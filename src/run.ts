import { runChild } from "./child.ts";
import { readConfig, type AppConfig, type Registry } from "./config.ts";
import { childEnv } from "./env.ts";
import { Failure } from "./failure.ts";
import { type Api, MissingInstallation, repoVisibility, requireInstallation, type Visibility } from "./github.ts";
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

/**
 * A known read whose repository lacks the family App: GitHub's canonical name
 * for it (a rename or transfer is followed once, on the API origin), then that
 * name's installation, then public visibility. Returns to run the read;
 * anything else keeps the refusal, with the check's error when it failed.
 */
const authorizeRead = async (context: Context, config: AppConfig, token: string, requested: Repo, missing: MissingInstallation): Promise<void> => {
  let found: Visibility | undefined;
  try {
    found = await repoVisibility(context.api, requested, token);
  } catch (probe) {
    if (!(probe instanceof Failure)) throw probe;
    throw new Failure(missing.stage, `${missing.detail}; public visibility check failed: ${probe.detail}`, probe.network);
  }
  if (found === undefined) throw missing;
  const renamed = slug(found.repo).toLowerCase() !== slug(requested).toLowerCase();
  let refusal = missing;
  if (renamed) {
    try {
      await requireInstallation(context.api, config, context.identity.family, token, found.repo);
      return;
    } catch (error) {
      if (!(error instanceof MissingInstallation)) throw error;
      refusal = error;
    }
  }
  if (!found.public) throw refusal;
  const name = renamed ? `${slug(found.repo)} (requested as ${slug(requested)})` : slug(found.repo);
  (context.print ?? console.error)(`agent-gh: reading public repository ${name} with the ${config.slug} App (not installed on this repository).`);
};

/**
 * Runs `gh` through the family's App and returns the child's exit code. A
 * known read checks the repository it actually reads, and may read a public
 * repository the App is not installed on with the same login.
 */
export const runAs = async (context: Context, command: readonly string[]): Promise<number> => {
  const read = command[0] === "gh" ? publicRead(command.slice(1), context.repo) : undefined;
  const repo = read === undefined ? context.repo : read.repo;
  const { config, token } = await familyLogin(context);
  if (repo !== undefined) {
    try {
      await requireInstallation(context.api, config, context.identity.family, token, repo);
    } catch (error) {
      if (!(error instanceof MissingInstallation) || read === undefined) throw error;
      await authorizeRead(context, config, token, repo, error);
    }
  }
  // Never retry a command after it has started, even if its failure resembles an auth error.
  // The authorization target must not retarget gh's placeholders or branch
  // resolution. Explicit flags/URLs/endpoints still tell gh what to read.
  return (await runChild(command, childEnv(context.env, token, context.repo))).code;
};
