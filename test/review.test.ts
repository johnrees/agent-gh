import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Failure } from "../src/failure.ts";
import {
  apiCall,
  apiMerge,
  authorFamily,
  diffLines,
  effortFor,
  graphqlMergeIds,
  labelMatches,
  mergeCommand,
  outputTail,
  parseMarker,
  parseReviewConfig,
  readyTarget,
  reviewerFor,
  reviewed,
  reviewMarker,
  reviewState,
  waivedBy,
} from "../src/review.ts";
import {
  authoredBy,
  dispatchGh,
  fullCommand,
  gateReady,
  type GhDispatch,
  inClone,
  pullDiff,
  type ReviewIo,
  reviewerEnv,
  reviewFull,
  reviewSweep,
  runChecks,
  spawnCheck,
  spawnReviewer,
  sweepCommand,
} from "../src/review-run.ts";
import { fakeGitHub, reply } from "./fake-github.ts";
import { parseRepo, repoFlag, slug } from "../src/repo.ts";

/** The issue's example config: Codex and Claude reviewers, effort from the ticket's labels. */
const EXAMPLE = {
  reviewers: { codex: { model: "gpt-6-astra" }, claude: { model: "claude-opus-5-5" } },
  effort: {
    default: "high",
    rules: [
      { labels: ["model:fable-*"], effort: "xhigh" },
      { labels: ["model:opus-*", "effort:xhigh"], effort: "xhigh" },
      { labels: ["model:opus-*", "effort:max"], effort: "xhigh" },
    ],
  },
  checklist: "docs/agents/review-checklist.md",
  waiver_label: "review-waived",
  checks: ["make check", "make lint"],
};
const config = parseReviewConfig(JSON.stringify(EXAMPLE));

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof Failure) return error.detail;
    throw error;
  }
  throw new Error("expected a refusal");
};

test("effort follows the first rule whose patterns all match the ticket's labels", () => {
  expect(effortFor(config, ["wayfinder:task", "model:fable-astra", "effort:medium"])).toBe("xhigh");
  expect(effortFor(config, ["model:opus-sol", "effort:xhigh"])).toBe("xhigh");
  expect(effortFor(config, ["model:opus-sol", "effort:max"])).toBe("xhigh");
  expect(effortFor(config, ["model:opus-sol", "effort:high"])).toBe("high");
  expect(effortFor(config, ["model:sonnet-luna", "effort:xhigh"])).toBe("high");
  expect(effortFor(config, [])).toBe("high");
  expect(labelMatches("model:fable-*", "model:fable-astra")).toBe(true);
  expect(labelMatches("model:fable-*", "xmodel:fable-astra")).toBe(false);
  expect(labelMatches("a.b", "axb")).toBe(false);
});

test("the reviewer is always another family than the session's", () => {
  expect(reviewerFor(config, "claude")).toEqual({ family: "codex", model: "gpt-6-astra" });
  expect(reviewerFor(config, "codex")).toEqual({ family: "claude", model: "claude-opus-5-5" });
  expect(reviewerFor(config, "glm")).toEqual({ family: "codex", model: "gpt-6-astra" });
  const codexOnly = parseReviewConfig(JSON.stringify({ reviewers: { codex: { model: "gpt-6-astra" } } }));
  expect(refusal(() => reviewerFor(codexOnly, "codex"))).toContain("and codex's work needs another family's review");
});

test("a config with a typo is refused with the field to fix, and defaults fill what is left out", () => {
  expect(refusal(() => parseReviewConfig("{"))).toBe(".github/agent-review.json is not valid JSON");
  expect(refusal(() => parseReviewConfig(JSON.stringify({ reviewers: { gemini: { model: "x" } } })))).toContain("reviewers.gemini is not a reviewer");
  expect(refusal(() => parseReviewConfig(JSON.stringify({ ...EXAMPLE, effort: { default: "huge" } })))).toContain("effort.default must be one of");
  expect(refusal(() => parseReviewConfig(JSON.stringify({ ...EXAMPLE, waiver: "x" })))).toContain("unknown key waiver");
  expect(refusal(() => parseReviewConfig(JSON.stringify({ reviewers: {} })))).toContain("names no reviewer");
  const minimal = parseReviewConfig(JSON.stringify({ reviewers: { codex: { model: "gpt-6-astra" } } }));
  expect(minimal).toMatchObject({ effort: { default: "high", rules: [] }, checklist: undefined, waiverLabel: "review-waived", checks: [] });
  expect(refusal(() => parseReviewConfig(JSON.stringify({ ...EXAMPLE, checks: "make check" })))).toContain("checks must be a list");
  expect(minimal).toMatchObject({ blockOn: "changes_requested", checksOutputLines: 60, postChecksOutput: false, checksTimeoutMinutes: 30 });
  expect(parseReviewConfig(JSON.stringify({ ...EXAMPLE, post_checks_output: true, checks_timeout_minutes: 90 }))).toMatchObject({ postChecksOutput: true, checksTimeoutMinutes: 90 });
  expect(refusal(() => parseReviewConfig(JSON.stringify({ ...EXAMPLE, post_checks_output: "yes" })))).toContain("post_checks_output must be true or false");
  expect(refusal(() => parseReviewConfig(JSON.stringify({ ...EXAMPLE, checks_timeout_minutes: 0 })))).toContain("checks_timeout_minutes must be a whole number from 1 to 1440");
  expect(parseReviewConfig(JSON.stringify({ ...EXAMPLE, block_on: "changes_requested", checks_output_lines: 0 }))).toMatchObject({ blockOn: "changes_requested", checksOutputLines: 0 });
  expect(refusal(() => parseReviewConfig(JSON.stringify({ ...EXAMPLE, block_on: "nothing" })))).toBe('.github/agent-review.json: block_on must be "changes_requested"');
  expect(refusal(() => parseReviewConfig(JSON.stringify({ ...EXAMPLE, checks_output_lines: -1 })))).toContain("checks_output_lines must be a whole number");
});

test("the status follows the verdict: the block_on verdict fails it", () => {
  expect(reviewState("changes_requested", "changes_requested")).toBe("failure");
  expect(reviewState("approve", "changes_requested")).toBe("success");
});

test("the review marker is one JSON object a workflow can read back, and a malformed one reads as none", () => {
  const marker = { v: 1, head: HEAD, merge_base: OLD, patch_id: "c".repeat(40), verdict: "approve", checks: "not run", reviewer: "claude" } as const;
  const body = `${reviewMarker(marker)}\n**agent-review** of aaaaaaaa: approve`;
  expect(body.split("\n")[0]).toBe(`<!-- agent-review {"v":1,"head":"${HEAD}","merge_base":"${OLD}","patch_id":"${"c".repeat(40)}","verdict":"approve","checks":"not run","reviewer":"claude"} -->`);
  expect(parseMarker(body)).toEqual(marker);
  expect(parseMarker(reviewMarker({ ...marker, patch_id: null }))?.patch_id).toBeNull();
  expect(parseMarker("<!-- agent-review -->")).toBeUndefined();
  expect(parseMarker(reviewMarker({ ...marker, head: "abc" }))).toBeUndefined();
  expect(parseMarker(reviewMarker({ ...marker, verdict: "maybe" } as never))).toBeUndefined();
});

