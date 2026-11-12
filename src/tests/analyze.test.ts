import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { analyzeProject, exportedKeys, type ParseCache } from "../analyze/analyze.js";
import { projectRoot, runAnalyze, type LivePlay } from "../analyze/command.js";
import { parseLuau } from "../analyze/luau/parser.js";
import { ANALYTICS_OPS } from "../cloud/analytics.js";
import { buttonsCode, errorPlace, installCode, nodeForPath, probeErrorLine, probeErrors, readCode, removeCode, requireCode, signature, type CollectedError } from "../analyze/probe.js";
import { fileKey, loadTree, treeFromSourcemap } from "../analyze/tree.js";
import { sourcemapFromProject, treeFromProject } from "../analyze/project.js";
import { ROBLOX_MEMBERS } from "../analyze/robloxMembers.js";

// The bugs these come from are real ones of Anime Astral (the council's set C, 10/11/26): a
// handler kept calling PrimordialsConfig:GetBoosts after the config renamed it to
// GetBoostsForDemon, and the Primordial boost silently stopped (MultiplierService's pcall ate the
// error). Over the whole game as it is today the analyzer must stay at zero.

type Files = Record<string, string>;

function project(files: Files, sourcemap?: object): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-analyze-"));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, "sync", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  if (sourcemap) fs.writeFileSync(path.join(root, "sourcemap.json"), JSON.stringify(sourcemap));
  return root;
}

/**
 * Every case also runs twice through one parse cache and a tree loaded once (the hub's resident
 * analysis): a kept parse must give what a fresh read gives, so nothing a run fills leaks into it
 */
const run = (root: string, files?: string[]) => {
  const fresh = analyzeProject(root, { files });
  const cache: ParseCache = new Map();
  const loadedTree = loadTree(root, path.join(root, "sync"), path.join(root, "sourcemap.json"));
  const plain = (r: ReturnType<typeof analyzeProject>) => ({ ...r, stats: { ...r.stats, ms: 0 } });
  for (let i = 0; i < 2; i++) assert.deepEqual(plain(analyzeProject(root, { files, cache, loadedTree })), plain(fresh), `run ${i + 1} through the cache`);
  return fresh;
};
const brief = (root: string, files?: string[]) => run(root, files).findings.map((f) => `${path.relative(path.join(root, "sync"), f.file).replace(/\\/g, "/")}:${f.line} ${f.rule} ${f.message}`);

const LIBRARY = `local Library = {}
Library.Config = script:WaitForChild("Config")
function Library.getConfig(name: string): any
	return require(Library.Config:FindFirstChild(name))
end
return Library
`;

const CONFIG = `local PrimordialsConfig = {
	Demons = {},
	["Spaced Key"] = 1,
}

function PrimordialsConfig:GetBoostsForDemon(demonKey: string?, activated: boolean?)
	return {}
end

PrimordialsConfig.Version   = 2

export type Demon = { Key: string }

return PrimordialsConfig
`;

/** Two more configs loaded somewhere: a loader method counts as one from three modules on */
const MORE_CONFIGS: Record<string, string> = {
  "ReplicatedStorage/Library/Config/A.luau": "local A = {}\nreturn A\n",
  "ReplicatedStorage/Library/Config/B.luau": "local B = {}\nreturn B\n",
  "ServerScriptService/Uses.luau": `local Library = require(game:GetService("ReplicatedStorage").Library)\nlocal A = Library.getConfig("A")\nlocal B = Library.getConfig("B")\nreturn {}\n`,
};

test("analyze: a member the module no longer has is reported on its line; the ones it has are not", () => {
  const root = project({
    "ReplicatedStorage/Library.luau": LIBRARY,
    "ReplicatedStorage/Library/Config/PrimordialsConfig.luau": CONFIG,
    ...MORE_CONFIGS,
    "ServerScriptService/Handler.luau": `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Library = require(ReplicatedStorage.Library)
local PrimordialsConfig: any = Library.getConfig("PrimordialsConfig")

local Handler = {}
function Handler.Handle(data, activated)
	local ok = PrimordialsConfig:GetBoostsForDemon(data.Key, activated)
	local d: PrimordialsConfig.Demon = PrimordialsConfig.Demons[1]
	local v = PrimordialsConfig.Version + PrimordialsConfig["Spaced Key"]
	print("PrimordialsConfig.Missing in a string is not a use") -- nor PrimordialsConfig.InAComment
	return PrimordialsConfig:GetBoosts(data.Rarity, activated)
end
return Handler
`,
  });
  assert.deepEqual(brief(root), [`ServerScriptService/Handler.luau:11 missing-member PrimordialsConfig:GetBoosts: PrimordialsConfig (PrimordialsConfig.luau) has no "GetBoosts"`]);
  const f = run(root).findings[0];
  assert.equal(f.column, 9, "the column of the use");
});

test("analyze: a loader method that does not return modules (getBridge) binds nothing, even when a module shares the name", () => {
  const root = project({
    "ReplicatedStorage/Library.luau": LIBRARY.replace("return Library", `function Library.getBridge(name) return {} end\nreturn Library`),
    "ReplicatedStorage/Library/Config/Hit.luau": "local Hit = {}\nreturn Hit\n",
    "ReplicatedStorage/Library/Config/Other.luau": "local Other = {}\nreturn Other\n",
    ...MORE_CONFIGS,
    "ServerScriptService/A.luau": `local Library = require(game:GetService("ReplicatedStorage").Library)
local Hit = Library.getBridge("Hit")
local Shot = Library.getBridge("Shot")
local Swing = Library.getBridge("Swing")
Hit:Fire(1)
return {}
`,
    "ServerScriptService/B.luau": `local Library = require(game:GetService("ReplicatedStorage").Library)
local Other = Library.getConfig("Other")
local Hit = Library.getConfig("Hit")
return Other.Missing
`,
  });
  assert.deepEqual(brief(root), [`ServerScriptService/B.luau:4 missing-member Other.Missing: Other (Other.luau) has no "Missing"`]);
});

test("analyze: a loader method called with a name its folder lacks is reported, with the near name; any instance by that name keeps it quiet", () => {
  const root = project({
    "ReplicatedStorage/Library.luau": LIBRARY,
    "ReplicatedStorage/Library/Config/PrimordialsConfig.luau": CONFIG,
    ...MORE_CONFIGS,
    // the method stays a loader while nine of ten calls name a module
    "ServerScriptService/Many.luau": `local Library = require(game:GetService("ReplicatedStorage").Library)\n${Array.from({ length: 40 }, (_, i) => `local x${i} = Library.getConfig("${"AB"[i % 2]}")`).join("\n")}\nreturn {}\n`,
    "ServerScriptService/Handler.luau": `local Library = require(game:GetService("ReplicatedStorage").Library)
local P = Library.getConfig("PrimordialsConfig")
local typo = Library.getConfig("PrimordalsConfig")
local inline = Library.getConfig("Gone").Demons
local folder = Library.getConfig("Config")
-- quack: allow(missing-module)
local allowed = Library.getConfig("Allowed")
return {}
`,
  });
  assert.deepEqual(brief(root, ["sync/ServerScriptService/Handler.luau"]), [
    `ServerScriptService/Handler.luau:3 missing-module Library.getConfig("PrimordalsConfig"): ReplicatedStorage.Library.Config has no module "PrimordalsConfig" (did you mean "PrimordialsConfig"?)`,
    `ServerScriptService/Handler.luau:4 missing-module Library.getConfig("Gone"): ReplicatedStorage.Library.Config has no module "Gone"`,
  ]);
});

