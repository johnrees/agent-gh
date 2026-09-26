import { readConfig, readKey, type AppConfig } from "./config.ts";
import { childEnv } from "./env.ts";
import { needsToken, withTrailers } from "./git.ts";
import { type Api, mintToken, revokeToken } from "./github.ts";
import type { Env, Identity } from "./harness.ts";
import type { Repo } from "./repo.ts";
import { runChild } from "./child.ts";

export type Context = {
  readonly identity: Identity;
  readonly repo: Repo;
  readonly env: Env;
  readonly api: Api;
  readonly configDir: string;
  readonly nowSeconds: () => number;
  readonly warn: (line: string) => void;
};

/**
 * Mints a token for the context's one repository with the family's App, hands
 * `use` the child environment, and revokes the token afterwards whatever
 * `use` did. A failed revocation only warns: the token expires within an hour.
 */
export const withToken = async <T>(
  context: Context,
  use: (env: Record<string, string>, config: AppConfig) => Promise<T>,
): Promise<T> => {
  const config = readConfig(context.configDir, context.identity.family);
  const key = readKey(context.configDir, context.identity.family);
  const token = await mintToken(context.api, config, key, context.repo, context.nowSeconds());
  try {
    return await use(childEnv(context.env, token, context.repo, config), config);
  } finally {
    if (!(await revokeToken(context.api, token))) {
      context.warn("agent-gh: the temporary token could not be revoked; it expires within one hour.");
    }
  }
};

/** The bot's identity with no token, for git commands that never reach GitHub. */
export const withIdentity = <T>(
  context: Context,
  use: (env: Record<string, string>, config: AppConfig) => Promise<T>,
): Promise<T> => {
  const config = readConfig(context.configDir, context.identity.family);
  return use(childEnv(context.env, undefined, context.repo, config), config);
};

/**
 * Runs `gh` or `git` as the family's bot and returns the child's exit code.
 * A commit carries the Agent-* trailers; local git commands get no token.
 */
export const runAs = (context: Context, command: readonly string[]): Promise<number> => {
  const [program, ...args] = command;
  if (program === "git") {
    const argv = ["git", ...withTrailers(args, context.identity)];
    const run = needsToken(args) ? withToken : withIdentity;
    return run(context, async (env) => (await runChild(argv, env)).code);
  }
  return withToken(context, async (env) => (await runChild(command, env)).code);
};
