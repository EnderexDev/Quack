import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { IPCServer } from "../ipc/server.js";
import { StudioTools } from "../studioTools.js";
import { encodePng, halve } from "../util/png.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "package.json"), "utf8")).version;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(20);
  }
}

/** A daemon's IPC server with its Studio tools, as index.ts wires them */
async function daemon() {
  const httpServer: Server = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as { port: number }).port;
  const ipc = new IPCServer(undefined, httpServer, { requestSnapshotOnConnect: false });
  const shots = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shots-"));
  const tools = StudioTools.attach(ipc, shots);
  const printed: string[] = [];
  ipc.onMessage((message) => {
    if (message.type === "studioOutput") printed.push(message.message);
  });
  return {
    url: `ws://127.0.0.1:${port}`,
    ipc,
    tools,
    shots,
    printed,
    close: async () => {
      await ipc.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(shots, { recursive: true, force: true });
    },
  };
}

type Handler = (tool: string, args: any) => unknown;

/** A peer that answers toolRequests with `handler` (a thrown error becomes ok: false) */
function answer(ws: WebSocket, handler: Handler, seen?: any[]) {
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "toolRequest") return;
    seen?.push(message);
    Promise.resolve()
      .then(() => handler(message.tool, message.args))
      .then(
        (result) => ws.send(JSON.stringify({ type: "toolResult", id: message.id, ok: true, result })),
        (error) => ws.send(JSON.stringify({ type: "toolResult", id: message.id, ok: false, error: (error as Error).message })),
      );
  });
}

async function editStudio(url: string, handler: Handler, seen?: any[]): Promise<WebSocket> {
  const ws = new WebSocket(url);
  answer(ws, handler, seen);
  await new Promise<void>((resolve) => ws.once("open", () => resolve()));
  ws.send(JSON.stringify({ type: "handshakeStudio", version, placeId: 1 }));
  await new Promise<void>((resolve) => ws.on("message", (raw) => JSON.parse(raw.toString()).type === "handshakeAck" && resolve()));
  return ws;
}

/** A play peer's /studio-output socket; `hello` false is a plugin from before the tools */
async function playPeer(url: string, source: "server" | "client", handler: Handler, options: { hello?: boolean; log?: boolean } = {}): Promise<WebSocket> {
  const ws = new WebSocket(`${url}/studio-output`);
  answer(ws, handler);
  await new Promise<void>((resolve) => ws.once("open", () => resolve()));
  if (options.hello !== false) ws.send(JSON.stringify({ type: "peerHello", source, log: options.log === true }));
  return ws;
}

const output = (source: "server" | "client", message: string, messageType = "MessageOutput") =>
  JSON.stringify({ type: "studioOutput", message, messageType, source, timestamp: Date.now() });

test("an eval goes to the play peer it names and its answer comes back; each missing peer says why", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    await assert.rejects(d.tools.call("eval", { code: "return 1" }), /Studio is not connected to this place/);
    const edit = await editStudio(d.url, () => ({}));
    await assert.rejects(d.tools.call("eval", { code: "return 1" }), /no play is running in this place/);

    const server = await playPeer(d.url, "server", (tool, args) => ({ ok: true, values: [`server ran ${tool}: ${args.code}`], output: ["printed"] }));
    await waitFor(() => d.ipc.playPeers().server === "ready");
    const result: any = await d.tools.call("eval", { code: "return 1" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.values, ["server ran eval: return 1"]);
    assert.deepEqual(result.output, ["printed"]);
    assert.equal(result.peer, "server");
    await assert.rejects(d.tools.call("eval", { code: "return 1", peer: "client" }), /the play client is not connected: a Run-mode play has no client/);
    // A Run-mode play: nothing can capture its view, and keys would go nowhere (measured in PA)
    await assert.rejects(d.tools.call("screenshot", {}), /a screenshot needs a Play-mode play/);
    await assert.rejects(d.tools.call("key", { keyCode: "W" }), /the play client is not connected/);

    const client = await playPeer(d.url, "client", () => ({ ok: true, values: ["client"], output: [] }));
    await waitFor(() => d.ipc.playPeers().client === "ready");
    assert.deepEqual(((await d.tools.call("eval", { code: "x", peer: "client" })) as any).values, ["client"]);
    await assert.rejects(d.tools.call("eval", { code: "  " }), /code is required/);

    for (const ws of [server, client, edit]) ws.close();
  } finally {
    await d.close();
  }
});

