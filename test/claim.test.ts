import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimCommitMessage,
  claimMarker,
  claimsOn,
  linkedIssues,
  mismatch,
  parseClaim,
  parseClaimArgs,
  releaseMarker,
  sessionId,
  taken,
  titleSlug,
} from "../src/claim.ts";
import { claim, type ClaimIo, claimsLines, eventIssues, listClaims, release, syncLabels, UNKNOWN } from "../src/claim-run.ts";
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

test("the commands parse as the usage says", () => {
  expect(parseClaimArgs("claim", ["7"])).toEqual({ command: "claim", issue: 7, refs: false, noPr: false });
  expect(parseClaimArgs("claim", ["--refs", "-R", "o/r", "7"])).toEqual({ command: "claim", issue: 7, refs: true, noPr: false });
  expect(parseClaimArgs("claim", ["7", "--no-pr", "--repo=o/r"])).toEqual({ command: "claim", issue: 7, refs: false, noPr: true });
  for (const bad of [[], ["x"], ["7", "8"], ["7", "--refs", "--no-pr"], ["7", "--draft"], ["-R"], ["0"]]) expect(parseClaimArgs("claim", bad)).toBeUndefined();
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
  const routes: Record<string, (body: string, url: URL) => Response> = {
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
