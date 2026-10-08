import { join } from "node:path";
import { Failure, type Stage } from "./failure.ts";
import { type Api, request } from "./github.ts";
import { HARNESSES, type Env } from "./harness.ts";
import { type Repo, slug } from "./repo.ts";
import {
  CONFIG_PATH,
  type Effort,
  effortFor,
  fullPrompt,
  parseReview,
  parseReviewConfig,
  type PullRequest,
  type ReadyTarget,
  REVIEW_SCHEMA,
  type Review,
  reviewComment,
  reviewed,
  type Reviewer,
  type ReviewConfig,
  reviewerFor,
  STATUS_CONTEXT,
  statusDescription,
  sweepPrompt,
  type Ticket,
  waivedBy,
} from "./review.ts";

/** Everything the review commands and the gate touch, so tests pass fakes. */
export type ReviewIo = {
  readonly api: Api;
  readonly token: string;
  readonly repo: Repo;
  /** The session's family: its work is reviewed by another family. */
  readonly family: string;
  /** Runs git in the working tree; its trimmed stdout, or undefined when it fails. */
  readonly git: (args: readonly string[]) => Promise<string | undefined>;
  /** Runs a reviewer CLI with `stdin` (none when empty) and returns its exit code and stdout. */
  readonly runReviewer: (command: readonly string[], stdin: string) => Promise<{ readonly code: number; readonly stdout: string }>;
  readonly readFile: (path: string) => Promise<string>;
  readonly tempDir: () => string;
  /** Progress and notes, to stderr. */
  readonly print: (line: string) => void;
  /** The command's result, to stdout. */
  readonly out: (text: string) => void;
};

const call = async (io: ReviewIo, stage: Stage, method: "GET" | "POST", path: string, body?: unknown, allow: readonly number[] = []) => {
  const { status, value } = await request(io.api, stage, method, path, io.token, body);
  if (status === 401) throw new Failure(stage, "GitHub refused the stored login (HTTP 401)");
  if ((status < 200 || status >= 300) && !allow.includes(status)) throw new Failure(stage, `HTTP ${status} from ${method} ${path.split("?")[0]}`);
  return { status, value };
};

const repoPath = (io: ReviewIo) => `/repos/${slug(io.repo)}`;
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const labelNames = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((label) => text(record(label).name)).filter((name) => name !== "") : [];

/** The review config on `ref`, or undefined when the repository has not opted in there. */
export const readReviewConfig = async (io: ReviewIo, stage: Stage, ref: string): Promise<ReviewConfig | undefined> => {
  const { status, value } = await call(io, stage, "GET", `${repoPath(io)}/contents/${CONFIG_PATH}?ref=${encodeURIComponent(ref)}`, undefined, [404]);
  if (status === 404) return undefined;
  const content = record(value).content;
  if (typeof content !== "string") throw new Failure("reading the review config", `${CONFIG_PATH} on ${ref} is not a file`);
  return parseReviewConfig(Buffer.from(content, "base64").toString("utf8"));
};

type Pull = PullRequest & { readonly head: string; readonly base: string; readonly labels: readonly string[]; readonly open: boolean };

const pull = async (io: ReviewIo, stage: Stage, number: number): Promise<Pull> => {
  const value = record((await call(io, stage, "GET", `${repoPath(io)}/pulls/${number}`)).value);
  const head = text(record(value.head).sha);
  const base = text(record(value.base).ref);
  if (head === "" || base === "") throw new Failure(stage, `pull request #${number}: invalid response`);
  return { number, title: text(value.title), body: text(value.body), head, base, labels: labelNames(value.labels), open: value.state === "open" };
};

const openPullNumber = (value: unknown): number | undefined => {
  if (!Array.isArray(value)) return undefined;
  const found = value.map(record).find((item) => item.state === "open" && Number.isSafeInteger(item.number));
  return found === undefined ? undefined : (found.number as number);
};

/** The open pull request whose head branch is `branch` in this repository. */
const pullForBranch = async (io: ReviewIo, stage: Stage, branch: string) =>
  openPullNumber((await call(io, stage, "GET", `${repoPath(io)}/pulls?state=open&head=${encodeURIComponent(`${io.repo.owner}:${branch}`)}`)).value);

/** The open pull request containing `sha`; finds it when the local branch is named differently. */
const pullForCommit = async (io: ReviewIo, stage: Stage, sha: string) =>
  openPullNumber((await call(io, stage, "GET", `${repoPath(io)}/commits/${sha}/pulls`, undefined, [404, 422])).value);

