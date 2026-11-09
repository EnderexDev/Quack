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
 * assets previewed and inserted, memory, the script profiler, scene analysis), and the Roblox web
 * tools that need no hub (the engine reference, the Creator Store, an Open Cloud upload): a
 * change to the hub (resolve, pause, register...) stays a person's, in the app or the terminal.
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
    description: "Puts an .rbxm file's instances in the place in edit mode (default under Workspace), as one undo step; scripts inside sync to disk like any made in Studio. A worktree's play carries scripts only: this is how a model or UI from elsewhere comes in.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Absolute path of the .rbxm" },
        parent: { type: "string", description: "Where to put them (default Workspace)" },
        ...placeProp,
      },
      required: ["file"],
    },
    argv: (args) => ["import", ...text(args, "file", true), ...text(args, "place"), ...(typeof args.parent === "string" && args.parent ? [`--parent=${args.parent}`] : [])],
  },
  {
    name: "find_instances",
    description: "Finds instances in the place by name (wildcards * and ?, any case), class (one or several, comma-separated, exact ClassName) and where (under a path), read from Quack's own copy of the synced tree: no Studio call, the place in edit mode as of the last sync, every instance (not only scripts). Answers paths, classes and each script's file. For a running game's instances use the eval tools.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name pattern: Boss*, *Button, Shop" },
        className: { type: "string", description: "ClassName, or several comma-separated (MeshPart,Part)" },
        under: { type: "string", description: "Only below this path (ReplicatedStorage.Assets)" },
        limit: { type: "number", description: "At most this many listed (default 100); the total is always counted" },
        ...placeProp,
      },
    },
    argv: (args) => {
      if (![args.name, args.className, args.under].some((v) => typeof v === "string" && v.trim())) throw new ToolInputError("give name, className or under");
      const flag = (key: string, name: string) => (typeof args[key] === "string" && (args[key] as string).trim() ? [`--${name}=${args[key]}`] : []);
      return ["find", ...text(args, "place"), ...flag("name", "name"), ...flag("className", "class"), ...flag("under", "under"), ...number(args, "limit", "--limit")];
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
];

/** A Creator Store id from the AI: a whole number, as one argv entry */
function assetIdArg(args: Record<string, unknown>): string {
  const id = Number(args.assetId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ToolInputError("assetId must be a whole number above 0");
  return String(id);
}

/** In a multiplayer test these reach one player's client: they take `player` */
const PLAYER_TOOLS = new Set(["eval_client_runtime", "inspect_instance", "set_properties", "simulate_conditions", "simulate_keyboard_input", "click_gui", "wait_for", "inspect_gui", "simulate_mouse_input", "perf_sample", "get_memory_breakdown", "capture_script_profiler", "get_scene_analysis"]);
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
