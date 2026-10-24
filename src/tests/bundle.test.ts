import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => boolean, ms = 30000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(100);
  }
}

test("the bundled hub the app ships syncs a Studio with one daemon, away from dist/", { timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-bundle-"));
  const bundleDir = path.join(tmp, "bundle");
  const folder = path.join(tmp, "Game");
  fs.mkdirSync(folder);
  const registry = path.join(tmp, "hub.json");
  fs.writeFileSync(registry, JSON.stringify({ places: { "321": { folder, name: "Bundled" } } }));

  const { bundleHub } = await import(pathToFileURL(path.join(repo, "scripts", "bundle-hub.mjs")).href);
  await bundleHub(bundleDir);
  // The bundle stands alone: nothing from dist/ or node_modules next to it
  assert.deepEqual(fs.readdirSync(bundleDir).sort(), ["BUILD", "DAEMON_BUILD", "VERSION", "cli.mjs", "daemon.mjs", "hub.mjs"]);
  const buildId = fs.readFileSync(path.join(bundleDir, "BUILD"), "utf8").trim();
  assert.match(buildId, /^[0-9a-f]{12}$/);
  assert.match(fs.readFileSync(path.join(bundleDir, "DAEMON_BUILD"), "utf8").trim(), /^[0-9a-f]{12}$/);
  // No placeholder left behind in any file
  for (const file of ["hub.mjs", "daemon.mjs", "cli.mjs"]) {
    assert.equal(fs.readFileSync(path.join(bundleDir, file), "utf8").includes("@@quack-build-id@@"), false, file);
  }

  const port = await freePort();
  const hub = spawn(process.execPath, [path.join(bundleDir, "hub.mjs"), "--port", String(port), "--registry", registry], { stdio: ["ignore", "pipe", "pipe"] });
  const hubExited = new Promise<void>((resolve) => hub.once("exit", () => resolve()));
  let hubOut = "";
  hub.stdout.on("data", (d) => (hubOut += d));
  hub.stderr.on("data", (d) => (hubOut += d));
  const received: any[] = [];
  let ws: WebSocket | undefined;
  try {
    await waitFor(() => hubOut.includes("listening"));
    ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (msg.type === "requestSnapshot") {
        ws!.send(JSON.stringify({
          type: "fullSnapshot",
          placeId: 321,
          data: [
            { guid: "ss", className: "ServerStorage", name: "ServerStorage", path: ["ServerStorage"], parentGuid: "root" },
            { guid: "s1", className: "ModuleScript", name: "FromBundle", path: ["ServerStorage", "FromBundle"], parentGuid: "ss", source: "return 1\n" },
          ],
        }));
      }
    });
    ws.on("open", () => ws!.send(JSON.stringify({ type: "handshakeStudio", version, placeId: 321, placeName: "Bundled" })));

    const script = path.join(folder, "sync", "ServerStorage", "FromBundle.luau");
    await waitFor(() => fs.existsSync(script));
    // Accepted: the version baked into the bundle matches the plugin's
    assert.ok(received.some((m) => m.type === "handshakeAck"), JSON.stringify(received.map((m) => m.type)));
    await wait(1000);
    const log = fs.readFileSync(path.join(folder, ".quack", "daemon.log"), "utf8");
    // One daemon only: the bundled CLI must not also start index.ts's own daemon
    assert.equal(log.split("daemon starting").length - 1, 1, log);
    assert.equal(/EADDRINUSE|already in use/i.test(log), false, log);
    // Stopped the way the app stops it: kill() on Windows ends the hub without hub.stop(),
    // which would leave its daemon running
    const state = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as any;
    // The app tells an outdated hub by this id; it is baked in, not read from the file, which
    // an install overwrites under a running hub
    assert.equal(state.build, buildId);
    fs.writeFileSync(path.join(bundleDir, "BUILD"), "replaced-by-an-install");
    assert.equal(((await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as any).build, buildId);
    const daemonPid = state.sessions[0].daemonPid as number;
    const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    await hubExited;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await waitFor(() => !alive(daemonPid), 5000);
  } finally {
    ws?.terminate();
    // A failure above lands here with the hub still up: stop it the same graceful way, and
    // force it only if it does not go within 5 s
    if (hub.exitCode === null && hub.signalCode === null) {
      await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
      await Promise.race([hubExited, wait(5000)]);
      if (hub.exitCode === null && hub.signalCode === null) hub.kill();
    }
    await Promise.race([hubExited, wait(2000)]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a rebuild of the same code keeps its build ids, so an update that leaves the hub alone does not restart it", { timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-bundle-ids-"));
  const { bundleHub } = await import(pathToFileURL(path.join(repo, "scripts", "bundle-hub.mjs")).href);
  const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8").trim();
  const first = await bundleHub(path.join(tmp, "a"));
  await wait(20);
  const second = await bundleHub(path.join(tmp, "b"));
  assert.equal(read(first, "BUILD"), read(second, "BUILD"));
  assert.equal(read(first, "DAEMON_BUILD"), read(second, "DAEMON_BUILD"));
  // The hub and the daemon are different files with ids of their own
  assert.notEqual(read(first, "BUILD"), read(first, "DAEMON_BUILD"));
  fs.rmSync(tmp, { recursive: true, force: true });
});
