import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../merge/cli.js";
import type { FlavorInfo } from "./hubClient.js";

/**
 * Connects `quack mcp` to the AI clients on this computer: Claude Code and Codex through their
 * own `mcp add`, Cursor through its ~/.cursor/mcp.json. The app's "Connect to AI" button runs
 * this, so a person who installs Quack never writes an MCP config by hand.
 *
 * Claude Code and Codex keep their MCP servers in a config folder, and apps that run them
 * (T3 Code, a proxy like CLIProxyAPI) often give each account its own folder through
 * CLAUDE_CONFIG_DIR or CODEX_HOME. A server added to the default folder never reaches those,
 * so every folder found is its own target: the default, the ones in this environment, the
 * ~/.claude-* and ~/.codex-* folders a client has used, and each T3 Code provider's home.
 */

export type ClientKind = "claude" | "cursor" | "codex";
export const CLIENTS: readonly ClientKind[] = ["claude", "cursor", "codex"];
const LABELS: Record<ClientKind, string> = { claude: "Claude Code", cursor: "Cursor", codex: "Codex" };

export interface ClientStatus {
  client: ClientKind;
  /** "claude", "codex", "cursor", or "claude:<folder>" / "codex:<folder>" for another config folder */
  id: string;
  label: string;
  /** The config folder (CLAUDE_CONFIG_DIR / CODEX_HOME); absent for the default one */
  dir?: string;
  installed: boolean;
  connected: boolean;
  problem?: string;
}

interface Target {
  client: ClientKind;
  id: string;
  label: string;
  dir?: string;
}

export interface ClientsEnv {
  home: string;
  claudeBin: string;
  codexBin: string;
  /** Where CLAUDE_CONFIG_DIR / CODEX_HOME are read from */
  env?: NodeJS.ProcessEnv;
  /** T3 Code's settings, for the config folder of each of its providers */
  t3Settings?: string;
}

/** How a client starts the MCP server: this same command, with `mcp` */
export interface ServerCommand {
  command: string;
  args: string[];
}

export const defaultClientsEnv = (): ClientsEnv => ({
  home: os.homedir(),
  claudeBin: "claude",
  codexBin: "codex",
  env: process.env,
  t3Settings: path.join(os.homedir(), ".t3", "userdata", "settings.json"),
});

/** One name per flavor, so Official and Dev sit side by side in a client */
export const serverName = (info: FlavorInfo) => (info.flavor === "official" ? "quack" : "quack-dev");

const TIMEOUT_MS = 30_000;
/** CLIProxyAPI's default port: a Claude folder whose ANTHROPIC_BASE_URL is there runs through it */
const CLIPROXY_PORT = "8317";
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const sameDir = (a: string, b: string) => {
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
};

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** T3 Code's providers that run in their own folder: [driver, folder, name] */
function t3Homes(env: ClientsEnv): { driver: string; dir: string; name: string }[] {
  const settings = env.t3Settings ? readJson(env.t3Settings) : undefined;
  const found: { driver: string; dir: string; name: string }[] = [];
  for (const [key, instance] of Object.entries<any>(settings?.providerInstances ?? {})) {
    for (const dir of [instance?.config?.homePath, instance?.config?.shadowHomePath]) {
      if (typeof dir === "string" && dir.trim()) found.push({ driver: String(instance.driver ?? ""), dir: dir.trim(), name: String(instance.displayName ?? key) });
    }
  }
  return found;
}

/** Folders in home whose name starts with `prefix` and that hold one of `marks` */
function homeFolders(env: ClientsEnv, prefix: string, marks: string[]): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(env.home);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(prefix))
    .map((n) => path.join(env.home, n))
    .filter((dir) => marks.some((m) => fs.existsSync(path.join(dir, m))));
}

/** "via CLIProxyAPI" when the folder's Claude Code talks to it */
function claudeVia(dir: string): string | undefined {
  const url = readJson(path.join(dir, "settings.json"))?.env?.ANTHROPIC_BASE_URL;
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    if (/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(parsed.hostname) && parsed.port === CLIPROXY_PORT) return "CLIProxyAPI";
  } catch {
    // not a URL: nothing to say
  }
  return undefined;
}

