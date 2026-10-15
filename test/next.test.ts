import { afterEach, expect, test } from "bun:test";
import { type Claim, claimMarker, parseClaimArgs } from "../src/claim.ts";
import { type ClaimIo, UNKNOWN } from "../src/claim-run.ts";
import { type Blocker, frontier, type Node, parseQueue, waves } from "../src/next.ts";
import { apiReader, claimNext, nextIssues, nextJson, nextLines, type Read, wavesJson, wavesLines } from "../src/next-run.ts";
import { fakeGitHub, reply } from "./fake-github.ts";

const REPO = { owner: "johnrees", name: "widget" };

test("a Queue entry is a numbered item, and its first issue reference is what it queues", () => {
  const body = [
    "The next issue is the first numbered entry below (#99 is context).",
    "",
    "1. `xhigh` #337 T7 The native app. Queued ahead of #472.",
    "2. `medium` #636 Size the compute limit; see johnrees/other#5 and docs/x#7.",
    "- Swaps: #655 (a bullet, context)",
    "3. #337 again, a duplicate",
    "10.\t#12 tab-separated",
    "4.no space #13",
    "5. a path docs/a.md#4 and a repo johnrees/other#5 come before #21",
  ].join("\n");
  expect(parseQueue(body)).toEqual([337, 636, 12, 21]);
});

const blocker = (number: number, open = true, repo?: string): Blocker => ({ repo, number, open, title: `T${number}` });
const node = (number: number, blockers: Blocker[] = [], extra: Partial<Node> = {}): [number, Node] => [number, { number, title: `T${number}`, dispatched: true, blockers, claim: undefined, ...extra }];
const graph = (entries: [number, Node][], queue?: number[]) => waves({ queue, nodes: new Map(entries) });
const numbers = (result: ReturnType<typeof waves>) => result.waves.map((wave) => wave.map((item) => item.issue));

test("a diamond: the root first, its two dependents together, then what waits on both", () => {
  const result = graph([node(4, [blocker(2), blocker(3)]), node(3, [blocker(1)]), node(2, [blocker(1)]), node(1)]);
  expect(numbers(result)).toEqual([[1], [2, 3], [4]]);
  expect(result.waves[0]?.[0]).toMatchObject({ issue: 1, state: "workable", unblocks: 3, waiting_on: [] });
  expect(result.waves[2]?.[0]).toMatchObject({ issue: 4, state: "waiting", waiting_on: ["#2", "#3"] });
  expect(result.cycles).toEqual([]);
});

test("a chain layers one per wave, and a closed blocker counts as resolved", () => {
  const result = graph([node(3, [blocker(2)]), node(2, [blocker(1), blocker(9, false)]), node(1, [blocker(8, false)])]);
  expect(numbers(result)).toEqual([[1], [2], [3]]);
  expect(result.waves[0]?.[0]?.unblocks).toBe(2);
});

test("a cycle is reported and never offered, nor is anything behind it", () => {
  const result = graph([node(5, [blocker(6)]), node(6, [blocker(5)]), node(7, [blocker(6)]), node(8, [blocker(8)]), node(1)]);
  expect(result.cycles).toEqual([[5, 6], [8]]);
  expect(numbers(result)).toEqual([[1]]);
  expect(result.stuck.map((item) => item.issue)).toEqual([5, 6, 7, 8]);
  expect(frontier(result).map((item) => item.issue)).toEqual([1]);
});

test("an open blocker in another repository is never queued, and holds back what waits on it; a closed one does not", () => {
  const result = graph([node(2, [blocker(40, true, "johnrees/other")]), node(3, [blocker(2)]), node(4, [blocker(41, false, "johnrees/other")])]);
  expect(numbers(result)).toEqual([[4]]);
  expect(result.stuck).toEqual([
    expect.objectContaining({ issue: 2, waiting_on: ["johnrees/other#40"] }),
    expect.objectContaining({ issue: 3, waiting_on: ["#2"] }),
  ]);
});

