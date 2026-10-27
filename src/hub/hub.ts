import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { BUNDLED_BUILD } from "../bundled.js";
import { getUserConfigPath, readMergeSettings, writeMergeSettings } from "../config.js";
import { detectAiCached, resolveAi, usable, type Detected, type Effective } from "../merge/ai.js";
import { ApiError, readConflict, readLogChunk, readMerges, resolveConflict } from "./api.js";
import { findStampedFolders, folderNameFor } from "./candidates.js";
import type { DaemonStatus } from "../hubLink.js";
import { clearHubLock, folderOwner, isAlive, readHubLock, stopOwner, writeHubLock, type FolderOwner, type HubLock } from "./owners.js";
import { loadRegistry, saveRegistry, type Registry } from "./registry.js";

/**
 * Quack hub: one port for every Studio. It reads the place from the plugin's handshake, starts
 * (or reuses) a regular Quack daemon for that place's registered folder on an internal port,
 * and relays the WebSocket both ways. Each game keeps its own daemon process, the same code
 * that runs alone today, so one game failing cannot take the others down.
 *
 * Only this machine may connect (Studio and the app are local): anything else is refused
 * before a byte is read.
 */

export interface HubOptions {
  port: number;
  registryFile: string;
  /** The daemon entry point (dist/cli.js) */
  daemonCli: string;
  /** Node executable for the daemons */
  node?: string;
  log?: (line: string) => void;
  /**
   * Called by POST /api/shutdown, so the app that started the hub can stop it. `handoff` (a
   * restart or an update) leaves the daemons running for the next hub to adopt; otherwise they
   * stop with it. Without it the endpoint does not exist.
   */
  onShutdownRequest?: (options: { handoff: boolean; replaceDaemons: boolean }) => void;
  /**
   * The content id of the daemon this hub starts (DAEMON_BUILD next to daemon.mjs). A running
   * daemon with another one is replaced instead of adopted. Defaults to "dist".
   */
  daemonBuild?: string;
  /**
   * Replace the hub running on this port: get ready first (adopt its daemons), then ask it to
   * step down (a handoff) and take the port the moment it is free. The port is closed for ~tens
   * of ms instead of the whole start of a new hub.
   */
  takeover?: boolean;
  /** Overrides for tests */
  configFile?: string;
  detectAi?: (settings: ReturnType<typeof readMergeSettings>, force: boolean) => Promise<Detected>;
  handshakeDeadlineMs?: number;
  daemonStartTimeoutMs?: number;
}

/** A daemon the last hub left running that this one replaces instead of adopting */
interface Replacement {
  placeId: string;
  folder: string;
  name?: string;
  lock: HubLock & { token: string };
  why: string;
}

/**
 * A place's daemon: one this hub started, or one a previous hub started and this one adopted.
 * Either way it is detached: it outlives the hub, so a hub restart does not drop its Studio.
 */
interface DaemonHandle {
  readonly pid: number | undefined;
  alive(): boolean;
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
}

class OwnDaemon implements DaemonHandle {
  constructor(private readonly child: ChildProcess) {}
  get pid() {
    return this.child.pid;
  }
  alive() {
    // The process itself, not only Node's record of it: "exit" arrives a moment after a crash,
    // and a Studio routed in that moment was sent to the dead daemon's port
    return this.child.exitCode === null && !this.child.killed && isAlive(this.child.pid ?? 0);
  }
  kill() {
    this.child.kill();
  }
  onExit(listener: (code: number | null) => void) {
    this.child.on("exit", (code) => listener(code));
  }
}

/** Not this hub's child: its exit is seen by polling the pid (no "exit" event for it) */
class AdoptedDaemon implements DaemonHandle {
  private exited = false;
  private listeners: ((code: number | null) => void)[] = [];
  private readonly timer: NodeJS.Timeout;
  constructor(readonly pid: number) {
    this.timer = setInterval(() => {
      if (!isAlive(pid)) this.exit();
    }, 500);
    this.timer.unref();
  }
  private exit() {
    if (this.exited) return;
    this.exited = true;
    clearInterval(this.timer);
    for (const listener of this.listeners) listener(null);
  }
  alive() {
    return !this.exited && isAlive(this.pid);
  }
  kill() {
    try {
      process.kill(this.pid);
    } catch {
      // already gone
    }
  }
  onExit(listener: (code: number | null) => void) {
    this.listeners.push(listener);
  }
  /** Stop watching (the hub is closing and leaves it running) */
  release() {
    clearInterval(this.timer);
  }
}

interface Session {
  placeId: string;
  folder: string;
  name?: string;
  daemon: DaemonHandle;
  childPort: number;
  /** Every request to the daemon and every WebSocket to it carries this */
  token: string;
  ready: Promise<void>;
  startedAt: number;
  /** The daemon's last /status, polled while the session lives */
  status?: DaemonStatus;
  statusTimer?: NodeJS.Timeout;
  studio?: WebSocket;
  studioSince?: number;
  /** The connected Studio's plugin session id (new plugins send one) and its relay to the daemon */
  studioSession?: string;
  studioUpstream?: WebSocket;
  /** From the daemon's last "Sync complete" line */
  instances?: number;
  scripts?: number;
  /** The last message either way between the Studio and its daemon, pings left out */
  lastActivity?: number;
  /** When the daemon last printed "Sync complete" (a full snapshot written) */
  syncedAt?: number;
}

export interface SessionInfo {
  placeId: string;
  name?: string;
  folder: string;
  daemonPid?: number;
  daemonPort: number;
  studioConnected: boolean;
  studioSince?: number;
  daemonSince: number;
  instances?: number;
  scripts?: number;
  /** For `quack wait --idle`: a sync is over once nothing has crossed for a while */
  lastActivity?: number;
  /**
   * The last full sync, null before the first. `quack wait` needs one after studioSince: right
   * after a connection nothing crosses while the plugin builds its snapshot (seconds in a big place)
   */
  syncedAt: number | null;
}

export interface Refusal {
  placeId: string;
  placeName?: string;
  why: string;
  at: number;
}

/**
 * A connection that would take a folder or a place from another one, waiting for the user to
 * choose in the app. The Studio is refused meanwhile (it cannot be held while someone thinks)
 * and retries on its own; its next attempt follows the choice.
 */
export interface PendingChoice {
  id: string;
  /** setup: an unregistered place whose Studio asked to be set up ("Set up" in the plugin) */
  kind: "folderInUse" | "secondStudio" | "setup";
  placeId: string;
  placeName?: string;
  folder: string;
  /** The connection that would be stopped: another Quack on the folder, or the other Studio */
  other: { kind: "standalone" | "hub" | "studio" | "none"; pid?: number; port?: number };
  since: number;
  lastSeen: number;
}

type Decision = { decision: "continue" | "cancel"; at: number };

/** A choice still waiting is dropped once its Studio has not retried for this long */
const PENDING_STALE_MS = 30_000;
/** "Continue" is good for the next attempt, "cancel" until the user connects by hand */
const CONTINUE_VALID_MS = 2 * 60_000;
const CANCEL_VALID_MS = 30 * 60_000;

