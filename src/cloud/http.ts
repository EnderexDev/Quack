import { resolveKey, RobloxError, type RobloxEnv } from "../control/roblox.js";

/**
 * One Open Cloud request with the hub's key: the permission it needs named on a 401/403, the key
 * scrubbed from every message, a 404 kept apart (often "nothing there", not a failure).
 */
export interface CloudAnswer {
  status: number;
  headers: Headers;
  text: string;
  json?: any;
}

export async function cloudRequest(
  env: RobloxEnv,
  request: { method?: string; url: string; what: string; permission: string; body?: string; headers?: Record<string, string>; allow404?: boolean; timeoutMs?: number },
): Promise<CloudAnswer> {
  const { key, scrub } = await resolveKey(env, request.permission);
  let response: Response;
  try {
    response = await env.fetch(request.url, {
      method: request.method ?? "GET",
      headers: { "x-api-key": key, Accept: "application/json", ...(request.body !== undefined ? { "content-type": "application/json" } : {}), ...request.headers },
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
    });
  } catch (error) {
    const e = error as Error;
    throw new RobloxError(`${request.what}: Roblox did not answer (${scrub(e.name === "TimeoutError" ? "no answer in time" : ((e.cause as Error)?.message ?? e.message))})`);
  }
  // A body that fails to arrive (a timeout after the headers) is an error, never an empty answer
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    throw new RobloxError(`${request.what}: Roblox's answer did not arrive whole (${scrub((error as Error).message)})`);
  }
  const text = scrub(raw);
  if (response.status === 401 || response.status === 403) {
    throw new RobloxError(`${request.what}: Roblox refused the key (HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}). It needs ${request.permission}, for this experience: the user adds it to the key in the Creator Hub (Open Cloud, API Keys)`);
  }
  if (response.status === 404 && request.allow404) return { status: 404, headers: response.headers, text };
  if (response.status === 404) throw new RobloxError(`${request.what}: not found (404)`);
  if (response.status === 429) throw new RobloxError(`${request.what}: Roblox's rate limit (HTTP 429): wait a little and try again`);
  if (!response.ok) throw new RobloxError(`${request.what}: HTTP ${response.status} ${text.slice(0, 300)}`);
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    // a value that is not JSON (a DataStore string, a text answer)
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** A whole number id from the caller, for a URL */
export function wholeId(raw: unknown, what: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new RobloxError(`${what} must be a whole number above 0`);
  return n;
}

/** A name for a URL or a query: present, not too long, no control characters */
export function nameArg(raw: unknown, what: string, max = 200): string {
  if (typeof raw !== "string" || !raw.length) throw new RobloxError(`${what} is required`);
  if (raw.length > max) throw new RobloxError(`${what} is at most ${max} characters`);
  if (/[\u0000-\u001f]/.test(raw)) throw new RobloxError(`${what} has a control character`);
  return raw;
}

/** What the approval window holds at most: a write that changes more is done in parts */
export const DIALOG_MAX_CHANGES = 2000;
export const DIALOG_MAX_CHARS = 400_000;

/**
 * A write's changes as the approval window shows them: every one, whole, in the window itself
 * (it scrolls). More than the window can hold is refused, never cut: nothing approved goes unseen.
 */
export function changesForDialog(before: unknown, after: unknown): string {
  // A character budget too: building stops once the window could not hold it anyway
  const budget = { left: DIALOG_MAX_CHARS + 1 };
  const all = changedPaths(before, after, "", [], DIALOG_MAX_CHANGES + 1, Number.MAX_SAFE_INTEGER, budget);
  if (!all.length) return "Nothing changes: the value is the same.";
  const text = `What changes (${all.length}):\n${all.map((c) => `  ${c}`).join("\n")}`;
  if (all.length > DIALOG_MAX_CHANGES || text.length > DIALOG_MAX_CHARS || budget.left <= 0) {
    throw new RobloxError(`this write changes more than the approval window can show whole (${all.length > DIALOG_MAX_CHANGES ? `over ${DIALOG_MAX_CHANGES} fields` : `${text.length} characters`}): split it into smaller writes`);
  }
  return text;
}

/** The dot paths whose values differ between two JSON values, for a write's question */
export function changedPaths(before: unknown, after: unknown, prefix = "", out: string[] = [], max = 25, valueChars = 60, budget = { left: Number.MAX_SAFE_INTEGER }): string[] {
  if (out.length >= max || budget.left <= 0) return out;
  const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
    // A key that is not a plain name is quoted with its escapes: a line break in a key never
    // makes a fake line in the approval window
    for (const k of [...keys].sort()) {
      const segment = /^[\w$-]+$/.test(k) ? k : JSON.stringify(k);
      changedPaths((before as any)[k], (after as any)[k], prefix ? `${prefix}.${segment}` : segment, out, max, valueChars, budget);
    }
    return out;
  }
  const a = JSON.stringify(before);
  const b = JSON.stringify(after);
  if (a !== b) {
    const show = (v: string | undefined) => (v === undefined ? "(none)" : v.slice(0, valueChars));
    const line = `${prefix || "(the whole value)"}: ${show(a)} -> ${show(b)}`;
    budget.left -= line.length;
    out.push(line);
  }
  return out;
}
