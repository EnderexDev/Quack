import path from "node:path";
import { childNamed, type GameTree, type TreeNode } from "./tree.js";

/**
 * `quack probe <place>`: a robot in a play already running in a test place. It requires every
 * module the server and the client can reach, presses every button a player could press (and
 * the ones the windows it opens bring), and reports each error the game raised meanwhile, with
 * its file and line. It changes the play's state as a player would (it buys, it opens, it
 * resets): never on a place whose play touches real data, and it never starts a play itself.
 *
 * The errors come from a collector put on ScriptContext.Error in each peer (message, stack and
 * the script), tagged with what the robot was doing; an error already repeating before the robot
 * started is left out. A module that fails on one side and loads on the other is written for
 * that side, not broken: its errors there are left out too.
 */

/** The table the collector keeps in each peer, in `shared` (one per Luau VM: the play server, the play client) */
const KEY = "__quackProbe";

/** Luau: put (again) the error collector in this peer */
export function installCode(): string {
  return `local state = shared.${KEY}
if state and state.conn then state.conn:Disconnect() end
state = { errors = {}, tag = "before", dropped = 0 }
state.conn = game:GetService("ScriptContext").Error:Connect(function(message, trace, script)
	if #state.errors >= 2000 then
		state.dropped += 1
		return
	end
	table.insert(state.errors, { m = tostring(message), t = tostring(trace), s = if script then script:GetFullName() else "", g = state.tag })
end)
shared.${KEY} = state
return "installed"`;
}

/** Luau: the errors collected since the last read (cleared), and the tag the next ones get */
export function readCode(nextTag: string): string {
  return `local state = shared.${KEY}
if not state then return game:GetService("HttpService"):JSONEncode({ missing = true }) end
local errors, dropped = state.errors, state.dropped
state.errors, state.dropped = {}, 0
state.tag = ${luauString(nextTag)}
return game:GetService("HttpService"):JSONEncode({ errors = errors, dropped = dropped })`;
}

/** Luau: take the collector away */
export function removeCode(): string {
  return `local state = shared.${KEY}
if state and state.conn then state.conn:Disconnect() end
shared.${KEY} = nil
return "removed"`;
}

/**
 * Luau: require every ModuleScript this peer can reach, one at a time, each error tagged with
 * the module. A require that has not returned in `wait` seconds is left running (cancelling it
 * could leave the module half loaded) and reported as not returned. Wally's _Index is skipped:
 * its modules are reached through the packages' link modules
 */
export function requireCode(side: "server" | "client", wait: number, budget: number): string {
  const roots = side === "server"
    ? `{ game:GetService("ServerScriptService"), game:GetService("ServerStorage"), game:GetService("ReplicatedStorage"), game:GetService("ReplicatedFirst"), workspace }`
    : `{ game:GetService("ReplicatedStorage"), game:GetService("ReplicatedFirst"), game:GetService("Players").LocalPlayer, game:GetService("Players").LocalPlayer.Character }`;
  return `local state = shared.${KEY}
local out = {}
local started = os.clock()
for _, root in ${roots} do
	if out[#out] and out[#out].r == "budget" then break end
	if not root then continue end
	for _, m in root:GetDescendants() do
		if not m:IsA("ModuleScript") or m:FindFirstAncestor("_Index") then continue end
		if os.clock() - started > ${budget} then
			table.insert(out, { p = "", r = "budget" })
			break
		end
		local name = m:GetFullName()
		if state then state.tag = "require " .. name end
		local done, ok, why = false, false, nil
		task.spawn(function()
			ok, why = pcall(require, m)
			done = true
		end)
		local t = os.clock()
		while not done and os.clock() - t < ${wait} do
			task.wait()
		end
		-- ScriptContext.Error fires deferred: one frame, so the errors of this require come under its tag
		task.wait()
		table.insert(out, { p = name, r = if not done then "wait" elseif ok then "ok" else "error", e = if done and not ok then tostring(why) else nil })
	end
end
if state then state.tag = "after requires" end
return game:GetService("HttpService"):JSONEncode(out)`;
}

