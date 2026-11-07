--!strict
--[[
	Quack: a copy of what Studio deletes from the synced area, so it comes back with a click.

	Parts, Models, GUIs and maps live only in the place: when they go, the folder on disk has
	nothing to bring back. Anime Astral, 07/11/26: a Map of 2810 instances left the place during a
	Team Create session and nobody could say how; only the scripts were on disk.

	Measured in Studio on 07/11/26 (CoreGui, place 98303250209605): signals are deferred, so
	DescendantRemoving runs after the removal, top-down, once per instance. After Parent = nil the
	tree is still whole and one Clone() of its root copies it all. After Destroy() the children are
	already torn off when the handler runs, so Clone() of the root is empty, but a Clone() of each
	instance still carries its properties (Size, Color, Text, attributes). So each instance's parent
	is noted while it is alive (noteParent), every removed one is noted (noteRemoved), and at the
	end of the frame the trees are rebuilt from those links.

	Only what Studio removes reaches this: the plugin's own deletes clear tracking first.
]]

local ChangeHistoryService = game:GetService("ChangeHistoryService")

local Trash = {}
Trash.__index = Trash

--- A removed tree smaller than this gets no copy (a Part and its decals are what Ctrl+Z is for)
Trash.MIN_INSTANCES = 50
--- Past this one tree is not copied: the copy alone would hold Studio for a second or more
Trash.MAX_TREE = 50000
--- Copies kept, the newest first, and for how long
Trash.MAX_ENTRIES = 20
Trash.MAX_KEPT_INSTANCES = 200000
Trash.KEEP_SECONDS = 30 * 60

export type Entry = {
	id: number,
	name: string,
	--- Where it was: names from the service down to its parent
	parentPath: { string },
	count: number,
	at: number,
	--- When the copy was made, os.date("%H:%M")
	clock: string,
	original: Instance,
	parent: Instance?,
	copy: Instance?,
}

export type Trash = typeof(setmetatable(
	{} :: {
		parentOf: { [Instance]: Instance },
		recentAdds: { [string]: number },
		addsSincePrune: number,
		pending: { Instance },
		flushQueued: boolean,
		entries: { Entry },
		nextId: number,
		onChanged: (kept: Entry?) -> (),
	},
	Trash
))

function Trash.new(onChanged: (kept: Entry?) -> ()): Trash
	local self = setmetatable({
		-- Weak keys: never keeps an instance alive by itself
		parentOf = setmetatable({} :: any, { __mode = "k" }),
		recentAdds = {},
		addsSincePrune = 0,
		pending = {},
		flushQueued = false,
		entries = {},
		nextId = 0,
		onChanged = onChanged,
	}, Trash)
	return self
end

--- Notes where an instance is now; call it whenever a tracked one appears or moves
function Trash.noteParent(self: Trash, instance: Instance)
	local parent = instance.Parent
	if parent then self.parentOf[instance] = parent end
end

--- How long after a removal a same-named instance appearing means it moved, not left
Trash.MOVED_SECONDS = 2

--- Something appeared in the place: a removed tree that comes back under another parent (a
--- move delivered as remove and add) keeps its copy in the list but raises no pop-up
function Trash.noteAdded(self: Trash, instance: Instance)
	self.recentAdds[`{instance.ClassName}\0{instance.Name}`] = os.clock()
	self.addsSincePrune += 1
	if self.addsSincePrune < 5000 then return end
	self.addsSincePrune = 0
	local now = os.clock()
	for key, at in self.recentAdds do
		if now - at > 10 then self.recentAdds[key] = nil end
	end
end

--- Whether something with the entry's name and class appeared right after its removal (or just
--- before: the add of a move may come first). Not earlier: a tree made and deleted 2 s later
--- had its own creation taken for a return and got no pop-up (PA, 07/11/26)
function Trash.reappeared(self: Trash, entry: Entry): boolean
	local at = self.recentAdds[`{entry.original.ClassName}\0{entry.name}`]
	return at ~= nil and at >= entry.at - 0.5 and at <= entry.at + Trash.MOVED_SECONDS
end

--- A tracked instance left the place (from DescendantRemoving, so already gone)
function Trash.noteRemoved(self: Trash, instance: Instance)
	table.insert(self.pending, instance)
	if self.flushQueued then return end
	self.flushQueued = true
	-- After every DescendantRemoving of this removal: they are resumed before a deferred thread
	task.defer(function()
		self.flushQueued = false
		local ok, err = pcall(function() self:flush() end)
		if not ok then warn(`[Quack]: Could not keep a copy of what was deleted: {err}`) end
	end)
