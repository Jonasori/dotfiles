#!/usr/bin/env bun
/// <reference path="./env.d.ts" />

/**
 * Terminal UI surface -- statusline pairs (model|cwd, USE|branch), CONTEXT
 * meter, rotating tips row, and Claude-Code-style select-to-copy. A static
 * body: no menus, no navigation model, nothing to drill into. q or ESC
 * quits; drag with button 1 and release to copy the covered text.
 *
 *     bun tui.ts              # interactive
 *     bun tui.ts --selftest   # headless logic check
 *
 * Everything is plain CSI/SGR escape sequences -- no ncurses, no
 * dependencies. The "Copied N characters" toast lands in the bottom-right
 * corner, Claude Code style.
 *
 * The CONTEXT bar is a placeholder usage meter driven by set_context(); a
 * real host would feed it real numbers.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Keys. Curly-style private codes sit above the ASCII range; the terminal's
// escape sequences for arrows are reassembled in feed_mouse() and then
// dropped -- this surface has no navigation, but the bytes still have to be
// consumed or an errant arrow would flush its ESC prefix as a quit.
// ---------------------------------------------------------------------------

const KEY_UP = 258;
const KEY_DOWN = 259;
const KEY_RIGHT = 261;
const KEY_LEFT = 260;

// ---------------------------------------------------------------------------
// Application state. The surface is static: nothing here drives a stack or a
// cursor. set_context()/set_status() are the seams a real host would use.
// ---------------------------------------------------------------------------

class App {
  /** One-line transient message, shown over the tip row until cleared. */
  status = "";
  tipIndex = 0;
  cwd = process.cwd();
  /** Placeholder CONTEXT-bar state; drive with set_context(). */
  contextPct = 19;
  contextWindow = 200_000;

  setStatus(text: string): void {
    this.status = text;
  }

  setContext(pct: unknown, window?: unknown): void {
    // Bad input leaves the bar as it was.
    const n = parseInt(String(pct), 10);
    if (Number.isFinite(n)) this.contextPct = Math.max(0, Math.min(100, n));
    if (window !== undefined) {
      const w = parseInt(String(window), 10);
      if (Number.isFinite(w)) this.contextWindow = Math.max(0, w);
    }
  }
}

// ---------------------------------------------------------------------------
// Status area -- paired rows (model|cwd, USE|branch), CONTEXT bar, tips line.
// Pure helpers first so the layout math is testable headless.
// ---------------------------------------------------------------------------

const TIPS = [
  "Drag with button 1 and release to copy visible text, Claude Code style",
  "The toast at the bottom-right overlays the tip row",
  "Multi-line drags join with newlines, like Claude Code",
  "The CONTEXT meter is a placeholder -- feed it with set_context()",
  "Slash commands: /verify /derive /stats /pipeline -- rigor on demand",
  "Type / at the prompt to list every slash command",
  "/verify reproduces a claim against real data before believing it",
  "/stats audits significance, effect size, confounders, multiplicity",
  "/derive states assumptions, units, and edge cases before the math",
  "/pipeline checks idempotency, retries, and failure modes",
  "q or ESC quits; the terminal is always restored cleanly",
];

