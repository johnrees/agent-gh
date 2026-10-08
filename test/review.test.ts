import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Failure } from "../src/failure.ts";
import {
  effortFor,
  labelMatches,
  parseReviewConfig,
  readyTarget,
  reviewerFor,
  reviewed,
  waivedBy,
} from "../src/review.ts";
import { dispatchGh, fullCommand, gateReady, type GhDispatch, type ReviewIo, reviewerEnv, reviewFull, reviewSweep, spawnReviewer } from "../src/review-run.ts";
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
  checks: ["bun test", "bun run typecheck"],
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
  expect(refusal(() => reviewerFor(codexOnly, "codex"))).toContain("a codex session's work needs another family's review");
});

test("a config with a typo is refused with the field to fix, and defaults fill what is left out", () => {
  expect(refusal(() => parseReviewConfig("{"))).toBe(".github/agent-review.json is not valid JSON");
  expect(refusal(() => parseReviewConfig(JSON.stringify({ reviewers: { gemini: { model: "x" } } })))).toContain("reviewers.gemini is not a reviewer");
  expect(refusal(() => parseReviewConfig(JSON.stringify({ ...EXAMPLE, effort: { default: "huge" } })))).toContain("effort.default must be one of");
  expect(refusal(() => parseReviewConfig(JSON.stringify({ ...EXAMPLE, waiver: "x" })))).toContain("unknown key waiver");
  expect(refusal(() => parseReviewConfig(JSON.stringify({ reviewers: {} })))).toContain("names no reviewer");
  const minimal = parseReviewConfig(JSON.stringify({ reviewers: { codex: { model: "gpt-6-astra" } } }));
  expect(minimal).toMatchObject({ effort: { default: "high", rules: [] }, checklist: undefined, waiverLabel: "review-waived", checks: [] });
  expect(refusal(() => parseReviewConfig(JSON.stringify({ ...EXAMPLE, checks: "bun test" })))).toContain("checks must be a list");
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
const REPO = "/repos/johnrees/penmon";
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

type World = {
  head?: string;
  labels?: string[];
  status?: { context: string; state: string }[];
  events?: unknown[];
  optedIn?: boolean;
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
};

/** A pull request #12 on johnrees/penmon, closing issue #7, in a fake GitHub and a fake reviewer. */
const world = ({ head = HEAD, labels = [], status = [], events = [], optedIn = true, answer, closes = "johnrees/penmon", upstream = true, commitPulls = [{ number: 12, state: "open", head: { sha: HEAD } }], branchPulls = [{ number: 12, state: "open" }], family = "claude" }: World = {}) => {
  const fake = fakeGitHub({
    [`GET ${REPO}/pulls/12`]: () =>
      reply(200, { state: "open", title: "Do it", body: "Closes #7.", head: { sha: head }, base: { ref: "main" }, labels: labels.map((name) => ({ name })) }),
    [`GET ${REPO}/pulls`]: () => reply(200, branchPulls),
    [`GET ${REPO}/commits/${HEAD}/pulls`]: () => reply(200, commitPulls),
    [`GET ${REPO}`]: () => reply(200, { default_branch: "main" }),
    [`GET ${REPO}/contents/.github/agent-review.json`]: () =>
      optedIn ? reply(200, { content: Buffer.from(JSON.stringify(EXAMPLE)).toString("base64") }) : reply(404, {}),
    // The pull request's own merge base; origin's (below) would be a fork's.
    [`GET ${REPO}/compare/main...${HEAD}`]: () => reply(200, { merge_base_commit: { sha: OLD } }),
    [`GET ${REPO}/commits/${head}/status`]: () => reply(200, { state: "success", statuses: status }),
    [`GET ${REPO}/issues/12/events`]: () => reply(200, events),
    "POST /graphql": () => reply(200, { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 7, repository: { nameWithOwner: closes } }] } } } } }),
    [`GET ${REPO}/issues/7`]: () => reply(200, { title: "The ticket", body: "Do it well.", labels: [{ name: "model:fable-astra" }], comments: 1 }),
    [`GET ${REPO}/issues/7/comments`]: () => reply(200, [{ body: "Last word." }]),
    ["GET /repos/johnrees/tracker/issues/7"]: () => reply(200, { title: "Elsewhere", body: "Tracked elsewhere.", labels: [{ name: "model:opus-sol" }], comments: 0 }),
    [`POST ${REPO}/issues/12/comments`]: () => reply(201, {}),
    [`POST ${REPO}/statuses/${HEAD}`]: () => reply(201, {}),
  });
  stops.push(fake.stop);
  const commands: { command: readonly string[]; stdin: string; cwd: string }[] = [];
  const worktrees: string[] = [];
  const printed: string[] = [];
  let output = "";
  const io: ReviewIo = {
    api: fake.api,
    token: "ghu_test",
    repo: { owner: "johnrees", name: "penmon" },
    family,
    git: async (args) => {
      if (args[0] === "rev-parse" && args.at(-1) === "HEAD" && args.length === 2) return HEAD;
      if (args[0] === "rev-parse" && args.includes("@{upstream}")) return upstream ? "origin/feature" : undefined;
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return upstream ? "feature" : "HEAD";
      if (args[0] === "fetch") return args.at(-1) === "+refs/heads/main:refs/remotes/origin/main" ? "" : undefined;
      if (args[0] === "worktree") {
        worktrees.push(args.join(" "));
        return "";
      }
      if (args[0] === "merge-base") return "f".repeat(40);
      if (args[0] === "cat-file") return args.at(-1) === `${OLD}^{commit}` ? "" : undefined;
      return undefined;
    },
    runReviewer: async (command, stdin, cwd) => {
      commands.push({ command, stdin, cwd });
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
  return { fake, io, commands, worktrees, printed, output: () => output };
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

test("a full review runs the other family in a checkout of the head against the ticket, then posts its findings and status", async () => {
  const answer = {
    verdict: "changes_requested",
    spec: "Mostly done.",
    findings: [{ priority: "P2", kind: "tests", file: "src/a.ts", line: 3, summary: "Untested branch.", scenario: "Deleting it passes every test." }],
  };
  const { fake, io, commands, worktrees, output } = world({ answer });
  await reviewFull(io, {});
  expect(commands).toHaveLength(1);
  const [{ command, stdin, cwd }] = commands as [{ command: readonly string[]; stdin: string; cwd: string }];
  expect(command.slice(0, 9)).toEqual(["codex", "exec", "-m", "gpt-6-astra", "-c", 'model_reasoning_effort="xhigh"', "-s", "workspace-write", "-c"]);
  expect(command).toContain("sandbox_workspace_write.network_access=true");
  // The reviewer runs in a throwaway checkout of the reviewed commit, removed afterwards.
  expect(worktrees).toEqual([`worktree add --detach ${cwd} ${HEAD}`, `worktree remove --force ${cwd}`]);
  // The merge base is the pull request's, from GitHub, not origin's.
  expect(stdin).toContain(`git diff ${OLD}...${HEAD}`);
  expect(stdin).toContain("# Issue #7: The ticket\nLabels: model:fable-astra\n\nDo it well.\n\n## Last comment\n\nLast word.");
  expect(stdin).toContain("Apply each section of docs/agents/review-checklist.md");
  expect(stdin).toContain("you may run these checks, and no other commands that build or write: `bun test`, `bun run typecheck`.");
  expect(JSON.parse(output())).toEqual(answer);
  const [comment] = posted(fake, `${REPO}/issues/12/comments`);
  expect(comment?.body).toContain("**agent-review** of aaaaaaaa against #7 by gpt-6-astra (codex) at xhigh: changes requested");
  expect(comment?.body).toContain("- **P2 tests** `src/a.ts:3`: Untested branch.");
  expect(posted(fake, `${REPO}/statuses/${HEAD}`)).toEqual([
    { state: "success", context: "agent-review", description: "changes requested: 1 finding(s) by gpt-6-astra at xhigh" },
  ]);
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
  expect(posted(fake, `${REPO}/issues/12/comments`)[0]?.body).toContain("against johnrees/tracker#7 by");
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
      calls.push(`token ${slug(repo)}`);
      return use({ GH_TOKEN: "t" });
    },
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
  const here = parseRepo("johnrees/penmon");
  await gateRefusal(dispatchGh(["pr", "ready", "12"], here, deps(world().io)));
  expect(calls).toEqual(["token johnrees/penmon"]);

  calls.length = 0;
  const done = world({ status: [{ context: "agent-review", state: "success" }] }).io;
  expect(await dispatchGh(["-R", "johnrees/penmon", "pr", "ready", "12"], here, deps(done))).toBe(0);
  expect(await dispatchGh(["pr", "ready", "12", "--undo"], here, deps(done))).toBe(0);
  expect(await dispatchGh(["pr", "view", "12"], here, deps(done))).toBe(0);
  expect(calls).toEqual(["token johnrees/penmon", "gated gh -R johnrees/penmon pr ready 12 t", "gh pr ready 12 --undo", "gh pr view 12"]);

  calls.length = 0;
  await dispatchGh(["pr", "ready", "https://github.com/johnrees/penmon/pull/12"], parseRepo("someone/else"), deps(done));
  expect(calls[0]).toBe("token johnrees/penmon");
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

test("a Codex session's work is reviewed by Claude, restricted to git's reads and the configured checks", async () => {
  const answer = { verdict: "approve", spec: "Done.", findings: [] };
  const w = world({ family: "codex", answer });
  await reviewFull(w.io, {});
  const [{ command }] = w.commands as [{ command: readonly string[]; stdin: string; cwd: string }];
  expect(command.slice(0, 6)).toEqual(["claude", "-p", "--model", "claude-opus-5-5", "--effort", "xhigh"]);
  expect(command).toContain("--restricted");
  expect(command).toContain("dontAsk");
  expect(command).not.toContain("bypassPermissions");
  expect(command[command.indexOf("--allowedTools") + 1]).toBe("Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(bun test:*),Bash(bun run typecheck:*)");
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

test("a reviewer with no checks to run is read-only", () => {
  const codex = { family: "codex", model: "gpt-6-astra" } as const;
  const files = { schema: "s.json", out: "o.json" };
  const sandbox = (checks: string[]) => fullCommand(codex, "high", files, checks).slice(6, 8);
  expect(sandbox([])).toEqual(["-s", "read-only"]);
  expect(sandbox(["bun test"])).toEqual(["-s", "workspace-write"]);
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
