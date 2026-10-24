--[[
	Quack: the app's pill switch. Yellow track when on, dark when off, outlined, knob sliding.
]]
local Quack = script:FindFirstAncestor("QuackPlugin")
local App = Quack.App
local Components = App.Components
local Util = Components.Util

local Fusion = require(Quack.Packages.fusion)

local Theme = require(App.Theme)
local isState = require(Util.isState)

local Children = Fusion.Children
local OnEvent = Fusion.OnEvent
local peek = Fusion.peek

type Scope = Fusion.Scope<typeof(Fusion)>

type Props = {
	Value: Fusion.UsedAs<boolean>?,
	Changed: ((value: boolean) -> ())?,
	[any]: any,
}

local WIDTH = 42
local HEIGHT = 24
local KNOB = 12
local INSET = 6

return function(outerScope: Scope, props: Props): Instance
	local scope = outerScope:innerScope()
	local value = isState(props.Value) and props.Value or scope:Value(props.Value or false)

	-- The same 6 px from either end: the stroke is drawn outside the track, so it takes no room
	local knobX = scope:Spring(
		scope:Computed(function(use) return use(value) and WIDTH - KNOB - INSET or INSET end),
		Theme.SpringFastSpeed,
		Theme.SpringDamping
	)

	return scope:New "TextButton" {
		Name = "Switch",
		Text = "",
		AutoButtonColor = false,
		Size = UDim2.fromOffset(WIDTH, HEIGHT),
		LayoutOrder = props.LayoutOrder,
		BackgroundColor3 = scope:Computed(
			function(use) return use(value) and use(Theme.Colors.Brand) or use(Theme.Colors.ActiveBackground) end
		),
		[OnEvent "Activated"] = function()
			local nextValue = not peek(value)
			-- A read-only state (a Computed) has no set: the owner hears Changed and updates it
			if typeof((value :: any).set) == "function" then (value :: any):set(nextValue) end
			if props.Changed then props.Changed(nextValue) end
		end,
		[Children] = {
			scope:New "UICorner" { CornerRadius = UDim.new(1, 0) },
			scope:New "UIStroke" {
				ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
				Color = Theme.Colors.Border,
				Thickness = Theme.BorderThickness,
			},
			scope:New "Frame" {
				Name = "Knob",
				AnchorPoint = Vector2.new(0, 0.5),
				Position = scope:Computed(function(use) return UDim2.new(0, use(knobX), 0.5, 0) end),
				Size = UDim2.fromOffset(KNOB, KNOB),
				BorderSizePixel = 0,
				BackgroundColor3 = scope:Computed(
					function(use) return use(value) and use(Theme.Colors.Border) or use(Theme.Colors.TextDimmed) end
				),
				[Children] = scope:New "UICorner" { CornerRadius = UDim.new(1, 0) },
			},
		},
	}
end