function fmtTokens(count: number): string {
  // 999, 1.2k, 12k, 1.2M, 12M -- same shape as the statusline reference.
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function abbrevHome(p: string): string {
  // ~/... under $HOME, untouched otherwise (so the cwd stays short).
  const home = os.homedir();
  const abs = path.resolve(p);
  if (abs === home) return "~";
  if (abs.startsWith(home + path.sep)) return "~" + abs.slice(home.length);
  return abs;
}

function repoBranch(startDir: string): string | null {
  // Git branch by walking up the tree and reading .git/HEAD (no subprocess).
  // Returns the branch name, "detached", or null when not in a repository.
  let cur = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth++) {
    const head = path.join(cur, ".git", "HEAD");
    if (fs.existsSync(head) && fs.statSync(head).isFile()) {
      try {
        const ref = fs.readFileSync(head, "utf8").split("\n")[0].trim();
        if (ref.startsWith("ref: refs/heads/")) return ref.slice("ref: refs/heads/".length);
        return ref ? "detached" : null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

function fitLeftLen(leftLen: number, rightLen: number, width: number, gutter = 2): number {
  // Longest left text that leaves room for right text + gutter in `width` cols.
  return Math.max(0, Math.min(leftLen, width - rightLen - gutter));
}

function pairMath(
  leftLen: number,
  rightLen: number,
  width: number,
  gutter = 2,
): { clipped: number; pad: number } {
  const clipped = fitLeftLen(leftLen, rightLen, width, gutter);
  return { clipped, pad: width - clipped - rightLen };
}

/** CONTEXT-bucket band key for 1-based position i: markers at 1/3 and 2/3. */
function bandOf(i: number, pos1: number, pos2: number, filled: number): Band {
  if (i === pos1) return "marker1";
  if (i === pos2) return "marker2";
  if (i <= filled) {
    if (i < pos1) return "green";
    if (i < pos2) return "amber";
    return "orange";
  }
  return "empty";
}

/** Trailing percentage color: emerald → amber → orange → rose. */
function usageColorKey(pct: number | null): Band {
  if (pct === null) return "muted";
  if (pct >= 80) return "rose";
  if (pct >= 60) return "orange";
  if (pct >= 40) return "amber";
  return "green";
}

type Band =
  | "text"
  | "cwd"
  | "muted"
  | "branch"
  | "ctlabel"
  | "empty"
  | "green"
  | "amber"
  | "orange"
  | "marker1"
  | "marker2"
  | "rose"
  | "gold"
  | "golddim"
  | "uselabel";

// Claude statusline palette (~/dotfiles/claude/statusline/statusline.sh RGBs).
const RGB: Record<Band, [number, number, number]> = {
  text: [203, 213, 225], // model / values
  cwd: [148, 163, 184], // working directory
  muted: [100, 116, 139], // secondary labels
  branch: [56, 189, 248], // git branch
  ctlabel: [165, 180, 252], // CONTEXT label
  empty: [75, 82, 95], // empty buckets
  green: [74, 222, 128],
  amber: [250, 204, 21],
  orange: [251, 146, 60],
  marker1: [251, 146, 60], // 1/3 threshold
  marker2: [180, 40, 40], // 2/3 threshold
  rose: [251, 113, 133],
  gold: [252, 211, 77], // tips marker
  golddim: [180, 140, 60], // tips text
  uselabel: [168, 113, 50], // USE:
};

/** Per-band SGR decoration on top of the color (1=bold, 2=dim, ""=plain). */
const ATTR: Record<Band, string> = {
  text: "",
  cwd: "2",
  muted: "2",
  branch: "1",
  ctlabel: "1",
  empty: "2",
  green: "1",
  amber: "1",
  orange: "1",
  marker1: "1",
  marker2: "1",
  rose: "1",
  gold: "1",
  golddim: "2",
  uselabel: "2",
};

function fg(band: Band): string {
  const [r, g, b] = RGB[band];
  const deco = ATTR[band];
  return `\x1b[${deco ? deco + ";" : ""}38;2;${r};${g};${b}m`;
}

/**
 * Pure CONTEXT-bar geometry. Buckets are U+00B7 middle dots, one per column
 * (the 2:1 byte budget the notebook build had under macOS ncurses is gone:
 * raw SGR rendering budgets by column, so a dot occupies one).
 */
function renderBar(
  width: number,
  pct: number | null,
  window: number,
  maxBuckets = 100,
): {
  label: string;
  pctStr: string;
  windowPart: string;
  buckets: number;
  filled: number;
  pos1: number;
  pos2: number;
} {
  const label = "CONTEXT:";
  const pctStr = pct === null ? "?" : `${Math.round(pct)}%`;
  const windowPart = `/${fmtTokens(window)}`;
  const buckets = Math.max(
    0,
    Math.min(maxBuckets, width - label.length - 1 - pctStr.length - windowPart.length - 2),
  );
  return {
    label,
    pctStr,
    windowPart,
    buckets,
    filled: Math.floor((buckets * (pct ?? 0)) / 100),
    pos1: Math.floor(buckets / 3),
    pos2: Math.floor((2 * buckets) / 3),
  };
}

// ---------------------------------------------------------------------------
// Select-to-copy -- Claude Code behaviour: dragging with button 1 copies the
// covered text and pops a "Copied N characters" toast in the bottom-right
// corner. Mouse input is negotiated straight with the terminal (SGR button
// events with motion), because relying on a host library's mouse layer means
// trusting whatever X10 negotiation that library happens to do.
// ---------------------------------------------------------------------------

const MOUSE_PROTOCOL_ON = "\x1b[?1002h\x1b[?1006h";
const MOUSE_PROTOCOL_OFF = "\x1b[?1006l\x1b[?1002l";

// Mouse escape reassembly: 0 idle, 1=ESC, 2=ESC[, 3=SGR digits.
let mState = 0;
/** Parsed SGR numbers so far, e.g. [0, null, 3, null, 2]. */
const mBuf: (number | null)[] = [];
/** Finished keys flushed out of an aborted escape, for the caller to drain. */
const mPending: number[] = [];

type MouseEvent = { mouse: true; btn: number; x: number; y: number; kind: "press" | "drag" | "release" };

/**
 * Reassemble one raw key byte from the terminal stream into a mouse event.
 * Returns a mouse event for a complete SGR escape, a key int to pass through
 * untouched, or null when the byte was absorbed into a partial escape. Keys
 * flushed from an aborted escape are queued in mPending.
 */
function feedMouse(b: number): MouseEvent | number | null {
  if (mState === 0) {
    if (b === 0x1b) {
      // Possible start of an escape sequence.
      mState = 1;
      return null;
    }
    return b;
  }
  if (mState === 1) {
    if (b === 0x5b) {
      // "["
      mState = 2;
      return null;
    }
    if (b === 0x4f) {
      // ESC O ... (SS3): treat like a CSI below for the arrow letters.
      mState = 2;
      mBuf.push(null);
      return null;
    }
    mState = 0; // ESC + non-[ : forward the ESC first, then the key.
    mPending.push(b);
    return 0x1b;
  }
  if (mState === 2) {
    // Saw ESC[ or ESC O.
    if (mBuf.length && mBuf[mBuf.length - 1] === null) mBuf.pop(); // SS3 marker
    if (b === 0x3c) {
      // "<" -- this is a mouse escape.
      mState = 3;
      return null;
    }
    // A key sequence, not a mouse escape: map the final byte to the key.
    mState = 0;
    const arrow: Record<number, number> = {
      0x41: KEY_UP,
      0x42: KEY_DOWN,
      0x43: KEY_RIGHT,
      0x44: KEY_LEFT,
    };
    const mapped = arrow[b];
    if (mapped !== undefined) return mapped;
    // Unknown sequence: flush ESC[ plus this byte for the caller to re-handle.
    mPending.push(0x5b, b);
    return 0x1b;
  }
  // State 3: SGR mouse digits, e.g. ESC[<0;12;5M.
  if (b === 0x4d || b === 0x6d) {
    // "M" / "m"
    const nums = mBuf.filter((n): n is number => n !== null);
    mBuf.length = 0;
    mState = 0;
    if (nums.length !== 3) return null;
    const [btn, sx, sy] = nums;
    if (btn & 0x40 || (btn & 3) !== 0) return null; // wheel / right / middle
    let kind: MouseEvent["kind"];
    if (b === 0x6d) kind = "release";
    else if (btn & 0x20) kind = "drag"; // motion while button 1 is held
    else kind = "press";
    return { mouse: true, btn, x: sx, y: sy, kind };
  }
  if (b >= 0x30 && b <= 0x39) {
    const digit = b - 0x30;
    if (!mBuf.length || mBuf[mBuf.length - 1] === null) mBuf.push(digit);
    else mBuf[mBuf.length - 1] = (mBuf[mBuf.length - 1] as number) * 10 + digit;
  } else if (b === 0x3b) {
    // ";"
    mBuf.push(null);
  } else {
    mBuf.length = 0;
    mState = 0; // garbage mid-escape: drop it
  }
  return null;
}

function mouseFlushDangling(): void {
  // Idle with a half-typed escape: a lone ESC was a real key (quit), and a
  // mid-SGR stream is terminal garbage to be dropped.
  if (mState === 1) mPending.push(0x1b);
  mState = 0;
  mBuf.length = 0;
}

function extractSelection(lines: string[], x0: number, x1: number): string {
  // Text under a selection: one column slice per row (`lines` are rendered
  // rows, trailing spaces allowed), rstrip'd, blank tail rows dropped.
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  const parts = lines.map((line) => (lo < line.length ? line.slice(lo, hi + 1) : ""));
  const stripped = parts.map((p) => p.replace(/\s+$/, ""));
  while (stripped.length && stripped[stripped.length - 1] === "") stripped.pop();
  return stripped.join("\n");
}

function copyText(text: string): boolean {
  // System clipboard via pbcopy; OSC 52 escape fallback; false when both fail.
  if (process.platform === "darwin") {
    try {
      const r = spawnSync("pbcopy", { input: text, timeout: 2000, maxBuffer: 1 << 20 });
      if (!r.error) return true;
    } catch {
      // No pbcopy (or it hung): fall through to OSC 52.
    }
  }
  try {
    const payload = Buffer.from(text, "utf8").toString("base64");
    process.stdout.write(`\x1b]52;c;${payload}\x07`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Renderer -- raw SGR into the terminal. The last frame's plain text is kept
// in `grid` (padded to width) so selection extraction reads our own output.
// ---------------------------------------------------------------------------

interface Seg {
  sgr: string;
  text: string;
}

const CLEAR = "\x1b[2J\x1b[H";
const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";

let grid: string[] = [];
let selStart: [number, number] | null = null;
let selEnd: [number, number] | null = null;
type Toast = { text: string; deadline: number };
let toast: Toast | null = null;
let needDraw = true;

/** Accessor so callers can read the toast without inheriting TS's control-flow
 * null-narrowing from earlier `toast = null` resets in the same function. */
function curToast(): Toast | null {
  return toast;
}
const BOTTOM_ROWS = 4;

function selActive(): boolean {
  return selStart !== null || selEnd !== null;
}

/** One rendered row: updates the extraction grid and returns the SGR text. */
function emitRow(y: number, width: number, segs: Seg[]): string {
  let plain = "";
  for (const s of segs) plain += s.text;
  if (plain.length < width) plain += " ".repeat(width - plain.length);
  grid[y] = plain;

  if (selStart && selEnd) {
    const [y0, y1] = [Math.min(selStart[0], selEnd[0]), Math.max(selStart[0], selEnd[0])];
    if (y >= y0 && y <= y1) {
      const [x0, x1] = [Math.min(selStart[1], selEnd[1]), Math.max(selStart[1], selEnd[1])];
      let out = "";
      let x = 0;
      for (const s of segs) {
        const end = x + s.text.length - 1;
        if (end < x0 || x > x1) {
          out += s.sgr + s.text;
          x = end + 1;
          continue;
        }
        const i0 = Math.max(0, x0 - x);
        const i1 = Math.min(s.text.length - 1, x1 - x);
        if (i0 > 0) out += s.sgr + s.text.slice(0, i0);
        if (i0 <= i1) {
          out += "\x1b[0;7m" + s.sgr + s.text.slice(i0, i1 + 1) + "\x1b[0m" + s.sgr;
        }
        if (i1 + 1 < s.text.length) out += s.text.slice(i1 + 1);
        x = end + 1;
      }
      return out;
    }
  }
  let out = "";
  for (const s of segs) out += s.sgr + s.text;
  return out;
}

/**
 * One button-1 frame: "press" starts, "drag" extends, "release" copies and
 * toasts. Returns true once a copy has run, so the caller redraws the overlay
 * away. `copier` is injectable for tests; the default never raises.
 */
function mouseEvent(
  y: number,
  x: number,
  kind: "press" | "drag" | "release",
  copier: (text: string) => boolean = copyText,
): boolean {
  const w = process.stdout.columns || 80;
  const h = process.stdout.rows || 24;
  y = Math.max(0, Math.min(y, h - 1));
  x = Math.max(0, Math.min(x, w - 1));

  if (kind === "press") {
    if (selStart === null) selStart = [y, x];
    selEnd = [y, x]; // repeating presses are drag continuations
    needDraw = true;
    return false;
  }
  if (selStart === null || selEnd === null) return false;

  selEnd = [y, x];
  if (kind === "drag") {
    needDraw = true;
    return false;
  }

  const [y0, y1] = [Math.min(selStart[0], selEnd[0]), Math.max(selStart[0], selEnd[0])];
  const lines = grid.slice(y0, y1 + 1);
  const text = extractSelection(lines, selStart[1], selEnd[1]);
  let ok = false;
  try {
    ok = Boolean(copier(text));
  } catch {
    ok = false;
  }
  toast = {
    text: ok ? `Copied ${text.length} characters` : "Copy failed",
    deadline: Date.now() + 2500,
  };
  selStart = selEnd = null;
  return true;
}

// Static body: legend of the surface, and the drag-to-copy target. Drawn from
// row 0 until the status area; rows are clipped in terminals that are too
// short for the whole legend (the size guard only requires h >= 9).
const BODY: Seg[][] = [
  [{ sgr: "\x1b[1m", text: "tui -- terminal UI surface" }],
  [],
  [{ sgr: "", text: "Bottom-up: tips, the CONTEXT meter, the USE | branch row," }],
  [{ sgr: "", text: "and the tui | cwd pair." }],
  [],
  [{ sgr: "", text: "Drag with button 1, then release, to copy the covered text." }],
  [{ sgr: "", text: "The toast in the bottom-right corner reports the character count." }],
  [],
  [{ sgr: "", text: "q or ESC quits; the terminal is restored cleanly." }],
];

function draw(app: App): void {
  const w = process.stdout.columns || 80;
  const h = process.stdout.rows || 24;
  if (h < 9 || w < 30) {
    process.stdout.write(CLEAR + "Terminal too small");
    needDraw = false;
    return;
  }

  const rows: string[] = [];
  grid = Array.from({ length: h }, () => " ".repeat(w));

  const add = (y: number, segs: Seg[]): void => {
    if (y < 0 || y >= h) return;
    rows[y] = emitRow(y, w, segs);
  };

  // Static body, clipped at the status area.
  const base = h - BOTTOM_ROWS;
  for (let y = 0; y < BODY.length && y < base; y++) add(y, BODY[y]);

  // Status area: model|cwd, USE|branch, the CONTEXT bar, tips.
  const pair0 = pairMath("tui".length, abbrevHome(app.cwd).length, w);
  add(base + 0, [
    { sgr: fg("text"), text: "tui".slice(0, pair0.clipped) },
    { sgr: "", text: " ".repeat(pair0.pad) },
    { sgr: fg("cwd"), text: abbrevHome(app.cwd) },
  ]);
  // USE shows placeholder usage/cost. Tokens are the CONTEXT window times
  // its fill, so the meter and the USE pair never contradict each other; a
  // real host would feed both via set_context().
  const branch = repoBranch(app.cwd);
  const usedTokens =
    app.contextPct === null ? 0 : Math.round((app.contextWindow * app.contextPct) / 100);
  const useText = `USE: ${fmtTokens(usedTokens)}/$0.00`;
  const pair1 = pairMath(useText.length, (branch ?? "").length, w);
  add(base + 1, [
    { sgr: fg("uselabel"), text: useText.slice(0, pair1.clipped) },
    { sgr: "", text: " ".repeat(pair1.pad) },
    { sgr: fg("branch"), text: (branch ?? "").slice(0, w) },
  ]);

  // CONTEXT bar: label, one dot per column, percentage, window.
  const bar = renderBar(w, app.contextPct, app.contextWindow);
  const barSegs: Seg[] = [{ sgr: fg("ctlabel"), text: bar.label }, { sgr: "", text: " " }];
  for (let i = 1; i <= bar.buckets; i++) {
    barSegs.push({ sgr: fg(bandOf(i, bar.pos1, bar.pos2, bar.filled)), text: "·" });
  }
  barSegs.push({ sgr: fg(usageColorKey(app.contextPct)), text: bar.pctStr });
  barSegs.push({ sgr: fg("muted"), text: bar.windowPart });
  add(base + 2, barSegs);

  // Tips row doubles as the transient status row; the toast overlays its
  // right end (Claude Code style), so the tip is clipped to make room.
  const now = Date.now();
  const tipNow = TIPS[app.tipIndex % TIPS.length];
  let tipSegs: Seg[];
  if (app.status) {
    tipSegs = [{ sgr: fg("golddim"), text: ("» " + app.status).slice(0, w - 1) }];
  } else {
    tipSegs = [
      { sgr: fg("gold"), text: "❯" },
      { sgr: fg("golddim"), text: tipNow.slice(0, w - 3) },
    ];
  }
  const tb = curToast();
  if (tb !== null && now >= tb.deadline) toast = null;
  if (curToast() !== null) {
    const t = (curToast() as Toast).text.slice(0, Math.max(0, w - 4));
    const tx = Math.max(0, w - t.length - 1);
    if (app.status) {
      tipSegs = [{ sgr: fg("golddim"), text: ("» " + app.status).slice(0, tx) }];
    } else {
      tipSegs = [
        { sgr: fg("gold"), text: "❯" },
        { sgr: fg("golddim"), text: tipNow.slice(0, Math.max(0, tx - 1)) },
      ];
    }
    tipSegs.push({ sgr: "\x1b[1m\x1b[0;7m", text: t });
  }
  add(base + 3, tipSegs);

  process.stdout.write(CLEAR + rows.join("\r\n"));
  needDraw = false;
}

// ---------------------------------------------------------------------------
// Run loop -- raw stdin, reassembled keys, timed redraws.
// ---------------------------------------------------------------------------

let exiting = false;
let tick: unknown;
let tipsTimer: unknown;

function exitApp(): void {
  if (exiting) return;
  exiting = true;
  if (tick !== undefined) clearInterval(tick);
  if (tipsTimer !== undefined) clearInterval(tipsTimer);
  try {
    process.stdout.write(MOUSE_PROTOCOL_OFF + CURSOR_SHOW + ALT_OFF + "\x1b[0m");
  } catch {
    // stdout may already be gone on shutdown.
  }
  try {
    process.stdin.setRawMode(false);
  } catch {
    // stdin may already be closed.
  }
  process.exit(0);
}

function run(app: App): void {
  tick = setInterval(() => {
    if (mState === 1) {
      mouseFlushDangling(); // a lone ESC is a real quit: hand it to the key path
      needDraw = true;
    }
    // Keys flushed by an aborted escape are drained here, too -- the stdin
    // handler never runs again while the app sits idle.
    while (mPending.length) handleKey(mPending.shift() as number);
    if (toast !== null && Date.now() >= toast.deadline) needDraw = true;
    if (needDraw) draw(app);
  }, 150);

  tipsTimer = setInterval(() => {
    if (!selActive() && toast === null) {
      app.tipIndex++;
      needDraw = true;
    }
  }, 5000);

  function handleKey(key: number): void {
    needDraw = true;
    // q / Q / ESC quit; everything else -- arrow keycodes, stray bytes -- is
    // deliberately ignored. The surface has no navigation.
    if (key === 0x71 || key === 0x51 || key === 0x1b) exitApp();
  }

  process.stdin.on("data", (chunk: Buffer) => {
    while (mPending.length) handleKey(mPending.shift() as number);
    for (const b of chunk) {
      const out = feedMouse(b);
      if (out === null) continue;
      if (typeof out === "object") {
        // SGR coordinates are 1-based.
        if (mouseEvent(Math.max(0, out.y - 1), Math.max(0, out.x - 1), out.kind)) {
          needDraw = true; // a copy ran: redraw the overlay away, show the toast
        }
        continue;
      }
      handleKey(out);
    }
    if (needDraw) draw(app);
  });

  process.stdout.on("resize", () => {
    needDraw = true;
  });

  process.on("SIGINT", exitApp);
  process.on("SIGTERM", exitApp);
  process.on("SIGTSTP", exitApp); // ctrl-Z: restore the terminal before suspending
  process.on("uncaughtException", exitApp);

  draw(app);
}

// ---------------------------------------------------------------------------
// Selftest -- the logic that can silently break, walked headlessly.
// ---------------------------------------------------------------------------

function selftest(): void {
  const app = new App();
  const check = (cond: boolean, label: string): void => {
    if (!cond) throw new Error(label);
  };

  const p = (l: number, r: number, w: number) => pairMath(l, r, w);
  check(p(20, 4, 30).clipped === 20, "fit_left unclipped");
  check(p(50, 4, 30).clipped === 24, "fit_left clipped");
  check(p(50, 4, 30).pad === 2, "pair pad clipped");
  check(p(3, 4, 30).clipped === 3 && p(3, 4, 30).pad === 23, "pair pad short left");
  check(bandOf(1, 2, 4, 10) === "green", "band green");
  check(bandOf(2, 2, 4, 10) === "marker1", "band marker1");
  check(bandOf(3, 2, 4, 10) === "amber", "band amber");
  check(bandOf(4, 2, 4, 10) === "marker2", "band marker2");
  check(bandOf(5, 2, 4, 6) === "orange", "band orange");
  check(bandOf(9, 2, 4, 6) === "empty", "band empty");
  check(usageColorKey(19) === "green", "usage green");
  check(usageColorKey(55) === "amber", "usage amber");
  check(usageColorKey(70) === "orange", "usage orange");
  check(usageColorKey(95) === "rose", "usage rose");
  check(usageColorKey(null) === "muted", "usage muted");

  // CONTEXT-bar geometry: buckets one column apart, percentage right after the
  // last bucket, and the whole row inside the terminal width.
  for (const [w, want] of [
    [120, 100],
    [100, 81],
    [76, 57],
    [40, 21],
  ] as [number, number][]) {
    const bar = renderBar(w, 19, 200_000);
    check(bar.buckets === want, `bucket count at w=${w}: ${bar.buckets}`);
    const total = bar.label.length + 1 + bar.buckets + bar.pctStr.length + bar.windowPart.length;
    check(total <= w, `bar row overflows at w=${w} (ends ${total})`);
    check(bar.pos1 === Math.floor(want / 3) && bar.pos2 === Math.floor((2 * want) / 3), "marker positions");
  }
  const unknown = renderBar(40, null, 0);
  check(unknown.pctStr === "?", "unknown pct rendered sanely");

  // -- select-to-copy rect over rendered rows --------------------------------

  const rows = ["P0422 Catalyst eff", "  below threshold  ", ""];
  check(extractSelection(rows, 0, 5) === "P0422\n  belo", "rect slice");
  check(extractSelection(rows, 2, 0) === "P04\n  b", "reversed x endpoints");
  check(extractSelection(["abcdef"], 0, 0) === "a", "single cell");
  check(extractSelection(["abcdef", " ", "x"], 0, 99) === "abcdef\n\nx", "blank middle kept");
  check(extractSelection(["   "], 0, 2) === "", "all-blank selection copies nothing");
  check(extractSelection([], 0, 3) === "", "empty rows");

  // -- gesture logic over a fake grid ---------------------------------------

  const savedGrid = grid;
  grid = ["> Powertrain", "  Clear all codes", "  Simulator x"];
  const savedSel = selStart;
  const savedToast = toast;
  selStart = null;
  selEnd = null;
  toast = null;
  const recorded: string[] = [];
  const stubCopy = (text: string): boolean => {
    recorded.push(text);
    return true;
  };
  try {
    // Drag across one row.
    check(mouseEvent(0, 3, "press", stubCopy) === false, "press opens a selection");
    check(selStart !== null && selStart[0] === 0 && selStart[1] === 3, "selection start set");
    check(mouseEvent(0, 13, "drag", stubCopy) === false, "drag extends");
    check(mouseEvent(0, 13, "release", stubCopy) === true, "release copies");
    check(recorded[0] === "owertrain", `1-row drag text: ${JSON.stringify(recorded[0])}`);
    const to1 = curToast();
    check(to1 !== null && to1.text === "Copied 9 characters", "toast text");
    check(selStart === null && selEnd === null, "selection reset after copy");

    // Drag up across three rows, reversed endpoints.
    recorded.length = 1;
    grid = ["> Powertrain", "  Clear all codes", "  Simulator x"];
    mouseEvent(2, 20, "press", stubCopy);
    mouseEvent(1, 5, "drag", stubCopy);
    mouseEvent(0, 3, "release", stubCopy);
    check(recorded[1] === "owertrain\nlear all codes\nimulator x", "reversed multi-row drag");
    const to2 = curToast();
    check(to2 !== null && to2.text === `Copied ${recorded[1].length} characters`, "multi-row toast");

    // Plain click copies its single cell.
    recorded.length = 2;
    grid = ["  Clear all codes"];
    mouseEvent(0, 2, "press", stubCopy);
    mouseEvent(0, 2, "release", stubCopy);
    check(recorded[2] === "C", "single-cell click");

    // Copy failure still resets state and says so honestly.
    const failing = (): boolean => {
      throw new Error("no clipboard");
    };
    mouseEvent(0, 1, "press", failing);
    mouseEvent(0, 1, "release", failing);
    const to3 = curToast();
    check(to3 !== null && to3.text === "Copy failed", "copy failure toast");
    check(selStart === null, "state reset on failure");
  } finally {
    grid = savedGrid;
    selStart = savedSel;
    selEnd = null;
    toast = savedToast;
  }

  // -- SGR mouse escape reassembly, driven byte by byte -----------------------

  const reset = (): void => {
    mState = 0;
    mBuf.length = 0;
    mPending.length = 0;
  };
  const sgr = (esc: number[]): MouseEvent | number | null => {
    reset();
    let out: MouseEvent | number | null = null;
    for (const b of esc) out = feedMouse(b);
    return out;
  };
  const isEvent = (
    esc: number[],
    kind: "press" | "drag" | "release",
    btn: number,
    x: number,
    y: number,
  ): boolean => {
    const ev = sgr(esc);
    return ev !== null && typeof ev === "object" && ev.btn === btn && ev.x === x && ev.y === y && ev.kind === kind;
  };

  check(isEvent([27, 91, 60, 48, 59, 53, 59, 55, 77], "press", 0, 5, 7), "SGR press");
  check(isEvent([27, 91, 60, 51, 50, 59, 49, 48, 59, 55, 77], "drag", 32, 10, 7), "SGR drag");
  check(isEvent([27, 91, 60, 48, 59, 49, 48, 59, 55, 109], "release", 0, 10, 7), "SGR release");
  check(isEvent([27, 91, 60, 48, 59, 49, 50, 51, 59, 52, 53, 77], "press", 0, 123, 45), "SGR big coords");
  check(isEvent([27, 91, 60, 51, 50, 59, 50, 48, 59, 54, 77], "drag", 32, 20, 6), "SGR drag 2");
  check(sgr([27, 91, 60, 54, 52, 59, 53, 59, 54, 77]) === null, "SGR wheel ignored");
  check(sgr([27, 91, 60, 50, 59, 53, 59, 54, 77]) === null, "SGR right button ignored");
  check(sgr([27, 91, 60, 48, 77]) === null, "SGR malformed ignored");
  // A lone ESC stays pending until the next byte decides its fate.
  reset();
  check(feedMouse(27) === null, "ESC absorbed");
  check(feedMouse("k".charCodeAt(0)) === 27 && mPending.length === 1 && mPending[0] === "k".charCodeAt(0), "ESC+k");
  // ESC[ then a non-mouse key sequence: arrows map to key codes (the caller
  // ignores them -- there is no navigation -- but the sequence is absorbed).
  const arrow = (final: number): number | null => {
    reset();
    feedMouse(27);
    feedMouse(0x5b);
    const out = feedMouse(final);
    return typeof out === "object" ? null : out;
  };
  check(arrow(0x41) === KEY_UP, "ESC[A is up");
  check(arrow(0x42) === KEY_DOWN, "ESC[B is down");
  check(arrow(0x43) === KEY_RIGHT, "ESC[C is right");
  check(arrow(0x44) === KEY_LEFT, "ESC[D is left");
  // ESC[< that never terminates: garbage dropped, nothing pending.
  reset();
  check(feedMouse(27) === null && feedMouse(0x5b) === null && feedMouse(0x3c) === null, "mouse prefix opening");
  check(feedMouse(0x3a) === null && mState === 0 && mPending.length === 0, "garbage mid-mouse dropped");

  // -- formatters --------------------------------------------------------------

  check(fmtTokens(999) === "999", "tok 999");
  check(fmtTokens(200_000) === "200k", "tok 200k");
  check(fmtTokens(1_234_567) === "1.2M", "tok 1.2M");
  check(abbrevHome(os.homedir()) === "~", "home abbrev");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tui-branch-"));
  try {
    const git = path.join(tmp, ".git");
    fs.mkdirSync(git);
    fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/experiment\n", "utf8");
    check(repoBranch(tmp) === "experiment", "branch read");
    fs.writeFileSync(path.join(git, "HEAD"), "9f2a1b3c4d\n", "utf8");
    check(repoBranch(tmp) === "detached", "detached read");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  check(repoBranch(os.tmpdir()) === null, "no repo -> null");

  // -- context plumbing ----------------------------------------------------------

  app.setContext("nonsense");
  check(app.contextPct === 19, "bad pct leaves bar alone");
  app.setContext(42, 100_000);
  check(app.contextPct === 42 && app.contextWindow === 100_000, "good pct+window");
  app.setContext(-5);
  check(app.contextPct === 0, "pct clamped low");
  app.setContext(500);
  check(app.contextPct === 100, "pct clamped high");

  process.stdout.write("tui selftest OK\n");
}

// ---------------------------------------------------------------------------

function main(): void {
  if (process.argv.includes("--selftest")) {
    selftest();
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write("tui needs a terminal; run `bun tui.ts --selftest` headless.\n");
    process.exit(1);
  }
  process.stdin.setRawMode(true);
  process.stdout.write(ALT_ON + CURSOR_HIDE + MOUSE_PROTOCOL_ON);
  const app = new App();
  run(app);
}

main();
