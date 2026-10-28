import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureCodexSandbox } from "../src/codex.ts";
import { userToken } from "../src/login.ts";
import { tokenStorageCheck } from "../src/machine.ts";
import { CONFIG, fakeGitHub, loggedIn, reply } from "./fake-github.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const fixture = (text?: string) => {
  const home = mkdtempSync(join(tmpdir(), "agent-gh-codex-"));
  homes.push(home);
  const dir = join(home, ".config", "agent-gh");
  mkdirSync(dir, { recursive: true });
  const path = join(home, ".codex", "config.toml");
  if (text !== undefined) {
    mkdirSync(join(home, ".codex"));
    writeFileSync(path, text, { mode: 0o600 });
  }
  const cli = (extra: Record<string, string> = {}, args = ["--codex-sandbox"]) => Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "install-shims", ...args],
    { env: { HOME: home, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", ...extra }, stdout: "pipe", stderr: "pipe" },
  );
  return { home, dir, path, cli };
};

for (const custom of [false, true]) {
  test(`fresh CLI opt-in installs config and instructions (custom CODEX_HOME: ${custom})`, () => {
    const { home, dir, cli } = fixture();
    const codexHome = join(home, custom ? "custom codex" : ".codex");
    expect(cli(custom ? { CODEX_HOME: codexHome } : {}).exitCode).toBe(0);
    const path = join(codexHome, "config.toml");
    expect(Bun.TOML.parse(readFileSync(path, "utf8"))).toEqual({ sandbox_mode: "workspace-write", sandbox_workspace_write: { writable_roots: [dir], network_access: true } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(codexHome, "AGENTS.md"), "utf8")).toContain("GitHub (managed by `agent-gh install-shims`)");
  });
}

test("setup merges settings, privately backs up original text, and is idempotent", () => {
  const original = '# original comment\nmodel = "example"\n[sandbox_workspace_write]\nwritable_roots = ["/other", "/other"]\nnetwork_access = false\nexclude_slash_tmp = true\n';
  const { home, dir, path } = fixture(original);
  chmodSync(path, 0o640);
  configureCodexSandbox(home, dir, {});
  expect(Bun.TOML.parse(readFileSync(path, "utf8"))).toEqual({ model: "example", sandbox_mode: "workspace-write", sandbox_workspace_write: { writable_roots: ["/other", "/other", dir], network_access: true, exclude_slash_tmp: true } });
  expect(statSync(path).mode & 0o777).toBe(0o640);
  const backup = readdirSync(join(home, ".codex")).find((name) => name.endsWith(".bak"))!;
  expect(readFileSync(join(home, ".codex", backup), "utf8")).toBe(original);
  expect(statSync(join(home, ".codex", backup)).mode & 0o777).toBe(0o600);
  const inode = statSync(path).ino;
  expect(configureCodexSandbox(home, dir, {})).toContain("already configured");
  expect(statSync(path).ino).toBe(inode);
  expect(readdirSync(join(home, ".codex"))).toHaveLength(2);
});

for (const text of ['default_permissions = "custom"', 'sandbox_mode = "read-only"', 'sandbox_mode = "danger-full-access"', 'sandbox_workspace_write = 2026-10-28', '[sandbox_workspace_write]\nwritable_roots = "bad"', 'secret = "do-not-print"\nmalformed [']) {
  test(`refuses unsupported config without mutation or parser-secret leaks: ${text.split("\n")[0]}`, () => {
    const { home, dir, path } = fixture(text);
    expect(() => configureCodexSandbox(home, dir, {})).toThrow();
    try { configureCodexSandbox(home, dir, {}); } catch (error) { expect(String(error)).not.toContain("do-not-print"); }
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readdirSync(join(home, ".codex"))).toEqual(["config.toml"]);
  });
}

for (const present of [false, true]) {
  test(`preserves a dotfiles symlink (target exists: ${present})`, () => {
    const { home, dir, path } = fixture();
    mkdirSync(join(home, ".codex"));
    const target = join(home, "dotfiles.toml");
    if (present) writeFileSync(target, 'model = "example"', { mode: 0o600 });
    symlinkSync("../dotfiles.toml", path);
    configureCodexSandbox(home, dir, {});
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toContain("workspace-write");
  });
}

test("CLI keeps setup opt-in, refuses agents, and still installs shims after optional config refusal", () => {
  const { path, cli } = fixture();
  expect(cli({}, []).exitCode).toBe(0);
  expect(existsSync(path)).toBe(false);
  expect(cli({ CODEX_THREAD_ID: "test" }).stderr.toString()).toContain("an agent does not change its own guardrails");
  expect(existsSync(path)).toBe(false);
  const custom = fixture('default_permissions = "custom"');
  expect(custom.cli().exitCode).toBe(1);
  expect(existsSync(join(custom.home, ".local", "share", "agent-gh", "shims", "gh"))).toBe(true);
  expect(readFileSync(custom.path, "utf8")).toBe('default_permissions = "custom"');
});

test.skipIf(process.getuid?.() === 0)("doctor detects denied refresh writes without touching tokens; restoring access refreshes the same login", async () => {
  const { dir } = fixture();
  const now = 1_800_000_000;
  loggedIn(dir, now, { expires_at: now - 1 });
  writeFileSync(join(dir, "other.token.lock"), "untouched");
  const before = readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]);
  expect(tokenStorageCheck(dir).state).toBe("ok");
  expect(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")])).toEqual(before);
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
    expect(await userToken(CONFIG, "claude", deps)).toBe("ghu_refreshed_test");
    expect(refreshes).toBe(1);
    expect(existsSync(join(dir, "claude.token.lock"))).toBe(false);
  } finally { chmodSync(dir, 0o700); github.stop(); }
});
