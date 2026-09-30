import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { installClaudeHook, installInstructions } from "./agents.ts";
import { READ_APP, readConfig, type Registry } from "./config.ts";
import { PUSH_USER } from "./credential.ts";
import { CHILD_MARKER } from "./env.ts";
import { Failure } from "./failure.ts";
import { type Env, HARNESSES, harnessNames } from "./harness.ts";
import { loginUsable } from "./login.ts";
import { VERSION } from "./version.ts";

/** Where `install-shims` writes the gh shim; first on PATH. */
export const defaultShimDir = (): string => join(homedir(), ".local", "share", "agent-gh", "shims");
export const defaultBinDir = (): string => join(homedir(), ".local", "bin");

/** What `install-shims` records about the machine, beside the logins. */
export type Machine = { readonly agent_machine: boolean; readonly families?: readonly string[] };

export const readMachine = (dir: string): Machine => {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dir, "machine.json"), "utf8"));
    if (typeof value === "object" && value !== null && (value as Record<string, unknown>).agent_machine === true) {
      const families = (value as Record<string, unknown>).families;
      return Array.isArray(families) && families.every((name) => typeof name === "string")
        ? { agent_machine: true, families }
        : { agent_machine: true };
    }
  } catch {
    // No record: a machine John also works on.
  }
  return { agent_machine: false };
};

