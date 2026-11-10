import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./fileWriter.js";
import { diskText } from "../util/scriptFile.js";
import { log } from "../util/log.js";

/**
 * Quack: what Studio last wrote to each script file, so `changes` can tell a game designer's
 * edits in Studio (the sync writes them to disk) from an agent's or a person's edits on disk.
 * Every session used to find uncommitted files it did not make and ask whose they were; the
 * daemon knows, because it writes those files itself.
 *
 * Kept in the place's .quack/studio-writes.json, so it survives a daemon restart, a hub restart
 * and a handoff to a new daemon. Only files git sees as changed matter: `changes` drops the rest,
 * and the oldest entries go past MAX_FILES.
 */

/** Stands for "no file" in a streak: a script Studio created */
export const ABSENT = "absent";
const MAX_FILES = 5000;
/**
 * Texts kept per streak: the first (what Studio wrote over) and the latest ones. Many, as short
 * hashes: a commit made in the middle of a long tuning session is one of them, and dropping it
 * turned every later Studio write into "mixed". A test lowers it to reach the cut
 */
export const STREAK_LIMIT = { texts: 1000 };
const SAVE_DELAY_MS = 300;

export interface StudioWrite {
  /** sha256 of the exact bytes Studio's text was written as; empty for a deletion */
  hash: string;
  /** When it was written (ms) */
  at: number;
  /** Studio removed the file (a delete, or the old file of a rename) */
  deleted?: true;
  /**
   * sha256 of each text the file held (line endings ignored) before each Studio write of this
   * streak, oldest first, ABSENT for no file. A streak is a run of Studio writes with nothing else
   * writing the file between them: its first text is what the file held before Studio began, so
   * the file is Studio's alone only when that text (or one Studio wrote since) is the commit's.
   */
  streak: string[];
  /**
   * The streak went through a merge of a Studio edit and a disk edit: the merged text's hash (line
   * endings ignored). Studio's writes after it are Studio's alone only once that text is committed.
   */
  merged?: string;
}

export const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
/**
 * A text's hash with line endings ignored (git may hold CRLF where Studio writes LF), 64 bits of
 * sha256: only compared with each other, and a streak keeps many
 */
export const textHash = (text: string): string => sha256(diskText(text)).slice(0, 16);

export class StudioWrites {
  private files = new Map<string, StudioWrite>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.load();
  }

  /** Reads the file again (a successor taking over: its predecessor wrote it since) */
  public load(): void {
    this.files.clear();
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const entries = parsed && typeof parsed.files === "object" && parsed.files ? Object.entries(parsed.files) : [];
      for (const [rel, value] of entries) {
        const w = value as StudioWrite;
        if (typeof w?.hash !== "string" || typeof w.at !== "number" || !Array.isArray(w.streak)) continue;
        // A record of the first build kept whole sha256 texts: cut to the short form compared now
        const short = (h: string) => (h.length === 64 ? h.slice(0, 16) : h);
        this.files.set(rel, { ...w, streak: w.streak.map(short), ...(typeof w.merged === "string" ? { merged: short(w.merged) } : {}) });
      }
    } catch (error) {
      log.warn(`Could not read ${this.file}; Studio's earlier writes are forgotten: ${(error as Error).message}`);
    }
  }

  /**
   * Studio's text was written to `rel` (a path from the sync folder), or the file removed
   * (`written` null). `before` is what the file held just before, undefined for no file.
   */
  public record(rel: string, written: string | null, before: string | undefined): void {
    const prev = this.files.get(rel);
    // The streak goes on when the file still held exactly what Studio last wrote (or is still gone)
    const continues = prev !== undefined && (prev.deleted ? before === undefined : before !== undefined && sha256(before) === prev.hash);
    const beforeHash = before === undefined ? ABSENT : textHash(before);
    let streak = continues ? [...prev!.streak] : [];
    if (streak[streak.length - 1] !== beforeHash) streak.push(beforeHash);
    const max = STREAK_LIMIT.texts;
    if (streak.length > max) streak = [streak[0], ...streak.slice(streak.length - max + 1)];
    const entry: StudioWrite = {
      hash: written === null ? "" : sha256(written),
      at: this.now(),
      streak,
      ...(written === null ? { deleted: true as const } : {}),
      ...(continues && prev!.merged ? { merged: prev!.merged } : {}),
    };
    // Re-inserted last: the map's order is the oldest write first
    this.files.delete(rel);
    this.files.set(rel, entry);
    while (this.files.size > MAX_FILES) this.files.delete(this.files.keys().next().value!);
    this.changed();
  }

  /** The text just written at `rel` is a merge of both sides: not Studio's alone until committed */
  public markMerged(rel: string, text: string): void {
    const entry = this.files.get(rel);
    if (!entry) return;
    this.files.set(rel, { ...entry, merged: textHash(text) });
    this.changed();
  }

  public get(rel: string): StudioWrite | undefined {
    return this.files.get(rel);
  }

  /** The entries as they are now, for keepOnly to tell the ones written since */
  public snapshot(): Map<string, StudioWrite> {
    return new Map(this.files);
  }

  /**
   * Drops the files not named (the ones git no longer sees as changed), only those still as in
   * `seen`: a file Studio wrote while git was being asked is kept. Returns how many went.
   */
  public keepOnly(keep: Set<string>, seen: Map<string, StudioWrite>): number {
    let dropped = 0;
    for (const [rel, entry] of seen) {
      if (keep.has(rel) || this.files.get(rel) !== entry) continue;
      this.files.delete(rel);
      dropped++;
    }
    if (dropped) this.changed();
    return dropped;
  }

  public get size(): number {
    return this.files.size;
  }

  private changed(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  /** Writes the file now if anything changed (before a stop or a handoff) */
  public flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify({ version: 1, files: Object.fromEntries(this.files) }));
      this.dirty = false;
    } catch (error) {
      // Still owed: the next write, or the flush at the stop, tries again
      log.warn(`Could not save ${this.file}:`, error);
    }
  }
}
