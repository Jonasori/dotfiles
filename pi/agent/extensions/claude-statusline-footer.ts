/**
 * claude-statusline-footer.ts
 *
 * Replaces pi's default footer with a statusline styled after the Claude Code
 * statusline (~/dotfiles/claude/statusline/statusline.sh). The status area is
 * a stack of four rows; the top two pair a left and a right column so related
 * metadata shares one line instead of each owning a line:
 *
 *   gemini-flash-latest · high · 2 providers  ~/projects/example  <- model | cwd
 *   USE: ↑14k ↓5.1k R90k W2.3k CH68.5% $0.046                       main  <- USE | branch
 *   CONTEXT: ⛁⛁…⛁ 19%/200k · #ca5b66b5 · 89 msgs                          <- context + session
 *   ❯ Ctrl+Shift+E — sharpen your prompt before sending ┆ auto · xhigh      <- tips + ext status
 *
 * The model label carries muted metadata when it means something: the live
 * provider count (only when >1, so a provider dropping out is visible) and the
 * Ctrl+P cycle size (only when models are scoped). The session tag on the
 * CONTEXT row is the tail-8 of the session id plus the branch's message count.
 * The bottom row shows the LIVE output of pi's suggestions loop: footer-tips.ts
 * publishes the current tip under the "tips" status; any OTHER extension
 * status is appended after it (auto-reasoning publishes "auto · <level>"
 * while an agent-elevated thinking level is live). pi-lens's LSP status
 * ("pi-lens-lsp") is the one thing filtered out, and its below-editor
 * diagnostics widget is disabled via ~/.pi-lens/config.json -> widget.visible
 * = false, or /lens-widget-toggle.
 *
 * cwd and branch never get a line to themselves: model pairs with cwd, USE
 * stats pair with the branch. When a pair doesn't fit, the right side keeps at
 * most half the width (min 24 cols) and the left side truncates into what is
 * left, so neither side is ever dropped entirely. USE is always shown (it
 * carries the $ cost, so the "USE/cost" slot and the branch share row 2).
 *
 * Palette is ported verbatim from statusline.sh: slate structural colors,
 * sky/blue git colors, indigo context colors, brown/orange usage colors, gold
 * quote colors. The CONTEXT bar keeps the reference's 1/3 (orange) and 2/3
 * (dark-red) threshold markers, the green→orange→dark-red banding, and is
 * capped at 60 buckets.
 *
 * Responsive modes: full/standard (>=70 cols) render all four rows; compact
 * (<70) collapses to inline `model │ ~/cwd (branch)` + a mini pct + the tip.
 *
 * Env:
 *   CLAUDE_STATUSLINE_FOOTER_OFF=1  -> keep pi's default footer
 *   CLAUDE_STATUSLINE_TIP_TICK_MS    -> poll for tip rotation (default 5000)
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const DISABLED = process.env.CLAUDE_STATUSLINE_FOOTER_OFF === "1";
const TIP_TICK_MS = Math.max(1000, Number(process.env.CLAUDE_STATUSLINE_TIP_TICK_MS ?? "5000"));
const MAX_BAR_BUCKETS = 60;

// ─────────────────────────────────────────────────────────────────────────────
// COLOR PALETTE (ported from ~/dotfiles/claude/statusline/statusline.sh)
// ─────────────────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
/** ANSI 24-bit foreground. */
const c = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`;

// Structural (chrome, labels, separators)
const SLATE_300 = c(203, 213, 225); // light text/values
const SLATE_400 = c(148, 163, 184); // labels
const SLATE_500 = c(100, 116, 139); // muted text
const SLATE_600 = c(71, 85, 105); // separators

// Semantic
const EMERALD = c(74, 222, 128); // positive/success
const ROSE = c(251, 113, 133); // error/negative

// Git (sky/blue)
const GIT_PRIMARY = c(56, 189, 248);

// Context (indigo)
const CTX_PRIMARY = c(129, 140, 248);
const CTX_SECONDARY = c(165, 180, 252);
const CTX_BUCKET_EMPTY = c(75, 82, 95);

// Usage (brown/orange)
const USAGE_PRIMARY = c(194, 139, 62);
const USAGE_LABEL = c(168, 113, 50);
const USAGE_EXTRA = c(140, 90, 60);

// Quote (gold) — the suggestions row inherits the quote slot
const QUOTE_PRIMARY = c(252, 211, 77);
const QUOTE_AUTHOR = c(180, 140, 60);

// Context bar bands + threshold markers
const BAND_GREEN = c(74, 222, 128);
const BAND_ORANGE = c(251, 146, 60);
const BAND_AMBER = c(251, 191, 36);
const BAND_DARK_RED = c(180, 40, 40);
const BUCKET = "⛁";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Color for a usage percentage: emerald → amber → orange → rose. */
function usageColor(pct: number): string {
	if (pct >= 80) return ROSE;
	if (pct >= 60) return BAND_ORANGE;
	if (pct >= 40) return BAND_AMBER;
	return EMERALD;
}

/**
 * Render the context bar: `width` buckets, two threshold markers at 1/3
 * (orange) and 2/3 (dark red), filled buckets banded green → orange → dark
 * red, empty buckets dim indigo. Mirrors render_context_bar() in statusline.sh.
 */
function renderContextBar(width: number, pct: number): string {
	if (width < 3) return "";

	const filled = Math.max(0, Math.floor((pct * width) / 100));
	const pos20 = Math.floor(width / 3);
	const pos60 = Math.floor((2 * width) / 3);
	const spaced = width <= 20;

	let out = "";
	for (let i = 1; i <= width; i++) {
		if (i === pos20) {
			out += `${BAND_ORANGE}${BUCKET}${RESET}`;
		} else if (i === pos60) {
			out += `${BAND_DARK_RED}${BUCKET}${RESET}`;
		} else if (i <= filled) {
			let color = BAND_DARK_RED;
			if (i < pos20) color = BAND_GREEN;
			else if (i < pos60) color = BAND_ORANGE;
			out += `${color}${BUCKET}${RESET}`;
		} else {
			out += `${CTX_BUCKET_EMPTY}${BUCKET}${RESET}`;
		}
		if (spaced) out += " ";
	}
	return spaced ? out.replace(/ $/, "") : out;
}

/** Context pct + window from live usage (or model defaults), with display color. */
function contextUsage(ctx: ExtensionContext): {
	windowTokens: number;
	pct: number | null;
	pctColor: string;
	pctStr: string;
} {
	const usage = ctx.getContextUsage();
	const windowTokens = Math.max(
		0,
		usage?.contextWindow ?? ctx.model?.contextWindow ?? 0
	);
	const pct = usage?.percent ?? null;
	return {
		windowTokens,
		pct,
		pctColor: pct === null ? SLATE_500 : usageColor(pct),
		pctStr: pct === null ? "?" : `${Math.round(pct)}`,
	};
}

/** Format token counts: 999, 1.2k, 12k, 1.2M, 12M. */
function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** Abbreviate cwd under $HOME as ~/… (same logic as pi's built-in footer). */
function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = path.resolve(cwd);
	const resolvedHome = path.resolve(home);
	const rel = path.relative(resolvedHome, resolvedCwd);
	const inside =
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${path.sep}${rel}`;
}

