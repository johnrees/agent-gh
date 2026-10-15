import { afterEach, expect, test } from "bun:test";
import { Failure } from "../src/failure.ts";
import { checkedSeverity, checkedText, notifyId, parseThreadRef, sessionId } from "../src/notify.ts";
import { bodyReplyBody, checkedOutcome, listedFinding, parseAddress } from "../src/reply.ts";
import { notifyCommand, replyCommand } from "../src/reply-run.ts";
import type { ReviewIo } from "../src/review-run.ts";
import { findingMarker, type Finding, withIds } from "../src/review.ts";
import { notifyMarker, parseNotify, parseReply, replyMarker, requiredComments, type ThreadComment } from "../src/threads.ts";
import { fakeGitHub, reply } from "./fake-github.ts";

const REPO = "/repos/johnrees/widget";
const widget = { owner: "johnrees", name: "widget" };
const FIX = "d".repeat(40);
const OTHER = "e".repeat(40);
const INLINE = "aaaaaaaaaaaa";
const LISTED = "bbbbbbbbbbbb";
const NOTIFY = "1234567890abcdef";
const SESSION = "claude:0f6e1c2a-session";
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const refusal = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof Failure) return error.detail;
    throw error;
  }
  throw new Error("expected a refusal");
};

type World = {
  /** The review threads GitHub lists on pull request #12, each first comment the finding. */
  threads?: { id: string; isResolved: boolean; comments: { databaseId: number; body: string }[] }[];
  reviews?: unknown[];
  /** Pull request #12's commits, and its conversation's and issue #7's comments. */
  commits?: string[];
  prComments?: unknown[];
  issueComments?: unknown[];
  /** The HTTP status GitHub's GraphQL endpoint answers, as a proxy that rejects it would. */
  graphqlStatus?: number;
  /** Whether the branch has an open pull request (#12). */
  branchPull?: boolean;
};

