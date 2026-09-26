import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig, REGISTRY, type AppConfig, type Registry } from "./config.ts";
import { Failure, type Stage } from "./failure.ts";
import { type Api, errorCode, getJson, oauthPost } from "./github.ts";

/**
 * John's login through one family's App: a user access token, so GitHub
 * records each action as John with the App's badge. Times are Unix seconds;
 * null means the App opted out of expiring user tokens.
 */
export type Login = {
  readonly access_token: string;
  readonly expires_at: number | null;
  readonly refresh_token: string | null;
  readonly refresh_expires_at: number | null;
};

export type LoginDeps = {
  readonly api: Api;
  readonly dir: string;
  readonly nowSeconds: () => number;
  readonly sleep: (ms: number) => Promise<void>;
};

/** A cached token is used until this many seconds before it expires. */
const MARGIN = 300;
/** How long to wait for another agent-gh refreshing the same login. */
const LOCK_WAIT_MS = 30_000;
/** A lock older than this outlived any refresh (requests time out at 15 s). */
const STALE_LOCK_MS = 60_000;

const paths = (dir: string, family: string) => ({
  login: join(dir, `${family}.token.json`),
  lock: join(dir, `${family}.token.lock`),
});

const relogin = (family: string) => `run \`agent-gh login ${family}\` in your own terminal`;

const code = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : "an error";

const isLogin = (value: unknown): value is Login => {
  if (typeof value !== "object" || value === null) return false;
  const login = value as Record<string, unknown>;
  const time = (field: unknown) => field === null || Number.isSafeInteger(field);
  return (
    typeof login.access_token === "string" &&
    login.access_token !== "" &&
    time(login.expires_at) &&
    (login.refresh_token === null || (typeof login.refresh_token === "string" && login.refresh_token !== "")) &&
    time(login.refresh_expires_at)
  );
};

export const readLogin = (dir: string, family: string): Login => {
  const path = paths(dir, family).login;
  let text: string;
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      throw new Failure("reading the login", `${path} is readable by other users; run chmod 600 ${path}`);
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Failure) throw error;
    if (code(error) === "ENOENT") throw new Failure("reading the login", `no login for ${family}; ${relogin(family)}`);
    throw new Failure("reading the login", `${path} could not be read (${code(error)})`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Failure("reading the login", `${path} is not valid JSON; ${relogin(family)}`);
  }
  if (!isLogin(value)) throw new Failure("reading the login", `${path} is not an agent-gh login; ${relogin(family)}`);
  return value;
};

/** Writes a login atomically (temp file, then rename): directory 700, file 600. */
export const writeLogin = (dir: string, family: string, login: Login): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = join(dir, `.${family}.token.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temp, `${JSON.stringify(login)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temp, paths(dir, family).login);
};

/** A token response from github.com/login/oauth/access_token, as a Login. */
export const loginFrom = (reply: Record<string, unknown>, now: number): Login | undefined => {
  const { access_token, expires_in, refresh_token, refresh_token_expires_in } = reply;
  if (typeof access_token !== "string" || access_token === "") return undefined;
  const seconds = (value: unknown) => (Number.isSafeInteger(value) && (value as number) > 0 ? now + (value as number) : null);
  return {
    access_token,
    expires_at: seconds(expires_in),
    refresh_token: typeof refresh_token === "string" && refresh_token !== "" ? refresh_token : null,
    refresh_expires_at: seconds(refresh_token_expires_in),
  };
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) === "EPERM";
  }
};

/**
 * An exclusive lock on one family's login, so parallel agent-gh processes do
 * not each spend the same refresh token: GitHub rotates it on use, and a
 * second use would lock John out. The lock names its holder's pid; a lock whose
 * holder is gone, or that is older than any refresh, is removed.
 */
