import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { classifyScriptFileName } from "../util/scriptFile.js";

/**
 * Quack: a playtest of a git worktree's scripts (`quackdev play`). The place in edit mode stays on
 * the registered folder; for the moment Studio copies it into the play session, the plugin swaps
 * in the branch's scripts and then restores them. This works out what to swap: only scripts git
 * tracks in the worktree count, so the maps' scripts (ignored folders) are never touched.
 */

export interface PlayPatch {
  guid: string;
  source: string;
  /** Instance path, for the check inside the play session */
  path: string[];
  hash: string;
}

export interface PlayCreate {
  className: string;
  name: string;
  parentPath: string[];
  source: string;
  hash: string;
}

/** A script the branch deleted: turned off for the play (a ModuleScript nobody requires stays) */
export interface PlayDisable {
  guid: string;
  path: string[];
}

export interface PlayOverlay {
  patches: PlayPatch[];
  creates: PlayCreate[];
  disables: PlayDisable[];
  /** Branch changes the play cannot carry, said in the report */
  skipped: string[];
}

/** What the overlay needs from the daemon's view of the place */
export interface PlaceView {
  /** The registered folder's sync directory (absolute) */
  syncDir: string;
  /** guid of the script mapped to this file, if any */
  guidByFile: (filePath: string) => string | undefined;
  /** The script's text in Studio and its instance path */
  node: (guid: string) => { source?: string; path: string[]; className: string } | undefined;
}

const SCRIPT_FILE = /\.(luau|lua)$/i;

/**
 * Whether the folder's file system ignores case (Foo.luau and foo.luau one file): Windows does;
 * a Mac volume may or may not, so it is asked, by looking the folder up in the other case
 */
function ignoresCase(folder: string): boolean {
  if (process.platform === "win32") return true;
  const flipped = folder.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  if (flipped === folder) return false;
  try {
    return fs.realpathSync(flipped) === fs.realpathSync(folder);
  } catch {
    return false;
  }
}

/** FNV-1a 32 over the UTF-8 bytes, as hex; the plugin computes the same in Luau */
export function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 256 * 1024 * 1024 });
}

/** The path as it is on disk: git prints long names, a registered folder may hold an 8.3 one (RUNNER~1) */
function onDisk(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

const samePath = (a: string, b: string) =>
  process.platform === "win32" ? onDisk(a).toLowerCase() === onDisk(b).toLowerCase() : onDisk(a) === onDisk(b);

/** The worktree's root, or why it cannot be played */
export function worktreeOf(folder: string, registered: string): string {
  let top: string;
  let common: string;
  let registeredCommon: string;
  try {
    top = git(folder, ["rev-parse", "--show-toplevel"]).trim();
    common = git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  } catch {
    throw new Error(`${folder} is not inside a git repository`);
  }
  try {
    registeredCommon = git(registered, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  } catch {
    throw new Error(`the place's folder ${registered} is not a git repository, so it has no worktrees`);
  }
  if (!samePath(common, registeredCommon)) {
    throw new Error(`${folder} belongs to another repository than the place's folder ${registered}`);
  }
  if (samePath(top, registered)) throw new Error(`${folder} is the place's own folder: its scripts are already in Studio`);
  return path.resolve(top);
}

/** Files git tracks under `dir` (absolute paths) */
function trackedFiles(root: string, dir: string): string[] {
  const rel = path.relative(root, dir) || ".";
  return git(root, ["ls-files", "-z", "--", rel])
    .split("\0")
    .filter(Boolean)
    .map((file) => path.resolve(root, file));
}

export function computePlayOverlay(registeredRoot: string, worktreeRoot: string, place: PlaceView): PlayOverlay {
  const syncRel = path.relative(registeredRoot, place.syncDir);
  // "..scripts" is a folder inside; only ".." itself or "../..." leaves
  if (syncRel === ".." || syncRel.startsWith(`..${path.sep}`) || path.isAbsolute(syncRel)) {
    throw new Error("the sync folder is outside the place's folder");
  }
  const branchSync = path.join(worktreeRoot, syncRel);
  const overlay: PlayOverlay = { patches: [], creates: [], disables: [], skipped: [] };

  const branchFiles = trackedFiles(worktreeRoot, branchSync);
  const foldCase = ignoresCase(worktreeRoot);
  const fileKey = (rel: string) => (foldCase ? rel.toLowerCase() : rel);
  const inBranch = new Set<string>();
  for (const file of branchFiles) {
    const rel = path.relative(branchSync, file);
    if (!SCRIPT_FILE.test(file)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      // Tracked but deleted and not committed: the branch as it is has no script, so the place's
      // one is turned off below like any other deletion. Any other failure is not a deletion:
      // the script stays as the place has it, and the report says so
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        inBranch.add(fileKey(rel));
        overlay.skipped.push(`${rel}: could not be read, left as the place has it (${(error as Error).message})`);
      }
      continue;
    }
    inBranch.add(fileKey(rel));
    // git on Windows checks a worktree out with CRLF (core.autocrlf, no .gitattributes in the
    // games), while Studio and the synced folder hold LF: without this every script of a fresh
    // worktree differs (measured 22/10/26 on PA). A script whose Studio text has CR keeps it
    const lf = raw.replace(/\r\n/g, "\n");
    const guid = place.guidByFile(path.join(place.syncDir, rel));
    if (guid) {
      const node = place.node(guid);
      if (!node) continue;
      const source = node.source?.includes("\r\n") ? raw : lf;
      if (node.source !== source) overlay.patches.push({ guid, source, path: node.path, hash: textHash(source) });
      continue;
    }
    const source = lf;
    const segments = rel.split(/[/\\]/).filter(Boolean);
    const classified = classifyScriptFileName(segments[segments.length - 1], { stripDisambiguationSuffix: true });
    overlay.creates.push({
      className: classified.className,
      name: classified.scriptName,
      parentPath: segments.slice(0, -1),
      source,
      hash: textHash(source),
    });
  }

  // Deleted by the branch: tracked in the registered folder, absent from the branch. Only tracked
  // files: a script git ignores (inside a map) is the place's, never the branch's to remove
  for (const file of trackedFiles(registeredRoot, place.syncDir)) {
    if (!SCRIPT_FILE.test(file)) continue;
    const rel = path.relative(place.syncDir, file);
    if (inBranch.has(fileKey(rel))) continue;
    const guid = place.guidByFile(file);
    const node = guid ? place.node(guid) : undefined;
    if (!guid || !node) continue;
    if (node.className === "ModuleScript") {
      overlay.skipped.push(`${rel}: deleted in the branch, a ModuleScript stays in the play (nothing in the branch requires it)`);
      continue;
    }
    overlay.disables.push({ guid, path: node.path });
  }
  return overlay;
}
