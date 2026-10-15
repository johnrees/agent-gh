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
- **Instructions**: adds a managed block to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`, and `~/.pi/agent/AGENTS.md`: run plain `gh`; if it says it is not logged in, run `agent-gh <gh arguments>`, or read with `GH_TOKEN=$(agent-gh read-token) gh ...`; never ask for `gh auth login`; where a repository opts in to reviews, run `agent-gh review full` before marking a pull request ready; and answer each finding and notify with `agent-gh reply`.

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

Where git runs hooks from config (`git hook list` exists), `install-shims` sets `hook.agent-gh.command` and `hook.agent-gh.event=commit-msg` globally, so every repository on the machine credits agent sessions with no setup of its own; `git config hook.agent-gh.enabled false` turns it off in one repository. It also sets `hook.agent-gh-push` for `pre-push`: an agent session's push to the repository's default branch, or to a branch a ruleset or classic protection requires status checks on, is refused, since agents act as John and John may bypass those rules. A push whose GitHub repository or rules cannot be told is refused too; a remote on a local path is not held, and a person's pushes never are. It runs before a repository's own hook, and the trailers are replaced or skipped when already there, so both together credit a commit once. Older gits, Apple's among them, need the repository hooks below; `doctor --machine` checks the commit and push hooks apart, and says which applies. This repository has one in `.githooks` (`git config core.hooksPath .githooks`).

```sh
# .githooks/commit-msg (with git config core.hooksPath .githooks)
command -v agent-gh > /dev/null || exit 0
exec agent-gh guard commit-msg "$1"
```

```sh
# .githooks/pre-push
command -v agent-gh > /dev/null || exit 0
exec agent-gh guard pre-push "$@"
```

A machine without agent-gh, such as a cloud agent's, skips it, and `--no-verify` skips it anywhere. An empty message still aborts the commit. An older pre-push hook that runs `agent-gh guard pre-push` without git's arguments refuses an agent's push to a GitHub branch; pass it `"$@"`.

## Apps

`agent-gh setup <family>` (or `read`), in your own terminal, creates the App from a manifest and prints what is left: install it on repositories, enable device flow, log in, and commit its `apps.json` line, which is how other machines find it. `agent-gh settings <family>` prints its pages; GitHub has no API for an App's permissions or repositories. Each machine keeps John's user tokens in `~/.config/agent-gh/` (mode 600); they refresh for six months, and the App keys are never needed day to day.

## Reviews

A repository opts in to cross-family review by committing `.github/agent-review.json` to its base branch. There, in an agent session, the gh shim refuses `gh pr ready` until the pull request's current head has a successful `agent-review` status, so work is reviewed before CI runs on it. A review that `block_on` blocks sets a failing status, and the refusal names it: answer the findings, push a fix, and review the new head. It also refuses while a comment waits for an agent's answer (the `agent-threads` rule below), naming each. A repository without the file, and a person's own `gh`, are never gated.

- `agent-gh review full` reviews the pushed head of the branch's pull request against the issue it closes (or `--issue N`), from the merge base GitHub reports for the pull request's own repository. First it runs the config's `checks` itself, in order until one fails or runs past `checks_timeout_minutes` (stopped with everything it started), in a throwaway `git clone --shared` of the head, which has its own `.git`, so nothing they write reaches the caller's repository. In that clone `origin` is the repository on GitHub, and `origin/<base>` is the pull request's merge base as GitHub reports it, however stale the caller's own base branch is; each check also gets `AGENT_GH_BASE` (the merge base's sha) and `AGENT_GH_BASE_REF` (`origin/<base>`), so a check that diffs against the base need not guess it. Then it runs the first configured reviewer from another family than the author's (or the config's `pin`), with the checks' result and the last `checks_output_lines` lines of their output, the issue, its last comment, the pull request's description, and the repository's checklist. The author is the family App every commit since the merge base credits as `Co-authored-by`; when they credit none or a mix, the session's family, and it says which. The reviewer only reads: Codex in its read-only sandbox, Claude restricted to git's read commands. It posts the findings as a pull request review (a comment: agents act as John, who cannot approve his own pull requests), each on its line where the diff shows that line and otherwise in the body, and sets the status on that head: failure when `block_on` blocks the review, else success, with "checks passed", "failed", "timed out", or "not run" and the command that did not pass; the checks' output reaches only the reviewer unless `post_checks_output` is set. A new commit needs a new review.
- The prompt defines the finding priorities (P0: loss of funds, keys, or data, or a security hole; P1: shipped behaviour, or a claim the change makes, is wrong; P2: a concrete defect, or new behaviour with no test, where a real failure path exists; P3: wording, style, or tests for unlikely regressions) and states `block_on`, so the verdict agrees with the status.
- A re-review is incremental. When the pull request has an earlier review (the latest valid marker, as the workflow counts them), the reviewer gets its head, its findings, and the author's comments since, and judges `git diff <earlier head>...<head>`; on code unchanged since then it raises new findings only at P0 or P1, and raises an earlier finding again only when nothing has fixed it and no reply answers it. When the earlier head is no longer in the branch's history (a force-push or rebase), it is a full review, and the prompt says so.
- The review's body starts with a marker, `<!-- agent-review {...} -->`, holding the full head sha, the merge base, the `git patch-id --stable` of the diff, the verdict, the checks' result, the reviewer's family, and the findings' priorities (`"priorities": ["P2", "P3"]`) as one JSON object.
- Each finding's comment, or its line of the body, carries `<!-- agent-finding {"v":1,"id":"<hex>","priority":"P2"} -->`; `review full` prints the findings as JSON with those ids, for `agent-gh reply` (below).
- `agent-gh review sweep` is a quick bug sweep of the branch with no ticket; it runs no checks, and prints and records nothing.
- Effort comes from the ticket's labels through the config's rules (`--effort` overrides). Reviewers are the `codex` and `claude` CLIs on PATH.
- John waives the review of one pull request by adding the waiver label himself. A label an agent adds, through its App, waives nothing; `review full` then records "waived by" on the status, and reads the label again before it sets the status, so a waiver added while it ran stands.

In any repository, an agent session's `gh pr merge`, and a `gh api` call that merges a pull request (a REST merge, or the GraphQL `mergePullRequest`, `enablePullRequestAutoMerge`, or `enqueuePullRequest`), runs only when every status check its base branch requires, by ruleset or classic branch protection, has passed on the pull request's head; `--admin`, merges outside a pull request, and a `gh api` call the guard cannot read are refused. Auto-merge (`gh pr merge --auto`, or GraphQL `enablePullRequestAutoMerge`) is let through while checks are pending or failing, since GitHub completes it only once they pass, even for a bypass actor. The merge then requires the head whose checks passed (gh's `--match-head-commit`, REST's `sha`, or, which a GraphQL merge must give itself, `expectedHeadOid`), so a commit pushed meanwhile is not merged in its place. Agents act as John, who may bypass those rules, so without this an agent's merge would skip them. A check a rule ties to one App counts only that App's check runs, and the statuses its bot set (GitHub Actions' `github-actions[bot]` for the workflow's).

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

`status_writer` says who sets `agent-review`: `"agent"` (the default), `review full` itself, or `"actions"`, the repository's agent-review workflow (below). With `"actions"`, `review full` posts the review and its marker but no status, then waits up to a minute for the workflow's status and prints it; a slow workflow is reported, not a failure. Releases before it refuse the key, so they fail closed.

`block_on` says what fails the status. `"changes_requested"`, the default, fails a review whose verdict requested changes. `"P0"`, `"P1"`, `"P2"`, or `"P3"` fails one with any finding at that priority or above, whatever the verdict, so at `"P2"` a review with only P3 findings passes; a marker from a release before priorities were recorded has none, and fails. Releases before a value refuse it, so they refuse to review or to pass `gh pr ready`, and the workflow sets an error status, rather than pass a review they cannot judge. `checks_output_lines` (default 60) is how much of the checks' output the reviewer sees; `post_checks_output` (default false) also shows it on the review, which suits only checks that print nothing private. `checks_timeout_minutes` defaults to 30.

The family Apps need the Commit statuses permission (write; the read App, read). An App created before it needs it added on its permissions page (`agent-gh settings <family>` prints the link), and each installation must accept the change; until then `review full` posts its review but cannot set the status.

The first rule whose label patterns (`*` matches anything) all match one of the ticket's labels sets the effort. The config is read from the pull request's base branch, so a branch cannot switch off its own review. Without the workflow, the status is set by the agent that asked for the review: it shows that a review was recorded, not that nobody could forge one. With it, a ruleset can require the status from GitHub Actions alone.

### Statuses from GitHub Actions

A repository adds this workflow (and `"status_writer": "actions"` in its config) to have GitHub Actions set two statuses on each pull request's head with the run's `GITHUB_TOKEN`. Each run derives both from GitHub as it stands, so it needs no state of its own.

```yaml
# .github/workflows/agent-review.yml
name: agent-review
on:
  pull_request_target:
    types: [opened, edited, synchronize, reopened, ready_for_review, labeled, unlabeled] # edited: a new closing issue
  pull_request_review:
  issue_comment:
