import { WebSocketServer, WebSocket } from "ws";
import { log } from "../util/log.js";
import type { StudioMessage, DaemonMessage } from "./messages.js";
import { isStudioOutputMessage } from "../studioOutput.js";
import type { SnapshotRequestOptions, PlayVerifyMessage } from "./messages.js";

function isPlayVerifyMessage(value: unknown): value is PlayVerifyMessage {
  const message = value as Partial<PlayVerifyMessage> | null;
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === "playVerify" &&
    typeof message.id === "string" &&
    typeof message.ok === "boolean" &&
    typeof message.passed === "number" &&
    Array.isArray(message.failed)
  );
}
import type { IncomingMessage, Server as HttpServer } from "http";
import {
  getCurrentVersion,
  isVersionCompatible,
  versionToAnnounce,
} from "../util/versionUtils.js";

const DAEMON_VERSION = getCurrentVersion();

export type MessageHandler = (message: StudioMessage) => void;

interface IPCServerOptions {
  requestSnapshotOnConnect?: boolean;
  /** Decides each connection before the upgrade (a hub's daemon asks for its token) */
  verifyClient?: (request: IncomingMessage) => boolean;
}

/** What a Studio's handshake says about itself */
export interface HandshakeInfo {
  session?: string;
  /** It kept its tracking through a drop and can send what changed instead of a snapshot */
  resume: boolean;
}

/** The connected Studio, for the hub's /status */
export interface StudioLink {
  connected: boolean;
  /** The plugin's session id, from its handshake */
  session?: string;
  since?: number;
  /** The last message either way, pings left out */
  lastActivity?: number;
}

export class IPCServer {
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private messageHandler: MessageHandler | null = null;
  private connectionHandler: (() => void) | null = null;
  /** Returns true when the session resumes (no snapshot asked for) */
  private handshakeHandler: ((info: HandshakeInfo) => boolean | void) | null = null;
  /** This connection resumed its session; repeated handshakes are answered the same way */
  private resumed = false;
  private requestSnapshotOnConnect: boolean;
  private pingIntervals = new Map<WebSocket, NodeJS.Timeout>();
  private outputClients = new Set<WebSocket>();
  private closePromise: Promise<void> | null = null;
  private handshakeComplete = false;
  private studioSession?: string;
  private studioSince?: number;
  private lastActivity?: number;
  /**
   * What the disk changed while no Studio was connected. Script edits are sent again once a
   * Studio resumes (the latest text per script); a created, deleted or moved instance cannot be
   * replayed safely, so it makes the next Studio send a snapshot instead of resuming.
   */
  private missedPatches = new Map<string, string>();
  private missedStructure = false;
  /** A successor on standby answers no handshake until it has taken over (holdHandshakes) */
  private handshakeGate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  constructor(port?: number, server?: HttpServer, options?: IPCServerOptions) {
    this.requestSnapshotOnConnect = options?.requestSnapshotOnConnect !== false;
    const verify = options?.verifyClient;
    if (server) {
      // Use existing HTTP server
      this.wss = new WebSocketServer({
        server,
        // perMessageDeflate: false, // Roblox WebSocket client does not negotiate RSV2/RSV3 extensions
        maxPayload: 256 * 1024 * 1024, // 256 MB
        ...(verify ? { verifyClient: (info: { req: IncomingMessage }) => verify(info.req) } : {}),
      });
    } else {
      // Create standalone WebSocket server
      this.wss = new WebSocketServer({
        port: port ?? 3825,
        // perMessageDeflate: false, // avoid RSV2/RSV3 bits from compression
        maxPayload: 256 * 1024 * 1024, // 256 MB
      });
    }
    this.setupServer();
  }

