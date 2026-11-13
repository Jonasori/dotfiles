import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import hibernate, { decideHibernation } from "../hibernate.ts";

const NOW = 1_800_000_000_000;
const ENV_KEYS = [
	"HIBERNATE_OFF",
	"HIBERNATE_PCT",
	"HIBERNATE_BUFFER_SEC",
	"HIBERNATE_MAX_SLEEP_SEC",
	"HIBERNATE_STALE_SEC",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
	for (const key of ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	savedEnv.clear();
});

function reportWithFiveHour(
	fraction: number | undefined,
	resetAt: number | undefined,
	options: { fetchedAt?: number; modelId?: string } = {},
): UsageReport {
	return {
		provider: "opencode-go",
		fetchedAt: options.fetchedAt ?? NOW,
		limits: [
			{
				id: "rolling-5h",
				label: "5 Hour limit",
				scope: {
					provider: "opencode-go",
					windowId: "5h",
					shared: true,
					...(options.modelId ? { modelId: options.modelId } : {}),
				},
				window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, ...(resetAt ? { resetsAt: resetAt } : {}) },
				amount: {
					...(fraction === undefined ? {} : { usedFraction: fraction }),
					unit: "percent",
				},
				status: "ok",
			},
		],
	};
}

describe("decideHibernation", () => {
	test("sleeps at 97 percent until reset plus the buffer", () => {
		const decision = decideHibernation(reportWithFiveHour(0.97, NOW + 3_600_000), "kimi", NOW);
		expect(decision).toEqual({ sleepMs: 3_630_000, pct: 97 });
	});

	test("proceeds below the threshold", () => {
		expect(decideHibernation(reportWithFiveHour(0.969, NOW + 3_600_000), "kimi", NOW)).toBeUndefined();
	});

	test("proceeds with stale usage", () => {
		const report = reportWithFiveHour(0.99, NOW + 3_600_000, { fetchedAt: NOW - 300_001 });
		expect(decideHibernation(report, "kimi", NOW)).toBeUndefined();
	});

	test("proceeds without a usable fraction or reset", () => {
		expect(decideHibernation(reportWithFiveHour(undefined, NOW + 3_600_000), "kimi", NOW)).toBeUndefined();
		expect(decideHibernation(reportWithFiveHour(0.99, undefined), "kimi", NOW)).toBeUndefined();
	});

	test("proceeds after the reset buffer has elapsed", () => {
		expect(decideHibernation(reportWithFiveHour(0.99, NOW - 30_000), "kimi", NOW)).toBeUndefined();
		expect(decideHibernation(reportWithFiveHour(0.99, NOW - 29_000), "kimi", NOW)?.sleepMs).toBe(1_000);
	});

	test("caps one wait below the five-hour handler timeout", () => {
		const decision = decideHibernation(reportWithFiveHour(0.99, NOW + 3 * 86_400_000), "kimi", NOW);
		expect(decision?.sleepMs).toBe(17_700_000);
		expect(decision?.sleepMs).toBeLessThan(18_000_000);
	});

	test("ignores a five-hour limit scoped to another model", () => {
		const report = reportWithFiveHour(0.99, NOW + 3_600_000, { modelId: "another-model" });
		expect(decideHibernation(report, "kimi", NOW)).toBeUndefined();
	});

	test("derives usage from the normalized amount fallbacks", () => {
		const report = reportWithFiveHour(undefined, NOW + 3_600_000);
		report.limits[0]!.amount = { used: 99, limit: 100, unit: "requests" };
		expect(decideHibernation(report, "kimi", NOW)?.sleepMs).toBe(3_630_000);
		report.limits[0]!.amount = { used: 99, unit: "percent" };
		expect(decideHibernation(report, "kimi", NOW)?.sleepMs).toBe(3_630_000);
		report.limits[0]!.amount = { remainingFraction: 0.01, unit: "percent" };
		expect(decideHibernation(report, "kimi", NOW)?.sleepMs).toBe(3_630_000);
	});
});

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function harness(ctx: ExtensionContext) {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	};
	hibernate(pi as unknown as ExtensionAPI);
	return {
		tool: () => handlers.get("tool_call")?.({ type: "tool_call" }, ctx),
		shutdown: () => handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx),
	};
}

