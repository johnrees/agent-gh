# agent-gh

Runs `gh` and `git` as the current agent's GitHub App bot, so its issues, comments, commits, and pull requests are attributed to `johnrees-<harness>[bot]` instead of John. One App per harness serves every repository it is installed on; each command gets a fresh token for that one repository, revoked when the command ends. It never falls back to John's login.

```sh
agent-gh pr create --draft --fill      # gh, as the bot
agent-gh git push -u origin my-branch  # git, as the bot (github.com remotes over HTTPS; SSH is off)
agent-gh doctor                        # bot login, git author, and repository access
```

The harness comes from the environment its tools run in, never from an argument: `CLAUDECODE=1` (Claude Code), `CODEX_THREAD_ID` or `CODEX_SESSION_ID` (Codex), `PI_SESSION_ID` (pi). With none, agent-gh refuses; with two, it refuses as ambiguous. `AGENT_GH_HARNESS` names the harness only on a runner with no harness variable. The repository is gh's `-R`/`--repo`, else `GH_REPO`, else `origin`.

## Install

```sh
bun install && bun run install-local   # builds dist/agent-gh and installs ~/.local/bin/agent-gh
```

## Set up a harness (once, in your own terminal)

```sh
agent-gh setup claude   # then: agent-gh setup codex
```

This opens a local page that posts an App manifest to GitHub: a private App named `johnrees-<harness>` with contents, issues, and pull requests write, actions and checks read, and no webhook deliveries. After you click **Create**, GitHub hands the credentials back to the local page. agent-gh keeps only the private key and the public identifiers in `~/.config/agent-gh/` (directory 700, files 600). It refuses to run inside an agent session.

Then install the App on each repository agents work in, at the URL setup prints (`https://github.com/apps/johnrees-<harness>/installations/new`, **Only select repositories**). Adding a repository later is a checkbox on that page; no new key. Check it with `agent-gh doctor` from the repository, inside an agent session.

## Claude Code

Allow the command, and deny GitHub writes that skip it. In `~/.claude/settings.json`:

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

The hook denies `gh pr|issue|release|repo` writes, `gh api` writes (an explicit write method, fields or input without a method, or a GraphQL mutation), and `git push` unless the command runs through agent-gh. It is a guard against the easy mistake, not a security boundary. Codex does not read Claude Code hooks; repositories that need the rule to bind every harness check authorship in CI.

## Development

`bun test` runs offline against a fake GitHub API; `bun run typecheck`; `bun run build`.
