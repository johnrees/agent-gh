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

const started = (run: Record<string, unknown>) => (typeof run.started_at === "string" ? run.started_at : "");
const runId = (run: Record<string, unknown>) => (Number.isSafeInteger(run.id) ? (run.id as number) : 0);

/** The runs that started last (by `started_at`, then `id`): the ones GitHub judges a required check by. */
const newest = (runs: Record<string, unknown>[]): Record<string, unknown>[] => {
  const last = runs.reduce<Record<string, unknown> | undefined>(
    (best, run) => (best === undefined || started(run) > started(best) || (started(run) === started(best) && runId(run) > runId(best)) ? run : best),
    undefined,
  );
  return last === undefined ? [] : runs.filter((run) => started(run) === started(last) && runId(run) === runId(last));
};

/**
 * Whether a commit passed a required check, from its statuses, latest first,
 * and the check runs named `check.context` (the latest of each suite). Only
 * the newest matching run counts, as GitHub's own rules judge it: a draft's
 * failed run in one workflow run is superseded by the ready one's pass in
 * the next. Runs started together (or undated) must all pass. A check tied to an App counts only that App's
 * check runs and statuses: for one, `statuses` must give each status's
 * `app_id` (the App whose bot set it), and a status without it never counts.
 */
export const checkState = (check: RequiredCheck, statuses: unknown, runs: unknown): CheckState => {
  const matching = newest(
    list(runs)
      .map(record)
      .filter((run) => run.name === check.context && (check.app === undefined || record(run.app).id === check.app)),
  );
  const status = list(statuses).map(record).find((entry) => entry.context === check.context && (check.app === undefined || entry.app_id === check.app));
  if (matching.length === 0 && status === undefined) return "missing";
  if (matching.some((run) => run.status === "completed" && !PASSING.includes(run.conclusion as string))) return "failed";
  if (status !== undefined && (status.state === "failure" || status.state === "error")) return "failed";
  if (matching.some((run) => run.status !== "completed")) return "pending";
  if (status !== undefined && status.state !== "success") return "pending";
  return "passed";
};

/**
 * The branches a push moves, from the lines git gives a pre-push hook
 * (`<local ref> <local sha> <remote ref> <remote sha>`), deletions
 * included; tags and other refs carry no required checks. Undefined when a
 * line is not in that form, so the guard fails closed.
 */
export const pushedBranches = (stdin: string): string[] | undefined => {
  const branches: string[] = [];
  for (const line of stdin.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split(" ");
    if (parts.length !== 4 || !/^[0-9a-f]{40,64}$/.test(parts[1] as string) || !/^[0-9a-f]{40,64}$/.test(parts[3] as string)) return undefined;
    const remote = parts[2] as string;
    if (remote.startsWith("refs/heads/")) branches.push(remote.slice("refs/heads/".length));
    else if (!remote.startsWith("refs/")) return undefined;
  }
  return [...new Set(branches)];
};