test("analyze: a loader needs three different modules, not three calls naming one", () => {
  const root = project({
    "ReplicatedStorage/Library.luau": LIBRARY.replace("return Library", `function Library.getBridge(name) return {} end\nreturn Library`),
    "ReplicatedStorage/Library/Config/Hit.luau": "local Hit = {}\nreturn Hit\n",
    "ServerScriptService/A.server.luau": `local Library = require(game:GetService("ReplicatedStorage").Library)\nlocal Hit = Library.getBridge("Hit")\nHit:Fire()\n`,
    "ServerScriptService/B.server.luau": `local Library = require(game:GetService("ReplicatedStorage").Library)\nlocal Hit = Library.getBridge("Hit")\nHit:Fire()\n`,
    "ServerScriptService/C.server.luau": `local Library = require(game:GetService("ReplicatedStorage").Library)\nlocal Hit = Library.getBridge("Hit")\nHit:Fire()\n`,
  });
  assert.deepEqual(brief(root), []);
});

// The council's review of this code (10/11/26), one case per finding it raised that was real
test("analyze: interpolations, reassignment, a lone loader call, constructor bodies and computed keys, a far check, a folder", async () => {
  const root = project({
    "ReplicatedStorage/Library.luau": LIBRARY.replace("return Library", `function Library.getBridge(name) return {} end\nreturn Library`),
    "ReplicatedStorage/Library/Config/Hit.luau": "local Hit = {}\nreturn Hit\n",
    "ServerScriptService/M.luau": `local M = {
	Field = 1,
	Make = function()
		local inner = 1
		hidden = 2
		if inner then inner = 3 end
	end,
	After = true,
}
return M
`,
    "ServerScriptService/Computed.luau": `local key = "Dynamic"\nlocal C = { [key] = true, ["Fixed Key"] = 1 }\nreturn C\n`,
    "ServerScriptService/Use.server.luau": `local M = require(script.Parent.M)
local C = require(script.Parent.Computed)
local Library = require(game:GetService("ReplicatedStorage").Library)
local Hit = Library.getBridge("Hit")
Hit:Fire(1)
print(\`value {M.Gone()} and {M.Field} {"{M.NotCode}"}\`)
local d = C.Dynamic
local x = M.After and M.Make
local y = M.hidden
if M.Checked then M.Checked() end
`,
    "ServerScriptService/Far.server.luau": `local M = require(script.Parent.M)
local function a()
	if M.Optional then return end
end
${"\n".repeat(20)}
return M.Optional()
`,
    "ServerScriptService/Swap.server.luau": `local M = require(script.Parent.M)\nM = { Other = 1 }\nreturn M.Other\n`,
  });
  assert.deepEqual(brief(root), [
    `ServerScriptService/Far.server.luau:26 missing-member M.Optional: M (M.luau) has no "Optional"`,
    `ServerScriptService/Use.server.luau:6 missing-member M.Gone: M (M.luau) has no "Gone"`,
    `ServerScriptService/Use.server.luau:9 missing-member M.hidden: M (M.luau) has no "hidden"`,
  ]);
  // a folder stands for its scripts
  const out: string[] = [];
  assert.equal(await runAnalyze({ cwd: root, files: ["sync/ServerScriptService"], json: true, out: (l) => out.push(l) }), 1);
  assert.equal(JSON.parse(out.join("\n")).findings.length, 3);
  fs.mkdirSync(path.join(root, "sync/Empty"));
  const empty: string[] = [];
  assert.equal(await runAnalyze({ cwd: root, files: ["sync/Empty"], json: false, out: (l) => empty.push(l) }), 1);
  assert.match(empty[0], /^No scripts in /);
});

// Read from the syntax tree with scopes (11/11/26): what the regexes could not tell apart
test("analyze: scopes tell a module from a parameter or an inner local with its name; self, brackets, a late require, a test that covers the rest of the function", () => {
  const root = project({
    "ServerScriptService/M.luau": `local M = { Field = 1 }
function M:Init()
	self.FromInit = true
end
return M
`,
    "ServerScriptService/Use.server.luau": `local M = require(script.Parent.M)
local function handle(M)
	return M.AnyField
end
do
	local M = { Own = 1 }
	print(M.Own, M.Other)
end
local late
late = require(script.Parent.M)
print(M.FromInit, M["Field"], M["Bracket Gone"], late.LateGone)
M.Field += 1
M.Count += 1
if M["Bracketed"] then M["Bracketed"]() end
M.Allowed() -- quack: allow(missing-member)
local function run()
	if not M.Optional then
		return
	end
${"\n".repeat(30)}
	M.Optional()
end
for M = 1, 3 do print(M) end
return handle, run
`,
  });
  assert.deepEqual(brief(root), [
    `ServerScriptService/Use.server.luau:11 missing-member M["Bracket Gone"]: M (M.luau) has no "Bracket Gone"`,
    `ServerScriptService/Use.server.luau:11 missing-member late.LateGone: M (M.luau) has no "LateGone"`,
    `ServerScriptService/Use.server.luau:13 missing-member M.Count: M (M.luau) has no "Count"`,
  ]);
});

test("analyze: a module written with a computed key from another file, or one that does not parse, is never checked; its strings still count", () => {
  const root = project({
    "ServerScriptService/Registry.luau": "local Registry = { A = 1 }\nreturn Registry\n",
    "ServerScriptService/Fill.server.luau": `local Registry = require(script.Parent.Registry)\nfor _, name in { "B", "C" } do Registry[name] = true end\n`,
    "ServerScriptService/Broken.luau": `local Broken = { A = 1 }\nlocal s = "MadeInBroken"\nif then\nreturn Broken\n`,
    "ServerScriptService/Use.server.luau": `local Registry = require(script.Parent.Registry)\nlocal Broken = require(script.Parent.Broken)\nprint(Registry.B, Broken.Gone)\n`,
  });
  assert.deepEqual(brief(root).map((l) => l.replace(/ Expected.*/, "")), ["ServerScriptService/Broken.luau:3 parse-error"]);
  const r = run(root);
  assert.deepEqual(r.opaque.map((o) => [path.basename(o.file), o.why]).sort(), [
    ["Broken.luau", "does not parse"],
    ["Registry.luau", "written with a computed key in Fill.server.luau"],
  ]);
});

