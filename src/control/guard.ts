/**
 * Quack's guard for AI clients: a PreToolUse hook that "Connect to AI" installs in each Claude
 * Code folder next to the MCP server. It refuses the tool calls that would reach what only the
 * user may use:
 * - the Open Cloud key vault (open-cloud.key, and open-cloud.env, where a key sat in plain text
 *   before the vault), which only the hub decrypts
 * - the app's approval token (approval-token.dpapi), which answers a write's approval
 * - DPAPI decryption, and running the vault's own code
 * - UI automation aimed at Quack's app, which would click Accept for the user
 * It reads the command's text, so a script obfuscated on purpose gets past it; what holds then
 * is structural (the key is DPAPI-encrypted, the hub accepts an answer only with the app's
 * token). The guard keeps an AI from reaching them by accident or by a plain try.
 *
 * Only node:os and node:path: it runs on every tool call, so it starts as one small file (guard.mjs).
 * Every check is linear in the command's length: words are split once and each is scanned with
 * indexOf or a pattern that cannot backtrack over another, so a long command cannot stall it.
 */
import os from "node:os";
import path from "node:path";

export interface GuardBlock {
  id: string;
  reason: string;
}

const KEY_REASON = "Quack's Open Cloud key is for its hub only: Open Cloud work goes through quack's tools (the hub's named operations), and the key is never read, printed or asked for";
const TOKEN_REASON = "Quack's approval token belongs to its app: with it a write could be approved without the user";
const SEARCH_REASON = "A wildcard or a search over Quack's data folders (or a folder above them) reaches its key vault and approval token: search a narrower folder";

