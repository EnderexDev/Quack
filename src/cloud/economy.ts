import { RobloxError } from "../control/roblox.js";
import type { CloudOp } from "./ops.js";
import { allPages, checkUniverseName, cloudRequest, idArg, readImage, universeInfo, universeLabel } from "./web.js";

/**
 * Badges, developer products and game passes through Open Cloud, ported from
 * ~/.claude/scripts/roblox-cloud.mjs (the dashboard clicks a release used to wait on).
 *
 * None of the three can be deleted: a badge can be disabled, a product or a pass taken off sale,
 * never removed. So every create and update is a write (the hub's dialog asks first) and says so.
 *
 * Money: a universe gets 5 free badges per UTC day, then each costs BADGE_COST Robux. The CLI
 * reads the quota and refuses at 0 without --spend before any dialog opens; the operation checks
 * the quota again after the yes and refuses when it no longer matches the cost the dialog showed,
 * and it always sends expectedCost, so Roblox refuses instead of charging an amount nobody saw.
 * The payment source follows the universe's owner (the group's funds for a group game).
 */

export const BADGE_COST = 100;
export const FREE_BADGES_A_DAY = 5;

const PRODUCTS = "https://apis.roblox.com/developer-products/v2/universes";
const PASSES = "https://apis.roblox.com/game-passes/v1/universes";

const PERMISSION = {
  badgeCreate: "legacy-universe.badge:manage-and-spend-robux",
  badgeIcon: "legacy-badge:manage",
  productRead: "developer-product:read",
  productWrite: "developer-product:write",
  passRead: "game-pass:read",
  passWrite: "game-pass:write",
};

function nameArg(raw: unknown, what: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new RobloxError(`${what} is required`);
  return raw.trim();
}

function priceArg(raw: unknown): number {
  // Number(true) is 1 and Number("") is 0: only a number or its digits is a price
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new RobloxError("the price must be a whole number of Robux, 0 or more");
  return n;
}

function boolArg(raw: unknown, what: string): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  throw new RobloxError(`${what} must be true or false`);
}

export async function badgeQuota(env: Parameters<typeof cloudRequest>[0], universeId: string): Promise<number> {
  const raw = await cloudRequest(env, { method: "GET", url: `https://badges.roblox.com/v1/universes/${universeId}/free-badges-quota`, permission: "none", what: `the free badge quota of universe ${universeId}`, auth: false });
  // An empty answer is not a spent quota: Number(null) would read as 0
  const n = raw === null || raw === "" || typeof raw === "object" ? NaN : Number(raw);
  if (!Number.isFinite(n)) throw new RobloxError(`the free badge quota of universe ${universeId} is not a number`);
  return n;
}

/** The dialog's cost line, from the cost the caller read before asking */
function costText(expectedCost: number): string {
  return expectedCost === 0
    ? `Cost: free (one of the ${FREE_BADGES_A_DAY} free badges a UTC day; checked again before it is made).`
    : `Cost: ${BADGE_COST} Robux, from the owner's funds (the group's for a group game): no free badge is left today.`;
}

function badgeCostArg(args: Record<string, any>): number {
  const cost = Number(args.expectedCost);
  if (cost !== 0 && cost !== BADGE_COST) throw new RobloxError(`expectedCost must be 0 (a free badge) or ${BADGE_COST} (the price past the free quota)`);
  if (cost > 0 && args.spend !== true) throw new RobloxError(`no free badge is left today: it costs ${BADGE_COST} Robux, and that needs spend (the CLI's --spend). Nothing was asked or made`);
  return cost;
}

/** A developer product or a game pass: the same shape on two APIs */
interface SaleKind {
  label: string;
  base: string;
  /** The id's field in the answer, and its segment in the URL */
  idField: string;
  segment: string;
  listField: string;
  read: string;
  write: string;
  /** A product is always put on sale when made (the script's rule); a pass may start off sale */
  createForSale: (args: Record<string, any>) => boolean;
}

const PRODUCT: SaleKind = {
  label: "developer product",
  base: PRODUCTS,
  idField: "productId",
  segment: "developer-products",
  listField: "developerProducts",
  read: PERMISSION.productRead,
  write: PERMISSION.productWrite,
  createForSale: () => true,
};

const PASS: SaleKind = {
  label: "game pass",
  base: PASSES,
  idField: "gamePassId",
  segment: "game-passes",
  listField: "gamePasses",
  read: PERMISSION.passRead,
  write: PERMISSION.passWrite,
  // A pass on sale can be bought from the game's page before the code that grants it is live:
  // forSale false on create keeps it off until the release
  createForSale: (args) => boolArg(args.forSale, "forSale") ?? true,
};

