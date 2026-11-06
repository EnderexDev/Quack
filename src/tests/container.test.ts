import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SyncDaemon } from "../index.js";
import { config } from "../config.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The daemon busy for longer than the watcher's 1 s suppression (a 300k-instance place does) */
function stall(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // hold the event loop
  }
}

const W0 = ["Workspace", "Worlds", "0"];
const S0 = ["ServerStorage", "WorldStorage", "0"];

// Anime Astral copy, 06/11/26: Worlds.0 is the Main Lobby, a Folder of stations and spawns with no
// script (so no folder on disk); its Map, kept in ServerStorage, holds one script
const PLACE = [
  { guid: "ws", className: "Workspace", name: "Workspace", path: ["Workspace"], parentGuid: "root" },
  { guid: "worlds", className: "Folder", name: "Worlds", path: ["Workspace", "Worlds"], parentGuid: "ws" },
  { guid: "w0", className: "Folder", name: "0", path: W0, parentGuid: "worlds" },
  { guid: "spawn", className: "Part", name: "Spawn", path: [...W0, "Spawn"], parentGuid: "w0" },
  { guid: "sys", className: "Folder", name: "Systems", path: [...W0, "Systems"], parentGuid: "w0" },
  { guid: "gacha", className: "Model", name: "GachaStation", path: [...W0, "Systems", "GachaStation"], parentGuid: "sys" },
  { guid: "ss", className: "ServerStorage", name: "ServerStorage", path: ["ServerStorage"], parentGuid: "root" },
  { guid: "wst", className: "Folder", name: "WorldStorage", path: ["ServerStorage", "WorldStorage"], parentGuid: "ss" },
  { guid: "s0", className: "Folder", name: "0", path: S0, parentGuid: "wst" },
  { guid: "map", className: "Model", name: "Map", path: [...S0, "Map"], parentGuid: "s0" },
  { guid: "aura", className: "Part", name: "AuraCirculo", path: [...S0, "Map", "AuraCirculo"], parentGuid: "map" },
  { guid: "mihawk", className: "Model", name: "Mihawk", path: [...S0, "Map", "AuraCirculo", "Mihawk"], parentGuid: "aura" },
  { guid: "scr", className: "Script", name: "Script", path: [...S0, "Map", "AuraCirculo", "Mihawk", "Script"], parentGuid: "mihawk", source: "print(1)" },
];

