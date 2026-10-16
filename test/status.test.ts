import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentApps } from "../src/config.ts";
import { reviewMarker, type ReviewMarker } from "../src/review.ts";
import { pullDiff } from "../src/review-run.ts";
import {
  agentCommit,
  agentPull,
  askFor,
  callBody,
  callMarker,
  carryCandidate,
  eventTarget,
  firstLine,
  type FoundMarker,
  headRelease,
  holdLink,
  holdStatus,
  type HoldThread,
  labelEvents,
  NO_ASK,
  type PostedBy,
  releaseLine,
  reservedFiles,
  reviewStatus,
  validMarkers,
} from "../src/status.ts";
import { deriveStatuses, statusCommand, type StatusIo, writeStatuses } from "../src/status-run.ts";
import { awaitingOwner, notifyMarker, parseNotify, parseReply, replyMarker, requiredComments, type ThreadComment, threadsStatus } from "../src/threads.ts";
import { fakeGitHub, reply } from "./fake-github.ts";

const APPS = agentApps();
const CLAUDE = (APPS.find((app) => app.family === "claude") as (typeof APPS)[number]).id;
const OTHER_APP = 999_999;
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

const marker = (overrides: Partial<ReviewMarker> = {}): ReviewMarker => ({
  v: 1, head: A, merge_base: B, patch_id: C, verdict: "approve", checks: "passed", reviewer: "codex", ...overrides,
});
const NO_CHECKS = { blockOn: "changes_requested", checks: [] } as const;
const CHECKED = { blockOn: "changes_requested", checks: ["make check"] } as const;
const found = (overrides: Partial<ReviewMarker>, at: string): FoundMarker => ({ marker: marker(overrides), at, url: `https://github.com/r/${at}` });

test("an event names its pull request; a comment on a plain issue names the issue whose closing pull requests count", () => {
  for (const name of ["pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment"]) {
    expect(eventTarget(name, { pull_request: { number: 12 } })).toEqual({ pull: 12 });
  }
  expect(eventTarget("issue_comment", { issue: { number: 12, pull_request: { url: "x" } } })).toEqual({ pull: 12 });
  expect(eventTarget("issue_comment", { issue: { number: 7 } })).toEqual({ issue: 7 });
  // A label added to or removed from an issue: the pull requests that close it.
  expect(eventTarget("issues", { action: "labeled", issue: { number: 7 } })).toEqual({ issue: 7 });
  expect(eventTarget("push", { ref: "refs/heads/main" })).toBeUndefined();
  expect(eventTarget("pull_request", {})).toBeUndefined();
});

test("only markers the owner posted count, a comment's only through a family App; they are read oldest first", () => {
  const body = (head: string) => `${reviewMarker(marker({ head }))}\n**agent-review**`;
  const posts = [
    { author: "JohnRees", appId: undefined, kind: "review", at: "2026-10-12T00:00:00Z", body: body(B), url: "review-late" },
    { author: "johnrees", appId: undefined, kind: "review", at: "2026-10-11T00:00:00Z", body: body(A), url: "review-early" },
    { author: "johnrees", appId: CLAUDE, kind: "comment", at: "2026-10-13T00:00:00Z", body: body(C), url: "comment-app" },
    { author: "johnrees", appId: undefined, kind: "comment", at: "2026-10-14T00:00:00Z", body: body(D), url: "comment-person" },
    { author: "johnrees", appId: OTHER_APP, kind: "comment", at: "2026-10-14T00:00:00Z", body: body(D), url: "comment-other-app" },
    { author: "mallory", appId: undefined, kind: "review", at: "2026-10-15T00:00:00Z", body: body(D), url: "review-other" },
    { author: "johnrees", appId: undefined, kind: "review", at: "2026-10-15T00:00:00Z", body: "<!-- agent-review {broken} -->", url: "malformed" },
  ] as const;
  expect(validMarkers(posts, "johnrees", APPS).map((item) => item.url)).toEqual(["review-early", "review-late", "comment-app"]);
});

test("an agent's pull request is told by its commits' trailers, its App, or its author; Dependabot's and a person's are not", () => {
  const person = { author: "johnrees", authorType: "User", viaApp: undefined };
  expect(agentPull({ ...person, commits: ["Fix it\n\nAgent-Harness: claude\nCo-authored-by: johnrees-claude[bot] <1+johnrees-claude[bot]@users.noreply.github.com>"] }, APPS)).toBe(true);
  expect(agentPull({ ...person, commits: ["by hand", "Fix\n\nAgent-Model: gpt-6-astra"] }, APPS)).toBe(true);
  expect(agentPull({ ...person, commits: ["Fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"] }, APPS)).toBe(true);
  expect(agentPull({ ...person, commits: ["by hand", "Co-authored-by: Jo <jo@example.com>"] }, APPS)).toBe(false);
  expect(agentPull({ ...person, commits: ["mentions Agent-Model: in prose, not a trailer"] }, APPS)).toBe(false);
  expect(agentPull({ ...person, viaApp: CLAUDE, commits: ["by hand"] }, APPS)).toBe(true);
  // Too many commits to read: reviewed, never skipped on a guess.
  expect(agentPull({ ...person, commits: undefined }, APPS)).toBe(true);
  expect(agentPull({ author: "dependabot[bot]", authorType: "Bot", viaApp: undefined, commits: ["Bump x\n\nAgent-Harness: claude"] }, APPS)).toBe(false);
  expect(agentPull({ author: "johnrees-codex[bot]", authorType: "Bot", viaApp: undefined, commits: ["x"] }, APPS)).toBe(true);
  expect(agentCommit("x\n\nCo-authored-by: johnrees-claude[bot]-fake <x@example.com>", APPS)).toBe(false);
});

test("an approval carries forward only from the latest marker for the same patch", () => {
  const approved = found({ head: A, patch_id: C }, "1");
  const blocked = found({ head: B, patch_id: C, verdict: "changes_requested" }, "2");
  const other = found({ head: D, patch_id: D }, "3");
  expect(carryCandidate([approved, other], C, NO_CHECKS)).toBe(approved);
  expect(carryCandidate([approved, blocked, other], C, NO_CHECKS)).toBeUndefined();
  expect(carryCandidate([approved], D, NO_CHECKS)).toBeUndefined();
  expect(carryCandidate([found({ patch_id: null }, "1")], null, NO_CHECKS)).toBeUndefined();
});

test("under a priority threshold, a review carries forward when it passes the threshold, never one that records no priorities", () => {
  const minor = found({ patch_id: C, verdict: "changes_requested", priorities: ["P3"] }, "1");
  const major = found({ patch_id: C, verdict: "approve", priorities: ["P2"] }, "2");
  expect(carryCandidate([minor], C, { blockOn: "P2", checks: [] })).toBe(minor);
  expect(carryCandidate([minor, major], C, { blockOn: "P2", checks: [] })).toBeUndefined();
  expect(carryCandidate([found({ patch_id: C }, "1")], C, { blockOn: "P2", checks: [] })).toBeUndefined();
});

test("a review whose checks did not pass never carries forward, and a later one of the same patch stops an earlier pass carrying", () => {
  const approved = found({ patch_id: C }, "1");
  const timedOut = found({ patch_id: C, checks: "timed out" }, "2");
  expect(carryCandidate([timedOut], C, CHECKED)).toBeUndefined();
  expect(carryCandidate([found({ patch_id: C, checks: "failed" }, "1")], C, NO_CHECKS)).toBeUndefined();
  expect(carryCandidate([found({ patch_id: C, checks: "not run" }, "1")], C, CHECKED)).toBeUndefined();
  expect(carryCandidate([approved, timedOut], C, CHECKED)).toBeUndefined();
  // With no checks configured, a review with none run carries as before.
  const unchecked = found({ patch_id: C, checks: "not run" }, "1");
  expect(carryCandidate([unchecked], C, NO_CHECKS)).toBe(unchecked);
});

test("agent-review fails an approval whose checks failed, timed out, or did not run, naming why", () => {
  const base = { number: 12, agent: true, waivedBy: undefined, current: undefined, carried: undefined, policy: CHECKED } as const;
  expect(reviewStatus({ ...base, current: found({ checks: "timed out" }, "1") })).toEqual({
    context: "agent-review", state: "failure", description: "checks unverified: approved, but checks timed out (codex review)", targetUrl: "https://github.com/r/1",
  });
  expect(reviewStatus({ ...base, current: found({ checks: "failed" }, "1") })).toMatchObject({ state: "failure", description: "approved, but checks failed (codex review)" });
  expect(reviewStatus({ ...base, current: found({ checks: "not run" }, "1") })).toMatchObject({ state: "failure", description: "checks unverified: approved, but checks not run (codex review)" });
  expect(reviewStatus({ ...base, current: found({}, "1") })).toMatchObject({ state: "success", description: "approved; checks passed (codex review)" });
  expect(reviewStatus({ ...base, policy: NO_CHECKS, current: found({ checks: "not run" }, "1") })).toMatchObject({ state: "success", description: "approved; checks not run (codex review)" });
  // A person's waiver still stands.
  expect(reviewStatus({ ...base, waivedBy: "johnrees", current: found({ checks: "timed out" }, "1") })).toMatchObject({ state: "success", description: "waived by johnrees" });
});

