import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Failure } from "./failure.ts";
import { writeAtomic } from "./files.ts";

/**
 * What install-shims tells the agent harnesses themselves, beside the shell
 * startup files. A harness does not always start its tools from those files
 * as a person's shell does (Claude Code runs a snapshot of the environment it
 * was started in), and a version manager such as mise, asdf, or Homebrew's
 * shellenv can put its own gh back ahead of the shim after they run. So Claude
 * Code gets a SessionStart hook that puts the shim first before every command,
 * and every harness's global instructions say what to do when gh still says
 * it is not logged in.
 */

const quoteArg = (value: string): string => (/^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/** The SessionStart hook's command: agent-gh writes the PATH block to CLAUDE_ENV_FILE. */
export const sessionEnvCommand = (agentGh: string): string => `${quoteArg(agentGh)} session-env`;

const SESSION_ENV = / session-env$/;

type Hook = { type?: unknown; command?: unknown };
type Matcher = { matcher?: unknown; hooks?: unknown };

const isOurs = (entry: Matcher): boolean =>
  Array.isArray(entry.hooks) &&
  entry.hooks.some((hook: Hook) => typeof hook.command === "string" && /agent-gh/.test(hook.command) && SESSION_ENV.test(hook.command));

const readSettings = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Failure("installing the shims", `${path} is not valid JSON; fix it, then rerun the install line`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Failure("installing the shims", `${path} is not a JSON object; fix it, then rerun the install line`);
  }
  return value as Record<string, unknown>;
};

const sessionStart = (settings: Record<string, unknown>): Matcher[] => {
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null) return [];
  const entries = (hooks as Record<string, unknown>).SessionStart;
  return Array.isArray(entries) ? (entries as Matcher[]) : [];
};

export const claudeDir = (home: string): string => join(home, ".claude");
const claudeSettings = (home: string): string => join(claudeDir(home), "settings.json");

/**
 * Adds, or rewrites, agent-gh's SessionStart hook in ~/.claude/settings.json,
 * keeping every other setting and hook. Only where Claude Code has run (its
 * directory exists). Returns the settings path it wrote, or undefined.
 */
export const installClaudeHook = (home: string, agentGh: string): string | undefined => {
  if (!existsSync(claudeDir(home))) return undefined;
  const path = claudeSettings(home);
  const settings = readSettings(path);
  const ours: Matcher = { hooks: [{ type: "command", command: sessionEnvCommand(agentGh) }] };
  const kept = sessionStart(settings).filter((entry) => !isOurs(entry));
  const hooks = typeof settings.hooks === "object" && settings.hooks !== null ? (settings.hooks as Record<string, unknown>) : {};
  const next = { ...settings, hooks: { ...hooks, SessionStart: [...kept, ours] } };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeAtomic(path, text);
  return path;
};

/** Whether Claude Code is absent, or has agent-gh's hook with this agent-gh. */
export const claudeHookState = (home: string, agentGh: string): "absent" | "ok" | "missing" | "stale" => {
  if (!existsSync(claudeDir(home))) return "absent";
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(claudeSettings(home));
  } catch {
    return "missing";
  }
  const ours = sessionStart(settings).filter(isOurs);
  if (ours.length === 0) return "missing";
  const want = sessionEnvCommand(agentGh);
  return ours.some((entry) => (entry.hooks as Hook[]).some((hook) => hook.command === want)) ? "ok" : "stale";
};

const BEGIN = "<!-- >>> agent-gh >>> -->";
const END = "<!-- <<< agent-gh <<< -->";

/** The global instructions block: plain gh first, and what to do when it says it is not logged in. */
export const instructionsBlock = (): string =>
  [
    BEGIN,
    "## GitHub (managed by `agent-gh install-shims`)",
    "",
    "GitHub access on this machine goes through agent-gh, which acts as John with this agent family's GitHub App. Run plain `gh` and `git`; do not ask John to run `gh auth login`.",
    "",
    "- If `gh` says it is not logged in, or a private repository is not found, gh is not going through agent-gh's shim. Run the same command as `agent-gh <gh arguments>` (for example `agent-gh pr view 12 -R owner/repo`) instead.",
    "- For a read where that fails too, `GH_TOKEN=$(agent-gh read-token) gh <arguments>` reads with the read-only App.",
    "- Commit with plain `git commit`: a commit-msg hook adds `Agent-*` trailers and `Co-authored-by: johnrees-<family>[bot]`. If a commit you made lacks that co-author line, the hook did not run; run `agent-gh doctor` in the repository and say so, rather than adding the trailers by hand.",
    "- `agent-gh doctor --machine` shows what is set up wrong; tell John its FAIL lines rather than working around them silently.",
    END,
  ].join("\n");

/** `text` with the managed block replaced, or appended once when absent. */
const withInstructions = (text: string, block: string): string => {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start !== -1 && end > start) return `${text.slice(0, start)}${block}${text.slice(end + END.length)}`;
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${text === "" ? "" : "\n"}${block}\n`;
};

/** Each harness's global instructions file, for harnesses that have run here (their directory exists). */
export const instructionFiles = (home: string): string[] =>
  [
    [".claude", "CLAUDE.md"],
    [".codex", "AGENTS.md"],
    [".config/opencode", "AGENTS.md"],
    [".pi/agent", "AGENTS.md"],
  ]
    .filter(([dir]) => existsSync(join(home, dir as string)))
    .map(([dir, file]) => join(home, dir as string, file as string));

export const installInstructions = (home: string): string[] => {
  const files = instructionFiles(home);
  const block = instructionsBlock();
  for (const path of files) {
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const next = withInstructions(text, block);
    if (next !== text) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeAtomic(path, next);
    }
  }
  return files;
};

/** Instruction files that lack the current block. */
export const staleInstructions = (home: string): string[] =>
  instructionFiles(home).filter((path) => !existsSync(path) || !readFileSync(path, "utf8").includes(instructionsBlock()));

/**
 * Names a version manager or package manager from the directory of the gh
 * that comes before the shim, for doctor's advice. Undefined when unknown.
 */
export const pathOwner = (program: string): string | undefined => {
  const rules: [RegExp, string][] = [
    [/\/mise\//, "mise"],
    [/\/\.asdf\//, "asdf"],
    [/\/\.nix-profile\/|^\/nix\//, "Nix"],
    [/^\/(opt\/homebrew|home\/linuxbrew\/\.linuxbrew|usr\/local\/Homebrew)\//, "Homebrew"],
    [/\/\.proto\//, "proto"],
    [/\/aquaproj-aqua\//, "aqua"],
  ];
  return rules.find(([pattern]) => pattern.test(program))?.[1];
};
