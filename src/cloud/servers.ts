import { RobloxError } from "../control/roblox.js";
import { boolArg, cloudRequest, idArg, intArg, universeArg, universeLabel, universeUrl } from "./live-http.js";
import type { CloudContext, CloudOp } from "./ops.js";

/**
 * A live game's servers and settings (Open Cloud v2 universes). A restart drops the players in
 * the servers it closes; visibility PRIVATE removes every player at once; a new private server
 * price cancels every private server subscription (the studio rules, 04/11/26). Each is a write:
 * the hub's dialog says so before it runs.
 */

/** The settings Quack changes, with what each one does to players */
export const UNIVERSE_FIELDS: Record<string, { kind: "bool" | "visibility" | "price"; about: string }> = {
  voiceChatEnabled: { kind: "bool", about: "voice chat (running servers keep the old setting)" },
  desktopEnabled: { kind: "bool", about: "joining from a computer" },
  mobileEnabled: { kind: "bool", about: "joining from a phone" },
  tabletEnabled: { kind: "bool", about: "joining from a tablet" },
  consoleEnabled: { kind: "bool", about: "joining from a console" },
  vrEnabled: { kind: "bool", about: "joining in VR" },
  visibility: { kind: "visibility", about: "who can see and join the experience" },
  privateServerPriceRobux: { kind: "price", about: "the private server price in Robux" },
};

interface UniverseChange {
  universeId: string;
  fields: Record<string, boolean | string | number | null>;
}

function universeChange(args: Record<string, any>): UniverseChange {
  const universeId = universeArg(args);
  const given = args.fields;
  if (!given || typeof given !== "object" || Array.isArray(given) || !Object.keys(given).length) {
    throw new RobloxError(`fields must name at least one setting: ${Object.keys(UNIVERSE_FIELDS).join(", ")}`);
  }
  const fields: UniverseChange["fields"] = {};
  for (const [name, value] of Object.entries(given)) {
    const field = Object.hasOwn(UNIVERSE_FIELDS, name) ? UNIVERSE_FIELDS[name] : undefined;
    if (!field) throw new RobloxError(`${name} is not a setting Quack changes; these are: ${Object.keys(UNIVERSE_FIELDS).join(", ")}`);
    if (field.kind === "bool") fields[name] = boolArg(value, name) ?? (() => { throw new RobloxError(`${name} must be true or false`); })();
    else if (field.kind === "visibility") {
      if (value !== "PUBLIC" && value !== "PRIVATE") throw new RobloxError("visibility must be PUBLIC or PRIVATE");
      fields[name] = value;
    } else fields[name] = value === null ? null : intArg(value, name, 0, 1_000_000_000) ?? (() => { throw new RobloxError(`${name} must be a whole number of Robux, or null to turn private servers off`); })();
  }
  return { universeId, fields };
}

const show = (value: unknown) => (value === undefined ? "(not set)" : value === null ? "off" : typeof value === "boolean" ? (value ? "on" : "off") : String(value));

/** What a settings change does to the players, line by line, for the dialog */
function consequences(fields: UniverseChange["fields"], before: Record<string, any> | undefined): string[] {
  const out: string[] = [];
  if (fields.visibility === "PRIVATE") out.push("PRIVATE REMOVES EVERY PLAYER FROM EVERY RUNNING SERVER AT ONCE, and nobody but the owner can join until it is public again.");
  if ("privateServerPriceRobux" in fields) {
    out.push(fields.privateServerPriceRobux === null
      ? "Turning private servers off shuts every active private server and cancels every private server subscription."
      : "A new private server price CANCELS EVERY PRIVATE SERVER SUBSCRIPTION: each owner has to buy it again.");
  }
  for (const name of ["desktopEnabled", "mobileEnabled", "tabletEnabled", "consoleEnabled", "vrEnabled"]) {
    if (fields[name] === false) out.push(`Players can no longer join from ${UNIVERSE_FIELDS[name].about.replace(/^joining (from |in )/, "")}.`);
  }
  if ("voiceChatEnabled" in fields) out.push("Voice chat changes in new servers only.");
  if (before && Object.entries(fields).every(([k, v]) => before[k] === v)) out.push("(Every value is already the one asked: Roblox keeps it as it is.)");
  return out;
}

