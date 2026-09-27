#!/usr/bin/env bun
/**
 * agent-gh: run gh or git as John through the GitHub App of the model family
 * driving this agent session (johnrees-<family>), whatever harness runs it.
 * GitHub shows each action as John with the App's badge.
 *
 *   agent-gh <gh arguments...>     gh through the App, e.g. agent-gh pr create --draft
 *   agent-gh git <git arguments...>
 *   agent-gh doctor                who is acting, then user, App, git author, and repository access
 *   agent-gh setup <family>        create johnrees-<family> (run in your own terminal)
 *   agent-gh login <family>        authorize the App to act as John (run in your own terminal)
 *   agent-gh settings [family...]  print where each family App's permissions and repositories are changed
 *   agent-gh guard <hook> [args]   decide a repository's git hook: commit-msg, pre-push
 *   agent-gh login --all           log in every App this machine lacks (the install line runs it)
 *   agent-gh install-shims         gh and git shims first on PATH; --agent-machine also removes personal write access
 *   agent-gh doctor --machine      is this machine set up so agents use agent-gh for everything
 *   agent-gh credential <action>   git's credential helper on an agent machine: the read App's token
 */
import { defaultConfigDir, isConfigured, READ_APP, REGISTRY } from "./config.ts";
import { credential, readToken } from "./credential.ts";
import { doctor } from "./doctor.ts";
import { describe, Failure } from "./failure.ts";
import { GITHUB } from "./github.ts";
import { guard } from "./guard.ts";
import { familyNames } from "./family.ts";
import { detectIdentity, inAgentSession } from "./harness.ts";
import { limitedFamilies, login, loginAll, loginTargets } from "./login.ts";
import { formatLine, latestRelease, machineDoctor } from "./machine.ts";
import { originUrl, resolveRepo } from "./repo.ts";
import { type Context, runAs, runGit } from "./run.ts";
import { configuredFamilies, settingsLines } from "./settings.ts";
import { setup } from "./setup.ts";
import { readGitConfig } from "./target.ts";
import { defaultBinDir, defaultShimDir, installShims, type ShimDeps } from "./shims.ts";
import { VERSION } from "./version.ts";

const USAGE = `usage:
  agent-gh <gh arguments...>        run gh as John through this agent's family App
  agent-gh git <git arguments...>   run git the same way; commits credit the App as co-author
  agent-gh doctor                   show who is acting, then check the user, App, git author, and repository access
  agent-gh setup <family>           create johnrees-<family> (${familyNames().join(", ")}, or read); run it yourself, not from an agent
  agent-gh login <family>|--all     authorize johnrees-<family> to act as you (device flow); --all: every App not yet logged in
  agent-gh install-shims [--agent-machine]  gh and git shims first on PATH; --agent-machine: clone with the read App, gh logged out
  agent-gh doctor --machine         check this machine: release, gitleaks, logins, shims, and agent-machine settings
  agent-gh --version
  agent-gh credential get           git's credential helper on agent machines: the read App's token, for github.com only
  agent-gh read-token               print the read App's token (the gh shim's GH_TOKEN on agent machines)
  agent-gh settings [family...]     print each App's settings, permissions, and repository-access pages (default: every set-up family)
  agent-gh guard commit-msg <file>  from a git hook: refuse an agent session's commit that does not credit its family App
  agent-gh guard pre-push           from a git hook: refuse an agent session's push that did not come through agent-gh`;

