import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Failure } from "../src/failure.ts";
import { manifest, setup } from "../src/setup.ts";
import { fakeGitHub, reply } from "./fake-github.ts";

let stops: (() => void)[] = [];
/** The simulated browser's visit, awaited by tests that check what it saw. */
let visit: Promise<void> = Promise.resolve();
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

test("the manifest asks for exactly the permissions agents need, and no webhook deliveries", () => {
  const value = manifest("codex", "http://127.0.0.1:5000/callback");
  expect(value.name).toBe("johnrees-codex");
  expect(value.public).toBe(false);
  expect(value.hook_attributes.active).toBe(false);
  expect(value.default_events).toEqual([]);
  expect(value.default_permissions).toEqual({
    contents: "write",
    issues: "write",
    pull_requests: "write",
    actions: "read",
    checks: "read",
  });
  expect(value.redirect_url).toBe("http://127.0.0.1:5000/callback");
  expect("callback_urls" in value).toBe(false);
});

const conversion = {
  id: 99,
  slug: "johnrees-codex",
  client_id: "Iv23liCONVERTED",
  client_secret: "CLIENT-SECRET-must-not-be-stored",
  webhook_secret: "WEBHOOK-SECRET-must-not-be-stored",
  pem: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n",
};

const run = (configDir: string, onPage: (page: string, local: string) => Promise<void>) => {
  const fake = fakeGitHub({
    "POST /app-manifests/code123/conversions": () => reply(201, conversion),
    "GET /users/johnrees-codex%5Bbot%5D": () => reply(200, { id: 424242 }),
  });
  stops.push(fake.stop);
  return setup("codex", {
    configDir,
    api: fake.api,
    github: "https://github.example",
    print: () => {},
    timeoutMs: 5000,
    open: (local) => {
      visit = fetch(local)
        .then((response) => response.text())
        .then((page) => onPage(page, local));
    },
  });
};

test("the manifest flow stores the key and public identifiers only", async () => {
  const configDir = join(mkdtempSync(join(tmpdir(), "agent-gh-setup-")), "agent-gh");
  let wrongState = 0;
  let result = "";
  const config = await run(configDir, async (page, local) => {
    expect(page).toContain('action="https://github.example/settings/apps/new?state=');
    expect(page).toContain("&quot;pull_requests&quot;:&quot;write&quot;");
    const state = /state=([0-9a-f]+)/.exec(page)?.[1];
    wrongState = (await fetch(`${local}callback?code=code123&state=forged`)).status;
    result = await (await fetch(`${local}callback?code=code123&state=${state}`)).text();
  });
  expect(wrongState).toBe(400);
  // The browser receives the result page before the server stops.
  await visit;
  expect(result).toContain("Created johnrees-codex.");
  expect(config).toEqual({
    client_id: "Iv23liCONVERTED",
    app_id: 99,
    slug: "johnrees-codex",
    bot_login: "johnrees-codex[bot]",
    bot_user_id: 424242,
  });
  expect(statSync(configDir).mode & 0o777).toBe(0o700);
  for (const file of ["codex.pem", "codex.json"]) expect(statSync(join(configDir, file)).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(configDir, "codex.pem"), "utf8")).toBe(conversion.pem);
  const stored = readFileSync(join(configDir, "codex.json"), "utf8");
  expect(stored).not.toContain("SECRET");
  expect(JSON.parse(stored)).toEqual(config);
});

test("setup refuses when the harness already has an App", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "agent-gh-setup-"));
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "codex.json"), "{}");
  const error = await run(configDir, async () => {}).catch((failure: Failure) => failure);
  expect(error).toBeInstanceOf(Failure);
  expect((error as Failure).detail).toContain("already configured");
});
