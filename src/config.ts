import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./util/log.js";

/**
 * Configuration for the sync daemon
 */

export interface QuackConfig {
  //////// Daemon Settings ////////

  /** WebSocket server port */
  port: number;

  /** Enable debug mode */
  debugMode: boolean;

  //////// Sync Settings ////////

  /** Directory where synced files will be stored (relative to project root) */
  syncDir: string;

  /** Path where sourcemap.json is written (relative to project root) */
  sourcemapPath: string;

  /** File extension for scripts */
  scriptExtension: string;

  /** Debounce delay for file watching (ms); 0 = next event-loop turn, no timer */
  fileWatchDebounce: number;

  /** Delete unmapped files in syncDir after a new connection/full snapshot */
  deleteOrphansOnConnect: boolean;

  /** Suffix ModuleScript names with ".module"? */
  suffixModuleScripts: boolean;

  /** Rewrite `@self/` requires to `./instanceName/` when building or pushing */
  rewriteSelfRequires: boolean;

  /** Replicate filesystem actions (create, delete) to Studio during live sync */
  liveFsSync: {
    /** Replicate filesystem create/delete actions to Studio */
    enabled: boolean;

    /**
     * Use polling for file watching instead of native OS events.
     * On Windows, native watching holds open handles on every watched
     * subdirectory, which makes the OS reject renaming any folder that
     * contains a watched subfolder (EPERM). Polling avoids those handles.
     * Defaults to true on Windows, false elsewhere.
     */
    usePolling: boolean;

    /** Interval (ms) used when usePolling is enabled */
    pollInterval: number;

    /**
     * "native" (Quack): one recursive OS watch on the sync root. On Windows that
     * is a single ReadDirectoryChangesW handle on the root, so subfolders stay
     * renameable and events arrive in milliseconds instead of a poll tick.
     * "chokidar": the chokidar watcher (honours usePolling).
     */
    watcher: "native" | "chokidar";
  };

  /**
   * Quack: a Studio edit and a disk edit of the same script that raced are merged
   * (text merge, Luau check, then an AI merge when the check finds new errors).
   */
  merge: {
    /** Merge races at all; off = the last write wins */
    enabled: boolean;
    /** Let an AI CLI merge when the text merge fails the check */
    ai: boolean;
    /** Which CLI merges; "" = the only one installed (none chosen yet) */
    provider: AiProvider | "";
    /** Claude model for the AI merge */
    model: string;
    /** The claude CLI to run */
    claudeBin: string;
    /** Codex model; "" = Codex's own default */
    codexModel: string;
    /** The codex CLI to run */
    codexBin: string;
    /** luau-lsp executable; empty = newest installed by Rokit */
    luauLsp: string;
  };

}

export const defaultConfig: Readonly<QuackConfig> = {
  port: 3825,
  debugMode: false,
  syncDir: "./sync",
  sourcemapPath: "./sourcemap.json",
  scriptExtension: ".luau",
  fileWatchDebounce: 0,
  deleteOrphansOnConnect: true,
  suffixModuleScripts: false,
  rewriteSelfRequires: false,
  liveFsSync: {
    enabled: true,
    usePolling: process.platform === "win32",
    pollInterval: 200,
    watcher: "native",
  },
  merge: {
    enabled: true,
    ai: true,
    provider: "",
    model: "sonnet",
    claudeBin: "claude",
    codexModel: "",
    codexBin: "codex",
    luauLsp: "",
  },
};

export const config: QuackConfig = { ...defaultConfig };

let initialized = false;

export function getUserConfigPath(): string {
  const configRoot = getPlatformConfigRoot();
  return path.join(configRoot, "quack", "config.json");
}

export function initializeConfig(): void {
  if (initialized) {
    return;
  }

  initialized = true;

  const configPath = getUserConfigPath();
  ensureUserConfigExists(configPath);

  const userConfig = readUserConfig(configPath);
  if (!userConfig) {
    return;
  }

  addMissingFields(userConfig);

  Object.assign(config, userConfig);
}

function getPlatformConfigRoot(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }

  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

