--!nocheck
-- Quack Test: the Roblox data types Lune does not have, as tables whose typeof is Roblox's name:
-- DateTime, TweenInfo, RaycastParams, OverlapParams, Random. Local time is UTC here, so a test
-- reads the same on every machine.

local LuneDateTime = require("@lune/datetime")

local function typed(name: string, methods: { [string]: any }?)
	local meta = methods or {}
	meta.__index = meta
	meta.__type = name
	meta.__tostring = meta.__tostring or function()
		return name
	end
	return meta
end

-- ---------------------------------------------------------------------------------------------
-- DateTime

-- Days since 1970-01-01 <-> civil date (Howard Hinnant's algorithms, proleptic Gregorian)
local function daysFromCivil(y: number, m: number, d: number): number
	y -= if m <= 2 then 1 else 0
	local era = (if y >= 0 then y else y - 399) // 400
	local yoe = y - era * 400
	local doy = (153 * (m + (if m > 2 then -3 else 9)) + 2) // 5 + d - 1
	local doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
	return era * 146097 + doe - 719468
end

local function civilFromDays(z: number): (number, number, number)
	z += 719468
	local era = (if z >= 0 then z else z - 146096) // 146097
	local doe = z - era * 146097
	local yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
	local y = yoe + era * 400
	local doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
	local mp = (5 * doy + 2) // 153
	local d = doy - (153 * mp + 2) // 5 + 1
	local m = mp + (if mp < 10 then 3 else -9)
	return y + (if m <= 2 then 1 else 0), m, d
end

local MONTHS = { "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December" }
local DAYS = { "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday" }

local DateTimeMeta
local DateTime = {}

local function fromMillis(ms: number)
	ms = math.floor(ms)
	return setmetatable({ UnixTimestampMillis = ms, UnixTimestamp = ms // 1000 }, DateTimeMeta)
end

local function parts(self)
	local ms = self.UnixTimestampMillis
	local days = ms // 86400000
	local rest = ms - days * 86400000
	local y, m, d = civilFromDays(days)
	return {
		Year = y,
		Month = m,
		Day = d,
		Hour = rest // 3600000,
		Minute = (rest // 60000) % 60,
		Second = (rest // 1000) % 60,
		Millisecond = rest % 1000,
		WeekDay = (days + 4) % 7, -- 1970-01-01 was a Thursday; 0 is Sunday
	}
end

local function pad(n: number, width: number): string
	return string.format(`%0{width}d`, n)
end

-- Roblox's (Moment.js) format tokens, the common ones; text in [brackets] is kept as written
local function format(self, fmt: string): string
	local p = parts(self)
	local hour12 = if p.Hour % 12 == 0 then 12 else p.Hour % 12
	local tokens = {
		YYYY = tostring(p.Year),
		YY = pad(p.Year % 100, 2),
		MMMM = MONTHS[p.Month],
		MMM = string.sub(MONTHS[p.Month], 1, 3),
		MM = pad(p.Month, 2),
		M = tostring(p.Month),
		DD = pad(p.Day, 2),
		D = tostring(p.Day),
		dddd = DAYS[p.WeekDay + 1],
		ddd = string.sub(DAYS[p.WeekDay + 1], 1, 3),
		HH = pad(p.Hour, 2),
		H = tostring(p.Hour),
		hh = pad(hour12, 2),
		h = tostring(hour12),
		mm = pad(p.Minute, 2),
		m = tostring(p.Minute),
		ss = pad(p.Second, 2),
		s = tostring(p.Second),
		SSS = pad(p.Millisecond, 3),
		A = if p.Hour < 12 then "AM" else "PM",
		a = if p.Hour < 12 then "am" else "pm",
	}
	local order = { "YYYY", "YY", "MMMM", "MMM", "MM", "M", "DD", "D", "dddd", "ddd", "HH", "H", "hh", "h", "mm", "m", "ss", "s", "SSS", "A", "a" }
	local out, i = {}, 1
	while i <= #fmt do
		local c = string.sub(fmt, i, i)
		if c == "[" then
			local close = string.find(fmt, "]", i + 1, true)
			if close then
				table.insert(out, string.sub(fmt, i + 1, close - 1))
				i = close + 1
				continue
			end
		end
		local matched = false
		for _, token in order do
			if string.sub(fmt, i, i + #token - 1) == token then
				table.insert(out, tokens[token])
				i += #token
				matched = true
				break
			end
		end
		if not matched then
			table.insert(out, c)
			i += 1
		end
	end
	return table.concat(out)
end

DateTimeMeta = typed("DateTime", {
	ToUniversalTime = function(self)
		local p = parts(self)
		p.WeekDay = nil
		return p
	end,
	ToLocalTime = function(self)
		local p = parts(self)
		p.WeekDay = nil
		return p
	end,
	ToIsoDate = function(self)
		local p = parts(self)
		return string.format("%04d-%02d-%02dT%02d:%02d:%02dZ", p.Year, p.Month, p.Day, p.Hour, p.Minute, p.Second)
	end,
	FormatUniversalTime = function(self, fmt: string, _locale: string?)
		return format(self, fmt)
	end,
	FormatLocalTime = function(self, fmt: string, _locale: string?)
		return format(self, fmt)
	end,
	__eq = function(a, b)
		return a.UnixTimestampMillis == b.UnixTimestampMillis
	end,
	__lt = function(a, b)
		return a.UnixTimestampMillis < b.UnixTimestampMillis
	end,
	__le = function(a, b)
		return a.UnixTimestampMillis <= b.UnixTimestampMillis
	end,
	__tostring = function(self)
		return self:ToIsoDate()
	end,
})

function DateTime.now()
	return fromMillis(LuneDateTime.now().unixTimestampMillis)
end
function DateTime.fromUnixTimestamp(seconds: number)
	return fromMillis(seconds * 1000)
end
function DateTime.fromUnixTimestampMillis(ms: number)
	return fromMillis(ms)
end
local function fromValues(year, month, day, hour, minute, second, millisecond)
	return fromMillis(daysFromCivil(year, month or 1, day or 1) * 86400000 + (hour or 0) * 3600000 + (minute or 0) * 60000 + (second or 0) * 1000 + (millisecond or 0))
end
DateTime.fromUniversalTime = fromValues
DateTime.fromLocalTime = fromValues
function DateTime.fromIsoDate(text: string)
	local y, mo, d, h, mi, s = string.match(text, "^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)")
	if not y then
		return nil
	end
	local frac = string.match(text, "^%d+-%d+-%d+T%d+:%d+:%d+%.(%d+)")
	local ms = if frac then math.floor(tonumber("0." .. frac) * 1000) else 0
	local base = fromValues(tonumber(y), tonumber(mo), tonumber(d), tonumber(h), tonumber(mi), tonumber(s), ms).UnixTimestampMillis
	-- an offset (+03:00) moves it back to UTC; Z or none is UTC
	local sign, oh, om = string.match(text, "([%+%-])(%d%d):?(%d%d)$")
	if sign and not string.find(text, "Z$") then
		local offset = (tonumber(oh) * 60 + tonumber(om)) * 60000
		base -= if sign == "+" then offset else -offset
	end
	return fromMillis(base)
end

-- ---------------------------------------------------------------------------------------------
-- TweenInfo, RaycastParams, OverlapParams

return function(Enum, Vector3)
	local TweenInfoMeta = typed("TweenInfo")
	local TweenInfo = {}
	function TweenInfo.new(time, easingStyle, easingDirection, repeatCount, reverses, delayTime)
		return setmetatable({
			Time = time or 1,
			EasingStyle = easingStyle or Enum.EasingStyle.Quad,
			EasingDirection = easingDirection or Enum.EasingDirection.Out,
			RepeatCount = repeatCount or 0,
			Reverses = reverses or false,
			DelayTime = delayTime or 0,
		}, TweenInfoMeta)
	end

	local function params(name: string, defaults: () -> { [string]: any })
		local meta = typed(name, {
			AddToFilter = function(self, value)
				local list = table.clone(self.FilterDescendantsInstances)
				if typeof(value) == "Instance" then
					table.insert(list, value)
				else
					for _, item in value do
						table.insert(list, item)
					end
				end
				self.FilterDescendantsInstances = list
			end,
		})
		return {
			new = function()
				return setmetatable(defaults(), meta)
			end,
		}
	end
	local RaycastParams = params("RaycastParams", function()
		return {
			FilterDescendantsInstances = {},
			FilterType = Enum.RaycastFilterType.Exclude,
			IgnoreWater = false,
			CollisionGroup = "Default",
			RespectCanCollide = false,
			BruteForceAllSlow = false,
		}
	end)
	local OverlapParams = params("OverlapParams", function()
		return {
			FilterDescendantsInstances = {},
			FilterType = Enum.RaycastFilterType.Exclude,
			MaxParts = 0,
			CollisionGroup = "Default",
			RespectCanCollide = false,
			BruteForceAllSlow = false,
		}
	end)

	-- Random: xorshift32, seeded; the same seed gives the same numbers on every run
	local RandomMeta
	local Random = {}
	local function nextUint(self): number
		local x = self._state
		x = bit32.bxor(x, bit32.lshift(x, 13))
		x = bit32.bxor(x, bit32.rshift(x, 17))
		x = bit32.bxor(x, bit32.lshift(x, 5))
		self._state = x
		return x
	end
	local function unit(self): number
		-- 53 bits from two draws: [0, 1)
		local hi = nextUint(self) // 32 -- 27 bits
		local lo = nextUint(self) // 64 -- 26 bits
		return (hi * 67108864 + lo) / 9007199254740992
	end
	RandomMeta = typed("Random", {
		NextNumber = function(self, min, max)
			min, max = min or 0, max or 1
			return min + unit(self) * (max - min)
		end,
		NextInteger = function(self, min, max)
			assert(type(min) == "number" and type(max) == "number", "NextInteger expects two numbers")
			if max < min then
				error("invalid argument #2 to 'NextInteger' (interval is empty)", 2)
			end
			return min + math.floor(unit(self) * (max - min + 1))
		end,
		NextUnitVector = function(self)
			local z = unit(self) * 2 - 1
			local a = unit(self) * 2 * math.pi
			local r = math.sqrt(1 - z * z)
			return Vector3.new(r * math.cos(a), r * math.sin(a), z)
		end,
		Shuffle = function(self, list)
			for i = #list, 2, -1 do
				local j = 1 + math.floor(unit(self) * i)
				list[i], list[j] = list[j], list[i]
			end
		end,
		Clone = function(self)
			return setmetatable({ _state = self._state }, RandomMeta)
		end,
	})
	function Random.new(seed: number?)
		local s = seed or (os.clock() * 1e6 + LuneDateTime.now().unixTimestampMillis)
		local state = bit32.band(math.floor(math.abs(s)) % 4294967296, 0xFFFFFFFF)
		if state == 0 then
			state = 0x9E3779B9
		end
		return setmetatable({ _state = state }, RandomMeta)
	end

	return {
		DateTime = DateTime,
		TweenInfo = TweenInfo,
		RaycastParams = RaycastParams,
		OverlapParams = OverlapParams,
		Random = Random,
	}
end
