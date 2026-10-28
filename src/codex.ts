import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Failure } from "./failure.ts";
import { writeAtomic } from "./files.ts";
import type { Env } from "./harness.ts";

export type SandboxCheck = { readonly state: "ok" | "FAIL" | "note"; readonly name: string; readonly detail: string };
const record = (value: unknown): Record<string, unknown> => {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a TOML table");
  return value as Record<string, unknown>;
};
export const codexConfigPath = (home: string, env: Env): string => join(env.CODEX_HOME?.trim() || join(home, ".codex"), "config.toml");
const config = (path: string): { text: string; data: Record<string, unknown> } => {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return { text, data: record(Bun.TOML.parse(text)) };
};
const covers = (root: string, dir: string): boolean => {
  if (!isAbsolute(root)) return false;
  const rest = relative(root, dir);
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
};
const rootsFrom = (sandbox: Record<string, unknown>): string[] => {
  const roots = sandbox.writable_roots ?? [];
  if (!Array.isArray(roots) || !roots.every((root) => typeof root === "string")) throw new Error("writable_roots must be an array of paths");
  return roots;
};

/** Explicit opt-in only. Preserve setting values and back up the original TOML, including comments. */
export const configureCodexSandbox = (home: string, dir: string, env: Env): string => {
  const path = codexConfigPath(home, env);
  try {
    const { text, data } = config(path);
    if (data.default_permissions !== undefined) {
      throw new Error("uses named permission profiles; add the agent-gh directory and network access to your chosen profile manually");
    }
    if (data.sandbox_mode !== undefined && data.sandbox_mode !== "workspace-write") {
      throw new Error(`sandbox_mode is ${String(data.sandbox_mode)}; choose workspace-write yourself before opting in`);
    }
    const sandbox = record(data.sandbox_workspace_write);
    const roots = rootsFrom(sandbox);
    const covered = roots.some((root) => covers(root, resolve(dir)));
    if (data.sandbox_mode === "workspace-write" && covered && sandbox.network_access === true) return `${path}: agent-gh sandbox access already configured`;
    const next = { ...data, sandbox_mode: "workspace-write", sandbox_workspace_write: {
      ...sandbox, writable_roots: covered ? roots : [...roots, resolve(dir)], network_access: true,
    } };
    const output = Bun.TOML.stringify(next);
    if (output === undefined || !isDeepStrictEqual(Bun.TOML.parse(output), next)) throw new Error("TOML cannot be rewritten without changing other settings");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const backup = `${path}.agent-gh.${randomUUID()}.bak`;
    if (text !== "") writeFileSync(backup, text, { flag: "wx", mode: 0o600 });
    // Create privately without truncating; append follows even a dangling dotfiles symlink.
    // Once its target exists, writeAtomic preserves the symlink and original permissions.
    if (!existsSync(path)) writeFileSync(path, "", { flag: "a", mode: 0o600 });
    writeAtomic(path, output);
    return `${path}: enabled writes to ${resolve(dir)} and outbound network access (all hosts); ${text === "" ? "new config" : `original saved to ${backup}`}. Restart Codex; active profiles, CLI overrides, or managed policy may override these defaults`;
  } catch (error) {
    // Parser errors can quote config values, including secrets. Never print them.
    const reason = error instanceof Error && /^(uses named|sandbox_mode is|TOML cannot)/.test(error.message) ? error.message : "could not safely read or update the TOML; check its syntax and file permissions";
    throw new Failure("installing the shims", `${path}: ${reason}`);
  }
};

/** Defaults only: the active session may have a different profile or managed policy. */
export const codexSandboxCheck = (home: string, dir: string, env: Env): SandboxCheck | undefined => {
  const path = codexConfigPath(home, env);
  if (!existsSync(dirname(path))) return undefined;
  const name = "Codex sandbox defaults";
  try {
    const { data } = config(path);
    if (data.default_permissions !== undefined) return { state: "note", name, detail: `${path} uses named permissions; run agent-gh doctor --sandbox inside your chosen Codex session to verify access` };
    if (data.sandbox_mode === "danger-full-access") return { state: "note", name, detail: "full access is configured; no sandbox isolation. Run agent-gh doctor --sandbox in the active session" };
    if (data.sandbox_mode !== undefined && data.sandbox_mode !== "workspace-write") return { state: "note", name, detail: `${path} selects a non-workspace sandbox; configure permissions manually or choose workspace-write yourself before using --codex-sandbox` };
    const sandbox = record(data.sandbox_workspace_write);
    if (data.sandbox_mode === "workspace-write" && sandbox.network_access === true && rootsFrom(sandbox).some((root) => covers(root, resolve(dir)))) {
      return { state: "ok", name, detail: "default workspace sandbox allows token refresh writes and outbound networking; active profiles and managed policy may override it" };
    }
    return { state: "note", name, detail: `default sandbox cannot refresh agent-gh tokens and reach GitHub without approval; opt in from your own terminal with agent-gh install-shims --codex-sandbox (credential-directory writes and network access to all hosts), or configure your active permissions manually` };
  } catch {
    return { state: "FAIL", name, detail: `${path} could not be read as supported TOML; check syntax and permissions` };
  }
};

/** Exercise refresh's filesystem operations without touching any real token or refresh lock. */
export const tokenStorageCheck = (dir: string): SandboxCheck => {
  const name = "token refresh storage";
  let probe: string | undefined;
  try {
    probe = mkdtempSync(join(dir, ".agent-gh-doctor-"));
    writeFileSync(join(probe, "lock"), "probe", { flag: "wx", mode: 0o600 });
    writeFileSync(join(probe, "token.tmp"), "probe", { flag: "wx", mode: 0o600 });
    writeFileSync(join(probe, "token.json"), "old probe", { flag: "wx", mode: 0o600 });
    renameSync(join(probe, "token.tmp"), join(probe, "token.json"));
    rmSync(probe, { recursive: true });
    probe = undefined;
    return { state: "ok", name, detail: `${dir}: lock creation and atomic replacement work in this process` };
  } catch {
    return { state: "FAIL", name, detail: `${dir}: cannot create/remove a refresh lock or atomically replace a token; check sandbox write access and filesystem permissions, not the GitHub login` };
  } finally {
    if (probe !== undefined) {
      try { rmSync(probe, { recursive: true, force: true }); } catch { /* The failure above reports cleanup denial too. */ }
    }
  }
};

/** No credentials: distinguish blocked networking from token validity in the current process. */
export const sandboxNetworkChecks = async (request: typeof fetch = fetch): Promise<SandboxCheck[]> => Promise.all(
  ["https://api.github.com/", "https://github.com/"].map(async (url): Promise<SandboxCheck> => {
    const name = `network ${new URL(url).host}`;
    try {
      const response = await request(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel();
      return { state: "ok", name, detail: `reachable (HTTP ${response.status}); authentication not tested` };
    } catch {
      return { state: "FAIL", name, detail: "unreachable; check sandbox network access, DNS, proxy and TLS settings. An approved elevated retry can distinguish sandbox restrictions from host networking; do not reset the login" };
    }
  }),
);
