--!strict
--[[
	Quack: the Studio tools the daemon calls (src/studioTools.ts). Each DataModel's plugin
	answers the ones that run there:
	  edit    exec, playStart (solo, Run mode, or a multiplayer test with players), playState,
	          capture, captureRead, captureBurst, key, device, gui, sourceCheck, logpoint,
	          exportRbxm, importRbxm, inspect, setProps, simulate, tabs, assetPreview, assetInsert,
	          memory, scene
	  server  eval, stop, perf, inspect, setProps, memory, profiler, scene
	  client  eval, captureBegin, captureBurst, key, click, gui, mouse, perf, inspect, setProps,
	          simulate, memory, profiler, scene

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
local GuiService = game:GetService("GuiService")
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

--- A line of the prelude is "prelude:N", one of the code "eval:N" counted from the code's own line 1
local function relabel(line: string, offset: number): string
	if offset <= 0 then return line end
	return (string.gsub(line, "eval:(%d+)", function(raw)
		local n = tonumber(raw) :: number
		return if n <= offset then `prelude:{n}` else `eval:{n - offset}`
	end))
end

--- The payload's chunk name becomes "eval", and only the frames that are the user's own stay.
--- `offset`: the lines of a prelude before the code
local function cleanError(message: string, userLines: number, offset: number?): string
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
	for i, line in kept do
		kept[i] = relabel(line, offset or 0)
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
local function compileError(code: string, offset: number?): string?
	local source = "return function() " .. code .. "\nend"
	local hasLoadstring, fn, loadError = pcall(loadstring :: any, source, "=eval")
	if hasLoadstring then
		if fn then return nil end
		return cleanError(tostring(loadError), countLines(code), offset)
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
	return cleanError(message, countLines(code), offset)
end

type EvalResult = { ok: boolean, values: { string }?, error: string?, output: { string } }

local function finish(raw: any, userLines: number, offset: number?): EvalResult
	if type(raw) ~= "table" then return { ok = false, error = `the payload returned {typeof(raw)}`, output = {} } end
	local output = if type(raw.output) == "table" then raw.output else {}
	if raw.ok then return { ok = true, values = raw.values or {}, output = output } end
	return { ok = false, error = cleanError(tostring(raw.error), userLines, offset), output = output }
end

--[=[
	The code with the place's prelude before it (the daemon reads quack-prelude/<peer>.luau): its
	locals are the code's. The prelude's lines are counted so errors keep naming the code's own.
]=]
local function withPrelude(args: { [string]: any }, code: string): (string, number)
	local prelude = args.prelude
	if type(prelude) ~= "string" or prelude == "" then return code, 0 end
	return prelude .. "\n" .. code, countLines(prelude)
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

local function evalInGame(code: string, offset: number?): EvalResult
	local compile = compileError(code, offset)
	if compile then return { ok = false, error = compile, output = {} } end
	local invoke, why = bridgeInvoke()
	if not invoke then error(why, 0) end
	local payload = newModule(PREFIX .. code .. SUFFIX)
	local ok, raw = pcall(function() return invoke:Invoke(payload) end)
	payload:Destroy()
	if not ok then error(`the eval bridge failed: {raw}`, 0) end
	return finish(raw, countLines(code), offset)
end

--- execute_luau: in this plugin's own VM (edit mode), fresh module copies
local function execInPlugin(code: string, offset: number?): EvalResult
	local compile = compileError(code, offset)
	if compile then return { ok = false, error = compile, output = {} } end
	local payload = newModule(PREFIX .. code .. SUFFIX)
	local ok, raw = pcall(require, payload)
	payload:Destroy()
	if not ok then
		-- Only a compile error gets here: the wrapper catches everything the code raises
		return { ok = false, error = cleanError(tostring(raw), countLines(code), offset), output = {} }
	end
	return finish(raw, countLines(code), offset)
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

-- A screenshot's focus (set further down, where paths are resolved): a GUI object gives the part
-- of the screen to keep, a part or model moves the camera onto it until the capture is back
local captureFocus: ((focus: string) -> ({ [string]: number }?, (() -> ())?))? = nil

local function captureBegin(args: { [string]: any }?): { [string]: any }
	local why = notRendering()
	if why then error(why, 0) end
	local rect, restore = nil, nil
	local focus = args and args.focus
	if type(focus) == "string" and focus ~= "" and captureFocus then
		rect, restore = (captureFocus :: any)(focus)
	end
	local contentId: any = nil
	local ok, err = pcall(function()
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
	end)
	if restore then restore() end
	if not ok then error(err, 0) end
	return { contentId = tostring(contentId), rect = rect }
end

local TILE = 1024
-- Raw RGBA larger than this is not sent (36 MB is a 4K frame): the edit plugin halves it first
local MAX_RAW_BYTES = 36 * 1024 * 1024

--- `maxWidth`: scaled down to that width first (a recording's frames), else only below MAX_RAW_BYTES
local function captureRead(contentId: string, maxWidth: number?): { [string]: any }
	if type(contentId) ~= "string" or contentId == "" then error("contentId is required", 0) end
	local ok, image = pcall(function() return AssetService:CreateEditableImageAsync(Content.fromUri(contentId)) end)
	if not ok then
		error(
			`could not open the screenshot as an EditableImage: {image}. If this mentions permissions, turn on Game Settings > Security > "Allow Mesh / Image APIs"`,
			0
		)
	end
	-- Out of EditableImage memory budget, the engine answers nil instead of an error
	if image == nil then error("Studio has no EditableImage memory left to open the screenshot: try again in a moment", 0) end
	local source = image :: EditableImage
	local nativeW, nativeH = math.floor(source.Size.X), math.floor(source.Size.Y)
	local w, h = nativeW, nativeH
	local scale = 1
	if w * h * 4 > MAX_RAW_BYTES then scale = math.sqrt(MAX_RAW_BYTES / (w * h * 4)) end
	if type(maxWidth) == "number" and maxWidth >= 16 and w * scale > maxWidth then scale = maxWidth / w end
	if scale < 1 then
		w, h = math.max(1, math.floor(w * scale)), math.max(1, math.floor(h * scale))
		local made, scaled = pcall(function()
			local target = AssetService:CreateEditableImage({ Size = Vector2.new(w, h) })
			if target == nil then error("no EditableImage memory left to scale it", 0) end
			local drawn, drawError = pcall(function()
				target:DrawImageTransformed(Vector2.zero, Vector2.new(w / nativeW, h / nativeH), 0, source, {
					CombineType = Enum.ImageCombineType.Overwrite,
					SamplingMode = Enum.ResamplerMode.Default,
					PivotPoint = Vector2.zero,
				} :: any)
			end)
			if not drawn then
				target:Destroy()
				error(drawError, 0)
			end
			return target
		end)
		-- The native frame goes either way: a recording reads dozens, each one holds memory
		source:Destroy()
		if not made then error(`could not scale the screenshot: {scaled}`, 0) end
		source = scaled :: EditableImage
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

--[=[
	A recording's frames: a capture every 1/fps s for `seconds`, each one asked for without
	waiting on the one before (a capture comes back ~0.4 s later). Only the content ids come back;
	the edit DataModel reads the pixels after the recording, so that work never steals frames
	from what is being recorded. Measured 08/11/26 in PA: 10 captures a second all came back,
	rbxtemp ids stay readable afterwards, 75 captures held +9 MB, and the game itself drew 41
	fps while capturing at 5 a second (166 without).
]=]
local function captureBurst(args: { [string]: any }): { [string]: any }
	local why = notRendering()
	if why then error(why, 0) end
	local seconds = math.clamp(tonumber(args.seconds) or 3, 0.1, 15)
	local fps = math.clamp(tonumber(args.fps) or 5, 1, 30)
	local frames: { { at: number, contentId: string? } } = {}
	local waiting = 0
	local drawn = 0
	local counting = RunService.RenderStepped:Connect(function() drawn += 1 end)
	local started = os.clock()
	local nextAt = started
	while os.clock() - started < seconds do
		local now = os.clock()
		-- More than a second of captures still out: the window stopped drawing
		if now >= nextAt and waiting <= fps then
			local frame: { at: number, contentId: string? } = { at = math.floor((now - started) * 1000) }
			table.insert(frames, frame)
			waiting += 1
			CaptureService:CaptureScreenshot(function(id)
				frame.contentId = tostring(id)
				waiting -= 1
			end)
			nextAt += 1 / fps
			-- Behind (a long frame): no burst to catch up, the gap shows in the frame times
			if nextAt < now then nextAt = now end
		end
		task.wait()
	end
	local elapsed = os.clock() - started
	counting:Disconnect()
	local deadline = os.clock() + 10
	while waiting > 0 and os.clock() < deadline do
		task.wait(0.03)
	end
	local done = {}
	for _, frame in frames do
		if frame.contentId then table.insert(done, frame) end
	end
	if #done == 0 then
		error("no capture came back in 10 s: the Studio window is likely minimized or covered (restore it so the viewport renders)", 0)
	end
	return { frames = done, asked = #frames, seconds = elapsed, gameFps = drawn / elapsed }
end

--------------------------------------------------------------------------------------------
-- Clicking a GUI button by its path, in the play client. The point is computed here, so
-- display scaling (125% on Ender's PC) and the device simulator change nothing: chrrxs takes
-- screenshot pixels, which miss at any scale but 100%.

-- One per DataModel, shared with the keys: a key pressed in one call is released by the next
local virtualInput: any = nil

--[=[
	The instance a path names, read from the play client: "Players.LocalPlayer.PlayerGui.Shop.Buy",
	"PlayerGui.Shop.Buy", or "StarterGui.Shop.Buy" (the player's copy in PlayerGui). A name with
	dots in it is found too: the longest run of parts that names a child wins.
]=]
local function resolvePath(raw: string): Instance
	local parts = string.split(raw, ".")
	if parts[1] == "game" then table.remove(parts, 1) end
	if #parts == 0 or parts[1] == "" then error("the path is empty", 0) end
	-- Studio sets LocalPlayer in edit mode too (measured 08/11/26 in PA): only a play has a PlayerGui
	local player = if RunService:IsRunning() then Players.LocalPlayer else nil
	local node: Instance? = nil
	local i = 2
	if not player and parts[1] == "PlayerGui" then
		error("there is no PlayerGui outside a play client: name StarterGui.<...> to read the place's own copy", 0)
	elseif not player and parts[1] == "Players" and parts[2] == "LocalPlayer" then
		error("there is no LocalPlayer outside a play client", 0)
	elseif player and (parts[1] == "StarterGui" or parts[1] == "PlayerGui") then
		node = player:FindFirstChildOfClass("PlayerGui")
		if not node then error("the play client has no PlayerGui yet", 0) end
	elseif parts[1] == "Players" and parts[2] == "LocalPlayer" then
		node = player
		i = 3
	else
		local ok, service = pcall(game.GetService, game, parts[1])
		node = if ok and service then service else game:FindFirstChild(parts[1])
	end
	if not node then error(`the game has no {parts[1]}`, 0) end
	local found = node :: Instance
	while i <= #parts do
		local child: Instance? = nil
		for j = #parts, i, -1 do
			child = found:FindFirstChild(table.concat(parts, ".", i, j))
			if child then
				i = j + 1
				break
			end
		end
		if not child then
			local names = {}
			for _, c in found:GetChildren() do
				if #names >= 12 then
					table.insert(names, "...")
					break
				end
				table.insert(names, c.Name)
			end
			local listed = if #names > 0 then `its children: {table.concat(names, ", ")}` else "it has no children"
			error(`{found:GetFullName()} has no child "{parts[i]}" ({listed})`, 0)
		end
		found = child :: Instance
	end
	return found
end

--- Why `button` cannot be clicked where a player would click it, or nil
local function hiddenBecause(button: GuiButton, layer: LayerCollector): string?
	if layer:IsA("ScreenGui") and not layer.Enabled then return `its ScreenGui {layer:GetFullName()} is disabled (Enabled = false)` end
	local node: Instance? = button
	while node and node ~= layer do
		if node:IsA("GuiObject") and not node.Visible then
			return if node == button then "it is hidden (Visible = false)" else `it is hidden: {node:GetFullName()} has Visible = false`
		end
		node = node.Parent
	end
	local interactable, value = pcall(function() return (button :: any).Interactable end)
	if interactable and value == false then return "it is not interactable (Interactable = false)" end
	return nil
end

--[=[
	The screen's top-left corner in GUI space, and the screen's size: virtual input counts pixels
	from that corner. A ScreenGui that ignores every inset covers the whole screen. Measured
	08/11/26: (0, -58) at 1380x850 normally (the top bar), (-47, -58) at 844x390 under the iPhone
	14 simulator in landscape (its notch), where adding only GuiService:GetGuiInset() put a click
	47 px left, on the next button.
]=]
local function screenOrigin(playerGui: Instance): (Vector2, Vector2)
	local probe = Instance.new("ScreenGui")
	probe.Name = "__QuackClickProbe"
	probe.Archivable = false
	probe.IgnoreGuiInset = true
	pcall(function() (probe :: any).ScreenInsets = Enum.ScreenInsets.None end)
	probe.Parent = playerGui
	-- At most half a second: a window that stops drawing must not leave the probe behind
	local deadline = os.clock() + 0.5
	while probe.AbsoluteSize.X <= 0 and os.clock() < deadline do
		task.wait()
	end
	local origin, size = probe.AbsolutePosition, probe.AbsoluteSize
	probe:Destroy()
	if size.X <= 0 then
		local inset = GuiService:GetGuiInset()
		local viewport = workspace.CurrentCamera and workspace.CurrentCamera.ViewportSize or Vector2.zero
		return -inset, viewport
	end
	return origin, size
end

--- Waits a few frames for the button's signals; true once either fired
local function firedWithin(fired: { activated: boolean, click: boolean }, seconds: number): boolean
	local deadline = os.clock() + seconds
	while not (fired.activated or fired.click) and os.clock() < deadline do
		task.wait()
	end
	return fired.activated or fired.click
end

local function click(args: { [string]: any }): { [string]: any }
	if type(args.path) ~= "string" or args.path == "" then error("path is required (e.g. PlayerGui.Shop.Frame.Buy)", 0) end
	local method = args.method or "auto"
	if method ~= "auto" and method ~= "input" and method ~= "select" then error("method must be auto, input or select", 0) end
	local why = notRendering()
	if why then error(why, 0) end
	local started = os.clock()
	local target = resolvePath(args.path)
	if not target:IsA("GuiButton") then
		error(`{target:GetFullName()} is a {target.ClassName}, not a GuiButton (TextButton or ImageButton)`, 0)
	end
	local button = target :: GuiButton
	local playerGui = Players.LocalPlayer:FindFirstChildOfClass("PlayerGui")
	if not playerGui or not button:IsDescendantOf(playerGui) then
		error(`{button:GetFullName()} is not in the player's PlayerGui: only that copy is on screen`, 0)
	end
	local layer = button:FindFirstAncestorWhichIsA("LayerCollector")
	if not layer then error(`{button:GetFullName()} is not inside a ScreenGui`, 0) end
	local hidden = hiddenBecause(button, layer)
	if hidden then error(`{button:GetFullName()}: {hidden}`, 0) end
	-- First, since it may wait a frame: the button's place is read after it, with no wait between
	-- that and the click (a moving button would be clicked where it was)
	local origin, screen = screenOrigin(playerGui)
	-- A button made this frame has no size until the next one
	local sizeDeadline = os.clock() + 0.5
	while (button.AbsoluteSize.X <= 0 or button.AbsoluteSize.Y <= 0) and os.clock() < sizeDeadline do
		task.wait()
	end
	local size = button.AbsoluteSize
	if size.X <= 0 or size.Y <= 0 then error(`{button:GetFullName()} has zero size ({size.X}x{size.Y} pixels)`, 0) end

	-- GUI space (AbsolutePosition, GetGuiObjectsAtPosition) starts below the top bar and, under
	-- the device simulator, right of the notch; virtual input counts from the screen's corner
	local center = button.AbsolutePosition + size / 2
	local point = center - origin
	local onScreen = point.X >= 0 and point.Y >= 0 and point.X < screen.X and point.Y < screen.Y
	local cover: string? = nil
	local underCenter = false
	if layer:IsA("ScreenGui") and onScreen then
		for _, object in playerGui:GetGuiObjectsAtPosition(center.X, center.Y) do
			if object == button then
				underCenter = true
				break
			end
			-- Front to back: a button or text box in front takes the click (an Active Frame did not)
			if object:IsA("GuiButton") or object:IsA("TextBox") then
				cover = object:GetFullName()
				break
			end
		end
	end
	local result: { [string]: any } = {
		path = button:GetFullName(),
		x = math.round(point.X),
		y = math.round(point.Y),
		screen = { width = math.round(screen.X), height = math.round(screen.Y) },
		origin = { x = origin.X, y = origin.Y },
	}
	if method ~= "select" then
		local cause: string? = nil
		if not layer:IsA("ScreenGui") then
			cause = `it is in a {layer.ClassName}, not on the screen`
		elseif not onScreen then
			cause =
				`its center is off-screen at ({math.round(point.X)}, {math.round(point.Y)}) on a {math.round(screen.X)}x{math.round(screen.Y)} screen`
		elseif cover then
			cause = `{cover} is in front of its center`
		elseif not underCenter then
			cause = "its center is not on screen: clipped by an ancestor with ClipsDescendants, or scrolled out of its ScrollingFrame"
		end
		if cause then
			error(`{button:GetFullName()} cannot be clicked: {cause}{if method == "auto" then " (method select clicks it anyway, as a gamepad would)" else ""}`, 0)
		end
	end

	local fired = { activated = false, click = false }
	local connections = {
		button.Activated:Connect(function() fired.activated = true end),
		button.MouseButton1Click:Connect(function() fired.click = true end),
	}
	if not virtualInput then
		local ok, made = pcall(function() return (UserInputService :: any):CreateVirtualInput() end)
		if not ok or not made then error(`UserInputService:CreateVirtualInput() is not available here: {made}`, 0) end
		virtualInput = made
	end
	local used = method
	local sendError: string? = nil
	if method ~= "select" then
		used = "input"
		-- Where the engine saw the press, in GUI space: a press anywhere but the button's center
		-- hit something else, and selecting the button afterwards would hide that
		-- (under the device simulator the press arrives as Touch: measured 08/11/26)
		local landed: Vector2? = nil
		local watching = UserInputService.InputBegan:Connect(function(input)
			local kind = input.UserInputType
			if (kind == Enum.UserInputType.MouseButton1 or kind == Enum.UserInputType.Touch) and not landed then
				landed = Vector2.new(input.Position.X, input.Position.Y)
				result.landedAs = kind.Name
			end
		end)
		local ok, err = pcall(function()
			virtualInput:SendMouseButton(point, Enum.UserInputType.MouseButton1, true)
			task.wait(0.05)
			virtualInput:SendMouseButton(point, Enum.UserInputType.MouseButton1, false)
		end)
		if not ok then sendError = tostring(err) end
		firedWithin(fired, 0.5)
		watching:Disconnect()
		if landed then
			local at = landed :: Vector2
			result.landed = { x = math.round(at.X), y = math.round(at.Y) }
			if not (fired.activated or fired.click) and (at - center).Magnitude > 2 then
				for _, connection in connections do
					connection:Disconnect()
				end
				error(
					`{button:GetFullName()}: the virtual click at ({result.x}, {result.y}) landed at ({math.round(at.X)}, {math.round(at.Y)}) in GUI space, not on the button's center ({math.round(center.X)}, {math.round(center.Y)}), so it may have clicked something else; not retried with select`,
					0
				)
			end
		end
	end
	-- Selecting it and pressing Return, as a gamepad does: the house rule's measured way
	if method == "select" or (method == "auto" and not (fired.activated or fired.click)) then
		used = "select"
		local wasSelectable = button.Selectable
		local previous = GuiService.SelectedObject
		local ok, err = pcall(function()
			button.Selectable = true
			GuiService.SelectedObject = button
			virtualInput:SendKey(true, Enum.KeyCode.Return)
			task.wait(0.05)
			virtualInput:SendKey(false, Enum.KeyCode.Return)
		end)
		if not ok then sendError = tostring(err) end
		firedWithin(fired, 0.5)
		pcall(function()
			GuiService.SelectedObject = if previous and previous.Parent and previous ~= button then previous else nil
			button.Selectable = wasSelectable
		end)
	end
	for _, connection in connections do
		connection:Disconnect()
	end
	if not (fired.activated or fired.click) then
		local tried = if method == "auto" then "a virtual mouse click and then selecting it with Return" else `method {method}`
		error(`{button:GetFullName()} did not fire Activated or MouseButton1Click after {tried}{if sendError then ` ({sendError})` else ""}`, 0)
	end
	result.method = used
	result.activated = fired.activated
	result.mouseButton1Click = fired.click
	result.ms = math.round((os.clock() - started) * 1000)
	return result
end

--------------------------------------------------------------------------------------------
-- Reading a GUI: the tree under a path as the player sees it. Sessions read PlayerGui in two of
-- every three client evals (4732 of 6934, 05/10-07/11), each building its own table.concat.

local function getVirtualInput(): any
	if not virtualInput then
		local ok, made = pcall(function() return (UserInputService :: any):CreateVirtualInput() end)
		if not ok or not made then error(`UserInputService:CreateVirtualInput() is not available here: {made}`, 0) end
		virtualInput = made
	end
	return virtualInput
end

local function isModifier(instance: Instance): boolean
	return instance:IsA("UIComponent") or instance:IsA("UIStroke") or instance:IsA("UIGradient") or instance:IsA("UICorner")
end

--- The GUI children of `parent` in the order a player reads them: a layout's own order, else top to bottom
local function guiChildren(parent: Instance): { Instance }
	local kids: { Instance } = {}
	local layout: Instance? = nil
	for _, child in parent:GetChildren() do
		if child:IsA("UIGridStyleLayout") then
			layout = child
		elseif child:IsA("GuiObject") or child:IsA("LayerCollector") or child:IsA("Folder") then
			table.insert(kids, child)
		end
	end
	local byLayoutOrder = layout ~= nil and (layout :: any).SortOrder == Enum.SortOrder.LayoutOrder
	local byName = layout ~= nil and (layout :: any).SortOrder == Enum.SortOrder.Name
	table.sort(kids, function(a: any, b: any)
		if byLayoutOrder and a:IsA("GuiObject") and b:IsA("GuiObject") and a.LayoutOrder ~= b.LayoutOrder then
			return a.LayoutOrder < b.LayoutOrder
		end
		if not byName and not byLayoutOrder and a:IsA("GuiObject") and b:IsA("GuiObject") then
			local pa, pb = a.AbsolutePosition, b.AbsolutePosition
			if math.abs(pa.Y - pb.Y) > 1 then return pa.Y < pb.Y end
			if math.abs(pa.X - pb.X) > 1 then return pa.X < pb.X end
		end
		return a.Name < b.Name
	end)
	return kids
end

--- Why a GUI button could not take a player's click at its center, or nil (click's own checks)
local function unclickable(button: GuiButton, playerGui: Instance?, origin: Vector2, screen: Vector2): string?
	if not playerGui or not button:IsDescendantOf(playerGui) then return nil end
	local layer = button:FindFirstAncestorWhichIsA("LayerCollector")
	if not layer or not layer:IsA("ScreenGui") then return "not on the screen" end
	local hidden = hiddenBecause(button, layer)
	if hidden then return hidden end
	local size = button.AbsoluteSize
	if size.X <= 0 or size.Y <= 0 then return "zero size" end
	local center = button.AbsolutePosition + size / 2
	local point = center - origin
	if point.X < 0 or point.Y < 0 or point.X >= screen.X or point.Y >= screen.Y then return "off-screen" end
	for _, object in (playerGui :: any):GetGuiObjectsAtPosition(center.X, center.Y) do
		if object == button then return nil end
		if object:IsA("GuiButton") or object:IsA("TextBox") then return `covered by {object:GetFullName()}` end
	end
	return "clipped or scrolled out of view"
end

local function inspectGui(args: { [string]: any }): { [string]: any }
	local player = if RunService:IsRunning() then Players.LocalPlayer else nil
	local root: Instance
	if type(args.path) == "string" and args.path ~= "" then
		root = resolvePath(args.path)
	elseif player then
		root = player:FindFirstChildOfClass("PlayerGui") or error("the play client has no PlayerGui yet", 0)
	else
		root = game:GetService("StarterGui")
	end
	local maxDepth = math.clamp(math.floor(tonumber(args.depth) or 3), 0, 20)
	local limit = math.clamp(math.floor(tonumber(args.limit) or 250), 1, 2000)
	local showHidden = args.hidden == true
	local playerGui = player and player:FindFirstChildOfClass("PlayerGui")
	local origin, screen = Vector2.zero, Vector2.zero
	if playerGui and root:IsDescendantOf(playerGui) or root == playerGui then
		origin, screen = screenOrigin(playerGui :: Instance)
	end
	local nodes = {}
	local truncated = false
	local function visit(instance: Instance, depth: number, parentShown: boolean)
		if #nodes >= limit then
			truncated = true
			return
		end
		local node: { [string]: any } = { d = depth, n = instance.Name, c = instance.ClassName }
		local shown = parentShown
		if instance:IsA("LayerCollector") then
			if instance:IsA("ScreenGui") and not instance.Enabled then
				shown = false
				node.off = "Enabled = false"
			end
		elseif instance:IsA("GuiObject") then
			if not instance.Visible then
				shown = false
				node.off = "Visible = false"
			end
			local p, s = instance.AbsolutePosition, instance.AbsoluteSize
			node.r = { math.round(p.X), math.round(p.Y), math.round(s.X), math.round(s.Y) }
			if instance:IsA("TextLabel") or instance:IsA("TextButton") or instance:IsA("TextBox") then
				local ok, text = pcall(function() return (instance :: any).ContentText end)
				node.t = if ok and type(text) == "string" then text else (instance :: any).Text
				if #node.t > 120 then node.t = string.sub(node.t, 1, 117) .. "..." end
			end
			if instance:IsA("ImageLabel") or instance:IsA("ImageButton") then
				local image = (instance :: any).Image
				if image ~= "" then node.img = string.match(image, "%d+$") or image end
			end
			if instance:IsA("GuiButton") and shown and playerGui then
				local why = unclickable(instance :: any, playerGui, origin, screen)
				node.btn = why or true
			elseif instance:IsA("GuiButton") then
				node.btn = if shown then true else "hidden"
			end
			if instance:IsA("ScrollingFrame") then
				local cp = (instance :: any).CanvasPosition
				node.scroll = { math.round(cp.X), math.round(cp.Y) }
			end
		end
		if not parentShown then node.off = node.off or "an ancestor is hidden" end
		local mods = {}
		for _, child in instance:GetChildren() do
			if isModifier(child) then table.insert(mods, child.ClassName) end
		end
		if #mods > 0 then
			table.sort(mods)
			node.m = table.concat(mods, ",")
		end
		table.insert(nodes, node)
		local kids = guiChildren(instance)
		if #kids == 0 then return end
		if depth >= maxDepth or (not shown and not showHidden) then
			local count = 0
			for _, d in instance:GetDescendants() do
				if d:IsA("GuiObject") then count += 1 end
			end
			node.more = count
			return
		end
		for _, child in kids do
			visit(child, depth + 1, shown)
		end
	end
	visit(root, 0, true)
	return {
		root = root:GetFullName(),
		nodes = nodes,
		truncated = truncated,
		screen = if screen.X > 0 then { width = math.round(screen.X), height = math.round(screen.Y) } else nil,
		origin = if screen.X > 0 then { x = origin.X, y = origin.Y } else nil,
	}
end

--------------------------------------------------------------------------------------------
-- The mouse by pixel: a point on the last screenshot, a GUI object's center, or a world part's.
-- UserInputService's VirtualInput has buttons only (no move, no wheel: chrrxs's plugin says the
-- same), so a drag or a scroll cannot be sent.

local MOUSE_BUTTONS = {
	left = Enum.UserInputType.MouseButton1,
	right = Enum.UserInputType.MouseButton2,
	middle = Enum.UserInputType.MouseButton3,
}

local function mouse(args: { [string]: any }): { [string]: any }
	local why = notRendering()
	if why then error(why, 0) end
	local player = Players.LocalPlayer
	local playerGui = player and player:FindFirstChildOfClass("PlayerGui")
	if not playerGui then error("the play client has no PlayerGui yet", 0) end
	local origin, screen = screenOrigin(playerGui)
	local button = MOUSE_BUTTONS[string.lower(tostring(args.button or "left"))]
	if not button then error("button must be left, right or middle", 0) end
	local action = args.action or "click"
	if action ~= "click" and action ~= "double" and action ~= "down" and action ~= "up" then
		error("action must be click, double, down or up", 0)
	end
	local point: Vector2
	local result: { [string]: any } = { screen = { width = math.round(screen.X), height = math.round(screen.Y) } }
	if type(args.path) == "string" and args.path ~= "" then
		local target = resolvePath(args.path)
		if target:IsA("GuiObject") then
			point = target.AbsolutePosition + target.AbsoluteSize / 2 - origin
			result.target = target:GetFullName()
		else
			local position: Vector3
			if target:IsA("BasePart") then
				position = target.Position
			elseif target:IsA("Model") then
				position = target:GetPivot().Position
			elseif target:IsA("Attachment") then
				position = target.WorldPosition
			else
				error(`{target:GetFullName()} is a {target.ClassName}: name a GuiObject, a BasePart, a Model or an Attachment`, 0)
			end
			local camera = workspace.CurrentCamera
			local gui, inFront = camera:WorldToScreenPoint(position)
			if not inFront then error(`{target:GetFullName()} is behind the camera`, 0) end
			point = Vector2.new(gui.X, gui.Y) - origin
			result.target = target:GetFullName()
		end
	elseif type(args.x) == "number" and type(args.y) == "number" then
		local x, y = args.x, args.y
		if type(args.imageWidth) == "number" and type(args.imageHeight) == "number" and args.imageWidth > 0 and args.imageHeight > 0 then
			-- A point on a screenshot: the capture is the whole screen at the display's scale (1725x1063
			-- for a 1380x850 screen at 125%); a different shape means the screen changed since
			local imageAspect, screenAspect = args.imageWidth / args.imageHeight, screen.X / screen.Y
			if math.abs(imageAspect / screenAspect - 1) > 0.03 then
				error(
					`the screen is {math.round(screen.X)}x{math.round(screen.Y)} now, not the shape of the {args.imageWidth}x{args.imageHeight} screenshot (the device simulator changed?): take a new screenshot`,
					0
				)
			end
			x, y = x * screen.X / args.imageWidth, y * screen.Y / args.imageHeight
		end
		point = Vector2.new(x, y)
	else
		error("give x and y (a point on the last screenshot), or the path of a GuiObject or a part", 0)
	end
	if point.X < 0 or point.Y < 0 or point.X >= screen.X or point.Y >= screen.Y then
		error(`({math.round(point.X)}, {math.round(point.Y)}) is off the {math.round(screen.X)}x{math.round(screen.Y)} screen`, 0)
	end
	local guiPoint = point + origin
	result.x, result.y = math.round(point.X), math.round(point.Y)
	result.gui = { x = math.round(guiPoint.X), y = math.round(guiPoint.Y) }
	-- What is there: the front GUI object, else the part a ray from the camera hits
	local objects = playerGui:GetGuiObjectsAtPosition(guiPoint.X, guiPoint.Y)
	-- The button or text box that takes the press, else the front object (a full-screen Frame such
	-- as the simulator's TouchControlFrame comes first and says nothing)
	local front: GuiObject? = objects[1]
	for _, object in objects do
		if object:IsA("GuiButton") or object:IsA("TextBox") then
			front = object
			break
		end
	end
	if front then result.under = front:GetFullName() end
	local camera = workspace.CurrentCamera
	if camera then
		local ray = camera:ScreenPointToRay(guiPoint.X, guiPoint.Y)
		local hit = workspace:Raycast(ray.Origin, ray.Direction * 2000)
		if hit then result.hit = hit.Instance:GetFullName() end
	end
	local input = getVirtualInput()
	local ok, err = pcall(function()
		if action == "down" then
			input:SendMouseButton(point, button, true)
		elseif action == "up" then
			input:SendMouseButton(point, button, false)
		else
			for i = 1, if action == "double" then 2 else 1 do
				input:SendMouseButton(point, button, true)
				task.wait(0.05)
				input:SendMouseButton(point, button, false)
				if i == 1 and action == "double" then task.wait(0.08) end
			end
		end
	end)
	if not ok then error(`could not send the mouse button: {err}`, 0) end
	result.action = action
	result.button = string.lower(tostring(args.button or "left"))
	return result
end

--------------------------------------------------------------------------------------------
-- A screenshot's focus. A GUI object: the screen's part it covers (8 px around it), as fractions
-- of the screen so the daemon crops the capture whatever the display scale. A part or a model:
-- the camera keeps its angle and backs off until the object's bounding sphere fills the view,
-- for two frames and the capture, then goes back where it was.

captureFocus = function(focus: string): ({ [string]: number }?, (() -> ())?)
	local target = resolvePath(focus)
	if target:IsA("GuiObject") then
		local player = Players.LocalPlayer
		local playerGui = player and player:FindFirstChildOfClass("PlayerGui")
		if not playerGui or not target:IsDescendantOf(playerGui) then
			error(`{target:GetFullName()} is not on the player's screen: a GUI focus needs a Play-mode play and a PlayerGui path`, 0)
		end
		local origin, screen = screenOrigin(playerGui)
		local pad = 8
		local p = target.AbsolutePosition - origin
		local s = target.AbsoluteSize
		local x0, y0 = math.clamp(p.X - pad, 0, screen.X), math.clamp(p.Y - pad, 0, screen.Y)
		local x1, y1 = math.clamp(p.X + s.X + pad, 0, screen.X), math.clamp(p.Y + s.Y + pad, 0, screen.Y)
		if x1 - x0 < 2 or y1 - y0 < 2 then
			error(`{target:GetFullName()} is off-screen or has no size ({math.round(s.X)}x{math.round(s.Y)} at {math.round(p.X)}, {math.round(p.Y)})`, 0)
		end
		return { x = x0 / screen.X, y = y0 / screen.Y, w = (x1 - x0) / screen.X, h = (y1 - y0) / screen.Y }, nil
	end
	local center: Vector3, size: Vector3
	if target:IsA("Model") then
		local cf, extents = target:GetBoundingBox()
		center, size = cf.Position, extents
	elseif target:IsA("BasePart") then
		center, size = target.Position, target.Size
	else
		error(`{target:GetFullName()} is a {target.ClassName}: focus a GuiObject, a BasePart or a Model`, 0)
	end
	local camera = workspace.CurrentCamera
	if not camera then error("there is no camera to move", 0) end
	local saved = { cframe = camera.CFrame, kind = camera.CameraType, focus = camera.Focus }
	local look = camera.CFrame.LookVector
	-- FieldOfView is vertical; the bounding sphere fits the shorter side
	local radius = math.max(size.Magnitude / 2, 0.5)
	local half = math.rad(camera.FieldOfView) / 2
	local aspect = camera.ViewportSize.X / math.max(camera.ViewportSize.Y, 1)
	local fit = math.min(math.tan(half), math.tan(half) * aspect)
	local distance = radius / fit * 1.1
	camera.CameraType = Enum.CameraType.Scriptable
	camera.CFrame = CFrame.lookAt(center - look * distance, center)
	camera.Focus = CFrame.new(center)
	RunService.RenderStepped:Wait()
	RunService.RenderStepped:Wait()
	return nil, function()
		camera.CameraType = saved.kind
		camera.CFrame = saved.cframe
		camera.Focus = saved.focus
	end
end

--------------------------------------------------------------------------------------------
-- Does Studio hold the disk's text? The daemon sends each mapped script's guid, its disk text's
-- length in bytes and FNV-1a hash; this answers the ones whose .Source, or whose open tab (the
-- text a play copies), is not that. Sessions checked with `.Source:find("...")` in 676 of the
-- month's 1001 execute_luau that read a Source.

local guidResolver: ((guid: string) -> Instance?)? = nil

--- The sync session's guid map, read at each call (it is replaced on a new snapshot)
function StudioTools.setGuidResolver(resolve: (guid: string) -> Instance?)
	guidResolver = resolve
end

--- FNV-1a, 32 bits, over the bytes: h * 16777619 is h * 2^24 + h * 403, kept below 2^53
local function fnv(text: string): number
	local data = buffer.fromstring(text)
	local h = 2166136261
	for i = 0, buffer.len(data) - 1 do
		h = bit32.bxor(h, buffer.readu8(data, i))
		h = (bit32.lshift(h, 24) + h * 403) % 4294967296
	end
	return h
end

--- The daemon reads files with CRLF as LF (the sync counts them the same): Studio's text too
local function sameText(text: string, len: number, hash: number): boolean
	if string.find(text, "\r", 1, true) then text = (string.gsub(text, "\r\n", "\n")) end
	return #text == len and fnv(text) == hash
end

local function sourceCheck(args: { [string]: any }): { [string]: any }
	if not guidResolver then error("the sync session has not started: connect the place first", 0) end
	local ScriptEditorService = game:GetService("ScriptEditorService")
	local items = if type(args.items) == "table" then args.items else {}
	local differ = {}
	local checked = 0
	local budget = os.clock()
	for _, item in items do
		if type(item) ~= "table" or type(item.guid) ~= "string" then continue end
		checked += 1
		local instance = (guidResolver :: any)(item.guid)
		if not instance or not instance.Parent then
			table.insert(differ, { guid = item.guid, state = "missing" })
			continue
		end
		local okSource, source = pcall(function() return (instance :: any).Source end)
		if not okSource then
			table.insert(differ, { guid = item.guid, state = "unreadable", path = instance:GetFullName(), error = tostring(source) })
			continue
		end
		local okEditor, editor = pcall(function() return ScriptEditorService:GetEditorSource(instance) end)
		local sourceSame = sameText(source, item.len, item.hash)
		local editorSame = if okEditor and editor ~= source then sameText(editor, item.len, item.hash) else sourceSame
		if not sourceSame or not editorSame then
			table.insert(differ, {
				guid = item.guid,
				path = instance:GetFullName(),
				state = if sourceSame then "tab" elseif editorSame then "source" else "both",
				len = #source,
				tabLen = if okEditor and editor ~= source then #editor else nil,
			})
		end
		-- Hashing megabytes holds Studio: a frame back every 50 ms of it
		if os.clock() - budget > 0.05 then
			task.wait()
			budget = os.clock()
		end
	end
	return { checked = checked, differ = differ }
end

--------------------------------------------------------------------------------------------
-- A performance sample of one play peer for a few seconds: the frame times (the client's
-- RenderStepped, the server's Heartbeat), the hitches, memory by tag and the engine's own Stats.
-- What sessions built by hand with os.clock (806 evals), Stats (250) and frame counters (116).

local function percentile(sorted: { number }, p: number): number
	if #sorted == 0 then return 0 end
	return sorted[math.clamp(math.ceil(#sorted * p), 1, #sorted)]
end

local function round(n: number, places: number?): number
	local scale = 10 ^ (places or 1)
	return math.round(n * scale) / scale
end

local function perfSample(args: { [string]: any }): { [string]: any }
	local Stats = game:GetService("Stats")
	local seconds = math.clamp(tonumber(args.seconds) or 3, 0.5, 30)
	local isClient = RunService:IsClient()
	local signal = if isClient then RunService.RenderStepped else RunService.Heartbeat
	local deltas: { number } = {}
	local connection = signal:Connect(function(dt: number) table.insert(deltas, dt * 1000) end)
	local memoryBefore = Stats:GetTotalMemoryUsageMb()
	local started = os.clock()
	task.wait(seconds)
	local elapsed = os.clock() - started
	connection:Disconnect()
	local sorted = table.clone(deltas)
	table.sort(sorted)
	local hitches, worst = 0, 0
	for _, ms in deltas do
		if ms > 50 then hitches += 1 end
		worst = math.max(worst, ms)
	end
	local tags = {}
	for _, tag in Enum.DeveloperMemoryTag:GetEnumItems() do
		local ok, mb = pcall(function() return Stats:GetMemoryUsageMbForTag(tag) end)
		if ok and type(mb) == "number" and mb > 0 then table.insert(tags, { tag = tag.Name, mb = round(mb) }) end
	end
	table.sort(tags, function(a, b) return a.mb > b.mb end)
	local top = {}
	for i = 1, math.min(8, #tags) do
		top[i] = tags[i]
	end
	local engine: { [string]: number } = {}
	for _, name in { "HeartbeatTimeMs", "PhysicsStepTimeMs", "InstanceCount", "PrimitivesCount", "MovingPrimitivesCount", "ContactsCount", "DataReceiveKbps", "DataSendKbps" } do
		local ok, value = pcall(function() return (Stats :: any)[name] end)
		if ok and type(value) == "number" then engine[name] = round(value, 2) end
	end
	local result: { [string]: any } = {
		seconds = round(elapsed, 2),
		signal = if isClient then "RenderStepped" else "Heartbeat",
		frames = #deltas,
		fps = round(#deltas / elapsed),
		frameMs = { p50 = round(percentile(sorted, 0.5), 2), p90 = round(percentile(sorted, 0.9), 2), p99 = round(percentile(sorted, 0.99), 2), max = round(worst, 2) },
		hitches = hitches,
		memoryMb = round(Stats:GetTotalMemoryUsageMb()),
		memoryChangeMb = round(Stats:GetTotalMemoryUsageMb() - memoryBefore),
		memoryTags = top,
		stats = engine,
		players = #Players:GetPlayers(),
	}
	if not isClient then
		local ok, physics = pcall(function() return workspace:GetRealPhysicsFPS() end)
		if ok then result.physicsFps = round(physics) end
	end
	if isClient and #deltas == 0 then result.warning = "the window drew no frame: it is minimized or covered" end
	return result
end

--------------------------------------------------------------------------------------------
-- Logpoints: a line of a script that prints Luau values when it runs, with no edit to the script
-- (ScriptDebuggerService, behind Studio's beta "Studio Debugger Luau API"). Set in edit mode,
-- they fire in the play and their lines reach the play's output. Sessions used chrrxs's for
-- perf-hunt timings (80 calls in a month).

local logpoints: { [string]: { script: LuaSourceContainer, path: string, line: number, message: string?, condition: string? } } = {}

local function quoted(text: string): string
	return '"' .. string.gsub(string.gsub(string.gsub(text, "\\", "\\\\"), '"', '\\"'), "\n", "\\n") .. '"'
end

local function debuggerService(): any
	local ok, service = pcall(function() return (game :: any):GetService("ScriptDebuggerService") end)
	if not ok or not service then
		error(
			"ScriptDebuggerService is not available: turn on the beta feature \"Studio Debugger Luau API\" (File > Beta Features) and restart Studio",
			0
		)
	end
	return service
end

local function logpoint(args: { [string]: any }): { [string]: any }
	local action = args.action or "add"
	local service = debuggerService()
	if action == "list" then
		local out = {}
		for _, entry in logpoints do
			if entry.script.Parent then table.insert(out, { path = entry.path, line = entry.line, message = entry.message, condition = entry.condition }) end
		end
		table.sort(out, function(a, b) return if a.path == b.path then a.line < b.line else a.path < b.path end)
		return { logpoints = out }
	end
	if action == "clear" then
		local removed = 0
		for key, entry in logpoints do
			if pcall(function() service:RemoveBreakpoint(entry.script, entry.line) end) then removed += 1 end
			logpoints[key] = nil
		end
		return { removed = removed }
	end
	local script: Instance? = nil
	if type(args.guid) == "string" and guidResolver then script = (guidResolver :: any)(args.guid) end
	if not script and type(args.path) == "string" and args.path ~= "" then script = resolvePath(args.path) end
	if not script then error("name the script by its path, or its file", 0) end
	if not (script :: Instance):IsA("LuaSourceContainer") then error(`{(script :: Instance):GetFullName()} is a {(script :: Instance).ClassName}, not a script`, 0) end
	local target = script :: LuaSourceContainer
	local line = math.floor(tonumber(args.line) or 0)
	if line < 1 then error("line must be a line number, 1 or more", 0) end
	local path = target:GetFullName()
	local key = `{path}:{line}`
	if action == "remove" then
		local ok, err = pcall(function() service:RemoveBreakpoint(target, line) end)
		logpoints[key] = nil
		if not ok then error(`ScriptDebuggerService:RemoveBreakpoint failed: {err}`, 0) end
		return { removed = 1, path = path, line = line }
	end
	if action ~= "add" then error("action must be add, remove, list or clear", 0) end
	local message = if type(args.message) == "string" and args.message ~= "" then args.message else nil
	-- LogMessage is a list of Luau expressions, as print takes them: a label first, then the values
	local spec: { [string]: any } = {
		Line = line,
		Enabled = true,
		ContinueExecution = true,
		LogMessage = quoted(`[logpoint {target.Name}:{line}]`) .. (if message then ", " .. message else ""),
	}
	local condition = if type(args.condition) == "string" and args.condition ~= "" then args.condition else nil
	if condition then spec.Condition = condition end
	pcall(function() service:RemoveBreakpoint(target, line) end)
	local ok, result = pcall(function() return service:AddBreakpoint(target, spec) end)
	if not ok then
		error(
			`ScriptDebuggerService:AddBreakpoint failed: {result} (it needs the beta feature "Studio Debugger Luau API" on and Studio restarted)`,
			0
		)
	end
	local actual = if type(result) == "table" and type(result.Line) == "number" then result.Line else line
	logpoints[`{path}:{actual}`] = { script = target, path = path, line = actual, message = message, condition = condition }
	return {
		path = path,
		line = actual,
		requestedLine = if actual ~= line then line else nil,
		verified = if type(result) == "table" then result.Verified else nil,
		note = if type(result) == "table" and type(result.Message) == "string" and result.Message ~= "" then result.Message else nil,
	}
end

--------------------------------------------------------------------------------------------
-- Models as .rbxm files, both ways (SerializationService, plugin security): a play of a
-- worktree carries scripts only, so a model, a map piece or a UI made elsewhere comes in this
-- way. chrrxs's import_rbxm and export_rbxm: 167 calls in a month.

local function exportRbxm(args: { [string]: any }): { [string]: any }
	local paths = if type(args.paths) == "table" then args.paths else {}
	if #paths == 0 then error("paths is required: the instances to save", 0) end
	local instances = {}
	for _, path in paths do
		table.insert(instances, resolvePath(tostring(path)))
	end
	local SerializationService = (game :: any):GetService("SerializationService")
	local ok, data = pcall(function() return SerializationService:SerializeInstancesAsync(instances) end)
	if not ok then error(`SerializationService:SerializeInstancesAsync failed: {data}`, 0) end
	local names = {}
	for _, instance in instances do
		table.insert(names, instance:GetFullName())
	end
	return { data = base64(data), bytes = buffer.len(data), instances = names }
end

local function importRbxm(args: { [string]: any }): { [string]: any }
	if type(args.data) ~= "string" or args.data == "" then error("the file's bytes did not come", 0) end
	local parent = resolvePath(if type(args.parent) == "string" and args.parent ~= "" then args.parent else "Workspace")
	local EncodingService = (game :: any):GetService("EncodingService")
	local SerializationService = (game :: any):GetService("SerializationService")
	local decoded, raw = pcall(function() return EncodingService:Base64Decode(buffer.fromstring(args.data)) end)
	if not decoded then error(`could not decode the file: {raw}`, 0) end
	local ok, made = pcall(function() return SerializationService:DeserializeInstancesAsync(raw) end)
	if not ok then error(`SerializationService:DeserializeInstancesAsync failed (not an .rbxm?): {made}`, 0) end
	local ChangeHistoryService = game:GetService("ChangeHistoryService")
	local recording = if RunService:IsEdit() then ChangeHistoryService:TryBeginRecording("Quack: import .rbxm") else nil
	local placed = {}
	local failure: string? = nil
	for _, instance in made do
		local parented, err = pcall(function() instance.Parent = parent end)
		if not parented then
			failure = `could not put {instance.Name} ({instance.ClassName}) in {parent:GetFullName()}: {err}`
			break
		end
		table.insert(placed, instance)
	end
	if failure then
		for _, instance in placed do
			pcall(function() instance:Destroy() end)
		end
		if recording then ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel) end
		error(failure, 0)
	end
	if recording then ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit) end
	local names = {}
	local scripts = 0
	for _, instance in placed do
		table.insert(names, `{instance:GetFullName()} ({instance.ClassName})`)
		if instance:IsA("LuaSourceContainer") then scripts += 1 end
		for _, d in instance:GetDescendants() do
			if d:IsA("LuaSourceContainer") then scripts += 1 end
		end
	end
	return { placed = names, scripts = scripts }
end

--------------------------------------------------------------------------------------------
-- One instance read whole, and its properties and attributes changed with the right types.
-- Sessions read three or more properties of one thing in 231 execute_luau of a month and every
-- attribute in 296 evals; the official server's inspect_instance had 7 calls. The property names
-- come from the vendored rbx-dom database, the defaults from a fresh instance of the class.

local rbxDatabase = require("./Vendor/rbx_dom_lua/database")

local function short(n: number): string
	if n ~= n then return "nan" end
	if n == 0 then return "0" end
	if math.abs(n) >= 1e15 or (n ~= 0 and math.abs(n) < 1e-4) then return string.format("%.4g", n) end
	local text = string.format("%.4f", n)
	text = string.gsub(text, "0+$", "")
	return (string.gsub(text, "%.$", ""))
end

--- A value as a person reads it: 1, 2.5, 3 for a Vector3, #ff8800 for a Color3, an enum's name...
local function describe(value: any): string
	local kind = typeof(value)
	if kind == "number" then return short(value) end
	if kind == "string" then
		local text = if #value > 200 then string.sub(value, 1, 197) .. "..." else value
		return string.format("%q", text)
	end
	if kind == "Vector3" then return `{short(value.X)}, {short(value.Y)}, {short(value.Z)}` end
	if kind == "Vector2" then return `{short(value.X)}, {short(value.Y)}` end
	if kind == "Color3" then return "#" .. value:ToHex() end
	if kind == "UDim2" then
		return "{" .. short(value.X.Scale) .. ", " .. short(value.X.Offset) .. "}, {" .. short(value.Y.Scale) .. ", " .. short(value.Y.Offset) .. "}"
	end
	if kind == "UDim" then return `{short(value.Scale)}, {short(value.Offset)}` end
	if kind == "CFrame" then
		local rx, ry, rz = value:ToOrientation()
		return `at {short(value.X)}, {short(value.Y)}, {short(value.Z)}, turned {short(math.deg(rx))}, {short(math.deg(ry))}, {short(math.deg(rz))}`
	end
	if kind == "EnumItem" then return value.Name end
	if kind == "BrickColor" then return value.Name end
	if kind == "Instance" then return value:GetFullName() end
	if kind == "NumberRange" then return `{short(value.Min)} to {short(value.Max)}` end
	if kind == "NumberSequence" or kind == "ColorSequence" then
		local points = {}
		for _, point in value.Keypoints do
			table.insert(points, short(point.Time) .. "=" .. (if kind == "NumberSequence" then short(point.Value) else "#" .. point.Value:ToHex()))
		end
		return table.concat(points, " ")
	end
	if kind == "Content" then
		local ok, uri = pcall(function() return (value :: any).Uri end)
		return if ok and uri then tostring(uri) else tostring(value)
	end
	if kind == "Font" then return `{value.Family} {value.Weight.Name} {value.Style.Name}` end
	return tostring(value)
end

--- Readable property names of a class (and its ancestors), minus deprecated and hidden ones unless asked
local function propertyNames(className: string, includeHidden: boolean): { string }
	local names, seen = {}, {}
	local current: string? = className
	while current do
		local info = rbxDatabase.Classes[current]
		if not info then break end
		for name, data in info.Properties do
			if seen[name] then continue end
			seen[name] = true
			-- Read-only ones are derived (AssemblyMass, ExtentsSize...): only with hidden
			if data.Scriptability ~= "ReadWrite" and not (includeHidden and data.Scriptability == "Read") then continue end
			if not data.Kind or not data.Kind.Canonical then continue end
			local tags = data.Tags or {}
			if not includeHidden and (table.find(tags, "Deprecated") or table.find(tags, "Hidden") or table.find(tags, "NotBrowsable")) then
				continue
			end
			if name == "Source" or name == "Parent" then continue end
			table.insert(names, name)
		end
		current = info.Superclass
	end
	table.sort(names)
	return names
end

local function sameValue(a: any, b: any): boolean
	if typeof(a) ~= typeof(b) then return false end
	if typeof(a) == "number" then return a == b or (a ~= a and b ~= b) end
	local ok, equal = pcall(function() return a == b end)
	return ok and equal
end

local function inspectInstance(args: { [string]: any }): { [string]: any }
	if type(args.path) ~= "string" or args.path == "" then error("path is required", 0) end
	local target = resolvePath(args.path)
	local all = args.all == true
	local fresh: Instance? = nil
	if not all then
		local ok, made = pcall(Instance.new, target.ClassName)
		if ok then fresh = made end
	end
	local properties = {}
	local unread = 0
	for _, name in propertyNames(target.ClassName, args.hidden == true) do
		local ok, value = pcall(function() return (target :: any)[name] end)
		if not ok then
			unread += 1
			continue
		end
		if fresh and name ~= "Name" then
			local okDefault, default = pcall(function() return (fresh :: any)[name] end)
			if okDefault and sameValue(value, default) then continue end
		end
		table.insert(properties, { name = name, value = describe(value), type = typeof(value) })
	end
	if fresh then fresh:Destroy() end
	local attributes = {}
	for name, value in target:GetAttributes() do
		table.insert(attributes, { name = name, value = describe(value), type = typeof(value) })
	end
	table.sort(attributes, function(a, b) return a.name < b.name end)
	local tags = game:GetService("CollectionService"):GetTags(target)
	table.sort(tags)
	local children = {}
	local kids = target:GetChildren()
	for i, child in kids do
		if i > 40 then break end
		table.insert(children, `{child.Name} [{child.ClassName}]`)
	end
	local result: { [string]: any } = {
		path = target:GetFullName(),
		className = target.ClassName,
		properties = properties,
		attributes = attributes,
		tags = tags,
		children = children,
		childCount = #kids,
		defaultsLeftOut = fresh ~= nil,
		unread = unread,
	}
	if target:IsA("PVInstance") then
		local ok, pivot = pcall(function() return (target :: any):GetPivot() end)
		if ok then result.pivot = describe(pivot) end
	end
	if target:IsA("Model") then
		local ok, cf, size = pcall(function() return (target :: any):GetBoundingBox() end)
		if ok then result.boundingBox = `{describe(size)} around {describe(cf.Position)}` end
	end
	return result
end

--[=[
	A value from JSON for a property or attribute: { Vector3 = {1, 2, 3} }, { Color3 = "#ff8800" },
	{ UDim2 = {0, 10, 0.5, 0} }, { CFrame = {x, y, z} or {x, y, z, rx, ry, rz} }, { Enum = "Name" },
	{ Instance = "Workspace.Part" }..., or a plain number, string, boolean or nil, which takes the
	type of what is there now (a string on an enum property is that enum's item).
]=]
local function enumByName(enum: Enum, raw: string, label: string): EnumItem
	local name = string.match(raw, "([^%.]+)$") or raw
	local names = {}
	for _, item in enum:GetEnumItems() do
		if item.Name == name then return item end
		table.insert(names, item.Name)
	end
	error(`{label} "{raw}" is not one of: {table.concat(names, ", ")}`, 0)
end

local function parseValue(raw: any, current: any, label: string): any
	local function numbers(list: any, count: number, kind: string): { number }
		if type(list) == "string" then
			local parsed = {}
			for piece in string.gmatch(list, "[^,%s]+") do
				table.insert(parsed, tonumber(piece))
			end
			list = parsed
		end
		if type(list) ~= "table" or #list < count then error(`{label}: a {kind} takes {count} numbers`, 0) end
		for i = 1, count do
			if type(list[i]) ~= "number" then error(`{label}: a {kind} takes {count} numbers`, 0) end
		end
		return list
	end
	local function color(value: any): Color3
		if type(value) == "string" then
			local ok, made = pcall(Color3.fromHex, value)
			if ok then return made end
			local okBrick, brick = pcall(function() return BrickColor.new(value :: any).Color end)
			if okBrick then return brick end
		end
		local n = numbers(value, 3, "Color3")
		if n[1] > 1 or n[2] > 1 or n[3] > 1 then return Color3.fromRGB(n[1], n[2], n[3]) end
		return Color3.new(n[1], n[2], n[3])
	end
	if type(raw) == "table" and next(raw) ~= nil and #raw == 0 then
		local kind, value = next(raw)
		-- JSON null does not survive JSONDecode: the daemon sends { Remove = true } for it
		if kind == "Remove" then return nil end
		if kind == "Vector3" then
			local n = numbers(value, 3, kind)
			return Vector3.new(n[1], n[2], n[3])
		elseif kind == "Vector2" then
			local n = numbers(value, 2, kind)
			return Vector2.new(n[1], n[2])
		elseif kind == "Color3" then
			return color(value)
		elseif kind == "UDim2" then
			local n = numbers(value, 4, kind)
			return UDim2.new(n[1], n[2], n[3], n[4])
		elseif kind == "UDim" then
			local n = numbers(value, 2, kind)
			return UDim.new(n[1], n[2])
		elseif kind == "NumberRange" then
			local n = numbers(value, 2, kind)
			return NumberRange.new(n[1], n[2])
		elseif kind == "CFrame" then
			local n = numbers(value, 3, kind)
			local at = CFrame.new(n[1], n[2], n[3])
			if type(n[6]) == "number" then return at * CFrame.fromOrientation(math.rad(n[4]), math.rad(n[5]), math.rad(n[6])) end
			if typeof(current) == "CFrame" then return at * current.Rotation end
			return at
		elseif kind == "BrickColor" then
			return BrickColor.new(value :: any)
		elseif kind == "Instance" then
			return if value == nil or value == "" then nil else resolvePath(tostring(value))
		elseif kind == "Enum" then
			if typeof(current) ~= "EnumItem" then error(`{label} is not an enum property`, 0) end
			return enumByName(current.EnumType, tostring(value), label)
		end
		error(`{label}: unknown type {kind} (Vector3, Vector2, Color3, UDim2, UDim, CFrame, NumberRange, BrickColor, Enum, Instance)`, 0)
	end
	-- A plain value takes the type of what is there now
	local kind = typeof(current)
	if raw == nil then return nil end
	if kind == "EnumItem" and type(raw) == "string" then return enumByName(current.EnumType, raw, label) end
	if kind == "EnumItem" and type(raw) == "number" then
		for _, item in current.EnumType:GetEnumItems() do
			if item.Value == raw then return item end
		end
		error(`{label}: {raw} is not a value of {tostring(current.EnumType)}`, 0)
	end
	if kind == "Color3" then return color(raw) end
	if kind == "BrickColor" and type(raw) == "string" then return BrickColor.new(raw :: any) end
	if kind == "Vector3" then
		local n = numbers(raw, 3, kind)
		return Vector3.new(n[1], n[2], n[3])
	end
	if kind == "Vector2" then
		local n = numbers(raw, 2, kind)
		return Vector2.new(n[1], n[2])
	end
	if kind == "UDim2" then
		local n = numbers(raw, 4, kind)
		return UDim2.new(n[1], n[2], n[3], n[4])
	end
	if kind == "CFrame" then return parseValue({ CFrame = raw }, current, label) end
	if kind == "Instance" or (current == nil and type(raw) == "string" and string.find(raw, ".", 1, true)) then
		if kind == "Instance" then return resolvePath(tostring(raw)) end
	end
	return raw
end

local function setProperties(args: { [string]: any }): { [string]: any }
	if type(args.path) ~= "string" or args.path == "" then error("path is required", 0) end
	local target = resolvePath(args.path)
	local props = if type(args.properties) == "table" then args.properties else {}
	local attributes = if type(args.attributes) == "table" then args.attributes else {}
	if next(props) == nil and next(attributes) == nil then error("give properties or attributes to set", 0) end
	-- Every value parsed first: one bad value changes nothing
	local planned = {}
	for name, raw in props do
		local ok, current = pcall(function() return (target :: any)[name] end)
		if not ok then error(`{target:GetFullName()} has no property {name} that a plugin can read: {current}`, 0) end
		table.insert(planned, { kind = "property", name = name, value = parseValue(raw, current, name), before = current })
	end
	for name, raw in attributes do
		local current = target:GetAttribute(name)
		local value = parseValue(raw, current, name)
		table.insert(planned, { kind = "attribute", name = name, value = value, before = current })
	end
	local ChangeHistoryService = game:GetService("ChangeHistoryService")
	local recording = if RunService:IsEdit() then ChangeHistoryService:TryBeginRecording("Quack: set properties") else nil
	local done = {}
	for _, change in planned do
		local ok, err = pcall(function()
			if change.kind == "property" then
				(target :: any)[change.name] = change.value
			else
				target:SetAttribute(change.name, change.value)
			end
		end)
		if not ok then
			-- Put back what was changed before the failure
			for i = #done, 1, -1 do
				local undo = done[i]
				pcall(function()
					if undo.kind == "property" then
						(target :: any)[undo.name] = undo.before
					else
						target:SetAttribute(undo.name, undo.before)
					end
				end)
			end
			if recording then ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel) end
			error(`{change.name}: {err} (nothing was changed)`, 0)
		end
		table.insert(done, change)
	end
	if recording then ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit) end
	local changed = {}
	for _, change in done do
		local now = if change.kind == "property" then (target :: any)[change.name] else target:GetAttribute(change.name)
		table.insert(changed, { kind = change.kind, name = change.name, before = describe(change.before), after = describe(now) })
	end
	return { path = target:GetFullName(), changed = changed }
end

--------------------------------------------------------------------------------------------
-- Studio's network and performance simulation (the toolbar's Network simulation and
-- Performance simulation panels): NetworkSettings' six delay, jitter and loss values,
-- RenderSettings.QualityLevel and NetworkSettings.EmulatedTotalMemoryInMB, all plugin-writable.
-- The engine caps simulated packet loss at 0.5%. A solo play shares the edit Studio's settings;
-- a multiplayer client keeps its own after it starts (chrrxs's notes, 3.1.5).

local NETWORK_KEYS = {
	"InboundNetworkMinDelayMs", "InboundNetworkJitterMs", "InboundNetworkLossPercent",
	"OutboundNetworkMinDelayMs", "OutboundNetworkJitterMs", "OutboundNetworkLossPercent",
}

local function simulationState(): { [string]: any }
	local network = settings().Network
	local out: { [string]: any } = {}
	for _, key in NETWORK_KEYS do
		local ok, value = pcall(function() return (network :: any)[key] end)
		if ok then out[key] = value end
	end
	local okQuality, quality = pcall(function() return settings().Rendering.QualityLevel end)
	if okQuality then out.QualityLevel = quality.Name end
	local okMemory, memory = pcall(function() return (network :: any).EmulatedTotalMemoryInMB end)
	if okMemory then out.EmulatedTotalMemoryInMB = memory end
	return out
end

local function simulate(args: { [string]: any }): { [string]: any }
	local network = settings().Network
	local before = simulationState()
	local values = if type(args.network) == "table" then args.network else {}
	for key, value in values do
		if not table.find(NETWORK_KEYS, key) then error(`{key} is not one of {table.concat(NETWORK_KEYS, ", ")}`, 0) end
		if type(value) ~= "number" or value < 0 or value ~= value then error(`{key} must be a number, 0 or more`, 0) end
		if string.find(key, "LossPercent") and value > 0.5 then error(`{key}: the engine simulates at most 0.5% packet loss`, 0) end
	end
	for key, value in values do
		(network :: any)[key] = value
	end
	if args.quality ~= nil then
		local level = if args.quality == "auto" or args.quality == 0 then Enum.QualityLevel.Automatic else nil
		if not level then
			local n = tonumber(args.quality)
			if not n or n < 1 or n > 21 or n % 1 ~= 0 then error("quality must be auto or a level from 1 to 21", 0) end
			level = (Enum.QualityLevel :: any)[string.format("Level%02d", n)]
		end
		(settings().Rendering :: any).QualityLevel = level
	end
	if args.memoryMb ~= nil then
		local mb = tonumber(args.memoryMb)
		if not mb or mb < 256 then error("memoryMb must be a number of megabytes, 256 or more", 0) end
		(network :: any).EmulatedTotalMemoryInMB = mb
	end
	return { before = before, after = simulationState() }
end

--------------------------------------------------------------------------------------------
-- Script tabs open in this Studio. A tab edited in the Studio that starts a play gives the play
-- its own text instead of the swapped script's (Memória, 25/10/26: "has the place's text", 31
-- plays in 18 sessions of a month); a collaborator's tab in Team Create does not, and a plugin
-- sees only this Studio's tabs anyway.

local function scriptTabs(args: { [string]: any }): { [string]: any }
	local ScriptEditorService = game:GetService("ScriptEditorService")
	local close = if type(args.close) == "table" then args.close else nil
	local closeAll = args.closeEdited == true
	local tabs = {}
	local closed = {}
	for _, doc in ScriptEditorService:GetScriptDocuments() do
		local document = doc :: any
		if document:IsCommandBar() then continue end
		local script = document:GetScript()
		if not script then continue end
		local path = script:GetFullName()
		local okText, text = pcall(function() return document:GetText() end)
		local okSource, source = pcall(function() return (script :: any).Source end)
		local edited = okText and okSource and text ~= source
		local wanted = (close ~= nil and table.find(close, path) ~= nil) or (closeAll and edited)
		if wanted then
			local ok, err = pcall(function() return document:CloseAsync() end)
			table.insert(closed, { path = path, edited = edited, ok = ok, error = if ok then nil else tostring(err) })
		else
			table.insert(tabs, { path = path, edited = edited, lines = if okText then select(2, string.gsub(text, "\n", "")) + 1 else nil })
		end
	end
	table.sort(tabs, function(a, b) return a.path < b.path end)
	return { tabs = tabs, closed = closed }
end

--------------------------------------------------------------------------------------------
-- Keys (virtualInput is declared with the clicks)

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
-- Creator Store assets, previewed and inserted in edit mode (AssetService:LoadAssetAsync). The
-- loaded asset is a Model outside the DataModel until something is parented. Preview lists
-- every LuaSourceContainer and PackageLink in it; insert destroys them all, scans again and
-- refuses when any is left, before anything reaches the place: a free model's script is how a
-- backdoor gets into a game, and here it would also sync to disk. chrrxs sanitizes the same way.

local THIRD_PARTY_HINT =
	' To load a public Creator Store asset you do not own, turn on "Allow Loading Third Party Assets" in Game Settings > Security.'

local function loadAsset(assetId: number): Instance
	local ok, loaded = pcall(function() return AssetService:LoadAssetAsync(assetId) end)
	if ok and loaded then return loaded :: Instance end
	-- LoadAssetAsync (and InsertService:LoadAsset) refuse a free model the user does not own
	-- unless the game allows third-party assets ("User is not authorized to access Asset", the
	-- Astral copy, 09/11/26). game:GetObjects, what the Toolbox uses, loads it from a plugin:
	-- its roots go in a wrapper Model shaped like LoadAssetAsync's, outside the DataModel.
	local okObjects, objects = pcall(function() return (game :: any):GetObjects(`rbxassetid://{assetId}`) end)
	if okObjects and type(objects) == "table" and #objects > 0 then
		local wrapper = Instance.new("Model")
		wrapper.Name = `Asset{assetId}`
		for _, object in objects do
			(object :: Instance).Parent = wrapper
		end
		return wrapper
	end
	local readable, allowed = pcall(function() return (AssetService :: any).AllowInsertFreeAssets end)
	local hint = if readable and allowed == true then "" else THIRD_PARTY_HINT
	error(`AssetService:LoadAssetAsync({assetId}) failed: {loaded} (game:GetObjects too: {if okObjects then "no instances" else tostring(objects)}).{hint}`, 0)
end

local function isForbidden(instance: Instance): boolean
	return instance:IsA("LuaSourceContainer") or instance:IsA("PackageLink")
end

--- A path inside the loaded asset, from below its wrapper
local function insidePath(instance: Instance, root: Instance): string
	local parts = {}
	local node: Instance? = instance
	while node and node ~= root do
		table.insert(parts, 1, (node :: Instance).Name)
		node = (node :: Instance).Parent
	end
	return table.concat(parts, ".")
end

-- What in a script's text a backdoor uses: a module required by id, code built at runtime
local SUSPICIOUS = {
	{ pattern = "require%s*%(%s*%d", label = "require(<asset id>)" },
	{ pattern = "loadstring", label = "loadstring" },
	{ pattern = "getfenv", label = "getfenv" },
	{ pattern = "setfenv", label = "setfenv" },
	{ pattern = "HttpService", label = "HttpService" },
	{ pattern = "MarketplaceService", label = "MarketplaceService" },
	{ pattern = "TeleportService", label = "TeleportService" },
}

local PREVIEW_NODES = 100

local function assetIdOf(args: { [string]: any }): number
	local id = tonumber(args.assetId)
	if not id or id <= 0 or id ~= math.floor(id) then error("assetId must be a whole number above 0", 0) end
	return id :: number
end

local function previewAsset(args: { [string]: any }): { [string]: any }
	local assetId = assetIdOf(args)
	local maxDepth = math.clamp(math.floor(tonumber(args.depth) or 4), 0, 20)
	local root = loadAsset(assetId)
	local ok, result = pcall(function()
		pcall(function() root.Parent = nil end)
		local classes: { [string]: number } = {}
		local total = 0
		local scripts, packageLinks, sounds = {}, {}, {}
		for _, d in root:GetDescendants() do
			total += 1
			classes[d.ClassName] = (classes[d.ClassName] or 0) + 1
			if d:IsA("LuaSourceContainer") then
				local entry: { [string]: any } = { path = insidePath(d, root), className = d.ClassName }
				local readable, source = pcall(function() return (d :: any).Source end)
				if readable and type(source) == "string" then
					entry.lines = countLines(source)
					local found = {}
					for _, s in SUSPICIOUS do
						if string.find(source, s.pattern) then table.insert(found, s.label) end
					end
					if #found > 0 then entry.uses = found end
				end
				if d:IsA("BaseScript") then entry.enabled = (d :: BaseScript).Enabled end
				table.insert(scripts, entry)
			elseif d:IsA("PackageLink") then
				table.insert(packageLinks, insidePath(d, root))
			elseif d:IsA("Sound") then
				table.insert(sounds, { path = insidePath(d, root), soundId = (d :: Sound).SoundId })
			end
		end
		local nodes = {}
		local truncated = false
		local function walk(instance: Instance, depth: number)
			for _, child in instance:GetChildren() do
				if #nodes >= PREVIEW_NODES then
					truncated = true
					return
				end
				local node: { [string]: any } = { d = depth, n = child.Name, c = child.ClassName }
				table.insert(nodes, node)
				if depth >= maxDepth then
					local below = #child:GetDescendants()
					if below > 0 then node.more = below end
				else
					walk(child, depth + 1)
				end
			end
		end
		walk(root, 0)
		local classList = {}
		for name, count in classes do
			table.insert(classList, { class = name, count = count })
		end
		table.sort(classList, function(a, b) return if a.count == b.count then a.class < b.class else a.count > b.count end)
		return {
			assetId = assetId,
			total = total,
			classes = classList,
			nodes = nodes,
			truncated = truncated,
			scripts = scripts,
			packageLinks = packageLinks,
			sounds = sounds,
		}
	end)
	pcall(function() root:Destroy() end)
	if not ok then error(`could not read asset {assetId}: {result}`, 0) end
	return result
end

local function insertAsset(args: { [string]: any }): { [string]: any }
	if not RunService:IsEdit() then error("an asset is inserted in edit mode, not in a play", 0) end
	local assetId = assetIdOf(args)
	local parent = resolvePath(if type(args.parent) == "string" and args.parent ~= "" then args.parent else "Workspace")
	local position: Vector3? = nil
	if type(args.position) == "table" then
		local p = args.position
		position = Vector3.new(tonumber(p[1]) or 0, tonumber(p[2]) or 0, tonumber(p[3]) or 0)
	end
	local root = loadAsset(assetId)
	pcall(function() root.Parent = nil end)
	local removedScripts, removedLinks = {}, {}
	-- Every one first, then each destroyed: destroying one also takes what it holds
	local forbidden = {}
	for _, d in root:GetDescendants() do
		if isForbidden(d) then table.insert(forbidden, d) end
	end
	for _, d in forbidden do
		local label = insidePath(d, root)
		if d:IsA("LuaSourceContainer") then
			table.insert(removedScripts, `{label} ({d.ClassName})`)
		else
			table.insert(removedLinks, label)
		end
		pcall(function() d:Destroy() end)
	end
	local left = {}
	for _, d in root:GetDescendants() do
		if isForbidden(d) then table.insert(left, insidePath(d, root)) end
	end
	local children = root:GetChildren()
	if #left > 0 then
		pcall(function() root:Destroy() end)
		error(`asset {assetId} still holds {#left} script(s) or PackageLink(s) after they were removed ({table.concat(left, ", ")}): nothing was inserted`, 0)
	end
	if #children == 0 then
		pcall(function() root:Destroy() end)
		error(`nothing is left of asset {assetId} once its scripts are removed: nothing was inserted`, 0)
	end
	-- Moved together: the first model's or part's pivot goes to the position, the rest keep their offsets
	local moved = false
	if position then
		for _, child in children do
			if child:IsA("PVInstance") then
				local delta = (position :: Vector3) - (child :: PVInstance):GetPivot().Position
				for _, other in children do
					if other:IsA("PVInstance") then
						local pv = other :: PVInstance
						pv:PivotTo(pv:GetPivot() + delta)
					end
				end
				moved = true
				break
			end
		end
	end
	local ChangeHistoryService = game:GetService("ChangeHistoryService")
	local recording = ChangeHistoryService:TryBeginRecording(`Quack: insert asset {assetId}`)
	local placed = {}
	local failure: string? = nil
	for _, child in children do
		local parented, err = pcall(function() child.Parent = parent end)
		if not parented then
			failure = `could not put {child.Name} ({child.ClassName}) in {parent:GetFullName()}: {err}`
			break
		end
		table.insert(placed, child)
	end
	if failure then
		for _, instance in placed do
			pcall(function() instance:Destroy() end)
		end
		if recording then ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel) end
		pcall(function() root:Destroy() end)
		error(failure, 0)
	end
	if recording then ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit) end
	pcall(function() root:Destroy() end)
	pcall(function() game:GetService("Selection"):Set(placed) end)
	local inserted = {}
	for _, instance in placed do
		table.insert(inserted, { path = instance:GetFullName(), className = instance.ClassName })
	end
	return {
		assetId = assetId,
		parent = parent:GetFullName(),
		inserted = inserted,
		removedScripts = removedScripts,
		removedPackageLinks = removedLinks,
		moved = if moved then { (position :: Vector3).X, (position :: Vector3).Y, (position :: Vector3).Z } else nil,
	}
end

--------------------------------------------------------------------------------------------
-- Memory by Enum.DeveloperMemoryTag, in whichever DataModel asks: what the Developer Console's
-- Memory tab shows, read by Stats.

local function memoryBreakdown(args: { [string]: any }): { [string]: any }
	local Stats = game:GetService("Stats")
	local wanted: { [string]: boolean }? = nil
	if type(args.tags) == "table" and #args.tags > 0 then
		local set: { [string]: boolean } = {}
		for _, name in args.tags do
			set[tostring(name)] = true
		end
		wanted = set
	end
	local tags = {}
	local known: { [string]: boolean } = {}
	for _, tag in Enum.DeveloperMemoryTag:GetEnumItems() do
		known[tag.Name] = true
		if wanted and not wanted[tag.Name] then continue end
		local ok, mb = pcall(function() return Stats:GetMemoryUsageMbForTag(tag) end)
		if ok and type(mb) == "number" and (wanted ~= nil or mb > 0) then table.insert(tags, { tag = tag.Name, mb = round(mb, 2) }) end
	end
	if wanted then
		local unknown = {}
		for name in wanted :: { [string]: boolean } do
			if not known[name] then table.insert(unknown, name) end
		end
		if #unknown > 0 then error(`not an Enum.DeveloperMemoryTag: {table.concat(unknown, ", ")}`, 0) end
	end
	table.sort(tags, function(a, b) return a.mb > b.mb end)
	local tracking, enabled = pcall(function() return Stats.MemoryTrackingEnabled end)
	return {
		totalMb = round(Stats:GetTotalMemoryUsageMb(), 1),
		trackingEnabled = if tracking then enabled else nil,
		tags = tags,
	}
end

--------------------------------------------------------------------------------------------
-- The script profiler of a play peer (ScriptProfilerService): a capture of durationMs at
-- `frequency` samples a second, its data asked for and decoded here, the functions that took
-- the most time kept. Flags bit 1 is a native function, bit 2 a plugin's; Quack's own eval
-- payload and bridge run in the game VM unflagged, and are left out by their names.

local function scriptProfiler(args: { [string]: any }): { [string]: any }
	if not RunService:IsRunning() then error("the script profiler runs in a play's server or client", 0) end
	local service = game:GetService("ScriptProfilerService")
	local durationMs = math.clamp(math.floor(tonumber(args.durationMs) or 1000), 100, 15000)
	local frequency = math.clamp(math.floor(tonumber(args.frequency) or 1000), 1, 10000)
	local maxFunctions = math.clamp(math.floor(tonumber(args.maxFunctions) or 20), 1, 100)
	local filter = if type(args.filter) == "string" and args.filter ~= "" then string.lower(args.filter) else nil
	local isServer = RunService:IsServer()
	local player = if isServer then nil else Players.LocalPlayer
	if not isServer and not player then error("the play client has no LocalPlayer yet", 0) end
	local data: string? = nil
	local connection = service.OnNewData:Connect(function(_, json: string)
		if data == nil then data = json end
	end)
	local started, startError = pcall(function()
		if isServer then
			service:ServerStart(frequency)
		else
			service:ClientStart(player :: Player, frequency)
		end
	end)
	if not started then
		connection:Disconnect()
		error(`ScriptProfilerService could not start: {startError}`, 0)
	end
	task.wait(durationMs / 1000)
	local stopped, stopError = pcall(function()
		if isServer then
			service:ServerStop()
			service:ServerRequestData()
		else
			service:ClientStop(player :: Player)
			service:ClientRequestData(player :: Player)
		end
	end)
	if not stopped then
		connection:Disconnect()
		error(`ScriptProfilerService could not stop: {stopError}`, 0)
	end
	local deadline = os.clock() + 5
	while data == nil and os.clock() < deadline do
		task.wait(0.05)
	end
	connection:Disconnect()
	if data == nil then error("ScriptProfilerService sent no data within 5 s of the request", 0) end
	local json = data :: string
	local HttpService = game:GetService("HttpService")
	local decoded, profile = pcall(function() return HttpService:JSONDecode(json) end)
	if not decoded or type(profile) ~= "table" then error(`the profiler's data is not JSON ({#json} bytes)`, 0) end
	local functions = if type(profile.Functions) == "table" then profile.Functions else {}
	local rows = {}
	local omitted = { native = 0, plugin = 0, quack = 0, filtered = 0 }
	for _, f in functions do
		if type(f) ~= "table" then continue end
		local flags = tonumber(f.Flags) or 0
		local source = if type(f.Source) == "string" then f.Source else ""
		local line = tonumber(f.Line) or 0
		local name = if type(f.Name) == "string" and f.Name ~= "" then f.Name else "<anonymous>"
		local isQuack = string.find(source, CHUNK, 1, true) ~= nil or string.find(source, "QuackPlugin", 1, true) ~= nil
		if bit32.band(flags, 1) ~= 0 and args.includeNative ~= true then
			omitted.native += 1
			continue
		end
		if (isQuack or bit32.band(flags, 2) ~= 0) and args.includePlugin ~= true then
			if isQuack then omitted.quack += 1 else omitted.plugin += 1 end
			continue
		end
		if filter and not string.find(string.lower(`{name} {source}`), filter, 1, true) then
			omitted.filtered += 1
			continue
		end
		table.insert(rows, {
			name = name,
			source = if source ~= "" then source else nil,
			line = if line > 0 then line else nil,
			totalUs = tonumber(f.TotalDuration) or 0,
			native = if bit32.band(flags, 1) ~= 0 then true else nil,
		})
	end
	table.sort(rows, function(a, b) return a.totalUs > b.totalUs end)
	local top = {}
	for i = 1, math.min(maxFunctions, #rows) do
		local row = rows[i]
		row.rank = i
		row.pct = round(row.totalUs / (durationMs * 1000) * 100, 2)
		row.totalUs = math.floor(row.totalUs + 0.5)
		top[i] = row
	end
	return {
		durationMs = durationMs,
		frequency = frequency,
		functions = top,
		counted = #functions,
		kept = #rows,
		omitted = omitted,
		player = if player then player.Name else nil,
		raw = if args.raw == true then json else nil,
	}
end

--------------------------------------------------------------------------------------------
-- Studio's Scene Analysis (SceneAnalysisService, a beta feature): each breakdown is a tree,
-- flattened to its leaves and sorted by size (triangles by their count). In mode all every
-- breakdown answers for itself, its error included.

local SCENE_METHODS: { [string]: string } = {
	instance_composition = "GetInstanceCompositionAsync",
	script_memory = "GetScriptMemoryAsync",
	unparented_instances = "GetUnparentedInstancesAsync",
	triangle_composition = "GetTriangleCompositionAsync",
	animation_memory = "GetAnimationMemoryAsync",
	audio_memory = "GetAudioMemoryAsync",
}
local SCENE_ORDER: { string } = { "instance_composition", "script_memory", "unparented_instances", "triangle_composition", "animation_memory", "audio_memory" }

local function sceneLeaves(node: any, out: { any })
	local children = if type(node) == "table" then node.Children else nil
	if type(children) == "table" and #children > 0 then
		for _, child in children do
			sceneLeaves(child, out)
		end
	elseif type(node) == "table" then
		table.insert(out, node)
	end
end

local function sceneSize(node: any, triangles: boolean): number
	if triangles then return if type(node.Sizes) == "table" then tonumber(node.Sizes.Triangles) or 0 else 0 end
	return tonumber(node.Size) or 0
end

local function sceneAnalysis(args: { [string]: any }): { [string]: any }
	local found, service = pcall(function() return (game :: any):GetService("SceneAnalysisService") end)
	if not found or not service then
		error('SceneAnalysisService is not available: turn on the beta feature "Scene Analysis" (File > Beta Features) and restart Studio', 0)
	end
	local topN = math.clamp(math.floor(tonumber(args.topN) or 10), 1, 100)
	local modes: { string } = if args.mode == nil or args.mode == "all" then SCENE_ORDER else { tostring(args.mode) }
	local out: { [string]: any } = {}
	for _, mode in modes do
		local method = SCENE_METHODS[mode]
		if not method then error(`mode must be all or one of {table.concat(SCENE_ORDER, ", ")}`, 0) end
		local started = os.clock()
		local ok, tree = pcall(function() return service[method](service) end)
		local ms = math.floor((os.clock() - started) * 1000)
		if not ok then
			local message = tostring(tree)
			if string.find(message, "not enabled", 1, true) then
				message ..= ' (turn on the beta feature "Scene Analysis" in File > Beta Features and restart Studio)'
			end
			out[mode] = { method = method, ms = ms, error = message }
			continue
		end
		local leaves = {}
		sceneLeaves(tree, leaves)
		local triangles = mode == "triangle_composition"
		table.sort(leaves, function(a, b) return sceneSize(a, triangles) > sceneSize(b, triangles) end)
		local top = {}
		for i = 1, math.min(topN, #leaves) do
			local leaf = leaves[i]
			top[i] = { name = leaf.Name, size = leaf.Size, sizes = leaf.Sizes, assetId = leaf.AssetId }
		end
		out[mode] = {
			method = method,
			ms = ms,
			root = { name = if type(tree) == "table" then tree.Name else nil, size = if type(tree) == "table" then tree.Size else nil, sizes = if type(tree) == "table" then tree.Sizes else nil, leaves = #leaves },
			top = top,
		}
	end
	return { modes = out, order = modes }
end

--------------------------------------------------------------------------------------------

export type Role = "edit" | "server" | "client"

local function codeOf(args: { [string]: any }): string
	if type(args.code) ~= "string" or args.code == "" then error("code is required", 0) end
	return args.code
end

local HANDLERS: { [string]: { [Role]: (args: { [string]: any }) -> any } } = {
	eval = {
		server = function(args) return evalInGame(withPrelude(args, codeOf(args))) end,
		client = function(args) return evalInGame(withPrelude(args, codeOf(args))) end,
	},
	exec = { edit = function(args) return execInPlugin(withPrelude(args, codeOf(args))) end },
	playState = { edit = function() return { editModeActive = StudioTestService.EditModeActive } end },
	playStart = {
		edit = function(args)
			if not StudioTestService.EditModeActive then error("a play is already running: stop it first", 0) end
			local run = args.mode == "run"
			local players = tonumber(args.players)
			task.spawn(function()
				local ok, err = pcall(function()
					if players then
						-- Studio's Local Server: a server window and one window a player
						return StudioTestService:ExecuteMultiplayerTestAsync(players, {})
					end
					if run then
						return StudioTestService:ExecuteRunModeAsync({})
					end
					return StudioTestService:ExecutePlayModeAsync({})
				end)
				if not ok then warn("[Quack]: the play ended with an error:", err) end
			end)
			return { mode = if players then "multiplayer" elseif run then "run" else "play" }
		end,
	},
	stop = {
		server = function()
			local ok, err = pcall(function() StudioTestService:EndTest("quack") end)
			if not ok then error(`StudioTestService:EndTest failed: {err}`, 0) end
			return { stopping = true }
		end,
	},
	captureBegin = { client = function(args: { [string]: any }) return captureBegin(args) end },
	captureRead = { edit = function(args) return captureRead(args.contentId, tonumber(args.maxWidth)) end },
	capture = { edit = function(args: { [string]: any }) return captureRead((captureBegin(args) :: any).contentId, tonumber(args.maxWidth)) end },
	captureBurst = { client = captureBurst, edit = captureBurst },
	key = { client = key, edit = key },
	click = { client = click },
	gui = { client = inspectGui, edit = inspectGui },
	mouse = { client = mouse },
	sourceCheck = { edit = sourceCheck },
	perf = { server = perfSample, client = perfSample },
	logpoint = { edit = logpoint },
	inspect = { edit = inspectInstance, server = inspectInstance, client = inspectInstance },
	setProps = { edit = setProperties, server = setProperties, client = setProperties },
	simulate = { edit = simulate, client = simulate },
	tabs = { edit = scriptTabs },
	exportRbxm = { edit = exportRbxm },
	importRbxm = { edit = importRbxm },
	device = { edit = device },
	assetPreview = { edit = previewAsset },
	assetInsert = { edit = insertAsset },
	memory = { edit = memoryBreakdown, server = memoryBreakdown, client = memoryBreakdown },
	profiler = { server = scriptProfiler, client = scriptProfiler },
	scene = { edit = sceneAnalysis, server = sceneAnalysis, client = sceneAnalysis },
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
