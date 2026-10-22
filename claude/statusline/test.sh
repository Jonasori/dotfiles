#!/bin/bash
# Smoke test for statusline.sh. Runs the script against synthetic Claude Code
# input across all four width modes plus the degraded paths, and asserts the
# lines that matter actually render. No framework, no fixtures — just run it:
#   ./test.sh
#
# Uses a throwaway cache dir so it never touches the real one. Network calls
# (location/weather/quote) may fail offline; those are optional lines and the
# test does not assert on them.

set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/statusline.sh"
CACHE="$(mktemp -d)"
trap 'rm -rf "$CACHE" /tmp/claude-statusline-startup-sltest*.sh' EXIT

# Network stub. The usage fallback reads the real keychain token and, on an
# enterprise account, would buy a billed completion on every test run. Silence
# curl so the degraded paths are exercised as they behave offline — which is also
# the only way to make them deterministic.
STUB="$CACHE/stub"; mkdir -p "$STUB"
printf '#!/bin/sh\necho "$*" >> "%s/calls"\nexit 0\n' "$STUB" > "$STUB/curl"; chmod +x "$STUB/curl"

pass=0 fail=0

# Strip ANSI so assertions match on plain text.
# Invoke the script directly rather than via `bash "$SCRIPT"` so the shebang
# decides the interpreter — that is what Claude Code does, and on macOS the two
# differ (`bash` is homebrew 5.x, `/bin/bash` is 3.2).
run() {
    local cols="$1" json="$2"
    printf '%s' "$json" | STATUSLINE_CACHE_DIR="$CACHE" COLUMNS="$cols" PATH="$STUB:$PATH" \
        "$SCRIPT" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'
}

# Same, but pins the account kind. STATUSLINE_ACCOUNT short-circuits the account
# block, so the value survives instead of being overwritten by the on-disk
# account cache (which lives in /tmp and is shared with the real shells).
run_as() { # <subscriptionType> <cols> <json>
    local sub="$1" cols="$2" json="$3"
    printf '%s' "$json" | STATUSLINE_ACCOUNT=Test ACCOUNT_SUB="$sub" \
        STATUSLINE_CACHE_DIR="$CACHE" COLUMNS="$cols" PATH="$STUB:$PATH" \
        "$SCRIPT" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'
}

check() {
    local label="$1" haystack="$2" needle="$3"
    if [[ "$haystack" == *"$needle"* ]]; then
        pass=$((pass + 1)); printf '  ok   %s\n' "$label"
    else
        fail=$((fail + 1)); printf '  FAIL %s — expected to find %q in:\n%s\n' "$label" "$needle" "$haystack"
    fi
}

check_not() {
    local label="$1" haystack="$2" needle="$3"
    if [[ "$haystack" != *"$needle"* ]]; then
        pass=$((pass + 1)); printf '  ok   %s\n' "$label"
    else
        fail=$((fail + 1)); printf '  FAIL %s — did not expect %q in:\n%s\n' "$label" "$needle" "$haystack"
    fi
}

check_eq() {
    local label="$1" actual="$2" want="$3"
    if [ "$actual" = "$want" ]; then
        pass=$((pass + 1)); printf '  ok   %s\n' "$label"
    else
        fail=$((fail + 1)); printf '  FAIL %s — got %q, want %q\n' "$label" "$actual" "$want"
    fi
}

# mtime N minutes in the past, BSD or GNU date.
backdate() { # <file> <minutes>
    touch -t "$(date -v-"$2"M '+%Y%m%d%H%M' 2>/dev/null || date -d "$2 minutes ago" '+%Y%m%d%H%M')" "$1"
}

FULL='{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"'"$PWD"'"},
"session_id":"sltest","version":"2.1.80",
"context_window":{"context_window_size":200000,"used_percentage":42,"total_input_tokens":84000},
"rate_limits":{"five_hour":{"used_percentage":42,"resets_at":"2099-01-01T00:00:00Z"},
"seven_day":{"used_percentage":18,"resets_at":"2099-01-02T00:00:00Z"}}}'

