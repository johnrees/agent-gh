import { afterEach, expect, test } from "bun:test";
import { claimMarker } from "../src/claim.ts";
import { listClaims } from "../src/claim-run.ts";
import { Failure } from "../src/failure.ts";
import { type GraphIssue, graphJson, type GraphPull, type GraphRead, parseGraphArgs } from "../src/graph.ts";
import { readGraph } from "../src/graph-run.ts";
import { apiReader, DEFAULT_PRIORITY_LABELS, nextIssues } from "../src/next-run.ts";
import { fakeGitHub, reply, SECRET_BODY } from "./fake-github.ts";

const REPO = { owner: "johnrees", name: "widget" };
const NOW = () => new Date("2026-10-21T12:00:00Z");

test("graph takes --json, --all, and -R; anything else, or no --json, is refused", () => {
  expect(parseGraphArgs(["--json"])).toEqual({ all: false });
  expect(parseGraphArgs(["--json", "--all", "-R", "o/r"])).toEqual({ all: true });
  expect(parseGraphArgs(["--repo=o/r", "--json"])).toEqual({ all: false });
  expect(parseGraphArgs([])).toBeUndefined();
  expect(parseGraphArgs(["--all"])).toBeUndefined();
  expect(parseGraphArgs(["--json", "--json"])).toBeUndefined();
  expect(parseGraphArgs(["--json", "7"])).toBeUndefined();
  expect(parseGraphArgs(["--json", "-R"])).toBeUndefined();
});

// The world: one repository's issues and pull requests, served over REST (for `next` and `claims`) and GraphQL (for `graph`).

type Comment = { readonly id: number; readonly body: string; readonly at: string; readonly association?: string };
type Issue = {
  readonly number: number;
  readonly state?: "open" | "closed";
  readonly labels?: readonly string[];
  readonly milestone?: number;
  readonly blockedBy?: readonly { readonly number: number; readonly repo?: string }[];
  readonly comments?: readonly Comment[];
  readonly closedBy?: readonly number[];
};
type Status = { readonly context: string; readonly state: string; readonly creator?: string };
type Run = { readonly name: string; readonly conclusion: string | null; readonly suite: number; readonly workflow?: number; readonly event?: string; readonly app?: number };
type Pull = {
  readonly number: number;
  readonly body: string;
  readonly state?: "open" | "closed" | "merged";
  readonly draft?: boolean;
  readonly createdAt: string;
  readonly pushedAt: string;
  readonly commits?: number;
  readonly changedFiles?: number;
  readonly comments?: readonly string[];
  readonly statuses?: readonly Status[];
  readonly runs?: readonly Run[];
  readonly review?: string;
  /** Its author's REST login. */
  readonly author?: string;
};
type World = {
  readonly config: unknown;
  readonly issues: readonly Issue[];
  readonly pulls: readonly Pull[];
  /** Issues in johnrees/other, by number: open or not. */
  readonly other?: Readonly<Record<number, boolean>>;
  readonly milestones: readonly { readonly number: number; readonly title: string; readonly state?: "open" | "closed" }[];
  /** The required_status_checks rules on main. */
  readonly rules?: readonly unknown[];
  /** GraphQL's page size here, small so paging is exercised. */
  readonly page?: number;
  readonly graphql?: (body: string) => Response | undefined;
};

const sha = (pr: number) => pr.toString(16).padStart(40, "0");
const title = (number: number) => `T${number}`;
const url = (number: number, kind = "issues") => `https://github.com/johnrees/widget/${kind}/${number}`;

