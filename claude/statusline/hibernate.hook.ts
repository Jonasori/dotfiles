#!/usr/bin/env bun
/**
 * hibernate.hook.ts - Hibernate near the subscription usage limit (PreToolUse)
 *
 * PURPOSE:
 * Keeps a long autonomous session ALIVE across a usage-limit window instead of
 * letting it hit the wall and die. Before each tool call it reads the current
 * 5-hour usage percentage; when it reaches HIBERNATE_PCT%, the hook simply sleeps
 * — in place, at zero token cost — for the time remaining until the window resets,
 * then returns and lets the pending tool proceed. No external supervisor, no
 * "continue your work" reprompt: the session is never killed, just paused.
 *
 * SIGNAL SOURCE — the authoritative one, not a proxy:
 * The 5HR percentage is exactly what the footer shows ("USE: 5HR: 72%"). It comes
 * from Claude Code's native `rate_limits` (Anthropic /api/oauth/usage). That native
 * data is NOT on a PreToolUse hook's stdin, and pulling the OAuth token ourselves
 * is off-limits — so statusline.sh (which receives fresh native data every ~2s
 * refresh) persists it to this file, and we read it here:
 *     /tmp/claude-statusline-usage-$USER.json  ->  {five_hour_pct, five_hour_reset, ...}
 * The writer is the "PUBLISH LIVE USAGE" block near the top of statusline.sh, which
 * runs before any width-mode branching so narrow panes still feed this hook.
 *
 * TRIGGER: PreToolUse (no matcher — runs before every tool). Reading one small
 * local file is ~free, so it checks on every tool with no throttle — which catches
 * the threshold crossing tightly, without spawning anything.
 *
 * CONFIG (env; all optional — the feature is ON by default):
 * - HIBERNATE_OFF           : set to "1" to disable entirely.
 * - HIBERNATE_PCT           : hibernate at this 5h utilization % (default 97).
 * - HIBERNATE_BUFFER_SEC    : extra seconds to sleep past the reset (default 30).
 * - HIBERNATE_MAX_SLEEP_SEC : hard cap on a single sleep (default 17700 = 4h55m,
 *                             which must stay under the settings.json hook timeout).
 * - HIBERNATE_STALE_SEC     : ignore the live file if older than this (default 300).
 *
 * WHY THE STALENESS GUARD: during active work the statusline refreshes the file
 * every couple seconds. If it's stale (idle session, statusline off, old Claude
 * Code with no native rate_limits), we have no trustworthy % and do nothing.
 *
 * SCOPE: acts on the 5-hour limit only. The 7-day limit resets days out, so
 * "sleep until reset" is not a sensible response to it — left out deliberately.
 *
 * INPUT:  stdin: PreToolUse hook JSON (drained and ignored — decision is usage-based)
 * OUTPUT: stderr: a status line when it hibernates/wakes; exit(0) ALWAYS (never blocks)
 *
 * SIDE EFFECTS: may pause the session (sleep) for up to ~5h while hibernating.
 *
 * FAIL-OPEN: every error path returns and exits 0. A bug here must never brick
 * the ability to use Claude — the only thing this hook is allowed to do is delay.
 *
 * HOOK TIMEOUT (verified): the harness honours the `timeout` field in
 * settings.json for command hooks — measured, a 95s sleep ran to completion under
 * `timeout: 18000` where the 60s default would have cut it at 60s. So the sleep
 * must stay under that configured timeout, which is what HIBERNATE_MAX_SLEEP_SEC
 * is for: waking early is harmless (the next tool call re-checks and sleeps the
 * remainder), being killed mid-sleep is not.
 *
 * VISIBILITY: a sleeping hook renders nothing — the session just stops, and hook
 * stderr is not surfaced on a non-blocking hook. Hours of that is indistinguishable
 * from a hang, and a user who concludes it hung and hits ctrl-c has thrown away the
 * whole wait. So before sleeping we publish `<until-epoch> <pct> <pid>` to
 * /tmp/claude-hibernate-$USER and statusline.sh renders a countdown banner from it;
 * the status line keeps refreshing while the hook blocks (verified), so it ticks.
 * See publishState for how the banner is kept from outliving the sleep.
 *
 * SUBAGENTS: nothing special is needed for them. PreToolUse fires for a subagent's
 * tool calls too, so each one hibernates at its own next tool boundary — verified
 * by having a subagent publish an over-threshold usage file in its first command
 * and measuring the delay on its second. Background shell commands run straight
 * through a hibernation, which is harmless: they cost no tokens.
 *
 * SELF-CHECK: `bun hibernate.hook.ts --selftest` exercises the decision logic
 * against synthetic live-usage files without sleeping. Run it after edits.
 */

const LOG = "[hibernate]";

interface Live {
  five_hour_pct?: number;
  five_hour_reset?: string | number;
  ts?: number;
}

