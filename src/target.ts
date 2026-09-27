import { Failure } from "./failure.ts";
import { type Repo, parseRemoteUrl, parseRepo } from "./repo.ts";

/** A `url.<base>.insteadOf` (or `pushInsteadOf`) rule: a URL starting with `prefix` starts with `base` instead. */
export type Rewrite = { readonly base: string; readonly prefix: string; readonly push: boolean };

/**
 * What one repository's git config says about its remotes: each remote's
 * `url` and `pushurl` as written, the URL rewrite rules, and any other key.
 * A directory outside a repository has no remotes.
 */
export type GitConfig = {
  readonly urls: ReadonlyMap<string, readonly string[]>;
  readonly pushUrls: ReadonlyMap<string, readonly string[]>;
  readonly rewrites: readonly Rewrite[];
  /** The host ssh's own config sends an SSH host name to (a `Host` alias), or undefined when ssh cannot say. */
  readonly sshHostname: (host: string) => string | undefined;
  readonly get: (key: string) => string | undefined;
};

/** A URL rewritten by the longest matching rule of one kind, as git does, or undefined when none matches. */
const rewrite = (url: string, rules: readonly Rewrite[], push: boolean): string | undefined => {
  let best: Rewrite | undefined;
  for (const rule of rules) {
    if (rule.push === push && url.startsWith(rule.prefix) && (best === undefined || rule.prefix.length > best.prefix.length)) {
      best = rule;
    }
  }
  return best === undefined ? undefined : best.base + url.slice(best.prefix.length);
};

/** The host and path of an SSH URL: `ssh://[user@]host[:port]/path`, or git's scp-like `[user@]host:path`. */
const sshUrl = (url: string): { host: string; path: string } | undefined => {
  const ssh = /^(?:ssh|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(url);
  if (ssh) return { host: ssh[1] as string, path: ssh[2] as string };
  // scp-like: no scheme, and a colon before any slash.
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.*)$/.exec(url);
  return scp && !url.includes("://") ? { host: scp[1] as string, path: scp[2] as string } : undefined;
};

const GITHUB_SSH_HOSTS = new Set(["github.com", "ssh.github.com"]);

/**
 * The github.com repository a remote URL reaches: as written, as an
 * `insteadOf` or `pushInsteadOf` rule rewrites it (`gh:owner/repo`, say), or
 * through an ssh `Host` alias (`github-work:owner/repo`). Any of them on
 * github.com counts, so neither a rewrite nor an alias hides GitHub.
 */
export const githubRepoOf = (url: string, config: GitConfig): Repo | undefined => {
  for (const candidate of [url, rewrite(url, config.rewrites, false), rewrite(url, config.rewrites, true)]) {
    if (candidate === undefined) continue;
    const repo = parseRemoteUrl(candidate);
    if (repo !== undefined) return repo;
    const ssh = sshUrl(candidate);
    if (ssh === undefined) continue;
    const host = (config.sshHostname(ssh.host) ?? ssh.host).toLowerCase();
    const aliased = GITHUB_SSH_HOSTS.has(host) ? parseRepo(ssh.path.replace(/^\/+/, "")) : undefined;
    if (aliased !== undefined) return aliased;
  }
  return undefined;
};

/**
 * The HostName ssh's config gives `host`, from `ssh -G`, which prints the
 * resolved config without connecting. Undefined when ssh cannot say, or for a
 * host git itself would refuse as an option.
 */
export const sshHostname = (host: string, options: readonly string[] = []): string | undefined => {
  if (host.startsWith("-")) return undefined;
  try {
    const result = Bun.spawnSync(["ssh", ...options, "-G", "--", host], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return undefined;
    return /^hostname (\S+)$/m.exec(result.stdout.toString())?.[1];
  } catch {
    return undefined;
  }
};

/** The repository's GitHub remote, `origin` first, if any remote is on github.com. */
const anyGitHub = (config: GitConfig): Repo | undefined => {
  const names = [...config.urls.keys()].sort((a, b) => (a === "origin" ? -1 : b === "origin" ? 1 : 0));
  for (const name of names) {
    for (const url of [...(config.pushUrls.get(name) ?? []), ...(config.urls.get(name) ?? [])]) {
      const repo = githubRepoOf(url, config);
      if (repo !== undefined) return repo;
    }
  }
  return undefined;
};

/** Whether any remote of the repository reaches github.com. */
export const onGitHub = (config: GitConfig): boolean => anyGitHub(config) !== undefined;

/**
 * Parses `git config -z --get-regexp` output (each entry `key\nvalue\0`) for
 * remote URLs and URL rewrite rules. git lowercases the variable names, never
 * the remote name or the rule's base.
 */
export const parseRemoteConfig = (
  text: string,
): { urls: Map<string, string[]>; pushUrls: Map<string, string[]>; rewrites: Rewrite[] } => {
  const urls = new Map<string, string[]>();
  const pushUrls = new Map<string, string[]>();
  const rewrites: Rewrite[] = [];
  for (const entry of text.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline === -1) continue;
    const key = entry.slice(0, newline);
    const value = entry.slice(newline + 1);
    const remote = /^remote\.(.+)\.(url|pushurl)$/.exec(key);
    if (remote) {
      const [, name, kind] = remote as unknown as [string, string, string];
      const map = kind === "url" ? urls : pushUrls;
      map.set(name, [...(map.get(name) ?? []), value]);
      continue;
    }
    const rule = /^url\.(.+)\.(insteadof|pushinsteadof)$/.exec(key);
    if (rule) rewrites.push({ base: rule[1] as string, prefix: value, push: rule[2] === "pushinsteadof" });
  }
  for (const name of pushUrls.keys()) if (!urls.has(name)) urls.set(name, []);
  return { urls, pushUrls, rewrites };
};

/**
 * Reads a repository's remote config with git. Config git cannot read is a
 * failure, never "no remotes": that would pass a GitHub repository over.
 */
export const readGitConfig = (dir: string, env: Record<string, string | undefined>): GitConfig => {
  const plain: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) plain[name] = value;
  const git = (args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, ...args], { env: plain, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const remotes = git(["config", "-z", "--get-regexp", "^(remote\\..*\\.(url|pushurl)|url\\..*\\.(insteadof|pushinsteadof))$"]);
  // Exit 1 is git's "no such key"; anything else means the config was not read.
  if (remotes.exitCode !== 0 && remotes.exitCode !== 1) {
    throw new Failure("resolving the repository", `git config exited ${remotes.exitCode} in ${dir}`);
  }
  const { urls, pushUrls, rewrites } = parseRemoteConfig(remotes.exitCode === 0 ? remotes.stdout.toString() : "");
  const value = (args: string[]) => {
    const result = git(args);
    return result.exitCode === 0 ? result.stdout.toString().trim() || undefined : undefined;
  };
  const hosts = new Map<string, string | undefined>();
  return {
    urls,
    pushUrls,
    rewrites,
    sshHostname: (host) => {
      if (!hosts.has(host)) hosts.set(host, sshHostname(host));
      return hosts.get(host);
    },
    get: (key) => value(["config", "--get", key]),
  };
};
