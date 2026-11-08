import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fnv1a, planGroups } from "../queue/disk.js";
import { RUNNER, StudioLock, rankWaiters, type GrantRecord, type Waiter } from "../queue/lock.js";
import { PRELUDE } from "../queue/prelude.js";
import { PlaceQueue, type StudioPort, type Verdict } from "../queue/queue.js";
import { DEFAULT_SETTINGS, effectiveSettings, loadSettings, saveSettings, type QueueSettings } from "../queue/settings.js";
import { removeDir } from "./removeDir.js";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------
// The lock and its waiting list

function lockWith(opts: { now: { t: number }; alive?: Set<number>; pending?: { count: number; oldest: number | null }; settings?: Partial<QueueSettings> }) {
  const ended: GrantRecord[] = [];
  const settings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const pending = opts.pending ?? { count: 0, oldest: null };
  const lock = new StudioLock({
    now: () => opts.now.t,
    alive: (pid) => (opts.alive ? opts.alive.has(pid) : true),
    settings: () => settings,
    pending: () => pending,
    onGrantEnd: (r) => ended.push(r),
  });
  return { lock, ended, pending };
}

const waiter = (id: string, level: Waiter["level"], holdMin: number, since: number, extra: Partial<Waiter> = {}): Waiter => ({
  client: { id, pid: 1 },
  task: id,
  holdMin,
  level,
  rush: false,
  since,
  exclusive: false,
  ...extra,
});

test("waiting list: rush first, then level, then the shorter hold, then who came first", () => {
  const list = [
    waiter("low-early", "low", 5, 0),
    waiter("normal-long", "normal", 20, 1000),
    waiter("normal-short", "normal", 5, 2000),
    waiter("normal-short-later", "normal", 5, 3000),
    waiter("critical", "critical", 30, 4000),
    waiter("rush-low", "low", 30, 5000, { rush: true }),
  ];
  assert.deepEqual(
    rankWaiters(list, 6000, 10).map((w) => w.client.id),
    ["rush-low", "critical", "normal-short", "normal-short-later", "normal-long", "low-early"],
  );
});

test("waiting list: a level rises one step per agingMin waited, so nothing starves", () => {
  const now = { t: 0 };
  const { lock } = lockWith({ now, settings: { agingMin: 10 } });
  lock.join({ client: { id: "low", pid: 1 }, task: "", holdMin: 5, level: "low", rush: false, exclusive: false });
  now.t = 25 * 60_000; // low -> update after two steps
  lock.join({ client: { id: "normal", pid: 1 }, task: "", holdMin: 5, level: "normal", rush: false, exclusive: false });
  assert.deepEqual(lock.ranked().map((w) => w.client.id), ["low", "normal"]);
  // Without aging the newer "normal" would be ahead
  const { lock: frozen } = lockWith({ now, settings: { agingMin: 1000 } });
  frozen.join({ client: { id: "low", pid: 1 }, task: "", holdMin: 5, level: "low", rush: false, exclusive: false, since: 0 });
  frozen.join({ client: { id: "normal", pid: 1 }, task: "", holdMin: 5, level: "normal", rush: false, exclusive: false });
  assert.deepEqual(frozen.ranked().map((w) => w.client.id), ["normal", "low"]);
});

test("lock: a free Studio goes to the head of the line, the runner skips the line, a grant records asked vs held", () => {
  const now = { t: 1000 };
  const { lock, ended } = lockWith({ now });
  lock.join({ client: { id: "a", pid: 1 }, task: "first", holdMin: 10, level: "normal", rush: false, exclusive: false });
  lock.join({ client: { id: "b", pid: 1 }, task: "urgent", holdMin: 3, level: "critical", rush: false, exclusive: false });
  const refused = lock.claim({ id: "a", pid: 1 }, "tool");
  assert.equal(refused.ok, false);
  assert.deepEqual((refused as any).queue.map((w: Waiter) => w.client.id), ["b"]);
  assert.equal(lock.claim({ id: "b", pid: 1 }, "tool").ok, true);
  assert.equal(lock.claim({ id: "a", pid: 1 }, "tool").ok, false, "held by b");
  now.t += 4 * 60_000;
  assert.ok(lock.release("b"));
  assert.equal(ended.length, 1);
  assert.equal(ended[0].requestedMin, 3);
  assert.equal(ended[0].heldMs, 4 * 60_000);
  assert.equal(ended[0].endedBy, "release");
  // The runner takes a free Studio even with a client in line
  assert.equal(lock.claim(RUNNER, "queue").ok, true);
  assert.ok(lock.release(RUNNER.id));
  assert.equal(lock.claim({ id: "a", pid: 1 }, "tool").ok, true, "a is the head now");
});

test("lock: a client whose process ends loses its lock and its place in line", () => {
  const now = { t: 0 };
  const alive = new Set([10, 20]);
  const { lock, ended } = lockWith({ now, alive });
  assert.equal(lock.claim({ id: "holder", pid: 10 }, "t").ok, true);
  lock.join({ client: { id: "waiting", pid: 20 }, task: "", holdMin: 5, level: "normal", rush: false, exclusive: false });
  alive.delete(10);
  alive.delete(20);
  assert.equal(lock.tick(), "gone");
  assert.equal(lock.state.holder, null);
  assert.equal(lock.state.waiters.length, 0);
  assert.equal(ended[0].endedBy, "gone");
});

test("lock: idle ends a hold after lockIdleMin, or lockIdleWaitingMin while someone waits; the runner has no short limit", () => {
  const now = { t: 0 };
  const { lock, pending } = lockWith({ now, settings: { lockIdleMin: 15, lockIdleWaitingMin: 3 } });
  lock.claim({ id: "a" }, "t");
  now.t = 4 * 60_000;
  assert.equal(lock.tick(), null, "nobody waits: 15 min");
  lock.join({ client: { id: "b", pid: 1 }, task: "", holdMin: 5, level: "normal", rush: false, exclusive: false });
  assert.equal(lock.tick(), "idle-waiting");
  lock.leave("b");
  lock.claim({ id: "a" }, "t");
  now.t += 16 * 60_000;
  assert.equal(lock.tick(), "idle");
  // The runner with a job waiting idles out only at the long limit
  pending.count = 1;
  pending.oldest = now.t;
  lock.claim(RUNNER, "queue");
  now.t += 4 * 60_000;
  assert.equal(lock.tick(), null);
});

