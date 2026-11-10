import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ABSENT, sha256, textHash, type StudioWrite, type StudioWrites } from "./fs/studioWrites.js";
import { numbersOnly } from "./util/luauNumbers.js";
import { diskText } from "./util/scriptFile.js";

/**
 * Quack: `changes`. The files git sees as changed in a place's sync folder, each marked by who
 * changed it, from what the daemon itself wrote there when Studio changed a script:
 * - studio: Studio wrote it and nothing touched it since; from the commit, only Studio changed it
 * - mixed: Studio wrote it, but the disk changed it since, or the file already held someone's
 *   uncommitted edit when Studio began writing it, or it is a merge of both sides
 * - other: not from Studio at all (an agent, a person, git)
 * The commit stays the caller's: this only says whose each change is.
 */

export type ChangeOrigin = "studio" | "mixed" | "other";

export interface ChangedFile {
  /** From the repository's root, as git prints it (ready for `git add`) */
  path: string;
  /** git's two status letters: " M", "??", " D", "M "... */
  status: string;
  origin: ChangeOrigin;
  /** Why mixed, or what Studio did */
  note: string;
  /** When Studio last wrote it (ms) */
  writtenAt?: number;
  /** With numbersOnly: whether Studio's change to it is only numbers (and if not, why) */
  numbersOnly?: boolean;
  numbersNote?: string;
}

export type ChangesResult =
  | { git: false; syncDir: string; note: string }
  | { git: true; root: string; syncDir: string; files: ChangedFile[]; studio: number; mixed: number; other: number; forgotten: number; ms: number };

const GIT_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: stderr?.toString("utf8") ?? "" }));
      else resolve(stdout);
    });
  });
}

/** git status -z: "XY path\0" each (no renames asked) */
function parseStatus(out: Buffer): { status: string; path: string }[] {
  const entries: { status: string; path: string }[] = [];
  for (const item of out.toString("utf8").split("\0")) {
    if (item.length < 4) continue;
    entries.push({ status: item.slice(0, 2), path: item.slice(3) });
  }
  return entries;
}

/**
 * The commit's version of each path (from the repo's root), all through one `git cat-file --batch`
 * (a process per file cost too much on Windows with hundreds of files), read as it streams: each
 * blob is hashed as it arrives, and its text kept only with `keepText` (the numbers check). A path
 * git cannot name in the batch (a newline in it), or one the commit lacks, has none.
 */
