// The Studio queue with several sessions at once (audit of 13/11/26, a manager session running 3
// to 4 children against one Studio). Each test failed before its fix: B1 a session's play left up
// blocked every job for good; B2 a turn's end dropped a waiting session's place in line; B3 a plain
// waiter never got Studio while jobs kept coming (studio-lock.mjs wait now joins exclusive, the
// case tested here); B5 a job ran next to an eval that had timed out; B6 the runner's hold idled
// out in the middle of a job.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlaceQueue, type StudioPort } from "../queue/queue.js";
import { DEFAULT_SETTINGS, type QueueSettings } from "../queue/settings.js";
import { RUNNER } from "../queue/lock.js";
import { removeDir } from "./removeDir.js";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FAST = { windowMs: 30, tickMs: 5, lockRetryMs: 20, syncWaitMs: 50, startRetryMs: 300, phaseTimeoutMs: 2000, capPlayMs: 100 };
const FAST_SETTINGS: QueueSettings = { ...DEFAULT_SETTINGS, lingerSec: 0.3, holdSec: 0, readySec: 0.3, infraWaitSec: [0.05, 0.1], infraTries: 3 };

function makeGame() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-concurrency-"));
  const folder = path.join(tmp, "Game");
  fs.mkdirSync(path.join(folder, "sync", "ServerStorage"), { recursive: true });
  fs.writeFileSync(path.join(folder, "sync", "ServerStorage", "A.luau"), "return 'a'\n");
  fs.writeFileSync(
    path.join(folder, "sourcemap.json"),
    JSON.stringify({ name: "Game", className: "DataModel", children: [{ name: "ServerStorage", className: "ServerStorage", children: [{ name: "A", className: "ModuleScript", filePaths: ["sync/ServerStorage/A.luau"] }] }] }),
  );
  return { tmp, folder };
}

/** A Studio with one play at a time; `-- SLOW <ms>` in a job makes its setup take that long, `-- TIMEOUT` makes its check time out */
function fakeStudio() {
  // startedBy: who started the play through Quack's tools (the daemon's playtest status); none for a play by hand
  const s = { playing: false, startedBy: undefined as string | undefined, starts: 0, stops: 0, running: [] as string[], seq: 0 };
  const port: StudioPort = {
    async studio(tool, args) {
      if (tool === "playtest") {
        if (args.action === "status") return { editConnected: true, playing: s.playing, ...(s.playing && s.startedBy ? { startedBy: s.startedBy } : {}) };
        if (args.action === "start") {
          if (s.playing) throw new Error("a play is already running: stop it first");
          s.playing = true;
          s.startedBy = String(args.caller ?? "cli");
          s.starts++;
          return {};
        }
        if (args.action === "stop") {
          if (!s.playing) throw new Error("no play is running in this place");
          s.playing = false;
          s.startedBy = undefined;
          s.stops++;
          return {};
        }
      }
      if (tool === "logs") return { entries: [], cursor: String(++s.seq) };
      if (tool === "exec") return { ok: true, values: [JSON.stringify([])] };
      if (tool === "eval") {
        if (!s.playing) throw new Error("no play is running in this place");
        const code = String(args.code);
        const phase = /return __run\(__job, "(\w+)"/.exec(code)?.[1];
        if (!phase) {
          if (code.includes("return shared.__quackQueueOwner")) return { ok: true, values: [] };
          return { ok: true, values: ["true"] };
        }
        const name = /--! name: (.*)/.exec(code)?.[1] ?? "?";
        const slow = /-- SLOW (\d+)/.exec(code);
        if (phase === "setup" && slow) {
          s.running.push(name);
          await wait(Number(slow[1]));
          s.running = s.running.filter((n) => n !== name);
        }
        if (phase === "check" && code.includes("-- TIMEOUT")) {
          // The daemon gives up on the eval; Studio keeps running it (it is never cancelled)
          s.running.push(`${name} (check, still running in Studio)`);
          throw new Error("the play server did not answer in 2 s");
        }
        if (phase === "cleanup") return { ok: true, values: [JSON.stringify({ skipped: true })] };
        return { ok: true, values: [JSON.stringify({ ok: true, checks: [] })] };
      }
      if (tool === "play") throw new Error("no worktree play here");
      throw new Error(`fake: no tool ${tool}`);
    },
    async play() {
      throw new Error("no worktree play in this fake");
    },
  };
  return { s, port };
}

function makeQueue(folder: string, port: StudioPort, settings: Partial<QueueSettings> = {}) {
  const lines: string[] = [];
  const queue = new PlaceQueue({ placeId: "1", folder, port, settings: () => ({ ...FAST_SETTINGS, ...settings }), timings: FAST, log: (l) => lines.push(l) });
  return { queue, lines };
}

const job = (name: string, root: string, body = "") => ({
  name,
  files: [] as string[],
  fresh: false,
  root,
  source: `--! name: ${name}\n${body}\nreturn { setup = function(ctx) end, check = function(ctx) end }`,
});

/** What the hub does every second: tick the queue (it ends idle and dead holds) */
function ticking(queue: PlaceQueue, everyMs = 50): () => void {
  const timer = setInterval(() => queue.tick(), everyMs);
  return () => clearInterval(timer);
}

async function verdictWithin(queue: PlaceQueue, id: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const st = queue.jobStatus(id);
    if (st.state === "done") return st.verdict!;
    await wait(20);
  }
  return null;
}

