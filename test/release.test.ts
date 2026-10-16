import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantBody } from "../src/allow.ts";
import { Failure } from "../src/failure.ts";
import { slug } from "../src/repo.ts";
import { releaseCommand } from "../src/review.ts";
import { dispatchGh, type GhDispatch, guardPush, type ReviewIo } from "../src/review-run.ts";
import { fakeGitHub, reply } from "./fake-github.ts";

const REPO = "/repos/johnrees/widget";
const HERE = { owner: "johnrees", name: "widget" };
const URL = "https://github.com/johnrees/widget.git";
/** The commit John grants, another, an annotated tag object pointing at the first, and git's zeros. */
const COMMIT = "c".repeat(40);
const OTHER = "d".repeat(40);
const ANNOTATED = "e".repeat(40);
const Z = "0".repeat(40);
const HOUR = 3_600_000;
const GRANT = "agent-gh allow release v1.2.3 -R johnrees/widget";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** A grant issue as GitHub lists it, John's and valid unless a field says otherwise. */
type Grant = {
  number?: number; tag?: string; sha?: string | null; user?: string; app?: unknown; state?: string; ageHours?: number;
  /** Its body was edited, or it was closed, reopened, or transferred, as GraphQL tells. */
  edited?: boolean; history?: number;
  pr?: boolean;
};

const issue = (grant: Grant) => ({
  number: grant.number ?? 51,
  state: grant.state ?? "open",
  user: { login: grant.user ?? "johnrees" },
  performed_via_github_app: grant.app ?? null,
  created_at: new Date(Date.now() - (grant.ageHours ?? 1) * HOUR).toISOString(),
  body: grantBody(HERE, grant.tag ?? "v1.2.3", grant.sha === undefined ? COMMIT : grant.sha),
  labels: [{ name: "agent-release" }],
  ...(grant.pr === true ? { pull_request: { url: "https://api.github.com/repos/johnrees/widget/pulls/51" } } : {}),
});

type World = {
  grants?: Grant[];
  /** Tags on GitHub, each an object GitHub's ref points at. */
  tags?: Record<string, { type: string; sha: string }>;
  /** Branches, and the commit each points at. */
  branches?: Record<string, string>;
  /** Releases by id: their tag and target. */
  releases?: Record<number, { tag_name: string; target_commitish: string }>;
  /** What local git peels each pushed object to. */
  local?: Record<string, string>;
  /** GraphQL Ref nodes by id. */
  refs?: Record<string, { name: string; prefix: string }>;
};

/** johnrees/widget in a fake GitHub, owned by johnrees, with the grants and objects the test names. */
const world = ({ grants = [], tags = {}, branches = { main: COMMIT, feature: OTHER }, releases = {}, local = { [COMMIT]: COMMIT, [ANNOTATED]: COMMIT, [OTHER]: OTHER }, refs = {} }: World = {}) => {
  const fake = fakeGitHub({
    [`GET ${REPO}`]: () => reply(200, { default_branch: "main", owner: { login: "johnrees" } }),
    [`GET ${REPO}/issues`]: () => reply(200, grants.map(issue)),
    "POST /graphql": (body) => {
      const { query, variables } = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
      if (query.includes("lastEditedAt")) {
        const found = grants.find((grant) => (grant.number ?? 51) === variables.number);
        return reply(200, { data: { repository: { issue: { lastEditedAt: found?.edited ? "2026-10-16T00:00:00Z" : null, history: { totalCount: found?.history ?? 0 } } } } });
      }
      if (query.includes("on Repository")) return reply(200, { data: { node: variables.id === "R_widget" ? { nameWithOwner: "johnrees/widget" } : {} } });
      const ref = refs[variables.id as string];
      return reply(200, { data: { node: ref === undefined ? {} : { ...ref, repository: { nameWithOwner: "johnrees/widget" } } } });
    },
    ...Object.fromEntries(Object.entries(tags).map(([name, object]) => [`GET ${REPO}/git/ref/tags/${name}`, () => reply(200, { ref: `refs/tags/${name}`, object })])),
    [`GET ${REPO}/git/tags/${ANNOTATED}`]: () => reply(200, { sha: ANNOTATED, object: { type: "commit", sha: COMMIT } }),
    [`GET ${REPO}/git/commits/${COMMIT}`]: () => reply(200, { sha: COMMIT }),
    [`GET ${REPO}/git/commits/${OTHER}`]: () => reply(200, { sha: OTHER }),
    ...Object.fromEntries(Object.entries(branches).map(([name, sha]) => [`GET ${REPO}/commits/${name}`, () => reply(200, { sha })])),
    ...Object.fromEntries(Object.entries(releases).map(([id, release]) => [`GET ${REPO}/releases/${id}`, () => reply(200, release)])),
    // A feature branch with no rules, for a branch push beside a tag.
    [`GET ${REPO}/rules/branches/feature`]: () => reply(200, []),
    [`GET ${REPO}/branches/feature`]: () => reply(404, {}),
  });
  stops.push(fake.stop);
  const printed: string[] = [];
  const unused = () => {
    throw new Error("the release guard never runs this");
  };
  const io: ReviewIo = {
    api: fake.api,
    token: "ghu_test",
    repo: HERE,
    family: "claude",
    git: async (args) => (args[0] === "rev-parse" && args.includes("--verify") ? local[(args.at(-1) as string).replace("^{commit}", "")] : undefined),
    runCheck: unused,
    runReviewer: unused,
    readFile: unused,
    tempDir: unused,
    print: (line) => printed.push(line),
    out: unused,
    sleep: async () => {},
  };
  return { fake, io, printed };
};

