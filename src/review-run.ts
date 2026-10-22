import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type GrantMarker, GRANT_LABEL, grantCommand, grantProblem, parseGrant, validTag } from "./allow.ts";
import { parseClaim } from "./claim.ts";
import { agentApps, REGISTRY } from "./config.ts";
import { Failure, type Stage } from "./failure.ts";
import { familyNames } from "./family.ts";
import { type Api, request } from "./github.ts";
import { HARNESSES, type Env } from "./harness.ts";
import { parseRemoteUrl, parseRepo, type Repo, slug } from "./repo.ts";
import { absent, checkState, type PushedTag, pushedRefs, type RequiredCheck, requiredChecks } from "./merge.ts";
import { type ApiIo, closingIssues, describeRequired, everyPage, pullThreads, repoOwner } from "./threads-run.ts";
import {
  AWAITING,
  byReviewer,
  type FamilyReview,
  HOLD_CONTEXT,
  holdLink,
  type HoldThread,
  labelEvents,
  labelHoldReason,
  type MarkerPost,
  markerFor,
  headRelease,
  releaseLine,
  requiredStatus,
  validMarkers,
} from "./status.ts";
import {
  agentReviewStatus,
  type ApiCall,
  type CommitStatus,
  apiCall,
  apiMerge,
  authorFamily,
  type ChecksResult,
  checksBlock,
  checksSummary,
  CONFIG_PATH,
  diffLines,
  type Effort,
  effortFor,
  type Finding,
  fullPrompt,
  type HoldConfig,
  graphqlMerges,
  graphqlRefWrites,
  graphqlReleaseRefusal,
  inlineComment,
  mergeCommand,
  outcomeSummary,
  outputTail,
  parseMarker,
  type PostedComment,
  prRepoFlag,
  type PriorReview,
  parseReview,
  parseReviewConfig,
  type PullRequest,
  type ReadyTarget,
  readyTarget,
  type ReleaseCommand,
  releaseCommand,
  RELEASE_GRANT,
  REVIEW_SCHEMA,
  type Review,
  reviewBody,
  type ReviewMarker,
  type Reviewer,
  type ReviewConfig,
  type ReviewerFamily,
  reviewerFor,
  reviewersToRun,
  reviewState,
  STATUS_CONTEXT,
  statusDescription,
  sweepPrompt,
  type Ticket,
  waivedBy,
  withIds,
} from "./review.ts";

/** Everything the review commands and the gate touch, so tests pass fakes. */
export type ReviewIo = {
  readonly api: Api;
  readonly token: string;
  readonly repo: Repo;
  /** The session's family: its work is reviewed by another family. */
  readonly family: string;
  /** The session's id as its claims carry it (`sessionId`); undefined when its environment names none. */
  readonly session?: string;
  /** Runs git in the working tree, with `input` on stdin; its trimmed stdout, or undefined when it fails. */
  readonly git: (args: readonly string[], input?: string) => Promise<string | undefined>;
  /** Runs one of the config's checks, a shell command, in `cwd` with `env` added, stopping it after `timeoutMs`; its exit code and its stdout and stderr together. */
  readonly runCheck: (command: string, cwd: string, timeoutMs: number, env: Readonly<Record<string, string>>) => Promise<CheckRun>;
  /** Runs a reviewer CLI in `cwd` with `stdin` (none when empty) and returns its exit code and stdout. */
  readonly runReviewer: (command: readonly string[], stdin: string, cwd: string) => Promise<{ readonly code: number; readonly stdout: string }>;
  readonly readFile: (path: string) => Promise<string>;
  readonly tempDir: () => string;
  /** Progress and notes, to stderr. */
  readonly print: (line: string) => void;
  /** The command's result, to stdout. */
  readonly out: (text: string) => void;
  /** Waits, between reads of a status another writer sets. */
  readonly sleep: (ms: number) => Promise<void>;
};

const call = async (io: ApiIo, stage: Stage, method: "GET" | "POST", path: string, body?: unknown, allow: readonly number[] = []) => {
  const { status, value } = await request(io.api, stage, method, path, io.token, body);
  if (status === 401) throw new Failure(stage, "GitHub refused the stored login (HTTP 401)");
  if ((status < 200 || status >= 300) && !allow.includes(status)) throw new Failure(stage, `HTTP ${status} from ${method} ${path.split("?")[0]}`);
  return { status, value };
};

const repoPath = (io: ApiIo) => `/repos/${slug(io.repo)}`;
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const labelNames = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((label) => text(record(label).name)).filter((name) => name !== "") : [];

/** The review config on `ref`, or undefined when the repository has not opted in there. */
export const readReviewConfig = async (io: ApiIo, stage: Stage, ref: string): Promise<ReviewConfig | undefined> => {
  const { status, value } = await call(io, stage, "GET", `${repoPath(io)}/contents/${CONFIG_PATH}?ref=${encodeURIComponent(ref)}`, undefined, [404]);
  if (status === 404) return undefined;
  const content = record(value).content;
  if (typeof content !== "string") throw new Failure("reading the review config", `${CONFIG_PATH} on ${ref} is not a file`);
  return parseReviewConfig(Buffer.from(content, "base64").toString("utf8"));
};

export type Pull = PullRequest & {
  readonly head: string;
  readonly base: string;
  readonly labels: readonly string[];
  readonly open: boolean;
  readonly createdAt: string;
  readonly author: string;
  /** GitHub's account type for the author: `User`, `Bot`, or `Organization`. */
  readonly authorType: string;
};

export const pull = async (io: ApiIo, stage: Stage, number: number): Promise<Pull> => {
  const value = record((await call(io, stage, "GET", `${repoPath(io)}/pulls/${number}`)).value);
  const head = text(record(value.head).sha);
  const base = text(record(value.base).ref);
  if (head === "" || base === "") throw new Failure(stage, `pull request #${number}: invalid response`);
  const user = record(value.user);
  return {
    number, title: text(value.title), body: text(value.body), head, base, labels: labelNames(value.labels), open: value.state === "open",
    createdAt: text(value.created_at), author: text(user.login), authorType: text(user.type),
  };
};

const openPullNumber = (value: unknown): number | undefined => {
  if (!Array.isArray(value)) return undefined;
  const found = value.map(record).find((item) => item.state === "open" && Number.isSafeInteger(item.number));
  return found === undefined ? undefined : (found.number as number);
};

/** The open pull request whose head branch is `branch`, or `owner:branch` for a fork's, as gh names one. */
const pullForBranch = async (io: ReviewIo, stage: Stage, branch: string) => {
  const head = branch.includes(":") ? branch : `${io.repo.owner}:${branch}`;
  return openPullNumber((await call(io, stage, "GET", `${repoPath(io)}/pulls?state=open&head=${encodeURIComponent(head)}`)).value);
};

/** The open pull request whose head is `sha`; finds it when the local branch is named differently. */
const pullForCommit = async (io: ReviewIo, stage: Stage, sha: string) => {
  const { value } = await call(io, stage, "GET", `${repoPath(io)}/commits/${sha}/pulls`, undefined, [404, 422]);
  return openPullNumber(Array.isArray(value) ? value.filter((item) => record(record(item).head).sha === sha) : undefined);
};

type IssueRef = { readonly repo: Repo; readonly number: number };

/** The first issue the pull request closes, in whichever repository (GraphQL only: REST does not expose it). */
const closingIssue = async (io: ReviewIo, number: number): Promise<IssueRef | undefined> => {
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:1){nodes{number repository{nameWithOwner}}}}}}`;
  const { value } = await call(io, "reviewing", "POST", "/graphql", { query, variables: { owner: io.repo.owner, name: io.repo.name, number } });
  const nodes = record(record(record(record(record(value).data).repository).pullRequest).closingIssuesReferences).nodes;
  const first = Array.isArray(nodes) ? record(nodes[0]) : {};
  const repo = parseRepo(text(record(first.repository).nameWithOwner));
  return Number.isSafeInteger(first.number) && repo !== undefined ? { repo, number: first.number as number } : undefined;
};

const ticket = async (io: ReviewIo, { repo, number }: IssueRef): Promise<Ticket> => {
  const path = `/repos/${slug(repo)}/issues/${number}`;
  const issue = record((await call(io, "reviewing", "GET", path)).value);
  const count = Number.isSafeInteger(issue.comments) ? (issue.comments as number) : 0;
  let lastComment: string | undefined;
  if (count > 0) {
    const page = Math.ceil(count / 100);
    const comments = (await call(io, "reviewing", "GET", `${path}/comments?per_page=100&page=${page}`)).value;
    if (Array.isArray(comments) && comments.length > 0) lastComment = text(record(comments[comments.length - 1]).body);
  }
  const ref = slug(repo).toLowerCase() === slug(io.repo).toLowerCase() ? `#${number}` : `${slug(repo)}#${number}`;
  return { ref, number, title: text(issue.title), labels: labelNames(issue.labels), body: text(issue.body), lastComment };
};

/** Every review and conversation comment on pull request `number` that may hold a review marker. */
export const markerPosts = async (io: ApiIo, stage: Stage, number: number): Promise<MarkerPost[]> => {
  const reviews = (await everyPage(io, stage, `${repoPath(io)}/pulls/${number}/reviews`)).map(record).map((review): MarkerPost => ({
    author: text(record(review.user).login), appId: undefined, kind: "review", at: text(review.submitted_at), body: text(review.body), url: text(review.html_url),
    ...(Number.isSafeInteger(review.id) ? { reviewId: review.id as number } : {}),
  }));
  const comments = (await everyPage(io, stage, `${repoPath(io)}/issues/${number}/comments`)).map(record).map((comment): MarkerPost => {
    const app = record(comment.performed_via_github_app).id;
    return { author: text(record(comment.user).login), appId: Number.isSafeInteger(app) ? (app as number) : undefined, kind: "comment", at: text(comment.created_at), body: text(comment.body), url: text(comment.html_url) };
  });
  return [...reviews, ...comments];
};

/**
 * The pull request's latest earlier review (by `family`'s reviewer, when
 * given), from the markers the workflow counts: its head, whether that head is an ancestor of `head` (so the diff
 * since it shows what changed), its findings as posted, and every comment the
 * pull request's author has posted since, outside that review, without a
 * marker. Undefined when it has none.
 */