test("agent-review: not an agent's, waived, the head's own verdict, carried forward, else pending with the command", () => {
  const base = { number: 12, agent: true, waivedBy: undefined, current: undefined, carried: undefined, policy: { blockOn: "changes_requested", checks: [] } } as const;
  expect(reviewStatus({ ...base, agent: false })).toMatchObject({ context: "agent-review", state: "success", description: "not an agent PR" });
  expect(reviewStatus({ ...base, waivedBy: "johnrees", current: found({ verdict: "changes_requested" }, "1") })).toMatchObject({ state: "success", description: "waived by johnrees" });
  expect(reviewStatus({ ...base, current: found({ verdict: "changes_requested", checks: "failed" }, "1") })).toEqual({
    context: "agent-review", state: "failure", description: "changes requested; checks failed (codex review)", targetUrl: "https://github.com/r/1",
  });
  expect(reviewStatus({ ...base, current: found({}, "1") })).toMatchObject({ state: "success", description: "approved; checks passed (codex review)" });
  expect(reviewStatus({ ...base, carried: found({}, "1") })).toMatchObject({
    state: "success", description: "approved at aaaaaaaa, carried forward: same patch, base changes miss its files; checks passed",
  });
  expect(reviewStatus(base)).toMatchObject({ state: "pending", description: "needs a review: run `gh pr checkout 12 && agent-gh review full --pr 12`", targetUrl: undefined });
});

test("agent-review at block_on P2: the head's marker fails on a P2 or above, passes on P3s whatever the verdict, and fails closed without priorities", () => {
  const base = { number: 12, agent: true, waivedBy: undefined, current: undefined, carried: undefined, policy: { blockOn: "P2", checks: [] } } as const;
  expect(reviewStatus({ ...base, current: found({ verdict: "changes_requested", priorities: ["P3", "P3"] }, "1") })).toMatchObject({
    state: "success", description: "changes requested; 0 finding(s) at P2 or above; checks passed (codex review)",
  });
  expect(reviewStatus({ ...base, current: found({ verdict: "approve", priorities: ["P3", "P2"] }, "1") })).toMatchObject({
    state: "failure", description: "approved; 1 finding(s) at P2 or above; checks passed (codex review)",
  });
  expect(reviewStatus({ ...base, current: found({}, "1") })).toMatchObject({
    state: "failure", description: "approved; the review records no finding priorities, which block_on P2 needs: review again; checks passed (codex review)",
  });
  expect(reviewStatus({ ...base, waivedBy: "johnrees", current: found({ priorities: ["P0"] }, "1") })).toMatchObject({ state: "success", description: "waived by johnrees" });
  expect(reviewStatus({ ...base, carried: found({ priorities: ["P3"] }, "1") })).toMatchObject({
    state: "success", description: "passed at aaaaaaaa, carried forward: same patch, base changes miss its files; checks passed",
  });
});

const comment = (id: number, author: string, appId: number | undefined, createdAt: string, extra: Partial<ThreadComment> = {}): ThreadComment => ({
  id, thread: "#12", url: `https://github.com/c/${id}`, author, appId, createdAt, body: "", thumbsUp: 0, ...extra,
});
const SINCE = "2026-10-10T00:00:00Z";

test("the owner's comment waits for an answer until an agent comments after it on its thread, or the owner gives it a 👍", () => {
  const input = (comments: ThreadComment[]) => ({ owner: "johnrees", agentApps: [CLAUDE], since: SINCE, comments });
  const john = comment(2, "johnrees", undefined, "2026-10-11T00:00:00Z");
  expect(requiredComments(input([john]), new Set())).toEqual([{ url: "https://github.com/c/2", thread: "#12", why: "johnrees's comment" }]);
  // An agent's later comment on the same thread answers it; one on another thread does not.
  expect(requiredComments(input([john, comment(3, "johnrees", CLAUDE, "2026-10-11T01:00:00Z")]), new Set())).toEqual([]);
  expect(requiredComments(input([john, comment(3, "johnrees", CLAUDE, "2026-10-11T01:00:00Z", { thread: "#7" })]), new Set())).toHaveLength(1);
  // The ball returns when the owner comments again.
  expect(requiredComments(input([comment(1, "johnrees", CLAUDE, "2026-10-10T12:00:00Z"), john]), new Set())).toHaveLength(1);
  // Same second: the later id is the later comment.
  expect(requiredComments(input([comment(1, "johnrees", CLAUDE, "2026-10-11T00:00:00Z"), john]), new Set())).toHaveLength(1);
  expect(requiredComments(input([john]), new Set([2]))).toEqual([]);
  // Before the pull request, from someone else, or through another App the owner did not use for an agent.
  expect(requiredComments(input([comment(4, "johnrees", undefined, "2026-10-09T00:00:00Z")]), new Set())).toEqual([]);
  expect(requiredComments(input([comment(5, "mallory", undefined, "2026-10-11T00:00:00Z")]), new Set())).toEqual([]);
  expect(requiredComments(input([comment(6, "JohnRees", OTHER_APP, "2026-10-11T00:00:00Z")]), new Set())).toHaveLength(1);
  // Only the owner's own comments with a 👍 are worth reading reactions for.
  expect(awaitingOwner(input([john, comment(5, "mallory", undefined, "2026-10-11T00:00:00Z", { thumbsUp: 1 })])).map((item) => item.id)).toEqual([2]);
});

test("a P0 to P2 notify from an agent waits for an agent's reply marker; P3 never does", () => {
  const input = (comments: ThreadComment[]) => ({ owner: "johnrees", agentApps: [CLAUDE], since: SINCE, comments });
  const notify = (id: number, severity: "P0" | "P1" | "P2" | "P3", author = "johnrees", appId: number | undefined = CLAUDE) =>
    comment(id, author, appId, "2026-10-11T00:00:00Z", { body: `${notifyMarker({ v: 1, id: `${id}`.padStart(8, "0"), severity })}\nA finding.` });
  expect(requiredComments(input([notify(1, "P1")]), new Set())).toEqual([{ url: "https://github.com/c/1", thread: "#12", why: "an unanswered P1 notify" }]);
  expect(requiredComments(input([notify(1, "P3")]), new Set())).toEqual([]);
  const answer = comment(2, "johnrees", CLAUDE, "2026-10-11T02:00:00Z", { thread: "#7", body: replyMarker({ v: 1, to: "00000001" }) });
  expect(requiredComments(input([notify(1, "P0"), answer]), new Set())).toEqual([]);
  // A reply marker from a person is not an agent's reply; a notify from someone else is not an agent's notify.
  expect(requiredComments(input([notify(1, "P2"), { ...answer, appId: undefined }]), new Set()).map((item) => item.why)).toEqual(["an unanswered P2 notify", "johnrees's comment"]);
  expect(requiredComments(input([notify(1, "P0", "mallory", undefined)]), new Set())).toEqual([]);
  expect(parseNotify(`<!-- agent-notify {"v":1,"id":"00000001","severity":"P1","session":"s"} -->`)).toEqual({ v: 1, id: "00000001", severity: "P1" });
  expect(parseNotify(`<!-- agent-notify {"v":1,"id":"x","severity":"P1"} -->`)).toBeUndefined();
  expect(parseReply(`<!-- agent-reply {"v":1} -->`)).toBeUndefined();
  expect(threadsStatus([])).toEqual({ state: "success", description: "no comment awaits an agent's answer", targetUrl: undefined });
  expect(threadsStatus([{ url: "u", thread: "#7", why: "johnrees's comment" }])).toEqual({ state: "failure", description: "1 comment(s) await an agent's answer, first johnrees's comment on #7", targetUrl: "u" });
  // GitHub refuses a description over 140 characters; a long repository name is cut, not refused.
  expect(threadsStatus([{ url: "u", thread: `${"o".repeat(80)}/${"r".repeat(80)}#7`, why: "johnrees's comment" }]).description).toHaveLength(140);
  // A pull request with no opening time counts every comment of the owner's, never none.
  expect(awaitingOwner({ owner: "johnrees", agentApps: [CLAUDE], since: "", comments: [comment(2, "johnrees", undefined, "2020-01-01T00:00:00Z")] })).toHaveLength(1);
});

// --- The workflow's statuses, from a fake GitHub and real git ---

