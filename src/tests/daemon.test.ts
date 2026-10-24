import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SyncDaemon } from "../index.js";
import { config } from "../config.js";
import { isVersionCompatible } from "../util/versionUtils.js";

function makeTempDir(prefix = "quack-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Walk a generated sourcemap tree by exact DataModel path (from the root). */
function findInSourcemap(root: any, pathSegments: string[]): any {
  let current = root;
  for (const segment of pathSegments) {
    if (!current || !Array.isArray(current.children)) return undefined;
    current = current.children.find((c: any) => c.name === segment);
  }
  return current;
}

function readSourcemap(): any {
  return JSON.parse(fs.readFileSync(config.sourcemapPath, "utf8"));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the sourcemap once the daemon's coalesced write has landed. */
async function readSettledSourcemap(): Promise<any> {
  await wait(250);
  return readSourcemap();
}

test("fullSnapshot writes scripts, generates sourcemap, and removes orphans", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevDeleteOrphansOnConnect = config.deleteOrphansOnConnect;
  let daemon: SyncDaemon | undefined;
  try {
    // Configure daemon to use our temp dir and an ephemeral port
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.deleteOrphansOnConnect = true;

    // Create an orphan file that should be removed on snapshot
    const orphanDir = path.join(tmp, "extra");
    fs.mkdirSync(orphanDir, { recursive: true });
    const orphanPath = path.join(orphanDir, "orphan.luau");
    fs.writeFileSync(orphanPath, "print('i am orphan')", "utf8");
    assert.ok(fs.existsSync(orphanPath), "orphan created");

    daemon = new SyncDaemon();

    const instances = [
      {
        guid: "r1",
        className: "Folder",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
      },
      {
        guid: "m1",
        className: "Folder",
        name: "Modules",
        path: ["ReplicatedStorage", "Modules"],
      },
      {
        guid: "s1",
        className: "ModuleScript",
        name: "Foo",
        path: ["ReplicatedStorage", "Modules", "Foo"],
        source: "print('hello')",
      },
    ];

    // Send full snapshot
    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: instances,
    });

    const expectedFile = path.join(
      tmp,
      "ReplicatedStorage",
      "Modules",
      "Foo.luau",
    );
    assert.ok(fs.existsSync(expectedFile), "script file was written");

    assert.ok(fs.existsSync(config.sourcemapPath), "sourcemap was generated");
    const sourcemap = JSON.parse(fs.readFileSync(config.sourcemapPath, "utf8"));
    assert.strictEqual(sourcemap.name, "Game");

    // Orphan file should have been removed
    assert.strictEqual(fs.existsSync(orphanPath), false, "orphan file removed");
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.deleteOrphansOnConnect = prevDeleteOrphansOnConnect;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a snapshot without paths (omitPaths) syncs the same files and sourcemap as one with them", async () => {
  // Parents before children, as the plugin's walk sends them; a name with a dot on purpose
  const withPaths = [
    { guid: "r1", className: "ReplicatedStorage", name: "ReplicatedStorage", parentGuid: "root", path: ["ReplicatedStorage"] },
    { guid: "m1", className: "Folder", name: "Mod.ules", parentGuid: "r1", path: ["ReplicatedStorage", "Mod.ules"] },
    { guid: "s1", className: "ModuleScript", name: "Foo", parentGuid: "m1", path: ["ReplicatedStorage", "Mod.ules", "Foo"], source: "return 1\n" },
    { guid: "s2", className: "Script", name: "Bar", parentGuid: "s1", path: ["ReplicatedStorage", "Mod.ules", "Foo", "Bar"], source: "print(2)\n" },
    { guid: "w1", className: "Workspace", name: "Workspace", parentGuid: "root", path: ["Workspace"] },
    { guid: "p1", className: "Part", name: "Part", parentGuid: "w1", path: ["Workspace", "Part"] },
  ];
  const withoutPaths = withPaths.map(({ path: _path, ...rest }) => rest);

  async function syncInto(data: any[]): Promise<{ files: string[]; sourcemap: string }> {
    const tmp = makeTempDir();
    const prev = { syncDir: config.syncDir, sourcemapPath: config.sourcemapPath, port: config.port };
    let daemon: SyncDaemon | undefined;
    try {
      config.syncDir = tmp;
      config.sourcemapPath = path.join(tmp, "sourcemap.json");
      config.port = 0;
      daemon = new SyncDaemon();
      (daemon as any).handleStudioMessage({ type: "fullSnapshot", data: structuredClone(data) });
      const files = (fs.readdirSync(tmp, { recursive: true }) as string[])
        .filter((f) => f.endsWith(".luau"))
        .map((f) => `${f.replaceAll("\\", "/")}=${fs.readFileSync(path.join(tmp, f), "utf8")}`)
        .sort();
      // guids aside, which the sourcemap carries as given, and the temp folder each run gets
      const sourcemap = JSON.stringify(await readSettledSourcemap(), (k, v) => (k === "guid" ? undefined : v))
        .replaceAll(tmp.replaceAll("\\", "/"), "<tmp>");
      return { files, sourcemap };
    } finally {
      await daemon?.stop();
      Object.assign(config, prev);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const expected = await syncInto(withPaths);
  const actual = await syncInto(withoutPaths);
  assert.equal(expected.files.length, 2, expected.files.join("\n"));
  assert.deepEqual(actual.files, expected.files);
  assert.equal(actual.sourcemap, expected.sourcemap);
});

test("the daemon asks Studio for a snapshot without paths", () => {
  const prevPort = config.port;
  config.port = 0;
  const daemon = new SyncDaemon();
  const sent: any[] = [];
  (daemon as any).ipc.send = (message: any) => {
    sent.push(message);
    return true;
  };
  try {
    // What runs once a plugin's handshake is accepted
    (daemon as any).ipc.handshakeHandler({ session: "s", resume: false });
    const request = sent.find((m) => m.type === "requestSnapshot");
    assert.ok(request, JSON.stringify(sent));
    assert.equal(request.options?.omitPaths, true);
  } finally {
    void daemon.stop();
    config.port = prevPort;
  }
});

test("paths rebuilt from parents: an instance without its parent is dropped, a parent loop ends", async () => {
  const { fillSnapshotPaths } = await import("../fs/snapshotPaths.js");
  const { filled, dropped } = fillSnapshotPaths([
    { guid: "a", className: "Folder", name: "ServerStorage", parentGuid: "root" },
    // child listed before its parent: still placed
    { guid: "c", className: "Folder", name: "C", parentGuid: "b" },
    { guid: "b", className: "Folder", name: "B", parentGuid: "a" },
    // an older plugin's path is kept as sent
    { guid: "k", className: "Folder", name: "K", parentGuid: "a", path: ["ServerStorage", "K"] },
    { guid: "lost", className: "Folder", name: "Lost", parentGuid: "nowhere" },
    { guid: "x", className: "Folder", name: "X", parentGuid: "y" },
    { guid: "y", className: "Folder", name: "Y", parentGuid: "x" },
  ] as any);
  assert.deepEqual(
    Object.fromEntries(filled.map((i) => [i.guid, i.path.join("/")])),
    { a: "ServerStorage", c: "ServerStorage/B/C", b: "ServerStorage/B", k: "ServerStorage/K" },
  );
  assert.equal(dropped, 3);
});

test("same-named sibling scripts keep their file names when the place is reopened (new guids)", async () => {
  const tmp = makeTempDir();
  const prev = { syncDir: config.syncDir, sourcemapPath: config.sourcemapPath, port: config.port };
  let daemon: SyncDaemon | undefined;
  // Studio's debug ids, the guids, change at every session; the files must not
  const session = (ids: string[]) => [
    { guid: ids[0], className: "Workspace", name: "Workspace", parentGuid: "root", path: ["Workspace"] },
    { guid: ids[1], className: "Part", name: "Mesh", parentGuid: ids[0], path: ["Workspace", "Mesh"] },
    { guid: ids[2], className: "Script", name: "Script", parentGuid: ids[1], path: ["Workspace", "Mesh", "Script"], source: "print('a')\n" },
    { guid: ids[3], className: "Script", name: "Script", parentGuid: ids[1], path: ["Workspace", "Mesh", "Script"], source: "print('b')\n" },
    { guid: ids[4], className: "Script", name: "Script", parentGuid: ids[1], path: ["Workspace", "Mesh", "Script"], source: "print('c')\n" },
  ];
  const files = () =>
    Object.fromEntries(
      fs.readdirSync(path.join(tmp, "Workspace", "Mesh")).sort().map((f) => [f, fs.readFileSync(path.join(tmp, "Workspace", "Mesh", f), "utf8")]),
    );
  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    daemon = new SyncDaemon();
    (daemon as any).handleStudioMessage({ type: "fullSnapshot", data: session(["1001", "1002", "183751", "183752", "183753"]) });
    const first = files();
    // Numbered from 2, not named after the session's guid
    assert.deepEqual(first, {
      "Script.server.luau": "print('a')\n",
      "Script__2.server.luau": "print('b')\n",
      "Script__3.server.luau": "print('c')\n",
    });
    // Reopened: every guid shifted, and the second and third come in the other order
    const reopened = session(["2001", "2002", "183750", "183761", "183760"]);
    [reopened[3], reopened[4]] = [reopened[4], reopened[3]];
    (daemon as any).handleStudioMessage({ type: "fullSnapshot", data: reopened });
    assert.deepEqual(files(), first);

    // A project from before: a guid-suffixed file keeps its name while its text matches
    fs.rmSync(path.join(tmp, "Workspace", "Mesh", "Script__3.server.luau"));
    fs.writeFileSync(path.join(tmp, "Workspace", "Mesh", "Script__70742.server.luau"), "print('c')\n");
    (daemon as any).handleStudioMessage({ type: "fullSnapshot", data: session(["3001", "3002", "3003", "3004", "3005"]) });
    assert.deepEqual(Object.keys(files()), ["Script.server.luau", "Script__2.server.luau", "Script__70742.server.luau"]);
  } finally {
    await daemon?.stop();
    Object.assign(config, prev);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scriptChanged creates file when node missing", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;
  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();

    const msg = {
      type: "scriptChanged",
      data: {
        guid: "new1",
        path: ["ReplicatedStorage", "Modules", "Bar"],
        className: "ModuleScript",
        source: "print('bar')",
      },
    } as any;

    (daemon as any).handleStudioMessage(msg);

    const expected = path.join(tmp, "ReplicatedStorage", "Modules", "Bar.luau");
    assert.ok(fs.existsSync(expected), "scriptChanged created file");

    // Resending identical source leaves the file untouched
    const mtimeBefore = fs.statSync(expected).mtimeMs;
    await wait(20);
    (daemon as any).handleStudioMessage(msg);
    assert.equal(fs.statSync(expected).mtimeMs, mtimeBefore);

    // Changed source is still written
    (daemon as any).handleStudioMessage({
      ...msg,
      data: { ...msg.data, source: "print('baz')" },
    });
    assert.equal(fs.readFileSync(expected, "utf8"), "print('baz')");
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("deleted removes files and updates sourcemap", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;
  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();

    // Create snapshot with one script
    const instances = [
      {
        guid: "r1",
        className: "Folder",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
      },
      {
        guid: "m1",
        className: "Folder",
        name: "Modules",
        path: ["ReplicatedStorage", "Modules"],
      },
      {
        guid: "sdel",
        className: "ModuleScript",
        name: "ToDelete",
        path: ["ReplicatedStorage", "Modules", "ToDelete"],
        source: "print('bye')",
      },
    ];

    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: instances,
    });
    const filePath = path.join(
      tmp,
      "ReplicatedStorage",
      "Modules",
      "ToDelete.luau",
    );
    assert.ok(fs.existsSync(filePath), "initial file exists");
    assert.ok(fs.existsSync(config.sourcemapPath), "sourcemap exists");

    // Send delete
    (daemon as any).handleStudioMessage({
      type: "deleted",
      data: { guid: "sdel" },
    });

    // File should be removed
    assert.strictEqual(fs.existsSync(filePath), false, "file was deleted");

    // Sourcemap should also be pruned for the deleted node/path
    await wait(250);
    const sourcemapRaw = fs.readFileSync(config.sourcemapPath, "utf8");
    const sourcemap = JSON.parse(sourcemapRaw);
    assert.notStrictEqual(sourcemapRaw.includes('"guid": "sdel"'), true);
    assert.notStrictEqual(sourcemapRaw.includes('"name": "ToDelete"'), true);
    const hasDeletedPath = (node: any, pathSegments: string[]): boolean => {
      if (!node || !Array.isArray(node.children)) return false;
      for (const child of node.children) {
        if (child.name === pathSegments[0]) {
          if (pathSegments.length === 1) return true;
          if (hasDeletedPath(child, pathSegments.slice(1))) return true;
        }
        if (hasDeletedPath(child, pathSegments)) return true;
      }
      return false;
    };
    assert.strictEqual(
      hasDeletedPath(sourcemap, ["ReplicatedStorage", "Modules", "ToDelete"]),
      false,
      "deleted path removed from sourcemap",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("filesystem live sync triggers createInstance and deleteInstance IPC messages", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();

    const sentMessages: any[] = [];
    (daemon as any).ipc.send = (msg: any) => {
      sentMessages.push(msg);
      return true;
    };

    // Test handleFileAdd for a Server script
    const serverScriptPath = path.join(
      tmp,
      "ReplicatedStorage",
      "Test.server.luau",
    );
    (daemon as any).handleFileAdd(serverScriptPath, "print('server')");

    assert.strictEqual(sentMessages.length, 1);
    assert.deepStrictEqual(sentMessages[0], {
      type: "createInstance",
      className: "Script",
      name: "Test",
      parentPath: ["ReplicatedStorage"],
      source: "print('server')",
    });

    sentMessages.length = 0;

    // Test handleDirAdd
    const dirPath = path.join(tmp, "ReplicatedStorage", "NewFolder");
    (daemon as any).handleDirAdd(dirPath);

    assert.strictEqual(sentMessages.length, 1);
    assert.deepStrictEqual(sentMessages[0], {
      type: "createInstance",
      className: "Folder",
      name: "NewFolder",
      parentPath: ["ReplicatedStorage"],
      source: undefined,
    });

    sentMessages.length = 0;

    // Test handleFileDelete for an unmapped file
    (daemon as any).handleFileDelete(serverScriptPath);

    assert.strictEqual(sentMessages.length, 1);
    assert.deepStrictEqual(sentMessages[0], {
      type: "deleteInstance",
      guid: undefined,
      path: ["ReplicatedStorage", "Test"],
    });

    sentMessages.length = 0;

    // Test handleDirDelete
    (daemon as any).handleDirDelete(dirPath);

    assert.strictEqual(sentMessages.length, 1);
    assert.deepStrictEqual(sentMessages[0], {
      type: "deleteInstance",
      guid: undefined,
      path: ["ReplicatedStorage", "NewFolder"],
    });
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("renaming a folder on disk moves the instance and preserves non-script descendants", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();

    // Studio has: ReplicatedStorage > Parent(Folder) > { Thing(Part), S(Script) }
    const tree = (daemon as any).tree;
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "gP",
        className: "Folder",
        name: "Parent",
        path: ["ReplicatedStorage", "Parent"],
        parentGuid: "rs",
      },
      {
        guid: "gPart",
        className: "Part",
        name: "Thing",
        path: ["ReplicatedStorage", "Parent", "Thing"],
        parentGuid: "gP",
      },
      {
        guid: "gS",
        className: "Script",
        name: "S",
        path: ["ReplicatedStorage", "Parent", "S"],
        parentGuid: "gP",
        source: "print(1)",
      },
    ]);

    // Write scripts to disk (creates Parent/ and maps the script), then record
    // folder inodes as the daemon does after a snapshot.
    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();

    const sentMessages: any[] = [];
    (daemon as any).ipc.send = (msg: any) => {
      sentMessages.push(msg);
      return true;
    };

    // Real rename preserves the directory inode.
    const parentDir = path.join(tmp, "ReplicatedStorage", "Parent");
    const renamedDir = path.join(tmp, "ReplicatedStorage", "Renamed");
    const oldScript = path.join(parentDir, "S.server.luau");
    fs.renameSync(parentDir, renamedDir);

    // Real ordering: the script's unlink (carrying its OLD path) is processed
    // first and tears the script node out of the tree, then the folder's
    // unlinkDir, then the folder's addDir. This desync is what broke content
    // matching; inode matching is immune to it.
    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleDirDelete(parentDir);
    (daemon as any).handleDirAdd(renamedDir);

    const moves = sentMessages.filter((m) => m.type === "moveInstance");
    assert.deepStrictEqual(moves, [
      {
        type: "moveInstance",
        guid: "gP",
        parentPath: ["ReplicatedStorage"],
        name: "Renamed",
        className: undefined,
        source: undefined,
      },
    ]);

    // The folder itself is never deleted (that would destroy the Part in Studio).
    const folderDeletes = sentMessages.filter(
      (m) => m.type === "deleteInstance" && m.guid === "gP",
    );
    assert.strictEqual(folderDeletes.length, 0, "folder is moved, not deleted");

    // The non-script Part survives and rode along to the new path.
    const part = tree.getNode("gPart");
    assert.ok(part, "Part node still exists");
    assert.deepStrictEqual(part.path, [
      "ReplicatedStorage",
      "Renamed",
      "Thing",
    ]);

    // The descendant script's own mapping is fixed proactively — not left
    // stale until a later round-trip self-heals it.
    const scriptMapping = (daemon as any).fileWriter.getMapping("gS");
    const newScriptPath = path.join(renamedDir, "S.server.luau");
    assert.strictEqual(
      path.resolve(scriptMapping.filePath),
      path.resolve(newScriptPath),
      "descendant script mapping points at its new path immediately",
    );

    // The physical file the folder rename already relocated is now recognized
    // as already-mapped when its own "add" event eventually arrives — not
    // treated as an unrelated new file.
    sentMessages.length = 0;
    (daemon as any).handleFileAdd(
      newScriptPath,
      fs.readFileSync(newScriptPath, "utf8"),
    );
    assert.strictEqual(
      sentMessages.filter((m) => m.type === "createInstance").length,
      0,
      "descendant script's add event does not spawn a spurious createInstance",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("moving a script file on disk moves the instance and preserves non-script descendants", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();

    // ReplicatedStorage > Module(ModuleScript) > Thing(Part, non-script descendant).
    const tree = (daemon as any).tree;
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "ws",
        className: "Workspace",
        name: "Workspace",
        path: ["Workspace"],
        parentGuid: "root",
      },
      {
        guid: "gM",
        className: "ModuleScript",
        name: "Module",
        path: ["ReplicatedStorage", "Module"],
        parentGuid: "rs",
        source: "return {}",
      },
      {
        guid: "gPart",
        className: "Part",
        name: "Thing",
        path: ["ReplicatedStorage", "Module", "Thing"],
        parentGuid: "gM",
      },
    ]);

    // Write the script to disk (creates ReplicatedStorage/Module.luau and maps
    // it), then record inodes as the daemon does after a snapshot.
    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();

    const sentMessages: any[] = [];
    (daemon as any).ipc.send = (msg: any) => {
      sentMessages.push(msg);
      return true;
    };

    // Real move preserves the file's inode (mirrors the reported bug: moving
    // Module.luau from ReplicatedStorage to Workspace).
    const oldScript = path.join(tmp, "ReplicatedStorage", "Module.luau");
    const newScript = path.join(tmp, "Workspace", "Module.luau");
    fs.mkdirSync(path.dirname(newScript), { recursive: true });
    fs.renameSync(oldScript, newScript);

    // Real chokidar ordering: unlink (old path) fires before add (new path).
    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleFileAdd(
      newScript,
      fs.readFileSync(newScript, "utf8"),
    );

    const moves = sentMessages.filter((m) => m.type === "moveInstance");
    assert.deepStrictEqual(moves, [
      {
        type: "moveInstance",
        guid: "gM",
        parentPath: ["Workspace"],
        name: "Module",
        className: undefined,
        source: undefined,
      },
    ]);

    // The script itself is never deleted (that would destroy the Part in Studio).
    const scriptDeletes = sentMessages.filter(
      (m) => m.type === "deleteInstance" && m.guid === "gM",
    );
    assert.strictEqual(scriptDeletes.length, 0, "script is moved, not deleted");

    // The non-script Part survives and rode along to the new path.
    const part = tree.getNode("gPart");
    assert.ok(part, "Part node still exists");
    assert.deepStrictEqual(part.path, ["Workspace", "Module", "Thing"]);
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("renaming a script's suffix propagates the class change (ModuleScript -> Script)", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    tree.applyFullSnapshot([
      { guid: "rs", className: "ReplicatedStorage", name: "ReplicatedStorage", path: ["ReplicatedStorage"], parentGuid: "root" },
      { guid: "gM", className: "ModuleScript", name: "Foo", path: ["ReplicatedStorage", "Foo"], parentGuid: "rs", source: "return {}" },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();

    const sentMessages: any[] = [];
    (daemon as any).ipc.send = (msg: any) => {
      sentMessages.push(msg);
      return true;
    };

    // Foo.luau -> Foo.server.luau: same name and directory, only the suffix
    // (and therefore the implied class) changes.
    const oldScript = path.join(tmp, "ReplicatedStorage", "Foo.luau");
    const newScript = path.join(tmp, "ReplicatedStorage", "Foo.server.luau");
    fs.renameSync(oldScript, newScript);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleFileAdd(newScript, fs.readFileSync(newScript, "utf8"));

    const moves = sentMessages.filter((m) => m.type === "moveInstance");
    assert.strictEqual(moves.length, 1);
    assert.strictEqual(moves[0].className, "Script", "class change is sent to Studio");

    const node = tree.getNode("gM");
    assert.strictEqual(node.className, "Script", "daemon tree reflects the new class");

    // FileWriter's mapping matches the actual renamed file, not the old path.
    const mapping = (daemon as any).fileWriter.getMapping("gM");
    assert.strictEqual(
      path.resolve(mapping.filePath),
      path.resolve(newScript),
      "file mapping points at the renamed file",
    );

    // The dangling buffered-delete timer must not fire and destroy the
    // instance after the fact.
    await wait(650);
    const deletes = sentMessages.filter(
      (m) => m.type === "deleteInstance" && m.guid === "gM",
    );
    assert.strictEqual(deletes.length, 0, "no delayed delete for the renamed instance");
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("renaming a script's suffix propagates the class change (Script -> ModuleScript)", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    tree.applyFullSnapshot([
      { guid: "rs", className: "ReplicatedStorage", name: "ReplicatedStorage", path: ["ReplicatedStorage"], parentGuid: "root" },
      { guid: "gS", className: "Script", name: "Foo", path: ["ReplicatedStorage", "Foo"], parentGuid: "rs", source: "print(1)" },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();

    const sentMessages: any[] = [];
    (daemon as any).ipc.send = (msg: any) => {
      sentMessages.push(msg);
      return true;
    };

    // Foo.server.luau -> Foo.luau: dropping the suffix implies ModuleScript.
    const oldScript = path.join(tmp, "ReplicatedStorage", "Foo.server.luau");
    const newScript = path.join(tmp, "ReplicatedStorage", "Foo.luau");
    fs.renameSync(oldScript, newScript);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleFileAdd(newScript, fs.readFileSync(newScript, "utf8"));

    const moves = sentMessages.filter((m) => m.type === "moveInstance");
    assert.strictEqual(moves.length, 1);
    assert.strictEqual(moves[0].className, "ModuleScript", "class change is sent to Studio");

    const node = tree.getNode("gS");
    assert.strictEqual(node.className, "ModuleScript", "daemon tree reflects the new class");

    await wait(650);
    const deletes = sentMessages.filter(
      (m) => m.type === "deleteInstance" && m.guid === "gS",
    );
    assert.strictEqual(deletes.length, 0, "no delayed delete for the renamed instance");
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("moving a script file relocates its nested-scripts children folder alongside it", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();

    // ReplicatedStorage > Module(ModuleScript) > Script1(Script, nested script descendant).
    const tree = (daemon as any).tree;
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "ws",
        className: "Workspace",
        name: "Workspace",
        path: ["Workspace"],
        parentGuid: "root",
      },
      {
        guid: "gM",
        className: "ModuleScript",
        name: "Module",
        path: ["ReplicatedStorage", "Module"],
        parentGuid: "rs",
        source: "return {}",
      },
      {
        guid: "gS1",
        className: "Script",
        name: "Script1",
        path: ["ReplicatedStorage", "Module", "Script1"],
        parentGuid: "gM",
        source: "print(1)",
      },
    ]);

    // Write the tree to disk: creates ReplicatedStorage/Module.luau AND the
    // nested-scripts container ReplicatedStorage/Module/Script1.server.luau.
    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();

    const oldFolder = path.join(tmp, "ReplicatedStorage", "Module");
    const oldNestedScript = path.join(oldFolder, "Script1.server.luau");
    assert.ok(
      fs.existsSync(oldNestedScript),
      "sanity: nested script written under Module/",
    );

    (daemon as any).ipc.send = () => true;

    // Only the script FILE is moved (mirrors the reported bug exactly): the
    // OS operation doesn't know to also move the sibling Module/ folder.
    const oldScript = path.join(tmp, "ReplicatedStorage", "Module.luau");
    const newScript = path.join(tmp, "Workspace", "Module.luau");
    fs.mkdirSync(path.dirname(newScript), { recursive: true });
    fs.renameSync(oldScript, newScript);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleFileAdd(
      newScript,
      fs.readFileSync(newScript, "utf8"),
    );

    const newFolder = path.join(tmp, "Workspace", "Module");
    const newNestedScript = path.join(newFolder, "Script1.server.luau");

    assert.ok(
      !fs.existsSync(oldFolder),
      "old children folder no longer exists",
    );
    assert.ok(
      fs.existsSync(newNestedScript),
      "children folder relocated alongside the script",
    );

    // FileWriter's mapping for the nested script is updated, not left stale.
    const mapping = (daemon as any).fileWriter.getMapping("gS1");
    assert.strictEqual(
      path.resolve(mapping.filePath),
      path.resolve(newNestedScript),
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("moving a folder to a different parent updates the tree's parent/child linkage, not just its path", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();

    // ReplicatedStorage > Foo(Folder) > Thing(Part); ServerStorage is the move destination.
    const tree = (daemon as any).tree;
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "ss",
        className: "ServerStorage",
        name: "ServerStorage",
        path: ["ServerStorage"],
        parentGuid: "root",
      },
      {
        guid: "gF",
        className: "Folder",
        name: "Foo",
        path: ["ReplicatedStorage", "Foo"],
        parentGuid: "rs",
      },
      {
        guid: "gPart",
        className: "Part",
        name: "Thing",
        path: ["ReplicatedStorage", "Foo", "Thing"],
        parentGuid: "gF",
      },
    ]);

    (daemon as any).ipc.send = () => true;

    // Move Foo from ReplicatedStorage to ServerStorage.
    (daemon as any).performInstanceMove(
      "gF",
      ["ReplicatedStorage", "Foo"],
      ["ServerStorage", "Foo"],
    );

    const rs = tree.getNode("rs");
    const ss = tree.getNode("ss");
    const folder = tree.getNode("gF");

    assert.deepStrictEqual(
      folder.path,
      ["ServerStorage", "Foo"],
      "path updated",
    );
    assert.strictEqual(
      folder.parent?.guid,
      "ss",
      "parent link points at the new parent",
    );
    assert.ok(
      !rs.children.has("gF"),
      "old parent no longer lists the folder as a child",
    );
    assert.ok(ss.children.has("gF"), "new parent lists the folder as a child");

    // A later delete of the OLD parent must not cascade into the moved subtree.
    tree.deleteInstance("rs");
    assert.ok(
      tree.getNode("gF"),
      "moved folder survives deletion of its old parent",
    );
    assert.ok(tree.getNode("gPart"), "moved folder's descendant survives too");
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("moving a script to become nested under another script resolves the correct parent", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();

    // ReplicatedStorage > { Module(ModuleScript) > Sub(Script), Other(ModuleScript) }.
    // destinationParent must resolve Other even though it's a script, not a folder.
    const tree = (daemon as any).tree;
    tree.applyFullSnapshot([
      { guid: "rs", className: "ReplicatedStorage", name: "ReplicatedStorage", path: ["ReplicatedStorage"], parentGuid: "root" },
      { guid: "gM", className: "ModuleScript", name: "Module", path: ["ReplicatedStorage", "Module"], parentGuid: "rs", source: "return {}" },
      { guid: "gSub", className: "Script", name: "Sub", path: ["ReplicatedStorage", "Module", "Sub"], parentGuid: "gM", source: "print(1)" },
      { guid: "gOther", className: "ModuleScript", name: "Other", path: ["ReplicatedStorage", "Other"], parentGuid: "rs", source: "return {}" },
    ]);

    (daemon as any).ipc.send = () => true;

    // Move Sub from under Module to under Other (a script, not a folder).
    (daemon as any).performInstanceMove(
      "gSub",
      ["ReplicatedStorage", "Module", "Sub"],
      ["ReplicatedStorage", "Other", "Sub"],
    );

    const module_ = tree.getNode("gM");
    const other = tree.getNode("gOther");
    const sub = tree.getNode("gSub");

    assert.deepStrictEqual(sub.path, ["ReplicatedStorage", "Other", "Sub"]);
    assert.strictEqual(
      sub.parent?.guid,
      "gOther",
      "parent link points at the script-class destination parent",
    );
    assert.ok(
      !module_.children.has("gSub"),
      "old script parent no longer lists Sub as a child",
    );
    assert.ok(
      other.children.has("gSub"),
      "new script parent lists Sub as a child",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("empty folder instances are preserved by cleanupDirectories", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();

    // Create an empty folder on disk
    const emptyFolderPath = path.join(tmp, "ReplicatedStorage", "MyFolder");
    fs.mkdirSync(emptyFolderPath, { recursive: true });

    // Snapshot contains an empty Folder instance at ReplicatedStorage/MyFolder
    const instances = [
      {
        guid: "r1",
        className: "Folder",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
      },
      {
        guid: "f1",
        className: "Folder",
        name: "MyFolder",
        path: ["ReplicatedStorage", "MyFolder"],
      },
    ];

    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: instances,
    });

    // Verify the empty directory was NOT cleaned up
    assert.ok(
      fs.existsSync(emptyFolderPath),
      "empty Folder instance directory was preserved",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Sourcemap staleness after external (filesystem) actions ---

test("sourcemap has no stale entries after a folder is renamed on disk", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    // ReplicatedStorage > Parent(Folder) > S(Script)
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "gP",
        className: "Folder",
        name: "Parent",
        path: ["ReplicatedStorage", "Parent"],
        parentGuid: "rs",
      },
      {
        guid: "gS",
        className: "Script",
        name: "S",
        path: ["ReplicatedStorage", "Parent", "S"],
        parentGuid: "gP",
        source: "print(1)",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();
    (daemon as any).regenerateSourcemap();
    (daemon as any).ipc.send = () => true;

    const before = readSourcemap();
    assert.ok(
      findInSourcemap(before, ["ReplicatedStorage", "Parent"]),
      "sanity: initial sourcemap has the folder at its original path",
    );

    // Real rename preserves the directory inode.
    const parentDir = path.join(tmp, "ReplicatedStorage", "Parent");
    const renamedDir = path.join(tmp, "ReplicatedStorage", "Renamed");
    const oldScript = path.join(parentDir, "S.server.luau");
    fs.renameSync(parentDir, renamedDir);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleDirDelete(parentDir);
    (daemon as any).handleDirAdd(renamedDir);

    const after = await readSettledSourcemap();
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Parent"]),
      undefined,
      "no stale entry left at the old folder path",
    );

    const folderNode = findInSourcemap(after, ["ReplicatedStorage", "Renamed"]);
    assert.ok(folderNode, "folder entry exists at the new path");
    assert.strictEqual(folderNode.guid, "gP");

    const scriptNode = findInSourcemap(after, [
      "ReplicatedStorage",
      "Renamed",
      "S",
    ]);
    assert.ok(scriptNode, "descendant script entry exists at the new path");
    const newScriptPath = path.join(renamedDir, "S.server.luau");
    assert.strictEqual(
      path.resolve(process.cwd(), scriptNode.filePaths[0]),
      path.resolve(newScriptPath),
      "descendant script's filePaths point at its new location, not the old one",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sourcemap has no stale entries after a folder is moved to a different parent on disk", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    // ReplicatedStorage > Foo(Folder) > S(Script); ServerStorage is the destination.
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "ss",
        className: "ServerStorage",
        name: "ServerStorage",
        path: ["ServerStorage"],
        parentGuid: "root",
      },
      {
        guid: "gF",
        className: "Folder",
        name: "Foo",
        path: ["ReplicatedStorage", "Foo"],
        parentGuid: "rs",
      },
      {
        guid: "gS",
        className: "Script",
        name: "S",
        path: ["ReplicatedStorage", "Foo", "S"],
        parentGuid: "gF",
        source: "print(1)",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();
    (daemon as any).regenerateSourcemap();
    (daemon as any).ipc.send = () => true;

    assert.ok(
      findInSourcemap(readSourcemap(), ["ReplicatedStorage", "Foo"]),
      "sanity: initial sourcemap has the folder under ReplicatedStorage",
    );

    const oldDir = path.join(tmp, "ReplicatedStorage", "Foo");
    const newDir = path.join(tmp, "ServerStorage", "Foo");
    const oldScript = path.join(oldDir, "S.server.luau");
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleDirDelete(oldDir);
    (daemon as any).handleDirAdd(newDir);

    const after = await readSettledSourcemap();
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Foo"]),
      undefined,
      "no stale entry left under the old parent",
    );

    const folderNode = findInSourcemap(after, ["ServerStorage", "Foo"]);
    assert.ok(folderNode, "folder entry exists under the new parent");
    assert.strictEqual(folderNode.guid, "gF");

    const scriptNode = findInSourcemap(after, ["ServerStorage", "Foo", "S"]);
    assert.ok(
      scriptNode,
      "descendant script entry exists under the new parent",
    );
    const newScriptPath = path.join(newDir, "S.server.luau");
    assert.strictEqual(
      path.resolve(process.cwd(), scriptNode.filePaths[0]),
      path.resolve(newScriptPath),
      "descendant script's filePaths point at its new location",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sourcemap prunes the entry when a folder is deleted on disk", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "gP",
        className: "Folder",
        name: "Parent",
        path: ["ReplicatedStorage", "Parent"],
        parentGuid: "rs",
      },
      {
        guid: "gS",
        className: "Script",
        name: "S",
        path: ["ReplicatedStorage", "Parent", "S"],
        parentGuid: "gP",
        source: "print(1)",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();
    (daemon as any).regenerateSourcemap();
    (daemon as any).ipc.send = () => true;

    assert.ok(
      findInSourcemap(readSourcemap(), ["ReplicatedStorage", "Parent"]),
      "sanity: initial sourcemap has the folder",
    );

    const parentDir = path.join(tmp, "ReplicatedStorage", "Parent");
    const script = path.join(parentDir, "S.server.luau");
    fs.rmSync(parentDir, { recursive: true, force: true });

    // Real ordering: the descendant script's unlink fires before the folder's.
    (daemon as any).handleFileDelete(script);
    (daemon as any).handleDirDelete(parentDir);

    // No matching add arrives — let the buffered deletes flush for real.
    await wait(650);

    const after = await readSettledSourcemap();
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Parent"]),
      undefined,
      "folder entry pruned",
    );
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Parent", "S"]),
      undefined,
      "descendant script entry pruned too",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sourcemap has no stale entry after a script is renamed on disk", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "gM",
        className: "ModuleScript",
        name: "Module",
        path: ["ReplicatedStorage", "Module"],
        parentGuid: "rs",
        source: "return {}",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();
    (daemon as any).regenerateSourcemap();
    (daemon as any).ipc.send = () => true;

    assert.ok(
      findInSourcemap(readSourcemap(), ["ReplicatedStorage", "Module"]),
      "sanity: initial sourcemap has the script",
    );

    const oldScript = path.join(tmp, "ReplicatedStorage", "Module.luau");
    const newScript = path.join(tmp, "ReplicatedStorage", "IGotRenamed.luau");
    fs.renameSync(oldScript, newScript);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleFileAdd(
      newScript,
      fs.readFileSync(newScript, "utf8"),
    );

    const after = await readSettledSourcemap();
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Module"]),
      undefined,
      "no stale entry left at the old name",
    );

    const node = findInSourcemap(after, ["ReplicatedStorage", "IGotRenamed"]);
    assert.ok(node, "entry exists at the new name");
    assert.strictEqual(node.guid, "gM");
    assert.strictEqual(
      path.resolve(process.cwd(), node.filePaths[0]),
      path.resolve(newScript),
      "filePaths point at the renamed file",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sourcemap has no stale entries after a script (with a nested descendant) is moved on disk", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    // ReplicatedStorage > Module(ModuleScript) > Script1(Script, nested).
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "ws",
        className: "Workspace",
        name: "Workspace",
        path: ["Workspace"],
        parentGuid: "root",
      },
      {
        guid: "gM",
        className: "ModuleScript",
        name: "Module",
        path: ["ReplicatedStorage", "Module"],
        parentGuid: "rs",
        source: "return {}",
      },
      {
        guid: "gS1",
        className: "Script",
        name: "Script1",
        path: ["ReplicatedStorage", "Module", "Script1"],
        parentGuid: "gM",
        source: "print(1)",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();
    (daemon as any).regenerateSourcemap();
    (daemon as any).ipc.send = () => true;

    const before = readSourcemap();
    assert.ok(findInSourcemap(before, ["ReplicatedStorage", "Module"]));
    assert.ok(
      findInSourcemap(before, ["ReplicatedStorage", "Module", "Script1"]),
    );

    // Only the script FILE is moved (the sibling children folder is not
    // touched by the OS operation itself — the daemon has to relocate it).
    const oldScript = path.join(tmp, "ReplicatedStorage", "Module.luau");
    const newScript = path.join(tmp, "Workspace", "Module.luau");
    fs.mkdirSync(path.dirname(newScript), { recursive: true });
    fs.renameSync(oldScript, newScript);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleFileAdd(
      newScript,
      fs.readFileSync(newScript, "utf8"),
    );

    const after = await readSettledSourcemap();
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Module"]),
      undefined,
      "no stale entry left at the old location",
    );

    const moduleNode = findInSourcemap(after, ["Workspace", "Module"]);
    assert.ok(moduleNode, "script entry exists at the new location");
    assert.strictEqual(moduleNode.guid, "gM");
    assert.strictEqual(
      path.resolve(process.cwd(), moduleNode.filePaths[0]),
      path.resolve(newScript),
    );

    const nestedNode = findInSourcemap(after, [
      "Workspace",
      "Module",
      "Script1",
    ]);
    assert.ok(
      nestedNode,
      "nested descendant entry exists under the new location",
    );
    assert.strictEqual(nestedNode.guid, "gS1");
    const newNestedPath = path.join(
      tmp,
      "Workspace",
      "Module",
      "Script1.server.luau",
    );
    assert.strictEqual(
      path.resolve(process.cwd(), nestedNode.filePaths[0]),
      path.resolve(newNestedPath),
      "nested descendant's filePaths point at its relocated file, not the old one",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sourcemap prunes the entry when a script is deleted on disk", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "gM",
        className: "ModuleScript",
        name: "Module",
        path: ["ReplicatedStorage", "Module"],
        parentGuid: "rs",
        source: "return {}",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();
    (daemon as any).regenerateSourcemap();
    (daemon as any).ipc.send = () => true;

    assert.ok(
      findInSourcemap(readSourcemap(), ["ReplicatedStorage", "Module"]),
      "sanity: initial sourcemap has the script",
    );

    const scriptPath = path.join(tmp, "ReplicatedStorage", "Module.luau");
    fs.rmSync(scriptPath);
    (daemon as any).handleFileDelete(scriptPath);

    // No matching add arrives — let the buffered delete flush for real.
    await wait(650);

    const after = await readSettledSourcemap();
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Module"]),
      undefined,
      "script entry pruned",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("live sync stamps _quack.placeId on the sourcemap and keeps it when an unsaved place connects", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();
    (daemon as any).ipc.send = () => true;

    const snapshot = [
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
    ];

    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: snapshot,
      placeId: 123456789,
    });

    assert.strictEqual(readSourcemap()._quack?.placeId, 123456789);

    // Quack: an unsaved place (PlaceId 0) connecting to a stamped project is refused
    // (the daemon used to accept it and drop the stamp; with auto-connect, "File > New" would then
    // wipe the project). The stamp stays.
    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: snapshot,
      placeId: 0,
    });

    assert.strictEqual(readSourcemap()._quack?.placeId, 123456789);
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a burst of Studio changes produces one sourcemap write and one directory cleanup, and identical regens skip the write", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();
    (daemon as any).ipc.send = () => true;

    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: [
        {
          guid: "rs",
          className: "ReplicatedStorage",
          name: "ReplicatedStorage",
          path: ["ReplicatedStorage"],
          parentGuid: "root",
        },
      ],
    });

    const generator = (daemon as any).sourcemapGenerator;
    let writes = 0;
    const originalWrite = generator.write.bind(generator);
    generator.write = (...args: any[]) => {
      writes++;
      return originalWrite(...args);
    };

    let cleanups = 0;
    const fileWriter = (daemon as any).fileWriter;
    const originalCleanup = fileWriter.cleanupEmptyDirectories.bind(fileWriter);
    fileWriter.cleanupEmptyDirectories = (...args: any[]) => {
      cleanups++;
      return originalCleanup(...args);
    };

    const messages = Array.from({ length: 50 }, (_, i) => ({
      type: "instanceUpdated",
      data: {
        guid: `f${i}`,
        className: "Folder",
        name: `F${i}`,
        path: ["ReplicatedStorage", `F${i}`],
        parentGuid: "rs",
      },
    }));
    (daemon as any).handleStudioMessage({ type: "batch", messages });

    const after = await readSettledSourcemap();
    assert.equal(writes, 1, "50 updates coalesce into one write");
    assert.equal(cleanups, 1, "50 updates share one directory walk");
    assert.ok(findInSourcemap(after, ["ReplicatedStorage", "F49"]));

    // Regenerating an unchanged tree leaves the file untouched
    const mtimeBefore = fs.statSync(config.sourcemapPath).mtimeMs;
    await wait(20);
    (daemon as any).regenerateSourcemap();
    assert.equal(fs.statSync(config.sourcemapPath).mtimeMs, mtimeBefore);
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("same-name siblings stay separate in the sourcemap through duplicate, rename, and delete", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;

  const guidsAt = (sourcemap: any, name: string): string[] =>
    findInSourcemap(sourcemap, ["ReplicatedStorage"])
      .children.filter((c: any) => c.name === name)
      .map((c: any) => c.guid)
      .sort();

  const script = (guid: string, name: string) => ({
    guid,
    className: "ModuleScript",
    name,
    path: ["ReplicatedStorage", name],
    parentGuid: "rs",
    source: `return "${guid}"`,
  });

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();
    (daemon as any).ipc.send = () => true;

    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: [
        {
          guid: "rs",
          className: "ReplicatedStorage",
          name: "ReplicatedStorage",
          path: ["ReplicatedStorage"],
          parentGuid: "root",
        },
        script("a", "Mod"),
      ],
    });

    // Duplicating in Studio: new guid, identical name/class/path
    (daemon as any).handleStudioMessage({
      type: "instanceUpdated",
      data: script("b", "Mod"),
    });
    assert.deepEqual(guidsAt(await readSettledSourcemap(), "Mod"), ["a", "b"]);

    // Editing one copy doesn't merge or drop the other
    (daemon as any).handleStudioMessage({
      type: "scriptChanged",
      data: script("a", "Mod"),
    });
    assert.deepEqual(guidsAt(await readSettledSourcemap(), "Mod"), ["a", "b"]);

    // Renaming one leaves the other in place
    (daemon as any).handleStudioMessage({
      type: "instanceUpdated",
      data: script("b", "Other"),
    });
    let after = await readSettledSourcemap();
    assert.deepEqual(guidsAt(after, "Mod"), ["a"]);
    assert.deepEqual(guidsAt(after, "Other"), ["b"]);

    // Deleting one of two same-name siblings keeps the survivor
    (daemon as any).handleStudioMessage({
      type: "instanceUpdated",
      data: script("c", "Mod"),
    });
    (daemon as any).handleStudioMessage({
      type: "deleted",
      data: { guid: "a" },
    });
    after = await readSettledSourcemap();
    assert.deepEqual(guidsAt(after, "Mod"), ["c"]);
    assert.deepEqual(guidsAt(after, "Other"), ["b"]);
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isVersionCompatible only cares about major.minor", () => {
  assert.equal(isVersionCompatible("2.0.0", "2.0.3"), true);
  assert.equal(isVersionCompatible("2.0.0", "2.1.0"), false);
  assert.equal(isVersionCompatible("2.0.0", "3.0.0"), false);
});

