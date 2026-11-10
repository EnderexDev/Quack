import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Quack's Open Cloud key, kept so no AI reads it (Ender's call, 09/11/26): encrypted with the
 * Windows user's DPAPI in open-cloud.key next to the registry, never in a text file. The CLI and
 * the app only encrypt (cloud set); only the hub decrypts, keeps the key in memory and calls
 * Roblox. Both hubs share the folder, so Official and Dev share the key.
 *
 * Any program running as the same Windows user can ask DPAPI to decrypt: this keeps the key out
 * of every file an AI reads and every answer it gets, and Ender's hook blocks the decrypt call;
 * real isolation would need another Windows user.
 */

/** DPAPI, swapped in tests */
export interface Dpapi {
  protect(data: Buffer): Promise<Buffer>;
  unprotect(data: Buffer): Promise<Buffer>;
}

/** Ties the blob to Quack: a plain ProtectedData call without it cannot decrypt it */
const ENTROPY = "quack-open-cloud-v1";

/**
 * Windows PowerShell by its absolute path: a bare name is searched in the current folder before
 * System32, so a planted powershell.exe there could read the key or answer an approval
 */
export function powershellExe(): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

const DPAPI_TIMEOUT_MS = 30_000;

function powershell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // -NoProfile: his profile costs seconds; the data goes on stdin, never the command line
    const child = spawn(powershellExe(), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    let out = "";
    let err = "";
    let settled = false;
    const done = (error: Error | undefined, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const timer = setTimeout(() => {
      child.kill();
      done(new Error(`DPAPI did not answer in ${DPAPI_TIMEOUT_MS / 1000} s`));
    }, DPAPI_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => done(e));
    child.on("close", (code) => (code === 0 ? done(undefined, out.trim()) : done(new Error(`DPAPI failed (${code}): ${err.trim().split("\n")[0]}`))));
    child.stdin.on("error", (e) => done(e));
    child.stdin.end(input);
  });
}

const dpapiScript = (method: "Protect" | "Unprotect") =>
  `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; ` +
  `$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ` +
  `$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}'); ` +
  `$o=[Security.Cryptography.ProtectedData]::${method}($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
  `[Console]::Out.Write([Convert]::ToBase64String($o))`;

export const windowsDpapi: Dpapi = {
  async protect(data) {
    return Buffer.from(await powershell(dpapiScript("Protect"), data.toString("base64")), "base64");
  },
  async unprotect(data) {
    return Buffer.from(await powershell(dpapiScript("Unprotect"), data.toString("base64")), "base64");
  },
};

interface VaultFile {
  v: 1;
  /** The key's last 4 characters, for the app to show which key is saved */
  keyEnd?: string;
  savedAt: string;
  /** DPAPI blob, base64 */
  blob: string;
}

export const VAULT_FILE = "open-cloud.key";
const LEGACY_FILE = "open-cloud.env";
const LEGACY_LINE = /^\s*(?:export\s+)?ROBLOX_OPEN_CLOUD_API_KEY\s*=\s*(.*)$/;

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export class Vault {
  private cached: { mtimeMs: number; key: string } | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly dpapi: Dpapi = windowsDpapi,
  ) {}

  get file(): string {
    return path.join(this.dataDir, VAULT_FILE);
  }

  private read(): VaultFile | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return parsed?.v === 1 && typeof parsed.blob === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** What the app shows: whether a key is saved, its last 4, when; never the key */
  info(): { hasKey: boolean; keyEnd?: string; savedAt?: string; legacyPlainKey: boolean } {
    const saved = this.read();
    return { hasKey: Boolean(saved), keyEnd: saved?.keyEnd, savedAt: saved?.savedAt, legacyPlainKey: this.legacyKey() !== undefined };
  }

  /** Encrypts and saves a key ("" clears it). The CLI and the app call this; it never decrypts */
  async set(key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) {
      fs.rmSync(this.file, { force: true });
      this.cached = undefined;
      return;
    }
    if (/\s/.test(trimmed)) throw new Error("an Open Cloud key has no spaces or line breaks");
    const blob = await this.dpapi.protect(Buffer.from(trimmed, "utf8"));
    const record: VaultFile = { v: 1, keyEnd: trimmed.length > 12 ? trimmed.slice(-4) : undefined, savedAt: new Date().toISOString(), blob: blob.toString("base64") };
    writeAtomic(this.file, `${JSON.stringify(record, null, 2)}\n`);
    this.cached = undefined;
    this.dropLegacy();
  }

  /**
   * The key, for the hub only: decrypted once and kept while the file is the same. A key still
   * in plain text in open-cloud.env (before 09/11/26) moves into the vault first.
   */
  async get(): Promise<string | undefined> {
    const legacy = this.legacyKey();
    if (legacy && !this.read()) await this.set(legacy);
    else if (legacy) this.dropLegacy();
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return undefined;
    }
    if (this.cached && this.cached.mtimeMs === stat.mtimeMs) return this.cached.key;
    // Calls at once share one decrypt (one PowerShell), per state of the file
    if (this.decrypting?.mtimeMs === stat.mtimeMs) return this.decrypting.key;
    const saved = this.read();
    if (!saved) return undefined;
    const mtimeMs = stat.mtimeMs;
    const key = this.dpapi.unprotect(Buffer.from(saved.blob, "base64")).then((b) => b.toString("utf8"));
    this.decrypting = { mtimeMs, key };
    try {
      const value = await key;
      this.cached = { mtimeMs, key: value };
      return value;
    } finally {
      if (this.decrypting?.key === key) this.decrypting = undefined;
    }
  }

  private decrypting: { mtimeMs: number; key: Promise<string> } | undefined;

  private legacyKey(): string | undefined {
    try {
      for (const line of fs.readFileSync(path.join(this.dataDir, LEGACY_FILE), "utf8").split(/\r?\n/)) {
        const m = LEGACY_LINE.exec(line);
        if (!m) continue;
        const value = m[1].trim().replace(/^(["'])(.*)\1$/, "$2");
        if (value) return value;
      }
    } catch {
      // no file
    }
    return undefined;
  }

  /** Takes the plain key line out of open-cloud.env, every other line kept */
  private dropLegacy(): void {
    const file = path.join(this.dataDir, LEGACY_FILE);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    const lines = text.split(/\r?\n/);
    const kept = lines.filter((line) => !LEGACY_LINE.test(line));
    if (kept.length !== lines.length) writeAtomic(file, kept.join("\n").replace(/\n*$/, "\n"));
  }
}