const claimOn = (issue: number, pr: number): Claim => ({
  issue, kind: "pr", pr, comment: null, url: `https://github.com/johnrees/widget/pull/${pr}`, author: "johnrees", family: "claude", session: "s", id: "0123456789abcdef", branch: "b", draft: true, createdAt: "",
});

test("a claimed issue in the frontier is in progress; a blocker nobody dispatched is unblocked but not offered", () => {
  const result = graph([node(1, [], { claim: claimOn(1, 31) }), node(2), node(3, [], { dispatched: false }), node(4, [blocker(3)])]);
  expect(result.waves[0]?.map((item) => [item.issue, item.state])).toEqual([[3, "not_dispatched"], [1, "in_progress"], [2, "workable"]]);
  expect(frontier(result).map((item) => [item.issue, item.state])).toEqual([[1, "in_progress"], [2, "workable"]]);
  expect(result.waves[0]?.find((item) => item.issue === 1)?.claim).toEqual({ kind: "pr", pr: 31, url: "https://github.com/johnrees/widget/pull/31", family: "claude", session: "s" });
});

test("within a wave the Queue's order wins; then what unblocks the most, then the number", () => {
  const entries = [node(1), node(2), node(3), node(9), node(5, [blocker(9)]), node(6, [blocker(3)]), node(7, [blocker(6)])];
  expect(graph(entries, [2, 1]).waves[0]?.map((item) => item.issue)).toEqual([2, 1, 3, 9]);
  expect(graph(entries).waves[0]?.map((item) => item.issue)).toEqual([3, 9, 1, 2]);
});

test("next parses its flags, and claim takes --next in place of a number", () => {
  expect(parseClaimArgs("next", [])).toEqual({ command: "next", json: false, waves: false });
  expect(parseClaimArgs("next", ["--waves", "--json", "-R", "o/r"])).toEqual({ command: "next", json: true, waves: true });
  expect(parseClaimArgs("next", ["7"])).toBeUndefined();
  expect(parseClaimArgs("claim", ["--next", "--no-pr"])).toEqual({ command: "claim-next", refs: false, noPr: true });
  expect(parseClaimArgs("claim", ["--next", "7"])).toBeUndefined();
  expect(parseClaimArgs("claim", ["--next", "--next"])).toBeUndefined();
});

// The reader soltui's script injects: endpoint in, JSON out (every page), undefined for a 404.

const issue = (number: number, labels: string[] = ["ready"], extra: Record<string, unknown> = {}) => ({
  number, title: `T${number}`, state: "open", labels: labels.map((name) => ({ name })), repository_url: "https://api.github.com/repos/johnrees/widget", ...extra,
});
const config = (value: unknown) => ({ content: Buffer.from(JSON.stringify(value)).toString("base64") });

/** A route GitHub answers with 404. */
const NOT_FOUND = Symbol("404");
/** A list endpoint with no route reads as an empty list; anything else with none, and NOT_FOUND, as a 404. */
const LIST = /(\/comments|\/dependencies\/blocked_by|\/pulls\?state=open|\/issues\?state=open&labels=[^/]*)$/;

const reader = (routes: Record<string, unknown>) => {
  const asked: string[] = [];
  const read: Read = async (endpoint) => {
    asked.push(endpoint);
    if (Object.hasOwn(routes, endpoint)) return routes[endpoint] === NOT_FOUND ? undefined : routes[endpoint];
    return LIST.test(endpoint) ? [] : undefined;
  };
  return { read, asked };
};

const BASE = {
  "repos/johnrees/widget": { default_branch: "main" },
  "repos/johnrees/widget/pulls?state=open": [{ number: 31, state: "open", body: `Closes #3.\n${claimMarker({ v: 1, issue: 3, family: "codex", session: "t", id: "0123456789abcdef" })}`, user: { login: "johnrees" }, head: { ref: "codex/3-x" } }],
};

