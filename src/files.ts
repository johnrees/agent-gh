import { chmodSync, renameSync, statSync, writeFileSync } from "node:fs";

/**
 * Replaces `path` with `text` through a temporary file and a rename. The
 * replacement keeps the original's permissions: a startup or settings file
 * someone made private stays private. The temporary file is private from the
 * start, so the text is never readable by others in between.
 */
export const writeAtomic = (path: string, text: string): void => {
  let mode: number | undefined;
  try {
    mode = statSync(path).mode & 0o7777;
  } catch {
    // A new file: the umask decides, as for any other.
  }
  const temp = `${path}.agent-gh.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, mode ?? 0o666 & ~process.umask());
  renameSync(temp, path);
};
