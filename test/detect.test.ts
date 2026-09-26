import { expect, test } from "bun:test";
import { childEnv } from "../src/env.ts";
import { Failure } from "../src/failure.ts";
import { detectHarness, type Env } from "../src/harness.ts";
import { parseRepo, repoFlag, resolveRepo } from "../src/repo.ts";
import { CONFIG } from "./fake-github.ts";

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof Failure) return `${error.stage}: ${error.detail}`;
    throw error;
  }
  throw new Error("expected a Failure");
};

test("each harness is detected by the variable it sets", () => {
  expect(detectHarness({ CLAUDECODE: "1" })).toBe("claude");
  expect(detectHarness({ CODEX_THREAD_ID: "t" })).toBe("codex");
  expect(detectHarness({ CODEX_SESSION_ID: "s" })).toBe("codex");
  expect(detectHarness({ PI_SESSION_ID: "p" })).toBe("pi");
  expect(detectHarness({ CLAUDECODE: "0", CODEX_THREAD_ID: "" , AGENT_GH_HARNESS: "codex" })).toBe("codex");
});

test("no harness, or two, is refused", () => {
  expect(refusal(() => detectHarness({}))).toBe(
    "detecting the harness: no agent harness detected; run gh yourself, agent-gh is for agent sessions",
  );
  expect(refusal(() => detectHarness({ CLAUDECODE: "1", CODEX_THREAD_ID: "t" }))).toContain("matches claude and codex");
});

test("AGENT_GH_HARNESS names a harness only when none is detected", () => {
  expect(detectHarness({ AGENT_GH_HARNESS: "claude" })).toBe("claude");
  expect(detectHarness({ CLAUDECODE: "1", AGENT_GH_HARNESS: "claude" })).toBe("claude");
  expect(refusal(() => detectHarness({ CLAUDECODE: "1", AGENT_GH_HARNESS: "codex" }))).toBe(
    "detecting the harness: AGENT_GH_HARNESS=codex cannot override the detected harness claude",
  );
  expect(refusal(() => detectHarness({ AGENT_GH_HARNESS: "copilot" }))).toContain("unknown harness");
});

test("repositories parse from every form gh and git use", () => {
  const penmon = { owner: "johnrees", name: "penmon" };
  for (const value of [
    "johnrees/penmon",
    "github.com/johnrees/penmon",
    "https://github.com/johnrees/penmon",
    "https://github.com/johnrees/penmon.git",
    "git@github.com:johnrees/penmon.git",
    "ssh://git@github.com/johnrees/penmon.git",
  ]) {
    expect(parseRepo(value)).toEqual(penmon);
  }
  for (const value of ["gitlab.com/johnrees/penmon", "https://gitlab.com/a/b", "penmon", "a/b/c/d", "a b/c"]) {
    expect(parseRepo(value)).toBeUndefined();
  }
});

test("gh's repo flag is found in every spelling", () => {
  expect(repoFlag(["pr", "view", "-R", "a/b"])).toBe("a/b");
  expect(repoFlag(["pr", "view", "-Ra/b"])).toBe("a/b");
  expect(repoFlag(["pr", "view", "-R=a/b"])).toBe("a/b");
  expect(repoFlag(["pr", "view", "--repo", "a/b"])).toBe("a/b");
  expect(repoFlag(["pr", "view", "--repo=a/b"])).toBe("a/b");
  expect(repoFlag(["pr", "create", "--", "-R", "a/b"])).toBeUndefined();
});

test("the repository comes from the flag, then GH_REPO, then origin", async () => {
  const origin = async () => "git@github.com:johnrees/soltui.git";
  expect(await resolveRepo("gh", ["pr", "view", "-R", "a/flag"], { GH_REPO: "a/env" }, origin)).toEqual({ owner: "a", name: "flag" });
  expect(await resolveRepo("gh", ["pr", "view"], { GH_REPO: "a/env" }, origin)).toEqual({ owner: "a", name: "env" });
  expect(await resolveRepo("gh", ["pr", "view"], {}, origin)).toEqual({ owner: "johnrees", name: "soltui" });
  expect(await resolveRepo("git", ["push", "-R", "a/flag"], {}, origin)).toEqual({ owner: "johnrees", name: "soltui" });
  const failed = await resolveRepo("gh", ["pr", "view"], {}, async () => undefined).catch((error: Failure) => error.detail);
  expect(failed).toContain("no --repo flag, no GH_REPO, and no origin remote");
  const other = await resolveRepo("gh", ["pr", "view"], { GH_REPO: "gitlab.com/a/b" }, origin).catch((error: Failure) => error.detail);
  expect(other).toBe("GH_REPO does not name a github.com repository as OWNER/REPO");
});

test("the child environment appends to inherited git config", () => {
  const parent: Env = {
    HOME: "/home/x",
    GH_DEBUG: "api",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.editor",
    GIT_CONFIG_VALUE_0: "vi",
    GIT_CONFIG_KEY_1: "user.name",
    GIT_CONFIG_VALUE_1: "Someone",
  };
  const env = childEnv(parent, "ghs_x", { owner: "johnrees", name: "penmon" }, CONFIG);
  expect(env.HOME).toBe("/home/x");
  expect(env.GH_DEBUG).toBeUndefined();
  expect(env.GIT_CONFIG_KEY_0).toBe("core.editor");
  expect(env.GIT_CONFIG_KEY_1).toBe("user.name");
  expect(env.GIT_CONFIG_COUNT).toBe("6");
  expect([2, 3, 4, 5].map((n) => [env[`GIT_CONFIG_KEY_${n}`], env[`GIT_CONFIG_VALUE_${n}`]])).toEqual([
    ["credential.helper", ""],
    ["credential.https://github.com.helper", "!gh auth git-credential"],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ]);
  expect(env.GIT_SSH_COMMAND).toContain("exit 1");
  expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  expect(env.GH_PROMPT_DISABLED).toBe("1");
  expect(env.GH_HOST).toBe("github.com");
  expect(childEnv({}, "t", { owner: "a", name: "b" }, CONFIG).GIT_CONFIG_COUNT).toBe("4");
});
