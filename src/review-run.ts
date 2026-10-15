import { rmSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY } from "./config.ts";
import { Failure, type Stage } from "./failure.ts";
import { familyNames } from "./family.ts";
import { type Api, request } from "./github.ts";
import { HARNESSES, type Env } from "./harness.ts";
import { parseRemoteUrl, parseRepo, type Repo, slug } from "./repo.ts";
import { checkState, pushedBranches, requiredChecks } from "./merge.ts";
import {
  agentReviewStatus,
  type ApiCall,
  apiCall,
  apiMerge,
  authorFamily,
  type ChecksResult,
  checksSummary,
  CONFIG_PATH,
  diffLines,
  type Effort,
  effortFor,
  type Finding,
  fullPrompt,
  graphqlMerges,
  graphqlRefWrites,
  inlineComment,
  mergeCommand,
  outputTail,
  prRepoFlag,
  parseReview,
  parseReviewConfig,
  type PullRequest,
  type ReadyTarget,
  readyTarget,
  REVIEW_SCHEMA,
  type Review,
  reviewBody,
  type ReviewMarker,
  type Reviewer,
  type ReviewConfig,
  reviewerFor,
  reviewState,
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
  /** Runs git in the working tree, with `input` on stdin; its trimmed stdout, or undefined when it fails. */
  readonly git: (args: readonly string[], input?: string) => Promise<string | undefined>;
  /** Runs one of the config's checks, a shell command, in `cwd`, stopping it after `timeoutMs`; its exit code and its stdout and stderr together. */
  readonly runCheck: (command: string, cwd: string, timeoutMs: number) => Promise<CheckRun>;
  /** Runs a reviewer CLI in `cwd` with `stdin` (none when empty) and returns its exit code and stdout. */
  readonly runReviewer: (command: readonly string[], stdin: string, cwd: string) => Promise<{ readonly code: number; readonly stdout: string }>;
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

/** The person who waived the review of this pull request, if one did and the label is still on it. */
const waiver = async (io: ReviewIo, stage: Stage, target: Pull, config: ReviewConfig): Promise<string | undefined> => {
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
 * a waiver label a person added. Passes silently where the repository has not
 * opted in, and when no pull request is found (gh then reports that itself).
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
  const status = agentReviewStatus(record((await call(io, stage, "GET", `${repoPath(io)}/commits/${pr.head}/status`)).value));
  if (status?.state === "success") return;
  const person = await waiver(io, stage, pr, config);
  if (person !== undefined) {
    io.print(`agent-gh: the review of #${number} was waived by ${person}`);
    return;
  }
  const waive = `or ask John to add the \`${config.waiverLabel}\` label`;
  if (status?.state === "failure") {
    throw new Failure(
      stage,
      `pull request #${number}'s head ${pr.head.slice(0, 8)} was reviewed and blocked (${status.description}); answer each finding on the pull request, push a fix, and run \`agent-gh review full\` on the new head, ${waive}`,
    );
  }
  throw new Failure(
    stage,
    `pull request #${number}'s head ${pr.head.slice(0, 8)} has no ${STATUS_CONTEXT} status; run \`agent-gh review full\` on it (it reviews the pushed head), ${waive}`,
  );
};

/** The pull request a gh selector names, as gh resolves it: by number, by branch, else the current branch's or HEAD's. */
const pullNumber = async (io: ReviewIo, stage: Stage, target: ReadyTarget): Promise<number | undefined> => {
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

/**
 * The guard on `gh pr merge` in an agent session: agents act as John, who may
 * bypass the base branch's rules, so every check the branch requires (its
 * rulesets' and classic protection's) must have passed on the pull request's
 * head. `--admin` is always refused, and so is a pull request the guard
 * cannot find. A branch that requires no checks is not held. Returns the
 * head it checked, which the merge must then require, so a commit pushed
 * meanwhile is not merged in its place.
 */
export const gateMerge = async (io: ReviewIo, target: ReadyTarget, admin: boolean): Promise<string> => {
  const stage = MERGE_STAGE;
  if (admin) throw new Failure(stage, "an agent never merges with `--admin`, which skips the base branch's requirements; merge without it once the required checks pass, or ask John");
  const number = await pullNumber(io, stage, target);
  if (number === undefined) throw new Failure(stage, "cannot find the pull request `gh pr merge` names; name it by number");
  const pr = await pull(io, stage, number);
  const base = branchPath(pr.base);
  const rules = await pages(io, stage, `${repoPath(io)}/rules/branches/${base}`);
  const branch = (await call(io, stage, "GET", `${repoPath(io)}/branches/${base}`)).value;
  const required = requiredChecks(rules, branch);
  if (required.length === 0) return pr.head;
  const statuses = await counted(io, stage, `${repoPath(io)}/commits/${pr.head}/status?`, "statuses");
  const unmet: string[] = [];
  for (const check of required) {
    const runs = await counted(io, stage, `${repoPath(io)}/commits/${pr.head}/check-runs?check_name=${encodeURIComponent(check.context)}&filter=latest&`, "check_runs");
    const state = checkState(check, statuses, runs);
    if (state !== "passed") unmet.push(`\`${check.context}\` ${state}`);
  }
  if (unmet.length === 0) return pr.head;
  throw new Failure(
    stage,
    `pull request #${number}'s head ${pr.head.slice(0, 8)} has not passed every check ${pr.base} requires (${unmet.join(", ")}); wait for them to pass, fix what fails, or ask John to merge it`,
  );
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
 * remote on a local path is not GitHub, and is not held.
 */
export const guardPush = async (
  url: string | undefined,
  stdin: string,
  deps: Pick<GhDispatch, "withToken" | "io">,
): Promise<void> => {
  const branches = pushedBranches(stdin);
  if (branches === undefined) throw new Failure(PUSH_STAGE, "git's pre-push lines are not in the form agent-gh reads");
  if (branches.length === 0) return;
  if (url === undefined) throw new Failure(PUSH_STAGE, "the pre-push hook passed no remote URL; run `agent-gh guard pre-push \"$@\"` from it");
  const repo = parseRemoteUrl(url);
  if (repo === undefined) {
    if (url.startsWith("/") || url.startsWith(".") || url.startsWith("file://")) return;
    throw new Failure(PUSH_STAGE, "cannot tell which GitHub repository this push goes to; use a https://github.com/ or git@github.com: remote");
  }
  await deps.withToken(repo, async (env) => {
    await gatePush(deps.io(repo, env), branches);
    return 0;
  });
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
 * reviewed and `gh pr merge` until its required checks pass. The gh shim
 * sends only agent sessions' gh here; a person's gh never reaches it.
 */
export const dispatchGh = async (args: readonly string[], repo: Repo | undefined, deps: GhDispatch): Promise<number> => {
  const ready = readyTarget(args);
  const merge = ready === undefined ? mergeCommand(args) : undefined;
  const target = ready ?? merge?.target;
  if (target === undefined) {
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
    const head = await gateMerge(io, merge.target, merge.admin);
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
 * `gh api` behind the merge guard: a REST or GraphQL call that merges a pull
 * request runs only when `gh pr merge` would; one that merges outside a pull
 * request, or that the guard cannot read, is refused.
 */
const dispatchApi = async (args: readonly string[], api: ApiCall, repo: Repo | undefined, deps: GhDispatch): Promise<number> => {
  const plan = apiMerge(api);
  if (plan.kind === "none") return deps.run(args);
  if (plan.kind === "refuse") throw new Failure(MERGE_STAGE, plan.reason);
  if (plan.kind === "ref" || plan.kind === "ref-field") {
    const target = plan.repo === undefined ? repo : parseRepo(plan.repo);
    if (target === undefined) throw new Failure(PUSH_STAGE, "cannot tell which repository `gh api` writes to; name it in the endpoint");
    const named = plan.kind === "ref" ? plan.branch : await bodyField(api, plan.field, deps.readFile);
    // A new ref that is not a branch carries no required checks.
    if (plan.kind === "ref-field" && plan.field === "ref" && !named?.startsWith("refs/heads/")) {
      if (named === undefined) throw new Failure(PUSH_STAGE, "cannot read the ref `gh api` creates");
      return deps.run(args);
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
  const writes = graphqlRefWrites(request.query, request.variables);
  if ("refuse" in writes) throw new Failure(PUSH_STAGE, writes.refuse);
  if (merges.length === 0 && writes.length === 0) return deps.run(args);
  return deps.withToken(repo, async (env) => {
    for (const write of writes) {
      // The node lookup is GraphQL, which names no repository; the io's own is unused.
      const target = "node" in write ? await refForNode(deps.io(repo ?? { owner: "-", name: "-" }, env), write.node) : { repo: parseRepo(write.repo), branch: write.branch };
      if (target.repo === undefined) throw new Failure(PUSH_STAGE, "cannot tell which repository a GraphQL ref write moves a branch in");
      if (target.branch !== undefined) await gatePush(deps.io(target.repo, env), [target.branch]);
    }
    for (const merge of merges) {
      // The node lookup is GraphQL, which names no repository; the io's own is unused.
      const pr = await pullForNode(deps.io(repo ?? { owner: "-", name: "-" }, env), merge.id);
      const head = await gateMerge(deps.io(pr.repo, env), { number: pr.number }, false);
      if (merge.expectedHeadOid !== head) {
        throw new Failure(MERGE_STAGE, `a GraphQL merge of #${pr.number} must give expectedHeadOid: "${head}", the head whose checks passed, so a later push is not merged in its place`);
      }
    }
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

/** The branch (undefined for a tag or other ref) and repository a GraphQL ref node id names; refused when it names no ref. */
const refForNode = async (io: ReviewIo, id: string): Promise<{ readonly repo: Repo | undefined; readonly branch: string | undefined }> => {
  const query = "query($id:ID!){node(id:$id){... on Ref{name prefix repository{nameWithOwner}}}}";
  const node = record(record(record((await call(io, PUSH_STAGE, "POST", "/graphql", { query, variables: { id } })).value).data).node);
  const repo = parseRepo(text(record(node.repository).nameWithOwner));
  if (text(node.name) === "" || repo === undefined) throw new Failure(PUSH_STAGE, "a GraphQL ref write names a node that is not a ref agent-gh can find");
  return { repo, branch: node.prefix === "refs/heads/" ? text(node.name) : undefined };
};

/** A string field of a REST write's body: from its fields, else its `--input` JSON; undefined when absent, refused when unreadable. */
const bodyField = async (api: ApiCall, name: string, readFile: (path: string) => Promise<string | undefined>): Promise<string | undefined> => {
  if (api.input !== undefined) {
    const content = api.input === "-" ? undefined : await readFile(api.input);
    let value: unknown;
    try {
      if (content === undefined) throw new Error();
      value = own(record(JSON.parse(content)), name);
    } catch {
      throw new Failure(PUSH_STAGE, `cannot read the body \`gh api --input\` sends; agents give a branch write's \`${name}\` with -f`);
    }
    if (value !== undefined && typeof value !== "string") throw new Failure(PUSH_STAGE, `cannot read the \`${name}\` \`gh api\` sends`);
    return value;
  }
  const field = api.fields.findLast((candidate) => candidate.name === name);
  if (field !== undefined && !field.raw && field.value.startsWith("@")) throw new Failure(PUSH_STAGE, `give \`${name}\` with -f ${name}=<value>`);
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
// sandbox; Claude runs restricted to its own settings, with git's read commands the only
// shell commands it is allowed.
const CODEX_ACCESS = ["-s", "read-only"];
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

/**
 * Runs `use` in a throwaway clone of `sha`, removed afterwards whatever was
 * left in it. The clone borrows the caller's objects (`--shared`) but has its
 * own `.git`, so whatever runs there writes only inside it, never into the
 * caller's repository.
 */
export const inClone = async <T>(io: ReviewIo, sha: string, use: (dir: string) => Promise<T>): Promise<T> => {
  const common = await io.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const dir = join(io.tempDir(), "checkout");
  try {
    if (
      common === undefined ||
      (await io.git(["clone", "-q", "--shared", "--no-checkout", common, dir])) === undefined ||
      (await io.git(["-C", dir, "checkout", "-q", "--detach", sha])) === undefined
    ) {
      throw new Failure("reviewing", `could not clone ${sha.slice(0, 8)} for the review`);
    }
    return await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Runs the config's checks in order in `dir`, stopping at the first that fails or runs out of time. */
export const runChecks = async (io: ReviewIo, config: ReviewConfig, dir: string): Promise<ChecksResult> => {
  if (config.checks.length === 0) return { state: "not run" };
  let output = "";
  const tail = () => outputTail(output, config.checksOutputLines);
  for (const command of config.checks) {
    io.print(`agent-gh: running \`${command}\``);
    const result = await io.runCheck(command, dir, config.checksTimeoutMinutes * 60_000);
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
export const spawnCheck = async (command: string, cwd: string, env: Env, timeoutMs: number): Promise<CheckRun> => {
  const child = Bun.spawn(["sh", "-c", `exec 2>&1\n${command}`], { cwd, env: reviewerEnv(env), stdin: "ignore", stdout: "pipe", stderr: "inherit", detached: true });
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

export type FullOptions = { readonly pr?: number; readonly issue?: number; readonly effort?: Effort };

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
export const pullDiff = async (io: ReviewIo, mergeBase: string, head: string): Promise<{ readonly diff: string; readonly patchId: string | null }> => {
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
  const inline = review.findings.filter(onDiff);
  const path = `${repoPath(io)}/pulls/${number}/reviews`;
  const comments = inline.map((finding) => ({ path: finding.file, line: finding.line, side: "RIGHT", body: inlineComment(finding) }));
  const first = await call(io, "reviewing", "POST", path, { commit_id: head, event: "COMMENT", body: body(review.findings.filter((finding) => !onDiff(finding))), comments }, [422]);
  if (first.status !== 422) return;
  if (comments.length === 0) throw new Failure("reviewing", `HTTP 422 from POST ${path}`);
  io.print("agent-gh: GitHub refused a finding's line, so every finding is in the review's body");
  await call(io, "reviewing", "POST", path, { commit_id: head, event: "COMMENT", body: body(review.findings), comments: [] });
};

/**
 * `agent-gh review full`: the pull request's pushed head, reviewed by another
 * family than its author's against the issue it closes. agent-gh runs the
 * config's checks in a throwaway clone of the head, then the reviewer reads
 * it, read-only. Posts the findings as a pull request review and sets the
 * agent-review status on that head from the verdict; prints the findings as
 * JSON. A waiver a person added sets the status without a review, and one
 * added while the review ran is never overwritten.
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
  /** Records a person's waiver on the head, and returns who waived, if one did. */
  const recordWaiver = async (labels: Pull): Promise<string | undefined> => {
    const person = await waiver(io, stage, labels, config);
    if (person === undefined) return undefined;
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
  const reviewer = reviewerFor(config, await authoredBy(io, mergeBase, head));
  const { diff, patchId } = await pullDiff(io, mergeBase, head);
  const dir = io.tempDir();
  const files = { schema: join(dir, "schema.json"), out: join(dir, "review.json") };
  await Bun.write(files.schema, JSON.stringify(REVIEW_SCHEMA));
  const checks: ChecksResult = config.checks.length === 0 ? { state: "not run" } : await inClone(io, head, (cwd) => runChecks(io, config, cwd));
  io.print(`agent-gh: ${checksSummary(checks)}; ${reviewer.model} (${reviewer.family}) at ${effort} is reviewing #${number} against ${tick.ref}`);
  // A fresh clone: the reviewer reads the commit as pushed, never what the checks built or changed.
  const prompt = fullPrompt({ repo: slug(io.repo), pull: target, ticket: tick, mergeBase, head, checklist: config.checklist, checks });
  const result = await inClone(io, head, (cwd) => io.runReviewer(fullCommand(reviewer, effort, files), prompt, cwd));
  if (result.code !== 0) throw new Failure(stage, `the ${reviewer.family} reviewer exited with ${result.code}`);
  const review = await answer(io, reviewer, result.stdout, files.out);
  const marker: ReviewMarker = { v: 1, head, merge_base: mergeBase, patch_id: patchId, verdict: review.verdict, checks: checks.state, reviewer: reviewer.family };
  await postReview(io, number, head, review, diff, (outside) => reviewBody(review, { marker, reviewer, effort, issue: tick.ref, checks, postOutput: config.postChecksOutput }, outside));
  // A waiver John added while the review ran stands: the labels are read afresh, and the verdict never overwrites it.
  if ((await recordWaiver(await pull(io, stage, number))) === undefined) {
    const verdict = review.verdict === "approve" ? "approved" : "changes requested";
    await setStatus(io, head, reviewState(review.verdict, config.blockOn), `${verdict}; ${checksSummary(checks)}: ${review.findings.length} finding(s) by ${reviewer.model} at ${effort}`);
  }
  io.out(`${JSON.stringify(review, null, 2)}\n`);
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
