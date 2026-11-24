--!nocheck
-- Quack Test: expect(value).toBe(other), Jest's style, with .never to negate any matcher. The
-- matchers are LuneTest 0.1.4's (MIT, Austin Barikdar; see NOTICE.md), so its specs run here
-- unchanged, plus the >= and <= pair. A failed matcher raises a failure the runner reports as
-- "failed" (the code was wrong), never as "did not run".

return function(ctx)
	local function show(value: any, depth: number?): string
		if type(value) == "string" then
			return string.format("%q", value)
		end
		if type(value) ~= "table" then
			return `{tostring(value)} ({ctx.typeof(value)})`
		end
		if (depth or 0) >= 2 then
			return "{...}"
		end
		local parts = {}
		for key, child in value do
			table.insert(parts, `[{show(key, 2)}] = {show(child, (depth or 0) + 1)}`)
		end
		table.sort(parts)
		return `\{ {table.concat(parts, ", ")} }`
	end

	local function deepEqual(a: any, b: any): boolean
		if a == b then
			return true
		end
		if type(a) ~= "table" or type(b) ~= "table" then
			return false
		end
		for key, value in a do
			if not deepEqual(value, b[key]) then
				return false
			end
		end
		for key in b do
			if a[key] == nil then
				return false
			end
		end
		return true
	end

	local function matchers(value: any, negated: boolean)
		local function check(pass: boolean, message: string)
			if pass == negated then
				ctx.failExpect(if negated then `expected not: {message}` else `expected {message}`)
			end
		end
		local function number(name: string, expected: any)
			if type(expected) ~= "number" then
				ctx.failExpect(`{name} expects a number, got {show(expected)}`)
			end
		end
		return {
			toBe = function(expected)
				check(value == expected, `{show(value)} to be {show(expected)}`)
			end,
			toEqual = function(expected)
				check(deepEqual(value, expected), `{show(value)} to deep-equal {show(expected)}`)
			end,
			toBeTruthy = function()
				check(not not value, `{show(value)} to be truthy`)
			end,
			toBeFalsy = function()
				check(not value, `{show(value)} to be falsy`)
			end,
			toBeNil = function()
				check(value == nil, `{show(value)} to be nil`)
			end,
			toBeA = function(typeName)
				check(ctx.typeof(value) == typeName, `{show(value)} to be a {typeName}`)
			end,
			toBeCloseTo = function(expected, epsilon)
				number("toBeCloseTo", expected)
				check(type(value) == "number" and math.abs(value - expected) <= (epsilon or 1e-3), `{show(value)} to be within {epsilon or 1e-3} of {expected}`)
			end,
			toBeGreaterThan = function(expected)
				number("toBeGreaterThan", expected)
				check(type(value) == "number" and value > expected, `{show(value)} to be > {expected}`)
			end,
			toBeGreaterThanOrEqual = function(expected)
				number("toBeGreaterThanOrEqual", expected)
				check(type(value) == "number" and value >= expected, `{show(value)} to be >= {expected}`)
			end,
			toBeLessThan = function(expected)
				number("toBeLessThan", expected)
				check(type(value) == "number" and value < expected, `{show(value)} to be < {expected}`)
			end,
			toBeLessThanOrEqual = function(expected)
				number("toBeLessThanOrEqual", expected)
				check(type(value) == "number" and value <= expected, `{show(value)} to be <= {expected}`)
			end,
			toContain = function(item)
				local found = false
				if type(value) == "string" then
					found = string.find(value, tostring(item), 1, true) ~= nil
				elseif type(value) == "table" then
					found = table.find(value, item) ~= nil
				end
				check(found, `{show(value)} to contain {show(item)}`)
			end,
			toThrow = function(substring)
				if type(value) ~= "function" then
					ctx.failExpect("toThrow expects a function")
				end
				local ok, err = pcall(value)
				local text = if ok then nil else ctx.message(err)
				local matches = not ok and (substring == nil or string.find(text, substring, 1, true) ~= nil)
				check(matches, if substring then `function to throw containing {show(substring)}, got {if ok then "no error" else show(text)}` else "function to throw")
			end,
		}
	end

	return function(value: any)
		local expectation = matchers(value, false)
		expectation.never = matchers(value, true)
		return expectation
	end
end