/** The gate's deps: one token, files for `--input`, and a log of what gh runs, gated (with the gate's token) or not. */
const deps = (io: ReviewIo, calls: string[], files: Record<string, string> = {}, tokens: string[] = []): GhDispatch => ({
  withToken: async (repo, use) => {
    tokens.push(repo === undefined ? "none" : slug(repo));
    return use({ GH_TOKEN: "t" });
  },
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

const refusal = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof Failure) return error.detail;
    throw error;
  }
  throw new Error("expected a refusal");
};

const ungranted = (tag: string, reasons = "") =>
  `John has not granted \`${tag}\` in johnrees/widget${reasons === "" ? "" : ` (${reasons})`}, and agents push a tag or write a release only with his grant; ask John to run \`agent-gh allow release ${tag} -R johnrees/widget\``;

const tagLine = (tag: string, local = COMMIT, remote = Z) => `refs/tags/${tag} ${local} refs/tags/${tag} ${remote}\n`;

test("an agent's tag push needs John's grant for that tag, at the commit it points at", async () => {
  const push = (stdin: string, w = world()) => guardPush(URL, stdin, deps(w.io, []));
  expect(await refusal(push(tagLine("v1.2.3")))).toBe(ungranted("v1.2.3"));
  // A grant for another tag grants nothing here.
  expect(await refusal(push(tagLine("v1.2.3"), world({ grants: [{ tag: "v1.2.4" }] })))).toBe(ungranted("v1.2.3"));
  const granted = world({ grants: [{ tag: "v1.2.3" }] });
  await push(tagLine("v1.2.3"), granted);
  expect(granted.printed).toEqual(["agent-gh: John's grant #51 allows `v1.2.3` in johnrees/widget"]);
  // An annotated tag is judged by the commit it points at; a grant that names no commit takes any.
  await push(tagLine("v1.2.3", ANNOTATED), world({ grants: [{ tag: "v1.2.3" }] }));
  await push(tagLine("v1.2.3", OTHER), world({ grants: [{ tag: "v1.2.3", sha: null }] }));
});

test("a grant counts only while it is the owner's own open, unedited issue, under 24 hours old, at the tag's commit", async () => {
  const cases: [Grant, string][] = [
    [{ ageHours: 25 }, "#51 expired 24 hours after it was opened"],
    [{ state: "closed" }, "#51 is closed"],
    [{ app: { id: 7, slug: "johnrees-claude" } }, "#51 was opened through the johnrees-claude App, as an agent's would be"],
    [{ user: "mallory" }, "#51 was opened by mallory, not the repository's owner, johnrees"],
    [{ sha: OTHER }, "#51 grants it at dddddddd, but it points at cccccccc"],
    // An agent acts as John, so it could edit John's own issue into a grant, or reopen one he closed.
    [{ edited: true }, "#51 was edited after it was opened"],
    [{ history: 1 }, "#51 was closed, reopened, or transferred since it was opened"],
    // GitHub records no App for a pull request, so one an agent opened would pass for John's.
    [{ pr: true }, "#51 is a pull request, which GitHub never records as opened through an App"],
  ];
  for (const [grant, why] of cases) {
    expect(await refusal(guardPush(URL, tagLine("v1.2.3"), deps(world({ grants: [{ tag: "v1.2.3", ...grant }] }).io, [])))).toBe(ungranted("v1.2.3", why));
  }
  // A valid grant beside a void one still grants.
  await guardPush(URL, tagLine("v1.2.3"), deps(world({ grants: [{ number: 50, tag: "v1.2.3", edited: true }, { tag: "v1.2.3" }] }).io, []));
});

