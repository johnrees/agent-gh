import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Failure } from "./failure.ts";

/** What `agent-gh setup` records for one harness's App. No secret lives here. */
export type AppConfig = {
  readonly client_id: string;
  readonly app_id: number;
  readonly slug: string;
  readonly bot_login: string;
  readonly bot_user_id: number;
};

export const defaultConfigDir = (): string => join(homedir(), ".config", "agent-gh");

const paths = (dir: string, harness: string) => ({
  config: join(dir, `${harness}.json`),
  key: join(dir, `${harness}.pem`),
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

export const readConfig = (dir: string, harness: string): AppConfig => {
  const path = paths(dir, harness).config;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") {
      throw new Failure(
        "reading config",
        `no App for ${harness} in ${dir}; run \`agent-gh setup ${harness}\` in your own terminal`,
      );
    }
    throw new Failure("reading config", `${path} could not be read (${code(error)})`);
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

/** The App's private key. The caller zeroes the buffer once it has signed. */
export const readKey = (dir: string, harness: string): Buffer => {
  const path = paths(dir, harness).key;
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (error) {
    if (code(error) === "ENOENT") {
      throw new Failure(
        "reading key",
        `no private key for ${harness} in ${dir}; run \`agent-gh setup ${harness}\` in your own terminal`,
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

export const hasCredentials = (dir: string, harness: string): boolean => {
  const { config, key } = paths(dir, harness);
  return existsSync(config) || existsSync(key);
};

/** Writes a new App's key and config: directory 700, files 600, never overwriting. */
export const writeCredentials = (dir: string, harness: string, config: AppConfig, pem: string): void => {
  const { config: configPath, key } = paths(dir, harness);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(key, pem, { mode: 0o600, flag: "wx" });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
};
