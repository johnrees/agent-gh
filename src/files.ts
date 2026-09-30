import { chmodSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";

/**
 * Replaces `link` with `text` through a temporary file and a rename. The
 * replacement keeps the original's permissions: a startup or settings file
 * someone made private stays private. The temporary file is private from the
 * start, so the text is never readable by others in between. A symlink (a
 * dotfiles repository's) is followed and its target replaced, so the link
 * still points at the managed file.
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
  const temp = `${path}.agent-gh.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, mode ?? 0o666 & ~process.umask());
  renameSync(temp, path);
};
