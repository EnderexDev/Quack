--!strict
--[[
	Quack: the Studio tools the daemon calls (src/studioTools.ts). Each DataModel's plugin
	answers the ones that run there:
	  edit    exec, playStart, playState, capture, captureRead, captureBurst, key, device
	  server  eval, stop
	  client  eval, captureBegin, captureBurst, key, click

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
	local player = Players.LocalPlayer
	local node: Instance? = nil
	local i = 2
	if parts[1] == "StarterGui" or parts[1] == "PlayerGui" then
		node = player and player:FindFirstChildOfClass("PlayerGui")
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
	captureRead = { edit = function(args) return captureRead(args.contentId, tonumber(args.maxWidth)) end },
	capture = { edit = function() return captureRead(captureBegin().contentId) end },
	captureBurst = { client = captureBurst, edit = captureBurst },
	key = { client = key, edit = key },
	click = { client = click },
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
