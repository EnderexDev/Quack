import { RobloxError } from "../control/roblox.js";
import {
  boolArg, cloudRequest, enc, humanDuration, intArg, nameArg, numberArg, optionalText, pageSizeArg, pageTokenArg, quoted, seconds,
  universeArg, universeLabel, universeUrl,
} from "./live-http.js";
import type { CloudContext, CloudOp } from "./ops.js";

/**
 * A live game's MemoryStore (Open Cloud v2): sorted maps (list, get, create, update, delete),
 * queues (read, add, discard) and the flush of the whole store. Every change is a write the user
 * approves; so is a queue read, which hides the items it read from the game's own servers for
 * its invisibility window (items come back unless discarded).
 */

/** MemoryStore's own limits (cloud-services/memory-stores) */
const NAME_MAX = 128;
const ITEM_ID_MAX = 127;
const VALUE_MAX = 32 * 1024;
const TTL_MAX = 3_888_000;

const structure = (args: Record<string, any>, what: "map" | "queue") => ({
  universeId: universeArg(args),
  name: nameArg(args[what], what === "map" ? "map (the sorted map's name)" : "queue (the queue's name)", NAME_MAX),
});

const itemArg = (args: Record<string, any>) => nameArg(args.item, "item (the item's key)", ITEM_ID_MAX);

function valueArg(raw: unknown, what: string): unknown {
  if (raw === undefined) throw new RobloxError(`${what} is required (any JSON value)`);
  const text = JSON.stringify(raw);
  if (text === undefined) throw new RobloxError(`${what} must be a JSON value`);
  if (Buffer.byteLength(text) > VALUE_MAX) throw new RobloxError(`${what} is at most 32 KB as JSON (this one is ${Buffer.byteLength(text)} bytes)`);
  return raw;
}

const ttlArg = (raw: unknown, required: boolean) => {
  const ttl = intArg(raw, "ttlSeconds", 1, TTL_MAX);
  if (ttl === undefined && required) throw new RobloxError(`ttlSeconds is required: how long the item lives, 1 to ${TTL_MAX} (45 days)`);
  return ttl;
};

/** A sort key: a number sorts by number, text by text; never both */
function sortKey(args: Record<string, any>): { numericSortKey?: number; stringSortKey?: string } {
  if (args.numericSortKey !== undefined && args.stringSortKey !== undefined) throw new RobloxError("give numericSortKey or stringSortKey, not both");
  const n = numberArg(args.numericSortKey, "numericSortKey");
  if (n !== undefined) return { numericSortKey: n };
  const s = optionalText(args.stringSortKey, "stringSortKey", 128);
  return s !== undefined ? { stringSortKey: s } : {};
}

const mapUrl = (m: { universeId: string; name: string }) => `${universeUrl(m.universeId)}/memory-store/sorted-maps/${enc(m.name)}/items`;
const queueUrl = (q: { universeId: string; name: string }) => `${universeUrl(q.universeId)}/memory-store/queues/${enc(q.name)}/items`;

const itemRef = (args: Record<string, any>) => ({ ...structure(args, "map"), item: itemArg(args) });

const itemWrite = (args: Record<string, any>) => ({
  ...itemRef(args), value: valueArg(args.value, "value"), ttl: ttlArg(args.ttlSeconds, true)!, ...sortKey(args), allowMissing: boolArg(args.allowMissing, "allowMissing") ?? false,
});

/** The item as it is now, for the dialog (a missing item says so) */
async function itemNow(ctx: CloudContext, m: { universeId: string; name: string; item: string }): Promise<string> {
  try {
    const now = await cloudRequest(ctx.env, { method: "GET", url: `${mapUrl(m)}/${enc(m.item)}`, permission: "memory-store.sorted-map:read", what: "the item" });
    return `Now: ${quoted(now?.value, 300)}${now?.expireTime ? `, expires ${now.expireTime}` : ""}`;
  } catch (error) {
    return /not found/.test((error as Error).message) ? "Now: the item does not exist." : `Now: could not be read (${(error as Error).message.slice(0, 160)})`;
  }
}

