/**
 * Quack's review after an AI's edit (his call, 12/11/26): a hook "Connect to AI" installs in each
 * client next to the guard. The client starts it after a tool that edits files, with the call on
 * stdin; it asks the hub to analyze the Luau files the call touched and hands the findings back
 * to the AI at once, in the client's own format. It never blocks or undoes the edit, and it says
 * nothing when there is nothing to say: no Luau file, no project, the hub down, the review turned
 * off in the app, no finding, or any error of its own.
 *
 *  - Claude Code: PostToolUse on Edit|Write|MultiEdit, `tool_input.file_path`; the answer is
 *    `hookSpecificOutput.additionalContext`
 *  - Codex: PostToolUse on apply_patch, the paths read from the patch (`*** Update File: x`); the
 *    same answer. Codex asks the user to trust a new hook once, in its /hooks
 *  - Cursor: postToolUse (its edit tools' names are not documented: every tool comes, and only a
 *    call naming a Luau file goes further); the answer is `additional_context`
 *
 * Only node:fs, node:http and node:path: it runs after every edit, as one small file (review.mjs).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export type ReviewClient = "claude" | "codex" | "cursor";

/** The tools the Claude Code hook is called for */
export const REVIEW_MATCHER = "Edit|Write|MultiEdit";
/** Codex's file edits all go through apply_patch */
export const CODEX_REVIEW_MATCHER = "apply_patch|Edit|Write";

const LUAU = /\.luau?$/i;
const MAX_LINES = 40;

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The files a tool call wrote: named in its input, or in an apply_patch patch */
export function editedFiles(data: any): string[] {
  const input = data?.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
  const cwd = text(data?.cwd) || text(data?.workspace_roots?.[0]) || process.cwd();
  const found: string[] = [];
  for (const key of ["file_path", "path", "target_file", "filePath", "notebook_path"]) if (text(input[key])) found.push(text(input[key]));
  if (Array.isArray(input.edits)) for (const e of input.edits) if (text(e?.file_path)) found.push(text(e.file_path));
  // apply_patch: the patch is the command (a string, or argv with the patch last) or the input
  const patches = [input.command, input.input, input.patch].flatMap((v) => (Array.isArray(v) ? v : [v])).map(text).filter((p) => p.includes("*** "));
  for (const patch of patches) {
    for (const m of patch.matchAll(/^\*\*\* (?:Update File|Add File|Move to):\s*(.+?)\s*$/gm)) found.push(m[1]);
  }
  const out: string[] = [];
  for (const f of found) {
    const abs = path.resolve(cwd, f);
    if (LUAU.test(abs) && !out.includes(abs)) out.push(abs);
  }
  return out;
}

export interface ReviewFinding {
  file: string;
  line: number;
  column: number;
  rule: string;
  message: string;
}

/** What the AI reads, or "" when nothing was found */
export function reviewText(answer: { findings?: ReviewFinding[]; elsewhere?: ReviewFinding[] }): string {
  const own = answer.findings ?? [];
  const other = answer.elsewhere ?? [];
  if (!own.length && !other.length) return "";
  const line = (f: ReviewFinding) => `${f.file}:${f.line}:${f.column}  ${f.rule}  ${f.message}`;
  const lines: string[] = [];
  const problems = (n: number) => `${n} problem${n === 1 ? "" : "s"}`;
  if (own.length) lines.push(`Quack's analysis found ${problems(own.length)} in the file(s) just edited:`, ...own.slice(0, MAX_LINES).map(line));
  if (other.length) lines.push(`${own.length ? "And" : "Quack's analysis found"} ${problems(other.length)} new in other files since this edit (a caller it may have broken):`, ...other.slice(0, MAX_LINES).map(line));
  if (own.length > MAX_LINES || other.length > MAX_LINES) lines.push("(more not shown: `quack analyze` lists every one)");
  lines.push("Fix what this edit caused. A finding left on purpose is silenced with `-- quack: allow(<rule>)` on its line or the one above.");
  return lines.join("\n");
}

/** The answer in the client's format; "" (Claude, Codex) or "{}" (Cursor) when there is nothing */
export function reviewOutput(client: ReviewClient, message: string): string {
  if (client === "cursor") return JSON.stringify(message ? { additional_context: message } : {});
  if (!message) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message } });
}

function askHub(port: number, files: string[], timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ files, feature: "review" });
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/api/analyze", timeout: timeoutMs, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw new Error(`hub answered ${res.statusCode}`);
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

/** The hook's whole run: stdin in, the client's answer out; never throws */
export async function reviewAnswer(stdin: string, options: { client: ReviewClient; port: number; timeoutMs?: number; ask?: typeof askHub }): Promise<string> {
  const empty = reviewOutput(options.client, "");
  try {
    const files = editedFiles(JSON.parse(stdin)).filter((f) => fs.existsSync(f));
    if (!files.length) return empty;
    const answer = await (options.ask ?? askHub)(options.port, files, options.timeoutMs ?? 20_000);
    if (!answer || answer.disabled) return empty;
    return reviewOutput(options.client, reviewText(answer));
  } catch {
    return empty;
  }
}
