import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { QuackHub } from "../hub/hub.js";
import { saveRegistry } from "../hub/registry.js";
import { readConflict, readLogChunk, readMerges, resolveConflict } from "../hub/api.js";

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

async function waitFor(check: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(50);
  }
}

/** A fake Studio: handshake with its place, answer the snapshot request with one script */
function fakeStudio(port: number, placeId: number, scriptName: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const received: any[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    received.push(msg);
    if (msg.type === "requestSnapshot") {
      ws.send(JSON.stringify({
        type: "fullSnapshot",
        placeId,
        data: [
          { guid: "ss", className: "ServerStorage", name: "ServerStorage", path: ["ServerStorage"], parentGuid: "root" },
          { guid: `s${placeId}`, className: "ModuleScript", name: scriptName, path: ["ServerStorage", scriptName], parentGuid: "ss", source: `return "${scriptName}"\n` },
        ],
      }));
    }
  });
  ws.on("open", () => ws.send(JSON.stringify({ type: "handshakeStudio", version, placeId, placeName: scriptName })));
  return { ws, received };
}

test("the hub routes each place to its own folder, refuses unknown places, reuses daemons", { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-hub-"));
  const folderA = path.join(tmp, "GameA");
  const folderB = path.join(tmp, "GameB");
  fs.mkdirSync(folderA);
  fs.mkdirSync(folderB);
  const registryFile = path.join(tmp, "hub.json");
  saveRegistry(registryFile, { places: { "111": { folder: folderA, name: "Game A" }, "222": { folder: folderB, name: "Game B" } } });
  const port = await freePort();
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await hub.start();
  const opened: WebSocket[] = [];
  try {
    const a = fakeStudio(port, 111, "AlphaScript");
    const b = fakeStudio(port, 222, "BetaScript");
    opened.push(a.ws, b.ws);
    const fileA = path.join(folderA, "sync", "ServerStorage", "AlphaScript.luau");
    const fileB = path.join(folderB, "sync", "ServerStorage", "BetaScript.luau");
    await waitFor(() => fs.existsSync(fileA) && fs.existsSync(fileB));
    assert.ok(a.received.some((m) => m.type === "handshakeAck"));
    assert.equal(fs.existsSync(path.join(folderA, "sync", "ServerStorage", "BetaScript.luau")), false, "B's script must not land in A");
    assert.equal(fs.existsSync(path.join(folderB, "sync", "ServerStorage", "AlphaScript.luau")), false, "A's script must not land in B");

    // A save in A's folder reaches Studio A only
    await wait(500);
    fs.writeFileSync(fileA, 'return "edited in A"\n');
    await waitFor(() => a.received.some((m) => m.type === "patchScript" && m.source === 'return "edited in A"\n'));
    await wait(300);
    assert.equal(b.received.some((m) => m.type === "patchScript"), false, "Studio B got A's patch");

    // Unknown place: error + disconnect, no daemon started for it
    const stranger = fakeStudio(port, 999, "Stranger");
    opened.push(stranger.ws);
    await waitFor(() => stranger.received.some((m) => m.type === "daemonDisconnect"));
    assert.ok(stranger.received.some((m) => m.type === "error" && /not registered/.test(m.message)));

    // Sessions API lists the two games
    const api = (await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json()) as any;
    assert.deepEqual(api.sessions.map((s: any) => s.placeId).sort(), ["111", "222"]);
    const pidA = api.sessions.find((s: any) => s.placeId === "111").daemonPid;

    // Studio A reconnects: same daemon, files untouched
    a.ws.close();
    await wait(500);
    const again = fakeStudio(port, 111, "AlphaScript");
    opened.push(again.ws);
    await waitFor(() => again.received.some((m) => m.type === "handshakeAck"));
    const api2 = (await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json()) as any;
    assert.equal(api2.sessions.find((s: any) => s.placeId === "111").daemonPid, pidA);
  } finally {
    for (const ws of opened) ws.terminate();
    await hub.stop();
    await wait(500);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

async function withHub(
  places: Record<string, string>,
  body: (ctx: { port: number; hub: QuackHub; tmp: string; registryFile: string; folders: Record<string, string> }) => Promise<void>,
  extra: Partial<ConstructorParameters<typeof QuackHub>[0]> = {},
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-hub-"));
  const folders: Record<string, string> = {};
  const registry: Record<string, { folder: string; name: string }> = {};
  for (const [placeId, name] of Object.entries(places)) {
    folders[placeId] = path.join(tmp, name);
    fs.mkdirSync(folders[placeId]);
    registry[placeId] = { folder: folders[placeId], name };
  }
  const registryFile = path.join(tmp, "hub.json");
  saveRegistry(registryFile, { places: registry });
  const port = await freePort();
  // Never this machine's config.json or AI CLIs
  const noAi = async () => ({ claude: { installed: false, loggedIn: false }, codex: { installed: false, loggedIn: false } });
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {}, configFile: path.join(tmp, "config.json"), detectAi: noAi, ...extra });
  await hub.start();
  try {
    await body({ port, hub, tmp, registryFile, folders });
  } finally {
    await hub.stop();
    await wait(500);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const sessionsOf = async (port: number) =>
  ((await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json()) as any).sessions as any[];

test("a malformed request target does not crash the hub", { timeout: 30000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port }) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    socket.write("GET //[ HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    await wait(500);
    socket.destroy();
    // Still serving
    assert.deepEqual(await sessionsOf(port), []);
  });
});

