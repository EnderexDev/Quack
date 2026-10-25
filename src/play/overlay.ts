import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { classifyScriptFileName } from "../util/scriptFile.js";

/**
 * Quack: a playtest of a git worktree's scripts (`quackdev play`). The place in edit mode stays on
 * the registered folder; for the moment Studio copies it into the play session, the plugin swaps
 * in the branch's scripts and then restores them. This works out what to swap: only what the
 * branch changed since it forked from the place's folder, so Studio keeps everyone else's text
 * (and the maps' scripts, ignored by git, are never touched).
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
  /** Scripts the branch changed that Studio holds changed by someone else, said in the report */
  conflicts: string[];
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
  // stderr piped: a `git show` of a file the commit lacks is an answer here, not a line for the log
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 256 * 1024 * 1024,
  });
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

/**
 * Said when the play's check finds a script with the place's text. Measured 25/10/26 in Anime
 * Astral (Team Create): a script whose tab is open in the Studio running the swap, and was edited
 * through the editor there (by hand, or by the sync writing to the open tab), goes into the play
 * with the tab's text, not the .Source the swap set. The same tab open and not edited, or a
 * collaborator's tab even with edits, did not get in the way; closing the tab let the play through
 */
export const PLAY_TAB_HINT =
  "a script whose tab is open in the Studio running the play, and was edited there, goes into the play with the tab's text: close that tab and play again";

/** The text git holds for a file at a commit, or undefined when the commit has no such file */
function blobAt(root: string, commit: string, rel: string): string | undefined {
  try {
    return git(root, ["show", `${commit}:${rel.split(path.sep).join("/")}`]);
  } catch {
    return undefined;
  }
}

const lfOf = (text: string) => text.replace(/\r\n/g, "\n");

/**
 * What the branch brings: the merge-base of the worktree's HEAD with the registered checkout's
 * HEAD, and every file under the sync folder the worktree changed since then (committed or not).
 * 24/10/26 on Anime Astral: comparing every tracked script with Studio swapped in any script
 * someone else had edited in Studio without a commit (the balancer's AccessoryConfig), so every
 * worktree's play tried to revert it, and every play failed its check on it (that script also
 * had a tab edited in the swapping Studio, which the copy takes over .Source: PLAY_TAB_HINT)
 */
function branchChanges(
  registeredRoot: string,
  worktreeRoot: string,
  syncRel: string,
): { base: string; registeredHead: string; changes: string[] } {
  let base: string;
  let registeredHead: string;
  try {
    registeredHead = git(registeredRoot, ["rev-parse", "HEAD"]).trim();
    base = git(worktreeRoot, ["merge-base", "HEAD", registeredHead]).trim();
  } catch {
    throw new Error("the worktree's branch shares no commit with the place's folder, so there is no telling what it brings");
  }
  // --no-renames: a moved script is the old one deleted and a new one created
  const changes = git(worktreeRoot, ["diff", "--name-only", "-z", "--no-renames", base, "--", syncRel ? syncRel.split(path.sep).join("/") : "."])
    .split("\0")
    .filter(Boolean)
    .map((file) => path.normalize(file));
  return { base, registeredHead, changes };
}

export function computePlayOverlay(registeredRoot: string, worktreeRoot: string, place: PlaceView): PlayOverlay {
  const syncRel = path.relative(registeredRoot, place.syncDir);
  // "..scripts" is a folder inside; only ".." itself or "../..." leaves
  if (syncRel === ".." || syncRel.startsWith(`..${path.sep}`) || path.isAbsolute(syncRel)) {
    throw new Error("the sync folder is outside the place's folder");
  }
  const overlay: PlayOverlay = { patches: [], creates: [], disables: [], skipped: [], conflicts: [] };
  const { base, registeredHead, changes } = branchChanges(registeredRoot, worktreeRoot, syncRel);

  for (const repoRel of changes) {
    if (!SCRIPT_FILE.test(repoRel)) continue;
    const rel = path.relative(syncRel, repoRel);
    const file = path.join(worktreeRoot, repoRel);
    const guid = place.guidByFile(path.join(place.syncDir, rel));
    const node = guid ? place.node(guid) : undefined;

    // Studio holds someone else's text when it differs from the text the branch started from:
    // a later commit of the place's folder, or an edit made in Studio and not committed. The
    // branch's text replaces it in the play, and the report names the file
    const conflict = (studio: string | undefined) => {
      if (studio === undefined) return;
      const baseText = blobAt(worktreeRoot, base, repoRel);
      if (baseText === undefined || lfOf(baseText) === lfOf(studio)) return;
      const headText = registeredHead === base ? undefined : blobAt(registeredRoot, registeredHead, repoRel);
      overlay.conflicts.push(
        headText !== undefined && lfOf(headText) === lfOf(studio)
          ? `${rel}: the place's folder committed a change to it after the branch forked; the play runs the branch's text without that change (rebase the branch to get both)`
          : `${rel}: changed in Studio and not committed (someone's edit there); the play runs the branch's text without that edit`,
      );
    };

    // Read whatever git says: it calls a file turned into a folder a deletion too
    let raw: string | undefined;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      // Not there (deleted, committed or not) is a deletion. Any other failure is not one: the
      // script stays as the place has it, and the report says so
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        overlay.skipped.push(`${rel}: could not be read, left as the place has it (${(error as Error).message})`);
        continue;
      }
    }

    if (raw === undefined) {
      if (!guid || !node) continue;
      conflict(node.source);
      if (node.className === "ModuleScript") {
        overlay.skipped.push(`${rel}: deleted in the branch, a ModuleScript stays in the play (nothing in the branch requires it)`);
        continue;
      }
      overlay.disables.push({ guid, path: node.path });
      continue;
    }

    // git on Windows checks a worktree out with CRLF (core.autocrlf, no .gitattributes in the
    // games), while Studio and the synced folder hold LF: without this every script of a fresh
    // worktree differs (measured 22/10/26 on PA). A script whose Studio text has CR keeps it
    const lf = lfOf(raw);
    if (guid) {
      if (!node) continue;
      const source = node.source?.includes("\r\n") ? raw : lf;
      if (node.source === source) continue;
      conflict(node.source);
      overlay.patches.push({ guid, source, path: node.path, hash: textHash(source) });
      continue;
    }
    const segments = rel.split(/[/\\]/).filter(Boolean);
    const classified = classifyScriptFileName(segments[segments.length - 1], { stripDisambiguationSuffix: true });
    overlay.creates.push({
      className: classified.className,
      name: classified.scriptName,
      parentPath: segments.slice(0, -1),
      source: lf,
      hash: textHash(lf),
    });
  }
  return overlay;
}
