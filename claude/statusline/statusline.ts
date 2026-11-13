#!/usr/bin/env bun
/**
 * Claude Code status line — responsive display with 4 modes by terminal width:
 *   nano (<35), micro (35-54), mini (55-79), normal (80+)
 * Normal output: model/cwd → header (account, location, time, weather) → context
 * → usage and session work → quote.
 *
 * Every open session runs this on every refresh, and endpoint-security agents
 * inspect each process launch (5-150ms apiece under load), so the steady state
 * launches nothing: machine-wide data comes from the file refresh.ts maintains,
 * git state is read from .git, and session work is read incrementally.
 *
 * Environment overrides (all optional):
 *   STATUSLINE_CACHE_DIR   cache root         (default ~/.cache/claude-statusline)
 *   STATUSLINE_TEMP_UNIT   fahrenheit|celsius (default fahrenheit)
 *   STATUSLINE_TZ          IANA tz name       (default: system timezone)
 *   STATUSLINE_ACCOUNT     header label       (default: derived from logged-in account)
 *   STATUSLINE_OFFLINE     1 = never fetch; render from what is cached
 *   ZENQUOTES_API_KEY      keyed quote API    (optional; keyless endpoint otherwise)
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { gitInfo, lastCommit } from "./git.ts";
import { CACHE_DIR, type Item, type Shared, accountKind, accountSub, isDue, lockHeld, readShared, usageShapeOk } from "./refresh.ts";
import { sessionWork } from "./work.ts";

const HOME = process.env.HOME ?? "";
const USER = process.env.USER ?? "anon";
const TZ = process.env.STATUSLINE_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
// Live 5h/7d usage for hibernate.hook.ts. In /tmp because it is per-boot
// scratch: a stale copy surviving a reboot is what the hook's freshness guard rejects.
const USAGE_LIVE = `/tmp/claude-statusline-usage-${USER}.json`;
// "<wake-epoch> <pct> <pid>", written by hibernate.hook.ts while it sleeps.
const HIBERNATE_STATE = `/tmp/claude-hibernate-${USER}`;
const now = Math.floor(Date.now() / 1000);

// ─── Colors ──────────────────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const SLATE_300 = rgb(203, 213, 225);
const SLATE_400 = rgb(148, 163, 184);
const SLATE_600 = rgb(71, 85, 105); // separators
const EMERALD = rgb(74, 222, 128);
const ROSE = rgb(251, 113, 133);
const ORANGE = rgb(251, 146, 60);
const AMBER = rgb(251, 191, 36);
const DARK_RED = rgb(180, 40, 40);
const GIT_PRIMARY = rgb(56, 189, 248);
const GIT_VALUE = rgb(186, 230, 253);
const GIT_DIR = rgb(147, 197, 253);
const GIT_STASH = rgb(165, 180, 252);
const GIT_AGE = rgb(96, 165, 250);
const CTX_PRIMARY = rgb(129, 140, 248);
const CTX_SECONDARY = rgb(165, 180, 252);
const CTX_EMPTY = rgb(75, 82, 95);
const USAGE_PRIMARY = rgb(194, 139, 62);
const USAGE_LABEL = rgb(168, 113, 50);
const USAGE_RESET = rgb(148, 163, 184);
const USAGE_EXTRA = rgb(140, 90, 60);
const USAGE_STALE = rgb(120, 113, 108); // stale labels, never values
const QUOTE_PRIMARY = rgb(252, 211, 77);
const QUOTE_AUTHOR = rgb(180, 140, 60);
const BRAND = rgb(59, 130, 246);
const HDR_CITY = rgb(37, 99, 235);
const HDR_STATE = rgb(125, 211, 252);
const HDR_TIME = rgb(96, 165, 250);
const HDR_WEATHER = rgb(135, 206, 235);
const HDR_SESSION = rgb(120, 135, 160);
const BAR = ` ${SLATE_600}│${RESET} `;

const usageColor = (pct: number) => (pct >= 80 ? ROSE : pct >= 60 ? ORANGE : pct >= 40 ? AMBER : EMERALD);

// ─── Time formatting ─────────────────────────────────────────────────────────
const zoneParts = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, year: "numeric", month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function zoned(epoch: number): Record<string, string> {
  return Object.fromEntries(zoneParts.formatToParts(new Date(epoch * 1000)).map((p) => [p.type, p.value]));
}

// Absolute reset time: "TODAY@1500", "THU@0900", or "JAN1@0000" when a weekday
// alone would read as this week (the enterprise credit pool resets monthly).
function resetTime(epoch: number): string {
  if (epoch <= now) return "now";
  const r = zoned(epoch);
  const t = zoned(now);
  const hhmm = `${r.hour}${r.minute}`;
  if (r.year === t.year && r.month === t.month && r.day === t.day) return `TODAY@${hhmm}`;
  if (epoch - now >= 6 * 86400) return `${r.month.toUpperCase()}${r.day}@${hhmm}`;
  return `${r.weekday.toUpperCase()}@${hhmm}`;
}

// Epoch seconds from either an epoch integer (native rate_limits) or an ISO 8601
// string (OAuth API). An ISO string without an offset is UTC.
function toEpoch(ts: string | number | undefined): number {
  if (ts === undefined || ts === "") return 0;
  if (typeof ts === "number" || /^\d+$/.test(ts)) return Number(ts);
  const ms = Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts}Z`);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

// ─── Input ───────────────────────────────────────────────────────────────────
let input: any = {};
try { input = JSON.parse(await Bun.stdin.text()) ?? {}; } catch { /* render from defaults */ }
const currentDir: string = input.workspace?.current_dir ?? input.cwd ?? ".";
const sessionId: string = input.session_id ?? "";
const transcript: string = input.transcript_path ?? "";
const modelName: string = input.model?.display_name ?? "unknown";
const contextMax: number = input.context_window?.context_window_size ?? 200000;
let contextPct: number = input.context_window?.used_percentage ?? 0;
const totalInput: number = input.context_window?.total_input_tokens ?? 0;
const rl = input.rate_limits;
const pctOf = (w: any): number => w?.used_percentage ?? w?.utilization ?? 0;

