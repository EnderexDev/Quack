import fs from "node:fs";
import path from "node:path";
import { isLevel, RUNNER, type Client } from "./lock.js";
import { PlaceQueue, queueDir, readClient, type StudioPort, type Timings } from "./queue.js";
import { loadSettings, saveSettings, SettingsError, settingsFileFor, type QueueSettings } from "./settings.js";
import { parseJob, samePath, untrackable } from "./disk.js";
import { PublishError, type PublishGit } from "./publish.js";

/**
 * The hub's side of the Studio queue: one PlaceQueue per registered place, the clock that ticks
 * their locks, and the API (/api/queue/...) the app, the CLI and outside clients use.
 *
 * GET  /api/queue?placeId=             status: lock, waiting list, jobs, the play, the day's speed
 * GET  /api/queue/job?placeId=&id=     a job's state, or its verdict
 * GET  /api/queue/settings             the hub's timings
 * POST /api/queue/settings {..}        change them (the app's Settings)
 * POST /api/queue/submit  { placeId, client, job: { name?, files?, fresh?, root, source } }
 * POST /api/queue/lock    { placeId, op, client, ... } op: claim | touch | release | join | leave
 * POST /api/queue/release-all { client: { id }, placeId? }   the client is done: every lock and place in line it has
 * POST /api/queue/force-release { placeId }   the app's one button: frees the lock whoever holds it
 * POST /api/queue/publish { placeId, op, ... }  publishing the place (publish.ts):
 *      join { client, commit?, task?, level?, rush? }  a ticket, or the publish that already shipped the commit
 *      claim { ticket }   the ticket's turn ("yours": publish now), "waiting", or the publish that covered it
 *      touch { ticket }   the publish command still runs: the hold does not idle out
 *      done { ticket, ok, version?, commit?, reason? }   what the command did; a publish answers the tickets it covers
 *      leave { ticket }   the client gave up
 */

export class QueueError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface QueuesOptions {
  registryFile: string;
  /** Registered places: placeId -> folder and name */
  places: () => Record<string, { folder: string; name?: string }>;
  /** How the runner reaches a place's daemon */
  port: (placeId: string) => StudioPort;
  log: (line: string) => void;
  /** Tests */
  settingsFile?: string;
  timings?: Partial<Timings>;
  now?: () => number;
  alive?: (pid: number) => boolean;
  tickMs?: number;
  git?: PublishGit;
}

const MAX_SOURCE = 512 * 1024;

export class HubQueues {
  private queues = new Map<string, PlaceQueue>();
  private timer: NodeJS.Timeout | null = null;
  private readonly settingsFile: string;
  private cached: { settings: QueueSettings; mtime: number; at: number } | null = null;

  constructor(private readonly options: QueuesOptions) {
    this.settingsFile = options.settingsFile ?? settingsFileFor(options.registryFile);
  }

  /** The hub's settings, read again when the file changed (checked at most once a second) */
  settings(): QueueSettings {
    const now = Date.now();
    if (this.cached && now - this.cached.at < 1000) return this.cached.settings;
    let mtime = 0;
    try {
      mtime = fs.statSync(this.settingsFile).mtimeMs;
    } catch {
      // no file: the defaults
    }
    if (!this.cached || this.cached.mtime !== mtime) this.cached = { settings: loadSettings(this.settingsFile), mtime, at: now };
    else this.cached.at = now;
    return this.cached.settings;
  }

