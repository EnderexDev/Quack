--!nocheck
-- Quack Test's runtime: one Lune process runs one batch of specs against the place's tree.
--
--   lune run main.luau <boot JSON> (or a file holding it)
--
-- It loads the tree first (the .rbxl kept from an earlier build, else built from the sourcemap
-- or the tree file Quack wrote, then kept), prints a ready line, and waits for one request line
-- on stdin. The hub starts it before anyone asks (a standby: the tree is loaded by the time a
-- run comes) and replaces it after its run, since a test may change the tree; the CLI with no
-- hub starts it and writes the request at once. Closing stdin before a request ends it. The
-- answer is one line on stdout:
--
--   @@quacktest-ready@@ {"ms":..,"instances":..,"scripts":..,"built":bool}
--   @@quacktest-result@@ {"specs":[...],"setup":{..},"ms":..}
--
-- Everything the game prints goes into the test that was running, never to stdout.

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local stdio = require("@lune/stdio")
local task = require("@lune/task")
local LuneDateTime = require("@lune/datetime")

local READY = "@@quacktest-ready@@ "
local RESULT = "@@quacktest-result@@ "
local PROGRESS = "@@quacktest-progress@@"
local OUTSIDE = "[outside Studio] "
local MAX_OUTPUT = 60

local started = os.clock()
local bootArg = assert(process.args[1], "usage: main.luau <boot JSON, or a file holding it>")
local boot = serde.decode("json", if string.sub(bootArg, 1, 1) == "{" then bootArg else fs.readFile(bootArg))
local Instance = roblox.Instance

local ctx = { Enum = roblox.Enum, waitTimeout = boot.waitTimeout or 2 }

-- ---------------------------------------------------------------------------------------------
-- Errors: what a failure says, where it happened, whether it is the code's or the run's

-- The text of any error value: Lune raises its own errors as `error` userdata, which
-- string.format("%s") refuses and Roblox never gives; the game always sees a string
function ctx.message(e: any): string
	if type(e) == "table" and (e.__quackFailure or e.__quackExpect) then
		return e.message
	end
	if typeof(e) == "error" then
		local text = tostring(e)
		text = string.gsub(text, "^<LuaError%(\n?", "")
		text = string.gsub(text, "^runtime error: ", "")
		text = string.gsub(text, "^callback error: ", "")
		local cut = string.find(text, "\n%[Stack Begin%]") or string.find(text, "\nstack traceback:")
		if cut then
			text = string.sub(text, 1, cut - 1)
		end
		return (string.gsub(text, "%s+$", ""))
	end
	return if type(e) == "string" then e else tostring(e)
end

-- Failures captured during the running test: a game that catches an error and raises its own
-- message around it keeps the inner one's place this way
local recent = {}

-- xpcall's handler everywhere: the error, with the stack at the point it was raised
function ctx.capture(e: any)
	if type(e) == "table" and e.__quackFailure then
		return e
	end
	local record = {
		__quackFailure = true,
		message = ctx.message(e),
		expect = type(e) == "table" and e.__quackExpect == true,
		traceback = debug.traceback(),
	}
	table.insert(recent, record)
	return record
end

function ctx.failExpect(message: string)
	error({ __quackExpect = true, message = message }, 0)
end

-- A piece of the play this process does not have
function ctx.outside(what: string)
	error(OUTSIDE .. what, 0)
end

local threadErrors = {}
function ctx.threadError(text: string, err: any)
	table.insert(threadErrors, { text = text, record = if type(err) == "table" and err.__quackFailure then err else nil })
end
function ctx.raiseThreadErrors()
	if #threadErrors > 0 then
		local first = threadErrors[1]
		threadErrors = {}
		error(first.record or { __quackFailure = true, message = first.text, traceback = "" }, 0)
	end
end

-- What the game printed, kept with the test that was running
local output = {}
function ctx.output(kind: string, text: string)
	if #output < MAX_OUTPUT then
		table.insert(output, (if kind == "print" then "" else `[{kind}] `) .. text)
	elseif #output == MAX_OUTPUT then
		table.insert(output, "(more output cut)")
	end
end

local function joined(...)
	local args = table.pack(...)
	local parts = {}
	for i = 1, args.n do
		parts[i] = tostring(args[i])
	end
	return table.concat(parts, " ")
end

