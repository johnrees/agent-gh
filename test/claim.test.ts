import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimBranchIssue,
  claimCommitMessage,
  claimMarker,
  claimsOn,
  firstTake,
  linkedIssues,
  mismatch,
  mine,
  parseClaim,
  parseClaimArgs,
  parseTake,
  releaseMarker,
  retakeBody,
  sessionId,
  takeCommentBody,
  takesOf,
  taken,
  titleSlug,
} from "../src/claim.ts";
import { claim, type ClaimIo, claimsLines, eventIssues, holderOf, listClaims, release, syncLabels, take, UNKNOWN } from "../src/claim-run.ts";
import { adoptedCommits } from "../src/review-run.ts";
import { apiReader, claimNext } from "../src/next-run.ts";
import { fakeGitHub, reply } from "./fake-github.ts";

const REPO = { owner: "johnrees", name: "widget" };
const PATH = "/repos/johnrees/widget";
const NOW = Date.parse("2026-10-15T12:00:00Z");
const marker = (issue: number, family = "claude", session = "s-one", id = "0123456789abcdef") => claimMarker({ v: 1, issue, family, session, id });

test("a description links an issue with a closing keyword or Refs, never by a bare mention or in another repository", () => {
  expect(linkedIssues("Closes #7.", REPO)).toEqual([7]);
  expect(linkedIssues("fixed: #7, resolves johnrees/widget#8, Refs https://github.com/johnrees/widget/issues/9", REPO)).toEqual([7, 8, 9]);
  expect(linkedIssues("Unlike #7, this follows #8. Prefixes #9.", REPO)).toEqual([]);
  expect(linkedIssues("Closes johnrees/other#7 and fixes https://github.com/johnrees/other/issues/8", REPO)).toEqual([]);
  expect(linkedIssues("Closes #70", REPO)).toEqual([70]);
});

test("claim and release markers read back; a malformed one reads as none", () => {
  expect(parseClaim(`text\n${marker(7)}\nmore`)).toEqual({ v: 1, issue: 7, family: "claude", session: "s-one", id: "0123456789abcdef" });
  expect(parseClaim('<!-- agent-claim {"v":1,"issue":"7","family":"claude","session":"s","id":"0123456789abcdef"} -->')).toBeUndefined();
  expect(parseClaim('<!-- agent-claim {"v":1,"issue":7,"family":"claude","session":"a b","id":"0123456789abcdef"} -->')).toBeUndefined();
  expect(parseClaim("<!-- agent-claim {broken} -->")).toBeUndefined();
});

const pull = (number: number, body: string, extra: Record<string, unknown> = {}) => ({
  number, state: "open", body, draft: true, html_url: `https://github.com/johnrees/widget/pull/${number}`, user: { login: "johnrees" },
  head: { ref: `claude/7-x-${number}`, sha: "a".repeat(40), repo: { full_name: "johnrees/widget" } }, created_at: "2026-10-15T10:00:00Z", ...extra,
});
const comment = (id: number, body: string, association = "OWNER") => ({
  id, body, author_association: association, user: { login: "johnrees" }, created_at: "2026-10-15T09:00:00Z", html_url: `https://github.com/johnrees/widget/issues/7#issuecomment-${id}`,
});
const OPEN = { number: 7, state: "open", title: "Fix the widget" };

test("the rule: the earliest claim holds the issue, a pull request before a comment within the same second, then the lowest number; only a writer's live comment claims count", () => {
  const pulls = [pull(40, `Closes #7.\n${marker(7, "codex", "late")}`), pull(31, `Refs #7.\n${marker(7)}`), pull(12, "Unlike #7"), pull(13, marker(8))];
  const later = (item: ReturnType<typeof comment>, at = "2026-10-15T10:00:00Z") => ({ ...item, created_at: at });
  const comments = [later(comment(900, marker(7, "glm", "c", "aaaaaaaaaaaaaaaa"))), comment(800, marker(7, "kimi", "x", "bbbbbbbbbbbbbbbb"), "NONE")];
  const result = taken(REPO, OPEN, pulls, comments);
  expect(result.taken).toBe(true);
  expect(result.claims.map((item) => [item.kind, item.pr ?? item.comment, item.family])).toEqual([["pr", 31, "claude"], ["pr", 40, "codex"], ["comment", 900, "glm"]]);
  expect(result.holder?.session).toBe("s-one");
  // A comment claim posted before a pull request holds the issue, whichever kind the later one is.
  const early = comment(901, marker(7, "glm", "c", "aaaaaaaaaaaaaaaa"));
  expect(taken(REPO, OPEN, pulls, [early]).holder).toMatchObject({ kind: "comment", comment: 901 });
  expect(taken(REPO, OPEN, [pull(41, marker(7), { created_at: "2026-10-15T08:59:59Z" })], [early]).holder).toMatchObject({ kind: "pr", pr: 41 });
  // A person's pull request that closes the issue takes it, with no marker.
  expect(taken(REPO, OPEN, [pull(5, "Fixes #7")], []).holder).toMatchObject({ pr: 5, family: null, author: "johnrees" });
  // A released comment claim, a closed issue, and a pull request number are never taken.
  expect(taken(REPO, OPEN, [], [comment(900, marker(7, "glm", "c", "aaaaaaaaaaaaaaaa")), comment(901, releaseMarker({ v: 1, id: "aaaaaaaaaaaaaaaa" }))]).taken).toBe(false);
  expect(taken(REPO, { ...OPEN, state: "closed" }, pulls, comments).taken).toBe(false);
  expect(taken(REPO, { ...OPEN, pull_request: {} }, pulls, comments).taken).toBe(false);
  // A release by someone without write access releases nothing.
  expect(taken(REPO, OPEN, [], [comment(900, marker(7, "glm", "c", "aaaaaaaaaaaaaaaa")), comment(901, releaseMarker({ v: 1, id: "aaaaaaaaaaaaaaaa" }), "NONE")]).taken).toBe(true);
  expect(claimsOn(REPO, 7, [pull(31, marker(7), { state: "closed" })], [])).toEqual([]);
});

test("the label disagrees with the claims when it marks a free issue, or misses an agent's claim", () => {
  const agent = taken(REPO, OPEN, [pull(31, marker(7))], []).claims;
  const person = taken(REPO, OPEN, [pull(5, "Fixes #7")], []).claims;
  expect(mismatch(7, true, [])).toEqual({ issue: 7, labeled: true, claimed: false });
  expect(mismatch(7, false, agent)).toEqual({ issue: 7, labeled: false, claimed: true });
  expect(mismatch(7, false, person)).toBeUndefined();
  expect(mismatch(7, true, agent)).toBeUndefined();
});

test("the session is the harness's own id, AGENT_GH_SESSION first, else a new one", () => {
  expect(sessionId({ CLAUDE_CODE_SESSION_ID: "1a811df7-f1a4", CODEX_THREAD_ID: "t" })).toEqual({ id: "1a811df7-f1a4", generated: false });
  expect(sessionId({ CODEX_THREAD_ID: "thread-9" })).toEqual({ id: "thread-9", generated: false });
  expect(sessionId({ AGENT_GH_SESSION: "mine", CLAUDE_CODE_SESSION_ID: "c" })).toEqual({ id: "mine", generated: false });
  expect(sessionId({ CLAUDE_CODE_SESSION_ID: "has space" }, () => "f00d")).toEqual({ id: "f00d", generated: true });
});

test("a branch slug is the title's words, cut at a word within 40 characters", () => {
  expect(titleSlug("Fix the widget!")).toBe("fix-the-widget");
  expect(titleSlug("Claim an issue when work starts: agent-gh claim, release, and claims")).toBe("claim-an-issue-when-work-starts-agent-gh");
  expect(titleSlug("Ünïcödé — ")).toBe("unicode");
  expect(titleSlug("!!!")).toBe("issue");
});

test("a claim branch names its issue; any other branch, or none, names nothing", () => {
  expect(claimBranchIssue("claude/7-fix-the-widget")).toBe(7);
  expect(claimBranchIssue("codex/64-x")).toBe(64);
  for (const branch of ["feature/7-fix", "claude/fix-7", "claude/7", "main", "claude/07-x", "", undefined]) expect([branch, claimBranchIssue(branch)]).toEqual([branch, undefined]);
});

