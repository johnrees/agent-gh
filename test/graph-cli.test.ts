import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "..", "src", "main.ts");

/** Runs the CLI offline: these cases all stop before any request. */
const cli = async (args: string[], env: Record<string, string>) => {
  const home = mkdtempSync(join(tmpdir(), "agent-gh-home-"));
  const child = Bun.spawn([process.execPath, main, ...args], { cwd: home, env: { PATH: process.env.PATH ?? "", HOME: home, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stderr: stderr.trim(), stdout };
};

test("a person's graph reads with the read App in every format, never the agent-session refusal", async () => {
  for (const format of [["--json"], ["--mermaid", "--milestone", "M0"], ["--html"], ["--html", "--out", "g.html"]]) {
    const result = await cli(["graph", ...format, "-R", "johnrees/widget"], {});
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith("agent-gh: reading the login failed: no login for read; run `agent-gh login read` in your own terminal");
  }
});

test("graph with a flag its format does not take prints the usage", async () => {
  const result = await cli(["graph", "--mermaid", "--every", "60", "-R", "johnrees/widget"], {});
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("agent-gh graph --json|--mermaid|--html [--all] [-R repo]");
});
