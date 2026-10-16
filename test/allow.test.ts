import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AllowIo, allowRelease, grantBody, grantCommand, grantProblem, parseAllowArgs, parseGrant, validTag } from "../src/allow.ts";

const HERE = { owner: "johnrees", name: "widget" };
const COMMIT = "c".repeat(40);
const MAIN = join(import.meta.dir, "..", "src", "main.ts");

/**
 * The person's gh against a fake GitHub that holds johnrees/widget's labels
 * and issues: logged in as `login` (logged out when null), and opening
 * issues as GitHub records them, through `app` when one is given.
 */
const personGh = ({ login = "johnrees" as string | null, label = false, app = null as unknown, canLabel = true } = {}) => {
  const calls: string[][] = [];
  const issues: Record<string, unknown>[] = [];
  const labels: string[] = label ? ["agent-release"] : [];
  const fields = (args: readonly string[]) => {
    const out: Record<string, string> = {};
    for (let index = 0; index < args.length; index++) {
      if (args[index] !== "-f") continue;
      const pair = args[++index] as string;
      out[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1);
    }
    return out;
  };
  const gh = async (args: readonly string[]) => {
    calls.push([...args]);
    const [command, path] = args;
    if (command !== "api" || login === null) return { code: 4, stdout: "" };
    if (path === "user") return { code: 0, stdout: `${login}\n` };
    if (path === "repos/johnrees/widget") return { code: 0, stdout: "johnrees\n" };
    if (path === "repos/johnrees/widget/labels/agent-release") return { code: labels.includes("agent-release") ? 0 : 1, stdout: "" };
    if (path === "repos/johnrees/widget/labels") {
      if (!canLabel) return { code: 1, stdout: "" };
      labels.push(fields(args).name as string);
      return { code: 0, stdout: "" };
    }
    if (path === "repos/johnrees/widget/issues") {
      const given = fields(args);
      const issue = {
        number: 52 + issues.length, html_url: `https://github.com/johnrees/widget/issues/${52 + issues.length}`, state: "open", user: { login },
        performed_via_github_app: app, created_at: new Date().toISOString(), title: given.title, body: given.body, labels: [{ name: given["labels[]"] }],
      };
      issues.push(issue);
      return { code: 0, stdout: JSON.stringify(issue) };
    }
    return { code: 1, stdout: "" };
  };
  return { gh, calls, issues, labels };
};

const allowIo = (gh: AllowIo["gh"]) => {
  const printed: string[] = [];
  let out = "";
  const io: AllowIo = { gh, print: (line) => printed.push(line), out: (text) => (out += text) };
  return { io, printed, out: () => out };
};

test("allow release opens the grant as an issue through the person's own gh, labelled, with the marker the guard reads", async () => {
  const person = personGh();
  const { io, printed, out } = allowIo(person.gh);
  expect(await allowRelease(io, HERE, "v1.2.3", COMMIT)).toBe(0);
  expect(person.labels).toEqual(["agent-release"]);
  const [issue] = person.issues as Record<string, unknown>[];
  expect(issue?.title).toBe("Release v1.2.3");
  expect(issue?.labels).toEqual([{ name: "agent-release" }]);
  expect(parseGrant(issue?.body as string)).toEqual({ v: 1, action: "release", tag: "v1.2.3", sha: COMMIT });
  expect(grantProblem(issue as Record<string, unknown>, "johnrees", Date.now())).toBeUndefined();
  expect(out()).toBe("https://github.com/johnrees/widget/issues/52\n");
  expect(printed).toEqual([
    "agent-gh: #52 grants `v1.2.3` in johnrees/widget for 24 hours at cccccccc: an agent may push that tag once and create or edit its release. Close the issue to revoke it.",
  ]);
  // The label is made only when missing; a grant that names no commit takes any.
  const again = personGh({ label: true });
  expect(await allowRelease(allowIo(again.gh).io, HERE, "v2", null)).toBe(0);
  expect(again.calls.some((args) => args[1] === "repos/johnrees/widget/labels")).toBe(false);
  expect(parseGrant(again.issues[0]?.body as string)).toEqual({ v: 1, action: "release", tag: "v2", sha: null });
});

test("where the person's gh is logged out, missing, or someone else, allow release prints the grant to open on GitHub", async () => {
  for (const [gh, why] of [
    [personGh({ login: null }).gh, "gh here is not logged in (an agent machine's gh only reads)"],
    [undefined, "there is no gh here but agent-gh's shims"],
    [personGh({ login: "mallory" }).gh, "a grant counts only when johnrees/widget's owner, johnrees, opens it, and gh here is logged in as mallory"],
  ] as [AllowIo["gh"], string][]) {
    const { io, printed, out } = allowIo(gh);
    expect(await allowRelease(io, HERE, "v1.2.3", COMMIT)).toBe(1);
    expect(printed).toEqual([`agent-gh: ${why}, so open the grant yourself on GitHub, signed in as johnrees:`]);
    const [link, ...rest] = out().split("\n");
    const url = new URL(link as string);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/johnrees/widget/issues/new");
    expect(url.searchParams.get("title")).toBe("Release v1.2.3");
    expect(url.searchParams.get("labels")).toBe("agent-release");
    expect(url.searchParams.get("body")).toBe(grantBody(HERE, "v1.2.3", COMMIT));
    expect(rest.join("\n")).toContain(`title: Release v1.2.3\nlabel: agent-release (create it first if johnrees/widget has none; the guard finds grants by it)\nbody:\n${grantBody(HERE, "v1.2.3", COMMIT)}\n`);
  }
});

