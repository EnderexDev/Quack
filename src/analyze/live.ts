/**
 * The keys of the modules the text cannot read (wrapped, a metatable, filled by a loop or by
 * another module), read from a play already running (his call, 10/11/26: any place, the real
 * Astral too, only when a play is up; never one started for this). The Luau below runs in the
 * play's server and only reads: it requires modules the game's server requires anyway (the
 * analyzer sends no other), lists each one's string keys raw (`next`, no `__iter`), and follows
 * `__index` only while it is a table. A function `__index`, a locked metatable or a value that
 * is not a table leaves the module unread, as before.
 */

/**
 * Seconds the requires get, all together (they start at once): a module whose require has not
 * returned by then is left unread. The modules sent are ones the server loads when it starts, so
 * their require returns at once; one still waiting is waiting with the game's own require (a
 * child that never comes). That thread is left to finish with it, not cancelled: cancelling a
 * thread inside require could leave the module half loaded for the game.
 */
const REQUIRE_WAIT = 3;
/** `__index` tables followed at most */
const MAX_DEPTH = 8;

/**
 * The Luau for eval-server: reads the modules at these instance paths, returns one entry per
 * module. A module with roots (proven loaded by them) is required only when one of its root
 * Scripts is in the play, enabled and not client-run: the sourcemap has no properties, so a
 * disabled Script or one with RunContext Client cannot be told from the disk. A module with no
 * roots is one whose top level only builds and reads: requiring it changes nothing.
 */
export function liveKeysCode(modules: { path: string[]; roots: string[][] }[]): string {
  const json = JSON.stringify(modules.map((m) => [m.path, m.roots]));
  let level = "";
  while (`${json}]`.includes(`]${level}]`)) level += "=";
  return `local HttpService = game:GetService("HttpService")
local modules = HttpService:JSONDecode([${level}[${json}]${level}])
local function find(p)
	local found, inst = pcall(game.GetService, game, p[1])
	if not found then
		return nil
	end
	for j = 2, #p do
		inst = inst and inst:FindFirstChild(p[j])
	end
	return inst
end
local function runsOnServer(p)
	local s = find(p)
	return s ~= nil and s.ClassName == "Script" and s.Enabled and s.RunContext ~= Enum.RunContext.Client
end
local out = {}
local loads = {}
local pending = 0
for i, m in modules do
	local inst = find(m[1])
	if not inst or not inst:IsA("ModuleScript") then
		out[i] = { why = "not in the play" }
		continue
	end
	-- no roots: a module whose top level only builds and reads, safe to require even if never loaded
	local loaded = #m[2] == 0
	for _, root in m[2] do
		if runsOnServer(root) then
			loaded = true
			break
		end
	end
	if not loaded then
		out[i] = { why = "no enabled server Script loads it" }
		continue
	end
	local load = { done = false, ok = false, value = nil }
	loads[i] = load
	pending += 1
	task.spawn(function()
		load.ok, load.value = pcall(require, inst)
		load.done = true
		pending -= 1
	end)
end
local started = os.clock()
while pending > 0 and os.clock() - started < ${REQUIRE_WAIT} do
	task.wait()
end
for i, load in loads do
	local ok, value = load.ok, load.value
	if not load.done then
		out[i] = { why = "require did not return in ${REQUIRE_WAIT} s" }
	elseif not ok then
		out[i] = { why = "require failed: " .. tostring(value) }
	elseif type(value) ~= "table" then
		out[i] = { why = "returns a " .. typeof(value) }
	else
		local keys, list = {}, {}
		local t, why, depth = value, nil, 0
		while t ~= nil do
			depth += 1
			if depth > ${MAX_DEPTH} then
				why = "__index deeper than ${MAX_DEPTH} tables"
				break
			end
			for k in next, t do
				if type(k) == "string" and not keys[k] then
					keys[k] = true
					table.insert(list, k)
				end
			end
			local mt = getmetatable(t)
			if mt == nil then
				break
			end
			-- a protected metatable answers with its __metatable value (any table), not itself: setting
			-- the same metatable back errors only then (and on a frozen table), and changes nothing
			if type(mt) ~= "table" or not pcall(setmetatable, t, mt) then
				why = "a locked metatable"
				break
			end
			local index = rawget(mt, "__index")
			if index ~= nil and type(index) ~= "table" then
				why = "__index is a " .. type(index)
				break
			end
			t = if index == t then nil else index
		end
		out[i] = if why then { why = why } else { keys = list }
	end
end
return out
`;
}

export type LiveAnswer = { keys: string[]; why?: undefined } | { why: string; keys?: undefined };

/** The eval's returned value (the table, JSON-encoded by the plugin), one entry per path sent */
export function parseLiveAnswer(value: string | undefined, count: number): LiveAnswer[] {
  const parsed = JSON.parse(value ?? "null");
  if (!Array.isArray(parsed) || parsed.length !== count) throw new Error(`the play answered ${Array.isArray(parsed) ? `${parsed.length} entries for ${count} modules` : "something else"}`);
  return parsed.map((e) => (e && Array.isArray(e.keys) ? { keys: e.keys.filter((k: unknown) => typeof k === "string") } : { why: String(e?.why ?? "no answer") }));
}
