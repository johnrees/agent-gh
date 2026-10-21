/**
 * `agent-gh graph --json`: reads the repository for graph.ts in a few
 * GraphQL round trips (the open issues with their `blockedBy`, milestone,
 * labels, last comments, and closing pull requests; the open pull requests
 * with their head's statuses and check runs; the milestones and their closed
 * issues), where `next --waves` and `claims` make one REST call per issue and
 * per edge. The config, the Queue, and the base branch's required checks are
 * read over REST, as `next` and the merge guard read them. Nothing is written.
 */
import { Failure, type Stage } from "./failure.ts";
import { type GraphIssue, graphJson, type GraphJson, type GraphPull, type Milestone, type PullRef } from "./graph.ts";
import { request } from "./github.ts";
import { type RequiredCheck, requiredChecks } from "./merge.ts";
import { type Blocker, parseQueue } from "./next.ts";
import { queueConfig, type Read } from "./next-run.ts";
import { parseRepo, slug } from "./repo.ts";
import { CONFIG_PATH } from "./review.ts";
import { type ApiIo, everyPage } from "./threads-run.ts";

const STAGE: Stage = "reading the graph";
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const integer = (value: unknown): number => (Number.isSafeInteger(value) ? (value as number) : 0);
const nodes = (value: unknown): Record<string, unknown>[] => {
  const list = record(value).nodes;
  return Array.isArray(list) ? list.map(record) : [];
};
const lower = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value.toLowerCase() : null);

/**
 * A GraphQL request. Some proxies (Claude cloud's) reject GraphQL, so a
 * refusal says that is what failed; GitHub's error messages are response
 * text, so only their type codes are shown.
 */
const graphql = async (io: ApiIo, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const { status, value } = await request(io.api, STAGE, "POST", "/graphql", io.token, { query, variables });
  if (status === 401) throw new Failure(STAGE, "GitHub refused the token (HTTP 401)");
  if (status < 200 || status >= 300) throw new Failure(STAGE, `HTTP ${status} from POST /graphql; graph reads through GitHub's GraphQL API, which some proxies (Claude cloud's) reject, so run it from a local session`);
  const errors = record(value).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const types = [...new Set(errors.map((error) => text(record(error).type)).filter((type) => /^[A-Z_]{1,40}$/.test(type)))];
    throw new Failure(STAGE, `GitHub's GraphQL API refused the request${types.length === 0 ? "" : ` (${types.join(", ")})`}`);
  }
  const repository = record(record(value).data).repository;
  if (typeof repository !== "object" || repository === null) throw new Failure(STAGE, `${slug(io.repo)} cannot be read with this token`);
  return repository as Record<string, unknown>;
};

const MAX_PAGES = 30;

/** Every node of one connection on the repository, 100 a page: `field(args)` with `fields` on each node. */
const everyNode = async (io: ApiIo, field: string, args: string, fields: string): Promise<Record<string, unknown>[]> => {
  const query = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){list:${field}(first:100,after:$after${args}){pageInfo{hasNextPage endCursor} nodes{${fields}}}}}`;
  const found: Record<string, unknown>[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const list = record((await graphql(io, query, { owner: io.repo.owner, name: io.repo.name, after })).list);
    if (!Array.isArray(list.nodes)) throw new Failure(STAGE, `${field}: invalid response`);
    found.push(...nodes(list));
    const info = record(list.pageInfo);
    if (info.hasNextPage !== true) return found;
    after = text(info.endCursor);
  }
  throw new Failure(STAGE, `${slug(io.repo)} lists over ${MAX_PAGES * 100} ${field}`);
};

/** The comments read with each open issue; an issue with more is read whole over REST. */
const LAST_COMMENTS = 30;

const PULL_REF = "number url state isDraft mergedAt repository{nameWithOwner}";
const issueFields = (comments: boolean) =>
  [
    "number title url state updatedAt milestone{number title}",
    "labels(first:100){totalCount nodes{name}}",
    "blockedBy(first:100){totalCount nodes{number title state repository{nameWithOwner}}}",
    `closedByPullRequestsReferences(first:25,includeClosedPrs:true){totalCount nodes{${PULL_REF}}}`,
    comments ? `comments(last:${LAST_COMMENTS}){totalCount nodes{databaseId url authorAssociation author{login} body createdAt}}` : "",
  ].join(" ");

const ROLLUP =
  "statusCheckRollup{contexts(first:100){totalCount nodes{__typename ...on StatusContext{context state creator{__typename login}} ...on CheckRun{name status conclusion checkSuite{databaseId app{databaseId} workflowRun{workflow{databaseId}}}}}}}";
const PULL_FIELDS = `${PULL_REF} title body createdAt reviewDecision baseRefName headRefName headRefOid changedFiles author{login} comments(last:1){nodes{createdAt}} commits(last:1){totalCount nodes{commit{committedDate ${ROLLUP}}}}`;

/** A list read whole, or a refusal: a label, blocker, or closing pull request left out would misjudge the issue. */
const whole = (issue: number, what: string, connection: unknown): Record<string, unknown>[] => {
  const found = nodes(connection);
  if (integer(record(connection).totalCount) > found.length) throw new Failure(STAGE, `#${issue} has over ${found.length} ${what}, too many to read`);
  return found;
};

