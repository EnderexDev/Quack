--!strict
--[[
	Settings storage helper for the Quack plugin config.
	Handles global/project scope selection and persisted config values.
]]

local SettingsStore = {}

--- Defaults that changed (Quack 1.0.20). Settings saved before that hold the old value because
--- every save writes the whole config, not because anyone chose it; once migrated (the saved
--- version is SETTINGS_VERSION), a value equal to an old default is a real choice and stays.
local OLD_DEFAULTS: { [string]: any } = {
	SCRIPT_CHANGE_DEBOUNCE = 0.35,
	BATCH_IDLE_WINDOW = 0.1,
}
local SETTINGS_VERSION = 2
SettingsStore.__index = SettingsStore

type ScopeEnum = {
	GLOBAL: string,
	PROJECT: string,
}

type SettingsStoreOptions = {
	settingsKey: string?,
	settingsScopeKey: string?,
	defaultScope: string?,
	-- Read pre-table flat settings (GetSetting("WS_URL")...). Off: those keys belong to other plugins.
	legacyFlatSettings: boolean?,
}

export type SettingsStore = {
	plugin: Plugin,
	config: { [string]: any }, -- Reference to the live config table (Module) used by the plugin.
	scopeEnum: ScopeEnum,
	settingsKey: string,
	settingsScopeKey: string,
	scope: string,
	storedSettings: { [string]: any },
	legacyFlatSettings: boolean,

	getScopeKey: (self: SettingsStore, scope: string) -> string,
	getPlaceScopeSelectionKey: (self: SettingsStore) -> string,
	saveSelectedScope: (self: SettingsStore) -> (),
	loadSelectedScope: (self: SettingsStore) -> (),
	saveSettings: (self: SettingsStore) -> (),
	loadSettings: (self: SettingsStore) -> (),
	getScope: (self: SettingsStore) -> string,
	setScope: (self: SettingsStore, newScope: string) -> (),
	getLastSynced: (self: SettingsStore) -> number?,
	markPlaceSynced: (self: SettingsStore) -> (),
	isPlaceIgnored: (self: SettingsStore) -> boolean,
	setPlaceIgnored: (self: SettingsStore, ignored: boolean) -> (),
	forgetPlace: (self: SettingsStore) -> (),
}

-- Plugin setting holding `{ [placeId]: os.time() of the last successful sync }`
local SYNCED_PLACES_KEY = "QUACK_SYNCED_PLACES"
-- Places the user said should never connect (no auto-connect, no Quack pop-ups)
local IGNORED_PLACES_KEY = "QUACK_IGNORED_PLACES"

--[=[
	Constructor for SettingsStore.

	@param plugin The plugin instance, used for GetSetting/SetSetting.
	@param config Reference to the live config table (Module) used by the plugin. This table will be read from and written to.
	@param scopeEnum An enum table containing scope identifiers, e.g. `{ GLOBAL = "global", PROJECT = "project" }`.
	@param options Optional settings:<br/>- `settingsKey`: The key under which all settings will be stored in plugin settings. Default is "QUACK_SETTINGS".<br/>- `settingsScopeKey`: The key under which scope selections will be stored in plugin settings. Default is "QUACK_SETTINGS_SCOPE_BY_PLACE".<br/>- `defaultScope`: The default scope to use if no selection is found. Should be one of the values in scopeEnum. Default is scopeEnum.GLOBAL.

	@return A new instance of SettingsStore.
]=]
function SettingsStore.new(
	plugin: Plugin,
	config: { [string]: any },
	scopeEnum: ScopeEnum,
	options: SettingsStoreOptions?
): SettingsStore
	local self = setmetatable({}, SettingsStore)
	self.plugin = plugin
	self.config = config
	self.scopeEnum = scopeEnum
	self.settingsKey = if options and options.settingsKey then options.settingsKey else "QUACK_SETTINGS"
	self.settingsScopeKey = if options and options.settingsScopeKey
		then options.settingsScopeKey
		else "QUACK_SETTINGS_SCOPE_BY_PLACE"
	self.scope = if options and options.defaultScope then options.defaultScope else scopeEnum.GLOBAL
	self.storedSettings = {}
	self.legacyFlatSettings = not (options and options.legacyFlatSettings == false)

	self:loadSelectedScope()
	self:loadSettings()

	return (self :: any) :: SettingsStore
