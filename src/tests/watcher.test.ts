import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileWatcher } from "../fs/watcher.js";
import { config } from "../config.js";

const wait = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

async function withNativeWatcher(
  body: (
    root: string,
    events: string[],
    settle: () => Promise<void>,
    watcher: FileWatcher,
  ) => Promise<void>,
): Promise<void> {
  const prevLive = config.liveFsSync;
  config.liveFsSync = { ...prevLive, watcher: "native" };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-watch-"));
  fs.mkdirSync(path.join(root, "Existing", "Inner"), { recursive: true });
  const old = path.join(root, "Existing", "Inner", "Old.luau");
  fs.writeFileSync(old, "x");
  // Last read a day ago, so Windows updates its last-access time on the next read
  fs.utimesSync(old, new Date(Date.now() - 86_400_000), fs.statSync(old).mtime);

  const watcher = new FileWatcher();
  const events: string[] = [];
  watcher.onEvent((event, filePath, source) => {
    const rel = path.relative(root, filePath).split(path.sep).join("/");
    events.push(source === undefined ? `${event} ${rel}` : `${event} ${rel} =${source}`);
  });
  watcher.watch(root);
  const settle = () => wait(config.fileWatchDebounce + 150);
  try {
    await settle();
    await body(root, events, settle, watcher);
  } finally {
    await watcher.stop();
    config.liveFsSync = prevLive;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("native watcher reports a new script once, with its final content", async () => {
  await withNativeWatcher(async (root, events, settle) => {
    fs.writeFileSync(path.join(root, "A.luau"), "return 1");
    await settle();
    assert.deepEqual(events, ["add A.luau =return 1"]);
  });
});

test("native watcher reports an edit as change with the new content", async () => {
  await withNativeWatcher(async (root, events, settle) => {
    const file = path.join(root, "Existing", "Inner", "Old.luau");
    fs.writeFileSync(file, "return 2");
    await settle();
    assert.deepEqual(events, ["change Existing/Inner/Old.luau =return 2"]);
  });
});

test("native watcher announces a new folder before the script inside it", async () => {
  await withNativeWatcher(async (root, events, settle) => {
    fs.mkdirSync(path.join(root, "New", "Deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "New", "Deep", "S.luau"), "s");
    await settle();
    assert.deepEqual(events, [
      "addDir New",
      "addDir New/Deep",
      "add New/Deep/S.luau =s",
    ]);
  });
});

test("native watcher reports a deleted folder as file unlinks, then folders deepest first", async () => {
  await withNativeWatcher(async (root, events, settle) => {
    fs.rmSync(path.join(root, "Existing"), { recursive: true });
    await settle();
    assert.deepEqual(events, [
      "unlink Existing/Inner/Old.luau",
      "unlinkDir Existing/Inner",
      "unlinkDir Existing",
    ]);
  });
});

test("native watcher leaves a folder with a subfolder renameable (the EPERM polling avoided)", async () => {
  await withNativeWatcher(async (root, events, settle) => {
    fs.renameSync(path.join(root, "Existing"), path.join(root, "Renamed"));
    await settle();
    assert.deepEqual(events, [
      "unlink Existing/Inner/Old.luau",
      "unlinkDir Existing/Inner",
      "unlinkDir Existing",
      "addDir Renamed",
      "addDir Renamed/Inner",
      "add Renamed/Inner/Old.luau =x",
    ]);
  });
});

test("native watcher ignores non-script files but still tracks them", async () => {
  await withNativeWatcher(async (root, events, settle) => {
    fs.writeFileSync(path.join(root, "notes.txt"), "hi");
    fs.writeFileSync(path.join(root, "notes.txt"), "hi again");
    fs.rmSync(path.join(root, "notes.txt"));
    await settle();
    assert.deepEqual(events, []);
  });
});

test("a save caught empty mid-write reaches Studio once, with its final content", async () => {
  await withNativeWatcher(async (root, events, settle) => {
    const file = path.join(root, "Existing", "Inner", "Old.luau");
    fs.writeFileSync(file, "");
    await wait(5);
    fs.writeFileSync(file, "return 9");
    await settle();
    assert.deepEqual(events, ["change Existing/Inner/Old.luau =return 9"]);
  });
});

test("a script emptied on purpose still reaches Studio as empty", async () => {
  await withNativeWatcher(async (root, events, settle) => {
    fs.writeFileSync(path.join(root, "Existing", "Inner", "Old.luau"), "");
    await settle();
    assert.deepEqual(events, ["change Existing/Inner/Old.luau ="]);
  });
});

test("saving the same content twice sends it once", async () => {
  await withNativeWatcher(async (root, events, settle) => {
    const file = path.join(root, "Existing", "Inner", "Old.luau");
    fs.writeFileSync(file, "return 5");
    await wait(50);
    fs.writeFileSync(file, "return 5");
    await settle();
    assert.deepEqual(events, ["change Existing/Inner/Old.luau =return 5"]);
  });
});

test("reading a script is not an edit (Windows reports the last-access update)", async () => {
  await withNativeWatcher(async (root, events, settle) => {
    fs.readFileSync(path.join(root, "Existing", "Inner", "Old.luau"), "utf-8");
    await settle();
    assert.deepEqual(events, []);
  });
});

test("a lost-events rescan reports only what changed, without reading every script", async () => {
  await withNativeWatcher(async (root, events, settle, watcher) => {
    (watcher as unknown as { rescanNative(root: string): void }).rescanNative(root);
    await settle();
    assert.deepEqual(events, []);
  });
});

test("a lost-events rescan finds new scripts in folders it already knew", async () => {
  await withNativeWatcher(async (root, events, settle, watcher) => {
    // The OS dropped these: write them with the watch closed, then rescan as an overflow does
    const native = watcher as unknown as {
      nativeWatcher: fs.FSWatcher;
      rescanNative(root: string): void;
    };
    native.nativeWatcher.close();
    fs.writeFileSync(path.join(root, "Existing", "Inner", "Lost.luau"), "return 1");
    fs.writeFileSync(path.join(root, "Existing", "Top.luau"), "return 2");
    fs.mkdirSync(path.join(root, "Existing", "Fresh"));
    fs.writeFileSync(path.join(root, "Existing", "Fresh", "F.luau"), "return 3");
    native.rescanNative(root);
    await settle();
    assert.deepEqual([...events].sort(), [
      "add Existing/Fresh/F.luau =return 3",
      "add Existing/Inner/Lost.luau =return 1",
      "add Existing/Top.luau =return 2",
      "addDir Existing/Fresh",
    ]);
  });
});

test("overflows ~120 ms apart in one burst cost one rescan", async () => {
  await withNativeWatcher(async (root, events, settle, watcher) => {
    const { log } = await import("../util/log.js");
    const warn = log.warn;
    let rescans = 0;
    log.warn = (...args: Parameters<typeof log.warn>) => {
      rescans++;
      warn(...args);
    };
    try {
      const overflow = watcher as unknown as { requestRescan(root: string): void };
      for (let i = 0; i < 4; i++) {
        overflow.requestRescan(root);
        await wait(120);
      }
      await wait(400);
      await settle();
    } finally {
      log.warn = warn;
    }
    assert.equal(rescans, 1);
    assert.deepEqual(events, []);
  });
});
