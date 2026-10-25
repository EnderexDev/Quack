--!strict
local QuackService = {}
QuackService.VERSION = "1.0.0"

-- Services
local ScriptEditorService = game:GetService("ScriptEditorService")
local HttpService = game:GetService("HttpService")
local InsertService = game:GetService("InsertService")
local RunService = game:GetService("RunService")

-- Modules
local Serializer = require("./Serializer")
local Config = require("./Config")
local Enums = require("./Enums")

-- Logging helpers
local function debugPrint(...)
	if Config.SILENT_MODE or not Config.DEBUG_MODE then return end
	print(`[🐛 Quack]:`, ...)
end

--[=[
	Utility: Check if instance is a script
	@param instance Instance - The instance to check
	@return boolean - True if the instance is a Script, LocalScript, or ModuleScript
]=]
function QuackService.isScript(instance)
	return instance:IsA("Script") or instance:IsA("LocalScript") or instance:IsA("ModuleScript")
end

function QuackService.isScriptClass(className)
	return className == "Script" or className == "LocalScript" or className == "ModuleScript"
end

--[=[
	Utility: Rebuild service set from config
	@param serviceSet { [string]: boolean } - The service set to rebuild
]=]
function QuackService.rebuildServiceSet(serviceSet)
	table.clear(serviceSet)
	for _, name in Config.SERVICE_LIST do
		serviceSet[name] = true
	end
end

