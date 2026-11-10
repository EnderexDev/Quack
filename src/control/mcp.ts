import fs from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { BUNDLED_VERSION } from "../bundled.js";
import { newErrorsText, recordSummary, runControl, type ControlContext } from "./commands.js";
import { instructions } from "./rule.js";

/**
 * `quack mcp` / `quackdev mcp`: the hub for an AI, as an MCP server on stdio (JSON-RPC, one
 * message per line). Each tool runs the terminal command of the same name through runControl,
 * so the terminal and the AI never read the hub two ways. Reading, waiting, play and the Studio
 * tools (evals, execute_luau, playtest, screenshots, keys, the device simulator, Creator Store
 * assets previewed and inserted, memory, the script profiler, scene analysis, the MicroProfiler,
 * the selection, a generated model, a timed-out call's answer), the Roblox web tools that need
 * no hub (the engine reference, the Creator Store, an Open Cloud upload, a place's saved versions
 * and one downloaded), the Open Cloud jobs the hub runs with its key (badges, developer
 * products, game passes, the localization table, analytics; each write asks the user in
 * Quack's app), and opening a place in Studio: a change to the hub (resolve, pause,
 * register...) stays a person's, in the app or the terminal.
 */

type Context = Omit<ControlContext, "out" | "err" | "confirm" | "interactive" | "color">;

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  argv: (args: Record<string, unknown>) => string[];
  /** Keeps only the end of a long answer (the log) */
  tail?: (args: Record<string, unknown>) => number;
  /** Builds the answer from the command's output instead of one text block (a screenshot's image) */
  finish?: (body: string, code: number) => object[];
}

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const placeProp = { place: { type: "string", description: "Place id or (part of) its name. Left out: the place whose folder the AI runs in, or the only one registered." } };

/** A value from the AI becomes one argv entry: one that starts with "-" would be read as an option */
function text(args: Record<string, unknown>, key: string, required = false): string[] {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new ToolInputError(`${key} is required`);
    return [];
  }
  if (typeof value !== "string" && typeof value !== "number") throw new ToolInputError(`${key} must be a string`);
  const s = String(value);
  if (s.startsWith("-")) throw new ToolInputError(`${key} cannot start with "-"`);
  return [s];
}

function number(args: Record<string, unknown>, key: string, flag: string): string[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ToolInputError(`${key} must be a number, 0 or more`);
  return [flag, String(value)];
}

class ToolInputError extends Error {}

const luauSchema = {
  type: "object",
  properties: {
    code: { type: "string", description: "Luau; `return` a value to get it back (tables come back as JSON)" },
    ...placeProp,
    timeoutSeconds: { type: "number", description: "How long to wait for it (default 30)" },
  },
  required: ["code"],
};

/** Luau goes as one --code=<text> entry: code that starts with "--" must not read as an option */
function codeFlag(args: Record<string, unknown>): string {
  if (typeof args.code !== "string" || args.code.trim() === "") throw new ToolInputError("code is required");
  return `--code=${args.code}`;
}

function worktreeList(args: Record<string, unknown>): string[] {
  const value = args.worktrees;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((w) => typeof w !== "string" || w === "" || w.startsWith("-"))) {
    throw new ToolInputError("worktrees must be a list of paths, none starting with \"-\"");
  }
  return value as string[];
}

