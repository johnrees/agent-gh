import { Failure } from "./failure.ts";

export type Env = Readonly<Record<string, string | undefined>>;

type Harness = {
  readonly name: string;
  readonly detect: (env: Env) => boolean;
  /** Where the harness sets the variable, so the rule can be rechecked. */
  readonly source: string;
};

const set = (value: string | undefined): boolean => value !== undefined && value !== "";

/**
 * Each harness is recognised by a variable it sets for the processes its
 * tools start. Add a harness only after finding that variable in its source.
 */
export const HARNESSES: readonly Harness[] = [
  {
    name: "claude",
    detect: (env) => env.CLAUDECODE === "1",
    source: "Claude Code sets CLAUDECODE=1 in its Bash tool's environment",
  },
  {
    name: "codex",
    detect: (env) => set(env.CODEX_THREAD_ID) || set(env.CODEX_SESSION_ID),
    source:
      "openai/codex codex-rs/protocol/src/shell_environment.rs (CODEX_THREAD_ID) and codex-rs/core/src/exec_env.rs (CODEX_SESSION_ID)",
  },
  {
    name: "pi",
    detect: (env) => set(env.PI_SESSION_ID),
    source: "pi packages/coding-agent/src/core/tools/bash.ts (PI_SESSION_ID)",
  },
  // TODO kimi: add once the variable Kimi sets for its shell tool is found in its source.
];

export const harnessNames = (): string[] => HARNESSES.map((harness) => harness.name);

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
    if (!harnessNames().includes(named as string)) {
      throw new Failure(
        "detecting the harness",
        `AGENT_GH_HARNESS names an unknown harness; use one of ${harnessNames().join(", ")}`,
      );
    }
    return named as string;
  }
  throw new Failure(
    "detecting the harness",
    "no agent harness detected; run gh yourself, agent-gh is for agent sessions",
  );
};