permissions: {}
jobs:
  agent-review:
    uses: johnrees/agent-gh/.github/workflows/agent-review.yml@v0.8.0
    with:
      version: v0.8.0 # the agent-gh release that sets the statuses
    # Declaring permissions drops the defaults, so each read is named, though nothing is checked out:
    # contents (the config, compare, fetching commits), pull-requests (the PR, its commits and reviews),
    # issues (comments, labels' events, reactions, closing issues), statuses (read and set them).
    permissions:
      contents: read
      issues: read
      pull-requests: read
      statuses: write
```

- **`agent-review`**: success "not an agent PR" when the author is a bot that is not a family App (Dependabot), or no commit has an `Agent-*` trailer or credits a family App or Claude as co-author (and the pull request was not opened through a family App). Else success "waived by <login>" when a person, not an App, added the waiver label. Else the latest valid marker for the current head, judged by `block_on`. A marker is valid in a review or comment by the repository's owner; a comment must come through a family App in `apps.json`, and a review must only be the owner's, since GitHub records no App for a review. With no marker for the head, a review carries forward from the latest marker for the same patch id, when that review passes `block_on` and `git diff --name-only <its merge base> <the new merge base>` touches none of the patch's files. Otherwise it is pending: "needs a review: run `gh pr checkout N && agent-gh review full --pr N`".
- **`agent-threads`**: success unless a comment waits for an agent's answer: an agent's P0 to P2 notify (`<!-- agent-notify {"v":1,"id":"<hex>","severity":"P1"} -->`) with no agent reply (`<!-- agent-reply {"v":1,"to":"<hex>"} -->`), or the owner's own comment, posted after the pull request was opened, on its conversation or an issue it closes, that is newer than the last comment an agent posted on that thread. The owner's 👍 on his own comment clears it. Only conversation comments count: GitHub records no App for inline review comments, so the ruleset's conversation resolution covers those. `gh pr ready` uses the same rule. A 👍 starts no workflow run, so the status catches up on the next event.
- **Events and runs**: a pull request's events, a review, or a comment (on the pull request, or on an issue it closes) start a run. Runs are grouped per pull request (per issue for an issue's comment, whose group cannot name its pull requests) and cancel in progress, so the newest replaces an older one; and each run derives the statuses again after writing them, and rewrites them if the pull request changed meanwhile, so an older run in another group never leaves its result over a newer one. A status GitHub Actions already set the same is not set again; one an agent set is replaced. A pull request with GitHub's limit of 250 listed commits counts as an agent's.
- **Scopes**: the job's token reads the config and compares commits (`contents`), the pull request, its commits and reviews (`pull-requests`), comments, label events, reactions, and closing issues (`issues`), and reads and sets statuses (`statuses`). An issue a pull request closes in another private repository is beyond that token, and the run fails rather than pass without it.
- **What it runs**: a released agent-gh checked against the release's `SHA256SUMS`, never the pull request's code. Carry-forward fetches the commits it compares, one deep, into a scratch repository, and only diffs them.
- **Forks**: supported. `pull_request_target` runs the base branch's workflow with a token that can set statuses, so a pull request cannot rewrite the workflow that judges it either. `pull_request_review` runs the pull request's own copy of the workflow, read-only for a fork; that run reports it cannot set statuses, and the next `pull_request_target` or `issue_comment` run sets them. Review a change to `.github/workflows/` itself by hand.

To make both required: in the repository's settings, Rules, Rulesets, edit the default branch's ruleset, turn on "Require status checks to pass", add `agent-review` and `agent-threads`, and choose GitHub Actions as each one's source (its `integration_id` is 15368). An agent's App token then cannot set a status that satisfies them, and an agent's `gh pr merge` waits for those GitHub Actions statuses too.

## Notify and reply

- `agent-gh reply <finding> --applied <sha> | --declined "<why>" [--pr N]` answers a review finding or a notify. `<finding>` is its id, looked up on `--pr` or the current branch's pull request and the issues it closes, or the URL of its review comment, review, or conversation comment, or its review thread's id (`PRRT_...`). A finding with a review thread is answered in that thread, which is then resolved; John can unresolve it to reopen. One only in a review's body, which has no thread, gets a pull request comment that links the review and quotes it; a notify gets a comment on its own thread. `--applied` takes a commit on the pull request's head branch (one of its commits since the base), and is refused otherwise; `--declined` needs a reason. Review threads exist only in GitHub's GraphQL API, which some proxies (Claude cloud's) reject, so reply runs locally.
- `agent-gh notify <issue or pr> --severity P0|P1|P2 --body "<text>" | --body-file <file|-> [--from <issue or pr>]` posts a finding on another thread, linked back to `--from` or the current branch's pull request, and refuses without one. A P3 needs no answer, so it is no notify. Its id is a hash of its thread and text, so the same notify twice is refused. Its marker, `<!-- agent-notify {"v":1,"id":"<hex>","severity":"P1","session":"claude:<id>"} -->`, names the harness session that sent it where the harness tells (Claude Code, Codex, pi).
- A reply carries `<!-- agent-reply {"v":1,"to":"<id>"} -->` (with the session too) and never needs an answer itself; neither command posts text holding an agent-gh marker of its own, so two agents cannot start a loop.

## Development

`bun test` (offline: a fake GitHub API, real throwaway repositories and hooks, the shim under real shells, and `install.sh` against a fake release), `bun run typecheck`, `bun run build`. `bun run install-local` installs a checkout's build. A `v*` tag publishes a release with `SHA256SUMS`.
