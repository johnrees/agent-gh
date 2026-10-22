/**
 * `agent-gh claim`, `release`, and `claims`: GitHub and git around the
 * pure rule in claim.ts. A claim is a draft pull request (or, for an issue
 * with no code, a comment) holding a marker; the label is a mirror for
 * people and filters, kept in step where agent-gh can, and never read as
 * the truth.
 */
import {
  type Claim,
  claimBody,
  claimBranch,
  claimCommentBody,
  claimCommitMessage,
  type ClaimMarker,
  claimMarkerText,
  claimsOn,
  DEFAULT_CLAIM_LABEL,
  describeClaim,
  emptyClaim,
  firstTake,
  linkedIssues,
  mine,
  type Mismatch,
  mismatch,
  ago,
  parseClaim,
  releaseCommentBody,
  retakeBody,
  takeCommentBody,
  type Taken,
  taken,
  withClaimMarker,
} from "./claim.ts";
import { Failure, type Stage } from "./failure.ts";
import { request } from "./github.ts";
import { parseRemoteUrl, slug } from "./repo.ts";
import { CONFIG_PATH } from "./review.ts";
import { type ApiIo, everyPage } from "./threads-run.ts";

export type GitResult = { readonly code: number; readonly stdout: string };

/** What the claim commands touch, so tests pass a fake GitHub and a throwaway clone. */
export type ClaimIo = ApiIo & {
  /** The session's family and id, which its claims carry. */
  readonly family: string;
  readonly session: string;
  /** Runs git in the working tree (its stderr goes to the caller's); the exit code and trimmed stdout. */
  readonly git: (args: readonly string[]) => Promise<GitResult>;
  /** Progress and notes, to stderr. */
  readonly print: (line: string) => void;
  /** The command's result, to stdout. */
  readonly out: (text: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nowMs: () => number;
  /** How long to wait after posting a claim before reading the competition back (GitHub's lists can lag a write). */
  readonly recheckMs: number;
};

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const repoPath = (io: ApiIo) => `/repos/${slug(io.repo)}`;

const call = async (
  io: ApiIo,
  stage: Stage,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  allow: readonly number[] = [],
) => {
  const { status, value } = await request(io.api, stage, method, path, io.token, body);
  if (status === 401) throw new Failure(stage, "GitHub refused the token (HTTP 401)");
  if ((status < 200 || status >= 300) && !allow.includes(status)) throw new Failure(stage, `HTTP ${status} from ${method} ${path.split("?")[0]}`);
  return { status, value };
};

const repository = async (io: ApiIo, stage: Stage) => {
  const value = record((await call(io, stage, "GET", repoPath(io))).value);
  const base = text(value.default_branch);
  if (base === "") throw new Failure(stage, `${slug(io.repo)}: invalid response`);
  return { base };
};

/**
 * The claim label: `claims.label` in the review config on the default branch
 * (`.github/agent-review.json`), else `claimed`. Only that key is read here,
 * so a config the review commands refuse still names its label.
 */
export const claimLabel = async (io: ApiIo, stage: Stage, base: string): Promise<string> => {
  const { status, value } = await call(io, stage, "GET", `${repoPath(io)}/contents/${CONFIG_PATH}?ref=${encodeURIComponent(base)}`, undefined, [404]);
  if (status === 404) return DEFAULT_CLAIM_LABEL;
  let config: unknown;
  try {
    config = JSON.parse(Buffer.from(text(record(value).content), "base64").toString("utf8"));
  } catch {
    throw new Failure(stage, `${CONFIG_PATH} on ${base} is not valid JSON`);
  }
  const claims = record(config).claims;
  if (claims === undefined) return DEFAULT_CLAIM_LABEL;
  const keys = Object.keys(record(claims));
  const label = record(claims).label;
  if (typeof claims !== "object" || claims === null || Array.isArray(claims) || keys.some((key) => key !== "label")) {
    throw new Failure(stage, `${CONFIG_PATH}: claims takes one key, label`);
  }
  if (label === undefined) return DEFAULT_CLAIM_LABEL;
  if (typeof label !== "string" || label.trim() === "" || label.length > 50) throw new Failure(stage, `${CONFIG_PATH}: claims.label must be a label name of 1 to 50 characters`);
  return label;
};

const openPulls = (io: ApiIo, stage: Stage) => everyPage(io, stage, `${repoPath(io)}/pulls?state=open`);
const comments = (io: ApiIo, stage: Stage, number: number) => everyPage(io, stage, `${repoPath(io)}/issues/${number}/comments`);

/** Issue `number` as REST returns it; undefined when there is none. */
const issueOf = async (io: ApiIo, stage: Stage, number: number): Promise<Record<string, unknown> | undefined> => {
  const { status, value } = await call(io, stage, "GET", `${repoPath(io)}/issues/${number}`, undefined, [404, 410]);
  return status === 200 ? record(value) : undefined;
};

/** The claims on `issue` as GitHub shows them now. */
export const claimState = async (io: ApiIo, stage: Stage, issue: Record<string, unknown>): Promise<Taken> =>
  taken(io.repo, issue, await openPulls(io, stage), await comments(io, stage, issue.number as number));

/** The claim that holds issue `number` now, as `claims` judges it; undefined when nothing does, or there is no such open issue. */
export const holderOf = async (io: ApiIo, stage: Stage, number: number): Promise<Claim | undefined> => {
  const issue = await issueOf(io, stage, number);
  return issue === undefined ? undefined : (await claimState(io, stage, issue)).holder;
};

/** Creates the label when it is missing, then adds it to `issue`; a refusal is reported, since the label only mirrors the claim. */
const addLabel = async (io: ApiIo, stage: Stage, issue: number, label: string, print: (line: string) => void): Promise<void> => {
  const name = encodeURIComponent(label);
  const found = await call(io, stage, "GET", `${repoPath(io)}/labels/${name}`, undefined, [404]);
  if (found.status === 404) {
    const made = await call(io, stage, "POST", `${repoPath(io)}/labels`, { name: label, color: "fbca04", description: "Taken: an agent-gh claim (a draft PR or comment) holds it" }, [403, 404, 422]);
    if (made.status === 403 || made.status === 404) {
      print(`agent-gh: could not create the \`${label}\` label (HTTP ${made.status}): the App may lack Issues write here; create the label in ${slug(io.repo)}'s settings`);
      return;
    }
  }
  const added = await call(io, stage, "POST", `${repoPath(io)}/issues/${issue}/labels`, { labels: [label] }, [403, 404, 422]);
  if (added.status !== 200) print(`agent-gh: could not label #${issue} \`${label}\` (HTTP ${added.status}); the claim stands without it`);
};

/** Removes the label from `issue`, if it is there. */
const removeLabel = async (io: ApiIo, stage: Stage, issue: number, label: string, print: (line: string) => void): Promise<boolean> => {
  const { status } = await call(io, stage, "DELETE", `${repoPath(io)}/issues/${issue}/labels/${encodeURIComponent(label)}`, undefined, [403, 404]);
  if (status === 403) print(`agent-gh: could not remove \`${label}\` from #${issue} (HTTP 403)`);
  return status === 200;
};

const labeled = (issue: Record<string, unknown>, label: string): boolean =>
  Array.isArray(issue.labels) && issue.labels.some((item) => text(record(item).name) === label);

/** Removes the label from `issue` once nothing claims it. */
const settleLabel = async (io: ApiIo, stage: Stage, number: number, label: string, print: (line: string) => void): Promise<void> => {
  const issue = await issueOf(io, stage, number);
  if (issue === undefined || !labeled(issue, label)) return;
  if (!(await claimState(io, stage, issue)).taken && (await removeLabel(io, stage, number, label, print))) print(`agent-gh: removed \`${label}\` from #${number}`);
};

const git = async (io: ClaimIo, stage: Stage, args: readonly string[]): Promise<string> => {
  const result = await io.git(args);
  if (result.code !== 0) throw new Failure(stage, `\`git ${args.slice(0, 2).join(" ")}\` exited ${result.code}`);
  return result.stdout;
};

/** Undoes a claim's branch: on GitHub, then here, back where the session was. */
const dropBranch = async (io: ClaimIo, stage: Stage, branch: string, previous: { readonly branch: string | undefined; readonly sha: string }, remote: boolean) => {
  if (remote) await call(io, stage, "DELETE", `${repoPath(io)}/git/refs/heads/${branch}`, undefined, [404, 422]);
  await io.git(previous.branch === undefined ? ["switch", "-q", "--detach", previous.sha] : ["switch", "-q", previous.branch]);
  await io.git(["branch", "-q", "-D", branch]);
};

/**
 * Refuses a clone whose origin does not fetch from and push to `io.repo`, or
 * whose working tree has uncommitted changes, before a claim moves to a
 * branch. Fetch and every push URL: a clone that fetches here but pushes to
 * a fork, or to a mirror on disk, would push nothing here. A push URL must
 * name this repository, or be the fetch URL itself.
 */
const cleanCloneOfRepo = async (io: ClaimIo, stage: Stage, what: string, why: string): Promise<void> => {
  const fetchUrl = (await io.git(["remote", "get-url", "origin"])).stdout;
  const pushUrls = (await io.git(["remote", "get-url", "--push", "--all", "origin"])).stdout.split("\n");
  const here = (url: string) => {
    const remote = parseRemoteUrl(url);
    return remote !== undefined && slug(remote).toLowerCase() === slug(io.repo).toLowerCase();
  };
  const elsewhere = (url: string) => url === "" || (parseRemoteUrl(url) !== undefined && !here(url));
  if (elsewhere(fetchUrl) || pushUrls.some((url) => url === "" || (url !== fetchUrl && !here(url)))) {
    throw new Failure(stage, `${what} from a clone whose origin fetches from and pushes to ${slug(io.repo)}`);
  }
  if ((await git(io, stage, ["status", "--porcelain", "--untracked-files=no"])) !== "") {
    throw new Failure(stage, `the working tree has uncommitted changes; commit or stash them first, since ${why}`);
  }
};

/** Rounds of reading a new claim back before giving up on seeing it listed. */
const READ_BACK_ROUNDS = 3;

/**
 * Reads the issue and its claims back after posting one, until GitHub lists
 * it (its lists can lag a write): "closed" when the issue closed meanwhile,
 * and undefined when the claim is never listed, since a claim that cannot
 * see itself cannot tell whether it won.
 */
const readBack = async (io: ClaimIo, stage: Stage, number: number, ours: (item: Claim) => boolean, gone?: (item: Claim) => boolean): Promise<Taken | "closed" | undefined> => {
  for (let round = 1; round <= READ_BACK_ROUNDS; round++) {
    await io.sleep(io.recheckMs * round);
    const issue = await issueOf(io, stage, number);
    if (issue === undefined || text(issue.state) !== "open") return "closed";
    const state = await claimState(io, stage, issue);
    // `gone`: a claim this one released, which a list that lags the release still shows.
    if (state.claims.some(ours) && (gone === undefined || !state.claims.some(gone))) return state;
  }
  return undefined;
};

/** How a claim that lost names what it lost to. */
const lostTo = (after: Taken | "closed") =>
  after === "closed" ? "was closed while this claim was posted" : `went to ${after.holder === undefined ? "nobody" : describeClaim(after.holder)} first`;

/** The exit code of a claim posted but never seen listed: it stands, and whether it won is unknown (1 is a refusal or a lost race). */
export const UNKNOWN = 2;

export type ClaimOptions = { readonly issue: number; readonly refs: boolean; readonly noPr: boolean };

/** Refuses a closed issue, a pull request, or a taken issue, naming the holder; the issue otherwise. */
const claimable = async (io: ClaimIo, stage: Stage, number: number): Promise<{ readonly issue: Record<string, unknown> } | { readonly code: number }> => {
  const issue = await issueOf(io, stage, number);
  if (issue === undefined) throw new Failure(stage, `${slug(io.repo)} has no issue #${number}`);
  if (issue.pull_request !== undefined) throw new Failure(stage, `#${number} is a pull request, not an issue`);
  if (text(issue.state) !== "open") {
    io.print(`agent-gh: #${number} is closed; pick another issue`);
    return { code: 1 };
  }
  const state = await claimState(io, stage, issue);
  if (state.holder !== undefined) {
    if (mine(state.holder, io.family, io.session)) {
      io.print(`agent-gh: this session already holds #${number}: ${describeClaim(state.holder)}`);
      return { code: 0 };
    }
    io.print(`agent-gh: #${number} is taken by ${describeClaim(state.holder)}; pick another issue`);
    return { code: 1 };
  }
  return { issue };
};

/**
 * `agent-gh claim <N>`: refuses a closed or taken issue, else opens a draft
 * pull request (or, with `noPr`, posts a claim comment), waits, reads the
 * claims back, and keeps the issue only if this claim holds it; a claim that
 * lost the race undoes itself and names the winner. Returns the exit code:
 * 0 held, 1 refused or lost (nothing left behind), UNKNOWN when it stands
 * unconfirmed.
 */
export const claim = async (io: ClaimIo, options: ClaimOptions): Promise<number> => {
  const stage: Stage = "claiming";
  const found = await claimable(io, stage, options.issue);
  if ("code" in found) return found.code;
  const { issue } = found;
  const number = options.issue;
  const title = text(issue.title);
  const { base } = await repository(io, stage);
  const label = await claimLabel(io, stage, base);
  const marker: ClaimMarker = { v: 1, issue: number, family: io.family, session: io.session, id: crypto.randomUUID().replaceAll("-", "") };
  if (options.noPr) return claimByComment(io, marker, label);

  await cleanCloneOfRepo(io, stage, "claim with a draft pull request", "the claim switches to a new branch");
  const previous = { branch: (await io.git(["symbolic-ref", "-q", "--short", "HEAD"])).stdout || undefined, sha: await git(io, stage, ["rev-parse", "HEAD"]) };
  const branch = claimBranch(io.family, number, title);
  if ((await io.git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`])).code === 0) {
    throw new Failure(stage, `a local branch ${branch} already exists; delete it, or work on it without a new claim`);
  }
  await git(io, stage, ["fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  await git(io, stage, ["switch", "-q", "--no-track", "-c", branch, `refs/remotes/origin/${base}`]);
  let pushed = false;
  let pr = 0;
  let url = "";
  try {
    // The commit-msg hook adds the session's Agent-* trailers and co-author.
    await git(io, stage, ["commit", "-q", "--allow-empty", "-m", claimCommitMessage(number, title)]);
    // Create-only: a branch of the same name (another session of this family claiming the issue) is never overwritten, nor later deleted by this one.
    // An identical commit (same title, parent, and second) would push as a no-op, so a branch already there is refused first.
    const exists = (await io.git(["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`])).code === 0;
    const push = exists ? { code: 1 } : await io.git(["push", "-q", "-u", `--force-with-lease=refs/heads/${branch}:`, "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    if (push.code !== 0) {
      await dropBranch(io, stage, branch, previous, false);
      await io.sleep(io.recheckMs);
      const now = await claimState(io, stage, issue);
      if (now.holder !== undefined) {
        io.print(`agent-gh: #${number} went to ${describeClaim(now.holder)} first; this claim's branch ${branch} could not be pushed. Pick another issue.`);
        return 1;
      }
      throw new Failure(stage, `\`git push\` of ${branch} exited ${push.code}; if that branch exists on GitHub, another session may be claiming #${number}: run \`agent-gh claims\``);
    }
    pushed = true;
    const opened = record((await call(io, stage, "POST", `${repoPath(io)}/pulls`, { title, head: branch, base, body: claimBody(marker, options.refs), draft: true })).value);
    pr = opened.number as number;
    url = text(opened.html_url);
    if (!Number.isSafeInteger(pr)) throw new Failure(stage, "opening the draft pull request: invalid response");
  } catch (error) {
    // A branch another session's open pull request already uses is its, never this claim's to delete;
    // nor is one whose pull requests cannot be read, since another session's may use it.
    let used = false;
    let unread = false;
    let own: Claim | undefined;
    if (pushed) {
      try {
        const open = await openPulls(io, stage);
        used = open.some((item) => text(record(record(item).head).ref) === branch);
        // One carrying this claim's own marker is this claim's: GitHub opened it, and only its answer was lost.
        own = claimsOn(io.repo, number, open, []).find((item) => item.kind === "pr" && item.id === marker.id && item.branch === branch);
      } catch {
        unread = true;
      }
    }
    if (own === undefined) {
      await dropBranch(io, stage, branch, previous, pushed && !used && !unread);
      if (unread) io.print(`agent-gh: could not read ${slug(io.repo)}'s open pull requests, so ${branch} is left on GitHub in case another session's uses it; delete it if none does`);
      const holder = used ? (await claimState(io, stage, issue)).holder : undefined;
      if (holder === undefined) throw error;
      io.print(`agent-gh: #${number} went to ${describeClaim(holder)} first, on the same branch; this claim opened nothing. Pick another issue.`);
      return 1;
    }
    pr = own.pr as number;
    url = own.url;
    io.print(`agent-gh: GitHub opened this claim's #${pr}, though its answer to the request was lost; reading the claims back`);
  }
  const after = await readBack(io, stage, number, (item) => item.pr === pr);
  if (after === undefined) {
    io.print(`agent-gh: GitHub does not list this claim's #${pr} yet, so whether it won is unknown; it stays open: run \`agent-gh claims\`, then keep it or \`agent-gh release ${number}\``);
    return UNKNOWN;
  }
  if (after === "closed" || after.holder?.pr !== pr) {
    await call(io, stage, "PATCH", `${repoPath(io)}/pulls/${pr}`, { state: "closed" });
    await dropBranch(io, stage, branch, previous, true);
    io.print(`agent-gh: #${number} ${lostTo(after)}; closed this claim's #${pr} and deleted ${branch}. Pick another issue.`);
    return 1;
  }
  await addLabel(io, stage, number, label, io.print);
  io.print(`agent-gh: claimed #${number} with draft #${pr} (${url}) on ${branch}; session ${io.session}`);
  io.out(`${url}\n`);
  return 0;
};