test("deleting or moving a tag is refused even with a grant, before any request; every pushed tag needs its own grant", async () => {
  const tokens: string[] = [];
  const granted = world({ grants: [{ tag: "v1.2.3" }] });
  expect(await refusal(guardPush(URL, `(delete) ${Z} refs/tags/v1.2.3 ${COMMIT}\n`, deps(granted.io, [], {}, tokens)))).toBe(
    "agents never delete a tag, grant or not (`v1.2.3` in johnrees/widget): `agent-gh allow release v1.2.3 -R johnrees/widget` lets them create a new tag once and write its release; ask John to delete this one himself",
  );
  expect(await refusal(guardPush(URL, tagLine("v1.2.3", COMMIT, OTHER), deps(granted.io, [], {}, tokens)))).toBe(
    "`v1.2.3` already exists in johnrees/widget, and agents never move a tag, grant or not (`v1.2.3` in johnrees/widget): `agent-gh allow release v1.2.3 -R johnrees/widget` lets them create a new tag once and write its release; ask John to move this one himself",
  );
  expect(tokens).toEqual([]);
  // `git push --tags`: each new tag needs a grant; a tag already there as it is needs none.
  const both = tagLine("v1.2.3") + tagLine("v1.2.4") + tagLine("v1.0.0", OTHER, OTHER);
  expect(await refusal(guardPush(URL, both, deps(granted.io, [])))).toBe(ungranted("v1.2.4"));
  await guardPush(URL, both, deps(world({ grants: [{ tag: "v1.2.3" }, { number: 52, tag: "v1.2.4" }] }).io, []));
  // A branch pushed beside a tag still goes through the branch guard.
  const mixed = `refs/heads/feature ${OTHER} refs/heads/feature ${Z}\n${tagLine("v1.2.3")}`;
  await guardPush(URL, mixed, deps(world({ grants: [{ tag: "v1.2.3" }] }).io, [], {}, tokens));
  expect(tokens).toEqual(["johnrees/widget"]);
  // A remote on a local path is not held.
  await guardPush("/tmp/elsewhere.git", `(delete) ${Z} refs/tags/v1.2.3 ${COMMIT}\n`, deps(world().io, []));
});

test("from the CLI, an agent's tag deletion is refused before any request, and a person's tag push is never held", () => {
  const push = (env: Record<string, string>) => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "guard", "pre-push", "origin", URL], {
      env: { PATH: process.env.PATH ?? "", HOME: mkdtempSync(join(tmpdir(), "agent-gh-release-")), ...env },
      stdin: new TextEncoder().encode(`(delete) ${Z} refs/tags/v1.2.3 ${COMMIT}\n`),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: result.exitCode, stderr: result.stderr.toString() };
  };
  const agent = push({ CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" });
  expect(agent.code).toBe(1);
  expect(agent.stderr).toStartWith("agent-gh: checking the release failed: agents never delete a tag, grant or not");
  expect(push({})).toEqual({ code: 0, stderr: "" });
});

