# agent-gh

Agents publish to GitHub as John through one GitHub App per model family (claude, codex, glm, deepseek, kimi, qwen), whatever harness runs them. GitHub shows each issue, comment, review, and pull request as John with the App's badge, and each commit as John with the App as co-author. Agents run plain `gh` and `git`; nothing asks them to choose a method or an identity.

- **gh**: in an agent session, the gh shim runs every `gh` command through the session family's App. It never falls back to John's own login. A command that names a repository (`--repo`, `GH_REPO`, or a clone's github.com `origin`) first checks that the App is installed there, so a refusal says why; one that names none (`gh api user`, `gh search`, `gh repo clone` outside a clone) runs as it is, and GitHub refuses whatever the App cannot reach.
- **Commits**: a global `commit-msg` hook (git's config-based hooks, set by `install-shims`), or a repository's own, adds `Agent-Harness` (with `Agent-Model` and `Agent-Effort` when the harness reports them) and `Co-authored-by: johnrees-<family>[bot]` to an agent session's commits. A person's commits, and repositories with no github.com remote, are left as written.
- **Pushes**: on a machine you use, git pushes with your own login. On an agent machine, GitHub remotes use HTTPS, an agent session's git uses its family's App wherever that App is installed and the read-only App (`johnrees-read`) elsewhere, and anyone else's git only reads.

## Install

In your own terminal, on macOS or Linux (arm64 or x64); on a machine that only runs agents, add `-s -- --agent-machine`:

```sh
curl -fsSL https://raw.githubusercontent.com/johnrees/agent-gh/main/install.sh | bash
```

It installs the checked release and gitleaks in `~/.local/bin`, logs in each App (you enter the device-flow codes it prints), puts the gh shim first on PATH, tells the agent harnesses installed here how to reach it (below), and ends with `agent-gh doctor --machine`, whose every failure names its fix. A rerun updates everything. `agent-gh doctor`, from an agent session in a repository, checks who is acting and the App's access there. `AGENT_GH_FAMILIES=claude,codex` limits the logins.

## Agents find the shim

Shell startup files are not enough on their own: a harness may start its tools from a snapshot of the environment it was launched in, and a version manager (mise, asdf, Homebrew's shellenv, Nix) can put its own gh back ahead of the shim after the startup files run. So `install-shims` also, for each harness that has run on the machine (its directory exists):

- **Claude Code**: adds a SessionStart hook to `~/.claude/settings.json`, `agent-gh session-env`, which writes the PATH block to `CLAUDE_ENV_FILE`; Claude Code sources it before every command.
- **Instructions**: adds a managed block to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`, and `~/.pi/agent/AGENTS.md`: run plain `gh`; if it says it is not logged in, run `agent-gh <gh arguments>`, or read with `GH_TOKEN=$(agent-gh read-token) gh ...`; never ask for `gh auth login`.

`doctor --machine` checks both, and when another gh comes first it names the version manager responsible.

## Who is acting

The harness is found from a variable it sets for its tools, and the family from the model the harness reports. Where a harness reports none, the session declares it with `AGENT_GH_MODEL`; agent-gh never guesses, and its refusal names the setting to add.

| Harness | Detected by | Model from |
| --- | --- | --- |
| Claude Code | `CLAUDECODE=1` with `CLAUDE_CODE_CHILD_SESSION` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_*_MODEL`; effort from `CLAUDE_EFFORT` |
| Codex | `CODEX_THREAD_ID` or `CODEX_SESSION_ID` | openai, else `AGENT_GH_MODEL` via `shell_environment_policy` |
| pi | `PI_SESSION_ID` | `PI_MODEL`, `PI_PROVIDER`; effort from `PI_REASONING_LEVEL` |
| opencode | `OPENCODE_TERMINAL=1` | `AGENT_GH_MODEL`, set when it starts |

## Repository hooks

Where git runs hooks from config (`git hook list` exists), `install-shims` sets `hook.agent-gh.command` and `hook.agent-gh.event=commit-msg` globally, so every repository on the machine credits agent sessions with no setup of its own; `git config hook.agent-gh.enabled false` turns it off in one repository. It runs before a repository's own hook, and the trailers are replaced or skipped when already there, so both together credit a commit once. Older gits, Apple's among them, need the repository hook below; `doctor --machine` says which applies. This repository has one in `.githooks` (`git config core.hooksPath .githooks`).

```sh
# .githooks/commit-msg (with git config core.hooksPath .githooks)
command -v agent-gh > /dev/null || exit 0
exec agent-gh guard commit-msg "$1"
```

A machine without agent-gh, such as a cloud agent's, skips it, and `--no-verify` skips it anywhere. An empty message still aborts the commit. `agent-gh guard pre-push` passes and is kept only for older hooks.

## Apps

`agent-gh setup <family>` (or `read`), in your own terminal, creates the App from a manifest and prints what is left: install it on repositories, enable device flow, log in, and commit its `apps.json` line, which is how other machines find it. `agent-gh settings <family>` prints its pages; GitHub has no API for an App's permissions or repositories. Each machine keeps John's user tokens in `~/.config/agent-gh/` (mode 600); they refresh for six months, and the App keys are never needed day to day.

## Reviews

A repository opts in to cross-family review by committing `.github/agent-review.json` to its base branch. There, in an agent session, the gh shim refuses `gh pr ready` until the pull request's current head has a successful `agent-review` status, so work is reviewed before CI runs on it. A review that requested changes sets a failing status, and the refusal names it: answer the findings, push a fix, and review the new head. A repository without the file, and a person's own `gh`, are never gated.

- `agent-gh review full` reviews the pushed head of the branch's pull request against the issue it closes (or `--issue N`), from the merge base GitHub reports for the pull request's own repository. First it runs the config's `checks` itself, in order until one fails or runs past `checks_timeout_minutes` (stopped with everything it started), in a throwaway `git clone --shared` of the head, which has its own `.git`, so nothing they write reaches the caller's repository. Then it runs the first configured reviewer from another family than the author's (or the config's `pin`), with the checks' result and the last `checks_output_lines` lines of their output, the issue, its last comment, the pull request's description, and the repository's checklist. The author is the family App every commit since the merge base credits as `Co-authored-by`; when they credit none or a mix, the session's family, and it says which. The reviewer only reads: Codex in its read-only sandbox, Claude restricted to git's read commands. It posts the findings as a pull request review (a comment: agents act as John, who cannot approve his own pull requests), each on its line where the diff shows that line and otherwise in the body, and sets the status on that head: failure for a `changes_requested` verdict, success for `approve`, with "checks passed", "failed", "timed out", or "not run" and the command that did not pass; the checks' output reaches only the reviewer unless `post_checks_output` is set. A new commit needs a new review.
- The review's body starts with a marker, `<!-- agent-review {...} -->`, holding the full head sha, the merge base, the `git patch-id --stable` of the diff, the verdict, the checks' result, and the reviewer's family as one JSON object.
- `agent-gh review sweep` is a quick bug sweep of the branch with no ticket; it runs no checks, and prints and records nothing.
- Effort comes from the ticket's labels through the config's rules (`--effort` overrides). Reviewers are the `codex` and `claude` CLIs on PATH.
- John waives the review of one pull request by adding the waiver label himself. A label an agent adds, through its App, waives nothing; `review full` then records "waived by" on the status, and reads the label again before it sets the status, so a waiver added while it ran stands.

In any repository, an agent session's `gh pr merge`, and a `gh api` call that merges a pull request (a REST merge, or the GraphQL `mergePullRequest`, `enablePullRequestAutoMerge`, or `enqueuePullRequest`), runs only when every status check its base branch requires, by ruleset or classic branch protection, has passed on the pull request's head; `--admin`, merges outside a pull request, and a `gh api` call the guard cannot read are refused. The merge then requires the head whose checks passed (gh's `--match-head-commit`, REST's `sha`, or, which a GraphQL merge must give itself, `expectedHeadOid`), so a commit pushed meanwhile is not merged in its place. Agents act as John, who may bypass those rules, so without this an agent's merge would skip them. A check a rule ties to one App counts only that App's check runs.

```json
{
  "reviewers": { "codex": { "model": "gpt-6-astra" }, "claude": { "model": "claude-opus-5-5" } },
  "effort": {
    "default": "high",
    "rules": [
      { "labels": ["model:fable-*"], "effort": "xhigh" },
      { "labels": ["model:opus-*", "effort:xhigh"], "effort": "xhigh" }
    ]
  },
  "checklist": "docs/agents/review-checklist.md",
  "checks": ["make check"],
  "checks_output_lines": 60,
  "checks_timeout_minutes": 30,
  "post_checks_output": false,
  "waiver_label": "review-waived",
  "block_on": "changes_requested"
}
```

`block_on` names the verdict that fails the status; `changes_requested` is its only value and the default. Setting it makes releases before it, which refuse a config key they do not know, refuse to review or to pass `gh pr ready` rather than pass a review that requested changes. `checks_output_lines` (default 60) is how much of the checks' output the reviewer sees; `post_checks_output` (default false) also shows it on the review, which suits only checks that print nothing private. `checks_timeout_minutes` defaults to 30.

The family Apps need the Commit statuses permission (write; the read App, read). An App created before it needs it added on its permissions page (`agent-gh settings <family>` prints the link), and each installation must accept the change; until then `review full` posts its review but cannot set the status.

The first rule whose label patterns (`*` matches anything) all match one of the ticket's labels sets the effort. The config is read from the pull request's base branch, so a branch cannot switch off its own review. The status is set by the agent that asked for the review: it shows that a review was recorded, not that nobody could forge one. A branch ruleset that requires `agent-review` makes it a merge condition too.

## Development

`bun test` (offline: a fake GitHub API, real throwaway repositories and hooks, the shim under real shells, and `install.sh` against a fake release), `bun run typecheck`, `bun run build`. `bun run install-local` installs a checkout's build. A `v*` tag publishes a release with `SHA256SUMS`.
