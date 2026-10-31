import { afterEach, expect, test } from "bun:test";
import { claimMarker } from "../src/claim.ts";
import { type Registry, REGISTRY } from "../src/config.ts";
import { Failure } from "../src/failure.ts";
import { commitWorkers, delegatedWaiver, parseReviewConfig, waiveMarker } from "../src/review.ts";
import { gateReady, type ReviewIo } from "../src/review-run.ts";
import { waiveCommand } from "../src/waive-run.ts";
import { fakeGitHub, reply } from "./fake-github.ts";

// A delegated waiver (#110): the orchestrator's label counts with its `Waived:` comment for the head, never a worker's.

const HEAD = "a".repeat(40);
const PUSHED = "c".repeat(40);
const REPO = "/repos/johnrees/widget";
const ORCH_ID = 990001;
const CLAUDE_ID = REGISTRY.claude?.app_id as number;
/** apps.json with the orchestrator's App, which John creates (`agent-gh setup orchestrator`). */
const REGISTRY_WITH: Registry = { ...REGISTRY, orchestrator: { slug: "johnrees-orchestrator", app_id: ORCH_ID, client_id: "Iv23liORCH", bot_user_id: 990002 } };
const ORCH = { id: ORCH_ID, slug: "johnrees-orchestrator" };
const CLAUDE = { id: CLAUDE_ID, slug: "johnrees-claude" };
const WORKER = "worker-session";
const CONFIG = { reviewers: { codex: { model: "m" } }, waiver_label: "review-waived", waiver_by: ["orchestrator"] };

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const labeled = (app: unknown) => ({ event: "labeled", label: { name: "review-waived" }, actor: { login: "johnrees" }, performed_via_github_app: app });
const waivedComment = (app: unknown, head: string, extra: Record<string, unknown> = {}) => ({
  id: 80,
  user: { login: "johnrees" },
  performed_via_github_app: app,
  created_at: "2026-10-31T10:00:00Z",
  updated_at: "2026-10-31T10:00:00Z",
  html_url: "https://github.com/johnrees/widget/pull/12#issuecomment-80",
  body: `Waived: independent Fable review, bun test passed at the head\n\n${waiveMarker({ v: 1, head, session: "orch-session" })}`,
  ...extra,
});
/** A claude worker's claim pull request: its commits credit johnrees-claude and name the worker's session. */
const CLAIM_BODY = `Closes #7.\n\n${claimMarker({ v: 1, issue: 7, family: "claude", session: WORKER, id: "0123456789abcdef" })}`;
const WORKER_COMMIT = { commit: { message: `Do it\n\nAgent-Session: ${WORKER}\nCo-authored-by: johnrees-claude[bot] <1+johnrees-claude[bot]@users.noreply.github.com>` } };

type World = { head?: string; config?: unknown; events?: unknown[]; comments?: unknown[]; labels?: string[]; session?: string; family?: string; openedVia?: unknown };

const world = ({ head = HEAD, config = CONFIG, events = [], comments = [], labels = ["review-waived"], session = "orch-session", family = "orchestrator", openedVia = CLAUDE }: World = {}) => {
  const posts = [...comments];
  const timeline = [...events];
  const acting = family === "orchestrator" ? ORCH : CLAUDE;
  // The label is on as its last event left it, else as the scenario says.
  const current = () => {
    const last = timeline.at(-1) as { event: string } | undefined;
    return last === undefined ? labels : last.event === "labeled" ? ["review-waived"] : [];
  };
  const fake = fakeGitHub({
    [`GET ${REPO}/pulls/12`]: () =>
      reply(200, { state: "open", title: "Do it", body: CLAIM_BODY, head: { sha: head }, base: { ref: "main" }, labels: current().map((name) => ({ name })), created_at: "2026-10-30T00:00:00Z", user: { login: "johnrees", type: "User" } }),
    [`GET ${REPO}/contents/.github/agent-review.json`]: () => reply(200, { content: Buffer.from(JSON.stringify(config)).toString("base64") }),
    [`GET ${REPO}/commits/${head}/status`]: () => reply(200, { state: "pending", total_count: 0, statuses: [] }),
    [`GET ${REPO}/issues/12`]: () => reply(200, { performed_via_github_app: openedVia }),
    [`GET ${REPO}/issues/12/events`]: () => reply(200, timeline),
    [`GET ${REPO}/pulls/12/commits`]: () => reply(200, [WORKER_COMMIT]),
    [`GET ${REPO}/issues/12/comments`]: () => reply(200, posts),
    [`POST ${REPO}/issues/12/comments`]: (body) => {
      posts.push({ ...waivedComment(acting, head), body: (JSON.parse(body) as { body: string }).body });
      return reply(201, {});
    },
    // GitHub records a labeled event only for a label that was not on already.
    [`POST ${REPO}/issues/12/labels`]: () => {
      if (!timeline.some((event) => (event as { event: string }).event === "labeled") || (timeline.at(-1) as { event: string }).event === "unlabeled") timeline.push(labeled(acting));
      return reply(200, []);
    },
    [`DELETE ${REPO}/issues/12/labels/review-waived`]: () => {
      timeline.push({ ...labeled(acting), event: "unlabeled" });
      return reply(200, []);
    },
    [`GET ${REPO}`]: () => reply(200, { default_branch: "main", owner: { login: "johnrees" } }),
    "POST /graphql": () => reply(200, { data: { repository: { pullRequest: { closingIssuesReferences: { totalCount: 0, nodes: [] } } } } }),
  });
  stops.push(fake.stop);
  const printed: string[] = [];
  const io: ReviewIo = {
    api: fake.api, token: "ghu_test", repo: { owner: "johnrees", name: "widget" }, registry: REGISTRY_WITH, family, session,
    git: async () => undefined,
    runCheck: async () => ({ code: 0, output: "", timedOut: false }),
    runReviewer: async () => ({ code: 0, stdout: "" }),
    readFile: async () => "",
    tempDir: () => "/nonexistent",
    print: (line) => printed.push(line),
    out: () => {},
    sleep: async () => {},
  };
  return { fake, io, printed };
};

