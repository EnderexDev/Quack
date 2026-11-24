import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Quack Test's own cache for these tests, never the user's
process.env.QUACK_TEST_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "quacktest-cache-"));

const { executeTests } = await import("../quacktest/execute.js");
const { engine } = await import("../quacktest/lune.js");
const { StandbyPool } = await import("../quacktest/pool.js");
const { findSpecs, treeSource } = await import("../quacktest/project.js");
const { reachingSpecs } = await import("../quacktest/reach.js");
const { classify, reportFailed, reportText } = await import("../quacktest/report.js");
const { runTestCommand } = await import("../quacktest/command.js");
const { editText, playText } = await import("../quacktest/text.js");
const { QuackHub } = await import("../hub/hub.js");
const { saveRegistry } = await import("../hub/registry.js");
const { reviewAnswer } = await import("../control/review.js");
const { LuneProcess } = await import("../quacktest/runner.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonCli = path.join(here, "..", "cli.js");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function post(port: number, pathname: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

type Files = Record<string, string>;

interface MapNode {
  name: string;
  className: string;
  filePaths?: string[];
  children?: MapNode[];
}

/** A synced project: sync/ files, tests/ files, and a sourcemap made from `tree` */
function project(sync: Files, tests: Files, tree?: MapNode[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quacktest-"));
  for (const [rel, text] of Object.entries(sync)) {
    const p = path.join(root, "sync", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  for (const [rel, text] of Object.entries(tests)) {
    const p = path.join(root, "tests", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  if (tree) fs.writeFileSync(path.join(root, "sourcemap.json"), JSON.stringify({ name: "Game", className: "DataModel", children: tree }));
  return root;
}

const module = (name: string, file: string, children?: MapNode[]): MapNode => ({ name, className: "ModuleScript", filePaths: [file], ...(children ? { children } : {}) });

const byName = (report: Awaited<ReturnType<typeof executeTests>>) => new Map(report.rows.map((r) => [r.test, r]));

test("classify: an assertion fails, a piece of Roblox Lune lacks did not run, the game's own error fails", () => {
  assert.deepEqual(classify({ message: "expected 1 (number) to be 2 (number)", expect: true }), { status: "failed" });
  assert.equal(classify({ message: "Raycast is not a valid member of Workspace" }).status, "notRun");
  assert.match(classify({ message: "Raycast is not a valid member of Workspace" }).reason!, /Workspace\.Raycast does not exist outside Studio/);
  // a child the tree lacks is not a member of the class: said as a child
  assert.match(classify({ message: "Coins is not a valid member of Folder" }).reason!, /no child or member "Coins"/);
  // wrapped by the game's own loader: the inner cause still counts
  assert.match(classify({ message: "sync/Library.luau:325: Erro ao carregar Util 'X': GetHashMap is not a valid member of MemoryStoreService" }).reason!, /MemoryStoreService\.GetHashMap/);
  assert.equal(classify({ message: "[outside Studio] settings()" }).reason, "settings()");
  assert.equal(classify({ message: "sync/A.luau:3: attempt to index nil with 'x'" }).status, "failed");
  assert.equal(classify({ message: "timed out after 10 s", timeout: true }).status, "failed");
});

test("a project's specs run against its sourcemap: passes, failures and what did not run, each with its line", async (t) => {
  if (!engine()) return t.skip("no Lune: node scripts/fetch-lune.mjs");
  const root = project(
    {
      "ReplicatedStorage/Shop.luau": `local Config = require(script.Parent.Config)
local Shop = {}
function Shop.price(level) return Config.base * level end
function Shop.buy(level) return workspace:Raycast(Vector3.zero, Vector3.one) end
return Shop`,
      "ReplicatedStorage/Config.luau": "return { base = 10 }",
      "ReplicatedStorage/Saver.luau": `local store = game:GetService("DataStoreService"):GetDataStore("Players")
return { save = function(id, v) store:SetAsync(tostring(id), v) end, load = function(id) return store:GetAsync(tostring(id)) end }`,
      // on disk only: made after the sourcemap was written
      "ReplicatedStorage/Fresh.luau": "return 'fresh'",
      "ReplicatedStorage/Loader.luau": `local ok, m = pcall(require, script.Parent.Broken)
if not ok then error(string.format("Erro ao carregar %s: %s", "Broken", m)) end
return m`,
      "ReplicatedStorage/Broken.luau": `local map = game:GetService("BadgeService"):AwardBadge(1, 2)
return {}`,
    },
    {
      "setup.luau": `local remote = Instance.new("RemoteEvent")
remote.Name = "Ping"
remote.Parent = game:GetService("ReplicatedStorage")
return nil`,
      "Shop/ShopSpec.luau": `local RS = game:GetService("ReplicatedStorage")
local T = require("@quack/test")
local expect, network = T.expect, T.network
return {
  ["price grows with the level"] = function() print("price checked") expect(require(RS.Shop).price(3)).toBe(30) end,
  ["a wrong price fails"] = function()
    expect(require(RS.Shop).price(2)).toBe(21)
  end,
  ["never negates"] = function() expect(5).never.toBe(6) end,
  ["buy needs physics"] = function() require(RS.Shop).buy(1) end,
  ["a module made after the sourcemap loads"] = function() expect(require(RS.Fresh)).toBe("fresh") end,
  ["a module the disk lost is gone"] = function() local x = RS.Gone end,
  ["a wrapped cause is still found"] = function() require(RS.Loader) end,
  ["saves"] = function()
    local Saver = require(RS.Saver)
    expect(Saver.load(1)).toBeNil()
    Saver.save(1, { coins = 5 })
    expect(Saver.load(1)).toEqual({ coins = 5 })
  end,
  ["the stores are empty again"] = function() expect(require(RS.Saver).load(1)).toBeNil() end,
  ["a remote round trip"] = function()
    local remote = RS:WaitForChild("Ping")
    network.server(function()
      remote.OnServerEvent:Connect(function(player, m) remote:FireClient(player, m .. " pong") end)
    end)
    local reply
    network.client(function()
      remote.OnClientEvent:Connect(function(m) reply = m end)
      remote:FireServer("ping")
    end)
    network.flush()
    expect(reply).toBe("ping pong")
  end,
  ["an attribute's signal"] = function()
    local f = Instance.new("Folder")
    local seen
    f:GetAttributeChangedSignal("Level"):Connect(function() seen = f:GetAttribute("Level") end)
    f:SetAttribute("Level", 4)
    network.flush(2)
    expect(seen).toBe(4)
  end,
  ["dates and tweens"] = function()
    expect(DateTime.fromUnixTimestampMillis(86400000):FormatUniversalTime("YYYY-MM-DD HH:mm", "en-us")).toBe("1970-01-02 00:00")
    expect(typeof(TweenInfo.new(1))).toBe("TweenInfo")
    expect(RaycastParams.new().FilterType).toBe(Enum.RaycastFilterType.Exclude)
  end,
  ["the game's prints stay with the test"] = function() print("from the test") error("boom") end,
}`,
      "Other/OtherSpec.luau": `local expect = require("@quack/test").expect
local helper = require("./helper")
return { ["uses a helper"] = function() expect(helper.double(2)).toBe(4) end }`,
      "Other/helper.luau": "return { double = function(x) return x * 2 end }",
    },
    [
      {
        name: "ReplicatedStorage",
        className: "ReplicatedStorage",
        children: [
          module("Shop", "sync/ReplicatedStorage/Shop.luau"),
          module("Config", "sync/ReplicatedStorage/Config.luau"),
          module("Saver", "sync/ReplicatedStorage/Saver.luau"),
          module("Loader", "sync/ReplicatedStorage/Loader.luau"),
          module("Broken", "sync/ReplicatedStorage/Broken.luau"),
          // in the sourcemap, no longer on disk
          module("Gone", "sync/ReplicatedStorage/Gone.luau"),
        ],
      },
    ],
  );
  const report = await executeTests({ root });
  assert.equal(report.error, undefined, report.error);
  const rows = byName(report);
  const status = (name: string) => rows.get(name)?.status;
  for (const name of ["price grows with the level", "never negates", "a module made after the sourcemap loads", "saves", "the stores are empty again", "a remote round trip", "an attribute's signal", "dates and tweens", "uses a helper"]) {
    assert.equal(status(name), "passed", `${name}: ${rows.get(name)?.message}`);
  }
  const wrong = rows.get("a wrong price fails")!;
  assert.equal(wrong.status, "failed");
  assert.equal(wrong.line, 7);
  assert.match(wrong.message!, /expected 20 \(number\) to be 21 \(number\)/);
  const buy = rows.get("buy needs physics")!;
  assert.equal(buy.status, "notRun");
  assert.match(buy.reason!, /Workspace\.Raycast/);
  assert.equal(buy.where, "sync/ReplicatedStorage/Shop.luau:4");
  assert.equal(status("a module the disk lost is gone"), "notRun");
  const wrapped = rows.get("a wrapped cause is still found")!;
  assert.equal(wrapped.status, "notRun");
  assert.match(wrapped.reason!, /BadgeService\.AwardBadge/);
  assert.equal(wrapped.where, "sync/ReplicatedStorage/Broken.luau:1");
  const printed = rows.get("the game's prints stay with the test")!;
  assert.equal(printed.status, "failed");
  assert.deepEqual(printed.output, ["from the test"]);
  assert.equal(report.stats.specs, 2);
  assert.equal(reportFailed(report), true);
  const text = reportText(report);
  assert.match(text, /tests\/Shop\/ShopSpec\.luau:7  failed  a wrong price fails: expected 20/);
  assert.match(text, /9 passed, 2 failed, 3 did not run outside Studio: 14 tests in 2 specs/);
  assert.doesNotMatch(text, /price grows with the level/, "a pass is listed only in the verbose mode");
  assert.match(reportText(report, true), /passed  price grows with the level \([\d.]+ ms\)\n    \| price checked/, "verbose shows what a passed test printed");

  // the tree was kept: a second run reads the .rbxl instead of the sourcemap
  const source = await treeSource(root);
  assert.ok(!("error" in source) && source.tree.cache && fs.existsSync(source.tree.cache));
  const again = await executeTests({ root, files: [path.join(root, "tests", "Other", "OtherSpec.luau")] });
  assert.deepEqual(again.rows.map((r) => [r.test, r.status]), [["uses a helper", "passed"]]);
});

test("the specs an edit reaches: through the requires the analyzer reads, a helper, or setup.luau", async () => {
  const root = project(
    {
      "ReplicatedStorage/Config.luau": "return { base = 10 }",
      "ReplicatedStorage/Shop.luau": "local Config = require(script.Parent.Config)\nreturn { price = function(l) return Config.base * l end }",
      "ReplicatedStorage/Pets.luau": "return {}",
    },
    {
      "ShopSpec.luau": `local RS = game:GetService("ReplicatedStorage")\nreturn { a = function() require(RS.Shop) end }`,
      "PetsSpec.luau": `local helper = require("./petsHelper")\nreturn { a = function() helper() end }`,
      "petsHelper.luau": `return function() return require(game:GetService("ReplicatedStorage").Pets) end`,
      "setup.luau": "return nil",
    },
    [
      {
        name: "ReplicatedStorage",
        className: "ReplicatedStorage",
        children: [module("Config", "sync/ReplicatedStorage/Config.luau"), module("Shop", "sync/ReplicatedStorage/Shop.luau"), module("Pets", "sync/ReplicatedStorage/Pets.luau")],
      },
    ],
  );
  const names = async (...files: string[]) => (await reachingSpecs(root, files.map((f) => path.join(root, f)))).map((s) => s.name);
  assert.deepEqual(await names("sync/ReplicatedStorage/Config.luau"), ["ShopSpec"]);
  assert.deepEqual(await names("sync/ReplicatedStorage/Pets.luau"), ["PetsSpec"]);
  assert.deepEqual(await names("tests/petsHelper.luau"), ["PetsSpec"]);
  assert.deepEqual(await names("tests/setup.luau"), ["PetsSpec", "ShopSpec"]);
  assert.deepEqual(findSpecs(root).map((s) => s.name), ["PetsSpec", "ShopSpec"]);
});

test("the hub's pool: a ready process serves the next run, and none is left behind", async (t) => {
  if (!engine()) return t.skip("no Lune: node scripts/fetch-lune.mjs");
  const root = project({ "ReplicatedStorage/A.luau": "return 1" }, { "ASpec.luau": `return { one = function() require("@quack/test").expect(require(game:GetService("ReplicatedStorage").A)).toBe(1) end }` }, [
    { name: "ReplicatedStorage", className: "ReplicatedStorage", children: [module("A", "sync/ReplicatedStorage/A.luau")] },
  ]);
  const pool = new StandbyPool();
  const first = await executeTests({ root, pool });
  assert.equal(first.stats.warm, false);
  assert.equal(first.stats.passed, 1);
  assert.equal(pool.size, 1, "the next process is loading while nobody waits");
  const second = await executeTests({ root, pool });
  assert.equal(second.stats.warm, true);
  assert.equal(second.stats.passed, 1);
  const kept = (pool as any).kept.values().next().value.proc;
  await kept.ready;
  const pid = kept.pid as number;
  // a run going on when the pool stops ends with it, and none starts after
  fs.writeFileSync(path.join(root, "tests", "SlowSpec.luau"), "return { slow = function() task.wait(30) end }");
  const t0 = Date.now();
  const running = executeTests({ root, pool, files: [path.join(root, "tests", "SlowSpec.luau")] });
  await new Promise((r) => setTimeout(r, 300));
  pool.stop();
  const stopped = await running;
  assert.ok(Date.now() - t0 < 10_000, "not after the slow test's 30 s");
  assert.match(stopped.error ?? "", /Lune exited/);
  assert.ok(await gone(pid), "the pool's process exits when the pool stops");
  assert.match((await executeTests({ root, pool })).error ?? "", /the hub is stopping/);
});

test("a ready process exits by itself when the process that started it dies", async (t) => {
  if (!engine()) return t.skip("no Lune: node scripts/fetch-lune.mjs");
  const root = project({ "ReplicatedStorage/A.luau": "return 1" }, {}, [{ name: "ReplicatedStorage", className: "ReplicatedStorage", children: [module("A", "sync/ReplicatedStorage/A.luau")] }]);
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "quacktest", "runner.js");
  const lune = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "quacktest", "lune.js");
  const projectJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "quacktest", "project.js");
  const script = `
    const { LuneProcess } = await import(${JSON.stringify(new URL(`file:///${runner.replace(/\\/g, "/")}`).href)});
    const { engine } = await import(${JSON.stringify(new URL(`file:///${lune.replace(/\\/g, "/")}`).href)});
    const { treeSource } = await import(${JSON.stringify(new URL(`file:///${projectJs.replace(/\\/g, "/")}`).href)});
    const source = await treeSource(${JSON.stringify(root)});
    const p = new LuneProcess(engine(), source.tree);
    await p.ready;
    console.log(p.pid);
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"], env: process.env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  await new Promise((resolve) => child.on("exit", resolve));
  const pid = Number(out.trim());
  assert.ok(pid > 0, `the child printed ${out}`);
  assert.ok(await gone(pid), "Lune exits once its stdin closes");
});

test("quack test with no specs says so and exits 0; with one that fails, exits 1", async (t) => {
  if (!engine()) return t.skip("no Lune: node scripts/fetch-lune.mjs");
  const none = project({ "ReplicatedStorage/A.luau": "return 1" }, {});
  const lines: string[] = [];
  assert.equal(await runTestCommand({ cwd: none, files: [], json: false, verbose: false, out: (l) => lines.push(l) }), 0);
  assert.match(lines.join("\n"), /No specs in/);
  // no sourcemap: the sync folder's tree
  const failing = project({ "ReplicatedStorage/A.luau": "return 1" }, { "ASpec.luau": `return { one = function() require("@quack/test").expect(require(game:GetService("ReplicatedStorage").A)).toBe(2) end }` });
  const json: string[] = [];
  assert.equal(await runTestCommand({ cwd: failing, files: [], json: true, verbose: false, out: (l) => json.push(l) }), 1);
  const report = JSON.parse(json.join("\n"));
  assert.equal(report.stats.failed, 1);
  assert.match(report.stats.tree, /sync folder/);
});

test("a worktree runs its own scripts against the synced checkout's sourcemap, its new script included", async (t) => {
  if (!engine()) return t.skip("no Lune: node scripts/fetch-lune.mjs");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", encoding: "utf8" });
  const checkout = project(
    { "ReplicatedStorage/Price.luau": "return { of = function(l) return 10 * l end }" },
    { "PriceSpec.luau": `local expect = require("@quack/test").expect
return { ["price"] = function() expect(require(game:GetService("ReplicatedStorage").Price).of(2)).toBe(20) end }` },
    [{ name: "ReplicatedStorage", className: "ReplicatedStorage", children: [module("Price", "sync/ReplicatedStorage/Price.luau")] }],
  );
  git(checkout, "init", "-q");
  git(checkout, "-c", "user.email=t@t", "-c", "user.name=t", "add", "sync", "tests");
  git(checkout, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "place");
  const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "quacktest-wt-")), "branch");
  git(checkout, "worktree", "add", "-q", worktree);
  assert.equal(fs.existsSync(path.join(worktree, "sourcemap.json")), false, "the sourcemap is not committed");
  // the branch changes the price and adds a module the sourcemap never had
  fs.writeFileSync(path.join(worktree, "sync", "ReplicatedStorage", "Price.luau"), "return { of = function(l) return 11 * l end }");
  fs.writeFileSync(path.join(worktree, "sync", "ReplicatedStorage", "Bonus.luau"), "return 5");
  fs.writeFileSync(path.join(worktree, "tests", "BonusSpec.luau"), `local expect = require("@quack/test").expect
return { ["bonus"] = function() expect(require(game:GetService("ReplicatedStorage").Bonus)).toBe(5) end }`);
  const report = await executeTests({ root: worktree, placeFolders: async () => [checkout] });
  assert.equal(report.error, undefined, report.error);
  assert.equal(report.stats.tree, `tree from ${path.join(checkout, "sourcemap.json")}`);
  assert.deepEqual(report.rows.map((r) => [r.test, r.status]), [["bonus", "passed"], ["price", "failed"]], "the worktree's text, not the checkout's");
  assert.match(report.rows[1].message!, /expected 22 \(number\) to be 20/);
});

