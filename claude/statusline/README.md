# claude-statusline

A self-contained status line for Claude Code that works on any machine with
bash 4+, jq, curl, and git.

The shebang is `#!/usr/bin/env bash` on purpose: macOS pins `/bin/bash` at 3.2
forever, and 3.2 differs from 4+ in ways that silently change output rather than
erroring (most memorably, `${x/#$HOME/~}` abbreviates on 3.2 but is a no-op on 4+,
which tilde-expands a substitution's replacement). Rather than write to the
intersection of both, the script targets 4+ and refuses to run on less.

```
Opus 5 │ ~/dotfiles
▲ │ 🇺🇸 OAKLAND, CA  16:28  ☁️ 63°F
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
CONTEXT: ⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁⛁ 19%
──────────────────────────────────────────────────
USE: 5HR: 42% ↻TODAY@1500 │ WEEK: 18% ↻SUN@1700 (SUB/API) │ WORK: 4 days • 29 prompts • 2 compactions • 6.8k tool calls
──────────────────────────────────────────────────
"A minute's success pays the failure of years." —Robert Browning
```

## Install

Point `statusLine` at the script in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "$HOME/dotfiles/claude/statusline/statusline.sh",
    "refreshInterval": 2
  }
}
```

No other setup. Caches are created on first run.

## What it shows

| Row | Source |
|-----|--------|
| Model + working directory | statusline JSON on stdin |
| Location, time, weather | ip-api.com + open-meteo.com (cached 60 min / 15 min) |
| Context bar | `context_window` from stdin; estimated from file sizes before the first API call |
| Usage 5HR / WEEK | native `rate_limits` from stdin, falling back to the OAuth usage API |
| Session work (on the usage row) | `transcript_path` and its `subagents/*.jsonl`: days with a prompt, human prompts, compactions, unique tool calls; read incrementally into `$STATUSLINE_CACHE_DIR/work/<session_id>/` |
| Quote | zenquotes.io (cached 15 min) |

The context bar has two fixed markers at 1/3 and 2/3 of the width — orange, then
dark red — so the fill color tells you which threshold you are heading toward.

Every network call is best-effort with a short timeout. Offline, the affected
rows fall back to cache or disappear; the rest still render.

## Responsive modes

Width is detected via Kitty IPC, `/dev/tty`, `tput`, then `$COLUMNS`.

| Mode | Width | Shows |
|------|-------|-------|
| nano | < 35 | brand + context %, git branch |
| micro | 35–54 | above + commit age |
| mini | 55–79 | model/cwd, location, compact bar, git |
| normal | 80+ | everything above |

## Configuration

All optional, all environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `STATUSLINE_CACHE_DIR` | `~/.cache/claude-statusline` | Cache root |
| `STATUSLINE_TEMP_UNIT` | `fahrenheit` | `fahrenheit` or `celsius` |
| `STATUSLINE_TZ` | system timezone | IANA name, for usage-reset times |
| `STATUSLINE_ACCOUNT` | derived (see below) | Label leading the header line |
| `ZENQUOTES_API_KEY` | unset | Keyed quote API; drops refresh to 60s |

Set them in the `env` block of `settings.json`, or export them in your shell.

### The account label

The header line leads with which login the pane is running as — the one thing you
can't infer from the rest of the footer, and getting it wrong means burning the
wrong org's rate limit.

The name comes from Claude Code's own `~/.claude.json` (`.oauthAccount`):
`organizationName` for a real org, otherwise the bare email (personal accounts
get an auto-named `<email>'s Organization`, which is noise).

**`.oauthAccount` is a cached profile blob, not the live credential.** It refreshes
opportunistically and has been observed sitting on a *different account's* profile
for hours — showing a personal Max login while the keychain token was enterprise
the whole time. Since a label that confidently names the wrong org is worse than
no label, it is cross-checked against the token that actually authenticates
requests (`.claudeAiOauth.subscriptionType`, from the macOS keychain or
`~/.claude/.credentials.json`):

| Token | Cached profile | Shows |
|-------|----------------|-------|
| `enterprise` | `claude_enterprise` | `Example Corp` |
| `max` | `claude_max` | `person@example.net` |
| `enterprise` | `claude_max` | `enterprise` — disagreement, so no name is claimed |
| unreadable | anything | falls back to the cached name |

Both reads sit behind the same mtime cache and only re-run when `~/.claude.json`
changes, so the `security` fork is not on the 2s refresh path.

Set `STATUSLINE_ACCOUNT` to override with any string. The full email is
deliberately not shown for org accounts — the header already carries location,
time, and weather, and the short form is what distinguishes them.

## Usage hibernation

`hibernate.hook.ts` keeps a long session alive across a usage-limit window rather
than letting it hit the wall and die. On every `PreToolUse` it reads the current
5-hour percentage; at `HIBERNATE_PCT` it sleeps in place — zero tokens, no
supervisor, no reprompt — until the window resets, then lets the pending tool
through. The session is never killed, just paused.

Because the pause needs no resume message, there is nothing to schedule and
nothing to get lost: the tool call that was about to run is still the tool call
that runs on the other side. Accounts with no 5-hour limit (enterprise, most API
keys) never publish a `rate_limits` block, so no live file is written and the hook
is inert — nothing to turn off.

While it sleeps, the status line shows a banner in every width mode:

```
HIBERNATING │ 5h 98% · resumes in 2h14m (TODAY@0224) · no action needed
```

That banner is the whole reason the state file exists. A blocked hook renders
nothing of its own and hook stderr is not surfaced for a non-blocking hook, so
without it a three-hour pause is indistinguishable from a hang — and the one
thing that actually breaks hibernation is a user concluding it crashed and
hitting ctrl-c. The hook writes `<wake-epoch> <pct>` to
`/tmp/claude-hibernate-$USER` before sleeping and removes it on wake or on
SIGINT/SIGTERM/SIGHUP. The status line trusts the wake stamp rather than the
file's existence, so even a `SIGKILL` that outruns the cleanup cannot leave a
banner on screen forever.

It lives here because it depends on this statusline. Claude Code hands the native
`rate_limits` block to the status line only; a hook never sees it on stdin, and
reading the OAuth token directly is off-limits. So `statusline.sh` republishes it
to `/tmp/claude-statusline-usage-$USER.json` on every refresh (the "PUBLISH LIVE
USAGE" block, which runs before width-mode branching so narrow panes still feed
the hook), and the hook reads that.

Wire it up in `settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{
          "type": "command",
          "command": "$HOME/dotfiles/claude/statusline/hibernate.hook.ts",
          "timeout": 18000
      }] }
    ]
  }
}
```

The `timeout` must exceed the longest sleep or the harness cuts hibernation
short — 18000s is the ~5h window length. Claude Code honours this field for
command hooks with no ceiling of its own: measured on 2.1.273, a 95s hook sleep
ran to completion where the 60s default would have cut it at 60s.

`HIBERNATE_MAX_SLEEP_SEC` is the other half of that pair and must stay *below*
it. Waking early is harmless — the next tool call re-checks, finds the window
still exhausted, and sleeps the remainder — whereas being killed mid-sleep drops
the session straight into the wall this hook exists to avoid. Raise one and you
have to raise the other.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HIBERNATE_OFF` | unset | Set to `1` to disable entirely |
| `HIBERNATE_PCT` | `97` | Hibernate at this 5h utilization % |
| `HIBERNATE_BUFFER_SEC` | `30` | Extra seconds to sleep past the reset |
| `HIBERNATE_MAX_SLEEP_SEC` | `17700` | Hard cap on one sleep (4h55m) — must stay under the `timeout` above |
| `HIBERNATE_STALE_SEC` | `300` | Ignore the live file if older than this |

Every error path fails open — a missing file, a stale timestamp, an unparseable
reset time, or any exception exits 0 and lets the tool run. The only thing this
hook is permitted to do is delay.

It acts on the 5-hour limit only. The 7-day limit resets days out, so "sleep
until reset" is not a sensible response to it.

Subagents hibernate too, without anything being done to make them: `PreToolUse`
fires for their tool calls as well, so each one pauses at its own next tool
boundary. Measured — a subagent whose first command published an over-threshold
usage file saw its second command delayed by the full sleep. Background *shell*
commands keep running through a hibernation, which is fine: they burn no tokens.

### What it does not cover

The live usage file is written by the status line, so at least one session has to
be running it for any of this to fire. A session without the status line still
benefits — the file is shared — but if no session is rendering one, the file goes
stale and the hook does nothing.

Both files are per-user, not per-session, because the usage window is per-account.
So every open session shows the banner once any of them is asleep, which is
accurate: the others hibernate at their own next tool call. The flip side is that
whichever hook wakes first clears the banner for all of them, a few seconds early
for the rest. They share a reset time, so the gap is seconds.

Waking is timed off the reset stamp the API reports, plus `HIBERNATE_BUFFER_SEC`.
If the server rolls the window over later than that stamp promised, the hook wakes
into a window that is still full, sees a reset time now in the past, and proceeds
rather than sleeping again — deliberately, since "reset is in the past" is also the
normal signal to carry on, and treating it as a reason to sleep is how a session
wedges forever. Widen `HIBERNATE_BUFFER_SEC` if that is ever seen in practice.

### Picking the threshold

The check runs at tool-call boundaries, so the margin below 100% has to cover
whatever a single request can consume. Measured over 8,023 requests from ~3 weeks
of local transcripts, expressed as a share of the busiest observed 5h window:

```
median request   0.10%
p90              0.29%
p99              0.57%
max              4.84%
```

The tail is not a smooth ramp — it is bimodal. Ordinary requests sit under 0.6%,
and then there is a cluster at 4.5–4.8% with almost nothing in between. Those big
ones are 98% `cache_creation`: a single request that rebuilds a full 1M-token
context cache. Running `opus[1m]` makes them routine, not exotic.

The consequence is that a 1% and a 2% margin miss nearly the same set. Weighting
by size (a large request covers more of the axis, so it is likelier to be the one
that straddles the threshold):

| Threshold | Margin | Chance the crossing request overshoots |
|-----------|--------|----------------------------------------|
| 99 | 1% | ~14% |
| **98** | **2%** | **~11.5%** |
| 97 | 3% | ~8% |
| 95 | 5% | ~0% |

**95 is where the observed tail actually clears.** 97 is the current default: it
sits at the near-flat part of that curve, where the next percent of headroom buys
much less than the first two did. If hibernation keeps failing to catch in time,
`HIBERNATE_PCT=95` is the fix, at the price of 5% of every window.

Overshooting is not catastrophic in any case. The threshold governs how often the
wall gets hit, not what happens next — and when the hook does catch, it holds the
session for exactly as long as the window has left.

Two caveats on those numbers. The "limit" is proxied by the busiest 5h window
in the data, which assumes that window actually reached ~100%. And the weighting
(input ×1, cache-create ×1.25, cache-read ×0.1, output ×5) approximates
Anthropic's accounting rather than reproducing it. Both shift the absolute
percentages; neither changes the shape, since the ratio is computed within one
dataset. Re-run the analysis if the model or context size changes.

## Tests

```sh
./test.sh                          # status line + hook decision logic
bun hibernate.hook.ts --selftest   # hook only
```

`test.sh` runs the script against synthetic input across all four width modes
plus the degraded paths (no `rate_limits`, no `context_window`), asserts the rows
that matter render, checks the live usage file is published correctly, and shells
out to the hook's own self-check. Uses a throwaway cache dir.

The hook self-check exercises threshold, staleness, buffer, cap, and malformed
input branches without ever sleeping.

## Notes

- Nothing is written outside `$STATUSLINE_CACHE_DIR` and `/tmp`. The live usage
  file is deliberately in `/tmp` rather than the cache dir — it is per-boot
  scratch, and a stale copy surviving a reboot is exactly what the hook's
  freshness guard is there to reject.
- Session labels come from Claude Code's own `sessions-index.json`, so only
  sessions renamed with `/rename` show a label.
- The keyless zenquotes endpoint allows 5 req / 30s, which several concurrent
  panes will exhaust. A 429 is filtered out rather than cached, so the previous
  quote stays until a fetch succeeds.
