import { runChild } from "./child.ts";
import { readConfig, type AppConfig, type Registry } from "./config.ts";
import { childEnv } from "./env.ts";
import { type Api, isPublic, MissingInstallation, requireInstallation } from "./github.ts";
import type { Env, Identity } from "./harness.ts";
import { userToken } from "./login.ts";
import { type Repo, slug } from "./repo.ts";
import { apiCall } from "./review.ts";

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
};

/**
 * John's user access token for the family's App, after checking with that
 * token that the App is installed on the context's repository, when the
 * command names one. The check only explains a refusal: a user token reaches
 * every repository the App is installed on, cannot be narrowed to one per
 * call, and GitHub refuses the rest itself. The App's private key is never
 * read here. GitHub records what the child does as John with the App's badge.
 *
 * A `read` (see `readOnly`) of a public repository the App is not installed
 * on goes ahead with the same token, which reads any public repository, and
 * says so on stderr; a private one, or one whose visibility the check cannot
 * learn, keeps the refusal.
 */
export const withToken = async <T>(
  context: Context,
  use: (env: Record<string, string>, config: AppConfig) => Promise<T>,
  read = false,
): Promise<T> => {
  const { family } = context.identity;
  const config = readConfig(context.configDir, family, context.registry);
  const token = await userToken(config, family, {
    api: context.api,
    dir: context.configDir,
    nowSeconds: context.nowSeconds,
    sleep: context.sleep,
  });
  const { repo } = context;
  if (repo !== undefined) {
    try {
      await requireInstallation(context.api, config, family, token, repo);
    } catch (error) {
      if (!read || !(error instanceof MissingInstallation)) throw error;
      if (!(await isPublic(context.api, error.stage, repo, token).catch(() => false))) throw error;
      console.error(`agent-gh: ${slug(repo)} is public; reading it with the ${config.slug} App, which is not installed there.`);
    }
  }
  return use(childEnv(context.env, token, repo), config);
};

/** gh commands that only read from GitHub, whatever their flags. */
const READS = new Set([
  "pr view", "pr list", "pr diff", "pr checks", "pr status",
  "issue view", "issue list", "issue status",
  "repo view",
  "release view", "release list", "release download",
  "run view", "run list",
]);

/** gh's arguments without `-R`/`--repo` and their values, which gh also takes before a subcommand. */
const withoutRepo = (args: readonly string[]): string[] => {
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "--") return [...rest, ...args.slice(index)];
    if (arg === "-R" || arg === "--repo") index++;
    else if (!arg.startsWith("--repo=") && !arg.startsWith("-R")) rest.push(arg);
  }
  return rest;
};

/**
 * Whether gh's arguments only read: a command in READS, any `gh search`, or a
 * REST `gh api` GET. GraphQL is left out, since a query can carry a mutation.
 */
export const readOnly = (args: readonly string[]): boolean => {
  const api = apiCall(args);
  if (api !== undefined) {
    const path = api.endpoint?.replace(/^https:\/\/api\.github\.com/i, "").replace(/^\//, "").split(/[?#]/)[0];
    return api.method === "GET" && path !== undefined && path.toLowerCase() !== "graphql";
  }
  const [command, verb] = withoutRepo(args);
  return command === "search" || READS.has(`${command} ${verb}`);
};

/** Runs `gh` through the family's App and returns the child's exit code; `read` as `withToken` takes it. */
export const runAs = async (context: Context, command: readonly string[], read = false): Promise<number> =>
  withToken(context, async (env) => (await runChild(command, env)).code, read);
