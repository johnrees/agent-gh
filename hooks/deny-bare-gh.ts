#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook: denies a Bash command that writes to GitHub
 * with gh or pushes with git without going through agent-gh. Register it in
 * ~/.claude/settings.json (README). Unreadable input is reported and allowed:
 * this is a guard, not a boundary.
 */
import { bareWrite, denyReason } from "../src/hook.ts";

let input: unknown;
try {
  input = JSON.parse(await Bun.stdin.text());
} catch {
  console.error("deny-bare-gh: the hook input was not JSON; the command was not checked.");
  process.exit(1);
}

const event = input as { tool_name?: unknown; tool_input?: { command?: unknown } };
if (event.tool_name === "Bash" && typeof event.tool_input?.command === "string") {
  const write = bareWrite(event.tool_input.command);
  if (write !== undefined) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: denyReason(write),
        },
      }),
    );
  }
}