  private setupServer(): void {
    this.wss.on("connection", (ws, request) => {
      if (
        new URL(request.url ?? "/", "http://localhost").pathname ===
        "/studio-output"
      ) {
        this.handleOutputConnection(ws);
        return;
      }

      // One Studio session per daemon: a second one would overwrite the first's files
      if (this.isConnected()) {
        log.warn(
          "Rejected a Studio connection: another Studio session is already syncing with this daemon",
        );
        const busy: DaemonMessage = { type: "daemonBusy" };
        ws.send(JSON.stringify(busy), () => ws.close());
        return;
      }

      log.info("Studio client connected");
      log.info("Waiting for Studio messages...");

      // A previous client that is still closing is replaced
      if (this.client) {
        this.closeOutputClients();
        this.client.close();
      }

      this.client = ws;
      this.handshakeComplete = false;
      this.resumed = false;
      this.studioSession = undefined;
      this.studioSince = Date.now();

      if (this.connectionHandler) {
        this.connectionHandler();
      }

      ws.on("message", (data) => {
        try {
          const message: StudioMessage = JSON.parse(data.toString());
          log.debug(`Received: ${message.type}`);
          if (message.type !== "ping") this.lastActivity = Date.now();

          if (message.type === "handshakeStudio") {
            if (typeof message.session === "string" && message.session.length <= 100) this.studioSession = message.session;
            const handshake = () => this.handleHandshake(message.version, { session: this.studioSession, resume: message.resume === true });
            // On standby: answered once this daemon has taken over, the moment it can resume
            if (this.handshakeGate) void this.handshakeGate.then(() => (this.client === ws ? handshake() : undefined));
            else void handshake();
            return;
          }

          if (this.messageHandler) {
            this.messageHandler(message);
          }
        } catch (error) {
          log.error("Failed to parse message:", error);
          this.sendError("Invalid JSON message");
        }
      });

      ws.on("close", () => {
        const pingInterval = this.pingIntervals.get(ws);
        if (pingInterval) {
          clearInterval(pingInterval);
          this.pingIntervals.delete(ws);
        }

        // A replaced socket closing late must not tear down its successor
        if (this.client !== ws) {
          return;
        }

        log.info("Studio client disconnected");
        this.client = null;
        this.handshakeComplete = false;
        this.studioSession = undefined;
        this.studioSince = undefined;
        this.closeOutputClients();
      });

      ws.on("error", (error) => {
        log.error("WebSocket error:", error);
      });

      // Set up ping/pong to keep connection alive
      ws.on("pong", () => {
        log.debug("Received pong from client");
      });

      // Send ping every 30 seconds
      const pingInterval = setInterval(() => {
        if (this.client === ws && ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          clearInterval(pingInterval);
          this.pingIntervals.delete(ws);
        }
      }, 30000);
      this.pingIntervals.set(ws, pingInterval);

      // Request initial snapshot after a brief delay
      if (this.requestSnapshotOnConnect) {
        setTimeout(() => {
          if (this.client === ws) {
            this.send({ type: "requestSnapshot" });
          }
        }, 100);
      }
    });

    this.wss.on("listening", () => {
      log.success("WebSocket server ready");
    });

    this.wss.on("error", (error) => {
      log.error("WebSocket server error:", error);
    });
  }

  /**
   * Handles the handshake process with the Studio client, verifying version compatibility and sending a handshake acknowledgment.
   * If the versions are incompatible, it tells the client why and disconnects it.
   */
  private async handleHandshake(pluginVersion: string | undefined, info: HandshakeInfo): Promise<void> {
    pluginVersion =
      typeof pluginVersion === "string" ? pluginVersion : undefined;

    if (!pluginVersion || !isVersionCompatible(pluginVersion, DAEMON_VERSION)) {
      const message = `Version mismatch: plugin v${pluginVersion ?? "unknown"}, daemon v${DAEMON_VERSION}. Update both to matching versions.`;

      this.sendError(message);
      this.send({ type: "daemonDisconnect" }); // stops the plugin's sync session
      // Only this Studio goes: the server stays up for a matching plugin (a hub's daemon outlives
      // many connections, and closing the server left it alive but unreachable)
      const client = this.client;
      setTimeout(() => client?.close(), 50);

      log.error(`VERSION MISMATCH:`);
      log.error(
        `- Your Plugin version: ${pluginVersion ?? "unknown (needs update)"}`,
      );
      log.error(`- Your Daemon version: ${DAEMON_VERSION}`);
      log.error(`Make sure both are updated and using matching versions!`);
      if (!pluginVersion) {
        log.error(
          `If the Plugin is up to date but still shows "unknown", please open an issue.`,
        );
      }
      return;
    }

    if (!this.handshakeComplete) {
      this.handshakeComplete = true;
      if (this.handshakeHandler) {
        this.resumed = this.handshakeHandler(info) === true;
      }
    }
    // A 2.4 plugin drops a daemon that says 1.0; it hears the 2.4 it accepts
    this.send({
      type: "handshakeAck",
      version: versionToAnnounce(pluginVersion, DAEMON_VERSION),
      ...(this.resumed ? { resumed: true } : {}),
    });
    // Resumed: the disk edits this Studio missed follow the ack, the latest text of each script
    if (this.resumed && this.missedPatches.size > 0) {
      const patches = [...this.missedPatches];
      this.missedPatches.clear();
      log.info(`Sending ${patches.length} script edit(s) made on disk while Studio was away`);
      for (const [guid, source] of patches) this.patchScript(guid, source);
    }
  }