interface Handshake {
  placeId: string;
  placeName?: string;
  /** Per plugin load; without it the old rules apply (a second Studio gets daemonBusy) */
  session?: string;
  /** True when the user clicked Connect, false for auto-connect retries */
  explicit: boolean;
  /** The plugin's "Set up" button: an unregistered place asks the app to register it */
  setup: boolean;
  /** The plugin follows a redirect to its daemon, so a hub restart does not drop it */
  redirect: boolean;
}

/** The app lists a refused place for this long after its last attempt */
const REFUSAL_SHOWN_MS = 10 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;

const MAX_PAYLOAD = 256 * 1024 * 1024;
/** A Studio must name its place this fast, and send at most this much before it does */
const HANDSHAKE_DEADLINE_MS = 15_000;
const HANDSHAKE_MAX_BYTES = 1024 * 1024;
/** A relay whose receiver stops reading is cut once this much is queued for it */
const MAX_QUEUED_BYTES = 512 * 1024 * 1024;
const DAEMON_START_TIMEOUT_MS = 20_000;
/** How often the hub reads each daemon's /status (Studio connected, last sync) */
const STATUS_POLL_MS = 200;

const isLoopback = (address: string | undefined) =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

/**
 * A web page in a browser on this machine can open a WebSocket to localhost too, and the
 * browser always says where the page came from (Origin). Studio and the daemons are not
 * browsers: a connection that carries a web Origin is a page, and is refused.
 */
const isWebOrigin = (origin: string | undefined) => !!origin && /^(https?:|null$)/i.test(origin);

/** The Host header names this machine: localhost, 127.0.0.1 or [::1], with or without a port */
const isLoopbackHost = (host: string | undefined) =>
  !!host && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);

export class QuackHub {
  private server?: http.Server;
  private wss?: WebSocketServer;
  private sessions = new Map<string, Session>();
  /** Daemons being started, so two Studios of one place never start two daemons */
  private starting = new Map<string, Promise<Session>>();
  /** Places whose daemon is being replaced by a successor (started with this hub) */
  private replacing = new Map<string, Promise<void>>();
  private startingFolder = new Map<string, string>();
  private refusedLogged = new Map<string, number>();
  private refusals = new Map<string, Refusal>();
  private pending = new Map<string, PendingChoice>();
  private decisions = new Map<string, Decision>();
  /** Plugin sessions another Studio took the place from: refused quietly until they connect by hand */
  private displaced = new Set<string>();
  private paused = false;
  /** The last AI check, for /api/state (which never waits on the CLIs) */
  private aiSummary?: Effective;
  /** The CLIs that last check found usable; a choice outside them is refused */
  private aiLastUsable?: string[];
  private aiCheckedAt = 0;
  private stopping = false;
  /** Tells this hub from the one started after it, for `quack restart-hub` */
  private startedAt = 0;
  private readonly log: (line: string) => void;

  constructor(private readonly options: HubOptions) {
    this.log = options.log ?? ((line) => console.log(`[${new Date().toISOString()}] ${line}`));
  }