test("lock: a hold past the cap with a job waiting ends; the client gets Studio back only after a batch", () => {
  const now = { t: 0 };
  const { lock, pending, ended } = lockWith({ now, settings: { capMin: 5 } });
  lock.claim({ id: "a" }, "t");
  now.t = 7 * 60_000;
  lock.touch("a");
  assert.equal(lock.tick(), null, "no job waits: no cap");
  pending.count = 1;
  pending.oldest = 6 * 60_000; // waited 1 min so far
  assert.equal(lock.tick(), null);
  now.t = 11.5 * 60_000; // the job waited 5.5 min
  lock.touch("a");
  assert.equal(lock.tick(), "cap");
  assert.equal(ended.at(-1)!.endedBy, "cap");
  const refused = lock.claim({ id: "a" }, "t");
  assert.equal(refused.ok, false);
  assert.equal((refused as any).capped.pending, 1);
  assert.equal(lock.claim({ id: "someone-else" }, "t").ok, true, "only the capped client waits");
  lock.release("someone-else");
  now.t += 1000;
  lock.batchDone();
  assert.equal(lock.claim({ id: "a" }, "t").ok, true);
});

test("lock: an exclusive waiter capped is not served before the batch", () => {
  const now = { t: 0 };
  const { lock, pending } = lockWith({ now });
  pending.count = 1;
  pending.oldest = 0;
  lock.state.cap = { clientId: "x", at: 10, waitedMs: 1, capMs: 1 };
  lock.state.capped = [lock.state.cap];
  lock.join({ client: { id: "x", pid: 1 }, task: "", holdMin: 5, level: "normal", rush: false, exclusive: true });
  assert.equal(lock.exclusiveWaiters().length, 0);
  now.t = 20;
  lock.batchDone();
  assert.equal(lock.exclusiveWaiters().length, 1);
});

// ---------------------------------------------------------------------------------------
// Settings

test("settings: defaults, a checked patch saved, and a game's own file on top", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-qs-"));
  try {
    const file = path.join(tmp, "hub-queue.json");
    assert.deepEqual(loadSettings(file), DEFAULT_SETTINGS);
    assert.throws(() => saveSettings(file, { capMin: -1 }), /capMin/);
    assert.throws(() => saveSettings(file, { sharedRetry: "some" }), /sharedRetry/);
    const saved = saveSettings(file, { capMin: 7, historyDays: 0, infraWaitSec: [5, 10, 20] });
    assert.equal(saved.capMin, 7);
    assert.equal(loadSettings(file).historyDays, 0);
    assert.deepEqual(loadSettings(file).infraWaitSec, [5, 10, 20]);
    const game = path.join(tmp, "Game");
    fs.mkdirSync(path.join(game, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(game, ".claude", "studio-test.json"), JSON.stringify({ placeIds: [1], sharedRetry: "foreign", lingerSec: 5, capMin: "bad" }));
    const effective = effectiveSettings(loadSettings(file), game);
    assert.equal(effective.sharedRetry, "foreign");
    assert.equal(effective.lingerSec, 5);
    assert.equal(effective.capMin, 7, "a bad value in the game's file is ignored, the hub's stays");
    assert.deepEqual(effective.overridden.sort(), ["lingerSec", "sharedRetry"]);
  } finally {
    removeDir(tmp);
  }
});

test("the prelude keeps the ctx every existing job uses", () => {
  for (const member of ["function ctx.check", "function ctx.expect", "function ctx.waitFor", "function ctx.log", "ctx.state =", "ctx.client =", "ctx.player =", "local ctx = { checks = checks }"]) {
    assert.ok(PRELUDE.includes(member), member);
  }
});

test("planGroups: disjoint worktrees share a play, overlapping ones do not, one fresh per play", () => {
  const set = (...k: string[]) => new Set(k);
  const groups = planGroups([
    { folder: "A", files: set("x"), fresh: false },
    { folder: "B", files: set("y"), fresh: true },
    { folder: "C", files: set("x"), fresh: false },
    { folder: "D", files: set("z"), fresh: true },
  ]);
  assert.deepEqual(groups.map((g) => g.map((c) => c.folder)), [["B", "A"], ["D", "C"]]);
});

// ---------------------------------------------------------------------------------------
// A fake Studio behind the place's daemon

interface FakeOptions {
  /** Job phase behaviour from markers in the job's source */
  failShared?: boolean;
  readyAfter?: number;
  infraFirst?: number;
}

