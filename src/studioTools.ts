import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StudioOutputMessage, ToolRequestMessage, ToolResultMessage } from "./ipc/messages.js";
import type { IPCServer, PeerRole, PlayRole } from "./ipc/server.js";
import { encodeGif } from "./util/gif.js";
import { encodePng, halve, mosaic, sheet } from "./util/png.js";
import { pathOf, RbxlError, readRoblox, resolvePicks, scriptsUnder, summarize, toModelFile, topItems, type FileInstance, type Pick, type RobloxFile } from "./util/rbxl.js";

/**
 * Quack: the Studio tools an AI uses most (08/11/26, a month of chrrxs calls): evals in the play
 * server and client, Luau in the edit plugin, play start/stop, screenshots, the play's output,
 * key presses and the device simulator; then a click on a GUI button by its path, a wait until
 * Luau turns truthy or an output line shows up, and a short recording of the play view; then a
 * GUI's tree, the mouse by pixel, a performance sample, logpoints, .rbxm files both ways and
 * multiplayer tests; then a Creator Store asset previewed or inserted with its scripts stripped,
 * memory by tag, the script profiler and Studio's scene analysis; then what only chrrxs had
 * (09/11/26): the MicroProfiler through LibMP, the place's info, the selection and the edit
 * camera on it, a model from Roblox's generation, and the answer of a call that timed out; then
 * the player's character moved (teleported or walked) and instances found in a running play; plus
 * three read in the daemon itself: whether Studio holds each script's disk text (verify),
 * instances of the synced tree (find) and the calls that timed out (requestStatus). Every answer carries the play errors the
 * caller has not seen, and evals get the place's quack-prelude/<peer>.luau first. Each one
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
  playPeers(): { server?: "ready" | "old"; client?: "ready" | "old"; players?: string[] };
  playSockets(): number;
  /** `player`: which client, in a multiplayer test */
  send(role: PeerRole, message: ToolRequestMessage, player?: string): boolean;
}

/** What the daemon knows of its place, for the tools that read the synced tree instead of Studio */
export interface PlaceView {
  /** Every script file the sync maps to an instance: its guid, path from the sync folder, disk text */
  scripts(): { guid: string; file: string; text: string | undefined }[];
  /** Script files on disk with no instance in Studio (wait's own list) */
  unmapped(): string[];
  /** Every instance of the synced tree */
  nodes(): Iterable<{ guid: string; name: string; className: string; path: string[] }>;
  /** A script's file, from the sync folder */
  fileOf(guid: string): string | undefined;
  /** The files git sees as changed in the sync folder, each marked by whether Studio wrote it */
  changes?(options: { numbersOnly?: boolean }): Promise<unknown>;
}

/** FNV-1a, 32 bits, over UTF-8 bytes: the plugin hashes Studio's text the same way */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(text, "utf8")) {
    h ^= byte;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** A name pattern with * and ? (case-insensitive, whole name) as a RegExp */
function globRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
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
  /** A client call aimed at one player of a multiplayer test */
  player?: string;
  tool: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** Edit calls: the connection they were sent on */
  since?: number | true;
}

interface LateCall {
  tool: string;
  role: PeerRole;
  player?: string;
  state: "pending" | "answered" | "failed" | "lost";
  timedOutAt: number;
  answeredAt?: number;
  result?: unknown;
  /** The answer's size when it was too big to keep */
  tooBig?: number;
  error?: string;
}

