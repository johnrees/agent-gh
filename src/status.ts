import type { AgentApp } from "./config.ts";
import { type HoldConfig, inert, outcomeSummary, parseMarker, type ReviewMarker, type ReviewPolicy, reviewState, sameLabel, STATUS_CONTEXT, statusDescription } from "./review.ts";
import { byAgent, type ThreadComment } from "./threads.ts";

/**
 * The agent-review workflow's pure decisions: which pull requests an event
 * concerns, whether one is an agent's, which review markers count, the
 * agent-review status they give, and what holds a pull request for a person
 * (agent-hold). status-run.ts does the I/O.
 */

export type Status = {
  readonly context: string;
  readonly state: "success" | "failure" | "pending" | "error";
  readonly description: string;
  readonly targetUrl: string | undefined;
};

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/**
 * The pull requests an Actions event concerns: the event's own, or, for a
 * comment on or a label change to an issue that is not a pull request, the
 * issue (whose closing pull requests the caller looks up). Undefined for any
 * other event.
 */
export const eventTarget = (name: string, payload: unknown): { readonly pull: number } | { readonly issue: number } | undefined => {
  const event = record(payload);
  const pull = record(event.pull_request).number;
  if (["pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment"].includes(name)) {
    return Number.isSafeInteger(pull) ? { pull: pull as number } : undefined;
  }
  if (name === "issue_comment" || name === "issues") {
    const issue = record(event.issue);
    if (!Number.isSafeInteger(issue.number)) return undefined;
    return issue.pull_request !== undefined && issue.pull_request !== null ? { pull: issue.number as number } : { issue: issue.number as number };
  }
  return undefined;
};

/** A review or issue comment that may hold a review marker. */
export type MarkerPost = {
  readonly author: string;
  /** The App it was posted through; GitHub records none for a review, so a review's is always undefined. */
  readonly appId: number | undefined;
  readonly kind: "review" | "comment";
  readonly at: string;
  readonly body: string;
  readonly url: string;
  /** A review's id, whose inline comments hold the findings posted on their lines. */
  readonly reviewId?: number;
};

export type FoundMarker = { readonly marker: ReviewMarker; readonly at: string; readonly url: string; readonly reviewId?: number };

/**
 * The review markers that count, oldest first: posted by the repository
 * owner, through a family App for a comment. A review records no App
 * (GitHub keeps none for reviews), so a review counts when the owner posted
 * it, which every agent does, as the owner.
 */
