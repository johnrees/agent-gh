import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRemoteUrl } from "../src/repo.ts";
import {
  type GitConfig,
  type GitRoute,
  gitCwd,
  gitRoute,
  parseRemoteConfig,
  readGitConfig,
  repositoryArg,
  type Rewrite,
  sshHostname,
} from "../src/target.ts";

const PENMON = { owner: "johnrees", name: "penmon" };
const SOLTUI = { owner: "johnrees", name: "soltui" };

/** A repository's remote config: `remotes` maps a name to its url (and `push` to a pushurl). */
const config = (
  remotes: Record<string, string> = {},
  {
    push = {},
    rewrites = [],
    aliases = {},
    branch,
    keys = {},
  }: {
    push?: Record<string, string>;
    rewrites?: Rewrite[];
    aliases?: Record<string, string>;
    branch?: string;
    keys?: Record<string, string>;
  } = {},
): GitConfig => ({
  urls: new Map(Object.entries(remotes).map(([name, url]) => [name, [url]])),
  pushUrls: new Map(Object.entries(push).map(([name, url]) => [name, [url]])),
  rewrites,
  sshHostname: (host) => aliases[host],
  branch,
  get: (key) => keys[key],
});

const github = (repo: { owner: string; name: string }): GitRoute => ({ kind: "github", repo });
const through = (reason: string): GitRoute => ({ kind: "passthrough", reason });

test("github.com remote URLs parse in every form; paths, shorthand, and other hosts do not", () => {
  for (const url of [
    "https://github.com/johnrees/penmon.git",
    "https://github.com/johnrees/penmon",
    "https://x-access-token@github.com/johnrees/penmon.git",
    "git@github.com:johnrees/penmon.git",
    "ssh://git@github.com/johnrees/penmon.git",
    "git://github.com/johnrees/penmon",
    "https://GitHub.com/johnrees/penmon.git",
    "GIT@GITHUB.COM:johnrees/penmon.git",
    "ssh://git@ssh.github.com:443/johnrees/penmon.git",
    "git+ssh://git@github.com/johnrees/penmon.git",
  ]) {
    expect([url, parseRemoteUrl(url)]).toEqual([url, PENMON]);
  }
  for (const url of ["/tmp/remote.git", "../remote.git", "file:///tmp/remote.git", "johnrees/penmon", "https://gitlab.com/johnrees/penmon.git"]) {
    expect([url, parseRemoteUrl(url)]).toEqual([url, undefined]);
  }
});

test("a local command in a repository with no github.com remote passes through; with one it goes to GitHub", () => {
  for (const args of [["commit", "-m", "x"], ["merge", "main"], ["rebase", "main"], ["cherry-pick", "abc"], ["revert", "abc"], ["am", "p"]]) {
    expect(gitRoute(args, config())).toEqual(through("no github.com remote"));
    expect(gitRoute(args, config({ origin: "/tmp/remote.git" }))).toEqual(through("no github.com remote"));
    expect(gitRoute(args, config({ fixture: "/tmp/f.git", origin: "git@github.com:johnrees/penmon.git" }))).toEqual(github(PENMON));
  }
});

