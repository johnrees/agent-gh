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
  const result = await cli(["pr", "view"], { CLAUDECODE: "1", GH_REPO: "johnrees/penmon" });
  expect(result.code).toBe(1);
  expect(result.stderr).toStartWith("agent-gh: reading config failed: no App for claude in ");
  expect(result.stderr).toContain("run `agent-gh setup claude` in your own terminal");
});

test("agents cannot run setup", async () => {
  const result = await cli(["setup", "claude"], { CODEX_THREAD_ID: "t" });
  expect(result).toEqual({
    code: 1,
    stderr:
      "agent-gh: setting up failed: agents do not create their own credentials; run `agent-gh setup` in your own terminal. No personal-login fallback was used.",
  });
});

test("an unknown harness for setup prints usage", async () => {
  const result = await cli(["setup", "copilot"], {});
  expect(result.code).toBe(1);
  expect(result.stderr).toStartWith("usage:");
});