test("a review comment can go on any new-side line a diff hunk shows, context included", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -10,4 +10,4 @@ fn", " ten", "-old", "+new", "++++ added, not a header", " thirteen",
    "diff --git a/gone.ts b/gone.ts", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
    "diff --git a/new.ts b/new.ts", "--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1,2 @@", "+a", "+b", "\\ No newline at end of file",
  ].join("\n");
  expect(diffLines(diff)).toEqual(new Map([["x.ts", new Set([10, 11, 12, 13])], ["new.ts", new Set([1, 2])]]));
});

test("the checks' output tail keeps the configured number of last lines, without colours", () => {
  expect(outputTail("a\nb\nc\n\n", 2)).toBe("b\nc");
  expect(outputTail("\u001b[1;32mok\u001b[0m\r\n", 5)).toBe("ok");
  expect(outputTail("a\nb", 0)).toBe("");
  expect(outputTail("x".repeat(30_000), 1)).toHaveLength(20_001);
});

test("the author family is the one App every head commit credits", () => {
  const bots = { claude: "johnrees-claude[bot]", codex: "johnrees-codex[bot]" };
  expect(authorFamily([[bot("claude")], ["Jo <j@example.com>", bot("claude")]], bots)).toBe("claude");
  expect(authorFamily([[bot("claude")], [bot("codex")]], bots)).toBeUndefined();
  expect(authorFamily([[bot("claude"), bot("codex")]], bots)).toBeUndefined();
  expect(authorFamily([[bot("claude")], []], bots)).toBeUndefined();
  expect(authorFamily([], bots)).toBeUndefined();
  expect(authorFamily([["johnrees-claude[bot]-not <x@example.com>"]], bots)).toBeUndefined();
});

const labeled = (login: string, app: unknown, event = "labeled", name = "review-waived") => ({
  event,
  label: { name },
  actor: { login },
  performed_via_github_app: app,
});

test("only a person's waiver label counts, and removing it withdraws the waiver", () => {
  expect(waivedBy([labeled("johnrees", null)], "review-waived")).toBe("johnrees");
  expect(waivedBy([labeled("johnrees", { slug: "johnrees-claude" })], "review-waived")).toBeUndefined();
  expect(waivedBy([labeled("johnrees", null), labeled("johnrees", null, "unlabeled")], "review-waived")).toBeUndefined();
  expect(waivedBy([labeled("johnrees", { slug: "johnrees-claude" }), labeled("johnrees", null, "unlabeled"), labeled("johnrees", null)], "review-waived")).toBe("johnrees");
  expect(waivedBy([labeled("johnrees", null, "labeled", "bug")], "review-waived")).toBeUndefined();
});

test("gh pr ready names its pull request as gh does, and --undo is not gated", () => {
  expect(readyTarget(["pr", "ready"])).toEqual({ branch: undefined });
  expect(readyTarget(["-R", "o/r", "pr", "ready", "12"])).toEqual({ number: 12 });
  expect(readyTarget(["--repo=o/r", "pr", "ready"])).toEqual({ branch: undefined });
  expect(readyTarget(["pr", "ready", "https://github.com/other/place/pull/9"])).toEqual({ number: 9, repo: "other/place" });
  expect(readyTarget(["pr", "ready", "12"])).toEqual({ number: 12 });
  expect(readyTarget(["pr", "ready", "#12"])).toEqual({ number: 12 });
  expect(readyTarget(["pr", "ready", "contributor:feature"])).toEqual({ branch: "contributor:feature" });
  expect(readyTarget(["pr", "ready", "-R", "o/r", "https://github.com/o/r/pull/34"])).toEqual({ number: 34, repo: "o/r" });
  expect(readyTarget(["pr", "ready", "feature/x"])).toEqual({ branch: "feature/x" });
  expect(readyTarget(["pr", "ready", "12", "--undo"])).toBeUndefined();
  expect(readyTarget(["pr", "ready", "12", "--undo=true"])).toBeUndefined();
  // gh's last --undo wins.
  expect(readyTarget(["pr", "ready", "12", "--undo", "--undo=false"])).toEqual({ number: 12 });
  expect(repoFlag(["-R", "o/first", "pr", "ready", "12", "--repo=o/last"])).toBe("o/last");
  expect(repoFlag(["pr", "ready", "-R", "o/r", "--", "-R", "o/not"])).toBe("o/r");
  expect(readyTarget(["pr", "view", "12"])).toBeUndefined();
  expect(reviewed({ statuses: [{ context: "agent-review", state: "success" }] })).toBe(true);
  expect(reviewed({ statuses: [{ context: "agent-review", state: "pending" }, { context: "ci", state: "success" }] })).toBe(false);
});

