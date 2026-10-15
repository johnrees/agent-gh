import { agentApps } from "./config.ts";
import { Failure } from "./failure.ts";
import { request } from "./github.ts";
import { pull, pullDiff, readReviewConfig, type ReviewIo, waiver } from "./review-run.ts";
import { slug } from "./repo.ts";
import { agentPull, carryCandidate, eventTarget, type FoundMarker, markerFor, type MarkerPost, reviewStatus, type Status, validMarkers } from "./status.ts";
import { THREADS_CONTEXT, threadsStatus } from "./threads.ts";
import { type ApiIo, everyPage, get, pullThreads, repoOwner } from "./threads-run.ts";

/**
 * `agent-gh status`, in the agent-review workflow: derives agent-review and
 * agent-threads for a pull request from GitHub and git, and sets them with
 * the workflow's GITHUB_TOKEN, so they come from GitHub Actions.
 */
export type StatusIo = ApiIo &
  Pick<ReviewIo, "git" | "print"> & {
    /** The repository's git URL, which carry-forward fetches the commits it compares from (never the pull request's code to run). */
    readonly remote: string;
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

/** Every review and conversation comment that may hold a review marker. */
const markerPosts = async (io: ApiIo, number: number): Promise<MarkerPost[]> => {
  const reviews = (await everyPage(io, STAGE, `${repoPath(io)}/pulls/${number}/reviews`)).map(record).map(
    (review): MarkerPost => ({ author: text(record(review.user).login), appId: undefined, kind: "review", at: text(review.submitted_at), body: text(review.body), url: text(review.html_url) }),
  );
  const comments = (await everyPage(io, STAGE, `${repoPath(io)}/issues/${number}/comments`)).map(record).map((comment): MarkerPost => {
    const app = record(comment.performed_via_github_app).id;
    return { author: text(record(comment.user).login), appId: Number.isSafeInteger(app) ? (app as number) : undefined, kind: "comment", at: text(comment.created_at), body: text(comment.body), url: text(comment.html_url) };
  });
  return [...reviews, ...comments];
};

/** Fetches commits into the scratch repository, one depth each: only their trees are compared, nothing is run. */
const fetched = async (io: StatusIo, refs: readonly string[], want: string): Promise<boolean> => {
  await io.git(["fetch", "-q", "--no-tags", "--depth=1", io.remote, ...refs]);
  return (await io.git(["cat-file", "-e", `${want}^{commit}`])) !== undefined;
};

const names = async (io: StatusIo, from: string, to: string): Promise<string[] | undefined> =>
  (await io.git(["diff", "--name-only", "--no-renames", "--no-ext-diff", from, to]))?.split("\n").filter((name) => name !== "");

/**
 * An approval carried forward to `head`, which has no review of its own: the
 * latest marker for the same patch approved it, and the base's changes since
 * that marker's merge base touch none of the patch's files. Anything git
 * cannot show (a commit it cannot fetch) carries nothing.
 */
const carriedForward = async (io: StatusIo, number: number, base: string, head: string, markers: readonly FoundMarker[]): Promise<FoundMarker | undefined> => {
  if (!markers.some((found) => found.marker.verdict === "approve")) return undefined;
  const compare = record(await get(io, STAGE, `${repoPath(io)}/compare/${encodeURIComponent(base)}...${head}`));
  const mergeBase = text(record(compare.merge_base_commit).sha);
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) return undefined;
  await io.git(["init", "-q", "--bare"]);
  if (!(await fetched(io, [`refs/pull/${number}/head`, mergeBase], head)) && !(await fetched(io, [head, mergeBase], head))) return undefined;
  if ((await io.git(["cat-file", "-e", `${mergeBase}^{commit}`])) === undefined) return undefined;
  const { patchId } = await pullDiff(io, mergeBase, head);
  const candidate = carryCandidate(markers, patchId);
  if (candidate === undefined) return undefined;
  if (candidate.marker.merge_base === mergeBase) return candidate;
  if (!(await fetched(io, [candidate.marker.merge_base], candidate.marker.merge_base))) return undefined;
  const [patched, moved] = [await names(io, mergeBase, head), await names(io, candidate.marker.merge_base, mergeBase)];
  if (patched === undefined || moved === undefined) return undefined;
  return moved.some((name) => patched.includes(name)) ? undefined : candidate;
};

