# agent-gh

Runs `gh` and `git` as John through the GitHub App of the model family driving the current agent session. GitHub shows each issue, comment, review, and pull request as John with the App's badge (`performed_via_github_app` is `johnrees-<family>`), the way Claude's cloud agent posts. Commits keep John as author and credit the App as co-author. One App per model family (claude, codex, glm, deepseek, kimi, qwen) serves every harness and every repository it is installed on. It never falls back to John's own gh login.

```sh
agent-gh pr create --draft --fill      # gh, as John through the App
agent-gh git commit -m "..."           # John as author; Agent-* trailers and the App as co-author
agent-gh git push -u origin my-branch  # github.com remotes over HTTPS; SSH is off
agent-gh doctor                        # harness, model, family, App; then user, token App, git author, and access
agent-gh settings claude               # the App's settings, permissions, and repository-access pages
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

In your own terminal, on any macOS or Linux machine (arm64 or x64):

```sh
curl -fsSL https://raw.githubusercontent.com/johnrees/agent-gh/main/install.sh | bash
```

On a machine that only runs agents:

```sh
curl -fsSL https://raw.githubusercontent.com/johnrees/agent-gh/main/install.sh | bash -s -- --agent-machine
```

The only manual step is entering the device-flow codes it prints, in any browser on any machine. It needs no sudo and no Bun, and a rerun updates agent-gh and skips what is done. It:

1. downloads the latest release's `agent-gh-<os>-<arch>`, checks it against the release's `SHA256SUMS`, and installs it at `~/.local/bin/agent-gh`;
2. installs gitleaks 8.30.1 there if it is missing, checked against gitleaks' checksums (repositories' pre-commit hooks scan with it);
3. runs `agent-gh login --all`: a device-flow login for each App in `apps.json` not already logged in here, then the read App. `AGENT_GH_FAMILIES=claude,codex` limits the families;
4. runs `agent-gh install-shims`, below;
5. runs `agent-gh doctor --machine`, a checklist whose every FAIL line names its fix, and fails if any line fails.

The script and the releases download without authentication, so the curl line needs the repository to be public. `login` reads each App from the committed `apps.json`; the private keys never leave the machine that ran `setup`, and are only for App-level requests. A family missing from `apps.json` has no App yet: create it with `agent-gh setup` where you create Apps, and commit the entry it prints. A `v*` tag publishes a release: every platform's binary, built on Linux (Bun's darwin builds are ad-hoc signed and run on macOS), and `SHA256SUMS`.

### The shims

`install-shims` writes `gh` and `git` shims to `~/.local/share/agent-gh/shims` and puts them, then `~/.local/bin`, first on PATH with a marked block in each shell startup file present (`.zshrc`, `.zprofile`, `.zshenv`, `.bashrc`, `.bash_profile`, `.profile`; `.profile` when there is none). Open a new shell after it.

In an agent session (the harness table above), `gh` runs `agent-gh gh`, and `git commit`, `merge`, `pull`, `cherry-pick`, `revert`, `rebase`, `am` (except `--abort` and `--quit`), and `push` run `agent-gh git`: the commands the Claude Code hook below refuses. Every other git command, and gh's own `--version` and help, is the real program. So agents use agent-gh whatever they type. Outside an agent session, and in agent-gh's own children (`AGENT_GH_CHILD=1`), the shims exec the real program after a test made of shell builtins only: no agent-gh process and no delay. The shims are generated from agent-gh's harness table, so rerun the install line after updating to keep them in step.

### Agent machines

`--agent-machine` makes agent-gh the only way to write to GitHub from the machine:

- git's global credential helper for https://github.com becomes `agent-gh credential`, which answers with the read App's token, so clones, fetches, and pulls work and a push with it is refused by GitHub. agent-gh replaces that helper with the family App's token for its own git.
- gh is logged out of your personal login (gh may ask you to confirm). A person's `gh` there runs with the read App's token, which the gh shim sets as `GH_TOKEN` unless one is already set, so it can read but not write.

It refuses until the read App is logged in on the machine, so the machine is never left unable to clone. `agent-gh doctor --machine` checks both.

## Set up a family (once, in your own terminal)

```sh
agent-gh setup glm   # or claude, codex, deepseek, kimi, qwen, or read
```

This opens a local page that posts an App manifest to GitHub: a private App named `johnrees-<family>` with contents, issues, and pull requests write, actions and checks read, and no webhook deliveries. After you click **Create**, GitHub hands the credentials back to the local page. agent-gh keeps only the private key and the public identifiers in `~/.config/agent-gh/` (directory 700, files 600). It refuses to run inside an agent session.

Then, for each App (`agent-gh settings <family>` prints its pages):

1. Install it on each repository agents work in, at its repository-access page (**Only select repositories**). Adding a repository later is a checkbox there; no new key.
2. Tick **Enable Device Flow** on its settings page and save. A manifest cannot set it.
3. Run `agent-gh login <family>` (the install line does this for every App). It prints a code to enter at github.com/login/device, then stores John's user token for that App in `~/.config/agent-gh/<family>.token.json` (mode 600). It refuses to run inside an agent session.
4. Add the `apps.json` line setup prints and commit it. The registry holds only public identifiers (slug, App ID, client ID, bot user ID), and it is how every other machine finds the App.

`agent-gh setup read` creates the read App, `johnrees-read`: contents, issues, pull requests, actions, and checks, all read-only. It is not a family: nothing acts, publishes, or co-authors as it, and it only answers git's credentials and a person's gh on agent machines. Install it on every repository agent machines clone.

User tokens last 8 hours and refresh for 6 months (unless the App opts out of expiring tokens). agent-gh refreshes a token five minutes before it expires, under a lock so parallel sessions never spend the rotating refresh token twice; a device-flow token refreshes without the client secret, so none is stored. When the refresh token itself expires, rerun the install line (or `agent-gh login <family>`). A user token reaches every repository its App is installed on and John can access; unlike an installation token, it cannot be narrowed to one repository per command, so before each GitHub command agent-gh checks, with that user token (`GET /user/installations`, then the installation's repositories), that the App is installed on the target repository. Everyday commands never read the App's private key.

GitHub has no API to change an App's permissions or its repositories, so each App is edited by hand. Check the whole path with `agent-gh doctor` from the repository, inside an agent session.

## Commit trailers

`agent-gh git commit` keeps John's own git author and committer and adds, with `--trailer` (so `-m`, `-F`, `--amend`, and `--no-edit` all work): `Agent-Harness`, plus `Agent-Model` and `Agent-Effort` when the harness reports them, and `Co-authored-by: johnrees-<family>[bot] <id+johnrees-<family>[bot]@users.noreply.github.com>`, so GitHub shows John and the App together. An amend replaces the Agent-* trailers and credits the App only once, keeping other co-authors. They replace Claude Code's `Co-Authored-By` line, which can be turned off with `"attribution": { "commit": "" }`.

## Claude Code

The shims already route an agent's gh and git writes through agent-gh. On a machine without them, allow the command, and deny commands that would skip it and act with John's own login. In `~/.claude/settings.json`, with this machine's checkout path:

```json
{
  "permissions": { "allow": ["Bash(agent-gh *)"] },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "bun /path/to/agent-gh/hooks/deny-bare-gh.ts" }]
      }
    ]
  }
}
```

The hook denies, unless run through agent-gh: `gh pr|issue|release|repo` writes; `gh api` writes (an explicit write method, fields or input without a method, or a GraphQL mutation); and `git commit`, `merge`, `pull`, `cherry-pick`, `revert`, `rebase`, `am` (except `--abort` and `--quit`), and `push`. Reads such as `git status`, `diff`, `log`, `show`, and `fetch` stay allowed. It is a guard against the easy mistake, not a security boundary. Codex and opencode do not read Claude Code hooks; the git hooks below bind every harness, and repositories check authorship in CI.

## Git hooks (any harness)

git runs a repository's hooks whichever tool calls it, so these bind Claude Code, Codex, opencode, and pi alike. A repository's hooks call:

```sh
# .githooks/commit-msg
command -v agent-gh > /dev/null || exit 0
exec agent-gh guard commit-msg "$1"