const priorReview = async (io: ReviewIo, pr: Pull, head: string, family?: ReviewerFamily): Promise<PriorReview | undefined> => {
  const stage = "reviewing";
  const posts = await markerPosts(io, stage, pr.number);
  const valid = validMarkers(posts, await repoOwner(io, stage), agentApps());
  const found = (family === undefined ? valid : byReviewer(valid, family)).at(-1);
  if (found === undefined) return undefined;
  const prior = found.marker.head;
  const reachable = (await io.git(["merge-base", "--is-ancestor", prior, head])) !== undefined;
  io.print(
    reachable
      ? `agent-gh: re-reviewing the changes since the review of ${prior.slice(0, 8)}`
      : `agent-gh: the earlier review's head ${prior.slice(0, 8)} is not in ${head.slice(0, 8)}'s history, so this is a full review`,
  );
  if (!reachable) return { head: prior, reachable, body: "", inline: [], replies: [] };
  const lines = (await everyPage(io, stage, `${repoPath(io)}/pulls/${pr.number}/comments`)).map(record);
  const onLine = (comment: Record<string, unknown>): PostedComment => {
    const line = comment.line ?? comment.original_line;
    return { where: `\`${text(comment.path)}${Number.isSafeInteger(line) ? `:${line as number}` : ""}\``, body: text(comment.body) };
  };
  const inline = found.reviewId === undefined ? [] : lines.filter((comment) => comment.pull_request_review_id === found.reviewId).map(onLine);
  const author = (login: string) => login.toLowerCase() === pr.author.toLowerCase();
  const since = (at: string) => at > found.at;
  const replies: (PostedComment & { readonly at: string })[] = [
    ...lines
      .filter((comment) => author(text(record(comment.user).login)) && since(text(comment.created_at)) && comment.pull_request_review_id !== found.reviewId)
      .map((comment) => ({ ...onLine(comment), where: `On ${onLine(comment).where}`, at: text(comment.created_at) })),
    ...posts
      .filter((post) => author(post.author) && since(post.at) && post.body.trim() !== "" && parseMarker(post.body) === undefined)
      .map((post) => ({ where: `On the conversation`, body: post.body, at: post.at })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    head: prior, reachable,
    body: (posts.find((post) => post.url === found.url)?.body ?? "").replace(/<!-- agent-review \{[^\n]*?\} -->\n?/, ""),
    inline,
    replies: replies.map(({ where, body }) => ({ where, body })),
  };
};

/** The person who waived the review of this pull request, if one did and the label is still on it. */
export const waiver = async (io: ApiIo, stage: Stage, target: Pull, config: ReviewConfig): Promise<string | undefined> => {
  if (!target.labels.includes(config.waiverLabel)) return undefined;
  const events: unknown[] = [];
  for (let page = 1; ; page++) {
    // A history cut short could hide the App that re-added the label last, so it waives nothing.
    if (page > 10) throw new Failure(stage, `pull request #${target.number} has over 1,000 events; its waiver cannot be checked`);
    const { value } = await call(io, stage, "GET", `${repoPath(io)}/issues/${target.number}/events?per_page=100&page=${page}`);
    if (!Array.isArray(value)) throw new Failure(stage, `pull request #${target.number}'s events: invalid response`);
    events.push(...value);
    if (value.length < 100) break;
  }
  return waivedBy(events, config.waiverLabel);
};

const setStatus = (io: ReviewIo, sha: string, state: "success" | "failure", description: string) =>
  call(io, "reviewing", "POST", `${repoPath(io)}/statuses/${sha}`, { state, context: STATUS_CONTEXT, description: statusDescription(description) });

const currentBranch = async (io: ReviewIo): Promise<string | undefined> => {
  const upstream = await io.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream !== undefined && upstream.includes("/")) return upstream.slice(upstream.indexOf("/") + 1);
  const branch = await io.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === undefined || branch === "HEAD" ? undefined : branch;
};

/**
 * The gate on `gh pr ready`: in a repository whose base branch has the review
 * config, the pull request's head needs a successful agent-review status, or
 * a waiver label a person added, and no comment may wait for an agent's
 * answer (agent-threads' predicate, threads.ts). Passes silently where the
 * repository has not opted in, and when no pull request is found (gh then
 * reports that itself).
 */
export const gateReady = async (io: ReviewIo, target: ReadyTarget): Promise<void> => {
  const stage = "checking the review";
  const number = await pullNumber(io, stage, target);
  if (number === undefined) {
    // gh may resolve a selector this lookup does not, so an opted-in repository fails closed.
    const branch = text(record((await call(io, stage, "GET", repoPath(io))).value).default_branch);
    if (branch === "" || (await readReviewConfig(io, stage, branch)) === undefined) return;
    throw new Failure(stage, "cannot find the pull request `gh pr ready` names; name it by number");
  }
  const pr = await pull(io, stage, number);
  const config = await readReviewConfig(io, stage, pr.base);
  if (config === undefined) return;
  const combined = record((await call(io, stage, "GET", `${repoPath(io)}/commits/${pr.head}/status`)).value);
  const status = agentReviewStatus(combined);
  if (status?.state !== "success") await gateUnreviewed(io, stage, pr, config, status);
  const required = await pullThreads(io, stage, pr, await repoOwner(io, stage));
  if (required.length > 0) {
    throw new Failure(
      stage,
      `pull request #${number} has ${required.length} comment(s) waiting for an agent's answer: ${describeRequired(required)}; answer each on its thread, or John gives his own comment a 👍 when it needs no answer`,
    );
  }
  // A hold blocks the merge, not readiness: CI has to run on a held pull request.
  if (config.hold === undefined) return;
  const held = agentReviewStatus(combined, HOLD_CONTEXT);
  if (held?.state === "success") return;
  io.print(
    held?.state === "failure"
      ? `agent-gh: ${held.description}; John releases it before it can merge`
      : `agent-gh: ${HOLD_CONTEXT} on ${pr.head.slice(0, 8)} ${held === undefined ? "is not set yet" : `reads ${held.state} (${held.description})`}; the merge waits for it, and only John releases a hold`,
  );
};

/** Passes only for a person's waiver; otherwise refuses, naming the verdict or the missing review. */
const gateUnreviewed = async (io: ReviewIo, stage: Stage, pr: Pull, config: ReviewConfig, status: CommitStatus | undefined): Promise<void> => {
  const number = pr.number;
  const person = await waiver(io, stage, pr, config);
  if (person !== undefined) {
    io.print(`agent-gh: the review of #${number} was waived by ${person}`);
    return;
  }
  const waive = `or ask John to add the \`${config.waiverLabel}\` label`;
  // Where `require` names the author, a family yet to review this head is named, with the command that runs it alone.
  const awaiting = status?.state === "failure" ? AWAITING.exec(status.description) : null;
  if (awaiting !== null) {
    throw new Failure(stage, `pull request #${number}'s head ${pr.head.slice(0, 8)} still needs ${awaiting[1]}'s review (${status?.description}); run \`${awaiting[2]}\` on it, ${waive}`);
  }
  if (status?.state === "failure") {
    throw new Failure(
      stage,
      `pull request #${number}'s head ${pr.head.slice(0, 8)} was reviewed and blocked (${status.description}); answer each finding with \`agent-gh reply\`, push a fix, and run \`agent-gh review full\` on the new head (on this head again when only its checks timed out), ${waive}`,
    );
  }
  throw new Failure(
    stage,
    `pull request #${number}'s head ${pr.head.slice(0, 8)} ${status === undefined ? `has no ${STATUS_CONTEXT} status` : `has ${STATUS_CONTEXT} ${status.state} (${status.description})`}; run \`agent-gh review full\` on it (it reviews the pushed head), ${waive}`,
  );
};

/** The pull request a gh selector names, as gh resolves it: by number, by branch, else the current branch's or HEAD's. */
export const pullNumber = async (io: ReviewIo, stage: Stage, target: ReadyTarget): Promise<number | undefined> => {
  if ("number" in target) return target.number;
  const named = target.branch;
  const branch = named ?? (await currentBranch(io));
  const number = branch === undefined ? undefined : await pullForBranch(io, stage, branch);
  if (number !== undefined || named !== undefined) return number;
  const head = await io.git(["rev-parse", "HEAD"]);
  return head === undefined ? undefined : pullForCommit(io, stage, head);
};

const MERGE_STAGE = "checking the merge";

const branchPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

/** GitHub Actions' App, whose bot (`github-actions[bot]`) sets the agent-review workflow's statuses. */
export const ACTIONS_APP = 15368;

/** The pull request's thread, then each issue it closes, with their labels and label events now. */
const liveThreads = async (io: ReviewIo, pr: Pull): Promise<HoldThread[]> => {
  const events = async (repo: Repo, number: number) => labelEvents(await everyPage(io, MERGE_STAGE, `/repos/${slug(repo)}/issues/${number}/events`, 10));
  const threads: HoldThread[] = [{ ref: `#${pr.number}`, labels: pr.labels, events: await events(io.repo, pr.number) }];
  for (const issue of await closingIssues(io, MERGE_STAGE, pr.number)) {
    const value = record((await call(io, MERGE_STAGE, "GET", `/repos/${slug(issue.repo)}/issues/${issue.number}`)).value);
    const ref = slug(issue.repo).toLowerCase() === slug(io.repo).toLowerCase() ? `#${issue.number}` : `${slug(issue.repo)}#${issue.number}`;
    threads.push({ ref, labels: labelNames(value.labels), events: await events(issue.repo, issue.number) });
  }
  return threads;
};

/**
 * Why the hold refuses a merge of `pr`, if it does, where the base branch's
 * config has `hold`. The hold's label, and the owner's release of the head,
 * are read live, so a label added, or a release withdrawn, while its run
 * waits still counts. Then the latest agent-hold GitHub Actions set on the
 * head must link this pull request (a status on a commit is any pull
 * request's with that head) and be `success`, whether or not a ruleset
 * requires it, and one that passed on a release needs that release to
 * stand. Auto-merge (`auto`) is let through while it is not `success` only
 * where a ruleset requires agent-hold from GitHub Actions, which auto-merge
 * then waits for.
 */
const holdRefusal = async (io: ReviewIo, pr: Pull, hold: HoldConfig, required: readonly RequiredCheck[], auto: boolean, byApps: () => Promise<Record<string, unknown>[]>): Promise<string | undefined> => {
  const releasing = `only John releases it, with a comment of his own on #${pr.number}: \`${releaseLine(pr.head)}\``;
  const owner = await repoOwner(io, MERGE_STAGE);
  const comments = (await everyPage(io, MERGE_STAGE, `${repoPath(io)}/issues/${pr.number}/comments`)).map((item) => {
    const comment = record(item);
    const app = record(comment.performed_via_github_app).id;
    return { author: text(record(comment.user).login), body: text(comment.body), edited: text(comment.updated_at) !== text(comment.created_at), appId: Number.isSafeInteger(app) ? (app as number) : undefined, at: text(comment.created_at) };
  });
  const release = headRelease(comments, owner, pr.head);
  const label = labelHoldReason(await liveThreads(io, pr), hold, release);
  if (label !== undefined) return `pull request #${pr.number} is ${label}; ${releasing}`;
  const shown = (await byApps()).find((status) => status.context === HOLD_CONTEXT && status.app_id === ACTIONS_APP);
  const link = text(shown?.target_url).toLowerCase();
  const own = [false, true].some((released) => holdLink(slug(io.repo), pr.number, released).toLowerCase() === link);
  const leansOnRelease = holdLink(slug(io.repo), pr.number, true).toLowerCase() === link;
  const cleared = shown?.state === "success" && own && (!leansOnRelease || release !== undefined);
  if (cleared) return undefined;
  if (auto && required.some((entry) => entry.context === HOLD_CONTEXT && entry.app === ACTIONS_APP)) return undefined;
  const why =
    shown === undefined
      ? `no ${HOLD_CONTEXT} status from GitHub Actions`
      : !own
        ? `the latest ${HOLD_CONTEXT} on it is another pull request's (${text(shown.target_url) || "no link"})`
        : shown.state === "success"
          ? `it passed on ${owner}'s release of ${pr.head.slice(0, 8)}, which no longer stands`
          : `${HOLD_CONTEXT} ${shown.state === "failure" || shown.state === "error" ? "failed" : text(shown.state)}: ${text(shown.description)}`;
  const wait = auto ? `; \`--auto\` would not wait for it, since ${pr.base}'s rules do not require ${HOLD_CONTEXT} from GitHub Actions` : "";
  return `pull request #${pr.number}'s head ${pr.head.slice(0, 8)} is not cleared by ${HOLD_CONTEXT} (${why})${wait}; ${releasing}, and an agent merges once ${HOLD_CONTEXT} passes`;
};