--[=[
	Quack: whether an excluded entry names this instance or one of its ancestors. An entry with a
	dot is a path and must equal an ancestor's full name; one without is a name and must equal an
	ancestor's Name. Compared with the real ancestors, not as text inside the path: as a Lua
	pattern "Workspace.Map-1" missed Map-1 and "Ma-1" excluded Ma1; as a substring
	"Workspace.Map" took Workspace.Maple, Workspace.Other.Workspace.Map and a child named
	"Map.Backup" (all checked in Studio, 20/10/26).
	Each ancestor's full name is the one below it with ".<child name>" cut off the end, so a name
	that holds a dot is cut whole and GetFullName runs once per instance, not once per ancestor.
]=]
function QuackService.isUnderExcluded(instance: Instance, fullName: string, entries: { string }): boolean
	if #entries == 0 then return false end
	local current: Instance? = instance
	local path = fullName
	while current and current ~= game do
		for _, entry in entries do
			if entry ~= "" and (if string.find(entry, ".", 1, true) then path == entry else current.Name == entry) then
				return true
			end
		end
		path = string.sub(path, 1, #path - #current.Name - 1)
		current = current.Parent
	end
	return false
end

--- Utility: Check if instance should be excluded from sync
function QuackService.isExcluded(instance: Instance, serviceSet: { [string]: boolean })
	if not instance then return true end

	local fullName = instance:GetFullName()
	if QuackService.isUnderExcluded(instance, fullName, Config.EXCLUDED_PARENTS) then return true end

	-- Walk up to the service
	local current: Instance? = instance
	while current do
		-- Is it an ignored ClassName?
		for _, className in Config.IGNORED_CLASSES do
			if current.ClassName == className then return true end
		end

		if current.Parent == game then
			-- Players' descendants are runtime Player objects that can't be rebuilt (WritePlayer), so only the service itself is kept
			if current ~= instance and current.ClassName == "Players" then return true end

			-- Handle whitelist/blacklist logic based on the service set
			local inList = serviceSet[current.Name] ~= nil

			if Config.LIST_TYPE == Enums.listType.WHITELIST then
				-- Whitelist: only allow services in the list
				-- debugPrint(`Included {instance} in whitelist`)
				return not inList
			else
				-- Blacklist: exclude services in the list
				-- debugPrint(`Excluded {instance} in blacklist`)
				return inList
			end
		end
		current = current.Parent
	end

	-- Not under DataModel
	return true
end

--[=[
	Quack: isExcluded for a child whose parent is already known to be included, in O(1): every
	rule on the ancestors already passed, so only the child itself is left to check. `fullName` is
	the child's GetFullName (the parent's plus "." and the child's Name). Used by the snapshot walk,
	which checked every instance twice with isExcluded: ~2 s of the 10.6 s a 261k-instance place
	took to connect (measured 20/10/26).
]=]
function QuackService.isChildExcluded(child: Instance, fullName: string, parent: Instance): boolean
	-- A Players service's descendants are runtime Player objects
	if parent.Parent == game and parent.ClassName == "Players" then return true end
	for _, className in Config.IGNORED_CLASSES do
		if child.ClassName == className then return true end
	end
	for _, entry in Config.EXCLUDED_PARENTS do
		if entry ~= "" and (if string.find(entry, ".", 1, true) then fullName == entry else child.Name == entry) then
			return true
		end
	end
	return false
end

--- Utility: Get or create instance by path segments
function QuackService.getOrCreatePath(pathSegments: { string }): Instance
	local current: Instance = game
	for index, segment in pathSegments do
		local nextNode: Instance? = current:FindFirstChild(segment)

		if not nextNode then
			if index == 1 then
				local ok, service = pcall(function() return game:GetService(segment) end)
				if ok and service then nextNode = service end
			end

			if not nextNode then
				local newFolder = Instance.new("Folder")
				newFolder.Name = segment
				newFolder.Parent = current
				nextNode = newFolder
			end
		end

		current = nextNode :: Instance
	end

	return current
end

function QuackService.isProtectedRobloxContainer(instance: Instance?): boolean
	if not instance then return false end

	-- Can't destroy terrain!
	-- In the future, we may want to serialize terrain chunks and wipe them here
	-- For now, just skip terrain entirely
	if instance:IsA("Terrain") then return true end

	-- Top-level services cannot be destroyed or reparented. FindService by class and compared with
	-- the instance itself: GetService(Name) succeeded for anything named like a service, and
	-- created the service when it did not exist yet
	if instance.Parent == game then
		local ok, service = pcall(function() return game:FindService(instance.ClassName) end)
		if ok and service == instance then return true end
	end

	-- Certain StarterPlayer children are locked (StarterPlayerScripts, StarterCharacterScripts, StarterGear)
	local parent = instance.Parent
	-- By class: a plain Folder named like one of them is an ordinary folder (Studio: the two under
	-- StarterPlayer are of class StarterPlayerScripts and StarterCharacterScripts)
	if parent and parent.ClassName == "StarterPlayer" then
		local class = instance.ClassName
		if class == "StarterPlayerScripts" or class == "StarterCharacterScripts" or class == "StarterGear" then
			return true
		end
	end

	return false
end

--- Utility: Generate or retrieve GUID for instance (use Roblox debug IDs to avoid attribute churn)
function QuackService.getOrCreateGUID(
	instance,
	trackedInstances: { [Instance]: string },
	guidMap: { [string]: Instance },
	usedGuids: { [string]: boolean }
): string
	local cached = trackedInstances[instance]
	if cached then return cached end

	local guid = instance:GetDebugId(0)
	trackedInstances[instance] = guid
	guidMap[guid] = instance
	usedGuids[guid] = true
	return guid
end

--- Utility: Get instance path
function QuackService.getInstancePath(instance: Instance): { string }?
	local path = {}
	local current: Instance? = instance

	while current and current ~= game do
		table.insert(path, 1, current.Name)
		current = current.Parent
	end

	-- If current became nil, the instance is no longer under DataModel
	if current ~= game then return nil end

	return path
end

--- Convert instance to data format
function QuackService.instanceToData(
	instance,
	trackedInstances: { [Instance]: string },
	guidMap: { [string]: Instance },
	usedGuids: { [string]: boolean },
	-- path: the instance's path when the caller already has it (the snapshot walk builds each one
	-- from its parent's), instead of walking up to the DataModel again
	options: { includeProperties: boolean?, path: { string }? }?
): { [string]: any }?
	local guid = QuackService.getOrCreateGUID(instance, trackedInstances, guidMap, usedGuids)
	local path = (options and options.path) or QuackService.getInstancePath(instance)
	if not path then return nil end

	local parentGuid: string? = nil
	local parent = instance.Parent
	if parent then
		if parent == game then
			parentGuid = "root"
		else
			parentGuid = QuackService.getOrCreateGUID(parent, trackedInstances, guidMap, usedGuids)
		end
	end

	local data: { [string]: any } = {
		guid = guid,
		className = instance.ClassName,
		name = instance.Name,
		path = path,
		parentGuid = parentGuid,
	}

	if QuackService.isScript(instance) then data.source = ScriptEditorService:GetEditorSource(instance) end

	if options and options.includeProperties then
		local properties = Serializer.collectSerializedProperties(instance, {
			getInstanceRefData = function(referenceInstance: Instance)
				local referencePath = QuackService.getInstancePath(referenceInstance)
				if not referencePath then return nil end

				local referenceGuid =
					QuackService.getOrCreateGUID(referenceInstance, trackedInstances, guidMap, usedGuids)
				return {
					guid = referenceGuid,
					path = referencePath,
				}
			end,
		})
		if next(properties) ~= nil then data.properties = properties end

		local attributes = Serializer.collectSerializedAttributes(instance)
		if next(attributes) ~= nil then data.attributes = attributes end

		local tags = Serializer.collectSerializedTags(instance)
		if #tags > 0 then data.tags = tags end
	end

	return data
end

--- Quack: in an open editor tab, replace only the lines that differ, so the cursor of whoever is
--- typing stays put. UpdateSourceAsync replaces the whole document and the cursor jumps to the end
--- (reproduced: cursor at 7:5, an agent changed line 3, cursor went to 16:1).
--- Edits on whole-line boundaries (column 1) wherever possible. Columns are BYTES (measured: with
--- "é" a character-count column left a char behind). Returns false if the document does
--- not end up exactly as `source`, and the caller falls back to UpdateSourceAsync.
local function applyMinimalDocumentEdit(doc: ScriptDocument, source: string): boolean
	local current = doc:GetText()
	if current == source then return true end

	local old = string.split(current, "\n")
	local new = string.split(source, "\n")

	local prefix = 0
	while prefix < #old and prefix < #new and old[prefix + 1] == new[prefix + 1] do
		prefix += 1
	end
	local suffix = 0
	while suffix < #old - prefix and suffix < #new - prefix and old[#old - suffix] == new[#new - suffix] do
		suffix += 1
	end

	local middle = table.move(new, prefix + 1, #new - suffix, 1, {})
	local lastChanged = #old - suffix -- last old line being replaced (< prefix + 1 when inserting)

	local ok = pcall(function()
		if prefix == #old then
			-- Pure append after the last line
			local lastLine = old[#old]
			local endCol = #lastLine + 1
			doc:EditTextAsync("\n" .. table.concat(middle, "\n"), #old, endCol, #old, endCol)
		elseif lastChanged < #old then
			-- A line follows the changed block: replace whole lines up to the start of that line
			local text = if #middle > 0 then table.concat(middle, "\n") .. "\n" else ""
			doc:EditTextAsync(text, prefix + 1, 1, lastChanged + 1, 1)
		else
			-- The changed block runs to the end of the document
			local lastLine = old[#old]
			local endCol = #lastLine + 1
			if #middle == 0 and prefix > 0 then
				-- Trailing lines deleted: start at the end of the last kept line, so its newline goes too
				local keptLine = old[prefix]
				local keptEnd = #keptLine + 1
				doc:EditTextAsync("", prefix, keptEnd, #old, endCol)
			else
				doc:EditTextAsync(table.concat(middle, "\n"), prefix + 1, 1, #old, endCol)
			end
		end
	end)

	return ok and doc:GetText() == source
end

--- Quack: whether this Studio edits a Team Create place. FindScriptDocument only sees this
--- Studio's tabs, and .Source leaves a collaborator's open tab on the old text: their next
--- keystroke writes that whole old text back (EnemyConfig, Anime Astral, 23/10/26). Measured
--- 25/10/26: an edit-mode Studio in Team Create has a NetworkClient; one on a local file has none.
function QuackService.isTeamCreate(): boolean
	return RunService:IsEdit() and game:FindService("NetworkClient") ~= nil
end

export type SetSourceOptions = {
	-- The instance was created in this same call: no tab anywhere can show it yet
	fresh: boolean?,
	-- The text the caller checked; if the script holds anything else by the time the write
	-- lands (someone typed while it yielded), nothing is written and the second result is true
	expected: string?,
}

--- Utility: set script source safely (handles large sources via ScriptEditorService)
function QuackService.setScriptSource(
	scriptInstance: Script | LocalScript | ModuleScript,
	source: string,
	options: SetSourceOptions?
): (boolean, boolean?)
	local fresh = options and options.fresh
	local expected = options and options.expected
	-- Quack: .Source costs ~80 us against ~80 ms for UpdateSourceAsync (measured 19/10/26; 258 ms
	-- in Team Create, 25/10/26), but it refuses more than 200,000 characters, it leaves a tab open
	-- in this Studio on the old text, and in Team Create a collaborator's tab too (that one this
	-- Studio cannot see). Those cases keep the slow path. Fresh instances have no tab anywhere.
	local doc = ScriptEditorService:FindScriptDocument(scriptInstance)
	if doc == nil and scriptInstance.Source == source then return true, false end
	if #source <= 200000 and doc == nil and (fresh or not QuackService.isTeamCreate()) then
		local okDirect = pcall(function() scriptInstance.Source = source end)
		if okDirect then return true, false end
	end

	if doc then
		if expected ~= nil and doc:GetText() ~= expected then return false, true end
		if applyMinimalDocumentEdit(doc, source) then return true, false end
	end

	local changedUnderneath = false
	local okUpdateSource, errUpdateSource = pcall(function()
		ScriptEditorService:UpdateSourceAsync(scriptInstance, function(old: string)
			if expected ~= nil and old ~= expected then
				changedUnderneath = true
				return old
			end
			return source
		end)
	end)

	if not okUpdateSource then
		warn(`[Quack]: Failed to set script source for {scriptInstance}:`, errUpdateSource)
	end

	if changedUnderneath then return false, true end
	return okUpdateSource, false
end

--- Writes many scripts at once, `MAX_PARALLEL_WRITES` at a time. In Team Create each write is an
--- UpdateSourceAsync of ~258 ms; measured 25/10/26, 20 of them took 5.3 s one after another and
--- 281 ms side by side, every one landing.
local MAX_PARALLEL_WRITES = 32
function QuackService.setScriptSources(writes: { { instance: Script | LocalScript | ModuleScript, source: string } })
	local nextIndex = 1
	local running = 0
	local caller = coroutine.running()
	local finished = false

	local function worker()
		while nextIndex <= #writes do
			local write = writes[nextIndex]
			nextIndex += 1
			local ok, err = pcall(QuackService.setScriptSource, write.instance, write.source)
			if not ok then warn(`[Quack]: Failed to set script source for {write.instance}:`, err) end
		end
		running -= 1
		if running == 0 and finished then task.spawn(caller) end
	end

	for _ = 1, math.min(MAX_PARALLEL_WRITES, #writes) do
		running += 1
		task.spawn(worker)
	end
	finished = true
	if running > 0 then coroutine.yield() end
end

--- Create/update instance data with dedup tracking (returns data if changed, nil if duplicate)
function QuackService.instanceToDataDedup(
	instance: Instance,
	trackedInstances: { [Instance]: string },
	guidMap: { [string]: Instance },
	usedGuids: { [string]: boolean },
	lastInstanceUpdate: { [string]: { key: string, t: number } }
): { [string]: any }?
	local data = QuackService.instanceToData(instance, trackedInstances, guidMap, usedGuids)
	if not data then return nil end

	local guid = data.guid :: string
	local parentKey = (data.parentGuid :: string?) or ""
	local key = table.concat(data.path :: { string }, "/")
		.. "|"
		.. (data.className :: string)
		.. "|"
		.. (data.name :: string)
		.. "|"
		.. parentKey
	local now = tick()
	local last = lastInstanceUpdate[guid]
	if last and last.key == key and now - last.t < 0.05 then
		-- Ignore duplicate bursts from multiple property signals firing at once
		return nil
	end
	lastInstanceUpdate[guid] = { key = key, t = now }

	return data
end

type InstanceData = {
	guid: string,
	className: string,
	name: string,
	path: { string }, -- ["ReplicatedStorage", "Modules", "Foo"]
	parentGuid: string?, -- parent instance GUID
	source: string?, -- Only present for Script/LocalScript/ModuleScript
	properties: { [string]: any }?, -- Record<string, unknown>;
	attributes: { [string]: any }?, -- Record<string, unknown>;
	tags: { string }?,
}

type MeshData = {
	meshId: string,
	collisionFidelity: Enum.CollisionFidelity,
	renderFidelity: Enum.RenderFidelity,
}

--- Apply snapshot instances to the workspace
function QuackService.applySnapshotInstances(
	instances: { InstanceData },
	destination: { string }?
): (number, number, { [string]: Instance })
	-- Sort instances by path length to make sure parents are created before children
	table.sort(instances, function(a, b) return #a.path < #b.path end)

	--[=[
		Extract MeshId from properties if present and valid. We need to do this before instance creation because MeshId is a special case that requires creating the MeshPart via InsertService with the content ID, and we want to avoid applying it as a normal property which would fail and log errors.
	]=]
	local function extractMeshId(properties: { [string]: any }?): string?
		if type(properties) ~= "table" then return nil end

		-- Roblox migrated MeshId to the Content-typed MeshContent, which is what
		-- current snapshots carry. Pack version 1 sourcemaps still hold MeshId as
		-- a plain content string.
		if properties.MeshContent ~= nil then
			local content = Serializer.deserializeValue(properties.MeshContent)
			if typeof(content) == "Content" then
				local uri = content.Uri
				if type(uri) == "string" and uri ~= "" then return uri end
			end
		end

		if properties.MeshId ~= nil then
			local value = Serializer.deserializeValue(properties.MeshId)
			if type(value) == "string" and value ~= "" then return value end
		end

		return nil
	end

	local function getMeshData(properties: { [string]: any }?): MeshData?
		if type(properties) ~= "table" then return nil end
		local meshId = extractMeshId(properties)
		if not meshId then return nil end
		local collisionFidelity = Enum.CollisionFidelity.Default :: Enum.CollisionFidelity
		local renderFidelity = Enum.RenderFidelity.Automatic :: Enum.RenderFidelity

		if properties["CollisionFidelity"] then
			collisionFidelity = Serializer.deserializeValue(properties["CollisionFidelity"])
		end

		if properties["RenderFidelity"] then
			renderFidelity = Serializer.deserializeValue(properties["RenderFidelity"])
		end

		return {
			meshId = meshId,
			collisionFidelity = collisionFidelity,
			renderFidelity = renderFidelity,
		}
	end

	--[=[
		Strip the MeshId property from instance properties before creating the instance.
	]=]
	local function stripMeshId(properties: { [string]: any }?): { [string]: any }?
		if type(properties) ~= "table" then return nil end
		local filtered = {}
		local hasValues = false
		for key, value in properties do
			if key ~= "MeshId" and key ~= "MeshContent" then
				filtered[key] = value
				hasValues = true
			end
		end
		if not hasValues then return {} end
		return filtered
	end

	local function recreateMeshPart(
		existing: MeshPart,
		meshData: MeshData,
		targetName: string,
		targetParent: Instance?
	): MeshPart?
		local okCreate, newMeshPart = pcall(
			function()
				return InsertService:CreateMeshPartAsync(
					meshData.meshId,
					meshData.collisionFidelity,
					meshData.renderFidelity
				)
			end
		)
		if not okCreate or not newMeshPart then return nil end

		newMeshPart.Name = targetName
		for _, child in existing:GetChildren() do
			child.Parent = newMeshPart
		end
		newMeshPart.Parent = targetParent or existing.Parent
		existing:Destroy()
		return newMeshPart
	end

	--[=[
		Adjust instance paths based on locked container parents. For example, if the snapshot contains an instance targeting StarterPlayerScripts, we need to adjust the path to StarterPlayer/StarterPlayerScripts to account for the fact that StarterPlayerScripts is a protected container that cannot be created or reparented, and always exists under StarterPlayer.
	]=]
	local function computeAdjustedPath(
		pathSegments: { string },
		lockedContainerParentsMap: { [string]: string }
	): ({ string }, string?)
		local adjustedPath = {}
		for i, segment in pathSegments do
			adjustedPath[i] = segment
		end

		local protectedContainerName: string? = nil
		local first = adjustedPath[1]
		local maybeParent = lockedContainerParentsMap[first]
		if maybeParent and maybeParent ~= first then table.insert(adjustedPath, 1, maybeParent) end

		-- Only treat as a protected-container target when the path points to the
		-- container itself (StarterPlayer/<LockedContainer>), not its descendants.
		if #adjustedPath == 2 then
			local second = adjustedPath[2]
			if lockedContainerParentsMap[second] == adjustedPath[1] then protectedContainerName = second end
		end

		return adjustedPath, protectedContainerName
	end

	local siblingOrdinalByPathClass: { [string]: number } = {}
	local existingInstancesByGuid: { [string]: Instance } = {}
	local initialStudioGuids: { [string]: boolean } = {}
	local resolvedInstancesByGuid: { [string]: Instance } = {}
	local deferredPropertyApplications: { { instance: Instance, properties: { [string]: any }? } } = {}
	-- Written together after the loop: in Team Create each one yields (setScriptSources)
	local scriptWrites: { { instance: Script | LocalScript | ModuleScript, source: string } } = {}

	local lockedContainerParents = {
		StarterPlayerScripts = "StarterPlayer",
		StarterCharacterScripts = "StarterPlayer",
		StarterGear = "StarterPlayer",
	}

	local created = 0
	local updated = 0
	local guidMatchCount = 0
	local fallbackMatchCount = 0

	for _, existing in game:GetDescendants() do
		local guid = existing:GetDebugId(0)
		if type(guid) == "string" and guid ~= "" then
			existingInstancesByGuid[guid] = existing
			initialStudioGuids[guid] = true
		end
	end

	local function findInstanceByPath(pathSegments: { string }): Instance?
		local current: Instance = game
		for index, segment in pathSegments do
			local nextNode: Instance? = nil

			if index == 1 then
				local okService, service = pcall(function() return game:GetService(segment) end)
				if okService and service then nextNode = service end
			end

			if not nextNode then nextNode = current:FindFirstChild(segment) end
			if not nextNode then return nil end
			current = nextNode
		end

		return current
	end

	local function applyItem(item: InstanceData)
		debugPrint(
			`Processing snapshot instance "{item.name}" ({item.className}) with path {table.concat(item.path, "/")}`
		)

		local adjustedPath, protectedContainerName = computeAdjustedPath(item.path, lockedContainerParents)

		-- Get service candidate for the top-level node
		local serviceCandidate: Instance? = nil
		if #adjustedPath == 1 then
			local okService, service = pcall(function() return game:GetService(adjustedPath[1]) end)
			if okService then serviceCandidate = service end
		end

		-- Compute parent path for lookup/creation and determine parent instance (if any)
		local parentPath = {}
		for i = 1, #adjustedPath - 1 do
			parentPath[i] = adjustedPath[i]
		end

		-- Only use parent GUID resolution if there's no explicit destination override,
		-- an explicit destination implies the user ran a push with a specific destination target.
		local useParentGuidResolution = not destination or #destination == 0
		local parent: Instance? = nil
		if
			useParentGuidResolution
			and type(item.parentGuid) == "string"
			and item.parentGuid ~= ""
			and item.parentGuid ~= "root"
		then
			parent = resolvedInstancesByGuid[item.parentGuid] or existingInstancesByGuid[item.parentGuid]
		end
		if not parent then parent = QuackService.getOrCreatePath(parentPath) end

		debugPrint(`Determined parent for instance "{item.name}" ({item.className}): {tostring(parent)}`)

		local targetName = adjustedPath[#adjustedPath]
		if QuackService.isScriptClass(item.className) then
			local sameNameChildren = {}
			local hasPreExistingSameNamed = false

			-- Check for same-named children to determine if we need to preserve any due to studio GUID matches
			for _, child in (parent :: Instance):GetChildren() do
				if child.Name == targetName and child.ClassName == item.className then
					table.insert(sameNameChildren, child)
					local childGuid = child:GetDebugId(0)
					if type(childGuid) == "string" and childGuid ~= "" and initialStudioGuids[childGuid] then
						hasPreExistingSameNamed = true
					end
				end
			end

			-- If the target is a script and there's a pre-existing same-named script with a studio GUID, skip destroying it to avoid breaking references in the script editor.
			-- Instead, we'll treat it as a candidate for reuse and overwrite its source and properties.
			if not hasPreExistingSameNamed then
				for _, child in sameNameChildren do
					if not QuackService.isProtectedRobloxContainer(child) then
						local childGuid = child:GetDebugId(0)
						if type(childGuid) == "string" and childGuid ~= "" then
							existingInstancesByGuid[childGuid] = nil
							resolvedInstancesByGuid[childGuid] = nil
						end
						child:Destroy()
					end
				end
			end
		end

		local existing: Instance? = nil
		if type(item.guid) == "string" and item.guid ~= "" then
			existing = existingInstancesByGuid[item.guid]
			if existing then
				guidMatchCount += 1
			end
		end

		if not existing then
			existing = serviceCandidate
			if existing then
				fallbackMatchCount += 1
			end
		end

		if not existing then
			local targetClassName = item.className
			local occurrenceKey = table.concat(adjustedPath, "\u{1F}") .. "::" .. tostring(targetClassName)
			local occurrenceOrdinal = (siblingOrdinalByPathClass[occurrenceKey] or 0) + 1
			siblingOrdinalByPathClass[occurrenceKey] = occurrenceOrdinal

			local sameNameChildren = {}
			for _, child in (parent :: Instance):GetChildren() do
				if child.Name == targetName then table.insert(sameNameChildren, child) end
			end

			existing = sameNameChildren[occurrenceOrdinal]
			if existing then
				fallbackMatchCount += 1
			end
		end

		local instance = existing

		if existing and existing.ClassName ~= item.className then
			local targetIsScript = QuackService.isScriptClass(item.className)
			if targetIsScript then
				if QuackService.isProtectedRobloxContainer(existing) then
					instance = existing
				else
					existing:Destroy()
					instance = nil
				end
			else
				instance = existing
			end
		end

		if not instance and protectedContainerName then
			local protectedParentName = lockedContainerParents[protectedContainerName]
			if protectedParentName then
				local okParent, protectedParent = pcall(function() return game:GetService(protectedParentName) end)
				if okParent and protectedParent then
					local protectedExisting = protectedParent:FindFirstChild(protectedContainerName)
					if protectedExisting then instance = protectedExisting end
				end
			end
		end

		if not instance then -- If we still don't have an existing instance, create it
			local newInstance: Instance
			if item.className == "MeshPart" then
				local meshData = getMeshData(item.properties)
				if meshData then
					local content = Content.fromUri(meshData.meshId)
					local okMesh, meshResult = pcall(
						function()
							return InsertService:CreateMeshPartAsync(
								meshData.meshId,
								meshData.collisionFidelity,
								meshData.renderFidelity
							)
						end
					)

					if okMesh and meshResult then
						newInstance = meshResult
					elseif not okMesh then
						warn(
							`[Quack]: Failed to create MeshPart for instance "{item.name}" with MeshId "{meshData.meshId}": {tostring(
								meshResult
							)}.`
						)
					end
				end
			end
			if not newInstance then
				local okNew, createdInstance = pcall(function() return Instance.new(item.className) end)
				if okNew and createdInstance then
					newInstance = createdInstance
				else
					newInstance = Instance.new("Folder")
					debugPrint(
						`Failed to create instance of class "{item.className}", created Folder placeholder instead.`
					)
				end
			end
			newInstance.Name = adjustedPath[#adjustedPath]
			newInstance.Parent = parent :: Instance
			instance = newInstance
			created += 1
		else
			if parent and instance.Parent ~= parent and not QuackService.isProtectedRobloxContainer(instance) then
				local okReparent = pcall(function() instance.Parent = parent :: Instance end)
				if not okReparent then
					debugPrint(`Failed to reparent instance "{instance.Name}" ({instance.ClassName}) to target parent.`)
				end
			end

			if not serviceCandidate and not QuackService.isProtectedRobloxContainer(instance) then
				instance.Name = adjustedPath[#adjustedPath]
			end
		end

		if instance then -- Apply properties, attributes, and tags if we have a valid instance
			if item.className == "MeshPart" and instance:IsA("MeshPart") then
				local meshData = getMeshData(item.properties)
				if meshData and meshData.meshId ~= (instance :: MeshPart).MeshId then
					local replaced = recreateMeshPart(instance :: MeshPart, meshData, targetName, parent)
					if replaced then instance = replaced end
				end
			end

			if type(item.guid) == "string" and item.guid ~= "" then
				existingInstancesByGuid[item.guid] = instance
				resolvedInstancesByGuid[item.guid] = instance
			end

			local propertiesForApply = item.properties
			if instance:IsA("MeshPart") then propertiesForApply = stripMeshId(propertiesForApply) end

			table.insert(deferredPropertyApplications, {
				instance = instance,
				properties = propertiesForApply,
			})

			Serializer.applySerializedAttributes(instance, item.attributes)
			Serializer.applySerializedTags(instance, item.tags)
		end

		if QuackService.isScriptClass(item.className) and item.source and instance then
			if QuackService.isScript(instance) then
				table.insert(scriptWrites, { instance = instance :: Script, source = item.source })
				updated += 1
			else
				debugPrint(
					`Skipped source apply for non-script instance "{instance.Name}" ({instance.ClassName}) targeting class "{item.className}".`
				)
			end
		end
	end

	-- Isolate each instance so one failure (e.g. a protected Name write) doesn't abort the build before properties are applied
	for _, item in instances do
		local ok, err: string? = pcall(applyItem, item)
		if not ok then warn(`[Quack]: Skipped snapshot instance "{item.name}" ({item.className}): {err}`) end
	end
	QuackService.setScriptSources(scriptWrites)

	for _, pending in deferredPropertyApplications do
		local ok, err: string? = pcall(function()
			Serializer.applySerializedProperties(pending.instance, pending.properties, {
				resolveInstanceByGuid = function(guid: string): Instance? return resolvedInstancesByGuid[guid] end,
				resolveInstanceByPath = function(pathSegments: { string }): Instance?
					return findInstanceByPath(pathSegments)
				end,
			})
		end)
		if not ok then
			warn(
				`[Quack]: Failed to apply properties for instance "{pending.instance.Name}" ({pending.instance.ClassName}): {err}`
			)
		end
	end

	debugPrint(
		`Snapshot resolve summary: {guidMatchCount} guid matches, {fallbackMatchCount} fallback matches, {created} created, {updated} scripts updated`
	)

	return created, updated, resolvedInstancesByGuid
end

--- Find the push config ModuleScript
function QuackService.findPushConfigModule(pushConfigPath: { string }): ModuleScript?
	local current: Instance = game
	for index, segment in pushConfigPath do
		if index == 1 then
			local ok, service = pcall(function() return game:GetService(segment) end)
			if not ok or not service then return nil end
			current = service
		else
			local nextNode = current:FindFirstChild(segment)
			if not nextNode then return nil end
			current = nextNode
		end
	end

	if current and current:IsA("ModuleScript") then return current :: ModuleScript end

	return nil
end

--- Read and validate push config from ModuleScript
function QuackService.readPushConfig(pushConfigPath: { string }): ({ [string]: any }?, string?)
	local module = QuackService.findPushConfigModule(pushConfigPath)
	if not module then return nil, "Push config ModuleScript not found" end

	-- Clone module to force require to refresh data
	local moduleClone = module:Clone()
	moduleClone.Parent = module.Parent
	module:Destroy()
	module = moduleClone
	--

	local ok, data = pcall(require, module)
	if not ok then return nil, `Failed to require push config: {data}` end

	if type(data) ~= "table" then return nil, "Push config is not a table" end

	debugPrint(`Push config loaded from {module}: {HttpService:JSONEncode(data)}`)

	local mappings = {}
	if type(data.pushMappings) == "table" then
		for _, entry in data.pushMappings do
			if type(entry) == "table" and type(entry.source) == "string" and type(entry.destination) == "table" then
				local dest = {}
				for _, seg in entry.destination do
					if type(seg) == "string" and seg ~= "" then table.insert(dest, seg) end
				end

				if #dest > 0 then
					table.insert(mappings, {
						source = entry.source,
						destination = dest,
						destructive = entry.destructive == true,
						rojoMode = entry.rojoMode == true,
						fromSourcemap = if type(entry.fromSourcemap) == "string" and entry.fromSourcemap ~= ""
							then entry.fromSourcemap
							else nil,
					})
				end
			end
		end
	end

	local configPayload = {
		mappings = mappings,
		port = data.port,
		debugMode = data.debugMode,
		deleteOrphansOnConnect = data.deleteOrphansOnConnect,
	}

	return configPayload, nil
end

function QuackService.parseCommaSeparatedList(str: string): { string }
	local result = {}
	for segment in str:gmatch("([^,]+)") do
		local trimmed = segment:match("^%s*(.-)%s*$")
		if trimmed and trimmed ~= "" then table.insert(result, trimmed) end
	end
	return result
end

return QuackService
