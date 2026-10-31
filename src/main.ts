#!/usr/bin/env bun
/**
 * agent-gh: run gh as John through the GitHub App of the model family driving
 * this agent session (johnrees-<family>), whatever harness runs it, and credit
 * that App on the session's commits. GitHub shows each action as John with
 * the App's badge. The usage below lists every command.
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowRelease, parseAllowArgs } from "./allow.ts";
import { runChild } from "./child.ts";
import { parseClaimArgs, sessionId as claimSession } from "./claim.ts";
import { claim, type ClaimIo, claimsLines, eventIssues, holderOf, listClaims, release, restore, syncLabels, take } from "./claim-run.ts";
import type { LabelRules } from "./next.ts";
import { apiReader, claimNext, nextIssues, nextJson, nextLines, wavesJson, wavesLines } from "./next-run.ts";
import { parseGraphArgs } from "./graph.ts";
import { readGraph } from "./graph-run.ts";
import { defaultConfigDir, isConfigured, ORCHESTRATOR, READ_APP, REGISTRY } from "./config.ts";
import { configureCodexSandbox } from "./codex.ts";
import { credential, familyToken, readToken } from "./credential.ts";
import { doctor, PERSON } from "./doctor.ts";
import { describe, Failure, NEXT_STEP } from "./failure.ts";
import { GITHUB } from "./github.ts";
import { type ClaimCheck, guard } from "./guard.ts";
import { familyNames } from "./family.ts";
import { detectIdentity, inAgentSession, personShell } from "./harness.ts";
import { limitedFamilies, login, loginAll, loginTargets } from "./login.ts";
import { formatLine, latestRelease, machineDoctor, sshToGitHub } from "./machine.ts";
import { parseThreadRef, sessionId } from "./notify.ts";
import { originUrl, parseRemoteUrl, parseRepo, type Repo, resolveRepo, slug } from "./repo.ts";
import { parseAddress } from "./reply.ts";
import { type NotifyOptions, notifyCommand, replyCommand, type ReplyOptions } from "./reply-run.ts";
import { EFFORTS, type Effort } from "./review.ts";
import { dispatchGh, guardPush, type ReviewIo, reviewFull, reviewSweep, spawnCheck, spawnReviewer } from "./review-run.ts";
import { type Context, runAs, withToken } from "./run.ts";
import { type StatusIo, statusCommand } from "./status-run.ts";
import { configuredFamilies, settingsLines } from "./settings.ts";
import { setup } from "./setup.ts";
import { readGitConfig } from "./target.ts";
import { defaultBinDir, defaultShimDir, installShims, rcBlock, type ShimDeps, whichReal } from "./shims.ts";
import { VERSION } from "./version.ts";
import { waiveCommand } from "./waive-run.ts";

const USAGE = `usage:
  agent-gh <gh arguments...>        run gh as John through this agent's family App
  agent-gh doctor                   show who is acting, then check the user, App, git author, and repository access
  agent-gh setup <family>           create johnrees-<family> (${familyNames().join(", ")}, read, or ${ORCHESTRATOR}); run it yourself, not from an agent
  agent-gh login <family>|--all     authorize johnrees-<family> to act as you (device flow); --all: every App not yet logged in
  agent-gh install-shims [--agent-machine] [--codex-sandbox]
                                    --codex-sandbox: set Codex's global default to workspace-write, allow token-directory writes and outbound networking (all hosts)
                                    the gh shim first on PATH; --agent-machine: git reads with the read App and pushes with the family App, gh logged out
  agent-gh doctor --machine         check this machine: release, gitleaks, logins, shims, and agent-machine settings
  agent-gh --version
  agent-gh credential get           git's credential helper on agent machines: an agent session's family App where installed, else the read App
  agent-gh session-env              from Claude Code's SessionStart hook: put the gh shim first on PATH for every command
  agent-gh read-token               print the read App's token (the gh shim's GH_TOKEN on agent machines)
  agent-gh settings [family...]     print each App's settings, permissions, and repository-access pages (default: every set-up family)
  agent-gh guard commit-msg <file>  from a git hook: in an agent session, refuse a commit on another session's claim branch,
                                    then add its Agent-* trailers and credit its family App
  agent-gh guard pre-push <remote> <url>
                                    from a git hook: in an agent session, refuse a push to the default branch or one whose rules require checks
  agent-gh review sweep [--base REF] [--effort E]
                                    a quick bug sweep of the branch by another model family; prints, records nothing
  agent-gh review full [--pr N] [--issue N] [--effort E] [--adopt] [--reviewer FAMILY]
                                    run the config's checks on the pull request's pushed head, review it against its issue,
                                    and post the findings as a review and the agent-review status (or, with
                                    status_writer "actions", wait for the agent-review workflow to set it); a commit
                                    another session made on a claim's branch is refused unless --adopt takes it on,
                                    or a \`claim --take\` handed the branch on after it;
                                    where the config's require names the author, each required family reviews in turn,
                                    or only --reviewer's
  agent-gh reply <finding> --applied <sha> | --declined "<why>" [--pr N]
                                    answer a review finding or a notify (its id as \`review full\` prints it, or its URL);
                                    a finding's review thread is answered and resolved
  agent-gh waive --reason "<evidence>" [--pr N]
                                    an orchestrator session's delegated review waiver, through johnrees-${ORCHESTRATOR}:
                                    a \`Waived:\` comment naming the head, then the waiver label; it counts where
                                    waiver_by lists ${ORCHESTRATOR}, never on a pull request it worked on, and a push voids it
  agent-gh notify <issue or pr> --severity P0|P1|P2 --body "<text>" | --body-file <file|-> [--from <issue or pr>]
                                    post a finding on another thread, linked back to this branch's pull request (or --from);
                                    it waits for an agent's \`agent-gh reply\`
  agent-gh status [--pr N]          in the agent-review workflow (GitHub Actions, GITHUB_TOKEN): set agent-review
                                    and agent-threads on the event's pull request
  agent-gh claim <N> [--refs|--no-pr] [-R repo]
                                    take an issue before working on it: refuse a closed or taken one, else open a draft
                                    pull request closing it (--refs: referencing it) from a new <family>/<N>-<slug> branch,
                                    or (--no-pr) post a claim comment; a claim that loses a race undoes itself
  agent-gh claim --take <N> [-R repo]
                                    take over another session's claim on an issue, keeping its branch and pull request:
                                    rewrite the claim to this session and check out its branch, whose earlier commits
                                    \`review full\` then takes as this session's (a comment claim: claim anew, release the old)
  agent-gh claim --restore <N> [-R repo]
                                    put the claim marker back on the pull request holding an issue, from the description's
                                    edit history, after an edit outside the gh shim dropped it (the shim keeps it on \`gh pr edit\`)
  agent-gh claim --next [--refs|--no-pr] [LABEL FILTERS] [-R repo]
                                    claim the first issue \`next\` offers; after a lost race, the next one (at most three)
  agent-gh next [--json] [--waves] [LABEL FILTERS] [-R repo]
                                    the issues an agent may take, the next first: open, ready, queued (where a Queue issue
                                    is configured), unblocked, and unclaimed; --waves: the blocked_by graph in waves;
                                    --json includes each issue's labels
                                    LABEL FILTERS, each repeatable, a pattern where * matches anything:
                                      --skip-label <pattern>     leave out an issue carrying a matching label
                                      --require-label <pattern>  leave out an issue with no matching label
                                      --fit-label <group:pattern>  leave out an issue with a label in the pattern's group
                                                                 (up to its first ":") that does not match: model:sonnet-*
                                    queue.skip_labels in .github/agent-review.json applies --skip-label for everyone
  agent-gh release <N> [-R repo]    release this session's claim: close its still-empty draft, or post a release comment
  agent-gh claims [--json] [-R repo]
                                    list live claims with their holder and last push and comment (--json: the stable form)
  agent-gh claims sync [--issue N]... [-R repo]
                                    remove the claim label from issues nothing claims (in GitHub Actions: the closed PR's)
  agent-gh graph --json [--all] [-R repo]
                                    the repository as one graph: every open issue with its milestone, blockers, wave,
                                    holder, pull request, and statuses, and each open milestone's closed issues
                                    (--all: every issue); reads in a few GraphQL requests, writes nothing
  agent-gh allow release <tag> [--at <sha>] [-R repo]
                                    in your own terminal: grant agents one tag, pushed once (at <sha>, a full commit sha,
                                    when given), and its release, for 24 hours: an issue your own gh opens, or one you paste
  agent-gh which <gh|git>           print the real program, past any agent-gh shim; copy this, never \`command -v gh\`, into a test's PATH`;

/** Opens a URL in a local browser if there is one; the printed URL is always the fallback. */
const openUrl = (url: string) => {
  try {
    Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    // No opener (a headless or remote machine): the printed URL and code are the path.
  }
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Apps setup, login, and settings accept: every family, the read App, and the orchestrator's. */
const apps = (): string[] => [...familyNames(), READ_APP, ORCHESTRATOR];

/** This binary, for the shims and git's credential helper to call; `bun src/main.ts` stands in for it with the installed one. */
const self = (): string => (/(^|\/)agent-gh[^/]*$/.test(process.execPath) ? process.execPath : `${defaultBinDir()}/agent-gh`);

const shimDeps = (env: NodeJS.ProcessEnv): ShimDeps => ({
  home: process.env.HOME ?? "",
  shims: defaultShimDir(),
  bin: defaultBinDir(),
  configDir: defaultConfigDir(),
  registry: REGISTRY,
  agentGh: self(),
  env,
  nowSeconds,
  print: (line) => console.error(line),
});

const deviceDeps = () => ({
  api: GITHUB,
  dir: defaultConfigDir(),
  registry: REGISTRY,
  github: GITHUB.web,
  nowSeconds,
  sleep: (ms: number) => Bun.sleep(ms),
  open: openUrl,
  print: (line: string) => console.error(line),
});

/** The review commands' and the gate's I/O, in an agent session with the family App's token in `env`. */
const reviewIo = (context: Context, repo: Repo, env: Record<string, string>): ReviewIo => ({
  api: context.api,
  token: env.GH_TOKEN ?? "",
  repo,
  family: context.identity.family,
  ...(claimSession(context.env).generated ? {} : { session: claimSession(context.env).id }),
  git: async (args, input) => {
    const child = Bun.spawn(["git", ...args], { env, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "ignore" });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return code === 0 ? out.trim() : undefined;
  },
  runCheck: (command, cwd, timeoutMs, extra) => spawnCheck(command, cwd, process.env, timeoutMs, extra),
  runReviewer: async (command, stdin, cwd) => {
    const dir = mkdtempSync(join(tmpdir(), "agent-gh-reviewer-"));
    const log = join(dir, "stderr.log");
    const { code, stdout, stderr } = await spawnReviewer(command, stdin, cwd, process.env);
    writeFileSync(log, stderr);
    if (code !== 0) console.error(`agent-gh: the reviewer's log is ${log}`);
    return { code, stdout };
  },
  readFile: (path) => Bun.file(path).text(),
  tempDir: () => mkdtempSync(join(tmpdir(), "agent-gh-review-")),
  print: (line) => console.error(line),
  out: (text) => process.stdout.write(text),
  sleep: (ms) => Bun.sleep(ms),
});

/**
 * `agent-gh status`'s I/O in a GitHub Actions job: the workflow's
 * GITHUB_TOKEN, git in a scratch repository that fetches commits to
 * compare, with the token in git's environment, never its arguments, and
 * the NTFY_URL secret as the step passes it (`AGENT_GH_NTFY_URL`), which no
 * child process sees.
 */
const statusIo = (env: NodeJS.ProcessEnv, repo: Repo, token: string): StatusIo => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gh-status-"));
  const gitEnv: Record<string, string> = {
    PATH: env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
  return {
    api: GITHUB,
    token,
    repo,
    remote: `https://github.com/${slug(repo)}.git`,
    ntfyUrl: env.AGENT_GH_NTFY_URL,
    git: async (args, input) => {
      const child = Bun.spawn(["git", ...args], { cwd: dir, env: gitEnv, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "ignore" });
      const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      return code === 0 ? out.trim() : undefined;
    },
    print: (line) => console.error(line),
  };
};

/** `agent-gh review sweep|full` options; undefined when they do not parse. */
const reviewOptions = (rest: readonly string[]) => {
  const [mode, ...flags] = rest;
  if (mode !== "sweep" && mode !== "full") return undefined;
  const allowed = mode === "sweep" ? ["--base", "--effort"] : ["--pr", "--issue", "--effort", "--reviewer"];
  const values: Record<string, string> = {};
  let adopt = false;
  for (let index = 0; index < flags.length; ) {
    const flag = flags[index] as string;
    // `--adopt` stands alone; every other flag takes a value.
    if (mode === "full" && flag === "--adopt") {
      if (adopt) return undefined;
      adopt = true;
      index += 1;
      continue;
    }
    const value = flags[index + 1];
    if (!allowed.includes(flag) || value === undefined || values[flag] !== undefined) return undefined;
    values[flag] = value;
    index += 2;
  }
  const number = (value: string | undefined) => (value === undefined ? undefined : /^\d+$/.test(value) ? Number(value) : Number.NaN);
  const [pr, issue] = [number(values["--pr"]), number(values["--issue"])];
  const effort = values["--effort"] as Effort | undefined;
  if (Number.isNaN(pr) || Number.isNaN(issue) || (effort !== undefined && !EFFORTS.includes(effort))) return undefined;
  return {
    mode,
    ...(values["--base"] === undefined ? {} : { base: values["--base"] }),
    ...(pr === undefined ? {} : { pr }),
    ...(issue === undefined ? {} : { issue }),
    ...(effort === undefined ? {} : { effort }),
    ...(adopt ? { adopt } : {}),
    ...(values["--reviewer"] === undefined ? {} : { reviewer: values["--reviewer"] }),
  };
};

/** `--flag value` pairs after `count` positional arguments; undefined when they do not parse. */
const flagPairs = (args: readonly string[], count: number, allowed: readonly string[]) => {
  const positional = args.slice(0, count);
  if (positional.length < count || positional.some((arg) => arg.startsWith("--"))) return undefined;
  const values: Record<string, string> = {};
  for (let index = count; index < args.length; index += 2) {
    const [flag, value] = [args[index] as string, args[index + 1]];
    if (!allowed.includes(flag) || value === undefined || values[flag] !== undefined) return undefined;
    values[flag] = value;
  }
  return { positional, values };
};

const prFlag = (value: string | undefined) => (value === undefined ? undefined : /^\d+$/.test(value) ? Number(value) : Number.NaN);

/** `agent-gh reply`'s options; undefined when they do not parse. */
const replyOptions = (rest: readonly string[]): ReplyOptions | undefined => {
  const parsed = flagPairs(rest, 1, ["--applied", "--declined", "--pr"]);
  if (parsed === undefined) return undefined;
  const { positional, values } = parsed;
  const [applied, declined, pr] = [values["--applied"], values["--declined"], prFlag(values["--pr"])];
  if ((applied === undefined) === (declined === undefined) || Number.isNaN(pr)) return undefined;
  return { address: positional[0] as string, outcome: applied === undefined ? { declined: declined as string } : { applied }, ...(pr === undefined ? {} : { pr }) };
};

/** `agent-gh notify`'s options, with the text read from `--body-file` (`-` for stdin); undefined when they do not parse. */
const notifyOptions = async (rest: readonly string[]): Promise<NotifyOptions | undefined> => {
  const parsed = flagPairs(rest, 1, ["--severity", "--body", "--body-file", "--from"]);
  if (parsed === undefined) return undefined;
  const { positional, values } = parsed;
  const [body, file] = [values["--body"], values["--body-file"]];
  if ((body === undefined) === (file === undefined)) return undefined;
  let text = body ?? "";
  if (file !== undefined) {
    try {
      text = file === "-" ? await new Response(Bun.stdin.stream()).text() : readFileSync(file, "utf8");
    } catch {
      throw new Failure("notifying", `cannot read ${file}`);
    }
  }
  const from = values["--from"];
  return { target: positional[0] as string, severity: values["--severity"], text, ...(from === undefined ? {} : { from }) };
};

/** The claim commands' I/O: git in the working tree with the App's token, its stderr shown as it runs. */
const claimIo = (context: Context, repo: Repo, env: Record<string, string>, session: string): ClaimIo => ({
  api: context.api,
  token: env.GH_TOKEN ?? "",
  repo,
  family: context.identity.family,
  session,
  git: async (args) => {
    const child = Bun.spawn(["git", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { code, stdout: out.trim() };
  },
  print: (line) => console.error(line),
  out: (text) => process.stdout.write(text),
  sleep: (ms) => Bun.sleep(ms),
  nowMs: () => Date.now(),
  recheckMs: 2000,
});

/** `agent-gh claim`, `release`, and `claims`. */
const claimCommand = async (first: string, rest: readonly string[], env: NodeJS.ProcessEnv): Promise<number> => {
  const parsed = parseClaimArgs(first, rest);
  if (parsed === undefined) {
    console.error(USAGE);
    return 1;
  }
  const print = (line: string) => console.error(line);
  if (parsed.command === "sync" && env.GITHUB_ACTIONS === "true" && !inAgentSession(env)) {
    // The agent-claims workflow, with its GITHUB_TOKEN: the closed pull request's issues.
    const repo = parseRepo(env.GITHUB_REPOSITORY ?? "");
    const token = env.GITHUB_TOKEN ?? "";
    if (repo === undefined || token === "") throw new Failure("listing claims", "GITHUB_REPOSITORY and GITHUB_TOKEN must be set; pass `GITHUB_TOKEN: ${{ github.token }}` to the step");
    const io = { api: GITHUB, token, repo };
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8"));
    } catch {
      payload = undefined;
    }
    await syncLabels(io, print, parsed.issues.length > 0 ? parsed.issues : eventIssues(io, payload));
    return 0;
  }
  const repo = await resolveRepo("gh", rest, env, () => originUrl(process.cwd()));
  if (repo === undefined) throw new Failure("resolving the repository", "no -R, GH_REPO, or github.com origin remote; run it inside a clone of the repository or pass -R OWNER/REPO");
  const showNext = async (io: { api: typeof GITHUB; token: string; repo: Repo }, options: { readonly json: boolean; readonly waves: boolean; readonly rules: LabelRules }) => {
    const result = await nextIssues(repo, apiReader(io), options.rules);
    const value = options.waves ? (options.json ? wavesJson(repo, result) : wavesLines(result, print)) : options.json ? nextJson(repo, result) : nextLines(result, print);
    process.stdout.write(Array.isArray(value) ? `${value.join("\n")}\n` : `${JSON.stringify(value, null, 2)}\n`);
    return 0;
  };
  if ((parsed.command === "claims" || parsed.command === "next") && !inAgentSession(env)) {
    // A person's listing reads with the read App.
    const token = await readToken({ api: GITHUB, dir: defaultConfigDir(), registry: REGISTRY, nowSeconds, sleep: (ms) => Bun.sleep(ms) });
    if (parsed.command === "next") return showNext({ api: GITHUB, token, repo }, parsed);
    const list = await listClaims({ api: GITHUB, token, repo });
    process.stdout.write(parsed.json ? `${JSON.stringify(list, null, 2)}\n` : `${claimsLines(list, Date.now()).join("\n")}\n`);
    return 0;
  }
  const context: Context = { identity: detectIdentity(env), repo, env, api: GITHUB, configDir: defaultConfigDir(), registry: REGISTRY, nowSeconds, sleep: (ms) => Bun.sleep(ms) };
  const session = claimSession(env);
  return withToken(context, async (childEnv) => {
    const io = claimIo(context, repo, childEnv, session.id);
    if (parsed.command === "claims") {
      const list = await listClaims(io);
      io.out(parsed.json ? `${JSON.stringify(list, null, 2)}\n` : `${claimsLines(list, io.nowMs()).join("\n")}\n`);
      return 0;
    }
    if (parsed.command === "sync") {
      await syncLabels(io, print, parsed.issues.length > 0 ? parsed.issues : undefined);
      return 0;
    }
    if (parsed.command === "release") return release(io, parsed.issue);
    if (parsed.command === "restore") return restore(io, parsed.issue);
    if (parsed.command === "next") return showNext(io, parsed);
    if (parsed.command === "claim-next") {
      if (session.generated) print(`agent-gh: no session id in the environment; this claim's is ${session.id}: set AGENT_GH_SESSION=${session.id} to release it later`);
      return claimNext(io, apiReader(io), parsed);
    }
    if (session.generated) print(`agent-gh: no session id in the environment; this claim's is ${session.id}: set AGENT_GH_SESSION=${session.id} to release it later`);
    if (parsed.command === "take") return take(io, parsed.issue);
    return claim(io, parsed);
  });
};

/** `agent-gh graph --json`: with the family App in an agent session, else the read App, as `next` and `claims` read. */
const graphCommand = async (rest: readonly string[], env: NodeJS.ProcessEnv): Promise<number> => {
  const parsed = parseGraphArgs(rest);
  if (parsed === undefined) {
    console.error(USAGE);
    return 1;
  }
  const repo = await resolveRepo("gh", rest, env, () => originUrl(process.cwd()));
  if (repo === undefined) throw new Failure("resolving the repository", "no -R, GH_REPO, or github.com origin remote; run it inside a clone of the repository or pass -R OWNER/REPO");
  const show = async (io: { api: typeof GITHUB; token: string; repo: Repo }) => {
    process.stdout.write(`${JSON.stringify(await readGraph(io, apiReader(io), parsed), null, 2)}\n`);
    return 0;
  };
  if (!inAgentSession(env)) return show({ api: GITHUB, token: await readToken({ api: GITHUB, dir: defaultConfigDir(), registry: REGISTRY, nowSeconds, sleep: (ms) => Bun.sleep(ms) }), repo });
  const context: Context = { identity: detectIdentity(env), repo, env, api: GITHUB, configDir: defaultConfigDir(), registry: REGISTRY, nowSeconds, sleep: (ms) => Bun.sleep(ms) };
  return withToken(context, (childEnv) => show({ api: GITHUB, token: childEnv.GH_TOKEN ?? "", repo }));
};

const main = async (argv: readonly string[]): Promise<number> => {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    console.error(USAGE);
    return first === undefined ? 1 : 0;
  }
  if (first === "--version" || first === "version") {
    console.log(`agent-gh ${VERSION}`);
    return 0;
  }
  const env = process.env;
  if (first === "credential") {
    // git runs this for every github.com request once --agent-machine set it up, agent sessions included.
    const input = await new Response(Bun.stdin.stream()).text();
    const deps = { api: GITHUB, dir: defaultConfigDir(), registry: REGISTRY, nowSeconds, sleep: (ms: number) => Bun.sleep(ms), env };
    process.stdout.write(
      await credential(rest[0], input, {
        inAgentSession: inAgentSession(env),
        read: () => readToken(deps),
        family: (repo) => familyToken(deps, repo),
        print: (line) => console.error(line),
      }),
    );
    return 0;
  }
  if (first === "which") {
    const [name, ...extra] = rest;
    if ((name !== "gh" && name !== "git") || extra.length > 0) {
      console.error(USAGE);
      return 1;
    }
    const program = whichReal(name, env.PATH, defaultShimDir());
    if (program === undefined) {
      console.error(`agent-gh: no ${name} on PATH besides agent-gh's shims`);
      return 1;
    }
    console.log(program);
    return 0;
  }
  if (first === "session-env") {
    // Claude Code's SessionStart hook: CLAUDE_ENV_FILE is sourced before every command, after the shell snapshot.
    const file = env.CLAUDE_ENV_FILE;
    if (file !== undefined && file !== "") {
      try {
        // SessionStart runs again on resume and compaction. The block must come last, so that nothing another
        // hook appended puts its PATH ahead of the shim; when it already does, a rerun adds nothing. Other hooks
        // write the same file, so it is appended to, never rewritten.
        const block = `${rcBlock(defaultShimDir(), defaultBinDir())}\n`;
        if (!existsSync(file) || !readFileSync(file, "utf8").endsWith(block)) appendFileSync(file, block);
        else console.error(`agent-gh session-env: ${file} already ends with the PATH block; nothing changed`);
      } catch (error) {
        console.error(`agent-gh session-env: could not write ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return 0;
  }
  if (first === "read-token") {
    console.log(await readToken({ api: GITHUB, dir: defaultConfigDir(), registry: REGISTRY, nowSeconds, sleep: (ms) => Bun.sleep(ms) }));
    return 0;
  }
  if (first === "doctor" && rest[0] === "--machine") {
    const lines = await machineDoctor({
      ...shimDeps(env),
      version: VERSION,
      latest: () => latestRelease(GITHUB, "johnrees/agent-gh"),
      ssh: sshToGitHub,
    });
    for (const line of lines) console.log(formatLine(line));
    const failed = lines.some((line) => line.state === "FAIL");
    console.log(failed ? "Not set up yet: fix the FAIL lines above." : "This machine is set up: agents use agent-gh for GitHub writes.");
    return failed ? 1 : 0;
  }
  if (first === "status") {
    const pr = rest.length === 0 ? undefined : rest.length === 2 && rest[0] === "--pr" && /^\d+$/.test(rest[1] ?? "") ? Number(rest[1]) : Number.NaN;
    if (Number.isNaN(pr)) {
      console.error(USAGE);
      return 1;
    }
    const stage = "deriving the statuses";
    if (env.GITHUB_ACTIONS !== "true" || inAgentSession(env)) {
      throw new Failure(stage, "`agent-gh status` runs in GitHub Actions, in the agent-review workflow, with its GITHUB_TOKEN; an agent runs `agent-gh review full`");
    }
    const repo = parseRepo(env.GITHUB_REPOSITORY ?? "");
    const token = env.GITHUB_TOKEN ?? "";
    if (repo === undefined || token === "") throw new Failure(stage, "GITHUB_REPOSITORY and GITHUB_TOKEN must be set; pass `GITHUB_TOKEN: ${{ github.token }}` to the step");
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8"));
    } catch {
      throw new Failure(stage, "cannot read the event GITHUB_EVENT_PATH names");
    }
    await statusCommand(statusIo(env, repo, token), { name: env.GITHUB_EVENT_NAME ?? "", payload }, pr);
    return 0;
  }
  if (first === "install-shims") {
    const agentMachine = rest.includes("--agent-machine");
    if (rest.some((arg) => arg !== "--agent-machine" && arg !== "--codex-sandbox")) {
      console.error(USAGE);
      return 1;
    }
    if (inAgentSession(env)) {
      throw new Failure("installing the shims", "an agent does not change its own guardrails; run the install line in your own terminal");
    }
    // Create CODEX_HOME before installing harness instructions on a fresh machine,
    // but an optional config refusal must not prevent the shim installation.
    let codexFailure: Failure | undefined;
    if (rest.includes("--codex-sandbox")) {
      const deps = shimDeps(env);
      try {
        console.log(configureCodexSandbox(deps.home, deps.configDir, env));
      } catch (error) {
        if (!(error instanceof Failure)) throw error;
        codexFailure = error;
      }
    }
    installShims(shimDeps(env), agentMachine, limitedFamilies(familyNames(), env.AGENT_GH_FAMILIES));
    if (codexFailure !== undefined) throw codexFailure;
    return 0;
  }
  if (first === "git") {
    // Older releases ran git through agent-gh; now a repository's commit hook credits the App.
    const git = whichReal("git", env.PATH, defaultShimDir());
    if (git === undefined) {
      console.error("agent-gh: no git on PATH");
      return 127;
    }
    console.error("agent-gh: `agent-gh git` is plain git now; run git directly (the repository's commit hook credits the App)");
    const plain: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) if (value !== undefined) plain[name] = value;
    return (await runChild([git, ...rest], plain)).code;
  }
  if (first === "guard" && rest[0] === "pre-push" && inAgentSession(env)) {
    const input = await new Response(Bun.stdin.stream()).text();
    const repo = parseRemoteUrl(rest[2] ?? "");
    const context: Context = { identity: detectIdentity(env), repo, env, api: GITHUB, configDir: defaultConfigDir(), registry: REGISTRY, nowSeconds, sleep: (ms) => Bun.sleep(ms) };
    await guardPush(rest[2], input, {
      withToken: (target, use) => withToken({ ...context, repo: target }, use),
      io: (target, childEnv) => reviewIo({ ...context, repo: target }, target, childEnv),
    });
    return 0;
  }
  if (first === "guard") {
    // git runs a hook from the working tree's top level, where its config and HEAD are read.
    const claims: ClaimCheck = {
      branch: () => {
        const result = Bun.spawnSync(["git", "symbolic-ref", "-q", "--short", "HEAD"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
        return result.exitCode === 0 ? result.stdout.toString().trim() || undefined : undefined;
      },
      session: claimSession(env),
      holder: (repo, issue) => {
        const context: Context = { identity: detectIdentity(env), repo, env, api: GITHUB, configDir: defaultConfigDir(), registry: REGISTRY, nowSeconds, sleep: (ms) => Bun.sleep(ms) };
        return withToken(context, (childEnv) => holderOf({ api: GITHUB, token: childEnv.GH_TOKEN ?? "", repo }, "checking the commit", issue));
      },
      print: (line) => console.error(line),
    };
    const verdict = await guard(rest, env, defaultConfigDir(), REGISTRY, () => readGitConfig(process.cwd(), env), claims);
    if (verdict.message !== undefined) console.error(verdict.message);
    return verdict.code;
  }
  if (first === "settings") {
    const dir = defaultConfigDir();
    if (rest.some((family) => !apps().includes(family))) {
      console.error(USAGE);
      return 1;
    }
    const configured = [...configuredFamilies(dir), ...(isConfigured(dir, READ_APP) ? [READ_APP] : [])];
    const families = rest.length > 0 ? rest : configured;
    if (families.length === 0) {
      console.error("no family has an App yet; run `agent-gh setup <family>` on the machine where you create Apps");
      return 1;
    }
    for (const family of families) for (const line of settingsLines(dir, family, GITHUB.web)) console.log(line);
    return families.every((family) => configured.includes(family)) ? 0 : 1;
  }
  if (first === "setup") {
    const [family] = rest;
    if (family === undefined || !apps().includes(family) || rest.length !== 1) {
      console.error(USAGE);
      return 1;
    }
    if (inAgentSession(env)) {
      throw new Failure("setting up", "agents do not create their own credentials; run `agent-gh setup` in your own terminal");
    }
    await setup(family, {
      configDir: defaultConfigDir(),
      registry: REGISTRY,
      api: GITHUB,
      github: GITHUB.web,
      open: openUrl,
      print: (line) => console.error(line),
      timeoutMs: 10 * 60 * 1000,
    });
    return 0;
  }
  if (first === "login") {
    const [family] = rest;
    if (family === undefined || !(apps().includes(family) || family === "--all") || rest.length !== 1) {
      console.error(USAGE);
      return 1;
    }
    if (inAgentSession(env)) {
      throw new Failure("logging in", "an agent cannot authorize itself to act as John; run `agent-gh login` in your own terminal");
    }
    if (family === "--all") {
      const configured = (name: string) => isConfigured(defaultConfigDir(), name);
      const failed = await loginAll(loginTargets(familyNames(), env.AGENT_GH_FAMILIES, READ_APP, configured), deviceDeps());
      if (failed.length > 0) console.error(`Not logged in: ${failed.join(", ")}. Rerun to retry them.`);
      return failed.length > 0 ? 1 : 0;
    }
    await login(family, deviceDeps());
    return 0;
  }
  if (first === "allow") {
    const parsed = parseAllowArgs(rest);
    if (parsed === undefined) {
      console.error(USAGE);
      return 1;
    }
    if (inAgentSession(env)) {
      throw new Failure("granting a release", `an agent cannot grant itself a release; John runs \`agent-gh allow release ${parsed.tag}\` in his own terminal`);
    }
    const repo = await resolveRepo("gh", rest, env, () => originUrl(process.cwd()));
    if (repo === undefined) throw new Failure("granting a release", "no -R, GH_REPO, or github.com origin remote; run it inside a clone of the repository or pass -R OWNER/REPO");
    // The person's own gh, past agent-gh's shims, so GitHub records the issue as theirs with no App.
    const gh = whichReal("gh", env.PATH, defaultShimDir());
    const plain: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) if (value !== undefined) plain[name] = value;
    return allowRelease(
      {
        gh:
          gh === undefined
            ? undefined
            : async (args) => {
                const child = Bun.spawn([gh, ...args], { env: plain, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
                const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
                return { code, stdout };
              },
        print: (line) => console.error(line),
        out: (text) => process.stdout.write(text),
      },
      repo,
      parsed.tag,
      parsed.sha,
    );
  }
  if (first === "waive") {
    const parsed = flagPairs(rest, 0, ["--reason", "--pr"]);
    const pr = prFlag(parsed?.values["--pr"]);
    const reason = parsed?.values["--reason"];
    if (reason === undefined || Number.isNaN(pr)) {
      console.error(USAGE);
      return 1;
    }
    if (!inAgentSession(env)) throw new Failure("waiving the review", "John waives a review by adding the waiver label himself; `agent-gh waive` is for an orchestrator session");
    const repo = await resolveRepo("git", [], env, () => originUrl(process.cwd()));
    if (repo === undefined) throw new Failure("waiving the review", "no GH_REPO and no github.com origin remote; run it inside a clone of the repository");
    // The session's own harness and session id, acting through the orchestrator's App.
    const context: Context = { identity: { ...detectIdentity(env), family: ORCHESTRATOR }, repo, env, api: GITHUB, configDir: defaultConfigDir(), registry: REGISTRY, nowSeconds, sleep: (ms) => Bun.sleep(ms) };
    return withToken(context, async (childEnv) => {
      await waiveCommand(reviewIo(context, repo, childEnv), { reason, ...(pr === undefined ? {} : { pr }) });
      return 0;
    });
  }
  if (first === "claim" || first === "release" || first === "claims" || first === "next") return claimCommand(first, rest, env);
  if (first === "graph") return graphCommand(rest, env);
  const review = first === "review" ? reviewOptions(rest) : undefined;
  const replying = first === "reply" ? replyOptions(rest) : undefined;
  const notifying = first === "notify" ? await notifyOptions(rest) : undefined;
  if ((first === "review" && review === undefined) || (first === "reply" && replying === undefined) || (first === "notify" && notifying === undefined)) {
    console.error(USAGE);
    return 1;
  }
  // doctor also checks a person's shell, with the read App; every other command needs an agent session.
  const identity = first === "doctor" && personShell(env) ? PERSON : detectIdentity(env);
  const args = first === "gh" ? rest : argv;
  const local = first === "doctor" || first === "review" || first === "reply" || first === "notify";
  // Outside a clone, a reply or notify that names its thread by URL acts in that thread's repository.
  const named = replying === undefined ? undefined : (parseAddress(replying.address) as { readonly repo?: Repo } | undefined)?.repo;
  const repo =
    (await resolveRepo(local ? "git" : "gh", args, env, () => originUrl(process.cwd()))) ??
    named ??
    (notifying === undefined ? undefined : parseThreadRef(notifying.target, undefined)?.repo);
  const context: Context = {
    identity,
    repo,
    env,
    api: GITHUB,
    configDir: defaultConfigDir(),
    registry: REGISTRY,
    nowSeconds,
    sleep: (ms) => Bun.sleep(ms),
  };
  if (first === "doctor") {
    if (repo === undefined) {
      throw new Failure("resolving the repository", "no GH_REPO and no github.com origin remote; run doctor inside a clone of the repository");
    }
    return doctor({ ...context, repo }, (line) => console.log(line));
  }
  if (review !== undefined) {
    if (repo === undefined) {
      throw new Failure("reviewing", "no GH_REPO and no github.com origin remote; run the review inside a clone of the repository");
    }
    return withToken(context, async (childEnv) => {
      const io = reviewIo(context, repo, childEnv);
      if (review.mode === "full") await reviewFull(io, review);
      else await reviewSweep(io, review);
      return 0;
    });
  }
  if (replying !== undefined || notifying !== undefined) {
    if (repo === undefined) {
      throw new Failure(replying === undefined ? "notifying" : "replying", "no GH_REPO and no github.com origin remote; run it inside a clone of the repository, or name the thread by its URL");
    }
    return withToken(context, async (childEnv) => {
      const io = reviewIo(context, repo, childEnv);
      if (replying !== undefined) await replyCommand(io, sessionId(env), replying);
      else if (notifying !== undefined) await notifyCommand(io, sessionId(env), notifying);
      return 0;
    });
  }
  if (args.length === 0) {
    console.error(USAGE);
    return 1;
  }
  return dispatchGh(args, repo, {
    withToken: (target, use) => withToken({ ...context, repo: target }, use),
    readFile: async (path) => {
      try {
        return await Bun.file(path).text();
      } catch {
        return undefined;
      }
    },
    readStdin: async () => {
      try {
        return await Bun.stdin.text();
      } catch {
        return undefined;
      }
    },
    io: (target, childEnv) => reviewIo({ ...context, repo: target }, target, childEnv),
    runWith: async (ghArgs, childEnv) => (await runChild(["gh", ...ghArgs], childEnv)).code,
    run: (ghArgs) => runAs(context, ["gh", ...ghArgs]),
  });
};

try {
  process.exitCode = await main(Bun.argv.slice(2));
} catch (error) {
  console.error(
    error instanceof Failure
      ? describe(error)
      : `agent-gh: unexpected ${error instanceof Error ? error.name : "error"}.\n${NEXT_STEP}`,
  );
  process.exitCode = 1;
}