  private registry(): Registry {
    // Read on every connection: a place registered while the hub runs works at once
    return loadRegistry(this.options.registryFile);
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.server,
      maxPayload: MAX_PAYLOAD,
      verifyClient: (info: { req: http.IncomingMessage; origin?: string }) => {
        if (!isLoopback(info.req.socket.remoteAddress)) return false;
        if (isWebOrigin(info.origin)) {
          this.log(`Refused a connection from a web page (Origin ${info.origin})`);
          return false;
        }
        return true;
      },
    });
    this.wss.on("connection", (ws, req) => {
      if (process.env.QUACK_HUB_LOG_HEADERS) {
        this.log(`Connection ${req.url} origin=${req.headers.origin ?? "(none)"} user-agent=${req.headers["user-agent"] ?? "(none)"}`);
      }
      // Before anything else: a bad frame from a client must never crash the hub
      ws.on("error", () => ws.terminate());
      try {
        this.handleConnection(ws, req);
      } catch (error) {
        this.log(`Dropped a connection: ${(error as Error).message}`);
        ws.terminate();
      }
    });
    this.wss.on("error", (error) => this.log(`WebSocket server error: ${error.message}`));
    // Before any Studio arrives: the daemons the last hub left running are this hub's now
    const replacements = await this.adoptDaemons();
    if (this.options.takeover) await this.askRunningHubToStepDown();
    await this.listenWhenFree();
    this.startedAt = Date.now();
    this.log(`Quack hub listening on ${this.options.port} (registry ${this.options.registryFile})`);
    // Daemons that need replacing are replaced now, all at once, with the hub already answering;
    // a Studio of one of those places waits in route() for its own replacement only
    for (const replacement of replacements) {
      const done = this.replaceDaemon(replacement).finally(() => this.replacing.delete(replacement.placeId));
      this.replacing.set(replacement.placeId, done);
    }
    // Known before the app asks: a place with both AIs and no choice shows it at once
    this.aiStatus().catch(() => {});
  }

  /** The hub on this port leaves its daemons (already adopted by this one) and closes its port */
  private async askRunningHubToStepDown(): Promise<void> {
    await new Promise<void>((resolve) => {
      const body = JSON.stringify({ handoff: true });
      const req = http.request(
        { host: "127.0.0.1", port: this.options.port, method: "POST", path: "/api/shutdown", timeout: 3000, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
        (res) => {
          res.resume();
          res.on("end", resolve);
          res.on("error", () => resolve());
        },
      );
      // None running, or it would not answer: the port tells (listenWhenFree)
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve());
      req.end(body);
    });
  }

  /** Listens on the hub port; while another hub still holds it, tries again every 5 ms */
  private async listenWhenFree(): Promise<void> {
    const deadline = Date.now() + (this.options.takeover ? 15_000 : 0);
    for (;;) {
      try {
        await new Promise<void>((resolve, reject) => {
          // Each try removes both of its listeners, so thousands of tries leave none behind
          const onListening = () => {
            this.server!.off("error", onError);
            resolve();
          };
          const onError = (error: Error) => {
            this.server!.off("listening", onListening);
            reject(error);
          };
          this.server!.once("error", onError);
          this.server!.once("listening", onListening);
          this.server!.listen(this.options.port);
        });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, 5));
      }
    }
  }

  /**
   * Stops the hub. With `handoff` (a restart, an update) its daemons keep running, and a Studio
   * connected to one directly keeps syncing; the next hub adopts them. Without it they stop too.
   */
  async stop(options: { handoff?: boolean; replaceDaemons?: boolean } = {}): Promise<void> {
    this.stopping = true;
    // A start or replacement already under way finishes first, so its daemon is in the list below
    await Promise.allSettled([...this.replacing.values()]);
    await Promise.allSettled([...this.starting.values()]);
    // A daemon still coming up is listening (adoptable) before the hub leaves, or was stopped
    await Promise.allSettled([...this.sessions.values()].map((s) => s.ready));
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    for (const session of this.sessions.values()) {
      if (session.statusTimer) clearInterval(session.statusTimer);
      if (!options.handoff) session.daemon.kill();
      else if (session.daemon instanceof AdoptedDaemon) session.daemon.release();
      if (options.handoff && options.replaceDaemons) {
        const lock = readHubLock(session.folder);
        if (lock && lock.daemonPid === session.daemon.pid) writeHubLock(session.folder, { ...lock, replace: true });
      }
    }
    if (options.handoff && this.sessions.size > 0) this.log(`Leaving ${this.sessions.size} daemon(s) running for the next hub`);
    this.sessions.clear();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /**
   * Takes over the daemons a previous hub on this port left running: alive, answering /status
   * with the token from its lock, for the same folder. One built from other code is stopped
   * instead (its Studio reconnects and gets a new one). Anything doubtful is left alone.
   */
  private async adoptDaemons(): Promise<Replacement[]> {
    const want = this.options.daemonBuild ?? "dist";
    // Those to replace are returned and replaced once the hub listens (replaceDaemon)
    const replacements: Replacement[] = [];
    for (const [placeId, entry] of Object.entries(this.registry().places)) {
      const lock = readHubLock(entry.folder);
      if (!lock?.token || lock.hubPort !== this.options.port) continue;
      // The hub before this one is still exiting: its port was free, so it is on its way out.
      // (One in this same process, as in tests, has already stopped: this hub is starting.) A
      // takeover adopts while that hub still runs, and asks it to step down right after.
      if (lock.hubPid !== process.pid && !this.options.takeover) {
        const until = Date.now() + 3000;
        while (isAlive(lock.hubPid) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
        if (isAlive(lock.hubPid)) continue;
      }
      if (!isAlive(lock.daemonPid)) {
        clearHubLock(entry.folder, lock.daemonPid);
        continue;
      }
      const status = await daemonRequest<DaemonStatus>(lock.daemonPort, lock.token, "GET", "/status").catch(() => undefined);
      // A pid Windows gave to another process, or another folder's daemon: not this one
      if (!status || status.pid !== lock.daemonPid || path.resolve(status.folder) !== path.resolve(entry.folder)) continue;
      const name = entry.name ?? placeId;
      if (status.build !== want || lock.replace) {
        const why = status.build !== want ? `runs other code (${status.build}, this hub ships ${want})` : "was asked to restart";
        // Adopted for now all the same: its orphan countdown stops while it waits its turn
        await daemonRequest(lock.daemonPort, lock.token, "POST", "/adopt", { hubPid: process.pid }).catch(() => undefined);
        replacements.push({ placeId, folder: entry.folder, name: entry.name, lock: lock as HubLock & { token: string }, why });
        continue;
      }
      try {
        await daemonRequest(lock.daemonPort, lock.token, "POST", "/adopt", { hubPid: process.pid });
      } catch {
        continue;
      }
      const daemon = new AdoptedDaemon(lock.daemonPid);
      const session: Session = {
        placeId,
        folder: entry.folder,
        name: entry.name,
        daemon,
        childPort: lock.daemonPort,
        token: lock.token,
        ready: Promise.resolve(),
        startedAt: lock.since,
        status,
        // Known at once: `quack wait` and the app need no new sync to see this place is synced
        syncedAt: status.syncedAt ?? undefined,
        scripts: status.scripts,
        instances: status.instances,
      };
      this.sessions.set(placeId, session);
      this.watchSession(session);
      writeHubLock(entry.folder, { ...lock, hubPid: process.pid, hubPort: this.options.port });
      this.log(`Adopted the daemon for ${name} (pid ${lock.daemonPid}, port ${lock.daemonPort}${status.studio.connected ? ", Studio connected" : ""})`);
    }

    return replacements;
  }

  /**
   * The successor starts from the old daemon's tree, and its Studio resumes on it without a
   * snapshot. If the old one cannot hand it over, it is stopped and the Studio resyncs.
   */
  private async replaceDaemon({ placeId, folder, name, lock, why }: Replacement): Promise<void> {
    this.log(`${name ?? placeId}: its daemon ${why}; replacing it`);
    // Two steps: the successor builds itself from the old daemon's tree while the old one keeps
    // syncing (~1.4 s on a 262k-instance place, measured 21/10/26), and only then the switch,
    // where the Studio waits for nothing but the changes made meanwhile
    const prepared = await daemonRequest<{ file: string }>(lock.daemonPort, lock.token, "POST", "/export", { phase: "prepare" }, 30_000).catch(() => undefined);
    if (prepared) {
      let successor: Session | undefined;
      try {
        successor = await this.sessionFor(placeId, folder, name, prepared.file, true);
        await successor.ready;
      } catch (error) {
        this.log(`${name ?? placeId}: the successor did not start (${(error as Error).message}); handing over in one step`);
        successor = undefined;
      }
      if (successor) {
        const final = await daemonRequest<{ file: string }>(lock.daemonPort, lock.token, "POST", "/export", { phase: "final", successorUrl: daemonUrl(successor) }, 30_000).catch(() => undefined);
        if (!final && isAlive(lock.daemonPid)) {
          // No last word, and the old one may still be syncing: it must be gone before the
          // successor writes, or both would. One that will not stop keeps the place.
          try {
            process.kill(lock.daemonPid);
          } catch {
            // gone meanwhile
          }
          const killBy = Date.now() + 2000;
          while (isAlive(lock.daemonPid) && Date.now() < killBy) await new Promise((r) => setTimeout(r, 25));
          if (isAlive(lock.daemonPid)) {
            this.log(`${name ?? placeId}: the old daemon would neither hand over nor stop; it keeps the place`);
            if (this.sessions.get(placeId) === successor) this.sessions.delete(placeId);
            successor.daemon.kill();
            // The folder is the old one's again: its lock, not the dropped successor's
            setTimeout(() => writeHubLock(folder, lock), 500);
            return;
          }
        }
        // Without the old one's last word, the successor goes by what changed on disk since it built
        const tookOver = await daemonRequest(successor.childPort, successor.token, "POST", "/takeover", final ? { file: final.file } : {}, 30_000).then(
          () => true,
          (error: Error) => {
            this.log(`${name ?? placeId}: the successor did not take over (${error.message})`);
            return false;
          },
        );
        if (!tookOver) {
          if (this.sessions.get(placeId) === successor) this.sessions.delete(placeId);
          successor.daemon.kill();
        }
        await this.waitForOldDaemon(lock, folder, name ?? placeId);
        return;
      }
    }
    const handed = await daemonRequest<{ file: string }>(lock.daemonPort, lock.token, "POST", "/export", {}, 30_000).catch(() => undefined);
    // Handed over: the old daemon no longer writes the folder (its watcher and Studio are gone,
    // it is only closing down), so the successor starts now; waiting cost 0.6 s (21/10/26)
    const successor = handed ? this.sessionFor(placeId, folder, name, handed.file).catch(() => undefined) : undefined;
    if (!handed) await daemonRequest(lock.daemonPort, lock.token, "POST", "/shutdown", {}).catch(() => undefined);
    await this.waitForOldDaemon(lock, folder, name ?? placeId);
    // Its Studio is reconnecting: it waits for this in route() and lands on the successor
    if (successor) await successor;
  }

  /** The replaced daemon stops on its own after handing over; one that does not is killed */
  private async waitForOldDaemon(lock: HubLock, folder: string, label: string): Promise<void> {
    const until = Date.now() + 5000;
    while (isAlive(lock.daemonPid) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    if (isAlive(lock.daemonPid)) {
      try {
        process.kill(lock.daemonPid);
      } catch {
        // gone meanwhile, or not ours to kill (checked below)
      }
      const killBy = Date.now() + 2000;
      while (isAlive(lock.daemonPid) && Date.now() < killBy) await new Promise((r) => setTimeout(r, 25));
    }
    // Still alive: its lock stays, so the folder keeps counting as taken (claimFolder asks)
    if (!isAlive(lock.daemonPid)) clearHubLock(folder, lock.daemonPid);
    else this.log(`${label}: the old daemon (pid ${lock.daemonPid}) would not stop`);
  }

  /** Polls the daemon's /status (the Studio, the last sync) and forgets the session when it exits */
  private watchSession(session: Session): void {
    session.daemon.onExit((code) => {
      if (session.statusTimer) clearInterval(session.statusTimer);
      clearHubLock(session.folder, session.daemon.pid);
      if (this.sessions.get(session.placeId) === session) this.sessions.delete(session.placeId);
      this.log(`Daemon for ${session.name ?? session.placeId} exited (${code})`);
    });
    const poll = () => {
      daemonRequest<DaemonStatus>(session.childPort, session.token, "GET", "/status").then(
        (status) => {
          session.status = status;
          if (status.syncedAt !== null) {
            session.syncedAt = status.syncedAt;
            session.scripts = status.scripts;
            session.instances = status.instances;
          }
        },
        () => {},
      );
    };
    poll();
    session.statusTimer = setInterval(poll, STATUS_POLL_MS);
    session.statusTimer.unref();
  }

  /** What the app shows: one entry per running game daemon */
  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => {
      // A Studio relayed by this hub (an older plugin), or one talking to its daemon directly
      const relayed = s.studio?.readyState === WebSocket.OPEN;
      const direct = s.status?.studio;
      const activity = Math.max(s.lastActivity ?? 0, direct?.lastActivity ?? 0);
      return {
        placeId: s.placeId,
        name: s.name,
        folder: s.folder,
        daemonPid: s.daemon.pid,
        daemonPort: s.childPort,
        studioConnected: relayed || direct?.connected === true,
        studioSince: relayed ? s.studioSince : direct?.since,
        daemonSince: s.startedAt,
        instances: s.instances,
        scripts: s.scripts,
        lastActivity: activity || undefined,
        syncedAt: s.syncedAt ?? null,
      };
    });
  }

  /** Everything the app's tray and window show, in one poll */
  state() {
    const registry = this.registry();
    const now = Date.now();
    for (const [id, refusal] of this.refusals) if (now - refusal.at > REFUSAL_SHOWN_MS) this.refusals.delete(id);
    const places = Object.entries(registry.places).map(([placeId, entry]) => {
      let merges = { today: 0, conflicts: 0 };
      try {
        const summary = readMerges(entry.folder);
        merges = { today: summary.today, conflicts: summary.conflicts.length };
      } catch {
        // an unreadable folder shows no merges
      }
      return { placeId, name: entry.name, folder: entry.folder, ...merges };
    });
    for (const [id, choice] of this.pending) if (now - choice.lastSeen > PENDING_STALE_MS) this.pending.delete(id);
    return {
      build: BUNDLED_BUILD ?? "dist",
      startedAt: this.startedAt,
      paused: this.paused,
      sessions: this.listSessions(),
      places,
      pending: [...this.pending.values()].sort((a, b) => a.since - b.since),
      // A place registered after its refusal is no longer refused
      refused: [...this.refusals.values()].filter((r) => !registry.places[r.placeId]).sort((a, b) => b.at - a.at),
      ai: this.aiSummaryFresh(now),
    };
  }

  /**
   * The last AI check, with a new one started in the background once it is five minutes old: a
   * CLI installed later, or a choice made in the other hub's app (same file), shows up on its own
   */
  private aiSummaryFresh(now: number): Effective | undefined {
    if (now - this.aiCheckedAt > 5 * 60_000) {
      this.aiCheckedAt = now;
      this.aiStatus().catch(() => {});
    }
    return this.aiSummary;
  }

  /** The AI merge: what this machine has, what the user set, and what a merge would use */
  async aiStatus(force = false) {
    this.aiCheckedAt = Date.now();
    const file = this.options.configFile ?? getUserConfigPath();
    const settings = readMergeSettings(file);
    const detected = await (this.options.detectAi ?? detectAiCached)(settings, force);
    const effective = resolveAi(settings, detected);
    this.aiSummary = effective;
    this.aiLastUsable = usable(detected);
    return { detected, usable: usable(detected), settings: { ai: settings.ai, provider: settings.provider }, effective, file };
  }

  /** Paused: every daemon stops and every Studio is turned away until resumed */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.log(paused ? "Paused: daemons stopped, Studios refused" : "Resumed");
    if (!paused) return;
    for (const session of this.sessions.values()) {
      session.studio?.close();
      session.daemon.kill();
    }
    this.sessions.clear();
  }

  /**
   * The live session `quackdev play` goes through. Whether a Studio is synced is the daemon's to
   * say: a Studio sent to its daemon directly is not one the hub relays
   */
  private playSession(placeId: string | null): Session {
    this.folderOf(placeId);
    const session = this.sessions.get(placeId!);
    if (!session) throw new ApiError(409, `place ${placeId} has no daemon running (open it in Studio first)`);
    return session;
  }

  private folderOf(placeId: string | null): string {
    const entry = placeId ? this.registry().places[placeId] : undefined;
    if (!entry) throw new ApiError(404, `place ${placeId} is not registered`);
    return entry.folder;
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    // The app is the only HTTP client. A browser page on this machine can reach localhost too,
    // so a web Origin is refused here as on the WebSocket, and a POST must be JSON: a page
    // cannot send that without a preflight, which this server never answers
    // A same-origin GET carries no Origin, so a page whose own name was rebound to 127.0.0.1
    // (DNS rebinding) would pass that check: the Host it sends still names its own site
    if (!isLoopback(req.socket.remoteAddress) || isWebOrigin(req.headers.origin) || !isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end();
      return;
    }
    const send = (status: number, body: unknown) => {
      if (res.headersSent) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      send(400, { error: "bad request target" });
      return;
    }
    const fail = (error: unknown) => {
      if (error instanceof ApiError) send(error.status, { error: error.message });
      else {
        this.log(`API ${url.pathname} failed: ${(error as Error).message}`);
        send(500, { error: (error as Error).message });
      }
    };

    if (req.method === "GET") {
      try {
        const q = url.searchParams;
        switch (url.pathname) {
          case "/api/sessions":
            return send(200, { sessions: this.listSessions() });
          case "/api/state":
            return send(200, this.state());
          case "/api/log": {
            const from = q.get("from");
            const offset = from === null ? undefined : Number(from);
            if (offset !== undefined && !(Number.isInteger(offset) && offset >= 0)) throw new ApiError(400, "bad from");
            return send(200, readLogChunk(this.folderOf(q.get("placeId")), offset, q.get("ansi") === "1"));
          }
          case "/api/merges":
            return send(200, readMerges(this.folderOf(q.get("placeId"))));
          case "/api/setup-candidates": {
            // Folders already stamped with the place, under the roots the app names plus the
            // folders that hold registered games; and where a new one would go
            const placeId = q.get("placeId") ?? "";
            if (!/^\d+$/.test(placeId)) throw new ApiError(400, "placeId must be a place id");
            const roots = q.getAll("root").filter((r) => path.isAbsolute(r));
            for (const entry of Object.values(this.registry().places)) roots.push(path.dirname(entry.folder));
            const name = q.get("name") ?? undefined;
            return send(200, { existing: findStampedFolders(placeId, roots), folderName: folderNameFor(name, placeId) });
          }
          case "/api/conflict":
            return send(200, readConflict(this.folderOf(q.get("placeId")), q.get("id") ?? ""));
          case "/api/ai":
            this.aiStatus(q.get("refresh") === "1").then((status) => send(200, status), fail);
            return;
          case "/api/play": {
            const session = this.playSession(q.get("placeId"));
            daemonRequest<{ play: unknown }>(session.childPort, session.token, "GET", "/play").then((answer) => send(200, answer), fail);
            return;
          }
          case "/api/unsynced": {
            const session = this.playSession(q.get("placeId"));
            daemonRequest<{ files: string[] }>(session.childPort, session.token, "GET", "/unsynced").then((answer) => send(200, answer), fail);
            return;
          }
        }
      } catch (error) {
        return fail(error);
      }
      return send(404, { error: "not found" });
    }

    if (req.method === "POST") {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
        send(415, { error: "send JSON" });
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          send(413, { error: "too large" });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("error", () => res.destroy());
      req.on("end", () => {
        if (size > MAX_BODY_BYTES) return;
        try {
          let body: any;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            throw new ApiError(400, "body is not JSON");
          }
          if (!body || typeof body !== "object") throw new ApiError(400, "body must be an object");
          if (url.pathname === "/api/shutdown" && this.options.onShutdownRequest) {
            const handoff = body.handoff === true;
            const replaceDaemons = handoff && body.replaceDaemons === true;
            this.log(
              !handoff ? "Shutdown requested by the app"
              : replaceDaemons ? "Restart requested with the daemons: the next hub replaces them"
              : "Restart requested: the daemons keep running for the next hub",
            );
            res.once("finish", () => this.options.onShutdownRequest?.({ handoff, replaceDaemons }));
            send(200, { ok: true });
            return;
          }
          if (url.pathname === "/api/ai") {
            // Checked first, so a choice right after start is held to what is really here
            const checked = this.aiLastUsable ? Promise.resolve() : this.aiStatus();
            checked.then(() => this.setAi(body)).then(() => this.aiStatus()).then((status) => send(200, status), fail);
            return;
          }
          if (url.pathname === "/api/unsynced") {
            const session = this.playSession(typeof body.placeId === "string" ? body.placeId : null);
            daemonRequest<{ files: string[] }>(session.childPort, session.token, "POST", "/unsynced", {}).then((answer) => send(200, answer), fail);
            return;
          }
          if (url.pathname === "/api/play") {
            // Quack: `quackdev play`. The daemon answers once the swap is over (~2 s)
            const session = this.playSession(typeof body.placeId === "string" ? body.placeId : null);
            if (typeof body.worktree !== "string" || !path.isAbsolute(body.worktree)) throw new ApiError(400, "worktree must be an absolute path");
            this.log(`${session.name ?? session.placeId}: play of ${body.worktree}`);
            daemonRequest<{ play: unknown }>(session.childPort, session.token, "POST", "/play", { worktree: path.resolve(body.worktree) }, 60_000).then(
              (answer) => send(200, answer),
              fail,
            );
            return;
          }
          this.handlePost(url.pathname, body);
          send(200, { ok: true });
        } catch (error) {
          fail(error);
        }
      });
      return;
    }
    send(405, { error: "method not allowed" });
  }

  /**
   * Turns the AI merge on or off and picks Claude or Codex. Only what this machine can run:
   * turning it on with nothing installed, or picking a CLI that is not here, is refused.
   * The file is shared by every game and both hubs, so every daemon follows at its next merge.
   */
  private setAi(body: Record<string, unknown>): void {
    const file = this.options.configFile ?? getUserConfigPath();
    const patch: { ai?: boolean; provider?: "claude" | "codex" } = {};
    if (body.ai !== undefined) {
      if (typeof body.ai !== "boolean") throw new ApiError(400, "ai must be true or false");
      patch.ai = body.ai;
    }
    if (body.provider !== undefined) {
      if (body.provider !== "claude" && body.provider !== "codex") throw new ApiError(400, "provider must be claude or codex");
      patch.provider = body.provider;
    }
    const last = this.aiLastUsable;
    if (patch.ai === true && last && last.length === 0) throw new ApiError(409, "no AI here: install Claude Code or Codex and log in");
    if (patch.provider && last && !last.includes(patch.provider)) throw new ApiError(409, `${patch.provider} is not installed or not logged in here`);
    writeMergeSettings(patch, file);
    this.log(`AI merge: ${patch.ai === undefined ? "" : patch.ai ? "on" : "off"}${patch.provider ? ` ${patch.provider}` : ""}`.trim());
  }

  private handlePost(pathname: string, body: Record<string, unknown>): void {
    switch (pathname) {
      case "/api/pause":
        if (typeof body.paused !== "boolean") throw new ApiError(400, "paused must be true or false");
        this.setPaused(body.paused);
        return;
      case "/api/conflict/resolve": {
        if (body.action !== "useDisk" && body.action !== "keep") throw new ApiError(400, "action must be useDisk or keep");
        if (typeof body.id !== "string") throw new ApiError(400, "id is required");
        resolveConflict(this.folderOf(typeof body.placeId === "string" ? body.placeId : null), body.id, body.action);
        return;
      }
      case "/api/registry": {
        const { placeId, folder, name } = body;
        if (typeof placeId !== "string" || !/^\d+$/.test(placeId) || placeId === "0") throw new ApiError(400, "placeId must be a place id");
        if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new ApiError(400, "folder must be an absolute path");
        if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new ApiError(400, `folder ${folder} does not exist`);
        if (name !== undefined && typeof name !== "string") throw new ApiError(400, "name must be text");
        const registry = this.registry();
        registry.places[placeId] = { folder: path.resolve(folder), ...(name ? { name } : {}) };
        saveRegistry(this.options.registryFile, registry);
        this.refusals.delete(placeId);
        // Registered: its setup request is answered
        this.pending.delete(`setup:${placeId}`);
        this.log(`Registered ${name ?? placeId} -> ${folder}`);
        // Moved to another folder while syncing: its daemon must not keep writing the old one.
        // Its Studio, talking to that daemon directly, reconnects and lands on the new folder.
        const running = this.sessions.get(placeId);
        if (running && path.resolve(running.folder) !== path.resolve(folder)) {
          this.sessions.delete(placeId);
          running.studio?.close();
          running.daemon.kill();
          this.log(`${name ?? placeId}: stopped its daemon for ${running.folder}`);
        }
        return;
      }
      case "/api/choice": {
        if (typeof body.id !== "string") throw new ApiError(400, "id is required");
        if (body.decision !== "continue" && body.decision !== "cancel") throw new ApiError(400, "decision must be continue or cancel");
        const choice = this.pending.get(body.id);
        if (!choice) throw new ApiError(404, "no such choice waiting");
        this.pending.delete(body.id);
        this.decisions.set(body.id, { decision: body.decision, at: Date.now() });
        this.log(`${choice.placeName ?? choice.placeId}: ${body.decision === "continue" ? "take over" : "keep the other connection"} (${choice.kind})`);
        return;
      }
      case "/api/unregister": {
        if (typeof body.placeId !== "string") throw new ApiError(400, "placeId is required");
        const registry = this.registry();
        delete registry.places[body.placeId];
        saveRegistry(this.options.registryFile, registry);
        // Its daemon must stop serving a folder that is no longer registered
        const session = this.sessions.get(body.placeId);
        if (session) {
          this.sessions.delete(body.placeId);
          session.studio?.close();
          session.daemon.kill();
        }
        this.log(`Unregistered ${body.placeId}`);
        return;
      }
    }
    throw new ApiError(404, "not found");
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      ws.terminate();
      return;
    }
    if (url.pathname === "/studio-output") {
      this.relayOutput(ws, url.searchParams.get("placeId") ?? "");
      return;
    }

    // Everything the Studio sends is held, in order, until its daemon is ready; that covers the
    // wait for the handshake and the wait for the daemon to start
    const held: RawData[] = [];
    let heldBytes = 0;
    let upstream: WebSocket | undefined;
    let routed = false;

    const deadline = setTimeout(() => {
      if (!routed) ws.terminate();
    }, this.options.handshakeDeadlineMs ?? HANDSHAKE_DEADLINE_MS);
    ws.on("close", () => clearTimeout(deadline));

    ws.on("message", (data) => {
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        sendBounded(upstream, data, ws);
        return;
      }
      held.push(data);
      heldBytes += rawLength(data);
      if (heldBytes > (routed ? MAX_QUEUED_BYTES : HANDSHAKE_MAX_BYTES)) {
        ws.terminate();
        return;
      }
      if (routed) return;

      let message: { type?: string; placeId?: unknown; placeName?: unknown; session?: unknown; explicit?: unknown; setup?: unknown; redirect?: unknown } | undefined;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message?.type !== "handshakeStudio") return;
      routed = true;
      clearTimeout(deadline);
      const handshake: Handshake = {
        placeId: typeof message.placeId === "number" ? String(message.placeId) : "",
        placeName: typeof message.placeName === "string" ? message.placeName.slice(0, 200) : undefined,
        session: typeof message.session === "string" && message.session.length <= 100 ? message.session : undefined,
        explicit: message.explicit === true,
        setup: message.setup === true,
        redirect: message.redirect === true,
      };
      void this.route(ws, handshake, held, (socket) => (upstream = socket)).catch((error) => {
        this.log(`Routing failed: ${(error as Error).message}`);
        ws.terminate();
      });
    });
  }

  private refuse(ws: WebSocket, placeId: string, placeName: string | undefined, why: string): void {
    // Auto-connect retries every few seconds: log a refused place once a minute, not every time
    const now = Date.now();
    if (this.refusals.size > 200) this.refusals.clear();
    this.refusals.set(placeId, { placeId, placeName, why, at: now });
    if (this.refusedLogged.size > 200) {
      for (const [id, at] of this.refusedLogged) if (now - at > 60_000) this.refusedLogged.delete(id);
      if (this.refusedLogged.size > 200) this.refusedLogged.clear();
    }
    const last = this.refusedLogged.get(placeId) ?? 0;
    if (now - last > 60_000) {
      this.log(`Refused ${placeName ?? "a place"} (${placeId || "no place id"}): ${why}`);
      this.refusedLogged.set(placeId, now);
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "error", message: `Quack hub: ${why}` }));
    ws.send(JSON.stringify({ type: "daemonDisconnect" }), () => ws.close());
  }

  /** Refused for good: the plugin stops retrying (daemonBusy) and shows `why` */
  private refuseQuietly(ws: WebSocket, why: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "daemonBusy", message: `Quack hub: ${why}` }), () => ws.close());
  }

  /** Records or refreshes a choice for the app; the Studio is told to wait and retries */
  private ask(ws: WebSocket, choice: Omit<PendingChoice, "since" | "lastSeen">, why: string): void {
    const now = Date.now();
    const existing = this.pending.get(choice.id);
    if (!existing) this.log(`${choice.placeName ?? choice.placeId}: waiting for a choice in the app (${choice.kind})`);
    this.pending.set(choice.id, { ...choice, since: existing?.since ?? now, lastSeen: now });
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "error", message: `Quack hub: ${why}` }));
    ws.send(JSON.stringify({ type: "daemonDisconnect" }), () => ws.close());
  }

  /** The user's choice for a pending id, if one is still valid; "continue" is used up here */
  private takeDecision(id: string, explicit: boolean): "continue" | "cancel" | undefined {
    const found = this.decisions.get(id);
    if (!found) return undefined;
    const age = Date.now() - found.at;
    if (found.decision === "continue") {
      this.decisions.delete(id);
      return age < CONTINUE_VALID_MS ? "continue" : undefined;
    }
    // A cancel holds until the user connects by hand, which asks again
    if (explicit || age > CANCEL_VALID_MS) {
      this.decisions.delete(id);
      return undefined;
    }
    return "cancel";
  }

  /** Before a daemon starts on a folder: another Quack syncing it is stopped only if the user says so */
  private async claimFolder(ws: WebSocket, handshake: Handshake, folder: string, name: string | undefined): Promise<boolean> {
    const { placeId, explicit } = handshake;
    const running = this.sessions.get(placeId);
    if (running && path.resolve(running.folder) === path.resolve(folder)) return true;
    let owner: FolderOwner | undefined;
    try {
      owner = await folderOwner(folder, process.pid);
    } catch {
      owner = undefined;
    }
    if (!owner) return true;
    const id = `folder:${placeId}`;
    const decision = this.takeDecision(id, explicit);
    const label = owner.kind === "standalone" ? `a standalone Quack (pid ${owner.pid}, port ${owner.port})` : `another Quack hub (port ${owner.port})`;
    if (decision === "continue") {
      this.log(`${name ?? placeId}: stopping ${label} on ${folder}`);
      await stopOwner(folder, owner);
      return true;
    }
    if (decision === "cancel") {
      this.refuseQuietly(ws, `${folder} stays with ${label}. Connect again to choose again.`);
      return false;
    }
    this.ask(ws, { id, kind: "folderInUse", placeId, placeName: name, folder, other: { kind: owner.kind, pid: owner.pid, port: owner.port } },
      `${folder} is already synced by ${label}. Choose in the Quack app whether this Studio takes it over.`);
    return false;
  }

  /** A second Studio of a place already syncing: it takes over only if the user says so */
  private async claimStudio(ws: WebSocket, handshake: Handshake, session: Session): Promise<boolean> {
    const { placeId, explicit } = handshake;
    const sessionId = handshake.session;
    // The Studio syncing now: relayed by this hub, or connected to the daemon directly
    const relayed = session.studio?.readyState === WebSocket.OPEN ? session.studio : undefined;
    const status = relayed ? undefined : await this.refreshStatus(session);
    const direct = status?.studio.connected ? status.studio : undefined;
    const currentSession = relayed ? session.studioSession : direct?.session;
    // Old plugins send no session id: the daemon answers daemonBusy, as before
    if (!sessionId || (!relayed && !direct)) return true;
    if (currentSession === sessionId) {
      // The same plugin again while its old direct socket is still open: that one is stale
      if (direct) await this.kickDirect(session, "reconnecting.");
      return true;
    }
    if (this.displaced.has(sessionId)) {
      if (!explicit) {
        this.refuseQuietly(ws, "another Studio took this place over. Connect again to choose again.");
        return false;
      }
      this.displaced.delete(sessionId);
    }
    const id = `studio:${placeId}:${sessionId}`;
    const decision = this.takeDecision(id, explicit);
    if (decision === "cancel") {
      this.refuseQuietly(ws, "the other Studio keeps this place. Connect again to choose again.");
      return false;
    }
    if (decision !== "continue") {
      this.ask(ws, { id, kind: "secondStudio", placeId, placeName: session.name ?? handshake.placeName, folder: session.folder, other: { kind: "studio" } },
        "another Studio is syncing this place. Choose in the Quack app whether this one takes over.");
      return false;
    }
    // Take over: the old Studio is told why and stops retrying; its daemon link closes before the
    // new one opens, or the daemon would still see it and answer daemonBusy
    if (currentSession) this.displaced.add(currentSession);
    if (this.displaced.size > 200) this.displaced.clear();
    const why = "another Studio took this place over. Connect again to take it back.";
    if (relayed) {
      this.refuseQuietly(relayed, why);
      const oldUpstream = session.studioUpstream;
      oldUpstream?.close();
      const deadline = Date.now() + 3000;
      while (oldUpstream && oldUpstream.readyState !== WebSocket.CLOSED && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    } else {
      await this.kickDirect(session, why);
    }
    this.log(`${session.name ?? placeId}: a new Studio took over`);
    return true;
  }

  /**
   * The daemon's /status now, not the last poll's. A daemon that does not answer has no Studio:
   * an old "connected" kept the hub waiting 3 s to kick a socket of a daemon that had died
   * (measured 21/10/26, every daemon crash).
   */
  private async refreshStatus(session: Session): Promise<DaemonStatus | undefined> {
    try {
      session.status = await daemonRequest<DaemonStatus>(session.childPort, session.token, "GET", "/status");
      return session.status;
    } catch {
      return undefined;
    }
  }

  /** Drops the Studio connected to the daemon directly, and waits until the daemon is free */
  private async kickDirect(session: Session, why: string): Promise<void> {
    await daemonRequest(session.childPort, session.token, "POST", "/kick", { why: `Quack hub: ${why}` }).catch(() => undefined);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await this.refreshStatus(session))?.studio.connected) await new Promise((r) => setTimeout(r, 50));
  }

  private async route(
    ws: WebSocket,
    handshake: Handshake,
    held: RawData[],
    setUpstream: (socket: WebSocket) => void,
  ): Promise<void> {
    const { placeId, placeName } = handshake;
    if (this.paused) {
      this.refuse(ws, placeId, placeName, "Quack is paused");
      return;
    }
    if (!placeId || placeId === "0") {
      this.refuse(ws, placeId, placeName, "this place is not saved to Roblox yet (no place id)");
      return;
    }
    const entry = this.registry().places[placeId];
    if (!entry) {
      // "Set up" in the plugin (or a retry while that setup is open in the app) waits for the app
      const id = `setup:${placeId}`;
      if (handshake.setup || this.pending.has(id)) {
        const decision = this.takeDecision(id, handshake.explicit);
        if (decision !== "cancel") {
          this.ask(ws, { id, kind: "setup", placeId, placeName, folder: "", other: { kind: "none" } },
            "finish setting this place up in the Quack app; it connects on its own after.");
          return;
        }
      }
      this.refuse(ws, placeId, placeName, `place ${placeId} is not registered with the hub`);
      return;
    }

    // Its daemon is handing over to a successor: the old one still holds the folder until then
    await this.replacing.get(placeId);
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!(await this.claimFolder(ws, handshake, entry.folder, entry.name ?? placeName))) return;
    if (ws.readyState !== WebSocket.OPEN) return;

    let session: Session;
    try {
      session = await this.sessionFor(placeId, entry.folder, entry.name ?? placeName);
      await session.ready;
    } catch (error) {
      this.refuse(ws, placeId, placeName, this.paused ? "Quack is paused" : `the daemon for ${entry.folder} did not start: ${(error as Error).message}`);
      return;
    }
    if (this.paused) {
      this.refuse(ws, placeId, placeName, "Quack is paused");
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!(await this.claimStudio(ws, handshake, session))) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    // It died while this Studio was being routed (a crash): the Studio goes to a new one, not
    // to the port of the dead one
    if (!session.daemon.alive()) {
      try {
        session = await this.sessionFor(placeId, entry.folder, entry.name ?? placeName);
        await session.ready;
      } catch (error) {
        this.refuse(ws, placeId, placeName, `the daemon for ${entry.folder} did not start: ${(error as Error).message}`);
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
    }

    if (handshake.redirect) {
      // The plugin talks to its daemon from here on: a hub restart no longer touches that link.
      // The handshake it sent here is dropped; it sends it again to the daemon.
      held.length = 0;
      ws.send(JSON.stringify({ type: "redirect", url: daemonUrl(session) }), () => ws.close());
      this.log(`${session.name ?? placeId}: sent to its daemon directly (port ${session.childPort})`);
      return;
    }

    const upstream = new WebSocket(daemonUrl(session), { maxPayload: MAX_PAYLOAD });
    upstream.on("open", () => {
      // Flush what the Studio sent while waiting, in order, then relay directly
      for (const data of held.splice(0)) sendBounded(upstream, data, ws);
      setUpstream(upstream);
    });
    let accepted = false;
    upstream.on("message", (data) => {
      // This Studio owns the session only once its daemon acknowledges the handshake; a second
      // Studio of the same place gets daemonBusy and must not displace the first in the list
      if (!accepted) {
        try {
          if (JSON.parse(data.toString())?.type === "handshakeAck") {
            accepted = true;
            session.studio = ws;
            session.studioSince = Date.now();
            session.studioSession = handshake.session;
            session.studioUpstream = upstream;
            this.log(`${session.name ?? placeId} connected -> ${session.folder}`);
          }
        } catch {
          // not JSON: relay as is
        }
      }
      if (accepted && isActivity(data)) session.lastActivity = Date.now();
      sendBounded(ws, data, upstream);
    });
    ws.on("message", (data) => {
      if (accepted && isActivity(data)) session.lastActivity = Date.now();
    });

    const closeBoth = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
      if (session.studio === ws) {
        session.studio = undefined;
        session.studioSince = undefined;
        session.studioSession = undefined;
        session.studioUpstream = undefined;
        this.log(`${session.name ?? placeId} disconnected (its daemon keeps running)`);
      }
    };
    ws.on("close", closeBoth);
    ws.on("error", closeBoth);
    upstream.on("close", closeBoth);
    upstream.on("error", closeBoth);
  }

  private relayOutput(ws: WebSocket, placeId: string): void {
    const session = this.sessions.get(placeId);
    if (!session) {
      ws.close();
      return;
    }
    const upstream = new WebSocket(daemonUrl(session, "/studio-output"));
    const pending: RawData[] = [];
    let pendingBytes = 0;
    ws.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) {
        sendBounded(upstream, data, ws);
        return;
      }
      pending.push(data);
      pendingBytes += rawLength(data);
      if (pendingBytes > HANDSHAKE_MAX_BYTES) ws.terminate();
    });
    upstream.on("open", () => {
      for (const data of pending.splice(0)) sendBounded(upstream, data, ws);
    });
    upstream.on("message", (data) => sendBounded(ws, data, upstream));
    const closeBoth = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    };
    ws.on("close", closeBoth);
    ws.on("error", closeBoth);
    upstream.on("close", closeBoth);
    upstream.on("error", closeBoth);
  }

  /** The running daemon for a place, started on first use */
  private sessionFor(placeId: string, folder: string, name?: string, seed?: string, standby = false): Promise<Session> {
    const existing = this.sessions.get(placeId);
    if (existing && existing.daemon.alive()) {
      if (path.resolve(existing.folder) === path.resolve(folder)) {
        if (name) existing.name = name;
        return Promise.resolve(existing);
      }
      // Re-registered to another folder: the old daemon must not keep serving this place
      this.log(`${name ?? placeId} now points to ${folder}; stopping its daemon for ${existing.folder}`);
      this.sessions.delete(placeId);
      existing.daemon.kill();
    }

    const inFlight = this.starting.get(placeId);
    if (inFlight) {
      if (path.resolve(this.startingFolder.get(placeId) ?? "") === path.resolve(folder)) return inFlight;
      // A start for the old folder is under way: let it land, then this call replaces it
      return inFlight.then(
        () => this.sessionFor(placeId, folder, name, seed, standby),
        () => this.sessionFor(placeId, folder, name, seed, standby),
      );
    }
    const startup = this.startDaemon(placeId, folder, name, seed, standby).finally(() => {
      this.starting.delete(placeId);
      this.startingFolder.delete(placeId);
    });
    this.starting.set(placeId, startup);
    this.startingFolder.set(placeId, folder);
    return startup;
  }

  private async startDaemon(placeId: string, folder: string, name?: string, seed?: string, standby = false): Promise<Session> {
    if (this.stopping) throw new Error("the hub is stopping");
    if (!fs.existsSync(folder)) throw new Error(`folder ${folder} does not exist`);
    if (this.paused) throw new Error("Quack is paused");
    const childPort = await freePort();
    if (this.stopping) throw new Error("the hub is stopping");
    // Paused while the port was being found: setPaused already stopped what was running, and
    // this start must not add a daemon after it
    if (this.paused) throw new Error("Quack is paused");
    // Unregistered (or moved to another folder) meanwhile: no daemon for a folder it left
    const entry = this.registry().places[placeId];
    if (!entry || path.resolve(entry.folder) !== path.resolve(folder)) throw new Error(`${folder} is no longer registered for this place`);
    const quackDir = path.join(folder, ".quack");
    fs.mkdirSync(quackDir, { recursive: true });
    const logFile = path.join(quackDir, "daemon.log");
    fs.appendFileSync(logFile, `\n===== quack hub start ${new Date().toISOString()} (internal port ${childPort}) =====\n`);
    // The daemon writes its log itself: a pipe through the hub would break when the hub restarts
    const logFd = fs.openSync(logFile, "a");
    const token = randomBytes(24).toString("hex");

    let child: ChildProcess;
    try {
      // Detached: on Windows a non-detached child sits in libuv's job object and dies with the
      // hub, even on a hard kill (measured 21/10/26). This one outlives a hub restart.
      child = spawn(this.options.node ?? process.execPath, [this.options.daemonCli, "--port", String(childPort), "--no-warn"], {
        cwd: folder,
        windowsHide: true,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, QUACK_HUB_TOKEN: token, QUACK_HUB_PID: String(process.pid), ...(seed ? { QUACK_HUB_SEED: seed } : {}), ...(standby ? { QUACK_HUB_STANDBY: "1" } : {}) },
      });
    } finally {
      fs.closeSync(logFd);
    }
    child.unref();

    let spawnError = false;
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once("error", (error) => {
        spawnError = true;
        reject(error);
      });
    });
    const session: Session = {
      placeId,
      folder,
      name,
      daemon: new OwnDaemon(child),
      childPort,
      token,
      startedAt: Date.now(),
      ready: Promise.race([waitForPort(childPort, this.options.daemonStartTimeoutMs ?? DAEMON_START_TIMEOUT_MS, child, () => spawnError), spawnFailed]),
    };
    // A failed start leaves nothing behind: the next connection tries again from scratch
    session.ready.catch((error) => {
      this.log(`Daemon for ${name ?? placeId} did not start: ${(error as Error).message}`);
      if (this.sessions.get(placeId) === session) this.sessions.delete(placeId);
      child.kill();
    });
    this.sessions.set(placeId, session);
    // Marks the folder as this hub's, so another hub asks before taking it; the next hub on this
    // port adopts the daemon from it (token, build). Written at once: a hub restarting while this
    // daemon still starts must leave its successor a way to find it. A failed start clears it.
    writeHubLock(folder, {
      hubPid: process.pid,
      hubPort: this.options.port,
      daemonPid: child.pid ?? 0,
      daemonPort: childPort,
      since: session.startedAt,
      token,
      daemonBuild: this.options.daemonBuild ?? "dist",
    });
    // Its exit clears the lock and the session; its /status feeds the app (Studio, last sync)
    this.watchSession(session);
    this.log(`Started the daemon for ${name ?? placeId} in ${folder} (pid ${child.pid}, port ${childPort})`);
    return session;
  }
}