const quote = (value: string): string => {
  if (value.includes("'")) throw new Failure("installing the shims", `${value} contains a single quote`);
  return `'${value}'`;
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The harness table as a POSIX shell function, so the shim decides exactly as
 * agent-gh does, with shell builtins only: no process starts on a person's
 * gh. `agh_set` mirrors agent-gh's "set": present and not blank.
 */
export const sessionFunction = (): string => {
  const rules = HARNESSES.flatMap((harness) =>
    harness.rules.map((rule) => {
      const tests = rule.map((condition) => {
        if (!NAME.test(condition.name)) throw new Failure("installing the shims", `bad variable name ${condition.name}`);
        return condition.equals === undefined
          ? `agh_set "\${${condition.name}-}"`
          : `[ "\${${condition.name}-}" = ${quote(condition.equals)} ]`;
      });
      return `  { ${tests.join(" && ")}; } && return 0 # ${harness.name}`;
    }),
  );
  return [
    "agh_set() { case $1 in *[![:space:]]*) return 0 ;; esac; return 1; }",
    "agh_session() {",
    ...rules,
    `  case \${AGENT_GH_HARNESS-} in ${harnessNames().map(quote).join(" | ")}) return 0 ;; esac # a runner that names its harness`,
    "  return 1",
    "}",
  ].join("\n");
};

/** How many agent-gh shims one process may run in turn before the next refuses. */
export const SHIM_HOPS = 3;

/**
 * Finds the next `$1` on PATH into AGH_REAL, without a subshell. It skips the
 * shim directory and the running script itself (its own directory when the
 * names match, and any path to the same file), so a copy of the shim, such as
 * a test fixture's copy of `command -v gh`, finds the real program instead of
 * itself. A shim that reaches another shim execs it in the same process, so
 * AGH_SHIM_PID equal to `$$` counts one more hop, and shims that keep reaching
 * each other fail loudly instead of looping. A program that runs gh again
 * starts a new process, which starts a new count.
 */
export const realFunction = (shims: string) =>
  [
    `AGH_SHIMS=${quote(shims)}`,
    "agh_real() {",
    '  if [ "${AGH_SHIM_PID-}" = "$$" ]; then',
    "    AGH_SHIM_HOPS=$(( ${AGH_SHIM_HOPS:-0} + 1 ))",
    '    AGH_SHIM_TRAIL="${AGH_SHIM_TRAIL-}, $0"',
    "  else",
    "    AGH_SHIM_HOPS=0",
    "    AGH_SHIM_TRAIL=$0",
    "  fi",
    `  if [ "$AGH_SHIM_HOPS" -ge ${SHIM_HOPS} ]; then`,
    '    echo "agent-gh shim: $AGH_SHIM_TRAIL ran in turn and never reached the real $1: a copy of the shim, or a wrapper that runs $1 from PATH, is ahead of it. Copy the real $1 instead: \\$(agent-gh which $1)" >&2',
    "    exit 127",
    "  fi",
    "  AGH_SHIM_PID=$$",
    "  export AGH_SHIM_PID AGH_SHIM_HOPS AGH_SHIM_TRAIL",
    "  case $0 in */*) agh_here=${0%/*}/ ;; *) agh_here=./ ;; esac",
    '  agh_rest="$PATH:"',
    '  while [ -n "$agh_rest" ]; do',
    '    agh_dir=${agh_rest%%:*}',
    '    agh_rest=${agh_rest#*:}',
    '    case $agh_dir in "" | "$AGH_SHIMS" | "$AGH_SHIMS/") continue ;; esac',
    '    case $agh_dir/ in "$agh_here" | "$agh_here/") [ "${0##*/}" = "$1" ] && continue ;; esac',
    '    if [ -f "$agh_dir/$1" ] && [ -x "$agh_dir/$1" ] && ! [ "$agh_dir/$1" -ef "$0" ]; then AGH_REAL=$agh_dir/$1; return 0; fi',
    "  done",
    '  if [ "$0" -ef "$AGH_SHIMS/$1" ]; then echo "agent-gh shim: no $1 on PATH outside $AGH_SHIMS" >&2; exit 127; fi',
    '  echo "agent-gh shim: $0 is a copy of the $1 shim in $AGH_SHIMS, and no real $1 follows it on PATH. Copy the real $1 instead: \\$(agent-gh which $1)" >&2',
    "  exit 127",
    "}",
  ].join("\n");

const header = (name: string) =>
  [
    "#!/bin/sh",
    `# ${name} shim from agent-gh ${VERSION} (install-shims). In an agent session of any harness it runs`,
    `# ${name} through agent-gh; otherwise it is the real one. Regenerate with \`agent-gh install-shims\`.`,
  ].join("\n");

/**
 * The gh shim. In an agent session every gh command goes through agent-gh
 * (the family App's token, as John with its badge), except gh's own version
 * and help. On an agent machine, a person's gh with no token gets the read
 * App's: reads work, and GitHub refuses writes.
 */
export const ghShim = (shims: string, agentGh: string, agentMachine: boolean): string =>
  [
    header("gh"),
    realFunction(shims),
    sessionFunction(),
    `if [ "\${${CHILD_MARKER}-}" != 1 ] && agh_session; then`,
    '  case ${1-} in',
    "    --version | -v | version | help | --help | -h | completion) ;;",
    `    *) exec ${quote(agentGh)} gh "$@" ;;`,
    "  esac",
    ...(agentMachine
      ? [
          `elif [ "\${${CHILD_MARKER}-}" != 1 ] && [ -z "\${GH_TOKEN-}" ] && [ -z "\${GITHUB_TOKEN-}" ]; then`,
          `  if agh_token=$(${quote(agentGh)} read-token); then GH_TOKEN=$agh_token; export GH_TOKEN; fi`,
          "  unset agh_token",
        ]
      : []),
    "fi",
    "agh_real gh",
    'exec "$AGH_REAL" "$@"',
    "",
  ].join("\n");

const BEGIN = "# >>> agent-gh >>>";
const END = "# <<< agent-gh <<<";

/**
 * The startup-file block: the shim directory, then agent-gh's own directory,
 * first on PATH, each once. POSIX shell, read by bash and zsh alike, and run
 * last so a system PATH helper cannot reorder it.
 */
export const rcBlock = (shims: string, bin: string): string =>
  [
    BEGIN,
    "# Managed by `agent-gh install-shims`: its gh shim, then agent-gh, first on PATH.",
    'agh_path=""; agh_rest="$PATH:"',
    'while [ -n "$agh_rest" ]; do',
    '  agh_dir=${agh_rest%%:*}; agh_rest=${agh_rest#*:}',
    `  case $agh_dir in ${quote(shims)} | ${quote(bin)} | "") ;; *) agh_path=\${agh_path:+$agh_path:}$agh_dir ;; esac`,
    "done",
    `export PATH=${quote(shims)}:${quote(bin)}\${agh_path:+:$agh_path}`,
    "unset agh_path agh_rest agh_dir",
    END,
  ].join("\n");

/** `text` with the managed block replaced, or appended once when absent. */
export const withBlock = (text: string, block: string): string => {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start !== -1 && end > start) return `${text.slice(0, start)}${block}${text.slice(end + END.length)}`;
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${text === "" ? "" : "\n"}${block}\n`;
};

/**
 * The startup files that get the block: each one present among the shells'
 * interactive and login files, and `.profile` when none is, so every shell a
 * harness starts finds the shims.
 */
export const RC_FILES = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile"] as const;

const writeAtomic = (path: string, text: string) => {
  const temp = `${path}.agent-gh.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
};

