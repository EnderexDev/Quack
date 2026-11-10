import test from "node:test";
import { numbersOnly } from "../util/luauNumbers.js";
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
import { encodeGif, lzw } from "../util/gif.js";
import { encodePng, halve, sheet } from "../util/png.js";
import { readRoblox } from "../util/rbxl.js";
import { buildRoblox, chunk as rbxChunk, samplePlace } from "./rbxlFixture.js";

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
async function daemon(options: { preludeDir?: string } = {}) {
  const httpServer: Server = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as { port: number }).port;
  const ipc = new IPCServer(undefined, httpServer, { requestSnapshotOnConnect: false });
  const shots = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shots-"));
  const recordings = path.join(shots, "recordings");
  const tools = StudioTools.attach(ipc, shots, recordings, options.preludeDir);
  const printed: string[] = [];
  ipc.onMessage((message) => {
    if (message.type === "studioOutput") printed.push(message.message);
  });
  return {
    url: `ws://127.0.0.1:${port}`,
    ipc,
    tools,
    shots,
    recordings,
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

// 08/11/26, Anime Astral right after the 1.0.11 install, its Studio not reopened: exec waited
// 30 s and said "the code may still be running there"; the plugin simply knew no tools
test("an exec that times out names the cause: an edit-mode plugin that never answered is older than the tools, one that did is busy", { timeout: 30000 }, async () => {
  const d = await daemon();
  try {
    const seen: any[] = [];
    const old = new WebSocket(d.url);
    old.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "toolRequest") seen.push(message.tool); // an older plugin: never answers
    });
    await new Promise<void>((resolve) => old.once("open", () => resolve()));
    old.send(JSON.stringify({ type: "handshakeStudio", version, placeId: 1 }));
    await new Promise<void>((resolve) => old.on("message", (raw) => JSON.parse(raw.toString()).type === "handshakeAck" && resolve()));
    // Shorter than the probe: it is still on its way, so nothing is blamed yet; two calls share one probe
    const short = [d.tools.call("exec", { code: "return 1", timeoutMs: 1000 }), d.tools.call("exec", { code: "return 1", timeoutMs: 1000 })];
    for (const call of short) await assert.rejects(call, /did not answer in 1 s \(the code may still be running there\)/);
    assert.equal(seen.filter((t) => t === "playState").length, 1, "one probe for both");
    // Longer than the probe: its silence is the old plugin's
    await assert.rejects(d.tools.call("exec", { code: "return 1", timeoutMs: 6000 }), /has answered no tool call since it connected: most likely its Quack plugin is older than these tools/);
    assert.ok(seen.includes("exec"), "the code goes along with the probe: nothing waits on it");
    // Its probe timed out unanswered: a short exec now names the old plugin, and no new probe goes out
    const probes = seen.filter((t) => t === "playState").length;
    await assert.rejects(d.tools.call("exec", { code: "return 1", timeoutMs: 1000 }), /most likely its Quack plugin is older than these tools/);
    assert.equal(seen.filter((t) => t === "playState").length, probes, "not probed again on the same connection");
    old.close();

    // A current plugin that answers the probe only after the probe's 5 s: its late answer counts
    let late = true;
    const lagging = await editStudio(d.url, async (tool) => {
      if (late) await wait(tool === "playState" ? 5500 : 7000);
      return { ok: true, values: [], output: [] };
    });
    await assert.rejects(d.tools.call("exec", { code: "return 1", timeoutMs: 6500 }), /\(the code may still be running there\)/);
    late = false;
    lagging.close();

    // A plugin that knows the tools, even one answering the probe with an error, runs the code;
    // probed only while it has not answered on this connection
    const tools: string[] = [];
    let slow = false;
    const edit = await editStudio(d.url, async (tool) => {
      tools.push(tool);
      if (tool === "playState") throw new Error("busy");
      if (slow) await wait(3000);
      return { ok: true, values: ["1"], output: [] };
    });
    assert.deepEqual(((await d.tools.call("exec", { code: "return 1" })) as any).values, ["1"]);
    await d.tools.call("exec", { code: "return 2" });
    assert.deepEqual(tools.filter((t) => t === "playState").length, 1);
    // The same plugin, now slow: its timeout is the code's, not an old plugin
    slow = true;
    await assert.rejects(d.tools.call("exec", { code: "return 3", timeoutMs: 1000 }), /did not answer in 1 s \(the code may still be running there\)/);
    edit.close();
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

// chrrxs's get_request_status (3 calls in a month): a timeout ends the wait, not the code. Its
// answer was dropped, so the only way to learn what an exec did was to send it again
test("a call that timed out keeps its id: get_request_status says pending, then the answer that came later, or lost when the play left", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    await assert.rejects(d.tools.call("requestStatus", { id: "nope" }), /id must be the request id a timeout named/);
    const unknown: any = await d.tools.call("requestStatus", { id: "0123456789ab" });
    assert.equal(unknown.state, "unknown");
    assert.match(unknown.note, /cannot say whether it ran/);

    // An edit call that takes longer than its wait: the timeout names its id
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const edit = await editStudio(d.url, async (tool) => {
      if (tool === "exec") await gate;
      return { ok: true, values: ["42"], output: ["done"] };
    });
    const error = await d.tools.call("exec", { code: "return 42", timeoutMs: 400 }).then(() => undefined, (e: Error) => e);
    assert.ok(error);
    const id = /Request ([0-9a-f]{12}): get_request_status/.exec(error.message)?.[1];
    assert.ok(id, error.message);
    const pending: any = await d.tools.call("requestStatus", { id });
    assert.equal(pending.state, "pending");
    assert.equal(pending.tool, "exec");
    assert.equal(pending.peer, "edit");
    release();
    await waitFor(() => (d.tools as any).late.get(id)?.state === "answered");
    const answered: any = await d.tools.call("requestStatus", { id });
    assert.equal(answered.state, "answered");
    assert.deepEqual(answered.result.values, ["42"]);
    assert.deepEqual(answered.result.output, ["done"]);
    assert.ok(answered.answeredAfterTimeoutMs >= 0);

    // A late error is kept as the error
    const failing = new Promise<void>((r) => setTimeout(r, 600));
    edit.removeAllListeners("message");
    answer(edit, async () => {
      await failing;
      throw new Error("attempt to index nil");
    });
    const second = await d.tools.call("exec", { code: "x.y = 1", timeoutMs: 300 }).then(() => undefined, (e: Error) => e);
    const id2 = /Request ([0-9a-f]{12})/.exec(second!.message)![1];
    await waitFor(() => (d.tools as any).late.get(id2)?.state === "failed");
    assert.match(((await d.tools.call("requestStatus", { id: id2 })) as any).error, /attempt to index nil/);

    // A play peer that leaves before answering: lost, never pending forever
    const server = await playPeer(d.url, "server", () => new Promise(() => {}));
    await waitFor(() => d.ipc.playPeers().server === "ready");
    // wait_for's tries that time out keep no id: a long wait would push real calls out of the 50
    const before = (d.tools as any).late.size;
    await d.tools.call("waitFor", { code: "workspace.Never", timeoutMs: 700, tryTimeoutMs: 200, intervalMs: 50 }).catch(() => undefined);
    assert.equal((d.tools as any).late.size, before, "no try of wait_for is kept");
    // A try cut by the deadline says the time it had, not its own limit
    const cut: any = await d.tools.call("waitFor", { code: "workspace.Never", timeoutMs: 400, tryTimeoutMs: 5000 }).catch((e: Error) => ({ thrown: e.message }));
    assert.match(JSON.stringify(cut), /the try did not answer in [1-4]\d\d ms/, JSON.stringify(cut));
    const third = await d.tools.call("eval", { code: "while true do end", timeoutMs: 300 }).then(() => undefined, (e: Error) => e);
    const id3 = /Request ([0-9a-f]{12})/.exec(third!.message)![1];
    server.close();
    await waitFor(() => (d.tools as any).late.get(id3)?.state === "lost");
    assert.match(((await d.tools.call("requestStatus", { id: id3 })) as any).error, /the play stopped before the play server answered/);
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

test("click: the play client gets the button's path and the method, refusals name the cause before Studio, and the answer says how it clicked", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const edit = await editStudio(d.url, () => ({}));
    await assert.rejects(d.tools.call("click", { path: "PlayerGui.Shop.Buy" }), /no play is running in this place/);
    const server = await playPeer(d.url, "server", () => ({}));
    await waitFor(() => d.ipc.playPeers().server === "ready");
    // A Run-mode play has no client to click in
    await assert.rejects(d.tools.call("click", { path: "PlayerGui.Shop.Buy" }), /the play client is not connected/);
    const seen: any[] = [];
    const client = await playPeer(d.url, "client", (tool, args) => {
      seen.push({ tool, args });
      if (args.path.endsWith("Hidden")) throw new Error("Players.Ender.PlayerGui.Shop.Hidden: it is hidden (Visible = false)");
      return { path: `Players.Ender.${args.path}`, method: "input", x: 690, y: 454, screen: { width: 1380, height: 850 }, activated: true, mouseButton1Click: true, ms: 70 };
    });
    await waitFor(() => d.ipc.playPeers().client === "ready");
    const clicked: any = await d.tools.call("click", { path: " PlayerGui.Shop.Buy " });
    assert.deepEqual(seen.at(-1), { tool: "click", args: { path: "PlayerGui.Shop.Buy", method: "auto" } });
    assert.equal(clicked.peer, "client");
    assert.equal(clicked.method, "input");
    assert.equal(clicked.activated, true);
    assert.equal(clicked.x, 690);
    assert.ok(typeof clicked.ms === "number");
    await d.tools.call("click", { path: "PlayerGui.Shop.Buy", method: "select" });
    assert.equal(seen.at(-1).args.method, "select");
    await assert.rejects(d.tools.call("click", { path: "PlayerGui.Shop.Hidden" }), /it is hidden \(Visible = false\)/);
    await assert.rejects(d.tools.call("click", {}), /path is required/);
    await assert.rejects(d.tools.call("click", { path: "x", method: "tap" }), /method must be auto, input or select/);
    assert.equal(seen.length, 3, "the refused ones never reached Studio");
    for (const ws of [client, server, edit]) ws.close();
  } finally {
    await d.close();
  }
});

