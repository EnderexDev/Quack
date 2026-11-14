import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "ui");
const read = (name: string) => fs.readFileSync(path.join(ui, name), "utf8");

/** The keys of one language's block in i18n.js */
function keysOf(language: "en" | "pt"): Set<string> {
  const text = read("i18n.js");
  const start = text.indexOf(`  ${language}: {`);
  const end = language === "en" ? text.indexOf("  pt: {") : text.indexOf("\n};", start);
  return new Set([...text.slice(start, end).matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]));
}

test("app: the Queue tab and the Queue settings have every string in English and Portuguese", () => {
  assert.match(read("index.html"), /data-view="queue" data-t="queue"/);
  const main = read("main.js");
  assert.match(main, /if \(ui\.view === "queue"\) return renderQueue\(target\)/);
  const used = new Set([...main.matchAll(/t\("((?:queue|qs)\w*)"/g)].map((m) => m[1]));
  for (const m of main.matchAll(/\["\w+", "(qs\w+)"\]/g)) used.add(m[1]);
  assert.ok(used.size > 30, `${used.size} queue strings found`);
  for (const language of ["en", "pt"] as const) {
    const keys = keysOf(language);
    const missing = [...used].filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `${language} is missing ${missing.join(", ")}`);
  }
});

test("app: Settings > Queue offers every timing the hub keeps", async () => {
  const { DEFAULT_SETTINGS } = await import("../queue/settings.js");
  const main = read("main.js");
  const fields = new Set([...main.matchAll(/\["(\w+)", "qs\w+"\]/g)].map((m) => m[1]));
  fields.add("sharedRetry"); // a choice of two, not a number
  assert.deepEqual([...fields].sort(), Object.keys(DEFAULT_SETTINGS).sort());
});

// 14/11/26: Studio refused every queue play for 6 minutes and the tab showed the 7 jobs it never
// ran as tests (Today: 8 tests, 0 passed, "INFRA 7"). The tab now says Studio is stuck, offers
// Unstick, keeps the not-run jobs apart, and still reads an older hub that sends none of it.
type View = {
  stuckOf(q: unknown, now: number): { kind: "refused" | "foreign-play"; forMs: number; error: string; tries: number } | null;
  jobWait(j: unknown): "stuck" | "infra" | null;
  recentOf(q: unknown): { verdict: string; name: string }[];
  todayOf(d: unknown): { notRun: number | null; failures: [string, number][] };
  knownFields(fields: [string, string][], settings: unknown): [string, string][];
};
const loadView = async (): Promise<View> => import(pathToFileURL(path.join(ui, "queueview.js")).href);

test("app queue: Studio refusing the play shows how long, and nothing when it is not stuck or the hub is older", async () => {
  const v = await loadView();
  // a hub from before `kind` sent only refusals
  assert.deepEqual(v.stuckOf({ stuck: { since: 1_000, error: "a previous one is still in progress", tries: 7 } }, 181_000), {
    kind: "refused",
    forMs: 180_000,
    error: "a previous one is still in progress",
    tries: 7,
  });
  assert.equal(v.stuckOf({ stuck: { kind: "refused", since: 1, error: "e", tries: 1 } }, 2)!.kind, "refused");
  // a play Quack did not start (a Local Server test started in Studio): the same banner and Unstick
  assert.deepEqual(v.stuckOf({ stuck: { kind: "foreign-play", since: 1_000, error: "a play Quack did not start is up", tries: 4 } }, 61_000), {
    kind: "foreign-play",
    forMs: 60_000,
    error: "a play Quack did not start is up",
    tries: 4,
  });
  assert.equal(v.stuckOf({ stuck: { kind: "something new", since: 1, error: "e", tries: 1 } }, 2)!.kind, "refused", "an unknown kind reads as a refusal");
  assert.equal(v.stuckOf({ stuck: null }, 5), null);
  assert.equal(v.stuckOf({}, 5), null, "an older hub sends no stuck");
  // a pending job waiting on a stuck Studio is that, not an infra try
  assert.equal(v.jobWait({ stuck: { since: 1, last: "refused" } }), "stuck");
  assert.equal(v.jobWait({ stuck: { since: 1, last: "refused" }, infra: { tries: 1 } }), "stuck");
  assert.equal(v.jobWait({ infra: { tries: 2, last: "x", retryInMs: 1 } }), "infra");
  assert.equal(v.jobWait({}), null);
});

