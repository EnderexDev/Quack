import fs from "node:fs";
import path from "node:path";
import { loadProject, type AnalyzeReport, type Finding, type ParseCache } from "../analyze/analyze.js";
import { borrowedSourcemap } from "../analyze/command.js";
import { treeFromProject } from "../analyze/project.js";
import { fileKey, loadTree, type GameTree } from "../analyze/tree.js";

/**
 * The analysis that stays loaded between runs (the hub's worker thread): per project, the parse of
 * every script and the place's tree are kept, so a run after an edit reads and parses only what
 * changed. Measured on 12/11/26 in the ANIME ASTRAL COPY (1,459 scripts): 2.4 to 3.3 s cold, 0.86
 * to 1.0 s for the whole place warm. The tree is loaded again only when the sourcemap's size or
 * time changes (rebuilding it costs ~0.25 s, and editing text never changes it).
 *
 * Text only: the keys a running play could tell (`quack analyze` slice 2) are never read here,
 * since a run happens on every edit and must not touch Studio.
 */
export interface ResidentRequest {
  /** The project folder (holding sync/, or a Rojo project file) */
  root: string;
  /** The files a review is about (absolute); none: the whole place */
  files?: string[];
  /** The registered places' folders, for a worktree's sourcemap */
  placeFolders: string[];
}

export interface ResidentAnswer {
  /** Every finding of the place (whole), or of the files asked for */
  findings: Finding[];
  /** Findings in other files that the place did not have at the last run (a caller the edit broke); empty on a project's first run */
  elsewhere: Finding[];
  stats: AnalyzeReport["stats"];
}

interface Entry {
  cache: ParseCache;
  tree?: GameTree;
  treeStamp?: string;
  /** A worktree's borrowed sourcemap (null: none), and the registered folders it was looked up among */
  borrowed?: string | null;
  borrowedAmong?: string;
  /**
   * The last runs' findings over the whole place (reviews and the panel's), by what they say
   * (lines move with every edit), with when each run started: a review compares with the newest
   * one that started before its edit, so neither a panel run nor another review that came after
   * the edit takes the edit's findings as already known
   */
  baselines: Baseline[];
  used: number;
}

/** Runs kept as baselines per project: a few edits can queue their reviews behind each other */
const BASELINES = 6;
const CLOCK_MARGIN_MS = 50;

interface Baseline {
  at: number;
  ids: Set<string>;
}

/** Projects kept at once: the Astral's parses take ~340 MB */
const MAX_PROJECTS = 3;

const identity = (f: Finding) => `${fileKey(f.file)}|${f.rule}|${f.message}`;

function stampOf(file: string | undefined): string {
  if (!file) return "none";
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "none";
  }
}

export class ResidentAnalysis {
  private readonly projects = new Map<string, Entry>();

  /** How many projects are loaded (the hub shows it, tests read it) */
  get size(): number {
    return this.projects.size;
  }

  drop(root?: string): void {
    if (root) this.projects.delete(fileKey(path.resolve(root)));
    else this.projects.clear();
  }

  async run(req: ResidentRequest): Promise<ResidentAnswer> {
    const root = path.resolve(req.root);
    const key = fileKey(root);
    let entry = this.projects.get(key);
    if (!entry) {
      entry = { cache: new Map(), baselines: [], used: 0 };
      this.projects.set(key, entry);
      if (this.projects.size > MAX_PROJECTS) {
        const oldest = [...this.projects.entries()].filter(([k]) => k !== key).sort((a, b) => a[1].used - b[1].used)[0];
        if (oldest) this.projects.delete(oldest[0]);
      }
    }
    const started = Date.now();
    entry.used = started;
    const syncDir = path.join(root, "sync");
    let report: AnalyzeReport;
    if (fs.existsSync(syncDir)) {
      let sourcemap: string | undefined = path.join(root, "sourcemap.json");
      if (!fs.existsSync(sourcemap)) {
        // looked up again when the registered folders change (the checkout registered later) or the borrowed file is gone
        const among = JSON.stringify(req.placeFolders);
        if (entry.borrowed === undefined || entry.borrowedAmong !== among || (entry.borrowed && !fs.existsSync(entry.borrowed))) {
          entry.borrowed = (await borrowedSourcemap(root, async () => req.placeFolders).catch(() => undefined)) ?? null;
          entry.borrowedAmong = among;
        }
        sourcemap = entry.borrowed ?? undefined;
      }
      const stamp = stampOf(sourcemap);
      // a tree read from the sync folder (no sourcemap, or one cut mid-write) follows its files:
      // read again every run, so a module added since is found by the requires that name it
      if (!entry.tree || entry.treeStamp !== stamp || !entry.tree.complete) {
        entry.tree = loadTree(root, syncDir, sourcemap ?? path.join(root, "sourcemap.json"));
        entry.treeStamp = stamp;
      }
      report = loadProject(root, { sourcemap, loadedTree: entry.tree, cache: entry.cache }).report();
    } else {
      // a Rojo project: its tree is its project file and the disk, read again each run
      const tree = await treeFromProject(root);
      if (!tree) throw new Error(`no sync folder or readable project file in ${root}`);
      report = loadProject(root, { tree, cache: entry.cache }).report();
    }
    // the whole place is checked every time (a run costs about the same either way, since the
    // binding is global): what the edit broke in a caller shows up too
    const wanted = req.files?.length ? new Set(req.files.map((f) => fileKey(path.resolve(f)))) : null;
    const findings = wanted ? report.findings.filter((f) => wanted.has(fileKey(f.file))) : report.findings;
    const ids = new Set(report.findings.map(identity));
    let elsewhere: Finding[] = [];
    if (wanted) {
      const edited = Math.min(...[...(req.files ?? [])].map((f) => {
        try {
          return fs.statSync(f).mtimeMs;
        } catch {
          return started;
        }
      }));
      // A file's time runs ahead of Date.now() here (measured 12/11/26: 1.0 to 1.4 ms on NTFS), so a
      // run that started right after the write looks earlier than it: only one that started
      // CLOCK_MARGIN_MS before the edit counts as before it
      const before = entry.baselines.filter((b) => b.at < edited - CLOCK_MARGIN_MS).sort((a, b) => b.at - a.at)[0];
      if (before) elsewhere = report.findings.filter((f) => !wanted.has(fileKey(f.file)) && !before.ids.has(identity(f)));
    }
    entry.baselines.push({ at: started, ids });
    if (entry.baselines.length > BASELINES) entry.baselines.shift();
    return { findings, elsewhere, stats: report.stats };
  }
}