test("a snapshot from a different place is refused before anything is written", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();
    const sent: any[] = [];
    (daemon as any).ipc.send = (msg: any) => {
      sent.push(msg);
      return true;
    };
    (daemon as any).ipc.sendError = (message: string) => {
      sent.push({ type: "error", message });
      return true;
    };

    const placeA = [
      { guid: "rs", className: "ReplicatedStorage", name: "ReplicatedStorage", path: ["ReplicatedStorage"], parentGuid: "root" },
      { guid: "a1", className: "ModuleScript", name: "OnlyInA", path: ["ReplicatedStorage", "OnlyInA"], parentGuid: "rs", source: "return 'a'" },
    ];
    (daemon as any).handleStudioMessage({ type: "fullSnapshot", data: placeA, placeId: 111 });
    const scriptA = path.join(tmp, "ReplicatedStorage", "OnlyInA.luau");
    assert.ok(fs.existsSync(scriptA));
    assert.strictEqual(readSourcemap()._quack?.placeId, 111);

    // Place B has none of A's scripts: accepting it would delete OnlyInA as an orphan
    const placeB = [
      { guid: "rs2", className: "ReplicatedStorage", name: "ReplicatedStorage", path: ["ReplicatedStorage"], parentGuid: "root" },
    ];
    (daemon as any).handleStudioMessage({ type: "fullSnapshot", data: placeB, placeId: 222 });

    assert.ok(fs.existsSync(scriptA), "place B must not delete place A's files");
    assert.strictEqual(fs.readFileSync(scriptA, "utf8"), "return 'a'");
    assert.strictEqual(readSourcemap()._quack?.placeId, 111);
    assert.ok(sent.some((m) => m.type === "error" && /place 111/.test(m.message)));
    assert.ok(sent.some((m) => m.type === "daemonDisconnect"));

    // The same place reconnecting is still accepted
    sent.length = 0;
    (daemon as any).handleStudioMessage({ type: "fullSnapshot", data: placeA, placeId: 111 });
    assert.ok(!sent.some((m) => m.type === "daemonDisconnect"));
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
  }
});

