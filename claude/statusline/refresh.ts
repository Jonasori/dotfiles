#!/usr/bin/env bun
/**
 * refresh.ts — keeps the status line's machine-wide data fresh, for every session.
 *
 * Account label, location, weather, quote and the usage fallback are the same in
 * every open session, so they live in one file ($CACHE_DIR/shared.json) that
 * statusline.ts only reads. When an item is due, the renderer spawns this script
 * detached with the due items as arguments and renders from what is already on
 * disk; a lock keeps it to one refresher at a time across all sessions. Network
 * calls use fetch, so the only process this ever launches is `security`, for the
 * keychain token.
 *
 *   bun refresh.ts account location weather quote usage   refresh what is due
 *   bun refresh.ts --selftest                             decision logic, no network
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const HOME = process.env.HOME ?? "";

// Claude Code does not shell-expand values in settings.json env{}, so an override
// may arrive as the literal string "$HOME/...".
function expandHome(p: string): string {
  for (const pre of ["${HOME}", "$HOME", "~"]) if (p.startsWith(pre)) return HOME + p.slice(pre.length);
  return p;
}

export const CACHE_DIR = expandHome(
  process.env.STATUSLINE_CACHE_DIR || `${process.env.XDG_CACHE_HOME || `${HOME}/.cache`}/claude-statusline`,
);
mkdirSync(CACHE_DIR, { recursive: true });
const SHARED = `${CACHE_DIR}/shared.json`;
const LOCK = `${CACHE_DIR}/refresh.lock`;
const CLAUDE_JSON = `${HOME}/.claude.json`;

export type Item = "account" | "location" | "weather" | "quote" | "usage";
const ITEMS: Item[] = ["account", "location", "weather", "quote", "usage"];

export interface Window { utilization?: number; resets_at?: string | number }
export interface UsageData {
  enterprise_credits?: { utilization: number; resets_at: number; status: string };
  five_hour?: Window;
  seven_day?: Window;
  extra_usage?: { is_enabled?: boolean; monthly_limit?: number; used_credits?: number };
}

export interface Shared {
  // `profile` is .oauthAccount as last read, `seen` the ~/.claude.json mtime (ms)
  // it came from, `at` when the keychain token was last checked against it.
  account?: { label: string; sub: string; profile: string; seen: number; at: number };
  location?: { city: string; region: string; cc: string; lat: number; lon: number; at: number };
  weather?: { text: string; at: number };
  quote?: { text: string; author: string; at: number };
  usage?: { data: UsageData; at: number };
  tried?: Partial<Record<Item, number>>;
}

export function readShared(): Shared {
  if (!existsSync(SHARED)) return {};
  // Written by rename, so a partial file is not expected; a corrupt one is
  // treated as empty and rewritten by the next refresh.
  try { return JSON.parse(readFileSync(SHARED, "utf8")); } catch { return {}; }
}

const mtimeMs = (p: string): number => statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0;

// .oauthAccount as a string. ~/.claude.json is rewritten every few seconds for
// unrelated reasons, so it is parsed only when its mtime differs from what the
// cached profile came from, and the label is redone only when the profile itself
// differs. A file caught mid-write reads as unchanged.
export function readProfile(s: Shared): { profile: string; seen: number; acct: object } {
  const seen = mtimeMs(CLAUDE_JSON);
  const cached = s.account;
  if (cached && seen === cached.seen) return { profile: cached.profile, seen, acct: JSON.parse(cached.profile) };
  try {
    const acct = JSON.parse(readFileSync(CLAUDE_JSON, "utf8")).oauthAccount ?? {};
    return { profile: JSON.stringify(acct), seen, acct };
  } catch {
    return { profile: cached?.profile ?? "{}", seen: cached?.seen ?? 0, acct: JSON.parse(cached?.profile ?? "{}") };
  }
}

// ─── Due rules ───────────────────────────────────────────────────────────────
// Location 1h and weather 15m change slowly. The keyless quote endpoint allows
// 5 req / 30s, so 15m unless a key is configured. A failed fetch leaves the item
// stale, so every item also waits RETRY_SEC after an attempt before trying again.
const TTL = { location: 3600, weather: 900, quote: process.env.ZENQUOTES_API_KEY ? 60 : 900 };
const RETRY_SEC = 60;
// The token is re-checked against the cached profile on this clock even when
// ~/.claude.json is unchanged: a /login swaps the token first.
const ACCOUNT_TTL = 300;
// /api/oauth/usage answers 429 after ~5 requests, so 15m. The enterprise probe is
// an ordinary billed completion (~8 tokens) and the credit meter moves while you
// work, so 1m. Either way the clock governs attempts, not just successes: a probe
// that keeps failing would otherwise fire on every refresh, all day.
const USAGE_TTL = { personal: 900, enterprise: 60 };
const ENTERPRISE_PROBE_MODEL = "claude-haiku-4-5-20251001";

export type Kind = "enterprise" | "personal" | "unknown";
export const accountKind = (sub: string): Kind => (sub === "enterprise" ? "enterprise" : sub ? "personal" : "unknown");
const usageKind = (d?: UsageData): Kind | "none" =>
  d?.enterprise_credits ? "enterprise" : d?.five_hour ? "personal" : "none";

// Personal accounts report 5h/7d windows; enterprise seats report one org credit
// meter. A cache left over from the other account is refetched, never rendered:
// the wrong account's numbers are worse than none. An unknown account kind (no
// readable token) accepts whatever shape is there.
export function usageShapeOk(s: Shared, kind: Kind): boolean {
  const k = usageKind(s.usage?.data);
  return k !== "none" && (kind === "unknown" || kind === k);
}

// STATUSLINE_ACCOUNT replaces the derived label; ACCOUNT_SUB then stands in for
// the token's subscription type.
export function accountSub(s: Shared): string {
  return process.env.STATUSLINE_ACCOUNT ? (process.env.ACCOUNT_SUB ?? "") : (s.account?.sub ?? "");
}

export function isDue(item: Item, s: Shared, now: number, profile: () => string = () => readProfile(s).profile): boolean {
  const since = now - (s.tried?.[item] ?? 0);
  switch (item) {
    case "account":
      return !s.account || now - s.account.at >= ACCOUNT_TTL || profile() !== s.account.profile;
    case "usage": {
      const acct = accountKind(accountSub(s));
      const kind = acct === "unknown" ? usageKind(s.usage?.data) : acct;
      const ttl = kind === "enterprise" ? USAGE_TTL.enterprise : USAGE_TTL.personal;
      const age = s.usage ? now - s.usage.at : Infinity;
      return since >= ttl && (age > ttl || !usageShapeOk(s, acct));
    }
    default: {
      const at = s[item]?.at;
      return since >= RETRY_SEC && (at === undefined || now - at > TTL[item]);
    }
  }
}

// Every refresh step is bounded well under this (fetches 2-4s, keychain 5s), so
// an older lock belongs to a holder that died.
export function lockHeld(now: number): boolean {
  const at = mtimeMs(LOCK);
  return at > 0 && now - at / 1000 < 60;
}

// ─── Account label ───────────────────────────────────────────────────────────
// Leads the header: the one thing the rest of the footer cannot tell you, and
// getting it wrong means running work against the wrong org's limit.
//
// The name comes from ~/.claude.json .oauthAccount: the org name for enterprise,
// the bare email for a personal login (whose org is auto-named "<email>'s
// Organization"). But .oauthAccount is a cached profile blob, observed holding a
// personal Max profile for hours while the keychain token was enterprise. So it is
// cross-checked against the token's subscriptionType, and on disagreement the
// label is the token's type rather than a name we cannot stand behind.
export function accountLabel(acct: { organizationName?: string; emailAddress?: string; organizationType?: string }, tok: string): string {
  const org = acct.organizationName ?? "";
  const email = acct.emailAddress ?? "";
  const name = org.length > 0 && org !== `${email}'s Organization` ? org : email;
  if (tok.length === 0) return name;
  return (tok === "enterprise") === (acct.organizationType === "claude_enterprise") ? name : tok;
}

interface Creds { token: string; sub: string }
let creds: Creds | undefined;
function readCreds(): Creds {
  if (creds) return creds;
  let raw = "";
  if (process.platform === "darwin") {
    // Bounded: a locked keychain waits on an unlock dialog indefinitely.
    raw = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { stderr: "ignore", timeout: 5000 }).stdout.toString();
  } else if (existsSync(`${HOME}/.claude/.credentials.json`)) {
    raw = readFileSync(`${HOME}/.claude/.credentials.json`, "utf8");
  }
  let o: { accessToken?: string; subscriptionType?: string } = {};
  try { o = JSON.parse(raw).claudeAiOauth ?? {}; } catch { /* unreadable token: no cross-check */ }
  // Stripped to identifier characters: it is rendered and compared, never trusted.
  creds = { token: o.accessToken ?? "", sub: (o.subscriptionType ?? "").replace(/[^A-Za-z0-9_]/g, "") };
  return creds;
}