test("next reads the Queue, the ready issues, their blockers transitively, and their claims", async () => {
  const { read, asked } = reader({
    ...BASE,
    "repos/johnrees/widget/contents/.github/agent-review.json?ref=main": config({ reviewers: { codex: { model: "m" } }, queue: { issue: 100, label: "go" } }),
    "repos/johnrees/widget/issues/100": { number: 100, body: "1. #4 last\n2. #2 first? no: second\n3. #3 claimed\n4. #9 closed" },
    "repos/johnrees/widget/issues?state=open&labels=go": [issue(2, ["go"]), issue(3, ["go"]), issue(4, ["go"]), issue(6, ["go"]), { ...issue(50, ["go"]), pull_request: {} }],
    "repos/johnrees/widget/issues/9": issue(9, ["go"], { state: "closed" }),
    "repos/johnrees/widget/issues/4/dependencies/blocked_by": [issue(5, []), { ...issue(70, []), repository_url: "https://api.github.com/repos/johnrees/other", state: "closed" }],
    "repos/johnrees/widget/issues/5/dependencies/blocked_by": [{ ...issue(1, []), state: "closed" }],
    "repos/johnrees/widget/issues/2/dependencies/blocked_by": [],
    "repos/johnrees/widget/issues/6/dependencies/blocked_by": [{ ...issue(40, []), repository_url: "https://api.github.com/repos/johnrees/other" }],
    "repos/johnrees/widget/issues/3/comments": [],
  });
  const result = await nextIssues(REPO, read);
  // #5 joins as #4's open blocker (undispatched); #6 is ready but not queued; #70 elsewhere is never followed.
  expect(result.waves.map((wave) => wave.map((item) => [item.issue, item.state]))).toEqual([
    [[2, "workable"], [3, "in_progress"], [5, "not_dispatched"]],
    [[4, "waiting"]],
  ]);
  expect(result.stuck).toEqual([expect.objectContaining({ issue: 6, waiting_on: ["johnrees/other#40"] })]);
  expect(asked.some((endpoint) => endpoint.includes("johnrees/other"))).toBe(false);
  const notes: string[] = [];
  expect(nextLines(result, (line) => notes.push(line))).toEqual(["#2 T2"]);
  expect(notes).toEqual(["agent-gh: #3 T3: in progress: #31 by codex t"]);
  expect(nextJson(REPO, result)).toEqual({
    v: 1, repo: "johnrees/widget", queue: 100, label: "go",
    issues: [{ issue: 2, title: "T2", priority: null, claim: null }, { issue: 3, title: "T3", priority: null, claim: { kind: "pr", pr: 31, url: "", family: "codex", session: "t" } }],
  });
  expect(wavesJson(REPO, result).waves[1]).toEqual({ wave: 2, issues: [expect.objectContaining({ issue: 4, queued: 0, waiting_on: ["#5"] })] });
  expect(wavesLines(result, () => {})).toEqual([
    "Wave 1, workable now:",
    "  #2 T2 (queue 2)",
    "Wave 1, in progress:",
    "  #3 T3 (queue 3; in progress: #31 by codex t)",
    "Wave 1, unblocked but not dispatched:",
    "  #5 T5 (unblocks 1; not dispatched)",
    "Wave 2:",
    "  #4 T4 (queue 1; waits on #5)",
    "Stuck (a cycle, or an open issue elsewhere):",
    "  #6 T6 (waits on johnrees/other#40)",
  ]);
});

test("with no Queue configured, next falls back to the ready issues and says so", async () => {
  const { read } = reader({
    ...BASE,
    "repos/johnrees/widget/issues?state=open&labels=ready": [issue(8), issue(2)],
    "repos/johnrees/widget/issues/2/comments": [],
    "repos/johnrees/widget/issues/8/comments": [],
  });
  const result = await nextIssues(REPO, read);
  const notes: string[] = [];
  expect(nextLines(result, (line) => notes.push(line))).toEqual(["#2 T2", "#8 T8"]);
  expect(notes[0]).toContain("no Queue issue is configured");
  expect(nextJson(REPO, result).queue).toBeNull();
});

