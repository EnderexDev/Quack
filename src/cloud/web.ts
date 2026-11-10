import fs from "node:fs";
import path from "node:path";
import { resolveKey, RobloxError, type RobloxEnv } from "../control/roblox.js";

/**
 * The requests behind the named Open Cloud operations (economy.ts, localization.ts,
 * analytics.ts), ported from ~/.claude/scripts/roblox-cloud.mjs. The key comes from
 * resolveKey (the hub's vault) and every message is scrubbed of it.
 *
 * Retries: a 429 is a refusal before anything ran, so it is waited out (Roblox's retry-after, or
 * 15 s as the script did, at most 8 times). A 5xx is sent again only for `idempotent` calls (the
 * localization table: writing the same entries twice is harmless; a PATCH there came back 504
 * with part of it applied, 15/10/2026). A badge, a product or a pass is never sent twice: a 5xx
 * or a dropped connection there may still have made it.
 */

const READ_TIMEOUT_MS = 30_000;
/** A write is never cut short by us before Roblox answers: an abort is how duplicates are made */
const WRITE_TIMEOUT_MS = 180_000;
const RETRY_WAIT_MS = 15_000;
const RETRIES = 8;

export interface CloudRequest {
  method: "GET" | "POST" | "PATCH";
  url: string;
  /** JSON (any value) or a multipart form */
  body?: unknown;
  /** The key's permission, named in the message of a 401 or 403 */
  permission: string;
  /** What the request is, for messages: "the badges of universe 5" */
  what: string;
  /** Safe to send again after a 5xx (the same result twice) */
  idempotent?: boolean;
  /** Public endpoints (games, badges) take no key */
  auth?: boolean;
}

export async function cloudRequest(env: RobloxEnv, request: CloudRequest): Promise<any> {
  const auth = request.auth !== false;
  const { key, scrub } = auth ? await resolveKey(env, request.permission) : { key: "", scrub: (t: string) => t };
  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth) headers["x-api-key"] = key;
  let body: any = request.body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const write = request.method !== "GET" && !request.idempotent;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await env.fetch(request.url, { method: request.method, headers, body, signal: AbortSignal.timeout(request.method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS) });
    } catch (error) {
      const e = error as Error;
      const why = scrub(e.name === "TimeoutError" ? "no answer in time" : (e.cause as Error)?.message ?? e.message);
      if (request.idempotent && attempt < RETRIES) {
        await env.sleep(RETRY_WAIT_MS);
        continue;
      }
      throw new RobloxError(`${request.what}: Roblox did not answer (${why})${write ? ". It may still have been done: read it back (list) before sending it again" : ""}`);
    }
    let text: string;
    try {
      text = scrub(await response.text());
    } catch (error) {
      // Headers came and the body did not: the write may have run; a read or an idempotent call is asked again
      if (request.idempotent && attempt < RETRIES) {
        await env.sleep(RETRY_WAIT_MS);
        continue;
      }
      throw new RobloxError(`${request.what}: Roblox's answer (HTTP ${response.status}) was cut off (${scrub((error as Error).message)})${write ? ". It may still have been done: read it back (list) before sending it again" : ""}`);
    }
    const retry = response.status === 429 || (request.idempotent === true && response.status >= 500);
    if (retry && attempt < RETRIES) {
      const after = Number(response.headers.get("retry-after"));
      await env.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : RETRY_WAIT_MS);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new RobloxError(`${request.what}: Roblox refused the key (HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}). It needs ${request.permission}, for the experience named`);
    }
    if (response.status === 404) throw new RobloxError(`${request.what}: not found (404)${text ? ` ${text.slice(0, 200)}` : ""}`);
    if (!response.ok) {
      const maybe = write && response.status >= 500 ? ". It may still have been done: read it back (list) before sending it again" : "";
      throw new RobloxError(`${request.what}: HTTP ${response.status} ${text.slice(0, 400)}${maybe}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      // A few endpoints answer a bare value (the badge quota is a number)
      return text;
    }
  }
}

/** A whole number id from the caller: never a path or a query in a URL */
export function idArg(raw: unknown, what: string): string {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s) || Number(s) <= 0) throw new RobloxError(`${what} must be a whole number above 0`);
  return s;
}

/** Badge icons and product or pass images are small; a bigger file is a wrong path, not an image */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Strings, translations and query files: 10,000 entries in 17 languages fit many times over */
export const MAX_JSON_BYTES = 64 * 1024 * 1024;

/** Most pages one listing reads: a table of 10,000 entries is 100 pages */
const MAX_PAGES = 1000;

/**
 * Reads every page of a listing: `page` asks one by its cursor ("" first) and answers its items
 * and the next cursor. A cursor Roblox gives twice, or more pages than any listing has, stops it
 * instead of asking forever.
 */
export async function allPages<T>(what: string, page: (cursor: string) => Promise<{ items: T[]; next: string }>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor = "";
  for (let n = 0; ; n++) {
    if (n >= MAX_PAGES) throw new RobloxError(`${what}: more than ${MAX_PAGES} pages, stopped`);
    const answer = await page(cursor);
    items.push(...answer.items);
    if (!answer.next) return items;
    if (seen.has(answer.next)) throw new RobloxError(`${what}: Roblox gave the same page cursor twice, stopped`);
    seen.add(answer.next);
    cursor = answer.next;
  }
}

/** An absolute path the hub reads (the CLI resolves it); its bytes and type */
export function readImage(file: unknown, what: string): { blob: Blob; name: string } {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new RobloxError(`${what} must be an absolute path`);
  const lower = file.toLowerCase();
  const type = lower.endsWith(".png") ? "image/png" : lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg" : "";
  if (!type) throw new RobloxError(`${what} must be a .png or .jpg file`);
  let bytes: Buffer;
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_IMAGE_BYTES) throw new RobloxError(`${file} is ${Math.round(size / 1024 / 1024)} MB: an image here is at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error instanceof RobloxError) throw error;
    throw new RobloxError(`cannot read ${file}: ${(error as Error).message}`);
  }
  return { blob: new Blob([new Uint8Array(bytes)], { type }), name: path.basename(file) };
}