-- typeof that knows this runtime's Roblox types (tables marked with __type)
function ctx.typeof(value: any): string
	if type(value) == "table" then
		local meta = getmetatable(value)
		if type(meta) == "table" and type(rawget(meta, "__type")) == "string" then
			return rawget(meta, "__type")
		end
	end
	return typeof(value)
end

-- ---------------------------------------------------------------------------------------------
-- The tree

local game, fileOf, byFile
local userChunks = {}

-- Children with a name another sibling also has are found by their place among those
local function lookup(path)
	local node = game
	for _, step in path do
		if type(step) == "string" then
			node = node:FindFirstChild(step)
		else
			local seen = 0
			local found = nil
			for _, child in node:GetChildren() do
				if child.Name == step[1] then
					seen += 1
					if seen == step[2] then
						found = child
						break
					end
				end
			end
			node = found
		end
		if not node then
			return nil
		end
	end
	return node
end

local function isScriptFile(f: string): boolean
	return string.match(f, "%.luau?$") ~= nil
end

-- The sourcemap's shape: { name, className, filePaths?, children? }
local function build(json)
	local model = Instance.new("DataModel")
	local index = {}
	local made, refused = 0, 0
	local function steps(parentSteps, siblings, node)
		local count, nth = 0, 0
		for _, s in siblings do
			if s.name == node.name then
				count += 1
				if s == node then
					nth = count
				end
			end
		end
		local out = table.clone(parentSteps)
		local total = 0
		for _, s in siblings do
			if s.name == node.name then
				total += 1
			end
		end
		table.insert(out, if total > 1 then { node.name, nth } else node.name)
		return out
	end
	local function add(node, parent, path)
		local ok, inst = pcall(Instance.new, node.className)
		if not ok then
			refused += 1
			inst = Instance.new("Folder")
		end
		inst.Name = node.name
		for _, f in node.filePaths or {} do
			if isScriptFile(f) then
				table.insert(index, { path = path, file = (string.gsub(f, "\\", "/")) })
				break
			end
		end
		inst.Parent = parent
		made += 1
		local children = node.children or {}
		for _, child in children do
			add(child, inst, steps(path, children, child))
		end
	end
	for _, service in json.children or {} do
		local ok, inst = pcall(model.GetService, model, service.className)
		if not ok then
			inst = Instance.new("Folder")
			inst.Name = service.name
			inst.Parent = model
		end
		local children = service.children or {}
		for _, child in children do
			add(child, inst, steps({ service.name }, children, child))
		end
	end
	return model, index, made, refused
end

local function loadTree()
	local t = boot.tree
	local built = false
	local index
	-- a kept tree that cannot be read (cut, or from another Lune) is built again and replaced
	local kept = t.cache and fs.isFile(t.cache) and fs.isFile(t.cache .. ".index.json") and pcall(function()
		local place = roblox.deserializePlace(fs.readFile(t.cache))
		local entries = serde.decode("json", fs.readFile(t.cache .. ".index.json"))
		assert(type(entries) == "table")
		game, index = place, entries
	end)
	if not kept then
		local json = serde.decode("json", fs.readFile(t.source))
		game, index = build(json)
		built = true
		if t.cache then
			-- written whole under a name of this process's own and then moved, so a process never
			-- reads half of one and two processes building at once never write the same file. A
			-- write that fails (a full disk) costs only the next run's build, never this run
			local temp = `{t.cache}.{boot.tmp or "0"}.tmp`
			pcall(function()
				fs.writeFile(temp, roblox.serializePlace(game))
				fs.writeFile(temp .. ".index.json", serde.encode("json", index))
				fs.move(temp .. ".index.json", t.cache .. ".index.json", true)
				fs.move(temp, t.cache, true)
			end)
			pcall(fs.removeFile, temp .. ".index.json")
			pcall(fs.removeFile, temp)
		end
	end
	fileOf = setmetatable({}, { __mode = "k" })
	byFile = {}
	for _, entry in index do
		local inst = lookup(entry.path)
		if inst then
			fileOf[inst] = entry.file
			byFile[entry.file] = inst
		end
	end
	return built, #index
end