test("gh release is read as gh reads it: its subcommand, aliases, tag, and -R in any spelling", () => {
  expect(releaseCommand(["release", "create", "v1", "--notes", "x"])).toEqual({ kind: "write", subcommand: "create", tag: "v1", repo: undefined, target: undefined, newTag: undefined });
  expect(releaseCommand(["release", "new", "-t", "v9", "v1", "--target", "main", "-p"])).toMatchObject({ subcommand: "create", tag: "v1", target: "main" });
  expect(releaseCommand(["-R", "o/r", "release", "upload", "v1", "a.zip", "--clobber"])).toMatchObject({ subcommand: "upload", tag: "v1", repo: "o/r" });
  expect(releaseCommand(["release", "delete-asset", "v1", "a.zip", "-yRo/r"])).toMatchObject({ subcommand: "delete-asset", tag: "v1", repo: "o/r" });
  expect(releaseCommand(["release", "edit", "--repo=o/r", "v1", "--tag", "v2", "--draft=false"])).toMatchObject({ subcommand: "edit", tag: "v1", repo: "o/r", newTag: "v2" });
  expect(releaseCommand(["release", "delete", "v1", "--cleanup-tag", "-y"])).toMatchObject({ subcommand: "delete", tag: "v1" });
  // gh's parser takes a flag before the subcommand as one with a value, so this creates v1, not a list.
  expect(releaseCommand(["release", "--target", "list", "create", "v1"])).toMatchObject({ kind: "write", subcommand: "create", tag: "v1", target: "list" });
  for (const args of [["release"], ["release", "--help"], ["release", "list"], ["release", "ls", "-L", "5"], ["release", "view", "v1"], ["release", "download", "v1", "-p", "*.zip"], ["release", "verify", "v1"], ["release", "verify-asset", "v1", "a.zip"]]) {
    expect(releaseCommand(args)).toEqual({ kind: "read" });
  }
  expect(releaseCommand(["release", "publish", "v1"])).toEqual({ kind: "unknown", subcommand: "publish", repo: undefined });
  expect(releaseCommand(["release", "constructor"])).toEqual({ kind: "unknown", subcommand: "constructor", repo: undefined });
  // A word before the command words leaves the tag unread, so the guard refuses rather than guess.
  expect(releaseCommand(["--clobber", "x", "release", "upload", "v1"])).toMatchObject({ subcommand: "upload", tag: undefined });
  for (const args of [["pr", "view"], ["api", "repos/o/r/releases"], ["help", "release", "create"]]) expect(releaseCommand(args)).toBeUndefined();
});

test("an agent's gh release write needs John's grant for its tag, and a new tag is pinned to the granted commit", async () => {
  const calls: string[] = [];
  const run = (args: string[], w: ReturnType<typeof world>, repo: typeof HERE | null = HERE) => dispatchGh(args, repo ?? undefined, deps(w.io, calls));
  expect(await refusal(run(["release", "create", "v1.2.3", "--generate-notes"], world()))).toBe(ungranted("v1.2.3"));
  const granted = () => world({ grants: [{ tag: "v1.2.3" }] });
  await run(["release", "create", "v1.2.3", "--generate-notes"], granted());
  await run(["release", "create", "v1.2.3", "--target", "main", "--", "notes.md"], granted());
  expect(await refusal(run(["release", "create", "v1.2.3", "--target", "feature"], granted()))).toBe(ungranted("v1.2.3", "#51 grants it at cccccccc, but it points at dddddddd"));
  // A grant that names no commit leaves the target alone.
  await run(["release", "create", "v1.2.3", "--target", "feature"], world({ grants: [{ tag: "v1.2.3", sha: null }] }));
  // Once the tag is on GitHub, it is judged where it points.
  const tagged = () => world({ grants: [{ tag: "v1.2.3" }], tags: { "v1.2.3": { type: "tag", sha: ANNOTATED } } });
  await run(["-R", "johnrees/widget", "release", "create", "v1.2.3"], tagged(), null);
  await run(["release", "upload", "v1.2.3", "a.zip", "--clobber"], tagged());
  await run(["release", "edit", "v1.2.3", "--draft=false"], tagged());
  await run(["release", "delete-asset", "v1.2.3", "a.zip", "-y"], tagged());
  expect(await refusal(run(["release", "upload", "v1.2.3", "a.zip"], world({ grants: [{ tag: "v1.2.3" }], tags: { "v1.2.3": { type: "commit", sha: OTHER } } })))).toContain("but it points at dddddddd");
  expect(calls).toEqual([
    `gh release create v1.2.3 --generate-notes --target ${COMMIT}`,
    `gh release create v1.2.3 --target main --target ${COMMIT} -- notes.md`,
    "gh release create v1.2.3 --target feature",
    "gh -R johnrees/widget release create v1.2.3",
    "gh release upload v1.2.3 a.zip --clobber",
    "gh release edit v1.2.3 --draft=false",
    "gh release delete-asset v1.2.3 a.zip -y",
  ]);
  // Moving a release to another tag needs a grant for each.
  expect(await refusal(run(["release", "edit", "v1.2.3", "--tag", "v1.2.4"], tagged()))).toBe(ungranted("v1.2.4"));
  expect(await refusal(run(["release", "edit", "v1.2.3", "--tag", "v1.2.4"], world({ grants: [{ tag: "v1.2.4" }], tags: { "v1.2.3": { type: "commit", sha: COMMIT } } })))).toBe(ungranted("v1.2.3"));
});