test("a client that never names its place is cut at the deadline", { timeout: 30000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    let closedAt = 0;
    ws.on("close", () => (closedAt = Date.now()));
    await new Promise((r) => ws.on("open", r));
    const t0 = Date.now();
    ws.send(JSON.stringify({ type: "ping" }));
    await waitFor(() => closedAt > 0, 5000);
    assert.ok(closedAt - t0 >= 250, "closed too early");
  }, { handshakeDeadlineMs: 300 });
});

test("two Studios of one place at the same moment start a single daemon", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port }) => {
    const first = fakeStudio(port, 111, "AlphaScript");
    const second = fakeStudio(port, 111, "AlphaScript");
    await waitFor(() => first.received.length > 0 && second.received.length > 0);
    await wait(500);
    const sessions = await sessionsOf(port);
    assert.equal(sessions.length, 1);
    // One of them syncs, the other is told the daemon is busy
    const all = [...first.received, ...second.received].map((m) => m.type);
    assert.ok(all.includes("handshakeAck"));
    assert.ok(all.includes("daemonBusy"));
    first.ws.terminate();
    second.ws.terminate();
  });
});

test("re-registering a place to another folder moves it to a new daemon there", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port, tmp, registryFile, folders }) => {
    const a = fakeStudio(port, 111, "AlphaScript");
    await waitFor(() => fs.existsSync(path.join(folders["111"], "sync", "ServerStorage", "AlphaScript.luau")));
    const pid1 = (await sessionsOf(port))[0].daemonPid;
    a.ws.terminate();

    const moved = path.join(tmp, "GameMoved");
    fs.mkdirSync(moved);
    saveRegistry(registryFile, { places: { "111": { folder: moved, name: "GameA" } } });
    const again = fakeStudio(port, 111, "AlphaScript");
    await waitFor(() => fs.existsSync(path.join(moved, "sync", "ServerStorage", "AlphaScript.luau")));
    const sessions = await sessionsOf(port);
    assert.equal(sessions.length, 1);
    assert.notEqual(sessions[0].daemonPid, pid1);
    assert.equal(path.resolve(sessions[0].folder), path.resolve(moved));
    again.ws.terminate();
  });
});

test("a daemon that fails to start is refused cleanly and retried on the next connection", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port }) => {
    const broken = fakeStudio(port, 111, "AlphaScript");
    await waitFor(() => broken.received.some((m) => m.type === "daemonDisconnect"));
    assert.ok(broken.received.some((m) => m.type === "error" && /did not start/.test(m.message)));
    assert.deepEqual(await sessionsOf(port), []);
  }, { daemonCli: path.join(os.tmpdir(), "no-such-quack-cli.js") });
});

test("a web page (browser Origin) cannot connect; a client without Origin can", { timeout: 30000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port }) => {
    const page = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: "https://evil.example" });
    const pageResult = await new Promise<string>((resolve) => {
      page.on("open", () => resolve("open"));
      page.on("error", () => resolve("refused"));
      page.on("unexpected-response", () => resolve("refused"));
    });
    assert.equal(pageResult, "refused");
    const studio = fakeStudio(port, 111, "AlphaScript");
    await waitFor(() => studio.received.some((m) => m.type === "handshakeAck"));
    studio.ws.terminate();
  });
});

test("a second Studio refused as busy does not take the first one's place in the list", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port }) => {
    const first = fakeStudio(port, 111, "AlphaScript");
    await waitFor(() => first.received.some((m) => m.type === "handshakeAck"));
    const second = fakeStudio(port, 111, "AlphaScript");
    await waitFor(() => second.received.some((m) => m.type === "daemonBusy"));
    await wait(300);
    const sessions = await sessionsOf(port);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].studioConnected, true);
    first.ws.terminate();
    second.ws.terminate();
  });
});

