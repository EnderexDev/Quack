import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { BUNDLED_VERSION } from "../bundled.js";
import { runControl, type ControlContext } from "./commands.js";
import type { FlavorInfo } from "./hubClient.js";

/**
 * `quack mcp` / `quackdev mcp`: the hub for an AI, as an MCP server on stdio (JSON-RPC, one
 * message per line). Each tool runs the terminal command of the same name through runControl,
 * so the terminal and the AI never read the hub two ways. Only reading, waiting and play: a
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

export const TOOLS: Tool[] = [
  {
    name: "status",
    description: "The hub, the AI merge and every registered place with its folder: whether Studio is connected, instances, scripts, conflicts waiting. Call it before editing synced files.",
    inputSchema: { type: "object", properties: {} },
    argv: () => ["status"],
  },
  {
    name: "wait",
    description: "Returns once the place's Studio is connected and nothing has synced for a moment (default 1.5 s). Call it after editing synced files and before starting a playtest or reading scripts in Studio.",
    inputSchema: {
      type: "object",
      properties: {
        ...placeProp,
        connectedOnly: { type: "boolean", description: "Only until Studio is connected, not until the sync is quiet" },
        idleMs: { type: "number", description: "How long the sync must be quiet (default 1500)" },
        timeoutSeconds: { type: "number", description: "Give up after this long (default 120)" },
      },
    },
    argv: (args) => ["wait", ...text(args, "place"), ...(args.connectedOnly === true ? ["--connected"] : []), ...number(args, "idleMs", "--idle"), ...number(args, "timeoutSeconds", "--timeout")],
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
    description: "Starts a playtest in Studio with the scripts a git worktree's branch changed since it forked from the synced folder; every other script runs as Studio has it. Waits for the play's own check and answers 'N of M have the branch' or what did not arrive. One play at a time: stop the running one first.",
    inputSchema: {
      type: "object",
      properties: {
        worktree: { type: "string", description: "Absolute path of the worktree (default: the folder the AI runs in)" },
        ...placeProp,
        timeoutSeconds: { type: "number", description: "How long to wait for the play's check (default 60)" },
      },
    },
    argv: (args) => ["play", ...text(args, "place"), ...(text(args, "worktree").length ? ["-w", String(args.worktree)] : []), ...number(args, "timeoutSeconds", "--timeout")],
  },
];

export function instructions(info: FlavorInfo): string {
  return `${info.appName} syncs Roblox places in Studio with folders on disk, both ways. One hub (port ${info.port}) runs one daemon per registered place; \`status\` lists each place and its folder. Scripts are files: .luau is a ModuleScript, .server.luau a Script, .client.luau a LocalScript. The terminal command \`${info.command}\` does the same as these tools and more.

Editing in the synced folder:
- A file saved there reaches Studio in milliseconds while Studio has the place open and connected. Check \`status\` first: with no Studio connected, edits wait, and when the place is opened again Studio's copy of every script wins, so disk edits made meanwhile come back reverted.
- Before a playtest or reading a script in Studio, call \`wait\`.
- A new script: create the file (one at a time, not a burst), then confirm it exists in Studio.
- A script edited in Studio and on disk at once is merged; a disk version the merge did not keep goes to \`conflicts\`. Check it after a batch of edits. Which side wins is the user's call.
- Do not use Studio's Undo (Ctrl+Z, ChangeHistoryService:Undo) with the sync on: it also undoes the sync's own steps, and a created file gets deleted from disk too.

Git in the synced folder: every file git writes goes to Studio. A merge or fast-forward is fine. Never switch branches, checkout or stash there: the moment the tree rewinds becomes deletions in Studio, and pausing the sync does not protect it. After any git operation there: \`wait\`, then \`log\` for a deleted script the operation did not mean to delete; one lost that way comes back by writing it from git (git show HEAD:<path> > <path>).

Work on another branch in a git worktree:
- Its edits never reach Studio. Do not change scripts in Studio for that work (that writes to the synced folder's branch).
- Test with \`play\` (worktree path). A new file needs \`git add\` first, or the play leaves it out. The answer says 'N of M have the branch'; compare 'N changed, N new' with what the branch touched. To change code: stop the play, edit, \`play\` again.
- A 'conflict:' line is a script the branch changed that Studio also holds changed by someone else. 'has the place's text' means a tab open and edited in that Studio beat the swap: closing the tab fixes the next play.
- Maps, models and UI layout live in the place and are not carried by a play.`;
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
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    // Nothing here mutates, and nothing may ever wait on a terminal nobody sees
    confirm: async () => false,
    interactive: false,
    color: false,
  });
  let body = lines.join("\n");
  if (tool.tail) {
    const all = body.split("\n");
    const keep = tool.tail(args);
    if (all.length > keep) body = [`(last ${keep} of ${all.length} lines)`, ...all.slice(-keep)].join("\n");
  }
  return { content: [{ type: "text", text: body || "(no output)" }], ...(code === 0 ? {} : { isError: true }) };
}
