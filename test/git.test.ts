import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../src/env.ts";
import { needsToken, subcommand, withTrailers } from "../src/git.ts";
import type { Identity } from "../src/harness.ts";
import { runAs } from "../src/run.ts";
import { CONFIG, credentials, fakeGitHub, HAPPY } from "./fake-github.ts";

const OPUS: Identity = { harness: "claude", family: "claude", model: "claude-opus-5-5", effort: "xhigh" };
const CODEX: Identity = { harness: "codex", family: "codex" };
const TRAILERS = ["--trailer", "Agent-Model: claude-opus-5-5", "--trailer", "Agent-Harness: claude", "--trailer", "Agent-Effort: xhigh"];

test("trailers go right after commit, past git's global options and before a pathspec", () => {
  expect(withTrailers(["commit", "-m", "x"], OPUS)).toEqual(["commit", ...TRAILERS, "-m", "x"]);
  expect(withTrailers(["-C", "/r", "-c", "a.b=c", "commit", "--amend", "--no-edit"], OPUS)).toEqual([
    "-C", "/r", "-c", "a.b=c", "commit", ...TRAILERS, "--amend", "--no-edit",
  ]);
  expect(withTrailers(["commit", "-m", "x", "--", "f"], OPUS)).toEqual(["commit", ...TRAILERS, "-m", "x", "--", "f"]);
  expect(withTrailers(["push", "origin", "main"], OPUS)).toEqual(["push", "origin", "main"]);
  expect(withTrailers(["log", "--grep", "commit"], OPUS)).toEqual(["log", "--grep", "commit"]);
});

test("only what the harness reports becomes a trailer", () => {
  expect(withTrailers(["commit", "-m", "x"], CODEX)).toEqual(["commit", "--trailer", "Agent-Harness: codex", "-m", "x"]);
});

test("local git commands need no token; anything that may reach a remote does", () => {
  for (const args of [["commit", "-m", "x"], ["-C", "/r", "rebase", "main"], ["cherry-pick", "abc"], ["status"], ["log"]]) {
    expect([args.join(" "), needsToken(args)]).toEqual([args.join(" "), false]);
  }
  for (const args of [["push"], ["fetch"], ["pull"], ["ls-remote", "x"], ["clone", "x"], ["submodule", "update"], ["remote", "update"], []]) {
    expect([args.join(" "), needsToken(args)]).toEqual([args.join(" "), true]);
  }
  expect(subcommand(["--git-dir", "/g", "--no-pager", "show"])).toBe("show");
});

/** A throwaway repository with one staged file. */
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gh-git-"));
  const git = (args: string[], identity: Identity = OPUS) =>
    Bun.spawnSync(["git", "-C", dir, ...withTrailers(args, identity)], {
      env: { ...childEnv({ PATH: process.env.PATH, HOME: dir }, undefined, { owner: "a", name: "b" }, CONFIG), GIT_CONFIG_NOSYSTEM: "1" },
    });
  Bun.spawnSync(["git", "-C", dir, "init", "-q"]);
  writeFileSync(join(dir, "f"), "a\n");
  Bun.spawnSync(["git", "-C", dir, "add", "f"]);
  const last = (format: string) =>
    Bun.spawnSync(["git", "-C", dir, "log", "-1", `--format=${format}`]).stdout.toString().trim();
  return { dir, git, last };
};

test("real commits carry the trailers and the bot as author, whatever the message form", () => {
  const { dir, git, last } = repo();
  expect(git(["commit", "-q", "-m", "first"]).exitCode).toBe(0);
  expect(last("%an <%ae>|%cn")).toBe(`johnrees-claude[bot] <123456+johnrees-claude[bot]@users.noreply.github.com>|johnrees-claude[bot]`);
  expect(last("%B")).toBe("first\n\nAgent-Model: claude-opus-5-5\nAgent-Harness: claude\nAgent-Effort: xhigh");

  writeFileSync(join(dir, "msg"), "second\n\nSigned-off-by: x <x@e>\n");
  writeFileSync(join(dir, "f"), "b\n");
  expect(git(["commit", "-q", "-a", "-F", join(dir, "msg")]).exitCode).toBe(0);
  expect(last("%B")).toBe("second\n\nSigned-off-by: x <x@e>\nAgent-Model: claude-opus-5-5\nAgent-Harness: claude\nAgent-Effort: xhigh");

  writeFileSync(join(dir, "f"), "c\n");
  expect(git(["commit", "-q", "-m", "third", "--", "f"]).exitCode).toBe(0);
  expect(last("%s")).toBe("third");
});

test("an amend replaces the agent trailers instead of stacking them", () => {
  const { git, last } = repo();
  git(["commit", "-q", "-m", "first"]);
  const other: Identity = { harness: "pi", family: "glm", model: "glm-4.6", effort: "high" };
  expect(git(["commit", "-q", "--amend", "--no-edit"], other).exitCode).toBe(0);
  expect(last("%B")).toBe("first\n\nAgent-Model: glm-4.6\nAgent-Harness: pi\nAgent-Effort: high");
});

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

test("a commit through agent-gh mints no token and makes no request", async () => {
  const fake = fakeGitHub(HAPPY);
  stops.push(fake.stop);
  const creds = credentials();
  const { dir, last } = repo();
  const code = await runAs(
    {
      identity: OPUS,
      repo: { owner: "johnrees", name: "penmon" },
      env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
      api: fake.api,
      configDir: creds.dir,
      nowSeconds: () => 1_900_000_000,
      warn: () => {},
    },
    ["git", "-C", dir, "commit", "-q", "-m", "local"],
  );
  expect(code).toBe(0);
  expect(fake.log).toEqual([]);
  expect(last("%an|%(trailers:key=Agent-Harness,valueonly)")).toBe("johnrees-claude[bot]|claude");
});