const SEP = `${SLATE_600} │ ${RESET}`;

/**
 * Pair a left label and a right label on one row: left starts at column 0,
 * right is justified to `width`, at least two columns of gap. When both don't
 * fit, the right side is budgeted at most half the width (min 24 cols) and the
 * left side truncates into what remains, so neither side is dropped entirely.
 */
function pairRow(left: string, right: string, width: number): string {
	const avail = Math.max(0, width);
	const lw = visibleWidth(left);
	const rw = right ? visibleWidth(right) : 0;
	if (lw + rw + 2 <= avail) {
		return right ? left + " ".repeat(avail - lw - rw) + right : left;
	}
	const rBudget = Math.min(rw, Math.max(24, Math.floor(avail / 2)));
	const lBudget = Math.max(0, avail - rBudget - 2);
	const lFit = lBudget > 0 ? truncateToWidth(left, lBudget, "…") : "";
	const rFit = rBudget > 0 && rBudget < rw ? truncateToWidth(right, rBudget, "…") : right;
	const pad = Math.max(0, avail - visibleWidth(lFit) - visibleWidth(rFit));
	return lFit + " ".repeat(pad) + rFit;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROW BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

/** Muted model metadata: live provider count (when >1) and scoped cycle size. */
function modelMeta(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider): string {
	const parts: string[] = [];
	const providers = footerData.getAvailableProviderCount();
	if (providers >= 2) parts.push(`${providers} providers`);
	if (ctx.scopedModels.length >= 2) parts.push(`cycle ${ctx.scopedModels.length}`);
	return parts.length > 0 ? ` ${SLATE_500}· ${parts.join(" · ")}${RESET}` : "";
}

/** Styled (model · thinking) left label, plus muted provider/cycle metadata. */
function modelLabel(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider): string {
	const model = ctx.model?.id ?? "no-model";
	let label = `${SLATE_300}${model}${RESET}`;
	const level = ctx.thinkingLevel ?? "off";
	if (ctx.model?.reasoning && level !== "off") {
		label += ` ${SLATE_500}· ${level}${RESET}`;
	}
	return label + modelMeta(ctx, footerData);
}

/** Styled cwd (right side of row 1). */
function cwdLabel(ctx: ExtensionContext): string {
	return `${SLATE_400}${formatCwd(ctx.cwd, process.env.HOME)}${RESET}`;
}

/** Styled git branch (right side of row 2), "" when not in a repo. */
function branchLabel(footerData: ReadonlyFooterDataProvider): string {
	const name = footerData.getGitBranch();
	return name ? `${GIT_PRIMARY}${name}${RESET}` : "";
}

/**
 * Compact row 1 (narrow panes): model · thinking │ ~/cwd · main inline, plus
 * the git branch in parens-free dots — cwd and branch share the line even here.
 */
function compactHeaderRow(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider, width: number): string {
	const cwd = cwdLabel(ctx);
	const branch = branchLabel(footerData);
	let row = `${modelLabel(ctx, footerData)}${SEP}${cwd}${branch ? ` · ${branch}` : ""}`;
	return visibleWidth(row) > width ? truncateToWidth(row, width, "…") : row;
}

/**
 * Muted session tag: · #<short id> · <n> msgs on the CONTEXT row. Only on
 * rows >=100 cols so the bar keeps its bucket budget on narrow panes. The
 * short id is the tail-8 of the UUID half of the session id (the timestamp
 * half is shared by any session started in the same second).
 */
function sessionTag(ctx: ExtensionContext, width: number): string {
	if (width < 100) return "";
	const raw = ctx.sessionManager.getSessionId();
	if (!raw) return "";
	const stem = raw.split("_").pop() ?? raw;
	const short = stem.length > 8 ? stem.slice(-8) : stem;
	const msgs = ctx.sessionManager.getBranch().length;
	return `${SLATE_600} · ${RESET}${SLATE_500}#${short} · ${msgs} msgs${RESET}`;
}

/** CONTEXT: ⛁…⛁ 19%/200k (bar capped at 60 buckets; shrinks on narrow panes). */
function contextRow(ctx: ExtensionContext, width: number): string {
	const { windowTokens, pct, pctColor, pctStr } = contextUsage(ctx);
	const suffix = ` ${pctColor}${pctStr}%${RESET}${SLATE_500}/${formatTokens(windowTokens)}${RESET}`;
	const prefix = `${CTX_SECONDARY}CONTEXT:${RESET} `;
	const tag = sessionTag(ctx, width);

	const available = width - visibleWidth(prefix) - visibleWidth(suffix) - visibleWidth(tag);
	const bar = renderContextBar(Math.min(MAX_BAR_BUCKETS, Math.max(0, available)), pct ?? 0);

	const row = `${prefix}${bar}${bar && !suffix.startsWith(" ") ? " " : ""}${suffix}${tag}`;
	return visibleWidth(row) > width ? truncateToWidth(row, width, "…") : row;
}

/** Compact row 2 (narrow panes): ◉ 19%/200k */
function contextCompactRow(ctx: ExtensionContext): string {
	const { windowTokens, pctColor, pctStr } = contextUsage(ctx);
	return `${CTX_PRIMARY}◉${RESET} ${pctColor}${pctStr}%${RESET}${SLATE_500}/${formatTokens(windowTokens)}${RESET}`;
}

/**
 * USE statistics line (left side of row 2): USE: ↑14k ↓5.1k R90k W2.3k CH68.5%
 * $0.046. The $ cost is included whenever it is nonzero, so this is the
 * USE/cost slot the branch pairs against — never a full-width line.
 */
function usageLine(ctx: ExtensionContext): string {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let latestCacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const u = entry.message.usage;
		input += u.input;
		output += u.output;
		cacheRead += u.cacheRead;
		cacheWrite += u.cacheWrite;
		cost += u.cost.total;
		const prompt = u.input + u.cacheRead + u.cacheWrite;
		if (prompt > 0) latestCacheHitRate = (u.cacheRead / prompt) * 100;
	}

	const metric = (unit: string, value: number | undefined): string =>
		value !== undefined && value > 0 ? ` ${SLATE_500}${unit}${RESET}${SLATE_300}${formatTokens(value)}${RESET}` : "";

	let line = `${USAGE_LABEL}USE:${RESET}`;
	if (input + output + cacheRead + cacheWrite === 0) {
		line += ` ${SLATE_500}—${RESET}`;
	} else {
		line += metric("↑", input);
		line += metric("↓", output);
		line += metric("R", cacheRead);
		line += metric("W", cacheWrite);
		if (cacheRead > 0 && latestCacheHitRate !== undefined) {
			line += ` ${SLATE_500}CH${RESET}${SLATE_300}${latestCacheHitRate.toFixed(1)}%${RESET}`;
		}
		if (cost > 0) {
			line += `${USAGE_EXTRA} $${cost.toFixed(3)}${RESET}`;
		}
	}
	return line;
}

