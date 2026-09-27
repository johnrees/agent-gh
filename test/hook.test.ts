import { expect, test } from "bun:test";
import { join } from "node:path";
import { bareWrite } from "../src/hook.ts";

test("bare GitHub writes through gh are found wherever they sit in a command line", () => {
  const denied: [string, string][] = [
    ["gh pr create --draft --title x", "gh pr create"],
    ["gh pr edit 3 --body y", "gh pr edit"],
    ["gh pr comment 3 -b hi", "gh pr comment"],
    ["gh pr merge 3 --squash", "gh pr merge"],
    ["gh pr ready 3", "gh pr ready"],
    ["gh pr review 3 --approve", "gh pr review"],
    ["gh issue create -t x -b y", "gh issue create"],
    ["gh issue edit 5 --add-label a", "gh issue edit"],
    ["gh issue comment 5 --body-file f", "gh issue comment"],
    ["gh issue close 5", "gh issue close"],
    ["gh release create v1", "gh release create"],
    ["gh repo create johnrees/x --private", "gh repo create"],
    ["gh api -X POST repos/a/b/issues", "gh api (a write)"],
    ["gh api --method=PATCH repos/a/b", "gh api (a write)"],
    ["gh api -XDELETE repos/a/b/labels/x", "gh api (a write)"],
    ["gh api repos/a/b/issues -f title=x", "gh api (a write)"],
    ["gh api graphql -f query='mutation { x }'", "gh api (a write)"],
    ["cd crates && gh pr create", "gh pr create"],
    ["make test; gh issue comment 1 -b done", "gh issue comment"],
    ["FOO=1 gh pr ready 2", "gh pr ready"],
    ["env GH_REPO=a/b gh issue close 1", "gh issue close"],
    ["/opt/homebrew/bin/gh pr merge 1", "gh pr merge"],
    ["echo $(gh pr create --fill)", "gh pr create"],
    ["git status\ngh pr ready 4", "gh pr ready"],
  ];
  for (const [command, write] of denied) expect([command, bareWrite(command)]).toEqual([command, write]);
});

test("gh reads, agent-gh, mentions, and every git command are allowed", () => {
  for (const command of [
    "gh pr view 3",
    "gh pr checks 3 --watch",
    "gh issue list --state all",
    "gh api repos/a/b/pulls",
    "gh api -X GET repos/a/b -f per_page=100",
    "gh api graphql -f query='{ viewer { login } }'",
    "agent-gh pr create --draft",
    "agent-gh git push -u origin b",
    "cd x && agent-gh issue comment 1 -b ok",
    "echo 'gh pr create'",
    "git log --oneline",
    "git status",
    "git diff --stat",
    "git show HEAD",
    "git fetch origin",
    "git branch -a",
    "git worktree list",
    "git merge --abort",
    "git rebase --abort",
    "git cherry-pick --quit",
    "agent-gh git commit -m 'git push later'",
    "agent-gh git rebase main",
    "rg 'gh pr merge' docs",
    "git push origin main",
    "git -C /r commit --amend --no-edit",
    "git commit -m 'gh pr create later'",
    "cargo test && git commit -m done",
    "git merge feature",
    "git rebase --continue",
  ]) {
    expect([command, bareWrite(command)]).toEqual([command, undefined]);
  }
});

const hook = async (input: string) => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "hooks", "deny-bare-gh.ts")], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

test("the hook script denies with Claude Code's PreToolUse decision", async () => {
  const denied = await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr create --draft" } }));
  expect(denied.code).toBe(0);
  const output = JSON.parse(denied.stdout).hookSpecificOutput;
  expect(output.hookEventName).toBe("PreToolUse");
  expect(output.permissionDecision).toBe("deny");
  expect(output.permissionDecisionReason).toContain("agent-gh pr create");

  const commit = await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -m x && git push" } }));
  expect([commit.code, commit.stdout]).toEqual([0, ""]);

  const allowed = await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "agent-gh pr create" } }));
  expect([allowed.code, allowed.stdout]).toEqual([0, ""]);
  const other = await hook(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "x" } }));
  expect([other.code, other.stdout]).toEqual([0, ""]);
  const broken = await hook("not json");
  expect(broken.code).toBe(1);
  expect(broken.stderr).toContain("was not checked");
});
