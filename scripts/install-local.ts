/**
 * bun run install-local: check the Bun version, install exactly the locked
 * dependencies, build, and install ~/.local/bin/agent-gh.
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bunVersionProblem } from "./bun-version.ts";

const root = join(import.meta.dir, "..");
const problem = bunVersionProblem(Bun.version, readFileSync(join(root, ".bun-version"), "utf8").trim());
if (problem !== undefined) {
  console.error(problem);
  process.exit(1);
}
const run = (command: string[]) => {
  const { exitCode } = Bun.spawnSync(command, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (exitCode !== 0) process.exit(exitCode ?? 1);
};
run([process.execPath, "install", "--frozen-lockfile"]);
run([process.execPath, "run", "build"]);
// A copy beside the target, then a rename: an interrupted install never leaves a partial agent-gh, and a
// running one keeps its file.
const bin = join(homedir(), ".local", "bin");
const staged = join(bin, `.agent-gh.${process.pid}.tmp`);
mkdirSync(bin, { recursive: true });
try {
  copyFileSync(join(root, "dist", "agent-gh"), staged);
  chmodSync(staged, 0o755);
  renameSync(staged, join(bin, "agent-gh"));
} finally {
  rmSync(staged, { force: true });
}
