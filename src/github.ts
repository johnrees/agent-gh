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
    throw new Failure(stage, `could not reach ${host(api.base)}`, true);
  }
};

/** A GET against the REST API; any status but 2xx fails with the status only. */
export const getJson = async (api: Api, stage: Stage, path: string, token: string): Promise<Record<string, unknown>> => {
  const response = await get(api, stage, path, token);
  if (!response.ok) throw new Failure(stage, `HTTP ${response.status}`);
  return json(response, stage);
};

/**
 * A REST request with John's user token for the family App, in any method,
 * with an optional JSON body. Returns the status and the parsed body (or
 * undefined when there is none or it is not JSON), so callers decide what a
 * 404 means; a request that never reaches GitHub fails.
 */
export const request = async (
  api: Api,
  stage: Stage,
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly value: unknown }> => {
  let response: Response;
  try {
    response = await fetch(`${api.base}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "agent-gh",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(api.timeoutMs),
    });
  } catch {
    throw new Failure(stage, `could not reach ${host(api.base)}`, true);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  return { status: response.status, value };
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
    throw new Failure(stage, `could not reach ${host(api.web)}`, true);
  }
  return json(response, stage);
};

/** An OAuth error code, safe to show: GitHub's are short snake_case words. */
export const errorCode = (value: unknown): string =>
  typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : "an unrecognised error";

const PER_PAGE = 100;
const MAX_PAGES = 50;

/**
 * Walks one of the user-token list endpoints page by page until `match` finds
 * an item or the list ends. A 401 means GitHub no longer accepts the login.
 */
const findInPages = async (
  api: Api,
  stage: Stage,
  path: string,
  token: string,
  field: "installations" | "repositories",
  match: (item: Record<string, unknown>) => boolean,
  relogin: string,
): Promise<Record<string, unknown> | undefined> => {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await get(api, stage, `${path}?per_page=${PER_PAGE}&page=${page}`, token);
    if (response.status === 401) throw new Failure(stage, `GitHub refused the stored login (HTTP 401); ${relogin}`);
    if (!response.ok) throw new Failure(stage, `HTTP ${response.status}`);
    const body = await json(response, stage);
    const items = body[field];
    const total = body.total_count;
    if (!Array.isArray(items) || !Number.isSafeInteger(total)) throw new Failure(stage, "invalid response");
    const hit = items.find(
      (item): item is Record<string, unknown> => typeof item === "object" && item !== null && match(item as Record<string, unknown>),
    );
    if (hit !== undefined) return hit;
    if (items.length < PER_PAGE || page * PER_PAGE >= (total as number)) return undefined;
  }
  throw new Failure(stage, `gave up after ${MAX_PAGES * PER_PAGE} results`);
};

const fullName = (item: Record<string, unknown>): string | undefined => {
  if (typeof item.full_name === "string") return item.full_name;
  const owner = item.owner;
  const login = typeof owner === "object" && owner !== null ? (owner as Record<string, unknown>).login : undefined;
  return typeof login === "string" && typeof item.name === "string" ? `${login}/${item.name}` : undefined;
};

/**
 * Refuses up front when the family's App is not installed on the repository:
 * gh's own error for that case does not say why. Uses John's user token for
 * the App (GET /user/installations, then that installation's repositories),
 * so no machine needs the App's private key for everyday commands.
 */
export const requireInstallation = async (
  api: Api,
  config: AppConfig,
  family: string,
  token: string,
  repo: Repo,
): Promise<void> => {
  const stage = "finding the installation";
  const relogin = `run \`agent-gh login ${family}\` in your own terminal`;
  const missing = () =>
    new Failure(
      stage,
      `the ${config.slug} App is not installed on ${slug(repo)}; install it at https://github.com/apps/${config.slug}/installations/new and select ${slug(repo)}`,
    );
  const installation = await findInPages(
    api,
    stage,
    "/user/installations",
    token,
    "installations",
    (item) => item.app_slug === config.slug,
    relogin,
  );
  if (installation === undefined) throw missing();
  const { id } = installation;
  if (!Number.isSafeInteger(id)) throw new Failure(stage, "invalid response");
  const target = slug(repo).toLowerCase();
  const repository = await findInPages(
    api,
    stage,
    `/user/installations/${id as number}/repositories`,
    token,
    "repositories",
    (item) => fullName(item)?.toLowerCase() === target,
    relogin,
  );
  if (repository === undefined) throw missing();
};
