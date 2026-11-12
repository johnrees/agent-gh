import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.ts";
import { writeAtomic } from "./files.ts";
import { type Api, MissingInstallation, requireInstallation } from "./github.ts";
import { type Repo, slug } from "./repo.ts";

/**
 * How long a yes from `requireInstallation` is remembered. Asking costs a
 * request for the installation and one more for each hundred repositories
 * listed before the one named, and John's newest come last: nine requests for
 * a repository on the eighth page. Asked before every gh command and every
 * git credential request, that was most of the 5,000 requests an hour GitHub
 * allows John through one App. Remembered, it is one walk an hour for each
 * repository, and an hour is the longest a refusal goes unexplained after the
 * App is removed from one.
 */
export const REMEMBER_SECONDS = 3600;

export type InstalledDeps = {
  readonly api: Api;
  readonly dir: string;
  readonly nowSeconds: () => number;
};

const path = (dir: string, family: string): string => join(dir, `${family}.installed.json`);

/** GitHub matches repository names in any case, so one repository is one key. */
const key = (repo: Repo): string => slug(repo).toLowerCase();

/**
 * The repositories the family's App was seen installed on, each with when
 * (Unix seconds): only this App's, seen within REMEMBER_SECONDS and not after
 * now. A file that is missing, unreadable, another App's, or not in this
 * shape remembers nothing, so the worst a bad file does is one more check.
 */
const read = (deps: InstalledDeps, config: AppConfig, family: string): Map<string, number> => {
  const seen = new Map<string, number>();
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path(deps.dir, family), "utf8"));
  } catch {
    return seen;
  }
  if (typeof value !== "object" || value === null) return seen;
  const { app, repos } = value as Record<string, unknown>;
  if (app !== config.slug || typeof repos !== "object" || repos === null) return seen;
  const now = deps.nowSeconds();
  for (const [name, at] of Object.entries(repos)) {
    if (Number.isSafeInteger(at) && at <= now && now - at < REMEMBER_SECONDS) seen.set(name, at);
  }
  return seen;
};

/**
 * Records that the App is, or is no longer, installed on the repository,
 * dropping what `read` no longer counts. Two processes writing at once can
 * lose one's entry, which costs one more check and nothing else, so there is
 * no lock. A directory this process cannot write (a sandbox's) is not an
 * error: the check passed, and the next command asks GitHub again.
 */
const record = (deps: InstalledDeps, config: AppConfig, family: string, repo: Repo, installed: boolean): void => {
  const seen = read(deps, config, family);
  if (installed) seen.set(key(repo), deps.nowSeconds());
  else if (!seen.delete(key(repo))) return;
  try {
    writeAtomic(path(deps.dir, family), `${JSON.stringify({ app: config.slug, repos: Object.fromEntries(seen) })}\n`);
  } catch {
    // Not remembered: asked again next time.
  }
};

/**
 * `requireInstallation`, asking GitHub only when no yes for the repository is
 * remembered in `<family>.installed.json`, or when `recheck` says to ask
 * anyway (doctor's). Only a yes is remembered: a no is asked again every time,
 * so installing the App takes effect at once, and a no on a recheck forgets
 * the yes. Nothing is remembered about a check that failed for another reason.
 *
 * A remembered yes can outlive the installation by up to REMEMBER_SECONDS.
 * GitHub still refuses what the App cannot reach, so nothing more is allowed
 * in that time: the refusal is GitHub's own, unexplained, and git is handed
 * the family's token where it would have fallen back to the read App's.
 */
export const requireInstalled = async (
  deps: InstalledDeps,
  config: AppConfig,
  family: string,
  token: string,
  repo: Repo,
  recheck = false,
): Promise<void> => {
  if (!recheck && read(deps, config, family).has(key(repo))) return;
  try {
    await requireInstallation(deps.api, config, family, token, repo);
  } catch (error) {
    if (error instanceof MissingInstallation) record(deps, config, family, repo, false);
    throw error;
  }
  record(deps, config, family, repo, true);
};