const REPO = "/repos/johnrees/widget";
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const gitEnv = (home: string) => ({ PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" });
const runGit = (env: Record<string, string>, cwd: string, args: readonly string[], input?: string) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
};

/**
 * The repository on "GitHub" (a local remote that serves any commit): a.txt
 * of 30 lines and b.txt on main. The pull request changes a.txt's first
 * line. Then main changes b.txt only (mb2), and later a.txt's last line
 * (mb3); the pull request is rebased onto each, as head2 and head3.
 */
const history = () => {
  const home = mkdtempSync(join(tmpdir(), "agent-gh-status-"));
  const dir = join(home, "remote");
  const env = gitEnv(home);
  const git = (args: readonly string[], input?: string) => runGit(env, dir, args, input);
  runGit(env, home, ["init", "-q", "-b", "main", dir]);
  git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  const commit = (file: string, text: string, message: string) => {
    writeFileSync(join(dir, file), text);
    git(["add", file]);
    git(["commit", "-q", "-m", message]);
    return git(["rev-parse", "HEAD"]) as string;
  };
  writeFileSync(join(dir, "b.txt"), "b\n");
  git(["add", "b.txt"]);
  const mb1 = commit("a.txt", `${lines.join("\n")}\n`, "base");
  git(["checkout", "-q", "-b", "feature"]);
  const head1 = commit("a.txt", `${["changed", ...lines.slice(1)].join("\n")}\n`, "the change\n\nAgent-Harness: claude");
  git(["checkout", "-q", "main"]);
  const mb2 = commit("b.txt", "b2\n", "base touches b only");
  const mb3 = commit("a.txt", `${[...lines.slice(0, 29), "last changed"].join("\n")}\n`, "base touches a's end");
  const rebase = (onto: string, name: string) => {
    git(["checkout", "-q", "-b", name, onto]);
    git(["cherry-pick", head1]);
    return git(["rev-parse", "HEAD"]) as string;
  };
  const head2 = rebase(mb2, "rebased2");
  const head3 = rebase(mb3, "rebased3");
  const io = { git: async (args: readonly string[], input?: string) => git(args, input) };
  return { home, dir, env, git, mb1, head1, mb2, head2, mb3, head3, io };
};

type Scenario = {
  head: string;
  mergeBase: string;
  remote?: string;
  author?: { login: string; type: string };
  labels?: string[];
  events?: unknown[];
  reviews?: unknown[];
  comments?: unknown[];
  commits?: string[];
  combined?: unknown[];
  statusReply?: number;
  optedIn?: boolean;
  /** GitHub's answer to GraphQL, when not 200. */
  graphqlStatus?: number;
  /** The config's block_on, if it sets one. */
  blockOn?: string;
  /** The config's checks, if it names any. */
  checks?: string[];
  /** A conversation comment posted the moment this run first sets a status, as when another run's event lands meanwhile. */
  commentWhileWriting?: unknown;
  /** The NTFY_URL secret: a topic on the fake that answers, one that fails, or a port nothing listens on. */
  ntfy?: "ok" | "fails" | "unreachable";
  /** The base branch's config's `hold`, if it sets one; the pull request's own branch's copy never has one. */
  hold?: unknown;
  /** The repository owner, as the API names him. */
  owner?: string;
  /** Issue #7, which the pull request closes: its labels, events, and comments. */
  issueLabels?: string[];
  issueEvents?: unknown[];
  issueComments?: unknown[];
  /** How many issues GitHub says the pull request closes, when more than it lists. */
  closingTotal?: number;
  /** Pages of the pull requests that close issue #7 (#12 is on the last). */
  closingPages?: number;
  /** The merge bases of heads other than the current one, by head (against main), or by `base...head`. */
  mergeBases?: Record<string, string>;
  /** A second open pull request that closes issue #7, closed by the time it is read. */
  alsoClosing?: boolean;
  /** Other open pull requests whose head is this one's. */
  sharedWith?: number[];
  /** Another run's call for the same event, posted the moment this run posts its own. */
  callRace?: unknown;
};

/** The secret part of the NTFY_URL secret, which no printed line may show. */
const TOPIC = "topic-3e9a-secret";

const statusWorld = (scenario: Scenario) => {
  const { head, author = { login: "johnrees", type: "User" }, labels = [], events = [], reviews = [], commits = ["x\n\nAgent-Harness: claude"], combined = [], optedIn = true, owner = "johnrees" } = scenario;
  const comments = [...(scenario.comments ?? [])];
  const issueComments = [...(scenario.issueComments ?? [])];
  const configRefs: string[] = [];
  const posting = (thread: unknown[], number: number) => (body: string) => {
    if (scenario.callRace !== undefined && body.includes("agent-hold-call")) thread.push(scenario.callRace);
    thread.push({ id: 5000 + thread.length, user: { login: "github-actions[bot]", type: "Bot" }, performed_via_github_app: { id: 15368 }, created_at: "2026-10-11T12:01:00Z", updated_at: "2026-10-11T12:01:00Z", html_url: `https://github.com/johnrees/widget/issues/${number}#c`, body: (JSON.parse(body) as { body: string }).body });
    return reply(201, { id: 5000 + thread.length - 1 });
  };
  const config = (ref: string | null) => ({
    reviewers: { codex: { model: "m" } }, status_writer: "actions",
    ...(scenario.blockOn === undefined ? {} : { block_on: scenario.blockOn }), ...(scenario.checks === undefined ? {} : { checks: scenario.checks }),
    ...(scenario.hold === undefined || ref !== "main" ? {} : { hold: scenario.hold }),
  });
  const fake = fakeGitHub({
    [`GET ${REPO}/pulls/12`]: () => reply(200, { state: "open", head: { sha: head }, base: { ref: "main" }, labels: labels.map((name) => ({ name })), created_at: "2026-10-10T00:00:00Z", user: author }),
    [`GET ${REPO}/contents/.github/agent-review.json`]: (_, url) => {
      configRefs.push(url.searchParams.get("ref") ?? "");
      return optedIn ? reply(200, { content: Buffer.from(JSON.stringify(config(url.searchParams.get("ref")))).toString("base64") }) : reply(404, {});
    },
    [`GET ${REPO}`]: () => reply(200, { default_branch: "main", owner: { login: owner } }),
    [`GET ${REPO}/issues/12`]: () => reply(200, { performed_via_github_app: null, labels: labels.map((name) => ({ name })), html_url: "https://github.com/johnrees/widget/pull/12" }),
    [`GET ${REPO}/issues/7`]: () => reply(200, { labels: (scenario.issueLabels ?? []).map((name) => ({ name })), html_url: "https://github.com/johnrees/widget/issues/7" }),
    [`GET ${REPO}/issues/7/events`]: () => reply(200, scenario.issueEvents ?? []),
    [`GET ${REPO}/pulls/13`]: () => reply(200, { state: "closed", head: { sha: head }, base: { ref: "main" }, labels: [], user: author }),
    [`POST ${REPO}/issues/12/comments`]: posting(comments, 12),
    [`GET ${REPO}/commits/${head}/pulls`]: () => reply(200, [{ number: 12, state: "open", head: { sha: head } }, ...(scenario.sharedWith ?? []).map((number) => ({ number, state: "open", head: { sha: head } })), { number: 3, state: "closed", head: { sha: head } }]),
    ...Object.fromEntries(Array.from({ length: 4 }, (_, n) => [`DELETE ${REPO}/issues/comments/${5000 + n}`, () => new Response(null, { status: 204 })])),
    [`POST ${REPO}/issues/7/comments`]: posting(issueComments, 7),
    [`POST /ntfy/${TOPIC}`]: () => (scenario.ntfy === "fails" ? reply(500, {}) : reply(200, {})),
    [`GET ${REPO}/pulls/12/commits`]: (_, url) => {
      // As GitHub lists them: 100 a page, and never past the 250th.
      const at = (Number(url.searchParams.get("page") ?? 1) - 1) * 100;
      return reply(200, commits.slice(0, 250).slice(at, at + 100).map((message) => ({ commit: { message } })));
    },
    [`GET ${REPO}/issues/12/events`]: () => reply(200, events),
    [`GET ${REPO}/pulls/12/reviews`]: () => reply(200, reviews),
    [`GET ${REPO}/issues/12/comments`]: () => {
      const wrote = fake.log.some((entry) => entry.method === "POST" && entry.path.startsWith(`${REPO}/statuses/`));
      return reply(200, wrote && scenario.commentWhileWriting !== undefined ? [...comments, scenario.commentWhileWriting] : comments);
    },
    [`GET ${REPO}/issues/7/comments`]: () => reply(200, issueComments),
    [`GET ${REPO}/compare/main...${head}`]: () => reply(200, { merge_base_commit: { sha: scenario.mergeBase } }),
    ...Object.fromEntries(Object.entries(scenario.mergeBases ?? {}).map(([other, base]) => [`GET ${REPO}/compare/${other.includes("...") ? other : `main...${other}`}`, () => reply(200, { merge_base_commit: { sha: base } })])),
    [`GET ${REPO}/commits/${head}/statuses`]: () => reply(200, combined),
    [`POST ${REPO}/statuses/${head}`]: () => reply(scenario.statusReply ?? 201, {}),
    "POST /graphql": (body) =>
      scenario.graphqlStatus !== undefined
        ? reply(scenario.graphqlStatus, {})
        : body.includes("closedByPullRequestsReferences")
        ? (JSON.parse(body).variables.after === null && scenario.closingPages === 2
            ? reply(200, { data: { repository: { issue: { closedByPullRequestsReferences: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [{ number: 99, repository: { nameWithOwner: "other/repo" } }] } } } } })
            : reply(200, { data: { repository: { issue: { closedByPullRequestsReferences: { pageInfo: { hasNextPage: false, endCursor: "c2" }, nodes: [{ number: 12, repository: { nameWithOwner: "johnrees/widget" } }, ...(scenario.alsoClosing === true ? [{ number: 13, repository: { nameWithOwner: "johnrees/widget" } }] : []), { number: 99, repository: { nameWithOwner: "other/repo" } }] } } } } }))
        : reply(200, { data: { repository: { pullRequest: { closingIssuesReferences: { totalCount: scenario.closingTotal ?? 1, nodes: [{ number: 7, repository: { nameWithOwner: "johnrees/widget" } }] } } } } }),
  });
  stops.push(fake.stop);
  const scratch = mkdtempSync(join(tmpdir(), "agent-gh-scratch-"));
  const env = gitEnv(scratch);
  const gitCalls: string[] = [];
  const printed: string[] = [];
  const io: StatusIo = {
    api: fake.api,
    token: "ghs_actions",
    repo: { owner: "johnrees", name: "widget" },
    remote: scenario.remote ?? "file:///nowhere",
    ntfyUrl: scenario.ntfy === undefined ? undefined : scenario.ntfy === "unreachable" ? `http://127.0.0.1:1/${TOPIC}` : `${fake.api.base}/ntfy/${TOPIC}`,
    git: async (args, input) => {
      gitCalls.push(args.join(" "));
      return runGit(env, scratch, args, input);
    },
    print: (line) => printed.push(line),
  };
  const posted = () => fake.log.filter((entry) => entry.method === "POST" && entry.path.startsWith(`${REPO}/statuses/`)).map((entry) => JSON.parse(entry.body) as Record<string, unknown>);
  /** The comments this run posted on #`number`. */
  const commented = (number: number) => fake.log.filter((entry) => entry.method === "POST" && entry.path === `${REPO}/issues/${number}/comments`).map((entry) => (JSON.parse(entry.body) as { body: string }).body);
  const pushes = () => fake.log.filter((entry) => entry.path === `/ntfy/${TOPIC}`);
  return { fake, io, gitCalls, printed, posted, commented, pushes, comments, configRefs };
};

const reviewOf = (value: ReviewMarker, at: string, login = "johnrees") => ({ user: { login }, submitted_at: at, body: `${reviewMarker(value)}\n**agent-review**`, html_url: `https://github.com/johnrees/widget/pull/12#review-${at}` });