  /**
   * Register a handler for incoming Studio messages
   */
  public onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Register a handler that fires when a Studio client connects
   */
  public onConnection(handler: () => void): void {
    this.connectionHandler = handler;
  }

  /**
   * Register a handler that fires when Studio completes the handshake
   */
  public onHandshake(handler: (info: HandshakeInfo) => boolean | void): void {
    this.handshakeHandler = handler;
    if (this.handshakeComplete) {
      handler({ session: this.studioSession, resume: false });
    }
  }

  /**
   * Closes the Studio's connection without a word: a plugin that resumes reconnects and sends
   * what it queued (a daemon handing its place to its successor)
   */
  public dropClient(): void {
    this.client?.terminate();
  }

  /**
   * Accept a playtest output relay socket while the main Studio client is connected.
   * Relays are auxiliary: they never replace or affect the main sync connection.
   */
  private handleOutputConnection(ws: WebSocket): void {
    if (!this.client) {
      ws.terminate();
      return;
    }

    if (this.outputClients.size === 0) {
      log.playtest("started");
    }
    this.outputClients.add(ws);

    ws.once("close", () => {
      if (this.outputClients.delete(ws) && this.outputClients.size === 0) {
        log.playtest("ended");
      }
    });

    ws.on("error", (error) => {
      log.error("WebSocket error:", error);
    });

    ws.on("message", (data) => {
      try {
        const message: unknown = JSON.parse(data.toString());
        if (isStudioOutputMessage(message) && this.messageHandler) {
          this.messageHandler(message);
        } else if (isPlayVerifyMessage(message) && this.messageHandler) {
          // Quack: the play session's check of a `quackdev play` comes on the same relay
          this.messageHandler(message);
        }
      } catch (error) {
        log.error("Failed to parse playtest output message:", error);
      }
    });
  }

  /** Terminate every output relay; their close handlers remove them from the set. */
  private closeOutputClients(): void {
    for (const client of this.outputClients) {
      client.terminate();
    }
  }

  /**
   * Send a message to the connected Studio client
   */
  public send(message: DaemonMessage): boolean {
    if (!this.client || this.client.readyState !== WebSocket.OPEN || !this.handshakeComplete) {
      if (message.type === "patchScript") this.missedPatches.set(message.guid, message.source);
      else if (message.type === "createInstance" || message.type === "deleteInstance" || message.type === "moveInstance") this.missedStructure = true;
      if (!this.client || this.client.readyState !== WebSocket.OPEN) {
        log.warn("Cannot send message: no connected client");
        return false;
      }
      // Connected but not handshaken yet: control messages (ack, snapshot request) still go out
      if (message.type === "patchScript" || message.type === "createInstance" || message.type === "deleteInstance" || message.type === "moveInstance") return false;
    }

    try {
      this.client.send(JSON.stringify(message));
      log.debug(`Sent: ${message.type}`);
      if (message.type !== "pong") this.lastActivity = Date.now();
      return true;
    } catch (error) {
      log.error("Failed to send message:", error);
      return false;
    }
  }

  /**
   * Send a patch to update a script's source in Studio
   */
  public patchScript(guid: string, source: string): boolean {
    return this.send({
      type: "patchScript",
      guid,
      source,
    });
  }

  /**
   * Tell Studio to create a new instance (script or folder)
   */
  public createInstance(
    className: string,
    name: string,
    parentPath: string[],
    source?: string,
  ): boolean {
    return this.send({
      type: "createInstance",
      className,
      name,
      parentPath,
      source,
    });
  }

  /**
   * Tell Studio to delete an instance by GUID or path
   */
  public deleteInstance(guid?: string, instancePath?: string[]): boolean {
    return this.send({
      type: "deleteInstance",
      guid,
      path: instancePath,
    });
  }

