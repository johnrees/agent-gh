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

const run = (name: string, conclusion: string | null, app = 15368, status = "completed") => ({ name, status, conclusion, app: { id: app } });

test("only the newest run of a required check counts, as GitHub judges it", () => {
  const build = { context: "build", app: 15368 };
  const at = (conclusion: string | null, started_at: string, id: number, status = "completed") => ({ ...run("build", conclusion, 15368, status), started_at, id });
  // penmon #387: the draft's run failed, the ready run passed.
  expect(checkState(build, [], [at("failure", "2026-10-15T14:20:56Z", 1), at("success", "2026-10-15T14:23:57Z", 2)])).toBe("passed");
  expect(checkState(build, [], [at("success", "2026-10-15T14:20:56Z", 1), at("failure", "2026-10-15T14:23:57Z", 2)])).toBe("failed");
  expect(checkState(build, [], [at("success", "2026-10-15T14:20:56Z", 1), at(null, "2026-10-15T14:23:57Z", 2, "in_progress")])).toBe("pending");
  // Same start: the later id wins; another App's newer run is not the required App's.
  expect(checkState(build, [], [at("failure", "2026-10-15T14:20:56Z", 1), at("success", "2026-10-15T14:20:56Z", 2)])).toBe("passed");
  expect(checkState(build, [], [at("failure", "2026-10-15T14:20:56Z", 1), { ...at("success", "2026-10-15T14:23:57Z", 2), app: { id: 99 } }])).toBe("failed");
});

test("a required check passes only when every matching run or status passed", () => {
  const build = { context: "build", app: 15368 };
  expect(checkState(build, [], [run("build", "success")])).toBe("passed");
  expect(checkState(build, [], [run("build", "skipped"), run("build", "neutral")])).toBe("passed");
  expect(checkState(build, [], [run("build", "success"), run("build", "failure")])).toBe("failed");
  expect(checkState(build, [], [run("build", null, 15368, "in_progress")])).toBe("pending");
  expect(checkState(build, [], [])).toBe("missing");
  // Another App's run, or a status anyone could set, is not the required App's.
  expect(checkState(build, [{ context: "build", state: "success" }], [run("build", "success", 99)])).toBe("missing");
  const review = { context: "agent-review", app: undefined };
  expect(checkState(review, [{ context: "agent-review", state: "success" }], [])).toBe("passed");
  expect(checkState(review, [{ context: "agent-review", state: "failure" }], [])).toBe("failed");
  expect(checkState(review, [{ context: "agent-review", state: "pending" }], [])).toBe("pending");
  expect(checkState(review, [{ context: "agent-review", state: "success" }], [run("agent-review", "failure", 1)])).toBe("failed");
});
