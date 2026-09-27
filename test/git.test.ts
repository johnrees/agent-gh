import { expect, test } from "bun:test";
import { ABSENT, trailerArgs, withoutAbsent } from "../src/git.ts";
import type { Identity } from "../src/harness.ts";
import { CONFIG } from "./fake-github.ts";

const OPUS: Identity = { harness: "claude", family: "claude", model: "claude-opus-5-5", effort: "xhigh" };
const CODEX: Identity = { harness: "codex", family: "codex" };
const CO_AUTHOR = "Co-authored-by: johnrees-claude[bot] <123456+johnrees-claude[bot]@users.noreply.github.com>";

test("the agent trailers replace any before them, marking what the harness does not report; the App is the co-author, once", () => {
  expect(trailerArgs(OPUS, CONFIG)).toEqual([
    "--if-exists", "replace",
    "--trailer", "Agent-Model: claude-opus-5-5",
    "--trailer", "Agent-Harness: claude",
    "--trailer", "Agent-Effort: xhigh",
    "--if-exists", "addIfDifferent",
    "--trailer", CO_AUTHOR,
  ]);
  expect(trailerArgs(CODEX, CONFIG)).toEqual([
    "--if-exists", "replace",
    "--trailer", `Agent-Model: ${ABSENT}`,
    "--trailer", "Agent-Harness: codex",
    "--trailer", `Agent-Effort: ${ABSENT}`,
    "--if-exists", "addIfDifferent",
    "--trailer", CO_AUTHOR,
  ]);
  expect(withoutAbsent(`x\n\nAgent-Model: ${ABSENT}\nAgent-Harness: codex\nAgent-Effort: ${ABSENT}\n${CO_AUTHOR}\n`)).toBe(
    `x\n\nAgent-Harness: codex\n${CO_AUTHOR}\n`,
  );
});
