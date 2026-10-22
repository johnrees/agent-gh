import type { AgentApp } from "./config.ts";
import { type HoldConfig, inert, outcomeSummary, parseMarker, type ReviewerFamily, type ReviewMarker, type ReviewPolicy, reviewState, sameLabel, STATUS_CONTEXT, statusDescription } from "./review.ts";
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

/** The latest marker for `head` (by `family`'s reviewer, when given), which decides its status. */
export const markerFor = (markers: readonly FoundMarker[], head: string, family?: ReviewerFamily): FoundMarker | undefined =>
  markers.findLast((found) => found.marker.head === head && (family === undefined || found.marker.reviewer === family));

/** The markers `family`'s reviewer posted, so each required family is judged, and carried forward, on its own reviews alone. */
export const byReviewer = (markers: readonly FoundMarker[], family: ReviewerFamily): FoundMarker[] => markers.filter((found) => found.marker.reviewer === family);

/**
 * The family whose work a pull request is, as the workflow reads it: the one
 * family App every commit credits as co-author (`authorFamily`, from
 * `fromCommits`), else the author the latest marker that records one names
 * (the session's family `review full` took, when the commits credit none or
 * a mix); else undefined.
 */
export const pullAuthor = (fromCommits: string | undefined, markers: readonly FoundMarker[]): string | undefined =>
  fromCommits ?? markers.findLast((found) => found.marker.author !== undefined)?.marker.author;

const status = (state: Status["state"], description: string, targetUrl?: string): Status => ({
  context: STATUS_CONTEXT,
  state,
  description: statusDescription(description),
  targetUrl,
});

/** One family `require` names, and its review of the head: its own marker for it, else a passing one carried forward. */
export type FamilyReview = { readonly family: ReviewerFamily; readonly current: FoundMarker | undefined; readonly carried: FoundMarker | undefined };

/** How a status that names a missing family begins; the `gh pr ready` refusal reads the family from it. */
export const AWAITING = /^awaiting (.+?)'s review: run `(agent-gh review full --reviewer \S+)`/;

/**
 * agent-review where `require` names the author: success only when every
 * required family's review of the head passes `block_on` and its checks;
 * else failure naming the first family whose review blocks, else the
 * families yet to review; pending while none has.
 */
export const requiredStatus = (number: number, reviews: readonly FamilyReview[], policy: ReviewPolicy): Status => {
  const head = (found: FoundMarker) => found.marker.head.slice(0, 8);
  const missing = reviews.filter((review) => review.current === undefined && review.carried === undefined).map((review) => review.family);
  if (missing.length === reviews.length) {
    return status("pending", `needs ${missing.join(" and ")}'s reviews: run \`gh pr checkout ${number} && agent-gh review full --pr ${number}\``);
  }
  // Each status links the latest review it counts, so a new review that leaves its words as they were still sets it anew (and `review full` sees it land).
  const latest = reviews
    .flatMap((review) => [review.current ?? review.carried].filter((found) => found !== undefined))
    .reduce<FoundMarker | undefined>((newest, found) => (newest === undefined || found.at >= newest.at ? found : newest), undefined);
  const blocking = reviews.find((review) => review.current !== undefined && !passes(review.current, policy));
  const verdict = (found: FoundMarker) => outcomeSummary(found.marker, policy, `checks ${found.marker.checks}`);
  if (blocking?.current !== undefined) {
    const rest = missing.length === 0 ? "" : `; ${missing.join(" and ")} yet to review`;
    return status("failure", `${blocking.family} blocks: ${verdict(blocking.current)}${rest}`, latest?.url);
  }
  const passed = reviews.flatMap((review) => {
    if (review.current !== undefined) return [`${review.family} ${verdict(review.current)}`];
    if (review.carried !== undefined) return [`${review.family} ${policy.blockOn === "changes_requested" ? "approved" : "passed"} at ${head(review.carried)}, carried forward`];
    return [];
  });
  if (missing.length > 0) {
    return status("failure", `awaiting ${missing.join(" and ")}'s review: run \`agent-gh review full --reviewer ${missing[0]}\`; ${passed.join(". ")}`, latest?.url);
  }
  return status("success", `${reviews.map((review) => review.family).join(" and ")} passed: ${passed.join(". ")}`, latest?.url);
};

/**
 * agent-review for pull request `number`'s head: success for a pull request
 * that is not an agent's, or that a person waived; where `require` names the
 * author, every required family's review (`requiredStatus`); else the head's
 * own marker, which `block_on` and its checks judge; else a passing review
 * carried forward; else pending, naming the command that reviews it.
 */
