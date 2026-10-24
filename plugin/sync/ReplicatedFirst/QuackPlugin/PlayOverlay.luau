--!strict
--[[
	Quack: `quackdev play`, a playtest of a git worktree's scripts.

	The place in edit mode keeps its own scripts. Studio copies the place into the play session
	a moment after the play is asked for, so the branch's scripts are swapped in, the play is
	started, and they are restored as soon as the copy is done. Measured 22/10/26: the plugin
	loads in the play session ~3.8 s after the game's scripts ran (too late to swap there), and
	the edit DataModel stalls for about a second while Studio copies it (1.1 s in the Anime
	Astral copy, 1.4 s in PA). The restore waits for the end of that stall. The play session's
	plugin then checks it really got the branch and reports it.
]]

local StudioTestService = game:GetService("StudioTestService")

local PlayOverlay = {}

-- The restore waits for the first stall above this once the edit DataModel left edit mode.
-- Measured 22/10/26: the copy's stall was 1.1 s in the Anime Astral copy and 0.75 to 1.4 s in
-- PA, while shorter stalls (up to 185 ms in PA) came before the copy: a 0.1 s threshold
-- restored at 185 ms and the play ran the place's scripts. Restoring late only holds the swap
-- longer; restoring early tests the wrong code, and the play session's check says so
local COPY_STALL_SECONDS = 0.5
-- No stall at all this long after asking: restore anyway (the play did not start)
local MAX_HOLD_SECONDS = 15
-- Marks each swapped instance with its check's number; the copy carries it into the play, where
-- the check finds the instance by it wherever the game moved it (Cmdr moves its command modules
-- to ReplicatedStorage at start: 180 checks by path failed on the Anime Astral copy, 22/10/26)
local MARK = "QuackPlayCheck"

--- FNV-1a 32 over the bytes, as 8 hex digits; the daemon computes the same (src/play/overlay.ts)
function PlayOverlay.hash(text: string): string
	local hash = 0x811c9dc5
	for i = 1, #text do
		hash = bit32.bxor(hash, string.byte(text, i))
		-- hash * 16777619 mod 2^32, without losing bits in a double: 16777619 = 2^24 + 403
		hash = (bit32.lshift(hash, 24) + hash * 403) % 4294967296
	end
	return string.format("%08x", hash)
end

local function serviceOrChild(parent: Instance, segment: string, first: boolean): Instance?
	if first then
		local ok, service = pcall(function() return game:GetService(segment) end)
		if ok and service then return service end
	end
	return parent:FindFirstChild(segment)
end

export type Result = {
	ok: boolean,
	error: string?,
	windowMs: number?,
	applied: number?,
	failed: { string }?,
	stalls: { string }?,
}

--[=[
	Swaps the branch in, starts the play, restores. Yields ~1-2 s. Outbound sync must be
	suppressed by the caller: nothing of the swap may reach the disk.
]=]
function PlayOverlay.run(message: any, guidMap: { [string]: Instance }): Result
	if not StudioTestService.EditModeActive then
		return { ok = false, error = "a playtest is already running: stop it first" }
	end

	local restore: { () -> () } = {}
	local failed: { string } = {}
	local applied = 0
	-- The checks go in the daemon's order: patches, then creates, then disables
	local checkIndex = 0
	local function mark(instance: Instance)
		checkIndex += 1
		local before = instance:GetAttribute(MARK)
		instance:SetAttribute(MARK, tostring(checkIndex))
		table.insert(restore, function() instance:SetAttribute(MARK, before) end)
	end

	for _, patch in message.patches or {} do
		local instance = guidMap[patch.guid]
		if instance and instance:IsA("LuaSourceContainer") then
			local before = (instance :: any).Source
			-- .Source, not the editor: the copy takes .Source, and an open tab keeps showing the
			-- place's text (measured 22/10/26)
			local ok, err = pcall(function() (instance :: any).Source = patch.source end)
			if ok then
				applied += 1
				table.insert(restore, function() (instance :: any).Source = before end)
				mark(instance)
			else
				table.insert(failed, `{instance:GetFullName()}: {err}`)
			end
		else
			table.insert(failed, `script {patch.guid} is not in the place any more`)
		end
	end

	for _, create in message.creates or {} do
		local ok, err = pcall(function()
			local parent: Instance = game
			for index, segment in create.parentPath do
				local nextNode = serviceOrChild(parent, segment, index == 1)
				if not nextNode then
					local folder = Instance.new("Folder")
					folder.Name = segment
					folder.Parent = parent
					-- Removed on undo even if what follows fails (a class that cannot be created)
					table.insert(restore, function() folder:Destroy() end)
					nextNode = folder
				end
				parent = nextNode :: Instance
			end
			local instance = Instance.new(create.className)
			table.insert(restore, function() instance:Destroy() end)
			instance.Name = create.name;
			(instance :: any).Source = create.source
			instance:SetAttribute(MARK, tostring(checkIndex + 1))
			instance.Parent = parent
		end)
		checkIndex += 1
		if ok then
			applied += 1
		else
			table.insert(failed, `new {create.className} {table.concat(create.parentPath, ".")}.{create.name}: {err}`)
		end
	end

	for _, disable in message.disables or {} do
		local instance = guidMap[disable.guid]
		if instance and instance:IsA("Script") then
			local script = instance :: Script
			local before = script.Enabled
			script.Enabled = false
			applied += 1
			table.insert(restore, function() script.Enabled = before end)
			mark(instance)
		else
			-- Keeps the numbering in step with the daemon's checks
			checkIndex += 1
		end
	end

	local function undo()
		for i = #restore, 1, -1 do
			pcall(restore[i])
		end
	end

	-- A play with half a branch would test something that exists nowhere
	if #failed > 0 then
		undo()
		return { ok = false, error = "the branch could not be swapped in", failed = failed, applied = applied }
	end

	local startedAt = os.clock()
	local startError: string? = nil
	task.spawn(function()
		local ok, err = pcall(function()
			return StudioTestService:ExecutePlayModeAsync({ quackPlay = { id = message.id, checks = message.checks } })
		end)
		if not ok then startError = tostring(err) end
	end)

	local copied = false
	-- Every stall above 50 ms, for the daemon log: what the rule saw when a check fails
	local stalls: { string } = {}
	-- pcall: whatever happens while it holds, the swap is restored
	local waited, waitError = pcall(function()
		local last = os.clock()
		while os.clock() - startedAt < MAX_HOLD_SECONDS do
			task.wait()
			if startError then break end
			local now = os.clock()
			if now - last > 0.05 then
				table.insert(stalls, `{math.floor((now - last) * 1000)} ms ending at {math.floor((now - startedAt) * 1000)} ms`)
			end
			if not StudioTestService.EditModeActive and now - last > COPY_STALL_SECONDS then
				copied = true
				break
			end
			last = now
		end
	end)
	undo()
	local windowMs = (os.clock() - startedAt) * 1000

	if not waited then return { ok = false, error = `restored after an error: {waitError}`, windowMs = windowMs, applied = applied } end
	if startError then return { ok = false, error = startError, windowMs = windowMs, applied = applied } end
	if not copied and not StudioTestService.EditModeActive then
		-- The play started and no stall reached the threshold (a copy too quick to stall the
		-- edit DataModel): after MAX_HOLD_SECONDS the copy is long done. The play's check decides
		return { ok = true, windowMs = windowMs, applied = applied, stalls = stalls }
	end
	if not copied then
		return {
			ok = false,
			error = `Studio did not copy the place within {MAX_HOLD_SECONDS} s; the swap was restored`,
			windowMs = windowMs,
			applied = applied,
		}
	end
	return { ok = true, windowMs = windowMs, applied = applied, stalls = stalls }
