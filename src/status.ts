import type { AgentApp } from "./config.ts";
import { type BlockOn, parseMarker, type ReviewMarker, reviewState, STATUS_CONTEXT, statusDescription } from "./review.ts";

/**
 * The agent-review workflow's pure decisions: which pull requests an event
 * concerns, whether one is an agent's, which review markers count, and the
 * agent-review status they give. status-run.ts does the I/O.
 */

export type Status = {
  readonly context: string;
  readonly state: "success" | "failure" | "pending" | "error";
  readonly description: string;
  readonly targetUrl: string | undefined;
};

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/**
 * The pull requests an Actions event concerns: the event's own, or, for a
 * comment on an issue that is not a pull request, the issue (whose closing
 * pull requests the caller looks up). Undefined for any other event.
 */
export const eventTarget = (name: string, payload: unknown): { readonly pull: number } | { readonly issue: number } | undefined => {
  const event = record(payload);
  const pull = record(event.pull_request).number;
  if (["pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment"].includes(name)) {
    return Number.isSafeInteger(pull) ? { pull: pull as number } : undefined;
  }
  if (name === "issue_comment") {
    const issue = record(event.issue);
    if (!Number.isSafeInteger(issue.number)) return undefined;
    return issue.pull_request !== undefined && issue.pull_request !== null ? { pull: issue.number as number } : { issue: issue.number as number };
  }
  return undefined;
};

/** A review or issue comment that may hold a review marker. */
export type MarkerPost = {
  readonly author: string;
  /** The App it was posted through; GitHub records none for a review, so a review's is always undefined. */
  readonly appId: number | undefined;
  readonly kind: "review" | "comment";
  readonly at: string;
  readonly body: string;
  readonly url: string;
};

export type FoundMarker = { readonly marker: ReviewMarker; readonly at: string; readonly url: string };

/**
 * The review markers that count, oldest first: posted by the repository
 * owner, through a family App for a comment. A review records no App
 * (GitHub keeps none for reviews), so a review counts when the owner posted
 * it, which every agent does, as the owner.
 */
export const validMarkers = (posts: readonly MarkerPost[], owner: string, apps: readonly AgentApp[]): FoundMarker[] =>
  posts
    .filter((post) => post.author.toLowerCase() === owner.toLowerCase())
    .filter((post) => post.kind === "review" || (post.appId !== undefined && apps.some((app) => app.id === post.appId)))
    .flatMap((post) => {
      const marker = parseMarker(post.body);
      return marker === undefined ? [] : [{ marker, at: post.at, url: post.url }];
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

/**
 * Whether a commit message shows an agent wrote it: an `Agent-*` trailer
 * (agent-gh's commit hook adds them), or a `Co-authored-by` crediting a
 * family App or Claude.
 */
export const agentCommit = (message: string, apps: readonly AgentApp[]): boolean =>
  message.split(/\r?\n/).some((line) => {
    if (/^Agent-[A-Za-z-]+:\s*\S/.test(line)) return true;
    const credit = /^Co-authored-by:\s*(.+)$/i.exec(line)?.[1]?.trim().toLowerCase();
    if (credit === undefined) return false;
    return credit.includes("<noreply@anthropic.com>") || apps.some((app) => credit.split(/\s+/)[0] === app.bot.toLowerCase());
  });

/**
 * Whether a pull request is an agent's. Not one: a bot's (Dependabot's, say)
 * that is not a family App, or one none of whose commits shows an agent.
 * `commits` undefined (too many to read) counts as an agent's, so the review
 * is never skipped on a guess.
 */
export const agentPull = (
  pull: { readonly author: string; readonly authorType: string; readonly viaApp: number | undefined; readonly commits: readonly string[] | undefined },
  apps: readonly AgentApp[],
): boolean => {
  if (pull.viaApp !== undefined && apps.some((app) => app.id === pull.viaApp)) return true;
  if (apps.some((app) => app.bot.toLowerCase() === pull.author.toLowerCase())) return true;
  if (pull.authorType === "Bot") return false;
  return pull.commits === undefined || pull.commits.some((message) => agentCommit(message, apps));
};

/**
 * The marker a head with no review of its own may carry forward: the latest
 * for the same patch (`git patch-id --stable` of its diff from its merge
 * base), when that one approved. A later `changes_requested` on the same
 * patch is never skipped for an earlier approval. The caller still checks
 * that the base's changes since the marker's merge base touch none of the
 * patch's files.
 */
export const carryCandidate = (markers: readonly FoundMarker[], patchId: string | null): FoundMarker | undefined => {
  if (patchId === null) return undefined;
  const latest = markers.findLast((found) => found.marker.patch_id === patchId);
  return latest?.marker.verdict === "approve" ? latest : undefined;
};

/** The latest marker for `head`, which decides its status. */
export const markerFor = (markers: readonly FoundMarker[], head: string): FoundMarker | undefined => markers.findLast((found) => found.marker.head === head);

const status = (state: Status["state"], description: string, targetUrl?: string): Status => ({
  context: STATUS_CONTEXT,
  state,
  description: statusDescription(description),
  targetUrl,
});

/**
 * agent-review for pull request `number`'s head: success for a pull request
 * that is not an agent's, or that a person waived; else the head's own
 * marker's verdict (`block_on` fails it); else an approval carried forward;
 * else pending, naming the command that reviews it.
 */
export const reviewStatus = (input: {
  readonly number: number;
  readonly agent: boolean;
  readonly waivedBy: string | undefined;
  readonly current: FoundMarker | undefined;
  readonly carried: FoundMarker | undefined;
  readonly blockOn: BlockOn;
}): Status => {
  if (!input.agent) return status("success", "not an agent PR");
  if (input.waivedBy !== undefined) return status("success", `waived by ${input.waivedBy}`);
  if (input.current !== undefined) {
    const { marker } = input.current;
    return status(
      reviewState(marker.verdict, input.blockOn),
      `${marker.verdict === "approve" ? "approved" : "changes requested"}; checks ${marker.checks} (${marker.reviewer} review)`,
      input.current.url,
    );
  }
  if (input.carried !== undefined) {
    const { marker } = input.carried;
    return status("success", `approved at ${marker.head.slice(0, 8)}, carried forward: same patch, base changes miss its files; checks ${marker.checks}`, input.carried.url);
  }
  return status("pending", `needs a review: run \`gh pr checkout ${input.number} && agent-gh review full --pr ${input.number}\``);
};
