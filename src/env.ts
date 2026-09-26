import { TRAILER_KEYS } from "./git.ts";
import type { Env } from "./harness.ts";
import { type Repo, slug } from "./repo.ts";

/** Git sees these after every config file, so they win. */
const GIT_CONFIG: readonly (readonly [string, string])[] = [
  // An empty helper clears every inherited credential helper.
  ["credential.helper", ""],
  // github.com remotes use HTTPS and the App's user token, never John's SSH key.
  ["url.https://github.com/.insteadOf", "git@github.com:"],
  ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  // An amend replaces the agent trailers instead of stacking a second set,
  ...TRAILER_KEYS.map((key) => [`trailer.${key}.ifexists`, "replace"] as const),
  // and adds the App as co-author only once, keeping any other co-author.
  ["trailer.Co-authored-by.ifexists", "addIfDifferent"],
];

/** With a token, gh's helper answers git with GH_TOKEN; without one, nothing answers. */
const TOKEN_HELPER = ["credential.https://github.com.helper", "!gh auth git-credential"] as const;

const SSH_OFF =
  "sh -c 'echo \"agent-gh: SSH is off; github.com remotes use the App token over HTTPS\" >&2; exit 1'";

const count = (value: string | undefined): number => {
  const parsed = value === undefined ? 0 : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

/**
 * The child's environment: the parent's, with the family App's user token when
 * the command talks to GitHub. The git author stays John's own. Without a
 * token, inherited GitHub tokens are removed and no credential helper answers,
 * so a command that reaches a remote fails instead of using John's own login.
 */
export const childEnv = (parent: Env, token: string | undefined, repo: Repo): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) if (value !== undefined) env[name] = value;
  delete env.GH_DEBUG;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  const entries = token === undefined ? GIT_CONFIG : [...GIT_CONFIG.slice(0, 1), TOKEN_HELPER, ...GIT_CONFIG.slice(1)];
  const first = count(parent.GIT_CONFIG_COUNT);
  entries.forEach(([key, value], offset) => {
    env[`GIT_CONFIG_KEY_${first + offset}`] = key;
    env[`GIT_CONFIG_VALUE_${first + offset}`] = value;
  });
  return Object.assign(env, token === undefined ? {} : { GH_TOKEN: token, GITHUB_TOKEN: token }, {
    GH_HOST: "github.com",
    GH_REPO: slug(repo),
    GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_COUNT: String(first + entries.length),
    GIT_SSH_COMMAND: SSH_OFF,
    GIT_TERMINAL_PROMPT: "0",
  });
};