/**
 * Luau (client): the buttons a player could press now, as paths from PlayerGui: visible all the
 * way up, in an enabled ScreenGui, with a size, on screen, and the front object at their center.
 * A button that is not the first child with its name at some level is left out: the path would
 * reach the other one
 */
export function buttonsCode(): string {
  return `local Players = game:GetService("Players")
local playerGui = Players.LocalPlayer:FindFirstChildOfClass("PlayerGui")
if not playerGui then return "[]" end
local camera = workspace.CurrentCamera
local view = if camera then camera.ViewportSize else Vector2.zero
local out = {}
local function shown(o)
	local x = o
	while x and x ~= playerGui do
		if x:IsA("GuiObject") and not x.Visible then return false end
		if x:IsA("LayerCollector") and not x.Enabled then return false end
		x = x.Parent
	end
	return x == playerGui
end
local function pathOf(o)
	local parts = {}
	local x = o
	while x and x ~= playerGui do
		local parent = x.Parent
		-- the click tool walks the path child by child, each the first with its name
		if parent:FindFirstChild(x.Name) ~= x or string.find(x.Name, ".", 1, true) then return nil end
		table.insert(parts, 1, x.Name)
		x = parent
	end
	return "PlayerGui." .. table.concat(parts, ".")
end
for _, b in playerGui:GetDescendants() do
	if not b:IsA("GuiButton") or not b.Active or b.AbsoluteSize.X <= 0 or b.AbsoluteSize.Y <= 0 then continue end
	local layer = b:FindFirstAncestorWhichIsA("ScreenGui")
	if not layer or not shown(b) then continue end
	local c = b.AbsolutePosition + b.AbsoluteSize / 2
	if c.X < 0 or c.Y < 0 or c.X > view.X or c.Y > view.Y then continue end
	-- front to back: the first button or text box takes the click (a frame in front does not, as the click tool measured)
	local reached = false
	for _, o in playerGui:GetGuiObjectsAtPosition(c.X, c.Y) do
		if o == b then
			reached = true
			break
		end
		if o:IsA("GuiButton") or o:IsA("TextBox") then break end
	end
	if not reached then continue end
	local p = pathOf(b)
	if p then table.insert(out, p) end
end
return game:GetService("HttpService"):JSONEncode(out)`;
}

function luauString(s: string): string {
  let level = "";
  // the text's own last "]" followed by the closing one would close it early
  while (`${s}]`.includes(`]${level}]`)) level += "=";
  return `[${level}[${s}]${level}]`;
}

export interface CollectedError {
  /** The message as the game raised it */
  m: string;
  /** The stack */
  t: string;
  /** The script that raised it (its full name) */
  s: string;
  /** What the robot was doing: "require <path>", "click <path>", "before" */
  g: string;
}

export interface ProbeError {
  side: "server" | "client";
  message: string;
  /** The script file, when the path maps to one in the tree */
  file?: string;
  line?: number;
  /** The instance path the error names, when it maps to no file */
  where?: string;
  /** What the robot was doing when it came */
  during: string;
  count: number;
}

/**
 * The script a run-time path names, in the place's tree: PlayerGui's copies are StarterGui's,
 * PlayerScripts' are StarterPlayerScripts', the character's are StarterCharacterScripts', the
 * Backpack's are StarterPack's. Names with dots are matched greedily against the tree's children
 */