const lock = async (deps: LoginDeps, family: string): Promise<() => void> => {
  const path = paths(deps.dir, family).lock;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // Already gone: nothing to release.
        }
      };
    } catch (error) {
      if (code(error) !== "EEXIST") throw new Failure("refreshing the login", `${path} could not be created (${code(error)})`);
    }
    try {
      const holder = Number(readFileSync(path, "utf8"));
      const stale = Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS || (Number.isSafeInteger(holder) && holder > 0 && !alive(holder));
      if (stale) {
        unlinkSync(path);
        continue;
      }
    } catch {
      // Released between our attempts: try again at once.
      continue;
    }
    if (Date.now() > deadline) {
      throw new Failure("refreshing the login", `another agent-gh has held ${path} for 30 s; remove it if no agent-gh is running`);
    }
    await deps.sleep(100);
  }
};

const refresh = async (config: AppConfig, family: string, login: Login, deps: LoginDeps): Promise<Login> => {
  const stage = "refreshing the login";
  const now = deps.nowSeconds();
  if (login.refresh_token === null || (login.refresh_expires_at !== null && now >= login.refresh_expires_at)) {
    throw new Failure(stage, `the ${family} login has expired; ${relogin(family)}`);
  }
  // A token from the device flow refreshes without the client secret.
  const reply = await oauthPost(deps.api, stage, "/login/oauth/access_token", {
    client_id: config.client_id,
    grant_type: "refresh_token",
    refresh_token: login.refresh_token,
  });
  if (reply.error !== undefined) {
    throw new Failure(stage, `GitHub refused the stored ${family} login (${errorCode(reply.error)}); ${relogin(family)}`);
  }
  const next = loginFrom(reply, now);
  if (next === undefined) throw new Failure(stage, "invalid response");
  return next;
};

/**
 * John's current user access token for the family's App: the cached one until
 * five minutes before it expires, else a refreshed one, rotated and stored
 * under the lock. Never falls back to John's own gh login.
 */
export const userToken = async (config: AppConfig, family: string, deps: LoginDeps): Promise<string> => {
  const fresh = (login: Login) => login.expires_at === null || deps.nowSeconds() < login.expires_at - MARGIN;
  const cached = readLogin(deps.dir, family);
  if (fresh(cached)) return cached.access_token;
  const release = await lock(deps, family);
  try {
    // Another process may have refreshed while this one waited.
    const latest = readLogin(deps.dir, family);
    if (fresh(latest)) return latest.access_token;
    const next = await refresh(config, family, latest, deps);
    writeLogin(deps.dir, family, next);
    return next.access_token;
  } finally {
    release();
  }
};

type DeviceDeps = LoginDeps & {
  readonly github: string;
  readonly registry?: Registry;
  readonly open: (url: string) => void;
  readonly print: (line: string) => void;
};

const deviceFlowOff = (config: AppConfig, github: string) =>
  `device flow is off for ${config.slug}; tick "Enable Device Flow" at ${github}/settings/apps/${config.slug}, save, then run \`agent-gh login\` again`;

/**
 * Logs John in through the family App's device flow: prints a code for him to
 * enter at github.com, polls until he approves, and stores the token pair.
 * Returns the login GitHub reports for the new token.
 */