export const TOOLS: Tool[] = [
  {
    name: "status",
    description: "The hub, the AI merge and every registered place with its folder: whether Studio is connected, instances, scripts, conflicts waiting. Call it before editing synced files.",
    inputSchema: { type: "object", properties: {} },
    argv: () => ["status"],
  },
  {
    name: "wait",
    description: "Returns once the place's Studio is connected and nothing has synced for a moment (default 1.5 s). Call it after editing synced files or a git merge there, and before starting a playtest or reading scripts in Studio. It lists script files on disk that have no instance in Studio.",
    inputSchema: {
      type: "object",
      properties: {
        ...placeProp,
        connectedOnly: { type: "boolean", description: "Only until Studio is connected, not until the sync is quiet" },
        fix: { type: "boolean", description: "Send the create of each listed script file again; Studio reuses a script already there, so nothing is duplicated" },
        idleMs: { type: "number", description: "How long the sync must be quiet (default 1500)" },
        timeoutSeconds: { type: "number", description: "Give up after this long (default 120)" },
      },
    },
    argv: (args) => ["wait", ...text(args, "place"), ...(args.connectedOnly === true ? ["--connected"] : []), ...(args.fix === true ? ["--fix"] : []), ...number(args, "idleMs", "--idle"), ...number(args, "timeoutSeconds", "--timeout")],
  },
  {
    name: "log",
    description: "The end of the place's daemon log: what synced each way, scripts created or deleted, errors. Read it after a git operation in the synced folder, looking for deletions it did not ask for.",
    inputSchema: { type: "object", properties: { ...placeProp, lines: { type: "number", description: "How many of the last lines (default 200)" } } },
    argv: (args) => ["log", ...text(args, "place")],
    tail: (args) => (typeof args.lines === "number" && args.lines > 0 ? Math.max(1, Math.floor(args.lines)) : 200),
  },
  {
    name: "conflicts",
    description: "Scripts edited in Studio and on disk at once whose disk version the merge did not keep. Check after a batch of edits: an edit listed here did not reach Studio. Settling one is the user's call (the app, or `resolve` in the terminal).",
    inputSchema: { type: "object", properties: { ...placeProp } },
    argv: (args) => ["conflicts", ...text(args, "place")],
  },
  {
    name: "conflict",
    description: "One conflict: the saved disk version the merge did not keep, and the script as it is now.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The id `conflicts` lists" }, ...placeProp }, required: ["id"] },
    argv: (args) => ["conflict", ...text(args, "id", true), ...text(args, "place")],
  },
  {
    name: "doctor",
    description: "Checks the hub, its build against the installed app, the Studio plugin and the registered folders. Call it when the sync seems off.",
    inputSchema: { type: "object", properties: {} },
    argv: () => ["doctor"],
  },
  {
    name: "play",
    description: "Starts a playtest in Studio with the scripts a git worktree's branch changed since it forked from the synced folder; every other script runs as Studio has it. Waits for the play's own check and answers 'N of M have the branch' or what did not arrive. Several worktrees share one play when no two change the same script, and the check answers for each. One play at a time: stop the running one first.",
    inputSchema: {
      type: "object",
      properties: {
        worktree: { type: "string", description: "Absolute path of the worktree (default: the folder the AI runs in)" },
        worktrees: { type: "array", items: { type: "string" }, description: "Several worktrees in one play (absolute paths), instead of worktree" },
        ...placeProp,
        timeoutSeconds: { type: "number", description: "How long to wait for the play's check (default 60)" },
      },
    },
    argv: (args) => [
      "play",
      ...text(args, "place"),
      ...(text(args, "worktree").length ? ["-w", String(args.worktree)] : []),
      ...worktreeList(args).flatMap((w) => ["-w", w]),
      ...number(args, "timeoutSeconds", "--timeout"),
    ],
  },
  {
    name: "eval_server_runtime",
    description: "Runs Luau in the running play's server, in the game VM with the game's require cache (require gives the modules the game's scripts hold). Returns what the code printed (print/warn) and what it returned; a Luau error comes back as the error. Needs a play running (solo_playtest).",
    inputSchema: luauSchema,
    argv: (args) => ["eval-server", ...text(args, "place"), codeFlag(args), ...number(args, "timeoutSeconds", "--timeout")],
  },
  {
    name: "eval_client_runtime",
    description: "Runs Luau in the running play's client (a LocalScript's VM, with the game's require cache): Players.LocalPlayer, the player's GUI, the client's modules. Returns what it printed and returned. Needs a solo play in Play mode (Run mode has no client).",
    inputSchema: luauSchema,
    argv: (args) => ["eval-client", ...text(args, "place"), codeFlag(args), ...number(args, "timeoutSeconds", "--timeout")],
  },
  {
    name: "execute_luau",
    description: "Runs Luau in the Quack plugin of Studio in edit mode (plugin security: Source, Selection, ChangeHistoryService). What it changes in the place syncs to disk like any edit in Studio. Its require gives fresh module copies, not the running game's: use the eval tools for a running play.",
    inputSchema: luauSchema,
    argv: (args) => ["exec", ...text(args, "place"), codeFlag(args), ...number(args, "timeoutSeconds", "--timeout")],
  },
  {
    name: "solo_playtest",
    description: "Starts, stops or reports a solo playtest. start returns once the play's server (and client, in Play mode) is connected; stop returns once Studio is back in edit mode. A play is needed by the eval tools, keyboard input and the play's logs.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "status"] },
        mode: { type: "string", enum: ["play", "run"], description: "start only: play (server and client, default) or run (server only)" },
        players: { type: "number", description: "start only: a multiplayer test with this many players (Studio's Local Server, 1 to 8); the client tools then take player (Player1, Player2...)" },
        ...placeProp,
        timeoutSeconds: { type: "number", description: "start: how long to wait for the play (default 60); stop: default 15" },
      },
      required: ["action"],
    },
    argv: (args) => {
      if (!["start", "stop", "status"].includes(String(args.action))) throw new ToolInputError("action must be start, stop or status");
      if (args.mode !== undefined && args.mode !== "play" && args.mode !== "run") throw new ToolInputError("mode must be play or run");
      return ["playtest", String(args.action), ...text(args, "place"), ...(args.mode === "run" ? ["--run"] : []), ...number(args, "players", "--players"), ...number(args, "timeoutSeconds", "--timeout")];
    },
  },
  {
    name: "capture_screenshot",
    description: "A PNG of the Studio viewport: the play client's view while a play runs, else edit mode. width caps its pixels (an image costs by its pixels: 800 is often enough to read a UI). focus on a GUI object's path (PlayerGui.Windows.Shop) keeps only the part of the screen it covers; on a part or model it points the camera at it for the capture and puts the camera back. simulate_mouse_input reads x and y on the last screenshot, cropped or not. Fails with the reason when the window is minimized or not rendering. The file is also saved; its path is in the answer.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number", description: "At most this many pixels wide (64 to 4096; default the window's own size)" },
        focus: { type: "string", description: "A GuiObject to crop to, or a BasePart / Model to point the camera at" },
        ...placeProp,
      },
    },
    argv: (args) => ["screenshot", ...text(args, "place"), ...number(args, "width", "--width"), ...(text(args, "focus").length ? [`--focus=${args.focus}`] : []), "--json"],
    finish: screenshotAnswer,
  },
  {
    name: "get_runtime_logs",
    description: "The running play's output (server and client), oldest first, with a cursor: pass the cursor of the last read to get only what came after. The cursor survives a stop and a new play; '--- play started ---' lines mark each play.",
    inputSchema: {
      type: "object",
      properties: {
        ...placeProp,
        cursor: { type: "string", description: "The cursor a previous read returned" },
        tail: { type: "number", description: "Only the last N lines (default 100 without a cursor, 1000 with one)" },
        filter: { type: "string", description: "Only lines containing this text" },
        peer: { type: "string", enum: ["server", "client"], description: "Only one peer's lines" },
      },
    },
    argv: (args) => {
      if (args.cursor !== undefined && args.cursor !== null && !/^\d+$/.test(String(args.cursor))) throw new ToolInputError("cursor must be the cursor a previous read returned");
      if (args.peer !== undefined && args.peer !== "server" && args.peer !== "client") throw new ToolInputError("peer must be server or client");
      if (args.tail !== undefined && !(Number.isInteger(args.tail) && (args.tail as number) > 0)) throw new ToolInputError("tail must be a whole number above 0");
      return [
        "output", ...text(args, "place"),
        ...(args.cursor !== undefined && args.cursor !== null ? [`--cursor=${args.cursor}`] : []),
        ...(args.tail !== undefined ? [`--tail=${args.tail}`] : []),
        ...(typeof args.filter === "string" && args.filter ? [`--filter=${args.filter}`] : []),
        ...(args.peer ? [`--peer=${args.peer}`] : []),
      ];
    },
  },
  {
    name: "simulate_keyboard_input",
    description: "Sends a key (an Enum.KeyCode name: W, Space, E, LeftShift...) or text for the focused TextBox to the play client, or to Studio in edit mode when no play runs. tap presses, waits `duration` and releases. Fails with the reason when the window is minimized.",
    inputSchema: {
      type: "object",
      properties: {
        keyCode: { type: "string", description: "Enum.KeyCode name; leave out when sending text" },
        text: { type: "string", description: "Text for the focused TextBox, instead of a key" },
        action: { type: "string", enum: ["tap", "press", "release"], description: "Default tap" },
        duration: { type: "number", description: "tap: seconds held (default 0.1)" },
        peer: { type: "string", enum: ["client", "edit"], description: "Default: the play client when one runs, else edit" },
        ...placeProp,
      },
    },
    argv: (args) => {
      const keyCode = text(args, "keyCode");
      const hasText = typeof args.text === "string";
      if (!keyCode.length && !hasText) throw new ToolInputError("keyCode or text is required");
      if (keyCode.length && hasText) throw new ToolInputError("give keyCode or text, not both");
      if (args.action !== undefined && !["tap", "press", "release"].includes(String(args.action))) throw new ToolInputError("action must be tap, press or release");
      if (args.peer !== undefined && args.peer !== "client" && args.peer !== "edit") throw new ToolInputError("peer must be client or edit");
      return [
        "key", ...keyCode, ...text(args, "place"),
        ...(hasText ? [`--text=${args.text}`] : []),
        ...(args.action ? [`--action=${args.action}`] : []),
        ...(typeof args.duration === "number" ? [`--duration=${args.duration}`] : []),
        ...(args.peer ? [`--peer=${args.peer}`] : []),
      ];
    },
  },
  {
    name: "set_device_simulator",
    description: "Studio's device simulator: a built-in device (deviceId), orientation (Enum.ScreenOrientation name), resolution, pixel density, scaling mode (Enum.DeviceSimulatorScalingMode name), or stopSimulation. With no setting it reports the state; list adds the device ids.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        orientation: { type: "string" },
        resolution: { type: "object", properties: { width: { type: "number" }, height: { type: "number" } }, required: ["width", "height"] },
        pixelDensity: { type: "number" },
        scalingMode: { type: "string" },
        stopSimulation: { type: "boolean" },
        list: { type: "boolean", description: "Also list the built-in device ids" },
        ...placeProp,
      },
    },
    argv: (args) => {
      const resolution = args.resolution as { width?: unknown; height?: unknown } | undefined;
      if (resolution !== undefined && !(Number.isInteger(resolution?.width) && Number.isInteger(resolution?.height))) throw new ToolInputError("resolution must be { width, height } in whole pixels");
      if (args.pixelDensity !== undefined && typeof args.pixelDensity !== "number") throw new ToolInputError("pixelDensity must be a number");
      const flag = (key: string, name: string) => (text(args, key).length ? [`--${name}=${args[key]}`] : []);
      return [
        "device", ...text(args, "place"),
        ...flag("deviceId", "id"), ...flag("orientation", "orientation"), ...flag("scalingMode", "scaling"),
        ...(resolution ? [`--resolution=${resolution.width}x${resolution.height}`] : []),
        ...(typeof args.pixelDensity === "number" ? [`--density=${args.pixelDensity}`] : []),
        ...(args.stopSimulation === true ? ["--stop"] : []),
        ...(args.list === true ? ["--list"] : []),
      ];
    },
  },
  {
    name: "click_gui",
    description: "Clicks a GUI button in the play client by its instance path (PlayerGui.Shop.Frame.Buy, Players.LocalPlayer.PlayerGui..., or StarterGui.Shop.Frame.Buy for the player's copy). The point comes from the button itself, so display scaling and the device simulator do not matter. Answers whether its Activated / MouseButton1Click fired, the method and the point; refuses with the cause (not a GuiButton, hidden, disabled ScreenGui, zero size, off-screen, covered by another button). method auto (default) clicks with virtual input and, if no signal fired, selects the button and presses Return; select skips the position checks.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The button's path, dots between names" },
        method: { type: "string", enum: ["auto", "input", "select"], description: "Default auto" },
        ...placeProp,
      },
      required: ["path"],
    },
    argv: (args) => {
      if (args.method !== undefined && !["auto", "input", "select"].includes(String(args.method))) throw new ToolInputError("method must be auto, input or select");
      return ["click", ...text(args, "path", true), ...text(args, "place"), ...(args.method ? [`--method=${args.method}`] : [])];
    },
  },
  {
    name: "wait_for",
    description: "Waits inside the running play instead of sleeping: until Luau in the play server (or client) turns truthy, tried every intervalMs, or until a play output line matches a regular expression, or the deadline (default 30 s, at most 600). Code with no `return` is taken as an expression (`workspace:FindFirstChild('Boss')`); code with one returns its value. Answers what it returned, the time and the tries; on the deadline, the last value or error. A Luau error in a try (indexing something not there yet) just counts as not yet.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Luau expression, or code that returns; truthy ends the wait" },
        pattern: { type: "string", description: "A regular expression (JavaScript) for a play output line, from the server or the client" },
        peer: { type: "string", enum: ["server", "client"], description: "Where the code runs (default server)" },
        intervalMs: { type: "number", description: "Between tries (default 250)" },
        timeoutSeconds: { type: "number", description: "The deadline (default 30, at most 600)" },
        tryTimeoutSeconds: { type: "number", description: "One try's own limit (default 5)" },
        cursor: { type: "string", description: "Match output lines after this get_runtime_logs cursor too (default: only lines from now on)" },
        ...placeProp,
      },
    },
    argv: (args) => {
      const hasCode = typeof args.code === "string" && args.code.trim() !== "";
      const pattern = typeof args.pattern === "string" && args.pattern !== "" ? args.pattern : undefined;
      if (!hasCode && !pattern) throw new ToolInputError("code or pattern is required");
      if (args.peer !== undefined && args.peer !== "server" && args.peer !== "client") throw new ToolInputError("peer must be server or client");
      if (args.cursor !== undefined && args.cursor !== null && !/^\d+$/.test(String(args.cursor))) throw new ToolInputError("cursor must be the cursor a previous read returned");
      return [
        "wait-for", ...text(args, "place"),
        ...(hasCode ? [codeFlag(args)] : []),
        ...(pattern ? [`--pattern=${pattern}`] : []),
        ...(args.peer ? [`--peer=${args.peer}`] : []),
        ...number(args, "intervalMs", "--interval"),
        ...number(args, "timeoutSeconds", "--timeout"),
        ...number(args, "tryTimeoutSeconds", "--try-timeout"),
        ...(args.cursor !== undefined && args.cursor !== null ? [`--cursor=${args.cursor}`] : []),
      ];
    },
  },
  {
    name: "record",
    description: "A short video of the play client's view (edit mode with no play): screenshots for `seconds` (default 3, at most 15) at `fps` (default 5, at most 10), saved as an animated GIF under the place's .quack/recordings (the last 10 kept). The answer carries a contact sheet of up to 12 frames spread over the recording (left to right, then down) as the image, the real frame rate and the GIF's path, for judging VFX and UI animation that one screenshot cannot show.",
    inputSchema: {
      type: "object",
      properties: {
        seconds: { type: "number" },
        fps: { type: "number" },
        width: { type: "number", description: "Frame width in pixels (default 640)" },
        ...placeProp,
      },
    },
    argv: (args) => ["record", ...text(args, "place"), ...number(args, "seconds", "--seconds"), ...number(args, "fps", "--fps"), ...number(args, "width", "--width"), "--json"],
    finish: recordAnswer,
  },
  {
    name: "inspect_gui",
    description: "Reads a GUI as the player sees it, instead of an eval that walks PlayerGui: one line per object with its class, text, image id, place and size (GUI pixels), modifiers (UICorner, UIStroke...), whether it is hidden and by what (its own Visible, a hidden ancestor, a disabled ScreenGui), and for a button whether a click would reach it (or what covers it). Children come in their layout's order. Hidden subtrees and anything past depth are counted, not listed (hidden true opens them). Default: the play client's PlayerGui, or StarterGui in edit mode with no play. Paths as click_gui takes them.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Where to start: PlayerGui.Windows.Shop, StarterGui.HUD, Players.LocalPlayer.PlayerGui... (default the whole PlayerGui)" },
        depth: { type: "number", description: "Levels below the path (default 3)" },
        limit: { type: "number", description: "At most this many objects (default 250)" },
        hidden: { type: "boolean", description: "Open hidden subtrees too" },
        ...placeProp,
      },
    },
    argv: (args) => ["gui", ...text(args, "place"), ...(text(args, "path").length ? [`--path=${args.path}`] : []), ...number(args, "depth", "--depth"), ...number(args, "limit", "--limit"), ...(args.hidden === true ? ["--hidden"] : [])],
  },
  {
    name: "verify_sync",
    description: "Checks that Studio holds the disk's text of every synced script (or the files named), instead of reading .Source in execute_luau: by length and hash, in each script's .Source and in its open tab, which is the text a play copies. Answers each one that differs and how (an older .Source, an open tab with other text, an instance gone), and script files with no instance in Studio. Call it after edits, before a playtest, to know they arrived. Errors when any differ.",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "Script files, paths from the sync folder (ServerScriptService/Main.server.luau); default every script" },
        ...placeProp,
      },
    },
    argv: (args) => {
      const files = args.files;
      if (files !== undefined && (!Array.isArray(files) || files.some((f) => typeof f !== "string" || !f || f.includes(",")))) throw new ToolInputError("files must be a list of paths, none with a comma");
      return ["verify", ...text(args, "place"), ...(Array.isArray(files) && files.length ? [`--files=${files.join(",")}`] : [])];
    },
  },
  {
    name: "studio_changes",
    description: "Which uncommitted changes in the place's synced folder came from Studio (a game designer tuning values there; the sync writes them to disk), so they are not taken for someone's work in progress. Lists every file git sees as changed in the sync folder, new files too, each marked: studio (Studio wrote it and nothing touched it since; from the commit only Studio changed it), mixed (Studio wrote it, but the disk changed it after, or it already held another uncommitted edit, or a merge) or other (not from Studio). Quack knows because its daemon writes those files itself; no Studio call, so it answers with Studio closed. numbersOnly also says which of Studio's files differ from the commit only in numeric literals. Paths are from the repository's root. It commits nothing: whether to commit is the user's call.",
    inputSchema: {
      type: "object",
      properties: {
        numbersOnly: { type: "boolean", description: "Also say which of Studio's files differ from the commit only in numbers" },
        ...placeProp,
      },
    },
    argv: (args) => ["changes", ...text(args, "place"), ...(args.numbersOnly === true ? ["--numbers-only"] : [])],
  },
  {
    name: "perf_sample",
    description: "Measures the running play for a few seconds in the server and the client at once (or one peer): fps, frame times p50 / p90 / p99 / max (the client's RenderStepped, the server's Heartbeat), hitches over 50 ms, memory and its change, the top memory tags, instances, network kbps, the server's physics fps. Take one before and one after a change, in the same play. A solo play runs both peers in one Studio process: the server's frame times carry the client's drawing, and memory is the whole Studio process (the same number in both). A minimized window draws no frames.",
    inputSchema: {
      type: "object",
      properties: {
        seconds: { type: "number", description: "How long to sample (default 3, 0.5 to 30)" },
        peer: { type: "string", enum: ["server", "client"], description: "Only one peer (default both)" },
        ...placeProp,
      },
    },
    argv: (args) => {
      if (args.peer !== undefined && args.peer !== "server" && args.peer !== "client") throw new ToolInputError("peer must be server or client");
      return ["perf", ...text(args, "place"), ...number(args, "seconds", "--seconds"), ...(args.peer ? [`--peer=${args.peer}`] : [])];
    },
  },
  {
    name: "set_logpoint",
    description: "A logpoint: a script line that prints values each time it runs in the play, with no edit to the script and no sync cycle (Studio's ScriptDebuggerService, set in edit mode before or during a play). message is a comma-separated list of Luau expressions, as print takes them (\"hp\", humanoid.Health, os.clock()); condition is Luau that must be truthy. Its lines reach get_runtime_logs as \"[logpoint Script:Line] ...\". Use for timings and for values inside a function an eval cannot reach. action list, remove, clear. Needs Studio's beta feature \"Studio Debugger Luau API\"; the refusal says so.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove", "list", "clear"], description: "Default add" },
        file: { type: "string", description: "The script's file, from the sync folder (ServerScriptService/Main.server.luau)" },
        path: { type: "string", description: "Instead of file: its instance path" },
        line: { type: "number" },
        message: { type: "string", description: "Luau expressions to print, comma-separated" },
        condition: { type: "string", description: "Luau; only when truthy" },
        ...placeProp,
      },
    },
    argv: (args) => {
      const action = args.action === undefined ? "add" : String(args.action);
      if (!["add", "remove", "list", "clear"].includes(action)) throw new ToolInputError("action must be add, remove, list or clear");
      if (action === "list" || action === "clear") return ["logpoint", action, ...text(args, "place")];
      const file = text(args, "file");
      const scriptPath = typeof args.path === "string" && args.path ? args.path : undefined;
      if (!file.length && !scriptPath) throw new ToolInputError("give file or path");
      if (typeof args.line !== "number" || !Number.isInteger(args.line) || args.line < 1) throw new ToolInputError("line must be a line number");
      return [
        "logpoint", action, ...file, ...text(args, "place"), ...(file.length ? [] : [`--path=${scriptPath}`]), `--line=${args.line}`,
        ...(typeof args.message === "string" && args.message ? [`--message=${args.message}`] : []),
        ...(typeof args.condition === "string" && args.condition ? [`--condition=${args.condition}`] : []),
      ];
    },
  },
  {
    name: "export_rbxm",
    description: "Saves instances of the place (edit mode) as one .rbxm file: a model, a map piece, a UI, to carry to another place or keep. Answers the file's path (default under the place's .quack/exports).",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Instance paths (Workspace.Map.Tower, StarterGui.Shop)" },
        out: { type: "string", description: "Absolute path of the .rbxm to write" },
        ...placeProp,
      },
      required: ["paths"],
    },
    argv: (args) => {
      const paths = args.paths;
      if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== "string" || !p || p.includes(",") || p.startsWith("-"))) throw new ToolInputError("paths must be a list of instance paths, none with a comma");
      if (args.out !== undefined && (typeof args.out !== "string" || !/\.rbxm$/i.test(args.out))) throw new ToolInputError("out must be an .rbxm path");
      return ["export", paths.join(","), ...text(args, "place"), ...(args.out ? [`--out=${args.out}`] : [])];
    },
  },
  {
    name: "import_rbxm",
    description: "Puts an .rbxm file's instances, or a place file's (.rbxl from download_place, Workspace and StarterGui included), in the place in edit mode as one undo step; scripts inside sync to disk like any made in Studio. A worktree's play carries scripts only: this is how a model or UI from elsewhere comes in. For a place file: list true first (reads the file, no Studio: its items and scripts), then paths to bring back only what is missing, each item into its own parent here (Workspace.MapA into Workspace); a place with no paths lands whole under ServerStorage, each service a Folder. A place file is untrusted: its scripts land only with scripts true, after you read the list. Terrain voxels never come.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Absolute path of the .rbxm or .rbxl" },
        paths: { type: "array", items: { type: "string" }, description: "Only these items of the file: Workspace.MapA, StarterGui.Shop, ReplicatedStorage.Config; a service alone (StarterGui) is all its items" },
        parent: { type: "string", description: "Where to put them (default Workspace for a model; for a place, each item's own parent, or ServerStorage with no paths)" },
        list: { type: "boolean", description: "Only read the file: its top-level items, scripts and Terrain; no Studio" },
        scripts: { type: "boolean", description: "Let a place file's scripts land (read them in list first)" },
        ...placeProp,
      },
      required: ["file"],
    },
    argv: (args) => {
      const paths = args.paths;
      if (paths !== undefined && (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== "string" || !p.trim() || p.includes(",") || p.startsWith("-")))) throw new ToolInputError("paths must be a list of paths in the file, none with a comma");
      return [
        "import", ...text(args, "file", true), ...text(args, "place"),
        ...(typeof args.parent === "string" && args.parent ? [`--parent=${args.parent}`] : []),
        ...(Array.isArray(paths) ? [`--paths=${paths.join(",")}`] : []),
        ...(args.list === true ? ["--list"] : []),
        ...(args.scripts === true ? ["--scripts"] : []),
      ];
    },
  },
  {
    name: "find_instances",
    description: "Finds instances by name (wildcards * and ?, any case), class (one or several, comma-separated) and where (under a path). With no peer: Quack's own copy of the synced tree, no Studio call, the place in edit mode as of the last sync, classes by exact ClassName, each script's file. With peer server or client: the RUNNING play's DataModel (what the game made, PlayerGui on the client), classes by IsA unless exact, and also by attribute (name, and value) and CollectionService tag; peer edit does the same in Studio's live edit mode. An attribute or a tag with no peer searches the play server during a play, else edit mode. Without under, a live search covers the game's services (Workspace, Players, ReplicatedStorage, ServerStorage, StarterGui...), not CoreGui. Answers paths, classes and each one's attribute count; inspect_instance reads one whole.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name pattern: Boss*, *Button, Shop" },
        className: { type: "string", description: "A class, or several comma-separated (MeshPart,Part); live: IsA (BasePart finds every part)" },
        exact: { type: "boolean", description: "Live search: the exact ClassName instead of IsA" },
        under: { type: "string", description: "Only below this path (ReplicatedStorage.Assets, Workspace.Enemies, PlayerGui.Shop)" },
        attribute: { type: "string", description: "Live search: has this attribute" },
        attributeValue: { type: ["string", "number", "boolean"], description: "With attribute: that value (a number by value, true/false, a string as it is)" },
        tag: { type: "string", description: "Live search: has this CollectionService tag" },
        peer: { type: "string", enum: ["server", "client", "edit"], description: "Search this live DataModel instead of the synced tree" },
        limit: { type: "number", description: "At most this many listed (default 100, live 50); the total is always counted" },
        ...placeProp,
      },
    },
    argv: (args) => {
      if (![args.name, args.className, args.under, args.attribute, args.tag].some((v) => typeof v === "string" && v.trim())) throw new ToolInputError("give name, className, under, attribute or tag");
      if (args.peer !== undefined && !["server", "client", "edit"].includes(String(args.peer))) throw new ToolInputError("peer must be server, client or edit");
      const flag = (key: string, name: string) => (typeof args[key] === "string" && (args[key] as string).trim() ? [`--${name}=${args[key]}`] : []);
      let attr: string[] = [];
      if (typeof args.attribute === "string" && args.attribute.trim()) {
        const attribute = args.attribute.trim();
        if (!/^[A-Za-z0-9_]+$/.test(attribute)) throw new ToolInputError("attribute must be an attribute's name (letters, digits and _)");
        const value = args.attributeValue;
        if (value !== undefined && value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new ToolInputError("attributeValue must be a string, a number or true/false");
        attr = [value === undefined || value === null ? `--attr=${attribute}` : `--attr=${attribute}=${value}`];
      } else if (args.attributeValue !== undefined) throw new ToolInputError("attributeValue needs attribute");
      return [
        "find", ...text(args, "place"), ...flag("name", "name"), ...flag("className", "class"), ...flag("under", "under"), ...number(args, "limit", "--limit"),
        ...(args.peer ? [`--peer=${args.peer}`] : []), ...attr, ...flag("tag", "tag"), ...(args.exact === true ? ["--exact"] : []),
      ];
    },
  },
  {
    name: "inspect_instance",
    description: "Reads one instance whole instead of an eval that lists properties: the properties that differ from a new instance of its class (all true: every readable one), each with its type, its attributes, tags, children, and a model's pivot and bounding box. During a play it reads the running game (the server, or the client for a PlayerGui path); peer edit reads the place in edit mode.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace.Map.Door, ReplicatedStorage.Config, PlayerGui.Shop..." },
        peer: { type: "string", enum: ["edit", "server", "client"], description: "Default: the play server (client for PlayerGui) while a play runs, else edit" },
        all: { type: "boolean", description: "Every readable property, defaults included" },
        hidden: { type: "boolean", description: "Also deprecated and hidden properties" },
        ...placeProp,
      },
      required: ["path"],
    },
    argv: (args) => {
      if (args.peer !== undefined && !["edit", "server", "client"].includes(String(args.peer))) throw new ToolInputError("peer must be edit, server or client");
      return ["inspect", ...text(args, "path", true), ...text(args, "place"), ...(args.peer ? [`--peer=${args.peer}`] : []), ...(args.all === true ? ["--all"] : []), ...(args.hidden === true ? ["--hidden"] : [])];
    },
  },
  {
    name: "set_properties",
    description: "Changes properties and attributes of one instance together: every value is checked before anything changes, and one undo step in edit mode. A plain value takes the type of what is there now (\"Neon\" for Material, [1, 2, 3] for a Vector3, \"#ff8800\" for a Color3, a path for an Instance property); or name the type: {\"Vector3\": [1, 2, 3]}, {\"UDim2\": [0, 10, 0.5, 0]}, {\"CFrame\": [x, y, z, rx, ry, rz]}, {\"Enum\": \"Name\"}. An attribute set to null is removed. In edit mode the change is the place's (and a script's Source is not a property here: edit its file); during a play, the running game's.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        properties: { type: "object", description: "name: value" },
        attributes: { type: "object", description: "name: value (null removes it)" },
        peer: { type: "string", enum: ["edit", "server", "client"], description: "Default as inspect_instance" },
        ...placeProp,
      },
      required: ["path"],
    },
    argv: (args) => {
      const isObject = (v: unknown) => v !== undefined && v !== null && typeof v === "object" && !Array.isArray(v);
      if (args.properties !== undefined && !isObject(args.properties)) throw new ToolInputError("properties must be an object");
      if (args.attributes !== undefined && !isObject(args.attributes)) throw new ToolInputError("attributes must be an object");
      if (args.peer !== undefined && !["edit", "server", "client"].includes(String(args.peer))) throw new ToolInputError("peer must be edit, server or client");
      return [
        "set", ...text(args, "path", true), ...text(args, "place"),
        ...(args.properties ? [`--props=${JSON.stringify(args.properties)}`] : []),
        ...(args.attributes ? [`--attrs=${JSON.stringify(args.attributes)}`] : []),
        ...(args.peer ? [`--peer=${args.peer}`] : []),
      ];
    },
  },
  {
    name: "simulate_conditions",
    description: "Studio's network and performance simulation, the toolbar's Network simulation and Performance simulation panels: a network preset (off, great 15 ms, good 50 ms with 10 ms jitter, poor 150 ms with 100 ms jitter and 0.5% loss) or each side's latency, jitter and loss (the engine allows at most 0.5% loss); the graphics quality level (auto or 1 to 21); the device memory in MB. Set in edit mode and in the play client when one runs; a multiplayer client keeps the values it started with. With nothing to set it reports the state. Put it back (network off, quality auto) when done: it is Studio's own setting and stays.",
    inputSchema: {
      type: "object",
      properties: {
        network: { type: "string", enum: ["off", "great", "good", "poor"] },
        inbound: { type: "object", properties: { latencyMs: { type: "number" }, jitterMs: { type: "number" }, lossPercent: { type: "number" } } },
        outbound: { type: "object", properties: { latencyMs: { type: "number" }, jitterMs: { type: "number" }, lossPercent: { type: "number" } } },
        quality: { description: "\"auto\" or 1 to 21" },
        memoryMb: { type: "number", description: "The device memory to simulate, in MB" },
        ...placeProp,
      },
    },
    argv: (args) => {
      const side = (key: string) => {
        const v = args[key] as any;
        if (v === undefined || v === null) return [];
        if (typeof v !== "object") throw new ToolInputError(`${key} must be { latencyMs, jitterMs, lossPercent }`);
        const cell = (n: unknown) => (n === undefined ? "" : String(n));
        return [`--${key}=${cell(v.latencyMs)},${cell(v.jitterMs)},${cell(v.lossPercent)}`];
      };
      if (args.network !== undefined && !["off", "great", "good", "poor"].includes(String(args.network))) throw new ToolInputError("network must be off, great, good or poor");
      if (args.quality !== undefined && args.quality !== "auto" && !(Number.isInteger(args.quality) && (args.quality as number) >= 1 && (args.quality as number) <= 21)) throw new ToolInputError("quality must be auto or 1 to 21");
      return [
        "simulate", ...text(args, "place"),
        ...(args.network ? [`--network=${args.network}`] : []), ...side("inbound"), ...side("outbound"),
        ...(args.quality !== undefined ? [`--quality=${args.quality}`] : []), ...number(args, "memoryMb", "--memory"),
      ];
    },
  },
  {
    name: "script_tabs",
    description: "The script tabs open in this Studio, and the ones whose text differs from the script's .Source right now. play closes the open tabs of the scripts it swaps by itself: a tab once typed in (by hand, or by the sync writing to it) gives a play its own text, and no API says whether a tab was ever typed in. Use this to list tabs, or to close some (close: script paths; closeEdited: every one with unsaved text). A collaborator's tab in Team Create is not listed and does not interfere.",
    inputSchema: {
      type: "object",
      properties: {
        close: { type: "array", items: { type: "string" }, description: "Script paths whose tabs to close" },
        closeEdited: { type: "boolean" },
        ...placeProp,
      },
    },
    argv: (args) => {
      const close = args.close;
      if (close !== undefined && (!Array.isArray(close) || close.some((p) => typeof p !== "string" || !p || p.includes(",")))) throw new ToolInputError("close must be a list of script paths, none with a comma");
      return ["tabs", ...text(args, "place"), ...(Array.isArray(close) && close.length ? [`--close=${close.join(",")}`] : []), ...(args.closeEdited === true ? ["--close-edited"] : [])];
    },
  },
  {
    name: "capture_devices",
    description: "The view on several devices in one call and one picture, side by side at the same height: the device simulator set to each in turn (default a small Android phone, an iPhone 14, an iPad and no simulation), a screenshot of each, the simulator put back as it was. For checking a UI on phones and a tablet without a set_device_simulator and a capture_screenshot per device. Device ids as set_device_simulator lists them; none is no simulation.",
    inputSchema: {
      type: "object",
      properties: {
        devices: { type: "array", items: { type: "string" }, description: "Up to 8 device ids (none: no simulation)" },
        orientation: { type: "string", description: "Enum.ScreenOrientation name (default LandscapeLeft)" },
        width: { type: "number", description: "Each screenshot at most this wide (default 900)" },
        ...placeProp,
      },
    },
    argv: (args) => {
      const devices = args.devices;
      if (devices !== undefined && (!Array.isArray(devices) || !devices.length || devices.some((d) => typeof d !== "string" || !d || d.includes(",")))) throw new ToolInputError("devices must be a list of device ids");
      return ["devices", ...text(args, "place"), ...(Array.isArray(devices) ? [`--devices=${devices.join(",")}`] : []), ...(typeof args.orientation === "string" && args.orientation ? [`--orientation=${args.orientation}`] : []), ...number(args, "width", "--width"), "--json"];
    },
    finish: devicesAnswer,
  },
  {
    name: "test_profile",
    description: "Keeps the test player's profile and puts it back, through the game's own functions: the place's quack-prelude/server.luau defines __quackSaveProfile(player), returning the profile as a table, and __quackRestoreProfile(player, data). Quack does not know a game's data layer, so without them it says what to add. save before a test that spends or grants, restore after; list shows what is kept (under .quack/profiles).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["save", "restore", "list"] },
        name: { type: "string", description: "Letters, digits, - or _ (default: default)" },
        ...placeProp,
      },
      required: ["action"],
    },
    argv: (args) => {
      if (!["save", "restore", "list"].includes(String(args.action))) throw new ToolInputError("action must be save, restore or list");
      return ["profile", String(args.action), ...(args.action !== "list" ? text(args, "name") : []), ...text(args, "place")];
    },
  },
  {
    name: "simulate_mouse_input",
    description: "The play client's mouse: a click (or double, down, up; left, right or middle button) at a point given in the last capture_screenshot's own pixels (Quack scales it to the screen, so display scaling and the device simulator do not shift it), or at the center of a GuiObject or a part by its path (a 3D object: ClickDetectors, the world under the cursor). Answers the screen point, the GUI object under it and the part a ray from the camera hits there. For a GUI button prefer click_gui (it says whether the button fired). Studio's virtual input has no mouse move or wheel: drags and scrolls cannot be sent.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Pixels from the left of the last screenshot" },
        y: { type: "number", description: "Pixels from the top of the last screenshot" },
        path: { type: "string", description: "Instead of x and y: a GuiObject, BasePart, Model or Attachment" },
        action: { type: "string", enum: ["click", "double", "down", "up"], description: "Default click" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Default left" },
        space: { type: "string", enum: ["screenshot", "screen"], description: "x and y on the last screenshot (default) or on the screen itself" },
        ...placeProp,
      },
    },
    argv: (args) => {
      const hasPath = typeof args.path === "string" && args.path !== "";
      if (!hasPath && (typeof args.x !== "number" || typeof args.y !== "number" || !(args.x >= 0) || !(args.y >= 0))) throw new ToolInputError("give x and y (0 or more), or path");
      if (args.action !== undefined && !["click", "double", "down", "up"].includes(String(args.action))) throw new ToolInputError("action must be click, double, down or up");
      if (args.button !== undefined && !["left", "right", "middle"].includes(String(args.button))) throw new ToolInputError("button must be left, right or middle");
      if (args.space !== undefined && args.space !== "screenshot" && args.space !== "screen") throw new ToolInputError("space must be screenshot or screen");
      return [
        "mouse",
        ...(hasPath ? [] : [String(args.x), String(args.y)]),
        ...text(args, "place"),
        ...(hasPath ? [`--path=${args.path}`] : []),
        ...(args.action ? [`--action=${args.action}`] : []),
        ...(args.button ? [`--button=${args.button}`] : []),
        ...(args.space ? [`--space=${args.space}`] : []),
      ];
    },
  },
  {
    name: "get_roblox_docs",
    description: "A page of Roblox's engine reference (create.roblox.com) by name: a class, enum, datatype, library or global (TweenService, Enum.KeyCode, Color3, task). Use it instead of guessing an API. The answer starts with every member whose security is above None (PluginSecurity: plugins and the command bar only; RobloxScriptSecurity: Roblox only), so check a property there before trusting a game script can write it. Long pages stop at 50,000 characters with the list of sections: ask for one section (Properties, Methods, Events...) to read it whole. A name not found answers the 5 nearest. Cached a day on disk; needs internet, not Studio.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "PascalCase, as in the engine: Instance, ProximityPrompt, Enum.KeyCode, CFrame" },
        type: { type: "string", enum: ["classes", "enums", "datatypes", "libraries", "globals"], description: "Default: found from the reference's index" },
        section: { type: "string", description: "One ## section, any case: Properties, Methods, Events, Callbacks, Description, Code Samples" },
      },
      required: ["name"],
    },
    argv: (args) => {
      if (args.type !== undefined && !["classes", "enums", "datatypes", "libraries", "globals"].includes(String(args.type))) throw new ToolInputError("type must be classes, enums, datatypes, libraries or globals");
      return ["docs", ...text(args, "name", true), ...(args.type ? [`--type=${args.type}`] : []), ...(typeof args.section === "string" && args.section ? [`--section=${args.section}`] : [])];
    },
  },
  {
    name: "search_assets",
    description: "Searches the Creator Store (the Toolbox) with no login: each result's asset id, name, creator (verified or not), price, votes, script count, triangles, an image's id, an audio's length and the start of its description. assetType Image is searched as Decal (its imageId is the texture to use); Particle and VFX as Models with those words added. A free model with scripts can hide a backdoor: preview_asset before insert_asset.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        assetType: { type: "string", enum: ["Model", "Decal", "Image", "Audio", "MeshPart", "Video", "Plugin", "FontFamily", "Particle", "VFX"], description: "Default Model" },
        maxResults: { type: "number", description: "1 to 100 (default 10)" },
        sortBy: { type: "string", enum: ["Relevance", "Trending", "Top", "AudioDuration", "CreateTime", "UpdatedTime", "Ratings"] },
        robloxCreatedOnly: { type: "boolean", description: "Only assets made by Roblox" },
      },
    },
    argv: (args) => {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      return [
        "asset", "search",
        ...(args.assetType ? [`--type=${args.assetType}`] : []),
        ...number(args, "maxResults", "--limit"),
        ...(args.sortBy ? [`--sort=${args.sortBy}`] : []),
        ...(args.robloxCreatedOnly === true ? ["--roblox"] : []),
        // After "--" the query is the query even when it starts with "-"
        ...(query ? ["--", query] : []),
      ];
    },
  },
  {
    name: "get_asset_details",
    description: "One Creator Store asset by id: name, creator, price, votes, type, whether it has scripts and how many, instance counts, mesh triangles, an image's id, dates and description. No login, no Studio.",
    inputSchema: { type: "object", properties: { assetId: { type: "number" } }, required: ["assetId"] },
    argv: (args) => ["asset", "details", assetIdArg(args)],
  },
  {
    name: "get_asset_thumbnail",
    description: "A Creator Store asset's thumbnail as an image (Roblox's thumbnails API, retried while it is still being made). Also saved as a PNG; the answer says where. No login, no Studio.",
    inputSchema: {
      type: "object",
      properties: { assetId: { type: "number" }, size: { type: "string", enum: ["150x150", "420x420", "768x432"], description: "Default 420x420" } },
      required: ["assetId"],
    },
    argv: (args) => {
      if (args.size !== undefined && !["150x150", "420x420", "768x432"].includes(String(args.size))) throw new ToolInputError("size must be 150x150, 420x420 or 768x432");
      return ["asset", "thumbnail", assetIdArg(args), ...(args.size ? [`--size=${args.size}`] : []), "--json"];
    },
    finish: thumbnailAnswer,
  },
  {
    name: "preview_asset",
    description: "Loads a Creator Store asset in Studio's edit mode without putting it in the place, reads it and destroys it: instance count by class, a tree of up to 100 objects (maxDepth levels, default 4), every script with its line count and what in it a backdoor uses (require by id, loadstring, getfenv, HttpService...), PackageLinks and sounds. Call it before insert_asset on anything with scripts. An asset the place's owner does not own needs \"Allow Loading Third Party Assets\" (Game Settings > Security); the refusal says so.",
    inputSchema: {
      type: "object",
      properties: { assetId: { type: "number" }, maxDepth: { type: "number", description: "Tree levels (default 4, at most 20)" }, ...placeProp },
      required: ["assetId"],
    },
    argv: (args) => ["asset", "preview", assetIdArg(args), ...text(args, "place"), ...number(args, "maxDepth", "--depth")],
  },
  {
    name: "insert_asset",
    description: "Puts a Creator Store asset in the place in edit mode, as one undo step, and selects it. Every script and PackageLink in it is destroyed first and the asset checked again: when any is left nothing is inserted. A Store asset's scripts never come in this way (they would sync to disk and run in the game); the answer lists what was removed. position moves it so its first model or part's pivot lands there, the rest keeping their offsets. Not during a play.",
    inputSchema: {
      type: "object",
      properties: {
        assetId: { type: "number" },
        parentPath: { type: "string", description: "Where to put it (default Workspace)" },
        position: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x", "y", "z"], description: "In studs" },
        ...placeProp,
      },
      required: ["assetId"],
    },
    argv: (args) => {
      const p = args.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
      if (p !== undefined && p !== null && !(typeof p === "object" && [p.x, p.y, p.z].every((n) => typeof n === "number" && Number.isFinite(n)))) throw new ToolInputError("position must be { x, y, z } in studs");
      return [
        "asset", "insert", assetIdArg(args), ...text(args, "place"),
        ...(typeof args.parentPath === "string" && args.parentPath ? [`--parent=${args.parentPath}`] : []),
        ...(p ? [`--at=${p.x},${p.y},${p.z}`] : []),
      ];
    },
  },
  {
    name: "upload_asset",
    description: "Uploads a file to Roblox through Open Cloud: Decal (png, jpg, bmp, tga), Audio (mp3, ogg, wav, flac), Model (fbx, gltf, glb, rbxm, rbxmx), Animation (rbxm, rbxmx) or Video (mp4, mov). The key and creator come from ROBLOX_OPEN_CLOUD_API_KEY and ROBLOX_CREATOR_USER_ID / ROBLOX_CREATOR_GROUP_ID (the group wins) or open-cloud.env in Quack's folder (%APPDATA%\\quack). Every upload is logged by the file's hash, type, name and creator: the same upload again answers the asset it already made (or keeps waiting for one still processing) instead of making a duplicate, so retrying after a timeout is safe; force posts anyway. A Decal also answers its image id (what an ImageLabel takes), read from the Creator Store or the place's Studio.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path of the file" },
        assetType: { type: "string", enum: ["Decal", "Audio", "Model", "Animation", "Video"] },
        displayName: { type: "string", description: "The asset's name on Roblox (at most 50 characters)" },
        description: { type: "string" },
        userId: { type: "string", description: "Upload for this user instead of the configured creator" },
        groupId: { type: "string", description: "Upload for this group instead of the configured creator" },
        force: { type: "boolean", description: "Post even when the log knows this upload (a new asset)" },
        ...placeProp,
      },
      required: ["filePath", "assetType", "displayName"],
    },
    argv: (args) => {
      if (!["Decal", "Audio", "Model", "Animation", "Video"].includes(String(args.assetType))) throw new ToolInputError("assetType must be Decal, Audio, Model, Animation or Video");
      if (typeof args.displayName !== "string" || !args.displayName.trim()) throw new ToolInputError("displayName is required");
      for (const key of ["userId", "groupId"]) if (args[key] !== undefined && !/^\d+$/.test(String(args[key]))) throw new ToolInputError(`${key} must be a number`);
      return [
        "asset", "upload", ...text(args, "filePath", true), ...text(args, "place"),
        `--type=${args.assetType}`, `--name=${args.displayName}`,
        ...(typeof args.description === "string" && args.description ? [`--description=${args.description}`] : []),
        ...(args.userId !== undefined ? [`--user=${args.userId}`] : []),
        ...(args.groupId !== undefined ? [`--group=${args.groupId}`] : []),
        ...(args.force === true ? ["--force"] : []),
      ];
    },
  },
  {
    name: "get_memory_breakdown",
    description: "Memory by Enum.DeveloperMemoryTag (the Developer Console's Memory tab) and the total, from Studio's edit mode and each play peer at once (or the peer named). In a solo play edit mode, the server and the client are one Studio process: the totals are that process's, the same in each, and only the tags tell them apart. tags keeps only those (Script, Instances, PhysicsCollision, GraphicsTexture...). For frame times use perf_sample.",
    inputSchema: {
      type: "object",
      properties: {
        peer: { type: "string", enum: ["edit", "server", "client"], description: "Default every one connected" },
        tags: { type: "array", items: { type: "string" }, description: "Enum.DeveloperMemoryTag names" },
        ...placeProp,
      },
    },
    argv: (args) => {
      if (args.peer !== undefined && !["edit", "server", "client"].includes(String(args.peer))) throw new ToolInputError("peer must be edit, server or client");
      const tags = args.tags;
      if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || !/^\w+$/.test(t)))) throw new ToolInputError("tags must be a list of DeveloperMemoryTag names");
      return ["memory", ...text(args, "place"), ...(args.peer ? [`--peer=${args.peer}`] : []), ...(Array.isArray(tags) && tags.length ? [`--tags=${tags.join(",")}`] : [])];
    },
  },
  {
    name: "capture_script_profiler",
    description: "Runs ScriptProfilerService in the play server (default) or the play client for durationMs (100 to 15000, default 1000) and answers the functions that took the most time: each one's share of the capture, its total time, name, script and line. Quack's own plugin and eval functions are left out (includePlugin keeps them), native ones too (includeNative). filter keeps functions whose name or script contains the text. out saves the raw profile JSON. Needs a play running; to find what eats a frame, after perf_sample says one does.",
    inputSchema: {
      type: "object",
      properties: {
        peer: { type: "string", enum: ["server", "client"], description: "Default server" },
        durationMs: { type: "number" },
        frequency: { type: "number", description: "Samples a second, 1 to 10000 (default 1000)" },
        maxFunctions: { type: "number", description: "1 to 100 (default 20)" },
        filter: { type: "string" },
        includeNative: { type: "boolean" },
        includePlugin: { type: "boolean" },
        out: { type: "string", description: "Absolute path of a .json for the raw profile" },
        ...placeProp,
      },
    },
    argv: (args) => {
      if (args.peer !== undefined && args.peer !== "server" && args.peer !== "client") throw new ToolInputError("peer must be server or client");
      if (args.out !== undefined && (typeof args.out !== "string" || !/\.json$/i.test(args.out))) throw new ToolInputError("out must be a .json path");
      return [
        "profiler", ...text(args, "place"),
        ...(args.peer ? [`--peer=${args.peer}`] : []),
        ...number(args, "durationMs", "--ms"), ...number(args, "frequency", "--frequency"), ...number(args, "maxFunctions", "--limit"),
        ...(typeof args.filter === "string" && args.filter ? [`--filter=${args.filter}`] : []),
        ...(args.includeNative === true ? ["--native"] : []),
        ...(args.includePlugin === true ? ["--plugin"] : []),
        ...(args.out ? [`--out=${args.out}`] : []),
      ];
    },
  },
  {
    name: "get_scene_analysis",
    description: "Studio's Scene Analysis (SceneAnalysisService): the biggest entries of instance_composition, script_memory, unparented_instances (instances kept alive with no parent: leaks), triangle_composition, animation_memory and audio_memory, or all six (default). Each breakdown is flattened to its leaves and sorted by size (triangles by count); topN per breakdown (default 10). Edit mode with no play, the play server during one, or the peer named. Needs Studio's beta feature Scene Analysis; the refusal says so, and in mode all each breakdown reports its own error.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["all", "instance_composition", "script_memory", "unparented_instances", "triangle_composition", "animation_memory", "audio_memory"] },
        peer: { type: "string", enum: ["edit", "server", "client"] },
        topN: { type: "number", description: "1 to 100 (default 10)" },
        ...placeProp,
      },
    },
    argv: (args) => {
      if (args.mode !== undefined && !["all", "instance_composition", "script_memory", "unparented_instances", "triangle_composition", "animation_memory", "audio_memory"].includes(String(args.mode))) throw new ToolInputError("mode must be all or one of the six breakdowns");
      if (args.peer !== undefined && !["edit", "server", "client"].includes(String(args.peer))) throw new ToolInputError("peer must be edit, server or client");
      return ["scene", ...text(args, "place"), ...(args.mode ? [`--mode=${args.mode}`] : []), ...(args.peer ? [`--peer=${args.peer}`] : []), ...number(args, "topN", "--limit")];
    },
  },
  {
    name: "capture_micro_profiler",
    description: "The MicroProfiler for durationMs (100 to 5000, default 1000), read through LibMP, Roblox's library: frame times (avg, p50, p90, p99, max, the slowest frames with their ids), the scopes that took the time in ms a frame (self: without the scopes inside it; inclusive: with them; the worst frame; calls), groups (Physics, Render, Script...) and threads. Engine work that capture_script_profiler cannot see. focus keeps one subsystem, filter a scope or group name. Edit mode with no play, the play server during one, or the peer named; a solo play and edit mode are one Studio process, so every peer reads the same profiler (a multiplayer client is its own). out saves the capture. A minimized or unfocused Studio throttles its frames.",
    inputSchema: {
      type: "object",
      properties: {
        peer: { type: "string", enum: ["edit", "server", "client"] },
        durationMs: { type: "number" },
        frames: { type: "number", description: "The last frames read, 1 to 256 (default the ones that cover durationMs)" },
        focus: { type: "string", enum: ["all", "script", "physics", "render", "network", "jobs"] },
        filter: { type: "string" },
        sort: { type: "string", enum: ["self", "inclusive"], description: "Default self" },
        maxTimers: { type: "number", description: "1 to 100 (default 20)" },
        includeGpu: { type: "boolean" },
        includeIdle: { type: "boolean", description: "Keep the scopes of a thread waiting for work (Sleep), left out by default" },
        keep: { type: "boolean", description: "Leave the MicroProfiler on after (default: turned off again)" },
        out: { type: "string", description: "Absolute path of a .mpz for the capture (LZ4-compressed, LibMP opens it)" },
        ...placeProp,
      },
    },
    argv: (args) => {
      if (args.peer !== undefined && !["edit", "server", "client"].includes(String(args.peer))) throw new ToolInputError("peer must be edit, server or client");
      if (args.focus !== undefined && !["all", "script", "physics", "render", "network", "jobs"].includes(String(args.focus))) throw new ToolInputError("focus must be all, script, physics, render, network or jobs");
      if (args.sort !== undefined && args.sort !== "self" && args.sort !== "inclusive") throw new ToolInputError("sort must be self or inclusive");
      if (args.out !== undefined && (typeof args.out !== "string" || !/\.mpz$/i.test(args.out))) throw new ToolInputError("out must be a .mpz path");
      return [
        "micro", ...text(args, "place"),
        ...(args.peer ? [`--peer=${args.peer}`] : []),
        ...number(args, "durationMs", "--ms"), ...number(args, "frames", "--frames"), ...number(args, "maxTimers", "--limit"),
        ...(args.focus ? [`--mode=${args.focus}`] : []), ...(args.sort ? [`--sort=${args.sort}`] : []),
        ...(typeof args.filter === "string" && args.filter ? [`--filter=${args.filter}`] : []),
        ...(args.includeGpu === true ? ["--gpu"] : []), ...(args.includeIdle === true ? ["--include-idle"] : []), ...(args.keep === true ? ["--keep"] : []),
        ...(args.out ? [`--out=${args.out}`] : []),
      ];
    },
  },
  {
    name: "get_request_status",
    description: "What became of a Studio call that timed out, by the request id its timeout named: pending (Studio has not answered: the code may still be running), answered (with the answer that came later), failed (with its error), lost (the play stopped first) or unknown. A timeout ends only the wait; check here before sending the same call again, or it runs twice. Kept 15 minutes, the last 50.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The 12-character request id" }, ...placeProp }, required: ["id"] },
    argv: (args) => ["result", ...text(args, "id", true), ...text(args, "place")],
  },
  {
    name: "get_place_info",
    description: "The place open in Studio: its place and experience ids, saved version, owner, published name and description, whether Studio is in edit mode or a play, StreamingEnabled and gravity.",
    inputSchema: { type: "object", properties: { ...placeProp } },
    argv: (args) => ["place", "info", ...text(args, "place")],
  },
  {
    name: "list_place_versions",
    description: "A place's saved versions on Roblox, newest first, with when each was saved (Open Cloud, the key in Quack's Settings with asset:read). Pick one for download_place. placeId: any place id, registered or not; left out, the place's own.",
    inputSchema: {
      type: "object",
      properties: {
        placeId: { type: "string", description: "A place id; default the place's" },
        limit: { type: "number", description: "1 to 50 (default 10)" },
        pageToken: { type: "string", description: "The nextPageToken of the page before" },
        ...placeProp,
      },
    },
    argv: (args) => {
      if (args.pageToken !== undefined && (typeof args.pageToken !== "string" || args.pageToken.startsWith("-"))) throw new ToolInputError("pageToken must be the token a page gave");
      return ["place", "versions", ...text(args, "placeId").concat(args.placeId ? [] : text(args, "place")), ...number(args, "limit", "--limit"), ...(args.pageToken ? [`--page=${args.pageToken}`] : [])];
    },
  },
  {
    name: "download_place",
    description: "One saved version of a place (default the latest) downloaded as an .rbxl through Open Cloud, to bring back instances the sync deleted when git has no copy: import_rbxm takes the file directly (list true to see its items and scripts, then paths with only what is missing). open true (or open_place with the file) shows it in a Studio of its own, which the user sees and Quack neither syncs nor reaches with its tools.",
    inputSchema: {
      type: "object",
      properties: {
        placeId: { type: "string", description: "A place id; default the place's" },
        version: { type: "number", description: "A version from list_place_versions; default the latest" },
        out: { type: "string", description: "Absolute .rbxl path (default under Quack's data folder, places/)" },
        open: { type: "boolean", description: "Open it in Studio after" },
        ...placeProp,
      },
    },
    argv: (args) => {
      if (args.out !== undefined && (typeof args.out !== "string" || !/\.rbxlx?$/i.test(args.out))) throw new ToolInputError("out must be an .rbxl path");
      return ["place", "download", ...text(args, "placeId").concat(args.placeId ? [] : text(args, "place")), ...number(args, "version", "--version"), ...(args.out ? [`--out=${args.out}`] : []), ...(args.open === true ? ["--open"] : [])];
    },
  },
  {
    name: "open_place",
    description: "Opens a place in Studio, which the user sees: a registered place (or any place id) to edit, or a local .rbxl / .rbxlx file (a version from download_place) in a Studio of its own. wait (a registered place) returns once its Studio connects to Quack.",
    inputSchema: {
      type: "object",
      properties: {
        place: { type: "string", description: "A place id or a registered place's name" },
        file: { type: "string", description: "Absolute path of an .rbxl or .rbxlx instead" },
        wait: { type: "boolean" },
        timeoutSeconds: { type: "number", description: "wait: give up after this long (default 300)" },
      },
    },
    argv: (args) => {
      if (args.file !== undefined) {
        if (typeof args.file !== "string" || !/\.rbxlx?$/i.test(args.file)) throw new ToolInputError("file must be an .rbxl or .rbxlx path");
        return ["open", `--file=${args.file}`];
      }
      return ["open", ...text(args, "place", true), ...(args.wait === true ? ["--wait"] : []), ...number(args, "timeoutSeconds", "--timeout")];
    },
  },
  {
    name: "selection",
    description: "Studio's selection in edit mode: get it, set it to instance paths (mode add or remove changes it; an empty list clears it), or view: point the edit camera at a path or the selection (from: degrees around, 0 is +X and 90 is +Z, default 45; angleY: degrees up, default 30; padding scales the distance). view leaves the camera there, so a capture_screenshot after shows it.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set", "view"] },
        paths: { type: "array", items: { type: "string" }, description: "set: instance paths" },
        mode: { type: "string", enum: ["set", "add", "remove"] },
        path: { type: "string", description: "view: what to frame (default the selection)" },
        from: { type: "number" },
        angleY: { type: "number" },
        padding: { type: "number" },
        ...placeProp,
      },
    },
    argv: (args) => {
      const action = args.action ?? "get";
      if (!["get", "set", "view"].includes(String(action))) throw new ToolInputError("action must be get, set or view");
      if (action === "set") {
        const paths = args.paths;
        if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string" || !p || p.includes(",") || p.startsWith("-"))) throw new ToolInputError("paths must be a list of instance paths (none with a comma)");
        if (args.mode !== undefined && !["set", "add", "remove"].includes(String(args.mode))) throw new ToolInputError("mode must be set, add or remove");
        return ["selection", "set", paths.length ? paths.join(",") : "none", ...text(args, "place"), ...(args.mode ? [`--mode=${args.mode}`] : [])];
      }
      if (action === "view") {
        const signed = (key: string, flag: string) => {
          const v = args[key];
          if (v === undefined || v === null) return [];
          if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolInputError(`${key} must be a number`);
          return [`${flag}=${v}`];
        };
        if (typeof args.path === "string" && args.path && !args.path.includes(".") && !/^(Workspace|workspace)$/.test(args.path)) throw new ToolInputError("path must be an instance path like Workspace.Map.Door");
        return ["selection", "view", ...text(args, "path"), ...text(args, "place"), ...signed("from", "--from"), ...signed("angleY", "--angle"), ...signed("padding", "--padding")];
      }
      return ["selection", "get", ...text(args, "place")];
    },
  },
  {
    name: "generate_model",
    description: "A 3D model made by Roblox's generation (GenerationService) from a text prompt, an image, or both, put in the place in edit mode (default in Workspace where the camera looks), one undo step, selected; it syncs to disk like anything made in Studio. Takes minutes (118 s for a crate). image: an image asset id, or an absolute .png path that is uploaded first (Open Cloud; the same file never twice). schema Body1 is one mesh, Car5 a car's five parts; groups names the parts instead.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        image: { type: "string", description: "An image asset id or an absolute .png path" },
        size: { type: "array", items: { type: "number" }, description: "[x, y, z] studs, approximate" },
        position: { type: "array", items: { type: "number" }, description: "[x, y, z] where its pivot goes" },
        parent: { type: "string", description: "Default Workspace" },
        name: { type: "string" },
        maxTriangles: { type: "number" },
        textures: { type: "boolean", description: "Default true" },
        schema: { type: "string", enum: ["Body1", "Car5"] },
        groups: { type: "array", items: { type: "string" } },
        timeoutSeconds: { type: "number", description: "Default 300" },
        ...placeProp,
      },
    },
    argv: (args) => {
      const vec = (key: string, flag: string) => {
        const v = args[key];
        if (v === undefined || v === null) return [];
        if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw new ToolInputError(`${key} must be [x, y, z]`);
        return [`${flag}=${v.join(",")}`];
      };
      if (args.image !== undefined && (typeof args.image !== "string" || !(/^\d+$/.test(args.image) || /\.png$/i.test(args.image)))) throw new ToolInputError("image must be an image asset id or a .png path");
      if (args.schema !== undefined && !["Body1", "Car5"].includes(String(args.schema))) throw new ToolInputError("schema must be Body1 or Car5");
      const groups = args.groups;
      if (groups !== undefined && (!Array.isArray(groups) || groups.some((g) => typeof g !== "string" || !g || g.includes(",")))) throw new ToolInputError("groups must be a list of part names");
      const prompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt.trim() : undefined;
      if (!prompt && args.image === undefined) throw new ToolInputError("give a prompt, an image, or both");
      // The prompt as --text=: it may start with "-" and the place stays the one positional
      return ["generate", ...text(args, "place")].concat(
        prompt ? [`--text=${prompt}`] : [],
        args.image !== undefined ? [`--image=${args.image}`] : [],
        vec("size", "--size"), vec("position", "--at"),
        typeof args.parent === "string" && args.parent ? [`--parent=${args.parent}`] : [],
        typeof args.name === "string" && args.name ? [`--name=${args.name}`] : [],
        number(args, "maxTriangles", "--triangles"),
        args.textures === false ? ["--no-textures"] : [],
        args.schema ? [`--schema=${args.schema}`] : [],
        Array.isArray(groups) && groups.length ? [`--groups=${groups.join(",")}`] : [],
        number(args, "timeoutSeconds", "--timeout"),
      );
    },
  },  {
    name: "badges",
    description: "A universe's badges through Open Cloud (run by Quack's hub, which holds the key). quota: free badges left today (5 a UTC day; past them each costs 100 Robux). list: every badge. create: IRREVERSIBLE, a badge is never deleted, only disabled; past the free quota it refuses unless spend is true, and sends the cost as expectedCost so Roblox charges nothing else. icon: replaces a badge's icon. create and icon ask the user in Quack's app and run only after their Accept; never create one to test, or in a test place's universe. Only when the user asked for it.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["quota", "list", "create", "icon"] },
        universeId: { type: "string", description: "quota, list, create" },
        name: { type: "string", description: "create" },
        description: { type: "string", description: "create" },
        iconPath: { type: "string", description: "create (optional) and icon: absolute .png or .jpg path" },
        spend: { type: "boolean", description: "create: allow the 100 Robux a badge costs past the free quota" },
        badgeId: { type: "string", description: "icon" },
      },
      required: ["action"],
    },
    argv: (args) => {
      const action = String(args.action);
      if (action === "quota" || action === "list") return ["badge", action, universeIdArg(args)];
      if (action === "create") {
        if (typeof args.name !== "string" || !args.name.trim()) throw new ToolInputError("name is required");
        return ["badge", "create", universeIdArg(args), `--name=${args.name}`, ...optionText(args, "description", "--description"), ...optionText(args, "iconPath", "--icon"), ...(args.spend === true ? ["--spend"] : [])];
      }
      if (action === "icon") return ["badge", "icon", wholeArg(args, "badgeId"), ...text(args, "iconPath", true)];
      throw new ToolInputError("action must be quota, list, create or icon");
    },
  },
  ...(["developer_products", "game_passes"] as const).map((name): Tool => {
    const product = name === "developer_products";
    const idKey = product ? "productId" : "gamePassId";
    return {
      name,
      description: product
        ? "A universe's developer products through Open Cloud (run by Quack's hub, which holds the key). list, get: read. create: IRREVERSIBLE, a product is never deleted, only taken off sale; it is made on sale. update: changes only the fields given (forSale false takes it off sale). create and update ask the user in Quack's app and run only after their Accept. Make them in the published game's universe, only when the user asked for it."
        : "A universe's game passes through Open Cloud (run by Quack's hub, which holds the key). list, get: read. create: IRREVERSIBLE, a pass is never deleted, only taken off sale; forSale false keeps it off sale until the code that grants it is live (a pass on sale can be bought from the game's page at once). update: changes only the fields given. create and update ask the user in Quack's app and run only after their Accept. Make them in the published game's universe, only when the user asked for it.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "create", "update"] },
          universeId: { type: "string" },
          [idKey]: { type: "string", description: "get, update" },
          name: { type: "string" },
          price: { type: "number", description: "Robux" },
          description: { type: "string" },
          forSale: { type: "boolean" },
          imagePath: { type: "string", description: "Absolute .png or .jpg path" },
        },
        required: ["action", "universeId"],
      },
      argv: (args) => {
        const command = product ? "product" : "gamepass";
        const action = String(args.action);
        if (action === "list") return [command, "list", universeIdArg(args)];
        if (action === "get") return [command, "get", universeIdArg(args), wholeArg(args, idKey)];
        if (action !== "create" && action !== "update") throw new ToolInputError("action must be list, get, create or update");
        if (args.forSale !== undefined && typeof args.forSale !== "boolean") throw new ToolInputError("forSale must be true or false");
        return [
          command, action, universeIdArg(args), ...(action === "update" ? [wholeArg(args, idKey)] : []),
          ...optionText(args, "name", "--name"), ...number(args, "price", "--price"), ...optionText(args, "description", "--description"),
          ...(typeof args.forSale === "boolean" ? [`--for-sale=${args.forSale}`] : []), ...optionText(args, "imagePath", "--image"),
        ];
      },
    };
  }),
  {
    name: "localization",
    description: "A universe's auto-localization table through Open Cloud (run by Quack's hub, which holds the key). Read: info (entries of the 10,000 the table holds, untranslated, settings), dump (every entry to a .json file, the copy to keep before a delete), lint (a translations file checked alone: placeholders, RichText tags, icons, redeem codes, the 300-character limit, locales; no Roblox call), check (one string's latest translation per locale), langs (which languages get automatic translation). Write, each asking the user in Quack's app and running only after their Accept, only when the user asked: push (adds a JSON array's English strings the table lacks, untranslated; automatic translation then fills them and spends the universe's translation quota), delete (removes those entries and their translations, no undo; a deleted string cannot be added back as it was), translate ({ \"<English source>\": { \"<locale>\": \"<text>\" } }, checked as lint does first; spends no quota and Roblox never overwrites it), langs with changes (automatic translation on or off per language). dryRun on push, delete and translate only reports what would happen.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["info", "dump", "push", "delete", "translate", "lint", "check", "langs"] },
        universeId: { type: "string" },
        filePath: { type: "string", description: "push, delete: JSON array of strings; translate, lint: the translations file. Absolute" },
        out: { type: "string", description: "dump: absolute .json path" },
        dryRun: { type: "boolean" },
        locales: { type: "array", items: { type: "string" }, description: "translate, lint: locales every string must have; check: which to read (default pt, es, fr, ru, vi, th)" },
        source: { type: "string", description: "check: the English text" },
        changes: { type: "object", additionalProperties: { type: "boolean" }, description: "langs: { \"de\": false, \"pt\": true } (asks first)" },
        unchecked: { type: "boolean", description: "translate: send even with problems the check found" },
      },
      required: ["action"],
    },
    argv: (args) => {
      const action = String(args.action);
      const locales = () => {
        const v = args.locales;
        if (v === undefined || v === null) return [];
        if (!Array.isArray(v) || v.some((l) => typeof l !== "string" || !/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(l))) throw new ToolInputError("locales must be a list of locale codes");
        return v.length ? [`--locales=${v.join(",")}`] : [];
      };
      const dry = args.dryRun === true ? ["--dry-run"] : [];
      switch (action) {
        case "lint":
          return ["loc", "lint", ...text(args, "filePath", true), ...locales()];
        case "info":
          return ["loc", "info", universeIdArg(args)];
        case "dump":
          if (typeof args.out !== "string" || !/\.json$/i.test(args.out)) throw new ToolInputError("out must be a .json path");
          return ["loc", "dump", universeIdArg(args), ...text(args, "out", true)];
        case "push":
        case "delete":
          return ["loc", action, universeIdArg(args), ...text(args, "filePath", true), ...dry];
        case "translate":
          return ["loc", "translate", universeIdArg(args), ...text(args, "filePath", true), ...locales(), ...dry, ...(args.unchecked === true ? ["--unchecked"] : [])];
        case "check":
          if (typeof args.source !== "string" || !args.source) throw new ToolInputError("source is required");
          return ["loc", "check", universeIdArg(args), `--text=${args.source}`, ...locales()];
        case "langs": {
          const changes = args.changes;
          if (changes !== undefined && (typeof changes !== "object" || changes === null || Array.isArray(changes))) throw new ToolInputError("changes must be { \"<code>\": true | false }");
          const list = Object.entries((changes ?? {}) as Record<string, unknown>).map(([code, on]) => {
            if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(code) || typeof on !== "boolean") throw new ToolInputError("changes must be { \"<code>\": true | false }");
            return `${code}=${on ? "on" : "off"}`;
          });
          return ["loc", "langs", universeIdArg(args), ...list];
        }
      }
      throw new ToolInputError("action must be info, dump, push, delete, translate, lint, check or langs");
    },
  },
  {
    name: "analytics_query",
    description: "Roblox's Analytics Query API for a universe, read-only (run by Quack's hub, which holds the key): the numbers TelemetryService sends and the standard metrics. query is the API's body: { metric, granularity (OneDay, OneHour, None), startTime, endTime, breakdown, filter }; left out, daily active users for the last 3 days. kind dimension-values lists a dimension's values. Daily data arrives about two days late, hourly within 1 to 2 hours. Names: https://create.roblox.com/docs/cloud/guides/analytics/metrics",
    inputSchema: {
      type: "object",
      properties: {
        universeId: { type: "string" },
        query: { type: "object" },
        kind: { type: "string", enum: ["metrics", "dimension-values"] },
      },
      required: ["universeId"],
    },
    argv: (args) => {
      if (args.query !== undefined && (typeof args.query !== "object" || args.query === null || Array.isArray(args.query))) throw new ToolInputError("query must be an object");
      if (args.kind !== undefined && !["metrics", "dimension-values"].includes(String(args.kind))) throw new ToolInputError("kind must be metrics or dimension-values");
      return ["analytics", universeIdArg(args), ...(args.query ? [`--body=${JSON.stringify(args.query)}`] : []), ...(args.kind ? [`--kind=${args.kind}`] : []), "--json"];
    },
  },
  {
    name: "move_player",
    description: "Moves the player's character in a running play instead of an eval that sets HumanoidRootPart.CFrame. mode teleport (default): onto a part's or model's top, to an attachment, or the feet to a position; facing kept, velocity zeroed, a seat left first. mode walk: Humanoid:MoveTo in a straight line; mode path: along a PathfindingService path (jumps included). A walk waits until the feet are within radius studs (flat, default 2), no closer for 2 s (stuck), the character dies, or timeoutSeconds (default 15). Runs on the play server, or on the player's client when that player owns the character's physics (the answer says which and who owns it); peer forces one side. Answers where the feet ended, the distance (and height) left, why it stopped, the time.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Where to: Workspace.Map.Shop, an Attachment, Players.Player2 (that player's character)" },
        position: { type: "array", items: { type: "number" }, description: "Or [x, y, z]: where the feet go" },
        mode: { type: "string", enum: ["teleport", "walk", "path"] },
        radius: { type: "number", description: "Walk: arrived within this many studs, flat (default 2)" },
        timeoutSeconds: { type: "number", description: "Walk: give up after this long (default 15)" },
        peer: { type: "string", enum: ["server", "client"], description: "Default: the server, or the owner's client" },
        ...placeProp,
      },
    },
    argv: (args) => {
      const position = args.position;
      const hasPath = typeof args.path === "string" && args.path.trim() !== "";
      if ((position === undefined || position === null) === !hasPath) throw new ToolInputError("give path or position, one of them");
      if (position !== undefined && position !== null && (!Array.isArray(position) || position.length !== 3 || position.some((n) => typeof n !== "number" || !Number.isFinite(n)))) throw new ToolInputError("position must be [x, y, z]");
      if (args.mode !== undefined && !["teleport", "walk", "path"].includes(String(args.mode))) throw new ToolInputError("mode must be teleport, walk or path");
      if (args.peer !== undefined && !["server", "client"].includes(String(args.peer))) throw new ToolInputError("peer must be server or client");
      return [
        "move", ...(hasPath ? text(args, "path", true) : []), ...text(args, "place"),
        ...(Array.isArray(position) ? [`--at=${position.join(",")}`] : []),
        ...(args.mode ? [`--mode=${args.mode}`] : []),
        ...number(args, "radius", "--radius"), ...number(args, "timeoutSeconds", "--timeout"),
        ...(args.peer ? [`--peer=${args.peer}`] : []),
      ];
    },
  },
  ...LIVE_TOOLS(),
];

