import { readFileSync, writeFileSync } from "node:fs";
import { readConfig, type Registry } from "./config.ts";
import { NEXT_STEP } from "./failure.ts";
import { trailerArgs, withoutAbsent } from "./git.ts";
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

/** The characters `core.commentChar=auto` chooses from, in git's order. */
const AUTO = "#;@!$%^&|:";

/**
 * The prefix git's comment lines start with: `core.commentString`, else
 * `core.commentChar`, else `#`. For `auto`, git chose a character no line of
 * the starting message began with and wrote its template with it, so it is
 * read back from the `-v` scissors line or the template's last two lines;
 * with neither (an editor replaced the whole buffer), no line is a comment.
 */
export const commentPrefix = (config: GitConfig, text: string): string | undefined => {
  const prefix = config.get("core.commentString") ?? config.get("core.commentChar");
  if (prefix !== "auto") return prefix ?? "#";
  const lines = text.split("\n");
  const scissors = lines.find((line) => /^. -{24} >8 -{24}$/.test(line) && AUTO.includes(line[0] as string));
  if (scissors !== undefined) return scissors[0] as string;
  const [last, previous] = lines.filter((line) => line.trim() !== "").reverse();
  const char = last?.[0];
  return char !== undefined && AUTO.includes(char) && commentLine(last, char) && commentLine(previous, char) ? char : undefined;
};

/** A line as git's own template writes a comment: the prefix alone, or followed by a space or tab. */
const commentLine = (line: string | undefined, prefix: string): boolean =>
  line !== undefined && (line === prefix || line.startsWith(`${prefix} `) || line.startsWith(`${prefix}\t`));

/**
 * Whether a commit message has any text of its own: something before the
 * `git commit -v` scissors line that is not blank, and not a comment when
 * git's cleanup strips comments. git aborts an empty message only after
 * commit-msg runs, so a hook that added trailers to one would commit a
 * message made of trailers alone.
 */
export const hasMessage = (text: string, prefix: string | undefined, stripsComments: boolean): boolean => {
  const lines = text.split("\n");
  const scissors = prefix === undefined ? -1 : lines.indexOf(`${prefix} ------------------------ >8 ------------------------`);
  return (scissors === -1 ? lines : lines.slice(0, scissors)).some(
    (line) => line.trim() !== "" && !(stripsComments && prefix !== undefined && line.startsWith(prefix)),
  );
};

/**
 * Whether git strips comment lines from this message: with `commit.cleanup`
 * at its default, only from an edited one. git sets GIT_EDITOR to `:` for the
 * hook when no editor runs (`-m`, `-F`, `--no-edit`), but a `:` editor someone
 * configured still gets git's template, which comment lines of its own mark.
 */
export const stripsComments = (config: GitConfig, env: Env, text: string, prefix: string | undefined): boolean => {
  const cleanup = config.get("commit.cleanup") ?? "default";
  if (cleanup !== "default") return cleanup === "strip";
  return env.GIT_EDITOR !== ":" || (prefix !== undefined && text.split("\n").some((line) => commentLine(line, prefix)));
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
    if (!onGitHub(config)) return PASS;
    const text = readFileSync(file, "utf8");
    const prefix = commentPrefix(config, text);
    if (!hasMessage(text, prefix, stripsComments(config, env, text, prefix))) return PASS;
    const identity = detectIdentity(env);
    const app = readConfig(configDir, identity.family, registry);
    const result = Bun.spawnSync(["git", "interpret-trailers", "--in-place", "--no-divider", ...trailerArgs(identity, app), file], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    if (result.exitCode === 0) {
      writeFileSync(file, withoutAbsent(readFileSync(file, "utf8")));
      return PASS;
    }
    return {
      code: 1,
      message: `agent-gh guard: git interpret-trailers exited ${result.exitCode}, so this commit would not credit ${app.slug}[bot]: ${result.stderr.toString().trim()}\n${NEXT_STEP}`,
    };
  }
  if (hook === "pre-push") return PASS;
  return unknown(hook === undefined ? "no hook named" : `unknown hook \`${hook}\``);
};
