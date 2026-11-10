import { randomBytes } from "node:crypto";
import { resolveKey, RobloxError, type RobloxEnv } from "../control/roblox.js";
import type { CloudContext } from "./ops.js";

/**
 * What every live-game operation (servers, settings, MessagingService, MemoryStore, ordered data
 * stores, bans) shares: one request to Open Cloud v2 with the key the hub holds, the key scrubbed
 * from every message, a refusal that names the permission to add, and the checks every id and
 * name passes before it goes into a URL or a dialog.
 */

export const CLOUD_V2 = "https://apis.roblox.com/cloud/v2";
const REQUEST_TIMEOUT_MS = 30_000;

export interface CloudRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  body?: unknown;
  /** The key's permission this needs (universe:write, memory-store.queue:add...) */
  permission: string;
  /** For messages: "the sorted map item ... of universe ..." */
  what: string;
  /** Said after a 429 (a per-user limit, for one) */
  limitNote?: string;
  /** Changes Roblox even as a GET (a queue read hides items): its failure may have happened */
  sideEffect?: boolean;
}

/**
 * One Open Cloud request. A write is never sent twice: an answer that never came, or a 5xx, may
 * have changed Roblox, so the message says to read before trying again. A 429 is refused before
 * anything happens, and says so.
 */
export async function cloudRequest(env: RobloxEnv, request: CloudRequest): Promise<any> {
  const { key, scrub } = await resolveKey(env, request.permission);
  const write = request.method !== "GET" || request.sideEffect === true;
  const headers: Record<string, string> = { "x-api-key": key, Accept: "application/json" };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await env.fetch(request.url, {
      method: request.method,
      headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const e = error as Error;
    const why = scrub(e.name === "TimeoutError" ? `no answer in ${REQUEST_TIMEOUT_MS / 1000} s` : ((e.cause as Error)?.message ?? e.message));
    throw new RobloxError(write
      ? `${request.what}: the request was sent but Roblox did not answer (${why}). It may have happened: read it again before sending it a second time`
      : `${request.what}: Roblox did not answer (${why})`);
  }
  let text: string;
  try {
    text = scrub(await response.text());
  } catch (error) {
    const why = scrub((error as Error).message);
    throw new RobloxError(response.ok && write
      ? `${request.what}: Roblox accepted it (HTTP ${response.status}) but its answer could not be read (${why}). It happened: read it again to see the result`
      : response.status >= 500 && write
        ? `${request.what}: Roblox answered HTTP ${response.status} and its answer broke off (${why}). It may have happened: read it again before sending it a second time`
        : `${request.what}: the answer (HTTP ${response.status}) could not be read (${why})`);
  }
  // Only an error's body is read for its message: a success is parsed once, below
  const detail = response.ok ? "" : robloxMessage(text);
  if (response.status === 401) throw new RobloxError(`${request.what}: Roblox refused the key (HTTP 401${detail ? `: ${detail}` : ""}): it is wrong, expired or turned off. The user makes a new one at create.roblox.com/dashboard/credentials and saves it in Quack's Settings, Open Cloud`);
  if (response.status === 403) throw new RobloxError(`${request.what}: Roblox refused the key (HTTP 403${detail ? `: ${detail}` : ""}). It needs the permission ${request.permission} for this experience: the user adds it to the key at create.roblox.com/dashboard/credentials (Access Permissions)`);
  if (response.status === 404) throw new RobloxError(`${request.what}: not found (404${detail ? `: ${detail}` : ""})`);
  if (response.status === 429) {
    const after = Number(response.headers.get("retry-after"));
    throw new RobloxError(`${request.what}: Roblox's rate limit (HTTP 429), nothing was done${Number.isFinite(after) && after > 0 ? `; try again in ${after} s` : ""}${request.limitNote ? ` (${request.limitNote})` : ""}`);
  }
  if (response.status >= 500 && write) throw new RobloxError(`${request.what}: Roblox answered HTTP ${response.status}${detail ? ` (${detail})` : ""}. It may have happened: read it again before sending it a second time`);
  if (!response.ok) throw new RobloxError(`${request.what}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new RobloxError(write
      ? `${request.what}: Roblox accepted it (HTTP ${response.status}) but its answer is not JSON. It happened: read it again before sending it a second time`
      : `${request.what}: the answer is not JSON`);
  }
}

/** Roblox's error body as one short line (its message when it has one) */
function robloxMessage(text: string): string {
  if (!text.trim()) return "";
  try {
    const body = JSON.parse(text);
    const message = body?.message ?? body?.error?.message ?? body?.errors?.[0]?.message;
    const code = body?.code ?? body?.error?.status;
    if (typeof message === "string") return `${code ? `${code}: ` : ""}${message}`.slice(0, 300);
  } catch {
    // not JSON: the text itself
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

// ---------------------------------------------------------------------------------------
// Arguments: checked before the dialog opens and before anything goes into a URL

/** A whole id above 0, as a string (ids can pass 2^53 one day; these stay digits) */
export function idArg(raw: unknown, what: string): string {
  const s = typeof raw === "number" ? (Number.isSafeInteger(raw) ? String(raw) : "") : typeof raw === "string" ? raw.trim() : "";
  if (!/^[1-9]\d{0,18}$/.test(s)) throw new RobloxError(`${what} must be a whole number above 0`);
  return s;
}

export const universeArg = (args: Record<string, any>) => idArg(args.universeId, "universeId (the experience's id)");

/** A name Roblox keeps (a map, a queue, a store, an item): no control characters, a length cap */
export function nameArg(raw: unknown, what: string, max: number, inPath = true): string {
  if (typeof raw !== "string" || raw.length === 0) throw new RobloxError(`${what} is required`);
  if (raw.length > max) throw new RobloxError(`${what} is at most ${max} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new RobloxError(`${what} cannot hold control characters or line breaks`);
  // encodeURIComponent keeps "." and "..": in a URL they move the request to another path
  if (inPath && (raw === "." || raw === "..")) throw new RobloxError(`${what} cannot be "." or ".."`);
  return raw;
}

export function optionalText(raw: unknown, what: string, max: number): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new RobloxError(`${what} must be text`);
  if (raw.length > max) throw new RobloxError(`${what} is at most ${max} characters`);
  return raw;
}

export function boolArg(raw: unknown, what: string): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") throw new RobloxError(`${what} must be true or false`);
  return raw;
}

