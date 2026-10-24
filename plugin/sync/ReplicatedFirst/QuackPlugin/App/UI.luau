--[[
	Quack UI module
	Component-based dock widget UI for the companion plugin
]]

local UI = {}

local QuackService = require("../QuackService")
local Config = require("../Config")
local Enums = require("../Enums")

local fusion = require("../Packages/fusion")
local Theme = require("./Theme")
local Assets = require("./Assets")
local Notifications = require("./Components/Notifications")

-- Registered on the root scope, so they can be used as `scope:Name { ... }`
local Components = {
	Border = require("./Components/Border"),
	Box = require("./Components/Box"),
	Checkbox = require("./Components/Checkbox"),
	Collapsible = require("./Components/Collapsible"),
	Container = require("./Components/Container"),
	Image = require("./Components/Image"),
	Input = require("./Components/Input"),
	List = require("./Components/List"),
	Notifications = Notifications,
	OptionSelector = require("./Components/OptionSelector"),
	Padding = require("./Components/Padding"),
	ScrollingContainer = require("./Components/ScrollingContainer"),
	Slider = require("./Components/Slider"),
	Switch = require("./Components/Switch"),
	Text = require("./Components/Text"),
	TextButton = require("./Components/TextButton"),
	Toolbar = require("./Components/Plugin/Toolbar"),
	ToolbarButton = require("./Components/Plugin/ToolbarButton"),
	Widget = require("./Components/Plugin/Widget"),
}

local Children = fusion.Children
local OnEvent = fusion.OnEvent
local peek = fusion.peek

type Scope = fusion.Scope<typeof(fusion) & typeof(Components)>

UI.__index = UI

export type HelperFunctions = {
	rebuildServiceSet: () -> (),
	openPlaceConfig: () -> (),
	isPlaceIgnored: () -> boolean,
}

export type CallbackFunctions = {
	onStartSync: () -> (),
	onStopSync: () -> (),
	onAutoConnectChanged: (boolean) -> ()?,
	onDebugModeChanged: (boolean) -> ()?,
	onSilentModeChanged: (boolean) -> ()?,
	onConfigChanged: (string, any) -> (),
	onSettingsScopeChanged: (string) -> (),
	onSourcemapReload: () -> (),
	onPlaceIgnoredChanged: (boolean) -> (),
	onRequestSetup: () -> (),
}

type QuackUI = {
	plugin: Plugin,
	-- Owns every state object and instance the UI creates; cleaned up on unload
	scope: Scope,
	config: { any },
	callbacks: CallbackFunctions,
	LOGO: string,
	LOGO_SYNCED: string,
	settingsScope: string,
	rebuildServiceSet: () -> (),

	isSyncEnabled: boolean,

	quackWidget: DockWidgetPluginGui,
	notify: Notifications.Notify,
	connectButton: PluginToolbarButton,

	icon: fusion.Value<string>,
	isOpen: fusion.Value<boolean>,
	syncEnabled: fusion.Value<boolean>,
	handshakeComplete: fusion.Value<boolean>,
	autoConnect: fusion.Value<boolean>,
	debugMode: fusion.Value<boolean>,
	silentMode: fusion.Value<boolean>,
	notifications: fusion.Value<boolean>,
	notificationSounds: fusion.Value<boolean>,
	autoOpenModal: fusion.Value<boolean>,
	syncReminders: fusion.Value<boolean>,
	streamSoloOutput: fusion.Value<boolean>,
	settingsScopeValue: fusion.Value<string>,
	listTypeValue: fusion.Value<string>,

	wsUrlRef: fusion.Value<TextBox?>,
	heartbeat: fusion.Value<number>,
	batchIdleRef: fusion.Value<TextBox?>,
	scriptDebounceRef: fusion.Value<TextBox?>,

	maxHandshakes: fusion.Value<number>,
	maxReconnections: fusion.Value<number>,
	reconnectionInterval: fusion.Value<number>,

	serviceListRef: fusion.Value<TextBox?>,
	serviceList: fusion.Value<{ string }>,
	excludedParents: fusion.Value<{ string }>,
	ignoredClasses: fusion.Value<{ string }>,
	excludedParentsRef: fusion.Value<TextBox?>,
	ignoredClassesRef: fusion.Value<TextBox?>,

	GetSyncState: (QuackUI) -> boolean,
	UpdateSyncState: (QuackUI, boolean) -> (),
	UpdateHandshakeState: (QuackUI, boolean) -> (),
	UpdateConfig: (QuackUI) -> (),
	SetSettingsScope: (QuackUI, any) -> (),
	Notify: (QuackUI, string, number?, { Notifications.Action }?) -> (),
}

-- Quack: the app's Q (app/assets/icon-small.svg, the official logo) with a status dot, grey idle and
-- green synced, rendered by app/scripts/icons.mjs into plugin/assets/. Decals on EnderexDev:
-- 77079393892035 (idle) and 111806008879312 (synced), uploaded 22/10/26 with the dot moved off the Q's tail
UI.logo = "rbxassetid://79454901305076"
UI.syncedLogo = "rbxassetid://101555384706119"

