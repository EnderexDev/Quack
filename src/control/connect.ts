import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../merge/cli.js";
import { GUARD_MATCHER } from "./guard.js";
import { markers, rule } from "./rule.js";
import type { FlavorInfo } from "./hubClient.js";

/**
 * Connects `quack mcp` to the AI clients on this computer: Claude Code and Codex through their
 * own `mcp add`, Cursor through its ~/.cursor/mcp.json. The app's "Connect to AI" button runs
 * this, so a person who installs Quack never writes an MCP config by hand. The same click puts
 * Quack's rule in Claude Code's CLAUDE.md and Codex's AGENTS.md (an older copy is replaced
 * where it is), and Quack's guard in Claude Code's hooks. Cursor keeps its rules in its own
 * settings, not a file: it gets the MCP server's instructions (the rule's short form).
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
  /** Claude Code: Quack's guard is in this folder's settings.json */
  guarded?: boolean;
  /** Claude Code and Codex: Quack's rule in the folder's instructions, as this Quack has it or older */
  rule?: "current" | "outdated" | "missing";
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
  /** Quack's guard (guard.ts), installed as a PreToolUse hook in each Claude Code folder */
  guard?: { command: string; args: string[] };
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

async function status(target: Target, info: FlavorInfo, env: ClientsEnv): Promise<ClientStatus> {
  const name = serverName(info);
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
    const guarded = target.client === "claude" ? hasGuard(claudeSettings(target, env), name) : undefined;
    const found = findRule(configDir(target, env), target.client, info);
    const ruleState = !found ? "missing" : found.version === rule(info).version ? "current" : "outdated";
    return { ...base, installed: true, connected: r.code === 0, ...(guarded === undefined ? {} : { guarded }), rule: ruleState };
  } catch (error) {
    if (missing(error)) return { ...base, installed: false, connected: false };
    return { ...base, installed: true, connected: false, problem: (error as Error).message };
  }
}

export function listClients(info: FlavorInfo, env: ClientsEnv): Promise<ClientStatus[]> {
  return Promise.all(findTargets(env).map((target) => status(target, info, env)));
}

async function connectOne(target: Target, info: FlavorInfo, server: ServerCommand, env: ClientsEnv): Promise<void> {
  const name = serverName(info);
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
  if (target.client === "claude" && server.guard) installGuard(claudeSettings(target, env), name, server.guard);
  installRule(configDir(target, env), target.client, info);
}

/** The client's config folder (CLAUDE_CONFIG_DIR / CODEX_HOME, or the default one) */
function configDir(target: Target, env: ClientsEnv): string {
  return target.dir ?? path.join(env.home, target.client === "claude" ? ".claude" : ".codex");
}

/** The instructions file each client loads in every session, in its config folder */
const INSTRUCTIONS: Record<"claude" | "codex", string> = { claude: "CLAUDE.md", codex: "AGENTS.md" };
/** A client's own data, never instructions: not searched for the rule */
const NOT_INSTRUCTIONS = new Set(["projects", "plugins", "todos", "shell-snapshots", "statsig", "ide", "cache", "debug", "file-history", "sessions", "archived_sessions", "node_modules", "logs", "log", "tasks", "attachments", "backups", "downloads", "telemetry", "tmp", "worktrees"]);
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface RuleBlock {
  file: string;
  text: string;
  start: number;
  stop: number;
  version: string;
}

/** This flavor's rule block in one file, or undefined */
function blockIn(file: string, info: FlavorInfo): RuleBlock | undefined {
  let text: string;
  try {
    if (fs.statSync(file).size > 2_000_000) return undefined;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const { begin, end } = markers(info);
  const open = new RegExp(`${escapeRegExp(begin)} ([0-9a-f]{8}) -->`).exec(text);
  if (!open) return undefined;
  const close = text.indexOf(end, open.index);
  if (close < 0) return undefined;
  return { file, text, start: open.index, stop: close + end.length, version: open[1] };
}

/**
 * Where this flavor's rule is: the instructions file first, then any .md the user keeps rules in
 * (rules/, a folder of their own), three levels down at most. A user who moved the block keeps
 * it where they put it.
 */
function findRule(dir: string, client: ClientKind, info: FlavorInfo): RuleBlock | undefined {
  if (client === "cursor") return undefined;
  const main = blockIn(path.join(dir, INSTRUCTIONS[client]), info);
  if (main) return main;
  const walk = (folder: string, depth: number): RuleBlock | undefined => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const found = blockIn(path.join(folder, entry.name), info);
        if (found) return found;
      }
    }
    if (depth >= 3) return undefined;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || NOT_INSTRUCTIONS.has(entry.name)) continue;
      const found = walk(path.join(folder, entry.name), depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(dir, 0);
}