/** Opens a URL in a local browser if there is one; the printed URL is always the fallback. */
const openUrl = (url: string) => {
  try {
    Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    // No opener (a headless or remote machine): the printed URL and code are the path.
  }
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Apps setup, login, and settings accept: every family, and the read App. */
const apps = (): string[] => [...familyNames(), READ_APP];

/** This binary, for the shims and git's credential helper to call; `bun src/main.ts` stands in for it with the installed one. */
const self = (): string => (/(^|\/)agent-gh[^/]*$/.test(process.execPath) ? process.execPath : `${defaultBinDir()}/agent-gh`);

const shimDeps = (env: NodeJS.ProcessEnv): ShimDeps => ({
  home: process.env.HOME ?? "",
  shims: defaultShimDir(),
  bin: defaultBinDir(),
  configDir: defaultConfigDir(),
  registry: REGISTRY,
  agentGh: self(),
  env,
  nowSeconds,
  print: (line) => console.error(line),
});

const deviceDeps = () => ({
  api: GITHUB,
  dir: defaultConfigDir(),
  registry: REGISTRY,
  github: GITHUB.web,
  nowSeconds,
  sleep: (ms: number) => Bun.sleep(ms),
  open: openUrl,
  print: (line: string) => console.error(line),
});

const main = async (argv: readonly string[]): Promise<number> => {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    console.error(USAGE);
    return first === undefined ? 1 : 0;
  }
  if (first === "--version" || first === "version") {
    console.log(`agent-gh ${VERSION}`);
    return 0;
  }
  const env = process.env;
  if (first === "credential") {
    // git runs this for every github.com request once --agent-machine set it up, agent sessions included.
    const input = await new Response(Bun.stdin.stream()).text();
    process.stdout.write(
      await credential(rest[0], input, () => readToken({ api: GITHUB, dir: defaultConfigDir(), registry: REGISTRY, nowSeconds, sleep: (ms) => Bun.sleep(ms) })),
    );
    return 0;
  }
  if (first === "read-token") {
    console.log(await readToken({ api: GITHUB, dir: defaultConfigDir(), registry: REGISTRY, nowSeconds, sleep: (ms) => Bun.sleep(ms) }));
    return 0;
  }
  if (first === "doctor" && rest[0] === "--machine") {
    const lines = await machineDoctor({
      ...shimDeps(env),
      version: VERSION,
      latest: () => latestRelease(GITHUB, "johnrees/agent-gh"),
    });
    for (const line of lines) console.log(formatLine(line));
    const failed = lines.some((line) => line.state === "FAIL");
    console.log(failed ? "Not set up yet: fix the FAIL lines above." : "This machine is set up: agents use agent-gh for GitHub writes.");
    return failed ? 1 : 0;
  }
  if (first === "install-shims") {
    const agentMachine = rest.includes("--agent-machine");
    if (rest.some((arg) => arg !== "--agent-machine")) {
      console.error(USAGE);
      return 1;
    }
    if (inAgentSession(env)) {
      throw new Failure("installing the shims", "an agent does not change its own guardrails; run the install line in your own terminal");
    }
    installShims(shimDeps(env), agentMachine, limitedFamilies(familyNames(), env.AGENT_GH_FAMILIES));
    return 0;
  }
  if (first === "guard") {
    const verdict = guard(rest, env, defaultConfigDir(), REGISTRY, () => readGitConfig(process.cwd(), env));
    if (verdict.message !== undefined) console.error(verdict.message);
    return verdict.code;
  }
  if (first === "settings") {
    const dir = defaultConfigDir();
    if (rest.some((family) => !apps().includes(family))) {
      console.error(USAGE);
      return 1;
    }
    const configured = [...configuredFamilies(dir), ...(isConfigured(dir, READ_APP) ? [READ_APP] : [])];
    const families = rest.length > 0 ? rest : configured;
    if (families.length === 0) {
      console.error("no family has an App yet; run `agent-gh setup <family>` on the machine where you create Apps");
      return 1;
    }
    for (const family of families) for (const line of settingsLines(dir, family, GITHUB.web)) console.log(line);
    return families.every((family) => configured.includes(family)) ? 0 : 1;
  }
  if (first === "setup") {
    const [family] = rest;
    if (family === undefined || !apps().includes(family) || rest.length !== 1) {
      console.error(USAGE);
      return 1;
    }
    if (inAgentSession(env)) {
      throw new Failure("setting up", "agents do not create their own credentials; run `agent-gh setup` in your own terminal");
    }
    await setup(family, {
      configDir: defaultConfigDir(),
      registry: REGISTRY,
      api: GITHUB,
      github: GITHUB.web,
      open: openUrl,
      print: (line) => console.error(line),
      timeoutMs: 10 * 60 * 1000,
    });
    return 0;
  }
  if (first === "login") {
    const [family] = rest;
    if (family === undefined || !(apps().includes(family) || family === "--all") || rest.length !== 1) {
      console.error(USAGE);
      return 1;
    }
    if (inAgentSession(env)) {
      throw new Failure("logging in", "an agent cannot authorize itself to act as John; run `agent-gh login` in your own terminal");
    }
    if (family === "--all") {
      const configured = (name: string) => isConfigured(defaultConfigDir(), name);
      const failed = await loginAll(loginTargets(familyNames(), env.AGENT_GH_FAMILIES, READ_APP, configured), deviceDeps());
      if (failed.length > 0) console.error(`Not logged in: ${failed.join(", ")}. Rerun to retry them.`);
      return failed.length > 0 ? 1 : 0;
    }
    await login(family, deviceDeps());
    return 0;
  }
  const identity = detectIdentity(env);
  if (first === "git") {
    if (rest.length === 0) {
      console.error(USAGE);
      return 1;
    }
    return runGit(
      {
        identity,
        env,
        api: GITHUB,
        configDir: defaultConfigDir(),
        registry: REGISTRY,
        nowSeconds,
        sleep: (ms) => Bun.sleep(ms),
        readGitConfig: (dir) => readGitConfig(dir, env),
      },
      rest,
    );
  }
  const args = first === "gh" ? rest : argv;
  const context: Context = {
    identity,
    repo: await resolveRepo(first === "doctor" ? "git" : "gh", args, env, () => originUrl(process.cwd())),
    env,
    api: GITHUB,
    configDir: defaultConfigDir(),
    registry: REGISTRY,
    nowSeconds,
    sleep: (ms) => Bun.sleep(ms),
  };
  if (first === "doctor") return doctor(context, (line) => console.log(line));
  if (args.length === 0) {
    console.error(USAGE);
    return 1;
  }
  return runAs(context, ["gh", ...args]);
};

try {
  process.exitCode = await main(Bun.argv.slice(2));
} catch (error) {
  console.error(
    error instanceof Failure
      ? describe(error)
      : `agent-gh: unexpected ${error instanceof Error ? error.name : "error"}. No personal-login fallback was used.`,
  );
  process.exitCode = 1;
}