test("the reviewer does not inherit the caller's harness", () => {
  const env = reviewerEnv({ CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", AGENT_GH_MODEL: "x", CODEX_THREAD_ID: "t", PATH: "/bin", HOME: "/h" });
  expect(env).toEqual({ PATH: "/bin", HOME: "/h", MISE_QUIET: "1" });
});

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const REPO = "/repos/johnrees/widget";
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

type World = {
  head?: string;
  labels?: string[];
  /** The labels every later read of the pull request sees, as when John adds one during a review. */
  labelsLater?: string[];
  status?: { context: string; state: string; description?: string }[];
  events?: unknown[];
  optedIn?: boolean;
  config?: unknown;
  answer?: unknown;
  /** Whether the branch has an upstream (whose pull request is #12). */
  upstream?: boolean;
  /** The open pull requests GitHub lists for HEAD's commit. */
  commitPulls?: unknown[];
  /** The open pull requests for a branch lookup. */
  branchPulls?: unknown[];
  family?: string;
  /** The repository of the issue #7 the pull request closes. */
  closes?: string;
  /** Each head commit's Co-authored-by values. */
  coAuthors?: string[][];
  /** The checks' results, in the order they run; any more pass. */
  checkResults?: { code: number; output: string; timedOut?: boolean }[];
  /** The statuses GitHub answers a posted review with, in order. */
  reviewReplies?: number[];
  /** The base branch's rules (rulesets), its branch record (classic protection), and the head's check runs. */
  rules?: unknown[];
  branch?: unknown;
  checkRuns?: unknown[];
};

const bot = (family: string) => `johnrees-${family}[bot] <1+johnrees-${family}[bot]@users.noreply.github.com>`;

/** The pull request's diff: src/a.ts's lines 1 to 4 are on it. */
const DIFF = "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n one\n+two\n three\n four";
const PATCH_ID = "c".repeat(40);

/** A pull request #12 on johnrees/widget, closing issue #7, in a fake GitHub and a fake reviewer. */
const world = ({
  head = HEAD, labels = [], labelsLater, status = [], events = [], optedIn = true, config = EXAMPLE, answer, closes = "johnrees/widget", upstream = true,
  commitPulls = [{ number: 12, state: "open", head: { sha: HEAD } }], branchPulls = [{ number: 12, state: "open" }], family = "claude",
  coAuthors = [[bot("claude")], [bot("claude")]], checkResults = [], reviewReplies = [], rules = [], branch = { protected: false }, checkRuns = [],
}: World = {}) => {
  let pullReads = 0;
  const reviewStatuses = [...reviewReplies];
  const fake = fakeGitHub({
    [`GET ${REPO}/pulls/12`]: () => {
      const names = pullReads++ === 0 ? labels : (labelsLater ?? labels);
      return reply(200, { state: "open", title: "Do it", body: "Closes #7.", head: { sha: head }, base: { ref: "main" }, labels: names.map((name) => ({ name })) });
    },
    [`GET ${REPO}/pulls`]: () => reply(200, branchPulls),
    [`GET ${REPO}/commits/${HEAD}/pulls`]: () => reply(200, commitPulls),
    [`GET ${REPO}`]: () => reply(200, { default_branch: "main" }),
    [`GET ${REPO}/contents/.github/agent-review.json`]: () =>
      optedIn ? reply(200, { content: Buffer.from(JSON.stringify(config)).toString("base64") }) : reply(404, {}),
    // The pull request's own merge base; origin's (below) would be a fork's.
    [`GET ${REPO}/compare/main...${HEAD}`]: () => reply(200, { merge_base_commit: { sha: OLD } }),
    [`GET ${REPO}/commits/${head}/status`]: () => reply(200, { state: "success", statuses: status }),
    [`GET ${REPO}/commits/${head}/check-runs`]: (_, url) =>
      reply(200, { check_runs: checkRuns.filter((run) => (run as { name: string }).name === url.searchParams.get("check_name")) }),
    [`GET ${REPO}/rules/branches/main`]: () => reply(200, rules),
    [`GET ${REPO}/branches/main`]: () => reply(200, branch),
    [`GET ${REPO}/issues/12/events`]: () => reply(200, events),
    "POST /graphql": (body) =>
      body.includes("node(id")
        ? reply(200, { data: { node: JSON.parse(body).variables.id === "PR_12" ? { number: 12, repository: { nameWithOwner: "johnrees/widget" } } : {} } })
        : reply(200, { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 7, repository: { nameWithOwner: closes } }] } } } } }),
    [`GET ${REPO}/issues/7`]: () => reply(200, { title: "The ticket", body: "Do it well.", labels: [{ name: "model:fable-astra" }], comments: 1 }),
    [`GET ${REPO}/issues/7/comments`]: () => reply(200, [{ body: "Last word." }]),
    ["GET /repos/johnrees/tracker/issues/7"]: () => reply(200, { title: "Elsewhere", body: "Tracked elsewhere.", labels: [{ name: "model:opus-sol" }], comments: 0 }),
    [`POST ${REPO}/pulls/12/reviews`]: () => reply(reviewStatuses.shift() ?? 200, {}),
    [`POST ${REPO}/statuses/${HEAD}`]: () => reply(201, {}),
  });
  stops.push(fake.stop);
  const commands: { command: readonly string[]; stdin: string; cwd: string }[] = [];
  const gitCalls: string[] = [];
  const checks: { command: string; cwd: string; timeoutMs: number }[] = [];
  const steps: string[] = [];
  const printed: string[] = [];
  let output = "";
  const io: ReviewIo = {
    api: fake.api,
    token: "ghu_test",
    repo: { owner: "johnrees", name: "widget" },
    family,
    git: async (args, input) => {
      if (args[0] === "rev-parse" && args.at(-1) === "HEAD" && args.length === 2) return HEAD;
      if (args[0] === "rev-parse" && args.includes("@{upstream}")) return upstream ? "origin/feature" : undefined;
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return upstream ? "feature" : "HEAD";
      if (args[0] === "rev-parse" && args.includes("--git-common-dir")) return "/work/widget/.git";
      if (args[0] === "fetch") return args.at(-1) === "+refs/heads/main:refs/remotes/origin/main" ? "" : undefined;
      if (args[0] === "clone" || args[0] === "-C") {
        gitCalls.push(args.join(" "));
        steps.push(`git ${args[0] === "-C" ? args[2] : args[0]}`);
        return "";
      }
      if (args[0] === "log" && args.at(-1) === `${OLD}..${HEAD}`) return coAuthors.map((values) => `${values.join("\x1f")}\x1e`).join("\n");
      if (args[0] === "diff" && args.at(-2) === OLD && args.at(-1) === HEAD) return DIFF;
      if (args[0] === "patch-id") return input === `${DIFF}\n` ? `${PATCH_ID} ${"0".repeat(40)}` : undefined;
      if (args[0] === "merge-base") return "f".repeat(40);
      if (args[0] === "cat-file") return args.at(-1) === `${OLD}^{commit}` ? "" : undefined;
      return undefined;
    },
    runCheck: async (command, cwd, timeoutMs) => {
      checks.push({ command, cwd, timeoutMs });
      steps.push(`check ${command}`);
      const result = checkResults.shift() ?? { code: 0, output: `${command}: ok\n` };
      return { timedOut: false, ...result };
    },
    runReviewer: async (command, stdin, cwd) => {
      commands.push({ command, stdin, cwd });
      steps.push("reviewer");
      if (command[0] === "claude") return { code: 0, stdout: JSON.stringify({ type: "result", result: "", structured_output: answer }) };
      const out = command[command.indexOf("-o") + 1];
      if (out !== undefined) await Bun.write(out, typeof answer === "string" ? answer : JSON.stringify(answer));
      return { code: 0, stdout: "" };
    },
    readFile: (path) => Bun.file(path).text(),
    tempDir: () => mkdtempSync(join(tmpdir(), "agent-gh-review-test-")),
    print: (line) => printed.push(line),
    out: (text) => {
      output += text;
    },
  };
  return { fake, io, commands, gitCalls, checks, steps, printed, output: () => output };
};

const posted = (fake: ReturnType<typeof world>["fake"], path: string) =>
  fake.log.filter((entry) => entry.method === "POST" && entry.path === path).map((entry) => JSON.parse(entry.body) as Record<string, unknown>);

const gateRefusal = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof Failure) return error.detail;
    throw error;
  }
  throw new Error("expected the gate to refuse");
};

test("the gate refuses gh pr ready until the head is reviewed, and passes once it is", async () => {
  const unreviewed = world();
  expect(await gateRefusal(gateReady(unreviewed.io, { number: 12 }))).toBe(
    "pull request #12's head aaaaaaaa has no agent-review status; run `agent-gh review full` on it (it reviews the pushed head), or ask John to add the `review-waived` label",
  );
  await gateReady(world({ status: [{ context: "agent-review", state: "success" }] }).io, { number: 12 });
  // The current branch's pull request, through its upstream.
  await gateReady(world({ status: [{ context: "agent-review", state: "success" }] }).io, { branch: undefined });
});

test("a review that requested changes blocks gh pr ready, naming the verdict and the next step", async () => {
  const blocked = world({ status: [{ context: "agent-review", state: "failure", description: "changes requested; checks passed: 2 finding(s) by gpt-6-astra at high" }] });
  expect(await gateRefusal(gateReady(blocked.io, { number: 12 }))).toBe(
    "pull request #12's head aaaaaaaa was reviewed and blocked (changes requested; checks passed: 2 finding(s) by gpt-6-astra at high); answer each finding on the pull request, push a fix, and run `agent-gh review full` on the new head, or ask John to add the `review-waived` label",
  );
  // John's waiver still passes it.
  await gateReady(world({ status: [{ context: "agent-review", state: "failure" }], labels: ["review-waived"], events: [labeled("johnrees", null)] }).io, { number: 12 });
});

test("a commit pushed after the review blocks gh pr ready again", async () => {
  // The status is on HEAD; the pull request's head moved to OLD, which has none.
  const moved = world({ head: OLD });
  expect(await gateRefusal(gateReady(moved.io, { number: 12 }))).toContain("head bbbbbbbb has no agent-review status");
});

test("a repository without the config is not gated", async () => {
  const { fake, io } = world({ optedIn: false });
  await gateReady(io, { number: 12 });
  expect(fake.log.some((entry) => entry.path.endsWith("/status"))).toBe(false);
});

