import { afterEach, describe as group, expect, test } from "bun:test";
import { verify } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, Failure } from "../src/failure.ts";
import { mintToken } from "../src/github.ts";
import { type Context, runAs } from "../src/run.ts";
import { CONFIG, credentials, fakeGitHub, HAPPY, reply, SECRET_BODY, SECRET_HEADER } from "./fake-github.ts";

const NOW = 1_800_000_000;
let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

const setup = (routes: Record<string, (body: string) => Response> = HAPPY) => {
  const fake = fakeGitHub(routes);
  stops.push(fake.stop);
  const creds = credentials();
  const out = join(mkdtempSync(join(tmpdir(), "agent-gh-out-")), "env.json");
  const warnings: string[] = [];
  const context: Context = {
    harness: "claude",
    repo: { owner: "johnrees", name: "penmon" },
    env: { PATH: process.env.PATH, OUT: out, GH_DEBUG: "api", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" },
    api: fake.api,
    configDir: creds.dir,
    nowSeconds: () => NOW,
    warn: (line) => warnings.push(line),
  };
  return { fake, creds, out, warnings, context };
};

/** A child that records its environment, then exits with `code`. */
const recorder = (code = 0) => [
  process.execPath,
  "-e",
  `require("node:fs").writeFileSync(process.env.OUT, JSON.stringify(process.env)); process.exit(${code})`,
];

const failure = async (promise: Promise<unknown>): Promise<Failure> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Failure) return error;
    throw error;
  }
  throw new Error("expected a Failure");
};

const clean = (message: string, secrets: readonly string[]) => {
  for (const secret of [SECRET_BODY, SECRET_HEADER, "BEGIN RSA", "ghs_test_token_1234", "eyJ", ...secrets]) {
    expect(message).not.toContain(secret);
  }
};

group("a command runs with a token for one repository", () => {
  test("the JWT is signed by the App key with the right claims", async () => {
    const { fake, creds, context } = setup();
    expect(await runAs(context, recorder())).toBe(0);
    const lookup = fake.log[0];
    expect(lookup?.method).toBe("GET");
    expect(lookup?.path).toBe("/repos/johnrees/penmon/installation");
    const jwt = lookup?.auth.replace(/^Bearer /, "") ?? "";
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toEqual({
      iat: NOW - 60,
      exp: NOW + 540,
      iss: CONFIG.client_id,
    });
    expect(
      verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), creds.publicKey, Buffer.from(signature ?? "", "base64url")),
    ).toBe(true);
  });

  test("the token is requested for exactly that repository, then revoked", async () => {
    const { fake, context } = setup();
    await runAs(context, recorder());
    expect(fake.log.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /repos/johnrees/penmon/installation",
      "POST /app/installations/42/access_tokens",
      "DELETE /installation/token",
    ]);
    expect(JSON.parse(fake.log[1]?.body ?? "")).toEqual({ repositories: ["penmon"] });
    expect(fake.log[1]?.auth).toStartWith("Bearer eyJ");
    expect(fake.log[2]?.auth).toBe("Bearer ghs_test_token_1234");
  });

  test("the child gets the token and the bot's identity", async () => {
    const { out, context } = setup();
    await runAs(context, recorder());
    const env = JSON.parse(readFileSync(out, "utf8"));
    expect(env.GH_TOKEN).toBe("ghs_test_token_1234");
    expect(env.GITHUB_TOKEN).toBe("ghs_test_token_1234");
    expect(env.GH_REPO).toBe("johnrees/penmon");
    expect(env.GIT_AUTHOR_NAME).toBe("johnrees-claude[bot]");
    expect(env.GIT_COMMITTER_EMAIL).toBe("123456+johnrees-claude[bot]@users.noreply.github.com");
    expect(env.GH_DEBUG).toBeUndefined();
  });

  test("the child's exit code is returned and the token is still revoked", async () => {
    const { fake, context } = setup();
    expect(await runAs(context, recorder(3))).toBe(3);
    expect(fake.log.at(-1)?.path).toBe("/installation/token");
  });

  test("a failed revocation warns and keeps the child's exit code", async () => {
    const { warnings, context } = setup({ ...HAPPY, "DELETE /installation/token": () => reply(500, { message: SECRET_BODY }) });
    expect(await runAs(context, recorder(0))).toBe(0);
    expect(warnings).toEqual(["agent-gh: the temporary token could not be revoked; it expires within one hour."]);
  });

  test("the key buffer is zeroed after signing", async () => {
    const { fake, creds } = setup();
    const key = readFileSync(join(creds.dir, "claude.pem"));
    await mintToken(fake.api, CONFIG, key, { owner: "johnrees", name: "penmon" }, NOW);
    expect(key.every((byte) => byte === 0)).toBe(true);
  });
});

