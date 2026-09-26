import { Failure } from "./failure.ts";
import type { Env } from "./harness.ts";

export type Repo = { readonly owner: string; readonly name: string };

export const slug = (repo: Repo): string => `${repo.owner}/${repo.name}`;

const NAME = /^[A-Za-z0-9_.-]+$/;

const repo = (owner: string | undefined, name: string | undefined): Repo | undefined => {
  const bare = name?.replace(/\.git$/, "");
  return owner !== undefined && bare !== undefined && NAME.test(owner) && NAME.test(bare)
    ? { owner, name: bare }
    : undefined;
};

/**
 * `OWNER/REPO`, `github.com/OWNER/REPO`, or a github.com URL in https, ssh, or
 * scp form. Anything else, including another host, is undefined.
 */
export const parseRepo = (value: string): Repo | undefined => {
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)\/?$/.exec(value);
  if (scp) return repo(scp[1], scp[2]);
  const url = /^(?:https:\/\/|ssh:\/\/git@|git:\/\/)github\.com\/([^/]+)\/([^/]+?)\/?$/.exec(value);
  if (url) return repo(url[1], url[2]);
  const parts = value.split("/");
  if (parts.length === 2) return repo(parts[0], parts[1]);
  if (parts.length === 3 && parts[0] === "github.com") return repo(parts[1], parts[2]);
  return undefined;
};

/** The value of gh's `-R`/`--repo` flag in any of its spellings, if given. */
export const repoFlag = (args: readonly string[]): string | undefined => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "--") return undefined;
    if (arg === "-R" || arg === "--repo") return args[index + 1];
    if (arg.startsWith("--repo=")) return arg.slice("--repo=".length);
    if (arg.startsWith("-R=")) return arg.slice("-R=".length);
    if (arg.startsWith("-R") && arg.length > 2) return arg.slice(2);
  }
  return undefined;
};

/**
 * The one repository a command's token is minted for: gh's `-R`/`--repo`, else
 * `GH_REPO`, else the `origin` remote.
 */
export const resolveRepo = async (
  command: "gh" | "git",
  args: readonly string[],
  env: Env,
  origin: () => Promise<string | undefined>,
): Promise<Repo> => {
  const [source, value] =
    command === "gh" && repoFlag(args) !== undefined
      ? ["the --repo flag", repoFlag(args)]
      : env.GH_REPO
        ? ["GH_REPO", env.GH_REPO]
        : ["the origin remote", await origin()];
  if (value === undefined) {
    throw new Failure(
      "resolving the repository",
      "no --repo flag, no GH_REPO, and no origin remote; run inside a clone of the repository or pass --repo OWNER/REPO",
    );
  }
  const parsed = parseRepo(value);
  if (parsed === undefined) {
    throw new Failure(
      "resolving the repository",
      `${source} does not name a github.com repository as OWNER/REPO`,
    );
  }
  return parsed;
};

/** `git remote get-url origin` in `cwd`, or undefined outside a clone. */
export const originUrl = async (cwd: string): Promise<string | undefined> => {
  const child = Bun.spawn(["git", "remote", "get-url", "origin"], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return code === 0 ? text.trim() : undefined;
};
