/**
 * `agent-gh graph --json`: the repository as one graph of issues, their
 * `blocked_by` edges, milestones, claims, and pull request state, so an
 * orchestrator reads it in one call instead of joining `next --waves`,
 * `claims`, and `gh api` by hand. Pure: graph-run.ts reads GitHub (GraphQL)
 * and hands this the issues and pull requests, the claim inputs in REST's
 * shapes, so `taken` and `checkState` judge them as they judge REST's.
 *
 * `blocked_by` is the only edge: a pull request is a property of its issue,
 * a milestone is a group, and a **When done, update** line is prose.
 */
import { type Claim, emptyClaim, taken } from "./claim.ts";
import { type CheckState, checkState, type RequiredCheck, type WorkflowRuns } from "./merge.ts";
import { type Blocker, labelFilter, type LabelRules, type Node, type SkippedBy, waves } from "./next.ts";
import type { QueueConfig } from "./next-run.ts";
import { type Repo, slug } from "./repo.ts";
import { sameLabel, STATUS_CONTEXT } from "./review.ts";
import { HOLD_CONTEXT } from "./status.ts";
import { THREADS_CONTEXT } from "./threads.ts";

/** `graph --json [--all]`, with an optional `-R repo`; undefined when it does not parse, or lacks `--json`. */
export const parseGraphArgs = (args: readonly string[]): { readonly all: boolean } | undefined => {
  const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "-R" || arg === "--repo") {
      if (args[++index] === undefined) return undefined;
    } else if (!arg.startsWith("--repo=") && !(arg.startsWith("-R") && arg.length > 2)) words.push(arg);
  }
  if (words.some((word) => word !== "--json" && word !== "--all") || new Set(words).size !== words.length || !words.includes("--json")) return undefined;
  return { all: words.includes("--all") };
};

/** A pull request as an issue links it (`closedByPullRequestsReferences`), open or not. */
export type PullRef = {
  readonly number: number;
  readonly url: string;
  /** In this repository: a pull request elsewhere can close the issue too, and its number says nothing here. */
  readonly here: boolean;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly mergedAt: string | null;
};

/** An open pull request, with what its claim and its statuses are judged by. */
export type GraphPull = PullRef & {
  /** As REST's `GET /repos/{o}/{r}/pulls` lists it, for `claimsOn`: number, state, body, html_url, user, head, draft, created_at. */
  readonly rest: Record<string, unknown>;
  readonly base: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, or `REVIEW_REQUIRED`, lowercased; null for none. */
  readonly reviewDecision: string | null;
  readonly commits: number;
  readonly changedFiles: number;
  /** The head commit's committer date. */
  readonly lastPushAt: string | null;
  /** Its latest conversation comment's. */
  readonly lastCommentAt: string | null;
  /** The head's statuses, latest first, as REST lists them (context, state, and `app_id` where known). */
  readonly statuses: readonly Record<string, unknown>[];
  /** The head's check runs, as REST lists them (name, status, conclusion, app, check_suite). */
  readonly runs: readonly Record<string, unknown>[];
  /** Each check suite's Actions workflow run, for `checkState`. */
  readonly workflows: WorkflowRuns;
};

export type GraphIssue = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly open: boolean;
  readonly milestone: { readonly number: number; readonly title: string } | null;
  readonly labels: readonly string[];
  /** Its blockers; `repo` is undefined for one in this repository. */
  readonly blockedBy: readonly Blocker[];
  /** Every comment, as REST lists them (id, html_url, author_association, user, body, created_at), for an open issue; none for a closed one. */
  readonly comments: readonly Record<string, unknown>[];
  /** The pull requests that close it, as GitHub links them. */
  readonly closedBy: readonly PullRef[];
  readonly updatedAt: string;
};

export type Milestone = { readonly number: number; readonly title: string; readonly description: string; readonly state: "open" | "closed"; readonly open: number; readonly closed: number };

export type GraphRead = {
  readonly repo: Repo;
  readonly fetchedAt: string;
  readonly config: QueueConfig;
  /** The Queue's order, or undefined when no queue is configured. */
  readonly queue: readonly number[] | undefined;
  readonly milestones: readonly Milestone[];
  readonly issues: readonly GraphIssue[];
  /** Every open pull request. */
  readonly pulls: readonly GraphPull[];
  /** The checks each base branch of an open pull request requires. */
  readonly required: ReadonlyMap<string, readonly RequiredCheck[]>;
};

