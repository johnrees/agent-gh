import { readFileSync } from "node:fs";
import { readConfig, type Registry } from "./config.ts";
import { NEXT_STEP } from "./failure.ts";
import { trailerArgs } from "./git.ts";
import { detectIdentity, type Env, inAgentSession } from "./harness.ts";
import { type GitConfig, onGitHub } from "./target.ts";

export const UPDATE =
  "rerun the install line (curl -fsSL https://raw.githubusercontent.com/johnrees/agent-gh/main/install.sh | bash, with `-s -- --agent-machine` on an agent machine)";

export type Verdict = { readonly code: 0 | 1 | 2; readonly message?: string };

const PASS: Verdict = { code: 0 };

const unknown = (what: string): Verdict => ({
  code: 2,
  message: `agent-gh guard: ${what}; this agent-gh may be older than the repository's hooks, so ${UPDATE}.\n${NEXT_STEP}`,
});

/** The prefix git's comment lines start with: `core.commentString`, else `core.commentChar`, else `#`. */
export const commentPrefix = (config: GitConfig): string => {
  const prefix = config.get("core.commentString") ?? config.get("core.commentChar");
  return prefix === undefined || prefix === "auto" ? "#" : prefix;
};

/**
 * Whether a commit message has any text of its own: something before the
 * `git commit -v` scissors line that is neither blank nor a comment. git
 * aborts an empty message only after commit-msg runs, so a hook that added
 * trailers to one would commit a message made of trailers alone.
 */
export const hasMessage = (text: string, prefix: string): boolean => {
  const lines = text.split("\n");
  const scissors = lines.indexOf(`${prefix} ------------------------ >8 ------------------------`);
  return (scissors === -1 ? lines : lines.slice(0, scissors)).some((line) => !line.startsWith(prefix) && line.trim() !== "");
};

/**
 * What a repository's git hook does, whichever tool ran git. In an agent
 * session, in a repository with a github.com remote, `commit-msg` credits the
 * session: it adds the Agent-* trailers the harness reports and the family
 * App as co-author with `git interpret-trailers` (as `git commit --trailer`
 * does, so comments and the `-v` scissors are respected). Otherwise it leaves
 * the message alone. It never refuses a commit for lacking them. `pre-push`
 * passes: it is kept only so repositories' existing hooks keep working.
 * Anything this version does not understand fails with exit 2, never a
 * silent pass.
 */
export const guard = (
  args: readonly string[],
  env: Env,
  configDir: string,
  registry: Registry,
  repository: () => GitConfig,
): Verdict => {
  const [hook, ...rest] = args;
  if (hook === "commit-msg") {
    const [file] = rest;
    if (file === undefined || rest.length !== 1) return unknown("commit-msg takes the message file git passes it");
    if (!inAgentSession(env)) return PASS;
    const config = repository();
    if (!onGitHub(config) || !hasMessage(readFileSync(file, "utf8"), commentPrefix(config))) return PASS;
    const identity = detectIdentity(env);
    const app = readConfig(configDir, identity.family, registry);
    const result = Bun.spawnSync(["git", "interpret-trailers", "--in-place", "--no-divider", ...trailerArgs(identity, app), file], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    if (result.exitCode === 0) return PASS;
    return {
      code: 1,
      message: `agent-gh guard: git interpret-trailers exited ${result.exitCode}, so this commit would not credit ${app.slug}[bot]: ${result.stderr.toString().trim()}\n${NEXT_STEP}`,
    };
  }
  if (hook === "pre-push") return PASS;
  return unknown(hook === undefined ? "no hook named" : `unknown hook \`${hook}\``);
};