// The native rate_limits block reaches only the status line, never a hook, so it
// is republished for hibernate.hook.ts. Written before any mode branching so
// narrow panes still feed it. Best-effort: a file left unwritable (say, by a
// root-owned run) must not cost the status line.
if (rl != null) {
  try {
    writeFileSync(USAGE_LIVE, JSON.stringify({
      five_hour_pct: pctOf(rl.five_hour), five_hour_reset: String(rl.five_hour?.resets_at ?? ""),
      seven_day_pct: pctOf(rl.seven_day), seven_day_reset: String(rl.seven_day?.resets_at ?? ""),
      ts: now,
    }));
  } catch { /* the hook treats a missing or stale file as "no data" */ }
}

// Before the first API call Claude Code reports no tokens, so estimate the
// starting context from what it loads: measured file sizes at ~3.5 chars/token
// plus per-item costs. Cached per session; the inputs do not change mid-session.
function startupPct(): number {
  const path = `/tmp/claude-statusline-startup-${sessionId || "nosess"}.json`;
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf8")).pct; } catch { /* recomputed below */ }
  }
  const home = `${HOME}/.claude`;
  const tokens = (p: string) => Math.floor(((statSync(p, { throwIfNoEntry: false })?.size ?? 0) * 10) / 35);
  // An unreadable or missing directory counts as empty, as a shell glob would.
  const glob = (pattern: string): string[] => {
    try { return [...new Bun.Glob(pattern).scanSync({ cwd: home, followSymlinks: true })]; } catch { return []; }
  };
  let est = 5000; // system prompt
  est += 12000; // tool definitions
  est += tokens(`${home}/CLAUDE.md`);
  for (const f of glob("projects/*/memory/MEMORY.md")) est += tokens(`${home}/${f}`);
  est += (glob("skills/*/SKILL.md").length + glob("plugins/*/*/skills/*/SKILL.md").length) * 150;
  est += (glob("agents/*.md").length + glob("plugins/*/*/agents/*.md").length) * 200;
  const status = Bun.spawnSync(["git", "-C", currentDir, "status", "--porcelain"], { stderr: "ignore", timeout: 1000 }).stdout;
  est += Math.floor((status.length * 10) / 35) + 500; // git status block + commit log
  est += 3000; // first message and startup reminders
  const pct = Math.floor((est * 100) / contextMax);
  writeFileSync(`${path}.${process.pid}`, JSON.stringify({ pct }));
  renameSync(`${path}.${process.pid}`, path);
  return pct;
}
if (contextPct === 0 && totalInput === 0) contextPct = startupPct();

let modelDisp = modelName.replace(/^Claude /, "").replace(/^claude-/, "");
modelDisp = modelDisp.charAt(0).toUpperCase() + modelDisp.slice(1);
if (modelDisp === "Unknown") modelDisp = "—";
const cwd = currentDir.startsWith(HOME) ? `~${currentDir.slice(HOME.length)}` : currentDir || ".";

