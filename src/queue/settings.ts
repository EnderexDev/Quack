import fs from "node:fs";
import path from "node:path";

/**
 * The Studio queue's timings (Spec "Fila do Studio no Quack", decision 16): one file per hub for
 * every place, set in the app's Settings, and each game's `.claude/studio-test.json` may change
 * them for that game alone. That file is also where a game names its places (`placeIds`) and its
 * readiness test (`readyCheck`); it is the one path in a game's folder the queue reads.
 */
export interface QueueSettings {
  /** Days the queue's history is kept in the place's .quack/queue/; 0 keeps it forever */
  historyDays: number;
  /** A lock with no Studio call for this long frees itself */
  lockIdleMin: number;
  /** The same, while a job or another client waits for Studio */
  lockIdleWaitingMin: number;
  /** A client's hold ends after this long while a job waits behind it */
  capMin: number;
  /** A job that failed in its own code keeps its play this long for the fixed resubmit */
  holdSec: number;
  /** How long a new play gets to be ready (a player, or the game's readyCheck) */
  readySec: number;
  /** Waits before each new try of a job that failed for the infrastructure's sake */
  infraWaitSec: number[];
  /** Tries before such a job is answered as infra */
  infraTries: number;
  /** A play with no jobs left stays up this long for a late job */
  lingerSec: number;
  /** A job that failed in a play shared with other worktrees runs again alone: on every failure, or only one whose error names someone else's module */
  sharedRetry: "all" | "foreign";
  /** A waiting client rises one priority level per this many minutes */
  agingMin: number;
}

export const DEFAULT_SETTINGS: QueueSettings = {
  historyDays: 180,
  lockIdleMin: 15,
  lockIdleWaitingMin: 3,
  capMin: 5,
  holdSec: 60,
  readySec: 30,
  infraWaitSec: [15, 30],
  infraTries: 3,
  lingerSec: 60,
  sharedRetry: "all",
  agingMin: 10,
};

const LIMITS: Record<Exclude<keyof QueueSettings, "sharedRetry" | "infraWaitSec">, [number, number]> = {
  historyDays: [0, 36500],
  lockIdleMin: [0.05, 24 * 60],
  lockIdleWaitingMin: [0.05, 24 * 60],
  capMin: [0.02, 24 * 60],
  holdSec: [0, 3600],
  readySec: [0, 600],
  infraTries: [1, 20],
  lingerSec: [0, 3600],
  agingMin: [0.05, 24 * 60],
};

export class SettingsError extends Error {}

/** The known keys of `input` checked and kept; an unknown key is ignored, a bad value refused */
export function checkSettings(input: Record<string, unknown>, strict = true): Partial<QueueSettings> {
  const out: Partial<QueueSettings> = {};
  if (!input || typeof input !== "object") {
    if (strict) throw new SettingsError("the settings must be an object");
    return out;
  }
  const bad = (key: string, why: string) => {
    if (strict) throw new SettingsError(`${key} ${why}`);
  };
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      bad(key, `must be a number from ${min} to ${max}`);
      continue;
    }
    (out as Record<string, number>)[key] = key === "historyDays" || key === "infraTries" ? Math.round(value) : value;
  }
  if (input.sharedRetry !== undefined) {
    if (input.sharedRetry === "all" || input.sharedRetry === "foreign") out.sharedRetry = input.sharedRetry;
    else bad("sharedRetry", "must be all or foreign");
  }
  if (input.infraWaitSec !== undefined) {
    const list = input.infraWaitSec;
    if (Array.isArray(list) && list.length >= 1 && list.length <= 10 && list.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 3600)) out.infraWaitSec = [...list];
    else bad("infraWaitSec", "must be a list of 1 to 10 numbers of seconds, 0 to 3600");
  }
  return out;
}

/** The hub's file: next to its registry, one per hub, so Official and Dev keep their own */
export function settingsFileFor(registryFile: string): string {
  return registryFile.replace(/\.json$/i, "") + "-queue.json";
}

export function loadSettings(file: string): QueueSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...checkSettings(JSON.parse(fs.readFileSync(file, "utf8")), false) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Merges a checked patch into the file; resolves to the new whole settings */
export function saveSettings(file: string, patch: Record<string, unknown>): QueueSettings {
  const checked = checkSettings(patch);
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // A file holding null, a list or a number is replaced, never a reason to refuse every save
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
  } catch {
    // first save
  }
  const next = { ...checkSettings(current, false), ...checked };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(temp, file);
  return { ...DEFAULT_SETTINGS, ...next };
}

/** What a game's own file says: its timings, its places and its readiness test */
export interface GameConfig {
  overrides: Partial<QueueSettings>;
  placeIds: string[] | null;
  readyCheck: string | null;
}

export const GAME_CONFIG = path.join(".claude", "studio-test.json");

/** The last read of each game's file, kept while its mtime stays the same: the lock reads it every tick */
const gameConfigs = new Map<string, { mtime: number; config: GameConfig }>();

export function readGameConfig(folder: string): GameConfig {
  const file = path.join(folder, GAME_CONFIG);
  let mtime = -1;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    // no file
  }
  const cached = gameConfigs.get(file);
  if (cached && cached.mtime === mtime) return cached.config;
  const config = parseGameConfig(folder);
  gameConfigs.set(file, { mtime, config });
  return config;
}

function parseGameConfig(folder: string): GameConfig {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(folder, GAME_CONFIG), "utf8"));
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch {
    // no file: the hub's settings
  }
  return {
    overrides: checkSettings(raw, false),
    placeIds: Array.isArray(raw.placeIds) ? raw.placeIds.map(String) : null,
    readyCheck: typeof raw.readyCheck === "string" && raw.readyCheck.trim() !== "" ? raw.readyCheck : null,
  };
}

/** The settings a place runs with: the hub's, then its game's file on top */
export function effectiveSettings(global: QueueSettings, folder: string): QueueSettings & { overridden: string[] } {
  const { overrides } = readGameConfig(folder);
  return { ...global, ...overrides, overridden: Object.keys(overrides) };
}