// Slice 2 (his call, 10/11/26): a running play tells the keys of a module the text cannot read
test("analyze: a running play gives the keys of a module the text cannot read, only for modules the server requires; no play, text only", async () => {
  const root = project({
    "ReplicatedStorage/Wrapped.luau": `local W = {}\nsetmetatable(W, { __index = require(script.Parent.Base) })\ngame:GetService("RunService").Heartbeat:Connect(function() end)\nlocal helper = {}\nhelper.Gone = true\nW.Removed = nil\nfunction W:Start() self.Later = 1 end\nreturn W\n`,
    "ReplicatedStorage/Registry.luau": `local R = {}\nfunction R.add(name) R[name] = true end\nreturn R\n`,
    "ReplicatedStorage/RegistryWrap.luau": `return require(script.Parent.Registry)\n`,
    "ReplicatedStorage/LockedBase.luau": `return setmetatable({}, { __metatable = {} })\n`,
    "ReplicatedStorage/OnLocked.luau": `local O = {}\nsetmetatable(O, { __index = require(script.Parent.LockedBase) })\nreturn O\n`,
    "ReplicatedStorage/Queued.luau": `local Q = {}\nsetmetatable(Q, {})\ngame:GetService("RunService").Heartbeat:Connect(function() end)\nreturn Q\n`,
    "ServerScriptService/Blocked.server.luau": `local RS = game:GetService("ReplicatedStorage")\nRS:WaitForChild("Missing")\nlocal Q = require(RS.Queued)\nQ.Anything()\n`,
    "ReplicatedStorage/Lazy.luau": `local L = {}\nsetmetatable(L, {})\ngame:GetService("RunService").Heartbeat:Connect(function() end)\nreturn L\n`,
    "ReplicatedStorage/Stored.luau": `local S = {}\nsetmetatable(S, {})\ngame:GetService("RunService").Heartbeat:Connect(function() end)\nreturn S\n`,
    "ServerScriptService/Later.server.luau": `local function load()\n\tlocal L = require(game:GetService("ReplicatedStorage").Lazy)\n\treturn L.Anything\nend\nreturn load\n`,
    "ServerStorage/Kept.server.luau": `local S = require(game:GetService("ReplicatedStorage").Stored)\nS.Anything()\n`,
    "ReplicatedStorage/Base.luau": `return setmetatable({}, {})\n`,
    "ReplicatedStorage/ClientOnly.luau": `local C = {}\nsetmetatable(C, {})\ngame:GetService("RunService").Heartbeat:Connect(function() end)\nreturn C\n`,
    "ReplicatedStorage/LateMod.luau": `local X = {}\nsetmetatable(X, {})\ngame:GetService("RunService").Heartbeat:Connect(function() end)\nreturn X\n`,
    "ServerScriptService/Late.server.luau": `local X\nlocal function load()\n\tX = require(game:GetService("ReplicatedStorage").LateMod)\nend\nreturn load\n`,
    "ReplicatedStorage/Locked.luau": `local K = {}\nsetmetatable(K, { __metatable = "locked" })\nreturn K\n`,
    "ReplicatedStorage/Swapped.luau": `local V = {}\nV.Gone = true\nV = setmetatable({}, {})\nreturn V\n`,
    "ServerScriptService/Main.server.luau": `local RS = game:GetService("ReplicatedStorage")
local W = require(RS.Wrapped)
local V = require(RS.Swapped)
local K = require(RS.Locked)
local G = require(RS.RegistryWrap)
local O = require(RS.OnLocked)
W.Real()
W.Gone()
W.Later()
V.Gone()
K.Anything()
W.Removed()
G.Anything()
O.Anything()
`,
    "ReplicatedStorage/Data.luau": `local D = {}\nsetmetatable(D, {})\nreturn D\n`,
    "ReplicatedStorage/Util.luau": `local Util = {}\nfunction Util.Extend(t)\n\tt.Added = function() end\nend\nreturn Util\n`,
    "ReplicatedStorage/Ext.luau": `local Util = require(script.Parent.Util)\nlocal E = { A = 1 }\nUtil.Extend(E)\nreturn E\n`,
    // each of these changes the game when required: only a proof the game loaded it would send it
    "ReplicatedStorage/Inst.luau": `local T = {}\nsetmetatable(T, {})\nlocal f = game:GetService("ReplicatedStorage")\nf.Name = "X"\nreturn T\n`,
    "ReplicatedStorage/Calls.luau": `local Registry = require(script.Parent.Registry)\nlocal T = {}\nsetmetatable(T, {})\nRegistry.add("x")\nreturn T\n`,
    "ReplicatedStorage/Meth.luau": `local W = require(script.Parent.Wrapped)\nlocal T = {}\nsetmetatable(T, {})\nW:Start()\nreturn T\n`,
    "ReplicatedStorage/Glob.luau": `local T = {}\nsetmetatable(T, {})\nShared = 1\nreturn T\n`,
    // f and g call each other and f writes a global: g is impure too, whichever is checked first
    "ReplicatedStorage/Cycle.luau": `local U = {}\nfunction U.f()\n\tU.g()\n\tShared = 1\nend\nfunction U.g()\n\tU.f()\nend\nfunction U.h()\n\tU.f()\nend\nreturn U\n`,
    "ReplicatedStorage/CycA.luau": `local U = require(script.Parent.Cycle)\nlocal T = {}\nsetmetatable(T, {})\nU.h()\nreturn T\n`,
    "ReplicatedStorage/CycC.luau": `local U = require(script.Parent.Cycle)\nlocal T = {}\nsetmetatable(T, {})\nU.g()\nreturn T\n`,
    // these change nothing but may never return: a hanging require, or a frozen server
    "ReplicatedStorage/Waits.luau": `local T = {}\nsetmetatable(T, {})\nT.Part = script:WaitForChild("Nope")\nreturn T\n`,
    "ReplicatedStorage/Loops.luau": `local T = {}\nsetmetatable(T, {})\nlocal n = 0\nwhile n < 3 do\n\tn += 1\nend\nreturn T\n`,
    // the review's case: a module that requires one whose for calls a function that never returns nil
    "ReplicatedStorage/Spins.luau": `for _ in function() return 1 end do end\nreturn {}\n`,
    "ReplicatedStorage/SpinsWrap.luau": `local T = {}\nsetmetatable(T, { __index = require(script.Parent.Spins) })\nreturn T\n`,
    "ReplicatedStorage/Counts.luau": `local T = { Items = { 1, 2 } }\nsetmetatable(T, {})\nlocal n = 0\nfor _, v in ipairs(T.Items) do\n\tn += v\nend\nfor _ in next, T do end\nreturn T\n`,
    "ReplicatedStorage/WaitsIn.luau": `local T = {}\nsetmetatable(T, {})\nlocal function find()\n\treturn script:WaitForChild("Nope")\nend\nT.Part = find()\nreturn T\n`,
    "StarterPlayer/StarterPlayerScripts/Ui.client.luau": `local RS = game:GetService("ReplicatedStorage")
local Inst, Calls, Meth, Glob = require(RS.Inst), require(RS.Calls), require(RS.Meth), require(RS.Glob)\nlocal CycA, CycC = require(RS.CycA), require(RS.CycC)\nlocal Waits, Loops, WaitsIn = require(RS.Waits), require(RS.Loops), require(RS.WaitsIn)\nlocal SpinsWrap, Counts = require(RS.SpinsWrap), require(RS.Counts)
local C = require(RS.ClientOnly)
C.Anything()
local D = require(RS.Data)
D.Gone()
local E = require(RS.Ext)
E.Real()
`,
  });
  const sent: string[] = [];
  let playing = false;
  const live: LivePlay = {
    places: async () => [{ folder: root, name: "Test (1)", id: "1" }],
    playing: async () => playing,
    evalServer: async (_id, code) => {
      sent.push(code);
      assert.doesNotThrow(() => parseLuau(code), "the Luau sent parses");
      // one answer per module sent
      const modules = JSON.parse(/JSONDecode\(\[(=*)\[([\s\S]*?)\]\1\]\)/.exec(code)![2]);
      return { ok: true, values: [JSON.stringify(modules.map(() => ({ keys: ["Real", "Other"] })))] };
    },
  };
  const analyze = async () => {
    const out: string[] = [];
    await runAnalyze({ cwd: root, files: [], json: true, out: (l) => out.push(l), live });
    return JSON.parse(out.join("\n"));
  };
  const quiet = await analyze();
  assert.deepEqual(quiet.findings, [], "no play: the module stays unread");
  assert.equal(quiet.stats.live.note, "no play running in Test (1): keys from the text only");
  assert.equal(sent.length, 0);

  playing = true;
  const report = await analyze();
  assert.deepEqual(report.findings.map((f: any) => [path.basename(f.file), f.line, f.rule]), [
    ["Main.server.luau", 8, "missing-member"],
    ["Main.server.luau", 10, "missing-member"],
    ["Main.server.luau", 12, "missing-member"],
    ["Ui.client.luau", 9, "missing-member"],
  ], "W.Gone (helper.Gone is another table), V.Gone (written on the table V no longer holds), W.Removed (set to nil)");
  assert.equal(report.stats.live.modules, 4, "Wrapped and Swapped proven loaded, Data and Ext safe to require (Counts is read but never used)");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /"ReplicatedStorage","Wrapped"/);
  assert.match(sent[0], /\[\["ServerScriptService","Main"\]\]/, "the root Script the play checks before requiring");
  assert.doesNotMatch(sent[0], /LateMod/, "a local required later, inside a function, may never have loaded");
  assert.doesNotMatch(sent[0], /Locked/, "a __metatable hides the real metatable from the play, also one a required base sets");
  assert.doesNotMatch(sent[0], /Registry/, "a module returning one filled on demand");
  assert.doesNotMatch(sent[0], /Queued/, "a require after a WaitForChild that may never return");
  assert.doesNotMatch(sent[0], /ClientOnly/, "a module only the client requires, that connects an event when loaded, is never required on the server");
  // a module whose top level only builds and reads goes with no root: requiring it changes nothing
  assert.match(sent[0], /\[\["ReplicatedStorage","Data"\],\[\]\]/);
  assert.match(sent[0], /\[\["ReplicatedStorage","Ext"\],\[\]\]/, "an Extend that writes only the table it is given is pure");
  assert.match(sent[0], /\[\["ReplicatedStorage","Counts"\],\[\]\]/, "ipairs and next end");
  for (const name of ["Inst", "Calls", "Meth", "Glob", "CycA", "CycC", "Waits", "Loops", "WaitsIn", "SpinsWrap"]) assert.doesNotMatch(sent[0], new RegExp(`"${name}"`), `${name} changes the game or may not return when required`);
  assert.doesNotMatch(sent[0], /Lazy/, "a require inside a function may never have run");
  assert.doesNotMatch(sent[0], /Stored/, "a Script in ServerStorage never runs");
  assert.ok(!report.opaque.some((o: any) => o.file.endsWith("Wrapped.luau")));

  // the play answers it cannot read the module: text only, nothing reported
  live.evalServer = async (_id, code) => ({ ok: true, values: [JSON.stringify(JSON.parse(/JSONDecode\(\[(=*)\[([\s\S]*?)\]\1\]\)/.exec(code)![2]).map(() => ({ why: "__index is a function" })))] });
  assert.deepEqual((await analyze()).findings, []);
  live.evalServer = async () => ({ ok: false, error: "Luau error\nstack" });
  assert.equal((await analyze()).stats.live.note, "the play's server could not read them: Luau error");
});

