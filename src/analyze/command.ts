import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadProject, type AnalyzeReport, type LiveCandidate, type LiveKeys } from "./analyze.js";
import { liveKeysCode, parseLiveAnswer } from "./live.js";
import { projectFileOf, treeFromProject } from "./project.js";
import { fileKey } from "./tree.js";

/**
 * `quack analyze`: the static check from a terminal, an AI (the MCP tool) or a review hook. It
 * reads only the disk (the sync folder and the sourcemap the daemon writes), so it needs neither
 * the hub nor Studio. Exit 0 when nothing is found, 1 when something is (or it could not run).
 */
export interface AnalyzeRequest {
  cwd: string;
  /** The project folder (the one holding sync/); default: found from the first file or the cwd */
  root?: string;
  /** Report only these (absolute, or from the project folder, the sync folder or the cwd) */
  files: string[];
  json: boolean;
  out: (line: string) => void;
  /** The registered places' folders (from the hub), to borrow a worktree's sourcemap; rejects when the hub is down */
  placeFolders?: () => Promise<string[]>;
  /** A running play of the project's place, to read the keys the text cannot tell (none: text only) */
  live?: LivePlay;
}

/** The hub's view of a place's play, for the keys of modules the text cannot read */
export interface LivePlay {
  /** The registered places; rejects when the hub is down */
  places(): Promise<{ folder: string; name: string; id: string }[]>;
  /** Whether a play is running in that place's Studio (no Studio: false) */
  playing(placeId: string): Promise<boolean>;
  /** Runs Luau in the play's server: what it returned, or its error */
  evalServer(placeId: string, code: string, timeoutMs: number): Promise<{ ok: boolean; values?: string[]; error?: string }>;
}

