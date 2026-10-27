import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as http from "http";
import { IPCServer } from "./ipc/server.js";
import { TreeManager, TreeNode } from "./fs/treeManager.js";
import { FileWriter } from "./fs/fileWriter.js";
import { FileWatcher } from "./fs/watcher.js";
import { fillSnapshotPaths, type SnapshotInstance } from "./fs/snapshotPaths.js";
import { SourcemapGenerator } from "./sourcemap/generator.js";
import {
  classifyScriptFileName,
  diskText,
  isInitScriptFileName,
  isScriptFileName,
  normalizeLuaLikeFileName,
} from "./util/scriptFile.js";
import { log } from "./util/log.js";
import { config, initializeConfig } from "./config.js";
import {
  mergeScripts,
  defaultTools as defaultMergeTools,
  type MergeTools,
} from "./merge/merge.js";
import type { InstanceData, StudioMessage, PlayOverlayResultMessage, PlayCheck } from "./ipc/messages.js";
import { computePlayOverlay, worktreeOf, type PlayOverlay } from "./play/overlay.js";
import {
  StudioOutputFormatter,
  isStudioOutputMessage,
} from "./studioOutput.js";
import { BUNDLED, BUNDLED_BUILD } from "./bundled.js";
import { HubLink, readHubLink } from "./hubLink.js";
import { clearHubLock } from "./hub/owners.js";

/** Quack: a `quackdev play`, from the swap request to the play session's check */
export interface PlayState {
  id: string;
  worktree: string;
  startedAt: number;
  /** The swap is over (restored or failed); `verify` may still arrive from the play session */
  done: boolean;
  patches: number;
  creates: number;
  disables: number;
  skipped: string[];
  /** Scripts the branch changed that Studio holds changed by someone else (the play runs the branch's) */
  conflicts: string[];
  /** Checks the play session runs: one per script the play carries */
  checks: number;
  result?: { ok: boolean; error?: string; windowMs?: number; applied?: number; failed?: string[] };
  verify?: { ok: boolean; passed: number; failed: string[]; unverified: string[]; at: number };
}

// Window for coalescing sourcemap writes and empty-directory cleanup
const COALESCE_DELAY_MS = 150;
// A successor's slow work after a takeover (inodes, orphan check, sourcemap) waits this long, so
// the Studio it is taking over reconnects and resumes first
const TAKEOVER_BACKGROUND_DELAY_MS = 3000;

/**
 * Quack: the instances Studio never lets the sync delete, as the plugin's
 * QuackService.isProtectedRobloxContainer decides: a service (a child of the DataModel that is
 * not a plain Folder or Model), and StarterPlayer's locked children, by class
 */
function isProtectedContainer(node: TreeNode): boolean {
  if (node.path.length === 1) return node.className !== "Folder" && node.className !== "Model";
  return (
    node.path.length === 2 &&
    node.path[0] === "StarterPlayer" &&
    (node.className === "StarterPlayerScripts" || node.className === "StarterCharacterScripts" || node.className === "StarterGear")
  );
}