const world = (spec: World) => {
  const issue = (number: number) => spec.issues.find((item) => item.number === number);
  const pull = (number: number) => spec.pulls.find((item) => item.number === number);
  const open = (item: Issue) => (item.state ?? "open") === "open";
  const restIssue = (item: Issue) => ({
    number: item.number, title: title(item.number), state: item.state ?? "open", labels: (item.labels ?? []).map((name) => ({ name })), html_url: url(item.number),
    repository_url: "https://api.github.com/repos/johnrees/widget", updated_at: "2026-10-20T00:00:00Z",
  });
  const blockers = (item: Issue) =>
    (item.blockedBy ?? []).map((blocker) =>
      blocker.repo === undefined
        ? { here: true, number: blocker.number, open: open(issue(blocker.number) as Issue) }
        : { here: false, number: blocker.number, open: spec.other?.[blocker.number] ?? false },
    );
  const restComment = (comment: Comment) => ({
    id: comment.id, html_url: `${url(0)}#issuecomment-${comment.id}`, author_association: comment.association ?? "OWNER", user: { login: "johnrees" }, body: comment.body, created_at: comment.at,
  });
  const restPull = (item: Pull) => ({
    number: item.number, state: "open", body: item.body, html_url: url(item.number, "pull"), user: { login: item.author ?? "johnrees" }, head: { ref: `claude/${item.number}-x`, sha: sha(item.number) },
    draft: item.draft ?? false, created_at: item.createdAt,
  });
  const openPulls = () => spec.pulls.filter((item) => (item.state ?? "open") === "open");
  const pageOf = <T>(items: readonly T[], query: URL) => {
    const page = Number(query.searchParams.get("page") ?? "1");
    const size = Number(query.searchParams.get("per_page") ?? "30");
    return items.slice((page - 1) * size, page * size);
  };

  const routes: Record<string, (body: string, query: URL) => Response> = {
    "GET /repos/johnrees/widget": () => reply(200, { default_branch: "main" }),
    "GET /repos/johnrees/widget/contents/.github/agent-review.json": () => reply(200, { content: Buffer.from(JSON.stringify(spec.config)).toString("base64") }),
    "GET /repos/johnrees/widget/issues": (_, query) =>
      reply(200, pageOf(spec.issues.filter((item) => open(item) && (item.labels ?? []).includes(query.searchParams.get("labels") ?? "")).map(restIssue), query)),
    "GET /repos/johnrees/widget/pulls": (_, query) => reply(200, pageOf(openPulls().map(restPull), query)),
    "GET /repos/johnrees/widget/rules/branches/main": () => reply(200, spec.rules ?? []),
    "GET /repos/johnrees/widget/branches/main": () => reply(200, { name: "main" }),
    "GET /apps/github-actions": () => reply(200, { id: 15368, slug: "github-actions" }),
  };
  for (const item of spec.issues) {
    const base = `GET /repos/johnrees/widget/issues/${item.number}`;
    routes[base] = () => reply(200, restIssue(item));
    routes[`${base}/comments`] = (_, query) => reply(200, pageOf((item.comments ?? []).map(restComment), query));
    routes[`${base}/dependencies/blocked_by`] = () =>
      reply(200, blockers(item).map((blocker) => ({
        number: blocker.number, title: title(blocker.number), state: blocker.open ? "open" : "closed",
        repository_url: `https://api.github.com/repos/johnrees/${blocker.here ? "widget" : "other"}`,
      })));
  }
  for (const item of spec.pulls) {
    routes[`GET /repos/johnrees/widget/commits/${sha(item.number)}`] = () => reply(200, { sha: sha(item.number), commit: { committer: { date: item.pushedAt } } });
    routes[`GET /repos/johnrees/widget/issues/${item.number}/comments`] = (_, query) => reply(200, pageOf((item.comments ?? []).map((at, index) => restComment({ id: 9000 + index, body: "hi", at })), query));
  }

  // GraphQL, as GitHub answers the queries graph-run.ts makes.
  const pullRef = (item: Pull) => ({ number: item.number, url: url(item.number, "pull"), repository: { nameWithOwner: "johnrees/widget" }, state: (item.state ?? "open").toUpperCase(), isDraft: item.draft ?? false, mergedAt: item.state === "merged" ? "2026-10-01T00:00:00Z" : null });
  const issueNode = (item: Issue, comments: boolean) => ({
    number: item.number, title: title(item.number), url: url(item.number), state: (item.state ?? "open").toUpperCase(), updatedAt: "2026-10-20T00:00:00Z",
    milestone: item.milestone === undefined ? null : { number: item.milestone, title: spec.milestones.find((milestone) => milestone.number === item.milestone)?.title },
    labels: { totalCount: (item.labels ?? []).length, nodes: (item.labels ?? []).map((name) => ({ name })) },
    blockedBy: {
      totalCount: (item.blockedBy ?? []).length,
      nodes: blockers(item).map((blocker) => ({ number: blocker.number, title: title(blocker.number), state: blocker.open ? "OPEN" : "CLOSED", repository: { nameWithOwner: `johnrees/${blocker.here ? "widget" : "other"}` } })),
    },
    closedByPullRequestsReferences: { totalCount: (item.closedBy ?? []).length, nodes: (item.closedBy ?? []).map((number) => pullRef(pull(number) as Pull)) },
    ...(comments
      ? {
          comments: {
            totalCount: (item.comments ?? []).length,
            nodes: (item.comments ?? []).slice(-30).map((comment) => ({
              databaseId: comment.id, url: `${url(0)}#issuecomment-${comment.id}`, authorAssociation: comment.association ?? "OWNER", author: { login: "johnrees" }, body: comment.body, createdAt: comment.at,
            })),
          },
        }
      : {}),
  });
  const pullNode = (item: Pull) => {
    const contexts = [
      ...(item.statuses ?? []).map((status) => ({ __typename: "StatusContext", context: status.context, state: status.state.toUpperCase(), creator: (status.creator ?? "johnrees").endsWith("[bot]") ? { __typename: "Bot", login: (status.creator as string).slice(0, -5) } : { __typename: "User", login: status.creator ?? "johnrees" } })),
      ...(item.runs ?? []).map((run) => ({
        __typename: "CheckRun", name: run.name, status: run.conclusion === null ? "IN_PROGRESS" : "COMPLETED", conclusion: run.conclusion?.toUpperCase() ?? null,
        checkSuite: {
          databaseId: run.suite, status: run.conclusion === null ? "IN_PROGRESS" : "COMPLETED", app: { databaseId: run.app ?? 15368 },
          workflowRun: run.workflow === undefined ? null : { event: run.event ?? "pull_request", workflow: { databaseId: run.workflow } },
        },
      })),
    ];
    return {
      ...pullRef(item), title: `P${item.number}`, body: item.body, createdAt: item.createdAt, reviewDecision: item.review ?? null, baseRefName: "main",
      headRefName: `claude/${item.number}-x`, headRefOid: sha(item.number), changedFiles: item.changedFiles ?? 1,
      author: item.author?.endsWith("[bot]") ? { __typename: "Bot", login: item.author.slice(0, -5) } : { __typename: "User", login: item.author ?? "johnrees" },
      comments: { nodes: (item.comments ?? []).slice(-1).map((createdAt) => ({ createdAt })) },
      commits: { totalCount: item.commits ?? 2, nodes: [{ commit: { committedDate: item.pushedAt, statusCheckRollup: contexts.length === 0 ? null : { contexts: { totalCount: contexts.length, nodes: contexts } } } }] },
    };
  };
  const size = spec.page ?? 2;
  const connection = (all: readonly unknown[], after: unknown) => {
    const start = typeof after === "string" ? Number(after) : 0;
    const end = start + size;
    return { pageInfo: { hasNextPage: end < all.length, endCursor: String(end) }, nodes: all.slice(start, end) };
  };
  routes["POST /graphql"] = (body) => {
    const custom = spec.graphql?.(body);
    if (custom !== undefined) return custom;
    const { query, variables } = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
    const list = /list:(\w+)\(first:100,after:\$after([^)]*\})?/.exec(query);
    const states = /states:\[([A-Z,]+)\]/.exec(query)?.[1]?.split(",").map((state) => state.toLowerCase());
    if (list?.[1] === "issues") {
      const milestone = /milestoneNumber:"(\d+)"/.exec(query)?.[1];
      const items = spec.issues
        .filter((item) => states === undefined || states.includes(item.state ?? "open"))
        .filter((item) => milestone === undefined || item.milestone === Number(milestone))
        .map((item) => issueNode(item, query.includes("comments(last:30)")));
      return reply(200, { data: { repository: { list: connection(items, variables.after) } } });
    }
    if (list?.[1] === "milestones") {
      const items = spec.milestones
        .filter((milestone) => states === undefined || states.includes(milestone.state ?? "open"))
        .map((milestone) => {
          const of = (state: string) => spec.issues.filter((item) => item.milestone === milestone.number && (item.state ?? "open") === state).length;
          return { number: milestone.number, title: milestone.title, description: `about ${milestone.title}`, state: (milestone.state ?? "open").toUpperCase(), open: { totalCount: of("open") }, closed: { totalCount: of("closed") } };
        });
      return reply(200, { data: { repository: { list: connection(items, variables.after) } } });
    }
    if (list?.[1] === "pullRequests") return reply(200, { data: { repository: { list: connection(openPulls().map(pullNode), variables.after) } } });
    const repository: Record<string, unknown> = {};
    for (const match of query.matchAll(/i(\d+):issue\(number:(\d+)\)/g)) {
      const found = issue(Number(match[2]));
      repository[`i${match[1]}`] = found === undefined ? null : issueNode(found, false);
    }
    return reply(200, { data: { repository } });
  };
  const fake = fakeGitHub(routes);
  servers.push(fake);
  return { io: { api: fake.api, token: "ghs_test", repo: REPO }, log: fake.log };
};