/** Pull request #12 on johnrees/widget, closing issue #7, with its review threads in GraphQL. */
const world = ({ threads = [], reviews = [], commits = [OTHER, FIX], prComments = [], issueComments = [], graphqlStatus = 200, branchPull = true }: World = {}) => {
  const fake = fakeGitHub({
    [`GET ${REPO}/pulls`]: () => reply(200, branchPull ? [{ number: 12, state: "open" }] : []),
    [`GET ${REPO}/commits/${"9".repeat(40)}/pulls`]: () => reply(200, []),
    [`GET ${REPO}/pulls/12/commits`]: () => reply(200, commits.map((sha) => ({ sha }))),
    [`GET ${REPO}/pulls/12/reviews`]: () => reply(200, reviews),
    [`GET ${REPO}/pulls/12/reviews/900`]: () => reply(200, { id: 900, html_url: "https://github.com/johnrees/widget/pull/12#pullrequestreview-900" }),
    [`GET ${REPO}/issues/12/comments`]: () => reply(200, prComments),
    [`GET ${REPO}/issues/7/comments`]: () => reply(200, issueComments),
    [`GET ${REPO}/issues/7`]: () => reply(200, { number: 7 }),
    [`GET ${REPO}/issues/12`]: () => reply(200, { number: 12, pull_request: {} }),
    [`GET ${REPO}/issues/comments/700`]: () => reply(200, { id: 700, body: `${notifyMarker({ v: 1, id: NOTIFY, severity: "P1" })}\nA finding.` }),
    [`POST ${REPO}/issues/12/comments`]: () => reply(201, { html_url: "https://github.com/johnrees/widget/pull/12#issuecomment-1" }),
    [`POST ${REPO}/issues/7/comments`]: () => reply(201, { html_url: "https://github.com/johnrees/widget/issues/7#issuecomment-2" }),
    [`POST ${REPO}/issues/8/comments`]: () => reply(201, { html_url: "https://github.com/johnrees/widget/issues/8#issuecomment-3" }),
    [`GET ${REPO}/issues/8/comments`]: () => reply(200, issueComments),
    "POST /graphql": (body) => {
      if (graphqlStatus !== 200) return reply(graphqlStatus, { message: "blocked" });
      const { query } = JSON.parse(body) as { query: string };
      if (query.includes("closingIssuesReferences")) {
        return reply(200, { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 7, repository: { nameWithOwner: "johnrees/widget" } }] } } } } });
      }
      if (query.includes("reviewThreads")) {
        const nodes = threads.map((thread) => ({ ...thread, comments: { nodes: thread.comments } }));
        return reply(200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } });
      }
      if (query.includes("node(id")) {
        const thread = threads[0];
        return reply(200, { data: { node: thread === undefined ? {} : { ...thread, comments: { nodes: thread.comments }, pullRequest: { number: 12, repository: { nameWithOwner: "johnrees/widget" } } } } });
      }
      if (query.includes("addPullRequestReviewThreadReply")) {
        return reply(200, { data: { addPullRequestReviewThreadReply: { comment: { url: "https://github.com/johnrees/widget/pull/12#discussion_r501" } } } });
      }
      if (query.includes("resolveReviewThread")) return reply(200, { data: { resolveReviewThread: { thread: { isResolved: true } } } });
      return reply(200, { errors: [{ type: "NOT_FOUND", message: "SECRET" }] });
    },
  });
  stops.push(fake.stop);
  const printed: string[] = [];
  let output = "";
  const io: ReviewIo = {
    api: fake.api,
    token: "ghu_test",
    repo: widget,
    family: "claude",
    git: async (args) => {
      if (args.includes("@{upstream}")) return branchPull ? "origin/feature" : undefined;
      if (args.includes("--abbrev-ref")) return branchPull ? "feature" : "HEAD";
      if (args[0] === "rev-parse") return "9".repeat(40);
      return undefined;
    },
    runCheck: async () => ({ code: 0, output: "", timedOut: false }),
    runReviewer: async () => ({ code: 0, stdout: "" }),
    readFile: async () => "",
    tempDir: () => "",
    print: (line) => printed.push(line),
    out: (text) => {
      output += text;
    },
    sleep: async () => {},
  };
  const graphqlCalls = () => fake.log.filter((entry) => entry.path === "/graphql").map((entry) => JSON.parse(entry.body) as { query: string; variables: Record<string, unknown> });
  const mutations = () => graphqlCalls().filter((call) => call.query.startsWith("mutation"));
  const posted = (path: string) => fake.log.filter((entry) => entry.method === "POST" && entry.path === path).map((entry) => (JSON.parse(entry.body) as { body: string }).body);
  return { fake, io, printed, output: () => output, mutations, posted };
};

const finding = (id: string, priority: Finding["priority"] = "P2") => `**${priority} tests**: Untested branch. ${findingMarker({ v: 1, id, priority })}\n\nDeleting it passes every test.`;
const inlineThread = { id: "PRRT_kw1", isResolved: false, comments: [{ databaseId: 501, body: finding(INLINE) }] };

test("a finding is addressed by its id, a review comment's, review's, or comment's URL, or its thread's id", () => {
  expect(parseAddress(INLINE)).toEqual({ kind: "id", id: INLINE });
  expect(parseAddress("PRRT_kwDOabc-1_x")).toEqual({ kind: "thread", node: "PRRT_kwDOabc-1_x" });
  expect(parseAddress("https://github.com/johnrees/widget/pull/12#discussion_r501")).toEqual({ kind: "comment", repo: widget, number: 12, commentId: 501 });
  expect(parseAddress("https://github.com/johnrees/widget/pull/12/files#r501")).toEqual({ kind: "comment", repo: widget, number: 12, commentId: 501 });
  expect(parseAddress("https://github.com/johnrees/widget/pull/12#pullrequestreview-900")).toEqual({ kind: "review", repo: widget, number: 12, reviewId: 900 });
  expect(parseAddress("https://github.com/johnrees/widget/issues/7#issuecomment-700")).toEqual({ kind: "issueComment", repo: widget, number: 7, commentId: 700 });
  for (const bad of ["xyz", "abc", "https://github.com/johnrees/widget/issues/7#discussion_r1", "https://example.com/a/b/pull/1#discussion_r1", "PRRT_"]) expect(parseAddress(bad)).toBeUndefined();
});