test("wait_for: code is retried until it turns truthy, errors count as not yet, the deadline answers the last try", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const edit = await editStudio(d.url, () => ({}));
    let calls = 0;
    const codes: string[] = [];
    const server = await playPeer(d.url, "server", (_tool, args) => {
      codes.push(args.code);
      calls++;
      if (args.code.includes("return false")) return { ok: true, values: ["false", "nil"], output: [] };
      if (calls === 1) return { ok: false, error: "eval:1: attempt to index nil with 'Health'", output: [] };
      if (calls < 4) return { ok: true, values: ["false", "nil"], output: [] };
      return { ok: true, values: ["true", "Boss (Model)", "3"], output: ["printed"] };
    });
    await waitFor(() => d.ipc.playPeers().server === "ready");
    const met: any = await d.tools.call("waitFor", { code: "workspace:FindFirstChild('Boss')", intervalMs: 50 });
    assert.equal(met.met, true);
    assert.equal(met.by, "code");
    assert.equal(met.tries, 4);
    assert.deepEqual(met.values, ["Boss (Model)", "3"], "the truthiness flag is not one of the values");
    assert.deepEqual(met.output, ["printed"]);
    // An expression gets a return; the code's first line stays line 1
    assert.match(codes[0], /^local __quack_w = table\.pack\(\(function\(\) return workspace:FindFirstChild\('Boss'\)\nend\)\(\)\)/);
    assert.equal(StudioTools.truthyCode("local b = workspace.Boss\nreturn b").split("\n")[1], "return b", "code that returns is left as it is");

    // Never truthy: the deadline answers with the last value
    const started = Date.now();
    const missed: any = await d.tools.call("waitFor", { code: "false", intervalMs: 50, timeoutMs: 400 });
    assert.equal(missed.met, false);
    assert.ok(Date.now() - started >= 380 && Date.now() - started < 2000);
    assert.ok(missed.tries >= 2);
    assert.deepEqual(missed.last.values, ["nil"]);
    await assert.rejects(d.tools.call("waitFor", {}), /give code \(Luau that turns truthy\), a pattern/);
    await assert.rejects(d.tools.call("waitFor", { pattern: "(" }), /pattern is not a regular expression/);
    await assert.rejects(d.tools.call("waitFor", { code: "x", peer: "client" }), /the play client is not connected/);

    // The play stops mid-wait: it ends then, not at the deadline
    server.close();
    await waitFor(() => d.ipc.playSockets() === 0);
    const silent = await playPeer(d.url, "server", () => new Promise(() => {}));
    await waitFor(() => d.ipc.playPeers().server === "ready");
    const waiting = d.tools.call("waitFor", { code: "x", timeoutMs: 15000, tryTimeoutMs: 10000 });
    await wait(200);
    const stopped = Date.now();
    silent.close();
    await assert.rejects(waiting, /the play stopped before the play server answered \(after 1 tries/);
    assert.ok(Date.now() - stopped < 3000);
    edit.close();
  } finally {
    await d.close();
  }
});

test("wait_for: a pattern wakes on the output line itself, and a cursor reaches lines from before the call", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const edit = await editStudio(d.url, () => ({}));
    const server = await playPeer(d.url, "server", () => ({ ok: true, values: ["false"], output: [] }));
    await waitFor(() => d.ipc.playPeers().server === "ready");
    server.send(output("server", "Wave 1 started"));
    await waitFor(() => (d.tools.logs({}) as any).entries.some((e: any) => e.message === "Wave 1 started"));
    const before: any = d.tools.logs({ tail: 1 });
    const cursor = String(Number(before.cursor) - 1);

    // Only lines after the call: wave 1 is old news, wave 2 arrives later
    const started = Date.now();
    const waiting = d.tools.call("waitFor", { pattern: "^Wave \\d+ started$", timeoutMs: 10000 });
    setTimeout(() => server.send(output("server", "Wave 2 started")), 300);
    const met: any = await waiting;
    assert.equal(met.by, "pattern");
    assert.equal(met.line.message, "Wave 2 started");
    assert.equal(met.line.source, "server");
    assert.equal(met.tries, 0);
    assert.ok(Date.now() - started < 1500, "woken by the line, not a poll of the deadline");

    const old: any = await d.tools.call("waitFor", { pattern: "Wave 1", cursor, timeoutMs: 1000 });
    assert.equal(old.line.message, "Wave 1 started");

    // Code and pattern together: whichever comes first; the code keeps saying false
    const both = d.tools.call("waitFor", { code: "false", pattern: "Boss spawned", intervalMs: 50, timeoutMs: 10000 });
    setTimeout(() => server.send(output("server", "Boss spawned at 12, 0, 4")), 300);
    const first: any = await both;
    assert.equal(first.by, "pattern");
    assert.ok(first.tries >= 1);

    // A chatty play: lines that do not match wake the pattern check, never an extra eval
    const chatter = setInterval(() => server.send(output("server", "tick")), 20);
    try {
      const busy: any = await d.tools.call("waitFor", { code: "false", pattern: "never printed", intervalMs: 500, timeoutMs: 1300 });
      assert.equal(busy.met, false);
      assert.ok(busy.tries <= 4, `one eval per interval, not one per line (${busy.tries} tries)`);
    } finally {
      clearInterval(chatter);
    }
    server.close();
    edit.close();
  } finally {
    await d.close();
  }
});

/** Each GIF frame starts with a Graphic Control Extension */
function gifFrames(gif: Buffer): number {
  let n = 0;
  for (let i = gif.indexOf(Buffer.from([0x21, 0xf9, 0x04])); i >= 0; i = gif.indexOf(Buffer.from([0x21, 0xf9, 0x04]), i + 1)) n++;
  return n;
}

test("record: the client captures a burst, edit mode reads each frame scaled, the GIF and its contact sheet are saved and the last 10 kept", { timeout: 30000 }, async () => {
  const d = await daemon();
  try {
    const W = 8;
    const H = 6;
    const frameOf = (n: number) => {
      const rgba = Buffer.alloc(W * H * 4, 255);
      rgba.set([n * 40, 0, 255 - n * 40, 255], (n % (W * H)) * 4);
      return rgba;
    };
    const reads: any[] = [];
    const edit = await editStudio(d.url, (tool, args) => {
      if (tool !== "captureRead") throw new Error(tool);
      reads.push(args);
      if (args.contentId === "rbxtemp://bad") throw new Error("could not open the screenshot as an EditableImage");
      const n = Number(args.contentId.split("/").pop());
      return { width: W, height: H, nativeWidth: 1725, nativeHeight: 1063, data: frameOf(n).toString("base64") };
    });
    const server = await playPeer(d.url, "server", () => ({}));
    await waitFor(() => d.ipc.playPeers().server === "ready");
    await assert.rejects(d.tools.call("record", {}), /a recording needs a Play-mode play/);
    let burstArgs: any;
    const client = await playPeer(d.url, "client", (tool, args) => {
      if (tool !== "captureBurst") throw new Error(tool);
      burstArgs = args;
      const frames = Array.from({ length: 6 }, (_, i) => ({ at: i * 200, contentId: `rbxtemp://${i}` }));
      frames.splice(3, 0, { at: 500, contentId: "rbxtemp://bad" });
      return { frames, asked: 7, seconds: 1.01, gameFps: 41.3 };
    });
    await waitFor(() => d.ipc.playPeers().client === "ready");
    // Ten older recordings, one with its sheet
    fs.mkdirSync(d.recordings, { recursive: true });
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(d.recordings, `rec-2000-01-0${i}.gif`), "old");
    fs.writeFileSync(path.join(d.recordings, "rec-2000-01-00-sheet.png"), "old");

    const rec: any = await d.tools.call("record", { seconds: 1, fps: 5, width: 320 });
    assert.deepEqual(burstArgs, { seconds: 1, fps: 5 });
    assert.ok(reads.every((r) => r.maxWidth === 320));
    assert.equal(rec.peer, "client");
    assert.equal(rec.frames, 6);
    assert.equal(rec.skipped, 1, "a frame that cannot be read is left out, the rest still make the GIF");
    assert.equal(rec.fps, 5, "5 frames between 0 and 1000 ms");
    assert.equal(rec.gameFps, 41.3);
    assert.equal(rec.width, W);
    assert.equal(rec.nativeWidth, 1725);
    const gif = fs.readFileSync(rec.file);
    assert.equal(gif.subarray(0, 6).toString(), "GIF89a");
    assert.equal(gifFrames(gif), 6);
    assert.equal(rec.bytes, gif.length);
    // The first frame's delay is the time to the next one: 200 ms
    const gce = gif.indexOf(Buffer.from([0x21, 0xf9, 0x04]));
    assert.equal(gif.readUInt16LE(gce + 4), 20);
    const png = fs.readFileSync(rec.sheet);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), 4 * W + 3 * 4, "four frames to a row, 4 px apart");
    assert.equal(png.readUInt32BE(20), 2 * H + 4);
    assert.deepEqual(rec.sheetAt, [0, 200, 400, 600, 800, 1000]);
    const left = fs.readdirSync(d.recordings).sort();
    assert.equal(left.filter((f) => f.endsWith(".gif")).length, 10);
    assert.ok(!left.includes("rec-2000-01-00.gif") && !left.includes("rec-2000-01-00-sheet.png"), "the oldest went, its sheet with it");
    await assert.rejects(d.tools.call("record", { seconds: 20 }), /seconds must be from 0.5 to 15/);
    await assert.rejects(d.tools.call("record", { fps: 30 }), /fps must be from 1 to 10/);
    for (const ws of [client, server, edit]) ws.close();
  } finally {
    await d.close();
  }
});

/** GIF's LZW, decoded as a viewer does: the codes widen when the table reaches the next power of two */
function unlzw(data: Buffer, minCodeSize = 8): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let size = minCodeSize + 1;
  let table: number[][] = [];
  const reset = () => {
    table = Array.from({ length: eoi + 1 }, (_, i) => [i]);
    size = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let bit = 0;
  let prev: number[] | undefined;
  for (;;) {
    let code = 0;
    for (let i = 0; i < size; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    if (code === clear) {
      reset();
      prev = undefined;
      continue;
    }
    if (code === eoi) break;
    const entry = code < table.length ? table[code] : [...prev!, prev![0]];
    if (prev) table.push([...prev, entry[0]]);
    out.push(...entry);
    prev = entry;
    if (table.length === 1 << size && size < 12) size++;
  }
  return out;
}

test("gif: LZW decodes back to the same indices across table resets, and frames of the wrong size are refused", () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  // Noisy enough to fill the 4096-entry table several times, with runs so codes chain
  const indices = new Uint8Array(60_000);
  for (let i = 0; i < indices.length; i++) indices[i] = random() < 0.3 ? indices[Math.max(0, i - 1)] : Math.floor(random() * 256);
  assert.deepEqual(unlzw(lzw(indices)), [...indices]);
  assert.deepEqual(unlzw(lzw(new Uint8Array([5]))), [5]);
  // A stream whose last code fills the table to a power of two: the decoder reads the end code
  // one bit wider, so the encoder must widen it too (council review, 08/11/26)
  const noise = new Uint8Array(2000);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(random() * 256);
  for (let n = 200; n <= 320; n++) assert.deepEqual(unlzw(lzw(noise.subarray(0, n))), [...noise.subarray(0, n)], `${n} indices`);
  const frame = { rgba: Buffer.alloc(4 * 4 * 4, 128), delayCs: 10 };
  const gif = encodeGif([frame, frame], 4, 4);
  assert.equal(gif.subarray(0, 6).toString(), "GIF89a");
  assert.equal(gif.at(-1), 0x3b);
  assert.throws(() => encodeGif([{ rgba: Buffer.alloc(3), delayCs: 10 }], 4, 4), /expected 64 bytes/);
  assert.throws(() => encodeGif([], 4, 4), /at least one frame/);
  assert.throws(() => encodeGif([{ rgba: Buffer.alloc(12), delayCs: 10 }], 1.5, 2), /a GIF cannot be 1.5x2/);
  // Huge dimensions with a small frame: refused before the encoder allocates anything
  assert.throws(() => encodeGif([{ rgba: Buffer.alloc(4), delayCs: 10 }], 65535, 65535), /frame 1: expected 17179345 ?\d* bytes|frame 1: expected \d+ bytes/);
  const nan = encodeGif([{ rgba: Buffer.alloc(4, 9), delayCs: Number.NaN }], 1, 1);
  const nanGce = nan.indexOf(Buffer.from([0x21, 0xf9, 0x04]));
  assert.equal(nan.readUInt16LE(nanGce + 4), 10, "a delay that is not a number becomes a tenth of a second");
  assert.throws(() => sheet([], 1, 1, 4), /at least one image/);
  const tiled = sheet([Buffer.alloc(4, 1), Buffer.alloc(4, 2), Buffer.alloc(4, 3)], 1, 1, 2, 1);
  assert.deepEqual([tiled.width, tiled.height], [3, 3]);
  assert.deepEqual([...tiled.rgba.subarray(0, 4)], [1, 1, 1, 1]);
  assert.deepEqual([...tiled.rgba.subarray(8, 12)], [2, 2, 2, 2]);
  assert.deepEqual([...tiled.rgba.subarray(24, 28)], [3, 3, 3, 3]);
});