const servers: { stop: () => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

const marker = (issue: number, family: string, session: string, id: string) => claimMarker({ v: 1, issue, family, session, id });
const comments = (count: number, from: number, at: (index: number) => string): Comment[] => Array.from({ length: count }, (_, index) => ({ id: from + index, body: "a note", at: at(index) }));

/** Every status graph gives, and the claims and blockers next --waves and claims see too. */
const REPOSITORY: World = {
  config: { reviewers: { codex: { model: "m" } }, hold: {} },
  milestones: [{ number: 1, title: "M0" }, { number: 2, title: "M1" }, { number: 3, title: "Old", state: "closed" }],
  other: { 40: true, 41: false },
  rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "agent-review", integration_id: 15368 }, { context: "test" }] } }],
  issues: [
    { number: 1, labels: ["ready", "priority:high"], milestone: 1, blockedBy: [{ number: 14 }, { number: 41, repo: "johnrees/other" }] },
    { number: 2, labels: ["ready"], milestone: 1, blockedBy: [{ number: 1 }] },
    { number: 3, labels: ["ready", "claimed"], milestone: 2 },
    { number: 4, labels: ["ready", "claimed"] },
    { number: 5, labels: ["ready", "claimed"] },
    // A comment claim behind 31 later comments: more than graph reads with the issue, so it reads them whole.
    {
      number: 6, labels: ["ready", "claimed"],
      comments: [{ id: 600, body: marker(6, "codex", "c6", "0123456789abcdef"), at: "2026-10-02T00:00:00Z" }, ...comments(31, 601, (index) => `2026-10-03T00:00:${String(index).padStart(2, "0")}Z`)],
    },
    { number: 7, labels: [] },
    { number: 8, labels: ["ready", "Needs-Human"] },
    { number: 9, labels: ["ready"], blockedBy: [{ number: 10 }] },
    { number: 10, labels: ["ready"], blockedBy: [{ number: 9 }] },
    { number: 11, labels: ["ready"], blockedBy: [{ number: 40, repo: "johnrees/other" }] },
    { number: 12, state: "closed", milestone: 1, closedBy: [20] },
    { number: 13, state: "closed", milestone: 1, closedBy: [21] },
    { number: 14, state: "closed", closedBy: [22], blockedBy: [{ number: 17 }] },
    { number: 15, state: "closed", milestone: 3 },
    // Behind a skipped issue: blocked, as next --waves has it waiting.
    { number: 16, labels: ["ready"], blockedBy: [{ number: 8 }] },
    // #14's own closed blocker, read only once #14 is.
    { number: 17, state: "closed" },
  ],
  pulls: [
    { number: 31, body: `Closes #3.\n${marker(3, "claude", "s3", "1111111111111111")}`, draft: true, createdAt: "2026-10-10T00:00:00Z", pushedAt: "2026-10-11T00:00:00Z", commits: 1, changedFiles: 0, comments: ["2026-10-12T00:00:00Z"] },
    {
      number: 32, body: `Closes #4.\n${marker(4, "codex", "s4", "2222222222222222")}`, createdAt: "2026-10-10T00:00:00Z", pushedAt: "2026-10-13T00:00:00Z",
      statuses: [{ context: "agent-review", state: "pending", creator: "github-actions[bot]" }, { context: "agent-threads", state: "success", creator: "github-actions[bot]" }],
    },
    {
      // A pull request with no marker: Refs only. A failed run of "test" gave way to a newer run of the same workflow;
      // a dispatched run's failure after it counts for nothing, as GitHub does not evaluate it.
      // A bot's: GraphQL names it `renovate`, claims --json `renovate[bot]`.
      number: 33, author: "renovate[bot]", body: "Refs #5", createdAt: "2026-10-10T00:00:00Z", pushedAt: "2026-10-14T00:00:00Z", review: "APPROVED",
      statuses: [{ context: "agent-review", state: "success", creator: "github-actions[bot]" }, { context: "agent-threads", state: "success", creator: "github-actions[bot]" }, { context: "agent-hold", state: "success", creator: "github-actions[bot]" }],
      runs: [{ name: "test", conclusion: "failure", suite: 1, workflow: 77 }, { name: "test", conclusion: "success", suite: 2, workflow: 77 }, { name: "test", conclusion: "failure", suite: 3, workflow: 77, event: "workflow_dispatch" }],
    },
    { number: 20, body: "Closes #12", state: "merged", createdAt: "2026-09-01T00:00:00Z", pushedAt: "2026-09-01T00:00:00Z" },
    { number: 21, body: "Closes #13", state: "closed", createdAt: "2026-09-01T00:00:00Z", pushedAt: "2026-09-01T00:00:00Z" },
    { number: 22, body: "Closes #14", state: "merged", createdAt: "2026-09-01T00:00:00Z", pushedAt: "2026-09-01T00:00:00Z" },
  ],
};

