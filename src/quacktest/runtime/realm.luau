--!nocheck
-- Quack Test: the two sides of a play in one Lune process. Every thread belongs to a realm,
-- "server" or "client"; RunService:IsServer() answers for the calling thread, modules load once
-- per realm, and a thread started by task or coroutine inherits its creator's realm. A thread
-- with no realm (a spec's own code) is the server, as in Studio.
--
-- The idea of tagging threads by realm comes from LuneTest's simulated network (MIT, Austin
-- Barikdar; see NOTICE.md).

local task = require("@lune/task")

return function(ctx)
	local realmOf: { [thread]: string } = setmetatable({}, { __mode = "k" })

	local function current(): string
		return realmOf[coroutine.running()] or "server"
	end

	-- An error in a thread the game started: the running test's, said in its report
	local function threadFailed(realm: string, err: any)
		ctx.threadError(`[{realm}] {ctx.message(err)}`, err)
	end

	local function wrap(realm: string, fn: (...any) -> ...any): thread
		local co = coroutine.create(function(...)
			local ok, err = xpcall(fn, ctx.capture, ...)
			if not ok then
				threadFailed(realm, err)
			end
		end)
		realmOf[co] = realm
		return co
	end

	local function spawnIn(realm: string, fn: (...any) -> ...any, ...: any)
		task.spawn(wrap(realm, fn), ...)
	end

	-- task and coroutine as the game sees them: new threads keep the creator's realm, and an
	-- error in one is reported instead of printed
	local realmTask = table.clone(task)
	local function tagged(fn: any): any
		if type(fn) ~= "function" then
			return fn -- a thread already made
		end
		return wrap(current(), fn)
	end
	realmTask.spawn = function(fn, ...)
		return task.spawn(tagged(fn), ...)
	end
	realmTask.defer = function(fn, ...)
		return task.defer(tagged(fn), ...)
	end
	realmTask.delay = function(seconds, fn, ...)
		return task.delay(seconds or 0, tagged(fn), ...)
	end
	realmTask.wait = function(seconds)
		-- Lune's wait reports ~1 ms for a frame that took ~15 ms on Windows: the clock tells
		local started = os.clock()
		task.wait(seconds)
		return os.clock() - started
	end
	realmTask.synchronize = function() end
	realmTask.desynchronize = function() end

	local realmCoroutine = table.clone(coroutine)
	realmCoroutine.create = function(fn)
		local co = coroutine.create(fn)
		realmOf[co] = current()
		return co
	end
	realmCoroutine.wrap = function(fn)
		local co = realmCoroutine.create(fn)
		return function(...)
			local result = table.pack(coroutine.resume(co, ...))
			if not result[1] then
				error(result[2], 2)
			end
			return table.unpack(result, 2, result.n)
		end
	end

	-- Runs fn as that realm and waits for it; errors come back to the caller
	local function runAs(realm: string, fn: (...any) -> ...any, ...: any): ...any
		local result
		local co = coroutine.create(function(...)
			result = table.pack(xpcall(fn, ctx.capture, ...))
		end)
		realmOf[co] = realm
		task.spawn(co, ...)
		while result == nil do
			task.wait()
		end
		if not result[1] then
			error(result[2], 0)
		end
		return table.unpack(result, 2, result.n)
	end

	return {
		current = current,
		spawnIn = spawnIn,
		task = realmTask,
		coroutine = realmCoroutine,
		runAs = runAs,
	}
end