/** The experience a cloud tool works on: universeId, or the place's (place: a registered place or a place id) */
function universeArgs(args: Record<string, unknown>): string[] {
  if (args.universeId !== undefined) {
    const n = Number(args.universeId);
    if (!Number.isSafeInteger(n) || n <= 0) throw new ToolInputError("universeId must be an experience (universe) id");
    return [`--universe=${n}`];
  }
  return text(args, "place");
}

const WRITE_RULE = "A write runs only when the user asked for this exact change in so many words; otherwise refuse and ask them first. Even then Quack asks the user in its app and changes nothing without their Accept (5 minutes, then No). An answer saying Quack is opening means its app was closed: ask again in a few seconds.";

TOOLS.push(
  {
    name: "datastore",
    description: `A live game's DataStores through Open Cloud (the key never leaves Quack's hub). Reads: stores (list), keys (of a store; prefix, scope or allScopes), get (an entry: version, size, users; fields picks dot paths like Coins,Pets.Count; a big value goes to a file; version reads an old one), versions (the history, with start and end times). Writes: set (value: the new JSON; the approval lists every field that changes and the write fails if the game saved in between), increment (by), delete. ${WRITE_RULE} The experience is universeId, or the place's.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["stores", "keys", "get", "versions", "set", "increment", "delete"] },
        store: { type: "string" },
        key: { type: "string" },
        scope: { type: "string", description: "Default global" },
        allScopes: { type: "boolean" },
        prefix: { type: "string" },
        fields: { type: "array", items: { type: "string" } },
        version: { type: "string", description: "get: an old version's id from versions" },
        start: { type: "string", description: "versions: ISO time" },
        end: { type: "string" },
        oldestFirst: { type: "boolean" },
        value: { description: "set: the entry's new value (any JSON)" },
        by: { type: "number", description: "increment: a whole number" },
        limit: { type: "number" },
        cursor: { type: "string" },
        out: { type: "string", description: "get: absolute .json path for the value" },
        universeId: { type: "number" },
        ...placeProp,
      },
      required: ["action"],
    },
    argv: (args) => {
      const action = String(args.action);
      if (!["stores", "keys", "get", "versions", "set", "increment", "delete"].includes(action)) throw new ToolInputError("action must be stores, keys, get, versions, set, increment or delete");
      const positional = [action, ...(action !== "stores" ? text(args, "store", true) : []), ...(!["stores", "keys"].includes(action) ? text(args, "key", true) : [])];
      const flag = (key: string, name = key) => (typeof args[key] === "string" && args[key] !== "" ? [`--${name}=${args[key]}`] : []);
      const fields = args.fields;
      if (fields !== undefined && (!Array.isArray(fields) || fields.some((f) => typeof f !== "string" || f.includes(",")))) throw new ToolInputError("fields must be a list of dot paths");
      if (action === "set" && args.value === undefined) throw new ToolInputError("set needs value");
      if (action === "increment" && (typeof args.by !== "number" || !Number.isInteger(args.by) || args.by === 0)) throw new ToolInputError("increment needs by, a whole number other than 0");
      return [
        "datastore", ...positional, ...universeArgs(args),
        ...flag("scope"), ...flag("prefix"), ...flag("version"), ...flag("start"), ...flag("end"), ...flag("cursor"), ...flag("out"),
        ...(args.allScopes === true ? ["--all-scopes"] : []), ...(args.oldestFirst === true ? ["--oldest-first"] : []),
        ...(Array.isArray(fields) && fields.length ? [`--fields=${fields.join(",")}`] : []),
        ...(action === "set" ? [`--value=${JSON.stringify(args.value)}`] : []),
        ...(action === "increment" ? [`--by=${args.by}`] : []),
        ...number(args, "limit", "--limit"),
      ];
    },
  },
  {
    name: "experience_config",
    description: `An experience's configs (In-Experience Config, what ConfigService reads in the game) through Open Cloud. get: the published values (keys picks some); draft: the pending draft and what it changes; set: merges entries into the draft (the game does not see a draft; no other key is touched); publish: the draft goes live on every server. publish is a write: ${WRITE_RULE}`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "draft", "set", "publish"] },
        keys: { type: "array", items: { type: "string" } },
        entries: { type: "object", description: "set: key: value to merge into the draft" },
        message: { type: "string", description: "publish: the version's note" },
        repository: { type: "string", description: "Default InExperienceConfig" },
        universeId: { type: "number" },
        ...placeProp,
      },
      required: ["action"],
    },
    argv: (args) => {
      const action = String(args.action);
      if (!["get", "draft", "set", "publish"].includes(action)) throw new ToolInputError("action must be get, draft, set or publish");
      const keys = args.keys;
      if (keys !== undefined && (!Array.isArray(keys) || keys.some((k) => typeof k !== "string" || k.includes(",")))) throw new ToolInputError("keys must be a list of config keys");
      const entries = args.entries;
      if (action === "set" && (!entries || typeof entries !== "object" || Array.isArray(entries))) throw new ToolInputError("set needs entries, an object of key: value");
      return [
        "config", action, ...universeArgs(args),
        ...(Array.isArray(keys) && keys.length ? [`--keys=${keys.join(",")}`] : []),
        ...(action === "set" ? [`--value=${JSON.stringify(entries)}`] : []),
        ...(typeof args.message === "string" && args.message ? [`--message=${args.message}`] : []),
        ...(typeof args.repository === "string" && args.repository ? [`--repository=${args.repository}`] : []),
      ];
    },
  },
);