const sortText = (k: { numericSortKey?: number; stringSortKey?: string }) =>
  k.numericSortKey !== undefined ? `, sort key ${k.numericSortKey}` : k.stringSortKey !== undefined ? `, sort key ${quoted(k.stringSortKey, 80)}` : "";

const readArgs = (args: Record<string, any>) => ({
  ...structure(args, "queue"),
  count: intArg(args.count, "count", 1, 200) ?? 1,
  invisibleSeconds: intArg(args.invisibleSeconds, "invisibleSeconds", 1, 3600) ?? 30,
  allOrNothing: boolArg(args.allOrNothing, "allOrNothing") ?? false,
});

const flushScope = (args: Record<string, any>) => {
  const scope = args.scope ?? "LIVE";
  if (scope !== "LIVE" && scope !== "TEST") throw new RobloxError("scope must be LIVE (the live game's servers) or TEST (Studio's)");
  return { universeId: universeArg(args), scope: scope as "LIVE" | "TEST" };
};

const FLUSH_POLLS = 10;

export const MEMORY_STORE_OPS: Record<string, CloudOp> = {
  sortedMapList: {
    write: false,
    run: async (ctx, args) => {
      const m = structure(args, "map");
      const url = new URL(mapUrl(m));
      url.searchParams.set("maxPageSize", String(pageSizeArg(args.limit, 20)));
      const token = pageTokenArg(args.pageToken);
      if (token) url.searchParams.set("pageToken", token);
      if (args.descending === true) url.searchParams.set("orderBy", "id desc");
      const filter = optionalText(args.filter, "filter", 500);
      if (filter) url.searchParams.set("filter", filter);
      const body = await cloudRequest(ctx.env, { method: "GET", url: url.toString(), permission: "memory-store.sorted-map:read", what: `the sorted map ${m.name} of experience ${m.universeId}` });
      return { universeId: m.universeId, map: m.name, items: Array.isArray(body?.items) ? body.items : [], ...(body?.nextPageToken ? { nextPageToken: String(body.nextPageToken) } : {}) };
    },
  },
  sortedMapGet: {
    write: false,
    run: async (ctx, args) => {
      const m = itemRef(args);
      return cloudRequest(ctx.env, { method: "GET", url: `${mapUrl(m)}/${enc(m.item)}`, permission: "memory-store.sorted-map:read", what: `the item ${m.item} of sorted map ${m.name} (experience ${m.universeId})` });
    },
  },
  sortedMapCreate: {
    write: true,
    describe: async (args, ctx) => {
      const m = itemWrite(args);
      const label = await universeLabel(ctx, m.universeId);
      return {
        title: `Quack: add an item to a sorted map of ${label.short}`,
        text: [`Create the item ${quoted(m.item, 127)} in the MemoryStore sorted map ${quoted(m.name, 128)} of ${label.long} (the LIVE game's store):`,
          `  value ${quoted(m.value, 300)}${sortText(m)}, lives ${humanDuration(m.ttl)}`, "", "The game's servers read it at once. Allow it?"].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const m = itemWrite(args);
      const url = new URL(mapUrl(m));
      url.searchParams.set("id", m.item);
      return cloudRequest(ctx.env, { method: "POST", url: url.toString(), body: { value: m.value, ttl: seconds(m.ttl), ...sortKey(args) }, permission: "memory-store.sorted-map:write", what: `the new item ${m.item} of sorted map ${m.name}` });
    },
  },
  sortedMapUpdate: {
    write: true,
    describe: async (args, ctx) => {
      const m = itemWrite(args);
      const label = await universeLabel(ctx, m.universeId);
      return {
        title: `Quack: change an item of a sorted map of ${label.short}`,
        text: [`Change the item ${quoted(m.item, 127)} of the MemoryStore sorted map ${quoted(m.name, 128)} of ${label.long} (the LIVE game's store)${m.allowMissing ? "; created if missing" : ""}.`,
          await itemNow(ctx, m), `New: ${quoted(m.value, 300)}${sortText(m)}, lives ${humanDuration(m.ttl)}`, "", "The old value is gone after this. Allow it?"].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const m = itemWrite(args);
      const url = new URL(`${mapUrl(m)}/${enc(m.item)}`);
      if (m.allowMissing) url.searchParams.set("allowMissing", "true");
      return cloudRequest(ctx.env, { method: "PATCH", url: url.toString(), body: { value: m.value, ttl: seconds(m.ttl), ...sortKey(args) }, permission: "memory-store.sorted-map:write", what: `the item ${m.item} of sorted map ${m.name}` });
    },
  },
  sortedMapDelete: {
    write: true,
    describe: async (args, ctx) => {
      const m = itemRef(args);
      const label = await universeLabel(ctx, m.universeId);
      return {
        title: `Quack: delete an item of a sorted map of ${label.short}`,
        text: [`DELETE the item ${quoted(m.item, 127)} of the MemoryStore sorted map ${quoted(m.name, 128)} of ${label.long} (the LIVE game's store).`,
          await itemNow(ctx, m), "", "It cannot be brought back. Allow it?"].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const m = itemRef(args);
      await cloudRequest(ctx.env, { method: "DELETE", url: `${mapUrl(m)}/${enc(m.item)}`, permission: "memory-store.sorted-map:write", what: `the item ${m.item} of sorted map ${m.name}` });
      return { universeId: m.universeId, map: m.name, item: m.item, deleted: true };
    },
  },
  queueRead: {
    write: true,
    describe: async (args, ctx) => {
      const q = readArgs(args);
      const label = await universeLabel(ctx, q.universeId);
      return {
        title: `Quack: read a queue of ${label.short}`,
        text: [`Read up to ${q.count} item${q.count > 1 ? "s" : ""} from the front of the MemoryStore queue ${quoted(q.name, 128)} of ${label.long} (the LIVE game's store).`,
          "", `A queue read takes the items for ${humanDuration(q.invisibleSeconds)}: the game's own servers do not see them in that time (a player waiting in that queue waits longer). They come back after it unless they are discarded.`,
          "", "Allow it?"].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const q = readArgs(args);
      const url = new URL(`${queueUrl(q)}:read`);
      url.searchParams.set("count", String(q.count));
      url.searchParams.set("invisibilityWindow", seconds(q.invisibleSeconds));
      if (q.allOrNothing) url.searchParams.set("allOrNothing", "true");
      const body = await cloudRequest(ctx.env, { method: "GET", url: url.toString(), permission: "memory-store.queue:dequeue", what: `the queue ${q.name} of experience ${q.universeId}`, sideEffect: true });
      return { universeId: q.universeId, queue: q.name, readId: body?.readId, items: Array.isArray(body?.items) ? body.items : [], invisibleSeconds: q.invisibleSeconds };
    },
  },
  queueAdd: {
    write: true,
    describe: async (args, ctx) => {
      const q = { ...structure(args, "queue"), value: valueArg(args.value, "value"), ttl: ttlArg(args.ttlSeconds, true)!, priority: numberArg(args.priority, "priority") };
      const label = await universeLabel(ctx, q.universeId);
      return {
        title: `Quack: add an item to a queue of ${label.short}`,
        text: [`Add to the MemoryStore queue ${quoted(q.name, 128)} of ${label.long} (the LIVE game's store):`,
          `  ${quoted(q.value, 300)}${q.priority !== undefined ? `, priority ${q.priority}` : ""}, lives ${humanDuration(q.ttl)}`, "", "The game's servers can take it at once. Allow it?"].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const q = { ...structure(args, "queue"), value: valueArg(args.value, "value"), ttl: ttlArg(args.ttlSeconds, true)!, priority: numberArg(args.priority, "priority") };
      return cloudRequest(ctx.env, {
        method: "POST", url: queueUrl(q), body: { data: q.value, ttl: seconds(q.ttl), ...(q.priority !== undefined ? { priority: q.priority } : {}) },
        permission: "memory-store.queue:add", what: `the new item of queue ${q.name}`,
      });
    },
  },
  queueDiscard: {
    write: true,
    describe: async (args, ctx) => {
      const q = { ...structure(args, "queue"), readId: nameArg(args.readId, "readId (from a queue read)", 200) };
      const label = await universeLabel(ctx, q.universeId);
      return {
        title: `Quack: discard items of a queue of ${label.short}`,
        text: [`DISCARD the items the read ${quoted(q.readId, 80)} took from the MemoryStore queue ${quoted(q.name, 128)} of ${label.long} (the LIVE game's store).`,
          "", "They leave the queue for good: the game's servers never get them. Allow it?"].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const q = { ...structure(args, "queue"), readId: nameArg(args.readId, "readId (from a queue read)", 200) };
      await cloudRequest(ctx.env, { method: "POST", url: `${queueUrl(q)}:discard`, body: { readId: q.readId }, permission: "memory-store.queue:discard", what: `the discard from queue ${q.name}` });
      return { universeId: q.universeId, queue: q.name, readId: q.readId, discarded: true };
    },
  },
  memoryStoreFlush: {
    write: true,
    describe: async (args, ctx) => {
      const f = flushScope(args);
      const label = await universeLabel(ctx, f.universeId);
      return {
        title: `Quack: ERASE the MemoryStore of ${label.short}`,
        text: [`ERASE EVERYTHING in the ${f.scope === "LIVE" ? "LIVE MemoryStore (what the running servers use)" : "TEST MemoryStore (Studio's)"} of ${label.long}: every sorted map, queue and hash map.`,
          "", f.scope === "LIVE" ? "Running servers lose what they keep there at once (matchmaking queues, live leaderboards, locks, server lists). It cannot be undone." : "Studio's test data only; the live game's store stays. It cannot be undone.",
          "", "Allow it?"].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const f = flushScope(args);
      const url = new URL(`${universeUrl(f.universeId)}/memory-store:flush`);
      url.searchParams.set("scope", f.scope);
      const operation = await cloudRequest(ctx.env, { method: "POST", url: url.toString(), permission: "memory-store:flush", what: `the flush of experience ${f.universeId}'s MemoryStore` });
      const opPath = typeof operation?.path === "string" ? operation.path.replace(/^\/+/, "") : "";
      if (operation?.error) throw new RobloxError(`the flush failed on Roblox: ${JSON.stringify(operation.error).slice(0, 300)}`);
      let done = operation?.done === true;
      let note: string | undefined;
      // Its path already starts with cloud/v2 (the spec says so): polled as given
      for (let i = 0; !done && opPath && /^cloud\/v2\/[\w\-/]+$/.test(opPath) && i < FLUSH_POLLS; i++) {
        await ctx.env.sleep(1000 + i * 500);
        try {
          const now = await cloudRequest(ctx.env, { method: "GET", url: `https://apis.roblox.com/${opPath}`, permission: "memory-store:flush", what: "the flush's progress" });
          done = now?.done === true;
          if (now?.error) throw new RobloxError(`the flush failed on Roblox: ${JSON.stringify(now.error).slice(0, 300)}`);
        } catch (error) {
          if (/the flush failed/.test((error as Error).message)) throw error;
          note = `its progress could not be read (${(error as Error).message.slice(0, 200)})`;
          break;
        }
      }
      return { universeId: f.universeId, scope: f.scope, operation: opPath || undefined, done, ...(done ? {} : { note: note ?? "Roblox is still flushing: the flush goes on by itself" }) };
    },
  },
};
