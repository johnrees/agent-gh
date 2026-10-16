import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Installs `built` at `target`, mode 755, unless `target` already is that
 * file; whether it installed. A copy beside the target, then a rename: an
 * interrupted install never leaves a partial binary, and a running one keeps
 * its file. `copy` is the copy itself; tests interrupt it.
 */
export const installBinary = (
  built: string,
  target: string,
  copy: (from: string, to: string) => void = copyFileSync,
): boolean => {
  try {
    if ((statSync(target).mode & 0o777) === 0o755 && readFileSync(target).equals(readFileSync(built))) return false;
  } catch {
    // No target yet: install it.
  }
  mkdirSync(dirname(target), { recursive: true });
  const staged = join(dirname(target), `.agent-gh.${process.pid}.tmp`);
  try {
    copy(built, staged);
    chmodSync(staged, 0o755);
    renameSync(staged, target);
  } finally {
    rmSync(staged, { force: true });
  }
  return true;
};
