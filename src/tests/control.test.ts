import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { PassThrough } from "node:stream";
import { runControl, type ControlContext } from "../control/commands.js";
import { serveMcp } from "../control/mcp.js";
import { instructions, rule } from "../control/rule.js";
import { checkTool, guardAnswer } from "../control/guard.js";
import { installGuard, installRule } from "../control/connect.js";
import { flavorInfo, HubClient, type Flavor } from "../control/hubClient.js";
import { QuackHub } from "../hub/hub.js";
import { removeDir } from "./removeDir.js";
import { saveRegistry } from "../hub/registry.js";
import { Vault, type Dpapi } from "../cloud/vault.js";

/** DPAPI stand-in: reversible, never the key's own bytes on disk */
const fakeDpapi: Dpapi = {
  protect: async (b) => Buffer.from([...b].reverse().map((x) => x ^ 0x5a)),
  unprotect: async (b) => Buffer.from([...b].map((x) => x ^ 0x5a).reverse()),
};
import { buildRoblox, samplePlace } from "./rbxlFixture.js";

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
    await removeDir(tmp);
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
    await removeDir(tmp);
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

/** The eight Studio calls an AI makes most (a month of chrrxs use, 08/11/26), by the same names, then a click by path, a wait and a recording */
const STUDIO_TOOLS = ["eval_server_runtime", "eval_client_runtime", "execute_luau", "solo_playtest", "capture_screenshot", "get_runtime_logs", "simulate_keyboard_input", "set_device_simulator", "click_gui", "wait_for", "record", "inspect_gui", "verify_sync", "studio_changes", "perf_sample", "set_logpoint", "export_rbxm", "import_rbxm", "find_instances", "inspect_instance", "set_properties", "simulate_conditions", "script_tabs", "capture_devices", "test_profile", "simulate_mouse_input", "get_roblox_docs", "search_assets", "get_asset_details", "get_asset_thumbnail", "preview_asset", "insert_asset", "upload_asset", "get_memory_breakdown", "capture_script_profiler", "get_scene_analysis", "capture_micro_profiler", "get_request_status", "get_place_info", "list_place_versions", "download_place", "open_place", "selection", "generate_model", "badges", "developer_products", "game_passes", "localization", "analytics_query", "move_player", "get_universe", "update_universe", "restart_servers", "publish_message", "memory_store_sorted_map", "memory_store_queue", "flush_memory_store", "ordered_data_store", "user_restriction", "datastore", "experience_config", "cloud_permissions", "luau_run"];