TOOLS.push(
  {
    name: "cloud_permissions",
    description: "What the Open Cloud key saved in Quack may do (Roblox's own check: the key's state and scopes, never the key), and which Quack tools each missing permission leaves out. When a cloud tool is refused for a permission, this says what the user adds to the key in the Creator Hub.",
    inputSchema: { type: "object", properties: {} },
    argv: () => ["cloud", "check"],
  },
  {
    name: "luau_run",
    description: `Luau run by Roblox in a cloud server of its own against the latest saved version of a place (or version), with no Studio open: returns what it printed and returned. It runs as the experience and can change its DataStores, so it is a write: ${WRITE_RULE} For the running game in Studio use eval_server_runtime.`,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        version: { type: "number", description: "A saved version (list_place_versions); default the latest" },
        timeoutSeconds: { type: "number", description: "1 to 300 (default 60)" },
        universeId: { type: "number" },
        ...placeProp,
      },
      required: ["code"],
    },
    argv: (args) => ["luau", ...text(args, "place"), codeFlag(args), ...universeArgs(args), ...number(args, "version", "--version"), ...number(args, "timeoutSeconds", "--timeout")],
  },
);
/** A universe id from the AI, as one argv entry */
function universeIdArg(args: Record<string, unknown>): string {
  return wholeArg(args, "universeId");
}

