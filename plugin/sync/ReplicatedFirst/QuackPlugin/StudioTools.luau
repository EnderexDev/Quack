--!strict
--[[
	Quack: the Studio tools the daemon calls (src/studioTools.ts). Each DataModel's plugin
	answers the ones that run there:
	  edit    exec, playStart, playState, capture, captureRead, key, device
	  server  eval, stop
	  client  eval, captureBegin, key

	Evals run in the game VM with the game's require cache: a bridge Script (server) or
	LocalScript (client) made at runtime in the play DataModel holds a BindableFunction that
	requires a fresh ModuleScript payload, as chrrxs's plugin does (no loadstring, which the play
	peers do not have). The payload is compiled in the plugin VM first, so a syntax error comes
	back as Luau's own text instead of "Requested module experienced an error while loading".
	Measured 08/11/26 in PA: a ModuleScript with no parent is required fine by the game VM, and
	the edit DataModel can read the play client's rbxtemp:// screenshot (22 ms for 1725x1063).
]]

local AssetService = game:GetService("AssetService")
local CaptureService = game:GetService("CaptureService")
local LogService = game:GetService("LogService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local ServerScriptService = game:GetService("ServerScriptService")
local StudioTestService = game:GetService("StudioTestService")
local UserInputService = game:GetService("UserInputService")

local StudioTools = {}

-- The payload's name: errors and tracebacks name it, and are rewritten to "eval:<line>"
local CHUNK = "__QuackEval"
local BRIDGE_NAME = "__QuackEvalBridge"
local INVOKE_NAME = "Invoke"
local MAX_OUTPUT_LINES = 1000

--------------------------------------------------------------------------------------------
-- Is the window drawing? A minimized Studio keeps running scripts but renders no frame, and
-- then virtual input does nothing and a capture never comes back (chrrxs measured a 5 s gap of
-- RenderStepped against 0.1 s of Heartbeat while minimized). The play server renders nothing.

local lastFrame = os.clock()
local watchingFrames = false

function StudioTools.watchRendering()
	if watchingFrames then return end
	watchingFrames = pcall(function()
		RunService.RenderStepped:Connect(function() lastFrame = os.clock() end)
	end)
	lastFrame = os.clock()
end

local function notRendering(): string?
	if not watchingFrames then return nil end
	-- The edit DataModel draws nothing while a play runs (a Run-mode play shows its server):
	-- its stale frames say nothing about the window (measured 08/11/26 in PA)
	if not RunService:IsRunning() and not StudioTestService.EditModeActive then return nil end
	local gap = os.clock() - lastFrame
	if gap > 1 then
		return string.format(
			"the Studio window is minimized or not drawing (no frame for %.1f s): restore it so the viewport renders, then retry",
			gap
		)
	end
	return nil
end

--------------------------------------------------------------------------------------------
-- The payload. Everything before the user's code is on one line, so the code's line N is the
-- module's line N; print and warn are shadowed so what the code prints comes back too.

local PREFIX = table.concat({
	"return (function()",
	'local __quack_http = game:GetService("HttpService")',
	"local __quack_out = {}",
	"local __quack_print, __quack_warn = print, warn",
	'local function __quack_line(...) local n = select("#", ...) local parts = table.create(n) for i = 1, n do parts[i] = tostring((select(i, ...))) end return table.concat(parts, " ") end',
	`local function print(...) __quack_print(...) if #__quack_out < {MAX_OUTPUT_LINES} then table.insert(__quack_out, __quack_line(...)) end end`,
	`local function warn(...) __quack_warn(...) if #__quack_out < {MAX_OUTPUT_LINES} then table.insert(__quack_out, "[warn] " .. __quack_line(...)) end end`,
	"local function __quack_run() ",
}, " ")

local SUFFIX = table.concat({
	"",
	"end",
	"local function __quack_format(v)",
	'  if type(v) == "table" then local ok, s = pcall(__quack_http.JSONEncode, __quack_http, v) if ok then return s end return tostring(v) end',
	'  if typeof(v) == "Instance" then local ok, s = pcall(function() return v:GetFullName() end) return (if ok then s else tostring(v)) .. " (" .. v.ClassName .. ")" end',
	"  return tostring(v)",
	"end",
	"local __quack_ok, __quack_result = xpcall(function() return table.pack(__quack_run()) end, function(e) return debug.traceback(tostring(e), 2) end)",
	"if not __quack_ok then return { ok = false, error = __quack_result, output = __quack_out } end",
	"local __quack_values = {}",
	"for i = 1, __quack_result.n do __quack_values[i] = __quack_format(__quack_result[i]) end",
	"return { ok = true, values = __quack_values, output = __quack_out }",
	"end)()",
}, "\n")

local function countLines(code: string): number
	local _, breaks = string.gsub(code, "\n", "")
	return breaks + 1
end

--- The payload's chunk name becomes "eval", and only the frames that are the user's own stay
local function cleanError(message: string, userLines: number): string
	local kept = {}
	for line in string.gmatch(message, "[^\n]+") do
		line = string.gsub(line, "Workspace%." .. CHUNK .. ":", "eval:")
		line = string.gsub(line, CHUNK .. ":", "eval:")
		-- The user's top level runs inside the wrapper's __quack_run: that frame is the user's
		line = string.gsub(line, " function __quack_run$", "")
		local n = tonumber(string.match(line, "^eval:(%d+)"))
		-- A parse error past the code (an unfinished `1 +`) lands on the wrapper's closing line
		if #kept == 0 and n and n > userLines then
			line = string.gsub(line, "^eval:%d+:", `eval:{userLines} (at the end of the code):`)
			line = string.gsub(line, "got 'end'$", "got the end of the code")
			n = userLines
		end
		local wrapper = string.find(line, "__quack_", 1, true) ~= nil
			or string.find(line, "function xpcall", 1, true) ~= nil
			or string.find(line, "QuackPlugin", 1, true) ~= nil
		-- A frame on a line after the user's code is the wrapper's
		if #kept > 0 and n and n > userLines then wrapper = true end
		-- The frame the message itself already names ("eval:2: attempt to..." then "eval:2")
		if #kept == 1 and line == `eval:{n}` and string.sub(kept[1], 1, #`eval:{n}:`) == `eval:{n}:` then wrapper = true end
		if #kept == 0 then
			table.insert(kept, line)
		elseif not wrapper then
			table.insert(kept, "  at " .. line)
		end
		if #kept >= 20 then break end
	end
	return table.concat(kept, "\n")
end

local function newModule(source: string): ModuleScript
	local module = Instance.new("ModuleScript")
	module.Name = CHUNK
	module.Archivable = false;
	(module :: any).Source = source
	return module
end

local REQUIRE_FAILED = "Requested module experienced an error while loading"

--[=[
	A compile error in the code, as Luau says it, or nil; nothing of the code runs. The edit
	plugin has loadstring; the play peers do not, and there a failed require says only
	REQUIRE_FAILED while Luau's own text goes to the output (measured 08/11/26 in PA), so it is
	read back from LogService.
]=]
local function compileError(code: string): string?
	local source = "return function() " .. code .. "\nend"
	local hasLoadstring, fn, loadError = pcall(loadstring :: any, source, "=eval")
	if hasLoadstring then
		if fn then return nil end
		return cleanError(tostring(loadError), countLines(code))
	end
	local before = #LogService:GetLogHistory()
	local check = newModule(source)
	local ok, err = pcall(require, check)
	check:Destroy()
	if ok then return nil end
	local message = tostring(err)
	if message == REQUIRE_FAILED then
		local prefix = CHUNK .. ":"
		local deadline = os.clock() + 0.5
		repeat
			task.wait(0.03)
			local history = LogService:GetLogHistory()
			for i = #history, before + 1, -1 do
				local entry = history[i]
				if entry.messageType == Enum.MessageType.MessageError and string.sub(entry.message, 1, #prefix) == prefix then
					message = entry.message
					break
				end
			end
		until message ~= REQUIRE_FAILED or os.clock() > deadline
	end
	return cleanError(message, countLines(code))
end

type EvalResult = { ok: boolean, values: { string }?, error: string?, output: { string } }

local function finish(raw: any, userLines: number): EvalResult
	if type(raw) ~= "table" then return { ok = false, error = `the payload returned {typeof(raw)}`, output = {} } end
	local output = if type(raw.output) == "table" then raw.output else {}
	if raw.ok then return { ok = true, values = raw.values or {}, output = output } end
	return { ok = false, error = cleanError(tostring(raw.error), userLines), output = output }
end

--------------------------------------------------------------------------------------------
-- The game-VM bridge, made in the play DataModel by this plugin (it goes away with the play)

local BRIDGE_SOURCE = [[
-- Made by the Quack plugin for its eval tools while Studio plays; inert outside Studio
if not game:GetService("RunService"):IsStudio() then return end
local invoke = Instance.new("BindableFunction")
invoke.Name = "Invoke"
invoke.Archivable = false
invoke.OnInvoke = function(payload)
	if typeof(payload) ~= "Instance" or not payload:IsA("ModuleScript") then
		return { ok = false, error = "the payload must be a ModuleScript" }
	end
	local ok, value = pcall(require, payload)
	if not ok then return { ok = false, error = tostring(value) } end
	return value
end
invoke.Parent = script
]]

local bridge: BaseScript? = nil

local function bridgeParent(): (Instance?, string?)
	if RunService:IsServer() then return ServerScriptService, nil end
	local player = Players.LocalPlayer
	if not player then return nil, "the play client has no LocalPlayer yet" end
	local scripts = player:FindFirstChild("PlayerScripts") or player:WaitForChild("PlayerScripts", 5)
	if not scripts then return nil, "Players.LocalPlayer.PlayerScripts is missing: the eval bridge cannot run" end
	return scripts, nil
end

local function bridgeInvoke(): (BindableFunction?, string?)
	if bridge and bridge.Parent then
		local invoke = bridge:FindFirstChild(INVOKE_NAME)
		if invoke and invoke:IsA("BindableFunction") then return invoke, nil end
	end
	local parent, why = bridgeParent()
	if not parent then return nil, why end
	local old = parent:FindFirstChild(BRIDGE_NAME)
	if old then old:Destroy() end
	local made: BaseScript = if RunService:IsServer() then Instance.new("Script") else Instance.new("LocalScript")
	made.Name = BRIDGE_NAME
	made.Archivable = false
	local ok, err = pcall(function() (made :: any).Source = BRIDGE_SOURCE end)
	if not ok then return nil, `could not write the eval bridge: {err}` end
	made.Parent = parent
	bridge = made
	local invoke = made:WaitForChild(INVOKE_NAME, 5)
	if not invoke or not invoke:IsA("BindableFunction") then
		return nil, "the eval bridge did not start within 5 s (is the game's script loading stuck?)"
	end
	return invoke, nil
end

local function evalInGame(code: string): EvalResult
	local compile = compileError(code)
	if compile then return { ok = false, error = compile, output = {} } end
	local invoke, why = bridgeInvoke()
	if not invoke then error(why, 0) end
	local payload = newModule(PREFIX .. code .. SUFFIX)
	local ok, raw = pcall(function() return invoke:Invoke(payload) end)
	payload:Destroy()
	if not ok then error(`the eval bridge failed: {raw}`, 0) end
	return finish(raw, countLines(code))
end

--- execute_luau: in this plugin's own VM (edit mode), fresh module copies
local function execInPlugin(code: string): EvalResult
	local compile = compileError(code)
	if compile then return { ok = false, error = compile, output = {} } end
	local payload = newModule(PREFIX .. code .. SUFFIX)
	local ok, raw = pcall(require, payload)
	payload:Destroy()
	if not ok then
		-- Only a compile error gets here: the wrapper catches everything the code raises
		return { ok = false, error = cleanError(tostring(raw), countLines(code)), output = {} }
	end
	return finish(raw, countLines(code))
end

--------------------------------------------------------------------------------------------
-- Screenshots: the play client captures (it renders the viewport), the edit DataModel reads the
-- pixels back (the game VM may not open a temporary texture)

local BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local B64: { number } = {}
for i = 1, 64 do
	B64[i - 1] = string.byte(BASE64, i)
end

local function base64(data: buffer): string
	local len = buffer.len(data)
	local triples = len // 3
	local rest = len - triples * 3
	local out = buffer.create((triples + (if rest > 0 then 1 else 0)) * 4)
	local si, di = 0, 0
	for _ = 1, triples do
		local n = bit32.bor(
			bit32.lshift(buffer.readu8(data, si), 16),
			bit32.lshift(buffer.readu8(data, si + 1), 8),
			buffer.readu8(data, si + 2)
		)
		buffer.writeu8(out, di, B64[bit32.rshift(n, 18)])
		buffer.writeu8(out, di + 1, B64[bit32.band(bit32.rshift(n, 12), 63)])
		buffer.writeu8(out, di + 2, B64[bit32.band(bit32.rshift(n, 6), 63)])
		buffer.writeu8(out, di + 3, B64[bit32.band(n, 63)])
		si += 3
		di += 4
	end
	if rest > 0 then
		local b0 = buffer.readu8(data, si)
		local b1 = if rest == 2 then buffer.readu8(data, si + 1) else 0
		local n = bit32.bor(bit32.lshift(b0, 16), bit32.lshift(b1, 8))
		buffer.writeu8(out, di, B64[bit32.rshift(n, 18)])
		buffer.writeu8(out, di + 1, B64[bit32.band(bit32.rshift(n, 12), 63)])
		buffer.writeu8(out, di + 2, if rest == 2 then B64[bit32.band(bit32.rshift(n, 6), 63)] else 61)
		buffer.writeu8(out, di + 3, 61)
	end
	return buffer.tostring(out)
end

local function captureBegin(): { contentId: string }
	local why = notRendering()
	if why then error(why, 0) end
	local contentId: any = nil
	CaptureService:CaptureScreenshot(function(id) contentId = id end)
	local started = os.clock()
	while contentId == nil do
		if os.clock() - started > 10 then
			error(
				"the screenshot never came back in 10 s: the Studio window is likely minimized or covered (restore it so the viewport renders)",
				0
			)
		end
		task.wait(0.03)
	end
	return { contentId = tostring(contentId) }
end

local TILE = 1024
-- Raw RGBA larger than this is not sent (36 MB is a 4K frame): the edit plugin halves it first
local MAX_RAW_BYTES = 36 * 1024 * 1024

local function captureRead(contentId: string): { [string]: any }
	if type(contentId) ~= "string" or contentId == "" then error("contentId is required", 0) end
	local ok, image = pcall(function() return AssetService:CreateEditableImageAsync(Content.fromUri(contentId)) end)
	if not ok then
		error(
			`could not open the screenshot as an EditableImage: {image}. If this mentions permissions, turn on Game Settings > Security > "Allow Mesh / Image APIs"`,
			0
		)
	end
	local source = image :: EditableImage
	local nativeW, nativeH = math.floor(source.Size.X), math.floor(source.Size.Y)
	local w, h = nativeW, nativeH
	if w * h * 4 > MAX_RAW_BYTES then
		local scale = math.sqrt(MAX_RAW_BYTES / (w * h * 4))
		w, h = math.max(1, math.floor(w * scale)), math.max(1, math.floor(h * scale))
		local scaled = AssetService:CreateEditableImage({ Size = Vector2.new(w, h) })
		scaled:DrawImageTransformed(Vector2.zero, Vector2.new(w / nativeW, h / nativeH), 0, source, {
			CombineType = Enum.ImageCombineType.Overwrite,
			SamplingMode = Enum.ResamplerMode.Default,
			PivotPoint = Vector2.zero,
		} :: any)
		source:Destroy()
		source = scaled
	end
	local pixels = buffer.create(w * h * 4)
	local rowBytes = w * 4
	local readOk, readError = pcall(function()
		for ty = 0, h - 1, TILE do
			local tileH = math.min(TILE, h - ty)
			for tx = 0, w - 1, TILE do
				local tileW = math.min(TILE, w - tx)
				local tile = source:ReadPixelsBuffer(Vector2.new(tx, ty), Vector2.new(tileW, tileH))
				for row = 0, tileH - 1 do
					buffer.copy(pixels, (ty + row) * rowBytes + tx * 4, tile, row * tileW * 4, tileW * 4)
				end
			end
		end
	end)
	source:Destroy()
	if not readOk then error(`could not read the screenshot's pixels: {readError}`, 0) end
	return { width = w, height = h, nativeWidth = nativeW, nativeHeight = nativeH, data = base64(pixels) }
end

--------------------------------------------------------------------------------------------
-- Keys

local virtualInput: any = nil

local function key(args: { [string]: any }): { [string]: any }
	local why = notRendering()
	if why then error(why, 0) end
	if not virtualInput then
		local ok, made = pcall(function() return (UserInputService :: any):CreateVirtualInput() end)
		if not ok or not made then error(`UserInputService:CreateVirtualInput() is not available here: {made}`, 0) end
		virtualInput = made
	end
	if type(args.text) == "string" then
		local ok, err = pcall(function() virtualInput:SendTextInput(args.text) end)
		if not ok then error(`could not send the text: {err}`, 0) end
		return { text = args.text }
	end
	local found, keyCode = pcall(function() return (Enum.KeyCode :: any)[args.keyCode] end)
	if not found or typeof(keyCode) ~= "EnumItem" then
		error(`{args.keyCode} is not an Enum.KeyCode name (W, Space, E, LeftShift, One...)`, 0)
	end
	local action = args.action or "tap"
	local ok, err = pcall(function()
		if action == "press" then
			virtualInput:SendKey(true, keyCode)
		elseif action == "release" then
			virtualInput:SendKey(false, keyCode)
		else
			virtualInput:SendKey(true, keyCode)
			task.wait(tonumber(args.duration) or 0.1)
			virtualInput:SendKey(false, keyCode)
		end
	end)
	if not ok then error(`could not send {args.keyCode}: {err}`, 0) end
	return { keyCode = args.keyCode, action = action }
end

--------------------------------------------------------------------------------------------
-- The device simulator (StudioDeviceSimulatorService, from the edit DataModel; it serves the
-- play too)

local function plain(value: any): any
	if typeof(value) == "Vector2" then return { width = value.X, height = value.Y } end
	if typeof(value) == "EnumItem" then return value.Name end
	return value
end

local function enumNamed(enum: Enum, raw: string, label: string): EnumItem
	local name = string.match(raw, "([^%.]+)$") or raw
	local names = {}
	for _, item in enum:GetEnumItems() do
		if item.Name == name then return item end
		table.insert(names, item.Name)
	end
	error(`{label} "{raw}" is not one of: {table.concat(names, ", ")}`, 0)
end

local function device(args: { [string]: any }): { [string]: any }
	local simulator = (game :: any):GetService("StudioDeviceSimulatorService")
	local function state(): { [string]: any }
		local active = tostring(simulator:GetDeviceAsync())
		local out: { [string]: any } = { activeDeviceId = active, isSimulating = active ~= "default" }
		if out.isSimulating then
			local getters: { { string } } = {
				{ "resolution", "GetResolutionAsync" },
				{ "pixelDensity", "GetPixelDensityAsync" },
				{ "orientation", "GetOrientationAsync" },
				{ "scalingMode", "GetScalingModeAsync" },
			}
			for _, pair in getters do
				local ok, value = pcall(function() return simulator[pair[2]](simulator) end)
				if ok then out[pair[1]] = plain(value) end
			end
		end
		return out
	end
	local function deviceIds(): { string }
		local ids = {}
		for _, entry in simulator:GetDeviceListAsync() do
			table.insert(ids, if type(entry) == "table" then tostring(entry.DeviceId or entry.Id or entry[1]) else tostring(entry))
		end
		table.sort(ids)
		return ids
	end

	local settings = args.settings or {}
	local result: { [string]: any } = {}
	if args.stop or next(settings) ~= nil then
		result.before = state()
		local applied = {}
		if args.stop then
			simulator:StopSimulationAsync()
			applied.stopSimulation = true
		end
		if settings.deviceId then
			local ids = deviceIds()
			if not table.find(ids, settings.deviceId) then
				error(`"{settings.deviceId}" is not a built-in device; they are: {table.concat(ids, ", ")}`, 0)
			end
			simulator:SetDeviceAsync(settings.deviceId)
			applied.deviceId = settings.deviceId
		end
		if settings.orientation then
			local item = enumNamed(Enum.ScreenOrientation, settings.orientation, "orientation")
			simulator:SetOrientationAsync(item)
			applied.orientation = item.Name
		end
		if settings.resolution then
			simulator:SetResolutionAsync(settings.resolution.width, settings.resolution.height)
			applied.resolution = settings.resolution
		end
		if settings.pixelDensity then
			simulator:SetPixelDensityAsync(settings.pixelDensity)
			applied.pixelDensity = settings.pixelDensity
		end
		if settings.scalingMode then
			local item = enumNamed((Enum :: any).DeviceSimulatorScalingMode, settings.scalingMode, "scalingMode")
			simulator:SetScalingModeAsync(item)
			applied.scalingMode = item.Name
		end
		result.applied = applied
		result.after = state()
	else
		for k, v in state() do
			result[k] = v
		end
	end
	if args.list then result.devices = deviceIds() end
	return result
end

--------------------------------------------------------------------------------------------

export type Role = "edit" | "server" | "client"

local function codeOf(args: { [string]: any }): string
	if type(args.code) ~= "string" or args.code == "" then error("code is required", 0) end
	return args.code
end

local HANDLERS: { [string]: { [Role]: (args: { [string]: any }) -> any } } = {
	eval = {
		server = function(args) return evalInGame(codeOf(args)) end,
		client = function(args) return evalInGame(codeOf(args)) end,
	},
	exec = { edit = function(args) return execInPlugin(codeOf(args)) end },
	playState = { edit = function() return { editModeActive = StudioTestService.EditModeActive } end },
	playStart = {
		edit = function(args)
			if not StudioTestService.EditModeActive then error("a play is already running: stop it first", 0) end
			local run = args.mode == "run"
			task.spawn(function()
				local ok, err = pcall(function()
					if run then
						return StudioTestService:ExecuteRunModeAsync({})
					end
					return StudioTestService:ExecutePlayModeAsync({})
				end)
				if not ok then warn("[Quack]: the play ended with an error:", err) end
			end)
			return { mode = if run then "run" else "play" }
		end,
	},
	stop = {
		server = function()
			local ok, err = pcall(function() StudioTestService:EndTest("quack") end)
			if not ok then error(`StudioTestService:EndTest failed: {err}`, 0) end
			return { stopping = true }
		end,
	},
	captureBegin = { client = function() return captureBegin() end },
	captureRead = { edit = function(args) return captureRead(args.contentId) end },
	capture = { edit = function() return captureRead(captureBegin().contentId) end },
	key = { client = key, edit = key },
	device = { edit = device },
}

--[=[
	Runs one tool call. Returns ok and the result, or false and the reason (Luau's own text).
	Yields: run it off the socket's message handler.
]=]
function StudioTools.handle(tool: string, args: any, role: Role): (boolean, any)
	local byRole = HANDLERS[tool]
	if not byRole then return false, `this plugin has no tool {tool} (an older plugin than the daemon?)` end
	local handler = byRole[role]
	if not handler then return false, `{tool} does not run in the {role} DataModel` end
	local ok, result = pcall(handler, if type(args) == "table" then args else {})
	if not ok then return false, tostring(result) end
	return true, result
end

--- The toolResult message for a toolRequest, ready to encode
function StudioTools.answer(request: any, role: Role): { [string]: any }
	local ok, result = StudioTools.handle(request.tool, request.args, role)
	if ok then return { type = "toolResult", id = request.id, ok = true, result = result } end
	return { type = "toolResult", id = request.id, ok = false, error = result }
end

return StudioTools