end

function SettingsStore:getScopeKey(scope: string): string
	local placeId = tostring(game.PlaceId or "0")
	if scope == self.scopeEnum.PROJECT then return `project_{placeId}` end
	return self.scopeEnum.GLOBAL
end

function SettingsStore:getPlaceScopeSelectionKey(): string return tostring(game.PlaceId or "0") end

function SettingsStore:saveSelectedScope()
	local selectedScopes = self.plugin:GetSetting(self.settingsScopeKey)
	if type(selectedScopes) ~= "table" then selectedScopes = {} end

	selectedScopes[self:getPlaceScopeSelectionKey()] = self.scope
	self.plugin:SetSetting(self.settingsScopeKey, selectedScopes)
end

function SettingsStore:loadSelectedScope()
	local selectedScopes = self.plugin:GetSetting(self.settingsScopeKey)
	if type(selectedScopes) ~= "table" then return end

	local selectedScope = selectedScopes[self:getPlaceScopeSelectionKey()]
	if selectedScope == self.scopeEnum.GLOBAL or selectedScope == self.scopeEnum.PROJECT then
		self.scope = selectedScope
	end
end

function SettingsStore:saveSettings()
	local allSettings = self.plugin:GetSetting(self.settingsKey)
	if type(allSettings) ~= "table" then allSettings = {} end

	local scopeKey = self:getScopeKey(self.scope)
	local scopedCopy = {}
	for key, value in pairs(self.config) do
		scopedCopy[key] = value
	end

	-- Always persist debug/silent at the global level.
	local globalScoped = allSettings[self.scopeEnum.GLOBAL]
	if type(globalScoped) ~= "table" then globalScoped = {} end
	globalScoped.DEBUG_MODE = self.config.DEBUG_MODE
	globalScoped.SILENT_MODE = self.config.SILENT_MODE
	globalScoped.AUTO_OPEN_MODAL = self.config.AUTO_OPEN_MODAL
	globalScoped.SYNC_REMINDERS = self.config.SYNC_REMINDERS
	allSettings[self.scopeEnum.GLOBAL] = globalScoped

	allSettings[scopeKey] = scopedCopy
	-- From here on, a saved value equal to an old default is a choice (see OLD_DEFAULTS). Every
	-- other stored scope is migrated first, or switching to it would keep its old defaults.
	if (tonumber(allSettings._version) or 1) < SETTINGS_VERSION then
		for key, scope in pairs(allSettings) do
			if key ~= scopeKey and type(scope) == "table" then
				for setting, old in pairs(OLD_DEFAULTS) do
					if scope[setting] == old then scope[setting] = nil end
				end
			end
		end
	end
	allSettings._version = SETTINGS_VERSION
	self.storedSettings = allSettings
	self.plugin:SetSetting(self.settingsKey, allSettings)
end

