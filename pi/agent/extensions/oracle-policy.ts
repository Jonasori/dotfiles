/**
 * oracle-policy — maintains the oracle's configured default model so it is
 * always the MOST CAPABLE NON-AMERICAN model available, and keeps that pin
 * fresh as new models appear (no manual upkeep).
 *
 * Rule implemented here (mirror of user preference):
 *   "oracle = most capable non-American option; Claude/GPT/Gemini/Grok are
 *    excluded (too expensive)."
 *
 * Mechanism:
 *  - Computes the best eligible model at session start and writes the
 *    oracle's pin file (`getAgentDir()/extensions/oracle.json`), which the
 *    oracle extension reads verbatim (its auto-select is bypassed when a
 *    configured model exists).
 *  - Ranking: family priority (editable below) then version, then tier.
 *    Within a family, higher versions auto-win — so when a newer kimi/glm/
 *    qwen/deepseek lands on the provider, the pin updates itself on the
 *    next session start. New *families* are a rare one-line edit below.
 *  - User override respected: if the oracle pin differs from what this
 *    extension last wrote (i.e. the user ran `/oracle model X`), this
 *    extension backs off. `/oracle-policy refresh` re-asserts the rule.
 *
 * Commands:
 *   /oracle-policy          -> status: current pin, owner, best eligible, why
 *   /oracle-policy refresh  -> recompute and re-assert the pin now
 *   /oracle-policy auto     -> (default) auto-manage on every session start
 *
 * Env:
 *   ORACLE_POLICY_DISABLE=1 -> stop auto-managing entirely (manual mode)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

/** Structural subset of PiModel used here; avoids depending on package type exports. */
interface PiModel {
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

const ORACLE_CONFIG_FILE = "oracle.json";
const POLICY_SIDECAR = "oracle-policy.json";

/** Family priority: higher = preferred for oracle duty. Edit ordering here. */
const FAMILY_RANK = [
	"kimi", // Moonshot — strongest overall (K3: AA index #4, GPQA 93.5)
	"glm", // Z.ai — coding/agentic strengths; GLM 5.3 when it lands
	"qwen", // Alibaba — multimodal agentic flagship line
	"deepseek", // DeepSeek — math/algorithmics specialist
	"minimax", // MiniMax — long-context/multimodal
	"step", // StepFun — emerging frontier line
	"muse", // Tencent — Muse Spark line
	"mimo", // Xiaomi — MiMo line
	"ling", // Ant Group — Ling line
] as const;

/**
 * US-lab model-id patterns excluded from oracle consideration regardless of
 * family. Anything not on this list AND not matched by a known US provider
 * is treated as non-American (e.g. mistral, glm, kimi, qwen, deepseek).
 */
const US_MODEL_PATTERNS = [
	/^claude[\w.-]*$/i,
	/^(gpt|o[1-9]|grok)[\w.-]*$/i,
	/^gemini[\w.-]*$/i,
	/^llama[\w.-]*$/i,
	/^nemotron[\w.-]*$/i,
	/^phi[\w.-]*$/i,
	/^command[\w.-]*$/i,
	/^(gpt-oss|codex|dall-e|jamba|ministral|sonar)[\w.-]*$/i,
] as const;

const US_PROVIDERS = new Set([
	"anthropic",
	"openai",
	"openai-codex",
	"google",
	"google-vertex",
	"xai",
	"meta",
	"microsoft",
	"azure",
	"azure-openai-responses",
	"amazon",
	"amazon-bedrock",
	"groq",
	"cerebras",
	"together",
	"fireworks",
	"deepinfra",
	"nvidia",
	"nvidia-nim",
	"modal",
	"replicate",
]);

const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

interface PolicyState {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	updatedAt?: string;
}

function configPaths(): { oracle: string; sidecar: string } {
	const dir = path.join(getAgentDir(), "extensions");
	return {
		oracle: path.join(dir, ORACLE_CONFIG_FILE),
		sidecar: path.join(dir, POLICY_SIDECAR),
	};
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.promises.readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	await fs.promises.writeFile(
		file,
		`${JSON.stringify(value, null, 2)}\n`,
		"utf8",
	);
}

function normalizeId(model: PiModel): string {
	return `${model.id} ${model.name ?? ""}`.toLowerCase();
}

function isUsLab(model: PiModel): boolean {
	if (US_PROVIDERS.has(model.provider.toLowerCase())) return true;
	const text = normalizeId(model);
	return US_MODEL_PATTERNS.some((pattern) => pattern.test(text));
}

/** Extract the leading family token (e.g. "kimi-k3" -> "kimi", "mimo-v2.5-free" -> "mimo"). */
function familyOf(id: string): string {
	const m = id.toLowerCase().match(/^([a-z]+)(?:[-\d].*)?$/);
	return m?.[1] ?? id.toLowerCase();
}

function familyRank(family: string): number {
	const idx = FAMILY_RANK.findIndex((f) => family.startsWith(f));
	return idx === -1 ? FAMILY_RANK.length : idx;
}

function versionOf(id: string): number {
	const digit = id.match(/(\d+)\.(\d+)/);
	if (digit) return Number(digit[1]) * 100 + Number(digit[2]);
	const single = id.match(/(\d+)/);
	return single ? Number(single[1]) * 100 : 0;
}

function tierRank(id: string): number {
	const text = id.toLowerCase();
	if (/max|ultra|pro/.test(text)) return 3;
	if (/plus|thinking|reasoning|turbo/.test(text)) return 2;
	if (/flash|mini|lite|free|small|nano/.test(text)) return 0;
	return 1;
}

function score(model: PiModel): number {
	const id = model.id.toLowerCase();
	// Lower is better: family rank first, then higher version → lower score, then higher tier → lower score
	return (
		familyRank(familyOf(id)) * 1_000_000 - versionOf(id) * 100 - tierRank(id)
	);
}

function bestEligible(models: PiModel[]): PiModel | undefined {
	const eligible = models.filter((m) => !isUsLab(m));
	if (eligible.length === 0) return undefined;
	return [...eligible].sort((a, b) => score(a) - score(b))[0];
}

function describe(model: PiModel): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Write the oracle pin, unless the user has an override newer than our own
 * last write (respecting `updatedAt` and matching model).
 */
async function maybeWritePin(
	pick: PiModel,
	thinking: ThinkingLevel,
	force: boolean,
): Promise<{ written: boolean; reason: string }> {
	const { oracle, sidecar } = configPaths();
	const oracleCfg = await readJson<PolicyState>(oracle);
	const prev = await readJson<PolicyState>(sidecar);
	const modelRef = describe(pick);

	// A user override is visible as oracle.json differing from what the policy
	// last wrote (the sidecar). Comparing the sidecar to the NEW pick instead
	// would defeat overrides whenever the pick is unchanged (`/oracle model X`
	// writes only oracle.json, as does a manual edit — both were re-asserted
	// away before this fix; verified 2026-08-19).
	const ours = prev?.model === oracleCfg?.model;
	const userSet =
		oracleCfg?.model !== undefined &&
		oracleCfg.model !== modelRef &&
		oracleCfg?.updatedAt &&
		(!prev?.updatedAt || oracleCfg.updatedAt > (prev.updatedAt ?? ""));

	if (!force && userSet && !ours) {
		return {
			written: false,
			reason: `user override active (${oracleCfg.model}); use /oracle-policy refresh to re-assert`,
		};
	}

	const next: PolicyState = {
		model: modelRef,
		thinkingLevel: thinking,
		updatedAt: new Date().toISOString(),
	};
	await writeJson(oracle, next);
	await writeJson(sidecar, next);
	return { written: true, reason: `pinned ${modelRef} (${thinking})` };
}

function statusView(
	ctx: ExtensionCommandContext,
	effective: string,
	pick: PiModel | undefined,
	written: { written: boolean; reason: string },
) {
	const oracle = configPaths().oracle;
	const lines = [
		`oracle model : ${effective || "(none)"}`,
		`rule         : ${written.reason}`,
		pick
			? `  candidate   : ${describe(pick)} (score ${score(pick)}, family=${familyOf(pick.id)}, v${versionOf(pick.id)}, tier=${tierRank(pick.id)})`
			: "",
		`  overrides   : /oracle model X sets manual pin; /oracle-policy refresh re-asserts`,
		`config       : ${oracle}`,
		`families     : ${FAMILY_RANK.join(" > ")}`,
	].filter(Boolean);
	if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
	else console.log(lines.join("\n"));
}

export default function oraclePolicyExtension(pi: ExtensionAPI) {
	const autoManaged =
		(globalThis as any).process?.env?.ORACLE_POLICY_DISABLE !== "1";
	const DEFAULT_THINKING: ThinkingLevel = "xhigh";
	let policyApplied = false;

	const runPolicy = async (ctx: ExtensionCommandContext, force: boolean) => {
		const scoped = ctx.scopedModels?.map((entry: any) => entry.model) ?? [];
		const available =
			scoped.length > 0 ? scoped : await ctx.modelRegistry.getAvailable();
		const pick = bestEligible(available);
		const written = pick
			? await maybeWritePin(pick, DEFAULT_THINKING, force)
			: { written: false, reason: "no non-American model found in scope/catalog" };
		// Headline shows the EFFECTIVE pin (oracle.json), not the auto-policy
		// candidate — a manual /oracle model or edited oracle.json must be
		// displayed truthfully, not the would-be pick.
		const effective =
			written.written && pick
				? describe(pick)
				: ((await readJson<PolicyState>(configPaths().oracle))?.model ?? "");
		statusView(ctx, effective, pick, written);
		return { pick, written };
	};

	if (autoManaged) {
		pi.on("session_start", async (_event: any, ctx: any) => {
			if (policyApplied) return;
			policyApplied = true;
			try {
				await runPolicy(ctx, false);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`oracle-policy: ${message}`, "error");
				else console.error(`oracle-policy: ${message}`);
			}
		});
	}

	pi.registerCommand("oracle-policy", {
		description:
			"Show or refresh the oracle's auto-managed model pin (most capable non-American model)",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			const options = ["status", "refresh", "auto"];
			return options
				.filter((o) => o.startsWith(p))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args: string, ctx: any) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "refresh") return runPolicy(ctx, true);
			if (action === "auto") {
				// legacy no-op; auto-managed is the default
				return runPolicy(ctx, true);
			}
			return runPolicy(ctx, false);
		},
	});
}