const GLOB = /[*?[]/;
const HOME = os.homedir();
const ROAMING = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
const slashes = (s: string) => s.replace(/\\/g, "/");

/**
 * A protected file named in one word (a path, an argument): by its name, or by a wildcard
 * after its stem (open-cloud.*, approval-token?dpapi). Every occurrence of a stem counts
 * (C:/Users/open-cloud/.../open-cloud.env), each checked in constant time.
 */
function fileHit(word: string): GuardBlock | undefined {
  const lower = word.toLowerCase();
  const lastGlob = Math.max(lower.lastIndexOf("*"), lower.lastIndexOf("?"), lower.lastIndexOf("["));
  for (const [stem, exts, reason, id] of [
    ["open-cloud", /^\.(?:key|env)(?![a-z0-9])/, KEY_REASON, "quack-vault-file"],
    ["approval-token", /^\.(?:dpapi|tmp)(?![a-z0-9])/, TOKEN_REASON, "quack-approval-token"],
  ] as const) {
    for (let at = lower.indexOf(stem); at >= 0; at = lower.indexOf(stem, at + 1)) {
      const end = at + stem.length;
      if (exts.test(lower.slice(end, end + 7)) || lastGlob >= end) return { id, reason };
      if (stem === "approval-token" && /dev\.enderex\.quack(?:\.dev)?\/+$/.test(lower.slice(Math.max(0, at - 30), at))) return { id, reason };
    }
  }
  return undefined;
}

/** An option (-r, --hidden, /s, /c), never a path */
const isOption = (w: string) => w.startsWith("-") || /^\/[A-Za-z?]{1,2}(?::\S*)?$/.test(w);

/** The word as a path: ~, $HOME, $env:APPDATA, %APPDATA%, /c/... spelled out */
function expand(word: string): string {
  return word
    .replace(/^\/([A-Za-z])(?=\/|$)/, "$1:")
    .replace(/^(?:\$env:APPDATA|%APPDATA%|\$\{?APPDATA\}?)(?=$|\/)/i, slashes(ROAMING))
    .replace(/^(?:\$env:LOCALAPPDATA|%LOCALAPPDATA%|\$\{?LOCALAPPDATA\}?)(?=$|\/)/i, slashes(LOCAL))
    .replace(/^(?:~|\$\{?HOME\}?|\$env:USERPROFILE|%USERPROFILE%|\$env:HOME)(?=$|\/)/i, slashes(HOME));
}

/** Where a word points, resolved against the session's folder (., .., ./x/.. all collapse) */
const resolveWord = (word: string, cwd: string) => slashes(path.resolve(cwd, expand(word)));

/**
 * A folder a recursive search or a wildcard must not start from: Quack's data folders, or above
 * them (Roaming, AppData, a user's home, Users, a drive's root). Takes a resolved path.
 */
function searchRoot(resolved: string): boolean {
  let w = resolved;
  while (w.endsWith("/")) w = w.slice(0, -1);
  if (!w || /^[A-Za-z]:$/.test(w)) return true;
  const same = (dir: string) => w.toLowerCase() === slashes(dir).replace(/\/+$/, "").toLowerCase();
  if (same(HOME) || same(ROAMING) || same(path.dirname(ROAMING))) return true;
  if (/^[A-Za-z]:\/+Users(?:\/+[^/]+)?$/i.test(w)) return true;
  if (/\/AppData(?:\/+Roaming)?$/i.test(w)) return true;
  return /\/AppData\/+Roaming\/+(?:quack|dev\.enderex\.quack(?:\.dev)?)$/i.test(w) || same(path.join(ROAMING, "quack"));
}

/**
 * Whether a wildcard path can match a file of the given path: * and ? stay inside one folder,
 * ** crosses folders, [..] is one character. Dynamic programming over the two strings, so a
 * long pattern costs its length times the path's (a protected path is under 100 characters).
 */
function globMatches(glob: string, target: string): boolean {
  const g = glob.toLowerCase();
  const s = target.toLowerCase();
  const tokens: string[] = [];
  for (let i = 0; i < g.length; ) {
    if (g.startsWith("**", i)) {
      tokens.push("**");
      while (g[i] === "*") i++;
    } else if (g[i] === "[") {
      const close = g.indexOf("]", i + 1);
      tokens.push("?");
      i = close < 0 ? i + 1 : close + 1;
    } else tokens.push(g[i++]);
  }
  let row: boolean[] = Array.from({ length: s.length + 1 }, (_, j) => j === 0);
  for (const token of tokens) {
    const next: boolean[] = new Array(s.length + 1).fill(false);
    for (let j = 0; j <= s.length; j++) {
      if (token === "**") next[j] = row[j] || (j > 0 && next[j - 1]);
      else if (token === "*") next[j] = row[j] || (j > 0 && s[j - 1] !== "/" && next[j - 1]);
      else if (j > 0 && row[j - 1]) next[j] = token === "?" ? s[j - 1] !== "/" : token === s[j - 1];
    }
    row = next;
    if (!row.includes(true)) return false;
  }
  return row[s.length];
}

/** Quack's own files under a user's folder: the vault (and its old plain-text file), both tokens */
const QUACK_FILES = ["quack/open-cloud.key", "quack/open-cloud.env", "dev.enderex.quack/approval-token.dpapi", "dev.enderex.quack.dev/approval-token.dpapi"];

/** A resolved wildcard path that can match one of Quack's files, for this user or the one it names */
function reachesQuackFile(resolved: string): boolean {
  const roamings = new Set([slashes(ROAMING).replace(/\/+$/, "")]);
  const named = /^([A-Za-z]:\/+Users\/+[^/*?[]+)/i.exec(resolved);
  if (named) roamings.add(`${named[1]}/AppData/Roaming`);
  return [...roamings].some((roaming) => QUACK_FILES.some((file) => globMatches(resolved, `${roaming}/${file}`)));
}

const SEARCH_WORDS = new Set(["rg", "ag", "ack", "findstr", "select-string", "sls", "--recursive", "/s"]);
/**
 * A word that makes its command read every file under a folder: a search tool, or a recursive
 * flag (grep -rn, cp -R, PowerShell's -r, -rec, -Recurse). Short flags only (up to four letters),
 * so -Force or -ErrorAction is not one.
 */
function recursiveWord(word: string): boolean {
  const lower = word.toLowerCase();
  const name = lower.replace(/^.*\//, "").replace(/\.exe$/, "");
  return SEARCH_WORDS.has(name) || /^-(?=[a-z]{1,4}$)[a-z]*r/.test(lower) || /^-rec(?:u(?:r(?:s(?:e)?)?)?)?$/.test(lower);
}

/** Commands that change the folder the rest of the line runs in */
const CHANGE_DIR = new Set(["cd", "chdir", "pushd", "set-location", "sl"]);

const AUTOMATION = /SendKeys|SendWait|AppActivate|UIAutomation|AutomationElement|InvokePattern|keybd_event|SendInput|PostMessage|SendMessage/i;

/** The vault's own code run by a script runtime; Vault...get( is looked for line by line */
function runsVaultCode(command: string): boolean {
  if (!/\b(?:node|tsx|bun|deno)\b/.test(command)) return false;
  if (/cloud[\\/]vault(?:\.[jt]s)?\b|\bnew\s+Vault\s*\(/.test(command)) return true;
  return command.split("\n").some((line) => {
    const at = line.search(/\bVault\b/);
    return at >= 0 && /\.get\s*\(/.test(line.slice(at));
  });
}

/** PowerShell's -EncodedCommand (and its short forms) hides a command: decoded, a few levels deep */
function withDecoded(command: string, depth = 0): string[] {
  const all = [command];
  if (depth >= 3) return all;
  for (const m of command.matchAll(/(?:^|\s)-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)\s+["']?([A-Za-z0-9+/=]{8,})/gi)) {
    all.push(...withDecoded(Buffer.from(m[1], "base64").toString("utf16le"), depth + 1));
  }
  return all;
}

/**
 * A word with "/" for "\". A "\" before a wildcard escapes it (grep "a\*b", a shell's \?), so
 * that wildcard is no wildcard: it never becomes "/*", the root. Only a word that starts as a
 * Windows path (C:\, \\server, $env:, %APPDATA%) keeps "\*" as a folder and a wildcard.
 */
function normalizeWord(word: string): string {
  if (/^(?:[A-Za-z]:|\\\\|\$env:|%)/i.test(word)) return slashes(word);
  return slashes(word.replace(/\\[*?[]/g, "\u0001"));
}

function checkCommand(command: string, cwd: string): GuardBlock | undefined {
  const words = command.split(/[\s"'`;|&()<>,]+/).filter(Boolean).map(normalizeWord);
  for (const word of words) {
    const hit = fileHit(word);
    if (hit) return hit;
  }
  const blocked = { id: "quack-data-search", reason: SEARCH_REASON };
  // The folder each word runs in: the session's, then each cd's target (cd $env:APPDATA\quack; cat *)
  const folderAt: string[] = [];
  let here = slashes(path.resolve(cwd));
  for (let i = 0; i < words.length; i++) {
    folderAt.push(here);
    if (CHANGE_DIR.has(words[i].toLowerCase()) && i + 1 < words.length && !isOption(words[i + 1])) here = resolveWord(words[i + 1], here);
  }
  let recursive = false;
  let rootWord = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    // A recursive search reads from the folder it runs in, or from a word naming one
    if (recursiveWord(word)) {
      recursive = true;
      if (searchRoot(folderAt[i])) rootWord = true;
    }
    if (isOption(word)) continue;
    const where = resolveWord(word, folderAt[i]);
    if (searchRoot(where)) rootWord = true;
    // A wildcard, resolved where it runs, must not match one of Quack's own files (quack*/*,
    // ~/AppDat?/Roaming/quack/*, cat * inside quack). Any other one passes: /* in a code comment,
    // a search pattern like AppData.*, ~/AppData/Local/Roblox/logs/*.log
    if (GLOB.test(word) && reachesQuackFile(resolveWord(word, folderAt[i]))) return blocked;
  }
  // A recursive search from Quack's folders or above them (rg . C:/Users/ana/AppData/Roaming/x/..,
  // or rg . run from Roaming)
  if (recursive && rootWord) return blocked;
  if (/ProtectedData\]?\s*::\s*Unprotect|CryptUnprotectData|\bUnprotect-CmsMessage\b/i.test(command)) {
    return { id: "dpapi-unprotect", reason: "Decrypting DPAPI data reaches stored keys (Quack keeps its Open Cloud key that way)" };
  }
  if (/\bQuack\b/i.test(command) && AUTOMATION.test(command)) {
    return { id: "quack-app-automation", reason: "Driving Quack's app by script would answer its write approval for the user; only the user clicks it" };
  }
  if (runsVaultCode(command)) {
    return { id: "quack-vault-code", reason: "Running Quack's vault code decrypts the Open Cloud key; it runs in the hub only" };
  }
  return undefined;
}

/** The tool's own name: a client may prefix it (an MCP server's mcp__x__Bash) */
function toolKind(name: string): string | undefined {
  return /(?:^|_)(Bash|PowerShell|Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob)$/.exec(name)?.[1];
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The block for one tool call, or undefined when it may run; `cwd` is where the session runs */
export function checkTool(toolName: string, input: Record<string, unknown> | undefined, cwd?: string): GuardBlock | undefined {
  const kind = toolKind(toolName);
  if (!kind || !input) return undefined;
  if (kind === "Bash" || kind === "PowerShell") {
    for (const command of withDecoded(text(input.command))) {
      const hit = checkCommand(command, cwd || process.cwd());
      if (hit) return hit;
    }
    return undefined;
  }
  // A file tool: only where it points, never the text it writes (Quack's own source names
  // these files, and editing it must stay possible)
  for (const where of [input.file_path, input.notebook_path, input.path, input.glob, kind === "Glob" ? input.pattern : undefined].map(text)) {
    const hit = fileHit(where.replace(/\\/g, "/"));
    if (hit) return hit;
  }
  // Grep reads every file below where it starts (its path, or the session's folder): never from
  // Quack's data folders or above them, however the path is spelled (Roaming/., a/../Roaming)
  if (kind === "Grep") {
    if (searchRoot(resolveWord(slashes(text(input.path)) || ".", cwd || process.cwd()))) return { id: "quack-data-search", reason: SEARCH_REASON };
  }
  return undefined;
}

/** The hook's answer to Claude Code's PreToolUse input (JSON text): a deny, or "{}" */
export function guardAnswer(stdin: string): string {
  let data: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
  try {
    data = JSON.parse(stdin);
  } catch {
    return "{}";
  }
  if (!data || typeof data !== "object") return "{}";
  const input = data.tool_input && typeof data.tool_input === "object" ? (data.tool_input as Record<string, unknown>) : undefined;
  const block = checkTool(text(data.tool_name), input, text(data.cwd) || undefined);
  if (!block) return "{}";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Quack's guard [${block.id}]: ${block.reason}. This block is final: do not look for another way around it.`,
    },
  });
}

/** The tools the installed hook is called for (Claude Code's matcher) */
export const GUARD_MATCHER = "Bash|PowerShell|Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob";