function saleSummary(kind: SaleKind, p: any) {
  return {
    id: p?.[kind.idField],
    name: p?.name,
    price: p?.priceInformation?.defaultPriceInRobux ?? null,
    forSale: p?.isForSale,
    ...(p?.iconImageAssetId !== undefined ? { iconImageAssetId: p.iconImageAssetId } : {}),
    ...(p?.iconAssetId !== undefined ? { iconAssetId: p.iconAssetId } : {}),
  };
}

function saleOps(kind: SaleKind, prefix: string): Record<string, CloudOp> {
  const changes = (args: Record<string, any>, create: boolean): string[] => {
    // A file that cannot be read stops it before the dialog
    if (args.image !== undefined) readImage(args.image, "image");
    const lines: string[] = [];
    if (args.name !== undefined) lines.push(`name "${nameArg(args.name, "name")}"`);
    if (args.price !== undefined) lines.push(`price ${priceArg(args.price)} Robux`);
    if (args.description !== undefined) lines.push(`description "${String(args.description).slice(0, 120)}"`);
    const forSale = create ? kind.createForSale(args) : boolArg(args.forSale, "forSale");
    if (forSale === true) lines.push("on sale: players can buy it as soon as this runs");
    if (forSale === false) lines.push("off sale");
    if (args.image !== undefined) lines.push(`image ${String(args.image)}`);
    return lines;
  };
  const form = (args: Record<string, any>, create: boolean): FormData => {
    const body = new FormData();
    if (args.name !== undefined) body.append("name", nameArg(args.name, "name"));
    if (args.description !== undefined) body.append("description", String(args.description));
    if (args.price !== undefined) body.append("price", String(priceArg(args.price)));
    // On update only what was asked changes: putting it back on sale is never implied
    const forSale = create ? kind.createForSale(args) : boolArg(args.forSale, "forSale");
    if (forSale !== undefined) body.append("isForSale", String(forSale));
    if (args.image !== undefined) {
      const image = readImage(args.image, "image");
      body.append("imageFile", image.blob, image.name);
    }
    return body;
  };
  return {
    [`${prefix}.list`]: {
      write: false,
      run: async (ctx, args) => {
        const universeId = idArg(args.universeId, "the universe id");
        const what = `the ${kind.label}s of universe ${universeId}`;
        const items = await allPages(what, async (token) => {
          const page = await cloudRequest(ctx.env, { method: "GET", url: `${kind.base}/${universeId}/${kind.segment}/creator?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, permission: kind.read, what });
          return { items: (page?.[kind.listField] ?? []).map((p: any) => saleSummary(kind, p)), next: page?.nextPageToken || "" };
        });
        return { universeId, items };
      },
    },
    [`${prefix}.get`]: {
      write: false,
      run: async (ctx, args) => {
        const universeId = idArg(args.universeId, "the universe id");
        const id = idArg(args.id, `the ${kind.label} id`);
        return cloudRequest(ctx.env, { method: "GET", url: `${kind.base}/${universeId}/${kind.segment}/${id}/creator`, permission: kind.read, what: `${kind.label} ${id}` });
      },
    },
    [`${prefix}.create`]: {
      write: true,
      describe: (args) => {
        idArg(args.universeId, "the universe id");
        nameArg(args.name, "name");
        if (args.price === undefined) throw new RobloxError("price is required");
        return {
          title: `Quack: create a ${kind.label}`,
          text: [
            `Create the ${kind.label} "${args.name}" in ${universeLabel(args)}:`,
            ...changes(args, true).map((l) => `  ${l}`),
            "",
            `A ${kind.label} can never be deleted, only taken off sale. Make it in the published game's universe: a test place's universe cannot sell it in the real game.`,
          ].join("\n"),
        };
      },
      run: async (ctx, args) => {
        const universeId = idArg(args.universeId, "the universe id");
        await checkUniverseName(ctx.env, args);
        const p = await cloudRequest(ctx.env, { method: "POST", url: `${kind.base}/${universeId}/${kind.segment}`, body: form(args, true), permission: kind.write, what: `the new ${kind.label} "${args.name}"` });
        return { universeId, created: saleSummary(kind, p) };
      },
    },
    [`${prefix}.update`]: {
      write: true,
      describe: (args) => {
        idArg(args.universeId, "the universe id");
        const id = idArg(args.id, `the ${kind.label} id`);
        const lines = changes(args, false);
        if (!lines.length) throw new RobloxError("nothing to change: give a name, price, description, forSale or image");
        return { title: `Quack: change a ${kind.label}`, text: [`Change ${kind.label} ${id} in ${universeLabel(args)}:`, ...lines.map((l) => `  ${l}`)].join("\n") };
      },
      run: async (ctx, args) => {
        const universeId = idArg(args.universeId, "the universe id");
        const id = idArg(args.id, `the ${kind.label} id`);
        await checkUniverseName(ctx.env, args);
        await cloudRequest(ctx.env, { method: "PATCH", url: `${kind.base}/${universeId}/${kind.segment}/${id}`, body: form(args, false), permission: kind.write, what: `${kind.label} ${id}` });
        return { universeId, id, updated: true };
      },
    },
  };
}

export const ECONOMY_OPS: Record<string, CloudOp> = {
  universe: {
    write: false,
    run: (ctx, args) => universeInfo(ctx.env, args.universeId),
  },
  "badge.quota": {
    write: false,
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      return { universeId, free: await badgeQuota(ctx.env, universeId), costPastQuota: BADGE_COST };
    },
  },
  "badge.list": {
    write: false,
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      const what = `the badges of universe ${universeId}`;
      const badges = await allPages(what, async (cursor) => {
        const page = await cloudRequest(ctx.env, { method: "GET", url: `https://badges.roblox.com/v1/universes/${universeId}/badges?limit=100&sortOrder=Asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, permission: "none", what, auth: false });
        return { items: (page?.data ?? []).map((b: any) => ({ id: b.id, name: b.name, enabled: b.enabled, iconImageId: b.iconImageId })), next: page?.nextPageCursor || "" };
      });
      return { universeId, badges };
    },
  },
  "badge.create": {
    write: true,
    describe: (args) => {
      idArg(args.universeId, "the universe id");
      nameArg(args.name, "name");
      const cost = badgeCostArg(args);
      if (args.icon !== undefined) readImage(args.icon, "icon");
      return {
        title: cost > 0 ? `Quack: create a badge for ${BADGE_COST} Robux` : "Quack: create a badge",
        text: [
          `Create the badge "${args.name}" in ${universeLabel(args)}${args.icon ? ` with the icon ${args.icon}` : " (no icon: Roblox's grey medal until one is set)"}.`,
          costText(cost),
          "",
          "A badge can never be deleted, only disabled. Make it in the published game's universe: a test place's universe cannot award it in the real game.",
        ].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      const name = nameArg(args.name, "name");
      const expectedCost = badgeCostArg(args);
      // The quota again, after the yes: the dialog showed the cost read before it
      const free = await badgeQuota(ctx.env, universeId);
      const cost = free > 0 ? 0 : BADGE_COST;
      if (cost !== expectedCost) {
        throw new RobloxError(`the free badge quota changed since the dialog (${free} free now, so it would cost ${cost} Robux, not the ${expectedCost} approved): nothing was made. Ask again`);
      }
      const universe = await universeInfo(ctx.env, universeId);
      if (args.universeName !== undefined && universe.name !== String(args.universeName)) {
        throw new RobloxError(`universe ${universeId} is "${universe.name}", not "${args.universeName}" as the dialog said: nothing was made`);
      }
      const body = new FormData();
      body.append("name", name);
      if (args.description !== undefined) body.append("description", String(args.description));
      body.append("paymentSourceType", universe.creator.type === "Group" ? "2" : "1");
      body.append("expectedCost", String(expectedCost));
      body.append("isActive", "true");
      if (args.icon !== undefined) {
        const icon = readImage(args.icon, "icon");
        body.append("files", icon.blob, icon.name);
      }
      const badge = await cloudRequest(ctx.env, { method: "POST", url: `https://apis.roblox.com/legacy-badges/v1/universes/${universeId}/badges`, body, permission: PERMISSION.badgeCreate, what: `the new badge "${name}"` });
      return { universeId, badgeId: badge?.id, name: badge?.name ?? name, enabled: badge?.enabled, iconImageId: badge?.iconImageId, cost: expectedCost, freeBefore: free, paidBy: universe.creator.type === "Group" ? `group ${universe.creator.name}` : `user ${universe.creator.name}` };
    },
  },
  "badge.icon": {
    write: true,
    describe: (args) => {
      const id = idArg(args.badgeId, "the badge id");
      readImage(args.file, "file");
      return { title: "Quack: replace a badge's icon", text: `Replace the icon of badge ${id} with ${args.file}. The old icon is not kept.` };
    },
    run: async (ctx, args) => {
      const id = idArg(args.badgeId, "the badge id");
      const image = readImage(args.file, "file");
      const body = new FormData();
      body.append("Files", image.blob, image.name);
      const out = await cloudRequest(ctx.env, { method: "POST", url: `https://apis.roblox.com/legacy-publish/v1/badges/${id}/icon`, body, permission: PERMISSION.badgeIcon, what: `the icon of badge ${id}` });
      return { badgeId: id, iconImageId: out?.targetId };
    },
  },
  ...saleOps(PRODUCT, "product"),
  ...saleOps(PASS, "gamepass"),
};