test("graph gives every open issue its status, wave, milestone, blockers, holder, and pull request, with each open milestone's closed issues", async () => {
  const { io } = world(REPOSITORY);
  const graph = await readGraph(io, apiReader(io), { all: false }, NOW);
  expect(graph).toMatchObject({ v: 1, repo: "johnrees/widget", fetched_at: "2026-10-21T12:00:00.000Z", queue: null, label: "ready", priority_labels: DEFAULT_PRIORITY_LABELS, stuck: [9, 10, 11], cycles: [[9, 10]] });
  expect(graph.milestones).toEqual([
    { number: 1, title: "M0", description: "about M0", state: "open", open: 2, closed: 2 },
    { number: 2, title: "M1", description: "about M1", state: "open", open: 1, closed: 0 },
  ]);
  // #14 is read as #1's closed blocker, and #17 as #14's; #15, closed in a closed milestone, is not read.
  expect(graph.issues.map((item) => [item.issue, item.status, item.wave])).toEqual([
    [1, "workable", 1],
    [2, "blocked", 2],
    [3, "claimed", 1],
    [4, "in_review", 1],
    [5, "ready", 1],
    [6, "claimed", 1],
    [7, "not_dispatched", 1],
    [8, "skipped", 1],
    [9, "stuck", null],
    [10, "stuck", null],
    [11, "stuck", null],
    [12, "merged", null],
    [13, "closed", null],
    [14, "merged", null],
    [16, "blocked", 2],
    [17, "closed", null],
  ]);
  // Every edge here ends at an issue in the graph.
  const numbers = new Set(graph.issues.map((item) => item.issue));
  expect(graph.issues.flatMap((item) => item.blocked_by.filter((blocker) => blocker.repo === null && !numbers.has(blocker.issue)))).toEqual([]);
  const at = (number: number) => graph.issues.find((item) => item.issue === number);
  expect(at(1)).toMatchObject({
    title: "T1", url: url(1), state: "open", milestone: "M0", labels: ["priority:high", "ready"], priority: "priority:high", queued: null,
    blocked_by: [{ issue: 14, repo: null, open: false }, { issue: 41, repo: "johnrees/other", open: false }], claim: null, pr: null, skipped_by: null,
  });
  expect(at(3)).toMatchObject({
    claim: { kind: "pr", pr: 31, family: "claude", session: "s3", branch: "claude/31-x", created_at: "2026-10-10T00:00:00Z", last_push_at: "2026-10-11T00:00:00Z", last_comment_at: "2026-10-12T00:00:00Z" },
    pr: { number: 31, draft: true, state: "open", merged_at: null, review_decision: null, statuses: { "agent-review": null, "agent-threads": null, "agent-hold": null }, checks: "missing" },
  });
  expect(at(4)?.pr).toMatchObject({ statuses: { "agent-review": "pending", "agent-threads": "success", "agent-hold": null }, checks: "missing" });
  expect(at(5)?.claim).toMatchObject({ kind: "pr", pr: 33, author: "renovate[bot]", family: null, session: null });
  expect(at(5)?.pr).toEqual({
    number: 33, url: url(33, "pull"), draft: false, state: "open", merged_at: null, review_decision: "approved",
    statuses: { "agent-review": "success", "agent-threads": "success", "agent-hold": "success" }, checks: "passed",
  });
  expect(at(6)?.claim).toMatchObject({ kind: "comment", pr: null, family: "codex", session: "c6", last_push_at: null, last_comment_at: "2026-10-03T00:00:30Z" });
  expect(at(8)?.skipped_by).toEqual({ rule: "hold.label", pattern: "needs-human", label: "Needs-Human" });
  expect(at(11)?.blocked_by).toEqual([{ issue: 40, repo: "johnrees/other", open: true }]);
  expect(at(12)?.pr).toMatchObject({ number: 20, state: "merged", merged_at: "2026-10-01T00:00:00Z", statuses: { "agent-review": null }, checks: null });
  expect(at(13)?.pr).toMatchObject({ number: 21, state: "closed" });
});

