import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, Registry } from "../src/config.ts";
import { type Answers, credential, familyToken, PUSH_USER, readToken } from "../src/credential.ts";
import { childEnv } from "../src/env.ts";
import { Failure } from "../src/failure.ts";
import { familyNames } from "../src/family.ts";
import { loginAll, loginTargets } from "../src/login.ts";
import { formatLine, machineDoctor } from "../src/machine.ts";
import { ghShim, installShims, RC_FILES, type ShimDeps } from "../src/shims.ts";
import { CONFIG, fakeGitHub, HAPPY, loggedIn, reply } from "./fake-github.ts";

const NOW = 1_800_000_000;
const REGISTRY: Registry = {};
const READ: AppConfig = { ...CONFIG, client_id: "Iv23liREADCLIENT", slug: "johnrees-read", bot_login: "johnrees-read[bot]" };
const CODEX: AppConfig = { ...CONFIG, client_id: "Iv23liCODEXCLIENT", slug: "johnrees-codex", bot_login: "johnrees-codex[bot]" };
const READ_TOKEN = "ghu_read_only_7777";
const FAMILY_TOKEN = "ghu_family_8888";
const root = join(import.meta.dir, "..");

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

/**
 * A machine in a temporary HOME: this checkout as its installed agent-gh, the
 * real git, and a fake gh and gitleaks in one bin directory. The fake gh holds
 * a personal login while `gh-login` exists, and answers git's credential
 * requests with GH_TOKEN as `gh auth git-credential` does. The claude and read
 * Apps exist and are logged in unless `read` is false.
 */