test("mcp: initialize carries the instructions, and the tools are the reading ones, wait, play and the Studio tools", { timeout: 15000 }, async () => {
  const mcp = mcpSession(await freePort());
  const init = await mcp.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "quack-dev");
  assert.match(init.result.instructions, /git add/);
  assert.match(init.result.instructions, /never checkout, reset or stash/);
  const ruleVersion = rule(flavorInfo("dev")).version;
  assert.ok(init.result.instructions.includes(`quackdev rule\`, version ${ruleVersion}`), "the instructions name the rule's command and version");
  mcp.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal((await mcp.call("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion, "2025-06-18", "an unknown version gets the newest");
  const names = (await mcp.call("tools/list")).result.tools.map((t: any) => t.name);
  assert.deepEqual(names, ["status", "wait", "log", "conflicts", "conflict", "doctor", "play", ...STUDIO_TOOLS]);
  for (const mutating of ["resolve", "pause", "resume", "register", "unregister", "choose", "restart-hub", "open", "ai"]) {
    assert.ok(!names.includes(mutating), `${mutating} is a person's, not a tool`);
  }
  assert.equal((await mcp.call("tools/call", { name: "pause" })).error.code, -32602);
  assert.equal((await mcp.call("resources/list")).error.code, -32601);
  assert.deepEqual((await mcp.call("ping")).result, {});
  await mcp.close();
});

test("rule: one text for the CLI, the app and the MCP, between markers carrying a version that follows the text", async () => {
  const run = control(await freePort());
  const plain = await run("rule");
  assert.equal(plain.code, 0);
  const dev = rule(flavorInfo("dev"));
  assert.equal(plain.out, dev.text, "no hub needed");
  // Each flavor has its own markers, so Dev's rule sits next to the Official's
  assert.match(dev.text, new RegExp(`^<!-- quackdev-rule ${dev.version} -->\\n[\\s\\S]+\\n<!-- /quackdev-rule -->$`));
  assert.match(dev.version, /^[0-9a-f]{8}$/);
  // An AI that swaps the block cuts at the first end marker: the body must not hold either marker
  assert.equal(dev.text.split("<!-- /quackdev-rule -->").length, 2, "one end marker, the last line");
  assert.equal(dev.text.split("<!-- quackdev-rule").length, 2, "one start marker, the first line");
  assert.equal(rule({ ...flavorInfo("dev"), port: 1 }).version, dev.version, "the port is not part of the rule");
  const official = rule(flavorInfo("official"));
  assert.notEqual(official.version, dev.version);
  assert.match(official.text, new RegExp(`^<!-- quack-rule ${official.version} -->\\n[\\s\\S]+\\n<!-- /quack-rule -->$`));
  assert.match(official.text, /`quack --help`/);
  assert.ok(!/quackdev/.test(official.text), "Official names only its own command");
  for (const tool of ["status", "wait", "verify_sync", "conflicts", "solo_playtest", "eval_server_runtime", "execute_luau", "click_gui", "wait_for", "set_logpoint", "perf_sample", "play", "test_profile", "get_roblox_docs", "search_assets", "preview_asset", "insert_asset", "upload_asset", "capture_script_profiler", "get_memory_breakdown", "get_scene_analysis"]) {
    assert.ok(dev.text.includes(`\`${tool}\``), `the rule names ${tool}`);
  }

  const prompt = (await run("rule", "--prompt", "--json")).json();
  assert.equal(prompt.version, dev.version);
  assert.ok(prompt.text.endsWith(dev.text), "the prompt ends with the rule itself");
  assert.match(prompt.text, /replace that whole block/);

  // Claude Code cut the old instructions at ~4 KB, mid-sentence: the short form stays well under
  for (const flavor of ["official", "dev"] as const) {
    const text = instructions(flavorInfo(flavor));
    assert.ok(text.length < 3000, `${flavor} instructions are ${text.length} characters`);
    assert.ok(text.endsWith("installs or updates it."), "the pointer to the rule is the last line");
  }
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
  assert.equal(messages.find((m) => m.id === 2).result.tools.length, 7 + STUDIO_TOOLS.length);
});

test("Quack's guard refuses the vault, the approval token, DPAPI, the vault's code and automating the app, and nothing else", () => {
  const blocked: [string, Record<string, unknown>][] = [
    ["Bash", { command: "cat %APPDATA%/quack/open-cloud.key" }],
    ["PowerShell", { command: "Get-Content $env:APPDATA\\quack\\open-cloud.key" }],
    ["Bash", { command: "K=$(node -e \"require('fs').readFileSync(process.env.APPDATA+'/quack/open-cloud.key')\")" }],
    ["Bash", { command: "ALLOW_SECRET=1 type open-cloud.key" }],
    ["Bash", { command: "grep KEY ~/AppData/Roaming/quack/open-cloud.env" }],
    ["PowerShell", { command: "[Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser')" }],
    ["Bash", { command: "node --input-type=module -e 'import { Vault } from \"./dist/cloud/vault.js\"; console.log(await new Vault(d).get())'" }],
    ["Bash", { command: "node <<'EOF'\nconst { Vault } = await import('./dist/cloud/vault.js');\nconsole.log(await new Vault(dir).get());\nEOF" }],
    ["Read", { file_path: "C:\\Users\\A\\AppData\\Roaming\\quack\\open-cloud.key" }],
    ["mcp__ide__Read", { file_path: "C:/Users/A/AppData/Roaming/quack/open-cloud.key" }],
    ["Grep", { pattern: "x", path: "C:/Users/A/AppData/Roaming/quack/open-cloud.key" }],
    ["Glob", { pattern: "**/approval-token.dpapi" }],
    ["PowerShell", { command: "$w=New-Object -ComObject WScript.Shell; $w.AppActivate('Quack Dev'); $w.SendKeys('{ENTER}')" }],
    ["PowerShell", { command: "[System.Windows.Forms.SendKeys]::SendWait('{LEFT}{ENTER}') # the Quack popup" }],
    ["Bash", { command: "cat $APPDATA/dev.enderex.quack.dev/approval-token.dpapi" }],
    ["Read", { file_path: "C:\\Users\\A\\AppData\\Roaming\\dev.enderex.quack\\approval-token.dpapi" }],
    // Wildcards in the name or in the folder
    ["Bash", { command: "cat ~/AppData/Roaming/quack/open-cloud.*" }],
    ["Bash", { command: "cat ~/AppData/Roaming/dev.enderex.quack.dev/approval-token*" }],
    ["Bash", { command: "cat ~/AppData/Roaming/quack/open-c*" }],
    ["PowerShell", { command: "cd $env:APPDATA\\quack; Get-Content *" }],
    // A recursive search of the folder, or a Grep from it or above it
    ["Bash", { command: "grep -r KEY ~/AppData/Roaming/quack" }],
    ["Bash", { command: "rg . \"$APPDATA/quack/\"" }],
    ["Grep", { pattern: ".", path: "C:\\Users\\A\\AppData\\Roaming\\quack" }],
    ["Grep", { pattern: "KEY", path: "C:/Users/A/AppData/Roaming" }],
    ["Grep", { pattern: "KEY", path: "C:/Users/A" }],
    ["Grep", { pattern: "KEY", path: "C:\\" }],
    // PowerShell's encoded command is decoded and checked
    ["PowerShell", { command: "powershell -EncodedCommand WwBTAGUAYwB1AHIAaQB0AHkALgBDAHIAeQBwAHQAbwBnAHIAYQBwAGgAeQAuAFAAcgBvAHQAZQBjAHQAZQBkAEQAYQB0AGEAXQA6ADoAVQBuAHAAcgBvAHQAZQBjAHQAKAAkAGIALAAkAGUALAAnAEMAdQByAHIAZQBuAHQAVQBzAGUAcgAnACkA" }],
    ["Bash", { command: "powershell.exe -NoProfile -enc WwBTAGUAYwB1AHIAaQB0AHkALgBDAHIAeQBwAHQAbwBnAHIAYQBwAGgAeQAuAFAAcgBvAHQAZQBjAHQAZQBkAEQAYQB0AGEAXQA6ADoAVQBuAHAAcgBvAHQAZQBjAHQAKAAkAGIALAAkAGUALAAnAEMAdQByAHIAZQBuAHQAVQBzAGUAcgAnACkA" }],
    // Round 2: a recursive search from above the folders, a path spelled with "." or "..",
    // a wildcard on the folder's own name, an encoded command inside an encoded command
    ["Bash", { command: "rg --hidden --no-ignore . C:/Users/ana/AppData/Roaming" }],
    ["PowerShell", { command: "Get-ChildItem $env:APPDATA -Recurse | Select-String KEY" }],
    ["Bash", { command: "grep -rn KEY ~" }],
    ["Bash", { command: "cat C:/Users/ana/AppData/Roaming/quack*/*" }],
    ["Bash", { command: "cat ~/AppData/Roam*/q*/open*" }],
    ["Grep", { pattern: ".", path: "C:/Users/ana/AppData/Roaming/." }],
    ["Grep", { pattern: ".", path: "C:/Users/ana/Documents/../AppData/Roaming" }],
    // Round 3: every occurrence of a stem, .. inside a shell path, PowerShell's -r, a Windows
    // path to the search tool, a wildcard spelling AppData itself
    ["Read", { file_path: "C:/Users/open-cloud/AppData/Roaming/quack/open-cloud.env" }],
    ["Bash", { command: "rg --hidden . C:/Users/ana/AppData/Roaming/x/.." }],
    ["PowerShell", { command: "gci $env:APPDATA -r -file | gc" }],
    ["PowerShell", { command: "Get-ChildItem $env:APPDATA -rec | Get-Content" }],
    ["PowerShell", { command: "C:\\tools\\rg.exe --hidden --no-ignore . C:\\Users\\ana\\AppData\\Roaming" }],
    ["Bash", { command: "cat C:/Users/ana/AppDat?/Roaming/quack/*" }],
    ["Bash", { command: "cat ~/App*/Roaming/quack/open*" }],
    ["Bash", { command: "cat C:/Users/*/AppData/Roaming/dev.enderex.quack*/*" }],
    ["Bash", { command: "rg KEY ~/**/quack/*.env" }],
    // ** is zero or more folders; a wildcard naming the folder carries the files to a recursive
    // copy or an archive
    ["Bash", { command: "cat $APPDATA/quack/**/open-clou?.key" }],
    ["PowerShell", { command: "Copy-Item -Recurse $env:APPDATA/qua?k ./dump" }],
    // A value glued to its option is read too
    ["PowerShell", { command: "Copy-Item -Recurse -Path:$env:APPDATA/qua?k ./dump" }],
    // A cd by -Path, glued or not, moves where the next words run
    ["PowerShell", { command: "Set-Location -Path:$env:APPDATA/qua?k; cat *" }],
    ["PowerShell", { command: "Set-Location -LiteralPath $env:APPDATA/quack; Get-Content *" }],
    ["Bash", { command: "rg --hidden --files-from=x . --path-separator=/ --pre=cat --glob=* --type-add=x:* --iglob=* --search-zip -e x --max-depth=9 --follow --no-ignore --dir=~/AppData/Roaming/quack" }],
    ["PowerShell", { command: "Get-Content -Path:C:\\Users\\ana\\AppData\\Roaming\\quack\\open-cloud.key" }],
    ["Bash", { command: "cp -r ~/AppData/Roaming/quack* /tmp/x" }],
    ["Bash", { command: "tar czf x.tgz ~/AppData/Roaming/*" }],
    ["Bash", { command: "tar czf q.tgz ~/AppData/Roaming/quack" }],
    ["PowerShell", { command: "Get-Content C:\\Users\\ana\\AppData\\Roaming\\quack\\*" }],
    ["PowerShell", { command: "Get-Content $env:APPDATA\\quack\\*" }],
    ["PowerShell", { command: "powershell -enc cABvAHcAZQByAHMAaABlAGwAbAAgAC0AZQBuAGMAIABXAHcAQgBUAEEARwBVAEEAWQB3AEIAMQBBAEgASQBBAGEAUQBCADAAQQBIAGsAQQBMAGcAQgBEAEEASABJAEEAZQBRAEIAdwBBAEgAUQBBAGIAdwBCAG4AQQBIAEkAQQBZAFEAQgB3AEEARwBnAEEAZQBRAEEAdQBBAEYAQQBBAGMAZwBCAHYAQQBIAFEAQQBaAFEAQgBqAEEASABRAEEAWgBRAEIAawBBAEUAUQBBAFkAUQBCADAAQQBHAEUAQQBYAFEAQQA2AEEARABvAEEAVgBRAEIAdQBBAEgAQQBBAGMAZwBCAHYAQQBIAFEAQQBaAFEAQgBqAEEASABRAEEASwBBAEEAawBBAEcASQBBAEwAQQBBAGsAQQBHAFUAQQBMAEEAQQBuAEEARQBNAEEAZABRAEIAeQBBAEgASQBBAFoAUQBCAHUAQQBIAFEAQQBWAFEAQgB6AEEARwBVAEEAYwBnAEEAbgBBAEMAawBBAA==" }],
  ];
  const allowed: [string, Record<string, unknown>][] = [
    ["PowerShell", { command: "$w=New-Object -ComObject WScript.Shell; $w.AppActivate('Roblox Studio'); $w.SendKeys('%p')" }],
    ["Bash", { command: "quackdev cloud check" }],
    ["Bash", { command: "quackdev datastore get PlayerData 123 PA" }],
    ["Bash", { command: "npm test" }],
    ["Bash", { command: "git add src/cloud/vault.ts src/cloud/ops.ts" }],
    ["Bash", { command: "npx tsc -p . && node --test dist/tests/roblox.test.js" }],
    // Quack's own source names these files: editing it stays possible
    ["Write", { file_path: "src/cloud/vault.ts", content: "export const VAULT_FILE = \"open-cloud.key\";" }],
    ["Edit", { file_path: "src/control/guard.ts", old_string: "approval-token.dpapi", new_string: "x" }],
    ["Read", { file_path: "src/cloud/vault.ts" }],
    ["Agent", { prompt: "cat open-cloud.key" }],
    ["Bash", { command: "cat ~/AppData/Roaming/quack/hub.json" }],
    ["Bash", { command: "ls ~/AppData/Roaming/quack" }],
    ["Bash", { command: "grep -rn open-cloud src/cloud" }],
    ["Grep", { pattern: "Vault", path: "E:/Documents/Dev/Quack" }],
    ["Grep", { pattern: "Vault" }],
    ["Grep", { pattern: "Vault", path: "src" }],
    ["Bash", { command: "rg Vault src/cloud" }],
    ["Bash", { command: "grep -rn KEY ./src" }],
    ["Bash", { command: "ls ~/AppData/Local/Roblox/logs" }],
    // A search pattern is not a path, and /s is an option, not a drive
    ["Bash", { command: "rg 'AppData.*' src" }],
    ["Bash", { command: "findstr /s /i Vault src\\*.ts" }],
    ["Bash", { command: "cmd /c dir /s src" }],
    ["PowerShell", { command: "Remove-Item dist -Force -ErrorAction SilentlyContinue" }],
    ["Bash", { command: "ls ~/AppData/Local/Roblox/logs/*.log" }],
    // An escaped wildcard is literal text, never the root "/*" (it blocked a real session, 10/11/26)
    ["Bash", { command: "head -30 x.mjs | grep -E \"^//|^ \\*|spawn|import\"" }],
    ["Bash", { command: "grep -n \"a\\?b\" src/x.ts" }],
    // A wildcard that cannot reach Quack's files: a code comment, the root, a home's top folder
    ["Bash", { command: "cat > x.js <<'EOF'\n/* a comment */\nconst a = 1;\nEOF" }],
    ["Bash", { command: "git commit -m \"the root /* is no wildcard here\"" }],
    ["Bash", { command: "ls ~/* /*" }],
    ["Bash", { command: "cat ~/AppData/Roaming/Code/User/*.json" }],
    ["Bash", { command: "tar xzf build.tgz -C dist" }],
    ["Bash", { command: "cp -r src/* dist" }],
    ["Bash", { command: "zip -r out.zip src" }],
    ["PowerShell", { command: "powershell -EncodedCommand RwBlAHQALQBQAHIAbwBjAGUAcwBzACAAcQB1AGEAYwBrAC0AYQBwAHAA" }],
  ];
  for (const [tool, input] of blocked) assert.ok(checkTool(tool, input), `${tool} ${JSON.stringify(input)} should be blocked`);
  for (const [tool, input] of allowed) assert.equal(checkTool(tool, input), undefined, `${tool} ${JSON.stringify(input)} should pass`);

  // The hook's answer, as Claude Code reads it
  const deny = JSON.parse(guardAnswer(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x/open-cloud.key" } })));
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /quack-vault-file/);
  assert.equal(guardAnswer(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } })), "{}");
  assert.equal(guardAnswer("not json"), "{}");
  assert.equal(guardAnswer("null"), "{}", "JSON that is not an object answers, never throws");
  // A long command of near misses answers, and in time linear in its length: the time for 4x the
  // words stays far from the 16x a pattern that backtracks would take. A ratio, not a budget in
  // ms, so a slow machine (the release's runner took 625 ms for all of these) cannot fail it
  const near = [
    (n: number) => "node Vault ".repeat(n),
    (n: number) => "Quack ".repeat(n),
    (n: number) => "open-cloud".repeat(n),
    (n: number) => "approval-token".repeat(n),
    (n: number) => `rg x ${"/.".repeat(n)}x`,
    (n: number) => "-r ".repeat(n) + "x",
    (n: number) => "cat " + "[".repeat(n),
  ];
  const timeOf = (command: string) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const at = performance.now();
      checkTool("Bash", { command });
      best = Math.min(best, performance.now() - at);
    }
    return best;
  };
  for (const make of near) {
    const small = Math.max(timeOf(make(5000)), 2);
    const large = timeOf(make(20000));
    assert.ok(large / small < 9, `${make(2).slice(0, 20)}: ${large.toFixed(1)} ms for 4x the words of ${small.toFixed(1)} ms`);
  }
  assert.equal(checkTool("Bash", { command: "node Vault ".repeat(20000) }), undefined);
  assert.equal(checkTool("Bash", { command: "Quack ".repeat(20000) }), undefined);
  assert.equal(checkTool("Bash", { command: "open-cloud".repeat(20000) }), undefined);
  assert.equal(checkTool("Bash", { command: "approval-token".repeat(20000) }), undefined);
  assert.equal(checkTool("Bash", { command: `rg x ${"/.".repeat(20000)}x` }), undefined);
  // A session's folder counts as where a Grep without a path starts
  assert.ok(checkTool("Grep", { pattern: "." }, "C:/Users/ana/AppData/Roaming/quack"));
  // A shell command runs in the session's folder, or where a cd took it
  assert.ok(checkTool("Bash", { command: "rg --hidden --no-ignore ." }, "C:/Users/ana/AppData/Roaming"));
  assert.ok(checkTool("Bash", { command: "cat quack*/*" }, "C:/Users/ana/AppData/Roaming"));
  assert.ok(checkTool("Bash", { command: "cd C:/Users/ana/AppData/Roaming && cat quack*/*" }));
  // A glued value is never a cd of its own: run in the vault's folder, the cat * still counts there
  assert.ok(checkTool("Bash", { command: "echo '--x=cd' C:/Windows; cat *" }, "C:/Users/ana/AppData/Roaming/quack"));
  assert.equal(checkTool("Bash", { command: "rg --hidden ." }, "E:/projects/game"), undefined);
  assert.equal(checkTool("Bash", { command: "-r ".repeat(20000) + "x" }), undefined);

  // The built file a tool call starts, end to end
  const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "control", "guardMain.js");
  const out = execFileSync(process.execPath, [main], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "type open-cloud.key" } }), encoding: "utf8" });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

