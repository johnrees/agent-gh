import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_APP, REGISTRY } from "../src/config.ts";
import { familyNames } from "../src/family.ts";
import { configuredFamilies, settingsLines } from "../src/settings.ts";

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

test("settings without a family lists every family with an App, local or in the registry", async () => {
  const result = await settings([], { claude: "johnrees-claude" });
  expect(result.code).toBe(0);
  const expected = [...familyNames(), READ_APP]
    .filter((app) => app === "claude" || Object.hasOwn(REGISTRY, app))
    .map((app) => `${app}: ${app === "claude" ? "johnrees-claude" : REGISTRY[app]?.slug}`);
  expect(result.stdout.filter((line) => !line.startsWith(" "))).toEqual(expected);
});

test("a family with no App anywhere gets the setup advice for where Apps are created, not URLs", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "agent-gh-")), "none");
  expect(settingsLines(dir, "glm", "https://github.com", {})).toEqual([
    "glm: has no App yet; run `agent-gh setup glm` on the machine where you create Apps, then commit the registry entry it prints",
  ]);
  expect(configuredFamilies(dir, {})).toEqual([]);
});

test("a family in the registry prints its pages without any local config", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "agent-gh-")), "none");
  const registry = { glm: { slug: "johnrees-glm", app_id: 1, client_id: "Iv23liG", bot_user_id: 2 } };
  expect(settingsLines(dir, "glm", "https://github.com", registry)[0]).toBe("glm: johnrees-glm");
  expect(configuredFamilies(dir, registry)).toEqual(["glm"]);
});

test("settings refuses an unknown family", async () => {
  const unknown = await settings(["gemma"], {});
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toStartWith("usage:");
});