test("analyze: a lookup by brackets is reported as written, and does not count as a name made at run time", () => {
  const files = { "ReplicatedStorage/Client.client.luau": `local r = game:GetService("ReplicatedStorage")["Absent"]\nlocal t = { ["Made"] = 1 }\n` };
  const root = project(files, node("Game", "DataModel", [
    node("ReplicatedStorage", "ReplicatedStorage", [node("Client", "LocalScript", [], ["sync/ReplicatedStorage/Client.client.luau"])]),
  ]));
  assert.deepEqual(brief(root), [`ReplicatedStorage/Client.client.luau:1 missing-child ReplicatedStorage has no child "Absent": ["Absent"] errors`]);
});

test("analyze: require by a relative path reaches the module, and a checked or written member is not reported", () => {
  const root = project({
    "ServerScriptService/Services/PrimordialsService.luau": `local PrimordialsService = {}
function PrimordialsService:ResolveDisplayDemonKey(data) return nil end
return PrimordialsService
`,
    "ServerScriptService/Services/Other.luau": `local PrimordialsService = require(script.Parent.PrimordialsService)
PrimordialsService.SetLater = function() end
return {}
`,
    "ServerScriptService/Services/Follow.luau": `local PrimordialsService = require(script.Parent:WaitForChild("PrimordialsService"))
local Follow = {}
function Follow.Run(data)
	if type(PrimordialsService.Optional) == "function" then PrimordialsService:Optional() end
	PrimordialsService.SetLater()
	return PrimordialsService:ResolveDisplayRarity(data)
end
return Follow
`,
  });
  assert.deepEqual(brief(root), [`ServerScriptService/Services/Follow.luau:6 missing-member PrimordialsService:ResolveDisplayRarity: PrimordialsService (PrimordialsService.luau) has no "ResolveDisplayRarity"`]);
  assert.deepEqual(brief(root, [path.join(root, "sync/ServerScriptService/Services/Other.luau")]), [], "files: only those are reported");
});

test("analyze: a module whose keys its text cannot tell is never checked", () => {
  const cases: Record<string, string> = {
    extended: `local C = { Paths = {} }\nEngine.Extend(C)\nreturn C`,
    metatable: `local C = {}\nsetmetatable(C, { __index = Base })\nreturn C`,
    loop: `local C = {}\nfor k, v in pairs(Other) do C[k] = v end\nreturn C`,
    wrapped: `return require(script.Parent._Index["pkg"])`,
    literal: `return { A = 1 }`,
    notATable: `local C = Base.new()\nreturn C`,
  };
  for (const [name, src] of Object.entries(cases)) {
    assert.equal(exportedKeys(src).open, true, name);
  }
  const k = exportedKeys(`local C = {\n\tA = 1,\n\tNested = { B = 2 },\n}\nfunction C.F() end\nfunction C:M() end\nC.G = 1\nC["H"] = 2\ntable.freeze(C)\nreturn C`);
  assert.equal(k.open, false);
  assert.deepEqual([...k.keys].sort(), ["A", "F", "G", "H", "M", "Nested"]);
});

const node = (name: string, className: string, children: object[] = [], filePaths?: string[]) => ({ name, className, children, ...(filePaths ? { filePaths } : {}) });

test("analyze: a lookup of a child the tree lacks is reported; members, made names, timeouts and FindFirstChild are not", () => {
  const files = {
    "ReplicatedStorage/Client.client.luau": `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local hit = Remotes:WaitForChild("Hit")
local typo = Remotes:WaitForChild("Hti")
Remotes.Hit.OnClientEvent:Connect(print)
Remotes.ChildAdded:Connect(print)
local made = ReplicatedStorage:WaitForChild("MadeAtRunTime")
local maybe = ReplicatedStorage:WaitForChild("Optional", 5)
local found = ReplicatedStorage:FindFirstChild("Nope")
local gone = ReplicatedStorage.Remotes.Deleted
local moved = ReplicatedStorage:WaitForChild("Elsewhere")
`,
    "ServerScriptService/Make.server.luau": `local f = Instance.new("Folder")\nf.Name = "MadeAtRunTime"\n`,
  };
  const root = project(files, node("Game", "DataModel", [
    node("ReplicatedStorage", "ReplicatedStorage", [
      node("Remotes", "Folder", [node("Hit", "RemoteEvent")]),
      node("Client", "LocalScript", [], ["sync/ReplicatedStorage/Client.client.luau"]),
    ]),
    node("ServerScriptService", "ServerScriptService", [node("Make", "Script", [node("Elsewhere", "Folder")], ["sync/ServerScriptService/Make.server.luau"])]),
  ]));
  assert.deepEqual(brief(root), [
    `ReplicatedStorage/Client.client.luau:4 missing-child ReplicatedStorage.Remotes has no child "Hti": WaitForChild("Hti") waits forever`,
    `ReplicatedStorage/Client.client.luau:10 missing-child ReplicatedStorage.Remotes has no child "Deleted": .Deleted errors`,
  ]);
  // Without a sourcemap the tree is only scripts: no path can be called missing
  fs.rmSync(path.join(root, "sourcemap.json"));
  assert.deepEqual(brief(root), []);
  assert.equal(run(root).stats.tree, "sync folder");
});