test("gh release delete is refused even with a grant; reads pass, and an unknown subcommand or an unreadable tag or repository is refused", async () => {
  const calls: string[] = [];
  const granted = world({ grants: [{ tag: "v1.2.3" }], tags: { "v1.2.3": { type: "commit", sha: COMMIT } } });
  const run = (args: string[], repo: typeof HERE | null = HERE) => dispatchGh(args, repo ?? undefined, deps(granted.io, calls));
  expect(await refusal(run(["release", "delete", "v1.2.3", "-y"]))).toBe(
    `agents never delete a release, grant or not (\`v1.2.3\` in johnrees/widget): \`${GRANT}\` lets them create and edit one; ask John to delete it himself`,
  );
  expect(await refusal(run(["release", "publish", "v1.2.3"]))).toContain("agent-gh does not know what `gh release publish` writes, so it refuses it");
  expect(await refusal(run(["release", "create"]))).toContain("cannot read which tag `gh release create` names");
  expect(await refusal(run(["release", "upload", "v1.2.3", "a.zip"], null))).toContain("cannot tell which repository `gh release` writes to; pass -R OWNER/REPO");
  expect(calls).toEqual([]);
  await run(["release", "list"]);
  await run(["release", "view", "v1.2.3"], null);
  expect(calls).toEqual(["ungated gh release list", "ungated gh release view v1.2.3"]);
});

