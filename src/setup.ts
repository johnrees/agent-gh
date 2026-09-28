import { randomBytes } from "node:crypto";
import { hasCredentials, READ_APP, REGISTRY, registryLine, writeCredentials, type AppConfig, type Registry } from "./config.ts";
import { Failure } from "./failure.ts";
import type { Api } from "./github.ts";

const WRITE = { contents: "write", issues: "write", pull_requests: "write", actions: "read", checks: "read" } as const;
const READ = { contents: "read", issues: "read", pull_requests: "read", actions: "read", checks: "read" } as const;

/**
 * An App private to John's account, with no webhook deliveries. A model
 * family's App (the one its agents publish as, whichever harness runs the
 * model) gets exactly the permissions agents need to push branches and work
 * issues and pull requests; the read App (`read`) gets the same areas read only.
 */
export const manifest = (family: string, redirectUrl: string) => ({
  name: `johnrees-${family}`,
  url: "https://github.com/johnrees",
  description:
    family === READ_APP
      ? "Read-only access for git clone and gh reads on machines that only run agents, through agent-gh."
      : `The identity of agents running ${family} models, used through agent-gh.`,
  public: false,
  // GitHub requires a URL whenever hook_attributes is present; active: false
  // means nothing is ever delivered to it.
  hook_attributes: { url: "https://github.com/johnrees", active: false },
  redirect_url: redirectUrl,
  default_events: [],
  default_permissions: family === READ_APP ? READ : WRITE,
  request_oauth_on_install: false,
  setup_on_update: false,
});

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const page = (body: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>agent-gh setup</title>${body}`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

type Setup = {
  readonly configDir: string;
  /** The committed App registry; tests pass their own. */
  readonly registry?: Registry;
  readonly api: Api;
  readonly github: string;
  readonly open: (url: string) => void;
  readonly print: (line: string) => void;
  readonly timeoutMs: number;
};

/**
 * Creates `johnrees-<family>` from a manifest: serves a one-shot page on
 * 127.0.0.1 that posts the manifest to GitHub, receives the redirect, converts
 * its code into the App's credentials, and stores only the key and the public
 * identifiers. The client secret and webhook secret are discarded. A family
 * already in the committed registry is refused: setup would make a second App.
 */
export const setup = async (family: string, deps: Setup): Promise<AppConfig> => {
  const registry = deps.registry ?? REGISTRY;
  if (Object.hasOwn(registry, family)) {
    throw new Failure(
      "setting up",
      `${registry[family]?.slug ?? family} already exists (it is in apps.json); run \`agent-gh login ${family}\` on this machine instead`,
    );
  }
  if (hasCredentials(deps.configDir, family)) {
    throw new Failure(
      "setting up",
      `an App for ${family} is already configured in ${deps.configDir}; remove ${family}.json and ${family}.pem first to create another`,
    );
  }
  const state = randomBytes(24).toString("hex");
  let settle!: { resolve: (config: AppConfig) => void; reject: (failure: Failure) => void };
  const done = new Promise<AppConfig>((resolve, reject) => {
    settle = { resolve, reject };
  });
  let finished = false;
  let port = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url);
      if (url.pathname === "/" && !finished) {
        const redirect = `http://127.0.0.1:${port}/callback`;
        const action = `${deps.github}/settings/apps/new?state=${state}`;
        return page(
          `<form method="post" action="${escape(action)}"><input type="hidden" name="manifest" value="${escape(
            JSON.stringify(manifest(family, redirect)),
          )}"><p>Create the <b>johnrees-${escape(family)}</b> GitHub App.</p><button>Continue to GitHub</button></form><script>document.forms[0].submit()</script>`,
        );
      }
      if (url.pathname !== "/callback" || finished) return new Response("Not found", { status: 404 });
      const code = url.searchParams.get("code") ?? "";
      if (url.searchParams.get("state") !== state || !/^[A-Za-z0-9_-]{1,100}$/.test(code)) {
        return new Response("This link is not from this setup run.", { status: 400 });
      }
      finished = true;
      try {
        const config = await convert(deps, family, code);
        settle.resolve(config);
        return page(`<p>Created ${escape(config.slug)}. Return to the terminal to install it on repositories.</p>`);
      } catch (error) {
        const failure =
          error instanceof Failure ? error : new Failure("setting up", "the App's credentials could not be stored");
        settle.reject(failure);
        return page(`<p>Setup failed: ${escape(failure.detail)}. See the terminal.</p>`);
      }
    },
  });
  port = server.port ?? 0;
  const local = `http://127.0.0.1:${port}/`;
  deps.print(`Opening ${local} to create johnrees-${family}. If no browser opens, visit it yourself.`);
  deps.open(local);
  const timer = setTimeout(
    () => settle.reject(new Failure("setting up", "no reply from GitHub before the setup timed out")),
    deps.timeoutMs,
  );
  try {
    const config = await done;
    deps.print(`Created ${config.slug}. Next:`);
    deps.print(
      family === READ_APP
        ? `  1. Install it on every repository you clone on agent machines (it can only read): ${deps.github}/apps/${config.slug}/installations/new`
        : `  1. Install it on each repository agents work in: ${deps.github}/apps/${config.slug}/installations/new`,
    );
    deps.print(`  2. Tick "Enable Device Flow" and save (a manifest cannot set it): ${deps.github}/settings/apps/${config.slug}`);
    deps.print(`  3. Run \`agent-gh login ${family}\` to let it act as you.`);
    deps.print(`  4. Add this line to apps.json in the agent-gh repository and commit it, so other machines need only \`agent-gh login ${family}\`:`);
    deps.print(`     ${registryLine(family, config)}`);
    return config;
  } finally {
    clearTimeout(timer);
    // Graceful: the browser still receives the result page.
    await server.stop();
  }
};

const convert = async (deps: Setup, family: string, code: string): Promise<AppConfig> => {
  const post = await fetchJson(deps.api, `/app-manifests/${code}/conversions`, "POST");
  const { id, slug, client_id, pem } = post;
  if (!Number.isSafeInteger(id) || typeof slug !== "string" || typeof client_id !== "string" || typeof pem !== "string") {
    throw new Failure("setting up", "GitHub's conversion response was invalid");
  }
  const user = await fetchJson(deps.api, `/users/${encodeURIComponent(`${slug}[bot]`)}`, "GET");
  if (!Number.isSafeInteger(user.id)) throw new Failure("setting up", "the bot user's id was invalid");
  const config: AppConfig = {
    client_id,
    app_id: id as number,
    slug,
    bot_login: `${slug}[bot]`,
    bot_user_id: user.id as number,
  };
  writeCredentials(deps.configDir, family, config, pem);
  return config;
};

const fetchJson = async (api: Api, path: string, method: string): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await fetch(`${api.base}${path}`, {
      method,
      headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-gh", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error",
      signal: AbortSignal.timeout(api.timeoutMs),
    });
  } catch {
    throw new Failure("setting up", `could not reach ${new URL(api.base).host}`, true);
  }
  if (!response.ok) throw new Failure("setting up", `HTTP ${response.status} from ${path.split("/")[1]}`);
  try {
    const value: unknown = await response.json();
    if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  } catch {
    // Reported below, without the body.
  }
  throw new Failure("setting up", "invalid response");
};
