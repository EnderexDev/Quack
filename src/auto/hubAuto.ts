import fs from "node:fs";
import path from "node:path";
import { gitCommonDir, projectRoot } from "../analyze/command.js";
import type { Finding } from "../analyze/analyze.js";
import { fileKey } from "../analyze/tree.js";
import type { RegisteredPlace } from "../hub/registry.js";
import type { AnalysisService } from "./service.js";
import { hooksRepository, setPrecommitHook, type HookStatus, type PrecommitEntry } from "./precommit.js";
import { autoEnabled, readAutoSettings, writeAutoSettings, type AutoFeature, type AutoPatch, type AutoSettings } from "./settings.js";

/**
 * What the hub runs on its own (his call, 12/11/26), in the hub because it is the one process
 * always up: a place's daemon exists only while its Studio is open, and an AI edits with Studio
 * closed all the time.
 *  - review: an AI client's hook (review.ts) sends the files it just edited; the answer is the
 *    findings in them, and the ones the edit added elsewhere (a caller it broke)
 *  - panel: each registered place's folder is watched; a script or sourcemap change (from Studio
 *    through its daemon, or from the disk) runs the whole place again, and the app lists the result
 * Both go through the resident analysis (one worker thread, parses kept between runs).
 */
export interface PanelFinding {
  /** From the place's folder, with / */
  file: string;
  line: number;
  column: number;
  rule: string;
  message: string;
}

export interface PanelState {
  state: "off" | "waiting" | "running" | "ready" | "error";
  findings: PanelFinding[];
  /** When the findings were found, and what the run cost */
  at?: number;
  ms?: number;
  scripts?: number;
  error?: string;
}

export interface ReviewAnswer {
  /** The feature is off for this project (in the app's settings): nothing was run */
  disabled?: boolean;
  root?: string;
  placeId?: string;
  findings: PanelFinding[];
  elsewhere: PanelFinding[];
  ms?: number;
}

export interface HubAutoOptions {
  settingsFile: string;
  places: () => Record<string, RegisteredPlace>;
  service: AnalysisService;
  log: (line: string) => void;
  /** Wait after the last change before a run (default 1.5 s) */
  debounceMs?: number;
  /** How the pre-commit hook starts this flavor's CLI; none (tests): no hook is ever installed */
  precommit?: PrecommitEntry;
  /** Where the folders holding a hook are kept between hub runs */
  hooksFile?: string;
  /** Puts a hook in or takes it out (tests make it fail) */
  setHook?: typeof setPrecommitHook;
}

/** A path relative to a place's folder that may change what the analysis says */
export function panelCounts(rel: string, folder?: string): boolean {
  const parts = rel.split(/[\\/]/);
  // the sync folder itself removed or replaced whole names only "sync"
  if (parts.length === 1) return parts[0] === "sourcemap.json" || parts[0] === "sync";
  if (parts[0] !== "sync" || parts.some((p) => p.startsWith("."))) return false;
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".luau" || ext === ".lua" || ext === "") return true;
  // a folder renamed or removed moves every script in it, and its name may have a dot
  // (sync/Version.2): a folder there now, or a path gone, counts
  if (!folder) return false;
  try {
    return fs.statSync(path.join(folder, rel)).isDirectory();
  } catch {
    return true;
  }
}

interface Watched {
  folder: string;
  watcher?: fs.FSWatcher;
  timer?: NodeJS.Timeout;
  running: boolean;
  dirty: boolean;
  /** Size and time of each path an event named, so a read (which Windows reports as a change) is no change */
  stamps: Map<string, string>;
  state: PanelState;
}

const stampOf = (file: string): string => {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "gone";
  }
};

