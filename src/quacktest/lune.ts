import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { BUNDLED } from "../bundled.js";

/**
 * Quack Test's engine: Lune (lune-org/lune, MPL-2.0), one fixed version, run as its own
 * process. The app ships the binary next to the hub (scripts/bundle-hub.mjs); a checkout gets it
 * from `node scripts/fetch-lune.mjs` (npm test runs it), which downloads the release and checks
 * its hash. Lune 0.11.1 was checked against the Anime Astral load sweep on 23/11/26: the same
 * 973 of 1,605 modules load as on 0.10.5, module by module.
 *
 * Nothing runs from where it was installed: the binary and the runtime's Luau files are copied to
 * a folder named by their hash in the cache (engine-<hash>), so a process left holding the exe
 * never stops an update from replacing the app's copy.
 */
export const LUNE_VERSION = "0.11.1";

/** The release's zip for each platform, and its SHA-256 (GitHub's own digest, 23/11/26) */
export const LUNE_ASSETS: Record<string, { zip: string; sha256: string }> = {
  "win32-x64": { zip: "windows-x86_64", sha256: "83f1dc29d9e35c494907521f2ca6561f6c204fdf6f1b06525d2e9fdd1e6b4301" },
  "win32-arm64": { zip: "windows-aarch64", sha256: "1b1394ca2ba4990ecde440cf787ff46f9c52b2c4318a39fa3373fc56b71e7d8a" },
  "linux-x64": { zip: "linux-x86_64", sha256: "39859282ce677fce19e6eb45c37596a90a25c324c95b4e7e02d428b6cae294a1" },
  "linux-arm64": { zip: "linux-aarch64", sha256: "f8d7d63384fad5edfaf5423b0ff1a1dbca9c44ec43beaa35c234b20a584aea66" },
  "darwin-arm64": { zip: "macos-aarch64", sha256: "0592c9b37c06f208f7d90e5d750e76101b9ba6191cd693ef34667f4f1f1063d4" },
  "darwin-x64": { zip: "macos-x86_64", sha256: "d083047e08a40bd73dbb1ae8af929536497c0d57021c0ead0f9c8571f228a5fa" },
};

export const LUNE_EXE = process.platform === "win32" ? "lune.exe" : "lune";

const here = path.dirname(fileURLToPath(import.meta.url));
/** dist/quacktest -> the repository (a checkout running from dist/) */
const repoRoot = path.resolve(here, "..", "..");

/** Where a checkout keeps the downloaded binary */
export function vendorDir(root = repoRoot): string {
  return path.join(root, "vendor", "lune", LUNE_VERSION);
}

/** Quack Test's own cache (trees, engines): per user, shared by Official and Dev */
export function cacheDir(): string {
  if (process.env.QUACK_TEST_CACHE) return process.env.QUACK_TEST_CACHE;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "quack-test");
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "quack-test");
}