test("gui: the play client reads PlayerGui, edit mode StarterGui; a PlayerGui path with no client says why; the text shows what is hidden and what is clickable", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const seen: any[] = [];
    const tree = (peer: string) => ({
      root: peer === "edit" ? "StarterGui" : "Players.Ender.PlayerGui",
      nodes: [
        { d: 0, n: "Shop", c: "ScreenGui" },
        { d: 1, n: "Main", c: "Frame", r: [100, 50, 400, 300], m: "UICorner,UIStroke" },
        { d: 2, n: "Buy", c: "TextButton", t: "Buy 100", r: [120, 300, 80, 30], btn: true },
        { d: 2, n: "Close", c: "ImageButton", img: "123", r: [480, 50, 20, 20], btn: "covered by Players.Ender.PlayerGui.Modal.Back" },
        { d: 2, n: "Guild", c: "Frame", r: [0, 0, 10, 10], off: "Visible = false", more: 42 },
      ],
      truncated: false,
      screen: peer === "edit" ? undefined : { width: 1380, height: 850 },
    });
    const edit = await editStudio(d.url, (tool, args) => {
      seen.push({ peer: "edit", tool, args });
      return tree("edit");
    });
    const fromEdit: any = await d.tools.call("gui", {});
    assert.equal(fromEdit.peer, "edit");
    await assert.rejects(d.tools.call("gui", { path: "PlayerGui.Shop" }), /no play is running/);
    await assert.rejects(d.tools.call("gui", { depth: 50 }), /depth must be a whole number from 0 to 20/);
    const client = await playPeer(d.url, "client", (tool, args) => {
      seen.push({ peer: "client", tool, args });
      return tree("client");
    });
    await waitFor(() => d.ipc.playPeers().client === "ready");
    const fromClient: any = await d.tools.call("gui", { path: "PlayerGui.Shop", depth: 2, hidden: true });
    assert.equal(fromClient.peer, "client");
    assert.deepEqual(seen.at(-1), { peer: "client", tool: "gui", args: { path: "PlayerGui.Shop", depth: 2, hidden: true } });
    const { guiText } = await import("../control/commands.js");
    const textOut = guiText(fromClient);
    assert.match(textOut, /^Players\.Ender\.PlayerGui \(the play client, screen 1380x850/);
    assert.match(textOut, /\n    Buy \[TextButton\]  "Buy 100"  at 120,300 80x30  clickable/);
    assert.match(textOut, /Close \[ImageButton\]  img 123  at 480,50 20x20  not clickable: covered by/);
    assert.match(textOut, /Guild \[Frame\]  at 0,0 10x10  hidden \(Visible = false\)  \+42 inside/);
    assert.match(textOut, /Main \[Frame\]  at 100,50 400x300  \{UICorner,UIStroke\}/);
    assert.equal(seen.length, 2, "the refused ones never reached Studio");
    client.close();
    edit.close();
  } finally {
    await d.close();
  }
});

test("mouse: a point on the last client screenshot is sent with that image's size, a cropped one is put back on the whole screen, and refusals come before Studio", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const rgba = Buffer.alloc(4 * 3 * 4, 255);
    const edit = await editStudio(d.url, (tool) => {
      if (tool === "captureRead") return { width: 4, height: 3, data: rgba.toString("base64") };
      throw new Error(tool);
    });
    const seen: any[] = [];
    const client = await playPeer(d.url, "client", (tool, args) => {
      if (tool === "captureBegin") return { contentId: "rbxtemp://1" };
      seen.push({ tool, args });
      return { x: 1, y: 1, gui: { x: 1, y: -57 }, screen: { width: 1380, height: 850 }, action: args.action, button: args.button };
    });
    await waitFor(() => d.ipc.playPeers().client === "ready");
    await assert.rejects(d.tools.call("mouse", { x: 1, y: 1 }), /no screenshot taken/);
    await d.tools.call("screenshot", {});
    await assert.rejects(d.tools.call("mouse", { x: 4, y: 1 }), /outside the last screenshot \(4x3\)/);
    await assert.rejects(d.tools.call("mouse", { x: 1, y: 1, action: "drag" }), /action must be click, double, down or up/);
    await assert.rejects(d.tools.call("mouse", { x: 1, y: 1, path: "PlayerGui.A" }), /a path or x and y, not both/);
    await d.tools.call("mouse", { x: 2, y: 1 });
    assert.deepEqual(seen.at(-1).args, { action: "click", button: "left", x: 2, y: 1, imageWidth: 4, imageHeight: 3 });
    await d.tools.call("mouse", { x: 300, y: 200, space: "screen", button: "right", action: "double" });
    assert.deepEqual(seen.at(-1).args, { action: "double", button: "right", x: 300, y: 200 });
    await d.tools.call("mouse", { path: "Workspace.Door" });
    assert.equal(seen.at(-1).args.path, "Workspace.Door");
    // A screenshot cropped to the right half: its x 1 is the whole screen's x 3 of 4
    (d.tools as any).lastShot = { width: 2, height: 3, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } };
    await d.tools.call("mouse", { x: 1, y: 2 });
    assert.deepEqual(seen.at(-1).args, { action: "click", button: "left", x: 3, y: 2, imageWidth: 4, imageHeight: 3 });
    assert.equal(seen.length, 4, "the refused ones never reached Studio");
    client.close();
    edit.close();
  } finally {
    await d.close();
  }
});

test("prelude: quack-prelude/<peer>.luau goes with every eval, exec and wait_for try of that peer, unless prelude is false", { timeout: 20000 }, async () => {
  const preludeDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-prelude-"));
  fs.writeFileSync(path.join(preludeDir, "server.luau"), "local player = game:GetService(\"Players\"):GetPlayers()[1]\r\n\r\n");
  fs.writeFileSync(path.join(preludeDir, "edit.luau"), "local sel = game:GetService(\"Selection\")\n");
  const d = await daemon({ preludeDir });
  try {
    const seen: any[] = [];
    const edit = await editStudio(d.url, (_tool, args) => {
      seen.push({ peer: "edit", args });
      return { ok: true, values: [], output: [] };
    });
    const server = await playPeer(d.url, "server", (_tool, args) => {
      seen.push({ peer: "server", args });
      return { ok: true, values: ["true"], output: [] };
    });
    const client = await playPeer(d.url, "client", (_tool, args) => {
      seen.push({ peer: "client", args });
      return { ok: true, values: [], output: [] };
    });
    await waitFor(() => d.ipc.playPeers().client === "ready" && d.ipc.playPeers().server === "ready");
    const evaluated: any = await d.tools.call("eval", { code: "return player.Name" });
    assert.equal(seen.at(-1).args.prelude, "local player = game:GetService(\"Players\"):GetPlayers()[1]", "CRLF and trailing blank lines dropped");
    assert.equal(evaluated.prelude, "quack-prelude/server.luau");
    await d.tools.call("eval", { code: "return 1", prelude: false });
    assert.equal(seen.at(-1).args.prelude, undefined);
    const fromClient: any = await d.tools.call("eval", { code: "return 1", peer: "client" });
    assert.equal(seen.at(-1).args.prelude, undefined, "no client.luau: nothing goes");
    assert.equal(fromClient.prelude, undefined);
    await d.tools.call("exec", { code: "return 1" });
    assert.equal(seen.at(-1).args.prelude, "local sel = game:GetService(\"Selection\")");
    await d.tools.call("waitFor", { code: "player" });
    assert.equal(seen.at(-1).peer, "server");
    assert.match(seen.at(-1).args.prelude, /GetPlayers/);
    for (const ws of [client, server, edit]) ws.close();
  } finally {
    await d.close();
    fs.rmSync(preludeDir, { recursive: true, force: true });
  }
});

test("new errors: each caller's next answer carries the play errors since its own previous call, grouped, with where they were thrown", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const edit = await editStudio(d.url, () => ({ ok: true, values: [], output: [] }));
    const server = await playPeer(d.url, "server", () => ({ ok: true, values: ["1"], output: [] }));
    await waitFor(() => d.ipc.playPeers().server === "ready");
    server.send(output("server", "ServerScriptService.Old:1: before the first call", "MessageError"));
    await waitFor(() => d.tools.logs({}).entries.some((e: any) => e.message.includes("before the first call")));
    // A caller's first call reads from the start of the play
    const first: any = await d.tools.call("eval", { code: "return 1", caller: "a" });
    assert.deepEqual(first.newErrors.map((e: any) => e.message), ["ServerScriptService.Old:1: before the first call"]);
    for (let i = 0; i < 3; i++) server.send(output("server", "ServerScriptService.Loop:5: attempt to index nil with 'X'", "MessageError"));
    server.send(output("server", "Stack Begin", "MessageInfo"));
    server.send(output("server", "Script 'ServerScriptService.Loop', Line 5", "MessageInfo"));
    server.send(output("server", "just a print"));
    server.send(output("server", "Players.Ender.PlayerScripts.Main:9: boom", "MessageError"));
    await waitFor(() => d.tools.logs({}).entries.some((e: any) => e.message.includes("boom")));
    const second: any = await d.tools.call("eval", { code: "return 1", caller: "a" });
    assert.deepEqual(second.newErrors, [
      { source: "server", message: "ServerScriptService.Loop:5: attempt to index nil with 'X'", count: 3 },
      { source: "server", message: "Players.Ender.PlayerScripts.Main:9: boom", count: 1 },
    ]);
    const third: any = await d.tools.call("eval", { code: "return 1", caller: "a" });
    assert.equal(third.newErrors, undefined, "seen once");
    // Another caller has its own cursor; reading the log moves it
    const other: any = await d.tools.call("logs", { caller: "b" });
    assert.equal(other.newErrors, undefined);
    assert.equal(((await d.tools.call("eval", { code: "return 1", caller: "b" })) as any).newErrors, undefined);
    server.send(output("server", "Workspace.Thing:1: once", "MessageError"));
    server.send(output("server", "Stack Begin", "MessageInfo"));
    server.send(output("server", "Script 'Workspace.Thing.Inner', Line 12", "MessageInfo"));
    await waitFor(() => d.tools.logs({}).entries.some((e: any) => e.message.includes("Inner")));
    const located: any = await d.tools.call("eval", { code: "return 1", caller: "b" });
    assert.deepEqual(located.newErrors, [{ source: "server", message: "Workspace.Thing:1: once", count: 1, at: "Workspace.Thing.Inner:12" }]);
    // An error already shown to this caller comes back only as a count (a game retrying every second)
    server.send(output("server", "Workspace.Thing:1: once", "MessageError"));
    server.send(output("server", "Workspace.Thing:1: once", "MessageError"));
    server.send(output("server", "Workspace.Other:2: fresh", "MessageError"));
    await waitFor(() => d.tools.logs({}).entries.some((e: any) => e.message.includes("fresh")));
    const again: any = await d.tools.call("eval", { code: "return 1", caller: "b" });
    assert.deepEqual(again.newErrors.map((e: any) => e.message), ["Workspace.Other:2: fresh"]);
    assert.equal(again.repeatedErrors, 2);
    server.send(output("server", "Workspace.Thing:1: once", "MessageError"));
    await waitFor(() => d.tools.logs({}).entries.filter((e: any) => e.message.includes(": once")).length === 4);
    const onlyRepeats: any = await d.tools.call("eval", { code: "return 1", caller: "b" });
    assert.equal(onlyRepeats.newErrors, undefined);
    assert.equal(onlyRepeats.repeatedErrors, 1);
    const { newErrorsText } = await import("../control/commands.js");
    assert.equal(newErrorsText([], 1), "The play logged 1 more of errors shown before since the last call.");
    assert.match(newErrorsText(again.newErrors, 2), /fresh\n  \(and 2 more of errors shown before\)$/);
    assert.equal(newErrorsText(second.newErrors), "New errors in the play since the last call (get_runtime_logs has the rest of each):\n  [server] ServerScriptService.Loop:5: attempt to index nil with 'X' (x3)\n  [server] Players.Ender.PlayerScripts.Main:9: boom");
    server.close();
    edit.close();
  } finally {
    await d.close();
  }
});

