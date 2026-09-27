import { resolve } from "node:path";
import { GIT_VALUE_OPTIONS, needsToken, subcommandIndex } from "./git.ts";
import { Failure } from "./failure.ts";
import { type Repo, parseRemoteUrl, parseRepo } from "./repo.ts";

/** A `url.<base>.insteadOf` (or `pushInsteadOf`) rule: a URL starting with `prefix` starts with `base` instead. */
export type Rewrite = { readonly base: string; readonly prefix: string; readonly push: boolean };

/**
 * What one repository's git config says about its remotes: each remote's
 * `url` and `pushurl` as written, the URL rewrite rules, and the keys the
 * default remote comes from. A directory outside a repository has none.
 */
export type GitConfig = {
  readonly urls: ReadonlyMap<string, readonly string[]>;
  readonly pushUrls: ReadonlyMap<string, readonly string[]>;
  readonly rewrites: readonly Rewrite[];
  /** The host ssh's own config sends an SSH host name to (a `Host` alias), or undefined when ssh cannot say. */
  readonly sshHostname: (host: string) => string | undefined;
  readonly get: (key: string) => string | undefined;
  readonly branch: string | undefined;
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

/** Whether any remote of the repository reaches github.com. */
export const onGitHub = (config: GitConfig): boolean => anyGitHub(config) !== undefined;

/**
 * Where a git command goes. `github`: through agent-gh, with the family App,
 * for this repository. `passthrough`: the real git, unchanged, because nothing
 * the command touches is on github.com.
 */
export type GitRoute =
  | { readonly kind: "github"; readonly repo: Repo }
  | { readonly kind: "passthrough"; readonly reason: string };

/**
 * The options each network subcommand takes with a separate value, as
 * `git <subcommand> -h` lists them (git 2.50). A short option means different
 * things to each: `push -u` is `--set-upstream`, `clone -u` is `--upload-pack`.
 */
const VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  push: new Set(["--receive-pack", "--exec", "-o", "--push-option"]),
  pull: new Set([
    "--cleanup", "-s", "--strategy", "-X", "--strategy-option", "--upload-pack", "--depth", "--shallow-since",
    "--shallow-exclude", "--deepen", "--refmap", "-o", "--server-option", "--negotiation-tip",
  ]),
  fetch: new Set([
    "--upload-pack", "-j", "--jobs", "--depth", "--shallow-since", "--shallow-exclude", "--deepen", "--refmap",
    "-o", "--server-option", "--negotiation-tip", "--filter",
  ]),
  "ls-remote": new Set(["--upload-pack", "--sort", "-o", "--server-option"]),
  clone: new Set([
    "-j", "--jobs", "--template", "--reference", "--reference-if-able", "-o", "--origin", "-b", "--branch",
    "--revision", "-u", "--upload-pack", "--depth", "--shallow-since", "--shallow-exclude", "--separate-git-dir",
    "--ref-format", "-c", "--config", "--server-option", "--filter", "--bundle-uri",
  ]),
};

/** Subcommands whose first positional argument names the remote (or URL) they use. */
const REMOTE_FIRST = new Set(["push", "pull", "fetch", "ls-remote", "clone"]);

/** The directory git works in after its `-C` options, each relative to the one before. */
export const gitCwd = (args: readonly string[], cwd: string): string => {
  const end = subcommandIndex(args) ?? args.length;
  let dir = cwd;
  for (let index = 0; index < end; index++) {
    const arg = args[index] as string;
    if (GIT_VALUE_OPTIONS.has(arg)) {
      if (arg === "-C" && args[index + 1] !== undefined) dir = resolve(dir, args[index + 1] as string);
      index++;
    }
  }
  return dir;
};

/**
 * The remote name or URL a push, pull, fetch, ls-remote, or clone names
 * explicitly: `--repo`, else its first positional argument, past options that
 * take a value. Undefined when it names none (the default remote applies).
 */
export const repositoryArg = (subcommand: string, rest: readonly string[]): string | undefined => {
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    if (arg === "--") return rest[index + 1];
    if (arg === "--repo") return rest[index + 1];
    if (arg.startsWith("--repo=")) return arg.slice("--repo=".length);
    if (VALUE_OPTIONS[subcommand]?.has(arg)) {
      index++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return REMOTE_FIRST.has(subcommand) ? arg : undefined;
  }
  return undefined;
};

/** The remote a push, pull, or fetch uses when it names none, as git chooses it. */
const defaultRemote = (subcommand: string, config: GitConfig): string => {
  const branch = config.branch;
  const fromBranch = (key: string) => (branch === undefined ? undefined : config.get(`branch.${branch}.${key}`));
  const pushed = subcommand === "push" ? (fromBranch("pushRemote") ?? config.get("remote.pushDefault")) : undefined;
  return pushed ?? fromBranch("remote") ?? "origin";
};

const urlsOf = (config: GitConfig, name: string, subcommand: string): readonly string[] => {
  const push = subcommand === "push" ? config.pushUrls.get(name) : undefined;
  return push !== undefined && push.length > 0 ? push : (config.urls.get(name) ?? []);
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

/**
 * Whether agent-gh handles a git command. A command in a repository with no
 * github.com remote, or one whose target remote is known to be elsewhere (a
 * local path, another host), is the real git's business and passes through
 * unchanged. When the target cannot be told apart, a repository with any
 * GitHub remote goes through agent-gh: passing through by mistake would reach
 * GitHub with John's own login.
 */
export const gitRoute = (args: readonly string[], config: GitConfig): GitRoute => {
  const github = anyGitHub(config);
  if (!needsToken(args)) {
    return github === undefined ? { kind: "passthrough", reason: "no github.com remote" } : { kind: "github", repo: github };
  }
  const index = subcommandIndex(args);
  const subcommand = index === undefined ? undefined : (args[index] as string);
  if (subcommand !== undefined && REMOTE_FIRST.has(subcommand)) {
    const explicit = repositoryArg(subcommand, args.slice((index as number) + 1));
    // A word that is neither a configured remote nor a path or URL is more
    // likely a misread option value than a repository in the working directory.
    const urls =
      explicit === undefined
        ? subcommand === "clone" ? [] : urlsOf(config, defaultRemote(subcommand, config), subcommand)
        : config.urls.has(explicit) ? urlsOf(config, explicit, subcommand)
        : /[/:\\]/.test(explicit) || explicit === "." || explicit === ".." ? [explicit] : [];
    if (urls.length > 0) {
      const target = urls.map((url) => githubRepoOf(url, config)).find((repo) => repo !== undefined);
      if (target !== undefined) return { kind: "github", repo: target };
      return { kind: "passthrough", reason: "the remote this command uses is not on github.com" };
    }
  }
  return github === undefined ? { kind: "passthrough", reason: "no github.com remote" } : { kind: "github", repo: github };
};

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
 * Reads a repository's remote config with the real git. `AGENT_GH_CHILD` keeps
 * agent-gh's own git shim out of the way. Config git cannot read is a failure,
 * never "no remotes": that would pass a GitHub command through.
 */
export const readGitConfig = (dir: string, env: Record<string, string | undefined>): GitConfig => {
  const plain: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) plain[name] = value;
  plain.AGENT_GH_CHILD = "1";
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
    branch: value(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    get: (key) => value(["config", "--get", key]),
  };
};
