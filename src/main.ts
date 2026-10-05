#!/usr/bin/env bun
/**
 * agent-gh: run gh as John through the GitHub App of the model family driving
 * this agent session (johnrees-<family>), whatever harness runs it, and credit
 * that App on the session's commits. GitHub shows each action as John with
 * the App's badge. The usage below lists every command.
 */
import { appendFileSync } from "node:fs";
import { runChild } from "./child.ts";
import { defaultConfigDir, isConfigured, READ_APP, REGISTRY } from "./config.ts";
import { credential, familyToken, readToken } from "./credential.ts";
import { doctor } from "./doctor.ts";
import { describe, Failure, NEXT_STEP } from "./failure.ts";
import { GITHUB } from "./github.ts";
import { guard } from "./guard.ts";
import { familyNames } from "./family.ts";
import { detectIdentity, inAgentSession } from "./harness.ts";
import { limitedFamilies, login, loginAll, loginTargets } from "./login.ts";
import { formatLine, latestRelease, machineDoctor, sshToGitHub } from "./machine.ts";
import { originUrl, resolveRepo } from "./repo.ts";
import { type Context, runAs } from "./run.ts";
import { configuredFamilies, settingsLines } from "./settings.ts";
import { setup } from "./setup.ts";
import { readGitConfig } from "./target.ts";
import { defaultBinDir, defaultShimDir, installShims, rcBlock, type ShimDeps, whichReal } from "./shims.ts";
import { VERSION } from "./version.ts";

const USAGE = `usage:
  agent-gh <gh arguments...>        run gh as John through this agent's family App
  agent-gh doctor                   show who is acting, then check the user, App, git author, and repository access
  agent-gh setup <family>           create johnrees-<family> (${familyNames().join(", ")}, or read); run it yourself, not from an agent
  agent-gh login <family>|--all     authorize johnrees-<family> to act as you (device flow); --all: every App not yet logged in
  agent-gh install-shims [--agent-machine]  the gh shim first on PATH; --agent-machine: git reads with the read App and pushes with the family App, gh logged out
  agent-gh doctor --machine         check this machine: release, gitleaks, logins, shims, and agent-machine settings
  agent-gh --version
  agent-gh credential get           git's credential helper on agent machines: an agent session's family App where installed, else the read App
  agent-gh session-env              from Claude Code's SessionStart hook: put the gh shim first on PATH for every command
  agent-gh read-token               print the read App's token (the gh shim's GH_TOKEN on agent machines)
  agent-gh settings [family...]     print each App's settings, permissions, and repository-access pages (default: every set-up family)
  agent-gh guard commit-msg <file>  from a git hook: in an agent session, add its Agent-* trailers and credit its family App
  agent-gh which <gh|git>           print the real program, past any agent-gh shim; copy this, never \`command -v gh\`, into a test's PATH`;

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
    const deps = { api: GITHUB, dir: defaultConfigDir(), registry: REGISTRY, nowSeconds, sleep: (ms: number) => Bun.sleep(ms), env };
    process.stdout.write(
      await credential(rest[0], input, {
        inAgentSession: inAgentSession(env),
        read: () => readToken(deps),
        family: (repo) => familyToken(deps, repo),
        print: (line) => console.error(line),
      }),
    );
    return 0;
  }
  if (first === "which") {
    const [name, ...extra] = rest;
    if ((name !== "gh" && name !== "git") || extra.length > 0) {
      console.error(USAGE);
      return 1;
    }
    const program = whichReal(name, env.PATH, defaultShimDir());
    if (program === undefined) {
      console.error(`agent-gh: no ${name} on PATH besides agent-gh's shims`);
      return 1;
    }
    console.log(program);
    return 0;
  }
  if (first === "session-env") {
    // Claude Code's SessionStart hook: CLAUDE_ENV_FILE is sourced before every command, after the shell snapshot.
    const file = env.CLAUDE_ENV_FILE;
    if (file !== undefined && file !== "") {
      try {
        appendFileSync(file, `${rcBlock(defaultShimDir(), defaultBinDir())}\n`);
      } catch (error) {
        console.error(`agent-gh session-env: could not write ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
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
      ssh: sshToGitHub,
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
  if (first === "git") {
    // Older releases ran git through agent-gh; now a repository's commit hook credits the App.
    const git = whichReal("git", env.PATH, defaultShimDir());
    if (git === undefined) {
      console.error("agent-gh: no git on PATH");
      return 127;
    }
    console.error("agent-gh: `agent-gh git` is plain git now; run git directly (the repository's commit hook credits the App)");
    const plain: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) if (value !== undefined) plain[name] = value;
    return (await runChild([git, ...rest], plain)).code;
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
  const args = first === "gh" ? rest : argv;
  const repo = await resolveRepo(first === "doctor" ? "git" : "gh", args, env, () => originUrl(process.cwd()));
  const context: Context = {
    identity,
    repo,
    env,
    api: GITHUB,
    configDir: defaultConfigDir(),
    registry: REGISTRY,
    nowSeconds,
    sleep: (ms) => Bun.sleep(ms),
  };
  if (first === "doctor") {
    if (repo === undefined) {
      throw new Failure("resolving the repository", "no GH_REPO and no github.com origin remote; run doctor inside a clone of the repository");
    }
    return doctor({ ...context, repo }, (line) => console.log(line));
  }
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
      : `agent-gh: unexpected ${error instanceof Error ? error.name : "error"}.\n${NEXT_STEP}`,
  );
  process.exitCode = 1;
}