test("an agent's gh api tag ref or release write needs John's grant; moving or deleting a tag is refused", async () => {
  const calls: string[] = [];
  const run = (args: string[], w: ReturnType<typeof world>, files: Record<string, string> = {}) => dispatchGh(args, HERE, deps(w.io, calls, files));
  const granted = () => world({ grants: [{ tag: "v1.2.3" }], releases: { 5: { tag_name: "v1.2.3", target_commitish: "main" } } });
  const newTag = ["api", "repos/johnrees/widget/git/refs", "-f", "ref=refs/tags/v1.2.3"];
  expect(await refusal(run([...newTag, "-f", `sha=${COMMIT}`], world()))).toBe(ungranted("v1.2.3"));
  await run([...newTag, "-f", `sha=${COMMIT}`], granted());
  // A new annotated tag's object is judged by the commit it points at.
  await run([...newTag, "-f", `sha=${ANNOTATED}`], granted());
  expect(await refusal(run([...newTag, "-f", `sha=${OTHER}`], granted()))).toContain("but it points at dddddddd");
  expect(await refusal(run(newTag, granted()))).toContain("cannot read the tag `gh api` creates, or its sha");
  // A branch still goes through the push guard.
  await run(["api", "repos/johnrees/widget/git/refs", "-f", "ref=refs/heads/feature", "-f", `sha=${OTHER}`], world());
  for (const args of [
    ["api", "-X", "PATCH", "repos/johnrees/widget/git/refs/tags/v1.2.3", "-f", `sha=${OTHER}`, "-F", "force=true"],
    ["api", "-X", "DELETE", "repos/{owner}/{repo}/git/refs/tags/v1.2.3"],
    ["api", "-X", "DELETE", "repos/johnrees/widget/git/refs/tags%2Fv1.2.3"],
  ]) {
    expect(await refusal(run(args, granted()))).toBe(
      "agents never move or delete a tag, grant or not (`v1.2.3` in johnrees/widget): `agent-gh allow release v1.2.3 -R johnrees/widget` lets them create a new tag once and write its release; ask John to move or delete this one himself",
    );
  }
  // A new release names its tag in its body; while that tag does not exist, it must name the granted commit.
  const release = ["api", "repos/johnrees/widget/releases", "-f", "tag_name=v1.2.3"];
  expect(await refusal(run(release, world()))).toBe(ungranted("v1.2.3"));
  expect(await refusal(run([...release, "-f", "target_commitish=main"], granted()))).toBe(
    `\`v1.2.3\` does not exist in johnrees/widget yet, and John granted it at ${COMMIT}: give -f target_commitish=${COMMIT}, so GitHub tags that commit`,
  );
  await run([...release, "-f", `target_commitish=${COMMIT}`], granted());
  await run(["api", "repos/johnrees/widget/releases", "--input", "release.json"], granted(), { "release.json": JSON.stringify({ tag_name: "v1.2.3", target_commitish: COMMIT }) });
  expect(await refusal(run(["api", "repos/johnrees/widget/releases", "-f", "name=Big"], granted()))).toContain("cannot read the tag of the release `gh api` creates");
  expect(await refusal(run(["api", "repos/johnrees/widget/releases", "--input", "-"], granted()))).toContain("cannot read the body `gh api --input` sends");
  // An existing release is judged by its own tag, read from GitHub, and by any tag it is moved to.
  const tagged = () => world({ grants: [{ tag: "v1.2.3" }], tags: { "v1.2.3": { type: "commit", sha: COMMIT } }, releases: { 5: { tag_name: "v1.2.3", target_commitish: "main" } } });
  await run(["api", "-X", "PATCH", "repos/johnrees/widget/releases/5", "-f", "body=Notes"], tagged());
  await run(["api", "-X", "DELETE", "repos/johnrees/widget/releases/5"], tagged());
  expect(await refusal(run(["api", "-X", "PATCH", "repos/johnrees/widget/releases/5", "-f", "tag_name=v1.2.4"], tagged()))).toBe(ungranted("v1.2.4"));
  const renamed = world({ grants: [{ tag: "v1.2.4" }], tags: { "v1.2.3": { type: "commit", sha: COMMIT } }, releases: { 5: { tag_name: "v1.2.3", target_commitish: "main" } } });
  expect(await refusal(run(["api", "-X", "PATCH", "repos/johnrees/widget/releases/5", "-f", "tag_name=v1.2.4", "-f", `target_commitish=${COMMIT}`], renamed))).toBe(ungranted("v1.2.3"));
  expect(await refusal(run(["api", "-X", "DELETE", "repos/johnrees/widget/releases/5"], world({ releases: { 5: { tag_name: "v1.2.3", target_commitish: "main" } } })))).toBe(ungranted("v1.2.3"));
  expect(await refusal(run(["api", "-X", "PATCH", "repos/johnrees/widget/releases/6", "-f", "body=x"], tagged()))).toContain("cannot find release 6 in johnrees/widget");
  // An asset upload goes to uploads.github.com, for the release's tag.
  const upload = ["api", "https://uploads.github.com/repos/johnrees/widget/releases/5/assets?name=a.zip", "--input", "a.zip", "-H", "Content-Type: application/zip"];
  await run(upload, tagged());
  expect(await refusal(run(upload, world({ releases: { 5: { tag_name: "v1.2.3", target_commitish: "main" } } })))).toBe(ungranted("v1.2.3"));
  expect(calls).toEqual([
    `gh ${newTag.join(" ")} -f sha=${COMMIT}`,
    `gh ${newTag.join(" ")} -f sha=${ANNOTATED}`,
    `gh api repos/johnrees/widget/git/refs -f ref=refs/heads/feature -f sha=${OTHER}`,
    `gh ${release.join(" ")} -f target_commitish=${COMMIT}`,
    "gh api repos/johnrees/widget/releases --input release.json",
    "gh api -X PATCH repos/johnrees/widget/releases/5 -f body=Notes",
    "gh api -X DELETE repos/johnrees/widget/releases/5",
    `gh ${upload.join(" ")}`,
  ]);
});