/** A whole-number id (universe, badge, product, pass) */
function wholeArg(args: Record<string, unknown>, key: string): string {
  const s = String(args[key] ?? "").trim();
  if (!/^\d+$/.test(s) ||Number(s) <= 0) throw new ToolInputError(`${key} must be a whole number above 0`);
  return s;
}

/** An option's value as one --flag=value entry, so a value starting with "-" stays the value */
function optionText(args: Record<string, unknown>, key: string, flag: string): string[] {
  const v = args[key];
  if (v === undefined || v === null || v === "") return [];
  if (typeof v !== "string") throw new ToolInputError(`${key} must be a string`);
  return [`${flag}=${v}`];
}

/**
 * The live game's Open Cloud (src/cloud, run by the hub): every change is a write that the hub
 * asks the user about in Quack's app and runs only after their Accept; the AI never approves one. The
 * experience is universeId, or the place's (place, or the place the AI runs in).
 */
function LIVE_TOOLS(): Tool[] {
  const WRITE_NOTE = "A write: the hub asks the user in Quack's app first and does nothing without their Accept (no answer in 5 minutes is a No); a refusal comes back as an error that says nothing changed. Never retry a refused write: ask the user. An answer saying Quack is opening means its app was closed and is starting: ask again in a few seconds.";
  const target = {
    universeId: { type: "string", description: "The experience (universe) id; left out, the experience of `place`" },
    ...placeProp,
  };
  const universe = (args: Record<string, unknown>): string[] => {
    if (args.universeId === undefined || args.universeId === null || args.universeId === "") return text(args, "place");
    if (!/^[1-9]\d{0,18}$/.test(String(args.universeId))) throw new ToolInputError("universeId must be a whole number");
    if (args.place !== undefined && args.place !== "") throw new ToolInputError("give universeId or place, not both");
    return [`--universe=${args.universeId}`];
  };
  const action = (args: Record<string, unknown>, allowed: string[]): string => {
    const a = String(args.action ?? "");
    if (!allowed.includes(a)) throw new ToolInputError(`action must be ${allowed.join(", ")}`);
    return a;
  };
  /** A value that goes as --flag=<value>: a negative number or a JSON text stays one entry */
  const flag = (args: Record<string, unknown>, key: string, name: string, kind: "number" | "string" | "json"): string[] => {
    const v = args[key];
    if (v === undefined || v === null) return [];
    if (kind === "number" && (typeof v !== "number" || !Number.isFinite(v))) throw new ToolInputError(`${key} must be a number`);
    if (kind === "string" && typeof v !== "string") throw new ToolInputError(`${key} must be a string`);
    return [`--${name}=${kind === "json" ? JSON.stringify(v) : String(v)}`];
  };
  const bool = (args: Record<string, unknown>, key: string, name: string) => (args[key] === true ? [`--${name}`] : []);
  const paging = { limit: { type: "number", description: "1 to 100 (default 20)" }, pageToken: { type: "string", description: "The nextPageToken of the page before" } };
  const pages = (args: Record<string, unknown>) => [...number(args, "limit", "--limit"), ...flag(args, "pageToken", "page", "string")];
  const id = (value: unknown) => /^[1-9]\d{0,18}$/.test(String(value));

  return [
    {
      name: "get_universe",
      description: "A live experience's settings from Roblox (Open Cloud, read only): name, visibility, owner, root place, voice chat, which devices can join, the private server price, age rating.",
      inputSchema: { type: "object", properties: { ...target } },
      argv: (args) => ["universe", "get", ...universe(args)],
    },
    {
      name: "update_universe",
      description: `Changes a live experience's settings. ${WRITE_NOTE} settings by Open Cloud name: voiceChatEnabled, desktopEnabled, mobileEnabled, tabletEnabled, consoleEnabled, vrEnabled (true/false), visibility (PUBLIC or PRIVATE: PRIVATE removes every player from every server at once), privateServerPriceRobux (Robux; a new price cancels every private server subscription; null turns private servers off).`,
      inputSchema: { type: "object", properties: { settings: { type: "object", description: "{ field: new value }" }, ...target }, required: ["settings"] },
      argv: (args) => {
        if (!args.settings || typeof args.settings !== "object" || Array.isArray(args.settings)) throw new ToolInputError("settings must be an object of fields");
        return ["universe", "set", ...universe(args), `--props=${JSON.stringify(args.settings)}`];
      },
    },
    {
      name: "restart_servers",
      description: `Restarts a live experience's servers (after a publish): by default only the servers on an older version than the latest published; allVersions: every server. The players in them are disconnected. bleedOffMinutes (1 to 60): those servers take no new players and close after that long. ${WRITE_NOTE}`,
      inputSchema: {
        type: "object",
        properties: { placeIds: { type: "array", items: { type: "string" }, description: "Only these places (default every place)" }, allVersions: { type: "boolean" }, bleedOffMinutes: { type: "number" }, ...target },
      },
      argv: (args) => {
        const ids = args.placeIds;
        if (ids !== undefined && (!Array.isArray(ids) || ids.some((p) => !id(p)))) throw new ToolInputError("placeIds must be a list of place ids");
        return ["servers", "restart", ...universe(args), ...(Array.isArray(ids) && ids.length ? [`--places=${ids.join(",")}`] : []), ...bool(args, "allVersions", "all-versions"), ...number(args, "bleedOffMinutes", "--bleed")];
      },
    },
    {
      name: "publish_message",
      description: `Publishes a MessagingService message to every live server of an experience (the servers that subscribed to the topic with SubscribeAsync run their code on it). Topic up to 80 characters, message up to 1,024 (a table goes as its JSON). ${WRITE_NOTE}`,
      inputSchema: { type: "object", properties: { topic: { type: "string" }, message: { type: "string" }, ...target }, required: ["topic", "message"] },
      argv: (args) => {
        if (typeof args.message !== "string") throw new ToolInputError("message must be a string");
        return ["message", "publish", ...text(args, "topic", true), ...universe(args), `--message=${args.message}`];
      },
    },
    {
      name: "memory_store_sorted_map",
      description: `A live experience's MemoryStore sorted map. list and get read; create, update (upsert: create if missing) and delete are writes. ${WRITE_NOTE} value: any JSON value (32 KB at most); ttlSeconds: how long it lives (1 to 3888000, 45 days), required to create or update; sortKey: a number or a string.`,
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "create", "update", "delete"] },
          map: { type: "string", description: "The sorted map's name" },
          item: { type: "string", description: "The item's key (all but list)" },
          value: { description: "create/update: the item's value (any JSON)" },
          ttlSeconds: { type: "number" },
          sortKey: { type: ["number", "string"] },
          upsert: { type: "boolean" },
          descending: { type: "boolean", description: "list: keys from last to first" },
          filter: { type: "string", description: "list: CEL on id and sortKey, like id > \"a\" && id < \"m\"" },
          ...paging, ...target,
        },
        required: ["action", "map"],
      },
      argv: (args) => {
        const a = action(args, ["list", "get", "create", "update", "delete"]);
        const head = ["memory-store", "map", a, ...text(args, "map", true)];
        if (a === "list") return [...head, ...universe(args), ...pages(args), ...bool(args, "descending", "descending"), ...flag(args, "filter", "filter", "string")];
        const out = [...head, ...text(args, "item", true), ...universe(args)];
        if (a === "get" || a === "delete") return out;
        if (args.value === undefined) throw new ToolInputError("value is required");
        if (args.sortKey !== undefined && typeof args.sortKey !== "number" && typeof args.sortKey !== "string") throw new ToolInputError("sortKey must be a number or a string");
        return [...out, ...flag(args, "value", "value", "json"), ...number(args, "ttlSeconds", "--ttl"), ...(args.sortKey !== undefined ? [`--sort-key=${args.sortKey}`] : []), ...(a === "update" ? bool(args, "upsert", "upsert") : [])];
      },
    },
    {
      name: "memory_store_queue",
      description: `A live experience's MemoryStore queue. All three are writes: read takes up to count items from the front and hides them from the game's own servers for invisibleSeconds (default 30), after which they come back unless discarded with the readId it answers; add puts an item in (ttlSeconds required, priority optional); discard removes the items of a read for good. ${WRITE_NOTE}`,
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "add", "discard"] },
          queue: { type: "string" },
          count: { type: "number", description: "read: 1 to 200 (default 1)" },
          invisibleSeconds: { type: "number" },
          allOrNothing: { type: "boolean", description: "read: fail unless count items are there" },
          value: { description: "add: the item (any JSON)" },
          ttlSeconds: { type: "number" },
          priority: { type: "number" },
          readId: { type: "string", description: "discard: the readId a read answered" },
          ...target,
        },
        required: ["action", "queue"],
      },
      argv: (args) => {
        const a = action(args, ["read", "add", "discard"]);
        const head = ["memory-store", "queue", a, ...text(args, "queue", true)];
        if (a === "read") return [...head, ...universe(args), ...number(args, "count", "--count"), ...number(args, "invisibleSeconds", "--invisible"), ...bool(args, "allOrNothing", "all-or-nothing")];
        if (a === "discard") return [...head, ...text(args, "readId", true), ...universe(args)];
        if (args.value === undefined) throw new ToolInputError("value is required");
        return [...head, ...universe(args), ...flag(args, "value", "value", "json"), ...number(args, "ttlSeconds", "--ttl"), ...flag(args, "priority", "priority", "number")];
      },
    },
    {
      name: "flush_memory_store",
      description: `Erases a live experience's whole MemoryStore: every sorted map, queue and hash map (scope LIVE, what the running servers use; TEST: Studio's). It cannot be undone. ${WRITE_NOTE}`,
      inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["LIVE", "TEST"] }, ...target } },
      argv: (args) => {
        if (args.scope !== undefined && args.scope !== "LIVE" && args.scope !== "TEST") throw new ToolInputError("scope must be LIVE or TEST");
        return ["memory-store", "flush", ...universe(args), ...(args.scope === "TEST" ? ["--test"] : [])];
      },
    },
    {
      name: "ordered_data_store",
      description: `A live experience's ordered data store (a leaderboard): list (highest first; ascending for lowest; min/max bound the values) and get read; create, set (upsert: create if missing), increment (amount, may be negative) and delete are writes. ${WRITE_NOTE} Values are whole numbers; scope defaults to global.`,
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "create", "set", "increment", "delete"] },
          store: { type: "string" },
          entry: { type: "string", description: "The entry's key (all but list), often a user id" },
          scope: { type: "string" },
          value: { type: "number" },
          amount: { type: "number" },
          upsert: { type: "boolean" },
          ascending: { type: "boolean" },
          min: { type: "number" },
          max: { type: "number" },
          ...paging, ...target,
        },
        required: ["action", "store"],
      },
      argv: (args) => {
        const a = action(args, ["list", "get", "create", "set", "increment", "delete"]);
        const head = ["leaderboard", a, ...text(args, "store", true)];
        const scope = flag(args, "scope", "scope", "string");
        if (a === "list") return [...head, ...universe(args), ...scope, ...pages(args), ...bool(args, "ascending", "ascending"), ...flag(args, "min", "min", "number"), ...flag(args, "max", "max", "number")];
        const out = [...head, ...text(args, "entry", true), ...universe(args), ...scope];
        if (a === "create" || a === "set") {
          if (typeof args.value !== "number") throw new ToolInputError("value is required: a whole number");
          return [...out, ...flag(args, "value", "value", "number"), ...(a === "set" ? bool(args, "upsert", "upsert") : [])];
        }
        if (a === "increment") {
          if (typeof args.amount !== "number") throw new ToolInputError("amount is required: a whole number");
          return [...out, ...flag(args, "amount", "amount", "number")];
        }
        return out;
      },
    },
    {
      name: "user_restriction",
      description: `A live experience's bans. list, get and logs read (logs: every ban and unban, filtered by userId and placeId). ban and unban are writes: ban kicks the user from any server they are in and keeps them out of the experience (or placeId only) for durationSeconds or permanently, and Roblox also bans their alt accounts unless excludeAltAccounts; displayReason is shown to them (400 characters), privateReason only in the log (1,000). Roblox takes 2 ban changes a minute for the same user. ${WRITE_NOTE}`,
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "ban", "unban", "logs"] },
          userId: { type: "string" },
          placeId: { type: "string", description: "One place of the experience instead of all of it" },
          durationSeconds: { type: "number", description: "ban: left out, permanent" },
          displayReason: { type: "string" },
          privateReason: { type: "string" },
          excludeAltAccounts: { type: "boolean" },
          ...paging, ...target,
        },
        required: ["action"],
      },
      argv: (args) => {
        const a = action(args, ["list", "get", "ban", "unban", "logs"]);
        if (args.placeId !== undefined && !id(args.placeId)) throw new ToolInputError("placeId must be a place id");
        if (args.userId !== undefined && !id(args.userId)) throw new ToolInputError("userId must be a Roblox user id");
        const inPlace = args.placeId !== undefined ? [`--in-place=${args.placeId}`] : [];
        if (a === "list") return ["ban", "list", ...universe(args), ...inPlace, ...pages(args)];
        if (a === "logs") return ["ban", "logs", ...universe(args), ...inPlace, ...(args.userId !== undefined ? [`--user=${args.userId}`] : []), ...pages(args)];
        const user = text(args, "userId", true);
        if (a === "get") return ["ban", "get", ...user, ...universe(args), ...inPlace];
        if (a === "unban") return ["ban", "lift", ...user, ...universe(args), ...inPlace, ...flag(args, "privateReason", "reason", "string")];
        const d = args.durationSeconds;
        if (d !== undefined && (typeof d !== "number" || !Number.isSafeInteger(d) || d < 1)) throw new ToolInputError("durationSeconds must be a whole number of seconds");
        return ["ban", "set", ...user, ...universe(args), ...inPlace, ...(d !== undefined ? [`--duration=${d}`] : []), ...flag(args, "displayReason", "display", "string"), ...flag(args, "privateReason", "reason", "string"), ...bool(args, "excludeAltAccounts", "keep-alts")];
      },
    },
  ];
}

