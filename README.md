# agent-gh

Agents publish to GitHub as John through one GitHub App per model family (claude, codex, glm, deepseek, kimi, qwen), whatever harness runs them. GitHub shows each issue, comment, review, and pull request as John with the App's badge, and each commit as John with the App as co-author. Agents run plain `gh` and `git`; nothing asks them to choose a method or an identity.

- **gh**: in an agent session, the gh shim runs every `gh` command through the session family's App. It never falls back to John's own login.
- **Commits**: a repository's `commit-msg` hook adds `Agent-Harness` (with `Agent-Model` and `Agent-Effort` when the harness reports them) and `Co-authored-by: johnrees-<family>[bot]` to an agent session's commits. A person's commits, and repositories with no github.com remote, are left as written.
- **Pushes**: on a machine you use, git pushes with your own login. On an agent machine, GitHub remotes use HTTPS, an agent session's git uses its family's App wherever that App is installed and the read-only App (`johnrees-read`) elsewhere, and anyone else's git only reads.

## Install

In your own terminal, on macOS or Linux (arm64 or x64); on a machine that only runs agents, add `-s -- --agent-machine`:

```sh
curl -fsSL https://raw.githubusercontent.com/johnrees/agent-gh/main/install.sh | bash
```

It installs the checked release and gitleaks in `~/.local/bin`, logs in each App (you enter the device-flow codes it prints), puts the gh shim first on PATH, and ends with `agent-gh doctor --machine`, whose every failure names its fix. A rerun updates everything. `agent-gh doctor`, from an agent session in a repository, checks who is acting and the App's access there. `AGENT_GH_FAMILIES=claude,codex` limits the logins.

## Who is acting

The harness is found from a variable it sets for its tools, and the family from the model the harness reports. Where a harness reports none, the session declares it with `AGENT_GH_MODEL`; agent-gh never guesses, and its refusal names the setting to add.

| Harness | Detected by | Model from |
| --- | --- | --- |
| Claude Code | `CLAUDECODE=1` with `CLAUDE_CODE_CHILD_SESSION` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_*_MODEL`; effort from `CLAUDE_EFFORT` |
| Codex | `CODEX_THREAD_ID` or `CODEX_SESSION_ID` | openai, else `AGENT_GH_MODEL` via `shell_environment_policy` |
| pi | `PI_SESSION_ID` | `PI_MODEL`, `PI_PROVIDER`; effort from `PI_REASONING_LEVEL` |
| opencode | `OPENCODE_TERMINAL=1` | `AGENT_GH_MODEL`, set when it starts |

## Repository hooks

```sh
# .githooks/commit-msg (with git config core.hooksPath .githooks)
command -v agent-gh > /dev/null || exit 0
exec agent-gh guard commit-msg "$1"
```

A machine without agent-gh, such as a cloud agent's, skips it, and `--no-verify` skips it anywhere. An empty message still aborts the commit. `agent-gh guard pre-push` passes and is kept only for older hooks.

## Apps

`agent-gh setup <family>` (or `read`), in your own terminal, creates the App from a manifest and prints what is left: install it on repositories, enable device flow, log in, and commit its `apps.json` line, which is how other machines find it. `agent-gh settings <family>` prints its pages; GitHub has no API for an App's permissions or repositories. Each machine keeps John's user tokens in `~/.config/agent-gh/` (mode 600); they refresh for six months, and the App keys are never needed day to day.

## Claude Code without the shim

On a machine without the gh shim, a PreToolUse hook denies a gh write that skips agent-gh:

```json
{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "bun /path/to/agent-gh/hooks/deny-bare-gh.ts" }] }
```

## Development

`bun test` (offline: a fake GitHub API, real throwaway repositories and hooks, the shim under real shells, and `install.sh` against a fake release), `bun run typecheck`, `bun run build`. `bun run install-local` installs a checkout's build. A `v*` tag publishes a release with `SHA256SUMS`.