export type IssueStatus = "blocked" | "stuck" | "not_dispatched" | "skipped" | "workable" | "claimed" | "in_review" | "ready" | "merged" | "closed";

/** The agent-gh statuses `graph` reports on a pull request's head. */
export const CONTEXTS = [STATUS_CONTEXT, THREADS_CONTEXT, HOLD_CONTEXT] as const;

/** The required checks as one state, the worst first: failed, missing, pending, passed; null when the base requires none. */
export const checksOf = (required: readonly RequiredCheck[], pull: Pick<GraphPull, "statuses" | "runs" | "workflows">): CheckState | null => {
  if (required.length === 0) return null;
  const states = required.map((check) => checkState(check, pull.statuses, pull.runs, pull.workflows));
  return (["failed", "missing", "pending"] as const).find((state) => states.includes(state)) ?? "passed";
};

const contextState = (pull: GraphPull, context: string): string | null => {
  const found = pull.statuses.find((status) => status.context === context);
  return typeof found?.state === "string" ? found.state : null;
};

/** A ready pull request is `ready` once agent-review passed, agent-threads and agent-hold pass where set, and so do the base's required checks. */
const pullStatus = (pull: GraphPull, checks: CheckState | null): "claimed" | "in_review" | "ready" => {
  if (pull.draft || emptyClaim({ commits: pull.commits, changed_files: pull.changedFiles })) return "claimed";
  const passes = (context: string, unset: boolean) => {
    const state = contextState(pull, context);
    return state === null ? unset : state === "success";
  };
  return passes(STATUS_CONTEXT, false) && passes(THREADS_CONTEXT, true) && passes(HOLD_CONTEXT, true) && (checks === null || checks === "passed") ? "ready" : "in_review";
};

const latest = (times: readonly (string | null)[]): string | null => times.filter((at): at is string => at !== null && at !== "").sort().at(-1) ?? null;

/**
 * The pull request to show for an issue: its claim's, else the latest open,
 * merged, then closed one that closes it; `live` is its open pull request
 * here, with the statuses, when it is one.
 */
const pullFor = (issue: GraphIssue, holder: Claim | undefined, open: ReadonlyMap<number, GraphPull>): { readonly live: GraphPull | undefined; readonly ref: PullRef | undefined } => {
  if (holder !== undefined && holder.pr !== null) {
    const live = open.get(holder.pr);
    return { live, ref: live };
  }
  for (const state of ["open", "merged", "closed"] as const) {
    const found = issue.closedBy.filter((pull) => pull.state === state).sort((a, b) => b.number - a.number)[0];
    if (found !== undefined) return { live: found.here && state === "open" ? open.get(found.number) : undefined, ref: found };
  }
  return { live: undefined, ref: undefined };
};

/**
 * The graph as `graph --json` prints it. Every open issue of this repository
 * goes through `waves`, as `next --waves` would lay it out with every open
 * issue dispatched or not, so `wave`, `stuck`, and `cycles` agree with it;
 * its holder is `taken`'s, as `claims` judges it. `status`: closed issues
 * are `merged` (a pull request that closes it merged) or `closed`; an open
 * one with a holder is `claimed` (a comment, a draft, or still only the
 * claim's empty commit), `in_review`, or `ready`; otherwise `stuck` (on or
 * behind a cycle, or behind an open issue in another repository), `blocked`
 * (an open blocker here), `skipped` (`hold.label` or `queue.skip_labels`),
 * `not_dispatched` (not `ready`, or not queued), or `workable`.
 */
