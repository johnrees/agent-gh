import { agentApps } from "./config.ts";
import { Failure } from "./failure.ts";
import { request } from "./github.ts";
import { markerPosts, type Pull, pull, pullDiff, readReviewConfig, type ReviewIo, waiver } from "./review-run.ts";
import { type Repo, slug } from "./repo.ts";
import {
  ACTIONS_BOT,
  agentPull,
  askFor,
  callBody,
  called,
  carryCandidate,
  type ChangedFile,
  eventTarget,
  FILES_LISTED,
  type FoundMarker,
  HOLD_CONTEXT,
  labelHold,
  holdNeeds,
  holdStatus,
  type HoldThread,
  labelEvents,
  markerFor,
  passes,
  type ReleaseRecord,
  releaseMarker,
  reservedFiles,
  reviewStatus,
  type Status,
  validMarkers,
} from "./status.ts";
import { type HoldConfig, type ReviewPolicy, sameLabel, STATUS_CONTEXT, statusDescription } from "./review.ts";
import { THREADS_CONTEXT, threadsStatus } from "./threads.ts";
import { type ApiIo, closingIssues, everyPage, get, issueComments, pullThreads, repoOwner } from "./threads-run.ts";

/**
 * `agent-gh status`, in the agent-review workflow: derives agent-review,
 * agent-threads, and (with `hold`) agent-hold for a pull request from GitHub
 * and git, and sets them with the workflow's GITHUB_TOKEN, so they come from
 * GitHub Actions; and, when the hold's label goes on, calls John in.
 */
export type StatusIo = ApiIo &
  Pick<ReviewIo, "git" | "print"> & {
    /** The repository's git URL, which carry-forward fetches the commits it compares from (never the pull request's code to run). */
    readonly remote: string;
    /** Where a hold's call is also pushed (the NTFY_URL secret), if anywhere; never printed. */
    readonly ntfyUrl: string | undefined;
  };

const STAGE = "deriving the statuses";

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const repoPath = (io: ApiIo) => `/repos/${slug(io.repo)}`;

/** GitHub lists at most this many of a pull request's commits, and says nothing of the rest. */
const COMMITS_LISTED = 250;

/** The commit messages of a pull request's commits; undefined when GitHub may not have listed them all. */
const commitMessages = async (io: ApiIo, number: number): Promise<string[] | undefined> => {
  const commits = await everyPage(io, STAGE, `${repoPath(io)}/pulls/${number}/commits`, 3).catch((error: unknown) => {
    if (error instanceof Failure && error.detail.includes("lists over")) return undefined;
    throw error;
  });
  if (commits === undefined || commits.length >= COMMITS_LISTED) return undefined;
  return commits.map((commit) => text(record(record(commit).commit).message));
};

/** Fetches commits into the scratch repository, one depth each: only their trees are compared, nothing is run. */
const fetched = async (io: StatusIo, refs: readonly string[], want: string): Promise<boolean> => {
  await io.git(["fetch", "-q", "--no-tags", "--depth=1", io.remote, ...refs]);
  return (await io.git(["cat-file", "-e", `${want}^{commit}`])) !== undefined;
};

const names = async (io: StatusIo, from: string, to: string): Promise<string[] | undefined> =>
  (await io.git(["diff", "--name-only", "--no-renames", "--no-ext-diff", from, to]))?.split("\n").filter((name) => name !== "");

/**
 * The merge base GitHub reports for pull request `number`'s `head`, with both
 * commits fetched into the scratch repository; undefined when git cannot
 * fetch them.
 */
const fetchedPull = async (io: StatusIo, number: number, base: string, head: string): Promise<string | undefined> => {
  const compare = record(await get(io, STAGE, `${repoPath(io)}/compare/${encodeURIComponent(base)}...${head}`));
  const mergeBase = text(record(compare.merge_base_commit).sha);
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) return undefined;
  await io.git(["init", "-q", "--bare"]);
  if (!(await fetched(io, [`refs/pull/${number}/head`, mergeBase], head)) && !(await fetched(io, [head, mergeBase], head))) return undefined;
  if ((await io.git(["cat-file", "-e", `${mergeBase}^{commit}`])) === undefined) return undefined;
  return mergeBase;
};

