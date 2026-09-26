import type { Identity } from "./harness.ts";

/** git's global options that take a separate value. */
export const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/** The index of git's subcommand in `args`, past its global options. */
export const subcommandIndex = (args: readonly string[]): number | undefined => {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    if (GIT_VALUE_OPTIONS.has(arg)) index += 2;
    else if (arg.startsWith("-")) index++;
    else return index;
  }
  return undefined;
};

export const subcommand = (args: readonly string[]): string | undefined => {
  const index = subcommandIndex(args);
  return index === undefined ? undefined : args[index];
};

/**
 * Subcommands that never talk to a remote, so they need no token. Anything
 * else (push, fetch, pull, clone, ls-remote, submodule, and anything unlisted)
 * gets John's user token for the family's App.
 */
const LOCAL = new Set([
  "add", "am", "apply", "bisect", "blame", "branch", "checkout", "cherry-pick", "clean", "commit", "config", "describe",
  "diff", "grep", "init", "log", "merge", "mv", "notes", "rebase", "reflog", "reset", "restore", "revert", "rev-parse",
  "rm", "shortlog", "show", "stash", "status", "switch", "tag", "var", "worktree",
]);

export const needsToken = (args: readonly string[]): boolean => {
  const name = subcommand(args);
  return name === undefined || !LOCAL.has(name);
};

/** The agent trailers: only what the harness reports, never a guess. An amend replaces them. */
export const TRAILER_KEYS = ["Agent-Model", "Agent-Harness", "Agent-Effort"] as const;

/** The App a commit credits, so GitHub shows John and the family's App together. */
export type CoAuthor = { readonly slug: string; readonly bot_user_id: number };

export const coAuthorTrailer = (app: CoAuthor): string =>
  `Co-authored-by: ${app.slug}[bot] <${app.bot_user_id}+${app.slug}[bot]@users.noreply.github.com>`;

export const trailers = (identity: Identity, app: CoAuthor): string[] => [
  ...(identity.model === undefined ? [] : [`Agent-Model: ${identity.model}`]),
  `Agent-Harness: ${identity.harness}`,
  ...(identity.effort === undefined ? [] : [`Agent-Effort: ${identity.effort}`]),
  coAuthorTrailer(app),
];

/**
 * Adds `--trailer` arguments right after `commit`, so they precede any `--`
 * pathspec separator and work with -m, -F, --amend, and --no-edit. Other
 * commands pass through unchanged. The commit's author stays John's own.
 */
export const withTrailers = (args: readonly string[], identity: Identity, app: CoAuthor): string[] => {
  const index = subcommandIndex(args);
  if (index === undefined || args[index] !== "commit") return [...args];
  const added = trailers(identity, app).flatMap((trailer) => ["--trailer", trailer]);
  return [...args.slice(0, index + 1), ...added, ...args.slice(index + 1)];
};