test("a push follows the remote it names, else the branch's push remote, upstream, or origin", () => {
  const mixed = config(
    { origin: "https://github.com/johnrees/penmon.git", fixture: "/tmp/fixture.git", other: "https://github.com/johnrees/soltui.git" },
    { branch: "work" },
  );
  expect(gitRoute(["push", "fixture", "HEAD:main"], mixed)).toEqual(through("the remote this command uses is not on github.com"));
  expect(gitRoute(["push", "/tmp/elsewhere.git", "HEAD:main"], mixed)).toEqual(through("the remote this command uses is not on github.com"));
  expect(gitRoute(["push", "origin", "HEAD:main"], mixed)).toEqual(github(PENMON));
  expect(gitRoute(["push", "other"], mixed)).toEqual(github(SOLTUI));
  expect(gitRoute(["push"], mixed)).toEqual(github(PENMON));
  // Each subcommand's own options: `push -u` takes no value, `-o` does.
  expect(gitRoute(["push", "-u", "origin", "work"], mixed)).toEqual(github(PENMON));
  expect(gitRoute(["push", "-u", "fixture", "work"], mixed)).toEqual(through("the remote this command uses is not on github.com"));
  expect(gitRoute(["push", "-o", "ci.skip", "origin", "HEAD"], mixed)).toEqual(github(PENMON));
  expect(gitRoute(["push", "-o", "ci.skip", "fixture", "HEAD"], mixed)).toEqual(through("the remote this command uses is not on github.com"));
  expect(gitRoute(["fetch", "-u", "fixture"], mixed)).toEqual(through("the remote this command uses is not on github.com"));
  expect(gitRoute(["pull", "-s", "ours", "fixture"], mixed)).toEqual(through("the remote this command uses is not on github.com"));
  expect(gitRoute(["pull", "-s", "ours", "origin"], mixed)).toEqual(github(PENMON));
  expect(gitRoute(["push", "--repo", "fixture"], mixed)).toEqual(through("the remote this command uses is not on github.com"));
  expect(gitRoute(["push", "--repo=other"], mixed)).toEqual(github(SOLTUI));
  const upstream = config(
    { origin: "https://github.com/johnrees/penmon.git", fixture: "/tmp/fixture.git" },
    { branch: "work", keys: { "branch.work.remote": "fixture" } },
  );
  expect(gitRoute(["push"], upstream)).toEqual(through("the remote this command uses is not on github.com"));
  expect(gitRoute(["pull"], upstream)).toEqual(through("the remote this command uses is not on github.com"));
  const pushRemote = config(
    { origin: "/tmp/mirror.git", gh: "https://github.com/johnrees/penmon.git" },
    { branch: "work", keys: { "branch.work.remote": "origin", "remote.pushDefault": "gh" } },
  );
  expect(gitRoute(["push"], pushRemote)).toEqual(github(PENMON));
  expect(gitRoute(["pull"], pushRemote)).toEqual(through("the remote this command uses is not on github.com"));
  // A pushurl on GitHub makes the push GitHub's, whatever the fetch url says.
  const pushUrl = config({ origin: "/tmp/mirror.git" }, { push: { origin: "https://github.com/johnrees/penmon.git" } });
  expect(gitRoute(["push"], pushUrl)).toEqual(github(PENMON));
  expect(gitRoute(["fetch"], pushUrl)).toEqual(through("the remote this command uses is not on github.com"));
});

test("a network command whose target cannot be told goes to GitHub if the repository has a GitHub remote", () => {
  expect(gitRoute(["submodule", "update", "--remote"], config({ origin: "https://github.com/johnrees/penmon.git" }))).toEqual(
    github(PENMON),
  );
  expect(gitRoute(["submodule", "update"], config({ origin: "/tmp/r.git" }))).toEqual(through("no github.com remote"));
  // A default remote that is not configured: any GitHub remote wins, so nothing reaches GitHub as John.
  expect(gitRoute(["push"], config({ gh: "https://github.com/johnrees/penmon.git" }, { branch: "work" }))).toEqual(github(PENMON));
  expect(gitRoute(["push"], config())).toEqual(through("no github.com remote"));
  // A word that is no configured remote, path, or URL is likely a misread option value.
  const origin = config({ origin: "https://github.com/johnrees/penmon.git" });
  expect(gitRoute(["push", "--push-opt", "ci.skip", "origin"], origin)).toEqual(github(PENMON));
  expect(gitRoute(["push", "nosuchremote"], origin)).toEqual(github(PENMON));
  expect(gitRoute(["push", "nosuchremote"], config({ origin: "/tmp/r.git" }))).toEqual(through("no github.com remote"));
});

test("a remote that an insteadOf or pushInsteadOf rule sends to github.com is GitHub's", () => {
  const shorthand = config({ origin: "gh:johnrees/penmon" }, { rewrites: [{ base: "git@github.com:", prefix: "gh:", push: false }] });
  expect(gitRoute(["commit", "-m", "x"], shorthand)).toEqual(github(PENMON));
  expect(gitRoute(["push"], shorthand)).toEqual(github(PENMON));
  expect(gitRoute(["push", "gh:johnrees/soltui", "HEAD"], shorthand)).toEqual(github(SOLTUI));
  const pushOnly = config(
    { origin: "https://mirror.example/johnrees/penmon.git" },
    { rewrites: [{ base: "https://github.com/", prefix: "https://mirror.example/", push: true }] },
  );
  expect(gitRoute(["push"], pushOnly)).toEqual(github(PENMON));
  // git uses the longest matching prefix: here the rule sends one remote to a local path.
  const local = config(
    { origin: "https://github.com/johnrees/penmon.git", fixture: "gh:johnrees/fixture" },
    {
      rewrites: [
        { base: "https://github.com/", prefix: "gh:", push: false },
        { base: "/tmp/fixture.git", prefix: "gh:johnrees/fixture", push: false },
      ],
    },
  );
  expect(gitRoute(["push", "fixture"], local)).toEqual(through("the remote this command uses is not on github.com"));
  expect(gitRoute(["push", "origin"], local)).toEqual(github(PENMON));
});

