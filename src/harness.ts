import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Failure } from "./failure.ts";
import { familyNames, familyOfHost, familyOfModel, familyOfProvider } from "./family.ts";

export type Env = Readonly<Record<string, string | undefined>>;

type Harness = {
  readonly name: string;
  readonly detect: (env: Env) => boolean;
  /** Where the harness sets the variable, so the rule can be rechecked. */
  readonly source: string;
};

const set = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

/**
 * Each harness is recognised by a variable it sets for the processes its
 * tools start. Add a harness only after finding that variable in its source.
 */
export const HARNESSES: readonly Harness[] = [
  {
    name: "claude",
    // IDE extensions also set CLAUDECODE=1 in their integrated terminals, so
    // a person typing there is not an agent: CLAUDE_CODE_CHILD_SESSION marks a
    // process a tool call or hook started (code.claude.com/docs/en/env-vars).
    detect: (env) => env.CLAUDECODE === "1" && set(env.CLAUDE_CODE_CHILD_SESSION),
    source: "Claude Code: CLAUDECODE=1 and CLAUDE_CODE_CHILD_SESSION in tool and hook subprocesses",
  },
  {
    name: "codex",
    detect: (env) => set(env.CODEX_THREAD_ID) || set(env.CODEX_SESSION_ID),
    source:
      "openai/codex codex-rs/protocol/src/shell_environment.rs:7,152 (CODEX_THREAD_ID) and codex-rs/core/src/exec_env.rs:42 (CODEX_SESSION_ID)",
  },
  {
    name: "pi",
    detect: (env) => set(env.PI_SESSION_ID),
    source: "pi packages/coding-agent/src/core/tools/bash.ts:180 (PI_SESSION_ID, with PI_MODEL and PI_PROVIDER)",
  },
  {
    name: "opencode",
    detect: (env) => env.OPENCODE_TERMINAL === "1",
    source: "opencode 2.0.16: its shell and PTY environments set OPENCODE_TERMINAL=1",
  },
  // TODO kimi: add once the variable Kimi's CLI sets for its shell tool is found in its source.
];

export const harnessNames = (): string[] => HARNESSES.map((harness) => harness.name);

/** True inside any agent harness's tool process: setup refuses there. */
export const inAgentSession = (env: Env): boolean => HARNESSES.some((harness) => harness.detect(env));

/**
 * The harness this process runs under. `AGENT_GH_HARNESS` names one only when
 * no harness variable is present (a runner you control), never to override a
 * detected harness.
 */
export const detectHarness = (env: Env): string => {
  const matched = HARNESSES.filter((harness) => harness.detect(env)).map((harness) => harness.name);
  const named = env.AGENT_GH_HARNESS;
  if (matched.length > 1) {
    throw new Failure(
      "detecting the harness",
      `the environment matches ${matched.join(" and ")}, as when one harness runs inside another; run the command from a single harness`,
    );
  }
  const [detected] = matched;
  if (detected !== undefined) {
    if (set(named) && named !== detected) {
      throw new Failure(
        "detecting the harness",
        `AGENT_GH_HARNESS=${named} cannot override the detected harness ${detected}`,
      );
    }
    return detected;
  }
  if (set(named)) {
    if (!harnessNames().includes(named)) {
      throw new Failure(
        "detecting the harness",
        `AGENT_GH_HARNESS names an unknown harness; use one of ${harnessNames().join(", ")}`,
      );
    }
    return named;
  }
  throw new Failure(
    "detecting the harness",
    "no agent harness detected; run gh yourself, agent-gh is for agent sessions",
  );
};

/** Who is acting: the harness, the family whose bot publishes, and what the harness says of its model. */
export type Identity = {
  readonly harness: string;
  readonly family: string;
  /** The model id, only when the harness reports it or the session declares it. */
  readonly model?: string;
  /** The reasoning effort, only when the harness exposes it. */
  readonly effort?: string;
};

/** Reads Codex's default model provider from config.toml, if it names one. */
export type CodexProvider = (env: Env) => string | undefined;

const refuse = (detail: string): never => {
  throw new Failure("detecting the model", detail);
};

/** Claude Code's model aliases resolve per backend, so they name no family. */
const ALIASES = new Set(["default", "best", "opus", "sonnet", "haiku", "opusplan", "opus[1m]", "sonnet[1m]"]);
const concrete = (model: string | undefined): model is string => set(model) && !ALIASES.has(model.trim().toLowerCase());

const CLAUDE_MODEL_VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

/** One answer from several signals, or a refusal naming them when they disagree. */
const agree = (signals: readonly (readonly [string, string | undefined])[]): string | undefined => {
  const known = signals.filter((signal): signal is readonly [string, string] => signal[1] !== undefined);
  if (new Set(known.map(([, family]) => family)).size > 1) {
    refuse(
      `the signals disagree (${known.map(([source, family]) => `${source}: ${family}`).join(", ")}); fix the session's model settings`,
    );
  }
  return known[0]?.[1];
};

const claude = (env: Env): Identity => {
  const base = env.ANTHROPIC_BASE_URL;
  let host: string | undefined;
  if (set(base)) {
    try {
      host = new URL(base.trim()).hostname;
    } catch {
      refuse("ANTHROPIC_BASE_URL is not a URL");
    }
  }
  const signals: [string, string | undefined][] = [
    ["ANTHROPIC_BASE_URL", host === undefined ? "claude" : familyOfHost(host)],
  ];
  for (const name of CLAUDE_MODEL_VARS) {
    const value = env[name];
    if (concrete(value)) signals.push([name, familyOfModel(value)]);
  }
  const family = agree(signals);
  if (family === undefined) {
    return refuse(
      `Claude Code talks to ${host}, which serves no single model family; set ANTHROPIC_MODEL to a model id of one of ${familyNames().join(", ")}`,
    );
  }
  const model = env.ANTHROPIC_MODEL;
  return {
    harness: "claude",
    family,
    ...(concrete(model) ? { model: model.trim() } : {}),
    ...(set(env.CLAUDE_EFFORT) ? { effort: env.CLAUDE_EFFORT.trim() } : {}),
  };
};