test("analyze: a member its class lacks is reported, on a path, a method call or a property set; inherited members, children, same-named siblings and unknown classes are not", () => {
  const files = {
    "ReplicatedFirst/Client.client.luau": `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Remotes = ReplicatedStorage:WaitForChild("Remotes")
Remotes.Ask:FireServer(1)
local ask = Remotes.Ask
ask:FireServer(2)
ask:InvokeServer(3)
Remotes.Hit:FireServer(4)
Remotes.Hit.OnClientEvent:Connect(print)
local gui = script.Parent:WaitForChild("Gui")
gui.Main.Image = "rbxassetid://1"
local img = gui.Main.Image
gui.Icon.Image = "rbxassetid://1"
gui.Main.BackgroundColor3 = Color3.new()
gui.Main.Inner.Visible = false
workspace.Door.Anchord = true
workspace.Door.Anchored = true
local pivot = workspace.Door:GetPivot()
workspace.Door:Destroy()
workspace.Twin:FireServer()
workspace.Odd:Whatever()
gui.Main["Image"] = "x"
-- quack: allow(invalid-member)
Remotes.Ask:FireServer(5)
`,
    "ServerStorage/Template.client.luau": `script.Parent.ImageRectSize = Vector2.new()\nlocal f = script.Parent.IsLoaded\n`,
  };
  const root = project(files, node("Game", "DataModel", [
    node("ReplicatedStorage", "ReplicatedStorage", [node("Remotes", "Folder", [node("Ask", "RemoteFunction"), node("Hit", "RemoteEvent")])]),
    node("ReplicatedFirst", "ReplicatedFirst", [
      node("Client", "LocalScript", [], ["sync/ReplicatedFirst/Client.client.luau"]),
      node("Gui", "ScreenGui", [node("Main", "Frame", [node("Inner", "Frame")]), node("Icon", "ImageLabel")]),
    ]),
    node("ServerStorage", "ServerStorage", [node("Template", "LocalScript", [], ["sync/ServerStorage/Template.client.luau"])]),
    node("Workspace", "Workspace", [node("Door", "Part"), node("Twin", "Part"), node("Twin", "RemoteEvent"), node("Odd", "SomeFutureClass")]),
  ]));
  assert.deepEqual(brief(root).filter((f) => f.includes(" invalid-member ")), [
    `ReplicatedFirst/Client.client.luau:3 invalid-member ReplicatedStorage.Remotes.Ask is a RemoteFunction: it has no method "FireServer"`,
    `ReplicatedFirst/Client.client.luau:5 invalid-member ReplicatedStorage.Remotes.Ask is a RemoteFunction: it has no method "FireServer"`,
    `ReplicatedFirst/Client.client.luau:10 invalid-member ReplicatedFirst.Gui.Main is a Frame: it has no property "Image" to set`,
    `ReplicatedFirst/Client.client.luau:11 invalid-member ReplicatedFirst.Gui.Main is a Frame: it has no member or child "Image"`,
    `ReplicatedFirst/Client.client.luau:15 invalid-member Workspace.Door is a Part: it has no property "Anchord" to set`,
    `ReplicatedFirst/Client.client.luau:21 invalid-member ReplicatedFirst.Gui.Main is a Frame: it has no property "Image" to set`,
  ]);
});

test("analyze: a remote of the tree fired with no listener, listened with no sender, or sent more values than its handler takes", () => {
  const files = {
    "ReplicatedFirst/Client.client.luau": `local Remotes = game:GetService("ReplicatedStorage"):WaitForChild("Remotes")
Remotes.Orphan:FireServer(1)
local ask = Remotes.Ask
local answer = ask:InvokeServer()
Remotes.Hit:FireServer(1, 2, 3)
Remotes.Hit:FireServer(1)
Remotes.Hit:FireServer(table.unpack({}))
Remotes.Push.OnClientEvent:Connect(function(a) end)
Remotes.Named:FireServer()
-- quack: allow(remote-no-listener)
Remotes.Allowed:FireServer()
Remotes.Moved:FireServer()
`,
    "ServerScriptService/Server.server.luau": `local Remotes = game:GetService("ReplicatedStorage").Remotes
Remotes.Hit.OnServerEvent:Connect(function(player, a, b) end)
print("Named")
local moved = Remotes.Moved:Clone()
`,
    "ServerScriptService/Other.server.luau": `local Shared = game:GetService("ReplicatedStorage").Shared
Shared.Free:FireServer()
setup(Shared)
`,
  };
  const remote = (name: string, cls = "RemoteEvent") => node(name, cls);
  const root = project(files, node("Game", "DataModel", [
    node("ReplicatedStorage", "ReplicatedStorage", [
      node("Remotes", "Folder", [remote("Orphan"), remote("Ask", "RemoteFunction"), remote("Hit"), remote("Push"), remote("Named"), remote("Allowed"), remote("Moved")]),
      node("Shared", "Folder", [remote("Free")]),
    ]),
    node("ReplicatedFirst", "ReplicatedFirst", [node("Client", "LocalScript", [], ["sync/ReplicatedFirst/Client.client.luau"])]),
    node("ServerScriptService", "ServerScriptService", [
      node("Server", "Script", [], ["sync/ServerScriptService/Server.server.luau"]),
      node("Other", "Script", [], ["sync/ServerScriptService/Other.server.luau"]),
    ]),
  ]));
  assert.deepEqual(brief(root).filter((f) => f.includes(" remote-")), [
    `ReplicatedFirst/Client.client.luau:2 remote-no-listener ReplicatedStorage.Remotes.Orphan:FireServer() reaches no code: nothing listens to RemoteEvent.OnServerEvent`,
    `ReplicatedFirst/Client.client.luau:4 remote-no-listener ReplicatedStorage.Remotes.Ask:InvokeServer() reaches no code: nothing listens to RemoteFunction.OnServerInvoke, so the call waits forever`,
    `ReplicatedFirst/Client.client.luau:5 remote-arg-count ReplicatedStorage.Remotes.Hit:FireServer() sends 3 values, but the handler at Server.server.luau:2 takes 2: the rest are dropped`,
    `ReplicatedFirst/Client.client.luau:8 remote-no-sender ReplicatedStorage.Remotes.Push.OnClientEvent never fires: no code calls :FireClient() or :FireAllClients() on it`,
  ]);
});

test("analyze: channels named in a central list, built names, names in config fields and loops, channels kept in a field, and any Fire* verb", () => {
  // the shapes of a game that lists every name once and builds some at run time (Anime Astral, 11/11/26)
  const net = `local Net = {}
local Names = { "Hit", "Buy", "Sell", "Orphan", "Lonely", "Tick" }
local Cache = {}
for _, name in ipairs(Names) do
	if not Cache[name] then Cache[name] = make(name) end
end
function Net.get(name: string)
	return Cache[name]
end
return Net
`;
  const root = project({
    "ReplicatedStorage/Net.luau": net,
    "ReplicatedStorage/Shop.luau": `local Shop = { Bridges = { Request = "Buy", Result = "Sell" } }\nreturn Shop\n`,
    "ReplicatedStorage/Modes.luau": `local Modes = {}\nModes.Bridges = { Raid = "RaidReady", Tower = "TowerReady" }\nreturn Modes\n`,
    "ReplicatedFirst/Client.client.luau": `local RS = game:GetService("ReplicatedStorage")
local Net = require(RS.Net)
local Shop = require(RS.Shop)
local Modes = require(RS.Modes)
local State = {}
local function open(config)
	Net.get(config.Bridges.Request):Fire()
end
open(Shop)
Net.get("Hit"):Fire(1)
Net.get("Orphan"):Fire()
Net.get("RaidAction"):Fire()
for _, bridgeName in pairs(Modes.Bridges) do
	Net.get(bridgeName):Connect(print)
end
function init()
	State.TickEvent = Net.get("Tick")
end
State.TickEvent:Connect(print)
`,
    "ServerScriptService/Server.server.luau": `local RS = game:GetService("ReplicatedStorage")
local Net = require(RS.Net)
local Shop = require(RS.Shop)
local RESULT = "Hit"
local function serve(config)
	Net.get(config.Bridges.Request):Connect(print)
	Net.get(config.Bridges.Result):FireAll()
end
serve(Shop)
Net.get(RESULT):Connect(print)
for _, prefix in { "Raid", "Tower" } do
	Net.get(prefix .. "Action"):Connect(print)
end
Net.get("Lonely"):Connect(print)
Net.get("RaidReady"):FireAll()
Net.get("Tick"):FireAllExcept()
`,
  });
  assert.deepEqual(brief(root).filter((f) => f.includes(" remote-")), [
    `ReplicatedFirst/Client.client.luau:11 remote-no-listener "Orphan" is sent here, but no code connects to "Orphan"`,
    `ServerScriptService/Server.server.luau:14 remote-no-sender "Lonely" is connected here, but no code sends on "Lonely"`,
  ]);
});