test("a person's waiver label passes the gate; an App's does not", async () => {
  const person = world({ labels: ["review-waived"], events: [labeled("johnrees", null)] });
  await gateReady(person.io, { number: 12 });
  expect(person.printed).toEqual(["agent-gh: the review of #12 was waived by johnrees"]);
  const app = world({ labels: ["review-waived"], events: [labeled("johnrees", { slug: "johnrees-claude" })] });
  expect(await gateRefusal(gateReady(app.io, { number: 12 }))).toContain("has no agent-review status");
});

test("a full review runs the checks itself in a clone of the head, then the author's other family read-only, and posts a review and a status that follow the verdict", async () => {
  const answer = {
    verdict: "changes_requested",
    spec: "Mostly done.",
    findings: [
      { priority: "P2", kind: "tests", file: "src/a.ts", line: 3, summary: "Untested branch.", scenario: "Deleting it passes every test." },
      { priority: "P1", kind: "defect", file: "src/b.ts", line: 9, summary: "Off by one.", scenario: "An empty list reads past its end." },
    ],
  };
  const { fake, io, commands, gitCalls, checks, steps, output } = world({ answer });
  await reviewFull(io, {});
  expect(commands).toHaveLength(1);
  const [{ command, stdin, cwd }] = commands as [{ command: readonly string[]; stdin: string; cwd: string }];
  // agent-gh runs the checks before the reviewer, in the same throwaway clone; the reviewer only reads.
  expect(steps).toEqual(["git clone", "git checkout", "check make check", "check make lint", "git reset", "git clean", "reviewer"]);
  expect(checks).toEqual([{ command: "make check", cwd, timeoutMs: 1_800_000 }, { command: "make lint", cwd, timeoutMs: 1_800_000 }]);
  expect(gitCalls[0]).toBe(`clone -q --shared --no-checkout /work/widget/.git ${cwd}`);
  expect(gitCalls[1]).toBe(`-C ${cwd} checkout -q --detach ${HEAD}`);
  expect(command.slice(0, 8)).toEqual(["codex", "exec", "-m", "gpt-6-astra", "-c", 'model_reasoning_effort="xhigh"', "-s", "read-only"]);
  expect(command).not.toContain("workspace-write");
  // The merge base is the pull request's, from GitHub, not origin's.
  expect(stdin).toContain(`git diff ${OLD}...${HEAD}`);
  expect(stdin).toContain("# Issue #7: The ticket\nLabels: model:fable-astra\n\nDo it well.\n\n## Last comment\n\nLast word.");
  expect(stdin).toContain("Apply each section of docs/agents/review-checklist.md");
  expect(stdin).toContain("agent-gh ran the repository's checks on the reviewed commit before you started: checks passed.\nThe last lines of their output:\n```\n$ make check\nmake check: ok\n$ make lint\nmake lint: ok\n```");
  expect(stdin).toContain("You are read-only");
  expect(JSON.parse(output())).toEqual(answer);
  expect(posted(fake, `${REPO}/issues/12/comments`)).toEqual([]);
  const [review] = posted(fake, `${REPO}/pulls/12/reviews`);
  expect(review).toMatchObject({ commit_id: HEAD, event: "COMMENT" });
  // The finding on a line of the diff goes on that line; the other is in the body.
  expect(review?.comments).toEqual([{ path: "src/a.ts", line: 3, side: "RIGHT", body: "**P2 tests**: Untested branch.\n\nDeleting it passes every test." }]);
  const body = review?.body as string;
  expect(parseMarker(body)).toEqual({ v: 1, head: HEAD, merge_base: OLD, patch_id: PATCH_ID, verdict: "changes_requested", checks: "passed", reviewer: "codex" });
  expect(body).toContain("**agent-review** of aaaaaaaa against #7 by gpt-6-astra (codex) at xhigh: changes requested; checks passed");
  expect(body).toContain("1 finding(s) are on their lines.\n\nOn lines outside the diff:\n- **P1 defect** `src/b.ts:9`: Off by one.");
  expect(body).not.toContain("src/a.ts:3");
  expect(posted(fake, `${REPO}/statuses/${HEAD}`)).toEqual([
    { state: "failure", context: "agent-review", description: "changes requested; checks passed: 2 finding(s) by gpt-6-astra at xhigh" },
  ]);
});

test("an approving review sets a successful status", async () => {
  const w = world({ answer: { verdict: "approve", spec: "Done.", findings: [] } });
  await reviewFull(w.io, {});
  expect(posted(w.fake, `${REPO}/statuses/${HEAD}`)).toEqual([
    { state: "success", context: "agent-review", description: "approved; checks passed: 0 finding(s) by gpt-6-astra at xhigh" },
  ]);
  expect(posted(w.fake, `${REPO}/pulls/12/reviews`)[0]?.comments).toEqual([]);
});

test("a failing check stops the rest, and the reviewer, the review, and the status say so", async () => {
  const noisy = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
  const w = world({
    config: { ...EXAMPLE, checks_output_lines: 3 },
    checkResults: [{ code: 2, output: `${noisy}\n\u001b[31merror: it broke\u001b[0m\n` }],
    answer: { verdict: "changes_requested", spec: "Broken.", findings: [] },
  });
  await reviewFull(w.io, {});
  expect(w.checks.map((check) => check.command)).toEqual(["make check"]);
  const [{ stdin }] = w.commands as [{ command: readonly string[]; stdin: string; cwd: string }];
  expect(stdin).toContain("checks failed (`make check` exited 2).\nThe last lines of their output:\n```\nline 28\nline 29\nerror: it broke\n```\nReport a failure as a finding where the change causes it.");
  const body = posted(w.fake, `${REPO}/pulls/12/reviews`)[0]?.body as string;
  expect(body).toContain("changes requested; checks failed (`make check` exited 2)");
  // The output can carry the machine's environment, so it reaches the pull request only when the repository opts in.
  expect(body).not.toContain("it broke");
  expect(body).not.toContain("<details>");
  expect(parseMarker(body)?.checks).toBe("failed");
  expect(posted(w.fake, `${REPO}/statuses/${HEAD}`)[0]?.description).toBe("changes requested; checks failed (`make check` exited 2): 0 finding(s) by gpt-6-astra at xhigh");
});

test("a repository that opts in shows the checks' output tail on the review", async () => {
  const w = world({
    config: { ...EXAMPLE, checks_output_lines: 2, post_checks_output: true },
    checkResults: [{ code: 1, output: "one\ntwo\nthree\n" }],
    answer: { verdict: "changes_requested", spec: "Broken.", findings: [] },
  });
  await reviewFull(w.io, {});
  expect(posted(w.fake, `${REPO}/pulls/12/reviews`)[0]?.body).toContain("<details><summary>Checks output (last lines)</summary>\n\n```\ntwo\nthree\n```");
});

test("a check that runs out of time stops the rest; the checks count as timed out and the reviewer still runs", async () => {
  const w = world({
    config: { ...EXAMPLE, checks_timeout_minutes: 5 },
    checkResults: [{ code: 137, output: "compiling\n", timedOut: true }],
    answer: { verdict: "approve", spec: "Fine.", findings: [] },
  });
  await reviewFull(w.io, {});
  expect(w.checks).toEqual([{ command: "make check", cwd: w.commands[0]?.cwd as string, timeoutMs: 300_000 }]);
  expect(w.commands[0]?.stdin).toContain("checks timed out (`make check` ran over 5 min).\nThe last lines of their output:\n```\n$ make check\ncompiling\n```\nReport a failure");
  expect(parseMarker(posted(w.fake, `${REPO}/pulls/12/reviews`)[0]?.body as string)?.checks).toBe("timed out");
  expect(posted(w.fake, `${REPO}/statuses/${HEAD}`)[0]?.description).toBe("approved; checks timed out (`make check` ran over 5 min): 0 finding(s) by gpt-6-astra at xhigh");
});