const refusal = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof Failure) return error.detail;
    throw error;
  }
  throw new Error("expected a refusal");
};

test("waiver_by defaults to none, takes the orchestrator, and refuses a model family, whose App is its own workers'", () => {
  const base = { reviewers: { codex: { model: "m" } } };
  expect(parseReviewConfig(JSON.stringify(base)).waiverBy).toEqual([]);
  expect(parseReviewConfig(JSON.stringify({ ...base, waiver_by: ["orchestrator"] })).waiverBy).toEqual(["orchestrator"]);
  // With "claude" listed, a claude worker could strip its claim, commit with --no-verify, and waive its own pull request.
  for (const bad of [["claude"], ["orchestrator", "codex"], ["read"], "orchestrator", [1]]) expect(() => parseReviewConfig(JSON.stringify({ ...base, waiver_by: bad }))).toThrow(Failure);
});

test("the gate passes on the orchestrator's label with its Waived: comment for the head", async () => {
  const w = world({ events: [labeled(ORCH)], comments: [waivedComment(ORCH, HEAD)] });
  await gateReady(w.io, { number: 12 });
  // The Waived: comment came through an agent App, so it waits for no answer either.
  expect(w.printed).toEqual(["agent-gh: the review of #12 was waived by orchestrator at aaaaaaaa: independent Fable review, bun test passed at the head"]);
});

test("the orchestrator's label without its comment, after a push, or under the default config waives nothing", async () => {
  for (const scenario of [
    { events: [labeled(ORCH)] },
    // A push moves the head past the one the comment waived.
    { head: PUSHED, events: [labeled(ORCH)], comments: [waivedComment(ORCH, HEAD)] },
    // Any agent, acting as John, could edit the comment to name a new head.
    { events: [labeled(ORCH)], comments: [waivedComment(ORCH, HEAD, { updated_at: "2026-10-31T11:00:00Z" })] },
    // The comment must come through the App that added the label.
    { events: [labeled(ORCH)], comments: [waivedComment(CLAUDE, HEAD)] },
    // The reason is the evidence: a bare `Waived:` gives none.
    { events: [labeled(ORCH)], comments: [{ ...waivedComment(ORCH, HEAD), body: `Waived:\n\n${waiveMarker({ v: 1, head: HEAD, session: "orch-session" })}` }] },
    // Nor does the marker on the same line pass for one.
    { events: [labeled(ORCH)], comments: [{ ...waivedComment(ORCH, HEAD), body: `Waived: ${waiveMarker({ v: 1, head: HEAD, session: "orch-session" })}` }] },
    // With no waiver_by, only a person's label counts, as before.
    { config: { ...CONFIG, waiver_by: undefined }, events: [labeled(ORCH)], comments: [waivedComment(ORCH, HEAD)] },
  ]) {
    expect(await refusal(gateReady(world(scenario).io, { number: 12 }))).toContain("has no agent-review status");
  }
});

test("a worker never waives its own pull request", async () => {
  // A worker family's label and comment count for nothing: waiver_by cannot list it.
  const w = world({ events: [labeled(CLAUDE)], comments: [waivedComment(CLAUDE, HEAD)] });
  expect(await refusal(gateReady(w.io, { number: 12 }))).toContain("has no agent-review status");
  // Nor does the orchestrator's on a pull request it opened.
  const opened = world({ openedVia: ORCH, events: [labeled(ORCH)], comments: [waivedComment(ORCH, HEAD)] });
  expect(await refusal(gateReady(opened.io, { number: 12 }))).toContain("has no agent-review status");
  // Nor does the orchestrator's App when the comment's session is the worker's.
  const own = world({ events: [labeled(ORCH)], comments: [{ ...waivedComment(ORCH, HEAD), body: `Waived: mine\n\n${waiveMarker({ v: 1, head: HEAD, session: WORKER })}` }] });
  expect(await refusal(gateReady(own.io, { number: 12 }))).toContain("has no agent-review status");
});

