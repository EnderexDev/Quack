import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * What the app reads from a game's folder: the daemon log, the merge log and the conflict
 * copies the daemon saves under .quack/. Only reads files, except resolving a conflict, which
 * writes the saved disk version back into the sync folder (the daemon then sends it to Studio
 * like any other save).
 */

/** First read of a log: its last 64 KB. Later reads: whatever was appended, up to 1 MB. */
const LOG_FIRST_READ = 64 * 1024;
const LOG_MAX_READ = 1024 * 1024;
/**
 * The merge log is read whole (cached until it changes), so an unresolved conflict stays listed
 * however many merges came after it; only a log past this size is read from its tail
 */
const MERGE_LOG_MAX = 64 * 1024 * 1024;
/** Summaries kept for this many folders; folders come and go with the registry */
const MERGE_CACHE_FOLDERS = 64;
const MERGES_RETURNED = 200;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (text: string) => text.replace(ANSI, "");

export interface LogChunk {
  text: string;
  /** Pass back as `from` to get only what comes after */
  next: number;
  /** True when the log was cut or replaced since `from`: the app starts its view over */
  reset: boolean;
}

/**
 * The daemon log from byte `from` on; no `from` (or one past the end of a cut log) reads the tail.
 * `keepAnsi` leaves the colour codes in: a playtest warning or error is told apart only by them.
 */
export function readLogChunk(folder: string, from?: number, keepAnsi = false): LogChunk {
  const file = path.join(folder, ".quack", "daemon.log");
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { text: "", next: 0, reset: from !== undefined && from > 0 };
  }
  let start: number;
  let reset = false;
  if (from === undefined || from > size) {
    start = Math.max(0, size - LOG_FIRST_READ);
    reset = from !== undefined;
  } else {
    start = from;
  }
  const end = Math.min(size, start + LOG_MAX_READ);
  if (end <= start) return { text: "", next: start, reset };

  const buffer = Buffer.alloc(end - start);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  // Cut on bytes, before decoding: a read can end inside a UTF-8 character, and counting the
  // decoded text back into bytes would then be off
  let first = 0;
  // A tail read starts mid-line: drop the partial first line
  if ((from === undefined || reset) && start > 0) {
    const firstBreak = buffer.indexOf(0x0a);
    if (firstBreak >= 0) first = firstBreak + 1;
  }
  // Hand out whole lines only: stop after the last line break
  let consumed = buffer.lastIndexOf(0x0a) + 1;
  if (consumed <= first) {
    // No line ends in a full-size read: one line longer than the cap. It goes out in pieces,
    // or the cursor would never move past it
    if (buffer.length < LOG_MAX_READ) return { text: "", next: start + first, reset };
    consumed = utf8Boundary(buffer);
  }
  const text = buffer.subarray(first, consumed).toString("utf8");
  return { text: keepAnsi ? text : stripAnsi(text), next: start + consumed, reset };
}

/** The end of the last whole UTF-8 character in the buffer: a piece never splits one */
function utf8Boundary(buffer: Buffer): number {
  let lead = buffer.length - 1;
  while (lead > 0 && (buffer[lead] & 0xc0) === 0x80) lead--;
  const byte = buffer[lead];
  const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return lead + size > buffer.length ? lead : buffer.length;
}

export interface MergeEntry {
  t: string;
  file: string;
  method: string;
  conflictingHunks?: number;
  ms?: number;
  /** The saved disk version, relative to the game folder; also the conflict's id */
  agentVersion?: string;
  error?: string;
  resolved?: boolean;
}

export interface MergeSummary {
  /** Newest first */
  entries: MergeEntry[];
  today: number;
  /** Merges that saved a disk version nobody has looked at yet, newest first */
  conflicts: MergeEntry[];
}

const mergeCache = new Map<string, { key: string; summary: MergeSummary }>();

function readTail(file: string, bytes: number): string {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const buffer = Buffer.alloc(size - start);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const text = buffer.toString("utf8");
  return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
}

function resolvedFile(folder: string): string {
  return path.join(folder, ".quack", "resolved.json");
}

