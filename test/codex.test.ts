import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexConfigPath, codexSandboxCheck, configureCodexSandbox, sandboxNetworkChecks, tokenStorageCheck } from "../src/codex.ts";
import { userToken } from "../src/login.ts";
import { CONFIG, fakeGitHub, loggedIn, reply } from "./fake-github.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const fixture = (text?: string) => {
  const home = mkdtempSync(join(tmpdir(), "agent-gh-codex-"));
  homes.push(home);
  const dir = join(home, ".config", "agent-gh");
  mkdirSync(dir, { recursive: true });
  const path = codexConfigPath(home, {});
  if (text !== undefined) {
    mkdirSync(join(home, ".codex"));
    writeFileSync(path, text, { mode: 0o600 });
  }
  return { home, dir, path };
};

test("fresh Codex setup grants only the token root and outbound network, then is a no-op", () => {
  const { home, dir, path } = fixture();
  configureCodexSandbox(home, dir, {});
  expect(Bun.TOML.parse(readFileSync(path, "utf8"))).toEqual({ sandbox_mode: "workspace-write", sandbox_workspace_write: { writable_roots: [dir], network_access: true } });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const before = statSync(path).ino;
  expect(configureCodexSandbox(home, dir, {})).toContain("already configured");
  expect(statSync(path).ino).toBe(before);
  expect(readdirSync(join(home, ".codex"))).toEqual(["config.toml"]);
  expect(codexSandboxCheck(home, dir, {})?.state).toBe("ok");
});

test("merges existing roots/settings, honors CODEX_HOME and backs up original comments privately", () => {
  const { home, dir } = fixture();
  const env = { CODEX_HOME: join(home, "custom codex") };
  mkdirSync(env.CODEX_HOME);
  const path = codexConfigPath(home, env);
  const text = '# keep in backup\nmodel = "example"\napproval_policy = "on-request"\n[sandbox_workspace_write]\nwritable_roots = ["/other"]\nnetwork_access = false\nexclude_slash_tmp = true\n[mcp_servers.example]\ncommand = "example"\nargs = ["--hello"]\n';
  writeFileSync(path, text, { mode: 0o640 });
  configureCodexSandbox(home, dir, env);
  expect(Bun.TOML.parse(readFileSync(path, "utf8"))).toEqual({ model: "example", approval_policy: "on-request", sandbox_mode: "workspace-write", sandbox_workspace_write: { writable_roots: ["/other", dir], network_access: true, exclude_slash_tmp: true }, mcp_servers: { example: { command: "example", args: ["--hello"] } } });
  expect(statSync(path).mode & 0o777).toBe(0o640);
  const backup = readdirSync(env.CODEX_HOME).find((name) => name.endsWith(".bak"))!;
  expect(readFileSync(join(env.CODEX_HOME, backup), "utf8")).toBe(text);
  expect(statSync(join(env.CODEX_HOME, backup)).mode & 0o777).toBe(0o600);
  expect(codexSandboxCheck(home, dir, env)?.state).toBe("ok");
  expect(existsSync(join(home, ".codex"))).toBe(false);
});

for (const text of ['default_permissions = "custom"\n', 'sandbox_mode = "read-only"\n', 'sandbox_mode = "danger-full-access"\n', '[sandbox_workspace_write]\nwritable_roots = "bad"\n', 'secret = "do-not-print"\nmalformed [']) {
  test(`refuses unsupported config without writing: ${text.split("\n")[0]}`, () => {
    const { home, dir, path } = fixture(text);
    expect(() => configureCodexSandbox(home, dir, {})).toThrow();
    try { configureCodexSandbox(home, dir, {}); } catch (error) { expect(String(error)).not.toContain("do-not-print"); }
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readdirSync(join(home, ".codex"))).toEqual(["config.toml"]);
  });
}

test("keeps symlinked config and recognizes parent roots without accepting path-prefix siblings", () => {
  const { home, dir, path } = fixture();
  mkdirSync(join(home, ".codex"));
  const target = join(home, "dotfiles.toml");
  writeFileSync(target, `sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(dir + '-other')}]\nnetwork_access = true\n`, { mode: 0o600 });
  symlinkSync(target, path);
  configureCodexSandbox(home, dir, {});
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect((Bun.TOML.parse(readFileSync(target, "utf8")) as any).sandbox_workspace_write.writable_roots).toEqual([dir + '-other', dir]);
  writeFileSync(target, `sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(home)}]\nnetwork_access = true\n`);
  expect(configureCodexSandbox(home, dir, {})).toContain("already configured");
});

test("doctor distinguishes absent, unconfigured, custom and invalid Codex defaults without changing files", () => {
  const { home, dir, path } = fixture();
  expect(codexSandboxCheck(home, dir, {})).toBeUndefined();
  mkdirSync(join(home, ".codex"));
  expect(codexSandboxCheck(home, dir, {})?.detail).toContain("--codex-sandbox");
  expect(existsSync(path)).toBe(false);
  writeFileSync(path, 'default_permissions = "custom"\n');
  expect(codexSandboxCheck(home, dir, {})?.state).toBe("note");
  expect(codexSandboxCheck(home, dir, {})?.detail).toContain("chosen Codex session");
  writeFileSync(path, 'malformed [');
  expect(codexSandboxCheck(home, dir, {})?.state).toBe("FAIL");
});