/**
 * The guard on `gh pr merge` in an agent session: agents act as John, who may
 * bypass the base branch's rules, so every check the branch requires (its
 * rulesets' and classic protection's) must have passed on the pull request's
 * head. Auto-merge (`auto`) is let through whatever the checks say: GitHub
 * merges it only once they pass, even for a bypass actor (checked live on
 * a ruleset with John as an always-bypass actor). `--admin` is always
 * refused, and so is a pull request the guard cannot find. A branch that
 * requires no checks is not held. Where the base branch's config has
 * `hold`, agent-hold must also pass (`holdRefusal`). Returns the head it
 * checked, which the merge must then require, so a commit pushed meanwhile
 * is not merged in its place.
 */
export const gateMerge = async (io: ReviewIo, target: ReadyTarget, admin: boolean, auto = false): Promise<string> => {
  const stage = MERGE_STAGE;
  if (admin) throw new Failure(stage, "an agent never merges with `--admin`, which skips the base branch's requirements; merge without it once the required checks pass, or ask John");
  const number = await pullNumber(io, stage, target);
  if (number === undefined) throw new Failure(stage, "cannot find the pull request `gh pr merge` names; name it by number");
  const pr = await pull(io, stage, number);
  const hold = (await readReviewConfig(io, stage, pr.base))?.hold;
  if (auto && hold === undefined) return pr.head;
  const base = branchPath(pr.base);
  const rules = await pages(io, stage, `${repoPath(io)}/rules/branches/${base}`);
  const branch = (await call(io, stage, "GET", `${repoPath(io)}/branches/${base}`)).value;
  const required = requiredChecks(rules, branch);
  let byApp: Promise<Record<string, unknown>[]> | undefined;
  const byApps = () => (byApp ??= appStatuses(io, stage, pr.head));
  if (hold !== undefined) {
    const refused = await holdRefusal(io, pr, hold, required, auto, byApps);
    if (refused !== undefined) throw new Failure(stage, refused);
  }
  if (auto || required.length === 0) return pr.head;
  const statuses = await counted(io, stage, `${repoPath(io)}/commits/${pr.head}/status?`, "statuses");
  const bySomeApp = required.some((check) => check.app !== undefined) ? await byApps() : [];
  let workflows: Map<number, number> | undefined;
  const unmet: string[] = [];
  for (const check of required) {
    const runs = await counted(io, stage, `${repoPath(io)}/commits/${pr.head}/check-runs?check_name=${encodeURIComponent(check.context)}&filter=latest&`, "check_runs");
    // Several suites' runs: which Actions workflow each suite ran, so a newer run of a workflow supersedes an older one.
    if (runs.length > 1 && workflows === undefined) workflows = await suiteWorkflows(io, stage, pr.head);
    const state = checkState(check, check.app === undefined ? statuses : bySomeApp, runs, workflows);
    if (state !== "passed") unmet.push(`\`${check.context}\` ${state}`);
  }
  if (unmet.length === 0) return pr.head;
  throw new Failure(
    stage,
    `pull request #${number}'s head ${pr.head.slice(0, 8)} has not passed every check ${pr.base} requires (${unmet.join(", ")}); wait for them to pass, fix what fails, or merge with \`--auto\`, which GitHub completes once they pass`,
  );
};

/** Each Actions workflow run's check suite id, mapped to its workflow's id, for the commit. */
const suiteWorkflows = async (io: ReviewIo, stage: Stage, sha: string): Promise<Map<number, number>> => {
  const map = new Map<number, number>();
  for (const run of (await counted(io, stage, `${repoPath(io)}/actions/runs?head_sha=${sha}&`, "workflow_runs")).map(record)) {
    if (Number.isSafeInteger(run.check_suite_id) && Number.isSafeInteger(run.workflow_id)) map.set(run.check_suite_id as number, run.workflow_id as number);
  }
  return map;
};

/**
 * The commit's statuses, latest first, each with the id of the App whose bot
 * set it (`app_id`; none for a person's): a status the agent-review workflow
 * sets with GITHUB_TOKEN is GitHub Actions' (`github-actions[bot]`, App
 * 15368), which a ruleset can tie a required check to.
 */
const appStatuses = async (io: ReviewIo, stage: Stage, sha: string): Promise<Record<string, unknown>[]> => {
  const statuses = (await everyPage(io, stage, `${repoPath(io)}/commits/${sha}/statuses`, 10)).map(record);
  const apps = new Map<string, number | undefined>();
  const out: Record<string, unknown>[] = [];
  for (const status of statuses) {
    const login = text(record(status.creator).login);
    const slugName = /^([A-Za-z0-9-]+)\[bot\]$/.exec(login)?.[1];
    if (slugName !== undefined && !apps.has(slugName)) {
      const { status: code, value } = await call(io, stage, "GET", `/apps/${slugName}`, undefined, [404]);
      const id = record(value).id;
      apps.set(slugName, code === 200 && Number.isSafeInteger(id) ? (id as number) : undefined);
    }
    out.push({ ...status, app_id: slugName === undefined ? undefined : apps.get(slugName) });
  }
  return out;
};

const PUSH_STAGE = "checking the push";

/**
 * Why an agent may not move `branch` itself, if it may not: it is the
 * repository's default branch, or a ruleset or classic protection requires
 * status checks on it. Agents act as John, who may bypass both, so the
 * branch moves only through a pull request.
 */
export const branchHeld = async (io: ReviewIo, stage: Stage, branch: string): Promise<string | undefined> => {
  const defaultBranch = text(record((await call(io, stage, "GET", repoPath(io))).value).default_branch);
  if (defaultBranch === "") throw new Failure(stage, `${slug(io.repo)}: invalid response`);
  if (branch === defaultBranch) return `\`${branch}\` is ${slug(io.repo)}'s default branch`;
  const path = branchPath(branch);
  const rules = await pages(io, stage, `${repoPath(io)}/rules/branches/${path}`);
  // A branch that does not exist yet has no classic protection of its own; its rulesets still apply.
  const classic = await call(io, stage, "GET", `${repoPath(io)}/branches/${path}`, undefined, [404]);
  if (requiredChecks(rules, classic.status === 404 ? {} : classic.value).length > 0) return `\`${branch}\` requires status checks in ${slug(io.repo)}`;
  return undefined;
};

/** The pre-push guard: refuses a push that moves a branch `branchHeld` holds. */
export const gatePush = async (io: ReviewIo, branches: readonly string[]): Promise<void> => {
  for (const branch of branches) {
    const held = await branchHeld(io, PUSH_STAGE, branch);
    if (held !== undefined) throw new Failure(PUSH_STAGE, `${held}; agents never move it themselves (John may bypass its rules, and agents act as John): push another branch and open a pull request`);
  }
};

/**
 * `agent-gh guard pre-push` in an agent session: git's remote URL argument
 * and the hook's stdin. A push that moves a held branch on GitHub is
 * refused, and so is one whose repository or rules cannot be determined. A
 * new tag needs John's grant (`gateRelease`), at the commit it points at;
 * deleting or moving a tag is always refused. A remote on a local path is
 * not GitHub, and is not held.
 */
export const guardPush = async (
  url: string | undefined,
  stdin: string,
  deps: Pick<GhDispatch, "withToken" | "io">,
): Promise<void> => {
  const refs = pushedRefs(stdin);
  if (refs === undefined) throw new Failure(PUSH_STAGE, "git's pre-push lines are not in the form agent-gh reads");
  const tags = refs.tags.filter((tag) => tag.local !== tag.remote);
  if (refs.branches.length === 0 && tags.length === 0) return;
  if (url === undefined) throw new Failure(PUSH_STAGE, "the pre-push hook passed no remote URL; run `agent-gh guard pre-push \"$@\"` from it");
  const repo = parseRemoteUrl(url);
  if (repo === undefined) {
    if (url.startsWith("/") || url.startsWith(".") || url.startsWith("file://")) return;
    throw new Failure(PUSH_STAGE, "cannot tell which GitHub repository this push goes to; use a https://github.com/ or git@github.com: remote");
  }
  for (const tag of tags) {
    if (absent(tag.local)) throw new Failure(RELEASE_STAGE, tagRefusal(tag.tag, repo, "delete"));
    if (!absent(tag.remote)) throw new Failure(RELEASE_STAGE, `\`${tag.tag}\` already exists in ${slug(repo)}, and ${tagRefusal(tag.tag, repo, "move")}`);
  }
  await deps.withToken(repo, async (env) => {
    const io = deps.io(repo, env);
    await gatePush(io, refs.branches);
    for (const tag of tags) await gateRelease(io, tag.tag, () => localCommit(io, tag));
    return 0;
  });
};

const RELEASE_STAGE = "checking the release";

/** Why an agent never moves or deletes a tag, naming what a grant does allow. */
const tagRefusal = (tag: string, repo: Repo | undefined, what: "move" | "delete" | "move or delete"): string =>
  `agents never ${what} a tag, grant or not (\`${tag}\`${repo === undefined ? "" : ` in ${slug(repo)}`}): \`${grantCommand(tag, repo)}\` lets them create a new tag once and write its release; ask John to ${what} this one himself`;

/** The commit a pushed tag points at, peeled from the local object git sends. */
const localCommit = async (io: ReviewIo, tag: PushedTag): Promise<string> => {
  const commit = await io.git(["rev-parse", "--verify", "--quiet", `${tag.local}^{commit}`]);
  if (commit === undefined || !/^[0-9a-f]{40}$/i.test(commit)) throw new Failure(RELEASE_STAGE, `cannot tell which commit tag \`${tag.tag}\` points at`);
  return commit.toLowerCase();
};

/**
 * Passes only when John has granted `tag` in the io's repository (allow.ts):
 * an open issue labelled GRANT_LABEL, opened by the repository's owner with
 * no App under GRANT_HOURS ago, never edited, closed, or transferred since,
 * whose marker names the tag and, when it names a commit, the one `commit`
 * gives for it (where the tag points or will point; omitted for a write that
 * places no tag). Returns that grant; otherwise refuses, naming the command
 * John runs.
 */