end

--- Names from the service down to `instance`. A parent removed in the same moment has no Parent
--- any more, so the walk goes on through the noted parents (measured 07/11/26: read from Parent
--- alone, a Map whose folder was deleted with it had the path "Holder" and came back under game)
function Trash.pathOf(self: Trash, instance: Instance): { string }
	local names = {}
	-- A noted parent can be stale: A left B, then B was put inside the detached A, and the walk
	-- would go A, B, A... forever. A repeat means the path is not known (restore then refuses)
	local seen: { [Instance]: boolean } = {}
	local current: Instance? = instance
	while current and current ~= game do
		if seen[current] then return {} end
		seen[current] = true
		table.insert(names, 1, current.Name)
		current = current.Parent or self.parentOf[current]
	end
	return names
end

local function holdsUnfiled(nodes: { Instance }): boolean
	for _, node in nodes do
		if not node:IsA("Folder") and not node:IsA("LuaSourceContainer") then return true end
	end
	return false
end

--- A tree's copy: the root's own Clone() when the tree is still whole (Parent = nil), else one
--- per instance, put back together from the noted parents (Destroy tore the children off)
function Trash.copyTree(self: Trash, root: Instance, nodes: { Instance }): Instance?
	if #root:GetChildren() > 0 then
		local ok, copy = pcall(function() return root:Clone() end)
		return if ok then copy else nil
	end
	-- A node still holding children is cloned whole, and nothing under it is cloned again
	local inGroup: { [Instance]: boolean } = {}
	local whole: { [Instance]: boolean } = {}
	for _, node in nodes do
		inGroup[node] = true
		if #node:GetChildren() > 0 then whole[node] = true end
	end
	local function underWhole(node: Instance): boolean
		local seen: { [Instance]: boolean } = {}
		local current = self.parentOf[node]
		while current and inGroup[current] and not seen[current] do
			if whole[current] then return true end
			seen[current] = true
			current = self.parentOf[current]
		end
		return false
	end
	-- Every clone first, the parents after: the order nodes came in does not matter
	local copies: { [Instance]: Instance } = {}
	for _, node in nodes do
		if node ~= root and underWhole(node) then continue end
		local ok, copy = pcall(function() return node:Clone() end)
		if ok and copy then copies[node] = copy end
	end
	for node, copy in copies do
		if node == root then continue end
		local parent = self.parentOf[node]
		local parentCopy = parent and copies[parent]
		if parentCopy then copy.Parent = parentCopy end
	end
	return copies[root]
end

function Trash.flush(self: Trash)
	local removed = self.pending
	self.pending = {}
	if #removed == 0 then return end

	local inBatch: { [Instance]: boolean } = {}
	for _, instance in removed do
		inBatch[instance] = true
	end

	-- Each removed instance under the topmost removed one of its chain
	local rootOf: { [Instance]: Instance } = {}
	local function findRoot(instance: Instance): Instance
		local known = rootOf[instance]
		if known then return known end
		-- Itself until its parent is resolved: stale noted parents that loop end here
		rootOf[instance] = instance
		local parent = self.parentOf[instance]
		local root = if parent and inBatch[parent] then findRoot(parent) else instance
		rootOf[instance] = root
		return root
	end
	local groups: { [Instance]: { Instance } } = {}
	local order: { Instance } = {}
	for _, instance in removed do
		local root = findRoot(instance)
		local group = groups[root]
		if not group then
			group = {}
			groups[root] = group
			table.insert(order, root)
		end
		table.insert(group, instance)
	end

	-- One removal clones at most the cap: several big trees deleted at once are not all copied
	-- only to be dropped by the prune after. Older copies make room (the prune drops them first)
	local budget = Trash.MAX_KEPT_INSTANCES

	local kept: Entry? = nil
	for _, root in order do
		local nodes = groups[root]
		if #nodes < Trash.MIN_INSTANCES or not holdsUnfiled(nodes) then continue end
		local parent = self.parentOf[root]
		local parentPath = if parent then self:pathOf(parent) else {}
		local where = table.concat(parentPath, ".")
		where = if where == "" then root.Name else `{where}.{root.Name}`
		-- A whole tree is copied with all it holds, excluded folders too: counted the same way
		local size = if #root:GetChildren() > 0 then #root:GetDescendants() + 1 else #nodes
		if size > Trash.MAX_TREE or size > budget then
			warn(`[Quack]: {where} was deleted ({size} instances); too big to keep a copy of`)
			continue
		end
		local copy = self:copyTree(root, nodes)
		if not copy then continue end
		budget -= size
		self.nextId += 1
		local entry: Entry = {
			id = self.nextId,
			name = root.Name,
			parentPath = parentPath,
			count = size,
			at = os.clock(),
			clock = os.date("%H:%M") :: string,
			original = root,
			parent = parent,
			copy = copy,
		}
		table.insert(self.entries, 1, entry)
		kept = entry
		local id = entry.id
		-- Announced once it is clear it left: not back by Ctrl+Z, not moved (removed and added
		-- again elsewhere) in the meantime. The list shows it from now on either way.
		-- Only the id is held by these delays: a copy the caps drop is let go at once
		task.delay(Trash.MOVED_SECONDS, function()
			self:prune()
			local found = self:find(id)
			if found and not self:reappeared(found) then self.onChanged(found) end
		end)
		task.delay(Trash.KEEP_SECONDS + 1, function()
			if self:find(id) then
				self:prune()
				self.onChanged(nil)
			end
		end)
	end
	if kept then
		self:prune()
		self.onChanged(nil)
	end
