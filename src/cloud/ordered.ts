import { RobloxError } from "../control/roblox.js";
import { boolArg, cloudRequest, enc, intArg, nameArg, pageSizeArg, pageTokenArg, quoted, universeArg, universeLabel, universeUrl } from "./live-http.js";
import type { CloudContext, CloudOp } from "./ops.js";

/**
 * A live game's ordered data stores (its leaderboards), Open Cloud v2: entries listed by value,
 * read, created, set, incremented and deleted. Values are whole numbers. Each change is a write
 * the user approves, its dialog showing the value now and the value after.
 */

const NAME_MAX = 50;
const ENTRY_MAX = 63;

const READ = "universe.ordered-data-store.scope.entry:read";
const WRITE = "universe.ordered-data-store.scope.entry:write";

function storeArgs(args: Record<string, any>) {
  return {
    universeId: universeArg(args),
    store: nameArg(args.store, "store (the ordered data store's name)", NAME_MAX),
    scope: args.scope === undefined || args.scope === null || args.scope === "" ? "global" : nameArg(args.scope, "scope", NAME_MAX),
  };
}

const entryArgs = (args: Record<string, any>) => ({ ...storeArgs(args), entry: nameArg(args.entry, "entry (the entry's key, often a user id)", ENTRY_MAX) });

const entriesUrl = (s: { universeId: string; store: string; scope: string }) =>
  `${universeUrl(s.universeId)}/ordered-data-stores/${enc(s.store)}/scopes/${enc(s.scope)}/entries`;
const entryUrl = (e: { universeId: string; store: string; scope: string; entry: string }) => `${entriesUrl(e)}/${enc(e.entry)}`;

const wholeValue = (raw: unknown, what: string) => {
  const n = intArg(raw, what, -(2 ** 53 - 1), 2 ** 53 - 1);
  if (n === undefined) throw new RobloxError(`${what} is required: a whole number`);
  return n;
};

const where = (e: { store: string; scope: string; entry?: string }) =>
  `${e.entry !== undefined ? `the entry ${quoted(e.entry, 63)} of ` : ""}the ordered data store ${quoted(e.store, 50)}${e.scope !== "global" ? ` (scope ${quoted(e.scope, 50)})` : ""}`;

/** The entry's value now: a number, null when there is none, or why it could not be read */
async function valueNow(ctx: CloudContext, e: ReturnType<typeof entryArgs>): Promise<number | null | string> {
  try {
    const now = await cloudRequest(ctx.env, { method: "GET", url: entryUrl(e), permission: READ, what: "the entry" });
    return typeof now?.value === "number" ? now.value : Number(now?.value);
  } catch (error) {
    return /not found/.test((error as Error).message) ? null : `could not be read (${(error as Error).message.slice(0, 160)})`;
  }
}

const nowText = (v: number | null | string) => (v === null ? "no entry yet" : String(v));

async function question(ctx: CloudContext, e: ReturnType<typeof entryArgs>, verb: string, title: string, after: (now: number | null | string) => string, warning: string) {
  const label = await universeLabel(ctx, e.universeId);
  const now = await valueNow(ctx, e);
  return {
    title: `Quack: ${title} of ${label.short}`,
    text: [`${verb} ${where(e)} of ${label.long} (the live game's leaderboard data).`, `Now: ${nowText(now)}`, `After: ${after(now)}`, "", warning, "", "Allow it?"].join("\n"),
  };
}