export const gateRelease = async (io: ReviewIo, tag: string, commit?: (granted: string) => Promise<string>): Promise<GrantMarker> => {
  const stage = RELEASE_STAGE;
  const owner = await repoOwner(io, stage);
  const issues = await everyPage(io, stage, `${repoPath(io)}/issues?state=open&labels=${encodeURIComponent(GRANT_LABEL)}&creator=${encodeURIComponent(owner)}`, 10);
  const reasons: string[] = [];
  for (const issue of issues.map(record)) {
    const grant = parseGrant(text(issue.body));
    if (grant === undefined || grant.tag !== tag || !Number.isSafeInteger(issue.number)) continue;
    const number = issue.number as number;
    const problem = grantProblem(issue, owner, Date.now()) ?? (await historyProblem(io, number));
    if (problem !== undefined) {
      reasons.push(`#${number} ${problem}`);
      continue;
    }
    if (grant.sha !== null && commit !== undefined) {
      const at = await commit(grant.sha);
      if (at !== grant.sha) {
        reasons.push(`#${number} grants it at ${grant.sha.slice(0, 8)}, but it points at ${at.slice(0, 8)}`);
        continue;
      }
    }
    io.print(`agent-gh: John's grant #${number} allows \`${tag}\` in ${slug(io.repo)}`);
    return grant;
  }
  throw new Failure(
    stage,
    `John has not granted \`${tag}\` in ${slug(io.repo)}${reasons.length === 0 ? "" : ` (${reasons.join("; ")})`}, and agents push a tag or write a release only with his grant; ask John to run \`${grantCommand(tag, io.repo)}\``,
  );
};

/** Why a grant issue's history voids it: an edit to its body, or a close, reopen, or transfer since it was opened. */
const historyProblem = async (io: ReviewIo, number: number): Promise<string | undefined> => {
  const query =
    "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){lastEditedAt history:timelineItems(itemTypes:[CLOSED_EVENT,REOPENED_EVENT,TRANSFERRED_EVENT],first:1){totalCount}}}}";
  const { value } = await call(io, RELEASE_STAGE, "POST", "/graphql", { query, variables: { owner: io.repo.owner, name: io.repo.name, number } });
  const issue = record(record(record(value).data).repository).issue;
  const count = record(record(issue).history).totalCount;
  if (typeof issue !== "object" || issue === null || !Number.isSafeInteger(count)) throw new Failure(RELEASE_STAGE, `cannot read the history of grant #${number}`);
  if (record(issue).lastEditedAt !== null) return "was edited after it was opened";
  if ((count as number) > 0) return "was closed, reopened, or transferred since it was opened";
  return undefined;
};

const HEX = /^[0-9a-f]{40}$/i;

/** The commit a tag object or commit `sha` names, peeling annotated tags. */
const peel = async (io: ReviewIo, type: unknown, sha: string, name: string): Promise<string> => {
  let [kind, at] = [type, sha];
  for (let depth = 0; kind === "tag" && HEX.test(at) && depth < 10; depth++) {
    const object = record(record((await call(io, RELEASE_STAGE, "GET", `${repoPath(io)}/git/tags/${at}`)).value).object);
    [kind, at] = [object.type, text(object.sha)];
  }
  if (kind !== "commit" || !HEX.test(at)) throw new Failure(RELEASE_STAGE, `\`${name}\` in ${slug(io.repo)} does not point at a commit agent-gh can find`);
  return at.toLowerCase();
};

/** Where `tag` points on GitHub, as a commit; undefined when GitHub has no such tag. */
const tagCommit = async (io: ReviewIo, tag: string): Promise<string | undefined> => {
  const { status, value } = await call(io, RELEASE_STAGE, "GET", `${repoPath(io)}/git/ref/tags/${branchPath(tag)}`, undefined, [404, 409]);
  if (status === 404 || status === 409) return undefined;
  const ref = record(value);
  const object = record(ref.object);
  if (ref.ref !== `refs/tags/${tag}` || typeof object.sha !== "string") throw new Failure(RELEASE_STAGE, `cannot read where \`${tag}\` points in ${slug(io.repo)}`);
  return peel(io, object.type, object.sha, tag);
};

/** The commit an object id names (an annotated tag's, peeled), where a new tag would point; refused when it names neither. */
const objectCommit = async (io: ReviewIo, sha: string, tag: string): Promise<string> => {
  if (!HEX.test(sha)) throw new Failure(RELEASE_STAGE, `cannot read the commit \`${tag}\` would point at; give its full sha`);
  const annotated = await call(io, RELEASE_STAGE, "GET", `${repoPath(io)}/git/tags/${sha}`, undefined, [404, 422]);
  if (annotated.status === 200) {
    const object = record(record(annotated.value).object);
    return peel(io, object.type, text(object.sha), tag);
  }
  const commit = await call(io, RELEASE_STAGE, "GET", `${repoPath(io)}/git/commits/${sha}`, undefined, [404, 422]);
  if (commit.status === 200 && text(record(commit.value).sha).toLowerCase() === sha.toLowerCase()) return sha.toLowerCase();
  throw new Failure(RELEASE_STAGE, `${sha.slice(0, 8)}, where \`${tag}\` would point, is no commit or tag in ${slug(io.repo)}`);
};

/** The commit a branch or commit names on GitHub, as a release's `--target` does. */
const resolveCommit = async (io: ReviewIo, ref: string): Promise<string> => {
  if (HEX.test(ref)) return ref.toLowerCase();
  const found = validTag(ref) ? await call(io, RELEASE_STAGE, "GET", `${repoPath(io)}/commits/${branchPath(ref)}`, undefined, [404, 422]) : undefined;
  const sha = text(record(found?.value).sha);
  if (found?.status !== 200 || !HEX.test(sha)) throw new Failure(RELEASE_STAGE, `cannot find the commit \`${ref}\` names in ${slug(io.repo)}`);
  return sha.toLowerCase();
};

/**
 * The release guard for a write that names `tag`: John's grant must hold,
 * and when it names a commit the tag must point there: where it points on
 * GitHub, or, when the tag does not exist yet and the write can create it,
 * where `creates` says it will (given the granted commit). Returns the
 * granted commit to pin a new tag to, if any.
 */
const gateTag = async (io: ReviewIo, tag: string, creates?: (granted: string) => Promise<string>): Promise<string | undefined> => {
  const existing = await tagCommit(io, tag);
  if (existing !== undefined || creates === undefined) {
    await gateRelease(io, tag, existing === undefined ? undefined : async () => existing);
    return undefined;
  }
  return (await gateRelease(io, tag, creates)).sha ?? undefined;
};

/**
 * `gh release` behind the release guard: a read runs as it is; `create`,
 * `edit`, `upload`, and `delete-asset` need John's grant for their tag (and
 * for the tag `edit --tag` moves the release to), and a tag they create is
 * pinned to the granted commit with `--target`; `delete`, and a subcommand
 * this release does not know, are refused.
 */
const dispatchRelease = async (args: readonly string[], release: ReleaseCommand, repo: Repo | undefined, deps: GhDispatch): Promise<number> => {
  if (release.kind === "read") return deps.run(args);
  const target = release.repo === undefined ? repo : parseRepo(release.repo);
  if (target === undefined) throw new Failure(RELEASE_STAGE, `cannot tell which repository \`gh release\` writes to; pass -R OWNER/REPO (a release write needs ${RELEASE_GRANT})`);
  if (release.kind === "unknown") {
    throw new Failure(RELEASE_STAGE, `agent-gh does not know what \`gh release ${release.subcommand}\` writes, so it refuses it; create, edit, upload, and delete-asset run with ${RELEASE_GRANT}`);
  }
  const tag = release.tag;
  if (release.subcommand === "delete") {
    throw new Failure(RELEASE_STAGE, `agents never delete a release, grant or not${tag === undefined ? "" : ` (\`${tag}\` in ${slug(target)})`}: \`${grantCommand(tag ?? "<tag>", target)}\` lets them create and edit one; ask John to delete it himself`);
  }
  if (tag === undefined) {
    throw new Failure(RELEASE_STAGE, `cannot read which tag \`gh release ${release.subcommand}\` names; give it first, as \`gh release ${release.subcommand} <tag>\` (it needs ${RELEASE_GRANT})`);
  }
  return deps.withToken(target, async (env) => {
    const io = deps.io(target, env);
    let pin: string | undefined;
    if (release.subcommand === "create" || release.subcommand === "edit") {
      const final = release.newTag ?? tag;
      // An edit that moves the release to another tag needs a grant for both.
      if (final !== tag) await gateTag(io, tag);
      pin = await gateTag(io, final, async (granted) => (release.target === undefined ? granted : resolveCommit(io, release.target)));
    } else await gateTag(io, tag);
    return deps.runWith(pin === undefined ? args : withFlags(args, ["--target", pin]), env);
  });
};

/** A release's tag and target, by its id, for a REST write to it. */
const releaseOf = async (io: ReviewIo, id: number): Promise<{ readonly tag: string; readonly target: string | undefined }> => {
  const { status, value } = await call(io, RELEASE_STAGE, "GET", `${repoPath(io)}/releases/${id}`, undefined, [404]);
  const tag = text(record(value).tag_name);
  if (status === 404 || tag === "") throw new Failure(RELEASE_STAGE, `cannot find release ${id} in ${slug(io.repo)}, whose tag needs ${RELEASE_GRANT}`);
  const target = text(record(value).target_commitish);
  return { tag, target: target === "" ? undefined : target };
};

/** Every item of a paginated response that reports its `total_count`, refusing one too long, or too short, to trust. */
const counted = async (io: ReviewIo, stage: Stage, path: string, field: string): Promise<unknown[]> => {
  const items: unknown[] = [];
  const where = path.replace(/^\/repos\/[^/]+\/[^/]+/, "").split("?")[0];
  for (let page = 1; page <= 10; page++) {
    const value = record((await call(io, stage, "GET", `${path}per_page=100&page=${page}`)).value);
    const list = value[field];
    if (!Array.isArray(list) || !Number.isSafeInteger(value.total_count)) throw new Failure(stage, `${where}: invalid response`);
    items.push(...list);
    if (items.length >= (value.total_count as number)) return items;
    // A short page before the total means results the guard cannot see.
    if (list.length < 100) throw new Failure(stage, `${where} lists fewer results than its total`);
  }
  throw new Failure(stage, `${where} lists over 1,000 results`);
};

/** Every item of a paginated list endpoint, refusing one too long to read whole. */
const pages = async (io: ReviewIo, stage: Stage, path: string): Promise<unknown[]> => {
  const items: unknown[] = [];
  for (let page = 1; page <= 10; page++) {
    const { value } = await call(io, stage, "GET", `${path}?per_page=100&page=${page}`);
    if (!Array.isArray(value)) throw new Failure(stage, `${path.replace(/^\/repos\/[^/]+\/[^/]+/, "")}: invalid response`);
    items.push(...value);
    if (value.length < 100) return items;
  }
  throw new Failure(stage, `${path.replace(/^\/repos\/[^/]+\/[^/]+/, "")} lists over 1,000 rules`);
};

/** What `dispatchGh` needs from the CLI: tokens, the gate's I/O, files, and gh itself. */
export interface GhDispatch {
  /** Runs `use` with one token for the repository (none for a command that names none), shared by the gate and the gh it lets through. */
  withToken: (repo: Repo | undefined, use: (env: Record<string, string>) => Promise<number>) => Promise<number>;
  /** Reads a file `gh api` would read (`--input`, `-F name=@file`), or undefined when it cannot. */
  readFile: (path: string) => Promise<string | undefined>;
  io: (repo: Repo, env: Record<string, string>) => ReviewIo;
  /** Runs gh with the token the gate used. */
  runWith: (args: readonly string[], env: Record<string, string>) => Promise<number>;
  /** Runs gh as any other command, with its own token. */
  run: (args: readonly string[]) => Promise<number>;
}

/**
 * Runs a gh command, holding `gh pr ready` until its pull request's head is
 * reviewed, `gh pr merge` until its required checks pass, and a release
 * write until John grants its tag. The gh shim sends only agent sessions' gh
 * here; a person's gh never reaches it.
 */
