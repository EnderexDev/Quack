import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SyncDaemon } from "../index.js";
import { config } from "../config.js";
import { textHash, worktreeOf } from "../play/overlay.js";

// `quackdev play`: a playtest of a git worktree's scripts, the place in edit mode untouched

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

test("textHash is FNV-1a 32 over UTF-8 bytes (the plugin computes the same)", () => {
  assert.equal(textHash(""), "811c9dc5");
  assert.equal(textHash("a"), "e40c292c");
  assert.equal(textHash("foobar"), "bf9cf968");
  // Multi-byte: hashed as bytes, not UTF-16 units
  assert.notEqual(textHash("é"), textHash("é".normalize("NFD")));
});

/** A game repo whose place is synced, and a worktree on another branch */
function fixture() {
  // .native: the long name, as git prints it (the JS realpath keeps an 8.3 RUNNER~1)
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "quack-play-")));
  const repo = path.join(root, "Game");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "core.autocrlf", "false");
  write(path.join(repo, ".gitignore"), "sync/Workspace/\nsourcemap.json\n.quack/\n");
  return { root, repo, worktree: path.join(root, "Game-feature") };
}

const placeData = [
  { guid: "rs", className: "ReplicatedStorage", name: "ReplicatedStorage", path: ["ReplicatedStorage"], parentGuid: "root" },
  { guid: "sss", className: "ServerScriptService", name: "ServerScriptService", path: ["ServerScriptService"], parentGuid: "root" },
  { guid: "ws", className: "Workspace", name: "Workspace", path: ["Workspace"], parentGuid: "root" },
  { guid: "cfg", className: "ModuleScript", name: "Config", path: ["ReplicatedStorage", "Config"], parentGuid: "rs", source: "return { damage = 10 }" },
  { guid: "same", className: "ModuleScript", name: "Same", path: ["ReplicatedStorage", "Same"], parentGuid: "rs", source: "local a = 1\nreturn a" },
  { guid: "old", className: "Script", name: "OldSystem", path: ["ServerScriptService", "OldSystem"], parentGuid: "sss", source: "print('old')" },
  { guid: "oldmod", className: "ModuleScript", name: "OldModule", path: ["ReplicatedStorage", "OldModule"], parentGuid: "rs", source: "return 'old'" },
  // Inside a map: ignored by git, so never the branch's to change or turn off
  { guid: "map", className: "Script", name: "Spinner", path: ["Workspace", "Spinner"], parentGuid: "ws", source: "print('spin')" },
];