test("a Queue issue that cannot be read is refused, not read as empty", async () => {
  const { read } = reader({ ...BASE, "repos/johnrees/widget/contents/.github/agent-review.json?ref=main": config({ queue: { issue: 100 } }) });
  await expect(nextIssues(REPO, read)).rejects.toThrow("the Queue issue #100");
  const bad = reader({ ...BASE, "repos/johnrees/widget/contents/.github/agent-review.json?ref=main": config({ queue: { issue: "100" } }) });
  await expect(nextIssues(REPO, bad.read)).rejects.toThrow("queue.issue must be an issue number");
});

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** A fake GitHub with ready issues #7 and #8 and no blockers; `lag` hides posted comments from every read, as a list that never catches up. */
const claimWorld = ({ lag = false } = {}) => {
  const PATH = "/repos/johnrees/widget";
  const comments: Record<number, unknown[]> = { 7: [], 8: [] };
  let id = 500;
  const competitor = { id: 1, body: claimMarker({ v: 1, issue: 7, family: "codex", session: "fast", id: "fedcba9876543210" }), author_association: "OWNER", user: { login: "johnrees" }, html_url: "c1" };
  const routes: Record<string, (body: string, url: URL) => Response> = {
    [`GET ${PATH}`]: () => reply(200, { default_branch: "main" }),
    [`GET ${PATH}/pulls`]: () => reply(200, []),
    [`GET ${PATH}/issues`]: (_, url) => reply(200, url.searchParams.get("page") === "1" ? [issue(7), issue(8)] : []),
    [`GET ${PATH}/labels/claimed`]: () => reply(200, {}),
  };
  for (const number of [7, 8]) {
    routes[`GET ${PATH}/issues/${number}`] = () => reply(200, issue(number));
    routes[`GET ${PATH}/issues/${number}/dependencies/blocked_by`] = () => reply(200, []);
    routes[`GET ${PATH}/issues/${number}/comments`] = () => reply(200, lag ? [] : comments[number]);
    routes[`POST ${PATH}/issues/${number}/labels`] = () => reply(200, []);
    routes[`POST ${PATH}/issues/${number}/comments`] = (body) => {
      // On #7 a faster session's claim lands first.
      if (number === 7 && comments[7]?.length === 0) comments[7].push(competitor);
      const made = { id: id++, body: (JSON.parse(body) as { body: string }).body, author_association: "OWNER", user: { login: "johnrees" }, html_url: `c${id}` };
      comments[number]?.push(made);
      return reply(201, made);
    };
  }
  const fake = fakeGitHub(routes);
  stops.push(fake.stop);
  const printed: string[] = [];
  const io: ClaimIo = {
    api: fake.api, token: "t", repo: REPO, family: "claude", session: "slow",
    git: async () => ({ code: 1, stdout: "" }), print: (line) => printed.push(line), out: () => {}, sleep: async () => {}, nowMs: () => 0, recheckMs: 0,
  };
  return { io, printed, comments };
};

test("claim --next takes the first workable issue; after a lost race it tries the next", async () => {
  const { io, printed } = claimWorld();
  expect(await claimNext(io, apiReader(io), { refs: false, noPr: true })).toBe(0);
  expect(printed.filter((line) => line.startsWith("agent-gh: claiming"))).toEqual(["agent-gh: claiming #7 T7", "agent-gh: claiming #8 T8"]);
  expect(printed.some((line) => line.includes("#7 went to a claim comment by a codex session (fast) (c1) first"))).toBe(true);
  expect(printed.at(-1)).toContain("claimed #8 with a comment");
});

