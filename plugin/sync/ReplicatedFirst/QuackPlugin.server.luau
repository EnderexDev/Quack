--!strict
--[[
	Quack - Roblox Studio plugin.
	Syncs the place with its folder on disk through the Quack hub.

	Ransomwave 2025
]]

const RunService = game:GetService("RunService")

const pluginParent = script.Parent
if not pluginParent then return end

-- Modules
const Config = require("@self/Config")
const Enums = require("@self/Enums")
const SettingsStore = require("@self/SettingsStore")

-- State Management
-- Own settings keys: a plugin installed next to Quack could have saved others (seen 19/10/26
-- in place PA, with AUTO_CONNECT false and WS_URL on another port).
local settingsStore = SettingsStore.new(plugin, Config, Enums.scope, {
	defaultScope = Enums.scope.GLOBAL,
	settingsKey = "QUACK_SETTINGS",
	settingsScopeKey = "QUACK_SETTINGS_SCOPE_BY_PLACE",
	legacyFlatSettings = false,
})

-- Playtest DataModels only relay output; syncing stays in the edit DataModel
if RunService:IsRunning() then
	const OutputRelay = require("@self/OutputRelay")
	-- Quack: the server of a `quackdev play` checks it got the worktree's scripts and says so
	-- on the same socket, so the server opens it even with the output relay off
	const isServer = RunService:IsServer()
	if Config.STREAM_SOLO_OUTPUT or isServer then
		const send = OutputRelay.start(Config.WS_URL, Config.STREAM_SOLO_OUTPUT)
		if isServer then
			task.spawn(function()
				const PlayOverlay = require("@self/PlayOverlay")
				const ok, report = pcall(PlayOverlay.check)
				if ok and report then send(report) end
				if not ok then warn("[Quack]: Could not check the play's scripts:", report) end
			end)
		end
	end
	return
end

const SyncSession = require("@self/SyncSession")

-- UI Apps
const quackApp = require("@self/App/UI")

const session = SyncSession.new(plugin, settingsStore, Config)

--[=[
    UI Callback Handlers
]=]
const uiCallbacks: quackApp.CallbackFunctions = {
	onStartSync = function()
		-- If the auto-connect runner is active, stop it while user triggers manual start.
		session:stopAutoConnect()

		session:startSync()

		-- If Auto Connect still requested, restart the auto-connect runner to monitor
		if Config.AUTO_CONNECT then session:startAutoConnect() end
	end,

	onStopSync = function() session:stopSync() end,

	onAutoConnectChanged = function(newValue: boolean)
		Config.AUTO_CONNECT = newValue
		session:debugPrint(`Auto Connect changed: {newValue}`)
		if newValue then
			session:startAutoConnect()
		else
			session:stopAutoConnect()
		end
	end,

	onConfigChanged = function(key, value)
		session:debugPrint(
			`Config {key} updated to: {if type(value) == "table" then table.concat(value, ", ") else tostring(value)}`
		)
		Config[key] = value
		settingsStore:saveSettings() -- Playtest DataModels read settings when they start
		if key == "SERVICE_LIST" then session:rebuildServiceSet() end
		if key == "AUTO_CONNECT" then
			if value then
				session:startAutoConnect()
			else
				session:stopAutoConnect()
				if session.syncEnabled and not session.handshakeComplete then session:stopSync() end
			end
		end
	end,

	onSettingsScopeChanged = function(newScope) session:onSettingsScopeChanged(newScope) end,

	onPlaceIgnoredChanged = function(ignored: boolean) session:setPlaceIgnored(ignored) end,

	onRequestSetup = function() session:requestSetup() end,

	onSourcemapReload = function()
		session:infoPrint("Reloading sourcemap...")
		session:reloadSourcemap()
	end,
}

local uiHelpers: quackApp.HelperFunctions = {
	rebuildServiceSet = function() session:rebuildServiceSet() end,
	isPlaceIgnored = function() return settingsStore:isPlaceIgnored() end,

	openPlaceConfig = function()
		local ScriptEditorService = game:GetService("ScriptEditorService")
		local ServerStorage = game:GetService("ServerStorage")
		-- The Config that applies, in the order the session reads it: ServerStorage.Quack, then
		-- ServerStorage.Azul (places set up before Quack 1.0). A new one is made only when neither
		-- has it, so an empty Quack.Config never hides a working Azul.Config
		local function existing(folderName: string): ModuleScript?
			local folder = ServerStorage:FindFirstChild(folderName)
			return folder and folder:FindFirstChild("Config") :: ModuleScript?
		end
		local placeConfig = existing("Quack") or existing("Azul")
		local configFolder = ServerStorage:FindFirstChild("Quack") :: Folder?
		if not placeConfig and not configFolder then
			configFolder = Instance.new("Folder")
			configFolder.Name = "Quack"
			configFolder.Parent = ServerStorage
		end

		if not placeConfig then
			local newConfigModule = Instance.new("ModuleScript")
			newConfigModule.Name = "Config"
			newConfigModule.Source = [[
-- Per-place Quack configuration
-- Sent to the daemon when this place syncs. Holds settings for this place only, such as the
-- push mappings ('quack push' with no -s/-d uses them).

return {}
]]
			newConfigModule.Parent = configFolder
			placeConfig = newConfigModule
		end

		ScriptEditorService:OpenScriptDocumentAsync(placeConfig)
	end,
}

--[=[
    Initialization
]=]
const quackUI = quackApp.new(plugin, uiCallbacks, settingsStore:getScope(), uiHelpers)
session:setUI(quackUI)

-- Plugin Lifecycle
plugin.Unloading:Connect(function()
	session:stopAutoConnect()
	settingsStore:saveSettings()
	settingsStore:saveSelectedScope()
	session:stopSync()
end)

--- Formats a duration in seconds as e.g. "3 days".
local function formatDuration(seconds: number): string
	const units: { { seconds: number, name: string } } = {
		{ seconds = 86400, name = "day" },
		{ seconds = 3600, name = "hour" },
		{ seconds = 60, name = "minute" },
	}
	for _, unit in units do
		local count = seconds // unit.seconds
		if count >= 1 then return `{count} {unit.name}{if count == 1 then "" else "s"}` end
	end
	return "less than a minute"
end

if Config.AUTO_CONNECT then
	session:startAutoConnect()
else
	session:infoPrint("Plugin loaded. Click on the 'Quack' button to connect.")

	-- Remind to sync Places that were synced before
	local lastSynced = settingsStore:getLastSynced()
	if lastSynced and Config.SYNC_REMINDERS then
		quackUI:Notify(
			`You synced this place with Quack {formatDuration(os.time() - lastSynced)} ago. Connect again?`,
			15,
			{
				{ Text = "Connect", Activated = uiCallbacks.onStartSync },
				{ Text = "Forget", Activated = function() settingsStore:forgetPlace() end },
			}
		)
	end
end

session:debugPrint("Debug mode is enabled!")
session:debugPrint(`Service list type is set to: "{Config.LIST_TYPE}"`)
