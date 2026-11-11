/**
 * The names a Roblox script reads without declaring: Luau's builtins, Roblox's globals and data
 * types. selene's roblox std (its 95 globals, read 10/11/26) less `io`, `package` and `arg`,
 * which Roblox does not have, plus the deprecated globals Roblox still runs (Wait, Spawn,
 * Delay, Game, Workspace, Version, ElapsedTime, stats, version, PluginManager, ypcall,
 * printidentity): selene calls
 * those undefined, but a script that reads one works (council review, 10/11/26). A class name
 * is not a global (`Part`).
 */
const BASE = [
  // Luau
  "_G", "_VERSION", "assert", "bit32", "buffer", "collectgarbage", "coroutine", "debug", "error", "gcinfo", "getfenv", "getmetatable",
  "ipairs", "loadstring", "math", "newproxy", "next", "os", "pairs", "pcall", "print", "rawequal", "rawget", "rawlen", "rawset", "require",
  "select", "setfenv", "setmetatable", "string", "table", "tonumber", "tostring", "type", "typeof", "unpack", "utf8", "vector", "xpcall",
  // Roblox
  "delay", "elapsedTime", "game", "plugin", "script", "settings", "shared", "spawn", "task", "tick", "time", "wait", "warn", "workspace",
  "DebuggerManager", "Instance", "UserSettings",
  // deprecated, still defined
  "Delay", "ElapsedTime", "Game", "PluginManager", "Spawn", "Version", "Wait", "Workspace", "stats", "version", "ypcall", "printidentity",
  // Roblox data types
  "Axes", "BrickColor", "CatalogSearchParams", "CFrame", "Color3", "ColorSequence", "ColorSequenceKeypoint", "Content", "DateTime",
  "DockWidgetPluginGuiInfo", "Enum", "Faces", "FloatCurveKey", "Font", "NumberRange", "NumberSequence",
  "NumberSequenceKeypoint", "OverlapParams", "Path2DControlPoint", "PathWaypoint", "PhysicalProperties", "Random", "Ray", "RaycastParams",
  "Rect", "Region3", "Region3int16", "RotationCurveKey", "SharedTable", "TweenInfo", "UDim", "UDim2", "Vector2", "Vector2int16", "Vector3",
  "Vector3int16",
];

export const GLOBALS: ReadonlySet<string> = new Set(BASE);

/** What TestEZ (Roblox's public test runner) defines in a `.spec` file */
export const TESTEZ_GLOBALS: ReadonlySet<string> = new Set([
  "describe", "it", "expect", "beforeAll", "afterAll", "beforeEach", "afterEach", "FOCUS", "SKIP", "describeFOCUS", "describeSKIP",
  "fdescribe", "xdescribe", "itFOCUS", "itSKIP", "itFIXME", "fit", "xit",
]);

/**
 * How many arguments each standard library function takes: [min, max] (max Infinity for a
 * vararg). Only the global itself is checked (a local `math` is the script's own). From Luau's
 * library reference; a call whose last argument is a call or `...` passes an unknown count, so
 * only its known part is checked against the max.
 */