const sessionA = { id: "session-a", name: "session A", pid: process.pid };
const sessionB = { id: "session-b", name: "session B", pid: process.pid };

// ---------------------------------------------------------------------------------------
// B1. A session's play outlives its hold: the queue never stops it and every job waits forever

test("B1a: a session ends its turn with its solo play up (Stop hook: release-all): the queue stops that play and runs the jobs", { timeout: 20_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio();
  const { queue } = makeQueue(folder, port);
  const stopTicks = ticking(queue);
  try {
    // Session A: the hook claims for solo_playtest start, the play goes up
    assert.equal(queue.lock.claim(sessionA, "quack solo_playtest").ok, true);
    s.playing = true;
    s.startedBy = "mcp-1234";
    // Session B submits a test job: it waits for A
    const j = queue.submit(sessionB, job("B's test", folder));
    await wait(200);
    // A's turn ends without solo_playtest stop: the Stop hook posts /api/queue/release-all
    queue.lock.releaseAll(sessionA.id);
    const verdict = await verdictWithin(queue, j.id, 4000);
    assert.ok(
      verdict?.pass === true,
      `B's job never ran (verdict: ${verdict ? JSON.stringify({ pass: verdict.pass, reason: verdict.reason }) : "none"}): phase "${queue.status().phase}", play still up: ${s.playing}, stops: ${s.stops}. The play A left up is "a play the queue did not start" and is never stopped`,
    );
  } finally {
    stopTicks();
    queue.stop();
    await queue.idle();
    // The runner schedules a save on its way out: stop() again runs it now, before the folder goes
    queue.stop();
    await removeDir(tmp);
  }
});

test("B1b: a holder idle 3 min while a job waits loses Studio (idle-waiting): the queue stops the play it left up", { timeout: 20_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio();
  // 3 min shrunk to 0.6 s
  const { queue } = makeQueue(folder, port, { lockIdleWaitingMin: 0.01 });
  const stopTicks = ticking(queue);
  try {
    assert.equal(queue.lock.claim(sessionA, "quack solo_playtest").ok, true);
    s.playing = true;
    s.startedBy = "mcp-1234";
    const j = queue.submit(sessionB, job("B's test", folder));
    await wait(1500);
    assert.notEqual(queue.lock.state.holder?.client.id, sessionA.id, "A's hold ended (idle-waiting)");
    const verdict = await verdictWithin(queue, j.id, 3000);
    assert.ok(verdict?.pass === true, `B's job never ran (verdict: ${verdict ? verdict.reason ?? "fail" : "none"}): phase "${queue.status().phase}", play still up: ${s.playing}, stops: ${s.stops}`);
  } finally {
    stopTicks();
    queue.stop();
    await queue.idle();
    // The runner schedules a save on its way out: stop() again runs it now, before the folder goes
    queue.stop();
    await removeDir(tmp);
  }
});