test("gh api endpoints the release guard cannot read are refused, and approving a deployment always is", async () => {
  const calls: string[] = [];
  const granted = world({ grants: [{ tag: "v1.2.3" }] });
  const run = (args: string[]) => dispatchGh(args, HERE, deps(granted.io, calls));
  const deployments =
    "agents never approve or reject a deployment: an environment's approval is John's click on the run's page, and no grant (`agent-gh allow release <tag>`) covers it";
  expect(await refusal(run(["api", "repos/johnrees/widget/actions/runs/9/pending_deployments", "-F", "environment_ids[]=1", "-f", "state=approved", "-f", "comment=ok"]))).toBe(deployments);
  expect(await refusal(run(["api", "repos/{owner}/{repo}/actions/runs/9/deployment_protection_rule", "-f", "environment_name=prod", "-f", "state=approved"]))).toBe(deployments);
  for (const [args, says] of [
    [["api", "-X", "DELETE", "repos/johnrees/widget/releases/assets/7"], "cannot tell which release `gh api DELETE repos/johnrees/widget/releases/assets/7` changes an asset of"],
    [["api", "-X", "PUT", "repos/johnrees/widget/releases/5"], "cannot tell which release `gh api PUT repos/johnrees/widget/releases/5` writes"],
    [["api", "-X", "POST", "repos/johnrees/widget/releases/latest"], "cannot tell which release"],
    [["api", "-X", "POST", "repositories/1/releases", "-f", "tag_name=v1.2.3"], "cannot tell which repository `gh api repositories/1/releases` writes to"],
    [["api", "https://uploads.github.com/repos/johnrees/widget/issues", "-f", "title=x"], "cannot tell what `gh api POST https://uploads.github.com/repos/johnrees/widget/issues` writes"],
    // GitHub decodes the path, so an encoded repository prefix must not hide a release or ref write (review finding 54729a508c23).
    [["api", "r%65pos/johnrees/widget/releases", "-f", "tag_name=v1.2.3"], "cannot read which repository `gh api POST r%65pos/johnrees/widget/releases` writes to"],
    [["api", "-X", "DELETE", "repos%2Fjohnrees%2Fwidget/git/refs/tags/v1.2.3"], "cannot read which repository"],
    [["api", "-X", "PATCH", "r%65pos/johnrees/widget/git/refs/heads/main", "-f", `sha=${COMMIT}`], "cannot read which repository"],
    // So must an encoded GraphQL endpoint (review finding 4125f56f31c9), whatever its mutation moves or merges.
    [["api", "gr%61phql", "-f", 'query=mutation { deleteRef(input: {refId: "REF_TAG"}) { clientMutationId } }'], "cannot read `gh api POST gr%61phql`: spell the GraphQL endpoint plainly, as `gh api graphql`"],
    [["api", "https://api.github.com/GRAPHQL%2F", "-f", 'query=mutation { mergePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId } }'], "spell the GraphQL endpoint plainly"],
    // gh sends a GraphQL endpoint spelled other than `graphql` as REST, so `variables[id]` would be the $id GitHub reads (review finding db612a5f083a).
    ...["https://api.github.com/graphql", "/graphql", "GRAPHQL", "graphql/"].map((endpoint): [string[], string] => [
      ["api", endpoint, "-f", "query=mutation($id: ID!) { deleteRef(input: {refId: $id}) { clientMutationId } }", "-f", "id=REF_BRANCH", "-f", "variables[id]=REF_TAG"],
      `cannot read \`gh api POST ${endpoint}\`: spell the GraphQL endpoint plainly, as \`gh api graphql\``,
    ]),
    // A spelling of api.github.com gh would still send John's token to is read as no path.
    [["api", "https://api.github.com:443/repos/johnrees/widget/git/refs", "-f", "ref=refs/tags/v1.2.3", "-f", `sha=${COMMIT}`], "cannot tell what `gh api POST https://api.github.com:443/"],
  ] as [string[], string][]) {
    expect(await refusal(run(args))).toContain(says);
  }
  expect(calls).toEqual([]);
  await run(["api", "repos/johnrees/widget/actions/runs/9/pending_deployments"]);
  await run(["api", "repos/johnrees/widget/releases/generate-notes", "-f", "tag_name=v9"]);
  await run(["api", "repos/johnrees/widget/releases/5/reactions", "-f", "content=heart"]);
  await run(["api", "https://example.com/hook", "-f", "x=y"]);
  expect(calls).toEqual([
    "ungated gh api repos/johnrees/widget/actions/runs/9/pending_deployments",
    "ungated gh api repos/johnrees/widget/releases/generate-notes -f tag_name=v9",
    "ungated gh api repos/johnrees/widget/releases/5/reactions -f content=heart",
    "ungated gh api https://example.com/hook -f x=y",
  ]);
});

