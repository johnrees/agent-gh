# agent-gh

Runs `gh` and `git` as the GitHub App bot of the model family driving the current agent session, so its issues, comments, commits, and pull requests are attributed to `johnrees-<family>[bot]` instead of John. One App per model family (claude, codex, glm, deepseek, kimi, qwen) serves every harness and every repository it is installed on. Each GitHub command gets a fresh token for that one repository, revoked when the command ends; local git commands get the bot's identity and no token. It never falls back to John's login.

```sh
agent-gh pr create --draft --fill      # gh, as the bot
agent-gh git commit -m "..."           # git, as the bot, with Agent-* trailers
agent-gh git push -u origin my-branch  # github.com remotes over HTTPS; SSH is off
agent-gh doctor                        # harness, model, family, bot; then login, git author, and access
```

## Who is acting

agent-gh finds the harness from a variable it sets for its tools, then the model from what that harness reports. It never guesses: signals that disagree, or a model no family claims, are refused.

| Harness | Detected by | Model |
| --- | --- | --- |
| Claude Code | `CLAUDECODE=1` with `CLAUDE_CODE_CHILD_SESSION` (an IDE terminal alone is a person) | claude, unless `ANTHROPIC_BASE_URL`'s host or `ANTHROPIC_*_MODEL` name another family; effort from `CLAUDE_EFFORT` |
| pi | `PI_SESSION_ID` | `PI_MODEL` and `PI_PROVIDER`; effort from `PI_REASONING_LEVEL` |
| Codex | `CODEX_THREAD_ID` or `CODEX_SESSION_ID` | codex, unless `config.toml` selects another `model_provider`; then the model must be declared |
| opencode | `OPENCODE_TERMINAL=1` | must be declared |

A session declares its model with `AGENT_GH_MODEL` (and optionally `AGENT_GH_PROVIDER`) only where the harness reports none; where it does, the two must agree. `AGENT_GH_HARNESS` names the harness only on a runner with no harness variable. The repository is gh's `-R`/`--repo`, else `GH_REPO`, else `origin`.

- **opencode** (2.0.16) passes no model to shell commands, and its documented `shell.env` plugin hook is not in the 2.x binary. Start a private server with the model declared, one model per launch: `AGENT_GH_MODEL=zai/glm-4.6 opencode --standalone`. The shared background service keeps the environment it started with, and a model switched mid-session is not seen, so restart after switching.
- **Codex** with another provider: add `[shell_environment_policy] set = { AGENT_GH_MODEL = "glm-4.6" }` to that config or profile. A profile chosen with `--profile` is invisible to agent-gh unless it declares the model this way.
- **Claude Code** with another backend: set `ANTHROPIC_BASE_URL` (z.ai, bigmodel, DeepSeek, Moonshot, and DashScope hosts are known) in the environment that launches `claude`. For a gateway serving several families, also set `ANTHROPIC_MODEL` to a concrete model id.

## Install

```sh
bun install && bun run install-local   # builds dist/agent-gh and installs ~/.local/bin/agent-gh
```

## Set up a family (once, in your own terminal)

```sh
agent-gh setup glm   # or claude, codex, deepseek, kimi, qwen
```

This opens a local page that posts an App manifest to GitHub: a private App named `johnrees-<family>` with contents, issues, and pull requests write, actions and checks read, and no webhook deliveries. After you click **Create**, GitHub hands the credentials back to the local page. agent-gh keeps only the private key and the public identifiers in `~/.config/agent-gh/` (directory 700, files 600). It refuses to run inside an agent session.

Then install the App on each repository agents work in, at the URL setup prints (`https://github.com/apps/johnrees-<family>/installations/new`, **Only select repositories**). Adding a repository later is a checkbox on that page; no new key. Check it with `agent-gh doctor` from the repository, inside an agent session.

## Commit trailers

`agent-gh git commit` adds `Agent-Harness`, plus `Agent-Model` and `Agent-Effort` when the harness reports them, with `--trailer` (so `-m`, `-F`, `--amend`, and `--no-edit` all work). An amend replaces them. They replace Claude Code's `Co-Authored-By` line, which can be turned off with `"attribution": { "commit": "" }`.

## Claude Code

Allow the command, and deny commands that would act as John. In `~/.claude/settings.json`:

```json
{
  "permissions": { "allow": ["Bash(agent-gh *)"] },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "bun /Users/john/Code/agent-gh/hooks/deny-bare-gh.ts" }]
      }
    ]
  }
}
```

The hook denies, unless run through agent-gh: `gh pr|issue|release|repo` writes; `gh api` writes (an explicit write method, fields or input without a method, or a GraphQL mutation); and `git commit`, `merge`, `pull`, `cherry-pick`, `revert`, `rebase`, `am` (except `--abort` and `--quit`), and `push`. Reads such as `git status`, `diff`, `log`, `show`, and `fetch` stay allowed. It is a guard against the easy mistake, not a security boundary. Codex and opencode do not read Claude Code hooks; repositories that need the rule to bind every harness check authorship in CI.

## Development

`bun test` runs offline against a fake GitHub API and real throwaway git repositories; `bun run typecheck`; `bun run build`.