export function nodeForPath(tree: GameTree, full: string): TreeNode | null {
  const parts = full.split(".");
  let start: TreeNode | undefined;
  let rest: string[] = parts;
  const service = (name: string) => childNamed(tree.root, name);
  if (parts[0] === "Players" && parts.length >= 3) {
    const where = parts[2];
    const starterPlayer = service("StarterPlayer");
    if (where === "PlayerGui") start = service("StarterGui");
    else if (where === "PlayerScripts") start = starterPlayer && childNamed(starterPlayer, "StarterPlayerScripts");
    else if (where === "Backpack") start = service("StarterPack");
    rest = parts.slice(3);
  } else if (parts[0] === "Workspace" && parts.length >= 3 && !(service("Workspace") && childNamed(service("Workspace")!, parts[1]))) {
    // a character: Workspace.<player name>.<script>
    const starterPlayer = service("StarterPlayer");
    start = starterPlayer && childNamed(starterPlayer, "StarterCharacterScripts");
    rest = parts.slice(2);
  } else {
    start = service(parts[0]);
    rest = parts.slice(1);
  }
  if (!start) return null;
  let node: TreeNode = start;
  let i = 0;
  while (i < rest.length) {
    let found: TreeNode | undefined;
    let used = 0;
    // the longest name first: "Pet.Data" may be one instance
    for (let j = rest.length; j > i && !found; j--) {
      const name = rest.slice(i, j).join(".");
      const c = childNamed(node, name);
      if (c) [found, used] = [c, j - i];
    }
    if (!found) return null;
    node = found;
    i += used;
  }
  return node;
}

/** `Path.To.Script:12: message`, or the first `Path, line 12` of a stack */
export function errorPlace(e: CollectedError): { path: string; line: number } | null {
  const m = /^(.+?):(\d+): /.exec(e.m);
  if (m) return { path: m[1], line: Number(m[2]) };
  // the play's stack (`Path, line 12 - function f`), or the live game's (`Script 'Path', Line 109`)
  // one frame per line: a native frame with no comma before it never joins the path
  const s = /^[ \t]*(?:Script '([^'\n]+)'|([^\s,'][^,\n]*?)), [Ll]ine (\d+)/m.exec(e.t);
  return s ? { path: s[1] ?? s[2], line: Number(s[3]) } : null;
}

/** An error's identity across repeats: where it came from and its message with numbers taken out */
export function signature(side: string, e: CollectedError): string {
  const m = /^(.+?:\d+: )([\s\S]*)$/.exec(e.m);
  const [where, body] = m ? [m[1], m[2]] : ["", e.m];
  return `${side}|${where}${body.replace(/\d+(\.\d+)?/g, "#")}`;
}

/**
 * The report: errors not already repeating before the robot started, without the ones a
 * side-specific module raised on the side it was not written for, grouped by signature
 */
export function probeErrors(
  tree: GameTree,
  collected: { side: "server" | "client"; errors: CollectedError[] }[],
  baseline: Set<string>,
  sideSpecific: Set<string>,
): ProbeError[] {
  const out = new Map<string, ProbeError>();
  for (const { side, errors } of collected) {
    for (const e of errors) {
      const sig = signature(side, e);
      if (baseline.has(sig)) continue;
      if (e.g.startsWith("require ") && sideSpecific.has(`${side}|${e.g.slice(8)}`)) continue;
      // raised later (a thread the module started) by a side-specific module or one inside it
      const place = errorPlace(e);
      const from = place?.path ?? e.s;
      if (from && from.split(".").some((_, i, parts) => sideSpecific.has(`${side}|${parts.slice(0, i + 1).join(".")}`))) continue;
      const known = out.get(sig);
      if (known) {
        known.count++;
        continue;
      }
      const node = place ? nodeForPath(tree, place.path) : null;
      out.set(sig, {
        side,
        message: e.m,
        ...(node?.file ? { file: node.file, line: place!.line } : place ? { where: `${place.path}:${place.line}` } : {}),
        during: e.g,
        count: 1,
      });
    }
  }
  return [...out.values()].sort((a, b) => (a.file ?? a.where ?? "").localeCompare(b.file ?? b.where ?? "") || (a.line ?? 0) - (b.line ?? 0));
}

/** One line an error: where, which side, the message, and what the robot was doing */
export function probeErrorLine(e: ProbeError, root: string): string {
  const where = e.file ? `${path.relative(root, e.file).replace(/\\/g, "/")}:${e.line}` : e.where ?? "(no script)";
  const message = e.message.replace(/^.+?:\d+: /, "").split("\n")[0];
  return `${where}  ${e.side}  ${message}  (${e.during}${e.count > 1 ? `, x${e.count}` : ""})`;
}