export const dispatchGh = async (args: readonly string[], repo: Repo | undefined, deps: GhDispatch): Promise<number> => {
  const ready = readyTarget(args);
  const merge = ready === undefined ? mergeCommand(args) : undefined;
  const target = ready ?? merge?.target;
  if (target === undefined) {
    const release = releaseCommand(args);
    if (release !== undefined) return dispatchRelease(args, release, repo, deps);
    const api = apiCall(args);
    return api === undefined ? deps.run(args) : dispatchApi(args, api, repo, deps);
  }
  // gh acts on a pull request URL's repository, whatever the clone or flags say; else on -R's, in any spelling gh reads.
  const flag = prRepoFlag(args);
  const targetRepo = "repo" in target && target.repo !== undefined ? parseRepo(target.repo) : flag !== undefined ? parseRepo(flag) : repo;
  if (targetRepo === undefined) {
    if (merge === undefined && flag === undefined) return deps.run(args);
    throw new Failure(merge === undefined ? "checking the review" : MERGE_STAGE, "cannot tell which repository the pull request is in; pass -R OWNER/REPO");
  }
  return deps.withToken(targetRepo, async (env) => {
    const io = deps.io(targetRepo, env);
    if (merge === undefined) {
      await gateReady(io, target);
      return deps.runWith(args, env);
    }
    const head = await gateMerge(io, merge.target, merge.admin, merge.auto);
    if (merge.headCommit !== undefined && merge.headCommit !== head) {
      throw new Failure(MERGE_STAGE, `--match-head-commit ${merge.headCommit.slice(0, 8)} is not the head whose checks passed (${head.slice(0, 8)})`);
    }
    return deps.runWith(merge.headCommit === undefined ? withFlags(args, ["--match-head-commit", head]) : args, env);
  });
};

/** gh's arguments with `extra` flags added before any `--`, where gh still reads them as flags. */
const withFlags = (args: readonly string[], extra: readonly string[]): string[] => {
  const end = args.indexOf("--");
  return end < 0 ? [...args, ...extra] : [...args.slice(0, end), ...extra, ...args.slice(end)];
};

/**
 * `gh api` behind the merge and release guards: a REST or GraphQL call that
 * merges a pull request runs only when `gh pr merge` would, and one that
 * creates a tag or writes a release only when John has granted its tag; one
 * that merges outside a pull request, moves or deletes a tag, approves a
 * deployment, or that the guards cannot read, is refused.
 */