end

local function isBack(entry: Entry): boolean
	return entry.original.Parent ~= nil and entry.original:IsDescendantOf(game)
end

--- Drops copies past their time, past the caps, and those whose original is back (Ctrl+Z)
function Trash.prune(self: Trash)
	local now = os.clock()
	local keptInstances = 0
	local entries = {}
	for _, entry in self.entries do
		if now - entry.at > Trash.KEEP_SECONDS or isBack(entry) then continue end
		if #entries >= Trash.MAX_ENTRIES or keptInstances + entry.count > Trash.MAX_KEPT_INSTANCES then continue end
		keptInstances += entry.count
		table.insert(entries, entry)
	end
	self.entries = entries
end

function Trash.find(self: Trash, id: number): Entry?
	for _, entry in self.entries do
		if entry.id == id then return entry end
	end
	return nil
end

--- The copies still kept, the newest first
function Trash.list(self: Trash): { Entry }
	self:prune()
	return table.clone(self.entries)
end

--- Where a restored tree goes: its old parent if still in the place, else the same path, with
--- Folders made for what is missing (the parent may have been deleted along with it)
local function restoreParent(entry: Entry): Instance
	if entry.parent and entry.parent:IsDescendantOf(game) then return entry.parent end
	if #entry.parentPath == 0 then error("its place is not known", 0) end
	local current: Instance = game
	for index, name in entry.parentPath do
		local nextNode: Instance? = nil
		if index == 1 then
			-- Only ever under a service: a path that does not start at one is not known whole
			local ok, service = pcall(function() return game:GetService(name :: any) end)
			if not ok or not service then error(`its place ({table.concat(entry.parentPath, ".")}) is not known`, 0) end
			nextNode = service
		end
		if not nextNode then nextNode = current:FindFirstChild(name) end
		if not nextNode then
			local folder = Instance.new("Folder")
			folder.Name = name
			folder.Parent = current
			nextNode = folder
		end
		current = nextNode :: Instance
	end
	return current
end

--- Puts a kept tree back where it was. The original when it can still be parented (a delete in
--- the Explorer keeps it for Ctrl+Z), else the copy. One undo step: Ctrl+Z takes it out again.
function Trash.restore(self: Trash, id: number): (boolean, string)
	local entry = self:find(id)
	if not entry then return false, "That copy is no longer kept." end
	if isBack(entry) then
		self:prune()
		self.onChanged(nil)
		return false, `{entry.name} is already back in the place.`
	end

	local recording = ChangeHistoryService:TryBeginRecording("Quack: restore deleted", `Restore {entry.name}`)
	local ok, result = pcall(function(): Instance
		local parent = restoreParent(entry)
		-- A destroyed original refuses a new Parent; a whole one keeps its identity
		local reparented = #entry.original:GetChildren() > 0
			and pcall(function() entry.original.Parent = parent end)
		if reparented then return entry.original end
		local copy = entry.copy :: Instance
		copy.Parent = parent
		return copy
	end)
	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			if ok then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel
		)
	end
	if not ok then return false, `Could not restore {entry.name}: {result}` end

	local index = table.find(self.entries, entry)
	if index then table.remove(self.entries, index) end
	self.onChanged(nil)
	local restored = result :: Instance
	return true, `Restored {restored:GetFullName()} ({entry.count} instances)`
end

return Trash