test("screenshot focus and width: a GUI focus comes back as a crop of the client capture, read at the size the crop needs; a part's focus goes to edit mode with no play", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    // A 4x2 capture: each pixel's red is its index
    const rgba = Buffer.alloc(4 * 2 * 4);
    for (let i = 0; i < 8; i++) rgba.set([i, 0, 0, 255], i * 4);
    const seen: any[] = [];
    const edit = await editStudio(d.url, (tool, args) => {
      seen.push({ tool, args });
      return { width: 4, height: 2, data: rgba.toString("base64") };
    });
    // No play: a part focus and the width go to edit's own capture; a GUI focus needs the client
    const own: any = await d.tools.call("screenshot", { focus: "Workspace.Tower", width: 800 });
    assert.deepEqual(seen.at(-1), { tool: "capture", args: { focus: "Workspace.Tower", maxWidth: 800 } });
    assert.equal(own.focus, "Workspace.Tower");
    await assert.rejects(d.tools.call("screenshot", { focus: "PlayerGui.Shop" }), /a GUI focus needs the play client/);
    await assert.rejects(d.tools.call("screenshot", { width: 10 }), /width must be a whole number from 64 to 4096/);
    const client = await playPeer(d.url, "client", (_tool, args) => ({ contentId: "rbxtemp://9", ...(args.focus ? { rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } } : {}) }));
    await waitFor(() => d.ipc.playPeers().client === "ready");
    const shot: any = await d.tools.call("screenshot", { focus: "PlayerGui.Shop", width: 100 });
    assert.deepEqual(seen.at(-1).args, { contentId: "rbxtemp://9", maxWidth: 200 }, "half the screen kept: read at twice the width");
    assert.equal(shot.width, 2);
    assert.equal(shot.height, 1);
    assert.deepEqual(shot.crop, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    const kept = StudioTools.crop({ rgba, width: 4, height: 2 }, shot.crop);
    assert.deepEqual([...kept.rgba].filter((_, i) => i % 4 === 0), [6, 7], "the bottom-right quarter");
    // The mouse reads x and y on this cropped shot
    assert.deepEqual((d.tools as any).lastShot, { width: 2, height: 1, crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } });
    client.close();
    edit.close();
  } finally {
    await d.close();
  }
});

test("verify: each mapped script's disk length and hash go to edit mode, and what differs comes back by file; find reads the synced tree with wildcards", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const { fnv1a } = await import("../studioTools.js");
    // The plugin's FNV-1a (h * 2^24 + h * 403 mod 2^32) is the same function
    const luauStyle = (text: string) => {
      let h = 2166136261;
      for (const byte of Buffer.from(text, "utf8")) {
        h = (h ^ byte) >>> 0;
        h = ((h * 2 ** 24) % 2 ** 32 + h * 403) % 2 ** 32;
      }
      return h;
    };
    for (const sample of ["", "print('olá')", "x".repeat(1000)]) assert.equal(fnv1a(sample), luauStyle(sample));
    d.tools.setPlace({
      scripts: () => [
        { guid: "g1", file: "ServerScriptService/Main.server.luau", text: "print(1)" },
        { guid: "g2", file: "ReplicatedStorage/Shop.luau", text: "return {}" },
        { guid: "g3", file: "ReplicatedStorage/Gone.luau", text: undefined },
      ],
      unmapped: () => ["ReplicatedStorage/New.luau"],
      nodes: () => [
        { guid: "a", name: "Workspace", className: "Workspace", path: ["Workspace"] },
        { guid: "b", name: "BossDoor", className: "Part", path: ["Workspace", "Map", "BossDoor"] },
        { guid: "c", name: "bossroom", className: "Model", path: ["Workspace", "Map", "bossroom"] },
        { guid: "g2", name: "Shop", className: "ModuleScript", path: ["ReplicatedStorage", "Shop"] },
      ],
      fileOf: (guid) => (guid === "g2" ? "ReplicatedStorage/Shop.luau" : undefined),
    });
    await assert.rejects(d.tools.call("verify", {}), /Studio is not connected/);
    const seen: any[] = [];
    const edit = await editStudio(d.url, (tool, args) => {
      seen.push({ tool, args });
      return { checked: args.items.length, differ: args.items.filter((i: any) => i.guid === "g2").map(() => ({ guid: "g2", path: "ReplicatedStorage.Shop", state: "tab", len: 9, tabLen: 20 })) };
    });
    const all: any = await d.tools.call("verify", {});
    assert.deepEqual(seen.at(-1).args.items, [
      { guid: "g1", len: 8, hash: fnv1a("print(1)") },
      { guid: "g2", len: 9, hash: fnv1a("return {}") },
    ]);
    assert.equal(all.same, 1);
    assert.deepEqual(all.differ, [{ file: "ReplicatedStorage/Shop.luau", path: "ReplicatedStorage.Shop", state: "tab", diskLen: 9, studioLen: 9, tabLen: 20 }]);
    assert.deepEqual(all.unmapped, ["ReplicatedStorage/New.luau"]);
    assert.deepEqual(all.unreadable, ["ReplicatedStorage/Gone.luau"]);
    const { verifyText } = await import("../control/commands.js");
    assert.match(verifyText(all), /ReplicatedStorage\/Shop\.luau: the \.Source matches, but an open tab in Studio holds other text/);
    assert.match(verifyText(all), /1 of 2 scripts match the disk; 3 do not/);
    const one: any = await d.tools.call("verify", { files: ["Main.server.luau"] });
    assert.deepEqual(seen.at(-1).args.items.map((i: any) => i.guid), ["g1"]);
    assert.deepEqual(one.unmapped, []);
    await assert.rejects(d.tools.call("verify", { files: ["Nope.luau"] }), /not a synced script file: Nope\.luau/);

    const bosses: any = await d.tools.call("find", { name: "boss*" });
    assert.deepEqual(bosses.found.map((f: any) => f.path), ["Workspace.Map.BossDoor", "Workspace.Map.bossroom"]);
    const parts: any = await d.tools.call("find", { className: "Part,Model", under: "Workspace.Map", limit: 1 });
    assert.equal(parts.total, 2);
    assert.equal(parts.found.length, 1);
    const shop: any = await d.tools.call("find", { name: "Shop" });
    assert.deepEqual(shop.found, [{ path: "ReplicatedStorage.Shop", className: "ModuleScript", file: "ReplicatedStorage/Shop.luau" }]);
    assert.equal((await d.tools.call("find", { under: "Workspace" }) as any).total, 2, "under counts what is below the path, not the path");
    await assert.rejects(d.tools.call("find", {}), /give a name/);
    edit.close();
  } finally {
    await d.close();
  }
});

test("perf: both peers sample at once and the answer keeps each; one peer when named; seconds bounded", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const edit = await editStudio(d.url, () => ({}));
    await assert.rejects(d.tools.call("perf", {}), /no play is running/);
    const asked: { peer: string; at: number }[] = [];
    const sample = (peer: string) => async (_tool: string, args: any) => {
      asked.push({ peer, at: Date.now() });
      await wait(300);
      return { seconds: args.seconds, signal: peer === "client" ? "RenderStepped" : "Heartbeat", fps: 60, frameMs: { p50: 16.6, p90: 17, p99: 20, max: 40 }, hitches: 0, memoryMb: 900, memoryChangeMb: 1, memoryTags: [{ tag: "Script", mb: 120 }], stats: { InstanceCount: 5000 } };
    };
    const server = await playPeer(d.url, "server", sample("server"));
    const client = await playPeer(d.url, "client", sample("client"));
    await waitFor(() => d.ipc.playPeers().client === "ready" && d.ipc.playPeers().server === "ready");
    const both: any = await d.tools.call("perf", { seconds: 1 });
    assert.equal(both.server.signal, "Heartbeat");
    assert.equal(both.client.signal, "RenderStepped");
    assert.ok(Math.abs(asked[0].at - asked[1].at) < 200, "sampled together, not one after the other");
    assert.match(both.note, /one Studio process/);
    const one: any = await d.tools.call("perf", { peer: "client" });
    assert.equal(one.server, undefined);
    assert.equal(one.client.fps, 60);
    await assert.rejects(d.tools.call("perf", { seconds: 60 }), /seconds must be from 0.5 to 30/);
    const { perfText } = await import("../control/commands.js");
    assert.match(perfText(both), /^server: 60 heartbeats a second over 1 s; frame ms p50 16\.6, p90 17, p99 20, max 40; 0 over 50 ms\n  memory 900 MB \(\+1 during\): Script 120; 5000 instances/);
    for (const ws of [client, server, edit]) ws.close();
  } finally {
    await d.close();
  }
});