function headVersions(root: string, paths: string[], keepText: boolean): Promise<Map<string, { hash: string; text?: string }>> {
  const asked = paths.filter((p) => !/[\r\n]/.test(p));
  const versions = new Map<string, { hash: string; text?: string }>();
  if (!asked.length) return Promise.resolve(versions);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, "cat-file", "--batch"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`git cat-file took more than ${GIT_TIMEOUT_MS / 1000} s`)), GIT_TIMEOUT_MS);
    // The answer, one path after another: a header line, then (for a blob) its bytes and a newline
    let next = 0;
    let pending: Buffer = Buffer.alloc(0);
    let body: { size: number; parts: Buffer[]; got: number } | undefined;
    const take = (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        if (body) {
          const want = body.size + 1 - body.got;
          if (pending.length < want) {
            body.parts.push(pending);
            body.got += pending.length;
            pending = Buffer.alloc(0);
            return;
          }
          body.parts.push(pending.subarray(0, want));
          pending = pending.subarray(want);
          const text = Buffer.concat(body.parts).subarray(0, body.size).toString("utf8");
          versions.set(asked[next], { hash: textHash(text), ...(keepText ? { text } : {}) });
          next++;
          body = undefined;
          continue;
        }
        const eol = pending.indexOf(10);
        if (eol < 0) return;
        const header = pending.subarray(0, eol).toString("utf8");
        pending = pending.subarray(eol + 1);
        const blob = /^[0-9a-f]+ blob (\d+)$/.exec(header);
        if (blob) body = { size: Number(blob[1]), parts: [], got: 0 };
        else next++; // "missing", or not a file in the commit
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    // git leaving early (killed by the timeout) closes its stdin: an EPIPE here is that, not a crash
    child.stdin.on("error", (error) => fail(error));
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      if (failed) return;
      clearTimeout(timer);
      if (code !== 0) {
        failed = true;
        reject(new Error(`git cat-file failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      resolve(versions);
    });
    child.stdin.end(asked.map((p) => `HEAD:${p}\n`).join(""));
  });
}

export async function studioChanges(syncDir: string, writes: StudioWrites, options: { numbersOnly?: boolean } = {}, now: () => number = Date.now): Promise<ChangesResult> {
  const started = now();
  // What the record held when this began: only those entries may be forgotten at the end (a file
  // Studio writes while git answers keeps its entry)
  const seen = writes.snapshot();
  const shownSync = syncDir.split(path.sep).join("/");
  let root: string;
  let prefix: string;
  try {
    const out = (await git(syncDir, ["rev-parse", "--show-toplevel", "--show-prefix"])).toString("utf8").split(/\r?\n/);
    root = out[0];
    prefix = out[1] ?? "";
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { git: false, syncDir: shownSync, note: "git is not installed (or not on PATH), so Quack cannot tell what changed" };
    if (/not a git repository/i.test(stderr)) return { git: false, syncDir: shownSync, note: "the sync folder is not in a git repository, so there is no commit to compare with" };
    throw new Error(`git could not read the sync folder: ${stderr.trim() || (error as Error).message}`);
  }
  let hasHead = true;
  try {
    await git(syncDir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch {
    hasHead = false;
  }
  // Every file under the sync folder, new ones file by file; paths from the root
  const status = parseStatus(await git(syncDir, ["-c", "core.quotepath=off", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."]));

  const files: ChangedFile[] = [];
  const keep = new Set<string>();
  // Files as Studio left them, with the record to check against the commit (no text kept)
  const candidates: { file: ChangedFile; rel: string; record: StudioWrite; diskHash: string | undefined }[] = [];
  for (const entry of status) {
    if (!entry.path.startsWith(prefix)) continue;
    const rel = entry.path.slice(prefix.length);
    keep.add(rel);
    // The latest entry: Studio may have written it while git answered (seen is for the pruning)
    const record = writes.get(rel);
    const file: ChangedFile = { path: entry.path, status: entry.status, origin: "other", note: "not from Studio" };
    files.push(file);
    if (!record) continue;
    file.writtenAt = record.at;
    // A type change (a script turned into a link): never what Studio does
    // Staged, and the disk differs from what is staged: the index holds a version Studio never wrote
    if (entry.status[0] !== " " && entry.status[0] !== "?" && entry.status[1] !== " ") {
      file.origin = "mixed";
      file.note = "a version staged in git differs from the one on disk";
      continue;
    }
    if (entry.status.includes("T")) {
      file.origin = "mixed";
      file.note = "its file type changed on disk after Studio wrote it";
      continue;
    }
    let bytes: Buffer | undefined;
    const full = path.join(syncDir, ...rel.split("/"));
    try {
      // A link put where Studio's file was (a new file shows no type change): never Studio's
      if (fs.lstatSync(full).isSymbolicLink()) {
        file.origin = "mixed";
        file.note = "a link now stands where Studio wrote a file";
        continue;
      }
      bytes = fs.readFileSync(full);
    } catch {
      bytes = undefined;
    }
    if (record.deleted) {
      if (bytes !== undefined) {
        file.origin = "mixed";
        file.note = "Studio removed it, and it was made again on disk since";
        continue;
      }
    } else if (bytes === undefined) {
      file.origin = "mixed";
      file.note = "Studio wrote it, then it was removed on disk";
      continue;
    } else if (sha256(bytes) !== record.hash) {
      file.origin = "mixed";
      file.note = "changed on disk after Studio wrote it";
      continue;
    }
    candidates.push({ file, rel, record, diskHash: bytes === undefined ? undefined : textHash(bytes.toString("utf8")) });
  }

  const needHead = hasHead ? candidates.filter((c) => c.file.status !== "??" && c.file.status[0] !== "A").map((c) => c.file.path) : [];
  const heads = await headVersions(root, needHead, options.numbersOnly === true);
  for (const { file, rel, record, diskHash } of candidates) {
    const head = heads.get(file.path);
    const headHash = head === undefined ? ABSENT : head.hash;
    // The texts the file went through in Studio's streak, the one on disk last. Studio's alone
    // only if the commit is one of them: else, when Studio began writing it, the file already
    // held someone's uncommitted edit, now under Studio's
    const texts = [...record.streak, diskHash ?? ABSENT];
    const headAt = texts.lastIndexOf(headHash);
    if (headAt < 0) {
      file.origin = "mixed";
      file.note = "it already held another uncommitted edit when Studio began writing it";
      continue;
    }
    // A merge in the streak that the commit does not hold yet
    if (record.merged !== undefined) {
      // Out of the streak's kept texts, it lay between the first and the second: only the first
      // is before it
      const mergedAt = texts.lastIndexOf(record.merged);
      if (mergedAt < 0 ? headAt === 0 : headAt < mergedAt) {
        file.origin = "mixed";
        file.note = "a merge of a Studio edit and a disk edit";
        continue;
      }
    }
    file.origin = "studio";
    file.note = diskHash === undefined ? "removed by Studio" : head === undefined ? "made by Studio" : "written by Studio, unchanged since";
    if (options.numbersOnly) {
      if (head === undefined || diskHash === undefined) {
        file.numbersOnly = false;
        file.numbersNote = head === undefined ? "a new file" : "a removed file";
      } else if (!file.path.endsWith(".luau") && !file.path.endsWith(".lua")) {
        file.numbersOnly = false;
        file.numbersNote = "not a Luau file";
      } else {
        // Read again here, one file at a time, instead of holding every file's text; it must still
        // be the text classified above
        let disk: Buffer | undefined;
        try {
          disk = fs.readFileSync(path.join(syncDir, ...rel.split("/")));
        } catch {
          disk = undefined;
        }
        const why = disk === undefined || sha256(disk) !== record.hash ? "it changed while being read; ask again" : numbersOnly(diskText(head.text ?? ""), diskText(disk.toString("utf8")));
        file.numbersOnly = why === null;
        if (why !== null) file.numbersNote = why;
      }
    }
  }

  // Bounded: a file git no longer lists (committed, or put back as the commit has it) is forgotten
  const forgotten = writes.keepOnly(keep, seen);
  const count = (origin: ChangeOrigin) => files.filter((f) => f.origin === origin).length;
  return { git: true, root, syncDir: prefix.replace(/\/$/, "") || ".", files, studio: count("studio"), mixed: count("mixed"), other: count("other"), forgotten, ms: now() - started };
}
