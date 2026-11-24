--!nocheck
-- Quack Test: RBXScriptSignal and RBXScriptConnection, which Lune does not have. Each handler
-- runs in its own thread, in the realm (server or client) that connected it, through the
-- spawn the realm module gives: an error there is the test's, never the run's.

local task = require("@lune/task")

return function(spawnIn: (realm: string, fn: (...any) -> ...any, ...any) -> (), currentRealm: () -> string)
	local Signal = {}
	Signal.__index = Signal
	Signal.__type = "RBXScriptSignal"
	Signal.__tostring = function()
		return "Signal"
	end

	local Connection = {}
	Connection.__index = Connection
	Connection.__type = "RBXScriptConnection"

	function Connection:Disconnect()
		if not self.Connected then
			return
		end
		self.Connected = false
		local list = self._signal._connections
		local at = table.find(list, self)
		if at then
			table.remove(list, at)
		end
	end
	Connection.disconnect = Connection.Disconnect

	-- options.queue: fires with no connection wait for the first one (a remote's events do)
	-- options.onFirstConnect: called once, when the first handler connects (a watch starts)
	function Signal.new(options: { queue: boolean?, onFirstConnect: (() -> ())? }?)
		return setmetatable({
			_connections = {},
			_pending = if options and options.queue then {} else nil,
			_onFirstConnect = options and options.onFirstConnect,
		}, Signal)
	end

	function Signal:Connect(fn)
		assert(type(fn) == "function", "Attempt to connect failed: Passed value is not a function")
		local connection = setmetatable({ Connected = true, _signal = self, _fn = fn, _realm = currentRealm() }, Connection)
		table.insert(self._connections, connection)
		if self._onFirstConnect then
			local start = self._onFirstConnect
			self._onFirstConnect = nil
			start()
		end
		local pending = self._pending
		if pending and #pending > 0 then
			self._pending = {}
			for _, args in pending do
				spawnIn(connection._realm, fn, table.unpack(args, 1, args.n))
			end
		end
		return connection
	end
	Signal.connect = Signal.Connect
	Signal.ConnectParallel = Signal.Connect

	function Signal:Once(fn)
		local connection
		connection = self:Connect(function(...)
			connection:Disconnect()
			fn(...)
		end)
		return connection
	end

	function Signal:Wait()
		local thread = coroutine.running()
		self:Once(function(...)
			task.spawn(thread, ...)
		end)
		return coroutine.yield()
	end
	Signal.wait = Signal.Wait

	function Signal:Fire(...)
		if #self._connections == 0 and self._pending then
			table.insert(self._pending, table.pack(...))
			return
		end
		for _, connection in table.clone(self._connections) do
			if connection.Connected then
				spawnIn(connection._realm, connection._fn, ...)
			end
		end
	end

	function Signal:HasConnections(): boolean
		return #self._connections > 0
	end

	function Signal:DisconnectAll()
		for _, connection in table.clone(self._connections) do
			connection:Disconnect()
		end
	end

	return Signal
end
