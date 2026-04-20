#!/usr/bin/env bash
# install.sh — one-command installer for Relay (CLI: rly)
#
# Usage:
#   ./install.sh                  # default: install deps, build, link globally
#   ./install.sh --with-tui       # also build the Rust TUI (requires cargo)
#   ./install.sh --with-gui       # also build the Tauri GUI (requires cargo)
#   ./install.sh --skip-link      # skip `pnpm link --global`
#
# Safe to re-run. Idempotent.
#
# After cloning you may need to mark this executable:
#   chmod +x install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------- flag parsing ----------
WITH_TUI=0
WITH_GUI=0
SKIP_LINK=0

for arg in "$@"; do
  case "$arg" in
    --with-tui)   WITH_TUI=1 ;;
    --with-gui)   WITH_GUI=1 ;;
    --skip-link)  SKIP_LINK=1 ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "unknown flag: $arg" >&2
      echo "try: $0 --help" >&2
      exit 2
      ;;
  esac
done

# ---------- helpers ----------
have() { command -v "$1" >/dev/null 2>&1; }

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# Compare semver-ish strings. Returns 0 iff $1 >= $2.
version_ge() {
  local a="${1#v}"
  local b="${2#v}"
  if printf '%s\n%s\n' "$b" "$a" | sort -V -c >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# ---------- prereq checks ----------
log "Checking prerequisites"

MISSING=()

if ! have node; then
  MISSING+=("node >=20 (https://nodejs.org or: brew install node)")
else
  NODE_VER="$(node --version 2>/dev/null | sed 's/^v//')"
  if ! version_ge "$NODE_VER" "20.0.0"; then
    MISSING+=("node >=20 (found v${NODE_VER})")
  fi
fi

if ! have pnpm; then
  MISSING+=("pnpm (https://pnpm.io/installation or: npm install -g pnpm)")
fi

if ! have git; then
  MISSING+=("git (https://git-scm.com or: brew install git)")
fi

if [ "$WITH_TUI" -eq 1 ] || [ "$WITH_GUI" -eq 1 ]; then
  if ! have cargo; then
    MISSING+=("cargo / Rust toolchain (https://rustup.rs or: brew install rustup)")
  fi
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  echo
  die "Missing prerequisites:$(printf '\n  - %s' "${MISSING[@]}")"
fi

log "Node $(node --version), pnpm $(pnpm --version), git $(git --version | awk '{print $3}')"

# ---------- install + build ----------
log "Installing dependencies (pnpm install)"
pnpm install

log "Building TypeScript (pnpm build)"
pnpm build

# ---------- global link ----------
if [ "$SKIP_LINK" -eq 0 ]; then
  log "Linking Relay globally (pnpm link --global) — exposes 'rly' and legacy 'agent-harness'"
  if ! pnpm link --global; then
    warn "pnpm link --global failed — this is usually a PNPM_HOME or permissions issue."
    warn "Try one of:"
    warn "  sudo pnpm link --global"
    warn "  export PNPM_HOME=\"\$HOME/.local/share/pnpm\" && export PATH=\"\$PNPM_HOME:\$PATH\" && pnpm link --global"
    warn "Continuing — you can still invoke the CLI via: pnpm exec rly <cmd>"
  fi
else
  log "Skipping global link (--skip-link)"
fi

# ---------- optional Rust pieces ----------
if [ "$WITH_TUI" -eq 1 ]; then
  log "Building TUI (pnpm tui:build)"
  pnpm tui:build
fi

if [ "$WITH_GUI" -eq 1 ]; then
  log "Building GUI (pnpm gui:build)"
  pnpm gui:build
fi

# ---------- config scaffold ----------
RELAY_DIR="${HOME}/.relay"
LEGACY_DIR="${HOME}/.agent-harness"

# Auto-migrate: if legacy dir exists and the new one doesn't, rename + back-compat symlink.
if [ ! -d "$RELAY_DIR" ] && [ -d "$LEGACY_DIR" ]; then
  log "Migrating ${LEGACY_DIR} -> ${RELAY_DIR} (a back-compat symlink will stay at the old path)"
  mv "$LEGACY_DIR" "$RELAY_DIR"
  ln -s "$RELAY_DIR" "$LEGACY_DIR" || warn "Could not create back-compat symlink at ${LEGACY_DIR}; continuing."
fi

mkdir -p "$RELAY_DIR"

TEMPLATE="${RELAY_DIR}/config.env.template"
log "Writing config template -> ${TEMPLATE}"
cat > "$TEMPLATE" <<'ENVEOF'
# Relay config
#
# Copy this file to ~/.relay/config.env and fill in tokens.
# Then either:
#   source ~/.relay/config.env
# or add that line to your ~/.zshrc / ~/.bashrc so every shell picks it up.

# GitHub personal access token — enables issue ingestion + PR watcher.
# Scopes: repo (private repos) or public_repo (public only).
# export GITHUB_TOKEN=""

# Linear API key — enables Linear issue ingestion.
# (COMPOSIO_API_KEY works as an alias.)
# export LINEAR_API_KEY=""

# Set to 1 to use the real Claude/Codex adapters instead of the scripted demo.
# export HARNESS_LIVE=1
ENVEOF

CONFIG="${RELAY_DIR}/config.env"
if [ ! -f "$CONFIG" ]; then
  log "No existing config.env found — leaving template only (copy it over when ready)"
else
  log "Existing config.env preserved at ${CONFIG}"
fi

# ---------- next-steps banner ----------
BOX_LINE='────────────────────────────────────────────────────────────────────────'
echo
echo "┌${BOX_LINE}┐"
printf "│ %-70s │\n" "Relay installed (CLI: rly — legacy alias: agent-harness)"
echo "├${BOX_LINE}┤"
printf "│ %-70s │\n" "Next steps:"
printf "│ %-70s │\n" ""
printf "│ %-70s │\n" "1. cp ~/.relay/config.env.template ~/.relay/config.env"
printf "│ %-70s │\n" "   Fill in GITHUB_TOKEN / LINEAR_API_KEY, then:"
printf "│ %-70s │\n" "   source ~/.relay/config.env"
printf "│ %-70s │\n" "   (or add that line to ~/.zshrc)"
printf "│ %-70s │\n" ""
printf "│ %-70s │\n" "2. cd to any repo you want Relay to manage and run:"
printf "│ %-70s │\n" "   rly up"
printf "│ %-70s │\n" ""
printf "│ %-70s │\n" "3. Sanity-check your setup:"
printf "│ %-70s │\n" "   rly doctor"
printf "│ %-70s │\n" ""
printf "│ %-70s │\n" "4. Start a session:"
printf "│ %-70s │\n" "   rly claude    # or: rly codex"
echo "└${BOX_LINE}┘"
echo