/**
 * Bottom row (tip slot): ❯ <current tip from the suggestions loop>.
 * pi-lens's LSP status ("pi-lens-lsp" / "LSP Inactive") is filtered out.
 */
function suggestionsRow(width: number, statuses: ReadonlyMap<string, string>): string {
	const tip = statuses.get("tips")?.trim() ?? "";
	const others: string[] = [];
	for (const [key, text] of statuses) {
		if (key === "tips" || /(pi-lens|lens|lsp)/i.test(key)) continue;
		const plain = text.replace(/\x1b\[[0-9;]*m/g, ""); // statuses may be ANSI-wrapped
		if (plain.length > 0 && !/(lsp inactive|lsp failed|pi-lens)/i.test(plain)) {
			others.push(text);
		}
	}

	let row: string;
	if (tip) {
		row = `${QUOTE_PRIMARY}❯${RESET} ${QUOTE_AUTHOR}${tip}${RESET}`;
	} else if (others.length > 0) {
		row = `${SLATE_400}❯${RESET} ${SLATE_300}${others.shift()}${RESET}`;
	} else {
		row = `${QUOTE_PRIMARY}❯${RESET} ${SLATE_400}Type / to list commands — /hotkeys shows every shortcut${RESET}`;
	}

	for (const extra of others) {
		const more = ` ${SLATE_600}┆${RESET} ${SLATE_500}${extra}${RESET}`;
		if (visibleWidth(row + more) > width) break;
		row += more;
	}
	return visibleWidth(row) > width ? truncateToWidth(row, width, "…") : row;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTENSION
// ─────────────────────────────────────────────────────────────────────────────

export default function claudeStatuslineFooter(pi: ExtensionAPI): void {
	if (DISABLED) return;

	let lastTui: { requestRender(): void } | undefined;

	// Keep the header/usage rows live when the model or thinking level changes.
	pi.on("model_select", () => lastTui?.requestRender());
	pi.on("thinking_level_select", () => lastTui?.requestRender());

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		// Re-assert on EVERY session start (startup/new/resume/fork/reload): the
		// built-in footer is the only component that renders extension statuses
		// (including pi-lens's "pi-lens-lsp"), and a skip-once guard lets it sneak
		// back after a session switch. setExtensionFooter disposes the previous
		// custom component, so re-installing is always safe.
		ctx.ui.setFooter((tui, _theme, footerData): Component & { dispose(): void } => {
			lastTui = tui;
			let lastStatusSig = "";

			// Re-render when ANY extension status changes (tips rotation, but also
			// state published by auto-reasoning/loop-police-style publishers).
			const ticker = setInterval(() => {
				const statuses = footerData.getExtensionStatuses();
				const sig = [...statuses].map(([k, v]) => `${k}=${v}`).join("\n");
				if (sig !== lastStatusSig) {
					lastStatusSig = sig;
					tui.requestRender();
				}
			}, TIP_TICK_MS);

			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				invalidate() {
					// No cached state.
				},
				render(width: number): string[] {
					const rows: string[] = [];
					if (width < 70) {
						// compact: model · thinking │ ~/cwd · main, mini pct, tip
						rows.push(compactHeaderRow(ctx, footerData, width));
						rows.push(contextCompactRow(ctx));
					} else {
						// row 1: model · thinking · meta (left) │ cwd (right)
						rows.push(pairRow(modelLabel(ctx, footerData), cwdLabel(ctx), width));
						// row 2: USE stats (left) │ git branch (right)
						rows.push(pairRow(usageLine(ctx), branchLabel(footerData), width));
						// row 3: CONTEXT bar
						rows.push(contextRow(ctx, width));
					}
					// row 4 (or tip in compact): live suggestions tip
					rows.push(suggestionsRow(width, footerData.getExtensionStatuses()));
					return rows;
				},
				dispose() {
					clearInterval(ticker);
					unsubBranch();
					if (lastTui === tui) lastTui = undefined;
				},
			};
		});
	});
}
