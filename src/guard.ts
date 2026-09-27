import { readFileSync } from "node:fs";
import { readConfig, type Registry } from "./config.ts";
import { coAuthorTrailer } from "./git.ts";
import { detectIdentity, type Env, inAgentSession } from "./harness.ts";
import { type GitConfig, githubRepoOf, onGitHub } from "./target.ts";

/**
 * agent-gh sets this on every git and gh it runs, so a repository's hooks can
 * tell its children from a bare command. It guards against the easy mistake,
 * not a determined agent: anything can set a variable.
 */
export const CHILD_MARKER = "AGENT_GH_CHILD";

export const UPDATE = "git -C ~/Code/agent-gh pull && bun install --frozen-lockfile && bun run install-local";

export type Verdict = { readonly code: 0 | 1 | 2; readonly message?: string };

const PASS: Verdict = { code: 0 };

const unknown = (what: string): Verdict => ({
  code: 2,
  message: `agent-gh guard: ${what}; this agent-gh may be older than the repository's hooks, so update it: ${UPDATE}`,
});

/**
 * What a repository's git hook decides, whichever tool ran git. Outside an
 * agent session everything passes, and so does a repository with no
 * github.com remote, or a push the hook is told goes elsewhere: agent-gh
 * governs GitHub, not local git. Inside an agent session, a commit must credit
 * the session family's App (which `agent-gh git commit` adds before git runs
 * commit-msg) and a push must come through agent-gh. Anything this version
 * does not understand fails with exit 2, never a silent pass.
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
    if (!inAgentSession(env) || env[CHILD_MARKER] === "1" || !onGitHub(repository())) return PASS;
    const identity = detectIdentity(env);
    const trailer = coAuthorTrailer(readConfig(configDir, identity.family, registry));
    const lines = readFileSync(file, "utf8").split("\n").map((line) => line.trimEnd());
    if (lines.includes(trailer)) return PASS;
    return {
      code: 1,
      message: `agent-gh guard: this agent session's commit would not credit ${trailer.slice("Co-authored-by: ".length)}; commit through agent-gh: \`agent-gh git commit ...\``,
    };
  }
  if (hook === "pre-push") {
    if (!inAgentSession(env) || env[CHILD_MARKER] === "1") return PASS;
    // git passes the remote's name and URL; a hook that forwards them lets a push elsewhere through.
    const url = rest[1];
    const config = repository();
    if (url !== undefined && githubRepoOf(url, config) === undefined) return PASS;
    if (!onGitHub(config)) return PASS;
    return {
      code: 1,
      message: "agent-gh guard: an agent session pushes through agent-gh, not with John's own login: `agent-gh git push ...`",
    };
  }
  return unknown(hook === undefined ? "no hook named" : `unknown hook \`${hook}\``);
};