const claimByComment = async (io: ClaimIo, marker: ClaimMarker, label: string): Promise<number> => {
  const stage: Stage = "claiming";
  const posted = record((await call(io, stage, "POST", `${repoPath(io)}/issues/${marker.issue}/comments`, { body: claimCommentBody(marker) })).value);
  const id = posted.id;
  const after = await readBack(io, stage, marker.issue, (item) => item.comment === id);
  if (after === undefined) {
    io.print(`agent-gh: GitHub does not list this claim's comment yet, so whether it won is unknown; it stands: run \`agent-gh claims\`, then keep it or \`agent-gh release ${marker.issue}\``);
    return UNKNOWN;
  }
  if (after === "closed" || after.holder?.comment !== id) {
    await call(io, stage, "POST", `${repoPath(io)}/issues/${marker.issue}/comments`, { body: releaseCommentBody({ v: 1, id: marker.id }) });
    io.print(`agent-gh: #${marker.issue} ${lostTo(after)}; released this claim's comment. Pick another issue.`);
    return 1;
  }
  await addLabel(io, stage, marker.issue, label, io.print);
  io.print(`agent-gh: claimed #${marker.issue} with a comment (${text(posted.html_url)}); session ${io.session}`);
  io.out(`${text(posted.html_url)}\n`);
  return 0;
};

