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
- **Instructions**: adds a managed block to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`, and `~/.pi/agent/AGENTS.md`: run plain `gh`; if it says it is not logged in, run `agent-gh <gh arguments>`, or read with `GH_TOKEN=$(agent-gh read-token) gh ...`; never ask for `gh auth login`; where a repository opts in to reviews, run `agent-gh review full` before marking a pull request ready; answer each finding and notify with `agent-gh reply`; never push a tag or write a release unless John has run `agent-gh allow release <tag>` for it; and, to call John in, post the question as one comment whose first line is the ask, then add `needs-human`, never removing it or adding the release label.

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

Where git runs hooks from config (`git hook list` exists), `install-shims` sets `hook.agent-gh.command` and `hook.agent-gh.event=commit-msg` globally, so every repository on the machine credits agent sessions with no setup of its own; `git config hook.agent-gh.enabled false` turns it off in one repository. It also sets `hook.agent-gh-push` for `pre-push`: an agent session's push to the repository's default branch, or to a branch a ruleset or classic protection requires status checks on, is refused, since agents act as John and John may bypass those rules. So is a new tag John has not granted, and deleting or moving any tag ([Releases](#releases)). A push whose GitHub repository or rules cannot be told is refused too; a remote on a local path is not held, and a person's pushes never are. It runs before a repository's own hook, and the trailers are replaced or skipped when already there, so both together credit a commit once. Older gits, Apple's among them, need the repository hooks below; `doctor --machine` checks the commit and push hooks apart, and says which applies. This repository has one in `.githooks` (`git config core.hooksPath .githooks`).

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

A repository opts in to cross-family review by committing `.github/agent-review.json` to its base branch. There, in an agent session, the gh shim refuses `gh pr ready` until the pull request's current head has a successful `agent-review` status, so work is reviewed before CI runs on it. A review that `block_on` blocks, or whose checks did not pass, sets a failing status, and the refusal names it: answer the findings, push a fix, and review the new head (or this head again, when its checks only timed out). It also refuses while a comment waits for an agent's answer (the `agent-threads` rule below), naming each. A repository without the file, and a person's own `gh`, are never gated.

- `agent-gh review full` reviews the pushed head of the branch's pull request against the issue it closes (or `--issue N`), from the merge base GitHub reports for the pull request's own repository. First it runs the config's `checks` itself, in order until one fails or runs past `checks_timeout_minutes` (stopped with everything it started), in a throwaway `git clone --shared` of the head, which has its own `.git`, so nothing they write reaches the caller's repository. In that clone `origin` is the repository on GitHub, and `origin/<base>` is the pull request's merge base as GitHub reports it, however stale the caller's own base branch is; each check also gets `AGENT_GH_BASE` (the merge base's sha) and `AGENT_GH_BASE_REF` (`origin/<base>`), so a check that diffs against the base need not guess it. Then it runs the first configured reviewer from another family than the author's (or the config's `pin`), with the checks' result and the last `checks_output_lines` lines of their output, the issue, its last comment, the pull request's description, and the repository's checklist. The author is the family App every commit since the merge base credits as `Co-authored-by`; when they credit none or a mix, the session's family, and it says which. The reviewer only reads: Codex in its read-only sandbox, Claude restricted to git's read commands. It posts the findings as a pull request review (a comment: agents act as John, who cannot approve his own pull requests), each on its line where the diff shows that line and otherwise in the body, and sets the status on that head: failure when `block_on` blocks the review or its checks failed, timed out, or did not run though the config names some ("checks unverified: …" leads the description when only a timeout or a missing run fails it), else success, with "checks passed", "failed", "timed out", or "not run" and the command that did not pass; a repository that names no checks is judged on the review alone, and the checks' output reaches only the reviewer unless `post_checks_output` is set. Unverified checks fail the status rather than leave it pending, since the review has finished and pending means a result is still to come. A new commit needs a new review.
- The prompt defines the finding priorities (P0: loss of funds, keys, or data, or a security hole; P1: shipped behaviour, or a claim the change makes, is wrong; P2: a concrete defect, or new behaviour with no test, where a real failure path exists; P3: wording, style, or tests for unlikely regressions) and states `block_on`, so the verdict agrees with the status.
- A re-review is incremental. When the pull request has an earlier review (the latest valid marker, as the workflow counts them), the reviewer gets its head, its findings, and the author's comments since, and judges `git diff <earlier head>...<head>`; on code unchanged since then it raises new findings only at P0 or P1, and raises an earlier finding again only when nothing has fixed it and no reply answers it. When the earlier head is no longer in the branch's history (a force-push or rebase), it is a full review, and the prompt says so.
- The review's body starts with a marker, `<!-- agent-review {...} -->`, holding the full head sha, the merge base, the `git patch-id --stable` of the diff, the verdict, the checks' result, the reviewer's family, and the findings' priorities (`"priorities": ["P2", "P3"]`) as one JSON object.
- Each finding's comment, or its line of the body, carries `<!-- agent-finding {"v":1,"id":"<hex>","priority":"P2"} -->`; `review full` prints the findings as JSON with those ids, for `agent-gh reply` (below).
- `agent-gh review sweep` is a quick bug sweep of the branch with no ticket; it runs no checks, and prints and records nothing.
- Effort comes from the ticket's labels through the config's rules (`--effort` overrides). Reviewers are the `codex` and `claude` CLIs on PATH.
- John waives the review of one pull request by adding the waiver label himself. A label an agent adds, through its App, waives nothing; `review full` then records "waived by" on the status, and reads the label again before it sets the status, so a waiver added while it ran stands.

In any repository, an agent session's `gh pr merge`, and a `gh api` call that merges a pull request (a REST merge, or the GraphQL `mergePullRequest`, `enablePullRequestAutoMerge`, or `enqueuePullRequest`), runs only when every status check its base branch requires, by ruleset or classic branch protection, has passed on the pull request's head; `--admin`, merges outside a pull request, and a `gh api` call the guard cannot read are refused. Auto-merge (`gh pr merge --auto`, or GraphQL `enablePullRequestAutoMerge`) is let through while checks are pending or failing, since GitHub completes it only once they pass, even for a bypass actor. The merge then requires the head whose checks passed (gh's `--match-head-commit`, REST's `sha`, or, which a GraphQL merge must give itself, `expectedHeadOid`), so a commit pushed meanwhile is not merged in its place. Agents act as John, who may bypass those rules, so without this an agent's merge would skip them. A check a rule ties to one App counts only that App's check runs, and the statuses its bot set (GitHub Actions' `github-actions[bot]` for the workflow's). Where the base branch's config has `hold`, the merge also needs `agent-hold` to pass ([Holds](#holds)).

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
  "block_on": "changes_requested",
  "status_writer": "actions",
  "hold": { "label": "needs-human", "release_label": "human-approved", "paths": ["docs/security-claims.md", "schema/**", ".github/**"] }
}
```