/** Calls that timed out, kept for request_status: how many, how long, how big an answer */
const LATE_KEPT = 50;
const LATE_KEPT_MS = 15 * 60_000;
const LATE_RESULT_MAX_CHARS = 1_000_000;

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
    /** quack-prelude/ at the project's root: <peer>.luau goes before every eval there */
    private readonly preludeDir?: string,
  ) {}

  /** The tools of a daemon's IPC server: its answers, its play peers and their output feed them */
  static attach(ipc: IPCServer, screenshotDir: string, recordingDir?: string, preludeDir?: string): StudioTools {
    const tools = new StudioTools(
      {
        editConnected: () => ipc.studioLink().connected,
        editSince: () => ipc.studioLink().since,
        playPeers: () => ipc.playPeers(),
        playSockets: () => ipc.playSockets(),
        send: (role, message, player) => ipc.sendToPeer(role, message, player),
      },
      screenshotDir,
      Date.now,
      recordingDir,
      preludeDir,
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
      // ...and its answer is kept for request_status
      const late = this.late.get(message.id);
      if (late && late.state === "pending") {
        late.state = message.ok ? "answered" : "failed";
        late.answeredAt = this.now();
        if (message.ok) {
          const json = JSON.stringify(message.result ?? null);
          if (json.length > LATE_RESULT_MAX_CHARS) late.tooBig = json.length;
          else late.result = message.result ?? null;
        } else late.error = typeof message.error === "string" && message.error ? message.error : `${LABEL[late.role]} failed without a reason`;
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
    if (!serverReady) this.multiplayer = undefined;
    for (const [id, waiting] of this.pending) {
      const playerGone = waiting.player !== undefined && !(peers.players ?? []).includes(waiting.player);
      if (waiting.role === "edit" || (peers[waiting.role] === "ready" && !playerGone) || waiting.tool === "stop") continue;
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new ToolError(`the play stopped before ${LABEL[waiting.role]} answered`));
    }
    // A timed-out call to a play peer that left never gets its answer
    for (const late of this.late.values()) {
      if (late.state !== "pending" || late.role === "edit") continue;
      const playerGone = late.player !== undefined && !(peers.players ?? []).includes(late.player);
      if (peers[late.role] === "ready" && !playerGone) continue;
      late.state = "lost";
      late.answeredAt = this.now();
      late.error = `the play stopped before ${LABEL[late.role]} answered: whatever the call had done by then stays done`;
    }
    for (const wake of [...this.peerWaiters]) wake();
  }

  /**
   * Calls that timed out, by request id, for request_status: still pending, answered later (the
   * answer kept, up to LATE_RESULT_MAX_CHARS), failed, or lost with the play. A timeout ends
   * only the wait: the code may still be running in Studio, and sending it again runs it twice
   * (chrrxs's get_request_status, 3 calls in a month).
   */
  private late = new Map<string, LateCall>();

  private keepLate(id: string, tool: string, role: PeerRole, player: string | undefined): void {
    this.pruneLate();
    this.late.set(id, { tool, role, player, state: "pending", timedOutAt: this.now() });
    while (this.late.size > LATE_KEPT) this.late.delete(this.late.keys().next().value!);
  }

  private pruneLate(): void {
    const now = this.now();
    for (const [id, late] of this.late) if (now - late.timedOutAt > LATE_KEPT_MS) this.late.delete(id);
  }

  /** What became of a call that timed out: request_status */
  private requestStatus(args: Record<string, any>) {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!/^[0-9a-f]{12}$/.test(id)) throw new ToolError("id must be the request id a timeout named (12 hex digits)");
    this.pruneLate();
    const late = this.late.get(id);
    if (!late) {
      return { id, state: "unknown", note: `no call that timed out has this id in the last ${LATE_KEPT_MS / 60_000} min (or the daemon restarted since): Quack cannot say whether it ran; read its effect in Studio before sending it again` };
    }
    const now = this.now();
    return {
      id,
      state: late.state,
      tool: late.tool,
      peer: late.role,
      ...(late.player ? { player: late.player } : {}),
      timedOutAgoMs: now - late.timedOutAt,
      ...(late.answeredAt !== undefined ? { answeredAfterTimeoutMs: late.answeredAt - late.timedOutAt } : {}),
      ...(late.state === "answered" ? (late.tooBig ? { note: `the answer came (${late.tooBig} characters of JSON), too big to keep` } : { result: late.result }) : {}),
      ...(late.error ? { error: late.error } : {}),
      ...(late.state === "pending" ? { note: `${LABEL[late.role]} has not answered yet: the call may still be running there` } : {}),
    };
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

  /**
   * The daemon's /studio: one tool call, by name. Every answer but the log's own carries the play
   * errors logged since the same caller's previous call (`caller`: one per MCP process, "cli" for
   * the terminal), so an error the game threw meanwhile is seen without reading the log.
   */
  public async call(tool: string, args: Record<string, any>): Promise<unknown> {
    const caller = typeof args.caller === "string" && args.caller ? args.caller.slice(0, 80) : "cli";
    if (args.player !== undefined && (typeof args.player !== "string" || !args.player)) throw new ToolError("player must be a player's name (Player1, Player2... in a multiplayer test)");
    // The client calls of this one go to that player's client
    const result = await this.callPlayer.run(args.player || undefined, () => this.run(tool, args));
    if (tool === "logs") {
      this.errorCursors.set(caller, this.nextSeq - 1);
      return result;
    }
    const { listed: newErrors, repeated } = this.errorsSince(caller);
    if (!result || typeof result !== "object" || Array.isArray(result) || (!newErrors.length && !repeated)) return result;
    return { ...result, ...(newErrors.length ? { newErrors } : {}), ...(repeated ? { repeatedErrors: repeated } : {}) };
  }

  private place: PlaceView | undefined;
  /** The daemon's view of its place, for verify and find */
  public setPlace(place: PlaceView): void {
    this.place = place;
  }

  /** Where each caller last saw the play's errors (its log seq) */
  private errorCursors = new Map<string, number>();
  /** The errors each caller was already shown (a game retrying a DataStore logs the same one every second) */
  private errorsShown = new Map<string, Set<string>>();

  /** newErrors, minus the ones this caller was already shown: those only counted in `repeated` */
  private errorsSince(caller: string): { listed: { source: string; message: string; count: number; at?: string }[]; repeated: number } {
    const shown = this.errorsShown.get(caller) ?? new Set<string>();
    this.errorsShown.set(caller, shown);
    if (this.errorsShown.size > 200) this.errorsShown.delete(this.errorsShown.keys().next().value!);
    const listed: { source: string; message: string; count: number; at?: string }[] = [];
    let repeated = 0;
    for (const group of this.newErrors(caller, 50)) {
      const key = `${group.source} ${group.message}`;
      if (shown.has(key)) {
        repeated += group.count;
        continue;
      }
      if (listed.length < 5) {
        listed.push(group);
        shown.add(key);
      } else repeated += group.count;
    }
    if (shown.size > 500) for (const key of [...shown].slice(0, shown.size - 500)) shown.delete(key);
    return { listed, repeated };
  }

  /**
   * The play's errors after the caller's cursor, grouped by their first line (a loop's error
   * once, with its count), at most 5 groups; the cursor moves to now. A caller's first call
   * reads from the start of the current play.
   */
  public newErrors(caller: string, groupsMax = 5): { source: string; message: string; count: number; at?: string }[] {
    let from = this.errorCursors.get(caller);
    if (from === undefined) {
      // From the last play's start, running or ended; a play whose marker the log's limit dropped:
      // from the oldest line still kept (the log holds only plays' lines)
      from = this.log.length ? this.log[0].seq - 1 : this.nextSeq - 1;
      for (let i = this.log.length - 1; i >= 0; i--) {
        if (this.log[i].source === "quack" && this.log[i].message === "--- play started ---") {
          from = this.log[i].seq;
          break;
        }
      }
    }
    this.errorCursors.set(caller, this.nextSeq - 1);
    if (this.errorCursors.size > 200) this.errorCursors.delete(this.errorCursors.keys().next().value!);
    const groups = new Map<string, { source: string; message: string; count: number; at?: string }>();
    let afterError: { source: string; message: string; count: number; at?: string } | undefined;
    for (const entry of this.log) {
      if (entry.seq <= from) continue;
      if (entry.type === "MessageError" && entry.source !== "quack") {
        const first = entry.message.split("\n")[0].slice(0, 300);
        const key = `${entry.source}\u0000${first}`;
        const group = groups.get(key) ?? { source: entry.source, message: first, count: 0 };
        group.count++;
        groups.set(key, group);
        afterError = group.count === 1 ? group : undefined;
        continue;
      }
      // Roblox logs an error's stack as info lines after it: the first "Script '...', Line N" is where
      if (afterError && !afterError.at && entry.source === afterError.source) {
        const where = /^Script '([^']+)', Line (\d+)/.exec(entry.message);
        if (where) {
          afterError.at = `${where[1]}:${where[2]}`;
          afterError = undefined;
        } else if (entry.message !== "Stack Begin") afterError = undefined;
      }
    }
    return [...groups.values()].slice(0, groupsMax);
  }

  private async run(tool: string, args: Record<string, any>): Promise<unknown> {
    switch (tool) {
      case "eval":
        return this.evalRuntime(args);
      case "exec":
        return this.exec(args);
      case "playtest":
        return this.playtest(args);
      case "screenshot":
        return this.screenshot(args);
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
      case "gui":
        return this.gui(args);
      case "verify":
        return this.verify(args);
      case "perf":
        return this.perf(args);
      case "logpoint":
        return this.logpoint(args);
      case "exportRbxm":
        return this.exportRbxm(args);
      case "importRbxm":
        return this.importRbxm(args);
      case "inspect":
        return this.inspect(args);
      case "setProps":
        return this.setProps(args);
      case "simulate":
        return this.simulate(args);
      case "tabs":
        return this.tabs(args);
      case "devices":
        return this.devices(args);
      case "profile":
        return this.profile(args);
      case "find":
        return this.find(args);
      case "mouse":
        return this.mouse(args);
      case "assetPreview":
        return this.assetPreview(args);
      case "assetInsert":
        return this.assetInsert(args);
      case "memory":
        return this.memory(args);
      case "profiler":
        return this.profiler(args);
      case "scene":
        return this.scene(args);
      case "requestStatus":
        return this.requestStatus(args);
      case "placeInfo":
        return this.placeInfo(args);
      case "selection":
        return this.selection(args);
      case "generate":
        return this.generate(args);
      case "micro":
        return this.micro(args);
      case "move":
        return this.move(args);
      case "changes":
        return this.changes(args);
    }
    throw new ToolError(`unknown Studio tool ${tool}`);
  }

  /** The player a call's client requests go to (a multiplayer test), set for the whole call */
  private callPlayer = new AsyncLocalStorage<string | undefined>();
  /** The players a multiplayer test was started with, until its server leaves */
  private multiplayer: number | undefined;

  /** Why `role` cannot take a tool call now, or undefined when it can */
  private missing(role: PeerRole): string | undefined {
    if (!this.link.editConnected()) return "Studio is not connected to this place: open it in Studio and wait for the sync to connect";
    if (role === "edit") return undefined;
    const peers = this.link.playPeers();
    const player = role === "client" ? this.callPlayer.getStore() : undefined;
    if (player !== undefined && peers.client === "ready" && !(peers.players ?? []).includes(player)) {
      return `no play client of ${player} is connected (clients: ${(peers.players ?? []).join(", ") || "none that say their player"})`;
    }
    if (peers[role] === "ready") return undefined;
    if (peers[role] === "old") return "the play's Quack plugin answers no tools (it is older than these tools): install the new plugin and reopen the place";
    if (role === "client" && peers.server === "ready") return "the play client is not connected: a Run-mode play has no client, or the client's plugin has not loaded yet";
    return "no play is running in this place (start one with solo_playtest, or `playtest start` in the terminal)";
  }

  /** `unkept`: a timeout keeps no id for get_request_status (wait_for's tries: a 600 s wait would push real calls out of the 50 kept) */
  private request<T = any>(role: PeerRole, tool: string, args: Record<string, unknown>, timeoutMs: number, unkept = false): Promise<T> {
    const why = this.missing(role);
    if (why) return Promise.reject(new ToolError(why));
    const id = randomBytes(6).toString("hex");
    // The connection the call goes out on: an answer is that connection's, whatever reconnects meanwhile
    const since = role === "edit" ? (this.link.editSince?.() ?? true) : undefined;
    const player = role === "client" ? this.callPlayer.getStore() : undefined;
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
        // A play-state question has no answer worth keeping (the probe, status, stop)
        const kept = !unkept && tool !== "playState";
        if (kept) this.keepLate(id, tool, role, player);
        const error = new ToolError(`${LABEL[role]} did not answer in ${Math.round(timeoutMs / 1000)} s (${why})${kept ? `. Request ${id}: get_request_status (the terminal's \`result ${id}\`) gives its answer if it comes later; check it before sending the call again` : ""}`);
        error.timedOut = true;
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { role, tool, resolve, reject, timer, since, player });
      if (!this.link.send(role, { type: "toolRequest", id, tool, args }, player)) {
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
    const prelude = this.prelude(peer, args);
    const result = await this.request(peer, "eval", { code: StudioTools.code(args), ...prelude.args }, StudioTools.timeout(args, 30_000));
    return { peer, ms: this.now() - started, ...prelude.note, ...result };
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
    const prelude = this.prelude("edit", args);
    const result = await this.request("edit", "exec", { code: StudioTools.code(args), ...prelude.args }, StudioTools.timeout(args, 30_000));
    return { peer: "edit", ms: this.now() - started, ...prelude.note, ...result };
  }

  /**
   * The place's prelude for `peer` (quack-prelude/server.luau, client.luau, edit.luau at the
   * project's root, next to the sourcemap): Luau put before the code of every eval, so a game
   * names its player, services and modules once instead of in every call (2744 of the evals of a
   * month began with GetPlayers()[1]). `prelude: false` leaves it out.
   */
  private prelude(peer: PeerRole, args: Record<string, any>): { args: { prelude?: string }; note: { prelude?: string } } {
    if (!this.preludeDir || args.prelude === false) return { args: {}, note: {} };
    const file = path.join(this.preludeDir, `${peer}.luau`);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
    } catch {
      return { args: {}, note: {} };
    }
    if (!text.trim()) return { args: {}, note: {} };
    return { args: { prelude: text }, note: { prelude: `quack-prelude/${peer}.luau` } };
  }

  private peerState() {
    const peers = this.link.playPeers();
    return { server: peers.server ?? "none", client: peers.client ?? "none", ...(peers.players && peers.players.length > 1 ? { players: peers.players } : {}) };
  }

  /** A capture is read by edit mode, which cannot open a multiplayer client's (another process) */
  private refuseMultiplayerCapture(what: string): void {
    if (this.multiplayer !== undefined || (this.link.playPeers().players?.length ?? 0) > 1) {
      throw new ToolError(`${what} needs a solo play: in a multiplayer test each player is another Studio process, whose captures edit mode cannot read`);
    }
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
      // players: a multiplayer test (Studio's Local Server: a server and one Studio window a player)
      const players = args.players === undefined || args.players === null ? undefined : Number(args.players);
      if (players !== undefined && (!Number.isInteger(players) || players < 1 || players > 8)) throw new ToolError("players must be a whole number from 1 to 8");
      if (players !== undefined && mode === "run") throw new ToolError("a multiplayer test has clients: leave out mode run");
      await this.request("edit", "playStart", { mode, ...(players !== undefined ? { players } : {}) }, 10_000);
      const timeoutMs = StudioTools.timeout(args, players ? 120_000 : 60_000);
      const peers = () => this.link.playPeers();
      const ready = () => peers().server === "ready" && (mode === "run" || peers().client === "ready") && (players === undefined || (peers().players?.length ?? 0) >= players);
      if (!(await this.until(ready, timeoutMs))) {
        const now = this.peerState();
        const joined = players !== undefined ? `, players: ${peers().players?.join(", ") || "none"} of ${players}` : "";
        throw new ToolError(`the play started, but its Quack plugin did not connect within ${Math.round(timeoutMs / 1000)} s (server: ${now.server}, client: ${now.client}${joined}); an older plugin answers no tools`);
      }
      if (players !== undefined) this.multiplayer = players;
      return { action, mode, ms: this.now() - started, ...this.peerState(), ...(players !== undefined ? { players: peers().players } : {}) };
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

  /**
   * The viewport as a PNG. `width`: at most this many pixels wide (the model reading the image is
   * charged by its pixels). `focus`: a GUI object's path keeps only the part of the screen it
   * covers; a part's or a model's moves the camera onto it for the capture.
   */
  private async screenshot(args: Record<string, any> = {}) {
    const focus = typeof args.focus === "string" && args.focus.trim() ? args.focus.trim() : undefined;
    let width: number | undefined;
    if (args.width !== undefined && args.width !== null) {
      width = Number(args.width);
      if (!Number.isInteger(width) || width < 64 || width > 4096) throw new ToolError("width must be a whole number from 64 to 4096");
    }
    const started = this.now();
    let read: { width: number; height: number; data: string; nativeWidth?: number; nativeHeight?: number };
    let peer: PeerRole;
    let rect: { x: number; y: number; w: number; h: number } | undefined;
    if (this.missing("client") === undefined) {
      this.refuseMultiplayerCapture("a screenshot");
      // The play client renders the viewport; only the edit DataModel may read its pixels back
      const begin = await this.request<{ contentId: string; rect?: { x: number; y: number; w: number; h: number } }>("client", "captureBegin", { focus }, 15_000);
      rect = StudioTools.validRect(begin.rect);
      // Read at the size the kept part needs to come out `width` wide
      const maxWidth = width ? Math.ceil(width / (rect?.w ?? 1)) : undefined;
      read = await this.request("edit", "captureRead", { contentId: begin.contentId, maxWidth }, 15_000);
      peer = "client";
    } else {
      const why = this.missing("edit");
      if (why) throw new ToolError(why);
      // A Run-mode play shows its server, which cannot capture; edit mode draws nothing then
      // (measured 08/11/26 in PA: the capture never came back)
      if (this.link.playPeers().server) throw new ToolError(`${this.missing("client")}; a screenshot needs a Play-mode play (solo_playtest start, mode play) or no play at all`);
      if (focus && /^(game\.)?(PlayerGui|Players\.LocalPlayer)\b/.test(focus)) throw new ToolError(`${this.missing("client")}: a GUI focus needs the play client`);
      read = await this.request("edit", "capture", { focus, maxWidth: width }, 20_000);
      peer = "edit";
    }
    if (typeof read?.data !== "string" || !Number.isInteger(read.width) || !Number.isInteger(read.height)) throw new ToolError("Studio's screenshot came back without its pixels");
    let image: { rgba: Buffer; width: number; height: number } = { rgba: Buffer.from(read.data, "base64"), width: read.width, height: read.height };
    if (rect) image = StudioTools.crop(image, rect);
    let png = encodePng(image.rgba, image.width, image.height);
    while (png.length > SCREENSHOT_MAX_BYTES && image.width > 64) {
      image = halve(image.rgba, image.width, image.height);
      png = encodePng(image.rgba, image.width, image.height);
    }
    fs.mkdirSync(this.screenshotDir, { recursive: true });
    const file = path.join(this.screenshotDir, `shot-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}.png`);
    fs.writeFileSync(file, png);
    this.pruneScreenshots();
    this.lastShot = peer === "client" ? { width: image.width, height: image.height, ...(rect ? { crop: rect } : {}) } : undefined;
    this.lastPixels = image;
    return {
      file, peer, width: image.width, height: image.height, nativeWidth: read.nativeWidth ?? read.width, nativeHeight: read.nativeHeight ?? read.height,
      ...(focus ? { focus } : {}), ...(rect ? { crop: rect } : {}), bytes: png.length, ms: this.now() - started,
    };
  }

  /** A crop rectangle from the plugin, as fractions of the screen, or undefined when it is not one */
  private static validRect(rect: any): { x: number; y: number; w: number; h: number } | undefined {
    if (!rect || typeof rect !== "object") return undefined;
    const { x, y, w, h } = rect;
    if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
    if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) return undefined;
    return { x, y, w, h };
  }

  /** The part of an RGBA image a rectangle of fractions covers (at least 1x1) */
  static crop(image: { rgba: Buffer; width: number; height: number }, rect: { x: number; y: number; w: number; h: number }) {
    const x0 = Math.min(image.width - 1, Math.max(0, Math.floor(rect.x * image.width)));
    const y0 = Math.min(image.height - 1, Math.max(0, Math.floor(rect.y * image.height)));
    const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((rect.x + rect.w) * image.width)));
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((rect.y + rect.h) * image.height)));
    const width = x1 - x0;
    const height = y1 - y0;
    const rgba = Buffer.alloc(width * height * 4);
    for (let row = 0; row < height; row++) {
      image.rgba.copy(rgba, row * width * 4, ((y0 + row) * image.width + x0) * 4, ((y0 + row) * image.width + x1) * 4);
    }
    return { rgba, width, height };
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
    const prelude = this.prelude(peer, args).args;
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
          // Near the deadline a try gets what is left, not its own limit: the message says which
          const thisTryMs = Math.max(100, Math.min(tryMs, deadline - this.now()));
          try {
            const result = await this.request(peer, "eval", { code, ...prelude }, thisTryMs, true);
            const values: string[] = Array.isArray(result?.values) ? result.values : [];
            if (result?.ok && values[0] === "true") return done({ met: true, by: "code", peer, values: values.slice(1), output: result.output ?? [] });
            last = result?.ok ? { values: values.slice(1), output: result.output ?? [] } : { error: String(result?.error ?? "the try failed without a reason"), output: result?.output ?? [] };
          } catch (error) {
            if (!(error instanceof ToolError)) throw error;
            if (error.timedOut) last = { error: `the try did not answer in ${Math.round(thisTryMs)} ms` };
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
    if (this.missing("client") === undefined) {
      this.refuseMultiplayerCapture("a recording");
      peer = "client";
    } else {
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

  /**
   * A GUI's tree as the player sees it: each object's class, text, image, place on screen,
   * whether it is hidden (and by what) and whether a button takes a click, children in their
   * layout's order. The play client's PlayerGui while one runs, else StarterGui in edit mode.
   */
  private async gui(args: Record<string, any>) {
    const path = typeof args.path === "string" ? args.path.trim() : "";
    const needsClient = /^(game\.)?(PlayerGui|Players\.LocalPlayer)\b/.test(path);
    let peer: PeerRole;
    if (this.missing("client") === undefined) peer = "client";
    else if (needsClient) throw new ToolError(this.missing("client")!);
    else {
      const why = this.missing("edit");
      if (why) throw new ToolError(why);
      peer = "edit";
    }
    const bounded = (key: string, min: number, max: number) => {
      if (args[key] === undefined || args[key] === null) return undefined;
      const n = Number(args[key]);
      if (!Number.isInteger(n) || n < min || n > max) throw new ToolError(`${key} must be a whole number from ${min} to ${max}`);
      return n;
    };
    const started = this.now();
    const result = await this.request(peer, "gui", { path: path || undefined, depth: bounded("depth", 0, 20), limit: bounded("limit", 1, 2000), hidden: args.hidden === true }, 15_000);
    return { peer, ...result, ms: this.now() - started };
  }

  /**
   * The play client's mouse by pixel: a point on the last screenshot (scaled from that image to
   * the screen, so display scaling and the device simulator drop out), or the center of a GUI
   * object or a part by its path. Buttons only: Studio's virtual input has no move and no wheel.
   */
  private async mouse(args: Record<string, any>) {
    const action = args.action ?? "click";
    if (!["click", "double", "down", "up"].includes(action)) throw new ToolError("action must be click, double, down or up");
    const button = args.button ?? "left";
    if (!["left", "right", "middle"].includes(button)) throw new ToolError("button must be left, right or middle");
    const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
    const hasPoint = args.x !== undefined || args.y !== undefined;
    if (path && hasPoint) throw new ToolError("give a path or x and y, not both");
    const request: Record<string, unknown> = { action, button, path };
    if (!path) {
      const x = Number(args.x);
      const y = Number(args.y);
      if (!hasPoint || !Number.isFinite(x) || !Number.isFinite(y)) throw new ToolError("give x and y (pixels on the last screenshot) or the path of a GuiObject or a part");
      if (args.space === "screen") {
        Object.assign(request, { x, y });
      } else {
        const shot = this.lastShot;
        if (!shot) throw new ToolError("no screenshot taken since this daemon started: take one (capture_screenshot) and give x and y on it, or pass space screen for the screen's own pixels");
        if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) throw new ToolError(`(${x}, ${y}) is outside the last screenshot (${shot.width}x${shot.height})`);
        // A cropped screenshot (focus) covers part of the screen: back to the whole one
        const crop = shot.crop ?? { x: 0, y: 0, w: 1, h: 1 };
        const fullWidth = shot.width / crop.w;
        const fullHeight = shot.height / crop.h;
        Object.assign(request, { x: crop.x * fullWidth + x, y: crop.y * fullHeight + y, imageWidth: fullWidth, imageHeight: fullHeight });
      }
    }
    const started = this.now();
    const result = await this.request("client", "mouse", request, 10_000);
    return { peer: "client", ...result, ms: this.now() - started };
  }

  /**
   * Does Studio hold the disk's text? Every mapped script (or the files named) is checked in the
   * edit plugin by length and hash against its .Source and its open tab, the text a play copies.
   * Answers the ones that differ and how, and the script files with no instance at all.
   */
  private async verify(args: Record<string, any>) {
    if (!this.place) throw new ToolError("this daemon has no synced tree to check");
    const why = this.missing("edit");
    if (why) throw new ToolError(why);
    let scripts = this.place.scripts();
    let unmapped = this.place.unmapped();
    if (Array.isArray(args.files) && args.files.length === 0) args.files = undefined;
    if (args.files !== undefined) {
      if (!Array.isArray(args.files) || args.files.some((f: unknown) => typeof f !== "string" || !f)) throw new ToolError("files must be a list of script paths");
      const wanted = (args.files as string[]).map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""));
      const matches = (file: string) => wanted.some((w) => file === w || file.endsWith(`/${w}`) || w.endsWith(`/${file}`));
      scripts = scripts.filter((s) => matches(s.file));
      unmapped = unmapped.filter(matches);
      const known = new Set([...scripts.map((s) => s.file), ...unmapped]);
      const unknown = wanted.filter((w) => ![...known].some((k) => k === w || k.endsWith(`/${w}`) || w.endsWith(`/${k}`)));
      if (unknown.length) throw new ToolError(`not a synced script file: ${unknown.join(", ")} (paths from the sync folder, like ServerScriptService/Main.server.luau)`);
    }
    const started = this.now();
    const unreadable = scripts.filter((s) => s.text === undefined).map((s) => s.file);
    const items = scripts.filter((s) => s.text !== undefined).map((s) => ({ guid: s.guid, len: Buffer.byteLength(s.text!, "utf8"), hash: fnv1a(s.text!) }));
    const answer = await this.request<{ checked: number; differ: { guid: string; state: string; path?: string; len?: number; tabLen?: number; error?: string }[] }>("edit", "sourceCheck", { items }, 120_000);
    const byGuid = new Map(scripts.map((s) => [s.guid, s]));
    const differ = (answer.differ ?? []).map((d) => {
      const script = byGuid.get(d.guid);
      return { file: script?.file ?? d.guid, path: d.path, state: d.state, ...(d.error ? { error: d.error } : {}), ...(script?.text !== undefined && d.len !== undefined ? { diskLen: Buffer.byteLength(script.text, "utf8"), studioLen: d.len } : {}), ...(d.tabLen !== undefined ? { tabLen: d.tabLen } : {}) };
    });
    return { checked: answer.checked ?? items.length, same: (answer.checked ?? items.length) - differ.length, differ, unmapped, unreadable, ms: this.now() - started };
  }

  /**
   * Which uncommitted changes in the sync folder came from Studio, read in the daemon from what it
   * wrote there itself: no Studio call, so it answers with Studio closed too
   */
  private async changes(args: Record<string, any>) {
    if (!this.place?.changes) throw new ToolError("this daemon does not record Studio's writes");
    if (args.numbersOnly !== undefined && typeof args.numbersOnly !== "boolean") throw new ToolError("numbersOnly must be true or false");
    return this.place.changes({ numbersOnly: args.numbersOnly === true });
  }

  /**
   * Instances of the synced tree by name (* and ? wildcards), class, and where they are, read in
   * the daemon without asking Studio: the edit-mode place as of the last sync. Sessions scanned
   * with GetDescendants in 2011 of the month's execute_luau. With a peer (or an attribute or a
   * tag, which the synced tree does not hold) the search runs in that live DataModel instead.
   */
  private find(args: Record<string, any>) {
    if (args.peer !== undefined && !["edit", "server", "client"].includes(args.peer)) throw new ToolError("peer must be server or client (a running play), or edit (Studio in edit mode, live)");
    const byAttribute = typeof args.attribute === "string" && args.attribute.trim() !== "";
    const byTag = typeof args.tag === "string" && args.tag.trim() !== "";
    if (args.peer || byAttribute || byTag) return this.findLive(args);
    if (!this.place) throw new ToolError("this daemon has no synced tree");
    const name = typeof args.name === "string" && args.name.trim() ? globRegExp(args.name.trim()) : undefined;
    const classes = typeof args.className === "string" && args.className.trim() ? new Set(args.className.split(",").map((c: string) => c.trim()).filter(Boolean)) : undefined;
    const under = typeof args.under === "string" && args.under.trim() ? args.under.trim().replace(/^game\./, "").split(".") : undefined;
    const limit = args.limit === undefined ? 100 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new ToolError("limit must be a whole number from 1 to 5000");
    if (!name && !classes && !under) throw new ToolError("give a name (wildcards * and ?), a className, or under (a path), or several");
    const started = this.now();
    const matches: { path: string; className: string; guid: string }[] = [];
    let scanned = 0;
    for (const node of this.place.nodes()) {
      scanned++;
      if (classes && !classes.has(node.className)) continue;
      if (name && !name.test(node.name)) continue;
      if (under && (node.path.length <= under.length || under.some((part, i) => node.path[i] !== part))) continue;
      matches.push({ path: node.path.join("."), className: node.className, guid: node.guid });
    }
    // The first `limit` in path order, whatever order the tree holds them in
    matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const found = matches.slice(0, limit).map((m) => {
      const file = this.place!.fileOf(m.guid);
      return { path: m.path, className: m.className, ...(file ? { file } : {}) };
    });
    return { found, total: matches.length, scanned, studioConnected: this.link.editConnected(), ms: this.now() - started };
  }

  /**
   * Instances of a live DataModel (the play server or client, or edit mode): by name, class (IsA,
   * or the exact ClassName with `exact`), under a path, an attribute (and its value), a tag.
   * 3869 of a month's evals walked GetDescendants by hand in a play. With no peer named (an
   * attribute or a tag asked), the play server during a play, else edit mode.
   */
  private async findLive(args: Record<string, any>) {
    const trimmed = (key: string) => (typeof args[key] === "string" && args[key].trim() ? (args[key] as string).trim() : undefined);
    const name = trimmed("name");
    const classes = trimmed("className")?.split(",").map((c) => c.trim()).filter(Boolean);
    const under = trimmed("under");
    const attribute = trimmed("attribute");
    const tag = trimmed("tag");
    if (attribute !== undefined && !/^[A-Za-z0-9_]{1,100}$/.test(attribute)) throw new ToolError("attribute must be an attribute's name (letters, digits and _)");
    let attributeValue: string | undefined;
    if (args.attributeValue !== undefined && args.attributeValue !== null) {
      if (!["string", "number", "boolean"].includes(typeof args.attributeValue)) throw new ToolError("attributeValue must be a string, a number or true/false");
      if (attribute === undefined) throw new ToolError("attributeValue needs attribute: the attribute's name");
      attributeValue = String(args.attributeValue);
    }
    const limit = args.limit === undefined ? 50 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new ToolError("limit must be a whole number from 1 to 5000");
    if (!name && !classes?.length && !under && !attribute && !tag) throw new ToolError("give a name (wildcards * and ?), a className, under (a path), an attribute or a tag, or several");
    const peer: PeerRole = args.peer ?? (this.link.playPeers().server === "ready" ? "server" : "edit");
    const request = {
      ...(name ? { name } : {}),
      ...(classes?.length ? { classes } : {}),
      ...(args.exact === true ? { exact: true } : {}),
      ...(under ? { under } : {}),
      ...(attribute ? { attribute } : {}),
      ...(attributeValue !== undefined ? { attributeValue } : {}),
      ...(tag ? { tag } : {}),
      limit,
    };
    const started = this.now();
    const result = await this.request(peer, "find", request, StudioTools.timeout(args, 30_000));
    return { peer, ...result, ms: this.now() - started };
  }

  /**
   * The player's character moved in a running play: teleported to a position or onto an instance
   * (a part's or model's top, an attachment), or walked there (Humanoid:MoveTo, or a
   * PathfindingService path), until it arrives, stops getting closer for 2 s or the timeout.
   * The server moves it unless a player owns the root's physics: then that player's client does
   * (the owner simulates it), and the answer names the owner. `peer` picks one side by force.
   */
  private async move(args: Record<string, any>) {
    let position: number[] | undefined;
    if (args.position !== undefined && args.position !== null) {
      if (!Array.isArray(args.position) || args.position.length !== 3 || args.position.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n))) throw new ToolError("position must be [x, y, z]");
      position = args.position;
    }
    const target = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
    if (!position === !target) throw new ToolError("give a position [x, y, z] or a path (a part, model or attachment to stand on), one of them");
    const mode = args.mode ?? "teleport";
    if (!["teleport", "walk", "path"].includes(mode)) throw new ToolError("mode must be teleport, walk (Humanoid:MoveTo in a straight line) or path (PathfindingService)");
    if (args.peer !== undefined && !["server", "client"].includes(args.peer)) throw new ToolError("peer must be server or client");
    let radius: number | undefined;
    if (args.radius !== undefined && args.radius !== null) {
      radius = Number(args.radius);
      if (!Number.isFinite(radius) || radius < 0.5 || radius > 50) throw new ToolError("radius must be a number of studs from 0.5 to 50");
    }
    const timeoutMs = StudioTools.timeout(args, 15_000);
    const request = {
      mode,
      ...(position ? { position } : { path: target }),
      seconds: timeoutMs / 1000,
      ...(radius !== undefined ? { radius } : {}),
      ...(typeof args.player === "string" && args.player ? { player: args.player } : {}),
    };
    // A path is computed first (up to a few seconds), then the walk has its own timeout
    const waitMs = mode === "teleport" ? 15_000 : timeoutMs + 20_000;
    const started = this.now();
    const peer: PlayRole = args.peer ?? "server";
    let result = await this.request(peer, "move", { ...request, ...(peer === "server" && args.peer === "server" ? { stay: true } : {}) }, waitMs);
    let owner: string | undefined;
    if (result?.handOff === "client") {
      owner = String(result.owner);
      // In a multiplayer test the owner's own client; in a solo play the only one
      const players = this.link.playPeers().players ?? [];
      const who = (typeof args.player === "string" && args.player) || (players.length > 1 || this.multiplayer !== undefined ? owner : undefined);
      // The goal as the server found it: with StreamingEnabled the client may not have the target
      const { path: _named, ...rest } = request as typeof request & { path?: string };
      const handed = { ...rest, ...(Array.isArray(result.position) ? { position: result.position } : {}), ...(typeof result.target === "string" ? { target: result.target } : {}) };
      result = await this.callPlayer.run(who, () => this.request("client", "move", handed, waitMs));
      return { peer: "client", ...result, owner, ms: this.now() - started };
    }
    return { peer, ...result, ms: this.now() - started };
  }

  /**
   * A few seconds of the play's performance, measured in both peers at once (or the one named):
   * frame times and hitches, memory by tag, the engine's Stats. In a solo play the server and
   * the client share one Studio process, so the server's frame times carry the client's drawing.
   */
  private async perf(args: Record<string, any>) {
    const seconds = args.seconds === undefined || args.seconds === null ? 3 : Number(args.seconds);
    if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 30) throw new ToolError("seconds must be from 0.5 to 30");
    if (args.peer !== undefined && args.peer !== "server" && args.peer !== "client") throw new ToolError("peer must be server or client");
    const peers: PlayRole[] = args.peer ? [args.peer] : (["server", "client"] as PlayRole[]).filter((p) => this.missing(p) === undefined);
    if (!peers.length) throw new ToolError(this.missing("server")!);
    const started = this.now();
    const results = await Promise.all(peers.map((peer) => this.request(peer, "perf", { seconds }, seconds * 1000 + 15_000)));
    const answer: Record<string, unknown> = { seconds, ms: this.now() - started };
    peers.forEach((peer, i) => (answer[peer] = results[i]));
    if (peers.length === 2 && this.multiplayer === undefined) answer.note = "a solo play's server and client run in one Studio process: the server's frame times include the client's drawing";
    return answer;
  }

  /** A synced script file (a path from the sync folder, or its end) to its guid */
  private guidOfFile(file: string): string {
    if (!this.place) throw new ToolError("this daemon has no synced tree");
    const wanted = file.replace(/\\/g, "/").replace(/^\.\//, "");
    const found = this.place.scripts().filter((s) => s.file === wanted || s.file.endsWith(`/${wanted}`));
    if (found.length === 0) throw new ToolError(`${file} is not a synced script file (paths from the sync folder, like ServerScriptService/Main.server.luau)`);
    if (found.length > 1) throw new ToolError(`${file} names ${found.length} scripts: ${found.map((s) => s.file).join(", ")}`);
    return found[0].guid;
  }

  /**
   * Logpoints: a script line that prints values when it runs, with no edit to the script (Studio's
   * ScriptDebuggerService, in edit mode; they fire in the play). The script by its file or path.
   */
  private async logpoint(args: Record<string, any>) {
    const action = args.action ?? "add";
    if (!["add", "remove", "list", "clear"].includes(action)) throw new ToolError("action must be add, remove, list or clear");
    const request: Record<string, unknown> = { action };
    if (action === "add" || action === "remove") {
      const file = typeof args.file === "string" && args.file.trim() ? args.file.trim() : undefined;
      const scriptPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
      if (!file && !scriptPath) throw new ToolError("name the script: file (from the sync folder) or path (its instance path)");
      const line = Number(args.line);
      if (!Number.isInteger(line) || line < 1) throw new ToolError("line must be a line number, 1 or more");
      Object.assign(request, { line, ...(file ? { guid: this.guidOfFile(file) } : { path: scriptPath }) });
      if (action === "add") {
        if (typeof args.message === "string" && args.message.trim()) request.message = args.message;
        if (typeof args.condition === "string" && args.condition.trim()) request.condition = args.condition;
      }
    }
    return this.request("edit", "logpoint", request, 15_000);
  }

  /** Instances saved as one .rbxm file (default under .quack/exports) */
  private async exportRbxm(args: Record<string, any>) {
    const paths = args.paths;
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== "string" || !p.trim())) throw new ToolError("paths must be a list of instance paths");
    const started = this.now();
    const result = await this.request<{ data: string; bytes: number; instances: string[] }>("edit", "exportRbxm", { paths }, 120_000);
    const data = Buffer.from(String(result?.data ?? ""), "base64");
    if (!data.length || data.length !== result.bytes) throw new ToolError("Studio's .rbxm came back incomplete");
    let file = typeof args.out === "string" && args.out ? args.out : "";
    if (!file) {
      const name = String(paths[paths.length - 1]).split(".").pop()!.replace(/[^\w-]+/g, "_") || "export";
      file = path.join(path.dirname(this.screenshotDir), "exports", `${name}-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}.rbxm`);
    }
    if (!path.isAbsolute(file)) throw new ToolError("out must be an absolute path");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    return { file, bytes: data.length, instances: result.instances, ms: this.now() - started };
  }

  /**
   * An .rbxm or .rbxl file's instances put in edit mode (their scripts then sync to disk). A place
   * file (a binary file holding services, told by its classes, not its extension) is made
   * importable first (see util/rbxl.ts). `paths` keeps only some of the file, each item put back
   * in its own parent in this place (Workspace.MapA into Workspace); a place with no paths lands
   * whole under `parent`, by default ServerStorage, where none of its scripts runs. A downloaded
   * place is untrusted: its scripts are listed, and they land only with `scripts: true`. `list`
   * reads the file and calls no Studio.
   */
  private async importRbxm(args: Record<string, any>) {
    const file = typeof args.file === "string" ? args.file : "";
    if (!file || !path.isAbsolute(file)) throw new ToolError("file must be the absolute path of an .rbxm or .rbxl");
    let data: Buffer;
    try {
      data = fs.readFileSync(file);
    } catch (error) {
      throw new ToolError(`cannot read ${file}: ${(error as Error).message}`);
    }
    if (data.length > 50 * 1024 * 1024) throw new ToolError(`${file} is ${Math.round(data.length / 1024 / 1024)} MB: at most 50 MB`);
    if (args.paths !== undefined && (!Array.isArray(args.paths) || !args.paths.length || args.paths.some((p: unknown) => typeof p !== "string" || !p.trim()))) {
      throw new ToolError("paths must be a list of paths in the file, like Workspace.MapA or StarterGui.Shop");
    }
    const paths: string[] | undefined = args.paths;
    const parent = typeof args.parent === "string" && args.parent ? args.parent : undefined;
    // An XML model (.rbxmx) goes to Studio as an .rbxm does: Studio deserializes XML too (measured
    // 09/11/26 in PA, a Model with a Part and a Script). An XML place (.rbxlx) or paths picked
    // from XML need the binary reader, so those ask for the binary file (Studio saves binary by
    // default); a place must never skip the script check and the ServerStorage default.
    if (data.subarray(0, 8).toString("latin1") !== "<roblox!" && /^\s*<roblox[\s>]/.test(data.subarray(0, 200).toString("latin1"))) {
      const head = data.toString("latin1", 0, Math.min(data.length, 2_000_000));
      const placeXml = /<Item\s+class\s*=\s*["'](?:Workspace|Lighting|ReplicatedStorage|ServerScriptService|ServerStorage|StarterGui|StarterPlayer|SoundService|Teams)["']/i.test(head);
      if (placeXml) throw new ToolError(`${file}: an XML place (.rbxlx): open it in Studio (open_place) and save it as .rbxl, then import that`);
      if (paths) throw new ToolError(`${file}: paths are picked from a binary file: save this XML model as .rbxm, or import it whole`);
      if (args.list === true) throw new ToolError(`${file}: list reads binary files only: save it as .rbxm to list it`);
      const xmlScripts = (head.match(/<Item\s+class\s*=\s*["'](?:Script|LocalScript|ModuleScript)["']/gi) ?? []).length;
      const started = this.now();
      const result = await this.request("edit", "importRbxm", { data: data.toString("base64"), parent }, 120_000);
      return { file, bytes: data.length, xml: true, xmlScripts, ...result, ms: this.now() - started };
    }
    let parsed: RobloxFile;
    try {
      parsed = readRoblox(data);
    } catch (error) {
      if (!(error instanceof RbxlError)) throw error;
      const xml = /an XML file/.test(error.message) ? " (open it in Studio, open_place for a place, and save it as .rbxm / .rbxl)" : "";
      throw new ToolError(`${file}: ${error.message}${xml}`);
    }
    if (args.list === true) return { file, bytes: data.length, ...summarize(parsed) };
    if (!parsed.place && !paths) {
      const started = this.now();
      const result = await this.request("edit", "importRbxm", { data: data.toString("base64"), parent }, 120_000);
      return { file, bytes: data.length, ...result, ms: this.now() - started };
    }

    let picks: Pick[] | undefined;
    try {
      picks = paths ? resolvePicks(parsed, paths) : undefined;
    } catch (error) {
      if (error instanceof RbxlError) throw new ToolError(`${file}: ${error.message}`);
      throw error;
    }
    const chosen = picks ? picks.flatMap((p) => p.instances) : parsed.roots;
    const found = scriptsUnder(chosen, 200);
    const scripts = found.paths;
    if (found.count && args.scripts !== true) {
      const shown = scripts.slice(0, 50).join(", ") + (found.count > 50 ? `, ... (${found.count})` : "");
      throw new ToolError(`${picks ? "what you picked" : "the file"} holds ${found.count} script(s), which sync to disk and run in a play: ${shown}. Read them first (the file came from outside; list true shows them), then import again with scripts: true, or pick paths without them`);
    }
    const payload = toModelFile(parsed);
    if (payload.length > 50 * 1024 * 1024) throw new ToolError(`${file} as a model is ${Math.round(payload.length / 1024 / 1024)} MB: at most 50 MB`);
    const voxels = parsed.place && parsed.terrain && !parsed.terrain.empty ? `the place's Terrain has ${parsed.terrain.voxelBytes} bytes of voxels, which an import cannot carry` : undefined;
    const started = this.now();
    if (!picks) {
      const result = await this.request<Record<string, any>>("edit", "importRbxm", { data: payload.toString("base64"), parent: parent ?? "ServerStorage" }, 120_000);
      return {
        file, bytes: data.length, place: true, ...result, scriptList: scripts, scriptCount: found.count,
        note: "the whole place: each service is a Folder of its name and Workspace a Model (with its Camera and an empty Terrain Folder). Move what is missing to where it belongs, or import again with paths to put each item back in its own parent",
        ...(voxels ? { terrain: voxels } : {}), ms: this.now() - started,
      };
    }
    const into = (p: Pick) => parent ?? (parsed.place ? p.names.slice(0, -1).join(".") : "Workspace");
    const result = await this.request<Record<string, any>>("edit", "importPicks", {
      data: payload.toString("base64"),
      picks: picks.map((p) => ({ names: p.names, className: p.className, count: p.count, into: into(p) })),
    }, 120_000);
    // every instance that is or holds a kept one: one walk up from each kept instance
    const holdsKept = new Set<FileInstance>();
    for (const pick of picks) {
      for (const k of pick.instances) {
        for (let at: FileInstance | undefined = k; at && !holdsKept.has(at); at = at.parent) holdsKept.add(at);
      }
    }
    const leftOut = topItems(parsed).filter((item) => !holdsKept.has(item)).map(pathOf);
    return {
      file, bytes: data.length, place: parsed.place,
      kept: picks.map((p) => `${p.path} (${p.className}${p.count > 1 ? `, ${p.count} of that name` : ""}) into ${into(p)}`),
      ...result,
      leftOut: leftOut.slice(0, 100), leftOutCount: leftOut.length,
      scriptList: scripts, scriptCount: found.count,
      ...(voxels && picks.some((p) => p.names[0] === "Workspace") ? { terrain: voxels } : {}),
      ms: this.now() - started,
    };
  }

  /** The last screenshot's pixels, for a picture made of several (devices) */
  private lastPixels: { rgba: Buffer; width: number; height: number } | undefined;

  /**
   * Where a read or a change of one instance goes: the peer named; else, during a play, the play
   * client for a PlayerGui path and the play server for the rest (the running game's state);
   * with no play, edit mode.
   */
  private instancePeer(args: Record<string, any>): PeerRole {
    if (args.peer !== undefined && !["edit", "server", "client"].includes(args.peer)) throw new ToolError("peer must be edit, server or client");
    if (args.peer) return args.peer;
    const path = String(args.path ?? "");
    if (/^(game\.)?(PlayerGui|Players\.LocalPlayer)\b/.test(path)) return "client";
    return this.link.playPeers().server === "ready" ? "server" : "edit";
  }

  /** One instance read whole: the properties that differ from a new one of its class (or all), attributes, tags, children */
  private async inspect(args: Record<string, any>) {
    if (typeof args.path !== "string" || !args.path.trim()) throw new ToolError("path is required: the instance's path, like Workspace.Map.Door");
    const peer = this.instancePeer(args);
    const started = this.now();
    const result = await this.request(peer, "inspect", { path: args.path.trim(), all: args.all === true, hidden: args.hidden === true }, 15_000);
    return { peer, ...result, ms: this.now() - started };
  }

  /**
   * Properties and attributes of one instance changed together (each value checked first, all or
   * nothing; one undo step in edit mode). A value takes the type of what is there now, or names
   * its type: { "Vector3": [1, 2, 3] }. An attribute set to null is removed.
   */
  private async setProps(args: Record<string, any>) {
    if (typeof args.path !== "string" || !args.path.trim()) throw new ToolError("path is required");
    const isObject = (v: unknown) => v !== undefined && v !== null && typeof v === "object" && !Array.isArray(v);
    if (args.properties !== undefined && !isObject(args.properties)) throw new ToolError("properties must be an object of name: value");
    if (args.attributes !== undefined && !isObject(args.attributes)) throw new ToolError("attributes must be an object of name: value");
    const properties = args.properties ?? {};
    const attributes: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(args.attributes ?? {})) attributes[name] = value === null ? { Remove: true } : value;
    for (const [name, value] of Object.entries(properties)) if (value === null) throw new ToolError(`${name}: null clears only an attribute; a property takes a value (an Instance property takes { "Instance": "" } to clear it)`);
    if (!Object.keys(properties).length && !Object.keys(attributes).length) throw new ToolError("give properties or attributes to set");
    const peer = this.instancePeer(args);
    const started = this.now();
    const result = await this.request(peer, "setProps", { path: args.path.trim(), properties, attributes }, 15_000);
    return { peer, ...result, ms: this.now() - started };
  }

  /** Studio's network presets (the Network simulation panel's numbers; chrrxs's great/good/poor) */
  static readonly NETWORK_PRESETS: Record<string, Record<string, number>> = {
    off: { InboundNetworkMinDelayMs: 0, OutboundNetworkMinDelayMs: 0, InboundNetworkJitterMs: 0, OutboundNetworkJitterMs: 0, InboundNetworkLossPercent: 0, OutboundNetworkLossPercent: 0 },
    great: { InboundNetworkMinDelayMs: 15, OutboundNetworkMinDelayMs: 15, InboundNetworkJitterMs: 0, OutboundNetworkJitterMs: 0, InboundNetworkLossPercent: 0, OutboundNetworkLossPercent: 0 },
    good: { InboundNetworkMinDelayMs: 50, OutboundNetworkMinDelayMs: 50, InboundNetworkJitterMs: 10, OutboundNetworkJitterMs: 10, InboundNetworkLossPercent: 0, OutboundNetworkLossPercent: 0 },
    poor: { InboundNetworkMinDelayMs: 150, OutboundNetworkMinDelayMs: 150, InboundNetworkJitterMs: 100, OutboundNetworkJitterMs: 100, InboundNetworkLossPercent: 0.5, OutboundNetworkLossPercent: 0.5 },
  };

  /**
   * Studio's network and performance simulation: a network preset or the six numbers, the
   * graphics quality level, the memory the device has. Set in edit mode (a solo play shares it)
   * and in the play client when one runs (a multiplayer client keeps its own after it starts).
   * With nothing to set it reports the state.
   */
  private async simulate(args: Record<string, any>) {
    const network: Record<string, number> = {};
    if (args.network !== undefined) {
      if (typeof args.network !== "string" || !StudioTools.NETWORK_PRESETS[args.network]) throw new ToolError(`network must be one of ${Object.keys(StudioTools.NETWORK_PRESETS).join(", ")}`);
      Object.assign(network, StudioTools.NETWORK_PRESETS[args.network]);
    }
    const side = (key: "inbound" | "outbound", prefix: "Inbound" | "Outbound") => {
      const given = args[key];
      if (given === undefined || given === null) return;
      if (typeof given !== "object") throw new ToolError(`${key} must be { latencyMs, jitterMs, lossPercent }`);
      const pairs: [string, string][] = [["latencyMs", "NetworkMinDelayMs"], ["jitterMs", "NetworkJitterMs"], ["lossPercent", "NetworkLossPercent"]];
      for (const [field, suffix] of pairs) {
        if (given[field] === undefined) continue;
        const n = Number(given[field]);
        if (!Number.isFinite(n) || n < 0) throw new ToolError(`${key}.${field} must be a number, 0 or more`);
        if (field === "lossPercent" && n > 0.5) throw new ToolError(`${key}.lossPercent: the engine simulates at most 0.5% packet loss`);
        network[`${prefix}${suffix}`] = n;
      }
    };
    side("inbound", "Inbound");
    side("outbound", "Outbound");
    const request: Record<string, unknown> = {};
    if (Object.keys(network).length) request.network = network;
    if (args.quality !== undefined) {
      const q = args.quality;
      if (!(q === "auto" || (Number.isInteger(q) && q >= 1 && q <= 21))) throw new ToolError("quality must be auto or a level from 1 to 21");
      request.quality = q;
    }
    if (args.memoryMb !== undefined) {
      if (!Number.isInteger(args.memoryMb) || args.memoryMb < 256) throw new ToolError("memoryMb must be a whole number of megabytes, 256 or more");
      request.memoryMb = args.memoryMb;
    }
    const result: Record<string, unknown> = { edit: await this.request("edit", "simulate", request, 10_000) };
    if (Object.keys(request).length && this.missing("client") === undefined) {
      result.client = await this.request("client", "simulate", request, 10_000).catch((error: Error) => ({ error: error.message }));
    }
    return result;
  }

  /**
   * Script tabs open in this Studio, and which were edited (their text is not the script's
   * .Source). A tab edited in the Studio that starts a play gives the play its own text instead
   * of the swapped script's. close: the tabs of these script paths; closeEdited: every edited one.
   */
  private async tabs(args: Record<string, any>) {
    if (args.close !== undefined && (!Array.isArray(args.close) || args.close.some((p: unknown) => typeof p !== "string" || !p))) throw new ToolError("close must be a list of script paths");
    return this.request("edit", "tabs", { close: args.close, closeEdited: args.closeEdited === true }, 30_000);
  }

  /** The devices a UI is checked on by default: a small Android phone, an iPhone, an iPad, then no simulation */
  static readonly DEFAULT_DEVICES = ["samsung_galaxy_a06", "iphone_14", "ipad_10th_generation", "none"];

  /**
   * The play view on several devices in one call: the simulator set to each one in turn, a
   * screenshot, then back to how it was. Answers one picture with all of them side by side (the
   * same height each) and each screenshot's file. Sessions paired a simulator change with a
   * screenshot 259 times in a month.
   */
  private async devices(args: Record<string, any>) {
    const devices: string[] = args.devices === undefined ? StudioTools.DEFAULT_DEVICES : args.devices;
    if (!Array.isArray(devices) || !devices.length || devices.length > 8 || devices.some((d) => typeof d !== "string" || !d)) throw new ToolError("devices must be a list of 1 to 8 device ids (none: no simulation)");
    const orientation = args.orientation ?? "LandscapeLeft";
    if (typeof orientation !== "string") throw new ToolError("orientation must be an Enum.ScreenOrientation name");
    const before: any = await this.device({});
    const started = this.now();
    const shots: { device: string; file: string; width: number; height: number }[] = [];
    const tiles: { rgba: Buffer; width: number; height: number }[] = [];
    try {
      for (const device of devices) {
        if (device === "none") await this.device({ stop: true });
        else await this.device({ deviceId: device, orientation });
        // The view takes a frame or two to lay out at the new size
        await new Promise((r) => setTimeout(r, 1000));
        const shot: any = await this.screenshot({ width: typeof args.width === "number" ? args.width : 900 });
        shots.push({ device, file: shot.file, width: shot.width, height: shot.height });
        if (this.lastPixels) tiles.push(this.lastPixels);
      }
    } finally {
      // Back to the simulator as it was, whatever failed
      if (before?.isSimulating && before.activeDeviceId) {
        await this.device({ deviceId: before.activeDeviceId, ...(before.orientation ? { orientation: before.orientation } : {}) }).catch(() => undefined);
      } else await this.device({ stop: true }).catch(() => undefined);
    }
    const picture = mosaic(tiles, 360, 1600);
    const png = encodePng(picture.rgba, picture.width, picture.height);
    fs.mkdirSync(this.screenshotDir, { recursive: true });
    const sheetFile = path.join(this.screenshotDir, `devices-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}.png`);
    fs.writeFileSync(sheetFile, png);
    this.lastShot = undefined;
    return { sheet: sheetFile, shots, places: picture.places, width: picture.width, height: picture.height, ms: this.now() - started };
  }

  /**
   * The player's test profile kept and put back, through the game's own functions: the place's
   * quack-prelude/server.luau defines __quackSaveProfile(player) (returns a table) and
   * __quackRestoreProfile(player, data). Quack cannot know a game's data layer; this only runs
   * those two and keeps what the first returns under .quack/profiles.
   */
  private async profile(args: Record<string, any>) {
    const action = args.action;
    if (!["save", "restore", "list"].includes(action)) throw new ToolError("action must be save, restore or list");
    const dir = path.join(path.dirname(this.screenshotDir), "profiles");
    if (action === "list") {
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
      } catch {
        // none kept yet
      }
      return { profiles: names };
    }
    const name = typeof args.name === "string" && /^[\w-]{1,60}$/.test(args.name) ? args.name : args.name === undefined ? "default" : undefined;
    if (!name) throw new ToolError("name must be letters, digits, - or _ (default: default)");
    const prelude = this.prelude("server", {}).args.prelude ?? "";
    const needs = action === "save" ? "__quackSaveProfile" : "__quackRestoreProfile";
    if (!prelude.includes(needs)) {
      throw new ToolError(`the place's quack-prelude/server.luau has no ${needs}: define __quackSaveProfile(player) returning the profile as a table and __quackRestoreProfile(player, data) there (Quack does not know a game's data layer)`);
    }
    const file = path.join(dir, `${name}.json`);
    const player = typeof args.player === "string" && args.player ? args.player : undefined;
    const who = player ? `game:GetService("Players"):FindFirstChild(${JSON.stringify(player)})` : `game:GetService("Players"):GetPlayers()[1]`;
    if (action === "save") {
      const code = `local __p = ${who}\nif not __p then error("no player in the play") end\nreturn game:GetService("HttpService"):JSONEncode(__quackSaveProfile(__p))`;
      const result: any = await this.callPlayer.run(undefined, () => this.evalRuntime({ code, peer: "server", timeoutMs: 30_000 }));
      if (!result?.ok) throw new ToolError(`__quackSaveProfile failed: ${result?.error ?? "no answer"}`);
      const json = String(result.values?.[0] ?? "");
      JSON.parse(json);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, json);
      return { action, name, file, bytes: Buffer.byteLength(json) };
    }
    let json: string;
    try {
      json = fs.readFileSync(file, "utf8");
    } catch {
      throw new ToolError(`no profile kept as ${name} (save one first)`);
    }
    const code = `local __p = ${who}\nif not __p then error("no player in the play") end\n__quackRestoreProfile(__p, game:GetService("HttpService"):JSONDecode(${JSON.stringify(json)}))\nreturn true`;
    const result: any = await this.evalRuntime({ code, peer: "server", timeoutMs: 30_000 });
    if (!result?.ok) throw new ToolError(`__quackRestoreProfile failed: ${result?.error ?? "no answer"}`);
    return { action, name, file, bytes: Buffer.byteLength(json) };
  }

  /** A Creator Store asset id from the caller */
  private static assetId(args: Record<string, any>): number {
    const id = Number(args.assetId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ToolError("assetId must be a whole number above 0");
    return id;
  }

  /**
   * A Creator Store asset loaded in edit mode (AssetService:LoadAssetAsync) and read without
   * being put in the place: its classes, a tree of up to 100 objects, every script and
   * PackageLink in it (a backdoor hides in a script deep inside), its sounds. Then destroyed.
   */
  private async assetPreview(args: Record<string, any>) {
    const assetId = StudioTools.assetId(args);
    const depth = args.depth === undefined || args.depth === null ? 4 : Number(args.depth);
    if (!Number.isInteger(depth) || depth < 0 || depth > 20) throw new ToolError("depth must be a whole number from 0 to 20");
    const started = this.now();
    const result = await this.request("edit", "assetPreview", { assetId, depth }, StudioTools.timeout(args, 60_000));
    return { ...result, ms: this.now() - started };
  }

  /**
   * A Creator Store asset put in the place (edit mode, one undo step): every script and
   * PackageLink in it destroyed first, the rest checked again, and nothing inserted when any is
   * left. Scripts would sync to disk and run in the game: they never come in this way.
   */
  private async assetInsert(args: Record<string, any>) {
    const assetId = StudioTools.assetId(args);
    let position: number[] | undefined;
    if (args.position !== undefined && args.position !== null) {
      const p = args.position;
      position = Array.isArray(p) ? p.map(Number) : [Number(p?.x), Number(p?.y), Number(p?.z)];
      if (position.length !== 3 || !position.every(Number.isFinite)) throw new ToolError("position must be x, y and z (studs)");
    }
    const parent = typeof args.parent === "string" && args.parent.trim() ? args.parent.trim() : undefined;
    const started = this.now();
    const result = await this.request("edit", "assetInsert", { assetId, ...(parent ? { parent } : {}), ...(position ? { position } : {}) }, StudioTools.timeout(args, 60_000));
    return { ...result, ms: this.now() - started };
  }

  /** The peers a read goes to: the one named, else every one connected now (edit first) */
  private readPeers(args: Record<string, any>, allowed: PeerRole[]): PeerRole[] {
    if (args.peer !== undefined && args.peer !== null) {
      if (!allowed.includes(args.peer)) throw new ToolError(`peer must be ${allowed.join(", ").replace(/, ([^,]+)$/, " or $1")}`);
      const why = this.missing(args.peer);
      if (why) throw new ToolError(why);
      return [args.peer];
    }
    const peers = allowed.filter((p) => this.missing(p) === undefined);
    if (!peers.length) throw new ToolError(this.missing(allowed.includes("edit") ? "edit" : "server")!);
    return peers;
  }

  /**
   * Memory by Enum.DeveloperMemoryTag (Stats:GetMemoryUsageMbForTag) and the total, in edit
   * mode and each play peer at once (or the one named). A solo play runs all of them in one
   * Studio process: the totals are that process's, the same number each.
   */
  private async memory(args: Record<string, any>) {
    let tags: string[] | undefined;
    if (args.tags !== undefined && args.tags !== null) {
      if (!Array.isArray(args.tags) || args.tags.some((t: unknown) => typeof t !== "string" || !t)) throw new ToolError("tags must be a list of Enum.DeveloperMemoryTag names");
      tags = args.tags.length ? args.tags : undefined;
    }
    const peers = this.readPeers(args, ["edit", "server", "client"]);
    const started = this.now();
    const results = await Promise.all(peers.map((peer) => this.request(peer, "memory", { ...(tags ? { tags } : {}) }, 15_000).catch((error: Error) => ({ error: error.message }))));
    const answer: Record<string, unknown> = { ms: this.now() - started };
    peers.forEach((peer, i) => (answer[peer] = results[i]));
    if (peers.length > 1 && this.multiplayer === undefined && peers.some((p) => p !== "edit")) answer.note = "Studio's edit mode and a solo play's server and client are one process: each total is that whole process's";
    return answer;
  }

  /**
   * ScriptProfilerService on the play server (default) or the play client for durationMs: the
   * functions that took the most time, with their share of the capture. Quack's own plugin and
   * eval functions are left out unless includePlugin. `save` keeps the raw JSON (the profiler's
   * own format) under .quack/profiler.
   */
  private async profiler(args: Record<string, any>) {
    const peer: PlayRole = args.peer === undefined || args.peer === null ? "server" : args.peer;
    if (peer !== "server" && peer !== "client") throw new ToolError("peer must be server or client");
    const whole = (key: string, fallback: number, min: number, max: number) => {
      if (args[key] === undefined || args[key] === null) return fallback;
      const n = Number(args[key]);
      if (!Number.isInteger(n) || n < min || n > max) throw new ToolError(`${key} must be a whole number from ${min} to ${max}`);
      return n;
    };
    const durationMs = whole("durationMs", 1000, 100, 15_000);
    const frequency = whole("frequency", 1000, 1, 10_000);
    const maxFunctions = whole("maxFunctions", 20, 1, 100);
    const filter = typeof args.filter === "string" && args.filter ? args.filter : undefined;
    const save = args.save === true || (typeof args.out === "string" && args.out !== "");
    if (typeof args.out === "string" && args.out && !path.isAbsolute(args.out)) throw new ToolError("out must be an absolute path");
    const started = this.now();
    // The capture, then up to 5 s for the profiler's data, then the decode in a big game
    const result = await this.request<any>(peer, "profiler", {
      durationMs, frequency, maxFunctions, ...(filter ? { filter } : {}), includeNative: args.includeNative === true, includePlugin: args.includePlugin === true, raw: save,
    }, durationMs + 20_000);
    const answer: Record<string, unknown> = { peer, ...result, ms: this.now() - started };
    if (typeof result?.raw === "string") {
      delete answer.raw;
      const file = typeof args.out === "string" && args.out
        ? args.out
        : path.join(path.dirname(this.screenshotDir), "profiler", `profile-${peer}-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, result.raw);
      answer.file = file;
    }
    return answer;
  }

  static readonly SCENE_MODES = ["instance_composition", "script_memory", "unparented_instances", "triangle_composition", "animation_memory", "audio_memory"];

  /**
   * SceneAnalysisService (Studio's Scene Analysis beta): the biggest entries of one breakdown or
   * all six, each a tree flattened to its leaves and sorted by size (triangles by their count).
   * Edit mode with no play, the play server during one, or the peer named. In mode all, a mode
   * that fails says its own error and the rest still answer.
   */
  private async scene(args: Record<string, any>) {
    const mode = args.mode === undefined || args.mode === null ? "all" : String(args.mode);
    if (mode !== "all" && !StudioTools.SCENE_MODES.includes(mode)) throw new ToolError(`mode must be all or one of ${StudioTools.SCENE_MODES.join(", ")}`);
    const topN = args.topN === undefined || args.topN === null ? 10 : Number(args.topN);
    if (!Number.isInteger(topN) || topN < 1 || topN > 100) throw new ToolError("topN must be a whole number from 1 to 100");
    if (args.peer !== undefined && args.peer !== null && !["edit", "server", "client"].includes(args.peer)) throw new ToolError("peer must be edit, server or client");
    const peer: PeerRole = args.peer ?? (this.link.playPeers().server === "ready" ? "server" : "edit");
    const started = this.now();
    const result = await this.request(peer, "scene", { mode, topN }, StudioTools.timeout(args, mode === "all" ? 300_000 : 120_000));
    return { peer, ...result, ms: this.now() - started };
  }

  /** The place in Studio: ids, version, creator, the published name, edit mode or a play */
  private async placeInfo(args: Record<string, any>) {
    return this.request("edit", "placeInfo", {}, StudioTools.timeout(args, 15_000));
  }

  /** Studio's selection: read it, set it (or add, remove), or point the edit camera at it */
  private async selection(args: Record<string, any>) {
    const action = args.action ?? "get";
    if (!["get", "set", "view"].includes(action)) throw new ToolError("action must be get, set or view");
    const request: Record<string, unknown> = { action };
    if (action === "set") {
      if (!Array.isArray(args.paths) || args.paths.some((p: unknown) => typeof p !== "string" || !p.trim())) throw new ToolError("paths must be a list of instance paths (empty clears the selection)");
      if (args.mode !== undefined && !["set", "add", "remove"].includes(args.mode)) throw new ToolError("mode must be set, add or remove");
      Object.assign(request, { paths: args.paths.map((p: string) => p.trim()), mode: args.mode ?? "set" });
    }
    if (action === "view") {
      if (typeof args.path === "string" && args.path.trim()) request.path = args.path.trim();
      for (const [key, min, max] of [["from", -360, 360], ["angleY", -89, 89], ["padding", 0.1, 10]] as const) {
        if (args[key] === undefined || args[key] === null) continue;
        const n = Number(args[key]);
        if (!Number.isFinite(n) || n < min || n > max) throw new ToolError(`${key} must be a number from ${min} to ${max}`);
        request[key] = n;
      }
    }
    return this.request("edit", "selection", request, 15_000);
  }

  /**
   * A model from Roblox's generation (GenerationService:GenerateModelAsync) put in the place in
   * edit mode: a prompt, an image asset id, or both. 118 s for a crate (09/11/26, PA), so the
   * wait is 5 min by default.
   */
  private async generate(args: Record<string, any>) {
    const prompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt.trim() : undefined;
    let imageAssetId: number | undefined;
    if (args.imageAssetId !== undefined && args.imageAssetId !== null) {
      imageAssetId = Number(args.imageAssetId);
      if (!Number.isSafeInteger(imageAssetId) || imageAssetId <= 0) throw new ToolError("imageAssetId must be an image asset id");
    }
    if (!prompt && !imageAssetId) throw new ToolError("give a prompt, an image, or both");
    const vector = (key: string): number[] | undefined => {
      const v = args[key];
      if (v === undefined || v === null) return undefined;
      const list = Array.isArray(v) ? v.map(Number) : [Number(v?.x), Number(v?.y), Number(v?.z)];
      if (list.length !== 3 || !list.every(Number.isFinite)) throw new ToolError(`${key} must be x, y and z (studs)`);
      return list;
    };
    const size = vector("size");
    if (size && size.some((n) => n <= 0)) throw new ToolError("size must be above 0 on each axis");
    const position = vector("position");
    if (args.maxTriangles !== undefined && (!Number.isInteger(args.maxTriangles) || args.maxTriangles < 1)) throw new ToolError("maxTriangles must be a whole number above 0");
    if (args.schema !== undefined && !["Body1", "Car5"].includes(args.schema)) throw new ToolError("schema must be Body1 (one mesh) or Car5 (a car's five parts)");
    if (args.groups !== undefined && (!Array.isArray(args.groups) || !args.groups.length || args.groups.some((g: unknown) => typeof g !== "string" || !g))) throw new ToolError("groups must be a list of part names");
    const started = this.now();
    const result = await this.request("edit", "generate", {
      ...(prompt ? { prompt } : {}), ...(imageAssetId ? { imageAssetId } : {}), ...(size ? { size } : {}), ...(position ? { position } : {}),
      ...(args.maxTriangles ? { maxTriangles: args.maxTriangles } : {}), ...(typeof args.textures === "boolean" ? { textures: args.textures } : {}),
      ...(args.schema ? { schema: args.schema } : {}), ...(args.groups ? { groups: args.groups } : {}),
      ...(typeof args.name === "string" && args.name.trim() ? { name: args.name.trim() } : {}),
      ...(typeof args.parent === "string" && args.parent.trim() ? { parent: args.parent.trim() } : {}),
    }, StudioTools.timeout(args, 300_000));
    return { ...result, ms: this.now() - started };
  }

  static readonly MICRO_FOCUS = ["all", "script", "physics", "render", "network", "jobs"];

  /**
   * The MicroProfiler for durationMs through LibMP: frame times, the scopes that took them (self
   * and inclusive ms a frame, the worst frame), groups and threads. Edit mode with no play, the
   * play server during one, or the peer named; a solo play is one Studio process, so the peers
   * read the same profiler. `out` (or save) keeps the capture, LZ4-compressed, for LibMP or the
   * MicroProfiler's own viewer.
   */
  private async micro(args: Record<string, any>) {
    if (args.peer !== undefined && args.peer !== null && !["edit", "server", "client"].includes(args.peer)) throw new ToolError("peer must be edit, server or client");
    const peer: PeerRole = args.peer ?? (this.link.playPeers().server === "ready" ? "server" : "edit");
    const whole = (key: string, fallback: number, min: number, max: number) => {
      if (args[key] === undefined || args[key] === null) return fallback;
      const n = Number(args[key]);
      if (!Number.isInteger(n) || n < min || n > max) throw new ToolError(`${key} must be a whole number from ${min} to ${max}`);
      return n;
    };
    const durationMs = whole("durationMs", 1000, 100, 5000);
    // Left out: the frames that cover durationMs, back from the last one
    const frames = args.frames === undefined || args.frames === null ? undefined : whole("frames", 256, 1, 256);
    const maxTimers = whole("maxTimers", 20, 1, 100);
    const focus = args.focus ?? "all";
    if (!StudioTools.MICRO_FOCUS.includes(focus)) throw new ToolError(`focus must be one of ${StudioTools.MICRO_FOCUS.join(", ")}`);
    if (args.sort !== undefined && args.sort !== "self" && args.sort !== "inclusive") throw new ToolError("sort must be self or inclusive");
    if (typeof args.out === "string" && args.out && !path.isAbsolute(args.out)) throw new ToolError("out must be an absolute path");
    const save = args.save === true || (typeof args.out === "string" && args.out !== "");
    const started = this.now();
    // The capture, then the first require of LibMP (3.3 MB of Luau) and the read of every frame
    const result = await this.request<any>(peer, "micro", {
      durationMs, ...(frames ? { frames } : {}), maxTimers, focus, sort: args.sort ?? "self", includeGpu: args.includeGpu === true, includeIdle: args.includeIdle === true,
      ...(typeof args.filter === "string" && args.filter ? { filter: args.filter } : {}), save, keep: args.keep === true,
    }, StudioTools.timeout(args, durationMs + 60_000));
    const answer: Record<string, unknown> = { peer, ...result, ms: this.now() - started };
    if (typeof result?.raw === "string") {
      delete answer.raw;
      const file = typeof args.out === "string" && args.out
        ? args.out
        : path.join(path.dirname(this.screenshotDir), "profiler", `micro-${peer}-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}.mpz`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(result.raw, "base64"));
      answer.file = file;
    }
    if (peer !== "edit" && this.multiplayer === undefined) answer.note = "a solo play and edit mode are one Studio process: one MicroProfiler, whichever peer reads it";
    return answer;
  }

  /** The image the last screenshot answered with, to read a mouse point given on it */
  private lastShot: { width: number; height: number; crop?: { x: number; y: number; w: number; h: number } } | undefined;

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
