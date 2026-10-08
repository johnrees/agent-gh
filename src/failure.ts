/**
 * A refusal. `stage` names the step that failed. Details never carry a key,
 * a token, a JWT, or a request or response body or header: callers build them
 * from paths, names, and HTTP statuses only. `network` marks a request that
 * never reached GitHub (DNS, a refused connection, a timeout), which a
 * sandbox without network access causes.
 */
export class Failure extends Error {
  constructor(
    readonly stage: Stage,
    readonly detail: string,
    readonly network = false,
  ) {
    super(`${stage} failed: ${detail}`);
  }
}

/**
 * What an agent does after any agent-gh refusal: the last line of every
 * message it can meet, so no project needs to say it in prose.
 */
export const NEXT_STEP =
  "Fix what this names, or report it to John; never publish another way (John's own login, gh without agent-gh, or a connector).";

/** The same, for a request that never reached GitHub. */
export const NETWORK_NEXT_STEP =
  "Retry the same command with the sandbox's network access; if it still fails, report it to John. Never publish another way (John's own login, gh without agent-gh, or a connector).";

export type Stage =
  | "detecting the harness"
  | "detecting the model"
  | "resolving the repository"
  | "reading config"
  | "reading key"
  | "signing"
  | "finding the installation"
  | "logging in"
  | "reading the login"
  | "refreshing the login"
  | "starting the child"
  | "setting up"
  | "installing the shims"
  | "reading a credential"
  | "reading the review config"
  | "checking the review"
  | "reviewing";

export const describe = (failure: Failure): string =>
  `agent-gh: ${failure.stage} failed: ${failure.detail}.\n${failure.network ? NETWORK_NEXT_STEP : NEXT_STEP}`;