async function withMergeDaemon(
  body: (ctx: {
    daemon: SyncDaemon;
    tmp: string;
    file: string;
    sent: any[];
    waitMerge: () => Promise<Record<string, unknown>>;
  }) => Promise<void>,
): Promise<void> {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;
  try {
    config.syncDir = path.join(tmp, "sync");
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    daemon = new SyncDaemon();
    const sent: any[] = [];
    (daemon as any).ipc.send = (msg: any) => {
      sent.push(msg);
      return true;
    };
    // Real git merge-file; the analyzer finds nothing, so the text merge stands
    // Never this machine's config.json or AI CLIs: Claude is the one AI there
    daemon.mergeTools = {
      ...daemon.mergeTools,
      analyze: async () => [],
      settings: () => ({ ...config.merge, ai: true, provider: "" }),
      detect: async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: false, loggedIn: false } }),
    };
    let resolveMerge: (e: Record<string, unknown>) => void = () => {};
    daemon.onMergeDone = (_guid, entry) => resolveMerge(entry);
    const waitMerge = () => new Promise<Record<string, unknown>>((r) => (resolveMerge = r));

    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      placeId: 1,
      data: [
        { guid: "ss", className: "ServerStorage", name: "ServerStorage", path: ["ServerStorage"], parentGuid: "root" },
        { guid: "cfg", className: "ModuleScript", name: "Cfg", path: ["ServerStorage", "Cfg"], parentGuid: "ss", source: "local a = 1\nlocal b = 2\nlocal c = 3\n" },
      ],
    });
    const file = path.join(tmp, "sync", "ServerStorage", "Cfg.luau");
    await body({ daemon, tmp, file, sent, waitMerge });
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
  }
}