export const validMarkers = (posts: readonly MarkerPost[], owner: string, apps: readonly AgentApp[]): FoundMarker[] =>
  posts
    .filter((post) => post.author.toLowerCase() === owner.toLowerCase())
    .filter((post) => post.kind === "review" || (post.appId !== undefined && apps.some((app) => app.id === post.appId)))
    .flatMap((post) => {
      const marker = parseMarker(post.body);
      return marker === undefined ? [] : [{ marker, at: post.at, url: post.url, ...(post.reviewId === undefined ? {} : { reviewId: post.reviewId }) }];
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

/**
 * Whether a commit message shows an agent wrote it: an `Agent-*` trailer
 * (agent-gh's commit hook adds them), or a `Co-authored-by` crediting a
 * family App or Claude.
 */
export const agentCommit = (message: string, apps: readonly AgentApp[]): boolean =>
  message.split(/\r?\n/).some((line) => {
    if (/^Agent-[A-Za-z-]+:\s*\S/.test(line)) return true;
    const credit = /^Co-authored-by:\s*(.+)$/i.exec(line)?.[1]?.trim().toLowerCase();
    if (credit === undefined) return false;
    return credit.includes("<noreply@anthropic.com>") || apps.some((app) => credit.split(/\s+/)[0] === app.bot.toLowerCase());
  });

/**
 * Whether a pull request is an agent's. Not one: a bot's (Dependabot's, say)
 * that is not a family App, or one none of whose commits shows an agent.
 * `commits` undefined (too many to read) counts as an agent's, so the review
 * is never skipped on a guess.
 */
export const agentPull = (
  pull: { readonly author: string; readonly authorType: string; readonly viaApp: number | undefined; readonly commits: readonly string[] | undefined },
  apps: readonly AgentApp[],
): boolean => {
  if (pull.viaApp !== undefined && apps.some((app) => app.id === pull.viaApp)) return true;
  if (apps.some((app) => app.bot.toLowerCase() === pull.author.toLowerCase())) return true;
  if (pull.authorType === "Bot") return false;
  return pull.commits === undefined || pull.commits.some((message) => agentCommit(message, apps));
};

/** Whether a marker's review passes `block_on` and its checks. */
export const passes = (found: FoundMarker, policy: ReviewPolicy): boolean => reviewState(found.marker, policy) === "success";

/**
 * The marker a head with no review of its own may carry forward: the latest
 * for the same patch (`git patch-id --stable` of its diff from its merge
 * base), when that one passes `block_on` and its checks. A later blocking
 * review of the same patch, one whose checks did not pass among them, is
 * never skipped for an earlier pass, so carrying never upgrades a result.
 * The caller still checks that the base's changes since the marker's merge
 * base touch none of the patch's files.
 */
export const carryCandidate = (markers: readonly FoundMarker[], patchId: string | null, policy: ReviewPolicy): FoundMarker | undefined => {
  if (patchId === null) return undefined;
  const latest = markers.findLast((found) => found.marker.patch_id === patchId);
  return latest !== undefined && passes(latest, policy) ? latest : undefined;
};

/** The latest marker for `head`, which decides its status. */
export const markerFor = (markers: readonly FoundMarker[], head: string): FoundMarker | undefined => markers.findLast((found) => found.marker.head === head);

const status = (state: Status["state"], description: string, targetUrl?: string): Status => ({
  context: STATUS_CONTEXT,
  state,
  description: statusDescription(description),
  targetUrl,
});

/**
 * agent-review for pull request `number`'s head: success for a pull request
 * that is not an agent's, or that a person waived; else the head's own
 * marker, which `block_on` and its checks judge; else a passing review
 * carried forward; else pending, naming the command that reviews it.
 */
export const reviewStatus = (input: {
  readonly number: number;
  readonly agent: boolean;
  readonly waivedBy: string | undefined;
  readonly current: FoundMarker | undefined;
  readonly carried: FoundMarker | undefined;
  readonly policy: ReviewPolicy;
}): Status => {
  if (!input.agent) return status("success", "not an agent PR");
  if (input.waivedBy !== undefined) return status("success", `waived by ${input.waivedBy}`);
  if (input.current !== undefined) {
    const { marker } = input.current;
    return status(reviewState(marker, input.policy), `${outcomeSummary(marker, input.policy, `checks ${marker.checks}`)} (${marker.reviewer} review)`, input.current.url);
  }
  if (input.carried !== undefined) {
    const { marker } = input.carried;
    const passed = input.policy.blockOn === "changes_requested" ? "approved" : "passed";
    return status("success", `${passed} at ${marker.head.slice(0, 8)}, carried forward: same patch, base changes miss its files; checks ${marker.checks}`, input.carried.url);
  }
  return status("pending", `needs a review: run \`gh pr checkout ${input.number} && agent-gh review full --pr ${input.number}\``);
};

// --- agent-hold: what holds a pull request until a person releases it ---

export const HOLD_CONTEXT = "agent-hold";

/** The bot whose statuses and comments a run's GITHUB_TOKEN makes: GitHub Actions' (App 15368). */
export const ACTIONS_BOT = "github-actions[bot]";

/** A label added to or removed from an issue or pull request, from GitHub's issue events. */
export type LabelEvent = {
  readonly id: number;
  readonly event: "labeled" | "unlabeled";
  readonly label: string;
  readonly at: string;
  readonly actor: string;
  /**
   * A person's own addition: no App acted for them (`performed_via_github_app`
   * is null), and they are no bot. Never a removal's: GitHub records no App on
   * an `unlabeled` event (checked live), so an agent's removal reads as a
   * person's, and no removal can be told to be one.
   */
  readonly person: boolean;
};

/** The label events among an issue's events, oldest first as GitHub lists them. */
export const labelEvents = (events: readonly unknown[]): LabelEvent[] =>
  events.map(record).flatMap((entry): LabelEvent[] => {
    const name = record(entry.label).name;
    if ((entry.event !== "labeled" && entry.event !== "unlabeled") || typeof name !== "string" || !Number.isSafeInteger(entry.id)) return [];
    const actor = record(entry.actor);
    const login = typeof actor.login === "string" ? actor.login : "";
    const viaApp = entry.performed_via_github_app !== null && entry.performed_via_github_app !== undefined;
    return [{
      id: entry.id as number, event: entry.event, label: name, at: typeof entry.created_at === "string" ? entry.created_at : "", actor: login,
      person: entry.event === "labeled" && !viaApp && login !== "" && actor.type !== "Bot" && !login.endsWith("[bot]"),
    }];
  });

const later = (a: LabelEvent, b: LabelEvent) => Date.parse(a.at) > Date.parse(b.at) || (Date.parse(a.at) === Date.parse(b.at) && a.id > b.id);

/** The latest event that added `label`. */
const lastAdded = (events: readonly LabelEvent[], label: string) => events.findLast((event) => event.event === "labeled" && sameLabel(event.label, label));

/**
 * The person's release a thread carries: `releaseLabel` is on it, and the
 * event that put it there was a person's, as for the review's waiver. An App
 * adding it, as an agent does, releases nothing.
 */
export const personRelease = (labels: readonly string[], events: readonly LabelEvent[], releaseLabel: string): LabelEvent | undefined => {
  if (!labels.some((label) => sameLabel(label, releaseLabel))) return undefined;
  const last = events.findLast((event) => sameLabel(event.label, releaseLabel));
  return last?.event === "labeled" && last.person ? last : undefined;
};

/** A thread the hold's label can hold a pull request from: the pull request itself (first), or an issue it closes. */
export type HoldThread = {
  /** `#N`, or `owner/repo#N` in another repository. */
  readonly ref: string;
  readonly labels: readonly string[];
  readonly events: readonly LabelEvent[];
  /** The first line of the ask for the label's latest addition, where the label is on. */
  readonly ask?: string;
};

/**
 * Whether the hold's label holds a thread (`on` it still, or `removed` from
 * it): from the time it last went on until a person adds the release label
 * (on the thread, or on the pull request, `prRelease`), whether or not it is
 * still on. Its removal releases nothing, since GitHub cannot say whose it
 * was (`LabelEvent.person`); adding it again holds again.
 */
export const labelHold = (thread: HoldThread, hold: HoldConfig, prRelease: LabelEvent | undefined): "on" | "removed" | undefined => {
  const on = thread.labels.some((label) => sameLabel(label, hold.label));
  const added = lastAdded(thread.events, hold.label);
  if (added === undefined) return on ? "on" : undefined;
  const released = [personRelease(thread.labels, thread.events, hold.releaseLabel), prRelease].some((release) => release !== undefined && later(release, added));
  return released ? undefined : on ? "on" : "removed";
};

/** A changed file as the pull request's files list gives it: its name, and its name before a rename. */
export type ChangedFile = { readonly name: string; readonly previous: string | undefined };

/**
 * The changed files the hold's `paths` reserve (a `Bun.Glob` pattern
 * matching the current name or, for a rename, the previous one), the names
 * to diff them by (both of a rename's), and the patterns that matched, in
 * the config's order.
 */
export const reservedFiles = (files: readonly ChangedFile[], paths: readonly string[]): { readonly files: string[]; readonly names: string[]; readonly patterns: string[] } => {
  const globs = paths.map((pattern) => ({ pattern, glob: new Bun.Glob(pattern) }));
  const matched = new Set<string>();
  const hits: ChangedFile[] = [];
  for (const file of files) {
    const names = [file.name, ...(file.previous === undefined ? [] : [file.previous])];
    const by = globs.filter(({ glob }) => names.some((name) => glob.match(name)));
    if (by.length === 0) continue;
    hits.push(file);
    for (const { pattern } of by) matched.add(pattern);
  }
  return {
    files: hits.map((file) => file.name),
    names: [...new Set(hits.flatMap((file) => [file.name, ...(file.previous === undefined ? [] : [file.previous])]))],
    patterns: paths.filter((pattern) => matched.has(pattern)),
  };
};

/**
 * What binds a person's path release: the release label's event, who added
 * it, the head it released, and the `git patch-id --stable` of the head's
 * diff from its merge base in the reserved files then (null for none). The
 * workflow writes it as `github-actions[bot]` when it first sees the
 * release; a record anyone else posts counts for nothing.
 */
export type ReleaseRecord = { readonly v: 1; readonly event: number; readonly by: string; readonly head: string; readonly paths_patch_id: string | null };

const RELEASE = /<!-- agent-hold-release (\{[^\n]*?\}) -->/;
const SHA = /^[0-9a-f]{40}$/;

export const releaseMarker = (value: ReleaseRecord): string => `<!-- agent-hold-release ${JSON.stringify(value)} -->`;

/** A comment's release record; undefined when it has none or it is malformed. */
export const parseRelease = (body: string): ReleaseRecord | undefined => {
  const match = RELEASE.exec(body);
  if (match === null) return undefined;
  try {
    const value = record(JSON.parse(match[1] as string));
    const ok =
      value.v === 1 && Number.isSafeInteger(value.event) && typeof value.by === "string" && typeof value.head === "string" && SHA.test(value.head) &&
      (value.paths_patch_id === null || (typeof value.paths_patch_id === "string" && SHA.test(value.paths_patch_id)));
    return ok ? { v: 1, event: value.event as number, by: value.by as string, head: value.head as string, paths_patch_id: value.paths_patch_id as string | null } : undefined;
  } catch {
    return undefined;
  }
};

/** A comment on the pull request, as the release records are read from them; `edited` once its body was changed after it was posted. */
export type PostedBy = { readonly author: string; readonly body: string; readonly edited?: boolean };

/**
 * The record that binds release `event`: the first `github-actions[bot]`
 * posted for it, so a later one cannot rebind it; `edited` when any of its
 * comments carrying one was edited since. Anyone with write access may edit
 * the bot's comment, its author unchanged (checked live), so an edited
 * record is never trusted.
 */
export const recordFor = (comments: readonly PostedBy[], event: number): ReleaseRecord | "edited" | undefined => {
  const records = comments.filter((comment) => comment.author === ACTIONS_BOT).flatMap((comment) => {
    const value = parseRelease(comment.body);
    return value?.event === event ? [{ value, edited: comment.edited === true }] : [];
  });
  return records.some((entry) => entry.edited) ? "edited" : records[0]?.value;
};

/**
 * How long after a release its record may first be written: the runs its own
 * event starts write it within a minute or two. A record missing past that
 * (deleted, or never written) is not written afresh, so it cannot be dropped
 * to bind the release to another head.
 */
export const RECORD_WINDOW_MS = 15 * 60_000;

/** The longest list GitHub gives of a pull request's files; one with more cannot be checked. */
export const FILES_LISTED = 3000;

export type HoldInput = {
  readonly hold: HoldConfig;
  /** Whose pull request: an agent's; a bot's that is no family App (Dependabot, which an agent could merge); or a person's own, which reserved paths do not hold. */
  readonly author: "agent" | "bot" | "person";
  /** The pull request first, then each issue it closes. */
  readonly threads: readonly HoldThread[];
  /** The pull request's changed files; undefined when it changes more than GitHub lists. */
  readonly files: readonly ChangedFile[] | undefined;
  /** The pull request's comments, which carry the release records. */
  readonly comments: readonly PostedBy[];
  readonly head: string;
  /** When this run judges it. */
  readonly now: string;
  /** The reserved files' patch id at the head now (`ReleaseRecord.paths_patch_id`); undefined when it was not needed. */
  readonly pathsPatchId?: string | null;
  /**
   * Whether GitHub Actions set agent-hold on the head before the release,
   * so the head is one the person could have seen as they released it;
   * undefined when it was not needed.
   */
  readonly headBeforeRelease?: boolean;
};

/** What a release must be checked against: the release, its files, and the record if one binds it (`edited` if one was tampered with). */
export type HoldNeeds = { readonly release: LabelEvent; readonly names: readonly string[]; readonly record: ReleaseRecord | "edited" | undefined };

/** What holdStatus needs read from git and the head's statuses: undefined when nothing reserved has a release to check. */
export const holdNeeds = (input: Omit<HoldInput, "pathsPatchId" | "headBeforeRelease">): HoldNeeds | undefined => {
  if (input.author === "person" || input.files === undefined) return undefined;
  const pr = input.threads[0];
  const release = pr === undefined ? undefined : personRelease(pr.labels, pr.events, input.hold.releaseLabel);
  const { names } = reservedFiles(input.files, input.hold.paths);
  if (release === undefined || names.length === 0) return undefined;
  return { release, names, record: recordFor(input.comments, release.id) };
};

const holdStatusOf = (state: Status["state"], description: string): Status => ({ context: HOLD_CONTEXT, state, description: statusDescription(description), targetUrl: undefined });

/**
 * agent-hold for a pull request's head, and the release record to write when
 * this run is the first to see a person's release. In order:
 * - held while the hold's label holds the pull request or an issue it closes
 *   (`labelHold`), whoever wrote it, until a person adds the release label;
 * - not held, for a person's own pull request;
 * - held when it changes more files than GitHub lists, which cannot be
 *   checked;
 * - held while it touches a reserved file, until a person adds the release
 *   label, which binds to the reserved files' diff at the head then: a
 *   change to that diff holds it again. A release first seen on a head
 *   pushed after it (no agent-hold set on it before), or more than
 *   RECORD_WINDOW_MS after it, binds nothing, nor does an edited record.
 */
export const holdStatus = (input: HoldInput): { readonly status: Status; readonly record?: ReleaseRecord } => {
  const { hold } = input;
  const pr = input.threads[0];
  const prRelease = pr === undefined ? undefined : personRelease(pr.labels, pr.events, hold.releaseLabel);
  const holds = input.threads.map((thread) => ({ thread, held: labelHold(thread, hold, prRelease) }));
  const on = holds.find((entry) => entry.held === "on");
  if (on !== undefined) return { status: holdStatusOf("failure", `held: \`${hold.label}\` on ${on.thread.ref}: ${on.thread.ask ?? NO_ASK}`) };
  const removed = holds.find((entry) => entry.held === "removed");
  if (removed !== undefined) return { status: holdStatusOf("failure", `held: \`${hold.label}\` came off ${removed.thread.ref}, which releases nothing; a person adds \`${hold.releaseLabel}\``) };
  if (input.author === "person") return { status: holdStatusOf("success", "not an agent PR") };
  if (input.files === undefined) return { status: holdStatusOf("failure", `held: lists over ${FILES_LISTED.toLocaleString("en-US")} files, too many to check`) };
  const reserved = reservedFiles(input.files, hold.paths);
  if (reserved.files.length === 0) return { status: holdStatusOf("success", "not held") };
  const needs = holdNeeds(input);
  if (needs === undefined) {
    const [first, ...rest] = reserved.files;
    const patterns = reserved.patterns.map((pattern) => `\`${pattern}\``).join(", ");
    return { status: holdStatusOf("failure", `held: touches ${patterns} (${first}${rest.length === 0 ? "" : ` and ${rest.length} more`}); John adds \`${hold.releaseLabel}\``) };
  }
  const { release, record: bound } = needs;
  const again = `John adds \`${hold.releaseLabel}\` again`;
  if (bound === "edited") return { status: holdStatusOf("failure", `held: the record of ${release.actor}'s release was edited; ${again}`) };
  if (bound === undefined && Date.parse(input.now) - Date.parse(release.at) > RECORD_WINDOW_MS) return { status: holdStatusOf("failure", `held: no record of ${release.actor}'s release; ${again}`) };
  // Never released on a guess: what this needs and was not given holds it.
  if (input.pathsPatchId === undefined) return { status: holdStatusOf("failure", "held: the reserved paths' diff was not read; rerun the workflow") };
  if (bound !== undefined) {
    return bound.paths_patch_id === input.pathsPatchId
      ? { status: holdStatusOf("success", `released by ${bound.by} at ${bound.head.slice(0, 8)}`) }
      : { status: holdStatusOf("failure", `held: reserved paths changed since ${bound.by} released at ${bound.head.slice(0, 8)}; John adds \`${hold.releaseLabel}\` again`) };
  }
  if (input.headBeforeRelease !== true) {
    return { status: holdStatusOf("failure", `held: ${input.head.slice(0, 8)} was pushed after ${release.actor}'s release; John adds \`${hold.releaseLabel}\` again`) };
  }
  return {
    status: holdStatusOf("success", `released by ${release.actor} at ${input.head.slice(0, 8)}`),
    record: { v: 1, event: release.id, by: release.actor, head: input.head, paths_patch_id: input.pathsPatchId },
  };
};

// --- Calling John in when the hold's label goes on ---

/** How long before the label went on an agent's comment counts as its ask. */
export const ASK_WINDOW_MS = 15 * 60_000;

/** The ask's line when no agent posted one in the window. */
export const NO_ASK = "(no ask posted; read the thread)";

const ASK_CHARACTERS = 200;

/**
 * The ask's first line: the first line with text once agent-gh's markers
 * (HTML comments) are stripped, unable to carry a marker of its own
 * (`inert`), and at most 200 characters.
 */
export const firstLine = (body: string): string | undefined => {
  const line = body.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/).map((part) => part.trim()).find((part) => part !== "");
  if (line === undefined) return undefined;
  const safe = inert(line);
  return safe.length <= ASK_CHARACTERS ? safe : `${safe.slice(0, ASK_CHARACTERS - 1)}…`;
};

/**
 * The ask behind a hold's label: the newest comment an agent (the owner,
 * through a family App) posted on the thread in the 15 minutes before the
 * label went on, with its first line; else NO_ASK.
 */
export const askFor = (comments: readonly ThreadComment[], labeledAt: string, owner: string, apps: readonly number[]): { readonly line: string; readonly url: string | undefined } => {
  const until = Date.parse(labeledAt);
  const asks = comments.filter((comment) => {
    const at = Date.parse(comment.createdAt);
    return byAgent(comment, owner, apps) && at <= until && at >= until - ASK_WINDOW_MS && firstLine(comment.body) !== undefined;
  });
  const ask = asks.reduce<ThreadComment | undefined>((newest, comment) => (newest === undefined || comment.createdAt > newest.createdAt || (comment.createdAt === newest.createdAt && comment.id > newest.id) ? comment : newest), undefined);
  return ask === undefined ? { line: NO_ASK, url: undefined } : { line: firstLine(ask.body) as string, url: ask.url };
};

/** The call's marker: the `labeled` event it answers, so a rerun or a later run never posts it twice. */
export type CallMarker = { readonly v: 1; readonly event: number };

const CALL = /<!-- agent-hold-call (\{[^\n]*?\}) -->/;

export const callMarker = (value: CallMarker): string => `<!-- agent-hold-call ${JSON.stringify(value)} -->`;

/** Whether `github-actions[bot]` has already called the owner in for `event` among these comments; anyone else's marker counts for nothing. */
export const called = (comments: readonly PostedBy[], event: number): boolean =>
  comments.some((comment) => {
    if (comment.author !== ACTIONS_BOT) return false;
    const match = CALL.exec(comment.body);
    if (match === null) return false;
    try {
      const value = record(JSON.parse(match[1] as string));
      return value.v === 1 && value.event === event;
    } catch {
      return false;
    }
  });

/**
 * The call's comment: it mentions the owner (a bot's mention notifies him,
 * where an agent's, posted as him, would not), quotes the ask's line with no
 * mention of its own, links the ask, and says how to release the hold.
 */
export const callBody = (input: { readonly owner: string; readonly ref: string; readonly hold: HoldConfig; readonly ask: { readonly line: string; readonly url: string | undefined }; readonly event: number }): string =>
  [
    `@${input.owner}, an agent needs you on ${input.ref}: ${input.ask.line.replace(/@(?=[A-Za-z0-9])/g, "@\u200b")}`,
    "",
    input.ask.url === undefined ? "No agent posted an ask in the 15 minutes before the label went on; read the thread." : `[The ask](${input.ask.url})`,
    "",
    `Only a person releases this hold: once it is answered, add \`${input.hold.releaseLabel}\` yourself. Removing \`${input.hold.label}\` releases nothing (GitHub records no App on a removal, so an agent's would read as yours), and nor does an agent adding \`${input.hold.releaseLabel}\`.`,
    "",
    callMarker({ v: 1, event: input.event }),
  ].join("\n");
