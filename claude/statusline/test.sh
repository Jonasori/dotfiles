#!/bin/bash
# Smoke test for statusline.ts. Runs it against synthetic Claude Code input
# across all four width modes plus the degraded paths, and asserts the lines that
# matter actually render. No framework, no fixtures — just run it:
#   ./test.sh
#
# Uses a throwaway cache dir so it never touches the real one, and
# STATUSLINE_OFFLINE so nothing is fetched: the usage fallback would otherwise
# read the real keychain token and, on an enterprise account, buy a billed
# completion. Shared data is seeded into shared.json where a case needs it.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/statusline.ts"
CACHE="$(mktemp -d)"
trap 'rm -rf "$CACHE" /tmp/claude-statusline-startup-sltest*.json' EXIT
export STATUSLINE_OFFLINE=1

pass=0 fail=0

# Strip ANSI so assertions match on plain text.
run() {
    local cols="$1" json="$2"
    printf '%s' "$json" | STATUSLINE_CACHE_DIR="$CACHE" COLUMNS="$cols" \
        bun "$SCRIPT" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'
}

# Same, but pins the account kind: with STATUSLINE_ACCOUNT set, ACCOUNT_SUB
# stands in for the token's subscription type.
run_as() { # <subscriptionType> <cols> <json>
    local sub="$1" cols="$2" json="$3"
    printf '%s' "$json" | STATUSLINE_ACCOUNT=Test ACCOUNT_SUB="$sub" \
        STATUSLINE_CACHE_DIR="$CACHE" COLUMNS="$cols" \
        bun "$SCRIPT" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'
}

# Seed the refresher's usage cache, as fetched <age> seconds ago.
seed_usage() { # <usage-json> [age]
    jq -n --argjson d "$1" --argjson at "$(( $(date +%s) - ${2:-0} ))" '{usage:{data:$d,at:$at}}' > "$CACHE/shared.json"
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

FULL='{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"'"$PWD"'"},
"session_id":"sltest","version":"2.1.80",
"context_window":{"context_window_size":200000,"used_percentage":42,"total_input_tokens":84000},
"rate_limits":{"five_hour":{"used_percentage":42,"resets_at":"2099-01-01T00:00:00Z"},
"seven_day":{"used_percentage":18,"resets_at":"2099-01-02T00:00:00Z"}}}'

echo "parses"
if bun build --no-bundle "$SCRIPT" >/dev/null 2>&1; then pass=$((pass+1)); echo "  ok   statusline.ts"; else fail=$((fail+1)); echo "  FAIL statusline.ts does not parse"; fi

# Expected cwd rendering: leading $HOME abbreviated to ~. Computed by prefix-strip
# rather than "${PWD/#$HOME/~}": bash 4+ tilde-expands a substitution's
# replacement, so that form gives a different answer depending on which bash runs.
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
# Seed what the probe writes, so this asserts the render path without a network call.
seed_usage '{"enterprise_credits":{"utilization":0.95,"resets_at":1790812800,"status":"allowed_warning"}}'
out=$(run_as enterprise 140 '{"model":{"display_name":"Sonnet 5"},"workspace":{"current_dir":"'"$PWD"'"},
"session_id":"sltest-ent","context_window":{"context_window_size":1000000,"used_percentage":7,"total_input_tokens":14000}}')
check     "credits row"    "$out" "CREDITS:"
check     "credit percent" "$out" "95%"
check_not "no 5h label"    "$out" "5HR:"
check_not "no week label"  "$out" "WEEK:"
# The credit pool resets on the 1st, weeks out; a bare weekday would read as this week.
seed_usage '{"enterprise_credits":{"utilization":0.43,"resets_at":4102444800,"status":"allowed"}}'
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
# would show the wrong account's numbers, so the row is dropped rather than
# guessed at until the refresher refetches.
NO_LIMITS='{"model":{"display_name":"Sonnet 5"},"workspace":{"current_dir":"'"$PWD"'"},
"session_id":"sltest-sw","context_window":{"context_window_size":200000,"used_percentage":7,"total_input_tokens":14000}}'
seed_usage '{"five_hour":{"utilization":42,"resets_at":"2099-01-01T00:00:00Z"},"seven_day":{"utilization":18,"resets_at":"2099-01-02T00:00:00Z"}}'
echo "account switch — personal cache while on the enterprise account"
out=$(run_as enterprise 140 "$NO_LIMITS")
check_not "personal cache not rendered"   "$out" "5HR:"
check_not "nothing invented as credits"   "$out" "CREDITS:"

echo "account switch — enterprise cache while on a personal account"
seed_usage '{"enterprise_credits":{"utilization":0.95,"resets_at":1790812800,"status":"allowed_warning"}}'
out=$(run_as max 140 "$NO_LIMITS")
check_not "enterprise cache not rendered" "$out" "CREDITS:"
check_not "nothing invented as a window"   "$out" "5HR:"

# Unknown account kind (no readable token) stays permissive, so the row still
# renders from whatever is there.
echo "unknown account kind — shape is accepted as before"
seed_usage '{"five_hour":{"utilization":42,"resets_at":"2099-01-01T00:00:00Z"},"seven_day":{"utilization":18,"resets_at":"2099-01-02T00:00:00Z"}}'
out=$(run_as '' 140 "$NO_LIMITS")
check "permissive when kind unknown" "$out" "5HR:"

