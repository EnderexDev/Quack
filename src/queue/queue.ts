import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { changedScripts, fnv1a, foreignIn, hashAll, loadSourcemap, planGroups, recentFiles, samePath, type Sourcemap } from "./disk.js";
import { isLevel, RUNNER, StudioLock, type Client, type Level } from "./lock.js";
import { luaString, phaseCode } from "./prelude.js";
import { effectiveSettings, readGameConfig, type QueueSettings } from "./settings.js";

/**
 * A place's Studio queue (Spec "Fila do Studio no Quack"): the jobs clients submit, the Studio
 * lock and its waiting list, and the runner that puts every ready job through as few plays as it
 * can, with the place's daemon's own Studio tools.
 *
 * A job: setup (server), client (client), check (server), cleanup (server, always), each one
 * eval in the running play with `ctx` (prelude.ts), then its own slice of the play's output. Its
 * verdict says pass or fail and why, or `infra` when Studio, the daemon or the play failed and
 * waiting did not fix it (that says nothing about the job).
 *
 * How a batch runs:
 * 1. Jobs that arrive while no play is the runner's wait a short collection window, so the clients
 *    that finish together share one play.
 * 2. A job joins the play already running when it is not `fresh`, comes from a folder that play
 *    runs, and none of its files changed on disk since that play started.
 * 3. The synced folder's jobs: stop, check that Studio's .Source matches disk for every file that
 *    matters, start, run. A worktree's jobs: a play of its branch (the daemon's worktree play,
 *    which swaps the branch's scripts in and checks them inside the play). Worktrees whose branches
 *    change no script in common share one play; a worktree the check says is missing plays alone.
 * 4. A job that fails in a play shared with other worktrees runs again in a play of its own branch
 *    alone before its failure is answered (the neighbour's branch may be what broke it), and the
 *    verdict keeps both runs (sharedRetry "foreign": only when the error names a module outside
 *    the job's files).
 * 5. A job that failed in its own code keeps its play `holdSec` for its client's fixed resubmit.
 * 6. Infrastructure failures go back to the queue after a wait, `infraTries` times, and only then
 *    are answered, as infra.
 * 7. The play stays up `lingerSec` for a late job, then stops; the runner gives the lock back.
 * 8. A client that asks for Studio live (an exclusive waiter) gets it once the batch ends.
 *
 * Everything is saved under the place's .quack/queue/: the state (jobs waiting, the lock, its
 * waiting list, the play left up) so a hub restart keeps them, each verdict, and the history.
 */

/** The place's daemon, as the runner reaches it */
export interface StudioPort {
  /** One Studio tool (eval, exec, playtest, logs) through the place's daemon; rejects when it fails */
  studio(tool: string, args: Record<string, unknown>, waitMs?: number): Promise<any>;
  /** A play of these worktrees' branches; resolves to the daemon's play state once its check came back (or the wait ran out) */
  play(worktrees: string[]): Promise<any>;
}

export interface Timings {
  windowMs: number;
  tickMs: number;
  lockRetryMs: number;
  syncWaitMs: number;
  startRetryMs: number;
  recentMs: number;
  maxChecked: number;
  /** A capped client's play still up this long with jobs waiting: the cap is lifted so it can stop it */
  capPlayMs: number;
  phaseTimeoutMs: number;
  /** How long a play left up by the previous hub is asked about while Studio does not answer */
  adoptMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  windowMs: 2500,
  tickMs: 300,
  lockRetryMs: 2000,
  syncWaitMs: 30_000,
  startRetryMs: 30_000,
  recentMs: 30 * 60_000,
  maxChecked: 60,
  capPlayMs: 2 * 60_000,
  phaseTimeoutMs: 120_000,
  adoptMs: 60_000,
};

export interface JobInput {
  name: string;
  files: string[] | null;
  fresh: boolean;
  /** The folder the job runs: the place's synced folder, or a git worktree of it (its branch) */
  root: string;
  source: string;
}

interface InfraTries {
  n: number;
  retryAt: number;
  last: string;
}

export interface Job extends JobInput {
  id: string;
  client: Client;
  submittedAt: number;
  state: "pending" | "running";
  infra?: InfraTries;
  /** Failed in a shared play: runs again alone, and this is the first run */
  soloRetry?: { with: string[]; pass: false; play: string; reason: string; ms: number };
}

export interface Verdict {
  id: string;
  name: string;
  client: Client;
  pass: boolean;
  infra?: boolean;
  reason?: string;
  play?: string;
  phases?: Record<string, any>;
  console?: string[];
  notYours?: string | null;
  quackPlay?: string[];
  syncWarnings?: string[];
  held?: number;
  sharedWith?: string[];
  firstRun?: Job["soloRetry"];
  infraRetried?: string;
  dropped?: string;
  ms: number;
  queuedMs: number;
  finishedAt: number;
}

export interface QueueOptions {
  placeId: string;
  folder: string;
  name?: string;
  port: StudioPort;
  settings: () => QueueSettings;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  log?: (line: string) => void;
  timings?: Partial<Timings>;
}

const LAZY_SAVE_MS = 5000;
const INFRA_PHASE = /^a phase call failed|^the cleanup call failed|^unreadable phase result/;
const TIMED_OUT = /did not answer in \d+ s/;
const LEVEL_CODE: Record<string, string> = { MessageError: "ERR", MessageWarning: "WARN", MessageInfo: "INFO", MessageOutput: "OUT" };
const ORDER: Level[] = ["critical", "blocking", "update", "normal", "low"];

