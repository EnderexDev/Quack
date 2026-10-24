import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { runControl, type ControlContext } from "../control/commands.js";
import { flavorInfo, HubClient, type Flavor } from "../control/hubClient.js";
import { QuackHub } from "../hub/hub.js";
import { saveRegistry } from "../hub/registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonCli = path.join(here, "..", "cli.js");
const version = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "package.json"), "utf8")).version;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(50);
  }
}

/** A fake Studio with one script, as in hub.test.ts; `snapshotDelay` is the plugin building its snapshot */
function fakeStudio(port: number, placeId: number, scriptName: string, snapshotDelay = 0) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const received: any[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    received.push(msg);
    if (msg.type === "requestSnapshot") {
      setTimeout(() => ws.send(JSON.stringify({
        type: "fullSnapshot",
        placeId,
        data: [
          { guid: "ss", className: "ServerStorage", name: "ServerStorage", path: ["ServerStorage"], parentGuid: "root" },
          { guid: `s${placeId}`, className: "ModuleScript", name: scriptName, path: ["ServerStorage", scriptName], parentGuid: "ss", source: `return "${scriptName}"\n` },
        ],
      })), snapshotDelay);
    }
  });
  ws.on("open", () => ws.send(JSON.stringify({ type: "handshakeStudio", version, placeId, placeName: scriptName })));
  return { ws, received };
}

interface Run {
  code: number;
  out: string;
  err: string;
  json: () => any;
}

function control(port: number, options: { flavor?: Flavor; cwd?: string; interactive?: boolean; answer?: boolean; opened?: string[] } = {}) {
  return async (...argv: string[]): Promise<Run> => {
    const out: string[] = [];
    const err: string[] = [];
    const ctx: ControlContext = {
      info: { ...flavorInfo(options.flavor ?? "dev"), port },
      client: new HubClient(port),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      confirm: async () => options.answer ?? false,
      interactive: options.interactive ?? false,
      color: false,
      cwd: options.cwd ?? os.tmpdir(),
      openUri: async (uri) => void options.opened?.push(uri),
      pollMs: 50,
    };
    const code = await runControl(argv, ctx);
    return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) };
  };
}

async function withHub(body: (ctx: { port: number; tmp: string; folders: Record<string, string> }) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-control-"));
  const folders: Record<string, string> = { "111": path.join(tmp, "Alpha Game"), "222": path.join(tmp, "Beta Game") };
  for (const folder of Object.values(folders)) fs.mkdirSync(folder);
  const registryFile = path.join(tmp, "hub.json");
  saveRegistry(registryFile, { places: { "111": { folder: folders["111"], name: "Alpha Game" }, "222": { folder: folders["222"], name: "Beta Game" } } });
  const port = await freePort();
  const noAi = async () => ({ claude: { installed: false, loggedIn: false }, codex: { installed: false, loggedIn: false } });
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {}, configFile: path.join(tmp, "config.json"), detectAi: noAi });
  await hub.start();
  try {
    await body({ port, tmp, folders });
  } finally {
    await hub.stop();
    await wait(500);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("status, places and log name a place by id, by part of its name or by the folder you are in", { timeout: 60000 }, async () => {
  await withHub(async ({ port, folders }) => {
    const studio = fakeStudio(port, 111, "AlphaScript");
    const run = control(port);
    await waitFor(async () => (await run("status", "--json")).json().sessions[0]?.instances === 3);

    const status = await run("status");
    assert.equal(status.code, 0);
    assert.match(status.out, /Alpha Game\s+111\s+connected/);
    assert.match(status.out, /Beta Game\s+222\s+-/);
    assert.deepEqual((await run("places", "--json")).json().map((p: any) => p.placeId), ["111", "222"]);

    assert.match((await run("log", "111")).out, /Sync complete: 1 scripts/);
    assert.match((await run("log", "alpha")).out, /Sync complete/);
    const inside = control(port, { cwd: path.join(folders["111"], "sync", "ServerStorage") });
    assert.match((await inside("log")).out, /Sync complete/, "the folder you are in names the place");
    const dotted = path.join(folders["111"], "..cache");
    fs.mkdirSync(dotted);
    assert.match((await control(port, { cwd: dotted })("log")).out, /Sync complete/, "a folder whose name starts with .. is still inside");

    const ambiguous = await run("log", "game");
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.err, /more than one place/);
    const none = await run("log");
    assert.equal(none.code, 1);
    assert.match(none.err, /Which place\?/);
    assert.equal((await run("log", "999")).code, 1);
    studio.ws.terminate();
  });
});