test("logpoint: a file becomes the script's guid, a path goes as it is; export writes Studio's bytes to a file and import sends a file's bytes", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    d.tools.setPlace({
      scripts: () => [
        { guid: "g1", file: "ServerScriptService/Main.server.luau", text: "" },
        { guid: "g2", file: "ReplicatedStorage/A/Util.luau", text: "" },
        { guid: "g3", file: "ReplicatedStorage/B/Util.luau", text: "" },
      ],
      unmapped: () => [],
      nodes: () => [],
      fileOf: () => undefined,
    });
    const seen: any[] = [];
    const model = buildRoblox([{ className: "Model", name: "Tower", children: [{ className: "Script", name: "A" }, { className: "Script", name: "B" }] }]);
    const edit = await editStudio(d.url, (tool, args) => {
      seen.push({ tool, args });
      if (tool === "exportRbxm") return { data: model.toString("base64"), bytes: model.length, instances: ["Workspace.Tower"] };
      if (tool === "importRbxm") return { placed: ["Workspace.Tower (Model)"], scripts: 2 };
      return { path: "ServerScriptService.Main", line: args.line };
    });
    await d.tools.call("logpoint", { file: "Main.server.luau", line: 12, message: "hp, os.clock()" });
    assert.deepEqual(seen.at(-1), { tool: "logpoint", args: { action: "add", line: 12, guid: "g1", message: "hp, os.clock()" } });
    await d.tools.call("logpoint", { action: "remove", path: "ServerScriptService.Main", line: 12 });
    assert.deepEqual(seen.at(-1).args, { action: "remove", line: 12, path: "ServerScriptService.Main" });
    await d.tools.call("logpoint", { action: "list" });
    assert.deepEqual(seen.at(-1).args, { action: "list" });
    await assert.rejects(d.tools.call("logpoint", { file: "Util.luau", line: 1 }), /names 2 scripts/);
    await assert.rejects(d.tools.call("logpoint", { file: "Nope.luau", line: 1 }), /not a synced script file/);
    await assert.rejects(d.tools.call("logpoint", { file: "Main.server.luau", line: 0 }), /line must be/);
    await assert.rejects(d.tools.call("logpoint", { action: "toggle" }), /action must be add, remove, list or clear/);
    assert.equal(seen.length, 3, "the refused ones never reached Studio");

    const out = path.join(d.shots, "tower.rbxm");
    const saved: any = await d.tools.call("exportRbxm", { paths: ["Workspace.Tower"], out });
    assert.equal(saved.file, out);
    assert.deepEqual(fs.readFileSync(out), model);
    const defaulted: any = await d.tools.call("exportRbxm", { paths: ["Workspace.Tower"] });
    assert.match(defaulted.file.split(path.sep).join("/"), /\/exports\/Tower-.*\.rbxm$/);
    await assert.rejects(d.tools.call("exportRbxm", { paths: [] }), /paths must be a list/);
    const placed: any = await d.tools.call("importRbxm", { file: out, parent: "ServerStorage" });
    assert.deepEqual(seen.at(-1).args, { data: model.toString("base64"), parent: "ServerStorage" });
    assert.equal(placed.scripts, 2);
    await assert.rejects(d.tools.call("importRbxm", { file: "relative.rbxm" }), /absolute path/);
    await assert.rejects(d.tools.call("importRbxm", { file: path.join(d.shots, "missing.rbxm") }), /cannot read/);
    const broken = path.join(d.shots, "broken.rbxm");
    fs.writeFileSync(broken, model.subarray(0, 40));
    await assert.rejects(d.tools.call("importRbxm", { file: broken }), /broken\.rbxm: .*(runs past the end|no END chunk)/);
    const xml = path.join(d.shots, "ui.rbxmx");
    fs.writeFileSync(xml, '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" version="4"><Item class="ScreenGui" referent="RBX0"><Item class="LocalScript" referent="RBX1"></Item></Item></roblox>');
    // An XML model goes to Studio as an .rbxm does (Studio reads XML: measured 09/11/26 in PA), its
    // scripts counted; an XML place and paths picked from XML ask for the binary file
    const xmlModel: any = await d.tools.call("importRbxm", { file: xml });
    assert.equal(xmlModel.xml, true);
    assert.equal(xmlModel.xmlScripts, 1);
    assert.equal(seen.at(-1).tool, "importRbxm", "sent to Studio whole");
    const calls = seen.length;
    await assert.rejects(d.tools.call("importRbxm", { file: xml, paths: ["Shop"] }), /paths are picked from a binary file: save this XML model as \.rbxm/);
    const xmlPlace = path.join(d.shots, "v84.rbxlx");
    fs.writeFileSync(xmlPlace, "<roblox version='4'><Item class = 'Workspace' referent='RBX0'><Item class='Script' referent='RBX1'></Item></Item></roblox>");
    await assert.rejects(d.tools.call("importRbxm", { file: xmlPlace }), /v84\.rbxlx: an XML place \(\.rbxlx\): open it in Studio .* save it as \.rbxl/);
    const junk = path.join(d.shots, "junk.rbxm");
    fs.writeFileSync(junk, "PK\x03\x04 not a model");
    await assert.rejects(d.tools.call("importRbxm", { file: junk }), /junk\.rbxm: not a Roblox file/);
    assert.equal(seen.length, calls, "none of them reached Studio");
    edit.close();
  } finally {
    await d.close();
  }
});

test("import: a place file is read before Studio sees it; paths bring back only those items into their own parents, its scripts land only when asked", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const seen: any[] = [];
    const edit = await editStudio(d.url, (tool, args) => {
      seen.push({ tool, args });
      if (tool === "importPicks") return { placed: args.picks.map((p: any) => `${p.into}.${p.names.at(-1)} (${p.className})`), scripts: 0, alreadyThere: ["Workspace.MapA"] };
      return { placed: ["ServerStorage.Workspace (Model)"], scripts: 3 };
    });
    // the extension says model, the classes say place: the classes win
    const file = path.join(d.shots, "backup.rbxm");
    fs.writeFileSync(file, buildRoblox(samplePlace()));

    const listed: any = await d.tools.call("importRbxm", { file, list: true });
    assert.equal(seen.length, 0, "list calls no Studio");
    assert.equal(listed.place, true);
    assert.equal(listed.scriptCount, 3);
    assert.ok(listed.items.some((i: any) => i.path === "StarterGui.Shop"));

    const picked: any = await d.tools.call("importRbxm", { file, paths: ["Workspace.My.Map", "StarterGui"] });
    assert.equal(seen.at(-1).tool, "importPicks");
    assert.deepEqual(seen.at(-1).args.picks, [
      { names: ["Workspace", "My.Map"], className: "Model", count: 1, into: "Workspace" },
      { names: ["StarterGui", "Shop"], className: "ScreenGui", count: 1, into: "StarterGui" },
    ]);
    const sent = readRoblox(Buffer.from(seen.at(-1).args.data, "base64"));
    assert.equal(sent.place, false, "Studio gets the converted file");
    assert.deepEqual(sent.roots.slice(0, 2).map((r) => r.className), ["Model", "Folder"]);
    assert.deepEqual(picked.kept, ["Workspace.My.Map (Model) into Workspace", "StarterGui.Shop (ScreenGui) into StarterGui"]);
    assert.deepEqual(picked.leftOut, ["Workspace.MapA", "Workspace.Baseplate", "ReplicatedStorage.Config", "StarterPlayer.StarterPlayerScripts", "Lighting.Sky"]);
    assert.deepEqual(picked.scriptList, []);
    assert.deepEqual(picked.alreadyThere, ["Workspace.MapA"]);

    const before = seen.length;
    await assert.rejects(d.tools.call("importRbxm", { file, paths: ["Workspace.MapA", "ReplicatedStorage"] }), /what you picked holds 2 script\(s\).*Workspace\.MapA\.Door \(Script\), ReplicatedStorage\.Config\.Prices \(ModuleScript\).*scripts: true/);
    await assert.rejects(d.tools.call("importRbxm", { file }), /the file holds 3 script\(s\)/);
    await assert.rejects(d.tools.call("importRbxm", { file, paths: ["Workspace.MapZ"] }), /the file has no Workspace\.MapZ; Workspace holds MapA, My\.Map, Baseplate/);
    await assert.rejects(d.tools.call("importRbxm", { file, paths: "Workspace.MapA" }), /paths must be a list/);
    assert.equal(seen.length, before, "nothing refused reached Studio");

    const withScripts: any = await d.tools.call("importRbxm", { file, paths: ["Workspace.MapA", "StarterPlayer"], parent: "ServerStorage.Recovered", scripts: true });
    assert.deepEqual(seen.at(-1).args.picks.map((p: any) => `${p.names.join(".")}>${p.into}`), ["Workspace.MapA>ServerStorage.Recovered", "StarterPlayer.StarterPlayerScripts.Camera>ServerStorage.Recovered"]);
    assert.deepEqual(withScripts.scriptList, ["Workspace.MapA.Door (Script)", "StarterPlayer.StarterPlayerScripts.Camera (LocalScript)"]);

    const whole: any = await d.tools.call("importRbxm", { file, scripts: true });
    assert.equal(seen.at(-1).tool, "importRbxm");
    assert.equal(seen.at(-1).args.parent, "ServerStorage", "a whole place lands where none of its scripts runs");
    assert.equal(readRoblox(Buffer.from(seen.at(-1).args.data, "base64")).place, false);
    assert.equal(whole.place, true);
    assert.match(whole.note, /each service is a Folder/);

    // a model file's own top level can be picked too: it goes under Workspace by default
    const model = path.join(d.shots, "props.rbxm");
    fs.writeFileSync(model, buildRoblox([{ className: "Model", name: "Tower" }, { className: "Model", name: "Shed" }]));
    const fromModel: any = await d.tools.call("importRbxm", { file: model, paths: ["Tower"] });
    assert.deepEqual(seen.at(-1).args.picks, [{ names: ["Tower"], className: "Model", count: 1, into: "Workspace" }]);
    assert.deepEqual(fromModel.leftOut, ["Shed"]);

    // zstd on a Node that cannot read it: refused, a place inside could not be checked for scripts
    const zstd = (zlib as any).zstdCompressSync as ((b: Buffer) => Buffer) | undefined;
    if (zstd) {
      const packed = path.join(d.shots, "packed.rbxm");
      fs.writeFileSync(packed, buildRoblox([{ className: "Model", name: "Tower" }], (name, payload) => (name === "END" ? undefined : rbxChunk(name, zstd(payload), zstd(payload).length, payload.length))));
      const real = (zlib as any).zstdDecompressSync;
      (zlib as any).zstdDecompressSync = undefined;
      try {
        const calls = seen.length;
        await assert.rejects(d.tools.call("importRbxm", { file: packed }), /packed\.rbxm: chunk .* is zstd, which this Node .* cannot read: Node 22\.15 or newer/);
        assert.equal(seen.length, calls, "nothing reached Studio");
        await assert.rejects(d.tools.call("importRbxm", { file: packed, list: true }), /zstd, which this Node .* cannot read/);
      } finally {
        (zlib as any).zstdDecompressSync = real;
      }
    }
    edit.close();
  } finally {
    await d.close();
  }
});

test("multiplayer: each client says its player, a call with player goes to that one, a missing player says who is there, and captures are refused", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const editSeen: any[] = [];
    const edit = await editStudio(d.url, (tool, args) => {
      editSeen.push({ tool, args });
      return tool === "playStart" ? { mode: "multiplayer" } : {};
    });
    const server = await playPeer(d.url, "server", () => ({ ok: true, values: ["server"], output: [] }));
    const client = async (name: string | undefined) => {
      const ws = new WebSocket(`${d.url}/studio-output`);
      answer(ws, () => ({ ok: true, values: [name ?? "nameless"], output: [] }));
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      ws.send(JSON.stringify({ type: "peerHello", source: "client", log: false, ...(name ? { player: name } : {}) }));
      return ws;
    };
    const starting = d.tools.call("playtest", { action: "start", players: 2 });
    await waitFor(() => editSeen.some((m) => m.tool === "playStart"));
    assert.deepEqual(editSeen.find((m) => m.tool === "playStart").args, { mode: "play", players: 2 });
    const one = await client("Player1");
    // A client whose LocalPlayer came late names itself after its hello
    const two = await client(undefined);
    await wait(100);
    assert.deepEqual(d.ipc.playPeers().players, ["Player1"], "the nameless one is not a second player yet, and did not replace Player1");
    two.send(JSON.stringify({ type: "peerPlayer", player: "Player2" }));
    const started: any = await starting;
    assert.deepEqual(started.players, ["Player1", "Player2"]);
    const fromOne: any = await d.tools.call("eval", { code: "return 1", peer: "client", player: "Player1" });
    assert.deepEqual(fromOne.values, ["Player1"]);
    const fromTwo: any = await d.tools.call("eval", { code: "return 1", peer: "client", player: "Player2" });
    assert.deepEqual(fromTwo.values, ["nameless"]);
    await assert.rejects(d.tools.call("eval", { code: "return 1", peer: "client", player: "Player3" }), /no play client of Player3 is connected \(clients: Player1, Player2\)/);
    await assert.rejects(d.tools.call("screenshot", {}), /needs a solo play/);
    await assert.rejects(d.tools.call("record", {}), /needs a solo play/);
    await assert.rejects(d.tools.call("eval", { code: "return 1", player: 3 }), /player must be a player's name/);
    await assert.rejects(d.tools.call("playtest", { action: "start", players: 9 }), /players must be a whole number from 1 to 8/);
    // A newer socket of the same player replaces only that player's
    const oneAgain = await client("Player1");
    await waitFor(() => d.ipc.playPeers().players?.length === 2);
    assert.deepEqual(d.ipc.playPeers().players, ["Player1", "Player2"]);
    for (const ws of [one, two, oneAgain, server, edit]) ws.close();
  } finally {
    await d.close();
  }
});

