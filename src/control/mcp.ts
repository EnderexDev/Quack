import fs from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { BUNDLED_VERSION } from "../bundled.js";
import { newErrorsText, recordSummary, runControl, type ControlContext } from "./commands.js";
import type { FlavorInfo } from "./hubClient.js";

/**
 * `quack mcp` / `quackdev mcp`: the hub for an AI, as an MCP server on stdio (JSON-RPC, one
 * message per line). Each tool runs the terminal command of the same name through runControl,
 * so the terminal and the AI never read the hub two ways. Reading, waiting, play and the Studio
 * tools (evals, execute_luau, playtest, screenshots, keys, the device simulator): a change to the
 * hub (resolve, pause, register...) stays a person's, in the app or the terminal.
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
];

/** In a multiplayer test these reach one player's client: they take `player` */
const PLAYER_TOOLS = new Set(["eval_client_runtime", "simulate_keyboard_input", "click_gui", "wait_for", "inspect_gui", "simulate_mouse_input", "perf_sample"]);
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

export function instructions(info: FlavorInfo): string {
  return `${info.appName} syncs Roblox places in Studio with folders on disk, both ways. One hub (port ${info.port}) runs one daemon per registered place; \`status\` lists each place and its folder. Scripts are files: .luau is a ModuleScript, .server.luau a Script, .client.luau a LocalScript. The terminal command \`${info.command}\` does the same as these tools and more.

Editing in the synced folder:
- A file saved there reaches Studio in milliseconds while Studio has the place open and connected. Check \`status\` first: with no Studio connected, edits wait, and when the place is opened again Studio's copy of every script wins, so disk edits made meanwhile come back reverted.
- Before a playtest or reading a script in Studio, call \`wait\`.
- A new script: create the file (one at a time, not a burst), then confirm it exists in Studio.
- A script edited in Studio and on disk at once is merged; a disk version the merge did not keep goes to \`conflicts\`. Check it after a batch of edits. Which side wins is the user's call.
- Do not use Studio's Undo (Ctrl+Z, ChangeHistoryService:Undo) with the sync on: it also undoes the sync's own steps, and a created file gets deleted from disk too.

Git in the synced folder: every file git writes goes to Studio. A merge or fast-forward is fine. Never switch branches, checkout or stash there: the moment the tree rewinds becomes deletions in Studio, and pausing the sync does not protect it. After any git operation there: \`wait\`, then \`log\` for a deleted script the operation did not mean to delete. A deleted one comes back by writing it from git (git show HEAD:<path> > <path>). \`wait\` also lists script files on disk with no instance in Studio (a merge's new script the sync missed): \`wait\` with fix sends their creates again; saving such a file again does nothing.

Work on another branch in a git worktree:
- Its edits never reach Studio. Do not change scripts in Studio for that work (that writes to the synced folder's branch).
- Test with \`play\` (worktree path). A new file needs \`git add\` first, or the play leaves it out. The answer says 'N of M have the branch'; compare 'N changed, N new' with what the branch touched. To change code: stop the play, edit, \`play\` again.
- A 'conflict:' line is a script the branch changed that Studio also holds changed by someone else. 'has the place's text' means a tab open and edited in that Studio beat the swap: closing the tab fixes the next play.
- Maps, models and UI layout live in the place and are not carried by a play.

Studio tools (through ${info.appName}'s own plugin, for the place named or the one whose folder the AI runs in):
- solo_playtest start, then eval_server_runtime / eval_client_runtime run Luau inside the running game (its require cache), get_runtime_logs reads the play's output with a cursor, simulate_keyboard_input sends keys to the play client, capture_screenshot shows the viewport. solo_playtest stop returns once Studio is back in edit mode.
- click_gui clicks a button by its path (no pixel coordinates), wait_for waits for Luau to turn truthy or an output line instead of sleeping, record makes a GIF of a few seconds of the play view (its answer shows a contact sheet of the frames).
- inspect_gui reads a GUI as the player sees it (text, place, hidden by what, clickable or covered) instead of an eval over PlayerGui. capture_screenshot takes width (an image costs by its pixels) and focus (a GUI object to crop to, or a part or model to point the camera at). simulate_mouse_input clicks at x, y on the last screenshot, or a GuiObject's or a part's center; it cannot drag or scroll.
- Every Studio answer lists the play's errors logged since your previous call ("New errors in the play..."): read them before going on.
- quack-prelude/server.luau, client.luau and edit.luau at the project's root (next to the sync folder, kept in git) go before every eval of that peer: a game names its player, services and modules there once. An answer says when one was used; prelude false leaves it out.
- verify_sync tells whether Studio holds the disk's text of each script (its .Source and its open tab, the text a play copies): call it after edits and before a play instead of reading .Source. find_instances searches the whole place by name, class and path from Quack's own copy, with no Studio call.
- perf_sample measures fps, frame times, hitches and memory in both play peers for a few seconds. set_logpoint prints values from a script line when it runs, with no edit (its lines reach get_runtime_logs). export_rbxm and import_rbxm move models as .rbxm files.
- solo_playtest start with players runs a multiplayer test; the client tools then take player.
- execute_luau runs in the edit plugin: what it changes in the place syncs to disk.
- An error says its cause: no Studio connected, no play running, no play client (Run mode), an older plugin (reopen the place), the window minimized, or Luau's own error.`;
}

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