test("an ssh Host alias for github.com is GitHub; other SSH hosts are not", () => {
  const aliased = config({ origin: "github-work:johnrees/penmon.git" }, { aliases: { "github-work": "github.com" } });
  expect(gitRoute(["commit", "-m", "x"], aliased)).toEqual(github(PENMON));
  expect(gitRoute(["push"], aliased)).toEqual(github(PENMON));
  const over443 = config({ origin: "ssh://git@gh443/johnrees/penmon.git" }, { aliases: { gh443: "SSH.GitHub.com" } });
  expect(gitRoute(["push"], over443)).toEqual(github(PENMON));
  const gitlab = config({ origin: "git@gitlab.com:johnrees/penmon.git" }, { aliases: { "gitlab.com": "gitlab.com" } });
  expect(gitRoute(["commit", "-m", "x"], gitlab)).toEqual(through("no github.com remote"));
  expect(gitRoute(["push"], gitlab)).toEqual(through("the remote this command uses is not on github.com"));
  // A path with a colon after a slash is a path, not an SSH host.
  expect(gitRoute(["push", "./a:b/r.git"], config({}, { aliases: { ".": "github.com" } }))).toEqual(through("the remote this command uses is not on github.com"));
});

test("ssh resolves a Host alias without connecting, and a host shaped like an option is never passed to it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gh-ssh-"));
  const file = join(dir, "config");
  writeFileSync(file, "Host github-work\n  HostName github.com\n");
  expect(sshHostname("github-work", ["-F", file])).toBe("github.com");
  expect(sshHostname("gitlab.com", ["-F", file])).toBe("gitlab.com");
  expect(sshHostname("-oProxyCommand=false", ["-F", file])).toBeUndefined();
});

test("a clone goes to GitHub only for a github.com URL", () => {
  expect(gitRoute(["clone", "https://github.com/johnrees/soltui"], config())).toEqual(github(SOLTUI));
  expect(gitRoute(["clone", "--depth", "1", "https://github.com/johnrees/soltui", "x"], config())).toEqual(github(SOLTUI));
  expect(gitRoute(["clone", "/tmp/remote.git", "x"], config({ origin: "https://github.com/johnrees/penmon.git" }))).toEqual(
    through("the remote this command uses is not on github.com"),
  );
  // `clone -s` (`--shared`) takes no value; `clone -u` (`--upload-pack`) does.
  expect(gitRoute(["clone", "-s", "https://github.com/johnrees/soltui", "x"], config())).toEqual(github(SOLTUI));
  expect(gitRoute(["clone", "-s", "../remote.git", "x"], config())).toEqual(through("the remote this command uses is not on github.com"));
  expect(gitRoute(["clone", "-u", "/opt/upload", "https://github.com/johnrees/soltui"], config())).toEqual(github(SOLTUI));
});

test("git's -C options set the directory, each relative to the one before", () => {
  expect(gitCwd(["-C", "a", "-C", "b", "commit"], "/w")).toBe("/w/a/b");
  expect(gitCwd(["-C", "/abs", "-c", "x.y=z", "push"], "/w")).toBe("/abs");
  expect(gitCwd(["push", "-C", "ignored"], "/w")).toBe("/w");
  expect(repositoryArg("push", ["-f", "--", "origin"])).toBe("origin");
});

test("git config -z --get-regexp output becomes url, pushurl, and rewrite rules; names keep dots and case", () => {
  const parsed = parseRemoteConfig(
    [
      "remote.origin.url\nhttps://github.com/johnrees/penmon.git",
      "remote.my.Fork.url\n/tmp/f.git",
      "remote.origin.pushurl\ngit@github.com:johnrees/soltui.git",
      "url.git@github.com:.insteadof\ngh:",
      "url.https://GitHub.com/.pushinsteadof\nhttps://mirror.example/",
      "",
    ].join("\0"),
  );
  expect([...parsed.urls.entries()]).toEqual([
    ["origin", ["https://github.com/johnrees/penmon.git"]],
    ["my.Fork", ["/tmp/f.git"]],
  ]);
  expect([...parsed.pushUrls.entries()]).toEqual([["origin", ["git@github.com:johnrees/soltui.git"]]]);
  expect(parsed.rewrites).toEqual([
    { base: "git@github.com:", prefix: "gh:", push: false },
    { base: "https://GitHub.com/", prefix: "https://mirror.example/", push: true },
  ]);
});

test("config git cannot read fails closed; outside a repository there are simply no remotes", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-gh-config-"));
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  expect(readGitConfig(home, env).urls.size).toBe(0);
  const broken = join(home, "broken");
  Bun.spawnSync(["git", "init", "-q", broken], { env });
  writeFileSync(join(broken, ".git", "config"), "[remote \"origin\"\n\turl = https://github.com/johnrees/penmon.git\n");
  expect(() => readGitConfig(broken, env)).toThrow("git config exited");
});