function fakeStudio(folder: string, options: FakeOptions = {}) {
  const sourcemap = JSON.parse(fs.readFileSync(path.join(folder, "sourcemap.json"), "utf8"));
  const byInstance = new Map<string, string>();
  (function walk(node: any, names: string[]) {
    for (const child of node.children ?? []) {
      const p = [...names, child.name];
      for (const f of child.filePaths ?? []) byInstance.set(p.join("."), f);
      walk(child, p);
    }
  })(sourcemap, []);
  const s = {
    connected: true,
    playing: false,
    roots: [] as string[],
    plays: [] as string[][],
    stops: 0,
    evals: [] as { peer: string; phase?: string; job?: string }[],
    log: [] as { seq: number; source: string; type: string; message: string }[],
    seq: 0,
    readyCalls: 0,
    infraLeft: options.infraFirst ?? 0,
    unsynced: new Set<string>(),
    playRefuse: null as string | null,
    /** shared.__quackQueueOwner in the running play's server */
    owner: null as string | null,
  };
  const print = (message: string, type = "MessageOutput") => s.log.push({ seq: ++s.seq, source: "server", type, message });
  const port: StudioPort = {
    async studio(tool, args) {
      if (!s.connected) throw new Error("Studio is not connected to this place: open it in Studio and wait for the sync to connect");
      if (tool === "playtest") {
        if (args.action === "status") return { editConnected: true, playing: s.playing };
        if (args.action === "start") {
          if (s.playing) throw new Error("a play is already running: stop it first");
          s.playing = true;
          s.owner = null;
          s.roots = [folder];
          s.plays.push([folder]);
          return { action: "start" };
        }
        if (args.action === "stop") {
          if (!s.playing) throw new Error("no play is running in this place");
          s.playing = false;
          s.owner = null;
          s.stops++;
          return { action: "stop" };
        }
      }
      if (tool === "logs") {
        const cursor = args.cursor === undefined ? undefined : Number(args.cursor);
        const entries = cursor === undefined ? s.log.slice(-1) : s.log.filter((e) => e.seq > cursor);
        return { entries, cursor: String(s.seq) };
      }
      if (tool === "exec") {
        const json = /JSONDecode\(\[=*\[\n([\s\S]*?)\]=*\]\)/.exec(String(args.code))![1];
        const paths: string[][] = JSON.parse(json);
        return {
          ok: true,
          values: [
            JSON.stringify(
              paths.map((p) => {
                const file = byInstance.get(p.join("."));
                if (!file || s.unsynced.has(file)) return -1;
                try {
                  return fnv1a(fs.readFileSync(path.join(folder, file), "utf8"));
                } catch {
                  return -1;
                }
              }),
            ),
          ],
        };
      }
      if (tool === "eval") {
        if (!s.playing) throw new Error("no play is running in this place (start one with solo_playtest, or `playtest start` in the terminal)");
        const code = String(args.code);
        const phase = /return __run\(__job, "(\w+)"/.exec(code)?.[1];
        if (!phase) {
          const mark = /shared\.__quackQueueOwner = "([^"]+)"/.exec(code);
          if (mark) {
            s.owner = mark[1];
            return { ok: true, values: ["true"] };
          }
          if (code.includes("return shared.__quackQueueOwner")) return { ok: true, values: s.owner ? [s.owner] : [] };
          s.readyCalls++;
          return { ok: true, values: [String(s.readyCalls > (options.readyAfter ?? 0))] };
        }
        const name = /--! name: (.*)/.exec(code)?.[1] ?? "?";
        s.evals.push({ peer: String(args.peer), phase, job: name });
        if (phase === "setup" && s.infraLeft > 0 && code.includes("-- INFRA")) {
          s.infraLeft--;
          throw new Error("the play client is not connected: a Run-mode play has no client");
        }
        if (phase === "cleanup") return { ok: true, values: [JSON.stringify({ skipped: true })] };
        if (phase === "check") {
          print(`checking ${name}`);
          const shared = s.roots.length > 1;
          const fail = code.includes("-- FAILCHECK") || (code.includes("-- FAIL_SHARED") && shared);
          if (code.includes("-- ERROR")) {
            print(`ServerStorage.A:3: boom`, "MessageError");
            return { ok: true, values: [JSON.stringify({ ok: false, error: "ServerStorage.A:3: boom", checks: [] })] };
          }
          if (code.includes("-- FOREIGN")) return { ok: true, values: [JSON.stringify({ ok: false, error: "ServerStorage.B:1: theirs", checks: [] })] };
          return { ok: true, values: [JSON.stringify({ ok: true, checks: [{ label: "it works", ok: !fail }] })] };
        }
        return { ok: true, values: [JSON.stringify({ ok: true, checks: [] })] };
      }
      throw new Error(`fake: no tool ${tool}`);
    },
    async play(worktrees) {
      if (s.playing) return { result: { ok: false, error: "a playtest is already running: stop it first" } };
      if (s.playRefuse) throw new Error(s.playRefuse);
      s.playing = true;
      s.owner = null;
      s.roots = [...worktrees];
      s.plays.push([...worktrees]);
      const parts = worktrees.map((w) => ({ worktree: w, patches: 1, creates: 0, disables: 0, checks: 1, conflicts: [], verify: { ok: true, passed: 1, failed: [], unverified: [] } }));
      return { id: String(s.plays.length), worktree: worktrees[0], patches: parts.length, creates: 0, disables: 0, checks: parts.length, conflicts: [], result: { ok: true }, verify: { ok: true, passed: parts.length, failed: [], unverified: [] }, worktrees: parts };
    },
  };
  return { s, port };
}

const FAST = { windowMs: 30, tickMs: 5, lockRetryMs: 20, syncWaitMs: 100, startRetryMs: 300, phaseTimeoutMs: 2000, capPlayMs: 100 };
const FAST_SETTINGS: QueueSettings = { ...DEFAULT_SETTINGS, lingerSec: 0.3, holdSec: 0.6, readySec: 0.3, infraWaitSec: [0.05, 0.1], infraTries: 3 };

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString();
}

/** A synced folder with two scripts and its sourcemap, a git repo with worktrees wtA (changes A) and wtB (changes B) */
function makeGame(withWorktrees = false) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-queue-"));
  const folder = path.join(tmp, "Game");
  fs.mkdirSync(path.join(folder, "sync", "ServerStorage"), { recursive: true });
  fs.writeFileSync(path.join(folder, "sync", "ServerStorage", "A.luau"), "return 'a'\n");
  fs.writeFileSync(path.join(folder, "sync", "ServerStorage", "B.luau"), "return 'b'\n");
  fs.writeFileSync(
    path.join(folder, "sourcemap.json"),
    JSON.stringify({
      name: "Game",
      className: "DataModel",
      children: [
        {
          name: "ServerStorage",
          className: "ServerStorage",
          children: [
            { name: "A", className: "ModuleScript", filePaths: ["sync/ServerStorage/A.luau"] },
            { name: "B", className: "ModuleScript", filePaths: ["sync/ServerStorage/B.luau"] },
          ],
        },
      ],
    }),
  );
  const wt: Record<string, string> = {};
  if (withWorktrees) {
    fs.writeFileSync(path.join(folder, ".gitignore"), ".quack/\n");
    git(folder, "init", "-q", "-b", "main");
    git(folder, "config", "user.email", "t@t");
    git(folder, "config", "user.name", "t");
    git(folder, "add", "-A");
    git(folder, "commit", "-q", "-m", "1");
    for (const [name, file] of [
      ["wtA", "A"],
      ["wtB", "B"],
      ["wtC", "A"],
    ]) {
      wt[name] = path.join(tmp, name);
      git(folder, "worktree", "add", "-q", "-b", name, wt[name]);
      fs.writeFileSync(path.join(wt[name], "sync", "ServerStorage", `${file}.luau`), `return '${name}'\n`);
    }
  }
  return { tmp, folder, wt };
}

