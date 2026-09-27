import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/run.ts";
import { gitShim } from "../src/shims.ts";
import { readGitConfig } from "../src/target.ts";
import { CONFIG, credentials, fakeGitHub, HAPPY, loggedIn } from "./fake-github.ts";

const main = join(import.meta.dir, "..", "src", "main.ts");
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/**
 * An agent session's git, the way soltui's tests meet it (johnrees/soltui#400):
 * the real git shim first on PATH, sending commits and pushes to this
 * checkout's agent-gh, in a throwaway repository whose origin is a URL, a local
 * path ("path"), or none. HOME is empty, so agent-gh has no login, and nothing
 * may need one.
 */
const world = (origin?: string) => {
  const root = mkdtempSync(join(tmpdir(), "agent-gh-local-"));
  const shims = join(root, "shims");
  const bin = join(root, "bin");
  mkdirSync(shims);
  mkdirSync(bin);
  const agentGh = join(bin, "agent-gh");
  writeFileSync(agentGh, `#!/bin/sh\nexec '${process.execPath}' '${main}' "$@"\n`);
  writeFileSync(join(shims, "git"), gitShim(shims, agentGh));
  chmodSync(agentGh, 0o755);
  chmodSync(join(shims, "git"), 0o755);
  const agent = {
    PATH: `${shims}:${process.env.PATH ?? ""}`,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    // Whatever goes wrong, nothing here reaches github.com: its other URLs lead nowhere.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${join(root, "nowhere")}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
  };
  const dir = join(root, "repo");
  const setup = (args: string[]) => Bun.spawnSync(["git", ...args], { env: { ...agent, AGENT_GH_CHILD: "1" } });
  const bare = (name: string) => {
    const path = join(root, `${name}.git`);
    setup(["init", "-q", "--bare", "-b", "main", path]);
    return path;
  };
  setup(["init", "-q", "-b", "main", dir]);
  setup(["-C", dir, "config", "user.name", "John Rees"]);
  setup(["-C", dir, "config", "user.email", "john@example.com"]);
  if (origin === "path") setup(["-C", dir, "remote", "add", "origin", bare("origin")]);
  else if (origin !== undefined) {
    // A hosted origin really points at a local bare repository.
    setup(["-C", dir, "remote", "add", "origin", origin]);
    setup(["-C", dir, "config", `url.${bare("origin")}.insteadOf`, origin]);
  }
  writeFileSync(join(dir, "f"), "a\n");
  setup(["-C", dir, "add", "f"]);
  const git = (args: string[]) => {
    const result = Bun.spawnSync([join(shims, "git"), ...args], { cwd: dir, env: agent, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, stderr: result.stderr.toString() };
  };
  const show = (args: string[]) => setup(["-C", dir, ...args]).stdout.toString().trim();
  return { dir, agent, bare, git, show };
};

const SUCCESS = { code: 0, stderr: "" };

test("in a repository with no remote, an agent's commit and local-path push are plain git", () => {
  const { dir, bare, git, show } = world();
  expect(git(["commit", "-q", "-m", "local"])).toEqual(SUCCESS);
  expect(show(["log", "-1", "--format=%an <%ae>%n%B"])).toBe("John Rees <john@example.com>\nlocal");
  const target = bare("target");
  expect(git(["push", "-q", target, "HEAD:main"])).toEqual(SUCCESS);
  expect(show(["--git-dir", target, "rev-parse", "main"])).toBe(show(["rev-parse", "HEAD"]));
  writeFileSync(join(dir, "f"), "b\n");
  expect(git(["commit", "-q", "-a", "--amend", "--no-edit"])).toEqual(SUCCESS);
  expect(show(["log", "-1", "--format=%B"])).toBe("local");
});

test("with only a non-GitHub remote, commits, pushes, and pulls are plain git", () => {
  for (const origin of ["path", "https://gitlab.com/johnrees/fixture.git"]) {
    const { bare, git, show } = world(origin);
    expect([origin, git(["commit", "-q", "-m", "local"])]).toEqual([origin, SUCCESS]);
    expect(show(["log", "-1", "--format=%B"])).toBe("local");
    expect([origin, git(["push", "-q", "-u", "origin", "HEAD:main"])]).toEqual([origin, SUCCESS]);
    expect([origin, git(["push", "-q"])]).toEqual([origin, SUCCESS]);
    expect([origin, git(["pull", "-q"])]).toEqual([origin, SUCCESS]);
    expect([origin, git(["push", "-q", bare("elsewhere"), "HEAD:main"])]).toEqual([origin, SUCCESS]);
  }
});

test("with a github.com origin, an agent's commit still gets the trailers, however the origin is spelled", () => {
  const check = (git: (args: string[]) => unknown, show: (args: string[]) => string) => {
    expect(git(["commit", "-q", "-m", "routed"])).toEqual(SUCCESS);
    const message = show(["log", "-1", "--format=%B"]);
    expect(message).toStartWith("routed\n\nAgent-Harness: claude\n");
    expect(message).toMatch(/\nCo-authored-by: johnrees-claude\[bot\] <\d+\+johnrees-claude\[bot\]@users\.noreply\.github\.com>$/);
  };
  const plain = world("https://github.com/johnrees/penmon.git");
  check(plain.git, plain.show);
  // A shorthand that an insteadOf rule sends to github.com.
  const shorthand = world();
  shorthand.show(["remote", "add", "origin", "gh:johnrees/penmon"]);
  shorthand.show(["config", "url.https://github.com/.insteadOf", "gh:"]);
  check(shorthand.git, shorthand.show);
});

test("with a github.com origin, a push to it checks the App's installation, and a push to a local path does not", async () => {
  const { dir, agent, bare, git, show } = world("https://github.com/johnrees/penmon.git");
  expect(git(["commit", "-q", "-m", "routed"])).toEqual(SUCCESS);
  const fake = fakeGitHub(HAPPY);
  stops.push(fake.stop);
  const creds = credentials("claude", CONFIG, { key: false });
  loggedIn(creds.dir, 1_800_000_000);
  const context = {
    identity: { harness: "claude", family: "claude" },
    env: agent,
    api: fake.api,
    configDir: creds.dir,
    registry: {},
    nowSeconds: () => 1_800_000_000,
    sleep: async () => {},
    readGitConfig: (at: string) => readGitConfig(at, agent),
  } as const;
  const checked = () => fake.log.map((request) => `${request.method} ${request.path}`).includes("GET /user/installations");
  expect(await runGit(context, ["-C", dir, "push", "-q", "-u", "origin", "HEAD:main"])).toBe(0);
  expect(checked()).toBe(true);
  expect(show(["--git-dir", join(dir, "..", "origin.git"), "rev-parse", "main"])).toBe(show(["rev-parse", "HEAD"]));
  fake.log.length = 0;
  expect(await runGit(context, ["-C", dir, "push", "-q"])).toBe(0);
  expect(checked()).toBe(true);

  fake.log.length = 0;
  const target = bare("target");
  expect(await runGit(context, ["-C", dir, "push", "-q", target, "HEAD:main"])).toBe(0);
  expect(fake.log).toEqual([]);
  expect(show(["--git-dir", target, "rev-parse", "main"])).toBe(show(["rev-parse", "HEAD"]));
});
