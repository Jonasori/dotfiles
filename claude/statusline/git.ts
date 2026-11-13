/**
 * git.ts — branch, stash count and last commit time for the status line.
 *
 * Branch and stash count are read from .git directly. The commit time needs git
 * itself, so it is cached by commit id in a file shared by every session: one
 * `git` call per new commit, none otherwise. Reftable repos keep refs in binary
 * tables, so there git is asked once per change to those tables.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface GitInfo { root: string; branch: string; stash: number; head: string; gitDir: string }

const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

function findGitDir(start: string): { root: string; gitDir: string } | undefined {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const dotgit = join(dir, ".git");
    if (existsSync(dotgit)) {
      // A .git without a HEAD (an empty dir, a worktree whose repo was deleted) is
      // not a repository; git keeps walking up past it, and so does this.
      const gitDir = statSync(dotgit).isDirectory() ? dotgit : resolve(dir, read(dotgit).match(/^gitdir: (.+)$/m)?.[1].trim() ?? "");
      if (existsSync(join(gitDir, "HEAD"))) return { root: dir, gitDir };
    }
    if (dirname(dir) === dir) return undefined;
  }
}

function refSha(common: string, ref: string): string {
  const loose = read(join(common, ref)).trim();
  if (loose) return loose;
  const line = read(join(common, "packed-refs")).split("\n").find((l) => l.endsWith(` ${ref}`));
  return line?.split(" ")[0] ?? "";
}

function cached<T>(path: string, key: string, compute: () => T): T {
  if (existsSync(path)) {
    try {
      const c = JSON.parse(readFileSync(path, "utf8"));
      if (c.key === key) return c.value;
    } catch { /* rewritten below */ }
  }
  const value = compute();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.${process.pid}`, JSON.stringify({ key, value }));
  renameSync(`${path}.${process.pid}`, path);
  return value;
}

const cachePath = (cacheDir: string, kind: string, gitDir: string) => join(cacheDir, "git", `${kind}-${Bun.hash(gitDir).toString(36)}.json`);
const git = (root: string, ...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args], { stderr: "ignore" }).stdout.toString().trim();

export function gitInfo(cwd: string, cacheDir: string): GitInfo | undefined {
  const found = findGitDir(cwd);
  if (!found) return undefined;
  const { root, gitDir } = found;
  // Worktrees keep HEAD in their own dir and refs, stash and packed-refs in the main one.
  const common = existsSync(join(gitDir, "commondir")) ? resolve(gitDir, read(join(gitDir, "commondir")).trim()) : gitDir;
  const tables = join(common, "reftable", "tables.list");
  if (existsSync(tables)) {
    const key = `${statSync(tables).mtimeMs} ${read(join(gitDir, "HEAD"))}`;
    return cached(cachePath(cacheDir, "reftable", gitDir), key, () => {
      const stash = git(root, "reflog", "--format=x", "refs/stash");
      return {
        root,
        gitDir,
        branch: git(root, "symbolic-ref", "--short", "-q", "HEAD") || "detached", // also right on an unborn branch
        stash: stash ? stash.split("\n").length : 0,
        head: git(root, "rev-parse", "-q", "--verify", "HEAD"),
      };
    });
  }
  const head = read(join(gitDir, "HEAD")).trim();
  const ref = head.startsWith("ref: refs/heads/") ? head.slice("ref: ".length) : "";
  return {
    root,
    gitDir,
    branch: ref ? ref.slice("refs/heads/".length) : "detached",
    stash: read(join(common, "logs/refs/stash")).split("\n").filter(Boolean).length,
    head: ref ? refSha(common, ref) : head,
  };
}

// Commit time of HEAD in epoch seconds, 0 on an unborn branch.
export function lastCommit(g: GitInfo, cacheDir: string): number {
  return cached(cachePath(cacheDir, "commit", g.gitDir), g.head, () => Number(git(g.root, "log", "-1", "--format=%ct")) || 0);
}
