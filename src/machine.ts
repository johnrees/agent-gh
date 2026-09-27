import { existsSync } from "node:fs";
import { join } from "node:path";
import { isConfigured, READ_APP } from "./config.ts";
import { familyNames } from "./family.ts";
import type { Api } from "./github.ts";
import { loginUsable } from "./login.ts";
import { agentMachineGit, findReal, holds, isShim, personalGhLogin, readMachine, type ShimDeps } from "./shims.ts";

export const RERUN = "rerun the install line";

/** What GitHub tells this machine's SSH keys: one logs in, none does, or no answer. */
export type SshAnswer = "authenticates" | "refused" | "unknown";

/**
 * Asks GitHub whether any SSH key here logs in, without a terminal. On an
 * agent machine one that does could push over SSH, which no URL rule can
 * route through agent-gh (an ssh Host alias, a spelling git does not match).
 */
export const sshToGitHub = (): SshAnswer => {
  try {
    const options = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new"];
    const result = Bun.spawnSync(["ssh", ...options, "git@github.com"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    const said = `${result.stdout.toString()}${result.stderr.toString()}`;
    if (said.includes("successfully authenticated")) return "authenticates";
    return said.includes("Permission denied") ? "refused" : "unknown";
  } catch {
    return "unknown";
  }
};

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
  deps: ShimDeps & { readonly version: string; readonly latest: () => Promise<string | undefined>; readonly ssh: () => SshAnswer },
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

  const gh = findReal("gh", deps.env.PATH, "");
  const shimmed = gh !== undefined && gh.startsWith(`${deps.shims}/`);
  add(shimmed ? "ok" : "FAIL", "gh shim", shimmed ? `${gh} is first on PATH` : `${gh ?? "no gh"} comes first, not the shim; open a new shell, or ${RERUN}`);
  const git = join(deps.shims, "git");
  if (existsSync(git) && isShim(git)) add("FAIL", "git shim", `${git} is left from an older agent-gh; ${RERUN}`);

  if (machine.agent_machine) {
    const wrong = agentMachineGit(deps.agentGh)
      .filter((setting) => !holds(deps, setting))
      .map((setting) => setting.key);
    add(
      wrong.length === 0 ? "ok" : "FAIL",
      "git credentials",
      wrong.length === 0
        ? "an agent session uses its family App where installed, and anyone else the read App"
        : `not as install-shims sets them: ${wrong.join(", ")}; ${RERUN} with --agent-machine`,
    );
    const ssh = deps.ssh();
    add(
      ssh === "authenticates" ? "FAIL" : ssh === "refused" ? "ok" : "note",
      "ssh",
      ssh === "authenticates"
        ? "a key here logs in to GitHub, and SSH can push without agent-gh; remove it from this machine or from your GitHub account"
        : ssh === "refused" ? "no key here logs in to GitHub" : "GitHub did not answer over SSH",
    );
    const personal = personalGhLogin(deps);
    add(personal ? "FAIL" : "ok", "gh login", personal ? "gh holds your personal login; run `gh auth logout --hostname github.com`" : "no personal login");
  }
  return lines;
};

export const formatLine = (line: Line): string => `${line.state === "ok" ? "ok  " : line.state} ${line.name}: ${line.detail}`;