test("a repository with no checks reviews with checks not run", async () => {
  const w = world({ config: { ...EXAMPLE, checks: undefined }, answer: { verdict: "approve", spec: "Done.", findings: [] } });
  await reviewFull(w.io, {});
  expect(w.steps).toEqual(["git clone", "git checkout", "reviewer"]);
  expect(w.commands[0]?.stdin).toContain("The repository configures no checks, so none ran.");
  expect(posted(w.fake, `${REPO}/statuses/${HEAD}`)[0]).toMatchObject({ state: "success", description: "approved; checks not run: 0 finding(s) by gpt-6-astra at xhigh" });
});

test("a line GitHub refuses moves every finding into the review's body instead of failing", async () => {
  const answer = { verdict: "approve", spec: "Done.", findings: [{ priority: "P3", kind: "standards", file: "src/a.ts", line: 2, summary: "Naming.", scenario: "Reads oddly." }] };
  const w = world({ answer, reviewReplies: [422, 200] });
  await reviewFull(w.io, {});
  const [first, second] = posted(w.fake, `${REPO}/pulls/12/reviews`);
  expect(first?.comments).toHaveLength(1);
  expect(second?.comments).toEqual([]);
  expect(second?.body).toContain("- **P3 standards** `src/a.ts:2`: Naming.");
  expect(parseMarker(second?.body as string)?.verdict).toBe("approve");
  expect(w.printed).toContain("agent-gh: GitHub refused a finding's line, so every finding is in the review's body");
  expect(posted(w.fake, `${REPO}/statuses/${HEAD}`)).toHaveLength(1);
});

test("the reviewer is from another family than the head commits' co-author, else the session's, and says which", async () => {
  const approve = { verdict: "approve", spec: "Done.", findings: [] };
  // A Claude session reviewing Codex's commits runs Claude.
  const codexWork = world({ coAuthors: [[bot("codex")], ["Someone <s@example.com>", bot("codex")]], answer: approve });
  await reviewFull(codexWork.io, {});
  expect(codexWork.commands[0]?.command[0]).toBe("claude");
  expect(codexWork.printed).toContain("agent-gh: the head commits credit johnrees-codex[bot], so this is codex's work");
  expect(parseMarker(posted(codexWork.fake, `${REPO}/pulls/12/reviews`)[0]?.body as string)?.reviewer).toBe("claude");
  for (const coAuthors of [[[bot("codex")], [bot("claude")]], [[bot("codex")], []], []]) {
    const mixed = world({ coAuthors, answer: approve, family: "codex" });
    await reviewFull(mixed.io, {});
    expect(mixed.commands[0]?.command[0]).toBe("claude");
    expect(mixed.printed).toContain("agent-gh: the head commits credit no single family App as co-author, so this is taken as this session's (codex) work");
  }
});

test("a waiver John adds while the review runs is never overwritten by the verdict", async () => {
  const w = world({ labelsLater: ["review-waived"], events: [labeled("johnrees", null)], answer: { verdict: "changes_requested", spec: "No.", findings: [] } });
  await reviewFull(w.io, {});
  expect(w.commands).toHaveLength(1);
  expect(posted(w.fake, `${REPO}/pulls/12/reviews`)).toHaveLength(1);
  expect(posted(w.fake, `${REPO}/statuses/${HEAD}`)).toEqual([{ state: "success", context: "agent-review", description: "waived by johnrees" }]);
});

test("a full review refuses a HEAD that is not the pushed head, and a waiver needs no reviewer", async () => {
  const behind = world({ head: OLD });
  expect(await gateRefusal(reviewFull(behind.io, {}))).toBe(
    "HEAD is not pull request #12's head (bbbbbbbb); push your commits or check out its head, then review",
  );
  expect(behind.commands).toEqual([]);
  const waived = world({ labels: ["review-waived"], events: [labeled("johnrees", null)] });
  await reviewFull(waived.io, {});
  expect(waived.commands).toEqual([]);
  expect(posted(waived.fake, `${REPO}/statuses/${HEAD}`)).toEqual([{ state: "success", context: "agent-review", description: "waived by johnrees" }]);
});

test("a malformed answer fails the review and sets no status", async () => {
  const { fake, io } = world({ answer: { verdict: "approve" } });
  expect(await gateRefusal(reviewFull(io, {}))).toBe("the reviewer's answer has no spec summary");
  expect(posted(fake, `${REPO}/statuses/${HEAD}`)).toEqual([]);
});

test("an issue closed in another repository is the ticket, with its own labels", async () => {
  const answer = { verdict: "approve", spec: "Done.", findings: [] };
  const { fake, commands } = await (async () => {
    const w = world({ closes: "johnrees/tracker", answer });
    await reviewFull(w.io, {});
    return w;
  })();
  const [{ command, stdin }] = commands as [{ command: readonly string[]; stdin: string; cwd: string }];
  expect(command).toContain('model_reasoning_effort="high"');
  expect(stdin).toContain("# Issue johnrees/tracker#7: Elsewhere\nLabels: model:opus-sol");
  expect(posted(fake, `${REPO}/pulls/12/reviews`)[0]?.body).toContain("against johnrees/tracker#7 by");
});

test("a selector the gate cannot resolve fails closed in an opted-in repository, and passes elsewhere", async () => {
  const opted = world({ branchPulls: [] });
  expect(await gateRefusal(gateReady(opted.io, { branch: "contributor:feature" }))).toBe("cannot find the pull request `gh pr ready` names; name it by number");
  expect(opted.fake.log.some((entry) => entry.path === `${REPO}/pulls` )).toBe(true);
  await gateReady(world({ branchPulls: [], optedIn: false }).io, { branch: "contributor:feature" });
});

test("gh pr ready runs only after the gate passes, with the gate's token; other commands are not gated", async () => {
  const calls: string[] = [];
  const deps = (io: ReviewIo): GhDispatch => ({
    withToken: async (repo, use) => {
      calls.push(`token ${repo === undefined ? "none" : slug(repo)}`);
      return use({ GH_TOKEN: "t" });
    },
    readFile: async () => undefined,
    io: () => io,
    runWith: async (args, env) => {
      calls.push(`gated gh ${args.join(" ")} ${env.GH_TOKEN}`);
      return 0;
    },
    run: async (args) => {
      calls.push(`gh ${args.join(" ")}`);
      return 0;
    },
  });
  const here = parseRepo("johnrees/widget");
  await gateRefusal(dispatchGh(["pr", "ready", "12"], here, deps(world().io)));
  expect(calls).toEqual(["token johnrees/widget"]);

  calls.length = 0;
  const done = world({ status: [{ context: "agent-review", state: "success" }] }).io;
  expect(await dispatchGh(["-R", "johnrees/widget", "pr", "ready", "12"], here, deps(done))).toBe(0);
  expect(await dispatchGh(["pr", "ready", "12", "--undo"], here, deps(done))).toBe(0);
  expect(await dispatchGh(["pr", "view", "12"], here, deps(done))).toBe(0);
  expect(calls).toEqual(["token johnrees/widget", "gated gh -R johnrees/widget pr ready 12 t", "gh pr ready 12 --undo", "gh pr view 12"]);

  calls.length = 0;
  await dispatchGh(["pr", "ready", "https://github.com/johnrees/widget/pull/12"], parseRepo("someone/else"), deps(done));
  expect(calls[0]).toBe("token johnrees/widget");
});

