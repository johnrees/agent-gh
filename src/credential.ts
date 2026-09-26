import { READ_APP, readConfig, type Registry } from "./config.ts";
import { type LoginDeps, userToken } from "./login.ts";

/**
 * John's current user token for the read App, and only the read App: it can
 * clone, fetch, and read, never write. No family's (writing) token is read
 * here, whatever asks.
 */
export const readToken = async (deps: LoginDeps & { readonly registry: Registry }): Promise<string> =>
  userToken(readConfig(deps.dir, READ_APP, deps.registry), READ_APP, deps);

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

/**
 * `agent-gh credential <get|store|erase>`, git's credential-helper protocol,
 * set up by `install-shims --agent-machine`. `get` for https://github.com
 * answers with the read App's token; anything else gets no answer, so git
 * moves on. `store` and `erase` do nothing: the token is agent-gh's to manage.
 * A push with this token is refused by GitHub, so on an agent machine only
 * agent-gh (which replaces git's helpers for its own children) can write.
 */
export const credential = async (
  action: string | undefined,
  input: string,
  token: () => Promise<string>,
): Promise<string> => {
  if (action !== "get") return "";
  const fields = parseCredential(input);
  if (fields.protocol !== "https" || fields.host !== "github.com") return "";
  return `username=x-access-token\npassword=${await token()}\n`;
};