test("installGuard keeps every other hook and key, replaces its own entry, and never writes over a broken file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-guard-"));
  try {
    const file = path.join(dir, "settings.json");
    const other = { matcher: "Bash", hooks: [{ type: "command", command: "node mine.cjs" }] };
    fs.writeFileSync(file, JSON.stringify({ model: "x", hooks: { PreToolUse: [other], Stop: [{ hooks: [] }] } }));
    const guard = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Quack Dev\\guard.mjs"] };
    installGuard(file, "quack-dev", guard);
    installGuard(file, "quack-dev", guard);
    installGuard(file, "quack", guard);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(written.model, "x");
    assert.deepEqual(written.hooks.Stop, [{ hooks: [] }]);
    assert.deepEqual(written.hooks.PreToolUse[0], other);
    assert.equal(written.hooks.PreToolUse.length, 3, "one entry per flavor, a second connect replaces it");
    assert.equal(written.hooks.PreToolUse[1].hooks[0].command, '"C:/Program Files/nodejs/node.exe" "C:/Quack Dev/guard.mjs" --quack-guard quack-dev');
    fs.writeFileSync(file, "{ broken");
    assert.throws(() => installGuard(file, "quack-dev", guard), /JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ broken");
    const fresh = path.join(dir, "new", "settings.json");
    installGuard(fresh, "quack", guard);
    assert.equal(JSON.parse(fs.readFileSync(fresh, "utf8")).hooks.PreToolUse.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("installRule puts the rule in CLAUDE.md or AGENTS.md, replaces an older copy where the user keeps it, and touches nothing else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-rule-"));
  try {
    const official = flavorInfo("official");
    const dev = flavorInfo("dev");
    const current = rule(official);
    // A new folder: the file is made with the rule alone
    installRule(path.join(dir, "fresh"), "claude", official);
    assert.equal(fs.readFileSync(path.join(dir, "fresh", "CLAUDE.md"), "utf8"), `${current.text}\n`);

    // An instructions file with the user's own text: the rule goes at the end, the text stays
    const claude = path.join(dir, "claude");
    fs.mkdirSync(claude);
    fs.writeFileSync(path.join(claude, "CLAUDE.md"), "# Mine\r\n\r\nKeep this.\r\n");
    installRule(claude, "claude", official);
    installRule(claude, "claude", official);
    const written = fs.readFileSync(path.join(claude, "CLAUDE.md"), "utf8");
    assert.ok(written.startsWith("# Mine\r\n\r\nKeep this.\r\n\r\n<!-- quack-rule "), "appended after a blank line, the user's text first");
    assert.equal(written.split("<!-- quack-rule ").length, 2, "a second connect replaces, never adds");
    assert.ok(!/[^\r]\n/.test(written), "the file's CRLF is kept");

    // Dev's rule sits next to the Official's
    installRule(claude, "claude", dev);
    const both = fs.readFileSync(path.join(claude, "CLAUDE.md"), "utf8");
    assert.equal(both.split("<!-- quack-rule ").length, 2);
    assert.equal(both.split("<!-- quackdev-rule ").length, 2);

    // An older copy the user keeps in a rule file of their own is replaced there, and only there
    const packs = path.join(dir, "packs");
    fs.mkdirSync(path.join(packs, "rules-packs"), { recursive: true });
    fs.mkdirSync(path.join(packs, "projects", "x"), { recursive: true });
    fs.writeFileSync(path.join(packs, "CLAUDE.md"), "# Global\n");
    const old = "---\nfrom: Quack\n---\n<!-- quack-rule 00000000 -->\nold text\n<!-- /quack-rule -->\nafter\n";
    fs.writeFileSync(path.join(packs, "rules-packs", "quack.md"), old);
    fs.writeFileSync(path.join(packs, "projects", "x", "log.md"), "<!-- quack-rule 11111111 -->\nnot a rule file\n<!-- /quack-rule -->\n");
    installRule(packs, "claude", official);
    assert.equal(fs.readFileSync(path.join(packs, "CLAUDE.md"), "utf8"), "# Global\n", "no second copy in CLAUDE.md");
    assert.equal(fs.readFileSync(path.join(packs, "rules-packs", "quack.md"), "utf8"), `---\nfrom: Quack\n---\n${current.text}\nafter\n`);
    assert.match(fs.readFileSync(path.join(packs, "projects", "x", "log.md"), "utf8"), /11111111/, "a client's own data is never searched");

    // Codex: AGENTS.md; Cursor has no rules file
    installRule(path.join(dir, "codex"), "codex", official);
    assert.ok(fs.readFileSync(path.join(dir, "codex", "AGENTS.md"), "utf8").includes(current.text));
    installRule(path.join(dir, "cursor"), "cursor", official);
    assert.equal(fs.existsSync(path.join(dir, "cursor")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    const server = { command: process.execPath, args: ["cli.mjs", "--flavor", "official", "mcp"], guard: { command: process.execPath, args: ["C:\\Quack\\guard.mjs"] } };
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
    // Quack's guard goes in each Claude Code folder's settings.json, next to what was there
    const settings = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.equal(settings(proxy).env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8317", "the folder's own settings stay");
    for (const dir of [proxy, t3Claude, path.join(home, ".claude")]) {
      const entries = settings(dir).hooks.PreToolUse;
      assert.equal(entries.length, 1, dir);
      assert.match(entries[0].hooks[0].command, /"C:\/Quack\/guard\.mjs" --quack-guard quack$/);
      assert.match(entries[0].matcher, /Bash/);
    }
    assert.equal(fs.existsSync(path.join(work, "settings.json")), false, "Codex gets no Claude Code hook");
    assert.ok(all.clients.filter((c) => c.client === "claude").every((c) => c.guarded), "ai-clients reads the guard back");
    // and the rule in each Claude Code folder's CLAUDE.md and each Codex folder's AGENTS.md
    const officialRule = rule(flavorInfo("official")).text;
    for (const file of [path.join(proxy, "CLAUDE.md"), path.join(t3Claude, "CLAUDE.md"), path.join(home, ".claude", "CLAUDE.md"), path.join(work, "AGENTS.md"), path.join(home, ".codex", "AGENTS.md")]) {
      assert.ok(fs.readFileSync(file, "utf8").includes(officialRule), file);
    }
    assert.ok(all.clients.filter((c) => c.client !== "cursor").every((c) => c.rule === "current"), "ai-clients reads the rule back");
  } finally {
    if (savedDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedDir;
    delete process.env.QUACK_FAKE_DEFAULT;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** A fake Studio whose edit DataModel and play peers answer Quack's tool calls, as the plugin does */
function toolStudio(port: number, placeId: number, handler: (role: string, tool: string, args: any) => unknown) {
  const reply = (ws: WebSocket, role: string) => ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "toolRequest") return;
    Promise.resolve().then(() => handler(role, message.tool, message.args)).then(
      (result) => ws.send(JSON.stringify({ type: "toolResult", id: message.id, ok: true, result })),
      (error) => ws.send(JSON.stringify({ type: "toolResult", id: message.id, ok: false, error: (error as Error).message })),
    );
  });
  const studio = fakeStudio(port, placeId, "ToolScript");
  reply(studio.ws, "edit");
  const peers: WebSocket[] = [];
  const play = async (role: "server" | "client") => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio-output?placeId=${placeId}`);
    reply(ws, role);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "peerHello", source: role, log: false }));
    peers.push(ws);
    return ws;
  };
  return { studio, play, close: () => [studio.ws, ...peers].forEach((ws) => ws.terminate()) };
}

test("Studio tools: the terminal and the MCP reach the play peers and edit mode through the hub, and say why when they cannot", { timeout: 60000 }, async () => {
  await withHub(async ({ port, folders }) => {
    const pixels = Buffer.alloc(2 * 2 * 4, 200);
    const fake = toolStudio(port, 111, (role, tool, args) => {
      if (tool === "eval" && args.code.startsWith("local __quack_w")) return { ok: true, values: ["true", "ready"], output: [] };
      if (tool === "click") return { path: `Players.Ender.${args.path}`, method: "input", x: 1, y: 2, screen: { width: 10, height: 10 }, activated: true, mouseButton1Click: false, ms: 5 };
      if (tool === "captureBurst") return { frames: [{ at: 0, contentId: "rbxtemp://1" }, { at: 200, contentId: "rbxtemp://2" }], asked: 2, seconds: 0.4, gameFps: 60 };
      if (tool === "eval" || tool === "exec") {
        if (args.code.includes("boom")) return { ok: false, error: "eval:1: boom", output: ["before"] };
        return { ok: true, values: [`${role}: ${args.code}`], output: ["printed"] };
      }
      if (tool === "captureBegin") return { contentId: "rbxtemp://1" };
      if (tool === "captureRead") return { width: 2, height: 2, data: pixels.toString("base64") };
      if (tool === "gui") return { root: args.path ?? "StarterGui", nodes: [], truncated: false };
      throw new Error(`${tool} is not faked`);
    });
    const run = control(port, { cwd: path.join(folders["111"], "sync") });
    await waitFor(async () => (await run("status", "--json")).json().sessions[0]?.instances === 3);

    // gui: a dotted argument no place answers to is the path; a place's name is the place
    const byPath = await run("gui", "StarterGui.Shop");
    assert.equal(byPath.code, 0, byPath.err);
    assert.match(byPath.out, /^StarterGui\.Shop \(edit mode/);
    const byPlace = await run("gui", "alpha", "--json");
    assert.equal(byPlace.code, 0, byPlace.err);
    assert.equal(byPlace.json().root, "StarterGui");
    assert.match((await run("gui", "StarterGui.Shop", "beta")).err, /Beta Game \(222\)/, "path then place: the place named, not the folder's");

    const exec = await run("exec", "--code=return 1");
    assert.equal(exec.code, 0, exec.err);
    assert.equal(exec.out, "printed\n=> edit: return 1\n" + exec.out.split("\n").at(-1));
    assert.match(exec.out, /ms in the edit plugin\)$/);

    const noPlay = await run("eval-server", "--code=return 1");
    assert.equal(noPlay.code, 1);
    assert.match(noPlay.err, /^Alpha Game \(111\): no play is running in this place/);
    assert.match((await run("eval-server")).err, /give the Luau as --code=<luau> or --file <path>/);

    await fake.play("server");
    await waitFor(async () => (await run("eval-server", "--code=x")).code === 0);
    const failed = await run("eval-server", "--code=error('boom')");
    assert.equal(failed.code, 1);
    assert.equal(failed.out, "before");
    assert.equal(failed.err, "Luau error in the play server: eval:1: boom");
    assert.match((await run("eval-client", "--code=x")).err, /the play client is not connected/);

    // The MCP: code that starts with "--" is the code, not an option; the place comes from the folder
    const mcp = mcpSession(port, path.join(folders["111"], "sync"));
    const evaluated = await mcp.tool("eval_server_runtime", { code: "-- a comment\nreturn 2" });
    assert.equal(evaluated.isError, undefined, evaluated.content[0].text);
    assert.match(evaluated.content[0].text, /^printed\n=> server: -- a comment\nreturn 2\n\(\d+ ms in the play server\)$/);
    assert.match((await mcp.tool("eval_client_runtime", { code: "x", place: "alpha" })).content[0].text, /the play client is not connected/);
    assert.match((await mcp.tool("execute_luau", {})).content[0].text, /code is required/);

    const runMode = await mcp.tool("capture_screenshot", {});
    assert.equal(runMode.isError, true);
    assert.match(runMode.content[0].text, /^Alpha Game \(111\): the play client is not connected.*a screenshot needs a Play-mode play/);

    await fake.play("client");
    await waitFor(async () => (await run("eval-client", "--code=x")).code === 0);
    const shot = await mcp.tool("capture_screenshot", {});
    assert.equal(shot.isError, undefined, shot.content[0].text);
    assert.match(shot.content[0].text, /^Screenshot of the play client: 2x2, \d+ ms\. Saved at .*\.png$/);
    assert.equal(shot.content[1].type, "image");
    assert.equal(shot.content[1].mimeType, "image/png");
    assert.equal(Buffer.from(shot.content[1].data, "base64").subarray(1, 4).toString(), "PNG");

    const logs = await mcp.tool("get_runtime_logs", { tail: 5 });
    assert.match(logs.content[0].text, /--- play started ---\ncursor: \d+$/);
    assert.match((await mcp.tool("get_runtime_logs", { cursor: "x1" })).content[0].text, /cursor must be/);
    assert.match((await mcp.tool("simulate_keyboard_input", {})).content[0].text, /keyCode or text is required/);
    assert.match((await mcp.tool("solo_playtest", { action: "pause" })).content[0].text, /action must be start, stop or status/);

    // A click by path, a wait and a recording
    const clicked = await run("click", "PlayerGui.Shop.Buy");
    assert.equal(clicked.code, 0, clicked.err);
    assert.match(clicked.out, /^Players\.Ender\.PlayerGui\.Shop\.Buy: clicked at \(1, 2\) on a 10x10 screen; Activated fired \(\d+ ms\)\.$/);
    assert.match((await mcp.tool("click_gui", {})).content[0].text, /path is required/);
    const waited = await mcp.tool("wait_for", { code: "workspace.Ready" });
    assert.equal(waited.isError, undefined, waited.content[0].text);
    assert.match(waited.content[0].text, /^Truthy after \d+ ms, 1 try in the play server: => ready\ncursor: \d+$/);
    assert.match((await mcp.tool("wait_for", {})).content[0].text, /code or pattern is required/);
    const missed = await run("wait-for", "--pattern=never printed", "--timeout", "0.3");
    assert.equal(missed.code, 3, "a deadline that passes exits as a timeout");
    assert.match(missed.err, /^Not met in 0\.\d s \(0 tries\)\.$/);
    const rec = await mcp.tool("record", { seconds: 1 });
    assert.equal(rec.isError, undefined, rec.content[0].text);
    assert.match(rec.content[0].text, /^Recorded 2 frames of the play client in 0\.4 s: 5 fps real \(asked 5; the game drew 60 fps meanwhile\), 2x2 GIF, .* GIF: .*\.gif Sheet: .*-sheet\.png\. The sheet shows the frames at 0\.0, 0\.2 s\.$/);
    assert.equal(rec.content[1].type, "image");
    assert.equal(Buffer.from(rec.content[1].data, "base64").subarray(1, 4).toString(), "PNG");
    await mcp.close();
    fake.close();
  });
});

test("Studio tools on assets, memory, the profiler and scene analysis: the terminal and the MCP reach the right peer through the hub, and a refusal comes before Studio", { timeout: 60000 }, async () => {
  await withHub(async ({ port, folders }) => {
    const seen: { role: string; tool: string; args: any }[] = [];
    const fake = toolStudio(port, 111, async (role, tool, args) => {
      seen.push({ role, tool, args });
      if (tool === "assetInsert") return { assetId: args.assetId, parent: "Workspace", inserted: [{ path: "Workspace.Tree", className: "Model" }], removedScripts: [], removedPackageLinks: [], moved: args.position };
      if (tool === "memory") return { totalMb: 800, trackingEnabled: true, tags: [{ tag: "Script", mb: 12 }] };
      if (tool === "scene") {
        await wait(300);
        return { order: ["script_memory"], modes: { script_memory: { method: "GetScriptMemoryAsync", ms: 300, root: { leaves: 1 }, top: [{ name: "Main", size: 4.5 }] } } };
      }
      if (tool === "profiler") return { durationMs: args.durationMs, frequency: 1000, counted: 1, kept: 1, omitted: {}, functions: [] };
      throw new Error(`${tool} is not faked`);
    });
    const run = control(port, { cwd: path.join(folders["111"], "sync") });
    await waitFor(async () => (await run("status", "--json")).json().sessions[0]?.instances === 3);

    const inserted = await run("asset", "insert", "123", "--at=-5,0,2.5", "--parent", "Workspace");
    assert.equal(inserted.code, 0, inserted.err);
    assert.deepEqual(seen.at(-1), { role: "edit", tool: "assetInsert", args: { assetId: 123, parent: "Workspace", position: [-5, 0, 2.5] } });
    assert.match(inserted.out, /^Inserted Workspace\.Tree \(Model\) under Workspace at -5, 0, 2\.5, one undo step/);
    assert.match((await run("asset", "insert", "123", "--at=1,2")).err, /--at is <x>,<y>,<z>/);
    const mem = await run("memory");
    assert.equal(mem.code, 0, mem.err);
    assert.equal(mem.out, "edit: 800 MB in all; Script 12");
    const scene = await run("scene", "--mode", "script_memory", "--json");
    assert.equal(scene.code, 0, scene.err);
    assert.equal(scene.json().modes.script_memory.top[0].name, "Main");
    assert.match((await run("profiler")).err, /no play is running/);

    const mcp = mcpSession(port, path.join(folders["111"], "sync"));
    const insert = await mcp.tool("insert_asset", { assetId: 7, position: { x: -1, y: 2, z: -3 } });
    assert.equal(insert.isError, undefined, insert.content[0].text);
    assert.deepEqual(seen.at(-1)!.args.position, [-1, 2, -3]);
    await fake.play("server");
    await waitFor(async () => (await run("memory", "--peer", "server")).code === 0);
    const profiled = await mcp.tool("capture_script_profiler", { durationMs: 300 });
    assert.equal(profiled.isError, undefined, profiled.content[0].text);
    assert.equal(seen.at(-1)!.role, "server");
    assert.equal(seen.at(-1)!.args.durationMs, 300);
    assert.match(profiled.content[0].text, /^the play server: 300 ms at 1000 samples a second/);
    assert.match((await mcp.tool("get_scene_analysis", { mode: "nope" })).content[0].text, /mode must be all or one of the six breakdowns/);
    await mcp.close();
    fake.close();
  });
});

test("import: the terminal and the MCP read a place file with no Studio call, then send only the paths asked for, and say what came and what stayed out", { timeout: 60000 }, async () => {
  await withHub(async ({ port, folders }) => {
    const seen: { role: string; tool: string; args: any }[] = [];
    const fake = toolStudio(port, 111, (role, tool, args) => {
      seen.push({ role, tool, args });
      if (tool === "importPicks") return { placed: args.picks.map((p: any) => `${p.into}.${p.names.at(-1)} (${p.className})`), scripts: 1, alreadyThere: [] };
      throw new Error(`${tool} is not faked`);
    });
    const run = control(port, { cwd: path.join(folders["111"], "sync") });
    await waitFor(async () => (await run("status", "--json")).json().sessions[0]?.instances === 3);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-import-"));
    const file = path.join(dir, "v84.rbxl");
    fs.writeFileSync(file, buildRoblox(samplePlace()));

    const listed = await run("import", file, "--list");
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, /^A place of 20 instances\.\nTop-level items \(each service's children\): 7\n {2}Workspace\.MapA \(Model\): 2 below, 1 script\(s\)/);
    assert.match(listed.out, /Scripts: 3\n {2}Workspace\.MapA\.Door \(Script\)/);
    assert.equal(seen.length, 0, "list calls no Studio");

    const refused = await run("import", file, "--paths", "Workspace.MapA,StarterGui.Shop");
    assert.equal(refused.code, 1);
    assert.match(refused.err, /what you picked holds 1 script\(s\).*Workspace\.MapA\.Door \(Script\)/);
    const done = await run("import", file, "--paths", "Workspace.MapA,StarterGui.Shop", "--scripts");
    assert.equal(done.code, 0, done.err);
    assert.deepEqual(seen.at(-1)!.args.picks.map((p: any) => p.into), ["Workspace", "StarterGui"]);
    assert.match(done.out, /^Put Workspace\.MapA \(Model\), StarterGui\.Shop \(ScreenGui\) in the place; its 1 script\(s\) sync to disk/);
    assert.match(done.out, /\nLeft out of the file: Workspace\.My\.Map, Workspace\.Baseplate, ReplicatedStorage\.Config, StarterPlayer\.StarterPlayerScripts, Lighting\.Sky\nScripts that came: Workspace\.MapA\.Door \(Script\)/);

    const mcp = mcpSession(port, path.join(folders["111"], "sync"));
    const viaMcp = await mcp.tool("import_rbxm", { file, paths: ["Workspace.My.Map"] });
    assert.equal(viaMcp.isError, undefined, viaMcp.content[0].text);
    assert.deepEqual(seen.at(-1)!.args.picks, [{ names: ["Workspace", "My.Map"], className: "Model", count: 1, into: "Workspace" }]);
    assert.match((await mcp.tool("import_rbxm", { file, list: true })).content[0].text, /^A place of 20 instances/);
    assert.match((await mcp.tool("import_rbxm", { file, paths: ["A,B"] })).content[0].text, /paths must be a list of paths in the file, none with a comma/);
    await mcp.close();
    fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// What only chrrxs had (09/11/26): the MicroProfiler, a timed-out call's answer, the place, the
// selection, model generation, opening a place file
test("Studio tools chrrxs alone had: micro, result, place info, selection and generate reach the right peer; a refusal comes before Studio", { timeout: 60000 }, async () => {
  await withHub(async ({ port, folders }) => {
    const seen: { role: string; tool: string; args: any }[] = [];
    let slowExec: Promise<void> | undefined;
    const fake = toolStudio(port, 111, async (role, tool, args) => {
      seen.push({ role, tool, args });
      if (tool === "playState") return { editModeActive: true };
      if (tool === "exec") {
        if (slowExec) await slowExec;
        return { ok: true, values: ["7"], output: ["late print"] };
      }
      if (tool === "micro") {
        return {
          durationMs: args.durationMs, bytes: 1000, sort: args.sort,
          frames: { count: 60, firstId: 1, lastId: 60, msAvg: 16.7, msP50: 16.6, msP90: 17, msP99: 33, msMax: 40, over50ms: 0, slowest: [{ id: 12, absoluteId: 9012, ms: 40 }] },
          timers: [{ rank: 1, name: "Physics", group: "Physics", selfMsPerFrame: 2.5, inclusiveMsPerFrame: 4, maxFrameMs: 9, calls: 60 }],
          groups: [{ name: "Physics", selfMsPerFrame: 2.5, pct: 40 }], threads: [{ name: "Main", busyMsPerFrame: 10 }], steps: 1000,
        };
      }
      if (tool === "placeInfo") return { placeId: 111, gameId: 9, creatorId: 5, creatorType: "User", placeVersion: 85, dataModelName: "Alpha", name: "Alpha Game", editMode: true, streamingEnabled: false, gravity: 196.2 };
      if (tool === "selection") {
        if (args.action === "view") return { action: "view", framed: 1, center: [0, 5, 0], size: [4, 4, 4], camera: [10, 10, 10], distance: 12 };
        return { action: args.action, selected: (args.paths ?? ["Workspace.Part"]).map((p: string) => ({ path: p, className: "Part" })), count: (args.paths ?? ["x"]).length };
      }
      if (tool === "generate") return { path: `Workspace.${args.name ?? "GeneratedModel"}`, seconds: 118, parts: [{ name: "body_geom", size: [4, 4, 4], meshId: "rbxassetid://1" }], size: [4, 4, 4] };
      throw new Error(`${tool} is not faked`);
    });
    const run = control(port, { cwd: path.join(folders["111"], "sync") });
    await waitFor(async () => (await run("status", "--json")).json().sessions[0]?.instances === 3);

    // micro: edit mode with no play; the focus goes as --mode
    const profiled = await run("micro", "--ms", "300", "--mode", "physics");
    assert.equal(profiled.code, 0, profiled.err);
    assert.deepEqual([seen.at(-1)!.role, seen.at(-1)!.tool, seen.at(-1)!.args.durationMs, seen.at(-1)!.args.focus], ["edit", "micro", 300, "physics"]);
    // No frames asked: the plugin reads the ones that cover durationMs, not the whole buffer (in PA
    // a default of 256 took in an earlier capture's frames)
    assert.equal(seen.at(-1)!.args.frames, undefined);
    assert.ok((await run("micro", "--frames", "40")).code === 0 && seen.at(-1)!.args.frames === 40);
    assert.match(profiled.out, /^MicroProfiler in the edit plugin for 300 ms: 60 frames .* p99 33, max 40; 0 over 50 ms\nSlowest frames: 40 ms \(id 12, absolute 9012\)/);
    assert.match(profiled.out, /  1\.      2\.5 \/        4 \/       9 \/     60  Physics \[Physics\]/);
    assert.match((await run("micro", "--out", "x.json")).err, /--out must be a \.mpz file/);
    assert.match((await run("micro", "--ms", "9000")).err, /durationMs must be a whole number from 100 to 5000/);

    // place info and the selection
    const info = await run("place", "info");
    assert.equal(info.code, 0, info.err);
    assert.match(info.out, /^Alpha Game \(place 111, experience 9\), version 85, owned by user 5\nStudio is in edit mode/);
    const set = await run("selection", "set", "Workspace.A,Workspace.B", "--mode", "add");
    assert.equal(set.code, 0, set.err);
    assert.deepEqual(seen.at(-1)!.args, { action: "set", paths: ["Workspace.A", "Workspace.B"], mode: "add" });
    assert.match(set.out, /^2 selected:\n  Workspace\.A \(Part\)/);
    const view = await run("selection", "view", "Workspace.Map", "--from=-90", "--angle", "20");
    assert.equal(view.code, 0, view.err);
    assert.deepEqual([seen.at(-1)!.args.path, seen.at(-1)!.args.from, seen.at(-1)!.args.angleY], ["Workspace.Map", -90, 20]);
    assert.match((await run("selection", "view", "--angle", "120")).err, /angleY must be a number from -89 to 89/);

    // generate: the prompt, the size and where it goes
    const made = await run("generate", "a wooden crate", "--size", "4,4,4", "--name", "Crate");
    assert.equal(made.code, 0, made.err);
    assert.deepEqual([seen.at(-1)!.args.prompt, seen.at(-1)!.args.size, seen.at(-1)!.args.name], ["a wooden crate", [4, 4, 4], "Crate"]);
    assert.match(made.out, /^Generated Workspace\.Crate in 118 s: 1 mesh part\(s\), 4 x 4 x 4 studs; anchored, one undo step, selected\./);
    assert.match((await run("generate")).err, /usage: generate <prompt>/);
    assert.match((await run("generate", "x", "--size", "1,2")).err, /--size must be <x>,<y>,<z>/);

    // result: a timed-out exec's answer, read after it came
    let release!: () => void;
    slowExec = new Promise<void>((r) => (release = r));
    const timedOut = await run("exec", "--code=return 7", "--timeout", "0.5");
    assert.equal(timedOut.code, 1);
    const id = /Request ([0-9a-f]{12})/.exec(timedOut.err)?.[1];
    assert.ok(id, timedOut.err);
    assert.match((await run("result", id!)).out, new RegExp(`^Request ${id} \\(exec to the edit plugin\\): no answer yet`));
    release();
    slowExec = undefined;
    await waitFor(async () => (await run("result", id!, "--json")).json().state === "answered");
    assert.match((await run("result", id!)).out, new RegExp(`^Request ${id} \\(exec to the edit plugin\\): answered, \\d+ s after its timeout\\.\\nlate print\\n=> 7$`));
    assert.match((await run("result", "0123456789ab")).out, /^Request 0123456789ab: unknown/);

    // The MCP: the same tools by chrrxs's names
    const mcp = mcpSession(port, path.join(folders["111"], "sync"));
    const micro = await mcp.tool("capture_micro_profiler", { focus: "render", sort: "inclusive", durationMs: 200 });
    assert.equal(micro.isError, undefined, micro.content[0].text);
    assert.deepEqual([seen.at(-1)!.args.focus, seen.at(-1)!.args.sort, seen.at(-1)!.args.durationMs], ["render", "inclusive", 200]);
    assert.match((await mcp.tool("capture_micro_profiler", { focus: "gpu" })).content[0].text, /focus must be all, script/);
    assert.match((await mcp.tool("get_request_status", { id })).content[0].text, /answered/);
    assert.match((await mcp.tool("get_place_info", {})).content[0].text, /^Alpha Game \(place 111/);
    const cleared = await mcp.tool("selection", { action: "set", paths: [] });
    assert.equal(cleared.isError, undefined, cleared.content[0].text);
    assert.deepEqual(seen.at(-1)!.args.paths, []);
    assert.match((await mcp.tool("selection", { action: "view", path: "Map" })).content[0].text, /path must be an instance path/);
    const generated = await mcp.tool("generate_model", { prompt: "-- a crate starting with dashes", position: [1, 2, 3] });
    assert.equal(generated.isError, undefined, generated.content[0].text);
    assert.deepEqual([seen.at(-1)!.args.prompt, seen.at(-1)!.args.position], ["-- a crate starting with dashes", [1, 2, 3]]);
    assert.match((await mcp.tool("generate_model", {})).content[0].text, /give a prompt, an image, or both/);
    assert.match((await mcp.tool("open_place", { file: "C:\\x.txt" })).content[0].text, /file must be an \.rbxl/);
    await mcp.close();
    fake.close();
  });
});

test("move and a live find: the terminal and the MCP reach the play through the hub, a position that starts with - goes as --at=, and a refusal comes before Studio", { timeout: 60000 }, async () => {
  await withHub(async ({ port, folders }) => {
    const seen: { role: string; tool: string; args: any }[] = [];
    const fake = toolStudio(port, 111, async (role, tool, args) => {
      seen.push({ role, tool, args });
      if (tool === "playState") return { editModeActive: false };
      if (tool === "move") return { how: args.mode, player: "Ender", owner: "server", target: args.path, goal: args.position ?? [0, 5, 0], from: [9, 3, 9], at: args.position ?? [0, 5, 0], distanceLeft: 0.4, heightLeft: 0, stopped: args.mode === "teleport" ? "teleported" : "arrived", arrived: true, seconds: 1.5, walkSpeed: 16, timeoutSeconds: args.seconds, ...(args.mode === "path" ? { waypoints: 7 } : {}) };
      if (tool === "find") return { found: [{ path: "Workspace.Enemies.Boss", className: "Model", attributes: 2 }], total: 1, scanned: 900, classMatch: args.classes ? "IsA" : undefined, seconds: 0.01 };
      throw new Error(`${tool} is not faked`);
    });
    const run = control(port, { cwd: path.join(folders["111"], "sync") });
    await waitFor(async () => (await run("status", "--json")).json().sessions[0]?.instances === 3);
    assert.match((await run("move", "--at=1,2,3")).err, /no play is running/);
    await fake.play("server");
    await fake.play("client");

    const teleported = await run("move", "--at=-5,0,2.5");
    assert.equal(teleported.code, 0, teleported.err);
    assert.deepEqual([seen.at(-1)!.role, seen.at(-1)!.tool, seen.at(-1)!.args], ["server", "move", { mode: "teleport", position: [-5, 0, 2.5], seconds: 15 }]);
    assert.match(teleported.out, /^Teleported Ender to -5, 0, 2\.5 from 9, 3, 9, on the play server: feet at -5, 0, 2\.5, 0\.4 studs from the goal \(\d+ ms\)\.$/);
    const walked = await run("move", "Workspace.Shop", "--mode", "path", "--timeout", "8", "--radius", "3");
    assert.equal(walked.code, 0, walked.err);
    assert.deepEqual(seen.at(-1)!.args, { mode: "path", path: "Workspace.Shop", seconds: 8, radius: 3 });
    assert.match(walked.out, /^Ender walked along a path of 7 waypoints from 9, 3, 9 toward Workspace\.Shop \(its top at 0, 5, 0\), on the play server: arrived\. Feet at 0, 5, 0, 0\.4 studs left; 1\.5 s at WalkSpeed 16 \(\d+ ms in all\)\.$/);
    assert.match((await run("move")).err, /usage: move <path>/);
    assert.match((await run("move", "Workspace.Shop", "--mode", "fly")).err, /--mode must be teleport, walk or path/);
    assert.match((await run("move", "--at=1,2")).err, /--at must be <x>,<y>,<z>/);

    const found = await run("find", "--peer", "server", "--class", "BasePart", "--attr=Level=3", "--tag", "Enemy");
    assert.equal(found.code, 0, found.err);
    assert.deepEqual([seen.at(-1)!.role, seen.at(-1)!.tool, seen.at(-1)!.args], ["server", "find", { classes: ["BasePart"], attribute: "Level", attributeValue: "3", tag: "Enemy", limit: 50 }]);
    assert.match(found.out, /^Workspace\.Enemies\.Boss \[Model\]  2 attributes\n1 found among 900 instances of the play server; classes by IsA \(subclasses too\) \(\d+ ms\)\.$/);
    assert.match((await run("find", "--peer", "studio", "--name", "x")).err, /--peer must be server or client/);

    const mcp = mcpSession(port, path.join(folders["111"], "sync"));
    const moved = await mcp.tool("move_player", { position: [-1, 2, -3], mode: "walk", timeoutSeconds: 5 });
    assert.equal(moved.isError, undefined, moved.content[0].text);
    assert.deepEqual(seen.at(-1)!.args, { mode: "walk", position: [-1, 2, -3], seconds: 5 });
    assert.match(moved.content[0].text, /^Ender walked in a straight line \(Humanoid:MoveTo\) from 9, 3, 9 toward -1, 2, -3/);
    assert.match((await mcp.tool("move_player", { path: "Workspace.Shop", position: [1, 2, 3] })).content[0].text, /give path or position, one of them/);
    assert.match((await mcp.tool("move_player", { path: "-Workspace" })).content[0].text, /path cannot start with "-"/);
    const live = await mcp.tool("find_instances", { peer: "client", name: "*Button", attribute: "Price", attributeValue: -5, exact: true });
    assert.equal(live.isError, undefined, live.content[0].text);
    assert.deepEqual([seen.at(-1)!.role, seen.at(-1)!.args], ["client", { name: "*Button", attribute: "Price", attributeValue: "-5", exact: true, limit: 50 }]);
    assert.match((await mcp.tool("find_instances", { tag: "Enemy", peer: "nope" })).content[0].text, /peer must be server, client or edit/);
    assert.match((await mcp.tool("find_instances", { attribute: "a b" })).content[0].text, /attribute must be an attribute's name/);
    await mcp.close();
    fake.close();
  });
});

test("queue: who holds Studio and who waits, the settings, a forced release, a submit that waits for its verdict", { timeout: 60000 }, async () => {
  await withHub(async ({ port, folders }) => {
    const run = control(port, { cwd: folders["111"] });
    const post = (pathname: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    await post("/api/queue/lock", { placeId: "111", op: "claim", client: { id: "s1", name: "session one", pid: process.pid }, tool: "solo_playtest" });
    await post("/api/queue/lock", { placeId: "111", op: "join", client: { id: "s2", name: "session two", pid: process.pid }, waiter: { task: "buy the sword", holdMin: 3, level: "update", exclusive: true } });
    const status = await run("queue");
    assert.equal(status.code, 0, status.err);
    assert.match(status.out, /Studio: held by session one \(s1\) for \d+ s, last call/);
    assert.match(status.out, /1\. update, ~3 min, waiting \d+ s, live: session two \(s2\): buy the sword/);
    assert.equal((await run("queue", "settings", "--json")).json().settings.capMin, 5);
    const released = await run("queue", "release");
    assert.match(released.out, /Studio lock of Alpha Game \(111\) freed \(was session one \(s1\)\)/);
    // Official asks first; without a terminal it needs --yes
    const official = control(port, { cwd: folders["111"], flavor: "official" });
    assert.equal((await official("queue", "release")).code, 1);
    // A job with no Studio open waits; past --timeout it stays queued and says so
    fs.writeFileSync(path.join(folders["111"], "job.luau"), "--! name: cli job\nreturn {}");
    const submitted = await run("queue", "submit", "job.luau", "--timeout", "0.01");
    assert.equal(submitted.code, 3, submitted.out + submitted.err);
    assert.match(submitted.out, /Submitted to Alpha Game \(111\)\. Waiting for the verdict/);
    assert.match(submitted.err, /No verdict yet; the job stays queued/);
    const queued = (await run("queue", "--json")).json();
    assert.equal(queued.jobs[0].name, "cli job");
    assert.equal(queued.jobs[0].client.name, "quack queue submit");
    assert.equal(queued.jobs[0].client.pid, undefined, "a terminal's job is not its process's: it stays queued after the command exits");
  });
});

// 09/11/26: the app's Open Cloud setting runs `cloud`; the key arrives on stdin and is never printed
test("cloud: the key and creator saved in open-cloud.env, the key never printed, other lines kept", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-cloud-"));
  try {
    const file = path.join(dataDir, "open-cloud.env");
    fs.writeFileSync(file, "# mine\nOTHER=1\nROBLOX_CREATOR_GROUP_ID=77\n");
    const key = "SECRETKEY-abcdefghijklmnop-WXYZ";
    const run = async (argv: string[], stdin = "") => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runControl(argv, {
        info: flavorInfo("dev"), client: new HubClient(1), out: (l) => out.push(l), err: (l) => err.push(l),
        confirm: async () => false, interactive: false, color: false, cwd: dataDir, openUri: async () => {},
        roblox: { dataDir, env: {}, dpapi: fakeDpapi }, readStdin: async () => stdin,
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };

    const saved = await run(["cloud", "set", "--key-stdin", "--user=123", "--json"], `${key}\r\n`);
    assert.equal(saved.code, 0, saved.err);
    assert.ok(!saved.out.includes(key), "the key is not in the answer");
    const json = JSON.parse(saved.out);
    assert.equal(json.hasKey, true);
    assert.equal(json.keyEnd, "WXYZ");
    assert.equal(json.userId, "123");
    assert.equal(json.groupId, undefined, "a user id replaces the group id");
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /^# mine\nOTHER=1\n/, "other lines stay, in their place");
    // The key is in the vault, encrypted (09/11/26): no file holds it, the hub's decrypt gives it back
    assert.ok(!text.includes(key) && !text.includes("ROBLOX_OPEN_CLOUD_API_KEY"), "the key is not in open-cloud.env");
    assert.ok(!fs.readFileSync(path.join(dataDir, "open-cloud.key"), "utf8").includes(key), "nor in plain text in the vault");
    assert.equal(await new Vault(dataDir, fakeDpapi).get(), key, "without the line break");
    assert.ok(!text.includes("ROBLOX_CREATOR_GROUP_ID"));

    const shown = await run(["cloud"]);
    assert.match(shown.out, /Key saved \(ends in WXYZ\), user 123/);
    assert.ok(!shown.out.includes(key));

    const group = JSON.parse((await run(["cloud", "set", "--group=456", "--json"])).out);
    assert.equal(group.groupId, "456");
    assert.equal(group.userId, undefined);
    assert.equal(group.hasKey, true, "setting the creator keeps the key");

    assert.equal((await run(["cloud", "set", "--user=abc"])).code, 1, "an id is a number");
    assert.equal((await run(["cloud", "set", "--key-stdin"], "  ")).code, 1, "an empty stdin is refused");

    const cleared = JSON.parse((await run(["cloud", "clear", "--json"])).out);
    assert.equal(cleared.hasKey, false);
    assert.equal(cleared.groupId, "456", "clear removes only the key");
    assert.ok(!fs.existsSync(path.join(dataDir, "open-cloud.key")), "clear removes the vault");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("changes: the terminal and the MCP say which uncommitted files Studio wrote, through the hub, with no Studio call", { timeout: 60000 }, async () => {
  await withHub(async ({ port, folders }) => {
    const folder = folders["111"];
    const gitIn = (...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    fs.writeFileSync(path.join(folder, ".gitignore"), ".quack/\nsourcemap.json\n");
    gitIn("init", "-q");
    gitIn("config", "user.email", "test@example.com");
    gitIn("config", "user.name", "Test");
    gitIn("add", "-A");
    gitIn("commit", "-q", "-m", "start");

    // The snapshot writes the place's one script: Studio's
    fakeStudio(port, 111, "AlphaScript");
    const run = control(port, { cwd: path.join(folder, "sync") });
    await waitFor(async () => (await run("status", "--json")).json().sessions[0]?.instances === 3);
    await waitFor(() => fs.existsSync(path.join(folder, "sync", "ServerStorage", "AlphaScript.luau")));
    // An agent's new file
    fs.writeFileSync(path.join(folder, "sync", "ServerStorage", "Note.luau"), "return 'note'\n");

    const listed = await run("changes");
    assert.equal(listed.code, 0, listed.err);
    const [head, studioLine, otherLine, total] = listed.out.split("\n");
    assert.equal(head, `2 files changed in sync since the last commit (repo ${gitIn("rev-parse", "--show-toplevel").trim()}):`);
    assert.match(studioLine, /^ {2}studio \?\? {2}sync\/ServerStorage\/AlphaScript\.luau {2}made by Studio \[Studio wrote it \d{4}-\d\d-\d\d \d\d:\d\d\]$/);
    assert.match(otherLine, /^ {2}other {2}\?\? {2}sync\/ServerStorage\/Note\.luau {9}not from Studio$/);
    assert.match(total, /^1 from Studio, 0 mixed, 1 not from Studio \(\d+ ms\)\. Paths are from the repo's root, for git add\.$/);
    const json = (await run("changes", "--numbers-only", "--json")).json();
    assert.deepEqual(json.files.map((f: any) => [f.path, f.origin, f.numbersOnly]), [["sync/ServerStorage/AlphaScript.luau", "studio", false], ["sync/ServerStorage/Note.luau", "other", undefined]]);

    const mcp = mcpSession(port, path.join(folder, "sync"));
    const answer = await mcp.tool("studio_changes", { numbersOnly: true });
    assert.equal(answer.isError, undefined, answer.content[0].text);
    assert.match(answer.content[0].text, /studio \?\? {2}sync\/ServerStorage\/AlphaScript\.luau {2}made by Studio \[Studio wrote it [^\]]+\]; not only numbers: a new file/);
    assert.match(answer.content[0].text, /\nBalance: none \(no file from Studio changed only in numbers\)\.$/);
    await mcp.close();
  });
});

test("changes --commit-balance: commits Studio's numbers alone through the hub and pushes from the caller; a failed push is an error", { timeout: 60000 }, async () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "quack-balance-remote-"));
  try {
    await withHub(async ({ port, folders }) => {
      const folder = folders["111"];
      const gitIn = (...args: string[]) => execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      fs.writeFileSync(path.join(folder, ".gitignore"), ".quack/\nsourcemap.json\n");
      gitIn("init", "-q");
      gitIn("config", "user.email", "test@example.com");
      gitIn("config", "user.name", "Test");
      gitIn("config", "core.hooksPath", path.join(folder, ".git", "hooks"));
      gitIn("add", "-A");
      gitIn("commit", "-q", "-m", "start");

      const studio = fakeStudio(port, 111, "AlphaScript");
      const run = control(port, { cwd: path.join(folder, "sync") });
      const alpha = path.join(folder, "sync", "ServerStorage", "AlphaScript.luau");
      const studioEdit = async (source: string) => {
        studio.ws.send(JSON.stringify({ type: "scriptChanged", data: { guid: "s111", source, path: ["ServerStorage", "AlphaScript"], className: "ModuleScript" } }));
        await waitFor(() => fs.existsSync(alpha) && fs.readFileSync(alpha, "utf8") === source);
      };
      await waitFor(async () => (await run("status", "--json")).json().sessions[0]?.instances === 3);
      await studioEdit("return { Hp = 1 }\n");
      gitIn("add", "-A");
      gitIn("commit", "-q", "-m", "the script");

      // The designer tunes it in Studio; someone's edit sits staged
      await studioEdit("return { Hp = 2 }\n");
      fs.writeFileSync(path.join(folder, "Note.txt"), "mine\n");
      gitIn("add", "Note.txt");
      const listed = await run("changes", "--balance");
      assert.equal(listed.code, 0, listed.err);
      assert.match(listed.out, /\nBalance: 1 file from Studio changed only in numbers \(--commit-balance commits it alone\)\.$/);
      assert.equal(gitIn("rev-list", "--count", "HEAD").trim(), "2", "listing commits nothing");

      // No remote: committed, the push fails, exit 1
      const noRemote = await run("changes", "--commit-balance");
      assert.equal(noRemote.code, 1, noRemote.out);
      assert.match(noRemote.out, /^Committed [0-9a-f]{7} "Balance: values tuned in Studio" with 1 file only Studio changed, numbers only:\n {2}sync\/ServerStorage\/AlphaScript\.luau\n/);
      assert.match(noRemote.out, /\nThe push failed, and stopped there \(the commit stays\): /);
      assert.equal(gitIn("log", "-1", "--format=%s").trim(), "Balance: values tuned in Studio");
      assert.equal(gitIn("show", "--name-only", "--format=", "HEAD").trim(), "sync/ServerStorage/AlphaScript.luau");
      assert.equal(gitIn("diff", "--cached", "--name-only").trim(), "Note.txt", "the staged file stays staged");

      // With a remote: the MCP commits and pushes
      execFileSync("git", ["init", "-q", "--bare", remote]);
      gitIn("remote", "add", "origin", remote);
      gitIn("push", "-q", "-u", "origin", "HEAD");
      await studioEdit("return { Hp = 3 }\n");
      const mcp = mcpSession(port, path.join(folder, "sync"));
      const answer = await mcp.tool("studio_changes", { commitBalance: true });
      assert.equal(answer.isError, undefined, answer.content[0].text);
      assert.match(answer.content[0].text, /^Committed [0-9a-f]{7} "Balance: values tuned in Studio"/);
      assert.match(answer.content[0].text, /\nPushed/);
      assert.equal(execFileSync("git", ["-C", remote, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), gitIn("rev-parse", "HEAD").trim());
      // Nothing left to commit: says so, exit 0, no push
      const none = await run("changes", "--commit-balance", "--json");
      assert.equal(none.code, 0, none.out);
      assert.deepEqual([none.json().committed, none.json().pushed], [null, undefined]);
      await mcp.close();
      studio.ws.close();
    });
  } finally {
    fs.rmSync(remote, { recursive: true, force: true });
  }
});
