import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SyncDaemon } from "../index.js";
import { config } from "../config.js";
import { FileWatcher } from "../fs/watcher.js";
import { diskText } from "../util/scriptFile.js";

// git on Windows rewrites a file by replacing it (reset, checkout, merge) and writes CRLF. With
// Quack running, a `git reset --hard` deleted the script it rewrote, from Studio and disk, and
// a merged file reached Studio with a CR on every line (PA, 22/10/26).

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const place = [
  { guid: "rs", className: "ReplicatedStorage", name: "ReplicatedStorage", path: ["ReplicatedStorage"], parentGuid: "root" },
  { guid: "sp", className: "ModuleScript", name: "Species", path: ["ReplicatedStorage", "Species"], parentGuid: "rs", source: "local a = 1\nreturn a" },
];

async function withDaemon(body: (daemon: any, file: string, sent: any[]) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-rewrite-"));
  const prev = { syncDir: config.syncDir, sourcemapPath: config.sourcemapPath, port: config.port, liveFsSync: config.liveFsSync };
  let daemon: any;
  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prev.liveFsSync, enabled: true };
    daemon = new SyncDaemon();
    const sent: any[] = [];
    daemon.ipc.send = (message: any) => {
      sent.push(message);
      return true;
    };
    daemon.handleStudioMessage({ type: "fullSnapshot", data: place, placeId: 7 });
    const file = path.join(tmp, "ReplicatedStorage", "Species.luau");
    assert.equal(fs.readFileSync(file, "utf8"), "local a = 1\nreturn a");
    sent.length = 0;
    await body(daemon, file, sent);
  } finally {
    await daemon?.stop();
    Object.assign(config, prev);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** git's way: unlink, then a new file (a new inode) at the same path */
function rewrite(file: string, text: string): void {
  fs.rmSync(file);
  fs.writeFileSync(file, text, "utf8");
}

test("a script git rewrites in place (delete, then the same path) is patched, never deleted", async () => {
  await withDaemon(async (daemon, file, sent) => {
    daemon.handleFileDelete(file);
    rewrite(file, "local a = 2\nreturn a");
    daemon.handleFileAdd(file, "local a = 2\nreturn a");
    await wait(daemon.moveWindowMs + 200);
    assert.equal(sent.filter((m) => m.type === "deleteInstance").length, 0, "no delete reaches Studio");
    assert.deepEqual(sent.filter((m) => m.type === "patchScript").map((m) => [m.guid, m.source]), [["sp", "local a = 2\nreturn a"]]);
    assert.ok(fs.existsSync(file), "the file stays on disk");
    assert.equal(daemon.tree.getNode("sp")?.source, "local a = 2\nreturn a");
  });
});

test("a rewrite whose add event never came is caught when the buffered delete fires", async () => {
  await withDaemon(async (daemon, file, sent) => {
    daemon.handleFileDelete(file);
    rewrite(file, "local a = 3\nreturn a");
    await wait(daemon.moveWindowMs + 200);
    assert.equal(sent.filter((m) => m.type === "deleteInstance").length, 0);
    assert.deepEqual(sent.filter((m) => m.type === "patchScript").map((m) => m.source), ["local a = 3\nreturn a"]);
  });
});

test("a script really deleted on disk is still deleted in Studio", async () => {
  await withDaemon(async (daemon, file, sent) => {
    fs.rmSync(file);
    daemon.handleFileDelete(file);
    await wait(daemon.moveWindowMs + 200);
    assert.deepEqual(sent.filter((m) => m.type === "deleteInstance").map((m) => m.guid), ["sp"]);
  });
});

test("a CRLF file from git reaches Studio as LF, and the same text in CRLF is no change", async () => {
  assert.equal(diskText("a\r\nb\r\n"), "a\nb\n");
  assert.equal(diskText("a\nb"), "a\nb");

  const prevLive = config.liveFsSync;
  config.liveFsSync = { ...prevLive, watcher: "native" };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-eol-"));
  const watcher = new FileWatcher();
  const seen: string[] = [];
  watcher.onEvent((event, _filePath, source) => {
    if (source !== undefined) seen.push(`${event} ${JSON.stringify(source)}`);
  });
  watcher.watch(root);
  try {
    await wait(config.fileWatchDebounce + 150);
    fs.writeFileSync(path.join(root, "Merged.luau"), "local x = 1\r\nreturn x\r\n", "utf8");
    await wait(config.fileWatchDebounce + 400);
    assert.ok(seen.length > 0, "the watcher saw the file");
    assert.ok(seen.every((line) => !line.includes("\\r")), `no CR reaches the daemon: ${seen.join(" | ")}`);
  } finally {
    await watcher.stop();
    config.liveFsSync = prevLive;
    fs.rmSync(root, { recursive: true, force: true });
  }

  await withDaemon(async (daemon, file, sent) => {
    // The checkout wrote Studio's own text with CRLF: nothing to send
    fs.writeFileSync(file, "local a = 1\r\nreturn a", "utf8");
    daemon.handleFileChange(file, diskText(fs.readFileSync(file, "utf8")));
    assert.equal(sent.filter((m) => m.type === "patchScript").length, 0);
  });
});

test("a file git wrote with CRLF and Studio's text is left alone, so git does not see it modified", async () => {
  await withDaemon(async (daemon, file) => {
    const crlf = Buffer.from("local a = 1\r\nreturn a", "utf8");
    fs.writeFileSync(file, crlf);
    daemon.fileWriter.writeScript(daemon.tree.getNode("sp"));
    assert.ok(fs.readFileSync(file).equals(crlf), "the CRLF file is not rewritten as LF");
  });
});

test("a script Studio holds with CRLF is not rewritten on every connect", async () => {
  await withDaemon(async (daemon, file, sent) => {
    // Studio holds the CRLF text a merge sent before CRs were kept out; the file has it too
    const crlf = "local a = 1\r\nreturn a";
    const studio = place.map((node) => (node.guid === "sp" ? { ...node, source: crlf } : node));
    fs.writeFileSync(file, crlf, "utf8");
    const before = fs.statSync(file).mtimeMs;
    await wait(30);
    daemon.handleStudioMessage({ type: "fullSnapshot", data: studio, placeId: 7 });
    assert.equal(fs.statSync(file).mtimeMs, before, "the file is not written again");
    assert.equal(fs.readFileSync(file, "utf8"), crlf);

    // The same with LF on disk: still the same script, nothing written
    fs.writeFileSync(file, "local a = 1\nreturn a", "utf8");
    const lfBefore = fs.statSync(file).mtimeMs;
    await wait(30);
    daemon.handleStudioMessage({ type: "fullSnapshot", data: studio, placeId: 7 });
    assert.equal(fs.statSync(file).mtimeMs, lfBefore);
    assert.equal(sent.filter((m) => m.type === "patchScript").length, 0, "nothing sent to Studio");
  });
});

test("a script created, edited or deleted in Studio is one line in the log, with the right mark", async () => {
  await withDaemon(async (daemon) => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: any[]) => {
      lines.push(args.join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
    };
    const take = () => lines.splice(0).filter((line) => /\] [+~−] /.test(line)).map((line) => line.replace(/^.*?\] /, ""));
    try {
      const script = { guid: "nw", className: "Script", name: "New", path: ["ReplicatedStorage", "New"], parentGuid: "rs", source: "print(1)" };
      daemon.handleStudioMessage({ type: "instanceUpdated", data: script });
      assert.deepEqual(take(), [`+ ${path.join("ReplicatedStorage", "New.server.luau")}`]);

      daemon.handleStudioMessage({ type: "instanceUpdated", data: { ...script, source: "print(2)" } });
      assert.deepEqual(take(), [`~ ${path.join("ReplicatedStorage", "New.server.luau")}`]);

      daemon.handleStudioMessage({ type: "deleted", data: { guid: "nw" } });
      assert.deepEqual(take(), [`− ${path.join("ReplicatedStorage", "New.server.luau")}`]);

      // An instance without a file still gets its line
      daemon.handleStudioMessage({ type: "instanceUpdated", data: { guid: "fo", className: "Folder", name: "Fo", path: ["ReplicatedStorage", "Fo"], parentGuid: "rs" } });
      daemon.handleStudioMessage({ type: "deleted", data: { guid: "fo" } });
      assert.deepEqual(take(), ["+ Created instance: ReplicatedStorage/Fo", "− Deleted instance: ReplicatedStorage/Fo"]);
    } finally {
      console.log = original;
    }
  });
});

