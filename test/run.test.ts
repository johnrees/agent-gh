import { afterEach, describe as group, expect, test } from "bun:test";
import { verify } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, Failure } from "../src/failure.ts";
import { requireInstallation } from "../src/github.ts";
import { type Context, runAs } from "../src/run.ts";
import {
  ACCESS,
  CONFIG,
  credentials,
  fakeGitHub,
  HAPPY,
  loggedIn,
  REFRESH,
  reply,
  SECRET_BODY,
  SECRET_HEADER,
} from "./fake-github.ts";

const NOW = 1_800_000_000;
let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

type Routes = Record<string, (body: string) => Response | Promise<Response>>;

const setup = (routes: Routes = HAPPY, login: Parameters<typeof loggedIn>[2] | null = {}) => {
  const fake = fakeGitHub(routes);
  stops.push(fake.stop);
  const creds = credentials();
  if (login !== null) loggedIn(creds.dir, NOW, login);
  const out = join(mkdtempSync(join(tmpdir(), "agent-gh-out-")), "env.json");
  const context: Context = {
    identity: { harness: "claude", family: "claude" },
    repo: { owner: "johnrees", name: "penmon" },
    env: { PATH: process.env.PATH, OUT: out, GH_DEBUG: "api", GH_TOKEN: "ghp_johns_own" },
    api: fake.api,
    configDir: creds.dir,
    nowSeconds: () => NOW,
    sleep: (ms) => Bun.sleep(Math.min(ms, 10)),
  };
  return { fake, creds, out, context };
};

/** A child that records its environment, then exits with `code`. */
const recorder = (code = 0) => [
  process.execPath,
  "-e",
  `require("node:fs").writeFileSync(process.env.OUT, JSON.stringify(process.env)); process.exit(${code})`,
];

const failure = async (promise: Promise<unknown>): Promise<Failure> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Failure) return error;
    throw error;
  }
  throw new Error("expected a Failure");
};

/** Nothing secret reaches a message: GitHub's bodies and headers, keys, JWTs, or tokens. */
const clean = (message: string, extra: readonly string[] = []) => {
  for (const secret of [SECRET_BODY, SECRET_HEADER, "BEGIN RSA", "eyJ", ACCESS, REFRESH, "ghu_new", "ghr_new", ...extra]) {
    expect(message).not.toContain(secret);
  }
};

const form = (body: string) => Object.fromEntries(new URLSearchParams(body));

group("a command runs as John through the family App", () => {
  test("the installation is checked with a JWT signed by the App key", async () => {
    const { fake, creds, context } = setup();
    expect(await runAs(context, recorder())).toBe(0);
    expect(fake.log.map((entry) => `${entry.method} ${entry.path}`)).toEqual(["GET /repos/johnrees/penmon/installation"]);
    const jwt = fake.log[0]?.auth.replace(/^Bearer /, "") ?? "";
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toEqual({
      iat: NOW - 60,
      exp: NOW + 540,
      iss: CONFIG.client_id,
    });
    expect(
      verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), creds.publicKey, Buffer.from(signature ?? "", "base64url")),
    ).toBe(true);
  });

  test("the child gets John's user token for the App and keeps John's git identity", async () => {
    const { out, context } = setup();
    await runAs(context, recorder());
    const env = JSON.parse(readFileSync(out, "utf8"));
    expect(env.GH_TOKEN).toBe(ACCESS);
    expect(env.GITHUB_TOKEN).toBe(ACCESS);
    expect(env.GH_REPO).toBe("johnrees/penmon");
    expect(env.GH_DEBUG).toBeUndefined();
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(REFRESH);
  });

  test("the child's exit code is returned", async () => {
    const { context } = setup();
    expect(await runAs(context, recorder(3))).toBe(3);
  });

  test("the key buffer is zeroed after signing", async () => {
    const { fake, creds } = setup();
    const key = readFileSync(join(creds.dir, "claude.pem"));
    await requireInstallation(fake.api, CONFIG, key, { owner: "johnrees", name: "penmon" }, NOW);
    expect(key.every((byte) => byte === 0)).toBe(true);
  });
});

