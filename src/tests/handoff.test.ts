import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { QuackHub } from "../hub/hub.js";
import { isAlive, readHubLock } from "../hub/owners.js";
import { saveRegistry } from "../hub/registry.js";

// A hub restart (an update, `quack restart-hub`) leaves the daemons running: a Studio that went
// to its daemon directly keeps syncing, and the next hub adopts the daemon.

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
    // Which wait ran out: a bare "timed out" did not say, the one time a run failed under load
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for: ${check.toString().slice(0, 160)}`);
    await wait(50);
  }
}

const snapshot = (placeId: number) => ({
  type: "fullSnapshot",
  placeId,
  data: [
    { guid: "ss", className: "ServerStorage", name: "ServerStorage", path: ["ServerStorage"], parentGuid: "root" },
    { guid: "s1", className: "ModuleScript", name: "Kept", path: ["ServerStorage", "Kept"], parentGuid: "ss", source: "return 1\n" },
  ],
});

/**
 * A Studio with the new plugin: it says it follows redirects, and when the hub sends one it
 * connects to that URL and handshakes again, as SyncSession does.
 */
function directStudio(hubPort: number, placeId: number, session: string) {
  const received: any[] = [];
  const state: { daemon?: WebSocket; url?: string } = {};
  const answer = (ws: WebSocket) => (raw: WebSocket.RawData) => {
    const msg = JSON.parse(raw.toString());
    received.push(msg);
    if (msg.type === "requestSnapshot") ws.send(JSON.stringify(snapshot(placeId)));
    if (msg.type === "redirect") {
      state.url = msg.url;
      const daemon = new WebSocket(msg.url);
      // A refused or dropped link is what the test looks at, not a crash of the test
      daemon.on("error", (error) => received.push({ type: "socketError", message: error.message }));
      state.daemon = daemon;
      daemon.on("message", answer(daemon));
      daemon.on("open", () => daemon.send(JSON.stringify({ type: "handshakeStudio", version, placeId, session, redirect: true })));
    }
  };
  const hub = new WebSocket(`ws://127.0.0.1:${hubPort}/`);
  hub.on("message", answer(hub));
  hub.on("open", () => hub.send(JSON.stringify({ type: "handshakeStudio", version, placeId, session, redirect: true })));
  return { hub, received, state };
}

