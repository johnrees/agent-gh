import type { Identity } from "./harness.ts";

/** The App a commit credits, so GitHub shows John and the family's App together. */
export type CoAuthor = { readonly slug: string; readonly bot_user_id: number };

export const coAuthorTrailer = (app: CoAuthor): string =>
  `Co-authored-by: ${app.slug}[bot] <${app.bot_user_id}+${app.slug}[bot]@users.noreply.github.com>`;

/** The agent trailers: only what the harness reports, never a guess. */
export const agentTrailers = (identity: Identity): string[] => [
  ...(identity.model === undefined ? [] : [`Agent-Model: ${identity.model}`]),
  `Agent-Harness: ${identity.harness}`,
  ...(identity.effort === undefined ? [] : [`Agent-Effort: ${identity.effort}`]),
];

/**
 * `git interpret-trailers` arguments that credit the session: an amend
 * replaces the agent trailers instead of stacking a second set, and credits
 * the App only once, keeping any other co-author.
 */
export const trailerArgs = (identity: Identity, app: CoAuthor): string[] => [
  "--if-exists", "replace",
  ...agentTrailers(identity).flatMap((trailer) => ["--trailer", trailer]),
  "--if-exists", "addIfDifferent",
  "--trailer", coAuthorTrailer(app),
];