group("the login refreshes before it expires, once, under a lock", () => {
  const rotated = (body: string) => {
    expect(form(body)).toEqual({ client_id: CONFIG.client_id, grant_type: "refresh_token", refresh_token: REFRESH });
    return reply(200, {
      access_token: "ghu_new_3333",
      expires_in: 28_800,
      refresh_token: "ghr_new_4444",
      refresh_token_expires_in: 15_897_600,
      token_type: "bearer",
      scope: "",
    });
  };

  test("a token within five minutes of expiry is refreshed without the client secret, and the rotation is stored", async () => {
    const { fake, creds, out, context } = setup({ ...HAPPY, "POST /login/oauth/access_token": rotated }, { expires_at: NOW + 299 });
    expect(await runAs(context, recorder())).toBe(0);
    expect(fake.log.filter((entry) => entry.path === "/login/oauth/access_token")).toHaveLength(1);
    expect(JSON.parse(readFileSync(out, "utf8")).GH_TOKEN).toBe("ghu_new_3333");
    const stored = JSON.parse(readFileSync(join(creds.dir, "claude.token.json"), "utf8"));
    expect(stored).toEqual({
      access_token: "ghu_new_3333",
      expires_at: NOW + 28_800,
      refresh_token: "ghr_new_4444",
      refresh_expires_at: NOW + 15_897_600,
    });
    expect(statSync(join(creds.dir, "claude.token.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(creds.dir, "claude.token.lock"))).toBe(false);
  });

  test("a token with more than five minutes left is used as it is", async () => {
    const { fake, context } = setup({ ...HAPPY, "POST /login/oauth/access_token": rotated }, { expires_at: NOW + 301 });
    await runAs(context, recorder());
    expect(fake.log.some((entry) => entry.path === "/login/oauth/access_token")).toBe(false);
  });

  test("a token from an App without expiring tokens never refreshes", async () => {
    const { fake, context } = setup(HAPPY, { expires_at: null, refresh_token: null, refresh_expires_at: null });
    expect(await runAs(context, recorder())).toBe(0);
    expect(fake.log.map((entry) => entry.path)).toEqual(["/repos/johnrees/penmon/installation"]);
  });

  test("parallel commands spend the refresh token once", async () => {
    const slow = async (body: string) => {
      await Bun.sleep(150);
      return rotated(body);
    };
    const { fake, creds, context } = setup({ ...HAPPY, "POST /login/oauth/access_token": slow }, { expires_at: NOW - 1 });
    const outs = [0, 1, 2].map((n) => join(mkdtempSync(join(tmpdir(), "agent-gh-out-")), `env${n}.json`));
    const codes = await Promise.all(outs.map((out) => runAs({ ...context, env: { ...context.env, OUT: out } }, recorder())));
    expect(codes).toEqual([0, 0, 0]);
    expect(fake.log.filter((entry) => entry.path === "/login/oauth/access_token")).toHaveLength(1);
    for (const out of outs) expect(JSON.parse(readFileSync(out, "utf8")).GH_TOKEN).toBe("ghu_new_3333");
    expect(existsSync(join(creds.dir, "claude.token.lock"))).toBe(false);
  });

  test("a lock left by a process that is gone is removed", async () => {
    const { creds, context } = setup({ ...HAPPY, "POST /login/oauth/access_token": rotated }, { expires_at: NOW - 1 });
    const gone = Bun.spawnSync([process.execPath, "-e", "0"]).pid;
    writeFileSync(join(creds.dir, "claude.token.lock"), String(gone), { mode: 0o600 });
    expect(await runAs(context, recorder())).toBe(0);
    expect(existsSync(join(creds.dir, "claude.token.lock"))).toBe(false);
  });

  test("a refused refresh token asks John to log in again, with no secret in the message", async () => {
    const { creds, context } = setup(
      { ...HAPPY, "POST /login/oauth/access_token": () => reply(200, { error: "bad_refresh_token", error_description: SECRET_BODY }) },
      { expires_at: NOW - 1 },
    );
    const error = await failure(runAs(context, recorder()));
    expect([error.stage, error.detail]).toEqual([
      "refreshing the login",
      "GitHub refused the stored claude login (bad_refresh_token); run `agent-gh login claude` in your own terminal",
    ]);
    clean(describe(error));
    expect(existsSync(join(creds.dir, "claude.token.lock"))).toBe(false);
  });

  test("an expired refresh token is not even sent", async () => {
    const { fake, context } = setup(HAPPY, { expires_at: NOW - 10, refresh_expires_at: NOW - 1 });
    const error = await failure(runAs(context, recorder()));
    expect(error.detail).toBe("the claude login has expired; run `agent-gh login claude` in your own terminal");
    expect(fake.log.some((entry) => entry.path === "/login/oauth/access_token")).toBe(false);
  });
});

group("every failure names its stage and carries no secret", () => {
  test("the App is not installed on the repository", async () => {
    const { context } = setup({});
    const error = await failure(runAs(context, recorder()));
    expect(error.stage).toBe("finding the installation");
    expect(error.detail).toBe(
      "the johnrees-claude App is not installed on johnrees/penmon; install it at https://github.com/apps/johnrees-claude/installations/new and select johnrees/penmon",
    );
    clean(describe(error));
  });

  test("an installation error", async () => {
    const { context } = setup({ "GET /repos/johnrees/penmon/installation": () => reply(500, { m: SECRET_BODY }) });
    const error = await failure(runAs(context, recorder()));
    expect([error.stage, error.detail]).toEqual(["finding the installation", "HTTP 500"]);
    clean(describe(error));
  });

  test("GitHub cannot be reached", async () => {
    const { context } = setup();
    const error = await failure(runAs({ ...context, api: { base: "http://127.0.0.1:1", web: "http://127.0.0.1:1", timeoutMs: 2000 } }, recorder()));
    expect([error.stage, error.detail]).toEqual(["finding the installation", "could not reach 127.0.0.1:1"]);
  });

  test("no login tells John to log in, and never falls back to his own gh login", async () => {
    const { out, context } = setup(HAPPY, null);
    const error = await failure(runAs(context, recorder()));
    expect([error.stage, error.detail]).toEqual(["reading the login", "no login for claude; run `agent-gh login claude` in your own terminal"]);
    expect(existsSync(out)).toBe(false);
  });

  test("a login other users can read is refused", async () => {
    const { creds, context } = setup();
    chmodSync(join(creds.dir, "claude.token.json"), 0o644);
    const error = await failure(runAs(context, recorder()));
    expect(error.stage).toBe("reading the login");
    expect(error.detail).toContain("chmod 600");
    clean(describe(error));
  });

  test("no config tells John to run setup", async () => {
    const { context } = setup();
    const error = await failure(runAs({ ...context, identity: { harness: "codex", family: "codex" } }, recorder()));
    expect(error.stage).toBe("reading config");
    expect(error.detail).toContain("run `agent-gh setup codex` in your own terminal");
  });

  test("a key other users can read is refused", async () => {
    const { creds, context } = setup();
    chmodSync(join(creds.dir, "claude.pem"), 0o644);
    const error = await failure(runAs(context, recorder()));
    expect(error.stage).toBe("reading key");
    clean(describe(error), [creds.pem.slice(40, 80)]);
  });

  test("a key that cannot sign", async () => {
    const { creds, context } = setup();
    writeFileSync(join(creds.dir, "claude.pem"), "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n", { mode: 0o600 });
    const error = await failure(runAs(context, recorder()));
    expect([error.stage, error.detail]).toEqual(["signing", "the johnrees-claude private key could not sign a JWT"]);
  });

  test("a child that cannot start", async () => {
    const { context } = setup();
    const error = await failure(runAs(context, ["agent-gh-no-such-program-7b1d"]));
    expect([error.stage, error.detail]).toEqual(["starting the child", "agent-gh-no-such-program-7b1d could not be started"]);
    clean(describe(error));
  });
});