`status_writer` says who sets `agent-review`: `"agent"` (the default), `review full` itself, or `"actions"`, the repository's agent-review workflow (below). With `"actions"`, `review full` posts the review and its marker but no status, then waits up to a minute for the workflow's status and prints it; a slow workflow is reported, not a failure. Releases before it refuse the key, so they fail closed.

`block_on` says what fails the status. `"changes_requested"`, the default, fails a review whose verdict requested changes. `"P0"`, `"P1"`, `"P2"`, or `"P3"` fails one with any finding at that priority or above, whatever the verdict, so at `"P2"` a review with only P3 findings passes; a marker from a release before priorities were recorded has none, and fails. Releases before a value refuse it, so they refuse to review or to pass `gh pr ready`, and the workflow sets an error status, rather than pass a review they cannot judge. `checks_output_lines` (default 60) is how much of the checks' output the reviewer sees; `post_checks_output` (default false) also shows it on the review, which suits only checks that print nothing private. `checks_timeout_minutes` defaults to 30.

`hold` holds a pull request for a person: once `label` (default `needs-human`) goes on it or on an issue it closes, or while its diff touches a file `paths` names (default none), the workflow fails `agent-hold`, and an agent's merge waits until a person releases it by adding `release_label` (default `human-approved`; [Holds](#holds)), which must differ from `label` and `waiver_label`. It needs `"status_writer": "actions"`, since otherwise the agent would set the status that holds it. Releases before v0.10.0 refuse the key, so a repository moves its agent-review workflow's pin to v0.10.0 or later, with the template's new event and its `issues: write` and `pull-requests: write`, before adding it.