const pi = (env: Env): Identity => {
  const model = env.PI_MODEL;
  const provider = env.PI_PROVIDER;
  const family = agree([
    ["PI_MODEL", set(model) ? familyOfModel(model) : undefined],
    ["PI_PROVIDER", set(provider) ? familyOfProvider(provider) : undefined],
  ]);
  if (family === undefined) {
    return refuse(
      set(model)
        ? `pi runs ${set(provider) ? `${provider.trim()}/` : ""}${model.trim()}, which no family in agent-gh's table claims`
        : "pi did not report its model (PI_MODEL is unset)",
    );
  }
  return {
    harness: "pi",
    family,
    ...(set(model) ? { model: model.trim() } : {}),
    ...(set(env.PI_REASONING_LEVEL) ? { effort: env.PI_REASONING_LEVEL.trim() } : {}),
  };
};

/** A model the session declares with AGENT_GH_MODEL (and optionally AGENT_GH_PROVIDER). */
const declared = (env: Env): { model: string; family: string } | undefined => {
  const model = env.AGENT_GH_MODEL;
  if (!set(model)) return undefined;
  const family = agree([
    ["AGENT_GH_MODEL", familyOfModel(model)],
    ["AGENT_GH_PROVIDER", set(env.AGENT_GH_PROVIDER) ? familyOfProvider(env.AGENT_GH_PROVIDER) : undefined],
  ]);
  if (family === undefined) return refuse(`AGENT_GH_MODEL=${model.trim()} belongs to no family in agent-gh's table`);
  return { model: model.trim(), family };
};

const codex = (env: Env, codexProvider: CodexProvider): Identity => {
  const session = declared(env);
  if (session !== undefined) return { harness: "codex", ...session };
  const provider = codexProvider(env);
  if (provider !== undefined && provider !== "openai") {
    return refuse(
      `Codex's config uses model_provider ${provider}, and Codex does not tell shell commands which model runs; declare it with shell_environment_policy.set.AGENT_GH_MODEL in that config`,
    );
  }
  return { harness: "codex", family: "codex" };
};

const declaredOnly = (harness: string, env: Env, hint: string): Identity => {
  const session = declared(env);
  return session === undefined ? refuse(hint) : { harness, ...session };
};

/**
 * The identity this process acts as. Each harness reports its model in its
 * own way; agent-gh never guesses. `AGENT_GH_MODEL` is how a session declares
 * the model where the harness reports none (opencode, Codex with another
 * provider, a runner); where the harness does report one, it must agree.
 */
export const detectIdentity = (env: Env, codexProvider: CodexProvider = readCodexProvider): Identity => {
  const harness = detectHarness(env);
  if (harness === "codex") return codex(env, codexProvider);
  if (harness === "opencode") {
    return declaredOnly(
      harness,
      env,
      "opencode does not tell shell commands which model runs; start it with the model declared, e.g. `AGENT_GH_MODEL=zai/glm-4.6 opencode --standalone` (see the agent-gh README)",
    );
  }
  if (harness !== "claude" && harness !== "pi") {
    return declaredOnly(harness, env, `set AGENT_GH_MODEL to the model this ${harness} runner drives`);
  }
  const identity = harness === "claude" ? claude(env) : pi(env);
  const session = declared(env);
  if (session !== undefined && session.family !== identity.family) {
    return refuse(
      `AGENT_GH_MODEL=${session.model} (${session.family}) disagrees with the ${harness} session's ${identity.family} model`,
    );
  }
  return identity.model === undefined && session !== undefined ? { ...identity, model: session.model } : identity;
};

/**
 * Codex's default `model_provider` from `$CODEX_HOME/config.toml` (default
 * ~/.codex): the top-level key, or the selected top-level `profile`'s. A
 * profile chosen with `--profile` at launch is invisible here; declare its
 * model with shell_environment_policy.set.AGENT_GH_MODEL in that profile.
 */
export const readCodexProvider: CodexProvider = (env) => {
  const path = join(set(env.CODEX_HOME) ? env.CODEX_HOME : join(homedir(), ".codex"), "config.toml");
  try {
    return codexProviderOf(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const unquote = (value: string): string | undefined => {
  const match = /^(?:"([^"]*)"|'([^']*)')/.exec(value.trim());
  return match === null ? undefined : (match[1] ?? match[2]);
};

/** The provider a Codex config.toml selects by default, reading only the keys that matter. */
export const codexProviderOf = (text: string): string | undefined => {
  let table = "";
  let provider: string | undefined;
  let profile: string | undefined;
  const profiles = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[\s*([^\]]+?)\s*\]/.exec(line);
    if (header !== null) {
      table = (header[1] ?? "").replace(/"/g, "");
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (pair === null) continue;
    const key = pair[1] ?? "";
    const value = unquote(pair[2] ?? "");
    if (value === undefined) continue;
    if (table === "" && key === "model_provider") provider = value;
    else if (table === "" && key === "profile") profile = value;
    else if (table.startsWith("profiles.") && key === "model_provider") profiles.set(table.slice("profiles.".length), value);
  }
  return (profile === undefined ? undefined : profiles.get(profile)) ?? provider;
};
