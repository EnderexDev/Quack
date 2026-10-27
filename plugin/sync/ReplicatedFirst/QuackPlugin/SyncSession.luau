--!strict

--[[
    SyncSession - Class for managing a sync session between the Quack plugin and the daemon.

    Ransomwave 2026
]]

local SyncSession = {}
SyncSession.__index = SyncSession

-- Services
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local ScriptEditorService = game:GetService("ScriptEditorService")

-- Modules
local QuackService = require("./QuackService")
local Enums = require("./Enums")
local Logger = require("./Logger")
local SettingsStore = require("./SettingsStore")
local WebSocketClient = require("./WebSocketClient")
local PlayOverlay = require("./PlayOverlay")

export type SyncSession = {
	-- Constructor fields
	plugin: Plugin,
	settingsStore: SettingsStore.SettingsStore,
	config: any,
	ui: any?,

	-- State fields
	syncEnabled: boolean,
	wsClient: WebSocketClient.WebSocketClient?,
	trackedInstances: { [Instance]: string },
	guidMap: { [string]: Instance },
	usedGuids: { [string]: boolean },
	lastHeartbeat: number,
	lastSyncedSource: { [string]: string },
	lastInstanceUpdate: { [string]: { key: string, t: number } },
	connections: { RBXScriptConnection },
	suppressOutbound: boolean,
	pendingInstanceUpdates: { [string]: any },
	pendingScriptChanges: { [string]: any },
	pendingScriptChangeReady: { [string]: boolean },
	scriptChangeDebounceTokenByGuid: { [string]: number },
	scriptChangeDebounceThreadByGuid: { [string]: thread },
	pendingDeletes: { [string]: boolean },
	batchingEnabled: boolean,
	batchFlushToken: number,
	batchAccumulator: number,
	serviceSet: { [string]: boolean },
	listenerAttachedInstances: { [Instance]: boolean },
	handshakeComplete: boolean,

	-- Methods
	startSync: (self: SyncSession, suppressInfo: boolean?) -> (),
	stopSync: (self: SyncSession, dontRelayDisconnect: boolean?) -> (),
	openLink: (self: SyncSession) -> boolean,
	goOffline: (self: SyncSession) -> (),
	reloadSourcemap: (self: SyncSession) -> (),
	onSettingsScopeChanged: (self: SyncSession, newScope: string) -> (),
	setUI: (self: SyncSession, ui: any) -> (),
	debugPrint: (self: SyncSession, ...any) -> (),
	infoPrint: (self: SyncSession, ...any) -> (),
	notify: (self: SyncSession, text: string, timeout: number?) -> (),
	rebuildServiceSet: (self: SyncSession) -> (),
	startAutoConnect: (self: SyncSession) -> (),
	stopAutoConnect: (self: SyncSession) -> (),
	setPlaceIgnored: (self: SyncSession, ignored: boolean) -> (),
	requestSetup: (self: SyncSession) -> (),
	markPlaceSynced: (self: SyncSession) -> (),

	-- Auto-connect helpers
	_autoConnectThread: thread?,
	-- The watchdog's wait for a handshake; kept here so stopAutoConnect, which cancels the
	-- watchdog mid-wait, can disconnect it too
	_autoConnectHandshakeConn: RBXScriptConnection?,
	_handshakeBindable: BindableEvent?,
	_suppressAutoConnectLogs: boolean?,
	_sessionId: string?,
	_placeName: string?,
	_connectExplicit: boolean?,
	_setupRequested: boolean?,
	_lastNotice: string?,
	_lastNoticeAt: number?,
	_lastHubError: string?,
	_lastHubErrorAt: number?,
	-- Where the hub sent this Studio (its daemon), used by the next openLink only
	_redirectUrl: string?,
	-- The place's listeners are set up (once per session; a resumed link keeps them)
	_tracking: boolean?,
	-- The link dropped while synced: changes queue up while it reconnects
	_offline: boolean?,
	_offlineSince: number?,
	-- Scripts sent lately, with the text agreed before: resent after a resume
	_recentScriptSends: { [string]: { at: number, base: string? } },
	-- True while sendFullSnapshot walks the place: changes wait in the queues until it is sent
	_snapshotInProgress: boolean?,
	_batchFlushThread: thread?,
}

-- Constants
-- The place's own config; places set up before Quack 1.0 keep it under ServerStorage.Azul
local PUSH_CONFIG_PATH = {
	"ServerStorage",
	"Quack",
	"Config",
}
local LEGACY_PUSH_CONFIG_PATH = {
	"ServerStorage",
	"Azul",
	"Config",
}

-- Legacy! Does not get used after initial snapshot!
local INITIAL_BATCH_INTERVAL = 0.2 -- Seconds between outbound batch flushes

--- Daemon and plugin only have to agree on major.minor; patch releases stay compatible.
local function getMajorMinorVersion(version: string): string return version:match("^%d+%.%d+") or version end

--- The 2.4 daemon (numbered before Quack had its own versions) speaks Quack 1.0's protocol
local function versionsMatch(a: string, b: string): boolean
	local ka, kb = getMajorMinorVersion(a), getMajorMinorVersion(b)
	return ka == kb or (ka == "2.4" and kb == "1.0") or (ka == "1.0" and kb == "2.4")
end

local function safeGetNumber(value: any, default: number)
	if type(value) == "number" and value > 0 then return value end
	return default
end

function SyncSession:debugPrint(...)
	if self.config.SILENT_MODE or not self.config.DEBUG_MODE then return end
	print(`[🐛 Quack::{script}]:`, ...)
end

function SyncSession:infoPrint(...) Logger.info("[Quack]:", ...) end

--- How long the same notice stays quiet after it was shown: auto-connect retries every few
--- seconds and used to stack the same refusal (seen 20/10/26)
local REPEAT_QUIET_SECONDS = 60

--- Shows a pop-up notification in the UI, if one is attached. Nothing at all on an ignored place,
--- and a notice identical to the last one is not shown again for a minute.
function SyncSession:notify(text: string, timeout: number?, actions: { any }?)
	if not self.ui or self.settingsStore:isPlaceIgnored() then return end
	local now = os.clock()
	if text == self._lastNotice and now - (self._lastNoticeAt or 0) < REPEAT_QUIET_SECONDS then return end
	self._lastNotice = text
	self._lastNoticeAt = now
	self.ui:Notify(text, timeout, actions)
end

--- Asks the Quack app to set this place up: connects at once with the setup flag, which the
--- app answers with its setup window; auto-connect keeps the flag until the place connects
function SyncSession:requestSetup()
	if game.PlaceId == 0 then
		self:notify("Save the place to Roblox first: an unsaved place has no id to register.", 10)
		return
	end
	self._setupRequested = true
	self._lastNotice = nil
	if self.syncEnabled then self:stopSync(true) end
	self:stopAutoConnect()
	self:startSync()
	if self.config.AUTO_CONNECT then self:startAutoConnect() end
end

--- Turns syncing off (or back on) for this Place: no auto-connect, no pop-ups while off
function SyncSession:setPlaceIgnored(ignored: boolean)
	self.settingsStore:setPlaceIgnored(ignored)
	if self.ui then self.ui:UpdatePlaceIgnored(ignored) end
	if ignored then
		self:stopAutoConnect()
		if self.syncEnabled then self:stopSync(true) end
		self:infoPrint("Syncing is off for this place")
	elseif self.config.AUTO_CONNECT then
		self:startAutoConnect()
	end
end

function SyncSession:rebuildServiceSet() QuackService.rebuildServiceSet(self.serviceSet) end

function SyncSession:setUI(ui) self.ui = ui end