test("claim --next stops when a claim stands unconfirmed, rather than claiming another issue too", async () => {
  const { io, printed, comments } = claimWorld({ lag: true });
  expect(await claimNext(io, apiReader(io), { refs: false, noPr: true })).toBe(UNKNOWN);
  expect(printed.filter((line) => line.startsWith("agent-gh: claiming"))).toEqual(["agent-gh: claiming #7 T7"]);
  expect(comments[8]).toEqual([]);
});

test("a cycle is shown as the issues that block one another, not as a path", () => {
  const result = graph([node(1, [blocker(4)]), node(3, [blocker(1)]), node(2, [blocker(3)]), node(4, [blocker(2)])]);
  expect(wavesLines({ ...result, config: { issue: undefined, label: "ready", priorityLabels: [] }, queued: true }, () => {}).at(-1)).toBe("Cycle: #1, #2, #3, #4 block one another");
});

const high = { priority: { label: "priority:high", rank: 0 } };
const low = { priority: { label: "priority:low", rank: 2 } };

test("a queued low-priority issue still comes before an unqueued high one", () => {
  expect(graph([node(1, [], low), node(2, [], high)], [1]).waves[0]?.map((item) => [item.issue, item.priority])).toEqual([[1, "priority:low"], [2, "priority:high"]]);
});

test("among unqueued issues, a higher priority comes before one that unblocks more", () => {
  expect(graph([node(1, [], high), node(2, [], low), node(3, [blocker(2)])]).waves[0]?.map((item) => item.issue)).toEqual([1, 2]);
});

const prioritized = (priorityLabels?: string[]) =>
  reader({
    ...BASE,
    ...(priorityLabels === undefined ? {} : { "repos/johnrees/widget/contents/.github/agent-review.json?ref=main": config({ queue: { priority_labels: priorityLabels } }) }),
    "repos/johnrees/widget/issues?state=open&labels=ready": [issue(2, ["ready"]), issue(4, ["ready", "priority:medium", "P0"]), issue(6, ["ready", "priority:low", "priority:high"]), issue(8, ["ready", "P1"])],
    ...Object.fromEntries([2, 4, 6, 8].map((number) => [`repos/johnrees/widget/issues/${number}/comments`, []])),
  });

test("with no Queue, next orders by priority label, an issue with two taking the higher; the labels are configurable, and [] turns them off", async () => {
  const order = async (labels?: string[]) => {
    const result = await nextIssues(REPO, prioritized(labels).read);
    return frontier(result).map((item) => [item.issue, item.priority]);
  };
  expect(await order()).toEqual([[6, "priority:high"], [4, "priority:medium"], [2, null], [8, null]]);
  expect(await order(["P0", "P1"])).toEqual([[4, "P0"], [8, "P1"], [2, null], [6, null]]);
  expect(await order([])).toEqual([[2, null], [4, null], [6, null], [8, null]]);
  const result = await nextIssues(REPO, prioritized().read);
  expect(nextJson(REPO, result).issues[0]).toEqual({ issue: 6, title: "T6", priority: "priority:high", claim: null });
  expect(wavesLines(result, () => {})[1]).toBe("  #6 T6 (priority:high)");
  const bad = reader({ ...BASE, "repos/johnrees/widget/contents/.github/agent-review.json?ref=main": config({ queue: { priority_labels: "priority:high" } }) });
  await expect(nextIssues(REPO, bad.read)).rejects.toThrow("queue.priority_labels must be a list of label names");
});

test("next fails, rather than offer an issue, when a list it judges by cannot be read", async () => {
  const routes = {
    ...BASE,
    "repos/johnrees/widget/issues?state=open&labels=ready": [issue(7)],
    "repos/johnrees/widget/issues/7/dependencies/blocked_by": [issue(8, [])],
  };
  // Read whole, #7 waits on #8, so nothing is offered.
  expect(nextLines(await nextIssues(REPO, reader(routes).read), () => {})).not.toContain("#7 T7");
  for (const endpoint of [
    "repos/johnrees/widget/issues/7/dependencies/blocked_by",
    "repos/johnrees/widget/issues/7/comments",
    "repos/johnrees/widget/pulls?state=open",
    "repos/johnrees/widget/issues?state=open&labels=ready",
  ]) {
    await expect(nextIssues(REPO, reader({ ...routes, [endpoint]: NOT_FOUND }).read)).rejects.toThrow(`GET /${endpoint.split("?")[0]} gave no list`);
  }
});

