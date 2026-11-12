import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Failure } from "../src/failure.ts";
import { MissingInstallation } from "../src/github.ts";
import { REMEMBER_SECONDS, requireInstalled } from "../src/installed.ts";
import { ACCESS, CONFIG, credentials, fakeGitHub, HAPPY, reply } from "./fake-github.ts";

const NOW = 1_800_000_000;
const PENMON = { owner: "johnrees", name: "penmon" };
const SOLTUI = { owner: "johnrees", name: "soltui" };
const ELSEWHERE = { owner: "johnrees", name: "elsewhere" };

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

/** An App installed on `installed`, which a test may change, and a clock it may move. */
const setup = (installed: string[] = ["johnrees/soltui", "johnrees/penmon"]) => {
  const state = { installed, now: NOW };
  const fake = fakeGitHub({
    ...HAPPY,
    "GET /user/installations/42/repositories": () =>
      reply(200, { total_count: state.installed.length, repositories: state.installed.map((full_name) => ({ full_name })) }),
  });
  stops.push(fake.stop);
  const { dir } = credentials();
  const deps = { api: fake.api, dir, nowSeconds: () => state.now };
  const file = join(dir, "claude.installed.json");
  const check = (repo: { owner: string; name: string }, recheck = false) => requireInstalled(deps, CONFIG, "claude", ACCESS, repo, recheck);
  /** How many requests GitHub got since the last count. */
  const asked = () => fake.log.splice(0).length;
  return { state, fake, dir, deps, file, check, asked };
};

test("a yes is remembered for an hour: GitHub is asked once, then again when the hour is up", async () => {
  const { state, file, check, asked } = setup();
  await check(PENMON);
  expect(asked()).toBe(2);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ app: "johnrees-claude", repos: { "johnrees/penmon": NOW } });

  state.now = NOW + REMEMBER_SECONDS - 1;
  await check(PENMON);
  expect(asked()).toBe(0);

  state.now = NOW + REMEMBER_SECONDS;
  await check(PENMON);
  expect(asked()).toBe(2);
  // The hour runs from when GitHub was last asked, not from when the yes was last used.
  expect(JSON.parse(readFileSync(file, "utf8")).repos).toEqual({ "johnrees/penmon": NOW + REMEMBER_SECONDS });
});

test("each repository is remembered on its own, in any case, and an entry past its hour is dropped", async () => {
  const { state, file, check, asked } = setup();
  await check(PENMON);
  state.now = NOW + 60;
  await check({ owner: "JohnRees", name: "Soltui" });
  expect(asked()).toBe(4);
  expect(JSON.parse(readFileSync(file, "utf8")).repos).toEqual({ "johnrees/penmon": NOW, "johnrees/soltui": NOW + 60 });
  await check({ owner: "JOHNREES", name: "PENMON" });
  await check(SOLTUI);
  expect(asked()).toBe(0);

  state.now = NOW + REMEMBER_SECONDS + 30;
  await check(PENMON);
  expect(asked()).toBe(2);
  expect(JSON.parse(readFileSync(file, "utf8")).repos).toEqual({ "johnrees/penmon": NOW + REMEMBER_SECONDS + 30, "johnrees/soltui": NOW + 60 });
  state.now = NOW + REMEMBER_SECONDS + 61;
  await check(PENMON);
  await check(SOLTUI);
  expect(JSON.parse(readFileSync(file, "utf8")).repos).toEqual({ "johnrees/penmon": NOW + REMEMBER_SECONDS + 30, "johnrees/soltui": NOW + REMEMBER_SECONDS + 61 });
});

test("a no is never remembered, so installing the App takes effect at once", async () => {
  const { state, file, check, asked } = setup(["johnrees/soltui"]);
  await expect(check(PENMON)).rejects.toThrow(MissingInstallation);
  await expect(check(PENMON)).rejects.toThrow("the johnrees-claude App is not installed on johnrees/penmon");
  expect(asked()).toBe(4);
  expect(existsSync(file)).toBe(false);

  state.installed.push("johnrees/penmon");
  await check(PENMON);
  await check(PENMON);
  expect(asked()).toBe(2);
});