test("play: only the branch's tracked scripts are swapped, and the play session's check comes back", async () => {
  const { root, repo, worktree } = fixture();
  const prev = { syncDir: config.syncDir, sourcemapPath: config.sourcemapPath, port: config.port };
  let daemon: SyncDaemon | undefined;
  try {
    config.syncDir = path.join(repo, "sync");
    config.sourcemapPath = path.join(repo, "sourcemap.json");
    config.port = 0;
    daemon = new SyncDaemon();
    const sent: any[] = [];
    (daemon as any).ipc.send = (message: any) => {
      sent.push(message);
      return true;
    };
    (daemon as any).ipc.isConnected = () => true;
    (daemon as any).handleStudioMessage({ type: "fullSnapshot", data: placeData, placeId: 5 });
    assert.ok(fs.existsSync(path.join(repo, "sync", "Workspace", "Spinner.server.luau")));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "place");

    // The branch: Config changed, a new system, OldSystem and OldModule deleted, Same untouched
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
    const branchSync = path.join(worktree, "sync");
    write(path.join(branchSync, "ReplicatedStorage", "Config.luau"), "return { damage = 25 }");
    write(path.join(branchSync, "ServerScriptService", "Guilds", "Guilds.server.luau"), "print('guilds')");
    fs.rmSync(path.join(branchSync, "ServerScriptService", "OldSystem.server.luau"));
    fs.rmSync(path.join(branchSync, "ReplicatedStorage", "OldModule.luau"));
    // Checked out with CRLF (git on Windows): the same script, not a change
    write(path.join(branchSync, "ReplicatedStorage", "Same.luau"), "local a = 1\r\nreturn a");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "-m", "feature");

    const before = fs.readFileSync(path.join(repo, "sync", "ReplicatedStorage", "Config.luau"), "utf8");
    const playing = daemon.startPlay(worktree);
    await new Promise((r) => setTimeout(r, 50));
    const swap = sent.find((m) => m.type === "playOverlay");
    assert.ok(swap, "the swap goes to Studio");
    assert.deepEqual(swap.patches, [{ guid: "cfg", source: "return { damage = 25 }" }]);
    assert.deepEqual(swap.creates, [
      { className: "Script", name: "Guilds", parentPath: ["ServerScriptService", "Guilds"], source: "print('guilds')" },
    ]);
    assert.deepEqual(swap.disables, [{ guid: "old" }], "a deleted Script is turned off; the map's script is not touched");
    assert.deepEqual(
      swap.checks.map((c: any) => [c.path.join("."), c.hash ?? (c.disabled ? "off" : "")]),
      [
        ["ReplicatedStorage.Config", textHash("return { damage = 25 }")],
        ["ServerScriptService.Guilds.Guilds", textHash("print('guilds')")],
        ["ServerScriptService.OldSystem", "off"],
      ],
    );

    (daemon as any).handleStudioMessage({ type: "playOverlayResult", id: swap.id, ok: true, windowMs: 1370, applied: 3 });
    const state = await playing;
    assert.equal(state.done, true);
    assert.deepEqual(state.result, { ok: true, windowMs: 1370, applied: 3 });
    assert.equal(state.skipped.length, 1);
    assert.match(state.skipped[0], /OldModule\.luau/);

    // The check from the play session, through the output relay
    (daemon as any).handleStudioMessage({ type: "playVerify", id: "not-this-play", ok: false, passed: 0, failed: ["x"] });
    assert.equal(state.verify, undefined, "another play's check is ignored");
    (daemon as any).handleStudioMessage({ type: "playVerify", id: swap.id, ok: true, passed: 3, failed: [], unverified: ["ServerScriptService.Gone"] });
    const verify = (state as any).verify;
    assert.equal(verify?.ok, true);
    assert.equal(verify?.passed, 3);
    assert.deepEqual(verify?.unverified, ["ServerScriptService.Gone"], "what the game removed is kept apart from failures");

    // The registered folder is untouched: the disk keeps the place's scripts
    assert.equal(fs.readFileSync(path.join(repo, "sync", "ReplicatedStorage", "Config.luau"), "utf8"), before);
    assert.equal(git(repo, "status", "--porcelain").trim(), "");
  } finally {
    await daemon?.stop();
    Object.assign(config, prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 24/10/26, Anime Astral: the balancer edited AccessoryConfig in Studio without a commit, and every
// worktree's play tried to swap it back, since every tracked script that differed from Studio
// was swapped. Only what the branch changed since it forked is the branch's
test("play: only what the branch changed since it forked is swapped; Studio's and main's own edits stay", async () => {
  const { root, repo, worktree } = fixture();
  const prev = { syncDir: config.syncDir, sourcemapPath: config.sourcemapPath, port: config.port };
  let daemon: SyncDaemon | undefined;
  try {
    config.syncDir = path.join(repo, "sync");
    config.sourcemapPath = path.join(repo, "sourcemap.json");
    config.port = 0;
    daemon = new SyncDaemon();
    const sent: any[] = [];
    (daemon as any).ipc.send = (message: any) => {
      sent.push(message);
      return true;
    };
    (daemon as any).ipc.isConnected = () => true;
    const data = [
      ...placeData,
      { guid: "acc", className: "ModuleScript", name: "AccessoryConfig", path: ["ReplicatedStorage", "AccessoryConfig"], parentGuid: "rs", source: "return { power = 1 }" },
      { guid: "late", className: "Script", name: "MainSystem", path: ["ServerScriptService", "MainSystem"], parentGuid: "sss", source: "print('main')" },
    ];
    (daemon as any).handleStudioMessage({ type: "fullSnapshot", data, placeId: 5 });
    const sync = path.join(repo, "sync");
    const mainSystem = path.join("sync", "ServerScriptService", "MainSystem.server.luau");
    git(repo, "add", "-A");
    git(repo, "reset", "-q", "--", mainSystem);
    git(repo, "commit", "-q", "-m", "place");
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree);

    // main moves on after the fork: a new system, and a change to Same
    write(path.join(sync, "ReplicatedStorage", "Same.luau"), "local a = 2\nreturn a");
    (daemon as any).tree.getNode("same").source = "local a = 2\nreturn a";
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "main moves on");

    // Edited in Studio and not committed: AccessoryConfig (the branch leaves it) and Config (the
    // branch changes it too: a real conflict)
    (daemon as any).tree.getNode("acc").source = "return { power = 7 }";
    (daemon as any).tree.getNode("cfg").source = "return { damage = 12 }";

    const branchSync = path.join(worktree, "sync");
    write(path.join(branchSync, "ReplicatedStorage", "Config.luau"), "return { damage = 25 }");
    // and Same, which main changed after the fork: the play runs the branch's without main's
    write(path.join(branchSync, "ReplicatedStorage", "Same.luau"), "local a = 3\nreturn a");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "-m", "feature");

    const playing = daemon.startPlay(worktree);
    await new Promise((r) => setTimeout(r, 50));
    const swap = sent.find((m) => m.type === "playOverlay");
    assert.deepEqual(
      swap.patches,
      [
        { guid: "cfg", source: "return { damage = 25 }" },
        { guid: "same", source: "local a = 3\nreturn a" },
      ],
      "Studio's own AccessoryConfig is not the branch's to swap",
    );
    assert.deepEqual(swap.disables, [], "a script main added after the fork is not turned off");
    assert.deepEqual(swap.creates, []);
    assert.equal(swap.checks.length, 2);
    (daemon as any).handleStudioMessage({ type: "playOverlayResult", id: swap.id, ok: true, windowMs: 1 });
    const state = await playing;
    assert.equal(state.checks, 2);
    assert.equal(state.conflicts.length, 2);
    assert.match(state.conflicts[0], /Config\.luau: changed in Studio and not committed/);
    assert.match(state.conflicts[1], /Same\.luau: the place's folder committed a change to it after the branch forked/);

    // A branch that brings nothing swaps nothing, whatever Studio holds
    sent.length = 0;
    git(worktree, "reset", "-q", "--hard", "HEAD~1");
    const empty = daemon.startPlay(worktree);
    await new Promise((r) => setTimeout(r, 50));
    const none = sent.find((m) => m.type === "playOverlay");
    assert.deepEqual([none.patches, none.creates, none.disables], [[], [], []]);
    (daemon as any).handleStudioMessage({ type: "playOverlayResult", id: none.id, ok: true, windowMs: 1 });
    assert.equal((await empty).checks, 0);
  } finally {
    await daemon?.stop();
    Object.assign(config, prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("play: Studio failing to swap leaves the play failed, and a second play waits for the first", async () => {
  const { root, repo, worktree } = fixture();
  const prev = { syncDir: config.syncDir, sourcemapPath: config.sourcemapPath, port: config.port };
  let daemon: SyncDaemon | undefined;
  try {
    config.syncDir = path.join(repo, "sync");
    config.sourcemapPath = path.join(repo, "sourcemap.json");
    config.port = 0;
    daemon = new SyncDaemon();
    const sent: any[] = [];
    (daemon as any).ipc.send = (message: any) => {
      sent.push(message);
      return true;
    };
    (daemon as any).ipc.isConnected = () => true;
    (daemon as any).handleStudioMessage({ type: "fullSnapshot", data: placeData, placeId: 5 });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "place");
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree);

    // Deleted in the worktree and not committed yet: git still lists it, the branch has no script
    fs.rmSync(path.join(worktree, "sync", "ServerScriptService", "OldSystem.server.luau"));

    const first = daemon.startPlay(worktree);
    await assert.rejects(daemon.startPlay(worktree), /already being started/);
    const swap = sent.find((m) => m.type === "playOverlay");
    assert.deepEqual(swap.disables, [{ guid: "old" }], "a script deleted but not committed is turned off too");
    (daemon as any).handleStudioMessage({ type: "playOverlayResult", id: swap.id, ok: false, error: "a playtest is already running: stop it first" });
    const state = await first;
    assert.equal(state.result?.ok, false);
    assert.match(state.result?.error ?? "", /already running/);
  } finally {
    await daemon?.stop();
    Object.assign(config, prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("play refuses a folder of another repository, the place's own folder, and no Studio", async () => {
  const a = fixture();
  const b = fixture();
  try {
    write(path.join(a.repo, "x.txt"), "x");
    git(a.repo, "add", "-A");
    git(a.repo, "commit", "-q", "-m", "a");
    write(path.join(b.repo, "x.txt"), "x");
    git(b.repo, "add", "-A");
    git(b.repo, "commit", "-q", "-m", "b");
    assert.throws(() => worktreeOf(b.repo, a.repo), /another repository/);
    assert.throws(() => worktreeOf(a.repo, a.repo), /place's own folder/);
    assert.throws(() => worktreeOf(a.root, a.repo), /not inside a git repository/);
    git(a.repo, "worktree", "add", "-q", "-b", "f", a.worktree);
    assert.equal(worktreeOf(path.join(a.worktree), a.repo), a.worktree);

    const prev = { syncDir: config.syncDir, sourcemapPath: config.sourcemapPath, port: config.port };
    config.syncDir = path.join(a.repo, "sync");
    config.sourcemapPath = path.join(a.repo, "sourcemap.json");
    config.port = 0;
    const daemon = new SyncDaemon();
    try {
      await assert.rejects(daemon.startPlay(a.worktree), /no Studio is synced/);
      await assert.rejects(daemon.startPlay("relative/path"), /absolute path/);
    } finally {
      await daemon.stop();
      Object.assign(config, prev);
    }
  } finally {
    fs.rmSync(a.root, { recursive: true, force: true });
    fs.rmSync(b.root, { recursive: true, force: true });
  }
});

// 22/10/26: the release runner's temp folder is C:\Users\RUNNER~1; git printed the long name and
// the place's own folder passed as a worktree
test("play knows the place's own folder when it is registered by its 8.3 short name", { skip: process.platform !== "win32" }, () => {
  const { root, repo } = fixture(); // root is quack-play-XXXXXX: longer than 8.3
  try {
    const short = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${repo}').ShortPath`],
      { encoding: "utf8" },
    ).trim();
    if (short.toLowerCase() === repo.toLowerCase()) return; // the volume makes no short names
    assert.throws(() => worktreeOf(repo, short), /place's own folder/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("play: a branch script that cannot be read is left as the place has it, never turned off", async () => {
  const { root, repo, worktree } = fixture();
  const prev = { syncDir: config.syncDir, sourcemapPath: config.sourcemapPath, port: config.port };
  let daemon: SyncDaemon | undefined;
  try {
    config.syncDir = path.join(repo, "sync");
    config.sourcemapPath = path.join(repo, "sourcemap.json");
    config.port = 0;
    daemon = new SyncDaemon();
    const sent: any[] = [];
    (daemon as any).ipc.send = (message: any) => {
      sent.push(message);
      return true;
    };
    (daemon as any).ipc.isConnected = () => true;
    (daemon as any).handleStudioMessage({ type: "fullSnapshot", data: placeData, placeId: 5 });
    git(repo, "add", "sync", ".gitignore");
    git(repo, "commit", "-q", "-m", "place");
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
    // Still tracked, but reading it fails with something other than "not there" (EISDIR here)
    const file = path.join(worktree, "sync", "ServerScriptService", "OldSystem.server.luau");
    fs.rmSync(file);
    fs.mkdirSync(file);

    const playing = daemon.startPlay(worktree);
    await new Promise((r) => setTimeout(r, 50));
    const swap = sent.find((m) => m.type === "playOverlay");
    assert.deepEqual(swap.disables, [], "an unreadable file is not a deletion");
    (daemon as any).handleStudioMessage({ type: "playOverlayResult", id: swap.id, ok: true, windowMs: 1 });
    const state = await playing;
    assert.ok(state.skipped.some((line) => /OldSystem\.server\.luau: could not be read/.test(line)));
  } finally {
    await daemon?.stop();
    Object.assign(config, prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quackdev play: says the branch is there only when the check passed, and keeps removed scripts apart", async () => {
  const { runControl } = await import("../control/commands.js");
  const run = async (verify: any, laterId?: string, change: Record<string, unknown> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const started = {
      id: "p1",
      worktree: "W",
      done: true,
      patches: 2,
      creates: 0,
      disables: 0,
      skipped: [],
      conflicts: ["ReplicatedStorage\\Config.luau: changed in Studio and not committed (someone's edit there); the play runs the branch's text without that edit"],
      checks: 2,
      result: { ok: true, windowMs: 1500 },
      ...change,
    };
    const client = {
      get: async (pathname: string) => {
        if (pathname === "/api/state") return { places: [{ placeId: "5", name: "Game", folder: os.tmpdir() }] };
        return { play: { ...started, id: laterId ?? "p1", verify } };
      },
      post: async () => ({ play: started }),
    };
    const code = await runControl(["play", "5", "-w", os.tmpdir()], {
      info: { flavor: "dev", command: "quackdev", appName: "Quack Dev", port: 0 } as any,
      client: client as any,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      confirm: async () => false,
      interactive: false,
      color: false,
      cwd: os.tmpdir(),
      openUri: async () => {},
      pollMs: 1,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  const ok = await run({ ok: true, passed: 2, failed: [], unverified: ["ServerScriptService.Gone"] });
  assert.equal(ok.code, 0);
  assert.match(ok.out, /2 of 2 have the branch/);
  assert.match(ok.out, /1 swapped script\(s\) were gone before the check/);
  assert.equal(ok.err, "", "a passed check prints no failure");

  // The usual case: nothing removed by the game (an empty "does NOT have the branch" came out here)
  const clean = await run({ ok: true, passed: 2, failed: [], unverified: [] });
  assert.equal(clean.code, 0);
  assert.equal(clean.err, "", "a passed check prints no failure");

  const bad = await run({ ok: false, passed: 1, failed: ["ReplicatedStorage.Config has the place's text, not the branch's"], unverified: [] });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /does NOT have the branch: ReplicatedStorage\.Config/);
  assert.doesNotMatch(bad.out, /have the branch\./);
  assert.match(bad.err, /tab is open in the Studio running the play/, "the cause measured 25/10/26 is named");
  assert.match(bad.out, /conflict: ReplicatedStorage\\Config\.luau: changed in Studio/);

  // The denominator is what was sent, not what passed
  const part = await run({ ok: true, passed: 1, failed: [], unverified: ["ServerScriptService.Gone"] }, undefined, { checks: 2 });
  assert.match(part.out, /1 of 2 have the branch/);

  // A swap Studio refused names the scripts (24/10/26: only "could not be swapped in" came out)
  const refused = await run(undefined, undefined, {
    result: { ok: false, error: "the branch could not be swapped in", failed: ["ReplicatedStorage.Big: Source too long"] },
  });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /could not be swapped in\n {2}ReplicatedStorage\.Big: Source too long/);

  const nothing = await run({ ok: true, passed: 0, failed: [], unverified: [] }, undefined, { checks: 0, patches: 0, conflicts: [] });
  assert.match(nothing.out, /brings no script change since it forked/);

  const replaced = await run(undefined, "p2");
  assert.equal(replaced.code, 1);
  assert.match(replaced.err, /another play of this place started/);
});