  /**
   * Tell Studio to move/rename an existing instance by GUID, preserving its
   * descendants (including non-script instances not represented on disk).
   */
  public moveInstance(
    guid: string,
    parentPath: string[],
    name: string,
    className?: string,
    source?: string,
  ): boolean {
    return this.send({
      type: "moveInstance",
      guid,
      parentPath,
      name,
      className,
      source,
    });
  }

  /**
   * Send an error message to Studio
   */
  public sendError(message: string): boolean {
    return this.send({
      type: "error",
      message,
    });
  }

  /**
   * Request a full snapshot from Studio
   */
  public requestSnapshot(options?: SnapshotRequestOptions): boolean {
    return this.send({
      type: "requestSnapshot",
      options,
    });
  }

  /**
   * Check if a client is connected
   */
  public isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  /** The Studio as the hub sees it: connected once its handshake was accepted */
  public studioLink(): StudioLink {
    const connected = this.isConnected() && this.handshakeComplete;
    return {
      connected,
      session: connected ? this.studioSession : undefined,
      since: connected ? this.studioSince : undefined,
      lastActivity: this.lastActivity,
    };
  }

  /** A successor on standby: a Studio may connect, but its handshake waits for releaseHandshakes */
  public holdHandshakes(): void {
    if (this.handshakeGate) return;
    this.handshakeGate = new Promise((resolve) => (this.openGate = resolve));
  }

  public releaseHandshakes(): void {
    const open = this.openGate;
    this.handshakeGate = null;
    this.openGate = null;
    open?.();
  }

  /**
   * Hands the Studio to the successor at `url` (a plugin that follows redirects goes straight
   * there, with what it queued) and lets go of it. Nothing it sends after this is read here.
   */
  public redirectAndDrop(url: string): void {
    const client = this.client;
    if (!client || client.readyState !== WebSocket.OPEN) {
      client?.terminate();
      return;
    }
    // No more of its messages reach this daemon: the successor gets them
    client.removeAllListeners("message");
    // Not waited for: the caller does nothing heavy after this, so the redirect goes out on the
    // next turn of the loop. Waiting for the send callback or the plugin's close cost the 300 ms
    // cap on every switch (measured 21/10/26). The plugin closes the socket on reading it; if it
    // does not, it is cut here, and the daemon's own shutdown cuts it anyway.
    client.send(JSON.stringify({ type: "redirect", url }));
    const cut = setTimeout(() => client.terminate(), 2000);
    cut.unref();
    client.once("close", () => clearTimeout(cut));
  }

  /** Nothing the disk did while Studio was away needs a snapshot: script edits replay */
  public canResume(): boolean {
    return !this.missedStructure;
  }

  /** What Studio has not received yet, for a successor daemon to carry on */
  public missed(): { patches: [string, string][]; structure: boolean } {
    return { patches: [...this.missedPatches], structure: this.missedStructure };
  }

  /** What Studio has not received, replaced (the predecessor's final word at a takeover) */
  public setMissed(patches: Iterable<[string, string]>, structure: boolean): void {
    this.missedPatches = new Map(patches);
    this.missedStructure = structure;
  }

  /** Adds to what Studio has not received (a successor's inheritance, a file edited during a handoff) */
  public addMissed(patches: Iterable<[string, string]>, structure = false): void {
    for (const [guid, source] of patches) this.missedPatches.set(guid, source);
    if (structure) this.missedStructure = true;
  }

  /** A full snapshot from Studio is the truth again: nothing is owed */
  public clearMissed(): void {
    this.missedPatches.clear();
    this.missedStructure = false;
  }

  /** Another Studio took the place over: this one is told why and stops retrying */
  public kick(why: string): void {
    const client = this.client;
    if (!client || client.readyState !== WebSocket.OPEN) return;
    const busy: DaemonMessage = { type: "daemonBusy", message: why };
    client.send(JSON.stringify(busy), () => client.close());
  }

  /**
   * Close the server
   */
  public close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    for (const interval of this.pingIntervals.values()) {
      clearInterval(interval);
    }
    this.pingIntervals.clear();

    if (this.client) {
      this.client.terminate();
      this.client = null;
    }
    this.closeOutputClients();

    this.closePromise = new Promise((resolve) => {
      this.wss.close(() => {
        log.info("WebSocket server closed.");
        resolve();
      });
    });
    return this.closePromise;
  }
}