test("the commands parse as the usage says", () => {
  expect(parseClaimArgs("claim", ["7"])).toEqual({ command: "claim", issue: 7, refs: false, noPr: false });
  expect(parseClaimArgs("claim", ["--refs", "-R", "o/r", "7"])).toEqual({ command: "claim", issue: 7, refs: true, noPr: false });
  expect(parseClaimArgs("claim", ["7", "--no-pr", "--repo=o/r"])).toEqual({ command: "claim", issue: 7, refs: false, noPr: true });
  for (const bad of [[], ["x"], ["7", "8"], ["7", "--refs", "--no-pr"], ["7", "--draft"], ["-R"], ["0"]]) expect(parseClaimArgs("claim", bad)).toBeUndefined();
  expect(parseClaimArgs("claim", ["--take", "7", "-R", "o/r"])).toEqual({ command: "take", issue: 7 });
  expect(parseClaimArgs("claim", ["7", "--take"])).toEqual({ command: "take", issue: 7 });
  for (const bad of [["--take"], ["--take", "7", "--refs"], ["--take", "7", "--no-pr"], ["--take", "--next"], ["--take", "7", "8"], ["--take", "--take", "7"]]) expect(parseClaimArgs("claim", bad)).toBeUndefined();
  expect(parseClaimArgs("claim", ["--take", "7", "--skip-label", "x"])).toBeUndefined();
  expect(parseClaimArgs("release", ["7"])).toEqual({ command: "release", issue: 7 });
  expect(parseClaimArgs("claims", ["--json", "-Ro/r"])).toEqual({ command: "claims", json: true });
  expect(parseClaimArgs("claims", [])).toEqual({ command: "claims", json: false });
  expect(parseClaimArgs("claims", ["sync", "--issue", "7", "--issue", "8"])).toEqual({ command: "sync", issues: [7, 8] });
  expect(parseClaimArgs("claims", ["sync", "--issue"])).toBeUndefined();
});

// A fake GitHub holding the issues, pull requests, comments, and labels claims touch, and real git in throwaway clones.

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

type Issue = { number: number; state: string; title: string; labels: { name: string }[] };
type Pull = ReturnType<typeof pull> & { commits?: number; changed_files?: number };

const page = <T>(items: readonly T[], url: URL): T[] => (Number(url.searchParams.get("page") ?? 1) === 1 ? [...items] : []);

const world = ({ issues = [{ ...OPEN, labels: [] }] as Issue[], pulls = [] as Pull[], comments = {} as Record<number, unknown[]>, label = true, labelCreate = 201, config = undefined as unknown } = {}) => {
  const state = { issues, pulls, comments, label, deleted: [] as string[], nextPull: 31, nextComment: 500, lagUntilPulls: 0, staleReads: 0, onPost: () => {} };
  const issue = (number: number) => state.issues.find((item) => item.number === number);
  const routes: Record<string, (body: string, url: URL) => Response | Promise<Response>> = {
    [`GET ${PATH}`]: () => reply(200, { default_branch: "main", owner: { login: "johnrees" } }),
    [`GET ${PATH}/contents/.github/agent-review.json`]: () => (config === undefined ? reply(404, {}) : reply(200, { content: Buffer.from(JSON.stringify(config)).toString("base64") })),
    [`GET ${PATH}/pulls`]: (_, url) =>
      reply(200, state.nextPull - 31 < state.lagUntilPulls || state.staleReads-- > 0 ? [] : page(state.pulls.filter((item) => item.state === "open"), url)),
    [`POST ${PATH}/pulls`]: (body) => {
      const sent = JSON.parse(body) as { title: string; head: string; body: string; draft: boolean };
      if (state.pulls.some((item) => item.state === "open" && item.head.ref === sent.head)) return reply(422, { message: "A pull request already exists" });
      const made = { ...pull(state.nextPull++, sent.body, { draft: sent.draft, head: { ref: sent.head, sha: "b".repeat(40), repo: { full_name: "johnrees/widget" } }, created_at: "2026-10-15T11:50:00Z" }), title: sent.title, commits: 1, changed_files: 0 };
      state.pulls.push(made);
      routes[`PATCH ${PATH}/pulls/${made.number}`] = (patch) => (Object.assign(made, JSON.parse(patch)), reply(200, made));
      routes[`GET ${PATH}/pulls/${made.number}`] = () => reply(200, made);
      state.onPost();
      return reply(201, made);
    },
    [`GET ${PATH}/labels/claimed`]: () => (state.label ? reply(200, { name: "claimed" }) : reply(404, {})),
    [`POST ${PATH}/labels`]: () => (labelCreate === 201 && (state.label = true), reply(labelCreate, {})),
    [`GET ${PATH}/issues`]: (_, url) =>
      reply(200, page(state.issues.filter((item) => item.state === "open" && item.labels.some((name) => name.name === url.searchParams.get("labels"))), url)),
    [`GET ${PATH}/commits/${"a".repeat(40)}`]: () => reply(200, { commit: { committer: { date: "2026-10-15T11:00:00Z" } } }),
    [`GET ${PATH}/commits/${"b".repeat(40)}`]: () => reply(200, { commit: { committer: { date: "2026-10-15T11:30:00Z" } } }),
  };
  for (const number of [7, 8, 31, 32, 33]) {
    routes[`GET ${PATH}/issues/${number}`] = () => {
      const found = issue(number);
      return found === undefined ? reply(200, { number, state: "open", pull_request: {} }) : reply(200, found);
    };
    routes[`GET ${PATH}/issues/${number}/comments`] = (_, url) => reply(200, page(state.comments[number] ?? [], url));
    routes[`POST ${PATH}/issues/${number}/comments`] = (body) => {
      const made = { ...comment(state.nextComment++, (JSON.parse(body) as { body: string }).body), created_at: "2026-10-15T11:45:00Z" };
      (state.comments[number] ??= []).push(made);
      state.onPost();
      return reply(201, made);
    };
    routes[`POST ${PATH}/issues/${number}/labels`] = (body) => {
      const found = issue(number);
      for (const name of (JSON.parse(body) as { labels: string[] }).labels) if (found !== undefined && !found.labels.some((item) => item.name === name)) found.labels.push({ name });
      return reply(200, found?.labels ?? []);
    };
    routes[`DELETE ${PATH}/issues/${number}/labels/claimed`] = () => {
      const found = issue(number);
      const had = found?.labels.some((item) => item.name === "claimed") ?? false;
      if (found !== undefined) found.labels = found.labels.filter((item) => item.name !== "claimed");
      return had ? reply(200, []) : reply(404, {});
    };
  }
  for (let id = 500; id < 510; id++) {
    routes[`DELETE ${PATH}/issues/comments/${id}`] = () => {
      for (const list of Object.values(state.comments)) list.splice(0, list.length, ...list.filter((item) => (item as { id: number }).id !== id));
      return new Response(null, { status: 204 });
    };
  }
  for (const family of ["claude", "codex"]) {
    routes[`DELETE ${PATH}/git/refs/heads/${family}/7-fix-the-widget`] = () => (state.deleted.push(`${family}/7-fix-the-widget`), new Response(null, { status: 204 }));
  }
  const fake = fakeGitHub(routes);
  stops.push(fake.stop);
  return { fake, state, routes };
};

/** A bare origin with one commit on main, and a clone of it per session. */
const origin = () => {
  const home = mkdtempSync(join(tmpdir(), "agent-gh-claim-"));
  const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" };
  const run = (args: readonly string[], cwd = home) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, stdout: result.stdout.toString().trim() };
  };
  const bare = join(home, "origin.git");
  run(["init", "-q", "--bare", "-b", "main", bare]);
  run(["clone", "-q", bare, join(home, "seed")]);
  run(["commit", "-q", "--allow-empty", "-m", "first"], join(home, "seed"));
  run(["push", "-q", "origin", "main"], join(home, "seed"));
  const clone = (name: string) => {
    const dir = join(home, name);
    run(["clone", "-q", bare, dir]);
    return dir;
  };
  return { home, bare, run, clone };
};