export const STD_ARGS: Record<string, [number, number]> = {
  assert: [1, Infinity], error: [0, 2], getmetatable: [1, 1], ipairs: [1, 1], next: [1, 2], pairs: [1, 1], pcall: [1, Infinity],
  print: [0, Infinity], rawequal: [2, 2], rawget: [2, 2], rawlen: [1, 1], rawset: [3, 3], require: [1, 1], select: [1, Infinity],
  setmetatable: [2, 2], tonumber: [1, 2], tostring: [1, 1], type: [1, 1], typeof: [1, 1], unpack: [1, 3], xpcall: [2, Infinity],
  tick: [0, 0], time: [0, 0], warn: [0, Infinity],
  "math.abs": [1, 1], "math.acos": [1, 1], "math.asin": [1, 1], "math.atan": [1, 1], "math.atan2": [2, 2], "math.ceil": [1, 1],
  "math.clamp": [3, 3], "math.cos": [1, 1], "math.cosh": [1, 1], "math.deg": [1, 1], "math.exp": [1, 1], "math.floor": [1, 1],
  "math.fmod": [2, 2], "math.frexp": [1, 1], "math.ldexp": [2, 2], "math.lerp": [3, 3], "math.log": [1, 2], "math.log10": [1, 1],
  "math.map": [5, 5], "math.max": [1, Infinity], "math.min": [1, Infinity], "math.modf": [1, 1], "math.noise": [1, 3], "math.pow": [2, 2],
  "math.rad": [1, 1], "math.random": [0, 2], "math.randomseed": [1, 1], "math.round": [1, 1], "math.sign": [1, 1], "math.sin": [1, 1],
  "math.sinh": [1, 1], "math.sqrt": [1, 1], "math.tan": [1, 1], "math.tanh": [1, 1], "math.isnan": [1, 1], "math.isinf": [1, 1],
  "math.isfinite": [1, 1],
  "string.byte": [1, 3], "string.char": [0, Infinity], "string.find": [2, 4], "string.format": [1, Infinity], "string.gmatch": [2, 2],
  "string.gsub": [3, 4], "string.len": [1, 1], "string.lower": [1, 1], "string.match": [2, 3], "string.pack": [1, Infinity],
  "string.packsize": [1, 1], "string.rep": [2, 3], "string.reverse": [1, 1], "string.split": [1, 2], "string.sub": [2, 3],
  "string.unpack": [2, 3], "string.upper": [1, 1],
  "table.clear": [1, 1], "table.clone": [1, 1], "table.concat": [1, 4], "table.create": [1, 2], "table.find": [2, 3], "table.freeze": [1, 1],
  "table.insert": [2, 3], "table.isfrozen": [1, 1], "table.maxn": [1, 1], "table.move": [4, 5], "table.pack": [0, Infinity],
  "table.remove": [1, 2], "table.sort": [1, 2], "table.unpack": [1, 3], "table.foreach": [2, 2], "table.foreachi": [2, 2], "table.getn": [1, 1],
  "coroutine.close": [1, 1], "coroutine.create": [1, 1], "coroutine.isyieldable": [0, 0], "coroutine.resume": [1, Infinity],
  "coroutine.running": [0, 0], "coroutine.status": [1, 1], "coroutine.wrap": [1, 1], "coroutine.yield": [0, Infinity],
  "bit32.arshift": [2, 2], "bit32.band": [0, Infinity], "bit32.bnot": [1, 1], "bit32.bor": [0, Infinity], "bit32.btest": [0, Infinity],
  "bit32.bxor": [0, Infinity], "bit32.byteswap": [1, 1], "bit32.countlz": [1, 1], "bit32.countrz": [1, 1], "bit32.extract": [2, 3],
  "bit32.lrotate": [2, 2], "bit32.lshift": [2, 2], "bit32.replace": [3, 4], "bit32.rrotate": [2, 2], "bit32.rshift": [2, 2],
  "utf8.char": [0, Infinity], "utf8.codepoint": [1, 3], "utf8.codes": [1, 1], "utf8.len": [1, 3], "utf8.offset": [2, 3],
  "os.clock": [0, 0], "os.date": [0, 2], "os.difftime": [1, 2], "os.time": [0, 1],
  "task.cancel": [1, 1], "task.defer": [1, Infinity], "task.delay": [2, Infinity], "task.spawn": [1, Infinity], "task.wait": [0, 1],
  "task.synchronize": [0, 0], "task.desynchronize": [0, 0],
  "buffer.create": [1, 1], "buffer.fromstring": [1, 1], "buffer.tostring": [1, 1], "buffer.len": [1, 1], "buffer.copy": [3, 5], "buffer.fill": [3, 4],
  "buffer.readi8": [2, 2], "buffer.readu8": [2, 2], "buffer.readi16": [2, 2], "buffer.readu16": [2, 2], "buffer.readi32": [2, 2],
  "buffer.readu32": [2, 2], "buffer.readf32": [2, 2], "buffer.readf64": [2, 2], "buffer.writei8": [3, 3], "buffer.writeu8": [3, 3],
  "buffer.writei16": [3, 3], "buffer.writeu16": [3, 3], "buffer.writei32": [3, 3], "buffer.writeu32": [3, 3], "buffer.writef32": [3, 3],
  "buffer.writef64": [3, 3], "buffer.readstring": [3, 3], "buffer.writestring": [3, 4],
};
