import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import registryJson from "../apps.json" with { type: "json" };
import { Failure } from "./failure.ts";

/** What `agent-gh setup` records for one model family's App. No secret lives here. */
export type AppConfig = {
  readonly client_id: string;
  readonly app_id: number;
  readonly slug: string;
  readonly bot_login: string;
  readonly bot_user_id: number;
};

/** One App's public identifiers, as committed in apps.json. */
export type RegistryEntry = {
  readonly slug: string;
  readonly app_id: number;
  readonly client_id: string;
  readonly bot_user_id: number;
};
export type Registry = Readonly<Record<string, RegistryEntry>>;

/**
 * John's family Apps, committed so that another machine needs only
 * `agent-gh login <family>`: public identifiers only (the client ID travels in
 * every device-flow and browser request), never a key or a token.
 */
export const REGISTRY: Registry = registryJson;

/**
 * The read-only App (`johnrees-read`): contents, issues, pull requests,
 * actions, and checks read, nothing written. It answers git's credential
 * requests and a person's gh on machines that only run agents, so clones and
 * reads work there while every write needs a family App through agent-gh. It
 * is a registry entry, never a model family: nothing publishes or co-authors
 * as it.
 */
export const READ_APP = "read";

export const defaultConfigDir = (): string => join(homedir(), ".config", "agent-gh");

const paths = (dir: string, family: string) => ({
  config: join(dir, `${family}.json`),
  key: join(dir, `${family}.pem`),
});

const code = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : "an error";

const isConfig = (value: unknown): value is AppConfig => {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.client_id === "string" &&
    config.client_id !== "" &&
    Number.isSafeInteger(config.app_id) &&
    typeof config.slug === "string" &&
    config.slug !== "" &&
    config.bot_login === `${config.slug}[bot]` &&
    Number.isSafeInteger(config.bot_user_id)
  );
};

const fromEntry = (entry: RegistryEntry): AppConfig => ({
  client_id: entry.client_id,
  app_id: entry.app_id,
  slug: entry.slug,
  bot_login: `${entry.slug}[bot]`,
  bot_user_id: entry.bot_user_id,
});

/** Whether the family has an App, locally recorded or committed in the registry. */
export const isConfigured = (dir: string, family: string, registry: Registry = REGISTRY): boolean =>
  existsSync(paths(dir, family).config) || Object.hasOwn(registry, family);

/**
 * The family's App: a local `<family>.json` from `agent-gh setup` wins (a new
 * App works before its registry entry is committed), else the committed
 * registry. Only a family in neither is told to run setup: setup on a family
 * that already has an App would create a second one.
 */
export const readConfig = (dir: string, family: string, registry: Registry = REGISTRY): AppConfig => {
  const path = paths(dir, family).config;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (code(error) !== "ENOENT") throw new Failure("reading config", `${path} could not be read (${code(error)})`);
    const entry = Object.hasOwn(registry, family) ? registry[family] : undefined;
    if (entry === undefined) {
      throw new Failure(
        "reading config",
        `${family} has no App yet: run \`agent-gh setup ${family}\` on the machine where you create Apps, then commit the registry entry it prints`,
      );
    }
    const config = fromEntry(entry);
    if (!isConfig(config)) throw new Failure("reading config", `the ${family} entry in apps.json is not a valid App`);
    return config;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Failure("reading config", `${path} is not valid JSON`);
  }
  if (!isConfig(value)) throw new Failure("reading config", `${path} is not an agent-gh App config`);
  return value;
};

/**
 * The App's private key, which only `agent-gh setup` writes and only App-level
 * requests (the planned `audit`) read: everyday commands use John's user token.
 * The caller zeroes the buffer once it has signed.
 */
export const readKey = (dir: string, family: string): Buffer => {
  const path = paths(dir, family).key;
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (error) {
    if (code(error) === "ENOENT") {
      throw new Failure(
        "reading key",
        `no private key for ${family} in ${dir}; run \`agent-gh setup ${family}\` in your own terminal`,
      );
    }
    throw new Failure("reading key", `${path} could not be read (${code(error)})`);
  }
  if ((mode & 0o077) !== 0) {
    throw new Failure("reading key", `${path} is readable by other users; run chmod 600 ${path}`);
  }
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Failure("reading key", `${path} could not be read (${code(error)})`);
  }
};

export const hasCredentials = (dir: string, family: string): boolean => {
  const { config, key } = paths(dir, family);
  return existsSync(config) || existsSync(key);
};

/** The line `agent-gh setup` asks John to add to apps.json for a new App. */
export const registryLine = (family: string, config: AppConfig): string =>
  `"${family}": ${JSON.stringify({ slug: config.slug, app_id: config.app_id, client_id: config.client_id, bot_user_id: config.bot_user_id })}`;

/** Writes a new App's key and config: directory 700, files 600, never overwriting. */
export const writeCredentials = (dir: string, family: string, config: AppConfig, pem: string): void => {
  const { config: configPath, key } = paths(dir, family);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(key, pem, { mode: 0o600, flag: "wx" });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
};