/** A Studio with an older plugin: no redirect, everything through the hub */
function relayedStudio(hubPort: number, placeId: number) {
  const received: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/`);
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    received.push(msg);
    if (msg.type === "requestSnapshot") ws.send(JSON.stringify(snapshot(placeId)));
  });
  ws.on("open", () => ws.send(JSON.stringify({ type: "handshakeStudio", version, placeId })));
  return { ws, received };
}

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-handoff-"));
  const folder = path.join(tmp, "Game");
  fs.mkdirSync(folder);
  const registryFile = path.join(tmp, "hub.json");
  saveRegistry(registryFile, { places: { "321": { folder, name: "Game" } } });
  return { tmp, folder, registryFile };
}

/** A daemon still closing can hold the folder for a moment on Windows */
function removeQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // left in the temp folder
  }
}

const sessionOf = (hub: QuackHub) => hub.listSessions().find((s) => s.placeId === "321");

test("a Studio sent to its daemon keeps syncing through a hub restart, and the next hub adopts the daemon", { timeout: 90000 }, async () => {
  const { tmp, folder, registryFile } = setup();
  const port = await freePort();
  const logs: string[] = [];
  const first = new QuackHub({ port, registryFile, daemonCli, log: (l) => logs.push(l) });
  await first.start();
  let second: QuackHub | undefined;
  let pid: number | undefined;
  const studio = directStudio(port, 321, "S1");
  try {
    const script = path.join(folder, "sync", "ServerStorage", "Kept.luau");
    await waitFor(() => fs.existsSync(script));
    // Sent to the daemon, with its token, on 127.0.0.1 only
    assert.match(studio.state.url ?? "", /^ws:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{48}$/);
    await waitFor(() => sessionOf(first)?.studioConnected === true && sessionOf(first)?.syncedAt !== null);
    pid = sessionOf(first)!.daemonPid!;
    const snapshotsBefore = studio.received.filter((m) => m.type === "requestSnapshot").length;

    await first.stop({ handoff: true });
    assert.ok(isAlive(pid), "the daemon outlives the hub");
    assert.equal(studio.state.daemon?.readyState, WebSocket.OPEN, "the Studio's link to its daemon stays up");

    // With no hub at all, a save on disk still reaches the Studio
    await wait(300);
    fs.writeFileSync(script, "return 2\n");
    await waitFor(() => studio.received.some((m) => m.type === "patchScript" && m.source === "return 2\n"));

    second = new QuackHub({ port, registryFile, daemonCli, log: (l) => logs.push(l) });
    await second.start();
    const adopted = sessionOf(second);
    assert.equal(adopted?.daemonPid, pid, "the same daemon, adopted");
    assert.ok(logs.some((l) => /Adopted the daemon for Game/.test(l)), logs.join("\n"));
    await waitFor(() => sessionOf(second!)?.studioConnected === true);
    assert.notEqual(sessionOf(second)?.syncedAt, null, "the last sync is known without a new one");
    assert.equal(readHubLock(folder)?.hubPid, process.pid);
    assert.equal(studio.received.filter((m) => m.type === "requestSnapshot").length, snapshotsBefore, "no new snapshot");

    // An older plugin, relayed by the new hub, reaches the adopted daemon (the relay has the token)
    studio.state.daemon?.close();
    await waitFor(() => sessionOf(second!)?.studioConnected === false);
    const relayed = relayedStudio(port, 321);
    await waitFor(() => relayed.received.some((m) => m.type === "handshakeAck"));
    relayed.ws.terminate();
  } finally {
    studio.hub.terminate();
    studio.state.daemon?.terminate();
    await (second ?? first).stop();
    if (pid) await waitFor(() => !isAlive(pid!), 5000).catch(() => {});
    assert.ok(!pid || !isAlive(pid), "a plain shutdown still stops the daemon");
    removeQuietly(tmp);
  }
});

test("a hub's daemon lets in only this machine with the token", { timeout: 60000 }, async () => {
  const { tmp, registryFile } = setup();
  const port = await freePort();
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await hub.start();
  const studio = directStudio(port, 321, "S2");
  try {
    await waitFor(() => !!studio.state.url && studio.received.some((m) => m.type === "handshakeAck"));
    const url = new URL(studio.state.url!);
    // No token: refused at the upgrade
    const refused = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${url.port}/`);
      ws.on("open", () => resolve(false));
      ws.on("error", () => resolve(true));
    });
    assert.ok(refused, "a WebSocket without the token is refused");
    assert.equal((await fetch(`http://127.0.0.1:${url.port}/status`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${url.port}/status?token=wrong`)).status, 403);
    const status = (await (await fetch(`http://127.0.0.1:${url.port}/status?token=${url.searchParams.get("token")}`)).json()) as any;
    assert.equal(status.studio.connected, true);
    assert.equal(status.studio.session, "S2");
    // Not reachable from another interface of this machine
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (lan) {
      const reached = await new Promise<boolean>((resolve) => {
        const socket = net.connect(Number(url.port), lan.address);
        socket.once("connect", () => (socket.destroy(), resolve(true)));
        socket.once("error", () => resolve(false));
      });
      assert.equal(reached, false, `the daemon answered on ${lan.address}`);
    }
  } finally {
    studio.hub.terminate();
    studio.state.daemon?.terminate();
    await hub.stop();
    await wait(300);
    removeQuietly(tmp);
  }
});

test("a daemon built from other code is replaced by a successor, not adopted", { timeout: 60000 }, async () => {
  const { tmp, folder, registryFile } = setup();
  const port = await freePort();
  const logs: string[] = [];
  const first = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await first.start();
  const studio = directStudio(port, 321, "S3");
  let second: QuackHub | undefined;
  try {
    await waitFor(() => sessionOf(first)?.studioConnected === true);
    const pid = sessionOf(first)!.daemonPid!;
    await first.stop({ handoff: true });
    assert.ok(isAlive(pid));
    // The daemon from dist/ reports "dist"; this hub ships something else
    second = new QuackHub({ port, registryFile, daemonCli, daemonBuild: "0123456789ab", log: (l) => logs.push(l) });
    await second.start();
    assert.notEqual(sessionOf(second)?.daemonPid, pid, "not adopted");
    await waitFor(() => !isAlive(pid), 10000);
    assert.ok(logs.some((l) => /runs other code \(dist, this hub ships 0123456789ab\)/.test(l)), logs.join("\n"));
    // Its successor holds the folder now
    await waitFor(() => !!sessionOf(second!) && readHubLock(folder)?.daemonPid === sessionOf(second!)?.daemonPid, 10000);
  } finally {
    studio.hub.terminate();
    studio.state.daemon?.terminate();
    await (second ?? first).stop();
    await wait(300);
    removeQuietly(tmp);
  }
});

