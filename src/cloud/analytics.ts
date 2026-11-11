import { RobloxError } from "../control/roblox.js";
import type { CloudContext, CloudOp } from "./ops.js";
import { cloudRequest, idArg } from "./web.js";

/**
 * The Analytics Query API (read-only), ported from Anime Astral's analytics-query.mjs: the
 * numbers TelemetryService sends, which a game server cannot read itself. A query may answer
 * done: false with a path; that path is asked again every 2 s until it is done (at most 60
 * times).
 *
 * Daily data arrives about two days late; hourly (OneHour) within 1 to 2 hours. The Onboarding
 * funnel comes back empty through the API (use TutorialStep / TutorialSkipped). Metric and
 * dimension names: https://create.roblox.com/docs/cloud/guides/analytics/metrics
 */

const HOST = "https://apis.roblox.com/analytics-query-api";
const ERRORS_HOST = "https://apis.roblox.com/universe-performance-raqi/v1/events/logging";
const PERMISSION = "universe.analytics:read";
export const ANALYTICS_KINDS = ["metrics", "dimension-values"] as const;
const POLL_MS = 2000;
const POLLS = 60;

/** Daily active users for the last 3 days: the query when none is given */
export function defaultAnalyticsBody(now: number) {
  const day = 24 * 3600 * 1000;
  const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00Z`;
  return { metric: "DailyActiveUsers", granularity: "OneDay", startTime: iso(now - 3 * day), endTime: iso(now + day) };
}

/** A query, asked again on its path until it is done */
async function analyticsQuery(env: CloudContext["env"], universeId: string, kind: string, body: object): Promise<any> {
      const what = `the analytics ${kind} of universe ${universeId}`;
      let answer = await cloudRequest(env, { method: "POST", url: `${HOST}/v1/universes/${universeId}/${kind}`, body, permission: PERMISSION, what });
      for (let i = 0; answer && answer.done === false && answer.path && i < POLLS; i++) {
        // Roblox's own path on the same host: never a URL of the caller's
        const next = String(answer.path);
        if (!/^[A-Za-z0-9_\-][A-Za-z0-9_\-/]*$/.test(next))throw new RobloxError(`${what}: an unexpected result path ${next.slice(0, 80)}`);
        await env.sleep(POLL_MS);
        answer = await cloudRequest(env, { method: "GET", url: `${HOST}/${next}`, permission: PERMISSION, what });
      }
      if (answer?.done === false) {
        const error = new RobloxError(`${what}: still computing after ${(POLLS * POLL_MS) / 1000} s; ask again in a moment`);
        error.pending = true;
        throw error;
      }
      return answer;
}

/** A production error: its hash, how many times it happened in the window, and (when the logs keep one) its message and stack */
export interface ProductionError {
  hash: string;
  count: number;
  message?: string;
  stacktrace?: string;
  source?: string;
  firstSeen?: string;
  firstSeenPlaceVersion?: number | null;
}

/** Hashes asked per error-details request (the URL repeats the parameter) */
const DETAILS_BATCH = 20;
/** Hashes counted (the kinds and the total cover these; the details only the --limit most frequent) */
const MAX_HASHES = 100;

export const ANALYTICS_OPS: Record<string, CloudOp> = {
  "analytics.query": {
    write: false,
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      const kind = args.kind ?? "metrics";
      if (!(ANALYTICS_KINDS as readonly string[]).includes(kind)) throw new RobloxError(`kind must be ${ANALYTICS_KINDS.join(" or ")}`);
      const body = args.body ?? defaultAnalyticsBody(ctx.env.now());
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new RobloxError("body must be a JSON object (metric, granularity, startTime, endTime, breakdown, filter)");
      const answer = await analyticsQuery(ctx.env, universeId, kind, body);
      return { universeId, kind, query: body, result: answer };
    },
  },
  /**
   * The live game's errors (Error Reporting, read-only): the most frequent message hashes of the
   * last days (ErrorCount by MessageHash), then each one's message and stack from the error
   * logs. A hash with no log in the window comes back with its count only
   */
  "errors.list": {
    write: false,
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      const days = Number(args.days ?? 3);
      const limit = Number(args.limit ?? 20);
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new RobloxError("days must be a whole number from 1 to 30");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RobloxError("limit must be a whole number from 1 to 100");
      const placeId = args.placeId === undefined ? undefined : idArg(args.placeId, "the place id");
      const day = 24 * 3600 * 1000;
      const now = ctx.env.now();
      const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00Z`;
      const startTime = iso(now - days * day);
      const endTime = iso(now + day);
      const answer = await analyticsQuery(ctx.env, universeId, "metrics", { metric: "ErrorCount", granularity: "None", startTime, endTime, breakdown: ["MessageHash"], limit: MAX_HASHES });
      const errors: ProductionError[] = [];
      for (const v of answer?.response?.values ?? []) {
        const hash = v?.breakdowns?.find((b: any) => b?.dimension === "MessageHash")?.value;
        const count = (v?.dataPoints ?? []).reduce((sum: number, p: any) => sum + (Number(p?.value) || 0), 0);
        if (typeof hash === "string" && /^-?\d+$/.test(hash)) errors.push({ hash, count });
      }
      errors.sort((a, b) => b.count - a.count);
      const top = errors.slice(0, limit);
      // the logs window: the same days as the counts, ending now
      const detailsEnd = new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
      for (let i = 0; i < top.length; i += DETAILS_BATCH) {
        const batch = top.slice(i, i + DETAILS_BATCH);
        const query = [...batch.map((e) => `messageHashIds=${encodeURIComponent(e.hash)}`), `startTime=${startTime}`, `endTime=${detailsEnd}`, ...(placeId ? [`placeId=${placeId}`] : [])].join("&");
        const details = await cloudRequest(ctx.env, { method: "GET", url: `${ERRORS_HOST}/universe/${universeId}/log-details?${query}`, permission: PERMISSION, what: `the error logs of universe ${universeId}` });
        for (const d of details?.values ?? []) {
          const e = batch.find((x) => x.hash === String(d?.id));
          if (!e) continue;
          e.message = typeof d.message === "string" ? d.message : undefined;
          e.stacktrace = typeof d.stacktrace === "string" ? d.stacktrace : undefined;
          e.source = typeof d.logSource === "string" ? d.logSource : undefined;
          e.firstSeen = typeof d.firstSeenUtc === "string" ? d.firstSeenUtc : undefined;
          if (placeId) e.firstSeenPlaceVersion = typeof d.firstSeenPlaceVersion === "number" ? d.firstSeenPlaceVersion : null;
        }
      }
      return { universeId, days, startTime, endTime, total: errors.reduce((s, e) => s + e.count, 0), kinds: errors.length, errors: top };
    },
  },
};