test("the workflow derives agent-review from the head's own marker, and the verdict decides it", async () => {
  const blocked = statusWorld({ head: A, mergeBase: B, reviews: [reviewOf(marker({ head: A, verdict: "changes_requested" }), "2026-10-11T00:00:00Z")] });
  const derived = await deriveStatuses(blocked.io, 12);
  expect(derived?.statuses).toEqual([
    { context: "agent-review", state: "failure", description: "changes requested; checks passed (codex review)", targetUrl: "https://github.com/johnrees/widget/pull/12#review-2026-10-11T00:00:00Z" },
    { context: "agent-threads", state: "success", description: "no comment awaits an agent's answer", targetUrl: undefined },
  ]);
  // A review of the head no one else's: someone else's marker counts for nothing, and git is never needed for the head's own marker.
  const approved = statusWorld({
    head: A, mergeBase: B,
    reviews: [reviewOf(marker({ head: A, verdict: "changes_requested" }), "2026-10-11T00:00:00Z"), reviewOf(marker({ head: A }), "2026-10-12T00:00:00Z"), reviewOf(marker({ head: A, verdict: "changes_requested" }), "2026-10-13T00:00:00Z", "mallory")],
  });
  expect((await deriveStatuses(approved.io, 12))?.statuses[0]).toMatchObject({ state: "success", description: "approved; checks passed (codex review)" });
  expect(approved.gitCalls).toEqual([]);
});

test("an unchanged patch rebased over base changes to other files carries its approval forward; a base change to a patched file needs a new review", async () => {
  const repo = history();
  const { patchId } = await pullDiff(repo.io, repo.mb1, repo.head1);
  expect((await pullDiff(repo.io, repo.mb3, repo.head3)).patchId).toBe(patchId);
  const approval = reviewOf(marker({ head: repo.head1, merge_base: repo.mb1, patch_id: patchId }), "2026-10-11T00:00:00Z");
  const remote = `file://${repo.dir}`;

  repo.git(["update-ref", "refs/pull/12/head", repo.head2]);
  const carried = statusWorld({ head: repo.head2, mergeBase: repo.mb2, remote, reviews: [approval] });
  expect((await deriveStatuses(carried.io, 12))?.statuses[0]).toMatchObject({
    state: "success", description: `approved at ${repo.head1.slice(0, 8)}, carried forward: same patch, base changes miss its files; checks passed`,
  });
  // Only commits are fetched, one deep, into a bare scratch repository; nothing is checked out.
  expect(carried.gitCalls.filter((call) => call.startsWith("fetch")).every((call) => call.startsWith("fetch -q --no-tags --depth=1"))).toBe(true);
  expect(carried.gitCalls.some((call) => call.startsWith("checkout") || call.startsWith("worktree"))).toBe(false);

  repo.git(["update-ref", "refs/pull/12/head", repo.head3]);
  const touched = statusWorld({ head: repo.head3, mergeBase: repo.mb3, remote, reviews: [approval] });
  expect((await deriveStatuses(touched.io, 12))?.statuses[0]).toMatchObject({ state: "pending", description: "needs a review: run `gh pr checkout 12 && agent-gh review full --pr 12`" });

  // A later review of the same patch that asked for changes is never skipped for the earlier approval.
  repo.git(["update-ref", "refs/pull/12/head", repo.head2]);
  const reblocked = statusWorld({
    head: repo.head2, mergeBase: repo.mb2, remote,
    reviews: [approval, reviewOf(marker({ head: "e".repeat(40), merge_base: repo.mb1, patch_id: patchId, verdict: "changes_requested" }), "2026-10-12T00:00:00Z")],
  });
  expect((await deriveStatuses(reblocked.io, 12))?.statuses[0]).toMatchObject({ state: "pending" });

  // A commit git cannot fetch carries nothing.
  const unreachable = statusWorld({ head: repo.head2, mergeBase: repo.mb2, remote: "file:///nowhere", reviews: [approval] });
  expect((await deriveStatuses(unreachable.io, 12))?.statuses[0]).toMatchObject({ state: "pending" });
});

test("the workflow judges the marker's priorities at block_on P2, carries forward only a review that passes it, and fails a marker without priorities", async () => {
  const at = "2026-10-11T00:00:00Z";
  const state = async (value: ReviewMarker) =>
    (await deriveStatuses(statusWorld({ head: A, mergeBase: B, blockOn: "P2", reviews: [reviewOf(value, at)] }).io, 12))?.statuses[0];
  expect(await state(marker({ verdict: "changes_requested", priorities: ["P3"] }))).toMatchObject({ state: "success", description: "changes requested; 0 finding(s) at P2 or above; checks passed (codex review)" });
  expect(await state(marker({ priorities: ["P2"] }))).toMatchObject({ state: "failure", description: "approved; 1 finding(s) at P2 or above; checks passed (codex review)" });
  expect(await state(marker())).toMatchObject({ state: "failure", description: "approved; the review records no finding priorities, which block_on P2 needs: review again; checks passed (codex review)" });

  const repo = history();
  const { patchId } = await pullDiff(repo.io, repo.mb1, repo.head1);
  const remote = `file://${repo.dir}`;
  repo.git(["update-ref", "refs/pull/12/head", repo.head2]);
  const carry = async (value: Partial<ReviewMarker>) =>
    (await deriveStatuses(statusWorld({ head: repo.head2, mergeBase: repo.mb2, remote, blockOn: "P2", reviews: [reviewOf(marker({ head: repo.head1, merge_base: repo.mb1, patch_id: patchId, ...value }), at)] }).io, 12))?.statuses[0];
  expect(await carry({ verdict: "changes_requested", priorities: ["P3"] })).toMatchObject({ state: "success", description: `passed at ${repo.head1.slice(0, 8)}, carried forward: same patch, base changes miss its files; checks passed` });
  expect(await carry({ priorities: ["P1"] })).toMatchObject({ state: "pending" });
  expect(await carry({})).toMatchObject({ state: "pending" });
});

test("the workflow fails an approval whose checks timed out, and carries forward no such review across a rebase", async () => {
  const at = "2026-10-11T00:00:00Z";
  const own = statusWorld({ head: A, mergeBase: B, checks: ["make check"], reviews: [reviewOf(marker({ checks: "timed out" }), at)] });
  expect((await deriveStatuses(own.io, 12))?.statuses[0]).toMatchObject({ state: "failure", description: "checks unverified: approved, but checks timed out (codex review)" });

  const repo = history();
  const { patchId } = await pullDiff(repo.io, repo.mb1, repo.head1);
  const remote = `file://${repo.dir}`;
  repo.git(["update-ref", "refs/pull/12/head", repo.head2]);
  const carry = async (value: Partial<ReviewMarker>) =>
    (await deriveStatuses(statusWorld({ head: repo.head2, mergeBase: repo.mb2, remote, checks: ["make check"], reviews: [reviewOf(marker({ head: repo.head1, merge_base: repo.mb1, patch_id: patchId, ...value }), at)] }).io, 12))?.statuses[0];
  expect(await carry({})).toMatchObject({ state: "success", description: `approved at ${repo.head1.slice(0, 8)}, carried forward: same patch, base changes miss its files; checks passed` });
  expect(await carry({ checks: "timed out" })).toMatchObject({ state: "pending", description: "needs a review: run `gh pr checkout 12 && agent-gh review full --pr 12`" });
  expect(await carry({ checks: "failed" })).toMatchObject({ state: "pending" });
  expect(await carry({ checks: "not run" })).toMatchObject({ state: "pending" });
});

test("a person's waiver passes agent-review; an App's does not", async () => {
  const person = statusWorld({ head: A, mergeBase: B, labels: ["review-waived"], events: [{ event: "labeled", label: { name: "review-waived" }, actor: { login: "johnrees" }, performed_via_github_app: null }] });
  expect((await deriveStatuses(person.io, 12))?.statuses[0]).toMatchObject({ state: "success", description: "waived by johnrees" });
  const app = statusWorld({ head: A, mergeBase: B, labels: ["review-waived"], events: [{ event: "labeled", label: { name: "review-waived" }, actor: { login: "johnrees" }, performed_via_github_app: { id: CLAUDE } }] });
  expect((await deriveStatuses(app.io, 12))?.statuses[0]).toMatchObject({ state: "pending" });
});

test("a pull request that is not an agent's passes both statuses; a repository without the config gets none", async () => {
  // GitHub lists only a pull request's first 250 commits, so 250 by hand may hide an agent's: reviewed.
  const capped = statusWorld({ head: A, mergeBase: B, commits: [...Array.from({ length: 250 }, () => "by hand"), "x\n\nAgent-Harness: claude"] });
  expect((await deriveStatuses(capped.io, 12))?.statuses[0]).toMatchObject({ state: "pending" });
  for (const scenario of [{ author: { login: "dependabot[bot]", type: "Bot" } }, { commits: ["by hand"] }]) {
    const w = statusWorld({ head: A, mergeBase: B, ...scenario });
    expect((await deriveStatuses(w.io, 12))?.statuses.map((status) => [status.context, status.state, status.description])).toEqual([
      ["agent-review", "success", "not an agent PR"],
      ["agent-threads", "success", "not an agent PR"],
    ]);
  }
  const off = statusWorld({ head: A, mergeBase: B, optedIn: false });
  expect(await deriveStatuses(off.io, 12)).toBeUndefined();
});