function refreshAccount(s: Shared, now: number): void {
  const { profile, seen, acct } = readProfile(s);
  const { sub } = readCreds();
  s.account = { label: accountLabel(acct, sub), sub, profile, seen, at: now };
}

// ─── Network items ───────────────────────────────────────────────────────────
async function getJson(url: string, ms: number, init: RequestInit = {}): Promise<any> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    return await r.json();
  } catch {
    return undefined; // offline, timeout, or a non-JSON error page: retried later
  }
}

async function refreshLocation(s: Shared, now: number): Promise<void> {
  const r = await getJson("http://ip-api.com/json/?fields=city,region,regionName,country,countryCode,lat,lon", 2000);
  if (r?.city) s.location = { city: r.city, region: r.region ?? r.regionName ?? "", cc: r.countryCode ?? "", lat: r.lat, lon: r.lon, at: now };
}

function weatherIcon(code: number, isDay: boolean): string {
  if (code === 0) return isDay ? "☀️" : "🌙";
  if (code === 1) return isDay ? "🌤️" : "🌙";
  if (code === 2) return "⛅";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 56, 57].includes(code)) return "🌦️";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "🌨️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌡️";
}

async function refreshWeather(s: Shared, now: number): Promise<void> {
  const unit = process.env.STATUSLINE_TEMP_UNIT === "celsius" ? "celsius" : "fahrenheit";
  const lat = s.location?.lat ?? 37.7749;
  const lon = s.location?.lon ?? -122.4194;
  const r = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day&temperature_unit=${unit}`,
    3000,
  );
  const c = r?.current;
  if (!c) return;
  s.weather = { text: `${weatherIcon(c.weather_code, c.is_day !== 0)} ${Math.round(c.temperature_2m)}°${unit === "celsius" ? "C" : "F"}`, at: now };
}

async function refreshQuote(s: Shared, now: number): Promise<void> {
  const key = process.env.ZENQUOTES_API_KEY;
  const r = await getJson(`https://zenquotes.io/api/random${key ? `/${key}` : ""}`, 2000);
  const q = r?.[0];
  // A 429 comes back as a "quote" attributed to zenquotes.io; never cache it.
  if (typeof q?.q === "string" && typeof q.a === "string" && q.q.length < 80 && q.a !== "zenquotes.io") {
    s.quote = { text: q.q, author: q.a, at: now };
  }
}