test("graph agrees with next --waves on each issue's wave and claim, and with claims on each holder", async () => {
  const { io } = world(REPOSITORY);
  const graph = await readGraph(io, apiReader(io), { all: false }, NOW);
  const next = await nextIssues(REPO, apiReader(io));
  const at = (number: number) => graph.issues.find((item) => item.issue === number);
  const status = { workable: ["workable"], in_progress: ["claimed", "in_review", "ready"], not_dispatched: ["not_dispatched"], skipped: ["skipped"], waiting: ["blocked"] };
  let compared = 0;
  next.waves.forEach((layer, index) => {
    for (const item of layer) {
      compared++;
      expect([item.issue, at(item.issue)?.wave]).toEqual([item.issue, index + 1]);
      // A skipped issue behind a blocker is blocked in graph, which says why it is skipped all the same.
      expect(item.state === "skipped" && index > 0 ? ["blocked"] : status[item.state]).toContain(at(item.issue)?.status as string);
      const claim = at(item.issue)?.claim;
      expect(claim === null || claim === undefined ? null : { kind: claim.kind, pr: claim.pr, url: claim.url, family: claim.family, session: claim.session }).toEqual(item.claim);
    }
  });
  expect(compared).toBe(8);
  expect(next.stuck.map((item) => item.issue)).toEqual(graph.stuck);
  expect(next.cycles).toEqual(graph.cycles);
  const claims = await listClaims(io);
  const holders = claims.claims.filter((item) => item.holds);
  expect(holders.map((item) => item.issue)).toEqual([3, 4, 5, 6]);
  for (const item of holders) {
    expect(at(item.issue)?.claim).toEqual({
      kind: item.kind, pr: item.pr, url: item.url, author: item.author, family: item.family, session: item.session, branch: item.branch,
      created_at: item.created_at, last_push_at: item.last_push_at, last_comment_at: item.last_comment_at,
    });
  }
});

