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
const CO_AUTHOR = "Co-authored-by: johnrees-claude[bot] <123456+johnrees-claude[bot]@users.noreply.github.com>";
const GLM_APP = { slug: "johnrees-glm", bot_user_id: 999 };
const GLM_CO_AUTHOR = "Co-authored-by: johnrees-glm[bot] <999+johnrees-glm[bot]@users.noreply.github.com>";
const TRAILERS = [
  "--trailer", "Agent-Model: claude-opus-5-5",
  "--trailer", "Agent-Harness: claude",
  "--trailer", "Agent-Effort: xhigh",
  "--trailer", CO_AUTHOR,
];

test("trailers go right after commit, past git's global options and before a pathspec", () => {
  expect(withTrailers(["commit", "-m", "x"], OPUS, CONFIG)).toEqual(["commit", ...TRAILERS, "-m", "x"]);
  expect(withTrailers(["-C", "/r", "-c", "a.b=c", "commit", "--amend", "--no-edit"], OPUS, CONFIG)).toEqual([
    "-C", "/r", "-c", "a.b=c", "commit", ...TRAILERS, "--amend", "--no-edit",
  ]);
  expect(withTrailers(["commit", "-m", "x", "--", "f"], OPUS, CONFIG)).toEqual(["commit", ...TRAILERS, "-m", "x", "--", "f"]);
  expect(withTrailers(["push", "origin", "main"], OPUS, CONFIG)).toEqual(["push", "origin", "main"]);
  expect(withTrailers(["log", "--grep", "commit"], OPUS, CONFIG)).toEqual(["log", "--grep", "commit"]);
});

test("only what the harness reports becomes an agent trailer; the App is always the co-author", () => {
  expect(withTrailers(["commit", "-m", "x"], CODEX, CONFIG)).toEqual([
    "commit", "--trailer", "Agent-Harness: codex", "--trailer", CO_AUTHOR, "-m", "x",
  ]);
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

/** A throwaway repository, owned by "John Rees", with one staged file. */
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gh-git-"));
  const env = { ...childEnv({ PATH: process.env.PATH, HOME: dir }, undefined, { owner: "a", name: "b" }), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args: string[], identity: Identity = OPUS, app: { slug: string; bot_user_id: number } = CONFIG) =>
    Bun.spawnSync(["git", "-C", dir, ...withTrailers(args, identity, app)], { env });
  Bun.spawnSync(["git", "-C", dir, "init", "-q"]);
  Bun.spawnSync(["git", "-C", dir, "config", "user.name", "John Rees"]);
  Bun.spawnSync(["git", "-C", dir, "config", "user.email", "john@example.com"]);
  writeFileSync(join(dir, "f"), "a\n");
  Bun.spawnSync(["git", "-C", dir, "add", "f"]);
  const last = (format: string) =>
    Bun.spawnSync(["git", "-C", dir, "log", "-1", `--format=${format}`]).stdout.toString().trim();
  return { dir, git, last };
};

test("real commits keep John as author and committer, and credit the App, whatever the message form", () => {
  const { dir, git, last } = repo();
  expect(git(["commit", "-q", "-m", "first"]).exitCode).toBe(0);
  expect(last("%an <%ae>|%cn")).toBe("John Rees <john@example.com>|John Rees");
  expect(last("%B")).toBe(`first\n\nAgent-Model: claude-opus-5-5\nAgent-Harness: claude\nAgent-Effort: xhigh\n${CO_AUTHOR}`);

  writeFileSync(join(dir, "msg"), "second\n\nSigned-off-by: x <x@e>\n");
  writeFileSync(join(dir, "f"), "b\n");
  expect(git(["commit", "-q", "-a", "-F", join(dir, "msg")]).exitCode).toBe(0);
  expect(last("%B")).toBe(
    `second\n\nSigned-off-by: x <x@e>\nAgent-Model: claude-opus-5-5\nAgent-Harness: claude\nAgent-Effort: xhigh\n${CO_AUTHOR}`,
  );

  writeFileSync(join(dir, "f"), "c\n");
  expect(git(["commit", "-q", "-m", "third", "--", "f"]).exitCode).toBe(0);
  expect(last("%s")).toBe("third");
});

test("an amend replaces the agent trailers, credits the App once, and keeps other co-authors", () => {
  const { dir, git, last } = repo();
  writeFileSync(join(dir, "msg"), "first\n\nCo-authored-by: Ada <ada@example.com>\n");
  git(["commit", "-q", "-F", join(dir, "msg")]);
  expect(git(["commit", "-q", "--amend", "--no-edit"]).exitCode).toBe(0);
  // git files a trailer next to an existing one with the same key.
  expect(last("%B")).toBe(
    `first\n\nCo-authored-by: Ada <ada@example.com>\n${CO_AUTHOR}\nAgent-Model: claude-opus-5-5\nAgent-Harness: claude\nAgent-Effort: xhigh`,
  );
  const glm: Identity = { harness: "pi", family: "glm", model: "glm-4.6", effort: "high" };
  expect(git(["commit", "-q", "--amend", "--no-edit"], glm, GLM_APP).exitCode).toBe(0);
  const body = last("%B");
  expect(body).toContain("Agent-Model: glm-4.6\n");
  expect(body).not.toContain("claude-opus-5-5");
  expect(body.split("\n").filter((line) => line.startsWith("Co-authored-by:"))).toEqual([
    "Co-authored-by: Ada <ada@example.com>",
    CO_AUTHOR,
    GLM_CO_AUTHOR,
  ]);
});

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

test("a commit through agent-gh needs no login and makes no request", async () => {
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
      registry: {},
      nowSeconds: () => 1_900_000_000,
      sleep: async () => {},
    },
    ["git", "-C", dir, "commit", "-q", "-m", "local"],
  );
  expect(code).toBe(0);
  expect(fake.log).toEqual([]);
  expect(last("%an")).toBe("John Rees");
  expect(last("%(trailers:key=Agent-Harness,valueonly)")).toBe("claude");
  expect(last("%(trailers:key=Co-authored-by,valueonly)")).toBe("johnrees-claude[bot] <123456+johnrees-claude[bot]@users.noreply.github.com>");
});
