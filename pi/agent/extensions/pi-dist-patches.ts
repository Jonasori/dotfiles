/**
 * pi-dist-patches — reapplies local patches that an install step wipes: pi's
 * dist files (`pi update --self/--all` npm-installs the package over itself in
 * place) and the extension manifests in the pi npm store (any `pi install`,
 * `pi remove`, or `pi update --extensions` reinstalls node_modules from the
 * registry).
 *
 * Runs the shared, marker-based patcher at every session start:
 *   <dotfiles>/pi/reapply-pi-patches.sh
 *
 * The patcher is idempotent and refuses to touch files whose shape changed,
 * so this never corrupts a new release — at worst it does nothing. The
 * ~/.zshrc `pi` wrapper re-applies immediately after a shell `pi update`;
 * this extension is the backstop for updates from any other path (it fires on
 * the next launch and toasts what happened, so nothing is silently forgotten).
 *
 * Env:
 *   PI_DIST_PATCHES_OFF=1 -> disable the self-heal check
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED = process.env.PI_DIST_PATCHES_OFF === "1";

const HOME_FALLBACK = process.env.HOME ? join(process.env.HOME, "dotfiles", "pi", "reapply-pi-patches.sh") : undefined;

function patcherScriptPath(): string | undefined {
	try {
		// This file:  <dotfiles>/pi/agent/extensions/pi-dist-patches.ts
		// Script:     <dotfiles>/pi/reapply-pi-patches.sh  (3 levels up)
		const here = fileURLToPath(import.meta.url);
		return join(dirname(dirname(dirname(here))), "reapply-pi-patches.sh");
	} catch {
		return HOME_FALLBACK;
	}
}

export default function piDistPatches(pi: ExtensionAPI) {
	if (DISABLED) return;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx?.hasUI) return;
		const script = patcherScriptPath();
		if (!script) return;
		try {
			const result = spawnSync("bash", [script], {
				encoding: "utf8",
				timeout: 15_000,
			});
			if (result.status === 2) {
				ctx.ui.notify(
					"reapplied local pi patches — restart pi (or /reload) to see it",
					"info",
				);
			} else if (result.status === 3) {
				ctx.ui.notify(
					"pi patch check: upstream changed a patched file — run ~/dotfiles/pi/reapply-pi-patches.sh to inspect",
					"warning",
				);
			}
		} catch {
			// Self-heal must never take pi down; failures are ignored.
		}
	});
}
