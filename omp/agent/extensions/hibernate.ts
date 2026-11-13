import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AuthCredential, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";

const STATUS_KEY = "hibernate";
const FIVE_HOUR_MS = 18_000_000;
const USAGE_TIMEOUT_MS = 10_000;

export interface HibernationDecision {
	sleepMs: number;
	pct: number;
}

function envNum(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

function usedFraction(limit: UsageLimit): number | undefined {
	const amount = limit.amount;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		return amount.used / amount.limit;
	}
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	if (amount.remainingFraction !== undefined) return 1 - amount.remainingFraction;
	return undefined;
}

function fiveHourLimit(report: UsageReport, modelId: string | undefined): UsageLimit | undefined {
	const candidates = report.limits.filter(limit => {
		const isFiveHour =
			limit.scope.windowId === "5h" || limit.window?.id === "5h" || limit.window?.durationMs === FIVE_HOUR_MS;
		return isFiveHour && (!limit.scope.modelId || limit.scope.modelId === modelId);
	});
	return candidates.find(limit => limit.scope.modelId) ?? candidates[0];
}

export function decideHibernation(
	report: UsageReport,
	modelId: string | undefined,
	nowMs: number,
): HibernationDecision | undefined {
	const staleMs = envNum("HIBERNATE_STALE_SEC", 300) * 1000;
	if (!Number.isFinite(report.fetchedAt) || nowMs - report.fetchedAt > staleMs) return;

	const limit = fiveHourLimit(report, modelId);
	if (!limit) return;
	const fraction = usedFraction(limit);
	if (fraction === undefined || !Number.isFinite(fraction)) return;
	const pct = fraction * 100;
	if (pct < envNum("HIBERNATE_PCT", 97)) return;

	const resetAt = limit.window?.resetsAt;
	if (resetAt === undefined || !Number.isFinite(resetAt)) return;
	const bufferMs = envNum("HIBERNATE_BUFFER_SEC", 30) * 1000;
	const maxSleepMs = envNum("HIBERNATE_MAX_SLEEP_SEC", 17_700) * 1000;
	const sleepMs = Math.min(resetAt - nowMs + bufferMs, maxSleepMs);
	if (sleepMs <= 0) return;
	return { sleepMs, pct };
}

type UsageWithDirectReport = ExtensionContext["modelRegistry"]["authStorage"]["usage"] & {
	report?: (
		provider: string,
		credential: AuthCredential,
		options?: { baseUrl?: string; signal?: AbortSignal },
	) => Promise<UsageReport | null>;
};

async function readActiveUsageReport(ctx: ExtensionContext): Promise<UsageReport | undefined> {
	const model = ctx.model;
	if (!model) return;
	const auth = ctx.modelRegistry.authStorage;
	const signal = AbortSignal.timeout(USAGE_TIMEOUT_MS);
	const resolved = await ctx.modelRegistry.getApiKeyWithCredentialForProvider(
		model.provider,
		ctx.sessionManager.getSessionId(),
		{ baseUrl: model.baseUrl, modelId: model.id, signal },
	);
	if (!resolved) return;

	if (resolved.credentialId === undefined) return;
	const credential = auth.credentials.list(model.provider).find(entry => entry.id === resolved.credentialId)?.credential;
	if (!credential) return;
	// The runtime's UsageService exposes this single-account read, but UsageApi omits it.
	const usage = auth.usage as UsageWithDirectReport;
	if (typeof usage.report !== "function") return;
	return (await usage.report(model.provider, credential, { baseUrl: model.baseUrl, signal })) ?? undefined;
}

function formatCountdown(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return `${hours}h${minutes}m`;
	if (seconds < 60) return "<1m";
	return `${Math.ceil(seconds / 60)}m`;
}

export default function hibernate(pi: ExtensionAPI): void {
	if (process.env.HIBERNATE_OFF === "1") return;

	let pending: Promise<void> | undefined;
	let cancel: (() => void) | undefined;
	let stopped = false;

	pi.on("session_shutdown", () => {
		stopped = true;
		cancel?.();
	});

	pi.on("tool_call", async (_event, ctx) => {
		if (stopped) return;
		let cancelOwnedWait: (() => void) | undefined;
		try {
			if (pending) {
				await pending;
				return;
			}
			const report = await readActiveUsageReport(ctx);
			if (!report) return;
			const decision = decideHibernation(report, ctx.model?.id, Date.now());
			if (!decision) return;
			// Another tool call may have started the wait while usage was loading.
			if (pending) {
				await pending;
				return;
			}
			if (stopped) return;

			const { promise, resolve } = Promise.withResolvers<void>();
			pending = promise;
			let timeout: Timer | undefined;
			let countdown: Timer | undefined;
			let finished = false;
			const wakeAt = Date.now() + decision.sleepMs;
			const pct = Math.round(decision.pct * 10) / 10;
			const finish = () => {
				if (finished) return;
				finished = true;
				if (timeout) ctx.clearTimer(timeout);
				if (countdown) ctx.clearTimer(countdown);
				ctx.ui.setStatus(STATUS_KEY, undefined);
				pending = undefined;
				cancel = undefined;
				resolve();
			};
			cancel = finish;
			cancelOwnedWait = finish;
			const updateStatus = () => {
				if (!finished) {
					ctx.ui.setStatus(
						STATUS_KEY,
						`HIBERNATING · 5h ${pct}% · resumes in ${formatCountdown(wakeAt - Date.now())} · no action needed`,
					);
				}
			};
			updateStatus();
			timeout = ctx.setTimeout(finish, decision.sleepMs);
			countdown = ctx.setInterval(updateStatus, 30_000);
			await promise;
		} catch {
			// OMP fails closed on handler errors. Hibernation must only ever delay.
			cancelOwnedWait?.();
		}
	});
}
