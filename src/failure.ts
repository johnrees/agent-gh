/**
 * A refusal. `stage` names the step that failed. Details never carry a key,
 * a token, a JWT, or a request or response body or header: callers build them
 * from paths, names, and HTTP statuses only.
 */
export class Failure extends Error {
  constructor(
    readonly stage: Stage,
    readonly detail: string,
  ) {
    super(`${stage} failed: ${detail}`);
  }
}

export type Stage =
  | "detecting the harness"
  | "resolving the repository"
  | "reading config"
  | "reading key"
  | "signing"
  | "finding the installation"
  | "requesting the token"
  | "starting the child"
  | "setting up";

export const describe = (failure: Failure): string =>
  `agent-gh: ${failure.stage} failed: ${failure.detail}. No personal-login fallback was used.`;
