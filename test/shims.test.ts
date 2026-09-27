import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HARNESSES, inAgentSession } from "../src/harness.ts";
import { bareWrite } from "../src/hook.ts";
import { defaultShimDir, ghShim, gitShim, rcBlock, realFunction, sessionFunction, SHIM_HOPS, whichReal, withBlock } from "../src/shims.ts";

/** A Claude Code agent session; a person's shell has neither variable. */
const AGENT = { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" };

/**
 * A shim directory and a bin directory holding a fake real git and gh and a
 * fake agent-gh, each logging how it was called. PATH holds only those two
 * directories: the shims find the fakes, and any other program they tried to
 * start (tr, sed, agent-gh itself on a person's path) would not exist.
 */
const world = (agentMachine = false) => {
  const root = mkdtempSync(join(tmpdir(), "agent-gh-shims-"));
  const shims = join(root, "shims");
  const bin = join(root, "bin");
  mkdirSync(shims);
  mkdirSync(bin);
  const log = join(root, "log");
  const script = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  script(join(bin, "git"), `echo "REAL git $*" >> '${log}'`);
  script(join(bin, "gh"), `echo "REAL gh $* token=\${GH_TOKEN-}" >> '${log}'`);
  const agentGh = join(bin, "agent-gh");
  script(
    agentGh,
    `if [ "$1" = read-token ]; then [ -f '${root}/no-read' ] && exit 1; echo ghu_read_only; exit 0; fi\necho "AGENT-GH $*" >> '${log}'`,
  );
  writeFileSync(join(shims, "git"), gitShim(shims, agentGh));
  writeFileSync(join(shims, "gh"), ghShim(shims, agentGh, agentMachine));
  chmodSync(join(shims, "git"), 0o755);
  chmodSync(join(shims, "gh"), 0o755);
  const run = (name: "git" | "gh", args: string[], env: Record<string, string> = {}, path = `${shims}:${bin}`) => {
    writeFileSync(log, "");
    const result = Bun.spawnSync([join(shims, name), ...args], { env: { PATH: path, ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, log: readFileSync(log, "utf8").trim(), stderr: result.stderr.toString() };
  };
  return { root, shims, bin, run };
};

test("a person's git and gh are the real ones, run with shell builtins only", () => {
  const { run } = world();
  expect(run("git", ["status"])).toMatchObject({ code: 0, log: "REAL git status" });
  expect(run("git", ["commit", "-m", "mine"])).toMatchObject({ code: 0, log: "REAL git commit -m mine" });
  expect(run("git", ["push", "origin", "main"])).toMatchObject({ code: 0, log: "REAL git push origin main" });
  expect(run("gh", ["pr", "create", "--fill"])).toMatchObject({ code: 0, log: "REAL gh pr create --fill token=" });
});

test("an agent session's commits and pushes go through agent-gh, and its reads stay with the real git", () => {
  const { run } = world();
  expect(run("git", ["status"], AGENT).log).toBe("REAL git status");
  expect(run("git", ["log", "--oneline"], AGENT).log).toBe("REAL git log --oneline");
  expect(run("git", ["fetch", "origin"], AGENT).log).toBe("REAL git fetch origin");
  expect(run("git", ["commit", "-m", "x"], AGENT).log).toBe("AGENT-GH git commit -m x");
  expect(run("git", ["-C", "/r", "-c", "a=b", "push", "origin", "b"], AGENT).log).toBe("AGENT-GH git -C /r -c a=b push origin b");
  expect(run("git", ["merge", "feature"], AGENT).log).toBe("AGENT-GH git merge feature");
  expect(run("git", ["rebase", "--abort"], AGENT).log).toBe("REAL git rebase --abort");
  expect(run("git", ["cherry-pick", "--quit"], AGENT).log).toBe("REAL git cherry-pick --quit");
});

test("the git shim routes exactly the commands the Claude Code hook calls writes", () => {
  const { run } = world();
  const cases = [
    ["status"], ["diff", "--stat"], ["commit", "-m", "x"], ["commit", "--amend", "--no-edit"], ["push"], ["push", "--force"],
    ["-C", "/r", "commit", "-am", "x"], ["-c", "core.hooksPath=/dev/null", "commit"], ["merge", "--continue"], ["merge", "--abort"],
    ["pull", "--rebase"], ["revert", "HEAD"], ["am", "p.patch"], ["am", "--quit"], ["rebase", "-i", "main"], ["fetch"], ["branch", "-a"],
    ["--git-dir", "/g", "log"], ["--no-pager", "log"], ["stash"], ["tag", "v1"], ["worktree", "list"],
  ];
  for (const args of cases) {
    const routed = run("git", args, AGENT).log.startsWith("AGENT-GH");
    expect([args.join(" "), routed]).toEqual([args.join(" "), bareWrite(`git ${args.join(" ")}`)?.startsWith("git ") ?? false]);
  }
});

test("an agent session's gh goes through agent-gh, except gh's own version and help", () => {
  const { run } = world();
  expect(run("gh", ["pr", "create", "--draft"], AGENT).log).toBe("AGENT-GH gh pr create --draft");
  expect(run("gh", ["issue", "view", "3"], AGENT).log).toBe("AGENT-GH gh issue view 3");
  expect(run("gh", ["--version"], AGENT).log).toBe("REAL gh --version token=");
});

test("agent-gh's own children reach the real git and gh, however PATH lists the shims", () => {
  const { run, shims, bin } = world();
  const child = { ...AGENT, AGENT_GH_CHILD: "1" };
  expect(run("git", ["commit", "-m", "x"], child).log).toBe("REAL git commit -m x");
  expect(run("gh", ["pr", "create"], child).log).toBe("REAL gh pr create token=");
  expect(run("git", ["status"], {}, `${shims}/:${shims}::${bin}`).log).toBe("REAL git status");
  const missing = run("git", ["status"], {}, shims);
  expect(missing.code).toBe(127);
  expect(missing.stderr).toContain("no git on PATH outside");
});

test("on an agent machine a person's gh reads with the read App's token, and never overrides a token already set", () => {
  const { run, root } = world(true);
  expect(run("gh", ["pr", "list"]).log).toBe("REAL gh pr list token=ghu_read_only");
  expect(run("gh", ["pr", "list"], { GH_TOKEN: "given" }).log).toBe("REAL gh pr list token=given");
  expect(run("gh", ["pr", "create"], AGENT).log).toBe("AGENT-GH gh pr create");
  writeFileSync(join(root, "no-read"), "");
  expect(run("gh", ["pr", "list"]).log).toBe("REAL gh pr list token=");
});

test("the shims' session test agrees with agent-gh's harness table", () => {
  const names = [...new Set(HARNESSES.flatMap((harness) => harness.rules.flat().map((condition) => condition.name)))];
  const values = [undefined, "", " ", "1", "x"];
  const fn = sessionFunction();
  const cases: Record<string, string>[] = [];
  for (const name of names) for (const value of values) cases.push(value === undefined ? {} : { [name]: value });
  for (const a of values) for (const b of values) {
    const env: Record<string, string> = {};
    if (a !== undefined) env.CLAUDECODE = a;
    if (b !== undefined) env.CLAUDE_CODE_CHILD_SESSION = b;
    cases.push(env);
  }
  for (const env of cases) {
    const shell = Bun.spawnSync(["/bin/sh", "-c", `${fn}\nagh_session`], { env }).exitCode === 0;
    expect([env, shell]).toEqual([env, inAgentSession(env)]);
  }
});

test("the startup block puts the shims then agent-gh first, once, in sh, bash, and zsh", () => {
  const block = rcBlock("/h/.local/share/agent-gh/shims", "/h/.local/bin");
  expect(withBlock(withBlock("export X=1\n", block), block)).toBe(withBlock("export X=1\n", block));
  expect(withBlock("", block)).toBe(`${block}\n`);
  // zsh -f: no startup files, which would add their own PATH entries.
  for (const shell of [["/bin/sh"], ["/bin/bash", "--norc", "--noprofile"], ["/bin/zsh", "-f"]].filter(([path]) => existsSync(path!))) {
    const out = Bun.spawnSync([...shell, "-c", `${block}\n${block}\nprintf %s "$PATH"`], {
      env: { PATH: "/usr/bin:/h/.local/bin:/bin:/h/.local/share/agent-gh/shims" },
    });
    expect([shell[0], out.stdout.toString()]).toEqual([shell[0], "/h/.local/share/agent-gh/shims:/h/.local/bin:/usr/bin:/bin"]);
  }
});

test("the generated shims hold no path with a quote that could break out of the shell", () => {
  expect(() => gitShim("/it's/shims", "/bin/agent-gh")).toThrow("single quote");
  expect(() => ghShim("/shims", "/it's/agent-gh", true)).toThrow("single quote");
});

/** The POSIX shells a shim meets: /bin/sh (bash on macOS, dash on Debian and Ubuntu) and dash, each once. */
const SHELLS = [...new Set(["/bin/sh", "/bin/dash", "/usr/bin/dash"].filter((path) => existsSync(path)).map((path) => realpathSync(path)))];

/** Writes `text` to `dir/name` as an executable script run by `shell`, as a test fixture copying `command -v git` would. */
const place = (dir: string, name: string, text: string, shell: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text.replace(/^#!\/bin\/sh\n/, `#!${shell}\n`));
  chmodSync(join(dir, name), 0o755);
  return join(dir, name);
};

/** Runs `program` with only `env`, killed after five seconds: a shim that loops is a failure, not a hung test. */
const bounded = (program: string[], env: Record<string, string>, cwd?: string) => {
  const result = Bun.spawnSync(program, { env, ...(cwd === undefined ? {} : { cwd }), stdout: "pipe", stderr: "pipe", timeout: 5000 });
  return { code: result.exitCode, timedOut: result.exitedDueToTimeout === true, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
};

/** agent-gh v0.1.1's agh_real, which skipped only the shim directory: a copy of the shim found itself. */
const oldReal = (shims: string) =>
  [
    `AGH_SHIMS='${shims}'`,
    "agh_real() {",
    '  agh_rest="$PATH:"',
    '  while [ -n "$agh_rest" ]; do',
    "    agh_dir=${agh_rest%%:*}",
    "    agh_rest=${agh_rest#*:}",
    '    case $agh_dir in "" | "$AGH_SHIMS" | "$AGH_SHIMS/") continue ;; esac',
    '    if [ -f "$agh_dir/$1" ] && [ -x "$agh_dir/$1" ]; then AGH_REAL=$agh_dir/$1; return 0; fi',
    "  done",
    '  echo "agent-gh shim: no $1 on PATH outside $AGH_SHIMS" >&2',
    "  exit 127",
    "}",
  ].join("\n");

for (const shell of SHELLS) {
  test(`a copy of the git shim runs the real git past itself, however it is named, under ${shell}`, () => {
    const { root, shims } = world();
    const log = join(root, "log");
    const copy = join(root, "copy");
    place(copy, "git", readFileSync(join(shims, "git"), "utf8"), shell);
    // hops=0: the copy ran the real git itself, rather than running itself again first.
    const bin = dirname(place(join(root, "real"), "git", `#!/bin/sh\necho "REAL git $* hops=$AGH_SHIM_HOPS" >> '${log}'\n`, shell));
    const cases: [string[], string, string?][] = [
      [[join(copy, "git"), "status"], `${copy}:${shims}:${bin}`],
      [[join(copy, "git"), "status"], `${copy}/:${bin}`],
      [[shell, "git", "status"], `${copy}:${bin}`, copy],
      [["./git", "status"], `.:${bin}`, copy],
      [[`${root}/copy/../copy/git`, "status"], `${copy}:${bin}`],
    ];
    for (const [program, path, cwd] of cases) {
      writeFileSync(log, "");
      const result = bounded(program, { PATH: path }, cwd);
      expect([program, path, result.code, result.stderr, readFileSync(log, "utf8")]).toEqual([program, path, 0, "", "REAL git status hops=0\n"]);
    }
  });

  test(`copies of the shim that reach each other, or no real git, fail loudly and never loop, under ${shell}`, () => {
    const { root, shims } = world();
    const text = readFileSync(join(shims, "git"), "utf8");
    const a = place(join(root, "a"), "git", text, shell);
    const b = place(join(root, "b"), "git", text, shell);
    const both = bounded([a, "status"], { PATH: `${dirname(a)}:${dirname(b)}:${shims}` });
    expect(both).toMatchObject({ code: 127, timedOut: false, stdout: "" });
    const trail = [a, b, a, b].slice(0, SHIM_HOPS + 1).join(", ");
    expect(both.stderr).toBe(
      `agent-gh shim: ${trail} ran in turn and never reached the real git: a copy of the shim, or a wrapper that runs git from PATH, is ahead of it. Copy the real git instead: $(agent-gh which git)\n`,
    );
    const alone = bounded([a, "status"], { PATH: `${dirname(a)}:${shims}` });
    expect(alone).toMatchObject({ code: 127, timedOut: false, stdout: "" });
    expect(alone.stderr).toBe(
      `agent-gh shim: ${a} is a copy of the git shim in ${shims}, and no real git follows it on PATH. Copy the real git instead: $(agent-gh which git)\n`,
    );
  });

  test(`the v0.1.1 shim, copied with the real git later on PATH, runs itself until killed, under ${shell}`, () => {
    const { root, shims, bin } = world();
    const current = gitShim(shims, join(bin, "agent-gh"));
    expect(current).toContain(realFunction(shims));
    const copy = place(join(root, "copy"), "git", current.replace(realFunction(shims), oldReal(shims)), shell);
    const result = Bun.spawnSync([copy, "status"], { env: { PATH: `${dirname(copy)}:${bin}` }, stdout: "pipe", stderr: "pipe", timeout: 1500 });
    expect(result.exitedDueToTimeout).toBe(true);
    expect(existsSync(join(root, "log"))).toBe(false); // the real git never ran
  });

  test(`real git running git again (a hook, git -C in it, a chain of aliases) never trips the shim's guard, under ${shell}`, () => {
    const real = whichReal("git", process.env.PATH, defaultShimDir());
    if (real === undefined) throw new Error("the tests need a real git on PATH");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-gh-hooks-")));
    const shims = join(root, "shims");
    const shim = place(shims, "git", gitShim(shims, join(root, "no-agent-gh")), shell);
    const repo = join(root, "repo");
    const log = join(root, "log");
    // git puts its own exec-path first on PATH for hooks and aliases, so each one puts the shim back first, as a test fixture does.
    const path = `${shims}:${dirname(real)}:/usr/bin:/bin`;
    const env = { PATH: path, HOME: root, GIT_CONFIG_NOSYSTEM: "1", AGH_TEST_PATH: path, AGH_TEST_LOG: log };
    const git = (...args: string[]) => bounded([shim, ...args], env);
    expect(git("init", "-q", repo).code).toBe(0);
    const hop = (next: string) => `!PATH="$AGH_TEST_PATH" git ${next}`;
    for (const [key, value] of [
      ["user.name", "Test"],
      ["user.email", "test@example.com"],
      ["core.hooksPath", join(root, "hooks")],
      ["test.marker", "deep"],
      ["alias.one", hop("two")],
      ["alias.two", hop("three")],
      ["alias.three", hop("four")],
      ["alias.four", hop("five")],
      ["alias.five", "config --get test.marker"],
    ] as const) {
      expect(git("-C", repo, "config", key, value).code).toBe(0);
    }
    place(
      join(root, "hooks"),
      "pre-commit",
      `#!/bin/sh\nPATH=$AGH_TEST_PATH\ngit -C '${repo}' rev-parse --is-inside-work-tree >> "$AGH_TEST_LOG" && git -C '${repo}' one >> "$AGH_TEST_LOG"\n`,
      shell,
    );
    const commit = git("-C", repo, "commit", "-q", "--allow-empty", "-m", "through the shim");
    expect([commit.code, commit.timedOut, commit.stderr]).toEqual([0, false, ""]);
    expect(readFileSync(log, "utf8")).toBe("true\ndeep\n");
    expect(git("-C", repo, "log", "--format=%s").stdout).toBe("through the shim\n");
  });
}

test("agent-gh which prints the real git and gh, past the shims and any copy of them", async () => {
  const { root, shims, bin } = world();
  const copy = place(join(root, "copy"), "git", readFileSync(join(shims, "git"), "utf8"), "/bin/sh");
  const path = `${dirname(copy)}:${shims}:${bin}`;
  expect(whichReal("git", path, shims)).toBe(join(bin, "git"));
  expect(whichReal("gh", path, shims)).toBe(join(bin, "gh"));
  expect(whichReal("git", `${dirname(copy)}:${shims}`, shims)).toBeUndefined();
  const main = join(import.meta.dir, "..", "src", "main.ts");
  const which = (...args: string[]) => bounded([process.execPath, main, "which", ...args], { PATH: path, HOME: root });
  expect(which("git")).toMatchObject({ code: 0, stdout: `${join(bin, "git")}\n` });
  expect(which("svn")).toMatchObject({ code: 1, stdout: "" });
});
