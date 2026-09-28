import { runChild } from "./child.ts";
import { readConfig, type AppConfig, type Registry } from "./config.ts";
import { childEnv } from "./env.ts";
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

/** Runs `gh` through the family's App and returns the child's exit code. */
export const runAs = async (context: Context, command: readonly string[]): Promise<number> =>
  withToken(context, async (env) => (await runChild(command, env)).code);