test("an issue GitHub records as opened through an App grants nothing, and allow release says so", async () => {
  const person = personGh({ app: { id: 7, slug: "johnrees-claude" } });
  const { io, printed } = allowIo(person.gh);
  expect(await allowRelease(io, HERE, "v1.2.3", null)).toBe(1);
  expect(printed[0]).toBe(
    "agent-gh: #52 was opened through the johnrees-claude App, as an agent's would be, and grants nothing (close it), so open the grant yourself on GitHub, signed in as johnrees:",
  );
});

test("allow release stops before opening a grant the guard could not find, when the label cannot be made", async () => {
  const person = personGh({ canLabel: false });
  let detail = "";
  try {
    await allowRelease(allowIo(person.gh).io, HERE, "v1.2.3", null);
  } catch (error) {
    detail = (error as { detail?: string }).detail ?? String(error);
  }
  expect(detail).toBe("gh could not create the `agent-release` label in johnrees/widget, which the guard finds grants by");
  expect(person.issues).toEqual([]);
});

test("allow release takes one valid tag, a full sha with --at, and -R in gh's spellings", () => {
  expect(parseAllowArgs(["release", "v1.2.3"])).toEqual({ tag: "v1.2.3", sha: null });
  expect(parseAllowArgs(["release", "v1.2.3", "--at", COMMIT.toUpperCase(), "-R", "o/r"])).toEqual({ tag: "v1.2.3", sha: COMMIT });
  expect(parseAllowArgs(["release", "release/1", "--at=" + COMMIT, "--repo=o/r", "-Ro/r"])).toEqual({ tag: "release/1", sha: COMMIT });
  for (const args of [
    [], ["release"], ["tag", "v1"], ["release", "--at", COMMIT], ["release", "v1", "--at", "abc1234"], ["release", "v1", "--at", COMMIT, "--at", COMMIT],
    ["release", "v1", "--force", "x"], ["release", "v1", "-R"], ["release", "v1 2"], ["release", "-v1"], ["release", "v1..2"], ["release", "v1.lock"],
  ]) {
    expect(parseAllowArgs(args)).toBeUndefined();
  }
  expect(["v1", "v1.2.3-rc.1", "release/2026-10", "@v1"].every(validTag)).toBe(true);
  expect(["", "@", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "/a", "a/", "a//b", "a.", ".a", "a/.b", "a@{1}"].some(validTag)).toBe(false);
  expect(grantCommand("v1.2.3", HERE)).toBe("agent-gh allow release v1.2.3 -R johnrees/widget");
  expect(grantCommand("v$1", undefined)).toBe("agent-gh allow release 'v$1'");
});

/** The CLI with a person's `gh` first on PATH: a script that logs its arguments and answers as GitHub would for johnrees. */
const cli = (args: string[], env: Record<string, string>) => {
  const home = mkdtempSync(join(tmpdir(), "agent-gh-allow-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const log = join(home, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `for arg in "$@"; do printf '%s\\037' "$arg"; done >> '${log}'; printf '\\036' >> '${log}'`,
      'case "$1 $2" in',
      '  "api user") [ "${LOGGED_IN-}" = 1 ] || { echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4; }; echo johnrees ;;',
      '  "api repos/johnrees/widget") echo johnrees ;;',
      '  "api repos/johnrees/widget/labels/agent-release") exit 1 ;;',
      '  "api repos/johnrees/widget/labels") ;;',
      `  "api repos/johnrees/widget/issues") printf '{"number":52,"html_url":"https://github.com/johnrees/widget/issues/52","state":"open","user":{"login":"johnrees"},"performed_via_github_app":null,"created_at":"%s"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  const result = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd: home, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env }, stdout: "pipe", stderr: "pipe" });
  let calls: string[][] = [];
  try {
    calls = readFileSync(log, "utf8").split("\x1e").slice(0, -1).map((call) => call.split("\x1f").slice(0, -1));
  } catch {
    // gh never ran.
  }
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), calls };
};

test("agent-gh allow release refuses an agent session, and otherwise runs the person's own gh", () => {
  const agent = cli(["allow", "release", "v1.2.3", "-R", "johnrees/widget"], { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" });
  expect(agent.code).toBe(1);
  expect(agent.stderr).toStartWith(
    "agent-gh: granting a release failed: an agent cannot grant itself a release; John runs `agent-gh allow release v1.2.3` in his own terminal.",
  );
  expect(agent.calls).toEqual([]);
  expect(cli(["allow", "release"], {}).stderr).toStartWith("usage:");
  const out = cli(["allow", "release", "v1.2.3", "-R", "johnrees/widget"], {});
  expect(out.code).toBe(1);
  expect(out.stdout).toStartWith("https://github.com/johnrees/widget/issues/new?");
  expect(out.calls).toEqual([["api", "user", "--jq", ".login"]]);
  const opened = cli(["allow", "release", "v1.2.3", "--at", COMMIT, "-R", "johnrees/widget"], { LOGGED_IN: "1" });
  expect(opened).toMatchObject({ code: 0, stdout: "https://github.com/johnrees/widget/issues/52\n" });
  expect(opened.calls.at(-1)).toEqual(["api", "repos/johnrees/widget/issues", "-f", "title=Release v1.2.3", "-f", `body=${grantBody(HERE, "v1.2.3", COMMIT)}`, "-f", "labels[]=agent-release"]);
});