/** A raw HTTP call, so tests can send the headers a browser would (fetch may drop Origin) */
function call(port: number, method: string, target: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: target,
      headers: { ...(payload !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: any;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = text;
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

test("the app API: state, log tail, merges, and a conflict resolved with the disk version", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port, folders }) => {
    const folder = folders["111"];
    const studio = fakeStudio(port, 111, "AlphaScript");
    const script = path.join(folder, "sync", "ServerStorage", "AlphaScript.luau");
    await waitFor(() => fs.existsSync(script));

    // State: the session with the instance count the daemon printed
    let state: any;
    const end = Date.now() + 10000;
    do {
      state = (await call(port, "GET", "/api/state")).json;
      if (state.sessions[0]?.instances) break;
      await wait(100);
    } while (Date.now() < end);
    assert.equal(state.paused, false);
    assert.equal(state.sessions[0].placeId, "111");
    assert.equal(state.sessions[0].instances, 3, "root, ServerStorage and the script");
    assert.equal(state.sessions[0].scripts, 1);
    assert.deepEqual(state.places.map((p: any) => p.placeId), ["111"]);

    // Log: a tail read without colour codes, then only what was appended
    const first = (await call(port, "GET", "/api/log?placeId=111")).json;
    assert.match(first.text, /Sync complete/);
    assert.equal(/\x1b/.test(first.text), false, "colour codes must be stripped");
    fs.appendFileSync(path.join(folder, ".quack", "daemon.log"), "\x1b[32mappended line\x1b[0m\n");
    const second = (await call(port, "GET", `/api/log?placeId=111&from=${first.next}`)).json;
    assert.equal(second.text, "appended line\n");
    assert.equal(second.reset, false);
    const coloured = (await call(port, "GET", `/api/log?placeId=111&from=${first.next}&ansi=1`)).json;
    assert.equal(coloured.text, "\x1b[32mappended line\x1b[0m\n", "ansi=1 keeps the colours the app reads levels from");

    // A merge that saved the disk version, as the daemon writes it
    const id = ".quack/conflicts/ServerStorage/AlphaScript.luau.2026-10-20T10-00-00-000Z-abc123.luau";
    fs.mkdirSync(path.dirname(path.join(folder, id)), { recursive: true });
    fs.writeFileSync(path.join(folder, id), 'return "disk side"\n');
    fs.appendFileSync(path.join(folder, ".quack", "merge-log.jsonl"),
      JSON.stringify({ t: new Date().toISOString(), file: "ServerStorage/AlphaScript.luau", method: "text", conflictingHunks: 1, textMergeErrors: [], ms: 100, agentVersion: id }) + "\n" +
      "{ cut by a crash\n");
    const merges = (await call(port, "GET", "/api/merges?placeId=111")).json;
    assert.equal(merges.today, 1);
    assert.equal(merges.conflicts.length, 1);
    assert.equal((await call(port, "GET", "/api/state")).json.places[0].conflicts, 1);

    const view = (await call(port, "GET", `/api/conflict?placeId=111&id=${encodeURIComponent(id)}`)).json;
    assert.equal(view.saved, 'return "disk side"\n');
    assert.equal(view.current, 'return "AlphaScript"\n');
    assert.equal(path.resolve(view.path), path.resolve(script));

    // Ids that leave the folder are refused
    for (const bad of ["../../hub.json", ".quack/conflicts/../../../hub.json", ".quack/other.luau"]) {
      assert.equal((await call(port, "GET", `/api/conflict?placeId=111&id=${encodeURIComponent(bad)}`)).status, 400, bad);
    }

    // "Use the disk version": the file takes it, the daemon sends it to Studio, the conflict is gone
    await wait(500);
    assert.equal((await call(port, "POST", "/api/conflict/resolve", { placeId: "111", id, action: "useDisk" })).status, 200);
    assert.equal(fs.readFileSync(script, "utf8"), 'return "disk side"\n');
    await waitFor(() => studio.received.some((m) => m.type === "patchScript" && m.source === 'return "disk side"\n'));
    assert.equal((await call(port, "GET", "/api/merges?placeId=111")).json.conflicts.length, 0);
    assert.deepEqual(fs.readdirSync(path.dirname(script)).filter((f) => f.includes("quack-tmp")), [], "no temp file left behind");
    studio.ws.terminate();
  });
});

test("the app API refuses web pages and form posts", { timeout: 30000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port }) => {
    assert.equal((await call(port, "GET", "/api/state", undefined, { origin: "https://evil.example" })).status, 403);
    assert.equal((await call(port, "POST", "/api/pause", '{"paused":true}', { origin: "null", "content-type": "application/json" })).status, 403);
    // A page can post text/plain without asking first: never accepted
    assert.equal((await call(port, "POST", "/api/pause", '{"paused":true}', { "content-type": "text/plain" })).status, 415);
    assert.equal((await call(port, "GET", "/api/state")).json.paused, false);
    assert.equal((await call(port, "POST", "/api/pause", { paused: "yes" })).status, 400);
    assert.equal((await call(port, "GET", "/api/log?placeId=999")).status, 404);
    assert.equal((await call(port, "GET", "/api/log?placeId=111&from=-5")).status, 400);
  });
});

test("pause stops every daemon and turns Studios away until resumed", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port }) => {
    const studio = fakeStudio(port, 111, "AlphaScript");
    await waitFor(() => studio.received.some((m) => m.type === "handshakeAck"));
    assert.equal((await call(port, "POST", "/api/pause", { paused: true })).status, 200);
    assert.deepEqual(await sessionsOf(port), []);
    const turnedAway = fakeStudio(port, 111, "AlphaScript");
    await waitFor(() => turnedAway.received.some((m) => m.type === "daemonDisconnect"));
    assert.ok(turnedAway.received.some((m) => m.type === "error" && /paused/.test(m.message)));
    assert.equal((await call(port, "GET", "/api/state")).json.paused, true);

    assert.equal((await call(port, "POST", "/api/pause", { paused: false })).status, 200);
    const back = fakeStudio(port, 111, "AlphaScript");
    await waitFor(() => back.received.some((m) => m.type === "handshakeAck"));
    for (const s of [studio, turnedAway, back]) s.ws.terminate();
  });
});

