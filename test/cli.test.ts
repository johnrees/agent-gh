import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "..", "src", "main.ts");

/** Runs the CLI offline: these cases all stop before any request. */
const cli = async (args: string[], env: Record<string, string>) => {
  const home = mkdtempSync(join(tmpdir(), "agent-gh-home-"));
  const child = Bun.spawn([process.execPath, main, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr: stderr.trim() };
};

test("outside an agent session, agent-gh refuses", async () => {
  expect(await cli(["pr", "view"], {})).toEqual({
    code: 1,
    stderr:
      "agent-gh: detecting the harness failed: no agent harness detected; run gh yourself, agent-gh is for agent sessions. No personal-login fallback was used.",
  });
});

test("without an App, agent-gh names the setup command", async () => {
  const result = await cli(["pr", "view"], { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", GH_REPO: "johnrees/penmon" });
  expect(result.code).toBe(1);
  expect(result.stderr).toStartWith("agent-gh: reading config failed: no App for claude in ");
  expect(result.stderr).toContain("run `agent-gh setup claude` in your own terminal");
});

test("a family without an App names its setup command", async () => {
  const result = await cli(["pr", "view"], { PI_SESSION_ID: "p", PI_PROVIDER: "zai", PI_MODEL: "glm-4.6", GH_REPO: "johnrees/penmon" });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("no App for glm in ");
  expect(result.stderr).toContain("run `agent-gh setup glm` in your own terminal");
});

test("an IDE terminal's CLAUDECODE is a person, and opencode must declare its model", async () => {
  expect((await cli(["pr", "view"], { CLAUDECODE: "1" })).stderr).toContain("no agent harness detected");
  const opencode = await cli(["pr", "view"], { OPENCODE_TERMINAL: "1", GH_REPO: "johnrees/penmon" });
  expect(opencode.code).toBe(1);
  expect(opencode.stderr).toStartWith("agent-gh: detecting the model failed: opencode does not tell shell commands which model runs");
});

test("agents cannot run setup, for any family", async () => {
  const result = await cli(["setup", "glm"], { CODEX_THREAD_ID: "t" });
  expect(result).toEqual({
    code: 1,
    stderr:
      "agent-gh: setting up failed: agents do not create their own credentials; run `agent-gh setup` in your own terminal. No personal-login fallback was used.",
  });
});

test("an agent cannot authorize itself to act as John", async () => {
  for (const env of [{ CODEX_THREAD_ID: "t" }, { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" }, { PI_SESSION_ID: "p" }]) {
    expect(await cli(["login", "claude"], env)).toEqual({
      code: 1,
      stderr:
        "agent-gh: logging in failed: an agent cannot authorize itself to act as John; run `agent-gh login` in your own terminal. No personal-login fallback was used.",
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
  expect(result.stderr).toContain("(claude, codex, glm, deepseek, kimi, qwen)");
});
