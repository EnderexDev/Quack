import fs from "node:fs";
import path from "node:path";

/**
 * The place's instance tree as the analyzer sees it. From the sourcemap.json the daemon writes
 * (every instance Studio had at the last sync: 309k in Anime Astral, read in ~0.2 s), else from
 * the sync folder alone (only scripts and the folders that hold them: enough to find modules,
 * never enough to say a child is missing).
 */
export interface TreeNode {
  name: string;
  className: string;
  parent?: TreeNode;
  children: TreeNode[];
  /** Absolute path of the script's file */
  file?: string;
  /** Its children are not all known (a project node Rojo lets keep unknown instances, a $path not on disk, a binary model) */
  open?: boolean;
}

export interface GameTree {
  root: TreeNode;
  /** Every instance is in it (sourcemap); false: only scripts and their folders (sync folder) */
  complete: boolean;
  /** Script file (normalized by fileKey) -> its node */
  byFile: Map<string, TreeNode>;
  /** The sourcemap read, when there was one */
  sourcemap?: string;
  /** Code the project names is not on disk (a package not installed): what fires or listens there is unseen */
  codeMissing?: boolean;
}

/** Windows paths compare without case */
export const fileKey = (file: string) => {
  const abs = path.resolve(file);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
};

export function childNamed(node: TreeNode, name: string): TreeNode | undefined {
  return node.children.find((c) => c.name === name);
}

export const isScript = (node: TreeNode) => node.className === "ModuleScript" || node.className === "Script" || node.className === "LocalScript";

export interface SourcemapNode {
  name: string;
  className: string;
  filePaths?: string[];
  children?: SourcemapNode[];
  /** Quack's mark on a node whose children are not all known (a sourcemap built from a project file) */
  _quack?: { open?: boolean; codeMissing?: boolean };
}

export function treeFromSourcemap(json: SourcemapNode, root: string): GameTree {
  const byFile = new Map<string, TreeNode>();
  const build = (n: SourcemapNode, parent?: TreeNode): TreeNode => {
    const node: TreeNode = { name: n.name, className: n.className, parent, children: [] };
    if (n._quack?.open === true) node.open = true;
    const script = n.filePaths?.find((f) => /\.luau?$/i.test(f));
    if (script) {
      node.file = path.resolve(root, script);
      byFile.set(fileKey(node.file), node);
    }
    for (const c of n.children ?? []) node.children.push(build(c, node));
    return node;
  };
  // `quack sourcemap` marks a project whose code is not all on disk (a package not installed, a binary model)
  return { root: build(json), complete: true, byFile, ...(json._quack?.codeMissing === true ? { codeMissing: true } : {}) };
}

const SCRIPT_FILE = /^(.*?)(\.server|\.client)?\.luau?$/i;

export function treeFromSyncFolder(syncDir: string): GameTree {
  const byFile = new Map<string, TreeNode>();
  const root: TreeNode = { name: "Game", className: "DataModel", children: [] };
  const fill = (dir: string, parent: TreeNode) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // scripts first: a folder named like a script beside it holds that script's children
    for (const e of entries) {
      if (!e.isFile()) continue;
      const m = SCRIPT_FILE.exec(e.name);
      if (!m) continue;
      const className = m[2]?.toLowerCase() === ".server" ? "Script" : m[2]?.toLowerCase() === ".client" ? "LocalScript" : "ModuleScript";
      const node: TreeNode = { name: m[1], className, parent, children: [], file: path.join(dir, e.name) };
      parent.children.push(node);
      byFile.set(fileKey(node.file!), node);
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      let node = parent.children.find((c) => c.name === e.name && isScript(c));
      if (!node) {
        node = { name: e.name, className: parent === root ? e.name : "Folder", parent, children: [] };
        parent.children.push(node);
      }
      fill(path.join(dir, e.name), node);
    }
  };
  fill(syncDir, root);
  return { root, complete: false, byFile };
}

/**
 * Puts a script the sync folder no longer has back in a tree read from that folder (the
 * pre-commit check: a script deleted after `git add`, which the commit still holds), with the
 * folders above it, named as treeFromSyncFolder names them
 */
export function addSyncFile(tree: GameTree, syncDir: string, file: string): void {
  if (tree.complete || tree.byFile.has(fileKey(file))) return;
  const rel = path.relative(syncDir, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  const parts = rel.split(/[\\/]/);
  const m = SCRIPT_FILE.exec(parts.pop()!);
  if (!m) return;
  let parent = tree.root;
  for (const name of parts) {
    let next = parent.children.find((c) => c.name === name && (c.className === "Folder" || isScript(c) || parent === tree.root));
    if (!next) {
      next = { name, className: parent === tree.root ? name : "Folder", parent, children: [] };
      parent.children.push(next);
    }
    parent = next;
  }
  const className = m[2]?.toLowerCase() === ".server" ? "Script" : m[2]?.toLowerCase() === ".client" ? "LocalScript" : "ModuleScript";
  const node: TreeNode = { name: m[1], className, parent, children: [], file: path.resolve(file) };
  parent.children.push(node);
  tree.byFile.set(fileKey(file), node);
}

/** The sourcemap when it is there and readable, else the sync folder */
export function loadTree(root: string, syncDir: string, sourcemap: string): GameTree {
  try {
    const json = JSON.parse(fs.readFileSync(sourcemap, "utf8"));
    if (json && Array.isArray(json.children)) return { ...treeFromSourcemap(json, root), sourcemap };
  } catch {
    // no sourcemap yet (the place never synced here) or one cut mid-write
  }
  return treeFromSyncFolder(syncDir);
}