export const updateStartupFiles = (home: string, shims: string, bin: string): string[] => {
  const present = RC_FILES.map((name) => join(home, name)).filter((path) => existsSync(path));
  const targets = present.length > 0 ? present : [join(home, ".profile")];
  const block = rcBlock(shims, bin);
  for (const path of targets) {
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const next = withBlock(text, block);
    if (next !== text) writeAtomic(path, next);
  }
  return targets;
};

/** The first `name` on `path` outside `skip`, as the shims find it, that `accept` takes. */
export const findReal = (
  name: string,
  path: string | undefined,
  skip: string,
  accept: (candidate: string) => boolean = () => true,
): string | undefined => {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "" || dir === skip || dir === `${skip}/`) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile() && accept(candidate)) return candidate;
    } catch {
      // Not there, or not executable: keep looking.
    }
  }
  return undefined;
};

const SHIM_HEADER = /^#!\/bin\/sh\n# \S+ shim from agent-gh /;

/** Whether `path` is an agent-gh shim, installed or copied, by its first line of comment. */
export const isShim = (path: string): boolean => {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false; // Executable but unreadable: a binary, not a shell script.
  }
  try {
    const head = Buffer.alloc(64);
    return SHIM_HEADER.test(head.toString("utf8", 0, readSync(fd, head, 0, head.length, 0)));
  } finally {
    closeSync(fd);
  }
};

/**
 * `agent-gh which <gh|git>`: the real program, never a shim or a copy of one,
 * for a script or test fixture that copies git or gh somewhere.
 */
export const whichReal = (name: string, path: string | undefined, shims: string): string | undefined =>
  findReal(name, path, shims, (candidate) => !isShim(candidate));

export type ShimDeps = {
  readonly home: string;
  readonly shims: string;
  readonly bin: string;
  readonly configDir: string;
  readonly registry: Registry;
  readonly agentGh: string;
  readonly env: Env;
  readonly nowSeconds: () => number;
  readonly print: (line: string) => void;
};

