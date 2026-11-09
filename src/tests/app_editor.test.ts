import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
const read = (...parts: string[]) => fs.readFileSync(path.join(app, ...parts), "utf8");

/** The keys of one language's block in i18n.js */
function keysOf(language: "en" | "pt"): Set<string> {
  const text = read("ui", "i18n.js");
  const start = text.indexOf(`  ${language}: {`);
  const end = language === "en" ? text.indexOf("  pt: {") : text.indexOf("\n};", start);
  return new Set([...text.slice(start, end).matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]));
}

test("app: no button is tied to VS Code; each one opens the editor the app found or the user picked", () => {
  const main = read("ui", "main.js");
  const html = read("ui", "index.html");
  for (const [name, text] of [["main.js", main], ["index.html", html], ["i18n.js", read("ui", "i18n.js")]]) {
    assert.doesNotMatch(text, /openVsc|VS Code"/, `${name} still names VS Code`);
  }
  // Every "open in an editor" goes through the one button with the list beside it
  const from = main.indexOf("function editorButtons(");
  const to = main.indexOf("\nfunction ", main.indexOf("function editorMenu("));
  const direct = [...main.matchAll(/invoke\("open_path", \{ path(?::\s*[\w.]+)?, editor: true \}\)/g)].map((m) => m.index);
  assert.equal(direct.length, 2, "the button and a pick in its list");
  assert.ok(direct.every((at) => at > from && at < to), "only editorButtons and its list open an editor");
  assert.equal([...main.matchAll(/editorButtons\(/g)].length, 4, "nav, Folder tab, conflict view, and its definition");
  // The app answers both calls the window makes
  const rust = read("src-tauri", "src", "main.rs");
  assert.match(rust, /generate_handler!\[[^\]]*\beditors,/s);
  assert.match(rust, /fn set_settings\([^)]*editor: Option<String>/);
});

test("app: the editor choice has every string in English and Portuguese", () => {
  const main = read("ui", "main.js");
  const used = ["openIn", "otherEditor", "openWith", "noEditor", "editorSetting", "editorAuto", "editorHint"];
  for (const key of used) assert.match(main, new RegExp(`t\\("${key}"`), `${key} is not used`);
  for (const language of ["en", "pt"] as const) {
    const keys = keysOf(language);
    const missing = used.filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `${language} is missing ${missing.join(", ")}`);
  }
});