/** A take that another session's rewrite of the marker overtook: `marker` is what the pull request carries now. */
class Lost extends Error {
  constructor(readonly marker: ClaimMarker | undefined, readonly why?: string) {
    super("the claim changed hands");
  }
}

/**
 * `agent-gh claim --take <N>`: hands the claim holding issue N, another
 * session's, to this one, keeping its branch and pull request. For a pull
 * request claim, the claim branch is fetched and checked out, one comment on
 * the pull request names who took it from whom at which head (what `review
 * full` reads to take the earlier holder's commits as this one's), and the
 * marker is rewritten to this session, keeping its `issue` and `id`; a
 * failure partway puts the clone back. A comment claim gets a new claim
 * comment, then its old one's release, and is read back as `claim` reads its
 * own, so of two sessions taking it at once one holds it.
 * Refuses a closed issue, one nothing claims, one held by a pull request
 * without a claim marker (a person's), and one this session holds already.
 * Who may take is who may close the claim's pull request: anyone acting as
 * John. Returns the exit code.
 */
export const take = async (io: ClaimIo, number: number): Promise<number> => {
  const stage: Stage = "claiming";
  const issue = await issueOf(io, stage, number);
  if (issue === undefined) throw new Failure(stage, `${slug(io.repo)} has no issue #${number}`);
  if (issue.pull_request !== undefined) throw new Failure(stage, `#${number} is a pull request, not an issue`);
  if (text(issue.state) !== "open") {
    io.print(`agent-gh: #${number} is closed; there is no claim to take`);
    return 1;
  }
  const state = await claimState(io, stage, issue);
  const holder = state.holder;
  if (holder === undefined) {
    io.print(`agent-gh: nothing claims #${number}, so there is nothing to take; claim it with \`agent-gh claim ${number}\``);
    return 1;
  }
  if (mine(holder, io.family, io.session)) {
    io.print(`agent-gh: this session already holds #${number}: ${describeClaim(holder)}; there is nothing to take`);
    return 1;
  }
  if (holder.family === null || holder.session === null || holder.id === null) {
    io.print(`agent-gh: #${number} is held by ${describeClaim(holder)}, which carries no claim marker, so there is no claim to take`);
    return 1;
  }
  const from = { family: holder.family, session: holder.session };
  const marker: ClaimMarker = { v: 1, issue: number, family: io.family, session: io.session, id: holder.id };
  if (holder.kind === "comment") {
    // The new claim comment is created after any other claim's, so with another claim behind this one it would fall behind it once the old one is released.
    if (state.claims.length > 1) {
      io.print(`agent-gh: #${number} has other claims behind ${describeClaim(holder)} (${state.claims.slice(1).map(describeClaim).join("; ")}); a new claim comment would fall behind them, so take nothing until they are closed or released`);
      return 1;
    }
    const fresh: ClaimMarker = { ...marker, id: crypto.randomUUID().replaceAll("-", "") };
    // The new claim first, then the old one's release, so the issue is never free between them.
    const release = (id: string) => call(io, stage, "POST", `${repoPath(io)}/issues/${number}/comments`, { body: releaseCommentBody({ v: 1, id }) });
    let posted: Record<string, unknown>;
    try {
      posted = record((await call(io, stage, "POST", `${repoPath(io)}/issues/${number}/comments`, { body: claimCommentBody(fresh, from) })).value);
    } catch (error) {
      // GitHub may have stored it without answering: released, it cannot sit behind the old claim and refuse the next take.
      await release(fresh.id).catch(() => undefined);
      throw error;
    }
    // Unanswered, or failed on GitHub's side (5xx), the release may have landed, so the new claim stays and the read-back below settles it;
    // refused (4xx), it did not, and the new claim, left live behind the old one, would refuse the next take.
    let status: number | undefined;
    try {
      ({ status } = await request(io.api, stage, "POST", `${repoPath(io)}/issues/${number}/comments`, io.token, { body: releaseCommentBody({ v: 1, id: holder.id }) }));
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
    }
    if (status !== undefined && status >= 400 && status < 500) {
      await release(fresh.id).catch(() => undefined);
      throw new Failure(stage, `HTTP ${status} from POST ${repoPath(io)}/issues/${number}/comments`);
    }
    // Another session taking it at the same time posts its own claim: the earlier one holds, and the later releases itself.
    const after = await readBack(io, stage, number, (item) => item.comment === posted.id, (item) => item.id === holder.id);
    if (after === undefined) {
      io.print(`agent-gh: GitHub does not list this take's claim comment yet, so whether it holds #${number} is unknown; it stands: run \`agent-gh claims\`, then keep it or \`agent-gh release ${number}\``);
      return UNKNOWN;
    }
    if (after === "closed" || after.holder?.comment !== posted.id) {
      await release(fresh.id);
      io.print(`agent-gh: #${number} ${lostTo(after)}; released this take's claim comment`);
      return 1;
    }
    io.print(`agent-gh: took #${number}'s claim from a ${from.family} session (${from.session}) with a comment (${text(posted.html_url)}); session ${io.session}`);
    io.out(`${text(posted.html_url)}\n`);
    return 0;
  }
  const pr = holder.pr as number;
  const pull = record((await call(io, stage, "GET", `${repoPath(io)}/pulls/${pr}`)).value);
  const sameClaim = (found: ClaimMarker | undefined, who: { readonly family: string; readonly session: string }) =>
    found?.id === holder.id && found.family === who.family && found.session === who.session;
  if (!sameClaim(parseClaim(text(pull.body)), from)) {
    io.print(`agent-gh: #${pr}'s claim changed while this take read it; run \`agent-gh claims\` and take again if it is still another session's`);
    return 1;
  }
  const branch = text(record(pull.head).ref);
  if (text(record(record(pull.head).repo).full_name).toLowerCase() !== slug(io.repo).toLowerCase() || branch === "") {
    throw new Failure(stage, `#${pr}'s branch is not in ${slug(io.repo)}, so this session could not push to it`);
  }
  await cleanCloneOfRepo(io, stage, "take a claim", "the take checks out the claim's branch");
  await git(io, stage, ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const head = await git(io, stage, ["rev-parse", `refs/remotes/origin/${branch}^{commit}`]);
  const local = await io.git(["rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`]);
  if (local.code === 0 && local.stdout !== head) {
    throw new Failure(stage, `a local branch ${branch} already exists at ${local.stdout.slice(0, 8)}, not at #${pr}'s head ${head.slice(0, 8)}; delete it or bring it to origin's, then take again`);
  }
  // The branch first, then the comment, then the marker: a take that fails before the rewrite leaves the claim with its holder and this clone where it was.
  const previous = { branch: (await io.git(["symbolic-ref", "-q", "--short", "HEAD"])).stdout || undefined, sha: await git(io, stage, ["rev-parse", "HEAD"]) };
  await git(io, stage, local.code === 0 ? ["switch", "-q", branch] : ["switch", "-q", "--no-track", "-c", branch, `refs/remotes/origin/${branch}`]);
  const back = async () => {
    if (local.code === 0) await io.git(previous.branch === undefined ? ["switch", "-q", "--detach", previous.sha] : ["switch", "-q", previous.branch]);
    else await dropBranch(io, stage, branch, previous, false);
  };
  const lost = (found: ClaimMarker | undefined) => {
    const who = found === undefined ? "nobody's claim" : `a ${found.family} session (${found.session})`;
    io.print(`agent-gh: #${pr}'s claim went to ${who} while this take ran, so this session did not take it; run \`agent-gh claims\``);
    return 1;
  };
  const takeBody = takeCommentBody({ v: 1, id: holder.id, from, to: { family: io.family, session: io.session }, head });
  let posted: unknown;
  let rewritten: boolean | undefined = false;
  try {
    await git(io, stage, ["config", `branch.${branch}.remote`, "origin"]);
    await git(io, stage, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
    posted = record((await call(io, stage, "POST", `${repoPath(io)}/issues/${pr}/comments`, { body: takeBody })).value).id;
    // GitHub has no compare-and-swap, so of several sessions taking this claim at once, the one whose take comment is listed first goes ahead.
    const holding: ClaimMarker = { ...marker, family: from.family, session: from.session };
    let first: ReturnType<typeof firstTake>;
    for (let round = 1; round <= READ_BACK_ROUNDS && first === undefined; round++) {
      await io.sleep(io.recheckMs * round);
      first = firstTake(await comments(io, stage, pr), holding);
    }
    // This session's own earlier take, one whose rewrite went unanswered, goes ahead as this one.
    if (first?.id !== posted && !(first !== undefined && first.marker.to.family === io.family && first.marker.to.session === io.session)) {
      throw new Lost(
        undefined,
        first === undefined
          ? "GitHub does not list this take's comment yet"
          : `a ${first.marker.to.family} session's (${first.marker.to.session}) take of it was posted first (${first.url}; if that take was abandoned before it rewrote the marker, delete that comment)`,
      );
    }
    // Read again just before the rewrite, and after it: of two sessions taking at once, the one whose rewrite stands holds the claim.
    const now = record((await call(io, stage, "GET", `${repoPath(io)}/pulls/${pr}`)).value);
    if (text(now.state) !== "open") throw new Lost(undefined, `#${pr} was closed while this take ran`);
    if (text((await issueOf(io, stage, number))?.state) !== "open") throw new Lost(undefined, `#${number} was closed while this take ran`);
    if (!sameClaim(parseClaim(text(now.body)), from)) throw new Lost(parseClaim(text(now.body)));
    // Unanswered, or failed on GitHub's side (5xx), the rewrite may have landed; refused (4xx), it did not.
    rewritten = undefined;
    const { status } = await request(io.api, stage, "PATCH", `${repoPath(io)}/pulls/${pr}`, io.token, { body: retakeBody(text(now.body), marker) });
    rewritten = status >= 200 && status < 300 ? true : status >= 500 ? undefined : false;
    if (!rewritten) throw new Failure(stage, `HTTP ${status} from PATCH ${repoPath(io)}/pulls/${pr}`);
  } catch (error) {
    if (rewritten === undefined) {
      io.print(`agent-gh: rewriting #${pr}'s claim marker went unanswered or failed on GitHub's side, so whether this session took #${number} is unknown; this clone stays on ${branch}: run \`agent-gh claims\`, and switch back if it is still another session's`);
      return UNKNOWN;
    }
    // A take comment whose marker was never rewritten hands nothing on (`takesOf`), but would go ahead of the next session's take (`firstTake`), so it is deleted;
    // one whose posting went unanswered is found by its marker.
    const mineNow = Number.isSafeInteger(posted)
      ? [posted as number]
      : await comments(io, stage, pr).then(
          (items) => items.map(record).filter((item) => text(item.body) === takeBody).map((item) => item.id as number),
          () => [],
        );
    for (const id of mineNow) await call(io, stage, "DELETE", `${repoPath(io)}/issues/comments/${id}`, undefined, [403, 404]).catch(() => undefined);
    await back();
    if (!(error instanceof Lost)) throw error;
    if (error.why !== undefined) {
      io.print(`agent-gh: this session took nothing from #${pr}: ${error.why}; run \`agent-gh claims\`, and take again if it is still another session's`);
      return 1;
    }
    return lost(error.marker);
  }
  // Rewritten: the comment stays whatever follows, since a take from this session builds its chain on it.
  // A read that still shows the previous holder's marker may lag the rewrite, so it is read again.
  let written: ClaimMarker | undefined;
  for (let round = 1; round <= READ_BACK_ROUNDS; round++) {
    await io.sleep(io.recheckMs * round);
    try {
      const after = record((await call(io, stage, "GET", `${repoPath(io)}/pulls/${pr}`)).value);
      // A pull request closed meanwhile holds nothing, whatever its marker says.
      written = text(after.state) === "open" ? parseClaim(text(after.body)) : undefined;
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      io.print(`agent-gh: rewrote #${pr}'s claim marker to this session, but could not read it back (${error.detail}); this clone is on ${branch}: run \`agent-gh claims\` to confirm`);
      return UNKNOWN;
    }
    if (!sameClaim(written, from)) break;
  }
  if (sameClaim(written, from)) {
    io.print(`agent-gh: rewrote #${pr}'s claim marker to this session, but GitHub still shows the previous holder's; this clone is on ${branch}: run \`agent-gh claims\` to confirm`);
    return UNKNOWN;
  }
  if (!sameClaim(written, { family: io.family, session: io.session })) {
    await back();
    return lost(written);
  }
  io.print(`agent-gh: took #${number}'s claim from a ${from.family} session (${from.session}): draft #${pr} (${holder.url}) on ${branch}, at ${head.slice(0, 8)}; session ${io.session}`);
  io.out(`${holder.url}\n`);
  return 0;
};

/**
 * `agent-gh claim --restore <N>`: puts the claim marker back on the pull
 * request that holds issue N without one. The gh shim keeps the marker
 * through `gh pr edit --body`, but an edit it does not see (GitHub's web
 * editor, `gh api`) replaces the whole description, marker included; the
 * pull request then reads as a person's and the commit hook refuses the
 * holder's own commits. The marker comes from the description's edit
 * history (GraphQL `userContentEdits`, each a full version): the latest
 * version that carried one for N, appended to the description as it is now,
 * whichever session it names. Returns the exit code.
 */
export const restore = async (io: ClaimIo, number: number): Promise<number> => {
  const stage: Stage = "restoring a claim";
  const issue = await issueOf(io, stage, number);
  if (issue === undefined) throw new Failure(stage, `${slug(io.repo)} has no issue #${number}`);
  if (issue.pull_request !== undefined) throw new Failure(stage, `#${number} is a pull request, not an issue`);
  if (text(issue.state) !== "open") {
    io.print(`agent-gh: #${number} is closed; there is no claim to restore`);
    return 1;
  }
  const holder = (await claimState(io, stage, issue)).holder;
  if (holder === undefined) {
    io.print(`agent-gh: nothing claims #${number}, so there is no marker to restore; claim it with \`agent-gh claim ${number}\``);
    return 1;
  }
  if (holder.family !== null) {
    io.print(`agent-gh: #${number} is held by ${describeClaim(holder)}, whose marker is in place; there is nothing to restore`);
    return mine(holder, io.family, io.session) ? 0 : 1;
  }
  // A comment without a marker is no claim, so a holder without one is a pull request.
  const pr = holder.pr as number;
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){userContentEdits(last:100){nodes{editedAt diff}}}}}`;
  const { value } = await call(io, stage, "POST", "/graphql", { query, variables: { owner: io.repo.owner, name: io.repo.name, number: pr } });
  const errors = record(value).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const types = [...new Set(errors.map((error) => text(record(error).type)).filter((type) => /^[A-Z_]{1,40}$/.test(type)))];
    throw new Failure(stage, `GitHub's GraphQL API refused the read of #${pr}'s edit history${types.length === 0 ? "" : ` (${types.join(", ")})`}`);
  }
  const nodes = record(record(record(record(record(value).data).repository).pullRequest).userContentEdits).nodes;
  const versions = (Array.isArray(nodes) ? nodes.map(record) : [])
    .map((node) => ({ at: text(node.editedAt), marker: claimMarkerText(text(node.diff)) }))
    .filter((version): version is { at: string; marker: string } => version.marker !== undefined && parseClaim(version.marker)?.issue === number)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const found = versions[0];
  if (found === undefined) {
    io.print(`agent-gh: #${number} is held by ${describeClaim(holder)}, and no version of its description carried a claim marker for #${number} (a person's pull request, not a claim an edit broke); there is nothing to restore`);
    return 1;
  }
  const now = record((await call(io, stage, "GET", `${repoPath(io)}/pulls/${pr}`)).value);
  if (text(now.state) !== "open") {
    io.print(`agent-gh: #${pr} was closed while this ran, so it holds #${number} no longer; there is nothing to restore`);
    return 1;
  }
  const marker = parseClaim(found.marker) as ClaimMarker;
  const ours = marker.family === io.family && marker.session === io.session;
  const names = ours ? "this session" : `a ${marker.family} session (${marker.session})`;
  if (claimMarkerText(text(now.body)) === undefined) {
    await call(io, stage, "PATCH", `${repoPath(io)}/pulls/${pr}`, { body: withClaimMarker(text(now.body), found.marker) });
    io.print(`agent-gh: restored #${pr}'s claim marker on #${number} from its description's version of ${found.at}; it names ${names}${ours ? "" : `, and \`agent-gh claim --take ${number}\` hands the claim to this one`}`);
  } else {
    io.print(`agent-gh: #${pr}'s claim marker was put back while this ran; it names ${names}`);
  }
  io.out(`${holder.url}\n`);
  return 0;
};