  /** Every registered place with a queue saved on disk comes back: its jobs run, its play left up is adopted */
  start(): void {
    for (const [placeId, entry] of Object.entries(this.options.places())) {
      if (!fs.existsSync(path.join(queueDir(entry.folder, placeId), "state.json"))) continue;
      const queue = this.queueOf(placeId);
      if (queue.hasWork()) {
        this.options.log(`${entry.name ?? placeId}: the Studio queue resumes`);
        queue.kick();
      }
    }
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const queue of this.queues.values()) queue.stop();
  }

  tick(): void {
    const places = this.options.places();
    for (const [placeId, queue] of this.queues) {
      // Unregistered, or moved to another folder: that queue is no longer the place's
      if (!places[placeId] || !samePath(places[placeId].folder, queue.folder)) {
        queue.stop();
        this.queues.delete(placeId);
        continue;
      }
      try {
        queue.tick();
      } catch (error) {
        this.options.log(`queue of ${placeId}: tick failed: ${(error as Error).message}`);
      }
    }
  }

  /** A place's queue, made on first use */
  queueOf(placeId: string | null | undefined): PlaceQueue {
    const entry = placeId ? this.options.places()[placeId] : undefined;
    if (!placeId || !entry) throw new QueueError(404, `place ${placeId} is not registered`);
    let queue = this.queues.get(placeId);
    if (queue && !samePath(queue.folder, entry.folder)) {
      queue.stop();
      queue = undefined;
    }
    if (!queue) {
      queue = new PlaceQueue({
        placeId,
        folder: entry.folder,
        name: entry.name,
        port: this.options.port(placeId),
        settings: () => this.settings(),
        log: (line) => this.options.log(`${entry.name ?? placeId}: ${line}`),
        ...(this.options.timings ? { timings: this.options.timings } : {}),
        ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.alive ? { alive: this.options.alive } : {}),
        ...(this.options.git ? { git: this.options.git } : {}),
      });
      this.queues.set(placeId, queue);
    }
    queue.name = entry.name;
    return queue;
  }

  /** What /api/state carries: per place, who holds Studio and how many jobs wait */
  summary(): Record<string, { holder: string | null; runner: boolean; jobs: number; waiters: number }> {
    const out: Record<string, { holder: string | null; runner: boolean; jobs: number; waiters: number }> = {};
    for (const [placeId, queue] of this.queues) {
      const holder = queue.lock.state.holder;
      out[placeId] = {
        holder: holder ? (holder.client.name ?? holder.client.id) : null,
        runner: holder?.client.id === RUNNER.id,
        jobs: queue.jobCount(),
        waiters: queue.lock.ranked().length,
      };
    }
    return out;
  }

  handleGet(pathname: string, q: URLSearchParams): unknown {
    switch (pathname) {
      case "/api/queue":
        return this.queueOf(q.get("placeId")).status();
      case "/api/queue/job": {
        const id = q.get("id") ?? "";
        const answer = this.queueOf(q.get("placeId")).jobStatus(id);
        if (answer.state === "unknown") throw new QueueError(404, `no job ${id} in this place's queue`);
        return answer;
      }
      case "/api/queue/settings":
        return { settings: this.settings(), file: this.settingsFile };
    }
    throw new QueueError(404, "not found");
  }

  /** An answer, or a promise of one (a publish asks git); either way a refusal is a QueueError */
  handlePost(pathname: string, body: Record<string, any>): unknown {
    const asQueueError = (error: unknown): never => {
      if (error instanceof QueueError) throw error;
      if (error instanceof PublishError) throw new QueueError(error.status, error.message);
      throw new QueueError(400, (error as Error).message);
    };
    try {
      const answer = this.post(pathname, body);
      return answer instanceof Promise ? answer.catch(asQueueError) : answer;
    } catch (error) {
      return asQueueError(error);
    }
  }

  private post(pathname: string, body: Record<string, any>): unknown {
    switch (pathname) {
      case "/api/queue/settings": {
        try {
          const settings = saveSettings(this.settingsFile, body.settings && typeof body.settings === "object" ? body.settings : body);
          this.cached = null;
          this.options.log(`Studio queue settings changed: ${JSON.stringify(body.settings ?? body)}`);
          return { settings };
        } catch (error) {
          if (error instanceof SettingsError) throw new QueueError(400, error.message);
          throw error;
        }
      }
      case "/api/queue/submit": {
        const queue = this.queueOf(body.placeId);
        const client = readClient(body.client);
        const job = body.job;
        if (!job || typeof job !== "object") throw new QueueError(400, "job is required");
        if (typeof job.source !== "string" || job.source.trim() === "") throw new QueueError(400, "job.source is required (the Luau)");
        if (job.source.length > MAX_SOURCE) throw new QueueError(413, "job.source is too large");
        if (typeof job.root !== "string" || !path.isAbsolute(job.root)) throw new QueueError(400, "job.root must be an absolute folder (the place's folder or a worktree of it)");
        if (!fs.existsSync(job.root)) throw new QueueError(400, `job.root ${job.root} does not exist`);
        const meta = parseJob(job.source, typeof job.name === "string" && job.name ? job.name : "job");
        const files = Array.isArray(job.files) ? job.files.map(String) : meta.files;
        if (files) {
          const bad = untrackable(files);
          if (bad.length) throw new QueueError(400, `these files cannot be tracked (scripts under sync/ ending .luau, written plainly): ${bad.join(", ")}`);
        }
        const submitted = queue.submit(client, {
          name: typeof job.name === "string" && job.name ? job.name.slice(0, 200) : meta.name.slice(0, 200),
          files,
          fresh: job.fresh === true || meta.fresh,
          root: job.root,
          source: job.source,
        });
        return { id: submitted.id, placeId: queue.placeId };
      }
      case "/api/queue/lock":
        return this.lockOp(body);
      case "/api/queue/publish":
        return this.publishOp(body);
      case "/api/queue/release-all": {
        const id = typeof body.client?.id === "string" ? body.client.id : null;
        if (!id) throw new QueueError(400, "client.id is required");
        const places = typeof body.placeId === "string" ? [body.placeId] : Object.keys(this.options.places());
        let released = 0;
        for (const placeId of places) {
          const queue = this.queues.get(placeId);
          if (queue?.lock.releaseAll(id)) released++;
        }
        return { released };
      }
      case "/api/queue/force-release": {
        const queue = this.queueOf(body.placeId);
        const was = queue.lock.release(null, true);
        if (was) this.options.log(`${queue.name ?? queue.placeId}: Studio lock freed by hand (was ${was.client.name ?? was.client.id})`);
        return { released: Boolean(was), was };
      }
    }
    throw new QueueError(404, "not found");
  }

  private publishOp(body: Record<string, any>): Promise<unknown> {
    const queue = this.queueOf(body.placeId);
    const line = queue.publishes;
    const ticket = typeof body.ticket === "string" ? body.ticket : "";
    switch (body.op) {
      case "join": {
        const commit = typeof body.commit === "string" && body.commit.trim() ? body.commit.trim().slice(0, 200) : undefined;
        return line.join({
          client: readClient(body.client),
          ...(commit ? { commit } : {}),
          ...(typeof body.task === "string" && body.task ? { task: body.task.slice(0, 300) } : {}),
          level: isLevel(body.level) ? body.level : "blocking",
          rush: body.rush === true,
        });
      }
      case "claim":
        return line.claim(ticket);
      case "touch":
        return Promise.resolve(line.touch(ticket));
      case "done": {
        const version = typeof body.version === "number" || (typeof body.version === "string" && body.version) ? body.version : undefined;
        return line.done(ticket, {
          ok: body.ok === true,
          ...(version !== undefined ? { version } : {}),
          ...(typeof body.commit === "string" && body.commit ? { commit: body.commit } : {}),
          ...(typeof body.reason === "string" && body.reason ? { reason: body.reason.slice(0, 500) } : {}),
        });
      }
      case "leave":
        return line.leave(ticket);
      case "status":
        return Promise.resolve(line.status());
    }
    throw new QueueError(400, "op must be join, claim, touch, done, leave or status");
  }

  private lockOp(body: Record<string, any>): unknown {
    const queue = this.queueOf(body.placeId);
    const op = body.op;
    if (op === "status") return { holder: queue.lock.state.holder, queue: queue.lock.ranked(), cap: queue.lock.state.cap };
    const client: Client = readClient(body.client);
    const tool = typeof body.tool === "string" ? body.tool.slice(0, 120) : "lock";
    switch (op) {
      case "claim": {
        const result = queue.lock.claim(client, tool);
        if (result.ok && result.fresh) queue.kick();
        return result;
      }
      case "touch":
        return { ok: queue.lock.touch(client.id, tool) };
      case "release": {
        const was = queue.lock.release(client.id);
        if (was) queue.kick();
        return { released: Boolean(was), holder: was ?? queue.lock.state.holder };
      }
      case "join": {
        const w = body.waiter ?? {};
        const level = isLevel(w.level) ? w.level : "normal";
        const asked = Number(w.holdMin);
        const holdMin = Number.isFinite(asked) && asked > 0 ? Math.min(600, Math.max(1, Math.round(asked))) : 10;
        const entry = queue.lock.join({
          client,
          task: typeof w.task === "string" ? w.task.slice(0, 300) : "",
          holdMin,
          level,
          rush: w.rush === true,
          exclusive: w.exclusive === true,
        });
        // An exclusive waiter makes the runner stand down: it must be awake to see it
        queue.kick();
        const ranked = queue.lock.ranked();
        return { entry, position: ranked.findIndex((r) => r.client.id === client.id) + 1, queue: ranked };
      }
      case "leave":
        queue.lock.leave(client.id, client.pid);
        return { ok: true };
    }
    throw new QueueError(400, "op must be claim, touch, release, join, leave or status");
  }
}