echo "syntax + interpreter"
if bash -n "$SCRIPT"; then pass=$((pass+1)); echo "  ok   parses"; else fail=$((fail+1)); echo "  FAIL syntax error"; fi
# The script requires bash 4+ (\U escapes, ${var^^}) and selects it via
# `env bash`. Confirm the shebang actually resolves to one, since macOS keeps
# /bin/bash pinned at 3.2 and an absolute-path shebang would silently pick it.
shebang_ver=$(printf '%s' '{"model":{"display_name":"x"},"workspace":{"current_dir":"'"$PWD"'"},"session_id":"v"}' \
    | STATUSLINE_CACHE_DIR="$CACHE" COLUMNS=140 "$SCRIPT" >/dev/null 2>&1; echo $?)
resolved=$( (command -v bash >/dev/null && bash -c 'echo ${BASH_VERSINFO[0]}') 2>/dev/null )
if [ "${resolved:-0}" -ge 4 ] && [ "$shebang_ver" -eq 0 ]; then
    pass=$((pass+1)); echo "  ok   shebang resolves to bash $resolved"
else
    fail=$((fail+1)); echo "  FAIL shebang resolved to bash ${resolved:-?} (need 4+), exit $shebang_ver"
fi
# Started by an ancient bash, the script must re-exec itself into a modern one and
# render anyway. This is what lets settings.json invoke the bare path instead of
# pinning /opt/homebrew/bin/bash, which only exists on one machine's prefix — and a
# status line that does not run publishes no usage file, which silently disables
# hibernation.
if [ -x /bin/bash ] && [ "$(/bin/bash -c 'echo ${BASH_VERSINFO[0]}')" -lt 4 ]; then
    old_out=$(printf '%s' "$FULL" | STATUSLINE_CACHE_DIR="$CACHE" COLUMNS=140 \
        /bin/bash "$SCRIPT" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g')
    check     "old bash re-execs and renders" "$old_out" "CONTEXT:"
    check_not "old bash does not give up"     "$old_out" "needs bash 4+"

    # With the re-exec suppressed, the guard must explain itself ON STDOUT — the
    # only stream the footer shows, so stderr alone reads as a blank status line.
    # Suppressing it is also what stops a loop when the replacement is old too.
    guard_out=$(printf '%s' "$FULL" | STATUSLINE_CACHE_DIR="$CACHE" COLUMNS=140 \
        STATUSLINE_REEXEC=1 /bin/bash "$SCRIPT" 2>/dev/null)
    check "guard explains itself on stdout" "$guard_out" "needs bash 4+"
else
    echo "  skip no bash <4 available to test the re-exec against"
fi

# Expected cwd rendering: leading $HOME abbreviated to ~. Computed by prefix-strip
# rather than "${PWD/#$HOME/~}" for the same reason the script avoids it — bash 4+
# tilde-expands a substitution's replacement, so that form yields a different
# expectation depending on which bash runs the test.
CWD_DISPLAY="$PWD"
[ "${CWD_DISPLAY#"$HOME"}" != "$CWD_DISPLAY" ] && CWD_DISPLAY="~${CWD_DISPLAY#"$HOME"}"

echo "normal mode (COLUMNS=140)"
out=$(run 140 "$FULL")
check "model name"   "$out" "Opus 5"
check "cwd"          "$out" "$CWD_DISPLAY"
check "context label" "$out" "CONTEXT:"
check "context pct"  "$out" "42%"
check "context bar"  "$out" "⛁"
check "usage row"    "$out" "USE:"
check "5h window"    "$out" "5HR:"
check "7d window"    "$out" "WEEK:"
check "billing mode" "$out" "(SUB/API)"

echo "mini mode (COLUMNS=70)"
out=$(run 70 "$FULL")
check "model name"  "$out" "Opus 5"
check "context bar" "$out" "⛁"

echo "micro mode (COLUMNS=45)"
out=$(run 45 "$FULL")
check "context pct" "$out" "42%"

echo "nano mode (COLUMNS=30)"
out=$(run 30 "$FULL")
check "context pct" "$out" "42%"

echo "no rate_limits (API-key auth — usage row must be suppressed, not blank)"
out=$(run 140 '{"model":{"display_name":"Sonnet 5"},"workspace":{"current_dir":"'"$PWD"'"},
"session_id":"sltest2","context_window":{"context_window_size":200000,"used_percentage":7,"total_input_tokens":14000}}')
check     "still renders context" "$out" "CONTEXT:"
check_not "no usage row"          "$out" "5HR:"

echo "enterprise (no 5h/7d windows — org credit meter renders on its own row)"
# Seed the cache the probe writes, so this asserts the render path without a
# network call. A fresh cache is under the TTL, so the script skips the fetch.
printf '{"enterprise_credits":{"utilization":0.95,"resets_at":1790812800,"status":"allowed_warning"}}\n' > "$CACHE/usage.json"
out=$(run_as enterprise 140 '{"model":{"display_name":"Sonnet 5"},"workspace":{"current_dir":"'"$PWD"'"},
"session_id":"sltest-ent","context_window":{"context_window_size":1000000,"used_percentage":7,"total_input_tokens":14000}}')
check     "credits row"    "$out" "CREDITS:"
check     "credit percent" "$out" "95%"
check_not "no 5h label"    "$out" "5HR:"
check_not "no week label"  "$out" "WEEK:"
# The credit pool resets on the 1st, weeks out; a bare weekday would read as this week.
printf '{"enterprise_credits":{"utilization":0.43,"resets_at":4102444800,"status":"allowed"}}\n' > "$CACHE/usage.json"
out=$(STATUSLINE_TZ=UTC run_as enterprise 140 '{"model":{"display_name":"Sonnet 5"},"workspace":{"current_dir":"'"$PWD"'"},
"session_id":"sltest-ent","context_window":{"context_window_size":1000000,"used_percentage":7,"total_input_tokens":14000}}')
check "distant reset shows the date" "$out" "↻JAN1@0000"

echo "session work (days • prompts • compactions • tool calls, subagents included)"
# A queued attachment is a prompt; a task notification is not. The subagent's
# toolu_A repeats the parent's, as a fork's transcript does, and counts once.
TR="$CACHE/work-sess.jsonl"; mkdir -p "$CACHE/work-sess/subagents"
cat > "$TR" <<'EOF'
{"type":"user","uuid":"u1","timestamp":"2026-01-01T10:00:00.000Z","origin":{"kind":"human"},"message":{"role":"user","content":"hi"}}
{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"toolu_A","name":"Bash","input":{}}]}}
{"type":"system","subtype":"compact_boundary","uuid":"c1","timestamp":"2026-01-01T10:10:00.000Z"}
{"type":"attachment","uuid":"q1","timestamp":"2026-01-01T10:20:00.000Z","attachment":{"type":"queued_command","origin":{"kind":"human"}}}
{"type":"user","uuid":"n1","timestamp":"2026-01-01T10:30:00.000Z","origin":{"kind":"task-notification"},"message":{"role":"user","content":"done"}}
{"type":"user","uuid":"u2","timestamp":"2026-01-03T10:00:00.000Z","origin":{"kind":"human"},"message":{"role":"user","content":"again"}}
EOF
cat > "$CACHE/work-sess/subagents/agent-x.jsonl" <<'EOF'
{"type":"assistant","uuid":"s1","message":{"content":[{"type":"tool_use","id":"toolu_A","name":"Bash","input":{}}]}}
{"type":"assistant","uuid":"s2","message":{"content":[{"type":"tool_use","id":"toolu_B","name":"Read","input":{}}]}}
EOF
WORK_JSON='{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"'"$PWD"'"},
"session_id":"sltest-work","transcript_path":"'"$TR"'",
"context_window":{"context_window_size":200000,"used_percentage":42,"total_input_tokens":84000},
"rate_limits":{"five_hour":{"used_percentage":42,"resets_at":"2099-01-01T00:00:00Z"},
"seven_day":{"used_percentage":18,"resets_at":"2099-01-02T00:00:00Z"}}}'
check "work counts" "$(run 200 "$WORK_JSON")" "WORK: 2 days • 3 prompts • 1 compaction • 2 tool calls"
echo '{"type":"assistant","uuid":"a2","message":{"content":[{"type":"tool_use","id":"toolu_C","name":"Bash","input":{}}]}}' >> "$TR"
check "appended bytes are counted" "$(run 200 "$WORK_JSON")" "• 3 tool calls"

