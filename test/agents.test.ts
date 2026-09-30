import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeHookState,
  installClaudeHook,
  installInstructions,
  instructionsBlock,
  pathOwner,
  sessionEnvCommand,
  staleInstructions,
} from "../src/agents.ts";
import { shimAdvice } from "../src/machine.ts";

const root = join(import.meta.dir, "..");
const home = () => mkdtempSync(join(tmpdir(), "agent-gh-agents-"));
const AGENT_GH = "/home/someone/.local/bin/agent-gh";

test("no Claude Code directory, no hook", () => {
  const dir = home();
  expect(installClaudeHook(dir, AGENT_GH)).toBeUndefined();
  expect(claudeHookState(dir, AGENT_GH)).toBe("absent");
});

test("the Claude Code hook keeps every other setting and hook, and is written once", () => {
  const dir = home();
  mkdirSync(join(dir, ".claude"));
  const other = { matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] };
  const settings = { model: "opus", hooks: { SessionStart: [other], PreToolUse: [{ matcher: "Bash", hooks: [] }] } };
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(settings));
  expect(claudeHookState(dir, AGENT_GH)).toBe("missing");

  installClaudeHook(dir, AGENT_GH);
  installClaudeHook(dir, AGENT_GH);
  const written = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  expect(written.model).toBe("opus");
  expect(written.hooks.PreToolUse).toEqual(settings.hooks.PreToolUse);
  expect(written.hooks.SessionStart).toEqual([other, { hooks: [{ type: "command", command: `${AGENT_GH} session-env` }] }]);
  expect(claudeHookState(dir, AGENT_GH)).toBe("ok");

  // agent-gh moved: the old entry is replaced, not duplicated.
  expect(claudeHookState(dir, "/opt/agent-gh")).toBe("stale");
  installClaudeHook(dir, "/opt/agent-gh");
  const moved = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  expect(moved.hooks.SessionStart).toEqual([other, { hooks: [{ type: "command", command: "/opt/agent-gh session-env" }] }]);
});

test("the Claude Code hook refuses settings that are not JSON, leaving them as they are", () => {
  const dir = home();
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "settings.json"), "{ nope");
  expect(() => installClaudeHook(dir, AGENT_GH)).toThrow("not valid JSON");
  expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toBe("{ nope");
});

test("a path with spaces is quoted in the hook command", () => {
  expect(sessionEnvCommand("/Users/j s/agent-gh")).toBe("'/Users/j s/agent-gh' session-env");
});

test("instructions go to each harness that has run here, once, and keep what is there", () => {
  const dir = home();
  expect(installInstructions(dir)).toEqual([]);
  mkdirSync(join(dir, ".claude"));
  mkdirSync(join(dir, ".codex"));
  writeFileSync(join(dir, ".claude", "CLAUDE.md"), "# Mine\n\nKeep this.\n");
  expect(staleInstructions(dir)).toEqual([join(dir, ".claude", "CLAUDE.md"), join(dir, ".codex", "AGENTS.md")]);
  installInstructions(dir);
  installInstructions(dir);
  const claude = readFileSync(join(dir, ".claude", "CLAUDE.md"), "utf8");
  expect(claude).toBe(`# Mine\n\nKeep this.\n\n${instructionsBlock()}\n`);
  expect(readFileSync(join(dir, ".codex", "AGENTS.md"), "utf8")).toBe(`${instructionsBlock()}\n`);
  expect(staleInstructions(dir)).toEqual([]);

  // An older block is rewritten in place.
  writeFileSync(join(dir, ".codex", "AGENTS.md"), "top\n<!-- >>> agent-gh >>> -->\nold\n<!-- <<< agent-gh <<< -->\nbottom\n");
  installInstructions(dir);
  expect(readFileSync(join(dir, ".codex", "AGENTS.md"), "utf8")).toBe(`top\n${instructionsBlock()}\nbottom\n`);
});

test("doctor names the version manager that puts its gh ahead of the shim", () => {
  expect(pathOwner("/home/j/.local/share/mise/installs/gh/latest/bin/gh")).toBe("mise");
  expect(pathOwner("/home/j/.asdf/shims/gh")).toBe("asdf");
  expect(pathOwner("/opt/homebrew/bin/gh")).toBe("Homebrew");
  expect(pathOwner("/nix/store/abc-gh/bin/gh")).toBe("Nix");
  expect(pathOwner("/usr/bin/gh")).toBeUndefined();
  expect(shimAdvice("/home/j/.local/share/mise/installs/gh/latest/bin/gh")).toContain("mise puts its directories ahead");
  expect(shimAdvice("/usr/bin/gh")).toBe("/usr/bin/gh comes first, not the shim; open a new shell, or rerun the install line");
});

test("session-env writes a PATH block that puts the shim first when sourced, and never fails the session", () => {
  const dir = home();
  const envFile = join(dir, "claude-env");
  const env = { HOME: dir, PATH: process.env.PATH ?? "", CLAUDE_ENV_FILE: envFile };
  const run = (extra: Record<string, string> = {}) =>
    Bun.spawnSync([process.execPath, join(root, "src", "main.ts"), "session-env"], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  expect(run().exitCode).toBe(0);
  const shims = join(dir, ".local", "share", "agent-gh", "shims");
  const sourced = Bun.spawnSync(["sh", "-c", `PATH=/first:/usr/bin:${shims}; . '${envFile}'; echo "$PATH"`], { stdout: "pipe" });
  expect(sourced.stdout.toString().trim()).toBe(`${shims}:${join(dir, ".local", "bin")}:/first:/usr/bin`);

  expect(run({ CLAUDE_ENV_FILE: join(dir, "missing", "dir", "file") }).exitCode).toBe(0);
  expect(run({ CLAUDE_ENV_FILE: "" }).exitCode).toBe(0);
});
