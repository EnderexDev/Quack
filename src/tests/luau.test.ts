import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TESTEZ_GLOBALS } from "../analyze/luau/globals.js";
import { lintLuau } from "../analyze/luau/lint.js";
import { parseLuau } from "../analyze/luau/parser.js";
import { LuauSyntaxError } from "../analyze/luau/lexer.js";

// Quack's own Luau parser and linter, which replaced selene (his call, 10/11/26). Before selene
// went, both ran over the four games, the plugin and the 31 copies of the review set C: the same
// 6 errors on the same lines, and every difference was one of selene's own false alarms
// (string requires, buffer.readbits, a one-argument assert).

const lines = (src: string) => lintLuau(src).findings.map((f) => `${src.slice(0, f.at).split("\n").length} ${f.rule}`);

test("luau: the three set C bugs selene caught, rebuilt (no game code), on their lines", () => {
  // ButtonAnimator (C-61780c99): a local function called above its own `local function`
  assert.deepEqual(lines(`local function TweenIcons(icons)
	for _, icon in icons do
		AnimateTween(icon)
	end
end

local function AnimateTween(target)
	return target
end

return { TweenIcons = TweenIcons, AnimateTween = AnimateTween }
`), ["3 undefined-variable"]);
  // FixerGigController (C-1c10d26e): a string left open keeps the module from loading
  assert.deepEqual(lines(`local function label(rare)
	return ("%s%% rare: Boss
		Epic"):format(rare)
end
return label
`), ["2 parse-error"]);
  // RaidController (C-5249a642): the parameter is `_arg4`, the body reads `arg4`
  assert.deepEqual(lines(`local Event = {}
Event.Connect = function(_, f) return f end
Event:Connect(function(arg1, _arg4)
	if arg4 == true and type(arg1) == "table" then
		return
	end
end)
`), ["4 undefined-variable"]);
});

test("luau: a missing end is reported where the file runs out, naming the line the block opened at", () => {
  const src = "local function a()\n\tif true then\n\t\tprint(1)\n\nend\n";
  assert.throws(() => parseLuau(src), (e: unknown) => e instanceof LuauSyntaxError && /Expected 'end' \(to close 'function' at line 1\), got <eof>/.test(e.message));
});

test("luau: scopes follow Luau (for variables, repeat-until, self, recursion, globals assigned anywhere)", () => {
  assert.deepEqual(lines(`for i = 1, 2 do end
print(i)
repeat local r = 1 until r == 1
local M = {}
function M:m() return self end
print(self)
local function rec(n) return rec(n - 1) end
local notRec = function() return notRec end
print(Later)
Later = 1
local function g() Inner = 2 end
print(Inner, ..., typeof(game), workspace, Vector3.new(), Instance.new("Part"), task.wait())
local t: Missing = nil
type X = typeof(Absent)
print(\`{Interp}\`, rec, g, t)
`), ["2 undefined-variable", "6 undefined-variable", "8 undefined-variable", "15 undefined-variable"]);
});

test("luau: the checks selene called errors, each on its line", () => {
  assert.deepEqual(lines(`local a, b = 1, 2
a = b
b = a
local x = 0
if x == 0/0 then end
if x == {} then end
local t = { k = 1, k = 2, [1] = 1, [1] = 2 }
if x == 1 then print(1) elseif x == 1 then print(2) end
print(string.format())
local function two(p, q) return p, q end
two(1, 2, 3)
for i = #t, 1 do print(i) end
if type(x == "string") then end
print(math.floor(1, 2))
local c = Color3.new(255, 0, 0)
print(two(1, two(1, 2)), math.max(1, table.unpack(t)), c)
`), ["2 almost-swapped", "5 compare-nan", "6 constant-table-compare", "7 duplicate-key", "7 duplicate-key", "8 ifs-same-cond", "9 std-arg-count", "11 mismatched-arg-count", "12 reverse-loop", "13 type-check-inside-call", "14 std-arg-count", "15 color3-bounds"]);
  // not errors: a local `math`, a vararg function, a call as the last argument, selene's own false alarms
  assert.deepEqual(lines(`local math = { floor = function(...) return ... end }
print(math.floor(1, 2, 3))
local function va(...) return ... end
va(1, 2, 3)
assert(true)
local b = buffer.create(4)
buffer.writebits(b, 0, 1, 1)
local Config = require("../Config")
print(Config)
`), []);
});

