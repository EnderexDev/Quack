import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileWatcher } from "../fs/watcher.js";
import { config } from "../config.js";

// The backstop's loaded copy goes here, not to the real %APPDATA%\quack\native. One fixed folder:
// the copy stays locked while this process runs, and its hashed name is reused next run
process.env.QUACK_NATIVE_DIR ??= path.join(os.tmpdir(), "quack-test-native");

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
  const settle = () => wait(config.fileWatchDebounce + 150);
  try {
    watcher.watch(root);
    // The backstop watch is live from here (when it loaded)
    await (watcher as unknown as { backstopPending: Promise<unknown> | null }).backstopPending;
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
      closeBackends(): Promise<void>;
      rescanNative(root: string): void;
    };
    await native.closeBackends();
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

/** The rescan's log lines while body runs: [level, message] */
async function rescanLog(body: () => Promise<void>): Promise<[string, string][]> {
  const { log } = await import("../util/log.js");
  const { info, warn } = log;
  const lines: [string, string][] = [];
  log.info = (message: string, ...args: unknown[]) => {
    if (message.includes("lost events")) lines.push(["info", message]);
    info(message, ...args);
  };
  log.warn = (message: string, ...args: unknown[]) => {
    if (message.includes("lost events")) lines.push(["warn", message]);
    warn(message, ...args);
  };
  try {
    await body();
  } finally {
    log.info = info;
    log.warn = warn;
  }
  return lines;
}

test("overflows ~120 ms apart in one burst cost one rescan", async () => {
  await withNativeWatcher(async (root, events, settle, watcher) => {
    const lines = await rescanLog(async () => {
      const overflow = watcher as unknown as { requestRescan(root: string): void };
      for (let i = 0; i < 4; i++) {
        overflow.requestRescan(root);
        await wait(120);
      }
      await wait(400);
      await settle();
    });
    assert.equal(lines.length, 1);
    assert.deepEqual(events, []);
  });
});

test("a rescan that finds nothing says so, as info, not as a warning", async () => {
  await withNativeWatcher(async (root, _events, settle, watcher) => {
    const lines = await rescanLog(async () => {
      (watcher as unknown as { rescanNative(root: string): void }).rescanNative(root);
      await settle();
    });
    assert.deepEqual(lines, [["info", "Native watcher lost events; the rescan found nothing missed"]]);
  });
});

test("a rescan that recovers changes warns with how many", async () => {
  await withNativeWatcher(async (root, _events, settle, watcher) => {
    const native = watcher as unknown as {
      closeBackends(): Promise<void>;
      rescanNative(root: string): void;
    };
    // The OS dropped these: one edit, a new folder with a script, one delete
    await native.closeBackends();
    fs.writeFileSync(path.join(root, "Existing", "Top.luau"), "return 2");
    fs.mkdirSync(path.join(root, "Existing", "Fresh"));
    fs.writeFileSync(path.join(root, "Existing", "Fresh", "F.luau"), "return 3");
    fs.rmSync(path.join(root, "Existing", "Inner", "Old.luau"));
    const lines = await rescanLog(async () => {
      native.rescanNative(root);
      await settle();
    });
    assert.deepEqual(lines, [
      ["warn", "Native watcher lost events; the rescan found 4 change(s) the OS did not report, now sent"],
    ]);
  });
});

/** 60 scripts in one folder, deleted at once: past fs.watch's buffer (50 deletes overflowed it) */
async function deleteSixty(root: string, settle: () => Promise<void>): Promise<string[]> {
  const dir = path.join(root, "Existing", "Burst");
  fs.mkdirSync(dir);
  const names = Array.from({ length: 60 }, (_, i) => `Action${i}.luau`);
  for (const name of names) fs.writeFileSync(path.join(dir, name), "x");
  await settle();
  for (const name of names) fs.unlinkSync(path.join(dir, name));
  return names.map((name) => `unlink Existing/Burst/${name}`).sort();
}

test("a burst past fs.watch's buffer arrives whole through the backstop, with no rescan", { skip: process.platform !== "win32" || process.arch !== "x64" }, async () => {
  await withNativeWatcher(async (root, events, settle, watcher) => {
    assert.ok((watcher as unknown as { backstopSub: unknown }).backstopSub, "the backstop watch is live");
    let expected: string[] = [];
    const lines = await rescanLog(async () => {
      expected = await deleteSixty(root, settle);
      events.length = 0;
      await wait(1500);
    });
    assert.deepEqual(lines, []);
    assert.deepEqual(events.filter((e) => e.startsWith("unlink ")).sort(), expected);
  });
});

