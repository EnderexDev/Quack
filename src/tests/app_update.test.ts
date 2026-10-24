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
