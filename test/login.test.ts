import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, Failure } from "../src/failure.ts";
import { login } from "../src/login.ts";
import { CONFIG, credentials, fakeGitHub, reply, SECRET_BODY } from "./fake-github.ts";

const NOW = 1_800_000_000;
let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

const DEVICE = {
  device_code: "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};
const TOKEN = {
  access_token: "ghu_device_5555",
  expires_in: 28_800,
  refresh_token: "ghr_device_6666",
  refresh_token_expires_in: 15_897_600,
  token_type: "bearer",
  scope: "",
};

type Step = Record<string, unknown>;

/** GitHub's device flow: the device code reply, then one reply per poll, in order. */
const flow = (device: Step, polls: Step[]) => {
  const bodies: Record<string, string>[] = [];
  let poll = 0;
  const fake = fakeGitHub({
    "POST /login/device/code": (body) => {
      bodies.push(Object.fromEntries(new URLSearchParams(body)));
      return reply(200, device);
    },
    "POST /login/oauth/access_token": (body) => {
      bodies.push(Object.fromEntries(new URLSearchParams(body)));
      return reply(200, polls[Math.min(poll++, polls.length - 1)]);
    },
    "GET /user": () => reply(200, { login: "johnrees" }),
  });
  stops.push(fake.stop);
  const creds = credentials();
  const waits: number[] = [];
  const printed: string[] = [];
  const opened: string[] = [];
  let now = NOW;
  const run = () =>
    login("claude", {
      api: fake.api,
      dir: creds.dir,
      github: "https://github.com",
      nowSeconds: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms / 1000;
      },
      open: (url) => opened.push(url),
      print: (line) => printed.push(line),
    });
  return { fake, creds, bodies, waits, printed, opened, run };
};

const failure = async (promise: Promise<unknown>): Promise<Failure> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Failure) return error;
    throw error;
  }
  throw new Error("expected a Failure");
};

test("John approves after two polls; slow_down adds five seconds; the token pair is stored", async () => {
  const { creds, bodies, waits, printed, opened, run } = flow(DEVICE, [
    { error: "authorization_pending" },
    { error: "slow_down", interval: 10 },
    TOKEN,
  ]);
  expect(await run()).toBe("johnrees");
  expect(bodies[0]).toEqual({ client_id: CONFIG.client_id });
  expect(bodies[1]).toEqual({
    client_id: CONFIG.client_id,
    device_code: DEVICE.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  expect(waits).toEqual([5000, 5000, 10_000]);
  expect(printed[0]).toBe("Open https://github.com/login/device and enter WDJB-MJHT to let johnrees-claude act as you.");
  expect(printed[1]).toStartWith("Logged in: johnrees-claude acts as johnrees.");
  expect(opened).toEqual(["https://github.com/login/device"]);
  const path = join(creds.dir, "claude.token.json");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    access_token: "ghu_device_5555",
    expires_at: NOW + 20 + 28_800,
    refresh_token: "ghr_device_6666",
    refresh_expires_at: NOW + 20 + 15_897_600,
  });
  for (const line of printed) expect(line).not.toContain("ghu_device_5555");
  for (const body of bodies) expect(Object.keys(body)).not.toContain("client_secret");
});

test("slow_down without an interval still adds five seconds", async () => {
  const { waits, run } = flow(DEVICE, [{ error: "slow_down" }, TOKEN]);
  await run();
  expect(waits).toEqual([5000, 10_000]);
});

test("an App that does not expire user tokens stores a token with no refresh", async () => {
  const { creds, run } = flow(DEVICE, [{ access_token: "ghu_forever_7777", token_type: "bearer", scope: "" }]);
  await run();
  expect(JSON.parse(readFileSync(join(creds.dir, "claude.token.json"), "utf8"))).toEqual({
    access_token: "ghu_forever_7777",
    expires_at: null,
    refresh_token: null,
    refresh_expires_at: null,
  });
});

const refused: [string, Step, Step[], string][] = [
  [
    "device flow off at the code request",
    { error: "device_flow_disabled", error_description: SECRET_BODY },
    [],
    'device flow is off for johnrees-claude; tick "Enable Device Flow" at https://github.com/settings/apps/johnrees-claude, save, then run `agent-gh login` again',
  ],
  [
    "device flow off while polling",
    DEVICE,
    [{ error: "device_flow_disabled" }],
    'device flow is off for johnrees-claude; tick "Enable Device Flow" at https://github.com/settings/apps/johnrees-claude, save, then run `agent-gh login` again',
  ],
  ["John cancels", DEVICE, [{ error: "access_denied" }], "the authorization was cancelled on github.com"],
  ["the code expires on GitHub's side", DEVICE, [{ error: "expired_token" }], "the code expired before it was entered; run `agent-gh login claude` again"],
  ["an unknown error", DEVICE, [{ error: "incorrect_client_credentials" }], "GitHub refused the login (incorrect_client_credentials)"],
  ["an error that is not a code", DEVICE, [{ error: `<${SECRET_BODY}>` }], "GitHub refused the login (an unrecognised error)"],
];
for (const [name, device, polls, detail] of refused) {
  test(name, async () => {
    const { run } = flow(device, polls);
    const error = await failure(run());
    expect([error.stage, error.detail]).toEqual(["logging in", detail]);
    expect(describe(error)).not.toContain(SECRET_BODY);
  });
}

test("a code nobody enters expires on our clock too", async () => {
  const { run } = flow({ ...DEVICE, expires_in: 12 }, [{ error: "authorization_pending" }]);
  const error = await failure(run());
  expect(error.detail).toBe("the code expired before it was entered; run `agent-gh login claude` again");
});
