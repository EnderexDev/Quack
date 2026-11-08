import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * What the queue reads from a folder on disk: its scripts' hashes (a play is joined only while
 * none a job depends on changed since it started), the sourcemap (which instance a file is, which
 * file an error names), and the scripts a worktree's branch changed (which worktrees can share a
 * play).
 */

/**
 * FNV-1a over the bytes with every \r removed: the same function the sync check computes in
 * Studio over .Source, so disk and Studio are compared without shipping the texts.
 */
export function fnv1a(text: string): number {
  const bytes = Buffer.from(String(text).replace(/\r/g, ""), "utf8");
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Two folders are the same one on NTFS whatever their case and slashes */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** Every script under the folder's sync/ ("sync/A/B.luau" -> hash) */
export function hashAll(folder: string): Map<string, number> {
  const map = new Map<string, number>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(folder, "sync"), { recursive: true }) as string[];
  } catch {
    return map;
  }
  for (const name of names) {
    if (!String(name).endsWith(".luau")) continue;
    const rel = ("sync/" + String(name)).replace(/\\/g, "/");
    try {
      map.set(rel, fnv1a(fs.readFileSync(path.join(folder, rel), "utf8")));
    } catch {
      // deleted between the listing and the read
    }
  }
  return map;
}

/** Scripts under sync/ modified since `since` */
export function recentFiles(folder: string, since: number): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(folder, "sync"), { recursive: true }) as string[];
  } catch {
    return out;
  }
  for (const name of names) {
    if (!String(name).endsWith(".luau")) continue;
    try {
      if (fs.statSync(path.join(folder, "sync", String(name))).mtimeMs >= since) out.push(("sync/" + String(name)).replace(/\\/g, "/"));
    } catch {
      // gone
    }
  }
  return out;
}

export interface Sourcemap {
  /** "sync/A/B.luau" -> the instance's names from the service down */
  byFile: Map<string, string[]>;
  /** "A.B" -> its file */
  byInstance: Map<string, string>;
  ok: boolean;
}

export function loadSourcemap(folder: string): Sourcemap {
  const byFile = new Map<string, string[]>();
  const byInstance = new Map<string, string>();
  let map: any;
  try {
    map = JSON.parse(fs.readFileSync(path.join(folder, "sourcemap.json"), "utf8"));
  } catch {
    return { byFile, byInstance, ok: false };
  }
  (function walk(node: any, names: string[]) {
    for (const child of node?.children ?? []) {
      const p = [...names, String(child.name)];
      for (const file of child.filePaths ?? []) {
        const rel = String(file).replace(/\\/g, "/");
        byFile.set(rel, p);
        byInstance.set(p.join("."), rel);
      }
      walk(child, p);
    }
  })(map, []);
  return { byFile, byInstance, ok: true };
}

/**
 * The first module an error names that is not one of the job's files. A module the sourcemap
 * does not know (made in Studio, never synced) counts too, with no file, unless it sits inside
 * one of the job's own modules. A job with no file list claims every script: null.
 */
export function foreignIn(text: string, files: string[] | null, sourcemap: Sourcemap): { instance: string; file: string | null } | null {
  if (!files) return null;
  const mine = new Set(files);
  const mineInstances = files.map((f) => sourcemap.byFile.get(f)?.join(".")).filter((p): p is string => Boolean(p));
  const roots = "ServerStorage|ServerScriptService|ReplicatedStorage|ReplicatedFirst|StarterPlayer|StarterGui|Workspace";
  // A traceback names a module up to ":<line>", and a name may hold spaces or hyphens
  // ("ServerStorage.Inventory Config:3:"); a path with no line number is read word by word
  const full = [...String(text).matchAll(new RegExp(`\\b((?:${roots})(?:\\.[\\w -]+?)+)(?=:\\d)`, "g"))];
  const starts = new Set(full.map((m) => m.index));
  const named = [
    ...full.map((m) => m[1]),
    // A word-by-word read of a name already read whole is its own first words, not another module
    ...[...String(text).matchAll(new RegExp(`\\b((?:${roots})(?:\\.\\w+)+)`, "g"))].filter((m) => !starts.has(m.index)).map((m) => m[1]),
  ];
  for (const m of named.map((name) => [name, name] as const)) {
    // The eval's own module: the job's code
    if (m[1].includes("__QuackEval")) continue;
    const parts = m[1].split(".");
    let known = false;
    for (let n = parts.length; n > 0; n--) {
      const file = sourcemap.byInstance.get(parts.slice(0, n).join("."));
      if (file) {
        known = true;
        if (!mine.has(file)) return { instance: parts.slice(0, n).join("."), file };
        break;
      }
    }
    if (!known && !mineInstances.some((p) => m[1] === p || m[1].startsWith(p + "."))) return { instance: m[1], file: null };
  }
  return null;
}