const restartArgs = (args: Record<string, any>) => {
  const universeId = universeArg(args);
  let placeIds: string[] | undefined;
  if (args.placeIds !== undefined && args.placeIds !== null) {
    if (!Array.isArray(args.placeIds) || !args.placeIds.length) throw new RobloxError("placeIds must be a list of place ids (left out: every place of the experience)");
    placeIds = args.placeIds.map((p: unknown) => idArg(p, "each place id"));
    // The body carries them as JSON numbers (the spec's int64): one past 2^53 would arrive as another id
    for (const p of placeIds!) if (!Number.isSafeInteger(Number(p))) throw new RobloxError(`place id ${p} is too large to send exactly`);
  }
  const closeAllVersions = boolArg(args.closeAllVersions, "closeAllVersions") ?? false;
  const bleedOffDurationMinutes = intArg(args.bleedOffDurationMinutes, "bleedOffDurationMinutes", 1, 60);
  const bleedOffServers = boolArg(args.bleedOffServers, "bleedOffServers") ?? bleedOffDurationMinutes !== undefined;
  if (bleedOffDurationMinutes !== undefined && !bleedOffServers) throw new RobloxError("bleedOffDurationMinutes is only for bleedOffServers true");
  if (bleedOffServers && bleedOffDurationMinutes === undefined) throw new RobloxError("bleedOffServers needs bleedOffDurationMinutes, from 1 to 60");
  return { universeId, placeIds, closeAllVersions, bleedOffServers, bleedOffDurationMinutes };
};

async function readUniverse(ctx: CloudContext, universeId: string) {
  return cloudRequest(ctx.env, { method: "GET", url: universeUrl(universeId), permission: "universe:read", what: `experience ${universeId}` });
}

export const SERVER_OPS: Record<string, CloudOp> = {
  universeGet: {
    write: false,
    run: async (ctx, args) => readUniverse(ctx, universeArg(args)),
  },
  universeUpdate: {
    write: true,
    describe: async (args, ctx) => {
      const change = universeChange(args);
      const label = await universeLabel(ctx, change.universeId);
      const before = label.universe;
      const lines = Object.entries(change.fields).map(([k, v]) => `  ${k} (${UNIVERSE_FIELDS[k].about}): ${before ? `${show(before[k])} -> ` : ""}${show(v)}`);
      return {
        title: `Quack: change the settings of ${label.short}`,
        text: [`Change these settings of ${label.long} on Roblox:`, ...lines, "", ...consequences(change.fields, before), "", "Allow this change?"].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const change = universeChange(args);
      const url = new URL(universeUrl(change.universeId));
      url.searchParams.set("updateMask", Object.keys(change.fields).join(","));
      return cloudRequest(ctx.env, { method: "PATCH", url: url.toString(), body: change.fields, permission: "universe:write", what: `the settings of experience ${change.universeId}` });
    },
  },
  serversRestart: {
    write: true,
    describe: async (args, ctx) => {
      const r = restartArgs(args);
      const label = await universeLabel(ctx, r.universeId);
      const which = r.closeAllVersions
        ? "EVERY running server, whatever version it runs"
        : "the servers running an older version than the latest published one (servers already on the latest stay up)";
      return {
        title: `Quack: restart the servers of ${label.short}`,
        text: [
          `Restart ${which} of ${label.long}${r.placeIds ? `, in place${r.placeIds.length > 1 ? "s" : ""} ${r.placeIds.join(", ")}` : ", in every place"}.`,
          "",
          r.bleedOffServers
            ? `Bleed off: those servers stop taking new players now and shut down after ${r.bleedOffDurationMinutes} min; the players still in them are disconnected then.`
            : "The players in those servers are DISCONNECTED NOW and have to join again.",
          "",
          "Allow the restart?",
        ].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const r = restartArgs(args);
      const body = {
        ...(r.placeIds ? { placeIds: r.placeIds.map(Number) } : {}),
        closeAllVersions: r.closeAllVersions,
        bleedOffServers: r.bleedOffServers,
        ...(r.bleedOffDurationMinutes !== undefined ? { bleedOffDurationMinutes: r.bleedOffDurationMinutes } : {}),
      };
      await cloudRequest(ctx.env, { method: "POST", url: `${universeUrl(r.universeId)}:restartServers`, body, permission: "universe:write", what: `the restart of experience ${r.universeId}'s servers` });
      return { universeId: r.universeId, restarted: true, ...body };
    },
  },
};
