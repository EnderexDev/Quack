import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { borrowedSourcemap } from "../analyze/command.js";
import { projectFileOf, sourcemapFromProject } from "../analyze/project.js";
import { scriptOfFile, treeFromSyncFolder, type SourcemapNode, type TreeNode } from "../analyze/tree.js";
import { cacheDir } from "./lune.js";

/**
 * What a Quack Test run needs from a project folder: its specs (tests/, next to sync/, never
 * synced to the game) and the tree they run against.
 *
 *  - A synced place: the sourcemap the daemon writes (Studio's whole tree, every instance), or in
 *    a git worktree the synced checkout's (its sourcemap is not committed). Built once into an
 *    .rbxl kept in the cache by the sourcemap's size and time. The scripts' text is always read
 *    from this project's own folder, and the scripts of its sync/ the sourcemap lacks go in (a
 *    file made since, a worktree's new file) while those the folder no longer has go out.
 *  - No sourcemap: the sync folder alone (scripts and their folders).
 *  - A Rojo project (a project file, no sync/): the tree its project file describes.
 */
export interface SpecFile {
  /** Absolute */
  file: string;
  /** From the project folder, with / */
  rel: string;
  /** From tests/, no extension ("Economy/CoinsSpec"): the start of each test's full name */
  name: string;
}

export interface TreeSource {
  kind: "sourcemap" | "sync folder" | "project file";
  /** The tree in the sourcemap's shape: the sourcemap itself, or a file Quack wrote */
  source: string;
  /** The built tree kept between runs (sourcemaps only) */
  cache?: string;
  /** Said in the report: which tree the specs ran against */
  label: string;
  /** A sourcemap's path, size and time: another one, another tree */
  stamp?: string;
}

/** A script of sync/: its file from the project folder and the instance path it becomes */
export interface PresentScript {
  rel: string;
  parts: string[];
  className: string;
}

export const TESTS_DIR = "tests";
export const SETUP_FILE = "setup.luau";
const SPEC = /Spec\.luau?$/;

const relOf = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");

/**
 * Every spec under tests/, in a stable order; helpers and setup.luau are not specs. No tests/ is
 * no specs; a folder there that cannot be read throws (a run must never pass by not seeing them)
 */
export function findSpecs(root: string): SpecFile[] {
  const dir = path.join(root, TESTS_DIR);
  const out: SpecFile[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // no tests/ at all is no specs; a folder of it gone mid-read would hide its specs
      if (d === dir && (code === "ENOENT" || code === "ENOTDIR")) return;
      throw new Error(`${d} cannot be read (${code ?? (error as Error).message})`);
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) walk(p);
      } else if (SPEC.test(e.name)) {
        out.push({ file: p, rel: relOf(root, p), name: relOf(dir, p).replace(/\.luau?$/, "") });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function setupFile(root: string): { file: string; rel: string } | undefined {
  const file = path.join(root, TESTS_DIR, SETUP_FILE);
  return fs.existsSync(file) ? { file, rel: relOf(root, file) } : undefined;
}

/**
 * Every script of sync/, as the instance it is in the place. A script left out would be taken out
 * of the tree, so a folder that cannot be read fails the run; one removed while it is walked (the
 * sync moving it) is simply gone
 */
export function presentScripts(root: string): PresentScript[] {
  const out: PresentScript[] = [];
  const walk = (d: string, parts: string[]) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (parts.length && (code === "ENOENT" || code === "ENOTDIR")) return;
      throw new Error(`${d} cannot be read (${code ?? (error as Error).message})`);
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) walk(path.join(d, e.name), [...parts, e.name]);
        continue;
      }
      const script = scriptOfFile(e.name);
      if (script) out.push({ rel: relOf(root, path.join(d, e.name)), parts: [...parts, script.name], className: script.className });
    }
  };
  walk(path.join(root, "sync"), []);
  return out;
}

/**
 * Sourcemaps Lune could not build from (one cut mid-write that passed the quick check), by path,
 * size and time: the sync folder's tree is used for them until the sourcemap is written again
 */
const unreadable = new Set<string>();

export function markUnreadable(tree: TreeSource): void {
  if (tree.stamp) unreadable.add(tree.stamp);
}

/** The sourcemap's size and time, or null when it is gone (removed between two reads) */
function stampOf(file: string): string | null {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? `${path.resolve(file)}:${st.size}:${st.mtimeMs}` : null;
  } catch {
    return null;
  }
}

/**
 * A sourcemap whole enough to build from: a JSON object from its first byte to its last. One cut
 * mid-write (the daemon writes it often) or emptied ends otherwise; reading all of it to check
 * would cost ~1 s for a big place on every run
 */