function log(msg: string): void {
  process.stderr.write(`${LOG} ${msg}\n`);
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The reset value can be an epoch integer (what Claude Code's native rate_limits
 * actually sends, e.g. "1784140200") OR an ISO string (the OAuth /usage format).
 * Handle both. Returns epoch ms, or NaN if unusable.
 */
function parseResetMs(v: string | number | undefined): number {
  if (v === undefined) return NaN;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return s.length >= 13 ? n : n * 1000; // 13 digits = ms, else seconds
  }
  return Date.parse(s);
}

/**
 * Pure decision: given the live payload and now, how long should we sleep?
 * Returns 0 for "proceed immediately". Split out from main() so the self-check
 * can exercise every branch without actually sleeping.
 */
export function decideSleepSec(live: Live, nowMs: number): number {
  const pctThreshold = envNum("HIBERNATE_PCT", 97);
  const bufferSec = envNum("HIBERNATE_BUFFER_SEC", 30);
  const maxSleepSec = envNum("HIBERNATE_MAX_SLEEP_SEC", 17700);
  const staleSec = envNum("HIBERNATE_STALE_SEC", 300);

  // Freshness: statusline stamps `ts` (epoch seconds). Ignore stale data.
  const ts = Number(live.ts ?? 0);
  if (!Number.isFinite(ts) || nowMs / 1000 - ts > staleSec) return 0;

  const pct = Number(live.five_hour_pct ?? NaN);
  if (!Number.isFinite(pct) || pct < pctThreshold) return 0; // under threshold → proceed

  const resetMs = parseResetMs(live.five_hour_reset);
  if (!Number.isFinite(resetMs)) return 0; // no usable reset time → fail open

  let sleepSec = (resetMs - nowMs) / 1000 + bufferSec;
  if (sleepSec <= 0) return 0; // window already reset → proceed
  if (sleepSec > maxSleepSec) sleepSec = maxSleepSec;
  return sleepSec;
}

function livePath(): string {
  return `/tmp/claude-statusline-usage-${process.env.USER ?? "anon"}.json`;
}

/**
 * Where the countdown banner is published for statusline.sh. Format is one line,
 * `<wake-epoch-seconds> <pct> <pid>` — flat rather than JSON so the status line can
 * read it with a builtin `read` on its 2s refresh instead of forking jq.
 *
 * The pid is what makes the banner honest. Cleanup on wake and on SIGINT/SIGTERM/
 * SIGHUP covers the ordinary exits, but a hook killed with SIGKILL runs nothing at
 * all — and a status line still claiming to hibernate while the session is plainly
 * working is worse than no banner. The reader checks the pid is alive, so the
 * banner cannot outlive the sleep it describes regardless of how the sleep ended.
 */
function statePath(): string {
  return `/tmp/claude-hibernate-${process.env.USER ?? "anon"}`;
}

function publishState(wakeAtSec: number, pct: unknown): void {
  try {
    require("node:fs").writeFileSync(
      statePath(),
      `${Math.round(wakeAtSec)} ${pct} ${process.pid}\n`,
    );
  } catch {
    /* the banner is a courtesy; never let it stop the hibernation itself */
  }
}

function clearState(): void {
  try {
    require("node:fs").unlinkSync(statePath());
  } catch {
    /* already gone */
  }
}

