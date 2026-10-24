local Enums = require("./Enums")

configTable = {
	WS_URL = "localhost:3825",

	-- Auto-Reconnect Settings
	MAX_HANDSHAKES = 5, -- Maximum handshake attempts per connection
	MAX_RECONNECTIONS = -1, -- Maximum total reconnection attempts before giving up (-1 for infinite)
	RECONNECTION_INTERVAL = 5,

	HEARTBEAT_INTERVAL = 30,
	-- Quack: an edit reached the disk ~0.65 s after the last keystroke, 0.35 s of it this debounce
	-- (measured 21/10/26); 0.15 s still lets a word be typed without a write per letter
	BATCH_IDLE_WINDOW = 0.05,
	SCRIPT_CHANGE_DEBOUNCE = 0.15,
	LIST_TYPE = Enums.listType.WHITELIST, -- or BLACKLIST
	SERVICE_LIST = {
		"Workspace",
		"Lighting",
		"ReplicatedFirst",
		"ReplicatedStorage",
		"ServerScriptService",
		"ServerStorage",
		"StarterGui",
		"StarterPack",
		"StarterPlayer",
		"SoundService",
	},

	EXCLUDED_PARENTS = {
		"ServerStorage.RecPlugins", -- Folder managed by "Eye" plugin. It updates the sourcemap thousands of times. We don't need to track this.
		"Workspace.Surface Converter Storage", -- Folder managed by "Surface Converter" plugin. We don't need to track it.
	},

	IGNORED_CLASSES = { -- ClassNames to ignore entirely (the instance and all of its descendants)
		"KeyframeSequence", -- Keyframe Sequences are created by the Animation Editor. They are created in immense numbers and are not useful to track.
	},

	AUTO_CONNECT = true, -- Quack: connects on its own; the daemon refuses a place other than its folder's
	DEBUG_MODE = false,
	SILENT_MODE = false,
	NOTIFICATIONS = true,
	NOTIFICATION_SOUNDS = true,
	AUTO_OPEN_MODAL = true,
	SYNC_REMINDERS = true, -- Remind to sync when opening a previously synced Place
	STREAM_SOLO_OUTPUT = false,
}

return configTable