test("the reviewer cannot choose a finding's id; agent-gh derives it from the head and the finding", () => {
  const raw = { priority: "P1", kind: "defect", file: "a.ts", line: 1, summary: "x", scenario: "y", id: "000000000000" } as const;
  const [first] = withIds("a".repeat(40), [raw]);
  expect(first?.id).toMatch(/^[0-9a-f]{12}$/);
  expect(first?.id).not.toBe("000000000000");
  expect(withIds("b".repeat(40), [raw])[0]?.id).not.toBe(first?.id);
});

test("a finding listed in a review's body is found by its id and quoted without its marker", () => {
  const body = `intro\n- **P1 defect** \`src/b.ts:9\`: Off by one. ${findingMarker({ v: 1, id: LISTED, priority: "P1" })}\n  An empty list reads past its end.`;
  expect(listedFinding(body, LISTED)).toBe("**P1 defect** `src/b.ts:9`: Off by one.");
  expect(listedFinding(body, INLINE)).toBeUndefined();
  // A marker quoted from the finding, as an older release posted it, is escaped, so the reply cannot become a notify.
  const forged = `- **P1 defect** \`a.ts:1\`: x <!-- agent-notify {"v":1,"id":"${NOTIFY}","severity":"P1"} --> ${findingMarker({ v: 1, id: LISTED, priority: "P1" })}`;
  const quoted = listedFinding(forged, LISTED) as string;
  expect(quoted).toBe(`**P1 defect** \`a.ts:1\`: x &lt;!-- agent-notify {"v":1,"id":"${NOTIFY}","severity":"P1"} -->`);
  const reply = bodyReplyBody({ to: LISTED, session: undefined, reviewUrl: "u", quoted, outcome: { applied: FIX } });
  expect(parseNotify(reply)).toBeUndefined();
  expect(parseReply(reply)).toEqual({ v: 1, to: LISTED });
});

test("--applied answers in the finding's review thread and resolves it, with the full sha and a reply marker", async () => {
  const { io, mutations, output, printed } = world({ threads: [{ id: "PRRT_other", isResolved: false, comments: [{ databaseId: 1, body: "a person's note" }] }, inlineThread] });
  await replyCommand(io, SESSION, { address: INLINE, outcome: { applied: FIX.slice(0, 7) } });
  const [answer, resolve] = mutations();
  expect(answer?.query).toContain("addPullRequestReviewThreadReply");
  expect(answer?.variables).toEqual({ thread: "PRRT_kw1", body: `${replyMarker({ v: 1, to: INLINE, session: SESSION })}\nApplied in ${FIX}.` });
  expect(parseReply(answer?.variables.body as string)).toEqual({ v: 1, to: INLINE });
  expect(resolve?.query).toContain("resolveReviewThread");
  expect(resolve?.variables).toEqual({ thread: "PRRT_kw1" });
  expect(mutations()).toHaveLength(2);
  expect(output()).toBe("https://github.com/johnrees/widget/pull/12#discussion_r501\n");
  expect(printed.join("\n")).toContain("resolved the thread");
});

test("--applied with a commit that is not on the pull request's head branch is refused, and nothing is posted or resolved", async () => {
  const { io, mutations, posted } = world({ threads: [inlineThread] });
  expect(await refusal(() => replyCommand(io, SESSION, { address: INLINE, outcome: { applied: "f".repeat(40) } }))).toBe(
    `${"f".repeat(40)} is not on johnrees/widget#12's head branch; push the fix to it first, or answer with --declined "<why>"`,
  );
  expect(await refusal(() => replyCommand(io, SESSION, { address: INLINE, outcome: { applied: "not-a-sha" } }))).toBe("--applied takes a commit sha (7 to 40 hex digits)");
  expect(mutations()).toEqual([]);
  expect(posted(`${REPO}/issues/12/comments`)).toEqual([]);
  // A prefix two of the pull request's commits share is ambiguous.
  const twins = world({ threads: [inlineThread], commits: [`abcdef1${"0".repeat(33)}`, `abcdef1${"1".repeat(33)}`] });
  expect(await refusal(() => replyCommand(twins.io, SESSION, { address: INLINE, outcome: { applied: "abcdef1" } }))).toContain("names more than one of johnrees/widget#12's commits");
});