/**
 * A passing review carried forward to `head`, which has no review of its own:
 * the latest marker for the same patch passes `block_on` and its checks,
 * and the base's changes since that marker's merge base touch none of the
 * patch's files. Anything git cannot show (a commit it cannot fetch) carries
 * nothing.
 */
const carriedForward = async (io: StatusIo, number: number, base: string, head: string, markers: readonly FoundMarker[], policy: ReviewPolicy): Promise<FoundMarker | undefined> => {
  if (!markers.some((found) => passes(found, policy))) return undefined;
  const mergeBase = await fetchedPull(io, number, base, head);
  if (mergeBase === undefined) return undefined;
  const { patchId } = await pullDiff(io, mergeBase, head);
  const candidate = carryCandidate(markers, patchId, policy);
  if (candidate === undefined) return undefined;
  if (candidate.marker.merge_base === mergeBase) return candidate;
  if (!(await fetched(io, [candidate.marker.merge_base], candidate.marker.merge_base))) return undefined;
  const [patched, moved] = [await names(io, mergeBase, head), await names(io, candidate.marker.merge_base, mergeBase)];
  if (patched === undefined || moved === undefined) return undefined;
  return moved.some((name) => patched.includes(name)) ? undefined : candidate;
};

const labelNames = (value: unknown): string[] => (Array.isArray(value) ? value.map((label) => text(record(label).name)).filter((name) => name !== "") : []);

/** Every event on issue or pull request `number` in `repo`, oldest first; over 1,000 cannot be trusted, since a later one left unread could be the one that counts. */
const issueEvents = async (io: ApiIo, repo: Repo, number: number): Promise<unknown[]> => everyPage(io, STAGE, `/repos/${slug(repo)}/issues/${number}/events`, 10);

const threadRef = (io: ApiIo, repo: Repo, number: number): string => (slug(repo).toLowerCase() === slug(io.repo).toLowerCase() ? `#${number}` : `${slug(repo)}#${number}`);

/** The pull request's changed files; undefined when it changes more than GitHub lists, so they cannot all be checked. */
const pullFiles = async (io: ApiIo, pr: Pull): Promise<ChangedFile[] | undefined> => {
  if (pr.changedFiles !== undefined && pr.changedFiles > FILES_LISTED) return undefined;
  const files = await everyPage(io, STAGE, `${repoPath(io)}/pulls/${pr.number}/files`, FILES_LISTED / 100).catch((error: unknown) => {
    if (error instanceof Failure && error.detail.includes("lists over")) return undefined;
    throw error;
  });
  return files?.map(record).map((file) => ({ name: text(file.filename), previous: typeof file.previous_filename === "string" ? file.previous_filename : undefined }));
};

/**
 * The files the hold's paths reserve in `head`'s diff from `mergeBase`, as
 * git names them (both names of a rename), so the patch id is read the same
 * way at any head.
 */
const reservedNames = async (io: StatusIo, mergeBase: string, head: string, paths: readonly string[]): Promise<string[]> => {
  const out = await io.git(["diff", "--name-status", "-M", "-z", "--no-ext-diff", mergeBase, head]);
  if (out === undefined) throw new Failure(STAGE, `could not list ${head.slice(0, 8)}'s changed files`);
  const parts = out.split("\0");
  const files: ChangedFile[] = [];
  for (let at = 0; at < parts.length && parts[at] !== ""; ) {
    const status = parts[at] as string;
    if (/^[RC]/.test(status)) {
      files.push({ name: parts[at + 2] ?? "", previous: parts[at + 1] });
      at += 3;
    } else {
      files.push({ name: parts[at + 1] ?? "", previous: undefined });
      at += 2;
    }
  }
  return reservedFiles(files, paths).names;
};

/** The reserved files' patch id at `head` (null for none), from its diff from the merge base GitHub reports for it. */
const reservedPatchId = async (io: StatusIo, pr: Pull, paths: readonly string[], head: string): Promise<string | null> => {
  const mergeBase = await fetchedPull(io, pr.number, pr.base, head);
  if (mergeBase === undefined) throw new Failure(STAGE, `could not fetch ${head.slice(0, 8)} and its merge base to compare #${pr.number}'s reserved paths`);
  const names = await reservedNames(io, mergeBase, head, paths);
  return names.length === 0 ? null : (await pullDiff(io, mergeBase, head, names)).patchId;
};

