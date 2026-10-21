import type { Identity } from "./harness.ts";

/** The App a commit credits, so GitHub shows John and the family's App together. */
export type CoAuthor = { readonly slug: string; readonly bot_user_id: number };

export const coAuthorTrailer = (app: CoAuthor): string =>
  `Co-authored-by: ${app.slug}[bot] <${app.bot_user_id}+${app.slug}[bot]@users.noreply.github.com>`;

/**
 * The value that marks an agent trailer this session does not report: the
 * hook deletes it after `git interpret-trailers` has replaced any earlier
 * one, so an amend never keeps another session's model or effort.
 */
export const ABSENT = "agent-gh-absent";

/**
 * `git interpret-trailers` arguments that credit the session: the agent
 * trailers replace any earlier set (only what the harness reports survives,
 * never a guess), and the App is credited once, keeping any other co-author.
 * `session` is the id the session's claims carry (`sessionId`), so `review
 * full` can tell a commit another session made on a claim branch; a session
 * with no id in its environment writes none, since a fresh id per commit
 * would name nobody.
 */
export const trailerArgs = (identity: Identity, app: CoAuthor, session?: string): string[] => [
  "--if-exists", "replace",
  "--trailer", `Agent-Model: ${identity.model ?? ABSENT}`,
  "--trailer", `Agent-Harness: ${identity.harness}`,
  "--trailer", `Agent-Effort: ${identity.effort ?? ABSENT}`,
  "--trailer", `Agent-Session: ${session ?? ABSENT}`,
  "--if-exists", "addIfDifferent",
  "--trailer", coAuthorTrailer(app),
];

/** A message without the trailers `trailerArgs` marked ABSENT. */
export const withoutAbsent = (text: string): string =>
  text
    .split("\n")
    .filter((line) => line !== `Agent-Model: ${ABSENT}` && line !== `Agent-Effort: ${ABSENT}` && line !== `Agent-Session: ${ABSENT}`)
    .join("\n");

/**
 * The author `git var GIT_AUTHOR_IDENT` reports, without its timestamp, and
 * whether it is a person's: git has one, and it is not an App's `[bot]`.
 */
export const gitAuthor = (ident: { readonly code: number; readonly stdout: string }): { readonly author: string; readonly person: boolean } => {
  const author = ident.stdout.trim().replace(/ \d+ [+-]\d{4}$/, "");
  return { author, person: ident.code === 0 && author !== "" && !author.includes("[bot]") };
};