export class HubAutomation {
  private readonly watched = new Map<string, Watched>();
  /** Each place's pre-commit hook, as the last reconcile left it */
  private readonly hooks = new Map<string, HookStatus>();
  /** The folder each installed hook went into, to take it out after the place leaves or moves (kept on disk: hooksFile) */
  private readonly hookFolders: Map<string, string>;
  /** Folders whose hook has to come out (a place gone or moved) and did not yet: tried on every reconcile, kept on disk */
  private readonly staleHooks = new Set<string>();
  /** The registry as the last refresh saw it: a change made from a terminal reconciles the hooks too */
  private placesKey = "";
  private hooksChain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: HubAutoOptions) {
    this.hookFolders = this.loadHookFolders();
  }

  settings(): AutoSettings {
    return readAutoSettings(this.options.settingsFile);
  }

  setSettings(patch: AutoPatch): AutoSettings {
    if (patch.place && !this.options.places()[patch.place.placeId]) throw new Error(`place ${patch.place.placeId} is not registered`);
    const next = writeAutoSettings(this.options.settingsFile, patch);
    this.options.log(`Automation settings: ${JSON.stringify(patch)}`);
    this.refresh();
    void this.reconcileHooks();
    return next;
  }

  enabled(feature: AutoFeature, placeId?: string | null): boolean {
    return autoEnabled(this.settings(), feature, placeId);
  }

  /** The registered place a project folder belongs to: its own folder, or the one checkout of the same repository (a worktree) */
  placeOf(root: string): string | undefined {
    const places = Object.entries(this.options.places());
    const own = places.find(([, p]) => fileKey(path.resolve(p.folder)) === fileKey(root));
    if (own) return own[0];
    // a worktree: git answers (synchronously, on the hub's thread) once a minute per folder
    const kept = this.worktreePlaces.get(fileKey(root));
    if (kept && Date.now() - kept.at < 60_000) return kept.placeId;
    const mine = gitCommonDir(root);
    const same = mine ? places.filter(([, p]) => fs.existsSync(p.folder) && gitCommonDir(p.folder) === mine) : [];
    const placeId = same.length === 1 ? same[0][0] : undefined;
    this.worktreePlaces.set(fileKey(root), { placeId, at: Date.now() });
    return placeId;
  }

  private readonly worktreePlaces = new Map<string, { placeId: string | undefined; at: number }>();

  /** The review an AI client's hook (or the pre-commit check) asks for, on files of one project */
  async review(files: string[], feature: "review" | "precommit", texts?: Record<string, string>, absent?: string[]): Promise<ReviewAnswer> {
    // a file given with its text (the commit's copy) counts even when the disk no longer has it
    const given = new Set(Object.keys(texts ?? {}).map((f) => fileKey(f)));
    const scripts = files.map((f) => path.resolve(f)).filter((f) => /\.luau?$/i.test(f) && (fs.existsSync(f) || given.has(fileKey(f))));
    // one edit may touch several projects (a patch over two games): each is reviewed on its own
    const byRoot = new Map<string, string[]>();
    for (const f of scripts) {
      const root = projectRoot(f);
      if (root) byRoot.set(root, [...(byRoot.get(root) ?? []), f]);
    }
    if (!byRoot.size) return { findings: [], elsewhere: [] };
    const started = Date.now();
    const several = byRoot.size > 1;
    const out: ReviewAnswer = { findings: [], elsewhere: [] };
    let ran = false;
    for (const [root, mine] of byRoot) {
      const placeId = this.placeOf(root);
      if (!out.root) Object.assign(out, { root, ...(placeId ? { placeId } : {}) });
      if (!this.enabled(feature, placeId)) continue;
      ran = true;
      // this project's texts and absent files (a dependency the commit holds otherwise than the disk)
      const inRoot = (f: string) => fileKey(projectRoot(f) ?? "") === fileKey(root);
      const ownTexts = texts ? Object.fromEntries(Object.entries(texts).filter(([f]) => inRoot(f))) : undefined;
      const ownAbsent = absent?.filter(inRoot);
      const answer = await this.options.service.run({
        root,
        files: mine,
        placeFolders: Object.values(this.options.places()).map((p) => p.folder),
        ...(ownTexts ? { texts: ownTexts } : {}),
        ...(ownAbsent?.length ? { absent: ownAbsent } : {}),
      });
      // from its own project; with several, the whole path says which project
      const rel = (f: Finding) => (several ? { ...this.relative(root, f), file: f.file.replace(/\\/g, "/") } : this.relative(root, f));
      out.findings.push(...answer.findings.map(rel));
      out.elsewhere.push(...answer.elsewhere.map(rel));
    }
    if (!ran) return { ...out, disabled: true };
    return { ...out, ms: Date.now() - started };
  }

  private relative(root: string, f: Finding): PanelFinding {
    return { file: path.relative(root, f.file).replace(/\\/g, "/"), line: f.line, column: f.column, rule: f.rule, message: f.message };
  }

  /** The panel of one place */
  panel(placeId: string): PanelState {
    return this.watched.get(placeId)?.state ?? { state: "off", findings: [] };
  }

  /** The findings count of each place whose panel has run (the app's place list and tray) */
  counts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, w] of this.watched) if (w.state.at !== undefined) out.set(id, w.state.findings.length);
    return out;
  }

  /** Runs one place's panel now (the app's "Run again") */
  rerun(placeId: string): void {
    const w = this.watched.get(placeId);
    if (!w) throw new Error(`the panel is off for place ${placeId}`);
    this.schedule(placeId, w, 0);
  }

  start(): void {
    this.refresh();
    // every place once: a check turned off while the hub was down has its hook taken out
    void this.reconcileHooks(true);
  }

  /** Once the reconciles asked so far are done (tests) */
  hooksSettled(): Promise<void> {
    return this.hooksChain;
  }

  /** Where each place's pre-commit hook stands */
  hookStatus(): Record<string, HookStatus> {
    return Object.fromEntries(this.hooks);
  }

  /**
   * Puts the pre-commit hook in the repository of each place whose check is on, and takes it out
   * where it is off. One reconcile at a time; it waits for the one before
   */
  reconcileHooks(everyPlace = false): Promise<void> {
    const entry = this.options.precommit;
    if (!entry || this.stopped) return this.hooksChain;
    this.hooksChain = this.hooksChain.then(async () => {
      const settings = this.settings();
      const places = this.options.places();
      const same = (a: string, b: string) => fileKey(path.resolve(a)) === fileKey(path.resolve(b));
      // Places of one repository share its hook (worktrees, or several places of one game): it
      // stays while any of them has the check on. A place never turned on and never given a
      // hook is not looked at: nothing of Quack's can be there
      const groups = new Map<string, { folder: string; ids: string[]; on: boolean }>();
      for (const [id, place] of Object.entries(places)) {
        const on = autoEnabled(settings, "precommit", id);
        const before = this.hooks.get(id);
        if (!on && !everyPlace && !this.hookFolders.has(id) && (before === undefined || before === "not installed")) continue;
        const repo = await hooksRepository(place.folder);
        const key = repo ? fileKey(repo) : `folder:${fileKey(path.resolve(place.folder))}`;
        const group = groups.get(key) ?? { folder: place.folder, ids: [], on: false };
        group.ids.push(id);
        group.on ||= on;
        groups.set(key, group);
      }
      // a place unregistered or moved (also while the hub was down: the folders are on disk):
      // its hook leaves the folder it went in, unless a place still on shares that repository.
      // Forgotten only once it is out, so a removal that failed is tried again
      // a removal that failed waits in its own list, apart from the place's current folder
      for (const [id, folder] of [...this.hookFolders]) {
        if (places[id] && same(places[id].folder, folder)) continue;
        this.hookFolders.delete(id);
        if (!places[id]) this.hooks.delete(id);
        if (![...this.staleHooks].some((f) => same(f, folder))) this.staleHooks.add(folder);
      }
      for (const folder of [...this.staleHooks]) {
        const repo = await hooksRepository(folder);
        if (repo && groups.get(fileKey(repo))?.on) {
          this.staleHooks.delete(folder);
          continue;
        }
        try {
          await (this.options.setHook ?? setPrecommitHook)(folder, false, entry);
          this.staleHooks.delete(folder);
        } catch (error) {
          this.options.log(`${folder}: pre-commit hook not taken out, tried again later (${(error as Error).message})`);
        }
      }
      for (const group of groups.values()) {
        let status: HookStatus;
        try {
          status = await (this.options.setHook ?? setPrecommitHook)(group.folder, group.on, entry);
        } catch (error) {
          this.options.log(`${group.folder}: pre-commit hook not changed (${(error as Error).message})`);
          status = "failed";
        }
        for (const id of group.ids) {
          if (status !== this.hooks.get(id)) this.options.log(`${places[id].name ?? id}: pre-commit check ${status}`);
          this.hooks.set(id, status);
          if (status === "installed") this.hookFolders.set(id, places[id].folder);
          else if (status !== "failed") this.hookFolders.delete(id);
        }
      }
      this.saveHookFolders();
    });
    return this.hooksChain;
  }

  private loadHookFolders(): Map<string, string> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.options.hooksFile ?? "", "utf8"));
      for (const f of Array.isArray(parsed?.stale) ? parsed.stale : []) if (typeof f === "string") this.staleHooks.add(f);
      return new Map(Object.entries(parsed?.folders ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch {
      return new Map();
    }
  }

  private saveHookFolders(): void {
    const file = this.options.hooksFile;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ folders: Object.fromEntries(this.hookFolders), stale: [...this.staleHooks] }, null, 2)}\n`);
    } catch (error) {
      this.options.log(`Could not save ${file} (${(error as Error).message})`);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const w of this.watched.values()) this.unwatch(w);
    this.watched.clear();
  }

  /**
   * Watches the places whose panel is on, stops watching the others. Called at start, on every
   * settings change and on the hub's registry changes
   */
  refresh(): void {
    if (this.stopped) return;
    const places = this.options.places();
    const settings = this.settings();
    // a place registered, removed or moved since (also from a terminal): its hook follows
    const placesKey = JSON.stringify(Object.entries(places).map(([id, p]) => [id, p.folder]));
    if (this.placesKey && placesKey !== this.placesKey) void this.reconcileHooks();
    this.placesKey = placesKey;
    for (const [id, w] of this.watched) {
      const place = places[id];
      if (place && autoEnabled(settings, "panel", id) && fileKey(path.resolve(place.folder)) === fileKey(w.folder)) continue;
      this.unwatch(w);
      this.watched.delete(id);
      void this.options.service.drop(w.folder).catch(() => {});
    }
    for (const [id, place] of Object.entries(places)) {
      if (this.watched.has(id) || !autoEnabled(settings, "panel", id)) continue;
      const folder = path.resolve(place.folder);
      if (!fs.existsSync(path.join(folder, "sync"))) continue;
      const w: Watched = { folder, running: false, dirty: false, stamps: new Map(), state: { state: "waiting", findings: [] } };
      this.watched.set(id, w);
      try {
        w.watcher = fs.watch(folder, { recursive: true }, (_event, name) => {
          if (!name) return this.schedule(id, w);
          const rel = name.toString();
          if (!panelCounts(rel, folder)) return;
          const now = stampOf(path.join(folder, rel));
          if (w.stamps.get(rel) === now) return;
          w.stamps.set(rel, now);
          this.schedule(id, w);
        });
        w.watcher.on("error", (error) => this.options.log(`${place.name ?? id}: the panel's watcher stopped (${error.message})`));
      } catch (error) {
        this.options.log(`${place.name ?? id}: the panel cannot watch ${folder} (${(error as Error).message})`);
      }
      this.schedule(id, w, 0);
    }
  }

  private unwatch(w: Watched): void {
    w.watcher?.close();
    if (w.timer) clearTimeout(w.timer);
    w.state = { state: "off", findings: [] };
  }

  private schedule(placeId: string, w: Watched, delay = this.options.debounceMs ?? 1500): void {
    if (this.stopped || this.watched.get(placeId) !== w) return;
    if (w.running) {
      w.dirty = true;
      return;
    }
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => void this.runPanel(placeId, w), delay);
    w.timer.unref();
  }

  private async runPanel(placeId: string, w: Watched): Promise<void> {
    if (this.watched.get(placeId) !== w) return;
    w.running = true;
    w.dirty = false;
    w.state = { ...w.state, state: "running" };
    const started = Date.now();
    try {
      const answer = await this.options.service.run({ root: w.folder, placeFolders: Object.values(this.options.places()).map((p) => p.folder) });
      if (this.watched.get(placeId) !== w) return;
      w.state = { state: "ready", findings: answer.findings.map((f) => this.relative(w.folder, f)), at: Date.now(), ms: Date.now() - started, scripts: answer.stats.scripts };
    } catch (error) {
      if (this.watched.get(placeId) !== w) return;
      w.state = { ...w.state, state: "error", error: (error as Error).message };
    } finally {
      w.running = false;
      if (w.dirty) this.schedule(placeId, w);
    }
  }
}

