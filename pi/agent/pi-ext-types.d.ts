// Ambient type shim for pi extension development in this repo.
// The pi runtime provides these modules to extensions at load time, but the
// repo intentionally has no node_modules (dotfiles; portable — installing one
// would also shadow the loader's own module resolution). This file types ONLY
// the surface this repo's extensions actually use, verified against the
// installed pi's dist/core/extensions/types.d.ts (v0.84.2). If the real API
// grows, extend here; do NOT install node_modules.

declare module "typebox" {
	export const Type: {
		Object(
			props: Record<string, unknown>,
			opts?: Record<string, unknown>,
		): unknown;
		String(opts?: Record<string, unknown>): unknown;
		Literal(value: string): unknown;
		Union(types: unknown[], opts?: Record<string, unknown>): unknown;
		Optional(t: unknown): unknown;
	};
}

declare module "node:fs" {
	export function readFileSync(path: string, encoding: string): string;
	export function writeFileSync(path: string, data: string): void;
	export function renameSync(oldPath: string, newPath: string): void;
	export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
	export function realpathSync(path: string): string;
	export const promises: {
		mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
		readFile(path: string, encoding: "utf8"): Promise<string>;
		readFile(path: string, encoding?: undefined): Promise<string | Uint8Array>;
		writeFile(
			path: string,
			data: string,
			opts?: string | Record<string, unknown>,
		): Promise<void>;
	};
}

declare module "node:url" {
	export function fileURLToPath(url: string | URL): string;
}

declare module "node:path" {
	export function join(...parts: string[]): string;
	export function dirname(p: string): string;
	export function resolve(...parts: string[]): string;
	export function relative(from: string, to: string): string;
}

declare module "@earendil-works/pi-coding-agent" {
	export function getAgentDir(): string;

	export interface ExtensionCommandContext {
		hasUI: boolean;
		ui: { notify(message: string, level?: string): unknown };
		scopedModels: readonly unknown[];
		modelRegistry: { getAvailable(): Promise<unknown[]> };
	}

	export interface ExtensionAPI {
		on(event: string, handler: (event: any, ctx: any) => unknown): void;
		registerTool(
			tool:
				| {
						name: string;
						label: string;
						description: string;
						parameters: unknown;
						execute(
							toolCallId: string,
							params: Record<string, unknown>,
							signal: AbortSignal,
							onUpdate: (update: unknown) => void,
							ctx: unknown,
						): Promise<{
							content: Array<{ type: string; text: string }>;
							details: Record<string, unknown>;
						}>;
				  }
				| Record<string, unknown>,
		): void;
		registerCommand(
			name: string,
			cmd: {
				description: string;
				handler(args: string, ctx: ExtensionCommandContext): unknown;
				getArgumentCompletions?(
					prefix: string,
				): Array<{ value: string; label: string }>;
			},
		): void;
	}
}
