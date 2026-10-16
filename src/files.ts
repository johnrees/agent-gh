import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Replaces `link` with `text` through a temporary file and a rename. The
 * replacement keeps the original's permissions: a startup or settings file
 * someone made private stays private. The temporary file is private from the
 * start, so the text is never readable by others in between. A symlink (a
 * dotfiles repository's) is followed and its target replaced, so the link
 * still points at the managed file. Each write has its own temporary file,
 * so two agent-gh processes writing at once never rename each other's.
 */
export const writeAtomic = (link: string, text: string): void => {
  let path = link;
  try {
    path = realpathSync(link);
  } catch {
    // A new file, or a dangling link: write where it names.
  }
  let mode: number | undefined;
  try {
    mode = statSync(path).mode & 0o7777;
  } catch {
    // A new file: the umask decides, as for any other.
  }
  const temp = join(dirname(path), `.${basename(path)}.agent-gh.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    chmodSync(temp, mode ?? 0o666 & ~process.umask());
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Never created, or already renamed.
    }
    throw error;
  }
};

/** Writes `text` to `link` as writeAtomic does, only when it differs; whether it wrote. */
export const writeIfChanged = (link: string, text: string): boolean => {
  try {
    if (readFileSync(link, "utf8") === text) return false;
  } catch {
    // Missing or unreadable: write it.
  }
  writeAtomic(link, text);
  return true;
};