test("graph reads in a few GraphQL requests where next --waves and claims make one REST call per issue and edge", async () => {
  const { io, log } = world({ ...REPOSITORY, page: 100 });
  await readGraph(io, apiReader(io), { all: false }, NOW);
  const graphql = log.filter((entry) => entry.path === "/graphql");
  // Milestones, open issues, M0's closed issues, #14 by number, then its blocker #17, open pull requests.
  expect(graphql.length).toBe(6);
  // The config and repository, #6's comments read whole, main's rules and branch, and the github-actions App.
  expect(log.length - graphql.length).toBe(6);
  expect(graphql.every((entry) => !/mutation/.test(entry.body))).toBe(true);
  const before = log.length;
  await nextIssues(REPO, apiReader(io));
  await listClaims(io);
  expect(log.length - before).toBeGreaterThan(30);
});

test("--all reads every issue and every milestone", async () => {
  const { io } = world(REPOSITORY);
  const graph = await readGraph(io, apiReader(io), { all: true }, NOW);
  expect(graph.issues.map((item) => item.issue)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  expect(graph.issues.find((item) => item.issue === 15)).toMatchObject({ state: "closed", status: "closed", milestone: "Old" });
  expect(graph.milestones.map((item) => [item.title, item.state])).toEqual([["M0", "open"], ["M1", "open"], ["Old", "closed"]]);
});

test("GraphQL that fails or is refused is reported by its status or error types, never GitHub's text", async () => {
  for (const [answer, expected] of [
    [() => reply(502, { message: SECRET_BODY }), "HTTP 502 from POST /graphql"],
    [() => reply(200, { errors: [{ type: "FORBIDDEN", message: SECRET_BODY }] }), "GitHub's GraphQL API refused the request (FORBIDDEN)"],
    [() => reply(200, { data: { repository: null } }), "johnrees/widget cannot be read with this token"],
  ] as const) {
    const { io } = world({ ...REPOSITORY, graphql: answer });
    const error = await readGraph(io, apiReader(io), { all: false }, NOW).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Failure);
    expect((error as Failure).detail).toContain(expected);
    expect((error as Failure).detail).not.toContain(SECRET_BODY);
  }
});

