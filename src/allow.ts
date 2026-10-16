import { Failure } from "./failure.ts";
import { type Repo, slug } from "./repo.ts";

/**
 * John's grant of one release: an issue he opens himself, which the release
 * guard (review-run.ts's `gateRelease`) looks for before an agent session
 * pushes a tag or writes a release. Agents run as the same Unix user as
 * John, so anything local (a variable, a file) they could write themselves;
 * an issue GitHub records as opened by the owner with no App is something an
 * agent's App cannot make.
 */
export const GRANT_LABEL = "agent-release";
export const GRANT_HOURS = 24;

/** What a grant allows: `tag`, at the commit `sha` when John names one. */
export type GrantMarker = { readonly v: 1; readonly action: "release"; readonly tag: string; readonly sha: string | null };

const MARKER = /<!-- agent-gh-allow (\{[^\n]*?\}) -->/;
const SHA = /^[0-9a-f]{40}$/;

export const grantMarker = (marker: GrantMarker): string => `<!-- agent-gh-allow ${JSON.stringify(marker)} -->`;

/** The grant marker in an issue's body; undefined when there is none or it is malformed. */
export const parseGrant = (body: string): GrantMarker | undefined => {
  const match = MARKER.exec(body);
  if (match === null) return undefined;
  try {
    const value = JSON.parse(match[1] as string) as Record<string, unknown>;
    const ok = value.v === 1 && value.action === "release" && typeof value.tag === "string" && validTag(value.tag) && (value.sha === null || (typeof value.sha === "string" && SHA.test(value.sha)));
    return ok ? { v: 1, action: "release", tag: value.tag as string, sha: value.sha as string | null } : undefined;
  } catch {
    return undefined;
  }
};