test("wait --idle returns only once Studio stopped sending, and pings do not count as syncing", { timeout: 60000 }, async () => {
  await withHub(async ({ port }) => {
    const studio = fakeStudio(port, 111, "AlphaScript");
    const run = control(port);
    assert.equal((await run("wait", "111", "--connected", "--timeout", "15")).code, 0);
    await wait(500);

    // Edits keep coming for 1.2 s: a quiet of 300 ms is only reached after the last one
    let sending = true;
    const edits = (async () => {
      for (let i = 0; sending; i++) {
        studio.ws.send(JSON.stringify({ type: "scriptChanged", data: { guid: "s111", path: ["ServerStorage", "AlphaScript"], className: "ModuleScript", source: `return ${i}\n` } }));
        await wait(100);
      }
    })();
    setTimeout(() => (sending = false), 1200);
    const busy = await run("wait", "111", "--idle", "300", "--json");
    await edits;
    assert.equal(busy.code, 0);
    assert.ok(busy.json().waitedMs >= 1200, `returned after ${busy.json().waitedMs} ms, while Studio was still sending`);

    // The plugin's pings go on all the time: they are not syncing
    const pings = setInterval(() => studio.ws.send(JSON.stringify({ type: "ping" })), 50);
    try {
      const quiet = await run("wait", "111", "--idle", "300", "--json");
      assert.equal(quiet.code, 0);
      assert.ok(quiet.json().waitedMs < 1000, `pings held the wait for ${quiet.json().waitedMs} ms`);
    } finally {
      clearInterval(pings);
    }

    // No Studio for the other place: it times out with its own code
    const absent = await run("wait", "222", "--timeout", "0.3");
    assert.equal(absent.code, 3);
    assert.match(absent.err, /did not connect/);
    studio.ws.terminate();
  });
});

test("wait is not done while the plugin is still building its first snapshot", { timeout: 60000 }, async () => {
  await withHub(async ({ port }) => {
    // Seconds of silence after the handshake, as a 261k-instance place gives
    const studio = fakeStudio(port, 111, "AlphaScript", 2500);
    const run = control(port);
    const done = await run("wait", "111", "--idle", "300", "--timeout", "20", "--json");
    assert.equal(done.code, 0, done.err);
    const session = (await run("sessions", "--json")).json()[0];
    assert.equal(session.instances, 3, "returned before the full sync was written");
    assert.ok(session.syncedAt >= session.studioSince);
    studio.ws.terminate();
  });
});

test("on Official a change asks first, and without a terminal it needs --yes", { timeout: 30000 }, async () => {
  await withHub(async ({ port }) => {
    const paused = async () => (await control(port)("status", "--json")).json().paused;

    const script = await control(port, { flavor: "official" })("pause");
    assert.equal(script.code, 1);
    assert.match(script.err, /--yes/);
    assert.equal(await paused(), false, "a script without --yes must not pause Official");

    assert.equal((await control(port, { flavor: "official", interactive: true, answer: false })("pause")).code, 1);
    assert.equal(await paused(), false, "answering no must not pause");

    assert.equal((await control(port, { flavor: "official", interactive: true, answer: true })("pause")).code, 0);
    assert.equal(await paused(), true);
    assert.equal((await control(port, { flavor: "official" })("resume", "--yes")).code, 0);
    assert.equal(await paused(), false);

    // Reading never asks; Dev never asks
    assert.equal((await control(port, { flavor: "official" })("status")).code, 0);
    assert.equal((await control(port)("pause")).code, 0);
    assert.equal(await paused(), true);
  });
});

test("register, a conflict found and resolved without naming its place, and open", { timeout: 60000 }, async () => {
  await withHub(async ({ port, tmp, folders }) => {
    const run = control(port);
    const extra = path.join(tmp, "Gamma");
    fs.mkdirSync(extra);
    const registered = await control(port, { cwd: extra })("register", "333", "--name", "Gamma");
    assert.equal(registered.code, 0, registered.err);
    assert.ok((await run("places", "--json")).json().some((p: any) => p.placeId === "333" && path.resolve(p.folder) === extra));
    assert.equal((await run("unregister", "gamma")).code, 0);
    assert.equal((await run("places", "--json")).json().some((p: any) => p.placeId === "333"), false);

    const studio = fakeStudio(port, 222, "BetaScript");
    const folder = folders["222"];
    const script = path.join(folder, "sync", "ServerStorage", "BetaScript.luau");
    await waitFor(() => fs.existsSync(script));
    const id = ".quack/conflicts/ServerStorage/BetaScript.luau.2026-10-21T10-00-00-000Z-abc123.luau";
    fs.mkdirSync(path.dirname(path.join(folder, id)), { recursive: true });
    fs.writeFileSync(path.join(folder, id), 'return "disk side"\n');
    fs.appendFileSync(path.join(folder, ".quack", "merge-log.jsonl"),
      JSON.stringify({ t: new Date().toISOString(), file: "ServerStorage/BetaScript.luau", method: "text", conflictingHunks: 1, agentVersion: id }) + "\n");

    const listed = (await run("conflicts", "--json")).json();
    assert.deepEqual(listed.map((c: any) => [c.placeId, c.agentVersion]), [["222", id]]);
    assert.match((await run("conflict", id)).out, /disk side/);
    assert.equal((await run("resolve", id)).code, 1, "neither --disk nor --keep");
    await wait(500);
    assert.equal((await run("resolve", id, "--disk")).code, 0);
    assert.equal(fs.readFileSync(script, "utf8"), 'return "disk side"\n');
    assert.match((await run("conflicts")).out, /No conflicts waiting/);

    const opened: string[] = [];
    assert.equal((await control(port, { opened })("open", "beta")).code, 0);
    assert.equal((await control(port, { opened })("open", "444")).code, 0, "an unregistered id opens for Set up");
    assert.deepEqual(opened, ["roblox-studio:1+task:EditPlace+placeId:222+universeId:0", "roblox-studio:1+task:EditPlace+placeId:444+universeId:0"]);
    studio.ws.terminate();
  });
});