/** The first issue the pull request closes (GraphQL only: REST does not expose it). */
const closingIssue = async (io: ReviewIo, number: number): Promise<number | undefined> => {
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:1){nodes{number}}}}}`;
  const { value } = await call(io, "reviewing", "POST", "/graphql", { query, variables: { owner: io.repo.owner, name: io.repo.name, number } });
  const nodes = record(record(record(record(record(value).data).repository).pullRequest).closingIssuesReferences).nodes;
  const first = Array.isArray(nodes) ? record(nodes[0]).number : undefined;
  return Number.isSafeInteger(first) ? (first as number) : undefined;
};

const ticket = async (io: ReviewIo, number: number): Promise<Ticket> => {
  const issue = record((await call(io, "reviewing", "GET", `${repoPath(io)}/issues/${number}`)).value);
  const count = Number.isSafeInteger(issue.comments) ? (issue.comments as number) : 0;
  let lastComment: string | undefined;
  if (count > 0) {
    const page = Math.ceil(count / 100);
    const comments = (await call(io, "reviewing", "GET", `${repoPath(io)}/issues/${number}/comments?per_page=100&page=${page}`)).value;
    if (Array.isArray(comments) && comments.length > 0) lastComment = text(record(comments[comments.length - 1]).body);
  }
  return { number, title: text(issue.title), labels: labelNames(issue.labels), body: text(issue.body), lastComment };
};

/** The person who waived the review of this pull request, if one did and the label is still on it. */
const waiver = async (io: ReviewIo, stage: Stage, target: Pull, config: ReviewConfig): Promise<string | undefined> => {
  if (!target.labels.includes(config.waiverLabel)) return undefined;
  const events: unknown[] = [];
  for (let page = 1; page <= 10; page++) {
    const { value } = await call(io, stage, "GET", `${repoPath(io)}/issues/${target.number}/events?per_page=100&page=${page}`);
    if (!Array.isArray(value)) break;
    events.push(...value);
    if (value.length < 100) break;
  }
  return waivedBy(events, config.waiverLabel);
};

const setStatus = (io: ReviewIo, sha: string, description: string) =>
  call(io, "reviewing", "POST", `${repoPath(io)}/statuses/${sha}`, { state: "success", context: STATUS_CONTEXT, description: statusDescription(description) });

const currentBranch = async (io: ReviewIo): Promise<string | undefined> => {
  const upstream = await io.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream !== undefined && upstream.includes("/")) return upstream.slice(upstream.indexOf("/") + 1);
  const branch = await io.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === undefined || branch === "HEAD" ? undefined : branch;
};

/**
 * The gate on `gh pr ready`: in a repository whose base branch has the review
 * config, the pull request's head needs a successful agent-review status, or
 * a waiver label a person added. Passes silently where the repository has not
 * opted in, and when no pull request is found (gh then reports that itself).
 */
export const gateReady = async (io: ReviewIo, target: ReadyTarget): Promise<void> => {
  const stage = "checking the review";
  let number = "number" in target ? target.number : undefined;
  if (number === undefined) {
    const branch = "branch" in target && target.branch !== undefined ? target.branch : await currentBranch(io);
    if (branch !== undefined) number = await pullForBranch(io, stage, branch);
    if (number === undefined && !("branch" in target && target.branch !== undefined)) {
      const head = await io.git(["rev-parse", "HEAD"]);
      if (head !== undefined) number = await pullForCommit(io, stage, head);
    }
  }
  if (number === undefined) return;
  const pr = await pull(io, stage, number);
  const config = await readReviewConfig(io, stage, pr.base);
  if (config === undefined) return;
  const status = record((await call(io, stage, "GET", `${repoPath(io)}/commits/${pr.head}/status`)).value);
  if (reviewed(status)) return;
  const person = await waiver(io, stage, pr, config);
  if (person !== undefined) {
    io.print(`agent-gh: the review of #${number} was waived by ${person}`);
    return;
  }
  throw new Failure(
    stage,
    `pull request #${number}'s head ${pr.head.slice(0, 8)} has no ${STATUS_CONTEXT} status; run \`agent-gh review full\` on it (it reviews the pushed head), or ask John to add the \`${config.waiverLabel}\` label`,
  );
};

/** The reviewer command for a full review: read-only, answering in REVIEW_SCHEMA. */
export const fullCommand = (reviewer: Reviewer, effort: Effort, files: { readonly schema: string; readonly out: string }): string[] =>
  reviewer.family === "codex"
    ? ["codex", "exec", "-m", reviewer.model, "-c", `model_reasoning_effort="${effort}"`, "-s", "read-only", "--ephemeral", "--output-schema", files.schema, "-o", files.out, "-"]
    : [
        "claude", "-p", "--model", reviewer.model, "--effort", effort, "--output-format", "json",
        "--json-schema", JSON.stringify(REVIEW_SCHEMA), "--tools", "Read,Grep,Glob,Bash",
        "--allowedTools", "Bash(git diff:*),Bash(git log:*),Bash(git show:*)",
        "--permission-mode", "dontAsk", "--no-session-persistence",
      ];