test("a daemon no hub adopts stops on its own and frees the folder", { timeout: 60000 }, async () => {
  const { tmp, folder, registryFile } = setup();
  const port = await freePort();
  process.env.QUACK_HUB_ORPHAN_MS = "1500";
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  let pid: number | undefined;
  try {
    await hub.start();
    const studio = directStudio(port, 321, "S4");
    await waitFor(() => sessionOf(hub)?.studioConnected === true);
    pid = sessionOf(hub)!.daemonPid!;
    await hub.stop({ handoff: true });
    studio.hub.terminate();
    // The hub here is this test process, still alive: the daemon sees it as its hub until the
    // lock's hub is gone. Point it at a dead pid, as a crashed hub would leave it.
    const token = new URL(studio.state.url!).searchParams.get("token")!;
    const lock = readHubLock(folder)!;
    await fetch(`http://127.0.0.1:${lock.daemonPort}/adopt?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hubPid: 999_999 }),
    });
    await waitFor(() => !isAlive(pid!), 15000);
    assert.equal(readHubLock(folder), undefined, "the lock is cleared");
    studio.state.daemon?.terminate();
  } finally {
    delete process.env.QUACK_HUB_ORPHAN_MS;
    if (pid && isAlive(pid)) process.kill(pid);
    await wait(300);
    removeQuietly(tmp);
  }
});

/**
 * A Studio with the plugin that resumes: when its link to the daemon drops it keeps its session,
 * reconnects through the hub with resume, follows the redirect, and sends what it queued.
 */
function resumingStudio(hubPort: number, placeId: number, session: string) {
  const received: any[] = [];
  const state: { daemon?: WebSocket; links: number; resumed: number; stopped: boolean } = { links: 0, resumed: 0, stopped: false };
  let tracking = false;
  const connect = (url: string) => {
    const ws = new WebSocket(url);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (msg.type === "requestSnapshot") ws.send(JSON.stringify(snapshot(placeId)));
      if (msg.type === "handshakeAck") {
        tracking = true;
        if (msg.resumed) state.resumed++;
      }
      if (msg.type === "redirect") {
        state.daemon = connect(msg.url);
        state.links++;
      }
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "handshakeStudio", version, placeId, session, redirect: true, resume: tracking })));
    ws.on("close", () => {
      // The daemon link dropped: back through the hub, retrying until it answers
      if (ws === state.daemon && !state.stopped) {
        const retry = () => {
          if (state.stopped) return;
          const probe = new WebSocket(`ws://127.0.0.1:${hubPort}/`);
          probe.on("error", () => setTimeout(retry, 100));
          probe.on("open", () => {
            probe.terminate();
            connect(`ws://127.0.0.1:${hubPort}/`);
          });
        };
        retry();
      }
    });
    return ws;
  };
  connect(`ws://127.0.0.1:${hubPort}/`);
  return { received, state, stop: () => ((state.stopped = true), state.daemon?.terminate()) };
}