const machine = ({ read = true, rc = [".zshrc", ".bashrc"] } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "agent-gh-home-"));
  const bin = join(home, ".local", "bin");
  const shims = join(home, ".local", "share", "agent-gh", "shims");
  const configDir = join(home, ".config", "agent-gh");
  mkdirSync(bin, { recursive: true });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  for (const name of rc) writeFileSync(join(home, name), "export EDITOR=vi\n");
  const log = join(home, "gh.log");
  const agentGh = join(bin, "agent-gh");
  script(agentGh, `exec '${process.execPath}' '${join(root, "src", "main.ts")}' "$@"`);
  script(
    join(bin, "gh"),
    [
      `echo "gh $*" >> '${log}'`,
      `case "$1 $2" in`,
      `  "auth status") [ -f '${home}/gh-login' ] ;;`,
      `  "auth logout") rm -f '${home}/gh-login' ;;`,
      `  "auth git-credential") printf 'username=x-access-token\\npassword=%s\\n' "$GH_TOKEN" ;;`,
      "esac",
    ].join("\n"),
  );
  script(join(bin, "gitleaks"), "exit 0");
  symlinkSync(Bun.which("git") ?? "/usr/bin/git", join(bin, "git"));
  writeFileSync(join(home, "gh-login"), "");
  writeFileSync(join(configDir, "claude.json"), JSON.stringify(CONFIG));
  loggedIn(configDir, NOW, { access_token: FAMILY_TOKEN });
  if (read) {
    writeFileSync(join(configDir, "read.json"), JSON.stringify(READ));
    loggedIn(configDir, NOW, { access_token: READ_TOKEN }, "read");
  }
  const env = { HOME: home, PATH: `${shims}:${bin}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: "1" };
  const printed: string[] = [];
  const deps: ShimDeps = {
    home,
    shims,
    bin,
    configDir,
    registry: REGISTRY,
    agentGh,
    env,
    nowSeconds: () => NOW,
    print: (line) => printed.push(line),
  };
  const git = (args: string[], stdin = "", extra: Record<string, string> = {}) => {
    const result = Bun.spawnSync([join(bin, "git"), ...args], {
      cwd: home,
      env: { ...env, GIT_TERMINAL_PROMPT: "0", ...extra },
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  const ghLog = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return { home, bin, shims, configDir, env, deps, printed, git, ghLog };
};

const password = (fill: string) => fill.split("\n").find((line) => line.startsWith("password="))?.slice("password=".length);
const GITHUB_FILL = "protocol=https\nhost=github.com\npath=johnrees/penmon.git\n\n";
const PUSH_FILL = `protocol=https\nhost=github.com\nusername=${PUSH_USER}\n\n`;
const AGENT = { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" };

test("git's credential helper answers https://github.com's gets: an agent session with its family App where installed, else the read App", async () => {
  const asked: string[] = [];
  const printed: string[] = [];
  const answers = (inAgentSession: boolean, family: Answers["family"] = async (repo) => `family for ${JSON.stringify(repo)}`): Answers => ({
    inAgentSession,
    read: async () => {
      asked.push("read");
      return READ_TOKEN;
    },
    family,
    print: (line) => printed.push(line),
  });
  const reader = answers(false);
  expect(await credential("get", "protocol=https\nhost=github.com\n\n", reader)).toBe(`username=x-access-token\npassword=${READ_TOKEN}\n`);
  expect(await credential("get", "protocol=https\nhost=gitlab.com\n\n", reader)).toBe("");
  expect(await credential("get", "protocol=http\nhost=github.com\n\n", reader)).toBe("");
  expect(await credential("get", "host=github.com\n\nprotocol=https\n", reader)).toBe("");
  expect(await credential("store", "protocol=https\nhost=github.com\nusername=x\npassword=y\n\n", reader)).toBe("");
  expect(await credential("erase", "protocol=https\nhost=github.com\n\n", reader)).toBe("");
  expect(await credential(undefined, "", reader)).toBe("");
  expect(asked).toEqual(["read"]);

  // A push: the family App for an agent session, checked against the repository git names.
  expect(await credential("get", `${PUSH_FILL.trim()}\npath=johnrees/penmon.git\n\n`, answers(true))).toBe(
    'password=family for {"owner":"johnrees","name":"penmon"}\n',
  );
  expect(await credential("get", PUSH_FILL, answers(true))).toBe("password=family for undefined\n");
  // Anyone else's push quits, so git neither prompts nor tries another login.
  expect(await credential("get", PUSH_FILL, answers(false))).toBe("quit=1\n");
  expect(printed.pop()).toBe(
    "agent-gh: this is an agent machine, and only an agent session pushes to GitHub from it.\nFix what this names, or report it to John; never publish another way (John's own login, gh without agent-gh, or a connector).",
  );
  const unreachable = answers(true, async () => {
    throw new Failure("finding the installation", "could not reach api.github.com", true);
  });
  expect(await credential("get", PUSH_FILL, unreachable)).toBe("quit=1\n");
  expect(printed.pop()).toBe(
    "agent-gh: finding the installation failed: could not reach api.github.com.\nRetry the same command with the sandbox's network access; if it still fails, report it to John. Never publish another way (John's own login, gh without agent-gh, or a connector).",
  );

  // Without the push username (a remote's explicit pushurl, or a read), an agent session with a
  // repository still gets its family App where that App is installed, and the read App where not.
  expect(await credential("get", GITHUB_FILL, answers(true))).toBe(
    'username=x-access-token\npassword=family for {"owner":"johnrees","name":"penmon"}\n',
  );
  const notInstalled = answers(true, async () => {
    throw new Failure("finding the installation", "the johnrees-claude App is not installed on johnrees/penmon");
  });
  expect(await credential("get", GITHUB_FILL, notInstalled)).toBe(`username=x-access-token\npassword=${READ_TOKEN}\n`);
  expect(await credential("get", GITHUB_FILL, unreachable)).toBe(`username=x-access-token\npassword=${READ_TOKEN}\n`);
  expect(await credential("get", "protocol=https\nhost=github.com\n\n", answers(true))).toBe(`username=x-access-token\npassword=${READ_TOKEN}\n`);
  expect(asked).toEqual(["read", "read", "read", "read"]);
  asked.length = 0;
  expect(printed).toEqual([]);
  expect(await credential("get", PUSH_FILL, unreachable)).toBe("quit=1\n");
  expect(printed.pop()).toBe(
    "agent-gh: finding the installation failed: could not reach api.github.com.\nRetry the same command with the sandbox's network access; if it still fails, report it to John. Never publish another way (John's own login, gh without agent-gh, or a connector).",
  );
  const noRead: Answers = {
    ...reader,
    read: async () => {
      throw new Failure("reading the login", "no login for read; run `agent-gh login read` in your own terminal");
    },
  };
  expect(await credential("get", GITHUB_FILL, noRead)).toBe("quit=1\n");
  expect(printed.pop()).toBe(
    "agent-gh: reading the login failed: no login for read; run `agent-gh login read` in your own terminal.\nFix what this names, or report it to John; never publish another way (John's own login, gh without agent-gh, or a connector).",
  );
  expect(asked).toEqual([]);

  const { configDir } = machine();
  const deps = { api: { base: "http://127.0.0.1:9", web: "http://127.0.0.1:9", timeoutMs: 100 }, dir: configDir, registry: REGISTRY, nowSeconds: () => NOW, sleep: async () => {} };
  expect(await readToken(deps)).toBe(READ_TOKEN);
  rmSync(join(configDir, "read.json"));
  await expect(readToken(deps)).rejects.toThrow("agent-gh setup read");
});

test("login --all logs in each App once, keeps going after a failure, and ends with the read App", async () => {
  const fake = fakeGitHub({
    "POST /login/device/code": (body) =>
      new URLSearchParams(body).get("client_id") === CODEX.client_id
        ? reply(200, { error: "device_flow_disabled" })
        : reply(200, { device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }),
    "POST /login/oauth/access_token": () =>
      reply(200, { access_token: "ghu_new_9999", expires_in: 28_800, refresh_token: "ghr_new", refresh_token_expires_in: 15_897_600 }),
    "GET /user": () => reply(200, { login: "johnrees" }),
  });
  stops.push(fake.stop);
  const { configDir } = machine({ read: false });
  writeFileSync(join(configDir, "codex.json"), JSON.stringify(CODEX));
  writeFileSync(join(configDir, "read.json"), JSON.stringify(READ));
  const printed: string[] = [];
  const configured = (name: string) => existsSync(join(configDir, `${name}.json`));
  const targets = loginTargets(familyNames(), undefined, "read", configured);
  expect(targets).toEqual(["claude", "codex", "read"]);
  const failed = await loginAll(targets, {
    api: fake.api,
    dir: configDir,
    registry: REGISTRY,
    github: "https://github.com",
    nowSeconds: () => NOW,
    sleep: async () => {},
    open: () => {},
    print: (line) => printed.push(line),
  });
  expect(failed).toEqual(["codex"]);
  expect(printed[0]).toBe("claude: already logged in");
  expect(printed[1]).toBe("codex: logging in");
  expect(printed[2]).toStartWith("codex: logging in failed: device flow is off for johnrees-codex");
  expect(printed[3]).toBe("read: logging in");
  expect(printed.at(-1)).toStartWith("Logged in: johnrees-read acts as johnrees.");
  expect(JSON.parse(readFileSync(join(configDir, "read.token.json"), "utf8")).access_token).toBe("ghu_new_9999");
  for (const line of printed) expect(line).not.toContain("ghu_new_9999");
});

test("AGENT_GH_FAMILIES limits the families, never drops the read App, and refuses a name no family has", () => {
  const families = familyNames();
  expect(families).not.toContain("read");
  const all = () => true;
  expect(loginTargets(families, " codex , ,claude", "read", all)).toEqual(["claude", "codex", "read"]);
  expect(loginTargets(families, "", "read", all)).toEqual([...families, "read"]);
  expect(loginTargets(families, "glm", "read", (name) => name !== "read")).toEqual(["glm"]);
  expect(() => loginTargets(families, "claude,claud", "read", all)).toThrow("AGENT_GH_FAMILIES names claud");
  expect(() => loginTargets(families, "read", "read", all)).toThrow("AGENT_GH_FAMILIES names read");
});

test("a family token is the session family's, and only once its App is on the repository", async () => {
  const fake = fakeGitHub(HAPPY);
  stops.push(fake.stop);
  const { configDir } = machine();
  const deps = { api: fake.api, dir: configDir, registry: REGISTRY, nowSeconds: () => NOW, sleep: async () => {}, env: AGENT };
  expect(await familyToken(deps, { owner: "johnrees", name: "penmon" })).toBe(FAMILY_TOKEN);
  expect(fake.log.map((entry) => `${entry.method} ${entry.path}`)).toContain("GET /user/installations");
  await expect(familyToken(deps, { owner: "johnrees", name: "elsewhere" })).rejects.toThrow("is not installed on johnrees/elsewhere");
  await expect(familyToken({ ...deps, env: { OPENCODE_TERMINAL: "1" } }, undefined)).rejects.toThrow("opencode does not tell shell commands");
});

test("install-shims --agent-machine: git reads with the read App and pushes with the family App, gh is logged out, and a rerun changes nothing", () => {
  const { home, shims, deps, printed, git, ghLog, configDir } = machine();
  // An older release's git shim is removed; anything else there is not ours to touch.
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(shims, "git"), ghShim(shims, deps.agentGh, false).replace("# gh shim", "# git shim"));
  installShims(deps, true, ["claude"]);
  expect([existsSync(join(shims, "git")), existsSync(join(shims, "gh"))]).toEqual([false, true]);
  expect(printed[0]).toBe(`removed ${join(shims, "git")}: git is plain git, and a repository's commit hook credits the App`);
  expect(JSON.parse(readFileSync(join(configDir, "machine.json"), "utf8"))).toEqual({ agent_machine: true, families: ["claude"] });
  expect(git(["config", "--global", "--get-all", "credential.https://github.com.helper"]).stdout).toBe(`\n!${deps.agentGh} credential\n`);
  expect(git(["config", "--global", "--get-all", "credential.https://github.com.useHttpPath"]).stdout).toBe("true\n");
  expect(ghLog()).toContain("gh auth logout --hostname github.com");
  expect(existsSync(join(home, "gh-login"))).toBe(false);
  expect(existsSync(join(home, ".profile"))).toBe(false);
  const zshrc = readFileSync(join(home, ".zshrc"), "utf8");
  expect(zshrc).toStartWith("export EDITOR=vi\n\n# >>> agent-gh >>>");
  expect(printed.join("\n")).toContain("gh: logged out of your personal login");

  // A rerun changes nothing, and a shared key keeps its other values.
  git(["config", "--global", "--add", "url.https://github.com/.insteadOf", "gh:"]);
  const gitconfig = readFileSync(join(home, ".gitconfig"), "utf8");
  installShims(deps, true, ["claude"]);
  expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe(gitconfig);
  git(["config", "--global", "--unset", "url.https://github.com/.insteadOf", "^git@"]);
  installShims(deps, true, ["claude"]);
  expect(git(["config", "--global", "--get-all", "url.https://github.com/.insteadOf"]).stdout).toBe(
    "ssh://git@github.com/\ngit+ssh://git@github.com/\nssh+git://git@github.com/\nssh://git@ssh.github.com:443/\ngh:\ngit@github.com:\n",
  );
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe(zshrc);
  expect(printed.at(-1)).toBe("gh: no personal login on this machine");

  // A person's git, and an agent's reads, get the read App's token from agent-gh itself.
  const fill = git(["credential", "fill"], GITHUB_FILL);
  expect([fill.code, password(fill.stdout)]).toEqual([0, READ_TOKEN]);
  // (An agent session's read names a repository, which would ask api.github.com: the unit test covers it.)
  expect(password(git(["credential", "fill"], "protocol=https\nhost=github.com\n\n", AGENT).stdout)).toBe(READ_TOKEN);
  expect(git(["credential", "fill"], "protocol=https\nhost=example.com\n\n").code).not.toBe(0);

  // Every GitHub remote uses HTTPS, and pushes, and only pushes, name PUSH_USER, whichever way the remote is written.
  const repo = join(home, "repo");
  git(["init", "-q", repo]);
  for (const [name, url] of [
    ["https", "https://github.com/johnrees/penmon.git"],
    ["scp", "git@github.com:johnrees/penmon.git"],
    ["ssh", "ssh://git@github.com/johnrees/penmon.git"],
    ["gitssh", "git+ssh://git@github.com/johnrees/penmon.git"],
    ["sshgit", "ssh+git://git@github.com/johnrees/penmon.git"],
    ["port443", "ssh://git@ssh.github.com:443/johnrees/penmon.git"],
  ]) {
    git(["-C", repo, "remote", "add", name as string, url as string]);
    expect(git(["-C", repo, "remote", "get-url", "--push", name as string]).stdout).toBe(`https://${PUSH_USER}@github.com/johnrees/penmon.git\n`);
    expect(git(["-C", repo, "remote", "get-url", name as string]).stdout).toBe("https://github.com/johnrees/penmon.git\n");
  }
  // git leaves an explicit pushurl alone for pushInsteadOf, but not for insteadOf: an SSH one uses HTTPS too.
  git(["-C", repo, "remote", "set-url", "--push", "scp", "git@github.com:johnrees/penmon.git"]);
  expect(git(["-C", repo, "remote", "get-url", "--push", "scp"]).stdout).toBe("https://github.com/johnrees/penmon.git\n");
  // An agent session's push gets its family's token; a person's is stopped before git would prompt.
  const push = git(["credential", "fill"], PUSH_FILL, AGENT);
  expect([push.code, password(push.stdout)]).toEqual([0, FAMILY_TOKEN]);
  const person = git(["credential", "fill"], PUSH_FILL, { GIT_TERMINAL_PROMPT: "1" });
  expect(person.code).not.toBe(0);
  expect(person.stderr).toContain("only an agent session pushes to GitHub from it");
  expect(person.stderr).toContain("told us to quit");
  // The gh agent-gh runs replaces every inherited helper with the family token's, for its git too.
  const child = childEnv({}, FAMILY_TOKEN, { owner: "johnrees", name: "penmon" });
  for (const input of [GITHUB_FILL, PUSH_FILL]) {
    const childFill = git(["credential", "fill"], input, child);
    expect([childFill.code, password(childFill.stdout)]).toEqual([0, FAMILY_TOKEN]);
  }
});

