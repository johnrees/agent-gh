/**
 * Claims: which issues an agent has taken, so parallel sessions never start
 * the same one. Pure: claim-run.ts reads GitHub, and `claim`, `release`,
 * `claims`, and a script with nothing but REST all decide with `taken`.
 *
 * The rule (README, "Claims"): an open issue is taken when an open pull
 * request in its repository references it (a closing keyword or `Refs`, or a
 * claim marker in its description), or when a claim comment on it by someone
 * with write access has no release comment. Of several claims, the earliest
 * created holds the issue; within one second, pull requests before comments,
 * then the lowest number or id. GitHub has no compare-and-swap, so two
 * sessions that both found the issue free settle it this way after posting.
 * The claim label only mirrors this: anyone can add or remove a label.
 */
import { randomBytes } from "node:crypto";
import { familyNames } from "./family.ts";
import { fitGroup, type LabelRules } from "./next.ts";
import type { Env } from "./harness.ts";
import { type Repo, slug } from "./repo.ts";

export const DEFAULT_CLAIM_LABEL = "claimed";

/** In a claim pull request's description or a claim comment. `id` names a comment claim for its release. */
export type ClaimMarker = { readonly v: 1; readonly issue: number; readonly family: string; readonly session: string; readonly id: string };
/** Releases the comment claim `id`. */
export type ReleaseMarker = { readonly v: 1; readonly id: string };
/** A session and its family, as a claim marker names them. */
export type Holder = { readonly family: string; readonly session: string };
/** On a claim pull request: `to` took the claim `id` from `from` (`claim --take`) when the branch's head was `head`. */
export type TakeMarker = { readonly v: 1; readonly id: string; readonly from: Holder; readonly to: Holder; readonly head: string };

const CLAIM = /<!-- agent-claim (\{[^\n]*?\}) -->/;
const RELEASE = /<!-- agent-release (\{[^\n]*?\}) -->/;
const TAKE = /<!-- agent-take (\{[^\n]*?\}) -->/;
const ID = /^[0-9a-f]{8,64}$/;
const WORD = /^[A-Za-z0-9_.:-]{1,100}$/;

export const claimMarker = (marker: ClaimMarker): string => `<!-- agent-claim ${JSON.stringify(marker)} -->`;
export const releaseMarker = (marker: ReleaseMarker): string => `<!-- agent-release ${JSON.stringify(marker)} -->`;
export const takeMarker = (marker: TakeMarker): string => `<!-- agent-take ${JSON.stringify(marker)} -->`;