test("new errors: a caller's first call during a long play still sees the errors the log kept after the play's start marker was dropped", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const edit = await editStudio(d.url, () => ({ ok: true, values: [], output: [] }));
    const server = await playPeer(d.url, "server", () => ({ ok: true, values: ["1"], output: [] }));
    await waitFor(() => d.ipc.playPeers().server === "ready");
    const line = (message: string, messageType = "MessageOutput") => ({ type: "studioOutput", message, messageType, source: "server", timestamp: Date.now() }) as any;
    // More lines than the log keeps (10,000): the "--- play started ---" marker goes
    for (let i = 0; i < 10_050; i++) d.tools.runtimeLog(line(`print ${i}`));
    d.tools.runtimeLog(line("ServerScriptService.Late:3: kept", "MessageError"));
    assert.ok(!d.tools.logs({ tail: 10_000 }).entries.some((e: any) => e.message === "--- play started ---"));
    const first: any = await d.tools.call("eval", { code: "return 1", caller: "late" });
    assert.deepEqual(first.newErrors?.map((e: any) => e.message), ["ServerScriptService.Late:3: kept"]);
    // The same once that play has ended: as with a marker, the last play's errors
    server.close();
    await waitFor(() => d.ipc.playPeers().server === undefined);
    const after: any = await d.tools.call("exec", { code: "return 1", caller: "after the play" });
    assert.deepEqual(after.newErrors?.map((e: any) => e.message), ["ServerScriptService.Late:3: kept"]);
    edit.close();
  } finally {
    await d.close();
  }
});

test("inspect and set: edit mode with no play, the play server during one, the client for a PlayerGui path; an attribute's null goes as Remove; a property's null is refused", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const seen: any[] = [];
    const answerAs = (peer: string) => (tool: string, args: any) => {
      seen.push({ peer, tool, args });
      return tool === "inspect" ? { path: args.path, className: "Part", properties: [], attributes: [], tags: [], children: [], childCount: 0 } : { path: args.path, changed: [] };
    };
    const edit = await editStudio(d.url, answerAs("edit"));
    await d.tools.call("inspect", { path: "Workspace.Door" });
    assert.equal(seen.at(-1).peer, "edit");
    const server = await playPeer(d.url, "server", answerAs("server"));
    const client = await playPeer(d.url, "client", answerAs("client"));
    await waitFor(() => d.ipc.playPeers().client === "ready" && d.ipc.playPeers().server === "ready");
    await d.tools.call("inspect", { path: "Workspace.Door", all: true });
    assert.deepEqual(seen.at(-1), { peer: "server", tool: "inspect", args: { path: "Workspace.Door", all: true, hidden: false } });
    await d.tools.call("inspect", { path: "PlayerGui.Shop" });
    assert.equal(seen.at(-1).peer, "client");
    await d.tools.call("inspect", { path: "Workspace.Door", peer: "edit" });
    assert.equal(seen.at(-1).peer, "edit");
    await d.tools.call("setProps", { path: "Workspace.Door", properties: { Transparency: 0.5 }, attributes: { Locked: null, Level: 3 } });
    assert.deepEqual(seen.at(-1).args, { path: "Workspace.Door", properties: { Transparency: 0.5 }, attributes: { Locked: { Remove: true }, Level: 3 } });
    await assert.rejects(d.tools.call("setProps", { path: "Workspace.Door", properties: { Parent: null } }), /null clears only an attribute/);
    await assert.rejects(d.tools.call("setProps", { path: "Workspace.Door" }), /give properties or attributes/);
    await assert.rejects(d.tools.call("inspect", { path: "Workspace.Door", peer: "studio" }), /peer must be edit, server or client/);
    for (const ws of [client, server, edit]) ws.close();
  } finally {
    await d.close();
  }
});

test("simulate: a preset and one side's numbers become the six NetworkSettings values, the play client gets them too, and the engine's 0.5% loss cap is checked first", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const seen: any[] = [];
    const edit = await editStudio(d.url, (_tool, args) => {
      seen.push({ peer: "edit", args });
      return { before: {}, after: {} };
    });
    const state: any = await d.tools.call("simulate", {});
    assert.deepEqual(seen.at(-1).args, {}, "nothing to set: only the state");
    assert.equal(state.client, undefined);
    await d.tools.call("simulate", { network: "good", inbound: { latencyMs: 80 }, quality: 3, memoryMb: 2048 });
    assert.deepEqual(seen.at(-1).args, {
      network: { InboundNetworkMinDelayMs: 80, OutboundNetworkMinDelayMs: 50, InboundNetworkJitterMs: 10, OutboundNetworkJitterMs: 10, InboundNetworkLossPercent: 0, OutboundNetworkLossPercent: 0 },
      quality: 3,
      memoryMb: 2048,
    });
    const client = await playPeer(d.url, "client", (_tool, args) => {
      seen.push({ peer: "client", args });
      return { before: {}, after: {} };
    });
    await playPeer(d.url, "server", () => ({}));
    await waitFor(() => d.ipc.playPeers().client === "ready");
    const both: any = await d.tools.call("simulate", { network: "poor" });
    assert.equal(seen.at(-1).peer, "client");
    assert.ok(both.client && both.edit);
    await assert.rejects(d.tools.call("simulate", { outbound: { lossPercent: 2 } }), /at most 0\.5% packet loss/);
    await assert.rejects(d.tools.call("simulate", { network: "awful" }), /network must be one of off, great, good, poor/);
    await assert.rejects(d.tools.call("simulate", { quality: 30 }), /quality must be auto or a level from 1 to 21/);
    const { simulationText } = await import("../control/commands.js");
    assert.equal(
      simulationText({ InboundNetworkMinDelayMs: 15, InboundNetworkJitterMs: 0, InboundNetworkLossPercent: 0, OutboundNetworkMinDelayMs: 15, OutboundNetworkJitterMs: 0, OutboundNetworkLossPercent: 0, QualityLevel: "Automatic", EmulatedTotalMemoryInMB: 63090 }),
      "inbound 15 ms, jitter 0 ms, loss 0%; outbound 15 ms, jitter 0 ms, loss 0%; graphics Automatic; device memory 61.6 GB",
    );
    client.close();
    edit.close();
  } finally {
    await d.close();
  }
});

test("devices: the simulator goes to each device, a screenshot of each, one picture of all, and back to how it was even when one fails", { timeout: 30000 }, async () => {
  const d = await daemon();
  try {
    const deviceCalls: any[] = [];
    let current = "default";
    let failOn: string | undefined;
    const pixels = (w: number, h: number, value: number) => Buffer.alloc(w * h * 4, value);
    const edit = await editStudio(d.url, (tool, args) => {
      if (tool === "device") {
        deviceCalls.push(args);
        if (args.stop) current = "default";
        else if (args.settings?.deviceId) current = args.settings.deviceId;
        return { activeDeviceId: current, isSimulating: current !== "default", ...(current !== "default" ? { orientation: "LandscapeLeft" } : {}) };
      }
      if (tool === "capture") {
        if (current === failOn) throw new Error("the Studio window is minimized");
        return current === "default" ? { width: 8, height: 4, data: pixels(8, 4, 200).toString("base64") } : { width: 4, height: 4, data: pixels(4, 4, 100).toString("base64") };
      }
      throw new Error(tool);
    });
    const result: any = await d.tools.call("devices", { devices: ["iphone_14", "none"] });
    assert.deepEqual(result.shots.map((s: any) => s.device), ["iphone_14", "none"]);
    assert.deepEqual(result.places.map((p: any) => [p.width, p.height]), [[360, 360], [720, 360]], "each scaled to 360 tall, keeping its shape");
    assert.equal(fs.readFileSync(result.sheet).subarray(1, 4).toString(), "PNG");
    assert.equal(current, "default", "no simulation before: none after");
    // A device was on before, and a capture fails midway: the simulator still goes back to it
    current = "ipad_10th_generation";
    failOn = "iphone_14";
    await assert.rejects(d.tools.call("devices", { devices: ["iphone_14"] }), /minimized/);
    assert.equal(current, "ipad_10th_generation");
    assert.deepEqual(deviceCalls.at(-1), { settings: { deviceId: "ipad_10th_generation", orientation: "LandscapeLeft" }, stop: false, list: false });
    await assert.rejects(d.tools.call("devices", { devices: [] }), /1 to 8 device ids/);
    edit.close();
  } finally {
    await d.close();
  }
});

test("profile: save runs the prelude's __quackSaveProfile and keeps its JSON, restore sends it back; without the functions it says what to add", { timeout: 20000 }, async () => {
  const preludeDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-profile-"));
  const d = await daemon({ preludeDir });
  try {
    const edit = await editStudio(d.url, () => ({}));
    const codes: string[] = [];
    const server = await playPeer(d.url, "server", (_tool, args) => {
      codes.push(args.code);
      return args.code.includes("JSONEncode(__quackSaveProfile") ? { ok: true, values: ['{"Coins":5,"Name":"olá"}'], output: [] } : { ok: true, values: ["true"], output: [] };
    });
    await waitFor(() => d.ipc.playPeers().server === "ready");
    await assert.rejects(d.tools.call("profile", { action: "save" }), /has no __quackSaveProfile/);
    fs.writeFileSync(path.join(preludeDir, "server.luau"), "local function __quackSaveProfile(p) return {} end\nlocal function __quackRestoreProfile(p, d) end\n");
    const saved: any = await d.tools.call("profile", { action: "save", name: "before-shop" });
    assert.equal(JSON.parse(fs.readFileSync(saved.file, "utf8")).Coins, 5);
    assert.match(codes.at(-1)!, /GetPlayers\(\)\[1\]/);
    await d.tools.call("profile", { action: "restore", name: "before-shop" });
    assert.match(codes.at(-1)!, /__quackRestoreProfile\(__p, game:GetService\("HttpService"\):JSONDecode\("\{\\"Coins\\":5,\\"Name\\":\\"olá\\"\}"\)\)/);
    assert.deepEqual(((await d.tools.call("profile", { action: "list" })) as any).profiles, ["before-shop"]);
    await assert.rejects(d.tools.call("profile", { action: "restore", name: "nope" }), /no profile kept as nope/);
    await assert.rejects(d.tools.call("profile", { action: "save", name: "../x" }), /name must be letters/);
    server.close();
    edit.close();
  } finally {
    await d.close();
    fs.rmSync(preludeDir, { recursive: true, force: true });
  }
});