test("storage probe leaves tokens and existing refresh locks untouched and cleans up", () => {
  const { dir } = fixture();
  writeFileSync(join(dir, "codex.token.json"), "unchanged");
  writeFileSync(join(dir, "codex.token.lock"), "existing lock");
  expect(tokenStorageCheck(dir).state).toBe("ok");
  expect(readdirSync(dir).sort()).toEqual(["codex.token.json", "codex.token.lock"]);
  expect(readFileSync(join(dir, "codex.token.json"), "utf8")).toBe("unchanged");
  expect(readFileSync(join(dir, "codex.token.lock"), "utf8")).toBe("existing lock");
  expect(tokenStorageCheck(join(dir, "missing")).state).toBe("FAIL");
});

test("network probe tests both GitHub hosts without tokens, reports HTTP separately from transport failures", async () => {
  const calls: [string, RequestInit | undefined][] = [];
  const request = (async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    if (url.includes("api.github.com")) return new Response(null, { status: 403 });
    throw new Error("DNS blocked");
  }) as typeof fetch;
  const checks = await sandboxNetworkChecks(request);
  expect(checks.map((c) => c.state)).toEqual(["ok", "FAIL"]);
  expect(checks[0]?.detail).toContain("authentication not tested");
  expect(checks[1]?.detail).toContain("do not reset the login");
  expect(calls.map(([url]) => url)).toEqual(["https://api.github.com/", "https://github.com/"]);
  expect(calls.every(([, init]) => init?.method === "HEAD" && init.headers === undefined && init.signal instanceof AbortSignal)).toBe(true);
});

test.skipIf(process.getuid?.() === 0)("expired token fails before network when storage is denied, then refreshes without resetting login", async () => {
  const { dir } = fixture();
  const now = 1_800_000_000;
  loggedIn(dir, now, { expires_at: now - 1 });
  let refreshes = 0;
  const github = fakeGitHub({ "POST /login/oauth/access_token": () => {
    refreshes++;
    return reply(200, { access_token: "ghu_refreshed_test", expires_in: 3600, refresh_token: "ghr_rotated_test", refresh_token_expires_in: 7200 });
  } });
  const deps = { dir, api: github.api, nowSeconds: () => now, sleep: async () => {} };
  try {
    chmodSync(dir, 0o500);
    expect(tokenStorageCheck(dir).state).toBe("FAIL");
    await expect(userToken(CONFIG, "claude", deps)).rejects.toThrow("this is not a GitHub authentication failure");
    expect(refreshes).toBe(0);
    chmodSync(dir, 0o700);
    expect(tokenStorageCheck(dir).state).toBe("ok");
    expect(await userToken(CONFIG, "claude", deps)).toBe("ghu_refreshed_test");
    expect(refreshes).toBe(1);
    expect(existsSync(join(dir, "claude.token.lock"))).toBe(false);
  } finally { chmodSync(dir, 0o700); github.stop(); }
});

test("CLI refuses an agent's sandbox opt-in before writing config", () => {
  const { home, path } = fixture();
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "install-shims", "--codex-sandbox"], {
    env: { HOME: home, PATH: "/usr/bin:/bin", CODEX_THREAD_ID: "codex-sandbox-test" },
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("an agent does not change its own guardrails");
  expect(existsSync(path)).toBe(false);
});

test("doctor does not recommend automatic setup for an explicitly read-only mode or call unset mode configured", () => {
  const { home, dir, path } = fixture('sandbox_mode = "read-only"\n');
  expect(codexSandboxCheck(home, dir, {})?.detail).toContain("choose workspace-write yourself");
  writeFileSync(path, `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(dir)}]\nnetwork_access = true\n`);
  expect(codexSandboxCheck(home, dir, {})?.state).toBe("note");
  configureCodexSandbox(home, dir, {});
  expect(codexSandboxCheck(home, dir, {})?.state).toBe("ok");
});

test("creates a missing dotfiles target privately while preserving its config symlink", () => {
  const { home, dir, path } = fixture();
  mkdirSync(join(home, ".codex"));
  const target = join(home, "missing.toml");
  symlinkSync("../missing.toml", path);
  configureCodexSandbox(home, dir, {});
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(statSync(target).mode & 0o777).toBe(0o600);
  expect(codexSandboxCheck(home, dir, {})?.state).toBe("ok");
});

test("a refused optional Codex setup still installs shims and preserves the custom config", () => {
  const original = 'default_permissions = "custom"\n';
  const { home, path } = fixture(original);
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "install-shims", "--codex-sandbox"], {
    env: { HOME: home, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("uses named permission profiles");
  expect(existsSync(join(home, ".local", "share", "agent-gh", "shims", "gh"))).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(original);
});
