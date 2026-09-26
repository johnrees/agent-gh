import type { AppConfig } from "./config.ts";
import type { Env } from "./harness.ts";
import { type Repo, slug } from "./repo.ts";

/** Git sees these after every config file, so they win. */
const GIT_CONFIG: readonly (readonly [string, string])[] = [
  // An empty helper clears every inherited credential helper, then gh's
  // helper answers with GH_TOKEN.
  ["credential.helper", ""],
  ["credential.https://github.com.helper", "!gh auth git-credential"],
  // github.com remotes use HTTPS and the bot token, never John's SSH key.
  ["url.https://github.com/.insteadOf", "git@github.com:"],
  ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
];

const SSH_OFF =
  "sh -c 'echo \"agent-gh: SSH is off; github.com remotes use the bot token over HTTPS\" >&2; exit 1'";

const count = (value: string | undefined): number => {
  const parsed = value === undefined ? 0 : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

export const botEmail = (config: AppConfig): string =>
  `${config.bot_user_id}+${config.bot_login}@users.noreply.github.com`;

/** The child's environment: the parent's, with the bot's identity and token. */
export const childEnv = (
  parent: Env,
  token: string,
  repo: Repo,
  config: AppConfig,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) if (value !== undefined) env[name] = value;
  delete env.GH_DEBUG;
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
    GIT_AUTHOR_NAME: config.bot_login,
    GIT_AUTHOR_EMAIL: botEmail(config),
    GIT_COMMITTER_NAME: config.bot_login,
    GIT_COMMITTER_EMAIL: botEmail(config),
    GIT_CONFIG_COUNT: String(first + GIT_CONFIG.length),
    GIT_SSH_COMMAND: SSH_OFF,
    GIT_TERMINAL_PROMPT: "0",
  });
};