test("a Studio edit racing a disk edit is merged, and both sides get the merge", async () => {
  await withMergeDaemon(async ({ daemon, tmp, file, sent, waitMerge }) => {
    // The agent saved line a; Studio, still on the snapshot text, changed line c
    fs.writeFileSync(file, "local a = 100\nlocal b = 2\nlocal c = 3\n");
    const done = waitMerge();
    (daemon as any).handleStudioMessage({
      type: "scriptChanged",
      data: {
        guid: "cfg", path: ["ServerStorage", "Cfg"], className: "ModuleScript",
        source: "local a = 1\nlocal b = 2\nlocal c = 300\n",
        base: "local a = 1\nlocal b = 2\nlocal c = 3\n",
      },
    });
    const entry = await done;

    const merged = "local a = 100\nlocal b = 2\nlocal c = 300\n";
    assert.equal(entry.method, "text");
    assert.equal(fs.readFileSync(file, "utf8"), merged);
    assert.deepEqual(sent.filter((m) => m.type === "patchScript"), [{ type: "patchScript", guid: "cfg", source: merged }]);
    const log = fs.readFileSync(path.join(tmp, ".quack", "merge-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log.length, 1);
    assert.equal(log[0].file, "ServerStorage/Cfg.luau");
    // No temp file left behind by the atomic write
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes("quack-tmp")), []);
  });
});