test("without the backstop an overflow still rescans and finds the burst", { skip: process.platform !== "win32" || process.arch !== "x64" }, async () => {
  const loader = FileWatcher.backstopLoader;
  FileWatcher.backstopLoader = () => null;
  try {
    await withNativeWatcher(async (root, events, settle) => {
      let expected: string[] = [];
      const lines = await rescanLog(async () => {
        expected = await deleteSixty(root, settle);
        events.length = 0;
        await wait(1500);
      });
      assert.equal(lines.length, 1);
      assert.deepEqual(events.filter((e) => e.startsWith("unlink ")).sort(), expected);
    });
  } finally {
    FileWatcher.backstopLoader = loader;
  }
});

test("the backstop loads a copy, so the shipped binary can still be replaced by an update", { skip: process.platform !== "win32" || process.arch !== "x64" }, async () => {
  const { shippedBinary } = await import("../fs/backstopWatcher.js");
  const binary = shippedBinary();
  assert.ok(binary, "@parcel/watcher-win32-x64 is installed");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "quack-backstop-"));
  try {
    const install = path.join(scratch, "install", "watcher.node");
    fs.mkdirSync(path.dirname(install));
    fs.copyFileSync(binary, install);
    // In a child: a loaded DLL stays locked until its process exits. Windows lets it be renamed
    // but not overwritten (EBUSY), and overwriting is what the installer does
    const module = new URL("../fs/backstopWatcher.js", import.meta.url).href;
    const script = `
      import fs from "node:fs";
      const { loadBackstop } = await import(${JSON.stringify(module)});
      const { loadedFrom } = loadBackstop(${JSON.stringify(install)}, ${JSON.stringify(path.join(scratch, "native"))});
      const tryOverwrite = (file) => { try { fs.copyFileSync(${JSON.stringify(binary)}, file); return true; } catch { return false; } };
      console.log(JSON.stringify({ loadedFrom, install: tryOverwrite(${JSON.stringify(install)}), loaded: tryOverwrite(loadedFrom) }));
    `;
    const { execFileSync } = await import("node:child_process");
    const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).trim());
    assert.ok(out.loadedFrom.startsWith(path.join(scratch, "native")), out.loadedFrom);
    assert.equal(out.install, true, "the shipped file is free while the watcher runs");
    assert.equal(out.loaded, false, "the copy is the one Windows holds");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the loaded copy is reused only when every byte is the shipped one, and a relative folder works", { skip: process.platform !== "win32" || process.arch !== "x64" }, async () => {
  const { copyForLoading, shippedBinary } = await import("../fs/backstopWatcher.js");
  const binary = shippedBinary()!;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "quack-copy-"));
  const cwd = process.cwd();
  try {
    const first = copyForLoading(binary, path.join(scratch, "native"));
    // Same size, other bytes (a corrupt or planted file under the expected name)
    const size = fs.statSync(first).size;
    fs.writeFileSync(first, Buffer.alloc(size, 0x90));
    const again = copyForLoading(binary, path.join(scratch, "native"));
    assert.equal(again, first);
    assert.deepEqual(fs.readFileSync(again), fs.readFileSync(binary));
    // Another size: replaced (and never read whole), with no temporary file left behind
    fs.writeFileSync(first, Buffer.alloc(size * 2, 0x90));
    copyForLoading(binary, path.join(scratch, "native"));
    assert.deepEqual(fs.readFileSync(first), fs.readFileSync(binary));
    assert.deepEqual(fs.readdirSync(path.join(scratch, "native")), [path.basename(first)]);
    // require() reads a bare relative path as a package name: the copy's path is absolute
    process.chdir(scratch);
    const relative = copyForLoading(binary, "rel-native");
    assert.ok(path.isAbsolute(relative), relative);
    assert.equal(relative, path.join(process.cwd(), "rel-native", path.basename(first)));
  } finally {
    process.chdir(cwd);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the backstop never asks for Watchman, whose check opened a Terminal window per daemon", { skip: process.platform !== "win32" || process.arch !== "x64" }, async () => {
  // A fake watchman on PATH that leaves a mark when run. Parcel's default backend runs it
  // through cmd.exe (popen) to see whether Watchman is there; in a daemon, which has no
  // console, that cmd opened a Terminal window left open by its error exit
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "quack-watchman-"));
  try {
    const bin = path.join(scratch, "bin");
    fs.mkdirSync(bin);
    const mark = path.join(scratch, "ran.txt");
    fs.writeFileSync(path.join(bin, "watchman.cmd"), `@echo ran> "${mark}"\r\n@exit /b 1\r\n`);
    const watched = path.join(scratch, "sync");
    fs.mkdirSync(watched);
    const module = new URL("../fs/backstopWatcher.js", import.meta.url).href;
    const script = `
      const { loadBackstop } = await import(${JSON.stringify(module)});
      const backstop = loadBackstop(undefined, ${JSON.stringify(path.join(scratch, "native"))});
      const subscription = await backstop.subscribe(${JSON.stringify(watched)}, () => {}, []);
      await subscription.unsubscribe();
    `;
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PATH: `${bin};${process.env.PATH}` },
      windowsHide: true,
      stdio: "ignore",
    });
    assert.equal(fs.existsSync(mark), false, "watchman was run");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