The family Apps need the Commit statuses permission (write; the read App, read). An App created before it needs it added on its permissions page (`agent-gh settings <family>` prints the link), and each installation must accept the change; until then `review full` posts its review but cannot set the status.

The first rule whose label patterns (`*` matches anything) all match one of the ticket's labels sets the effort. The config is read from the pull request's base branch, so a branch cannot switch off its own review. Without the workflow, the status is set by the agent that asked for the review: it shows that a review was recorded, not that nobody could forge one. With it, a ruleset can require the status from GitHub Actions alone.

### Statuses from GitHub Actions

A repository adds this workflow (and `"status_writer": "actions"` in its config) to have GitHub Actions set two statuses on each pull request's head with the run's `GITHUB_TOKEN`, and a third, `agent-hold`, where the config has `hold` ([Holds](#holds)). Each run derives them from GitHub as it stands, so it needs no state of its own.

```yaml
# .github/workflows/agent-review.yml
name: agent-review
on:
  pull_request_target:
    types: [opened, edited, synchronize, reopened, ready_for_review, labeled, unlabeled] # edited: a new closing issue
  pull_request_review:
  issue_comment:
  issues:
    types: [labeled, unlabeled] # a hold's label on an issue holds the pull requests that close it
permissions: {}
jobs:
  agent-review:
    uses: johnrees/agent-gh/.github/workflows/agent-review.yml@v0.10.0
    with:
      version: v0.10.0 # the agent-gh release that sets the statuses
      # runs-on: ubicloud-standard-2 # only once this pin is a release that has the input
    secrets:
      NTFY_URL: ${{ secrets.NTFY_URL }} # optional: a hold's call is also pushed there
    # Declaring permissions drops the defaults, so each scope is named, though nothing is checked out:
    # contents (the config, compare, fetching commits), pull-requests (the PR, its commits, files, and reviews),
    # issues (comments, labels' events, reactions, closing issues), statuses (read and set them). The writes
    # to issues and pull-requests post a hold's call and release record.
    permissions:
      contents: read
      issues: write
      pull-requests: write
      statuses: write
```

Both reusable workflows (`agent-review.yml` and `agent-claims.yml`) take a `runs-on` input, default `ubuntu-latest`: a runner label (`ubicloud-standard-2`) or a JSON list of labels (`'["self-hosted","linux"]'`), Linux only, x86_64 or arm64. The job downloads the release asset for the runner's architecture and checks it against `SHA256SUMS`; another OS or architecture fails naming the input. A release before the one that added `runs-on` fails a caller that passes it (an undefined input), so a repository moves its workflow's pin and `version` to a release with it before uncommenting the line.

- **`agent-review`**: success "not an agent PR" when the author is a bot that is not a family App (Dependabot), or no commit has an `Agent-*` trailer or credits a family App or Claude as co-author (and the pull request was not opened through a family App). Else success "waived by <login>" when a person, not an App, added the waiver label. Else the latest valid marker for the current head, judged by `block_on` and its checks' result, as `review full` judges it. A marker is valid in a review or comment by the repository's owner; a comment must come through a family App in `apps.json`, and a review must only be the owner's, since GitHub records no App for a review. With no marker for the head, a review carries forward from the latest marker for the same patch id, when that review passes `block_on` and its checks (so a carried review never reads better than it did) and `git diff --name-only <its merge base> <the new merge base>` touches none of the patch's files. Otherwise it is pending: "needs a review: run `gh pr checkout N && agent-gh review full --pr N`".
- **`agent-threads`**: success unless a comment waits for an agent's answer: an agent's P0 to P2 notify (`<!-- agent-notify {"v":1,"id":"<hex>","severity":"P1"} -->`) with no agent reply (`<!-- agent-reply {"v":1,"to":"<hex>"} -->`), or the owner's own comment, posted after the pull request was opened, on its conversation or an issue it closes, that is newer than the last comment an agent posted on that thread. The owner's 👍 on his own comment clears it. Only conversation comments count: GitHub records no App for inline review comments, so the ruleset's conversation resolution covers those. `gh pr ready` uses the same rule. A 👍 starts no workflow run, so the status catches up on the next event.
- **Events and runs**: a pull request's events, a review, a comment (on the pull request, or on an issue it closes), or a label added to or removed from an issue start a run. Runs are grouped per pull request (per issue for an issue's comment or label, whose group cannot name its pull requests) and cancel in progress, so the newest replaces an older one; and each run derives the statuses again after writing them, and rewrites them if the pull request changed meanwhile, so an older run in another group never leaves its result over a newer one. A status GitHub Actions already set the same is not set again; one an agent set is replaced. A pull request with GitHub's limit of 250 listed commits counts as an agent's.
- **Scopes**: the job's token reads the config and compares commits (`contents`), the pull request, its commits, files, and reviews (`pull-requests`), and comments, label events, reactions, and closing issues (`issues`), and reads and sets statuses (`statuses`). It writes issues and pull requests only to post a hold's call and release record, as `github-actions[bot]`: a comment on a pull request's conversation needs `pull-requests: write` as well as `issues: write`. An issue a pull request closes in another private repository is beyond that token, and the run fails rather than pass without it.
- **What it runs**: a released agent-gh checked against the release's `SHA256SUMS`, never the pull request's code. Carry-forward fetches the commits it compares, one deep, into a scratch repository, and only diffs them.
- **Forks**: supported. `pull_request_target` runs the base branch's workflow with a token that can set statuses, so a pull request cannot rewrite the workflow that judges it either. `pull_request_review` runs the pull request's own copy of the workflow, read-only for a fork; that run reports it cannot set statuses, and the next `pull_request_target` or `issue_comment` run sets them. Review a change to `.github/workflows/` itself by hand.

To make them required: in the repository's settings, Rules, Rulesets, edit the default branch's ruleset, turn on "Require status checks to pass", add `agent-review` and `agent-threads` (and `agent-hold`, where the config has `hold`), and choose GitHub Actions as each one's source (its `integration_id` is 15368). An agent's App token then cannot set a status that satisfies them, and an agent's `gh pr merge` waits for those GitHub Actions statuses too.

### Holds

A pull request that needs John cannot be merged by an agent until a person releases it. Two things hold it, where the base branch's config has `hold`:

- **The label**, `needs-human`, on the pull request or on an issue it closes. An agent calls John in by posting its question as one comment whose first line is the ask, then adding the label. It holds from when it last went on until a person adds `human-approved` (to that thread or the pull request), whether or not the label is still on; adding it again holds again. Removing it releases nothing: GitHub records the App on a label's addition but not on its removal (checked live), so an agent's removal reads as John's.
- **A reserved path**: the diff touches a file `hold.paths` names (a `Bun.Glob` pattern, matched against each changed file's name and, for a rename, its old name). The changed files come from git, between the merge base GitHub reports and the head, the same two commits the status is fingerprinted by, so every one is checked however many there are. A person releases it by adding `human-approved` to the pull request. The run of that `labeled` event (one GitHub never cancels: a label's run has a concurrency group of its own; matched to that addition by the event's time, the pull request's `updated_at` in its payload, so an earlier addition's run does not count, and one that shares its second with another change to the label records nothing) binds the release to the reserved files' diff at the head GitHub gave the event, against the base branch's commit it gave (`base.sha`), whatever has merged into the base since, (`git patch-id --stable` of `git diff <merge base> <head> -- <reserved files>`), and records it as `github-actions[bot]` in `<!-- agent-hold-release {"v":1,"event":…,"by":…,"head":…,"base":…,"paths_patch_id":…} -->`. Retargeted to another base, the pull request is held again. No other run writes one, so a push, a rewind, or a deleted record cannot bind the release to another head; without a record it stays held. Anyone with write access can edit the bot's comment, its author unchanged (checked live), so an edited record (its `updated_at` moved; a reaction leaves it) holds the pull request too. A rebase that leaves that diff as it was keeps the release; any change to it holds the pull request again, and John removes and adds the label again to release the new diff. A pull request whose head is another open pull request's too is held, since a status on that commit is theirs as well. A person's own pull request with no agent commits is never held by its paths; Dependabot's is.

Only a person releases a hold: a `labeled` event GitHub records with no App (`performed_via_github_app` null) and no bot as its actor, the same test as the waiver's. An agent adding the release label, or anyone removing a label, releases nothing, and only records `github-actions[bot]` wrote count. A person's waiver waives the review, never the hold.

- **`agent-hold`**: success "not held", "released by <login> at <sha>", or "not an agent PR"; else failure naming the hold: "held: `needs-human` on #N: <the ask's first line>", "came off #N, which releases nothing", "touches `schema/**` (… and 2 more); John adds `human-approved`", "reserved paths changed since <login> released at <sha>", or "is also the head of #M". It links its pull request, with a fingerprint of what it was judged against: the base branch, the merge base, the hold, and the person's release then (`…/pull/N#agent-hold-<hash>`). It is a status apart from `agent-review`, so a hold blocks the merge but not `gh pr ready`: CI runs on a held pull request.
- **Calling John in**: while the label holds a pull request or an issue, even once it is off again (not when John added it himself), the workflow posts a comment as `github-actions[bot]` that mentions the repository owner, as the API names him (a bot's mention notifies him; an agent's, posted as him, would not), with the ask's first line (the newest comment an agent posted on that thread in the 15 minutes before the label, markers stripped, at most 200 characters; else "(no ask posted; read the thread)"), a link to it, and how to release the hold. Its `<!-- agent-hold-call {"v":1,"event":…} -->` marker names the label's event, so a rerun or a later run never posts it twice, and of two runs that post one at once, the later removes its own. A newly posted call is also pushed to the repository secret `NTFY_URL`, if set (`Title: <owner/repo>#<n> needs you`, `Click:` the thread, `Tags: raised_hand`); a failed push only warns, and the URL is never printed.
- **`gh pr ready`** prints the hold ("held: …; John releases it before it can merge") and lets the pull request go ready.
- **The merge guard** (`gh pr merge`, a REST or GraphQL merge, and `enablePullRequestAutoMerge`) reads the hold's label live (on the pull request and the issues it closes), so one added while its run waits still holds; and requires the latest `agent-hold` GitHub Actions set on the head to be success and to link this pull request against the base branch, merge base, hold, and release it has now, even where the ruleset does not list it, and names the hold and how it is released: a status on a commit is any pull request's with that head, and outlives a retarget, a merge into the base, a change to the hold, or a release taken back. It refuses `--auto` unless the ruleset requires `agent-hold` from GitHub Actions, whatever `agent-hold` reads now, and until this pull request's own is on the head: auto-merge waits only for the checks a ruleset requires, and a hold can come after it is turned on.

## Notify and reply

- `agent-gh reply <finding> --applied <sha> | --declined "<why>" [--pr N]` answers a review finding or a notify. `<finding>` is its id, looked up on `--pr` or the current branch's pull request and the issues it closes, or the URL of its review comment, review, or conversation comment, or its review thread's id (`PRRT_...`). A finding with a review thread is answered in that thread, which is then resolved; John can unresolve it to reopen. One only in a review's body, which has no thread, gets a pull request comment that links the review and quotes it; a notify gets a comment on its own thread. `--applied` takes a commit on the pull request's head branch (one of its commits since the base), and is refused otherwise; `--declined` needs a reason. Review threads exist only in GitHub's GraphQL API, which some proxies (Claude cloud's) reject, so reply runs locally.
- `agent-gh notify <issue or pr> --severity P0|P1|P2 --body "<text>" | --body-file <file|-> [--from <issue or pr>]` posts a finding on another thread, linked back to `--from` or the current branch's pull request, and refuses without one. A P3 needs no answer, so it is no notify. Its id is a hash of its thread and text, so the same notify twice is refused. Its marker, `<!-- agent-notify {"v":1,"id":"<hex>","severity":"P1","session":"claude:<id>"} -->`, names the harness session that sent it where the harness tells (Claude Code, Codex, pi).
- A reply carries `<!-- agent-reply {"v":1,"to":"<id>"} -->` (with the session too) and never needs an answer itself; neither command posts text holding an agent-gh marker of its own, so two agents cannot start a loop.

## Claims

An agent claims an issue when it starts work, so parallel sessions see what is taken and never start the same issue by accident. A repository opts in by saying so in its own agent docs; the managed instructions do not tell agents to claim, since a claim opens a branch and a pull request.

- `agent-gh claim <N>`, in a clone with no uncommitted changes: refuses, naming the holder, an issue that is closed or taken (below). Otherwise it fetches the default branch, creates `<family>/<N>-<slug>` from it with one empty commit (the commit-msg hook credits the session; the message is the issue's title and `Refs #N`, so a squash merge reads well), pushes it (never over an existing branch), and opens a draft pull request whose description says `Closes #N` (`--refs`: `Refs #N`, for work that will not finish the issue) and carries a claim marker, `<!-- agent-claim {"v":1,"issue":N,"family":"claude","session":"…","id":"…"} -->`. Keep the marker when rewriting the description. It then reads the claims back: if an earlier claim holds the issue, it closes its own pull request, deletes its branch, returns to where it was, and exits 1 naming the winner; a claim GitHub never lists back stands unconfirmed, and `claim` exits 2. `--no-pr`, for an issue with no code (research, a decision), claims with a comment carrying the marker instead, under the same check, and a losing comment posts its own release.
- The session is `AGENT_GH_SESSION` if set, else Claude Code's `CLAUDE_CODE_SESSION_ID`, Codex's `CODEX_THREAD_ID`, or pi's `PI_SESSION_ID`, else a new id that `claim` prints.
- `agent-gh release <N>` releases this session's own claim: it closes the draft and deletes its branch while the pull request holds only the claim's empty commit (one with work on it is closed deliberately, with `gh pr close`), or posts `<!-- agent-release {"v":1,"id":"…"} -->` for a comment claim. Another session's claim is John's to release, by closing its pull request. There is no expiry: nobody infers a release from silence.
- `agent-gh claims [--json] [-R OWNER/REPO]` lists each live claim with its holder and when it last saw a push or a comment, so John can see a claim going quiet. Outside an agent session it reads with the read App.

**The rule**, which anything with REST alone (a cloud session, a repository script) can apply: an issue is taken when it is open and either an open pull request in its repository links it in its description, with a closing keyword (close, fix, resolve, in any tense) or `Ref`/`Refs` followed by `#N`, `OWNER/REPO#N`, or the issue's URL, or carries a claim marker for it; or a comment on it carries a claim marker, its author has write access (`author_association` `OWNER`, `MEMBER`, or `COLLABORATOR`), and no such author's comment releases that marker's `id`. A bare mention ("unlike #12") takes nothing. Of several claims, the one created first (`created_at`) holds the issue; within the same second, a pull request before a comment, then the lowest number or id. So a claim that saw itself win is never displaced by one posted after it, whichever kind each is. It reads `GET /repos/{o}/{r}/issues/{n}`, every page of `GET /repos/{o}/{r}/pulls?state=open`, and every page of `GET /repos/{o}/{r}/issues/{n}/comments`. In TypeScript it is `taken(repo, issue, pulls, comments)` in `src/claim.ts`, which takes those three responses as they are.

**`claims --json`** is the stable interface for repository scripts (a next-issue picker, a frontier): `{"v":1,"repo","label","claims":[…],"mismatches":[…]}`. Each claim has `issue`, `title`, `kind` (`pr` or `comment`), `pr` (or null), `url`, `author`, `family` and `session` (null for a pull request without a marker, such as a person's), `branch`, `holds` (whether it is the issue's first claim), `created_at`, `last_push_at` (the head commit's committer date), `last_comment_at` (on the issue or the pull request), and `labeled`. Every issue with a claim is taken. It finds pull request claims everywhere, and comment claims on the issues that carry the label; the per-issue rule above sees every comment claim.

**The label.** A claim also labels the issue (`claimed`, or `"claims": {"label": "…"}` in `.github/agent-review.json` on the default branch), creating the label when it is missing, so a person or a script can filter with `-label:claimed`. Releases before v0.9.0 refuse a config with the `claims` key, so a repository moves its agent-review workflow's pin to v0.9.0 or later before adding it. It only mirrors the claims: anyone can add or remove a label, so neither the rule nor `claims` trusts it, and `claims` reports where the two disagree. `release` removes it once nothing claims the issue, and `agent-gh claims sync [--issue N]...` removes it from every labelled issue nothing claims. To have it removed when a claim's pull request closes or merges, a repository adds:

```yaml
# .github/workflows/agent-claims.yml
name: agent-claims
on:
  pull_request_target:
    types: [closed]
permissions: {}
jobs:
  agent-claims:
    uses: johnrees/agent-gh/.github/workflows/agent-claims.yml@v0.9.0
    with:
      version: v0.9.0
      # runs-on: ubicloud-standard-2 # only once this pin is a release that has the input
    # contents (the label's name), pull-requests (the open pull requests), issues (the issues, comments, and the label).
    permissions:
      contents: read
      issues: write
      pull-requests: read
```

A claim pull request is a draft with an agent's empty commit, so the agent-review workflow sets it pending ("needs a review"), one run when it opens and one per later event, as for any draft. It does not skip drafts: `review full` runs before `gh pr ready`, while the pull request is still a draft, and with `status_writer` `"actions"` it waits for the workflow's status. `gh pr ready` still needs a review, so a claim cannot slip through.

### What to take next

`agent-gh next [--json] [LABEL FILTERS] [-R OWNER/REPO]` prints the issues an agent may take, the next first: open, labelled `ready`, listed in the repository's Queue issue where one is configured, with every `blocked_by` blocker closed, and unclaimed. Claimed ones are noted on stderr as in progress. It comes from soltui's `scripts/next-issues.ts`: a Queue entry is a numbered list item, and its first `#N` is the issue it queues; other mentions are context. The Queue is configured in `.github/agent-review.json` on the default branch, `"queue": {"issue": 735, "label": "ready"}` (both optional; `label` defaults to `ready`); as with `claims`, a repository moves its agent-review pin to v0.9.0 or later first. Without a Queue it says so and falls back to every open `ready` issue, by priority label. `--json` gives `{"v":1,"repo","queue","label","issues":[{"issue","title","priority","labels","claim"}]}`, where `labels` is the issue's label names, sorted, and `claim` is null or the holder's `kind`, `pr`, `url`, `family`, and `session`.

**Label filters.** `next`, `next --waves`, and `claim --next` take three flags, each repeatable, each a label pattern where `*` matches anything, so a session skips what is not for it in one call:

- `--skip-label <pattern>` leaves out an issue when any of its labels matches.
- `--require-label <pattern>` leaves out an issue unless some label matches each pattern given.
- `--fit-label <pattern>` leaves out an issue that carries a label in the pattern's group (its text up to and including the first `:`) unless that label also matches the pattern. `--fit-label 'model:sonnet-*'` keeps `model:sonnet-luna` and issues with no `model:` label, and drops `model:opus-sol`, `model:fable-astra`, and `model:redteam`; `--require-label` cannot say that without dropping the unlabelled ones. A pattern with no `:` is refused, as is a flag with no pattern.

`queue.skip_labels` in `.github/agent-review.json` on the default branch is a list of patterns (default `[]`) applied as `--skip-label` on every call, whoever runs it: `"queue": {"skip_labels": ["needs-human", "ready-for-human", "model:redteam"]}`. Where the config has `hold`, an issue carrying its label, in any case, is always skipped too (`hold.label`; [Holds](#holds)). A repository moves its agent-review pin to a release that accepts the key first, since older releases refuse an unknown `queue` key.

A filtered issue is not offered and not claimed, but it stays in the graph: it still blocks its dependents, and `unblocks` does not change. Only issues that would otherwise be dispatched are filtered. In `--waves --json`, in whatever wave it lands (its `waiting_on` still names its blockers), it has `"state": "skipped"` and `"skipped_by": {"rule", "pattern", "label"}` (`rule` is `hold.label`, `queue.skip_labels`, `--skip-label`, `--require-label`, or `--fit-label`; `label` is null when a required label is missing); `skipped_by` is null for every other issue. Plain `next` and `claim --next` print one stderr line per skipped issue of wave 1: `agent-gh: skipped #12 Title: carries needs-human (queue.skip_labels)`. `claim --next` filters before it picks, and again on each retry.

`agent-gh next --waves [--json]` lays out the dependency graph for parallel workers: the queued and `ready` issues and, transitively, their open blockers in this repository (a blocker in another repository is read, never followed or offered; a closed one is resolved). Wave 1 is the frontier, every issue with no open blocker: workable, in progress (claimed), or unblocked but not dispatched (not `ready` or not queued). Each later wave waits only on earlier ones, and each issue names what it waits on. Within a wave the Queue's order comes first; then the highest priority label (`queue.priority_labels`, highest first, default `["priority:high", "priority:medium", "priority:low"]`, `[]` for none; an issue with two takes the higher), so a repository without a Queue is ordered by priority; then the issues that unblock the most; then the lowest number. `--json` and `--waves` show each issue's priority and labels; plain `next` is wave 1's workable issues in that order. Issues on a cycle, or behind one or behind an open issue in another repository, are listed as stuck with the cycle, and never offered. It schedules nothing.

`agent-gh claim --next [--refs|--no-pr] [LABEL FILTERS]` claims the first issue `next` offers. When that claim loses a race, it reads the frontier again and tries the next one, three times at most (never after an unconfirmed claim), so several workers running it spread across the frontier.

## Releases

Agents never cut, change, or approve a release unless John has granted that one tag. A tag ruleset does not stop them, since they act as John, its bypass actor, so the guard does, as the merge guard does for branches. In an agent session:

- **Tags**: the pre-push hook refuses a new tag (`git push origin v1`, `--tags`, `--follow-tags`) without a grant for it, each tag its own, and refuses deleting or moving a tag, grant or not.
- **`gh release`**: `create`, `edit`, `upload`, and `delete-asset` need a grant for their tag (`edit --tag` for the new one too); `delete` is always refused; `list`, `view`, `download`, `verify`, and `verify-asset` run as they are. The tag is read with each subcommand's own flags, and `-R` in any spelling.
- **`gh api`**: creating a tag (`POST git/refs` with `refs/tags/...`, or GraphQL `createRef`) or writing a release (`POST releases`, `PATCH` or `DELETE releases/{id}`, an asset upload to uploads.github.com) needs a grant for the release's tag, read from the body or from GitHub. A write to a tag's own ref (`PATCH` or `DELETE git/refs/tags/...`, GraphQL `updateRef`, `updateRefs`, or `deleteRef`), any GraphQL mutation that names a release, and an endpoint the guard cannot read are refused.
- **Deployments**: approving or rejecting one (`POST actions/runs/{id}/pending_deployments` or `deployment_protection_rule`, GraphQL `approveDeployments` or `rejectDeployments`) is always refused, so a release workflow behind a protected environment still waits for John's click.

Every refusal names the tag and what John runs.

**The grant** is an issue John opens with his own login. In his own terminal (it refuses in an agent session):

```sh
agent-gh allow release v1.2.3 [--at <full commit sha>] [-R OWNER/REPO]
```

It opens "Release v1.2.3" with the real gh (never a shim), labelled `agent-release` (created when missing), its body a sentence and `<!-- agent-gh-allow {"v":1,"action":"release","tag":"v1.2.3","sha":null} -->`. Where gh does not act as the repository's owner, as on an agent machine, whose gh only reads, it prints a prefilled new-issue link and the fields to paste instead. A grant holds while the issue is open, was opened by the repository's owner with no App (`performed_via_github_app` null), is under 24 hours old, and has never been edited, closed, reopened, or transferred (agents act as John, so they could do any of those to his issue), and its marker names the tag and, when `--at` named one, the commit the tag points at. A pull request never counts, since GitHub records no App for one. The label only helps the guard find grants; anyone can add one, so it is not trusted.

A grant covers creating that tag while it does not exist on GitHub (or already points at the granted commit, so a retry is harmless), and `gh release create`, `edit`, `upload`, and `delete-asset` for it while it holds. A new tag `gh release` creates is pinned to the granted commit with `--target`; a REST release write that would create one must give that commit as `target_commitish`. A tag is created once and never moved or deleted, so a grant is one-shot with no state in agent-gh. Closing the issue revokes it, and expiry clears the rest. It is not a variable or a file because an agent runs as the same Unix user as John and could write either.

Stated limits:

- `git push --no-verify` skips the pre-push hook, as it does for branches.
- On John's own Mac, a determined agent could run the real gh with John's keyring login and open a grant, as it could add a waiver label. Agent machines have no such login.
- `gh workflow run` of a dispatch-triggered release workflow is not held. Such a repository should run its release job in a protected environment, whose approval agents cannot give.
- A gh alias or extension is not expanded, so one that writes a release is not held; agents use gh's own commands.

## Development

`bun test` (offline: a fake GitHub API, real throwaway repositories and hooks, the shim under real shells, and `install.sh` against a fake release), `bun run typecheck`, `bun run build`. `bun run install-local` installs a checkout's build. A `v*` tag publishes a release with `SHA256SUMS`.
