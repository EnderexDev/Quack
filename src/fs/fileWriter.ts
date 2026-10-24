import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { TreeNode } from "./treeManager.js";
import type { FileEventType } from "./watcher.js";
import { config } from "../config.js";
import { diskText } from "../util/scriptFile.js";
import { log } from "../util/log.js";

/**
 * Quack: write through a temp file and a rename, so a reader (an agent, an editor, the
 * watcher) sees the old text or the new one, never the empty file writeFileSync leaves
 * between its truncate and its write (caught by an outside reader on 19/10/26).
 * Falls back to a direct write if the rename is refused (a file held open on Windows).
 */
export function writeFileAtomic(filePath: string, text: string): void {
  // Unpredictable name, created exclusively ("wx" fails on an existing path, a planted
  // symlink included, instead of following it)
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.quack-tmp-${randomBytes(6).toString("hex")}`,
  );
  // The rename replaces the file: the temp file is born with the destination's
  // permissions (POSIX; Windows ignores the mode)
  let mode: number | undefined;
  try {
    mode = fs.statSync(filePath).mode & 0o7777;
  } catch {
    mode = undefined; // a new file: default permissions, as writeFileSync would give it
  }
  try {
    fs.writeFileSync(temp, text, { encoding: "utf-8", flag: "wx", mode: mode ?? 0o666 });
    // The umask may have narrowed the mode at creation; set it exactly, or do not replace
    if (mode !== undefined && process.platform !== "win32") fs.chmodSync(temp, mode);
    fs.renameSync(temp, filePath);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // nothing to clean
    }
    log.debug(`Atomic write fell back to a direct write for ${filePath}:`, error);
    fs.writeFileSync(filePath, text, "utf-8");
  }
}

/**
 * Mapping of GUID to file path
 */
export interface FileMapping {
  guid: string;
  filePath: string;
  className: string;
}

/**
 * Handles writing the virtual tree to the filesystem
 */
export class FileWriter {
  private baseDir: string;
  private fileMappings: Map<string, FileMapping> = new Map();
  private pathToGuid: Map<string, string> = new Map(); // Reverse index for O(1) path lookups
  private eventSuppressor:
    | ((filePath: string, event: FileEventType) => void)
    | null = null;

  constructor(baseDir: string = config.syncDir) {
    this.baseDir = path.resolve(baseDir);
    this.ensureDirectory(this.baseDir);
  }

  /**
   * Register a callback used to suppress watcher echo events for filesystem
   * mutations the daemon performs itself (create/delete of files and folders).
   * Without this, a daemon-originated write/delete is re-observed by the watcher
   * and mistaken for a user action.
   */
  public setEventSuppressor(
    fn: (filePath: string, event: FileEventType) => void,
  ): void {
    this.eventSuppressor = fn;
  }

  private suppressEvent(filePath: string, event: FileEventType): void {
    this.eventSuppressor?.(filePath, event);
  }

  /**
   * Write all script nodes to the filesystem
   */
  public writeTree(nodes: Map<string, TreeNode>, options: { preferDisk?: boolean; mapOnly?: boolean } = {}): { guid: string; source: string }[] {
    log.info("Writing tree to filesystem...");

    // Clear existing mappings
    this.fileMappings.clear();
    this.pathToGuid.clear();

    // Collect all script nodes for batch writing
    const scriptNodes: TreeNode[] = [];
    for (const node of nodes.values()) {
      if (this.isScriptNode(node)) {
        scriptNodes.push(node);
      }
    }

    const diskNewer = this.writeBatch(scriptNodes, options);

    log.success(`Wrote ${this.fileMappings.size} scripts to filesystem`);
    return diskNewer;
  }

  /**
   * Write multiple scripts in a batch for improved I/O efficiency. With `preferDisk` (a daemon
   * starting from its predecessor's tree) a file that differs was edited on disk since that tree
   * was taken: it is kept, the node takes its text, and it is returned for Studio to receive.
   */
  public writeBatch(nodes: TreeNode[], options: { preferDisk?: boolean; mapOnly?: boolean } = {}): { guid: string; source: string }[] {
    const diskNewer: { guid: string; source: string }[] = [];
    if (options.mapOnly) {
      // A successor on standby: where each script lives, without touching the disk another
      // daemon is still writing
      const batchPathToGuid = new Map<string, string>();
      for (const node of nodes) {
        if (!this.isScriptNode(node) || node.source === undefined) continue;
        const filePath = this.getFilePathWithCollisionMap(node, batchPathToGuid);
        batchPathToGuid.set(path.resolve(filePath), node.guid);
        this.fileMappings.set(node.guid, { guid: node.guid, filePath, className: node.className });
        this.pathToGuid.set(path.resolve(filePath), node.guid);
      }
      return diskNewer;
    }
    // Pre-compute all file paths and collect writes
    const writes: { node: TreeNode; filePath: string; dirPath: string }[] = [];
    const dirsToCreate = new Set<string>();
    const batchPathToGuid = new Map<string, string>();

    for (const node of nodes) {
      if (!this.isScriptNode(node) || node.source === undefined) continue;
      const filePath = this.getFilePathWithCollisionMap(node, batchPathToGuid);
      const dirPath = path.dirname(filePath);
      writes.push({ node, filePath, dirPath });
      dirsToCreate.add(dirPath);
      batchPathToGuid.set(path.resolve(filePath), node.guid);
    }

    // Batch create all directories first (sorted by depth to ensure parents exist)
    const sortedDirs = Array.from(dirsToCreate).sort(
      (a, b) => a.length - b.length,
    );
    for (const dir of sortedDirs) {
      this.ensureDirectory(dir);
    }

    for (const { node, filePath } of writes) {
      try {
        // Quack: skip files already identical, as writeScript does. A reconnect to a big game
        // rewrote all 1380 scripts (1.6 s) and woke every editor and luau-lsp watching them.
        let onDisk: string | undefined;
        try {
          onDisk = diskText(fs.readFileSync(filePath, "utf-8"));
        } catch (error) {
          onDisk = undefined;
          // Missing is fine to write; unreadable is not, when the disk may hold a newer edit
          if (options.preferDisk && (error as NodeJS.ErrnoException).code !== "ENOENT") {
            log.warn(`Left ${this.getRelativePath(filePath)} alone: could not read it (${(error as NodeJS.ErrnoException).code})`);
            this.fileMappings.set(node.guid, { guid: node.guid, filePath, className: node.className });
            this.pathToGuid.set(path.resolve(filePath), node.guid);
            continue;
          }
        }
        // Quack: both sides without CR. A script that reached Studio with CRLF (from git, before
        // the watcher kept CRs out) differed from its own file on every connect and was rewritten
        const changed = onDisk !== diskText(node.source!);
        if (onDisk !== undefined && changed && options.preferDisk) {
          node.source = onDisk;
          diskNewer.push({ guid: node.guid, source: onDisk });
          log.info(`Kept ${this.getRelativePath(filePath)}: edited on disk during the handoff`);
        } else if (changed) {
          writeFileAtomic(filePath, node.source!);
          log.script(this.getRelativePath(filePath), "updated");
        }

        this.fileMappings.set(node.guid, {
          guid: node.guid,
          filePath: filePath,
          className: node.className,
        });
        this.pathToGuid.set(path.resolve(filePath), node.guid);
      } catch (error) {
        log.error(`Failed to write script ${filePath}:`, error);
      }
    }
    return diskNewer;
  }

  /**
   * Write or update a single script
   */
  public writeScript(node: TreeNode): string | null {
    if (!this.isScriptNode(node)) {
      return null;
    }

    // Allow empty-string sources on new scripts; only skip if source is truly undefined
    if (node.source === undefined) {
      return null;
    }

    const existingMapping = this.fileMappings.get(node.guid);
    const filePath = this.getFilePath(node);
    const dirPath = path.dirname(filePath);
    const previousPath = existingMapping?.filePath;
    const pathChanged = previousPath && previousPath !== filePath;

    // Ensure directory exists
    this.ensureDirectory(dirPath);

    // Write file, skipping identical content so editors and luau-lsp aren't
    // triggered to re-check a file that didn't change
    try {
      // Quack: the same text with CRLF (git wrote it) counts as unchanged; rewriting it as LF
      // left git showing the file modified with no content change, which blocked the next merge
      const existed = fs.existsSync(filePath);
      const unchanged =
        !pathChanged &&
        existed &&
        diskText(fs.readFileSync(filePath, "utf-8")) === diskText(node.source ?? "");
      if (!unchanged) {
        writeFileAtomic(filePath, node.source);
        log.script(this.getRelativePath(filePath), existed ? "updated" : "created");
      }

      // If the target path changed for this guid, remove the old file to avoid stale copies
      if (pathChanged && previousPath && fs.existsSync(previousPath)) {
        // Suppress the watcher echo for our own delete so it isn't mistaken
        // for a user-initiated removal (which would delete the instance in Studio).
        this.suppressEvent(previousPath, "unlink");
        fs.unlinkSync(previousPath);
        this.pathToGuid.delete(path.resolve(previousPath));
        this.cleanupParentsIfEmpty(path.dirname(previousPath));
      }

      // Update mapping and reverse index
      this.fileMappings.set(node.guid, {
        guid: node.guid,
        filePath: filePath,
        className: node.className,
      });
      this.pathToGuid.set(path.resolve(filePath), node.guid);

      return filePath;
    } catch (error) {
      log.error(`Failed to write script ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Delete a script file
   */
  public deleteScript(guid: string): boolean {
    const mapping = this.fileMappings.get(guid);
    if (!mapping) {
      return false;
    }

    try {
      const deleted = this.deleteFilePathInternal(mapping.filePath);
      this.fileMappings.delete(guid);
      this.pathToGuid.delete(path.resolve(mapping.filePath));
      return deleted;
    } catch (error) {
      log.error(`Failed to delete script ${mapping.filePath}:`, error);
      return false;
    }
  }

  /**
   * Delete a script file by path even if the mapping is missing
   */
  public deleteFilePath(filePath: string): boolean {
    try {
      return this.deleteFilePathInternal(filePath);
    } catch (error) {
      log.error(`Failed to delete script ${filePath}:`, error);
      return false;
    }
  }

  /**
   * Get the filesystem path for a node
   */
  public getFilePath(node: TreeNode): string {
    return this.getFilePathWithCollisionMap(node);
  }

  /**
   * Get the filesystem path for a node, with optional collision map for batch operations
   */
  private getFilePathWithCollisionMap(
    node: TreeNode,
    batchCollisionMap?: Map<string, string>,
  ): string {
    // Build the path from the node's hierarchy. For scripts, we only use the parent path
    // as directories, then add the script file name. This prevents creating an extra
    // folder named after the script itself.
    const parts: string[] = [];

    const dirSegments = this.isScriptNode(node)
      ? node.path.slice(0, Math.max(0, node.path.length - 1))
      : node.path;

    for (const segment of dirSegments) {
      parts.push(this.sanitizeName(segment));
    }

    // If this is a script, add the script name as a file
    if (this.isScriptNode(node)) {
      const scriptName = this.getScriptFileName(node);
      parts.push(scriptName);
    }

    const desiredPath = path.join(this.baseDir, ...parts);
    const normalizedDesiredPath = path.resolve(desiredPath);

    // Check for collisions in both the persistent mappings and the batch collision map
    const existingGuid = this.pathToGuid.get(normalizedDesiredPath);
    const batchGuid = batchCollisionMap?.get(normalizedDesiredPath);
    const collision = existingGuid || batchGuid;

    // If another GUID already owns this path, disambiguate with a suffix that holds across sessions
    if (collision && collision !== node.guid) {
      const dir = path.dirname(desiredPath);
      const uniqueName = this.getDisambiguatedScriptFileName(node, dir, batchCollisionMap);
      return path.join(dir, uniqueName);
    }

    return desiredPath;
  }

  /** Whether a path is mapped to another instance, in this batch or from before */
  private ownedByOther(filePath: string, guid: string, batchCollisionMap?: Map<string, string>): boolean {
    const resolved = path.resolve(filePath);
    const owner = batchCollisionMap?.get(resolved) ?? this.pathToGuid.get(resolved);
    return owner !== undefined && owner !== guid;
  }

  /**
   * Get the appropriate filename for a script node
   */
  private getScriptFileName(node: TreeNode): string {
    const ext = config.scriptExtension;

    // If the script has the same name as its parent, use init pattern
    // const parentName = node.path[node.path.length - 2]; // 2 to get parent
    // if (node.name === parentName) {
    //   log.info(
    //     `Using init file pattern for script ${node.name} because it matches its parent directory name (${parentName}).`
    //   );
    //   return `init${ext}`;
    // }

    let name = this.sanitizeName(node.name);

    if (node.className === "Script") {
      name = `${name}.server`;
    } else if (node.className === "LocalScript") {
      name = `${name}.client`;
    } else if (node.className === "ModuleScript") {
      if (config.suffixModuleScripts) {
        name = `${name}.module`;
      }
    }

    return `${name}${ext}`;
  }

  /**
   * The file name of a script whose plain name a same-named sibling already took, keeping its
   * .server/.client/.module suffix: Name__<x>.server.luau.
   *
   * Quack: the suffix was the instance's guid, which is Studio's debug id and changes when the
   * place is opened again, so these files were renamed on disk at every session (4 of the 5 in
   * the Anime Astral copy, 20/10/26). Now, in order:
   *  1. a file of this name pattern already in the folder, not mapped to another instance, whose
   *     text is this script's: last session's file keeps its name (old guid-suffixed names too)
   *  2. the lowest free number from 2: Name__2, Name__3
   */
  private getDisambiguatedScriptFileName(
    node: TreeNode,
    dir: string,
    batchCollisionMap?: Map<string, string>,
  ): string {
    const baseFileName = this.getScriptFileName(node);
    const ext = config.scriptExtension;

    let rawName = baseFileName;
    let tail = "";
    if (baseFileName.endsWith(ext)) {
      const stem = baseFileName.slice(0, -ext.length);
      const classSuffix = stem.match(/(\.(?:server|client|module))$/)?.[1] ?? "";
      rawName = stem.slice(0, stem.length - classSuffix.length);
      tail = `${classSuffix}${ext}`;
    }
    const named = (suffix: string) => `${rawName}__${suffix}${tail}`;

    if (node.source !== undefined) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        // the folder does not exist yet
      }
      const prefix = `${rawName}__`;
      const candidates = entries
        .filter((entry) => entry.startsWith(prefix) && entry.endsWith(tail) && entry.length > prefix.length + tail.length)
        .filter((entry) => /^[A-Za-z0-9]+$/.test(entry.slice(prefix.length, entry.length - tail.length)))
        .sort();
      for (const entry of candidates) {
        const candidate = path.join(dir, entry);
        if (this.ownedByOther(candidate, node.guid, batchCollisionMap)) continue;
        try {
          if (diskText(fs.readFileSync(candidate, "utf-8")) === diskText(node.source ?? "")) return entry;
        } catch {
          // unreadable: not a match
        }
      }
    }

    for (let n = 2; ; n++) {
      const name = named(String(n));
      if (!this.ownedByOther(path.join(dir, name), node.guid, batchCollisionMap)) return name;
    }
  }

  /**
   * Sanitize a name for use in filesystem
   */
  private sanitizeName(name: string): string {
    // Replace invalid filesystem characters
    return name.replace(/[<>:"|?*]/g, "_");
  }

  /**
   * Public accessor for sanitizeName, so callers building directory paths from
   * raw instance-name segments (e.g. matching against the on-disk tree) apply
   * the same transformation this class uses when it writes those directories.
   */
  public sanitizeSegment(name: string): string {
    return this.sanitizeName(name);
  }

  /**
   * Compute the on-disk directory path for a DataModel path (e.g. a script's
   * own path, to find its nested-scripts children-container directory).
   * Sanitizes each segment the same way script/folder paths are written.
   * Does not check existence or create the directory.
   */
  public getDirPathForSegments(segments: string[]): string {
    return path.join(
      this.baseDir,
      ...segments.map((s) => this.sanitizeName(s)),
    );
  }

  /**
   * Check if a node is a script
   */
  private isScriptNode(node: TreeNode): boolean {
    return (
      node.className === "Script" ||
      node.className === "LocalScript" ||
      node.className === "ModuleScript"
    );
  }

  /**
   * Ensure a directory exists
   */
  private ensureDirectory(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      // Suppress addDir echoes for every directory this recursive mkdir creates,
      // so daemon-created folders don't loop back as user-created folders.
      if (this.eventSuppressor) {
        let current = path.resolve(dirPath);
        while (!fs.existsSync(current)) {
          this.suppressEvent(current, "addDir");
          const parent = path.dirname(current);
          if (parent === current) break;
          current = parent;
        }
      }
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Internal helper to remove a file and clean mapping
   */
  private deleteFilePathInternal(filePath: string): boolean {
    const normalized = path.resolve(filePath);
    let deleted = true;

    if (fs.existsSync(normalized)) {
      try {
        this.suppressEvent(normalized, "unlink");
        fs.unlinkSync(normalized);
        log.script(this.getRelativePath(normalized), "deleted");
      } catch (error) {
        log.warn(`Failed to delete file ${filePath}:`, error);
        deleted = false;
      }
    }

    const guid = this.pathToGuid.get(normalized);
    if (guid) {
      this.fileMappings.delete(guid);
      this.pathToGuid.delete(normalized);
    }

    return deleted;
  }

  /**
   * Get path relative to base directory
   */
  private getRelativePath(filePath: string): string {
    return path.relative(this.baseDir, filePath);
  }

  /**
   * Get file mapping by GUID
   */
  public getMapping(guid: string): FileMapping | undefined {
    return this.fileMappings.get(guid);
  }

  /**
   * Get GUID by file path
   */
  public getGuidByPath(filePath: string): string | undefined {
    return this.pathToGuid.get(path.resolve(filePath));
  }

  /**
   * Update a script's mapping to reflect a file that was already moved/renamed
   * externally (e.g. by an OS-level rename the daemon detected and turned into
   * an instance move). The physical file itself doesn't need touching — it's
   * already at newFilePath — only the internal bookkeeping is stale.
   */
  public remapScript(
    guid: string,
    newFilePath: string,
    className: string,
  ): void {
    const existing = this.fileMappings.get(guid);
    if (existing) {
      this.pathToGuid.delete(path.resolve(existing.filePath));
    }
    this.fileMappings.set(guid, { guid, filePath: newFilePath, className });
    this.pathToGuid.set(path.resolve(newFilePath), guid);
  }

  /**
   * Get all file mappings
   */
  public getAllMappings(): Map<string, FileMapping> {
    return this.fileMappings;
  }

  /**
   * Get the base directory
   */
  public getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * Clean up empty directories that do not correspond to active instances
   */
  public cleanupEmptyDirectories(activeFolderPaths?: Set<string>): void {
    this.cleanupEmptyDirsRecursive(this.baseDir, activeFolderPaths);
  }

  private cleanupEmptyDirsRecursive(
    dirPath: string,
    activeFolderPaths?: Set<string>,
  ): boolean {
    if (!fs.existsSync(dirPath)) {
      return false;
    }

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      // Recursively check subdirectories
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subPath = path.join(dirPath, entry.name);
          this.cleanupEmptyDirsRecursive(subPath, activeFolderPaths);
        }
      }

      // Check if directory is now empty
      const updatedEntries = fs.readdirSync(dirPath);
      if (updatedEntries.length === 0 && dirPath !== this.baseDir) {
        if (activeFolderPaths) {
          const relPath = path
            .relative(this.baseDir, dirPath)
            .replace(/\\/g, "/");
          if (activeFolderPaths.has(relPath)) {
            return false; // Preserve folder instance in Roblox DataModel
          }
        }

        try {
          this.suppressEvent(dirPath, "unlinkDir");
          fs.rmdirSync(dirPath);
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      // Ignore read errors
    }

    return false;
  }

  /**
   * Walk up from a directory and remove empty parents until baseDir is reached.
   */
  private cleanupParentsIfEmpty(startDir: string): void {
    let current = path.resolve(startDir);
    const root = this.baseDir;

    while (current.startsWith(root)) {
      if (current === root) {
        break;
      }

      try {
        const entries = fs.existsSync(current)
          ? fs.readdirSync(current, { withFileTypes: true })
          : [];

        if (entries.length === 0) {
          this.suppressEvent(current, "unlinkDir");
          fs.rmdirSync(current);
          current = path.dirname(current);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }
}
