/**
 * footer-tips — cycles a short tip in pi's footer so workflow shortcuts
 * don't get forgotten (prompt-enhance, verify/derive templates, session/
 * context commands, change_reasoning, loop-police, etc.).
 *
 * - Shows one tip at a time, rotating every TIP_INTERVAL seconds.
 * - TUI-only (setStatus is a no-op/none in print/json/rpc without UI).
 * - Timer is session-scoped and cleaned up on session_shutdown.
 *
 * Env:
 *   FOOTER_TIPS_OFF=1 -> disable
 *   FOOTER_TIPS_INTERVAL=30 -> seconds between tips (default 20)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TIPS: string[] = [
	"Type / at the prompt to list commands — /hotkeys shows every shortcut",
	"Ctrl+Shift+E — sharpen your prompt before sending (prompt-enhancer)",
	"/verify — rigor-check a claim against data; /derive — step-by-step math",
	"/stats — statistical claim audit; /pipeline — data/ML pipeline review",
	"Esc aborts a request; Alt+Enter queues a follow-up; Enter steers the agent",
	"/compact — shrink context when the CONTEXT meter climbs",
	"/session — tokens, cost, and the session file; /copy — last answer to clipboard",
	"/oracle-policy — see which model the oracle will use, and why",
	"change_reasoning — the agent can raise its own reasoning level (floor = your baseline)",
	"/loop-police — inspect loop detectors; /loop-police reset — clear loop state",
	"Ctrl+P cycles models; /model picks explicitly; /scoped-models trims the cycle",
	"/subagents — parallel work in separate agents; /subagent-cost — spend per worker",
];

const DISABLED = process.env.FOOTER_TIPS_OFF === "1";
const INTERVAL_MS = Math.max(10, Number(process.env.FOOTER_TIPS_INTERVAL ?? "20")) * 1000;

export default function footerTipsExtension(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let index = 0;

	const showNext = (ctx: { hasUI: boolean; ui: { setStatus(id: string, text: string): void } }) => {
		if (!ctx.hasUI) return;
		const tip = TIPS[index % TIPS.length];
		index += 1;
		ctx.ui.setStatus("tips", tip);
	};

	pi.on("session_start", (event, ctx) => {
		if (DISABLED) return;
		if (event.reason !== "startup" && event.reason !== "reload") return;
		showNext(ctx);
		if (timer) return; // already running
		timer = setInterval(() => showNext(ctx), INTERVAL_MS);
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});
}