test("agent-threads fails while the owner's comment waits, naming it, and passes once an agent answers", async () => {
  const john = { id: 21, user: { login: "johnrees" }, performed_via_github_app: null, created_at: "2026-10-11T00:00:00Z", html_url: "https://github.com/johnrees/widget/pull/12#issuecomment-21", body: "Why this way?" };
  const waiting = statusWorld({ head: A, mergeBase: B, comments: [john] });
  expect((await deriveStatuses(waiting.io, 12))?.statuses[1]).toEqual({
    context: "agent-threads", state: "failure", description: "1 comment(s) await an agent's answer, first johnrees's comment on #12", targetUrl: john.html_url,
  });
  const answered = statusWorld({ head: A, mergeBase: B, comments: [john, { ...john, id: 22, performed_via_github_app: { id: CLAUDE }, created_at: "2026-10-11T01:00:00Z", body: "Because." }] });
  expect((await deriveStatuses(answered.io, 12))?.statuses[1]).toMatchObject({ state: "success" });
});

test("statuses are set only when they change, and a token that may not set them is reported, not fatal", async () => {
  const statuses = [
    { context: "agent-review", state: "pending", description: "needs a review", targetUrl: undefined },
    { context: "agent-threads", state: "success", description: "none", targetUrl: "https://x" },
  ] as const;
  const actions = { login: "github-actions[bot]" };
  const fresh = statusWorld({
    head: A, mergeBase: B,
    combined: [
      { context: "agent-review", state: "pending", description: "needs a review", creator: actions },
      { context: "agent-threads", state: "success", description: "none", target_url: "https://x", creator: actions },
    ],
  });
  await writeStatuses(fresh.io, A, statuses);
  expect(fresh.posted()).toEqual([]);
  // A new review with the same verdict links elsewhere: set again, so `review full` sees the workflow handled it.
  const relinked = statusWorld({ head: A, mergeBase: B, combined: [{ context: "agent-review", state: "pending", description: "needs a review", creator: actions }, { context: "agent-threads", state: "success", description: "none", target_url: "https://old", creator: actions }] });
  await writeStatuses(relinked.io, A, statuses);
  expect(relinked.posted().map((status) => status.context)).toEqual(["agent-threads"]);
  // The same status from an agent, which a check tied to GitHub Actions does not count, is set again by Actions.
  const migrated = statusWorld({ head: A, mergeBase: B, combined: [{ context: "agent-review", state: "pending", description: "needs a review", creator: { login: "johnrees" } }, { context: "agent-threads", state: "failure", description: "x", creator: actions }] });
  await writeStatuses(migrated.io, A, statuses);
  expect(migrated.posted()).toEqual([
    { state: "pending", context: "agent-review", description: "needs a review" },
    { state: "success", context: "agent-threads", description: "none", target_url: "https://x" },
  ]);
  const forked = statusWorld({ head: A, mergeBase: B, statusReply: 403 });
  await writeStatuses(forked.io, A, statuses);
  expect(forked.printed.at(-1)).toContain("this run's token may not set statuses (HTTP 403");
});

test("a run whose pull request changed while it wrote sets what GitHub shows now, so an older run never leaves its result over a newer one", async () => {
  // The owner comments (on the closing issue, say, whose run is in another concurrency group) just as this older run writes "no comment awaits".
  const john = { id: 21, user: { login: "johnrees" }, performed_via_github_app: null, created_at: "2026-10-11T00:00:00Z", html_url: "https://github.com/johnrees/widget/pull/12#issuecomment-21", body: "Wait." };
  const w = statusWorld({ head: A, mergeBase: B, commentWhileWriting: john });
  await statusCommand(w.io, { name: "pull_request_target", payload: { pull_request: { number: 12 } } }, undefined);
  const threads = w.posted().filter((status) => status.context === "agent-threads").map((status) => status.state);
  expect(threads).toEqual(["success", "failure"]);
  expect(w.printed).toContain("agent-gh: #12 changed while this run wrote its statuses; setting what it shows now");
  // Nothing changed: one derive after the write, and no second write.
  const still = statusWorld({ head: A, mergeBase: B });
  await statusCommand(still.io, { name: "pull_request_target", payload: { pull_request: { number: 12 } } }, undefined);
  expect(still.posted()).toHaveLength(2);
});

test("a run that cannot derive the statuses sets both to error on the head, so an earlier success never stands, and still fails", async () => {
  const w = statusWorld({ head: A, mergeBase: B, graphqlStatus: 502 });
  let refusal = "";
  await statusCommand(w.io, { name: "pull_request_target", payload: { pull_request: { number: 12 } } }, undefined).catch((error: Error) => (refusal = error.message));
  expect(refusal).toContain("HTTP 502 from POST /graphql");
  expect(w.posted()).toEqual(
    ["agent-review", "agent-threads"].map((context) => ({ state: "error", context, description: "agent-gh could not derive it: HTTP 502 from POST /graphql; rerun the workflow" })),
  );
});

test("a comment on an issue updates every open pull request here that closes it", async () => {
  const w = statusWorld({ head: A, mergeBase: B });
  await statusCommand(w.io, { name: "issue_comment", payload: { issue: { number: 7 } } }, undefined);
  expect(w.posted().map((status) => status.context)).toEqual(["agent-review", "agent-threads"]);
  expect(w.fake.log.some((entry) => entry.path.includes("/pulls/99"))).toBe(false);
  let refusal = "";
  await statusCommand(w.io, { name: "push", payload: {} }, undefined).catch((error: Error) => (refusal = error.message));
  expect(refusal).toContain("a push event names no pull request");
});

test("the reusable workflow is a workflow_call that sets the statuses with GITHUB_TOKEN, one run per pull request, and never checks out its code", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "agent-review.yml"), "utf8")) as Record<string, any>;
  expect(Object.keys(workflow.on)).toEqual(["workflow_call"]);
  // NTFY_URL is optional, and reaches agent-gh only through the step's environment.
  expect(workflow.on.workflow_call.secrets).toEqual({ NTFY_URL: { description: expect.any(String), required: false } });
  const job = workflow.jobs.status;
  // The writes post a hold's call and release record: commenting on a pull request needs pull-requests: write too (checked live).
  expect(job.permissions).toEqual({ contents: "read", issues: "write", "pull-requests": "write", statuses: "write" });
  expect(job.steps.at(-1).env.AGENT_GH_NTFY_URL).toBe("${{ secrets.NTFY_URL }}");
  expect(JSON.stringify(job.steps.slice(0, -1))).not.toContain("NTFY_URL");
  expect(job.concurrency.group).toContain("github.event.pull_request.number || github.event.issue.number");
  expect(job.concurrency["cancel-in-progress"]).toBe(true);
  const steps = JSON.stringify(job.steps);
  expect(steps).not.toContain("actions/checkout");
  expect(steps).toContain("sha256sum -c");
  expect(job.steps.at(-1).run).toBe("./agent-gh status");
  expect(job.steps.at(-1).env.GITHUB_TOKEN).toBe("${{ github.token }}");
});

test("the README's caller template grants the reusable workflow every scope it declares, on the events it handles", () => {
  const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
  const template = /```yaml\n(# \.github\/workflows\/agent-review\.yml[\s\S]*?)```/.exec(readme)?.[1];
  const caller = Bun.YAML.parse(template ?? "") as Record<string, any>;
  const reusable = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "agent-review.yml"), "utf8")) as Record<string, any>;
  expect(caller.jobs["agent-review"].permissions).toEqual(reusable.jobs.status.permissions);
  expect(caller.jobs["agent-review"].permissions).toMatchObject({ issues: "write", "pull-requests": "write" });
  expect(caller.jobs["agent-review"].uses).toStartWith("johnrees/agent-gh/.github/workflows/agent-review.yml@");
  expect(caller.jobs["agent-review"].secrets).toEqual({ NTFY_URL: "${{ secrets.NTFY_URL }}" });
  expect(Object.keys(caller.on)).toEqual(["pull_request_target", "pull_request_review", "issue_comment", "issues"]);
  // `edited`: a description that adds a closing issue brings that issue's comments into agent-threads.
  expect(caller.on.pull_request_target.types).toEqual(["opened", "edited", "synchronize", "reopened", "ready_for_review", "labeled", "unlabeled"]);
  // A hold's label on a plain issue holds the pull requests that close it, and calls John in on it.
  expect(caller.on.issues.types).toEqual(["labeled", "unlabeled"]);
});

// --- agent-hold ---

const HOLD = { label: "needs-human", paths: ["docs/security-claims.md", "schema/**", ".github/**"] } as const;
const LABELED = "2026-10-11T12:00:00Z";
const minutes = (offset: number) => new Date(Date.parse(LABELED) + offset * 60_000).toISOString();
const PERSON = { login: "johnrees", type: "User" };
/** An issue event: a label added or removed, by a person (no App) unless `app` names the one an agent acted through. */
const labelEvent = (id: number, event: "labeled" | "unlabeled", name: string, app: number | null, at: string, actor: { login: string; type: string } = PERSON) => ({
  id, event, label: { name }, actor, performed_via_github_app: app === null ? null : { id: app }, created_at: at,
});
const PR_URL = "https://github.com/johnrees/widget/pull/12";
const RELEASED_URL = `${PR_URL}#agent-hold-released`;
const thread = (ref: string, labels: string[], events: unknown[], ask?: string): HoldThread => ({ ref, labels, events: labelEvents(events), ...(ask === undefined ? {} : { ask }) });
/** The owner's own comment releasing `head`, ten minutes after the label, unless overridden. */
const releasing = (head: string, overrides: Partial<PostedBy> = {}): PostedBy => ({ author: "johnrees", body: releaseLine(head), edited: false, appId: undefined, at: minutes(10), id: 600, ...overrides });
const holdInput = (overrides: Partial<Parameters<typeof holdStatus>[0]> = {}): Parameters<typeof holdStatus>[0] => ({
  hold: HOLD, author: "agent", repo: "johnrees/widget", number: 12, owner: "johnrees", threads: [thread("#12", [], [])], files: [{ name: "src/a.ts", previous: undefined }],
  comments: [], head: A, sharedWith: [], ...overrides,
});
const description = (overrides: Partial<Parameters<typeof holdStatus>[0]>) => {
  const status = holdStatus(holdInput(overrides));
  return `${status.state}: ${status.description}`;
};
const file = (name: string, previous?: string) => ({ name, previous });