test("a refused place is listed until the app registers it, then it connects", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port, tmp }) => {
    const stranger = fakeStudio(port, 555, "Stranger");
    await waitFor(() => stranger.received.some((m) => m.type === "daemonDisconnect"));
    const refused = (await call(port, "GET", "/api/state")).json.refused;
    assert.deepEqual(refused.map((r: any) => [r.placeId, r.placeName]), [["555", "Stranger"]]);

    assert.equal((await call(port, "POST", "/api/registry", { placeId: "555", folder: "relative/path" })).status, 400);
    assert.equal((await call(port, "POST", "/api/registry", { placeId: "555", folder: path.join(tmp, "missing") })).status, 400);
    const folder = path.join(tmp, "Stranger");
    fs.mkdirSync(folder);
    assert.equal((await call(port, "POST", "/api/registry", { placeId: "555", folder, name: "Stranger" })).status, 200);
    const state = (await call(port, "GET", "/api/state")).json;
    assert.deepEqual(state.refused, []);
    assert.deepEqual(state.places.map((p: any) => p.placeId).sort(), ["111", "555"]);

    const again = fakeStudio(port, 555, "Stranger");
    await waitFor(() => fs.existsSync(path.join(folder, "sync", "ServerStorage", "Stranger.luau")));

    // Unregistering stops its daemon
    assert.equal((await call(port, "POST", "/api/unregister", { placeId: "555" })).status, 200);
    assert.deepEqual(await sessionsOf(port), []);
    stranger.ws.terminate();
    again.ws.terminate();
  });
});

test("shutdown exists only when the hub's owner asked for it", { timeout: 30000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port }) => {
    assert.equal((await call(port, "POST", "/api/shutdown", {})).status, 404);
  });
  let asked = 0;
  await withHub({ "111": "GameA" }, async ({ port }) => {
    assert.equal((await call(port, "POST", "/api/shutdown", {}, { origin: "https://evil.example", "content-type": "application/json" })).status, 403);
    assert.equal((await call(port, "POST", "/api/shutdown", {})).status, 200);
    await waitFor(() => asked === 1, 2000);
  }, { onShutdownRequest: () => asked++ });
});

test("the app API refuses a request whose Host is not this machine (DNS rebinding)", { timeout: 30000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port }) => {
    assert.equal((await call(port, "GET", "/api/state", undefined, { host: `evil.example:${port}` })).status, 403);
    assert.equal((await call(port, "GET", "/api/state", undefined, { host: `localhost:${port}` })).status, 200);
    assert.equal((await call(port, "GET", "/api/state", undefined, { host: `127.0.0.1:${port}` })).status, 200);
  });
});