test("a reasoned --declined answers and resolves the thread; an empty reason, or one holding a marker, is refused before any request", async () => {
  const { fake, io, mutations } = world({ threads: [inlineThread] });
  await replyCommand(io, undefined, { address: "https://github.com/johnrees/widget/pull/12#discussion_r501", outcome: { declined: "  The branch is unreachable: parse() never returns null.  " } });
  expect(mutations().map((call) => call.variables)).toEqual([
    { thread: "PRRT_kw1", body: `${replyMarker({ v: 1, to: INLINE })}\nDeclined: The branch is unreachable: parse() never returns null.` },
    { thread: "PRRT_kw1" },
  ]);
  const before = fake.log.length;
  expect(await refusal(() => replyCommand(io, undefined, { address: INLINE, outcome: { declined: "   " } }))).toBe("the reason --declined gives is empty");
  // A forged notify in a reply would make the reply need an answer: a loop.
  const forged = `ok <!-- agent-notify {"v":1,"id":"${NOTIFY}","severity":"P0"} -->`;
  expect(await refusal(() => replyCommand(io, undefined, { address: INLINE, outcome: { declined: forged } }))).toContain("holds an agent-gh marker");
  expect(fake.log.length).toBe(before);
});

test("a thread named by its id is answered and resolved; a review thread with no finding marker gets a reply without one", async () => {
  const plain = { id: "PRRT_kw1", isResolved: false, comments: [{ databaseId: 501, body: "**P2 tests**: an older review's finding" }] };
  const { io, mutations } = world({ threads: [plain] });
  await replyCommand(io, undefined, { address: "PRRT_kw1", outcome: { applied: FIX } });
  expect(mutations().map((call) => call.variables)).toEqual([{ thread: "PRRT_kw1", body: `Applied in ${FIX}.` }, { thread: "PRRT_kw1" }]);
});

test("a finding only in a review's body is answered with a pull request comment that links the review and quotes the finding", async () => {
  const review = {
    id: 900,
    html_url: "https://github.com/johnrees/widget/pull/12#pullrequestreview-900",
    body: `marker\n- **P1 defect** \`src/b.ts:9\`: Off by one. ${findingMarker({ v: 1, id: LISTED, priority: "P1" })}\n  An empty list reads past its end.`,
  };
  const { io, mutations, posted, output } = world({ reviews: [review] });
  await replyCommand(io, SESSION, { address: LISTED, outcome: { applied: FIX } });
  expect(mutations()).toEqual([]);
  expect(posted(`${REPO}/issues/12/comments`)).toEqual([
    `${replyMarker({ v: 1, to: LISTED, session: SESSION })}\nOn a finding in https://github.com/johnrees/widget/pull/12#pullrequestreview-900:\n\n> **P1 defect** \`src/b.ts:9\`: Off by one.\n\nApplied in ${FIX}.`,
  ]);
  expect(output()).toBe("https://github.com/johnrees/widget/pull/12#issuecomment-1\n");
  // A review's URL answers the findings in its body as a whole.
  const whole = world();
  await replyCommand(whole.io, undefined, { address: "https://github.com/johnrees/widget/pull/12#pullrequestreview-900", outcome: { declined: "Out of scope; filed #30." } });
  expect(whole.posted(`${REPO}/issues/12/comments`)).toEqual(["On the findings in https://github.com/johnrees/widget/pull/12#pullrequestreview-900:\n\nDeclined: Out of scope; filed #30."]);
});

