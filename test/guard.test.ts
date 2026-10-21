import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Claim } from "../src/claim.ts";
import { REGISTRY } from "../src/config.ts";
import { Failure, NEXT_STEP } from "../src/failure.ts";
import { coAuthorTrailer } from "../src/git.ts";
import { type ClaimCheck, guard, hasMessage, UPDATE } from "../src/guard.ts";
import { readGitConfig } from "../src/target.ts";
import { bunVersionProblem } from "../scripts/bun-version.ts";

const root = join(import.meta.dir, "..");
/** A byte-identical copy of johnrees/penmon's .githooks/commit-msg. */
const HOOKS = join(import.meta.dir, "penmon-hooks");
/** A Claude Code agent session that reports its model and effort; a person's shell has none of these. */
const AGENT = { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", ANTHROPIC_MODEL: "claude-opus-5-5", CLAUDE_EFFORT: "xhigh" };
/** A pi session driving GLM. */
const GLM = { PI_SESSION_ID: "p", PI_PROVIDER: "zai", PI_MODEL: "glm-4.6" };
const app = (family: string) => {
  const entry = REGISTRY[family];
  if (entry === undefined) throw new Error(`the registry has no ${family} App`);
  return coAuthorTrailer(entry);
};
const CLAUDE = app("claude");
const CLAUDE_TRAILERS = `Agent-Model: claude-opus-5-5\nAgent-Harness: claude\nAgent-Effort: xhigh\n${CLAUDE}`;
/** The same, from a session with an id in its environment. */
const SESSION_TRAILERS = (id: string) => `Agent-Model: claude-opus-5-5\nAgent-Harness: claude\nAgent-Effort: xhigh\nAgent-Session: ${id}\n${CLAUDE}`;

/** A claim check for hooks that never reach it. */
const NEVER: ClaimCheck = {
  branch: () => {
    throw new Error("pre-push and unknown hooks never read the branch");
  },
  session: { id: "s-one", generated: false },
  holder: () => {
    throw new Error("pre-push and unknown hooks never read the claims");
  },
  print: () => {
    throw new Error("pre-push and unknown hooks print nothing");
  },
};

/** The claim on #64 as `claims` would report it: draft #65 by a session, or (both null) a person's pull request. */
const claimBy = (session: string | null, family: string | null = "claude"): Claim => ({
  issue: 64, kind: "pr", pr: 65, comment: null, url: "https://github.com/johnrees/penmon/pull/65", author: "someone", family, session,
  id: family === null ? null : "0123456789abcdef", branch: "claude/64-fix", draft: true, createdAt: "2026-10-21T00:00:00Z",
});

/**
 * A clone with Penmon's hooks switched on, one staged file, and an `agent-gh`
 * on PATH that runs this checkout's source with an empty HOME, so every App
 * comes from the committed registry and nothing is logged in. Its `origin` is
 * a github.com URL that git rewrites to a local bare repository, so it is a
 * GitHub repository to agent-gh while pushes stay local; `onGitHub: false`
 * makes `origin` the bare path itself.
 */
const world = ({ onGitHub = true } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "agent-gh-guard-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "agent-gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "src", "main.ts")}" "$@"\n`);
  chmodSync(join(bin, "agent-gh"), 0o755);
  const remote = join(home, "remote.git");
  const dir = join(home, "repo");
  Bun.spawnSync(["git", "init", "-q", "--bare", remote]);
  Bun.spawnSync(["git", "init", "-q", dir]);
  const config = (key: string, value: string) => Bun.spawnSync(["git", "-C", dir, "config", key, value]);
  for (const [key, value] of [["user.name", "John Rees"], ["user.email", "john@example.com"], ["core.hooksPath", HOOKS]] as const) config(key, value);
  const url = onGitHub ? "https://github.com/johnrees/penmon.git" : remote;
  Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", url]);
  if (onGitHub) config(`url.${remote}.insteadOf`, url);
  const stage = (text: string) => {
    writeFileSync(join(dir, "f"), text);
    Bun.spawnSync(["git", "-C", dir, "add", "f"]);
  };
  stage("a\n");
  const person = { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  const agent = { ...person, ...AGENT };
  const run = (command: string[], env: Record<string, string>) => {
    const result = Bun.spawnSync(command, { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, stderr: result.stderr.toString() };
  };
  const last = (format: string) => Bun.spawnSync(["git", "-C", dir, "log", "-1", `--format=${format}`]).stdout.toString().trim();
  const count = () => Number(Bun.spawnSync(["git", "-C", dir, "rev-list", "--count", "--all"]).stdout.toString().trim() || "0");
  return { home, dir, person, agent, run, last, count, stage, config };
};

/**
 * The commit-msg hook run in-process on a world's repository, HEAD on
 * `branch`, with a fake claim check in GitHub's place: `holds` is what holds
 * #64 (a Failure is thrown, as when GitHub cannot be reached).
 */
const hookOn = async (branch: string | undefined, holds: Claim | Failure | undefined, session = { id: "s-one", generated: false }) => {
  const { home, dir, agent } = world();
  const file = join(home, "COMMIT_EDITMSG");
  writeFileSync(file, "work\n");
  const asked: [string, number][] = [];
  const printed: string[] = [];
  const claims: ClaimCheck = {
    branch: () => branch,
    session,
    holder: async (repo, issue) => {
      asked.push([`${repo.owner}/${repo.name}`, issue]);
      if (holds instanceof Failure) throw holds;
      return holds;
    },
    print: (line) => printed.push(line),
  };
  const verdict = await guard(["commit-msg", file], agent, "/nonexistent", REGISTRY, () => readGitConfig(dir, agent), claims);
  return { verdict, message: readFileSync(file, "utf8"), asked, printed };
};

test("a commit on the session's own claim branch is credited with its session; on another session's claim branch it is refused, naming the holder and the fix", async () => {
  const own = await hookOn("claude/64-fix", claimBy("s-one"));
  expect(own.verdict).toEqual({ code: 0 });
  expect(own.asked).toEqual([["johnrees/penmon", 64]]);
  expect(own.message).toBe(`work\n\n${SESSION_TRAILERS("s-one")}\n`);
  const other = await hookOn("claude/64-fix", claimBy("s-two"));
  expect(other.verdict).toEqual({
    code: 1,
    message: `agent-gh guard: branch \`claude/64-fix\` is #64's claim branch, and #64 is held by draft #65 by a claude session (s-two) (https://github.com/johnrees/penmon/pull/65), not this claude session (s-one); commit on your own claim branch (\`agent-gh claim <n>\`).\n${NEXT_STEP}`,
  });
  expect(other.message).toBe("work\n");
  // Another family's claim branch is a claim branch too, and a person's pull request holds an issue as well.
  expect((await hookOn("codex/64-fix", claimBy("s-two", "codex"))).verdict.code).toBe(1);
  const person = await hookOn("claude/64-fix", claimBy(null, null));
  expect(person.verdict.message).toContain("#64 is held by draft #65 by someone (https://github.com/johnrees/penmon/pull/65), not this claude session (s-one)");
  // A session with no id in its environment holds nothing the hook can see, and is told how to say who it is.
  const anonymous = await hookOn("claude/64-fix", claimBy("s-two"), { id: "f00d", generated: true });
  expect(anonymous.verdict.message).toContain("not this session, which has no id in its environment (set AGENT_GH_SESSION to the id its claim printed)");
});

test("a commit on any other branch, on a claim branch nothing holds, or when GitHub cannot say who holds it, passes", async () => {
  for (const branch of ["main", "feature/64-fix", "claude/fix-64", undefined]) {
    const result = await hookOn(branch, claimBy("s-two"));
    expect([branch, result.verdict]).toEqual([branch, { code: 0 }]);
    expect(result.asked).toEqual([]);
    expect(result.message).toBe(`work\n\n${SESSION_TRAILERS("s-one")}\n`);
  }
  const free = await hookOn("claude/64-fix", undefined);
  expect(free.verdict).toEqual({ code: 0 });
  expect(free.asked).toEqual([["johnrees/penmon", 64]]);
  // Offline, the commit passes with a note: it carries its session, and `review full` refuses a stray one.
  const offline = await hookOn("claude/64-fix", new Failure("checking the commit", "could not reach api.github.com", true));
  expect(offline.verdict).toEqual({ code: 0 });
  expect(offline.printed).toEqual([
    "agent-gh guard: could not check who holds #64 (checking the commit failed: could not reach api.github.com); committing on claude/64-fix unchecked, and `agent-gh review full` refuses a commit that is not the claim holder's",
  ]);
  expect(offline.message).toBe(`work\n\n${SESSION_TRAILERS("s-one")}\n`);
  // A session with no id writes no Agent-Session trailer.
  expect((await hookOn("main", undefined, { id: "f00d", generated: true })).message).toBe(`work\n\n${CLAUDE_TRAILERS}\n`);
  // Offline and with no id, neither check could tell the commit from the holder's, so it is refused until the session says who it is.
  const unknown = await hookOn("claude/64-fix", new Failure("checking the commit", "could not reach api.github.com", true), { id: "f00d", generated: true });
  expect(unknown.verdict).toEqual({
    code: 1,
    message: `agent-gh guard: could not check who holds #64 (checking the commit failed: could not reach api.github.com), and this session has no id in its environment, so \`agent-gh review full\` could not tell its commit from the claim holder's either; set AGENT_GH_SESSION to the id its claim printed, then commit again.\n${NEXT_STEP}`,
  });
  expect(unknown.printed).toEqual([]);
  expect(unknown.message).toBe("work\n");
});

test("through git, a session with an id is credited with it, and a claim branch whose holder cannot be read is noted, not refused", () => {
  const { agent, run, last, stage } = world();
  const session = { ...agent, CLAUDE_CODE_SESSION_ID: "1a811df7-f1a4" };
  expect(run(["git", "commit", "-q", "-m", "mine"], session)).toEqual({ code: 0, stderr: "" });
  expect(last("%B")).toBe(`mine\n\n${SESSION_TRAILERS("1a811df7-f1a4")}`);
  // An amend from a session without an id drops the earlier session's, never keeping another's.
  expect(run(["git", "commit", "-q", "--amend", "--no-edit"], agent).code).toBe(0);
  const amended = last("%B").split("\n");
  expect(amended.some((line) => line.startsWith("Agent-Session:"))).toBe(false);
  expect(amended.filter((line) => line.startsWith("Agent-") || line.startsWith("Co-authored-by:")).sort()).toEqual(CLAUDE_TRAILERS.split("\n").sort());
  // On a claim branch the hook asks GitHub who holds #64; with no login here it cannot, says so, and passes.
  stage("b\n");
  expect(run(["git", "switch", "-q", "-c", "claude/64-fix"], agent).code).toBe(0);
  const commit = run(["git", "commit", "-q", "-m", "on a claim branch"], session);
  expect(commit.code).toBe(0);
  expect(commit.stderr).toStartWith("agent-gh guard: could not check who holds #64 (reading the login failed: no login for claude; run `agent-gh login claude` in your own terminal); committing on claude/64-fix unchecked");
  expect(last("%B")).toBe(`on a claim branch\n\n${SESSION_TRAILERS("1a811df7-f1a4")}`);
});

test("an agent session's plain commit keeps John as author and credits the session's App", () => {
  const { agent, run, last } = world();
  expect(run(["git", "commit", "-q", "-m", "plain"], agent)).toEqual({ code: 0, stderr: "" });
  expect(last("%an <%ae>|%cn")).toBe("John Rees <john@example.com>|John Rees");
  expect(last("%B")).toBe(`plain\n\n${CLAUDE_TRAILERS}`);
});

test("trailers join a message's own trailer block, whatever the message form", () => {
  const { dir, agent, run, last, stage } = world();
  writeFileSync(join(dir, "..", "msg"), "from a file\n\nSigned-off-by: x <x@e>\n");
  expect(run(["git", "commit", "-q", "-F", join(dir, "..", "msg")], agent).code).toBe(0);
  expect(last("%B")).toBe(`from a file\n\nSigned-off-by: x <x@e>\n${CLAUDE_TRAILERS}`);
  stage("b\n");
  // A --- line is text in a commit message, not the end of it, as `git commit --trailer` treats it.
  expect(run(["git", "commit", "-q", "-m", "above\n---\nbelow"], agent).code).toBe(0);
  expect(last("%B")).toBe(`above\n---\nbelow\n\n${CLAUDE_TRAILERS}`);
});

test("an amend replaces the agent trailers, credits each App once, and keeps other co-authors", () => {
  const { dir, agent, run, last } = world();
  writeFileSync(join(dir, "..", "msg"), "first\n\nCo-authored-by: Ada <ada@example.com>\n");
  expect(run(["git", "commit", "-q", "-F", join(dir, "..", "msg")], agent).code).toBe(0);
  expect(run(["git", "commit", "-q", "--amend", "--no-edit"], agent).code).toBe(0);
  const once = last("%B");
  expect(once.split("\n").filter((line) => line.startsWith("Co-authored-by:"))).toEqual(["Co-authored-by: Ada <ada@example.com>", CLAUDE]);
  expect(once.split("\n").filter((line) => line.startsWith("Agent-Model:"))).toEqual(["Agent-Model: claude-opus-5-5"]);

  expect(run(["git", "commit", "-q", "--amend", "--no-edit"], { ...agent, CLAUDECODE: "", ...GLM }).code).toBe(0);
  const body = last("%B");
  expect(body).toContain("Agent-Model: glm-4.6\n");
  expect(body).toContain("Agent-Harness: pi\n");
  expect(body).not.toContain("claude-opus-5-5");
  // pi reports no effort here, so the Claude session's is gone rather than credited to GLM.
  expect(body).not.toContain("Agent-Effort");
  expect(body.split("\n").filter((line) => line.startsWith("Co-authored-by:"))).toEqual(["Co-authored-by: Ada <ada@example.com>", CLAUDE, app("glm")]);
});

test("a message written in the editor gets the trailers above its comments and the -v diff, and keeps them", () => {
  const { home, agent, run, last } = world();
  const editor = join(home, "editor");
  writeFileSync(editor, `#!/bin/sh\n{ printf 'from the editor\\n'; cat "$1"; } > "$1.new" && mv "$1.new" "$1"\n`);
  chmodSync(editor, 0o755);
  expect(run(["git", "commit", "-q", "-v"], { ...agent, GIT_EDITOR: editor }).code).toBe(0);
  expect(last("%B")).toBe(`from the editor\n\n${CLAUDE_TRAILERS}`);
});

test("an empty message still aborts the commit: no trailers make it a message", () => {
  const { agent, run, count } = world();
  const before = count();
  expect(run(["git", "commit", "-q", "-m", ""], agent).code).not.toBe(0);
  expect(run(["git", "commit", "-q", "-v"], { ...agent, GIT_EDITOR: "true" }).code).not.toBe(0);
  // A configured `:` editor looks like no editor to the hook, but git's template still says the message is empty.
  expect(run(["git", "commit", "-q"], { ...agent, GIT_EDITOR: ":" }).code).not.toBe(0);
  expect(count()).toBe(before);
  expect(hasMessage("\n# only a comment\n", "#", true)).toBe(false);
  expect(hasMessage("#123 fix\n", "#", true)).toBe(false);
  expect(hasMessage("#123 fix\n", "#", false)).toBe(true);
  expect(hasMessage("#123 fix\n", ";", true)).toBe(true);
  expect(hasMessage(`\n# ------------------------ >8 ------------------------\ndiff --git a/f b/f\n`, "#", true)).toBe(false);
  // commit.cleanup=strip strips comments from a -m message too, so this one is empty.
  const { agent: stripping, run: runStripping, count: counted, config } = world();
  config("commit.cleanup", "strip");
  expect(runStripping(["git", "commit", "-q", "-m", "# only a comment"], stripping).code).not.toBe(0);
  expect(counted()).toBe(0);
});

test("a message git keeps is credited, whatever looks like a comment in it", () => {
  // -m keeps comment lines: git strips them only from an edited message.
  const { home, agent, run, last, stage, config } = world();
  expect(run(["git", "commit", "-q", "-m", "#123 fix"], agent).code).toBe(0);
  expect(last("%B")).toBe(`#123 fix\n\n${CLAUDE_TRAILERS}`);
  // An edited message: the repository's comment character, set or chosen by git.
  for (const [char, message] of [[";", "#123 fix"], ["auto", "#123 fix"], ["auto", "plain"]] as const) {
    stage(`${char} ${message}\n`);
    config("core.commentChar", char);
    expect([char, message, run(["git", "commit", "-q", "-e", "-m", message], { ...agent, GIT_EDITOR: "true" }).code]).toEqual([char, message, 0]);
    expect([char, last("%B")]).toEqual([char, `${message}\n\n${CLAUDE_TRAILERS}`]);
  }
  // With auto, an editor that replaces the whole buffer leaves no comment character behind: its text is the message.
  const replacer = join(home, "replacer");
  writeFileSync(replacer, `#!/bin/sh\nprintf '#new subject\\n' > "$1"\n`);
  chmodSync(replacer, 0o755);
  stage("replaced\n");
  expect(run(["git", "commit", "-q", "-e", "-m", "#old"], { ...agent, GIT_EDITOR: replacer }).code).toBe(0);
  expect(last("%B")).toBe(`#new subject\n\n${CLAUDE_TRAILERS}`);
  // With auto, an emptied message is still empty, whichever character git chose.
  const emptier = join(home, "emptier");
  writeFileSync(emptier, `#!/bin/sh\ngrep '^;' "$1" > "$1.new"; mv "$1.new" "$1"\n`);
  chmodSync(emptier, 0o755);
  stage("emptied\n");
  expect(run(["git", "commit", "-q", "-e", "-m", "#123 fix"], { ...agent, GIT_EDITOR: emptier }).code).not.toBe(0);
  expect(run(["git", "commit", "-q"], { ...agent, GIT_EDITOR: "true" }).code).not.toBe(0);
});

test("a runner that names its harness is credited like any agent session", () => {
  const { person, run, last } = world();
  expect(run(["git", "commit", "-q", "-m", "runner"], { ...person, AGENT_GH_HARNESS: "codex" }).code).toBe(0);
  expect(last("%B")).toBe(`runner\n\nAgent-Harness: codex\n${app("codex")}`);
});

test("a person's commit, and any commit in a repository with no github.com remote, is left exactly as written", () => {
  const { person, run, last } = world();
  expect(run(["git", "commit", "-q", "-m", "mine"], person)).toEqual({ code: 0, stderr: "" });
  expect(last("%B")).toBe("mine");
  const local = world({ onGitHub: false });
  expect(local.run(["git", "commit", "-q", "-m", "local"], local.agent)).toEqual({ code: 0, stderr: "" });
  expect(local.last("%B")).toBe("local");
});

test("a session agent-gh cannot identify stops the commit with the fix, rather than crediting nobody", () => {
  const { person, run, count } = world();
  const before = count();
  const commit = run(["git", "commit", "-q", "-m", "who"], { ...person, OPENCODE_TERMINAL: "1" });
  expect(commit.code).not.toBe(0);
  expect(commit.stderr).toContain("opencode does not tell shell commands which model runs");
  expect(count()).toBe(before);
});

test("a person's push passes the pre-push guard untouched; an agent's never passes it silently", async () => {
  const verdict = (env: Record<string, string>) =>
    guard(["pre-push", "origin", "https://github.com/johnrees/widget.git"], env, "/nonexistent", REGISTRY, () => {
      throw new Error("pre-push never reads the repository");
    }, NEVER);
  expect(await verdict({})).toEqual({ code: 0 });
  // The CLI checks an agent's push against GitHub before guard runs; here it fails closed.
  expect((await verdict(AGENT)).code).toBe(2);
});

test("an agent's push through the CLI is refused where its repository cannot be told, and a local remote is not held", () => {
  const line = `refs/heads/feature ${"a".repeat(40)} refs/heads/main ${"0".repeat(40)}\n`;
  const push = (url: string, env: Record<string, string>) => {
    const result = Bun.spawnSync([process.execPath, join(root, "src", "main.ts"), "guard", "pre-push", "origin", url], {
      env: { PATH: process.env.PATH ?? "", HOME: mkdtempSync(join(tmpdir(), "agent-gh-push-")), ...env },
      stdin: new TextEncoder().encode(line),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: result.exitCode, stderr: result.stderr.toString() };
  };
  const alias = push("git@work-github:johnrees/widget.git", AGENT);
  expect(alias.code).toBe(1);
  expect(alias.stderr).toContain("cannot tell which GitHub repository this push goes to");
  expect(push("/tmp/somewhere/remote.git", AGENT)).toEqual({ code: 0, stderr: "" });
  expect(push("git@work-github:johnrees/widget.git", {})).toEqual({ code: 0, stderr: "" });
});

test("a hook this version does not understand fails with exit 2 and the update command, never a pass", async () => {
  for (const args of [["post-merge"], [], ["commit-msg"], ["commit-msg", "a", "b"]]) {
    for (const env of [{}, AGENT]) {
      const verdict = await guard(args, env, "/nonexistent", REGISTRY, () => {
        throw new Error("an unknown hook never reads the repository");
      }, NEVER);
      expect(verdict.code).toBe(2);
      expect(verdict.message).toContain(UPDATE);
    }
  }
});

test("install-local names the exact Bun to install when the version differs from .bun-version", () => {
  expect(bunVersionProblem("1.4.2", "1.4.2")).toBeUndefined();
  const problem = bunVersionProblem("1.4.0", "1.4.2");
  expect(problem).toContain("this is Bun 1.4.0, and agent-gh is pinned to 1.4.2");
  expect(problem).toContain('curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"');
});