const session = (fake: ReturnType<typeof world>["fake"], git: ReturnType<typeof origin>, dir: string, family = "claude", id = "s-one", sleep: () => Promise<void> = async () => {}) => {
  const printed: string[] = [];
  const io: ClaimIo = {
    api: fake.api, token: "t", repo: REPO, family, session: id,
    git: async (args) => git.run(args, dir),
    print: (line) => printed.push(line), out: (text) => printed.push(text.trim()), sleep, nowMs: () => NOW, recheckMs: 0,
  };
  return { io, printed, dir };
};

const sent = (fake: ReturnType<typeof world>["fake"], method: string, path: string) =>
  fake.log.filter((entry) => entry.method === method && entry.path === path).map((entry) => JSON.parse(entry.body) as Record<string, unknown>);

test("a claim opens a draft pull request closing the issue from a new branch with one empty commit, then labels the issue", async () => {
  const w = world({ label: false });
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: false })).toBe(0);
  const [opened] = sent(w.fake, "POST", `${PATH}/pulls`);
  expect(opened).toMatchObject({ title: "Fix the widget", head: "claude/7-fix-the-widget", base: "main", draft: true });
  expect(String(opened?.body)).toStartWith("Closes #7.");
  expect(parseClaim(String(opened?.body))).toMatchObject({ issue: 7, family: "claude", session: "s-one" });
  // Pushed: one empty commit on main, and the clone is on the branch, tracking it.
  expect(git.run(["rev-list", "--count", "main..claude/7-fix-the-widget"], git.bare).stdout).toBe("1");
  expect(git.run(["diff", "--stat", "main", "claude/7-fix-the-widget"], git.bare).stdout).toBe("");
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], a.dir).stdout).toBe("claude/7-fix-the-widget");
  expect(git.run(["rev-parse", "--abbrev-ref", "@{upstream}"], a.dir).stdout).toBe("origin/claude/7-fix-the-widget");
  // The missing label was created, then added.
  expect(sent(w.fake, "POST", `${PATH}/labels`)).toHaveLength(1);
  expect(w.state.issues[0]?.labels).toEqual([{ name: "claimed" }]);
  expect(a.printed.at(-1)).toBe("https://github.com/johnrees/widget/pull/31");
});

test("--refs opens a pull request that references the issue without closing it", async () => {
  const w = world();
  const git = origin();
  expect(await claim(session(w.fake, git, git.clone("a")).io, { issue: 7, refs: true, noPr: false })).toBe(0);
  expect(String(sent(w.fake, "POST", `${PATH}/pulls`)[0]?.body)).toStartWith("Refs #7.");
});

test("the claim's commit message reads well in a squash merge: the issue's title and link, never \"Claim #N\"", async () => {
  const w = world({ issues: [{ number: 7, state: "open", title: "Claim an issue when work starts", labels: [] }] });
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: false })).toBe(0);
  git.run(["commit", "-q", "--allow-empty", "-m", "Add agent-gh claim"], a.dir);
  const messages = git.run(["log", "--reverse", "--format=%B%x00", "origin/main..HEAD"], a.dir).stdout.split("\0").map((item) => item.trim()).filter((item) => item !== "");
  // GitHub's default squash message: the pull request's title, then each commit's message as a bullet.
  const squash = [`Claim an issue when work starts (#31)`, ...messages.map((message) => `* ${message}`)].join("\n\n");
  expect(squash).not.toMatch(/claim #\d/i);
  expect(messages[0]).toBe(claimCommitMessage(7, "Claim an issue when work starts"));
  expect(messages[0]).toBe("Claim an issue when work starts\n\nRefs #7");
});

test("a claim is refused for a closed issue, an issue an open pull request references, or one a live claim comment holds, naming the holder", async () => {
  const git = origin();
  const cases: [Parameters<typeof world>[0], string][] = [
    [{ issues: [{ ...OPEN, state: "closed", labels: [] }] }, "#7 is closed"],
    [{ pulls: [pull(5, "Fixes #7", { user: { login: "someone" }, draft: false })] }, "#7 is taken by #5 by someone"],
    [{ comments: { 7: [comment(400, marker(7, "codex", "other"))] } }, "#7 is taken by a claim comment by a codex session (other)"],
  ];
  for (const [setup, expected] of cases) {
    const w = world(setup);
    const a = session(w.fake, git, git.clone(`refused-${expected.length}-${Math.random()}`));
    expect(await claim(a.io, { issue: 7, refs: false, noPr: false })).toBe(1);
    expect(a.printed.join("\n")).toContain(expected);
    expect(sent(w.fake, "POST", `${PATH}/pulls`)).toEqual([]);
  }
  // A claim comment from someone without write access claims nothing.
  const w = world({ comments: { 7: [comment(400, marker(7, "codex", "other"), "NONE")] } });
  expect(await claim(session(w.fake, git, git.clone("open")).io, { issue: 7, refs: false, noPr: false })).toBe(0);
});

test("two sessions claiming at once: the lower pull request holds the issue; the other closes its own, deletes its branch, and names the winner", async () => {
  const w = world();
  const git = origin();
  // Both read the issue as free (GitHub has no compare-and-swap), and each reads the claims back only once both have posted.
  w.state.lagUntilPulls = 2;
  let release = () => {};
  const both = new Promise<void>((resolve) => (release = resolve));
  w.state.onPost = () => {
    if (w.state.nextPull - 31 === 2) release();
  };
  const a = session(w.fake, git, git.clone("a"), "claude", "s-one", () => both);
  const b = session(w.fake, git, git.clone("b"), "codex", "s-two", () => both);
  const codes = await Promise.all([claim(a.io, { issue: 7, refs: false, noPr: false }), claim(b.io, { issue: 7, refs: false, noPr: false })]);
  const [winner, loser] = sent(w.fake, "POST", `${PATH}/pulls`)[0]?.head === "claude/7-fix-the-widget" ? [a, b] : [b, a];
  expect(codes.sort()).toEqual([0, 1]);
  const lost = w.state.pulls.find((item) => item.number === 32);
  expect(lost?.state).toBe("closed");
  expect(w.state.pulls.find((item) => item.number === 31)?.state).toBe("open");
  expect(loser.printed.join("\n")).toContain("#7 went to draft #31");
  expect(loser.printed.join("\n")).toContain("closed this claim's #32");
  expect(w.state.deleted).toEqual([lost?.head.ref as string]);
  // The loser is back on main, without the branch; the winner keeps its own.
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], loser.dir).stdout).toBe("main");
  expect(git.run(["rev-parse", "-q", "--verify", `refs/heads/${lost?.head.ref}`], loser.dir).code).not.toBe(0);
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], winner.dir).stdout).toBe(w.state.pulls[0]?.head.ref as string);
  expect(w.state.issues[0]?.labels).toEqual([{ name: "claimed" }]);
});

test("a second session of the same family never overwrites or deletes the first one's branch", async () => {
  const w = world();
  const git = origin();
  expect(await claim(session(w.fake, git, git.clone("a")).io, { issue: 7, refs: false, noPr: false })).toBe(0);
  const before = git.run(["rev-parse", "claude/7-fix-the-widget"], git.bare).stdout;
  // The second read the issue as free before the first pull request was listed.
  w.state.lagUntilPulls = 2;
  const b = session(w.fake, git, git.clone("b"), "claude", "s-two", async () => {
    w.state.lagUntilPulls = 0;
  });
  expect(await claim(b.io, { issue: 7, refs: false, noPr: false })).toBe(1);
  expect(b.printed.join("\n")).toContain("#7 went to draft #31");
  expect(git.run(["rev-parse", "claude/7-fix-the-widget"], git.bare).stdout).toBe(before);
  expect(w.state.deleted).toEqual([]);
  expect(w.state.pulls).toHaveLength(1);
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], b.dir).stdout).toBe("main");
});

test("a claim with uncommitted changes is refused before it moves anything", async () => {
  const w = world();
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  await Bun.write(join(a.dir, "f.txt"), "x");
  git.run(["add", "f.txt"], a.dir);
  await expect(claim(a.io, { issue: 7, refs: false, noPr: false })).rejects.toThrow("uncommitted changes");
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], a.dir).stdout).toBe("main");
});