test("B1c: after the app's 'free the lock' button (force-release) the queue stops the play left up", { timeout: 20_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio();
  const { queue } = makeQueue(folder, port);
  try {
    assert.equal(queue.lock.claim(sessionA, "quack solo_playtest").ok, true);
    s.playing = true;
    s.startedBy = "mcp-1234";
    const j = queue.submit(sessionB, job("B's test", folder));
    await wait(200);
    queue.lock.release(null, true);
    const verdict = await verdictWithin(queue, j.id, 4000);
    assert.ok(verdict?.pass === true, `B's job never ran after force-release (verdict: ${verdict ? verdict.reason ?? "fail" : "none"}): phase "${queue.status().phase}", play still up: ${s.playing}`);
  } finally {
    queue.stop();
    await queue.idle();
    // The runner schedules a save on its way out: stop() again runs it now, before the folder goes
    queue.stop();
    await removeDir(tmp);
  }
});

// ---------------------------------------------------------------------------------------
// B1d.
test("B1d: a play started in Studio by hand (no startedBy) is still never stopped: the job waits", { timeout: 20_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio();
  const { queue } = makeQueue(folder, port);
  try {
    s.playing = true;
    const j = queue.submit(sessionB, job("B's test", folder));
    await wait(800);
    assert.equal(queue.jobStatus(j.id).state, "pending");
    assert.equal(s.stops, 0);
    assert.equal(s.playing, true);
  } finally {
    queue.stop();
    await queue.idle();
    queue.stop();
    await removeDir(tmp);
  }
});

// ---------------------------------------------------------------------------------------
// B2.The Stop hook's release-all also drops a session that only waits (its `wait` / `exclusive` in the background)

test("B2a: release-all of a session that only waits keeps its place in line (keepPlaceInLine: the hook's Stop)", async () => {
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio();
  const { queue } = makeQueue(folder, port);
  try {
    assert.equal(queue.lock.claim(sessionA, "quack solo_playtest").ok, true);
    // B runs `studio-lock.mjs wait` in the background: its pid is the wait's own process
    queue.lock.join({ client: { ...sessionB, pid: process.pid }, task: "click the shop", holdMin: 3, level: "update", rush: false, exclusive: false });
    // B's turn ends while it waits (run_in_background ends the turn): Stop -> /api/queue/release-all { client: { id: B } }
    queue.lock.releaseAll(sessionB.id, true);
    assert.equal(queue.lock.state.waiters.length, 1, "B lost its place in line while its wait process still runs");
  } finally {
    queue.stop();
    await removeDir(tmp);
  }
});

test("B2b: an exclusive waiter whose turn ends while the runner is busy still gets Studio before the next job", { timeout: 20_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio();
  const { queue } = makeQueue(folder, port, { lingerSec: 5 });
  try {
    // The runner is in the middle of a job when B asks for Studio live (studio-test.mjs exclusive, in the background)
    const first = queue.submit(sessionA, job("A's test", folder, "-- SLOW 1500"));
    const started = Date.now() + 3000;
    while (Date.now() < started && queue.status().running?.id !== first.id) await wait(20);
    queue.lock.join({ client: { ...sessionB }, task: "drive the shop", holdMin: 5, level: "update", rush: false, exclusive: true });
    // B's turn ends while `exclusive` polls: the Stop hook's release-all
    queue.lock.releaseAll(sessionB.id, true);
    // Another session's job arrives before the first one ends
    const second = queue.submit(sessionA, job("A's second test", folder, "-- SLOW 3000"));
    // Right: the first job ends and the runner hands Studio to B before the second job.
    // Wrong: B is out of line, the runner keeps Studio and runs the second job.
    let claimed = false;
    let secondRan = false;
    const until = Date.now() + 4000;
    while (Date.now() < until && !claimed && !secondRan) {
      secondRan = queue.status().running?.id === second.id;
      if (!secondRan) claimed = queue.lock.claim(sessionB, "studio-test exclusive").ok;
      await wait(20);
    }
    assert.ok(claimed && !secondRan, `B never got Studio: the runner ran the second job first (${secondRan}); B in line: ${queue.lock.state.waiters.length}, holder ${queue.lock.state.holder?.client.id}, plays started: ${s.starts}`);
  } finally {
    queue.stop();
    await queue.idle();
    // The runner schedules a save on its way out: stop() again runs it now, before the folder goes
    queue.stop();
    await removeDir(tmp);
  }
});

