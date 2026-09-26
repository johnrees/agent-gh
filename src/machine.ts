import { isConfigured, READ_APP } from "./config.ts";
import { familyNames } from "./family.ts";
import type { Api } from "./github.ts";
import { loginUsable } from "./login.ts";
import { credentialHelpers, findReal, helperValues, personalGhLogin, readMachine, type ShimDeps } from "./shims.ts";

export const RERUN = "rerun the install line";

type Line = { readonly state: "ok" | "FAIL" | "note"; readonly name: string; readonly detail: string };

/** The newest release's tag, or undefined when GitHub does not say (a private repository, or offline). */
export const latestRelease = async (api: Api, repo: string): Promise<string | undefined> => {
  try {
    const response = await fetch(`${api.base}/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-gh" },
      redirect: "error",
      signal: AbortSignal.timeout(api.timeoutMs),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const tag = typeof body === "object" && body !== null ? (body as Record<string, unknown>).tag_name : undefined;
    return typeof tag === "string" ? tag : undefined;
  } catch {
    return undefined;
  }
};

/**
 * `agent-gh doctor --machine`: whether this machine is set up so agents use
 * agent-gh for everything. Every failing line names its fix, which is almost
 * always the install line. Exit 0 only with no failure.
 */
export const machineDoctor = async (
  deps: ShimDeps & { readonly version: string; readonly latest: () => Promise<string | undefined> },
): Promise<Line[]> => {
  const lines: Line[] = [];
  const add = (state: Line["state"], name: string, detail: string) => lines.push({ state, name, detail });
  const machine = readMachine(deps.configDir);

  if (deps.version === "dev") add("note", "agent-gh", "a local build, not a release");
  else {
    const latest = await deps.latest();
    if (latest === undefined) add("note", "agent-gh", `${deps.version}; the latest release is unknown (a private repository, or GitHub unreachable)`);
    else if (latest === deps.version) add("ok", "agent-gh", `${deps.version}, the latest release`);
    else add("FAIL", "agent-gh", `${deps.version}, and ${latest} is out; ${RERUN}`);
  }

  const gitleaks = findReal("gitleaks", deps.env.PATH, deps.shims);
  add(gitleaks === undefined ? "FAIL" : "ok", "gitleaks", gitleaks ?? `missing; ${RERUN}`);

  const families = machine.families ?? familyNames().filter((family) => isConfigured(deps.configDir, family, deps.registry));
  for (const family of families) {
    const usable = loginUsable(deps.configDir, family, deps.nowSeconds());
    add(usable ? "ok" : "FAIL", `login ${family}`, usable ? "usable" : `not logged in; ${RERUN} (or \`agent-gh login ${family}\`)`);
  }
  if (!isConfigured(deps.configDir, READ_APP, deps.registry)) {
    add(machine.agent_machine ? "FAIL" : "note", "login read", "the read App does not exist yet; run `agent-gh setup read` where you create Apps and commit its registry entry");
  } else {
    const usable = loginUsable(deps.configDir, READ_APP, deps.nowSeconds());
    add(usable ? "ok" : machine.agent_machine ? "FAIL" : "note", "login read", usable ? "usable" : `not logged in; ${RERUN} (or \`agent-gh login read\`)`);
  }

  for (const name of ["gh", "git"]) {
    const first = findReal(name, deps.env.PATH, "");
    const shimmed = first !== undefined && first.startsWith(`${deps.shims}/`);
    add(
      shimmed ? "ok" : "FAIL",
      `${name} shim`,
      shimmed ? `${first} is first on PATH` : `${first ?? `no ${name}`} comes first, not the shim; open a new shell, or ${RERUN}`,
    );
  }

  if (machine.agent_machine) {
    const helpers = credentialHelpers(deps);
    const want = helperValues(deps.agentGh);
    const helped = helpers.length === want.length && helpers.every((value, index) => value === want[index]);
    add(helped ? "ok" : "FAIL", "git credentials", helped ? "github.com uses the read App" : `github.com does not use the read App; ${RERUN} with --agent-machine`);
    const personal = personalGhLogin(deps);
    add(personal ? "FAIL" : "ok", "gh login", personal ? "gh holds your personal login; run `gh auth logout --hostname github.com`" : "no personal login");
  }
  return lines;
};

export const formatLine = (line: Line): string => `${line.state === "ok" ? "ok  " : line.state} ${line.name}: ${line.detail}`;
