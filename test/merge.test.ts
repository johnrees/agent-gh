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

test("a newer run of the same workflow supersedes an older one; other workflows still count", () => {
  const build = { context: "build", app: 15368 };
  const at = (conclusion: string | null, id: number, suite: number, status = "completed", app = 15368) => ({ ...run("build", conclusion, app, status), id, check_suite: { id: suite } });
  const ci = new Map([[10, 1], [20, 1], [30, 2]]); // suites 10 and 20 ran workflow 1, suite 30 workflow 2
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
  // Suites with no known workflow never supersede each other.
  expect(checkState(build, [], [at("failure", 1, 10), at("success", 2, 20)])).toBe("failed");
  // Another App's newer run is not the required App's.
  expect(checkState(build, [], [at("failure", 1, 10), at("success", 2, 20, "completed", 99)], ci)).toBe("failed");
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