# The account-switch case: a cache written under the other account. Rendering it
# would show the wrong account's numbers, so the shape mismatch forces a refetch
# and, with curl silenced, the row is dropped rather than guessed at.
NO_LIMITS='{"model":{"display_name":"Sonnet 5"},"workspace":{"current_dir":"'"$PWD"'"},
"session_id":"sltest-sw","context_window":{"context_window_size":200000,"used_percentage":7,"total_input_tokens":14000}}'
printf '{"five_hour":{"utilization":42,"resets_at":"2099-01-01T00:00:00Z"},"seven_day":{"utilization":18,"resets_at":"2099-01-02T00:00:00Z"}}\n' > "$CACHE/usage.json"
echo "account switch — personal cache while on the enterprise account"
out=$(run_as enterprise 140 "$NO_LIMITS")
check_not "personal cache not rendered"   "$out" "5HR:"
check_not "nothing invented as credits"   "$out" "CREDITS:"

echo "account switch — enterprise cache while on a personal account"
printf '{"enterprise_credits":{"utilization":0.95,"resets_at":1790812800,"status":"allowed_warning"}}\n' > "$CACHE/usage.json"
out=$(run_as max 140 "$NO_LIMITS")
check_not "enterprise cache not rendered" "$out" "CREDITS:"
check_not "nothing invented as a window"   "$out" "5HR:"