function wholeJson(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size < 2) return false;
    const edge = Math.min(256, size);
    const head = Buffer.alloc(edge);
    const tailBytes = Buffer.alloc(edge);
    fs.readSync(fd, head, 0, edge, 0);
    fs.readSync(fd, tailBytes, 0, edge, size - edge);
    return head.toString("utf8").trimStart().startsWith("{") && tailBytes.toString("utf8").trimEnd().endsWith("}");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * A tree Quack wrote, as a file named by its content in the cache; when the cache cannot be
 * written (a full disk, no permission), in the system's temporary folder
 */
function written(map: SourcemapNode, label: TreeSource["kind"]): TreeSource {
  const text = JSON.stringify(map);
  const name = `${createHash("sha256").update(text).digest("hex").slice(0, 16)}.json`;
  const describe = label === "project file" ? "tree from the project file" : "tree from the sync folder (no sourcemap: only scripts and their folders)";
  let failure: unknown;
  for (const dir of [path.join(cacheDir(), "trees"), path.join(os.tmpdir(), "quack-test-trees")]) {
    const source = path.join(dir, name);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(source)) {
        const temp = `${source}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        fs.writeFileSync(temp, text);
        fs.renameSync(temp, source);
      }
      return { kind: label, source, label: describe };
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(`the tree could not be written for Lune (${(failure as Error).message})`);
}

/** The sync folder's tree in place of a sourcemap Lune could not read */
export function syncFolderTree(root: string, sourcemap?: string): TreeSource {
  const tree = written(toSourcemap(treeFromSyncFolder(path.join(root, "sync")).root, root), "sync folder");
  return sourcemap ? { ...tree, label: `tree from the sync folder (${sourcemap} could not be read)` } : tree;
}

function toSourcemap(node: TreeNode, root: string): SourcemapNode {
  const out: SourcemapNode = { name: node.name, className: node.className };
  if (node.file) out.filePaths = [relOf(root, node.file)];
  if (node.children.length) out.children = node.children.map((c) => toSourcemap(c, root));
  return out;
}

/**
 * The tree for a project folder. `placeFolders` lists the registered places (from the hub): a
 * worktree borrows the sourcemap of the one in its repository. Null with the reason when there
 * is none to run against.
 */
export async function treeSource(root: string, placeFolders?: () => Promise<string[]>): Promise<{ tree: TreeSource; present?: PresentScript[] } | { error: string }> {
  const sync = path.join(root, "sync");
  if (fs.existsSync(sync)) {
    let sourcemap: string | undefined = path.join(root, "sourcemap.json");
    let borrowed = false;
    if (!fs.existsSync(sourcemap)) {
      sourcemap = placeFolders ? await borrowedSourcemap(root, placeFolders).catch(() => undefined) : undefined;
      borrowed = !!sourcemap;
    }
    const stamp = sourcemap ? stampOf(sourcemap) : null;
    if (sourcemap && stamp && !unreadable.has(stamp)) {
      const key = createHash("sha256").update(stamp).update("tree-v1").digest("hex").slice(0, 16);
      let cache: string | undefined = path.join(cacheDir(), "trees", `${key}.rbxl`);
      try {
        fs.mkdirSync(path.dirname(cache), { recursive: true });
      } catch {
        // no cache folder (no permission, a full disk): the tree is built for each run
        cache = undefined;
      }
      // a tree already kept for this sourcemap was built from it whole
      if ((cache && fs.existsSync(cache)) || wholeJson(sourcemap)) {
        return {
          tree: { kind: "sourcemap", source: sourcemap, ...(cache ? { cache } : {}), stamp, label: borrowed ? `tree from ${sourcemap}` : "tree from the sourcemap" },
          present: presentScripts(root),
        };
      }
    }
    // no sourcemap, or one cut or emptied: the sync folder, as the analyzer does
    return { tree: syncFolderTree(root, sourcemap) };
  }
  const projectFile = projectFileOf(root);
  if (projectFile) {
    const map = await sourcemapFromProject(projectFile);
    if (map) return { tree: written(map, "project file") };
  }
  return { error: `No sync folder or readable project file in ${root}` };
}

/** Trees and tree files not used for a while (a sourcemap rewritten leaves the old .rbxl behind) */
export function pruneTrees(maxAgeDays = 14): void {
  const dir = path.join(cacheDir(), "trees");
  const cutoff = Date.now() - maxAgeDays * 86400_000;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // no cache yet
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {
      // removed by another process meanwhile, or in use: the others are still looked at
    }
  }
}