test("a play socket that never says hello is an older plugin, and a peer leaving fails its call at once", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const edit = await editStudio(d.url, () => ({}));
    const old = await playPeer(d.url, "server", () => ({}), { hello: false });
    await waitFor(() => d.ipc.playSockets() === 1);
    await assert.rejects(d.tools.call("eval", { code: "return 1" }), /answers no tools \(it is older than these tools\)/);
    old.close();

    // A server that never answers, then goes away: the call fails when it leaves, not at its timeout
    const silent = await playPeer(d.url, "server", () => new Promise(() => {}));
    await waitFor(() => d.ipc.playPeers().server === "ready");
    const started = Date.now();
    const call = d.tools.call("eval", { code: "while true do task.wait() end", timeoutMs: 15000 });
    await wait(100);
    silent.close();
    await assert.rejects(call, /the play stopped before the play server answered/);
    assert.ok(Date.now() - started < 5000);

    // One that answers nothing at all times out with the reason
    const deaf = await playPeer(d.url, "server", () => new Promise(() => {}));
    await waitFor(() => d.ipc.playPeers().server === "ready");
    await assert.rejects(d.tools.call("eval", { code: "x", timeoutMs: 300 }), /the play server did not answer in 0 s \(the code may still be running there\)/);
    deaf.close();
    edit.close();
  } finally {
    await d.close();
  }
});

test("the play's output is kept for logs with a cursor even when the daemon log does not show it", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const edit = await editStudio(d.url, () => ({}));
    const server = await playPeer(d.url, "server", () => ({}), { log: false });
    const client = await playPeer(d.url, "client", () => ({}), { log: true });
    await waitFor(() => d.ipc.playPeers().client === "ready" && d.ipc.playPeers().server === "ready");
    server.send(output("server", "boot"));
    client.send(output("client", "hello from client", "MessageWarning"));
    server.send(output("server", "[Roblox][CorePackages.Foo] noise"));
    // The plugin's compile check of an eval logs the error the caller already got back
    server.send(output("server", "__QuackEval:2: Expected identifier when parsing expression, got 'local'", "MessageError"));
    await waitFor(() => (d.tools.logs({}) as any).entries.length === 3);
    await wait(100);

    const first: any = d.tools.logs({});
    assert.deepEqual(first.entries.map((e: any) => e.message), ["--- play started ---", "boot", "hello from client"]);
    assert.deepEqual(d.printed, ["hello from client"], "only the peer whose hello asked for it reaches the daemon log");

    server.send(output("server", "later"));
    await waitFor(() => (d.tools.logs({ cursor: first.cursor }) as any).entries.length === 1);
    const next: any = d.tools.logs({ cursor: first.cursor });
    assert.equal(next.entries[0].message, "later");
    assert.equal((d.tools.logs({ cursor: next.cursor }) as any).entries.length, 0, "nothing new after the last cursor");
    assert.deepEqual((d.tools.logs({ peer: "client" }) as any).entries.map((e: any) => e.message), ["--- play started ---", "hello from client"]);
    assert.deepEqual((d.tools.logs({ filter: "lat" }) as any).entries.map((e: any) => e.message), ["later"]);
    assert.deepEqual((d.tools.logs({ tail: 1 }) as any).entries.map((e: any) => e.message), ["later"]);
    assert.throws(() => d.tools.logs({ cursor: "abc" }), /cursor must be the number/);

    server.close();
    client.close();
    await waitFor(() => d.ipc.playSockets() === 0);
    const after: any = d.tools.logs({ cursor: next.cursor });
    assert.deepEqual(after.entries.map((e: any) => e.message), ["--- play stopped ---"], "the cursor survives the play");
    edit.close();
  } finally {
    await d.close();
  }
});

test("playtest start returns once the play's peers said hello; stop once they left and edit mode is back", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    let editMode = true;
    const peers: WebSocket[] = [];
    const startPeers = async () => {
      peers.push(await playPeer(d.url, "server", (tool) => {
        if (tool !== "stop") return {};
        // EndTest: the peers go, edit mode comes back a moment later
        setTimeout(() => peers.splice(0).forEach((p) => p.close()), 50);
        setTimeout(() => (editMode = true), 200);
        return { stopping: true };
      }));
      peers.push(await playPeer(d.url, "client", () => ({})));
    };
    const edit = await editStudio(d.url, (tool) => {
      if (tool === "playState") return { editModeActive: editMode };
      if (tool === "playStart") {
        if (!editMode) throw new Error("a play is already running: stop it first");
        editMode = false;
        setTimeout(() => void startPeers(), 150);
        return { mode: "play" };
      }
      throw new Error(`unexpected ${tool}`);
    });

    await assert.rejects(d.tools.call("playtest", { action: "stop" }), /no play is running in this place/);
    const started: any = await d.tools.call("playtest", { action: "start" });
    assert.equal(started.server, "ready");
    assert.equal(started.client, "ready");
    assert.ok(started.ms >= 100, "it waited for the peers");
    assert.equal(((await d.tools.call("playtest", { action: "status" })) as any).playing, true);
    await assert.rejects(d.tools.call("playtest", { action: "start" }), /a play is already running/);

    const stopped: any = await d.tools.call("playtest", { action: "stop" });
    assert.equal(editMode, true, "stop returned only once Studio was back in edit mode");
    assert.ok(stopped.ms >= 150);
    assert.equal(d.ipc.playSockets(), 0);

    // A play whose server has no Quack plugin answering: stop says so instead of waiting
    editMode = false;
    await assert.rejects(d.tools.call("playtest", { action: "stop" }), /a play is running, but its server has no Quack plugin that answers tools/);
    edit.close();
  } finally {
    await d.close();
  }
});