test("hub: /api/test runs what quack test asks, the specs an AI's edit reaches, every spec before a play, each as its setting says", { timeout: 120000 }, async (t) => {
  if (!engine()) return t.skip("no Lune: node scripts/fetch-lune.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quacktest-hub-"));
  const folder = path.join(tmp, "Game");
  fs.mkdirSync(folder);
  const made = project(
    {
      "ReplicatedStorage/Config.luau": "return { base = 10 }",
      "ReplicatedStorage/Shop.luau": "local Config = require(script.Parent.Config)\nreturn { price = function(l) return Config.base * l end }",
      "ReplicatedStorage/Pets.luau": "return { count = 3 }",
    },
    {
      "ShopSpec.luau": `local RS = game:GetService("ReplicatedStorage")
local expect = require("@quack/test").expect
return { ["price"] = function() expect(require(RS.Shop).price(2)).toBe(20) end }`,
      "PetsSpec.luau": `local RS = game:GetService("ReplicatedStorage")
local expect = require("@quack/test").expect
return { ["count"] = function() expect(require(RS.Pets).count).toBe(4) end }`,
    },
    [
      {
        name: "ReplicatedStorage",
        className: "ReplicatedStorage",
        children: [module("Config", "sync/ReplicatedStorage/Config.luau"), module("Shop", "sync/ReplicatedStorage/Shop.luau"), module("Pets", "sync/ReplicatedStorage/Pets.luau")],
      },
    ],
  );
  fs.cpSync(made, folder, { recursive: true });
  const registryFile = path.join(tmp, "hub-dev.json");
  saveRegistry(registryFile, { places: { "777": { folder, name: "Game" } } });
  const port = await freePort();
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {} });
  await hub.start();
  try {
    // quack test: every spec, then the next process is made ready
    const all = (await post(port, "/api/test", { root: folder })).body;
    assert.deepEqual(all.rows.map((r: any) => [r.test, r.status]), [["count", "failed"], ["price", "passed"]]);
    assert.equal(all.stats.warm, false);
    const again = (await post(port, "/api/test", { root: folder, filter: ["price"] })).body;
    assert.equal(again.stats.warm, true, "the second run finds the tree loaded");
    assert.deepEqual(again.rows.map((r: any) => r.test), ["price"]);
    assert.equal(again.stats.specs, 1, "a spec none of whose tests the filter kept is not counted");

    // after an edit: only the specs the edited file reaches
    const config = path.join(folder, "sync", "ReplicatedStorage", "Config.luau");
    const edit = (await post(port, "/api/test", { feature: "edit", files: [config] })).body;
    assert.equal(edit.reports.length, 1);
    assert.deepEqual(edit.reports[0].rows.map((r: any) => r.test), ["price"]);
    assert.match(editText(edit.reports), /the 1 test of the 1 spec this edit reaches passed/);
    const pets = path.join(folder, "sync", "ReplicatedStorage", "Pets.luau");
    const petsEdit = (await post(port, "/api/test", { feature: "edit", files: [pets] })).body;
    assert.match(editText(petsEdit.reports), /tests\/PetsSpec\.luau:3  failed  count: expected 3 \(number\) to be 4/);
    // the review hook carries it with the analysis's answer
    const hook = JSON.parse(await reviewAnswer(JSON.stringify({ tool_input: { file_path: pets } }), { client: "claude", port }));
    assert.match(hook.hookSpecificOutput.additionalContext, /Quack Test, the specs this edit reaches/);
    // an edit no spec reaches says nothing
    const lonely = path.join(folder, "sync", "ReplicatedStorage", "Lonely.luau");
    fs.writeFileSync(lonely, "return 1");
    assert.deepEqual((await post(port, "/api/test", { feature: "edit", files: [lonely] })).body.reports, []);

    // before a play: every spec, a warning
    const play = (await post(port, "/api/test", { feature: "play", placeId: "777" })).body;
    assert.match(playText(play.report), /Quack Test before this play: 1 passed, 1 failed/);
    // each one off in the place's settings
    await post(port, "/api/automation", { placeId: "777", values: { tests: false, playTests: false } });
    assert.equal((await post(port, "/api/test", { feature: "edit", files: [pets] })).body.disabled, true);
    assert.equal((await post(port, "/api/test", { feature: "play", placeId: "777" })).body.disabled, true);
    assert.equal((await post(port, "/api/test", { root: "relative" })).status, 400);
  } finally {
    await hub.stop();
  }
  assert.equal(hub.tests.pool.size, 0, "the hub's stop leaves no Quack Test process");
});

