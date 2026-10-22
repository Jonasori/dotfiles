#!/usr/bin/env bash
# bootstrap.sh — create symlinks from home dirs → dotfiles
# Run on a new machine after cloning this repo to ~/dotfiles/
# Safe to re-run: skips if a symlink already points to the right place.
set -euo pipefail

DOTFILES="$HOME/dotfiles"

link() {
  local src="$DOTFILES/$1"
  local dst="$HOME/$2"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    echo "  ok  $dst"
    return
  fi
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "  mv  $dst → $dst.bak"
    mv "$dst" "$dst.bak"
  fi
  ln -sf "$src" "$dst"
  echo "  ln  $dst → $src"
}

linkdir() {
  local src="$DOTFILES/$1"
  local dst="$HOME/$2"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    echo "  ok  $dst/"
    return
  fi
  if [ -d "$dst" ] && [ ! -L "$dst" ]; then
    echo "  mv  $dst → $dst.bak"
    mv "$dst" "$dst.bak"
  fi
  ln -sf "$src" "$dst"
  echo "  ln  $dst/ → $src/"
}

# Append a guarded `source` line to a machine-local (untracked) rc file, once.
# For shared extras that must load AFTER machine-specific setup (starship, conda,
# …), so a whole-file symlink won't do — the line goes at the tail of the user's
# own file, which stays machine-specific.
ensure_sourced() {
  local rc="$HOME/$1" line="$2"
  touch "$rc"
  if grep -qF "$line" "$rc"; then
    echo "  ok  $rc already sources shared extras"
  else
    printf '\n# Shared, version-controlled shell extras\n%s\n' "$line" >>"$rc"
    echo "  ++  appended shared-extras source to $rc"
  fi
}

echo "=== Shell ==="
# ~/.bash_profile stays machine-specific (conda, brew, …) and untracked; it only
# sources our portable extras from the repo. Append that line if it's missing.
ensure_sourced .bash_profile '[ -f "$HOME/dotfiles/shell/bash_profile.shared" ] && . "$HOME/dotfiles/shell/bash_profile.shared"'

# Readline config is a whole file with no machine-specific parts, so it symlinks.
link shell/inputrc .inputrc

echo ""
echo "=== Ghostty ==="
link ghostty/config .config/ghostty/config

echo ""
echo "=== Pi (earendil-works/pi-coding-agent) ==="
link pi/gentle-ai/persona.json .pi/gentle-ai/persona.json
link pi/agent/LEARNED_RULES.md .pi/agent/LEARNED_RULES.md
link pi/agent/settings.json .pi/agent/settings.json
link pi/agent/themes/pi-code.json .pi/agent/themes/pi-code.json
linkdir pi/agent/agents .pi/agent/agents
linkdir pi/agent/chains .pi/agent/chains
linkdir pi/agent/extensions .pi/agent/extensions
linkdir pi/agent/prompts .pi/agent/prompts
linkdir pi/agent/skills .pi/agent/skills

echo ""
echo "=== Claude Code ==="
# The status line is not symlinked — settings.json points at it by absolute path
# ($HOME/dotfiles/claude/statusline/statusline.sh), which Claude Code expands.
link claude/settings.json .claude/settings.json
link claude/keybindings.json .claude/keybindings.json
linkdir claude/commands .claude/commands
linkdir claude/hooks .claude/hooks
linkdir claude/skills .claude/skills

echo ""
echo "=== Agent instructions ==="
# One owner for these: bin/sync-agent-wrappers points ~/.claude/CLAUDE.md,
# ~/.codex/AGENTS.md and ~/.pi/agent/AGENTS.md at the canonical AGENTS.md, links
# ~/.pi/agent/APPEND_SYSTEM.md, and removes wrappers we no longer keep. Do not add
# `link` lines for those files here — the two scripts would fight over them and
# leave dangling symlinks.
"$DOTFILES/bin/sync-agent-wrappers"
echo "  ok  agent instruction wrappers"

echo ""
echo "=== Claude Code MCP servers ==="
# User-scope MCP lives in ~/.claude.json, which is machine-local state and not
# tracked here — so re-register instead of symlinking. `claude mcp add` is not
# idempotent, hence the guard.
if claude mcp get excalidraw >/dev/null 2>&1; then
  echo "  ok  excalidraw"
else
  claude mcp add excalidraw --scope user \
    -e EXPRESS_SERVER_URL=http://127.0.0.1:3000 \
    -e ENABLE_CANVAS_SYNC=true \
    -- node "$HOME/tools/mcp_excalidraw/dist/index.js"
fi
# Canvas server itself: git clone https://github.com/yctimlin/mcp_excalidraw \
#   ~/tools/mcp_excalidraw && npm ci && npm run build && PORT=3000 npm run canvas

echo ""
echo "=== Herdr ==="
link herdr/config.toml .config/herdr/config.toml
# Manual per machine: System Settings → Keyboard → Modifier Keys → Caps Lock
# = Option. Herdr's prefix (alt+a) + ghostty/config's macos-option-as-alt do
# the rest.

# Integration hooks land in symlinked dirs (pi/agent/extensions, claude/hooks),
# so the files themselves are tracked — this just re-runs the installer.
# (Command substitution, not pipes: `grep -q` closes the pipe early and
# pipefail then reports SIGPIPE from herdr as a guard failure.)
if [[ "$(herdr integration status 2>/dev/null)" == *"pi: current"* ]]; then
  echo "  ok  herdr pi integration"
else
  herdr integration install pi
fi
if [[ "$(herdr integration status 2>/dev/null)" == *"claude: current"* ]]; then
  echo "  ok  herdr claude integration"
else
  herdr integration install claude
fi

# Plugins are machine-local (~/.config/herdr/plugins); config.toml binds
# prefix+m to memex's toggle action, so install it if missing.
if [[ "$(herdr plugin list 2>/dev/null)" == *"nicosuave.memex"* ]]; then
  echo "  ok  herdr plugin nicosuave.memex"
else
  herdr plugin install nicosuave/memex --yes
fi

echo ""
echo "=== Git: hide tool-written model preference ==="
# Claude Code and pi both rewrite their user-scope settings file when you switch
# model — Claude via /model, pi via Ctrl+S in /model or /thinking — and both files
# are symlinks into this repo, so every switch dirties the tree. Neither tool has
# a machine-local settings layer that could absorb it. skip-worktree keeps the
# files tracked and reviewable while hiding those local edits.
# To make an intentional edit visible again:
#   git -C ~/dotfiles update-index --no-skip-worktree <file>
for f in claude/settings.json pi/agent/settings.json; do
  if [ "$(git -C "$DOTFILES" ls-files -v "$f" | cut -c1)" = "S" ]; then
    echo "  ok  $f (skip-worktree)"
  else
    git -C "$DOTFILES" update-index --skip-worktree "$f"
    echo "  ++  $f skip-worktree"
  fi
done

echo ""
echo "Done. Credentials (pi/agent/auth.json, web-search.json) must be set up manually."
