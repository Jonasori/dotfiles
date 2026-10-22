// Minimal ambient types for the Node/Bun runtime surface tui.ts uses.
// By design this file carries no dependency on @types/node: the TUI is a
// zero-dep reference, and bun runs it directly. tui.ts pulls it in with
// `/// <reference path="./env.d.ts" />` so it applies even when a host
// type-checker compiles the file without consulting tsconfig.json.
//
// This is a SCRIPT-format .d.ts on purpose: top-level `declare module` blocks
// create the ambient modules, and everything else lands on the global scope.
// Adding `export {}` would flip it to a module and demote those blocks to
// module augmentation of packages that do not exist.

declare module "node:child_process" {
  export interface SpawnSyncResult {
    error?: Error;
  }
  export function spawnSync(
    command: string,
    options: { input: string; timeout: number; maxBuffer: number },
  ): SpawnSyncResult;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { isFile(): boolean };
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, encoding: "utf8"): void;
  export function mkdirSync(path: string): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}

declare module "node:os" {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export const sep: string;
}

// Merges as an overload with whatever timers the host lib declares.
declare function setInterval(callback: () => void, ms?: number): unknown;
declare function clearInterval(id: unknown): void;

interface Stdin {
  isTTY: boolean;
  setRawMode(mode: boolean): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
}

interface Stdout {
  isTTY: boolean;
  columns: number;
  rows: number;
  write(text: string): void;
  on(event: "resize", listener: () => void): void;
}

declare const process: {
  stdin: Stdin;
  stdout: Stdout;
  platform: string;
  argv: string[];
  cwd(): string;
  exit(code: number): never;
  on(event: string, listener: () => void): void;
};

// The slice of the runtime Buffer type the file touches: bytes you can
// iterate and re-encode. bun supplies the real thing.
interface Buffer {
  toString(encoding: string): string;
  [Symbol.iterator](): IterableIterator<number>;
}

declare const Buffer: {
  from(data: string, encoding: string): Buffer;
};