test("analyze: a channel made by a function from a literal name (a remote by name, a networking library's object) is matched by that name across the game", () => {
  const net = `local Net = {}\nfunction Net.get(name: string)\n\treturn script:FindFirstChild(name)\nend\nreturn Net\n`;
  const root = project({
    "ReplicatedStorage/Net.luau": net,
    "ReplicatedFirst/Client.client.luau": `local Net = require(game:GetService("ReplicatedStorage").Net)
local hit = Net.get("Hit")
hit:Fire(1)
Net.get("Buy"):Fire()
local typo = Net.get("Sel")
if typo then typo:Fire() end
Net.get("Update"):Connect(function() end)
local late
late = Net.get("Late")
late:Fire()
`,
    "ServerScriptService/Server.server.luau": `local Net = require(game:GetService("ReplicatedStorage").Net)
Net.get("Hit"):Connect(function(player, n) end)
Net.get("Buy"):Connect(print)
Net.get("Sell"):Connect(print)
Net.get("Late"):Connect(print)
local stored = { Net.get("Update") }
`,
  });
  assert.deepEqual(brief(root).filter((f) => f.includes(" remote-")), [
    `ReplicatedFirst/Client.client.luau:6 remote-no-listener "Sel" is sent here, but no code connects to "Sel" (did you mean "Sell"?)`,
    `ServerScriptService/Server.server.luau:4 remote-no-sender "Sell" is connected here, but no code sends on "Sell" (did you mean "Sel"?)`,
  ]);
  // a call with a name the text does not give, that connects: any name sent may have its listener there
  fs.appendFileSync(path.join(root, "sync/ServerScriptService/Server.server.luau"), `local function on(n: string) return n end\nNet.get(on("x")):Connect(print)\n`);
  assert.deepEqual(brief(root).filter((f) => f.includes(" remote-")), [
    `ServerScriptService/Server.server.luau:4 remote-no-sender "Sell" is connected here, but no code sends on "Sell" (did you mean "Sel"?)`,
  ]);
});

test("analyze: a player data key the profile template lacks, read directly or through a key accessor recognized by its use", () => {
  const root = project({
    "ServerScriptService/Data.luau": `local ProfileService = require(game:GetService("ServerScriptService").ProfileService)
local Template = { Coins = 0, Gems = 0, Level = 1, Inventory = {} }
local Store = ProfileService.GetProfileStore("PlayerData", Template)
local Profiles = {}
local Data = {}
function Data.Load(player)
	local profile = Store:LoadProfileAsync("Player_" .. player.UserId)
	profile.Data.Joined = os.time()
	print(profile.Data.Coins, profile.Data.Coinz, profile.Data.Joined)
	Profiles[player] = profile
end
function Data:Get(player, key) return Profiles[player].Data[key] end
function Data:Set(player, key, value) Profiles[player].Data[key] = value end
return Data
`,
    "ServerScriptService/Shop.luau": `local Data = require(script.Parent.Data)
local Shop = {}
function Shop.Buy(player)
	Data:Set(player, "Coins", Data:Get(player, "Coins") - 1)
	Data:Set(player, "Gems", Data:Get(player, "Gems") + 1)
	print(Data:Get(player, "Level"), Data:Get(player, "Inventory.Sword"), Data:Get(player, "Levle"))
end
-- an accessor is one where nine of ten literal names are template keys
function Shop.Show(player)
	print(Data:Get(player, "Coins"), Data:Get(player, "Gems"), Data:Get(player, "Level"), Data:Get(player, "Inventory"), Data:Get(player, "Coins"))
end
return Shop
`,
  });
  assert.deepEqual(brief(root).filter((f) => f.includes("missing-data-key")), [
    `ServerScriptService/Data.luau:9 missing-data-key the player data template has no "Coinz" (did you mean "Coins"?): this reads nil`,
    `ServerScriptService/Shop.luau:6 missing-data-key the player data template has no "Levle" (did you mean "Level"?): this reads nil`,
  ]);
  // a template the text cannot read whole (built elsewhere) leaves every read alone
  fs.writeFileSync(path.join(root, "sync/ServerScriptService/Data.luau"), fs.readFileSync(path.join(root, "sync/ServerScriptService/Data.luau"), "utf8").replace("local Template = {", "local Template = build() or {"));
  assert.deepEqual(brief(root).filter((f) => f.includes("missing-data-key")), []);
});

test("probe: its Luau parses, run-time paths map to the place's files, and repeating or side-specific errors are left out", () => {
  for (const code of [installCode(), readCode("click PlayerGui.A]]B"), readCode("click PlayerGui.Slot]"), removeCode(), requireCode("server", 2, 150), requireCode("client", 2, 150), buttonsCode()]) parseLuau(code);
  const root = project({ "ReplicatedStorage/Shop.luau": "return {}\n" }, node("Game", "DataModel", [
    node("ReplicatedStorage", "ReplicatedStorage", [node("Shop", "ModuleScript", [], ["sync/ReplicatedStorage/Shop.luau"]), node("Pet.Data", "ModuleScript", [], ["sync/ReplicatedStorage/Pet.Data.luau"])]),
    node("StarterGui", "StarterGui", [node("Hud", "ScreenGui", [node("Main", "LocalScript", [], ["sync/StarterGui/Hud/Main.client.luau"])])]),
    node("StarterPlayer", "StarterPlayer", [node("StarterCharacterScripts", "StarterCharacterScripts", [node("Run", "LocalScript", [], ["sync/StarterPlayer/StarterCharacterScripts/Run.client.luau"])])]),
    node("Workspace", "Workspace", [node("Map", "Folder")]),
  ]));
  const tree = loadTree(root, path.join(root, "sync"), path.join(root, "sourcemap.json"));
  assert.equal(nodeForPath(tree, "Players.Ender.PlayerGui.Hud.Main")?.name, "Main");
  assert.equal(nodeForPath(tree, "Workspace.Ender.Run")?.name, "Run");
  assert.equal(nodeForPath(tree, "ReplicatedStorage.Pet.Data")?.name, "Pet.Data");
  assert.equal(nodeForPath(tree, "Workspace.Map")?.name, "Map");
  // the live game's stack (Error Reporting) and the play's
  assert.deepEqual(errorPlace({ m: "Script timeout: exhausted allowed execution time", t: "Script 'ReplicatedStorage.Pet.Data', Line 109", s: "", g: "" }), { path: "ReplicatedStorage.Pet.Data", line: 109 });
  assert.deepEqual(errorPlace({ m: "boom", t: "ReplicatedStorage.Shop, line 12 - function buy\nReplicatedStorage.Main, line 3", s: "", g: "" }), { path: "ReplicatedStorage.Shop", line: 12 });
  assert.equal(errorPlace({ m: "[GuildBoards] refused", t: "EconomyWatch_BalanceP2W", s: "", g: "" }), null, "a grouped warning's varying part is no stack");
  // a native frame first (no comma) stays on its own line
  assert.deepEqual(errorPlace({ m: "boom", t: "[C] function error\nReplicatedStorage.Shop, line 7 - function buy", s: "", g: "" }), { path: "ReplicatedStorage.Shop", line: 7 });
  // a tree with no Workspace (a sync folder with no script there) answers null, never throws
  const bare = loadTree(root, path.join(root, "sync"), path.join(root, "none.json"));
  assert.equal(nodeForPath(bare, "Workspace.Ender.Run"), null);
  const err = (m: string, g: string, s = ""): CollectedError => ({ m, t: "", s, g });
  // the same message at another line is another error
  assert.notEqual(signature("client", err("A.B:12: x 1", "")), signature("client", err("A.B:40: x 1", "")));
  assert.equal(signature("client", err("A.B:12: x 1", "")), signature("client", err("A.B:12: x 2", "")));
  const errors = probeErrors(tree, [
    { side: "client", errors: [err("Players.Ender.PlayerGui.Hud.Main:12: attempt to index nil with 'Visible'", "click PlayerGui.Hud.Buy"), err("Players.Ender.PlayerGui.Hud.Main:12: attempt to index nil with 'Visible'", "click PlayerGui.Hud.Sell"), err("ReplicatedStorage.Shop:3: every frame 41", "click PlayerGui.Hud.Buy")] },
    { side: "server", errors: [err("ReplicatedStorage.Shop:9: LocalPlayer is nil", "require ReplicatedStorage.Shop"), err("ReplicatedStorage.Shop.Inner:2: later", "after requires")] },
  ], new Set([signature("client", err("ReplicatedStorage.Shop:3: every frame 7", ""))]), new Set(["server|ReplicatedStorage.Shop"]));
  assert.deepEqual(errors.map((e) => probeErrorLine(e, root)), [`sync/StarterGui/Hud/Main.client.luau:12  client  attempt to index nil with 'Visible'  (click PlayerGui.Hud.Buy, x2)`]);
});