test("a pull request claim opened after a comment claim won loses to it, so both sessions never hold the issue", async () => {
  const w = world();
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: true })).toBe(0);
  // A competitor who read the issue as free before that comment was posted, and opens its pull request after.
  const comments = w.state.comments[7] as unknown[];
  w.state.comments[7] = [];
  w.state.onPost = () => {
    w.state.comments[7] = [...comments];
  };
  const b = session(w.fake, git, git.clone("b"), "codex", "s-two");
  expect(await claim(b.io, { issue: 7, refs: false, noPr: false })).toBe(1);
  expect(b.printed.join("\n")).toContain("#7 went to a claim comment by a claude session (s-one)");
  expect(w.state.pulls[0]?.state).toBe("closed");
  expect(taken(REPO, OPEN, w.state.pulls, w.state.comments[7] ?? []).holder).toMatchObject({ kind: "comment", session: "s-one" });
});

test("--no-pr claims with a comment; one that loses to an earlier comment posts its own release", async () => {
  const w = world();
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: true })).toBe(0);
  const posted = w.state.comments[7]?.[0] as { body: string };
  expect(parseClaim(posted.body)).toMatchObject({ issue: 7, family: "claude", session: "s-one" });
  expect(w.state.issues[0]?.labels).toEqual([{ name: "claimed" }]);
  expect(sent(w.fake, "POST", `${PATH}/pulls`)).toEqual([]);

  // A competitor who read the issue before that comment was posted.
  const comments = w.state.comments[7] as unknown[];
  w.state.comments[7] = [];
  const b = session(w.fake, git, git.clone("b"), "codex", "s-two");
  const route = w.routes[`POST ${PATH}/issues/7/comments`] as (body: string, url: URL) => Response;
  w.routes[`POST ${PATH}/issues/7/comments`] = (body, url) => {
    if ((w.state.comments[7] ?? []).length === 0) w.state.comments[7] = [...comments];
    return route(body, url);
  };
  expect(await claim(b.io, { issue: 7, refs: false, noPr: true })).toBe(1);
  expect(b.printed.join("\n")).toContain("#7 went to a claim comment by a claude session (s-one)");
  expect(taken(REPO, OPEN, [], w.state.comments[7] ?? []).claims.map((item) => item.session)).toEqual(["s-one"]);
});

test("release closes this session's still-empty claim, deletes its branch, and removes the label", async () => {
  const w = world({ issues: [{ ...OPEN, labels: [{ name: "claimed" }] }] });
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: false })).toBe(0);
  expect(await release(a.io, 7)).toBe(0);
  expect(w.state.pulls[0]?.state).toBe("closed");
  expect(w.state.deleted).toEqual(["claude/7-fix-the-widget"]);
  expect(w.state.issues[0]?.labels).toEqual([]);
  expect(await release(a.io, 7)).toBe(1);
  expect(a.printed.at(-1)).toBe("agent-gh: nothing claims #7");
});

test("release refuses a claim with work on it, and another session's claim", async () => {
  const w = world({ pulls: [{ ...pull(31, `Closes #7.\n${marker(7)}`), commits: 2, changed_files: 3 }] });
  w.routes[`GET ${PATH}/pulls/31`] = () => reply(200, w.state.pulls[0]);
  const git = origin();
  const mine = session(w.fake, git, git.clone("a"));
  expect(await release(mine.io, 7)).toBe(1);
  expect(mine.printed.at(-1)).toContain("close it deliberately (`gh pr close 31`)");
  const other = session(w.fake, git, git.clone("b"), "codex", "s-two");
  expect(await release(other.io, 7)).toBe(1);
  expect(other.printed.at(-1)).toContain("an agent releases only its own claim, and John releases another by closing its pull request");
  expect(w.state.pulls[0]?.state).toBe("open");
});

test("release of a comment claim posts a release marker", async () => {
  const w = world();
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: true })).toBe(0);
  expect(await release(a.io, 7)).toBe(0);
  expect(taken(REPO, OPEN, [], w.state.comments[7] ?? []).taken).toBe(false);
  expect(w.state.issues[0]?.labels).toEqual([]);
});

test("claims lists each live claim with its holder and last push and comment, and the label's mismatches", async () => {
  const w = world({
    issues: [{ ...OPEN, labels: [] }, { number: 8, state: "open", title: "Free", labels: [{ name: "claimed" }] }],
    pulls: [pull(31, `Closes #7.\n${marker(7)}`), pull(12, "Unlike #8")],
    comments: { 7: [comment(400, "Looks good")], 31: [{ ...comment(401, "Pushed"), created_at: "2026-10-15T11:50:00Z" }] },
  });
  const list = await listClaims({ api: w.fake.api, token: "t", repo: REPO });
  expect(list).toEqual({
    v: 1, repo: "johnrees/widget", label: "claimed",
    claims: [{
      issue: 7, title: "Fix the widget", kind: "pr", pr: 31, url: "https://github.com/johnrees/widget/pull/31", author: "johnrees", family: "claude", session: "s-one",
      branch: "claude/7-x-31", holds: true, created_at: "2026-10-15T10:00:00Z", last_push_at: "2026-10-15T11:00:00Z", last_comment_at: "2026-10-15T11:50:00Z", labeled: false,
    }],
    mismatches: [{ issue: 7, labeled: false, claimed: true }, { issue: 8, labeled: true, claimed: false }],
  });
  expect(claimsLines(list, NOW)).toEqual([
    "#7 Fix the widget: #31 by claude s-one; claimed 2h ago, last push 1h ago, last comment 10m ago; quiet since 10m ago",
    "#7: claimed but missing `claimed`; the claim holds it regardless",
    "#8: carries `claimed` but nothing claims it; `agent-gh claims sync` removes the label",
  ]);
  // A released claim drops out.
  const empty = world();
  expect(claimsLines(await listClaims({ api: empty.fake.api, token: "t", repo: REPO }), NOW)).toEqual(["No live claims in johnrees/widget."]);
});

test("the label's name comes from the review config's claims.label", async () => {
  const w = world({ config: { reviewers: { codex: { model: "m" } }, claims: { label: "taken" } }, issues: [{ ...OPEN, labels: [{ name: "taken" }] }] });
  expect((await listClaims({ api: w.fake.api, token: "t", repo: REPO })).label).toBe("taken");
  const bad = world({ config: { claims: { label: "" } } });
  await expect(listClaims({ api: bad.fake.api, token: "t", repo: REPO })).rejects.toThrow("claims.label must be a label name");
});

test("claims sync removes the label only where nothing claims the issue; a closed pull request's event names its issues", async () => {
  const w = world({
    issues: [{ ...OPEN, labels: [{ name: "claimed" }] }, { number: 8, state: "open", title: "Free", labels: [{ name: "claimed" }] }],
    pulls: [pull(31, `Closes #7.\n${marker(7)}`)],
  });
  const printed: string[] = [];
  await syncLabels({ api: w.fake.api, token: "t", repo: REPO }, (line) => printed.push(line));
  expect(w.state.issues.map((item) => item.labels)).toEqual([[{ name: "claimed" }], []]);
  expect(printed).toEqual(["agent-gh: removed `claimed` from #8"]);
  // Merged or closed: the issue is no longer held, so the label goes.
  w.state.pulls[0]!.state = "closed";
  await syncLabels({ api: w.fake.api, token: "t", repo: REPO }, () => {}, eventIssues({ api: w.fake.api, token: "t", repo: REPO }, { pull_request: { number: 31, body: w.state.pulls[0]?.body } }));
  expect(w.state.issues[0]?.labels).toEqual([]);
  expect(eventIssues({ api: w.fake.api, token: "t", repo: REPO }, { issue: { number: 7 } })).toBeUndefined();
});

test("a label the App may not create is reported, and the claim stands", async () => {
  const w = world({ label: false, labelCreate: 403 });
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: false })).toBe(0);
  expect(a.printed.join("\n")).toContain("could not create the `claimed` label (HTTP 403): the App may lack Issues write here");
  expect(w.state.issues[0]?.labels).toEqual([]);
});