// ─── Width ───────────────────────────────────────────────────────────────────
// Claude Code runs this with no terminal attached and passes the width in
// $COLUMNS. Some headless contexts pass 0, which must not force nano mode.
const cols = Math.floor(Number(process.env.COLUMNS));
const termWidth = cols > 0 ? cols : 80;
const mode = termWidth < 35 ? "nano" : termWidth < 55 ? "micro" : termWidth < 80 ? "mini" : "normal";
const contentWidth = Math.max(10, Math.min(termWidth, 72));
const sepSolid = `${SLATE_600}${"─".repeat(contentWidth)}${RESET}`;
const sepDashed = `${SLATE_600}${"┄".repeat(contentWidth)}${RESET}`;

// ─── Shared data ─────────────────────────────────────────────────────────────
const shared: Shared = readShared();
const wants: Item[] = [];
if (!process.env.STATUSLINE_ACCOUNT) wants.push("account");
if (mode === "mini" || mode === "normal") wants.push("location", "weather");
if (mode === "normal") wants.push("quote");
if (mode === "normal" && rl == null) wants.push("usage");
const due = wants.filter((i) => isDue(i, shared, now));
if (due.length > 0 && process.env.STATUSLINE_OFFLINE !== "1" && !lockHeld(now)) {
  spawn(process.execPath, [`${import.meta.dir}/refresh.ts`, ...due], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, STATUSLINE_CC_VERSION: input.version ?? "" },
  }).unref();
}

const label = process.env.STATUSLINE_ACCOUNT || shared.account?.label || "▲";
const loc = shared.location;
const city = mode === "mini" || mode === "normal" ? (loc ? loc.city.toUpperCase() : "UNKNOWN") : "";
const state = loc?.region.toUpperCase() ?? "";
const weather = shared.weather?.text ?? "—";