/** The other open pull requests here whose head is `head`. */
const sharingHead = async (io: ApiIo, number: number, head: string): Promise<number[]> =>
  (await everyPage(io, STAGE, `${repoPath(io)}/commits/${head}/pulls`, 3))
    .map(record)
    .filter((item) => item.state === "open" && text(record(item.head).sha) === head && Number.isSafeInteger(item.number) && item.number !== number)
    .map((item) => item.number as number);

/**
 * agent-hold for `pr`'s head (holdStatus), from the labels and label events of
 * the pull request and every issue it closes, its files, its release
 * records, the open pull requests sharing its head, and, only when a
 * person's release has to be checked, the reserved files' diff, read from
 * git. `releaseHead` is the head the release label's own `labeled` event
 * gave, in that run alone.
 */
const deriveHold = async (io: StatusIo, pr: Pull, hold: HoldConfig, author: "agent" | "bot" | "person", releaseHead: string | undefined): Promise<{ readonly status: Status; readonly record?: ReleaseRecord }> => {
  const threads: (HoldThread & { readonly repo: Repo; readonly number: number })[] = [
    { ref: `#${pr.number}`, repo: io.repo, number: pr.number, labels: pr.labels, events: labelEvents(await issueEvents(io, io.repo, pr.number)) },
  ];
  for (const issue of await closingIssues(io, STAGE, pr.number)) {
    const labels = labelNames(record(await get(io, STAGE, `/repos/${slug(issue.repo)}/issues/${issue.number}`)).labels);
    threads.push({ ref: threadRef(io, issue.repo, issue.number), repo: issue.repo, number: issue.number, labels, events: labelEvents(await issueEvents(io, issue.repo, issue.number)) });
  }
  const prComments = await issueComments(io, STAGE, io.repo, pr.number, `#${pr.number}`);
  // The ask, on each thread the label is on, names the hold.
  let owner: string | undefined;
  for (const [index, thread] of threads.entries()) {
    if (!thread.labels.some((label) => sameLabel(label, hold.label))) continue;
    const added = thread.events.findLast((event) => event.event === "labeled" && sameLabel(event.label, hold.label));
    if (added === undefined) continue;
    owner ??= await repoOwner(io, STAGE);
    const comments = index === 0 ? prComments : await issueComments(io, STAGE, thread.repo, thread.number, thread.ref);
    threads[index] = { ...thread, ask: askFor(comments, added.at, owner, agentApps().map((app) => app.id)).line };
  }
  const files = author === "person" ? [] : await pullFiles(io, pr);
  // A comment edited since it was posted (its updated_at moved; a reaction leaves it) carries no trusted record.
  const comments = prComments.map((comment) => ({ author: comment.author, body: comment.body, edited: comment.updatedAt !== comment.createdAt }));
  const input = { hold, author, number: pr.number, url: `https://github.com/${slug(io.repo)}/pull/${pr.number}`, threads, files, comments, head: pr.head, sharedWith: await sharingHead(io, pr.number, pr.head) };
  const needs = holdNeeds(input);
  if (needs === undefined || needs.record === "edited" || (needs.record === undefined && releaseHead === undefined)) return holdStatus(input);
  const pathsPatchId = await reservedPatchId(io, pr, hold.paths, pr.head);
  const releaseRun = needs.record === undefined && releaseHead !== undefined ? { head: releaseHead, pathsPatchId: releaseHead === pr.head ? pathsPatchId : await reservedPatchId(io, pr, hold.paths, releaseHead) } : undefined;
  return holdStatus({ ...input, pathsPatchId, ...(releaseRun === undefined ? {} : { releaseRun }) });
};

/** A pull request's `labeled` event, which this run handles: the label, and the head GitHub gave the event. */
export type LabeledEvent = { readonly label: string; readonly head: string };

/** What a run derives for a pull request: the statuses for its head, a release record to write first, and the hold it judged by. */
export type Derived = { readonly head: string; readonly statuses: readonly Status[]; readonly record?: ReleaseRecord; readonly hold?: HoldConfig };

/**
 * The statuses for pull request `number`'s current head (agent-hold too when
 * its base branch's config has `hold`); undefined when it is closed, or its
 * base branch has no review config.
 */