/** Where a Studio (or this hub's relay) reaches a session's daemon; only this machine, with the token */
function daemonUrl(session: Session, pathname = "/"): string {
  return `ws://127.0.0.1:${session.childPort}${pathname}?token=${session.token}`;
}

/** One request to a daemon's hub API, JSON both ways; rejects on any status but 200 */
function daemonRequest<T = unknown>(port: number, token: string, method: "GET" | "POST", pathname: string, body?: unknown, timeoutMs = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        timeout: timeoutMs,
        headers: { "x-quack-token": token, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        // A daemon that dies mid-answer must fail this request, never the hub
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("daemon hung up mid-answer")));
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            // The daemon's own reason, when it gave one (a refused `quackdev play` says why)
            let why: unknown;
            try {
              why = JSON.parse(text)?.error;
            } catch {
              // not JSON
            }
            return reject(new ApiError(res.statusCode === 409 ? 409 : 502, typeof why === "string" ? why : `daemon answered ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new Error("daemon answered something other than JSON"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("daemon did not answer")));
    req.on("error", reject);
    req.end(payload);
  });
}

/** Pings and pongs are small: only those are parsed, a snapshot never is */
function isActivity(data: RawData): boolean {
  if (rawLength(data) > 256) return true;
  try {
    const type = JSON.parse(data.toString())?.type;
    return type !== "ping" && type !== "pong";
  } catch {
    return true;
  }
}

function rawLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  return (data as Buffer | ArrayBuffer).byteLength;
}

/** Send, or cut both ends if the receiver has stopped reading and too much is queued */
function sendBounded(to: WebSocket, data: RawData, from: WebSocket): void {
  if (to.readyState !== WebSocket.OPEN) return;
  if (to.bufferedAmount > MAX_QUEUED_BYTES) {
    to.terminate();
    from.terminate();
    return;
  }
  to.send(data, { binary: false });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, timeoutMs: number, child: ChildProcess, cancelled: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (cancelled()) {
        reject(new Error("daemon failed to spawn"));
        return;
      }
      if (child.exitCode !== null) {
        reject(new Error(`daemon exited with code ${child.exitCode}`));
        return;
      }
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`no answer on port ${port} after ${timeoutMs} ms`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}
