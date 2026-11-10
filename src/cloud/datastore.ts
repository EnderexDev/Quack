import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RobloxError } from "../control/roblox.js";
import { changesForDialog, cloudRequest, nameArg, wholeId } from "./http.js";
import type { CloudContext, CloudOp } from "./ops.js";

/**
 * A live game's standard DataStores through Open Cloud (v1, the API profile-read.mjs measured on
 * Anime Astral's production saves): list stores and keys, read an entry (or only some of its
 * fields) and its versions. Reading is free; saving, incrementing and deleting are writes (Ender,
 * 09/11/26: only when the user asks, and the hub's dialog shows what changes, field by field).
 * A save carries the version the user saw (matchVersion): a game save in between makes Roblox
 * refuse instead of overwriting it.
 */

const base = (universeId: number) => `https://apis.roblox.com/datastores/v1/universes/${universeId}/standard-datastores`;
const READ = "universe-datastores.objects:read (list for listing)";
const VERSIONS = "universe-datastores.versions:list and :read";
const WRITE_UPDATE = "universe-datastores.objects:update (and :create for a new key)";
const WRITE_DELETE = "universe-datastores.objects:delete";

/** The text a value may be in an answer: past this it goes to a file */
const INLINE_MAX_CHARS = 40_000;

interface EntryRef {
  universeId: number;
  store: string;
  key: string;
  scope: string;
}

function entryRef(a: Record<string, any>): EntryRef {
  return {
    universeId: wholeId(a.universeId, "universeId"),
    store: nameArg(a.store, "store (the DataStore's name)", 50),
    key: nameArg(a.key, "key (the entry's key)", 50),
    scope: a.scope === undefined || a.scope === null || a.scope === "" ? "global" : nameArg(a.scope, "scope", 50),
  };
}

const entryQuery = (r: EntryRef) => `datastoreName=${encodeURIComponent(r.store)}&entryKey=${encodeURIComponent(r.key)}&scope=${encodeURIComponent(r.scope)}`;
const label = (r: EntryRef) => `${r.store}/${r.key}${r.scope !== "global" ? ` (scope ${r.scope})` : ""} in experience ${r.universeId}`;