/** The Lune binary this Quack runs: QUACK_LUNE, the app's copy, or the checkout's download */
export function findLune(): string | null {
  const candidates = [process.env.QUACK_LUNE, BUNDLED ? path.join(here, LUNE_EXE) : undefined, path.join(vendorDir(), LUNE_EXE)];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

/** The runtime's Luau files by name: the app's flat copies (quacktest-main.luau...) or src/quacktest/runtime */
export function runtimeFiles(): Map<string, string> {
  const out = new Map<string, string>();
  if (BUNDLED) {
    for (const name of fs.readdirSync(here)) {
      const m = /^quacktest-(.+)$/.exec(name);
      if (m) out.set(m[1], path.join(here, name));
    }
    return out;
  }
  const dir = path.join(repoRoot, "src", "quacktest", "runtime");
  for (const name of fs.readdirSync(dir)) out.set(name, path.join(dir, name));
  return out;
}

export interface Engine {
  lune: string;
  main: string;
  dir: string;
}

const engineMemo = new Map<string, Engine>();

/** The engine copied out of the install (see above); null when this Quack has no Lune */
export function engine(): Engine | null {
  const lune = findLune();
  if (!lune) return null;
  const files = runtimeFiles();
  const stamp = [lune, ...files.values()].map((f) => {
    const st = fs.statSync(f);
    return `${f}:${st.size}:${st.mtimeMs}`;
  }).join("|");
  const kept = engineMemo.get(stamp);
  if (kept && fs.existsSync(kept.main) && fs.existsSync(kept.lune)) return kept;
  const hash = createHash("sha256");
  const exe = fs.readFileSync(lune);
  hash.update(exe);
  const sources = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => [name, fs.readFileSync(file)] as const);
  for (const [name, bytes] of sources) hash.update(name).update(bytes);
  const name = `engine-${hash.digest("hex").slice(0, 16)}`;
  // the cache, else the system's temporary folder (a cache that cannot be written: no permission,
  // a full disk)
  let failure: unknown;
  for (const base of [cacheDir(), path.join(os.tmpdir(), "quack-test")]) {
    const dir = path.join(base, name);
    try {
      if (!fs.existsSync(path.join(dir, ".complete"))) {
        // made in a folder of its own and renamed, so two processes never see half of one
        const temp = `${dir}.${process.pid}.${Date.now()}.tmp`;
        fs.mkdirSync(temp, { recursive: true });
        fs.writeFileSync(path.join(temp, LUNE_EXE), exe, { mode: 0o755 });
        for (const [file, bytes] of sources) fs.writeFileSync(path.join(temp, file), bytes);
        fs.writeFileSync(path.join(temp, ".complete"), "");
        try {
          fs.renameSync(temp, dir);
        } catch {
          // another process made it first: theirs is the same bytes
          fs.rmSync(temp, { recursive: true, force: true });
        }
        if (!fs.existsSync(path.join(dir, ".complete"))) throw new Error(`${dir} was not made`);
        pruneEngines(dir);
      }
      const result: Engine = { lune: path.join(dir, LUNE_EXE), main: path.join(dir, "main.luau"), dir };
      engineMemo.set(stamp, result);
      return result;
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(`Quack Test's engine could not be copied out of the install (${(failure as Error).message})`);
}

/** Engines other than the newest few (each edit of the runtime in a checkout makes one) */
function pruneEngines(keep: string): void {
  try {
    const base = path.dirname(keep);
    const engines = fs.readdirSync(base)
      .filter((n) => /^engine-[0-9a-f]+$/.test(n) && path.join(base, n) !== keep)
      .map((n) => ({ dir: path.join(base, n), at: fs.statSync(path.join(base, n)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of engines.slice(3)) fs.rmSync(old.dir, { recursive: true, force: true });
  } catch {
    // a folder in use (an exe still running) stays for the next time
  }
}

/** The one file of a zip (a release holds only the binary), read with no unzip tool */
export function unzipEntry(zip: Buffer, wanted: (name: string) => boolean): Buffer {
  // the end of central directory record, searched from the end (a comment may follow it)
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("bad zip directory");
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataStart, dataStart + compressed);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error(`zip method ${method} not supported`);
  }
  throw new Error("the zip has no such file");
}

/**
 * Downloads the pinned release into `dir` (default the checkout's vendor/lune/<version>), checked
 * against its hash; nothing when the binary is already there. Returns its path.
 */
export async function fetchLune(dir = vendorDir(), platform = `${process.platform}-${process.arch}`): Promise<string> {
  const target = path.join(dir, platform.startsWith("win32") ? "lune.exe" : "lune");
  if (fs.existsSync(target)) return target;
  const asset = LUNE_ASSETS[platform];
  if (!asset) throw new Error(`Lune ${LUNE_VERSION} has no release for ${platform}`);
  const url = `https://github.com/lune-org/lune/releases/download/v${LUNE_VERSION}/lune-${LUNE_VERSION}-${asset.zip}.zip`;
  const response = await fetch(url, { headers: { "user-agent": "quack-test" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const zip = Buffer.from(await response.arrayBuffer());
  const sha = createHash("sha256").update(zip).digest("hex");
  if (sha !== asset.sha256) throw new Error(`${url}: SHA-256 ${sha}, expected ${asset.sha256}`);
  const exe = unzipEntry(zip, (name) => /(^|\/)lune(\.exe)?$/.test(name));
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, exe, { mode: 0o755 });
  fs.renameSync(temp, target);
  return target;
}
