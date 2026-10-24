import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Who else is syncing a game folder. A folder takes one daemon: two writing the same files would
 * undo each other. Two kinds of owner leave a mark in .quack/:
 * - a standalone daemon started by the old `quack start` script (removed in 1.0) wrote
 *   daemon.pid: the pid, then the folder. Still read: one may run from an older copy
 * - a hub writes hub-lock.json for each daemon it starts (this one too, so two hubs see each other)
 * A mark counts only if its process is alive and listening on a port: a file left by a crash or
 * a reboot (the Astral pid file on 20/10/26 named a dead process) must not block anything.
 */

export interface FolderOwner {
  kind: "standalone" | "hub";
  /** The process to stop for this folder (the daemon) */
  pid: number;
  /** Where it listens: for a standalone daemon the Studio port, for a hub its own port */
  port?: number;
  /** For a hub-owned folder: the hub's pid, so its own daemons are told apart */
  hubPid?: number;
}

export interface HubLock {
  hubPid: number;
  hubPort: number;
  daemonPid: number;
  daemonPort: number;
  since: number;
  /** The daemon's token: the next hub on this port uses it to adopt the daemon (Quack 1.0.10 on) */
  token?: string;
  /** The content id of the daemon's code (DAEMON_BUILD) */
  daemonBuild?: string;
  /** Set by a hub restarting with its daemons (`quack restart-hub --daemons`): replace, not adopt */
  replace?: boolean;
}

const lockFile = (folder: string) => path.join(folder, ".quack", "hub-lock.json");
const pidFile = (folder: string) => path.join(folder, ".quack", "daemon.pid");

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by someone else
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The TCP ports a process listens on (Windows netstat; elsewhere lsof) */
export function listeningPorts(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        if (error) return resolve([]);
        const ports = new Set<number>();
        for (const line of stdout.split(/\r?\n/)) {
          // "  TCP  0.0.0.0:3825  0.0.0.0:0  LISTENING  66220". The state word is localized, so a
          // listening socket is told by its remote address ending in ":0"
          const match = /^\s*TCP\s+\S*:(\d+)\s+(\S+)\s+\S+\s+(\d+)\s*$/i.exec(line);
          if (match && match[2].endsWith(":0") && Number(match[3]) === pid) ports.add(Number(match[1]));
        }
        resolve([...ports]);
      });
    } else {
      // -F n: one "n<address>:<port>" line per listening socket of that pid
      execFile("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid), "-Fn"], { timeout: 5000 }, (error, stdout) => {
        if (error) return resolve([]);
        const ports = new Set<number>();
        for (const line of stdout.split("\n")) {
          const match = /^n.*:(\d+)$/.exec(line.trim());
          if (match) ports.add(Number(match[1]));
        }
        resolve([...ports]);
      });
    }
  });
}

export function readHubLock(folder: string): HubLock | undefined {
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile(folder), "utf8"));
    if ([lock?.hubPid, lock?.hubPort, lock?.daemonPid, lock?.daemonPort].every((n) => Number.isInteger(n))) return lock;
  } catch {
    // none, or unreadable
  }
  return undefined;
}

export function writeHubLock(folder: string, lock: HubLock): void {
  try {
    fs.mkdirSync(path.dirname(lockFile(folder)), { recursive: true });
    fs.writeFileSync(lockFile(folder), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  } catch {
    // the lock is advisory: a folder we cannot mark still syncs
  }
}

/** Removes this daemon's lock, never one another hub wrote since */
export function clearHubLock(folder: string, daemonPid: number | undefined): void {
  const lock = readHubLock(folder);
  if (lock && lock.daemonPid === daemonPid) fs.rmSync(lockFile(folder), { force: true });
}

/**
 * The live owner of a folder other than this hub, if any. `selfHubPid` is this hub's pid, so its
 * own lock never counts.
 */
export async function folderOwner(folder: string, selfHubPid: number): Promise<FolderOwner | undefined> {
  const lock = readHubLock(folder);
  // Its hub need not be alive: daemons outlive their hub now (a restart, an update) and wait to
  // be adopted. Two daemons on one folder would undo each other's writes.
  if (lock && lock.hubPid !== selfHubPid && isAlive(lock.daemonPid)) {
    const ports = await listeningPorts(lock.daemonPid);
    if (ports.includes(lock.daemonPort)) {
      return { kind: "hub", pid: lock.daemonPid, port: lock.hubPort, hubPid: lock.hubPid };
    }
  }
  try {
    const [pidText] = fs.readFileSync(pidFile(folder), "utf8").split(/\r?\n/);
    const pid = Number(pidText?.trim());
    if (isAlive(pid)) {
      const ports = await listeningPorts(pid);
      if (ports.length > 0) return { kind: "standalone", pid, port: ports[0] };
    }
  } catch {
    // no pid file
  }
  return undefined;
}

/** Stops a folder's other owner; for a standalone daemon also clears its pid file */
export async function stopOwner(folder: string, owner: FolderOwner): Promise<void> {
  try {
    process.kill(owner.pid);
  } catch {
    // already gone
  }
  const deadline = Date.now() + 5000;
  while (isAlive(owner.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (owner.kind === "standalone") fs.rmSync(pidFile(folder), { force: true });
  else {
    const lock = readHubLock(folder);
    if (lock && lock.daemonPid === owner.pid) fs.rmSync(lockFile(folder), { force: true });
  }
}
