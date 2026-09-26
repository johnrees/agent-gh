import { expect, test } from "bun:test";
import { join } from "node:path";
import { bareWrite } from "../src/hook.ts";

test("bare GitHub writes and commit-making git are found wherever they sit in a command line", () => {
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
    ["git push origin main", "git push"],
    ["git -C /tmp/repo push", "git push"],
    ["git -c core.x=y push -u origin b", "git push"],
    ["cd crates && gh pr create", "gh pr create"],
    ["make test; gh issue comment 1 -b done", "gh issue comment"],
    ["FOO=1 gh pr ready 2", "gh pr ready"],
    ["env GH_REPO=a/b gh issue close 1", "gh issue close"],
    ["/opt/homebrew/bin/gh pr merge 1", "gh pr merge"],
    ["echo $(gh pr create --fill)", "gh pr create"],
    ["git status\ngit push", "git push"],
    ["git commit -m 'git push later'", "git commit"],
    ["git -C /r commit --amend --no-edit", "git commit"],
    ["git -c core.hooksPath=/dev/null commit -am x", "git commit"],
    ["git merge feature", "git merge"],
    ["git merge --continue", "git merge"],
    ["git pull --rebase", "git pull"],
    ["git cherry-pick abc123", "git cherry-pick"],
    ["git revert HEAD", "git revert"],
    ["git rebase -i main", "git rebase"],
    ["git rebase --continue", "git rebase"],
    ["git am < fix.patch", "git am"],
    ["cargo test && git commit -m done", "git commit"],
  ];
  for (const [command, write] of denied) expect([command, bareWrite(command)]).toEqual([command, write]);
});

test("reads, agent-gh, and mentions are allowed", () => {
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

  const commit = await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }));
  const commitReason = JSON.parse(commit.stdout).hookSpecificOutput.permissionDecisionReason;
  expect(commitReason).toBe(
    "git commit would be authored as John. Run it as `agent-gh git commit ...` so this agent's bot is the author and a commit carries the Agent-* trailers.",
  );

  const allowed = await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "agent-gh pr create" } }));
  expect([allowed.code, allowed.stdout]).toEqual([0, ""]);
  const other = await hook(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "x" } }));
  expect([other.code, other.stdout]).toEqual([0, ""]);
  const broken = await hook("not json");
  expect(broken.code).toBe(1);
  expect(broken.stderr).toContain("was not checked");
});
