import { READ_APP, readConfig, type Registry } from "./config.ts";
import { describe, Failure, NEXT_STEP } from "./failure.ts";
import { requireInstallation } from "./github.ts";
import { detectIdentity, type Env } from "./harness.ts";
import { type LoginDeps, userToken } from "./login.ts";
import { parseRepo, type Repo } from "./repo.ts";

/**
 * The username an agent machine's push URLs carry (`install-shims
 * --agent-machine` sets `url.https://agent-push@github.com/.pushInsteadOf`),
 * so git's credential request says whether it is for a push.
 */
export const PUSH_USER = "agent-push";

type TokenDeps = LoginDeps & { readonly registry: Registry };

/**
 * John's current user token for the read App, and only the read App: it can
 * clone, fetch, and read, never write.
 */
export const readToken = async (deps: TokenDeps): Promise<string> =>
  userToken(readConfig(deps.dir, READ_APP, deps.registry), READ_APP, deps);

/**
 * The session family's user token for a repository, after checking that its
 * App is installed there when git names one: GitHub's own refusal does not
 * say why.
 */
export const familyToken = async (deps: TokenDeps & { readonly env: Env }, repo: Repo | undefined): Promise<string> => {
  const { family } = detectIdentity(deps.env);
  const config = readConfig(deps.dir, family, deps.registry);
  const token = await userToken(config, family, deps);
  if (repo !== undefined) await requireInstallation(deps.api, config, family, token, repo);
  return token;
};

/** git's credential-helper input: `key=value` lines up to a blank line. */
export const parseCredential = (input: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const line of input.split("\n")) {
    if (line === "") break;
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
};

export type Answers = {
  readonly inAgentSession: boolean;
  readonly read: () => Promise<string>;
  readonly family: (repo: Repo | undefined) => Promise<string>;
  readonly print: (line: string) => void;
};

/**
 * `agent-gh credential <get|store|erase>`, git's credential-helper protocol,
 * set up by `install-shims --agent-machine`. A `get` for https://github.com
 * from an agent session is answered with the session family's token wherever
 * that family's App is installed, and with the read App's token elsewhere; a
 * person's gets the read App's. A push (username PUSH_USER) that the family's
 * App cannot make, or one from a person, gets `quit` with the reason, so git
 * neither prompts nor tries another login; so does a read agent-gh cannot
 * answer. Anything else gets no answer, so git moves on. `store` and `erase`
 * do nothing: the token is agent-gh's to manage.
 */
export const credential = async (action: string | undefined, input: string, answers: Answers): Promise<string> => {
  if (action !== "get") return "";
  const fields = parseCredential(input);
  if (fields.protocol !== "https" || fields.host !== "github.com") return "";
  const repo = fields.path === undefined ? undefined : parseRepo(fields.path);
  const quit = (line: string) => {
    answers.print(line);
    return "quit=1\n";
  };
  if (fields.username === PUSH_USER) {
    if (!answers.inAgentSession) return quit(`agent-gh: this is an agent machine, and only an agent session pushes to GitHub from it.\n${NEXT_STEP}`);
    try {
      return `password=${await answers.family(repo)}\n`;
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      return quit(describe(error));
    }
  }
  // A push to a remote's explicit pushurl, which pushInsteadOf leaves alone, arrives here too.
  if (answers.inAgentSession && repo !== undefined) {
    try {
      return `username=x-access-token\npassword=${await answers.family(repo)}\n`;
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
    }
  }
  try {
    return `username=x-access-token\npassword=${await answers.read()}\n`;
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    return quit(describe(error));
  }
};
