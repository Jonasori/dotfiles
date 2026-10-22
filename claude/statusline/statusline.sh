#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Claude Code status line — responsive display with 4 modes by terminal width:
#   nano (<35), micro (35-54), mini (55-79), normal (80+)
# Normal output: model/cwd → header (location, time, weather) → context → usage → quote
#
# Self-contained: no dependencies beyond bash, jq, curl, git.
# Caches live under $CACHE_DIR; nothing is written outside it and /tmp.
#
# Environment overrides (all optional):
#   STATUSLINE_CACHE_DIR   cache root         (default ~/.cache/claude-statusline)
#   STATUSLINE_TEMP_UNIT   fahrenheit|celsius (default fahrenheit)
#   STATUSLINE_TZ          IANA tz name       (default: system timezone)
#   STATUSLINE_ACCOUNT     header label       (default: derived from logged-in account)
#   ZENQUOTES_API_KEY      keyed quote API    (optional; keyless endpoint otherwise)
# ═══════════════════════════════════════════════════════════════════════════════

set -o pipefail

# Requires bash 4+ (\U escapes, ${var^^}). The shebang is `env bash` rather than
# /bin/bash on purpose: macOS pins /bin/bash at 3.2 forever, so an absolute path
# would silently select the ancient one even with a modern bash installed.
#
# When PATH hands us that 3.2 anyway, re-exec under a Homebrew bash rather than
# giving up. This is what keeps the command in settings.json portable: pinning
# /opt/homebrew/bin/bash there works on exactly one machine's prefix and leaves a
# Linux box with no status line at all — and no status line means no live usage
# file, which silently disables hibernation. The guard variable is what stops a
# re-exec loop if the replacement turns out to be old too.
if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ] && [ -z "${STATUSLINE_REEXEC:-}" ]; then
    for _newer_bash in /opt/homebrew/bin/bash /usr/local/bin/bash; do
        [ -x "$_newer_bash" ] && STATUSLINE_REEXEC=1 exec "$_newer_bash" "$0" "$@"
    done
fi

if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
    # Deliberately stdout: Claude Code renders stdout as the footer and discards
    # stderr, so a stderr-only message would leave a blank status line and no
    # indication why. Exit 0 — a non-zero status here buys nothing and some
    # harness versions log it noisily.
    printf 'statusline: needs bash 4+, got %s — install a newer bash (brew install bash)\n' \
        "${BASH_VERSION%%(*}"
    exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────────────────────────────────────

CLAUDE_HOME="$HOME/.claude"

# Cache root. Claude Code does not shell-expand values in settings.json env{},
# so an override may arrive as the literal string "$HOME/...". Bash does not
# re-expand the inner $HOME on use, making it a relative path that spawns a
# stray "$HOME" directory in the CWD. Expand a leading $HOME/${HOME}/~ first.
CACHE_DIR="${STATUSLINE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/claude-statusline}"
CACHE_DIR="${CACHE_DIR/#\$\{HOME\}/$HOME}"
CACHE_DIR="${CACHE_DIR/#\$HOME/$HOME}"
CACHE_DIR="${CACHE_DIR/#\~/$HOME}"
mkdir -p "$CACHE_DIR" 2>/dev/null

MODEL_CACHE="$CACHE_DIR/model.txt"
QUOTE_CACHE="$CACHE_DIR/quote.txt"
LOCATION_CACHE="$CACHE_DIR/location.json"
WEATHER_CACHE="$CACHE_DIR/weather.txt"
USAGE_CACHE="$CACHE_DIR/usage.json"

# Live 5h/7d usage, republished on every refresh for hibernate.hook.ts. Lives in
# /tmp rather than $CACHE_DIR because it is per-boot scratch, not a warm cache —
# a stale copy surviving a reboot is exactly what its freshness guard rejects.
USAGE_LIVE="/tmp/claude-statusline-usage-${USER:-anon}.json"

# Hibernation banner, written by hibernate.hook.ts while it sleeps out a usage
# window: one line, "<wake-epoch-seconds> <pct>". A blocked hook renders nothing of
# its own, so without this the session looks hung for hours. Flat text, not JSON —
# this is read on every 2s refresh and does not deserve a jq fork.
HIBERNATE_STATE="/tmp/claude-hibernate-${USER:-anon}"

TEMP_UNIT="${STATUSLINE_TEMP_UNIT:-fahrenheit}"
[ "$TEMP_UNIT" != "celsius" ] && TEMP_UNIT="fahrenheit"

# Timezone for usage-reset display. Derive from the system when not overridden —
# /etc/localtime is a symlink into the zoneinfo tree on both macOS and Linux.
USER_TZ="${STATUSLINE_TZ:-}"
if [ -z "$USER_TZ" ]; then
    USER_TZ=$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')
    USER_TZ="${USER_TZ:-${TZ:-UTC}}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# ACCOUNT LABEL — which login this pane is running as
# ─────────────────────────────────────────────────────────────────────────────
# Leads the header line. Worth the space because it is the one thing you cannot
# infer from the rest of the footer, and getting it wrong means running work
# against the wrong org's rate limit.
#
# Name comes from ~/.claude.json (.oauthAccount). Prefer the org name for
# enterprise logins; a personal login gets an auto-named org, so fall
# back to the bare email there.
#
# CAVEAT that motivated the cross-check below: .oauthAccount is a CACHED PROFILE
# BLOB, not the live credential. It is refreshed opportunistically, and it can sit
# holding a different account's profile for hours — observed in the wild showing a
# personal Max profile while the keychain token was enterprise the whole time. A
# label that confidently names the wrong org is worse than no label, so verify it
# against the token that actually authenticates requests:
#   keychain "Claude Code-credentials" -> .claudeAiOauth.subscriptionType
# If the token says enterprise and the cached profile does not (or vice versa),
# the cache is stale — show the token's subscription type rather than a name we
# cannot stand behind.
#
# Both reads cost enough to matter on a 2s refresh (a ~100KB jq parse and a
# `security` fork), so they sit behind the same mtime cache and only re-run when
# ~/.claude.json actually changes.
ACCOUNT_LABEL="${STATUSLINE_ACCOUNT:-}"
if [ -z "$ACCOUNT_LABEL" ]; then
    _ACCOUNT_JSON="$HOME/.claude.json"
    _ACCOUNT_CACHE="/tmp/claude-statusline-account-${USER:-anon}.sh"
    if [ -f "$_ACCOUNT_CACHE" ] && [ -f "$_ACCOUNT_JSON" ] && [ "$_ACCOUNT_JSON" -ot "$_ACCOUNT_CACHE" ]; then
        # shellcheck disable=SC1090
        source "$_ACCOUNT_CACHE"
    else
        # Live token's subscription type. Empty if unreadable — then we just trust
        # the cached profile, having nothing to contradict it with.
        if [ "$(uname -s)" = "Darwin" ]; then
            _tok=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
        else
            _tok=$(cat "$HOME/.claude/.credentials.json" 2>/dev/null)
        fi
        _tok_sub=$(printf '%s' "$_tok" | jq -r '.claudeAiOauth.subscriptionType // empty' 2>/dev/null)
        unset _tok

        # --- label-jq-begin --- (extracted verbatim by test.sh; keep the markers)
        jq -r --arg tok "$_tok_sub" '
          .oauthAccount // {} |
          (.organizationName // "") as $org |
          (.emailAddress // "") as $email |
          (.organizationType // "") as $otype |
          # Personal accounts get an auto-named org (<email> + apostrophe + s +
          # " Organization"). That is not a real org, so fall back to the bare
          # email. The apostrophe is written \u0027 because a literal one would
          # end the shell quoting around this jq program.
          (if ($org | length) > 0 and $org != ($email + "\u0027s Organization")
           then $org else $email end) as $name |
          # Stale-cache guard: the token knows enterprise vs not, and the profile
          # encodes the same fact in organizationType. Disagreement means the
          # profile describes a different account than the one actually in use.
          (($otype == "claude_enterprise") as $profile_ent |
           if   ($tok | length) == 0            then $name
           elif ($tok == "enterprise") == $profile_ent then $name
           else $tok end)
          | "ACCOUNT_LABEL=" + @sh
        ' "$_ACCOUNT_JSON" 2>/dev/null > "$_ACCOUNT_CACHE"
        # --- label-jq-end ---
        # Which kind of account the token belongs to. The usage block needs this to
        # pick a source (enterprise credit meter vs 5h/7d windows), and this is the
        # one place a keychain read is already being paid for, so record it here
        # rather than forking `security` a second time on a 2s refresh. Stripped to
        # alphanumerics so that sourcing the cache can never execute anything.
        printf 'ACCOUNT_SUB=%s\n' "$(printf '%s' "$_tok_sub" | tr -dc '[:alnum:]_')" >> "$_ACCOUNT_CACHE"
        # shellcheck disable=SC1090
        source "$_ACCOUNT_CACHE"
    fi
fi
# Empty when the account cache predates this field, or no token was readable.
ACCOUNT_SUB="${ACCOUNT_SUB:-}"
# Never leave the header leaderless — fall back to a neutral glyph.
ACCOUNT_LABEL="${ACCOUNT_LABEL:-▲}"
# Expanded inside a printf FORMAT string downstream — double any % so it prints
# literally rather than being read as a conversion spec.
ACCOUNT_LABEL="${ACCOUNT_LABEL//\%/%%}"

# Cache TTL in seconds — rationale documented for each
# ┌─────────────────┬────────┬──────────────────────────────────────────────────┐
# │ Cache           │ TTL    │ Rationale                                        │
# ├─────────────────┼────────┼──────────────────────────────────────────────────┤
# │ Location        │ 3600s  │ IP/geo rarely changes; external API              │
# │ Weather         │  900s  │ 15 min: weather changes slowly                   │
# │ Usage (OAuth)   │  900s  │ 15 min: /api/oauth/usage has aggressive 429 limits│
# │ Usage (credits) │   60s  │ 1 min: your own /v1/messages, ~8 tokens per probe │
# │ Session name    │ mtime  │ Invalidated when source files change             │
# │ Quote           │   60s  │ 1 min: keyed ZenQuotes is effectively unlimited  │
# │ Model           │ n/a    │ Written once per session, no TTL                 │
# │ Terminal width  │ n/a    │ Written once, read as fallback                   │
# └─────────────────┴────────┴──────────────────────────────────────────────────┘
LOCATION_CACHE_TTL=3600
WEATHER_CACHE_TTL=900
USAGE_CACHE_TTL=900      # 15 min: /api/oauth/usage has aggressive per-token rate limits (~5 req before 429)

# Enterprise seats have no 5h/7d windows. Their only usage figure is the org
# credit meter, which is reported solely on the anthropic-ratelimit-unified-*
# response headers of a /v1/messages call — /api/oauth/usage answers 429 to these
# tokens, prepaid/credits is Pro/Max only, and no read-only endpoint carries the
# headers (count_tokens, /v1/models, and rejected requests all return none). So
# the probe below buys the cheapest completion there is to read them: 8 input
# tokens, ~$0.006/day at one a minute. Cheap enough to refresh on its own, much
# shorter clock — the 900s above exists only to stay off the OAuth endpoint,
# which this path never touches.
ENTERPRISE_PROBE_MODEL="claude-haiku-4-5-20251001"
ENTERPRISE_CACHE_TTL=60  # 1 min: the credit meter moves while you work

# Cross-platform file mtime (seconds since epoch). Detect stat flavor once;
# probing both variants on every mtime check is expensive on macOS.
if _stat_probe=$(stat -f %m "$0" 2>/dev/null) && [[ "$_stat_probe" =~ ^[0-9]+$ ]]; then
    STAT_FLAVOR="bsd"
else
    STAT_FLAVOR="gnu"
fi
unset _stat_probe

get_mtime() {
    if [ "$STAT_FLAVOR" = "bsd" ]; then
        stat -f %m "$1" 2>/dev/null || echo 0
    else
        stat -c %Y "$1" 2>/dev/null || echo 0
    fi
}

if date --version >/dev/null 2>&1; then
    DATE_FLAVOR="gnu"
else
    DATE_FLAVOR="bsd"
fi

# Parse timestamp to epoch seconds — handles both Unix epoch integers
# (from Claude Code native rate_limits) and ISO 8601 strings (from OAuth API)
parse_iso_epoch() {
    local ts="$1"
    [ -z "$ts" ] && echo 0 && return
    # If it's already a plain integer (epoch seconds), return directly
    if [[ "$ts" =~ ^[0-9]+$ ]]; then
        echo "$ts"
        return
    fi
    local clean="$ts"
    if [[ "$clean" =~ ^(.*)\.[0-9]+(Z|[+-][0-9][0-9]:[0-9][0-9])$ ]]; then
        clean="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
    elif [[ "$clean" =~ ^(.*)\.[0-9]+$ ]]; then
        clean="${BASH_REMATCH[1]}"
    fi
    if [[ "$clean" =~ ^(.*)([+-][0-9][0-9]):([0-9][0-9])$ ]]; then
        clean="${BASH_REMATCH[1]}${BASH_REMATCH[2]}${BASH_REMATCH[3]}"
    elif [[ "$clean" =~ Z$ ]]; then
        clean="${clean%Z}+0000"
    else
        clean="${clean}+0000"
    fi
    if [ "$DATE_FLAVOR" = "gnu" ]; then
        date -d "$ts" +%s 2>/dev/null || echo 0
    else
        date -jf "%Y-%m-%dT%H:%M:%S%z" "$clean" +%s 2>/dev/null || echo 0
    fi
}

# Format epoch as absolute reset time (e.g., "today@1500", "Thu@0900")
reset_time_str() {
    local epoch="$1"
    [ -z "$epoch" ] || [ "$epoch" -le 0 ] 2>/dev/null && echo "now" && return
    local now_epoch="${NOW_EPOCH:-$(date +%s)}"
    [ "$epoch" -le "$now_epoch" ] 2>/dev/null && echo "now" && return
    local reset_day reset_time today_day reset_dow reset_mon reset_dom dow
    if [ "$DATE_FLAVOR" = "gnu" ]; then
        # GNU date
        read -r reset_day reset_time reset_dow reset_mon reset_dom <<< "$(LC_ALL=C TZ="$USER_TZ" date -d "@$epoch" "+%Y-%m-%d %H%M %w %b %d")"
        today_day=$(TZ="$USER_TZ" date +%Y-%m-%d)
    else
        # macOS/BSD date
        read -r reset_day reset_time reset_dow reset_mon reset_dom <<< "$(LC_ALL=C TZ="$USER_TZ" date -r "$epoch" "+%Y-%m-%d %H%M %w %b %d")"
        today_day=$(TZ="$USER_TZ" date +%Y-%m-%d)
    fi
    if [ "$reset_day" = "$today_day" ]; then
        echo "TODAY@${reset_time}"
    elif [ $((epoch - now_epoch)) -ge $((6 * 86400)) ]; then
        # A weekday alone reads as this week; the enterprise credit pool resets
        # monthly, weeks out.
        echo "${reset_mon^^}${reset_dom#0}@${reset_time}"
    else
        case "$reset_dow" in
            0) dow="SUN" ;; 1) dow="MON" ;; 2) dow="TUE" ;; 3) dow="WED" ;;
            4) dow="THU" ;; 5) dow="FRI" ;; 6) dow="SAT" ;; *) dow="NOW" ;;
        esac
        echo "${dow}@${reset_time}"
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# PARSE INPUT (must happen before parallel block consumes stdin)
# ─────────────────────────────────────────────────────────────────────────────

