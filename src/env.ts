import type { Env } from "./harness.ts";
import { type Repo, slug } from "./repo.ts";

/**
 * agent-gh sets this on every gh it runs, so its gh shim sends that gh (and
 * any gh it starts) to the real program. It guards against the easy mistake,
 * not a determined agent: anything can set a variable.
 */
export const CHILD_MARKER = "AGENT_GH_CHILD";

/**
 * Git sees these after every config file, so they win: an empty helper clears
 * every inherited credential helper, gh's then answers with GH_TOKEN, and
 * github.com remotes use HTTPS with the App's token, never John's SSH key.
 */
const GIT_CONFIG: readonly (readonly [string, string])[] = [
  ["credential.helper", ""],
  ["credential.https://github.com.helper", "!gh auth git-credential"],
  ["url.https://github.com/.insteadOf", "git@github.com:"],
  ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
];

const SSH_OFF =
  "sh -c 'echo \"agent-gh: SSH is off; github.com remotes use the App token over HTTPS\" >&2; exit 1'";

const count = (value: string | undefined): number => {
  const parsed = value === undefined ? 0 : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

/**
 * The environment of a gh that agent-gh runs: the parent's, with the family
 * App's user token in place of any inherited GitHub token, for gh and for the
 * git gh starts. The git author stays John's own.
 */
export const childEnv = (parent: Env, token: string, repo: Repo): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) if (value !== undefined) env[name] = value;
  delete env.GH_DEBUG;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  const first = count(parent.GIT_CONFIG_COUNT);
  GIT_CONFIG.forEach(([key, value], offset) => {
    env[`GIT_CONFIG_KEY_${first + offset}`] = key;
    env[`GIT_CONFIG_VALUE_${first + offset}`] = value;
  });
  return Object.assign(env, {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GH_HOST: "github.com",
    GH_REPO: slug(repo),
    GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_COUNT: String(first + GIT_CONFIG.length),
    GIT_SSH_COMMAND: SSH_OFF,
    GIT_TERMINAL_PROMPT: "0",
    [CHILD_MARKER]: "1",
  });
};