export const login = async (family: string, deps: DeviceDeps): Promise<string> => {
  const stage: Stage = "logging in";
  const config = readConfig(deps.dir, family, deps.registry ?? REGISTRY);
  const device = await oauthPost(deps.api, stage, "/login/device/code", { client_id: config.client_id });
  if (device.error === "device_flow_disabled") throw new Failure(stage, deviceFlowOff(config, deps.github));
  if (device.error !== undefined) throw new Failure(stage, `GitHub refused the device code request (${errorCode(device.error)})`);
  const { device_code, user_code, verification_uri, expires_in, interval } = device;
  if (
    typeof device_code !== "string" ||
    typeof user_code !== "string" ||
    typeof verification_uri !== "string" ||
    !Number.isSafeInteger(expires_in) ||
    !Number.isSafeInteger(interval)
  ) {
    throw new Failure(stage, "invalid response");
  }
  deps.print(`Open ${verification_uri} in any browser (on this machine or another) and enter ${user_code} to let ${config.slug} act as you.`);
  try {
    deps.open(verification_uri);
  } catch {
    // A headless machine has no browser to open: the printed URL and code are the path.
  }
  const deadline = deps.nowSeconds() + (expires_in as number);
  let wait = interval as number;
  for (;;) {
    await deps.sleep(wait * 1000);
    if (deps.nowSeconds() > deadline) throw new Failure(stage, `the code expired before it was entered; run \`agent-gh login ${family}\` again`);
    const reply = await oauthPost(deps.api, stage, "/login/oauth/access_token", {
      client_id: config.client_id,
      device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (reply.error === "authorization_pending") continue;
    if (reply.error === "slow_down") {
      // GitHub adds five seconds to the minimum interval, and may say so.
      wait = Math.max(wait + 5, Number.isSafeInteger(reply.interval) ? (reply.interval as number) : 0);
      continue;
    }
    if (reply.error === "expired_token") throw new Failure(stage, `the code expired before it was entered; run \`agent-gh login ${family}\` again`);
    if (reply.error === "access_denied") throw new Failure(stage, "the authorization was cancelled on github.com");
    if (reply.error === "device_flow_disabled") throw new Failure(stage, deviceFlowOff(config, deps.github));
    if (reply.error !== undefined) throw new Failure(stage, `GitHub refused the login (${errorCode(reply.error)})`);
    const result = loginFrom(reply, deps.nowSeconds());
    if (result === undefined) throw new Failure(stage, "invalid response");
    writeLogin(deps.dir, family, result);
    const user = await getJson(deps.api, stage, "/user", result.access_token);
    if (typeof user.login !== "string") throw new Failure(stage, "invalid response");
    deps.print(`Logged in: ${config.slug} acts as ${user.login}. The token is in ${paths(deps.dir, family).login} (mode 600).`);
    return user.login;
  }
};

/**
 * Whether the family's stored login can still act without a new device flow:
 * present, readable, and its refresh token (if any) not yet expired. An
 * expired access token is fine; agent-gh refreshes it.
 */
export const loginUsable = (dir: string, family: string, now: number): boolean => {
  try {
    const stored = readLogin(dir, family);
    if (stored.refresh_token === null) return stored.expires_at === null || now < stored.expires_at;
    return stored.refresh_expires_at === null || now < stored.refresh_expires_at;
  } catch {
    return false;
  }
};

/**
 * The families `AGENT_GH_FAMILIES` names, in family order, or undefined when
 * it is unset (every family). A name no family has is refused, so a typo
 * never silently skips a login.
 */
export const limitedFamilies = (families: readonly string[], limit: string | undefined): string[] | undefined => {
  if (limit === undefined || limit.trim() === "") return undefined;
  const wanted = limit.split(",").map((name) => name.trim()).filter((name) => name !== "");
  const unknown = wanted.filter((name) => !families.includes(name));
  if (unknown.length > 0) {
    throw new Failure("logging in", `AGENT_GH_FAMILIES names ${unknown.join(", ")}, which no family is called; use ${families.join(", ")}`);
  }
  return families.filter((name) => wanted.includes(name));
};

/**
 * The Apps `login --all` covers, in order: each family (or those
 * `AGENT_GH_FAMILIES` names), then the read App, keeping only the Apps that
 * exist (`configured`).
 */
export const loginTargets = (
  families: readonly string[],
  limit: string | undefined,
  read: string,
  configured: (name: string) => boolean,
): string[] => [...(limitedFamilies(families, limit) ?? families), read].filter(configured);

/**
 * `agent-gh login --all`: a device-flow login for each target not already
 * usable, one after another. A failed one is reported and the rest still run;
 * the result lists the failures (empty when every login is usable).
 */
export const loginAll = async (targets: readonly string[], deps: DeviceDeps): Promise<string[]> => {
  const failed: string[] = [];
  for (const family of targets) {
    if (loginUsable(deps.dir, family, deps.nowSeconds())) {
      deps.print(`${family}: already logged in`);
      continue;
    }
    deps.print(`${family}: logging in`);
    try {
      await login(family, deps);
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      deps.print(`${family}: ${error.stage} failed: ${error.detail}`);
      failed.push(family);
    }
  }
  return failed;
};