test("a draft pull request GitHub refuses undoes the claim's branch, here and on GitHub", async () => {
  const w = world();
  w.routes[`POST ${PATH}/pulls`] = () => reply(422, { message: "Draft pull requests are not supported" });
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  await expect(claim(a.io, { issue: 7, refs: false, noPr: false })).rejects.toThrow("HTTP 422 from POST /repos/johnrees/widget/pulls");
  expect(w.state.deleted).toEqual(["claude/7-fix-the-widget"]);
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], a.dir).stdout).toBe("main");
  expect(git.run(["rev-parse", "-q", "--verify", "refs/heads/claude/7-fix-the-widget"], a.dir).code).not.toBe(0);
});

test("when GitHub refuses the pull request because another open one already uses the branch, the branch is left alone", async () => {
  // As when two sessions of one family push the same commit in the same second: the second push is a no-op.
  const w = world({ pulls: [pull(30, "Unrelated", { head: { ref: "claude/7-fix-the-widget", sha: "a".repeat(40), repo: { full_name: "johnrees/widget" } } })] });
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  await expect(claim(a.io, { issue: 7, refs: false, noPr: false })).rejects.toThrow("HTTP 422");
  expect(w.state.deleted).toEqual([]);
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], a.dir).stdout).toBe("main");
});

test("when the pull request is refused and the open pull requests cannot then be read, the branch is left on GitHub", async () => {
  const w = world();
  let refused = false;
  w.routes[`POST ${PATH}/pulls`] = () => ((refused = true), reply(422, { message: "A pull request already exists" }));
  const list = w.routes[`GET ${PATH}/pulls`] as (body: string, url: URL) => Response;
  w.routes[`GET ${PATH}/pulls`] = (body, url) => (refused ? reply(502, {}) : list(body, url));
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  await expect(claim(a.io, { issue: 7, refs: false, noPr: false })).rejects.toThrow("HTTP 422");
  expect(w.state.deleted).toEqual([]);
  expect(a.printed.join("\n")).toContain("claude/7-fix-the-widget is left on GitHub");
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], a.dir).stdout).toBe("main");
});

test("a claim whose pull request GitHub opened, though its answer was lost, goes on with it", async () => {
  const w = world();
  const open = w.routes[`POST ${PATH}/pulls`] as (body: string, url: URL) => Response;
  w.routes[`POST ${PATH}/pulls`] = (body, url) => (open(body, url), reply(502, {}));
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: false })).toBe(0);
  expect(a.printed.join("\n")).toContain("GitHub opened this claim's #31, though its answer to the request was lost");
  expect(w.state.pulls[0]?.state).toBe("open");
  expect(w.state.deleted).toEqual([]);
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], a.dir).stdout).toBe("claude/7-fix-the-widget");
  expect(w.state.issues[0]?.labels).toEqual([{ name: "claimed" }]);
});

test("a session that read the issue as free and finds its branch's pull request already open names the holder", async () => {
  const w = world({ pulls: [pull(30, `Closes #7.\n${marker(7, "claude", "first")}`, { head: { ref: "claude/7-fix-the-widget", sha: "a".repeat(40), repo: { full_name: "johnrees/widget" } } })] });
  w.state.staleReads = 1;
  const git = origin();
  const a = session(w.fake, git, git.clone("a"), "claude", "second");
  expect(await claim(a.io, { issue: 7, refs: false, noPr: false })).toBe(1);
  expect(a.printed.join("\n")).toContain("#7 went to draft #30 by a claude session (first) (https://github.com/johnrees/widget/pull/30) first, on the same branch");
  expect(w.state.deleted).toEqual([]);
});

test("a claim whose issue closes while it is posted undoes itself", async () => {
  for (const noPr of [false, true]) {
    const w = world();
    const git = origin();
    const a = session(w.fake, git, git.clone("a"), "claude", "s-one", async () => {
      w.state.issues[0]!.state = "closed";
    });
    expect(await claim(a.io, { issue: 7, refs: false, noPr })).toBe(1);
    expect(a.printed.join("\n")).toContain("#7 was closed while this claim was posted");
    expect(w.state.issues[0]?.labels).toEqual([]);
    if (noPr) expect(taken(REPO, OPEN, [], w.state.comments[7] ?? []).taken).toBe(false);
    else expect(w.state.pulls[0]?.state).toBe("closed");
  }
});

test("a claim refuses a clone that pushes somewhere else than it fetches from", async () => {
  const w = world();
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  git.run(["remote", "set-url", "--push", "origin", "https://github.com/someone/fork.git"], a.dir);
  await expect(claim(a.io, { issue: 7, refs: false, noPr: false })).rejects.toThrow("whose origin fetches from and pushes to johnrees/widget");
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], a.dir).stdout).toBe("main");
  // A push URL that names no GitHub repository (a mirror on disk), unless it is the fetch URL itself.
  const mirror = join(git.home, "mirror.git");
  git.run(["init", "-q", "--bare", mirror]);
  const b = session(w.fake, git, git.clone("b"));
  git.run(["remote", "set-url", "--push", "origin", mirror], b.dir);
  await expect(claim(b.io, { issue: 7, refs: false, noPr: false })).rejects.toThrow("whose origin fetches from and pushes to johnrees/widget");
  expect(git.run(["for-each-ref", "refs/heads"], mirror).stdout).toBe("");
  expect(sent(w.fake, "POST", `${PATH}/pulls`)).toEqual([]);
});

test("claim --next stops when its draft pull request stands unconfirmed, and claims no other issue", async () => {
  const ready = [{ name: "ready" }];
  const w = world({ issues: [{ ...OPEN, labels: ready }, { number: 8, state: "open", title: "Another widget", labels: ready }] });
  for (const number of [7, 8]) w.routes[`GET ${PATH}/issues/${number}/dependencies/blocked_by`] = () => reply(200, []);
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  // GitHub opens the pull request but never lists it, so the claim cannot tell whether it won.
  w.state.onPost = () => {
    w.state.lagUntilPulls = 99;
  };
  expect(await claimNext(a.io, apiReader(a.io), { refs: false, noPr: false })).toBe(UNKNOWN);
  expect(a.printed.filter((line) => line.startsWith("agent-gh: claiming"))).toEqual(["agent-gh: claiming #7 Fix the widget"]);
  expect(a.printed.join("\n")).toContain("GitHub does not list this claim's #31 yet");
  expect(w.state.pulls.map((item) => [item.number, item.state])).toEqual([[31, "open"]]);
});

/** A session's commit with work in it, credited to `session` as the commit-msg hook would, pushed to its branch. */
const work = (git: ReturnType<typeof origin>, dir: string, file: string, session: string) => {
  writeFileSync(join(dir, file), `${file}\n`);
  git.run(["add", file], dir);
  expect(git.run(["commit", "-q", "-m", `Add ${file}\n\nAgent-Session: ${session}`], dir).code).toBe(0);
  expect(git.run(["push", "-q", "origin", "HEAD"], dir).code).toBe(0);
  return git.run(["rev-parse", "HEAD"], dir).stdout;
};

