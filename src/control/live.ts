import { durationSeconds, humanDuration, isIntText, isNumberText } from "../cloud/live-http.js";
import { RobloxError, type RobloxEnv } from "./roblox.js";

/**
 * The live game's Open Cloud from the terminal: servers and settings, MessagingService,
 * MemoryStore, ordered data stores (leaderboards) and bans. Every one runs in the hub through a
 * named operation (src/cloud): the key never reaches this process, and each write waits for the
 * user's yes in the hub's own dialog. The experience comes from --universe, or from the place
 * (its id or a registered place's name; left out, the place whose folder this runs in).
 */

/** What these commands take from commands.ts (passed in: no import cycle) */
export interface LiveDeps {
  out: (line: string) => void;
  json: boolean;
  command: string;
  cloudCall: (op: string, args: Record<string, unknown>) => Promise<any>;
  placeId: (query: string | undefined) => Promise<string>;
  roblox: () => RobloxEnv;
}

export interface LiveOptions {
  universe?: string;
  places?: string;
  allVersions: boolean;
  bleed?: string;
  props?: string;
  message?: string;
  value?: string;
  amount?: string;
  ttl?: string;
  sortKey?: string;
  priority?: string;
  count?: string;
  invisible?: string;
  allOrNothing: boolean;
  test: boolean;
  descending: boolean;
  ascending: boolean;
  min?: string;
  max?: string;
  upsert: boolean;
  inPlace?: string;
  reason?: string;
  display?: string;
  keepAlts: boolean;
  scope?: string;
  user?: string;
  duration?: string;
  limit?: string;
  page?: string;
  filter?: string;
}

export class LiveUsage extends Error {}

export const LIVE_COMMANDS = ["universe", "servers", "message", "memory-store", "leaderboard", "ban"] as const;

export const LIVE_USAGE: Record<(typeof LIVE_COMMANDS)[number], string> = {
  universe: "universe [get] [place] [--universe <id>] | universe set [place] [--universe <id>] --props=<json>",
  servers: "servers restart [place] [--universe <id>] [--places <id>,<id>] [--all-versions] [--bleed <minutes>]",
  message: "message publish <topic> [place] [--universe <id>] --message=<text>",
  "memory-store": "memory-store map list <map> | map get|delete <map> <item> | map create|update <map> <item> --value=<json> --ttl <s> [--sort-key=<k>] [--upsert] | queue read <queue> [--count <n>] [--invisible <s>] | queue add <queue> --value=<json> --ttl <s> [--priority=<n>] | queue discard <queue> <read id> | flush [--test]   (each takes [place] last and --universe <id>)",
  leaderboard: "leaderboard list <store> | get|delete <store> <entry> | create|set <store> <entry> --value=<n> [--upsert] | increment <store> <entry> --amount=<n>   (each takes [place] last, --universe <id> and --scope <name>)",
  ban: "ban list [place] | ban get|lift <user id> [place] | ban set <user id> [place] [--duration <time>] [--display=<shown to them>] [--reason=<private>] [--keep-alts] | ban logs [place] [--user <id>]   (each takes --universe <id> and --in-place <place id>)",
};

const need = (value: string | undefined, usage: string): string => {
  if (!value) throw new LiveUsage(`usage: ${usage}`);
  return value;
};