test("the kept tree: two runs building it at once both pass, and a cut one is built again", async (t) => {
  if (!engine()) return t.skip("no Lune: node scripts/fetch-lune.mjs");
  const root = project({ "ReplicatedStorage/A.luau": "return 1" }, { "ASpec.luau": `return { one = function() require("@quack/test").expect(require(game:GetService("ReplicatedStorage").A)).toBe(1) end }` }, [
    { name: "ReplicatedStorage", className: "ReplicatedStorage", children: [module("A", "sync/ReplicatedStorage/A.luau")] },
  ]);
  const [a, b, c] = await Promise.all([executeTests({ root }), executeTests({ root }), executeTests({ root })]);
  for (const r of [a, b, c]) assert.equal(r.stats.passed, 1, r.error ?? r.rows[0]?.message);
  const source = await treeSource(root);
  assert.ok(!("error" in source));
  const cache = source.tree.cache!;
  assert.deepEqual(fs.readdirSync(path.dirname(cache)).filter((n) => n.endsWith(".tmp")), [], "no temporary file left behind");
  fs.writeFileSync(cache, "not a place");
  const again = await executeTests({ root });
  assert.equal(again.stats.passed, 1, again.error ?? again.rows[0]?.message);
  assert.ok(fs.statSync(cache).size > 100, "the cut tree was replaced");
  // a run keeps the tree and its index alive together (the prune drops what no run touched)
  const old = new Date(Date.now() - 30 * 86400_000);
  for (const f of [cache, `${cache}.index.json`]) fs.utimesSync(f, old, old);
  await executeTests({ root });
  for (const f of [cache, `${cache}.index.json`]) assert.ok(fs.statSync(f).mtimeMs > Date.now() - 60_000, `${path.basename(f)} touched`);
});

