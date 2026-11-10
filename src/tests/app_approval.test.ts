import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_HEADER, APPROVAL_TOKEN_HEADER } from "../cloud/approve.js";

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
  assert.match(read("ui/style.css"), /#approval \{ z-index: 30; \}/);

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
