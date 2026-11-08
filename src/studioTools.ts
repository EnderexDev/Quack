import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StudioOutputMessage, ToolRequestMessage, ToolResultMessage } from "./ipc/messages.js";
import type { IPCServer, PeerRole, PlayRole } from "./ipc/server.js";
import { encodePng, halve } from "./util/png.js";

/**
 * Quack: the Studio tools an AI uses most (08/11/26, a month of chrrxs calls): evals in the play
 * server and client, Luau in the edit plugin, play start/stop, screenshots, the play's output,
 * key presses and the device simulator. Each one is a toolRequest to the right DataModel's
 * Quack plugin: the edit one on its sync socket, a play peer on its /studio-output socket.
 * Every refusal says why: no Studio, no play, no client, an older plugin, a timeout.
 */

export class ToolError extends Error {}

/** What the daemon's IPC server offers the tools */
export interface ToolLink {
  editConnected(): boolean;
  playPeers(): { server?: "ready" | "old"; client?: "ready" | "old" };
  playSockets(): number;
  send(role: PeerRole, message: ToolRequestMessage): boolean;
}

export interface LogEntry {
  seq: number;
  t: number;
  source: "server" | "client" | "quack";
  type: string;
  message: string;
}

interface Pending {
  role: PeerRole;
  tool: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const LOG_MAX_ENTRIES = 10_000;
const LOG_MAX_BYTES = 4 * 1024 * 1024;
/** What the image block of an MCP answer may weigh; a bigger PNG is halved until it fits */
const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
const SCREENSHOTS_KEPT = 20;

const LABEL: Record<PeerRole, string> = { edit: "Studio (edit mode)", server: "the play server", client: "the play client" };

export class StudioTools {
  private pending = new Map<string, Pending>();
  private peerWaiters = new Set<() => void>();
  private log: LogEntry[] = [];
  private logBytes = 0;
  private nextSeq = 1;
  private serverWasReady = false;

  constructor(
    private readonly link: ToolLink,
    private readonly screenshotDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The tools of a daemon's IPC server: its answers, its play peers and their output feed them */
  static attach(ipc: IPCServer, screenshotDir: string): StudioTools {
    const tools = new StudioTools(
      {
        editConnected: () => ipc.studioLink().connected,
        playPeers: () => ipc.playPeers(),
        playSockets: () => ipc.playSockets(),
        send: (role, message) => ipc.sendToPeer(role, message),
      },
      screenshotDir,
    );
    ipc.onToolResult((message) => tools.handleResult(message));
    ipc.onPeersChanged(() => tools.peersChanged());
    ipc.onRuntimeLog((message) => tools.runtimeLog(message));
    return tools;
  }

  /** A toolResult from any peer */
  public handleResult(message: ToolResultMessage): void {
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.ok) waiting.resolve(message.result ?? null);
    else waiting.reject(new ToolError(typeof message.error === "string" && message.error ? message.error : `${LABEL[waiting.role]} failed without a reason`));
  }

  /** A play peer said hello or closed: a request to a peer that left fails now, not at its timeout */
  public peersChanged(): void {
    const peers = this.link.playPeers();
    const serverReady = peers.server === "ready";
    if (serverReady && !this.serverWasReady) this.push({ source: "quack", type: "MessageInfo", message: "--- play started ---", timestamp: this.now() });
    if (!serverReady && this.serverWasReady) this.push({ source: "quack", type: "MessageInfo", message: "--- play stopped ---", timestamp: this.now() });
    this.serverWasReady = serverReady;
    for (const [id, waiting] of this.pending) {
      if (waiting.role === "edit" || peers[waiting.role] === "ready" || waiting.tool === "stop") continue;
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new ToolError(`the play stopped before ${LABEL[waiting.role]} answered`));
    }
    for (const wake of [...this.peerWaiters]) wake();
  }

  /** One line of the play's output, kept for `logs` whether or not the daemon log shows it */
  public runtimeLog(message: StudioOutputMessage): void {
    if (message.message.startsWith("[Roblox][CorePackages.")) return;
    // The plugin's compile check of an eval: Luau logs the error it also returns to the caller
    if (message.messageType === "MessageError" && message.message.startsWith("__QuackEval:")) return;
    this.push({ source: message.source, type: message.messageType, message: message.message, timestamp: message.timestamp });
  }