test("gh pr merge names its pull request as gh does, skipping flag values, and --admin is always seen", () => {
  expect(mergeCommand(["pr", "merge"])).toEqual({ target: { branch: undefined }, admin: false });
  expect(mergeCommand(["pr", "merge", "12", "--squash", "-d"])).toEqual({ target: { number: 12 }, admin: false });
  expect(mergeCommand(["pr", "merge", "-b", "body text", "-t", "subject", "--match-head-commit", HEAD, "#12"])).toEqual({ target: { number: 12 }, admin: false });
  expect(mergeCommand(["pr", "merge", "-sb", "12", "13"])).toEqual({ target: { number: 13 }, admin: false });
  expect(mergeCommand(["pr", "merge", "--body=12", "feature"])).toEqual({ target: { branch: "feature" }, admin: false });
  expect(mergeCommand(["-R", "o/r", "pr", "merge", "https://github.com/o/r/pull/4", "--admin"])).toEqual({ target: { number: 4, repo: "o/r" }, admin: true });
  expect(mergeCommand(["pr", "merge", "12", "--admin=false", "--admin"])?.admin).toBe(true);
  expect(mergeCommand(["pr", "merge", "12", "--admin", "--admin=false"])?.admin).toBe(false);
  expect(mergeCommand(["pr", "merge", "12", "--disable-auto"])).toBeUndefined();
  expect(mergeCommand(["pr", "merge", "12", "--disable-auto", "--admin"])?.admin).toBe(true);
  expect(mergeCommand(["pr", "view", "12"])).toBeUndefined();
});

const REQUIRED = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "build", integration_id: 15368 }, { context: "agent-review" }] } }];
const PASSED = { status: [{ context: "agent-review", state: "success" }], checkRuns: [{ name: "build", status: "completed", conclusion: "success", app: { id: 15368 } }] };

const mergeDeps = (io: ReviewIo, calls: string[], files: Record<string, string> = {}): GhDispatch => ({
  withToken: async (_, use) => use({ GH_TOKEN: "t" }),
  readFile: async (path) => files[path],
  io: () => io,
  runWith: async (args) => {
    calls.push(`gh ${args.join(" ")}`);
    return 0;
  },
  run: async (args) => {
    calls.push(`ungated gh ${args.join(" ")}`);
    return 0;
  },
});

test("an agent's gh pr merge runs only once every check the base branch requires has passed on the head", async () => {
  const here = parseRepo("johnrees/widget");
  const calls: string[] = [];
  const unmet = world({ rules: REQUIRED, status: [{ context: "agent-review", state: "failure" }], checkRuns: [{ name: "build", status: "in_progress", conclusion: null, app: { id: 15368 } }] });
  expect(await gateRefusal(dispatchGh(["pr", "merge", "12", "--squash"], here, mergeDeps(unmet.io, calls)))).toBe(
    "pull request #12's head aaaaaaaa has not passed every check main requires (`build` pending, `agent-review` failed); wait for them to pass, fix what fails, or ask John to merge it",
  );
  const classic = world({ branch: { protection: { required_status_checks: { enforcement_level: "non_admins", contexts: ["lint"], checks: [] } } } });
  expect(await gateRefusal(dispatchGh(["pr", "merge", "12"], here, mergeDeps(classic.io, calls)))).toContain("(`lint` missing)");
  expect(calls).toEqual([]);
  expect(await dispatchGh(["pr", "merge", "12", "--squash"], here, mergeDeps(world({ rules: REQUIRED, ...PASSED }).io, calls))).toBe(0);
  // A base branch that requires nothing holds nothing back.
  expect(await dispatchGh(["pr", "merge"], here, mergeDeps(world().io, calls))).toBe(0);
  expect(calls).toEqual(["gh pr merge 12 --squash", "gh pr merge"]);
});

test("an agent's gh pr merge --admin is always refused, and an unnamed repository fails closed", async () => {
  const calls: string[] = [];
  const passed = world({ rules: REQUIRED, ...PASSED });
  expect(await gateRefusal(dispatchGh(["pr", "merge", "12", "--admin"], parseRepo("johnrees/widget"), mergeDeps(passed.io, calls)))).toContain("an agent never merges with `--admin`");
  expect(await gateRefusal(dispatchGh(["pr", "merge", "12"], undefined, mergeDeps(passed.io, calls)))).toBe("cannot tell which repository `gh pr merge` acts on; pass -R OWNER/REPO");
  expect(await gateRefusal(dispatchGh(["pr", "merge", "elsewhere"], parseRepo("johnrees/widget"), mergeDeps(world({ branchPulls: [] }).io, calls)))).toBe(
    "cannot find the pull request `gh pr merge` names; name it by number",
  );
  expect(calls).toEqual([]);
});

test("gh api's endpoint, method, and fields are read as gh reads them", () => {
  expect(apiCall(["api", "repos/o/r/pulls/1/merge", "-X", "put"])).toEqual({ endpoint: "repos/o/r/pulls/1/merge", method: "PUT", fields: [], input: undefined });
  expect(apiCall(["api", "-XPUT", "/repos/o/r/pulls/1/merge"])?.method).toBe("PUT");
  expect(apiCall(["api", "--method=PUT", "repos/o/r/pulls/1/merge"])?.method).toBe("PUT");
  expect(apiCall(["api", "--method", "PUT", "-H", "Accept: x", "repos/o/r/pulls/1/merge"])?.endpoint).toBe("repos/o/r/pulls/1/merge");
  // Fields make it a POST; -f is raw, -F reads @files.
  expect(apiCall(["api", "graphql", "-f", "query=q", "-Fid=@id.txt"])).toEqual({
    endpoint: "graphql", method: "POST", fields: [{ name: "query", value: "q", raw: true }, { name: "id", value: "@id.txt", raw: false }], input: undefined,
  });
  expect(apiCall(["api", "repos/o/r/pulls/1"])?.method).toBe("GET");
  expect(apiCall(["pr", "view"])).toBeUndefined();
});

test("a gh api call that merges is found in every spelling, and one the guard cannot read is refused", () => {
  const plan = (args: string[]) => apiMerge(apiCall(args) as NonNullable<ReturnType<typeof apiCall>>);
  expect(plan(["api", "-X", "PUT", "repos/o/r/pulls/12/merge"])).toEqual({ kind: "rest", repo: "o/r", number: 12 });
  expect(plan(["api", "--method", "put", "https://api.github.com/repos/o/r/pulls/12/merge?x=1"])).toEqual({ kind: "rest", repo: "o/r", number: 12 });
  expect(plan(["api", "-X", "PUT", "repos/{owner}/{repo}/pulls/12/merge"])).toEqual({ kind: "rest", repo: undefined, number: 12 });
  expect(plan(["api", "repos/o/r/pulls/12/merge", "-f", "merge_method=squash"])).toEqual({ kind: "rest", repo: "o/r", number: 12 });
  expect(plan(["api", "repos/o/r/pulls/12/merge"])).toEqual({ kind: "none" });
  expect(plan(["api", "-X", "PATCH", "repos/o/r/pulls/12"])).toEqual({ kind: "none" });
  expect(plan(["api", "-X", "POST", "repos/o/r/merges", "-f", "base=main"])).toMatchObject({ kind: "refuse" });
  expect(plan(["api", "-X", "PUT", "repos/o/r/pulls/{number}/merge"])).toMatchObject({ kind: "refuse" });
  expect(plan(["api", "-X", "PUT", "repos/o/r/pulls/12/%6Derge"])).toMatchObject({ kind: "refuse" });
  expect(plan(["api", "-X", "PUT", "repos/o/r/pulls/12/x/../merge"])).toMatchObject({ kind: "refuse" });
  expect(plan(["api", "graphql", "-f", "query=q"])).toEqual({ kind: "graphql" });
});

