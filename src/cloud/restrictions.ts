import { RobloxError } from "../control/roblox.js";
import {
  boolArg, cloudRequest, durationSeconds, humanDuration, idArg, idempotency, intArg, optionalText, pageSizeArg, pageTokenArg, quoted, seconds,
  universeArg, universeLabel, universeUrl, userLabel,
} from "./live-http.js";
import type { CloudContext, CloudOp } from "./ops.js";

/**
 * A live game's bans (Open Cloud v2 user restrictions): listed, read, set or lifted, and the log
 * of every change. A ban kicks the user from any server they are in and keeps them out of the
 * whole experience (or one place); Roblox also bans their alt accounts unless told not to. A ban
 * or an unban is a write the user approves.
 */

const READ = "universe.user-restriction:read";
const WRITE = "universe.user-restriction:write";
/** Roblox's longest ban, in seconds (the spec: 1 to 315,576,000,000) */
const DURATION_MAX = 315_576_000_000;
const PER_USER_LIMIT = "Roblox takes at most 2 ban changes a minute for the same user";

function where(args: Record<string, any>) {
  const universeId = universeArg(args);
  const placeId = args.placeId === undefined || args.placeId === null || args.placeId === "" ? undefined : idArg(args.placeId, "placeId");
  return { universeId, placeId, base: `${universeUrl(universeId)}${placeId ? `/places/${placeId}` : ""}/user-restrictions` };
}

function banArgs(args: Record<string, any>) {
  const w = where(args);
  const userId = idArg(args.userId, "userId");
  const active = boolArg(args.active, "active");
  if (active === undefined) throw new RobloxError("active is required: true bans, false lifts the ban");
  const duration = intArg(args.durationSeconds, "durationSeconds", 1, DURATION_MAX);
  const privateReason = optionalText(args.privateReason, "privateReason", 1000);
  const displayReason = optionalText(args.displayReason, "displayReason", 400);
  const excludeAltAccounts = boolArg(args.excludeAltAccounts, "excludeAltAccounts");
  if (!active && (duration !== undefined || displayReason !== undefined || excludeAltAccounts !== undefined)) {
    throw new RobloxError("lifting a ban (active false) takes no duration, displayReason or excludeAltAccounts");
  }
  const restriction = active
    ? { active, ...(duration !== undefined ? { duration: seconds(duration) } : {}), ...(privateReason !== undefined ? { privateReason } : {}), ...(displayReason !== undefined ? { displayReason } : {}), excludeAltAccounts: excludeAltAccounts ?? false }
    : { active, ...(privateReason !== undefined ? { privateReason } : {}) };
  return { ...w, userId, active, duration, privateReason, displayReason, excludeAltAccounts: excludeAltAccounts ?? false, restriction };
}

/** The user's ban as it is now, for the dialog */
async function banNow(ctx: CloudContext, b: ReturnType<typeof banArgs>): Promise<string> {
  try {
    const now = await cloudRequest(ctx.env, { method: "GET", url: `${b.base}/${b.userId}`, permission: READ, what: "the ban" });
    const g = now?.gameJoinRestriction;
    if (!g?.active) return "Now: not banned.";
    const left = durationSeconds(g.duration);
    return `Now: banned${g.inherited ? " (from the whole experience)" : ""}${left !== undefined ? ` for ${humanDuration(left)} from ${g.startTime ?? "?"}` : " permanently"}.`;
  } catch (error) {
    return `Now: could not be read (${(error as Error).message.slice(0, 160)})`;
  }
}

