// What the Queue tab decides from the hub's /api/queue answer, apart from the DOM so a test can
// run it in node. An older hub sends no `stuck`, `recent` or `today.notRun`: each helper then
// answers what the tab showed before them.

/**
 * What holds every job back, or null: "refused" (Studio refuses every play start) or
 * "foreign-play" (a play Quack did not start is up, e.g. a Local Server test), for how long, the
 * reason and how many tries. A hub from before `kind` sent only refusals.
 */
export function stuckOf(q, now) {
  const s = q?.stuck;
  if (!s || typeof s.since !== "number") return null;
  return { kind: s.kind === "foreign-play" ? "foreign-play" : "refused", forMs: Math.max(0, now - s.since), error: s.error ?? "", tries: s.tries ?? 0 };
}

/** Why a pending job waits: "stuck" (Studio refuses the play), "infra" (an infra try), or null */
export function jobWait(j) {
  if (j?.stuck) return "stuck";
  if (j?.infra) return "infra";
  return null;
}

/** The day's answered jobs, newest first; [] from a hub that does not send them */
export function recentOf(q) {
  return Array.isArray(q?.recent) ? q.recent.filter((r) => r && (r.verdict === "pass" || r.verdict === "fail" || r.verdict === "infra")) : [];
}

/**
 * The Today card's numbers. With `notRun` the hub counts the jobs that never ran apart, so the
 * "infra" reason leaves the failures (it is the not-run count, not a test that failed). An older
 * hub: notRun is null and the failures stay as they were.
 */
export function todayOf(d) {
  const notRun = typeof d?.notRun === "number" ? d.notRun : null;
  const failures = Object.entries(d?.failures ?? {}).filter(([k, n]) => n > 0 && !(notRun !== null && k === "infra"));
  return { notRun, failures };
}

/** The settings rows the hub knows: a key an older hub lacks is left out, never shown "undefined" */
export function knownFields(fields, settings) {
  return fields.filter(([key]) => settings?.[key] !== undefined);
}