function ensureUserConfigExists(configPath: string): void {
  try {
    const configDir = path.dirname(configPath);
    fs.mkdirSync(configDir, { recursive: true });

    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(defaultConfig, null, 2)}\n`,
        "utf8",
      );
    }
  } catch (error) {
    log.warn("Failed to initialize the Quack user config file:", error);
  }
}

function addMissingFields(target: Partial<QuackConfig>): void {
  Object.assign(target, { ...defaultConfig, ...target });

  try {
    const configPath = getUserConfigPath();
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(target, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    log.warn("Failed to add missing fields to the Quack user config:", error);
  }
}

function readUserConfig(configPath: string): Partial<QuackConfig> | null {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);

    if (!isRecord(parsed)) {
      return null;
    }

    return sanitizeConfig(parsed);
  } catch (error) {
    log.warn("Failed to read the Quack user config file:", error);
    return null;
  }
}

function sanitizeConfig(input: Record<string, unknown>): Partial<QuackConfig> {
  const sanitized: Partial<QuackConfig> = {};

  // Same range the --port flag accepts; a bigger number would only fail at listen()
  if (isPositiveInteger(input.port) && input.port <= 65535) {
    sanitized.port = input.port;
  }

  if (typeof input.debugMode === "boolean") {
    sanitized.debugMode = input.debugMode;
  }

  if (isNonEmptyString(input.syncDir)) {
    sanitized.syncDir = input.syncDir;
  }

  if (isNonEmptyString(input.sourcemapPath)) {
    sanitized.sourcemapPath = input.sourcemapPath;
  }

  if (isNonEmptyString(input.scriptExtension)) {
    sanitized.scriptExtension = input.scriptExtension;
  }

  // 0 is valid: process on the next turn of the event loop, no timer
  if (
    isPositiveInteger(input.fileWatchDebounce) ||
    input.fileWatchDebounce === 0
  ) {
    sanitized.fileWatchDebounce = input.fileWatchDebounce;
  }

  if (isRecord(input.liveFsSync)) {
    const fs = input.liveFsSync;
    const liveFsSync = { ...defaultConfig.liveFsSync };
    if (typeof fs.enabled === "boolean") liveFsSync.enabled = fs.enabled;
    if (typeof fs.usePolling === "boolean")
      liveFsSync.usePolling = fs.usePolling;
    if (isPositiveInteger(fs.pollInterval))
      liveFsSync.pollInterval = fs.pollInterval;
    if (fs.watcher === "native" || fs.watcher === "chokidar")
      liveFsSync.watcher = fs.watcher;
    sanitized.liveFsSync = liveFsSync;
  }

  if (isRecord(input.merge)) sanitized.merge = sanitizeMerge(input.merge);

  if (typeof input.deleteOrphansOnConnect === "boolean") {
    sanitized.deleteOrphansOnConnect = input.deleteOrphansOnConnect;
  }

  if (typeof input.suffixModuleScripts === "boolean") {
    sanitized.suffixModuleScripts = input.suffixModuleScripts;
  }

  if (typeof input.rewriteSelfRequires === "boolean") {
    sanitized.rewriteSelfRequires = input.rewriteSelfRequires;
  }

  return sanitized;
}

export type AiProvider = "claude" | "codex";

/** A model name reaches a command line (codex runs through cmd.exe): names only */
const MODEL_NAME = /^[\w.:-]+$/;

function sanitizeMerge(m: Record<string, unknown>): QuackConfig["merge"] {
  const merge = { ...defaultConfig.merge };
  if (typeof m.enabled === "boolean") merge.enabled = m.enabled;
  if (typeof m.ai === "boolean") merge.ai = m.ai;
  if (m.provider === "claude" || m.provider === "codex" || m.provider === "") merge.provider = m.provider;
  if (isNonEmptyString(m.model) && MODEL_NAME.test(m.model)) merge.model = m.model;
  if (isNonEmptyString(m.claudeBin)) merge.claudeBin = m.claudeBin;
  if (m.codexModel === "" || (typeof m.codexModel === "string" && MODEL_NAME.test(m.codexModel))) merge.codexModel = m.codexModel;
  if (isNonEmptyString(m.codexBin)) merge.codexBin = m.codexBin;
  if (typeof m.luauLsp === "string") merge.luauLsp = m.luauLsp;
  return merge;
}

/**
 * The merge settings as the file holds them now. The app changes them while daemons run
 * (and the file is shared by both hubs), so a merge reads them fresh instead of trusting
 * the copy loaded at start. A file that cannot be read keeps the loaded copy.
 */
export function readMergeSettings(file = getUserConfigPath()): QuackConfig["merge"] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isRecord(parsed) && isRecord(parsed.merge)) return sanitizeMerge(parsed.merge);
  } catch {
    // missing or half-written: the loaded copy stands
  }
  return config.merge;
}

/** Changes some merge settings in the file, keeping everything else in it */
export function writeMergeSettings(patch: Partial<QuackConfig["merge"]>, file = getUserConfigPath()): QuackConfig["merge"] {
  let whole: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isRecord(parsed)) whole = parsed;
  } catch {
    // no file yet: it starts with the merge section
  }
  const merge = sanitizeMerge({ ...(isRecord(whole.merge) ? whole.merge : {}), ...patch });
  whole.merge = merge;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(whole, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  config.merge = merge;
  return merge;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
