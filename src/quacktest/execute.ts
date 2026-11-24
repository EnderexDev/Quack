import path from "node:path";
import { fileKey } from "../analyze/tree.js";
import { engine as findEngine, LUNE_VERSION } from "./lune.js";
import type { StandbyPool } from "./pool.js";
import { findSpecs, markUnreadable, pruneTrees, setupFile, syncFolderTree, treeSource, type SpecFile } from "./project.js";
import { reachingSpecs } from "./reach.js";
import { buildReport, type TestReport } from "./report.js";
import { LuneProcess, touch } from "./runner.js";

/**
 * One Quack Test run of a project, the same for the hub (`/api/test`, with its ready processes and
 * its analysis thread for the reach) and for the CLI with no hub (a process started for the run).
 */
export interface ExecuteOptions {
  /** The project folder (holding sync/ and tests/, or a Rojo project file) */
  root: string;
  /**
   * Spec files run as named; any other script stands for the specs that reach it. None: every
   * spec
   */
  files?: string[];
  /** Only tests whose full name ("Group/CoinsSpec › adds") holds one of these, without case */
  filter?: string[];
  /** The registered places' folders: a worktree borrows its checkout's sourcemap */
  placeFolders?: () => Promise<string[]>;
  /** The hub's ready processes */
  pool?: StandbyPool;
  /** How the specs reaching files are found (the hub: its analysis thread) */
  reach?: (root: string, files: string[]) => Promise<SpecFile[]>;
  /** Seconds one test may take (default 10) */
  testTimeout?: number;
}

const empty = (root: string, tree: string, note: string): TestReport => ({ root, rows: [], stats: { passed: 0, failed: 0, notRun: 0, specs: 0, ms: 0, tree }, note });

export async function executeTests(o: ExecuteOptions): Promise<TestReport> {
  const root = path.resolve(o.root);
  let all: SpecFile[];
  try {
    all = findSpecs(root);
  } catch (error) {
    return { ...empty(root, "", ""), note: undefined, error: (error as Error).message };
  }
  if (!all.length) return empty(root, "", `No specs in ${path.join(root, "tests")}: a spec is a module named *Spec.luau that returns its tests ({ ["name"] = function() ... end }).`);
  let specs = all;
  if (o.files?.length) {
    const byKey = new Map(all.map((s) => [fileKey(s.file), s]));
    const named = o.files.map((f) => byKey.get(fileKey(f))).filter((s): s is SpecFile => !!s);
    const others = o.files.filter((f) => !byKey.has(fileKey(f)));
    let reachedBy: SpecFile[] = [];
    try {
      if (others.length) reachedBy = await (o.reach ?? ((r, f) => reachingSpecs(r, f, o.placeFolders)))(root, others);
    } catch (error) {
      return { ...empty(root, "", ""), note: undefined, error: `the specs these files reach could not be found: ${(error as Error).message}` };
    }
    const chosen = new Set([...named, ...reachedBy].map((s) => fileKey(s.file)));
    specs = all.filter((s) => chosen.has(fileKey(s.file)));
    if (!specs.length) return empty(root, "", `No spec reaches ${others.map((f) => path.relative(root, f).split(path.sep).join("/")).join(", ")}.`);
  }
  let source: Awaited<ReturnType<typeof treeSource>>;
  try {
    source = await treeSource(root, o.placeFolders);
  } catch (error) {
    return { ...empty(root, "", ""), note: undefined, error: `the place's tree could not be read: ${(error as Error).message}` };
  }
  if ("error" in source) return { ...empty(root, "", ""), note: undefined, error: source.error };
  let engine: ReturnType<typeof findEngine>;
  try {
    engine = findEngine();
  } catch (error) {
    return { ...empty(root, source.tree.label, ""), note: undefined, error: (error as Error).message };
  }
  if (!engine) {
    return { ...empty(root, source.tree.label, ""), note: undefined, error: `Lune ${LUNE_VERSION} is not installed with this Quack (a checkout gets it with \`node scripts/fetch-lune.mjs\`)` };
  }
  const started = Date.now();
  let taken: { proc: LuneProcess; warm: boolean };
  try {
    taken = o.pool ? o.pool.take(root, engine, source.tree) : { proc: new LuneProcess(engine, source.tree), warm: false };
  } catch (error) {
    return { ...empty(root, source.tree.label, ""), note: undefined, error: (error as Error).message };
  }
  const { proc, warm } = taken;
  // 0 or less is no limit Luau would keep (0 is true there): the default
  const testTimeout = o.testTimeout !== undefined && o.testTimeout > 0 ? o.testTimeout : 10;
  // the runtime says when each test ends (and when the tree is loaded): a gap past twice a
  // test's limit, or two minutes for a big tree's first build, is a stuck process
  const idleMs = Math.max(120_000, testTimeout * 2000 + 30_000);
  const request = (present: typeof source.present) => ({
    root,
    specs,
    setup: setupFile(root),
    ...(o.filter?.length ? { filter: o.filter } : {}),
    ...(present ? { present } : {}),
    testTimeout,
  });
  let label = source.tree.label;
  // the tree this run ended up using: the next ready process loads the same one
  let used = source.tree;
  try {
    let raw;
    try {
      raw = await proc.run(request(source.present), idleMs);
      touch(source.tree.cache);
    } catch (error) {
      // a sourcemap Lune could not build from (cut mid-write in a way the quick check missed):
      // the sync folder's tree, once. Only when Lune exited by itself before its tree was
      // loaded: never after a stop, the silence limit, or a failure of the tests themselves
      if (proc.loaded || !proc.exitedAlone || source.tree.kind !== "sourcemap" || o.pool?.isStopped) throw error;
      markUnreadable(source.tree);
      const fallback = syncFolderTree(root, source.tree.source);
      label = fallback.label;
      used = fallback;
      const retry = o.pool ? o.pool.take(root, engine, fallback).proc : new LuneProcess(engine, fallback);
      try {
        raw = await retry.run(request(undefined), idleMs);
      } finally {
        if (o.pool) o.pool.release(retry);
        else retry.kill();
      }
    }
    const report = buildReport(root, raw, label, o.pool ? warm : undefined);
    // the whole run as the caller waited for it, the tree's load included when it was not ready
    report.stats.ms = Date.now() - started;
    return report;
  } catch (error) {
    return { ...empty(root, label, ""), note: undefined, error: (error as Error).message };
  } finally {
    if (o.pool) o.pool.release(proc);
    else proc.kill();
    if (o.pool) {
      // the next run's process, made again by the pool when the project's tree changes before it
      const refresh = async () => {
        const now = await treeSource(root, o.placeFolders);
        const next = findEngine();
        return "error" in now || !next ? null : { engine: next, tree: now.tree };
      };
      o.pool.prepare(root, engine, used, refresh);
    } else pruneTrees();
  }
}