test("the pool remakes a ready process when the project's sourcemap changes, before the next run", async (t) => {
  if (!engine()) return t.skip("no Lune: node scripts/fetch-lune.mjs");
  const tree = (names: string[]): MapNode[] => [{ name: "ReplicatedStorage", className: "ReplicatedStorage", children: names.map((n) => module(n, `sync/ReplicatedStorage/${n}.luau`)) }];
  const root = project({ "ReplicatedStorage/A.luau": "return 1", "ReplicatedStorage/B.luau": "return 2" }, { "ASpec.luau": `return { one = function() require("@quack/test").expect(require(game:GetService("ReplicatedStorage").A)).toBe(1) end }` }, tree(["A"]));
  const pool = new StandbyPool({ refreshMs: 60_000 });
  try {
    assert.equal((await executeTests({ root, pool })).stats.warm, false);
    // Studio made a module: the sourcemap is written again
    fs.writeFileSync(path.join(root, "sourcemap.json"), JSON.stringify({ name: "Game", className: "DataModel", children: tree(["A", "B"]) }));
    await pool.refreshAll();
    const after = await executeTests({ root, pool });
    assert.equal(after.stats.warm, true, "the process the refresh made has the new tree ready");
    assert.equal(after.stats.passed, 1);
  } finally {
    pool.stop();
  }
});