const SCRIPT = /\.(luau|lua)$/i;

/** The instance a script file lands on: Foo.luau, Foo.server.luau and Foo.client.luau are one script; no case on NTFS */
export function scriptKey(rel: string): string {
  return String(rel)
    .replace(/\\/g, "/")
    .replace(/\.(server|client)?\.?(luau|lua)$/i, "")
    .replace(/\/init$/i, "")
    .toLowerCase();
}

/** git, without blocking the hub: its API and its lock ticks keep answering meanwhile */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]} in ${cwd}: ${(stderr || error.message || "failed").trim()}`));
      else resolve(stdout);
    });
  });
}

/**
 * The scripts `folder`'s branch changed since it forked from `syncedRoot`'s HEAD, committed or
 * not (merge-base, diff --name-only, under sync/), as the play's overlay reads them: an untracked
 * script is left out here as the play leaves it out. Null when git cannot say: that folder then
 * plays alone.
 */
export async function changedScripts(folder: string, syncedRoot: string): Promise<Set<string> | null> {
  try {
    const head = (await git(syncedRoot, ["rev-parse", "HEAD"])).trim();
    const base = (await git(folder, ["merge-base", "HEAD", head])).trim();
    const names = (await git(folder, ["diff", "--name-only", "-z", "--no-renames", base, "--", "sync"])).split("\0").filter(Boolean);
    return new Set(names.filter((n) => SCRIPT.test(n)).map(scriptKey));
  } catch {
    return null;
  }
}

export interface GroupCandidate {
  folder: string;
  files: Set<string> | null;
  fresh: boolean;
}

/**
 * Which worktrees share a play: greedy in arrival order, each joins the first group whose
 * scripts it does not touch. A worktree with a `fresh` job wants a play of its own start, so a
 * group holds at most one, and it goes first. One git could not read plays alone.
 */
export function planGroups<T extends GroupCandidate>(candidates: T[], max = 6): T[][] {
  const groups: { items: T[]; keys: Set<string>; fresh: boolean }[] = [];
  for (const c of candidates) {
    const home = c.files
      ? groups.find((g) => g.items.length < max && g.items[0].files && !(c.fresh && g.fresh) && ![...c.files!].some((k) => g.keys.has(k)))
      : undefined;
    if (home) {
      if (c.fresh) {
        home.items.unshift(c);
        home.fresh = true;
      } else home.items.push(c);
      for (const k of c.files!) home.keys.add(k);
    } else groups.push({ items: [c], keys: new Set(c.files ?? []), fresh: c.fresh });
  }
  return groups.map((g) => g.items);
}

/**
 * A job file: `--!` header lines, then a Luau chunk returning { setup, client, check, cleanup }.
 *     --! name: equip best picks the rare sword
 *     --! files: sync/ReplicatedStorage/.../InventoryService.luau, sync/.../InventoryConfig.luau
 *     --! fresh
 * Without a `files` line any change under sync/ since the play started counts as the job's.
 */
export function parseJob(source: string, fallbackName: string): { name: string; files: string[] | null; fresh: boolean } {
  const meta = { name: fallbackName, files: null as string[] | null, fresh: false };
  for (const line of source.split(/\r?\n/)) {
    const m = /^--!\s*(\w+)\s*(?::\s*(.*))?$/.exec(line.trim());
    if (!m) continue;
    const [, key, value = ""] = m;
    if (key === "name" && value.trim()) meta.name = value.trim();
    else if (key === "files") meta.files = value.split(",").map((f) => f.trim().replace(/\\/g, "/")).filter(Boolean);
    else if (key === "fresh") meta.fresh = true;
  }
  return meta;
}

/** A job's file list as the queue can track it: scripts under sync/, plain paths */
export function untrackable(files: string[]): string[] {
  return files.filter((f) => !/^sync\/.+\.luau$/.test(f) || path.posix.normalize(f) !== f || f.split("/").includes(".."));
}