export const deriveStatuses = async (io: StatusIo, number: number, labeled?: LabeledEvent): Promise<Derived | undefined> => {
  const pr = await pull(io, STAGE, number);
  if (!pr.open) {
    io.print(`agent-gh: #${number} is closed; no status set`);
    return undefined;
  }
  const config = await readReviewConfig(io, STAGE, pr.base);
  if (config === undefined) {
    io.print(`agent-gh: ${slug(io.repo)} has no .github/agent-review.json on ${pr.base}; no status set`);
    return undefined;
  }
  const apps = agentApps();
  const issue = record(await get(io, STAGE, `${repoPath(io)}/issues/${number}`));
  const viaApp = record(issue.performed_via_github_app).id;
  const agent = agentPull(
    { author: pr.author, authorType: pr.authorType, viaApp: Number.isSafeInteger(viaApp) ? (viaApp as number) : undefined, commits: await commitMessages(io, number) },
    apps,
  );
  // A bot that is no family App (Dependabot) is not an agent, but an agent could merge its pull request: reserved paths hold it.
  const releaseHead = config.hold !== undefined && labeled !== undefined && sameLabel(labeled.label, config.hold.releaseLabel) ? labeled.head : undefined;
  const held = config.hold === undefined ? undefined : await deriveHold(io, pr, config.hold, agent ? "agent" : pr.authorType === "Bot" ? "bot" : "person", releaseHead);
  const hold = held === undefined ? {} : { hold: config.hold, ...(held.record === undefined ? {} : { record: held.record }) };
  if (!agent) {
    const skip = (context: string): Status => ({ context, state: "success", description: "not an agent PR", targetUrl: undefined });
    const review = reviewStatus({ number, agent, waivedBy: undefined, current: undefined, carried: undefined, policy: config });
    return { head: pr.head, statuses: [review, skip(THREADS_CONTEXT), ...(held === undefined ? [] : [held.status])], ...hold };
  }
  const owner = await repoOwner(io, STAGE);
  const waivedBy = await waiver(io, STAGE, pr, config);
  const markers = validMarkers(await markerPosts(io, STAGE, number), owner, apps);
  const current = markerFor(markers, pr.head);
  const carried = current === undefined && waivedBy === undefined ? await carriedForward(io, number, pr.base, pr.head, markers, config) : undefined;
  const review = reviewStatus({ number, agent, waivedBy, current, carried, policy: config });
  const threads = threadsStatus(await pullThreads(io, STAGE, pr, owner));
  return { head: pr.head, statuses: [review, { context: THREADS_CONTEXT, ...threads }, ...(held === undefined ? [] : [held.status])], ...hold };
};

/**
 * Sets each status on `head` unless GitHub Actions already set the same one
 * last, target link included, so a new review of the same verdict (a new
 * link) is still set and `review full` sees it land (an equal status from anyone else, such as an agent before the
 * repository moved to the workflow, cannot meet a check tied to GitHub
 * Actions). A token that may not write statuses (a fork's run) is reported,
 * and nothing fails: a later run with a writable token sets them.
 */
export const writeStatuses = async (io: StatusIo, head: string, statuses: readonly Status[]): Promise<boolean> => {
  // Latest first; the first page holds the latest of each context this writes, or the status is set again.
  const listed = await get(io, STAGE, `${repoPath(io)}/commits/${head}/statuses?per_page=100`);
  const latest = Array.isArray(listed) ? listed.map(record) : [];
  for (const status of statuses) {
    const shown = latest.find((entry) => entry.context === status.context);
    const same = shown?.state === status.state && shown.description === status.description && text(shown.target_url) === (status.targetUrl ?? "");
    if (same && text(record(shown?.creator).login) === ACTIONS_BOT) {
      io.print(`agent-gh: ${status.context} on ${head.slice(0, 8)} already reads ${status.state}: ${status.description}`);
      continue;
    }
    const body = { state: status.state, context: status.context, description: status.description, ...(status.targetUrl === undefined || status.targetUrl === "" ? {} : { target_url: status.targetUrl }) };
    const { status: code } = await request(io.api, STAGE, "POST", `${repoPath(io)}/statuses/${head}`, io.token, body);
    if (code === 403 || code === 404) {
      io.print(`agent-gh: this run's token may not set statuses (HTTP ${code}; a fork's pull request runs read-only); a run with \`statuses: write\` sets them`);
      return false;
    }
    if (code < 200 || code >= 300) throw new Failure(STAGE, `HTTP ${code} from POST ${repoPath(io)}/statuses`);
    io.print(`agent-gh: ${status.context} on ${head.slice(0, 8)}: ${status.state}: ${status.description}`);
  }
  return true;
};