/** A JSON file the hub reads, from an absolute path */
export function readJsonFile(file: unknown, what: string): unknown {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new RobloxError(`${what} must be an absolute path`);
  let text: string;
  try {
    // The hub reads it in one go: a file far past any table (10,000 entries) is a wrong path
    const size = fs.statSync(file).size;
    if (size > MAX_JSON_BYTES) throw new RobloxError(`${file} is ${Math.round(size / 1024 / 1024)} MB: a file here is at most ${MAX_JSON_BYTES / 1024 / 1024} MB`);
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof RobloxError) throw error;
    throw new RobloxError(`cannot read ${file}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new RobloxError(`${file} is not JSON: ${(error as Error).message}`);
  }
}

export interface Universe {
  universeId: string;
  name: string;
  rootPlaceId?: number;
  creator: { type: string; name: string; id: number };
}

/** The public facts of a universe (no key): its game's name, root place and owner */
export async function universeInfo(env: RobloxEnv, raw: unknown): Promise<Universe> {
  const universeId = idArg(raw, "the universe id");
  const data = await cloudRequest(env, { method: "GET", url: `https://games.roblox.com/v1/games?universeIds=${universeId}`, permission: "none", what: `universe ${universeId}`, auth: false });
  const game = data?.data?.[0];
  if (!game) throw new RobloxError(`universe ${universeId} not found (a universe id, not a place id: Studio's game.GameId, or the number in the Creator Hub's experience URL)`);
  return { universeId, name: String(game.name ?? ""), rootPlaceId: game.rootPlaceId, creator: { type: String(game.creator?.type ?? ""), name: String(game.creator?.name ?? ""), id: Number(game.creator?.id) } };
}

/**
 * The game's name the dialog showed, checked again before the write: the dialog's text comes
 * from the caller's arguments, so a name it could not prove would be a claim anyone can write.
 */
export async function checkUniverseName(env: RobloxEnv, args: Record<string, any>): Promise<Universe | undefined> {
  if (args.universeName === undefined) return undefined;
  const universe = await universeInfo(env, args.universeId);
  if (universe.name !== String(args.universeName)) {
    throw new RobloxError(`universe ${universe.universeId} is "${universe.name}", not "${args.universeName}" as the dialog said: nothing was changed`);
  }
  return universe;
}

/** "universe 123 ("Game")" when the name came with the arguments, else the id alone */
export function universeLabel(args: Record<string, any>): string {
  const id = String(args.universeId ?? "?");
  return args.universeName !== undefined ? `universe ${id} ("${args.universeName}")` : `universe ${id}`;
}
