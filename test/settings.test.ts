import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "..", "src", "main.ts");

/** Runs `agent-gh settings` with a fresh HOME holding the given family configs. */
const settings = async (args: string[], slugs: Record<string, string>) => {
  const home = mkdtempSync(join(tmpdir(), "agent-gh-home-"));
  const dir = join(home, ".config", "agent-gh");
  mkdirSync(dir, { recursive: true });
  for (const [family, slug] of Object.entries(slugs)) {
    const config = { client_id: "Iv1.test", app_id: 1, slug, bot_login: `${slug}[bot]`, bot_user_id: 2 };
    writeFileSync(join(dir, `${family}.json`), JSON.stringify(config));
  }
  const child = Bun.spawn([process.execPath, main, "settings", ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout: stdout.trim().split("\n"), stderr: stderr.trim() };
};

test("settings prints a family's pages from its recorded slug", async () => {
  expect(await settings(["claude"], { claude: "johnrees-claude-2" })).toEqual({
    code: 0,
    stdout: [
      "claude: johnrees-claude-2",
      "  app settings:      https://github.com/settings/apps/johnrees-claude-2",
      "  permissions:       https://github.com/settings/apps/johnrees-claude-2/permissions",
      "  repository access: https://github.com/apps/johnrees-claude-2/installations/new",
    ],
    stderr: "",
  });
});

test("settings without a family lists every set-up family", async () => {
  const result = await settings([], { claude: "johnrees-claude", codex: "johnrees-codex" });
  expect(result.code).toBe(0);
  expect(result.stdout.filter((line) => !line.startsWith(" "))).toEqual(["claude: johnrees-claude", "codex: johnrees-codex"]);
});

test("a family that is not set up gets the setup command, not URLs, and exit 1", async () => {
  expect(await settings(["glm"], { claude: "johnrees-claude" })).toEqual({
    code: 1,
    stdout: ["glm: not set up; run `agent-gh setup glm` in your own terminal"],
    stderr: "",
  });
});

test("settings refuses an unknown family and an empty setup", async () => {
  const unknown = await settings(["gemma"], {});
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toStartWith("usage:");
  const empty = await settings([], {});
  expect(empty.code).toBe(1);
  expect(empty.stderr).toContain("no family is set up");
});