test("the log reader cuts on bytes: a character split by the read cap comes back whole", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "quack-log-"));
  try {
    fs.mkdirSync(path.join(folder, ".quack"));
    // 2-byte characters on 3-byte lines: the 1 MB cap lands inside a character
    const text = "é\n".repeat(400_000);
    fs.writeFileSync(path.join(folder, ".quack", "daemon.log"), text);
    let from = 0;
    let read = "";
    for (let i = 0; i < 10 && from < Buffer.byteLength(text); i++) {
      const chunk = readLogChunk(folder, from);
      read += chunk.text;
      assert.ok(chunk.next > from, "the cursor must move");
      from = chunk.next;
    }
    assert.equal(read.includes("�"), false, "no replacement characters");
    assert.equal(read, text);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("the log reader moves past a line longer than its read cap", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "quack-log-"));
  try {
    fs.mkdirSync(path.join(folder, ".quack"));
    fs.writeFileSync(path.join(folder, ".quack", "daemon.log"), "x".repeat(1_500_000) + "\nend\n");
    let from = 0;
    let read = "";
    for (let i = 0; i < 5; i++) {
      const chunk = readLogChunk(folder, from);
      read += chunk.text;
      from = chunk.next;
    }
    assert.ok(read.endsWith("\nend\n"), "the line after the long one is reached");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("an unresolved conflict older than the listed history still opens; a link out of the folder does not", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-conflict-"));
  const folder = path.join(tmp, "Game");
  const outside = path.join(tmp, "Outside");
  try {
    fs.mkdirSync(path.join(folder, ".quack", "conflicts", "ServerStorage"), { recursive: true });
    fs.mkdirSync(path.join(folder, "sync", "ServerStorage"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(folder, "sync", "ServerStorage", "Old.luau"), "now\n");
    const old = ".quack/conflicts/ServerStorage/Old.luau.old.luau";
    fs.writeFileSync(path.join(folder, old), "saved\n");
    const lines = [JSON.stringify({ t: "2026-01-01T00:00:00.000Z", file: "ServerStorage/Old.luau", method: "text", conflictingHunks: 1, agentVersion: old })];
    for (let i = 0; i < 250; i++) lines.push(JSON.stringify({ t: new Date().toISOString(), file: `ServerStorage/S${i}.luau`, method: "text", conflictingHunks: 0 }));

    // A directory junction (no admin rights needed on Windows) from the conflicts folder outward
    fs.writeFileSync(path.join(outside, "secret.luau"), "secret\n");
    fs.symlinkSync(outside, path.join(folder, ".quack", "conflicts", "link"), "junction");
    const linked = ".quack/conflicts/link/secret.luau";
    lines.push(JSON.stringify({ t: new Date().toISOString(), file: "ServerStorage/Old.luau", method: "text", conflictingHunks: 1, agentVersion: linked }));
    fs.writeFileSync(path.join(folder, ".quack", "merge-log.jsonl"), lines.join("\n") + "\n");

    const summary = readMerges(folder);
    assert.equal(summary.entries.some((e) => e.agentVersion === old), false, "the old one is past the listed history");
    assert.equal(readConflict(folder, old).saved, "saved\n");
    assert.throws(() => readConflict(folder, linked), /link leads outside/);
    assert.throws(() => resolveConflict(folder, linked, "useDisk"), /link leads outside/);
    assert.equal(fs.readFileSync(path.join(folder, "sync", "ServerStorage", "Old.luau"), "utf8"), "now\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pausing while a daemon start waits for its port leaves no daemon behind", { timeout: 30000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ hub, folders }) => {
    // sessionFor runs until it awaits the free port; the pause lands right there
    const starting = (hub as any).sessionFor("111", folders["111"], "GameA") as Promise<any>;
    hub.setPaused(true);
    await assert.rejects(starting, /paused/);
    await wait(300);
    assert.deepEqual(hub.listSessions(), []);
  });
});

test("marking a conflict seen replaces a resolved.json link instead of writing through it", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-resolved-"));
  const folder = path.join(tmp, "Game");
  try {
    fs.mkdirSync(path.join(folder, ".quack", "conflicts"), { recursive: true });
    fs.mkdirSync(path.join(folder, "sync"), { recursive: true });
    const id = ".quack/conflicts/A.luau.x.luau";
    fs.writeFileSync(path.join(folder, id), "saved\n");
    fs.writeFileSync(path.join(folder, ".quack", "merge-log.jsonl"), JSON.stringify({ t: new Date().toISOString(), file: "A.luau", method: "text", conflictingHunks: 1, agentVersion: id }) + "\n");
    // A hard link (no admin rights needed) from resolved.json to a file outside the folder
    const outside = path.join(tmp, "outside.txt");
    fs.writeFileSync(outside, "keep me\n");
    fs.linkSync(outside, path.join(folder, ".quack", "resolved.json"));
    resolveConflict(folder, id, "keep");
    assert.equal(fs.readFileSync(outside, "utf8"), "keep me\n", "the outside file is untouched");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, ".quack", "resolved.json"), "utf8")).ids, [id]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("an unresolved conflict stays listed past a long merge history; a deleted sync folder still resolves", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-history-"));
  const folder = path.join(tmp, "Game");
  try {
    fs.mkdirSync(path.join(folder, ".quack", "conflicts"), { recursive: true });
    const id = ".quack/conflicts/A.luau.old.luau";
    fs.writeFileSync(path.join(folder, id), "saved\n");
    const lines = [JSON.stringify({ t: "2026-01-01T00:00:00.000Z", file: "ServerStorage/A.luau", method: "text", conflictingHunks: 1, agentVersion: id })];
    // Over 512 KB of later merges
    const filler = "x".repeat(400);
    for (let i = 0; i < 2000; i++) lines.push(JSON.stringify({ t: new Date().toISOString(), file: `ServerStorage/S${i}.luau`, method: "text", conflictingHunks: 0, note: filler }));
    fs.writeFileSync(path.join(folder, ".quack", "merge-log.jsonl"), lines.join("\n") + "\n");
    assert.ok(fs.statSync(path.join(folder, ".quack", "merge-log.jsonl")).size > 512 * 1024);
    assert.deepEqual(readMerges(folder).conflicts.map((c) => c.agentVersion), [id]);

    // No sync folder at all: the conflict opens, and the disk version recreates the script
    const view = readConflict(folder, id);
    assert.equal(view.current, null);
    resolveConflict(folder, id, "useDisk");
    assert.equal(fs.readFileSync(path.join(folder, "sync", "ServerStorage", "A.luau"), "utf8"), "saved\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a line longer than the read cap goes out in pieces that never split a character", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "quack-log-"));
  try {
    fs.mkdirSync(path.join(folder, ".quack"));
    // One ASCII byte first: the 2-byte characters then straddle the (even) 1 MB cap
    const text = "a" + "é".repeat(800_000) + "\nend\n";
    fs.writeFileSync(path.join(folder, ".quack", "daemon.log"), text);
    let from = 0;
    let read = "";
    for (let i = 0; i < 6; i++) {
      const chunk = readLogChunk(folder, from);
      read += chunk.text;
      from = chunk.next;
    }
    assert.equal(read.includes("�"), false);
    assert.equal(read, text);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/** A fake Studio with the new handshake fields, recording every message it gets */
function studioWith(port: number, placeId: number, scriptName: string, extra: { session?: string; explicit?: boolean; setup?: boolean } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const received: any[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    received.push(msg);
    if (msg.type === "requestSnapshot") {
      ws.send(JSON.stringify({
        type: "fullSnapshot",
        placeId,
        data: [
          { guid: "ss", className: "ServerStorage", name: "ServerStorage", path: ["ServerStorage"], parentGuid: "root" },
          { guid: `s${placeId}`, className: "ModuleScript", name: scriptName, path: ["ServerStorage", scriptName], parentGuid: "ss", source: `return "${scriptName}"\n` },
        ],
      }));
    }
  });
  ws.on("open", () => ws.send(JSON.stringify({ type: "handshakeStudio", version, placeId, placeName: scriptName, ...extra })));
  return { ws, received };
}

/** A process that stands in for a standalone daemon (the old `quack start`): alive and listening */
async function fakeStandalone(folder: string) {
  const child = spawn(process.execPath, ["-e", "require('net').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)}); setInterval(()=>{},1e6)"], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise<number>((resolve) => child.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
  fs.mkdirSync(path.join(folder, ".quack"), { recursive: true });
  fs.writeFileSync(path.join(folder, ".quack", "daemon.pid"), `${child.pid}\r\n${folder}\r\n`);
  return { child, port };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a folder synced by a live standalone Quack waits for a choice; continue stops it and syncs", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port, folders }) => {
    const folder = folders["111"];
    const other = await fakeStandalone(folder);
    try {
      const first = studioWith(port, 111, "AlphaScript", { session: "s1" });
      await waitFor(() => first.received.some((m) => m.type === "daemonDisconnect"));
      assert.ok(first.received.some((m) => m.type === "error" && /already synced by a standalone Quack/.test(m.message)), JSON.stringify(first.received));
      const state = (await call(port, "GET", "/api/state")).json;
      assert.deepEqual(state.pending.map((p: any) => [p.kind, p.placeId, p.other.pid]), [["folderInUse", "111", other.child.pid]]);
      assert.deepEqual(state.sessions, [], "no daemon started while the user decides");
      assert.ok(alive(other.child.pid!));

      assert.equal((await call(port, "POST", "/api/choice", { id: state.pending[0].id, decision: "continue" })).status, 200);
      const second = studioWith(port, 111, "AlphaScript", { session: "s1" });
      await waitFor(() => fs.existsSync(path.join(folder, "sync", "ServerStorage", "AlphaScript.luau")));
      assert.equal(alive(other.child.pid!), false, "the other Quack was stopped");
      assert.equal(fs.existsSync(path.join(folder, ".quack", "daemon.pid")), false);
      // The folder is now marked as this hub's
      const lock = JSON.parse(fs.readFileSync(path.join(folder, ".quack", "hub-lock.json"), "utf8"));
      assert.equal(lock.hubPid, process.pid);
      assert.equal(lock.hubPort, port);
      assert.deepEqual((await call(port, "GET", "/api/state")).json.pending, []);
      first.ws.terminate();
      second.ws.terminate();
    } finally {
      other.child.kill();
    }
  });
});