test("png: resize averages the area each pixel covers, and a mosaic wraps rows at the width it is given", async () => {
  const { resize, mosaic } = await import("../util/png.js");
  const two = Buffer.from([0, 0, 0, 255, 200, 100, 50, 255]);
  assert.deepEqual([...resize(two, 2, 1, 1, 1).rgba], [100, 50, 25, 255]);
  const square = { rgba: Buffer.alloc(4 * 4 * 4, 9), width: 4, height: 4 };
  const laid = mosaic([square, square, square], 10, 25, 2);
  assert.deepEqual(laid.places.map((p) => [p.x, p.y]), [[0, 0], [12, 0], [0, 12]]);
  assert.equal(laid.width, 22);
  assert.equal(laid.height, 22);
});

test("assets: preview and insert go to edit mode with the id checked first; a position becomes x, y, z; the answers name the scripts and what insert removed", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    await assert.rejects(d.tools.call("assetPreview", { assetId: 5 }), /Studio is not connected/);
    const seen: any[] = [];
    const edit = await editStudio(d.url, (tool, args) => {
      seen.push({ tool, args });
      if (tool === "assetPreview") {
        return { assetId: args.assetId, total: 3, classes: [{ class: "Script", count: 1 }, { class: "Part", count: 2 }], nodes: [{ d: 0, n: "Sword", c: "Tool" }, { d: 1, n: "Handle", c: "Part", more: 2 }], truncated: false, scripts: [{ path: "Sword.Loader", className: "Script", lines: 4, enabled: true, uses: ["require(<asset id>)"] }], packageLinks: [], sounds: [] };
      }
      return { assetId: args.assetId, parent: "Workspace", inserted: [{ path: "Workspace.Sword", className: "Tool" }], removedScripts: ["Sword.Loader (Script)"], removedPackageLinks: [], moved: args.position };
    });
    for (const bad of [0, -1, 1.5, "x"]) await assert.rejects(d.tools.call("assetPreview", { assetId: bad }), /assetId must be a whole number above 0/);
    await assert.rejects(d.tools.call("assetPreview", { assetId: 5, depth: 99 }), /depth must be a whole number from 0 to 20/);
    assert.equal(seen.length, 0, "refused before Studio");
    const preview: any = await d.tools.call("assetPreview", { assetId: "47433" });
    assert.deepEqual(seen.at(-1), { tool: "assetPreview", args: { assetId: 47433, depth: 4 } });
    const { previewText, insertText } = await import("../control/commands.js");
    assert.match(previewText(preview), /^Asset 47433: 3 instances \(Script 1, Part 2\), \d+ ms\nScripts \(1; insert_asset removes every one\):\n  Sword\.Loader \[Script\], 4 lines, uses require\(<asset id>\)\nTree:\n  Sword \[Tool\]\n    Handle \[Part\] \+2 inside$/);

    const inserted: any = await d.tools.call("assetInsert", { assetId: 47433, position: { x: -10, y: 2.5, z: 0 }, parent: "Workspace.Map" });
    assert.deepEqual(seen.at(-1).args, { assetId: 47433, parent: "Workspace.Map", position: [-10, 2.5, 0] });
    await d.tools.call("assetInsert", { assetId: 47433, position: [1, 2, 3] });
    assert.deepEqual(seen.at(-1).args, { assetId: 47433, position: [1, 2, 3] });
    await assert.rejects(d.tools.call("assetInsert", { assetId: 47433, position: { x: 1 } }), /position must be x, y and z/);
    assert.match(insertText(inserted), /^Inserted Workspace\.Sword \(Tool\) under Workspace at -10, 2\.5, 0, one undo step, selected \(\d+ ms\)\.\nRemoved before the insert: 1 script\(s\): Sword\.Loader \(Script\)\. Quack never inserts a Store asset's scripts/);
    edit.close();
  } finally {
    await d.close();
  }
});

test("memory: edit mode alone with no play, every peer at once during one, one peer when named, tags checked; a peer that fails says so beside the others", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const asked: { peer: string; args: any; at: number }[] = [];
    const answerAs = (peer: string) => async (_tool: string, args: any) => {
      asked.push({ peer, args, at: Date.now() });
      await wait(200);
      if (peer === "client") throw new Error("no Stats here");
      return { totalMb: 1500, trackingEnabled: true, tags: [{ tag: "Script", mb: 100 }, { tag: "Instances", mb: 50 }] };
    };
    const edit = await editStudio(d.url, answerAs("edit"));
    const alone: any = await d.tools.call("memory", {});
    assert.deepEqual(Object.keys(alone).filter((k) => k !== "ms"), ["edit"]);
    await assert.rejects(d.tools.call("memory", { peer: "server" }), /no play is running/);
    const server = await playPeer(d.url, "server", answerAs("server"));
    const client = await playPeer(d.url, "client", answerAs("client"));
    await waitFor(() => d.ipc.playPeers().client === "ready" && d.ipc.playPeers().server === "ready");
    asked.length = 0;
    const all: any = await d.tools.call("memory", { tags: ["Script"] });
    assert.deepEqual(asked.map((a) => a.peer).sort(), ["client", "edit", "server"]);
    assert.ok(Math.max(...asked.map((a) => a.at)) - Math.min(...asked.map((a) => a.at)) < 150, "asked together");
    assert.deepEqual(asked[0].args, { tags: ["Script"] });
    assert.equal(all.client.error, "no Stats here");
    assert.match(all.note, /one process/);
    const one: any = await d.tools.call("memory", { peer: "server" });
    assert.deepEqual(Object.keys(one).filter((k) => k !== "ms"), ["server"]);
    await assert.rejects(d.tools.call("memory", { tags: "Script" }), /tags must be a list/);
    await assert.rejects(d.tools.call("memory", { peer: "studio" }), /peer must be edit, server or client/);
    const { memoryText } = await import("../control/commands.js");
    assert.match(memoryText(all), /^edit: 1500 MB in all; Script 100, Instances 50\nserver: 1500 MB in all; Script 100, Instances 50\nclient: no Stats here\n\(Studio's edit mode/);
    for (const ws of [client, server, edit]) ws.close();
  } finally {
    await d.close();
  }
});

test("profiler: the play server by default or the client, its numbers bounded before Studio, and the raw profile saved when asked", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const edit = await editStudio(d.url, () => ({}));
    await assert.rejects(d.tools.call("profiler", {}), /no play is running/);
    const seen: any[] = [];
    const answerAs = (peer: string) => (_tool: string, args: any) => {
      seen.push({ peer, args });
      return {
        durationMs: args.durationMs, frequency: args.frequency, counted: 40, kept: 2, omitted: { native: 30, plugin: 0, quack: 8, filtered: 0 },
        functions: [{ rank: 1, name: "step", source: "ServerScriptService.Loop", line: 12, totalUs: 52000, pct: 5.2 }],
        ...(args.raw ? { raw: '{"Functions":[]}' } : {}),
      };
    };
    const server = await playPeer(d.url, "server", answerAs("server"));
    const client = await playPeer(d.url, "client", answerAs("client"));
    await waitFor(() => d.ipc.playPeers().client === "ready" && d.ipc.playPeers().server === "ready");
    const result: any = await d.tools.call("profiler", {});
    assert.deepEqual(seen.at(-1), { peer: "server", args: { durationMs: 1000, frequency: 1000, maxFunctions: 20, includeNative: false, includePlugin: false, raw: false } });
    assert.equal(result.file, undefined);
    await d.tools.call("profiler", { peer: "client", durationMs: 200, filter: "Loop", includePlugin: true });
    assert.deepEqual(seen.at(-1), { peer: "client", args: { durationMs: 200, frequency: 1000, maxFunctions: 20, filter: "Loop", includeNative: false, includePlugin: true, raw: false } });
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ durationMs: 50 }, /durationMs must be a whole number from 100 to 15000/],
      [{ frequency: 0 }, /frequency must be/],
      [{ maxFunctions: 500 }, /maxFunctions must be/],
      [{ peer: "edit" }, /peer must be server or client/],
      [{ out: "relative.json" }, /out must be an absolute path/],
    ];
    for (const [args, why] of refused) await assert.rejects(d.tools.call("profiler", args), why);
    const saved: any = await d.tools.call("profiler", { save: true });
    assert.equal(seen.at(-1).args.raw, true);
    assert.equal(saved.raw, undefined, "the raw profile goes to a file, not the answer");
    assert.equal(fs.readFileSync(saved.file, "utf8"), '{"Functions":[]}');
    assert.match(saved.file, /profiler[\\/]profile-server-.*\.json$/);
    const { profilerText } = await import("../control/commands.js");
    assert.match(profilerText(saved), /^the play server: 1000 ms at 1000 samples a second; 40 functions, 2 kept \(left out: 30 native, 8 Quack's own\)\n  1\.    5\.2%      52\.00 ms  step  ServerScriptService\.Loop:12\nRaw profile: /);
    for (const ws of [client, server, edit]) ws.close();
  } finally {
    await d.close();
  }
});

test("scene: edit mode with no play, the play server during one, mode and topN checked first; each mode's error stays its own", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const seen: any[] = [];
    const answerAs = (peer: string) => (_tool: string, args: any) => {
      seen.push({ peer, args });
      return {
        order: ["instance_composition", "triangle_composition"],
        modes: {
          instance_composition: { method: "GetInstanceCompositionAsync", ms: 40, root: { name: "game", size: 2000, leaves: 2 }, top: [{ name: "Part", size: 1500 }, { name: "Model", size: 500 }] },
          triangle_composition: { method: "GetTriangleCompositionAsync", ms: 3, error: 'SceneAnalysisService is not enabled (turn on the beta feature "Scene Analysis" in File > Beta Features and restart Studio)' },
        },
      };
    };
    const edit = await editStudio(d.url, answerAs("edit"));
    const result: any = await d.tools.call("scene", {});
    assert.deepEqual(seen.at(-1), { peer: "edit", args: { mode: "all", topN: 10 } });
    await assert.rejects(d.tools.call("scene", { mode: "everything" }), /mode must be all or one of instance_composition/);
    await assert.rejects(d.tools.call("scene", { topN: 0 }), /topN must be a whole number from 1 to 100/);
    const server = await playPeer(d.url, "server", answerAs("server"));
    await waitFor(() => d.ipc.playPeers().server === "ready");
    await d.tools.call("scene", { mode: "script_memory", topN: 3 });
    assert.deepEqual(seen.at(-1), { peer: "server", args: { mode: "script_memory", topN: 3 } });
    await d.tools.call("scene", { peer: "edit" });
    assert.equal(seen.at(-1).peer, "edit");
    // The caller's timeoutMs is the wait (the CLI sends 300 s for all, which the hub honors too)
    const slow = await playPeer(d.url, "client", async () => wait(2000));
    await waitFor(() => d.ipc.playPeers().client === "ready");
    await assert.rejects(d.tools.call("scene", { peer: "client", timeoutMs: 200 }), /the play client did not answer in 0 s/);
    slow.close();
    const { sceneText } = await import("../control/commands.js");
    assert.match(sceneText(result), /^Scene analysis of the edit plugin \(\d+ ms\):\ninstance_composition: 2 entries, 2000 in all \(40 ms\)\n  Part  1500\n  Model  500\ntriangle_composition: SceneAnalysisService is not enabled \(turn on the beta feature "Scene Analysis"/);
    for (const ws of [server, edit]) ws.close();
  } finally {
    await d.close();
  }
});