function intOption(raw: string | undefined, name: string, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = isIntText(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new LiveUsage(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function numberOption(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  // Number("0x10") is 16 and Number("  ") is 0: only a number written in decimal counts
  // and 1e400 is Infinity, which JSON sends as null (the option would vanish)
  const n = isNumberText(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new LiveUsage(`--${name} must be a number`);
  return n;
}

/** A value for the MemoryStore: JSON when it reads as JSON, else the text itself */
function jsonValue(raw: string | undefined, usage: string): unknown {
  if (raw === undefined) throw new LiveUsage(`--value is required: ${usage}`);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 90, 90s, 30m, 12h, 7d, 2w in seconds */
export function parseDuration(raw: string): number {
  const m = /^(\d+)\s*(s|m|min|h|d|w)?$/i.exec(raw.trim());
  if (!m) throw new LiveUsage(`--duration must be a time like 3600, 30m, 12h, 7d or 2w, not "${raw}"`);
  const unit = (m[2] ?? "s").toLowerCase();
  const n = Number(m[1]) * ({ s: 1, m: 60, min: 60, h: 3600, d: 86_400, w: 604_800 } as Record<string, number>)[unit];
  if (!Number.isSafeInteger(n) || n < 1) throw new LiveUsage("--duration must be at least 1 second");
  return n;
}

/** The experience: --universe, or the place's (Roblox's public universes API, no key) */
async function universeOf(deps: LiveDeps, options: LiveOptions, placeQuery: string | undefined): Promise<string> {
  if (options.universe !== undefined) {
    if (!/^[1-9]\d{0,18}$/.test(options.universe)) throw new LiveUsage("--universe must be an experience id (a whole number)");
    if (placeQuery !== undefined) throw new LiveUsage("give the place or --universe, not both");
    return options.universe;
  }
  const placeId = await deps.placeId(placeQuery);
  const env = deps.roblox();
  let response: Response;
  try {
    response = await env.fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new RobloxError(`the experience of place ${placeId} could not be read (${(error as Error).message}): give --universe <id>`);
  }
  const body: any = await response.json().catch(() => undefined);
  const universeId = body?.universeId;
  if (!response.ok || universeId === null || universeId === undefined) throw new RobloxError(`Roblox names no experience for place ${placeId} (HTTP ${response.status}): give --universe <id>`);
  return String(universeId);
}

const when = (iso: unknown) => (typeof iso === "string" ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z") : "?");
const nextPage = (r: any, command: string) => (r.nextPageToken ? [`More: ${command} ... --page ${r.nextPageToken}`] : []);
/** Roblox's "604800s" as "7 d" (as it came when it is not seconds) */
const span = (raw: unknown) => { const n = durationSeconds(raw); return n === undefined ? String(raw) : humanDuration(n); };
const onOff = (v: unknown) => (v === true ? "on" : v === false ? "off" : "?");

export function universeText(u: any): string {
  const id = String(u?.path ?? "").split("/").pop();
  return [
    `${u?.displayName ?? "?"} (experience ${id}), ${String(u?.visibility ?? "?").toLowerCase()}, ${u?.user ? `owned by ${u.user}` : u?.group ? `owned by ${u.group}` : "owner ?"}`,
    `  root place ${String(u?.rootPlace ?? "?").split("/").pop()}, updated ${when(u?.updateTime)}`,
    `  voice chat ${onOff(u?.voiceChatEnabled)}; joins from desktop ${onOff(u?.desktopEnabled)}, mobile ${onOff(u?.mobileEnabled)}, tablet ${onOff(u?.tabletEnabled)}, console ${onOff(u?.consoleEnabled)}, VR ${onOff(u?.vrEnabled)}`,
    `  private servers: ${u?.privateServerPriceRobux === undefined || u?.privateServerPriceRobux === null ? "off" : `${u.privateServerPriceRobux} Robux`}${u?.ageRating ? `; age rating ${String(u.ageRating).replace(/^AGE_RATING_/, "")}` : ""}`,
  ].join("\n");
}

/** One of the live-game commands; the place (when there is one) is the last positional */
export async function liveCommand(deps: LiveDeps, options: LiveOptions, command: string, args: string[]): Promise<number> {
  const print = (value: unknown, text: () => string) => deps.out(deps.json ? JSON.stringify(value, null, 2) : text());
  const usage = LIVE_USAGE[command as (typeof LIVE_COMMANDS)[number]];
  const q = deps.command;
  const paging = { limit: intOption(options.limit, "limit", 1, 100), pageToken: options.page };

  if (command === "universe") {
    const action = args[0] === "get" || args[0] === "set" ? args[0] : "get";
    const rest = args[0] === "get" || args[0] === "set" ? args.slice(1) : args;
    const universeId = await universeOf(deps, options, rest[0]);
    if (action === "get") {
      const u = await deps.cloudCall("universeGet", { universeId });
      print(u, () => universeText(u));
      return 0;
    }
    if (!options.props) throw new LiveUsage(`universe set needs --props=<json>, the settings by their Open Cloud names, like {"voiceChatEnabled":true}. Usage: ${usage}`);
    let fields: unknown;
    try {
      fields = JSON.parse(options.props);
    } catch {
      throw new LiveUsage("--props must be a JSON object");
    }
    const u = await deps.cloudCall("universeUpdate", { universeId, fields });
    print(u, () => `Changed (approved in the dialog). The experience now:\n${universeText(u)}`);
    return 0;
  }

  if (command === "servers") {
    if (args[0] !== "restart") throw new LiveUsage(`usage: ${usage}`);
    const universeId = await universeOf(deps, options, args[1]);
    const placeIds = options.places?.split(",").map((p) => p.trim()).filter(Boolean);
    const bleed = intOption(options.bleed, "bleed", 1, 60);
    const r = await deps.cloudCall("serversRestart", { universeId, placeIds, closeAllVersions: options.allVersions, ...(bleed !== undefined ? { bleedOffServers: true, bleedOffDurationMinutes: bleed } : {}) });
    print(r, () => `Restart sent for experience ${universeId} (approved in the dialog): ${options.allVersions ? "every server" : "the servers on an older version"}${placeIds?.length ? ` in places ${placeIds.join(", ")}` : ""}${bleed ? `, closing after ${bleed} min` : ", now"}.`);
    return 0;
  }

  if (command === "message") {
    if (args[0] !== "publish") throw new LiveUsage(`usage: ${usage}`);
    const topic = need(args[1], usage);
    if (options.message === undefined) throw new LiveUsage(`--message=<text> is required. Usage: ${usage}`);
    const universeId = await universeOf(deps, options, args[2]);
    const r = await deps.cloudCall("messagePublish", { universeId, topic, message: options.message });
    print(r, () => `Published on topic "${topic}" of experience ${universeId} (approved in the dialog): ${r.characters} characters to every live server that subscribed.`);
    return 0;
  }

  if (command === "memory-store") {
    const [kind, action] = args;
    if (kind === "flush") {
      const universeId = await universeOf(deps, options, args[1]);
      const r = await deps.cloudCall("memoryStoreFlush", { universeId, scope: options.test ? "TEST" : "LIVE" });
      print(r, () => `The ${r.scope} MemoryStore of experience ${universeId} ${r.done ? "is flushed" : `is being flushed (${r.note})`} (approved in the dialog).`);
      return 0;
    }
    if (kind === "map") {
      const map = need(args[2], usage);
      if (action === "list") {
        const universeId = await universeOf(deps, options, args[3]);
        const r = await deps.cloudCall("sortedMapList", { universeId, map, ...paging, descending: options.descending, filter: options.filter });
        print(r, () => [r.items.length ? `Sorted map "${map}" of experience ${universeId}:` : `Sorted map "${map}" of experience ${universeId}: no item on this page.`,
          ...r.items.map((i: any) => `  ${i.id ?? String(i.path ?? "").split("/").pop()}  ${JSON.stringify(i.value)}${i.numericSortKey !== undefined ? `  sort ${i.numericSortKey}` : i.stringSortKey !== undefined ? `  sort "${i.stringSortKey}"` : ""}${i.expireTime ? `  expires ${when(i.expireTime)}` : ""}`),
          ...nextPage(r, `${q} memory-store map list`)].join("\n"));
        return 0;
      }
      const item = need(args[3], usage);
      const universeId = await universeOf(deps, options, args[4]);
      if (action === "get") {
        const r = await deps.cloudCall("sortedMapGet", { universeId, map, item });
        print(r, () => `${item} = ${JSON.stringify(r.value)}${r.numericSortKey !== undefined ? `, sort key ${r.numericSortKey}` : r.stringSortKey !== undefined ? `, sort key "${r.stringSortKey}"` : ""}${r.expireTime ? `, expires ${when(r.expireTime)}` : ""}`);
        return 0;
      }
      if (action === "delete") {
        const r = await deps.cloudCall("sortedMapDelete", { universeId, map, item });
        print(r, () => `Deleted ${item} from sorted map "${map}" (approved in the dialog).`);
        return 0;
      }
      if (action === "create" || action === "update") {
        const value = jsonValue(options.value, usage);
        const ttlSeconds = intOption(options.ttl, "ttl", 1, 3_888_000);
        if (ttlSeconds === undefined) throw new LiveUsage("--ttl <seconds> is required: how long the item lives (at most 3888000, 45 days)");
        const key = options.sortKey === undefined ? {} : /^-?\d+(\.\d+)?$/.test(options.sortKey) ? { numericSortKey: Number(options.sortKey) } : { stringSortKey: options.sortKey };
        const r = await deps.cloudCall(action === "create" ? "sortedMapCreate" : "sortedMapUpdate", { universeId, map, item, value, ttlSeconds, ...key, ...(action === "update" && options.upsert ? { allowMissing: true } : {}) });
        print(r, () => `${action === "create" ? "Created" : "Set"} ${item} in sorted map "${map}" (approved in the dialog): ${JSON.stringify(r.value ?? value)}${r.expireTime ? `, expires ${when(r.expireTime)}` : ""}.`);
        return 0;
      }
      throw new LiveUsage(`usage: ${usage}`);
    }
    if (kind === "queue") {
      const queue = need(args[2], usage);
      if (action === "read") {
        const universeId = await universeOf(deps, options, args[3]);
        const r = await deps.cloudCall("queueRead", { universeId, queue, count: intOption(options.count, "count", 1, 200), invisibleSeconds: intOption(options.invisible, "invisible", 1, 3600), allOrNothing: options.allOrNothing });
        print(r, () => [`Queue "${queue}" of experience ${universeId}: ${r.items.length} item(s), hidden from the game for ${r.invisibleSeconds} s (approved in the dialog).`,
          ...r.items.map((i: any) => `  ${JSON.stringify(i.data)}${i.priority !== undefined ? `  priority ${i.priority}` : ""}`),
          ...(r.items.length ? [`Read id ${r.readId}: ${q} memory-store queue discard ${queue} ${r.readId} takes them out for good; otherwise they come back.`] : [])].join("\n"));
        return 0;
      }
      if (action === "add") {
        const universeId = await universeOf(deps, options, args[3]);
        const ttlSeconds = intOption(options.ttl, "ttl", 1, 3_888_000);
        if (ttlSeconds === undefined) throw new LiveUsage("--ttl <seconds> is required: how long the item lives (at most 3888000, 45 days)");
        const r = await deps.cloudCall("queueAdd", { universeId, queue, value: jsonValue(options.value, usage), ttlSeconds, priority: numberOption(options.priority, "priority") });
        print(r, () => `Added to queue "${queue}" (approved in the dialog)${r.expireTime ? `, expires ${when(r.expireTime)}` : ""}.`);
        return 0;
      }
      if (action === "discard") {
        const readId = need(args[3], usage);
        const universeId = await universeOf(deps, options, args[4]);
        const r = await deps.cloudCall("queueDiscard", { universeId, queue, readId });
        print(r, () => `Discarded the items of read ${readId} from queue "${queue}" (approved in the dialog).`);
        return 0;
      }
    }
    throw new LiveUsage(`usage: ${usage}`);
  }

  if (command === "leaderboard") {
    const [action, store] = args;
    need(store, usage);
    const scope = options.scope;
    if (action === "list") {
      const universeId = await universeOf(deps, options, args[2]);
      const r = await deps.cloudCall("leaderboardList", { universeId, store, scope, ...paging, ascending: options.ascending, min: numberOption(options.min, "min"), max: numberOption(options.max, "max") });
      print(r, () => [r.entries.length ? `Ordered data store "${store}" (scope ${r.scope}) of experience ${universeId}, ${options.ascending ? "lowest" : "highest"} first:` : `Ordered data store "${store}" (scope ${r.scope}): no entry on this page.`,
        ...r.entries.map((e: any, i: number) => `  ${String(i + 1).padStart(3)}. ${e.entry}  ${e.value}`),
        ...nextPage(r, `${q} leaderboard list`)].join("\n"));
      return 0;
    }
    const entry = need(args[2], usage);
    const universeId = await universeOf(deps, options, args[3]);
    const base = { universeId, store, scope, entry };
    const done = (r: any, verb: string) => print(r, () => `${verb} ${entry} in "${store}" (approved in the dialog): ${r.value ?? "gone"}.`);
    if (action === "get") {
      const r = await deps.cloudCall("leaderboardGet", base);
      print(r, () => `${entry} = ${r.value} in "${store}" (scope ${r.scope})`);
      return 0;
    }
    if (action === "create" || action === "set") {
      const value = numberOption(need(options.value, `--value=<whole number>. Usage: ${usage}`), "value");
      done(await deps.cloudCall(action === "create" ? "leaderboardCreate" : "leaderboardUpdate", { ...base, value, ...(action === "set" && options.upsert ? { allowMissing: true } : {}) }), action === "create" ? "Created" : "Set");
      return 0;
    }
    if (action === "increment") {
      const amount = numberOption(need(options.amount, `--amount=<whole number>. Usage: ${usage}`), "amount");
      done(await deps.cloudCall("leaderboardIncrement", { ...base, amount }), "Incremented");
      return 0;
    }
    if (action === "delete") {
      done(await deps.cloudCall("leaderboardDelete", base), "Deleted");
      return 0;
    }
    throw new LiveUsage(`usage: ${usage}`);
  }

  if (command === "ban") {
    const action = need(args[0], usage);
    const placeId = options.inPlace;
    if (action === "list" || action === "logs") {
      const universeId = await universeOf(deps, options, args[1]);
      if (action === "list") {
        const r = await deps.cloudCall("banList", { universeId, placeId, ...paging });
        const banned = r.restrictions.filter((x: any) => x?.gameJoinRestriction?.active);
        print(r, () => [banned.length ? `Banned in experience ${universeId}${placeId ? `, place ${placeId}` : ""}:` : `No ban on this page in experience ${universeId}.`,
          ...banned.map((x: any) => banLine(x)), ...nextPage(r, `${q} ban list`)].join("\n"));
      } else {
        const r = await deps.cloudCall("banLogs", { universeId, placeId, userId: options.user, ...paging });
        print(r, () => [r.logs.length ? `Ban log of experience ${universeId}, newest first:` : `No ban log entry in experience ${universeId}.`,
          ...r.logs.map((l: any) => `  ${when(l.createTime)}  ${l.user ?? "?"}  ${l.active ? "banned" : "unbanned"}${l.active ? (l.duration ? ` for ${span(l.duration)}` : " permanently") : ""}${l.place ? ` in ${l.place}` : ""}${l.moderator?.robloxUser ? ` by ${l.moderator.robloxUser}` : l.moderator?.gameServerScript !== undefined ? " by a game script" : ""}${l.displayReason ? `  shown: "${l.displayReason}"` : ""}${l.privateReason ? `  private: "${l.privateReason}"` : ""}`),
          ...nextPage(r, `${q} ban logs`)].join("\n"));
      }
      return 0;
    }
    const userId = need(args[1], usage);
    if (!/^[1-9]\d{0,18}$/.test(userId)) throw new LiveUsage("the user id must be a whole number (a Roblox user id)");
    const universeId = await universeOf(deps, options, args[2]);
    if (action === "get") {
      const r = await deps.cloudCall("banGet", { universeId, placeId, userId });
      print(r, () => banLine(r).trim());
      return 0;
    }
    if (action === "set" || action === "lift") {
      const r = await deps.cloudCall("banUpdate", action === "lift"
        ? { universeId, placeId, userId, active: false, ...(options.reason !== undefined ? { privateReason: options.reason } : {}) }
        : {
            universeId, placeId, userId, active: true,
            ...(options.duration !== undefined ? { durationSeconds: parseDuration(options.duration) } : {}),
            ...(options.display !== undefined ? { displayReason: options.display } : {}),
            ...(options.reason !== undefined ? { privateReason: options.reason } : {}),
            excludeAltAccounts: options.keepAlts,
          });
      print(r, () => `${action === "lift" ? "Ban lifted" : "Banned"} (approved in the dialog): ${banLine(r).trim()}`);
      return 0;
    }
    throw new LiveUsage(`usage: ${usage}`);
  }
  throw new LiveUsage(`unknown command ${command}`);
}

function banLine(x: any): string {
  const g = x?.gameJoinRestriction ?? {};
  const user = String(x?.user ?? x?.path ?? "?").split("/").pop();
  if (!g.active) return `  user ${user}: not banned`;
  return `  user ${user}: banned ${g.duration ? `for ${span(g.duration)}` : "permanently"} since ${when(g.startTime)}${g.inherited ? " (from the whole experience)" : ""}${g.excludeAltAccounts ? ", alts left alone" : ""}${g.displayReason ? `, shown "${g.displayReason}"` : ""}${g.privateReason ? `, private "${g.privateReason}"` : ""}`;
}