test("cancel keeps the other Quack and stops the retries until the user connects by hand", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port, folders }) => {
    const other = await fakeStandalone(folders["111"]);
    try {
      const first = studioWith(port, 111, "AlphaScript", { session: "s1" });
      await waitFor(() => first.received.some((m) => m.type === "daemonDisconnect"));
      const id = (await call(port, "GET", "/api/state")).json.pending[0].id;
      assert.equal((await call(port, "POST", "/api/choice", { id, decision: "cancel" })).status, 200);

      // An auto-connect retry: refused for good (daemonBusy stops the plugin's retries), no new question
      const retry = studioWith(port, 111, "AlphaScript", { session: "s1" });
      await waitFor(() => retry.received.some((m) => m.type === "daemonBusy"));
      assert.match(retry.received.find((m) => m.type === "daemonBusy").message, /stays with/);
      assert.deepEqual((await call(port, "GET", "/api/state")).json.pending, []);
      assert.ok(alive(other.child.pid!), "the other Quack keeps running");

      // Clicking Connect asks again
      const byHand = studioWith(port, 111, "AlphaScript", { session: "s1", explicit: true });
      await waitFor(() => byHand.received.some((m) => m.type === "daemonDisconnect"));
      assert.equal((await call(port, "GET", "/api/state")).json.pending.length, 1);
      for (const s of [first, retry, byHand]) s.ws.terminate();
    } finally {
      other.child.kill();
    }
  });
});

