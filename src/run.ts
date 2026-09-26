import { readConfig, readKey, type AppConfig } from "./config.ts";
import { childEnv } from "./env.ts";
import { type Api, mintToken, revokeToken } from "./github.ts";
import type { Env } from "./harness.ts";
import type { Repo } from "./repo.ts";
import { runChild } from "./child.ts";

export type Context = {
  readonly harness: string;
  readonly repo: Repo;
  readonly env: Env;
  readonly api: Api;
  readonly configDir: string;
  readonly nowSeconds: () => number;
  readonly warn: (line: string) => void;
};

/**
 * Mints a token for the context's one repository, hands `use` the child
 * environment, and revokes the token afterwards whatever `use` did. A failed
 * revocation only warns: the token expires within an hour.
 */
export const withToken = async <T>(
  context: Context,
  use: (env: Record<string, string>, config: AppConfig) => Promise<T>,
): Promise<T> => {
  const config = readConfig(context.configDir, context.harness);
  const key = readKey(context.configDir, context.harness);
  const token = await mintToken(context.api, config, key, context.repo, context.nowSeconds());
  try {
    return await use(childEnv(context.env, token, context.repo, config), config);
  } finally {
    if (!(await revokeToken(context.api, token))) {
      context.warn("agent-gh: the temporary token could not be revoked; it expires within one hour.");
    }
  }
};

/** Runs `gh` or `git` as the harness's bot and returns the child's exit code. */
export const runAs = (context: Context, command: readonly string[]): Promise<number> =>
  withToken(context, async (env) => (await runChild(command, env)).code);
