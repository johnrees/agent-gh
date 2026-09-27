import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY } from "../src/config.ts";
import { coAuthorTrailer } from "../src/git.ts";
import { guard, hasMessage, UPDATE } from "../src/guard.ts";
import { bunVersionProblem } from "../scripts/bun-version.ts";

const root = join(import.meta.dir, "..");
/** Byte-identical copies of johnrees/penmon's .githooks/commit-msg and pre-push. */
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
  expect(count()).toBe(before);
  expect(hasMessage("\n# only a comment\n", "#")).toBe(false);
  expect(hasMessage("#123 fix\n", "#")).toBe(false);
  expect(hasMessage("#123 fix\n", ";")).toBe(true);
  expect(hasMessage(`\n# ------------------------ >8 ------------------------\ndiff --git a/f b/f\n`, "#")).toBe(false);
});

test("git's comment character is the repository's own", () => {
  const { agent, run, last, config } = world();
  config("core.commentChar", ";");
  expect(run(["git", "commit", "-q", "-m", "#123 fix"], agent).code).toBe(0);
  expect(last("%B")).toBe(`#123 fix\n\n${CLAUDE_TRAILERS}`);
});

test("a person's commit, and any commit in a repository with no github.com remote, is left exactly as written", () => {
  const { person, run, last } = world();
  expect(run(["git", "commit", "-q", "-m", "mine"], person)).toEqual({ code: 0, stderr: "" });
  expect(last("%B")).toBe("mine");
  const local = world({ onGitHub: false });
  expect(local.run(["git", "commit", "-q", "-m", "local"], local.agent)).toEqual({ code: 0, stderr: "" });
  expect(local.last("%B")).toBe("local");
});

test("pushes pass the hook, an agent's and a person's alike", () => {
  const { person, agent, run } = world();
  expect(run(["git", "commit", "-q", "-m", "mine"], person).code).toBe(0);
  expect(run(["git", "push", "-q", "origin", "HEAD:main"], agent).code).toBe(0);
  expect(run(["git", "push", "-q", "origin", "HEAD:person"], person).code).toBe(0);
});

test("a session agent-gh cannot identify stops the commit with the fix, rather than crediting nobody", () => {
  const { person, run, count } = world();
  const before = count();
  const commit = run(["git", "commit", "-q", "-m", "who"], { ...person, OPENCODE_TERMINAL: "1" });
  expect(commit.code).not.toBe(0);
  expect(commit.stderr).toContain("opencode does not tell shell commands which model runs");
  expect(count()).toBe(before);
});

test("a hook this version does not understand fails with exit 2 and the update command, never a pass", () => {
  for (const args of [["post-merge"], [], ["commit-msg"], ["commit-msg", "a", "b"]]) {
    for (const env of [{}, AGENT]) {
      const verdict = guard(args, env, "/nonexistent", REGISTRY, () => {
        throw new Error("an unknown hook never reads the repository");
      });
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
