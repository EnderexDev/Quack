import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StudioOutputMessage, ToolRequestMessage, ToolResultMessage } from "./ipc/messages.js";
import type { IPCServer, PeerRole, PlayRole } from "./ipc/server.js";
import { encodeGif } from "./util/gif.js";
import { encodePng, halve, sheet } from "./util/png.js";

/**
 * Quack: the Studio tools an AI uses most (08/11/26, a month of chrrxs calls): evals in the play
 * server and client, Luau in the edit plugin, play start/stop, screenshots, the play's output,
 * key presses and the device simulator; then a click on a GUI button by its path, a wait until
 * Luau turns truthy or an output line shows up, and a short recording of the play view. Each one
 * is a toolRequest to the right DataModel's Quack plugin: the edit one on its sync socket, a
 * play peer on its /studio-output socket. Every refusal says why: no Studio, no play, no client,
 * an older plugin, a timeout.
 */

export class ToolError extends Error {
  /** No answer at all within the call's time (not an error the peer sent back) */
  timedOut = false;
}

/** How long edit mode gets to answer anything before its plugin counts as older than the tools */
const EDIT_PROBE_MS = 5000;

/** What the daemon's IPC server offers the tools */
export interface ToolLink {
  editConnected(): boolean;
  /** When the edit-mode Studio connected: one probe per connection */
  editSince?(): number | undefined;
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
  /** Edit calls: the connection they were sent on */
  since?: number | true;
}

const LOG_MAX_ENTRIES = 10_000;
const LOG_MAX_BYTES = 4 * 1024 * 1024;
/** What the image block of an MCP answer may weigh; a bigger PNG is halved until it fits */
const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
const SCREENSHOTS_KEPT = 20;
const RECORDINGS_KEPT = 10;
/** A recording's frames on its contact sheet (the picture an AI reads), 4 to a row */
const SHEET_FRAMES = 12;
const SHEET_TILE_MAX_WIDTH = 400;

const LABEL: Record<PeerRole, string> = { edit: "Studio (edit mode)", server: "the play server", client: "the play client" };

export class StudioTools {
  private pending = new Map<string, Pending>();
  private peerWaiters = new Set<() => void>();
  /** wait_for calls with a pattern: woken by each new play output line */
  private logWaiters = new Set<() => void>();
  private log: LogEntry[] = [];
  private logBytes = 0;
  private nextSeq = 1;
  private serverWasReady = false;

  constructor(
    private readonly link: ToolLink,
    private readonly screenshotDir: string,
    private readonly now: () => number = Date.now,
    private readonly recordingDir: string = path.join(path.dirname(screenshotDir), "recordings"),
  ) {}

  /** The tools of a daemon's IPC server: its answers, its play peers and their output feed them */
  static attach(ipc: IPCServer, screenshotDir: string, recordingDir?: string): StudioTools {
    const tools = new StudioTools(
      {
        editConnected: () => ipc.studioLink().connected,
        editSince: () => ipc.studioLink().since,
        playPeers: () => ipc.playPeers(),
        playSockets: () => ipc.playSockets(),
        send: (role, message) => ipc.sendToPeer(role, message),
      },
      screenshotDir,
      Date.now,
      recordingDir,
    );
    ipc.onToolResult((message) => tools.handleResult(message));
    ipc.onPeersChanged(() => tools.peersChanged());
    ipc.onRuntimeLog((message) => tools.runtimeLog(message));
    return tools;
  }