test("a Studio edit made on top of the current disk text is written as before, no merge", async () => {
  await withMergeDaemon(async ({ daemon, tmp, file, sent }) => {
    (daemon as any).handleStudioMessage({
      type: "scriptChanged",
      data: {
        guid: "cfg", path: ["ServerStorage", "Cfg"], className: "ModuleScript",
        source: "local a = 1\nlocal b = 20\nlocal c = 3\n",
        base: "local a = 1\nlocal b = 2\nlocal c = 3\n",
      },
    });
    assert.equal(fs.readFileSync(file, "utf8"), "local a = 1\nlocal b = 20\nlocal c = 3\n");
    assert.equal(sent.filter((m) => m.type === "patchScript").length, 0);
    assert.equal(fs.existsSync(path.join(tmp, ".quack")), false);
  });
});

test("a merge that cannot be checked clean keeps Studio and saves the agent's version", async () => {
  await withMergeDaemon(async ({ daemon, tmp, file, waitMerge }) => {
    daemon.mergeTools = {
      ...daemon.mergeTools,
      analyze: async (text) => (text.includes("300") && text.includes("100") ? ["new error"] : []),
      aiMerge: async () => "still bad 100 300",
    };
    fs.writeFileSync(file, "local a = 100\nlocal b = 2\nlocal c = 3\n");
    const done = waitMerge();
    (daemon as any).handleStudioMessage({
      type: "scriptChanged",
      data: {
        guid: "cfg", path: ["ServerStorage", "Cfg"], className: "ModuleScript",
        source: "local a = 1\nlocal b = 2\nlocal c = 300\n",
        base: "local a = 1\nlocal b = 2\nlocal c = 3\n",
      },
    });
    const entry = await done;
    assert.equal(entry.method, "fallback");
    assert.equal(fs.readFileSync(file, "utf8"), "local a = 1\nlocal b = 2\nlocal c = 300\n");
    const saved = path.join(tmp, String(entry.agentVersion));
    assert.equal(fs.readFileSync(saved, "utf8"), "local a = 100\nlocal b = 2\nlocal c = 3\n");
  });
});