test("claim --take hands a claim with work on it to this session: same branch and pull request, the marker rewritten, one comment, and review full takes the earlier commits as the holder's", async () => {
  const w = world();
  const git = origin();
  // Session A (claude) claims #7 and pushes a commit.
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: false })).toBe(0);
  const before = parseClaim(w.state.pulls[0]?.body ?? "");
  const theirs = work(git, a.dir, "a.txt", "s-one");
  // Session B (codex), in its own clean clone, takes it.
  const b = session(w.fake, git, git.clone("b"), "codex", "s-two");
  expect(await take(b.io, 7)).toBe(0);
  expect(w.state.pulls.map((item) => [item.number, item.state, item.head.ref])).toEqual([[31, "open", "claude/7-fix-the-widget"]]);
  const after = parseClaim(w.state.pulls[0]?.body ?? "");
  expect(after).toEqual({ v: 1, issue: 7, family: "codex", session: "s-two", id: before?.id as string });
  // The rest of the description is as it was.
  expect(w.state.pulls[0]?.body.replace(/<!-- agent-claim .* -->/, "")).toBe(String(sent(w.fake, "POST", `${PATH}/pulls`)[0]?.body).replace(/<!-- agent-claim .* -->/, ""));
  const posted = sent(w.fake, "POST", `${PATH}/issues/31/comments`);
  expect(posted).toHaveLength(1);
  expect(parseTake(String(posted[0]?.body))).toEqual({ v: 1, id: before?.id as string, from: { family: "claude", session: "s-one" }, to: { family: "codex", session: "s-two" }, head: theirs });
  expect(String(posted[0]?.body)).toContain("A codex session (s-two) took this claim from a claude session (s-one) with `agent-gh claim --take`");
  expect(b.printed.at(-1)).toBe("https://github.com/johnrees/widget/pull/31");
  // B is on the claim branch at A's head, tracking it; the issue is still claimed, now by B, so B's hook passes and A's refuses.
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], b.dir).stdout).toBe("claude/7-fix-the-widget");
  expect(git.run(["rev-parse", "HEAD"], b.dir).stdout).toBe(theirs);
  expect(git.run(["rev-parse", "--abbrev-ref", "@{upstream}"], b.dir).stdout).toBe("origin/claude/7-fix-the-widget");
  expect(w.state.issues[0]?.labels).toEqual([{ name: "claimed" }]);
  const holder = await holderOf(b.io, "checking the commit", 7);
  expect(holder !== undefined && mine(holder, "codex", "s-two")).toBe(true);
  expect(holder !== undefined && mine(holder, "claude", "s-one")).toBe(false);
  // B commits and pushes plainly; review full's check of the commits passes with no --adopt, and says what it took on.
  const ours = work(git, b.dir, "b.txt", "s-two");
  expect(git.run(["rev-parse", "claude/7-fix-the-widget"], git.bare).stdout).toBe(ours);
  const printed: string[] = [];
  const review = {
    api: w.fake.api, token: "t", repo: REPO, family: "codex", session: "s-two", print: (line: string) => printed.push(line),
    git: async (args: readonly string[]) => {
      const result = git.run(args, b.dir);
      return result.code === 0 ? result.stdout : undefined;
    },
  };
  const base = git.run(["merge-base", "HEAD", "origin/main"], b.dir).stdout;
  const pr = { number: 31, body: w.state.pulls[0]?.body ?? "" };
  expect(await adoptedCommits(review, pr, base, ours, false)).toEqual({ adopted: [], taken: [`${theirs.slice(0, 8)} (session s-one)`] });
  // A commit A makes after the take (offline, past its hook) is not the holder's: the review refuses it until B adopts or drops it.
  git.run(["pull", "-q", "--ff-only"], a.dir);
  const late = work(git, a.dir, "late.txt", "s-one");
  git.run(["fetch", "-q", "origin"], b.dir);
  await expect(adoptedCommits(review, pr, base, late, false)).rejects.toThrow(`commit ${late.slice(0, 8)} is from session s-one, not this claim's holder (s-two)`);
  // A take comment by someone without write access, or for another claim, takes nothing on.
  w.state.comments[31] = (w.state.comments[31] ?? []).map((item) => ({ ...(item as object), author_association: "NONE" }));
  await expect(adoptedCommits(review, pr, base, ours, false)).rejects.toThrow(`commit ${theirs.slice(0, 8)} is from session s-one`);
});

test("claim --take refuses a closed issue, one nothing claims, one held by a person's pull request, and one this session holds", async () => {
  const git = origin();
  const cases: [Parameters<typeof world>[0], string][] = [
    [{ issues: [{ ...OPEN, state: "closed", labels: [] }] }, "#7 is closed; there is no claim to take"],
    [{}, "nothing claims #7, so there is nothing to take; claim it with `agent-gh claim 7`"],
    [{ pulls: [pull(5, "Fixes #7", { user: { login: "someone" }, draft: false })] }, "#7 is held by #5 by someone (https://github.com/johnrees/widget/pull/5), which carries no claim marker"],
    [{ pulls: [pull(31, `Closes #7.\n${marker(7)}`)] }, "this session already holds #7: draft #31 by a claude session (s-one)"],
  ];
  for (const [setup, expected] of cases) {
    const w = world(setup);
    const a = session(w.fake, git, git.clone(`take-${Math.random()}`));
    const head = git.run(["rev-parse", "--abbrev-ref", "HEAD"], a.dir).stdout;
    expect(await take(a.io, 7)).toBe(1);
    expect(a.printed.join("\n")).toContain(expected);
    expect(w.fake.log.filter((entry) => entry.method !== "GET")).toEqual([]);
    expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], a.dir).stdout).toBe(head);
  }
});

test("claim --take of a pull request claim refuses uncommitted changes, and a local branch of that name at another commit, before it writes anything", async () => {
  const w = world();
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: false })).toBe(0);
  work(git, a.dir, "a.txt", "s-one");
  const b = session(w.fake, git, git.clone("b"), "codex", "s-two");
  writeFileSync(join(b.dir, "README"), "x");
  git.run(["add", "README"], b.dir);
  await expect(take(b.io, 7)).rejects.toThrow("the working tree has uncommitted changes; commit or stash them first, since the take checks out the claim's branch");
  git.run(["reset", "-q", "--hard"], b.dir);
  git.run(["branch", "claude/7-fix-the-widget", "main"], b.dir);
  await expect(take(b.io, 7)).rejects.toThrow("a local branch claude/7-fix-the-widget already exists at");
  expect(w.fake.log.filter((entry) => entry.method !== "GET" && entry.path !== `${PATH}/pulls`).filter((entry) => entry.path.includes("/31"))).toEqual([]);
  expect(parseClaim(w.state.pulls[0]?.body ?? "")?.session).toBe("s-one");
  // GitHub refusing the marker's rewrite leaves the claim with its holder and the clone where it was.
  git.run(["branch", "-q", "-D", "claude/7-fix-the-widget"], b.dir);
  w.routes[`PATCH ${PATH}/pulls/31`] = () => reply(422, {});
  await expect(take(b.io, 7)).rejects.toThrow("HTTP 422 from PATCH");
  expect(parseClaim(w.state.pulls[0]?.body ?? "")?.session).toBe("s-one");
  const [made] = sent(w.fake, "POST", `${PATH}/issues/31/comments`);
  expect(parseTake(String(made?.body))?.to).toEqual({ family: "codex", session: "s-two" });
  expect(w.fake.log.filter((entry) => entry.method === "DELETE").map((entry) => entry.path)).toEqual([`${PATH}/issues/comments/500`]);
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], b.dir).stdout).toBe("main");
  expect(git.run(["rev-parse", "-q", "--verify", "refs/heads/claude/7-fix-the-widget"], b.dir).code).not.toBe(0);
  // A pull request whose marker another take rewrote since the claims were read is left alone.
  const opened = w.state.pulls[0] as Pull;
  const read = w.routes[`GET ${PATH}/pulls/31`] as (body: string, url: URL) => Response;
  w.routes[`GET ${PATH}/pulls/31`] = () => reply(200, { ...opened, body: `Closes #7.\n${marker(7, "glm", "s-three", parseClaim(opened.body)?.id)}` });
  expect(await take(b.io, 7)).toBe(1);
  expect(b.printed.at(-1)).toBe("agent-gh: #31's claim changed while this take read it; run `agent-gh claims` and take again if it is still another session's");
  expect(sent(w.fake, "POST", `${PATH}/issues/31/comments`)).toHaveLength(1);
  w.routes[`GET ${PATH}/pulls/31`] = read;
  // Another session's rewrite landing over this one's: the take stands down and puts the clone back, keeping its comment, on which a take from this session would chain.
  w.routes[`PATCH ${PATH}/pulls/31`] = () => {
    opened.body = `Closes #7.\n${marker(7, "glm", "s-three", parseClaim(opened.body)?.id)}`;
    return reply(200, opened);
  };
  expect(await take(b.io, 7)).toBe(1);
  expect(b.printed.at(-1)).toBe("agent-gh: #31's claim went to a glm session (s-three) while this take ran, so this session did not take it; run `agent-gh claims`");
  expect(w.fake.log.filter((entry) => entry.method === "DELETE")).toHaveLength(1);
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], b.dir).stdout).toBe("main");
});