export const graphJson = (input: GraphRead) => {
  const name = slug(input.repo);
  const pulls = input.pulls.map((pull) => pull.rest);
  const open = new Map(input.pulls.map((pull) => [pull.number, pull]));
  const rules: LabelRules = { skip: [], require: [], fit: [], configured: input.config.skipLabels, ...(input.config.holdLabel === undefined ? {} : { held: input.config.holdLabel }) };
  const holders = new Map<number, Claim | undefined>();
  const nodes = new Map<number, Node>();
  for (const issue of input.issues) {
    if (!issue.open) continue;
    const holder = taken(input.repo, { number: issue.number, state: "open" }, pulls, issue.comments).holder;
    holders.set(issue.number, holder);
    // GitHub's labels ignore case, as next's `labels=` filter does.
    const dispatched = issue.labels.some((label) => sameLabel(label, input.config.label)) && (input.queue === undefined || input.queue.includes(issue.number));
    const skipped = dispatched ? labelFilter(issue.labels, rules) : undefined;
    const rank = input.config.priorityLabels.findIndex((label) => issue.labels.includes(label));
    nodes.set(issue.number, {
      number: issue.number, title: issue.title, dispatched, blockers: issue.blockedBy, claim: holder, labels: issue.labels,
      ...(skipped === undefined ? {} : { skipped }),
      ...(rank === -1 ? {} : { priority: { label: input.config.priorityLabels[rank] as string, rank } }),
    });
  }
  const laid = waves({ queue: input.queue, nodes });
  const waveOf = new Map<number, number>();
  laid.waves.forEach((layer, index) => {
    for (const item of layer) waveOf.set(item.issue, index + 1);
  });
  const issues = [...input.issues].sort((a, b) => a.number - b.number).map((issue) => {
    const holder = holders.get(issue.number);
    const node = nodes.get(issue.number);
    const wave = waveOf.get(issue.number) ?? null;
    const { live, ref } = pullFor(issue, holder, open);
    const checks = live === undefined ? null : checksOf(input.required.get(live.base) ?? [], live);
    const status: IssueStatus = !issue.open
      ? issue.closedBy.some((pull) => pull.state === "merged")
        ? "merged"
        : "closed"
      : holder !== undefined
        ? holder.kind === "pr" && live !== undefined
          ? pullStatus(live, checks)
          : "claimed"
        : wave === null
          ? "stuck"
          : wave > 1
            ? "blocked"
            : node?.skipped !== undefined
              ? "skipped"
              : node?.dispatched === true
                ? "workable"
                : "not_dispatched";
    const holderPull = holder === undefined || holder.pr === null ? undefined : open.get(holder.pr);
    const at = input.queue?.indexOf(issue.number) ?? -1;
    return {
      issue: issue.number,
      title: issue.title,
      url: issue.url,
      state: issue.open ? "open" : "closed",
      milestone: issue.milestone?.title ?? null,
      labels: [...issue.labels].sort(),
      priority: node?.priority?.label ?? null,
      queued: at === -1 ? null : at,
      blocked_by: issue.blockedBy.map((blocker) => ({ issue: blocker.number, repo: blocker.repo ?? null, open: blocker.open })),
      wave,
      status,
      skipped_by: (node?.skipped ?? null) as SkippedBy | null,
      claim:
        holder === undefined
          ? null
          : {
              kind: holder.kind, pr: holder.pr, url: holder.url, author: holder.author, family: holder.family, session: holder.session, branch: holder.branch,
              created_at: holder.createdAt,
              last_push_at: holderPull?.lastPushAt ?? null,
              last_comment_at: latest([...issue.comments.map((comment) => (typeof comment.created_at === "string" ? comment.created_at : null)), holderPull?.lastCommentAt ?? null]),
            },
      pr:
        ref === undefined
          ? null
          : {
              number: ref.number, url: ref.url, draft: ref.draft, state: ref.state, merged_at: ref.mergedAt,
              review_decision: live?.reviewDecision ?? null,
              statuses: Object.fromEntries(CONTEXTS.map((context) => [context, live === undefined ? null : contextState(live, context)])),
              checks,
            },
      updated_at: issue.updatedAt,
    };
  });
  return {
    v: 1,
    repo: name,
    fetched_at: input.fetchedAt,
    queue: input.config.issue ?? null,
    label: input.config.label,
    priority_labels: [...input.config.priorityLabels],
    milestones: input.milestones.map((milestone) => ({ ...milestone })),
    issues,
    stuck: laid.stuck.map((item) => item.issue),
    cycles: laid.cycles,
  };
};

export type GraphJson = ReturnType<typeof graphJson>;