export const reviewStatus = (input: {
  readonly number: number;
  readonly agent: boolean;
  readonly waivedBy: string | undefined;
  readonly current: FoundMarker | undefined;
  readonly carried: FoundMarker | undefined;
  readonly policy: ReviewPolicy;
  /** Each family `require` names for the author, in the config's order; undefined when it names none. */
  readonly required?: readonly FamilyReview[] | undefined;
  /** The config has `require`, but neither the commits nor any marker says whose work this is, so what it asks cannot be known. */
  readonly authorUnknown?: boolean;
}): Status => {
  if (!input.agent) return status("success", "not an agent PR");
  if (input.waivedBy !== undefined) return status("success", `waived by ${input.waivedBy}`);
  // Fails closed: a review from a release that recorded no author never passes for work require may cover.
  if (input.authorUnknown === true) return status("pending", `needs a review that records its author, for require: run \`gh pr checkout ${input.number} && agent-gh review full --pr ${input.number}\``);
  if (input.required !== undefined) return requiredStatus(input.number, input.required, input.policy);
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

/** The latest event that added `label`. */
export const lastAdded = (events: readonly LabelEvent[], label: string) => events.findLast((event) => event.event === "labeled" && sameLabel(event.label, label));

/** A comment on the pull request, as releases and the bot's markers are read from them; `edited` once its body was changed after it was posted. */
export type PostedBy = { readonly author: string; readonly body: string; readonly edited?: boolean; readonly appId?: number | undefined; readonly at?: string; readonly id?: number };

/** A comment as the hold reads it: an edited one (its updated_at moved; a reaction leaves it) releases nothing, since an agent, acting as the owner, can edit his (checked live). */
export const postedBy = (comment: ThreadComment): PostedBy => ({ author: comment.author, body: comment.body, edited: comment.updatedAt !== comment.createdAt, appId: comment.appId, at: comment.createdAt, id: comment.id });

const RELEASE = /^agent-hold release ([0-9a-f]{40})\s*$/m;

/** The line a person posts to release a pull request at one exact head. */
export const releaseLine = (head: string): string => `agent-hold release ${head}`;

/**
 * The person's release of `head`: the owner's own comment (no App acted for
 * him) holding the line `agent-hold release <head>`, never edited, since an
 * agent, acting as him, could edit it (GitHub records no App on an edit). It
 * names one exact head, so any push holds the pull request again. The newest
 * counts (comments come oldest first), so a release after the label went on
 * again is not hidden by an earlier one.
 */
export const headRelease = (comments: readonly PostedBy[], owner: string, head: string): PostedBy | undefined =>
  comments.findLast((comment) => comment.author.toLowerCase() === owner.toLowerCase() && comment.appId === undefined && comment.edited !== true && RELEASE.exec(comment.body)?.[1] === head);

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
 * it): from the time it last went on until the person's release of the head
 * (`release`) comes after it, whether or not the label is still on. Its
 * removal releases nothing, since GitHub records no App on an `unlabeled`
 * event (checked live): an agent's removal reads as a person's.
 */
export const labelHold = (thread: HoldThread, hold: HoldConfig, release: PostedBy | undefined): "on" | "removed" | undefined => {
  const on = thread.labels.some((label) => sameLabel(label, hold.label));
  const added = lastAdded(thread.events, hold.label);
  if (added === undefined) return on ? "on" : undefined;
  if (release?.at !== undefined && Date.parse(release.at) > Date.parse(added.at)) return undefined;
  return on ? "on" : "removed";
};

/** A changed file as git lists it: its name, and its name before a rename. */
export type ChangedFile = { readonly name: string; readonly previous: string | undefined };

/**
 * The changed files the hold's `paths` reserve (a `Bun.Glob` pattern
 * matching the current name or, for a rename, the previous one), and the
 * patterns that matched, in the config's order.
 */
export const reservedFiles = (files: readonly ChangedFile[], paths: readonly string[]): { readonly files: string[]; readonly patterns: string[] } => {
  const globs = paths.map((pattern) => ({ pattern, glob: new Bun.Glob(pattern) }));
  const matched = new Set<string>();
  const hits: string[] = [];
  for (const file of files) {
    const names = [file.name, ...(file.previous === undefined ? [] : [file.previous])];
    const by = globs.filter(({ glob }) => names.some((name) => glob.match(name)));
    if (by.length === 0) continue;
    hits.push(file.name);
    for (const { pattern } of by) matched.add(pattern);
  }
  return { files: hits, patterns: paths.filter((pattern) => matched.has(pattern)) };
};

/**
 * What an agent-hold status links: its pull request, and, where it passed on
 * a person's release, `#agent-hold-released`, so the merge guard checks the
 * release still stands. A status on a commit is any pull request's with that
 * head, so the guard counts only one linking the pull request it merges.
 */
export const holdLink = (repo: string, number: number, released: boolean): string => `https://github.com/${repo}/pull/${number}${released ? "#agent-hold-released" : ""}`;

/**
 * Why the hold's label holds a pull request, from it (first) and the issues
 * it closes (`labelHold`), or undefined: for the workflow's agent-hold, and
 * for the merge guard, which reads it live, so a label added while its run
 * waits still holds.
 */
