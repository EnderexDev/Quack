import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
const read = (p: string) => fs.readFileSync(path.join(app, p), "utf8");

// 22/10/26: the background check runs every 6 hours, so a release published right after the app
// opened only showed after a restart. Settings has a button that checks now.
test("Settings can check for an update now", () => {
  const main = read("src-tauri/src/main.rs");
  assert.match(main, /#\[tauri::command\]\r?\nasync fn check_update\(/);
  const handlers = main.slice(main.indexOf("generate_handler!["), main.indexOf("])", main.indexOf("generate_handler![")));
  assert.match(handlers, /\bcheck_update,/, "check_update is registered as a command");

  const ui = read("ui/main.js");
  const settings = ui.slice(ui.indexOf("async function renderSettings("), ui.indexOf("// ---------- Navigation"));
  assert.match(settings, /invoke\("check_update"\)/);
  assert.match(settings, /t\("checkUpdate"\)/);
});

test("every language has the update check's texts", async () => {
  const i18n = read("ui/i18n.js");
  for (const key of ["checkUpdate", "checkingUpdate", "upToDate"]) {
    assert.equal([...i18n.matchAll(new RegExp(`\\n\\s+${key}: "`, "g"))].length, 2, key);
  }
  assert.equal([...i18n.matchAll(/upToDate: "[^"]*\{version\}/g)].length, 2, "upToDate names the version");
});

// 08/11/26: a Dev update after a one-line change took 116 s, nearly all of it fat LTO over the
// whole program. Dev builds skip it (21 s); Official keeps Cargo.toml's release profile.
test("Dev updates build without LTO, Official keeps the release profile", () => {
  const publish = read("scripts/publish-dev-update.mjs");
  assert.match(publish, /CARGO_PROFILE_RELEASE_LTO: "false"/);
  assert.match(publish, /CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16"/);
  const env = publish.slice(publish.indexOf("const env = {"), publish.indexOf("};", publish.indexOf("const env = {")));
  assert.match(env, /\.\.\.DEV_PROFILE_ENV,/, "the build's env carries the Dev profile");

  const cargo = read("src-tauri/Cargo.toml");
  const release = cargo.slice(cargo.indexOf("[profile.release]"));
  assert.match(release, /^lto = true$/m, "Official still builds with LTO");
  assert.match(release, /^codegen-units = 1$/m);
});

// 09/11/26: the rule an AI keeps in its instructions file, copied from the app and pasted to the AI,
// which puts it in place or swaps an older copy. The app runs the shipped `rule --prompt`.
test("Settings copies the rule for AI from the shipped command", () => {
  const main = read("src-tauri/src/main.rs");
  assert.match(main, /#\[tauri::command\]\r?\nasync fn ai_rule\(/);
  assert.match(main, /"rule", "--prompt", "--json"/);
  const handlers = main.slice(main.indexOf("generate_handler!["), main.indexOf("])", main.indexOf("generate_handler![")));
  assert.match(handlers, /\bai_rule,/, "ai_rule is registered as a command");

  const ui = read("ui/main.js");
  const card = ui.slice(ui.indexOf("function mcpCard("), ui.indexOf("async function renderSettings("));
  assert.match(card, /ruleButton\(\)/);
  assert.match(card, /invoke\("ai_rule"\)/);
  assert.match(card, /navigator\.clipboard\.writeText/);

  const i18n = read("ui/i18n.js");
  for (const key of ["ruleNote", "ruleCopy", "ruleCopied"]) {
    assert.equal([...i18n.matchAll(new RegExp(`\\n\\s+${key}: "`, "g"))].length, 2, key);
  }
  assert.equal([...i18n.matchAll(/ruleCopied: "[^"]*\{version\}/g)].length, 2, "ruleCopied names the version");
});