test("the hold's label holds while on the pull request or an issue it closes, and once gone, until the owner releases this head after it went on: no removal releases it", () => {
  // Each agent-hold links its pull request, so the merge guard reads only its own.
  expect(holdStatus(holdInput())).toEqual({ context: "agent-hold", state: "success", description: "not held", targetUrl: PR_URL });
  // A head that is another open pull request's too is held: the status on that commit is theirs as well.
  expect(description({ sharedWith: [13] })).toBe("failure: held: aaaaaaaa is also the head of #13, so neither is judged alone");
  const added = labelEvent(1, "labeled", "needs-human", CLAUDE, minutes(0));
  expect(description({ threads: [thread("#12", ["needs-human"], [added], "Drop the v1 schema?")] })).toBe("failure: held: `needs-human` on #12: Drop the v1 schema?");
  expect(description({ threads: [thread("#12", [], []), thread("#7", ["Needs-Human"], [added], "Which API?")] })).toBe("failure: held: `needs-human` on #7: Which API?");
  // GitHub records no App on a removal (checked live: an agent's reads `performed_via_github_app: null`), so none releases it, whoever's it looks.
  const removed = labelEvent(2, "unlabeled", "needs-human", null, minutes(5));
  expect(description({ threads: [thread("#12", [], [added, removed])] })).toBe("failure: held: `needs-human` came off #12, which releases nothing; John releases the head");
  expect(description({ threads: [thread("#12", [], []), thread("#7", [], [added, removed])] })).toContain("came off #7");
  // The owner's release of this head, after the label went on, releases it, on or off, and the status says it leans on that release.
  expect(holdStatus(holdInput({ threads: [thread("#12", ["needs-human"], [added], "Ask")], comments: [releasing(A)] }))).toEqual({
    context: "agent-hold", state: "success", description: "released by johnrees at aaaaaaaa", targetUrl: RELEASED_URL,
  });
  expect(description({ threads: [thread("#12", [], []), thread("#7", [], [added, removed])], comments: [releasing(A)] })).toBe("success: released by johnrees at aaaaaaaa");
  // Not one from before the label went on, nor one of another head (any push holds again), nor once the label goes on again.
  expect(description({ threads: [thread("#12", ["needs-human"], [added], "Ask")], comments: [releasing(A, { at: minutes(-1) })] })).toBe("failure: held: `needs-human` on #12: Ask");
  expect(description({ threads: [thread("#12", ["needs-human"], [added], "Ask")], comments: [releasing(B)] })).toBe("failure: held: `needs-human` on #12: Ask");
  const again = labelEvent(3, "labeled", "needs-human", CLAUDE, minutes(20));
  expect(description({ threads: [thread("#12", ["needs-human"], [added, again], "Again?")], comments: [releasing(A)] })).toBe("failure: held: `needs-human` on #12: Again?");
  // A person's own pull request is still held by the label; released, it is not an agent's.
  expect(description({ author: "person", threads: [thread("#12", ["needs-human"], [added], "Ask")] })).toBe("failure: held: `needs-human` on #12: Ask");
  expect(holdStatus(holdInput({ author: "person", threads: [thread("#12", [], [added, removed])], comments: [releasing(A)] }))).toMatchObject({ state: "success", description: "not an agent PR", targetUrl: RELEASED_URL });
});

test("only the owner's own comment, never edited, with the line naming this exact head, releases a reserved path; a push to another head holds it again", () => {
  const files = [file("schema/a.json")];
  expect(description({ files })).toBe("failure: held: touches `schema/**` (schema/a.json); John releases aaaaaaaa");
  expect(holdStatus(holdInput({ files, comments: [releasing(A)] }))).toEqual({ context: "agent-hold", state: "success", description: "released by johnrees at aaaaaaaa", targetUrl: RELEASED_URL });
  expect(description({ files, comments: [releasing(A, { author: "JohnRees", body: `Looks right.\n\n${releaseLine(A)}\n` })] })).toBe("success: released by johnrees at aaaaaaaa");
  for (const refused of [
    releasing(B), // another head: any push holds it again
    releasing(A, { appId: CLAUDE }), // an agent, posting as the owner
    releasing(A, { edited: true }), // edited since: an agent, acting as him, could have edited it
    releasing(A, { author: "mallory" }),
    releasing(A, { body: `please ${releaseLine(A)}` }), // not its own line
    releasing(A, { body: releaseLine(A.slice(0, 12)) }), // not the whole sha
  ]) {
    expect(description({ files, comments: [refused] })).toBe("failure: held: touches `schema/**` (schema/a.json); John releases aaaaaaaa");
  }
  expect(headRelease([releasing(A, { id: 601 }), releasing(A, { edited: true })], "johnrees", A)?.id).toBe(601);
  // The newest release counts: John releases, the label goes on again, and John releases this head again.
  const first = labelEvent(1, "labeled", "needs-human", CLAUDE, minutes(0));
  const again = labelEvent(2, "labeled", "needs-human", CLAUDE, minutes(20));
  const twice = [releasing(A, { at: minutes(10), id: 601 }), releasing(A, { at: minutes(30), id: 602 })];
  expect(description({ threads: [thread("#12", ["needs-human"], [first, again], "Again?")], comments: twice })).toBe("success: released by johnrees at aaaaaaaa");
  expect(headRelease(twice, "johnrees", A)?.id).toBe(602);
});

test("a reserved path holds a pull request, by its current name or a rename's old one; a person's own pull request is not held by its paths, and Dependabot's is", () => {
  const schema = [file("schema/request.schema.json"), file("schema/b.json"), file("src/x.ts"), file("schema/c.json")];
  expect(description({ files: schema })).toBe("failure: held: touches `schema/**` (schema/request.schema.json and 2 more); John releases aaaaaaaa");
  expect(description({ files: [file("old-schema/x.json", "schema/x.json")] })).toBe("failure: held: touches `schema/**` (old-schema/x.json); John releases aaaaaaaa");
  // A dot directory matches when the pattern names it.
  expect(description({ files: [file(".github/workflows/ci.yml"), file("docs/security-claims.md")] })).toBe(
    "failure: held: touches `docs/security-claims.md`, `.github/**` (.github/workflows/ci.yml and 1 more); John releases aaaaaaaa",
  );
  expect(description({ files: [file("schemas/x.json"), file("docs/other.md")] })).toBe("success: not held");
  expect(reservedFiles([file("new.json", "schema/old.json"), file("src/a.ts")], HOLD.paths)).toEqual({ files: ["new.json"], patterns: ["schema/**"] });
  expect(description({ author: "person", files: schema })).toBe("success: not an agent PR");
  expect(description({ author: "bot", files: schema })).toContain("held: touches `schema/**`");
  expect(holdLink("johnrees/widget", 12, false)).toBe(PR_URL);
  expect(holdLink("johnrees/widget", 12, true)).toBe(RELEASED_URL);
});

test("the ask is the newest agent comment in the 15 minutes before the label, its first line without markers, inert, and at most 200 characters", () => {
  // `null`: the owner's own comment, through no App.
  const at = (id: number, offset: number, body: string, appId: number | null = CLAUDE, author = "johnrees") => comment(id, author, appId ?? undefined, minutes(offset), { body });
  const comments = [
    at(1, -20, "Too early."),
    at(2, -10, "An older ask."),
    at(3, -1, `${notifyMarker({ v: 1, id: "00000003", severity: "P1" })}\n\n   Should we drop the v1 schema?\nThe details.`),
    at(4, -0.5, "A person's note.", null),
    at(5, 1, "After the label."),
  ];
  expect(askFor(comments, LABELED, "johnrees", [CLAUDE])).toEqual({ line: "Should we drop the v1 schema?", url: "https://github.com/c/3" });
  expect(askFor(comments.slice(0, 1), LABELED, "johnrees", [CLAUDE])).toEqual({ line: NO_ASK, url: undefined });
  expect(askFor([at(6, -2, "Owner's own, no App.", null), at(7, -2, "Another App's.", OTHER_APP)], LABELED, "johnrees", [CLAUDE]).line).toBe(NO_ASK);
  expect(firstLine(`${"x".repeat(250)}\nsecond`)).toBe(`${"x".repeat(199)}…`);
  expect(firstLine("<!-- agent-notify {} --> <!-- forged")).toBe("&lt;!-- forged");
  expect(firstLine("<!-- only a marker -->\n\n")).toBeUndefined();
  // The call mentions the owner, never anyone the ask names, and names the line that releases this head.
  const body = callBody({ owner: "jr-owner", ref: "#12", hold: HOLD, ask: { line: "Ask @mallory?", url: "https://x/3" }, event: 900, head: A });
  expect(body.split("\n")[0]).toBe("@jr-owner, an agent needs you on #12: Ask @\u200bmallory?");
  expect(body).toContain("[The ask](https://x/3)");
  expect(body).toContain(`comment the line \`${releaseLine(A)}\`. It releases this head alone, so a later push is held again.`);
  expect(body).toContain("Removing `needs-human` releases nothing");
  expect(body.endsWith(callMarker({ v: 1, event: 900 }))).toBe(true);
  expect(callBody({ owner: "jr-owner", ref: "#7", hold: HOLD, ask: { line: "Ask", url: undefined }, event: 901 })).toContain("on each pull request that closes this issue");
});

test("a person, and no App or bot, is who labelEvents says added a label, and no removal is a person's", () => {
  const events = labelEvents([
    labelEvent(1, "labeled", "x", null, LABELED),
    labelEvent(2, "labeled", "x", CLAUDE, LABELED),
    labelEvent(3, "labeled", "x", null, LABELED, { login: "github-actions[bot]", type: "Bot" }),
    labelEvent(4, "labeled", "x", null, LABELED, { login: "renovate[bot]", type: "User" }),
    // A removal is never known to be a person's: GitHub records no App on one.
    labelEvent(5, "unlabeled", "x", null, LABELED),
    { id: 6, event: "commented", created_at: LABELED },
  ]);
  expect(events.map((event) => [event.id, event.person])).toEqual([[1, true], [2, false], [3, false], [4, false], [5, false]]);
});