const pullRef = (node: Record<string, unknown>, repo: string): PullRef => {
  const state = lower(node.state);
  return {
    number: integer(node.number), url: text(node.url), here: text(record(node.repository).nameWithOwner).toLowerCase() === repo.toLowerCase(),
    state: state === "merged" || state === "closed" ? state : "open", draft: node.isDraft === true, mergedAt: text(node.mergedAt) || null,
  };
};

/** An issue node, its comments as REST lists them; an open one with more than were read has them read whole over REST. */
const issueOf = async (io: ApiIo, node: Record<string, unknown>): Promise<GraphIssue> => {
  const number = integer(node.number);
  const name = slug(io.repo).toLowerCase();
  const open = lower(node.state) === "open";
  const blockedBy = whole(number, "blockers", node.blockedBy).map((blocker): Blocker => {
    const from = parseRepo(text(record(blocker.repository).nameWithOwner));
    const here = from === undefined || slug(from).toLowerCase() === name;
    return { repo: here ? undefined : slug(from), number: integer(blocker.number), open: lower(blocker.state) === "open", title: text(blocker.title) };
  });
  let comments: Record<string, unknown>[] = [];
  if (open && node.comments !== undefined) {
    const read = nodes(node.comments);
    comments =
      integer(record(node.comments).totalCount) > read.length
        ? (await everyPage(io, STAGE, `/repos/${slug(io.repo)}/issues/${number}/comments`)).map(record)
        : read.map((comment) => ({
            id: integer(comment.databaseId), html_url: text(comment.url), author_association: text(comment.authorAssociation),
            user: { login: text(record(comment.author).login) }, body: text(comment.body), created_at: text(comment.createdAt),
          }));
  }
  const milestone = record(node.milestone);
  return {
    number, title: text(node.title), url: text(node.url), open,
    milestone: node.milestone === null || node.milestone === undefined ? null : { number: integer(milestone.number), title: text(milestone.title) },
    labels: whole(number, "labels", node.labels).map((label) => text(label.name)),
    blockedBy, comments,
    closedBy: whole(number, "closing pull requests", node.closedByPullRequestsReferences).map((pull) => pullRef(pull, slug(io.repo))),
    updatedAt: text(node.updatedAt),
  };
};

/** An open pull request node of `repo`, its head's statuses and check runs as REST lists them. */
const pullOf = (node: Record<string, unknown>, repo: string): GraphPull => {
  const commits = record(node.commits);
  const head = record(nodes(commits)[0]?.commit);
  const rollup = record(record(head.statusCheckRollup).contexts);
  const contexts = nodes(rollup);
  if (integer(rollup.totalCount) > contexts.length) throw new Failure(STAGE, `#${integer(node.number)}'s head has over ${contexts.length} statuses and check runs, too many to read`);
  const statuses = contexts
    .filter((context) => context.__typename === "StatusContext")
    .map((context) => {
      // GraphQL names a bot `github-actions`; REST, and so the App lookup, `github-actions[bot]`.
      const creator = record(context.creator);
      return { context: text(context.context), state: lower(context.state), creator: { login: `${text(creator.login)}${creator.__typename === "Bot" ? "[bot]" : ""}` } };
    });
  const workflows = new Map<number, number>();
  const runs = contexts
    .filter((context) => context.__typename === "CheckRun")
    .map((context) => {
      const suite = record(context.checkSuite);
      const workflow = record(record(suite.workflowRun).workflow).databaseId;
      if (Number.isSafeInteger(suite.databaseId) && Number.isSafeInteger(workflow)) workflows.set(suite.databaseId as number, workflow as number);
      return { name: text(context.name), status: lower(context.status), conclusion: lower(context.conclusion), app: { id: record(suite.app).databaseId }, check_suite: { id: suite.databaseId } };
    });
  const ref = pullRef(node, repo);
  return {
    ...ref,
    rest: {
      number: ref.number, state: "open", body: text(node.body), html_url: ref.url, user: { login: text(record(node.author).login) },
      head: { ref: text(node.headRefName), sha: text(node.headRefOid) }, draft: ref.draft, created_at: text(node.createdAt),
    },
    base: text(node.baseRefName),
    reviewDecision: lower(node.reviewDecision),
    commits: integer(commits.totalCount),
    changedFiles: integer(node.changedFiles),
    lastPushAt: text(head.committedDate) || null,
    lastCommentAt: text(nodes(node.comments)[0]?.createdAt) || null,
    statuses,
    runs,
    workflows,
  };
};

const branchPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

/**
 * The checks each base branch requires, as the merge guard reads them. A
 * check tied to an App counts only that App's statuses, so where one is,
 * each status's `app_id` is looked up from the bot that set it.
 */