test("errors: the live game's top error hashes come with their counts, messages and stacks, in batches; a hash with no log keeps its count", async () => {
  const asked: string[] = [];
  const hashes = Array.from({ length: 25 }, (_, i) => String(1000 + i));
  const fake = (async (url: string, init?: RequestInit) => {
    asked.push(`${init?.method ?? "GET"} ${url}`);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/analytics-query-api/")) {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual([body.metric, body.breakdown, body.limit], ["ErrorCount", ["MessageHash"], 100]);
      return json({ done: true, response: { values: hashes.map((h, i) => ({ breakdowns: [{ dimension: "MessageHash", value: h }], dataPoints: [{ value: 100 - i }, { value: 1 }] })) } });
    }
    const ids = new URL(url).searchParams.getAll("messageHashIds");
    return json({ values: ids.filter((id) => id !== "1003").map((id) => ({ id, logSource: "Server", message: `ServerScriptService.Shop:${id}: attempt to index nil`, stacktrace: `Script 'ServerScriptService.Shop', Line ${id}` })) });
  }) as typeof fetch;
  const env = { fetch: fake, dataDir: os.tmpdir(), env: {}, sleep: async () => {}, now: () => Date.parse("2026-11-11T12:00:00Z"), apiKey: async () => "key" };
  const r: any = await ANALYTICS_OPS["errors.list"].run({ env, approve: async () => true } as any, { universeId: "42", days: 3, limit: 25 });
  assert.equal(r.kinds, 25);
  assert.equal(r.errors[0].count, 101);
  assert.equal(r.errors[0].message, "ServerScriptService.Shop:1000: attempt to index nil");
  assert.equal(r.errors[3].message, undefined, "no log for 1003: its count stays, with no message");
  assert.equal(r.errors[3].count, 98);
  const details = asked.filter((a) => a.includes("/log-details?"));
  assert.equal(details.length, 2, "25 hashes go in two requests of at most 20");
  assert.match(details[0], /universe-performance-raqi\/v1\/events\/logging\/universe\/42\/log-details\?messageHashIds=1000&messageHashIds=1001/);
  assert.match(details[0], /startTime=2026-11-08T00:00:00Z&endTime=2026-11-11T12:00:00Z/);
  await assert.rejects(ANALYTICS_OPS["errors.list"].run({ env, approve: async () => true } as any, { universeId: "42", days: 31 }), /days must be/);
});

test("analyze: a Rojo project's tree comes from its project file: a child its folders lack is reported; a $path not on disk, a node Rojo may fill, a binary model, a package's own project and a Version.txt are not", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-rojo-"));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write("default.project.json", JSON.stringify({
    name: "Game",
    tree: {
      $className: "DataModel",
      ReplicatedStorage: { Shared: { $path: "src/shared" }, Packages: { $path: "Packages" }, Lib: { $path: "lib" } },
      ServerScriptService: { $path: "src/server" },
      Workspace: { Map: { $path: "assets/Map.rbxm" } },
    },
  }));
  write("src/shared/Config/Fall.luau", "return {}\n");
  write("src/shared/Version.txt", "1.0\n");
  // a package's own project: its folder is src's contents
  write("lib/default.project.json", JSON.stringify({ name: "lib", tree: { $path: "src" } }));
  write("lib/src/init.luau", "local Util = require(script.Util)\nreturn Util\n");
  write("lib/src/Util.luau", "return {}\n");
  write("assets/Map.rbxm", "binary");
  write("src/server/Main.server.luau", `local RS = game:GetService("ReplicatedStorage")
local Fall = require(RS.Shared.Config.Fall)
local Typo = require(RS.Shared.Config.Fal)
local Version = RS.Shared.Version.Value
local Signal = require(RS.Packages.Signal)
local Lib = require(RS.Lib)
local Spawn = workspace.Map.Spawn
local Made = RS:WaitForChild("MadeByAPackage")
local parent = script.parent.Main
`);
  const tree = await treeFromProject(root);
  assert.ok(tree, "the project file gives a tree");
  assert.equal(tree!.byFile.get(fileKey(path.join(root, "src/server/Main.server.luau")))?.name, "Main", "scripts carry their files");
  const r = analyzeProject(root, { tree: tree! });
  assert.deepEqual(r.findings.filter((f) => f.rule === "missing-child" || f.rule === "invalid-member").map((f) => `${f.line} ${f.rule} ${f.message}`), [
    `3 missing-child ReplicatedStorage.Shared.Config has no child "Fal": .Fal errors`,
  ]);
  // the written sourcemap carries the open marks, and code not on disk read back from it
  const map = await sourcemapFromProject(path.join(root, "default.project.json"));
  assert.equal(map!._quack?.codeMissing, true);
  assert.equal(treeFromSourcemap(map!, root).codeMissing, true, "read back from the written file");
  const rs = map!.children!.find((c) => c.name === "ReplicatedStorage")!;
  assert.equal(rs.children!.find((c) => c.name === "Packages")?._quack?.open, true);
  assert.equal(rs.children!.find((c) => c.name === "Shared")?._quack?.open, undefined);
  // the package's init script is the package node, with its file (not a Folder before it)
  const lib = rs.children!.find((c) => c.name === "Lib")!;
  assert.equal(lib.className, "ModuleScript");
  assert.deepEqual(lib.filePaths, ["lib/src/init.luau"]);
  // a project file given relative to the cwd
  const cwd = process.cwd();
  process.chdir(path.dirname(root));
  try {
    assert.ok(await sourcemapFromProject(path.join(path.basename(root), "default.project.json")));
  } finally {
    process.chdir(cwd);
  }
  // a sync folder given with the tree adds its scripts, it does not replace the tree's (lib's are read)
  const both = analyzeProject(root, { tree: tree!, syncDir: "src" });
  assert.ok(both.stats.scripts >= 4, `${both.stats.scripts} scripts read`);
  // with a package not installed, a remote fired with no listener on disk may be heard there
  write("src/server/Fire.server.luau", `local RS = game:GetService("ReplicatedStorage")\nRS.Shared.Ping:FireServer()\n`);
  write("src/shared/Ping.model.json", JSON.stringify({ className: "RemoteEvent" }));
  const missing = analyzeProject(root, { tree: (await treeFromProject(root))! });
  assert.deepEqual(missing.findings.filter((f) => f.rule.startsWith("remote-")), []);
  // the Map.rbxm may hold the listener too: only with no binary model is the dead send reported
  fs.mkdirSync(path.join(root, "Packages"));
  const withModel = await treeFromProject(root);
  assert.equal(withModel!.codeMissing, true, "a binary model is code the reader does not see");
  assert.deepEqual(analyzeProject(root, { tree: withModel! }).findings.filter((f) => f.rule.startsWith("remote-")), []);
  fs.rmSync(path.join(root, "assets"), { recursive: true });
  // a script whose source sits inside a .model.json has no file the analyzer reads
  write("src/shared/Embedded.model.json", JSON.stringify({ className: "ModuleScript", properties: { Source: "return {}" } }));
  assert.equal((await treeFromProject(root))!.codeMissing, true);
  fs.rmSync(path.join(root, "src/shared/Embedded.model.json"));
  write("default.project.json", JSON.stringify({
    name: "Game",
    tree: { $className: "DataModel", ReplicatedStorage: { Shared: { $path: "src/shared" }, Packages: { $path: "Packages" }, Lib: { $path: "lib" } }, ServerScriptService: { $path: "src/server" } },
  }));
  const installed = analyzeProject(root, { tree: (await treeFromProject(root))! });
  assert.deepEqual(installed.findings.filter((f) => f.rule.startsWith("remote-")).map((f) => f.rule), ["remote-no-listener"]);
});

