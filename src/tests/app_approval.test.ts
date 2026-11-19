import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_HEADER, APPROVAL_TOKEN_HEADER } from "../cloud/approve.js";
import { appCss } from "./app_css.js";

// 10/11/26: a write to the live game is answered in the app's own popup (Ender: the PowerShell
// window "looked like a virus"). These read the app's real code: the Rust side holds the token,
// the window only shows the question and sends the click.

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
const read = (p: string) => fs.readFileSync(path.join(app, p), "utf8").replace(/\r\n/g, "\n");
const between = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `${from} is there`);
  const end = text.indexOf(to, start + from.length);
  return text.slice(start, end < 0 ? undefined : end);
};

/** The keys of one language's block in i18n.js */
function keysOf(language: "en" | "pt"): Set<string> {
  const text = read("ui/i18n.js");
  const start = text.indexOf(`  ${language}: {`);
  const end = language === "en" ? text.indexOf("  pt: {") : text.indexOf("\n};", start);
  return new Set([...text.slice(start, end).matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]));
}

test("app approval: the hub gets the token on stdin, the answer carries it from Rust, and the windows never reach it", () => {
  const main = read("src-tauri/src/main.rs");
  const approval = read("src-tauri/src/approval.rs");
  // The same headers on both sides
  assert.match(approval, new RegExp(`TOKEN_HEADER: &str = "${APPROVAL_TOKEN_HEADER}"`));
  assert.match(approval, new RegExp(`APP_HEADER: &str = "${APP_HEADER}"`));

  const start = between(main, "fn start_hub_process(", "\nfn write_token(");
  assert.match(start, /"--token-stdin"/);
  assert.match(start, /\.stdin\(Stdio::piped\(\)\)/);
  assert.match(start, /write_token\(&mut child, token\)/);
  assert.doesNotMatch(start, /\.env\(/, "never in the environment");
  assert.doesNotMatch(start, /\.args?\(\[?[^)]*[\s(,&]token[\s,)\]]/, "never on the command line");

  // Every start of a hub makes a new token and saves it for the next app instance
  const spawn = between(main, "fn spawn_hub_with(", "\n/** The token saved");
  assert.match(spawn, /approval::new_token\(\)/);
  assert.match(spawn, /remember_token\(&token\)/);
  assert.match(between(main, "fn early_update_takeover(", "\n/**"), /approval::new_token\(\)[\s\S]*remember_token\(&token\)/);
  // A new app instance reads back the token of the hub an earlier one started
  assert.match(main, /approval::load_token\(&settings_dir\(\), flavor::IDENTIFIER\)/);

  // The token goes out only on the approvals' own calls, added in Rust
  const answer = between(main, "async fn approval_answer(", "\n#[tauri::command]");
  assert.match(answer, /hub_call_with\(port, "POST", "\/api\/approvals\/answer", [^;]*Some\(&token\)\)/);
  assert.equal([...main.matchAll(/hub_call_with\([^)]*approvals/g)].length, 2, "the list and the answer, nothing else");
  const post = between(main, "async fn hub_post(", "\n}");
  assert.match(post, /path\.starts_with\("\/api\/approvals"\)/, "the windows' relay cannot reach the approvals");
  const handlers = between(main, "generate_handler![", "])");
  assert.match(handlers, /\bapproval_answer,/);
  for (const emit of main.matchAll(/emit(?:_to)?\([^;]*;/g)) assert.doesNotMatch(emit[0], /approval_token|token\b/, `no token in ${emit[0]}`);

  // DPAPI, tied to the flavor, in the flavor's settings folder
  assert.match(approval, /CryptProtectData/);
  assert.match(approval, /CryptUnprotectData/);
  assert.match(approval, /CRYPTPROTECT_UI_FORBIDDEN/);
  assert.match(approval, /TOKEN_FILE: &str = "approval-token\.dpapi"/);
  assert.match(main, /fn settings_dir\(\) -> PathBuf \{\n {4}appdata\(\)\.join\(flavor::IDENTIFIER\)/);
});

test("app approval: a waiting write brings the chime, the taskbar flash and a toast whose click shows the window; the hub's own launch never takes the screen", () => {
  const main = read("src-tauri/src/main.rs");
  const alert = between(main, "fn alert_approval(", "\nfn poll_loop(");
  assert.match(alert, /approval::play_chime\(\)/);
  assert.match(alert, /request_user_attention\(Some\(UserAttentionType::Critical\)\)/);
  assert.match(alert, /window\.minimize\(\);\n\s+let _ = window\.show\(\);/, "back on the taskbar minimized, not over a game");
  assert.doesNotMatch(alert, /set_focus/);
  assert.match(alert, /approval::show_toast\([^;]*show_main_window\(&handle\)\)/);
  const poll = between(main, "fn poll_loop(", "\n/** Sleeps");
  assert.match(poll, /for approval in &fresh \{\n\s+if let \(Some\(hold\), Some\(id\)\) = \(alert_approval\(/);
  // Each toast's thread lives only while its write waits (council review, round 2)
  assert.match(poll, /toasts\.insert\(id\.to_string\(\), hold\)/);
  assert.match(poll, /toasts\.retain\(\|id, _\| approvals\.is_waiting\(id\)\)/);
  assert.match(poll, /just_emptied\(\)[\s\S]*request_user_attention\(None\)/, "the flash stops once answered");
  assert.match(poll, /"approvals": approvals\.list, "approvalsAnswerable": approvals\.answerable/);
  const single = between(main, ".plugin(tauri_plugin_single_instance::init(", ".plugin(tauri_plugin_autostart");
  assert.match(single, /!args\.iter\(\)\.any\(\|arg\| arg == "--hidden"\)/);

  const approval = read("src-tauri/src/approval.rs");
  assert.match(approval, /include_bytes!\("\.\.\/sounds\/approval\.wav"\)/);
  assert.match(approval, /PlaySoundW\(CHIME\.as_ptr\(\)[^;]*SND_MEMORY \| SND_ASYNC/);
  assert.match(approval, /"O Quack está esperando uma resposta"/);
  assert.match(approval, /\.on_activated\(/);
  assert.match(read("src-tauri/Cargo.toml"), /tauri-winrt-notification = "0\.8"/);
});

test("app approval: the chime in the app is the one the script makes (three tones, ~1.5 s)", async () => {
  const { chimeWav, chimeSamples } = await import(pathToFileURL(path.join(app, "scripts", "chime.mjs")).href);
  const committed = fs.readFileSync(path.join(app, "src-tauri", "sounds", "approval.wav"));
  assert.ok(Buffer.compare(chimeWav(), committed) === 0, "run node app/scripts/chime.mjs again");
  const samples: Float64Array = chimeSamples();
  assert.equal(samples.length, Math.round(22050 * 1.5));
  assert.ok(Math.max(...samples.map(Math.abs)) <= 0.5, "below full scale");
  assert.ok(Math.abs(samples[samples.length - 1]) < 1e-12, "ends in silence");
});

test("app approval: the popup shows the title and the whole text read only, Refuse is the default and Esc refuses, and every string is in both languages", () => {
  const ui = read("ui/main.js");
  const popup = between(ui, "function renderApproval(", "\nui.app = await");
  assert.match(popup, /ui\.hub\.approvals\?\.\[0\]/);
  assert.match(popup, /h\("textarea", \{ class: "approval-text mono", readonly: true/);
  assert.match(popup, /text\.value = approval\.text;/, "set as a value, never parsed as HTML");
  assert.doesNotMatch(popup, /innerHTML/);
  assert.match(popup, /h\("h2", \{ class: "display approval-title", id: "approvalTitle" \}, approval\.title\)/);
  assert.match(popup, /invoke\("approval_answer", \{ id: approval\.id, approve \}\)/);
  assert.match(popup, /refuse\.focus\(\);\n\}\n?$/, "Refuse has the focus");
  assert.match(popup, /approvalEscape = answer\(false\);/);
  assert.match(ui, /if \(event\.key === "Escape" && approvalEscape\)/);
  assert.match(popup, /refuse\.disabled = accept\.disabled = !answerable;/, "a hub that does not take this app's token: nothing to click");
  assert.match(ui, /onState: \(payload\) => \{[\s\S]*?renderApproval\(\);/);
  // The restart notice, with the existing Restart hub button, never a restart by itself
  const bar = between(ui, "function renderUpdate(", "\n/**");
  assert.match(bar, /ui\.hub\.approvalsAnswerable === false/);
  assert.match(bar, /t\("approvalNeedsRestart"\)/);
  assert.match(bar, /invoke\("restart_hub"\)/);
  assert.match(appCss(), /#approval \{ z-index: 30; \}/);

  const used = new Set([...ui.matchAll(/t\("(approval\w*)"/g)].map((m) => m[1]));
  assert.ok(used.size >= 8, `${used.size} approval strings`);
  for (const language of ["en", "pt"] as const) {
    const keys = keysOf(language);
    assert.deepEqual([...used].filter((k) => !keys.has(k)), [], language);
  }
  const i18n = read("ui/i18n.js");
  assert.match(i18n, /approvalRefuse: "Recusar"/);
  assert.match(i18n, /approvalAccept: "Aceitar"/);
});

// 18/11/26, the Quackify restyle of the dialogs: an entrance must never hide a dialog. body.idle
// pauses every CSS animation on its first frame, and the approval usually opens in a window
// without focus (minimized on the taskbar), so a CSS fade would leave it invisible there
test("app dialogs: the entrance is a Web Animation skipped without focus, never a CSS one, for every dialog, the menu and the toast", () => {
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const sheet of ["ui/dialogs.css", "ui/tray.css"]) assert.doesNotMatch(strip(read(sheet)), /animation|@keyframes/, sheet);
  const common = read("ui/common.js");
  const pop = between(common, "export function popIn(", "\n}");
  assert.match(pop, /if \(document\.body\.classList\.contains\("idle"\)[^)]*\) return;/, "no entrance without the focus");
  assert.match(pop, /node\.animate\(/);
  assert.match(between(common, "export function toast(", "\n}"), /popIn\(node/);
  const ui = read("ui/main.js");
  for (const [from, to] of [["function renderApproval(", "\nui.app = await"], ["function renderChoice(", "\n// ----------"], ["async function renderSetup(", "\n/** One dialog"], ["function aiConnectDialog(", "\n/**"]]) {
    assert.match(between(ui, from, to), /document\.body\.append\(dialog\);\n\s+popIn\(dialog\.firstChild\);/, from);
  }
  assert.match(between(ui, "function popMenu(", "\nfunction "), /placeMenu\(menu, anchor\);\n\s+popIn\(menu\);/);
});

test("app dialogs: one brand-coloured element per dialog (its main answer), none in the menu, the tray's states or the AI picks", () => {
  const ui = read("ui/main.js");
  const brandIn = (body: string) => [...body.matchAll(/btn yellow|option\("keep"|pill brand/g)].length;
  assert.equal(brandIn(between(ui, "function renderApproval(", "\nui.app = await")), 1, "Refuse");
  assert.match(between(ui, "function renderApproval(", "\nui.app = await"), /const refuse = h\("button", \{ class: "btn yellow/);
  assert.equal(brandIn(between(ui, "function renderChoice(", "\n// ----------")), 1, "Keep the current one");
  assert.equal(brandIn(between(ui, "async function renderSetup(", "\n/** One dialog")), 1, "Set up and connect");
  assert.equal(brandIn(between(ui, "function aiConnectDialog(", "\n/**")), 1, "Connect");
  // In the stylesheets the brand is the keep option's fill and nothing else
  const css = read("ui/dialogs.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const branded = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => /--brand-/.test(m[2])).map((m) => m[1].trim());
  assert.deepEqual(branded.filter((s) => !s.startsWith(".option.keep")), []);
  assert.doesNotMatch(read("ui/tray.css"), /--brand-/);
  const trayHtml = read("ui/tray.html");
  assert.equal([...trayHtml.matchAll(/btn yellow/g)].length, 1, "Open window");
  // Every rule of the tray's sheet is under the panel: both windows load it, the sidebar must not change
  const tray = read("ui/tray.css").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of tray.matchAll(/([^{}]+)\{[^}]*\}/g)) for (const s of m[1].split(",")) assert.match(s.trim(), /^(\.tray\b|body\.traybody\b)/, s.trim());
});

test("app menu: placed from rem and its own size, above the anchor when there is no room below, never outside the window", () => {
  const ui = read("ui/main.js");
  const place = between(ui, "function placeMenu(", "\n}");
  assert.match(place, /getComputedStyle\(document\.documentElement\)\.fontSize/);
  assert.match(place, /menu\.getBoundingClientRect\(\)/);
  assert.match(place, /classList\.toggle\("up", up\)/);
  assert.match(place, /innerWidth - gap - box\.width/);
  assert.match(place, /innerHeight - gap - box\.height/);
  assert.doesNotMatch(between(ui, "function popMenu(", "\nfunction "), /\d+\}px|\+ \d+\}/, "no fixed px offsets");
});

// 18/11/26, the merge of the Quackify restyle: toast() with no kind shows a success tick, so a
// line that only informs passes "info" (being up to date is not an action that succeeded)
test("app toasts: a line that only informs is an info toast, an error is an error", () => {
  const ui = read("ui/main.js");
  assert.match(ui, /toast\(t\("upToDate", \{ version: ui\.app\.version \}\), "info"\)/);
  assert.match(ui, /toast\(t\("mcpRestart"\), "info"\)/);
  assert.match(ui, /const fail = \(error\) => toast\(t\("error", \{ e: error \}\), true\);/);
  // Every other call is a success (no kind), info or an error: no unknown kind falls back silently
  for (const m of ui.matchAll(/\btoast\(t\("(\w+)"[^;\n]*/g)) {
    const kind = /\),\s*(true|false|"[a-z]+")(?:,\s*\d+)?\)/.exec(m[0])?.[1];
    assert.ok(kind === undefined || ["true", "false", '"info"', '"success"', '"error"'].includes(kind), m[0]);
  }
});