local function debugPrint(...)
	if not Config.DEBUG_MODE then return end
	print(`[🐛 Quack::{script}]: `, ...)
end

local function labeledInput(scope: Scope, label: string, ref: fusion.Value<TextBox?>, props: { [string]: any })
	local input = scope:Input {
		Text = props.Text or "",
		PlaceholderText = props.Placeholder or "",
		TextWrapped = props.TextWrapped or false,
		MultiLine = props.MultiLine or false,
		ClearTextOnFocus = false,
		Size = UDim2.fromScale(1, 1),
		Changed = props.Changed,
		Finished = props.Finished,
	}
	ref:set(input)

	return scope:Container {
		Size = UDim2.fromScale(1, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		[Children] = {
			scope:List {
				Spacing = 4,
			},
			scope:Text {
				Text = label,
				TextSize = Theme.TextSize.Small,
				Color = Theme.Colors.TextDimmed,
				AutomaticSize = Enum.AutomaticSize.XY,
			},
			scope:Box {
				Size = props.BoxSize or UDim2.new(1, 0, 0, Theme.CompSizeY.Medium),
				AutomaticSize = Enum.AutomaticSize.None,
				[Children] = {
					scope:Padding {
						Padding = 6,
						Vertical = false,
					},
					input,
				},
			},
		},
	}
end

--- The reconnection slider's minimum (0) stands for infinite attempts, stored in config as -1.
local function toReconnectionSlider(value: number): number return if value == -1 then 0 else value end

--[[
	Quack layout. The earlier one was a logo, a button and seven sections of ~25 controls; with the
	hub most of them are never touched. Here: a status card first (state, place, hub, the one
	button), three switches that matter, and everything else folded under Advanced. The network
	timings (heartbeat, batch window, debounce, handshake and reconnection limits) are gone from
	the screen; their saved values still apply.
]]

-- A row with a label, an optional hint under it, and a control on the right
local function settingRow(scope: Scope, label: string, hint: string?, control: Instance)
	-- Built up rather than written `hint and x or nil`: a nil in the middle of a children table
	-- would cut it there
	local texts: { any } = {
		scope:List { Spacing = 2 },
		scope:Text {
			Text = label,
			Font = Theme.Fonts.Bold,
			TextSize = Theme.TextSize.Medium,
			Size = UDim2.fromScale(1, 0),
			AutomaticSize = Enum.AutomaticSize.Y,
			TextWrapped = true,
		},
	}
	if hint then
		table.insert(texts, scope:Text {
			Text = hint,
			TextSize = Theme.TextSize.Small,
			Color = Theme.Colors.TextDimmed,
			Size = UDim2.fromScale(1, 0),
			AutomaticSize = Enum.AutomaticSize.Y,
			TextWrapped = true,
		})
	end
	return scope:Container {
		Size = UDim2.fromScale(1, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		[Children] = {
			scope:New "UIPadding" {
				PaddingTop = UDim.new(0, 10),
				PaddingBottom = UDim.new(0, 10),
				PaddingLeft = UDim.new(0, 12),
				PaddingRight = UDim.new(0, 12),
			},
			scope:Container {
				Size = UDim2.new(1, -56, 0, 0),
				AutomaticSize = Enum.AutomaticSize.Y,
				[Children] = texts,
			},
			scope:Container {
				AnchorPoint = Vector2.new(1, 0.5),
				Position = UDim2.fromScale(1, 0.5),
				Size = UDim2.fromOffset(46, 0),
				AutomaticSize = Enum.AutomaticSize.Y,
				[Children] = {
					scope:List { HorizontalAlignment = Enum.HorizontalAlignment.Right },
					control,
				},
			},
		},
	}
end

-- Rows stacked in one outlined card, a thin rule between them
local function rowGroup(scope: Scope, rows: { Instance })
	-- Centred, so the rules (24 px short of the full width) sit evenly inside the card
	local children = { scope:List { Spacing = 0, HorizontalAlignment = Enum.HorizontalAlignment.Center } }
	for index, row in rows do
		if index > 1 then
			table.insert(children, scope:New "Frame" {
				Size = UDim2.new(1, -24, 0, 2),
				BorderSizePixel = 0,
				BackgroundColor3 = Theme.Colors.Rail,
			})
		end
		table.insert(children, row)
	end
	return scope:Box {
		Size = UDim2.fromScale(1, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		[Children] = children,
	}
end

-- The services a game keeps its content in, in Explorer order. Any other name already in the
-- saved list is shown after these, so nothing in it disappears from the screen
local KNOWN_SERVICES = {
	"Workspace",
	"Lighting",
	"MaterialService",
	"ReplicatedFirst",
	"ReplicatedStorage",
	"ServerScriptService",
	"ServerStorage",
	"StarterGui",
	"StarterPack",
	"StarterPlayer",
	"Teams",
	"SoundService",
	"TextChatService",
	"Chat",
	"LocalizationService",
}

local function checkItem(scope: Scope, name: string, checked, onToggle: () -> ())
	return scope:New "TextButton" {
		Name = name,
		Text = "",
		AutoButtonColor = false,
		BackgroundTransparency = 1,
		[OnEvent "Activated"] = onToggle,
		[Children] = {
			scope:New "Frame" {
				AnchorPoint = Vector2.new(0, 0.5),
				Position = UDim2.new(0, 3, 0.5, 0),
				Size = UDim2.fromOffset(18, 18),
				BorderSizePixel = 0,
				BackgroundColor3 = scope:Computed(
					function(use) return use(checked) and use(Theme.Colors.Brand) or use(Theme.Colors.ActiveBackground) end
				),
				[Children] = {
					scope:New "UICorner" { CornerRadius = UDim.new(0, 5) },
					scope:New "UIStroke" {
						ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
						Color = Theme.Colors.Border,
						Thickness = Theme.BorderThickness,
					},
					scope:New "ImageLabel" {
						AnchorPoint = Vector2.new(0.5, 0.5),
						Position = UDim2.fromScale(0.5, 0.5),
						Size = UDim2.fromOffset(14, 14),
						BackgroundTransparency = 1,
						Image = Assets.Icons.Checkmark,
						ImageColor3 = Theme.Colors.Border,
						Visible = checked,
					},
				},
			},
			scope:Text {
				Text = name,
				-- Regular weight: narrower, so ServerScriptService fits a half-width cell
				Font = Theme.Fonts.Regular,
				TextSize = Theme.TextSize.Small,
				Color = scope:Computed(
					function(use) return use(checked) and use(Theme.Colors.Text) or use(Theme.Colors.TextDimmed) end
				),
				AnchorPoint = Vector2.new(0, 0.5),
				Position = UDim2.new(0, 27, 0.5, 0),
				Size = UDim2.new(1, -27, 1, 0),
				AutomaticSize = Enum.AutomaticSize.None,
				TextTruncate = Enum.TextTruncate.AtEnd,
			},
		},
	}
end

-- Every service as a checkbox, two columns. Ticking writes SERVICE_LIST; the list mode decides
-- whether the ticked ones are the only ones synced (whitelist) or the ones left out (blacklist)
local function serviceChecklist(self, scope: Scope)
	local names = table.clone(KNOWN_SERVICES)
	local known = {}
	for _, name in KNOWN_SERVICES do known[name] = true end
	for _, name in Config.SERVICE_LIST do
		if not known[name] then table.insert(names, name) end
	end

	local items: { any } = {
		scope:New "UIGridLayout" {
			CellSize = UDim2.new(0.5, -3, 0, 30),
			CellPadding = UDim2.fromOffset(6, 2),
			SortOrder = Enum.SortOrder.LayoutOrder,
		},
	}
	for order, name in names do
		local checked = scope:Computed(function(use) return table.find(use(self.serviceList), name) ~= nil end)
		local item = checkItem(scope, name, checked, function()
			local list = table.clone(peek(self.serviceList))
			local at = table.find(list, name)
			if at then
				table.remove(list, at)
			else
				table.insert(list, name)
			end
			self.serviceList:set(list)
			self.callbacks.onConfigChanged("SERVICE_LIST", list)
		end)
		item.LayoutOrder = order
		table.insert(items, item)
	end

	return scope:Container {
		Size = UDim2.fromScale(1, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		[Children] = {
			scope:List { Spacing = 6 },
			scope:Text {
				Text = scope:Computed(function(use)
					return if use(self.listTypeValue) == "Whitelist"
						then "SERVICES THAT SYNC"
						else "SERVICES LEFT OUT"
				end),
				Font = Theme.Fonts.Bold,
				TextSize = Theme.TextSize.Small,
				Color = Theme.Colors.TextDimmed,
				AutomaticSize = Enum.AutomaticSize.XY,
			},
			scope:Box {
				Size = UDim2.fromScale(1, 0),
				AutomaticSize = Enum.AutomaticSize.Y,
				[Children] = {
					scope:Padding { Padding = 10 },
					scope:Container {
						Size = UDim2.fromScale(1, 0),
						AutomaticSize = Enum.AutomaticSize.Y,
						[Children] = items,
					},
				},
			},
		},
	}
end

local function smallLabel(scope: Scope, text: string)
	return scope:Text {
		Text = string.upper(text),
		Font = Theme.Fonts.Bold,
		TextSize = Theme.TextSize.Small,
		Color = Theme.Colors.TextDimmed,
		AutomaticSize = Enum.AutomaticSize.XY,
	}
end

--[[
	A list edited as removable rows: each entry with an × to drop it, a box to type one, and a
	button that takes it from the Explorer selection. Replaces the comma-separated fields.
]]
type ListEditorOptions = {
	title: string,
	empty: string,
	key: string,
	list: any,
	placeholder: string,
	selectionText: string,
	fromSelection: () -> { string },
}

local function listEditor(self, scope: Scope, options: ListEditorOptions)
	local typed = scope:Value("")
	local inputRef: { box: TextBox? } = { box = nil }

	local function save(list: { string })
		options.list:set(list)
		self.callbacks.onConfigChanged(options.key, list)
	end

	local function add(items: { string })
		local list = table.clone(peek(options.list))
		local added = 0
		for _, item in items do
			item = item:match("^%s*(.-)%s*$")
			if item ~= "" and not table.find(list, item) then
				table.insert(list, item)
				added += 1
			end
		end
		if added > 0 then save(list) end
		return added
	end

	local rows = scope:ForPairs(options.list, function(_, innerScope, index, item)
		return index, innerScope:Container {
			LayoutOrder = index,
			Size = UDim2.fromScale(1, 0),
			AutomaticSize = Enum.AutomaticSize.Y,
			[Children] = {
				innerScope:New "UIPadding" {
					PaddingTop = UDim.new(0, 6),
					PaddingBottom = UDim.new(0, 6),
					PaddingLeft = UDim.new(0, 12),
					PaddingRight = UDim.new(0, 8),
				},
				innerScope:Text {
					Text = item,
					Font = Theme.Fonts.Mono,
					TextSize = Theme.TextSize.Small,
					Size = UDim2.new(1, -36, 0, 0),
					AutomaticSize = Enum.AutomaticSize.Y,
					TextWrapped = true,
				},
				innerScope:New "TextButton" {
					AnchorPoint = Vector2.new(1, 0.5),
					Position = UDim2.fromScale(1, 0.5),
					Size = UDim2.fromOffset(26, 26),
					Text = "×",
					FontFace = Theme.Fonts.Bold,
					TextSize = 18,
					TextColor3 = Theme.Colors.TextDimmed,
					BackgroundColor3 = Theme.Colors.ActiveBackground,
					AutoButtonColor = true,
					[OnEvent "Activated"] = function()
						local list = table.clone(peek(options.list))
						local at = table.find(list, item)
						if at then
							table.remove(list, at)
							save(list)
						end
					end,
					[Children] = innerScope:New "UICorner" { CornerRadius = UDim.new(0, 6) },
				},
			},
		}
	end)

	local inputBox = scope:Input {
		PlaceholderText = options.placeholder,
		Font = Theme.Fonts.Mono,
		TextSize = Theme.TextSize.Small,
		Size = UDim2.fromScale(1, 1),
		Changed = function(text) typed:set(text) end,
	}
	inputRef.box = inputBox

	return scope:Container {
		Size = UDim2.fromScale(1, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		[Children] = {
			scope:List { Spacing = 6 },
			smallLabel(scope, options.title),
			scope:Box {
				Size = UDim2.fromScale(1, 0),
				AutomaticSize = Enum.AutomaticSize.Y,
				[Children] = {
					scope:List { Spacing = 0 },
					rows,
					scope:Text {
						LayoutOrder = 100000,
						Text = options.empty,
						TextSize = Theme.TextSize.Small,
						Color = Theme.Colors.TextDimmed,
						Size = UDim2.fromScale(1, 0),
						AutomaticSize = Enum.AutomaticSize.Y,
						Visible = scope:Computed(function(use) return #use(options.list) == 0 end),
						[Children] = scope:New "UIPadding" {
							PaddingTop = UDim.new(0, 10),
							PaddingBottom = UDim.new(0, 10),
							PaddingLeft = UDim.new(0, 12),
						},
					},
				},
			},
			scope:Container {
				Size = UDim2.new(1, 0, 0, Theme.CompSizeY.Medium + 4),
				AutomaticSize = Enum.AutomaticSize.None,
				[Children] = {
					scope:Box {
						Size = UDim2.new(1, -70, 1, 0),
						AutomaticSize = Enum.AutomaticSize.None,
						[Children] = {
							scope:Padding { Padding = 8, Vertical = false },
							inputBox,
						},
					},
					scope:TextButton {
						AnchorPoint = Vector2.new(1, 0),
						Position = UDim2.fromScale(1, 0),
						Size = UDim2.new(0, 62, 1, 0),
						Text = "Add",
						Activated = function()
							if add({ peek(typed) }) > 0 and inputRef.box then inputRef.box.Text = "" end
						end,
					},
				},
			},
			scope:TextButton {
				Text = options.selectionText,
				Size = UDim2.new(1, 0, 0, Theme.CompSizeY.Medium + 4),
				Activated = function()
					local items = options.fromSelection()
					if #items == 0 then
						self:Notify("Select something in the Explorer first.")
					elseif add(items) == 0 then
						self:Notify("Already in the list.")
					end
				end,
			},
		},
	}
end


local function buildContent(self, scope: Scope, helpers)
	-- off: not trying; waiting: trying, the hub has not accepted yet; synced: handshake done
	local status = scope:Computed(function(use)
		if not use(self.syncEnabled) then return "off" end
		return if use(self.handshakeComplete) then "synced" else "waiting"
	end)
	local statusText = scope:Computed(function(use)
		local s = use(status)
		return if s == "synced" then "Synced" elseif s == "waiting" then "Waiting for the hub" else "Not connected"
	end)
	local statusColor = scope:Computed(function(use)
		local s = use(status)
		return if s == "synced"
			then use(Theme.Colors.Diff.Add)
			elseif s == "waiting" then use(Theme.Colors.Brand)
			else use(Theme.Colors.TextDimmed)
	end)

	local function switch(value, key: string, onChanged: ((boolean) -> ())?)
		return scope:Switch {
			Value = value,
			Changed = function(newValue)
				Config[key] = newValue
				if onChanged then onChanged(newValue) end
				self.callbacks.onConfigChanged(key, newValue)
			end,
		}
	end

	-- game.Name is the place's internal name ("Place1"); the name people know comes from Roblox,
	-- fetched once, with the internal one shown until it answers
	local placeName = scope:Value(
		if game.PlaceId == 0 then `{game.Name} (not saved to Roblox)` else `{game.Name} · {game.PlaceId}`
	)
	if game.PlaceId ~= 0 then
		task.spawn(function()
			local ok, info = pcall(function()
				return game:GetService("MarketplaceService"):GetProductInfo(game.PlaceId)
			end)
			if ok and type(info) == "table" and type(info.Name) == "string" and info.Name ~= "" then
				placeName:set(`{info.Name} · {game.PlaceId}`)
			end
		end)
	end

	local statusCard = scope:Box {
		Size = UDim2.fromScale(1, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		[Children] = {
			scope:Padding { Padding = 14 },
			scope:List { Spacing = 12 },
			scope:Container {
				Size = UDim2.fromScale(1, 0),
				AutomaticSize = Enum.AutomaticSize.Y,
				[Children] = {
					scope:List {
						FillDirection = Enum.FillDirection.Horizontal,
						VerticalAlignment = Enum.VerticalAlignment.Center,
						Spacing = 12,
					},
					scope:Image {
						Size = UDim2.fromOffset(44, 44),
						Image = self.icon,
					},
					scope:Container {
						Size = UDim2.new(1, -56, 0, 0),
						AutomaticSize = Enum.AutomaticSize.Y,
						[Children] = {
							scope:List { Spacing = 2 },
							scope:Text {
								Text = scope:Computed(function(use) return string.upper(use(statusText)) end),
								Font = Theme.Fonts.Black,
								TextSize = Theme.TextSize.Large + 3,
								Color = statusColor,
								Size = UDim2.fromScale(1, 0),
								AutomaticSize = Enum.AutomaticSize.Y,
								TextWrapped = true,
							},
							scope:Text {
								Text = scope:Computed(function(use) return `Hub · {use(self.wsUrlValue)}` end),
								Font = Theme.Fonts.Mono,
								TextSize = Theme.TextSize.Small,
								Color = Theme.Colors.TextDimmed,
								AutomaticSize = Enum.AutomaticSize.XY,
							},
						},
					},
				},
			},
			scope:New "Frame" {
				Size = UDim2.new(1, 0, 0, 2),
				BorderSizePixel = 0,
				BackgroundColor3 = Theme.Colors.Rail,
			},
			scope:Container {
				Size = UDim2.fromScale(1, 0),
				AutomaticSize = Enum.AutomaticSize.Y,
				[Children] = {
					scope:List { Spacing = 2 },
					smallLabel(scope, "Place"),
					scope:Text {
						Text = placeName,
						Font = Theme.Fonts.Bold,
						TextSize = Theme.TextSize.Medium,
						Size = UDim2.fromScale(1, 0),
						AutomaticSize = Enum.AutomaticSize.Y,
						TextWrapped = true,
					},
				},
			},
			-- A place the hub does not know: set it up from here
			scope:TextButton {
				Text = "Set up in Quack",
				Size = UDim2.new(1, 0, 0, Theme.CompSizeY.Large + 4),
				Solid = true,
				Visible = scope:Computed(function(use) return string.find(use(self.lastNotice), "is not registered with the hub", 1, true) ~= nil end),
				Activated = function() self.callbacks.onRequestSetup() end,
			},
			-- The last thing the hub or the daemon said, e.g. why a place was refused
			scope:Text {
				Text = self.lastNotice,
				TextSize = Theme.TextSize.Small,
				Color = Theme.Colors.TextDimmed,
				Size = UDim2.fromScale(1, 0),
				AutomaticSize = Enum.AutomaticSize.Y,
				TextWrapped = true,
				Visible = scope:Computed(function(use) return use(self.lastNotice) ~= "" end),
			},
			scope:TextButton {
				Text = scope:Computed(function(use)
					local s = use(status)
					return if s == "synced" then "Disconnect" elseif s == "waiting" then "Stop trying" else "Connect"
				end),
				Size = UDim2.new(1, 0, 0, Theme.CompSizeY.Large + 4),
				Solid = scope:Computed(function(use) return use(status) ~= "synced" end),
				Activated = function()
					if peek(self.syncEnabled) then
						self.callbacks.onStopSync()
					else
						self.callbacks.onStartSync()
					end
				end,
			},
		},
	}

	local placeSwitch = scope:Switch {
		Value = self.placeEnabled,
		Changed = function(enabled) self.callbacks.onPlaceIgnoredChanged(not enabled) end,
	}

	local quick = rowGroup(scope, {
		settingRow(scope, "Sync this place", "Off: this place never connects and shows no Quack pop-ups.", placeSwitch),
		settingRow(scope, "Connect on its own", "When Studio opens a registered place.", switch(self.autoConnect, "AUTO_CONNECT", function(v)
			if self.callbacks.onAutoConnectChanged then self.callbacks.onAutoConnectChanged(v) end
		end)),
		settingRow(scope, "Playtest output", "Shown in the Quack app's Playtest tab.", switch(self.streamSoloOutput, "STREAM_SOLO_OUTPUT")),
		settingRow(scope, "Notifications", "Pop-ups for connects, refusals and merges.", switch(self.notifications, "NOTIFICATIONS")),
	})

	local advanced = scope:Container {
		Size = UDim2.fromScale(1, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		[Children] = {
			scope:Padding { Padding = 12 },
			scope:List { Spacing = 12 },
			labeledInput(scope, "Hub address", self.wsUrlRef, {
				Text = Config.WS_URL,
				Finished = function(text)
					if text == "" then return end
					self.callbacks.onConfigChanged("WS_URL", text)
				end,
			}),
			rowGroup(scope, {
				settingRow(scope, "Notification sounds", nil, switch(self.notificationSounds, "NOTIFICATION_SOUNDS")),
				settingRow(scope, "Open this window at start", nil, switch(self.autoOpenModal, "AUTO_OPEN_MODAL")),
				settingRow(scope, "Sync reminders", nil, switch(self.syncReminders, "SYNC_REMINDERS")),
				settingRow(scope, "Debug logging", nil, switch(self.debugMode, "DEBUG_MODE", function(v)
					if self.callbacks.onDebugModeChanged then self.callbacks.onDebugModeChanged(v) end
				end)),
				settingRow(scope, "Silent", "Only errors in the Output window.", switch(self.silentMode, "SILENT_MODE", function(v)
					if self.callbacks.onSilentModeChanged then self.callbacks.onSilentModeChanged(v) end
				end)),
			}),
			smallLabel(scope, "Settings saved for"),
			scope:OptionSelector {
				Options = { "Global", "Project" },
				Value = self.settingsScopeValue,
				Selected = function(option)
					local settingsScope = option == "Global" and Enums.scope.GLOBAL or Enums.scope.PROJECT
					self.callbacks.onSettingsScopeChanged(settingsScope)
				end,
			},
			smallLabel(scope, "What syncs"),
			scope:OptionSelector {
				Options = { "Whitelist", "Blacklist" },
				Value = self.listTypeValue,
				Selected = function(option)
					self.callbacks.onConfigChanged(
						"LIST_TYPE",
						option == "Whitelist" and Enums.listType.WHITELIST or Enums.listType.BLACKLIST
					)
				end,
			},
			serviceChecklist(self, scope),
			listEditor(self, scope, {
				title = "Folders left out",
				empty = "Nothing left out.",
				key = "EXCLUDED_PARENTS",
				list = self.excludedParents,
				placeholder = "Workspace.Folder",
				selectionText = "Leave out the selection",
				fromSelection = function()
					local paths = {}
					for _, instance in game:GetService("Selection"):Get() do
						-- A whole service is chosen in the checklist above, not here
						if instance.Parent ~= game and instance ~= game then table.insert(paths, instance:GetFullName()) end
					end
					return paths
				end,
			}),
			listEditor(self, scope, {
				title = "Classes ignored",
				empty = "No class ignored.",
				key = "IGNORED_CLASSES",
				list = self.ignoredClasses,
				placeholder = "ClassName",
				selectionText = "Ignore the selection's class",
				fromSelection = function()
					local classes = {}
					for _, instance in game:GetService("Selection"):Get() do
						if instance.Parent ~= game and instance ~= game then table.insert(classes, instance.ClassName) end
					end
					return classes
				end,
			}),
			scope:TextButton {
				Text = "Reload sourcemap",
				Size = UDim2.new(1, 0, 0, Theme.CompSizeY.Medium + 4),
				Activated = function() self.callbacks.onSourcemapReload() end,
			},
			scope:TextButton {
				Text = "Open place configuration",
				Size = UDim2.new(1, 0, 0, Theme.CompSizeY.Medium + 4),
				Activated = function() helpers.openPlaceConfig() end,
			},
		},
	}

	return {
		scope:Padding { Padding = Theme.WidgetPadding },
		scope:List { Spacing = Theme.ListSpacing },
		-- Top bar: the app's yellow tag and the version, nothing else
		scope:Container {
			Size = UDim2.fromScale(1, 0),
			AutomaticSize = Enum.AutomaticSize.Y,
			[Children] = {
				scope:Text {
					Text = "QUACK",
					Font = Theme.Fonts.Logo,
					TextSize = Theme.TextSize.Large + 2,
					Color = Theme.Colors.TextBranded,
					AutomaticSize = Enum.AutomaticSize.XY,
					BackgroundColor3 = Theme.Colors.Brand,
					BackgroundTransparency = 0,
					[Children] = {
						scope:New "UIPadding" {
							PaddingLeft = UDim.new(0, 10),
							PaddingRight = UDim.new(0, 10),
							PaddingTop = UDim.new(0, 3),
							PaddingBottom = UDim.new(0, 3),
						},
						scope:Border {},
					},
				},
				scope:Text {
					AnchorPoint = Vector2.new(1, 0.5),
					Position = UDim2.fromScale(1, 0.5),
					Text = `v{QuackService.VERSION}`,
					Font = Theme.Fonts.Mono,
					TextSize = Theme.TextSize.Small,
					Color = Theme.Colors.TextDimmed,
					AutomaticSize = Enum.AutomaticSize.XY,
				},
			},
		},
		statusCard,
		smallLabel(scope, "Quick settings"),
		quick,
		scope:Collapsible {
			Title = "Advanced",
			Elements = { advanced },
		},
		scope:Text {
			Text = "Output, merges and conflicts are in the Quack app.",
			TextSize = Theme.TextSize.Small,
			Color = Theme.Colors.TextDimmed,
			Size = UDim2.fromScale(1, 0),
			AutomaticSize = Enum.AutomaticSize.Y,
			TextWrapped = true,
		},
	}
end

--[=[
	Initializes the plugin UI, sets up callbacks, and manages sync state
]=]
function UI.new(plugin, callbacks, settingsScope, helpers): QuackUI
	local self = {} :: QuackUI
	setmetatable(self, UI)

	-- Store references
	self.plugin = plugin
	self.callbacks = callbacks
	self.LOGO = UI.logo
	self.LOGO_SYNCED = UI.syncedLogo
	self.settingsScope = settingsScope
	self.rebuildServiceSet = helpers.rebuildServiceSet

	-- Track sync enabled state locally
	self.isSyncEnabled = false

	local scope = fusion.scoped(fusion, Components)
	self.scope = scope
	plugin.Unloading:Once(function() fusion.doCleanup(scope) end)

	self.icon = scope:Value(self.LOGO)
	self.isOpen = scope:Value(Config.AUTO_OPEN_MODAL and true or false)
	self.syncEnabled = scope:Value(false)
	self.handshakeComplete = scope:Value(false)
	self.autoConnect = scope:Value(Config.AUTO_CONNECT)
	self.debugMode = scope:Value(Config.DEBUG_MODE)
	self.silentMode = scope:Value(Config.SILENT_MODE)
	self.notifications = scope:Value(Config.NOTIFICATIONS)
	self.notificationSounds = scope:Value(Config.NOTIFICATION_SOUNDS)
	self.autoOpenModal = scope:Value(Config.AUTO_OPEN_MODAL)
	self.syncReminders = scope:Value(Config.SYNC_REMINDERS)
	self.streamSoloOutput = scope:Value(Config.STREAM_SOLO_OUTPUT)
	self.settingsScopeValue = scope:Value(settingsScope == Enums.scope.GLOBAL and "Global" or "Project")
	self.listTypeValue = scope:Value(Config.LIST_TYPE == Enums.listType.WHITELIST and "Whitelist" or "Blacklist")

	self.wsUrlRef = scope:Value(nil)
	self.wsUrlValue = scope:Value(Config.WS_URL)
	self.lastNotice = scope:Value("")
	self.placeEnabled = scope:Value(not helpers.isPlaceIgnored())
	self.heartbeat = scope:Value(Config.HEARTBEAT_INTERVAL)
	self.batchIdleRef = scope:Value(nil)
	self.scriptDebounceRef = scope:Value(nil)

	self.maxHandshakes = scope:Value(Config.MAX_HANDSHAKES)
	self.maxReconnections = scope:Value(toReconnectionSlider(Config.MAX_RECONNECTIONS))
	self.reconnectionInterval = scope:Value(Config.RECONNECTION_INTERVAL)

	self.serviceListRef = scope:Value(nil)
	self.serviceList = scope:Value(table.clone(Config.SERVICE_LIST))
	self.excludedParents = scope:Value(table.clone(Config.EXCLUDED_PARENTS))
	self.ignoredClasses = scope:Value(table.clone(Config.IGNORED_CLASSES))
	self.excludedParentsRef = scope:Value(nil)
	self.ignoredClassesRef = scope:Value(nil)

	self.connectButton = scope:ToolbarButton {
		Toolbar = scope:Toolbar {
			Name = "Quack",
		},
		Name = "Quack",
		ToolTip = "Open Quack",
		Image = self.icon,
		[OnEvent "Click"] = function() self.isOpen:set(not peek(self.isOpen)) end,
	}

	local widget = scope:Widget {
		Name = "Quack",
		Id = "Quack",
		MinimumSize = Vector2.new(300, 300),
		FloatingSize = Vector2.new(345, 640),
		InitialDockTo = Enum.InitialDockState.Float,
		InitialEnabled = Config.AUTO_OPEN_MODAL and true or false,
		Enabled = self.isOpen,
		[Children] = {
			scope:Container {
				Size = UDim2.fromScale(1, 1),
				AutomaticSize = Enum.AutomaticSize.None,
				BackgroundColor3 = Theme.Colors.Window,
				BackgroundTransparency = 0,
				[Children] = {
					scope:ScrollingContainer {
						ScrollBar = true,
						[Children] = buildContent(self, scope, helpers),
					},
				},
			},
		},
	}

	self.quackWidget = widget

	self.notify = scope:Notifications {
		Logo = self.icon,
		SoundParent = widget,
	}

	scope:Observer(self.isOpen):onChange(function() self.connectButton:SetActive(peek(self.isOpen)) end)

	self.connectButton:SetActive(peek(self.isOpen))

	return self
end

function UI:GetSyncState() return self.isSyncEnabled end

function UI:UpdateSyncState(enabled: boolean)
	self.isSyncEnabled = enabled
	self.syncEnabled:set(enabled)
	self.icon:set(if enabled then self.LOGO_SYNCED else self.LOGO)
	if not enabled then self.handshakeComplete:set(false) end
end

function UI:UpdateHandshakeState(complete: boolean)
	self.handshakeComplete:set(complete)
	-- A refusal or setup notice from before the connect no longer applies
	if complete then self.lastNotice:set("") end
end

--[=[
	Shows a pop-up notification for `timeout` seconds with optional `actions` buttons, unless notifications are disabled.
]=]
function UI:UpdatePlaceIgnored(ignored: boolean)
	self.placeEnabled:set(not ignored)
	self.lastNotice:set(if ignored then "Syncing is off for this place." else "")
end

function UI:Notify(text: string, timeout: number?, actions: { Notifications.Action }?)
	-- Quack: the status card keeps the last notice even with pop-ups off
	self.lastNotice:set(text)
	if not Config.NOTIFICATIONS then return end
	self.notify(text, timeout, Config.NOTIFICATION_SOUNDS, actions)
end

function UI:SetSettingsScope(scope)
	self.settingsScope = scope
	self.settingsScopeValue:set(if scope == Enums.scope.GLOBAL then "Global" else "Project")
end

function UI:UpdateConfig()
	self = self :: QuackUI

	self.autoConnect:set(Config.AUTO_CONNECT)
	self.debugMode:set(Config.DEBUG_MODE)
	self.silentMode:set(Config.SILENT_MODE)
	self.notifications:set(Config.NOTIFICATIONS)
	self.notificationSounds:set(Config.NOTIFICATION_SOUNDS)
	self.autoOpenModal:set(Config.AUTO_OPEN_MODAL)
	self.syncReminders:set(Config.SYNC_REMINDERS)
	self.streamSoloOutput:set(Config.STREAM_SOLO_OUTPUT)
	self.settingsScopeValue:set(if self.settingsScope == Enums.scope.GLOBAL then "Global" else "Project")
	self.listTypeValue:set(if Config.LIST_TYPE == Enums.listType.WHITELIST then "Whitelist" else "Blacklist")

	local wsUrlInput = peek(self.wsUrlRef)
	if wsUrlInput then wsUrlInput.Text = Config.WS_URL end
	self.wsUrlValue:set(Config.WS_URL)

	self.heartbeat:set(Config.HEARTBEAT_INTERVAL)

	local batchIdleInput = peek(self.batchIdleRef)
	if batchIdleInput then batchIdleInput.Text = tostring(Config.BATCH_IDLE_WINDOW) end

	local scriptDebounceInput = peek(self.scriptDebounceRef)
	if scriptDebounceInput then scriptDebounceInput.Text = tostring(Config.SCRIPT_CHANGE_DEBOUNCE) end

	self.maxHandshakes:set(Config.MAX_HANDSHAKES)
	self.maxReconnections:set(toReconnectionSlider(Config.MAX_RECONNECTIONS))
	self.reconnectionInterval:set(Config.RECONNECTION_INTERVAL)

	self.serviceList:set(table.clone(Config.SERVICE_LIST))
	self.excludedParents:set(table.clone(Config.EXCLUDED_PARENTS))
	self.ignoredClasses:set(table.clone(Config.IGNORED_CLASSES))

	local serviceListInput = peek(self.serviceListRef)
	if serviceListInput then serviceListInput.Text = table.concat(Config.SERVICE_LIST, ", ") end

	local excludedParentsInput = peek(self.excludedParentsRef)
	if excludedParentsInput then excludedParentsInput.Text = table.concat(Config.EXCLUDED_PARENTS, ", ") end

	local ignoredClassesInput = peek(self.ignoredClassesRef)
	if ignoredClassesInput then ignoredClassesInput.Text = table.concat(Config.IGNORED_CLASSES, ", ") end
end

return UI
