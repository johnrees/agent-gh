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
 * A github.com remote URL in https, ssh, git, or scp form, as a remote's `url`
 * or `pushurl` holds it; hosts match in any case, and SSH also reaches GitHub
 * as ssh.github.com. A path, `OWNER/REPO` shorthand, or another host is
 * undefined: for a remote, those are not GitHub.
 */
export const parseRemoteUrl = (value: string): Repo | undefined => {
  const scp = /^(?:[^@/:]+@)?(?:ssh\.)?github\.com:([^/]+)\/([^/]+?)\/?$/i.exec(value);
  if (scp) return repo(scp[1], scp[2]);
  const url =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com|(?:ssh|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?(?:ssh\.)?github\.com|git:\/\/github\.com)(?::\d+)?\/([^/]+)\/([^/]+?)\/?$/i.exec(
      value,
    );
  if (url) return repo(url[1], url[2]);
  return undefined;
};

/**
 * `OWNER/REPO`, `github.com/OWNER/REPO`, or a github.com URL in https, ssh, or
 * scp form. Anything else, including another host, is undefined.
 */
export const parseRepo = (value: string): Repo | undefined => {
  const remote = parseRemoteUrl(value);
  if (remote) return remote;
  const parts = value.split("/");
  if (parts.length === 2) return repo(parts[0], parts[1]);
  if (parts.length === 3 && parts[0] === "github.com") return repo(parts[1], parts[2]);
  return undefined;
};

/** The value of gh's `-R`/`--repo` flag in any of its spellings, if given. */
export const repoFlag = (args: readonly string[]): string | undefined => {
  // gh takes the last of repeated flags, so the gate must check the repository gh acts on.
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "--") break;
    if (arg === "-R" || arg === "--repo") value = args[++index];
    else if (arg.startsWith("--repo=")) value = arg.slice("--repo=".length);
    else if (arg.startsWith("-R=")) value = arg.slice("-R=".length);
    else if (arg.startsWith("-R") && arg.length > 2) value = arg.slice(2);
  }
  return value;
};

/**
 * The repository a command names: gh's `-R`/`--repo`, else `GH_REPO`, else a
 * github.com `origin` remote. Undefined when none does, as for `gh api user`,
 * `gh search`, or `gh repo clone` outside a clone. A flag or `GH_REPO` that
 * names no github.com repository is refused, never passed over.
 */
export const resolveRepo = async (
  command: "gh" | "git",
  args: readonly string[],
  env: Env,
  origin: () => Promise<string | undefined>,
): Promise<Repo | undefined> => {
  const flag = command === "gh" ? repoFlag(args) : undefined;
  const [source, value] = flag !== undefined ? ["the --repo flag", flag] : env.GH_REPO ? ["GH_REPO", env.GH_REPO] : [];
  if (value === undefined) {
    const url = await origin();
    return url === undefined ? undefined : parseRemoteUrl(url);
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