  /** A toolResult from any peer */
  public handleResult(message: ToolResultMessage): void {
    const waiting = this.pending.get(message.id);
    if (!waiting) {
      // An edit-mode answer to a call that already timed out still says its plugin knows the tools
      const since = this.lateEdit.get(message.id);
      if (since !== undefined) {
        this.lateEdit.delete(message.id);
        this.markAnswered(since);
      }
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    // Any answer from edit mode, an error too, is a plugin that knows the tools
    if (waiting.role === "edit") this.markAnswered(waiting.since ?? true);
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
    for (const wake of [...this.logWaiters]) wake();
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
      case "click":
        return this.click(args);
      case "waitFor":
        return this.waitFor(args);
      case "record":
        return this.record(args);
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
    // The connection the call goes out on: an answer is that connection's, whatever reconnects meanwhile
    const since = role === "edit" ? (this.link.editSince?.() ?? true) : undefined;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (since !== undefined) {
          this.lateEdit.set(id, since);
          if (this.lateEdit.size > 100) this.lateEdit.delete(this.lateEdit.keys().next().value!);
          if (tool === "playState" && this.probing === since) this.probeSilent = since;
        }
        // Edit mode that never answered anything on this connection, its probe included (timed
        // out, not still on its way), is most likely a plugin from before the tools; a peer that
        // did answer, or a play peer (it said hello), is just slow
        const silentEdit = since !== undefined && !this.editKnowsTools() && this.probing !== this.currentEdit();
        const why = silentEdit
          ? "edit mode has answered no tool call since it connected: most likely its Quack plugin is older than these tools, so reopen the place in Studio; or Studio is frozen"
          : tool === "eval" || tool === "exec"
            ? "the code may still be running there"
            : "Studio may be busy: try again";
        const error = new ToolError(`${LABEL[role]} did not answer in ${Math.round(timeoutMs / 1000)} s (${why})`);
        error.timedOut = true;
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { role, tool, resolve, reject, timer, since });
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

  /**
   * Has edit mode's plugin answered any tool call since it connected? One from before the tools
   * stays silent, and an `exec` that timed out blamed the code (08/11/26, Anime Astral after the
   * install, its Studio not reopened yet). The connection's time when it did, `true` without one
   */
  private editAnswered: number | true | undefined;
  /** The edit connection now: its time, `true` for a link that does not say */
  private currentEdit(): number | true {
    return this.link.editSince?.() ?? true;
  }
  private editKnowsTools(): boolean {
    return this.editAnswered !== undefined && this.editAnswered === this.currentEdit();
  }
  /** An answer counts for the connection it came on, and only while that one is still the current */
  private markAnswered(since: number | true): void {
    if (since === this.currentEdit()) this.editAnswered = since;
  }

  /**
   * On a connection that has not answered yet, a short call goes along with the code: never
   * waited on (a slow Studio still gets the whole timeout), it only lets a timeout name the cause
   */
  private probing: number | true | undefined; // the connection a probe is on its way for
  private probeSilent: number | true | undefined; // the connection whose probe timed out unanswered: not asked again
  private lateEdit = new Map<string, number | true>(); // edit calls that timed out -> their connection
  private probeEdit(): void {
    if (this.editKnowsTools()) return;
    const since = this.currentEdit();
    if (this.probing === since || this.probeSilent === since) return; // one probe per connection
    this.probing = since;
    this.request("edit", "playState", {}, EDIT_PROBE_MS)
      .catch(() => {
        // its answer, or its silence, is read by editKnowsTools when the code's call ends
      })
      .finally(() => {
        if (this.probing === since) this.probing = undefined;
      });
  }

  private async exec(args: Record<string, any>) {
    StudioTools.code(args);
    this.probeEdit();
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

  /**
   * A GUI button clicked by its instance path in the play client: the plugin computes the point
   * from the button itself (AbsolutePosition + AbsoluteSize / 2 + the GUI inset), clicks it with
   * virtual input and checks its Activated / MouseButton1Click fired; failing that (method auto),
   * selects it and presses Return. chrrxs takes screenshot pixels instead, which miss at 125%.
   */
  private async click(args: Record<string, any>) {
    if (typeof args.path !== "string" || args.path.trim() === "") throw new ToolError("path is required: the button's instance path, like PlayerGui.Shop.Frame.Buy");
    const method = args.method ?? "auto";
    if (!["auto", "input", "select"].includes(method)) throw new ToolError("method must be auto, input or select");
    const started = this.now();
    const result = await this.request("client", "click", { path: args.path.trim(), method }, 15_000);
    return { peer: "client", ...result, ms: this.now() - started };
  }

  /**
   * The code as one wait_for try: its first value comes back as a real boolean ahead of the
   * values themselves (an eval's values are text, where nil, false and "false" look alike). Code
   * with no `return` is an expression and gets one. The code's line 1 stays line 1, so Luau's
   * errors name the caller's lines.
   */
  static truthyCode(code: string): string {
    const body = /\breturn\b/.test(code) ? code : `return ${code}`;
    return `local __quack_w = table.pack((function() ${body}\nend)()) return __quack_w[1] ~= nil and __quack_w[1] ~= false, table.unpack(__quack_w, 1, __quack_w.n)`;
  }

  /**
   * Until a Luau expression turns truthy in the play server or client (one eval per try, every
   * `intervalMs`), or a play output line after `cursor` matches `pattern`, or the deadline.
   * Sessions polled this with evals and sleeps, and a hook blocks a long foreground sleep.
   */
  private async waitFor(args: Record<string, any>) {
    const hasCode = typeof args.code === "string" && args.code.trim() !== "";
    let pattern: RegExp | undefined;
    if (typeof args.pattern === "string" && args.pattern !== "") {
      try {
        pattern = new RegExp(args.pattern);
      } catch (error) {
        throw new ToolError(`pattern is not a regular expression: ${(error as Error).message}`);
      }
    }
    if (!hasCode && !pattern) throw new ToolError("give code (Luau that turns truthy), a pattern (a regular expression for a play output line), or both");
    const peer: PlayRole = args.peer === "client" ? "client" : "server";
    const deadlineMs = StudioTools.timeout(args, 30_000);
    const bounded = (value: unknown, fallback: number, min: number, max: number) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, min), max) : fallback;
    };
    const intervalMs = bounded(args.intervalMs, 250, 50, 60_000);
    const tryMs = bounded(args.tryTimeoutMs, 5000, 100, 120_000);
    let cursor = this.nextSeq - 1;
    if (args.cursor !== undefined && args.cursor !== null && args.cursor !== "") {
      cursor = Number(args.cursor);
      if (!(Number.isInteger(cursor) && cursor >= 0)) throw new ToolError("cursor must be the number a previous read gave");
    }
    const code = hasCode ? StudioTools.truthyCode(args.code) : "";
    const started = this.now();
    const deadline = started + deadlineMs;
    let tries = 0;
    let last: { values?: string[]; error?: string; output?: string[] } | undefined;
    let scanned = cursor;
    const lineFound = (): LogEntry | undefined => {
      if (!pattern) return undefined;
      for (const entry of this.log) {
        if (entry.seq <= scanned) continue;
        scanned = entry.seq;
        if (pattern.test(entry.message)) return entry;
      }
      return undefined;
    };
    const done = (extra: Record<string, unknown>) => ({ ...extra, tries, ms: this.now() - started, cursor: String(this.nextSeq - 1) });
    // The next eval's time: an output line wakes the pattern check, never an early eval
    let nextTry = started;
    for (;;) {
      const line = lineFound();
      if (line) return done({ met: true, by: "pattern", line });
      if (hasCode && this.now() >= nextTry) {
        nextTry = this.now() + intervalMs;
        const why = this.missing(peer);
        // Without a pattern to watch, a peer that is not there ends the wait; with one, the
        // play may still come
        if (why && !pattern) throw new ToolError(tries ? `${why} (after ${tries} tries in ${this.now() - started} ms)` : why);
        if (!why) {
          tries++;
          try {
            const result = await this.request(peer, "eval", { code }, Math.max(100, Math.min(tryMs, deadline - this.now())));
            const values: string[] = Array.isArray(result?.values) ? result.values : [];
            if (result?.ok && values[0] === "true") return done({ met: true, by: "code", peer, values: values.slice(1), output: result.output ?? [] });
            last = result?.ok ? { values: values.slice(1), output: result.output ?? [] } : { error: String(result?.error ?? "the try failed without a reason"), output: result?.output ?? [] };
          } catch (error) {
            if (!(error instanceof ToolError)) throw error;
            if (error.timedOut) last = { error: `the try did not answer in ${Math.round(tryMs)} ms` };
            else if (!pattern) throw new ToolError(`${error.message} (after ${tries} tries in ${this.now() - started} ms)`);
            else last = { error: error.message };
          }
          const after = lineFound();
          if (after) return done({ met: true, by: "pattern", line: after });
        }
      }
      const left = deadline - this.now();
      if (left <= 0) return done({ met: false, ...(hasCode ? { peer } : {}), ...(last ? { last } : {}) });
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.logWaiters.delete(finish);
          resolve();
        };
        // Code: until the next try. A pattern: any new line wakes it sooner
        const timer = setTimeout(finish, hasCode ? Math.max(0, Math.min(nextTry - this.now(), left)) : left);
        if (pattern) this.logWaiters.add(finish);
      });
    }
  }

  /**
   * A short video of the play view: the play client captures every 1/fps s for `seconds` (only
   * content ids), then edit mode reads each frame scaled to `width`, and the daemon writes an
   * animated GIF (frame times as captured) and a contact sheet PNG of up to 12 frames.
   */
  private async record(args: Record<string, any>) {
    const number = (key: string, fallback: number, min: number, max: number, integer = false) => {
      if (args[key] === undefined || args[key] === null) return fallback;
      const n = Number(args[key]);
      if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new ToolError(`${key} must be ${integer ? "a whole number " : ""}from ${min} to ${max}`);
      return n;
    };
    const seconds = number("seconds", 3, 0.5, 15);
    const fps = number("fps", 5, 1, 10);
    const width = number("width", 640, 64, 1920, true);
    let peer: PeerRole;
    if (this.missing("client") === undefined) peer = "client";
    else {
      const why = this.missing("edit");
      if (why) throw new ToolError(why);
      if (this.link.playPeers().server) throw new ToolError(`${this.missing("client")}; a recording needs a Play-mode play (solo_playtest start, mode play) or no play at all`);
      peer = "edit";
    }
    const started = this.now();
    const burst = await this.request<{ frames: { at: number; contentId: string }[]; asked: number; seconds: number; gameFps: number }>(peer, "captureBurst", { seconds, fps }, seconds * 1000 + 20_000);
    if (!Array.isArray(burst?.frames) || burst.frames.length === 0) throw new ToolError("Studio's recording came back without frames");
    const readStarted = this.now();
    const frames: { rgba: Buffer; at: number }[] = [];
    let size: { width: number; height: number; nativeWidth: number; nativeHeight: number } | undefined;
    let skipped = 0;
    let firstError: Error | undefined;
    for (const frame of burst.frames) {
      try {
        const read = await this.request<{ width: number; height: number; data: string; nativeWidth?: number; nativeHeight?: number }>("edit", "captureRead", { contentId: frame.contentId, maxWidth: width }, 15_000);
        size ??= { width: read.width, height: read.height, nativeWidth: read.nativeWidth ?? read.width, nativeHeight: read.nativeHeight ?? read.height };
        const rgba = Buffer.from(read.data, "base64");
        // A frame of another size (the simulator changed mid-recording) does not fit the GIF
        if (read.width !== size.width || read.height !== size.height || rgba.length !== size.width * size.height * 4) {
          skipped++;
          continue;
        }
        frames.push({ rgba, at: Number(frame.at) || 0 });
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        firstError ??= error;
        skipped++;
      }
    }
    if (!frames.length || !size) throw firstError ?? new ToolError("none of the recording's frames could be read");
    const readMs = this.now() - readStarted;
    const span = frames.length > 1 ? frames.at(-1)!.at - frames[0].at : 0;
    const realFps = frames.length > 1 && span > 0 ? (frames.length - 1) / (span / 1000) : 0;
    const typical = frames.length > 1 ? span / (frames.length - 1) : 1000 / fps;
    const gif = encodeGif(
      frames.map((frame, i) => ({ rgba: frame.rgba, delayCs: (i + 1 < frames.length ? frames[i + 1].at - frame.at : typical) / 10 })),
      size.width,
      size.height,
    );
    // The contact sheet: up to 12 frames spread over the recording, each halved to ~400 px wide
    const count = Math.min(SHEET_FRAMES, frames.length);
    const picked = Array.from({ length: count }, (_, i) => frames[count === 1 ? 0 : Math.round((i * (frames.length - 1)) / (count - 1))]);
    let tiles = picked.map((frame) => ({ rgba: frame.rgba, width: size!.width, height: size!.height }));
    while (tiles[0].width > SHEET_TILE_MAX_WIDTH) tiles = tiles.map((t) => halve(t.rgba, t.width, t.height));
    const contact = sheet(tiles.map((t) => t.rgba), tiles[0].width, tiles[0].height, 4);
    const png = encodePng(contact.rgba, contact.width, contact.height);
    fs.mkdirSync(this.recordingDir, { recursive: true });
    const stem = path.join(this.recordingDir, `rec-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}`);
    fs.writeFileSync(`${stem}.gif`, gif);
    fs.writeFileSync(`${stem}-sheet.png`, png);
    this.pruneRecordings();
    return {
      file: `${stem}.gif`,
      sheet: `${stem}-sheet.png`,
      peer,
      frames: frames.length,
      asked: burst.asked,
      skipped,
      seconds: Math.round(Number(burst.seconds) * 100) / 100,
      fps: Math.round(realFps * 10) / 10,
      targetFps: fps,
      gameFps: Math.round(Number(burst.gameFps) * 10) / 10,
      width: size.width,
      height: size.height,
      nativeWidth: size.nativeWidth,
      nativeHeight: size.nativeHeight,
      bytes: gif.length,
      sheetAt: picked.map((frame) => frame.at - frames[0].at),
      readMs,
      ms: this.now() - started,
    };
  }

  private pruneRecordings(): void {
    try {
      const gifs = fs.readdirSync(this.recordingDir).filter((f) => /^rec-.*\.gif$/.test(f)).sort();
      for (const old of gifs.slice(0, Math.max(0, gifs.length - RECORDINGS_KEPT))) {
        fs.rmSync(path.join(this.recordingDir, old), { force: true });
        fs.rmSync(path.join(this.recordingDir, old.replace(/\.gif$/, "-sheet.png")), { force: true });
      }
    } catch {
      // a folder someone else cleans is fine
    }
  }
}