const dispatchApi = async (args: readonly string[], api: ApiCall, repo: Repo | undefined, deps: GhDispatch): Promise<number> => {
  const plan = apiMerge(api);
  if (plan.kind === "none") return deps.run(args);
  if (plan.kind === "refuse") throw new Failure(plan.release === true ? RELEASE_STAGE : MERGE_STAGE, plan.reason);
  if (plan.kind === "tag") {
    const target = plan.repo === undefined ? repo : parseRepo(plan.repo);
    if (plan.tag === "") throw new Failure(RELEASE_STAGE, `cannot tell which tag \`gh api\` writes to; agents never move or delete a tag, and a new one needs ${RELEASE_GRANT}`);
    throw new Failure(RELEASE_STAGE, tagRefusal(plan.tag, target, "move or delete"));
  }
  if (plan.kind === "release") return dispatchReleaseApi(args, api, plan, repo, deps);
  if (plan.kind === "ref" || plan.kind === "ref-field") {
    const target = plan.repo === undefined ? repo : parseRepo(plan.repo);
    if (target === undefined) throw new Failure(PUSH_STAGE, "cannot tell which repository `gh api` writes to; name it in the endpoint");
    const named = plan.kind === "ref" ? plan.branch : await bodyField(api, plan.field, deps.readFile);
    // A new ref that is not a branch carries no required checks; a new tag needs John's grant.
    if (plan.kind === "ref-field" && plan.field === "ref" && !named?.startsWith("refs/heads/")) {
      if (named === undefined) throw new Failure(PUSH_STAGE, "cannot read the ref `gh api` creates");
      if (!/^refs\/tags\//i.test(named)) return deps.run(args);
      const tag = named.slice("refs/tags/".length);
      const sha = await bodyField(api, "sha", deps.readFile, RELEASE_STAGE);
      if (tag === "" || sha === undefined) throw new Failure(RELEASE_STAGE, `cannot read the tag \`gh api\` creates, or its sha; give them with -f ref=refs/tags/<tag> -f sha=<sha> (it needs ${RELEASE_GRANT})`);
      return deps.withToken(target, async (env) => {
        const io = deps.io(target, env);
        await gateRelease(io, tag, () => objectCommit(io, sha, tag));
        return deps.runWith(args, env);
      });
    }
    return deps.withToken(target, async (env) => {
      const io = deps.io(target, env);
      const branch = named === undefined ? text(record((await call(io, PUSH_STAGE, "GET", repoPath(io))).value).default_branch) : named.replace(/^refs\/heads\//, "");
      await gatePush(io, [branch]);
      return deps.runWith(args, env);
    });
  }
  if (plan.kind === "rest") {
    const target = plan.repo === undefined ? repo : parseRepo(plan.repo);
    if (target === undefined) throw new Failure(MERGE_STAGE, "cannot tell which repository `gh api` merges in; name it in the endpoint");
    // The merge must require the head whose checks passed: GitHub refuses it (409) if the head has moved.
    const given = await restSha(api, deps.readFile);
    return deps.withToken(target, async (env) => {
      const head = await gateMerge(deps.io(target, env), { number: plan.number }, false);
      if (given !== undefined && given !== head) throw new Failure(MERGE_STAGE, `the merge's sha ${given.slice(0, 8)} is not the head whose checks passed (${head.slice(0, 8)})`);
      return deps.runWith(given === undefined ? withFlags(args, ["-f", `sha=${head}`]) : args, env);
    });
  }
  const request = await graphqlRequest(api, deps.readFile);
  const merges = graphqlMerges(request.query, request.variables);
  if ("refuse" in merges) throw new Failure(MERGE_STAGE, merges.refuse);
  const released = graphqlReleaseRefusal(request.query);
  if (released !== undefined) throw new Failure(RELEASE_STAGE, released);
  const writes = graphqlRefWrites(request.query, request.variables);
  if ("refuse" in writes) throw new Failure(PUSH_STAGE, writes.refuse);
  if (merges.length === 0 && writes.length === 0) return deps.run(args);
  return deps.withToken(repo, async (env) => {
    // A node lookup is GraphQL, which names no repository; this io's own is unused.
    const anywhere = () => deps.io(repo ?? { owner: "-", name: "-" }, env);
    for (const write of writes) {
      if ("tag" in write) {
        const io = deps.io(await repoForNode(anywhere(), write.repositoryId), env);
        await gateRelease(io, write.tag, () => objectCommit(io, write.oid, write.tag));
        continue;
      }
      const target = "node" in write ? await refForNode(anywhere(), write.node) : { repo: parseRepo(write.repo), branch: write.branch, tag: undefined };
      if (target.repo === undefined) throw new Failure(PUSH_STAGE, "cannot tell which repository a GraphQL ref write moves a branch in");
      if (target.tag !== undefined) throw new Failure(RELEASE_STAGE, tagRefusal(target.tag, target.repo, "move or delete"));
      if (target.branch !== undefined) await gatePush(deps.io(target.repo, env), [target.branch]);
    }
    for (const merge of merges) {
      // The node lookup is GraphQL, which names no repository; the io's own is unused.
      const pr = await pullForNode(deps.io(repo ?? { owner: "-", name: "-" }, env), merge.id);
      const head = await gateMerge(deps.io(pr.repo, env), { number: pr.number }, false, merge.auto);
      if (merge.expectedHeadOid !== head) {
        throw new Failure(MERGE_STAGE, `a GraphQL merge of #${pr.number} must give expectedHeadOid: "${head}", the head whose checks passed, so a later push is not merged in its place`);
      }
    }
    return deps.runWith(args, env);
  });
};

/**
 * A REST release write behind the release guard: a new release needs John's
 * grant for its `tag_name`; an edit, a deletion, or an asset upload needs it
 * for the release's own tag, read from GitHub, and an edit that renames the
 * tag for the new one too. A write that can create a tag that does not exist
 * yet (a new release, or an edit, which may publish a draft) must give the
 * granted commit as `target_commitish` when the grant names one, since a
 * branch could move before GitHub tags it.
 */
const dispatchReleaseApi = async (args: readonly string[], api: ApiCall, plan: { readonly repo: string | undefined; readonly id: number | undefined }, repo: Repo | undefined, deps: GhDispatch): Promise<number> => {
  const target = plan.repo === undefined ? repo : parseRepo(plan.repo);
  if (target === undefined) throw new Failure(RELEASE_STAGE, `cannot tell which repository \`gh api\` writes a release in; name it in the endpoint (it needs ${RELEASE_GRANT})`);
  const creates = plan.id === undefined || api.method === "PATCH";
  const named = creates ? await bodyField(api, "tag_name", deps.readFile, RELEASE_STAGE) : undefined;
  const commitish = creates ? await bodyField(api, "target_commitish", deps.readFile, RELEASE_STAGE) : undefined;
  if (plan.id === undefined && named === undefined) throw new Failure(RELEASE_STAGE, `cannot read the tag of the release \`gh api\` creates; give it with -f tag_name=<tag> (it needs ${RELEASE_GRANT})`);
  return deps.withToken(target, async (env) => {
    const io = deps.io(target, env);
    const release = plan.id === undefined ? undefined : await releaseOf(io, plan.id);
    const tag = named ?? (release?.tag as string);
    if (release !== undefined && release.tag !== tag) await gateTag(io, release.tag);
    const where = commitish ?? release?.target;
    await gateTag(
      io,
      tag,
      creates
        ? async (granted) => {
            if (where !== undefined && HEX.test(where)) return where.toLowerCase();
            throw new Failure(RELEASE_STAGE, `\`${tag}\` does not exist in ${slug(io.repo)} yet, and John granted it at ${granted}: give -f target_commitish=${granted}, so GitHub tags that commit`);
          }
        : undefined,
    );
    return deps.runWith(args, env);
  });
};

/** The `sha` a REST merge requires of the head, from its fields or `--input` body; refused when the body cannot be read. */
const restSha = async (api: ApiCall, readFile: (path: string) => Promise<string | undefined>): Promise<string | undefined> => {
  if (api.input !== undefined) {
    const content = api.input === "-" ? undefined : await readFile(api.input);
    let sha: unknown;
    try {
      sha = content === undefined ? undefined : record(JSON.parse(content)).sha;
    } catch {
      sha = undefined;
    }
    if (typeof sha !== "string") throw new Failure(MERGE_STAGE, "a `gh api` merge with `--input` must give the head's `sha` in a body agent-gh can read");
    return sha;
  }
  const field = api.fields.findLast((candidate) => candidate.name === "sha");
  if (field !== undefined && !field.raw && field.value.startsWith("@")) throw new Failure(MERGE_STAGE, "give a `gh api` merge's sha with `-f sha=<sha>`");
  return field?.value;
};

const UNREADABLE = "cannot read the GraphQL query `gh api graphql` sends; pass it with `-f query=...` or `--input <file>`";

/** The query and variables `gh api graphql` sends, read as gh builds them: from `--input`, else from its fields. */
export const graphqlRequest = async (
  api: ApiCall,
  readFile: (path: string) => Promise<string | undefined>,
): Promise<{ readonly query: string; readonly variables: Readonly<Record<string, unknown>> }> => {
  const file = async (path: string) => {
    const content = path === "-" || path === "" ? undefined : await readFile(path);
    if (content === undefined) throw new Failure(MERGE_STAGE, UNREADABLE);
    return content;
  };
  if (api.input !== undefined) {
    let body: Record<string, unknown>;
    try {
      body = record(JSON.parse(await file(api.input)));
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw new Failure(MERGE_STAGE, UNREADABLE);
    }
    if (typeof body.query !== "string") throw new Failure(MERGE_STAGE, UNREADABLE);
    return { query: body.query, variables: record(body.variables) };
  }
  let query: string | undefined;
  const variables: Record<string, unknown> = Object.create(null);
  for (const field of api.fields) {
    // -F reads `@file` (`@-` is stdin); -f sends its value as it is.
    const value = !field.raw && field.value.startsWith("@") ? await file(field.value.slice(1)) : field.value;
    if (field.name === "query") query = value;
    else if (field.name !== "operationName") setVariable(variables, field.name, value);
  }
  if (query === undefined) throw new Failure(MERGE_STAGE, UNREADABLE);
  return { query, variables };
};

/**
 * Sets a gh field's variable, nesting `input[pullRequestId]` as gh does, in
 * objects with no prototype; `name[]` arrays are kept apart, so they never
 * name a pull request. A key that names a prototype is refused.
 */
const setVariable = (variables: Record<string, unknown>, name: string, value: string) => {
  const path = /^([^[\]]+)((?:\[[^[\]]+\])*)$/.exec(name);
  if (path === null) return;
  const keys = [path[1] as string, ...[...(path[2] as string).matchAll(/\[([^[\]]+)\]/g)].map((match) => match[1] as string)];
  if (keys.some((key) => ["__proto__", "constructor", "prototype"].includes(key))) throw new Failure(MERGE_STAGE, `cannot read the GraphQL field \`${name}\``);
  let into = variables;
  for (const key of keys.slice(0, -1)) {
    const next = Object.hasOwn(into, key) ? into[key] : undefined;
    into = (into[key] = typeof next === "object" && next !== null ? next : Object.create(null)) as Record<string, unknown>;
  }
  into[keys.at(-1) as string] = value;
};

/** The branch or tag (neither, for another ref) and repository a GraphQL ref node id names; refused when it names no ref. */
const refForNode = async (io: ReviewIo, id: string): Promise<{ readonly repo: Repo | undefined; readonly branch: string | undefined; readonly tag: string | undefined }> => {
  const query = "query($id:ID!){node(id:$id){... on Ref{name prefix repository{nameWithOwner}}}}";
  const node = record(record(record((await call(io, PUSH_STAGE, "POST", "/graphql", { query, variables: { id } })).value).data).node);
  const repo = parseRepo(text(record(node.repository).nameWithOwner));
  if (text(node.name) === "" || repo === undefined) throw new Failure(PUSH_STAGE, "a GraphQL ref write names a node that is not a ref agent-gh can find");
  return { repo, branch: node.prefix === "refs/heads/" ? text(node.name) : undefined, tag: node.prefix === "refs/tags/" ? text(node.name) : undefined };
};

/** The repository a GraphQL node id names; refused when it names none. */
const repoForNode = async (io: ReviewIo, id: string): Promise<Repo> => {
  const query = "query($id:ID!){node(id:$id){... on Repository{nameWithOwner}}}";
  const node = record(record(record((await call(io, RELEASE_STAGE, "POST", "/graphql", { query, variables: { id } })).value).data).node);
  const repo = parseRepo(text(node.nameWithOwner));
  if (repo === undefined) throw new Failure(RELEASE_STAGE, "a GraphQL createRef names a node that is not a repository agent-gh can find");
  return repo;
};

/** A string field of a REST write's body: from its fields, else its `--input` JSON; undefined when absent, refused when unreadable. */
const bodyField = async (api: ApiCall, name: string, readFile: (path: string) => Promise<string | undefined>, stage: Stage = PUSH_STAGE): Promise<string | undefined> => {
  if (api.input !== undefined) {
    const content = api.input === "-" ? undefined : await readFile(api.input);
    let value: unknown;
    try {
      if (content === undefined) throw new Error();
      value = own(record(JSON.parse(content)), name);
    } catch {
      throw new Failure(stage, `cannot read the body \`gh api --input\` sends; agents give a ${stage === PUSH_STAGE ? "branch" : "release or tag"} write's \`${name}\` with -f`);
    }
    if (value !== undefined && typeof value !== "string") throw new Failure(stage, `cannot read the \`${name}\` \`gh api\` sends`);
    return value;
  }
  const field = api.fields.findLast((candidate) => candidate.name === name);
  if (field !== undefined && !field.raw && field.value.startsWith("@")) throw new Failure(stage, `give \`${name}\` with -f ${name}=<value>`);
  return field?.value;
};

const own = (object: Record<string, unknown>, key: string): unknown => (Object.hasOwn(object, key) ? object[key] : undefined);

/** The pull request a GraphQL node id names, and its repository; refused when it names none. */
const pullForNode = async (io: ReviewIo, id: string): Promise<{ readonly repo: Repo; readonly number: number }> => {
  const query = "query($id:ID!){node(id:$id){... on PullRequest{number repository{nameWithOwner}}}}";
  const node = record(record(record((await call(io, MERGE_STAGE, "POST", "/graphql", { query, variables: { id } })).value).data).node);
  const repo = parseRepo(text(record(node.repository).nameWithOwner));
  if (!Number.isSafeInteger(node.number) || repo === undefined) throw new Failure(MERGE_STAGE, "a GraphQL merge mutation names a node that is not a pull request agent-gh can find");
  return { repo, number: node.number as number };
};

/** Runs a reviewer in its checkout, with the instructions on stdin and without the caller's harness. */
export const spawnReviewer = async (
  command: readonly string[],
  stdin: string,
  cwd: string,
  env: Env,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const child = Bun.spawn([...command], {
    cwd,
    env: reviewerEnv(env),
    stdin: stdin === "" ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
};

// The reviewer only reads: agent-gh has already run the checks. Codex runs in its read-only
// sandbox, set through config: `codex exec review` takes no `-s` (v0.162 refuses it), and
// `-c` works for both commands. Claude runs restricted to its own settings, with git's read
// commands the only shell commands it is allowed.
const CODEX_ACCESS = ["-c", 'sandbox_mode="read-only"'];
const CLAUDE_ACCESS = [
  "--restricted", "--tools", "Read,Grep,Glob,Bash",
  "--allowedTools", ["git diff", "git log", "git show"].map((command) => `Bash(${command}:*)`).join(","),
  "--permission-mode", "dontAsk", "--no-session-persistence",
];

/** The reviewer command for a full review, answering in REVIEW_SCHEMA. */
export const fullCommand = (reviewer: Reviewer, effort: Effort, files: { readonly schema: string; readonly out: string }): string[] =>
  reviewer.family === "codex"
    ? ["codex", "exec", "-m", reviewer.model, "-c", `model_reasoning_effort="${effort}"`, ...CODEX_ACCESS, "--ephemeral", "--output-schema", files.schema, "-o", files.out, "-"]
    : ["claude", "-p", "--model", reviewer.model, "--effort", effort, "--output-format", "json", "--json-schema", JSON.stringify(REVIEW_SCHEMA), ...CLAUDE_ACCESS];

/** The reviewer command for a sweep: plain text, no ticket. */
export const sweepCommand = (reviewer: Reviewer, effort: Effort, base: string, out: string): string[] =>
  reviewer.family === "codex"
    ? ["codex", "exec", "review", "--base", base, "-m", reviewer.model, "-c", `model_reasoning_effort="${effort}"`, ...CODEX_ACCESS, "--ephemeral", "-o", out]
    : ["claude", "-p", "--model", reviewer.model, "--effort", effort, ...CLAUDE_ACCESS];

/** The pull request's base as GitHub reports it: its branch, and the merge base of the reviewed head. */
export type PullBase = { readonly ref: string; readonly sha: string };

/** What a check is told of the base: the merge base, and the ref that names it in the clone. */
export const baseEnv = (base: PullBase): Record<string, string> => ({ AGENT_GH_BASE: base.sha, AGENT_GH_BASE_REF: `origin/${base.ref}` });

/**
 * Runs `use` in a throwaway clone of `sha`, removed afterwards whatever was
 * left in it. The clone borrows the caller's objects (`--shared`) but has its
 * own `.git`, so whatever runs there writes only inside it, never into the
 * caller's repository. Its `origin` is the repository on GitHub, not the
 * caller's clone, and, given the pull request's `base`, `origin/<base>` is
 * the merge base GitHub reports, whatever the caller's own base branch says.
 */
export const inClone = async <T>(io: ReviewIo, sha: string, use: (dir: string) => Promise<T>, base?: PullBase): Promise<T> => {
  const common = await io.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const dir = join(io.tempDir(), "checkout");
  try {
    if (
      common === undefined ||
      (await io.git(["clone", "-q", "--shared", "--no-checkout", common, dir])) === undefined ||
      (await io.git(["-C", dir, "checkout", "-q", "--detach", sha])) === undefined ||
      (await io.git(["-C", dir, "remote", "set-url", "origin", `https://github.com/${slug(io.repo)}.git`])) === undefined ||
      (base !== undefined && (await io.git(["-C", dir, "update-ref", `refs/remotes/origin/${base.ref}`, base.sha])) === undefined)
    ) {
      throw new Failure("reviewing", `could not clone ${sha.slice(0, 8)} for the review`);
    }
    return await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Runs the config's checks in order in `dir`, stopping at the first that fails or runs out of time; each is told the pull request's base (`baseEnv`). */
export const runChecks = async (io: ReviewIo, config: ReviewConfig, dir: string, base?: PullBase): Promise<ChecksResult> => {
  if (config.checks.length === 0) return { state: "not run" };
  let output = "";
  const tail = () => outputTail(output, config.checksOutputLines);
  for (const command of config.checks) {
    io.print(`agent-gh: running \`${command}\``);
    const result = await io.runCheck(command, dir, config.checksTimeoutMinutes * 60_000, base === undefined ? {} : baseEnv(base));
    output += `$ ${command}\n${result.output}${result.output.endsWith("\n") || result.output === "" ? "" : "\n"}`;
    if (result.timedOut) return { state: "timed out", command, minutes: config.checksTimeoutMinutes, tail: tail() };
    if (result.code !== 0) return { state: "failed", command, code: result.code, tail: tail() };
  }
  return { state: "passed", tail: tail() };
};

export type CheckRun = { readonly code: number; readonly output: string; readonly timedOut: boolean };

/**
 * Runs a check through the shell in `cwd`, its stderr merged into its
 * stdout, without the caller's harness. It runs in its own process group, so
 * a timeout, or agent-gh being interrupted, stops everything it started.
 */
export const spawnCheck = async (command: string, cwd: string, env: Env, timeoutMs: number, extra: Readonly<Record<string, string>> = {}): Promise<CheckRun> => {
  const child = Bun.spawn(["sh", "-c", `exec 2>&1\n${command}`], { cwd, env: { ...reviewerEnv(env), ...extra }, stdin: "ignore", stdout: "pipe", stderr: "inherit", detached: true });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group has already exited.
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  const interrupted = (signal: NodeJS.Signals) => {
    stop();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { code, output, timedOut };
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  }
};

/** Reads a reviewer's structured answer from its output file (codex) or stdout (claude). */
const answer = async (io: ReviewIo, reviewer: Reviewer, stdout: string, out: string): Promise<Review> => {
  try {
    if (reviewer.family === "codex") return parseReview(JSON.parse(await io.readFile(out)));
    const result = record(JSON.parse(stdout));
    return parseReview(typeof result.structured_output === "object" ? result.structured_output : JSON.parse(text(result.result)));
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure("reviewing", `the ${reviewer.family} reviewer's answer is not JSON`);
  }
};

/** The caller's environment without its harness's variables, so the reviewer CLI is not mistaken for a session of that harness. */
export const reviewerEnv = (env: Env): Record<string, string> => {
  const drop = new Set(HARNESSES.flatMap((harness) => harness.rules.flat().map((condition) => condition.name)));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !drop.has(name) && !name.startsWith("AGENT_GH_")) out[name] = value;
  }
  // mise's shim for the reviewer CLI prints its tools banner to stdout, which would corrupt the answer.
  out.MISE_QUIET = "1";
  return out;
};

const fetchBase = async (io: ReviewIo, base: string): Promise<string> => {
  // An explicit refspec: a single-branch clone's configured one would not update origin/<base>.
  if ((await io.git(["fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`])) === undefined) throw new Failure("reviewing", `could not fetch ${base} from origin`);
  const mergeBase = await io.git(["merge-base", "HEAD", `origin/${base}`]);
  if (mergeBase === undefined) throw new Failure("reviewing", `HEAD shares no history with origin/${base}`);
  return mergeBase;
};

/** The pull request's merge base, from its own repository: origin may be a fork with a different base. */
const mergeBaseOf = async (io: ReviewIo, base: string, head: string): Promise<string> => {
  const stage = "reviewing";
  const compare = record((await call(io, stage, "GET", `${repoPath(io)}/compare/${encodeURIComponent(base)}...${head}`)).value);
  const sha = text(record(compare.merge_base_commit).sha);
  // An ancestor of HEAD, so it is already here; a missing one means HEAD is not the pull request.
  if (sha === "" || (await io.git(["cat-file", "-e", `${sha}^{commit}`])) === undefined) throw new Failure(stage, `HEAD shares no history with ${slug(io.repo)}'s ${base}`);
  return sha;
};

const headSha = async (io: ReviewIo): Promise<string> => {
  const head = await io.git(["rev-parse", "HEAD"]);
  if (head === undefined) throw new Failure("reviewing", "not in a git repository");
  return head;
};

export type FullOptions = {
  readonly pr?: number;
  readonly issue?: number;
  readonly effort?: Effort;
  /** Review a claim pull request though commits on it are other sessions' (`--adopt`). */
  readonly adopt?: boolean;
  /** Run only this reviewer family (`--reviewer`): one `require` names for the author, or the one the config would pick. */
  readonly reviewer?: string;
};

/** One commit since the merge base and the session its `Agent-Session` trailer names, if it has one. */
export type CommitSession = { readonly sha: string; readonly session: string | undefined };

/**
 * Each commit since the merge base, merges included (a merge's conflict
 * resolution is that session's work too), with the session that made it, as
 * the commit-msg hook recorded it. A commit from before the hook wrote the
 * trailer, a person's, or one by a session with no id names none.
 */
export const commitSessions = async (io: Pick<ReviewIo, "git">, mergeBase: string, head: string): Promise<CommitSession[]> => {
  const log = await io.git(["log", "--format=%H%x1f%(trailers:key=Agent-Session,valueonly,separator=%x1f)%x1e", `${mergeBase}..${head}`]);
  // One entry per commit, each ended by \x1e: the sha, then any session values, separated by \x1f.
  return (log ?? "").split("\x1e").slice(0, -1).map((entry) => {
    const [sha, ...sessions] = entry.trim().split("\x1f").map((value) => value.trim());
    return { sha: sha ?? "", session: sessions.find((value) => value !== "") };
  });
};

/**
 * A claim pull request's commits are its holder's. One whose Agent-Session
 * trailer names another session (a session that committed onto this branch
 * instead of its own claim's) stops the review until the holder drops or
 * squashes it, or takes it on with `--adopt`, which only the holder's own
 * session may pass, and which the review's body then says. A pull request
 * without a claim marker (a person's) has no holder, and a commit with no
 * session trailer names nobody, so neither is held. Returns the commits
 * adopted, for the body.
 */
const adoptedCommits = async (io: ReviewIo, pull: Pull, mergeBase: string, head: string, adopt: boolean): Promise<readonly string[]> => {
  const holder = parseClaim(pull.body);
  if (holder === undefined) return [];
  const foreign = (await commitSessions(io, mergeBase, head)).filter((commit) => commit.session !== undefined && commit.session !== holder.session);
  if (foreign.length === 0) return [];
  const named = foreign.map((commit) => `${commit.sha.slice(0, 8)} (session ${commit.session})`);
  if (adopt) {
    if (holder.family !== io.family || holder.session !== io.session) {
      const who = io.session === undefined ? "this session, which has no id in its environment (set AGENT_GH_SESSION to the id its claim printed)" : `this ${io.family} session (${io.session})`;
      throw new Failure("reviewing", `--adopt is the claim holder's to pass (a ${holder.family} session, ${holder.session}), not ${who}; the holder adopts ${named.join(", ")}, or drops them`);
    }
    io.print(`agent-gh: --adopt takes on ${foreign.length} commit(s) not by this claim's holder (${holder.session}): ${named.join(", ")}`);
    return named;
  }
  const [first] = foreign as [CommitSession, ...CommitSession[]];
  const [which, them] =
    foreign.length === 1
      ? [`commit ${first.sha.slice(0, 8)} is from session ${first.session}, not this claim's holder (${holder.session})`, "it"]
      : [`commits ${named.join(", ")} are from other sessions than this claim's holder (${holder.session})`, "them"];
  throw new Failure("reviewing", `${which}; drop or squash ${them}, or take ${them} on as the holder's with \`agent-gh review full --adopt\``);
};

/** Bot logins of the family Apps, as commits credit them: `johnrees-claude[bot]`. */
const BOTS: Readonly<Record<string, string>> = Object.fromEntries(
  familyNames().flatMap((family) => (REGISTRY[family] === undefined ? [] : [[family, `${REGISTRY[family].slug}[bot]`]])),
);

/**
 * The family whose work this is: the App every commit since the merge base
 * credits as co-author, else (none, or a mix) the session's. Says which.
 */
export const authoredBy = async (io: ReviewIo, mergeBase: string, head: string): Promise<string> => {
  const log = await io.git(["log", "--no-merges", "--format=%(trailers:key=Co-authored-by,valueonly,separator=%x1f)%x1e", `${mergeBase}..${head}`]);
  // One entry per commit, each ended by \x1e, its co-authors separated by \x1f.
  const commits = (log ?? "").split("\x1e").slice(0, -1).map((entry) => entry.split("\x1f").map((value) => value.trim()).filter((value) => value !== ""));
  const family = authorFamily(commits, BOTS);
  if (family !== undefined) {
    io.print(`agent-gh: the head commits credit ${BOTS[family]}, so this is ${family}'s work`);
    return family;
  }
  io.print(`agent-gh: the head commits credit no single family App as co-author, so this is taken as this session's (${io.family}) work`);
  return io.family;
};

/**
 * The pull request's diff, as `git diff` prints it with fixed options so its
 * patch id does not depend on local config, and that patch id. git patch-id
 * ignores whitespace, so the trimmed output gives the same id.
 */
export const pullDiff = async (io: Pick<ReviewIo, "git">, mergeBase: string, head: string): Promise<{ readonly diff: string; readonly patchId: string | null }> => {
  const diff = await io.git(["diff", "--no-color", "--no-ext-diff", "-M", "--src-prefix=a/", "--dst-prefix=b/", mergeBase, head]);
  if (diff === undefined) throw new Failure("reviewing", `could not diff ${mergeBase.slice(0, 8)}..${head.slice(0, 8)}`);
  if (diff === "") return { diff, patchId: null };
  const id = (await io.git(["patch-id", "--stable"], `${diff}\n`))?.split(" ")[0];
  if (id === undefined || !/^[0-9a-f]{40}$/.test(id)) throw new Failure("reviewing", "git patch-id gave no id for the pull request's diff");
  return { diff, patchId: id };
};

/**
 * Posts the review as a COMMENT-type pull request review (agents act as John,
 * who cannot approve his own pull requests): findings on a line the diff
 * shows go on that line, the rest in the body. If GitHub still refuses a
 * line (422), every finding goes in the body instead.
 */
const postReview = async (io: ReviewIo, number: number, head: string, review: Review, diff: string, body: (outside: readonly Finding[]) => string) => {
  const lines = diffLines(diff);
  const onDiff = (finding: Finding) => lines.get(finding.file)?.has(finding.line) === true;
  const { findings } = review;
  const inline = findings.filter(onDiff);
  const path = `${repoPath(io)}/pulls/${number}/reviews`;
  const comments = inline.map((finding) => ({ path: finding.file, line: finding.line, side: "RIGHT", body: inlineComment(finding) }));
  const first = await call(io, "reviewing", "POST", path, { commit_id: head, event: "COMMENT", body: body(findings.filter((finding) => !onDiff(finding))), comments }, [422]);
  if (first.status !== 422) return;
  if (comments.length === 0) throw new Failure("reviewing", `HTTP 422 from POST ${path}`);
  io.print("agent-gh: GitHub refused a finding's line, so every finding is in the review's body");
  await call(io, "reviewing", "POST", path, { commit_id: head, event: "COMMENT", body: body(findings), comments: [] });
};

const STATUS_WAIT_MS = 60_000;
const STATUS_POLL_MS = 5_000;

const headStatus = async (io: ReviewIo, head: string): Promise<CommitStatus | undefined> =>
  agentReviewStatus(record((await call(io, "reviewing", "GET", `${repoPath(io)}/commits/${head}/status`)).value));

/**
 * Where the agent-review workflow sets the status (`status_writer:
 * "actions"`): waits up to a minute for a settled status newer than `before`
 * on the head, and prints what it reads. The review is posted either way, so
 * a slow workflow is reported, not a failure.
 */
const awaitWorkflowStatus = async (io: ReviewIo, head: string, before: CommitStatus | undefined): Promise<void> => {
  const short = head.slice(0, 8);
  let seen = before;
  for (let waited = 0; ; waited += STATUS_POLL_MS) {
    seen = await headStatus(io, head);
    if (seen !== undefined && seen.id !== before?.id && seen.state !== "pending") {
      io.print(`agent-gh: the agent-review workflow set ${STATUS_CONTEXT} on ${short}: ${seen.state} (${seen.description})`);
      return;
    }
    if (waited >= STATUS_WAIT_MS) break;
    await io.sleep(STATUS_POLL_MS);
  }
  io.print(
    seen === undefined
      ? `agent-gh: no ${STATUS_CONTEXT} status on ${short} after ${STATUS_WAIT_MS / 1000}s; check that the repository runs the agent-review workflow, and the pull request's checks`
      : `agent-gh: after ${STATUS_WAIT_MS / 1000}s, ${STATUS_CONTEXT} on ${short} still reads ${seen.state} (${seen.description}); the workflow may not have finished, so check the pull request's checks`,
  );
};

/**
 * `agent-gh review full`: the pull request's pushed head, reviewed by another
 * family than its author's against the issue it closes. agent-gh runs the
 * config's checks in a throwaway clone of the head, then the reviewer reads
 * it, read-only. Posts the findings as a pull request review and sets the
 * agent-review status on that head from the verdict and the checks; prints
 * the findings as JSON. A waiver a person added sets the status without a review, and one
 * added while the review ran is never overwritten. With `status_writer:
 * "actions"`, the repository's agent-review workflow sets the status from
 * the review's marker instead, and this waits for it and prints it.
 */
export const reviewFull = async (io: ReviewIo, options: FullOptions): Promise<void> => {
  const stage = "reviewing";
  const head = await headSha(io);
  const branch = options.pr === undefined ? await currentBranch(io) : undefined;
  const number = options.pr ?? (branch === undefined ? undefined : await pullForBranch(io, stage, branch)) ?? (await pullForCommit(io, stage, head));
  if (number === undefined) throw new Failure(stage, "no open pull request for this branch or with HEAD as its head; push it and open a draft, or pass --pr N");
  const target = await pull(io, stage, number);
  if (target.head !== head) {
    throw new Failure(stage, `HEAD is not pull request #${number}'s head (${target.head.slice(0, 8)}); push your commits or check out its head, then review`);
  }
  const config = await readReviewConfig(io, stage, target.base);
  if (config === undefined) throw new Failure(stage, `${slug(io.repo)} has no ${CONFIG_PATH} on ${target.base}, so it has not opted in to reviews`);
  const actions = config.statusWriter === "actions";
  /** Records a person's waiver on the head (the workflow does, where it writes the status), and returns who waived, if one did. */
  const recordWaiver = async (labels: Pull): Promise<string | undefined> => {
    const person = await waiver(io, stage, labels, config);
    if (person === undefined) return undefined;
    if (actions) {
      io.print(`agent-gh: the review of #${number} was waived by ${person}; the agent-review workflow records it`);
      return person;
    }
    await setStatus(io, head, "success", `waived by ${person}`);
    io.print(`agent-gh: the review of #${number} was waived by ${person}; ${STATUS_CONTEXT} set on ${head.slice(0, 8)}`);
    return person;
  };
  const person = await recordWaiver(target);
  if (person !== undefined) {
    io.out(`${JSON.stringify({ waived_by: person }, null, 2)}\n`);
    return;
  }
  const issue = options.issue === undefined ? await closingIssue(io, number) : { repo: io.repo, number: options.issue };
  if (issue === undefined) throw new Failure(stage, `pull request #${number} closes no issue; pass --issue N for the ticket it implements`);
  const tick = await ticket(io, issue);
  const effort = options.effort ?? effortFor(config, tick.labels);
  const mergeBase = await mergeBaseOf(io, target.base, head);
  const adopted = await adoptedCommits(io, target, mergeBase, head, options.adopt === true);
  const author = await authoredBy(io, mergeBase, head);
  const required = Object.hasOwn(config.require, author) ? config.require[author] : undefined;
  const reviewers = reviewersToRun(config, author, options.reviewer);
  if (required !== undefined) {
    const running = reviewers.length === required.length ? "" : `; this runs ${reviewers.map((reviewer) => reviewer.family).join(" and ")}`;
    io.print(`agent-gh: ${CONFIG_PATH} requires ${required.join(" and ")} to review ${author}'s work, each on this head${running}`);
  }
  const { diff, patchId } = await pullDiff(io, mergeBase, head);
  const dir = io.tempDir();
  const files = { schema: join(dir, "schema.json"), out: join(dir, "review.json") };
  await Bun.write(files.schema, JSON.stringify(REVIEW_SCHEMA));
  const base: PullBase = { ref: target.base, sha: mergeBase };
  const checks: ChecksResult = config.checks.length === 0 ? { state: "not run" } : await inClone(io, head, (cwd) => runChecks(io, config, cwd, base), base);
  const done: { readonly reviewer: Reviewer; readonly review: Review; readonly marker: ReviewMarker }[] = [];
  let before: CommitStatus | undefined;
  for (const [index, reviewer] of reviewers.entries()) {
    io.print(`agent-gh: ${checksSummary(checks)}; ${reviewer.model} (${reviewer.family}) at ${effort} is reviewing #${number} against ${tick.ref}`);
    // Where `require` names the author, each family's own earlier review is its baseline.
    const prior = await priorReview(io, target, head, required === undefined ? undefined : reviewer.family);
    // A fresh clone: the reviewer reads the commit as pushed, never what the checks built or changed.
    const prompt = fullPrompt({ repo: slug(io.repo), pull: target, ticket: tick, mergeBase, head, checklist: config.checklist, checks, blockOn: config.blockOn, prior });
    const result = await inClone(io, head, (cwd) => io.runReviewer(fullCommand(reviewer, effort, files), prompt, cwd), base);
    if (result.code !== 0) throw new Failure(stage, `the ${reviewer.family} reviewer exited with ${result.code}`);
    const answered = await answer(io, reviewer, result.stdout, files.out);
    // Each finding's id, in its posted marker and the printed JSON: what `agent-gh reply` answers. New for each review.
    const review = { ...answered, findings: withIds(`${head}\n${randomUUID()}`, answered.findings) };
    const marker: ReviewMarker = {
      v: 1, head, merge_base: mergeBase, patch_id: patchId, verdict: review.verdict, checks: checks.state, reviewer: reviewer.family, priorities: review.findings.map((finding) => finding.priority), author,
    };
    // The workflow's runs for an earlier family's review have long settled by the last one's, so only the last is waited for.
    if (actions && index === reviewers.length - 1) before = await headStatus(io, head);
    await postReview(io, number, head, review, diff, (outside) => reviewBody(review, { marker, reviewer, effort, issue: tick.ref, checks, postOutput: config.postChecksOutput, since: prior?.reachable ? prior.head : undefined, adopted }, outside));
    done.push({ reviewer, review, marker });
  }
  // A waiver John added while the review ran stands: the labels are read afresh, and the verdict never overwrites it.
  let waived: string | undefined;
  if (actions) {
    await awaitWorkflowStatus(io, head, before);
    waived = await waiver(io, stage, await pull(io, stage, number), config);
  } else if ((waived = await recordWaiver(await pull(io, stage, number))) === undefined) {
    const [only] = done as [(typeof done)[number]];
    if (required === undefined) {
      await setStatus(io, head, reviewState(only.marker, config), `${outcomeSummary(only.marker, config, checksSummary(checks))}: ${only.review.findings.length} finding(s) by ${only.reviewer.model} at ${effort}`);
    } else {
      // Every required family's latest review of this head counts: this run's, and those posted before it.
      const posted = validMarkers(await markerPosts(io, stage, number), await repoOwner(io, stage), agentApps());
      const reviews = required.map((family): FamilyReview => {
        const mine = done.find((entry) => entry.reviewer.family === family);
        return { family, current: mine === undefined ? markerFor(posted, head, family) : { marker: mine.marker, at: "", url: "" }, carried: undefined };
      });
      const status = requiredStatus(number, reviews, config);
      await setStatus(io, head, status.state === "success" ? "success" : "failure", status.description);
    }
  }
  if (waived === undefined && checksBlock(checks.state, config.checks.length > 0) !== undefined) {
    const next = checks.state === "timed out" ? "run `agent-gh review full` again once the machine is less loaded, or raise checks_timeout_minutes" : "fix them, push, and review the new head";
    io.print(`agent-gh: ${checksSummary(checks)}, so ${STATUS_CONTEXT} fails whatever the verdict; ${next}`);
  }
  if (done.some((entry) => entry.review.findings.length > 0)) io.print('agent-gh: answer each finding with `agent-gh reply <id> --applied <sha>` or `agent-gh reply <id> --declined "<why>"`');
  // One review prints as it always has; where `require` names the author, a list of them, each naming its reviewer.
  const printed = required === undefined ? (done[0] as (typeof done)[number]).review : done.map((entry) => ({ reviewer: entry.reviewer.family, ...entry.review }));
  io.out(`${JSON.stringify(printed, null, 2)}\n`);
};

const SWEEP_BASE = "agent-gh-sweep-base";

export type SweepOptions = { readonly base?: string; readonly effort?: Effort };

/**
 * `agent-gh review sweep`: a quick bug sweep of the diff since the base, with
 * no ticket context. Prints the reviewer's text and records nothing. The
 * effort comes from the ticket's labels when HEAD is in a pull request that
 * closes one.
 */
export const reviewSweep = async (io: ReviewIo, options: SweepOptions): Promise<void> => {
  const stage = "reviewing";
  const head = await headSha(io);
  const number = await pullForCommit(io, stage, head);
  const target = number === undefined ? undefined : await pull(io, stage, number);
  const baseRef = target?.base ?? text(record((await call(io, stage, "GET", repoPath(io))).value).default_branch);
  const config = await readReviewConfig(io, stage, baseRef);
  if (config === undefined) throw new Failure(stage, `${slug(io.repo)} has no ${CONFIG_PATH} on ${baseRef}, so it has not opted in to reviews`);
  let effort = options.effort;
  if (effort === undefined && target !== undefined) {
    const issue = await closingIssue(io, target.number);
    if (issue !== undefined) effort = effortFor(config, (await ticket(io, issue)).labels);
  }
  effort ??= config.effort.default;
  const base = options.base ?? `origin/${baseRef}`;
  if (options.base === undefined) await fetchBase(io, baseRef);
  const reviewer = reviewerFor(config, io.family);
  const out = join(io.tempDir(), "sweep.md");
  io.print(`agent-gh: ${reviewer.model} (${reviewer.family}) at ${effort} is sweeping the changes since ${base}`);
  // `codex exec review` takes no prompt beside --base; claude reads the instructions on stdin.
  // The clone has the caller's objects but not its refs: the base goes in as a commit, under a name of its own.
  const baseSha = await io.git(["rev-parse", "--verify", "-q", `${base}^{commit}`]);
  if (baseSha === undefined) throw new Failure(stage, `${base} is not a commit here`);
  const result = await inClone(io, head, async (cwd) => {
    if ((await io.git(["-C", cwd, "update-ref", `refs/heads/${SWEEP_BASE}`, baseSha])) === undefined) throw new Failure(stage, `could not give the clone ${base}`);
    return io.runReviewer(sweepCommand(reviewer, effort, SWEEP_BASE, out), reviewer.family === "codex" ? "" : sweepPrompt(SWEEP_BASE), cwd);
  });
  if (result.code !== 0) throw new Failure(stage, `the ${reviewer.family} reviewer exited with ${result.code}`);
  io.out(`${reviewer.family === "codex" ? await io.readFile(out) : result.stdout}`.trimEnd() + "\n");
};
