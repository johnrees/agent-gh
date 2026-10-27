import { afterEach, describe as group, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, Failure } from "../src/failure.ts";
import { readConfig, type Registry } from "../src/config.ts";
import { doctor, PERSON } from "../src/doctor.ts";
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

type Routes = Record<string, (body: string, url: URL) => Response | Promise<Response>>;

const setup = (routes: Routes = HAPPY, login: Parameters<typeof loggedIn>[2] | null = {}, key = true) => {
  const fake = fakeGitHub(routes);
  stops.push(fake.stop);
  const creds = credentials("claude", CONFIG, { key });
  if (login !== null) loggedIn(creds.dir, NOW, login);
  const out = join(mkdtempSync(join(tmpdir(), "agent-gh-out-")), "env.json");
  const context = {
    identity: { harness: "claude", family: "claude" },
    repo: { owner: "johnrees", name: "penmon" },
    env: { PATH: process.env.PATH, OUT: out, GH_DEBUG: "api", GH_TOKEN: "ghp_johns_own" },
    api: fake.api,
    configDir: creds.dir,
    registry: {},
    nowSeconds: () => NOW,
    sleep: (ms: number) => Bun.sleep(Math.min(ms, 10)),
  } satisfies Context;
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
  test("the installation is checked with John's user token, and the App key is never read", async () => {
    const { fake, context } = setup(HAPPY, {}, false);
    expect(await runAs(context, recorder())).toBe(0);
    expect(fake.log.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /user/installations",
      "GET /user/installations/42/repositories",
    ]);
    for (const entry of fake.log) expect(entry.auth).toBe(`Bearer ${ACCESS}`);
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

  test("a command that names no repository runs with no installation check and no GH_REPO", async () => {
    const { fake, out, context } = setup();
    expect(await runAs({ ...context, repo: undefined }, recorder())).toBe(0);
    expect(fake.log).toEqual([]);
    const env = JSON.parse(readFileSync(out, "utf8"));
    expect(env.GH_TOKEN).toBe(ACCESS);
    expect(env.GH_REPO).toBeUndefined();
  });

  test("the child's exit code is returned", async () => {
    const { context } = setup();
    expect(await runAs(context, recorder(3))).toBe(3);
  });

});

