import { expect, test } from "bun:test";
import { checkState, requiredChecks } from "../src/merge.ts";

const RULES = [
  { type: "deletion" },
  { type: "required_status_checks", parameters: { required_status_checks: [{ context: "build", integration_id: 15368 }, { context: "agent-review" }] } },
  { type: "required_status_checks", parameters: { required_status_checks: [{ context: "agent-review" }] } },
];

test("the required checks are every ruleset's and classic protection's, once each", () => {
  expect(requiredChecks(RULES, { protected: false })).toEqual([{ context: "build", app: 15368 }, { context: "agent-review", app: undefined }]);
  const classic = { protection: { required_status_checks: { enforcement_level: "everyone", contexts: ["lint", "test"], checks: [{ context: "test", app_id: 7 }] } } };
  expect(requiredChecks([], classic)).toEqual([{ context: "test", app: 7 }, { context: "lint", app: undefined }]);
  expect(requiredChecks([], { protection: { required_status_checks: { enforcement_level: "off", contexts: ["lint"], checks: [] } } })).toEqual([]);
  expect(requiredChecks([], {})).toEqual([]);
});

const run = (name: string, conclusion: string | null, app = 15368, status = "completed") => ({ name, status, conclusion, app: { id: app }, check_suite: { id: 1 } });
/** Suite 1: a completed pull_request run of workflow 1, which `run`'s runs are from. */
const ONE = new Map([[1, { workflow: 1, event: "pull_request", completed: true }]]);
/** A workflow run of `workflow`, started by `event`, done or not. */
const wf = (workflow: number, event = "pull_request", completed = true) => ({ workflow, event, completed });

test("a newer run of the same workflow supersedes an older one; other workflows still count", () => {
  const build = { context: "build", app: 15368 };
  const at = (conclusion: string | null, id: number, suite: number, status = "completed", app = 15368) => ({ ...run("build", conclusion, app, status), id, check_suite: { id: suite } });
  const ci = new Map([[10, wf(1)], [20, wf(1)], [30, wf(2)]]); // suites 10 and 20 ran workflow 1, suite 30 workflow 2
  // penmon #387: the draft's run failed, the ready run of the same workflow passed.
  expect(checkState(build, [], [at("failure", 1, 10), at("success", 2, 20)], ci)).toBe("passed");
  expect(checkState(build, [], [at("success", 1, 10), at("failure", 2, 20)], ci)).toBe("failed");
  // An older workflow run whose job was created late (a higher run id) is still older.
  expect(checkState(build, [], [at("success", 3, 10), at("failure", 2, 20)], ci)).toBe("failed");
  // Every current run of the newest workflow run must pass.
  expect(checkState(build, [], [at("failure", 1, 10), at("success", 2, 20), at("failure", 3, 20)], ci)).toBe("failed");
  // A newer queued run (no start time yet) is still the current one.
  expect(checkState(build, [], [at("success", 1, 10), at(null, 2, 20, "queued")], ci)).toBe("pending");
  // Another workflow's job of the same name is judged on its own.
  expect(checkState(build, [], [at("failure", 1, 30), at("success", 2, 20)], ci)).toBe("failed");
  // Another App's newer run is not the required App's.
  expect(checkState(build, [], [at("failure", 1, 10), at("success", 2, 40, "completed", 99)], new Map([[10, wf(1)]]))).toBe("failed");
  // An Actions run whose workflow run is not listed (yet) fails closed: pending, whatever it says.
  expect(checkState(build, [], [at("failure", 1, 10), at("success", 2, 20)], new Map())).toBe("pending");
  expect(checkState(build, [], [at("success", 1, 10)], new Map())).toBe("pending");
  // Another App's runs never need a workflow run.
  expect(checkState({ context: "build", app: undefined }, [], [at("success", 1, 40, "completed", 99)], new Map())).toBe("passed");
});

