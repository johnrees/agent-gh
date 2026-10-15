/**
 * The agent-threads predicate: which comments on a pull request, or on an
 * issue it closes, still wait for an agent's answer. Pure: threads-run.ts
 * reads GitHub, and both the agent-review workflow and the `gh pr ready`
 * gate decide with this.
 *
 * Only issue comments count (the pull request's conversation and the
 * issue's). GitHub records which App posted an issue comment
 * (`performed_via_github_app`) but not which posted a review or an inline
 * review comment, so agents' and the owner's inline comments cannot be told
 * apart; inline threads are left to the ruleset's conversation resolution.
 */
import { statusDescription } from "./review.ts";

export const THREADS_CONTEXT = "agent-threads";

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * A notify: an agent's finding posted on another thread. P0 to P2 need a
 * reply; P3 never does. `id` names it, so a reply can point at it, and
 * `session` names the harness session that posted it (`<harness>:<id>`),
 * when the harness tells. `agent-gh notify` and `reply` post them (notify.ts,
 * reply.ts); this is the format both read.
 */
export type NotifyMarker = { readonly v: 1; readonly id: string; readonly severity: Severity; readonly session?: string };
/** A reply to the notify or review finding `to`; a reply never needs an answer itself. */
export type ReplyMarker = { readonly v: 1; readonly to: string; readonly session?: string };

const NOTIFY = /<!-- agent-notify (\{[^\n]*?\}) -->/;
const REPLY = /<!-- agent-reply (\{[^\n]*?\}) -->/;
const ID = /^[0-9a-f]{8,64}$/;

export const notifyMarker = (marker: NotifyMarker): string => `<!-- agent-notify ${JSON.stringify(marker)} -->`;
export const replyMarker = (marker: ReplyMarker): string => `<!-- agent-reply ${JSON.stringify(marker)} -->`;

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

/** A comment's notify marker; undefined when it has none or it is malformed. Keys a later version adds are ignored. */
export const parseNotify = (body: string): NotifyMarker | undefined => {
  const value = markerObject(NOTIFY, body);
  if (value?.v !== 1 || typeof value.id !== "string" || !ID.test(value.id) || !SEVERITIES.includes(value.severity as Severity)) return undefined;
  return { v: 1, id: value.id, severity: value.severity as Severity };
};

/** A comment's reply marker; undefined when it has none or it is malformed. */
export const parseReply = (body: string): ReplyMarker | undefined => {
  const value = markerObject(REPLY, body);
  if (value?.v !== 1 || typeof value.to !== "string" || !ID.test(value.to)) return undefined;
  return { v: 1, to: value.to };
};

/** An issue comment, on the pull request's conversation or an issue it closes (`thread`). */
export type ThreadComment = {
  readonly id: number;
  readonly thread: string;
  readonly url: string;
  readonly author: string;
  /** The App it was posted through (`performed_via_github_app.id`), if any. */
  readonly appId: number | undefined;
  readonly createdAt: string;
  readonly body: string;
  /** Its 👍 reactions, from anyone. */
  readonly thumbsUp: number;
};

export type ThreadsInput = {
  /** The repository owner: the person whose comments need an answer. */
  readonly owner: string;
  /** The family Apps' ids: the owner's comments through one are an agent's. */
  readonly agentApps: readonly number[];
  /** When the pull request was opened: the owner's earlier comments are not about it. */
  readonly since: string;
  readonly comments: readonly ThreadComment[];
};

export type RequiredComment = { readonly url: string; readonly thread: string; readonly why: string };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Posted by the owner through a family App: an agent's comment. */
export const byAgent = (comment: ThreadComment, owner: string, apps: readonly number[]): boolean =>
  same(comment.author, owner) && comment.appId !== undefined && apps.includes(comment.appId);

const after = (a: ThreadComment, b: ThreadComment) => a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);

/**
 * The owner's own comments (not through a family App), posted after the pull
 * request was opened, that are newer than the last agent comment on their
 * thread: the ball is in an agent's court. A 👍 is not yet considered; these
 * are the comments whose reactions are worth reading.
 */
export const awaitingOwner = (input: ThreadsInput): ThreadComment[] => {
  const lastAgent = new Map<string, ThreadComment>();
  for (const comment of input.comments) {
    if (!byAgent(comment, input.owner, input.agentApps)) continue;
    const last = lastAgent.get(comment.thread);
    if (last === undefined || after(comment, last)) lastAgent.set(comment.thread, comment);
  }
  // An opening time GitHub did not give counts every comment, never none.
  const since = Number.isNaN(Date.parse(input.since)) ? Number.NEGATIVE_INFINITY : Date.parse(input.since);
  return input.comments.filter((comment) => {
    if (!same(comment.author, input.owner) || byAgent(comment, input.owner, input.agentApps)) return false;
    if (!(Date.parse(comment.createdAt) > since)) return false;
    const last = lastAgent.get(comment.thread);
    return last === undefined || after(comment, last);
  });
};

/**
 * The comments that keep agent-threads failing: each unanswered P0 to P2
 * notify an agent posted (a reply marker from an agent answers it), and each
 * of the owner's comments `awaitingOwner` finds, unless the owner gave it a
 * 👍 (`thumbedUp`, by comment id), which says no answer is needed.
 */
export const requiredComments = (input: ThreadsInput, thumbedUp: ReadonlySet<number>): RequiredComment[] => {
  const agents = input.comments.filter((comment) => byAgent(comment, input.owner, input.agentApps));
  const replied = new Set(agents.flatMap((comment) => parseReply(comment.body)?.to ?? []));
  const notifies = agents.flatMap((comment) => {
    const notify = parseNotify(comment.body);
    return notify === undefined || notify.severity === "P3" || replied.has(notify.id)
      ? []
      : [{ url: comment.url, thread: comment.thread, why: `an unanswered ${notify.severity} notify` }];
  });
  const owner = awaitingOwner(input)
    .filter((comment) => !thumbedUp.has(comment.id))
    .map((comment) => ({ url: comment.url, thread: comment.thread, why: `${input.owner}'s comment` }));
  return [...notifies, ...owner];
};

/** The agent-threads status for the comments `requiredComments` found. */
export const threadsStatus = (required: readonly RequiredComment[]): { readonly state: "success" | "failure"; readonly description: string; readonly targetUrl: string | undefined } =>
  required.length === 0
    ? { state: "success", description: "no comment awaits an agent's answer", targetUrl: undefined }
    : {
        state: "failure",
        description: statusDescription(`${required.length} comment(s) await an agent's answer, first ${(required[0] as RequiredComment).why} on ${(required[0] as RequiredComment).thread}`),
        targetUrl: (required[0] as RequiredComment).url,
      };