/** The folder holding sync/, or a Rojo project file, walking up from `from` */
export function projectRoot(from: string): string | null {
  let dir = path.resolve(from);
  try {
    if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
  } catch {
    dir = path.dirname(dir);
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, "sync")) && fs.statSync(path.join(dir, "sync")).isDirectory()) return dir;
    if (projectFileOf(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function scriptsIn(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((e) => e.isFile() && /\.luau?$/i.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

function resolveFile(file: string, root: string, cwd: string): string {
  if (path.isAbsolute(file)) return file;
  for (const base of [cwd, root, path.join(root, "sync")]) {
    const p = path.resolve(base, file);
    if (fs.existsSync(p)) return p;
  }
  return path.resolve(cwd, file);
}

export async function runAnalyze(req: AnalyzeRequest): Promise<number> {
  const start = req.root ? path.resolve(req.cwd, req.root) : req.files[0] ? path.resolve(req.cwd, req.files[0]) : req.cwd;
  const root = req.root ? path.resolve(req.cwd, req.root) : projectRoot(start);
  const synced = !!root && fs.existsSync(path.join(root, "sync"));
  // a Rojo project with no sync folder: its tree and its scripts come from its project file (a
  // sourcemap.json there is Rojo's, which does not mark the nodes whose children it does not know)
  const projectTree = root && !synced ? await treeFromProject(root) : null;
  if (!root || (!synced && !projectTree)) {
    const message = `No sync folder or readable project file at or above ${start}: run it inside a synced project or a Rojo project, or pass --path <project folder>.`;
    req.out(req.json ? JSON.stringify({ error: message }) : message);
    return 1;
  }
  const named = req.files.map((f) => resolveFile(f, root, req.cwd));
  const missing = named.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    const message = `Not found: ${missing.join(", ")}`;
    req.out(req.json ? JSON.stringify({ error: message }) : message);
    return 1;
  }
  // a folder stands for the scripts in it; one with none is said, never "Nothing found"
  const files = named.flatMap((f) => (fs.statSync(f).isDirectory() ? scriptsIn(f) : [f]));
  const empty = named.filter((f) => fs.statSync(f).isDirectory() && !scriptsIn(f).length);
  if (empty.length) {
    const message = `No scripts in ${empty.join(", ")}`;
    req.out(req.json ? JSON.stringify({ error: message }) : message);
    return 1;
  }
  // A git worktree of the game has the scripts but no sourcemap (it is not committed): the synced
  // checkout of the same repository has the place's tree
  let sourcemap: string | undefined;
  if (!fs.existsSync(path.join(root, "sourcemap.json")) && req.placeFolders) {
    sourcemap = await borrowedSourcemap(root, req.placeFolders).catch(() => undefined);
  }
  const project = loadProject(root, { files, sourcemap, ...(projectTree ? { tree: projectTree } : {}) });
  const live = req.live ? await liveKeys(root, project.liveCandidates(), req.live).catch((error: Error) => ({ note: `keys not read in a play: ${error.message}` })) : undefined;
  const report = project.report(live && "keys" in live ? live : undefined);
  if (live && !("keys" in live)) report.stats.live = { modules: 0, note: live.note };
  req.out(req.json ? JSON.stringify(report, null, 2) : reportText(report));
  return report.findings.length ? 1 : 0;
}

function gitCommonDir(dir: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return fileKey(out);
  } catch {
    return undefined;
  }
}

/** The sourcemap of the one registered place folder in the same repository as `root` */
async function borrowedSourcemap(root: string, placeFolders: () => Promise<string[]>): Promise<string | undefined> {
  const mine = gitCommonDir(root);
  if (!mine) return undefined;
  const folders = (await placeFolders()).filter((f) => fileKey(f) !== fileKey(root) && fs.existsSync(path.join(f, "sourcemap.json")) && gitCommonDir(f) === mine);
  return folders.length === 1 ? path.join(folders[0], "sourcemap.json") : undefined;
}

/** The place whose play holds this project's modules: its own folder, or the synced checkout of the same repository (a worktree) */
async function livePlace(root: string, play: LivePlay): Promise<{ folder: string; name: string; id: string } | null> {
  const places = await play.places();
  const own = places.find((p) => fileKey(p.folder) === fileKey(root));
  if (own) return own;
  const mine = gitCommonDir(root);
  const same = mine ? places.filter((p) => fs.existsSync(p.folder) && gitCommonDir(p.folder) === mine) : [];
  return same.length === 1 ? same[0] : null;
}

/**
 * Keys from the running play for the modules the text cannot read, or why there are none. Only
 * when a play is already running; a worktree's module is read only when its file is the same as
 * the place's (the play runs the place's text, so another text could have other keys).
 */
async function liveKeys(root: string, candidates: LiveCandidate[], play: LivePlay): Promise<LiveKeys | { note: string }> {
  if (!candidates.length) return { note: "every module used has its keys in its text" };
  const place = await livePlace(root, play);
  if (!place) return { note: "no registered place holds this project" };
  if (!(await play.playing(place.id))) return { note: `no play running in ${place.name}: keys from the text only` };
  const same = fileKey(place.folder) === fileKey(root)
    ? candidates
    : candidates.filter((c) => {
        try {
          return fs.readFileSync(c.file, "utf8") === fs.readFileSync(path.join(place.folder, path.relative(root, c.file)), "utf8");
        } catch {
          return false;
        }
      });
  if (!same.length) return { note: `the ${candidates.length} module(s) to read differ from ${place.name}'s` };
  const result = await play.evalServer(place.id, liveKeysCode(same.map((c) => ({ path: c.path, roots: c.roots }))), 60_000);
  if (!result.ok) return { note: `the play's server could not read them: ${String(result.error).split("\n")[0]}` };
  const answers = parseLiveAnswer(result.values?.[0], same.length);
  const keys = new Map<string, string[]>();
  answers.forEach((a, i) => {
    if (a.keys) keys.set(fileKey(same[i].file), a.keys);
  });
  return { place: place.name, keys };
}

export function reportText(r: AnalyzeReport): string {
  const lines = r.findings.map((f) => `${path.relative(r.root, f.file).replace(/\\/g, "/")}:${f.line}:${f.column}  ${f.rule}  ${f.message}`);
  const s = r.stats;
  const n = (x: number) => x.toLocaleString("en-US");
  lines.push(
    `${r.findings.length ? `${r.findings.length} found` : "Nothing found"} in ${n(s.scripts)} scripts, ${(s.ms / 1000).toFixed(1)} s: ${n(s.memberUses)} uses of a module's members, ${n(s.instancePaths)} instance paths (${s.tree === "sync folder" ? "paths not checked: no sourcemap, and no registered place of this repository has one" : s.sourcemap === path.join(r.root, "sourcemap.json") ? "tree from the sourcemap" : `tree from ${s.sourcemap}`}), every script parsed and linted.`,
  );
  if (s.live) lines.push(`Live keys: ${s.live.note}.`);
  if (s.modulesOpaque) lines.push(`${s.modulesOpaque} of ${s.modulesRead} required modules are not checked: their keys are not all written in their text (wrapped, a metatable, filled by a loop or another module).`);
  return lines.join("\n");
}
