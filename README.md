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

A machine without agent-gh, such as a cloud agent's, skips it, and `--no-verify` skips it anywhere. An empty message still aborts the commit.

## Apps

`agent-gh setup <family>` (or `read`), in your own terminal, creates the App from a manifest and prints what is left: install it on repositories, enable device flow, log in, and commit its `apps.json` line, which is how other machines find it. `agent-gh settings <family>` prints its pages; GitHub has no API for an App's permissions or repositories. Each machine keeps John's user tokens in `~/.config/agent-gh/` (mode 600); they refresh for six months, and the App keys are never needed day to day.

## Development

`bun test` (offline: a fake GitHub API, real throwaway repositories and hooks, the shim under real shells, and `install.sh` against a fake release), `bun run typecheck`, `bun run build`. `bun run install-local` installs a checkout's build. A `v*` tag publishes a release with `SHA256SUMS`.
