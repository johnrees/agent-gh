import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentApps } from "../src/config.ts";
import { reviewMarker, type ReviewMarker } from "../src/review.ts";
import { pullDiff } from "../src/review-run.ts";
import { agentCommit, agentPull, carryCandidate, eventTarget, type FoundMarker, reviewStatus, validMarkers } from "../src/status.ts";
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
const found = (overrides: Partial<ReviewMarker>, at: string): FoundMarker => ({ marker: marker(overrides), at, url: `https://github.com/r/${at}` });

test("an event names its pull request; a comment on a plain issue names the issue whose closing pull requests count", () => {
  for (const name of ["pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment"]) {
    expect(eventTarget(name, { pull_request: { number: 12 } })).toEqual({ pull: 12 });
  }
  expect(eventTarget("issue_comment", { issue: { number: 12, pull_request: { url: "x" } } })).toEqual({ pull: 12 });
  expect(eventTarget("issue_comment", { issue: { number: 7 } })).toEqual({ issue: 7 });
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
  expect(carryCandidate([approved, other], C)).toBe(approved);
  expect(carryCandidate([approved, blocked, other], C)).toBeUndefined();
  expect(carryCandidate([approved], D)).toBeUndefined();
  expect(carryCandidate([found({ patch_id: null }, "1")], null)).toBeUndefined();
});

test("agent-review: not an agent's, waived, the head's own verdict, carried forward, else pending with the command", () => {
  const base = { number: 12, agent: true, waivedBy: undefined, current: undefined, carried: undefined, blockOn: "changes_requested" } as const;
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
};

const statusWorld = (scenario: Scenario) => {
  const { head, author = { login: "johnrees", type: "User" }, labels = [], events = [], reviews = [], comments = [], commits = ["x\n\nAgent-Harness: claude"], combined = [], optedIn = true } = scenario;
  const fake = fakeGitHub({
    [`GET ${REPO}/pulls/12`]: () => reply(200, { state: "open", head: { sha: head }, base: { ref: "main" }, labels: labels.map((name) => ({ name })), created_at: "2026-10-10T00:00:00Z", user: author }),
    [`GET ${REPO}/contents/.github/agent-review.json`]: () =>
      optedIn ? reply(200, { content: Buffer.from(JSON.stringify({ reviewers: { codex: { model: "m" } }, status_writer: "actions" })).toString("base64") }) : reply(404, {}),
    [`GET ${REPO}`]: () => reply(200, { default_branch: "main", owner: { login: "johnrees" } }),
    [`GET ${REPO}/issues/12`]: () => reply(200, { performed_via_github_app: null }),
    [`GET ${REPO}/pulls/12/commits`]: (_, url) => {
      // As GitHub lists them: 100 a page, and never past the 250th.
      const at = (Number(url.searchParams.get("page") ?? 1) - 1) * 100;
      return reply(200, commits.slice(0, 250).slice(at, at + 100).map((message) => ({ commit: { message } })));
    },
    [`GET ${REPO}/issues/12/events`]: () => reply(200, events),
    [`GET ${REPO}/pulls/12/reviews`]: () => reply(200, reviews),
    [`GET ${REPO}/issues/12/comments`]: () => reply(200, comments),
    [`GET ${REPO}/issues/7/comments`]: () => reply(200, []),
    [`GET ${REPO}/compare/main...${head}`]: () => reply(200, { merge_base_commit: { sha: scenario.mergeBase } }),
    [`GET ${REPO}/commits/${head}/statuses`]: () => reply(200, combined),
    [`POST ${REPO}/statuses/${head}`]: () => reply(scenario.statusReply ?? 201, {}),
    "POST /graphql": (body) =>
      body.includes("closedByPullRequestsReferences")
        ? reply(200, { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [{ number: 12, repository: { nameWithOwner: "johnrees/widget" } }, { number: 99, repository: { nameWithOwner: "other/repo" } }] } } } } })
        : reply(200, { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 7, repository: { nameWithOwner: "johnrees/widget" } }] } } } } }),
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
    git: async (args, input) => {
      gitCalls.push(args.join(" "));
      return runGit(env, scratch, args, input);
    },
    print: (line) => printed.push(line),
  };
  const posted = () => fake.log.filter((entry) => entry.method === "POST" && entry.path.startsWith(`${REPO}/statuses/`)).map((entry) => JSON.parse(entry.body) as Record<string, unknown>);
  return { fake, io, gitCalls, printed, posted };
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
      { context: "agent-threads", state: "success", description: "none", creator: actions },
    ],
  });
  await writeStatuses(fresh.io, A, statuses);
  expect(fresh.posted()).toEqual([]);
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
  const job = workflow.jobs.status;
  expect(job.permissions).toEqual({ contents: "read", issues: "read", "pull-requests": "read", statuses: "write" });
  expect(job.concurrency.group).toContain("github.event.pull_request.number || github.event.issue.number");
  expect(job.concurrency["cancel-in-progress"]).toBe(true);
  const steps = JSON.stringify(job.steps);
  expect(steps).not.toContain("actions/checkout");
  expect(steps).toContain("sha256sum -c");
  expect(job.steps.at(-1).run).toBe("./agent-gh-linux-x64 status");
  expect(job.steps.at(-1).env.GITHUB_TOKEN).toBe("${{ github.token }}");
});