test("install-shims --agent-machine refuses, changing nothing, until the read App is logged in", () => {
  const { home, shims, deps, git, ghLog, configDir } = machine({ read: false });
  expect(() => installShims(deps, true, undefined)).toThrow("agent-gh setup read");
  writeFileSync(join(configDir, "read.json"), JSON.stringify(READ));
  let failure: unknown;
  try {
    installShims(deps, true, undefined);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Failure);
  expect((failure as Failure).detail).toContain("run `agent-gh login read`");
  expect(existsSync(shims)).toBe(false);
  expect(existsSync(join(configDir, "machine.json"))).toBe(false);
  expect(git(["config", "--global", "--get-all", "credential.https://github.com.helper"]).code).not.toBe(0);
  expect(ghLog()).toBe("");
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("export EDITOR=vi\n");
});

test("install-shims on a person's own machine leaves git credentials and gh's login alone, and writes .profile when no startup file exists", () => {
  const { home, deps, git, ghLog, configDir } = machine({ read: false, rc: [] });
  installShims(deps, false, undefined);
  expect(JSON.parse(readFileSync(join(configDir, "machine.json"), "utf8"))).toEqual({ agent_machine: false });
  expect(git(["config", "--global", "--get-all", "credential.https://github.com.helper"]).code).not.toBe(0);
  expect(ghLog()).toBe("");
  expect(existsSync(join(home, "gh-login"))).toBe(true);
  expect(RC_FILES.filter((name) => existsSync(join(home, name)))).toEqual([".profile"]);
});

