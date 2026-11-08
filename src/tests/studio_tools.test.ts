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
import { encodeGif, lzw } from "../util/gif.js";
import { encodePng, halve, sheet } from "../util/png.js";

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
  const recordings = path.join(shots, "recordings");
  const tools = StudioTools.attach(ipc, shots, recordings);
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
