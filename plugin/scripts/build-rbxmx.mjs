// Builds the Quack plugin as a local plugin file, straight from plugin/sync, without a
// plugin dev place: node plugin/scripts/build-rbxmx.mjs [output.rbxmx]
// Default output: %LOCALAPPDATA%/Roblox/Plugins/Quack.rbxmx (Studio loads it from there).
//
// File rules (the same ones the daemon writes): X.server.luau = Script, X.client.luau =
// LocalScript, X.luau = ModuleScript, a folder X next to a script X holds that script's
// children, any other folder is a Folder.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOT = path.join(PLUGIN_DIR, "sync", "ReplicatedFirst");
const ROOT_SCRIPT = "QuackPlugin";

// --dev: a second plugin that lives next to the real one without touching it. Port 3826 (the
// development hub), its own saved-settings keys, its own toolbar and log prefix, its own file.
const DEV = process.argv.includes("--dev");
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const OUTPUT =
  positional[0] ??
  path.join(
    process.env.LOCALAPPDATA ?? "",
    "Roblox",
    "Plugins",
    DEV ? "QuackDev.rbxmx" : "Quack.rbxmx",
  );

const DEV_REPLACEMENTS = [
  ["localhost:3825", "localhost:3826"],
  ['"QUACK_SETTINGS"', '"QUACKDEV_SETTINGS"'],
  ['"QUACK_SETTINGS_SCOPE_BY_PLACE"', '"QUACKDEV_SETTINGS_SCOPE_BY_PLACE"'],
  ['"QUACK_SYNCED_PLACES"', '"QUACKDEV_SYNCED_PLACES"'],
  ['"QUACK_IGNORED_PLACES"', '"QUACKDEV_IGNORED_PLACES"'],
  ['Name = "Quack",', 'Name = "Quack Dev",'],
  ['Id = "Quack",', 'Id = "QuackDev",'],
  ["[Quack]", "[QuackDev]"],
  ["[Quack::", "[QuackDev::"],
  ["[🐛 Quack", "[🐛 QuackDev"],
  // Green where Official is yellow, as in the Dev app (app/ui/style.css html.dev): the toolbar Q
  // (decals 123091869089594 idle and 119947199784475 synced, EnderexDev, 22/10/26) and the brand
  ['UI.logo = "rbxassetid://79454901305076"', 'UI.logo = "rbxassetid://132862432873131"'],
  ['UI.syncedLogo = "rbxassetid://101555384706119"', 'UI.syncedLogo = "rbxassetid://86744950721031"'],
  ['Brand = Color3.fromHex("ffd41f"),', 'Brand = Color3.fromHex("5ee36a"),'],
  // The lockup's mark (logo-dev-mark.png, decal 128100074314929, 23/10/26) and the word's greens
  ['UI.mark = "rbxassetid://137540661809005"', 'UI.mark = "rbxassetid://124734565720834"'],
  ['UI.wordGradient = { "fff6c8", "ffcc1f", "b87400" }', 'UI.wordGradient = { "f0ffe8", "5ee36a", "1f8a3a" }'],
];
const devApplied = new Map(DEV_REPLACEMENTS.map(([from]) => [from, 0]));

function transform(source) {
  if (!DEV) return source;
  let out = source;
  for (const [from, to] of DEV_REPLACEMENTS) {
    const parts = out.split(from);
    devApplied.set(from, devApplied.get(from) + parts.length - 1);
    out = parts.join(to);
  }
  return out;
}

const SCRIPT_SUFFIXES = [
  [".server.luau", "Script"],
  [".client.luau", "LocalScript"],
  [".luau", "ModuleScript"],
];

let referent = 0;
let count = 0;

const escapeXml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cdata = (s) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

function scriptOf(fileName) {
  for (const [suffix, className] of SCRIPT_SUFFIXES) {
    if (fileName.endsWith(suffix)) {
      return { name: fileName.slice(0, -suffix.length), className };
    }
  }
  return null;
}

function item(className, name, extraProps, childrenXml) {
  count++;
  return [
    `<Item class="${className}" referent="RBX${referent++}">`,
    "<Properties>",
    `<string name="Name">${escapeXml(name)}</string>`,
    ...extraProps,
    "</Properties>",
    childrenXml,
    "</Item>",
  ].join("\n");
}

function childrenOf(dir) {
  if (!fs.existsSync(dir)) return "";
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const scripts = new Map();
  for (const e of entries) {
    if (!e.isFile()) continue;
    const s = scriptOf(e.name);
    if (!s) continue;
    // Two files naming the same instance (X.luau and X.server.luau): refuse, never drop one
    if (scripts.has(s.name)) {
      throw new Error(`${dir}: ${e.name} and another file both become "${s.name}"`);
    }
    scripts.set(s.name, { ...s, file: path.join(dir, e.name) });
  }
  const out = [];
  for (const s of [...scripts.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(scriptItem(s, path.join(dir, s.name)));
  }
  for (const e of entries) {
    if (!e.isDirectory() || scripts.has(e.name)) continue;
    out.push(item("Folder", e.name, [], childrenOf(path.join(dir, e.name))));
  }
  return out.join("\n");
}

function scriptItem(s, childDir, extraProps = []) {
  const source = transform(fs.readFileSync(s.file, "utf8"));
  return item(
    s.className,
    s.name,
    [`<ProtectedString name="Source">${cdata(source)}</ProtectedString>`, ...extraProps],
    childrenOf(childDir),
  );
}

const rootXml = scriptItem(
  {
    name: ROOT_SCRIPT,
    className: "Script",
    file: path.join(SOURCE_ROOT, `${ROOT_SCRIPT}.server.luau`),
  },
  path.join(SOURCE_ROOT, ROOT_SCRIPT),
  ['<token name="RunContext">3</token>'],
);

if (DEV) {
  // Every replacement must have landed, or the dev plugin could talk to the real port
  const missing = [...devApplied].filter(([, n]) => n === 0).map(([from]) => from);
  if (missing.length > 0) {
    console.error(`--dev replacements found nothing for: ${missing.join(", ")}; not writing ${OUTPUT}`);
    process.exit(1);
  }
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, `<roblox version="4">\n${rootXml}\n</roblox>\n`);
console.log(`${count} instances -> ${OUTPUT}${DEV ? ` (dev: ${[...devApplied].map(([f, n]) => `${f} x${n}`).join(", ")})` : ""}`);
