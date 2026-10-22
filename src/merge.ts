/**
 * The merge guard's pure decisions: which status checks a base branch
 * requires, and whether a commit has passed each. An agent acts as John, who
 * may bypass the branch's rules, so `gh pr merge` from an agent session checks
 * them itself (review-run.ts does the I/O).
 */

/** A required check: its name, and the App that must report it when the rule names one. */
export type RequiredCheck = { readonly context: string; readonly app: number | undefined };

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const add = (into: RequiredCheck[], context: unknown, app: unknown) => {
  if (typeof context !== "string" || context === "") return;
  const id = Number.isSafeInteger(app) && (app as number) > 0 ? (app as number) : undefined;
  if (!into.some((check) => check.context === context && check.app === id)) into.push({ context, app: id });
};

/**
 * The checks the base branch requires: every `required_status_checks` rule
 * GitHub applies to it (`GET /repos/{o}/{r}/rules/branches/{branch}`, from
 * every ruleset), and classic branch protection's (`protection` in
 * `GET /repos/{o}/{r}/branches/{branch}`) unless it is off.
 */
export const requiredChecks = (rules: unknown, branch: unknown): RequiredCheck[] => {
  const checks: RequiredCheck[] = [];
  for (const rule of list(rules).map(record)) {
    if (rule.type !== "required_status_checks") continue;
    for (const check of list(record(rule.parameters).required_status_checks).map(record)) add(checks, check.context, check.integration_id);
  }
  const classic = record(record(record(branch).protection).required_status_checks);
  if (classic.enforcement_level !== "off") {
    const detailed = list(classic.checks).map(record);
    for (const check of detailed) add(checks, check.context, check.app_id);
    for (const context of list(classic.contexts)) if (!detailed.some((check) => check.context === context)) add(checks, context, undefined);
  }
  return checks;
};

export type CheckState = "passed" | "failed" | "pending" | "missing";

const PASSING = ["success", "neutral", "skipped"];

/** GitHub Actions' App: its check runs are workflow jobs, and its bot sets a workflow's statuses. */
export const ACTIONS_APP = 15368;

/**
 * The events whose workflow runs' jobs GitHub evaluates for required checks
 * ("Checks from some workflow jobs are not evaluated", GitHub's
 * troubleshooting required status checks). A job's check from any other
 * (`workflow_dispatch`, `schedule`, `repository_dispatch`, …) never
 * satisfies one, and agents can start those runs.
 */
export const REQUIRED_CHECK_EVENTS: readonly string[] = ["push", "pull_request", "pull_request_review", "pull_request_target", "deployment", "deployment_status"];

/** An Actions workflow run on the commit: its workflow's id, the event that started it, and whether it has completed. */
export type WorkflowRun = { readonly workflow: number; readonly event: string; readonly completed: boolean };

/** Each workflow run's check suite id, mapped to that run. */
export type WorkflowRuns = ReadonlyMap<number, WorkflowRun>;

/** A required check's runs as GitHub counts them, and whether a workflow's newest run is still to report it or finished without it. */
type Counted = { readonly runs: Record<string, unknown>[]; readonly awaited: boolean; readonly dropped: boolean };

/**
 * The check runs a required check is judged by. Another App's runs all
 * count. An Actions run (a workflow job) counts only when its workflow run
 * was started by one of `REQUIRED_CHECK_EVENTS`, and only from its
 * workflow's newest such run: the check suite with the highest id, since
 * suites are created with their workflow run (a re-run keeps its suite)
 * while a run's own id dates only its job. So a draft's failed run gives way
 * to the ready pull request's run of that workflow, two workflows with the
 * same job name are judged separately, and a dispatched run neither passes,
 * fails, nor supersedes. When that newest run has not reported the job, the
 * older run's job counts for nothing: the check is `awaited` while the run
 * is in progress, and `dropped` once it finished without it (GitHub would
 * likely still judge the older job; the guard refuses instead). An Actions
 * run whose workflow run is not in `workflows` (not listed yet) is
 * `awaited`, so the guard fails closed.
 */