test("a GraphQL merge mutation's pull request ids are read from the query or its variables", () => {
  expect(graphqlMergeIds('mutation { mergePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId } }', {})).toEqual(["PR_1"]);
  expect(graphqlMergeIds("mutation($id: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }", { id: "PR_2" })).toEqual(["PR_2"]);
  expect(graphqlMergeIds("query { viewer { login } }", {})).toEqual([]);
  expect(graphqlMergeIds("mutation($input: MergePullRequestInput!) { mergePullRequest(input: $input) { clientMutationId } }", { input: { pullRequestId: "PR_3" } })).toHaveProperty("refuse");
  expect(graphqlMergeIds("mutation($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }", {})).toHaveProperty("refuse");
  expect(graphqlMergeIds('mutation { a: mergePullRequest(input: {pullRequestId: "PR_1"}) { x } b: mergePullRequest(input: $i) { x } }', {})).toHaveProperty("refuse");
  expect(graphqlMergeIds('mutation { mergeBranch(input: {repositoryId: "R", base: "main", head: "x"}) { x } }', {})).toHaveProperty("refuse");
});

test("an agent's gh api merge runs only when gh pr merge would", async () => {
  const here = parseRepo("johnrees/widget");
  const calls: string[] = [];
  const unmet = world({ rules: REQUIRED });
  expect(await gateRefusal(dispatchGh(["api", "-X", "PUT", "repos/{owner}/{repo}/pulls/12/merge"], here, mergeDeps(unmet.io, calls)))).toContain(
    "has not passed every check main requires (`build` missing, `agent-review` missing)",
  );
  const mutation = 'mutation { mergePullRequest(input: {pullRequestId: "PR_12"}) { clientMutationId } }';
  expect(await gateRefusal(dispatchGh(["api", "graphql", "-f", `query=${mutation}`], here, mergeDeps(unmet.io, calls)))).toContain("has not passed every check main requires");
  expect(await gateRefusal(dispatchGh(["api", "graphql", "--input", "body.json"], undefined, mergeDeps(unmet.io, calls, { "body.json": JSON.stringify({ query: mutation }) })))).toContain(
    "has not passed every check main requires",
  );
  expect(await gateRefusal(dispatchGh(["api", "graphql", "-F", "query=@-"], here, mergeDeps(unmet.io, calls)))).toBe(
    "cannot read the GraphQL query `gh api graphql` sends; pass it with `-f query=...` or `--input <file>`",
  );
  expect(await gateRefusal(dispatchGh(["api", "graphql", "-f", "id=PR_12"], here, mergeDeps(unmet.io, calls)))).toContain("cannot read the GraphQL query");
  expect(await gateRefusal(dispatchGh(["api", "graphql", "--input", "missing.json"], here, mergeDeps(unmet.io, calls)))).toContain("cannot read the GraphQL query");
  expect(await gateRefusal(dispatchGh(["api", "-X", "POST", "repos/johnrees/widget/merges"], here, mergeDeps(unmet.io, calls)))).toContain("merges endpoint");
  expect(await gateRefusal(dispatchGh(["api", "graphql", "-f", 'query=mutation { mergePullRequest(input: {pullRequestId: "MDQ6VXNlcjE="}) { x } }'], here, mergeDeps(unmet.io, calls)))).toBe(
    "a GraphQL merge mutation names a node that is not a pull request agent-gh can find",
  );
  expect(calls).toEqual([]);
  const passed = world({ rules: REQUIRED, ...PASSED });
  expect(await dispatchGh(["api", "-X", "PUT", "repos/johnrees/widget/pulls/12/merge"], here, mergeDeps(passed.io, calls))).toBe(0);
  expect(await dispatchGh(["api", "graphql", "-F", "query=@q.graphql"], here, mergeDeps(passed.io, calls, { "q.graphql": mutation }))).toBe(0);
  expect(await dispatchGh(["api", "graphql", "-f", "query=query { viewer { login } }"], here, mergeDeps(unmet.io, calls))).toBe(0);
  expect(await dispatchGh(["api", "repos/johnrees/widget/pulls/12/merge"], here, mergeDeps(unmet.io, calls))).toBe(0);
  expect(calls).toEqual([
    "gh api -X PUT repos/johnrees/widget/pulls/12/merge",
    "gh api graphql -F query=@q.graphql",
    "ungated gh api graphql -f query=query { viewer { login } }",
    "ungated gh api repos/johnrees/widget/pulls/12/merge",
  ]);
});

test("a waiver history longer than the gate reads is not trusted", async () => {
  const many = Array.from({ length: 100 }, () => labeled("johnrees", null));
  const long = world({ labels: ["review-waived"], events: many });
  expect(await gateRefusal(gateReady(long.io, { number: 12 }))).toBe("pull request #12 has over 1,000 events; its waiver cannot be checked");
});

test("without an upstream, the full review takes the pull request whose head is HEAD, not any that contains it", async () => {
  const w = world({
    upstream: false,
    commitPulls: [{ number: 11, state: "open", head: { sha: OLD } }, { number: 12, state: "open", head: { sha: HEAD } }],
    answer: { verdict: "approve", spec: "Done.", findings: [] },
  });
  await reviewFull(w.io, {});
  expect(w.fake.log.some((entry) => entry.path === `${REPO}/pulls/11`)).toBe(false);
  expect(posted(w.fake, `${REPO}/statuses/${HEAD}`)).toHaveLength(1);
});

test("Codex's work is reviewed by Claude, restricted to git's reads", async () => {
  const answer = { verdict: "approve", spec: "Done.", findings: [] };
  const w = world({ family: "codex", coAuthors: [[bot("codex")]], answer });
  await reviewFull(w.io, {});
  const [{ command }] = w.commands as [{ command: readonly string[]; stdin: string; cwd: string }];
  expect(command.slice(0, 6)).toEqual(["claude", "-p", "--model", "claude-opus-5-5", "--effort", "xhigh"]);
  expect(command).toContain("--restricted");
  expect(command).toContain("dontAsk");
  expect(command).not.toContain("bypassPermissions");
  expect(command[command.indexOf("--allowedTools") + 1]).toBe("Bash(git diff:*),Bash(git log:*),Bash(git show:*)");
  expect(JSON.parse(w.output())).toEqual(answer);
});

test("a pinned reviewer reviews its own family's work", () => {
  const pinned = parseReviewConfig(JSON.stringify({ reviewers: { codex: { model: "gpt-6-astra" } }, pin: "codex" }));
  expect(reviewerFor(pinned, "codex")).toEqual({ family: "codex", model: "gpt-6-astra" });
  expect(() => parseReviewConfig(JSON.stringify({ reviewers: { codex: { model: "gpt-6-astra" } }, pin: "claude" }))).toThrow("pin must name a family under reviewers");
});

test("a sweep prints the reviewer's text against the pull request's base and records nothing", async () => {
  const w = world({ answer: "No defects found." });
  await reviewSweep(w.io, {});
  const [{ command, stdin }] = w.commands as [{ command: readonly string[]; stdin: string; cwd: string }];
  expect(command.slice(0, 5)).toEqual(["codex", "exec", "review", "--base", "origin/main"]);
  expect(command).toContain('model_reasoning_effort="xhigh"');
  expect(stdin).toBe("");
  expect(w.output()).toBe("No defects found.\n");
  expect(w.fake.log.filter((entry) => entry.method === "POST" && entry.path !== "/graphql")).toEqual([]);
});

