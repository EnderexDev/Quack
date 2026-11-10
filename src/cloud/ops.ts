import { downloadPlace, placeVersions, RobloxError, uploadAsset, type RobloxEnv } from "../control/roblox.js";
import { ApprovalBusy, type Approver } from "./approve.js";
import { configOps } from "./configs.js";
import { datastoreOps } from "./datastore.js";
import { keyInfoOps } from "./keyinfo.js";
import { luauOps } from "./luau.js";
import { ECONOMY_OPS } from "./economy.js";
import { LOCALIZATION_OPS } from "./localization.js";
import { ANALYTICS_OPS } from "./analytics.js";
import { MEMORY_STORE_OPS } from "./memorystore.js";
import { MESSAGING_OPS } from "./messaging.js";
import { ORDERED_OPS } from "./ordered.js";
import { RESTRICTION_OPS } from "./restrictions.js";
import { SERVER_OPS } from "./servers.js";

/**
 * Everything Quack does with the Open Cloud key, by name: the hub's /api/cloud runs one of these
 * and nothing else (no raw request: any local program can call the hub, so a free-form proxy
 * would hand it the key's whole power). Each one says whether it writes to Roblox; a write runs
 * only after the user's Accept in Quack's app (approve.ts), and its `describe` is what the
 * app's popup asks. Uploads are not gated: they make a new asset, never change or delete one, and
 * their log never sends the same file twice.
 */

export interface CloudContext {
  env: RobloxEnv;
  approve: Approver;
  log?: (line: string) => void;
}

export interface CloudOp {
  /** Changes or deletes something on Roblox: asks the user first */
  write: boolean;
  /**
   * The dialog's question, in the user's words: what changes, where. It may read Roblox first
   * (the value now, to show what changes), and `with` pins arguments the write then uses (the
   * version the user saw, so a save in between makes Roblox refuse instead of overwriting it).
   * It may read the game's name, so the user tells the live game from a test copy, and it
   * throws a RobloxError for wrong arguments: no dialog opens for a write that could not run.
   */
  describe?: (args: Record<string, any>, ctx: CloudContext) => Question | Promise<Question>;
  run: (ctx: CloudContext, args: Record<string, any>) => Promise<unknown>;
}

export interface Question {
  title: string;
  text: string;
  with?: Record<string, unknown>;
}

export class ApprovalRefused extends RobloxError {}

/** The contexts with a write between its first step and its end (one hub: one context) */
const writing = new WeakSet<CloudContext>();

const OPS: Record<string, CloudOp> = {
  upload: {
    write: false,
    run: (ctx, a) => uploadAsset(ctx.env, { file: a.file, assetType: a.assetType, displayName: a.displayName, description: a.description, userId: a.userId, groupId: a.groupId, force: a.force === true }),
  },
  versions: {
    write: false,
    run: (ctx, a) => placeVersions(ctx.env, { placeId: a.placeId, limit: a.limit, pageToken: a.pageToken }),
  },
  download: {
    write: false,
    run: (ctx, a) => downloadPlace(ctx.env, { placeId: a.placeId, version: a.version, out: a.out }),
  },
  ...datastoreOps,
  ...configOps,
  ...keyInfoOps,
  ...luauOps,
  ...ECONOMY_OPS, ...LOCALIZATION_OPS, ...ANALYTICS_OPS,
  ...SERVER_OPS,
  ...MESSAGING_OPS,
  ...MEMORY_STORE_OPS,
  ...ORDERED_OPS,
  ...RESTRICTION_OPS,
};

/** Adds operations (each phase registers its own); a name is never replaced */
export function registerCloudOps(ops: Record<string, CloudOp>): void {
  for (const [name, op] of Object.entries(ops)) {
    if (OPS[name]) throw new Error(`cloud operation ${name} is registered twice`);
    OPS[name] = op;
  }
}

export function cloudOpNames(): string[] {
  return Object.keys(OPS).sort();
}

export function isWrite(name: string): boolean {
  return OPS[name]?.write === true;
}

/** Runs one named operation; a write asks the user first and stops on anything but yes */
export async function runCloudOp(ctx: CloudContext, name: string, args: Record<string, any>): Promise<unknown> {
  const op = Object.prototype.hasOwnProperty.call(OPS, name) ? OPS[name] : undefined;
  if (!op) throw new RobloxError(`no cloud operation ${name} (there are: ${cloudOpNames().join(", ")})`);
  if (op.write) {
    // One write at a time, the slot taken before any work (no Roblox read, no question built for
    // a write that would be refused), and given back however it ends
    if (writing.has(ctx) || ctx.approve.busy?.()) throw new ApprovalBusy("another write is waiting for the user's answer in Quack's app: ask again once it is answered");
    writing.add(ctx);
    try {
      const question = op.describe ? await op.describe(args, ctx) : { title: `Quack: ${name}`, text: `Run ${name} on Roblox?` };
      ctx.log?.(`cloud ${name}: asking the user (${question.title})`);
      const yes = await ctx.approve({ title: question.title, text: question.text });
      ctx.log?.(`cloud ${name}: ${yes ? "approved" : "refused"}`);
      if (!yes) throw new ApprovalRefused(`the user did not approve ${name} in Quack's app (Refuse, or no answer in time): nothing was changed`);
      return await op.run(ctx, { ...args, ...question.with });
    } finally {
      writing.delete(ctx);
    }
  }
  return op.run(ctx, args);
}
