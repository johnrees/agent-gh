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

const get = async (api: Api, stage: Stage, path: string, token: string, redirect: "error" | "manual" = "error"): Promise<Response> => {
  try {
    return await fetch(`${api.base}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "agent-gh",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect,
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
  method: "GET" | "POST" | "PATCH" | "DELETE",
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
/** Every page one installation check reads, across all of the App's installations. */
const MAX_REQUESTS = 200;

/**
 * Yields one of the user-token list endpoints' items page by page until the
 * list ends or the caller stops. A 401 means GitHub no longer accepts the
 * login. A page whose items are not plain objects, whose count is negative, or
 * which holds more items than a page or its own count allows is malformed and
 * fails, so it can never end the walk as "not found". Each list stops at
 * MAX_PAGES, and all the lists of one check share `budget`.
 */
async function* listItems(
  api: Api,
  stage: Stage,
  path: string,
  token: string,
  field: "installations" | "repositories",
  relogin: string,
  budget: { requests: number },
): AsyncGenerator<Record<string, unknown>> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (++budget.requests > MAX_REQUESTS) throw new Failure(stage, `gave up after ${MAX_REQUESTS} requests`);
    const response = await get(api, stage, `${path}?per_page=${PER_PAGE}&page=${page}`, token);
    if (response.status === 401) throw new Failure(stage, `GitHub refused the stored login (HTTP 401); ${relogin}`);
    if (!response.ok) throw new Failure(stage, `HTTP ${response.status}`);
    const body = await json(response, stage);
    const items = body[field];
    const total = body.total_count;
    if (
      !Array.isArray(items) ||
      !Number.isSafeInteger(total) ||
      (total as number) < 0 ||
      items.length > PER_PAGE ||
      (page - 1) * PER_PAGE + items.length > (total as number) ||
      (items.length < PER_PAGE && (page - 1) * PER_PAGE + items.length < (total as number))
    ) {
      throw new Failure(stage, "invalid response");
    }
    for (const item of items as unknown[]) {
      if (!isRecord(item)) throw new Failure(stage, "invalid response");
      yield item;
    }
    if (items.length < PER_PAGE || page * PER_PAGE >= (total as number)) return;
  }
  throw new Failure(stage, `gave up after ${MAX_PAGES * PER_PAGE} results`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const FULL_NAME = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** `OWNER/NAME` exactly, with no `.` or `..` segment; anything else is malformed. */
const parseFullName = (value: unknown): Repo | undefined => {
  const match = typeof value === "string" ? FULL_NAME.exec(value) : null;
  const owner = match?.[1];
  const name = match?.[2];
  return owner === undefined || name === undefined || [owner, name].some((part) => part === "." || part === "..") ? undefined : { owner, name };
};

/** A listed repository's name: its `full_name`, else (in older replies) `owner.login` and `name`. */
const fullName = (item: Record<string, unknown>): Repo | undefined => {
  if (item.full_name !== undefined) return parseFullName(item.full_name);
  const login = isRecord(item.owner) ? item.owner.login : undefined;
  return typeof login === "string" && typeof item.name === "string" ? parseFullName(`${login}/${item.name}`) : undefined;
};

/** Only an absent installation, never an API/authentication failure. */
export class MissingInstallation extends Failure {}

/** A repository's canonical name and whether anyone may read it. */
export type Visibility = { readonly repo: Repo; readonly public: boolean };

/** The redirects GitHub's REST API documents; a renamed or transferred repository answers 301. */
const MOVED = [301, 302, 307];

const visibility = (body: Record<string, unknown>, stage: Stage, id?: number): Visibility => {
  const repo = parseFullName(body.full_name);
  if (
    repo === undefined ||
    typeof body.private !== "boolean" ||
    (body.visibility !== undefined && typeof body.visibility !== "string") ||
    (id !== undefined && body.id !== id)
  ) {
    throw new Failure(stage, "invalid response");
  }
  return { repo, public: body.private === false && (body.visibility ?? "public") === "public" };
};

/**
 * The repository id a renamed or transferred repository's redirect names, as
 * GitHub sends it (`https://api.github.com/repositories/ID`, or the same path
 * relative to the API): only that path on the API's own origin, so never
 * another host, port or scheme, credentials, query or fragment. Anything else
 * is not followed.
 */
export const movedTo = (api: Api, location: string | null): number | undefined => {
  if (location === null) return undefined;
  let url: URL;
  try {
    url = new URL(location, `${api.base}/`);
  } catch {
    return undefined;
  }
  const base = new URL(api.base);
  const root = base.pathname.replace(/\/$/, "");
  const match = /^\/repositories\/([1-9]\d{0,15})$/.exec(url.pathname.startsWith(`${root}/`) ? url.pathname.slice(root.length) : "");
  if (!match || url.origin !== base.origin || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : undefined;
};

/**
 * Reads a repository's canonical name and visibility with the existing App
 * login. GitHub answers a renamed or transferred repository with a redirect to
 * its id; that one hop is rebuilt against the API base (the token never goes
 * where a Location points), and any other redirect fails. Undefined when the
 * login cannot see the repository.
 */
export const repoVisibility = async (api: Api, repo: Repo, token: string): Promise<Visibility | undefined> => {
  const stage = "finding the installation";
  const response = await get(api, stage, `/repos/${repo.owner}/${repo.name}`, token, "manual");
  if (response.status === 404) return undefined;
  if (MOVED.includes(response.status)) {
    const id = movedTo(api, response.headers.get("location"));
    if (id === undefined) throw new Failure(stage, `HTTP ${response.status} to an unrecognised location`);
    const moved = await get(api, stage, `/repositories/${id}`, token, "manual");
    if (moved.status === 404) return undefined;
    if (!moved.ok) throw new Failure(stage, `HTTP ${moved.status}`);
    return visibility(await json(moved, stage), stage, id);
  }
  if (!response.ok) throw new Failure(stage, `HTTP ${response.status}`);
  const found = visibility(await json(response, stage), stage);
  if (slug(found.repo).toLowerCase() !== slug(repo).toLowerCase()) throw new Failure(stage, "invalid response");
  return found;
};

/**
 * Refuses up front when the family's App is not installed on the repository:
 * gh's own error for that case does not say why. Uses John's user token for
 * the App (GET /user/installations, then each of this App's installations'
 * repositories, as the App may be installed on several accounts), so no
 * machine needs the App's private key for everyday commands. Only a complete
 * walk that finds no match is a MissingInstallation; any failed or malformed
 * page is a plain Failure.
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
  const target = slug(repo).toLowerCase();
  const budget = { requests: 0 };
  const seen = new Set<number>();
  for await (const installation of listItems(api, stage, "/user/installations", token, "installations", relogin, budget)) {
    // Every entry must be well formed: a malformed one skipped as another App's could end the walk as "not installed".
    const { id, app_slug: app } = installation;
    if (!Number.isSafeInteger(id) || (id as number) <= 0 || typeof app !== "string" || app === "") throw new Failure(stage, "invalid response");
    if (app !== config.slug || seen.has(id as number)) continue;
    seen.add(id as number);
    for await (const item of listItems(api, stage, `/user/installations/${id as number}/repositories`, token, "repositories", relogin, budget)) {
      const name = fullName(item);
      if (name === undefined) throw new Failure(stage, "invalid response");
      if (slug(name).toLowerCase() === target) return;
    }
  }
  throw new MissingInstallation(
    stage,
    `the ${config.slug} App is not installed on ${slug(repo)}; install it at https://github.com/apps/${config.slug}/installations/new and select ${slug(repo)}`,
  );
};
