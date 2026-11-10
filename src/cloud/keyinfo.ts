import { resolveKey, RobloxError } from "../control/roblox.js";
import type { CloudOp } from "./ops.js";

/**
 * What the saved key may do, read from Roblox's own introspect (measured 09/11/26: it answers the
 * key's name, state and every scope with its operations and experiences, never the key), and
 * which of Quack's tools each missing scope leaves out. The key goes to Roblox only.
 */

/** Quack's tools and the scope each needs (name:operation) */
export const TOOL_SCOPES: { tool: string; needs: string[] }[] = [
  { tool: "upload_asset", needs: ["asset:read", "asset:write"] },
  { tool: "list_place_versions / download_place", needs: ["asset:read", "legacy-asset:manage"] },
  { tool: "datastore reads", needs: ["universe-datastores.objects:list", "universe-datastores.objects:read", "universe-datastores.versions:list", "universe-datastores.versions:read"] },
  { tool: "datastore set / increment", needs: ["universe-datastores.objects:update", "universe-datastores.objects:create"] },
  { tool: "datastore delete", needs: ["universe-datastores.objects:delete"] },
  { tool: "experience_config", needs: ["universe:write"] },
  { tool: "luau_run (Luau in the cloud)", needs: ["universe.place.luau-execution-session:write"] },
];

export const keyInfoOps: Record<string, CloudOp> = {
  keyInfo: {
    write: false,
    run: async (ctx) => {
      const { key, scrub } = await resolveKey(ctx.env, "nothing in particular");
      let response: Response;
      try {
        response = await ctx.env.fetch("https://apis.roblox.com/api-keys/v1/introspect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: key }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        throw new RobloxError(`Roblox did not answer the key check (${scrub((error as Error).message)})`);
      }
      const text = scrub(await response.text().catch(() => ""));
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      if (!response.ok || !json) throw new RobloxError(`Roblox did not accept the saved key as an Open Cloud key (HTTP ${response.status}): the user saves another in Quack's Settings, Open Cloud`);
      const granted = new Set<string>();
      const scopes = (json.scopes ?? []).map((s: any) => {
        for (const op of s.operations ?? []) granted.add(`${s.name}:${op}`);
        return { name: s.name, operations: s.operations ?? [], experiences: s.universeIds ?? [] };
      });
      const missing = TOOL_SCOPES.map((t) => ({ tool: t.tool, missing: t.needs.filter((n) => !granted.has(n)) })).filter((t) => t.missing.length);
      return { name: json.name, enabled: json.enabled, expired: json.expired, expiration: json.expirationTimeUtc, scopes, missing };
    },
  },
};