test("of two sessions taking one claim at once, the one whose take comment is listed first takes it; the other deletes its comment and stays where it was", async () => {
  const w = world();
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: false })).toBe(0);
  work(git, a.dir, "a.txt", "s-one");
  // Both read the claim as the first session's and post their takes before either reads the comments back.
  let release = () => {};
  const both = new Promise<void>((resolve) => (release = resolve));
  w.state.onPost = () => {
    if ((w.state.comments[31] ?? []).length === 2) release();
  };
  const b = session(w.fake, git, git.clone("b"), "codex", "s-two", () => both);
  const c = session(w.fake, git, git.clone("c"), "glm", "s-three", () => both);
  const codes = await Promise.all([take(b.io, 7), take(c.io, 7)]);
  expect(codes.sort()).toEqual([0, 1]);
  const won = parseClaim(w.state.pulls[0]?.body ?? "");
  const [winner, loser] = won?.session === "s-two" ? [b, c] : [c, b];
  expect(loser.printed.at(-1)).toBe(
    `agent-gh: this session took nothing from #31: a ${winner === b ? "codex" : "glm"} session's (${won?.session}) take of it was posted first (https://github.com/johnrees/widget/issues/7#issuecomment-500; if that take was abandoned before it rewrote the marker, delete that comment); run \`agent-gh claims\`, and take again if it is still another session's`,
  );
  expect((w.state.comments[31] ?? []).map((item) => parseTake(String((item as { body: string }).body))?.to.session)).toEqual([won?.session]);
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], loser.dir).stdout).toBe("main");
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], winner.dir).stdout).toBe("claude/7-fix-the-widget");
});

test("a take whose rewrite went unanswered goes ahead when run again; one whose pull request closed meanwhile takes nothing", async () => {
  const w = world();
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: false })).toBe(0);
  const theirs = work(git, a.dir, "a.txt", "s-one");
  const patch = w.routes[`PATCH ${PATH}/pulls/31`] as (body: string, url: URL) => Response;
  // GitHub never answers the rewrite (and never applies it), then fails on its side.
  w.routes[`PATCH ${PATH}/pulls/31`] = async () => (await Bun.sleep(2500), reply(504, {}));
  const b = session(w.fake, git, git.clone("b"), "codex", "s-two");
  expect(await take(b.io, 7)).toBe(UNKNOWN);
  expect(b.printed.at(-1)).toContain("rewriting #31's claim marker went unanswered or failed on GitHub's side, so whether this session took #7 is unknown");
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], b.dir).stdout).toBe("claude/7-fix-the-widget");
  w.routes[`PATCH ${PATH}/pulls/31`] = () => reply(502, {});
  expect(await take(b.io, 7)).toBe(UNKNOWN);
  expect(w.fake.log.filter((entry) => entry.method === "DELETE")).toEqual([]);
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], b.dir).stdout).toBe("claude/7-fix-the-widget");
  w.routes[`PATCH ${PATH}/pulls/31`] = patch;
  expect(await take(b.io, 7)).toBe(0);
  expect(parseClaim(w.state.pulls[0]?.body ?? "")).toMatchObject({ family: "codex", session: "s-two" });
  expect(git.run(["rev-parse", "HEAD"], b.dir).stdout).toBe(theirs);
  // A pull request closed while a take runs is no claim to take.
  const c = session(w.fake, git, git.clone("c"), "glm", "s-three");
  const read = w.routes[`GET ${PATH}/pulls/31`] as (body: string, url: URL) => Response;
  let reads = 0;
  w.routes[`GET ${PATH}/pulls/31`] = (body, url) => (++reads === 2 ? reply(200, { ...(w.state.pulls[0] as Pull), state: "closed" }) : read(body, url));
  const posts = sent(w.fake, "POST", `${PATH}/issues/31/comments`).length;
  expect(await take(c.io, 7)).toBe(1);
  expect(c.printed.at(-1)).toBe("agent-gh: this session took nothing from #31: #31 was closed while this take ran; run `agent-gh claims`, and take again if it is still another session's");
  expect(sent(w.fake, "POST", `${PATH}/issues/31/comments`)).toHaveLength(posts + 1);
  expect((w.state.comments[31] ?? []).map((item) => parseTake(String((item as { body: string }).body))?.to.session)).toEqual(["s-two", "s-two", "s-two"]);
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], c.dir).stdout).toBe("main");
}, 15_000);

test("a take comment GitHub stored without answering is found and deleted, so it does not go ahead of the next session's take", async () => {
  const w = world();
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: false })).toBe(0);
  work(git, a.dir, "a.txt", "s-one");
  const post = w.routes[`POST ${PATH}/issues/31/comments`] as (body: string, url: URL) => Response;
  w.routes[`POST ${PATH}/issues/31/comments`] = async (body, url) => {
    const stored = post(body, url);
    await Bun.sleep(2500);
    return stored;
  };
  const b = session(w.fake, git, git.clone("b"), "codex", "s-two");
  await expect(take(b.io, 7)).rejects.toThrow("could not reach");
  expect(w.state.comments[31]).toEqual([]);
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], b.dir).stdout).toBe("main");
  w.routes[`POST ${PATH}/issues/31/comments`] = post;
  expect(await take(session(w.fake, git, git.clone("c"), "glm", "s-three").io, 7)).toBe(0);
  expect(parseClaim(w.state.pulls[0]?.body ?? "")).toMatchObject({ family: "glm", session: "s-three" });
}, 15_000);

test("claim --take whose rewrite cannot be confirmed keeps its comment and the clone on the claim branch, and says so", async () => {
  const w = world();
  const git = origin();
  const a = session(w.fake, git, git.clone("a"));
  expect(await claim(a.io, { issue: 7, refs: false, noPr: false })).toBe(0);
  const read = w.routes[`GET ${PATH}/pulls/31`] as (body: string, url: URL) => Response;
  let reads = 0;
  w.routes[`GET ${PATH}/pulls/31`] = (body, url) => (++reads === 3 ? reply(502, {}) : read(body, url));
  const b = session(w.fake, git, git.clone("b"), "codex", "s-two");
  expect(await take(b.io, 7)).toBe(UNKNOWN);
  expect(b.printed.at(-1)).toBe("agent-gh: rewrote #31's claim marker to this session, but could not read it back (HTTP 502 from GET /repos/johnrees/widget/pulls/31); this clone is on claude/7-fix-the-widget: run `agent-gh claims` to confirm");
  expect(parseClaim(w.state.pulls[0]?.body ?? "")?.session).toBe("s-two");
  expect(sent(w.fake, "POST", `${PATH}/issues/31/comments`)).toHaveLength(1);
  expect(w.fake.log.filter((entry) => entry.method === "DELETE")).toEqual([]);
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], b.dir).stdout).toBe("claude/7-fix-the-widget");
});