const job = (name: string, root: string, body = "", extra: { files?: string[] | null; fresh?: boolean } = {}) => ({
  name,
  files: extra.files === undefined ? ["sync/ServerStorage/A.luau"] : extra.files,
  fresh: extra.fresh ?? false,
  root,
  source: `--! name: ${name}\n${body}\nreturn { setup = function(ctx) end, check = function(ctx) end }`,
});

function makeQueue(folder: string, port: StudioPort, settings: Partial<QueueSettings> = {}, extra: { alive?: (pid: number) => boolean } = {}) {
  const lines: string[] = [];
  const queue = new PlaceQueue({ placeId: "1", folder, port, settings: () => ({ ...FAST_SETTINGS, ...settings }), timings: FAST, log: (l) => lines.push(l), ...extra });
  return { queue, lines };
}

async function verdictOf(queue: PlaceQueue, id: string, ms = 10_000): Promise<Verdict> {
  const end = Date.now() + ms;
  for (;;) {
    const status = queue.jobStatus(id);
    if (status.state === "done") return status.verdict!;
    if (Date.now() > end) throw new Error(`no verdict for ${id}: ${JSON.stringify(status)}`);
    await wait(10);
  }
}

const me = { id: "client-1", name: "tester", pid: process.pid };
const other = { id: "client-2", name: "other", pid: process.pid };

