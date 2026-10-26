import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../merge/cli.js";
import type { FlavorInfo } from "./hubClient.js";

/**
 * Connects `quack mcp` to the AI clients on this computer: Claude Code and Codex through their
 * own `mcp add`, Cursor through its ~/.cursor/mcp.json. The app's "Connect to AI" button runs
 * this, so a person who installs Quack never writes an MCP config by hand.
 */

export type ClientName = "claude" | "cursor" | "codex";
export const CLIENTS: readonly ClientName[] = ["claude", "cursor", "codex"];
const LABELS: Record<ClientName, string> = { claude: "Claude Code", cursor: "Cursor", codex: "Codex" };

export interface ClientStatus {
  client: ClientName;
  label: string;
  installed: boolean;
  connected: boolean;
  problem?: string;
}

export interface ClientsEnv {
  home: string;
  claudeBin: string;
  codexBin: string;
}

/** How a client starts the MCP server: this same command, with `mcp` */
export interface ServerCommand {
  command: string;
  args: string[];
}

export const defaultClientsEnv = (): ClientsEnv => ({ home: os.homedir(), claudeBin: "claude", codexBin: "codex" });

/** One name per flavor, so Official and Dev sit side by side in a client */
export const serverName = (info: FlavorInfo) => (info.flavor === "official" ? "quack" : "quack-dev");

const TIMEOUT_MS = 30_000;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function cursorFile(env: ClientsEnv): string {
  return path.join(env.home, ".cursor", "mcp.json");
}

/** Cursor's config, or null when there is none; a file that is not JSON is never overwritten */
function readCursor(env: ClientsEnv): { mcpServers?: Record<string, unknown> } | null {
  let text: string;
  try {
    text = fs.readFileSync(cursorFile(env), "utf8");
  } catch (error) {
    // Only a missing file is no config: one that cannot be read must not be written over
    if (missing(error)) return null;
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${cursorFile(env)} is not a JSON object`);
  return parsed;
}

async function status(client: ClientName, name: string, env: ClientsEnv): Promise<ClientStatus> {
  const base = { client, label: LABELS[client] };
  try {
    if (client === "cursor") {
      if (!fs.existsSync(path.join(env.home, ".cursor"))) return { ...base, installed: false, connected: false };
      const config = readCursor(env);
      return { ...base, installed: true, connected: !!config?.mcpServers && Object.hasOwn(config.mcpServers, name) };
    }
    const bin = client === "claude" ? env.claudeBin : env.codexBin;
    // `mcp get` exits 0 only when the server is there
    const r = await run(bin, ["mcp", "get", name], undefined, TIMEOUT_MS, os.tmpdir());
    return { ...base, installed: true, connected: r.code === 0 };
  } catch (error) {
    if (missing(error)) return { ...base, installed: false, connected: false };
    return { ...base, installed: true, connected: false, problem: (error as Error).message };
  }
}

export function listClients(info: FlavorInfo, env: ClientsEnv): Promise<ClientStatus[]> {
  return Promise.all(CLIENTS.map((client) => status(client, serverName(info), env)));
}

async function connectOne(client: ClientName, name: string, server: ServerCommand, env: ClientsEnv): Promise<void> {
  if (client === "cursor") {
    const config = readCursor(env) ?? {};
    const servers = (config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {}) as Record<string, unknown>;
    // Every other server and key stays as it was
    const next = { ...config, mcpServers: { ...servers, [name]: { command: server.command, args: server.args } } };
    fs.mkdirSync(path.dirname(cursorFile(env)), { recursive: true });
    fs.writeFileSync(cursorFile(env), `${JSON.stringify(next, null, 2)}\n`);
    return;
  }
  const bin = client === "claude" ? env.claudeBin : env.codexBin;
  const scope = client === "claude" ? ["--scope", "user"] : [];
  // Replaces an older entry (another install's path): add refuses a name already there
  await run(bin, ["mcp", "remove", name, ...scope], undefined, TIMEOUT_MS, os.tmpdir());
  const r = await run(bin, ["mcp", "add", ...scope, name, "--", server.command, ...server.args], undefined, TIMEOUT_MS, os.tmpdir());
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `${LABELS[client]} answered ${r.code}`);
}

/** Connects every client named (default: each one installed), then reads back what each has */
export async function connectClients(info: FlavorInfo, server: ServerCommand, env: ClientsEnv, only: ClientName[] = []): Promise<ClientStatus[]> {
  const before = await listClients(info, env);
  const problems = new Map<ClientName, string>();
  for (const found of before) {
    if (!found.installed || (only.length && !only.includes(found.client))) continue;
    try {
      await connectOne(found.client, serverName(info), server, env);
    } catch (error) {
      problems.set(found.client, (error as Error).message);
    }
  }
  const after = await listClients(info, env);
  return after.map((s) => (problems.has(s.client) ? { ...s, problem: problems.get(s.client) } : s));
}