/**
 * `agent-gh release <N>`: this session's claims on the issue only. A claim
 * pull request closes (and its branch goes) while it holds nothing but the
 * claim's empty commit; one with work on it is closed deliberately, by hand.
 * A comment claim gets a release comment. Another session's claim is John's
 * to release, by closing its pull request.
 */
export const release = async (io: ClaimIo, number: number): Promise<number> => {
  const stage: Stage = "releasing";
  const issue = await issueOf(io, stage, number);
  if (issue === undefined) throw new Failure(stage, `${slug(io.repo)} has no issue #${number}`);
  const state = taken(io.repo, { ...issue, state: "open", pull_request: undefined }, await openPulls(io, stage), await comments(io, stage, number));
  const ours = state.claims.filter((item) => mine(item, io.family, io.session));
  if (ours.length === 0) {
    const others = state.claims.map(describeClaim).join("; ");
    io.print(
      others === ""
        ? `agent-gh: nothing claims #${number}`
        : `agent-gh: this ${io.family} session (${io.session}) holds no claim on #${number}, which ${others} holds; an agent releases only its own claim, and John releases another by closing its pull request`,
    );
    return 1;
  }
  for (const item of ours) {
    if (item.kind === "comment") {
      await call(io, stage, "POST", `${repoPath(io)}/issues/${number}/comments`, { body: releaseCommentBody({ v: 1, id: item.id as string }) });
      io.print(`agent-gh: released the claim comment on #${number}`);
      continue;
    }
    const pull = record((await call(io, stage, "GET", `${repoPath(io)}/pulls/${item.pr}`)).value);
    if (!emptyClaim(pull)) {
      io.print(`agent-gh: #${item.pr} has work beyond the claim's empty commit, so release does not close it; close it deliberately (\`gh pr close ${item.pr}\`) if the work is abandoned`);
      return 1;
    }
    await call(io, stage, "PATCH", `${repoPath(io)}/pulls/${item.pr}`, { state: "closed" });
    const head = record(pull.head);
    if (text(record(head.repo).full_name).toLowerCase() === slug(io.repo).toLowerCase() && item.branch !== null) {
      await call(io, stage, "DELETE", `${repoPath(io)}/git/refs/heads/${item.branch}`, undefined, [404, 422]);
    }
    io.print(`agent-gh: released #${number}: closed draft #${item.pr}${item.branch === null ? "" : ` and deleted ${item.branch} on GitHub`}`);
  }
  const { base } = await repository(io, stage);
  await settleLabel(io, stage, number, await claimLabel(io, stage, base), io.print);
  return 0;
};