/** A Creator Store id from the AI: a whole number, as one argv entry */
function assetIdArg(args: Record<string, unknown>): string {
  const id = Number(args.assetId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ToolInputError("assetId must be a whole number above 0");
  return String(id);
}

/** In a multiplayer test these reach one player's client: they take `player` */
const PLAYER_TOOLS = new Set(["eval_client_runtime", "find_instances", "inspect_instance", "set_properties", "simulate_conditions", "simulate_keyboard_input", "click_gui", "wait_for", "inspect_gui", "simulate_mouse_input", "perf_sample", "get_memory_breakdown", "capture_script_profiler", "get_scene_analysis", "capture_micro_profiler", "move_player"]);
for (const tool of TOOLS) {
  if (!PLAYER_TOOLS.has(tool.name)) continue;
  const schema = tool.inputSchema as { properties: Record<string, unknown> };
  schema.properties.player = { type: "string", description: "A multiplayer test (solo_playtest start with players): the player whose client this goes to (Player1, Player2...); default the last one that joined" };
  const argv = tool.argv;
  tool.argv = (args) => {
    if (args.player === undefined || args.player === null || args.player === "") return argv(args);
    if (typeof args.player !== "string" || args.player.startsWith("-")) throw new ToolInputError("player must be a player's name");
    return [...argv(args), `--player=${args.player}`];
  };
}

/** The devices command's --json answer: which device is where, and the picture as an image block */
function devicesAnswer(body: string, code: number): object[] {
  let result: any;
  try {
    result = JSON.parse(body);
  } catch {
    return [{ type: "text", text: body || "(no output)" }];
  }
  if (code !== 0 || typeof result?.sheet !== "string") return [{ type: "text", text: typeof result?.error === "string" ? result.error : body }];
  const order = result.shots.map((s: any) => `${s.device === "none" ? "no simulation" : s.device} (${s.width}x${s.height})`).join(", ");
  const summary = `${result.shots.length} devices, left to right then down: ${order}. Each screenshot: ${result.shots.map((s: any) => s.file).join(" ")}. ${result.ms} ms.${errorsAfter(result)}`;
  try {
    return [{ type: "text", text: summary }, { type: "image", data: fs.readFileSync(result.sheet).toString("base64"), mimeType: "image/png" }];
  } catch (error) {
    return [{ type: "text", text: `${summary} The picture could not be read back: ${(error as Error).message}` }];
  }
}

/** The record command's --json answer: one line, and the contact sheet as an image block */
function recordAnswer(body: string, code: number): object[] {
  let rec: any;
  try {
    rec = JSON.parse(body);
  } catch {
    return [{ type: "text", text: body || "(no output)" }];
  }
  if (code !== 0 || typeof rec?.file !== "string") return [{ type: "text", text: typeof rec?.error === "string" ? rec.error : body }];
  const times = Array.isArray(rec.sheetAt) ? ` The sheet shows the frames at ${rec.sheetAt.map((ms: number) => `${(ms / 1000).toFixed(1)}`).join(", ")} s.` : "";
  const summary = `${recordSummary(rec)} GIF: ${rec.file} Sheet: ${rec.sheet}.${times}${errorsAfter(rec)}`;
  try {
    return [{ type: "text", text: summary }, { type: "image", data: fs.readFileSync(rec.sheet).toString("base64"), mimeType: "image/png" }];
  } catch (error) {
    return [{ type: "text", text: `${summary} The sheet could not be read back: ${(error as Error).message}` }];
  }
}

/** A --json answer's play errors since the last call, as the text commands print them */
function errorsAfter(result: any): string {
  const listed = Array.isArray(result?.newErrors) ? result.newErrors : [];
  return listed.length || result?.repeatedErrors ? `\n${newErrorsText(listed, result.repeatedErrors)}` : "";
}

/** The asset thumbnail command's --json answer: where it was saved, and the PNG as an image block */
function thumbnailAnswer(body: string, code: number): object[] {
  let result: any;
  try {
    result = JSON.parse(body);
  } catch {
    return [{ type: "text", text: body || "(no output)" }];
  }
  if (code !== 0 || typeof result?.file !== "string") return [{ type: "text", text: typeof result?.error === "string" ? result.error : body }];
  const summary = `Thumbnail of asset ${result.assetId} (${result.size}), saved at ${result.file}`;
  try {
    return [{ type: "text", text: summary }, { type: "image", data: fs.readFileSync(result.file).toString("base64"), mimeType: "image/png" }];
  } catch (error) {
    return [{ type: "text", text: `${summary}, but it could not be read back: ${(error as Error).message}` }];
  }
}

/** The screenshot command's --json answer: its text, and the PNG it saved as an image block */
function screenshotAnswer(body: string, code: number): object[] {
  let shot: any;
  try {
    shot = JSON.parse(body);
  } catch {
    return [{ type: "text", text: body || "(no output)" }];
  }
  // --json says a refusal as { error }
  if (code !== 0 || typeof shot?.file !== "string") return [{ type: "text", text: typeof shot?.error === "string" ? shot.error : body }];
  const scaled = shot.crop ? ` (cropped to ${shot.focus})` : shot.width !== shot.nativeWidth ? ` (scaled down from ${shot.nativeWidth}x${shot.nativeHeight})` : shot.focus ? ` (camera on ${shot.focus})` : "";
  const summary = `Screenshot of ${shot.peer === "client" ? "the play client" : "Studio in edit mode"}: ${shot.width}x${shot.height}${scaled}, ${shot.ms} ms. Saved at ${shot.file}${errorsAfter(shot)}`;
  try {
    return [{ type: "text", text: summary }, { type: "image", data: fs.readFileSync(shot.file).toString("base64"), mimeType: "image/png" }];
  } catch (error) {
    return [{ type: "text", text: `${summary}, but it could not be read back: ${(error as Error).message}` }];
  }
}

export { instructions };

/** Serves MCP on `input`/`output` until `input` ends */
export function serveMcp(input: Readable, output: Writable, ctx: Context): Promise<void> {
  const send = (message: object): void => void output.write(`${JSON.stringify(message)}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();

  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    // A notification (no id) asks for no answer: initialized, cancelled
    if (message?.id === undefined || message?.id === null) return;
    const job = handle(message, ctx)
      .then((result) => send({ jsonrpc: "2.0", id: message.id, result }))
      .catch((error) => send({ jsonrpc: "2.0", id: message.id, error: error instanceof RpcError ? { code: error.code, message: error.message } : { code: -32603, message: (error as Error).message } }))
      .finally(() => pending.delete(job));
    pending.add(job);
  });

  return new Promise((resolve) => lines.on("close", () => void Promise.allSettled([...pending]).then(() => resolve())));
}

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

async function handle(message: any, ctx: Context): Promise<object> {
  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      return {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: ctx.info.flavor === "official" ? "quack" : "quack-dev", version: BUNDLED_VERSION ?? "dev" },
        instructions: instructions(ctx.info),
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === message.params?.name);
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${message.params?.name}`);
      return callTool(tool, message.params?.arguments ?? {}, ctx);
    }
  }
  throw new RpcError(-32601, `Method not found: ${message.method}`);
}

async function callTool(tool: Tool, args: Record<string, unknown>, ctx: Context): Promise<object> {
  let argv: string[];
  try {
    argv = tool.argv(args);
  } catch (error) {
    if (error instanceof ToolInputError) return { content: [{ type: "text", text: error.message }], isError: true };
    throw error;
  }
  const lines: string[] = [];
  const code = await runControl(argv, {
    ...ctx,
    // One caller per MCP server (one AI session): the play errors it has not seen yet
    caller: `mcp-${process.pid}`,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    // Nothing here changes the hub, and nothing may ever wait on a terminal nobody sees
    confirm: async () => false,
    interactive: false,
    color: false,
  });
  let body = lines.join("\n");
  if (tool.finish) return { content: tool.finish(body, code), ...(code === 0 ? {} : { isError: true }) };
  if (tool.tail) {
    const all = body.split("\n");
    const keep = tool.tail(args);
    if (all.length > keep) body = [`(last ${keep} of ${all.length} lines)`, ...all.slice(-keep)].join("\n");
  }
  return { content: [{ type: "text", text: body || "(no output)" }], ...(code === 0 ? {} : { isError: true }) };
}