  private push(entry: { source: LogEntry["source"]; type: string; message: string; timestamp: number }): void {
    const message = entry.message.length > 16_384 ? `${entry.message.slice(0, 16_384)}... (cut)` : entry.message;
    this.log.push({ seq: this.nextSeq++, t: entry.timestamp, source: entry.source, type: entry.type, message });
    this.logBytes += message.length;
    while (this.log.length > LOG_MAX_ENTRIES || this.logBytes > LOG_MAX_BYTES) this.logBytes -= this.log.shift()!.message.length;
  }

  /** The daemon's /studio: one tool call, by name */
  public async call(tool: string, args: Record<string, any>): Promise<unknown> {
    switch (tool) {
      case "eval":
        return this.evalRuntime(args);
      case "exec":
        return this.exec(args);
      case "playtest":
        return this.playtest(args);
      case "screenshot":
        return this.screenshot();
      case "logs":
        return this.logs(args);
      case "key":
        return this.key(args);
      case "device":
        return this.device(args);
    }
    throw new ToolError(`unknown Studio tool ${tool}`);
  }

  /** Why `role` cannot take a tool call now, or undefined when it can */
  private missing(role: PeerRole): string | undefined {
    if (!this.link.editConnected()) return "Studio is not connected to this place: open it in Studio and wait for the sync to connect";
    if (role === "edit") return undefined;
    const peers = this.link.playPeers();
    if (peers[role] === "ready") return undefined;
    if (peers[role] === "old") return "the play's Quack plugin answers no tools (it is older than these tools): install the new plugin and reopen the place";
    if (role === "client" && peers.server === "ready") return "the play client is not connected: a Run-mode play has no client, or the client's plugin has not loaded yet";
    return "no play is running in this place (start one with solo_playtest, or `playtest start` in the terminal)";
  }