test("GraphQL: a tag's createRef needs John's grant; moving or deleting a tag, release mutations, and deployment approvals are refused", async () => {
  const calls: string[] = [];
  const refs = { REF_TAG: { name: "v1.2.3", prefix: "refs/tags/" } };
  const run = (query: string, w: ReturnType<typeof world>, extra: string[] = []) => dispatchGh(["api", "graphql", "-f", `query=${query}`, ...extra], HERE, deps(w.io, calls));
  const create = (oid: string) => `mutation { createRef(input: {repositoryId: "R_widget", name: "refs/tags/v1.2.3", oid: "${oid}"}) { ref { name } } }`;
  expect(await refusal(run(create(COMMIT), world()))).toBe(ungranted("v1.2.3"));
  await run(create(COMMIT), world({ grants: [{ tag: "v1.2.3" }] }));
  expect(await refusal(run(create(OTHER), world({ grants: [{ tag: "v1.2.3" }] })))).toContain("but it points at dddddddd");
  // In variables, as gh nests -F input[...] fields.
  const nested = "mutation($input: CreateRefInput!) { createRef(input: $input) { ref { name } } }";
  await run(nested, world({ grants: [{ tag: "v1.2.3" }] }), ["-F", "input[repositoryId]=R_widget", "-F", "input[name]=refs/tags/v1.2.3", "-F", `input[oid]=${COMMIT}`]);
  const granted = world({ grants: [{ tag: "v1.2.3" }], refs });
  expect(await refusal(run('mutation { createRef(input: {repositoryId: "R_widget", name: "refs/heads/x", oid: "a"}) { ref { name } } }', granted))).toBe(
    "agents create only tags with the GraphQL createRef mutation; push a branch with git, which checks it",
  );
  const moved =
    "agents never move or delete a tag, grant or not (`v1.2.3` in johnrees/widget): `agent-gh allow release v1.2.3 -R johnrees/widget` lets them create a new tag once and write its release; ask John to move or delete this one himself";
  expect(await refusal(run(`mutation { updateRef(input: {refId: "REF_TAG", oid: "${OTHER}", force: true}) { ref { name } } }`, granted))).toBe(moved);
  expect(await refusal(run("mutation($id: ID!) { deleteRef(input: {refId: $id}) { clientMutationId } }", granted, ["-f", "id=REF_TAG"]))).toBe(moved);
  expect(await refusal(run('mutation { updateRefs(input: {repositoryId: "R_widget", refUpdates: [{name: "refs/tags/v1.2.3", afterOid: "a", force: true}]}) { clientMutationId } }', granted))).toContain(
    "agents do not use the GraphQL updateRefs mutation",
  );
  expect(await refusal(run('mutation { approveDeployments(input: {workflowRunId: "W", environmentIds: ["E"]}) { deployments { id } } }', granted))).toContain(
    "agents never approve or reject a deployment",
  );
  expect(await refusal(run('mutation { a: rejectDeployments(input: {workflowRunId: "W", environmentIds: ["E"]}) { clientMutationId } }', granted))).toContain("agents never approve or reject a deployment");
  expect(await refusal(run('mutation { createRelease(input: {repositoryId: "R_widget", tagName: "v9"}) { clientMutationId } }', granted))).toBe(
    "agents do not write releases through GraphQL; use `gh release`, which needs John's grant (`agent-gh allow release <tag>`)",
  );
  await run('query { repository(owner: "johnrees", name: "widget") { releases(first: 1) { nodes { tagName } } } }', granted);
  expect(calls).toEqual([
    `gh api graphql -f query=${create(COMMIT)}`,
    `gh api graphql -f query=${nested} -F input[repositoryId]=R_widget -F input[name]=refs/tags/v1.2.3 -F input[oid]=${COMMIT}`,
    'ungated gh api graphql -f query=query { repository(owner: "johnrees", name: "widget") { releases(first: 1) { nodes { tagName } } } }',
  ]);
});