/** The value at a dot path (a.b.c; array items by number) */
function pick(value: unknown, dotted: string): unknown {
  let node: any = value;
  for (const part of dotted.split(".")) {
    if (node === null || node === undefined) return undefined;
    node = node[part];
  }
  return node;
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The entry as it is now: value, version, times, attributes, user ids; undefined when there is none */
async function readEntry(ctx: CloudContext, r: EntryRef, versionId?: string) {
  const url = versionId
    ? `${base(r.universeId)}/datastore/entries/entry/versions/version?${entryQuery(r)}&versionId=${encodeURIComponent(versionId)}`
    : `${base(r.universeId)}/datastore/entries/entry?${entryQuery(r)}`;
  const answer = await cloudRequest(ctx.env, { url, what: `the entry ${label(r)}`, permission: versionId ? VERSIONS : READ, allow404: true });
  if (answer.status === 404) return undefined;
  const header = (name: string) => answer.headers.get(name) ?? undefined;
  let attributes: unknown;
  try {
    attributes = header("roblox-entry-attributes") ? JSON.parse(header("roblox-entry-attributes")!) : undefined;
  } catch {
    attributes = header("roblox-entry-attributes");
  }
  let userIds: unknown;
  try {
    userIds = header("roblox-entry-userids") ? JSON.parse(header("roblox-entry-userids")!) : undefined;
  } catch {
    userIds = header("roblox-entry-userids");
  }
  return {
    value: parseValue(answer.text),
    bytes: Buffer.byteLength(answer.text),
    version: header("roblox-entry-version") ?? versionId,
    createdTime: header("roblox-entry-created-time"),
    versionCreatedTime: header("roblox-entry-version-created-time"),
    attributes,
    userIds,
  };
}

/** The value as an answer: whole, a few fields, or (big) saved to a file */
function shape(ctx: CloudContext, r: EntryRef, entry: NonNullable<Awaited<ReturnType<typeof readEntry>>>, a: Record<string, any>) {
  const fields: string[] = Array.isArray(a.fields) ? a.fields.map(String) : typeof a.fields === "string" && a.fields ? a.fields.split(",").map((f: string) => f.trim()).filter(Boolean) : [];
  const { value, ...meta } = entry;
  if (fields.length) {
    const picked: Record<string, unknown> = {};
    for (const f of fields) picked[f] = pick(value, f);
    return { ...meta, fields: picked };
  }
  const text = JSON.stringify(value, null, 2) ?? "";
  if (typeof a.out === "string" && a.out) {
    // A new .json file only: a read never replaces a file that is there
    if (!path.isAbsolute(a.out) || !/\.json$/i.test(a.out)) throw new RobloxError("out must be the absolute path of a .json file");
    fs.mkdirSync(path.dirname(a.out), { recursive: true });
    try {
      fs.writeFileSync(a.out, text, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RobloxError(`${a.out} already exists: give a new file`);
      throw error;
    }
    return { ...meta, file: a.out };
  }
  if (text.length > INLINE_MAX_CHARS) {
    const file = path.join(ctx.env.dataDir, "datastore", `${r.store}-${r.key}-${new Date(ctx.env.now()).toISOString().replace(/[:.]/g, "-")}.json`.replace(/[^\w.-]+/g, "_"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    const topLevel = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as object).slice(0, 60) : undefined;
    return { ...meta, file, topLevelKeys: topLevel, note: `${text.length} characters: saved to the file; fields picks a few` };
  }
  return { ...meta, value };
}

const limitArg = (raw: unknown, fallback: number, max: number) => {
  if (raw === undefined || raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new RobloxError(`limit must be from 1 to ${max}`);
  return n;
};

/** The value a save sends: JSON text from the caller (a string that is not JSON is a string value) */
function newValue(a: Record<string, any>): unknown {
  if (a.value === undefined) throw new RobloxError("value is required: the entry's new value, as JSON");
  if (typeof a.value === "string") {
    try {
      return JSON.parse(a.value);
    } catch {
      return a.value;
    }
  }
  return a.value;
}

export const datastoreOps: Record<string, CloudOp> = {
  dsStores: {
    write: false,
    run: async (ctx, a) => {
      const universeId = wholeId(a.universeId, "universeId");
      const url = new URL(base(universeId));
      url.searchParams.set("limit", String(limitArg(a.limit, 50, 100)));
      if (typeof a.prefix === "string" && a.prefix) url.searchParams.set("prefix", a.prefix);
      if (typeof a.cursor === "string" && a.cursor) url.searchParams.set("cursor", a.cursor);
      const { json } = await cloudRequest(ctx.env, { url: url.toString(), what: `the DataStores of experience ${universeId}`, permission: "universe-datastores.objects:list" });
      return { universeId, stores: (json?.datastores ?? []).map((d: any) => ({ name: d.name, createdTime: d.createdTime })), ...(json?.nextPageCursor ? { cursor: json.nextPageCursor } : {}) };
    },
  },
  dsKeys: {
    write: false,
    run: async (ctx, a) => {
      const universeId = wholeId(a.universeId, "universeId");
      const store = nameArg(a.store, "store", 50);
      const url = new URL(`${base(universeId)}/datastore/entries`);
      url.searchParams.set("datastoreName", store);
      url.searchParams.set("limit", String(limitArg(a.limit, 50, 1000)));
      if (a.allScopes === true) url.searchParams.set("allScopes", "true");
      else url.searchParams.set("scope", typeof a.scope === "string" && a.scope ? a.scope : "global");
      if (typeof a.prefix === "string" && a.prefix) url.searchParams.set("prefix", a.prefix);
      if (typeof a.cursor === "string" && a.cursor) url.searchParams.set("cursor", a.cursor);
      const { json } = await cloudRequest(ctx.env, { url: url.toString(), what: `the keys of ${store}`, permission: "universe-datastores.objects:list" });
      return { universeId, store, keys: (json?.keys ?? []).map((k: any) => (k.scope && k.scope !== "global" ? `${k.scope}/${k.key}` : k.key)), ...(json?.nextPageCursor ? { cursor: json.nextPageCursor } : {}) };
    },
  },
  dsGet: {
    write: false,
    run: async (ctx, a) => {
      const r = entryRef(a);
      const entry = await readEntry(ctx, r, typeof a.version === "string" && a.version ? a.version : undefined);
      if (!entry) return { ...r, exists: false };
      return { ...r, exists: true, ...shape(ctx, r, entry, a) };
    },
  },
  dsVersions: {
    write: false,
    run: async (ctx, a) => {
      const r = entryRef(a);
      const url = new URL(`${base(r.universeId)}/datastore/entries/entry/versions`);
      url.search = entryQuery(r);
      url.searchParams.set("limit", String(limitArg(a.limit, 20, 100)));
      url.searchParams.set("sortOrder", a.oldestFirst === true ? "Ascending" : "Descending");
      for (const [arg, param] of [["start", "startTime"], ["end", "endTime"]] as const) {
        if (a[arg] === undefined) continue;
        if (typeof a[arg] !== "string" || Number.isNaN(Date.parse(a[arg]))) throw new RobloxError(`${arg} must be a date and time (ISO, like 2026-11-09T12:00:00Z)`);
        url.searchParams.set(param, new Date(a[arg]).toISOString());
      }
      if (typeof a.cursor === "string" && a.cursor) url.searchParams.set("cursor", a.cursor);
      const { json } = await cloudRequest(ctx.env, { url: url.toString(), what: `the versions of ${label(r)}`, permission: VERSIONS });
      return {
        ...r,
        versions: (json?.versions ?? []).map((v: any) => ({ version: v.version, createdTime: v.createdTime, objectCreatedTime: v.objectCreatedTime, contentLength: v.contentLength, deleted: v.deleted || undefined })),
        ...(json?.nextPageCursor ? { cursor: json.nextPageCursor } : {}),
      };
    },
  },
  dsSet: {
    write: true,
    describe: async (a, ctx) => {
      const r = entryRef(a);
      const value = newValue(a);
      const now = await readEntry(ctx, r);
      // A v1 save replaces the entry's attributes and user ids too: the ones there are sent again
      // unless the caller gives new ones, and the window says which
      const attributes = a.attributes !== undefined ? a.attributes : (now?.attributes ?? undefined);
      const userIds = Array.isArray(a.userIds) ? a.userIds.map(Number) : (Array.isArray(now?.userIds) ? now.userIds : undefined);
      const meta = [
        a.attributes !== undefined ? `Its attributes become: ${JSON.stringify(a.attributes)} (now ${JSON.stringify(now?.attributes ?? null)})` : `Its attributes stay: ${JSON.stringify(attributes ?? null)}`,
        Array.isArray(a.userIds) ? `Its user ids become: ${JSON.stringify(userIds)} (now ${JSON.stringify(now?.userIds ?? null)})` : `Its user ids stay: ${JSON.stringify(userIds ?? null)}`,
      ];
      const text = [
        `Save the DataStore entry ${label(r)}?`,
        now ? `It exists now (version ${now.version}, ${now.bytes} bytes, saved ${now.versionCreatedTime ?? "?"}).` : "It does not exist yet: this creates it.",
        changesForDialog(now?.value, value),
        ...meta,
        "This is the live game's data: a player's save is replaced as written.",
      ].join("\n");
      return { title: `Quack: save DataStore ${r.store}`, text, with: { matchVersion: now?.version ?? null, exclusiveCreate: !now, attributes, userIds } };
    },
    run: async (ctx, a) => {
      const r = entryRef(a);
      const body = JSON.stringify(newValue(a));
      const url = new URL(`${base(r.universeId)}/datastore/entries/entry`);
      url.search = entryQuery(r);
      if (typeof a.matchVersion === "string" && a.matchVersion) url.searchParams.set("matchVersion", a.matchVersion);
      if (a.exclusiveCreate === true) url.searchParams.set("exclusiveCreate", "true");
      const headers: Record<string, string> = { "content-md5": createHash("md5").update(body).digest("base64") };
      if (a.attributes !== undefined) headers["roblox-entry-attributes"] = JSON.stringify(a.attributes);
      if (Array.isArray(a.userIds)) headers["roblox-entry-userids"] = JSON.stringify(a.userIds.map(Number));
      try {
        const { json } = await cloudRequest(ctx.env, { method: "POST", url: url.toString(), what: `saving ${label(r)}`, permission: WRITE_UPDATE, body, headers });
        return { ...r, saved: true, version: json?.version, bytes: Buffer.byteLength(body) };
      } catch (error) {
        if (/HTTP 412/.test((error as Error).message)) throw new RobloxError(`${label(r)} changed after the user approved (the game saved it in between): nothing was written; read it again and ask again`);
        throw error;
      }
    },
  },
  dsIncrement: {
    write: true,
    describe: async (a, ctx) => {
      const r = entryRef(a);
      const by = Number(a.by);
      if (!Number.isInteger(by) || by === 0) throw new RobloxError("by must be a whole number other than 0");
      const now = await readEntry(ctx, r);
      return { title: `Quack: increment DataStore ${r.store}`, text: `Add ${by} to the DataStore entry ${label(r)}?\nIt is ${now ? JSON.stringify(now.value).slice(0, 60) : "missing (it starts at 0)"} now: it becomes ${typeof now?.value === "number" ? now.value + by : by}.\nThis is the live game's data.` };
    },
    run: async (ctx, a) => {
      const r = entryRef(a);
      const url = new URL(`${base(r.universeId)}/datastore/entries/entry/increment`);
      url.search = entryQuery(r);
      url.searchParams.set("incrementBy", String(Number(a.by)));
      const answer = await cloudRequest(ctx.env, { method: "POST", url: url.toString(), what: `incrementing ${label(r)}`, permission: WRITE_UPDATE, body: "" });
      return { ...r, value: parseValue(answer.text), version: answer.headers.get("roblox-entry-version") ?? undefined };
    },
  },
  dsDelete: {
    write: true,
    describe: async (a, ctx) => {
      const r = entryRef(a);
      const now = await readEntry(ctx, r);
      if (!now) throw new RobloxError(`${label(r)} does not exist: nothing to delete`);
      return {
        title: `Quack: DELETE DataStore entry ${r.store}`,
        text: `Delete the DataStore entry ${label(r)} (version ${now.version}, ${now.bytes} bytes)?\nRoblox keeps its versions for 30 days, so it can be read back from them, but the game sees it as gone at once.`,
        with: { seenVersion: now.version },
      };
    },
    run: async (ctx, a) => {
      const r = entryRef(a);
      // The delete takes no version, so the one the user saw is checked right before it
      const now = await readEntry(ctx, r);
      if (!now) return { ...r, deleted: false, note: "it was already gone" };
      if (typeof a.seenVersion === "string" && now.version !== a.seenVersion) {
        throw new RobloxError(`${label(r)} changed after the user approved (version ${a.seenVersion} then, ${now.version} now: the game saved it): nothing was deleted; ask again`);
      }
      const url = new URL(`${base(r.universeId)}/datastore/entries/entry`);
      url.search = entryQuery(r);
      await cloudRequest(ctx.env, { method: "DELETE", url: url.toString(), what: `deleting ${label(r)}`, permission: WRITE_DELETE });
      return { ...r, deleted: true };
    },
  },
};