export const ORDERED_OPS: Record<string, CloudOp> = {
  leaderboardList: {
    write: false,
    run: async (ctx, args) => {
      const s = storeArgs(args);
      const url = new URL(entriesUrl(s));
      url.searchParams.set("maxPageSize", String(pageSizeArg(args.limit, 20)));
      const token = pageTokenArg(args.pageToken);
      if (token) url.searchParams.set("pageToken", token);
      url.searchParams.set("orderBy", args.ascending === true ? "value" : "value desc");
      const min = intArg(args.min, "min", -(2 ** 53 - 1), 2 ** 53 - 1);
      const max = intArg(args.max, "max", -(2 ** 53 - 1), 2 ** 53 - 1);
      const filter = [min !== undefined ? `entry >= ${min}` : "", max !== undefined ? `entry <= ${max}` : ""].filter(Boolean).join(" && ");
      if (filter) url.searchParams.set("filter", filter);
      const body = await cloudRequest(ctx.env, { method: "GET", url: url.toString(), permission: READ, what: `${where(s)} of experience ${s.universeId}` });
      const entries = (Array.isArray(body?.orderedDataStoreEntries) ? body.orderedDataStoreEntries : []).map((e: any) => ({ entry: String(e?.id ?? String(e?.path ?? "").split("/").pop()), value: Number(e?.value) }));
      return { universeId: s.universeId, store: s.store, scope: s.scope, entries, ...(body?.nextPageToken ? { nextPageToken: String(body.nextPageToken) } : {}) };
    },
  },
  leaderboardGet: {
    write: false,
    run: async (ctx, args) => {
      const e = entryArgs(args);
      const body = await cloudRequest(ctx.env, { method: "GET", url: entryUrl(e), permission: READ, what: `${where(e)} of experience ${e.universeId}` });
      return { universeId: e.universeId, store: e.store, scope: e.scope, entry: e.entry, value: Number(body?.value) };
    },
  },
  leaderboardCreate: {
    write: true,
    describe: async (args, ctx) => {
      const e = entryArgs(args);
      const value = wholeValue(args.value, "value");
      return question(ctx, e, "Create", "create a leaderboard entry", () => String(value), "Roblox refuses it if the entry already exists.");
    },
    run: async (ctx, args) => {
      const e = entryArgs(args);
      const value = wholeValue(args.value, "value");
      const url = new URL(entriesUrl(e));
      url.searchParams.set("id", e.entry);
      const body = await cloudRequest(ctx.env, { method: "POST", url: url.toString(), body: { value }, permission: WRITE, what: `the new ${where(e)}` });
      return { universeId: e.universeId, store: e.store, scope: e.scope, entry: e.entry, value: Number(body?.value ?? value) };
    },
  },
  leaderboardUpdate: {
    write: true,
    describe: async (args, ctx) => {
      const e = entryArgs(args);
      const value = wholeValue(args.value, "value");
      const allowMissing = boolArg(args.allowMissing, "allowMissing") ?? false;
      return question(ctx, e, "Set", "set a leaderboard entry", () => `${value}${allowMissing ? " (created if missing)" : ""}`, "The old value is gone after this.");
    },
    run: async (ctx, args) => {
      const e = entryArgs(args);
      const value = wholeValue(args.value, "value");
      const url = new URL(entryUrl(e));
      if (boolArg(args.allowMissing, "allowMissing")) url.searchParams.set("allowMissing", "true");
      const body = await cloudRequest(ctx.env, { method: "PATCH", url: url.toString(), body: { value }, permission: WRITE, what: where(e) });
      return { universeId: e.universeId, store: e.store, scope: e.scope, entry: e.entry, value: Number(body?.value ?? value) };
    },
  },
  leaderboardIncrement: {
    write: true,
    describe: async (args, ctx) => {
      const e = entryArgs(args);
      const amount = wholeValue(args.amount, "amount");
      return question(ctx, e, `Add ${amount} to`, "change a leaderboard entry", (now) => (typeof now === "number" ? String(now + amount) : now === null ? `${amount} (a new entry)` : `the value now plus ${amount}`), "A game server writing the same entry at the same time adds on top of this.");
    },
    run: async (ctx, args) => {
      const e = entryArgs(args);
      const amount = wholeValue(args.amount, "amount");
      const body = await cloudRequest(ctx.env, { method: "POST", url: `${entryUrl(e)}:increment`, body: { amount }, permission: WRITE, what: `the increment of ${where(e)}` });
      return { universeId: e.universeId, store: e.store, scope: e.scope, entry: e.entry, value: Number(body?.value) };
    },
  },
  leaderboardDelete: {
    write: true,
    describe: async (args, ctx) => question(ctx, entryArgs(args), "DELETE", "delete a leaderboard entry", () => "no entry", "It cannot be brought back."),
    run: async (ctx, args) => {
      const e = entryArgs(args);
      await cloudRequest(ctx.env, { method: "DELETE", url: entryUrl(e), permission: WRITE, what: where(e) });
      return { universeId: e.universeId, store: e.store, scope: e.scope, entry: e.entry, deleted: true };
    },
  },
};