const requirements = async (repo: string, read: Read, pulls: GraphPull[]): Promise<{ required: Map<string, RequiredCheck[]>; pulls: GraphPull[] }> => {
  const required = new Map<string, RequiredCheck[]>();
  for (const base of new Set(pulls.map((pull) => pull.base))) {
    const rules = await read(`repos/${repo}/rules/branches/${branchPath(base)}`);
    const branch = await read(`repos/${repo}/branches/${branchPath(base)}`);
    required.set(base, requiredChecks(rules ?? [], branch ?? {}));
  }
  if (![...required.values()].some((checks) => checks.some((check) => check.app !== undefined))) return { required, pulls };
  const apps = new Map<string, number | undefined>();
  const appOf = async (login: string) => {
    const name = /^([A-Za-z0-9-]+)\[bot\]$/.exec(login)?.[1];
    if (name === undefined) return undefined;
    if (!apps.has(name)) {
      const id = record(await read(`apps/${name}`)).id;
      apps.set(name, Number.isSafeInteger(id) ? (id as number) : undefined);
    }
    return apps.get(name);
  };
  const withApps: GraphPull[] = [];
  for (const pull of pulls) {
    const statuses: Record<string, unknown>[] = [];
    for (const status of pull.statuses) statuses.push({ ...status, app_id: await appOf(text(record(status.creator).login)) });
    withApps.push({ ...pull, statuses });
  }
  return { required, pulls: withApps };
};

/** How many issues one GraphQL request reads by number. */
const BY_NUMBER = 50;

/**
 * Reads the repository's graph: the open issues (every issue with `all`),
 * the issues they are blocked by here, the closed issues of each open
 * milestone, the milestones, and every open pull request.
 */
export const readGraph = async (io: ApiIo, read: Read, options: { readonly all: boolean }, now: () => Date = () => new Date()): Promise<GraphJson> => {
  const name = slug(io.repo);
  const fetchedAt = now().toISOString();
  const config = await queueConfig(io.repo, read);
  const queueIssue = config.issue === undefined ? undefined : await read(`repos/${name}/issues/${config.issue}`);
  if (config.issue !== undefined && queueIssue === undefined) throw new Failure(STAGE, `the Queue issue #${config.issue} (\`queue.issue\` in ${CONFIG_PATH}) cannot be read`);
  const queue = queueIssue === undefined ? undefined : parseQueue(text(record(queueIssue).body));
  const milestones = (
    await everyNode(io, "milestones", `,states:${options.all ? "[OPEN,CLOSED]" : "[OPEN]"},orderBy:{field:NUMBER,direction:ASC}`, "number title description state open:issues(states:OPEN){totalCount} closed:issues(states:CLOSED){totalCount}")
  ).map((node): Milestone => ({
    number: integer(node.number), title: text(node.title), description: text(node.description), state: lower(node.state) === "closed" ? "closed" : "open",
    open: integer(record(node.open).totalCount), closed: integer(record(node.closed).totalCount),
  }));
  const order = ",orderBy:{field:CREATED_AT,direction:ASC}";
  const found = new Map<number, Record<string, unknown>>();
  for (const node of await everyNode(io, "issues", `${options.all ? "" : ",states:[OPEN]"}${order}`, issueFields(true))) found.set(integer(node.number), node);
  if (!options.all) {
    for (const milestone of milestones.filter((item) => item.state === "open" && item.closed > 0)) {
      for (const node of await everyNode(io, "issues", `,states:[CLOSED],filterBy:{milestoneNumber:"${milestone.number}"}${order}`, issueFields(false))) found.set(integer(node.number), node);
    }
  }
  const issues: GraphIssue[] = [];
  for (const node of found.values()) issues.push(await issueOf(io, node));
  // The blockers here not read yet (closed ones, outside every open milestone), so each edge here ends at an issue in the graph.
  const missing = [...new Set(issues.flatMap((issue) => issue.blockedBy.filter((blocker) => blocker.repo === undefined && !found.has(blocker.number)).map((blocker) => blocker.number)))].sort((a, b) => a - b);
  for (let start = 0; start < missing.length; start += BY_NUMBER) {
    const batch = missing.slice(start, start + BY_NUMBER);
    const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${batch.map((number) => `i${number}:issue(number:${number}){${issueFields(false)}}`).join(" ")}}}`;
    const repository = await graphql(io, query, { owner: io.repo.owner, name: io.repo.name });
    for (const number of batch) {
      const node = repository[`i${number}`];
      if (typeof node === "object" && node !== null) {
        found.set(number, node as Record<string, unknown>);
        issues.push(await issueOf(io, node as Record<string, unknown>));
      }
    }
  }
  const listed = (await everyNode(io, "pullRequests", `,states:[OPEN]${order}`, PULL_FIELDS)).map((node) => pullOf(node, name));
  const { required, pulls } = await requirements(name, read, listed);
  return graphJson({ repo: io.repo, fetchedAt, config, queue, milestones, issues, pulls, required });
};