# Fallback data is shown while under 30 minutes old, its labels dimmed after 10.
echo "fallback staleness"
seed_usage '{"enterprise_credits":{"utilization":0.95,"resets_at":1790812800,"status":"allowed_warning"}}' 900
check     "stale value still shown" "$(run_as enterprise 140 "$NO_LIMITS")" "CREDITS: 95%"
check     "with its age"            "$(run_as enterprise 140 "$NO_LIMITS")" "(15m)"
seed_usage '{"enterprise_credits":{"utilization":0.95,"resets_at":1790812800,"status":"allowed_warning"}}' 2000
check_not "dropped past 30 minutes" "$(run_as enterprise 140 "$NO_LIMITS")" "CREDITS:"
rm -f "$CACHE/shared.json"

echo "startup estimate (no context_window at all — must not render 0%)"
rm -f /tmp/claude-statusline-startup-sltest3.json
out=$(run 140 '{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"'"$PWD"'"},"session_id":"sltest3"}')
check     "renders context"      "$out" "CONTEXT:"
check_not "estimate is non-zero" "$out" " 0%"

echo "account label"
out=$(printf '%s' "$FULL" | STATUSLINE_CACHE_DIR="$CACHE" STATUSLINE_ACCOUNT='TestCorp' COLUMNS=140 \
    bun "$SCRIPT" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
check "honors STATUSLINE_ACCOUNT" "$out" "TestCorp"

# Derived label: whatever the refresher recorded, and a neutral glyph before it has run.
check "label before first refresh" "$(run 140 "$FULL" | sed -n 2p)" "▲ │"
jq -n '{account:{label:"Example Corp",sub:"enterprise",profile:"{}",seen:0,at:0}}' > "$CACHE/shared.json"
check "label from the refresher"   "$(run 140 "$FULL" | sed -n 2p)" "Example Corp │"
rm -f "$CACHE/shared.json"

echo "session name (from transcript title records)"
# A rename does not stop ai-title records being appended afterwards, so this
# fixture puts the ai-title LAST — a custom title must still win on type, not
# position. Each case needs its own cache dir; titles are read incrementally.
sess_row() {
    local transcript="$1" c
    c=$(mktemp -d)
    printf '%s' '{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"'"$PWD"'"},
"session_id":"sltitle","transcript_path":"'"$transcript"'"}' \
        | STATUSLINE_OFFLINE=1 STATUSLINE_CACHE_DIR="$c" COLUMNS=140 bun "$SCRIPT" 2>&1 \
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

echo "refresher decisions (label guard, usage probe clock, cache shape, retry)"
if out=$(bun "$HERE/refresh.ts" --selftest 2>&1); then
    pass=$((pass + 1)); echo "  ok   $out"
else
    fail=$((fail + 1)); echo "  FAIL $out"
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
# fits. jq counts codepoints, which beats ${#} under a named locale — this file
# runs on bash 3.2, where ${#} counts bytes.
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

# /tmp is world-writable, so every field is untrusted.
check_not "garbage epoch renders nothing"  "$(banner 'banana split nonsense' 140)"       "HIBERNATING"
check_not "millisecond epoch rejected"     "$(banner "${NOW}000 98 $$" 140)"       "HIBERNATING"
check_not "empty file renders nothing"     "$(banner '' 140)"                   "HIBERNATING"
# The pid is the guard of last resort: SIGKILL runs no cleanup, so a stale file
# with a still-future wake time must not keep the banner up on a working session.
check_not "dead pid takes the banner down" "$(banner "$((NOW + 7200)) 98 999999" 140)" "HIBERNATING"
check_not "missing pid takes it down"      "$(banner "$((NOW + 7200)) 98" 140)"        "HIBERNATING"
check     "printf format in pct is inert"  "$(banner "$((NOW + 600)) %n%s $$" 140)" "HIBERNATING"
rm -f "$HIB"

echo "never blank: bad state renders the rest"
# Any throw prints nothing at all, so each of these must still produce rows.
check "null on stdin" "$(printf 'null' | STATUSLINE_CACHE_DIR="$CACHE" COLUMNS=30 bun "$SCRIPT" 2>&1)" "%"
mkdir -p /tmp/claude-hibernate-sltest
check "hibernate state is a directory" "$(printf '%s' "$FULL" | USER=sltest STATUSLINE_CACHE_DIR="$CACHE" COLUMNS=140 bun "$SCRIPT" 2>&1)" "CONTEXT:"
rmdir /tmp/claude-hibernate-sltest
mkdir -p "/tmp/claude-statusline-usage-sltest.json"
check "live usage file unwritable" "$(printf '%s' "$FULL" | USER=sltest STATUSLINE_CACHE_DIR="$CACHE" COLUMNS=140 bun "$SCRIPT" 2>&1)" "CONTEXT:"
rmdir "/tmp/claude-statusline-usage-sltest.json"
printf '{"quote":{"text":"No author.","at":%s}}\n' "$(date +%s)" > "$CACHE/shared.json"
check "cached quote without an author" "$(run 140 "$FULL")" "CONTEXT:"
rm -f "$CACHE/shared.json"

echo "hibernate hook self-check"
if bun "$HERE/hibernate.hook.ts" --selftest >/dev/null 2>&1; then
    pass=$((pass + 1)); echo "  ok   decision logic"
else
    fail=$((fail + 1)); echo "  FAIL hibernate selftest — run: bun hibernate.hook.ts --selftest"
fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
