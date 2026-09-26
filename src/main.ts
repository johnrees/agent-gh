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
 */
import { defaultConfigDir } from "./config.ts";
import { doctor } from "./doctor.ts";
import { describe, Failure } from "./failure.ts";
import { GITHUB } from "./github.ts";
import { familyNames } from "./family.ts";
import { detectIdentity, inAgentSession } from "./harness.ts";
import { login } from "./login.ts";
import { originUrl, resolveRepo } from "./repo.ts";
import { type Context, runAs } from "./run.ts";
import { configuredFamilies, settingsLines } from "./settings.ts";
import { setup } from "./setup.ts";

const USAGE = `usage:
  agent-gh <gh arguments...>        run gh as John through this agent's family App
  agent-gh git <git arguments...>   run git the same way; commits credit the App as co-author
  agent-gh doctor                   show who is acting, then check the user, App, git author, and repository access
  agent-gh setup <family>           create johnrees-<family> (${familyNames().join(", ")}); run it yourself, not from an agent
  agent-gh login <family>           authorize johnrees-<family> to act as you (device flow); run it yourself, not from an agent
  agent-gh settings [family...]     print each App's settings, permissions, and repository-access pages (default: every set-up family)`;

const openUrl = (url: string) => {
  try {
    Bun.spawn(["open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    // The printed URL is the fallback.
  }
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

const main = async (argv: readonly string[]): Promise<number> => {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    console.error(USAGE);
    return first === undefined ? 1 : 0;
  }
  const env = process.env;
  if (first === "settings") {
    const dir = defaultConfigDir();
    if (rest.some((family) => !familyNames().includes(family))) {
      console.error(USAGE);
      return 1;
    }
    const configured = configuredFamilies(dir);
    const families = rest.length > 0 ? rest : configured;
    if (families.length === 0) {
      console.error(`no family is set up in ${dir}; run \`agent-gh setup <family>\` in your own terminal`);
      return 1;
    }
    for (const family of families) for (const line of settingsLines(dir, family, GITHUB.web)) console.log(line);
    return families.every((family) => configured.includes(family)) ? 0 : 1;
  }
  if (first === "setup") {
    const [family] = rest;
    if (family === undefined || !familyNames().includes(family) || rest.length !== 1) {
      console.error(USAGE);
      return 1;
    }
    if (inAgentSession(env)) {
      throw new Failure("setting up", "agents do not create their own credentials; run `agent-gh setup` in your own terminal");
    }
    await setup(family, {
      configDir: defaultConfigDir(),
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
    if (family === undefined || !familyNames().includes(family) || rest.length !== 1) {
      console.error(USAGE);
      return 1;
    }
    if (inAgentSession(env)) {
      throw new Failure("logging in", "an agent cannot authorize itself to act as John; run `agent-gh login` in your own terminal");
    }
    await login(family, {
      api: GITHUB,
      dir: defaultConfigDir(),
      github: GITHUB.web,
      nowSeconds,
      sleep: (ms) => Bun.sleep(ms),
      open: openUrl,
      print: (line) => console.error(line),
    });
    return 0;
  }
  const identity = detectIdentity(env);
  const [command, args] =
    first === "git" ? (["git", rest] as const) : first === "gh" ? (["gh", rest] as const) : (["gh", argv] as const);
  const context: Context = {
    identity,
    repo: await resolveRepo(first === "doctor" ? "git" : command, args, env, () => originUrl(process.cwd())),
    env,
    api: GITHUB,
    configDir: defaultConfigDir(),
    nowSeconds,
    sleep: (ms) => Bun.sleep(ms),
  };
  if (first === "doctor") return doctor(context, (line) => console.log(line));
  if (args.length === 0) {
    console.error(USAGE);
    return 1;
  }
  return runAs(context, [command, ...args]);
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
