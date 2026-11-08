--!strict
--[[
	Relays playtest output to the Daemon's `/studio-output` endpoint.
	Runs inside the Solo playtest server and client DataModels.
]]

local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")
local RunService = game:GetService("RunService")

local StudioTools = require("./StudioTools")
local WebSocketClient = require("./WebSocketClient")

local MAX_PENDING_MESSAGES = 500 -- Messages buffered while the socket is opening

local OutputRelay = {}

--[=[
	Opens a WebSocket to the Daemon and forwards every LogService message to it.
	Relaying stops for good once the socket closes or errors.

	Quack: the socket also answers the daemon's tool calls (evals, a stop, a capture, keys;
	StudioTools.luau), so both play peers open it whatever the output setting. Its first message
	says which peer this is and whether the daemon log shows the output; the output is relayed
	either way, for the get_runtime_logs tool.

	@param wsUrl The Daemon WebSocket URL from Config (scheme optional).
	@param logToDaemon Show the output in the daemon log too (the "stream solo output" setting)
	@return A function that sends one more JSON message on the same socket (Quack: the check
	of a `quackdev play`), queued until the socket opens
]=]
function OutputRelay.start(wsUrl: string, logToDaemon: boolean?): (message: { [string]: any }) -> ()
	-- Quack: the place goes along so the hub can route the output to that game's session
	local url = WebSocketClient.normalizeUrl(wsUrl):gsub("/+$", "") .. "/studio-output?placeId=" .. tostring(game.PlaceId)
	local ok, result = pcall(
		function()
			return HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, {
				Url = url,
			})
		end
	)
	if not ok then
		warn(`[Quack]: Playtest output relay could not connect to {url}: {result}`)
		return function() end
	end

	local client = result :: WebStreamClient
	local source = if RunService:IsServer() then "server" else "client"
	local pending: { string } = {}
	local isOpen = false
	local messageConnection: RBXScriptConnection
	local requestConnection: RBXScriptConnection? = nil

	local function stop()
		isOpen = false
		messageConnection:Disconnect()
		if requestConnection then requestConnection:Disconnect() end
		table.clear(pending)
	end

	-- Sends are pcall'd: an uncaught send error would be logged, relayed, and fail again.
	local function send(encoded: string)
		if not pcall(client.Send, client, encoded) then stop() end
	end

	-- Quack: first on the socket, before the output buffered while it opened
	local hello = HttpService:JSONEncode({ type = "peerHello", source = source, log = logToDaemon == true })

	local function flush()
		if isOpen then return end
		isOpen = true
		send(hello)
		for _, encoded in pending do
			send(encoded)
		end
		table.clear(pending)
	end

	local function relay(message: string, messageType: Enum.MessageType, timestamp: number)
		local encoded = HttpService:JSONEncode({
			type = "studioOutput",
			message = message,
			messageType = messageType.Name,
			source = source,
			timestamp = timestamp, -- Taken when logged so buffered messages keep their real time
		})

		if isOpen then
			send(encoded)
		else
			-- Keep the most recent output: remove the oldest once the buffer is full
			if #pending >= MAX_PENDING_MESSAGES then table.remove(pending, 1) end
			table.insert(pending, encoded)
		end
	end

	-- Previous messages are removed when a playtest is started, so getting the log history is fine
	for _, entry in LogService:GetLogHistory() do
		relay(entry.message, entry.messageType, entry.timestamp * 1000)
	end

	messageConnection = LogService.MessageOut:Connect(
		function(message, messageType) relay(message, messageType, DateTime.now().UnixTimestampMillis) end
	)

	-- Quack: the daemon's tool calls, each answered on this socket once it is done
	local role: StudioTools.Role = if source == "server" then "server" else "client"
	if role == "client" then StudioTools.watchRendering() end
	requestConnection = client.MessageReceived:Connect(function(text: string)
		local decoded, request = pcall(HttpService.JSONDecode, HttpService, text)
		if not decoded or type(request) ~= "table" or request.type ~= "toolRequest" then return end
		task.spawn(function()
			local answer = StudioTools.answer(request, role)
			local encodedOk, encoded = pcall(HttpService.JSONEncode, HttpService, answer)
			if not encodedOk then
				encoded = HttpService:JSONEncode({
					type = "toolResult",
					id = request.id,
					ok = false,
					error = `the answer could not be encoded as JSON: {encoded}`,
				})
			end
			if isOpen then send(encoded) end
		end)
	end)

	client.Opened:Connect(flush)
	client.Closed:Connect(stop)
	client.Error:Connect(function(statusCode: number, errorMessage: string)
		if not messageConnection.Connected then return end
		stop() -- Disconnects the log listener first so this warning isn't relayed
		warn(`[Quack]: Playtest output relay stopped ({statusCode}): {errorMessage}`)
	end)
	if client.ConnectionState == Enum.WebStreamClientState.Open then flush() end

	return function(message: { [string]: any })
		local encoded = HttpService:JSONEncode(message)
		if isOpen then
			send(encoded)
		elseif messageConnection.Connected then
			table.insert(pending, encoded)
		end
	end
end

return OutputRelay