-- Services every play has, so game.Players and game:GetService("Players") both answer
local SERVICES = {
	"Workspace", "Players", "Lighting", "ReplicatedFirst", "ReplicatedStorage", "ServerScriptService", "ServerStorage",
	"StarterGui", "StarterPack", "StarterPlayer", "SoundService", "Teams", "RunService", "TweenService", "HttpService",
	"CollectionService", "DataStoreService", "MemoryStoreService", "MarketplaceService", "TextService", "UserInputService",
	"ContextActionService", "GuiService", "PhysicsService", "Debris", "BadgeService", "MessagingService", "TeleportService",
	"LocalizationService", "PolicyService", "SocialService", "ContentProvider", "TextChatService", "Chat", "VRService",
	"HapticService", "AnalyticsService", "ProximityPromptService", "PathfindingService", "AssetService", "GroupService",
	"InsertService", "LogService", "TestService", "AvatarEditorService", "ExperienceNotificationService",
}

local function prepare()
	for _, name in SERVICES do
		pcall(game.GetService, game, name)
	end
	local starterPlayer = game:FindFirstChildOfClass("StarterPlayer")
	if starterPlayer then
		for _, name in { "StarterPlayerScripts", "StarterCharacterScripts" } do
			if not starterPlayer:FindFirstChild(name) then
				local ok, inst = pcall(Instance.new, name)
				if ok then
					inst.Parent = starterPlayer
				end
			end
		end
	end
	-- the place's ids have no value outside a server; a setup file sets real ones
	for prop, value in { PlaceId = 0, GameId = 0, JobId = "quack-test", CreatorId = 0, PlaceVersion = 0, PrivateServerId = "", PrivateServerOwnerId = 0 } do
		pcall(function()
			game[prop] = value
		end)
	end
end