test("when Studio wins a line both sides changed, the agent's version is saved", async () => {
  await withMergeDaemon(async ({ daemon, tmp, file, waitMerge }) => {
    fs.writeFileSync(file, "local a = 1\nlocal b = 22\nlocal c = 3\n");
    const done = waitMerge();
    (daemon as any).handleStudioMessage({
      type: "scriptChanged",
      data: {
        guid: "cfg", path: ["ServerStorage", "Cfg"], className: "ModuleScript",
        source: "local a = 1\nlocal b = 99\nlocal c = 3\n",
        base: "local a = 1\nlocal b = 2\nlocal c = 3\n",
      },
    });
    const entry = await done;
    assert.equal(entry.conflictingHunks, 1);
    assert.equal(fs.readFileSync(file, "utf8"), "local a = 1\nlocal b = 99\nlocal c = 3\n");
    assert.equal(fs.readFileSync(path.join(tmp, String(entry.agentVersion)), "utf8"), "local a = 1\nlocal b = 22\nlocal c = 3\n");
  });
});

test("Studio edited and reverted to the base while the disk moved: the disk edit stands", async () => {
  await withMergeDaemon(async ({ daemon, file, sent }) => {
    const agent = "local a = 100\nlocal b = 2\nlocal c = 3\n";
    fs.writeFileSync(file, agent);
    (daemon as any).handleStudioMessage({
      type: "scriptChanged",
      data: {
        guid: "cfg", path: ["ServerStorage", "Cfg"], className: "ModuleScript",
        source: "local a = 1\nlocal b = 2\nlocal c = 3\n",
        base: "local a = 1\nlocal b = 2\nlocal c = 3\n",
      },
    });
    assert.equal(fs.readFileSync(file, "utf8"), agent);
    assert.deepEqual(sent.filter((m) => m.type === "patchScript"), [{ type: "patchScript", guid: "cfg", source: agent }]);
  });
});