test("the workflow sets agent-hold from the base branch's hold, never the pull request's own config, from the files git shows between the merge base and the head, released for that head alone; and a label on an issue it closes holds it", async () => {
  // The changed files come from git, between the merge base and the head: here, a.txt.
  const repo = history();
  const real = (head: string, mergeBase: string) => {
    repo.git(["update-ref", "refs/pull/12/head", head]);
    return { head, mergeBase, remote: `file://${repo.dir}` };
  };
  const w = statusWorld({ ...real(repo.head1, repo.mb1), hold: { paths: ["*.txt"] } });
  const derived = await deriveStatuses(w.io, 12);
  expect(derived?.statuses.map((status) => status.context)).toEqual(["agent-review", "agent-threads", "agent-hold"]);
  expect(derived?.statuses[2]).toMatchObject({ state: "failure", description: `held: touches \`*.txt\` (a.txt); John releases ${repo.head1.slice(0, 8)}` });
  // The pull request's own copy of the config (any other ref) drops the hold: only the base branch's is read.
  expect(new Set(w.configRefs)).toEqual(new Set(["main"]));
  expect((await deriveStatuses(statusWorld({ ...real(repo.head1, repo.mb1), hold: { paths: ["b.txt"] } }).io, 12))?.statuses[2]).toMatchObject({ state: "success", description: "not held" });
  // The owner's release of this head passes it; pushed (rebased) to another head, it is held again.
  const release = { id: 300, user: { login: "johnrees" }, performed_via_github_app: null, created_at: minutes(1), updated_at: minutes(1), body: releaseLine(repo.head1) };
  expect((await deriveStatuses(statusWorld({ ...real(repo.head1, repo.mb1), hold: { paths: ["a.txt"] }, comments: [release] }).io, 12))?.statuses[2]).toEqual({
    context: "agent-hold", state: "success", description: `released by johnrees at ${repo.head1.slice(0, 8)}`, targetUrl: RELEASED_URL,
  });
  expect((await deriveStatuses(statusWorld({ ...real(repo.head2, repo.mb2), hold: { paths: ["a.txt"] }, comments: [release] }).io, 12))?.statuses[2]).toMatchObject({ state: "failure" });
  const onIssue = statusWorld({
    head: A, mergeBase: B, hold: {}, issueLabels: ["needs-human"], issueEvents: [labelEvent(80, "labeled", "needs-human", CLAUDE, LABELED)],
    issueComments: [{ id: 71, user: { login: "johnrees" }, performed_via_github_app: { id: CLAUDE }, created_at: minutes(-3), html_url: "https://github.com/johnrees/widget/issues/7#issuecomment-71", body: "Which API version?" }],
  });
  expect((await deriveStatuses(onIssue.io, 12))?.statuses[2]).toMatchObject({ state: "failure", description: "held: `needs-human` on #7: Which API version?" });
  // Dependabot's pull request is not an agent's, but reserved paths still hold it; a person's own is not held by its paths, so git is never read.
  const dependabot = statusWorld({ ...real(repo.head1, repo.mb1), author: { login: "dependabot[bot]", type: "Bot" }, hold: { paths: ["a.txt"] } });
  expect((await deriveStatuses(dependabot.io, 12))?.statuses.map((status) => [status.context, status.state])).toEqual([["agent-review", "success"], ["agent-threads", "success"], ["agent-hold", "failure"]]);
  const person = statusWorld({ head: A, mergeBase: B, commits: ["by hand"], hold: { paths: ["a.txt"] } });
  expect((await deriveStatuses(person.io, 12))?.statuses[2]).toMatchObject({ state: "success", description: "not an agent PR" });
  expect(person.gitCalls).toEqual([]);
  // Commits git cannot fetch are never judged on a guess.
  let refusal = "";
  await deriveStatuses(statusWorld({ head: A, mergeBase: B, hold: { paths: ["a.txt"] } }).io, 12).catch((error: Error) => (refusal = error.message));
  expect(refusal).toContain("could not fetch aaaaaaaa and its merge base to read #12's changed files");
}, 30_000);

/** An agent's comment on #12, posted as `owner` through Claude's App. */
const agentSays = (id: number, offset: number, body: string, owner = "johnrees") => ({
  id, user: { login: owner }, performed_via_github_app: { id: CLAUDE }, created_at: minutes(offset), html_url: `https://github.com/johnrees/widget/pull/12#issuecomment-${id}`, body,
});
const LABELED_EVENT = { name: "pull_request_target", payload: { action: "labeled", pull_request: { number: 12 } } };

test("when the label goes on, the workflow calls the owner the API names in once per labeled event, with the ask, and pushes it to NTFY_URL", async () => {
  const added = labelEvent(900, "labeled", "needs-human", CLAUDE, LABELED, { login: "jr-owner", type: "User" });
  const w = statusWorld({
    head: A, mergeBase: B, owner: "jr-owner", hold: {}, labels: ["needs-human"], events: [added], ntfy: "ok",
    comments: [agentSays(1, -20, "Too early.", "jr-owner"), agentSays(2, -2, "<!-- agent-notify {} -->\nShould @mallory's API stay?\nMore.", "jr-owner")],
  });
  await statusCommand(w.io, LABELED_EVENT, undefined);
  const [call] = w.commented(12);
  expect(w.commented(12)).toHaveLength(1);
  expect(call?.split("\n")[0]).toBe("@jr-owner, an agent needs you on #12: Should @\u200bmallory's API stay?");
  expect(call).toContain("[The ask](https://github.com/johnrees/widget/pull/12#issuecomment-2)");
  expect(call).toContain(callMarker({ v: 1, event: 900 }));
  expect(w.posted().find((status) => status.context === "agent-hold")).toMatchObject({ state: "failure", description: "held: `needs-human` on #12: Should @mallory's API stay?" });
  expect(w.pushes()).toHaveLength(1);
  expect(w.pushes()[0]).toMatchObject({ method: "POST", body: "Should @mallory's API stay?", headers: { title: "johnrees/widget#12 needs you", click: "https://github.com/johnrees/widget/pull/12", tags: "raised_hand" } });
  // A rerun, or any later run, finds the call and posts nothing, pushes nothing.
  await statusCommand(w.io, LABELED_EVENT, undefined);
  await statusCommand(w.io, { name: "issue_comment", payload: { issue: { number: 12, pull_request: {} } } }, undefined);
  expect(w.commented(12)).toHaveLength(1);
  expect(w.pushes()).toHaveLength(1);
  expect(w.printed.join("\n")).not.toContain(TOPIC);
  // A call marker anyone but github-actions[bot] posted suppresses nothing.
  const faked = statusWorld({ head: A, mergeBase: B, hold: {}, labels: ["needs-human"], events: [added], comments: [{ ...agentSays(3, -1, callMarker({ v: 1, event: 900 })), performed_via_github_app: { id: CLAUDE } }] });
  await statusCommand(faked.io, LABELED_EVENT, undefined);
  expect(faked.commented(12)).toHaveLength(1);
});

test("with no ask in the window the call says so; a label the owner adds himself calls no one; without NTFY_URL no push is sent, and a failed push only warns, never naming the URL", async () => {
  const byAgent = labelEvent(900, "labeled", "needs-human", CLAUDE, LABELED);
  const quiet = statusWorld({ head: A, mergeBase: B, hold: {}, labels: ["needs-human"], events: [byAgent] });
  await statusCommand(quiet.io, LABELED_EVENT, undefined);
  expect(quiet.commented(12)[0]?.split("\n")[0]).toBe(`@johnrees, an agent needs you on #12: ${NO_ASK}`);
  expect(quiet.commented(12)[0]).toContain("No agent posted an ask in the 15 minutes before the label went on");
  expect(quiet.pushes()).toEqual([]);
  const himself = statusWorld({ head: A, mergeBase: B, hold: {}, labels: ["needs-human"], events: [labelEvent(900, "labeled", "needs-human", null, LABELED)], ntfy: "ok" });
  await statusCommand(himself.io, LABELED_EVENT, undefined);
  expect(himself.commented(12)).toEqual([]);
  expect(himself.pushes()).toEqual([]);
  for (const [ntfy, warning] of [["fails", "agent-gh: warning: the push to NTFY_URL failed (HTTP 500); the comment stands"], ["unreachable", "agent-gh: warning: could not reach NTFY_URL; the comment stands"]] as const) {
    const w = statusWorld({ head: A, mergeBase: B, hold: {}, labels: ["needs-human"], events: [byAgent], ntfy });
    await statusCommand(w.io, LABELED_EVENT, undefined);
    expect(w.commented(12)).toHaveLength(1);
    expect(w.printed).toContain(warning);
    expect(w.printed.join("\n")).not.toContain(TOPIC);
    expect(w.printed.join("\n")).not.toContain("127.0.0.1");
  }
});