/**
 * Quack's rule in the client's instructions: an older copy is replaced where it is, with nothing
 * else in that file changed; without one it goes at the end of CLAUDE.md / AGENTS.md
 */
export function installRule(dir: string, client: ClientKind, info: FlavorInfo): void {
  if (client === "cursor") return;
  const { text: block } = rule(info);
  const found = findRule(dir, client, info);
  if (found) {
    const newline = found.text.includes("\r\n") ? "\r\n" : "\n";
    const next = found.text.slice(0, found.start) + block.replace(/\r?\n/g, newline) + found.text.slice(found.stop);
    if (next !== found.text) fs.writeFileSync(found.file, next);
    return;
  }
  const file = path.join(dir, INSTRUCTIONS[client]);
  let before = "";
  try {
    before = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  const gap = !before ? "" : before.endsWith(newline + newline) ? "" : before.endsWith(newline) ? newline : newline + newline;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, before + gap + block.replace(/\r?\n/g, newline) + newline);
}

/** The Claude Code folder's settings.json (its hooks live there) */
function claudeSettings(target: Target, env: ClientsEnv): string {
  return path.join(target.dir ?? path.join(env.home, ".claude"), "settings.json");
}

/** Marks the hook each flavor installs (by its MCP server's name), so a new connect replaces it */
const guardMark = (name: string) => `--quack-guard ${name}`;
const quote = (part: string) => `"${part.replace(/\\/g, "/")}"`;

function isGuardEntry(entry: any, name: string): boolean {
  // The mark ends the command: "--quack-guard quack" must not match Dev's "--quack-guard quack-dev"
  return Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => typeof h?.command === "string" && h.command.trimEnd().endsWith(` ${guardMark(name)}`));
}

/** Settings as JSON, {} when missing; a file that is not a JSON object is never written over */
function readSettings(file: string): Record<string, any> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (missing(error)) return {};
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

function hasGuard(file: string, name: string): boolean {
  try {
    const list = readSettings(file).hooks?.PreToolUse;
    return Array.isArray(list) && list.some((entry) => isGuardEntry(entry, name));
  } catch {
    return false;
  }
}

/**
 * Quack's guard as a PreToolUse hook in this settings.json: an older entry of this flavor is
 * replaced, every other hook and key stays as it was
 */
export function installGuard(file: string, name: string, guard: { command: string; args: string[] }): void {
  const settings = readSettings(file);
  const hooks = settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : {};
  const before = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse.filter((entry: any) => !isGuardEntry(entry, name)) : [];
  const command = [guard.command, ...guard.args].map(quote).join(" ") + ` ${guardMark(name)}`;
  const next = {
    ...settings,
    hooks: { ...hooks, PreToolUse: [...before, { matcher: GUARD_MATCHER, hooks: [{ type: "command", command, timeout: 10 }] }] },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Connects every target named (a kind like "claude" names each of its folders; an id names one;
 * default: every one installed), then reads back what each has
 */
export async function connectClients(info: FlavorInfo, server: ServerCommand, env: ClientsEnv, only: string[] = []): Promise<ClientStatus[]> {
  const targets = findTargets(env);
  const before = await Promise.all(targets.map((t) => status(t, info, env)));
  const problems = new Map<string, string>();
  for (const [i, found] of before.entries()) {
    if (!found.installed || (only.length && !only.includes(found.client) && !only.includes(found.id))) continue;
    try {
      await connectOne(targets[i], info, server, env);
    } catch (error) {
      problems.set(found.id, (error as Error).message);
    }
  }
  const after = await listClients(info, env);
  return after.map((s) => (problems.has(s.id) ? { ...s, problem: problems.get(s.id) } : s));
}