test("a claim on a blocker that is not dispatched still shows in the waves", async () => {
  const { read } = reader({
    ...BASE,
    "repos/johnrees/widget/pulls?state=open": [{ number: 32, state: "open", body: `Closes #5.\n${claimMarker({ v: 1, issue: 5, family: "codex", session: "w", id: "0123456789abcdef" })}`, user: { login: "johnrees" }, head: { ref: "codex/5-x" } }],
    "repos/johnrees/widget/issues?state=open&labels=ready": [issue(4)],
    "repos/johnrees/widget/issues/4/dependencies/blocked_by": [issue(5, [])],
  });
  const result = await nextIssues(REPO, read);
  expect(wavesJson(REPO, result).waves[0]).toEqual({ wave: 1, issues: [expect.objectContaining({ issue: 5, claim: expect.objectContaining({ pr: 32, family: "codex" }) })] });
  expect(wavesLines(result, () => {})).toContain("  #5 T5 (unblocks 1; not dispatched; in progress: #32 by codex w)");
});

test("next reads every page of the open pull requests and of an issue's comments", async () => {
  const PATH = "/repos/johnrees/widget";
  const pages = <T>(items: readonly T[], url: URL) => {
    const size = Number(url.searchParams.get("per_page") ?? 30);
    const page = Number(url.searchParams.get("page") ?? 1);
    return items.slice((page - 1) * size, page * size);
  };
  const other = Array.from({ length: 100 }, (_, index) => ({ number: 100 + index, state: "open", body: "Unrelated", user: { login: "johnrees" }, head: { ref: `x-${index}` } }));
  const pulls = [...other, { number: 300, state: "open", body: `Closes #8.\n${claimMarker({ v: 1, issue: 8, family: "codex", session: "late", id: "0123456789abcdef" })}`, user: { login: "johnrees" }, head: { ref: "codex/8-x" } }];
  const chatter = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: "Noted", author_association: "OWNER", user: { login: "johnrees" } }));
  const comments = [...chatter, { id: 900, body: claimMarker({ v: 1, issue: 7, family: "glm", session: "late", id: "fedcba9876543210" }), author_association: "OWNER", user: { login: "johnrees" } }];
  const fake = fakeGitHub({
    [`GET ${PATH}`]: () => reply(200, { default_branch: "main" }),
    [`GET ${PATH}/pulls`]: (_, url) => reply(200, pages(pulls, url)),
    [`GET ${PATH}/issues`]: (_, url) => reply(200, pages([issue(7), issue(8)], url)),
    [`GET ${PATH}/issues/7/dependencies/blocked_by`]: () => reply(200, []),
    [`GET ${PATH}/issues/8/dependencies/blocked_by`]: () => reply(200, []),
    [`GET ${PATH}/issues/7/comments`]: (_, url) => reply(200, pages(comments, url)),
    [`GET ${PATH}/issues/8/comments`]: () => reply(200, []),
  });
  stops.push(fake.stop);
  const io = { api: fake.api, token: "t", repo: REPO };
  const result = await nextIssues(REPO, apiReader(io));
  // Each issue's claim is on its list's second page, so neither is offered.
  expect(nextLines(result, () => {})).toEqual(["No eligible issue: none is open, `ready`, unblocked, and unclaimed."]);
  expect(nextJson(REPO, result).issues.map((item) => [item.issue, item.claim?.kind, item.claim?.pr])).toEqual([[7, "comment", null], [8, "pr", 300]]);
});