function SettingsStore:loadSettings()
	local allSettings = self.plugin:GetSetting(self.settingsKey)
	if type(allSettings) ~= "table" then
		allSettings = {}

		-- Legacy flat settings fallback.
		if self.legacyFlatSettings then
			for key, _ in pairs(self.config) do
				local legacyValue = self.plugin:GetSetting(key)
				if legacyValue ~= nil then self.config[key] = legacyValue end
			end
		end

		self.storedSettings = allSettings
		return
	end

	self.storedSettings = allSettings

	local scopeKey = self:getScopeKey(self.scope)
	local scoped = allSettings[scopeKey]
	local globalScoped = allSettings[self.scopeEnum.GLOBAL]

	if type(scoped) ~= "table" then scoped = {} end
	if type(globalScoped) ~= "table" then globalScoped = {} end
	local migrate = (tonumber(allSettings._version) or 1) < SETTINGS_VERSION

	for key, _ in pairs(self.config) do
		local value = scoped[key]
		if value == nil and scopeKey ~= self.scopeEnum.GLOBAL then value = globalScoped[key] end
		-- Saved before the defaults changed: an old default there was never a choice
		if value ~= nil and migrate and OLD_DEFAULTS[key] == value then value = nil end
		if value ~= nil then self.config[key] = value end
	end

	-- DEBUG_MODE, SILENT_MODE, AUTO_OPEN_MODAL and SYNC_REMINDERS always come from global.
	if globalScoped.DEBUG_MODE ~= nil then self.config.DEBUG_MODE = globalScoped.DEBUG_MODE end
	if globalScoped.SILENT_MODE ~= nil then self.config.SILENT_MODE = globalScoped.SILENT_MODE end
	if globalScoped.AUTO_OPEN_MODAL ~= nil then self.config.AUTO_OPEN_MODAL = globalScoped.AUTO_OPEN_MODAL end
	if globalScoped.SYNC_REMINDERS ~= nil then self.config.SYNC_REMINDERS = globalScoped.SYNC_REMINDERS end
end

function SettingsStore:getScope(): string return self.scope end

function SettingsStore:setScope(newScope: string)
	if newScope ~= self.scopeEnum.GLOBAL and newScope ~= self.scopeEnum.PROJECT then return end
	if newScope == self.scope then return end

	self:saveSettings()
	self.scope = newScope
	self:saveSelectedScope()
	self:loadSettings()
end

--- Returns the synced-places table from plugin settings.
local function getSyncedPlaces(plugin: Plugin): { [string]: number }
	local places = plugin:GetSetting(SYNCED_PLACES_KEY)
	return if type(places) == "table" then places else {}
end

--[=[
	Returns when this Place was last synced (`os.time()`), or nil if it never was.
	Unpublished places (PlaceId 0) can't be told apart, so they are never tracked.
]=]
function SettingsStore:getLastSynced(): number?
	if game.PlaceId == 0 then return nil end
	return getSyncedPlaces(self.plugin)[tostring(game.PlaceId)]
end

--- Records that this Place was just synced.
function SettingsStore:markPlaceSynced()
	if game.PlaceId == 0 then return end
	local places = getSyncedPlaces(self.plugin)
	places[tostring(game.PlaceId)] = os.time()
	self.plugin:SetSetting(SYNCED_PLACES_KEY, places)
end

--- Whether the user turned syncing off for this Place. An unsaved place (PlaceId 0) has no id
--- to save it under: its choice lasts until Studio closes.
function SettingsStore:isPlaceIgnored(): boolean
	if game.PlaceId == 0 then return (self :: any)._ignoredThisSession == true end
	local places = self.plugin:GetSetting(IGNORED_PLACES_KEY)
	return type(places) == "table" and places[tostring(game.PlaceId)] == true
end

function SettingsStore:setPlaceIgnored(ignored: boolean)
	if game.PlaceId == 0 then
		(self :: any)._ignoredThisSession = ignored
		return
	end
	local places = self.plugin:GetSetting(IGNORED_PLACES_KEY)
	if type(places) ~= "table" then places = {} end
	places[tostring(game.PlaceId)] = if ignored then true else nil
	self.plugin:SetSetting(IGNORED_PLACES_KEY, places)
end

--- Removes this Place from the synced places, so it no longer gets sync reminders.
function SettingsStore:forgetPlace()
	local places = getSyncedPlaces(self.plugin)
	places[tostring(game.PlaceId)] = nil
	self.plugin:SetSetting(SYNCED_PLACES_KEY, places)
end

return SettingsStore