export const RESTRICTION_OPS: Record<string, CloudOp> = {
  banList: {
    write: false,
    run: async (ctx, args) => {
      const w = where(args);
      const url = new URL(w.base);
      url.searchParams.set("maxPageSize", String(pageSizeArg(args.limit, 20)));
      const token = pageTokenArg(args.pageToken);
      if (token) url.searchParams.set("pageToken", token);
      const body = await cloudRequest(ctx.env, { method: "GET", url: url.toString(), permission: READ, what: `the bans of experience ${w.universeId}${w.placeId ? ` in place ${w.placeId}` : ""}` });
      return { universeId: w.universeId, ...(w.placeId ? { placeId: w.placeId } : {}), restrictions: Array.isArray(body?.userRestrictions) ? body.userRestrictions : [], ...(body?.nextPageToken ? { nextPageToken: String(body.nextPageToken) } : {}) };
    },
  },
  banGet: {
    write: false,
    run: async (ctx, args) => {
      const w = where(args);
      const userId = idArg(args.userId, "userId");
      return cloudRequest(ctx.env, { method: "GET", url: `${w.base}/${userId}`, permission: READ, what: `the ban of user ${userId} in experience ${w.universeId}` });
    },
  },
  banUpdate: {
    write: true,
    describe: async (args, ctx) => {
      const b = banArgs(args);
      const label = await universeLabel(ctx, b.universeId);
      const who = await userLabel(ctx.env, b.userId);
      const scope = b.placeId ? `place ${b.placeId} of ${label.long}` : `${label.long}, every place`;
      if (!b.active) {
        return {
          title: `Quack: lift a ban in ${label.short}`,
          text: [`LIFT the ban of ${who} in ${scope}.`, await banNow(ctx, b), "", "They can join again at once.", ...(b.privateReason ? [`Private note kept in the log: ${quoted(b.privateReason, 300)}`] : []), "", "Allow it?"].join("\n"),
        };
      }
      return {
        title: `Quack: BAN a player from ${label.short}`,
        text: [
          `BAN ${who} from ${scope}, ${b.duration !== undefined ? `for ${humanDuration(b.duration)}` : "PERMANENTLY"}.`,
          await banNow(ctx, b),
          "",
          "If they are in a server now, they are kicked at once.",
          b.excludeAltAccounts ? "Their alt accounts are left alone." : "Roblox also bans the alt accounts it links to them.",
          `Shown to them: ${b.displayReason ? quoted(b.displayReason, 300) : "(no reason)"}`,
          `Private reason (the log only): ${b.privateReason ? quoted(b.privateReason, 300) : "(none)"}`,
          "",
          "Allow the ban?",
        ].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const b = banArgs(args);
      const url = new URL(`${b.base}/${b.userId}`);
      url.searchParams.set("updateMask", "gameJoinRestriction");
      // A retry of this same request is never applied twice
      const once = idempotency(ctx);
      url.searchParams.set("idempotencyKey.key", once.key);
      url.searchParams.set("idempotencyKey.firstSent", once.firstSent);
      return cloudRequest(ctx.env, {
        method: "PATCH", url: url.toString(), body: { gameJoinRestriction: b.restriction }, permission: WRITE,
        what: `the ban of user ${b.userId} in experience ${b.universeId}`, limitNote: PER_USER_LIMIT,
      });
    },
  },
  banLogs: {
    write: false,
    run: async (ctx, args) => {
      const universeId = universeArg(args);
      const url = new URL(`${universeUrl(universeId)}/user-restrictions:listLogs`);
      url.searchParams.set("maxPageSize", String(pageSizeArg(args.limit, 20)));
      const token = pageTokenArg(args.pageToken);
      if (token) url.searchParams.set("pageToken", token);
      const filter = [
        args.userId !== undefined && args.userId !== null && args.userId !== "" ? `user == 'users/${idArg(args.userId, "userId")}'` : "",
        args.placeId !== undefined && args.placeId !== null && args.placeId !== "" ? `place == 'places/${idArg(args.placeId, "placeId")}'` : "",
      ].filter(Boolean).join(" && ");
      if (filter) url.searchParams.set("filter", filter);
      const body = await cloudRequest(ctx.env, { method: "GET", url: url.toString(), permission: READ, what: `the ban log of experience ${universeId}` });
      return { universeId, logs: Array.isArray(body?.logs) ? body.logs : [], ...(body?.nextPageToken ? { nextPageToken: String(body.nextPageToken) } : {}) };
    },
  },
};