test("find with a peer searches that live DataModel; an attribute or a tag with no peer goes to the play server during a play, else edit mode; bad input is refused first", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const seen: any[] = [];
    const answerAs = (peer: string) => (tool: string, args: any) => {
      seen.push({ peer, tool, args });
      return { found: [{ path: "Workspace.Enemies.Boss", className: "Model", attributes: 2 }], total: 1, scanned: 900, classMatch: args.classes ? (args.exact ? "exact" : "IsA") : undefined, seconds: 0.01 };
    };
    const edit = await editStudio(d.url, answerAs("edit"));
    const live: any = await d.tools.call("find", { attribute: "Level", attributeValue: 3 });
    assert.deepEqual(seen.at(-1), { peer: "edit", tool: "find", args: { attribute: "Level", attributeValue: "3", limit: 50 } });
    assert.equal(live.peer, "edit");
    assert.equal(live.found[0].attributes, 2);
    await assert.rejects(d.tools.call("find", { peer: "server", name: "Boss" }), /no play is running/);
    const server = await playPeer(d.url, "server", answerAs("server"));
    const client = await playPeer(d.url, "client", answerAs("client"));
    await waitFor(() => d.ipc.playPeers().client === "ready" && d.ipc.playPeers().server === "ready");
    await d.tools.call("find", { tag: "Enemy", under: "Workspace" });
    assert.deepEqual(seen.at(-1), { peer: "server", tool: "find", args: { under: "Workspace", tag: "Enemy", limit: 50 } });
    const byClass: any = await d.tools.call("find", { peer: "client", name: "*Button", className: "GuiButton, TextLabel", exact: true, limit: 5 });
    assert.deepEqual(seen.at(-1), { peer: "client", tool: "find", args: { name: "*Button", classes: ["GuiButton", "TextLabel"], exact: true, limit: 5 } });
    assert.equal(byClass.classMatch, "exact");
    await assert.rejects(d.tools.call("find", { peer: "studio", name: "x" }), /peer must be server or client/);
    await assert.rejects(d.tools.call("find", { peer: "server" }), /give a name .* an attribute or a tag/);
    await assert.rejects(d.tools.call("find", { attribute: "has space" }), /attribute must be an attribute's name/);
    await assert.rejects(d.tools.call("find", { peer: "server", name: "x", attributeValue: 1 }), /attributeValue needs attribute/);
    await assert.rejects(d.tools.call("find", { peer: "server", name: "x", limit: 0 }), /limit must be a whole number from 1 to 5000/);
    // With no peer and no attribute or tag, still the synced tree (no Studio call)
    const before = seen.length;
    await assert.rejects(d.tools.call("find", { name: "x" }), /this daemon has no synced tree/);
    assert.equal(seen.length, before);
    const { findText } = await import("../control/commands.js");
    assert.equal(findText({ ...byClass, ms: 4 }), "Workspace.Enemies.Boss [Model]  2 attributes\n1 found among 900 instances of the play client; classes by exact ClassName (4 ms).");
    assert.equal(findText({ peer: "server", found: [], total: 0, scanned: 10, classMatch: "IsA", unknownClasses: ["Bos"], ms: 1 }), "0 found among 10 instances of the play server; classes by IsA (subclasses too), except Bos: no class the API knows, so matched by exact ClassName (1 ms).");
    for (const ws of [client, server, edit]) ws.close();
  } finally {
    await d.close();
  }
});

test("move: the play server moves the character unless a player owns its physics, then that player's client does; peer server forces the server; the target and mode are checked first", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const seen: any[] = [];
    let owner: string | undefined = "Ender";
    const moved = (peer: string, args: any) => ({ how: args.mode, player: "Ender", goal: args.position ?? [0, 5, 0], from: [9, 3, 9], at: args.position ?? [0, 5, 0], distanceLeft: 0.4, stopped: args.mode === "teleport" ? "teleported" : "arrived", arrived: true, seconds: 0.1, ...(peer === "server" ? { owner: owner ?? "server" } : {}) });
    const edit = await editStudio(d.url, () => ({}));
    await assert.rejects(d.tools.call("move", { position: [1, 2, 3] }), /no play is running/);
    const server = await playPeer(d.url, "server", (tool, args) => {
      seen.push({ peer: "server", tool, args });
      if (owner && !args.stay) return { handOff: "client", owner, player: "Ender", position: args.position ?? [0, 5, 0], ...(args.path ? { target: `Workspace.${args.path.split(".").at(-1)}` } : {}) };
      return moved("server", args);
    });
    const client = await playPeer(d.url, "client", (tool, args) => {
      seen.push({ peer: "client", tool, args });
      return moved("client", args);
    });
    await waitFor(() => d.ipc.playPeers().client === "ready" && d.ipc.playPeers().server === "ready");

    // The client owns the root: the server hands the move over, the client gets the same request
    const handed: any = await d.tools.call("move", { position: [1, 2, 3] });
    assert.deepEqual(seen.slice(-2).map((m) => [m.peer, m.tool]), [["server", "move"], ["client", "move"]]);
    assert.deepEqual(seen.at(-1).args, { mode: "teleport", position: [1, 2, 3], seconds: 15 });
    assert.equal(handed.peer, "client");
    assert.equal(handed.owner, "Ender");
    assert.equal(handed.stopped, "teleported");
    // A path is resolved by the server (the client may not have it streamed in): the client gets
    // the server's position, and the path only as the answer's label
    await d.tools.call("move", { path: "Workspace.Far.Shop", mode: "walk" });
    assert.deepEqual(seen.at(-1), { peer: "client", tool: "move", args: { mode: "walk", position: [0, 5, 0], seconds: 15, target: "Workspace.Shop" } });
    // peer server: the server moves it whoever owns it
    const forced: any = await d.tools.call("move", { path: "Workspace.Shop", mode: "walk", peer: "server", timeoutMs: 4000 });
    assert.deepEqual(seen.at(-1), { peer: "server", tool: "move", args: { mode: "walk", path: "Workspace.Shop", seconds: 4, stay: true } });
    assert.equal(forced.peer, "server");
    // The server owns it: no hand-off
    owner = undefined;
    const count = seen.length;
    const onServer: any = await d.tools.call("move", { path: "Workspace.Shop", mode: "path", radius: 3 });
    assert.equal(seen.length, count + 1);
    assert.deepEqual(seen.at(-1).args, { mode: "path", path: "Workspace.Shop", seconds: 15, radius: 3 });
    assert.equal(onServer.peer, "server");
    // peer client goes straight to the client
    await d.tools.call("move", { position: [0, 0, 0], peer: "client" });
    assert.equal(seen.at(-1).peer, "client");
    assert.equal(seen.length, count + 2);

    await assert.rejects(d.tools.call("move", {}), /give a position \[x, y, z\] or a path/);
    await assert.rejects(d.tools.call("move", { position: [1, 2, 3], path: "Workspace.Shop" }), /one of them/);
    await assert.rejects(d.tools.call("move", { position: [1, 2] }), /position must be \[x, y, z\]/);
    await assert.rejects(d.tools.call("move", { path: "Workspace.Shop", mode: "fly" }), /mode must be teleport, walk/);
    await assert.rejects(d.tools.call("move", { path: "Workspace.Shop", radius: 0 }), /radius must be a number of studs from 0.5 to 50/);
    await assert.rejects(d.tools.call("move", { path: "Workspace.Shop", peer: "edit" }), /peer must be server or client/);
    assert.equal(seen.length, count + 2, "refusals never reach Studio");

    const { moveText } = await import("../control/commands.js");
    assert.equal(moveText(handed), `Teleported Ender to 1, 2, 3 from 9, 3, 9, on the play client (Ender owns the character's physics): feet at 1, 2, 3, 0.4 studs from the goal (${handed.ms} ms).`);
    const stuck = { peer: "server", owner: "server", how: "path", player: "Ender", target: "Workspace.Shop", goal: [0, 5, 0], from: [9, 3, 9], at: [4, 3, 4], distanceLeft: 5.66, heightLeft: 2, stopped: "stuck", waypoints: 7, waypointReached: 3, seconds: 4.2, walkSpeed: 16, timeoutSeconds: 15, ms: 4300 };
    assert.equal(moveText(stuck), "Ender walked along a path of 7 waypoints from 9, 3, 9 toward Workspace.Shop (its top at 0, 5, 0), on the play server: stopped: no closer for 2 s (a wall, a gap, or the game holding it), after waypoint 3. Feet at 4, 3, 4, 5.66 studs left; 4.2 s at WalkSpeed 16 (4300 ms in all).");
    for (const ws of [client, server, edit]) ws.close();
  } finally {
    await d.close();
  }
});

test("move in a multiplayer test: the hand-off goes to the owner's own client", { timeout: 20000 }, async () => {
  const d = await daemon();
  try {
    const edit = await editStudio(d.url, () => ({}));
    const serverSeen: any[] = [];
    const server = await playPeer(d.url, "server", (_tool, args) => {
      serverSeen.push(args);
      return { handOff: "client", owner: args.player ?? "Player2", player: args.player ?? "Player2" };
    });
    const client = async (name: string) => {
      const ws = new WebSocket(`${d.url}/studio-output`);
      answer(ws, () => ({ how: "teleport", player: name, goal: [0, 0, 0], from: [0, 0, 0], at: [0, 0, 0], distanceLeft: 0, stopped: "teleported", arrived: true }));
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      ws.send(JSON.stringify({ type: "peerHello", source: "client", log: false, player: name }));
      return ws;
    };
    const one = await client("Player1");
    const two = await client("Player2");
    await waitFor(() => d.ipc.playPeers().players?.length === 2 && d.ipc.playPeers().server === "ready");
    // No player named: the server picks (here Player2 owns it), and Player2's client moves it
    const moved: any = await d.tools.call("move", { position: [0, 0, 0] });
    assert.equal(moved.player, "Player2");
    assert.equal(serverSeen.at(-1).player, undefined);
    // A player named goes to the server too, so it moves that one
    const named: any = await d.tools.call("move", { position: [0, 0, 0], player: "Player1" });
    assert.equal(serverSeen.at(-1).player, "Player1");
    assert.equal(named.player, "Player1");
    for (const ws of [one, two, server, edit]) ws.close();
  } finally {
    await d.close();
  }
});

test("numbersOnly: numbers, BigNum strings and a sign are tuning; comments are free; anything else is code", () => {
  assert.equal(numbersOnly("return { Hp = 10, Cost = \"1e30\" } -- note\n", "return { Hp = 12, Cost = \"2.5K\" } -- other note\n"), null);
  assert.equal(numbersOnly("local x = 5\n", "local x = -5\n"), null);
  assert.equal(numbersOnly("local x = 5\n", "local x = 5 -- why\n"), "no number changed (spacing or comments only)");
  assert.equal(numbersOnly("local x = 5\n", "local y = 6\n"), "code changed");
  assert.equal(numbersOnly("local s = \"Bolt\"\n", "local s = \"Bolt2\"\n"), "code changed");
  assert.match(numbersOnly("local s = `a{1}`\n", "local s = `a{2}`\n")!, /could not read it: an interpolated string/);
  assert.equal(numbersOnly("local s = [[100]]\n", "local s = [[200]]\n"), null);
  assert.equal(numbersOnly("local s = [[\n100]]\n", "local s = [[\n200]]\n"), null, "Luau drops the newline after [[");
  assert.equal(numbersOnly("local n = 1e1_0\n", "local n = 1e1_1\n"), null, "an exponent with _ is one number");
  const name = `v${"x".repeat(399)}`; // 400 characters, then a digit
  assert.equal(numbersOnly(`local ${name}1 = 5\n`, `local ${name}2 = 5\n`), "code changed", "a long name is read whole");
});