test("an Actions run from an event GitHub does not evaluate counts for nothing", () => {
  const build = { context: "build", app: 15368 };
  const at = (conclusion: string | null, suite: number) => ({ ...run("build", conclusion), check_suite: { id: suite } });
  for (const event of ["workflow_dispatch", "schedule", "repository_dispatch", "workflow_run", "issue_comment", "dynamic"]) {
    const ci = new Map([[10, wf(1)], [20, wf(1, event)]]);
    // A dispatched pass after a pull request's failure neither passes nor supersedes it.
    expect(checkState(build, [], [at("failure", 10), at("success", 20)], ci)).toBe("failed");
    // A dispatched pass alone is missing; a dispatched failure fails nothing.
    expect(checkState(build, [], [at("success", 20)], ci)).toBe("missing");
    expect(checkState(build, [], [at("success", 10), at("failure", 20)], ci)).toBe("passed");
    // A dispatched run still in progress, with or without the job, holds nothing up.
    expect(checkState(build, [], [at("success", 10)], new Map([[10, wf(1)], [20, wf(1, event, false)]]))).toBe("passed");
  }
  for (const event of ["push", "pull_request", "pull_request_review", "pull_request_target", "deployment", "deployment_status"]) {
    expect(checkState(build, [], [at("failure", 10), at("success", 20)], new Map([[10, wf(1)], [20, wf(1, event)]]))).toBe("passed");
  }
});

test("a workflow's newer run without the job is pending while it runs, and missing once it finished", () => {
  const build = { context: "build", app: 15368 };
  const at = (conclusion: string | null, suite: number) => ({ ...run("build", conclusion), check_suite: { id: suite } });
  expect(checkState(build, [], [at("success", 10)], new Map([[10, wf(1)], [20, wf(1, "pull_request", false)]]))).toBe("pending");
  expect(checkState(build, [], [at("failure", 10)], new Map([[10, wf(1)], [20, wf(1, "pull_request", false)]]))).toBe("pending");
  expect(checkState(build, [], [at("success", 10)], new Map([[10, wf(1)], [20, wf(1)]]))).toBe("missing");
  // A passing status does not stand in for the job the workflow's newest run lacks.
  expect(checkState(build, [{ context: "build", state: "success", app_id: 15368 }], [at("success", 10)], new Map([[10, wf(1)], [20, wf(1)]]))).toBe("missing");
  // Another workflow's newer run, or an older one, holds nothing up.
  expect(checkState(build, [], [at("success", 10)], new Map([[10, wf(1)], [20, wf(2, "pull_request", false)]]))).toBe("passed");
  expect(checkState(build, [], [at("success", 20)], new Map([[10, wf(1, "pull_request", false)], [20, wf(1)]]))).toBe("passed");
});

test("a required check passes only when every matching run or status passed", () => {
  const build = { context: "build", app: 15368 };
  expect(checkState(build, [], [run("build", "success")], ONE)).toBe("passed");
  expect(checkState(build, [], [run("build", "skipped"), run("build", "neutral")], ONE)).toBe("passed");
  expect(checkState(build, [], [run("build", "success"), run("build", "failure")], ONE)).toBe("failed");
  expect(checkState(build, [], [run("build", null, 15368, "in_progress")], ONE)).toBe("pending");
  expect(checkState(build, [], [], ONE)).toBe("missing");
  // Another App's run, or a status anyone could set, is not the required App's.
  expect(checkState(build, [{ context: "build", state: "success" }], [run("build", "success", 99)], ONE)).toBe("missing");
  const review = { context: "agent-review", app: undefined };
  expect(checkState(review, [{ context: "agent-review", state: "success" }], [], ONE)).toBe("passed");
  expect(checkState(review, [{ context: "agent-review", state: "failure" }], [], ONE)).toBe("failed");
  expect(checkState(review, [{ context: "agent-review", state: "pending" }], [], ONE)).toBe("pending");
  expect(checkState(review, [{ context: "agent-review", state: "success" }], [run("agent-review", "failure", 1)], ONE)).toBe("failed");
});