test("claim --take of a comment claim posts a new claim comment for this session, then the old one's release", async () => {
  const w = world({ comments: { 7: [comment(400, marker(7, "claude", "s-one", "aaaaaaaaaaaaaaaa"))] } });
  const git = origin();
  const b = session(w.fake, git, git.clone("b"), "codex", "s-two");
  expect(await take(b.io, 7)).toBe(0);
  const [claimed, released] = sent(w.fake, "POST", `${PATH}/issues/7/comments`).map((item) => String(item.body));
  expect(parseClaim(claimed ?? "")).toMatchObject({ issue: 7, family: "codex", session: "s-two" });
  expect(claimed).toContain("took this issue's claim from a claude session (s-one) with `agent-gh claim --take`");
  expect(released).toContain(releaseMarker({ v: 1, id: "aaaaaaaaaaaaaaaa" }));
  expect(taken(REPO, OPEN, [], w.state.comments[7] ?? []).claims.map((item) => [item.family, item.session])).toEqual([["codex", "s-two"]]);
  expect(git.run(["rev-parse", "--abbrev-ref", "HEAD"], b.dir).stdout).toBe("main");
  // Of two sessions taking it at once, the earlier new claim holds; the later releases its own.
  const race = world({ comments: { 7: [comment(400, marker(7, "claude", "s-one", "aaaaaaaaaaaaaaaa"))] } });
  let first = true;
  race.state.onPost = () => {
    if (first) (race.state.comments[7] ??= []).push({ ...comment(450, marker(7, "glm", "s-three", "cccccccccccccccc")), created_at: "2026-10-15T11:44:00Z" });
    first = false;
  };
  const d = session(race.fake, git, git.clone("d"), "codex", "s-two");
  expect(await take(d.io, 7)).toBe(1);
  expect(d.printed.join("\n")).toContain("first; released this take's claim comment");
  expect(taken(REPO, OPEN, [], race.state.comments[7] ?? []).claims.map((item) => item.session)).toEqual(["s-three"]);
  // When the old claim's release fails, the new claim is released too, so a retry is not refused for it.
  const flaky = world({ comments: { 7: [comment(400, marker(7, "claude", "s-one", "aaaaaaaaaaaaaaaa"))] } });
  const post = flaky.routes[`POST ${PATH}/issues/7/comments`] as (body: string, url: URL) => Response;
  flaky.routes[`POST ${PATH}/issues/7/comments`] = (body, url) => (body.includes("aaaaaaaaaaaaaaaa") ? reply(422, {}) : post(body, url));
  const e = session(flaky.fake, git, git.clone("e"), "codex", "s-two");
  await expect(take(e.io, 7)).rejects.toThrow("HTTP 422");
  expect(taken(REPO, OPEN, [], flaky.state.comments[7] ?? []).claims.map((item) => item.session)).toEqual(["s-one"]);
  // A release GitHub stored without answering: the new claim stays, and reading the claims back finds it holds.
  const slow = world({ comments: { 7: [comment(400, marker(7, "claude", "s-one", "aaaaaaaaaaaaaaaa"))] } });
  const store = slow.routes[`POST ${PATH}/issues/7/comments`] as (body: string, url: URL) => Response;
  slow.routes[`POST ${PATH}/issues/7/comments`] = async (body, url) => {
    const stored = store(body, url);
    if (body.includes("aaaaaaaaaaaaaaaa")) await Bun.sleep(2500);
    return stored;
  };
  const f = session(slow.fake, git, git.clone("f"), "codex", "s-two");
  expect(await take(f.io, 7)).toBe(0);
  expect(taken(REPO, OPEN, [], slow.state.comments[7] ?? []).claims.map((item) => item.session)).toEqual(["s-two"]);
  // A new claim GitHub stored without answering is released, so a retry is not refused for it.
  const unanswered = world({ comments: { 7: [comment(400, marker(7, "claude", "s-one", "aaaaaaaaaaaaaaaa"))] } });
  const keepIt = unanswered.routes[`POST ${PATH}/issues/7/comments`] as (body: string, url: URL) => Response;
  let slowOnce = true;
  unanswered.routes[`POST ${PATH}/issues/7/comments`] = async (body, url) => {
    const stored = keepIt(body, url);
    if (slowOnce) await Bun.sleep(2500);
    slowOnce = false;
    return stored;
  };
  await expect(take(session(unanswered.fake, git, git.clone("h"), "codex", "s-two").io, 7)).rejects.toThrow("could not reach");
  expect(taken(REPO, OPEN, [], unanswered.state.comments[7] ?? []).claims.map((item) => item.session)).toEqual(["s-one"]);
  // A release GitHub lists late: the take waits for it rather than judging the old claim still the holder.
  const lagging = world({ comments: { 7: [comment(400, marker(7, "claude", "s-one", "aaaaaaaaaaaaaaaa"))] } });
  const keep = lagging.routes[`POST ${PATH}/issues/7/comments`] as (body: string, url: URL) => Response;
  const list = lagging.routes[`GET ${PATH}/issues/7/comments`] as (body: string, url: URL) => Response;
  let hidden: unknown[] = [];
  lagging.routes[`POST ${PATH}/issues/7/comments`] = (body, url) => {
    const stored = keep(body, url);
    if (body.includes("aaaaaaaaaaaaaaaa")) hidden = (lagging.state.comments[7] ?? []).splice(-1);
    return stored;
  };
  let lists = 0;
  lagging.routes[`GET ${PATH}/issues/7/comments`] = (body, url) => {
    if (++lists === 3) lagging.state.comments[7]?.push(...hidden.splice(0));
    return list(body, url);
  };
  const g = session(lagging.fake, git, git.clone("g"), "codex", "s-two");
  expect(await take(g.io, 7)).toBe(0);
  expect(taken(REPO, OPEN, [], lagging.state.comments[7] ?? []).claims.map((item) => item.session)).toEqual(["s-two"]);
  // With another claim behind it, a new comment would fall behind that one, so nothing is taken.
  const crowded = world({ comments: { 7: [comment(400, marker(7, "claude", "s-one", "aaaaaaaaaaaaaaaa")), { ...comment(401, marker(7, "glm", "s-three", "bbbbbbbbbbbbbbbb")), created_at: "2026-10-15T09:30:00Z" }] } });
  const c = session(crowded.fake, git, git.clone("c"), "codex", "s-two");
  expect(await take(c.io, 7)).toBe(1);
  expect(c.printed.join("\n")).toContain("a new claim comment would fall behind them");
  expect(sent(crowded.fake, "POST", `${PATH}/issues/7/comments`)).toEqual([]);
}, 15_000);

test("a take hands on commits only through the latest chain of takes ending at the holder, by writers, for this claim", () => {
  const claimOf = (family: string, session: string) => ({ v: 1 as const, issue: 7, family, session, id: "0123456789abcdef" });
  const by = (from: string, to: string, head: string, association = "OWNER", id = "0123456789abcdef") => ({
    author_association: association,
    body: takeCommentBody({ v: 1, id, from: { family: "claude", session: from }, to: { family: "claude", session: to }, head: head.repeat(40) }),
  });
  const heads = (comments: unknown[], holder: string) => takesOf(comments, claimOf("claude", holder)).map((item) => `${item.from.session}>${item.to.session}@${item.head[0]}`);
  expect(heads([by("a", "b", "1"), by("b", "c", "2")], "c")).toEqual(["a>b@1", "b>c@2"]);
  // Two takes from a at once: whichever rewrite stands is the chain, the other hands nothing on.
  expect(heads([by("a", "b", "1"), by("a", "c", "2")], "c")).toEqual(["a>c@2"]);
  expect(heads([by("a", "b", "1"), by("a", "c", "2")], "b")).toEqual(["a>b@1"]);
  expect(heads([by("a", "b", "1", "NONE")], "b")).toEqual([]);
  expect(heads([by("a", "b", "1", "OWNER", "fedcba9876543210")], "b")).toEqual([]);
  expect(heads([], "b")).toEqual([]);
  // The take that goes ahead: the first from the holder since a take made it the holder.
  const ids = (comments: ReturnType<typeof by>[]) => comments.map((item, index) => ({ ...item, id: 10 + index }));
  expect(firstTake(ids([by("a", "b", "1"), by("a", "c", "2")]), claimOf("claude", "a"))?.id).toBe(10);
  expect(firstTake(ids([by("a", "b", "1"), by("b", "c", "2"), by("b", "d", "3")]), claimOf("claude", "b"))?.id).toBe(11);
  expect(firstTake(ids([by("b", "a", "1"), by("a", "b", "2"), by("b", "a", "3"), by("a", "c", "4")]), claimOf("claude", "a"))?.id).toBe(13);
  expect(firstTake(ids([by("a", "b", "1", "NONE")]), claimOf("claude", "a"))).toBeUndefined();
});

test("a description's claim marker is rewritten in place; a take marker reads back, and a malformed one reads as none", () => {
  const body = `Closes #7.\n\nWork.\n\n${marker(7)}\n\nMore.`;
  expect(retakeBody(body, { v: 1, issue: 7, family: "codex", session: "s-two", id: "0123456789abcdef" })).toBe(`Closes #7.\n\nWork.\n\n${marker(7, "codex", "s-two")}\n\nMore.`);
  expect(retakeBody("No marker.", { v: 1, issue: 7, family: "codex", session: "s-two", id: "0123456789abcdef" })).toBe("No marker.");
  const good = { v: 1, id: "0123456789abcdef", from: { family: "claude", session: "s-one" }, to: { family: "codex", session: "s-two" }, head: "a".repeat(40) };
  expect(parseTake(`<!-- agent-take ${JSON.stringify(good)} -->`)).toEqual(good as never);
  for (const bad of [{ ...good, head: "abc" }, { ...good, from: { family: "claude" } }, { ...good, id: "x" }, { ...good, v: 2 }]) expect(parseTake(`<!-- agent-take ${JSON.stringify(bad)} -->`)).toBeUndefined();
});