-- Scripts on disk the tree does not hold (made since the sourcemap, or a worktree's new file)
-- go in; scripts of sync/ the disk no longer has go out
local function applyPresent(present)
	if not present then
		return
	end
	local want = {}
	for _, p in present do
		want[p.rel] = p
	end
	local gone = {}
	for inst, rel in fileOf do
		if string.sub(rel, 1, 5) == "sync/" and not want[rel] then
			table.insert(gone, inst)
		end
	end
	for _, inst in gone do
		byFile[fileOf[inst]] = nil
		fileOf[inst] = nil
		pcall(inst.Destroy, inst)
	end
	for rel, p in want do
		if byFile[rel] then
			continue
		end
		local parent = game
		for i = 1, #p.parts - 1 do
			local name = p.parts[i]
			local child = parent:FindFirstChild(name)
			if not child and parent == game then
				local ok, service = pcall(game.GetService, game, name)
				child = if ok then service else nil
			end
			if not child then
				child = Instance.new("Folder")
				child.Name = name
				child.Parent = parent
			end
			parent = child
		end
		local name = p.parts[#p.parts]
		local existing = parent:FindFirstChild(name)
		local inst
		if existing and existing.ClassName == p.className and not fileOf[existing] then
			inst = existing
		else
			inst = Instance.new(p.className)
			inst.Name = name
			inst.Parent = parent
		end
		fileOf[inst] = rel
		byFile[rel] = inst
	end
end

-- ---------------------------------------------------------------------------------------------
-- Start: the tree, then the pieces of a play that need it

local built, scriptCount = loadTree()
prepare()
ctx.game = game

local Signal = require("./signal")(function(r, fn, ...)
	ctx.realm.spawnIn(r, fn, ...)
end, function()
	return ctx.realm.current()
end)
ctx.Signal = Signal
ctx.realm = require("./realm")(ctx)
ctx.datatypes = require("./datatypes")(roblox.Enum, roblox.Vector3)
ctx.stores = require("./stores")(ctx)
local network = require("./roblox")(ctx)
local expect = require("./expect")(ctx)

local count = 0
for _ in game:GetDescendants() do
	count += 1
end
stdio.write(READY .. serde.encode("json", { ms = math.floor((os.clock() - started) * 1000), instances = count, scripts = scriptCount, built = built }) .. "\n")

-- ---------------------------------------------------------------------------------------------
-- The environment the game's modules and the specs run in

local realm = ctx.realm
local root -- the project folder whose files are read (a worktree's own)
local clockStart = os.clock()

local function cleanError(e: any): any
	if typeof(e) == "error" then
		return ctx.message(e)
	end
	if type(e) == "table" and e.__quackFailure then
		-- a failure a module raised, now caught by the game: the game sees its text
		return e.message
	end
	return e
end

local function pcallx(fn, ...)
	local result = table.pack(pcall(fn, ...))
	if not result[1] then
		return false, cleanError(result[2])
	end
	return table.unpack(result, 1, result.n)
end

local function xpcallx(fn, handler, ...)
	return xpcall(fn, function(e)
		return handler(cleanError(e))
	end, ...)
end

local InstanceApi = {
	new = function(className: string, parent: any?)
		local inst = Instance.new(className)
		if ctx.instanceDefaults then
			ctx.instanceDefaults(inst)
		end
		if parent then
			inst.Parent = parent
		end
		return inst
	end,
	fromExisting = function(existing)
		return existing:Clone()
	end,
}

local bases = {}
local function base(r: string)
	if bases[r] then
		return bases[r]
	end
	local b = {}
	for key, value in roblox do
		if string.match(key, "^%u") then
			b[key] = value
		end
	end
	for key, value in ctx.datatypes do
		b[key] = value
	end
	b.Instance = InstanceApi
	b.game = game
	b.Game = game
	b.workspace = game:GetService("Workspace")
	b.Workspace = b.workspace
	b.task = realm.task
	b.coroutine = realm.coroutine
	b.wait = function(seconds)
		return realm.task.wait(seconds), os.clock() - clockStart
	end
	b.delay = function(seconds, fn)
		realm.task.delay(seconds, fn)
	end
	b.spawn = function(fn)
		realm.task.defer(fn)
	end
	b.tick = function()
		return LuneDateTime.now().unixTimestampMillis / 1000
	end
	b.time = function()
		return os.clock() - clockStart
	end
	b.elapsedTime = b.time
	b.version = function()
		return "0.0.0.0"
	end
	b.printidentity = function() end
	for _, name in { "settings", "UserSettings", "stats", "PluginManager", "DebuggerManager" } do
		b[name] = function()
			ctx.outside(`{name}()`)
		end
	end
	b.typeof = ctx.typeof
	b.print = function(...)
		ctx.output("print", joined(...))
	end
	b.warn = function(...)
		ctx.output("warn", joined(...))
	end
	b.pcall = pcallx
	b.xpcall = xpcallx
	b.shared = {}
	b._G = {}
	bases[r] = b
	return b
end

local api -- require("@quack/test")
local requireFor

local function envFor(r: string, script: any, from: any)
	local env = table.clone(base(r))
	env.script = script
	env.require = requireFor(from)
	return env
end

local function compile(rel: string, file: string, env)
	local ok, source = pcall(fs.readFile, file)
	if not ok then
		ctx.outside(`{rel} is not on disk`)
	end
	userChunks[rel] = true
	return luau.load(source, { debugName = "=" .. rel, environment = env })
end

local loaded = { server = {}, client = {} }

-- One module's value in the calling realm, loaded once; another thread asking while it loads
-- waits for it, as Roblox's require does
local function loadOnce(key: any, r: string, run: () -> any)
	local cache = loaded[r]
	local entry = cache[key]
	if entry then
		if entry.state == "loading" then
			if entry.thread == coroutine.running() then
				error("Requested module was required recursively", 0)
			end
			local deadline = os.clock() + ctx.waitTimeout * 5
			while entry.state == "loading" and os.clock() < deadline do
				task.wait()
			end
			if entry.state == "loading" then
				error("Requested module never finished loading (it waits on something this run does not have)", 0)
			end
		end
		if entry.state == "error" then
			error(entry.err, 0)
		end
		return entry.value
	end
	entry = { state = "loading", thread = coroutine.running() }
	cache[key] = entry
	local ok, value = xpcall(run, ctx.capture)
	if not ok then
		entry.state = "error"
		entry.err = value
		error(value, 0)
	end
	entry.state = "ok"
	entry.value = value
	return value
end

local function oneValue(chunk)
	local values = table.pack(chunk())
	if values.n ~= 1 then
		error("Module code did not return exactly one value", 0)
	end
	return values[1]
end

local function requireModule(module)
	local r = realm.current()
	return loadOnce(module, r, function()
		local rel = fileOf[module]
		if not rel then
			ctx.outside(`{module:GetFullName()} has no file on disk (only Studio has its text)`)
		end
		return oneValue(compile(rel, `{root}/{rel}`, envFor(r, module, { instance = module })))
	end)
end

-- A spec's own helper module, or the setup file: a file of tests/, outside the game's tree
local function requireFile(file: string, rel: string)
	local r = realm.current()
	return loadOnce("file:" .. file, r, function()
		local script = Instance.new("ModuleScript")
		script.Name = string.match(rel, "([^/]+)%.luau?$") or rel
		return oneValue(compile(rel, file, envFor(r, script, { file = file, rel = rel })))
	end)
end

local function dirOf(path: string): string
	return string.match(path, "^(.*)/[^/]*$") or "."
end

local function resolveFile(from, spec: string)
	local base = dirOf((string.gsub(from.file, "\\", "/")))
	local relBase = dirOf(from.rel)
	local parts = string.split(spec, "/")
	local path, rel = base, relBase
	for i, part in parts do
		if part == "." then
			continue
		elseif part == ".." then
			path, rel = dirOf(path), dirOf(rel)
		else
			path ..= "/" .. part
			rel ..= "/" .. part
		end
	end
	for _, suffix in { ".luau", ".lua", "/init.luau", "/init.lua" } do
		if fs.isFile(path .. suffix) then
			return path .. suffix, rel .. suffix
		end
	end
	return nil
end

-- Roblox's require by string: "./X" a sibling, "../X" the parent's sibling, "@self/X" a child,
-- "@game/Service/X" from the DataModel
local function resolveInstance(script, spec: string)
	local parts = string.split(spec, "/")
	local node
	local first = parts[1]
	if first == "@self" then
		node = script
	elseif first == "@game" then
		node = game
	elseif first == "." then
		node = script.Parent
	elseif first == ".." then
		node = script.Parent and script.Parent.Parent
	else
		return nil
	end
	for i = 2, #parts do
		if not node then
			return nil
		end
		local part = parts[i]
		if part == ".." then
			node = node.Parent
		elseif part ~= "." and part ~= "" then
			node = node:FindFirstChild(part)
		end
	end
	return node
end

requireFor = function(from)
	return function(target)
		if typeof(target) == "Instance" then
			if not target:IsA("ModuleScript") then
				error(`Attempted to call require with invalid argument(s): {target:GetFullName()} is a {target.ClassName}, not a ModuleScript`, 2)
			end
			return requireModule(target)
		end
		if type(target) == "number" then
			ctx.outside(`require({target}): a module by asset id loads only in Roblox`)
		end
		if type(target) ~= "string" then
			error("Attempted to call require with invalid argument(s).", 2)
		end
		if target == "@quack/test" then
			return api
		end
		if from.file then
			local file, rel = resolveFile(from, target)
			if not file then
				error(`require("{target}"): no file {target}.luau next to {from.rel}`, 2)
			end
			return requireFile(file, rel)
		end
		local inst = resolveInstance(from.instance, target)
		if not inst then
			error(`require("{target}"): no module there from {from.instance:GetFullName()}`, 2)
		end
		return requireModule(inst)
	end
end

api = {
	expect = expect,
	network = network,
	-- The data stores, emptied before each test; a test may empty them again
	resetData = ctx.stores.reset,
}

-- ---------------------------------------------------------------------------------------------
-- A run

local function where(traceback: string?, rels: { [string]: boolean }?): string?
	if not traceback then
		return nil
	end
	for line in string.gmatch(traceback, "[^\n]+") do
		local chunk, n = string.match(line, "^%s*(.-):(%d+)")
		if chunk and (rels or userChunks)[chunk] then
			return `{chunk}:{n}`
		end
	end
	return nil
end

local function specLine(traceback: string?, rel: string): number?
	if not traceback then
		return nil
	end
	for line in string.gmatch(traceback, "[^\n]+") do
		local chunk, n = string.match(line, "^%s*(.-):(%d+)")
		if chunk == rel then
			return tonumber(n)
		end
	end
	return nil
end

-- The failure a message came from: the earliest captured one whose text the final message holds
local function innermost(record)
	for _, r in recent do
		if r ~= record and r.message ~= "" and string.find(record.message, r.message, 1, true) then
			return r
		end
	end
	return record
end

local function describe(record, rel: string)
	local inner = innermost(record)
	return {
		message = record.message,
		expect = record.expect or nil,
		line = specLine(record.traceback, rel) or specLine(inner.traceback, rel),
		where = where(inner.traceback) or where(record.traceback),
	}
end

local function runTest(fn, timeout: number)
	local done, ok, err = false, false, nil
	local thread = coroutine.create(function()
		local success, failure = xpcall(fn, ctx.capture)
		done, ok, err = true, success, failure
	end)
	task.spawn(thread)
	local deadline = os.clock() + timeout
	while not done and os.clock() < deadline do
		task.wait()
	end
	if not done then
		local stack = debug.traceback(thread)
		task.cancel(thread)
		return false, { __quackFailure = true, message = `timed out after {timeout} s`, traceback = stack, timeout = true }
	end
	return ok, err
end

local function matches(name: string, filters): boolean
	if not filters or #filters == 0 then
		return true
	end
	for _, f in filters do
		if string.find(string.lower(name), string.lower(f), 1, true) then
			return true
		end
	end
	return false
end

local function takeOutput()
	local out = output
	output = {}
	return out
end

local function threadTexts()
	local out = {}
	for _, e in threadErrors do
		table.insert(out, e.text)
	end
	return out
end

-- A sign of life for the process waiting on this one: a test (or the setup, or a spec's load) ended
local function progress()
	stdio.write(PROGRESS .. "\n")
end

local function run(request)
	root = string.gsub(request.root, "\\", "/")
	ctx.waitTimeout = request.waitTimeout or ctx.waitTimeout
	applyPresent(request.present)
	local result = { specs = {}, setup = nil }
	local runStarted = os.clock()

	if request.setup then
		recent, threadErrors = {}, {}
		local ok, err = runTest(function()
			requireFile(request.setup.file, request.setup.rel)
		end, request.testTimeout or 10)
		local failure = if ok then nil else describe(err, request.setup.rel)
		result.setup = { rel = request.setup.rel, ok = ok, failure = failure, output = takeOutput(), threads = threadTexts() }
		progress()
		if not ok then
			result.ms = math.floor((os.clock() - runStarted) * 1000)
			return result
		end
	end

	for _, spec in request.specs do
		local entry = { rel = spec.rel, name = spec.name, tests = {} }
		table.insert(result.specs, entry)
		recent, threadErrors = {}, {}
		ctx.stores.reset()
		local value
		local loadedOk, tests = runTest(function()
			value = requireFile(spec.file, spec.rel)
		end, request.testTimeout or 10)
		if loadedOk and type(value) ~= "table" then
			loadedOk = false
			tests = { __quackFailure = true, message = "a spec returns a table of { [\"test name\"] = function() ... end }", traceback = "" }
		end
		progress()
		if not loadedOk then
			entry.load = describe(tests, spec.rel)
			entry.load.output = takeOutput()
			entry.load.threads = threadTexts()
			continue
		end
		takeOutput()
		local names = {}
		for name in value do
			table.insert(names, name)
		end
		table.sort(names, function(a, b)
			return tostring(a) < tostring(b)
		end)
		for _, name in names do
			local full = `{spec.name} › {tostring(name)}`
			if not matches(full, request.filter) then
				continue
			end
			local fn = value[name]
			recent, threadErrors = {}, {}
			ctx.stores.reset()
			local t0 = os.clock()
			local ok, err
			if type(fn) ~= "function" then
				ok, err = false, { __quackFailure = true, message = "a test is a function", traceback = "" }
			else
				ok, err = runTest(fn, request.testTimeout or 10)
			end
			-- an error in a thread the test started (a remote's handler, a spawned task) fails it
			if ok and #threadErrors > 0 then
				ok = false
				err = threadErrors[1].record or { __quackFailure = true, message = threadErrors[1].text, traceback = "" }
			end
			local row = { name = tostring(name), ok = ok, ms = math.floor((os.clock() - t0) * 10000) / 10 }
			if not ok then
				row.failure = describe(err, spec.rel)
				row.failure.timeout = err.timeout or nil
				row.threads = threadTexts()
			end
			-- what it printed, a passed test's too (the verbose report lists it)
			local printed = takeOutput()
			if #printed > 0 then
				row.output = printed
			end
			table.insert(entry.tests, row)
			progress()
		end
	end
	result.ms = math.floor((os.clock() - runStarted) * 1000)
	return result
end

-- ---------------------------------------------------------------------------------------------
-- Wait for the one request (a line of JSON); stdin closed first ends the process

local line = stdio.readLine()
if line == nil or line == "" then
	process.exit(0)
end
local request = serde.decode("json", line)
local ok, result = pcall(run, request)
if not ok then
	result = { crashed = ctx.message(result) }
end
stdio.write("\n" .. RESULT .. serde.encode("json", result) .. "\n")
process.exit(0)
