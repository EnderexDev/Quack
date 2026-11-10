import { RobloxError } from "../control/roblox.js";
import type { CloudOp } from "./ops.js";
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

export const ANALYTICS_OPS: Record<string, CloudOp> = {
  "analytics.query": {
    write: false,
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      const kind = args.kind ?? "metrics";
      if (!(ANALYTICS_KINDS as readonly string[]).includes(kind)) throw new RobloxError(`kind must be ${ANALYTICS_KINDS.join(" or ")}`);
      const body = args.body ?? defaultAnalyticsBody(ctx.env.now());
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new RobloxError("body must be a JSON object (metric, granularity, startTime, endTime, breakdown, filter)");
      const what = `the analytics ${kind} of universe ${universeId}`;
      let answer = await cloudRequest(ctx.env, { method: "POST", url: `${HOST}/v1/universes/${universeId}/${kind}`, body, permission: PERMISSION, what });
      for (let i = 0; answer && answer.done === false && answer.path && i < POLLS; i++) {
        // Roblox's own path on the same host: never a URL of the caller's
        const next = String(answer.path);
        if (!/^[A-Za-z0-9_\-][A-Za-z0-9_\-/]*$/.test(next))throw new RobloxError(`${what}: an unexpected result path ${next.slice(0, 80)}`);
        await ctx.env.sleep(POLL_MS);
        answer = await cloudRequest(ctx.env, { method: "GET", url: `${HOST}/${next}`, permission: PERMISSION, what });
      }
      if (answer?.done === false) {
        const error = new RobloxError(`${what}: still computing after ${(POLLS * POLL_MS) / 1000} s; ask again in a moment`);
        error.pending = true;
        throw error;
      }
      return { universeId, kind, query: body, result: answer };
    },
  },
};
