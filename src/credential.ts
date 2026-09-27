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
 * The session family's user token for a push, after checking that its App is
 * installed on the repository when git names one: GitHub's own refusal does
 * not say why.
 */
export const pushToken = async (deps: TokenDeps & { readonly env: Env }, repo: Repo | undefined): Promise<string> => {
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
  readonly push: (repo: Repo | undefined) => Promise<string>;
  readonly print: (line: string) => void;
};

/**
 * `agent-gh credential <get|store|erase>`, git's credential-helper protocol,
 * set up by `install-shims --agent-machine`. A `get` for https://github.com
 * is answered with the read App's token, or, for a push (username
 * PUSH_USER) from an agent session, with that session family's token. A push
 * from outside an agent session, or a request agent-gh cannot answer, gets
 * `quit`, so git neither prompts nor tries another login. Anything else gets
 * no answer, so git moves on. `store` and `erase` do nothing: the token is
 * agent-gh's to manage.
 */
export const credential = async (action: string | undefined, input: string, answers: Answers): Promise<string> => {
  if (action !== "get") return "";
  const fields = parseCredential(input);
  if (fields.protocol !== "https" || fields.host !== "github.com") return "";
  const push = fields.username === PUSH_USER;
  if (push && !answers.inAgentSession) {
    answers.print(`agent-gh: this is an agent machine, and only an agent session pushes to GitHub from it.\n${NEXT_STEP}`);
    return "quit=1\n";
  }
  try {
    if (!push) return `username=x-access-token\npassword=${await answers.read()}\n`;
    return `password=${await answers.push(fields.path === undefined ? undefined : parseRepo(fields.path))}\n`;
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    answers.print(describe(error));
    return "quit=1\n";
  }
};
