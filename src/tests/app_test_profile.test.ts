import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
const read = (p: string) => fs.readFileSync(path.join(app, p), "utf8").replace(/\r\n/g, "\n");

/** The body of `fn name(` in main.rs, up to the next top-level item */
function body(main: string, signature: string): string {
  const start = main.indexOf(signature);
  assert.ok(start >= 0, `${signature} is in main.rs`);
  const end = main.indexOf("\n}\n", start);
  return main.slice(start, end);
}

// 18/11/26: the redesigned window had only been seen in a headless browser. QUACK_TEST_PROFILE
// opens a debug build's real window next to the installed Quack Dev, which other sessions sync
// games with all day: nothing of the test may reach its settings, token, hub, plugin or PATH.
test("a test profile keeps the app away from the installed one", () => {
  const profile = read("src-tauri/src/test_profile.rs");
  assert.match(profile, /pub const PROFILE_VAR: &str = "QUACK_TEST_PROFILE";/);
  assert.match(profile, /const REAL_PORTS: \[u16; 2\] = \[3825, 3826\];/);

  const main = read("src-tauri/src/main.rs");
  // Everything under %APPDATA% (settings, token, hub log, registry) follows the profile
  assert.match(body(main, "fn appdata() -> PathBuf {"), /Some\(profile\) => profile\.appdata\(\)/);
  // ...and so do the hub, its daemons and the CLI it starts
  assert.match(body(main, "fn hidden_command(program: &str) -> Command {"), /command\.env\("APPDATA", profile\.appdata\(\)\)/);
  // Nothing written to the machine, and no update looked for or installed
  for (const signature of [
    "fn install_plugin(app: &AppHandle) {",
    "fn install_cli(app: &AppHandle) {",
    "fn update_loop(app: AppHandle) {",
    "fn finish_update(app: AppHandle) {",
    "fn early_update_takeover(settings: &Settings)",
    "async fn check_update(app: AppHandle)",
    "async fn install_update(app: AppHandle)",
    "fn set_autostart(app: AppHandle, enabled: bool)",
    "fn get_autostart(app: AppHandle) -> bool {",
    "fn make_folder(path: String)",
    "async fn ai_clients(app: AppHandle, connect: bool",
  ]) {
    const head = body(main, signature).split("\n").slice(0, 5).join("\n");
    assert.match(head, /test_profile\(\)\.is_some\(\)/, `${signature} stops first in a test profile`);
  }
  // Its own single-instance key, hub port and registry, and WebView2 folder
  assert.match(main, /context\.config_mut\(\)\.identifier = profile\.identifier\.clone\(\);[\s\S]*?tauri::Builder::default\(\)/);
  assert.match(main, /\.build\(context\)/);
  assert.match(main, /settings\.hub_port = profile\.port;\n\s+settings\.registry = profile\.appdata\(\)/);
  assert.match(body(main, "fn build_window(app: &AppHandle, label: &str)"), /profile\.webview_dir\(\)/);
  // Never activated: built without the focus, and never shown or focused again
  assert.match(body(main, "fn test_window(config:"), /config\.focus = false;\n\s+config\.focusable = false;/);
  assert.match(body(main, "fn show_main_window(app: &AppHandle) {"), /if test_profile\(\)\.is_some\(\) \{\n\s+return;/);
  // An unusable profile stops the app before anything runs
  assert.match(main, /fn main\(\) \{\n[\s\S]{0,400}test_profile::resolve\([\s\S]{0,300}std::process::exit\(2\)/);
});