/** The reviewer command for a sweep: plain text, no ticket. */
export const sweepCommand = (reviewer: Reviewer, effort: Effort, base: string, out: string): string[] =>
  reviewer.family === "codex"
    ? ["codex", "exec", "review", "--base", base, "-m", reviewer.model, "-c", `model_reasoning_effort="${effort}"`, "--ephemeral", "-o", out]
    : [
        "claude", "-p", "--model", reviewer.model, "--effort", effort, "--tools", "Read,Grep,Glob,Bash",
        "--allowedTools", "Bash(git diff:*),Bash(git log:*),Bash(git show:*)",
        "--permission-mode", "dontAsk", "--no-session-persistence",
      ];

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
  if ((await io.git(["fetch", "-q", "origin", base])) === undefined) throw new Failure("reviewing", `could not fetch ${base} from origin`);
  const mergeBase = await io.git(["merge-base", "HEAD", `origin/${base}`]);
  if (mergeBase === undefined) throw new Failure("reviewing", `HEAD shares no history with origin/${base}`);
  return mergeBase;
};

const headSha = async (io: ReviewIo): Promise<string> => {
  const head = await io.git(["rev-parse", "HEAD"]);
  if (head === undefined) throw new Failure("reviewing", "not in a git repository");
  return head;
};

export type FullOptions = { readonly pr?: number; readonly issue?: number; readonly effort?: Effort };

/**
 * `agent-gh review full`: the pull request's pushed head, reviewed by another
 * family against the issue it closes. Posts the findings and sets the
 * agent-review status on that head; prints the findings as JSON. A waiver a
 * person added sets the status without a review.
 */
export const reviewFull = async (io: ReviewIo, options: FullOptions): Promise<void> => {
  const stage = "reviewing";
  const head = await headSha(io);
  const number = options.pr ?? (await pullForCommit(io, stage, head));
  if (number === undefined) throw new Failure(stage, "no open pull request contains HEAD; push it and open a draft, or pass --pr N");
  const target = await pull(io, stage, number);
  if (target.head !== head) {
    throw new Failure(stage, `HEAD is not pull request #${number}'s head (${target.head.slice(0, 8)}); push your commits or check out its head, then review`);
  }
  const config = await readReviewConfig(io, stage, target.base);
  if (config === undefined) throw new Failure(stage, `${slug(io.repo)} has no ${CONFIG_PATH} on ${target.base}, so it has not opted in to reviews`);
  const person = await waiver(io, stage, target, config);
  if (person !== undefined) {
    await setStatus(io, head, `waived by ${person}`);
    io.print(`agent-gh: the review of #${number} was waived by ${person}; ${STATUS_CONTEXT} set on ${head.slice(0, 8)}`);
    io.out(`${JSON.stringify({ waived_by: person }, null, 2)}\n`);
    return;
  }
  const issue = options.issue ?? (await closingIssue(io, number));
  if (issue === undefined) throw new Failure(stage, `pull request #${number} closes no issue; pass --issue N for the ticket it implements`);
  const tick = await ticket(io, issue);
  const effort = options.effort ?? effortFor(config, tick.labels);
  const reviewer = reviewerFor(config, io.family);
  const mergeBase = await fetchBase(io, target.base);
  const dir = io.tempDir();
  const files = { schema: join(dir, "schema.json"), out: join(dir, "review.json") };
  await Bun.write(files.schema, JSON.stringify(REVIEW_SCHEMA));
  io.print(`agent-gh: ${reviewer.model} (${reviewer.family}) at ${effort} is reviewing #${number} against #${issue}`);
  const prompt = fullPrompt({ repo: slug(io.repo), pull: target, ticket: tick, mergeBase, checklist: config.checklist });
  const result = await io.runReviewer(fullCommand(reviewer, effort, files), prompt);
  if (result.code !== 0) throw new Failure(stage, `the ${reviewer.family} reviewer exited with ${result.code}`);
  const review = await answer(io, reviewer, result.stdout, files.out);
  await call(io, stage, "POST", `${repoPath(io)}/issues/${number}/comments`, { body: reviewComment(review, { reviewer, effort, head, issue }) });
  const verdict = review.verdict === "approve" ? "approved" : "changes requested";
  await setStatus(io, head, `${verdict}: ${review.findings.length} finding(s) by ${reviewer.model} at ${effort}`);
  io.out(`${JSON.stringify(review, null, 2)}\n`);
};

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
  const result = await io.runReviewer(sweepCommand(reviewer, effort, base, out), reviewer.family === "codex" ? "" : sweepPrompt(base));
  if (result.code !== 0) throw new Failure(stage, `the ${reviewer.family} reviewer exited with ${result.code}`);
  io.out(`${reviewer.family === "codex" ? await io.readFile(out) : result.stdout}`.trimEnd() + "\n");
};