test("the review hook waits a few seconds at most for the specs, and says they were still running", async () => {
  const file = path.join(project({ "ReplicatedStorage/A.luau": "return 1" }, {}), "sync", "ReplicatedStorage", "A.luau");
  const stdin = JSON.stringify({ tool_input: { file_path: file } });
  const t0 = Date.now();
  const out = JSON.parse(await reviewAnswer(stdin, { client: "claude", port: 1, ask: async () => ({ findings: [], elsewhere: [] }), askTests: () => new Promise(() => {}), testsWaitMs: 150 }));
  assert.ok(Date.now() - t0 < 2000);
  assert.match(out.hookSpecificOutput.additionalContext, /Quack Test was still running the specs this edit reaches/);
});

test("a run is limited by its silence, not its length: a long run with progress ends, a stuck load or an early exit fails fast", async (t) => {
  const real = engine();
  if (!real) return t.skip("no Lune: node scripts/fetch-lune.mjs");
  // five tests of 0.4 s each under a 1 s silence limit: every test's end is a sign of life
  const root = project({ "ReplicatedStorage/A.luau": "return 1" }, { "SlowSpec.luau": `local T = {}
for i = 1, 5 do T["slow " .. i] = function() task.wait(0.4) end end
return T` }, [{ name: "ReplicatedStorage", className: "ReplicatedStorage", children: [module("A", "sync/ReplicatedStorage/A.luau")] }]);
  const source = await treeSource(root);
  assert.ok(!("error" in source));
  // no cache folder: the tree's write fails, the run does not
  const tree = { ...source.tree, cache: path.join(root, "no", "such", "folder", "tree.rbxl") };
  const long = await new LuneProcess(real, tree).run({ root, specs: findSpecs(root), testTimeout: 5 }, 1000);
  assert.equal((long.specs as any[])[0].tests.length, 5);
  assert.ok((long.specs as any[])[0].tests.every((x: any) => x.ok), JSON.stringify(long));

  // an engine whose runtime never says it is ready (a load that hangs)
  const fake = (code: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quacktest-engine-"));
    fs.writeFileSync(path.join(dir, "main.luau"), code);
    return { lune: real.lune, main: path.join(dir, "main.luau"), dir };
  };
  const t0 = Date.now();
  const hung = new LuneProcess(fake(`require("@lune/task").wait(60)`), tree);
  await assert.rejects(hung.run({ root, specs: [] }, 800), /no progress for 1 s/);
  assert.ok(Date.now() - t0 < 5000, "the limit counts the load too");
  assert.ok(await gone(hung.pid!), "the stuck process is stopped");
  assert.equal(hung.exitedAlone, false, "stopped by the limit: never taken for a tree Lune could not read");

  // a runtime that says it is ready and exits before the request: the run fails at once
  const early = new LuneProcess(fake(`require("@lune/stdio").write("@@quacktest-ready@@ {}\\n")`), tree);
  await early.ready;
  const until = Date.now() + 5000;
  while (early.alive && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  const t1 = Date.now();
  await assert.rejects(early.run({ root, specs: [] }, 60_000), /Lune exited/);
  assert.ok(Date.now() - t1 < 1000, "not after the minute of silence");
  assert.equal(early.exitedAlone, true);

  // an answer past 64 MB is said as such, not lost in silence
  const huge = new LuneProcess(fake(`local stdio = require("@lune/stdio")
stdio.write("@@quacktest-ready@@ {}\\n")
stdio.readLine()
stdio.write('@@quacktest-result@@ {"crashed":"' .. string.rep("x", 65 * 1024 * 1024) .. '"}\\n')`), tree);
  await assert.rejects(huge.run({ root, specs: [] }, 60_000), /its answer was over 64 MB/);
});

test("a sourcemap cut mid-write or emptied: the sync folder's tree, and the run still passes", async (t) => {
  if (!engine()) return t.skip("no Lune: node scripts/fetch-lune.mjs");
  const root = project({ "ReplicatedStorage/A.luau": "return 1" }, { "ASpec.luau": `return { one = function() require("@quack/test").expect(require(game:GetService("ReplicatedStorage").A)).toBe(1) end }` });
  for (const text of ['{"name": "Game", "className": "DataModel", "children": [{"name": "Repl', ""]) {
    fs.writeFileSync(path.join(root, "sourcemap.json"), text);
    const report = await executeTests({ root });
    assert.equal(report.stats.passed, 1, report.error ?? report.rows[0]?.message);
    assert.match(report.stats.tree, /sync folder \(.*sourcemap\.json could not be read\)/);
  }
});

test("a sourcemap that looks whole but Lune cannot read, and a cache that cannot be written: the run still passes", async (t) => {
  if (!engine()) return t.skip("no Lune: node scripts/fetch-lune.mjs");
  const spec = { "ASpec.luau": `return { one = function() require("@quack/test").expect(require(game:GetService("ReplicatedStorage").A)).toBe(1) end }` };
  // cut right after an object: it ends in "}" and passes the quick check, then Lune refuses it
  const root = project({ "ReplicatedStorage/A.luau": "return 1" }, spec);
  fs.writeFileSync(path.join(root, "sourcemap.json"), '{"name": "Game", "className": "DataModel", "children": [{}');
  const cutPool = new StandbyPool({ refreshMs: 60_000 });
  try {
    const cut = await executeTests({ root, pool: cutPool });
    assert.equal(cut.stats.passed, 1, cut.error ?? cut.rows[0]?.message);
    assert.match(cut.stats.tree, /sync folder \(.*sourcemap\.json could not be read\)/);
    // the next ready process has the tree the run fell back to, so the next run is warm
    await cutPool.refreshAll();
    const next = await executeTests({ root, pool: cutPool });
    assert.equal(next.stats.passed, 1, next.error ?? next.rows[0]?.message);
    assert.equal(next.stats.warm, true);
  } finally {
    cutPool.stop();
  }

  // the cache is a path under a file: no folder can be made there
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "quacktest-blocked-")), "a-file");
  fs.writeFileSync(blocker, "");
  const saved = process.env.QUACK_TEST_CACHE;
  process.env.QUACK_TEST_CACHE = path.join(blocker, "cache");
  try {
    const withMap = project({ "ReplicatedStorage/A.luau": "return 1" }, spec, [{ name: "ReplicatedStorage", className: "ReplicatedStorage", children: [module("A", "sync/ReplicatedStorage/A.luau")] }]);
    const a = await executeTests({ root: withMap });
    assert.equal(a.stats.passed, 1, a.error ?? a.rows[0]?.message);
    const noMap = project({ "ReplicatedStorage/A.luau": "return 1" }, spec);
    const b = await executeTests({ root: noMap });
    assert.equal(b.stats.passed, 1, b.error ?? b.rows[0]?.message);
    // with no cache the tree's paths stay the same: the sourcemap's own version tells a rewrite
    const pool = new StandbyPool({ refreshMs: 60_000 });
    try {
      await executeTests({ root: withMap, pool });
      const kept = (pool as any).kept.values().next().value.proc;
      fs.writeFileSync(path.join(withMap, "sourcemap.json"), JSON.stringify({ name: "Game", className: "DataModel", children: [{ name: "ReplicatedStorage", className: "ReplicatedStorage", children: [module("A", "sync/ReplicatedStorage/A.luau"), module("B", "sync/ReplicatedStorage/B.luau")] }] }));
      await pool.refreshAll();
      assert.notEqual((pool as any).kept.values().next().value.proc, kept, "the rewritten sourcemap made a new ready process");
    } finally {
      pool.stop();
    }
  } finally {
    process.env.QUACK_TEST_CACHE = saved;
  }
});

