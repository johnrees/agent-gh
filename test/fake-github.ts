import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.ts";
import type { Api } from "../src/github.ts";
import type { Login } from "../src/login.ts";

/** Marks that must never reach a message: GitHub's bodies and headers. */
export const SECRET_BODY = "SECRET-BODY-3f1c";
export const SECRET_HEADER = "SECRET-HEADER-9a2e";

export type Logged = { method: string; path: string; auth: string; body: string };
type Route = (body: string) => Response | Promise<Response>;

export const reply = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "X-Secret": SECRET_HEADER },
  });

/**
 * A local stand-in for api.github.com and github.com's OAuth endpoints, on one
 * server: routes keyed by "METHOD /path".
 */
export const fakeGitHub = (routes: Record<string, Route>) => {
  const log: Logged[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = await request.text();
      log.push({ method: request.method, path: url.pathname, auth: request.headers.get("authorization") ?? "", body });
      const route = routes[`${request.method} ${url.pathname}`];
      return route ? route(body) : reply(404, { message: SECRET_BODY });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const api: Api = { base, web: base, timeoutMs: 2000 };
  return { api, log, stop: () => server.stop(true) };
};

/** A healthy App installed on johnrees/penmon. */
export const HAPPY = {
  "GET /repos/johnrees/penmon/installation": () => reply(200, { id: 42 }),
  "GET /user": () => reply(200, { login: "johnrees" }),
} as const;

export const CONFIG: AppConfig = {
  client_id: "Iv23liTESTCLIENT",
  app_id: 7,
  slug: "johnrees-claude",
  bot_login: "johnrees-claude[bot]",
  bot_user_id: 123456,
};

export const ACCESS = "ghu_access_test_1111";
export const REFRESH = "ghr_refresh_test_2222";

/** A config directory holding a fresh test keypair's private key and CONFIG. */
export const credentials = (family = "claude", config: AppConfig = CONFIG) => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const dir = join(mkdtempSync(join(tmpdir(), "agent-gh-")), "config");
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, `${family}.pem`), pem, { mode: 0o600 });
  writeFileSync(join(dir, `${family}.json`), JSON.stringify(config), { mode: 0o600 });
  chmodSync(join(dir, `${family}.pem`), 0o600);
  return { dir, pem, publicKey };
};

/** Stores a login for `family`, valid for eight hours from `now` unless overridden. */
export const loggedIn = (dir: string, now: number, overrides: Partial<Login> = {}, family = "claude"): Login => {
  const login: Login = {
    access_token: ACCESS,
    expires_at: now + 28_800,
    refresh_token: REFRESH,
    refresh_expires_at: now + 15_897_600,
    ...overrides,
  };
  writeFileSync(join(dir, `${family}.token.json`), JSON.stringify(login), { mode: 0o600 });
  return login;
};
