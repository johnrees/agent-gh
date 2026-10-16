import { afterEach, expect, test } from "bun:test";
import { type Claim, claimMarker, parseClaimArgs } from "../src/claim.ts";
import { type ClaimIo, UNKNOWN } from "../src/claim-run.ts";
import { type Blocker, frontier, labelFilter, type LabelRules, type Node, parseQueue, waves } from "../src/next.ts";
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

const NONE: LabelRules = { skip: [], require: [], fit: [] };

const blocker = (number: number, open = true, repo?: string): Blocker => ({ repo, number, open, title: `T${number}` });
const node = (number: number, blockers: Blocker[] = [], extra: Partial<Node> = {}): [number, Node] => [number, { number, title: `T${number}`, dispatched: true, blockers, claim: undefined, labels: [], ...extra }];
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
  expect(parseClaimArgs("next", [])).toEqual({ command: "next", json: false, waves: false, rules: NONE });
  expect(parseClaimArgs("next", ["--waves", "--json", "-R", "o/r"])).toEqual({ command: "next", json: true, waves: true, rules: NONE });
  expect(parseClaimArgs("next", ["7"])).toBeUndefined();
  expect(parseClaimArgs("claim", ["--next", "--no-pr"])).toEqual({ command: "claim-next", refs: false, noPr: true, rules: NONE });
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
    issues: [{ issue: 2, title: "T2", priority: null, labels: ["go"], claim: null }, { issue: 3, title: "T3", priority: null, labels: ["go"], claim: { kind: "pr", pr: 31, url: "", family: "codex", session: "t" } }],
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

