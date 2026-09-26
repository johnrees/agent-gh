import { sign } from "node:crypto";
import type { AppConfig } from "./config.ts";
import { Failure, type Stage } from "./failure.ts";
import { type Repo, slug } from "./repo.ts";

/**
 * Where requests go: `base` is the REST API, `web` is github.com, which serves
 * the device flow and token refresh. The shipped CLI always uses `GITHUB`; only
 * tests pass a local fake. There is deliberately no environment override: a
 * JWT or a refresh token sent to the wrong host would leak.
 */
export type Api = { readonly base: string; readonly web: string; readonly timeoutMs: number };

export const GITHUB: Api = { base: "https://api.github.com", web: "https://github.com", timeoutMs: 15_000 };

const host = (url: string): string => new URL(url).host;

const json = async (response: Response, stage: Stage): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = await response.json();
    if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  } catch {
    // Reported below, without the body.
  }
  throw new Failure(stage, response.ok ? "invalid response" : `HTTP ${response.status}`);
};

const get = async (api: Api, stage: Stage, path: string, token: string): Promise<Response> => {
  try {
    return await fetch(`${api.base}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "agent-gh",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(api.timeoutMs),
    });
  } catch {
    throw new Failure(stage, `could not reach ${host(api.base)}`);
  }
};

/** A GET against the REST API; any status but 2xx fails with the status only. */
export const getJson = async (api: Api, stage: Stage, path: string, token: string): Promise<Record<string, unknown>> => {
  const response = await get(api, stage, path, token);
  if (!response.ok) throw new Failure(stage, `HTTP ${response.status}`);
  return json(response, stage);
};

/**
 * A form POST to github.com's OAuth endpoints (device code, token exchange,
 * refresh). They answer JSON when asked, with errors as an `error` field, so
 * the caller reads the body whatever the status.
 */
export const oauthPost = async (
  api: Api,
  stage: Stage,
  path: string,
  form: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await fetch(`${api.web}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "agent-gh",
      },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(api.timeoutMs),
    });
  } catch {
    throw new Failure(stage, `could not reach ${host(api.web)}`);
  }
  return json(response, stage);
};

/** An OAuth error code, safe to show: GitHub's are short snake_case words. */
export const errorCode = (value: unknown): string =>
  typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : "an unrecognised error";

/** A GitHub App JWT: RS256, issued by the App's client ID, valid for nine minutes. */
export const appJwt = (config: AppConfig, key: Buffer, nowSeconds: number): string => {
  try {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const message = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
      iss: config.client_id,
    })}`;
    return `${message}.${sign("RSA-SHA256", Buffer.from(message), key).toString("base64url")}`;
  } catch {
    throw new Failure("signing", `the ${config.slug} private key could not sign a JWT`);
  }
};

/**
 * Refuses up front when the family's App is not installed on the repository.
 * A user token only reaches repositories its App is installed on, and gh's own
 * error for that case does not say why. Checked with the App's JWT; the key
 * buffer is zeroed whatever happens.
 */
export const requireInstallation = async (
  api: Api,
  config: AppConfig,
  key: Buffer,
  repo: Repo,
  nowSeconds: number,
): Promise<void> => {
  let jwt: string;
  try {
    jwt = appJwt(config, key, nowSeconds);
  } finally {
    key.fill(0);
  }
  const stage = "finding the installation";
  const response = await get(api, stage, `/repos/${slug(repo)}/installation`, jwt);
  if (response.status === 404) {
    throw new Failure(
      stage,
      `the ${config.slug} App is not installed on ${slug(repo)}; install it at https://github.com/apps/${config.slug}/installations/new and select ${slug(repo)}`,
    );
  }
  if (!response.ok) throw new Failure(stage, `HTTP ${response.status}`);
  const { id } = await json(response, stage);
  if (!Number.isSafeInteger(id)) throw new Failure(stage, "invalid response");
};
