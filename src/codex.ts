import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Failure } from "./failure.ts";
import { writeAtomic } from "./files.ts";
import type { Env } from "./harness.ts";

/** Explicit opt-in: merge workspace access, preserving values and backing up the original TOML. */
export const configureCodexSandbox = (home: string, dir: string, env: Env): string => {
  const path = join(env.CODEX_HOME?.trim() || join(home, ".codex"), "config.toml");
  const fail = (detail: string) => new Failure("installing the shims", `${path}: ${detail}`);
  try {
    const original = existsSync(path) ? readFileSync(path, "utf8") : "";
    const data = Bun.TOML.parse(original) as Record<string, unknown>;
    if (data.default_permissions === undefined && data.sandbox_mode === "danger-full-access") return `${path}: full filesystem and network access already configured; unchanged`;
    if (data.default_permissions !== undefined || (data.sandbox_mode !== undefined && data.sandbox_mode !== "workspace-write")) {
      throw fail("uses a different permission policy; configure agent-gh directory writes and networking in that policy manually");
    }
    const sandbox = data.sandbox_workspace_write ?? {};
    if (typeof sandbox !== "object" || sandbox === null || Object.getPrototypeOf(sandbox) !== Object.prototype) throw fail("sandbox_workspace_write must be a table");
    const settings = sandbox as Record<string, unknown>;
    const roots = settings.writable_roots ?? [];
    if (!Array.isArray(roots) || !roots.every((root) => typeof root === "string")) throw fail("writable_roots must be an array of paths");
    const next = { ...data, sandbox_mode: "workspace-write", sandbox_workspace_write: {
      ...settings, writable_roots: roots.includes(resolve(dir)) ? roots : [...roots, resolve(dir)], network_access: true,
    } };
    if (isDeepStrictEqual(data, next)) return `${path}: agent-gh sandbox access already configured`;
    const output = Bun.TOML.stringify(next);
    if (output === undefined || !isDeepStrictEqual(Bun.TOML.parse(output), next)) throw fail("cannot preserve settings when rewriting this TOML");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const backup = `${path}.agent-gh.${randomUUID()}.bak`;
    if (original !== "") writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
    // Create privately without truncating; append also follows a dangling dotfiles symlink.
    if (!existsSync(path)) writeFileSync(path, "", { flag: "a", mode: 0o600 });
    writeAtomic(path, output);
    return `${path}: set the global default sandbox_mode to workspace-write; enabled writes to ${resolve(dir)} and outbound networking to all hosts; ${original === "" ? "new config" : `backup: ${backup}`}. Restart Codex; active profiles and managed policy may override these defaults`;
  } catch (error) {
    if (error instanceof Failure) throw error;
    // TOML parser errors may quote secrets from the config.
    throw fail("could not safely read or update the TOML; check syntax and file permissions");
  }
};
