import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "..", "src", "main.ts");
const NEXT = "\nFix what this names, or report it to John; never publish another way (John's own login, gh without agent-gh, or a connector).";

/** Runs the CLI offline: these cases all stop before any request. */
const cli = async (args: string[], env: Record<string, string>) => {
  const home = mkdtempSync(join(tmpdir(), "agent-gh-home-"));
  const child = Bun.spawn([process.execPath, main, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stderr: stderr.trim(), stdout };
};

test("outside an agent session, agent-gh refuses", async () => {
  expect(await cli(["pr", "view"], {})).toMatchObject({
    code: 1,
    stderr:
      `agent-gh: detecting the harness failed: no agent harness detected; run gh yourself, agent-gh is for agent sessions.${NEXT}`,
  });
});

test("a family in the registry needs only a login, and is never told to run setup", async () => {
  for (const [env, family] of [
    [{ CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", GH_REPO: "johnrees/penmon" }, "claude"],
    [{ PI_SESSION_ID: "p", PI_PROVIDER: "zai", PI_MODEL: "glm-4.6", GH_REPO: "johnrees/penmon" }, "glm"],
  ] as const) {
    const result = await cli(["pr", "view"], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith(`agent-gh: reading the login failed: no login for ${family}; run \`agent-gh login ${family}\` in your own terminal`);
    expect(result.stderr).not.toContain("setup");
  }
});

test("outside a clone, gh runs with no repository, and doctor asks for one", async () => {
  const agent = { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" };
  for (const args of [["api", "user"], ["repo", "clone", "johnrees/penmon"], ["search", "issues", "x"]]) {
    const result = await cli(args, agent);
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith("agent-gh: reading the login failed: no login for claude");
  }
  expect((await cli(["doctor"], agent)).stderr).toStartWith(
    "agent-gh: resolving the repository failed: no GH_REPO and no github.com origin remote; run doctor inside a clone of the repository",
  );
});

test("an IDE terminal's CLAUDECODE is a person, and opencode must declare its model", async () => {
  expect((await cli(["pr", "view"], { CLAUDECODE: "1" })).stderr).toContain("no agent harness detected");
  const opencode = await cli(["pr", "view"], { OPENCODE_TERMINAL: "1", GH_REPO: "johnrees/penmon" });
  expect(opencode.code).toBe(1);
  expect(opencode.stderr).toStartWith("agent-gh: detecting the model failed: opencode does not tell shell commands which model runs");
});

test("agents cannot run setup, for any family", async () => {
  const result = await cli(["setup", "glm"], { CODEX_THREAD_ID: "t" });
  expect(result).toMatchObject({
    code: 1,
    stderr:
      `agent-gh: setting up failed: agents do not create their own credentials; run \`agent-gh setup\` in your own terminal.${NEXT}`,
  });
});

test("an agent cannot authorize itself to act as John", async () => {
  for (const env of [{ CODEX_THREAD_ID: "t" }, { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" }, { PI_SESSION_ID: "p" }]) {
    expect(await cli(["login", "claude"], env)).toMatchObject({
      code: 1,
      stderr:
        `agent-gh: logging in failed: an agent cannot authorize itself to act as John; run \`agent-gh login\` in your own terminal.${NEXT}`,
    });
  }
  const unknown = await cli(["login", "mistral"], {});
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toStartWith("usage:");
});

test("an unknown family for setup prints usage listing the families", async () => {
  const result = await cli(["setup", "mistral"], {});
  expect(result.code).toBe(1);
  expect(result.stderr).toStartWith("usage:");
  expect(result.stderr).toContain("(claude, codex, glm, deepseek, kimi, qwen, or read)");
});

test("agent-gh git, from older releases, is plain git with a note, in or out of an agent session", async () => {
  for (const env of [{}, { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" }]) {
    const result = await cli(["git", "--version"], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toStartWith("git version ");
    expect(result.stderr).toBe("agent-gh: `agent-gh git` is plain git now; run git directly (the repository's commit hook credits the App)");
  }
  expect((await cli(["git", "no-such-subcommand"], {})).code).toBe(1);
});

test("review takes sweep or full and their own flags, and refuses anything else before any request", async () => {
  const agent = { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", GH_REPO: "johnrees/penmon" };
  for (const args of [["review"], ["review", "all"], ["review", "full", "--base", "main"], ["review", "full", "--pr", "x"], ["review", "sweep", "--effort", "huge"], ["review", "full", "--pr"]]) {
    const result = await cli(args, agent);
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith("usage:");
  }
});
