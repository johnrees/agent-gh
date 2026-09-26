/**
 * Why a machine's Bun cannot build agent-gh, or undefined when it can. The
 * lockfile and the compiled binary are pinned to one Bun; another version
 * rewrites bun.lock (seen with Arch's bun 1.4.0).
 */
export const bunVersionProblem = (actual: string, pinned: string): string | undefined =>
  actual === pinned
    ? undefined
    : `install-local: this is Bun ${actual}, and agent-gh is pinned to ${pinned} (.bun-version). Install that exact version, then retry:\n  curl -fsSL https://bun.sh/install | bash -s "bun-v${pinned}"\nand make sure ~/.bun/bin comes first on PATH (\`which bun\`).`;