// Enterprise seats have no 5h/7d windows. Their only usage figure is the org
// credit meter, reported solely on the anthropic-ratelimit-unified-* headers of a
// /v1/messages call: /api/oauth/usage answers 429 to these tokens, and no
// read-only endpoint carries the headers. So the probe buys the cheapest
// completion there is to read them.
async function refreshUsage(s: Shared, now: number): Promise<void> {
  const { token, sub } = readCreds();
  if (!token) return;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20" };
  if (sub === "enterprise") {
    let h: Headers;
    try {
      h = (await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { ...auth, "anthropic-version": "2023-06-01", "x-app": "cli", "User-Agent": `claude-cli/${process.env.STATUSLINE_CC_VERSION || "unknown"} (external, cli)` },
        body: JSON.stringify({ model: ENTERPRISE_PROBE_MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(4000),
      })).headers;
    } catch {
      return;
    }
    const pct = h.get("anthropic-ratelimit-unified-overage-utilization");
    if (pct === null) return;
    s.usage = {
      data: { enterprise_credits: {
        utilization: Number(pct),
        resets_at: Number(h.get("anthropic-ratelimit-unified-overage-reset") ?? 0),
        status: h.get("anthropic-ratelimit-unified-overage-status") ?? "",
      } },
      at: now,
    };
  } else {
    const r = await getJson("https://api.anthropic.com/api/oauth/usage", 3000, { headers: auth });
    if (r?.five_hour) s.usage = { data: r, at: now };
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
// The lock holds the holder's pid, so a holder can only ever remove its own lock.
function takeLock(now: number): boolean {
  if (mtimeMs(LOCK) > 0 && !lockHeld(now)) unlinkSync(LOCK); // holder died mid-refresh
  try {
    const fd = openSync(LOCK, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

function releaseLock(): void {
  if (existsSync(LOCK) && readFileSync(LOCK, "utf8") === String(process.pid)) unlinkSync(LOCK);
}

async function main(items: Item[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (!takeLock(now)) return;
  try {
    const s = readShared();
    const due = items.filter((i) => isDue(i, s, now));
    s.tried = { ...s.tried };
    for (const i of due) s.tried[i] = now;
    const has = (i: Item) => due.includes(i);
    if (has("account")) refreshAccount(s, now);
    await Promise.all([
      (async () => {
        if (has("location")) await refreshLocation(s, now);
        if (has("weather")) await refreshWeather(s, now); // after location: it needs the coordinates
      })(),
      has("quote") && refreshQuote(s, now),
      has("usage") && refreshUsage(s, now),
    ]);
    writeFileSync(`${SHARED}.${process.pid}`, JSON.stringify(s));
    renameSync(`${SHARED}.${process.pid}`, SHARED);
  } finally {
    releaseLock();
  }
}

function selftest(): void {
  const eq = (label: string, got: unknown, want: unknown) => {
    if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  const ent = { emailAddress: "employee@example.com", organizationName: "Example Corp", organizationType: "claude_enterprise" };
  const per = { emailAddress: "person@example.net", organizationName: "person@example.net's Organization", organizationType: "claude_max" };
  eq("agreeing enterprise → org name", accountLabel(ent, "enterprise"), "Example Corp");
  eq("agreeing personal → bare email", accountLabel(per, "max"), "person@example.net");
  eq("token enterprise, stale personal profile → no name", accountLabel(per, "enterprise"), "enterprise");
  eq("token personal, stale enterprise profile → no name", accountLabel(ent, "max"), "max");
  eq("no token → falls back to profile", accountLabel(ent, ""), "Example Corp");

  const now = 1_000_000;
  const entUsage = { enterprise_credits: { utilization: 0.95, resets_at: 0, status: "" } };
  const perUsage = { five_hour: { utilization: 42 } };
  const acct = (sub: string) => ({ label: "x", sub, profile: "{}", seen: 0, at: now });
  const same = () => "{}";
  // Ten failing refreshes, two seconds apart, buy one probe.
  const s: Shared = { account: acct("enterprise"), usage: { data: entUsage, at: now - 120 } };
  let probes = 0;
  for (let t = now; t < now + 20; t += 2) {
    if (isDue("usage", s, t, same)) { probes++; s.tried = { usage: t }; }
  }
  eq("ten failing refreshes → one attempt", probes, 1);
  eq("enterprise retries after its 60s clock", isDue("usage", s, now + 61, same), true);
  eq("fresh enterprise cache is not due", isDue("usage", { account: acct("enterprise"), usage: { data: entUsage, at: now - 10 } }, now, same), false);
  eq("personal cache on enterprise account is refetched", isDue("usage", { account: acct("enterprise"), usage: { data: perUsage, at: now } }, now, same), true);
  eq("personal cache on enterprise account is not shown", usageShapeOk({ usage: { data: perUsage, at: now } }, "enterprise"), false);
  eq("enterprise cache on personal account is not shown", usageShapeOk({ usage: { data: entUsage, at: now } }, "personal"), false);
  eq("unknown account accepts either shape", usageShapeOk({ usage: { data: perUsage, at: now } }, "unknown"), true);
  eq("account due when the profile changes", isDue("account", { account: acct("max") }, now, () => '{"emailAddress":"b"}'), true);
  eq("account not due when the profile is unchanged", isDue("account", { account: acct("max") }, now + 10, same), false);
  eq("account due on its clock regardless", isDue("account", { account: acct("max") }, now + 300, same), true);
  eq("missing location is due", isDue("location", {}, now, same), true);
  eq("failed location waits before retrying", isDue("location", { tried: { location: now - 30 } }, now, same), false);
  eq("stale weather is due", isDue("weather", { weather: { text: "", at: now - 901 } }, now, same), true);
}

if (import.meta.main) {
  if (process.argv[2] === "--selftest") {
    selftest();
    console.log("refresh selftest ok");
  } else {
    const items = process.argv.slice(2) as Item[];
    for (const i of items) if (!ITEMS.includes(i)) throw new Error(`unknown item: ${i}`);
    await main(items);
  }
}
