# dotfiles

Cross-platform config for macOS and Linux (Arch/Omarchy). Symlinked via `bootstrap.sh`.

## Install

```bash
git clone --recurse-submodules https://github.com/Jonasori/dotfiles ~/dotfiles
cd ~/dotfiles && ./bootstrap.sh
```

Re-run `bootstrap.sh` any time new files are added — it's idempotent.

---

## Conventions — Read Before Changing Anything

### Paths in settings.json: `$HOME` in commands, but NOT in `env`

This file is shared across machines with different usernames, so never hardcode
`/Users/example/` or `/home/example/`.

`$HOME` works in **`command`** strings — Claude Code runs those through a shell,
which expands it:
```json
"command": "$HOME/dotfiles/claude/statusline/statusline.sh"   // ✅ expands
```

`$HOME` does **NOT** work in the **`env`** block. Those values are passed to
child processes verbatim — the shell never sees them, so `$HOME` stays literal.
A consumer that treats the value as a path then creates a relative directory
named `$HOME` in its working directory (this happened — stray `$HOME/` dirs
appeared in every project folder).

**Don't do this:**
```json
"env": { "SOME_DIR": "$HOME/.cache/thing" }   // ❌ literal "$HOME", spawns stray dirs
```
Either omit the path env var entirely and let the consumer fall back to a
`$HOME`-based default, or expand a leading `$HOME`/`${HOME}`/`~` inside the
consumer (see the `CACHE_DIR` block in `claude/statusline/statusline.sh`).

### Claude Code config is deliberately minimal

Keep configuration focused on the installed hooks and skills. Prefer a plugin or
a plain script when adding functionality.

### The status line is self-contained

`claude/statusline/` is a standalone bash script with no dependencies beyond
bash, jq, curl, and git. It caches to `~/.cache/claude-statusline/` and is
configured entirely through environment variables — see its README. Run
`claude/statusline/test.sh` after changing it.

`hibernate.hook.ts` lives in that same directory rather than a `hooks/` dir
because it is not independent of the status line: it pauses the session near the
5-hour usage limit, and the only source for that percentage is the native
`rate_limits` block, which Claude Code hands to the status line and to nothing
else. `statusline.sh` republishes it to `/tmp` for the hook to read. Change one,
check the other. It needs `bun`.

Both are referenced by absolute path in `settings.json`, so unlike the other
Claude files they are **not** symlinked by `bootstrap.sh`.

### Bootstrap wires the symlinks

`settings.json`, `keybindings.json`, `commands/`, `hooks/`, and `skills/` are
symlinks into this repo. If you add a new file or directory that needs to be
available at `~/.claude/`, add a `link`/`linkdir` line to `bootstrap.sh` and
re-run it.

Agent instruction files are the exception. `~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`, and
`~/.pi/agent/APPEND_SYSTEM.md` belong to `bin/sync-agent-wrappers`, which
`bootstrap.sh` calls; adding `link` lines for them here makes the two scripts
fight.

### Model preference is hidden from git

`claude/settings.json` and `pi/agent/settings.json` are symlinks into this repo,
and both tools rewrite them when you switch model — Claude Code via `/model`, pi
via Ctrl+S in `/model` or `/thinking`. Neither tool has a machine-local settings
layer that could absorb the write: pi has only global and project scopes, and
Claude Code's gitignored `.claude/settings.local.json` is project-scoped, not
user-scoped. So `bootstrap.sh` sets `skip-worktree` on both to keep the tree
clean.

The trade is that your own intentional edits to those two files are invisible to
`git status` too. Make a file visible before editing it, then commit:

```bash
git update-index --no-skip-worktree claude/settings.json
```

`skip-worktree` is per-clone state, so a new machine needs `bootstrap.sh` to
re-apply it. Check what is currently hidden with `git ls-files -v | grep '^S'`.
A pull that needs to update one of these files is refused until you un-hide it.

### Shell config is layered, not symlinked

`~/.bash_profile` stays **machine-specific and untracked** (conda, brew, starship,
and other per-machine tooling with hardcoded paths differ across machines). The
repo tracks only portable extras in `shell/bash_profile.shared`, and `bootstrap.sh`
appends one guarded `source` line to `~/.bash_profile` (via `ensure_sourced`, idempotent)
so the extras load at the tail — after machine setup. Put only cross-machine,
path-free shell config in `bash_profile.shared`.