test("a FORBIDDEN on the rollup's status contexts names the missing Commit statuses permission", async () => {
  const path = ["repository", "pullRequests", "nodes", 0, "commits", "nodes", 0, "commit", "statusCheckRollup", "contexts", "nodes", 0];
  const { io } = world({
    ...REPOSITORY,
    graphql: () => reply(200, { data: { repository: { list: { pageInfo: { hasNextPage: false }, nodes: [] } } }, errors: [{ type: "FORBIDDEN", path, message: SECRET_BODY }] }),
  });
  const error = await readGraph(io, apiReader(io), { all: false }, NOW).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Failure);
  expect((error as Failure).detail).toBe('the token cannot read commit statuses in johnrees/widget; give the App "Commit statuses: read" (agent-gh settings read prints its permissions page) and accept it on the installation');
  expect((error as Failure).detail).not.toContain(SECRET_BODY);
});

test("an issue with more blockers or labels than one read holds is refused, not judged on part of them", async () => {
  const { io } = world({
    ...REPOSITORY,
    graphql: (body) => {
      if (!body.includes("list:issues")) return undefined;
      const node = { number: 1, title: "T1", url: url(1), state: "OPEN", milestone: null, labels: { totalCount: 0, nodes: [] }, blockedBy: { totalCount: 101, nodes: [] }, closedByPullRequestsReferences: { totalCount: 0, nodes: [] }, comments: { totalCount: 0, nodes: [] } };
      return reply(200, { data: { repository: { list: { pageInfo: { hasNextPage: false }, nodes: [node] } } } });
    },
  });
  expect((await readGraph(io, apiReader(io), { all: false }, NOW).catch((caught: Failure) => caught.detail)) as string).toBe("#1 has over 0 blockers, too many to read");
});

// The derivation alone, on hand-built reads.

const CONFIG = { issue: undefined, label: "ready", priorityLabels: DEFAULT_PRIORITY_LABELS, skipLabels: [] };
const graphIssue = (number: number, extra: Partial<GraphIssue> = {}): GraphIssue => ({
  number, title: title(number), url: url(number), open: true, milestone: null, labels: ["ready"], blockedBy: [], comments: [], closedBy: [], updatedAt: "", ...extra,
});
const graphPull = (number: number, issue: number, extra: Partial<GraphPull> = {}): GraphPull => ({
  number, url: url(number, "pull"), here: true, state: "open", draft: false, mergedAt: null,
  rest: { number, state: "open", body: `Closes #${issue}`, html_url: url(number, "pull"), user: { login: "johnrees" }, head: { ref: "b", sha: sha(number) }, draft: extra.draft ?? false, created_at: "2026-10-01T00:00:00Z" },
  base: "main", reviewDecision: null, commits: 2, changedFiles: 1, lastPushAt: null, lastCommentAt: null,
  statuses: [{ context: "agent-review", state: "success" }], runs: [], workflows: new Map(), ...extra,
});
const derive = (issues: GraphIssue[], pulls: GraphPull[] = [], extra: Partial<GraphRead> = {}) =>
  graphJson({ repo: REPO, fetchedAt: "", config: CONFIG, queue: undefined, milestones: [], issues, pulls, required: new Map(), ...extra });
