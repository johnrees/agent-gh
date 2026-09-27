import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HARNESSES, inAgentSession } from "../src/harness.ts";
import { ghShim, rcBlock, realFunction, sessionFunction, SHIM_HOPS, whichReal, withBlock } from "../src/shims.ts";

/** A Claude Code agent session; a person's shell has neither variable. */
const AGENT = { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" };

/**
 * A shim directory and a bin directory holding a fake real git and gh and a
 * fake agent-gh, each logging how it was called. PATH holds only those two
 * directories: the shim finds the fakes, and any other program it tried to
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
  writeFileSync(join(shims, "gh"), ghShim(shims, agentGh, agentMachine));
  chmodSync(join(shims, "gh"), 0o755);
  const run = (args: string[], env: Record<string, string> = {}, path = `${shims}:${bin}`) => {
    writeFileSync(log, "");
    const result = Bun.spawnSync([join(shims, "gh"), ...args], { env: { PATH: path, ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, log: readFileSync(log, "utf8").trim(), stderr: result.stderr.toString() };
  };
  return { root, shims, bin, run };
};

test("a person's gh is the real one, run with shell builtins only", () => {
  const { run } = world();
  expect(run(["pr", "create", "--fill"])).toMatchObject({ code: 0, log: "REAL gh pr create --fill token=" });
});

test("an agent session's gh goes through agent-gh, except gh's own version and help", () => {
  const { run } = world();
  expect(run(["pr", "create", "--draft"], AGENT).log).toBe("AGENT-GH gh pr create --draft");
  expect(run(["issue", "view", "3"], AGENT).log).toBe("AGENT-GH gh issue view 3");
  expect(run(["--version"], AGENT).log).toBe("REAL gh --version token=");
});

test("agent-gh's own children reach the real gh, however PATH lists the shims", () => {
  const { run, shims, bin } = world();
  expect(run(["pr", "create"], { ...AGENT, AGENT_GH_CHILD: "1" }).log).toBe("REAL gh pr create token=");
  expect(run(["pr", "list"], {}, `${shims}/:${shims}::${bin}`).log).toBe("REAL gh pr list token=");
  const missing = run(["pr", "list"], {}, shims);
  expect(missing.code).toBe(127);
  expect(missing.stderr).toContain("no gh on PATH outside");
});

test("on an agent machine a person's gh reads with the read App's token, and never overrides a token already set", () => {
  const { run, root } = world(true);
  expect(run(["pr", "list"]).log).toBe("REAL gh pr list token=ghu_read_only");
  expect(run(["pr", "list"], { GH_TOKEN: "given" }).log).toBe("REAL gh pr list token=given");
  expect(run(["pr", "create"], AGENT).log).toBe("AGENT-GH gh pr create");
  writeFileSync(join(root, "no-read"), "");
  expect(run(["pr", "list"]).log).toBe("REAL gh pr list token=");
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

test("the generated shim holds no path with a quote that could break out of the shell", () => {
  expect(() => ghShim("/it's/shims", "/bin/agent-gh", false)).toThrow("single quote");
  expect(() => ghShim("/shims", "/it's/agent-gh", true)).toThrow("single quote");
});

/** The shells a shim meets: /bin/sh (bash on macOS, Fedora, and Arch; dash on Debian and Ubuntu), dash, and bash, each once. */
const SHELLS = [
  ...new Set(["/bin/sh", "/bin/dash", "/usr/bin/dash", "/bin/bash"].filter((path) => existsSync(path)).map((path) => realpathSync(path))),
];

/** Writes `text` to `dir/name` as an executable script run by `shell`, as a test fixture copying `command -v gh` would. */
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
  test(`a copy of the gh shim runs the real gh past itself, however it is named, under ${shell}`, () => {
    const { root, shims } = world();
    const log = join(root, "log");
    const copy = join(root, "copy");
    place(copy, "gh", readFileSync(join(shims, "gh"), "utf8"), shell);
    // hops=0: the copy ran the real gh itself, rather than running itself again first.
    const bin = dirname(place(join(root, "real"), "gh", `#!/bin/sh\necho "REAL gh $* hops=$AGH_SHIM_HOPS" >> '${log}'\n`, shell));
    const cases: [string[], string, string?][] = [
      [[join(copy, "gh"), "status"], `${copy}:${shims}:${bin}`],
      [[join(copy, "gh"), "status"], `${copy}/:${bin}`],
      [[shell, "gh", "status"], `${copy}:${bin}`, copy],
      [["./gh", "status"], `.:${bin}`, copy],
      [[`${root}/copy/../copy/gh`, "status"], `${copy}:${bin}`],
    ];
    for (const [program, path, cwd] of cases) {
      writeFileSync(log, "");
      const result = bounded(program, { PATH: path }, cwd);
      expect([program, path, result.code, result.stderr, readFileSync(log, "utf8")]).toEqual([program, path, 0, "", "REAL gh status hops=0\n"]);
    }
  });

  test(`copies of the shim that reach each other, or no real git, fail loudly and never loop, under ${shell}`, () => {
    const { root, shims } = world();
    const text = readFileSync(join(shims, "gh"), "utf8");
    const a = place(join(root, "a"), "gh", text, shell);
    const b = place(join(root, "b"), "gh", text, shell);
    const both = bounded([a, "status"], { PATH: `${dirname(a)}:${dirname(b)}:${shims}` });
    expect(both).toMatchObject({ code: 127, timedOut: false, stdout: "" });
    const trail = [a, b, a, b].slice(0, SHIM_HOPS + 1).join(", ");
    expect(both.stderr).toBe(
      `agent-gh shim: ${trail} ran in turn and never reached the real gh: a copy of the shim, or a wrapper that runs gh from PATH, is ahead of it. Copy the real gh instead: $(agent-gh which gh)\n`,
    );
    const alone = bounded([a, "status"], { PATH: `${dirname(a)}:${shims}` });
    expect(alone).toMatchObject({ code: 127, timedOut: false, stdout: "" });
    expect(alone.stderr).toBe(
      `agent-gh shim: ${a} is a copy of the gh shim in ${shims}, and no real gh follows it on PATH. Copy the real gh instead: $(agent-gh which gh)\n`,
    );
  });

  test(`the v0.1.1 shim, copied with the real program later on PATH, runs itself until killed, under ${shell}`, () => {
    const { root, shims, bin } = world();
    const current = ghShim(shims, join(bin, "agent-gh"), false);
    expect(current).toContain(realFunction(shims));
    const copy = place(join(root, "copy"), "gh", current.replace(realFunction(shims), oldReal(shims)), shell);
    const result = Bun.spawnSync([copy, "status"], { env: { PATH: `${dirname(copy)}:${bin}` }, stdout: "pipe", stderr: "pipe", timeout: 1500 });
    expect(result.exitedDueToTimeout).toBe(true);
    expect(existsSync(join(root, "log"))).toBe(false); // the real gh never ran
  });
}

test("agent-gh which prints the real git and gh, past the shims and any copy of them", async () => {
  const { root, shims, bin } = world();
  const copy = place(join(root, "copy"), "gh", readFileSync(join(shims, "gh"), "utf8"), "/bin/sh");
  const path = `${dirname(copy)}:${shims}:${bin}`;
  expect(whichReal("gh", path, shims)).toBe(join(bin, "gh"));
  expect(whichReal("git", path, shims)).toBe(join(bin, "git"));
  expect(whichReal("gh", `${dirname(copy)}:${shims}`, shims)).toBeUndefined();
  const main = join(import.meta.dir, "..", "src", "main.ts");
  const which = (...args: string[]) => bounded([process.execPath, main, "which", ...args], { PATH: path, HOME: root });
  expect(which("git")).toMatchObject({ code: 0, stdout: `${join(bin, "git")}\n` });
  expect(which("svn")).toMatchObject({ code: 1, stdout: "" });
});