// The council's review of the parser and linter (10/11/26), one case per real finding
test("luau: the review's cases (inherited names, reassigned functions, literal spaces, positional keys, nan, deprecated globals)", () => {
  assert.deepEqual(lines(`constructor(1)
toString()
local function f() end
f = function(a) return a end
f(1)
local x = ""
if x == "a b" then elseif x == "a  b" then end
local t = { [1] = "a", "b", [2] = "c" }
print(x == (0/0), x ~= 0/0)
task.delay(1)
print(stats, version, Wait, Game, Workspace)
print(t)
`), ["1 undefined-variable", "2 undefined-variable", "8 duplicate-key", "9 compare-nan", "9 compare-nan", "10 std-arg-count"]);
  assert.match(lintLuau("print(1 ~= 0/0)").findings[0].message, /always true/);
  // a byte escape and the same character typed are one key; two bytes that are no UTF-8 are two
  assert.deepEqual(lines('local t = { ["\\195\\169"] = 1, ["é"] = 2 }\nprint(t)'), ["1 duplicate-key"]);
  assert.deepEqual(lines('local t = { ["\\255"] = 1, ["\\254"] = 2 }\nprint(t)'), []);
  // a call anywhere in a condition may change it between branches
  assert.deepEqual(lines('local x, f = 1, function() return 1 end\nif `{f()}` == x then elseif `{f()}` == x then end\nif (if f() then 1 else 2) == x then elseif (if f() then 1 else 2) == x then end\nif #{ f() } == x then elseif #{ f() } == x then end'), []);
  // break and continue need a loop of their own function
  for (const bad of ["break", "continue", "local f = function() break end", "for i = 1, 2 do local g = function() continue end end", "local x = 0x_", "local x = 0b_"]) {
    assert.throws(() => parseLuau(bad), LuauSyntaxError, bad);
  }
  parseLuau("while true do do break end end\nrepeat continue until true\nfor _ = 1, 2 do if true then break end end");
});

test("luau: the syntax Roblox runs today parses", () => {
  parseLuau(`--!strict
@native
local function f<T>(x: T, ...: number): (T, ...number) return x, ... end
@checked function g() end
type Map<K, V = string> = { [K]: V, read name: string, write count: number? }
export type Fn = <A...>(A...) -> ...any
type function Id(t) return t end
type U = "a" | "b" | typeof(f) & { x: number }
type Arr = { number }
type Pack = (number, string) -> (boolean, ...string)
const LIMIT: number = 1_000
local n = 0x_FF + 0b1010 + 1e-3 + .5
local s = \`a {n} b {\`inner {n}\`} c\` .. "\\u{48}\\z
   tail" .. [==[long]] still]==] .. '\\q'
local v = if n > 1 then "big" elseif n < 0 then "neg" else "small"
n += 1; n //= 2; s ..= "x"
for _, k in { 1, 2 } do if k == 1 then continue end end
local continue = 1
continue += 1
local w = (f :: any)(1) :: number
local tbl = { [1] = 1, a = 2; 3 }
print(s, v, w, tbl, LIMIT, continue, g)
local one = f<<number>>(1)
local m = { get = function(self) return self end }
m:get<<string>>()
local two = m.get<<number, { string }>>(m)
local inst = f<<Vector3>>
Signal.Listen<<boolean?>>(m, "x"):Connect(print)
const function h(): () print(one, two, inst) end
`);
  for (const bad of ["local x = 1..2", "local s = \"\\300\"", "local s = \`a {{b}\`", "local x = 0b2", "local function f() return ... end", "x = 1 return x print(x)"]) {
    assert.throws(() => parseLuau(bad), LuauSyntaxError, bad);
  }
});

test("luau: a global tested before use, TestEZ's globals in a test file, and the deprecated ypcall are defined (open-source corpus, 11/11/26)", () => {
  // `if setclipboard then` probes an environment: absent on purpose where the game runs
  assert.deepEqual(lines(`if setclipboard then (setclipboard :: any)("x") end
local copy = writefile and writefile("a", "b")
if typeof(getgenv) == "function" then getgenv() end
local ok = ypcall(print)
print(Missing)
`), ["5 undefined-variable"]);
  const spec = `return function() describe("x", function() it("y", function() expect(1).to.equal(1) end) end) end\n`;
  assert.deepEqual(lines(spec), ["1 undefined-variable", "1 undefined-variable", "1 undefined-variable"]);
  assert.deepEqual(lintLuau(spec, { globals: TESTEZ_GLOBALS }).findings, []);
});