/** One live claim as `claims --json` lists it: the stable interface for repository scripts. */
export type ListedClaim = {
  readonly issue: number;
  readonly title: string;
  readonly kind: "pr" | "comment";
  readonly pr: number | null;
  readonly url: string;
  readonly author: string;
  readonly family: string | null;
  readonly session: string | null;
  readonly branch: string | null;
  /** Whether this claim holds the issue (the first of its claims). */
  readonly holds: boolean;
  readonly created_at: string;
  readonly last_push_at: string | null;
  readonly last_comment_at: string | null;
  readonly labeled: boolean;
};

export type ClaimsList = { readonly v: 1; readonly repo: string; readonly label: string; readonly claims: readonly ListedClaim[]; readonly mismatches: readonly Mismatch[] };

const latest = (items: readonly unknown[]): string | null =>
  items.map((item) => text(record(item).created_at)).filter((at) => at !== "").sort().at(-1) ?? null;

/**
 * Every live claim in the repository: the issues open pull requests link,
 * and the open issues carrying the label (where comment claims are found),
 * each judged by the rule, with when it last saw a push or a comment.
 */
export const listClaims = async (io: ApiIo, stage: Stage = "listing claims"): Promise<ClaimsList> => {
  const { base } = await repository(io, stage);
  const label = await claimLabel(io, stage, base);
  const pulls = await openPulls(io, stage);
  const withLabel = (await everyPage(io, stage, `${repoPath(io)}/issues?state=open&labels=${encodeURIComponent(label)}`)).map(record).filter((item) => item.pull_request === undefined);
  const numbers = new Set<number>(withLabel.map((item) => item.number as number));
  for (const pull of pulls.map(record)) {
    const body = text(pull.body);
    for (const number of linkedIssues(body, io.repo)) numbers.add(number);
    const marker = parseClaim(body);
    if (marker !== undefined) numbers.add(marker.issue);
  }
  const claims: ListedClaim[] = [];
  const mismatches: Mismatch[] = [];
  const pullComments = new Map<number, unknown[]>();
  for (const number of [...numbers].sort((a, b) => a - b)) {
    const issue = withLabel.find((item) => item.number === number) ?? (await issueOf(io, stage, number));
    if (issue === undefined) continue;
    const thread = await comments(io, stage, number);
    const state = taken(io.repo, issue, pulls, thread);
    const isLabeled = labeled(issue, label);
    const off = text(issue.state) === "open" && issue.pull_request === undefined ? mismatch(number, isLabeled, state.claims) : undefined;
    if (off !== undefined) mismatches.push(off);
    for (const [index, item] of state.claims.entries()) {
      let lastPush: string | null = null;
      let others: unknown[] = [];
      if (item.pr !== null) {
        const pull = record(pulls.map(record).find((candidate) => candidate.number === item.pr));
        const sha = text(record(pull.head).sha);
        if (/^[0-9a-f]{40}$/.test(sha)) {
          const commit = record((await call(io, stage, "GET", `${repoPath(io)}/commits/${sha}`, undefined, [404, 422])).value);
          lastPush = text(record(record(commit.commit).committer).date) || null;
        }
        others = pullComments.get(item.pr) ?? (await comments(io, stage, item.pr));
        pullComments.set(item.pr, others);
      }
      claims.push({
        issue: number, title: text(issue.title), kind: item.kind, pr: item.pr, url: item.url, author: item.author, family: item.family, session: item.session,
        branch: item.branch, holds: index === 0, created_at: item.createdAt, last_push_at: lastPush, last_comment_at: latest([...thread, ...others]), labeled: isLabeled,
      });
    }
  }
  return { v: 1, repo: slug(io.repo), label, claims, mismatches };
};

