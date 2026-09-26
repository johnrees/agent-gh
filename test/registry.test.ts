import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, REGISTRY } from "../src/config.ts";
import { familyNames } from "../src/family.ts";

test("every registry entry names a family the family table knows", () => {
  for (const family of Object.keys(REGISTRY)) expect(familyNames()).toContain(family);
});

test("every registry entry is a usable App: public identifiers only", () => {
  const empty = join(tmpdir(), "agent-gh-no-local-config");
  for (const [family, entry] of Object.entries(REGISTRY)) {
    expect(Object.keys(entry).sort()).toEqual(["app_id", "bot_user_id", "client_id", "slug"]);
    const config = readConfig(empty, family);
    expect(config.bot_login).toBe(`${entry.slug}[bot]`);
    expect(config.client_id).toMatch(/^Iv[0-9A-Za-z.]+$/);
  }
});