test("a notify on an issue the pull request closes is answered there, and its reply clears agent-threads; the reply needs no answer itself", async () => {
  const notify = { id: 700, html_url: "https://github.com/johnrees/widget/issues/7#issuecomment-700", body: `${notifyMarker({ v: 1, id: NOTIFY, severity: "P1" })}\nA finding.` };
  const { io, posted } = world({ issueComments: [notify] });
  await replyCommand(io, SESSION, { address: NOTIFY, outcome: { applied: FIX } });
  const [body] = posted(`${REPO}/issues/7/comments`) as [string];
  expect(body).toBe(`${replyMarker({ v: 1, to: NOTIFY, session: SESSION })}\nApplied in ${FIX}.`);
  const CLAUDE = 7;
  const comment = (id: number, text: string, at: string): ThreadComment => ({ id, thread: "#7", url: `u${id}`, author: "johnrees", appId: CLAUDE, createdAt: at, body: text, thumbsUp: 0 });
  const input = (comments: ThreadComment[]) => ({ owner: "johnrees", agentApps: [CLAUDE], since: "2026-10-10T00:00:00Z", comments });
  expect(requiredComments(input([comment(1, notify.body, "2026-10-11T00:00:00Z")]), new Set())).toHaveLength(1);
  expect(requiredComments(input([comment(1, notify.body, "2026-10-11T00:00:00Z"), comment(2, body, "2026-10-11T01:00:00Z")]), new Set())).toEqual([]);
  expect(parseNotify(body)).toBeUndefined();
  // By its comment's URL too, from an issue: the fix is checked against this branch's pull request.
  const byUrl = world();
  await replyCommand(byUrl.io, undefined, { address: "https://github.com/johnrees/widget/issues/7#issuecomment-700", outcome: { applied: FIX.slice(0, 10) } });
  expect(byUrl.posted(`${REPO}/issues/7/comments`)).toEqual([`${replyMarker({ v: 1, to: NOTIFY })}\nApplied in ${FIX}.`]);
});

test("an id on nothing in the pull request is refused, and so is an id with no pull request to look in", async () => {
  expect(await refusal(() => replyCommand(world().io, undefined, { address: INLINE, outcome: { applied: FIX } }))).toBe(
    `no finding or notify ${INLINE} on johnrees/widget#12 or an issue it closes; pass --pr N for another pull request, or the comment's URL`,
  );
  expect(await refusal(() => replyCommand(world({ branchPull: false }).io, undefined, { address: INLINE, outcome: { applied: FIX } }))).toBe(
    "no open pull request for this branch; pass --pr N, or the finding's URL",
  );
  expect(await refusal(() => replyCommand(world().io, undefined, { address: "nonsense", outcome: { applied: FIX } }))).toContain("is not a finding or notify id");
});

test("where GraphQL is refused, as Claude cloud's proxy does, reply says so; GitHub's error text is never shown", async () => {
  const blocked = await refusal(() => replyCommand(world({ graphqlStatus: 403 }).io, undefined, { address: INLINE, outcome: { applied: FIX } }));
  expect(blocked).toContain("GitHub's GraphQL API answered HTTP 403");
  expect(blocked).toContain("run this from a local session");
  const errors = await refusal(() => replyCommand(world({ threads: [] }).io, undefined, { address: "PRRT_missing", outcome: { applied: FIX } }));
  expect(errors).toBe("PRRT_missing is not a review thread GitHub shows");
});

test("notify needs a severity of P0 to P2, text without markers, and a thread to notify", () => {
  expect(checkedSeverity("P1")).toBe("P1");
  expect(() => checkedSeverity("P3")).toThrow("a P3 needs no answer, so it is not a notify");
  expect(() => checkedSeverity(undefined)).toThrow("--severity must be P0, P1, or P2");
  expect(() => checkedText("notifying", "the notify's text", " \n ")).toThrow("is empty");
  expect(() => checkedText("notifying", "the notify's text", "see <!-- agent-reply {} -->")).toThrow("holds an agent-gh marker");
  expect(parseThreadRef("12", widget)).toEqual({ repo: widget, number: 12 });
  expect(parseThreadRef("#12", widget)).toEqual({ repo: widget, number: 12 });
  expect(parseThreadRef("johnrees/penmon#383", widget)).toEqual({ repo: { owner: "johnrees", name: "penmon" }, number: 383 });
  expect(parseThreadRef("https://github.com/johnrees/soltui/pull/576#issuecomment-1", undefined)).toEqual({ repo: { owner: "johnrees", name: "soltui" }, number: 576 });
  expect(parseThreadRef("12", undefined)).toBeUndefined();
  expect(parseThreadRef("penmon#3", widget)).toBeUndefined();
  // The id names the finding and its thread, whatever the whitespace.
  expect(notifyId({ repo: widget, number: 7 }, "A  finding.\n")).toBe(notifyId({ repo: widget, number: 7 }, "A finding."));
  expect(notifyId({ repo: widget, number: 7 }, "A finding.")).not.toBe(notifyId({ repo: widget, number: 8 }, "A finding."));
});