// ---------------------------------------------------------------------------------------
// B3. A plain waiter (studio-lock.mjs wait joins non-exclusive) never gets Studio while jobs keep coming

test("B3: a waiter (studio-lock.mjs wait joins exclusive) gets Studio within a few batches while other sessions keep submitting jobs", { timeout: 30_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio();
  const { queue } = makeQueue(folder, port);
  let feeding = true;
  try {
    // Three sessions submit a job each, again as soon as each verdict comes
    const feeders = ["c1", "c2", "c3"].map(async (id) => {
      while (feeding) {
        const j = queue.submit({ id, pid: process.pid }, job(`${id} job`, folder));
        await verdictWithin(queue, j.id, 3000);
      }
    });
    await wait(300);
    queue.lock.join({ client: sessionB, task: "fix the crash the user reported", holdMin: 1, level: "critical", rush: true, exclusive: true });
    let got = false;
    const end = Date.now() + 4000;
    let holder: string | undefined;
    while (Date.now() < end && !got) {
      // `studio-lock.mjs wait` claims every 2 s; here every 50 ms
      const c = queue.lock.claim(sessionB, "studio-lock wait");
      got = c.ok;
      if (!c.ok) holder = c.holder?.client.id;
      await wait(50);
    }
    feeding = false;
    await Promise.all(feeders);
    assert.ok(got, `a RUSH critical waiter never got Studio in 4 s; the holder each time: ${holder} (the runner skips the line and only yields to exclusive waiters)`);
  } finally {
    feeding = false;
    queue.stop();
    await queue.idle();
    // The runner schedules a save on its way out: stop() again runs it now, before the folder goes
    queue.stop();
    await removeDir(tmp);
  }
});

// ---------------------------------------------------------------------------------------
// B5. A phase that timed out keeps running in Studio, and the next job joins that play

test("B5: after a job's phase times out, the next job gets a play of its own, never the one where that eval may still run", { timeout: 20_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio();
  const { queue } = makeQueue(folder, port, { lingerSec: 2 });
  try {
    const a = queue.submit(sessionA, job("A's test", folder, "-- TIMEOUT"));
    const va = await verdictWithin(queue, a.id, 4000);
    assert.ok(va && !va.pass && !va.infra, "A failed in its own run");
    assert.match(JSON.stringify(va!.phases ?? {}), /did not answer in \d+ s/, "A failed by the check's timeout");
    const b = queue.submit(sessionB, job("B's test", folder));
    const vb = await verdictWithin(queue, b.id, 4000);
    assert.ok(vb?.pass === true, `B ran and passed (verdict: ${vb ? vb.reason ?? "fail" : "none"})`);
    assert.notEqual(
      vb!.play,
      "joined the running play",
      `B ran in the play where A's check still runs (${s.running.join(", ")}); plays started ${s.starts}, stops ${s.stops}`,
    );
  } finally {
    queue.stop();
    await queue.idle();
    // The runner schedules a save on its way out: stop() again runs it now, before the folder goes
    queue.stop();
    await removeDir(tmp);
  }
});

// ---------------------------------------------------------------------------------------
// B6. The runner's own hold idles out in the middle of a long job

test("B6: the runner keeps Studio while one of its jobs runs a long phase", { timeout: 20_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio();
  // lockIdleMin 15 min shrunk to 0.9 s; the job's setup takes 2 s (a real one may take 2 min per phase)
  const { queue } = makeQueue(folder, port, { lockIdleMin: 0.015 });
  const stopTicks = ticking(queue);
  try {
    const a = queue.submit(sessionA, job("long job", folder, "-- SLOW 2000"));
    // Wait until the job is running
    const end = Date.now() + 3000;
    while (Date.now() < end && queue.status().running === null) await wait(20);
    await wait(1400);
    const taken = queue.lock.claim(sessionB, "quack solo_playtest");
    assert.equal(taken.ok, false, "another session took Studio (and may stop the play) while the runner's job was in its setup");
    await verdictWithin(queue, a.id, 4000);
    assert.equal(queue.lock.state.holder?.client.id === RUNNER.id || queue.lock.state.holder === null, true);
  } finally {
    stopTicks();
    queue.stop();
    await queue.idle();
    // The runner schedules a save on its way out: stop() again runs it now, before the folder goes
    queue.stop();
    await removeDir(tmp);
  }
});
