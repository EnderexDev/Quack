import type http from "node:http";
import { isAlive } from "./hub/owners.js";
import type { StudioLink } from "./ipc/server.js";

/**
 * A daemon started by a hub. It outlives the hub on purpose: a hub restart (an update, `quack
 * restart-hub`) leaves it running with its Studio connected, and the next hub adopts it. The
 * hub passes these in the environment, never on the command line other processes can read.
 *   QUACK_HUB_TOKEN  every request and WebSocket must carry it (?token= or x-quack-token)
 *   QUACK_HUB_PID    the hub that started it; once that is gone, see ORPHAN_GRACE_MS
 */
export interface HubLinkOptions {
  token: string;
  hubPid: number;
}

/**
 * How long a daemon whose hub died waits for another hub to adopt it before it stops. Longer
 * than the app takes to start the next hub after an update (installer included), short enough
 * that a hub that crashed for good does not leave a daemon holding the folder for long.
 */
export const ORPHAN_GRACE_MS = 60_000;
const ORPHAN_CHECK_MS = 1_000;

export function readHubLink(env: NodeJS.ProcessEnv = process.env): HubLinkOptions | undefined {
  const token = env.QUACK_HUB_TOKEN;
  const hubPid = Number(env.QUACK_HUB_PID);
  if (!token || token.length < 16 || !Number.isInteger(hubPid) || hubPid <= 0) return undefined;
  return { token, hubPid };
}

/** What the hub reads to list the session, and to check it is adopting the right daemon */
export interface DaemonStatus {
  pid: number;
  folder: string;
  /** The content id of the daemon's code (DAEMON_BUILD), "dist" outside the app's bundle */
  build: string;
  /** A successor still waiting to take over from its predecessor */
  standby?: boolean;
  hubPid: number;
  studio: StudioLink;
  /** From the last full sync */
  scripts?: number;
  instances?: number;
  syncedAt: number | null;
  placeId?: number;
}

const isLoopback = (address: string | undefined) =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
const isWebOrigin = (origin: string | undefined) => !!origin && /^(https?:|null$)/i.test(origin);

export interface HubLinkHandlers {
  status: () => DaemonStatus;
  /** Another Studio took over: tell the connected one why and drop it */
  kick: (why: string) => void;
  /** Stop the daemon (the hub that owns it is closing, pausing, or replacing it) */
  shutdown: () => void;
  /**
   * Write the tree for a successor to start from. "prepare" keeps syncing; "final" and a plain
   * export let the Studio go, and the daemon stops after answering
   */
  export: (request: { phase?: string; successorUrl?: string }) => Promise<{ file: string; session?: string }>;
  /** A successor on standby applies its predecessor's last changes and takes the Studio */
  takeOver: (request: { file?: string }) => Promise<{ applied: number }>;
  /** Quack: `quackdev play`: swap a worktree's scripts into a playtest (POST), or read the last (GET) */
  play?: (request: { worktree: unknown }) => Promise<unknown>;
  playState?: () => unknown;
  /** Script files on disk with no instance in Studio (`quack wait` lists them); fix sends their creates again */
  unsynced?: (fix: boolean) => string[];
}