/** Runs the real git or gh (never a shim), marked as agent-gh's child. */
const real = (deps: ShimDeps, name: string, args: string[], stdin: "inherit" | "ignore" = "ignore", extra: Record<string, string> = {}) => {
  const program = findReal(name, deps.env.PATH, deps.shims);
  if (program === undefined) return { code: 127, stdout: "" };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(deps.env)) if (value !== undefined) env[key] = value;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  env[CHILD_MARKER] = "1";
  Object.assign(env, extra);
  const result = Bun.spawnSync([program, ...args], { env, stdin, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
};

/**
 * The ways a remote spells github.com over SSH, as git parses them (connect.c
 * takes `git+ssh` and `ssh+git` as `ssh`), including SSH over port 443. An ssh
 * `Host` alias cannot be matched by prefix.
 */
const SSH_GITHUB = [
  "git@github.com:",
  "ssh://git@github.com/",
  "git+ssh://git@github.com/",
  "ssh+git://git@github.com/",
  "ssh://git@ssh.github.com:443/",
] as const;

/** One global git setting: every value in order (`exact`), or values it must include among others. */
export type GitSetting = { readonly key: string; readonly values: readonly string[]; readonly exact: boolean };

/**
 * The global git settings that make an agent machine's git use agent-gh's
 * credential helper for github.com: a reset, then the helper; the
 * repository's path, so the helper can check the family App's installation;
 * a push URL naming PUSH_USER, so a push the family App cannot make, or a
 * person's, fails with the reason; and HTTPS for SSH remotes, fetch and
 * explicit pushurl alike, so no SSH key writes.
 */
export const agentMachineGit = (agentGh: string): readonly GitSetting[] => [
  { key: "credential.https://github.com.helper", values: ["", `!${/\s/.test(agentGh) ? quote(agentGh) : agentGh} credential`], exact: true },
  { key: "credential.https://github.com.useHttpPath", values: ["true"], exact: true },
  { key: `url.https://${PUSH_USER}@github.com/.pushInsteadOf`, values: ["https://github.com/", ...SSH_GITHUB], exact: true },
  { key: "url.https://github.com/.insteadOf", values: SSH_GITHUB, exact: false },
];

/**
 * The global commit-msg hook, as git's config-based hooks (hook.<name>.*):
 * every repository on the machine credits an agent session's commits, with
 * no hook of its own. It runs before a repository's own hook, and the guard
 * replaces or skips trailers already there, so a repository that also has
 * agent-gh's hook gets them once. `hook.agent-gh.enabled=false` in a
 * repository turns it off there.
 */
export const commitHook = (agentGh: string): readonly GitSetting[] => [
  { key: "hook.agent-gh.command", values: [`${/\s/.test(agentGh) ? quote(agentGh) : agentGh} guard commit-msg`], exact: true },
  { key: "hook.agent-gh.event", values: ["commit-msg"], exact: true },
];

/** Whether this git runs hooks from config: older gits (Apple's among them) have no `git hook list`. */
export const configHooks = (deps: ShimDeps): boolean => {
  const probe = real(deps, "git", ["-c", "hook.agent-gh-probe.command=true", "-c", "hook.agent-gh-probe.event=commit-msg", "hook", "list", "commit-msg"], "ignore", {
    // Only the probe's own hook: a half-written one in the person's config would make git refuse the list.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  return probe.code === 0 && probe.stdout.split("\n").includes("agent-gh-probe");
};

/** The installed git's version, for doctor's advice. */
export const gitVersion = (deps: ShimDeps): string => real(deps, "git", ["--version"]).stdout.trim() || "git";

/** Every value of a global git setting, in order. */
export const globalGit = (deps: ShimDeps, key: string): string[] => {
  const result = real(deps, "git", ["config", "--global", "--get-all", key]);
  return result.code === 0 ? result.stdout.replace(/\n$/, "").split("\n") : [];
};

/** Whether the machine's global git config holds a setting as install-shims writes it. */
export const holds = (deps: ShimDeps, setting: GitSetting): boolean => {
  const values = globalGit(deps, setting.key);
  return setting.exact
    ? values.length === setting.values.length && values.every((value, index) => value === setting.values[index])
    : setting.values.every((value) => values.includes(value));
};

/** Whether gh itself holds John's personal login for github.com (a token in the environment is not asked about). */
export const personalGhLogin = (deps: ShimDeps): boolean =>
  real(deps, "gh", ["auth", "status", "--hostname", "github.com"]).code === 0;

/** Writes global git settings that do not already hold, keeping a shared key's other values. */
const setGit = (deps: ShimDeps, settings: readonly GitSetting[]): void => {
  for (const setting of settings) {
    if (holds(deps, setting)) continue;
    // A shared key (the insteadOf rules) keeps its other values; agent-gh's own are rewritten whole.
    if (setting.exact) real(deps, "git", ["config", "--global", "--unset-all", setting.key]);
    const present = setting.exact ? [] : globalGit(deps, setting.key);
    for (const value of setting.values.filter((value) => !present.includes(value))) {
      if (real(deps, "git", ["config", "--global", "--add", setting.key, value]).code !== 0) {
        throw new Failure("installing the shims", `git config --global could not set ${setting.key}`);
      }
    }
  }
};

/**
 * `agent-gh install-shims [--agent-machine]`: writes the gh shim and puts it
 * first on PATH in the shell startup files, and removes the git shim older
 * releases wrote. With --agent-machine it also makes agent-gh the only way to
 * write from this machine: git's credential helper for github.com answers an
 * agent session with its family App where installed and anyone else with the
 * read App, and gh is logged out of John's personal login. It refuses that until the
 * read App is logged in, so the machine is never left unable to clone.
 */
export const installShims = (deps: ShimDeps, agentMachine: boolean, families: readonly string[] | undefined): void => {
  if (agentMachine) {
    readConfig(deps.configDir, READ_APP, deps.registry);
    if (!loginUsable(deps.configDir, READ_APP, deps.nowSeconds())) {
      throw new Failure(
        "installing the shims",
        "the read App is not logged in on this machine, and an agent machine clones with it; run `agent-gh login read`, then rerun the install line",
      );
    }
  }
  mkdirSync(deps.shims, { recursive: true, mode: 0o755 });
  const gh = join(deps.shims, "gh");
  writeAtomic(gh, ghShim(deps.shims, deps.agentGh, agentMachine));
  chmodSync(gh, 0o755);
  const git = join(deps.shims, "git");
  if (existsSync(git) && isShim(git)) {
    unlinkSync(git);
    deps.print(`removed ${git}: git is plain git, and a repository's commit hook credits the App`);
  }
  const files = updateStartupFiles(deps.home, deps.shims, deps.bin);
  deps.print(`gh shim: ${gh}, first on PATH in ${files.join(", ")}; open a new shell to use it`);
  const claude = installClaudeHook(deps.home, deps.agentGh);
  if (claude !== undefined) deps.print(`Claude Code: a SessionStart hook in ${claude} puts the shim first on PATH before every command`);
  const instructions = installInstructions(deps.home);
  if (instructions.length > 0) deps.print(`agent instructions: how to reach GitHub through agent-gh, in ${instructions.join(", ")}`);
  mkdirSync(deps.configDir, { recursive: true, mode: 0o700 });
  const machine: Machine = agentMachine
    ? { agent_machine: true, ...(families === undefined ? {} : { families }) }
    : { agent_machine: false };
  writeAtomic(join(deps.configDir, "machine.json"), `${JSON.stringify(machine)}\n`);
  if (configHooks(deps)) {
    setGit(deps, commitHook(deps.agentGh));
    deps.print("commits: a global commit-msg hook credits an agent session's commits in every repository");
  } else {
    deps.print(`commits: ${gitVersion(deps)} has no config-based hooks, so only repositories with agent-gh's commit-msg hook credit agent sessions; a newer git credits every repository`);
  }
  if (!agentMachine) return;
  setGit(deps, agentMachineGit(deps.agentGh));
  deps.print("git: an agent session uses its family App where installed, and anyone else the read App");
  if (personalGhLogin(deps)) {
    const out = real(deps, "gh", ["auth", "logout", "--hostname", "github.com"], "inherit");
    if (out.code !== 0 || personalGhLogin(deps)) {
      throw new Failure("installing the shims", "gh is still logged in to your personal account; run `gh auth logout --hostname github.com` yourself");
    }
    deps.print("gh: logged out of your personal login; a person's gh reads with the read App, and an agent's writes with its family App");
  } else {
    deps.print("gh: no personal login on this machine");
  }
};