  private request<T = any>(role: PeerRole, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const why = this.missing(role);
    if (why) return Promise.reject(new ToolError(why));
    const id = randomBytes(6).toString("hex");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const why = tool === "eval" || tool === "exec"
          ? "the code may still be running there"
          : "a Quack plugin older than these tools does not answer them: reopen the place with the new plugin";
        reject(new ToolError(`${LABEL[role]} did not answer in ${Math.round(timeoutMs / 1000)} s (${why})`));
      }, timeoutMs);
      this.pending.set(id, { role, tool, resolve, reject, timer });
      if (!this.link.send(role, { type: "toolRequest", id, tool, args })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new ToolError(this.missing(role) ?? `could not send to ${LABEL[role]}`));
      }
    });
  }

  /** Until `done` holds or `ms` pass; re-checked whenever a play peer comes or goes */
  private until(done: () => boolean, ms: number): Promise<boolean> {
    if (done()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (value: boolean) => {
        clearTimeout(timer);
        this.peerWaiters.delete(wake);
        resolve(value);
      };
      const wake = () => {
        if (done()) finish(true);
      };
      const timer = setTimeout(() => finish(done()), ms);
      this.peerWaiters.add(wake);
    });
  }

  private static timeout(args: Record<string, any>, fallbackMs: number): number {
    const value = Number(args.timeoutMs);
    return Number.isFinite(value) && value > 0 ? Math.min(value, 600_000) : fallbackMs;
  }

  private static code(args: Record<string, any>): string {
    if (typeof args.code !== "string" || args.code.trim() === "") throw new ToolError("code is required");
    return args.code;
  }

  private async evalRuntime(args: Record<string, any>) {
    const peer: PlayRole = args.peer === "client" ? "client" : "server";
    const started = this.now();
    const result = await this.request(peer, "eval", { code: StudioTools.code(args) }, StudioTools.timeout(args, 30_000));
    return { peer, ms: this.now() - started, ...result };
  }

  private async exec(args: Record<string, any>) {
    const started = this.now();
    const result = await this.request("edit", "exec", { code: StudioTools.code(args) }, StudioTools.timeout(args, 30_000));
    return { peer: "edit", ms: this.now() - started, ...result };
  }

  private peerState() {
    const peers = this.link.playPeers();
    return { server: peers.server ?? "none", client: peers.client ?? "none" };
  }

  private async playtest(args: Record<string, any>) {
    const action = args.action;
    const started = this.now();
    if (action === "status") {
      if (!this.link.editConnected()) return { editConnected: false, ...this.peerState() };
      const state = await this.request("edit", "playState", {}, 5000);
      return { editConnected: true, playing: state.editModeActive === false, ...this.peerState() };
    }
    if (action === "start") {
      const mode = args.mode === "run" ? "run" : "play";
      await this.request("edit", "playStart", { mode }, 10_000);
      const timeoutMs = StudioTools.timeout(args, 60_000);
      const peers = () => this.link.playPeers();
      const ready = () => peers().server === "ready" && (mode === "run" || peers().client === "ready");
      if (!(await this.until(ready, timeoutMs))) {
        const now = this.peerState();
        throw new ToolError(`the play started, but its Quack plugin did not connect within ${Math.round(timeoutMs / 1000)} s (server: ${now.server}, client: ${now.client}); an older plugin answers no tools`);
      }
      return { action, mode, ms: this.now() - started, ...this.peerState() };
    }
    if (action === "stop") {
      const timeoutMs = StudioTools.timeout(args, 15_000);
      const why = this.missing("server");
      if (why) {
        if (!this.link.editConnected()) throw new ToolError(why);
        const state = await this.request("edit", "playState", {}, 5000);
        if (state.editModeActive !== false) throw new ToolError("no play is running in this place");
        throw new ToolError(`a play is running, but ${why.startsWith("the play's Quack plugin") ? why : "its server has no Quack plugin that answers tools"}: stop it in Studio`);
      }
      // The server's EndTest takes its socket down with it: the answer is the close, not a result
      let failed: Error | undefined;
      this.request("server", "stop", {}, timeoutMs).catch((error: Error) => {
        if (!/play stopped before/.test(error.message)) failed = error;
      });
      const gone = await this.until(() => failed !== undefined || (this.link.playPeers().server !== "ready" && this.link.playPeers().client !== "ready"), timeoutMs);
      if (failed) throw failed;
      if (!gone) throw new ToolError(`the play server was told to stop but its peers were still connected after ${Math.round(timeoutMs / 1000)} s`);
      // Edit mode is back only once Studio has torn the play down
      const deadline = started + timeoutMs;
      for (;;) {
        const state = await this.request("edit", "playState", {}, 5000).catch(() => undefined);
        if (state?.editModeActive === true) break;
        if (this.now() > deadline) throw new ToolError(`the play's peers closed but Studio was not back in edit mode after ${Math.round(timeoutMs / 1000)} s`);
        await new Promise((r) => setTimeout(r, 100));
      }
      return { action, ms: this.now() - started };
    }
    throw new ToolError("action must be start, stop or status");
  }

  private async screenshot() {
    const started = this.now();
    let read: { width: number; height: number; data: string; nativeWidth?: number; nativeHeight?: number };
    let peer: PeerRole;
    if (this.missing("client") === undefined) {
      // The play client renders the viewport; only the edit DataModel may read its pixels back
      const begin = await this.request<{ contentId: string }>("client", "captureBegin", {}, 15_000);
      read = await this.request("edit", "captureRead", { contentId: begin.contentId }, 15_000);
      peer = "client";
    } else {
      const why = this.missing("edit");
      if (why) throw new ToolError(why);
      // A Run-mode play shows its server, which cannot capture; edit mode draws nothing then
      // (measured 08/11/26 in PA: the capture never came back)
      if (this.link.playPeers().server) throw new ToolError(`${this.missing("client")}; a screenshot needs a Play-mode play (solo_playtest start, mode play) or no play at all`);
      read = await this.request("edit", "capture", {}, 20_000);
      peer = "edit";
    }
    if (typeof read?.data !== "string" || !Number.isInteger(read.width) || !Number.isInteger(read.height)) throw new ToolError("Studio's screenshot came back without its pixels");
    let image: { rgba: Buffer; width: number; height: number } = { rgba: Buffer.from(read.data, "base64"), width: read.width, height: read.height };
    let png = encodePng(image.rgba, image.width, image.height);
    while (png.length > SCREENSHOT_MAX_BYTES && image.width > 64) {
      image = halve(image.rgba, image.width, image.height);
      png = encodePng(image.rgba, image.width, image.height);
    }
    fs.mkdirSync(this.screenshotDir, { recursive: true });
    const file = path.join(this.screenshotDir, `shot-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}.png`);
    fs.writeFileSync(file, png);
    this.pruneScreenshots();
    return { file, peer, width: image.width, height: image.height, nativeWidth: read.nativeWidth ?? read.width, nativeHeight: read.nativeHeight ?? read.height, bytes: png.length, ms: this.now() - started };
  }

  private pruneScreenshots(): void {
    try {
      const shots = fs.readdirSync(this.screenshotDir).filter((f) => /^shot-.*\.png$/.test(f)).sort();
      for (const old of shots.slice(0, Math.max(0, shots.length - SCREENSHOTS_KEPT))) fs.rmSync(path.join(this.screenshotDir, old), { force: true });
    } catch {
      // a folder someone else cleans is fine
    }
  }

  /**
   * The play's output after `cursor` (or the last `tail` lines), newest last. `cursor` in the
   * answer is where the next read starts; it survives a stop and a new play.
   */
  public logs(args: Record<string, any>) {
    const cursor = args.cursor === undefined || args.cursor === null || args.cursor === "" ? undefined : Number(args.cursor);
    if (cursor !== undefined && !(Number.isInteger(cursor) && cursor >= 0)) throw new ToolError("cursor must be the number a previous read gave");
    const tail = args.tail === undefined || args.tail === null ? undefined : Number(args.tail);
    if (tail !== undefined && !(Number.isInteger(tail) && tail > 0)) throw new ToolError("tail must be a whole number above 0");
    const peer = args.peer === "server" || args.peer === "client" ? args.peer : undefined;
    const filter = typeof args.filter === "string" && args.filter ? args.filter : undefined;
    const oldest = this.log[0]?.seq ?? this.nextSeq;
    const dropped = cursor !== undefined && cursor + 1 < oldest ? oldest - cursor - 1 : 0;
    let found = this.log.filter((e) => (cursor === undefined || e.seq > cursor) && (!peer || e.source === peer || e.source === "quack") && (!filter || e.message.includes(filter)));
    const limit = tail ?? (cursor === undefined ? 100 : 1000);
    const skipped = Math.max(0, found.length - limit);
    found = found.slice(skipped);
    return { entries: found, cursor: String(this.nextSeq - 1), skipped, dropped, playing: this.link.playPeers().server === "ready" };
  }

  private async key(args: Record<string, any>) {
    const text = typeof args.text === "string" ? args.text : undefined;
    const keyCode = typeof args.keyCode === "string" && args.keyCode ? args.keyCode : undefined;
    if (!text && !keyCode) throw new ToolError("name a key (keyCode, an Enum.KeyCode name like W, Space, E) or give text");
    if (text && keyCode) throw new ToolError("give either a key or text, not both");
    const action = args.action ?? "tap";
    if (!["tap", "press", "release"].includes(action)) throw new ToolError("action must be tap, press or release");
    const duration = args.duration === undefined ? 0.1 : Number(args.duration);
    if (!Number.isFinite(duration) || duration < 0 || duration > 30) throw new ToolError("duration must be between 0 and 30 seconds");
    // A play's client takes the keys when there is one; with no play, the place in edit mode.
    // A Run-mode play has no client and its keys would go nowhere: refused unless asked for edit
    const playing = this.link.playPeers().server !== undefined;
    const peer: PeerRole = args.peer === "edit" ? "edit" : args.peer === "client" || playing || this.missing("client") === undefined ? "client" : "edit";
    const result = await this.request(peer, "key", { keyCode, text, action, duration }, 10_000 + duration * 1000);
    return { peer, ...result };
  }

  private async device(args: Record<string, any>) {
    const settings: Record<string, unknown> = {};
    for (const key of ["deviceId", "orientation", "scalingMode"]) {
      if (args[key] === undefined) continue;
      if (typeof args[key] !== "string" || !args[key]) throw new ToolError(`${key} must be a name`);
      settings[key] = args[key];
    }
    if (args.resolution !== undefined) {
      const { width, height } = args.resolution ?? {};
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new ToolError("resolution must be a width and a height in whole pixels");
      settings.resolution = { width, height };
    }
    if (args.pixelDensity !== undefined) {
      if (typeof args.pixelDensity !== "number" || !(args.pixelDensity > 0)) throw new ToolError("pixelDensity must be a number above 0");
      settings.pixelDensity = args.pixelDensity;
    }
    if (args.stop === true && Object.keys(settings).length) throw new ToolError("stop turns the simulator off; it takes no other setting");
    return this.request("edit", "device", { settings, stop: args.stop === true, list: args.list === true }, 20_000);
  }
}