const sameStatuses = (a: { readonly head: string; readonly statuses: readonly Status[] }, b: { readonly head: string; readonly statuses: readonly Status[] }) =>
  a.head === b.head && JSON.stringify(a.statuses) === JSON.stringify(b.statuses);

/** Rounds of derive-and-write before a run gives up chasing a pull request that keeps changing (the next event's run follows it). */
const WRITE_ROUNDS = 3;

/** Why a run's token may not comment: the scopes a hold's comments need, or a fork's read-only run. */
const NO_COMMENT = "the workflow needs `issues: write` and, on a pull request, `pull-requests: write`; a fork's pull_request_review run is read-only";

/**
 * Posts a person's release record on the pull request, as
 * `github-actions[bot]`, before the status it lets pass is set. A token that
 * may not comment (a fork's run) is reported, and nothing is set.
 */
const writeRecord = async (io: StatusIo, number: number, value: ReleaseRecord): Promise<boolean> => {
  const body = [
    `${value.by}'s \`${HOLD_CONTEXT}\` release binds to ${value.head.slice(0, 8)}'s reserved paths: a change to them holds this pull request again.`,
    "",
    releaseMarker(value),
  ].join("\n");
  const { status: code } = await request(io.api, STAGE, "POST", `${repoPath(io)}/issues/${number}/comments`, io.token, { body });
  if (code === 403 || code === 404) {
    io.print(`agent-gh: this run's token may not comment (HTTP ${code}: ${NO_COMMENT}), so ${value.by}'s release of #${number} is not recorded yet`);
    return false;
  }
  if (code < 200 || code >= 300) throw new Failure(STAGE, `HTTP ${code} from POST ${repoPath(io)}/issues/${number}/comments`);
  io.print(`agent-gh: recorded ${value.by}'s release of #${number} at ${value.head.slice(0, 8)}`);
  return true;
};

/**
 * Derives and sets pull request `number`'s statuses, then derives them again:
 * when the pull request changed while this run wrote (a new head, or a comment
 * whose own run, in another concurrency group, wrote first), it writes what
 * GitHub shows now. A stale run therefore never leaves its older result over
 * a newer one: the last write of any run follows a read made after it.
 * Returns the last derivation.
 */
const settle = async (io: StatusIo, number: number, labeled: LabeledEvent | undefined): Promise<Derived | undefined> => {
  let derived = await deriveStatuses(io, number, labeled);
  for (let round = 1; derived !== undefined; round++) {
    if (derived.record !== undefined && !(await writeRecord(io, number, derived.record))) return derived;
    if (!(await writeStatuses(io, derived.head, derived.statuses))) return derived;
    const now = await deriveStatuses(io, number, labeled);
    if (now === undefined || sameStatuses(now, derived)) return now;
    if (round >= WRITE_ROUNDS) {
      io.print(`agent-gh: #${number} kept changing while this run wrote its statuses; the next event's run sets them`);
      return now;
    }
    io.print(`agent-gh: #${number} changed while this run wrote its statuses; setting what it shows now`);
    derived = now;
  }
  return undefined;
};

/**
 * When a run cannot derive the statuses, it sets each to error on the
 * current head (agent-hold too, unless the config is read and has no
 * `hold`), so an earlier success never stands for a head this run could not
 * judge; the run still fails. Best effort: if even the head cannot be read,
 * nothing is set.
 */
const withdraw = async (io: StatusIo, number: number, error: unknown): Promise<void> => {
  const why = statusDescription(`agent-gh could not derive it: ${error instanceof Failure ? error.detail : "an unexpected error"}; rerun the workflow`);
  try {
    const { head, base } = await pull(io, STAGE, number);
    const holds = await readReviewConfig(io, STAGE, base).then((config) => config?.hold !== undefined, () => true);
    const contexts = [STATUS_CONTEXT, THREADS_CONTEXT, ...(holds ? [HOLD_CONTEXT] : [])];
    await writeStatuses(io, head, contexts.map((context): Status => ({ context, state: "error", description: why, targetUrl: undefined })));
  } catch {
    io.print(`agent-gh: could not mark #${number}'s statuses as errors`);
  }
};

