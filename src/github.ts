import { sign } from "node:crypto";
import type { AppConfig } from "./config.ts";
import { Failure, type Stage } from "./failure.ts";
import { type Repo, slug } from "./repo.ts";

/**
 * Where requests go. The shipped CLI always uses `GITHUB`; only tests pass a
 * local fake. There is deliberately no environment override: a JWT sent to
 * the wrong host could mint tokens for nine minutes.
 */
export type Api = { readonly base: string; readonly timeoutMs: number };

export const GITHUB: Api = { base: "https://api.github.com", timeoutMs: 15_000 };

const host = (api: Api): string => new URL(api.base).host;

const request = async (
  api: Api,
  stage: Stage,
  path: string,
  init: { readonly method: string; readonly token?: string; readonly body?: unknown },
): Promise<Response> => {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-gh",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  try {
    return await fetch(`${api.base}${path}`, {
      method: init.method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(api.timeoutMs),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new Failure(stage, `could not reach ${host(api)}`);
  }
};

const json = async (response: Response, stage: Stage): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = await response.json();
    if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  } catch {
    // Reported below, without the body.
  }
  throw new Failure(stage, "invalid response");
};

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

const installation = async (api: Api, config: AppConfig, jwt: string, repo: Repo): Promise<number> => {
  const stage = "finding the installation";
  const response = await request(api, stage, `/repos/${slug(repo)}/installation`, {
    method: "GET",
    token: jwt,
  });
  if (response.status === 404) {
    throw new Failure(
      stage,
      `the ${config.slug} App is not installed on ${slug(repo)}; install it at https://github.com/apps/${config.slug}/installations/new and select ${slug(repo)}`,
    );
  }
  if (!response.ok) throw new Failure(stage, `HTTP ${response.status}`);
  const { id } = await json(response, stage);
  if (!Number.isSafeInteger(id)) throw new Failure(stage, "invalid response");
  return id as number;
};

/**
 * An installation token for exactly one repository. The key buffer is zeroed
 * whatever happens.
 */
export const mintToken = async (
  api: Api,
  config: AppConfig,
  key: Buffer,
  repo: Repo,
  nowSeconds: number,
): Promise<string> => {
  let jwt: string;
  try {
    jwt = appJwt(config, key, nowSeconds);
  } finally {
    key.fill(0);
  }
  const id = await installation(api, config, jwt, repo);
  const stage = "requesting the token";
  const response = await request(api, stage, `/app/installations/${id}/access_tokens`, {
    method: "POST",
    token: jwt,
    body: { repositories: [repo.name] },
  });
  if (!response.ok) throw new Failure(stage, `HTTP ${response.status}`);
  const { token } = await json(response, stage);
  if (typeof token !== "string" || token === "") throw new Failure(stage, "invalid response");
  return token;
};

/** Revokes an installation token; false if GitHub did not confirm it. */
export const revokeToken = async (api: Api, token: string): Promise<boolean> => {
  try {
    const response = await fetch(`${api.base}/installation/token`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "agent-gh",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(api.timeoutMs),
    });
    return response.status === 204;
  } catch {
    return false;
  }
};
