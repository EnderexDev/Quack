import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "..", "plugin", "scripts", "build-rbxmx.mjs");

function build(dev: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-plugin-"));
  try {
    const out = path.join(dir, "Plugin.rbxmx");
    execFileSync(process.execPath, [script, out, ...(dev ? ["--dev"] : [])], { stdio: "pipe" });
    return fs.readFileSync(out, "utf8");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Both plugins load in every Studio: a line from the Dev one has to say so, or it reads as the
// Official plugin's (seen 21/10/26 with [WebSocket] and [QuackService] lines)
test("every log prefix of the Dev plugin says QuackDev", () => {
  const prefixes = [...build(true).matchAll(/(?:warn|print)\(\s*["`](\[[^\]]*\])/g)].map((m) => m[1]);
  assert.ok(prefixes.length > 40, `found only ${prefixes.length} log calls`);
  const stray = [...new Set(prefixes.filter((p) => !p.includes("QuackDev")))];
  assert.deepEqual(stray, []);
});

test("the Official plugin never says QuackDev", () => {
  assert.ok(!build(false).includes("QuackDev"));
});

// Dev tells apart from Official by colour alone: green brand and green toolbar Q, never yellow
test("the Dev plugin is green and the Official one stays yellow", () => {
  const dev = build(true);
  const official = build(false);
  assert.ok(dev.includes('Brand = Color3.fromHex("5ee36a")'));
  assert.ok(!dev.includes("ffd41f"));
  assert.ok(!dev.includes("79454901305076") && !dev.includes("101555384706119"));
  assert.ok(dev.includes("132862432873131") && dev.includes("86744950721031"));
  assert.ok(official.includes("79454901305076") && official.includes("101555384706119"));
  assert.ok(official.includes('Brand = Color3.fromHex("ffd41f")'));
  assert.ok(!official.includes("5ee36a"));
});

// In Team Create, .Source leaves a collaborator's open tab on the old text and their next
// keystroke writes it back (EnemyConfig, Anime Astral, 23/10/26). Measured 25/10/26 with two
// Studios: UpdateSourceAsync and EditTextAsync reach that tab. Nothing here runs Luau, so this
// pins the shape: the .Source shortcut only outside Team Create or on a fresh instance, and
// patches of one script one at a time (each write there yields ~258 ms).
test("in Team Create the plugin never writes an existing script by .Source", () => {
  const plugin = build(false);
  const setSource = plugin.match(/function QuackService\.setScriptSource\([\s\S]*?\nend\n/)?.[0] ?? "";
  assert.ok(setSource.length > 0, "setScriptSource not found");
  assert.match(plugin, /function QuackService\.isTeamCreate\(\)[\s\S]{0,120}FindService\("NetworkClient"\)/);
  const shortcuts = [...setSource.matchAll(/^.*scriptInstance\.Source = source.*$/gm)];
  assert.equal(shortcuts.length, 1);
  const guard = setSource.slice(0, shortcuts[0].index).split("\n").slice(-2).join("\n");
  assert.match(guard, /\(fresh or not QuackService\.isTeamCreate\(\)\)/);
  assert.match(plugin, /if message\.type == "patchScript" then[\s\S]{0,200}withScriptPatchLock\(message\.guid/);
});

// A Run-mode server of a big place loads its plugins before RunService:IsRunning() turns true
// (Anime Astral copy, 275k instances, 08/11/26): gated on IsRunning alone, the plugin there
// took the edit path and asked the hub to sync the place as a second Studio, and `playtest
// start --run` never saw a server peer. IsEdit is false in every play DataModel from the start
// (chrrxs's PeerRole.detect relies on it), so the play branch has to be taken on it too.
test("a play DataModel is told apart from the edit one by IsEdit, not IsRunning alone", () => {
  for (const plugin of [build(false), build(true)]) {
    const branch = plugin.match(/-- Playtest DataModels only relay output[\s\S]*?\nif (.*) then\n\s*const OutputRelay = require/);
    assert.ok(branch, "the play branch of QuackPlugin.server.luau was not found");
    assert.match(branch[1], /not RunService:IsEdit\(\)/);
  }
});

// 09/11/26, the Astral copy: AssetService:LoadAssetAsync and InsertService:LoadAsset both answered
// "User is not authorized to access Asset" for a free Creator Store model (183435411) the user does
// not own, while game:GetObjects (what the Toolbox uses) loaded it from the plugin, 329 instances.
test("preview_asset and insert_asset fall back to game:GetObjects when LoadAssetAsync refuses a free model", () => {
  const source = fs.readFileSync(path.join(here, "..", "..", "plugin", "sync", "ReplicatedFirst", "QuackPlugin", "StudioTools.luau"), "utf8");
  const start = source.indexOf("local function loadAsset(");
  const body = source.slice(start, source.indexOf("\nend", start));
  assert.ok(start > 0, "loadAsset exists");
  assert.match(body, /LoadAssetAsync/);
  assert.match(body, /GetObjects\(`rbxassetid:\/\/\{assetId\}`\)/, "the fallback loads by rbxassetid");
  assert.ok(body.indexOf("GetObjects") > body.indexOf("LoadAssetAsync"), "LoadAssetAsync first, GetObjects when it fails");
});