/** Sends the call to the NTFY_URL secret's topic, if one is set. A failure only warns: the comment is the record. Neither the URL nor its host is ever printed. */
const push = async (io: StatusIo, title: string, click: string, line: string): Promise<void> => {
  if (io.ntfyUrl === undefined || io.ntfyUrl === "") return;
  try {
    const response = await fetch(io.ntfyUrl, {
      method: "POST",
      headers: { Title: title, Click: click, Tags: "raised_hand" },
      body: line,
      redirect: "error",
      signal: AbortSignal.timeout(io.api.timeoutMs),
    });
    io.print(response.ok ? "agent-gh: pushed the call to NTFY_URL" : `agent-gh: warning: the push to NTFY_URL failed (HTTP ${response.status}); the comment stands`);
  } catch {
    io.print("agent-gh: warning: could not reach NTFY_URL; the comment stands");
  }
};

/**
 * Calls the repository owner in on issue or pull request `number`, here,
 * while the hold's label holds it (`labelHold`): once for the event that last added the
 * label (marked in the comment, so a rerun, or any later run, never posts
 * it twice), and never for a label the owner added himself. The comment, as
 * `github-actions[bot]`, mentions him, which notifies him where an agent's
 * mention (posted as him) would not; a newly posted one is also pushed to
 * the NTFY_URL secret's topic.
 */
const callOwner = async (io: StatusIo, number: number, hold: HoldConfig): Promise<void> => {
  const issue = record(await get(io, STAGE, `${repoPath(io)}/issues/${number}`));
  const events = labelEvents(await issueEvents(io, io.repo, number));
  // Whether or not the label is still on: one added and removed before any run read it holds all the same, so it calls all the same.
  if (labelHold({ ref: `#${number}`, labels: labelNames(issue.labels), events }, hold, undefined) === undefined) return;
  const added = events.findLast((event) => event.event === "labeled" && sameLabel(event.label, hold.label));
  if (added === undefined) {
    io.print(`agent-gh: #${number} has \`${hold.label}\` but GitHub lists no event that added it; no call`);
    return;
  }
  const owner = await repoOwner(io, STAGE);
  if (added.person && added.actor.toLowerCase() === owner.toLowerCase()) {
    io.print(`agent-gh: ${owner} added \`${hold.label}\` to #${number} himself; no call`);
    return;
  }
  const comments = await issueComments(io, STAGE, io.repo, number, `#${number}`);
  if (called(comments, added.id)) return;
  const ask = askFor(comments, added.at, owner, agentApps().map((app) => app.id));
  const body = callBody({ owner, ref: `#${number}`, hold, ask, event: added.id });
  const { status: code, value } = await request(io.api, STAGE, "POST", `${repoPath(io)}/issues/${number}/comments`, io.token, { body });
  if (code === 403 || code === 404) {
    io.print(`agent-gh: this run's token may not comment (HTTP ${code}: ${NO_COMMENT}); a later run calls ${owner} in`);
    return;
  }
  if (code < 200 || code >= 300) throw new Failure(STAGE, `HTTP ${code} from POST ${repoPath(io)}/issues/${number}/comments`);
  // A labeled run has a concurrency group of its own, so another run may have called at the same moment: the earliest call stands, and a later one removes itself unpushed.
  const id = record(value).id;
  const calls = (await issueComments(io, STAGE, io.repo, number, `#${number}`)).filter((comment) => called([comment], added.id)).map((comment) => comment.id);
  if (Number.isSafeInteger(id) && calls.some((other) => other < (id as number))) {
    await request(io.api, STAGE, "DELETE", `${repoPath(io)}/issues/comments/${id as number}`, io.token);
    io.print(`agent-gh: another run called ${owner} in on #${number} at the same moment; this run's call is removed`);
    return;
  }
  io.print(`agent-gh: called ${owner} in on #${number}: ${ask.line}`);
  await push(io, `${slug(io.repo)}#${number} needs you`, text(issue.html_url), ask.line);
};

/**
 * Every open pull request in this repository that closes `issue`, from every
 * page: one left unread would keep a status the issue's label now holds.
 */