test("a service's directory that git removes and brings back is never deleted nor made a Folder", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-service-dir-"));
  const prev = { syncDir: config.syncDir, sourcemapPath: config.sourcemapPath, port: config.port, liveFsSync: config.liveFsSync };
  let daemon: any;
  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prev.liveFsSync, enabled: true };
    daemon = new SyncDaemon();
    const sent: any[] = [];
    daemon.ipc.send = (message: any) => {
      sent.push(message);
      return true;
    };
    daemon.handleStudioMessage({
      type: "fullSnapshot",
      placeId: 7,
      data: [
        { guid: "sp", className: "StarterPlayer", name: "StarterPlayer", path: ["StarterPlayer"], parentGuid: "root" },
        { guid: "sps", className: "StarterPlayerScripts", name: "StarterPlayerScripts", path: ["StarterPlayer", "StarterPlayerScripts"], parentGuid: "sp" },
        { guid: "an", className: "LocalScript", name: "Animator", path: ["StarterPlayer", "StarterPlayerScripts", "Animator"], parentGuid: "sps", source: "print(1)" },
      ],
    });
    const spDir = path.join(tmp, "StarterPlayer");
    const spsDir = path.join(spDir, "StarterPlayerScripts");
    const file = path.join(spsDir, "Animator.client.luau");
    assert.ok(fs.existsSync(file));
    sent.length = 0;

    // A merge deletes the only script: git removes the file and both directories
    fs.rmSync(spDir, { recursive: true });
    daemon.handleFileDelete(file);
    daemon.handleDirDelete(spsDir);
    daemon.handleDirDelete(spDir);
    await wait(daemon.moveWindowMs + 200);
    assert.deepEqual(
      sent.filter((m) => m.type === "deleteInstance").map((m) => m.guid ?? m.path.join("/")),
      ["an"],
      "only the script is deleted, never the services",
    );

    // A reset brings them back
    sent.length = 0;
    fs.mkdirSync(spsDir, { recursive: true });
    fs.writeFileSync(file, "print(1)", "utf8");
    daemon.handleDirAdd(spDir);
    daemon.handleDirAdd(spsDir);
    daemon.handleFileAdd(file, "print(1)");
    const creates = sent.filter((m) => m.type === "createInstance");
    assert.deepEqual(
      creates.map((m) => `${m.className} ${[...m.parentPath, m.name].join("/")}`),
      ["LocalScript StarterPlayer/StarterPlayerScripts/Animator"],
      "no Folder named like a service",
    );
  } finally {
    await daemon?.stop();
    Object.assign(config, prev);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("an expected write that never happened does not swallow the same text arriving later from outside", async () => {
  const prevLive = config.liveFsSync;
  config.liveFsSync = { ...prevLive, watcher: "native" };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-stale-"));
  const watcher = new FileWatcher();
  const seen: string[] = [];
  watcher.onEvent((event, filePath, source) => {
    if (source !== undefined) seen.push(`${event} ${path.basename(filePath)} ${source}`);
  });
  watcher.watch(root);
  try {
    await wait(config.fileWatchDebounce + 150);
    const file = path.join(root, "Marker.server.luau");
    // The daemon expected to write this text, then skipped the write (the file already had it)
    watcher.suppressNextChange(file, "print('m')");
    await wait(1300);
    // Seconds later a merge creates the file with that text
    fs.writeFileSync(file, "print('m')", "utf8");
    await wait(config.fileWatchDebounce + 400);
    assert.ok(seen.some((line) => line.includes("Marker.server.luau print('m')")), `the merge's file reaches the daemon: ${seen.join(" | ") || "nothing"}`);
  } finally {
    await watcher.stop();
    config.liveFsSync = prevLive;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
