import { fileKey } from "../analyze/tree.js";
import type { Engine } from "./lune.js";
import type { TreeSource } from "./project.js";
import { LuneProcess } from "./runner.js";

/**
 * The hub's Quack Test processes (his call, 23/11/26: kept ready instead of embedding Lune). One
 * per project folder, holding the place's tree loaded (0.6 s from the kept .rbxl for the Astral
 * copy's 272k instances, ~130 MB, no CPU while it waits), so a run pays only for its specs. A
 * process runs one request and exits, since a test may change the tree; the next one starts
 * loading right after, while nobody waits. A project whose tree changed (a sourcemap rewritten
 * when a script is made or moved in Studio, or a newer runtime) gets a new one within refreshMs,
 * also while nobody waits. One left unused for idleMs is stopped.
 */
interface Kept {
  proc: LuneProcess;
  root: string;
  key: string;
  timer: NodeJS.Timeout;
  /** When it stops if nobody uses it (a refresh keeps this time) */
  expires: number;
  /** The project's engine and tree as they are now, to see whether this process's are still them */
  refresh?: Refresh;
}

/** The engine and tree a project's next run would use; null when it has none now */
export type Refresh = () => Promise<{ engine: Engine; tree: TreeSource } | null>;

export interface PoolOptions {
  /** Stop a process nobody used for this long (default 10 minutes) */
  idleMs?: number;
  /** Projects kept ready at once; the one used longest ago goes first (default 3) */
  max?: number;
  /** How often a ready process's tree is compared with its project's (default 30 s) */
  refreshMs?: number;
  log?: (line: string) => void;
}

export class StandbyPool {
  private readonly kept = new Map<string, Kept>();
  /** Processes taken for a run and not released yet */
  private readonly running = new Set<LuneProcess>();
  private stopped = false;
  private refreshing = false;
  private readonly refresher: NodeJS.Timeout;

  constructor(private readonly options: PoolOptions = {}) {
    this.refresher = setInterval(() => void this.refreshAll(), options.refreshMs ?? 30_000);
    this.refresher.unref();
  }

  get size(): number {
    return this.kept.size;
  }

  /** stop() was called: no run starts, none is retried */
  get isStopped(): boolean {
    return this.stopped;
  }

  private static key(engine: Engine, tree: TreeSource): string {
    // the sourcemap's size and time too: with no cache (none could be made) the paths stay the same
    return `${engine.dir}|${tree.source}|${tree.cache ?? ""}|${tree.stamp ?? ""}`;
  }

  /**
   * The project's ready process, or a new one; `warm` says whether it was started before this run.
   * It stays the pool's until the run ends (stop() ends it too); none once the pool is stopped
   */
  take(root: string, engine: Engine, tree: TreeSource): { proc: LuneProcess; warm: boolean } {
    if (this.stopped) throw new Error("the hub is stopping");
    const id = fileKey(root);
    const key = StandbyPool.key(engine, tree);
    const kept = this.kept.get(id);
    let taken: { proc: LuneProcess; warm: boolean } | undefined;
    if (kept) {
      this.kept.delete(id);
      clearTimeout(kept.timer);
      if (kept.key === key && kept.proc.alive) taken = { proc: kept.proc, warm: true };
      else kept.proc.kill();
    }
    taken ??= { proc: new LuneProcess(engine, tree), warm: false };
    const proc = taken.proc;
    this.running.add(proc);
    proc.ready.then(
      () => {},
      () => this.running.delete(proc),
    );
    return taken;
  }

  /** A taken process's run is over */
  release(proc: LuneProcess): void {
    this.running.delete(proc);
    proc.kill();
  }

  /** Starts the next process for a project, loading its tree while nobody waits */
  prepare(root: string, engine: Engine, tree: TreeSource, refresh?: Refresh, expires = Date.now() + (this.options.idleMs ?? 10 * 60_000)): void {
    if (this.stopped) return;
    const id = fileKey(root);
    const key = StandbyPool.key(engine, tree);
    const old = this.kept.get(id);
    if (old?.key === key && old.proc.alive) return;
    if (old) {
      clearTimeout(old.timer);
      old.proc.kill();
    }
    const proc = new LuneProcess(engine, tree);
    proc.ready.catch((error: Error) => {
      if (this.kept.get(id)?.proc === proc) this.kept.delete(id);
      this.options.log?.(`Quack Test: a ready process for ${root} failed (${error.message})`);
    });
    const timer = setTimeout(() => {
      if (this.kept.get(id)?.proc !== proc) return;
      this.kept.delete(id);
      proc.kill();
    }, Math.max(0, expires - Date.now()));
    timer.unref();
    this.kept.set(id, { proc, root, key, timer, expires, ...(refresh ? { refresh } : {}) });
    const max = this.options.max ?? 3;
    while (this.kept.size > max) {
      const [first, entry] = this.kept.entries().next().value as [string, Kept];
      clearTimeout(entry.timer);
      entry.proc.kill();
      this.kept.delete(first);
    }
  }

  /** Replaces each ready process whose tree is no longer its project's */
  async refreshAll(): Promise<void> {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      for (const [id, entry] of [...this.kept]) {
        if (!entry.refresh) continue;
        const next = await entry.refresh().catch(() => null);
        if (!next || this.kept.get(id) !== entry || StandbyPool.key(next.engine, next.tree) === entry.key) continue;
        this.options.log?.(`Quack Test: the tree of ${entry.root} changed, its ready process is made again`);
        this.prepare(entry.root, next.engine, next.tree, entry.refresh, entry.expires);
      }
    } finally {
      this.refreshing = false;
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.refresher);
    for (const entry of this.kept.values()) {
      clearTimeout(entry.timer);
      entry.proc.kill();
    }
    this.kept.clear();
    // a run going on now ends with its process (its caller gets "Lune exited")
    for (const proc of this.running) proc.kill();
    this.running.clear();
  }
}
