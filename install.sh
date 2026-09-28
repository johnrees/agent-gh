#!/usr/bin/env bash
# Sets up this machine so agents use agent-gh for every GitHub write. Safe to
# rerun: it updates agent-gh and skips what is already done.
#
#   curl -fsSL https://raw.githubusercontent.com/johnrees/agent-gh/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/johnrees/agent-gh/main/install.sh | bash -s -- --agent-machine
#
# --agent-machine, for a machine that only runs agents: an agent session's
# git uses its family App where installed and anyone else's the read-only
# App, and gh is logged out of your personal login, so nothing but agent-gh's
# Apps can write to GitHub from it.
#
# The only thing you do is enter the device-flow codes it prints. It needs no
# sudo. AGENT_GH_FAMILIES=claude,codex limits which family Apps it logs in.
set -euo pipefail

REPO="johnrees/agent-gh"
RELEASES="${AGENT_GH_RELEASES:-https://github.com/$REPO/releases}"
VERSION="${AGENT_GH_VERSION:-latest}"
GITLEAKS_VERSION="8.30.1"
GITLEAKS_RELEASES="${AGENT_GH_GITLEAKS_RELEASES:-https://github.com/gitleaks/gitleaks/releases}"
BIN="$HOME/.local/bin"
SHIMS="$HOME/.local/share/agent-gh/shims"

agent_machine=0
for arg in "$@"; do
  case $arg in
    --agent-machine) agent_machine=1 ;;
    *) echo "install.sh: unknown option $arg (only --agent-machine)" >&2; exit 2 ;;
  esac
done

say() { printf 'agent-gh install: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "no agent-gh build for $(uname -s)" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "no agent-gh build for $(uname -m)" ;;
esac

sha256() {
  if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
# The hash SUMS lists for FILE, whatever its line style ("hash  file" or "hash *file").
listed() { awk -v f="$2" '$2 == f || $2 == "*" f { print $1; exit }' "$1"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$BIN"

# 1. agent-gh itself, checked against the release's SHA256SUMS before it runs.
asset="agent-gh-$os-$arch"
if [ "$VERSION" = latest ]; then base="$RELEASES/latest/download"; else base="$RELEASES/download/$VERSION"; fi
fetch "$base/$asset" "$tmp/$asset" || die "could not download $asset from $base (is the repository public, with a release?)"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "could not download SHA256SUMS from $base"
want="$(listed "$tmp/SHA256SUMS" "$asset")"
[ -n "$want" ] || die "SHA256SUMS lists no $asset"
[ "$(sha256 "$tmp/$asset")" = "$want" ] || die "$asset does not match SHA256SUMS; nothing was installed"
chmod 755 "$tmp/$asset"
"$tmp/$asset" --version > /dev/null || die "the downloaded $asset does not run on this machine"
mv -f "$tmp/$asset" "$BIN/agent-gh"
say "installed $("$BIN/agent-gh" --version) at $BIN/agent-gh"

# 2. gitleaks, which repositories' pre-commit hooks scan with.
if command -v gitleaks > /dev/null 2>&1 || [ -x "$BIN/gitleaks" ]; then
  say "gitleaks: already installed"
else
  tarball="gitleaks_${GITLEAKS_VERSION}_${os}_${arch}.tar.gz"
  sums="gitleaks_${GITLEAKS_VERSION}_checksums.txt"
  from="$GITLEAKS_RELEASES/download/v$GITLEAKS_VERSION"
  fetch "$from/$tarball" "$tmp/$tarball" || die "could not download $tarball"
  fetch "$from/$sums" "$tmp/$sums" || die "could not download $sums"
  want="$(listed "$tmp/$sums" "$tarball")"
  [ -n "$want" ] && [ "$(sha256 "$tmp/$tarball")" = "$want" ] || die "$tarball does not match $sums; gitleaks was not installed"
  tar -xzf "$tmp/$tarball" -C "$tmp" gitleaks
  mv -f "$tmp/gitleaks" "$BIN/gitleaks"
  chmod 755 "$BIN/gitleaks"
  say "installed gitleaks $GITLEAKS_VERSION at $BIN/gitleaks"
fi

# For the rest of this script; new shells get it from the startup files install-shims writes.
export PATH="$SHIMS:$BIN:$PATH"

# Anything that may prompt reads the terminal, not this piped script.
tty=/dev/null
if { : < /dev/tty; } 2> /dev/null; then tty=/dev/tty; fi

# 3. Logins: one device-flow code per App this machine does not have yet.
login_ok=1
"$BIN/agent-gh" login --all < "$tty" || login_ok=0

# 4. The gh shim, and on an agent machine, git credentials and no personal write access.
if [ "$agent_machine" = 1 ]; then
  "$BIN/agent-gh" install-shims --agent-machine < "$tty"
else
  "$BIN/agent-gh" install-shims < "$tty"
fi

# 5. The checklist.
"$BIN/agent-gh" doctor --machine || exit 1
[ "$login_ok" = 1 ] || exit 1