group("every failure names its stage and carries no secret", () => {
  test("the App is not installed on the repository", async () => {
    const { context } = setup({});
    const error = await failure(runAs(context, recorder()));
    expect(error.stage).toBe("finding the installation");
    expect(error.detail).toBe(
      "the johnrees-claude App is not installed on johnrees/penmon; install it at https://github.com/apps/johnrees-claude/installations/new and select johnrees/penmon",
    );
    clean(describe(error), []);
  });

  const cases: [string, Record<string, (body: string) => Response>, string, string][] = [
    ["an installation error", { "GET /repos/johnrees/penmon/installation": () => reply(500, { m: SECRET_BODY }) }, "finding the installation", "HTTP 500"],
    [
      "a refused token",
      { ...HAPPY, "POST /app/installations/42/access_tokens": () => reply(403, { m: SECRET_BODY }) },
      "requesting the token",
      "HTTP 403",
    ],
    [
      "a token response without a token",
      { ...HAPPY, "POST /app/installations/42/access_tokens": () => reply(201, { m: SECRET_BODY }) },
      "requesting the token",
      "invalid response",
    ],
    [
      "an installation response that is not JSON",
      { "GET /repos/johnrees/penmon/installation": () => new Response(SECRET_BODY, { status: 200 }) },
      "finding the installation",
      "invalid response",
    ],
  ];
  for (const [name, routes, stage, detail] of cases) {
    test(name, async () => {
      const { context } = setup(routes);
      const error = await failure(runAs(context, recorder()));
      expect([error.stage, error.detail]).toEqual([stage, detail]);
      clean(describe(error), []);
    });
  }

  test("GitHub cannot be reached", async () => {
    const { context } = setup();
    const error = await failure(runAs({ ...context, api: { base: "http://127.0.0.1:1", timeoutMs: 2000 } }, recorder()));
    expect([error.stage, error.detail]).toEqual(["finding the installation", "could not reach 127.0.0.1:1"]);
  });

  test("no config tells John to run setup", async () => {
    const { context } = setup();
    const error = await failure(runAs({ ...context, harness: "codex" }, recorder()));
    expect(error.stage).toBe("reading config");
    expect(error.detail).toContain("run `agent-gh setup codex` in your own terminal");
  });

  test("a config that is not an App config", async () => {
    const { creds, context } = setup();
    writeFileSync(join(creds.dir, "claude.json"), JSON.stringify({ client_id: "x" }));
    const error = await failure(runAs(context, recorder()));
    expect(error.stage).toBe("reading config");
    expect(error.detail).toEndWith("is not an agent-gh App config");
  });

  test("a key other users can read is refused", async () => {
    const { creds, context } = setup();
    chmodSync(join(creds.dir, "claude.pem"), 0o644);
    const error = await failure(runAs(context, recorder()));
    expect(error.stage).toBe("reading key");
    expect(error.detail).toContain("chmod 600");
    clean(describe(error), [creds.pem.slice(40, 80)]);
  });

  test("a key that cannot sign", async () => {
    const { creds, context } = setup();
    writeFileSync(join(creds.dir, "claude.pem"), "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n", {
      mode: 0o600,
    });
    const error = await failure(runAs(context, recorder()));
    expect([error.stage, error.detail]).toEqual(["signing", "the johnrees-claude private key could not sign a JWT"]);
  });

  test("a child that cannot start still revokes the token", async () => {
    const { fake, context } = setup();
    const error = await failure(runAs(context, ["agent-gh-no-such-program-7b1d"]));
    expect([error.stage, error.detail]).toEqual(["starting the child", "agent-gh-no-such-program-7b1d could not be started"]);
    expect(fake.log.at(-1)?.path).toBe("/installation/token");
    clean(describe(error), []);
  });
});