test("a screenshot: the play client captures, edit mode reads the pixels, the PNG is saved", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const rgba = Buffer.alloc(4 * 3 * 4);
    for (let i = 0; i < 12; i++) rgba.set([i * 20, 255 - i * 20, i, 255], i * 4);
    const seen: any[] = [];
    const edit = await editStudio(d.url, (tool, args) => {
      if (tool === "captureRead") return { width: 4, height: 3, data: rgba.toString("base64"), contentId: args.contentId };
      if (tool === "capture") return { width: 4, height: 3, data: rgba.toString("base64") };
      throw new Error(tool);
    }, seen);

    // No play: edit mode captures and reads by itself
    const own: any = await d.tools.call("screenshot", {});
    assert.equal(own.peer, "edit");
    assert.deepEqual(seen.map((m) => m.tool), ["capture"]);

    const client = await playPeer(d.url, "client", (tool) => {
      if (tool === "captureBegin") return { contentId: "rbxtemp://7" };
      throw new Error("the Studio window is minimized or not drawing (no frame for 4.0 s)");
    });
    await waitFor(() => d.ipc.playPeers().client === "ready");
    const shot: any = await d.tools.call("screenshot", {});
    assert.equal(shot.peer, "client");
    assert.equal(seen.at(-1).tool, "captureRead");
    assert.equal(seen.at(-1).args.contentId, "rbxtemp://7");
    assert.equal(shot.width, 4);
    assert.equal(shot.height, 3);
    const png = fs.readFileSync(shot.file);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(path.dirname(shot.file), d.shots);
    // The pixels survive: inflate the IDAT and undo the Up filter
    const idat = png.subarray(png.indexOf("IDAT") + 4, png.indexOf("IEND") - 8);
    const raw = zlib.inflateSync(idat);
    const rows: number[][] = [];
    for (let y = 0; y < 3; y++) {
      const line = [...raw.subarray(y * 13 + 1, y * 13 + 13)].map((v, i) => (v + (y ? rows[y - 1][i] : 0)) & 0xff);
      rows.push(line);
    }
    const expected = [...rgba].filter((_, i) => i % 4 !== 3);
    assert.deepEqual(rows.flat(), expected);

    // A key while minimized: Studio's own reason comes back
    await assert.rejects(d.tools.call("key", { keyCode: "W" }), /minimized or not drawing/);
    client.close();
    edit.close();
  } finally {
    await d.close();
  }
});

test("keys go to the play client when there is one, else edit mode; bad input is refused before Studio", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const editSeen: any[] = [];
    const edit = await editStudio(d.url, (_tool, args) => ({ keyCode: args.keyCode }), editSeen);
    assert.equal(((await d.tools.call("key", { keyCode: "W" })) as any).peer, "edit");
    const client = await playPeer(d.url, "client", (_tool, args) => ({ keyCode: args.keyCode, action: args.action }));
    await waitFor(() => d.ipc.playPeers().client === "ready");
    const sent: any = await d.tools.call("key", { keyCode: "Space", action: "press" });
    assert.equal(sent.peer, "client");
    assert.equal(sent.action, "press");
    await assert.rejects(d.tools.call("key", {}), /name a key/);
    await assert.rejects(d.tools.call("key", { keyCode: "W", text: "x" }), /either a key or text/);
    await assert.rejects(d.tools.call("key", { keyCode: "W", action: "hold" }), /action must be tap, press or release/);
    await assert.rejects(d.tools.call("device", { resolution: { width: 0, height: 10 } }), /resolution must be/);
    await assert.rejects(d.tools.call("device", { stop: true, deviceId: "x" }), /takes no other setting/);
    assert.equal(editSeen.length, 1, "the refused ones never reached Studio");
    client.close();
    edit.close();
  } finally {
    await d.close();
  }
});

test("png: halve averages each 2x2 block, and the encoder refuses a wrong-sized buffer", () => {
  const four = Buffer.from([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 100, 100, 100, 255]);
  const half = halve(four, 2, 2);
  assert.equal(half.width, 1);
  assert.deepEqual([...half.rgba], [100, 100, 100, 255]);
  assert.throws(() => encodePng(Buffer.alloc(3), 1, 1), /expected 4 bytes/);
});
