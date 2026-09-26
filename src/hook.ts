/**
 * Finds GitHub writes in a shell command that do not go through agent-gh:
 * the check behind hooks/deny-bare-gh.ts. It is a guard against the easy
 * mistake, not a security boundary: `eval`, aliases, and scripts get past it.
 */

/** gh subcommands that write, by command group. */
const GH_WRITES: Readonly<Record<string, readonly string[]>> = {
  pr: ["create", "edit", "comment", "merge", "ready", "review", "close", "reopen"],
  issue: ["create", "edit", "comment", "close", "reopen", "delete"],
  release: ["create", "edit", "delete", "upload"],
  repo: ["create", "edit", "delete", "rename"],
};

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const API_FIELDS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);
/** Words that run the next word as the command. */
const WRAPPERS = new Set(["command", "builtin", "exec", "env", "time", "nohup", "sudo", "xargs"]);
/** git's global options that take a separate value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** Splits a command line into simple commands of words, honouring quotes. */
export const simpleCommands = (line: string): string[][] => {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < line.length; index++) {
    const char = line[index] as string;
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      word += line.slice(index + 1, end === -1 ? undefined : end);
      started = true;
      index = end === -1 ? line.length : end;
    } else if (char === '"') {
      let end = index + 1;
      while (end < line.length && line[end] !== '"') {
        if (line[end] === "\\" && end + 1 < line.length) end++;
        end++;
      }
      word += line.slice(index + 1, end).replace(/\\(.)/g, "$1");
      started = true;
      index = end;
    } else if (char === "\\" && index + 1 < line.length) {
      word += line[index + 1];
      started = true;
      index++;
    } else if (/\s/.test(char)) {
      if (char === "\n") endCommand();
      else endWord();
    } else if (";&|()`".includes(char) || (char === "$" && line[index + 1] === "(")) {
      endCommand();
      if (char === "$") index++;
    } else {
      word += char;
      started = true;
    }
  }
  endCommand();
  return commands;
};

const program = (words: readonly string[]): { name: string; args: string[] } | undefined => {
  let index = 0;
  while (index < words.length) {
    const word = words[index] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) index++;
    else if (WRAPPERS.has(word)) {
      index++;
      while (index < words.length && (words[index] as string).startsWith("-")) index++;
    } else break;
  }
  const name = words[index];
  return name === undefined ? undefined : { name: name.split("/").pop() as string, args: words.slice(index + 1) };
};

const ghApiWrites = (args: readonly string[]): boolean => {
  let method: string | undefined;
  let fields = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "-X" || arg === "--method") method = args[index + 1];
    else if (arg.startsWith("--method=")) method = arg.slice("--method=".length);
    else if (arg.startsWith("-X")) method = arg.slice(2).replace(/^=/, "");
    else if (API_FIELDS.has(arg) || [...API_FIELDS].some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`))) fields = true;
  }
  if (method !== undefined) return WRITE_METHODS.has(method.toUpperCase());
  if (args.find((arg) => !arg.startsWith("-")) === "graphql") return args.some((arg) => /\bmutation\b/.test(arg));
  // gh api sends POST whenever fields or input are given.
  return fields;
};

const ghWrites = (args: readonly string[]): string | undefined => {
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const [group, action] = positional;
  if (group === "api") return ghApiWrites(args.slice(args.indexOf("api") + 1)) ? "gh api (a write)" : undefined;
  if (group !== undefined && action !== undefined && GH_WRITES[group]?.includes(action)) return `gh ${group} ${action}`;
  return undefined;
};

const gitPushes = (args: readonly string[]): boolean => {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    if (GIT_VALUE_OPTIONS.has(arg)) index += 2;
    else if (arg.startsWith("-")) index++;
    else return arg === "push";
  }
  return false;
};

/** The first GitHub write in `line` that skips agent-gh, or undefined. */
export const bareWrite = (line: string): string | undefined => {
  for (const words of simpleCommands(line)) {
    const found = program(words);
    if (found === undefined || found.name === "agent-gh") continue;
    if (found.name === "gh") {
      const write = ghWrites(found.args);
      if (write !== undefined) return write;
    }
    if (found.name === "git" && gitPushes(found.args)) return "git push";
  }
  return undefined;
};

export const denyReason = (write: string): string =>
  `${write} would publish as John. Run GitHub writes through agent-gh so they carry this agent's bot identity: \`agent-gh ${write.replace(/^gh /, "").replace(/ \(a write\)$/, "")} ...\` (git: \`agent-gh git push ...\`).`;