async function main(): Promise<void> {
  // Drain stdin so the harness never blocks on our pipe; the content is unused.
  try {
    await Bun.stdin.text();
  } catch {
    /* ignore */
  }

  if (process.env.HIBERNATE_OFF === "1") return; // kill switch

  let live: Live;
  try {
    live = JSON.parse(await Bun.file(livePath()).text());
  } catch {
    return; // no live file / unreadable → fail open
  }

  const sleepSec = decideSleepSec(live, Date.now());
  if (sleepSec <= 0) return;

  const resetMs = parseResetMs(live.five_hour_reset);
  const resetLocal = new Date(resetMs).toLocaleTimeString();
  const mins = Math.round(sleepSec / 60);
  log(
    `💤 Claude is hibernating — 5h usage hit ${live.five_hour_pct}% ` +
      `(limit ${envNum("HIBERNATE_PCT", 97)}%). ` +
      `Pausing ~${mins} min until the window resets at ${resetLocal}, then resuming on its own. No action needed.`,
  );

  // Publish the banner before sleeping, and tear it down on the way out — including
  // the interrupt path, since a user who ctrl-c's out of a 3h pause must not be left
  // staring at a status line that still claims to be hibernating.
  const wakeAtSec = Date.now() / 1000 + sleepSec;
  publishState(wakeAtSec, live.five_hour_pct);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      clearState();
      process.exit(0);
    });
  }

  await new Promise((resolve) => setTimeout(resolve, sleepSec * 1000));

  clearState();
  log(`✅ Woke after usage-window reset (${resetLocal}); resuming work.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-CHECK — `bun hibernate.hook.ts --selftest`
// ─────────────────────────────────────────────────────────────────────────────
function selftest(): void {
  const NOW = 1_800_000_000_000; // fixed epoch ms
  const nowSec = NOW / 1000;
  let pass = 0;
  let fail = 0;

  const check = (label: string, got: number, want: "sleep" | "proceed") => {
    const ok = want === "sleep" ? got > 0 : got === 0;
    if (ok) {
      pass++;
      console.log(`  ok   ${label}`);
    } else {
      fail++;
      console.log(`  FAIL ${label} — got ${got}, wanted ${want}`);
    }
  };

  const inOneHour = Math.floor(NOW / 1000) + 3600;

  check("over threshold, fresh, future reset → sleeps",
    decideSleepSec({ five_hour_pct: 99, five_hour_reset: inOneHour, ts: nowSec }, NOW), "sleep");

  check("under threshold → proceeds",
    decideSleepSec({ five_hour_pct: 42, five_hour_reset: inOneHour, ts: nowSec }, NOW), "proceed");

  // Pin the default threshold. A single 1M-context request costs ~4.5-5% of a 5h
  // window, so this number is the whole ballgame — see README "Picking the threshold".
  check("default threshold is 97: exactly 97 → sleeps",
    decideSleepSec({ five_hour_pct: 97, five_hour_reset: inOneHour, ts: nowSec }, NOW), "sleep");
  check("default threshold is 97: 96 → proceeds",
    decideSleepSec({ five_hour_pct: 96, five_hour_reset: inOneHour, ts: nowSec }, NOW), "proceed");

  check("stale payload (>300s) → proceeds",
    decideSleepSec({ five_hour_pct: 99, five_hour_reset: inOneHour, ts: nowSec - 600 }, NOW), "proceed");

  check("reset passed longer ago than the buffer → proceeds",
    decideSleepSec({ five_hour_pct: 99, five_hour_reset: Math.floor(NOW / 1000) - 600, ts: nowSec }, NOW), "proceed");

  // Reset just happened but HIBERNATE_BUFFER_SEC (30s) has not fully elapsed —
  // wait out the remainder rather than resuming exactly on the boundary.
  check("reset just passed, still inside the buffer → sleeps out the remainder",
    decideSleepSec({ five_hour_pct: 99, five_hour_reset: Math.floor(NOW / 1000) - 10, ts: nowSec }, NOW), "sleep");

  check("missing reset → proceeds",
    decideSleepSec({ five_hour_pct: 99, ts: nowSec }, NOW), "proceed");

  check("garbage reset → proceeds",
    decideSleepSec({ five_hour_pct: 99, five_hour_reset: "not-a-date", ts: nowSec }, NOW), "proceed");

  check("missing pct → proceeds",
    decideSleepSec({ five_hour_reset: inOneHour, ts: nowSec }, NOW), "proceed");

  check("no ts at all → proceeds",
    decideSleepSec({ five_hour_pct: 99, five_hour_reset: inOneHour }, NOW), "proceed");

  check("ISO-8601 reset string is parsed → sleeps",
    decideSleepSec(
      { five_hour_pct: 99, five_hour_reset: new Date(NOW + 3600_000).toISOString(), ts: nowSec },
      NOW,
    ), "sleep");

  // Sleep must be capped at HIBERNATE_MAX_SLEEP_SEC even if the reset claims to be
  // days away — the guard against a bogus reset timestamp. The cap also has to stay
  // under the settings.json hook timeout (18000s) or the harness kills the sleep
  // partway, which is the one failure mode this whole hook exists to avoid.
  const capped = decideSleepSec(
    { five_hour_pct: 99, five_hour_reset: Math.floor(NOW / 1000) + 86400 * 3, ts: nowSec },
    NOW,
  );
  if (capped === 17700) {
    pass++;
    console.log("  ok   absurd reset is capped at 4h55m");
  } else {
    fail++;
    console.log(`  FAIL absurd reset cap — got ${capped}, wanted 17700`);
  }
  if (capped < 18000) {
    pass++;
    console.log("  ok   cap stays under the 18000s settings.json hook timeout");
  } else {
    fail++;
    console.log(`  FAIL cap ${capped} >= 18000s hook timeout — harness would kill the sleep`);
  }

  // Banner lifecycle: published before the sleep, gone after, and self-expiring so a
  // SIGKILLed hook cannot leave the status line permanently claiming to be asleep.
  publishState(NOW / 1000 + 600, 99);
  const raw = require("node:fs").readFileSync(statePath(), "utf8").trim();
  if (raw === `${Math.round(NOW / 1000 + 600)} 99 ${process.pid}`) {
    pass++;
    console.log("  ok   state file is `<wake-epoch> <pct> <pid>`");
  } else {
    fail++;
    console.log(`  FAIL state file contents — got ${JSON.stringify(raw)}`);
  }
  clearState();
  if (!require("node:fs").existsSync(statePath())) {
    pass++;
    console.log("  ok   state file is removed on wake");
  } else {
    fail++;
    console.log("  FAIL state file survived clearState()");
  }
  clearState(); // second clear must not throw
  pass++;
  console.log("  ok   clearing an absent state file is a no-op");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  await main();
  process.exit(0);
}
