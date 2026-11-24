--!nocheck
-- Quack Test: DataStoreService and MemoryStoreService in memory. Every test starts with them
-- empty (reset() between tests clears what they hold; the handles a module kept from its load
-- keep working, since each call reads the current contents). Values are copied in and out, as
-- the real stores do (a table saved and then changed is not changed in the store), and a value
-- the real store refuses (a function, an Instance, a cycle) is refused here too.

return function(ctx)
	local Enum = ctx.Enum
	local outside = ctx.outside
	local data

	local function reset()
		data = { stores = {}, ordered = {}, sorted = {}, hashes = {}, queues = {}, version = 0 }
	end
	reset()

	local function typed(name: string, methods)
		methods.__index = methods
		methods.__type = name
		methods.__tostring = function()
			return name
		end
		return methods
	end

	-- A copy as the store would save it; what it cannot save is an error naming the value
	local function stored(value: any, seen: { [any]: boolean }?): any
		local kind = typeof(value)
		if kind == "nil" or kind == "boolean" or kind == "string" then
			if kind == "string" and not utf8.len(value) then
				error("104: Cannot store invalid UTF-8 string in data store.", 3)
			end
			return value
		end
		if kind == "number" then
			if value ~= value then
				return value
			end
			return value
		end
		if kind == "buffer" then
			local out = buffer.create(buffer.len(value))
			buffer.copy(out, 0, value)
			return out
		end
		if kind == "table" then
			seen = seen or {}
			if seen[value] then
				error("104: Cannot store a table with a cycle in data store.", 3)
			end
			seen[value] = true
			local out = {}
			for k, v in value do
				out[stored(k, seen)] = stored(v, seen)
			end
			seen[value] = nil
			return out
		end
		error(`104: Cannot store {kind} in data store. Data stores can only accept valid UTF-8 characters.`, 3)
	end

	local function checkKey(key: any)
		if type(key) ~= "string" and type(key) ~= "number" then
			error("Argument 1 missing or nil", 3)
		end
		key = tostring(key)
		if #key == 0 or #key > 50 then
			error("101: Key name can't be empty or above 50 characters.", 3)
		end
		return key
	end

	local function now(): number
		return math.floor(os.clock() * 1000)
	end

	-- Pages: GetCurrentPage, AdvanceToNextPageAsync, IsFinished
	local PagesMeta = typed("Pages", {
		GetCurrentPage = function(self)
			return table.move(self._items, self._at, math.min(self._at + self._size - 1, #self._items), 1, {})
		end,
		AdvanceToNextPageAsync = function(self)
			self._at += self._size
			self.IsFinished = self._at + self._size > #self._items
		end,
	})
	local function pages(items, size)
		size = math.max(1, size or 50)
		return setmetatable({ _items = items, _at = 1, _size = size, IsFinished = size >= #items }, PagesMeta)
	end

	local KeyInfoMeta = typed("DataStoreKeyInfo", {
		GetUserIds = function(self)
			return table.clone(self._userIds)
		end,
		GetMetadata = function(self)
			return table.clone(self._metadata)
		end,
	})
	local function keyInfo(entry)
		return setmetatable({ Version = entry.version, CreatedTime = entry.created, UpdatedTime = entry.updated, _userIds = entry.userIds or {}, _metadata = entry.metadata or {} }, KeyInfoMeta)
	end

	-- -------------------------------------------------------------------------------------------
	-- DataStore and OrderedDataStore

	local function storeOf(kind: "stores" | "ordered", id: string)
		local store = data[kind][id]
		if not store then
			store = {}
			data[kind][id] = store
		end
		return store
	end

	local function write(store, key, value, userIds, options)
		data.version += 1
		local before = store[key]
		local entry = {
			value = value,
			version = tostring(data.version),
			created = if before then before.created else now(),
			updated = now(),
			userIds = userIds,
			metadata = options and options._metadata,
		}
		store[key] = entry
		return entry
	end

	local function storeMethods(kind: "stores" | "ordered", ordered: boolean)
		local function checkValue(value)
			if ordered and (type(value) ~= "number" or value ~= math.floor(value)) then
				error("Ordered data stores only accept integers", 3)
			end
		end
		return {
			GetAsync = function(self, key)
				key = checkKey(key)
				local entry = storeOf(kind, self._id)[key]
				if not entry then
					return nil, nil
				end
				return stored(entry.value), keyInfo(entry)
			end,
			SetAsync = function(self, key, value, userIds, options)
				key = checkKey(key)
				checkValue(value)
				local entry = write(storeOf(kind, self._id), key, stored(value), userIds, options)
				return entry.version
			end,
			UpdateAsync = function(self, key, transform)
				key = checkKey(key)
				local store = storeOf(kind, self._id)
				local entry = store[key]
				local old = if entry then stored(entry.value) else nil
				local new, userIds, metadata = transform(old, if entry then keyInfo(entry) else nil)
				if new == nil then
					return nil, nil
				end
				checkValue(new)
				local written = write(store, key, stored(new), userIds, { _metadata = metadata })
				return stored(written.value), keyInfo(written)
			end,
			RemoveAsync = function(self, key)
				key = checkKey(key)
				local store = storeOf(kind, self._id)
				local entry = store[key]
				store[key] = nil
				if not entry then
					return nil, nil
				end
				return stored(entry.value), keyInfo(entry)
			end,
			IncrementAsync = function(self, key, delta, userIds)
				key = checkKey(key)
				local store = storeOf(kind, self._id)
				local entry = store[key]
				local value = if entry then entry.value else 0
				if type(value) ~= "number" then
					error("IncrementAsync: the key's value is not a number", 2)
				end
				local written = write(store, key, value + (delta or 1), userIds)
				return written.value, keyInfo(written)
			end,
			ListKeysAsync = function(self, prefix, pageSize)
				local keys = {}
				for key in storeOf(kind, self._id) do
					if not prefix or string.sub(key, 1, #prefix) == prefix then
						table.insert(keys, { KeyName = key })
					end
				end
				table.sort(keys, function(a, b)
					return a.KeyName < b.KeyName
				end)
				return pages(keys, pageSize)
			end,
			GetSortedAsync = function(self, ascending, pageSize, minValue, maxValue)
				if not ordered then
					error("GetSortedAsync is not a valid member of DataStore", 2)
				end
				local rows = {}
				for key, entry in storeOf(kind, self._id) do
					local v = entry.value
					if (minValue == nil or v >= minValue) and (maxValue == nil or v <= maxValue) then
						table.insert(rows, { key = key, value = v })
					end
				end
				table.sort(rows, function(a, b)
					if a.value == b.value then
						return a.key < b.key
					end
					return if ascending then a.value < b.value else a.value > b.value
				end)
				return pages(rows, pageSize)
			end,
		}
	end

	local DataStoreMeta = typed("DataStore", storeMethods("stores", false))
	local OrderedMeta = typed("OrderedDataStore", storeMethods("ordered", true))

	local handles = {}
	local function handle(meta, kind: string, name: string, scope: string?)
		local id = `{kind}\0{name}\0{scope or "global"}`
		handles[id] = handles[id] or setmetatable({ _id = id, Name = name }, meta)
		return handles[id]
	end

	local dataStoreService = {
		GetDataStore = function(_, name, scope)
			assert(type(name) == "string", "GetDataStore expects a name")
			return handle(DataStoreMeta, "store", name, scope)
		end,
		GetGlobalDataStore = function()
			return handle(DataStoreMeta, "store", "\0global", nil)
		end,
		GetOrderedDataStore = function(_, name, scope)
			assert(type(name) == "string", "GetOrderedDataStore expects a name")
			return handle(OrderedMeta, "ordered", name, scope)
		end,
		GetRequestBudgetForRequestType = function()
			return 100
		end,
		ListDataStoresAsync = function()
			return outside("DataStoreService:ListDataStoresAsync")
		end,
	}

	-- -------------------------------------------------------------------------------------------
	-- MemoryStoreService: sorted maps, hash maps and queues, each entry with its expiration

	local function live(entry): boolean
		return entry ~= nil and (entry.expires == nil or entry.expires > os.clock())
	end
	local function expiresIn(seconds)
		if type(seconds) ~= "number" or seconds <= 0 then
			error("MemoryStore: expiration must be a positive number of seconds", 3)
		end
		return os.clock() + math.min(seconds, 3888000)
	end
	local function mapOf(kind, name)
		local map = data[kind][name]
		if not map then
			map = {}
			data[kind][name] = map
		end
		return map
	end

	local function mapMethods(kind)
		return {
			GetAsync = function(self, key)
				local entry = mapOf(kind, self._name)[checkKey(key)]
				if not live(entry) then
					return nil
				end
				return stored(entry.value), entry.sortKey
			end,
			SetAsync = function(self, key, value, expiration, sortKey)
				key = checkKey(key)
				local map = mapOf(kind, self._name)
				local isNew = not live(map[key])
				map[key] = { value = stored(value), expires = expiresIn(expiration), sortKey = sortKey }
				return isNew
			end,
			UpdateAsync = function(self, key, transform, expiration)
				key = checkKey(key)
				local map = mapOf(kind, self._name)
				local entry = map[key]
				local old = if live(entry) then stored(entry.value) else nil
				local new, sortKey = transform(old, if live(entry) then entry.sortKey else nil)
				if new == nil then
					return nil
				end
				map[key] = { value = stored(new), expires = expiresIn(expiration), sortKey = sortKey }
				return stored(new)
			end,
			RemoveAsync = function(self, key)
				mapOf(kind, self._name)[checkKey(key)] = nil
			end,
			GetSizeAsync = function(self)
				local n = 0
				for _, entry in mapOf(kind, self._name) do
					if live(entry) then
						n += 1
					end
				end
				return n
			end,
		}
	end

	local sortedMethods = mapMethods("sorted")
	-- Ordered by sort key (numbers before strings), then by key
	local function sortedRows(self)
		local rows = {}
		for key, entry in mapOf("sorted", self._name) do
			if live(entry) then
				table.insert(rows, { key = key, value = stored(entry.value), sortKey = entry.sortKey })
			end
		end
		local function rank(row)
			local s = row.sortKey
			return if s == nil then 0 elseif type(s) == "number" then 1 else 2
		end
		table.sort(rows, function(a, b)
			if rank(a) ~= rank(b) then
				return rank(a) < rank(b)
			end
			if a.sortKey ~= b.sortKey and a.sortKey ~= nil then
				return a.sortKey < b.sortKey
			end
			return a.key < b.key
		end)
		return rows
	end
	sortedMethods.GetRangeAsync = function(self, direction, count, lower, upper)
		local rows = sortedRows(self)
		if direction == Enum.SortDirection.Descending then
			local reversed = {}
			for i = #rows, 1, -1 do
				table.insert(reversed, rows[i])
			end
			rows = reversed
		end
		local out = {}
		for _, row in rows do
			if lower and type(lower) == "table" and lower.key and row.key <= lower.key then
				continue
			elseif lower and type(lower) == "string" and row.key <= lower then
				continue
			end
			if upper and type(upper) == "table" and upper.key and row.key >= upper.key then
				continue
			elseif upper and type(upper) == "string" and row.key >= upper then
				continue
			end
			table.insert(out, row)
			if #out >= (count or 1) then
				break
			end
		end
		return out
	end
	local SortedMapMeta = typed("MemoryStoreSortedMap", sortedMethods)

	local hashMethods = mapMethods("hashes")
	hashMethods.ListItemsAsync = function(self, count)
		local rows = {}
		for key, entry in mapOf("hashes", self._name) do
			if live(entry) then
				table.insert(rows, { key = key, value = stored(entry.value) })
			end
		end
		table.sort(rows, function(a, b)
			return a.key < b.key
		end)
		return pages(rows, count)
	end
	local HashMapMeta = typed("MemoryStoreHashMap", hashMethods)

	local queueIds = 0
	local QueueMeta = typed("MemoryStoreQueue", {
		AddAsync = function(self, value, expiration, priority)
			local queue = mapOf("queues", self._name)
			queueIds += 1
			table.insert(queue, { value = stored(value), expires = expiresIn(expiration), priority = priority or 0, order = queueIds })
			table.sort(queue, function(a, b)
				if a.priority ~= b.priority then
					return a.priority > b.priority
				end
				return a.order < b.order
			end)
		end,
		ReadAsync = function(self, count, allOrNothing, _waitTimeout)
			local queue = mapOf("queues", self._name)
			local items, taken = {}, {}
			for _, item in queue do
				if live(item) and not (item.hiddenUntil and item.hiddenUntil > os.clock()) then
					table.insert(items, stored(item.value))
					table.insert(taken, item)
					if #items >= (count or 1) then
						break
					end
				end
			end
			if #items == 0 or (allOrNothing and #items < (count or 1)) then
				return {}, ""
			end
			queueIds += 1
			local id = `read{queueIds}`
			for _, item in taken do
				item.hiddenUntil = os.clock() + self._invisibility
				item.readId = id
			end
			return items, id
		end,
		RemoveAsync = function(self, id)
			local queue = mapOf("queues", self._name)
			for i = #queue, 1, -1 do
				if queue[i].readId == id then
					table.remove(queue, i)
				end
			end
		end,
		GetSizeAsync = function(self, excludeInvisible)
			local n = 0
			for _, item in mapOf("queues", self._name) do
				if live(item) and not (excludeInvisible and item.hiddenUntil and item.hiddenUntil > os.clock()) then
					n += 1
				end
			end
			return n
		end,
	})

	local memoryHandles = {}
	local function memoryHandle(meta, kind, name, extra)
		assert(type(name) == "string", `{kind}: a name is required`)
		local id = `{kind}\0{name}`
		if not memoryHandles[id] then
			local h = { _name = name, Name = name }
			for k, v in extra or {} do
				h[k] = v
			end
			memoryHandles[id] = setmetatable(h, meta)
		end
		return memoryHandles[id]
	end

	local memoryStoreService = {
		GetSortedMap = function(_, name)
			return memoryHandle(SortedMapMeta, "sorted", name)
		end,
		GetHashMap = function(_, name)
			return memoryHandle(HashMapMeta, "hashes", name)
		end,
		GetQueue = function(_, name, invisibility)
			return memoryHandle(QueueMeta, "queues", name, { _invisibility = invisibility or 30 })
		end,
	}

	return {
		reset = reset,
		dataStoreService = dataStoreService,
		memoryStoreService = memoryStoreService,
	}
end