const markerObject = (pattern: RegExp, body: string): Record<string, unknown> | undefined => {
  const match = pattern.exec(body);
  if (match === null) return undefined;
  try {
    const value: unknown = JSON.parse(match[1] as string);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** A body's claim marker; undefined when it has none or it is malformed. */
export const parseClaim = (body: string): ClaimMarker | undefined => {
  const value = markerObject(CLAIM, body);
  if (value?.v !== 1 || !Number.isSafeInteger(value.issue) || (value.issue as number) <= 0) return undefined;
  if (typeof value.family !== "string" || !WORD.test(value.family) || typeof value.session !== "string" || !WORD.test(value.session)) return undefined;
  if (typeof value.id !== "string" || !ID.test(value.id)) return undefined;
  return { v: 1, issue: value.issue as number, family: value.family, session: value.session, id: value.id };
};

/** A body's claim marker as written, to carry through a rewrite; undefined when it has none that reads. */
export const claimMarkerText = (body: string): string | undefined => (parseClaim(body) === undefined ? undefined : CLAIM.exec(body)?.[0]);

/** `body` with `marker` appended on its own line: how a description that lost its marker gets it back. */
export const withClaimMarker = (body: string, marker: string): string => `${body.replace(/\s+$/, "")}\n\n${marker}`;

export const parseRelease = (body: string): ReleaseMarker | undefined => {
  const value = markerObject(RELEASE, body);
  return value?.v === 1 && typeof value.id === "string" && ID.test(value.id) ? { v: 1, id: value.id } : undefined;
};

const holderIn = (value: unknown): Holder | undefined => {
  const item = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return typeof item.family === "string" && WORD.test(item.family) && typeof item.session === "string" && WORD.test(item.session) ? { family: item.family, session: item.session } : undefined;
};

export const parseTake = (body: string): TakeMarker | undefined => {
  const value = markerObject(TAKE, body);
  const [from, to] = [holderIn(value?.from), holderIn(value?.to)];
  if (value?.v !== 1 || typeof value.id !== "string" || !ID.test(value.id) || from === undefined || to === undefined) return undefined;
  return typeof value.head === "string" && /^[0-9a-f]{40}$/.test(value.head) ? { v: 1, id: value.id, from, to, head: value.head } : undefined;
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The issues in `repo` a pull request's description links with a closing
 * keyword (close, fix, resolve in any tense) or `Ref`/`Refs`, as `#N`,
 * `owner/repo#N`, or the issue's URL. A bare mention ("unlike #12") links
 * nothing, so a description may cite related issues freely.
 */
export const linkedIssues = (body: string, repo: Repo): number[] => {
  const name = escape(slug(repo));
  const pattern = new RegExp(
    `(?<![\\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\\b:?[ \\t]+(?:(${name})#|https://github\\.com/(${name})/issues/|#)(\\d+)(?![\\w/])`,
    "gi",
  );
  return [...new Set([...body.matchAll(pattern)].map((match) => Number(match[3])))];
};

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const integer = (value: unknown): number => (Number.isSafeInteger(value) ? (value as number) : 0);

/** One claim on an issue: an open pull request that references it, or a live claim comment. */
export type Claim = {
  readonly issue: number;
  readonly kind: "pr" | "comment";
  /** The pull request's number, for a pull request claim. */
  readonly pr: number | null;
  /** The comment's id, for a comment claim. */
  readonly comment: number | null;
  readonly url: string;
  readonly author: string;
  /** From the claim marker; null for a pull request that references the issue without one (a person's). */
  readonly family: string | null;
  readonly session: string | null;
  readonly id: string | null;
  /** The pull request's head branch. */
  readonly branch: string | null;
  readonly draft: boolean;
  readonly createdAt: string;
};

/** Comment authors whose markers count: people with write access, as GitHub reports it on the comment. */
const TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"];

/** When a claim was created, in ms; one without a readable time comes last. */
const createdMs = (claim: Claim): number => {
  const ms = Date.parse(claim.createdAt);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
};

/**
 * The claims on `issue`, the holder first: open pull requests (REST
 * `GET /repos/{repo}/pulls?state=open`, every page) and live claim comments
 * (`GET /repos/{repo}/issues/{issue}/comments`), earliest created first.
 * Within one second (GitHub's times have no finer grain) pull requests come
 * before comments, then the lower number or id. So a comment claim that won
 * is never displaced by a pull request opened after it, and a pull request
 * claim never by a later comment.
 */
export const claimsOn = (repo: Repo, issue: number, pulls: readonly unknown[], comments: readonly unknown[]): Claim[] => {
  const fromPulls = pulls
    .map(record)
    .filter((pull) => text(pull.state) === "open" || pull.state === undefined)
    .flatMap((pull): Claim[] => {
      const body = text(pull.body);
      const marker = parseClaim(body);
      const ours = marker?.issue === issue ? marker : undefined;
      if (ours === undefined && !linkedIssues(body, repo).includes(issue)) return [];
      return [{
        issue, kind: "pr", pr: integer(pull.number), comment: null, url: text(pull.html_url), author: text(record(pull.user).login),
        family: ours?.family ?? null, session: ours?.session ?? null, id: ours?.id ?? null, branch: text(record(pull.head).ref) || null,
        draft: pull.draft === true, createdAt: text(pull.created_at),
      }];
    });
  const trusted = comments.map(record).filter((comment) => TRUSTED.includes(text(comment.author_association)));
  const released = new Set(trusted.flatMap((comment) => parseRelease(text(comment.body))?.id ?? []));
  const fromComments = trusted
    .flatMap((comment): Claim[] => {
      const marker = parseClaim(text(comment.body));
      if (marker === undefined || marker.issue !== issue || released.has(marker.id)) return [];
      return [{
        issue, kind: "comment", pr: null, comment: integer(comment.id), url: text(comment.html_url), author: text(record(comment.user).login),
        family: marker.family, session: marker.session, id: marker.id, branch: null, draft: false, createdAt: text(comment.created_at),
      }];
    });
  const rank = (claim: Claim): [number, number, number] => [createdMs(claim), claim.kind === "pr" ? 0 : 1, (claim.pr ?? claim.comment) as number];
  return [...fromPulls, ...fromComments].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
};

export type Taken = { readonly taken: boolean; readonly holder: Claim | undefined; readonly claims: readonly Claim[] };

/**
 * Whether issue `issue` (REST `GET /repos/{repo}/issues/{n}`) is taken: it is
 * an open issue, not a pull request, and something claims it. `holder` is the
 * claim that holds it. A closed issue is never taken, whatever references it.
 */
export const taken = (repo: Repo, issue: unknown, pulls: readonly unknown[], comments: readonly unknown[]): Taken => {
  const value = record(issue);
  const claims = claimsOn(repo, integer(value.number), pulls, comments);
  if (text(value.state) !== "open" || value.pull_request !== undefined) return { taken: false, holder: undefined, claims: [] };
  return { taken: claims.length > 0, holder: claims[0], claims };
};

/** Whether a claim is this session's. */
export const mine = (claim: Claim, family: string, session: string): boolean => claim.family === family && claim.session === session;

/** How a refusal names a claim: its pull request or comment, and who holds it. */
export const describeClaim = (claim: Claim): string => {
  const who = claim.family === null ? `by ${claim.author}` : `by a ${claim.family} session (${claim.session})`;
  return claim.kind === "pr" ? `${claim.draft ? "draft " : ""}#${claim.pr} ${who} (${claim.url})` : `a claim comment ${who} (${claim.url})`;
};

/**
 * The session a claim names: `AGENT_GH_SESSION` when set, else the harness's
 * own (Claude Code's `CLAUDE_CODE_SESSION_ID`, Codex's thread, pi's), else a
 * new random id, which `claim` prints so `release` can be given it.
 */
export const sessionId = (env: Env, random: () => string = () => randomBytes(8).toString("hex")): { readonly id: string; readonly generated: boolean } => {
  for (const name of ["AGENT_GH_SESSION", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "PI_SESSION_ID"]) {
    const value = env[name]?.trim();
    if (value !== undefined && WORD.test(value)) return { id: value, generated: false };
  }
  return { id: random(), generated: true };
};

/** A branch-name slug from an issue's title: lowercase words joined by `-`, at most 40 characters, cut at a word. */
export const titleSlug = (title: string): string => {
  const words = title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (words.length <= 40) return words || "issue";
  const cut = words.slice(0, 41);
  const end = cut.lastIndexOf("-");
  return (end > 0 ? cut.slice(0, end) : words.slice(0, 40)).replace(/-+$/, "");
};

/**
 * The issue a claim branch names: `<family>/<N>-<slug>` as `claimBranch`
 * makes it, for a family in agent-gh's table. Undefined for any other branch
 * (`feature/12-x`, `main`), and when there is none (a detached HEAD).
 */
export const claimBranchIssue = (branch: string | undefined): number | undefined => {
  const match = /^([^/]+)\/([1-9]\d{0,9})-/.exec(branch ?? "");
  return match !== null && familyNames().includes(match[1] as string) ? Number(match[2]) : undefined;
};

/** `<family>/<N>-<slug>`, the branch a claim opens. */
export const claimBranch = (family: string, issue: number, title: string): string => `${family}/${issue}-${titleSlug(title)}`;

/**
 * The claim's empty commit message. It survives into a squash merge's
 * message (GitHub lists each commit there), so it says what the work is, the
 * issue's title, and links the issue; it never says "Claim".
 */
export const claimCommitMessage = (issue: number, title: string): string => `${title.trim() || `Issue #${issue}`}\n\nRefs #${issue}`;

/** The claim pull request's description: the link, a line for people, and the marker. */
export const claimBody = (marker: ClaimMarker, refs: boolean): string =>
  [
    `${refs ? "Refs" : "Closes"} #${marker.issue}.`,
    "",
    `A ${marker.family} session claimed #${marker.issue} with \`agent-gh claim\`; this draft holds it until the work lands here or \`agent-gh release ${marker.issue}\` closes it. The gh shim keeps the marker below through \`gh pr edit\`; \`agent-gh claim --restore ${marker.issue}\` puts it back if another edit drops it.`,
    "",
    claimMarker(marker),
  ].join("\n");

/** A claim comment's body, for an issue with no code; `from`, the session it took the claim from with `claim --take`. */
export const claimCommentBody = (marker: ClaimMarker, from?: Holder): string =>
  from === undefined
    ? `${claimMarker(marker)}\nA ${marker.family} session (${marker.session}) claimed this issue with \`agent-gh claim --no-pr\`; \`agent-gh release ${marker.issue}\` releases it.`
    : `${claimMarker(marker)}\nA ${marker.family} session (${marker.session}) took this issue's claim from a ${from.family} session (${from.session}) with \`agent-gh claim --take\`; \`agent-gh release ${marker.issue}\` releases it.`;

/** A claim pull request's description with its marker rewritten to `marker`, as `claim --take` hands it on. */
export const retakeBody = (body: string, marker: ClaimMarker): string => body.replace(CLAIM, () => claimMarker(marker));

/** The comment `claim --take` posts on the claim pull request: who took it from whom, and the head the taker continues from. */
export const takeCommentBody = (marker: TakeMarker): string =>
  `${takeMarker(marker)}\nA ${marker.to.family} session (${marker.to.session}) took this claim from a ${marker.from.family} session (${marker.from.session}) with \`agent-gh claim --take\`, at ${marker.head.slice(0, 8)}; \`agent-gh review full\` takes the earlier session's commits up to there as the holder's.`;

const same = (a: Holder, b: Holder) => a.family === b.family && a.session === b.session;

/**
 * The takes that handed claim `holder` on to its holder, from a pull
 * request's comments (REST, oldest first), by people with write access as
 * for claim comments: the latest take of its `id` to the holder, the latest
 * before that to the session that one took it from, and so on back. A take
 * off that chain (one that lost a race, or failed before rewriting the
 * marker) hands nothing on.
 */
export const takesOf = (comments: readonly unknown[], holder: ClaimMarker): TakeMarker[] => {
  const chain: TakeMarker[] = [];
  let to: Holder = holder;
  for (const comment of comments.map(record).filter((item) => TRUSTED.includes(text(item.author_association))).reverse()) {
    const marker = parseTake(text(comment.body));
    if (marker === undefined || marker.id !== holder.id || !same(marker.to, to)) continue;
    chain.unshift(marker);
    to = marker.from;
  }
  return chain;
};

/**
 * Of the takes of `holder`'s claim from its holder, posted since a take made
 * it the holder (or since the claim opened), the comment id of the first,
 * by people with write access, its URL, and its marker: the one take that goes ahead
 * when several sessions take the same claim at once. Undefined when none is
 * listed.
 */
export const firstTake = (comments: readonly unknown[], holder: ClaimMarker): { readonly id: number; readonly url: string; readonly marker: TakeMarker } | undefined => {
  const takes = comments
    .map(record)
    .filter((item) => TRUSTED.includes(text(item.author_association)))
    .flatMap((item) => {
      const marker = parseTake(text(item.body));
      return marker === undefined || marker.id !== holder.id ? [] : [{ id: integer(item.id), url: text(item.html_url), marker }];
    });
  const since = takes.findLastIndex((item) => same(item.marker.to, holder));
  return takes.slice(since + 1).find((item) => same(item.marker.from, holder));
};

export const releaseCommentBody = (marker: ReleaseMarker): string => `${releaseMarker(marker)}\nReleased the claim above.`;

/** A claim pull request is still only a claim while it has the one empty commit. */
export const emptyClaim = (pull: unknown): boolean => {
  const value = record(pull);
  return value.commits === 1 && value.changed_files === 0;
};

/** The label disagrees with the claims: labelled but free, or held by an agent's claim but unlabelled. */
export type Mismatch = { readonly issue: number; readonly labeled: boolean; readonly claimed: boolean };

export const mismatch = (issue: number, labeled: boolean, claims: readonly Claim[]): Mismatch | undefined => {
  if (labeled && claims.length === 0) return { issue, labeled, claimed: false };
  if (!labeled && claims.some((claim) => claim.family !== null)) return { issue, labeled, claimed: true };
  return undefined;
};

/** "3h ago", for how long a claim has been quiet. */
export const ago = (iso: string | null, nowMs: number): string => {
  if (iso === null || iso === "") return "never";
  const minutes = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

/** A claim command's parsed arguments; `-R`/`--repo` is read separately, as gh reads it. */
export type ClaimArgs =
  | { readonly command: "claim"; readonly issue: number; readonly refs: boolean; readonly noPr: boolean }
  | { readonly command: "claim-next"; readonly refs: boolean; readonly noPr: boolean; readonly rules: LabelRules }
  | { readonly command: "next"; readonly json: boolean; readonly waves: boolean; readonly rules: LabelRules }
  | { readonly command: "take"; readonly issue: number }
  | { readonly command: "restore"; readonly issue: number }
  | { readonly command: "release"; readonly issue: number }
  | { readonly command: "claims"; readonly json: boolean }
  | { readonly command: "sync"; readonly issues: readonly number[] };

/**
 * `claim N|--next [--refs|--no-pr]`, `claim --take N`, `claim --restore N`, `release N`, `claims [--json]`,
 * `claims sync [--issue N]...`, `next [--json] [--waves]`, each with an
 * optional `-R repo`; undefined when they do not parse. `next` and
 * `claim --next` also take `--skip-label`, `--require-label`, and
 * `--fit-label`, each repeatable, with a pattern as the next word or after `=`.
 */
export const parseClaimArgs = (command: string, args: readonly string[]): ClaimArgs | undefined => {
  const words: string[] = [];
  const labels: Record<"skip" | "require" | "fit", string[]> = { skip: [], require: [], fit: [] };
  let labelFlags = 0;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    const flag = /^--(skip|require|fit)-label(?:=([\s\S]*))?$/.exec(arg);
    if (flag !== null) {
      // The pattern is the next word, or what follows `=`; a missing, blank, or flag-like one is refused.
      const pattern = flag[2] ?? args[++index];
      if (pattern === undefined || pattern.trim() === "" || (flag[2] === undefined && pattern.startsWith("--"))) return undefined;
      if (flag[1] === "fit" && fitGroup(pattern) === undefined) return undefined;
      labels[flag[1] as "skip" | "require" | "fit"].push(pattern);
      labelFlags++;
    } else if (arg === "-R" || arg === "--repo") {
      if (args[++index] === undefined) return undefined;
    } else if (!arg.startsWith("--repo=") && !(arg.startsWith("-R") && arg.length > 2)) words.push(arg);
  }
  const number = (value: string | undefined) => (value !== undefined && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : undefined);
  const takesLabels = (command === "claim" && words.includes("--next")) || command === "next";
  if (labelFlags > 0 && !takesLabels) return undefined;
  if (command === "claim") {
    const issues = words.filter((word) => !word.startsWith("-"));
    const handover = words.find((word) => word === "--take" || word === "--restore");
    if (handover !== undefined) {
      const issue = number(words.filter((word) => word !== handover)[0]);
      return issue === undefined || words.length !== 2 ? undefined : { command: handover === "--take" ? "take" : "restore", issue };
    }
    const next = words.includes("--next");
    const flags = words.filter((word) => word.startsWith("-") && word !== "--next");
    if (next) {
      if (issues.length > 0 || words.filter((word) => word === "--next").length > 1 || flags.some((flag) => flag !== "--refs" && flag !== "--no-pr") || flags.length > 1) return undefined;
      return { command: "claim-next", refs: flags.includes("--refs"), noPr: flags.includes("--no-pr"), rules: labels };
    }
    const issue = number(issues[0]);
    if (issue === undefined || issues.length !== 1 || flags.some((flag) => flag !== "--refs" && flag !== "--no-pr") || new Set(flags).size !== flags.length) return undefined;
    if (flags.length === 2) return undefined;
    return { command, issue, refs: flags.includes("--refs"), noPr: flags.includes("--no-pr") };
  }
  if (command === "release") {
    const issue = number(words[0]);
    return issue === undefined || words.length !== 1 ? undefined : { command, issue };
  }
  if (command === "next") {
    if (words.some((word) => word !== "--json" && word !== "--waves") || new Set(words).size !== words.length) return undefined;
    return { command, json: words.includes("--json"), waves: words.includes("--waves"), rules: labels };
  }
  if (command !== "claims") return undefined;
  if (words[0] === "sync") {
    const issues: number[] = [];
    for (let index = 1; index < words.length; index += 2) {
      const issue = number(words[index + 1]);
      if (words[index] !== "--issue" || issue === undefined) return undefined;
      issues.push(issue);
    }
    return { command: "sync", issues };
  }
  if (words.length > 1 || (words.length === 1 && words[0] !== "--json")) return undefined;
  return { command, json: words.length === 1 };
};
