import * as chokidar from "chokidar";
import * as fs from "fs";
import * as path from "path";
import { log } from "../util/log.js";
import { config } from "../config.js";
import { diskText } from "../util/scriptFile.js";

export type FileChangeHandler = (filePath: string, source: string) => void;

export type FileEventType =
  | "change"
  | "add"
  | "unlink"
  | "addDir"
  | "unlinkDir";

export type FileEventHandler = (
  event: FileEventType,
  filePath: string,
  source?: string,
) => void;

/**
 * Watches the filesystem for changes and notifies handlers
 */
export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private changeHandler: FileChangeHandler | null = null;
  private eventHandler: FileEventHandler | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout | NodeJS.Immediate> =
    new Map();
  private suppressedUntil: Map<string, number> = new Map();
  private expectedContents: Map<string, string> = new Map();
  // Map of filePath -> Map of event type -> expiry timestamp.
  // TTL'd (unlike a bare Set) because a suppression registered for a directory created before watch() starts (e.g.
  // the initial writeTree()) will never be consumed (ignoreInitial means
  // chokidar never emits addDir for it) and would otherwise sit forever,
  // silently swallowing the first *unrelated* future addDir for that same path.
  private suppressedEvents: Map<string, Map<FileEventType, number>> = new Map();
  private static readonly SUPPRESSION_TTL_MS = 1000;
  private nativeWatcher: fs.FSWatcher | null = null;
  private nativeRoot = "";
  // Known file -> its last seen stat stamp. Windows reports last-access updates
  // (enabled by default) through the same watch, so a read alone raises an event:
  // a stamp that did not move means nobody wrote the file.
  private knownFiles: Map<string, string> = new Map();
  private knownDirs: Set<string> = new Set();
  private rescanTimer: NodeJS.Timeout | null = null;
  private static readonly RESCAN_DELAY_MS = 250;
  // What Studio is believed to hold per script: the last content sent or written from Studio
  private lastKnownSource: Map<string, string> = new Map();
  private emptyRecheck: Set<string> = new Set();
  private static readonly EMPTY_RECHECK_MS = 30;

  /**
   * Start watching a directory
   */
  public watch(directory: string): void {
    if (this.watcher || this.nativeWatcher) {
      log.warn("Watcher already running, stopping it first");
      this.stop();
    }

    log.info(`Starting file watcher on: ${directory}`);

    if (config.liveFsSync.watcher === "native") {
      this.watchNative(directory);
      return;
    }

    // On Windows, native (fs.watch) watching holds an open handle on every
    // watched subdirectory, which makes the OS reject renaming any folder that
    // contains a watched subfolder (EPERM). Polling avoids those handles.
    const { usePolling, pollInterval } = config.liveFsSync;
    if (usePolling) {
      log.info(`Using polling mode (interval: ${pollInterval}ms)`);
    }

    this.watcher = chokidar.watch(directory, {
      persistent: true,
      ignoreInitial: true,
      usePolling,
      interval: pollInterval,
      binaryInterval: pollInterval,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    });

    this.watcher.on("change", (filePath) => {
      this.handleFileEvent("change", filePath);
    });

    this.watcher.on("add", (filePath) => {
      this.handleFileEvent("add", filePath);
    });

    this.watcher.on("unlink", (filePath) => {
      this.handleFileEvent("unlink", filePath);
    });

    this.watcher.on("addDir", (dirPath) => {
      this.handleFileEvent("addDir", dirPath);
    });

    this.watcher.on("unlinkDir", (dirPath) => {
      this.handleFileEvent("unlinkDir", dirPath);
    });

    this.watcher.on("error", (error) => {
      log.error("File watcher error:", error);
    });

    this.watcher.on("ready", () => {
      log.success("File watcher ready");
    });
  }

  /**
   * Native mode: one recursive fs.watch on the root, translated into the same
   * add/change/unlink/addDir/unlinkDir events chokidar emits. The OS only says
   * "something happened at this path", so the known tree decides which event it was.
   */
  private watchNative(directory: string): void {
    const root = path.resolve(directory);
    this.knownFiles.clear();
    this.knownDirs.clear();
    this.nativeRoot = root;
    this.scanInto(root, false);

    this.nativeWatcher = fs.watch(
      root,
      { recursive: true, persistent: true },
      (_type, relative) => {
        if (relative === null) {
          this.requestRescan(root);
          return;
        }
        this.classifyNative(path.join(root, relative.toString()));
      },
    );

    this.nativeWatcher.on("error", (error) => {
      log.error("File watcher error:", error);
    });

    log.success("File watcher ready (native)");
  }

  private classifyNative(fullPath: string): void {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      stat = null;
    }

    if (!stat) {
      if (this.knownDirs.has(fullPath)) {
        this.forgetDir(fullPath);
      } else if (this.knownFiles.has(fullPath)) {
        this.knownFiles.delete(fullPath);
        this.handleFileEvent("unlink", fullPath);
      }
      return;
    }

    this.ensureParentsKnown(fullPath);

    if (stat.isDirectory()) {
      // A folder's own "change" (a child was touched) arrives as its own event
      if (!this.knownDirs.has(fullPath)) {
        this.knownDirs.add(fullPath);
        this.handleFileEvent("addDir", fullPath);
        this.scanInto(fullPath, true);
      }
      return;
    }

    const stamp = FileWatcher.stampOf(stat);
    const knownStamp = this.knownFiles.get(fullPath);
    this.knownFiles.set(fullPath, stamp);
    if (knownStamp === undefined) {
      this.handleFileEvent("add", fullPath);
    } else if (knownStamp !== stamp) {
      this.handleFileEvent("change", fullPath);
    }
  }

  /** Moves on any write (ctime too, so a tool that restores mtime still counts); not on a read */
  private static stampOf(stat: fs.Stats): string {
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  }

  /** A folder created inside a folder nobody announced yet (mkdir -p, a moved tree) */
  private ensureParentsKnown(fullPath: string): void {
    const missing: string[] = [];
    let dir = path.dirname(fullPath);
    while (dir !== this.nativeRoot && !this.knownDirs.has(dir)) {
      missing.push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const parent of missing.reverse()) {
      this.knownDirs.add(parent);
      this.handleFileEvent("addDir", parent);
    }
  }

  /** Files first, then folders deepest first: the order chokidar reports a removed tree in */
  private forgetDir(dirPath: string): void {
    const prefix = dirPath + path.sep;
    for (const file of [...this.knownFiles.keys()]) {
      if (file.startsWith(prefix)) {
        this.knownFiles.delete(file);
        this.handleFileEvent("unlink", file);
      }
    }
    const dirs = [...this.knownDirs]
      .filter((d) => d === dirPath || d.startsWith(prefix))
      .sort((a, b) => b.length - a.length);
    for (const dir of dirs) {
      this.knownDirs.delete(dir);
      this.handleFileEvent("unlinkDir", dir);
    }
  }

  /**
   * Walk a folder into the known tree; announce what it finds when emit is set.
   * Known folders are walked too: a rescan after lost events has to find a new file in a
   * folder that already existed (a merge's new scripts in Config/ and Utils/ never reached
   * Studio when only unknown folders were walked: Astral, 27/10/26)
   */
  private scanInto(dirPath: string, emit: boolean): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (!this.knownDirs.has(full)) {
          this.knownDirs.add(full);
          if (emit) this.handleFileEvent("addDir", full);
        }
        this.scanInto(full, emit);
      } else if (!this.knownFiles.has(full)) {
        let stamp = "";
        try {
          stamp = FileWatcher.stampOf(fs.statSync(full));
        } catch {
          continue;
        }
        this.knownFiles.set(full, stamp);
        if (emit) this.handleFileEvent("add", full);
      }
    }
  }

  /** One rescan per burst: overflows repeat ~120 ms apart until it is over, so wait for the last */
  private requestRescan(root: string): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      this.rescanNative(root);
    }, FileWatcher.RESCAN_DELAY_MS);
  }

  /**
   * The OS dropped the path (buffer overflow): diff the whole tree by stat alone.
   * Reading every file here would touch every last-access time and overflow again.
   */
  private rescanNative(root: string): void {
    log.warn("Native watcher lost events, rescanning the sync folder");
    const before = [...this.knownFiles.keys(), ...this.knownDirs];
    for (const p of before) this.classifyNative(p);
    this.scanInto(root, true);
  }

  /**
   * Handle a file event with debouncing
   */
  private handleFileEvent(event: FileEventType, filePath: string): void {
    // A new file's write lands as "add" then "change"; the add reads the final content anyway
    if (event === "change" && this.debounceTimers.has(`add:${filePath}`)) {
      return;
    }

    const debounceKey = `${event}:${filePath}`;

    // Already queued for this turn of the loop: that run reads the newest content
    if (config.fileWatchDebounce === 0 && this.debounceTimers.has(debounceKey)) {
      return;
    }

    // Clear existing timer for this event+file
    const existingTimer = this.debounceTimers.get(debounceKey);
    if (existingTimer) {
      clearTimeout(existingTimer as NodeJS.Timeout);
    }

    const run = () => {
      this.debounceTimers.delete(debounceKey);
      this.processFileEvent(event, filePath);
    };

    // 0 = next turn of the event loop. A Windows timer can't fire sooner than its
    // ~15.6 ms tick, so even setTimeout(1) costs a whole tick on every save.
    const timer =
      config.fileWatchDebounce === 0
        ? setImmediate(run)
        : setTimeout(run, config.fileWatchDebounce);

    this.debounceTimers.set(debounceKey, timer);
  }

  /**
   * An empty read is usually a write caught between its truncate and its write
   * (writeFileSync does both). Look again shortly; a second empty read is real.
   * Emptying a script on purpose is rare, so it is the one case that pays the wait.
   */
  private isTornEmptyRead(
    event: FileEventType,
    filePath: string,
    normalizedPath: string,
    source: string,
  ): boolean {
    if (source !== "" || this.emptyRecheck.has(normalizedPath)) {
      this.emptyRecheck.delete(normalizedPath);
      return false;
    }

    this.emptyRecheck.add(normalizedPath);
    setTimeout(
      () => this.processFileEvent(event, filePath),
      FileWatcher.EMPTY_RECHECK_MS,
    );
    return true;
  }

  /**
   * Process a file event after debouncing
   */
  private processFileEvent(event: FileEventType, filePath: string): void {
    const normalizedPath = path.resolve(filePath);

    // For file events, only process script files
    if (event === "change" || event === "add" || event === "unlink") {
      if (!this.isScriptFile(filePath)) {
        return;
      }
    }

    // Check event-specific suppression (used for daemon-originated operations)
    const suppressedEventsForPath = this.suppressedEvents.get(normalizedPath);
    const suppressionExpiresAt = suppressedEventsForPath?.get(event);
    if (
      suppressedEventsForPath !== undefined &&
      suppressionExpiresAt !== undefined
    ) {
      // Always consume the entry on match (expired or not) so a stale
      // suppression can't linger and swallow a later, unrelated occurrence.
      suppressedEventsForPath.delete(event);
      if (suppressedEventsForPath.size === 0) {
        this.suppressedEvents.delete(normalizedPath);
      }

      if (suppressionExpiresAt > Date.now()) {
        log.debug(
          `File event suppressed (daemon-originated, event-specific): ${event} ${normalizedPath}`,
        );
        return;
      }

      log.debug(
        `Discarding expired suppression, processing normally: ${event} ${normalizedPath}`,
      );
    }

    // For unlink and unlinkDir, file no longer exists — skip content-based checks
    if (event === "unlink" || event === "unlinkDir") {
      this.lastKnownSource.delete(normalizedPath);
      log.debug(`File event: ${event} ${normalizedPath}`);
      this.dispatchEvent(event, normalizedPath);
      return;
    }

    // For addDir, no content to read
    if (event === "addDir") {
      log.debug(`File event: ${event} ${normalizedPath}`);
      this.dispatchEvent(event, normalizedPath);
      return;
    }

    // For change and add, read the file content
    try {
      const source = diskText(fs.readFileSync(filePath, "utf-8"));

      if (this.isTornEmptyRead(event, filePath, normalizedPath, source)) {
        return;
      }

      // The same content again (one save raising two OS events): Studio already has it
      if (
        event === "change" &&
        this.lastKnownSource.get(normalizedPath) === source
      ) {
        log.debug(`File event skipped (content unchanged): ${normalizedPath}`);
        return;
      }

      // Skip if this change was produced by a Studio-originated write.
      // Quack: only inside its window. A write the daemon skipped (the file already had that
      // text) left the entry behind with no event to consume it, and the same text coming back
      // later from outside (a merge recreating a deleted script) was taken for Studio's echo and
      // dropped: every other merge-and-reset cycle lost its new script (PA, 22/10/26)
      const expectedUntil = this.suppressedUntil.get(normalizedPath);
      if (this.expectedContents.has(normalizedPath) && (expectedUntil === undefined || expectedUntil <= Date.now())) {
        this.expectedContents.delete(normalizedPath);
        this.suppressedUntil.delete(normalizedPath);
      }
      const expectedSource = this.expectedContents.get(normalizedPath);
      if (expectedSource !== undefined) {
        if (source === expectedSource) {
          log.debug(
            `File event suppressed (Studio-originated content match): ${normalizedPath}`,
          );
          this.lastKnownSource.set(normalizedPath, source);
          this.suppressedUntil.delete(normalizedPath);
          this.expectedContents.delete(normalizedPath);
          return;
        }

        // Expected content mismatched, so this is an external change. Clear stale suppression.
        this.suppressedUntil.delete(normalizedPath);
        this.expectedContents.delete(normalizedPath);
      } else {
        // No expected content, but check if we're still within a suppression window
        const now = Date.now();
        const suppressUntil = this.suppressedUntil.get(normalizedPath);
        if (suppressUntil && suppressUntil > now) {
          log.debug(
            `File event suppressed (Studio-originated): ${normalizedPath}`,
          );
          return;
        }

        // Clear the suppression if it's expired
        if (suppressUntil && suppressUntil <= now) {
          this.suppressedUntil.delete(normalizedPath);
          this.expectedContents.delete(normalizedPath);
        }
      }

      log.debug(`File event: ${event} ${normalizedPath}`);
      this.lastKnownSource.set(normalizedPath, source);
      this.dispatchEvent(event, normalizedPath, source);
    } catch (error) {
      log.error(`Failed to read file for event ${event} ${filePath}:`, error);
    }
  }

  /**
   * Dispatch the event to the appropriate handler
   */
  private dispatchEvent(
    event: FileEventType,
    normalizedPath: string,
    source?: string,
  ): void {
    if (this.eventHandler) {
      this.eventHandler(event, normalizedPath, source);
    } else if (
      this.changeHandler &&
      event === "change" &&
      source !== undefined
    ) {
      // Legacy fallback for existing onChange handler
      this.changeHandler(normalizedPath, source);
    }
  }

  /**
   * Check if a file is a script file
   */
  private isScriptFile(filePath: string): boolean {
    return filePath.endsWith(".lua") || filePath.endsWith(".luau");
  }

  /**
   * Register a handler for file changes (legacy, content-change only)
   */
  public onChange(handler: FileChangeHandler): void {
    this.changeHandler = handler;
  }

  /**
   * Register a unified handler for all file events (change, add, unlink, addDir, unlinkDir)
   */
  public onEvent(handler: FileEventHandler): void {
    this.eventHandler = handler;
  }

  /**
   * Suppress the next change event for a specific file path (normalized)
   */
  public suppressNextChange(filePath: string, expectedSource?: string): void {
    const normalizedPath = path.resolve(filePath);
    const until = Date.now() + 1000; // 1s window to absorb duplicate events
    this.suppressedUntil.set(normalizedPath, until);

    if (expectedSource !== undefined) {
      this.expectedContents.set(normalizedPath, expectedSource);
      this.lastKnownSource.set(normalizedPath, expectedSource);
    } else {
      this.expectedContents.delete(normalizedPath);
      this.lastKnownSource.delete(normalizedPath);
    }
  }

  /**
   * Suppress the next occurrence of a specific event type for a file path.
   * Used when the daemon creates/deletes files and wants to avoid echo.
   */
  public suppressNextEvent(filePath: string, event: FileEventType): void {
    const normalizedPath = path.resolve(filePath);
    let eventMap = this.suppressedEvents.get(normalizedPath);
    if (!eventMap) {
      eventMap = new Map();
      this.suppressedEvents.set(normalizedPath, eventMap);
    }
    eventMap.set(event, Date.now() + FileWatcher.SUPPRESSION_TTL_MS);
  }

  /**
   * Stop watching
   */
  public async stop(): Promise<void> {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }

    if (this.nativeWatcher) {
      this.nativeWatcher.close();
      this.nativeWatcher = null;
      log.info("File watcher stopped");
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      log.info("File watcher stopped");
    }

    // Clear all pending timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer as NodeJS.Timeout);
      clearImmediate(timer as NodeJS.Immediate);
    }
    this.debounceTimers.clear();
    this.suppressedUntil.clear();
    this.expectedContents.clear();
    this.suppressedEvents.clear();
  }
}