function contextWithReport(
	report: UsageReport | Error,
	options: {
		environmentCredential?: boolean;
		reports?: UsageReport[];
		reportReader?: (report: UsageReport | Error, read: number) => Promise<UsageReport>;
	} = {},
) {
	const statuses: (string | undefined)[] = [];
	let reportReads = 0;
	const statusWaiters: (() => void)[] = [];
	const scheduled = new Map<number, { callback: () => void; kind: "timeout" | "interval" }>();
	const timerIds = new Map<Timer, number>();
	let nextTimerId = 1;
	const timer = (id: number) => {
		const handle = { id } as unknown as Timer;
		timerIds.set(handle, id);
		return handle;
	};
	const scheduler = {
		get timeoutCount() {
			return [...scheduled.values()].filter(entry => entry.kind === "timeout").length;
		},
		fireTimeout() {
			const pending = [...scheduled.entries()].find(([, entry]) => entry.kind === "timeout");
			if (!pending) throw new Error("no hibernation timeout was scheduled");
			const [id, entry] = pending;
			scheduled.delete(id);
			entry.callback();
		},
	};
	const ctx = {
		model: { provider: "opencode-go", id: "kimi", baseUrl: "https://opencode.ai/inference/go" },
		sessionManager: { getSessionId: () => "session-id" },
		modelRegistry: {
			getApiKeyWithCredentialForProvider: async () => ({
				apiKey: "credential-not-read-by-extension",
				...(options.environmentCredential ? {} : { credentialId: 7 }),
			}),
			authStorage: {
				credentials: {
					list: () => [
						{ id: 7, credential: { type: "api_key", key: "credential-not-read-by-extension" } },
					],
				},
				usage: {
					report: async () => {
						reportReads++;
						if (options.reportReader) return options.reportReader(report, reportReads);
						if (report instanceof Error) throw report;
						return report;
					},
					reports: async () => options.reports ?? [],
				},
			},
		},
		ui: {
			setStatus: (_key: string, text: string | undefined) => {
				statuses.push(text);
				for (const resolve of statusWaiters.splice(0)) resolve();
			},
		},
		setTimeout: (callback: () => void, _ms: number) => {
			const id = nextTimerId++;
			scheduled.set(id, { callback, kind: "timeout" });
			return timer(id);
		},
		setInterval: (callback: () => void, _ms: number) => {
			const id = nextTimerId++;
			scheduled.set(id, { callback, kind: "interval" });
			return timer(id);
		},
		clearTimer: (handle: Timer) => {
			const id = timerIds.get(handle);
			if (id !== undefined) scheduled.delete(id);
		},
	} as unknown as ExtensionContext;
	return {
		ctx,
		statuses,
		scheduler,
		nextStatus: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			statusWaiters.push(resolve);
			return promise;
		},
	};
}

describe("hibernate tool handler", () => {
	test("shares one wait across concurrent calls and clears status on wake", async () => {
		process.env.HIBERNATE_BUFFER_SEC = "0";
		const now = Date.now();
		const { ctx, statuses, scheduler, nextStatus } = contextWithReport(
			reportWithFiveHour(0.99, now + 40, { fetchedAt: now }),
		);
		const calls = harness(ctx);
		const sleeping = nextStatus();
		const first = calls.tool();
		await sleeping;
		const second = calls.tool();
		expect(scheduler.timeoutCount).toBe(1);

		scheduler.fireTimeout();
		await Promise.all([first, second]);

		expect(statuses.filter(text => text !== undefined)).toHaveLength(1);
		expect(statuses[0]).toContain("HIBERNATING");
		expect(statuses.at(-1)).toBeUndefined();
		expect(scheduler.timeoutCount).toBe(0);
	});

	test("fails open when the usage service errors", async () => {
		const { ctx, statuses } = contextWithReport(new Error("usage unavailable"));
		const calls = harness(ctx);
		expect(await calls.tool()).toBeUndefined();
		expect(statuses).toEqual([]);
	});

	test("session shutdown releases the pending wait and status", async () => {
		process.env.HIBERNATE_BUFFER_SEC = "0";
		process.env.HIBERNATE_MAX_SLEEP_SEC = "60";
		const now = Date.now();
		const { ctx, statuses, scheduler, nextStatus } = contextWithReport(
			reportWithFiveHour(0.99, now + 60_000, { fetchedAt: now }),
		);
		const calls = harness(ctx);
		const sleeping = nextStatus();
		const pending = calls.tool();
		await sleeping;
		expect(scheduler.timeoutCount).toBe(1);

		await calls.shutdown();
		await pending;
		expect(statuses.at(-1)).toBeUndefined();
		expect(scheduler.timeoutCount).toBe(0);
	});

	test("fails open for an id-less credential instead of using a stored account's report", async () => {
		process.env.HIBERNATE_BUFFER_SEC = "0";
		const now = Date.now();
		const storedAccountReport = reportWithFiveHour(0.99, now + 40, { fetchedAt: now });
		const { ctx, statuses, scheduler, nextStatus } = contextWithReport(new Error("direct report must not be used"), {
			environmentCredential: true,
			reports: [storedAccountReport],
		});
		const calls = harness(ctx);
		const sleeping = nextStatus();
		const pending = calls.tool();
		const outcome = await Promise.race([
			pending.then(() => "proceeded"),
			sleeping.then(() => "slept"),
		]);
		if (outcome === "slept") scheduler.fireTimeout();
		await pending;
		expect(outcome).toBe("proceeded");
		expect(statuses).toEqual([]);
	});

	test("a concurrent usage error does not cancel another call's wait", async () => {
		process.env.HIBERNATE_BUFFER_SEC = "0";
		const now = Date.now();
		const firstRead = Promise.withResolvers<void>();
		const secondRead = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		const { ctx, statuses, scheduler, nextStatus } = contextWithReport(
			reportWithFiveHour(0.99, now + 40, { fetchedAt: now }),
			{
				reportReader: async (report, read) => {
					if (read === 1) {
						firstRead.resolve();
						await releaseFirst.promise;
						if (report instanceof Error) throw report;
						return report;
					}
					secondRead.resolve();
					await releaseSecond.promise;
					throw new Error("concurrent usage read failed");
				},
			},
		);
		const calls = harness(ctx);
		const first = calls.tool();
		await firstRead.promise;
		const second = calls.tool();
		await secondRead.promise;
		const sleeping = nextStatus();
		releaseFirst.resolve();
		await sleeping;

		releaseSecond.resolve();
		await second;
		expect(scheduler.timeoutCount).toBe(1);
		expect(statuses.at(-1)).toContain("HIBERNATING");

		scheduler.fireTimeout();
		await first;
		expect(statuses.at(-1)).toBeUndefined();
	});
});