test("queue: jobs that arrive together share one play, a late one joins it, a changed file starts a new one", { timeout: 30_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio(folder);
  const { queue } = makeQueue(folder, port);
  try {
    const a = queue.submit(me, job("first", folder));
    const b = queue.submit(other, job("second", folder));
    const [va, vb] = await Promise.all([verdictOf(queue, a.id), verdictOf(queue, b.id)]);
    assert.equal(va.pass, true, JSON.stringify(va));
    assert.equal(vb.pass, true);
    assert.equal(s.plays.length, 1, "one play for both");
    assert.equal(va.play, "fresh play");
    // While the play lingers, a job whose files did not change joins it
    const c = queue.submit(me, job("late", folder));
    const vc = await verdictOf(queue, c.id);
    assert.equal(vc.play, "joined the running play");
    assert.equal(s.plays.length, 1);
    // A changed file: a new play (after the sync check)
    fs.writeFileSync(path.join(folder, "sync", "ServerStorage", "A.luau"), "return 'a2'\n");
    const d = queue.submit(me, job("after edit", folder));
    const vd = await verdictOf(queue, d.id);
    assert.equal(vd.play, "fresh play");
    assert.equal(s.plays.length, 2);
    await queue.idle();
    assert.equal(s.playing, false, "the play stops after the linger");
    assert.equal(queue.lock.state.holder, null, "the lock goes back");
    const today = queue.stats();
    assert.equal(today.jobs, 4);
    assert.equal(today.plays, 2);
    assert.equal(today.jobsPerPlay, 2);
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});

test("queue: a failed check is a FAIL with its checks, an error in its own code holds the play for the client's fixed job", { timeout: 30_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio(folder);
  const { queue } = makeQueue(folder, port, { holdSec: 2, lingerSec: 0.05 });
  try {
    const bad = queue.submit(me, job("check fails", folder, "-- FAILCHECK"));
    const vbad = await verdictOf(queue, bad.id);
    assert.equal(vbad.pass, false);
    assert.equal(vbad.held, undefined, "a red check holds nothing");
    const err = queue.submit(me, job("own error", folder, "-- ERROR"));
    const verr = await verdictOf(queue, err.id);
    assert.equal(verr.pass, false);
    assert.equal(verr.held, 2);
    assert.ok(verr.console!.some((l) => l.startsWith("ERR ServerStorage.A:3: boom")), JSON.stringify(verr.console));
    const playsBefore = s.plays.length;
    // The fixed job, fresh, runs in the held play with no new play
    await wait(200);
    const fixed = queue.submit(me, job("own error fixed", folder, "", { fresh: true }));
    const vfixed = await verdictOf(queue, fixed.id);
    assert.equal(vfixed.pass, true);
    assert.match(vfixed.play!, /fresh, the play held for its client/);
    assert.equal(s.plays.length, playsBefore);
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});

test("queue: an error naming someone else's module is NOT YOURS and holds nothing", { timeout: 30_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio(folder);
  const { queue } = makeQueue(folder, port);
  try {
    const j = queue.submit(me, job("foreign", folder, "-- FOREIGN"));
    const v = await verdictOf(queue, j.id);
    assert.equal(v.pass, false);
    assert.match(v.notYours!, /ServerStorage\.B \(sync\/ServerStorage\/B\.luau\)/);
    assert.equal(v.held, undefined);
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});

test("queue: infra is retried after a wait and answered as infra only after the tries run out", { timeout: 30_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio(folder, { infraFirst: 1 });
  const { queue } = makeQueue(folder, port);
  try {
    const j = queue.submit(me, job("flaky", folder, "-- INFRA"));
    const v = await verdictOf(queue, j.id);
    assert.equal(v.pass, true, JSON.stringify(v));
    assert.match(v.infraRetried!, /^1 time\(s\), last: executor: a phase call failed/);
    // Studio gone for good: three tries, then infra
    s.connected = false;
    const k = queue.submit(me, job("no studio", folder));
    const vk = await verdictOf(queue, k.id);
    assert.equal(vk.infra, true);
    assert.match(vk.reason!, /^infra \(after 3 tries\): the queue failed: Studio is not connected/);
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});

test("queue: a file Studio does not have is answered at once as infra; readyCheck from the game's file is waited for", { timeout: 30_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio(folder, { readyAfter: 3 });
  fs.mkdirSync(path.join(folder, ".claude"));
  fs.writeFileSync(path.join(folder, ".claude", "studio-test.json"), JSON.stringify({ readyCheck: "return game.Loaded" }));
  const { queue } = makeQueue(folder, port, { readySec: 5 });
  try {
    s.unsynced.add("sync/ServerStorage/A.luau");
    const j = queue.submit(me, job("stale", folder));
    const v = await verdictOf(queue, j.id);
    assert.equal(v.infra, true);
    assert.match(v.reason!, /Studio does not have the disk's version of: sync\/ServerStorage\/A\.luau/);
    s.unsynced.clear();
    const k = queue.submit(me, job("ready", folder));
    const vk = await verdictOf(queue, k.id);
    assert.equal(vk.pass, true);
    assert.ok(s.readyCalls >= 4, `readyCheck polled until true (${s.readyCalls})`);
    assert.equal(vk.syncWarnings, undefined);
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});

test("queue: a play never ready runs the jobs anyway and says so", { timeout: 30_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio(folder, { readyAfter: 1e9 });
  const { queue } = makeQueue(folder, port, { readySec: 0.2 });
  try {
    const v = await verdictOf(queue, queue.submit(me, job("unready", folder)).id);
    assert.equal(v.pass, true);
    assert.match(v.syncWarnings!.join("\n"), /the play was not ready after 0.2 s \(no player on the server: returned false\); the jobs ran anyway/);
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});

test("queue: worktrees with disjoint branches share one play; a shared failure runs again alone (sharedRetry all)", { timeout: 60_000 }, async () => {
  const { tmp, folder, wt } = makeGame(true);
  const { s, port } = fakeStudio(folder);
  const { queue } = makeQueue(folder, port);
  try {
    const a = queue.submit(me, job("on A", wt.wtA, "-- FAIL_SHARED"));
    const b = queue.submit(other, job("on B", wt.wtB, "", { files: ["sync/ServerStorage/B.luau"] }));
    const [va, vb] = await Promise.all([verdictOf(queue, a.id), verdictOf(queue, b.id)]);
    assert.equal(vb.pass, true);
    assert.match(vb.play!, /^shared quack play of 2 worktrees/);
    assert.ok(vb.quackPlay!.some((l) => l.startsWith("shared play with")));
    // A failed in the shared play, then passed alone: the verdict keeps both
    assert.equal(va.pass, true, JSON.stringify(va));
    assert.equal(va.firstRun?.pass, false);
    assert.deepEqual(va.firstRun?.with.map((f) => path.basename(f)), ["wtB"]);
    assert.match(va.play!, /^quack play, branch of/);
    assert.deepEqual(s.plays.map((p) => p.map((f) => path.basename(f))), [["wtA", "wtB"], ["wtA"]]);
    // wtC changes the same script as wtA: it never shares a play with it
    const c = queue.submit(me, job("on C", wt.wtC));
    const a2 = queue.submit(me, job("on A again", wt.wtA, "", { fresh: true }));
    await Promise.all([verdictOf(queue, c.id), verdictOf(queue, a2.id)]);
    assert.ok(!s.plays.slice(2).some((p) => p.length > 1 && p.some((f) => f.endsWith("wtC")) && p.some((f) => f.endsWith("wtA"))), JSON.stringify(s.plays));
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});

test("queue: sharedRetry foreign answers a shared failure at once when no module outside the job is named", { timeout: 60_000 }, async () => {
  const { tmp, folder, wt } = makeGame(true);
  const { s, port } = fakeStudio(folder);
  fs.mkdirSync(path.join(folder, ".claude"));
  fs.writeFileSync(path.join(folder, ".claude", "studio-test.json"), JSON.stringify({ sharedRetry: "foreign" }));
  const { queue } = makeQueue(folder, port);
  try {
    const a = queue.submit(me, job("on A", wt.wtA, "-- FAIL_SHARED"));
    const b = queue.submit(other, job("on B", wt.wtB, "", { files: ["sync/ServerStorage/B.luau"] }));
    const [va] = await Promise.all([verdictOf(queue, a.id), verdictOf(queue, b.id)]);
    assert.equal(va.pass, false);
    assert.deepEqual(va.sharedWith!.map((f) => path.basename(f)), ["wtB"]);
    assert.equal(s.plays.length, 1);
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});

test("queue: an exclusive waiter gets Studio after the batch, the runner stops its play and waits", { timeout: 30_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio(folder);
  const { queue } = makeQueue(folder, port, { lingerSec: 30 });
  try {
    await verdictOf(queue, queue.submit(me, job("warm", folder)).id);
    assert.equal(s.playing, true, "the play lingers");
    queue.lock.join({ client: other, task: "clicks", holdMin: 5, level: "normal", rush: false, exclusive: true });
    queue.kick();
    const end = Date.now() + 5000;
    while (queue.lock.state.holder && Date.now() < end) await wait(10);
    assert.equal(s.playing, false, "the runner stopped its play");
    assert.equal(queue.lock.claim(other, "exclusive").ok, true);
    // A job now waits for the client
    const j = queue.submit(me, job("behind", folder));
    await wait(200);
    assert.equal(queue.jobStatus(j.id).state, "pending");
    queue.lock.release(other.id);
    assert.equal((await verdictOf(queue, j.id)).pass, true);
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});

test("queue: a client's process ending drops its waiting jobs (the running one finishes)", { timeout: 30_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio(folder);
  const alive = new Set([111, 222]);
  const { queue } = makeQueue(folder, port, {}, { alive: (pid) => alive.has(pid) });
  try {
    queue.lock.claim({ id: "holder", pid: 222 }, "t");
    const j = queue.submit({ id: "dying", pid: 111 }, job("orphan", folder));
    alive.delete(111);
    queue.tick();
    const v = await verdictOf(queue, j.id);
    assert.match(v.dropped!, /its client's process ended/);
    alive.delete(222);
    queue.tick();
    assert.equal(queue.lock.state.holder, null, "the dead holder's lock went");
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});

test("queue: a restart keeps the jobs waiting, the lock and the line, and runs the jobs after", { timeout: 30_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio(folder);
  const first = makeQueue(folder, port);
  try {
    first.queue.lock.claim({ id: "holder", name: "holding", pid: process.pid }, "tool");
    first.queue.lock.join({ client: { id: "waiter", pid: process.pid }, task: "next", holdMin: 3, level: "update", rush: false, exclusive: false });
    const j = first.queue.submit(me, job("survives", folder));
    await wait(100);
    assert.equal(first.queue.jobStatus(j.id).state, "pending", "the holder keeps the runner out");
    first.queue.stop();

    const second = makeQueue(folder, port);
    assert.equal(second.queue.lock.state.holder?.client.id, "holder");
    assert.equal(second.queue.lock.ranked()[0].client.id, "waiter");
    assert.equal(second.queue.jobStatus(j.id).state, "pending");
    assert.equal(second.queue.hasWork(), true);
    second.queue.lock.releaseAll("holder");
    second.queue.lock.releaseAll("waiter");
    second.queue.kick();
    assert.equal((await verdictOf(second.queue, j.id)).pass, true);
    second.queue.stop();
    assert.equal(s.plays.length, 1);
  } finally {
    first.queue.stop();
    removeDir(tmp);
  }
});

test("queue: a play the previous hub left up is adopted by its token and stopped; a play someone started is never touched", { timeout: 30_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio(folder);
  try {
    // Someone's own play: the runner waits for it, never stops it
    s.playing = true;
    const one = makeQueue(folder, port, { lingerSec: 60 });
    const j = one.queue.submit(me, job("behind a foreign play", folder));
    await wait(300);
    assert.equal(s.playing, true);
    assert.equal(one.queue.jobStatus(j.id).state, "pending");
    assert.equal(s.stops, 0);
    s.playing = false;
    await verdictOf(one.queue, j.id);
    one.queue.stop(); // the hub restarts with the queue's play still lingering
    assert.equal(s.playing, true);
    assert.ok(s.owner, "the play carries the queue's token");
    const two = makeQueue(folder, port, { lingerSec: 0.1 });
    assert.equal(two.queue.hasWork(), true, "a play to adopt");
    two.queue.kick();
    await two.queue.idle();
    assert.equal(s.stops, 1, "adopted and stopped after the linger");
    assert.equal(s.playing, false);
    two.queue.stop();
    // A play with another token (someone started it after the hub went down) is not adopted
    const three = makeQueue(folder, port, { lingerSec: 60 });
    await verdictOf(three.queue, three.queue.submit(me, job("again", folder)).id);
    three.queue.stop();
    s.owner = "someone-else";
    const four = makeQueue(folder, port, { lingerSec: 0.1 });
    four.queue.kick();
    await four.queue.idle();
    assert.equal(s.stops, 1, "never stopped");
    assert.equal(s.playing, true);
    four.queue.stop();
  } finally {
    removeDir(tmp);
  }
});

test("queue: a hold past the cap while a job waits is ended and the job runs", { timeout: 30_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio(folder);
  const { queue } = makeQueue(folder, port, { capMin: 0.02 }); // 1.2 s
  try {
    queue.lock.claim({ id: "hog", pid: process.pid }, "clicks");
    const j = queue.submit(me, job("waits for the hog", folder));
    const end = Date.now() + 5000;
    while (queue.jobStatus(j.id).state === "pending" && Date.now() < end) {
      queue.tick();
      await wait(50);
    }
    assert.equal((await verdictOf(queue, j.id)).pass, true);
    assert.equal(queue.lock.state.cap?.clientId, "hog");
    const historyDir = path.join(folder, ".quack", "queue", "1", "history");
    const history = fs.readFileSync(path.join(historyDir, fs.readdirSync(historyDir)[0]), "utf8");
    assert.match(history, /"kind":"grant".*"endedBy":"cap"/);
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});

test("queue: history older than historyDays is pruned, 0 keeps it", () => {
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio(folder);
  try {
    const dir = path.join(folder, ".quack", "queue", "1", "history");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "2020-01-01.jsonl"), "{}\n");
    makeQueue(folder, port, { historyDays: 0 }).queue.prune();
    assert.ok(fs.existsSync(path.join(dir, "2020-01-01.jsonl")));
    makeQueue(folder, port, { historyDays: 30 }).queue.prune();
    assert.equal(fs.existsSync(path.join(dir, "2020-01-01.jsonl")), false);
  } finally {
    removeDir(tmp);
  }
});

// ---------------------------------------------------------------------------------------
// Through the hub's API

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as import("node:net").AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function api(port: number, method: "GET" | "POST", pathname: string, body?: unknown): Promise<{ status: number; body: any }> {
  const http = await import("node:http");
  const payload = body === undefined ? undefined : JSON.stringify(body);
  // A fresh connection each call: a kept-alive one dies with the hub a test restarts
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: pathname, agent: false, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || "null") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

test("hub API: capability, settings, the lock and its line, a job kept over a hub restart", { timeout: 60_000 }, async () => {
  const { QuackHub } = await import("../hub/hub.js");
  const { saveRegistry } = await import("../hub/registry.js");
  const { tmp, folder } = makeGame();
  const registryFile = path.join(tmp, "hub.json");
  saveRegistry(registryFile, { places: { "555": { folder, name: "Game" } } });
  const daemonCli = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..", "cli.js");
  const settingsFile = path.join(tmp, "hub-queue.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ infraWaitSec: [30], infraTries: 3 }));
  const port = await freePort();
  const options = { port, registryFile, daemonCli, log: () => {}, queue: { timings: FAST, tickMs: 50, settingsFile } };
  let hub = new QuackHub(options);
  await hub.start();
  try {
    const state = (await api(port, "GET", "/api/state")).body;
    assert.deepEqual(state.capabilities, ["queue"]);

    assert.equal((await api(port, "POST", "/api/queue/settings", { settings: { capMin: -3 } })).status, 400);
    const set = await api(port, "POST", "/api/queue/settings", { settings: { capMin: 4 } });
    assert.equal(set.body.settings.capMin, 4);
    assert.equal((await api(port, "GET", "/api/queue/settings")).body.settings.capMin, 4);

    const a = { id: "sess-a", name: "A", pid: process.pid };
    const b = { id: "sess-b", name: "B", pid: process.pid };
    assert.equal((await api(port, "POST", "/api/queue/lock", { placeId: "555", op: "claim", client: a, tool: "solo_playtest" })).body.ok, true);
    const refused = (await api(port, "POST", "/api/queue/lock", { placeId: "555", op: "claim", client: b, tool: "solo_playtest" })).body;
    assert.equal(refused.ok, false);
    assert.equal(refused.holder.client.id, "sess-a");
    const joined = (await api(port, "POST", "/api/queue/lock", { placeId: "555", op: "join", client: b, waiter: { task: "click the shop", holdMin: 4, level: "update" } })).body;
    assert.equal(joined.position, 1);
    assert.equal((await api(port, "POST", "/api/queue/release-all", { client: { id: "sess-a" } })).body.released, 1);
    assert.equal((await api(port, "POST", "/api/queue/lock", { placeId: "555", op: "claim", client: b, tool: "wait" })).body.ok, true);
    const status = (await api(port, "GET", "/api/queue?placeId=555")).body;
    assert.equal(status.holder.client.id, "sess-b");
    assert.equal(status.holder.requestedMin, 4, "the hold it asked for, kept for the history");

    // A job: no daemon runs for the place, so it waits out an infra retry; then the hub restarts
    const submitted = await api(port, "POST", "/api/queue/submit", { placeId: "555", client: a, job: { root: folder, source: "--! name: survives\nreturn {}" } });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal((await api(port, "POST", "/api/queue/submit", { placeId: "555", client: a, job: { root: folder, files: ["../x.luau"], source: "return {}" } })).status, 400);
    const id = submitted.body.id;
    // sess-b holds Studio: the job waits for the lock
    await wait(200);
    assert.equal((await api(port, "GET", `/api/queue/job?placeId=555&id=${id}`)).body.state, "pending");
    await hub.stop({ handoff: true });

    hub = new QuackHub(options);
    await hub.start();
    const after = (await api(port, "GET", "/api/queue?placeId=555")).body;
    assert.equal(after.holder.client.id, "sess-b", "the lock survived the restart");
    assert.deepEqual(after.jobs.map((j: any) => j.name), ["survives"]);
    assert.equal((await api(port, "POST", "/api/queue/force-release", { placeId: "555" })).body.released, true);
    // Free now: the runner tries, finds no daemon, and keeps it for an infra retry
    const end = Date.now() + 5000;
    let job: any;
    do {
      await wait(50);
      job = (await api(port, "GET", "/api/queue?placeId=555")).body.jobs[0];
    } while (!job?.infra && Date.now() < end);
    assert.match(job.infra.last, /no daemon runs for this place/);
  } finally {
    await hub.stop();
    removeDir(tmp);
  }
});

test("luaString: a text ending in ] (or ]=) still round-trips whole", async () => {
  const { luaString } = await import("../queue/prelude.js");
  const decode = (lua: string) => {
    const m = /^\[(=*)\[\n([\s\S]*)\]\1\]$/.exec(lua)!;
    // The first closing bracket of that level is where Luau ends the string
    const close = `]${m[1]}]`;
    return lua.slice(2 + m[1].length + 1, lua.indexOf(close, 2 + m[1].length));
  };
  for (const text of ['["a"]', "x]=", "a]]b", "]", "plain"]) assert.equal(decode(luaString(text)), text, text);
});

test("settings: a settings file holding null or a list is replaced on the next save", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-qs-"));
  try {
    const file = path.join(tmp, "hub-queue.json");
    for (const bad of ["null", "[1,2]", "7"]) {
      fs.writeFileSync(file, bad);
      assert.deepEqual(loadSettings(file), DEFAULT_SETTINGS);
      assert.equal(saveSettings(file, { capMin: 6 }).capMin, 6, bad);
    }
  } finally {
    removeDir(tmp);
  }
});

test("hub queues: a hold asked as an absurd number is kept in range, so the line still sorts", async () => {
  const { HubQueues } = await import("../queue/hubQueues.js");
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio(folder);
  const queues = new HubQueues({ registryFile: path.join(tmp, "hub.json"), places: () => ({ "9": { folder } }), port: () => port, log: () => {}, settingsFile: path.join(tmp, "s.json") });
  try {
    const join = (id: string, holdMin: unknown) => queues.handlePost("/api/queue/lock", { placeId: "9", op: "join", client: { id, pid: process.pid }, waiter: { holdMin, level: "normal" } }) as any;
    join("huge", "1e999");
    join("long", 5000);
    const last = join("small", 2);
    // Infinity is no number of minutes: the default; a finite one past 10 h is held at 600
    assert.deepEqual(last.queue.map((w: any) => [w.client.id, w.holdMin]), [["small", 2], ["huge", 10], ["long", 600]]);
    assert.equal(queues.summary()["9"].waiters, 3);
    assert.equal(queues.summary()["9"].jobs, 0);
  } finally {
    queues.stop();
    removeDir(tmp);
  }
});

test("queue: a play left up is still adopted when Studio answers only after a moment", { timeout: 30_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio(folder);
  try {
    const one = makeQueue(folder, port, { lingerSec: 60 });
    await verdictOf(one.queue, one.queue.submit(me, job("warm", folder)).id);
    one.queue.stop();
    assert.equal(s.playing, true);
    // The new hub starts while its Studio is still reconnecting
    s.connected = false;
    const two = new PlaceQueue({ placeId: "1", folder, port, settings: () => ({ ...FAST_SETTINGS, lingerSec: 0.1 }), timings: { ...FAST, adoptMs: 5000 } });
    two.kick();
    await wait(300);
    assert.equal(s.stops, 0);
    s.connected = true;
    await two.idle();
    assert.equal(s.stops, 1, "adopted once Studio answered, then stopped");
    two.stop();
  } finally {
    removeDir(tmp);
  }
});

test("hub queues: a job's name from its header is cut to 200 characters", async () => {
  const { HubQueues } = await import("../queue/hubQueues.js");
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio(folder);
  const queues = new HubQueues({ registryFile: path.join(tmp, "hub.json"), places: () => ({ "9": { folder } }), port: () => port, log: () => {}, settingsFile: path.join(tmp, "s.json") });
  try {
    const { id } = queues.handlePost("/api/queue/submit", { placeId: "9", client: { id: "c" }, job: { root: folder, source: `--! name: ${"x".repeat(10_000)}\nreturn {}` } }) as any;
    assert.equal((queues.queueOf("9").status().jobs.find((j: any) => j.id === id) as any).name.length, 200);
  } finally {
    queues.stop();
    removeDir(tmp);
  }
});

test("queue: a holder's Studio calls do not rewrite the state file each time; a new holder is written at once", { timeout: 20_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio(folder);
  const { queue } = makeQueue(folder, port);
  try {
    queue.lock.claim({ id: "a", pid: process.pid }, "t");
    await wait(20);
    const after = queue.saves;
    assert.ok(after >= 1, "the grant is saved");
    for (let i = 0; i < 200; i++) {
      queue.lock.touch("a", "read");
      queue.lock.claim({ id: "a", pid: process.pid }, "call");
    }
    await wait(50);
    assert.equal(queue.saves, after, "200 refreshes wrote nothing yet");
    queue.lock.release("a");
    await wait(20);
    assert.equal(queue.saves, after + 1, "a release is written in the same tick, once");
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});

test("settings: a game's file is read again only when it changes", async () => {
  const { readGameConfig } = await import("../queue/settings.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-gc-"));
  try {
    fs.mkdirSync(path.join(tmp, ".claude"));
    const file = path.join(tmp, ".claude", "studio-test.json");
    fs.writeFileSync(file, JSON.stringify({ lingerSec: 5 }));
    const first = readGameConfig(tmp);
    assert.equal(first.overrides.lingerSec, 5);
    assert.equal(readGameConfig(tmp), first, "the same read while the file is untouched");
    fs.writeFileSync(file, JSON.stringify({ lingerSec: 9 }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(readGameConfig(tmp).overrides.lingerSec, 9);
    fs.rmSync(file);
    assert.deepEqual(readGameConfig(tmp).overrides, {});
  } finally {
    removeDir(tmp);
  }
});


test("lock: a second client capped does not free the first one before the batch", () => {
  const now = { t: 0 };
  const { lock, pending } = lockWith({ now, settings: { capMin: 1 } });
  pending.count = 1;
  pending.oldest = 0;
  lock.claim({ id: "a" }, "t");
  now.t = 61_000;
  lock.touch("a");
  assert.equal(lock.tick(), "cap");
  assert.equal(lock.claim({ id: "b" }, "t").ok, true);
  now.t = 122_000;
  lock.touch("b");
  assert.equal(lock.tick(), "cap");
  assert.ok(lock.claim({ id: "a" }, "t").ok === false, "a is still capped");
  assert.ok(lock.claim({ id: "b" }, "t").ok === false, "b too");
  now.t += 1000;
  lock.batchDone();
  assert.equal(lock.claim({ id: "a" }, "t").ok, true);
});

test("disk: an instance whose name holds a space is read whole in a traceback", async () => {
  const { foreignIn } = await import("../queue/disk.js");
  const sourcemap = {
    ok: true,
    byFile: new Map([["sync/ServerStorage/Inventory Config.luau", ["ServerStorage", "Inventory Config"]]]),
    byInstance: new Map([["ServerStorage.Inventory Config", "sync/ServerStorage/Inventory Config.luau"], ["ServerStorage.Inventory", "sync/ServerStorage/Inventory.luau"]]),
  };
  assert.equal(foreignIn("ServerStorage.Inventory Config:3: attempt to index nil", ["sync/ServerStorage/Inventory Config.luau"], sourcemap), null, "its own module");
  assert.deepEqual(foreignIn("ServerStorage.Inventory:9: boom", ["sync/ServerStorage/Inventory Config.luau"], sourcemap), { instance: "ServerStorage.Inventory", file: "sync/ServerStorage/Inventory.luau" });
});

test("queue: two places registered with one folder keep separate queues", { timeout: 20_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio(folder);
  try {
    const one = new PlaceQueue({ placeId: "1", folder, port, settings: () => FAST_SETTINGS, timings: FAST });
    const two = new PlaceQueue({ placeId: "2", folder, port, settings: () => FAST_SETTINGS, timings: FAST });
    one.lock.claim({ id: "a", pid: process.pid }, "t");
    two.lock.claim({ id: "b", pid: process.pid }, "t");
    one.save();
    two.save();
    one.stop();
    two.stop();
    const again = new PlaceQueue({ placeId: "1", folder, port, settings: () => FAST_SETTINGS, timings: FAST });
    assert.equal(again.lock.state.holder?.client.id, "a", "place 1 kept its own lock");
    again.stop();
  } finally {
    removeDir(tmp);
  }
});

test("queue: a verdict the disk refuses is still answered from memory", { timeout: 20_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio(folder);
  const { queue } = makeQueue(folder, port);
  try {
    // .quack is a file: nothing the queue writes reaches the disk
    fs.writeFileSync(path.join(folder, ".quack"), "a file where the folder should be");
    const v = await verdictOf(queue, queue.submit(me, job("unsaved", folder)).id, 4000);
    assert.equal(v.pass, true);
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});

test("queue: a client that holds Studio after a restart owns the play left up: it is never stopped", { timeout: 20_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { s, port } = fakeStudio(folder);
  try {
    const one = makeQueue(folder, port, { lingerSec: 60 });
    await verdictOf(one.queue, one.queue.submit(me, job("warm", folder)).id);
    one.queue.stop();
    const two = makeQueue(folder, port, { lingerSec: 0.05 });
    two.queue.lock.claim({ id: "someone", pid: process.pid }, "solo_playtest");
    two.queue.kick();
    await two.queue.idle();
    assert.equal(s.stops, 0);
    assert.equal(s.playing, true);
    two.queue.stop();
  } finally {
    removeDir(tmp);
  }
});

test("queue: the day's numbers are read again only when the history grew", { timeout: 20_000 }, async () => {
  const { tmp, folder } = makeGame();
  const { port } = fakeStudio(folder);
  const { queue } = makeQueue(folder, port);
  try {
    await verdictOf(queue, queue.submit(me, job("one", folder)).id);
    const first = queue.stats();
    assert.equal(queue.stats(), first, "the same numbers while nothing was written");
    await verdictOf(queue, queue.submit(me, job("two", folder)).id);
    assert.equal(queue.stats().jobs, 2);
  } finally {
    queue.stop();
    removeDir(tmp);
  }
});