group("known public gh reads without a family installation", () => {
  const PUBLIC = { owner: "cloudflare", name: "workerd" };
  const PUBLIC_ROUTES = {
    ...HAPPY,
    "GET /repos/cloudflare/workerd": () => reply(200, { full_name: "cloudflare/workerd", private: false }),
  };
  const publicSetup = (routes: Routes = PUBLIC_ROUTES, code = 0) => {
    const state = setup(routes);
    const bin = mkdtempSync(join(tmpdir(), "agent-gh-public-bin-"));
    writeFileSync(join(bin, "gh"), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.OUT, JSON.stringify({env:process.env,args:process.argv.slice(2)})+'\\n');\nprocess.exit(${code});\n`, { mode: 0o755 });
    const lines: string[] = [];
    const context: Context = { ...state.context, env: { ...state.context.env, PATH: `${bin}:${process.env.PATH}` }, print: (line) => lines.push(line) };
    return { ...state, context, lines, child: () => readFileSync(state.out, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
  };
  const command = ["gh", "pr", "view", "7910", "-R", "cloudflare/workerd", "--json", "title,files"];

  test("public visibility is checked with the existing App login, then the read is logged", async () => {
    const { fake, context, lines, child } = publicSetup();
    expect(await runAs(context, command)).toBe(0);
    expect(fake.log.map((entry) => [entry.path, entry.auth])).toEqual([
      ["/user/installations", `Bearer ${ACCESS}`],
      ["/user/installations/42/repositories", `Bearer ${ACCESS}`],
      ["/repos/cloudflare/workerd", `Bearer ${ACCESS}`],
    ]);
    expect(child()).toHaveLength(1);
    const result = child()[0];
    expect(result.args).toEqual(command.slice(1));
    expect(result.env.GH_TOKEN).toBe(ACCESS);
    expect(result.env.GITHUB_TOKEN).toBe(ACCESS);
    expect(result.env.GH_REPO).toBe("cloudflare/workerd");
    expect(result.env.GH_DEBUG).toBeUndefined();
    expect(lines).toEqual(["agent-gh: reading public repository cloudflare/workerd with the johnrees-claude App (not installed on this repository)."]);
    clean(lines.join("\n"));
  });

  test("an App absent from every installation still permits a confirmed public read", async () => {
    const { context, fake, child } = publicSetup({ ...PUBLIC_ROUTES, "GET /user/installations": () => reply(200, { total_count: 0, installations: [] }) });
    expect(await runAs(context, command)).toBe(0);
    expect(fake.log.map((entry) => entry.path)).toEqual(["/user/installations", "/repos/cloudflare/workerd"]);
    expect(child()[0].env.GH_TOKEN).toBe(ACCESS);
  });

  test("an installed read keeps the family token and never probes visibility", async () => {
    const { context, fake, lines, child } = publicSetup();
    expect(await runAs(context, ["gh", "issue", "list"])).toBe(0);
    expect(child()[0].env.GH_TOKEN).toBe(ACCESS);
    expect(fake.log).toHaveLength(2);
    expect(lines).toEqual([]);
  });

  test("API and URL targets override an unrelated checkout, globals do not inherit it", async () => {
    for (const args of [
      ["api", "repos/cloudflare/workerd/pulls/7910"],
      ["pr", "view", "https://github.com/cloudflare/workerd/pull/7910"],
      ["repo", "view", "cloudflare/workerd"],
    ]) {
      const { context, child } = publicSetup();
      expect(await runAs(context, ["gh", ...args])).toBe(0);
      expect(child()[0].env.GH_REPO).toBe("cloudflare/workerd");
      expect(child()[0].env.GH_TOKEN).toBe(ACCESS);
    }
    const { context, fake, child } = publicSetup();
    expect(await runAs(context, ["gh", "search", "repos", "solana"])).toBe(0);
    expect(fake.log).toEqual([]);
    expect(child()[0].env.GH_TOKEN).toBe(ACCESS);
  });

  test("private and inaccessible repositories retain the installation refusal", async () => {
    for (const route of [() => reply(200, { full_name: "cloudflare/workerd", private: true }), () => reply(404, { message: SECRET_BODY })]) {
      const { context, out, lines } = publicSetup({ ...PUBLIC_ROUTES, "GET /repos/cloudflare/workerd": route });
      const error = await failure(runAs(context, command));
      expect(error.detail).toContain("App is not installed on cloudflare/workerd");
      expect(existsSync(out)).toBe(false);
      expect(lines).toEqual([]);
      clean(describe(error));
    }
  });

  test("writes, unknown commands, POST APIs and GraphQL never probe or fall back", async () => {
    for (const args of [
      ["pr", "comment", "7910", "-R", "cloudflare/workerd", "--body", "test"],
      ["issue", "create", "-R", "cloudflare/workerd", "--title", "test"],
      ["api", "repos/cloudflare/workerd/issues", "-XPOST"],
      ["api", "repos/cloudflare/workerd/issues/1/reactions", "-fcontent=+1"],
      ["api", "graphql", "-XGET"], ["new-command"],
    ]) {
      const { context, fake, out, lines } = publicSetup();
      await failure(runAs({ ...context, repo: PUBLIC }, ["gh", ...args]));
      expect(fake.log.map((entry) => entry.path)).toEqual(["/user/installations", "/user/installations/42/repositories"]);
      expect(existsSync(out)).toBe(false);
      expect(lines).toEqual([]);
    }
  });

  test("authentication, API and invalid visibility responses cannot trigger a fallback", async () => {
    for (const status of [401, 403, 500]) {
      const { context, fake, out } = publicSetup({ ...PUBLIC_ROUTES, "GET /user/installations": () => reply(status, { message: SECRET_BODY }) });
      clean(describe(await failure(runAs(context, command))));
      expect(fake.log).toHaveLength(1);
      expect(existsSync(out)).toBe(false);
    }
    for (const route of [
      () => reply(500, { message: SECRET_BODY }),
      () => reply(200, { full_name: "cloudflare/workerd" }),
      () => reply(200, { full_name: "other/public", private: false }),
      () => new Response(SECRET_BODY, { status: 200 }),
      () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }),
    ]) {
      const { context, out, lines } = publicSetup({ ...PUBLIC_ROUTES, "GET /repos/cloudflare/workerd": route });
      clean(describe(await failure(runAs(context, command))));
      expect(existsSync(out)).toBe(false);
      expect(lines).toEqual([]);
    }
  });

  test("an explicit public URL outside a clone needs no additional App configuration or login", async () => {
    const { context, creds, child } = publicSetup();
    expect(existsSync(join(creds.dir, "read.json"))).toBe(false);
    expect(existsSync(join(creds.dir, "read.token.json"))).toBe(false);
    expect(await runAs({ ...context, repo: undefined }, ["gh", "pr", "view", "https://github.com/cloudflare/workerd/pull/7910"])).toBe(0);
    expect(child()[0].env.GH_TOKEN).toBe(ACCESS);
  });

  test("repository-scoped search checks its explicit target instead of clearing it", async () => {
    const { context, child } = publicSetup();
    expect(await runAs(context, ["gh", "search", "issues", "bug", "--repo", "cloudflare/workerd"])).toBe(0);
    expect(child()[0].env.GH_REPO).toBe("cloudflare/workerd");
    const privateState = publicSetup({ ...PUBLIC_ROUTES, "GET /repos/cloudflare/workerd": () => reply(200, { full_name: "cloudflare/workerd", private: true }) });
    const error = await failure(runAs(privateState.context, ["gh", "search", "issues", "bug", "--repo", "cloudflare/workerd"]));
    expect(error.detail).toContain("App is not installed on cloudflare/workerd");
    expect(existsSync(privateState.out)).toBe(false);
  });

  test("visibility rate limits and redirects retain the installation refusal with a diagnostic", async () => {
    for (const status of [403, 429, 301]) {
      const { context, out } = publicSetup({ ...PUBLIC_ROUTES, "GET /repos/cloudflare/workerd": () => reply(status, { message: SECRET_BODY }) });
      const error = await failure(runAs(context, command));
      expect(error.detail).toContain("App is not installed on cloudflare/workerd");
      expect(error.detail).toContain(`public visibility check failed: HTTP ${status}`);
      expect(error.network).toBe(false);
      expect(existsSync(out)).toBe(false);
      clean(describe(error));
    }
  });

  test("a missing family login never falls back to a personal login", async () => {
    const { context, creds, out } = publicSetup();
    unlinkSync(join(creds.dir, "claude.token.json"));
    const error = await failure(runAs(context, command));
    expect(error.stage).toBe("reading the login");
    expect(error.detail).toContain("no login for claude");
    expect(existsSync(out)).toBe(false);
  });

  test("a failing child runs exactly once and retains its exit status", async () => {
    const { context, child, fake } = publicSetup(PUBLIC_ROUTES, 7);
    expect(await runAs(context, command)).toBe(7);
    expect(child()).toHaveLength(1);
    expect(fake.log).toHaveLength(3);
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
    expect(fake.log.map((entry) => entry.path)).toEqual(["/user/installations", "/user/installations/42/repositories"]);
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
  const NOT_INSTALLED =
    "the johnrees-claude App is not installed on johnrees/penmon; install it at https://github.com/apps/johnrees-claude/installations/new and select johnrees/penmon";

  test("the App is not installed anywhere John's token reaches", async () => {
    const { context } = setup({
      "GET /user/installations": () =>
        reply(200, { total_count: 1, installations: [{ id: 9, app_slug: "johnrees-codex", account: { login: "johnrees" } }] }),
    });
    const error = await failure(runAs(context, recorder()));
    expect([error.stage, error.detail]).toEqual(["finding the installation", NOT_INSTALLED]);
    clean(describe(error));
  });

  test("the App is installed, but not on this repository", async () => {
    const { context } = setup({
      ...HAPPY,
      "GET /user/installations/42/repositories": () => reply(200, { total_count: 1, repositories: [{ full_name: "johnrees/soltui" }] }),
    });
    const error = await failure(runAs(context, recorder()));
    expect([error.stage, error.detail]).toEqual(["finding the installation", NOT_INSTALLED]);
  });

  test("both lists are paged until the App and the repository are found", async () => {
    const page = (url: URL) => Number(url.searchParams.get("page"));
    const filler = (n: number, make: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, i) => make(i));
    const { fake, out, context } = setup({
      "GET /user/installations": (_body, url) => {
        expect(url.searchParams.get("per_page")).toBe("100");
        return page(url) === 1
          ? reply(200, { total_count: 101, installations: filler(100, (i) => ({ id: 1000 + i, app_slug: `other-${i}` })) })
          : reply(200, { total_count: 101, installations: [{ id: 42, app_slug: "johnrees-claude" }] });
      },
      "GET /user/installations/42/repositories": (_body, url) =>
        page(url) < 3
          ? reply(200, { total_count: 201, repositories: filler(100, (i) => ({ full_name: `johnrees/r${page(url)}-${i}` })) })
          : reply(200, { total_count: 201, repositories: [{ owner: { login: "JohnRees" }, name: "Penmon" }] }),
    });
    expect(await runAs(context, recorder())).toBe(0);
    expect(fake.log.map((entry) => entry.path)).toEqual([
      "/user/installations",
      "/user/installations",
      "/user/installations/42/repositories",
      "/user/installations/42/repositories",
      "/user/installations/42/repositories",
    ]);
    expect(existsSync(out)).toBe(true);
  });

  test("a login GitHub no longer accepts asks John to log in again", async () => {
    const { context } = setup({ "GET /user/installations": () => reply(401, { message: SECRET_BODY }) });
    const error = await failure(runAs(context, recorder()));
    expect([error.stage, error.detail]).toEqual([
      "finding the installation",
      "GitHub refused the stored login (HTTP 401); run `agent-gh login claude` in your own terminal",
    ]);
    clean(describe(error));
  });

  test("an installation error", async () => {
    const { context } = setup({ "GET /user/installations": () => reply(500, { m: SECRET_BODY }) });
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

  test("a family with no App anywhere is told to run setup where Apps are created", async () => {
    const { context } = setup();
    const error = await failure(runAs({ ...context, identity: { harness: "codex", family: "codex" } }, recorder()));
    expect([error.stage, error.detail]).toEqual([
      "reading config",
      "codex has no App yet: run `agent-gh setup codex` on the machine where you create Apps, then commit the registry entry it prints",
    ]);
  });

  test("a child that cannot start", async () => {
    const { context } = setup();
    const error = await failure(runAs(context, ["agent-gh-no-such-program-7b1d"]));
    expect([error.stage, error.detail]).toEqual(["starting the child", "agent-gh-no-such-program-7b1d could not be started"]);
    clean(describe(error));
  });
});

group("another machine needs only the committed registry and `agent-gh login`", () => {
  const ENTRY = { slug: CONFIG.slug, app_id: CONFIG.app_id, client_id: CONFIG.client_id, bot_user_id: CONFIG.bot_user_id };

  /** A config directory with a login and nothing else: no <family>.json, no key. */
  const loginOnly = (family = "claude") => {
    const dir = join(mkdtempSync(join(tmpdir(), "agent-gh-")), "config");
    mkdirSync(dir, { mode: 0o700 });
    loggedIn(dir, NOW, {}, family);
    return dir;
  };

  test("a family in the registry needs no local config and no key", async () => {
    const { out, context } = setup();
    const dir = loginOnly();
    expect(await runAs({ ...context, configDir: dir, registry: { claude: ENTRY } }, recorder())).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).GH_TOKEN).toBe(ACCESS);
    expect(readConfig(dir, "claude", { claude: ENTRY })).toEqual(CONFIG);
  });

  test("a local config wins over the registry, so a new App works before its entry is committed", () => {
    const { creds } = setup();
    expect(readConfig(creds.dir, "claude", { claude: { ...ENTRY, slug: "johnrees-claude-old" } }).slug).toBe("johnrees-claude");
  });

  test("a family in the registry is never told to run setup", async () => {
    const { context } = setup(HAPPY, null);
    const error = await failure(runAs({ ...context, configDir: join(mkdtempSync(join(tmpdir(), "agent-gh-")), "empty"), registry: { claude: ENTRY } }, recorder()));
    expect([error.stage, error.detail]).toEqual(["reading the login", "no login for claude; run `agent-gh login claude` in your own terminal"]);
    expect(error.detail).not.toContain("setup");
  });

  test("an invalid registry entry is refused, not used", () => {
    const bad: Registry = { claude: { ...ENTRY, client_id: "" } };
    expect(() => readConfig(join(tmpdir(), "agent-gh-none"), "claude", bad)).toThrow("the claude entry in apps.json is not a valid App");
  });

  test("gh and doctor work with no private key on the machine", async () => {
    const { context } = setup();
    const dir = loginOnly();
    const bin = mkdtempSync(join(tmpdir(), "agent-gh-bin-"));
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    script("gh", 'case "$2" in user) echo johnrees ;; user/installations) echo johnrees ;; esac');
    script("git", 'case "$1" in var) echo "John Rees <john@example.com> 1800000000 +0000" ;; ls-remote) echo "0000 HEAD" ;; --version) echo "git version 2" ;; esac');
    const machine = { ...context, configDir: dir, registry: { claude: ENTRY }, env: { ...context.env, PATH: `${bin}:${process.env.PATH}` } } satisfies Context;
    expect(await runAs(machine, ["gh", "--version"])).toBe(0);
    const lines: string[] = [];
    expect(await doctor(machine, (line) => lines.push(line))).toBe(0);
    expect(lines).toContain("ok   acting user: johnrees");
    expect(lines).toContain("ok   token app: johnrees-claude, installed on johnrees");
    expect(existsSync(join(dir, "claude.pem"))).toBe(false);
  });

  test("a person's doctor says so, credits no commit, and checks with the read App", async () => {
    const { context } = setup({
      ...HAPPY,
      "GET /user/installations": () =>
        reply(200, { total_count: 1, installations: [{ id: 42, app_slug: "johnrees-read", account: { login: "johnrees" } }] }),
    });
    const dir = loginOnly("read");
    const bin = mkdtempSync(join(tmpdir(), "agent-gh-bin-"));
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    script("gh", 'case "$2" in user) echo johnrees ;; user/installations) echo johnrees ;; esac');
    script("git", 'case "$1" in var) echo "John Rees <john@example.com> 1800000000 +0000" ;; ls-remote) echo "0000 HEAD" ;; --version) echo "git version 2" ;; esac');
    const read = { ...ENTRY, slug: "johnrees-read" };
    const machine = {
      ...context,
      identity: PERSON,
      configDir: dir,
      registry: { read },
      env: { ...context.env, PATH: `${bin}:${process.env.PATH}` },
    } satisfies Context;
    const lines: string[] = [];
    expect(await doctor(machine, (line) => lines.push(line))).toBe(0);
    expect(lines).toContain("harness: none, a person's shell; checks use the read App");
    expect(lines).toContain("app: johnrees-read");
    expect(lines).toContain("ok   token app: johnrees-read, installed on johnrees");
    // A person has no model or family, and the read App credits no commit.
    expect(lines.filter((line) => /^(model|family|commits get):/.test(line))).toEqual([]);
  });
});