# Unknown account kind (no readable token, or an account cache predating
# ACCOUNT_SUB) stays permissive, so the row still renders from whatever is there.
echo "unknown account kind — shape is accepted as before"
printf '{"five_hour":{"utilization":42,"resets_at":"2099-01-01T00:00:00Z"},"seven_day":{"utilization":18,"resets_at":"2099-01-02T00:00:00Z"}}\n' > "$CACHE/usage.json"
out=$(run_as '' 140 "$NO_LIMITS")
check "permissive when kind unknown" "$out" "5HR:"
rm -f "$CACHE/usage.json"

# The enterprise probe is a billed request, so its TTL has to govern failed
# attempts as well as successful ones. Observed in the wild: with only the cache
# age as a gate, a probe that never succeeds re-fires on every 2s refresh.
echo "probe TTL governs failed attempts, not just successes"
printf '{"enterprise_credits":{"utilization":0.95,"resets_at":1790812800,"status":"allowed_warning"}}\n' > "$CACHE/usage.json"
rm -f "$CACHE/usage.json.attempt"
: > "$STUB/calls"
for _ in 1 2 3 4 5 6 7 8 9 10; do
    backdate "$CACHE/usage.json" 2
    run_as enterprise 140 "$NO_LIMITS" >/dev/null
done
check_eq "ten failing refreshes → one attempt" "$(grep -c 'v1/messages' "$STUB/calls")" "1"
check "stale value still shown while throttled" "$(run_as enterprise 140 "$NO_LIMITS")" "CREDITS: 95%"
rm -f "$CACHE/usage.json" "$CACHE/usage.json.attempt"

echo "startup estimate (no context_window at all — must not render 0%)"
rm -f /tmp/claude-statusline-startup-sltest3.sh
out=$(run 140 '{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"'"$PWD"'"},"session_id":"sltest3"}')
check     "renders context"      "$out" "CONTEXT:"
check_not "estimate is non-zero" "$out" " 0%"