// ISO 3166-1 alpha-2 → flag emoji (a pair of regional indicator symbols).
function flag(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return "🌐";
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const d = new Date(now * 1000);
const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${SLATE_600}${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;

// Two markers split the bar into thirds; filled buckets take the color of the
// next marker you are heading toward: green, then orange (compact now), then dark
// red (context degraded). Narrow bars space their buckets for legibility.
function contextBar(width: number, pct: number): string {
  const filled = Math.max(0, Math.floor((pct * width) / 100));
  const m1 = Math.floor(width / 3);
  const m2 = Math.floor((2 * width) / 3);
  const cells: string[] = [];
  for (let i = 1; i <= width; i++) {
    const color = i === m1 ? ORANGE : i === m2 ? DARK_RED : i > filled ? CTX_EMPTY : i < m1 ? EMERALD : i < m2 ? ORANGE : DARK_RED;
    cells.push(`${color}⛁${RESET}`);
  }
  return cells.join(width <= 20 ? " " : "");
}

const out: string[] = [];

// ─── Hibernation banner ──────────────────────────────────────────────────────
// Above everything, in every mode: a hook sleeping out a usage window renders
// nothing itself, and a user who reads the pause as a hang and hits ctrl-c throws
// the wait away. The file is in world-writable /tmp, so every field is validated,
// and only a live hook pid with an unexpired wake stamp keeps the banner up: no
// way of killing the hook leaves a banner claiming a pause after it.
function hibernation(): string | undefined {
  let raw: string;
  // Absent is the normal case; unreadable or a directory reads as absent too.
  try { raw = readFileSync(HIBERNATE_STATE, "utf8"); } catch { return undefined; }
  const [untilS = "", pctS = "", pidS = ""] = raw.trim().split(/\s+/);
  if (!/^\d+$/.test(untilS) || !/^\d+$/.test(pidS) || Number(pidS) <= 0) return undefined;
  try { process.kill(Number(pidS), 0); } catch { return undefined; }
  const left = Number(untilS) - now;
  // One sleep never outlasts a 5h window; anything longer is corrupt or planted.
  if (left <= 0 || left > 18000) return undefined;
  const pct = /^\d+$/.test(pctS) ? pctS : "?";
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  // Under a minute floors to "0m", which reads as a stalled countdown.
  const eta = h > 0 ? `${h}h${m}m` : left < 60 ? "<1m" : `${m}m`;
  // The full form is 71 columns; anything narrower gets the short form, not a wrap.
  if (contentWidth >= 72) {
    return `${QUOTE_PRIMARY}HIBERNATING${RESET}${BAR}${USAGE_PRIMARY}5h ${pct}%${RESET} ${SLATE_600}·${RESET} ${QUOTE_PRIMARY}resumes in ${eta}${RESET} ${SLATE_600}(${resetTime(Number(untilS))})${RESET} ${SLATE_600}· no action needed${RESET}`;
  }
  return `${QUOTE_PRIMARY}HIBERNATING${RESET} ${SLATE_600}·${RESET} ${QUOTE_PRIMARY}${eta}${RESET}`;
}
const banner = hibernation();
if (banner) out.push(banner);

const git = gitInfo(currentDir, CACHE_DIR);
const pctInt = Math.trunc(contextPct);
const pctColor = usageColor(pctInt);

if (mode !== "normal") {
  // ─── Compact modes: same sections, horizontally compressed ─────────────────
  let age = "";
  if (git && mode !== "nano") {
    const commit = lastCommit(git, CACHE_DIR);
    const s = now - commit;
    if (commit > 0) age = s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  }
  const ageSeg = age ? ` ${GIT_AGE}${age}${RESET}` : "";
  const brandPct = `${BRAND}${label}${RESET} ${CTX_PRIMARY}◉${RESET}${pctColor}${pctInt}%${RESET}`;
  if (mode === "nano") {
    out.push(brandPct);
    if (git) out.push(`${GIT_PRIMARY}◈${RESET}${GIT_VALUE}${git.branch}${RESET}`);
  } else if (mode === "micro") {
    out.push(brandPct, `${GIT_PRIMARY}◈${RESET}${GIT_VALUE}${git?.branch || "—"}${RESET}${ageSeg}`);
  } else {
    out.push(
      `${SLATE_300}${modelDisp}${RESET}${BAR}${GIT_DIR}${cwd}${RESET}`,
      `${BRAND}${label}${RESET}${BAR}${HDR_CITY}${city}${RESET}${BAR}${HDR_TIME}${clock}${RESET}${BAR}${HDR_WEATHER}${weather}${RESET}`,
      `${CTX_PRIMARY}◉${RESET} ${contextBar(20, pctInt)} ${pctColor}${pctInt}%${RESET}`,
      `${GIT_PRIMARY}◈${RESET} ${GIT_VALUE}${git?.branch || "—"}${RESET}${ageSeg}${git && git.stash > 0 ? ` ${GIT_STASH}⊡${git.stash}${RESET}` : ""}`,
    );
  }
} else {
  // ─── Normal mode ───────────────────────────────────────────────────────────
  const work = transcript && sessionId && existsSync(transcript) ? sessionWork(transcript, sessionId, CACHE_DIR, TZ) : undefined;

  // Session title, uppercased and capped so a long auto-generated one cannot push
  // the cwd and branch off the row.
  const maxLen = Number(process.env.STATUSLINE_SESSION_MAX_LEN || 32);
  const chars = [...(work?.title ?? "").toUpperCase()]; // by code point, so emoji are never split
  const title = chars.length > maxLen ? `${chars.slice(0, maxLen - 1).join("")}…` : chars.join("");

  out.push(
    `${SLATE_300}${modelDisp}${RESET}${title ? `${BAR}${HDR_SESSION}${title}${RESET}` : ""}${BAR}${GIT_DIR}${cwd}${RESET}` +
      (git ? `${BAR}${GIT_PRIMARY}◈${RESET}${GIT_VALUE}${git.branch}${RESET}` : ""),
  );
  let hdrLoc = "";
  if (city) {
    hdrLoc = `${loc ? flag(loc.cc) : "🌐"} ${HDR_CITY}${city}${RESET}`;
    if (state) hdrLoc += `${SLATE_600}, ${RESET}${HDR_STATE}${state}${RESET}`;
  }
  out.push(`${BRAND}${label}${RESET}${BAR}${hdrLoc}  ${HDR_TIME}${clock}${RESET}  ${HDR_WEATHER}${weather}${RESET}`, sepDashed);

  const barWidth = Math.max(16, contentWidth - 11 - (String(pctInt).length + 2));
  out.push(`${CTX_SECONDARY}CONTEXT:${RESET} ${contextBar(barWidth, pctInt)} ${pctColor}${pctInt}%${RESET}`, sepSolid);

  // ─── Usage row ─────────────────────────────────────────────────────────────
  // Native rate_limits when Claude Code sends them; otherwise the refresher's
  // fallback, shown only while under 30 minutes old and from the current account.
  const cached = shared.usage;
  const cachedOk = cached !== undefined && now - cached.at < 1800 && usageShapeOk(shared, accountKind(accountSub(shared)));
  const u = rl != null ? { five_hour: rl.five_hour, seven_day: rl.seven_day, extra_usage: rl.extra_usage } : cachedOk ? cached.data : undefined;
  const fromCache = rl == null;
  const ent = u?.enterprise_credits;
  const u5 = Math.trunc(pctOf(u?.five_hour));
  const u7 = Math.trunc(pctOf(u?.seven_day));
  // Some sessions send native windows without resets_at; borrow the fallback's.
  const reset5 = u?.five_hour?.resets_at || cached?.data.five_hour?.resets_at;
  const reset7 = u?.seven_day?.resets_at || cached?.data.seven_day?.resets_at;

  if (u && (ent || u5 > 0 || u7 > 0 || cached)) {
    // Stale fallback data dims its labels and times, never its values.
    const age = fromCache ? now - cached!.at : 0;
    const stale = age > 600;
    const labelC = stale ? USAGE_STALE : USAGE_LABEL;
    const resetC = stale ? USAGE_STALE : USAGE_RESET;
    const fmtReset = (ts: string | number | undefined) => {
      const e = toEpoch(ts);
      if (e <= 0) return `${labelC}—${RESET}`;
      const [day, time] = resetTime(e).split("@");
      return time ? `${labelC}${day}${RESET}${SLATE_600}@${RESET}${labelC}${time}${RESET}` : `${labelC}${day}${RESET}`;
    };
    let row: string;
    if (ent) {
      // One org-wide credit pool, not two windows: labelling it 5HR/WEEK would lie.
      const p = Math.round(ent.utilization * 100);
      row = `${resetC}USE: CREDITS:${RESET} ${usageColor(p)}${p}%${RESET} ${resetC}↻${RESET}${fmtReset(ent.resets_at)} ${SLATE_600}(${RESET}${USAGE_PRIMARY}SUB${RESET}${SLATE_600})${RESET}`;
    } else {
      row = `${resetC}USE: 5HR:${RESET} ${usageColor(u5)}${u5}%${RESET} ${resetC}↻${RESET}${fmtReset(reset5)}${BAR}` +
        `${resetC}WEEK:${RESET} ${usageColor(u7)}${u7}%${RESET} ${resetC}↻${RESET}${fmtReset(reset7)} ` +
        `${SLATE_600}(${RESET}${USAGE_PRIMARY}SUB${RESET}${SLATE_600}/${RESET}${SLATE_600}API${RESET}${SLATE_600})${RESET}`;
    }
    if (work) {
      const noun = (n: number | string, w: string) => `${USAGE_PRIMARY}${n}${RESET} ${USAGE_RESET}${w}${n === 1 ? "" : "s"}${RESET}`;
      const r = Math.floor((work.tools + 50) / 100);
      const tools = work.tools >= 1000 ? `${Math.floor(r / 10)}.${r % 10}k` : work.tools;
      const dot = ` ${SLATE_600}•${RESET} `;
      row += `${BAR}${USAGE_RESET}WORK:${RESET} ${[noun(work.days, "day"), noun(work.prompts, "prompt"), noun(work.compacts, "compaction"), noun(tools, "tool call")].join(dot)}`;
    }
    const extra = u.extra_usage;
    if (extra?.is_enabled) {
      const limit = Math.floor((extra.monthly_limit ?? 0) / 100);
      const used = Math.floor(Math.trunc(extra.used_credits ?? 0) / 100);
      row += `${BAR}${USAGE_EXTRA}E:$${used}/${limit >= 1000 ? `$${Math.floor(limit / 1000)}K` : `$${limit}`}${RESET}`;
    }
    if (stale) {
      const min = Math.floor(age / 60);
      row += ` ${USAGE_STALE}(${min >= 60 ? `${Math.floor(min / 60)}h` : `${min}m`})${RESET}`;
    }
    out.push(row, sepSolid);
  }

  // ─── Quote ─────────────────────────────────────────────────────────────────
  const q = shared.quote;
  if (q?.text && typeof q.author === "string") {
    const width = Math.min(termWidth, 120);
    if (q.text.length + q.author.length + 6 <= width) {
      out.push(`${SLATE_400}"${q.text}"${RESET} ${QUOTE_AUTHOR}—${q.author}${RESET}`);
    } else {
      let at = Math.min(Math.max(width - 8, 40), q.text.length);
      while (at > 10 && q.text[at] !== " ") at--;
      out.push(`${SLATE_400}"${q.text.slice(0, at)}${RESET}`, `  ${SLATE_400}${q.text.slice(at + 1)}"${RESET} ${QUOTE_AUTHOR}—${q.author}${RESET}`);
    }
  }
}

process.stdout.write(`${out.join("\n")}\n`);
