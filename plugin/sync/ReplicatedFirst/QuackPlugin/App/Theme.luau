local plugin = script:FindFirstAncestorWhichIsA("Plugin")
local Studio = settings().Studio

local Quack = script:FindFirstAncestor("QuackPlugin")

local Fusion = require(Quack.Packages.fusion)

-- Lives for the whole plugin session; cleaned up on unload
local scope = Fusion.scoped(Fusion)

-- Quack: the app's palette (from the portfolio, Portfolio/src/styles/global.css): warm inks, a
-- near-black outline on every surface, yellow kept for what matters. Fixed, not taken from the
-- Studio theme, so the plugin and the app look the same.
local function getColors(_isDark: boolean): { [string]: { Color3 | { [string]: Color3 } } }
	return {
		Brand = Color3.fromHex("ffd41f"),

		-- The widget itself; components sit one step lighter on it
		Window = Color3.fromHex("0d0b08"),
		Background = Color3.fromHex("1d170f"),
		ActiveBackground = Color3.fromHex("2a2219"),
		Border = Color3.fromHex("0a0806"),
		Rail = Color3.fromHex("2a2219"),

		Text = Color3.fromHex("f3e9d8"),
		TextDimmed = Color3.fromHex("9a8f80"),
		-- Text on yellow is the outline colour, as on the portfolio's buttons
		TextBranded = Color3.fromHex("0a0806"),

		Diff = {
			Add = Color3.fromHex("4ade80"),
			Update = Color3.fromHex("6ec5fb"),
			Remove = Color3.fromHex("f23f43"),
		},
	}
end

local function init(): Fusion.Value<Color3> return scope:Value(Color3.new()) end

local Theme = {
	-- For autocomplete
	Colors = {
		Brand = init(),

		Window = init(),
		Background = init(),
		ActiveBackground = init(),
		Border = init(),
		Rail = init(),

		Text = init(),
		TextDimmed = init(),
		TextBranded = init(),

		Diff = {
			Add = init(),
			Update = init(),
			Remove = init(),
		},
	},

	-- Quack: Montserrat stands in for the portfolio's Archivo (not among Roblox's fonts): the same
	-- heavy geometric feel, Black for the brand tag, Bold for labels and buttons
	Fonts = {
		Regular = Font.fromName("Montserrat", Enum.FontWeight.Medium),
		Bold = Font.fromName("Montserrat", Enum.FontWeight.Bold),
		Black = Font.fromName("Montserrat", Enum.FontWeight.Heavy),
		Italic = Font.fromName("Montserrat", Enum.FontWeight.Medium, Enum.FontStyle.Italic),
		Mono = Font.fromName("RobotoMono"),
		-- The logo's face (Fredoka Bold in app/assets/icon.svg): Fredoka One is its Roblox cut
		Logo = Font.fromName("FredokaOne"),

		-- required for TextService:GetTextSize(). Gotham is the enum Roblox serves with Montserrat
		-- (Enum.Font.Montserrat answers Enum.Font.Gotham in Studio, checked 20/10/26); the canonical
		-- names, so nothing here leans on an alias
		Enums = {
			Regular = Enum.Font.Gotham,
			Bold = Enum.Font.GothamBold,
			Italic = Enum.Font.Gotham,
			Mono = Enum.Font.RobotoMono,
		},
	},

	BorderThickness = 3,
	CornerRadius = 10,
	ListSpacing = 14,
	WidgetPadding = 14,
	Padding = 8,

	-- Montserrat runs wider than SourceSans did: smaller sizes keep the same line lengths
	TextSize = {
		Heading = 26,
		Large = 15,
		Medium = 14,
		Small = 12,
	},

	CompSizeY = {
		Large = 36,
		Medium = 30,
		Small = 28,
	},

	SpringSpeed = 30,
	SpringFastSpeed = 60,
	SpringDamping = 1.5,

	IsDark = scope:Value(true),
}

do
	local function updateTheme()
		local _, _, v = Studio.Theme:GetColor(Enum.StudioStyleGuideColor.MainBackground):ToHSV()
		local isDark = v <= 0.6

		Theme.IsDark:set(isDark)

		for key, color in getColors(isDark) do
			if type(color) ~= "table" then
				Theme.Colors[key]:set(color)
			else
				for subKey, subColor in color do
					Theme.Colors[key][subKey]:set(subColor)
				end
			end
		end
	end

	updateTheme()

	table.insert(scope, Studio.ThemeChanged:Connect(updateTheme))

	plugin.Unloading:Once(function() Fusion.doCleanup(scope) end)

	-- :P
	local now = DateTime.now():ToLocalTime()
	if now.Month == 4 and now.Day == 1 then
		Theme.Colors.Brand:set(Color3.fromHex("e13835"))
		Theme.CornerRadius = 0
	end
end

return Theme