test("the session a notify or reply records is the harness's own id", () => {
  expect(sessionId({ CLAUDE_CODE_SESSION_ID: "0f6e-1" })).toBe("claude:0f6e-1");
  expect(sessionId({ CODEX_THREAD_ID: "t1", CODEX_SESSION_ID: "s1" })).toBe("codex:t1");
  expect(sessionId({ PI_SESSION_ID: "p1" })).toBe("pi:p1");
  expect(sessionId({ OPENCODE_TERMINAL: "1" })).toBeUndefined();
  expect(sessionId({ CLAUDE_CODE_SESSION_ID: "a b" })).toBeUndefined();
});

test("notify posts on the other thread with its marker, severity, session, and a backlink to this branch's pull request", async () => {
  const { io, posted, output, printed } = world();
  await notifyCommand(io, SESSION, { target: "#7", severity: "P1", text: "  parse() returns null on an empty file.\n" });
  const id = notifyId({ repo: widget, number: 7 }, "parse() returns null on an empty file.");
  const [body] = posted(`${REPO}/issues/7/comments`) as [string];
  expect(body).toBe(
    [
      notifyMarker({ v: 1, id, severity: "P1", session: SESSION }),
      "**P1** from johnrees/widget#12:",
      "",
      "parse() returns null on an empty file.",
      "",
      `Answer with \`agent-gh reply ${id} --applied <sha>\` or \`agent-gh reply ${id} --declined "<why>"\`.`,
    ].join("\n"),
  );
  expect(parseNotify(body)).toEqual({ v: 1, id, severity: "P1" });
  expect(output()).toBe("https://github.com/johnrees/widget/issues/7#issuecomment-2\n");
  expect(printed.join("\n")).toContain(`it waits for \`agent-gh reply ${id}\``);
  // --from names the backlink, and must be a thread GitHub shows.
  const from = world({ branchPull: false });
  await notifyCommand(from.io, undefined, { target: "8", severity: "P0", text: "x", from: "#7" });
  expect(from.posted(`${REPO}/issues/8/comments`)[0]).toContain("**P0** from johnrees/widget#7:");
  expect(await refusal(() => notifyCommand(from.io, undefined, { target: "8", severity: "P0", text: "x", from: "#99" }))).toBe("--from names johnrees/widget#99, which GitHub does not show (HTTP 404)");
});

test("a notify with no backlink, to its own thread, at P3, or already sent is refused, and nothing is posted", async () => {
  const lone = world({ branchPull: false });
  expect(await refusal(() => notifyCommand(lone.io, undefined, { target: "7", severity: "P1", text: "x" }))).toContain("a notify links back to where it came from, and this branch has no open pull request");
  const { io, posted } = world({ issueComments: [{ html_url: "https://github.com/johnrees/widget/issues/7#issuecomment-5", body: notifyBody(7, "Seen before.") }] });
  expect(await refusal(() => notifyCommand(io, undefined, { target: "12", severity: "P1", text: "x" }))).toBe("a notify goes to another thread than johnrees/widget#12; answer there with a comment");
  expect(await refusal(() => notifyCommand(io, undefined, { target: "7", severity: "P3", text: "x" }))).toContain("a P3 needs no answer");
  expect(await refusal(() => notifyCommand(io, undefined, { target: "7", severity: "P2", text: "Seen   before." }))).toBe(
    "johnrees/widget#7 already has this notify (https://github.com/johnrees/widget/issues/7#issuecomment-5); a notify is sent once",
  );
  expect(posted(`${REPO}/issues/7/comments`)).toEqual([]);
  expect(posted(`${REPO}/issues/12/comments`)).toEqual([]);
});

/** A notify's marker and text as an earlier `agent-gh notify` to issue `number` posted them. */
const notifyBody = (number: number, text: string) => `${notifyMarker({ v: 1, id: notifyId({ repo: widget, number }, text), severity: "P1" })}\n${text}`;

test("--applied and --declined are checked before anything is read", () => {
  expect(checkedOutcome({ applied: "ABCDEF1" })).toEqual({ applied: "abcdef1" });
  expect(checkedOutcome({ declined: " why " })).toEqual({ declined: "why" });
});
