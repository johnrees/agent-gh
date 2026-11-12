import type { GraphJson, IssueStatus } from "../src/graph.ts";

type Issue = GraphJson["issues"][number];
type Milestone = readonly [number, string] | null;

const M0: Milestone = [1, "M0"];
const END: Milestone = [2, "end"];
const OLD: Milestone = [3, "Old"];

const node = (number: number, status: IssueStatus, title: string, milestone: Milestone, blockers: Issue["blocked_by"] = [], extra: Partial<Issue> = {}): Issue => ({
  issue: number, title, url: `https://github.com/johnrees/widget/issues/${number}`, state: status === "merged" || status === "closed" ? "closed" : "open",
  milestone: milestone?.[1] ?? null, milestone_number: milestone?.[0] ?? null, labels: [], priority: null, queued: null,
  blocked_by: blockers, wave: null, status, skipped_by: null, claim: null, pr: null, updated_at: "2026-10-20T00:00:00Z", ...extra,
});
const here = (issue: number, open = true) => ({ issue, repo: null, open });

const claim = (pr: number, family: string | null, author: string): NonNullable<Issue["claim"]> => ({
  kind: "pr", pr, url: `https://github.com/johnrees/widget/pull/${pr}`, author, family, session: "s", branch: `claude/${pr}-x`,
  created_at: "2026-10-20T09:00:00Z", last_push_at: "2026-10-21T06:30:00Z", last_comment_at: "2026-10-21T08:00:00Z",
});
const pr = (number: number, draft: boolean, statuses: Record<string, string | null>, checks: NonNullable<Issue["pr"]>["checks"]): NonNullable<Issue["pr"]> => ({
  number, url: `https://github.com/johnrees/widget/pull/${number}`, draft, state: "open", merged_at: null, review_decision: null,
  statuses: { "agent-review": null, "agent-threads": null, "agent-hold": null, ...statuses }, checks,
});

/**
 * Every status, a blocker in another repository, issues with no milestone, a
 * closed blocker in a closed milestone (not in `milestones` without --all),
 * and hostile titles.
 */
export const FIXTURE: GraphJson = {
  v: 1,
  repo: "johnrees/widget",
  fetched_at: "2026-10-21T12:00:00.000Z",
  queue: null,
  label: "ready",
  milestones: [
    { number: 1, title: "M0", description: "", state: "open", open: 3, closed: 1 },
    { number: 2, title: "end", description: "", state: "open", open: 1, closed: 0 },
  ],
  issues: [
    node(1, "workable", 'Say "hi" ] and </script><b>x</b>', M0, [here(14, false), { issue: 41, repo: "johnrees/other", open: true }]),
    node(2, "blocked", "end", M0, [here(1)]),
    node(3, "claimed", "#12; is not an entity", END, [], { claim: claim(31, "claude", "johnrees"), pr: pr(31, true, {}, "missing") }),
    node(4, "in_review", "Ship it \u{1F680} now & `then`", null, [], { claim: claim(32, "codex", "johnrees"), pr: pr(32, false, { "agent-review": "pending", "agent-threads": "success" }, "pending") }),
    node(5, "ready", "Ready one", M0, [], { claim: claim(33, null, "renovate[bot]"), pr: pr(33, false, { "agent-review": "success", "agent-threads": "success", "agent-hold": "success" }, "passed") }),
    node(7, "not_dispatched", "A title that runs on well past the forty character cut", null),
    node(8, "skipped", "Held for a person", null, [], { skipped_by: { rule: "hold.label", pattern: "needs-human", label: "needs-human" } }),
    node(9, "stuck", "One side", null, [here(10)]),
    node(10, "stuck", "Other side", null, [here(9)]),
    node(12, "merged", "Done", M0),
    node(13, "closed", "Abandoned", null),
    node(14, "merged", "Old groundwork", OLD),
  ],
  stuck: [9, 10],
  cycles: [[9, 10]],
};