test("agent-gh waive posts the Waived: comment for the head, then the label, and the gate then passes", async () => {
  const w = world({ labels: [], comments: [] });
  await waiveCommand(w.io, { pr: 12, reason: "Fable reviewed it; bun test passed at the head" });
  const posts = w.fake.log.filter((entry) => entry.method === "POST" && entry.path.startsWith(`${REPO}/issues/12/`));
  expect(posts.map((entry) => entry.path)).toEqual([`${REPO}/issues/12/comments`, `${REPO}/issues/12/labels`]);
  expect((JSON.parse(posts[0]?.body ?? "{}") as { body: string }).body).toStartWith("Waived: Fable reviewed it; bun test passed at the head\n");
  expect(JSON.parse(posts[1]?.body ?? "{}")).toEqual({ labels: ["review-waived"] });
  await gateReady(w.io, { number: 12 });
  expect(w.printed.at(-1)).toBe("agent-gh: the review of #12 was waived by orchestrator at aaaaaaaa: Fable reviewed it; bun test passed at the head");
});

test("agent-gh waive takes off a waiver label a worker added, so the label it adds is the orchestrator's", async () => {
  const w = world({ events: [labeled(CLAUDE)], comments: [] });
  await waiveCommand(w.io, { pr: 12, reason: "re-tested at the head" });
  const writes = w.fake.log.filter((entry) => entry.method !== "GET" && entry.path.startsWith(`${REPO}/issues/12/`)).map((entry) => `${entry.method} ${entry.path}`);
  expect(writes).toEqual([`POST ${REPO}/issues/12/comments`, `DELETE ${REPO}/issues/12/labels/review-waived`, `POST ${REPO}/issues/12/labels`]);
  await gateReady(w.io, { number: 12 });
  expect(w.printed.at(-1)).toBe("agent-gh: the review of #12 was waived by orchestrator at aaaaaaaa: re-tested at the head");
});

test("agent-gh waive refuses a worker, an identity waiver_by does not list, and an empty reason, posting nothing", async () => {
  const cases: [World, string][] = [
    [{ session: WORKER }, "this session (worker-session) worked on pull request #12"],
    [{ openedVia: ORCH }, "orchestrator worked on pull request #12"],
    [{ config: { ...CONFIG, waiver_by: [] } }, "does not list orchestrator in waiver_by"],
  ];
  for (const [scenario, why] of cases) {
    const w = world(scenario);
    expect(await refusal(waiveCommand(w.io, { pr: 12, reason: "looked fine" }))).toContain(why);
    expect(w.fake.log.some((entry) => entry.method === "POST")).toBe(false);
  }
  expect(await refusal(waiveCommand(world().io, { pr: 12, reason: " " }))).toContain("--reason needs the evidence");
});

test("delegatedWaiver and commitWorkers: the comment's author and marker must match, and credits are read from every line", () => {
  const delegate = { name: "orchestrator", id: ORCH_ID };
  const comment = { appId: ORCH_ID, author: "johnrees", createdAt: "t", updatedAt: "t", body: `Waived: ok\n\n${waiveMarker({ v: 1, head: HEAD, session: "s" })}` };
  const none = { identities: [], sessions: [] };
  expect(delegatedWaiver({ login: "johnrees", appId: ORCH_ID }, delegate, HEAD, [comment], none)).toBe("orchestrator at aaaaaaaa: ok");
  expect(delegatedWaiver({ login: "johnrees", appId: ORCH_ID }, delegate, HEAD, [{ ...comment, author: "someone" }], none)).toBeUndefined();
  expect(delegatedWaiver({ login: "johnrees", appId: ORCH_ID }, delegate, HEAD, [{ ...comment, body: `ok\n${waiveMarker({ v: 1, head: HEAD, session: "s" })}` }], none)).toBeUndefined();
  expect(delegatedWaiver({ login: "johnrees", appId: ORCH_ID }, delegate, HEAD, [comment], { identities: ["orchestrator"], sessions: [] })).toBeUndefined();
  expect(commitWorkers([WORKER_COMMIT.commit.message, "x\n\nCo-authored-by: johnrees-orchestrator[bot] <x>"], { claude: "johnrees-claude[bot]", orchestrator: "johnrees-orchestrator[bot]" })).toEqual({
    identities: ["claude", "orchestrator"],
    sessions: [WORKER],
  });
});