test("a pid file of a dead process asks nothing", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port, folders }) => {
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => gone.once("exit", r));
    fs.mkdirSync(path.join(folders["111"], ".quack"), { recursive: true });
    fs.writeFileSync(path.join(folders["111"], ".quack", "daemon.pid"), `${gone.pid}\r\n${folders["111"]}\r\n`);
    const studio = studioWith(port, 111, "AlphaScript", { session: "s1" });
    await waitFor(() => studio.received.some((m) => m.type === "handshakeAck"));
    assert.deepEqual((await call(port, "GET", "/api/state")).json.pending, []);
    studio.ws.terminate();
  });
});

test("a second Studio of a place takes it over only after the user agrees", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port }) => {
    const a = studioWith(port, 111, "AlphaScript", { session: "a" });
    await waitFor(() => a.received.some((m) => m.type === "handshakeAck"));

    const b = studioWith(port, 111, "AlphaScript", { session: "b" });
    await waitFor(() => b.received.some((m) => m.type === "daemonDisconnect"));
    assert.ok(b.received.some((m) => m.type === "error" && /another Studio is syncing this place/.test(m.message)));
    const pending = (await call(port, "GET", "/api/state")).json.pending;
    assert.deepEqual(pending.map((p: any) => p.kind), ["secondStudio"]);
    assert.equal(a.ws.readyState, WebSocket.OPEN, "the first Studio is untouched while the user decides");

    assert.equal((await call(port, "POST", "/api/choice", { id: pending[0].id, decision: "continue" })).status, 200);
    const b2 = studioWith(port, 111, "AlphaScript", { session: "b" });
    await waitFor(() => b2.received.some((m) => m.type === "handshakeAck"));
    await waitFor(() => a.received.some((m) => m.type === "daemonBusy"));
    assert.match(a.received.find((m) => m.type === "daemonBusy").message, /took this place over/);

    // The displaced Studio's auto-connect is refused quietly; only Connect by hand asks again
    const aRetry = studioWith(port, 111, "AlphaScript", { session: "a" });
    await waitFor(() => aRetry.received.some((m) => m.type === "daemonBusy"));
    assert.deepEqual((await call(port, "GET", "/api/state")).json.pending, []);
    const aByHand = studioWith(port, 111, "AlphaScript", { session: "a", explicit: true });
    await waitFor(() => aByHand.received.some((m) => m.type === "daemonDisconnect"));
    assert.equal((await call(port, "GET", "/api/state")).json.pending.length, 1);
    assert.equal(b2.ws.readyState, WebSocket.OPEN, "the Studio that took over is still syncing");
    for (const s of [a, b, b2, aRetry, aByHand]) s.ws.terminate();
  });
});

test("the folder lock goes when the hub's daemon stops; a choice for nothing is refused", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port, folders, hub }) => {
    const studio = studioWith(port, 111, "AlphaScript", { session: "s1" });
    await waitFor(() => studio.received.some((m) => m.type === "handshakeAck"));
    const lockPath = path.join(folders["111"], ".quack", "hub-lock.json");
    await waitFor(() => fs.existsSync(lockPath));
    hub.setPaused(true);
    await waitFor(() => !fs.existsSync(lockPath), 10000);
    assert.equal((await call(port, "POST", "/api/choice", { id: "folder:999", decision: "continue" })).status, 404);
    assert.equal((await call(port, "POST", "/api/choice", { id: "folder:999", decision: "maybe" })).status, 400);
    studio.ws.terminate();
  });
});

test("a 2.4 plugin hears a version it accepts; a 1.0 plugin hears the real one", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA", "222": "GameB" }, async ({ port }) => {
    const ackFrom = (placeId: number, pluginVersion: string) => new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      ws.on("open", () => ws.send(JSON.stringify({ type: "handshakeStudio", version: pluginVersion, placeId, placeName: "G" })));
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "requestSnapshot") ws.send(JSON.stringify({ type: "fullSnapshot", placeId, data: [] }));
        if (msg.type === "handshakeAck") {
          resolve(msg.version);
          ws.terminate();
        }
      });
    });
    // The 2.4 plugin compares major.minor and would drop a daemon that says 1.0
    assert.match(await ackFrom(111, "2.4.0"), /^2\.4\./);
    assert.equal(await ackFrom(222, version), version);
  });
});