/** A fake GitHub with ready issues #7, #8, and #9 and no blockers (`labels` replaces an issue's); `lag` hides posted comments from every read, as a list that never catches up. */
const claimWorld = ({ lag = false, labels = {} as Record<number, string[]> } = {}) => {
  const PATH = "/repos/johnrees/widget";
  const comments: Record<number, unknown[]> = { 7: [], 8: [], 9: [] };
  const ready = [7, 8, 9].map((number) => issue(number, labels[number] ?? ["ready"]));
  let id = 500;
  const competitor = { id: 1, body: claimMarker({ v: 1, issue: 7, family: "codex", session: "fast", id: "fedcba9876543210" }), author_association: "OWNER", user: { login: "johnrees" }, html_url: "c1" };
  const routes: Record<string, (body: string, url: URL) => Response> = {
    [`GET ${PATH}`]: () => reply(200, { default_branch: "main" }),
    [`GET ${PATH}/pulls`]: () => reply(200, []),
    [`GET ${PATH}/issues`]: (_, url) => reply(200, url.searchParams.get("page") === "1" ? ready : []),
    [`GET ${PATH}/labels/claimed`]: () => reply(200, {}),
  };
  for (const number of [7, 8, 9]) {
    routes[`GET ${PATH}/issues/${number}`] = () => reply(200, issue(number, labels[number] ?? ["ready"]));
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
  expect(wavesLines({ ...result, config: { issue: undefined, label: "ready", priorityLabels: [], skipLabels: [] }, queued: true }, () => {}).at(-1)).toBe("Cycle: #1, #2, #3, #4 block one another");
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
  expect(nextJson(REPO, result).issues[0]).toEqual({ issue: 6, title: "T6", priority: "priority:high", labels: ["priority:high", "priority:low", "ready"], claim: null });
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

// Label output and filters.

const SKIP_HUMAN = { skip: ["needs-human"], require: [], fit: [] } satisfies LabelRules;

test("labelFilter skips by an exact label and by a * pattern, naming the label and the rule", () => {
  expect(labelFilter(["ready", "needs-human"], SKIP_HUMAN)).toEqual({ rule: "--skip-label", pattern: "needs-human", label: "needs-human" });
  expect(labelFilter(["ready", "model:redteam"], { ...NONE, skip: ["model:*"] })).toEqual({ rule: "--skip-label", pattern: "model:*", label: "model:redteam" });
  expect(labelFilter(["ready", "needs-humans"], SKIP_HUMAN)).toBeUndefined();
  expect(labelFilter([], SKIP_HUMAN)).toBeUndefined();
  expect(labelFilter(["needs-human"], { ...NONE, configured: ["needs-*"] })).toEqual({ rule: "queue.skip_labels", pattern: "needs-*", label: "needs-human" });
});

test("labelFilter requires every pattern to match some label", () => {
  const rules = { ...NONE, require: ["ready", "effort:*"] };
  expect(labelFilter(["ready", "effort:low", "x"], rules)).toBeUndefined();
  expect(labelFilter(["ready"], rules)).toEqual({ rule: "--require-label", pattern: "effort:*", label: null });
  expect(labelFilter(["effort:low"], rules)).toEqual({ rule: "--require-label", pattern: "ready", label: null });
});

test("labelFilter's fit drops an issue only for another label in the pattern's group", () => {
  const fit = { ...NONE, fit: ["model:sonnet-*"] };
  expect(labelFilter([], fit)).toBeUndefined();
  expect(labelFilter(["ready", "bug"], fit)).toBeUndefined();
  expect(labelFilter(["model:sonnet-luna"], fit)).toBeUndefined();
  expect(labelFilter(["model:sonnet-luna", "effort:max"], fit)).toBeUndefined();
  for (const other of ["model:opus-sol", "model:fable-astra", "model:redteam"]) {
    expect(labelFilter(["ready", other], fit)).toEqual({ rule: "--fit-label", pattern: "model:sonnet-*", label: other });
  }
  // Each pattern judges on its own.
  expect(labelFilter(["effort:max", "model:sonnet-luna"], { ...NONE, fit: ["model:sonnet-*", "effort:low"] })).toMatchObject({ pattern: "effort:low", label: "effort:max" });
  expect(() => labelFilter(["ready"], { ...NONE, fit: ["sonnet-*"] })).toThrow('needs a ":"');
});

test("a skipped issue still blocks its dependents and counts in unblocks; it is listed as skipped", () => {
  const skipped = { rule: "queue.skip_labels", pattern: "needs-human", label: "needs-human" };
  const result = graph([node(1, [], { skipped, labels: ["ready", "needs-human"] }), node(2, [blocker(1)]), node(3, [], { labels: ["b", "a"] })]);
  expect(numbers(result)).toEqual([[1, 3], [2]]);
  expect(result.waves[0]?.map((item) => [item.issue, item.state])).toEqual([[1, "skipped"], [3, "workable"]]);
  expect(result.waves[0]?.[0]).toMatchObject({ unblocks: 1, skipped_by: skipped, labels: ["needs-human", "ready"] });
  expect(result.waves[1]?.[0]).toMatchObject({ issue: 2, state: "waiting", waiting_on: ["#1"], skipped_by: null });
  // A filtered issue behind a blocker is skipped too, in its own wave, still waiting on the blocker.
  const later = graph([node(1), node(2, [blocker(1)], { skipped })]);
  expect(later.waves[1]?.[0]).toMatchObject({ issue: 2, state: "skipped", skipped_by: skipped, waiting_on: ["#1"] });
  expect(frontier(later).map((item) => item.issue)).toEqual([1]);
  expect(result.waves[0]?.[1]).toMatchObject({ skipped_by: null, labels: ["a", "b"] });
  expect(frontier(result).map((item) => item.issue)).toEqual([3]);
});

test("next --json carries sorted labels; queue.skip_labels from the default branch merges with the flags", async () => {
  const { read } = reader({
    ...BASE,
    "repos/johnrees/widget/contents/.github/agent-review.json?ref=main": config({ queue: { skip_labels: ["needs-human", "ready-for-*"] } }),
    "repos/johnrees/widget/issues?state=open&labels=ready": [
      issue(2, ["ready", "needs-human"]), issue(3, ["ready", "model:opus-sol"]), issue(4, ["ready", "model:sonnet-luna", "bug"]), issue(5, ["ready"]), issue(6, ["ready", "ready-for-human"]), issue(7, ["ready"]),
    ],
    "repos/johnrees/widget/issues/7/dependencies/blocked_by": [issue(2, [])],
    ...Object.fromEntries([2, 3, 4, 5, 6, 7].map((number) => [`repos/johnrees/widget/issues/${number}/comments`, []])),
  });
  const result = await nextIssues(REPO, read, { skip: [], require: [], fit: ["model:sonnet-*"] });
  expect(nextJson(REPO, result).issues).toEqual([
    { issue: 4, title: "T4", priority: null, labels: ["bug", "model:sonnet-luna", "ready"], claim: null },
    { issue: 5, title: "T5", priority: null, labels: ["ready"], claim: null },
  ]);
  const notes: string[] = [];
  expect(nextLines(result, (line) => notes.push(line))).toEqual(["#4 T4", "#5 T5"]);
  expect(notes.filter((line) => line.startsWith("agent-gh: skipped"))).toEqual([
    "agent-gh: skipped #2 T2: carries needs-human (queue.skip_labels)",
    "agent-gh: skipped #3 T3: carries model:opus-sol (--fit-label model:sonnet-*)",
    "agent-gh: skipped #6 T6: carries ready-for-human (queue.skip_labels)",
  ]);
  const json = wavesJson(REPO, result);
  expect(json.waves[0]?.issues.filter((item) => item.state === "skipped").map((item) => [item.issue, item.skipped_by])).toEqual([
    [2, { rule: "queue.skip_labels", pattern: "needs-human", label: "needs-human" }],
    [3, { rule: "--fit-label", pattern: "model:sonnet-*", label: "model:opus-sol" }],
    [6, { rule: "queue.skip_labels", pattern: "ready-for-*", label: "ready-for-human" }],
  ]);
  // #7 still waits on the skipped #2.
  expect(json.waves[1]?.issues).toEqual([expect.objectContaining({ issue: 7, state: "waiting", waiting_on: ["#2"] })]);
  expect(json.waves[0]?.issues.find((item) => item.issue === 2)?.unblocks).toBe(1);
  expect(wavesLines(result, () => {})).toContain("  #2 T2 (unblocks 1; skipped: carries needs-human (queue.skip_labels))");
});

test("a skip_labels that is not a list of non-empty strings is refused", async () => {
  for (const bad of ["needs-human", [1], [""], ["a", " "]]) {
    const { read } = reader({ ...BASE, "repos/johnrees/widget/contents/.github/agent-review.json?ref=main": config({ queue: { skip_labels: bad } }) });
    await expect(nextIssues(REPO, read)).rejects.toThrow("queue.skip_labels must be a list of label patterns");
  }
  const none = reader({ ...BASE, "repos/johnrees/widget/contents/.github/agent-review.json?ref=main": config({ queue: { skip_labels: [] } }) });
  await expect(nextIssues(REPO, none.read)).resolves.toBeDefined();
});

test("next and claim --next parse the three label flags, repeatable, with a pattern after a space or an =", () => {
  expect(parseClaimArgs("next", ["--skip-label", "needs-human", "--skip-label=model:*", "--require-label", "ready", "--fit-label", "model:sonnet-*", "--json"])).toEqual({
    command: "next", json: true, waves: false, rules: { skip: ["needs-human", "model:*"], require: ["ready"], fit: ["model:sonnet-*"] },
  });
  expect(parseClaimArgs("claim", ["--next", "--fit-label=model:sonnet-*", "-R", "o/r", "--refs"])).toEqual({
    command: "claim-next", refs: true, noPr: false, rules: { skip: [], require: [], fit: ["model:sonnet-*"] },
  });
  // A flag with no pattern, a blank or flag-like one, and a fit pattern with no ":" are refused.
  for (const args of [["--skip-label"], ["--skip-label", ""], ["--skip-label", "  "], ["--require-label="], ["--skip-label", "--json"], ["--fit-label", "sonnet-*"], ["--fit-label=x"], ["--json", "--fit-label"]]) {
    expect(parseClaimArgs("next", args)).toBeUndefined();
  }
  expect(parseClaimArgs("claim", ["--next", "--skip-label"])).toBeUndefined();
  // Only the pickers take them.
  expect(parseClaimArgs("claim", ["7", "--skip-label", "x"])).toBeUndefined();
  expect(parseClaimArgs("claims", ["--skip-label", "x"])).toBeUndefined();
  expect(parseClaimArgs("release", ["7", "--skip-label", "x"])).toBeUndefined();
});

test("claim --next passes over a skipped first candidate and claims the next one", async () => {
  const { io, printed, comments } = claimWorld({ labels: { 7: ["ready", "needs-human"] } });
  const rules = { skip: ["needs-human"], require: [], fit: [] };
  expect(await claimNext(io, apiReader(io), { refs: false, noPr: true, rules })).toBe(0);
  expect(printed.filter((line) => line.startsWith("agent-gh: claiming"))).toEqual(["agent-gh: claiming #8 T8"]);
  expect(printed).toContain("agent-gh: skipped #7 T7: carries needs-human (--skip-label needs-human)");
  expect(comments[7]).toEqual([]);
  // Without the filter, #7 is first.
  const plain = claimWorld({ labels: { 7: ["ready", "needs-human"] } });
  await claimNext(plain.io, apiReader(plain.io), { refs: false, noPr: true });
  expect(plain.printed.filter((line) => line.startsWith("agent-gh: claiming"))[0]).toBe("agent-gh: claiming #7 T7");
});

test("claim --next filters again on the retry after a lost race", async () => {
  // #7 goes to a faster session; #8 is not for this session; the retry offers #9.
  const { io, printed, comments } = claimWorld({ labels: { 8: ["ready", "model:opus-sol"] } });
  const rules = { skip: [], require: [], fit: ["model:sonnet-*"] };
  expect(await claimNext(io, apiReader(io), { refs: false, noPr: true, rules })).toBe(0);
  expect(printed.filter((line) => line.startsWith("agent-gh: claiming"))).toEqual(["agent-gh: claiming #7 T7", "agent-gh: claiming #9 T9"]);
  expect(comments[8]).toEqual([]);
  expect(printed.at(-1)).toContain("claimed #9 with a comment");
});

test("next --waves --json shows a filtered issue behind a blocker as skipped, with its reason and what it waits on", async () => {
  const { read } = reader({
    ...BASE,
    "repos/johnrees/widget/issues?state=open&labels=ready": [issue(1), issue(2, ["ready", "needs-human"])],
    "repos/johnrees/widget/issues/2/dependencies/blocked_by": [issue(1, [])],
    "repos/johnrees/widget/issues/1/comments": [],
    "repos/johnrees/widget/issues/2/comments": [],
  });
  const result = await nextIssues(REPO, read, { skip: ["needs-human"], require: [], fit: [] });
  expect(wavesJson(REPO, result).waves[1]).toEqual({
    wave: 2,
    issues: [expect.objectContaining({ issue: 2, state: "skipped", waiting_on: ["#1"], skipped_by: { rule: "--skip-label", pattern: "needs-human", label: "needs-human" } })],
  });
  expect(frontier(result).map((item) => item.issue)).toEqual([1]);
});