/**
 * Both statuses for pull request `number`'s current head; undefined when it
 * is closed, or its base branch has no review config.
 */
export const deriveStatuses = async (io: StatusIo, number: number): Promise<{ readonly head: string; readonly statuses: readonly Status[] } | undefined> => {
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
  if (!agent) {
    const skip = (context: string): Status => ({ context, state: "success", description: "not an agent PR", targetUrl: undefined });
    return { head: pr.head, statuses: [reviewStatus({ number, agent, waivedBy: undefined, current: undefined, carried: undefined, blockOn: config.blockOn }), skip(THREADS_CONTEXT)] };
  }
  const owner = await repoOwner(io, STAGE);
  const waivedBy = await waiver(io, STAGE, pr, config);
  const markers = validMarkers(await markerPosts(io, number), owner, apps);
  const current = markerFor(markers, pr.head);
  const carried = current === undefined && waivedBy === undefined ? await carriedForward(io, number, pr.base, pr.head, markers) : undefined;
  const review = reviewStatus({ number, agent, waivedBy, current, carried, blockOn: config.blockOn });
  const threads = threadsStatus(await pullThreads(io, STAGE, pr, owner));
  return { head: pr.head, statuses: [review, { context: THREADS_CONTEXT, ...threads }] };
};

/** The bot whose statuses a run's GITHUB_TOKEN sets: GitHub Actions' (App 15368). */
const ACTIONS_BOT = "github-actions[bot]";

/**
 * Sets each status on `head` unless GitHub Actions already set the same one
 * last (an equal status from anyone else, such as an agent before the
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
    if (shown?.state === status.state && shown.description === status.description && text(record(shown.creator).login) === ACTIONS_BOT) {
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

/**
 * Derives and sets pull request `number`'s statuses, then derives them again:
 * when the pull request changed while this run wrote (a new head, or a comment
 * whose own run, in another concurrency group, wrote first), it writes what
 * GitHub shows now. A stale run therefore never leaves its older result over
 * a newer one: the last write of any run follows a read made after it.
 */
const settle = async (io: StatusIo, number: number): Promise<void> => {
  let derived = await deriveStatuses(io, number);
  for (let round = 1; derived !== undefined; round++) {
    if (!(await writeStatuses(io, derived.head, derived.statuses))) return;
    const now = await deriveStatuses(io, number);
    if (now === undefined || sameStatuses(now, derived)) return;
    if (round >= WRITE_ROUNDS) {
      io.print(`agent-gh: #${number} kept changing while this run wrote its statuses; the next event's run sets them`);
      return;
    }
    io.print(`agent-gh: #${number} changed while this run wrote its statuses; setting what it shows now`);
    derived = now;
  }
};

/** The open pull requests in this repository that close `issue`. */
const closingPulls = async (io: ApiIo, issue: number): Promise<number[]> => {
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:25,includeClosedPrs:false){nodes{number repository{nameWithOwner}}}}}}`;
  const value = await get(io, STAGE, "/graphql", "POST", { query, variables: { owner: io.repo.owner, name: io.repo.name, number: issue } });
  const nodes = record(record(record(record(record(value).data).repository).issue).closedByPullRequestsReferences).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map(record)
    .filter((node) => text(record(node.repository).nameWithOwner).toLowerCase() === slug(io.repo).toLowerCase() && Number.isSafeInteger(node.number))
    .map((node) => node.number as number);
};

/**
 * `agent-gh status`: the pull request the Actions event concerns (or
 * `--pr`), or, for a comment on an issue, every open pull request here that
 * closes it; for each, derives and sets agent-review and agent-threads.
 */
export const statusCommand = async (io: StatusIo, event: { readonly name: string; readonly payload: unknown }, pr: number | undefined): Promise<void> => {
  const target = pr === undefined ? eventTarget(event.name, event.payload) : { pull: pr };
  if (target === undefined) throw new Failure(STAGE, `a ${event.name} event names no pull request; run it from the agent-review workflow's events, or pass --pr N`);
  const numbers = "pull" in target ? [target.pull] : await closingPulls(io, target.issue);
  if (numbers.length === 0) io.print(`agent-gh: no open pull request closes #${"issue" in target ? target.issue : ""}; no status set`);
  for (const number of numbers) await settle(io, number);
};