test("analyze: a path that climbs into a Starter container, a type, or a vendored package is not reported", () => {
  // Seen in Seven Sins and ExxoCreation 2 (10/11/26): types never run, and TopbarPlus's Janitor
  // looks for the framework it was written for
  const files = {
    "StarterPlayer/StarterPlayerScripts/Main.client.luau": `local m = script.Parent:WaitForChild("PlayerModule")\n`,
    "ReplicatedStorage/Types.luau": `export type MainUI = typeof(game:GetService("StarterGui"):WaitForChild("MainUI"))\nreturn {}\n`,
    "ReplicatedStorage/Packages/Janitor.luau": `local main = require(game:GetService("ReplicatedStorage").Framework)\nreturn {}\n`,
    "ReplicatedStorage/Maid.luau": `local Maid = {}\nfunction Maid.new() end\nreturn Maid\n`,
    "ReplicatedStorage/Replica.luau": `local Maid = require(script.Parent.Maid)\nexport type R = {\n\tMaid: typeof(Maid),\n}\nreturn {}\n`,
  };
  const root = project(files, node("Game", "DataModel", [
    node("ReplicatedStorage", "ReplicatedStorage", [
      node("Types", "ModuleScript", [], ["sync/ReplicatedStorage/Types.luau"]),
      node("Maid", "ModuleScript", [], ["sync/ReplicatedStorage/Maid.luau"]),
      node("Replica", "ModuleScript", [], ["sync/ReplicatedStorage/Replica.luau"]),
      node("Packages", "Folder", [node("Janitor", "ModuleScript", [], ["sync/ReplicatedStorage/Packages/Janitor.luau"])]),
    ]),
    node("StarterGui", "StarterGui"),
    node("StarterPlayer", "StarterPlayer", [node("StarterPlayerScripts", "StarterPlayerScripts", [node("Main", "LocalScript", [], ["sync/StarterPlayer/StarterPlayerScripts/Main.client.luau"])])]),
  ]));
  assert.deepEqual(brief(root), []);
});

test("analyze: the linter's findings come with the rest, and an allow comment (Quack's or selene's) silences one", () => {
  const root = project({
    "ServerScriptService/A.server.luau": `local function f(a) return a end
f(1, 2)
-- quack: allow(mismatched-arg-count)
f(1, 2)
f(1, 2) -- selene: allow(mismatched_arg_count)
print(Missing)
`,
  });
  assert.deepEqual(brief(root), [
    "ServerScriptService/A.server.luau:2 mismatched-arg-count `f` takes 1 argument but 2 are passed",
    "ServerScriptService/A.server.luau:6 undefined-variable `Missing` is not defined",
  ]);
  for (const name of ["Died", "ChildAdded", "OnClientEvent", "Size", "SetCore", "WaitForChild"]) assert.ok(ROBLOX_MEMBERS.has(name), name);
});

test("analyze: a TestEZ .spec file has its runner's globals, and what Wally installs is read but never reported (a package copied by hand is)", () => {
  const root = project({
    "ReplicatedStorage/Thing.spec.luau": `return function() describe("x", function() it("y", function() expect(Undefined).to.be.ok() end) end) end\n`,
    "ReplicatedStorage/Packages/_Index/lemur/spec.lua": `print(io.write, describe)\nlocal function nop() end\nnop(1)\n`,
    "ReplicatedStorage/Packages/Copied.lua": "print(Patched)\n",
  });
  assert.deepEqual(brief(root), [
    "ReplicatedStorage/Packages/Copied.lua:1 undefined-variable `Patched` is not defined",
    "ReplicatedStorage/Thing.spec.luau:1 undefined-variable `Undefined` is not defined",
  ]);
});

test("analyze: a worktree with no sourcemap borrows the one of the registered folder of its repository", async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore", windowsHide: true });
  const main = project(
    { "ReplicatedStorage/Client.client.luau": `local r = game:GetService("ReplicatedStorage"):WaitForChild("Remotes")\n` },
    node("Game", "DataModel", [node("ReplicatedStorage", "ReplicatedStorage", [node("Client", "LocalScript", [], ["sync/ReplicatedStorage/Client.client.luau"])])]),
  );
  git(main, "init", "-q");
  git(main, "add", "sync");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
  const wt = path.join(path.dirname(main), `${path.basename(main)}-wt`);
  git(main, "worktree", "add", "-q", wt);
  try {
    const out: string[] = [];
    const code = await runAnalyze({ cwd: wt, files: [], json: true, out: (l) => out.push(l), placeFolders: async () => [main, os.tmpdir()] });
    const report = JSON.parse(out.join("\n"));
    assert.equal(report.stats.tree, "sourcemap");
    assert.equal(report.stats.sourcemap, path.join(main, "sourcemap.json"));
    assert.deepEqual(report.findings.map((f: any) => [path.relative(wt, f.file).replace(/\\/g, "/"), f.line, f.rule]), [["sync/ReplicatedStorage/Client.client.luau", 1, "missing-child"]], "the worktree's own file, checked against the place's tree");
    assert.equal(code, 1);
    // the hub down: the worktree is still checked, without paths
    const quiet: string[] = [];
    assert.equal(await runAnalyze({ cwd: wt, files: [], json: true, out: (l) => quiet.push(l), placeFolders: () => Promise.reject(new Error("offline")) }), 0);
    assert.equal(JSON.parse(quiet.join("\n")).stats.tree, "sync folder");
  } finally {
    git(main, "worktree", "remove", "--force", wt);
  }
});

test("analyze: the command finds the project from a file, answers JSON and exits 1 when it finds something", async () => {
  const root = project({
    "ServerScriptService/M.luau": "local M = {}\nfunction M.A() end\nreturn M\n",
    "ServerScriptService/U.server.luau": "local M = require(script.Parent.M)\nM.A()\nM.B()\n",
  });
  const file = path.join(root, "sync/ServerScriptService/U.server.luau");
  assert.equal(projectRoot(file), root);
  const lines: string[] = [];
  const code = await runAnalyze({ cwd: os.tmpdir(), files: [file], json: true, out: (l) => lines.push(l) });
  assert.equal(code, 1);
  const report = JSON.parse(lines.join("\n"));
  assert.deepEqual(report.findings.map((f: any) => [f.line, f.rule]), [[3, "missing-member"]]);
  const text: string[] = [];
  assert.equal(await runAnalyze({ cwd: root, files: ["sync/ServerScriptService/M.luau"], json: false, out: (l) => text.push(l) }), 0);
  assert.match(text.join("\n"), /^Nothing found in 2 scripts/);
  const none: string[] = [];
  assert.equal(await runAnalyze({ cwd: os.tmpdir(), files: [], json: false, out: (l) => none.push(l) }), 1);
  assert.match(none[0], /No sync folder/);
});