test("a file deleted during the merge is not recreated from the stale input", async () => {
  await withMergeDaemon(async ({ daemon, file, waitMerge }) => {
    daemon.mergeTools = {
      ...daemon.mergeTools,
      analyze: async () => {
        fs.rmSync(file, { force: true });
        return [];
      },
    };
    fs.writeFileSync(file, "local a = 100\nlocal b = 2\nlocal c = 3\n");
    const done = waitMerge();
    (daemon as any).handleStudioMessage({
      type: "scriptChanged",
      data: {
        guid: "cfg", path: ["ServerStorage", "Cfg"], className: "ModuleScript",
        source: "local a = 1\nlocal b = 2\nlocal c = 300\n",
        base: "local a = 1\nlocal b = 2\nlocal c = 3\n",
      },
    });
    const entry = await done;
    assert.equal(entry.method, "aborted");
    assert.equal(fs.existsSync(file), false);
  });
});

test("a failed merge backs up what the disk holds at that moment, not the merge's input", async () => {
  await withMergeDaemon(async ({ daemon, tmp, file, waitMerge }) => {
    daemon.mergeTools = {
      ...daemon.mergeTools,
      merge3: async () => {
        fs.writeFileSync(file, "local a = 777 -- saved during the merge\n");
        throw new Error("boom");
      },
    };
    fs.writeFileSync(file, "local a = 100\nlocal b = 2\nlocal c = 3\n");
    const done = waitMerge();
    (daemon as any).handleStudioMessage({
      type: "scriptChanged",
      data: {
        guid: "cfg", path: ["ServerStorage", "Cfg"], className: "ModuleScript",
        source: "local a = 1\nlocal b = 2\nlocal c = 300\n",
        base: "local a = 1\nlocal b = 2\nlocal c = 3\n",
      },
    });
    const entry = await done;
    assert.equal(entry.method, "error");
    const conflictsDir = path.join(tmp, ".quack", "conflicts", "ServerStorage");
    const saved = fs.readdirSync(conflictsDir).map((n) => fs.readFileSync(path.join(conflictsDir, n), "utf8")).sort();
    assert.deepEqual(saved, ["local a = 100\nlocal b = 2\nlocal c = 3\n", "local a = 777 -- saved during the merge\n"].sort());
  });
});

test("Studio closing the place does not end the daemon", async () => {
  await withMergeDaemon(async ({ daemon }) => {
    const realExit = process.exit;
    let exited = false;
    (process as any).exit = () => {
      exited = true;
    };
    try {
      (daemon as any).handleStudioMessage({ type: "clientDisconnect" });
      await wait(100);
      assert.equal(exited, false);
    } finally {
      process.exit = realExit;
    }
  });
});

test("after a refused place, that Studio's changes are ignored, batch entries included", async () => {
  await withMergeDaemon(async ({ daemon, file, tmp }) => {
    const before = fs.readFileSync(file, "utf8");
    (daemon as any).handleStudioMessage({ type: "fullSnapshot", placeId: 999, data: [] });
    (daemon as any).handleStudioMessage({
      type: "batch",
      messages: [
        { type: "scriptChanged", data: { guid: "cfg", path: ["ServerStorage", "Cfg"], className: "ModuleScript", source: "return 'wrong place'\n" } },
        { type: "deleted", data: { guid: "cfg" } },
      ],
    });
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.ok(fs.existsSync(file));

    // The right place reconnecting is accepted and lifts the block
    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      placeId: 1,
      data: [
        { guid: "ss", className: "ServerStorage", name: "ServerStorage", path: ["ServerStorage"], parentGuid: "root" },
        { guid: "cfg", className: "ModuleScript", name: "Cfg", path: ["ServerStorage", "Cfg"], parentGuid: "ss", source: before },
      ],
    });
    (daemon as any).handleStudioMessage({
      type: "scriptChanged",
      data: { guid: "cfg", path: ["ServerStorage", "Cfg"], className: "ModuleScript", source: "return 'right place'\n" },
    });
    assert.equal(fs.readFileSync(file, "utf8"), "return 'right place'\n");
    void tmp;
  });
});

test("a batch nested inside a batch is ignored, not recursed into", async () => {
  await withMergeDaemon(async ({ daemon, file }) => {
    const before = fs.readFileSync(file, "utf8");
    (daemon as any).handleStudioMessage({
      type: "batch",
      messages: [{ type: "batch", messages: [{ type: "scriptChanged", data: { guid: "cfg", path: ["ServerStorage", "Cfg"], className: "ModuleScript", source: "nested\n" } }] }],
    });
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("a reconnect does not rewrite scripts that are already identical on disk", async () => {
  await withMergeDaemon(async ({ daemon, file }) => {
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const before = fs.statSync(file).mtimeMs;
    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      placeId: 1,
      data: [
        { guid: "ss", className: "ServerStorage", name: "ServerStorage", path: ["ServerStorage"], parentGuid: "root" },
        { guid: "cfg", className: "ModuleScript", name: "Cfg", path: ["ServerStorage", "Cfg"], parentGuid: "ss", source: fs.readFileSync(file, "utf8") },
      ],
    });
    assert.equal(fs.statSync(file).mtimeMs, before);
  });
});

test("renaming a folder whose scripts sit under Models and Parts sends one move and creates nothing", async () => {
  const tmp = makeTempDir();
  const prev = { syncDir: config.syncDir, sourcemapPath: config.sourcemapPath, port: config.port, live: config.liveFsSync };
  let daemon: SyncDaemon | undefined;
  try {
    config.syncDir = path.join(tmp, "sync");
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prev.live, enabled: true };
    daemon = new SyncDaemon();
    const sent: any[] = [];
    (daemon as any).ipc.send = (msg: any) => {
      sent.push(msg);
      return true;
    };
    (daemon as any).ipc.deleteInstance = (guid?: string, p?: string[]) => {
      sent.push({ type: "deleteInstance", guid, path: p });
      return true;
    };
    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      placeId: 1,
      data: [
        { guid: "rs", className: "ReplicatedStorage", name: "ReplicatedStorage", path: ["ReplicatedStorage"], parentGuid: "root" },
        { guid: "k", className: "Folder", name: "K", path: ["ReplicatedStorage", "K"], parentGuid: "rs" },
        { guid: "a", className: "Model", name: "A", path: ["ReplicatedStorage", "K", "A"], parentGuid: "k" },
        { guid: "n", className: "Model", name: "Normal", path: ["ReplicatedStorage", "K", "A", "Normal"], parentGuid: "a" },
        { guid: "t", className: "Part", name: "Torso", path: ["ReplicatedStorage", "K", "A", "Normal", "Torso"], parentGuid: "n" },
        { guid: "c", className: "Model", name: "Chimera", path: ["ReplicatedStorage", "K", "A", "Normal", "Torso", "Chimera"], parentGuid: "t" },
        { guid: "s", className: "Script", name: "Script", path: ["ReplicatedStorage", "K", "A", "Normal", "Torso", "Chimera", "Script"], parentGuid: "c", source: "print(1)" },
      ],
    });
    await wait(300);
    sent.length = 0;

    fs.renameSync(path.join(tmp, "sync", "ReplicatedStorage", "K"), path.join(tmp, "sync", "ReplicatedStorage", "K2"));
    await wait(1500);

    const summary = sent.map((m) => `${m.type} ${m.guid ?? ""} ${(m.parentPath ?? m.path ?? []).join("/")} ${m.name ?? ""}`.trim());
    assert.deepEqual(sent.filter((m) => m.type === "createInstance"), [], summary.join("\n"));
    assert.deepEqual(sent.filter((m) => m.type === "deleteInstance"), [], summary.join("\n"));
    assert.equal(sent.filter((m) => m.type === "moveInstance").length >= 1, true, summary.join("\n"));
  } finally {
    await daemon?.stop();
    config.syncDir = prev.syncDir;
    config.sourcemapPath = prev.sourcemapPath;
    config.port = prev.port;
    config.liveFsSync = prev.live;
  }
});