test("restarting with the daemons: the successor starts from the old daemon's tree and the Studio resumes without a snapshot", { timeout: 90000 }, async () => {
  const { tmp, folder, registryFile } = setup();
  const port = await freePort();
  const logs: string[] = [];
  const first = new QuackHub({ port, registryFile, daemonCli, log: (l) => logs.push(l) });
  await first.start();
  let second: QuackHub | undefined;
  const studio = resumingStudio(port, 321, "R1");
  try {
    const script = path.join(folder, "sync", "ServerStorage", "Kept.luau");
    await waitFor(() => fs.existsSync(script) && sessionOf(first)?.studioConnected === true);
    const oldPid = sessionOf(first)!.daemonPid!;
    const snapshots = () => studio.received.filter((m) => m.type === "requestSnapshot").length;
    assert.equal(snapshots(), 1);

    await first.stop({ handoff: true, replaceDaemons: true });
    second = new QuackHub({ port, registryFile, daemonCli, log: (l) => logs.push(l) });
    await second.start();
    await waitFor(() => studio.state.resumed === 1 && sessionOf(second!)?.studioConnected === true, 30000);
    const newPid = sessionOf(second)!.daemonPid!;
    assert.notEqual(newPid, oldPid, "a new daemon");
    await waitFor(() => !isAlive(oldPid), 5000);
    assert.equal(snapshots(), 1, "no second snapshot: the Studio resumed");
    assert.ok(logs.some((l) => /was asked to restart; replacing it/.test(l)), logs.join("\n"));
    assert.equal(fs.readdirSync(path.join(folder, ".quack")).some((f) => f.startsWith("handoff-")), false, "the handoff file is gone");
    const daemonLog = fs.readFileSync(path.join(folder, ".quack", "daemon.log"), "utf8");
    // Built while the old one still synced, then a switch that carried only what changed meanwhile
    assert.match(daemonLog, /Prepared 2 instances for the next daemon; still syncing/);
    assert.match(daemonLog, /Building from the previous daemon's tree on standby \(2 instances\)/);
    assert.match(daemonLog, /Took over \(\d+ change\(s\) since the standby started\)/);
    assert.match(daemonLog, /Studio resumed its session: no snapshot needed/);

    // Both ways still work with the successor: disk to Studio, Studio to disk
    await wait(300);
    fs.writeFileSync(script, "return 3\n");
    await waitFor(() => studio.received.some((m) => m.type === "patchScript" && m.source === "return 3\n"));
    studio.state.daemon!.send(JSON.stringify({
      type: "scriptChanged",
      data: { guid: "s1", path: ["ServerStorage", "Kept"], className: "ModuleScript", source: "return 4\n", base: "return 3\n" },
    }));
    await waitFor(() => fs.readFileSync(script, "utf8") === "return 4\n");
  } finally {
    studio.stop();
    await (second ?? first).stop();
    await wait(300);
    removeQuietly(tmp);
  }
});

test("a Studio that asks to resume a session its daemon does not have gets a snapshot", { timeout: 60000 }, async () => {
  const { tmp, registryFile } = setup();
  const port = await freePort();
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await hub.start();
  const opened: WebSocket[] = [];
  try {
    const first = directStudio(port, 321, "A");
    opened.push(first.hub);
    await waitFor(() => sessionOf(hub)?.studioConnected === true);
    const url = first.state.url!;
    first.state.daemon!.close();
    await waitFor(() => sessionOf(hub)?.studioConnected === false);
    // Another plugin session (Studio reopened) claims to resume: it has nothing queued for this tree
    const received: any[] = [];
    const ws = new WebSocket(url);
    opened.push(ws);
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    ws.on("open", () => ws.send(JSON.stringify({ type: "handshakeStudio", version, placeId: 321, session: "B", resume: true })));
    await waitFor(() => received.some((m) => m.type === "handshakeAck"));
    assert.ok(received.some((m) => m.type === "requestSnapshot"), "asked for a snapshot");
    assert.equal(received.find((m) => m.type === "handshakeAck").resumed, undefined);
  } finally {
    for (const ws of opened) ws.terminate();
    await hub.stop();
    await wait(300);
    removeQuietly(tmp);
  }
});

test("a plugin of another version is turned away without closing the daemon to the next Studio", { timeout: 60000 }, async () => {
  const { tmp, registryFile } = setup();
  const port = await freePort();
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await hub.start();
  const opened: WebSocket[] = [];
  try {
    const first = directStudio(port, 321, "V1");
    opened.push(first.hub);
    await waitFor(() => sessionOf(hub)?.studioConnected === true);
    const url = first.state.url!;
    first.state.daemon!.close();
    await waitFor(() => sessionOf(hub)?.studioConnected === false);
    const old: any[] = [];
    const stale = new WebSocket(url);
    opened.push(stale);
    stale.on("message", (raw) => old.push(JSON.parse(raw.toString())));
    stale.on("open", () => stale.send(JSON.stringify({ type: "handshakeStudio", version: "0.1.0", placeId: 321 })));
    await waitFor(() => old.some((m) => m.type === "daemonDisconnect"));
    await wait(300);
    // The daemon still takes a matching plugin
    const next: any[] = [];
    const ws = new WebSocket(url);
    opened.push(ws);
    ws.on("message", (raw) => next.push(JSON.parse(raw.toString())));
    ws.on("open", () => ws.send(JSON.stringify({ type: "handshakeStudio", version, placeId: 321, session: "V2" })));
    await waitFor(() => next.some((m) => m.type === "handshakeAck"));
  } finally {
    for (const ws of opened) ws.terminate();
    await hub.stop();
    await wait(300);
    removeQuietly(tmp);
  }
});

test("after its daemon crashes, the same Studio reconnecting lands on a new daemon at once", { timeout: 60000 }, async () => {
  const { tmp, registryFile } = setup();
  const port = await freePort();
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await hub.start();
  const opened: WebSocket[] = [];
  try {
    const first = directStudio(port, 321, "C1");
    opened.push(first.hub);
    await waitFor(() => sessionOf(hub)?.studioConnected === true);
    const pid = sessionOf(hub)!.daemonPid!;
    process.kill(pid);
    // The plugin is back right away, same session; the hub's last poll still says "connected"
    const started = Date.now();
    const again = directStudio(port, 321, "C1");
    opened.push(again.hub);
    await waitFor(() => again.received.some((m) => m.type === "handshakeAck"), 10000);
    const took = Date.now() - started;
    assert.ok(took < 2500, `took ${took} ms`);
    assert.notEqual(sessionOf(hub)?.daemonPid, pid);
    if (again.state.daemon) opened.push(again.state.daemon);
    if (first.state.daemon) opened.push(first.state.daemon);
  } finally {
    for (const ws of opened) ws.terminate();
    await hub.stop();
    await wait(300);
    removeQuietly(tmp);
  }
});

test("a script edited on disk during a daemon handoff keeps the edit and reaches the resumed Studio", { timeout: 90000 }, async () => {
  const { tmp, folder, registryFile } = setup();
  const port = await freePort();
  const first = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await first.start();
  let second: QuackHub | undefined;
  const studio = resumingStudio(port, 321, "D1");
  try {
    const script = path.join(folder, "sync", "ServerStorage", "Kept.luau");
    await waitFor(() => fs.existsSync(script) && sessionOf(first)?.studioConnected === true);
    await first.stop({ handoff: true, replaceDaemons: true });
    // Between the old daemon's export and its successor's start: no watcher sees this
    const lock = readHubLock(folder)!;
    const token = lock.token!;
    await fetch(`http://127.0.0.1:${lock.daemonPort}/export?token=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then((r) => r.json())
      .then((r: any) => {
        // The hub would start the successor from this; put the lock back as the hub left it
        fs.writeFileSync(script, 'return "edited during the handoff"\n');
        fs.renameSync(r.file, path.join(folder, ".quack", "handoff-test.json"));
      });
    await waitFor(() => !isAlive(lock.daemonPid), 5000);
    // A successor started from that tree (what the next hub does), then the Studio resumes on it
    second = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
    await second.start();
    await (second as any).sessionFor("321", folder, "Game", path.join(folder, ".quack", "handoff-test.json"));
    await waitFor(() => studio.state.resumed === 1, 30000);
    await waitFor(() => studio.received.some((m) => m.type === "patchScript" && m.source === 'return "edited during the handoff"\n'));
    assert.equal(fs.readFileSync(script, "utf8"), 'return "edited during the handoff"\n', "the disk edit is kept");
    assert.equal(studio.received.filter((m) => m.type === "requestSnapshot").length, 1, "still no snapshot");
  } finally {
    studio.stop();
    await (second ?? first).stop();
    await wait(300);
    removeQuietly(tmp);
  }
});

test("a script edited on disk while the Studio was away reaches it when it resumes", { timeout: 60000 }, async () => {
  const { tmp, folder, registryFile } = setup();
  const port = await freePort();
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await hub.start();
  const opened: WebSocket[] = [];
  try {
    const first = directStudio(port, 321, "E1");
    opened.push(first.hub);
    const script = path.join(folder, "sync", "ServerStorage", "Kept.luau");
    await waitFor(() => fs.existsSync(script) && sessionOf(hub)?.studioConnected === true);
    const url = first.state.url!;
    first.state.daemon!.close();
    await waitFor(() => sessionOf(hub)?.studioConnected === false);
    await wait(300);
    fs.writeFileSync(script, 'return "while away"\n');
    await wait(1000);
    const received: any[] = [];
    const ws = new WebSocket(url);
    opened.push(ws);
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    ws.on("open", () => ws.send(JSON.stringify({ type: "handshakeStudio", version, placeId: 321, session: "E1", resume: true })));
    await waitFor(() => received.some((m) => m.type === "patchScript" && m.source === 'return "while away"\n'));
    assert.equal(received.find((m) => m.type === "handshakeAck")?.resumed, true);
    assert.equal(received.some((m) => m.type === "requestSnapshot"), false);
  } finally {
    for (const ws of opened) ws.terminate();
    await hub.stop();
    await wait(300);
    removeQuietly(tmp);
  }
});

test("a file created on disk while the Studio was away is not resumed over: Studio sends a snapshot", { timeout: 60000 }, async () => {
  const { tmp, folder, registryFile } = setup();
  const port = await freePort();
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await hub.start();
  const opened: WebSocket[] = [];
  try {
    const first = directStudio(port, 321, "F1");
    opened.push(first.hub);
    await waitFor(() => sessionOf(hub)?.studioConnected === true && sessionOf(hub)?.syncedAt !== null);
    const url = first.state.url!;
    first.state.daemon!.close();
    await waitFor(() => sessionOf(hub)?.studioConnected === false);
    await wait(300);
    fs.writeFileSync(path.join(folder, "sync", "ServerStorage", "Brand.luau"), "return 5\n");
    await wait(1500);
    const received: any[] = [];
    const ws = new WebSocket(url);
    opened.push(ws);
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    ws.on("open", () => ws.send(JSON.stringify({ type: "handshakeStudio", version, placeId: 321, session: "F1", resume: true })));
    await waitFor(() => received.some((m) => m.type === "handshakeAck"));
    assert.ok(received.some((m) => m.type === "requestSnapshot"), "a snapshot, not a resume");
  } finally {
    for (const ws of opened) ws.terminate();
    await hub.stop();
    await wait(300);
    removeQuietly(tmp);
  }
});

test("a prewarmed successor: a Studio edit during its standby reaches it, and a disk edit after the switch wins", { timeout: 90000 }, async () => {
  const { tmp, folder, registryFile } = setup();
  const port = await freePort();
  const first = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await first.start();
  let second: QuackHub | undefined;
  const studio = resumingStudio(port, 321, "P1");
  try {
    const script = path.join(folder, "sync", "ServerStorage", "Kept.luau");
    await waitFor(() => fs.existsSync(script) && sessionOf(first)?.studioConnected === true);
    await first.stop({ handoff: true });
    const lock = readHubLock(folder)!;
    const old = `http://127.0.0.1:${lock.daemonPort}`;
    const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-quack-token": lock.token! }, body: JSON.stringify(body) });

    // Prepare: the old daemon keeps syncing
    const prepared = (await (await post(`${old}/export`, { phase: "prepare" })).json()) as any;
    // A hub on another port starts the successor on standby (it does not adopt the old daemon)
    second = new QuackHub({ port: await freePort(), registryFile, daemonCli, log: () => {} });
    await second.start();
    const successor = await (second as any).sessionFor("321", folder, "Game", prepared.file, true);
    await successor.ready;

    // During the standby: a Studio edit lands through the old daemon
    studio.state.daemon!.send(JSON.stringify({
      type: "scriptChanged",
      data: { guid: "s1", path: ["ServerStorage", "Kept"], className: "ModuleScript", source: "return 7\n", base: "return 1\n" },
    }));
    await waitFor(() => fs.readFileSync(script, "utf8") === "return 7\n");

    // The switch: the Studio is sent to the successor, the old daemon hands what changed
    const successorUrl = `ws://127.0.0.1:${successor.childPort}/?token=${successor.token}`;
    const final = (await (await post(`${old}/export`, { phase: "final", successorUrl })).json()) as any;
    // Saved on disk after the old daemon stopped looking, before the successor took over
    await wait(50);
    fs.writeFileSync(script, "return 8\n");
    const took = await fetch(`http://127.0.0.1:${successor.childPort}/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-quack-token": successor.token },
      body: JSON.stringify({ file: final.file }),
    });
    assert.equal(took.status, 200);

    await waitFor(() => studio.state.resumed === 1, 15000);
    await waitFor(() => studio.received.some((m) => m.type === "patchScript" && m.source === "return 8\n"));
    assert.equal(fs.readFileSync(script, "utf8"), "return 8\n", "the disk edit after the switch wins");
    assert.equal(studio.received.filter((m) => m.type === "requestSnapshot").length, 1, "no new snapshot");
    const log = fs.readFileSync(path.join(folder, ".quack", "daemon.log"), "utf8");
    assert.match(log, /Took over \(1 change\(s\) since the standby started\)/, "the standby edit came in the delta");
  } finally {
    studio.stop();
    if (second) await second.stop();
    // A failure before the handoff leaves the first hub running: stopped here (a no-op after it)
    await first.stop().catch(() => {});
    await wait(300);
    removeQuietly(tmp);
  }
});

test("a hub taking over closes the port only for a moment and keeps the daemons and their Studios", { timeout: 60000 }, async () => {
  const { tmp, registryFile } = setup();
  const port = await freePort();
  let firstStopped: Promise<void> | undefined;
  const first: QuackHub = new QuackHub({ port, registryFile, daemonCli, log: () => {}, onShutdownRequest: (o) => void (firstStopped = first.stop(o)) });
  await first.start();
  let second: QuackHub | undefined;
  const studio = directStudio(port, 321, "T1");
  try {
    await waitFor(() => sessionOf(first)?.studioConnected === true);
    const pid = sessionOf(first)!.daemonPid!;
    // Watch the port while the new hub takes over: how long nothing answers
    let watching = true;
    let downFrom: number | null = null;
    let downMs = 0;
    const watcher = (async () => {
      while (watching) {
        const ok = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(200) }).then(() => true, () => false);
        const now = Date.now();
        if (!ok && downFrom === null) downFrom = now;
        if (ok && downFrom !== null) {
          downMs += now - downFrom;
          downFrom = null;
        }
        await wait(2);
      }
    })();
    second = new QuackHub({ port, registryFile, daemonCli, log: () => {}, takeover: true });
    await second.start();
    await firstStopped;
    await wait(200);
    watching = false;
    await watcher;
    assert.ok(downMs < 300, `the port was closed ${downMs} ms`);
    assert.equal(sessionOf(second)?.daemonPid, pid, "the same daemon, adopted");
    await waitFor(() => sessionOf(second!)?.studioConnected === true);
    assert.equal(studio.state.daemon?.readyState, WebSocket.OPEN, "the Studio never noticed");
  } finally {
    studio.hub.terminate();
    studio.state.daemon?.terminate();
    await (second ?? first).stop();
    await wait(300);
    removeQuietly(tmp);
  }
});

test("a malformed request to a hub's daemon is answered 400 and the daemon stays up", { timeout: 60000 }, async () => {
  const { tmp, registryFile } = setup();
  const port = await freePort();
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await hub.start();
  const studio = directStudio(port, 321, "M1");
  try {
    await waitFor(() => sessionOf(hub)?.studioConnected === true);
    const daemonPort = Number(new URL(studio.state.url!).port);
    const pid = sessionOf(hub)!.daemonPid!;
    const status = await new Promise<string>((resolve) => {
      const socket = net.connect(daemonPort, "127.0.0.1", () => socket.write("GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
      let text = "";
      socket.on("data", (d) => (text += d));
      socket.on("close", () => resolve(text.split("\r\n")[0]));
      socket.on("error", () => resolve(text));
      setTimeout(() => socket.destroy(), 1500);
    });
    assert.match(status, /400/);
    await wait(300);
    assert.ok(isAlive(pid), "the daemon is still running");
  } finally {
    studio.hub.terminate();
    studio.state.daemon?.terminate();
    await hub.stop();
    await wait(300);
    removeQuietly(tmp);
  }
});

test("POST /status to a hub's daemon is refused and does not stop it", { timeout: 60000 }, async () => {
  const { tmp, registryFile } = setup();
  const port = await freePort();
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await hub.start();
  const studio = directStudio(port, 321, "N1");
  try {
    await waitFor(() => sessionOf(hub)?.studioConnected === true);
    const url = new URL(studio.state.url!);
    const pid = sessionOf(hub)!.daemonPid!;
    const res = await fetch(`http://127.0.0.1:${url.port}/status`, { method: "POST", headers: { "content-type": "application/json", "x-quack-token": url.searchParams.get("token")! }, body: "{}" });
    assert.equal(res.status, 405);
    await wait(500);
    assert.ok(isAlive(pid), "the daemon is still running");
  } finally {
    studio.hub.terminate();
    studio.state.daemon?.terminate();
    await hub.stop();
    await wait(300);
    removeQuietly(tmp);
  }
});

test("a disk save still in the old watcher's queue at the switch reaches the Studio through the successor", { timeout: 90000 }, async () => {
  const { tmp, folder, registryFile } = setup();
  const port = await freePort();
  const first = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await first.start();
  let second: QuackHub | undefined;
  const studio = resumingStudio(port, 321, "Q1");
  try {
    const script = path.join(folder, "sync", "ServerStorage", "Kept.luau");
    await waitFor(() => fs.existsSync(script) && sessionOf(first)?.studioConnected === true);
    await first.stop({ handoff: true });
    const lock = readHubLock(folder)!;
    const old = `http://127.0.0.1:${lock.daemonPort}`;
    const post = (url: string, token: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-quack-token": token }, body: JSON.stringify(body) });
    const prepared = (await (await post(`${old}/export`, lock.token!, { phase: "prepare" })).json()) as any;
    second = new QuackHub({ port: await freePort(), registryFile, daemonCli, log: () => {} });
    await second.start();
    const successor = await (second as any).sessionFor("321", folder, "Game", prepared.file, true);
    await successor.ready;

    // Saved and switched in the same moment: the old watcher has not delivered it yet
    fs.writeFileSync(script, "return 9\n");
    const final = (await (await post(`${old}/export`, lock.token!, { phase: "final", successorUrl: `ws://127.0.0.1:${successor.childPort}/?token=${successor.token}` })).json()) as any;
    assert.equal((await post(`http://127.0.0.1:${successor.childPort}/takeover`, successor.token, { file: final.file })).status, 200);

    await waitFor(() => studio.state.resumed === 1, 15000);
    await waitFor(() => studio.received.some((m) => m.type === "patchScript" && m.source === "return 9\n"), 10000);
    assert.equal(fs.readFileSync(script, "utf8"), "return 9\n");
  } finally {
    studio.stop();
    if (second) await second.stop();
    // A failure before the handoff leaves the first hub running: stopped here (a no-op after it)
    await first.stop().catch(() => {});
    await wait(300);
    removeQuietly(tmp);
  }
});

/** Old daemon prepared, successor on standby (started by a hub on another port), both reachable */
async function standbyPair(folder: string, registryFile: string, firstPort: number) {
  const lock = readHubLock(folder)!;
  const post = (url: string, token: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-quack-token": token }, body: JSON.stringify(body) });
  const old = `http://127.0.0.1:${lock.daemonPort}`;
  const prepared = (await (await post(`${old}/export`, lock.token!, { phase: "prepare" })).json()) as any;
  const second = new QuackHub({ port: await freePort(), registryFile, daemonCli, log: () => {} });
  await second.start();
  const successor = await (second as any).sessionFor("321", folder, "Game", prepared.file, true);
  await successor.ready;
  void firstPort;
  return { lock, post, old, second, successor };
}

test("a successor without its predecessor's last word makes the Studio send a snapshot, not resume", { timeout: 90000 }, async () => {
  const { tmp, folder, registryFile } = setup();
  const port = await freePort();
  const first = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await first.start();
  let second: QuackHub | undefined;
  const studio = resumingStudio(port, 321, "L1");
  try {
    await waitFor(() => sessionOf(first)?.studioConnected === true);
    await first.stop({ handoff: true });
    const pair = await standbyPair(folder, registryFile, port);
    second = pair.second;
    // The old daemon dies without a final export; the Studio comes back through a hub
    await pair.post(`${pair.old}/shutdown`, pair.lock.token!, {});
    await waitFor(() => !isAlive(pair.lock.daemonPid), 5000);
    assert.equal((await pair.post(`http://127.0.0.1:${pair.successor.childPort}/takeover`, pair.successor.token, {})).status, 200);
    // The hub that knows the successor is `second`; the Studio retries the first hub's port, so
    // it is sent straight to the successor here, as a redirect would
    const received: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${pair.successor.childPort}/?token=${pair.successor.token}`);
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    ws.on("open", () => ws.send(JSON.stringify({ type: "handshakeStudio", version, placeId: 321, session: "L1", resume: true })));
    await waitFor(() => received.some((m) => m.type === "handshakeAck"));
    assert.ok(received.some((m) => m.type === "requestSnapshot"), "a snapshot, not a resume");
    ws.terminate();
  } finally {
    studio.stop();
    if (second) await second.stop();
    // A failure before the handoff leaves the first hub running: stopped here (a no-op after it)
    await first.stop().catch(() => {});
    await wait(300);
    removeQuietly(tmp);
  }
});

test("a script deleted on disk during the switch makes the Studio send a snapshot, not resume over it", { timeout: 90000 }, async () => {
  const { tmp, folder, registryFile } = setup();
  const port = await freePort();
  const first = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await first.start();
  let second: QuackHub | undefined;
  const studio = resumingStudio(port, 321, "G1");
  try {
    const script = path.join(folder, "sync", "ServerStorage", "Kept.luau");
    await waitFor(() => fs.existsSync(script) && sessionOf(first)?.studioConnected === true);
    await first.stop({ handoff: true });
    const pair = await standbyPair(folder, registryFile, port);
    second = pair.second;
    const final = (await (await pair.post(`${pair.old}/export`, pair.lock.token!, { phase: "final", successorUrl: `ws://127.0.0.1:${pair.successor.childPort}/?token=${pair.successor.token}` })).json()) as any;
    fs.rmSync(script);
    assert.equal((await pair.post(`http://127.0.0.1:${pair.successor.childPort}/takeover`, pair.successor.token, { file: final.file })).status, 200);
    // Either the successor's watcher noted the delete on standby (the Studio sends a snapshot), or
    // it arrived after the takeover and went to the resumed Studio like any delete: never lost
    const deleted = () => studio.received.some((m) => m.type === "deleteInstance" && m.guid === "s1");
    await waitFor(() => studio.received.filter((m) => m.type === "requestSnapshot").length === 2 || deleted(), 15000);
    if (!deleted()) {
      // The snapshot is the truth again (it brings the script back from Studio, as any snapshot does)
      assert.equal(studio.state.resumed, 0, "no resume over the deletion");
    } else {
      await wait(300);
      assert.equal(fs.existsSync(script), false, "deleted in Studio too, the file stays deleted");
    }
  } finally {
    studio.stop();
    if (second) await second.stop();
    // A failure before the handoff leaves the first hub running: stopped here (a no-op after it)
    await first.stop().catch(() => {});
    await wait(300);
    removeQuietly(tmp);
  }
});
