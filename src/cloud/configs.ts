import { RobloxError } from "../control/roblox.js";
import { changedPaths, changesForDialog, cloudRequest, nameArg, wholeId } from "./http.js";
import type { CloudContext, CloudOp } from "./ops.js";

/**
 * An experience's configs (In-Experience Config, what ConfigService reads in the game) through
 * Open Cloud, as Anime Astral's rule measured it: GET reads the published entries, PATCH /draft
 * with { entries } merges into the draft and answers a draftHash, POST /publish with that hash
 * ships it. PUT /draft:overwrite removes every key it omits, so it is never offered. Reading and
 * editing the draft are free (the game does not see a draft); publishing is a write (Ender,
 * 09/11/26: only with the user's explicit yes), and its dialog lists what changes.
 */

const repoUrl = (universeId: number, repository: string) =>
  `https://apis.roblox.com/creator-configs-public-api/v1/configs/universes/${universeId}/repositories/${encodeURIComponent(repository)}`;
const PERMISSION = "universe:write (the experience's configs)";

function target(a: Record<string, any>) {
  return {
    universeId: wholeId(a.universeId, "universeId"),
    repository: a.repository === undefined || a.repository === "" ? "InExperienceConfig" : nameArg(a.repository, "repository", 100),
  };
}

/** The entries of an answer, whatever key Roblox nests them under */
const entriesOf = (json: any): Record<string, unknown> => (json && typeof json === "object" ? (json.entries ?? json.config?.entries ?? {}) : {});

async function published(ctx: CloudContext, t: ReturnType<typeof target>) {
  const { json } = await cloudRequest(ctx.env, { url: repoUrl(t.universeId, t.repository), what: `the published configs of experience ${t.universeId}`, permission: PERMISSION });
  return { entries: entriesOf(json), version: json?.version ?? json?.configVersion };
}

async function draft(ctx: CloudContext, t: ReturnType<typeof target>) {
  const answer = await cloudRequest(ctx.env, { url: `${repoUrl(t.universeId, t.repository)}/draft`, what: `the configs draft of experience ${t.universeId}`, permission: PERMISSION, allow404: true });
  if (answer.status === 404) return undefined;
  return { entries: entriesOf(answer.json), draftHash: answer.json?.draftHash };
}

const pickKeys = (entries: Record<string, unknown>, keys: unknown) => {
  if (keys === undefined) return entries;
  const wanted = Array.isArray(keys) ? keys.map(String) : String(keys).split(",").map((k) => k.trim()).filter(Boolean);
  return Object.fromEntries(wanted.map((k) => [k, entries[k]]));
};

export const configOps: Record<string, CloudOp> = {
  configGet: {
    write: false,
    run: async (ctx, a) => {
      const t = target(a);
      const p = await published(ctx, t);
      return { ...t, version: p.version, count: Object.keys(p.entries).length, entries: pickKeys(p.entries, a.keys) };
    },
  },
  configDraft: {
    write: false,
    run: async (ctx, a) => {
      const t = target(a);
      const [d, p] = await Promise.all([draft(ctx, t), published(ctx, t)]);
      if (!d) return { ...t, draft: false, note: "no draft is pending: a publish now would carry nothing" };
      return { ...t, draft: true, draftHash: d.draftHash, changes: changedPaths(p.entries, { ...p.entries, ...d.entries }, "", [], 200) };
    },
  },
  configSet: {
    // The draft only: the game does not see it until a publish
    write: false,
    run: async (ctx, a) => {
      const t = target(a);
      const entries = a.entries;
      if (!entries || typeof entries !== "object" || Array.isArray(entries) || !Object.keys(entries).length) throw new RobloxError("entries must be an object of key: value");
      const { json } = await cloudRequest(ctx.env, {
        method: "PATCH",
        url: `${repoUrl(t.universeId, t.repository)}/draft`,
        what: `the configs draft of experience ${t.universeId}`,
        permission: PERMISSION,
        body: JSON.stringify({ entries }),
      });
      return { ...t, merged: Object.keys(entries), draftHash: json?.draftHash, note: "in the draft only: configPublish ships it, with the user's yes" };
    },
  },
  configPublish: {
    write: true,
    describe: async (a, ctx) => {
      const t = target(a);
      const [d, p] = await Promise.all([draft(ctx, t), published(ctx, t)]);
      if (!d?.draftHash) throw new RobloxError(`experience ${t.universeId} has no configs draft: nothing to publish`);
      const message = typeof a.message === "string" && a.message ? a.message : "Published from Quack";
      // A draft made by an overwrite (the dashboard, another tool) holds the whole config: a key
      // it lacks is removed by the publish. Quack only merges, so these are named, not guessed away
      const absent = Object.keys(p.entries).filter((k) => !(k in d.entries));
      return {
        title: `Quack: publish configs of experience ${t.universeId}`,
        text: [
          `Publish the configs draft to the live game (experience ${t.universeId}, ${t.repository})?`,
          changesForDialog(p.entries, { ...p.entries, ...d.entries }),
          // Always named: a small overwrite draft is the one that removes the most
          ...(absent.length ? [`The draft lacks ${absent.length} published key(s): if it was made by an overwrite (the dashboard or another tool; Quack only merges), publishing REMOVES them: ${absent.map((k) => JSON.stringify(k)).join(", ")}`] : []),
          `Message: ${message}`,
          "Every server reads the new values right away.",
        ].join("\n"),
        with: { draftHash: d.draftHash, message },
      };
    },
    run: async (ctx, a) => {
      const t = target(a);
      if (typeof a.draftHash !== "string" || !a.draftHash) throw new RobloxError("no draftHash: the draft changed or vanished; read it again");
      const { json } = await cloudRequest(ctx.env, {
        method: "POST",
        url: `${repoUrl(t.universeId, t.repository)}/publish`,
        what: `publishing the configs of experience ${t.universeId}`,
        permission: PERMISSION,
        body: JSON.stringify({ draftHash: a.draftHash, message: a.message, deploymentStrategy: "Immediate" }),
      });
      return { ...t, published: true, version: json?.version ?? json?.configVersion };
    },
  },
};