/** Where a place's queue keeps its state, verdicts and history */
export function queueDir(folder: string, placeId: string): string {
  return path.join(folder, ".quack", "queue", placeId);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

class LockLost extends Error {}

const day = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

type Extra = { quackPlay?: string[]; syncWarnings?: string[] };

export class PlaceQueue {
  readonly placeId: string;
  readonly folder: string;
  name?: string;
  readonly lock: StudioLock;
  private jobs = new Map<string, Job>();
  private readonly port: StudioPort;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly alive: (pid: number) => boolean;
  private readonly log: (line: string) => void;
  private readonly t: Timings;
  private readonly globalSettings: () => QueueSettings;
  private readonly dir: string;
  private looping: Promise<void> | null = null;
  private stopped = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private saveSoon = false;
  /** How many state writes happened (tests) */
  saves = 0;
  private lastPrune = 0;
  /** The play the old hub's runner left up: adopted only when it still carries the token */
  private adoptable: { token: string; roots: string[] } | null = null;
  private adoptSince: number | undefined;

  // The play the runner started
  private playing = false;
  private playToken: string | null = null;
  private playRoots: string[] = [];
  private playId: string | null = null;
  private playStartedAt = 0;
  private extraOf = new Map<string, Extra>();
  private snapshots = new Map<string, Map<string, number>>();
  private lastCycleSnapshot: Map<string, number> | null = null;
  private carryOver = new Set<string>();
  private lastSourcemap: Sourcemap | null = null;
  private jobsInPlay = 0;
  private hold: { client: string; root: string; until: number; jobsAt: number; name: string } | null = null;
  private cursor: string | null = null;
  private multiPlay = true;
  private phase = "idle";
  private runningJob: { id: string; name: string; client: Client; since: number } | null = null;
  private waiting: { key: string; reason: string; queue: number; since: number } | null = null;

  constructor(options: QueueOptions) {
    this.placeId = options.placeId;
    this.folder = path.resolve(options.folder);
    this.name = options.name;
    this.port = options.port;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.alive = options.alive ?? pidAlive;
    this.log = options.log ?? (() => {});
    this.t = { ...DEFAULT_TIMINGS, ...options.timings };
    this.globalSettings = options.settings;
    // One folder per place: two places registered with one folder never share a queue
    this.dir = queueDir(this.folder, this.placeId);
    this.lock = new StudioLock({
      now: this.now,
      alive: this.alive,
      settings: () => this.settings(),
      pending: () => this.pendingSummary(),
      onGrantEnd: (record) => this.history({ ...record }),
      onChange: (clockOnly) => this.scheduleSave(clockOnly),
    });
    this.load();
  }

  /** The settings this place runs with now (the game's file is read each time: an edit counts at once) */
  settings(): QueueSettings & { overridden: string[] } {
    return effectiveSettings(this.globalSettings(), this.folder);
  }

  // ---------------------------------------------------------------------------------------
  // Disk: state, verdicts, history

  private statePath(): string {
    return path.join(this.dir, "state.json");
  }

  private load(): void {
    let saved: any = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.statePath(), "utf8"));
    } catch {
      return;
    }
    for (const job of Array.isArray(saved?.jobs) ? saved.jobs : []) {
      if (!job || typeof job.id !== "string" || typeof job.source !== "string" || typeof job.client?.id !== "string") continue;
      // A job the old hub was running starts over, without counting a try against it
      this.jobs.set(job.id, { ...job, state: "pending" });
    }
    this.lock.restore(saved?.lock);
    if (saved?.play && typeof saved.play.token === "string" && Array.isArray(saved.play.roots)) {
      this.adoptable = { token: saved.play.token, roots: saved.play.roots.map(String) };
    }
  }

  /** Anything to do after a restart: jobs waiting, or a play to adopt and stop */
  hasWork(): boolean {
    return this.pendingSummary().count > 0 || this.adoptable !== null;
  }

  /**
   * A change is written at the end of the tick; a refresh of the holder's clock (every Studio call
   * it makes) only within LAZY_SAVE_MS, so the state file with every job's source is not rewritten
   * per call. A restart loses at most those seconds of the idle clock.
   */
  private scheduleSave(clockOnly = false): void {
    if (this.saveTimer && (clockOnly || this.saveSoon)) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveSoon = !clockOnly;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, clockOnly ? LAZY_SAVE_MS : 0);
    this.saveTimer.unref?.();
  }

  save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const body = {
      placeId: this.placeId,
      savedAt: this.now(),
      jobs: [...this.jobs.values()],
      lock: this.lock.serialize(),
      play: this.playing && this.playToken ? { token: this.playToken, roots: this.playRoots } : (this.adoptable ?? null),
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = this.statePath();
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(body));
      fs.renameSync(temp, file);
      this.saves++;
    } catch (error) {
      this.log(`queue: could not save its state (${(error as Error).message})`);
    }
  }

  private history(entry: Record<string, unknown>): void {
    const at = this.now();
    try {
      const dir = path.join(this.dir, "history");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${day(at)}.jsonl`), JSON.stringify({ at, ...entry }) + "\n");
    } catch {
      // the history never stops a job
    }
    if (at - this.lastPrune > 3600_000) {
      this.lastPrune = at;
      this.prune();
    }
  }

  /** History and verdicts older than `historyDays` go (0 keeps everything) */
  prune(): void {
    const days = this.settings().historyDays;
    if (!days) return;
    const cutoff = this.now() - days * 86_400_000;
    const oldestDay = day(cutoff);
    try {
      for (const name of fs.readdirSync(path.join(this.dir, "history"))) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if (m && m[1] < oldestDay) fs.rmSync(path.join(this.dir, "history", name), { force: true });
      }
    } catch {
      // no history yet
    }
    try {
      const results = path.join(this.dir, "results");
      for (const name of fs.readdirSync(results)) {
        const file = path.join(results, name);
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      }
    } catch {
      // no verdicts yet
    }
  }

  /** The runner's waits that held jobs back, one line when each ends */
  private noteWait(key: string, reason: string, queue: number): void {
    if (this.waiting?.key === key) {
      this.waiting.reason = reason;
      this.waiting.queue = Math.max(this.waiting.queue, queue);
      return;
    }
    this.endWait();
    this.waiting = { key, reason, queue, since: this.now() };
  }

  private endWait(): void {
    if (!this.waiting) return;
    const ms = this.now() - this.waiting.since;
    this.history({ kind: "wait", reason: this.waiting.reason, ms, queued: this.waiting.queue });
    this.log(`queue: waited ${Math.round(ms / 1000)} s, up to ${this.waiting.queue} job(s) queued: ${this.waiting.reason}`);
    this.waiting = null;
  }

  // ---------------------------------------------------------------------------------------
  // Clients

  submit(client: Client, input: JobInput): Job {
    const id = `${this.now()}-${randomBytes(3).toString("hex")}`;
    const job: Job = {
      id,
      client: { id: client.id, ...(client.name ? { name: client.name } : {}), ...(client.pid ? { pid: client.pid } : {}) },
      submittedAt: this.now(),
      state: "pending",
      name: input.name,
      files: input.files,
      fresh: input.fresh === true,
      root: path.resolve(input.root),
      source: input.source,
    };
    this.jobs.set(id, job);
    this.save();
    this.history({ kind: "submit", id, name: job.name, client: job.client, root: job.root });
    this.kick();
    return job;
  }

  /** How many jobs wait or run, without reading the day's history (/api/state polls it) */
  jobCount(): number {
    return this.jobs.size;
  }

  /** A job's state, or its verdict once it has one */
  jobStatus(id: string): { state: "pending" | "running" | "done" | "unknown"; verdict?: Verdict; position?: number } {
    const job = this.jobs.get(id);
    if (job) {
      const pending = [...this.jobs.values()].filter((j) => j.state === "pending");
      return { state: job.state, ...(job.state === "pending" ? { position: pending.indexOf(job) + 1 } : {}) };
    }
    if (!/^[\w-]+$/.test(id)) return { state: "unknown" };
    const kept = this.unsaved.get(id);
    if (kept) return { state: "done", verdict: kept };
    try {
      return { state: "done", verdict: JSON.parse(fs.readFileSync(path.join(this.dir, "results", `${id}.json`), "utf8")) };
    } catch {
      return { state: "unknown" };
    }
  }

  private pendingSummary(): { count: number; oldest: number | null } {
    let count = 0;
    let oldest: number | null = null;
    for (const job of this.jobs.values()) {
      if (job.state !== "pending") continue;
      count++;
      if (oldest === null || job.submittedAt < oldest) oldest = job.submittedAt;
    }
    return { count, oldest };
  }

  /** Every second: the lock's clocks, and the jobs of clients that are gone */
  tick(): void {
    const ended = this.lock.tick();
    if (ended) this.log(`queue: the Studio lock ended (${ended})`);
    for (const job of [...this.jobs.values()]) {
      if (job.state !== "pending" || !job.client.pid || this.alive(job.client.pid)) continue;
      this.jobs.delete(job.id);
      this.save();
      this.history({ kind: "dropped", id: job.id, name: job.name, client: job.client, why: "its client is gone" });
      this.writeVerdict({ id: job.id, name: job.name, client: job.client, pass: false, dropped: "its client's process ended before it ran", ms: 0, queuedMs: this.now() - job.submittedAt, finishedAt: this.now() });
      this.log(`queue: ${job.name} dropped, its client ${job.client.name ?? job.client.id} is gone`);
    }
    if (this.hasWork()) this.kick();
  }

  // ---------------------------------------------------------------------------------------
  // What the app and the CLI show

  status() {
    const now = this.now();
    const settings = this.settings();
    const holder = this.lock.state.holder;
    const ranked = this.lock.ranked();
    const cap = this.lock.state.cap;
    return {
      placeId: this.placeId,
      name: this.name,
      folder: this.folder,
      settings,
      phase: this.phase,
      holder: holder && { ...holder, heldMs: now - holder.acquiredAt, idleMs: now - holder.lastUsed },
      waiters: ranked.map((w) => ({ ...w, waitedMs: now - w.since, effectiveLevel: this.effectiveLevel(w.level, w.since) })),
      cap: cap && { ...cap, active: this.lock.activeCap(cap.clientId) !== null },
      running: this.runningJob && { ...this.runningJob, ms: now - this.runningJob.since },
      jobs: [...this.jobs.values()].map((j) => ({
        id: j.id,
        name: j.name,
        client: j.client,
        root: j.root,
        state: j.state,
        waitedMs: now - j.submittedAt,
        fresh: j.fresh,
        ...(j.infra ? { infra: { tries: j.infra.n, retryInMs: Math.max(0, j.infra.retryAt - now), last: j.infra.last } } : {}),
        ...(j.soloRetry ? { alone: true } : {}),
      })),
      play: this.playing
        ? { roots: this.playRoots, since: this.playStartedAt, jobs: this.jobsInPlay, held: this.holdActive() ? { client: this.hold!.client, leftMs: this.hold!.until - now } : null }
        : null,
      today: this.stats(now),
    };
  }

  private effectiveLevel(level: Level, since: number): Level {
    const steps = Math.floor((this.now() - since) / 60_000 / this.settings().agingMin);
    return ORDER[Math.max(0, ORDER.indexOf(level) - steps)];
  }

  private statsCache: { file: string; size: number; value: ReturnType<PlaceQueue["computeStats"]> } | null = null;

  /** The day's speed (decision 9), read again only when the day's history grew: the app polls it */
  stats(now = this.now()) {
    const file = path.join(this.dir, "history", `${day(now)}.jsonl`);
    let size = -1;
    try {
      size = fs.statSync(file).size;
    } catch {
      // nothing today
    }
    if (this.statsCache && this.statsCache.file === file && this.statsCache.size === size) return this.statsCache.value;
    const value = this.computeStats(file);
    this.statsCache = { file, size, value };
    return value;
  }

  private computeStats(file: string) {
    const lines: any[] = [];
    try {
      for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
        if (!raw.trim()) continue;
        try {
          lines.push(JSON.parse(raw));
        } catch {
          // a line cut by a crash
        }
      }
    } catch {
      // nothing today
    }
    const jobs = lines.filter((l) => l.kind === "job");
    const plays = lines.filter((l) => l.kind === "play");
    const inPlays = jobs.filter((j) => j.playId);
    const failures: Record<string, number> = {};
    for (const j of jobs) if (!j.pass) failures[j.failure ?? "fail"] = (failures[j.failure ?? "fail"] ?? 0) + 1;
    const waits = jobs.map((j) => Number(j.queuedMs) || 0);
    const grants = lines.filter((l) => l.kind === "grant" && !l.runner);
    return {
      jobs: jobs.length,
      passed: jobs.filter((j) => j.pass).length,
      plays: plays.length,
      sharedPlays: plays.filter((p) => p.shared).length,
      jobsPerPlay: plays.length ? Math.round((inPlays.length / plays.length) * 100) / 100 : null,
      queueP50Ms: percentile(waits, 50),
      queueP90Ms: percentile(waits, 90),
      failures,
      grants: grants.length,
      grantsCapped: grants.filter((g) => g.endedBy === "cap").length,
    };
  }

  // ---------------------------------------------------------------------------------------
  // The runner

  /** Starts the runner when it is not running */
  kick(): void {
    if (this.looping || this.stopped) return;
    this.looping = this.loop()
      .catch((error) => this.log(`queue: the runner crashed: ${(error as Error).stack ?? error}`))
      .finally(() => {
        this.looping = null;
      });
  }

  /**
   * The hub stops (a restart or an update): the state is saved as it is, the job running now goes
   * back to the queue in the next hub, and the play stays up for it to adopt. Not waited on: a
   * job may take minutes, and a restart must not.
   */
  stop(): void {
    this.stopped = true;
    this.save();
  }

  /** Resolves when the runner has nothing left to do (tests) */
  async idle(): Promise<void> {
    while (this.looping) await this.looping;
  }

  private setPhase(phase: string): void {
    this.phase = phase;
  }

  private runnerHolds(): boolean {
    return this.lock.state.holder?.client.id === RUNNER.id;
  }

  private holdActive(): boolean {
    return Boolean(this.hold && this.playing && this.now() < this.hold.until && this.playRoots.some((f) => samePath(f, this.hold!.root)));
  }

  private readyJobs(): Job[] {
    const now = this.now();
    return [...this.jobs.values()].filter((j) => j.state === "pending" && !(j.infra && j.infra.retryAt > now));
  }

  private isSynced(folder: string): boolean {
    return samePath(folder, this.folder);
  }

  private inPlay(folder: string): boolean {
    return this.playRoots.some((f) => samePath(f, folder));
  }

  private studio(tool: string, args: Record<string, unknown>, waitMs?: number): Promise<any> {
    // `caller`: a daemon that keeps play errors per caller keeps the queue's apart from the CLI's and the MCP's
    return this.port.studio(tool, { caller: "queue", ...args }, waitMs);
  }

  private async loop(): Promise<void> {
    let idleSince = this.now();
    while (!this.stopped) {
      // The play a previous hub left up is settled before anything else uses Studio
      if (this.adoptable) {
        await this.adopt();
        if (this.adoptable) {
          this.setPhase("asking Studio whether the play left up is the queue's");
          await this.sleep(this.t.lockRetryMs);
          continue;
        }
      }
      const settings = this.settings();
      // A client asked for Studio live: finish nothing new, hand it over
      const yields = this.lock.exclusiveWaiters();
      if (yields.length) {
        const queued = this.readyJobs().length;
        if (queued) this.noteWait(`yield ${yields.map((y) => y.client.id).join(",")}`, `handed Studio to ${yields.map((y) => y.client.name ?? y.client.id).join(", ")} (exclusive)`, queued);
        else this.endWait();
        if (this.playing || this.runnerHolds()) await this.standDown(true);
        this.setPhase("Studio handed to a client (exclusive)");
        await this.sleep(this.t.tickMs);
        idleSince = this.now();
        continue;
      }

      let jobs = this.readyJobs();
      if (!jobs.length) {
        this.endWait();
        const idle = this.now() - idleSince;
        if (this.playing && idle > settings.lingerSec * 1000 && !this.holdActive()) await this.standDown(false);
        if (!this.playing && this.runnerHolds()) this.giveLockBack();
        // Nothing queued, no play, no lock: the runner ends; the next submit starts it again
        if (!this.playing && !this.runnerHolds() && this.pendingSummary().count === 0) break;
        this.setPhase(this.playing ? "idle, play kept up for late jobs" : "waiting out an infra retry");
        await this.sleep(this.t.tickMs);
        continue;
      }

      if (!this.playing) {
        this.setPhase("collecting jobs");
        await this.sleep(this.t.windowMs);
        jobs = this.readyJobs();
        if (!jobs.length) continue;
      }

      const claim = this.lock.claim(RUNNER, "queue");
      if (!claim.ok) {
        const holder = claim.holder;
        this.noteWait(`lock ${holder?.client.id}`, `Studio lock held by ${holder?.client.name ?? holder?.client.id ?? "someone"}`, jobs.length);
        this.setPhase(`waiting for the Studio lock (${holder?.client.name ?? holder?.client.id})`);
        await this.sleep(this.t.lockRetryMs);
        continue;
      }
      if (this.waiting?.key !== "foreign play") this.endWait();

      try {
        const outcome = await this.batch(jobs);
        if (outcome === "foreign play") {
          this.noteWait("foreign play", "a play the queue did not start is running", jobs.length);
          this.liftStaleCap();
          this.giveLockBack();
          this.setPhase("waiting: a play the queue did not start is running");
          await this.sleep(this.t.lockRetryMs);
          continue;
        }
        if (outcome === "held") {
          this.noteWait(`hold ${this.hold?.client}`, `play held for ${this.hold?.client} to resubmit ${this.hold?.name}`, jobs.length);
          this.setPhase(`play held for ${this.hold?.client} (${Math.max(0, Math.round(((this.hold?.until ?? 0) - this.now()) / 1000))} s left)`);
          this.lock.batchDone();
          await this.sleep(Math.min(1000, this.t.lockRetryMs));
          continue;
        }
        this.endWait();
      } catch (error) {
        this.endWait();
        const lost = error instanceof LockLost;
        this.log(`queue: batch failed: ${(error as Error).message}`);
        // Never a verdict on the jobs: they go back to the queue after a wait. A lost lock leaves them queued as they are
        for (const job of jobs) {
          const live = this.jobs.get(job.id);
          if (!live) continue;
          if (lost) live.state = "pending";
          else this.infra(live, `the queue failed: ${(error as Error).message}`);
        }
        if (!lost) {
          try {
            await this.stopPlay();
          } catch (stopError) {
            this.log(`queue: could not stop the play after the failure: ${(stopError as Error).message}`);
          }
        }
      } finally {
        this.runningJob = null;
      }
      this.lock.batchDone();
      idleSince = this.now();
    }
    this.endWait();
    this.setPhase(this.stopped ? "stopped" : "idle");
  }

  /** A previous hub's play still up: the runner's to stop, never someone's play by hand */
  private async adopt(): Promise<void> {
    const left = this.adoptable!;
    this.adoptSince ??= this.now();
    // A client that took Studio since the restart owns whatever runs there now
    if (!this.lock.claim(RUNNER, "queue").ok) {
      this.adoptable = null;
      this.save();
      this.log("queue: a client holds Studio, so the play the previous hub left up is not the queue's to stop");
      return;
    }
    try {
      const out = await this.studio("eval", { code: "return shared.__quackQueueOwner", peer: "server", timeoutMs: 5000 }, 5000);
      this.adoptable = null;
      if (out?.ok === true && out.values?.[0] === left.token) {
        this.playing = true;
        this.playToken = left.token;
        this.playRoots = left.roots;
        this.playStartedAt = this.now();
        this.log(`queue: adopting the play the previous hub left up (${left.roots.join(", ")})`);
        return;
      }
      this.giveLockBack();
    } catch (error) {
      // No play at all is an answer. Anything else (the daemon or Studio still coming back after
      // the restart, a slow answer) is asked again: given up too early, the queue's own play would
      // look like someone's and be waited on forever
      const definite = /no play is running/.test((error as Error).message);
      if (!definite && this.now() - this.adoptSince < this.t.adoptMs) return;
      this.adoptable = null;
      this.giveLockBack();
    }
    this.save();
    this.log("queue: the play the previous hub left is gone or not the queue's: not adopted");
  }

  private giveLockBack(): void {
    if (!this.runnerHolds()) return;
    this.lock.release(RUNNER.id);
  }

  /** Stops the play and gives the lock back; a play that will not stop stays the runner's unless a client is waiting for Studio */
  private async standDown(forClient: boolean): Promise<void> {
    // Studio went to a client meanwhile (a forced release, the idle limit): its play is not ours to stop
    if (this.lock.state.holder && !this.runnerHolds()) {
      this.forgetPlay();
      return;
    }
    try {
      await this.stopPlay();
    } catch (error) {
      this.log(`queue: could not stop the play: ${(error as Error).message}`);
      if (!forClient) return;
      this.forgetPlay();
      this.log("queue: Studio handed to a client with the play still up");
    }
    this.giveLockBack();
  }

  private forgetPlay(): void {
    this.playing = false;
    this.playToken = null;
    this.playRoots = [];
    this.playId = null;
    this.extraOf.clear();
    this.snapshots.clear();
    this.hold = null;
    this.save();
  }

  private async stopPlay(): Promise<void> {
    if (!this.playing) return;
    let status = await this.studio("playtest", { action: "status" }, 10_000);
    if (status?.editConnected === false) throw new Error("Studio is not connected to this place");
    if (status?.playing) {
      try {
        await this.studio("playtest", { action: "stop", timeoutMs: 30_000 }, 30_000);
      } catch (error) {
        if (!/no play is running/.test((error as Error).message)) throw error;
      }
      status = await this.studio("playtest", { action: "status" }, 10_000);
    }
    if (status?.playing !== false) throw new Error(`play did not stop (status: ${JSON.stringify(status).slice(0, 200)})`);
    this.forgetPlay();
    this.log("queue: play stopped");
  }

  /** A capped client's play still up with jobs waiting: the cap is lifted so it can stop the play */
  private liftStaleCap(): void {
    const cap = this.lock.state.cap;
    if (!cap || cap.at <= this.lock.state.lastBatchAt || this.now() - cap.at < this.t.capPlayMs) return;
    this.lock.liftCap();
    this.log(`queue: cap of ${cap.clientId} lifted, its play stayed up ${Math.round((this.now() - cap.at) / 1000)} s after the cap`);
  }

  // ---- jobs

  /** Verdicts the disk refused: kept here so the waiting client still gets its answer */
  private unsaved = new Map<string, Verdict>();

  private writeVerdict(verdict: Verdict): void {
    try {
      const dir = path.join(this.dir, "results");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${verdict.id}.json`);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(verdict, null, 2));
      fs.renameSync(`${file}.tmp`, file);
      this.unsaved.delete(verdict.id);
    } catch (error) {
      this.unsaved.set(verdict.id, verdict);
      if (this.unsaved.size > 200) this.unsaved.delete(this.unsaved.keys().next().value!);
      this.log(`queue: could not write the verdict of ${verdict.id} (${(error as Error).message}): kept in memory until the hub stops`);
    }
  }

  private publish(job: Job, result: Omit<Verdict, "id" | "name" | "client" | "finishedAt">): void {
    const tries = job.infra;
    const verdict: Verdict = {
      id: job.id,
      name: job.name,
      client: job.client,
      ...result,
      ...(job.soloRetry ? { firstRun: job.soloRetry } : {}),
      ...(tries && !result.infra ? { infraRetried: `${tries.n} time(s), last: ${tries.last}` } : {}),
      finishedAt: this.now(),
    };
    this.writeVerdict(verdict);
    this.jobs.delete(job.id);
    this.save();
    const phases = Object.values(verdict.phases ?? {}) as any[];
    const failure = verdict.pass
      ? undefined
      : verdict.infra
        ? "infra"
        : verdict.notYours
          ? "notYours"
          : phases.some((p) => p.ok === false && TIMED_OUT.test(String(p.error ?? "")))
            ? "timeout"
            : phases.some((p) => p.ok === false)
              ? "error"
              : "check";
    this.history({
      kind: "job",
      id: job.id,
      name: job.name,
      client: job.client,
      root: job.root,
      pass: verdict.pass,
      ...(failure ? { failure } : {}),
      ...(verdict.reason ? { reason: verdict.reason.slice(0, 200) } : {}),
      queuedMs: verdict.queuedMs,
      ms: verdict.ms,
      playId: verdict.infra ? null : this.playId,
      how: verdict.play ?? null,
      alone: Boolean(job.soloRetry),
    });
    this.log(`queue: ${job.name} (${job.client.name ?? job.client.id}): ${verdict.pass ? "PASS" : verdict.infra ? "INFRA" : "FAIL"}${verdict.reason ? ` - ${verdict.reason}` : ""}`);
  }

  /** Infra: back to the queue after a wait, answered as infra only after `infraTries` (or at once when waiting cannot fix it) */
  private infra(job: Job, reason: string, { retry = true, result = {} as Partial<Verdict> } = {}): void {
    const settings = this.settings();
    const tries: InfraTries = job.infra ? { ...job.infra } : { n: 0, retryAt: 0, last: "" };
    tries.n++;
    tries.last = String(reason).slice(0, 300);
    if (!retry || tries.n >= settings.infraTries) {
      job.infra = undefined;
      this.publish(job, { ms: 0, queuedMs: this.now() - job.submittedAt, ...result, pass: false, infra: true, reason: `infra${retry ? ` (after ${tries.n} tries)` : ""}: ${reason}` });
      return;
    }
    const waits = settings.infraWaitSec;
    tries.retryAt = this.now() + waits[Math.min(tries.n - 1, waits.length - 1)] * 1000;
    job.infra = tries;
    job.state = "pending";
    this.save();
    this.log(`queue: ${job.name}: infra, try ${tries.n} of ${settings.infraTries}, again in ${Math.round((tries.retryAt - this.now()) / 1000)} s: ${tries.last}`);
  }

  private requeueAlone(job: Job, firstRun: NonNullable<Job["soloRetry"]>): void {
    job.soloRetry = firstRun;
    job.state = "pending";
    this.save();
    this.log(`queue: ${job.name}: failed in a play shared with ${firstRun.with.join(", ")}, queued again to run alone`);
  }

  private changedSince(job: Job, base: Map<string, number> | undefined, now: Map<string, number>): boolean {
    if (!base) return true;
    const files = job.files ?? [...new Set([...now.keys(), ...base.keys()])];
    return files.some((f) => now.get(f) !== base.get(f));
  }

  private async runPhase(job: Job, phase: string, clientPayload: string | null): Promise<any> {
    let out: any;
    try {
      out = await this.studio(
        "eval",
        { code: phaseCode(job.source, phase, job.id, clientPayload), peer: phase === "client" ? "client" : "server", timeoutMs: this.t.phaseTimeoutMs },
        this.t.phaseTimeoutMs,
      );
    } catch (error) {
      const message = (error as Error).message;
      // An eval past its time may still run there: the job's own failure, not the play's
      if (TIMED_OUT.test(message)) return { ok: false, error: message };
      throw error;
    }
    if (out?.ok !== true) return { ok: false, error: String(out?.error ?? "the eval failed without a reason") };
    try {
      return JSON.parse(String(out.values?.[0]));
    } catch {
      return { ok: false, error: `unreadable phase result: ${String(out.values?.[0]).slice(0, 300)}` };
    }
  }

  private async readConsole(): Promise<string[]> {
    let slice: any;
    try {
      slice = await this.studio("logs", this.cursor !== null ? { cursor: this.cursor } : { tail: 1 }, 10_000);
    } catch (error) {
      return [`ERR studio queue: could not read the console (${(error as Error).message})`];
    }
    this.cursor = slice?.cursor ?? this.cursor;
    const counts = new Map<string, number>();
    for (const e of slice?.entries ?? []) {
      if (e.source === "quack") continue;
      const line = `${LEVEL_CODE[e.type] ?? e.type} ${e.message}`;
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    return [...counts].map(([line, n]) => (n > 1 ? `${line}  (x${n})` : line));
  }

  private async moveCursor(): Promise<void> {
    try {
      this.cursor = (await this.studio("logs", { tail: 1 }, 10_000))?.cursor ?? this.cursor;
    } catch {
      // the jobs read from the old cursor: more lines, nothing lost
    }
  }

  private async runJob(job: Job, how: string, extra: Extra, sourcemap: Sourcemap): Promise<void> {
    const started = this.now();
    // The lock is confirmed (and its idle clock refreshed) before anything runs
    const lock = this.lock.claim(RUNNER, "queue");
    if (!lock.ok) {
      this.forgetPlay();
      throw new LockLost(`lost the Studio lock to ${lock.holder?.client.name ?? lock.holder?.client.id}`);
    }
    if (this.hold && this.hold.client === job.client.id && samePath(this.hold.root, job.root)) {
      this.log(`queue: hold for ${this.hold.client} used: ${job.name} runs in the held play`);
      this.hold = null;
    }
    job.state = "running";
    this.runningJob = { id: job.id, name: job.name, client: job.client, since: started };
    this.save();
    this.jobsInPlay++;
    const phases: Record<string, any> = {};
    let clientPayload: string | null = null;
    try {
      for (const phase of ["setup", "client", "check"]) {
        if (Object.values(phases).some((p) => p.ok === false)) break;
        phases[phase] = await this.runPhase(job, phase, clientPayload);
        if (phase === "client") clientPayload = phases.client.payload ?? null;
      }
    } catch (error) {
      phases.executor = { ok: false, error: `a phase call failed: ${(error as Error).message}` };
    } finally {
      try {
        phases.cleanup = await this.runPhase(job, "cleanup", null);
      } catch (error) {
        phases.cleanup = { ok: false, error: `the cleanup call failed: ${(error as Error).message}` };
      }
    }
    for (const k of Object.keys(phases)) if (phases[k]?.skipped) delete phases[k];
    const console_ = await this.readConsole();

    const failed = Object.entries(phases).filter(([, p]) => p?.ok === false);
    const checksFailed = Object.values(phases).flatMap((p: any) => (p?.checks ?? []).filter((c: any) => !c.ok));
    let notYours: { instance: string; file: string | null } | null = null;
    for (const [, p] of failed) notYours ??= foreignIn(p.error, job.files, sourcemap);
    if (failed.length) for (const line of console_.filter((l) => l.startsWith("ERR"))) notYours ??= foreignIn(line, job.files, sourcemap);
    const pass = failed.length === 0 && checksFailed.length === 0;
    const queuedMs = started - job.submittedAt;

    const infraPhase = failed.find(([, p]) => INFRA_PHASE.test(String(p.error ?? "")));
    if (infraPhase) {
      for (const f of this.playRoots) if (samePath(f, job.root)) this.snapshots.delete(f);
      this.infra(job, `${infraPhase[0]}: ${String(infraPhase[1].error).split("\n")[0].slice(0, 200)}`, {
        result: { play: how, phases, console: console_, ...extra, ms: this.now() - started, queuedMs },
      });
      return;
    }
    const others = this.playRoots.filter((f) => !samePath(f, job.root));
    const retryAll = this.settings().sharedRetry !== "foreign";
    if (!pass && others.length && !job.soloRetry && (retryAll || notYours)) {
      this.requeueAlone(job, {
        with: others,
        pass: false,
        play: how,
        reason: [...failed.map(([phase, p]) => `${phase}: ${String(p.error ?? "error").split("\n")[0].slice(0, 200)}`), ...checksFailed.map((c: any) => `FAILED ${c.label}`)]
          .slice(0, 6)
          .join("; "),
        ms: this.now() - started,
      });
      return;
    }
    const ownError = failed.length > 0 && !notYours && !failed.some(([, p]) => TIMED_OUT.test(String(p.error ?? "")));
    const holdSec = this.settings().holdSec;
    const holding = ownError && this.playing && holdSec > 0;
    if (holding) {
      this.hold = { client: job.client.id, root: job.root, until: this.now() + holdSec * 1000, jobsAt: this.jobsInPlay, name: job.name };
      this.log(`queue: play held ${holdSec} s for ${job.client.name ?? job.client.id}: ${job.name} failed in its own code`);
    }
    this.publish(job, {
      ...(holding ? { held: holdSec } : {}),
      ...(!pass && others.length && !job.soloRetry ? { sharedWith: others } : {}),
      pass,
      play: how,
      phases,
      console: console_,
      notYours: notYours && `error in ${notYours.instance}${notYours.file ? ` (${notYours.file})` : " (not in sourcemap.json)"}, outside this job's files: probably another client's`,
      ...extra,
      ms: this.now() - started,
      queuedMs,
    });
  }

  /** A play just started is the runner's: its folders, and the token a later hub adopts it by */
  private async ownPlay(folders: string[], kind: string, startMs: number): Promise<void> {
    this.playing = true;
    this.playRoots = [...folders];
    this.playToken = `${process.pid}-${this.now()}-${randomBytes(3).toString("hex")}`;
    this.playId = randomBytes(4).toString("hex");
    this.playStartedAt = this.now();
    this.jobsInPlay = 0;
    this.hold = null;
    this.history({ kind: "play", playId: this.playId, roots: folders, shared: folders.length > 1, mode: kind, startMs });
    // Right after the start the play's server may not take tools for a moment
    let marked = false;
    for (let i = 0; i < 20 && !marked; i++) {
      try {
        const out = await this.studio("eval", { code: `shared.__quackQueueOwner = ${JSON.stringify(this.playToken)} return true`, peer: "server", timeoutMs: 5000 }, 5000);
        marked = out?.ok === true;
        if (!marked) break;
      } catch {
        await this.sleep(500);
      }
    }
    if (!marked) this.log("queue: could not mark the play as the queue's: a later hub will not adopt it");
    this.save();
  }

  /**
   * A play just started is not ready for jobs yet: the player joins and the game loads its profile
   * a moment later. Polled on the server until the game's readyCheck (a Luau chunk returning true,
   * in its .claude/studio-test.json) or a player on the server says yes, `readySec` at most.
   * Not ready in time: the jobs run anyway, the verdict says so.
   */
  private async waitReady(): Promise<string | null> {
    const { readyCheck } = readGameConfig(this.folder);
    const code = readyCheck ?? `return #game:GetService("Players"):GetPlayers() > 0`;
    const limit = this.settings().readySec * 1000;
    const start = this.now();
    let last = "no answer";
    this.setPhase("waiting for the play to be ready");
    while (this.now() - start < limit) {
      const left = Math.max(1000, limit - (this.now() - start));
      try {
        const out = await this.studio("eval", { code, peer: "server", timeoutMs: left }, left);
        if (out?.ok === true && String(out.values?.[0]) === "true") {
          this.log(`queue: play ready in ${this.now() - start} ms${readyCheck ? " (readyCheck)" : ""}`);
          await this.moveCursor();
          return null;
        }
        last = out?.ok === true ? `returned ${out.values?.[0]}` : String(out?.error ?? "error").slice(0, 200);
      } catch (error) {
        last = (error as Error).message.slice(0, 200);
      }
      await this.sleep(500);
    }
    this.log(`queue: play not ready after ${limit / 1000} s: ${last}`);
    await this.moveCursor();
    return `the play was not ready after ${limit / 1000} s (${readyCheck ? "readyCheck in .claude/studio-test.json" : "no player on the server"}: ${last}); the jobs ran anyway`;
  }

  /** Studio's hash of each file's .Source, in one Luau call in edit mode; unknown instances come back -1 */
  private async studioHashes(files: string[], pathOf: (f: string) => string[] | undefined): Promise<number[]> {
    const paths = files.map((f) => pathOf(f) ?? []);
    const code = `local HttpService = game:GetService("HttpService")
local paths = HttpService:JSONDecode(${luaString(JSON.stringify(paths))})
local function fnv(s)
	s = string.gsub(s, "\\r", "")
	local h = 2166136261
	for i = 1, #s do
		h = bit32.bxor(h, string.byte(s, i))
		h = (bit32.lshift(h, 24) + h * 403) % 4294967296
	end
	return h
end
local out = {}
for i, names in paths do
	local node = #names > 0 and game or nil
	for _, name in names do node = node and node:FindFirstChild(name) end
	local ok, source = pcall(function() return node.Source end)
	out[i] = (node and ok) and fnv(source) or -1
end
return HttpService:JSONEncode(out)`;
    const out = await this.studio("exec", { code, timeoutMs: 30_000 }, 30_000);
    if (out?.ok !== true) throw new Error(`sync check failed: ${out?.error ?? JSON.stringify(out)}`);
    return JSON.parse(String(out.values?.[0]));
  }

  /** Until Studio shows the disk's version of every file: the ones that never did, and the ones the sourcemap does not know */
  private async waitForSync(files: string[], sourcemap: Sourcemap): Promise<{ unsynced: string[]; unknown: string[] }> {
    const pathOf = (f: string) => sourcemap.byFile.get(f) ?? this.lastSourcemap?.byFile.get(f);
    const unknown = files.filter((f) => !pathOf(f));
    let left = files.filter((f) => pathOf(f));
    const deadline = this.now() + this.t.syncWaitMs;
    while (left.length) {
      const disk = left.map((f) => {
        try {
          return fnv1a(fs.readFileSync(path.join(this.folder, f), "utf8"));
        } catch {
          return -1;
        }
      });
      const inStudio = await this.studioHashes(left, pathOf);
      left = left.filter((_, i) => disk[i] !== inStudio[i]);
      if (!left.length || this.now() >= deadline) break;
      await this.sleep(1000);
    }
    return { unsynced: left, unknown };
  }

  /** Starts a play through the daemon's worktree play, retried while Studio is still leaving the last one */
  private async startBranchPlay(folders: string[]): Promise<{ state: any | null; error: string | null }> {
    const deadline = this.now() + this.t.startRetryMs;
    for (;;) {
      let state: any = null;
      let error: string | null = null;
      try {
        state = await this.port.play(folders);
        if (!state?.result?.ok) error = String(state?.result?.error ?? "the swap did not finish");
      } catch (e) {
        error = (e as Error).message;
      }
      const leaving = error !== null && /already running|already being started|transition/i.test(error);
      if (!leaving || this.now() > deadline) return { state, error };
      await this.sleep(1000);
    }
  }

  private async playingNow(): Promise<boolean> {
    try {
      return (await this.studio("playtest", { action: "status" }, 10_000))?.playing === true;
    } catch {
      return false;
    }
  }

  /** One play for a worktree's jobs: its branch, checked inside the play */
  private async branchCycle(jobs: Job[], sourcemap: Sourcemap, folder: string): Promise<void> {
    await this.stopPlay();
    const preStart = hashAll(folder);
    this.setPhase(`play of ${folder}`);
    const t = this.now();
    const { state, error } = await this.startBranchPlay([folder]);
    this.log(`queue: play of ${folder}: ${error ?? "started"} (${this.now() - t} ms)`);
    if (error !== null) {
      const why = (await this.playingNow()) ? "a play the queue did not start is running" : "the play did not start";
      for (const job of jobs) this.infra(job, `${why}: ${error}`);
      return;
    }
    await this.ownPlay([folder], "branch", this.now() - t);
    const verify = state.verify;
    if (verify && verify.ok === false) {
      // Up without the whole branch: no job runs in it and none joins it later; waiting does not fix it
      const lines = (verify.failed ?? []).slice(0, 5).join("; ");
      for (const job of jobs) this.infra(job, `the branch's scripts did not all reach the play: ${lines}`, { retry: false });
      return;
    }
    this.snapshots.set(folder, preStart);
    await this.moveCursor();
    const quackPlay = [
      `${state.patches} changed, ${state.creates} new, ${state.disables} turned off.`,
      ...(verify ? [`Checked inside the play: ${verify.passed} of ${state.checks ?? verify.passed} have the branch.`] : []),
      ...(state.conflicts ?? []).map((c: string) => `conflict: ${c}`),
    ];
    const warnings = verify ? [] : ["the play's check of the branch's scripts did not come back: they may not all be there"];
    const notReady = await this.waitReady();
    if (notReady) warnings.push(notReady);
    const extra: Extra = { quackPlay, ...(warnings.length ? { syncWarnings: warnings } : {}) };
    this.extraOf.set(folder, extra);
    for (const job of jobs) {
      this.setPhase(`running ${job.name} (branch ${folder})`);
      await this.runJob(job, `quack play, branch of ${folder}`, extra, sourcemap);
    }
  }

  /** One play for several worktrees whose branches change no script in common; each one the play's check says is missing plays alone */
  private async sharedCycle(group: { folder: string; jobs: Job[] }[], sourcemap: Sourcemap): Promise<void> {
    const folders = group.map((g) => g.folder);
    const alone = async (list: { folder: string; jobs: Job[] }[]) => {
      for (const g of list) await this.branchCycle(g.jobs, sourcemap, g.folder);
    };
    await this.stopPlay();
    const preStart = new Map(folders.map((f) => [f, hashAll(f)]));
    this.setPhase(`play of ${folders.length} worktrees`);
    const t = this.now();
    const { state, error } = await this.startBranchPlay(folders);
    this.log(`queue: shared play of ${folders.join(", ")}: ${error ?? "started"} (${this.now() - t} ms)`);
    if (error !== null) {
      if (/plays one worktree at a time/.test(error)) this.multiPlay = false;
      if (!state && (await this.playingNow())) {
        for (const g of group) for (const job of g.jobs) this.infra(job, `a play the queue did not start is running: ${error}`);
        return;
      }
      return alone(group);
    }
    // A daemon from before shared plays played the first worktree only
    const parts: any[] = Array.isArray(state.worktrees) ? state.worktrees : [{ ...state, worktree: state.worktree }];
    if (!Array.isArray(state.worktrees)) this.multiPlay = false;
    const partOf = (folder: string) => parts.find((p) => samePath(p.worktree, folder));
    const unchecked = !state.verify;
    const ok = group.filter((g) => partOf(g.folder) && (unchecked || partOf(g.folder).verify?.ok === true));
    const missing = group.filter((g) => !ok.includes(g));
    await this.ownPlay(
      ok.map((g) => g.folder),
      "shared",
      this.now() - t,
    );
    await this.moveCursor();
    const notReady = ok.length ? await this.waitReady() : null;
    for (const g of ok) {
      const part = partOf(g.folder);
      this.snapshots.set(g.folder, preStart.get(g.folder)!);
      const others = ok.filter((o) => o !== g).map((o) => o.folder);
      this.extraOf.set(g.folder, {
        quackPlay: [
          `${part.patches} changed, ${part.creates} new, ${part.disables} turned off.`,
          ...(part.verify ? [`Checked inside the play: ${part.verify.passed} of ${part.checks} have the branch.`] : []),
          ...(part.conflicts ?? []).map((c: string) => `conflict: ${c}`),
          ...(others.length ? [`shared play with ${others.join(", ")}`] : []),
        ],
        ...(unchecked || notReady
          ? { syncWarnings: [...(unchecked ? ["the play's check of the branch's scripts did not come back: they may not all be there"] : []), ...(notReady ? [notReady] : [])] }
          : {}),
      });
    }
    for (const g of ok) {
      for (const job of g.jobs) {
        this.setPhase(`running ${job.name} (branch ${g.folder}, shared play)`);
        await this.runJob(job, `shared quack play of ${ok.length} worktrees, branch of ${g.folder}`, this.extraOf.get(g.folder)!, sourcemap);
      }
    }
    if (missing.length) {
      for (const g of missing) this.log(`queue: ${g.folder} is not in the shared play (${partOf(g.folder)?.verify?.failed?.slice(0, 3).join("; ") ?? "the daemon did not play it"}): it plays alone`);
      await alone(missing);
    }
  }

  /** One play for jobs of one folder: a worktree's goes to branchCycle; the synced folder's is stop, sync check, start, run */
  private async cycle(jobs: Job[], sourcemap: Sourcemap): Promise<void> {
    const folder = jobs[0].root;
    if (!this.isSynced(folder)) return this.branchCycle(jobs, sourcemap, folder);
    await this.stopPlay();
    const now = hashAll(this.folder);
    const declared = jobs.flatMap((j) => j.files ?? []);
    const last = this.lastCycleSnapshot;
    const changed = [
      ...(last ? [...new Set([...now.keys(), ...last.keys()])].filter((f) => now.get(f) !== last.get(f)) : recentFiles(this.folder, this.now() - this.t.recentMs)),
      ...this.carryOver,
    ];
    const declaredSet = [...new Set(declared)];
    const extras = [...new Set(changed)].filter((f) => !declaredSet.includes(f));
    const toCheck = [...declaredSet, ...extras.slice(0, Math.max(0, this.t.maxChecked - declaredSet.length))];
    const skipped = extras.length - (toCheck.length - declaredSet.length);
    this.setPhase(`sync check of ${toCheck.length} file(s)`);
    const { unsynced, unknown } = toCheck.length ? await this.waitForSync(toCheck, sourcemap) : { unsynced: [] as string[], unknown: [] as string[] };
    this.log(`queue: sync check: ${toCheck.length} file(s), ${unsynced.length} not synced${unsynced.length ? ` (${unsynced.join(", ")})` : ""}, ${unknown.length} not in sourcemap, ${skipped} over the cap`);
    const runnable: Job[] = [];
    for (const job of jobs) {
      const stale = job.files ? job.files.filter((f) => unsynced.includes(f)) : unsynced;
      if (stale.length) this.infra(job, `Studio does not have the disk's version of: ${stale.join(", ")} (is the place's Studio connected to this folder?)`, { retry: false });
      else runnable.push(job);
    }
    if (!runnable.length) return;
    const warnings = [
      ...unsynced.filter((f) => !declared.includes(f)).map((f) => `not synced (someone else's change?): ${f}`),
      ...unknown.map((f) => `not in sourcemap.json, sync unverified: ${f}`),
      ...(skipped > 0 ? [`${skipped} other recently changed file(s) were not sync-checked (cap ${this.t.maxChecked})`] : []),
    ];
    // The snapshot is the disk before the check: a file edited after it differs, so no later job joins a play that may lack the edit
    const preStart = new Map(now);
    const unverified = [...unsynced, ...unknown, ...extras.slice(toCheck.length - declaredSet.length)];
    for (const f of unverified) preStart.delete(f);
    this.carryOver = new Set(unverified);
    this.lastSourcemap = sourcemap;
    this.setPhase("starting the play");
    const t = this.now();
    const deadline = this.now() + this.t.startRetryMs;
    for (;;) {
      try {
        await this.studio("playtest", { action: "start", mode: "play", timeoutMs: 60_000 }, 60_000);
        break;
      } catch (error) {
        const why = (error as Error).message;
        if (!/transition|already running/i.test(why) || this.now() > deadline) throw new Error(`play did not start: ${why}`);
        await this.sleep(1000);
      }
    }
    await this.ownPlay([this.folder], "synced", this.now() - t);
    this.snapshots.set(this.folder, preStart);
    this.lastCycleSnapshot = preStart;
    await this.moveCursor();
    const notReady = await this.waitReady();
    if (notReady) warnings.push(notReady);
    this.extraOf.set(this.folder, warnings.length ? { syncWarnings: warnings } : {});
    for (const job of runnable) {
      this.setPhase(`running ${job.name}`);
      await this.runJob(job, "fresh play", this.extraOf.get(this.folder)!, sourcemap);
    }
  }

  private async batch(jobs: Job[]): Promise<"foreign play" | "held" | void> {
    const sourcemap = loadSourcemap(this.folder);
    if (!sourcemap.ok) {
      for (const job of jobs) this.infra(job, `no readable sourcemap.json in ${this.folder}: is the place synced?`, { retry: false });
      return;
    }
    // A play nobody here started (someone's hands) is never stopped: the lock goes back and the runner comes round again
    if (!this.playing) {
      const status = await this.studio("playtest", { action: "status" }, 10_000);
      if (status?.editConnected === false) throw new Error("Studio is not connected to this place: open it in Studio");
      if (status?.playing) return "foreign play";
    }
    this.endWait();

    // Jobs that can join the running play go first, with no restart
    const playHashes = new Map(this.playing ? this.playRoots.map((f) => [f, hashAll(f)]) : []);
    const rootIn = (job: Job) => this.playRoots.find((f) => samePath(f, job.root));
    const reusesHold = (j: Job) =>
      j.fresh && this.holdActive() && j.client.id === this.hold!.client && samePath(j.root, this.hold!.root) && this.jobsInPlay === this.hold!.jobsAt;
    const joining = this.playing
      ? jobs.filter(
          (j) => (!j.fresh || reusesHold(j)) && rootIn(j) && !(j.soloRetry && this.playRoots.length > 1) && !this.changedSince(j, this.snapshots.get(rootIn(j)!), playHashes.get(rootIn(j)!)!),
        )
      : [];
    const rest = jobs.filter((j) => !joining.includes(j));
    for (const job of joining) {
      const folder = rootIn(job)!;
      this.setPhase(`running ${job.name} (joined the running play)`);
      const how = this.isSynced(folder)
        ? "joined the running play"
        : `joined the running ${this.playRoots.length > 1 ? `shared play of ${this.playRoots.length} worktrees` : "play"}, branch of ${folder}`;
      await this.runJob(job, `${how}${job.fresh ? " (fresh, the play held for its client after its failed run)" : ""}`, this.extraOf.get(folder) ?? {}, sourcemap);
    }

    // A play held for a client's fixed job: the plays that would end it wait, unless the held client's own job needs one
    if (rest.length && this.holdActive()) {
      if (!rest.some((j) => j.client.id === this.hold!.client && samePath(j.root, this.hold!.root))) return "held";
      this.log(`queue: hold for ${this.hold!.client} ended: its job needs a new play`);
      this.hold = null;
    }

    // The rest, folder by folder: the running play's folders first, then in arrival order
    const folders: string[] = [];
    for (const job of rest) if (!folders.some((f) => samePath(f, job.root))) folders.push(job.root);
    folders.sort((a, b) => Number(this.inPlay(b)) - Number(this.inPlay(a)));
    const work = folders.map((folder) => {
      const mine = rest.filter((j) => samePath(j.root, folder));
      const again = mine.filter((j) => j.soloRetry);
      const plain = mine.filter((j) => !j.fresh && !j.soloRetry);
      const fresh = mine.filter((j) => j.fresh && !j.soloRetry);
      return { folder, first: fresh.length ? [fresh[0], ...plain] : plain, fresh: fresh.length > 0, later: fresh.slice(1), again };
    });
    for (const w of work.filter((w) => this.isSynced(w.folder) && w.first.length)) await this.cycle(w.first, sourcemap);
    const branches = work.filter((w) => !this.isSynced(w.folder) && w.first.length);
    const groups =
      branches.length > 1 && this.multiPlay
        ? planGroups(await Promise.all(branches.map(async (w) => ({ folder: w.folder, files: await changedScripts(w.folder, this.folder), fresh: w.fresh, w }))))
        : branches.map((w) => [{ folder: w.folder, files: null, fresh: w.fresh, w }]);
    for (const group of groups) {
      if (group.length === 1) await this.branchCycle(group[0].w.first, sourcemap, group[0].folder);
      else await this.sharedCycle(group.map((g) => ({ folder: g.folder, jobs: g.w.first })), sourcemap);
    }
    for (const w of work) {
      for (const job of w.later) await this.cycle([job], sourcemap);
      const plainAgain = w.again.filter((j) => !j.fresh);
      if (plainAgain.length) await this.cycle(plainAgain, sourcemap);
      for (const job of w.again.filter((j) => j.fresh)) await this.cycle([job], sourcemap);
    }
  }
}

/** A client as a request sends it */
export function readClient(value: unknown): Client {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || typeof v.id !== "string" || !/^[\w.:-]{1,80}$/.test(v.id)) throw new Error("client.id is required (letters, digits, - _ . :)");
  if (v.id === RUNNER.id) throw new Error(`client.id ${RUNNER.id} is the queue's own`);
  const pid = Number(v.pid);
  return {
    id: v.id,
    ...(typeof v.name === "string" && v.name.trim() ? { name: v.name.slice(0, 80) } : {}),
    ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
  };
}

export { isLevel };
