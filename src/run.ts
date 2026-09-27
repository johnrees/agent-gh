import { runChild } from "./child.ts";
import { readConfig, type AppConfig, type Registry } from "./config.ts";
import { childEnv } from "./env.ts";
import { CHILD_MARKER } from "./guard.ts";
import { needsToken, withTrailers } from "./git.ts";
import { type Api, requireInstallation } from "./github.ts";
import type { Env, Identity } from "./harness.ts";
import { userToken } from "./login.ts";
import type { Repo } from "./repo.ts";
import { type GitConfig, gitCwd, gitRoute } from "./target.ts";

export type Context = {
  readonly identity: Identity;
  readonly repo: Repo;
  readonly env: Env;
  readonly api: Api;
  readonly configDir: string;
  /** The committed App registry; tests pass their own. */
  readonly registry: Registry;
  readonly nowSeconds: () => number;
  readonly sleep: (ms: number) => Promise<void>;
};

/**
 * John's user access token for the family's App, after checking with that
 * token that the App is installed on the context's repository. The App's
 * private key is never read here. GitHub records what the child does as
 * John with the App's badge. A user token reaches every repository the App is
 * installed on; it cannot be narrowed to one per call.
 */
export const withToken = async <T>(
  context: Context,
  use: (env: Record<string, string>, config: AppConfig) => Promise<T>,
): Promise<T> => {
  const { family } = context.identity;
  const config = readConfig(context.configDir, family, context.registry);
  const token = await userToken(config, family, {
    api: context.api,
    dir: context.configDir,
    nowSeconds: context.nowSeconds,
    sleep: context.sleep,
  });
  await requireInstallation(context.api, config, family, token, context.repo);
  return use(childEnv(context.env, token, context.repo), config);
};

/** No token, for git commands that never reach GitHub. */
export const withoutToken = <T>(
  context: Context,
  use: (env: Record<string, string>, config: AppConfig) => Promise<T>,
): Promise<T> =>
  use(childEnv(context.env, undefined, context.repo), readConfig(context.configDir, context.identity.family, context.registry));

/**
 * Runs `gh` or `git` through the family's App and returns the child's exit
 * code. A commit keeps John as author and carries the Agent-* trailers and the
 * App as co-author; local git commands get no token.
 */
export const runAs = async (context: Context, command: readonly string[]): Promise<number> => {
  const [program, ...args] = command;
  if (program === "git") {
    const run = needsToken(args) ? withToken : withoutToken;
    return run(context, async (env, config) => (await runChild(["git", ...withTrailers(args, context.identity, config)], env)).code);
  }
  return withToken(context, async (env) => (await runChild(command, env)).code);
};

/**
 * Everything `runGit` needs: the context without a repository, which the
 * command itself decides. The child git runs in this process's directory, so
 * its config is read there too, with git's `-C` options applied.
 */
export type GitContext = Omit<Context, "repo"> & {
  readonly readGitConfig: (dir: string) => GitConfig;
};

/**
 * `agent-gh git ...`: a command that touches GitHub runs through the family App
 * (John as author, the App as co-author, the App's token for the remote); one
 * in a repository with no github.com remote, or aimed at a remote elsewhere,
 * runs as the real git, unchanged. `AGENT_GH_CHILD` keeps the git shim from
 * sending it back here.
 */
export const runGit = async (context: GitContext, args: readonly string[]): Promise<number> => {
  const route = gitRoute(args, context.readGitConfig(gitCwd(args, process.cwd())));
  if (route.kind === "passthrough") {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(context.env)) if (value !== undefined) env[name] = value;
    env[CHILD_MARKER] = "1";
    return (await runChild(["git", ...args], env)).code;
  }
  return runAs({ ...context, repo: route.repo }, ["git", ...args]);
};
