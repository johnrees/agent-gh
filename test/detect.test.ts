import { expect, test } from "bun:test";
import { childEnv } from "../src/env.ts";
import { Failure } from "../src/failure.ts";
import { familyOfHost, familyOfModel, familyOfProvider } from "../src/family.ts";
import { codexProviderOf, detectHarness, detectIdentity, type Env, inAgentSession } from "../src/harness.ts";
import { parseRepo, repoFlag, resolveRepo } from "../src/repo.ts";

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof Failure) return `${error.stage}: ${error.detail}`;
    throw error;
  }
  throw new Error("expected a Failure");
};

const CLAUDE: Env = { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" };
const noCodexConfig = () => undefined;
const identity = (env: Env, codexProvider: (env: Env) => string | undefined = noCodexConfig) =>
  detectIdentity(env, codexProvider);

test("each harness is detected by the variable it sets", () => {
  expect(detectHarness(CLAUDE)).toBe("claude");
  expect(detectHarness({ CODEX_THREAD_ID: "t" })).toBe("codex");
  expect(detectHarness({ CODEX_SESSION_ID: "s" })).toBe("codex");
  expect(detectHarness({ PI_SESSION_ID: "p" })).toBe("pi");
  expect(detectHarness({ OPENCODE_TERMINAL: "1" })).toBe("opencode");
});

test("an IDE terminal's CLAUDECODE alone is a person, not an agent", () => {
  expect(inAgentSession({ CLAUDECODE: "1" })).toBe(false);
  expect(refusal(() => detectHarness({ CLAUDECODE: "1" }))).toContain("no agent harness detected");
  expect(inAgentSession(CLAUDE)).toBe(true);
});

test("a runner that names its harness is an agent session, so its commits are credited", () => {
  expect(inAgentSession({ AGENT_GH_HARNESS: "codex" })).toBe(true);
  expect(inAgentSession({ AGENT_GH_HARNESS: "nope" })).toBe(false);
  expect(inAgentSession({ AGENT_GH_HARNESS: "" })).toBe(false);
});

test("no harness, or two, is refused", () => {
  expect(refusal(() => detectHarness({}))).toBe(
    "detecting the harness: no agent harness detected; run gh yourself, agent-gh is for agent sessions",
  );
  expect(refusal(() => detectHarness({ ...CLAUDE, CODEX_THREAD_ID: "t" }))).toContain("matches claude and codex");
  expect(refusal(() => detectHarness({ ...CLAUDE, OPENCODE_TERMINAL: "1" }))).toContain("matches claude and opencode");
});

test("AGENT_GH_HARNESS names a harness only when none is detected", () => {
  expect(detectHarness({ AGENT_GH_HARNESS: "claude" })).toBe("claude");
  expect(detectHarness({ ...CLAUDE, AGENT_GH_HARNESS: "claude" })).toBe("claude");
  expect(refusal(() => detectHarness({ ...CLAUDE, AGENT_GH_HARNESS: "codex" }))).toBe(
    "detecting the harness: AGENT_GH_HARNESS=codex cannot override the detected harness claude",
  );
  expect(refusal(() => detectHarness({ AGENT_GH_HARNESS: "copilot" }))).toContain("unknown harness");
});

test("model ids, vendors, providers, and hosts map to one family", () => {
  expect(familyOfModel("claude-opus-5-5")).toBe("claude");
  expect(familyOfModel("anthropic/claude-sonnet-5")).toBe("claude");
  expect(familyOfModel("gpt-6")).toBe("codex");
  expect(familyOfModel("o3-mini")).toBe("codex");
  expect(familyOfModel("glm-5.3")).toBe("glm");
  expect(familyOfModel("z-ai/glm-4.6")).toBe("glm");
  expect(familyOfModel("zai/glm-4.6")).toBe("glm");
  expect(familyOfModel("opencode/glm-4.6")).toBe("glm");
  expect(familyOfModel("deepseek-chat")).toBe("deepseek");
  expect(familyOfModel("openrouter/deepseek/deepseek-r2")).toBe("deepseek");
  expect(familyOfModel("kimi-k2")).toBe("kimi");
  expect(familyOfModel("qwen3-coder")).toBe("qwen");
  expect(familyOfModel("anthropic/gpt-6")).toBeUndefined();
  expect(familyOfModel("mistral-large")).toBeUndefined();
  expect(familyOfModel("opus")).toBeUndefined();
  expect(familyOfProvider("zai")).toBe("glm");
  expect(familyOfProvider("openrouter")).toBeUndefined();
  expect(familyOfHost("api.z.ai")).toBe("glm");
  expect(familyOfHost("api.deepseek.com")).toBe("deepseek");
  expect(familyOfHost("gateway.example.com")).toBeUndefined();
});

test("Claude Code is claude on Anthropic's API, with its effort when set", () => {
  expect(identity(CLAUDE)).toEqual({ harness: "claude", family: "claude" });
  expect(identity({ ...CLAUDE, CLAUDE_EFFORT: "xhigh", ANTHROPIC_MODEL: "claude-opus-5-5" })).toEqual({
    harness: "claude",
    family: "claude",
    model: "claude-opus-5-5",
    effort: "xhigh",
  });
  // An alias resolves per backend, so it is no model id.
  expect(identity({ ...CLAUDE, ANTHROPIC_MODEL: "opus" })).toEqual({ harness: "claude", family: "claude" });
});

test("Claude Code with another backend publishes as that family", () => {
  expect(identity({ ...CLAUDE, ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_MODEL: "glm-4.6" })).toEqual({
    harness: "claude",
    family: "glm",
    model: "glm-4.6",
  });
  expect(identity({ ...CLAUDE, ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic" }).family).toBe("glm");
  expect(identity({ ...CLAUDE, ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" }).family).toBe("deepseek");
  expect(
    identity({ ...CLAUDE, ANTHROPIC_BASE_URL: "https://gateway.example.com", ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-4.6" }).family,
  ).toBe("glm");
});

test("Claude Code refuses a gateway it cannot place, disagreeing settings, and a bad URL", () => {
  const gateway = refusal(() => identity({ ...CLAUDE, ANTHROPIC_BASE_URL: "https://gateway.example.com/v1?key=SECRET-7c2" }));
  expect(gateway).toContain("Claude Code talks to gateway.example.com, which serves no single model family");
  expect(gateway).not.toContain("SECRET-7c2");
  expect(refusal(() => identity({ ...CLAUDE, ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_MODEL: "deepseek-chat" }))).toContain(
    "the signals disagree (ANTHROPIC_BASE_URL: glm, ANTHROPIC_MODEL: deepseek)",
  );
  expect(refusal(() => identity({ ...CLAUDE, ANTHROPIC_MODEL: "glm-4.6" }))).toContain("ANTHROPIC_BASE_URL: claude, ANTHROPIC_MODEL: glm");
  expect(refusal(() => identity({ ...CLAUDE, ANTHROPIC_BASE_URL: "not a url SECRET-9d1" }))).toBe(
    "detecting the model: ANTHROPIC_BASE_URL is not a URL",
  );
});

test("pi reports its model, provider, and reasoning level", () => {
  expect(identity({ PI_SESSION_ID: "p", PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-chat", PI_REASONING_LEVEL: "high" })).toEqual({
    harness: "pi",
    family: "deepseek",
    model: "deepseek-chat",
    effort: "high",
  });
  expect(identity({ PI_SESSION_ID: "p", PI_PROVIDER: "openrouter", PI_MODEL: "z-ai/glm-4.6" }).family).toBe("glm");
  expect(identity({ PI_SESSION_ID: "p", PI_PROVIDER: "anthropic", PI_MODEL: "claude-opus-5-5" }).family).toBe("claude");
  expect(refusal(() => identity({ PI_SESSION_ID: "p", PI_PROVIDER: "zai", PI_MODEL: "deepseek-chat" }))).toContain("the signals disagree");
  expect(refusal(() => identity({ PI_SESSION_ID: "p", PI_PROVIDER: "local", PI_MODEL: "llama-9" }))).toBe(
    "detecting the model: pi runs local/llama-9, which no family in agent-gh's table claims",
  );
  expect(refusal(() => identity({ PI_SESSION_ID: "p" }))).toBe("detecting the model: pi did not report its model (PI_MODEL is unset)");
});

test("AGENT_GH_MODEL never overrides a model the harness reports", () => {
  expect(refusal(() => identity({ PI_SESSION_ID: "p", PI_MODEL: "glm-4.6", AGENT_GH_MODEL: "deepseek-chat" }))).toBe(
    "detecting the model: AGENT_GH_MODEL=deepseek-chat (deepseek) disagrees with the pi session's glm model",
  );
  expect(refusal(() => identity({ ...CLAUDE, AGENT_GH_MODEL: "glm-4.6" }))).toContain("disagrees with the claude session's claude model");
  expect(identity({ ...CLAUDE, AGENT_GH_MODEL: "claude-opus-5-5" })).toEqual({ harness: "claude", family: "claude", model: "claude-opus-5-5" });
});

test("Codex is the codex family on OpenAI unless its config or the session says otherwise", () => {
  expect(identity({ CODEX_THREAD_ID: "t" })).toEqual({ harness: "codex", family: "codex" });
  expect(identity({ CODEX_THREAD_ID: "t" }, () => "openai")).toEqual({ harness: "codex", family: "codex" });
  expect(refusal(() => identity({ CODEX_THREAD_ID: "t" }, () => "zai"))).toContain(
    "Codex's config uses model_provider zai, and Codex does not tell shell commands which model runs; declare it with shell_environment_policy.set.AGENT_GH_MODEL",
  );
  expect(identity({ CODEX_THREAD_ID: "t", AGENT_GH_MODEL: "glm-4.6" }, () => "zai")).toEqual({
    harness: "codex",
    family: "glm",
    model: "glm-4.6",
  });
});

test("opencode needs the model declared at launch", () => {
  expect(refusal(() => identity({ OPENCODE_TERMINAL: "1" }))).toContain("opencode does not tell shell commands which model runs");
  expect(identity({ OPENCODE_TERMINAL: "1", AGENT_GH_MODEL: "zai/glm-4.6" })).toEqual({
    harness: "opencode",
    family: "glm",
    model: "zai/glm-4.6",
  });
  expect(identity({ OPENCODE_TERMINAL: "1", AGENT_GH_MODEL: "deepseek-chat", AGENT_GH_PROVIDER: "deepseek" }).family).toBe("deepseek");
  expect(refusal(() => identity({ OPENCODE_TERMINAL: "1", AGENT_GH_MODEL: "deepseek-chat", AGENT_GH_PROVIDER: "zai" }))).toContain(
    "the signals disagree (AGENT_GH_MODEL: deepseek, AGENT_GH_PROVIDER: glm)",
  );
  expect(refusal(() => identity({ OPENCODE_TERMINAL: "1", AGENT_GH_MODEL: "llama-9" }))).toBe(
    "detecting the model: AGENT_GH_MODEL=llama-9 belongs to no family in agent-gh's table",
  );
});

test("a runner names its harness and declares its model", () => {
  expect(identity({ AGENT_GH_HARNESS: "codex" })).toEqual({ harness: "codex", family: "codex" });
  expect(identity({ AGENT_GH_HARNESS: "opencode", AGENT_GH_MODEL: "deepseek-chat" }).family).toBe("deepseek");
});

test("Codex's default provider is read from the keys that select it", () => {
  expect(codexProviderOf('model = "gpt-6"\n')).toBeUndefined();
  expect(codexProviderOf('model_provider = "zai" # glm\nmodel = "glm-4.6"\n')).toBe("zai");
  expect(codexProviderOf("model_provider = 'openai'\n")).toBe("openai");
  expect(
    codexProviderOf('profile = "glm"\n\n[profiles.glm]\nmodel_provider = "zai"\n\n[model_providers.zai]\nname = "Z.ai"\n'),
  ).toBe("zai");
  expect(codexProviderOf('[profiles.glm]\nmodel_provider = "zai"\n')).toBeUndefined();
  expect(codexProviderOf('[model_providers.zai]\nmodel_provider = "not top level"\n')).toBeUndefined();
});

test("the child environment appends to inherited git config, replaces John's token with the App's, and keeps John's author", () => {
  const parent: Env = {
    HOME: "/home/x",
    GH_DEBUG: "api",
    GH_TOKEN: "ghp_johns_own",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.editor",
    GIT_CONFIG_VALUE_0: "vi",
    GIT_CONFIG_KEY_1: "user.name",
    GIT_CONFIG_VALUE_1: "Someone",
  };
  const env = childEnv(parent, "ghu_x", { owner: "johnrees", name: "penmon" });
  expect(env.HOME).toBe("/home/x");
  expect(env.GH_DEBUG).toBeUndefined();
  expect(env.GH_TOKEN).toBe("ghu_x");
  expect(env.GIT_CONFIG_KEY_0).toBe("core.editor");
  expect(env.GIT_CONFIG_KEY_1).toBe("user.name");
  expect(env.GITHUB_TOKEN).toBe("ghu_x");
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
  expect(env.GIT_AUTHOR_NAME).toBeUndefined();
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