test("a label added and removed before a run read it still holds, so the call is still made; once a person releases it, none is", async () => {
  const added = labelEvent(900, "labeled", "needs-human", CLAUDE, LABELED);
  const removed = labelEvent(901, "unlabeled", "needs-human", null, minutes(0.1));
  const gone = statusWorld({ head: A, mergeBase: B, hold: {}, events: [added, removed], comments: [agentSays(2, -1, "Which way?")] });
  await statusCommand(gone.io, { name: "pull_request_target", payload: { action: "unlabeled", pull_request: { number: 12 } } }, undefined);
  expect(gone.commented(12)).toHaveLength(1);
  expect(gone.commented(12)[0]?.split("\n")[0]).toBe("@johnrees, an agent needs you on #12: Which way?");
  expect(gone.posted().find((status) => status.context === "agent-hold")).toMatchObject({ description: "held: `needs-human` came off #12, which releases nothing; John releases the head" });
  // Once the owner has released this head, no call is made.
  const release = { id: 300, user: { login: "johnrees" }, performed_via_github_app: null, created_at: minutes(5), updated_at: minutes(5), body: releaseLine(A) };
  const released = statusWorld({ head: A, mergeBase: B, hold: {}, events: [added, removed], comments: [release] });
  await statusCommand(released.io, LABELED_EVENT, undefined);
  expect(released.commented(12)).toEqual([]);
  expect(released.posted().find((status) => status.context === "agent-hold")).toMatchObject({ state: "success", description: "released by johnrees at aaaaaaaa", target_url: RELEASED_URL });
});

test("a label on a plain issue calls the owner in there and holds every open pull request here that closes it", async () => {
  const w = statusWorld({
    head: A, mergeBase: B, hold: {}, issueLabels: ["needs-human"], issueEvents: [labelEvent(80, "labeled", "needs-human", CLAUDE, LABELED)], ntfy: "ok",
    issueComments: [{ id: 71, user: { login: "johnrees" }, performed_via_github_app: { id: CLAUDE }, created_at: minutes(-3), html_url: "https://github.com/johnrees/widget/issues/7#issuecomment-71", body: "Which API version?" }],
  });
  await statusCommand(w.io, { name: "issues", payload: { action: "labeled", issue: { number: 7 } } }, undefined);
  expect(w.posted().find((status) => status.context === "agent-hold")).toMatchObject({ state: "failure", description: "held: `needs-human` on #7: Which API version?" });
  expect(w.commented(7)).toHaveLength(1);
  expect(w.commented(7)[0]?.split("\n")[0]).toBe("@johnrees, an agent needs you on #7: Which API version?");
  expect(w.commented(12)).toEqual([]);
  expect(w.pushes()[0]?.headers).toMatchObject({ title: "johnrees/widget#7 needs you", click: "https://github.com/johnrees/widget/issues/7" });
  // Every page of the pull requests that close it is read: one on the second page is held too.
  const paged = statusWorld({ head: A, mergeBase: B, hold: {}, closingPages: 2, issueLabels: ["needs-human"], issueEvents: [labelEvent(80, "labeled", "needs-human", CLAUDE, LABELED)] });
  await statusCommand(paged.io, { name: "issues", payload: { action: "labeled", issue: { number: 7 } } }, undefined);
  expect(paged.posted().find((status) => status.context === "agent-hold")).toMatchObject({ state: "failure" });
  expect(paged.fake.log.filter((entry) => entry.body.includes("closedByPullRequestsReferences")).map((entry) => JSON.parse(entry.body).variables.after)).toEqual([null, "c1"]);
});

test("a head another open pull request shares is held: the status on that commit is theirs too", async () => {
  const w = statusWorld({ head: A, mergeBase: B, hold: {}, sharedWith: [13] });
  expect((await deriveStatuses(w.io, 12))?.statuses[2]).toEqual({
    context: "agent-hold", state: "failure", description: "held: aaaaaaaa is also the head of #13, so neither is judged alone",
    targetUrl: PR_URL,
  });
  expect((await deriveStatuses(statusWorld({ head: A, mergeBase: B, hold: {} }).io, 12))?.statuses[2]).toMatchObject({ state: "success", description: "not held" });
});

test("two runs that call the owner in at once leave one call: the later removes itself and pushes nothing", async () => {
  const added = labelEvent(900, "labeled", "needs-human", CLAUDE, LABELED);
  const theirs = { id: 4000, user: { login: "github-actions[bot]" }, created_at: minutes(1), updated_at: minutes(1), body: callMarker({ v: 1, event: 900 }) };
  const w = statusWorld({ head: A, mergeBase: B, hold: {}, labels: ["needs-human"], events: [added], ntfy: "ok", callRace: theirs });
  await statusCommand(w.io, LABELED_EVENT, undefined);
  expect(w.commented(12)).toHaveLength(1);
  expect(w.fake.log.filter((entry) => entry.method === "DELETE").map((entry) => entry.path)).toEqual([`${REPO}/issues/comments/5001`]);
  expect(w.pushes()).toEqual([]);
  expect(w.printed).toContain("agent-gh: another run called johnrees in on #12 at the same moment; this run's call is removed");
});

test("one pull request an issue's label reaches that cannot be judged is set to error, the rest are still settled, the owner is still called, and the run fails", async () => {
  const w = statusWorld({
    head: A, mergeBase: B, hold: { paths: ["schema/**"] }, alsoClosing: true, ntfy: "ok",
    issueLabels: ["needs-human"], issueEvents: [labelEvent(80, "labeled", "needs-human", CLAUDE, LABELED)],
  });
  let refusal = "";
  await statusCommand(w.io, { name: "issues", payload: { action: "labeled", issue: { number: 7 } } }, undefined).catch((error: Error) => (refusal = error.message));
  // #12's commits cannot be fetched (its remote is nowhere), so it cannot be judged.
  expect(refusal).toContain("could not fetch aaaaaaaa and its merge base to read #12's changed files");
  expect(w.posted().map((status) => [status.context, status.state])).toEqual([["agent-review", "error"], ["agent-threads", "error"], ["agent-hold", "error"]]);
  expect(w.printed).toContain("agent-gh: #13 is closed; no status set");
  expect(w.commented(7)).toHaveLength(1);
});

test("a run that cannot derive agent-hold sets it to error with the others, and a pull request closing more issues than GitHub lists cannot be read", async () => {
  const w = statusWorld({ head: A, mergeBase: B, hold: {}, graphqlStatus: 502 });
  await statusCommand(w.io, LABELED_EVENT, undefined).catch(() => undefined);
  expect(w.posted().map((status) => [status.context, status.state])).toEqual([["agent-review", "error"], ["agent-threads", "error"], ["agent-hold", "error"]]);
  let refusal = "";
  await deriveStatuses(statusWorld({ head: A, mergeBase: B, hold: {}, closingTotal: 26 }).io, 12).catch((error: Error) => (refusal = error.message));
  expect(refusal).toContain("#12 closes over 25 issues, too many to read");
});

const WORKFLOWS = ["agent-review", "agent-claims"] as const;
const workflow = (name: string): Record<string, any> =>
  Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", `${name}.yml`), "utf8")) as Record<string, any>;
const jobOf = (name: string): Record<string, any> => Object.values(workflow(name).jobs)[0] as Record<string, any>;
const downloadScript = (name: string): string => jobOf(name).steps[0].run;
/** The shell function that picks the release asset, as written in the workflow. */
const assetFunction = (name: string): string => /^agent_gh_asset\(\) \{\n[\s\S]*?^\}$/m.exec(downloadScript(name))?.[0] ?? "";

test("each reusable workflow takes a runs-on input, defaulting to ubuntu-latest, that is a label or a JSON list", () => {
  for (const name of WORKFLOWS) {
    const input = workflow(name).on.workflow_call.inputs["runs-on"];
    expect(input.type).toBe("string");
    expect(input.default).toBe("ubuntu-latest");
    expect(jobOf(name)["runs-on"]).toBe("${{ startsWith(inputs.runs-on, '[') && fromJSON(inputs.runs-on) || inputs.runs-on }}");
  }
});

test("the download step picks the release asset from the runner's OS and architecture, checks it, and refuses any other runner", () => {
  expect(assetFunction("agent-review")).not.toBe("");
  expect(assetFunction("agent-claims")).toBe(assetFunction("agent-review"));
  for (const name of WORKFLOWS) {
    const script = downloadScript(name);
    expect(script).toContain('asset=$(agent_gh_asset)');
    expect(script).toContain('grep " $asset\\$" SHA256SUMS | sha256sum -c -');
    expect(script).not.toContain("-o agent-gh-linux-x64");
  }
  const bin = mkdtempSync(join(tmpdir(), "agent-gh-uname-"));
  const uname = join(bin, "uname");
  writeFileSync(uname, '#!/bin/sh\ncase "$1" in -s) echo "$FAKE_OS" ;; -m) echo "$FAKE_ARCH" ;; esac\n');
  chmodSync(uname, 0o755);
  const pick = (os: string, arch: string) => {
    const run = Bun.spawnSync(["bash", "-c", `set -eu\n${assetFunction("agent-review")}\nasset=$(agent_gh_asset)\necho "$asset"`], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_OS: os, FAKE_ARCH: arch },
      stdout: "pipe", stderr: "pipe",
    });
    return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString() };
  };
  expect(pick("Linux", "x86_64")).toMatchObject({ code: 0, out: "agent-gh-linux-x64" });
  expect(pick("Linux", "aarch64")).toMatchObject({ code: 0, out: "agent-gh-linux-arm64" });
  expect(pick("Linux", "arm64")).toMatchObject({ code: 0, out: "agent-gh-linux-arm64" });
  for (const [os, arch] of [["Linux", "riscv64"], ["Darwin", "arm64"]] as const) {
    const refused = pick(os, arch);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toBe("");
    expect(refused.err).toContain(`${os} ${arch}`);
    expect(refused.err).toContain("runs-on");
  }
});

test("the README's caller templates show the runs-on input, commented out", () => {
  const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
  for (const name of WORKFLOWS) {
    const template = new RegExp(`\`\`\`yaml\\n(# \\.github/workflows/${name}\\.yml[\\s\\S]*?)\`\`\``).exec(readme)?.[1] ?? "";
    expect(template).toContain("      # runs-on: ubicloud-standard-2 # only once this pin is a release that has the input\n");
    expect((Bun.YAML.parse(template) as Record<string, any>).jobs[name].with).not.toHaveProperty("runs-on");
  }
});