const closingPulls = async (io: ApiIo, issue: number): Promise<number[]> => {
  const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:100,after:$after,includeClosedPrs:false){pageInfo{hasNextPage endCursor} nodes{number repository{nameWithOwner}}}}}}`;
  const numbers: number[] = [];
  let after: string | null = null;
  for (let page = 1; page <= 10; page++) {
    const value = await get(io, STAGE, "/graphql", "POST", { query, variables: { owner: io.repo.owner, name: io.repo.name, number: issue, after } });
    const references = record(record(record(record(value).data).repository).issue).closedByPullRequestsReferences;
    const nodes = record(references).nodes;
    if (!Array.isArray(nodes)) throw new Failure(STAGE, `the pull requests that close #${issue}: invalid response`);
    numbers.push(
      ...nodes
        .map(record)
        .filter((node) => text(record(node.repository).nameWithOwner).toLowerCase() === slug(io.repo).toLowerCase() && Number.isSafeInteger(node.number))
        .map((node) => node.number as number),
    );
    const info = record(record(references).pageInfo);
    if (info.hasNextPage !== true) return numbers;
    after = text(info.endCursor);
    if (after === "") throw new Failure(STAGE, `the pull requests that close #${issue}: invalid response`);
  }
  throw new Failure(STAGE, `over 1,000 open pull requests close #${issue}, too many to read`);
};

/** The hold on the default branch's config, which judges an issue no pull request's base names. */
const defaultHold = async (io: StatusIo): Promise<HoldConfig | undefined> => {
  const branch = text(record(await get(io, STAGE, repoPath(io))).default_branch);
  if (branch === "") throw new Failure(STAGE, `${slug(io.repo)}: invalid response`);
  return (await readReviewConfig(io, STAGE, branch))?.hold;
};

/**
 * `agent-gh status`: the pull request the Actions event concerns (or
 * `--pr`), or, for a comment on or a label change to an issue, every open
 * pull request here that closes it; for each, derives and sets its statuses.
 * Then, where the config has `hold`, calls the owner in on the thread the
 * event names while the hold's label holds it. A pull request that cannot be
 * judged is set to error and the rest still settled, the call still made,
 * before the run fails. A pull request's `labeled` event is passed on, so
 * the release label's own run can record its release.
 */
export const statusCommand = async (io: StatusIo, event: { readonly name: string; readonly payload: unknown }, pr: number | undefined): Promise<void> => {
  const target = pr === undefined ? eventTarget(event.name, event.payload) : { pull: pr };
  if (target === undefined) throw new Failure(STAGE, `a ${event.name} event names no pull request; run it from the agent-review workflow's events, or pass --pr N`);
  const numbers = "pull" in target ? [target.pull] : await closingPulls(io, target.issue);
  if (numbers.length === 0) io.print(`agent-gh: no open pull request closes #${"issue" in target ? target.issue : ""}; no status set`);
  const labeled = pr === undefined && "pull" in target ? labeledEvent(event.payload) : undefined;
  // One pull request that cannot be judged never leaves the others as they were, nor stops the call: each is settled, and the run fails after.
  let failure: unknown;
  for (const number of numbers) {
    try {
      await settle(io, number, labeled);
    } catch (error) {
      await withdraw(io, number, error);
      failure ??= error;
    }
  }
  try {
    const hold = "pull" in target ? await pullHold(io, target.pull) : await defaultHold(io);
    if (hold !== undefined) await callOwner(io, "pull" in target ? target.pull : target.issue, hold);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
};

/** The event's own `labeled` change to a pull request, with the head GitHub gave it; undefined for any other event. */
const labeledEvent = (payload: unknown): LabeledEvent | undefined => {
  const event = record(payload);
  const head = text(record(record(event.pull_request).head).sha);
  const label = text(record(event.label).name);
  return event.action === "labeled" && /^[0-9a-f]{40}$/.test(head) && label !== "" ? { label, head } : undefined;
};

/** The hold on an open pull request's base branch's config. */
const pullHold = async (io: StatusIo, number: number): Promise<HoldConfig | undefined> => {
  const pr = await pull(io, STAGE, number);
  return pr.open ? (await readReviewConfig(io, STAGE, pr.base))?.hold : undefined;
};
