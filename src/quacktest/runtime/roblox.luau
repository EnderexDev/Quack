--!nocheck
-- Quack Test: what a play has and Lune's instances lack, added with roblox.implementMethod and
-- implementProperty. Lune never lets these replace a member it has (measured 23/11/26), so only
-- missing members are added. Nothing here knows any particular game.
--
--  - The frames: Heartbeat and the other RunService events tick from one loop, started when a
--    run starts.
--  - Change signals (Changed, AttributeChanged, ChildAdded...): Lune has no hook on a property
--    write, so each signal compares what it watches once a frame, and only while something is
--    connected to it. It fires a frame later than the write, as deferred signals do.
--  - The network: one simulated player, joined the first time client code runs, with remotes
--    between the realms delivered a frame later with their arguments copied. The design follows
--    LuneTest's simulated network (MIT, Austin Barikdar; see NOTICE.md).
--  - Services: Players, RunService, HttpService, CollectionService, TweenService, Debris,
--    Bindables, the data stores (stores.luau); an engine-only setting (collision groups, the
--    core GUI) is accepted and does nothing. What gives the game data only Roblox has (physics,
--    the web, purchases) is left missing: the run says it did not run outside Studio.

local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local task = require("@lune/task")

return function(ctx)
	local Instance = roblox.Instance
	local Signal = ctx.Signal
	local realm = ctx.realm
	local outside = ctx.outside
	local game = ctx.game
	local Enum = roblox.Enum
	local implementMethod, implementProperty = roblox.implementMethod, roblox.implementProperty

	-- -------------------------------------------------------------------------------------------
	-- Frames

	local frameSignals = {}
	local watchers = {}
	local renderSteps = {}
	local started = false
	local frameCount = 0
	local clock = 0

	local function frameSignal(name: string)
		frameSignals[name] = frameSignals[name] or Signal.new()
		return frameSignals[name]
	end

	local function tick(dt: number)
		frameCount += 1
		clock += dt
		for _, step in table.clone(renderSteps) do
			realm.spawnIn(step.realm, step.fn, dt)
		end
		for _, name in { "PreRender", "RenderStepped", "PreAnimation", "PreSimulation" } do
			if frameSignals[name] then
				frameSignals[name]:Fire(dt)
			end
		end
		if frameSignals.Stepped then
			frameSignals.Stepped:Fire(clock, dt)
		end
		for _, name in { "PostSimulation", "Heartbeat" } do
			if frameSignals[name] then
				frameSignals[name]:Fire(dt)
			end
		end
		for _, watch in table.clone(watchers) do
			local ok, err = pcall(watch)
			if not ok then
				ctx.threadError(`a change signal's check failed: {ctx.message(err)}`, err)
			end
		end
	end

	function ctx.startFrames()
		if started then
			return
		end
		started = true
		task.spawn(function()
			local last = os.clock()
			while true do
				task.wait()
				local now = os.clock()
				tick(now - last)
				last = now
			end
		end)
	end

	function ctx.frames(): number
		return frameCount
	end

	-- -------------------------------------------------------------------------------------------
	-- Change signals on instances

	local instanceSignals = setmetatable({}, { __mode = "k" })

	-- One signal per instance and key; its check starts with its first connection
	local function watched(inst, key: string, makeCheck: (signal: any) -> () -> (), every: number?)
		local byKey = instanceSignals[inst]
		if not byKey then
			byKey = {}
			instanceSignals[inst] = byKey
		end
		local signal = byKey[key]
		if not signal then
			signal = Signal.new({
				onFirstConnect = function()
					local check = makeCheck(signal)
					local n = 0
					table.insert(watchers, function()
						n += 1
						if signal:HasConnections() and n % (every or 1) == 0 then
							check()
						end
					end)
					ctx.startFrames()
				end,
			})
			byKey[key] = signal
		end
		return signal
	end

	local function inert(inst, key: string)
		local byKey = instanceSignals[inst]
		if not byKey then
			byKey = {}
			instanceSignals[inst] = byKey
		end
		byKey[key] = byKey[key] or Signal.new()
		return byKey[key]
	end

	local function read(inst, prop: string)
		local ok, value = pcall(function()
			return inst[prop]
		end)
		return if ok then value else nil
	end

	local function setOf(list)
		local s = {}
		for _, item in list do
			s[item] = true
		end
		return s
	end

	local function changes(signal, now, before)
		for item in now do
			if not before[item] then
				signal:Fire(item)
			end
		end
	end

	implementProperty("Instance", "Changed", function(self)
		return watched(self, "Changed", function(signal)
			if self:IsA("ValueBase") then
				local last = read(self, "Value")
				return function()
					local value = read(self, "Value")
					if value ~= last then
						last = value
						signal:Fire(value)
					end
				end
			end
			local name, parent = self.Name, self.Parent
			return function()
				if self.Name ~= name then
					name = self.Name
					signal:Fire("Name")
				end
				if self.Parent ~= parent then
					parent = self.Parent
					signal:Fire("Parent")
				end
			end
		end)
	end)

	implementMethod("Instance", "GetPropertyChangedSignal", function(self, prop: string)
		return watched(self, `prop:{prop}`, function(signal)
			local last = read(self, prop)
			return function()
				local value = read(self, prop)
				if value ~= last then
					last = value
					signal:Fire()
				end
			end
		end)
	end)

	implementProperty("Instance", "AttributeChanged", function(self)
		return watched(self, "AttributeChanged", function(signal)
			local last = self:GetAttributes()
			return function()
				local now = self:GetAttributes()
				for name, value in now do
					if last[name] ~= value then
						signal:Fire(name)
					end
				end
				for name in last do
					if now[name] == nil then
						signal:Fire(name)
					end
				end
				last = now
			end
		end)
	end)

	implementMethod("Instance", "GetAttributeChangedSignal", function(self, name: string)
		return watched(self, `attr:{name}`, function(signal)
			local last = self:GetAttribute(name)
			return function()
				local value = self:GetAttribute(name)
				if value ~= last then
					last = value
					signal:Fire()
				end
			end
		end)
	end)

	local function membership(key: string, list: (inst: any) -> { any }, removed: boolean, every: number?)
		implementProperty("Instance", key, function(self)
			return watched(self, key, function(signal)
				local last = setOf(list(self))
				return function()
					local now = setOf(list(self))
					if removed then
						changes(signal, last, now)
					else
						changes(signal, now, last)
					end
					last = now
				end
			end, every)
		end)
	end
	membership("ChildAdded", function(i)
		return i:GetChildren()
	end, false)
	membership("ChildRemoved", function(i)
		return i:GetChildren()
	end, true)
	-- a whole subtree is compared: every few frames, not every one
	membership("DescendantAdded", function(i)
		return i:GetDescendants()
	end, false, 5)
	membership("DescendantRemoving", function(i)
		return i:GetDescendants()
	end, true, 5)

	implementProperty("Instance", "AncestryChanged", function(self)
		return watched(self, "AncestryChanged", function(signal)
			local parent, full = self.Parent, self:GetFullName()
			return function()
				local nowParent, nowFull = self.Parent, self:GetFullName()
				if nowParent ~= parent or nowFull ~= full then
					parent, full = nowParent, nowFull
					signal:Fire(self, nowParent)
				end
			end
		end)
	end)

	-- Lune cannot tell a Destroy from a Parent set to nil: never fired
	implementProperty("Instance", "Destroying", function(self)
		return inert(self, "Destroying")
	end)

	-- A child made by another script (or the other realm) a frame later is found; one the tree
	-- never gets is a piece of the play this run does not have
	implementMethod("Instance", "WaitForChild", function(self, name: string, timeout: number?)
		local found = self:FindFirstChild(name)
		if found then
			return found
		end
		local limit = timeout or ctx.waitTimeout
		local deadline = os.clock() + limit
		while not found and os.clock() < deadline do
			task.wait()
			found = self:FindFirstChild(name)
		end
		if not found and not timeout then
			outside(`{self:GetFullName()}:WaitForChild("{name}"): no such child after {limit} s (made during the play? make it in tests/setup.luau)`)
		end
		return found
	end)

	-- -------------------------------------------------------------------------------------------
	-- Bindables

	implementProperty("BindableEvent", "Event", function(self)
		return inert(self, "Event")
	end)
	implementMethod("BindableEvent", "Fire", function(self, ...)
		inert(self, "Event"):Fire(...)
	end)

	local callbacks = setmetatable({}, { __mode = "k" })
	local function callbackProperty(className: string, name: string)
		implementProperty(className, name, function(self)
			local c = callbacks[self] and callbacks[self][name]
			return c and c.fn
		end, function(self, fn)
			callbacks[self] = callbacks[self] or {}
			callbacks[self][name] = if fn then { fn = fn, realm = realm.current() } else nil
		end)
	end
	callbackProperty("BindableFunction", "OnInvoke")
	implementMethod("BindableFunction", "Invoke", function(self, ...)
		local deadline = os.clock() + ctx.waitTimeout
		while not (callbacks[self] and callbacks[self].OnInvoke) and os.clock() < deadline do
			task.wait()
		end
		local c = callbacks[self] and callbacks[self].OnInvoke
		if not c then
			outside(`{self:GetFullName()}:Invoke(): OnInvoke was never set`)
		end
		return c.fn(...)
	end)

	-- -------------------------------------------------------------------------------------------
	-- The network: one player, remotes between the realms

	local Players = game:GetService("Players")
	local playerAdded, playerRemoving = Signal.new(), Signal.new()
	local player = nil
	local spies = setmetatable({}, { __mode = "k" })

	local function record(remote, direction: string, args)
		local log = spies[remote]
		if log then
			table.insert(log, { direction = direction, args = { table.unpack(args, 1, args.n) } })
		end
	end

	-- Roblox copies what crosses the network: tables lose their metatables, buffers are copied
	local function copy(value: any): any
		if type(value) == "table" then
			local out = {}
			for k, v in value do
				out[copy(k)] = copy(v)
			end
			return out
		elseif type(value) == "buffer" then
			local out = buffer.create(buffer.len(value))
			buffer.copy(out, 0, value)
			return out
		elseif type(value) == "function" then
			return nil
		end
		return value
	end
	local function copyArgs(...)
		local args = table.pack(...)
		for i = 1, args.n do
			args[i] = copy(args[i])
		end
		return args
	end

	local function set(inst, props)
		for k, v in props do
			pcall(function()
				inst[k] = v
			end)
		end
	end

	-- A new Humanoid has no value for some properties in Lune: Roblox's defaults
	local function humanoidDefaults(h)
		set(h, { Health = 100, MaxHealth = 100, WalkSpeed = 16, JumpPower = 50, JumpHeight = 7.2, UseJumpPower = false, HipHeight = 2, AutoRotate = true })
	end
	ctx.instanceDefaults = function(inst)
		if inst:IsA("Humanoid") then
			humanoidDefaults(inst)
		end
	end

	local function spawnCharacter(p)
		local old = p.Character
		if old then
			inert(p, "CharacterRemoving"):Fire(old)
			old.Parent = nil
		end
		local character = Instance.new("Model")
		character.Name = p.Name
		local root = Instance.new("Part")
		root.Name = "HumanoidRootPart"
		root.Parent = character
		local head = Instance.new("Part")
		head.Name = "Head"
		head.Parent = character
		local humanoid = Instance.new("Humanoid")
		humanoidDefaults(humanoid)
		humanoid.Parent = character
		character.PrimaryPart = root
		character.Parent = game:GetService("Workspace")
		p.Character = character
		inert(p, "CharacterAdded"):Fire(character)
		inert(p, "CharacterAppearanceLoaded"):Fire(character)
		return character
	end

	-- The simulated player joins the first time client code runs, as Roblox makes one: its
	-- PlayerGui (StarterGui's screens copied in), Backpack, PlayerScripts and a character
	local function ensurePlayer()
		if player then
			return player
		end
		player = Instance.new("Player")
		player.Name = "Player1"
		set(player, { UserId = 1, DisplayName = "Player1", AccountAge = 0 })
		local gui = Instance.new("PlayerGui")
		gui.Parent = player
		local starterGui = game:FindFirstChildOfClass("StarterGui")
		if starterGui then
			for _, child in starterGui:GetChildren() do
				if not child:IsA("Script") then
					local ok, clone = pcall(child.Clone, child)
					if ok and clone then
						clone.Parent = gui
					end
				end
			end
		end
		Instance.new("Backpack").Parent = player
		local scripts = Instance.new("PlayerScripts")
		scripts.Parent = player
		player.Parent = Players
		Players.LocalPlayer = player
		playerAdded:Fire(player)
		spawnCharacter(player)
		return player
	end
	ctx.ensurePlayer = ensurePlayer

	local remoteSignals = setmetatable({}, { __mode = "k" })
	local function remoteSignal(remote, name: string)
		remoteSignals[remote] = remoteSignals[remote] or {}
		local s = remoteSignals[remote][name]
		if not s then
			s = Signal.new({ queue = true })
			remoteSignals[remote][name] = s
		end
		return s
	end

	for _, class in { "RemoteEvent", "UnreliableRemoteEvent" } do
		implementProperty(class, "OnServerEvent", function(self)
			return remoteSignal(self, "OnServerEvent")
		end)
		implementProperty(class, "OnClientEvent", function(self)
			return remoteSignal(self, "OnClientEvent")
		end)
		implementMethod(class, "FireServer", function(self, ...)
			if realm.current() ~= "client" then
				error("FireServer can only be called from the client", 2)
			end
			local args = copyArgs(...)
			record(self, "toServer", args)
			local from = ensurePlayer()
			ctx.startFrames()
			task.defer(function()
				remoteSignal(self, "OnServerEvent"):Fire(from, table.unpack(args, 1, args.n))
			end)
		end)
		local function toClient(self, args)
			record(self, "toClient", args)
			ctx.startFrames()
			task.defer(function()
				remoteSignal(self, "OnClientEvent"):Fire(table.unpack(args, 1, args.n))
			end)
		end
		implementMethod(class, "FireClient", function(self, target, ...)
			if realm.current() ~= "server" then
				error("FireClient can only be called from the server", 2)
			end
			if target == player then
				toClient(self, copyArgs(...))
			end
		end)
		implementMethod(class, "FireAllClients", function(self, ...)
			if realm.current() ~= "server" then
				error("FireAllClients can only be called from the server", 2)
			end
			if player then
				toClient(self, copyArgs(...))
			end
		end)
	end

	callbackProperty("RemoteFunction", "OnServerInvoke")
	callbackProperty("RemoteFunction", "OnClientInvoke")
	local function invoke(self, name: string, direction: string, args, ...)
		record(self, direction, args)
		local deadline = os.clock() + ctx.waitTimeout
		while not (callbacks[self] and callbacks[self][name]) and os.clock() < deadline do
			task.wait()
		end
		local c = callbacks[self] and callbacks[self][name]
		if not c then
			outside(`{self:GetFullName()}.{name} was never set`)
		end
		local prefix = table.pack(...)
		local all = table.move(args, 1, args.n, prefix.n + 1, table.clone(prefix))
		local result = table.pack(realm.runAs(c.realm, c.fn, table.unpack(all, 1, prefix.n + args.n)))
		local returned = copyArgs(table.unpack(result, 1, result.n))
		return table.unpack(returned, 1, returned.n)
	end
	implementMethod("RemoteFunction", "InvokeServer", function(self, ...)
		if realm.current() ~= "client" then
			error("InvokeServer can only be called from the client", 2)
		end
		return invoke(self, "OnServerInvoke", "toServer", copyArgs(...), ensurePlayer())
	end)
	implementMethod("RemoteFunction", "InvokeClient", function(self, target, ...)
		if realm.current() ~= "server" then
			error("InvokeClient can only be called from the server", 2)
		end
		if target ~= player then
			error("InvokeClient: the player is not in the game", 2)
		end
		return invoke(self, "OnClientInvoke", "toClient", copyArgs(...))
	end)

	-- -------------------------------------------------------------------------------------------
	-- Players

	implementProperty("Players", "PlayerAdded", function()
		return playerAdded
	end)
	implementProperty("Players", "PlayerRemoving", function()
		return playerRemoving
	end)
	implementMethod("Players", "GetPlayers", function()
		return if player and player.Parent then { player } else {}
	end)
	implementMethod("Players", "GetPlayerByUserId", function(_, userId)
		return if player and player.Parent and player.UserId == userId then player else nil
	end)
	implementMethod("Players", "GetPlayerFromCharacter", function(_, character)
		return if player and character ~= nil and player.Character == character then player else nil
	end)
	for _, name in { "CharacterAdded", "CharacterRemoving", "CharacterAppearanceLoaded", "Idled", "Chatted" } do
		implementProperty("Player", name, function(self)
			return inert(self, name)
		end)
	end
	implementMethod("Player", "LoadCharacter", function(self)
		spawnCharacter(self)
	end)
	implementMethod("Player", "Kick", function(self, message)
		ctx.output("info", `{self.Name} was kicked: {tostring(message or "")}`)
		if self.Parent then
			playerRemoving:Fire(self)
			self.Parent = nil
		end
	end)
	-- A plain player of the game: in no group, nobody's friend
	implementMethod("Player", "GetRankInGroup", function()
		return 0
	end)
	implementMethod("Player", "GetRoleInGroup", function()
		return "Guest"
	end)
	implementMethod("Player", "IsInGroup", function()
		return false
	end)
	implementMethod("Player", "IsFriendsWith", function()
		return false
	end)
	implementMethod("Player", "HasAppearanceLoaded", function()
		return true
	end)
	implementMethod("Player", "GetJoinData", function()
		return {}
	end)

	-- -------------------------------------------------------------------------------------------
	-- RunService

	implementMethod("RunService", "IsServer", function()
		return realm.current() == "server"
	end)
	implementMethod("RunService", "IsClient", function()
		return realm.current() == "client"
	end)
	for name, value in { IsStudio = true, IsRunning = true, IsEdit = false, IsRunMode = false } do
		implementMethod("RunService", name, function()
			return value
		end)
	end
	for _, name in { "Heartbeat", "Stepped", "RenderStepped", "PreRender", "PreAnimation", "PreSimulation", "PostSimulation" } do
		implementProperty("RunService", name, function()
			ctx.startFrames()
			return frameSignal(name)
		end)
	end
	implementMethod("RunService", "BindToRenderStep", function(_, name, priority, fn)
		table.insert(renderSteps, { name = name, priority = priority, fn = fn, realm = realm.current() })
		table.sort(renderSteps, function(a, b)
			return a.priority < b.priority
		end)
		ctx.startFrames()
	end)
	implementMethod("RunService", "UnbindFromRenderStep", function(_, name)
		for i = #renderSteps, 1, -1 do
			if renderSteps[i].name == name then
				table.remove(renderSteps, i)
			end
		end
	end)

	-- -------------------------------------------------------------------------------------------
	-- HttpService (no web), CollectionService, TweenService, Debris and the engine's settings

	implementMethod("HttpService", "JSONEncode", function(_, value)
		return serde.encode("json", value)
	end)
	implementMethod("HttpService", "JSONDecode", function(_, text)
		return serde.decode("json", text)
	end)
	local guids = ctx.datatypes.Random.new()
	implementMethod("HttpService", "GenerateGUID", function(_, wrap)
		local hex = string.gsub("xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx", "[xy]", function(c)
			local v = if c == "x" then guids:NextInteger(0, 15) else guids:NextInteger(8, 11)
			return string.format("%X", v)
		end)
		return if wrap == false then hex else `\{{hex}\}`
	end)
	implementMethod("HttpService", "UrlEncode", function(_, text)
		return (string.gsub(text, "[^%w%-_%.~]", function(c)
			return string.format("%%%02X", string.byte(c))
		end))
	end)

	local tagSignals = {}
	implementMethod("CollectionService", "GetTagged", function(_, tag)
		local out = {}
		for _, d in game:GetDescendants() do
			if d:HasTag(tag) then
				table.insert(out, d)
			end
		end
		return out
	end)
	implementMethod("CollectionService", "GetAllTags", function()
		local seen, out = {}, {}
		for _, d in game:GetDescendants() do
			for _, tag in d:GetTags() do
				if not seen[tag] then
					seen[tag] = true
					table.insert(out, tag)
				end
			end
		end
		return out
	end)
	-- Lune cannot see a tag being added: these never fire (GetTagged reads the tags as they are)
	for _, name in { "GetInstanceAddedSignal", "GetInstanceRemovedSignal" } do
		implementMethod("CollectionService", name, function(_, tag)
			local key = `{name}:{tag}`
			tagSignals[key] = tagSignals[key] or Signal.new()
			return tagSignals[key]
		end)
	end

	local TweenMeta = {}
	TweenMeta.__index = TweenMeta
	TweenMeta.__type = "Tween"
	-- A tween ends at once: its goals are set when it plays, Completed fires a frame later
	function TweenMeta:Play()
		for prop, value in self._goals do
			self.Instance[prop] = value
		end
		self.PlaybackState = Enum.PlaybackState.Completed
		ctx.startFrames()
		task.defer(function()
			self.Completed:Fire(Enum.PlaybackState.Completed)
		end)
	end
	function TweenMeta:Pause()
		self.PlaybackState = Enum.PlaybackState.Paused
	end
	function TweenMeta:Cancel()
		self.PlaybackState = Enum.PlaybackState.Cancelled
	end
	function TweenMeta:Destroy() end
	implementMethod("TweenService", "Create", function(_, inst, info, goals)
		return setmetatable({ Instance = inst, TweenInfo = info, _goals = goals, PlaybackState = Enum.PlaybackState.Begin, Completed = Signal.new() }, TweenMeta)
	end)

	implementMethod("Debris", "AddItem", function(_, item, lifetime)
		task.delay(lifetime or 10, function()
			pcall(item.Destroy, item)
		end)
	end)

	local function accepts(className: string, names: { string }, answer: any?)
		for _, name in names do
			implementMethod(className, name, function()
				return answer
			end)
		end
	end
	accepts("ContentProvider", { "PreloadAsync" })
	accepts("PhysicsService", { "RegisterCollisionGroup", "UnregisterCollisionGroup", "CollisionGroupSetCollidable", "RenameCollisionGroup" })
	accepts("PhysicsService", { "IsCollisionGroupRegistered", "CollisionGroupsAreCollidable" }, true)
	accepts("StarterGui", { "SetCoreGuiEnabled", "SetCore" })
	accepts("StarterGui", { "GetCoreGuiEnabled" }, true)
	implementMethod("PhysicsService", "GetRegisteredCollisionGroups", function()
		return {}
	end)
	-- The options a data store call takes: kept on the object, read back as set
	accepts("DataStoreOptions", { "SetExperimentalFeatures" })
	local metadata = setmetatable({}, { __mode = "k" })
	for _, className in { "DataStoreSetOptions", "DataStoreIncrementOptions" } do
		implementMethod(className, "SetMetadata", function(self, value)
			metadata[self] = table.clone(value or {})
		end)
		implementMethod(className, "GetMetadata", function(self)
			return table.clone(metadata[self] or {})
		end)
	end

	-- Purchases are not simulated: the game can set its receipt handler (so its module loads),
	-- and whatever asks Roblox about a purchase did not run outside Studio
	callbackProperty("MarketplaceService", "ProcessReceipt")
	for _, name in { "PromptProductPurchaseFinished", "PromptGamePassPurchaseFinished", "PromptPurchaseFinished", "PromptBundlePurchaseFinished", "PromptSubscriptionPurchaseFinished" } do
		implementProperty("MarketplaceService", name, function(self)
			return inert(self, name)
		end)
	end

	-- -------------------------------------------------------------------------------------------
	-- Data stores in memory

	local stores = ctx.stores
	for name, fn in stores.dataStoreService do
		implementMethod("DataStoreService", name, fn)
	end
	for name, fn in stores.memoryStoreService do
		implementMethod("MemoryStoreService", name, fn)
	end

	-- -------------------------------------------------------------------------------------------
	-- What a spec drives: the network as the test sees it

	return {
		client = function(fn, ...)
			ensurePlayer()
			return realm.runAs("client", fn, ...)
		end,
		server = function(fn, ...)
			return realm.runAs("server", fn, ...)
		end,
		-- Lets the remotes sent so far arrive and a few frames pass
		flush = function(frames: number?)
			ctx.startFrames()
			for _ = 1, frames or 3 do
				task.wait()
			end
			ctx.raiseThreadErrors()
		end,
		spy = function(remote)
			spies[remote] = spies[remote] or {}
			return spies[remote]
		end,
		player = function()
			return ensurePlayer()
		end,
	}
end
