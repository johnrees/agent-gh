import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESSES, inAgentSession } from "../src/harness.ts";
import { bareWrite } from "../src/hook.ts";
import { ghShim, gitShim, rcBlock, sessionFunction, withBlock } from "../src/shims.ts";

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
