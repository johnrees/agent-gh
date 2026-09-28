import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRemoteUrl } from "../src/repo.ts";
import { type GitConfig, githubRepoOf, onGitHub, parseRemoteConfig, readGitConfig, type Rewrite, sshHostname } from "../src/target.ts";

const PENMON = { owner: "johnrees", name: "penmon" };

/** A repository's remote config: `remotes` maps a name to its url (and `push` to a pushurl). */
const config = (
  remotes: Record<string, string> = {},
  { push = {}, rewrites = [], aliases = {} }: { push?: Record<string, string>; rewrites?: Rewrite[]; aliases?: Record<string, string> } = {},
): GitConfig => ({
  urls: new Map(Object.entries(remotes).map(([name, url]) => [name, [url]])),
  pushUrls: new Map(Object.entries(push).map(([name, url]) => [name, [url]])),
  rewrites,
  sshHostname: (host) => aliases[host],
  get: () => undefined,
});

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

test("a repository is on GitHub when any remote's url or pushurl reaches github.com", () => {
  expect(onGitHub(config())).toBe(false);
  expect(onGitHub(config({ origin: "/tmp/remote.git" }))).toBe(false);
  expect(onGitHub(config({ fixture: "/tmp/f.git", origin: "git@github.com:johnrees/penmon.git" }))).toBe(true);
  expect(onGitHub(config({ origin: "/tmp/mirror.git" }, { push: { origin: "https://github.com/johnrees/penmon.git" } }))).toBe(true);
});

test("a remote that an insteadOf or pushInsteadOf rule sends to github.com is GitHub's", () => {
  const shorthand = config({ origin: "gh:johnrees/penmon" }, { rewrites: [{ base: "git@github.com:", prefix: "gh:", push: false }] });
  expect(onGitHub(shorthand)).toBe(true);
  const pushOnly = config(
    { origin: "https://mirror.example/johnrees/penmon.git" },
    { rewrites: [{ base: "https://github.com/", prefix: "https://mirror.example/", push: true }] },
  );
  expect(onGitHub(pushOnly)).toBe(true);
  // git uses the longest matching prefix: here the rule sends the remote to a local path.
  const local = config(
    { fixture: "gh:johnrees/fixture" },
    {
      rewrites: [
        { base: "https://github.com/", prefix: "gh:", push: false },
        { base: "/tmp/fixture.git", prefix: "gh:johnrees/fixture", push: false },
      ],
    },
  );
  expect(onGitHub(local)).toBe(false);
});

test("an ssh Host alias for github.com is GitHub; other SSH hosts are not", () => {
  expect(githubRepoOf("github-work:johnrees/penmon.git", config({}, { aliases: { "github-work": "github.com" } }))).toEqual(PENMON);
  expect(githubRepoOf("ssh://git@gh443/johnrees/penmon.git", config({}, { aliases: { gh443: "SSH.GitHub.com" } }))).toEqual(PENMON);
  expect(onGitHub(config({ origin: "git@gitlab.com:johnrees/penmon.git" }, { aliases: { "gitlab.com": "gitlab.com" } }))).toBe(false);
  // A path with a colon after a slash is a path, not an SSH host.
  expect(githubRepoOf("./a:b/r.git", config({}, { aliases: { ".": "github.com" } }))).toBeUndefined();
});

test("ssh resolves a Host alias without connecting, and a host shaped like an option is never passed to it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gh-ssh-"));
  const file = join(dir, "config");
  writeFileSync(file, "Host github-work\n  HostName github.com\n");
  expect(sshHostname("github-work", ["-F", file])).toBe("github.com");
  expect(sshHostname("gitlab.com", ["-F", file])).toBe("gitlab.com");
  expect(sshHostname("-oProxyCommand=false", ["-F", file])).toBeUndefined();
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
