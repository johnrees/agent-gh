import { expect, test } from "bun:test";
import { trailerArgs } from "../src/git.ts";
import type { Identity } from "../src/harness.ts";
import { CONFIG } from "./fake-github.ts";

const OPUS: Identity = { harness: "claude", family: "claude", model: "claude-opus-5-5", effort: "xhigh" };
const CODEX: Identity = { harness: "codex", family: "codex" };
const CO_AUTHOR = "Co-authored-by: johnrees-claude[bot] <123456+johnrees-claude[bot]@users.noreply.github.com>";

test("only what the harness reports becomes an agent trailer, replacing any before it; the App is always the co-author, once", () => {
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
    "--trailer", "Agent-Harness: codex",
    "--if-exists", "addIfDifferent",
    "--trailer", CO_AUTHOR,
  ]);
});
