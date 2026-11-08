/**
 * Quack: a second watch on the sync folder that does not lose events, beside the fs.watch one.
 *
 * fs.watch asks Windows for a small buffer: measured 07/11/26, 50 deletes or 10 creates at once
 * overflow it, and so does reading the folder (last-access updates). @parcel/watcher asks for
 * 1 MB and reports an overflow as an error: 30 000 creates and a 30 000-file tree delete arrived
 * whole. But it holds every batch 50 ms (a C++ constant), ~62 ms per save against fs.watch's
 * ~1 ms, so it is the backstop: fs.watch stays the fast path, and the paths an overflow lost
 * arrive here instead of costing a rescan of the whole tree.
 *
 * Windows only (the overflow is a Windows one). Loading it is optional: without the binary the
 * watcher falls back to rescanning on overflow, as before.
 */
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import { createRequire } from "module";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { BUNDLED } from "../bundled.js";

export interface BackstopEvent {
  path: string;
  type: "create" | "update" | "delete";
}

export type BackstopCallback = (err: Error | null, events: BackstopEvent[]) => void;

export interface BackstopSubscription {
  unsubscribe(): Promise<void>;
}

export type BackstopSubscribe = (
  dir: string,
  callback: BackstopCallback,
  ignorePaths: string[],
) => Promise<BackstopSubscription>;

interface ParcelOptions {
  ignorePaths?: string[];
  backend?: string;
}

interface ParcelBinding {
  subscribe(dir: string, fn: BackstopCallback, opts: ParcelOptions): Promise<void>;
  unsubscribe(dir: string, fn: BackstopCallback, opts: ParcelOptions): Promise<void>;
}

/**
 * Always the Windows backend. The default first asks whether Watchman exists by running
 * `watchman` through `cmd.exe` (popen): in a daemon, which has no console, that cmd opened a
 * Terminal window, left open because it exits with an error without Watchman. One per daemon
 * start: 46 windows in one test run (08/11/26).
 */
export const PARCEL_OPTIONS = { backend: "windows" } as const;

const PACKAGE = "@parcel/watcher-win32-x64";
/** The name bundle-hub.mjs gives the binary next to daemon.mjs */
export const BUNDLED_BINARY = "watcher.node";

const require = createRequire(import.meta.url);

/** Where the binary the app (or node_modules) ships is; null when it is not there */
export function shippedBinary(): string | null {
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  if (BUNDLED) {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), BUNDLED_BINARY);
    return fs.existsSync(file) ? file : null;
  }
  try {
    return require.resolve(PACKAGE);
  } catch {
    return null;
  }
}

/**
 * %APPDATA%\quack\native: shared by both hubs, safe because each copy is named by its hash.
 * QUACK_NATIVE_DIR moves it (tests).
 */
export function defaultCopyDir(): string {
  if (process.env.QUACK_NATIVE_DIR) return process.env.QUACK_NATIVE_DIR;
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "quack", "native");
}

/**
 * A loaded .node is a DLL Windows keeps locked, and the installer overwrites the files of a hub
 * that is still running: loading the shipped file in place would make the next update fail.
 * Load a copy named by its content instead, so daemons of the same build share one file and a
 * new build gets its own.
 */
export function copyForLoading(binary: string, copyDir: string): string {
  const bytes = fs.readFileSync(binary);
  const digest = createHash("sha256").update(bytes).digest("hex");
  // Absolute: require() reads a bare relative path as a package name
  const target = path.resolve(copyDir, `watcher-${digest.slice(0, 12)}.node`);
  // Loaded as native code, so reused only when every byte is the shipped one
  const holdsShipped = () => {
    try {
      // Size first: a file of another size is never read whole
      if (fs.statSync(target).size !== bytes.length) return false;
      return createHash("sha256").update(fs.readFileSync(target)).digest("hex") === digest;
    } catch {
      return false;
    }
  };
  if (holdsShipped()) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Written aside and renamed: two daemons starting together never load a half-written file
  // A new name each time, opened exclusively: never writes through a file or link already there
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { flag: "wx" });
    fs.renameSync(temp, target);
  } catch (error) {
    // A failed write (only this attempt's temporary is removed), or another daemon put it there
    // first (loaded, so locked): fine only if what is there is the same bytes
    fs.rmSync(temp, { force: true });
    if (!holdsShipped()) throw error;
  }
  return target;
}

/** The subscribe function, or null when the binary is missing or does not load */
export function loadBackstop(
  binary: string | null = shippedBinary(),
  copyDir: string = defaultCopyDir(),
): { subscribe: BackstopSubscribe; loadedFrom: string } | null {
  if (!binary) return null;
  const loadedFrom = copyForLoading(binary, copyDir);
  const binding = require(loadedFrom) as ParcelBinding;
  const subscribe: BackstopSubscribe = async (dir, callback, ignorePaths) => {
    const opts: ParcelOptions = { ignorePaths, ...PARCEL_OPTIONS };
    await binding.subscribe(dir, callback, opts);
    return { unsubscribe: () => binding.unsubscribe(dir, callback, opts) };
  };
  return { subscribe, loadedFrom };
}