const statuses = (result: ReturnType<typeof derive>) => result.issues.map((item) => [item.issue, item.status]);

test("a ready pull request is in review until agent-review passes, agent-threads and agent-hold pass where set, and the required checks pass", () => {
  const issues = [1, 2, 3, 4, 5, 6].map((number) => graphIssue(number));
  const result = derive(issues, [
    graphPull(41, 1),
    graphPull(42, 2, { statuses: [] }),
    graphPull(43, 3, { statuses: [{ context: "agent-review", state: "success" }, { context: "agent-threads", state: "failure" }] }),
    graphPull(44, 4, { statuses: [{ context: "agent-review", state: "success" }, { context: "agent-hold", state: "pending" }] }),
    // Still only the claim's empty commit, though no longer a draft.
    graphPull(45, 5, { commits: 1, changedFiles: 0 }),
    graphPull(46, 6, { base: "release" }),
  ], { required: new Map([["release", [{ context: "build", app: undefined }]]]) });
  expect(statuses(result)).toEqual([[1, "ready"], [2, "in_review"], [3, "in_review"], [4, "in_review"], [5, "claimed"], [6, "in_review"]]);
  expect(result.issues.find((item) => item.issue === 6)?.pr?.checks).toBe("missing");
  expect(result.issues.find((item) => item.issue === 1)?.pr?.checks).toBeNull();
});

test("where a Queue is configured, only its issues are dispatched, and each issue carries its place", () => {
  const result = derive([graphIssue(1), graphIssue(2), graphIssue(3, { labels: [] })], [], { queue: [2, 3], config: { ...CONFIG, issue: 100 } });
  expect(result.queue).toBe(100);
  expect(result.issues.map((item) => [item.issue, item.status, item.queued])).toEqual([[1, "not_dispatched", null], [2, "workable", 0], [3, "not_dispatched", 1]]);
});

test("a claim holds a blocked issue's status as its work, and a pull request only a person linked shows without a claim", () => {
  const result = derive([
    graphIssue(1),
    graphIssue(2, { blockedBy: [{ repo: undefined, number: 1, open: true, title: "T1" }] }),
    graphIssue(3, { closedBy: [{ number: 50, url: url(50, "pull"), here: true, state: "open", draft: false, mergedAt: null }] }),
  ], [graphPull(48, 2, { draft: true }), graphPull(50, 99)]);
  expect(statuses(result)).toEqual([[1, "workable"], [2, "claimed"], [3, "workable"]]);
  expect(result.issues.find((item) => item.issue === 2)?.wave).toBe(2);
  expect(result.issues.find((item) => item.issue === 3)).toMatchObject({ claim: null, pr: { number: 50, state: "open", statuses: { "agent-review": "success" } } });
});

test("a pull request in another repository that closes an issue is shown as itself, never as the open one here with its number", () => {
  const elsewhere = "https://github.com/johnrees/other/pull/50";
  const result = derive([graphIssue(3, { closedBy: [{ number: 50, url: elsewhere, here: false, state: "open", draft: false, mergedAt: null }] })], [graphPull(50, 99)]);
  expect(result.issues[0]?.pr).toEqual({
    number: 50, url: elsewhere, draft: false, state: "open", merged_at: null, review_decision: null,
    statuses: { "agent-review": null, "agent-threads": null, "agent-hold": null }, checks: null,
  });
});

test("the dispatch label matches in any case, as GitHub's labels and next's filter do", () => {
  expect(statuses(derive([graphIssue(1, { labels: ["Ready"] }), graphIssue(2, { labels: ["READY", "needs-human"] })], [], { config: { ...CONFIG, holdLabel: "needs-human" } }))).toEqual([
    [1, "workable"],
    [2, "skipped"],
  ]);
});