test("luau: table.remove while walking forward, or by indexes gathered in ascending order (BridgeNet2's waiters, fixed in a game 31/08/26)", () => {
  assert.deepEqual(lines(`local list = {}
for i = 1, #list do
	if list[i].Dead then
		table.remove(list, i)
	end
end
for i, v in ipairs(list) do
	if v == "wanted" then table.remove(list, i) end
end
for i, v in list do
	if v.Dead then table.remove(list, i) break end
end
for i = #list, 1, -1 do
	table.remove(list, i)
end
local waiting = {}
local indexes = {}
for index, thread in waiting[1] do
	table.insert(indexes, index)
end
for _, index in indexes do
	table.remove(waiting[1], index)
end
`), ["4 remove-in-loop", "22 remove-in-loop"]);
  // review (11/11/26): an elseif's match, another local with the table's name, a list sorted high to low, and a list filled below
  assert.deepEqual(lines(`local list, wanted = {}, 1
for i, v in ipairs(list) do
	if v == 0 then print(v) elseif v == wanted then table.remove(list, i) end
end
for i = 1, #list do
	local list = { 1, 2 }
	table.remove(list, i)
end
local gathered = {}
for i in list do table.insert(gathered, i) end
table.sort(gathered, function(a, b) return a > b end)
for _, i in gathered do table.remove(list, i) end
local function later()
	for _, i in ipairs(shared.late) do table.remove(list, i) end
end
local late = {}
for _, i in late do table.remove(list, i) end
for i in list do table.insert(late, i) end
`), ["17 remove-in-loop"]);
});

test("luau: a handler that connects every run to something that outlives it; a new object, a kept connection or a handler that disconnects itself is fine", () => {
  assert.deepEqual(lines(`local Players = game:GetService("Players")
local button = script.Parent
Players.PlayerAdded:Connect(function(player)
	game.ReplicatedStorage.Remote.OnServerEvent:Connect(print)
	player.CharacterAdded:Connect(function(character)
		player.Chatted:Connect(print)
		character.Humanoid.Died:Connect(print)
	end)
end)
button.Activated:Connect(function()
	local clone = button:Clone()
	clone.Activated:Connect(print)
	local kept = button.MouseEnter:Connect(print)
end)
local tween
local con
con = button.Activated:Connect(function()
	tween = game:GetService("TweenService"):Create(button, TweenInfo.new(1), {})
	tween.Completed:Connect(print)
	con:Disconnect()
	button.MouseLeave:Connect(print)
end)
button.Activated:Once(function()
	button.MouseEnter:Connect(print)
end)
`), ["4 connect-in-handler", "6 connect-in-handler"]);
  // a chain through a call that makes the object (a clone, a getter) is not the name's own event
  assert.deepEqual(lines(`local template = script.Parent
template.Activated:Connect(function()
	template:Clone().Touched:Connect(print)
	game:GetService("ReplicatedStorage"):WaitForChild("Remote").OnClientEvent:Connect(print)
end)
`), ["4 connect-in-handler"]);
});

test("luau: in a list of records, the one entry with a field a letter away from the one every other entry has", () => {
  const entry = (i: number, rarity = "Rarity") => `\t{ Name = "P${i}", ${rarity} = "Common", Price = ${i} },`;
  assert.deepEqual(lines(`local Pets = {\n${[1, 2, 3, 4].map((i) => entry(i)).join("\n")}\n${entry(5, "Rariety")}\n}\nreturn Pets\n`), ["6 field-typo"]);
  // a field only some entries have is optional, not a typo
  assert.deepEqual(lines(`local Pets = {\n${[1, 2, 3, 4, 5].map((i) => entry(i)).join("\n")}\n\t{ Name = "P6", Rarity = "Rare", Price = 6, Shiny = true },\n}\nreturn Pets\n`), []);
});

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function luauFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...luauFiles(p));
    else if (/\.luau?$/.test(e.name)) out.push(p);
  }
  return out;
}

test("luau: every script of Quack's own plugin parses and lints with no error (122 files, Fusion's types, a 5.8 MB vendored module)", () => {
  const files = luauFiles(path.join(repo, "plugin", "sync"));
  assert.ok(files.length > 100);
  for (const f of files) {
    const findings = lintLuau(fs.readFileSync(f, "utf8")).findings.filter((x) => x.rule !== "almost-swapped" || !f.includes("LibMP"));
    assert.deepEqual(findings, [], f);
  }
});

// A game's scripts never go in this repo (it is exported public): point QUACK_LUAU_CORPUS at
// synced folders (";"-separated) to parse them all. Roblox runs every one, so any failure is ours.
const corpus = (process.env.QUACK_LUAU_CORPUS ?? "").split(";").filter((d) => d && fs.existsSync(d));
test("luau: every script of the games in QUACK_LUAU_CORPUS parses", { skip: corpus.length === 0 }, () => {
  for (const dir of corpus) {
    for (const f of luauFiles(dir)) {
      try {
        parseLuau(fs.readFileSync(f, "utf8"));
      } catch (e) {
        assert.fail(`${f}: ${(e as Error).message}`);
      }
    }
  }
});