/** A tag name git accepts (`git check-ref-format`'s rules for `refs/tags/<tag>`), so a grant names one exactly. */
export const validTag = (tag: string): boolean =>
  tag !== "" &&
  tag !== "@" &&
  !/[\x00-\x20\x7f~^:?*[\\]/.test(tag) &&
  !tag.includes("..") &&
  !tag.includes("@{") &&
  !tag.includes("//") &&
  !tag.startsWith("/") &&
  !tag.startsWith("-") &&
  !tag.endsWith("/") &&
  !tag.endsWith(".") &&
  tag.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/**
 * Why an issue, as GitHub's REST API lists it, is not the owner's grant, or
 * undefined when nothing on it says so. A grant is an open issue (never a
 * pull request: GitHub records no App for one) opened by the repository's
 * owner with no App (`performed_via_github_app` null), under GRANT_HOURS old
 * at `nowMs`. Its history (unedited, never closed or transferred) and its
 * marker's tag and commit are checked apart.
 */
export const grantProblem = (issue: Record<string, unknown>, owner: string, nowMs: number): string | undefined => {
  if (issue.pull_request !== undefined) return "is a pull request, which GitHub never records as opened through an App";
  if (issue.state !== "open") return "is closed";
  const login = typeof record(issue.user).login === "string" ? (record(issue.user).login as string) : "";
  if (login.toLowerCase() !== owner.toLowerCase()) return `was opened by ${login === "" ? "nobody GitHub names" : login}, not the repository's owner, ${owner}`;
  if (issue.performed_via_github_app !== null) {
    const app = record(issue.performed_via_github_app).slug;
    return issue.performed_via_github_app === undefined ? "does not say whether an App opened it" : `was opened through ${typeof app === "string" ? `the ${app} App` : "an App"}, as an agent's would be`;
  }
  const created = typeof issue.created_at === "string" ? Date.parse(issue.created_at) : Number.NaN;
  if (Number.isNaN(created)) return "has no time it was opened";
  if (created > nowMs + 5 * 60_000) return "is dated in the future";
  if (nowMs - created >= GRANT_HOURS * 3_600_000) return `expired ${GRANT_HOURS} hours after it was opened`;
  return undefined;
};

/** The shell word for `value`: as it is when the shell reads it so, else single-quoted. */
const shellWord = (value: string): string => (/^[A-Za-z0-9._/+@%=,:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/** The command John runs to grant `tag` in `repo` (its clone's, when undefined), which every release refusal names. */
export const grantCommand = (tag: string, repo: Repo | undefined): string => `agent-gh allow release ${tag === "<tag>" ? tag : shellWord(tag)}${repo === undefined ? "" : ` -R ${slug(repo)}`}`;

export const grantTitle = (tag: string): string => `Release ${tag}`;

/** The grant issue's body: a sentence, then its marker. */
export const grantBody = (repo: Repo, tag: string, sha: string | null): string =>
  [
    `Agents may push tag \`${tag}\` to ${slug(repo)} once, ${sha === null ? "at whichever commit they tag" : `at ${sha}`}, and create or edit its release, for ${GRANT_HOURS} hours from when this issue was opened. Close it to revoke the grant; editing it voids it.`,
    "",
    grantMarker({ v: 1, action: "release", tag, sha }),
  ].join("\n");

/** `agent-gh allow release`'s arguments after `allow`: the tag, `--at <sha>`, and `-R`/`--repo` (read by `resolveRepo`). */
export const parseAllowArgs = (args: readonly string[]): { readonly tag: string; readonly sha: string | null } | undefined => {
  const [action, tag, ...rest] = args;
  if (action !== "release" || tag === undefined || !validTag(tag)) return undefined;
  let sha: string | null = null;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    // gh's attached spellings, `-Ro/r` and `-R=o/r`.
    if (arg.startsWith("-R") && arg.length > 2) continue;
    const [flag, attached] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = attached ?? rest[++index];
    if (value === undefined) return undefined;
    if (flag === "--at") {
      if (sha !== null || !/^[0-9a-fA-F]{40}$/.test(value)) return undefined;
      sha = value.toLowerCase();
    } else if (flag !== "-R" && flag !== "--repo") return undefined;
  }
  return { tag, sha };
};

/** What `agent-gh allow release` needs: the person's own gh (never a shim), and where to print. */
export type AllowIo = {
  /** Runs the person's gh with `args`; undefined when there is no gh but agent-gh's shims. */
  readonly gh: ((args: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string }>) | undefined;
  /** Notes, to stderr. */
  readonly print: (line: string) => void;
  /** What the person copies (the issue, or the form to paste), to stdout. */
  readonly out: (text: string) => void;
};

const STAGE = "granting a release";

/** The grant as the person opens it on the web: a prefilled new-issue link, and its fields to paste. */
const pasteForm = (io: AllowIo, repo: Repo, tag: string, sha: string | null, why: string): number => {
  const body = grantBody(repo, tag, sha);
  const query = new URLSearchParams({ title: grantTitle(tag), labels: GRANT_LABEL, body });
  io.print(`agent-gh: ${why}, so open the grant yourself on GitHub, signed in as ${repo.owner}:`);
  io.out(
    [
      `https://github.com/${slug(repo)}/issues/new?${query.toString()}`,
      "",
      `or open an issue in ${slug(repo)} by hand, with`,
      `title: ${grantTitle(tag)}`,
      `label: ${GRANT_LABEL} (create it first if ${slug(repo)} has none; the guard finds grants by it)`,
      "body:",
      body,
      "",
    ].join("\n"),
  );
  return 1;
};

const json = (stdout: string): Record<string, unknown> => {
  try {
    return record(JSON.parse(stdout));
  } catch {
    return {};
  }
};

/**
 * `agent-gh allow release <tag> [--at <sha>]`, in the person's own terminal:
 * opens the grant issue in `repo` with the person's own gh, so GitHub records
 * it as theirs with no App, labelled GRANT_LABEL (created when missing). Where
 * that gh does not act as the owner (an agent machine's only reads), it prints
 * the issue to open on the web instead. Returns the exit code: 0 once the
 * grant is open.
 */
export const allowRelease = async (io: AllowIo, repo: Repo, tag: string, sha: string | null): Promise<number> => {
  const gh = io.gh;
  if (gh === undefined) return pasteForm(io, repo, tag, sha, "there is no gh here but agent-gh's shims");
  const user = await gh(["api", "user", "--jq", ".login"]);
  const login = user.stdout.trim();
  if (user.code !== 0 || login === "") return pasteForm(io, repo, tag, sha, "gh here is not logged in (an agent machine's gh only reads)");
  const repository = await gh(["api", `repos/${slug(repo)}`, "--jq", ".owner.login"]);
  const owner = repository.stdout.trim();
  if (repository.code !== 0 || owner === "") throw new Failure(STAGE, `gh, logged in as ${login}, cannot read ${slug(repo)}`);
  if (owner.toLowerCase() !== login.toLowerCase()) {
    return pasteForm(io, repo, tag, sha, `a grant counts only when ${slug(repo)}'s owner, ${owner}, opens it, and gh here is logged in as ${login}`);
  }
  if ((await gh(["api", `repos/${slug(repo)}/labels/${encodeURIComponent(GRANT_LABEL)}`, "--silent"])).code !== 0) {
    const made = await gh(["api", `repos/${slug(repo)}/labels`, "-f", `name=${GRANT_LABEL}`, "-f", "color=b60205", "-f", "description=A grant from the owner: agents may push this tag and write its release (agent-gh allow release)", "--silent"]);
    if (made.code !== 0) throw new Failure(STAGE, `gh could not create the \`${GRANT_LABEL}\` label in ${slug(repo)}, which the guard finds grants by`);
  }
  const opened = await gh(["api", `repos/${slug(repo)}/issues`, "-f", `title=${grantTitle(tag)}`, "-f", `body=${grantBody(repo, tag, sha)}`, "-f", `labels[]=${GRANT_LABEL}`]);
  const issue = json(opened.stdout);
  if (opened.code !== 0 || !Number.isSafeInteger(issue.number)) return pasteForm(io, repo, tag, sha, `gh could not open the grant issue in ${slug(repo)}`);
  const problem = grantProblem(issue, owner, Date.now());
  if (problem !== undefined) {
    return pasteForm(io, repo, tag, sha, `#${issue.number as number} ${problem}, and grants nothing (close it)`);
  }
  io.out(`${typeof issue.html_url === "string" ? issue.html_url : `${slug(repo)}#${issue.number as number}`}\n`);
  io.print(
    `agent-gh: #${issue.number as number} grants \`${tag}\` in ${slug(repo)} for ${GRANT_HOURS} hours${sha === null ? "" : ` at ${sha.slice(0, 8)}`}: an agent may push that tag once and create or edit its release. Close the issue to revoke it.`,
  );
  return 0;
};
