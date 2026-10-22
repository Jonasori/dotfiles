/**
 * sticky-rules — the user's only approved form of persistent memory.
 *
 * One mechanism, four parts (framing agreed 2026-08-19):
 *  - DETECT: the model itself. A protocol block appended at the END of the
 *    system prompt on every agent start tells it when a correction is
 *    persistent ("you keep …", "/stopit") vs. one-off. No regex (user decision).
 *  - DISTILL: one line, "Never X. Instead: Y." — deduped against existing
 *    rules at write time (case-insensitive substring overlap, both directions).
 *  - PERSIST: <agentDir>/LEARNED_RULES.md — tracked in dotfiles, symlinked,
 *    one rule per line; "#"-comment lines ignored on injection. No cap
 *    (user decision); the tool reports the running count for visibility.
 *  - INJECT: before_agent_start appends protocol + rules after the existing
 *    system prompt tail (recency position). Byte-stable while the file is
 *    unchanged → prompt cache unaffected; a new rule invalidates the next
 *    turn's cache exactly once, then stabilizes.
 *
 * Tool: sticky_rule { action: add|remove|list, rule?, match? }.
 * Slash entry point: /stopit (prompts/stopit.md).
 * Bench-detected failures only PROPOSE rules (scorecard candidates) — they
 * never auto-promote; the user accepts via /stopit or file edit.
 */
import {
	readFileSync,
	writeFileSync,
	renameSync,
	mkdirSync,
	realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Resolve the rules file from the extension's REAL location (dotfiles
// checkout), never through the ~/.pi/agent symlink: rename() onto a symlink
// path replaces the link instead of the target, orphaning the file.
const RULES_FILE = join(
	dirname(realpathSync(fileURLToPath(import.meta.url))),
	"..",
	"LEARNED_RULES.md",
);
const MAX_RULE_LEN = 240;

const PROTOCOL = `## Learned corrections (persistent)
- The user permits exactly one form of persistent memory: these corrections. If the user corrects a behavior pattern — "you keep …", "stop …", "never … again", a /stopit invocation, or "what I want different" — treat it as a persistent rule, not one-off feedback. Distill it to one line — "Never X. Instead: Y." — and call sticky_rule with action=add.
- One-off task feedback (a fix was wrong, a test fails, an approach was rejected) is NOT a pattern. Do not call sticky_rule for those.
- If the user says to forget or undo a rule, call sticky_rule with action=remove. If they ask what is pinned, call sticky_rule with action=list.
- If you catch yourself about to break one of the rules below, name it and stop.`;

// Keep the file's '#' comment header across writes — rules are the only
// mutable part.
function readFileLines(): string[] {
	try {
		return readFileSync(RULES_FILE, "utf8")
			.split("\n")
			.map((l) => l.trim());
	} catch {
		return [];
	}
}

function readRules(): string[] {
	return readFileLines().filter((l) => l.length > 0 && !l.startsWith("#"));
}

function writeRules(lines: string[]): void {
	const comments = readFileLines().filter((l) => l.startsWith("#"));
	mkdirSync(dirname(RULES_FILE), { recursive: true });
	const tmp = `${RULES_FILE}.tmp`;
	writeFileSync(tmp, [...comments, ...lines].join("\n") + "\n");
	renameSync(tmp, RULES_FILE);
}

function normalize(rule: string): string {
	return rule.replace(/\s+/g, " ").trim();
}

function findOverlap(rules: string[], rule: string): number {
	const needle = rule.toLowerCase();
	for (let i = 0; i < rules.length; i++) {
		const hay = rules[i].toLowerCase();
		if (hay.includes(needle) || needle.includes(hay)) return i;
	}
	return -1;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const rules = readRules();
		const bullets = rules.length
			? rules.map((r) => `- ${r}`).join("\n")
			: "- (none yet)";
		const block = `${PROTOCOL}\n\nRules:\n${bullets}`;
		return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
	});

	pi.registerTool({
		name: "sticky_rule",
		label: "Sticky rule",
		description:
			"Manage persistent behavioral corrections (the only approved memory — pinned rules are injected into every future session's system prompt). add: distill a one-line rule, 'Never X. Instead: Y.' — dedupes automatically. remove: delete a rule by matching its text. list: show all pinned rules. Only use add when the user frames a behavior as persistent ('you keep…', 'never… again', '/stopit'); never for one-off task feedback.",
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("add"), Type.Literal("remove"), Type.Literal("list")],
				{
					description: "What to do",
				},
			),
			rule: Type.Optional(
				Type.String({
					description: "One-line rule for action=add: 'Never X. Instead: Y.'",
				}),
			),
			match: Type.Optional(
				Type.String({ description: "Text identifying the rule for action=remove" }),
			),
		}),
		async execute(
			_toolCallId,
			params: { action: string; rule?: string; match?: string },
		) {
			const rules = readRules();

			if (params.action === "list") {
				const body = rules.length
					? rules.map((r, i) => `${i + 1}. ${r}`).join("\n")
					: "No learned corrections yet.";
				return {
					content: [{ type: "text", text: body }],
					details: { count: rules.length },
				};
			}

			if (params.action === "add") {
				if (!params.rule || normalize(params.rule).length === 0) {
					return {
						content: [
							{
								type: "text",
								text:
									"error: rule must be non-empty — /stopit requires a description of what the user wants different",
							},
						],
						details: {},
					};
				}
				const rule = normalize(params.rule);
				if (rule.length > MAX_RULE_LEN) {
					return {
						content: [
							{
								type: "text",
								text: `error: rule exceeds ${MAX_RULE_LEN} chars — shorten to a single line`,
							},
						],
						details: {},
					};
				}
				const dup = findOverlap(rules, rule);
				if (dup >= 0) {
					return {
						content: [
							{
								type: "text",
								text: `already covered by rule ${dup + 1}: "${rules[dup]}" — no change`,
							},
						],
						details: { count: rules.length },
					};
				}
				rules.push(rule);
				writeRules(rules);
				return {
					content: [
						{
							type: "text",
							text: `added rule ${rules.length}: "${rule}" — pinned in ${RULES_FILE} (${rules.length} total)`,
						},
					],
					details: { count: rules.length },
				};
			}

			if (params.action === "remove") {
				if (!params.match || !params.match.trim()) {
					return {
						content: [
							{
								type: "text",
								text: "error: remove needs match — text identifying the rule",
							},
						],
						details: {},
					};
				}
				const needle = params.match.toLowerCase();
				const idx = rules.findIndex((r) => r.toLowerCase().includes(needle));
				if (idx < 0) {
					return {
						content: [
							{
								type: "text",
								text: `no rule matches "${params.match}". Current rules:\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n") || "(none)"}`,
							},
						],
						details: { count: rules.length },
					};
				}
				const [removed] = rules.splice(idx, 1);
				writeRules(rules);
				return {
					content: [
						{
							type: "text",
							text: `removed rule ${idx + 1}: "${removed}" (${rules.length} remain)`,
						},
					],
					details: { count: rules.length },
				};
			}

			return {
				content: [
					{ type: "text", text: `error: unknown action "${params.action}"` },
				],
				details: {},
			};
		},
	});
}