echo "account label"
out=$(printf '%s' "$FULL" | STATUSLINE_CACHE_DIR="$CACHE" STATUSLINE_ACCOUNT='TestCorp' COLUMNS=140 \
    bash "$SCRIPT" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
check "honors STATUSLINE_ACCOUNT" "$out" "TestCorp"

# Derived label: must produce something non-empty without the override, and must
# never leak a raw email into the header (the org/domain label is what we want).
rm -f "/tmp/claude-statusline-account-${USER:-anon}.sh"
out=$(run 140 "$FULL")
hdr=$(printf '%s' "$out" | sed -n 2p)
if [ -n "${hdr// /}" ]; then
    pass=$((pass + 1)); echo "  ok   derived label is non-empty"
else
    fail=$((fail + 1)); echo "  FAIL header line 2 is blank"
fi
# Personal accounts have no real org — Claude auto-names one "<email>'s
# Organization", which is noise. We deliberately show the bare email instead,
# so the header is expected to carry an @ and NOT the auto-generated suffix.
check_not "no auto-named org in header" "$hdr" "s Organization"

echo "session name (from transcript title records)"
# A rename does not stop ai-title records being appended afterwards, so this
# fixture puts the ai-title LAST — a custom title must still win on type, not
# position. Each case needs its own cache dir; the label is mtime-cached.
sess_row() {
    local transcript="$1" c
    c=$(mktemp -d)
    printf '%s' '{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"'"$PWD"'"},
"session_id":"sltitle","transcript_path":"'"$transcript"'"}' \
        | STATUSLINE_CACHE_DIR="$c" COLUMNS=140 bash "$SCRIPT" 2>&1 \
        | sed 's/\x1b\[[0-9;]*m//g' | sed -n 1p
    rm -rf "$c"
}

T_AI=$(mktemp); T_CUSTOM=$(mktemp); T_NONE=$(mktemp); T_LONG=$(mktemp)
printf '%s\n' '{"type":"ai-title","aiTitle":"auto named thing","sessionId":"sltitle"}' > "$T_AI"
{ printf '%s\n' '{"type":"ai-title","aiTitle":"auto named thing","sessionId":"sltitle"}'
  printf '%s\n' '{"type":"custom-title","customTitle":"my chat","sessionId":"sltitle"}'
  printf '%s\n' '{"type":"ai-title","aiTitle":"auto named thing","sessionId":"sltitle"}'; } > "$T_CUSTOM"
printf '%s\n' '{"type":"user","message":"no title records here"}' > "$T_NONE"
printf '%s\n' '{"type":"ai-title","aiTitle":"set up mcp_excalidraw server for live diagram editing","sessionId":"sltitle"}' > "$T_LONG"

check     "ai-title renders"            "$(sess_row "$T_AI")"     "AUTO NAMED THING"
check     "custom title beats ai-title" "$(sess_row "$T_CUSTOM")" "MY CHAT"
check_not "ai-title dropped when named" "$(sess_row "$T_CUSTOM")" "AUTO NAMED"
check     "name sits before the cwd"    "$(sess_row "$T_CUSTOM")" "MY CHAT │ $CWD_DISPLAY"
check_not "no session segment when unset" "$(sess_row "$T_NONE")" "│  │"
# Long ai-titles are capped so the cwd and branch keep their place on the row.
long_row=$(sess_row "$T_LONG")
check     "long title truncated"        "$long_row" "…"
check_not "long title not shown whole"  "$long_row" "LIVE DIAGRAM EDITING"
rm -f "$T_AI" "$T_CUSTOM" "$T_NONE" "$T_LONG"

echo "account label: stale-profile guard"
# ~/.claude.json's .oauthAccount is a cached profile blob and has been observed
# holding a different account than the keychain token actually in use. The label
# cross-checks the two and refuses to name an org it cannot verify. Extract the
# jq verbatim from the script so this tests the shipped logic, not a copy.
LABEL_JQ="$CACHE/label.jq"
sed -n '/--- label-jq-begin ---/,/--- label-jq-end ---/p' "$SCRIPT" \
    | sed -n "/^        jq -r --arg tok/,/^        ' /p" \
    | sed '1s/.*--arg tok "\$_tok_sub" .//; $d' > "$LABEL_JQ"

label_for() { # <token subscriptionType> <profile organizationType>
    local tok="$1" otype="$2" em org
    if [ "$otype" = "claude_enterprise" ]; then em="employee@example.com"; org="Example Corp"
    else em="person@example.net"; org="person@example.net's Organization"; fi
    jq -rn --arg em "$em" --arg org "$org" --arg ot "$otype" \
        '{oauthAccount:{emailAddress:$em,organizationName:$org,organizationType:$ot}}' \
      | jq -r --arg tok "$tok" -f "$LABEL_JQ"
}

if [ -s "$LABEL_JQ" ]; then
    check     "agreeing enterprise → org name"   "$(label_for enterprise claude_enterprise)" "Example Corp"
    check     "agreeing personal → bare email"   "$(label_for max        claude_max)"        "person@example.net"
    # The exact failure seen in the wild: enterprise token, stale personal profile.
    check     "token/profile disagree → no name" "$(label_for enterprise claude_max)"        "enterprise"
    check_not "disagreement never names the org" "$(label_for enterprise claude_max)"        "example.net"
    check_not "disagreement never names the org" "$(label_for max claude_enterprise)"        "Example Corp"
    # No readable token (Linux without the creds file, locked keychain): fail open
    # to the cached name rather than showing nothing.
    check     "no token → falls back to profile" "$(label_for ''         claude_enterprise)" "Example Corp"
else
    fail=$((fail + 1)); echo "  FAIL could not extract label jq — did the markers move?"
fi

echo "live usage file (consumed by hibernate.hook.ts)"
LIVE="/tmp/claude-statusline-usage-${USER:-anon}.json"
rm -f "$LIVE"
run 140 "$FULL" >/dev/null
if [ -f "$LIVE" ]; then
    pass=$((pass + 1)); echo "  ok   file written"
    live=$(cat "$LIVE")
    check "has five_hour_pct"   "$live" '"five_hour_pct":42'
    check "has five_hour_reset" "$live" '"five_hour_reset"'
    check "has ts"              "$live" '"ts"'
    if jq empty "$LIVE" 2>/dev/null; then
        pass=$((pass + 1)); echo "  ok   valid JSON"
    else
        fail=$((fail + 1)); echo "  FAIL not valid JSON: $live"
    fi
else
    fail=$((fail + 1)); echo "  FAIL live usage file not written"
fi

# Narrow panes must still feed the hook — the write happens before mode branching.
rm -f "$LIVE"
run 30 "$FULL" >/dev/null
if [ -f "$LIVE" ]; then
    pass=$((pass + 1)); echo "  ok   written in nano mode too"
else
    fail=$((fail + 1)); echo "  FAIL live usage file not written in nano mode"
fi

# No rate_limits on stdin → nothing to publish, and no stale file left behind.
rm -f "$LIVE"
run 140 '{"model":{"display_name":"Sonnet 5"},"workspace":{"current_dir":"'"$PWD"'"},"session_id":"sltest4"}' >/dev/null
if [ ! -f "$LIVE" ]; then
    pass=$((pass + 1)); echo "  ok   not written when rate_limits absent"
else
    fail=$((fail + 1)); echo "  FAIL wrote a live file with no rate_limits to report"
fi
rm -f "$LIVE"

echo "hibernation banner (published by hibernate.hook.ts while it sleeps)"
HIB="/tmp/claude-hibernate-${USER:-anon}"
NOW=$(date +%s)
# $$ stands in for the sleeping hook: the reader requires a live pid.
banner() { printf '%s' "$1" > "$HIB"; run "$2" "$FULL" 2>&1 | head -1; }

rm -f "$HIB"
check_not "absent when not hibernating" "$(run 140 "$FULL" 2>&1 | head -1)" "HIBERNATING"

# A blocked hook draws nothing itself, so this banner is the only thing standing
# between a multi-hour pause and a user who concludes the session hung and ctrl-c's.
# It has to survive every width mode, including the compact card that exits early.
for w in 140 100 70 40 25; do
    check "shown at width $w" "$(banner "$((NOW + 7200)) 98 $$" "$w")" "HIBERNATING"
done
check "wide form carries the ETA"   "$(banner "$((NOW + 7200)) 98 $$" 140)" "resumes in"
check "wide form carries the usage" "$(banner "$((NOW + 7200)) 98 $$" 140)" "98%"

# Wrapping would push the status line's own rows off screen, so the banner has to
# fit the pane it is drawn in at every width, not just the wide one.
# Counted in characters, not bytes: the separators are multi-byte UTF-8 but each
# occupies one column, so wc -c overstates the width by ~4 and fails a line that
# fits. jq counts codepoints and is already a hard dependency, which beats ${#}
# under a named locale — this file runs on bash 3.2, where ${#} counts bytes, and
# en_US.UTF-8 is not guaranteed to exist on a minimal Linux.
_ovf=""
for w in 25 30 40 55 60 64 68 72 80 140; do
    _line=$(banner "$((NOW + 7200)) 98 $$" "$w" | LC_ALL=C sed $'s/\033\[[0-9;]*m//g')
    _len=$(printf '%s' "$_line" | jq -Rr 'length')
    _lim=$w; [ "$_lim" -gt 72 ] && _lim=72
    [ "$_len" -gt "$_lim" ] && _ovf="$_ovf ${w}:${_len}"
done
if [ -z "$_ovf" ]; then
    pass=$((pass + 1)); echo "  ok   never overflows its pane"
else
    fail=$((fail + 1)); echo "  FAIL banner overflows at (width:len)$_ovf"
fi

# Self-expiring: a hook SIGKILLed mid-sleep never runs its cleanup, so the wake
# stamp — not the file's existence — is what takes the banner down.
check_not "gone once the wake time passes" "$(banner "$((NOW - 60)) 98 $$" 140)" "HIBERNATING"

# /tmp is world-writable. Both fields are untrusted: the epoch reaches $(( )),
# which would run a command substitution planted in an array subscript.
rm -f /tmp/statusline-hib-pwned
banner 'a[$(touch /tmp/statusline-hib-pwned)] 98 1' 140 >/dev/null
if [ ! -f /tmp/statusline-hib-pwned ]; then
    pass=$((pass + 1)); echo "  ok   arithmetic injection blocked"
else
    fail=$((fail + 1)); echo "  FAIL arithmetic injection executed"
    rm -f /tmp/statusline-hib-pwned
fi
check_not "garbage epoch renders nothing"  "$(banner 'banana split nonsense' 140)"       "HIBERNATING"
check_not "millisecond epoch rejected"     "$(banner "${NOW}000 98 $$" 140)"       "HIBERNATING"
check_not "empty file renders nothing"     "$(banner '' 140)"                   "HIBERNATING"
# The pid is the guard of last resort: SIGKILL runs no cleanup, so a stale file
# with a still-future wake time must not keep the banner up on a working session.
check_not "dead pid takes the banner down" "$(banner "$((NOW + 7200)) 98 999999" 140)" "HIBERNATING"
check_not "missing pid takes it down"      "$(banner "$((NOW + 7200)) 98" 140)"        "HIBERNATING"
check     "printf format in pct is inert"  "$(banner "$((NOW + 600)) %n%s $$" 140)" "HIBERNATING"
rm -f "$HIB"

echo "hibernate hook self-check"
if command -v bun >/dev/null 2>&1; then
    if bun "$(dirname "$SCRIPT")/hibernate.hook.ts" --selftest >/dev/null 2>&1; then
        pass=$((pass + 1)); echo "  ok   decision logic"
    else
        fail=$((fail + 1)); echo "  FAIL hibernate selftest — run: bun hibernate.hook.ts --selftest"
    fi
else
    echo "  skip bun not installed"
fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