# .githooks/pre-push
command -v agent-gh > /dev/null || exit 0
exec agent-gh guard pre-push
```

Outside an agent session both pass. Inside one, `guard commit-msg` refuses a message without the session family's `Co-authored-by` trailer (git applies `--trailer` before commit-msg runs, so `agent-gh git commit` passes), and `guard pre-push` refuses a push that did not come through agent-gh. agent-gh marks every git and gh it runs with `AGENT_GH_CHILD=1`, which also covers commits it makes without `--trailer`, such as merges. A machine without agent-gh (a cloud runner) skips the guard. A hook this version does not understand exits 2 with the update command, never a silent pass. Like the Claude Code hook, this stops the easy mistake, not a determined agent (`--no-verify`, or setting the marker); CI's authorship check is the backstop. The hooks run only in a clone with `git config core.hooksPath .githooks`.

## Development

`bun test` runs offline against a fake GitHub API, real throwaway git repositories, the shims under a real `sh`, and `install.sh` against a local fake release; `bun run typecheck`; `bun run build`.

To run a checkout's build instead of a release:

```sh
bun run install-local   # checks Bun, installs the locked dependencies, builds, installs ~/.local/bin/agent-gh
```

`install-local` refuses a Bun other than `.bun-version` and prints the command for that exact version (a different Bun rewrites `bun.lock`), then runs `bun install --frozen-lockfile`.