export const labelHoldReason = (threads: readonly HoldThread[], hold: HoldConfig, release: PostedBy | undefined): string | undefined => {
  const holds = threads.map((thread) => ({ thread, state: labelHold(thread, hold, release) }));
  const on = holds.find((entry) => entry.state === "on");
  if (on !== undefined) return `held: \`${hold.label}\` on ${on.thread.ref}${on.thread.ask === undefined ? "" : `: ${on.thread.ask}`}`;
  const removed = holds.find((entry) => entry.state === "removed");
  if (removed !== undefined) return `held: \`${hold.label}\` came off ${removed.thread.ref}, which releases nothing; John releases the head`;
  return undefined;
};

export type HoldInput = {
  readonly hold: HoldConfig;
  /** Whose pull request: an agent's; a bot's that is no family App (Dependabot, which an agent could merge); or a person's own, which reserved paths do not hold. */
  readonly author: "agent" | "bot" | "person";
  /** The repository (`owner/name`) and the pull request's number, which its agent-hold status links. */
  readonly repo: string;
  readonly number: number;
  /** The repository owner, the person who releases. */
  readonly owner: string;
  /** The pull request first, then each issue it closes. */
  readonly threads: readonly HoldThread[];
  /** The pull request's changed files, from its merge base to its head (none read for a person's own). */
  readonly files: readonly ChangedFile[];
  /** The pull request's comments, which carry the person's release. */
  readonly comments: readonly PostedBy[];
  readonly head: string;
  /** Other open pull requests whose head is this one: a status on a commit is theirs too, so none is judged alone. */
  readonly sharedWith: readonly number[];
};

/**
 * agent-hold for a pull request's head, judged afresh on every event, for
 * that head alone. In order:
 * - held while its head is another open pull request's too, since the status
 *   on that commit is theirs as well;
 * - held while the hold's label holds the pull request or an issue it closes
 *   (`labelHold`), whoever wrote it, until the person releases this head
 *   after it went on;
 * - not held, for a person's own pull request;
 * - held while it touches a reserved file, until the person releases this
 *   exact head (`headRelease`); a push to another head holds it again.
 */
export const holdStatus = (input: HoldInput): Status => {
  const { hold } = input;
  const of = (state: Status["state"], description: string, released = false): Status => ({ context: HOLD_CONTEXT, state, description: statusDescription(description), targetUrl: holdLink(input.repo, input.number, released) });
  const head = input.head.slice(0, 8);
  if (input.sharedWith.length > 0) return of("failure", `held: ${head} is also the head of ${input.sharedWith.map((number) => `#${number}`).join(", ")}, so neither is judged alone`);
  const release = headRelease(input.comments, input.owner, input.head);
  const label = labelHoldReason(input.threads, hold, release);
  if (label !== undefined) return of("failure", label);
  // Released only for this head: the label hold above, once it has been, passes like any other.
  const labelled = input.threads.some((thread) => lastAdded(thread.events, hold.label) !== undefined);
  if (input.author === "person") return of("success", "not an agent PR", labelled);
  const reserved = reservedFiles(input.files, hold.paths);
  if (reserved.files.length === 0) return labelled ? of("success", `released by ${input.owner} at ${head}`, true) : of("success", "not held");
  if (release !== undefined) return of("success", `released by ${input.owner} at ${head}`, true);
  const [first, ...rest] = reserved.files;
  const patterns = reserved.patterns.map((pattern) => `\`${pattern}\``).join(", ");
  return of("failure", `held: touches ${patterns} (${first}${rest.length === 0 ? "" : ` and ${rest.length} more`}); John releases ${head}`);
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
export const callBody = (input: {
  readonly owner: string;
  readonly ref: string;
  readonly hold: HoldConfig;
  readonly ask: { readonly line: string; readonly url: string | undefined };
  readonly event: number;
  /** The pull request's head, for a call on one: the line that releases it names it. */
  readonly head?: string;
}): string =>
  [
    `@${input.owner}, an agent needs you on ${input.ref}: ${input.ask.line.replace(/@(?=[A-Za-z0-9])/g, "@\u200b")}`,
    "",
    input.ask.url === undefined ? "No agent posted an ask in the 15 minutes before the label went on; read the thread." : `[The ask](${input.ask.url})`,
    "",
    input.head === undefined
      ? `Only you release this hold, once it is answered: on each pull request that closes this issue, comment the line \`${releaseLine("<its head sha>")}\` with its full head sha.`
      : `Only you release this hold, once it is answered: comment the line \`${releaseLine(input.head)}\`. It releases this head alone, so a later push is held again.`,
    `Removing \`${input.hold.label}\` releases nothing (GitHub records no App on a removal, so an agent's would read as yours).`,
    "",
    callMarker({ v: 1, event: input.event }),
  ].join("\n");
