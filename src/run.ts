import { runChild } from "./child.ts";
import { readConfig, type AppConfig, type Registry } from "./config.ts";
import { childEnv } from "./env.ts";
import { Failure } from "./failure.ts";
import { type Api, isPublicRepo, MissingInstallation, requireInstallation } from "./github.ts";
import type { Env, Identity } from "./harness.ts";
import { userToken } from "./login.ts";
import { publicRead } from "./public-read.ts";
import { type Repo, slug } from "./repo.ts";

export type Context = {
  readonly identity: Identity;
  /** The repository the command names, if any (`resolveRepo`). */
  readonly repo: Repo | undefined;
  readonly env: Env;
  readonly api: Api;
  readonly configDir: string;
  /** The committed App registry; tests pass their own. */
  readonly registry: Registry;
  readonly nowSeconds: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Diagnostics go to stderr, leaving gh's JSON/stdout untouched. */
  readonly print?: (line: string) => void;
};

const familyLogin = async (context: Context) => {
  const { family } = context.identity;
  const config = readConfig(context.configDir, family, context.registry);
  const token = await userToken(config, family, {
    api: context.api, dir: context.configDir,
    nowSeconds: context.nowSeconds, sleep: context.sleep,
  });
  return { config, token };
};

/**
 * John's user access token for the family's App, after checking with that
 * token that the App is installed on the context's repository, when the
 * command names one. The check only explains a refusal: a user token reaches
 * every repository the App is installed on, cannot be narrowed to one per
 * call, and GitHub refuses the rest itself. The App's private key is never
 * read here. GitHub records what the child does as John with the App's badge.
 */
export const withToken = async <T>(
  context: Context,
  use: (env: Record<string, string>, config: AppConfig) => Promise<T>,
): Promise<T> => {
  const { config, token } = await familyLogin(context);
  if (context.repo !== undefined) await requireInstallation(context.api, config, context.identity.family, token, context.repo);
  return use(childEnv(context.env, token, context.repo), config);
};

/** Known gh reads can use the existing App login on a repository confirmed public. */
export const runAs = async (context: Context, command: readonly string[]): Promise<number> => {
  const read = command[0] === "gh" ? publicRead(command.slice(1), context.repo) : undefined;
  const target = read === undefined ? context : { ...context, repo: read.repo };
  const { config, token } = await familyLogin(target);
  try {
    if (target.repo !== undefined) await requireInstallation(target.api, config, target.identity.family, token, target.repo);
  } catch (error) {
    if (!(error instanceof MissingInstallation) || read?.repo === undefined) throw error;
    let visible: boolean;
    try {
      visible = await isPublicRepo(context.api, read.repo, token);
    } catch (probe) {
      if (!(probe instanceof Failure)) throw probe;
      throw new Failure(error.stage, `${error.detail}; public visibility check failed: ${probe.detail}`, probe.network);
    }
    if (!visible) throw error;
    (context.print ?? console.error)(`agent-gh: reading public repository ${slug(read.repo)} with the ${config.slug} App (not installed on this repository).`);
  }
  // Never retry a command after it has started, even if its failure resembles an auth error.
  // The authorization target must not retarget gh's placeholders or branch
  // resolution. Explicit flags/URLs/endpoints still tell gh what to read.
  return (await runChild(command, childEnv(context.env, token, context.repo))).code;
};