/** `claims` for a person: one line per claim, then the label's mismatches. */
export const claimsLines = (list: ClaimsList, nowMs: number): string[] => {
  if (list.claims.length === 0 && list.mismatches.length === 0) return [`No live claims in ${list.repo}.`];
  const lines = list.claims.map((item) => {
    const where = item.kind === "pr" ? `${item.pr === null ? "" : `#${item.pr}`}` : "comment";
    const who = item.family === null ? item.author : `${item.family} ${item.session}`;
    const quiet = [item.created_at, item.last_push_at, item.last_comment_at].filter((at): at is string => at !== null && at !== "").sort().at(-1) ?? null;
    return `#${item.issue} ${item.title}: ${where} by ${who}${item.holds ? "" : " (behind an earlier claim)"}; claimed ${ago(item.created_at, nowMs)}, last push ${ago(item.last_push_at, nowMs)}, last comment ${ago(item.last_comment_at, nowMs)}; quiet since ${ago(quiet, nowMs)}`;
  });
  for (const item of list.mismatches) {
    lines.push(
      item.claimed
        ? `#${item.issue}: claimed but missing \`${list.label}\`; the claim holds it regardless`
        : `#${item.issue}: carries \`${list.label}\` but nothing claims it; \`agent-gh claims sync\` removes the label`,
    );
  }
  return lines;
};

/**
 * `agent-gh claims sync`: removes the label from each of `issues` (default:
 * every open issue carrying it) that nothing claims, as after a claim pull
 * request closes or merges. It never adds the label: only a claim does.
 */
export const syncLabels = async (io: ApiIo, print: (line: string) => void, issues?: readonly number[]): Promise<void> => {
  const stage: Stage = "listing claims";
  const { base } = await repository(io, stage);
  const label = await claimLabel(io, stage, base);
  const numbers =
    issues ??
    (await everyPage(io, stage, `${repoPath(io)}/issues?state=open&labels=${encodeURIComponent(label)}`))
      .map(record)
      .filter((item) => item.pull_request === undefined)
      .map((item) => item.number as number);
  for (const number of numbers) await settleLabel(io, stage, number, label, print);
};

/** The issues a closed pull request's event concerns: those its description links or claims. */
export const eventIssues = (io: ApiIo, payload: unknown): number[] | undefined => {
  const pull = record(record(payload).pull_request);
  if (pull.number === undefined) return undefined;
  const body = text(pull.body);
  const marker = parseClaim(body);
  return [...new Set([...linkedIssues(body, io.repo), ...(marker === undefined ? [] : [marker.issue])])];
};
