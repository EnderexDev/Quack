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

    (daemon as any).handleStudioMessage({ type: "playOverlayResult", id: swap.id, ok: true, windowMs: 1370, applied: 3, closedTabs: ["ReplicatedStorage.Config"] });
    const state = await playing;
    assert.equal(state.done, true);
    assert.deepEqual(state.result, { ok: true, windowMs: 1370, applied: 3, closedTabs: ["ReplicatedStorage.Config"] }, "the tabs the plugin closed before the swap are said");
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

// 10/11/26, Anime Astral (Team Create): a play's swap came back in the edit DataModel ~3 s after
// the restore, the sync wrote the branch's text of two conflicting scripts to the place's folder,
// and a land committed it to main as Studio's edits (637f3ac8)
test("play: the branch's text coming back from Studio after the swap never reaches the place's folder", async () => {
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

    // The place's folder changes Config after the fork (a conflict), and Studio has it
    const config_ = path.join(repo, "sync", "ReplicatedStorage", "Config.luau");
    write(config_, "return { damage = 12 }");
    (daemon as any).tree.getNode("cfg").source = "return { damage = 12 }";
    git(repo, "commit", "-q", "-am", "main moves on");
    write(path.join(worktree, "sync", "ReplicatedStorage", "Config.luau"), "return { damage = 25 }");
    git(worktree, "commit", "-q", "-am", "feature");

    const playing = daemon.startPlay(worktree);
    await new Promise((r) => setTimeout(r, 50));
    const swap = sent.find((m) => m.type === "playOverlay");
    assert.deepEqual(swap.patches, [{ guid: "cfg", source: "return { damage = 25 }" }]);
    (daemon as any).handleStudioMessage({ type: "playOverlayResult", id: swap.id, ok: true, windowMs: 1500 });
    const state = await playing;
    assert.equal(state.conflicts.length, 1);
    sent.length = 0;

    // ~3 s later Studio holds the branch's text again and sends it, as an edit from the place's text
    const branchBack = { guid: "cfg", source: "return { damage = 25 }", path: ["ReplicatedStorage", "Config"], className: "ModuleScript", base: "return { damage = 12 }" };
    (daemon as any).handleStudioMessage({ type: "scriptChanged", data: branchBack });
    assert.equal(fs.readFileSync(config_, "utf8"), "return { damage = 12 }", "the place's folder keeps its text");
    assert.deepEqual(
      sent.filter((m) => m.type === "patchScript"),
      [{ type: "patchScript", guid: "cfg", source: "return { damage = 12 }" }],
      "Studio gets the place's text back",
    );
    assert.equal((daemon as any).tree.getNode("cfg").source, "return { damage = 12 }");
    assert.equal(git(repo, "status", "--porcelain").trim(), "");

    // A play of another worktree right after, swapping Config with its own text, keeps the first
    // play's text of Config covered
    const other = path.join(root, "Game-other");
    git(repo, "worktree", "add", "-q", "-b", "other", other);
    write(path.join(other, "sync", "ReplicatedStorage", "Config.luau"), "return { damage = 30 }");
    git(other, "commit", "-q", "-am", "other");
    const second = daemon.startPlay(other);
    await new Promise((r) => setTimeout(r, 50));
    const swap2 = sent.find((m) => m.type === "playOverlay");
    assert.deepEqual(swap2.patches, [{ guid: "cfg", source: "return { damage = 30 }" }]);
    (daemon as any).handleStudioMessage({ type: "playOverlayResult", id: swap2.id, ok: true, windowMs: 1500 });
    await second;
    sent.length = 0;
    (daemon as any).handleStudioMessage({ type: "scriptChanged", data: branchBack });
    assert.equal(fs.readFileSync(config_, "utf8"), "return { damage = 12 }", "the first play's echo is still refused");
    assert.equal(sent.filter((m) => m.type === "patchScript").length, 1);

    // A real edit in Studio still goes to disk, during the window or not
    (daemon as any).handleStudioMessage({
      type: "scriptChanged",
      data: { ...branchBack, source: "return { damage = 13 }", base: "return { damage = 12 }" },
    });
    assert.equal(fs.readFileSync(config_, "utf8"), "return { damage = 13 }");

    // Once the window is over, the same text is an edit like any other
    for (const r of (daemon as any).playEcho.get("cfg")) r.until = Date.now() - 1;
    (daemon as any).handleStudioMessage({ type: "scriptChanged", data: { ...branchBack, base: "return { damage = 13 }" } });
    assert.equal(fs.readFileSync(config_, "utf8"), "return { damage = 25 }");
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

// 08/11/26: several worktrees in one play (Anime Astral: 346 of 355 branch plays carried one job)
test("play of several worktrees: one swap in the plugin's order, each check owned by its worktree, the answer split", async () => {
  const { root, repo, worktree } = fixture();
  const other = path.join(root, "Game-other");
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

    // A: Config changed and a new Guilds. B: Same changed, a new Shop, OldSystem deleted
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
    write(path.join(worktree, "sync", "ReplicatedStorage", "Config.luau"), "return { damage = 25 }");
    write(path.join(worktree, "sync", "ServerScriptService", "Guilds.server.luau"), "print('guilds')");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "-m", "a");
    git(repo, "worktree", "add", "-q", "-b", "other", other);
    write(path.join(other, "sync", "ReplicatedStorage", "Same.luau"), "local a = 9\nreturn a");
    write(path.join(other, "sync", "ServerScriptService", "Shop.server.luau"), "print('shop')");
    fs.rmSync(path.join(other, "sync", "ServerScriptService", "OldSystem.server.luau"));
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "b");

    const playing = daemon.startPlay([worktree, other]);
    await new Promise((r) => setTimeout(r, 50));
    const swaps = sent.filter((m) => m.type === "playOverlay");
    assert.equal(swaps.length, 1, "one swap for both");
    const swap = swaps[0];
    // PlayOverlay.luau numbers its marks patches first, then creates, then disables: the merged
    // checks must keep that order, or every mark lands on another check's path
    assert.deepEqual(swap.patches.map((p: any) => p.guid), ["cfg", "same"]);
    assert.deepEqual(swap.creates.map((c: any) => c.name), ["Guilds", "Shop"]);
    assert.deepEqual(swap.disables, [{ guid: "old" }]);
    assert.deepEqual(
      swap.checks.map((c: any) => c.path.join(".")),
      ["ReplicatedStorage.Config", "ReplicatedStorage.Same", "ServerScriptService.Guilds", "ServerScriptService.Shop", "ServerScriptService.OldSystem"],
    );

    (daemon as any).handleStudioMessage({ type: "playOverlayResult", id: swap.id, ok: true, windowMs: 900, applied: 5 });
    const state = await playing;
    assert.equal(state.worktrees.length, 2);
    assert.deepEqual(state.worktrees.map((w) => [path.basename(w.worktree), w.patches, w.creates, w.disables, w.checks]), [
      ["Game-feature", 1, 1, 0, 2],
      ["Game-other", 1, 1, 1, 3],
    ]);
    assert.deepEqual(state.worktrees[0].files.map((f) => f.split(path.sep).join("/")).sort(), ["ReplicatedStorage/Config.luau", "ServerScriptService/Guilds.server.luau"]);

    // B's Same did not arrive: only B fails, A is in the play
    (daemon as any).handleStudioMessage({
      type: "playVerify",
      id: swap.id,
      ok: false,
      passed: 4,
      failed: ["ReplicatedStorage.Same has the place's text, not the branch's"],
      unverified: ["ServerScriptService.Guilds"],
    });
    const [a, b] = state.worktrees;
    assert.deepEqual(a.verify, { ok: true, passed: 1, failed: [], unverified: ["ServerScriptService.Guilds"] });
    assert.deepEqual(b.verify, { ok: false, passed: 2, failed: ["ReplicatedStorage.Same has the place's text, not the branch's"], unverified: [] });
  } finally {
    await daemon?.stop();
    Object.assign(config, prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("play of several worktrees: two that change the same script are refused, by file and by instance", async () => {
  const { root, repo, worktree } = fixture();
  const other = path.join(root, "Game-other");
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
    git(repo, "worktree", "add", "-q", "-b", "other", other);
    write(path.join(worktree, "sync", "ReplicatedStorage", "Config.luau"), "return { damage = 25 }");
    write(path.join(other, "sync", "ReplicatedStorage", "Config.luau"), "return { damage = 30 }");
    await assert.rejects(daemon.startPlay([worktree, other]), /both change ReplicatedStorage[\\/]Config\.luau/);
    assert.equal(sent.filter((m) => m.type === "playOverlay").length, 0, "nothing goes to Studio");

    // Another file, the same instance: Shop.luau in one, Shop.server.luau in the other
    git(other, "checkout", "-q", "--", ".");
    write(path.join(worktree, "sync", "ServerScriptService", "Shop.luau"), "return 1");
    write(path.join(other, "sync", "ServerScriptService", "Shop.server.luau"), "print(1)");
    git(worktree, "add", "-A");
    git(other, "add", "-A");
    git(worktree, "checkout", "-q", "--", "sync/ReplicatedStorage/Config.luau");
    await assert.rejects(daemon.startPlay([worktree, other]), /both change ServerScriptService\.Shop/);

    // The same worktree named twice is one worktree
    const once = daemon.startPlay([worktree, worktree + path.sep]);
    await new Promise((r) => setTimeout(r, 50));
    const swap = sent.find((m) => m.type === "playOverlay");
    (daemon as any).handleStudioMessage({ type: "playOverlayResult", id: swap.id, ok: true, windowMs: 1 });
    assert.equal((await once).worktrees.length, 1);
  } finally {
    await daemon?.stop();
    Object.assign(config, prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("play of several worktrees: a swap Studio refused names the worktree whose script it was", async () => {
  const { splitSwapFailures } = await import("../play/overlay.js");
  const part = (worktree: string, patches: any[], creates: any[] = []) => ({
    worktree,
    overlay: { patches, creates, disables: [], skipped: [], conflicts: [], files: [] },
  });
  const parts = [
    part("A", [{ guid: "g1", source: "", path: ["ReplicatedStorage", "Big"], hash: "" }]),
    part("B", [{ guid: "g2", source: "", path: ["ReplicatedStorage", "Small"], hash: "" }], [
      { className: "Script", name: "Shop", parentPath: ["ServerScriptService"], source: "", hash: "" },
    ]),
  ];
  assert.deepEqual(
    splitSwapFailures(parts, [
      "ReplicatedStorage.Big: Source too long",
      "script g2 is not in the place any more",
      "new Script ServerScriptService.Shop: no",
      "something nobody owns",
    ]),
    [
      ["ReplicatedStorage.Big: Source too long", "something nobody owns"],
      ["script g2 is not in the place any more", "new Script ServerScriptService.Shop: no", "something nobody owns"],
    ],
  );
});

test("quackdev play -w a -w b: one line per worktree, ok only when both are in the play, and an old hub is named", async () => {
  const { runControl } = await import("../control/commands.js");
  const { HubError } = await import("../control/hubClient.js");
  const A = path.join(os.tmpdir(), "A");
  const B = path.join(os.tmpdir(), "B");
  const run = async (answer: any, verify: any, post?: () => Promise<any>) => {
    const out: string[] = [];
    const err: string[] = [];
    const bodies: any[] = [];
    const client = {
      get: async (pathname: string) => pathname === "/api/state" ? { places: [{ placeId: "5", name: "Game", folder: os.tmpdir() }] } : ({ play: { ...answer, verify, worktrees: answer.worktrees?.map((w: any, i: number) => ({ ...w, verify: verify?.parts?.[i] })) } }),
      post: post ?? (async (_: string, body: any) => (bodies.push(body), { play: answer })),
    };
    const code = await runControl(["play", "5", "-w", A, "-w", B], {
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
    return { code, out: out.join("\n"), err: err.join("\n"), bodies };
  };
  const answer = {
    id: "p1",
    worktree: A,
    done: true,
    patches: 2,
    creates: 0,
    disables: 0,
    skipped: [],
    conflicts: [],
    checks: 2,
    result: { ok: true, windowMs: 900 },
    worktrees: [
      { worktree: A, patches: 1, creates: 0, disables: 0, skipped: [], conflicts: [], checks: 1, files: [] },
      { worktree: B, patches: 1, creates: 0, disables: 0, skipped: [], conflicts: [], checks: 1, files: [] },
    ],
  };
  const both = await run(answer, { ok: true, passed: 2, failed: [], parts: [{ ok: true, passed: 1, failed: [], unverified: [] }, { ok: true, passed: 1, failed: [], unverified: [] }] });
  assert.equal(both.code, 0);
  assert.deepEqual(both.bodies, [{ placeId: "5", worktrees: [A, B] }]);
  assert.match(both.out, /Playing 2 worktrees/);
  assert.equal((both.out.match(/1 of 1 have the branch/g) ?? []).length, 2);

  const oneBad = await run(answer, {
    ok: false,
    passed: 1,
    failed: ["ReplicatedStorage.B has the place's text, not the branch's"],
    parts: [{ ok: true, passed: 1, failed: [], unverified: [] }, { ok: false, passed: 0, failed: ["ReplicatedStorage.B has the place's text, not the branch's"], unverified: [] }],
  });
  assert.equal(oneBad.code, 1);
  assert.match(oneBad.err, new RegExp(`does NOT have ${B.replace(/\\/g, "\\\\")}'s branch`));

  // A hub from before 08/11/26 answers 400 to a list
  const old = await run(answer, undefined, async () => {
    throw new HubError(400, "worktree must be an absolute path");
  });
  assert.equal(old.code, 1);
  assert.match(old.err, /plays one worktree at a time/);

  // A daemon from before 08/11/26 behind a newer hub played the first only
  const { worktrees: _, ...single } = answer;
  const firstOnly = await run(single, { ok: true, passed: 1, failed: [] });
  assert.equal(firstOnly.code, 1, "not every worktree is in the play");
  assert.match(firstOnly.err, /plays one worktree at a time.*only .*A is in this play/);
});