test("renaming a folder creates nothing when the Models with scripts sit under one of several same-name siblings", async () => {
  // The Anime Astral copy: 9 UnionOperations named AuraCirculo side by side, one holding Models
  const tmp = makeTempDir();
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
    const map = ["ServerStorage", "Map"];
    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      placeId: 1,
      data: [
        { guid: "ss", className: "ServerStorage", name: "ServerStorage", path: ["ServerStorage"], parentGuid: "root" },
        { guid: "map", className: "Folder", name: "Map", path: map, parentGuid: "ss" },
        { guid: "u1", className: "UnionOperation", name: "Aura", path: [...map, "Aura"], parentGuid: "map" },
        { guid: "u2", className: "UnionOperation", name: "Aura", path: [...map, "Aura"], parentGuid: "map" },
        { guid: "u3", className: "UnionOperation", name: "Aura", path: [...map, "Aura"], parentGuid: "map" },
        { guid: "levi", className: "Model", name: "Levi", path: [...map, "Aura", "Levi"], parentGuid: "u2" },
        { guid: "s1", className: "Script", name: "Script", path: [...map, "Aura", "Levi", "Script"], parentGuid: "levi", source: "print(1)" },
        { guid: "rig", className: "Model", name: "Rig", path: [...map, "Aura", "Rig"], parentGuid: "u2" },
        { guid: "s2", className: "Script", name: "Script", path: [...map, "Aura", "Rig", "Script"], parentGuid: "rig", source: "print(2)" },
      ],
    });
    await wait(300);
    sent.length = 0;

    fs.renameSync(path.join(tmp, "sync", "ServerStorage", "Map"), path.join(tmp, "sync", "ServerStorage", "Map2"));
    await wait(1500);

    const summary = sent.map((m) => `${m.type} ${m.guid ?? ""} ${(m.parentPath ?? m.path ?? []).join("/")} ${m.name ?? ""}`.trim());
    assert.deepEqual(sent.filter((m) => m.type === "createInstance"), [], summary.join("\n"));
    assert.deepEqual(sent.filter((m) => m.type === "deleteInstance"), [], summary.join("\n"));
    assert.equal(sent.filter((m) => m.type === "moveInstance").length >= 1, true, summary.join("\n"));
  } finally {
    await daemon?.stop();
    config.syncDir = prev.syncDir;
    config.sourcemapPath = prev.sourcemapPath;
    config.port = prev.port;
    config.liveFsSync = prev.live;
  }
});

test("instances that arrive before their parent are adopted when the parent arrives", async () => {
  await withMergeDaemon(async ({ daemon }) => {
    const ws = { guid: "ws", className: "Workspace", name: "Workspace", path: ["Workspace"], parentGuid: "root" };
    (daemon as any).handleStudioMessage({ type: "instanceUpdated", data: ws });
    const children = [];
    for (let i = 0; i < 300; i++) {
      children.push({ type: "instanceUpdated", data: { guid: `p${i}`, className: "Part", name: `P${i}`, path: ["Workspace", "Box", `P${i}`], parentGuid: "box" } });
    }
    // Children first, the parent folder last, in the same batch
    (daemon as any).handleStudioMessage({
      type: "batch",
      messages: [...children, { type: "instanceUpdated", data: { guid: "box", className: "Folder", name: "Box", path: ["Workspace", "Box"], parentGuid: "ws" } }],
    });
    const box = (daemon as any).tree.getNode("box");
    assert.equal(box.children.size, 300);
    assert.equal((daemon as any).tree.getNode("p7").parent, box);

    // Deleting the parent takes the adopted children with it
    (daemon as any).handleStudioMessage({ type: "deleted", data: { guid: "box" } });
    assert.equal((daemon as any).tree.getNode("p7"), undefined);
  });
});

test("a folder stamped by the Azul-era daemon (_azul) still refuses another place", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;
  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    // A sourcemap as folders synced before Quack 1.0 have it
    fs.writeFileSync(config.sourcemapPath, JSON.stringify({ name: "Game", className: "DataModel", children: [], _azul: { placeId: 111 } }));

    daemon = new SyncDaemon();
    const sent: any[] = [];
    (daemon as any).ipc.send = (msg: any) => (sent.push(msg), true);
    (daemon as any).ipc.sendError = (message: string) => (sent.push({ type: "error", message }), true);
    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      placeId: 222,
      data: [{ guid: "rs", className: "ReplicatedStorage", name: "ReplicatedStorage", path: ["ReplicatedStorage"], parentGuid: "root" }],
    });
    assert.ok(sent.some((m) => m.type === "error" && /place 111/.test(m.message)), JSON.stringify(sent));
  } finally {
    await daemon?.stop?.();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the 2.4 plugin from before Quack's own numbering is accepted by Quack 1.0, both ways", () => {
  assert.equal(isVersionCompatible("2.4.0", "1.0.0"), true);
  assert.equal(isVersionCompatible("1.0.3", "2.4.1"), true);
  assert.equal(isVersionCompatible("1.0.0", "1.0.9"), true);
  assert.equal(isVersionCompatible("2.3.0", "1.0.0"), false);
  assert.equal(isVersionCompatible("1.1.0", "2.4.0"), false);
});

test("a script's text changing does not rebuild the sourcemap; a rename does", async () => {
  // The sourcemap holds names, classes and files, never text: rebuilding it on every save held
  // the daemon ~0.5 s per edit on a 262k-instance place
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;
  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    daemon = new SyncDaemon();
    const d = daemon as any;
    d.handleStudioMessage({
      type: "fullSnapshot",
      data: [
        { guid: "r1", className: "Folder", name: "ReplicatedStorage", path: ["ReplicatedStorage"] },
        { guid: "s1", className: "ModuleScript", name: "Foo", path: ["ReplicatedStorage", "Foo"], source: "return 1" },
      ],
    });
    let rebuilds = 0;
    const original = d.regenerateSourcemap.bind(d);
    d.regenerateSourcemap = () => {
      rebuilds++;
      original();
    };
    const settle = () => new Promise((r) => setTimeout(r, 400));

    d.handleStudioMessage({ type: "scriptChanged", data: { guid: "s1", path: ["ReplicatedStorage", "Foo"], className: "ModuleScript", source: "return 2" } });
    d.handleStudioMessage({ type: "instanceUpdated", data: { guid: "s1", className: "ModuleScript", name: "Foo", path: ["ReplicatedStorage", "Foo"], parentGuid: "r1", source: "return 3" } });
    await settle();
    assert.equal(rebuilds, 0, "text-only changes rebuilt the sourcemap");
    assert.equal(fs.readFileSync(path.join(tmp, "ReplicatedStorage", "Foo.luau"), "utf8"), "return 3");

    d.handleStudioMessage({ type: "instanceUpdated", data: { guid: "s1", className: "ModuleScript", name: "Bar", path: ["ReplicatedStorage", "Bar"], parentGuid: "r1", source: "return 3" } });
    await settle();
    assert.equal(rebuilds, 1, "a rename rebuilds it");
    const sourcemap = fs.readFileSync(config.sourcemapPath, "utf8");
    assert.match(sourcemap, /"Bar"/);
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