test("Set up: the request waits in the app, stamped folders are offered, registering connects it", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port, tmp }) => {
    // Two folders under a projects root: one stamped as Quack, one as Azul did, one unrelated
    const projects = path.join(tmp, "Projects");
    const stamped = path.join(projects, "Old Game");
    const legacy = path.join(projects, "Older Game");
    fs.mkdirSync(path.join(projects, "Unrelated"), { recursive: true });
    fs.mkdirSync(stamped, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(stamped, "sourcemap.json"), JSON.stringify({ name: "Game", children: [], _quack: { placeId: 777 } }));
    fs.writeFileSync(path.join(legacy, "sourcemap.json"), JSON.stringify({ name: "Game", children: [], _azul: { placeId: 777 } }));

    const asking = studioWith(port, 777, "NewGame", { session: "s1", explicit: true, setup: true });
    await waitFor(() => asking.received.some((m) => m.type === "daemonDisconnect"));
    assert.ok(asking.received.some((m) => m.type === "error" && /finish setting this place up/.test(m.message)));
    const pending = (await call(port, "GET", "/api/state")).json.pending;
    assert.deepEqual(pending.map((p: any) => [p.kind, p.placeId, p.placeName]), [["setup", "777", "NewGame"]]);

    // An auto-connect retry without the flag keeps the request alive instead of a plain refusal
    const retry = studioWith(port, 777, "NewGame", { session: "s1" });
    await waitFor(() => retry.received.some((m) => m.type === "daemonDisconnect"));
    assert.ok(retry.received.some((m) => m.type === "error" && /finish setting this place up/.test(m.message)));

    const found = (await call(port, "GET", `/api/setup-candidates?placeId=777&name=${encodeURIComponent("New: Game?")}&root=${encodeURIComponent(projects)}`)).json;
    assert.deepEqual(found.existing.map((f: string) => path.basename(f)).sort(), ["Old Game", "Older Game"]);
    assert.equal(found.folderName, "New Game");
    assert.equal((await call(port, "GET", "/api/setup-candidates?placeId=abc")).status, 400);

    // Registering answers the request; the next attempt syncs
    assert.equal((await call(port, "POST", "/api/registry", { placeId: "777", folder: stamped, name: "NewGame" })).status, 200);
    assert.deepEqual((await call(port, "GET", "/api/state")).json.pending, []);
    const synced = studioWith(port, 777, "NewGame", { session: "s1" });
    await waitFor(() => synced.received.some((m) => m.type === "handshakeAck"));
    for (const s of [asking, retry, synced]) s.ws.terminate();
  });
});

test("Set up cancelled in the app: the place goes back to a plain refusal until Set up is clicked again", { timeout: 60000 }, async () => {
  await withHub({ "111": "GameA" }, async ({ port }) => {
    const asking = studioWith(port, 777, "NewGame", { session: "s1", explicit: true, setup: true });
    await waitFor(() => asking.received.some((m) => m.type === "daemonDisconnect"));
    assert.equal((await call(port, "POST", "/api/choice", { id: "setup:777", decision: "cancel" })).status, 200);

    const retry = studioWith(port, 777, "NewGame", { session: "s1", setup: true });
    await waitFor(() => retry.received.some((m) => m.type === "daemonDisconnect"));
    assert.ok(retry.received.some((m) => m.type === "error" && /is not registered/.test(m.message)));
    assert.deepEqual((await call(port, "GET", "/api/state")).json.pending, []);

    const again = studioWith(port, 777, "NewGame", { session: "s1", explicit: true, setup: true });
    await waitFor(() => again.received.some((m) => m.type === "daemonDisconnect"));
    assert.equal((await call(port, "GET", "/api/state")).json.pending.length, 1);
    for (const s of [asking, retry, again]) s.ws.terminate();
  });
});

test("the AI merge in the app: off with nothing here, on by itself with one, a choice with both", { timeout: 30000 }, async () => {
  const machine = { claude: false, codex: false };
  const detectAi = async () => ({
    claude: { installed: machine.claude, loggedIn: machine.claude },
    codex: { installed: machine.codex, loggedIn: machine.codex },
  });
  await withHub({}, async ({ port, tmp }) => {
    const file = path.join(tmp, "config.json");
    fs.writeFileSync(file, JSON.stringify({ port: 3825, merge: { enabled: true, ai: true, model: "sonnet" } }));
    const get = async () => (await (await fetch(`http://127.0.0.1:${port}/api/ai?refresh=1`)).json()) as any;
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/ai`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    // Nothing installed: no AI, and it cannot be turned on or pointed at a CLI that is not here
    assert.deepEqual((await get()).effective, { state: "none", provider: null });
    assert.equal((await post({ ai: true })).status, 409);
    assert.equal((await post({ provider: "codex" })).status, 409);

    // Only Codex: used without asking
    machine.codex = true;
    assert.deepEqual((await get()).effective, { state: "ready", provider: "codex" });

    // Both: the app asks, and /api/state carries it for the banner
    machine.claude = true;
    assert.deepEqual((await get()).effective, { state: "choose", provider: null });
    assert.equal(((await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as any).ai.state, "choose");
    const chosen = (await (await post({ provider: "claude" })).json()) as any;
    assert.deepEqual(chosen.effective, { state: "ready", provider: "claude" });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).merge.provider, "claude");
    // Switching later, and turning it off; the rest of the file stays
    await post({ provider: "codex" });
    const off = (await (await post({ ai: false })).json()) as any;
    assert.deepEqual(off.effective, { state: "off", provider: null });
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.port, 3825);
    assert.equal(saved.merge.provider, "codex");
    assert.equal(saved.merge.ai, false);
    assert.equal((await post({ provider: "gpt" })).status, 400);
  }, { detectAi });
});