test("no hub on the port: its own exit code", { timeout: 15000 }, async () => {
  const run = control(await freePort());
  const status = await run("status");
  assert.equal(status.code, 2);
  assert.match(status.err, /no hub answers/);
  assert.equal((await run("bogus")).code, 1, "an unknown command is an error, not offline");
});

test("restart-hub stops the hub and returns once one answers again; a hub nobody restarts times out", { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-control-"));
  const registryFile = path.join(tmp, "hub.json");
  saveRegistry(registryFile, { places: {} });
  const port = await freePort();
  const noAi = async () => ({ claude: { installed: false, loggedIn: false }, codex: { installed: false, loggedIn: false } });
  const hubs: QuackHub[] = [];
  let restarts = 0;
  // What the app does: it sees the hub gone and starts the one it ships, on the same port
  const make = (restart: boolean): QuackHub => {
    const hub: QuackHub = new QuackHub({
      port, registryFile, daemonCli, log: () => {}, configFile: path.join(tmp, "config.json"), detectAi: noAi,
      onShutdownRequest: () => void hub.stop().then(async () => {
        if (!restart) return;
        restarts++;
        await wait(300);
        const next = make(false);
        hubs.push(next);
        await next.start();
      }),
    });
    return hub;
  };
  const first = make(true);
  hubs.push(first);
  await first.start();
  try {
    const run = control(port);
    const restarted = await run("restart-hub", "--json");
    assert.equal(restarted.code, 0, restarted.err);
    assert.equal(restarts, 1);
    assert.equal((await run("status")).code, 0, "the new hub answers");

    // The second hub is not brought back: stopped, and the command says nothing started it
    const alone = await run("restart-hub", "--timeout", "0.5");
    assert.equal(alone.code, 3);
    assert.match(alone.err, /nothing started it again/);
    assert.equal((await run("status")).code, 2);
  } finally {
    for (const hub of hubs) await hub.stop().catch(() => {});
    await wait(300);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("restart-hub sees a hub replaced between two of its polls", { timeout: 30000 }, async () => {
  // Never offline: the port answers throughout, only the hub behind it changes. The old one is
  // from before startedAt existed and reports none
  let startedAt: number | undefined;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/shutdown") {
      startedAt = 2;
      res.end(JSON.stringify({ ok: true }));
    } else res.end(JSON.stringify({ build: startedAt === undefined ? "old" : "new", startedAt, paused: false, sessions: [], places: [], pending: [], refused: [] }));
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    const restarted = await control(port)("restart-hub", "--json");
    assert.equal(restarted.code, 0, restarted.err);
    assert.deepEqual(restarted.json(), { ok: true, before: "old", after: "new" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("open --wait on a place not registered yet waits for Set up instead of failing", { timeout: 60000 }, async () => {
  await withHub(async ({ port, tmp }) => {
    const opened: string[] = [];
    const run = control(port, { opened });
    const folder = path.join(tmp, "Delta");
    fs.mkdirSync(folder);
    const waiting = run("open", "444", "--wait", "--timeout", "20");
    // What Set up in the app does a moment later, then the plugin connects on its own
    await wait(500);
    assert.equal((await run("register", "444", folder, "--name", "Delta")).code, 0);
    const studio = fakeStudio(port, 444, "DeltaScript");
    const result = await waiting;
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /is connected/);
    assert.deepEqual(opened, ["roblox-studio:1+task:EditPlace+placeId:444+universeId:0"]);
    studio.ws.terminate();
  });
});
