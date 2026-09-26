import { runChild } from "./child.ts";
import { readConfig, readKey, type AppConfig } from "./config.ts";
import { childEnv } from "./env.ts";
import { needsToken, withTrailers } from "./git.ts";
import { type Api, requireInstallation } from "./github.ts";
import type { Env, Identity } from "./harness.ts";
import { userToken } from "./login.ts";
import type { Repo } from "./repo.ts";

export type Context = {
  readonly identity: Identity;
  readonly repo: Repo;
  readonly env: Env;
  readonly api: Api;
  readonly configDir: string;
  readonly nowSeconds: () => number;
  readonly sleep: (ms: number) => Promise<void>;
};

/**
 * John's user access token for the family's App, after checking the App is
 * installed on the context's repository. GitHub records what the child does as
 * John with the App's badge. A user token reaches every repository the App is
 * installed on; it cannot be narrowed to one per call.
 */
export const withToken = async <T>(
  context: Context,
  use: (env: Record<string, string>, config: AppConfig) => Promise<T>,
): Promise<T> => {
  const { family } = context.identity;
  const config = readConfig(context.configDir, family);
  await requireInstallation(context.api, config, readKey(context.configDir, family), context.repo, context.nowSeconds());
  const token = await userToken(config, family, {
    api: context.api,
    dir: context.configDir,
    nowSeconds: context.nowSeconds,
    sleep: context.sleep,
  });
  return use(childEnv(context.env, token, context.repo), config);
};

/** No token, for git commands that never reach GitHub. */
export const withoutToken = <T>(
  context: Context,
  use: (env: Record<string, string>, config: AppConfig) => Promise<T>,
): Promise<T> => use(childEnv(context.env, undefined, context.repo), readConfig(context.configDir, context.identity.family));

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