function readFileIfExists(filePath: string): string | undefined {
  try {
    return diskText(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Quack: merge records live in .quack/ at the project root, next to the sourcemap (gitignore it) */
function quackDir(): string {
  return path.join(path.dirname(path.resolve(config.sourcemapPath)), ".quack");
}

/** A disk version a merge could not keep, saved so the agent's work is never lost */
function saveConflictCopy(relativePath: string, text: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Random tail: two copies in the same millisecond (a failed merge saves two) must not collide
  const target = path.join(quackDir(), "conflicts", `${relativePath}.${stamp}-${randomBytes(3).toString("hex")}.luau`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf-8");
  return path.relative(path.dirname(quackDir()), target).split(path.sep).join("/");
}

function appendMergeLog(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(quackDir(), { recursive: true });
    fs.appendFileSync(path.join(quackDir(), "merge-log.jsonl"), JSON.stringify(entry) + "\n");
  } catch (error) {
    log.warn("Could not write .quack/merge-log.jsonl:", error);
  }
}

/**
 * The place a folder was last synced with, from the `_quack.placeId` stamp the
 * sourcemap writer appends last. Reads only the tail: a big game's sourcemap is 10+ MB.
 */
export function readStampedPlaceId(sourcemapPath: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(sourcemapPath, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 4096);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const match = /"_(?:quack|azul)"\s*:\s*\{[^}]*"placeId"\s*:\s*(\d+)/.exec(
      buffer.toString("utf8"),
    );
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Main orchestrator for the Quack daemon
 */
export class SyncDaemon {
  private ipc: IPCServer;
  private httpServer: http.Server;
  private tree: TreeManager;
  private fileWriter: FileWriter;
  private fileWatcher: FileWatcher;
  // Quack: merges in flight, one per script. `dirty` = a newer side arrived; merge again.
  private merges: Map<string, { studio: string; dirty: boolean }> = new Map();
  // Quack: the connected Studio has the wrong place; its changes are ignored
  private snapshotRefused = false;
  /** Test hook: the merge tools (git, luau-lsp, claude) */
  public mergeTools: MergeTools = defaultMergeTools;
  /** Test hook: resolves when the merge of a script finishes */
  public onMergeDone?: (guid: string, entry: Record<string, unknown>) => void;
  private sourcemapGenerator: SourcemapGenerator;
  private studioOutputFormatter: StudioOutputFormatter;
  // Pending coalesced sourcemap write; see scheduleSourcemapWrite()
  private sourcemapTimer: NodeJS.Timeout | null = null;
  // Pending coalesced directory cleanup; see scheduleCleanup()
  private cleanupTimer: NodeJS.Timeout | null = null;
  private stopPromise: Promise<void> | null = null;
  private hubLink?: HubLink;
  /** A successor built from its predecessor's tree, waiting for takeOver */
  private standby = false;
  /** A sourcemap write was pending when this daemon handed over: its successor writes it */
  private sourcemapOwed = false;
  /** The slower work after a takeover, cancelled if this daemon hands over or stops first */
  private afterTakeoverTimer: NodeJS.Timeout | null = null;
  /** Quack: the last `quackdev play`, read by the hub's /api/play */
  private play: PlayState | null = null;
  private playResolve: ((result: PlayOverlayResultMessage) => void) | null = null;
  /** Handed its place to a successor: disk events are no longer this daemon's */
  private handedOff = false;
  /** Disk events seen while on standby, settled at the takeover */
  private standbyEvents: { event: string; filePath: string }[] = [];
  /** The last full sync, for the hub's /status */
  private lastSync?: { scripts: number; instances: number; at: number; placeId?: number; session?: string };

  // Buffers a deletion briefly so a matching filesystem creation can become a
  // move instead of a destroy+recreate (Roblox's Destroy() cascades, so a
  // recreate would permanently lose non-script descendants like Parts).
  // Keyed by inode: stable across rename/move, immune to event-ordering races.
  // Falls back to a guid key when the inode is unknown.
  private pendingInstanceDeletes = new Map<
    string,
    { guid: string; oldSegments: string[]; timer: NodeJS.Timeout }
  >();
  private guidToInode = new Map<string, string>();
  // A script file sent to Studio as a create, until Studio's answer maps it. The file is mapped
  // only from that answer: a create answered while the plugin held its sending off (a play swap
  // of another session) made the script in Studio and never mapped it (Astral, 27/10/26). The
  // plugin reuses a same-named script of the same class, so sending the create again makes
  // no second instance.
  private unansweredCreates = new Map<string, { attempt: number; timer?: NodeJS.Timeout }>();
  static createAnswerMs = 3000;
  private static readonly CREATE_ATTEMPTS = 3;
  private readonly moveWindowMs = Math.max(500, config.fileWatchDebounce * 5);

  constructor() {
    this.tree = new TreeManager();
    this.fileWriter = new FileWriter(config.syncDir);
    this.fileWatcher = new FileWatcher();
    this.sourcemapGenerator = new SourcemapGenerator();
    this.studioOutputFormatter = new StudioOutputFormatter(
      config.sourcemapPath,
    );

    // Suppress watcher echoes for filesystem mutations the daemon performs
    // itself, so its own writes/deletes aren't mistaken for user actions.
    this.fileWriter.setEventSuppressor((filePath, event) => {
      this.fileWatcher.suppressNextEvent(filePath, event);
    });

    // Started by a hub: it answers the hub's /status, /adopt, /kick and /shutdown, and lets in
    // only what carries the hub's token
    const link = readHubLink();
    this.hubLink = link
      ? new HubLink(link, {
          status: () => ({
            pid: process.pid,
            folder: process.cwd(),
            build: BUNDLED_BUILD ?? "dist",
            standby: this.standby,
            hubPid: this.hubLink!.hubPid,
            studio: this.ipc.studioLink(),
            scripts: this.lastSync?.scripts,
            instances: this.lastSync?.instances,
            syncedAt: this.lastSync?.at ?? null,
            placeId: this.lastSync?.placeId,
          }),
          kick: (why) => this.ipc.kick(why),
          shutdown: () => void this.shutdownForHub(),
          export: (request) => this.exportForSuccessor(request),
          takeOver: async (request) => this.takeOver(request),
          play: (request) => this.startPlay(request.worktree),
          playState: () => this.play,
          unsynced: (fix) => {
            const files = this.unsyncedScripts();
            if (fix) this.createAgain(files);
            return files;
          },
        }, (line) => log.info(line))
      : undefined;

    // HTTP server is used for WebSocket upgrade handling.
    this.httpServer = http.createServer((req, res) => {
      if (this.hubLink?.handle(req, res)) return;
      res.writeHead(404);
      res.end("Not found");
    });

    this.ipc = new IPCServer(config.port, this.httpServer, {
      requestSnapshotOnConnect: false,
      verifyClient: this.hubLink ? (req) => this.hubLink!.allows(req) : undefined,
    });

    this.setupHandlers();
    // A successor of a daemon that ran older code starts from its tree, before it takes any
    // connection: the Studio resumes here without a snapshot of the whole place
    // On standby (QUACK_HUB_STANDBY=1) it only builds itself, while the previous one still syncs
    const seed = this.hubLink ? process.env.QUACK_HUB_SEED : undefined;
    if (seed && process.env.QUACK_HUB_STANDBY === "1") this.applySeedStandby(seed);
    else if (seed) this.applySeed(seed);
    // A hub's daemon is reached only through 127.0.0.1, with the token
    if (this.hubLink) this.httpServer.listen(config.port, "127.0.0.1");
    else this.httpServer.listen(config.port);
    this.hubLink?.watch();
  }

  /**
   * Hands this place to a successor (new daemon code), in one of three ways:
   * - "single": the Studio is let go, the watcher stops, the tree goes to a file the successor
   *   starts from, and this daemon stops. The Studio waits through the successor's whole start.
   * - "prepare": the tree goes to a file while this daemon keeps syncing, and every change from
   *   then on is noted. The successor builds itself from it on standby.
   * - "final": the Studio is sent to the successor (`successorUrl`), the watcher stops, and only
   *   what changed since "prepare" goes to a file; this daemon then stops. The Studio waits only
   *   for the successor to apply that.
   */
  private async exportForSuccessor(request: { phase?: string; successorUrl?: string }): Promise<{ file: string; session?: string }> {
    const phase = request.phase === "prepare" || request.phase === "final" ? request.phase : "single";
    // A refused place has no session to resume
    const session = this.snapshotRefused ? undefined : this.lastSync?.session;
    const file = path.join(process.cwd(), ".quack", `handoff-${process.pid}-${phase}.json`);

    if (phase === "prepare") {
      this.tree.startJournal();
      const t0 = performance.now();
      const data = this.treeAsSnapshot();
      const t1 = performance.now();
      const json = JSON.stringify({ session, placeId: this.lastSync?.placeId, data, missed: this.ipc.missed() });
      const t2 = performance.now();
      fs.writeFileSync(file, json);
      const t3 = performance.now();
      log.info(`Prepared ${data.length} instances for the next daemon; still syncing (tree ${Math.round(t1 - t0)} ms, json ${Math.round(t2 - t1)} ms, write ${Math.round(t3 - t2)} ms, ${(json.length / 1e6).toFixed(1)} MB)`);
      return { file, session };
    }

    // Disk deletes still waiting to see whether they were moves would land after the handoff,
    // seen by neither daemon: applied now, while the Studio is still here to receive them
    for (const [key, pending] of [...this.pendingInstanceDeletes]) {
      clearTimeout(pending.timer);
      this.flushPendingDelete(key, pending.guid, pending.oldSegments);
    }
    if (phase === "final" && typeof request.successorUrl === "string" && /^ws:\/\/127\.0\.0\.1:\d+\//.test(request.successorUrl)) {
      this.ipc.redirectAndDrop(request.successorUrl);
      // The successor writes it instead: this one leaving need not spend ~0.5 s on it
      if (this.sourcemapTimer) {
        clearTimeout(this.sourcemapTimer);
        this.sourcemapTimer = null;
        this.sourcemapOwed = true;
      }
    } else {
      this.ipc.dropClient();
    }
    // From here on this daemon ignores the disk, and a file changed there is newer than anything
    // it knew (the successor reads those by date). Stopping the watcher itself took ~0.35 s with
    // the Studio waiting (measured 21/10/26): it stops later, as this daemon shuts down.
    this.handedOff = true;
    if (this.afterTakeoverTimer) clearTimeout(this.afterTakeoverTimer);
    const stoppedAt = Date.now();
    if (phase !== "final") await this.fileWatcher.stop();

    if (phase === "final") {
      const journal = this.tree.takeJournal();
      const changes = journal === "all" ? null : [...(journal ?? [])].map((guid) => {
        const node = this.tree.getNode(guid);
        return node
          ? { guid, className: node.className, name: node.name, parentGuid: node.parentGuid ?? "root", path: node.path, ...(node.source !== undefined ? { source: node.source } : {}) }
          : { guid, deleted: true };
      });
      // A whole new snapshot came in meanwhile: the successor takes the whole tree again
      const data = changes === null ? this.treeAsSnapshot() : undefined;
      fs.writeFileSync(file, JSON.stringify({ session, stoppedAt, changes, data, missed: this.ipc.missed(), sourcemapOwed: this.sourcemapOwed }));
      log.info(`Handed ${changes === null ? `${data!.length} instances` : `${changes.length} change(s)`} to the next daemon`);
      return { file, session };
    }

    const data = this.treeAsSnapshot();
    // What Studio has not received yet goes along, for the successor to send once it resumes
    fs.writeFileSync(file, JSON.stringify({ session, placeId: this.lastSync?.placeId, data, missed: this.ipc.missed() }));
    log.info(`Handed ${data.length} instances to the next daemon`);
    return { file, session };
  }

  /** The tree as a snapshot, paths included (the successor need not rebuild them) */
  private treeAsSnapshot(): SnapshotInstance[] {
    const data: SnapshotInstance[] = [];
    for (const node of this.tree.getAllNodes().values()) {
      if (node.guid === "root") continue;
      data.push({
        guid: node.guid,
        className: node.className,
        name: node.name,
        parentGuid: node.parentGuid ?? "root",
        path: node.path,
        ...(node.source !== undefined ? { source: node.source } : {}),
      } as SnapshotInstance);
    }
    return data;
  }

  private readSeed(file: string): {
    session?: string;
    placeId?: number;
    data: SnapshotInstance[];
    missed?: { patches: [string, string][]; structure: boolean };
  } | undefined {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      log.warn(`Could not start from the previous daemon's tree; the Studio sends a snapshot: ${(error as Error).message}`);
      return undefined;
    } finally {
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        // A seed left behind is harmless; a daemon that does not start is not
        log.warn(`Could not remove ${file}: ${(error as Error).message}`);
      }
    }
  }

  private applySeed(file: string): void {
    const seed = this.readSeed(file);
    if (!seed) return;
    log.info(`Starting from the previous daemon's tree (${seed.data.length} instances)`);
    // Owed before: an edit it inherits from the tree is overridden by the disk's below
    if (seed.missed) this.ipc.addMissed(seed.missed.patches, seed.missed.structure);
    this.handleFullSnapshot(seed.data, seed.placeId, seed.session, true);
  }

  /**
   * A successor on standby: the tree and where each script lives, built while the previous daemon
   * still syncs. No disk write, no watcher, and no Studio handshake until takeOver.
   */
  private applySeedStandby(file: string): void {
    const seed = this.readSeed(file);
    if (!seed) return;
    log.info(`Building from the previous daemon's tree on standby (${seed.data.length} instances)`);
    const { filled } = fillSnapshotPaths(seed.data);
    this.sourcemapGenerator.setPlaceId(seed.placeId);
    this.tree.applyFullSnapshot(filled);
    this.fileWriter.writeTree(this.tree.getAllNodes(), { mapOnly: true });
    const stats = this.tree.getStats();
    this.lastSync = { scripts: stats.scriptNodes, instances: stats.totalNodes, at: Date.now(), placeId: seed.placeId, session: seed.session };
    if (seed.missed) this.ipc.setMissed(seed.missed.patches, seed.missed.structure);
    this.standby = true;
    // Watching from now, only noting: at the takeover the noted paths are the only disk work, and
    // the watcher is already up (scanning every script and starting it cost ~0.2 s of the switch)
    this.fileWatcher.watch(this.fileWriter.getBaseDir());
    this.ipc.holdHandshakes();
    log.info("Standing by for the previous daemon's last changes");
  }

  /**
   * The previous daemon has let go: apply what changed since it prepared, keep any script edited
   * on disk after its watcher stopped (the disk wins, Studio receives it), start watching, and
   * let the waiting Studio resume. Slower work (inodes, orphan check, sourcemap) comes after.
   */
  private takeOver(request: { file?: string }): { applied: number } {
    if (!this.standby) throw new Error("not on standby");
    // Each part of the switch the Studio waits for, in the log
    const began = performance.now();
    const timing: string[] = [];
    let mark = began;
    const lap = (what: string) => {
      const now = performance.now();
      timing.push(`${what} ${Math.round(now - mark)}`);
      mark = now;
    };
    let delta: {
      session?: string;
      stoppedAt?: number;
      changes?: ({ guid: string; deleted: true } | (InstanceData & { deleted?: undefined }))[] | null;
      data?: SnapshotInstance[];
      missed?: { patches: [string, string][]; structure: boolean };
      /** The previous daemon left a sourcemap write pending: this one writes it */
      sourcemapOwed?: boolean;
    } = {};
    if (typeof request.file === "string") {
      try {
        delta = JSON.parse(fs.readFileSync(request.file, "utf8"));
      } catch (error) {
        log.warn(`Could not read the previous daemon's last changes: ${(error as Error).message}`);
        delta = {};
      }
      try {
        fs.rmSync(request.file, { force: true });
      } catch {
        // left behind, harmless
      }
    }
    // No last word from the previous daemon (it failed, or its file could not be read): what
    // changed during the standby is unknown, so the Studio sends its whole place, not a resume
    const lastWordLost = delta.changes === undefined && delta.data === undefined;
    lap("read changes");

    // Scripts whose disk text differs from the tree's: the disk wins and Studio receives it
    const editedOnDisk = new Map<string, string>();
    let structural = 0;
    let applied = 0;
    // What the previous daemon still owed Studio, first: the disk edits found below are newer and
    // must not be replaced by it (a whole-snapshot apply queues its own, too)
    if (delta.missed) this.ipc.setMissed(delta.missed.patches, delta.missed.structure);
    if (delta.data) {
      // A whole new snapshot reached the previous daemon meanwhile (its writes keep the disk's)
      this.standby = false;
      this.standbyEvents = [];
      this.handleFullSnapshot(delta.data, this.lastSync?.placeId, delta.session, true);
      applied = delta.data.length;
    } else {
      // This daemon's watcher has run since the standby began, only noting what changed: those
      // paths are all the disk work the switch needs (no scan, no watcher to start)
      const noted = new Set(this.standbyEvents.map((e) => path.resolve(e.filePath)));
      const readFile = (filePath: string) => {
        try {
          return diskText(fs.readFileSync(filePath, "utf8"));
        } catch {
          return undefined;
        }
      };
      for (const change of delta.changes ?? []) {
        if (change.deleted) {
          this.handleDeleted({ guid: change.guid });
        } else {
          // A script saved on disk after the previous daemon stopped looking keeps its text
          let disk: string | undefined;
          if (change.source !== undefined && this.isScriptClass(change.className)) {
            const target = path.resolve(this.fileWriter.getFilePath({ ...change, children: new Map() } as TreeNode));
            if (noted.has(target)) disk = readFile(target);
          }
          if (disk !== undefined && disk !== change.source) {
            editedOnDisk.set(change.guid, disk);
            this.handleInstanceUpdated({ ...change, source: disk });
          } else {
            this.handleInstanceUpdated(change);
          }
        }
        applied++;
      }
      lap("apply");
      this.standby = false;
      const events = this.standbyEvents;
      this.standbyEvents = [];
      const mappedUnder = (dir: string) => {
        const prefix = path.resolve(dir) + path.sep;
        for (const mapping of this.fileWriter.getAllMappings().values()) if (path.resolve(mapping.filePath).startsWith(prefix)) return true;
        return false;
      };
      for (const { event, filePath } of events) {
        const guid = this.fileWriter.getGuidByPath(filePath);
        if (event === "change" || event === "add") {
          const text = readFile(filePath);
          if (text === undefined) continue;
          if (!guid) {
            // A file no tree node owns: created on disk during the handoff
            structural++;
            continue;
          }
          const node = this.tree.getNode(guid);
          if (node && node.source !== text) {
            this.tree.updateScriptSource(guid, text);
            editedOnDisk.set(guid, text);
          }
        } else if (event === "unlink") {
          // Still mapped and gone: removed (or moved) on disk, not by the previous daemon
          if (guid && !fs.existsSync(filePath)) structural++;
        } else if (event === "unlinkDir") {
          if (!fs.existsSync(filePath) && mappedUnder(filePath)) structural++;
        } else if (event === "addDir") {
          // A folder with no script of the tree in it: made on disk during the handoff
          // Read once, guarded: a folder removed again meanwhile must not abort the takeover (the
          // Studio's handshake would wait forever)
          let empty = false;
          try {
            empty = fs.readdirSync(filePath).length === 0;
          } catch {
            empty = false;
          }
          if (empty && !mappedUnder(filePath)) structural++;
        }
      }
      lap("disk check");
    }
    if (editedOnDisk.size > 0) {
      log.info(`${editedOnDisk.size} script(s) saved on disk during the handoff; Studio receives them`);
      this.ipc.addMissed(editedOnDisk);
    }
    // Created, deleted or moved on disk during the handoff, or the last word lost: the Studio
    // sends its whole place instead of resuming
    if (structural > 0 || lastWordLost) {
      log.info(lastWordLost ? "The previous daemon's last changes are unknown; Studio sends a snapshot" : `${structural} file change(s) on disk during the handoff create, delete or move something; Studio sends a snapshot`);
      this.ipc.addMissed([], true);
    }
    if (delta.session !== undefined && this.lastSync) this.lastSync.session = delta.session;

    this.standby = false;
    this.ipc.releaseHandshakes();
    log.success(`Took over (${applied} change(s) since the standby started) in ${Math.round(performance.now() - began)} ms (${timing.join(", ")})`);

    // After the Studio is back: what the switch did not need to wait for. Not at once: it holds
    // the process ~0.7 s, and right after the takeover is when the Studio connects and handshakes
    // (that cost 0.7 s of the switch, measured 21/10/26)
    // The sourcemap only if the previous daemon left one unwritten: the tree is the same, its
    // sourcemap is on disk, and a structural change in the delta schedules its own. Rebuilding
    // it here anyway held the daemon ~0.5 s and delayed an edit by ~0.9 s (21/10/26).
    const sourcemapOwed = delta.sourcemapOwed === true || delta.data !== undefined;
    // Held by this daemon until written: a handoff before the timer below passes it on
    this.sourcemapOwed = sourcemapOwed;
    this.afterTakeoverTimer = setTimeout(() => {
      this.afterTakeoverTimer = null;
      // Handed over again within these seconds: the folder is the next daemon's now
      if (this.handedOff) return;
      const t0 = performance.now();
      this.recordInodes();
      const t1 = performance.now();
      if (this.cleanupOrphanFiles(true) > 0) {
        this.ipc.addMissed([], true);
        // Files appeared that the tree does not know: Studio sends its whole place
        if (this.ipc.isConnected()) this.ipc.requestSnapshot({ omitPaths: true });
      }
      const t2 = performance.now();
      if (sourcemapOwed) {
        this.regenerateSourcemap();
        this.sourcemapOwed = false;
      }
      log.info(`After the takeover: inodes ${Math.round(t1 - t0)} ms, orphan check ${Math.round(t2 - t1)} ms${sourcemapOwed ? `, sourcemap ${Math.round(performance.now() - t2)} ms` : ""}`);
    }, TAKEOVER_BACKGROUND_DELAY_MS);
    return { applied };
  }

  /** Stopped by its hub, or orphaned for good: the folder is left free for the next one */
  private async shutdownForHub(): Promise<void> {
    this.hubLink?.stop();
    try {
      await this.stop();
    } finally {
      clearHubLock(process.cwd(), process.pid);
      process.exit(0);
    }
  }

  /**
   * Set up all event handlers
   */
  private setupHandlers(): void {
    // Handle messages from Studio (WebSocket)
    this.ipc.onMessage((message) => this.handleStudioMessage(message));
    this.ipc.onHandshake((info) => {
      // The same plugin session this tree came from, and it kept tracking through the drop:
      // what changed meanwhile arrives as ordinary changes, no snapshot of the whole place
      // Nor did the disk create, delete or move anything Studio missed (that needs a snapshot)
      if (info.resume && info.session && !this.snapshotRefused && this.lastSync?.session === info.session && this.ipc.canResume()) {
        log.info("Studio resumed its session: no snapshot needed");
        return true;
      }
      // Paths rebuilt here from each parent's: a smaller snapshot to send, encode and parse
      this.ipc.requestSnapshot({ omitPaths: true });
      return false;
    });

    // Handle file & directory events from filesystem
    this.fileWatcher.onEvent((event, filePath, source) => {
      // Handed to a successor: the disk is its to read now
      if (this.handedOff) return;
      // On standby the previous daemon still owns the disk: noted, settled at the takeover
      if (this.standby) {
        this.standbyEvents.push({ event, filePath });
        return;
      }
      switch (event) {
        case "change":
          this.handleFileChange(filePath, source ?? "");
          break;
        case "add":
          this.handleFileAdd(filePath, source ?? "");
          break;
        case "unlink":
          this.handleFileDelete(filePath);
          break;
        case "addDir":
          this.handleDirAdd(filePath);
          break;
        case "unlinkDir":
          this.handleDirDelete(filePath);
          break;
      }
    });
  }

  /**
   * Handle incoming messages from Studio
   */
  private handleStudioMessage(message: StudioMessage, insideBatch = false): void {
    if (message.type === "batch") {
      // The plugin never nests batches; one inside another is refused, not recursed into
      if (insideBatch) {
        log.warn("Ignored a batch nested inside another batch");
        return;
      }
      for (const payload of message.messages) {
        this.handleStudioMessage(payload, true);
      }
      return;
    }

    // Quack: after a refused snapshot (wrong place), nothing from that Studio may touch the
    // folder until a snapshot of the right place is accepted; batch entries included.
    if (
      this.snapshotRefused &&
      message.type !== "fullSnapshot" &&
      message.type !== "ping" &&
      message.type !== "clientDisconnect"
    ) {
      log.debug(`Ignored ${message.type} from a Studio whose place was refused`);
      return;
    }

    switch (message.type) {
      case "fullSnapshot":
        this.handleFullSnapshot(message.data, message.placeId);
        break;

      case "scriptChanged":
        this.handleScriptChanged(message.data);
        break;

      case "instanceUpdated":
        this.handleInstanceUpdated(message.data);
        break;

      case "deleted":
        this.handleDeleted(message.data);
        break;

      case "studioOutput":
        // Also reachable from the main Studio route, so validate like /studio-output does
        if (isStudioOutputMessage(message)) {
          const line = this.studioOutputFormatter.format(message);
          if (line !== null) console.log(line);
        }
        break;

      case "ping":
        this.ipc.send({ type: "pong" });
        break;

      case "playOverlayResult":
        if (this.play && message.id === this.play.id) this.playResolve?.(message);
        break;

      case "playVerify":
        if (this.play && message.id === this.play.id) {
          const unverified = Array.isArray(message.unverified) ? message.unverified.slice(0, 50).map(String) : [];
          this.play.verify = { ok: message.ok, passed: message.passed, failed: message.failed.slice(0, 50).map(String), unverified, at: Date.now() };
          if (message.ok) log.success(`Play of ${this.play.worktree}: the play session has the branch (${message.passed} checked${unverified.length ? `, ${message.unverified!.length} removed by the game before the check` : ""})`);
          else log.error(`Play of ${this.play.worktree}: the play session does NOT have the branch: ${message.failed.slice(0, 5).join("; ")}`);
        }
        break;

      case "clientDisconnect":
        // Quack stays up: closing a place (the plugin unloading sends this) used to end the
        // daemon, which broke auto-connect for the next Studio. It waits for the next one.
        log.info("Studio stopped syncing; Quack keeps running and waits for the next connection");
        break;

      default:
        log.warn("Unknown message type:", (message as any).type);
    }
  }

  /**
   * Handle full snapshot from Studio
   */
  private handleFullSnapshot(snapshot: SnapshotInstance[], placeId?: number, session = this.ipc.studioLink().session, fromSeed = false): void {
    log.info(fromSeed ? "Applying the previous daemon's tree" : "Received full snapshot from Studio");
    const { filled: data, dropped } = fillSnapshotPaths(snapshot);
    if (dropped > 0) log.warn(`${dropped} instance(s) of the snapshot had no parent in it and were left out`);

    // Quack: a snapshot rewrites the folder and deletes orphans, so the wrong place connecting
    // (another Studio window, auto-connect) would wipe this project's files. Refuse it.
    // A stamped folder accepts only its own place: an unsaved place (id 0) or one with no id
    // is refused too, since "File > New" with auto-connect would otherwise wipe the project.
    const stampedPlaceId = readStampedPlaceId(config.sourcemapPath);
    if (stampedPlaceId && stampedPlaceId !== placeId) {
      const opened = placeId && placeId > 0 ? `place ${placeId}` : "an unsaved place";
      const message = `This folder syncs place ${stampedPlaceId}, but the Studio that connected has ${opened} open. Refused before writing anything.`;
      log.error(message);
      this.snapshotRefused = true;
      this.ipc.sendError(message);
      this.ipc.send({ type: "daemonDisconnect" });
      return;
    }
    this.snapshotRefused = false;

    // Stamp every later sourcemap write with the place, for 'quack open-studio'
    this.sourcemapGenerator.setPlaceId(placeId);

    // Update tree
    this.tree.applyFullSnapshot(data);

    // Write all scripts to filesystem. Studio's snapshot is the truth; the previous daemon's tree
    // is not: a script edited on disk since it was taken keeps the edit, and Studio receives it
    if (fromSeed) {
      const edited = this.fileWriter.writeTree(this.tree.getAllNodes(), { preferDisk: true });
      this.ipc.addMissed(edited.map((e) => [e.guid, e.source] as [string, string]));
    } else {
      this.fileWriter.writeTree(this.tree.getAllNodes());
      this.ipc.clearMissed();
    }

    // Record inodes so a later filesystem rename/move can be recognized as a
    // move (preserving non-script descendants) rather than a destroy + rebuild.
    this.recordInodes();

    // Remove any pre-existing files that are no longer mapped (optional). Not from the previous
    // daemon's tree: such a file was created during the handoff; it stays, and Studio sends a
    // snapshot instead of resuming
    if (fromSeed) {
      if (this.cleanupOrphanFiles(true) > 0) this.ipc.addMissed([], true);
    } else {
      this.cleanupOrphanFiles();
    }

    // Start file watching
    this.fileWatcher.watch(this.fileWriter.getBaseDir());

    // Generate sourcemap. A successor's comes once its Studio has resumed: the previous daemon's
    // sourcemap, for the same tree, stands meanwhile, and this is ~0.6 s on a 261k-instance place
    // that the Studio would otherwise wait for (measured 21/10/26)
    if (fromSeed) {
      if (this.sourcemapTimer) clearTimeout(this.sourcemapTimer);
      this.sourcemapTimer = setTimeout(() => this.regenerateSourcemap(), 1500);
    } else {
      this.regenerateSourcemap();
    }

    // Log statistics
    const stats = this.tree.getStats();
    this.lastSync = { scripts: stats.scriptNodes, instances: stats.totalNodes, at: Date.now(), placeId, session };
    log.success(
      `Sync complete: ${stats.scriptNodes} scripts, ${stats.totalNodes} total nodes`,
    );
  }

  /**
   * Handle script source change
   */
  private handleScriptChanged(message: {
    guid: string;
    source: string;
    path: string[];
    className: string;
    base?: string;
  }): void {
    const { guid, source, path: instancePath, className } = message;

    // Quack: a merge for this script is running; it picks up this newer Studio text when done
    const running = this.merges.get(guid);
    if (running) {
      running.studio = source;
      running.dirty = true;
      return;
    }

    // Quack: Studio edited from `base`, but the disk moved away from it meanwhile (an agent
    // saved). Both edits are real: merge them instead of letting the last write win.
    if (config.merge.enabled && message.base !== undefined) {
      const existing = this.tree.getNode(guid);
      if (existing) {
        const filePath = this.fileWriter.getFilePath(existing);
        const disk = readFileIfExists(filePath);
        if (disk !== undefined && disk !== message.base && disk !== source) {
          if (source === message.base) {
            // Studio has no net change (edited and reverted): the disk edit stands
            this.tree.updateScriptSource(guid, disk);
            this.ipc.patchScript(guid, disk);
            return;
          }
          this.startMerge(guid, message.base, disk, source);
          return;
        }
      }
    }

    // Update tree
    this.tree.updateScriptSource(guid, source);

    // Get or create node
    let node = this.tree.getNode(guid);
    if (!node) {
      // Create new node if it doesn't exist
      this.tree.updateInstance({
        guid,
        className,
        name: instancePath[instancePath.length - 1],
        path: instancePath,
        source,
      });
      node = this.tree.getNode(guid);
    }

    if (node) {
      // Precompute path and suppress watcher before writing to avoid race conditions
      const filePath = this.fileWriter.getFilePath(node);
      this.fileWatcher.suppressNextChange(filePath, source);

      // Write to filesystem
      const mappedBefore = this.fileWriter.getMapping(node.guid)?.filePath;
      this.fileWriter.writeScript(node);

      // The sourcemap holds names, classes and files, never text: only a script first seen here
      // (or now at another file) changes it. Regenerating it on every edit held the daemon
      // ~0.5 s per save on a 262k-instance place, which delayed the next edits (21/10/26).
      if (mappedBefore !== this.fileWriter.getMapping(node.guid)?.filePath) this.scheduleSourcemapWrite();
    }
  }

  /**
   * Quack: merge a Studio edit and a disk edit that raced, then give both sides the result.
   * Studio keeps showing the human's text until the merge lands; nothing is overwritten first.
   * The file path is read from the tree at every step, so a rename mid-merge is followed.
   */
  private startMerge(guid: string, base: string, disk: string, studio: string): void {
    const entry = { studio, dirty: false };
    this.merges.set(guid, entry);
    const currentPath = (): string | undefined => {
      const node = this.tree.getNode(guid);
      return node ? this.fileWriter.getFilePath(node) : undefined;
    };
    const relativeOf = (filePath: string) =>
      path.relative(this.fileWriter.getBaseDir(), filePath).split(path.sep).join("/");
    log.info(`Merge started: ${relativeOf(currentPath() ?? "")} (Studio and disk both changed it)`);

    // The agent's text of the latest attempt, so a failure can always save it
    let lastDisk = disk;

    const run = async (diskText: string): Promise<void> => {
      lastDisk = diskText;
      const studioText = entry.studio;
      entry.dirty = false;
      const result = await mergeScripts(base, diskText, studioText, this.mergeTools);

      const filePath = currentPath();
      if (!filePath) {
        this.merges.delete(guid);
        return;
      }

      // The file is gone or unreadable: never recreate it from the stale merge input
      const diskNow = readFileIfExists(filePath);
      if (diskNow === undefined) {
        this.merges.delete(guid);
        const relative = relativeOf(filePath);
        appendMergeLog({
          t: new Date().toISOString(),
          file: relative,
          method: "aborted",
          note: "the file was deleted or unreadable during the merge; nothing written",
          agentVersion: saveConflictCopy(relative, diskText),
        });
        log.warn(`Merge of ${relative} aborted: the file disappeared during the merge`);
        this.onMergeDone?.(guid, { method: "aborted" });
        return;
      }

      // A side moved while merging (a new save, a newer Studio edit, a rename): merge again
      if (entry.dirty || diskNow !== diskText) {
        await run(diskNow);
        return;
      }

      const relative = relativeOf(filePath);
      const logEntry: Record<string, unknown> = {
        t: new Date().toISOString(),
        file: relative,
        method: result.method,
        conflictingHunks: result.conflictingHunks,
        textMergeErrors: result.textMergeErrors,
        ms: result.ms,
      };
      if (result.aiNote) logEntry.note = result.aiNote;

      // Save the agent's version BEFORE the disk is overwritten: if saving fails, nothing is lost
      if (result.method === "fallback" || result.conflictingHunks > 0) {
        logEntry.agentVersion = saveConflictCopy(relative, diskText);
      }

      const node = this.tree.getNode(guid)!;
      this.tree.updateScriptSource(guid, result.text);
      this.fileWatcher.suppressNextChange(filePath, result.text);
      this.fileWriter.writeScript(node);
      this.ipc.patchScript(guid, result.text);

      if (result.method === "fallback") {
        log.warn(
          `Merge of ${relative} could not be checked clean; Studio's version kept, the disk version saved to ${logEntry.agentVersion}`,
        );
      } else {
        log.success(
          `Merged ${relative} (${result.method === "ai" ? "AI merge" : "text merge"}${result.conflictingHunks ? `, ${result.conflictingHunks} hunk(s) both changed${result.method === "text" ? ": Studio's lines kept" : ""}; the disk version saved` : ""}) in ${result.ms} ms`,
        );
      }
      appendMergeLog(logEntry);
      this.merges.delete(guid);
      this.onMergeDone?.(guid, logEntry);
    };

    run(disk).catch((error) => {
      this.merges.delete(guid);
      // Recovery must not throw out of here: an unhandled rejection would end the daemon
      try {
        const filePath = currentPath();
        const relative = filePath ? relativeOf(filePath) : guid;
        // Back up what the disk holds NOW (an agent may have saved during the merge)
        const diskNow = filePath ? readFileIfExists(filePath) : undefined;
        if (diskNow === undefined) {
          log.error(`Merge of ${relative} failed and its file cannot be read; nothing overwritten:`, error);
          appendMergeLog({ t: new Date().toISOString(), file: relative, method: "error", error: String(error) });
          this.onMergeDone?.(guid, { method: "error", error: String(error) });
          return;
        }
        const saved = saveConflictCopy(relative, diskNow);
        if (diskNow !== lastDisk) saveConflictCopy(relative, lastDisk);
        log.error(
          `Merge of ${relative} failed; Studio's text written to disk, the disk version saved to ${saved}:`,
          error,
        );
        appendMergeLog({
          t: new Date().toISOString(),
          file: relative,
          method: "error",
          error: String(error),
          agentVersion: saved,
        });
        const node = this.tree.getNode(guid);
        if (node && filePath) {
          this.tree.updateScriptSource(guid, entry.studio);
          this.fileWatcher.suppressNextChange(filePath, entry.studio);
          this.fileWriter.writeScript(node);
        }
      } catch (recoveryError) {
        log.error("Merge recovery failed; disk and Studio left as they were:", recoveryError);
      }
      this.onMergeDone?.(guid, { method: "error", error: String(error) });
    });
  }

  /**
   * Handle instance update (rename, move, etc.)
   */
  private handleInstanceUpdated(data: any): void {
    const classBefore = this.tree.getNode(data?.guid)?.className;
    const update = this.tree.updateInstance(data);
    const node = update?.node;

    if (!node) {
      return;
    }

    const scriptsToUpdate: Map<string, TreeNode> = new Map();

    if (this.isScriptClass(node.className)) {
      scriptsToUpdate.set(node.guid, node);
    }

    if (update.pathChanged || update.nameChanged || update.parentChanged) {
      for (const child of this.tree.getDescendantScripts(node.guid)) {
        scriptsToUpdate.set(child.guid, child);
      }
    }

    for (const scriptNode of scriptsToUpdate.values()) {
      // Quack: mid-merge, the tree's text is stale (disk saves wait for the merge). Carry what
      // the disk holds now to the new path; the merge re-reads it there.
      if (this.merges.has(scriptNode.guid)) {
        const oldPath = this.fileWriter.getMapping(scriptNode.guid)?.filePath;
        const onDisk = oldPath ? readFileIfExists(oldPath) : undefined;
        // Gone from disk mid-merge: the tree's text is stale, and writing it would bring the
        // deleted file back; the merge and the watcher settle it
        if (onDisk === undefined) continue;
        this.tree.updateScriptSource(scriptNode.guid, onDisk);
      }
      const filePath = this.fileWriter.getFilePath(scriptNode);
      this.fileWatcher.suppressNextChange(filePath, scriptNode.source);
      this.fileWriter.writeScript(scriptNode);
    }

    // Not for a script whose text alone changed: the sourcemap holds no text, and rebuilding it
    // (~0.5 s on 262k instances) on every edit held the daemon (21/10/26). A class change moves
    // the script to another file name, so it counts.
    const shouldUpdateSourcemap =
      update.isNew ||
      update.pathChanged ||
      update.nameChanged ||
      update.parentChanged ||
      classBefore !== node.className;

    if (shouldUpdateSourcemap) {
      this.scheduleSourcemapWrite();
    }

    // Keep inode tracking current for newly created/moved instances so a later
    // filesystem rename/move can be recognized as a move rather than a
    // destroy + rebuild.
    this.recordInode(node);

    this.scheduleCleanup();
  }

  /**
   * Handle instance deletion
   */
  private handleDeleted(message: { guid: string }): void {
    const { guid } = message;
    const node = this.tree.getNode(guid);

    // If the node is already gone (e.g., child deletes after parent delete), fall back to full cleanup
    if (!node) {
      log.debug(`Delete ignored for unknown guid: ${guid}`);
      this.fileWriter.deleteScript(guid);
      this.scheduleCleanup();
      return;
    }

    // Capture all script descendants (and the node itself if script) before we delete the tree nodes
    const scriptsToDelete: { guid: string; filePath: string | null }[] = [];
    const collectScript = (scriptNode: TreeNode): void => {
      const filePath = this.fileWriter.getFilePath(scriptNode);
      scriptsToDelete.push({ guid: scriptNode.guid, filePath });
    };

    if (this.isScriptClass(node.className)) {
      collectScript(node);
    }
    for (const child of this.tree.getDescendantScripts(node.guid)) {
      collectScript(child);
    }

    // Delete from tree (removes node and descendants)
    this.tree.deleteInstance(guid);

    // Delete files for all affected scripts
    for (const entry of scriptsToDelete) {
      const removed = this.fileWriter.deleteScript(entry.guid);
      if (!removed && entry.filePath) {
        this.fileWriter.deleteFilePath(entry.filePath);
      }
    }

    this.scheduleSourcemapWrite();

    if (node.parentGuid) {
      const siblingScriptNodes = this.tree.getDescendantScripts(
        node.parentGuid,
      );
      const sameNameScriptNodes = siblingScriptNodes.filter(
        (sibling) =>
          sibling.parent?.guid === node.parentGuid &&
          sibling.name === node.name,
      );

      for (const scriptToRename of sameNameScriptNodes) {
        if (scriptToRename.path.length !== 0) {
          const newFilePath = this.fileWriter.getFilePath(scriptToRename);

          // Write new path
          this.fileWatcher.suppressNextChange(
            newFilePath,
            scriptToRename.source,
          );
          this.fileWriter.writeScript(scriptToRename);
        }
      }
    }

    this.scheduleCleanup();
  }

  /**
   * Helper to get relative paths of all active folder/instance nodes in TreeManager
   */
  private getActiveFolderPaths(): Set<string> {
    const paths = new Set<string>();
    for (const node of this.tree.getAllNodes().values()) {
      if (node.path && node.path.length > 0) {
        // Sanitize each segment the same way FileWriter does.
        // Makes sure that the paths we use match the actual on-disk paths.
        const sanitized = node.path.map((segment) =>
          this.fileWriter.sanitizeSegment(segment),
        );
        paths.add(sanitized.join("/"));
        for (let i = 1; i < sanitized.length; i++) {
          paths.add(sanitized.slice(0, i).join("/"));
        }
      }
    }
    return paths;
  }

  /**
   * Queue an empty-directory cleanup. It walks the whole sync directory, so a
   * burst of changes shares one walk instead of paying for it per message.
   */
  private scheduleCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setTimeout(
      () => this.cleanupDirectories(),
      COALESCE_DELAY_MS,
    );
  }

  /**
   * Safe cleanup of empty directories that preserves active instance folders.
   * Runs now, absorbing any queued cleanup.
   */
  private cleanupDirectories(): void {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.fileWriter.cleanupEmptyDirectories(this.getActiveFolderPaths());
  }

  /**
   * Handle file change from filesystem
   */
  private handleFileChange(filePath: string, source: string): void {
    // Find the GUID for this file
    const guid = this.fileWriter.getGuidByPath(filePath);

    // Quack: an agent saved again while this script is being merged; the merge re-reads the disk
    const running = guid ? this.merges.get(guid) : undefined;
    if (running) {
      running.dirty = true;
      return;
    }

    if (guid) {
      log.script(
        `${path.relative(this.fileWriter.getBaseDir(), filePath)} (external)`,
        "updated",
      );

      // Same-source anti-echo should be handled in watcher.ts, this is just in case
      const node = this.tree.getNode(guid);
      if (node?.source === source) {
        log.debug(
          `Skipping Studio patch for unchanged file: ${path.relative(this.fileWriter.getBaseDir(), filePath)}.`,
        );
        return;
      }

      // Update tree
      this.tree.updateScriptSource(guid, source);

      // Send patch to Studio (WebSocket client)
      this.ipc.patchScript(guid, source);
    } else {
      log.warn(`No mapping found for file: ${filePath}`);
    }
  }

  /**
   * Helper to parse relative path segments inside syncDir
   */
  private getRelativeSegments(absPath: string): string[] {
    const baseDir = path.resolve(this.fileWriter.getBaseDir());
    const rel = path.relative(baseDir, absPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return [];
    }
    return rel.split(/[/\\]/).filter(Boolean);
  }

  /**
   * Handle new file creation on filesystem
   */
  private handleFileAdd(filePath: string, source: string): void {
    if (!config.liveFsSync.enabled) return;

    const existingGuid = this.fileWriter.getGuidByPath(filePath);
    if (existingGuid) {
      // Quack: the same path back while its delete is buffered is a rewrite, not a deletion: git
      // (reset, checkout, merge) replaces a file with a new one. Ignoring this add let the
      // buffered delete fire and remove the script from Studio and disk (PA, 22/10/26)
      if (this.cancelPendingDelete(existingGuid)) {
        log.debug(`Rewritten in place (delete, then the same path again): ${filePath}`);
        this.recordInodeFor(existingGuid, filePath);
        this.handleFileChange(filePath, source);
        return;
      }
      log.debug(`File add ignored, already mapped: ${filePath}`);
      return;
    }

    const segments = this.getRelativeSegments(filePath);
    if (segments.length === 0) return;

    const dirSegments = segments.slice(0, -1);
    const fileName = segments[segments.length - 1];

    // A file creation may actually be the destination of a script rename/move.
    // The inode is preserved across a rename, so if this new file's inode
    // matches a buffered delete, move the existing instance instead of
    // creating a fresh one — this preserves every descendant (script and
    // non-script alike) under the moved script.
    const inode = this.statInode(filePath);
    const pending = inode ? this.pendingInstanceDeletes.get(inode) : undefined;
    if (pending) {
      const classified = classifyScriptFileName(fileName, {
        stripDisambiguationSuffix: true,
      });
      this.performInstanceMove(
        pending.guid,
        pending.oldSegments,
        [...dirSegments, classified.scriptName],
        classified.className,
        source,
      );
      return;
    }

    // Rojo developers may do init.luau; warn them that Quack does not
    if (isInitScriptFileName(fileName)) {
      const relPath = path.relative(this.fileWriter.getBaseDir(), filePath);
      const normalized = normalizeLuaLikeFileName(fileName).toLowerCase();

      let siblingSuffix = ".luau"; // init.luau -> ModuleScript
      if (normalized === "init.server.luau") {
        siblingSuffix = ".server.luau"; // -> Script
      } else if (normalized === "init.client.luau") {
        siblingSuffix = ".client.luau"; // -> LocalScript
      }

      const folderName = dirSegments[dirSegments.length - 1];

      if (!folderName) {
        log.warn(`'${relPath}': Quack does not use the init.luau pattern; name the script after its folder instead`);
        log.warn(
          `To create a script, name the file after the instance (e.g. 'MyScript${siblingSuffix}') instead of 'init'.`,
        );
      } else {
        log.warn(`'${relPath}': Quack does not use the init.luau pattern; name the script after its folder instead`);
        log.warn(
          `To make '${folderName}' a script with children, create a sibling file '${folderName}${siblingSuffix}' next to the '${folderName}/' folder (not inside it). '${folderName}/' will now contain the children of '${folderName}${siblingSuffix}'.`,
        );
      }

      // return;
    }

    const classified = classifyScriptFileName(fileName, {
      stripDisambiguationSuffix: true,
    });

    // In the log at info, like an edit: which new files the daemon saw is the first question
    // when a script is missing in Studio after a merge
    log.script(
      `${path.relative(this.fileWriter.getBaseDir(), filePath)} (external)`,
      "created",
    );

    const sent = this.ipc.createInstance(
      classified.className,
      classified.scriptName,
      dirSegments,
      source,
    );
    if (sent) this.awaitCreateAnswer(filePath);
  }

  /** Sends a script's create again while Studio has not answered it, up to CREATE_ATTEMPTS */
  private awaitCreateAnswer(filePath: string): void {
    const key = path.resolve(filePath);
    const previous = this.unansweredCreates.get(key);
    if (previous?.timer) clearTimeout(previous.timer);
    const attempt = (previous?.attempt ?? 0) + 1;
    const timer = setTimeout(() => {
      const entry = this.unansweredCreates.get(key);
      if (entry?.timer !== timer) return;
      this.unansweredCreates.delete(key);
      if (this.fileWriter.getGuidByPath(key) || !this.ipc.isConnected()) return;
      const text = readFileIfExists(key);
      if (text === undefined) return;
      const relative = path.relative(this.fileWriter.getBaseDir(), key);
      if (attempt >= SyncDaemon.CREATE_ATTEMPTS) {
        log.error(`Studio never answered the create of ${relative} (${attempt} tries): it has no instance the sync knows`);
        return;
      }
      log.warn(`Studio did not answer the create of ${relative}; sending it again`);
      // Kept without a timer so the add below counts this as the next try
      this.unansweredCreates.set(key, { attempt });
      this.handleFileAdd(key, text);
      if (!this.unansweredCreates.get(key)?.timer) this.unansweredCreates.delete(key);
    }, SyncDaemon.createAnswerMs);
    this.unansweredCreates.set(key, { attempt, timer });
  }

  /**
   * Handle file deletion on filesystem
   */
  private handleFileDelete(filePath: string): void {
    if (!config.liveFsSync.enabled) return;

    const guid = this.fileWriter.getGuidByPath(filePath);

    if (guid) {
      // Tracked script: buffer the delete so a matching file creation can turn
      // it into an instance move instead of a destructive delete+recreate.
      // Without this, Studio's Destroy() would cascade and destroy every
      // descendant (script and non-script alike) under this script.
      //
      // Use the tree's own path for this guid rather than re-deriving it from
      // the raw filename — the filename still carries the .server/.client/.luau
      // suffix, which isn't part of the DataModel path.
      const relPath = this.getRelativeSegments(filePath);
      const oldSegments = this.tree.getNode(guid)?.path ?? relPath;
      const key = this.guidToInode.get(guid) ?? `guid:${guid}`;
      const previous = this.pendingInstanceDeletes.get(key);
      if (previous) {
        clearTimeout(previous.timer);
        log.debug(
          `Resetting pending delete for ${relPath.join("/")}; still waiting for a matching add`,
        );
      } else {
        log.debug(
          `Buffering delete for ${relPath.join("/")}; waiting for a matching add`,
        );
      }
      const timer = setTimeout(
        () => this.flushPendingDelete(key, guid, oldSegments),
        this.moveWindowMs,
      );
      this.pendingInstanceDeletes.set(key, {
        guid,
        oldSegments,
        timer,
      });
    } else {
      log.script(
        `${path.relative(this.fileWriter.getBaseDir(), filePath)} (external)`,
        "deleted",
      );

      const segments = this.getRelativeSegments(filePath);
      if (segments.length === 0) return;

      const dirSegments = segments.slice(0, -1);
      const fileName = segments[segments.length - 1];
      const classified = classifyScriptFileName(fileName, {
        stripDisambiguationSuffix: true,
      });
      const instancePath = [...dirSegments, classified.scriptName];

      this.ipc.deleteInstance(undefined, instancePath);
    }
  }

  /**
   * A directory whose name matches a sibling script file is not a Folder — it is
   * the children-container of that script (the nested-scripts convention:
   * `Foo.server.luau` + `Foo/`). Such directories must not map to Folder instances.
   */
  private isScriptChildContainer(dirPath: string): boolean {
    const parentDir = path.dirname(dirPath);
    const folderName = path.basename(dirPath);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(parentDir, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !isScriptFileName(entry.name)) continue;
      const classified = classifyScriptFileName(entry.name, {
        stripDisambiguationSuffix: true,
      });
      if (classified.scriptName === folderName) {
        return true;
      }
    }

    return false;
  }

  /**
   * Handle directory creation on filesystem
   */
  private handleDirAdd(dirPath: string): void {
    if (!config.liveFsSync.enabled) return;

    const segments = this.getRelativeSegments(dirPath);
    if (segments.length === 0) return;

    const parentPath = segments.slice(0, -1);
    const folderName = segments[segments.length - 1];

    // A directory alongside a same-named script is that script's children
    // container, not a Folder instance. Creating a Folder here would spawn a
    // spurious duplicate of the script's name in Studio.
    if (this.isScriptChildContainer(dirPath)) {
      log.debug(
        `Directory '${folderName}' is a script children container; not creating a Folder instance`,
      );
      return;
    }

    // A directory creation may actually be the destination of a folder
    // rename/move. The inode is preserved across a rename, so if this new
    // directory's inode matches a buffered folder deletion, move the existing
    // instance instead of creating a fresh Folder — this preserves non-script
    // descendants that have no filesystem representation.
    const inode = this.statInode(dirPath);
    const pending = inode ? this.pendingInstanceDeletes.get(inode) : undefined;
    if (pending) {
      this.performInstanceMove(pending.guid, pending.oldSegments, segments);
      return;
    }

    // Quack: the tree already has an instance here. Renaming a folder emits "added" for every
    // subfolder too, after the parent's move already brought them along; creating a Folder
    // here duplicated each Model/Part that holds scripts (9 in the Anime Astral copy).
    const existing = this.findNodeAtDiskPath(segments);
    if (existing) {
      if (inode) this.guidToInode.set(existing.guid, inode);
      log.debug(`Directory '${folderName}' is already tracked; not creating an instance`);
      return;
    }

    log.debug(
      `Directory created: ${path.relative(this.fileWriter.getBaseDir(), dirPath)} (external)`,
    );

    this.ipc.createInstance("Folder", folderName, parentPath);
  }

  /**
   * Quack: the tracked node at a disk path, found by walking down from the root one segment at a
   * time (findTrackedNode scans every node: ~260k per call in a real game). Same name matching.
   * Siblings that share a name share one folder on disk, so every one of them is followed: the
   * Anime Astral copy has 9 UnionOperations named AuraCirculo next to each other, and only one
   * holds the Models below (following the first one found none and created duplicate Folders).
   */
  private findNodeAtDiskPath(segments: string[]): TreeNode | undefined {
    let current: TreeNode[] = [];
    for (const node of this.tree.getAllNodes().values()) {
      if (node.className === "DataModel") {
        current = [node];
        break;
      }
    }
    for (const segment of segments) {
      const next: TreeNode[] = [];
      for (const node of current) {
        for (const child of node.children.values()) {
          if (this.fileWriter.sanitizeSegment(child.name) === segment) next.push(child);
        }
      }
      if (next.length === 0) return undefined;
      current = next;
    }
    return current[0];
  }

  /**
   * Handle directory deletion on filesystem
   */
  private handleDirDelete(dirPath: string): void {
    if (!config.liveFsSync.enabled) return;

    const segments = this.getRelativeSegments(dirPath);
    if (segments.length === 0) return;

    // If a same-named script file still exists, this directory was that script's
    // children container — deleting it must not delete the script instance
    // (its children were already removed via their own unlink events).
    if (this.isScriptChildContainer(dirPath)) {
      log.debug(
        `Directory '${segments[segments.length - 1]}' is a script children container; not deleting an instance`,
      );
      return;
    }

    const node = this.findTrackedFolderNode(segments);
    // Quack: a service, or a locked child of StarterPlayer, stands for a directory that git
    // removes once its last tracked file goes (a merge, a reset). The plugin refuses to delete it,
    // but dropping it from the tree here made the directory's return create a Folder with the
    // service's name next to it (PA, 22/10/26: a StarterPlayer Folder at the root and three
    // StarterPlayerScripts Folders). The instance stays, and so does its node
    if (node && isProtectedContainer(node)) {
      log.debug(`Directory '${segments.join("/")}' is a service's; Studio keeps it`);
      return;
    }
    if (!node) {
      // Untracked folder (created and removed purely on disk): nothing in Studio
      // to lose, delete immediately.
      log.debug(
        `Deleted directory: ${path.relative(this.fileWriter.getBaseDir(), dirPath)} (external)`,
      );
      this.ipc.deleteInstance(undefined, segments);
      return;
    }

    // Tracked folder: buffer the delete so a matching directory creation can turn
    // it into an instance move. Without this, deleting the folder in Studio
    // cascades and destroys non-script descendants that can't be rebuilt from disk.
    // Key by the folder's inode (recorded while its directory still existed) so a
    // matching addDir can claim it regardless of per-file event ordering.
    const key = this.guidToInode.get(node.guid) ?? `guid:${node.guid}`;
    const previous = this.pendingInstanceDeletes.get(key);
    if (previous) {
      clearTimeout(previous.timer);
      log.debug(
        `Resetting pending folder delete for ${segments.join("/")}; still waiting for a matching addDir`,
      );
    } else {
      log.debug(
        `Buffering folder delete for ${segments.join("/")}; waiting for a matching addDir`,
      );
    }
    const timer = setTimeout(
      () => this.flushPendingDelete(key, node.guid, segments),
      this.moveWindowMs,
    );
    this.pendingInstanceDeletes.set(key, {
      guid: node.guid,
      oldSegments: segments,
      timer,
    });
  }

  /** Find a tracked non-script folder node at the given path, if any. */
  private findTrackedFolderNode(segments: string[]): TreeNode | undefined {
    for (const node of this.tree.getAllNodes().values()) {
      if (
        node.className === "DataModel" ||
        this.isScriptClass(node.className)
      ) {
        continue;
      }
      if (
        node.path.length === segments.length &&
        node.path.every((s, i) => s === segments[i])
      ) {
        return node;
      }
    }
    return undefined;
  }

  /**
   * Find any tracked node at the given path, including scripts. A script's own
   * nested descendants (the nested-scripts convention) have that script as
   * their Roblox parent, so resolving a move's destination parent needs this,
   * not findTrackedFolderNode.
   */
  private findTrackedNode(segments: string[]): TreeNode | undefined {
    for (const node of this.tree.getAllNodes().values()) {
      if (node.className === "DataModel") {
        continue;
      }
      if (
        node.path.length === segments.length &&
        node.path.every(
          (segment, i) =>
            this.fileWriter.sanitizeSegment(segment) === segments[i],
        )
      ) {
        return node;
      }
    }
    return undefined;
  }

  /** The inode of a path as a string key, or null if it can't be stat'd. */
  /**
   * Script files on disk that no instance in Studio answers to: a file is mapped only once the
   * plugin created its instance and sent it back, so a create the watcher never reported, or
   * one the plugin never answered, stays here. Paths relative to the sync folder, sorted.
   */
  private unsyncedScripts(): string[] {
    const base = path.resolve(this.fileWriter.getBaseDir());
    const found: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.luau?$/.test(entry.name) && !this.fileWriter.getGuidByPath(full)) {
          found.push(path.relative(base, full).split(path.sep).join("/"));
        }
      }
    };
    walk(base);
    return found.sort();
  }

  /**
   * Sends the create of each listed script again (paths relative to the sync folder). Studio
   * reuses a script of that name and class already there, so one it made without answering is
   * mapped, not duplicated; one it never made is made now.
   */
  private createAgain(files: string[]): void {
    const base = this.fileWriter.getBaseDir();
    for (const file of files) {
      const full = path.resolve(base, file);
      const text = readFileIfExists(full);
      if (text === undefined || this.fileWriter.getGuidByPath(full)) continue;
      const previous = this.unansweredCreates.get(full);
      if (previous?.timer) clearTimeout(previous.timer);
      this.unansweredCreates.delete(full);
      log.info(`Sending the create of ${file} again (quack wait --fix)`);
      this.handleFileAdd(full, text);
    }
  }

  private statInode(absPath: string): string | null {
    try {
      const { ino } = fs.statSync(absPath);
      // Some filesystems (FAT/exFAT, certain network/virtual mounts) don't
      // support file IDs and report 0 for every entry. Treating that as a real
      // ID would collapse unrelated folders onto the same key and could make
      // performFolderMove reparent the wrong instance
      if (!ino) return null;
      return String(ino);
    } catch {
      return null;
    }
  }

  /**
   * Record inode→guid for a node whose filesystem path currently exists — a
   * script's file, or a folder's directory. Used to recognize a later
   * rename/move (matched by inode) instead of treating it as delete+recreate.
   */
  private recordInode(node: TreeNode): void {
    if (node.className === "DataModel") {
      return;
    }
    const inode = this.statInode(this.fileWriter.getFilePath(node));
    if (inode) this.guidToInode.set(node.guid, inode);
  }

  /** Record inodes for every tracked node that has a file/directory on disk. */
  private recordInodes(): void {
    log.debug("Recording inodes for all tracked nodes...");
    // Quack: stat only paths that exist. A real game has ~260k instances and ~1.5k files and
    // folders on disk; a failing statSync per instance took 7.8 s (Anime Astral copy, 19/10/26).
    const onDisk = new Set<string>();
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.resolve(dir, entry.name);
        onDisk.add(full);
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(path.resolve(this.fileWriter.getBaseDir()));

    // Top-down, skipping every branch whose own path is not on disk: a descendant's path sits
    // under its ancestor's, so nothing below can be there. Computing all ~260k paths cost 1.4 s.
    const visit = (node: TreeNode): void => {
      for (const child of node.children.values()) {
        if (!onDisk.has(path.resolve(this.fileWriter.getFilePath(child)))) continue;
        this.recordInode(child);
        visit(child);
      }
    };
    for (const node of this.tree.getAllNodes().values()) {
      if (node.className === "DataModel") visit(node);
    }
  }

  /** Quack: drops a buffered delete of this script, if there is one; true when there was */
  private cancelPendingDelete(guid: string): boolean {
    for (const [key, pending] of this.pendingInstanceDeletes) {
      if (pending.guid !== guid) continue;
      clearTimeout(pending.timer);
      this.pendingInstanceDeletes.delete(key);
      return true;
    }
    return false;
  }

  /** Quack: the inode of a script's (new) file, so a later rename of it is still seen as a move */
  private recordInodeFor(guid: string, filePath: string): void {
    const inode = this.statInode(filePath);
    if (!inode) return;
    this.guidToInode.set(guid, inode);
  }

  /** A buffered delete fired without a matching move: delete for real. */
  private flushPendingDelete(
    key: string,
    guid: string,
    oldSegments: string[],
  ): void {
    this.pendingInstanceDeletes.delete(key);

    // Backstop: if the node has moved to a different path since buffering, it was
    // a rename/move handled elsewhere — never delete an instance that relocated.
    const node = this.tree.getNode(guid);
    if (node && !this.pathsEqualSegments(node.path, oldSegments)) return;

    // Quack: the file is back at its path (a rewrite whose add event was missed or came first):
    // what is on disk is the script's new text, never a deletion
    const mapped = this.fileWriter.getMapping(guid)?.filePath;
    if (mapped && fs.existsSync(mapped)) {
      const text = readFileIfExists(mapped);
      if (text !== undefined) {
        log.debug(`Not deleting ${oldSegments.join("/")}: its file is back`);
        this.recordInodeFor(guid, mapped);
        this.handleFileChange(mapped, text);
        return;
      }
    }

    this.guidToInode.delete(guid);
    log.script(`${oldSegments.join("/")} (external)`, "deleted");

    // Only prune local state once Studio actually received the delete.
    if (this.ipc.deleteInstance(guid)) {
      this.handleDeleted({ guid });
    } else {
      log.warn(
        `Studio did not receive the delete for ${guid}; keeping local state`,
      );
    }
  }

  /**
   * Turn a buffered delete + matching filesystem creation into a move. Handles
   * both folders (a directory rename/move) and scripts (a file rename/move) —
   * in either case Studio reparents/renames the existing instance rather than
   * destroying and recreating it, so descendants that have no filesystem
   * representation (Parts, Models, ...) survive.
   */
  private performInstanceMove(
    guid: string,
    oldSegments: string[],
    newSegments: string[],
    newClassName?: string,
    source?: string,
  ): void {
    const newName = newSegments[newSegments.length - 1];
    const node = this.tree.getNode(guid);

    // A renamed file's suffix can imply a class change (Foo.luau -> Foo.server.luau
    // means ModuleScript -> Script). Roblox can't change ClassName in place, so
    // tell the plugin to recreate the instance as the new class instead of a
    // plain reparent, which would silently keep the old one.
    const classChanged = Boolean(
      newClassName && node && node.className !== newClassName,
    );

    // Move (and, if needed, convert) the existing instance in Studio,
    // preserving its GUID and every descendant (scripts and non-scripts alike).
    this.ipc.moveInstance(
      guid,
      newSegments.slice(0, -1),
      newName,
      classChanged ? newClassName : undefined,
      classChanged ? source : undefined,
    );

    // Resolve the destination parent from the NEW location. Without an explicit
    // parentGuid, updateInstance treats the parent as unchanged and leaves the
    // node attached under its OLD parent in the tree graph, only node.path
    // would reflect the move. That desync is invisible for a same-parent
    // rename, but for a cross-parent move it means a later delete of the old
    // parent would wrongly cascade-delete this already-moved subtree.
    const destinationParent = this.findTrackedNode(newSegments.slice(0, -1));

    // Reflect the move in the tree so descendant paths are recalculated. This
    // also arms the backstop for any descendant instances that moved along.
    this.tree.updateInstance({
      guid,
      className: newClassName ?? node?.className ?? "Folder",
      name: newName,
      path: newSegments,
      parentGuid: destinationParent?.guid,
      source: classChanged ? source : undefined,
    });

    const moved = this.tree.getNode(guid);

    // For a moved script, the physical file already exists at newSegments (the
    // OS move put it there) but FileWriter's own mapping still points at the
    // old path. Without updating it, getGuidByPath(newPath) would miss, and a
    // later content edit to this same file would be silently dropped.
    if (moved && this.isScriptClass(moved.className)) {
      const newFilePath = this.fileWriter.getFilePath(moved);
      this.fileWatcher.suppressNextChange(newFilePath, moved.source);
      this.fileWriter.remapScript(guid, newFilePath, moved.className);

      // A script with descendant scripts stores them in a sibling directory
      // sharing its base name (the nested-scripts convention: Module.luau +
      // Module/). That directory has no tree node of its own — it's purely
      // derived from each descendant's own path — so it doesn't follow the
      // script's move/rename automatically. Move it alongside now, instead of
      // leaving it orphaned until each descendant is individually re-edited.
      this.relocateScriptChildrenFolder(guid, oldSegments, newSegments);
    } else if (moved) {
      // OS already moved these files; FileWriter's mapping hasn't caught up.
      // Remap now, or each descendant's unlink/add reads as an unrelated
      // delete+create (harmless, but sourcemap stays stale for a round-trip).
      for (const descendant of this.tree.getDescendantScripts(guid)) {
        const oldFilePath = this.fileWriter.getMapping(
          descendant.guid,
        )?.filePath;
        const newFilePath = this.fileWriter.getFilePath(descendant);
        if (oldFilePath) {
          this.fileWatcher.suppressNextEvent(oldFilePath, "unlink");
        }
        this.fileWatcher.suppressNextEvent(newFilePath, "add");
        this.fileWriter.remapScript(
          descendant.guid,
          newFilePath,
          descendant.className,
        );
      }
    }

    // Descendants moved with this instance — cancel their buffered deletes.
    for (const [key, entry] of this.pendingInstanceDeletes) {
      if (
        entry.guid === guid ||
        this.pathsEqualSegments(entry.oldSegments, oldSegments) ||
        this.segmentsUnder(entry.oldSegments, oldSegments)
      ) {
        clearTimeout(entry.timer);
        this.pendingInstanceDeletes.delete(key);
      }
    }

    if (moved) {
      this.scheduleSourcemapWrite();
    }
    this.scheduleCleanup();

    // Same parent, different name = a rename; different parent = a move.
    // Detection can't tell these apart upfront (both are just an inode-matched
    // unlink+add pair), so decide the wording from the resulting segments.
    const sameParent = this.pathsEqualSegments(
      oldSegments.slice(0, -1),
      newSegments.slice(0, -1),
    );
    const action = sameParent ? "Renamed" : "Moved";
    log.script(
      `${action} (${moved?.className ?? "?"}): ${oldSegments.join("/")} -> ${newSegments.join("/")} (external)`,
      "updated",
    );
  }

  /**
   * Move a script's nested-scripts children-container directory (if it has
   * one) to sit alongside its new file location, and remap every descendant
   * script's file mapping to match. A failure here is non-fatal — the script
   * itself already moved successfully — it's just left at the old location
   * until it self-heals on the next edit of each descendant.
   */
  private relocateScriptChildrenFolder(
    guid: string,
    oldSegments: string[],
    newSegments: string[],
  ): void {
    const oldFolderPath = this.fileWriter.getDirPathForSegments(oldSegments);
    const newFolderPath = this.fileWriter.getDirPathForSegments(newSegments);

    if (oldFolderPath === newFolderPath || !fs.existsSync(oldFolderPath)) {
      return;
    }

    // Snapshot descendants' current file paths before anything moves.
    // FileWriter's mapping table is independent of tree.path (already updated
    // to the new location by the caller), so this still reflects where each
    // descendant's file currently sits on disk.
    const descendants = this.tree.getDescendantScripts(guid);
    const oldFilePaths = new Map<string, string | undefined>();
    for (const descendant of descendants) {
      oldFilePaths.set(
        descendant.guid,
        this.fileWriter.getMapping(descendant.guid)?.filePath,
      );
    }

    this.fileWatcher.suppressNextEvent(oldFolderPath, "unlinkDir");
    this.fileWatcher.suppressNextEvent(newFolderPath, "addDir");

    try {
      fs.mkdirSync(path.dirname(newFolderPath), { recursive: true });
      fs.renameSync(oldFolderPath, newFolderPath);
    } catch (error) {
      log.warn(
        `Failed to relocate children folder for moved instance ${guid} (left at old location):`,
        error,
      );
      return;
    }

    for (const descendant of descendants) {
      const oldFilePath = oldFilePaths.get(descendant.guid);
      const newFilePath = this.fileWriter.getFilePath(descendant);
      if (oldFilePath)
        this.fileWatcher.suppressNextEvent(oldFilePath, "unlink");
      this.fileWatcher.suppressNextEvent(newFilePath, "add");
      this.fileWriter.remapScript(
        descendant.guid,
        newFilePath,
        descendant.className,
      );
    }

    log.info(
      `Relocated children folder: ${path.relative(this.fileWriter.getBaseDir(), oldFolderPath)} -> ${path.relative(this.fileWriter.getBaseDir(), newFolderPath)}`,
    );
  }

  private pathsEqualSegments(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((s, i) => s === b[i]);
  }

  /** True if `inner` is strictly nested under `outer`. */
  private segmentsUnder(inner: string[], outer: string[]): boolean {
    return inner.length > outer.length && outer.every((s, i) => s === inner[i]);
  }

  /**
   * Queue a sourcemap regeneration. Every change inside the window lands in a
   * single write, so luau-lsp reindexes once per burst instead of per message.
   */
  private scheduleSourcemapWrite(): void {
    if (this.sourcemapTimer) return;
    this.sourcemapTimer = setTimeout(
      () => this.regenerateSourcemap(),
      COALESCE_DELAY_MS,
    );
  }

  /**
   * Regenerate the sourcemap now, absorbing any queued write
   */
  private regenerateSourcemap(): void {
    if (this.sourcemapTimer) {
      clearTimeout(this.sourcemapTimer);
      this.sourcemapTimer = null;
    }

    // Write sourcemap into the sync directory so Luau-LSP can find it
    const outputPath = config.sourcemapPath;
    this.sourcemapGenerator.generateAndWrite(
      this.tree.getAllNodes(),
      this.fileWriter.getAllMappings(),
      outputPath,
    );
  }

  /**
   * Start the daemon
   */
  /**
   * Quack: `quackdev play <worktree>`. The place in edit mode keeps this folder's scripts; the
   * plugin swaps in the worktree's for the moment Studio copies the place into a playtest, then
   * restores them (measured 22/10/26: ~1.4 s in the Anime Astral copy, ~2 s in PA). The play
   * session checks it got them and reports through the output relay.
   */
  public async startPlay(worktree: unknown): Promise<PlayState> {
    if (typeof worktree !== "string" || !path.isAbsolute(worktree)) throw new Error("worktree must be an absolute path");
    if (this.play && !this.play.done) throw new Error("a play is already being started");
    if (this.standby) throw new Error("this daemon is on standby for a hub switch");
    if (!this.ipc.isConnected() || this.lastSync === undefined) throw new Error("no Studio is synced with this place");
    // The project root, as for .quack/: the folder of the sourcemap (the hub's cwd for its daemons)
    const registered = path.dirname(path.resolve(config.sourcemapPath));
    const root = worktreeOf(worktree, registered);
    const overlay: PlayOverlay = computePlayOverlay(registered, root, {
      syncDir: this.fileWriter.getBaseDir(),
      guidByFile: (file) => this.fileWriter.getGuidByPath(file),
      node: (guid) => {
        const node = this.tree.getNode(guid);
        return node && { source: node.source, path: node.path, className: node.className };
      },
    });
    const id = randomBytes(6).toString("hex");
    const checks: PlayCheck[] = [
      ...overlay.patches.map((p) => ({ path: p.path, hash: p.hash })),
      ...overlay.creates.map((c) => ({ path: [...c.parentPath, c.name], hash: c.hash })),
      ...overlay.disables.map((d) => ({ path: d.path, disabled: true })),
    ];
    const state: PlayState = {
      id,
      worktree: root,
      startedAt: Date.now(),
      done: false,
      patches: overlay.patches.length,
      creates: overlay.creates.length,
      disables: overlay.disables.length,
      skipped: overlay.skipped,
      conflicts: overlay.conflicts,
      checks: checks.length,
    };
    this.play = state;
    log.info(`Play of ${root}: ${state.patches} changed, ${state.creates} new, ${state.disables} turned off${overlay.skipped.length ? `, ${overlay.skipped.length} the play cannot carry` : ""}`);
    for (const line of overlay.skipped) log.warn(`Play: ${line}`);
    for (const line of overlay.conflicts) log.warn(`Play conflict: ${line}`);
    const result = await new Promise<PlayOverlayResultMessage>((resolve) => {
      const timer = setTimeout(
        () => resolve({ type: "playOverlayResult", id, ok: false, error: "Studio did not answer in 40 s (a plugin without play support, or the place closed)" }),
        40_000,
      );
      this.playResolve = (answer) => {
        clearTimeout(timer);
        resolve(answer);
      };
      const sent = this.ipc.send({
        type: "playOverlay",
        id,
        patches: overlay.patches.map(({ guid, source }) => ({ guid, source })),
        creates: overlay.creates.map(({ className, name, parentPath, source }) => ({ className, name, parentPath, source })),
        disables: overlay.disables.map(({ guid }) => ({ guid })),
        checks,
      });
      if (!sent) {
        clearTimeout(timer);
        resolve({ type: "playOverlayResult", id, ok: false, error: "could not send the swap to Studio" });
      }
    });
    this.playResolve = null;
    state.done = true;
    state.result = {
      ok: result.ok === true,
      ...(typeof result.error === "string" ? { error: result.error.slice(0, 500) } : {}),
      ...(typeof result.windowMs === "number" ? { windowMs: result.windowMs } : {}),
      ...(typeof result.applied === "number" ? { applied: result.applied } : {}),
      ...(Array.isArray(result.failed) ? { failed: result.failed.slice(0, 50).map(String) } : {}),
    };
    if (Array.isArray(result.stalls)) log.info(`Play: stalls in edit mode: ${result.stalls.slice(0, 20).map(String).join(", ") || "none"}`);
    if (state.result.ok) log.success(`Play of ${root} started; the place in edit mode held it ${Math.round(state.result.windowMs ?? 0)} ms`);
    else log.error(`Play of ${root} failed: ${state.result.error ?? "unknown"}`);
    return state;
  }

  public start(): void {
    log.info("🦆 Quack daemon starting...");
    log.info(`Sync directory: ${config.syncDir}`);
    log.info(`HTTP/WebSocket port: ${config.port}`);
    log.info("");
    log.success(`Server listening on http://localhost:${config.port}`);
    log.info("Waiting for Studio connection...");
  }

  /**
   * Stop the daemon
   */
  public async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = (async () => {
      log.info("Stopping daemon...");
      if (this.afterTakeoverTimer) clearTimeout(this.afterTakeoverTimer);
      for (const entry of this.pendingInstanceDeletes.values()) {
        clearTimeout(entry.timer);
      }
      this.pendingInstanceDeletes.clear();
      for (const entry of this.unansweredCreates.values()) clearTimeout(entry.timer);
      this.unansweredCreates.clear();
      // Flush queued work so the last changes aren't lost
      if (this.sourcemapTimer) {
        this.regenerateSourcemap();
      }
      if (this.cleanupTimer) {
        this.cleanupDirectories();
      }
      this.guidToInode.clear();
      await this.fileWatcher.stop();
      this.ipc.send({ type: "daemonDisconnect" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await this.ipc.close();
      await new Promise<void>((resolve, reject) => {
        this.httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      log.info("Daemon stopped");
    })();

    return this.stopPromise;
  }

  private isScriptClass(className: string): boolean {
    return (
      className === "Script" ||
      className === "LocalScript" ||
      className === "ModuleScript"
    );
  }

  /**
   * Delete files under syncDir that are not mapped to any instance (opt-in).
   */
  /** Removes unmapped files, or with `countOnly` just counts them; returns how many there were */
  private cleanupOrphanFiles(countOnly = false): number {
    if (!config.deleteOrphansOnConnect) {
      return 0;
    }

    const baseDir = this.fileWriter.getBaseDir();
    const mapped = new Set<string>();

    for (const mapping of this.fileWriter.getAllMappings().values()) {
      mapped.add(path.resolve(mapping.filePath));
    }

    let removedFiles: string[] = [];

    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          if (!mapped.has(path.resolve(fullPath))) {
            if (countOnly) {
              removedFiles.push(entry.name);
              continue;
            }
            try {
              fs.unlinkSync(fullPath);
              removedFiles.push(entry.name);
            } catch (error) {
              log.warn("Failed to delete orphan file:", fullPath, error);
            }
          }
        }
      }
    };

    walk(baseDir);
    if (countOnly) {
      if (removedFiles.length > 0) log.info(`${removedFiles.length} file(s) appeared during the handoff (${removedFiles.join(", ")}); Studio sends a snapshot`);
      return removedFiles.length;
    }
    if (removedFiles.length > 0) {
      this.cleanupDirectories();
      log.success(
        `Removed ${removedFiles.length} orphan file(s) from sync directory (${removedFiles.join(", ")})`,
      );
    }
    return removedFiles.length;
  }
}

// Allow direct execution (`node dist/index.js`) while preventing side effects when imported by the CLI.
// Quack: in the bundled daemon this module shares its file with the CLI, so the check would see a
// direct run and start a second daemon next to the CLI's
const isDirectRun =
  !BUNDLED &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  initializeConfig();
  const daemon = new SyncDaemon();
  daemon.start();

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n");
    console.log("Received SIGINT, shutting down...");
    await daemon.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await daemon.stop();
    process.exit(0);
  });
}