test("a recheck asks GitHub whatever is remembered, and a no forgets the yes", async () => {
  const { state, file, check, asked } = setup();
  await check(PENMON);
  await check(SOLTUI);
  expect(asked()).toBe(4);
  await check(PENMON, true);
  expect(asked()).toBe(2);

  // The App is removed from penmon: the remembered yes still answers until someone rechecks.
  state.installed.pop();
  await check(PENMON);
  expect(asked()).toBe(0);
  await expect(check(PENMON, true)).rejects.toThrow(MissingInstallation);
  expect(JSON.parse(readFileSync(file, "utf8")).repos).toEqual({ "johnrees/soltui": NOW });
  asked();
  await expect(check(PENMON)).rejects.toThrow(MissingInstallation);
  expect(asked()).toBe(2);
});

test("a check that fails for another reason remembers nothing and forgets nothing", async () => {
  const { fake, dir, file, check } = setup();
  await check(PENMON);
  const before = readFileSync(file, "utf8");
  const down = fakeGitHub({ "GET /user/installations": () => reply(500, {}) });
  stops.push(down.stop);
  const broken = (repo: typeof PENMON, recheck = false) =>
    requireInstalled({ api: down.api, dir, nowSeconds: () => NOW }, CONFIG, "claude", ACCESS, repo, recheck);
  await expect(broken(ELSEWHERE)).rejects.toThrow(Failure);
  await expect(broken(PENMON, true)).rejects.toThrow("HTTP 500");
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(fake.log).toHaveLength(2);
});

test("a file that is not this App's memory, or says the future, remembers nothing and is replaced", async () => {
  const cases = [
    "not json",
    "null",
    "[]",
    JSON.stringify({ app: "johnrees-claude" }),
    JSON.stringify({ app: "johnrees-claude", repos: null }),
    JSON.stringify({ app: "johnrees-codex", repos: { "johnrees/penmon": NOW } }),
    JSON.stringify({ app: "johnrees-claude", repos: { "johnrees/penmon": NOW + 1 } }),
    JSON.stringify({ app: "johnrees-claude", repos: { "johnrees/penmon": "yes" } }),
    JSON.stringify({ app: "johnrees-claude", repos: { "johnrees/penmon": NOW - REMEMBER_SECONDS } }),
  ];
  for (const text of cases) {
    const { file, check, asked } = setup();
    writeFileSync(file, text);
    await check(PENMON);
    expect(asked()).toBe(2);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ app: "johnrees-claude", repos: { "johnrees/penmon": NOW } });
  }
});

test("a config directory that cannot be written is not an error: every command asks GitHub", async () => {
  const { dir, file, check, asked } = setup();
  chmodSync(dir, 0o500);
  try {
    await check(PENMON);
    await check(PENMON);
    expect(asked()).toBe(4);
    expect(existsSync(file)).toBe(false);
    await expect(check(ELSEWHERE)).rejects.toThrow(MissingInstallation);
  } finally {
    chmodSync(dir, 0o700);
  }
  expect(readdirSync(dir).filter((name) => name.includes("installed"))).toEqual([]);
});

test("commands running at once each get their answer, and leave a whole file with no temporary beside it", async () => {
  const { dir, file, check, asked } = setup();
  await Promise.all([check(PENMON), check(SOLTUI), check(PENMON), check(SOLTUI)]);
  expect(asked()).toBe(8);
  const { app, repos } = JSON.parse(readFileSync(file, "utf8"));
  expect(app).toBe("johnrees-claude");
  // Writers race, so one repository's entry may be lost; what is there is true.
  for (const [name, at] of Object.entries(repos)) {
    expect(["johnrees/penmon", "johnrees/soltui"]).toContain(name);
    expect(at).toBe(NOW);
  }
  expect(Object.keys(repos).length).toBeGreaterThan(0);
  expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
