import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY } from "../src/config.ts";
import { coAuthorTrailer } from "../src/git.ts";
import { guard, UPDATE } from "../src/guard.ts";
import { runAs } from "../src/run.ts";
import { bunVersionProblem } from "../scripts/bun-version.ts";
import { CONFIG, credentials, fakeGitHub, HAPPY, loggedIn } from "./fake-github.ts";

const root = join(import.meta.dir, "..");
/** Byte-identical copies of johnrees/penmon's .githooks/commit-msg and pre-push. */
const HOOKS = join(import.meta.dir, "penmon-hooks");
/** A Claude Code agent session; a person's shell has neither variable. */
const AGENT = { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" };
const claude = REGISTRY.claude;
if (claude === undefined) throw new Error("the registry has no claude App");
const CLAUDE_TRAILER = coAuthorTrailer(claude);

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

/**
 * A clone with Penmon's hooks switched on, one staged file, and an `agent-gh`
 * on PATH that runs this checkout's source. Its `origin` is a github.com URL
 * that git rewrites to a local bare repository, so it is a GitHub repository
 * to agent-gh while pushes stay local; `onGitHub: false` makes `origin` the
 * bare path itself.
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
  for (const [key, value] of [["user.name", "John Rees"], ["user.email", "john@example.com"], ["core.hooksPath", HOOKS]]) {
    Bun.spawnSync(["git", "-C", dir, "config", key as string, value as string]);
  }
  const url = onGitHub ? "https://github.com/johnrees/penmon.git" : remote;
  Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", url]);
  if (onGitHub) Bun.spawnSync(["git", "-C", dir, "config", `url.${remote}.insteadOf`, url]);
  writeFileSync(join(dir, "f"), "a\n");
  Bun.spawnSync(["git", "-C", dir, "add", "f"]);
  const person = { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GH_REPO: "johnrees/penmon" };
  const agent = { ...person, ...AGENT };
  const run = (command: string[], env: Record<string, string>) => {
    const result = Bun.spawnSync(command, { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, stderr: result.stderr.toString() };
  };
  const last = (format: string) => Bun.spawnSync(["git", "-C", dir, "log", "-1", `--format=${format}`]).stdout.toString().trim();
  return { home, dir, person, agent, run, last };
};

test("an agent session's bare commit is refused, and the same commit through agent-gh passes", () => {
  const { agent, run, last } = world();
  const bare = run(["git", "commit", "-q", "-m", "bare"], agent);
  expect(bare.code).not.toBe(0);
  expect(bare.stderr).toContain("commit through agent-gh: `agent-gh git commit ...`");
  expect(run(["agent-gh", "git", "commit", "-q", "-m", "through"], agent).code).toBe(0);
  expect(last("%s|%an")).toBe("through|John Rees");
  expect(last("%B")).toContain(CLAUDE_TRAILER);
});

test("git applies --trailer before commit-msg runs, so the trailer alone satisfies the guard", () => {
  const { agent, run } = world();
  expect(run(["git", "commit", "-q", "--trailer", CLAUDE_TRAILER, "-m", "trailer"], agent).code).toBe(0);
});

test("an agent session's bare push is refused", () => {
  const { person, agent, run } = world();
  expect(run(["git", "commit", "-q", "-m", "mine"], person).code).toBe(0);
  const push = run(["git", "push", "-q", "origin", "HEAD:main"], agent);
  expect(push.code).not.toBe(0);
  expect(push.stderr).toContain("pushes through agent-gh");
});

test("a push through agent-gh passes the pre-push guard", async () => {
  const { dir, person, agent, run } = world();
  expect(run(["git", "commit", "-q", "-m", "mine"], person).code).toBe(0);
  const fake = fakeGitHub(HAPPY);
  stops.push(fake.stop);
  const creds = credentials("claude", CONFIG, { key: false });
  loggedIn(creds.dir, 1_800_000_000);
  const code = await runAs(
    {
      identity: { harness: "claude", family: "claude" },
      repo: { owner: "johnrees", name: "penmon" },
      env: agent,
      api: fake.api,
      configDir: creds.dir,
      registry: {},
      nowSeconds: () => 1_800_000_000,
      sleep: async () => {},
    },
    ["git", "-C", dir, "push", "-q", "origin", "HEAD:main"],
  );
  expect(code).toBe(0);
});

test("a repository with no github.com remote is never refused: its hooks are its own business", () => {
  const { agent, run, last } = world({ onGitHub: false });
  expect(run(["git", "commit", "-q", "-m", "local"], agent)).toEqual({ code: 0, stderr: "" });
  expect(last("%B")).toBe("local");
  expect(run(["git", "push", "-q", "origin", "HEAD:main"], agent).code).toBe(0);
});

test("a pre-push hook told the push goes elsewhere lets it through, even in a GitHub repository", () => {
  const { dir } = world();
  const github = () => ({ urls: new Map([["origin", ["https://github.com/johnrees/penmon.git"]]]), pushUrls: new Map(), rewrites: [], sshHostname: () => undefined, branch: undefined, get: () => undefined });
  expect(guard(["pre-push", "fixture", `${dir}/../remote.git`], AGENT, "/nonexistent", REGISTRY, github).code).toBe(0);
  expect(guard(["pre-push", "origin", "https://github.com/johnrees/penmon.git"], AGENT, "/nonexistent", REGISTRY, github).code).toBe(1);
  expect(guard(["pre-push"], AGENT, "/nonexistent", REGISTRY, github).code).toBe(1);
});

test("outside an agent session, both hooks pass", () => {
  const { person, run } = world();
  expect(run(["git", "commit", "-q", "-m", "mine"], person).code).toBe(0);
  expect(run(["git", "push", "-q", "origin", "HEAD:main"], person).code).toBe(0);
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
