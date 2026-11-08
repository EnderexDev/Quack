/**
 * The `ctx` every job phase gets, prepended to the job's code in each phase's eval, on the server
 * and on the client alike. A phase is one eval: the job's file is compiled again each time and
 * only the phase's function runs, so the phases share nothing but `ctx.state` (server phases,
 * through `shared`) and `ctx.client` (what the client phase returned, given to `check`).
 *
 * What the runner reads back is the JSON string this returns: ok, error, value (for the report),
 * payload (the return value as JSON, so ctx.client keeps its type), checks.
 *
 * The members of ctx are a contract with every job already written: check, expect, waitFor, log,
 * state, client, player, checks. A tool that checks a job before submitting it reads them here.
 */
export const PRELUDE = `local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local function __describe(value)
	if type(value) == "table" then
		local ok, json = pcall(HttpService.JSONEncode, HttpService, value)
		return ok and json or tostring(value)
	end
	return tostring(value)
end

local function __makeCtx(jobId, clientPayload)
	local checks = {}
	local ctx = { checks = checks }
	if clientPayload ~= nil then
		local ok, decoded = pcall(HttpService.JSONDecode, HttpService, clientPayload)
		if ok and type(decoded) == "table" then
			ctx.client = decoded.v
		end
	end

	if RunService:IsServer() then
		shared.__studioTest = shared.__studioTest or {}
		shared.__studioTest[jobId] = shared.__studioTest[jobId] or {}
		ctx.state = shared.__studioTest[jobId]
		ctx.player = Players:GetPlayers()[1]
	else
		ctx.state = {}
		ctx.player = Players.LocalPlayer
	end

	-- A named check. Never throws: every check runs and lands in the report.
	function ctx.check(condition, label, detail)
		table.insert(checks, { label = tostring(label or "check"), ok = condition and true or false, detail = detail ~= nil and __describe(detail) or nil })
		return condition and true or false
	end

	-- Numbers within a relative 1e-6 are equal: a float32 attribute reads 0.05 back as
	-- 0.05000000074505806. Everything else compares exactly.
	function ctx.expect(actual, expected, label)
		local ok = actual == expected
		-- Finite numbers only: math.huge against anything would pass the relative test
		if not ok and type(actual) == "number" and type(expected) == "number" and math.abs(actual) ~= math.huge and math.abs(expected) ~= math.huge then
			ok = math.abs(actual - expected) <= 1e-6 * math.max(math.abs(actual), math.abs(expected))
		end
		table.insert(checks, { label = tostring(label or "expect"), ok = ok, actual = __describe(actual), expected = __describe(expected) })
		return ok
	end

	-- Waits until fn() is truthy (or \`timeout\` seconds pass) and returns its last value.
	function ctx.waitFor(fn, timeout)
		local deadline = os.clock() + (timeout or 5)
		local value = fn()
		while not value and os.clock() < deadline do
			task.wait(0.05)
			value = fn()
		end
		return value
	end

	function ctx.log(...)
		local parts = {}
		for i = 1, select("#", ...) do
			parts[i] = __describe((select(i, ...)))
		end
		print("[studio-test] " .. table.concat(parts, " "))
	end

	return ctx
end

local function __forget(jobId)
	if RunService:IsServer() and shared.__studioTest then
		shared.__studioTest[jobId] = nil
	end
end

local function __run(job, phase, jobId, clientPayload)
	if type(job) ~= "table" then
		if phase == "cleanup" then
			__forget(jobId)
		end
		return HttpService:JSONEncode({ ok = false, error = "the job file must return a table" })
	end
	local fn = job[phase]
	if fn == nil then
		if phase == "cleanup" then
			__forget(jobId) -- no cleanup function: the job's state still goes
		end
		return HttpService:JSONEncode({ skipped = true })
	end
	local ctx = __makeCtx(jobId, clientPayload)
	local ok, result = xpcall(fn, debug.traceback, ctx)
	if phase == "cleanup" then
		__forget(jobId)
	end
	local payload = nil
	if ok and result ~= nil then
		local encoded, json = pcall(HttpService.JSONEncode, HttpService, { v = result })
		payload = encoded and json or nil
	end
	return HttpService:JSONEncode({
		ok = ok,
		error = (not ok) and tostring(result) or nil,
		value = (ok and result ~= nil) and __describe(result) or nil,
		payload = payload,
		checks = ctx.checks,
	})
end
`;

/** A Luau long string holding `text` verbatim, whatever brackets it holds (the newline after the opening bracket is dropped by Luau) */
export function luaString(text: string): string {
  let level = 0;
  // A text ending in "]" (plus the level's "=") would close early against the closing bracket
  while (text.includes(`]${"=".repeat(level)}]`) || text.endsWith(`]${"=".repeat(level)}`)) level++;
  const eq = "=".repeat(level);
  return `[${eq}[\n${text}]${eq}]`;
}

/** One phase of a job as one eval: ctx, the job's chunk, and the phase run */
export function phaseCode(source: string, phase: string, jobId: string, clientPayload: string | null): string {
  const value = clientPayload == null ? "nil" : luaString(clientPayload);
  return `${PRELUDE}\nlocal __job = (function()\n${source}\nend)()\nreturn __run(__job, ${JSON.stringify(phase)}, ${JSON.stringify(jobId)}, ${value})`;
}