test("app queue: the not-run jobs are their own count, never a failure reason, and an older hub reads as before", async () => {
  const v = await loadView();
  const now = v.todayOf({ jobs: 1, passed: 0, notRun: 7, failures: { infra: 7, assert: 1 } });
  assert.equal(now.notRun, 7);
  assert.deepEqual(now.failures, [["assert", 1]], "infra is the not-run count, not a tested failure");
  const old = v.todayOf({ jobs: 8, passed: 0, failures: { infra: 7, assert: 1 } });
  assert.equal(old.notRun, null);
  assert.deepEqual(old.failures, [["infra", 7], ["assert", 1]]);
  assert.deepEqual(v.todayOf({}).failures, []);
  // the recent answers: a hub without them gives none; an unknown verdict is dropped
  const recent = [{ id: "a", name: "a", verdict: "infra" }, { id: "b", name: "b", verdict: "pass" }, { id: "c", name: "c", verdict: "fail" }, { id: "d", name: "d", verdict: "?" }];
  assert.deepEqual(v.recentOf({ recent }).map((r) => r.name), ["a", "b", "c"]);
  assert.deepEqual(v.recentOf({}), []);
});

test("app queue: the tab wires the stuck line, Unstick, the stuck pill, Recent and the not-run tile", async () => {
  const main = read("main.js");
  const view = main.slice(main.indexOf("async function renderQueue("), main.indexOf("function renderFolder("));
  assert.ok(view.includes('api.post("/api/queue/unstick", { placeId })'), "Unstick calls the hub");
  assert.match(view, /if \(stuck\) \{[\s\S]*unstickArmed/, "Unstick only when stuck, armed by a first click of its own");
  assert.match(view, /r\?\.ok === false/, "an answer with ok false toasts as an error");
  // each kind reads right: a refusal says how many tries, a foreign play says a play Quack did not start is up
  assert.match(view, /stuck\.kind === "foreign-play"\s*\?\s*t\("queueForeignPlay", \{ d: span\(stuck\.forMs\) \}\)\s*:\s*t\("queueStuck", \{ d: span\(stuck\.forMs\) \}\)/);
  assert.match(view, /wait === "stuck" \? h\("span", \{ class: "pill bad", title: j\.stuck\.last/);
  assert.match(view, /t\("queueRecentNotRun"\)/);
  assert.match(view, /t\("queueNotRun"\)/);
  // a settings key an older hub lacks is left out instead of showing "undefined"
  const v = await loadView();
  assert.deepEqual(v.knownFields([["a", "qsA"], ["stuckRetrySec", "qsStuckRetrySec"]], { a: 1 }), [["a", "qsA"]]);
  assert.match(main, /knownFields\(QUEUE_FIELDS, settings\)/);
});

test("cli queue: the stuck line reads right for a refusal and for a play Quack did not start", async () => {
  const { queueText } = await import("../control/commands.js");
  const base = { placeId: "1", name: "Game", phase: "idle", jobs: [] };
  const refused = queueText({ ...base, stuck: { kind: "refused", since: Date.now() - 180_000, error: "a previous one is still in progress", tries: 7 } });
  assert.match(refused, /STUCK: Studio refused 7 play start\(s\) in the last 3 min \(a previous one is still in progress\)/);
  assert.doesNotMatch(refused, /since .* ago/);
  const foreign = queueText({ ...base, stuck: { kind: "foreign-play", since: Date.now() - 60_000, error: "a play Quack did not start is up", tries: 3 } });
  assert.match(foreign, /STUCK: a play Quack did not start is up \(for 1 min\); no job is answered for it/);
});

// 14/11/26, Ender in the Dev app: the click stopped the play, but nothing told him so. The stop
// takes 9 to 13 s, the hub then reports no stuck state and the row vanished; the toast was the
// hub's English text for 2.2 s
test("app: Unstick says it works while the play stops, and its success toast is his language and stays", () => {
  const main = read("main.js");
  assert.match(main, /stuckOf\(q, Date\.now\(\)\) \?\? \(unsticking \? lastStuck : null\)/, "the row stays while the stop runs");
  assert.match(main, /unsticking \? t\("queueUnsticking"\)/, "the button says it works");
  assert.match(main, /toast\(t\("queueUnstuck"\), false, 6000\)/, "success: the translated text, 6 s");
  assert.match(read("common.js"), /export function toast\(text, bad = false, ms = /, "toast takes a duration");
  const i18n = read("i18n.js");
  assert.equal((i18n.match(/queueUnsticking:/g) ?? []).length, 2, "en and pt");
});