async function withPlace(body: (daemon: any, sent: any[]) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-"));
  const prev = { syncDir: config.syncDir, sourcemapPath: config.sourcemapPath, port: config.port, live: config.liveFsSync };
  let daemon: SyncDaemon | undefined;
  try {
    config.syncDir = path.join(tmp, "sync");
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prev.live, enabled: true };
    daemon = new SyncDaemon();
    const sent: any[] = [];
    (daemon as any).ipc.send = (msg: any) => (sent.push(msg), true);
    (daemon as any).ipc.deleteInstance = (guid?: string, p?: string[]) => (sent.push({ type: "deleteInstance", guid, path: p }), true);
    (daemon as any).handleStudioMessage({ type: "fullSnapshot", placeId: 1, data: PLACE });
    await wait(400);
    sent.length = 0;
    await body(daemon, sent);
  } finally {
    try {
      await daemon?.stop();
    } finally {
      config.syncDir = prev.syncDir;
      config.sourcemapPath = prev.sourcemapPath;
      config.port = prev.port;
      config.liveFsSync = prev.live;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

const summary = (sent: any[]) => sent.map((m) => `${m.type} ${m.guid ?? ""} ${(m.parentPath ?? m.path ?? []).join("/")} ${m.name ?? ""}`.trim()).join("\n");
const structural = (sent: any[]) => sent.filter((m) => m.type === "deleteInstance" || m.type === "createInstance" || m.type === "moveInstance");

test("a script passing through a container with no script of its own, with the daemon stalled, leaves the container in Studio", async () => {
  await withPlace(async (daemon, sent) => {
    assert.equal(fs.existsSync(path.join(config.syncDir, ...W0)), false, "Worlds/0 has no script, so no folder");

    // P.load(0): the Map goes into the world
    daemon.handleStudioMessage({ type: "instanceUpdated", data: { guid: "map", className: "Model", name: "Map", path: [...W0, "Map"], parentGuid: "w0" } });
    stall(1200);
    await wait(1500);
    assert.equal(fs.existsSync(path.join(config.syncDir, ...W0, "Map", "AuraCirculo", "Mihawk", "Script.server.luau")), true);

    // P.unload(0): back to ServerStorage, the daemon busy past the echo's suppression
    daemon.handleStudioMessage({ type: "instanceUpdated", data: { guid: "map", className: "Model", name: "Map", path: [...S0, "Map"], parentGuid: "s0" } });
    stall(1200);
    await wait(2500);

    assert.equal(fs.existsSync(path.join(config.syncDir, ...S0, "Map", "AuraCirculo", "Mihawk", "Script.server.luau")), true);
    assert.equal(fs.existsSync(path.join(config.syncDir, ...W0, "Map")), false, "the Map's old folders are cleaned up");
    assert.equal(fs.existsSync(path.join(config.syncDir, ...W0)), true, "the world's own folder stays: Worlds.0 is still in Studio");
    assert.deepEqual(structural(sent), [], summary(sent));
  });
});

test("a container's folder removed on disk keeps the container in Studio when it holds instances with no file", async () => {
  await withPlace(async (daemon, sent) => {
    daemon.handleStudioMessage({ type: "instanceUpdated", data: { guid: "map", className: "Model", name: "Map", path: [...W0, "Map"], parentGuid: "w0" } });
    await wait(1500);
    sent.length = 0;

    // Someone removes Workspace\Worlds\0 by hand: the script goes, the stations stay
    fs.rmSync(path.join(config.syncDir, ...W0), { recursive: true, force: true });
    await wait(2000);

    const deletes = sent.filter((m) => m.type === "deleteInstance");
    assert.deepEqual(deletes.map((m) => m.guid ?? m.path.join("/")), ["scr"], summary(sent));
  });
});

// ANIME ASTRAL COPY, 06/11/26 (world 13): same-named scripts kept their old names on disk
// (Script__183824...). Loading the Map renamed them and removed the old files; the OS dropped
// those events and a rescan delivered them after the Map was back. Each was sent as a delete by
// path, "Script" under MeshPart, and Studio destroyed one of the real scripts.
test("a late echo of a file the daemon renamed away sends no delete to Studio", async () => {
  await withPlace(async (daemon, sent) => {
    const part = [...S0, "Map", "AuraCirculo", "Mihawk"];
    const dir = path.join(config.syncDir, ...part);
    fs.writeFileSync(path.join(dir, "Twin__183824.server.luau"), "print(2)");
    daemon.handleStudioMessage({ type: "instanceUpdated", data: { guid: "t1", className: "Script", name: "Twin", path: [...part, "Twin"], parentGuid: "mihawk", source: "print(2)" } });
    daemon.handleStudioMessage({ type: "instanceUpdated", data: { guid: "t2", className: "Script", name: "Twin", path: [...part, "Twin"], parentGuid: "mihawk", source: "print(2)" } });
    await wait(600);
    const before = fs.readdirSync(dir).filter((f) => f.startsWith("Twin")).sort();
    assert.ok(before.includes("Twin__183824.server.luau"), `the old name is kept: ${before.join(", ")}`);
    sent.length = 0;

    daemon.handleStudioMessage({ type: "instanceUpdated", data: { guid: "map", className: "Model", name: "Map", path: [...W0, "Map"], parentGuid: "w0" } });
    await wait(600);
    daemon.handleStudioMessage({ type: "instanceUpdated", data: { guid: "map", className: "Model", name: "Map", path: [...S0, "Map"], parentGuid: "s0" } });
    await wait(600);
    // The rescan's late unlink of the name the first move removed
    if (!fs.existsSync(path.join(dir, "Twin__183824.server.luau"))) daemon.handleFileDelete(path.join(dir, "Twin__183824.server.luau"));
    await wait(1500);

    assert.deepEqual(sent.filter((m) => m.type === "deleteInstance"), [], summary(sent));
  });
});

test("a file named for one of several same-named scripts that no script owns sends no delete by path", async () => {
  await withPlace(async (daemon, sent) => {
    daemon.handleFileDelete(path.join(config.syncDir, "ServerStorage", "Twin__a1b2c3d4.server.luau"));
    daemon.handleFileDelete(path.join(config.syncDir, "ServerStorage", "Solo.server.luau"));
    const deletes = sent.filter((m) => m.type === "deleteInstance").map((m) => m.path.join("/"));
    assert.deepEqual(deletes, ["ServerStorage/Solo"]);
  });
});

test("a folder of Folders and scripts removed on disk is still deleted in Studio", async () => {
  await withPlace(async (daemon, sent) => {
    daemon.handleStudioMessage({ type: "instanceUpdated", data: { guid: "f", className: "Folder", name: "Utils", path: ["ServerStorage", "Utils"], parentGuid: "ss" } });
    daemon.handleStudioMessage({ type: "instanceUpdated", data: { guid: "m", className: "ModuleScript", name: "Mod", path: ["ServerStorage", "Utils", "Mod"], parentGuid: "f", source: "return 1" } });
    await wait(1500);
    sent.length = 0;

    fs.rmSync(path.join(config.syncDir, "ServerStorage", "Utils"), { recursive: true, force: true });
    await wait(2000);

    const deleted = sent.filter((m) => m.type === "deleteInstance").map((m) => m.guid ?? m.path.join("/"));
    assert.ok(deleted.includes("f"), summary(sent));
  });
});
