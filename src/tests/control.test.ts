import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { PassThrough } from "node:stream";
import { runControl, type ControlContext } from "../control/commands.js";
import { serveMcp } from "../control/mcp.js";
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

test("wait lists script files on disk that have no instance in Studio", { timeout: 60000 }, async () => {
  await withHub(async ({ port, folders }) => {
    const studio = fakeStudio(port, 111, "AlphaScript");
    const run = control(port);
    const clean = await run("wait", "111", "--idle", "300", "--timeout", "15");
    assert.equal(clean.code, 0, clean.err);
    assert.match(clean.out, /is connected and in sync/);

    // A merge's new script the Studio never created (this fake Studio does not answer creates)
    fs.mkdirSync(path.join(folders["111"], "sync", "ServerStorage", "Config"), { recursive: true });
    fs.writeFileSync(path.join(folders["111"], "sync", "ServerStorage", "Config", "Lost.luau"), "return 1\n");
    await waitFor(() => studio.received.some((m) => m.type === "createInstance" && m.name === "Lost"));
    const missing = await run("wait", "111", "--idle", "300", "--timeout", "15");
    assert.equal(missing.code, 0, "the exit code stays: scripts read it as synced");
    assert.match(missing.out, /1 script file\(s\) on disk have no instance in Studio/);
    assert.match(missing.out, /^  ServerStorage\/Config\/Lost\.luau$/m);
    assert.doesNotMatch(missing.out, /AlphaScript/);
    const json = (await run("wait", "111", "--idle", "300", "--timeout", "15", "--json")).json();
    assert.deepEqual(json.unsynced, ["ServerStorage/Config/Lost.luau"]);

    // Saving the file again is an edit of a file nobody maps: no create
    const lost = path.join(folders["111"], "sync", "ServerStorage", "Config", "Lost.luau");
    const creates = () => studio.received.filter((m) => m.type === "createInstance" && m.name === "Lost").length;
    // The daemon's own tries first (3, 3 s apart), so none lands in the middle of what follows
    await waitFor(() => creates() === 3, 20000);
    await wait(3500);
    const before = creates();
    assert.equal(before, 3, "three tries, then it gives up");
    fs.writeFileSync(lost, "return 1\r\n");
    await wait(800);
    assert.equal(creates(), before, "an overwrite sends no create");
    assert.match(missing.out, /wait --fix/);

    // --fix sends the create again; this Studio answers now, as one past a play swap does
    studio.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "createInstance") return;
      studio.ws.send(JSON.stringify({ type: "instanceUpdated", data: { guid: `made-${msg.name}`, className: msg.className, name: msg.name, path: [...msg.parentPath, msg.name], source: msg.source } }));
    });
    const fixed = await run("wait", "111", "--fix", "--idle", "300", "--timeout", "15");
    assert.equal(fixed.code, 0, fixed.err);
    assert.match(fixed.out, /Sending the create of 1 script file\(s\) again/);
    assert.match(fixed.out, /1 script file\(s\) now have their instance in Studio/);
    assert.match(fixed.out, /is connected and in sync/);
    assert.equal(fs.readFileSync(lost, "utf8"), "return 1\r\n", "the answer leaves the file as it was");
    assert.deepEqual((await run("wait", "111", "--idle", "300", "--json")).json().unsynced, []);
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

/** An MCP client on a pipe to serveMcp: `call` sends one request and returns its answer */
function mcpSession(port: number, cwd = os.tmpdir()) {
  const input = new PassThrough();
  const output = new PassThrough();
  const answers = new Map<number, (message: any) => void>();
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      answers.get(message.id)?.(message);
    }
  });
  const done = serveMcp(input, output, { info: { ...flavorInfo("dev"), port }, client: new HubClient(port), cwd, openUri: async () => {}, pollMs: 50 });
  let next = 1;
  const call = (method: string, params?: object): Promise<any> => {
    const id = next++;
    return new Promise((resolve) => {
      answers.set(id, resolve);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  const tool = async (name: string, args: object = {}) => (await call("tools/call", { name, arguments: args })).result;
  const close = () => {
    input.end();
    return done;
  };
  return { call, tool, close, write: (line: string) => input.write(`${line}\n`) };
}

test("mcp: initialize carries the instructions, and the tools are the reading ones, wait and play", { timeout: 15000 }, async () => {
  const mcp = mcpSession(await freePort());
  const init = await mcp.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "quack-dev");
  assert.match(init.result.instructions, /git add/);
  assert.match(init.result.instructions, /Never switch branches/);
  mcp.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal((await mcp.call("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion, "2025-06-18", "an unknown version gets the newest");
  const names = (await mcp.call("tools/list")).result.tools.map((t: any) => t.name);
  assert.deepEqual(names, ["status", "wait", "log", "conflicts", "conflict", "doctor", "play"]);
  for (const mutating of ["resolve", "pause", "resume", "register", "unregister", "choose", "restart-hub", "open", "ai"]) {
    assert.ok(!names.includes(mutating), `${mutating} is a person's, not a tool`);
  }
  assert.equal((await mcp.call("tools/call", { name: "pause" })).error.code, -32602);
  assert.equal((await mcp.call("resources/list")).error.code, -32601);
  assert.deepEqual((await mcp.call("ping")).result, {});
  await mcp.close();
});

test("mcp: the tools answer what the commands print, and refuse a value that would read as an option", { timeout: 60000 }, async () => {
  await withHub(async ({ port, folders }) => {
    const studio = fakeStudio(port, 111, "AlphaScript");
    const mcp = mcpSession(port, path.join(folders["111"], "sync"));
    await waitFor(async () => (await control(port)("status", "--json")).json().sessions[0]?.instances === 3);

    const status = await mcp.tool("status");
    assert.equal(status.isError, undefined);
    assert.match(status.content[0].text, /Alpha Game\s+111\s+connected/);

    const waited = await mcp.tool("wait", { idleMs: 200 });
    assert.match(waited.content[0].text, /Alpha Game \(111\) is connected and in sync/, "the folder the AI runs in names the place");

    const log = await mcp.tool("log", { place: "alpha", lines: 1 });
    assert.match(log.content[0].text, /^\(last 1 of \d+ lines\)\n/);
    assert.equal(log.content[0].text.split("\n").length, 2);
    const fraction = await mcp.tool("log", { place: "alpha", lines: 0.5 });
    assert.match(fraction.content[0].text, /^\(last 1 of \d+ lines\)\n/, "less than one line still cuts the log");

    assert.match((await mcp.tool("conflicts", { place: "111" })).content[0].text, /No conflicts waiting/);
    const noId = await mcp.tool("conflict");
    assert.equal(noId.isError, true);
    assert.match(noId.content[0].text, /id is required/);
    const option = await mcp.tool("log", { place: "--follow" });
    assert.equal(option.isError, true);
    assert.match(option.content[0].text, /cannot start with "-"/);
    const ambiguous = await mcp.tool("log", { place: "game" });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0].text, /more than one place/);

    // Two calls at once each get their own answer
    const [a, b] = await Promise.all([mcp.tool("conflicts", { place: "222" }), mcp.tool("status")]);
    assert.match(a.content[0].text, /No conflicts/);
    assert.match(b.content[0].text, /Beta Game/);
    await mcp.close();
    studio.ws.terminate();
  });
});

test("mcp: no hub running is a tool error that says so, and the real command speaks only protocol on stdout", { timeout: 30000 }, async () => {
  const mcp = mcpSession(await freePort());
  const status = await mcp.tool("status");
  assert.equal(status.isError, true);
  assert.match(status.content[0].text, /no hub answers/);
  await mcp.close();

  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [path.join(here, "..", "control", "main.js"), "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await waitFor(() => stdout.split("\n").filter(Boolean).length >= 2, 10000);
  child.stdin.end();
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, "closing stdin ends the server");
  const messages = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((m) => m.id).sort(), [1, 2]);
  assert.equal(messages.find((m) => m.id === 2).result.tools.length, 7);
});

test("connect-ai: Cursor's file keeps every other server and key, a broken one is never overwritten, a missing CLI is not installed", { timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "quack-clients-"));
  try {
    const clients = { home, claudeBin: "quack-no-such-claude", codexBin: "quack-no-such-codex", env: {} };
    const server = { command: process.execPath, args: ["cli.mjs", "--flavor", "dev", "mcp"] };
    const run = async (...argv: string[]) => {
      const out: string[] = [];
      const code = await runControl([...argv, "--json"], {
        info: flavorInfo("dev"), client: new HubClient(await freePort()), out: (l) => out.push(l), err: (l) => out.push(l),
        confirm: async () => false, interactive: false, color: false, cwd: home, openUri: async () => {}, server, clients,
      });
      return { code, json: () => JSON.parse(out.join("\n")) };
    };
    const byName = (r: any) => Object.fromEntries(r.clients.map((c: any) => [c.client, c]));

    let listed = byName((await run("ai-clients")).json());
    assert.deepEqual([listed.claude.installed, listed.cursor.installed, listed.codex.installed], [false, false, false]);

    fs.mkdirSync(path.join(home, ".cursor"));
    const file = path.join(home, ".cursor", "mcp.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { Other: { command: "x" } }, keep: 1 }));
    const connected = await run("connect-ai");
    assert.equal(connected.code, 0);
    listed = byName(connected.json());
    assert.equal(listed.cursor.connected, true);
    assert.equal(listed.claude.installed, false, "a client not installed is left alone");
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(written.mcpServers.Other, { command: "x" });
    assert.equal(written.keep, 1);
    assert.deepEqual(written.mcpServers["quack-dev"], server);

    fs.writeFileSync(file, "{ not json");
    const broken = await run("connect-ai", "cursor");
    assert.equal(broken.code, 1);
    assert.match(byName(broken.json()).cursor.problem, /JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "a file Quack cannot read stays as it was");

    assert.equal((await run("connect-ai", "vscode")).code, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("connect-ai reaches every config folder: the default, ~/.claude-*, ~/.codex-* and T3 Code's providers, named by app and proxy", { timeout: 60000, skip: process.platform !== "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "quack-homes-"));
  const savedDir = process.env.CLAUDE_CONFIG_DIR;
  try {
    // A fake claude/codex: `mcp get|add|remove` on a JSON file in the folder it is pointed at
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "fake.mjs"), `
      import fs from "node:fs"; import path from "node:path";
      const [kind, , verb, ...rest] = process.argv.slice(2);
      const dir = (kind === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME) || process.env.QUACK_FAKE_DEFAULT + "-" + kind;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "fake-mcp.json");
      const servers = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      const name = rest.filter((a) => !a.startsWith("--") && a !== "user")[0];
      if (verb === "get") process.exit(servers[name] ? 0 : 1);
      if (verb === "remove") delete servers[name];
      if (verb === "add") servers[name] = rest.slice(rest.indexOf("--") + 1);
      fs.writeFileSync(file, JSON.stringify(servers));
    `);
    for (const kind of ["claude", "codex"]) fs.writeFileSync(path.join(bin, `${kind}.cmd`), `@node "%~dp0fake.mjs" ${kind} %*\r\n`);
    process.env.QUACK_FAKE_DEFAULT = path.join(home, "default");

    const proxy = path.join(home, ".claude-proxy");
    fs.mkdirSync(proxy);
    fs.writeFileSync(path.join(proxy, ".claude.json"), "{}");
    fs.writeFileSync(path.join(proxy, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } }));
    fs.mkdirSync(path.join(home, ".claude-unused"));
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", ".claude.json"), "{}");
    const t3Claude = path.join(home, "t3-claude");
    fs.mkdirSync(t3Claude);
    const work = path.join(home, ".codex-work");
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, "config.toml"), "");
    const t3Settings = path.join(home, "t3.json");
    fs.writeFileSync(t3Settings, JSON.stringify({ providerInstances: {
      a: { driver: "claudeAgent", displayName: "Proxy", config: { homePath: proxy } },
      b: { driver: "claudeAgent", displayName: "Second", config: { homePath: t3Claude } },
      c: { driver: "claudeAgent", displayName: "Main", config: { homePath: "" } },
      d: { driver: "codex", config: { homePath: "", shadowHomePath: "" } },
    } }));
    // This process runs inside one of them, as a T3 session does: the default must still be the default
    process.env.CLAUDE_CONFIG_DIR = proxy;
    const clients = { home, claudeBin: path.join(bin, "claude.cmd"), codexBin: path.join(bin, "codex.cmd"), env: {}, t3Settings };
    const server = { command: process.execPath, args: ["cli.mjs", "--flavor", "official", "mcp"] };
    const run = async (...argv: string[]) => {
      const out: string[] = [];
      const code = await runControl([...argv, "--json"], {
        info: flavorInfo("official"), client: new HubClient(await freePort()), out: (l) => out.push(l), err: (l) => out.push(l),
        confirm: async () => false, interactive: false, color: false, cwd: home, openUri: async () => {}, server, clients,
      });
      return { code, clients: JSON.parse(out.join("\n")).clients as any[] };
    };
    const stored = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "fake-mcp.json"), "utf8"));

    const listed = await run("ai-clients");
    assert.deepEqual(listed.clients.map((c) => c.label), [
      "Claude Code", "Claude Code (T3 Code: Proxy, CLIProxyAPI)", "Claude Code (T3 Code: Second)", "Cursor", "Codex", "Codex (.codex-work)",
    ], "~/.claude, a folder with no .claude.json and an empty T3 home are not targets");

    const only = await run("connect-ai", `claude:${t3Claude}`);
    assert.equal(only.code, 0);
    assert.deepEqual(only.clients.filter((c) => c.connected).map((c) => c.id), [`claude:${t3Claude}`], "an id connects that folder alone");
    assert.deepEqual(stored(t3Claude).quack, ["--", process.execPath, "cli.mjs", "--flavor", "official", "mcp"].slice(1));

    const all = await run("connect-ai", "claude", "codex");
    assert.equal(all.code, 0);
    assert.deepEqual(all.clients.filter((c) => !c.connected).map((c) => c.id), ["cursor"]);
    assert.ok(stored(`${process.env.QUACK_FAKE_DEFAULT}-claude`).quack, "the default target ran without this process's CLAUDE_CONFIG_DIR");
    assert.ok(stored(proxy).quack);
    assert.ok(stored(work).quack);
    assert.ok(stored(`${process.env.QUACK_FAKE_DEFAULT}-codex`).quack);
  } finally {
    if (savedDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedDir;
    delete process.env.QUACK_FAKE_DEFAULT;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
