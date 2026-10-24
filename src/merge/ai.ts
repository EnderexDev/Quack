import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AiProvider, QuackConfig } from "../config.js";
import { run } from "./cli.js";

/**
 * Quack: which AI can merge on this machine. Nothing of the user's travels with Quack: the merge
 * runs the Claude Code or Codex CLI installed here, on the account logged in here. The app
 * offers only what it finds: neither = AI off and a note on what to install, one = that one,
 * both = the user picks.
 */

export const PROVIDERS: readonly AiProvider[] = ["claude", "codex"];

export interface ProviderStatus {
  installed: boolean;
  loggedIn: boolean;
  /** The model a merge would use, for display */
  model?: string;
  /** Why it cannot be used, when it cannot */
  problem?: string;
}

export type Detected = Record<AiProvider, ProviderStatus>;

/**
 * ready: merges use `provider`. off: the user turned AI off. none: no CLI usable here.
 * choose: both usable and none chosen; merges skip the AI until the user picks.
 */
export type AiState = "ready" | "off" | "none" | "choose";

export interface Effective {
  state: AiState;
  provider: AiProvider | null;
}

type MergeSettings = QuackConfig["merge"];

export function usable(detected: Detected): AiProvider[] {
  return PROVIDERS.filter((p) => detected[p].installed && detected[p].loggedIn);
}

/** The AI a merge would use now, from the settings and what is on this machine */
export function resolveAi(settings: MergeSettings, detected: Detected): Effective {
  const available = usable(detected);
  if (available.length === 0) return { state: "none", provider: null };
  if (!settings.ai) return { state: "off", provider: null };
  if (settings.provider && available.includes(settings.provider)) return { state: "ready", provider: settings.provider };
  // Nothing chosen, or the chosen one is gone: the only one left needs no choice
  if (available.length === 1) return { state: "ready", provider: available[0] };
  return { state: "choose", provider: null };
}

/** Why a merge did not use the AI, for its log line */
export function skippedNote(effective: Effective): string {
  switch (effective.state) {
    case "off":
      return "AI merge is off (merge.ai = false)";
    case "none":
      return "no AI here: install Claude Code or Codex and log in";
    case "choose":
      return "Claude Code and Codex are both here: choose one in the app";
    default:
      return "";
  }
}

const DETECT_TIMEOUT_MS = 20_000;

async function detectClaude(settings: MergeSettings): Promise<ProviderStatus> {
  try {
    const r = await run(settings.claudeBin, ["auth", "status"], undefined, DETECT_TIMEOUT_MS, os.tmpdir());
    let loggedIn = false;
    try {
      loggedIn = JSON.parse(r.stdout).loggedIn === true;
    } catch {
      // an old CLI without JSON output: exit 0 is the only answer it gives
      loggedIn = r.code === 0;
    }
    return { installed: true, loggedIn, model: settings.model, ...(loggedIn ? {} : { problem: "not logged in (run claude, then /login)" }) };
  } catch (error) {
    return notInstalled(error, "Claude Code");
  }
}

async function detectCodex(settings: MergeSettings): Promise<ProviderStatus> {
  try {
    const r = await run(settings.codexBin, ["login", "status"], undefined, DETECT_TIMEOUT_MS, os.tmpdir());
    const loggedIn = r.code === 0;
    const model = settings.codexModel || codexDefaultModel() || undefined;
    return { installed: true, loggedIn, model, ...(loggedIn ? {} : { problem: "not logged in (run codex login)" }) };
  } catch (error) {
    return notInstalled(error, "Codex");
  }
}

function notInstalled(error: unknown, name: string): ProviderStatus {
  const code = (error as NodeJS.ErrnoException).code;
  return { installed: false, loggedIn: false, problem: code === "ENOENT" ? `${name} is not installed` : (error as Error).message };
}

export async function detectAi(settings: MergeSettings): Promise<Detected> {
  const [claude, codex] = await Promise.all([detectClaude(settings), detectCodex(settings)]);
  return { claude, codex };
}

/**
 * The model Codex picks when given none, for display only: the first listed one of its model
 * cache. Codex itself decides at run time; a fresh install has no cache.
 */
export function codexDefaultModel(home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")): string | null {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8"));
    const listed = (cache.models as Array<{ slug?: string; visibility?: string; priority?: number }>)
      .filter((m) => m.visibility === "list" && typeof m.slug === "string")
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    return listed[0]?.slug ?? null;
  } catch {
    return null;
  }
}

/** Detection spawns two CLIs (about a second): kept for a minute */
const CACHE_MS = 60_000;
let cached: { at: number; key: string; detected: Promise<Detected> } | null = null;

export function detectAiCached(settings: MergeSettings, force = false): Promise<Detected> {
  const key = `${settings.claudeBin}\0${settings.codexBin}\0${settings.model}\0${settings.codexModel}`;
  if (force || !cached || cached.key !== key || Date.now() - cached.at > CACHE_MS) {
    cached = { at: Date.now(), key, detected: detectAi(settings) };
  }
  return cached.detected;
}

// ---------- the command lines ----------

/**
 * Claude Code in print mode with nothing of the user's setup: no tools, MCP servers, hooks,
 * skills or CLAUDE.md files, only the merge prompt. Not --bare: that mode ignores the login and
 * wants an API key (measured on 20/10/26: "Not logged in" with a logged-in claude.ai account).
 */
export function claudeArgs(model: string, systemPromptFile: string): string[] {
  return [
    "-p", "--model", model, "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    "--setting-sources", "", "--disable-slash-commands", "--system-prompt-file", systemPromptFile,
  ];
}

/**
 * What Codex could use to reach past the merge text. Read-only still lets its shell read any
 * file, and the scripts it merges are text a stranger may have written, so the tools that run
 * commands or code, browse or open apps are off (measured on 0.163: with these off, asked to read
 * a file it has no tool for it; code mode fails closed). Given as -c keys, which a Codex without
 * one of them ignores; --disable with a name it does not know refuses to start.
 */
const CODEX_TOOLS_OFF = [
  "shell_tool", "unified_exec", "code_mode_host", "browser_use", "browser_use_external",
  "in_app_browser", "computer_use", "apps", "plugins",
];

/**
 * Codex non-interactive, read-only, without the user's config.toml, AGENTS.md rules, a saved
 * session or tools; the prompt comes on stdin and the answer as JSON events on stdout.
 */
export function codexArgs(model: string): string[] {
  return [
    "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check",
    "-s", "read-only", "--json",
    ...CODEX_TOOLS_OFF.flatMap((feature) => ["-c", `features.${feature}=false`]),
    "-c", "web_search=disabled",
    ...(model ? ["-m", model] : []), "-",
  ];
}

/** The last agent message in Codex's JSON event stream */
export function codexReply(stdout: string): string {
  let reply: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // not an event line
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      reply = event.item.text;
    } else if (event.type === "error" || event.type === "turn.failed") {
      throw new Error(`codex: ${event.message ?? event.error?.message ?? line.slice(0, 300)}`);
    }
  }
  if (reply === null) throw new Error("codex gave no answer");
  return reply;
}