const counted = (runs: Record<string, unknown>[], workflows: WorkflowRuns): Counted => {
  const newest = new Map<number, number>();
  for (const [suite, run] of workflows) if (REQUIRED_CHECK_EVENTS.includes(run.event)) newest.set(run.workflow, Math.max(newest.get(run.workflow) ?? 0, suite));
  const kept: Record<string, unknown>[] = [];
  const superseded = new Set<number>();
  let awaited = false;
  for (const run of runs) {
    if (record(run.app).id !== ACTIONS_APP) {
      kept.push(run);
      continue;
    }
    const suite = record(run.check_suite).id;
    const workflowRun = Number.isSafeInteger(suite) ? workflows.get(suite as number) : undefined;
    if (workflowRun === undefined) awaited = true;
    else if (!REQUIRED_CHECK_EVENTS.includes(workflowRun.event)) continue;
    else if (suite === newest.get(workflowRun.workflow)) kept.push(run);
    else superseded.add(workflowRun.workflow);
  }
  let dropped = false;
  for (const workflow of superseded) {
    const suite = newest.get(workflow) as number;
    if (kept.some((run) => record(run.check_suite).id === suite)) continue;
    if (workflows.get(suite)?.completed === true) dropped = true;
    else awaited = true;
  }
  return { runs: kept, awaited, dropped };
};

/**
 * Whether a commit passed a required check, from its statuses, latest first,
 * and the check runs named `check.context` (the latest of each suite), with
 * the commit's Actions workflow runs (`workflows`) to judge an Actions run
 * by (see `counted`). Every counted run must pass. A check tied to an App
 * counts only that App's check runs and statuses: for one, `statuses` must
 * give each status's `app_id` (the App whose bot set it), and a status
 * without it never counts. A check whose workflow's newest run finished
 * without it is `missing`, whatever else passed.
 */
export const checkState = (check: RequiredCheck, statuses: unknown, runs: unknown, workflows: WorkflowRuns): CheckState => {
  const { runs: matching, awaited, dropped } = counted(
    list(runs)
      .map(record)
      .filter((run) => run.name === check.context && (check.app === undefined || record(run.app).id === check.app)),
    workflows,
  );
  const status = list(statuses).map(record).find((entry) => entry.context === check.context && (check.app === undefined || entry.app_id === check.app));
  if (matching.some((run) => run.status === "completed" && !PASSING.includes(run.conclusion as string))) return "failed";
  if (status !== undefined && (status.state === "failure" || status.state === "error")) return "failed";
  if (awaited || matching.some((run) => run.status !== "completed")) return "pending";
  if (status !== undefined && status.state !== "success") return "pending";
  if (dropped || (matching.length === 0 && status === undefined)) return "missing";
  return "passed";
};

/** A tag a push writes: its name, the object it sends (git's zeros for a deletion), and the remote's (zeros when the remote has no such tag). */
export type PushedTag = { readonly tag: string; readonly local: string; readonly remote: string };

/** Whether a pre-push object name is git's zeros: nothing, for a deletion's local side or a ref the remote lacks. */
export const absent = (sha: string): boolean => /^0+$/.test(sha);

/**
 * The branches and tags a push moves, from the lines git gives a pre-push
 * hook (`<local ref> <local sha> <remote ref> <remote sha>`), deletions
 * included; other refs carry no rules. Undefined when a line is not in that
 * form, so the guard fails closed.
 */
export const pushedRefs = (stdin: string): { readonly branches: string[]; readonly tags: PushedTag[] } | undefined => {
  const branches: string[] = [];
  const tags: PushedTag[] = [];
  for (const line of stdin.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split(" ");
    if (parts.length !== 4 || !/^[0-9a-f]{40,64}$/.test(parts[1] as string) || !/^[0-9a-f]{40,64}$/.test(parts[3] as string)) return undefined;
    const [local, remoteRef, remote] = [parts[1] as string, parts[2] as string, parts[3] as string];
    if (remoteRef.startsWith("refs/heads/")) branches.push(remoteRef.slice("refs/heads/".length));
    else if (remoteRef.startsWith("refs/tags/") && remoteRef.length > "refs/tags/".length) tags.push({ tag: remoteRef.slice("refs/tags/".length), local, remote });
    else if (!remoteRef.startsWith("refs/") || remoteRef === "refs/tags/") return undefined;
  }
  return { branches: [...new Set(branches)], tags };
};