test("the reviewer is read-only, whatever checks the repository configures", () => {
  const files = { schema: "s.json", out: "o.json" };
  expect(fullCommand({ family: "codex", model: "gpt-6-astra" }, "high", files).slice(6, 8)).toEqual(["-s", "read-only"]);
  expect(sweepCommand({ family: "codex", model: "gpt-6-astra" }, "high", "origin/main", "o.md")).toContain("read-only");
  const claude = fullCommand({ family: "claude", model: "claude-opus-5-5" }, "high", files);
  expect(claude[claude.indexOf("--allowedTools") + 1]).toBe("Bash(git diff:*),Bash(git log:*),Bash(git show:*)");
});

test("the reviewer process gets its instructions on stdin, in the checkout, without the caller's harness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gh-fake-reviewer-"));
  const checkout = mkdtempSync(join(tmpdir(), "agent-gh-checkout-"));
  const fake = join(dir, "reviewer");
  await Bun.write(fake, '#!/bin/sh\necho "cwd=$(pwd) args=$* claude=${CLAUDECODE:-unset} quiet=$MISE_QUIET"\ncat\necho oops >&2\nexit 3\n');
  chmodSync(fake, 0o755);
  const result = await spawnReviewer([fake, "--flag"], "the prompt", checkout, { PATH: process.env.PATH ?? "", CLAUDECODE: "1" });
  expect(result).toEqual({ code: 3, stdout: `cwd=${realpathSync(checkout)} args=--flag claude=unset quiet=1\nthe prompt`, stderr: "oops\n" });
});

/** A throwaway repository and a ReviewIo whose git is real git there, with no global or system config. */
const realRepo = () => {
  const home = mkdtempSync(join(tmpdir(), "agent-gh-real-"));
  const dir = join(home, "repo");
  const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" };
  const git = (args: readonly string[], input?: string, cwd = dir) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, env, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
  };
  git(["init", "-q", "-b", "main", dir], undefined, home);
  const commit = (file: string, text: string, message: string) => {
    writeFileSync(join(dir, file), text);
    git(["add", file]);
    git(["commit", "-q", "-m", message]);
    return git(["rev-parse", "HEAD"]) as string;
  };
  const printed: string[] = [];
  const io = {
    family: "codex",
    git: async (args: readonly string[], input?: string) => git(args, input),
    runCheck: (command: string, cwd: string, timeoutMs: number) => spawnCheck(command, cwd, env, timeoutMs),
    tempDir: () => mkdtempSync(join(home, "tmp-")),
    print: (line: string) => printed.push(line),
  } as unknown as ReviewIo;
  return { home, dir, env, git, commit, io, printed };
};

test("checks run in a self-contained clone: they write there even when the caller's objects are read-only, and leave the caller untouched", async () => {
  const repo = realRepo();
  const head = repo.commit("a.txt", "a\n", "first");
  const objects = join(repo.dir, ".git", "objects");
  const before = repo.git(["count-objects", "-v"]);
  // A sandbox that may write only inside the clone: the caller's .git is read-only to it.
  const lock = (mode: number) => Bun.spawnSync(["chmod", "-R", mode === 0 ? "a-w" : "u+w", objects]);
  lock(0);
  let clone = "";
  try {
    const result = await inClone(repo.io, head, async (dir) => {
      clone = dir;
      const config = parseReviewConfig(JSON.stringify({ reviewers: { claude: { model: "m" } }, checks: ["echo built > out.txt && git add --all && git commit -q -m check", "git rev-parse HEAD"] }));
      return runChecks(repo.io, config, dir);
    });
    expect(result.state).toBe("passed");
    expect(result.state === "passed" && result.tail).toContain("$ git rev-parse HEAD\n");
  } finally {
    lock(1);
  }
  expect(existsSync(clone)).toBe(false);
  expect(repo.git(["count-objects", "-v"])).toBe(before);
  expect(repo.git(["status", "--porcelain"])).toBe("");
  expect(repo.git(["rev-parse", "HEAD"])).toBe(head);
});

test("the author family is read from the head commits' co-author trailers", async () => {
  const repo = realRepo();
  const base = repo.commit("a.txt", "a\n", "base");
  repo.commit("b.txt", "b\n", `one\n\nCo-authored-by: ${bot("claude")}`);
  const head = repo.commit("c.txt", "c\n", `two\n\nAgent-Harness: claude\nCo-authored-by: Jo <j@example.com>\nCo-authored-by: ${bot("claude")}`);
  expect(await authoredBy(repo.io, base, head)).toBe("claude");
  const mixed = repo.commit("d.txt", "d\n", "John's own");
  expect(await authoredBy(repo.io, base, mixed)).toBe("codex");
  expect(repo.printed).toEqual([
    "agent-gh: the head commits credit johnrees-claude[bot], so this is claude's work",
    "agent-gh: the head commits credit no single family App as co-author, so this is taken as this session's (codex) work",
  ]);
});

test("the patch id names the change, not its base: a rebase over unrelated work keeps it", async () => {
  const repo = realRepo();
  const base = repo.commit("a.txt", "a\n", "base");
  const head = repo.commit("b.txt", "one\ntwo  \n", "change");
  const first = await pullDiff(repo.io, base, head);
  expect(first.diff).toContain("+++ b/b.txt");
  expect(first.patchId).toMatch(/^[0-9a-f]{40}$/);
  repo.git(["checkout", "-q", "-b", "other", base]);
  repo.commit("z.txt", "z\n", "unrelated");
  const rebasedBase = repo.git(["rev-parse", "HEAD"]) as string;
  repo.git(["cherry-pick", head]);
  const rebased = repo.git(["rev-parse", "HEAD"]) as string;
  expect((await pullDiff(repo.io, rebasedBase, rebased)).patchId).toBe(first.patchId);
  const edited = repo.commit("b.txt", "one\nthree\n", "edit");
  expect((await pullDiff(repo.io, rebasedBase, edited)).patchId).not.toBe(first.patchId);
  expect(await pullDiff(repo.io, head, head)).toEqual({ diff: "", patchId: null });
});

test("a check runs through the shell in its directory, with stderr in its output and without the caller's harness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gh-check-"));
  const result = await spawnCheck('echo "in $(pwd) claude=${CLAUDECODE:-unset}"; echo oops >&2; exit 4', dir, { PATH: process.env.PATH ?? "", CLAUDECODE: "1" }, 60_000);
  expect(result).toEqual({ code: 4, output: `in ${realpathSync(dir)} claude=unset\noops\n`, timedOut: false });
  expect(readdirSync(dir)).toEqual([]);
});

test("a check past its timeout is stopped with everything it started", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gh-check-"));
  const started = Date.now();
  // The background child would keep the output open, and the check running, if only the shell were stopped.
  const marker = `late-${process.pid}-${Date.now()}`;
  const result = await spawnCheck(`echo begun; (sleep 20; touch ${marker}) & sleep 20`, dir, { PATH: process.env.PATH ?? "" }, 300);
  expect(result).toMatchObject({ output: "begun\n", timedOut: true });
  expect(Date.now() - started).toBeLessThan(5_000);
  const running = () => Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim();
  for (let wait = 0; wait < 40 && running() !== ""; wait++) await Bun.sleep(50);
  expect(running()).toBe("");
});