test("the runtime's answer as one long line, in many pieces, is read whole and fast", async (t) => {
  const real = engine();
  if (!real) return t.skip("no Lune: node scripts/fetch-lune.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quacktest-engine-"));
  fs.writeFileSync(path.join(dir, "main.luau"), `local stdio = require("@lune/stdio")
stdio.write("@@quacktest-ready@@ {}\\n")
stdio.readLine()
stdio.write('@@quacktest-result@@ {"specs":[],"ms":1,"crashed":"' .. string.rep("x", 4000000) .. '"}\\n')`);
  const root = project({ "ReplicatedStorage/A.luau": "return 1" }, {});
  const source = await treeSource(root);
  assert.ok(!("error" in source));
  const t0 = Date.now();
  const raw = await new LuneProcess({ lune: real.lune, main: path.join(dir, "main.luau"), dir }, source.tree).run({ root, specs: [] }, 30_000);
  assert.equal(raw.crashed?.length, 4_000_000);
  assert.ok(Date.now() - t0 < 5000);
});

test("what setup.luau requires reaches every spec; a failing setup.luau is not counted as a spec", async (t) => {
  const root = project(
    { "ReplicatedStorage/Seed.luau": "return 1", "ReplicatedStorage/Other.luau": "return 2" },
    {
      "setup.luau": `require(game:GetService("ReplicatedStorage").Seed)\nreturn nil`,
      "ASpec.luau": `return { a = function() require(game:GetService("ReplicatedStorage").Other) end }`,
      "BSpec.luau": "return { b = function() end }",
    },
    [{ name: "ReplicatedStorage", className: "ReplicatedStorage", children: [module("Seed", "sync/ReplicatedStorage/Seed.luau"), module("Other", "sync/ReplicatedStorage/Other.luau")] }],
  );
  assert.deepEqual((await reachingSpecs(root, [path.join(root, "sync", "ReplicatedStorage", "Seed.luau")])).map((s) => s.name), ["ASpec", "BSpec"]);
  assert.deepEqual((await reachingSpecs(root, [path.join(root, "sync", "ReplicatedStorage", "Other.luau")])).map((s) => s.name), ["ASpec"]);
  if (!engine()) return t.skip("no Lune: node scripts/fetch-lune.mjs");
  fs.writeFileSync(path.join(root, "tests", "setup.luau"), "error('setup broke')");
  const report = await executeTests({ root });
  assert.deepEqual(report.rows.map((r) => [r.spec, r.test, r.status]), [["tests/setup.luau", null, "failed"]]);
  assert.equal(report.stats.specs, 0);
  assert.match(reportText(report), /setup\.luau did not load: .*setup broke[\s\S]*0 passed, 1 failed, 0 did not run outside Studio: 1 test in 0 specs/);
});

test("quack test refuses a timeout of 0, and a hub's error is said instead of running a second time", async () => {
  const root = project({ "ReplicatedStorage/A.luau": "return 1" }, { "ASpec.luau": "return { a = function() end }" });
  const lines: string[] = [];
  assert.equal(await runTestCommand({ cwd: root, files: [], testTimeout: 0, json: false, verbose: false, out: (l) => lines.push(l) }), 1);
  assert.match(lines.join("\n"), /--timeout is each test's limit in seconds: above 0/);
  lines.length = 0;
  const code = await runTestCommand({ cwd: root, files: [], json: false, verbose: false, out: (l) => lines.push(l), hub: async () => { throw new Error("the hub took more than 900 s to answer /api/test"); } });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /Quack Test could not run: the hub could not run it: the hub took more than 900 s/);
  assert.doesNotMatch(lines.join("\n"), /passed/, "nothing ran here");
});

/** Whether a process is gone within a few seconds */
async function gone(pid: number): Promise<boolean> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
