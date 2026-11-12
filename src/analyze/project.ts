import fs from "node:fs";
import path from "node:path";
import { RojoSnapshotBuilder } from "../snapshot/rojo/builder.js";
import { treeFromSourcemap, type GameTree, type SourcemapNode } from "./tree.js";

/**
 * The place's tree read from a Rojo project file, for a folder with no sourcemap written by
 * Quack (a Rojo or Wally game, or an old commit of one): Quack's own project reader, the one
 * `quack build` uses, in its tree mode. It never needs the rojo binary. A node whose children the
 * disk does not say all is marked open (`_quack.open`): one Rojo lets keep unknown instances (no
 * `$path`, unless `$ignoreUnknownInstances` is false), a `$path` that is not there (Packages
 * before `wally install`), a binary model. A lookup under such a node is never called missing.
 *
 * A game Quack syncs has no use for this: its sourcemap is Studio's own tree, every instance
 * included, which no reader of the disk can rebuild.
 */

/** The project file of a folder: default.project.json, or the only *.project.json there */
export function projectFileOf(root: string): string | null {
  const preferred = path.join(root, "default.project.json");
  if (fs.existsSync(preferred)) return preferred;
  let names: string[];
  try {
    names = fs.readdirSync(root).filter((n) => n.endsWith(".project.json"));
  } catch {
    return null;
  }
  return names.length === 1 ? path.join(root, names[0]) : null;
}

/** The written tree, with whether code it names is not on disk (`_quack.codeMissing` on the root) */
type ProjectSourcemap = SourcemapNode & { children: SourcemapNode[]; _quack?: { open?: boolean; codeMissing?: boolean } };

/** The project's tree in the sourcemap's shape (Rojo's, plus Quack's open marks), or null when it cannot be read */
export async function sourcemapFromProject(projectFile: string): Promise<ProjectSourcemap | null> {
  // absolute first: the builder resolves the file against its cwd, which is the file's own folder
  const file = path.resolve(projectFile);
  const dir = path.dirname(file);
  const builder = new RojoSnapshotBuilder({ projectFile: file, cwd: dir, tree: true });
  let instances;
  try {
    instances = await builder.build();
  } catch {
    // not a place (no DataModel root), or a file it cannot parse
    return null;
  }
  // a base place the tool builds on (Argon's `base`): the place holds instances the disk does not
  let based = false;
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    based = typeof json?.base === "string" && json.base !== "";
  } catch {
    // the builder read it: never here
  }
  // a package not installed, a binary model, a base place, or a script with no file of its own (its
  // source inside a .model.json): code the reader never sees
  const SCRIPTS = new Set(["Script", "LocalScript", "ModuleScript"]);
  const codeMissing = builder.missingTargets > 0 || based || instances.some((i) => SCRIPTS.has(i.className) && !builder.files.has(i));
  const root: ProjectSourcemap = { name: "Game", className: "DataModel", children: [], ...(codeMissing ? { _quack: { codeMissing: true } } : {}) };
  const byPath = new Map<string, SourcemapNode>([["", root]]);
  // parents first: the builder sorts shallow-first, and ensureFolder emits every parent
  for (const inst of instances) {
    const key = inst.path.join("/");
    const parent = byPath.get(inst.path.slice(0, -1).join("/"));
    if (!parent) continue;
    const scriptFile = builder.files.get(inst);
    const filePaths = scriptFile ? [path.relative(dir, scriptFile).split(path.sep).join("/")] : undefined;
    // code not on disk (a package not installed) may make instances in a service (Cmdr's CmdrClient)
    const service = inst.path.length === 1 && codeMissing;
    const open = based || service || builder.openPaths.has(key);
    const known = byPath.get(key);
    if (known) {
      // a Folder made for this path before its real instance (an init script, a model): the real one wins
      if (known.className === "Folder" && inst.className !== "Folder") {
        known.className = inst.className;
        if (filePaths) known.filePaths = filePaths;
      }
      if (open) known._quack = { ...known._quack, open: true };
      continue;
    }
    const node: SourcemapNode = { name: inst.name, className: inst.className };
    if (filePaths) node.filePaths = filePaths;
    if (open) node._quack = { open: true };
    (parent.children ??= []).push(node);
    byPath.set(key, node);
  }
  return root;
}

/** The project's tree, as the analyzer reads it, or null when there is no project file or it cannot be read */
export async function treeFromProject(root: string): Promise<GameTree | null> {
  const file = projectFileOf(path.resolve(root));
  if (!file) return null;
  const map = await sourcemapFromProject(file);
  if (!map) return null;
  return { ...treeFromSourcemap(map, path.dirname(file)), sourcemap: file, ...(map._quack?.codeMissing ? { codeMissing: true } : {}) };
}
