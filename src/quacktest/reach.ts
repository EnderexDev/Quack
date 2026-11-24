import fs from "node:fs";
import path from "node:path";
import { loadProject, type AnalyzeOptions } from "../analyze/analyze.js";
import { borrowedSourcemap } from "../analyze/command.js";
import { treeFromProject } from "../analyze/project.js";
import { fileKey } from "../analyze/tree.js";
import { findSpecs, SETUP_FILE, TESTS_DIR, type SpecFile } from "./project.js";

/**
 * The specs an edit can change the result of: those whose requires reach one of the edited files,
 * read by the analyzer's own reader (`require(X)` by its instance path, a loader's
 * `Library.getX("Name")`), plus a spec's string requires of its helpers in tests/. An edited spec
 * is its own; an edited setup.luau reaches every spec. A module required by a name only the run
 * knows (`require(folder[name])`) is not seen: such a spec runs with `quack test`, not after an edit.
 */

/** Every Luau file of tests/: specs, their helpers, setup.luau */
export function testFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) walk(p);
      } else if (/\.luau?$/i.test(e.name)) out.push(p);
    }
  };
  walk(path.join(root, TESTS_DIR));
  return out;
}

/** A test file's string requires of other files ("./helpers/Coins"), resolved like the runtime does */
export function stringRequires(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\brequire\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const base = path.resolve(path.dirname(file), m[1]);
    for (const suffix of [".luau", ".lua", "/init.luau", "/init.lua"]) {
      if (fs.existsSync(base + suffix)) {
        out.push(base + suffix);
        break;
      }
    }
  }
  return out;
}

/** The specs of `specs` that reach any of `files`, given what each script requires */
export function reached(root: string, specs: SpecFile[], files: string[], requires: Map<string, string[]>): SpecFile[] {
  const setup = fileKey(path.join(root, TESTS_DIR, SETUP_FILE));
  const targets = new Set(files.map(fileKey));
  // who requires each file
  const requiredBy = new Map<string, string[]>();
  for (const [from, deps] of requires) {
    for (const dep of deps) {
      const key = fileKey(dep);
      requiredBy.set(key, [...(requiredBy.get(key) ?? []), from]);
    }
  }
  const seen = new Set<string>();
  const queue = [...targets];
  while (queue.length) {
    const key = queue.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const up of requiredBy.get(key) ?? []) queue.push(up);
  }
  // setup.luau runs before every spec: what it requires reaches all of them
  if (seen.has(setup)) return specs;
  return specs.filter((s) => seen.has(fileKey(s.file)));
}

/** What each script and test file requires: the analyzer's binding plus the tests' string requires */
export function requiresOf(root: string, options: AnalyzeOptions): Map<string, string[]> {
  const tests = testFiles(root);
  const project = loadProject(root, { ...options, extraFiles: tests });
  const requires = project.requires();
  for (const file of tests) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const key = fileKey(file);
    requires.set(key, [...(requires.get(key) ?? []), ...stringRequires(file, text)]);
  }
  return requires;
}

/** The CLI's reach (no hub): the project read once, like `quack analyze` */
export async function reachingSpecs(root: string, files: string[], placeFolders?: () => Promise<string[]>): Promise<SpecFile[]> {
  const specs = findSpecs(root);
  if (!specs.length) return [];
  if (fs.existsSync(path.join(root, "sync"))) {
    const sourcemap = fs.existsSync(path.join(root, "sourcemap.json")) ? undefined : placeFolders ? await borrowedSourcemap(root, placeFolders).catch(() => undefined) : undefined;
    return reached(root, specs, files, requiresOf(root, { sourcemap }));
  }
  const tree = await treeFromProject(root);
  if (!tree) return [];
  return reached(root, specs, files, requiresOf(root, { tree }));
}