export class HubLink {
  private orphanSince: number | null = null;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly options: HubLinkOptions,
    private readonly handlers: HubLinkHandlers,
    private readonly log: (line: string) => void,
  ) {}

  get hubPid(): number {
    return this.options.hubPid;
  }

  /** A request or WebSocket upgrade from this machine, not a web page, with the token */
  allows(req: http.IncomingMessage): boolean {
    if (!isLoopback(req.socket.remoteAddress) || isWebOrigin(req.headers.origin)) return false;
    const header = req.headers["x-quack-token"];
    let query: string | null = null;
    try {
      query = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
    } catch {
      return false;
    }
    return header === this.options.token || query === this.options.token;
  }

  /** Answers the hub's requests; false when the request is not one of them */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      // A malformed target must not throw out of the request handler (it would end the daemon)
      res.writeHead(400).end();
      return true;
    }
    const routes = ["/status", "/adopt", "/kick", "/shutdown", "/export", "/takeover", "/play", "/unsynced"];
    if (!routes.includes(url.pathname)) return false;
    const send = (status: number, body: unknown) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!this.allows(req)) {
      send(403, { error: "forbidden" });
      return true;
    }
    if (url.pathname === "/status" && req.method === "GET") {
      send(200, this.handlers.status());
      return true;
    }
    if (url.pathname === "/play" && req.method === "GET") {
      send(200, { play: this.handlers.playState?.() ?? null });
      return true;
    }
    if (url.pathname === "/unsynced" && req.method === "GET") {
      send(200, { files: this.handlers.unsynced?.(false) ?? [] });
      return true;
    }
    if (req.method !== "POST") {
      send(405, { error: "method not allowed" });
      return true;
    }
    // Decoded once, whole: a character split across two chunks (a path with "ú") stays intact
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let parsed: any = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        send(400, { error: "body is not JSON" });
        return;
      }
      if (url.pathname === "/adopt") {
        const hubPid = Number(parsed?.hubPid);
        if (!Number.isInteger(hubPid) || hubPid <= 0) {
          send(400, { error: "hubPid must be a pid" });
          return;
        }
        this.adopt(hubPid);
        send(200, this.handlers.status());
      } else if (url.pathname === "/takeover") {
        this.handlers.takeOver({ file: typeof parsed?.file === "string" ? parsed.file : undefined }).then(
          (result) => send(200, result),
          (error: Error) => send(409, { error: error.message }),
        );
      } else if (url.pathname === "/export" && parsed?.phase === "prepare") {
        // Still syncing afterwards: no stop, and its hub is still watched
        this.handlers.export({ phase: "prepare" }).then(
          (result) => send(200, result),
          (error: Error) => send(500, { error: error.message }),
        );
      } else if (url.pathname === "/export") {
        this.stop();
        // Stops once the answer is out, or once the hub hangs up: never left running unwatched
        let stopped = false;
        const stopOnce = () => {
          if (stopped) return;
          stopped = true;
          this.handlers.shutdown();
        };
        res.once("finish", stopOnce);
        res.once("close", stopOnce);
        this.handlers.export({ phase: typeof parsed?.phase === "string" ? parsed.phase : undefined, successorUrl: typeof parsed?.successorUrl === "string" ? parsed.successorUrl : undefined }).then(
          (result) => send(200, result),
          (error: Error) => send(500, { error: error.message }),
        );
      } else if (url.pathname === "/play") {
        if (!this.handlers.play) {
          send(404, { error: "this daemon cannot play a worktree" });
          return;
        }
        this.handlers.play({ worktree: parsed?.worktree }).then(
          (result) => send(200, { play: result }),
          (error: Error) => send(409, { error: error.message }),
        );
      } else if (url.pathname === "/unsynced") {
        send(200, { files: this.handlers.unsynced?.(true) ?? [] });
      } else if (url.pathname === "/kick") {
        this.handlers.kick(typeof parsed?.why === "string" ? parsed.why.slice(0, 300) : "another Studio took this place over.");
        send(200, { ok: true });
      } else if (url.pathname === "/shutdown") {
        send(200, { ok: true });
        res.once("finish", () => this.handlers.shutdown());
      } else {
        // POST /status: never a reason to stop
        send(405, { error: "method not allowed" });
      }
    });
    return true;
  }

  /** A new hub takes this daemon over: its pid is the one watched from now on */
  adopt(hubPid: number): void {
    if (hubPid !== this.options.hubPid || this.orphanSince !== null) {
      this.log(`Adopted by the hub with pid ${hubPid}`);
    }
    this.options.hubPid = hubPid;
    this.orphanSince = null;
  }

  /** Watches the hub; with none for ORPHAN_GRACE_MS (QUACK_HUB_ORPHAN_MS in tests) the daemon stops */
  watch(graceMs = Number(process.env.QUACK_HUB_ORPHAN_MS) || ORPHAN_GRACE_MS, checkMs = ORPHAN_CHECK_MS): void {
    this.timer = setInterval(() => {
      if (isAlive(this.options.hubPid)) {
        this.orphanSince = null;
        return;
      }
      const now = Date.now();
      if (this.orphanSince === null) {
        this.orphanSince = now;
        this.log(`The hub (pid ${this.options.hubPid}) is gone; waiting ${Math.round(graceMs / 1000)} s for another to adopt this daemon`);
        return;
      }
      if (now - this.orphanSince >= graceMs) {
        this.log("No hub adopted this daemon; stopping");
        this.stop();
        this.handlers.shutdown();
      }
    }, checkMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