input=$(cat)

# Extract all data from JSON in single jq call
eval "$(jq -r '
  "current_dir=" + (.workspace.current_dir // .cwd // "." | @sh) + "\n" +
  "session_id=" + (.session_id // "" | @sh) + "\n" +
  "transcript_path=" + (.transcript_path // "" | @sh) + "\n" +
  "model_name=" + (.model.display_name // "unknown" | @sh) + "\n" +
  "cc_version_json=" + (.version // "" | @sh) + "\n" +
  "context_max=" + (.context_window.context_window_size // 200000 | tostring) + "\n" +
  "context_pct=" + (.context_window.used_percentage // 0 | tostring) + "\n" +
  "total_input=" + (.context_window.total_input_tokens // 0 | tostring) + "\n" +
  "has_native_rate_limits=" + ((.rate_limits != null) | tostring) + "\n" +
  "native_usage_5h=" + (.rate_limits.five_hour.used_percentage // .rate_limits.five_hour.utilization // 0 | tostring) + "\n" +
  "native_usage_5h_reset=" + (.rate_limits.five_hour.resets_at // "" | @sh) + "\n" +
  "native_usage_7d=" + (.rate_limits.seven_day.used_percentage // .rate_limits.seven_day.utilization // 0 | tostring) + "\n" +
  "native_usage_7d_reset=" + (.rate_limits.seven_day.resets_at // "" | @sh) + "\n" +
  "native_usage_opus=" + (if .rate_limits.seven_day_opus then (.rate_limits.seven_day_opus.used_percentage // .rate_limits.seven_day_opus.utilization // 0 | tostring) else "null" end) + "\n" +
  "native_usage_sonnet=" + (if .rate_limits.seven_day_sonnet then (.rate_limits.seven_day_sonnet.used_percentage // .rate_limits.seven_day_sonnet.utilization // 0 | tostring) else "null" end) + "\n" +
  "native_usage_extra_enabled=" + (.rate_limits.extra_usage.is_enabled // false | tostring) + "\n" +
  "native_usage_extra_limit=" + (.rate_limits.extra_usage.monthly_limit // 0 | tostring) + "\n" +
  "native_usage_extra_used=" + (.rate_limits.extra_usage.used_credits // 0 | tostring)
' 2>/dev/null <<< "$input")"

# Ensure defaults for critical numeric values
context_pct=${context_pct:-0}
context_max=${context_max:-200000}
total_input=${total_input:-0}
has_native_rate_limits="${has_native_rate_limits:-false}"

# ─────────────────────────────────────────────────────────────────────────────
# PUBLISH LIVE USAGE (for hibernate.hook.ts)
# ─────────────────────────────────────────────────────────────────────────────
# The native rate_limits block is only ever handed to the statusline — a
# PreToolUse hook does not get it on stdin, and pulling the OAuth token from the
# keychain to ask directly is off-limits. So we persist it here, and the
# hibernate hook reads it. Written before any width-mode branching so it stays
# fresh even in nano/micro panes that never render the usage row.
#
# Best-effort: a failure here must never affect the statusline output below.
if [ "$has_native_rate_limits" = "true" ]; then
    printf '{"five_hour_pct":%s,"five_hour_reset":"%s","seven_day_pct":%s,"seven_day_reset":"%s","ts":%s}\n' \
        "${native_usage_5h:-0}" "${native_usage_5h_reset:-}" \
        "${native_usage_7d:-0}" "${native_usage_7d_reset:-}" \
        "$(date +%s)" \
        > "$USAGE_LIVE" 2>/dev/null
fi

# ── Startup context estimate (fresh calculation, no cross-session caching) ─
# Before the first API call, Claude Code provides no token data. We estimate
# from measured file sizes + per-item token costs.
# Token ratio: ~3.5 chars/token for text content (bytes * 10 / 35).
# ───────────────────────────────────────────────────────────────────────────
if [ "$context_pct" = "0" ] && [ "$total_input" -eq 0 ] 2>/dev/null; then
    # Cache estimate per session — the inputs (CLAUDE.md, system prompt,
    # skill count, etc.) don't change mid-session, so recomputing on every
    # 1-second tick while total_input=0 is pure waste. ~8-12 subprocess
    # spawns (wc, jq, fd, git) eliminated per tick once cached.
    _STARTUP_EST_CACHE="/tmp/claude-statusline-startup-${session_id:-nosess}.sh"
    if [ -f "$_STARTUP_EST_CACHE" ]; then
        # shellcheck disable=SC1090
        source "$_STARTUP_EST_CACHE"
    else
        # Claude Code system prompt (~5k tokens — includes base instructions, mode rules,
        # permission model, output format, etc.)
        _est=5000

        # Claude Code tool definitions (~12k tokens — Agent tool alone is ~4k with all
        # subagent descriptions; Bash, Read, Edit, Write, Glob, Grep, Skill, ToolSearch
        # each 200-500 tokens; deferred tool names list ~500 tokens)
        _est=$((_est + 12000))

        # CLAUDE.md (loaded natively by Claude Code, ~3.5 chars/token)
        [ -f "$CLAUDE_HOME/CLAUDE.md" ] && _est=$((_est + $(wc -c < "$CLAUDE_HOME/CLAUDE.md") * 10 / 35))

        # Project memory files (CC native memory at ~/.claude/projects/*/memory/)
        for _f in "$HOME"/.claude/projects/*/memory/MEMORY.md; do
            [ -f "$_f" ] && _est=$((_est + $(wc -c < "$_f") * 10 / 35))
        done

        # Skill trigger descriptions (~150 tokens each — name, trigger phrases, examples)
        # and agent descriptions (~200 tokens each). Both user-level and plugin-provided.
        # Use bash globs — ~10-20ms faster than `fd` forks.
        shopt -s nullglob 2>/dev/null
        _sk_user=("$CLAUDE_HOME"/skills/*/SKILL.md)
        _sk_plugin=("$CLAUDE_HOME"/plugins/*/*/skills/*/SKILL.md)
        _ag_user=("$CLAUDE_HOME"/agents/*.md)
        _ag_plugin=("$CLAUDE_HOME"/plugins/*/*/agents/*.md)
        shopt -u nullglob 2>/dev/null
        _est=$((_est + (${#_sk_user[@]} + ${#_sk_plugin[@]}) * 150))
        _est=$((_est + (${#_ag_user[@]} + ${#_ag_plugin[@]}) * 200))

        # Git status block (injected by Claude Code — branch, status, recent commits)
        _git_bytes=$(timeout 1 git -C "$current_dir" status --porcelain 2>/dev/null | wc -c | tr -d ' ')
        _est=$((_est + ${_git_bytes:-0} * 10 / 35 + 500))  # +500 for commit log, branch info

        # Initial user message + startup hook system-reminders (currentDate, fast_mode_info,
        # gitStatus header, settings-based reminders)
        _est=$((_est + 3000))

        context_pct=$((_est * 100 / context_max))
        startup_tokens=$_est

        # Persist for this session's remaining pre-first-API ticks
        {
            echo "_est=$_est"
            echo "context_pct=$context_pct"
            echo "startup_tokens=$startup_tokens"
        } > "$_STARTUP_EST_CACHE" 2>/dev/null
    fi
fi

# Get Claude Code version — prefer JSON input, then mtime-cached value,
# fall back to forking `claude --version` (40-80ms, so cached for 24h).
_CC_VERSION_CACHE="$CACHE_DIR/cc-version.txt"
if [ -n "$cc_version_json" ] && [ "$cc_version_json" != "unknown" ]; then
    cc_version="$cc_version_json"
elif [ -f "$_CC_VERSION_CACHE" ] && [ -z "$(find "$_CC_VERSION_CACHE" -mtime +1 2>/dev/null)" ]; then
    cc_version=$(cat "$_CC_VERSION_CACHE" 2>/dev/null)
fi
if [ -z "$cc_version" ] || [ "$cc_version" = "unknown" ]; then
    cc_version=$(claude --version 2>/dev/null | head -1 | awk '{print $1}')
    cc_version="${cc_version:-unknown}"
    [ "$cc_version" != "unknown" ] && echo "$cc_version" > "$_CC_VERSION_CACHE" 2>/dev/null
fi

# Cache model name for other tools
mkdir -p "$(dirname "$MODEL_CACHE")" 2>/dev/null
echo "$model_name" > "$MODEL_CACHE" 2>/dev/null

# Display model: strip "Claude " or "claude-" prefix, capitalize first letter
_model_disp="${model_name#Claude }"
_model_disp="${_model_disp#claude-}"
_model_disp="${_model_disp^}"
[ "$_model_disp" = "Unknown" ] && _model_disp="—"

# CWD with ~ substitution for display
# Abbreviate a leading $HOME to ~. Deliberately NOT written as
# "${current_dir/#$HOME/~}" — bash performs tilde expansion on a substitution's
# replacement from 4.x onward, so there the ~ expands right back to $HOME and the
# whole thing silently becomes a no-op. Escaping it (\~) fixes 5.x and breaks 3.2,
# which emits a literal backslash. Prefix-strip works identically in every version.
_cwd="$current_dir"
if [ "${_cwd#"$HOME"}" != "$_cwd" ]; then
    _cwd="~${_cwd#"$HOME"}"
fi
[ -z "$_cwd" ] && _cwd="."

# Get the session label from the transcript, which carries two kinds of title
# record, appended as they change:
#   {"type":"custom-title","customTitle":"..."}  — set by /rename
#   {"type":"ai-title","aiTitle":"..."}          — auto-generated default
# A rename does NOT stop ai-title records from being appended afterwards, so
# position is not authority: a custom title always wins, and only when there is
# none do we fall back to the latest ai-title.
#
# grep narrows a multi-MB transcript to a handful of short lines before jq sees
# it — the scan is C-speed and jq only parses what matched.
SESSION_LABEL=""
SESSION_CACHE="$CACHE_DIR/session-name.sh"
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
    # Fast path: shell cache, invalidated when the transcript grows (catches /rename)
    if [ -f "$SESSION_CACHE" ]; then
        source "$SESSION_CACHE" 2>/dev/null
        if [ "${cached_session_id:-}" = "$session_id" ] && [ -n "${cached_session_label:-}" ]; then
            [ "$(get_mtime "$SESSION_CACHE")" -ge "$(get_mtime "$transcript_path")" ] && \
                SESSION_LABEL="${cached_session_label}"
        fi
    fi

    if [ -z "$SESSION_LABEL" ]; then
        SESSION_LABEL=$(grep -e '"type":"custom-title"' -e '"type":"ai-title"' "$transcript_path" 2>/dev/null \
            | jq -rs 'map(select(.customTitle // .aiTitle))
                      | (map(select(.type == "custom-title")) | last)
                        // (map(select(.type == "ai-title")) | last)
                      | (.customTitle // .aiTitle // empty)' 2>/dev/null)
    fi

    # Update cache with whatever we found
    if [ -n "$SESSION_LABEL" ]; then
        printf "cached_session_id='%s'\ncached_session_label='%s'\n" "$session_id" "$SESSION_LABEL" > "$SESSION_CACHE"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# TERMINAL WIDTH DETECTION
# ─────────────────────────────────────────────────────────────────────────────
# Hooks don't inherit terminal context. Try multiple methods. Width is detected
# before prefetch so narrow modes can skip work they never render.

_width_cache="/tmp/claude-statusline-width-${KITTY_WINDOW_ID:-default}"

detect_terminal_width() {
    local width=""

    # Tier 1: Kitty IPC (most accurate for Kitty panes)
    if [ -n "$KITTY_WINDOW_ID" ] && command -v kitten >/dev/null 2>&1; then
        width=$(kitten @ ls 2>/dev/null | jq -r --argjson wid "$KITTY_WINDOW_ID" \
            '.[].tabs[].windows[] | select(.id == $wid) | .columns' 2>/dev/null)
    fi

    # Tier 2: Direct TTY query
    [ -z "$width" ] || [ "$width" = "0" ] || [ "$width" = "null" ] && \
        width=$({ stty size </dev/tty; } 2>/dev/null | awk '{print $2}')

    # Tier 3: tput fallback
    [ -z "$width" ] || [ "$width" = "0" ] && width=$(tput cols 2>/dev/null)

    # If we got a real width, cache it for subprocess re-renders
    if [ -n "$width" ] && [ "$width" != "0" ] && [ "$width" -gt 0 ] 2>/dev/null; then
        echo "$width" > "$_width_cache" 2>/dev/null
        echo "$width"
        return
    fi

    # Tier 4: Read cached width from previous successful detection
    if [ -f "$_width_cache" ]; then
        local cached
        cached=$(cat "$_width_cache" 2>/dev/null)
        if [ "$cached" -gt 0 ] 2>/dev/null; then
            echo "$cached"
            return
        fi
    fi

    # Tier 5: Environment variable / default
    # Treat $COLUMNS=0 (and any non-positive value) as unset. Some hook
    # spawn contexts (Claude Code's statusline subprocess on a headless
    # server, no TTY, no Kitty IPC, no /dev/tty) export COLUMNS=0, which
    # would otherwise pass `${COLUMNS:-80}` straight through and force
    # MODE=nano — silently dropping the wide-mode rows from the render.
    if [ -n "${COLUMNS:-}" ] && [ "$COLUMNS" -gt 0 ] 2>/dev/null; then
        echo "$COLUMNS"
    else
        echo "80"
    fi
}

term_width=$(detect_terminal_width)

# Final guard: if everything fell through and we still have an invalid
# width, force normal mode rather than degrading to nano. Full-row
# version visibility matters more than format compactness here.
if [ -z "$term_width" ] || [ "$term_width" -le 0 ] 2>/dev/null; then
    term_width=80
fi

if [ "$term_width" -lt 35 ]; then
    MODE="nano"
elif [ "$term_width" -lt 55 ]; then
    MODE="micro"
elif [ "$term_width" -lt 80 ]; then
    MODE="mini"
else
    MODE="normal"
fi

# Content width: cap at 72 so wide terminals don't stretch, but narrow ones fit
content_width=$term_width
[ "$content_width" -gt 72 ] && content_width=72
[ "$content_width" -lt 10 ] && content_width=10

_repeat_chars() {
    local n="$1" ch="$2" s
    printf -v s '%*s' "$n" ''
    printf '%s' "${s// /$ch}"
}

SEP_SOLID=$(_repeat_chars "$content_width" "─")
SEP_DASHED=$(_repeat_chars "$content_width" "┄")

# Separator line helper — generates ─ repeated to content_width
sep() {
    printf "${SLATE_600}%s${RESET}\n" "$SEP_SOLID"
}

# ─────────────────────────────────────────────────────────────────────────────
# PARALLEL PREFETCH - Launch expensive operations needed by current width mode
# ─────────────────────────────────────────────────────────────────────────────
# Blocks write to $_parallel_tmp/{name}.sh and are skipped when the active
# width mode never renders that data.
#   git.sh      — Branch, stash, sync, last commit (all modes)
#   location.sh — City/state from ip-api.com (mini/normal)
#   weather.sh  — Temperature/conditions from open-meteo.com (mini/normal)
#   usage.sh    — Anthropic API rate limits 5H/WK (normal)
#   quote       — ZenQuotes API cache refresh (normal)
# Results are sourced after `wait` at the end of the block.

_parallel_tmp="/tmp/claude-statusline-parallel-$$"
mkdir -p "$_parallel_tmp"
NOW_EPOCH=$(date +%s)

# --- PARALLEL BLOCK START ---
{
    # 1. Git — FAST INDEX-ONLY ops (<50ms total, no working tree scan)
    #    No git status, no git diff, no file counts. Those scan 76K+ tracked files = 4-7s.
    if git rev-parse --git-dir > /dev/null 2>&1; then
        branch=$(git branch --show-current 2>/dev/null)
        [ -z "$branch" ] && branch="detached"
        stash_count=$(git stash list 2>/dev/null | wc -l | tr -d ' ')
        [ -z "$stash_count" ] && stash_count=0
        sync_info=$(git rev-list --left-right --count HEAD...@{u} 2>/dev/null)
        last_commit_epoch=$(git log -1 --format='%ct' 2>/dev/null)

        if [ -n "$sync_info" ]; then
            read -r ahead behind <<< "$sync_info"
        else
            ahead=0
            behind=0
        fi
        [ -z "$ahead" ] && ahead=0
        [ -z "$behind" ] && behind=0

        cat > "$_parallel_tmp/git.sh" << GITEOF
branch='$branch'
stash_count=${stash_count:-0}
ahead=${ahead:-0}
behind=${behind:-0}
last_commit_epoch=${last_commit_epoch:-0}
is_git_repo=true
GITEOF
    else
        echo "is_git_repo=false" > "$_parallel_tmp/git.sh"
    fi
} &

if [ "$MODE" = "mini" ] || [ "$MODE" = "normal" ]; then
{
    # 2. Location fetch (with caching)
    cache_age=999999
    [ -f "$LOCATION_CACHE" ] && cache_age=$((NOW_EPOCH - $(get_mtime "$LOCATION_CACHE")))

    if [ "$cache_age" -gt "$LOCATION_CACHE_TTL" ]; then
        loc_data=$(curl -s --max-time 2 "http://ip-api.com/json/?fields=city,region,regionName,country,countryCode,lat,lon" 2>/dev/null)
        if [ -n "$loc_data" ] && echo "$loc_data" | jq -e '.city' >/dev/null 2>&1; then
            echo "$loc_data" > "$LOCATION_CACHE"
        fi
    fi

    # Convert ISO 3166-1 alpha-2 country code → flag emoji (regional indicator pair).
    # Regional indicators are U+1F1E6 ('A') through U+1F1FF ('Z'), so each letter
    # maps to its code point by offset and printf %b renders the \U escape.
    cc_to_flag() {
        local code="${1:-}"
        [ "${#code}" -ne 2 ] && { printf '🌐'; return; }
        local c1 c2
        printf -v c1 '%d' "'${code:0:1}"
        printf -v c2 '%d' "'${code:1:1}"
        if (( c1 < 65 || c1 > 90 || c2 < 65 || c2 > 90 )); then printf '🌐'; return; fi
        printf '%b' "\\U$(printf '%08X' $((0x1F1E6 + c1 - 65)))\\U$(printf '%08X' $((0x1F1E6 + c2 - 65)))"
    }

    if [ -f "$LOCATION_CACHE" ]; then
        eval "$(jq -r '"_lc_city=" + (.city // "" | @sh) + "\n_lc_region=" + (.region // .regionName // "" | @sh) + "\n_lc_cc=" + (.countryCode // "" | @sh)' "$LOCATION_CACHE" 2>/dev/null)"
        _lc_flag=$(cc_to_flag "$_lc_cc")
        # Uppercase city and state for header display.
        _lc_city_upper="${_lc_city^^}"
        _lc_region_upper="${_lc_region^^}"
        {
            printf "location_city=%q\n" "$_lc_city_upper"
            printf "location_state=%q\n" "$_lc_region_upper"
            printf "location_flag=%q\n" "$_lc_flag"
        } > "$_parallel_tmp/location.sh"
    else
        echo -e "location_city='UNKNOWN'\nlocation_state=''\nlocation_flag='🌐'" > "$_parallel_tmp/location.sh"
    fi
} &
fi

if [ "$MODE" = "mini" ] || [ "$MODE" = "normal" ]; then
{
    # 3. Weather fetch (with caching)
    cache_age=999999
    [ -f "$WEATHER_CACHE" ] && cache_age=$((NOW_EPOCH - $(get_mtime "$WEATHER_CACHE")))

    if [ "$cache_age" -gt "$WEATHER_CACHE_TTL" ]; then
        lat="" lon=""
        if [ -f "$LOCATION_CACHE" ]; then
            eval "$(jq -r '"lat=\(.lat // empty)\nlon=\(.lon // empty)"' "$LOCATION_CACHE" 2>/dev/null)"
        fi
        lat="${lat:-37.7749}"
        lon="${lon:-122.4194}"

        weather_json=$(curl -s --max-time 3 "https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day&temperature_unit=${TEMP_UNIT}" 2>/dev/null)
        if [ -n "$weather_json" ] && echo "$weather_json" | jq -e '.current' >/dev/null 2>&1; then
            eval "$(echo "$weather_json" | jq -r '.current | "temp=\(.temperature_2m)\ncode=\(.weather_code)\nis_day=\(.is_day)"' 2>/dev/null)"
            # Map open-meteo weather_code → single emoji glyph (clear/cloudy/fog/rain/snow/storm)
            # Day vs. night uses the is_day flag to pick sun ☀ vs. moon 🌙 for clear conditions.
            case "$code" in
                0)              [ "${is_day:-1}" = "0" ] && icon="🌙" || icon="☀️" ;;
                1)              [ "${is_day:-1}" = "0" ] && icon="🌙" || icon="🌤️" ;;
                2)              icon="⛅" ;;
                3)              icon="☁️" ;;
                45|48)          icon="🌫️" ;;
                51|53|55|56|57) icon="🌦️" ;;
                61|63|65|66|67) icon="🌧️" ;;
                80|81|82)       icon="🌧️" ;;
                71|73|75|77|85|86) icon="🌨️" ;;
                95|96|99)       icon="⛈️" ;;
                *)              icon="🌡️" ;;
            esac
            temp_int=$(printf '%.0f' "$temp")
            if [ "$TEMP_UNIT" = "celsius" ]; then
                echo "${icon} ${temp_int}°C" > "$WEATHER_CACHE"
            else
                echo "${icon} ${temp_int}°F" > "$WEATHER_CACHE"
            fi
        fi
    fi

    if [ -f "$WEATHER_CACHE" ]; then
        echo "weather_str='$(cat "$WEATHER_CACHE" 2>/dev/null)'" > "$_parallel_tmp/weather.sh"
    else
        echo "weather_str='—'" > "$_parallel_tmp/weather.sh"
    fi
} &
fi

if [ "$MODE" = "normal" ]; then
{
    # 4. Usage data — prefer native rate_limits from statusline JSON input (v2.1.80+),
    #    fall back to OAuth API fetch. Native field eliminates 429 risk entirely.
    #    TTL: 900s (15 min). On failure, use cache if <30min old, else show "—".
    _usage_now=$NOW_EPOCH

    if [ "$has_native_rate_limits" = "true" ]; then
        # Native rate_limits available — use directly, skip OAuth API entirely
        cat > "$_parallel_tmp/usage.sh" << USAGEEOF
usage_5h=${native_usage_5h:-0}
usage_5h_reset=${native_usage_5h_reset:-''}
usage_7d=${native_usage_7d:-0}
usage_7d_reset=${native_usage_7d_reset:-''}
usage_opus=${native_usage_opus:-null}
usage_sonnet=${native_usage_sonnet:-null}
usage_extra_enabled=${native_usage_extra_enabled:-false}
usage_extra_limit=${native_usage_extra_limit:-0}
usage_extra_used=${native_usage_extra_used:-0}
usage_ws_cost_cents=0
USAGEEOF
    else
        # Fallback: fetch from OAuth API (pre-v2.1.80 or non-Claude.ai auth)
        cache_age=999999
        [ -f "$USAGE_CACHE" ] && cache_age=$((_usage_now - $(get_mtime "$USAGE_CACHE")))

        if [ "$cache_age" -gt "$USAGE_CACHE_TTL" ]; then
            # fall through to the fetch below
            :
        fi

        # Which account the cache on disk belongs to, probed once — the kind
        # decides both whether the cache is usable and which clock it runs on.
        _cache_kind=none
        if [ -f "$USAGE_CACHE" ]; then
            if   jq -e '.enterprise_credits' "$USAGE_CACHE" >/dev/null 2>&1; then _cache_kind=enterprise
            elif jq -e '.five_hour'          "$USAGE_CACHE" >/dev/null 2>&1; then _cache_kind=personal
            fi
        fi
        # Personal accounts report 5h/7d windows; enterprise seats report a single
        # org credit meter. The shapes are not interchangeable, so a cache left
        # over from the other account is refetched instead of rendered — showing
        # the wrong account's numbers is worse than showing none. An unknown kind
        # (account cache predates ACCOUNT_SUB, or no readable token) accepts
        # whatever shape is on disk, which is the permissive pre-existing path.
        if [ "$ACCOUNT_SUB" = "enterprise" ]; then _acct_kind=enterprise
        elif [ -n "$ACCOUNT_SUB" ];         then _acct_kind=personal
        else                                     _acct_kind=unknown; fi
        _cache_shape_ok=true
        if   [ "$_cache_kind" = "none" ]; then _cache_shape_ok=false
        elif [ "$_acct_kind" != "unknown" ] && [ "$_acct_kind" != "$_cache_kind" ]; then _cache_shape_ok=false
        fi

        # An enterprise probe is an ordinary billed completion, not a hit on the
        # rate-limited OAuth endpoint, so it runs on the short clock. When the
        # account kind is unknown, the shape on disk is the best evidence.
        _kind="$_acct_kind"
        [ "$_kind" = "unknown" ] && _kind="$_cache_kind"
        _usage_ttl=$USAGE_CACHE_TTL
        [ "$_kind" = "enterprise" ] && _usage_ttl=$ENTERPRISE_CACHE_TTL

        # The TTL governs attempts, not just successes. A probe that fails leaves
        # the cache stale, so on its own the condition below would fire again on
        # the very next 2s refresh — a billed request every 2 seconds, all day.
        _attempt_stamp="${USAGE_CACHE}.attempt"
        _since_attempt=999999
        [ -f "$_attempt_stamp" ] && _since_attempt=$((_usage_now - $(get_mtime "$_attempt_stamp")))

        if [ "$_since_attempt" -ge "$_usage_ttl" ] &&
           { [ "$cache_age" -gt "$_usage_ttl" ] || [ "$_cache_shape_ok" != "true" ]; }; then
            # Extract OAuth token — macOS Keychain or Linux credentials file
            if [ "$(uname -s)" = "Darwin" ]; then
                cred_json=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
            else
                cred_json=$(cat "${HOME}/.claude/.credentials.json" 2>/dev/null)
            fi
            token=$(echo "$cred_json" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
            _sub=$(echo "$cred_json" | jq -r '.claudeAiOauth.subscriptionType // empty' 2>/dev/null)

            if [ -n "$token" ] && [ "$_sub" = "enterprise" ]; then
                # Read the org credit meter off the unified rate-limit headers.
                _hdrs=$(curl -s -D - -o /dev/null --max-time 4 \
                    -X POST "https://api.anthropic.com/v1/messages" \
                    -H "Authorization: Bearer $token" \
                    -H "Content-Type: application/json" \
                    -H "anthropic-version: 2023-06-01" \
                    -H "anthropic-beta: oauth-2025-04-20" \
                    -H "x-app: cli" \
                    -A "claude-cli/${cc_version_json:-unknown} (external, cli)" \
                    -d "{\"model\":\"$ENTERPRISE_PROBE_MODEL\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
                    2>/dev/null | tr -d '\r')

                if [ -n "$_hdrs" ]; then
                    eval "$(printf '%s\n' "$_hdrs" | awk -F': ' '
                        tolower($1) == "anthropic-ratelimit-unified-overage-utilization" { printf "ent_pct=%s\n", $2 }
                        tolower($1) == "anthropic-ratelimit-unified-overage-reset"       { printf "ent_reset=%s\n", $2 }
                        tolower($1) == "anthropic-ratelimit-unified-overage-status"      { printf "ent_status=%s\n", $2 }
                    ')"
                    if [ -n "${ent_pct:-}" ]; then
                        jq -nc --argjson pct "$ent_pct" --argjson rst "${ent_reset:-0}" \
                            --arg st "${ent_status:-}" \
                            '{enterprise_credits:{utilization:$pct,resets_at:$rst,status:$st}}' \
                            > "$USAGE_CACHE" 2>/dev/null
                        _cache_shape_ok=true
                    fi
                fi
            elif [ -n "$token" ]; then
                usage_json=$(curl -s --max-time 3 \
                    -H "Authorization: Bearer $token" \
                    -H "Content-Type: application/json" \
                    -H "anthropic-beta: oauth-2025-04-20" \
                    "https://api.anthropic.com/api/oauth/usage" 2>/dev/null)

                if [ -n "$usage_json" ] && echo "$usage_json" | jq -e '.five_hour' >/dev/null 2>&1; then
                    echo "$usage_json" | jq '.' > "$USAGE_CACHE" 2>/dev/null
                    _cache_shape_ok=true
                fi
            fi
            # Stamped whatever the outcome: a success refreshes the cache mtime and
            # makes this moot, a failure needs it to hold the next attempt off.
            touch "$_attempt_stamp" 2>/dev/null
        fi

        # Read cache if it exists and is <30min old. Otherwise no data.
        _usage_age=999999
        [ -f "$USAGE_CACHE" ] && _usage_age=$((_usage_now - $(get_mtime "$USAGE_CACHE")))

        if [ -f "$USAGE_CACHE" ] && [ "$_usage_age" -lt 1800 ] && [ "$_cache_shape_ok" = "true" ]; then
            if jq -e '.enterprise_credits' "$USAGE_CACHE" >/dev/null 2>&1; then
                jq -r '
                    "usage_ent_pct=" + ((.enterprise_credits.utilization * 100) | round | tostring) + "\n" +
                    "usage_ent_reset=" + (.enterprise_credits.resets_at // 0 | tostring) + "\n" +
                    "usage_extra_enabled=false\nusage_ws_cost_cents=0"
                ' "$USAGE_CACHE" > "$_parallel_tmp/usage.sh" 2>/dev/null
            else
                jq -r '
                    "usage_5h=" + (.five_hour.utilization // 0 | tostring) + "\n" +
                    "usage_5h_reset=" + (.five_hour.resets_at // "" | @sh) + "\n" +
                    "usage_7d=" + (.seven_day.utilization // 0 | tostring) + "\n" +
                    "usage_7d_reset=" + (.seven_day.resets_at // "" | @sh) + "\n" +
                    "usage_opus=" + (if .seven_day_opus then (.seven_day_opus.utilization // 0 | tostring) else "null" end) + "\n" +
                    "usage_sonnet=" + (if .seven_day_sonnet then (.seven_day_sonnet.utilization // 0 | tostring) else "null" end) + "\n" +
                    "usage_extra_enabled=" + (.extra_usage.is_enabled // false | tostring) + "\n" +
                    "usage_extra_limit=" + (.extra_usage.monthly_limit // 0 | tostring) + "\n" +
                    "usage_extra_used=" + (.extra_usage.used_credits // 0 | tostring) + "\n" +
                    "usage_ws_cost_cents=0"
                ' "$USAGE_CACHE" > "$_parallel_tmp/usage.sh" 2>/dev/null
            fi
        else
            rm -f "$USAGE_CACHE" 2>/dev/null
            echo -e "usage_5h=0\nusage_7d=0\nusage_extra_enabled=false\nusage_ws_cost_cents=0\nusage_no_data=true" > "$_parallel_tmp/usage.sh"
        fi
    fi
} &
fi

if [ "$MODE" = "normal" ]; then
{
    # 5. Quote prefetch (was serial at the end — now parallel)
    # The keyless endpoint allows 5 req / 30s, so a 60s cadence across concurrent
    # panes 429s constantly. Refresh every 15 min unless a key is configured.
    # Rate-limit / system messages come back with a == "zenquotes.io" — filter those
    # so a transient 429 never clobbers a real cached quote.
    _quote_ttl=900
    [ -n "${ZENQUOTES_API_KEY:-}" ] && _quote_ttl=60
    quote_age=$((NOW_EPOCH - $(get_mtime "$QUOTE_CACHE")))
    if [ "$quote_age" -gt "$_quote_ttl" ] || [ ! -f "$QUOTE_CACHE" ]; then
        if [ -n "${ZENQUOTES_API_KEY:-}" ]; then
            _quote_url="https://zenquotes.io/api/random/${ZENQUOTES_API_KEY}"
        else
            _quote_url="https://zenquotes.io/api/random"
        fi
        new_quote=$(curl -s --max-time 2 "$_quote_url" 2>/dev/null | \
            jq -r '.[0] | select(.q | length < 80) | select(.a != "zenquotes.io") | .q + "|" + .a' 2>/dev/null)
        [ -n "$new_quote" ] && [ "$new_quote" != "null" ] && echo "$new_quote" > "$QUOTE_CACHE"
    fi
} &
fi

# --- PARALLEL BLOCK END - wait for all to complete ---
wait

# Source all parallel results
[ -f "$_parallel_tmp/git.sh" ] && source "$_parallel_tmp/git.sh"
[ -f "$_parallel_tmp/location.sh" ] && source "$_parallel_tmp/location.sh"
[ -f "$_parallel_tmp/weather.sh" ] && source "$_parallel_tmp/weather.sh"
[ -f "$_parallel_tmp/usage.sh" ] && source "$_parallel_tmp/usage.sh"
rm -rf "$_parallel_tmp" 2>/dev/null

# Supplement missing reset timestamps from OAuth cache when native rate_limits
# omits resets_at (happens in some Claude Code sessions)
if [ "$MODE" = "normal" ] && { [ -z "${usage_5h_reset:-}" ] || [ -z "${usage_7d_reset:-}" ]; } && [ -f "$USAGE_CACHE" ]; then
    eval "$(jq -r '
        "_cache_usage_5h_reset=" + (.five_hour.resets_at // "" | @sh) + "\n" +
        "_cache_usage_7d_reset=" + (.seven_day.resets_at // "" | @sh)
    ' "$USAGE_CACHE" 2>/dev/null)"
    [ -z "${usage_5h_reset:-}" ] && usage_5h_reset="${_cache_usage_5h_reset:-}"
    [ -z "${usage_7d_reset:-}" ] && usage_7d_reset="${_cache_usage_7d_reset:-}"
fi

# NOTE: input JSON, cc_version, and model_name
# are all already parsed above (lines 59-113). No duplicate parsing needed.

# ─────────────────────────────────────────────────────────────────────────────
# COLOR PALETTE
# ─────────────────────────────────────────────────────────────────────────────
# Tailwind-inspired colors organized by usage

RESET='\033[0m'

# Structural (chrome, labels, separators)
SLATE_300='\033[38;2;203;213;225m'     # Light text/values
SLATE_400='\033[38;2;148;163;184m'     # Labels
SLATE_600='\033[38;2;71;85;105m'       # Separators

# Semantic colors
EMERALD='\033[38;2;74;222;128m'        # Positive/success
ROSE='\033[38;2;251;113;133m'          # Error/negative

# Git (sky/blue)
GIT_PRIMARY='\033[38;2;56;189;248m'
GIT_VALUE='\033[38;2;186;230;253m'
GIT_DIR='\033[38;2;147;197;253m'
GIT_STASH='\033[38;2;165;180;252m'
GIT_AGE_RECENT='\033[38;2;96;165;250m'

# Context (indigo)
CTX_PRIMARY='\033[38;2;129;140;248m'
CTX_SECONDARY='\033[38;2;165;180;252m'
CTX_BUCKET_EMPTY='\033[38;2;75;82;95m'

# Usage (subtle brown/orange)
USAGE_PRIMARY='\033[38;2;194;139;62m'
USAGE_LABEL='\033[38;2;168;113;50m'
USAGE_RESET='\033[38;2;148;163;184m'
USAGE_EXTRA='\033[38;2;140;90;60m'
USAGE_STALE='\033[38;2;120;113;108m'   # Warm gray for stale labels (not values)

# Quote (gold)
QUOTE_PRIMARY='\033[38;2;252;211;77m'
QUOTE_AUTHOR='\033[38;2;180;140;60m'

# Header line (brand glyph, location, time, weather, session label)
BRAND='\033[38;2;59;130;246m'         # Medium blue
HDR_CITY='\033[38;2;37;99;235m'       # Blue-600 — darker, saturated city blue
HDR_STATE='\033[38;2;125;211;252m'    # Sky-300 — lighter blue, paired with city
HDR_TIME='\033[38;2;96;165;250m'      # Medium-light blue for time
HDR_WEATHER='\033[38;2;135;206;235m'  # Sky blue for weather
HDR_SESSION='\033[38;2;120;135;160m'  # Muted blue-gray for session label

# Color for the account label leading the header line.


# ─────────────────────────────────────────────────────────────────────────────
# HELPER FUNCTIONS
# ─────────────────────────────────────────────────────────────────────────────

# Get gradient color for context bar bucket
# Green(74,222,128) → Yellow(250,204,21) → Orange(251,146,60) → Red(239,68,68)
get_bucket_color() {
    local pos=$1 max=$2
    local pct=$((pos * 100 / max))
    local r g b

    if [ "$pct" -le 33 ]; then
        r=$((74 + (250 - 74) * pct / 33))
        g=$((222 + (204 - 222) * pct / 33))
        b=$((128 + (21 - 128) * pct / 33))
    elif [ "$pct" -le 66 ]; then
        local t=$((pct - 33))
        r=$((250 + (251 - 250) * t / 33))
        g=$((204 + (146 - 204) * t / 33))
        b=$((21 + (60 - 21) * t / 33))
    else
        local t=$((pct - 66))
        r=$((251 + (239 - 251) * t / 34))
        g=$((146 + (68 - 146) * t / 34))
        b=$((60 + (68 - 60) * t / 34))
    fi
    printf '\033[38;2;%d;%d;%dm' "$r" "$g" "$b"
}

# Get color for usage percentage (green→yellow→orange→red)
get_usage_color() {
    local pct="$1"
    local pct_int=${pct%%.*}
    [ -z "$pct_int" ] && pct_int=0
    if   [ "$pct_int" -ge 80 ]; then echo "$ROSE"
    elif [ "$pct_int" -ge 60 ]; then echo '\033[38;2;251;146;60m'    # Orange
    elif [ "$pct_int" -ge 40 ]; then echo '\033[38;2;251;191;36m'    # Amber
    else echo "$EMERALD"
    fi
}

# Render context bar - gradient progress bar using (potentially scaled) percentage
render_context_bar() {
    local width=$1 pct=$2
    local output="" color=""

    # Use percentage (may be scaled to compaction threshold)
    local filled=$((pct * width / 100))
    [ "$filled" -lt 0 ] && filled=0

    # Use spaced buckets only for small widths to improve readability
    local use_spacing=false
    [ "$width" -le 20 ] && use_spacing=true

    # Two threshold markers split the bar into three equal thirds.
    # Variable names kept for diff readability.
    local pos_20=$((width / 3))          # first warning  — orange marker at 1/3
    local pos_60=$((2 * width / 3))      # final warning  — dark-red marker at 2/3

    # Three discrete bands keyed to the two markers — no gradient.
    # Filled buckets read off the color of the next marker the user is heading toward:
    #   green   before pos_20  (orange marker)   — safe, no action needed
    #   orange  pos_20..pos_60 (dark-red marker) — compact now
    #   d.red   after pos_60                     — context degraded, compact immediately
    for ((i=1; i<=width; i++)); do
        # Marker positions render their threshold glyph regardless of fill.
        if [ "$i" -eq "$pos_20" ]; then
            output="${output}\033[38;2;251;146;60m⛁${RESET}"    # orange marker
        elif [ "$i" -eq "$pos_60" ]; then
            output="${output}\033[38;2;180;40;40m⛁${RESET}"     # dark-red marker
        elif [ "$i" -le "$filled" ]; then
            if [ "$i" -lt "$pos_20" ]; then
                color='\033[38;2;74;222;128m'    # green band
            elif [ "$i" -lt "$pos_60" ]; then
                color='\033[38;2;251;146;60m'    # orange band
            else
                color='\033[38;2;180;40;40m'     # dark-red band
            fi
            output="${output}${color}⛁${RESET}"
        else
            output="${output}${CTX_BUCKET_EMPTY}⛁${RESET}"
        fi
        [ "$use_spacing" = true ] && output="${output} "
    done

    output="${output% }"
    printf '%s\n' "$output"
}

# Calculate optimal bar width to match statusline content width
# Returns buckets that fill the same visual width as separator lines
calc_bar_width() {
    local mode=$1
    local prefix_len suffix_len bucket_size available

    case "$mode" in
        nano)
            prefix_len=2    # "◉ "
            suffix_len=5    # " XX%"
            bucket_size=2   # char + space
            ;;
        micro)
            prefix_len=2    # "◉ "
            suffix_len=5    # " XX%"
            bucket_size=2
            ;;
        mini)
            prefix_len=12   # "◉ CONTEXT: "
            suffix_len=5    # " XXX%"
            bucket_size=2
            ;;
        normal)
            prefix_len=11   # "◉ CONTEXT: " (◉=1 + space + CONTEXT: + space)
            suffix_len=5    # " XXX%" (space + up to 3 digits + %)
            bucket_size=1   # no spacing for dense display
            ;;
    esac

    available=$((content_width - prefix_len - suffix_len))
    local buckets=$((available / bucket_size))

    # Minimum floor per mode
    [ "$mode" = "nano" ] && [ "$buckets" -lt 5 ] && buckets=5
    [ "$mode" = "micro" ] && [ "$buckets" -lt 6 ] && buckets=6
    [ "$mode" = "mini" ] && [ "$buckets" -lt 8 ] && buckets=8
    [ "$mode" = "normal" ] && [ "$buckets" -lt 16 ] && buckets=16

    echo "$buckets"
}

# ═══════════════════════════════════════════════════════════════════════════════
# LINE 0: HEADER (location, time, weather)
# ═══════════════════════════════════════════════════════════════════════════════
# NOTE: location_city, location_state, weather_str are populated by PARALLEL PREFETCH

current_time=$(date +"%H:%M")

# Session label: uppercased, and capped so a long auto-generated title cannot
# push the CWD and branch off the top row (ai-title runs to whole sentences,
# e.g. "Set up mcp_excalidraw server for live diagram editing").
SESSION_MAX_LEN="${STATUSLINE_SESSION_MAX_LEN:-32}"
session_display=""
if [ -n "$SESSION_LABEL" ]; then
    session_display="${SESSION_LABEL^^}"
    if [ "${#session_display}" -gt "$SESSION_MAX_LEN" ]; then
        session_display="${session_display:0:$((SESSION_MAX_LEN - 1))}…"
    fi
fi

# This is expanded inside a printf FORMAT string downstream — double every % so
# it prints literally rather than being read as a conversion spec.
session_display_fmt="${session_display//\%/%%}"

# Line H: hibernation banner. Rendered above everything, in every width mode,
# because the thing it explains is a session that has stopped responding — the one
# state where a user reaches for ctrl-c and throws away the wait. Every field is
# re-derived here rather than trusted: a live pid and an unexpired wake stamp are
# both required, so no way of killing the hook leaves a banner on screen after it.
if [ -f "$HIBERNATE_STATE" ]; then
    read -r _hib_until _hib_pct _hib_pid < "$HIBERNATE_STATE" 2>/dev/null
    # /tmp is world-writable, so treat every field as untrusted: the epoch and pid
    # reach $(( )) and kill, and $(( )) evaluates array subscripts — a command
    # substitution planted in one would run. The percentage reaches a printf format.
    [[ "$_hib_until" =~ ^[0-9]+$ ]] || _hib_until=0
    [[ "$_hib_pct"   =~ ^[0-9]+$ ]] || _hib_pct="?"
    [[ "$_hib_pid"   =~ ^[0-9]+$ ]] || _hib_pid=0
    # A hook killed with SIGKILL never runs its cleanup, and a banner that outlives
    # the sleep is worse than none — it would claim the session is paused while it
    # is visibly working. Only the sleeping process itself can vouch for the banner.
    # Zero is excluded by hand: `kill -0 0` signals our own process group and would
    # report every malformed file as a live hook.
    if [ "$_hib_pid" -le 0 ] || ! kill -0 "$_hib_pid" 2>/dev/null; then _hib_until=0; fi
    _hib_left=$(( _hib_until - NOW_EPOCH ))
    # The hook can never sleep past one 5h window, so a longer remainder means a
    # corrupt or planted file (a millisecond epoch reads as ~500,000 hours). Render
    # nothing rather than a countdown that is wrong and would never expire.
    [ "$_hib_left" -gt 18000 ] && _hib_left=0
    if [ "$_hib_left" -gt 0 ] 2>/dev/null; then
        _hib_h=$(( _hib_left / 3600 )); _hib_m=$(( (_hib_left % 3600) / 60 ))
        # Under a minute floors to "0m", which reads like a stalled countdown at the
        # exact moment the user is watching hardest. Say "<1m" instead.
        if   [ "$_hib_h" -gt 0 ];    then _hib_eta="${_hib_h}h${_hib_m}m"
        elif [ "$_hib_left" -lt 60 ]; then _hib_eta="<1m"
        else _hib_eta="${_hib_m}m"
        fi
        # The full form measures 71 columns. content_width is capped at 72, so this
        # is "the whole line fits"; anything narrower degrades to the short form
        # rather than wrapping, the way the compact card modes already do.
        if [ "$content_width" -ge 72 ]; then
            # Only the wide form shows a clock time, so only it pays for the fork.
            _hib_at=$(reset_time_str "$_hib_until")
            printf "${QUOTE_PRIMARY}HIBERNATING${RESET} ${SLATE_600}│${RESET} ${USAGE_PRIMARY}5h ${_hib_pct}%%${RESET} ${SLATE_600}·${RESET} ${QUOTE_PRIMARY}resumes in ${_hib_eta}${RESET} ${SLATE_600}(${_hib_at})${RESET} ${SLATE_600}· no action needed${RESET}\n"
        else
            printf "${QUOTE_PRIMARY}HIBERNATING${RESET} ${SLATE_600}·${RESET} ${QUOTE_PRIMARY}${_hib_eta}${RESET}\n"
        fi
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# COMPACT CARD OUTPUT (nano/micro/mini modes)
# ═══════════════════════════════════════════════════════════════════════════════
# For narrow panes: all essential metrics in a dense, bordered card.
# No click-to-expand — everything visible in default view.

if [ "$MODE" != "normal" ]; then
    # ── Compute values needed for card ──

    # Context percentage — raw, matches /context command
    _raw_pct="${context_pct%%.*}"
    [ -z "$_raw_pct" ] && _raw_pct=0
    _pct_color=$(get_usage_color "$_raw_pct")

    # Git age
    _age=""
    if [ "$is_git_repo" = "true" ] && [ -n "$last_commit_epoch" ]; then
        _now=$NOW_EPOCH
        _age_s=$((_now - last_commit_epoch))
        _age_m=$((_age_s / 60)); _age_h=$((_age_s / 3600)); _age_d=$((_age_s / 86400))
        if   [ "$_age_m" -lt 1 ];  then _age="now"
        elif [ "$_age_h" -lt 1 ];  then _age="${_age_m}m"
        elif [ "$_age_h" -lt 24 ]; then _age="${_age_h}h"
        else _age="${_age_d}d"
        fi
    fi

    # ── Compact modes: same sections as normal, horizontally compressed ──
    case "$MODE" in
        nano)
            # Line 1: brand + context
            printf "${BRAND}${ACCOUNT_LABEL}${RESET} ${CTX_PRIMARY}◉${RESET}${_pct_color}${_raw_pct}%%${RESET}
"
            # Line 2: git
            [ "$is_git_repo" = "true" ] && printf "${GIT_PRIMARY}◈${RESET}${GIT_VALUE}${branch}${RESET}
"
            ;;
        micro)
            # Line 1: brand + context
            printf "${BRAND}${ACCOUNT_LABEL}${RESET} ${CTX_PRIMARY}◉${RESET}${_pct_color}${_raw_pct}%%${RESET}
"
            # Line 2: git
            printf "${GIT_PRIMARY}◈${RESET}${GIT_VALUE}${branch:-—}${RESET}"
            [ -n "$_age" ] && printf " ${GIT_AGE_RECENT}${_age}${RESET}"
            printf "
"
            ;;
        mini)
            # Line 1: model + CWD
            printf "${SLATE_300}${_model_disp}${RESET} ${SLATE_600}│${RESET} ${GIT_DIR}${_cwd}${RESET}
"
            # Line 2: brand + location/time
            printf "${BRAND}${ACCOUNT_LABEL}${RESET} ${SLATE_600}│${RESET} ${HDR_CITY}${location_city}${RESET} ${SLATE_600}│${RESET} ${HDR_TIME}${current_time}${RESET} ${SLATE_600}│${RESET} ${HDR_WEATHER}${weather_str}${RESET}
"
            # Line 3: context bar (compact)
            _bar_w=20
            _bar=$(render_context_bar $_bar_w $_raw_pct)
            printf "${CTX_PRIMARY}◉${RESET} ${_bar} ${_pct_color}${_raw_pct}%%${RESET}
"
            # Line 4: git
            printf "${GIT_PRIMARY}◈${RESET} ${GIT_VALUE}${branch:-—}${RESET}"
            [ -n "$_age" ] && printf " ${age_color:-$GIT_AGE_RECENT}${_age}${RESET}"
            [ "${stash_count:-0}" -gt 0 ] && printf " ${GIT_STASH}⊡${stash_count}${RESET}"
            printf "
"
            ;;
    esac
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════════
# NORMAL MODE: Full multi-line output (80+ columns)
# ═══════════════════════════════════════════════════════════════════════════════

# Output header line: ▲ │ 🇺🇸 CITY, STATE  HH:MM  ☁️ temp [│ session]
# City + state arrive uppercased from the location prefetch; flag is rendered there too.
_hdr_loc=""
if [ -n "$location_city" ]; then
    [ -n "$location_flag" ] && _hdr_loc="${location_flag} "
    _hdr_loc="${_hdr_loc}${HDR_CITY}${location_city}${RESET}"
    [ -n "$location_state" ] && _hdr_loc="${_hdr_loc}${SLATE_600}, ${RESET}${HDR_STATE}${location_state}${RESET}"
fi
# Plain-text twin for width math.
_hdr_loc_plain=""
[ -n "$location_flag" ] && _hdr_loc_plain="${location_flag} "
_hdr_loc_plain="${_hdr_loc_plain}${location_city}"
[ -n "$location_state" ] && _hdr_loc_plain="${_hdr_loc_plain}, ${location_state}"
[ -z "$_hdr_loc_plain" ] && _hdr_loc_plain="—"
# Line 0: model + session name + CWD + branch (own row — avoids overflow when
# the path is long). Session name only appears once /rename has set one.
printf "${SLATE_300}${_model_disp}${RESET}"
[ -n "$session_display" ] && printf " ${SLATE_600}│${RESET} ${HDR_SESSION}${session_display_fmt}${RESET}"
printf " ${SLATE_600}│${RESET} ${GIT_DIR}${_cwd}${RESET}"
[ "$is_git_repo" = "true" ] && printf " ${SLATE_600}│${RESET} ${GIT_PRIMARY}◈${RESET}${GIT_VALUE}${branch:-—}${RESET}"
printf "\n"
# Line 1: header
printf "${BRAND}${ACCOUNT_LABEL}${RESET} ${SLATE_600}│${RESET} ${_hdr_loc}  ${HDR_TIME}${current_time}${RESET}  ${HDR_WEATHER}${weather_str}${RESET}\n"
printf "${SLATE_600}%s${RESET}\n" "$SEP_DASHED"

# ═══════════════════════════════════════════════════════════════════════════════
# LINE 1: CONTEXT
# ═══════════════════════════════════════════════════════════════════════════════

# Context display — show percentage and bar (no token counts)
context_max="${context_max:-200000}"

# Use raw percentage directly — matches /context command output
raw_pct="${context_pct%%.*}"  # Remove decimals
[ -z "$raw_pct" ] && raw_pct=0
display_pct="$raw_pct"

# Color based on percentage (reuse get_usage_color for consistent thresholds)
pct_color=$(get_usage_color "$display_pct")

# Calculate bar width dynamically from actual prefix/suffix lengths
# Prefix: "◉ CONTEXT: " = 11 visible chars
# Suffix: " " + display_pct + "%" = 1 + len(display_pct) + 1
_ctx_suffix_len=$(( 1 + ${#display_pct} + 1 ))
bar_width=$(( content_width - 11 - _ctx_suffix_len ))
[ "$bar_width" -lt 16 ] && bar_width=16

bar=$(render_context_bar $bar_width $display_pct)
printf "${CTX_SECONDARY}CONTEXT:${RESET} ${bar} ${pct_color}${display_pct}%%${RESET}\n"
sep

# ═══════════════════════════════════════════════════════════════════════════════
# SESSION WORK (rendered on the usage row)
# ═══════════════════════════════════════════════════════════════════════════════
# How much the session has done across compactions and resumes: days with a
# prompt, human prompts (typed, or queued mid-turn as an attachment),
# compactions, and tool calls including every subagent's. A long session's
# transcripts run to hundreds of MB, about 2s to scan cold, so each refresh
# reads only the bytes appended since the last one and folds what it finds
# into a sorted set of keys. Keys make a re-read harmless: overlapping
# refreshes, or a fork's transcript repeating its parent's tool calls,
# collapse to one entry.
work_display=""
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ] && [ -n "$session_id" ]; then
    _work_dir="$CACHE_DIR/work/$session_id"
    mkdir -p "$_work_dir"
    shopt -s nullglob
    _work_files=("$transcript_path" "${transcript_path%.jsonl}"/subagents/*.jsonl)
    shopt -u nullglob
    if [ "$STAT_FLAVOR" = "bsd" ]; then
        _work_sizes=$(stat -f '%z %N' "${_work_files[@]}" 2>/dev/null)
    else
        _work_sizes=$(stat -c '%s %n' "${_work_files[@]}" 2>/dev/null)
    fi
    if [ ! -f "$_work_dir/offsets" ] || [ "$_work_sizes" != "$(<"$_work_dir/offsets")" ]; then
        declare -A _work_off=()
        [ -f "$_work_dir/offsets" ] && while read -r _sz _p; do _work_off[$_p]=$_sz; done < "$_work_dir/offsets"
        _tool_pat='"type":"tool_use","id":"toolu_'
        # ponytail: a line caught mid-write is skipped by fromjson? and not re-read; costs at most one entry
        { while read -r _sz _p; do
            _old=${_work_off[$_p]:-0}
            [ "$_sz" -eq "$_old" ] && continue
            [ "$_sz" -lt "$_old" ] && _old=0
            if [ "$_p" = "$transcript_path" ]; then
                _pats=(-e "$_tool_pat" -e '"origin":{"kind":"human"}' -e '"subtype":"compact_boundary"')
            else
                _pats=(-e "$_tool_pat")
            fi
            # Bytes appended past the stat are read too; they come back as keys
            # already in the set. Whole files skip tail, which is ~3x slower
            # than grep at reading from the start on BSD.
            if [ "$_old" -eq 0 ]; then
                grep -F "${_pats[@]}" "$_p"
            else
                tail -c +$((_old + 1)) "$_p" | grep -F "${_pats[@]}"
            fi
          done <<< "$_work_sizes" | TZ="$USER_TZ" jq -Rr '
            fromjson? // empty
            | if .type == "assistant" then .message.content[]? | select(.type == "tool_use") | "t \(.id)"
              elif .subtype == "compact_boundary" then "c \(.uuid)"
              elif (.origin.kind // .attachment.origin.kind) == "human" then
                "p \(.timestamp[0:19] + "Z" | fromdateiso8601 | strflocaltime("%F")) \(.uuid)"
              else empty end' 2>/dev/null
          cat "$_work_dir/keys" 2>/dev/null
        } | sort -u > "$_work_dir/keys.$$"
        mv "$_work_dir/keys.$$" "$_work_dir/keys"
        printf '%s\n' "$_work_sizes" > "$_work_dir/offsets"
    fi
    read -r _w_days _w_prompts _w_compacts _w_tools < <(awk '
        $1 == "t" { t++ } $1 == "c" { c++ } $1 == "p" { p++; if (!seen[$2]++) d++ }
        END { print d + 0, p + 0, c + 0, t + 0 }' "$_work_dir/keys" 2>/dev/null)
    if [ -n "${_w_tools:-}" ]; then
        # Same scheme as the CREDITS segment: value in amber, words in slate.
        _count_noun() { # <n> <noun> — plural unless n is exactly 1
            local s=s; [ "$1" = 1 ] && s=
            printf "${USAGE_PRIMARY}%s${RESET} ${USAGE_RESET}%s%s${RESET}" "$1" "$2" "$s"
        }
        _w_tools_num=$_w_tools
        if [ "$_w_tools" -ge 1000 ]; then
            _r=$(( (_w_tools + 50) / 100 ))
            _w_tools_num="$((_r / 10)).$((_r % 10))k"
        fi
        _dot=" ${SLATE_600}•${RESET} "
        work_display="$(_count_noun "$_w_days" day)${_dot}$(_count_noun "$_w_prompts" prompt)${_dot}$(_count_noun "$_w_compacts" compaction)${_dot}$(_count_noun "$_w_tools_num" "tool call")"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# LINE: ACCOUNT USAGE (Claude API rate limits — 5H and 7D windows)
# ═══════════════════════════════════════════════════════════════════════════════
# NOTE: usage_5h, usage_7d, usage_5h_reset, usage_7d_reset populated by PARALLEL PREFETCH

usage_5h_int=${usage_5h%%.*}
usage_7d_int=${usage_7d%%.*}
[ -z "$usage_5h_int" ] && usage_5h_int=0
[ -z "$usage_7d_int" ] && usage_7d_int=0

# Only show usage line if we have data (token was valid, cache fresh)
if [ "${usage_no_data:-false}" != "true" ] && { [ -n "${usage_ent_pct:-}" ] || [ "$usage_5h_int" -gt 0 ] || [ "$usage_7d_int" -gt 0 ] || [ -f "$USAGE_CACHE" ]; }; then
    usage_5h_color=$(get_usage_color "$usage_5h_int")
    usage_7d_color=$(get_usage_color "$usage_7d_int")

    # Parse reset timestamps and show absolute reset times (e.g., "TODAY@1500", "THU@0900")
    # Split into day/time parts for two-tone amber coloring
    reset_5h_day="—"; reset_5h_time=""; reset_7d_day="—"; reset_7d_time=""
    reset_ent_day="—"; reset_ent_time=""
    if [ -n "${usage_5h_reset:-}" ]; then
        _r5h_epoch=$(parse_iso_epoch "$usage_5h_reset")
        if [ "$_r5h_epoch" -gt 0 ] 2>/dev/null; then
            _r5h_str=$(reset_time_str "$_r5h_epoch")
            reset_5h_day="${_r5h_str%%@*}"
            reset_5h_time="${_r5h_str#*@}"
        fi
    fi
    if [ -n "${usage_7d_reset:-}" ]; then
        _r7d_epoch=$(parse_iso_epoch "$usage_7d_reset")
        if [ "$_r7d_epoch" -gt 0 ] 2>/dev/null; then
            _r7d_str=$(reset_time_str "$_r7d_epoch")
            reset_7d_day="${_r7d_str%%@*}"
            reset_7d_time="${_r7d_str#*@}"
        fi
    fi

    # Extra usage display (Max plan overage credits — values in cents)
    extra_display=""
    if [ "${usage_extra_enabled:-false}" = "true" ]; then
        extra_limit_dollars=$((${usage_extra_limit:-0} / 100))
        extra_used_dollars=$((${usage_extra_used%%.*} / 100))
        if [ "$extra_limit_dollars" -ge 1000 ]; then
            extra_limit_fmt="\$$(( extra_limit_dollars / 1000 ))K"
        else
            extra_limit_fmt="\$${extra_limit_dollars}"
        fi
        extra_display="E:\$${extra_used_dollars:-0}/${extra_limit_fmt}"
    fi

    # Staleness indicator: dim labels/timestamps only, NEVER dim data values
    _usage_cache_age=0
    [ -f "$USAGE_CACHE" ] && _usage_cache_age=$(( NOW_EPOCH - $(get_mtime "$USAGE_CACHE") ))
    _usage_is_stale=false
    stale_suffix=""
    if [ "$_usage_cache_age" -gt 600 ]; then
        _usage_is_stale=true
        stale_min=$((_usage_cache_age / 60))
        if [ "$stale_min" -ge 60 ]; then
            stale_suffix=" ${USAGE_STALE}($((stale_min / 60))h)${RESET}"
        else
            stale_suffix=" ${USAGE_STALE}(${stale_min}m)${RESET}"
        fi
    fi

    # Format colored reset display: day in USAGE_LABEL amber, time in USAGE_PRIMARY bright amber
    # When stale, labels/timestamps shift to warm gray; data values are NEVER affected
    if [ "$_usage_is_stale" = true ]; then
        _label_color="$USAGE_STALE"
        _reset_color="$USAGE_STALE"
    else
        _label_color="$USAGE_LABEL"
        _reset_color="$USAGE_RESET"
    fi
    _fmt_reset() {
        local day="$1" time="$2"
        if [ -n "$time" ]; then
            printf "${_label_color}${day}${RESET}${SLATE_600}@${RESET}${_label_color}${time}${RESET}"
        else
            printf "${_label_color}${day}${RESET}"
        fi
    }
    # Enterprise credit meter resets at period end, same epoch-integer form as the
    # native rate_limits windows, so it rides the same parser.
    if [ -n "${usage_ent_reset:-}" ]; then
        _rent_epoch=$(parse_iso_epoch "$usage_ent_reset")
        if [ "$_rent_epoch" -gt 0 ] 2>/dev/null; then
            _rent_str=$(reset_time_str "$_rent_epoch")
            reset_ent_day="${_rent_str%%@*}"
            reset_ent_time="${_rent_str#*@}"
        fi
    fi
    _reset_5h_fmt=$(_fmt_reset "$reset_5h_day" "$reset_5h_time")
    _reset_7d_fmt=$(_fmt_reset "$reset_7d_day" "$reset_7d_time")
    _reset_ent_fmt=$(_fmt_reset "$reset_ent_day" "$reset_ent_time")
    # Billing mode indicator — colored = active, slate-dim = inactive.
    # This block only renders when subscription OAuth usage data is present,
    # so SUB is always active here. API colored only if no usage data (pure API mode).
    if [ "${usage_no_data:-false}" = "true" ]; then
        _sub_color="$SLATE_600"; _api_color="$USAGE_PRIMARY"
    else
        _sub_color="$USAGE_PRIMARY"; _api_color="$SLATE_600"
    fi
    # Enterprise has one meter, not two windows: an org-wide credit pool that
    # resets at period end. Labelling it 5HR/WEEK would be a lie, so it gets its
    # own row.
    if [ -n "${usage_ent_pct:-}" ]; then
        _ent_color=$(get_usage_color "$usage_ent_pct")
        printf "${_reset_color}USE: CREDITS:${RESET} ${_ent_color}${usage_ent_pct}%%${RESET} ${_reset_color}↻${RESET}${_reset_ent_fmt} ${SLATE_600}(${RESET}${_sub_color}SUB${RESET}${SLATE_600})${RESET}"
    else
    printf "${_reset_color}USE: 5HR:${RESET} ${usage_5h_color}${usage_5h_int}%%${RESET} ${_reset_color}↻${RESET}${_reset_5h_fmt} ${SLATE_600}│${RESET} ${_reset_color}WEEK:${RESET} ${usage_7d_color}${usage_7d_int}%%${RESET} ${_reset_color}↻${RESET}${_reset_7d_fmt} ${SLATE_600}(${RESET}${_sub_color}SUB${RESET}${SLATE_600}/${RESET}${_api_color}API${RESET}${SLATE_600})${RESET}"
    fi
    [ -n "$work_display" ] && printf " ${SLATE_600}│${RESET} ${USAGE_RESET}WORK:${RESET} ${work_display}"
    [ -n "$extra_display" ] && printf " ${SLATE_600}│${RESET} ${USAGE_EXTRA}${extra_display}${RESET}"
    [ -n "$stale_suffix" ] && printf "${stale_suffix}"
    printf "\n"
    sep
fi

# ═══════════════════════════════════════════════════════════════════════════════
# LINE: QUOTE (normal mode only)
# ═══════════════════════════════════════════════════════════════════════════════

if [ "$MODE" = "normal" ]; then
    # Quote was prefetched in parallel block — just read the cache
    if [ -f "$QUOTE_CACHE" ]; then
        IFS='|' read -r quote_text quote_author < "$QUOTE_CACHE"
        full_len=$((${#quote_text} + ${#quote_author} + 6))
        _quote_width=$term_width
        [ "$_quote_width" -gt 120 ] && _quote_width=120

        if [ "$full_len" -le "$_quote_width" ]; then
            printf "${SLATE_400}\"${quote_text}\"${RESET} ${QUOTE_AUTHOR}—${quote_author}${RESET}\n"
        else
            wrap_at=$(( _quote_width - 8 ))
            [ "$wrap_at" -lt 40 ] && wrap_at=40
            [ "$wrap_at" -gt "${#quote_text}" ] && wrap_at=${#quote_text}
            while [ "$wrap_at" -gt 10 ] && [ "${quote_text:$wrap_at:1}" != " " ]; do wrap_at=$((wrap_at - 1)); done
            printf "${SLATE_400}\"${quote_text:0:$wrap_at}${RESET}\n"
            printf "  ${SLATE_400}${quote_text:$((wrap_at + 1))}\"${RESET} ${QUOTE_AUTHOR}—${quote_author}${RESET}\n"
        fi
    fi
fi