function readResolved(folder: string): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedFile(folder), "utf8"));
    return new Set(Array.isArray(parsed?.ids) ? parsed.ids.filter((id: unknown) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function statKey(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/** The merge log summed up; cached until the log or the resolved list changes (the app polls) */
export function readMerges(folder: string, now = new Date()): MergeSummary {
  const logFile = path.join(folder, ".quack", "merge-log.jsonl");
  const key = `${statKey(logFile)}|${statKey(resolvedFile(folder))}|${now.toDateString()}`;
  const cached = mergeCache.get(folder);
  if (cached?.key === key) return cached.summary;

  const resolved = readResolved(folder);
  const entries: MergeEntry[] = [];
  let text = "";
  try {
    text = readTail(logFile, MERGE_LOG_MAX);
  } catch {
    // no merges yet
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.t !== "string" || typeof entry?.file !== "string") continue;
      entries.push({
        t: entry.t,
        file: entry.file,
        method: typeof entry.method === "string" ? entry.method : "unknown",
        ...(typeof entry.conflictingHunks === "number" ? { conflictingHunks: entry.conflictingHunks } : {}),
        ...(typeof entry.ms === "number" ? { ms: entry.ms } : {}),
        ...(typeof entry.agentVersion === "string" ? { agentVersion: entry.agentVersion, resolved: resolved.has(entry.agentVersion) } : {}),
        ...(typeof entry.error === "string" ? { error: entry.error } : {}),
      });
    } catch {
      // a line cut by a crash: skip it
    }
  }
  entries.reverse();
  const today = now.toDateString();
  const summary: MergeSummary = {
    entries: entries.slice(0, MERGES_RETURNED),
    today: entries.filter((e) => new Date(e.t).toDateString() === today).length,
    conflicts: entries.filter((e) => e.agentVersion && !e.resolved),
  };
  if (mergeCache.size >= MERGE_CACHE_FOLDERS && !mergeCache.has(folder)) mergeCache.clear();
  mergeCache.set(folder, { key, summary });
  return summary;
}

/** The sync folder of a game, from the same user config the daemon reads */
export function syncDirOf(folder: string): string {
  let syncDir = "./sync";
  try {
    const root = process.platform === "win32"
      ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
      : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
    const config = JSON.parse(fs.readFileSync(path.join(root, "quack", "config.json"), "utf8"));
    if (typeof config?.syncDir === "string" && config.syncDir.trim()) syncDir = config.syncDir;
  } catch {
    // default
  }
  return path.resolve(folder, syncDir);
}

/** A path from a request, kept inside `root`; undefined when it would leave it */
function inside(root: string, relative: string): string | undefined {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return target;
}

/**
 * The same check on the real path, symlinks resolved: a link inside the game folder must not
 * let a read or a write land outside it. A path not created yet is judged by the nearest
 * folder above it that exists.
 */
function insideReal(root: string, target: string): boolean {
  // The root may be missing too (a deleted sync folder, which useDisk recreates)
  const realRoot = realThroughAncestor(root);
  const realTarget = realThroughAncestor(target);
  if (!realRoot || !realTarget) return false;
  return inside(realRoot, path.relative(realRoot, realTarget)) !== undefined;
}

/** A path with the links of its nearest existing ancestor resolved, the missing rest kept as is */
function realThroughAncestor(target: string): string | undefined {
  let probe = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(probe), path.relative(probe, target));
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return undefined;
      probe = parent;
    }
  }
}

export interface ConflictView {
  id: string;
  file: string;
  /** Absolute path of the script, for opening it in an editor */
  path: string;
  /** The script as it is now on disk (what Studio has), or null if it is gone */
  current: string | null;
  /** The disk version the merge did not keep */
  saved: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function conflictEntry(folder: string, id: string): { entry: MergeEntry; savedPath: string; filePath: string } {
  if (!id.startsWith(".quack/conflicts/")) throw new ApiError(400, "not a conflict id");
  const savedPath = inside(folder, id);
  if (!savedPath) throw new ApiError(400, "not a conflict id");
  // Unresolved conflicts are kept whole, past the 200 entries of history the app lists
  const merges = readMerges(folder);
  const entry = merges.conflicts.find((e) => e.agentVersion === id) ?? merges.entries.find((e) => e.agentVersion === id);
  if (!entry) throw new ApiError(404, "no merge saved this version");
  const syncDir = syncDirOf(folder);
  const filePath = inside(syncDir, entry.file);
  if (!filePath) throw new ApiError(400, "the merge names a file outside the sync folder");
  if (!insideReal(folder, savedPath) || !insideReal(syncDir, filePath)) {
    throw new ApiError(400, "a link leads outside the game folder");
  }
  return { entry, savedPath, filePath };
}

export function readConflict(folder: string, id: string): ConflictView {
  const { entry, savedPath, filePath } = conflictEntry(folder, id);
  let saved: string;
  try {
    saved = fs.readFileSync(savedPath, "utf8");
  } catch {
    throw new ApiError(404, "the saved version is gone");
  }
  let current: string | null = null;
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch {
    // deleted since
  }
  return { id, file: entry.file, path: filePath, current, saved };
}

/** "useDisk" writes the saved version over the script; both actions mark the conflict seen */
export function resolveConflict(folder: string, id: string, action: "useDisk" | "keep"): void {
  const { savedPath, filePath } = conflictEntry(folder, id);
  if (action === "useDisk") {
    let saved: string;
    try {
      saved = fs.readFileSync(savedPath, "utf8");
    } catch {
      throw new ApiError(404, "the saved version is gone");
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Atomic, with the daemon's own temp name (fs/fileWriter.ts) so its watcher skips it;
    // not imported from there because that module loads the daemon's config
    const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.quack-tmp-${randomBytes(6).toString("hex")}`);
    try {
      fs.writeFileSync(temp, saved, { encoding: "utf8", flag: "wx" });
      fs.renameSync(temp, filePath);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }
  const resolved = readResolved(folder);
  resolved.add(id);
  const file = resolvedFile(folder);
  if (!insideReal(folder, path.dirname(file))) throw new ApiError(400, "a link leads outside the game folder");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Through a temp file and a rename: the rename replaces a link planted at resolved.json
  // instead of writing through it
  const temp = path.join(path.dirname(file), `.resolved.json.quack-tmp-${randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ ids: [...resolved] }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
