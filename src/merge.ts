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

/**
 * Whether a commit passed a required check, from its combined status's
 * `statuses` and the check runs named `check.context` (the latest of each
 * suite). Every matching run must pass. A check tied to an App counts only
 * that App's check runs: a commit status does not say which App set it, so
 * one never satisfies it here, and the guard refuses rather than guess.
 */
export const checkState = (check: RequiredCheck, statuses: unknown, runs: unknown): CheckState => {
  const matching = list(runs)
    .map(record)
    .filter((run) => run.name === check.context && (check.app === undefined || record(run.app).id === check.app));
  const status = check.app === undefined ? list(statuses).map(record).find((entry) => entry.context === check.context) : undefined;
  if (matching.length === 0 && status === undefined) return "missing";
  if (matching.some((run) => run.status === "completed" && !PASSING.includes(run.conclusion as string))) return "failed";
  if (status !== undefined && (status.state === "failure" || status.state === "error")) return "failed";
  if (matching.some((run) => run.status !== "completed")) return "pending";
  if (status !== undefined && status.state !== "success") return "pending";
  return "passed";
};