test("doctor --machine passes a set-up agent machine and names the fix for each failure", async () => {
  const { home, bin, deps } = machine();
  installShims(deps, true, ["claude"]);
  const doctor = async (overrides: Partial<ShimDeps> = {}, version = "v0.1.0", latest: string | null = "v0.1.0") =>
    (await machineDoctor({ ...deps, ...overrides, version, latest: async () => latest ?? undefined })).map(formatLine);

  const healthy = await doctor();
  expect(healthy).toEqual([
    "ok   agent-gh: v0.1.0, the latest release",
    `ok   gitleaks: ${join(bin, "gitleaks")}`,
    "ok   login claude: usable",
    "ok   login read: usable",
    `ok   gh shim: ${join(deps.shims, "gh")} is first on PATH`,
    "ok   git credentials: an agent session uses its family App where installed, and anyone else the read App",
    "ok   gh login: no personal login",
  ]);

  expect((await doctor({}, "v0.1.0", "v0.2.0"))[0]).toBe("FAIL agent-gh: v0.1.0, and v0.2.0 is out; rerun the install line");
  expect((await doctor({}, "dev"))[0]).toBe("note agent-gh: a local build, not a release");
  expect((await doctor({}, "v0.1.0", null))[0]).toStartWith("note agent-gh: v0.1.0; the latest release is unknown");

  writeFileSync(join(home, "gh-login"), "");
  rmSync(join(bin, "gitleaks"));
  const env = { ...deps.env, PATH: `${bin}:/usr/bin:/bin:${deps.shims}` };
  const broken = await doctor({ env });
  expect(broken).toContain("FAIL gitleaks: missing; rerun the install line");
  expect(broken).toContain(`FAIL gh shim: ${join(bin, "gh")} comes first, not the shim; open a new shell, or rerun the install line`);
  expect(broken).toContain("FAIL gh login: gh holds your personal login; run `gh auth logout --hostname github.com`");
  rmSync(join(deps.configDir, "read.token.json"));
  expect(await doctor()).toContain("FAIL login read: not logged in; rerun the install line (or `agent-gh login read`)");

  writeFileSync(join(deps.shims, "git"), ghShim(deps.shims, deps.agentGh, true).replace("# gh shim", "# git shim"));
  expect(await doctor()).toContain(`FAIL git shim: ${join(deps.shims, "git")} is left from an older agent-gh; rerun the install line`);
  Bun.spawnSync(["git", "config", "--global", "--unset-all", `url.https://${PUSH_USER}@github.com/.pushInsteadOf`], { env: deps.env });
  Bun.spawnSync(["git", "config", "--global", "--unset", "url.https://github.com/.insteadOf", "^ssh://git@github"], { env: deps.env });
  expect(await doctor()).toContain(
    `FAIL git credentials: not as install-shims sets them: url.https://${PUSH_USER}@github.com/.pushInsteadOf, url.https://github.com/.insteadOf; rerun the install line with --agent-machine`,
  );
});