export function findTargets(env: ClientsEnv): Target[] {
  const t3 = t3Homes(env);
  const targets: Target[] = [];
  const extra = (client: "claude" | "codex", dirs: string[], isDefault: (dir: string) => boolean) => {
    const seen: string[] = [];
    for (const dir of dirs) {
      if (isDefault(dir) || seen.some((d) => sameDir(d, dir)) || !fs.existsSync(dir)) continue;
      seen.push(dir);
      const app = t3.find((h) => sameDir(h.dir, dir));
      const via = client === "claude" ? claudeVia(dir) : undefined;
      const where = [app ? `T3 Code: ${app.name}` : path.basename(dir), via].filter(Boolean).join(", ");
      targets.push({ client, id: `${client}:${dir}`, label: `${LABELS[client]} (${where})`, dir });
    }
  };

  targets.push({ client: "claude", id: "claude", label: LABELS.claude });
  // ~/.claude is the default folder's settings, not a CLAUDE_CONFIG_DIR of its own
  const claudeDefault = path.join(env.home, ".claude");
  extra("claude", [
    ...(env.env?.CLAUDE_CONFIG_DIR ? [env.env.CLAUDE_CONFIG_DIR] : []),
    ...t3.filter((h) => h.driver.startsWith("claude")).map((h) => h.dir),
    ...homeFolders(env, ".claude-", [".claude.json"]),
  ], (dir) => sameDir(dir, claudeDefault) && !env.env?.CLAUDE_CONFIG_DIR && !t3.some((h) => sameDir(h.dir, dir)));

  targets.push({ client: "cursor", id: "cursor", label: LABELS.cursor });

  const codexDefault = path.join(env.home, ".codex");
  targets.push({ client: "codex", id: "codex", label: LABELS.codex });
  extra("codex", [
    ...(env.env?.CODEX_HOME ? [env.env.CODEX_HOME] : []),
    ...t3.filter((h) => h.driver.startsWith("codex")).map((h) => h.dir),
    ...homeFolders(env, ".codex-", ["config.toml", "auth.json"]),
  ], (dir) => sameDir(dir, codexDefault));
  return targets;
}

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

/** The binary and the environment that point a CLI at the target's folder */
function cli(target: Target, env: ClientsEnv): { bin: string; vars?: NodeJS.ProcessEnv } {
  const bin = target.client === "claude" ? env.claudeBin : env.codexBin;
  const variable = target.client === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  // The default target unsets a variable this process may carry, or it would land elsewhere
  return { bin, vars: { [variable]: target.dir } };
}

async function status(target: Target, name: string, env: ClientsEnv): Promise<ClientStatus> {
  const base = { client: target.client, id: target.id, label: target.label, ...(target.dir ? { dir: target.dir } : {}) };
  try {
    if (target.client === "cursor") {
      if (!fs.existsSync(path.join(env.home, ".cursor"))) return { ...base, installed: false, connected: false };
      const config = readCursor(env);
      return { ...base, installed: true, connected: !!config?.mcpServers && Object.hasOwn(config.mcpServers, name) };
    }
    const { bin, vars } = cli(target, env);
    // `mcp get` exits 0 only when the server is there
    const r = await run(bin, ["mcp", "get", name], undefined, TIMEOUT_MS, os.tmpdir(), vars);
    return { ...base, installed: true, connected: r.code === 0 };
  } catch (error) {
    if (missing(error)) return { ...base, installed: false, connected: false };
    return { ...base, installed: true, connected: false, problem: (error as Error).message };
  }
}

export function listClients(info: FlavorInfo, env: ClientsEnv): Promise<ClientStatus[]> {
  return Promise.all(findTargets(env).map((target) => status(target, serverName(info), env)));
}

async function connectOne(target: Target, name: string, server: ServerCommand, env: ClientsEnv): Promise<void> {
  if (target.client === "cursor") {
    const config = readCursor(env) ?? {};
    const servers = (config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {}) as Record<string, unknown>;
    // Every other server and key stays as it was
    const next = { ...config, mcpServers: { ...servers, [name]: { command: server.command, args: server.args } } };
    fs.mkdirSync(path.dirname(cursorFile(env)), { recursive: true });
    fs.writeFileSync(cursorFile(env), `${JSON.stringify(next, null, 2)}\n`);
    return;
  }
  const { bin, vars } = cli(target, env);
  const scope = target.client === "claude" ? ["--scope", "user"] : [];
  // Replaces an older entry (another install's path): add refuses a name already there
  await run(bin, ["mcp", "remove", name, ...scope], undefined, TIMEOUT_MS, os.tmpdir(), vars);
  const r = await run(bin, ["mcp", "add", ...scope, name, "--", server.command, ...server.args], undefined, TIMEOUT_MS, os.tmpdir(), vars);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `${target.label} answered ${r.code}`);
}

/**
 * Connects every target named (a kind like "claude" names each of its folders; an id names one;
 * default: every one installed), then reads back what each has
 */
export async function connectClients(info: FlavorInfo, server: ServerCommand, env: ClientsEnv, only: string[] = []): Promise<ClientStatus[]> {
  const targets = findTargets(env);
  const before = await Promise.all(targets.map((t) => status(t, serverName(info), env)));
  const problems = new Map<string, string>();
  for (const [i, found] of before.entries()) {
    if (!found.installed || (only.length && !only.includes(found.client) && !only.includes(found.id))) continue;
    try {
      await connectOne(targets[i], serverName(info), server, env);
    } catch (error) {
      problems.set(found.id, (error as Error).message);
    }
  }
  const after = await listClients(info, env);
  return after.map((s) => (problems.has(s.id) ? { ...s, problem: problems.get(s.id) } : s));
}
