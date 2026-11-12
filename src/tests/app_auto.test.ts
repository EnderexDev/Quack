import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The app's side of what runs on its own (12/11/26): the Analysis tab of each game, the settings
// of the four features, and the notification of a new production error

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
const read = (...parts: string[]) => fs.readFileSync(path.join(app, ...parts), "utf8");

function keysOf(language: "en" | "pt"): Set<string> {
  const text = read("ui", "i18n.js");
  const start = text.indexOf(`  ${language}: {`);
  const end = language === "en" ? text.indexOf("  pt: {") : text.indexOf("\n};", start);
  return new Set([...text.slice(start, end).matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]));
}

test("app: each game has an Analysis tab with the findings panel, the new production errors and its own settings", () => {
  const html = read("ui", "index.html");
  const main = read("ui", "main.js");
  assert.match(html, /data-view="analysis"[^>]*>.*id="analysisBadge"/, "the tab, with a count");
  assert.match(main, /if \(ui\.view === "analysis"\) return renderAnalysis\(target\)/);
  for (const call of ["/api/analysis?placeId=", "/api/production-errors?placeId=", "\"/api/analysis/run\"", "\"/api/production-errors/dismiss\"", "\"/api/production-errors/check\"", "\"/api/automation\""]) {
    assert.ok(main.includes(call), `the window calls ${call}`);
  }
  // the badge counts the panel's findings and the errors not dismissed, from /api/state
  assert.match(main, /\(place\?\.findings \?\? 0\) \+ \(place\?\.newErrors \?\? 0\)/);
  // the four features in Settings (for every game) and in the tab (for that game)
  assert.match(main, /const AUTO_FEATURES = \["review", "panel", "errors", "precommit"\]/);
  assert.match(main, /automationCard\(automation\)/);
  assert.match(main, /autoRows\(view, placeId\)/);
  // its poll stops with the view
  assert.match(main.slice(main.indexOf("function stopContent()"), main.indexOf("function stopContent()") + 200), /clearInterval\(analysisTimer\)/);
  // a folder connected before the review hook existed needs connecting again
  assert.match(main, /c\.reviewed === false/);
});

test("app: every string of the Analysis tab and the automation settings is in English and Portuguese", () => {
  const main = read("ui", "main.js");
  const en = keysOf("en");
  const pt = keysOf("pt");
  const used = new Set([...main.matchAll(/\bt\("((?:analysis|errors|auto)\w*)"/g)].map((m) => m[1]));
  for (const f of ["review", "panel", "errors", "precommit"]) used.add(`auto_${f}`).add(`auto_${f}_hint`);
  assert.ok(used.size >= 25, `${used.size} keys`);
  for (const key of used) {
    assert.ok(en.has(key), `${key} in English`);
    assert.ok(pt.has(key), `${key} in Portuguese`);
  }
});

test("app: a new production error is a notification of its own, with its file and line; a key that cannot read is told once", () => {
  const rust = read("src-tauri", "src", "main.rs");
  const loop = rust.slice(rust.indexOf("fn poll_loop("), rust.indexOf("fn sleep_until_own_hub_exits("));
  assert.match(loop, /place\["newErrors"\]\.as_u64\(\)/);
  assert.match(loop, /latest\["at"\]/);
  assert.match(loop, /if count > \*before\.get\(&id\)\.unwrap_or\(&0\)/, "only when the count goes up");
  assert.match(loop, /place\["errorsProblem"\]\.is_string\(\)/);
  assert.match(loop, /!known_problems\.contains\(&id\)/, "a problem already told is not told again");
  // not behind the conflicts' notify switch: the feature's own setting turns it on
  const block = loop.slice(loop.indexOf("let mut errors_now"), loop.indexOf("known_problems = problems_now"));
  assert.doesNotMatch(block, /\bnotify &&/);
});