function SyncSession.new(plugin: Plugin, settingsStore: SettingsStore.SettingsStore, config: any): SyncSession
	local self = (setmetatable({}, SyncSession) :: any) :: SyncSession

	self.plugin = plugin
	self.settingsStore = settingsStore
	self.config = config
	self.ui = nil
	self._sessionId = HttpService:GenerateGUID(false)
	-- game.Name is the internal "Place1"; the hub and the app show the name Roblox knows
	if game.PlaceId ~= 0 then
		task.spawn(function()
			local ok, info = pcall(function() return game:GetService("MarketplaceService"):GetProductInfo(game.PlaceId) end)
			if ok and type(info) == "table" and type(info.Name) == "string" and info.Name ~= "" then
				self._placeName = info.Name
			end
		end)
	end

	self.syncEnabled = false
	self.wsClient = nil
	self.trackedInstances = {}
	self.guidMap = {}
	self.usedGuids = {}
	self.lastHeartbeat = 0
	self.lastSyncedSource = {}
	self._recentScriptSends = {}
	self.lastInstanceUpdate = {}
	self.connections = {}
	self.suppressOutbound = false

	self.pendingInstanceUpdates = {}
	self.pendingScriptChanges = {}
	self.pendingScriptChangeReady = {}
	self.scriptChangeDebounceTokenByGuid = {}
	self.scriptChangeDebounceThreadByGuid = {}
	self.pendingDeletes = {}

	self.batchingEnabled = false
	self.batchFlushToken = 0
	self.batchAccumulator = 0
	self.serviceSet = {}
	self.listenerAttachedInstances = {}
	self.handshakeComplete = false

	-- Auto-connect helpers
	self._autoConnectThread = nil
	self._handshakeBindable = Instance.new("BindableEvent")

	self:rebuildServiceSet()

	local function shouldIncludeInSnapshot(instance)
		if not instance then return false end
		return not QuackService.isExcluded(instance, self.serviceSet)
	end

	local function sendMessage(messageTypeOrPayload: string | { any }, data: any?)
		if not self.wsClient or not self.wsClient.connected then return false end

		local message

		-- If the caller provided a string, wrap it in a message object with the string as the "type" field and the data as the "data" field.
		-- If the caller provided a table, use it directly as the message object.
		if type(messageTypeOrPayload) == "table" then
			message = {}
			for key, value in pairs(messageTypeOrPayload) do
				message[key] = value
			end
		else
			message = {
				type = messageTypeOrPayload,
			}
			for key, value in pairs(data or {}) do
				message[key] = value
			end
		end

		self:debugPrint(`Sending message: {message.type}`)
		local encodeOk, encodedOrErr = pcall(function() return HttpService:JSONEncode(message) end)
		if not encodeOk then
			warn(`[Quack]: Cannot JSON-encode outbound message (type: {tostring(message.type)}): {encodedOrErr}`)
			return false
		end
		return self.wsClient:send(encodedOrErr)
	end

	--- Quack: the text sent is read now, not the one captured at edit time (a disk patch may have
	--- landed in between), and it carries `base`: the last text Studio and the daemon agreed on.
	--- A base different from the disk tells the daemon two edits raced, so it merges them.
	local function scriptChangeData(payload)
		local instance = self.guidMap[payload.guid]
		local source = payload.source
		if instance and QuackService.isScript(instance) then
			source = ScriptEditorService:GetEditorSource(instance)
		end
		return {
			guid = payload.guid,
			path = payload.path,
			className = payload.className,
			source = source,
			base = self.lastSyncedSource[payload.guid],
		}
	end

	--- After the daemon got a script change: drop it from the queue and move the agreed text.
	--- Not before: a failed send keeps the edit queued and the old base for the retry.
	local function commitScriptChange(data)
		-- Sent is not received: a link that drops right after may have lost it. Kept a few
		-- seconds with the text agreed before it, so a resumed session can send it again.
		self._recentScriptSends[data.guid] = { at = os.clock(), base = self.lastSyncedSource[data.guid] }
		self.pendingScriptChanges[data.guid] = nil
		self.pendingScriptChangeReady[data.guid] = nil
		-- Bump, never reset: a reset token 1 would match a still-pending delay from an older edit
		self.scriptChangeDebounceTokenByGuid[data.guid] = (self.scriptChangeDebounceTokenByGuid[data.guid] or 0) + 1
		self.lastSyncedSource[data.guid] = data.source
	end


	local function flushOutboundQueues()
		-- A change sent while the snapshot is still being built reached the daemon before it, and
		-- the snapshot, holding the state from before the change, undid it (a part moved into an
		-- excluded folder during a reconnect stayed in the sourcemap, 20/10/26). They wait, and
		-- sendFullSnapshot flushes them right after the snapshot
		if self._snapshotInProgress then return end
		local messages: { [number]: { type: string, data: any } } = {}

		for _, data in pairs(self.pendingInstanceUpdates) do
			table.insert(messages, {
				type = "instanceUpdated",
				data = data,
			})
		end

		for _, payload in pairs(self.pendingScriptChanges) do
			if self.pendingScriptChangeReady[payload.guid] == true then
				table.insert(messages, {
					type = "scriptChanged",
					data = scriptChangeData(payload),
				})
			end
		end

		for guid, shouldSend in pairs(self.pendingDeletes) do
			if shouldSend then
				table.insert(messages, {
					type = "deleted",
					data = {
						guid = guid,
					},
				})
			end
		end

		table.clear(self.pendingInstanceUpdates)
		table.clear(self.pendingDeletes)

		if #messages == 0 then return end

		-- Quack: what did not reach the daemon goes back in the queue for the next flush (a newer
		-- update for the same instance, queued meanwhile, wins). Script changes stay queued anyway:
		-- they only leave the queue in commitScriptChange.
		local function requeue(message)
			if message.type == "instanceUpdated" then
				if self.pendingInstanceUpdates[message.data.guid] == nil then
					self.pendingInstanceUpdates[message.data.guid] = message.data
				end
			elseif message.type == "deleted" then
				self.pendingDeletes[message.data.guid] = true
			end
		end

		local function sendOne(message)
			if sendMessage(message) then
				if message.type == "scriptChanged" then commitScriptChange(message.data) end
			elseif self.wsClient and self.wsClient.connected then
				-- Connected yet unsendable: it can never be encoded, so retrying would loop forever
				warn(`[Quack]: Dropped a {tostring(message.type)} that cannot be sent (see the warning above)`)
			else
				requeue(message)
			end
		end

		if self.batchingEnabled and #messages > 1 then
			-- Past 200 changes the plugin used to give up and re-send the whole place. With ~260k instances
			-- that froze Studio up to ~0.5 s and pushed the daemon to 1.3 GB for 2000 new or deleted
			-- parts (measured on the Anime Astral copy). The changes go in batches of 200 instead.
			local BATCH_SIZE = 200
			for first = 1, #messages, BATCH_SIZE do
				local chunk = table.move(messages, first, math.min(first + BATCH_SIZE - 1, #messages), 1, {})
				if sendMessage("batch", { messages = chunk }) then
					for _, message in chunk do
						if message.type == "scriptChanged" then commitScriptChange(message.data) end
					end
				elseif not (self.wsClient and self.wsClient.connected) then
					-- Disconnected: the snapshot of the next connection carries all of it
					for i = first, #messages do requeue(messages[i]) end
					break
				else
					-- Connected, so one message could not be encoded: send this chunk one by one,
					-- so a single bad message cannot hold back (or endlessly retry) the others
					for _, message in chunk do
						sendOne(message)
					end
				end
			end
		else
			for _, message in messages do
				sendOne(message)
			end
		end
	end

	local function scheduleBatchFlush()
		if not self.batchingEnabled then return end

		self.batchFlushToken += 1
		local token = self.batchFlushToken

		-- Quack: one pending flush at a time. Each change used to leave its own delayed task alive
		-- until it fired (2000 new parts = 2000 tasks); the previous one is cancelled instead.
		if self._batchFlushThread then
			pcall(task.cancel, self._batchFlushThread)
		end
		self._batchFlushThread = task.delay(safeGetNumber(self.config.BATCH_IDLE_WINDOW, 0.1), function()
			self._batchFlushThread = nil
			if token ~= self.batchFlushToken then return end
			flushOutboundQueues()
		end)
	end

	local function queueInstanceUpdate(data, isReply: boolean?)
		if (self.suppressOutbound and not isReply) or not self.syncEnabled then return end
		if not data or not data.guid then return end

		self.pendingInstanceUpdates[data.guid] = data
		-- Back after a delete still waiting to go out: the flush sends deletes last, so the
		-- delete would win over this newer update
		self.pendingDeletes[data.guid] = nil
		scheduleBatchFlush()
	end

	local function queueScriptChange(payload)
		if self.suppressOutbound or not self.syncEnabled then return end
		if not payload or not payload.guid then return end

		self.pendingScriptChangeReady[payload.guid] = false
		self.pendingScriptChanges[payload.guid] = payload

		local token = (self.scriptChangeDebounceTokenByGuid[payload.guid] or 0) + 1
		self.scriptChangeDebounceTokenByGuid[payload.guid] = token

		-- Quack: one pending debounce per script; fast typing used to leave one task per keystroke
		local previous = self.scriptChangeDebounceThreadByGuid[payload.guid]
		if previous then pcall(task.cancel, previous) end
		self.scriptChangeDebounceThreadByGuid[payload.guid] = task.delay(safeGetNumber(self.config.SCRIPT_CHANGE_DEBOUNCE, 0.35), function()
			self.scriptChangeDebounceThreadByGuid[payload.guid] = nil
			if not self.syncEnabled or self.suppressOutbound then return end
			if self.scriptChangeDebounceTokenByGuid[payload.guid] ~= token then return end
			if not self.pendingScriptChanges[payload.guid] then return end

			self.pendingScriptChangeReady[payload.guid] = true
			scheduleBatchFlush()
		end)
	end

	local function queueDeletion(guid: string)
		if self.suppressOutbound or not self.syncEnabled then return end
		if not guid or guid == "" then return end

		self.pendingDeletes[guid] = true
		-- An update queued before this delete is stale now
		self.pendingInstanceUpdates[guid] = nil
		scheduleBatchFlush()
	end

	local outboundSupressDepth = 0
	--- Function to set the outbound suppression state. This is used to prevent sending outbound messages during certain operations.
	local function setOutboundSuppressed(suppressed: boolean)
		self.suppressOutbound = suppressed
		if suppressed then
			outboundSupressDepth += 1
		else
			outboundSupressDepth = math.max(0, outboundSupressDepth - 1)
		end
		self.suppressOutbound = outboundSupressDepth > 0
	end

	--- isReply: the daemon asked for this instance (a create or move from disk) and maps its file
	--- only from this update. It goes out even while another operation holds outbound off: a
	--- create that landed during a play swap was made in Studio and never mapped (Astral, 27/10/26)
	local function sendInstanceUpdateDedup(instance, isReply: boolean?)
		if (self.suppressOutbound and not isReply) or not self.syncEnabled then return end

		local data = QuackService.instanceToDataDedup(
			instance,
			self.trackedInstances,
			self.guidMap,
			self.usedGuids,
			self.lastInstanceUpdate
		)
		if not data then return end

		local guid = data.guid
		self.trackedInstances[instance] = guid
		self.guidMap[guid] = instance

		queueInstanceUpdate(data, isReply)
	end

	local function shouldSync(instance)
		if not instance then return false end
		if not QuackService.isScript(instance) then return false end
		return not QuackService.isExcluded(instance, self.serviceSet)
	end

	local function onScriptChanged(changedScript: Script | LocalScript | ModuleScript)
		if self.suppressOutbound or not shouldSync(changedScript) then return end

		local guid = QuackService.getOrCreateGUID(changedScript, self.trackedInstances, self.guidMap, self.usedGuids)
		local source = ScriptEditorService:GetEditorSource(changedScript)

		-- Quack: text equal to what Studio and the daemon last agreed on is an echo (a patch landing)
		-- or no change at all. Anything else is a real Studio edit and goes to disk, even right after
		-- a patch (it used to drop every Studio change for 0.2 s after any patch, and the patched
		-- script's for 1 s).
		if self.lastSyncedSource[guid] == source then
			self:debugPrint("Ignoring change (already synced):", `{changedScript.Parent}.{changedScript.Name}`)
			return
		end

		local path = QuackService.getInstancePath(changedScript)
		if not path then return end

		queueScriptChange({
			guid = guid,
			path = path,
			className = changedScript.ClassName,
			source = source,
		})
	end

	--- After a resume: the scripts sent in the last seconds before the drop go again, against the
	--- text agreed before that send, so a lost one lands and one that arrived is a no-op merge
	local RESEND_WINDOW = 3
	local function resendRecentScripts(droppedAt: number)
		for guid, sent in pairs(self._recentScriptSends) do
			-- Edited again while offline: that queued change goes out against the text last sent,
			-- and rewinding its base would turn a revert into "no change"
			if self.pendingScriptChanges[guid] then continue end
			if sent.at >= droppedAt - RESEND_WINDOW and sent.at <= droppedAt then
				local instance = self.guidMap[guid]
				if instance and QuackService.isScript(instance) then
					self.lastSyncedSource[guid] = sent.base
					onScriptChanged(instance :: Script)
				end
			end
		end
		table.clear(self._recentScriptSends)
	end

	local function wipeChildren(container: Instance)
		for _, child in ipairs(container:GetChildren()) do
			if QuackService.isProtectedRobloxContainer(child) then continue end
			local ok, err = pcall(function() child:Destroy() end)
			if not ok then warn(`[Quack]: Cannot destroy '{child.Name}': {err}`) end
		end
	end

	local function wipeBuildRoots(instances: { any })
		local rootsSeen = {}

		for _, item in ipairs(instances) do
			local path = item.path
			if type(path) == "table" and #path >= 1 then
				local rootName = path[1]
				if type(rootName) == "string" and rootName ~= "" then rootsSeen[rootName] = true end
			end
		end

		for rootName in pairs(rootsSeen) do
			local rootInstance: Instance? = nil

			local okService, service = pcall(function() return game:GetService(rootName) end)
			if okService and service then
				rootInstance = service
			else
				rootInstance = game:FindFirstChild(rootName)
			end

			if rootInstance then
				local ok, err = pcall(function() wipeChildren(rootInstance) end)
				if not ok then warn(`[Quack]: Failed to wipe children for root container '{rootName}': {err}`) end
			else
				warn(`[Quack]: Destructive build could not find root container '{rootName}', skipping wipe`)
			end
		end
	end

	local function sendDaemonConfig(warnOnFail: boolean?)
		local configPayload, err = QuackService.readPushConfig(PUSH_CONFIG_PATH)
		if not configPayload then
			local legacyPayload = QuackService.readPushConfig(LEGACY_PUSH_CONFIG_PATH)
			if legacyPayload then configPayload, err = legacyPayload, nil end
		end
		if not configPayload then
			if warnOnFail then
				warn(`[Quack]: daemon config unavailable: {err}`)
			else
				self:debugPrint(`daemon config unavailable: {err}`)
			end
			return false
		end

		return sendMessage("pushConfig", {
			config = configPayload,
		})
	end

	local function onInstanceRemoved(instance)
		if self.suppressOutbound then return end
		if not self.trackedInstances[instance] then return end

		local guid = self.trackedInstances[instance]
		if not guid then guid = instance:GetDebugId(0) end
		if not guid then return end

		self.trackedInstances[instance] = nil
		self.guidMap[guid] = nil
		self.usedGuids[guid] = nil
		-- Moved out and straight back within the 50 ms dedup window: the update that brings it
		-- back has the same path as the one before the delete and was dropped as a duplicate
		self.lastInstanceUpdate[guid] = nil

		queueDeletion(guid)
	end

	-- Defined below with the added queue it feeds; attachListeners' Parent listener calls it
	local reAddSubtree: (instance: Instance) -> ()

	--[=[
		The descendants of an instance that just left the synced area (moved into an excluded
		folder): the daemon drops them with it, so nothing queued for them may go out after the
		delete (a folder toggled in and out during a reconnect left a script file on disk under
		an excluded parent, 21/10/26), and they stop being tracked, so one moved back out later
		is sent whole by reAddSubtree.
	]=]
	local function forgetDescendants(instance: Instance)
		for _, item in instance:GetDescendants() do
			local guid = self.trackedInstances[item]
			if not guid then continue end
			self.trackedInstances[item] = nil
			self.guidMap[guid] = nil
			self.usedGuids[guid] = nil
			self.lastInstanceUpdate[guid] = nil
			self.pendingInstanceUpdates[guid] = nil
			self.pendingScriptChanges[guid] = nil
			self.pendingScriptChangeReady[guid] = nil
		end
	end

	--[=[
		Leaving and coming back are decided here, not from trackedInstances: building any child's
		data caches its parent's guid there as a side effect, so "tracked" does not mean "the
		daemon has it". With a folder moved in and out every frame the plugin took it for sent,
		skipped the re-add, and it ended in Studio but not on disk (21/10/26).
		leaveCount: how many times an instance left, read by the added queue to drop descendants
		queued before one of their ancestors left again (weak keys: never holds an instance).
	]=]
	local leftSyncedArea: { [Instance]: boolean } = setmetatable({} :: any, { __mode = "k" })
	local leaveCount: { [Instance]: number } = setmetatable({} :: any, { __mode = "k" })

	--- Moved into an excluded folder: the daemon deletes it with its subtree
	local function leaveSyncedArea(instance: Instance)
		if leftSyncedArea[instance] then return end
		leftSyncedArea[instance] = true
		leaveCount[instance] = (leaveCount[instance] or 0) + 1
		forgetDescendants(instance)
		local guid = self.trackedInstances[instance] or instance:GetDebugId(0)
		self.trackedInstances[instance] = nil
		self.guidMap[guid] = nil
		self.usedGuids[guid] = nil
		self.lastInstanceUpdate[guid] = nil
		self.pendingScriptChanges[guid] = nil
		self.pendingScriptChangeReady[guid] = nil
		queueDeletion(guid)
	end

	--[=[
		Every Parent change of an instance still in the DataModel, from its own listener or, for
		one without a listener yet, from DataModel.ItemChanged (after a reconnect listeners are
		attached only to what is in the synced area when the walk reaches it). The daemon holds
		only tracked instances (a superset: a tracked one may not have been sent), so leaving is
		sent for a tracked one; coming back after leaving, or untracked, re-adds the subtree.
	]=]
	local function onParentChanged(instance: Instance)
		if instance.Parent == nil then return end
		if not shouldIncludeInSnapshot(instance) then
			if self.trackedInstances[instance] then leaveSyncedArea(instance) end
			return
		end
		if leftSyncedArea[instance] or not self.trackedInstances[instance] then
			leftSyncedArea[instance] = nil
			reAddSubtree(instance)
			return
		end
		sendInstanceUpdateDedup(instance)
	end

	local function attachListeners(instance)
		if not shouldIncludeInSnapshot(instance) then return end
		if self.listenerAttachedInstances[instance] then return end
		self.listenerAttachedInstances[instance] = true

		local nameConnnection = instance:GetPropertyChangedSignal("Name"):Connect(function()
			if not shouldIncludeInSnapshot(instance) then return end
			sendInstanceUpdateDedup(instance)
		end)
		table.insert(self.connections, nameConnnection)

		local parentConnection = instance:GetPropertyChangedSignal("Parent"):Connect(function()
			onParentChanged(instance)
		end)
		table.insert(self.connections, parentConnection)

		if QuackService.isScript(instance) then
			local sourceConnection = (instance :: Script):GetPropertyChangedSignal("Source"):Connect(function()
				if not self.syncEnabled or not shouldIncludeInSnapshot(instance) then return end
				onScriptChanged(instance :: Script)
			end)
			table.insert(self.connections, sourceConnection)
		end
	end

	-- Quack: new instances are processed over several frames, at most ~4 ms per frame. Pasting
	-- 2000 parts did all the serializing and listener wiring in one frame: +72 ms on Studio's own
	-- 50 ms hitch (Anime Astral copy). Whether to ignore an instance (one the daemon itself is
	-- creating) is decided when it appears, not later: a later check could land in an unrelated
	-- 0.5 s suppression window and drop a real addition.
	local ADDED_BUDGET_SECONDS = 0.004
	-- Explicit head and tail: consumed slots are set to nil, and # on a table with holes is unreliable
	local addedQueue: { [number]: Instance } = {}
	local addedHead = 1
	local addedTail = 0
	local addedWorkerRunning = false

	--- Queues an instance that appeared or came back; false when it is not in the synced area now
	local function processAddedInstance(instance: Instance): boolean
		if not self.syncEnabled then return false end
		if instance.Parent == nil or not instance:IsDescendantOf(game) then return false end
		if not shouldIncludeInSnapshot(instance) then return false end
		leftSyncedArea[instance] = nil

		local data = QuackService.instanceToDataDedup(
			instance,
			self.trackedInstances,
			self.guidMap,
			self.usedGuids,
			self.lastInstanceUpdate
		)
		if data then
			self.trackedInstances[instance] = data.guid
			self.guidMap[data.guid] = instance
			self.pendingInstanceUpdates[data.guid] = data
			-- Back after a delete still waiting to go out, which the flush would send after this
			self.pendingDeletes[data.guid] = nil
			scheduleBatchFlush()
		end
		attachListeners(instance)
		return true
	end

	-- Instances waiting in addedQueue: DescendantAdded and reAddSubtree can both queue the same one
	local queuedForAdd: { [Instance]: boolean } = {}
	-- Roots queued by reAddSubtree: their descendants are queued when the root is processed and
	-- found in the synced area, never before. Queued all at once, a child could go out in a frame
	-- where the root was back while the root itself had been skipped in an earlier frame (moved
	-- out then), and the daemon got the child without its parent (21/10/26)
	local expandWhenAdded: { [Instance]: boolean } = {}
	-- For a descendant queued by a re-add: its root, and how many times its ancestors up to that
	-- root had left then. A different count when its turn comes means one of them left (and its
	-- own return, if any, queues it again), so it is not sent without its parent
	local expandedFrom: { [Instance]: { root: Instance, leaves: number } } = setmetatable({} :: any, { __mode = "k" })
	local function ancestorLeaves(item: Instance, root: Instance): number
		local total = 0
		local ancestor = item.Parent
		while ancestor do
			total += leaveCount[ancestor] or 0
			if ancestor == root then return total end
			ancestor = ancestor.Parent
		end
		return -1 -- no longer under that root
	end

	-- Defined after the drain, which queues the descendants of a re-added root through it
	local onInstanceAdded: (instance: Instance) -> ()

	local function drainAddedQueue()
		while addedHead <= addedTail do
			local sliceStart = os.clock()
			while addedHead <= addedTail and os.clock() - sliceStart < ADDED_BUDGET_SECONDS do
				local instance = addedQueue[addedHead]
				addedQueue[addedHead] = nil
				addedHead += 1
				queuedForAdd[instance] = nil
				local expand = expandWhenAdded[instance]
				expandWhenAdded[instance] = nil
				local origin = expandedFrom[instance]
				expandedFrom[instance] = nil
				local stale = origin ~= nil and ancestorLeaves(instance, origin.root) ~= origin.leaves
				if not stale and processAddedInstance(instance) and expand then
					-- Leave counts summed down from the root, one step per descendant: GetDescendants
					-- lists every parent before its children, so a deep subtree is not walked up
					-- once per descendant in this one frame
					local leavesAbove: { [Instance]: number } = { [instance] = leaveCount[instance] or 0 }
					for _, descendant in instance:GetDescendants() do
						local parent = descendant.Parent :: Instance
						local above = leavesAbove[parent] or 0
						leavesAbove[descendant] = above + (leaveCount[descendant] or 0)
						-- Sent before the root left: the dedup window must not drop it now
						self.lastInstanceUpdate[descendant:GetDebugId(0)] = nil
						expandedFrom[descendant] = { root = instance, leaves = above }
						onInstanceAdded(descendant)
					end
				end
			end
			if addedHead <= addedTail then task.wait() end
		end
		addedQueue = {}
		addedHead = 1
		addedTail = 0
		addedWorkerRunning = false
	end

	function onInstanceAdded(instance: Instance)
		if self.suppressOutbound then return end
		if queuedForAdd[instance] then return end
		queuedForAdd[instance] = true
		addedTail += 1
		addedQueue[addedTail] = instance
		if not addedWorkerRunning then
			addedWorkerRunning = true
			task.defer(drainAddedQueue)
		end
	end

	--[=[
		An instance that moved into the synced area without being tracked: out of an excluded
		folder, or back after a move out removed it. Only its root reports the move (no
		DescendantAdded inside the DataModel), and the daemon dropped or never had its
		descendants, so the whole subtree goes through the added queue: the root first, and its
		descendants once the root is sent.
	]=]
	function reAddSubtree(instance: Instance)
		self.lastInstanceUpdate[instance:GetDebugId(0)] = nil
		-- Re-added in its own right: an entry already queued as part of another root's subtree
		-- must not be dropped as stale because it no longer sits under that root
		expandedFrom[instance] = nil
		expandWhenAdded[instance] = true
		onInstanceAdded(instance)
	end

	local function sendFullSnapshot(
		options: { includeProperties: boolean, scriptsAndDescendantsOnly: boolean, omitPaths: boolean? }?
	)
		self:infoPrint("Sending full snapshot...")

		local includeProperties = options and options.includeProperties == true
		local scriptsAndDescendantsOnly = options and options.scriptsAndDescendantsOnly == true
		-- A daemon that rebuilds each path from the parent's asks for none: 25 of the 64 MB a
		-- 261k-instance place sent (measured 20/10/26). Older daemons do not ask and get them
		local omitPaths = options and options.omitPaths == true
		local includeAncestorsOfScripts: { [Instance]: boolean } = {}

		if scriptsAndDescendantsOnly then
			for _, descendant in ipairs(game:GetDescendants()) do
				if QuackService.isScript(descendant) and shouldIncludeInSnapshot(descendant) then
					local current: Instance? = descendant
					while current and current ~= game do
						if shouldIncludeInSnapshot(current) then includeAncestorsOfScripts[current] = true end
						current = current.Parent
					end
				end
			end
		end

		self.trackedInstances = {}
		self.guidMap = {}
		self.usedGuids = {}
		self._snapshotInProgress = true
		table.clear(leftSyncedArea)

		local instances = {}
		local scriptCount = 0

		-- Each queued instance is already known to be included, so its children are checked
		-- against it alone (isChildExcluded) and their full name and path are built from its own.
		-- That holds only while nothing is renamed or moved: ItemChanged reports a Name or Parent
		-- change anywhere in the place (checked in Studio: a rename mid-tree and a deep move), and
		-- from the first one on every instance is checked again the slow way, ancestors included
		local structureChanged = false
		local itemChangedConnection = game.ItemChanged:Connect(function(_, property)
			if property == "Name" or property == "Parent" then structureChanged = true end
		end)
		local queue = {}
		for _, service in ipairs(game:GetChildren()) do
			if shouldIncludeInSnapshot(service) then
				table.insert(queue, {
					instance = service,
					hasScriptAncestor = false,
					fullName = service:GetFullName(),
					path = { service.Name },
				})
			end
		end

		-- Work in slices of SLICE_SECONDS and yield one frame between them. A yield every 400
		-- instances made 654 of them in a 261k-instance place, ~4.6 s of the 10.6 s it took
		local SLICE_SECONDS = 0.02
		local sliceStart = os.clock()
		local function yieldIfSliceDone()
			if os.clock() - sliceStart >= SLICE_SECONDS then
				task.wait()
				sliceStart = os.clock()
			end
		end
		local index = 1
		while index <= #queue do
			if not self.syncEnabled then
				itemChangedConnection:Disconnect()
				self._snapshotInProgress = false
				self:infoPrint("Snapshot aborted - sync disabled")
				return
			end

			local queued = queue[index]
			local instance = queued.instance
			index += 1

			-- Something was renamed or moved while the walk yielded: what was worked out from the
			-- parent may no longer hold, so the instance is checked again the slow way. One now
			-- under an excluded parent, or out of the DataModel, is not sent, and neither are its
			-- descendants; its path, full name and script ancestry are read again
			if structureChanged then
				if not instance:IsDescendantOf(game) or not shouldIncludeInSnapshot(instance) then
					yieldIfSliceDone()
					continue
				end
				queued.fullName = instance:GetFullName()
				queued.path = QuackService.getInstancePath(instance) or queued.path
				local scriptAbove = false
				local ancestor = instance.Parent
				while ancestor and ancestor ~= game do
					if QuackService.isScript(ancestor) then
						scriptAbove = true
						break
					end
					ancestor = ancestor.Parent
				end
				queued.hasScriptAncestor = scriptAbove
			end

			local hasScriptAncestor = queued.hasScriptAncestor == true
			local isScript = QuackService.isScript(instance)

			local includeByMode = true
			if scriptsAndDescendantsOnly then
				includeByMode = isScript or hasScriptAncestor or includeAncestorsOfScripts[instance] == true
			end

			if includeByMode then
				local data = QuackService.instanceToData(instance, self.trackedInstances, self.guidMap, self.usedGuids, {
					includeProperties = includeProperties,
					path = queued.path,
				})
				if data then
					if omitPaths then data.path = nil end
					table.insert(instances, data)

					self.trackedInstances[instance] = data.guid
					self.guidMap[data.guid] = instance

					if isScript then
						scriptCount += 1
					end
				end
			end

			for _, child in ipairs(instance:GetChildren()) do
				local childFullName = queued.fullName .. "." .. child.Name
				if not QuackService.isChildExcluded(child, childFullName, instance) then
					local childPath = table.clone(queued.path)
					table.insert(childPath, child.Name)
					table.insert(queue, {
						instance = child,
						hasScriptAncestor = hasScriptAncestor or isScript,
						fullName = childFullName,
						path = childPath,
					})
				end
				-- Also between children: one folder with tens of thousands of them would otherwise
				-- hold Studio for the whole list
				yieldIfSliceDone()
			end

			yieldIfSliceDone()
		end
		itemChangedConnection:Disconnect()

		local sent = sendMessage("fullSnapshot", { data = instances, placeId = game.PlaceId })
		if not sent then
			-- Full snapshot encoding failed; find and exclude the problematic instance(s)
			self:infoPrint("Full snapshot encoding failed! Scanning for non-encodable instances...")
			local filteredInstances = {}
			for _, instanceData in ipairs(instances) do
				if pcall(HttpService.JSONEncode, HttpService, instanceData) then
					table.insert(filteredInstances, instanceData)
				else
					warn(
						`[Quack]: Instance "{instanceData.name}" ({instanceData.className}) at {table.concat(
							instanceData.path or {},
							"."
						)} cannot be JSON-encoded and will be excluded from this sync session. This is usually caused by null bytes or non-UTF-8 characters in the instance name or script source.`
					)
				end
			end
			instances = filteredInstances
			if #filteredInstances > 0 then
				if not sendMessage("fullSnapshot", { data = filteredInstances, placeId = game.PlaceId }) then
					warn("[Quack]: The filtered snapshot could not be sent either, sync cannot proceed for this session.")
					self._snapshotInProgress = false
					return
				end
			else
				warn("[Quack]: No instances could be encoded, sync cannot proceed for this session.")
				self._snapshotInProgress = false
				return
			end
		end
		-- Quack: every script starts out agreed with the daemon at the text it actually received
		for _, instanceData in ipairs(instances) do
			if instanceData.guid and type(instanceData.source) == "string" then
				self.lastSyncedSource[instanceData.guid] = instanceData.source
			end
		end

		self:infoPrint("Snapshot sent:", #instances, "instances (", scriptCount, "scripts )")
		-- What changed while it was built goes now, after it
		self._snapshotInProgress = false
		flushOutboundQueues()

		if self.syncEnabled then
			if includeProperties or scriptsAndDescendantsOnly then
				self:debugPrint(
					`Snapshot sent with options (includeProperties={tostring(includeProperties)}, scriptsAndDescendantsOnly={tostring(
						scriptsAndDescendantsOnly
					)}) - stopping sync since "pack" is one-shot.`
				)
				self:stopSync()
			end

			self.batchingEnabled = true
			self.batchFlushToken += 1
			self.batchAccumulator = 0
		end
	end

	--[=[
		The handshake is considered complete once we receive any message from the daemon, even if it's not an explicit handshakeAck. 
		This is to handle the case where the daemon might send a message before it receives our handshakeStudio message, 
		which would indicate that the daemon is alive and has received our handshake attempt.
		]=]
	local function implicitHandshake()
		if not self.handshakeComplete then
			self.handshakeComplete = true
			-- Back from a drop on a daemon without this session's tree: the snapshot covers it all
			self._offline = false
			self._offlineSince = nil
			-- Connected either way: a setup request is done (the daemon often asks for the snapshot first)
			self._setupRequested = false
			self:debugPrint("Handshake implicitly satisfied by daemon message")
			self.settingsStore:markPlaceSynced()
			if self.ui then self.ui:UpdateHandshakeState(true) end
			if self._handshakeBindable then pcall(function() self._handshakeBindable:Fire() end) end
		end
	end

	-- Roblox can't change an instance's ClassName in place. Recreates
	-- `existing` as newClassName, migrating its children and reusing its
	-- tracking GUID, instead of a plain create (duplicate) or reparent
	-- (which would silently keep the old class).
	local function migrateInstanceChildren(
		existing: Instance,
		newClassName: string,
		name: string,
		parent: Instance
	): (Instance?, string?)
		local okNew, newInst = pcall(function() return Instance.new(newClassName) end)
		local instance: Instance = if okNew and newInst then newInst else Instance.new("Folder")
		instance.Name = name
		instance.Parent = parent

		local migratedChildren: { Instance } = {}
		local migrationFailed = false
		for _, child in existing:GetChildren() do
			local movedOk = pcall(function() child.Parent = instance end)
			if movedOk then
				table.insert(migratedChildren, child)
			else
				migrationFailed = true
				break
			end
		end

		if migrationFailed then
			-- Roll back already-migrated children so `existing` is left exactly
			-- as it was, then abort instead of destroying children that failed
			-- to move or reporting a false success.
			local stranded = 0
			for _, child in migratedChildren do
				local backOk = pcall(function() child.Parent = existing end)
				if not backOk then stranded += 1 end
			end
			-- Quack: destroying the replacement would destroy any child that could not move back
			if stranded == 0 then
				pcall(function() instance:Destroy() end)
			else
				warn(`[Quack]: {stranded} child(ren) of '{name}' could not be moved back; kept under {instance:GetFullName()}`)
			end
			return nil, `Failed to migrate children converting '{name}' to {newClassName}; aborting`
		end

		local oldGuid = self.trackedInstances[existing]
		self.trackedInstances[existing] = nil
		pcall(function() existing:Destroy() end)
		if oldGuid then
			self.trackedInstances[instance] = oldGuid
			self.guidMap[oldGuid] = instance
			self.usedGuids[oldGuid] = true
		end

		return instance, nil
	end

	local function queueStudioText(guid: string, instance: Instance, source: string)
		if self.pendingScriptChanges[guid] then return end
		local path = QuackService.getInstancePath(instance)
		if path then
			queueScriptChange({
				guid = guid,
				path = path,
				className = instance.ClassName,
				source = source,
			})
		end
	end

	local function applyScriptPatch(message)
		local instance = self.guidMap[message.guid]
		if instance and QuackService.isScript(instance) then
			-- Quack: never overwrite a Studio edit the daemon has not seen. If Studio holds text
			-- other than the last agreed one (an edit still queued, or typing in an open tab),
			-- refuse the patch. The edit goes out when the typing pauses (the usual debounce),
			-- and the daemon merges once. Sending it at once merged on every keystroke: 20
			-- merges in 2.3 s of typing in the Anime Astral copy (each would be an AI call if
			-- the text merge failed its check).
			local current = ScriptEditorService:GetEditorSource(instance)
			local synced = self.lastSyncedSource[message.guid]
			local hasUnsentEdit = self.pendingScriptChanges[message.guid] ~= nil
				or (synced ~= nil and current ~= synced)
			if hasUnsentEdit and current ~= message.source then
				self:debugPrint("Studio has an unsent edit; it goes for a merge when typing pauses:", `{instance.Parent}.{instance.Name}`)
				queueStudioText(message.guid, instance, current)
				return
			end

			-- Set before applying: .Source fires the change signal synchronously
			self.lastSyncedSource[message.guid] = message.source
			local _, changedUnderneath =
				QuackService.setScriptSource(instance :: Script, message.source, { expected = current })
			if changedUnderneath then
				-- Typed into while the write yielded (UpdateSourceAsync, ~258 ms in Team Create):
				-- nothing was written, and that text goes for a merge against the old agreed one
				self.lastSyncedSource[message.guid] = synced
				self:debugPrint("Typed into while patching; it goes for a merge:", `{instance.Parent}.{instance.Name}`)
				queueStudioText(message.guid, instance, ScriptEditorService:GetEditorSource(instance))
				return
			end

			self:infoPrint("Updated script:", `{instance.Parent}.{instance.Name}`)
		else
			warn("[Quack]: Cannot apply patch - instance not found for GUID:", message.guid)
			local count = 0
			for _ in pairs(self.guidMap) do
				count += 1
			end
			warn("[Quack]: Total tracked instances:", count)
		end
	end

	-- Quack: patches of one script apply one at a time, in arrival order. Each message runs in its
	-- own thread, and a write that yields (an open tab, or Team Create, where every write is an
	-- UpdateSourceAsync) let the next patch read the editor before the first landed and send that
	-- old text back as a Studio edit. Patches of different scripts still run side by side.
	local scriptPatchQueues: { [string]: { thread } } = {}
	local function withScriptPatchLock(guid: string, apply: () -> ...any)
		local queue = scriptPatchQueues[guid]
		if queue then
			table.insert(queue, coroutine.running())
			coroutine.yield()
		else
			scriptPatchQueues[guid] = {}
		end

		local ok, err = pcall(apply)

		local waiting = scriptPatchQueues[guid]
		local nextThread = table.remove(waiting, 1)
		if nextThread then
			task.spawn(nextThread)
		else
			scriptPatchQueues[guid] = nil
		end
		if not ok then error(err, 0) end
	end

	local function processMessage(message)
		self:debugPrint("Processing message type:", message.type)

		if message.type == "patchScript" then
			self:debugPrint("Patch requested for GUID:", message.guid)
			withScriptPatchLock(message.guid, function() applyScriptPatch(message) end)
		elseif message.type == "createInstance" then
			self:debugPrint("Create instance requested from filesystem:", message.name, message.className)
			setOutboundSuppressed(true)

			local ok, err = pcall(function(): Instance?
				local parent = QuackService.getOrCreatePath(message.parentPath or {})
				local existing = parent:FindFirstChild(message.name)
				local instance: Instance

				if existing and existing.ClassName == message.className then
					instance = existing
				elseif existing and existing.ClassName == "Folder" and QuackService.isScriptClass(message.className) then
					-- Nested-scripts convention: a script file created alongside a same-named
					-- folder means that folder IS the script's children container. Migrate
					-- into the new class, reusing the folder's tracking GUID.
					local migrated, migrateErr =
						migrateInstanceChildren(existing, message.className, message.name, parent)
					if not migrated then
						warn(`[Quack]: {migrateErr}`)
						return nil
					end
					instance = migrated
				else
					local okNew, newInst = pcall(function() return Instance.new(message.className) end)
					if okNew and newInst then
						instance = newInst
					else
						instance = Instance.new("Folder")
					end
					instance.Name = message.name
					instance.Parent = parent
				end

				if QuackService.isScriptClass(message.className) and message.source ~= nil then
					if QuackService.isScript(instance) then
						-- Quack: a script born from disk starts agreed at its file's text
						local createdGuid = QuackService.getOrCreateGUID(
							instance,
							self.trackedInstances,
							self.guidMap,
							self.usedGuids
						)
						self.lastSyncedSource[createdGuid] = message.source
						-- A script made in this call (not one already there) has no tab anywhere yet
						QuackService.setScriptSource(instance :: Script, message.source, { fresh = instance ~= existing })
					end
				end

				attachListeners(instance)
				return instance
			end)

			setOutboundSuppressed(false)

			if ok and err then
				local createdInst = err :: Instance
				sendInstanceUpdateDedup(createdInst, true)
				self:infoPrint(`Created instance from filesystem: {createdInst.Name} ({createdInst.ClassName})`)
			elseif not ok then
				warn("[Quack]: Failed to create instance from filesystem:", err)
			end
		elseif message.type == "deleteInstance" then
			self:debugPrint("Delete instance requested from filesystem")
			setOutboundSuppressed(true)

			local targetInst: Instance? = nil

			if type(message.guid) == "string" and message.guid ~= "" then targetInst = self.guidMap[message.guid] end

			if not targetInst and type(message.path) == "table" and #message.path > 0 then
				local current: Instance = game
				local resolvedFully = true
				for index, segment in ipairs(message.path) do
					if type(segment) ~= "string" then
						resolvedFully = false
						break
					end
					local nextNode: Instance? = nil
					if index == 1 then
						local okService, service = pcall(function() return game:GetService(segment) end)
						if okService and service then nextNode = service end
					end
					if not nextNode then nextNode = current:FindFirstChild(segment) end
					if not nextNode then
						resolvedFully = false
						break
					end
					current = nextNode
				end
				-- Only delete when the ENTIRE path resolves to the intended leaf.
				-- If the leaf is gone (e.g. a rename produced a stale delete-by-path),
				-- we must NOT fall back to destroying the nearest ancestor folder.
				if resolvedFully and current ~= game then targetInst = current end
			end

			if targetInst and not QuackService.isProtectedRobloxContainer(targetInst) then
				local name = targetInst.Name

				-- Clear tracking state for the whole subtree before destroying it.
				-- Outbound suppression is active here, so onInstanceRemoved (which
				-- normally does this cleanup) won't run for any descendant, leaving
				-- ghost entries pointing at now-destroyed instances otherwise.
				local function clearTracking(inst: Instance)
					local instGuid = self.trackedInstances[inst]
					if instGuid then
						self.trackedInstances[inst] = nil
						self.guidMap[instGuid] = nil
						self.usedGuids[instGuid] = nil
					end
					self.listenerAttachedInstances[inst] = nil
				end
				clearTracking(targetInst)
				for _, descendant in ipairs(targetInst:GetDescendants()) do
					clearTracking(descendant)
				end

				pcall(function() targetInst:Destroy() end)
				self:infoPrint(`Deleted instance from filesystem: {name}`)
			elseif targetInst then -- The target instance is protected
				warn("[Quack]: Refused to delete protected container:", targetInst:GetFullName())
			else
				warn("[Quack]: Delete requested from filesystem but the target was not found")
			end

			setOutboundSuppressed(false)
		elseif message.type == "moveInstance" then
			self:debugPrint("Move instance requested from filesystem:", message.guid, message.name)
			setOutboundSuppressed(true)

			local ok, instanceResult = pcall(function(): Instance?
				local instance = self.guidMap[message.guid]
				if not instance then return nil end
				if QuackService.isProtectedRobloxContainer(instance) then return nil end

				local parent = QuackService.getOrCreatePath(message.parentPath or {})
				local targetName = if type(message.name) == "string" and message.name ~= ""
					then message.name
					else instance.Name

				if
					type(message.className) == "string"
					and message.className ~= ""
					and message.className ~= instance.ClassName
				then
					-- The filesystem rename implies a class change. Recreate as the new
					-- class (reusing the GUID) instead of a plain reparent, which can't
					-- change ClassName and would silently keep the old one.
					local migrated, migrateErr =
						migrateInstanceChildren(instance, message.className, targetName, parent)
					if not migrated then
						warn(`[Quack]: {migrateErr}`)
						return nil
					end
					instance = migrated
					if QuackService.isScript(instance) and message.source ~= nil then
						self.lastSyncedSource[message.guid] = message.source
						QuackService.setScriptSource(instance :: Script, message.source, { fresh = true })
					end
					attachListeners(instance)
					return instance
				end

				-- Reparent/rename the existing instance so its whole subtree
				-- (scripts AND non-script instances) moves with it, keeping GUIDs.
				instance.Parent = parent
				instance.Name = targetName
				return instance
			end)

			setOutboundSuppressed(false)

			if ok and instanceResult then
				local movedInst = instanceResult :: Instance
				sendInstanceUpdateDedup(movedInst, true)
				self:infoPrint(`Moved instance from filesystem: {movedInst.Name}`)
			elseif ok and not instanceResult then
				warn("[Quack]: Move requested from filesystem but no tracked instance matched GUID:", message.guid)
			elseif not ok then
				warn("[Quack]: Failed to move instance from filesystem:", instanceResult)
			end
		elseif message.type == "playOverlay" then
			-- Quack: `quackdev play`. Yields while Studio copies the place, so off the message loop
			task.spawn(function()
				self:infoPrint("Starting a play with a worktree's scripts")
				setOutboundSuppressed(true)
				local ok, result = pcall(PlayOverlay.run, message, self.guidMap)
				setOutboundSuppressed(false)
				if not ok then result = { ok = false, error = tostring(result) } end
				-- An edit made in Studio while the swap held (outbound was off) still goes out
				for _, instance in pairs(self.guidMap) do
					if QuackService.isScript(instance) then onScriptChanged(instance :: Script) end
				end
				local reply: { [string]: any } = { type = "playOverlayResult", id = message.id }
				for key, value in pairs(result) do
					reply[key] = value
				end
				sendMessage(reply :: any)
				if result.ok then
					self:infoPrint(`Play started; the place held the worktree's scripts {math.round(result.windowMs or 0)} ms`)
				else
					warn("[Quack]: Play of a worktree failed:", result.error)
					self:notify(`Play failed: {result.error}`, 10)
				end
			end)
		elseif message.type == "requestSnapshot" then
			implicitHandshake()
			self:infoPrint("Snapshot requested by daemon")
			sendFullSnapshot(message.options)
		elseif message.type == "buildSnapshot" then
			implicitHandshake()
			self:infoPrint("Applying build snapshot from daemon")
			setOutboundSuppressed(true)

			local ok, err = pcall(function()
				if message.destructive == true then wipeBuildRoots(message.data or {}) end

				local created, updated, appliedGuidMap = QuackService.applySnapshotInstances(message.data)
				for guid, instance in pairs(appliedGuidMap) do
					self.guidMap[guid] = instance
					self.trackedInstances[instance] = guid
					attachListeners(instance)
				end
				self:infoPrint(`Build snapshot applied ({created} created, {updated} updated)`)
				self:notify(`Build applied ({created} created, {updated} updated)`)
			end)

			setOutboundSuppressed(false)
			if not ok then
				warn("[Quack]: Error applying build snapshot: ", err)
				self:notify("Failed to apply build snapshot. Check the Output for details.", 10)
			end

			local snapshotClient = self.wsClient
			task.delay(0.5, function()
				if self.wsClient == snapshotClient then self:stopSync() end
			end)
		elseif message.type == "pushSnapshot" then
			implicitHandshake()
			self:infoPrint("Applying push snapshot from daemon")
			setOutboundSuppressed(true)

			local ok, err = pcall(function()
				for _, mapping in ipairs(message.mappings or {}) do
					local destination = mapping.destination or {}
					if #destination == 0 then
						warn("[Quack]: Push mapping missing destination; skipping")
						continue
					end

					self:debugPrint(
						`Destination for push snapshot: {table.concat(destination, "/")}, destructive: {tostring(
							mapping.destructive
						)}`
					)

					local targetContainer = QuackService.getOrCreatePath(destination)
					if mapping.destructive then wipeChildren(targetContainer) end

					local created, updated, appliedGuidMap =
						QuackService.applySnapshotInstances(mapping.instances or {}, mapping.destination)
					for guid, instance in pairs(appliedGuidMap) do
						self.guidMap[guid] = instance
						self.trackedInstances[instance] = guid
						attachListeners(instance)
					end
					self:infoPrint(
						`Push applied to {table.concat(destination, ".")} ({created} created, {updated} updated)`
					)
					self:notify(
						`Push applied to {table.concat(destination, ".")} ({created} created, {updated} updated)`
					)
				end
			end)

			setOutboundSuppressed(false)
			if not ok then
				warn("[Quack]: Error applying push snapshot", err)
				self:notify("Failed to apply push snapshot. Check the Output for details.", 10)
			end

			local snapshotClient = self.wsClient
			task.delay(0.5, function()
				if self.wsClient == snapshotClient then self:stopSync() end
			end)
		elseif message.type == "requestPushConfig" then
			sendDaemonConfig(true)
		elseif message.type == "redirect" then
			-- The hub hands this Studio to its place's daemon. Only a local daemon is followed.
			local url = message.url
			if type(url) ~= "string" or url:find("^ws://127%.0%.0%.1:%d+/") == nil then
				warn("[Quack]: Ignored a redirect to", url)
				return
			end
			self:debugPrint("Redirected to the place's daemon")
			-- The same session moves to another socket: nothing stops, nothing is cleared. The hub
			-- closes its end; this side lets go of it first so that close is not a drop.
			local old = self.wsClient
			self.wsClient = nil
			if old then
				table.clear(old.messageHandlers)
				-- Closing waits for the other end; the new link need not (it waited ~0.3 s, 21/10/26)
				task.spawn(function() old:disconnect() end)
			end
			self._redirectUrl = url
			-- Offline, the reconnect loop opens the next socket (it takes the redirect)
			if self._offline then return end
			task.defer(function()
				if not self.syncEnabled or self.wsClient then return end
				if not self:openLink() and self.syncEnabled and not self._offline then
					-- The daemon did not answer: start over through the hub
					self:stopSync(true)
				end
			end)
		elseif message.type == "handshakeAck" then
			local daemonVersion = message.version
			if
				type(daemonVersion) ~= "string"
				or not versionsMatch(daemonVersion, QuackService.VERSION)
			then
				warn(`---------------------`)
				warn(`[Quack]: VERSION MISMATCH: Quack v{daemonVersion or "unknown"}, plugin v{QuackService.VERSION}.`)
				warn(`[Quack]: Make sure both are updated and using matching versions!`)
				warn(`---------------------`)
				self:notify(
					`This plugin (v{QuackService.VERSION}) and Quack (v{daemonVersion or "unknown"}) do not match. Update both to the same version.`,
					15
				)
				self:stopSync()
				return
			end

			if not self.handshakeComplete then
				self.handshakeComplete = true
				self._setupRequested = false
				local wasOffline = self._offline == true
				self._offline = false
				if wasOffline and message.resumed == true then
					-- Back on a daemon that has this session's tree: what changed meanwhile is in the
					-- queues; a script sent just before the drop may not have arrived, so it goes again
					self:debugPrint("Resumed the session: sending what changed meanwhile")
					resendRecentScripts(self._offlineSince or os.clock())
					flushOutboundQueues()
				elseif wasOffline then
					self:debugPrint("Reconnected; the daemon asks for a snapshot")
				else
					self:debugPrint("Handshake acknowledged by daemon")
					self:infoPrint("Connected to Quack")
					self:notify(`Synced with Quack ({self.config.WS_URL})`)
				end
				self._offlineSince = nil
				sendDaemonConfig()
				self.settingsStore:markPlaceSynced()
				if self.ui then self.ui:UpdateHandshakeState(true) end
				if self._handshakeBindable then pcall(function() self._handshakeBindable:Fire() end) end
			end
		elseif message.type == "daemonDisconnect" then
			-- Before the handshake it is the close that follows a refusal, already reported by
			-- its "error"; printing it too doubled the noise on every auto-connect retry
			if self.handshakeComplete then self:infoPrint("Quack is shutting down; disconnecting") end
			self:stopSync(true)
		elseif message.type == "daemonBusy" then
			-- The hub says why (kept the other connection, another Studio took over); old daemons do not
			local text = if type(message.message) == "string" and message.message ~= ""
				then message.message
				else `The Daemon at {self.config.WS_URL} is already syncing another Studio session. Disconnect it first or use a different port.`
			warn("[Quack]:", text)
			self:notify(text, 15)
			-- Retrying would just be rejected again
			self:stopAutoConnect()
			self:stopSync(true)
		elseif message.type == "error" then
			-- Auto-connect retries every few seconds and the hub refuses each time with the same
			-- text: warned once a minute, like the pop-up (spammed the Output, 21/10/26)
			local now = os.clock()
			if message.message ~= self._lastHubError or now - (self._lastHubErrorAt or 0) >= REPEAT_QUIET_SECONDS then
				self._lastHubError = message.message
				self._lastHubErrorAt = now
				warn("[Quack]:", message.message)
			end
			-- A place the hub does not know: offer to stop asking, right in the pop-up
			local unregistered = type(message.message) == "string" and message.message:find("is not registered with the hub", 1, true) ~= nil
			self:notify(message.message, 15, if unregistered
				then {
					{ Text = "Set up", Activated = function() self:requestSetup() end },
					{ Text = "Ignore this place", Activated = function() self:setPlaceIgnored(true) end },
				}
				else nil)
		elseif message.type == "pong" then
			self:debugPrint("Received pong")
		else
			warn("[Quack]: Unknown message type:", message.type)
		end
	end

	--- Handshakes over `client`. true: accepted. false: refused or no answer. nil: superseded (the
	--- session moved to another socket, a redirect or a reconnect, which handshakes on its own).
	local function tryHandshake(client: WebSocketClient.WebSocketClient): boolean?
		if not client or not client.connected then
			warn("[Quack]: Cannot perform handshake - WebSocket client not connected")
			return false
		end

		local tries = 0
		local HANDSHAKE_MAX_RETRIES = safeGetNumber(self.config.MAX_HANDSHAKES, 5)
		local HANDSHAKE_TIMEOUT = 2
		self.handshakeComplete = false

		repeat
			if self.wsClient ~= client then return nil end
			self:debugPrint(`Attempting handshake with daemon... (try {tries}/{HANDSHAKE_MAX_RETRIES})`)
			-- Quack: the place travels with the handshake, so the hub can route this Studio to its folder
			sendMessage("handshakeStudio", {
				version = QuackService.VERSION,
				placeId = game.PlaceId,
				placeName = self._placeName or game.Name,
				-- Tells this Studio apart from a second one of the same place
				session = self._sessionId,
				-- A click on Connect (or Set up) may take a place over; auto-connect retries never do
				explicit = self._connectExplicit == true,
				setup = self._setupRequested == true,
				-- This plugin follows the hub to its daemon: a hub restart then never drops it
				redirect = true,
				-- Still tracking after a drop, with the changes queued: a daemon that has this
				-- session's tree answers resumed and asks for no snapshot
				resume = self._tracking == true,
			})

			local startTime = tick()
			while tick() - startTime < HANDSHAKE_TIMEOUT do
				if self.wsClient ~= client then return nil end
				if not self.syncEnabled or not client.connected then return false end
				if self.handshakeComplete then return true end
				task.wait(0.05)
			end

			tries += 1

			--// Otherwise would bloat the console
			if not self.config.AUTO_CONNECT then warn(`[Quack]: Handshake attempt {tries} failed, retrying...`) end
		until tries >= HANDSHAKE_MAX_RETRIES

		return self.handshakeComplete
	end

	function self:reloadSourcemap() sendFullSnapshot() end

	--- Listeners for the whole place, once per session: a reconnect that resumes keeps them
	local function startTracking()
		if self._tracking then return end
		self._tracking = true

		-- Per-instance listeners, deferred so the handshake ack can finish processing first
		task.defer(function()
			local ok, err = pcall(function()
				local function setupListeners(parent)
					for _, child in ipairs(parent:GetChildren()) do
						attachListeners(child)
						setupListeners(child)
					end
				end

				for _, service in ipairs(game:GetChildren()) do
					setupListeners(service)
					task.wait()
				end
			end)
			if not ok then
				warn("[Quack]: Error during listener setup:", err)
				self:stopSync()
			end
		end)

		-- Instances in an excluded folder have no listeners, so moving one out of it was never
		-- seen; ItemChanged reports the Parent change of any instance in the place
		local itemParentConnection = game.ItemChanged:Connect(function(instance, property)
			if property ~= "Parent" or not self.syncEnabled then return end
			-- One with a listener is handled by it
			if self.listenerAttachedInstances[instance] then return end
			onParentChanged(instance)
		end)
		table.insert(self.connections, itemParentConnection)

		local descendantAddedConnection = game.DescendantAdded:Connect(function(instance)
			if self.syncEnabled then onInstanceAdded(instance) end
		end)
		table.insert(self.connections, descendantAddedConnection)

		local descendantRemovingConnection = game.DescendantRemoving:Connect(function(instance)
			if self.syncEnabled then onInstanceRemoved(instance) end
		end)
		table.insert(self.connections, descendantRemovingConnection)

		-- Roblox doesn't have a script-specific event for source changes, so we use the global signal.
		local textDocumentChangedConnection = ScriptEditorService.TextDocumentDidChange:Connect(
			function(scriptDocument, _)
				if not self.syncEnabled then return end

				local changedScript = scriptDocument:GetScript()
				if not changedScript then return end
				if not self.trackedInstances[changedScript] then return end

				onScriptChanged(changedScript :: Script)
			end
		)
		table.insert(self.connections, textDocumentChangedConnection)
	end

	--- Opens a socket for this session (to the hub, or to a daemon the hub redirected to) and
	--- handshakes on it. Returns whether the socket opened; the handshake follows on its own.
	function self:openLink(): boolean
		-- A redirect from the hub is used once: if the daemon goes away, the next try asks the hub
		local url = self._redirectUrl or self.config.WS_URL
		self._redirectUrl = nil
		local client = WebSocketClient.new(url, {
			debugMode = self.config.DEBUG_MODE,
			silentMode = self.config.SILENT_MODE,
		})
		if not client then
			warn("[Quack]: Failed to create WebSocket client")
			return false
		end
		self.wsClient = client

		client:on("connect", function()
			if self.wsClient ~= client then return end
			if not self._suppressAutoConnectLogs and not self._offline then
				self:infoPrint(`Connected to WebSocket at: {self.config.WS_URL}`)
			end
			local handshakeResult = tryHandshake(client)
			if handshakeResult == nil then return end

			if not handshakeResult then
				-- Offline, the reconnect loop tries again; otherwise the session ends here
				if self._offline then
					if self.wsClient == client then
						self.wsClient = nil
						table.clear(client.messageHandlers)
						client:disconnect()
					end
					return
				end
				-- A session that already stopped (e.g. daemonBusy) reported its own reason
				if self.syncEnabled and not self._suppressAutoConnectLogs then
					self:notify("Quack did not answer the connection. Is the Quack app running?", 10)
				end
				self:stopSync()
				return
			end

			startTracking()
		end)

		client:on("message", function(message)
			if self.wsClient == client then processMessage(message) end
		end)

		client:on("disconnect", function()
			if self.wsClient ~= client or not self.syncEnabled then return end
			-- The daemon closes right after sending a push/build; let the snapshot finish applying first
			while self.suppressOutbound do
				task.wait()
			end
			if self.wsClient ~= client or not self.syncEnabled then return end
			-- A synced session that loses its link keeps tracking, queues what changes, and
			-- reconnects asking to resume: a daemon restart then needs no snapshot of the place
			if self._tracking and self.handshakeComplete and self.config.AUTO_CONNECT then
				self:goOffline()
				return
			end
			if not self._suppressAutoConnectLogs then self:infoPrint("Disconnected from Quack") end
			self:stopSync()
		end)

		client:on("error", function(error) warn("[Quack]: Connection error:", error) end)

		local connected = client:connect()
		if self.wsClient ~= client then
			-- The session was stopped (or moved) while connecting
			table.clear(client.messageHandlers)
			client:disconnect()
			return false
		end
		if not connected then self.wsClient = nil end
		return connected
	end

	--- The link dropped while synced: keep every listener and queue, and reconnect for a while
	--- before giving up and starting over with a snapshot
	function self:goOffline()
		self._offline = true
		self._offlineSince = os.clock()
		self.handshakeComplete = false
		-- A socket that failed to send may still be half open: closed here, without its handlers
		local old = self.wsClient
		self.wsClient = nil
		if old then
			table.clear(old.messageHandlers)
			old:disconnect()
		end
		self:debugPrint("Lost the link to Quack; reconnecting and keeping the changes queued")
		task.spawn(function()
			local OFFLINE_SECONDS = 20
			while self._offline and self.syncEnabled and os.clock() - (self._offlineSince or 0) < OFFLINE_SECONDS do
				if not self.wsClient and self:openLink() then
					-- Wait for its handshake (accepted, refused, or moved by a redirect)
					local deadline = os.clock() + 12
					while self._offline and self.syncEnabled and self.wsClient and os.clock() < deadline do
						task.wait(0.05)
					end
					if not self._offline then return end
				else
					task.wait(0.1)
				end
			end
			if self._offline and self.syncEnabled then
				self._offline = false
				if not self._suppressAutoConnectLogs then self:infoPrint("Disconnected from Quack") end
				self:stopSync(true)
			end
		end)
	end

	function self:startSync(suppressInfo: boolean?)
		if self.syncEnabled then
			warn(`[Quack::{script}]: A Sync Session already active!`)
			return
		end
		local suppress = suppressInfo == true
		self._suppressAutoConnectLogs = suppress
		-- Auto-connect passes suppressInfo; a start without it is the user's click
		self._connectExplicit = not suppress
		if not suppress then self:infoPrint("Starting sync...") end
		self.syncEnabled = true
		self.batchingEnabled = false
		self.batchFlushToken += 1

		if self.ui then self.ui:UpdateSyncState(true) end
		if self.ui then self.ui:UpdateHandshakeState(false) end

		local connected = self:openLink()
		if not self.syncEnabled then return end
		if not connected then
			if not self._suppressAutoConnectLogs then
				warn("[Quack]: Could not reach Quack")
				self:notify(`Could not reach Quack at {self.config.WS_URL}. Is the Quack app running?`, 10)
			end
			self:stopSync()
			return
		end

		local heartbeatConnection = RunService.Heartbeat:Connect(function(dt)
			if self.syncEnabled then
				local now = os.time()
				-- Offline, the reconnect loop owns the link; the queues keep filling meanwhile
				if not self._offline and now - self.lastHeartbeat > safeGetNumber(self.config.HEARTBEAT_INTERVAL, 30) then
					if not sendMessage("ping", {}) then
						-- Synced: keep tracking and reconnect with the queue, as for a closed socket
						if self._tracking and self.handshakeComplete and self.config.AUTO_CONNECT then
							self:goOffline()
							return
						end
						warn("[Quack]: Lost the connection to Quack")
						self:stopSync()
						return
					end
					self.lastHeartbeat = now
				end

				if self.batchingEnabled then
					-- Batch flush uses an idle timer; heartbeat just keeps the client alive
				else
					self.batchAccumulator += dt
					if self.batchAccumulator >= INITIAL_BATCH_INTERVAL then
						self.batchAccumulator -= INITIAL_BATCH_INTERVAL
						flushOutboundQueues()
					end
				end
			end
		end)
		table.insert(self.connections, heartbeatConnection)

		if not self._suppressAutoConnectLogs then self:infoPrint("Sync enabled") end
	end

	function self:stopSync(dontRelayDisconnect: boolean?)
		if not self.syncEnabled then return end

		if not dontRelayDisconnect then sendMessage("clientDisconnect", {}) end

		local suppress = self._suppressAutoConnectLogs == true
		if not suppress then self:infoPrint("Stopping sync...") end
		if self.handshakeComplete or self._offline then self:notify("Disconnected from Quack") end
		self.syncEnabled = false
		self.handshakeComplete = false
		self._tracking = false
		self._offline = false
		self._offlineSince = nil
		table.clear(self._recentScriptSends)

		if self.ui then self.ui:UpdateHandshakeState(false) end
		if self.ui then self.ui:UpdateSyncState(false) end

		if self.wsClient then self.wsClient:disconnect() end
		self.wsClient = nil

		self.trackedInstances = {}
		self.guidMap = {}
		self.batchAccumulator = 0
		table.clear(self.listenerAttachedInstances)
		table.clear(self.pendingInstanceUpdates)
		table.clear(self.pendingScriptChanges)
		table.clear(self.pendingScriptChangeReady)
		table.clear(self.scriptChangeDebounceTokenByGuid)
		for _, thread in pairs(self.scriptChangeDebounceThreadByGuid) do pcall(task.cancel, thread) end
		table.clear(self.scriptChangeDebounceThreadByGuid)
		if self._batchFlushThread then pcall(task.cancel, self._batchFlushThread); self._batchFlushThread = nil end
		table.clear(self.pendingDeletes)

		self.batchingEnabled = false
		self.batchFlushToken += 1

		for _, conn in ipairs(self.connections) do
			conn:Disconnect()
		end
		self.connections = {}

		-- Preserve current suppress state for deciding whether to print "Sync stopped"
		local wasSuppressed = self._suppressAutoConnectLogs == true
		self._suppressAutoConnectLogs = false
		if not wasSuppressed then self:infoPrint("Sync stopped") end
	end

	function self:onSettingsScopeChanged(newScope: string)
		if newScope == self.settingsStore:getScope() then return end

		self.settingsStore:setScope(newScope)
		if self.ui then
			self.ui:SetSettingsScope(self.settingsStore:getScope())
			self.ui:UpdateConfig()
		end
		self:rebuildServiceSet()

		local scopeLabel = if self.settingsStore:getScope() == Enums.scope.GLOBAL then "Global" else "Project"
		self:infoPrint(`Settings scope set to {scopeLabel}`)
	end

	-- Auto-connect control: run a background task to attempt connects and honor config
	function self:startAutoConnect()
		if self._autoConnectThread then return end
		if self.settingsStore:isPlaceIgnored() then
			self:infoPrint("Syncing is off for this place; not connecting")
			return
		end
		self._autoConnectThread = task.spawn(function()
			local attempts = 0
			-- When a live connection dropped: the hub restarting (an update) is back in about a
			-- second, and the 5 s retry interval left Studio unsynced ~8 s (measured 20/10/26)
			local lostAt: number? = nil
			local FAST_RETRY_SECONDS = 20
			local FAST_RETRY_INTERVAL = 0.5
			self:infoPrint("Auto-connect enabled")
			self:debugPrint("AutoConnect: watchdog started")

			while self.config.AUTO_CONNECT do
				-- If not syncing, attempt to start
				if not self.syncEnabled and not self.handshakeComplete then
					self:debugPrint("AutoConnect: starting sync...")
					self:startSync(true)
				end

				-- Wait for handshake or failure
				local handshakeFired = false
				if self._handshakeBindable then
					self._autoConnectHandshakeConn = self._handshakeBindable.Event:Connect(function() handshakeFired = true end)
				end

				local waitCount = 0
				while
					self.syncEnabled
					and not self.handshakeComplete
					and waitCount < safeGetNumber(self.config.MAX_HANDSHAKES, 5)
				do
					task.wait(1)
					waitCount += 1
					if handshakeFired then break end
				end

				if self._autoConnectHandshakeConn then
					self._autoConnectHandshakeConn:Disconnect()
					self._autoConnectHandshakeConn = nil
				end

				if self.handshakeComplete then
					attempts = 0
					self:debugPrint("AutoConnect: connection succeeded")
					-- Idle while connected; checked often so a drop is retried at once
					repeat
						task.wait(0.25)
					until not self.handshakeComplete or not self.config.AUTO_CONNECT
					lostAt = os.clock()
				else
					local fast = lostAt ~= nil and os.clock() - lostAt < FAST_RETRY_SECONDS
					-- Fast retries after a drop do not count toward MAX_RECONNECTIONS
					if not fast then attempts += 1 end
					self:debugPrint(`AutoConnect: attempt {attempts} failed`)
					if self.config.MAX_RECONNECTIONS ~= -1 and attempts >= self.config.MAX_RECONNECTIONS then
						self:infoPrint(
							`Auto-connect: Reached max attempts ({self.config.MAX_RECONNECTIONS}). Stopping.`
						)
						self:notify(`Auto-connect gave up after {self.config.MAX_RECONNECTIONS} attempts.`, 10)
						break
					end
					-- Wait before next attempt
					task.wait(if fast then FAST_RETRY_INTERVAL else safeGetNumber(self.config.RECONNECTION_INTERVAL, 5))
				end
				if not self.config.AUTO_CONNECT then break end
				-- minor yield to avoid tight loop
				task.wait(0.1)
			end

			self._autoConnectThread = nil
			self:debugPrint("AutoConnect: watchdog stopped")
		end)
	end

	function self:stopAutoConnect()
		if not self._autoConnectThread then return end
		local ok, err = pcall(function() task.cancel(self._autoConnectThread) end)
		self._autoConnectThread = nil
		if self._autoConnectHandshakeConn then
			self._autoConnectHandshakeConn:Disconnect()
			self._autoConnectHandshakeConn = nil
		end
		if not ok then warn("AutoConnect: failed to cancel thread:", err) end
	end

	return self :: SyncSession
end

return SyncSession
