/**
 * work.ts — how much a session has done, and what it is called.
 *
 * Counts days with a prompt, human prompts (typed, or queued mid-turn as an
 * attachment), compactions, and tool calls including every subagent's. Also
 * tracks the session title, carried in the transcript as two kinds of record:
 *   {"type":"custom-title","customTitle":"..."}  set by /rename
 *   {"type":"ai-title","aiTitle":"..."}          auto-generated default
 * A rename does not stop ai-title records being appended, so a custom title
 * always wins regardless of position.
 *
 * A long session's transcripts run to hundreds of MB, so each refresh reads only
 * the complete lines appended since the last one. Counts are kept as sets of ids,
 * so a fork's transcript repeating its parent's tool calls counts once.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Work { days: number; prompts: number; compacts: number; tools: number; title: string }

interface State {
  offsets: Record<string, number>;
  tools: string[];
  compacts: string[];
  prompts: Record<string, string>; // uuid → local day
  custom: string;
  ai: string;
}

const TOOL = '"type":"tool_use","id":"toolu_';
const MAIN_PATTERNS = [TOOL, '"origin":{"kind":"human"}', '"subtype":"compact_boundary"', '"type":"custom-title"', '"type":"ai-title"'];
const CHUNK = 32 << 20;

// Calls `line` for each complete line in [from, size) and returns the offset just
// past the last newline, so a line caught mid-write is read whole next time.
function readLines(path: string, from: number, size: number, line: (l: string) => void): number {
  const fd = openSync(path, "r");
  try {
    let pos = from;
    let chunk = CHUNK;
    while (pos < size) {
      const buf = Buffer.allocUnsafe(Math.min(chunk, size - pos));
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break; // shrank since the stat; the next refresh sees the new size
      const end = buf.lastIndexOf(10, n - 1);
      if (end < 0) {
        if (n < buf.length || pos + n >= size) break; // trailing partial line
        chunk *= 2; // a single line longer than the chunk
        continue;
      }
      for (const l of buf.toString("utf8", 0, end).split("\n")) line(l);
      pos += end + 1;
      chunk = CHUNK;
    }
    return pos;
  } finally {
    closeSync(fd);
  }
}

export function sessionWork(transcript: string, sessionId: string, cacheDir: string, tz: string): Work {
  const dir = join(cacheDir, "work", sessionId);
  const statePath = join(dir, "state.json");
  let st: State = { offsets: {}, tools: [], compacts: [], prompts: {}, custom: "", ai: "" };
  if (existsSync(statePath)) {
    try { st = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* re-read from the start */ }
  }
  const tools = new Set(st.tools);
  const compacts = new Set(st.compacts);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });

  const subDir = join(transcript.replace(/\.jsonl$/, ""), "subagents");
  const files = [transcript];
  if (existsSync(subDir)) for (const f of readdirSync(subDir)) if (f.endsWith(".jsonl")) files.push(join(subDir, f));

  let changed = false;
  for (const path of files) {
    const size = statSync(path).size;
    let from = st.offsets[path] ?? 0;
    if (size === from) continue;
    if (size < from) from = 0; // rewritten; the sets absorb the re-read
    const isMain = path === transcript;
    st.offsets[path] = readLines(path, from, size, (l) => {
      if (!(isMain ? MAIN_PATTERNS.some((p) => l.includes(p)) : l.includes(TOOL))) return;
      let o: any;
      try { o = JSON.parse(l); } catch { return; }
      if (o.type === "assistant") {
        for (const c of o.message?.content ?? []) if (c?.type === "tool_use") tools.add(c.id);
      } else if (!isMain) {
        return;
      } else if (o.subtype === "compact_boundary") {
        compacts.add(o.uuid);
      } else if ((o.origin?.kind ?? o.attachment?.origin?.kind) === "human") {
        const t = new Date(`${String(o.timestamp).slice(0, 19)}Z`);
        if (!Number.isNaN(t.getTime())) st.prompts[o.uuid] = day.format(t);
      } else if (o.type === "custom-title" && o.customTitle) {
        st.custom = o.customTitle;
      } else if (o.type === "ai-title" && o.aiTitle) {
        st.ai = o.aiTitle;
      }
    });
    changed = true;
  }

  if (changed) {
    st.tools = [...tools];
    st.compacts = [...compacts];
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${statePath}.${process.pid}`, JSON.stringify(st));
    renameSync(`${statePath}.${process.pid}`, statePath);
  }
  const days = new Set(Object.values(st.prompts));
  return { days: days.size, prompts: Object.keys(st.prompts).length, compacts: compacts.size, tools: tools.size, title: st.custom || st.ai };
}