end

--- Every instance at this path: same-named siblings are all candidates
local function candidates(path: { string }): { Instance }
	local current: { Instance } = { game }
	for index, segment in path do
		local nextLevel: { Instance } = {}
		for _, parent in current do
			if index == 1 and parent == game then
				local found = serviceOrChild(game, segment, true)
				if found then table.insert(nextLevel, found) end
			else
				for _, child in parent:GetChildren() do
					if child.Name == segment then table.insert(nextLevel, child) end
				end
			end
		end
		current = nextLevel
		if #current == 0 then break end
	end
	return current
end

--[=[
	In the play session's server: the check of a `quackdev play`, or nil for an ordinary play.
	The test arguments show up a moment after the session starts, so they are polled.
]=]
function PlayOverlay.check(): { [string]: any }?
	local args: any = nil
	for _ = 1, 50 do
		local ok, value = pcall(function() return StudioTestService:GetTestArgs() end)
		if ok and value ~= nil then
			args = value
			break
		end
		task.wait(0.1)
	end
	local play = type(args) == "table" and args.quackPlay or nil
	if type(play) ~= "table" or type(play.id) ~= "string" then return nil end

	-- One pass over the place: every instance the swap marked, by its check's number
	local marked: { [string]: { Instance } } = {}
	for _, instance in game:GetDescendants() do
		local value = instance:GetAttribute(MARK)
		if type(value) == "string" then
			marked[value] = marked[value] or {}
			table.insert(marked[value], instance)
		end
	end

	local passed = 0
	local failed: { string } = {}
	-- Not found at all: the game removed it before the check ran (it loads seconds after the
	-- game's scripts), so there is nothing to check, which is not a failure
	local unverified: { string } = {}
	for index, check in play.checks or {} do
		local found: { Instance } = marked[tostring(index)] or candidates(check.path)
		local ok = false
		for _, instance in found do
			if check.disabled then
				-- Only a script answers for it: a same-named Folder or Model next to it does not
				ok = instance:IsA("Script") and (instance :: Script).Enabled == false
			elseif instance:IsA("LuaSourceContainer") then
				ok = PlayOverlay.hash((instance :: any).Source) == check.hash
			end
			if ok then break end
		end
		local where = table.concat(check.path, ".")
		if ok then
			passed += 1
		elseif #found == 0 then
			table.insert(unverified, where)
		else
			table.insert(failed, if check.disabled then `{where} still runs` else `{where} has the place's text, not the branch's`)
		end
	end
	if #failed > 0 then
		warn(`[Quack]: this play does NOT have the branch: {table.concat(failed, "; ")}`)
	else
		print(`[Quack]: this play has the branch ({passed} scripts checked)`)
	end
	if #unverified > 0 then
		print(`[Quack]: {#unverified} swapped script(s) were gone before the check (removed by the game): {table.concat(unverified, "; ")}`)
	end
	return { type = "playVerify", id = play.id, ok = #failed == 0, passed = passed, failed = failed, unverified = unverified }
end

return PlayOverlay