/** A whole number from min to max; undefined when left out */
/** Number("  ") is 0 and Number("0x10") is 16: a string must be written as a number to count as one */
const INT_TEXT = /^-?\d+$/;
// No two quantifiers side by side (a long wrong string backtracked in quadratic time), and a cap
const NUMBER_TEXT = /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
export const isIntText = (s: string) => s.length <= 40 && INT_TEXT.test(s);
export const isNumberText = (s: string) => s.length <= 40 && NUMBER_TEXT.test(s);

export function intArg(raw: unknown, what: string, min: number, max: number): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "string" ? (isIntText(raw) ? Number(raw) : NaN) : raw;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) throw new RobloxError(`${what} must be a whole number from ${min} to ${max}`);
  return n;
}

export function numberArg(raw: unknown, what: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "string" ? (isNumberText(raw) ? Number(raw) : NaN) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new RobloxError(`${what} must be a number`);
  return n;
}

export function pageSizeArg(raw: unknown, fallback: number): number {
  return intArg(raw, "limit", 1, 100) ?? fallback;
}

/** A page token from a page before: Roblox's own text, kept as is */
export function pageTokenArg(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 2000 || /\s/.test(raw)) throw new RobloxError("pageToken must be the nextPageToken a page gave");
  return raw;
}

/** Seconds as Roblox's duration text ("30s") */
export const seconds = (n: number) => `${n}s`;

/** "3600s" from Roblox back to seconds; undefined when it is not one */
export function durationSeconds(raw: unknown): number | undefined {
  const m = typeof raw === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(raw) : null;
  return m ? Number(m[1]) : undefined;
}

/** A length of time for a person: 90061 s is "1 d 1 h 1 min 1 s" */
export function humanDuration(totalSeconds: number): string {
  let s = Math.round(totalSeconds);
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86_400], ["h", 3600], ["min", 60]] as const) {
    if (s >= size) {
      parts.push(`${Math.floor(s / size)} ${unit}`);
      s %= size;
    }
  }
  if (s || !parts.length) parts.push(`${s} s`);
  return parts.join(" ");
}

/**
 * A value someone else wrote, as it shows in the dialog: quoted, one line, cut. Any program on
 * the computer can call the hub, so a value must never read as the dialog's own words.
 */
export function quoted(value: unknown, max = 200): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  // Line breaks of any kind, control characters and direction marks (U+202E turns the rest of a
  // line around) all become spaces: the value keeps no power over how the dialog reads
  // eslint-disable-next-line no-control-regex
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/"/g, "'");
  return `"${line.length > max ? `${line.slice(0, max)}...` : line}"${line.length > max ? ` (${text.length} characters, cut here)` : ""}`;
}

export const enc = encodeURIComponent;

export const universeUrl = (universeId: string) => `${CLOUD_V2}/universes/${universeId}`;

/** A key for Roblox's idempotency fields: a retry of the same write never applies twice */
export function idempotency(ctx: CloudContext): { key: string; firstSent: string } {
  return { key: randomBytes(16).toString("hex"), firstSent: new Date(ctx.env.now()).toISOString().replace(/\.\d+Z$/, "Z") };
}

/**
 * The experience by name for the dialog: the user tells the live game from its test copy by
 * name, never by id. A name that cannot be read still lets the dialog open, saying why.
 */
export async function universeLabel(ctx: CloudContext, universeId: string): Promise<{ short: string; long: string; universe?: Record<string, any> }> {
  try {
    const u = await cloudRequest(ctx.env, { method: "GET", url: universeUrl(universeId), permission: "universe:read", what: `experience ${universeId}` });
    const name = typeof u?.displayName === "string" && u.displayName ? u.displayName : undefined;
    const visibility = u?.visibility === "PUBLIC" ? "public" : u?.visibility === "PRIVATE" ? "private" : undefined;
    if (!name) return { short: `experience ${universeId}`, long: `experience ${universeId}`, universe: u };
    return { short: quoted(name, 60), long: `${quoted(name, 80)} (experience ${universeId}${visibility ? `, ${visibility}` : ""})`, universe: u };
  } catch (error) {
    return { short: `experience ${universeId}`, long: `experience ${universeId} (its name could not be read: ${(error as Error).message.slice(0, 160)})` };
  }
}

/** A Roblox user by name for the dialog (the public users API, no key) */
export async function userLabel(env: RobloxEnv, userId: string): Promise<string> {
  try {
    const response = await env.fetch(`https://users.roblox.com/v1/users/${userId}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return `user ${userId}${response.status === 404 ? " (no such user on Roblox)" : ""}`;
    const body = await response.json() as any;
    const name = typeof body?.name === "string" ? body.name : undefined;
    const display = typeof body?.displayName === "string" && body.displayName !== name ? body.displayName : undefined;
    return name ? `user ${userId} (${quoted(name, 40)}${display ? `, shown as ${quoted(display, 40)}` : ""})` : `user ${userId}`;
  } catch {
    return `user ${userId}`;
  }
}
