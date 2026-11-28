// Captures the app's UI in a headless Edge of its own (its own temporary profile, driven over
// CDP from this process: no window, no focus taken, no global mouse or keyboard). Each shot
// opens the page served by serve.mjs in a given state and size, waits for it to settle, saves a
// PNG, and lists every console error, uncaught exception and unanswered stub call.
//
//   node app/harness/capture.mjs --out <dir> [--ui <dir>] [--only <name,name>] [--prefix <p>]
//
// Edge runs with --disable-gpu, as the app's WebView2 does (tauri.conf.json).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "./serve.mjs";

const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/** The window's own size (tauri.conf.json: 1120 x 740) and a big screen */
const WINDOW = { width: 1120, height: 740 };
const BIG = { width: 1920, height: 1080 };
const HUGE = { width: 2560, height: 1440 };
const SMALL = { width: 820, height: 560 };
const WAIT_LOG = "document.querySelectorAll('#log .ln').length > 5";

/** name, page and query, size, what to wait for, and what to do once it is there */
export const SHOTS = [
  { name: "official", query: "update=1.0.41", size: WINDOW, ready: WAIT_LOG },
  { name: "dev", query: "flavor=dev&update=1.0.41", size: WINDOW, ready: WAIT_LOG },
  { name: "official-1920", query: "update=1.0.41", size: BIG, ready: WAIT_LOG },
  { name: "official-2560", query: "update=1.0.41", size: HUGE, ready: WAIT_LOG },
  { name: "official-820", query: "update=1.0.41", size: SMALL, ready: WAIT_LOG },
  { name: "official-pt-820", query: "lang=pt&update=1.0.41&rule=1", size: SMALL, ready: WAIT_LOG },
  // A view full of shared controls, on a big screen: the controls grow with the window too
  { name: "settings-1920", query: "view=settings", size: BIG, ready: "document.querySelectorAll('.card').length > 5" },
  { name: "notices", query: "rule=1&hubOld=1", size: WINDOW, ready: WAIT_LOG },
  { name: "playtest", query: "view=playtest", size: WINDOW, ready: WAIT_LOG },
  { name: "merges", query: "view=merges", size: WINDOW, ready: "document.querySelectorAll('.mrow').length > 2" },
  { name: "conflict", query: "view=merges", size: WINDOW, ready: "document.querySelectorAll('.mrow').length > 2", then: "document.querySelector('.mrow .pill.warn').click()", settle: "document.querySelector('.diff')" },
  // A write changes the example data: resolving the conflict clears the tab's count and its row
  { name: "resolved", query: "view=merges", size: WINDOW, ready: "document.querySelectorAll('.mrow').length > 2",
    then: "document.querySelector('.mrow .pill.warn').click(); new Promise((r) => { const t = setInterval(() => { const b = [...document.querySelectorAll('.actions .btn')].find((x) => x.textContent === 'Keep'); if (b) { clearInterval(t); b.click(); r(); } }, 50); })",
    settle: "document.getElementById('mergeBadge').classList.contains('hidden') && !document.querySelector('.mrow .pill.warn') && document.querySelectorAll('.mrow').length > 2" },
  { name: "analysis", query: "view=analysis", size: WINDOW, ready: "document.querySelectorAll('.frow').length > 1" },
  // Quack Test's two settings, in a game's Analysis tab (its own value off) and in Settings
  { name: "quacktest-game", query: "view=analysis", size: WINDOW, ready: "document.querySelectorAll('.frow').length > 1",
    then: "[...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Quack Test')).scrollIntoView({ block: 'end' })",
    check: "[...document.querySelectorAll('.field')].filter((f) => f.textContent.includes('Quack Test')).length === 2" },
  { name: "quacktest-game-pt-820", query: "view=analysis&lang=pt", size: SMALL, ready: "document.querySelectorAll('.frow').length > 1",
    then: "[...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Quack Test')).scrollIntoView({ block: 'end' })" },
  { name: "quacktest-settings", query: "view=settings", size: WINDOW, ready: "document.querySelectorAll('.card').length > 5",
    then: "[...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Quack Test')).scrollIntoView({ block: 'end' })",
    check: "[...document.querySelectorAll('.field')].filter((f) => f.textContent.includes('Quack Test')).length === 2" },
  { name: "queue", query: "view=queue", size: WINDOW, ready: "document.querySelectorAll('.card').length > 3" },
  { name: "folder", query: "view=folder", size: WINDOW, ready: "document.querySelector('.place')" },
  { name: "settings", query: "view=settings", size: WINDOW, ready: "document.querySelectorAll('.card').length > 5" },
  { name: "offline", query: "offline=1", size: WINDOW, ready: "document.querySelector('.offline')" },
  { name: "menu", query: "", size: WINDOW, ready: WAIT_LOG, then: "document.querySelector('#openCode .more').click()", settle: "document.querySelector('.menu')" },
  { name: "banners", query: "paused=1&aiChoose=1&refused=1", size: WINDOW, ready: "document.querySelectorAll('.top > .card').length === 2" },
  { name: "no-session", query: "place=98112345678901", size: WINDOW, ready: "document.querySelector('.head h1')?.textContent === 'Quack Lab'" },
  { name: "no-games", query: "noGames=1", size: WINDOW, ready: "document.querySelector('.offline .btn')" },
  { name: "approval", query: "approval=1", size: WINDOW, ready: "document.querySelector('#approval textarea')" },
  // Shown without the focus: body.idle pauses every animation, and a dialog must still be visible
  { name: "approval-unfocused", query: "approval=1&unfocused=1", size: WINDOW, ready: "document.body.classList.contains('idle') && document.querySelector('#approval textarea')",
    check: "[...document.querySelectorAll('#approval, #approval *')].every((n) => getComputedStyle(n).opacity === '1')" },
  // Refusing closes the popup, and the next state does not bring it back
  { name: "approval-answered", query: "approval=1", size: WINDOW, ready: "document.querySelector('#approval textarea')",
    then: "document.querySelector('#approval .btn.yellow').click(); new Promise((r) => setTimeout(r, 600))", settle: "!document.querySelector('#approval') && document.querySelector('.toast')" },
  { name: "choice-folder", query: "choice=folder&unfocused=1", size: WINDOW, ready: "document.querySelector('#choice .parties')",
    check: "[...document.querySelectorAll('#choice, #choice *')].every((n) => getComputedStyle(n).opacity === '1')" },
  { name: "choice-setup", query: "choice=setup", size: WINDOW, ready: "document.querySelector('#choice .setup-option')" },
  { name: "connect-ai", query: "view=settings", size: WINDOW, ready: "document.querySelectorAll('.card').length > 5",
    then: "[...document.querySelectorAll('button')].find((b) => b.textContent === 'Connect to AI').click()", settle: "document.querySelectorAll('#aiConnect .ai-option').length > 2" },
  // Every shared control (app/ui/controls.css) in its states, at the window's width (taller, so all of it shows; 1rem is still 16 px) and on a big screen
  { name: "controls", page: "__harness/controls.html", query: "", size: { width: 1120, height: 1400 }, ready: "document.readyState === 'complete' && document.fonts.status === 'loaded'" },
  { name: "controls-1920", page: "__harness/controls.html", query: "", size: { width: 1920, height: 1300 }, ready: "document.readyState === 'complete' && document.fonts.status === 'loaded'" },
  { name: "tray", page: "tray.html", query: "", size: { width: 320, height: 400 }, ready: "document.querySelectorAll('#list .game').length > 1", background: { r: 32, g: 36, b: 44, a: 1 } },
  // The Queue in each state (stub.js &queue=), at the three sizes, Dev and Portuguese, and its two danger buttons driven
  { name: "queue-busy", query: "view=queue&queue=busy", size: WINDOW, ready: "document.querySelector('.queue .qalert, .queue .qlock') && document.querySelectorAll('.queue .qrow').length > 6" },
  { name: "queue-busy-820", query: "view=queue&queue=busy", size: SMALL, ready: "document.querySelectorAll('.queue .qrow').length > 6" },
  { name: "queue-busy-1920", query: "view=queue&queue=busy", size: BIG, ready: "document.querySelectorAll('.queue .qrow').length > 6" },
  { name: "queue-820", query: "view=queue", size: SMALL, ready: "document.querySelector('.queue .qlock')" },
  { name: "queue-1920", query: "view=queue", size: BIG, ready: "document.querySelector('.queue .qlock')" },
  { name: "queue-dev", query: "flavor=dev&view=queue", size: WINDOW, ready: "document.querySelector('.queue .qlock')" },
  { name: "queue-pt", query: "lang=pt&view=queue&queue=busy", size: WINDOW, ready: "document.querySelectorAll('.queue .qrow').length > 6" },
  { name: "queue-stuck", query: "view=queue&queue=stuck", size: WINDOW, ready: "document.querySelector('.queue .qalert')" },
  { name: "queue-foreign-pt-820", query: "lang=pt&view=queue&queue=foreign", size: SMALL, ready: "document.querySelector('.queue .qalert')" },
  { name: "queue-empty", query: "view=queue&queue=empty", size: WINDOW, ready: "document.querySelector('.queue .qlock.free')" },
  { name: "queue-error", query: "view=queue&queueError=1", size: WINDOW, ready: "document.querySelector('.queue .qfail')" },
  // Free the lock: a first click arms it (red), a second frees Studio
  { name: "queue-release-armed", query: "view=queue", size: WINDOW, ready: "document.querySelector('.queue .qlock .btn')",
    then: "document.querySelector('.queue .qlock .btn').click()", settle: "document.querySelector('.queue .qlock .btn.armed')?.textContent === 'Free it?'" },
  { name: "queue-released", query: "view=queue", size: WINDOW, ready: "document.querySelector('.queue .qlock .btn')",
    then: "document.querySelector('.queue .qlock .btn').click(); new Promise((r) => setTimeout(() => { document.querySelector('.queue .qlock .btn').click(); r(); }, 150))",
    settle: "document.querySelector('.queue .qlock.free') && document.querySelector('.toast .toast-text')?.textContent === 'Lock freed'" },
  // Unstick: armed, then the play stops and the red block goes
  { name: "queue-unstick-armed", query: "view=queue&queue=stuck", size: WINDOW, ready: "document.querySelector('.queue .qalert .btn')",
    then: "document.querySelector('.queue .qalert .btn').click()", settle: "document.querySelector('.queue .qalert .btn.armed')?.textContent === 'Unstick it?'" },
  { name: "queue-unstuck", query: "view=queue&queue=stuck", size: WINDOW, ready: "document.querySelector('.queue .qalert .btn')",
    then: "document.querySelector('.queue .qalert .btn').click(); new Promise((r) => setTimeout(() => { document.querySelector('.queue .qalert .btn').click(); r(); }, 150))",
    settle: "!document.querySelector('.queue .qalert') && document.querySelector('.toast .toast-text')?.textContent.startsWith('Studio unstuck')" },
  // The Folder at the three sizes, Dev, Remove armed in Portuguese, removed, and a game with no folder
  { name: "folder-820", query: "view=folder", size: SMALL, ready: "document.querySelector('.folder .place')" },
  { name: "folder-1920", query: "view=folder", size: BIG, ready: "document.querySelector('.folder .place')" },
  { name: "folder-dev", query: "flavor=dev&view=folder", size: WINDOW, ready: "document.querySelector('.folder .place')" },
  { name: "folder-armed-pt-820", query: "lang=pt&view=folder", size: SMALL, ready: "document.querySelector('.folder .btn.danger')",
    then: "document.querySelector('.folder .btn.danger').click()", settle: "document.querySelector('.folder .btn.danger.armed') && !document.querySelector('.folder .note.bad').classList.contains('hidden')" },
  { name: "folder-removed", query: "view=folder", size: WINDOW, ready: "document.querySelector('.folder .btn.danger')",
    then: "document.querySelector('.folder .btn.danger').click(); document.querySelector('.folder .btn.danger').click()",
    settle: "document.querySelector('.toast') && ![...document.querySelectorAll('.side .game b')].some((b) => b.textContent === 'Anime Astral Copy')" },
  // Rename on a game that is not the first: the field open, then saved with Enter, and the
  // sidebar, the header and the card show the new name while the other games keep theirs
  { name: "folder-rename", query: "view=folder&place=98112345678901", size: WINDOW, ready: "document.querySelector('.folder .place')",
    then: "[...document.querySelectorAll('.folder .field .btn')].find((b) => b.textContent === 'Rename').click()",
    settle: "document.activeElement === document.querySelector('.folder .field .field-input')" },
  { name: "folder-renamed", query: "view=folder&place=98112345678901", size: WINDOW, ready: "document.querySelector('.folder .place')",
    then: "[...document.querySelectorAll('.folder .field .btn')].find((b) => b.textContent === 'Rename').click(); const i = document.querySelector('.folder .field .field-input'); i.value = 'Strike Reborn'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))",
    settle: "document.querySelector('.head h1')?.textContent === 'Strike Reborn' && document.querySelector('.folder .place b')?.textContent === 'Strike Reborn'",
    check: "(() => { const names = [...document.querySelectorAll('.side .game b')].map((b) => b.textContent); return names.includes('Strike Reborn') && !names.includes('Quack Lab') && names.includes('Anime Astral Copy'); })()" },
  { name: "folder-rename-pt-820", query: "lang=pt&view=folder", size: SMALL, ready: "document.querySelector('.folder .place')",
    then: "[...document.querySelectorAll('.folder .field .btn')].find((b) => b.textContent === 'Renomear').click()",
    settle: "document.querySelector('.folder .field .field-input')" },
  { name: "folder-none", query: "view=folder&noFolder=1", size: WINDOW, ready: "document.querySelector('.folder > .empty')" },
  // The busy Queue scrolled to its end: Waiting, Recent and Today
  // Scrolled, then past two polls (each 1.5 s redraws the cards): the scroll stays where it was
  { name: "queue-busy-end", query: "view=queue&queue=busy", size: WINDOW, ready: "document.querySelectorAll('.queue .qrow').length > 6",
    then: "const v = document.querySelector('.queue'); v.scrollTop = 1e6; window.__qTop = v.scrollTop; window.__qAt = Date.now()",
    settle: "window.__qTop > 0 && Date.now() - window.__qAt > 3200", check: "Math.abs(document.querySelector('.queue').scrollTop - window.__qTop) < 2" },
  { name: "queue-busy-end-820", query: "view=queue&queue=busy", size: SMALL, ready: "document.querySelectorAll('.queue .qrow').length > 6",
    then: "document.querySelector('.queue').scrollTop = 1e6", settle: "document.querySelector('.queue').scrollTop > 0" },
  { name: "queue-busy-end-1920", query: "view=queue&queue=busy", size: BIG, ready: "document.querySelectorAll('.queue .qrow').length > 6",
    then: "document.querySelector('.queue').scrollTop = 1e6", settle: "document.querySelector('.queue').scrollTop > 0" },
  ...G1_SHOTS(),
];

// Dialogs, menu, toast and tray (the dialogs group): every dialog at the three sizes, with and
// without the focus, and the flows driven by their own buttons, checked by the command they call
// (stub.js records them in __harness.calls)
{
  const called = (command, test = "true") => `window.__harness.calls.some((c) => c.command === '${command}' && (${test}))`;
  const posted = (path, test = "true") => called("hub_post", `c.args.path === '${path}' && (${test.replace(/\bbody\b/g, "c.args.body")})`);
  // Nothing in the dialog faded (a disabled button is dimmed on purpose), and no entrance left running
  const shown = (id) => `[...document.querySelectorAll('#${id}, #${id} *:not(:disabled)')].every((n) => getComputedStyle(n).opacity === '1') && document.querySelector('#${id} .dialog').getAnimations().length === 0 && getComputedStyle(document.querySelector('#${id} .dialog')).transform === 'none'`;
  // Every one of them that shows is wholly inside the window (and at least one shows)
  const inView = (selector) => `[...document.querySelectorAll('${selector}')].filter((n) => n.getClientRects().length).every((n) => { const r = n.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; }) && [...document.querySelectorAll('${selector}')].some((n) => n.getClientRects().length)`;
  const clickText = (text) => `[...document.querySelectorAll('button')].find((b) => b.textContent === '${text}').click()`;
  const later = (ms, js) => `new Promise((r) => setTimeout(() => { ${js}; r(); }, ${ms}))`;
  const dialogs = [
    { key: "approval", id: "approval", query: "approval=1", ready: "document.querySelector('#approval textarea')" },
    { key: "choice", id: "choice", query: "choice=folder", ready: "document.querySelector('#choice .parties')" },
    { key: "setup", id: "choice", query: "choice=setup&setupExisting=1", ready: "document.querySelectorAll('#choice .setup-option').length === 4" },
    { key: "ai", id: "aiConnect", query: "view=settings", ready: "document.querySelectorAll('.card').length > 5", then: clickText("Connect to AI"), settle: "document.querySelectorAll('#aiConnect .ai-option').length > 2" },
  ];
  const sizes = [["1120", WINDOW], ["820", SMALL], ["1920", BIG]];
  for (const d of dialogs) {
    for (const [label, size] of sizes) {
      for (const idle of [false, true]) {
        SHOTS.push({ name: `dlg-${d.key}-${label}${idle ? "-idle" : ""}`, query: `${d.query}${idle ? "&unfocused=1" : ""}`, size, ready: d.ready, then: d.then, settle: d.settle,
          check: `${shown(d.id)} && ${inView(`#${d.id} .btn, #${d.id} .option`)}` });
      }
    }
  }
  const tray = { page: "tray.html", size: { width: 320, height: 520 }, background: { r: 32, g: 36, b: 44, a: 1 }, ready: "document.querySelector('#list .game, #list .traymsg') && document.getElementById('pause').textContent" };
  SHOTS.push(
    // The approval: Dev, Portuguese, a long write at the smallest size, a hub that cannot be answered
    { name: "dlg-approval-dev", query: "flavor=dev&approval=1", size: WINDOW, ready: "document.querySelector('#approval textarea')", check: shown("approval") },
    { name: "dlg-approval-pt-820", query: "lang=pt&approval=1", size: SMALL, ready: "document.querySelector('#approval textarea')", check: `${shown("approval")} && ${inView("#approval .btn")}` },
    { name: "dlg-approval-long-820", query: "approval=1&approvalLong=1", size: SMALL, ready: "document.querySelector('#approval textarea')",
      check: `${inView("#approval .btn")} && document.querySelector('#approval textarea').scrollHeight > document.querySelector('#approval textarea').clientHeight` },
    { name: "dlg-approval-unanswerable-820", query: "approval=1&approvalLong=1", size: SMALL, ready: "document.querySelector('#approval textarea')",
      then: "window.__harness.emit('hub-state', { ...window.__harness.hubState(), approvalsAnswerable: false })", settle: "document.querySelector('#approval .note.bad')",
      check: `${inView("#approval .btn, #approval .note.bad")} && [...document.querySelectorAll('#approval .btn')].every((b) => b.disabled)` },
    // Accept and Refuse: the answer the app sends, the popup gone, and gone still after the next state
    { name: "dlg-approval-accept", query: "approval=1", size: WINDOW, ready: "document.querySelector('#approval textarea')",
      then: `document.querySelector('#approval .btn.danger').click(); ${later(500, "window.__harness.emit('hub-state', window.__harness.hubState())")}`, settle: "!document.querySelector('#approval') && document.querySelector('.toast.success')",
      check: `!document.querySelector('#approval') && ${called("approval_answer", "c.args.id === 'a1' && c.args.approve === true")} && !${called("approval_answer", "c.args.approve === false")}` },
    { name: "dlg-approval-refuse", query: "approval=1", size: WINDOW, ready: "document.querySelector('#approval textarea')",
      then: `document.querySelector('#approval .btn.yellow').click(); ${later(500, "window.__harness.emit('hub-state', window.__harness.hubState())")}`, settle: "!document.querySelector('#approval') && document.querySelector('.toast')",
      check: `!document.querySelector('#approval') && ${called("approval_answer", "c.args.approve === false")} && !${called("approval_answer", "c.args.approve === true")}` },
    // The choice: Portuguese, Dev, a second Studio, and both answers
    { name: "dlg-choice-pt-820", query: "lang=pt&choice=folder", size: SMALL, ready: "document.querySelector('#choice .parties')", check: `${shown("choice")} && ${inView("#choice .option")}` },
    { name: "dlg-choice-dev", query: "flavor=dev&choice=folder", size: WINDOW, ready: "document.querySelector('#choice .parties')", check: shown("choice") },
    { name: "dlg-choice-studio", query: "choice=studio", size: WINDOW, ready: "document.querySelector('#choice .parties')", check: shown("choice") },
    { name: "dlg-choice-keep", query: "choice=folder", size: WINDOW, ready: "document.querySelector('#choice .parties')", then: "document.querySelector('#choice .option.keep').click()",
      settle: "!document.querySelector('#choice')", check: posted("/api/choice", "body.id === 'c1' && body.decision === 'cancel'") },
    { name: "dlg-choice-take", query: "choice=folder", size: WINDOW, ready: "document.querySelector('#choice .parties')", then: "document.querySelector('#choice .option.take').click()",
      settle: "!document.querySelector('#choice')", check: posted("/api/choice", "body.id === 'c1' && body.decision === 'continue'") },
    // The setup: the middle folder picked (the others untouched), then each way to finish
    { name: "dlg-setup-pick", query: "choice=setup&setupExisting=1", size: WINDOW, ready: "document.querySelectorAll('#choice .setup-option').length === 4",
      then: "document.querySelectorAll('#choice .setup-option')[1].click()", settle: "document.querySelectorAll('#choice .setup-option')[1].classList.contains('on')",
      check: "[...document.querySelectorAll('#choice .setup-option')].map((n) => n.classList.contains('on')).join() === 'false,true,false,false' && document.querySelector('#choice .setup-new').classList.contains('hidden')" },
    { name: "dlg-setup-existing-go", query: "choice=setup&setupExisting=1", size: WINDOW, ready: "document.querySelectorAll('#choice .setup-option').length === 4",
      then: "document.querySelectorAll('#choice .setup-option')[1].click(); document.querySelector('#choice .btn.yellow').click()", settle: "!document.querySelector('#choice') && document.querySelector('.toast.success')",
      check: `${posted("/api/registry", "body.placeId === '55501234567890' && body.folder === 'E:\\\\Games\\\\Tower Tycoon (old)'")} && !${called("make_folder")}` },
    { name: "dlg-setup-new-picked", query: "choice=setup&picked=E:%5CGames%5CTower%20Picked", size: WINDOW, ready: "document.querySelectorAll('#choice .setup-option').length === 1",
      then: `${clickText("Choose folder")}; ${later(300, "document.querySelector('#choice .btn.yellow').click()")}`, settle: "!document.querySelector('#choice')",
      check: `${called("pick_folder")} && ${called("make_folder", "c.args.path === 'E:\\\\Games\\\\Tower Picked'")} && ${posted("/api/registry", "body.folder === 'E:\\\\Games\\\\Tower Picked'")}` },
    // Connect to AI: Cursor ticked too, then Connect: only the ticked folders are set up
    { name: "dlg-ai-tick", query: "view=settings", size: WINDOW, ready: "document.querySelectorAll('.card').length > 5",
      then: `${clickText("Connect to AI")}; ${later(400, "document.querySelectorAll('#aiConnect .ai-option input')[2].click()")}`, settle: "document.querySelector('#aiConnect .btn.yellow')?.textContent === 'Connect (2)'",
      check: "document.querySelectorAll('#aiConnect .ai-option input')[1].disabled && !document.querySelectorAll('#aiConnect .ai-option input')[1].checked" },
    { name: "dlg-ai-connect", query: "view=settings", size: WINDOW, ready: "document.querySelectorAll('.card').length > 5",
      then: `${clickText("Connect to AI")}; ${later(400, "document.querySelectorAll('#aiConnect .ai-option input')[2].click(); document.querySelector('#aiConnect .btn.yellow').click()")}`, settle: "!document.querySelector('#aiConnect')",
      check: called("ai_clients", "c.args.connect === true && c.args.only.join() === 'claude,cursor'") },
    // The menu: at the smallest size, picking an item, and near the bottom (it opens upwards)
    { name: "dlg-menu-820", query: "", size: SMALL, ready: WAIT_LOG, then: "document.querySelector('#openCode .more').click()", settle: "document.querySelector('.menu')",
      check: `${inView(".menu")} && !document.querySelector('.menu').classList.contains('up')` },
    { name: "dlg-menu-pick", query: "", size: WINDOW, ready: WAIT_LOG, then: `document.querySelector('#openCode .more').click(); ${later(200, "[...document.querySelectorAll('.menu button')].find((b) => b.textContent === 'Zed').click()")}`,
      settle: "!document.querySelector('.menu')", check: `${called("set_settings", "c.args.editor === 'zed'")} && ${called("open_path", "c.args.editor === true")}` },
    { name: "dlg-menu-bottom-820", query: "view=settings", size: SMALL, ready: "document.querySelector('#set-ai button.pill')",
      then: `document.querySelector('#set-ai button.pill').scrollIntoView({ block: 'end' }); ${later(200, "document.querySelector('#set-ai button.pill').click()")}`, settle: "document.querySelector('.menu')",
      check: `${inView(".menu")} && document.querySelector('.menu').classList.contains('up')` },
    { name: "dlg-menu-idle", query: "unfocused=1", size: WINDOW, ready: `document.body.classList.contains('idle') && ${WAIT_LOG}`, then: "document.querySelector('#openCode .more').click()", settle: "document.querySelector('.menu')",
      check: "getComputedStyle(document.querySelector('.menu')).opacity === '1' && document.querySelector('.menu').getAnimations().length === 0" },
    // The three toasts, and an error over a dialog
    { name: "dlg-toast-success", query: "", size: WINDOW, ready: WAIT_LOG, then: "import('/common.js').then((m) => m.toast('Answer sent'))", settle: "document.querySelector('.toast.success')" },
    { name: "dlg-toast-info", query: "", size: WINDOW, ready: WAIT_LOG, then: "import('/common.js').then((m) => m.toast('Quack 1.0.40 is the newest version', 'info'))", settle: "document.querySelector('.toast.info')" },
    { name: "dlg-toast-error", query: "", size: WINDOW, ready: WAIT_LOG, then: "import('/common.js').then((m) => m.toast('Error: the hub did not answer on port 3826', true))", settle: "document.querySelector('.toast.error')" },
    { name: "dlg-toast-over-dialog-820", query: "approval=1&unfocused=1", size: SMALL, ready: "document.querySelector('#approval textarea')",
      then: "import('/common.js').then((m) => m.toast('Error: the hub did not answer on port 3826', true))", settle: "document.querySelector('.toast.error')",
      check: "getComputedStyle(document.querySelector('.toast')).opacity === '1' && document.elementFromPoint(innerWidth / 2, document.querySelector('.toast').getBoundingClientRect().top + 8)?.closest('.toast')" },
    // The tray: paused, offline, no game, errors, a long list, Dev and Portuguese
    { ...tray, name: "tray-paused", query: "paused=1" },
    { ...tray, name: "tray-offline", query: "offline=1" },
    { ...tray, name: "tray-empty", query: "noGames=1" },
    { ...tray, name: "tray-errors", query: "refused=1" },
    { ...tray, name: "tray-many", query: "manyPlaces=1&refused=1", check: "document.getElementById('list').scrollHeight > document.getElementById('list').clientHeight" },
    { ...tray, name: "tray-dev", query: "flavor=dev" },
    { ...tray, name: "tray-pt", query: "lang=pt&refused=1" },
    // Each of its buttons, by the command it calls: a game in the middle, Open window, Pause all, Quit
    { ...tray, name: "tray-buttons", query: "",
      then: "document.querySelectorAll('#list .game')[1].click(); document.getElementById('open').click(); document.getElementById('pause').click(); document.getElementById('quit').click()",
      settle: "document.querySelector('#list .traymsg')",
      check: `${called("show_main", "c.args.placeId === '138530444532741' && c.args.view === 'output'")} && ${called("show_main", "c.args.placeId === null && c.args.view === null")} && ${posted("/api/pause", "body.paused === true")} && ${called("quit")} && document.getElementById('pause').textContent === 'Resume'` },
  );
}

/**
 * Merges, Conflict and Analysis in every size, flavour and language, their empty and error states
 * (set by changing the example data inside the page, then waiting for the view's 2 s poll), and
 * the clicks that matter checked by what they sent (stub.js records every command)
 */
function G1_SHOTS() {
  const F = "window.__QUACK_FIXTURES";
  const merges = "document.querySelectorAll('.mrow').length > 2";
  const findings = "document.querySelectorAll('.frow').length > 1";
  const open = "document.querySelector('.mrow .pill.warn').click()";
  const conflict = (before = "") => ({ query: "view=merges", ready: merges, then: `${before}${open}`, settle: "document.querySelector('.diff .cf-side')" });
  const click = (text) => `${open}; new Promise((r) => { const t = setInterval(() => { const b = [...document.querySelectorAll('.cf-side .btn')].find((x) => x.textContent === '${text}'); if (b) { clearInterval(t); b.click(); r(); } }, 50); })`;
  const sent = (action) => `window.__harness.calls.some((c) => c.command === 'hub_post' && c.args.path === '/api/conflict/resolve' && c.args.body.id === 'a3f9c1' && c.args.body.action === '${action}')`;
  const opened = (file) => `window.__harness.calls.some((c) => c.command === 'open_path' && c.args.editor === true && c.args.path === 'E:\\\\Dev\\\\AnimeAstralCopy\\\\${file}')`;
  const analysisIs = (panel, prod) => `Object.assign(${F}.analysis, ${panel}); Object.assign(${F}.productionErrors, ${prod})`;
  return [
    { name: "g1-merges-820", query: "view=merges", size: SMALL, ready: merges },
    { name: "g1-merges-1920", query: "view=merges", size: BIG, ready: merges },
    { name: "g1-merges-dev", query: "view=merges&flavor=dev", size: WINDOW, ready: merges },
    { name: "g1-merges-pt-820", query: "view=merges&lang=pt", size: SMALL, ready: merges },
    { name: "g1-merges-empty", query: "view=merges&place=138530444532741", size: WINDOW, ready: "document.querySelector('.mlist .empty strong')" },
    // A conflict older than the history: no time and no method, never "Invalid Date"
    { name: "g1-merges-old-conflict", query: "view=merges", size: WINDOW, ready: merges,
      then: `${F}.merges['122779716334700'].conflicts.push({ agentVersion: 'b70c4e', file: 'ServerScriptService/Old/ShopService.luau' })`,
      settle: "document.querySelectorAll('.mrow').length === 6", check: "!/Invalid/.test(document.querySelector('.mlist').textContent) && document.querySelectorAll('.mrow.waiting').length === 2" },
    { name: "g1-conflict-820", ...conflict(), size: SMALL },
    { name: "g1-conflict-1920", ...conflict(), size: BIG },
    { name: "g1-conflict-dev", ...conflict(), query: "view=merges&flavor=dev", size: WINDOW },
    { name: "g1-conflict-pt-820", ...conflict(), query: "view=merges&lang=pt", size: SMALL },
    // Both versions the same now, and the script gone from disk
    { name: "g1-conflict-same", ...conflict(`${F}.conflict.saved = ${F}.conflict.current; `), size: WINDOW, check: "document.querySelector('.cf-note') && document.querySelectorAll('.pane .ln').length > 10" },
    { name: "g1-conflict-gone", ...conflict(`${F}.conflict.current = null; `), size: WINDOW, check: "document.querySelector('.pane .gap') && document.querySelectorAll('.pane .lost').length > 5" },
    // Each side's button sends its own action, and the view goes back to the list
    { name: "g1-conflict-keep", query: "view=merges", size: WINDOW, ready: merges, then: click("Keep"),
      settle: "!document.querySelector('.diff') && document.querySelectorAll('.mrow').length > 2", check: `${sent("keep")} && !${sent("useDisk")}` },
    { name: "g1-conflict-usedisk", query: "view=merges", size: WINDOW, ready: merges, then: click("Use the disk version"),
      settle: "!document.querySelector('.diff') && document.querySelectorAll('.mrow').length > 2", check: `${sent("useDisk")} && !${sent("keep")}` },
    { name: "g1-analysis-820", query: "view=analysis", size: SMALL, ready: findings },
    { name: "g1-analysis-1920", query: "view=analysis", size: BIG, ready: findings },
    { name: "g1-analysis-dev", query: "view=analysis&flavor=dev", size: WINDOW, ready: findings },
    { name: "g1-analysis-pt-820", query: "view=analysis&lang=pt", size: SMALL, ready: findings },
    { name: "g1-analysis-empty", query: "view=analysis&place=138530444532741", size: WINDOW, ready: "document.querySelectorAll('.alist .empty').length === 2" },
    { name: "g1-analysis-running", query: "view=analysis", size: WINDOW, ready: findings,
      then: analysisIs("{ state: 'running', at: undefined, findings: [] }", "{ state: 'problem', problem: 'Open Cloud answered 403: the key has no universe-places:read for this game', fresh: [] }"),
      settle: "document.querySelector('.ainfo.busy') && document.querySelector('.aproblem')" },
    { name: "g1-analysis-off", query: "view=analysis", size: WINDOW, ready: findings,
      then: analysisIs("{ state: 'off', findings: [] }", "{ state: 'off', fresh: [] }"),
      settle: "document.querySelectorAll('.alist .empty').length === 2 && document.querySelector('.apanel .btn:disabled')" },
    { name: "g1-analysis-error", query: "view=analysis", size: WINDOW, ready: findings,
      then: analysisIs("{ state: 'error', error: 'luau-lsp exited with code 3', findings: [] }", "{}"), settle: "document.querySelector('.ainfo.bad') && !document.querySelector('.alist .empty')" },
    // A finding's line and the second file's name each open their own file in the editor
    { name: "g1-analysis-open", query: "view=analysis", size: WINDOW, ready: findings,
      then: "document.querySelector('.frow button.file').click(); document.querySelectorAll('.fhead')[1].click()",
      settle: "window.__harness.calls.filter((c) => c.command === 'open_path').length === 2",
      check: `${opened("ServerScriptService\\\\Services\\\\TradeService.luau")} && ${opened("StarterPlayer\\\\StarterPlayerScripts\\\\Controllers\\\\HudController.client.luau")}` },
    // Run again, Check now and Dismiss each post their own path for this game
    { name: "g1-analysis-buttons", query: "view=analysis", size: WINDOW, ready: findings,
      then: "for (const text of ['Run again', 'Check now', 'Dismiss']) [...document.querySelectorAll('.apanel .btn')].find((b) => b.textContent === text).click()",
      settle: "window.__harness.calls.filter((c) => c.command === 'hub_post').length >= 3 && document.querySelector('.apanel .btn.hidden')",
      check: "['/api/analysis/run', '/api/production-errors/check', '/api/production-errors/dismiss'].every((p) => window.__harness.calls.some((c) => c.command === 'hub_post' && c.args.path === p && c.args.body.placeId === '122779716334700'))" },
    // A long history (the list scrolls, its rows clear of the bar) and many findings: several in
    // one file, a long rule and message, errors with no script or no line
    { name: "g1-merges-many", query: "view=merges", size: WINDOW, ready: merges,
      then: `${F}.merges['122779716334700'].entries.push(...Array.from({ length: 18 }, (_, i) => ({ t: new Date(Date.now() - (100 + i * 7) * 60000).toISOString(), file: 'ServerScriptService/Services/Feature' + i + 'Service.luau', method: i % 3 ? 'text' : 'ai', ms: i % 3 ? 2 + i : 1800 + i * 90 })))`,
      settle: "document.querySelectorAll('.mrow').length === 23" },
    { name: "g1-merges-many-820", query: "view=merges", size: SMALL, ready: merges,
      then: `${F}.merges['122779716334700'].entries.push(...Array.from({ length: 18 }, (_, i) => ({ t: new Date(Date.now() - 2 * 86400000 - i * 60000).toISOString(), file: 'ReplicatedStorage/Shared/Config/Very/Deep/Folder/Feature' + i + 'Config.luau', method: 'text', ms: 4 })))`,
      settle: "document.querySelectorAll('.mrow').length === 23" },
    ...["", "-errors"].map((part) => ({ name: `g1-analysis-many${part}`, query: "view=analysis", size: WINDOW, ready: findings,
      then: `${F}.analysis.findings = [
        ...[12, 40, 88, 131].map((line) => ({ file: 'ServerScriptService/Services/TradeService.luau', line, rule: line === 40 ? 'unknown-member-of-required-module' : 'nil-index', message: line === 40 ? 'TradeService.accept calls Inventory.transferAll, but ReplicatedStorage.Shared.Inventory returns no member named transferAll (it has transfer, transferMany and clear); the call errors the first time a trade is accepted' : 'a.Inventory may be nil here' })),
        ...Array.from({ length: 6 }, (_, i) => ({ file: 'StarterPlayer/StarterPlayerScripts/Controllers/Window' + i + 'Controller.client.luau', line: 10 + i, rule: 'wait-for-child', message: 'WaitForChild(\\"Frame' + i + '\\") has no such child' }))];
        ${F}.productionErrors.fresh.push({ hash: '7f3a90c2', source: 'Client', message: 'Script timeout: exhausted allowed execution time', count: 4 }, { at: 'ServerScriptService/Data/ProfileTemplate.luau', hash: '11ab', source: 'Server', message: 'DataStore request was added to queue', count: 1200 });
        new Promise((r) => { const t = setInterval(() => { if (document.querySelectorAll('.fgroup').length >= 9) { clearInterval(t); ${part ? "document.querySelectorAll('.apanel')[1].scrollIntoView(); " : ""}r(); } }, 50); })`,
      settle: "document.querySelectorAll('.fgroup').length >= 9",
      check: "[...document.querySelectorAll('.frow .file')].every((n) => n.scrollWidth <= n.clientWidth + 1)" })),
    // Empty or missing fields read as missing: an error string "" keeps the folder, and an error
    // with no source, message, hash or count shows no "undefined"
    { name: "g1-merges-sparse", query: "view=merges", size: WINDOW, ready: merges,
      then: `${F}.merges['122779716334700'].entries.unshift({ t: new Date().toISOString(), file: 'ServerScriptService/Services/QuestService.luau', method: 'text', ms: 2, error: '' })`,
      settle: "document.querySelectorAll('.mrow').length === 6", check: "[...document.querySelectorAll('.mrow .dir')].some((n) => n.textContent === 'ServerScriptService/Services' && !n.classList.contains('why') && n.closest('.mrow').textContent.includes('QuestService'))" },
    { name: "g1-analysis-sparse", query: "view=analysis", size: WINDOW, ready: findings,
      then: `${F}.productionErrors.fresh.push({ source: '', message: '' }, { at: '', hash: '', source: 'Client', message: 'Players.Player1.PlayerGui.Hud:4: oops', count: 'many' })`,
      settle: "document.querySelectorAll('.apanel')[1].querySelectorAll('.frow').length === 3", check: "!/undefined|#undefi/.test(document.querySelectorAll('.apanel')[1].textContent)" },
  ];
}

// Settings (one long page: the index, the search, each section). Ready once every card is in and
// the rows that arrive later (the AIs found, the Open Cloud file) are there too
const SET_READY = "document.querySelectorAll('.set-group').length === 9 && document.querySelectorAll('#set-connect .field').length > 3 && document.querySelector('#set-cloud .set-path')?.textContent.includes('open-cloud.env')";
/** True once the list stopped scrolling between two reads (a smooth scroll is still moving) and `cond` holds */
const setStill = (cond) => `(() => { const l = document.querySelector('.set-list'); const top = l && l.scrollTop; const same = window.__setTop === top; window.__setTop = top; return same && (${cond}); })()`;
/** The index lit on `id`, and its section at the list's top (or the list at its end, for the short last ones) */
const setAt = (id) => `(() => { const l = document.querySelector('.set-list'); const d = document.getElementById('set-${id}').getBoundingClientRect().top - l.getBoundingClientRect().top;
  return document.querySelector('.set-index .on')?.dataset.sec === '${id}' && document.querySelector('.set-index [aria-current]')?.dataset.sec === '${id}' && (Math.abs(d) < 2 || l.scrollTop + l.clientHeight >= l.scrollHeight - 1); })()`;
const setClick = (id) => `document.querySelector('.set-index [data-sec="${id}"]').click()`;
const setType = (text) => `(() => { const q = document.querySelector('.set-q'); q.value = ${JSON.stringify(text)}; q.dispatchEvent(new Event('input')); })()`;
const setCalled = (fn) => `window.__harness.calls.some(({ command: c, args: a }) => ${fn})`;
/** Settings has no main action: nothing in it wears the brand */
const SET_NO_BRAND = "document.querySelectorAll('#main .btn.yellow, #main .pill.brand').length === 0";
const SET_IDS = ["general", "games", "connect", "ai", "auto", "cloud", "queue", "daemon", "about"];
const notifyRow = "[...document.querySelectorAll('#set-general .field')].find((f) => f.textContent.startsWith('Conflict notifications'))";
SHOTS.push(
  { name: "set-top", query: "view=settings", size: WINDOW, ready: SET_READY, check: `${SET_NO_BRAND} && document.querySelector('.set-index .on')?.dataset.sec === 'general'` },
  { name: "set-pt-top", query: "view=settings&lang=pt", size: WINDOW, ready: SET_READY, check: SET_NO_BRAND },
  // Each section reached from the index, in English and in Portuguese
  ...SET_IDS.flatMap((id) => ["", "pt-"].map((p) => ({
    name: `set-${p}${id}`, query: `view=settings${p ? "&lang=pt" : ""}`, size: WINDOW, ready: SET_READY,
    then: setClick(id), settle: setStill(`document.querySelector('.set-index [data-sec="${id}"]').classList.contains('on')`), check: setAt(id),
  }))),
  { name: "set-820", query: "view=settings", size: SMALL, ready: SET_READY, check: `getComputedStyle(document.querySelector('.set-index')).display === 'none' && ${SET_NO_BRAND}` },
  { name: "set-pt-820", query: "view=settings&lang=pt", size: SMALL, ready: SET_READY },
  { name: "set-820-queue", query: "view=settings", size: SMALL, ready: SET_READY,
    then: "(() => { const l = document.querySelector('.set-list'); l.scrollTop += document.getElementById('set-queue').getBoundingClientRect().top - l.getBoundingClientRect().top; })()", settle: setStill("true") },
  { name: "set-pt-820-cloud", query: "view=settings&lang=pt", size: SMALL, ready: SET_READY,
    then: "(() => { const l = document.querySelector('.set-list'); l.scrollTop += document.getElementById('set-cloud').getBoundingClientRect().top - l.getBoundingClientRect().top; })()", settle: setStill("true") },
  { name: "set-1920", query: "view=settings", size: BIG, ready: SET_READY, check: SET_NO_BRAND },
  { name: "set-pt-1920-connect", query: "view=settings&lang=pt", size: BIG, ready: SET_READY, then: setClick("connect"), settle: setStill("true"), check: setAt("connect") },
  { name: "set-dev", query: "view=settings&flavor=dev", size: WINDOW, ready: SET_READY, check: SET_NO_BRAND },
  { name: "set-dev-connect", query: "view=settings&flavor=dev", size: WINDOW, ready: SET_READY, then: setClick("connect"), settle: setStill("true"), check: `${setAt("connect")} && ${SET_NO_BRAND}` },
  // The long note behind a section's info button
  { name: "set-info", query: "view=settings", size: WINDOW, ready: SET_READY,
    then: `${setClick("connect")}; document.querySelector('#set-connect .set-info').click()`, settle: setStill("document.querySelector('#set-connect .set-more:not(.hidden)')"),
    check: "document.querySelector('#set-connect .set-info').getAttribute('aria-expanded') === 'true'" },
  // The search: rows that match in several sections, a whole section by its heading, nothing
  { name: "set-search", query: "view=settings", size: WINDOW, ready: SET_READY, then: setType("studio"), settle: "document.querySelector('.set-group.hidden')",
    check: "[...document.querySelectorAll('.set-group:not(.hidden) .field:not(.set-miss)')].every((f) => /studio/i.test(f.textContent + f.querySelector('input')?.getAttribute('aria-label'))) && document.querySelectorAll('.set-group:not(.hidden)').length > 1 && document.querySelector('.set-empty').classList.contains('hidden')" },
  { name: "set-pt-search", query: "view=settings&lang=pt", size: WINDOW, ready: SET_READY, then: setType("fila"), settle: "document.querySelector('.set-group.hidden')",
    check: "!document.getElementById('set-queue').classList.contains('hidden') && !document.querySelector('#set-queue .set-miss') && document.querySelector('.set-index [data-sec=\"general\"]').classList.contains('set-out')" },
  { name: "set-search-none", query: "view=settings", size: WINDOW, ready: SET_READY, then: setType("zzqx"), settle: "!document.querySelector('.set-empty.hidden')",
    check: "document.querySelectorAll('.set-group:not(.hidden)').length === 0 && document.querySelector('.set-empty strong').textContent.includes('zzqx')" },
  { name: "set-pt-search-none", query: "view=settings&lang=pt", size: WINDOW, ready: SET_READY, then: setType("zzqx"), settle: "!document.querySelector('.set-empty.hidden')" },
  // Driven: the language changes live, a switch and a number reach their command with the value
  { name: "set-lang", query: "view=settings", size: WINDOW, ready: SET_READY,
    then: "[...document.querySelectorAll('#set-general .seg button')].find((b) => b.textContent === 'Português').click()",
    settle: `document.querySelector('.set-title h1')?.textContent === 'Configurações' && ${SET_READY}`,
    check: `${setCalled("c === 'set_settings' && a.language === 'pt'")} && document.querySelector('.set-index [data-sec="general"]').textContent === 'Geral' && document.documentElement.lang === 'pt-BR'` },
  { name: "set-notify", query: "view=settings", size: WINDOW, ready: SET_READY, then: `${notifyRow}.querySelector('.tog').click()`, settle: `${notifyRow}?.querySelector('.tog.off')`,
    check: setCalled("c === 'set_settings' && a.notify === false") },
  { name: "set-queue-edit", query: "view=settings", size: WINDOW, ready: SET_READY,
    then: "new Promise((r) => { const i = document.querySelector('#set-queue input[aria-label=\"Lock idle (min)\"]'); i.value = '20'; i.dispatchEvent(new Event('change')); const t = setInterval(() => { const n = document.querySelector('#set-queue input[aria-label=\"Lock idle (min)\"]'); if (n && n !== i && n.value === '20') { clearInterval(t); document.querySelector('.set-index [data-sec=\"queue\"]').click(); r(); } }, 50); })",
    settle: setStill("document.querySelector('.set-index [data-sec=\"queue\"]').classList.contains('on') && document.querySelector('.toast')"),
    check: setCalled("c === 'hub_post' && a.path === '/api/queue/settings' && a.body.settings.lockIdleMin === 20") },
  // A switch far down the page redraws Settings: the page stays where it was
  { name: "set-keep-scroll", query: "view=settings", size: WINDOW, ready: SET_READY,
    then: "new Promise((r) => { document.querySelector('.set-index [data-sec=\"auto\"]').click(); let last = -1; const t = setInterval(() => { const l = document.querySelector('.set-list'); if (l.scrollTop === last && l.scrollTop > 0) { clearInterval(t); window.__keptTop = l.scrollTop; document.querySelector('#set-auto .tog').click(); r(); } last = l.scrollTop; }, 120); })",
    settle: "window.__keptTop !== undefined && document.querySelector('#set-auto .tog.off')",
    check: `Math.abs(document.querySelector('.set-list').scrollTop - window.__keptTop) < 2 && document.querySelector('.set-index .on')?.dataset.sec === 'auto' && ${setCalled("c === 'hub_post' && a.path === '/api/automation' && a.body.global?.review === false")}` },
  // A redraw while searching (here the language) keeps the search and its filter
  { name: "set-search-keep", query: "view=settings", size: WINDOW, ready: SET_READY,
    then: `${setType("studio")}; window.__TAURI__.core.invoke('set_settings', { language: 'pt' })`,
    settle: `document.querySelector('.set-title h1')?.textContent === 'Configurações' && ${SET_READY}`,
    check: "document.querySelector('.set-q').value === 'studio' && document.querySelectorAll('.set-group.hidden').length > 0" },
);

// The AI merge card's other states, and Settings with no game registered
SHOTS.push(
  ...["none", "both", "unknown"].map((which) => ({
    name: `set-ai-${which}`, query: `view=settings&ai=${which}`, size: WINDOW, ready: SET_READY, then: setClick("ai"), settle: setStill("true"),
    check: which === "unknown" ? "!document.querySelector('#set-ai .field') && document.querySelector('#set-ai .note')"
      : which === "both" ? "document.querySelector('#set-ai .seg') && document.querySelector('#set-ai .set-warn')"
      : "document.querySelector('#set-ai .tog.ro') && document.querySelectorAll('#set-ai .note').length === 3",
  })),
  { name: "set-pt-ai-both", query: "view=settings&ai=both&lang=pt", size: WINDOW, ready: SET_READY, then: setClick("ai"), settle: setStill("true") },
  // Remove a game: the first click arms it red (as Folder's and the Queue's), and removes nothing yet
  { name: "set-remove-armed", query: "view=settings", size: WINDOW, ready: SET_READY,
    then: `${setClick("games")}; document.querySelectorAll('#set-games .btn.danger')[1].click()`, settle: setStill("document.querySelector('#set-games .btn.danger.armed')"),
    check: "[...document.querySelectorAll('#set-games .btn.danger')].map((b) => b.classList.contains('armed')).join() === 'false,true,false' && !window.__harness.calls.some((c) => c.args?.path === '/api/unregister')" },
  { name: "set-no-games", query: "view=settings&noGames=1", size: WINDOW, ready: SET_READY, then: setClick("games"), settle: setStill("true"), check: "document.querySelector('#set-games .note')" },
);

// Adding a game: the sidebar's + Add folder and a refused Studio land on the form, in view and
// focused, with any search cleared; the redraws after that keep the reader's place
const SET_FORM_SHOWN = "(() => { const l = document.querySelector('.set-list').getBoundingClientRect(); const f = document.querySelector('.set-form').getBoundingClientRect(); return f.top >= l.top - 1 && f.bottom <= l.bottom + 1; })()";
const SET_GO_REFUSED = "window.__harness.go('register', null, '77001234567890')";
const SET_PLACE_FOCUSED = "document.activeElement === document.querySelector('.set-form input')";
SHOTS.push(
  { name: "set-add-folder", query: "", size: WINDOW, ready: WAIT_LOG, then: "document.querySelector('.side-add').click()",
    settle: `${SET_READY} && ${SET_PLACE_FOCUSED}`,
    check: `${SET_FORM_SHOWN} && document.querySelector('.set-q').value === '' && document.querySelector('.set-index .on')?.dataset.sec === 'games'` },
  { name: "set-register-refused", query: "view=settings&refused=1", size: WINDOW, ready: SET_READY,
    then: `${setType("zzqx")}; ${SET_GO_REFUSED}`,
    settle: `${SET_PLACE_FOCUSED} && document.querySelector('.set-form input').value === '77001234567890'`,
    check: `${SET_FORM_SHOWN} && document.querySelector('.set-q').value === '' && !document.getElementById('set-games').classList.contains('hidden') && document.querySelector('.set-form input[aria-label="Name"]').value === 'Obby Rush'` },
  { name: "set-register-keep", query: "view=settings&refused=1", size: WINDOW, ready: SET_READY,
    then: `new Promise((r) => { ${SET_GO_REFUSED}; const t = setInterval(() => { const p = document.querySelector('.set-form input'); if (p && p.value === '77001234567890' && document.activeElement === p) { clearInterval(t); document.querySelector('.set-index [data-sec="auto"]').click(); let last = -1; const u = setInterval(() => { const l = document.querySelector('.set-list'); if (l.scrollTop === last && l.scrollTop > 0) { clearInterval(u); window.__keptTop = l.scrollTop; document.querySelector('#set-auto .tog').click(); r(); } last = l.scrollTop; }, 120); } }, 50); })`,
    settle: "window.__keptTop !== undefined && document.querySelector('#set-auto .tog.off')",
    check: "Math.abs(document.querySelector('.set-list').scrollTop - window.__keptTop) < 2 && document.querySelector('.set-index .on')?.dataset.sec === 'auto' && document.activeElement !== document.querySelector('.set-form input') && document.querySelector('.set-form input').value === '77001234567890'" },
);

// The model pill says the menu's name for the model ("Opus"), or the default with none known; an
// older hub's single infraWaitSec still draws the queue card
SHOTS.push(
  { name: "set-ai-model", query: "view=settings", size: WINDOW, ready: SET_READY, then: setClick("ai"), settle: setStill("true"),
    check: "document.querySelector('#set-ai button.pill').textContent === 'Opus ▾'" },
  { name: "set-ai-nomodel", query: "view=settings&ai=nomodel", size: WINDOW, ready: SET_READY, then: setClick("ai"), settle: setStill("true"),
    check: "document.querySelector('#set-ai button.pill').textContent === 'Default ▾'" },
  { name: "set-queue-old", query: "view=settings&qsOld=1", size: WINDOW, ready: SET_READY, then: setClick("queue"), settle: setStill("true"),
    check: "document.querySelectorAll('#set-queue .field').length === 13 && document.querySelector('#set-queue input[aria-label=\"Waits between infra tries (s, comma)\"]').value === '15'" },
);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts Edge into `browser` (edge, profile, port as they come), so a failed start is still cleaned up */
async function launchEdge(browser) {
  if (!EDGE) throw new Error("Microsoft Edge was not found");
  browser.profile = fs.mkdtempSync(path.join(os.tmpdir(), "quack-ui-harness-"));
  let spawnError = null;
  browser.edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars=false", `--user-data-dir=${browser.profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  // A process that cannot start emits "error": unhandled, it would end node before the cleanup
  browser.edge.on("error", (error) => {
    spawnError = error;
  });
  const portFile = path.join(browser.profile, "DevToolsActivePort");
  // The file can exist before Edge has written the port: wait for a number on its first line
  const readPort = () => {
    try {
      const first = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
      return /^\d+$/.test(first) ? first : null;
    } catch {
      return null;
    }
  };
  for (let i = 0; i < 150 && !spawnError && browser.edge.exitCode === null && !readPort(); i++) await sleep(100);
  if (spawnError) throw new Error(`Edge did not start: ${spawnError.message}`);
  browser.port = readPort();
  if (!browser.port) throw new Error(`Edge did not open its debugging port in 15 s (exit code ${browser.edge.exitCode})`);
}

/** A request to Edge's own HTTP endpoint, with the same timeout as a CDP command */
const edgeJson = async (port, what) => (await fetch(`http://127.0.0.1:${port}/json/${what}`, { signal: AbortSignal.timeout(20_000) })).json();

const CDP_TIMEOUT_MS = 20_000;

/**
 * One CDP connection: send(method, params) and every event to `onEvent`. A command that gets no
 * answer in 20 s, a socket error or a closed socket rejects, so a capture never hangs.
 */
export function cdp(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  const failAll = (error) => {
    for (const { reject, timer } of waiting.values()) {
      clearTimeout(timer);
      reject(error);
    }
    waiting.clear();
  };
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject, timer } = waiting.get(msg.id);
      clearTimeout(timer);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) onEvent?.(msg);
  });
  ws.addEventListener("close", () => failAll(new Error("the CDP connection closed")));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no CDP connection to ${wsUrl}`)), CDP_TIMEOUT_MS);
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`the CDP connection to ${wsUrl} failed`));
    });
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        send: (method, params = {}) => new Promise((res, rej) => {
          if (ws.readyState !== WebSocket.OPEN) return rej(new Error(`CDP closed before ${method}`));
          const n = ++id;
          const timer = setTimeout(() => {
            waiting.delete(n);
            rej(new Error(`CDP ${method} got no answer in ${CDP_TIMEOUT_MS / 1000} s`));
          }, CDP_TIMEOUT_MS);
          waiting.set(n, { resolve: res, reject: rej, timer });
          ws.send(JSON.stringify({ id: n, method, params }));
        }),
        close: () => ws.close(),
      });
    });
  });
}

export async function waitFor(page, expression, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    // Mid-navigation the page's context can be gone: that read is a "not yet", not an error
    const answer = await page.send("Runtime.evaluate", { expression: `Boolean(${expression})`, returnByValue: true }).catch(() => null);
    if (answer?.result?.value) return true;
    await sleep(80);
  }
  return false;
}

export async function capture({ ui, out, only, prefix = "" }) {
  const unknown = (only ?? []).filter((name) => !SHOTS.some((s) => s.name === name));
  if (unknown.length) throw new Error(`no shot named ${unknown.join(", ")} (known: ${SHOTS.map((s) => s.name).join(", ")})`);
  fs.mkdirSync(out, { recursive: true });
  const server = await serve({ ui });
  const browser = {};
  const report = [];
  try {
    await launchEdge(browser);
    const { port } = browser;
    const list = await edgeJson(port, "list");
    const target = list.find((t) => t.type === "page");
    let events = [];
    const page = await cdp(target.webSocketDebuggerUrl, (msg) => events.push(msg));
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");
    // A first load, thrown away: the first shot of a run read its log scrolled 1 px off the
    // second run's (fonts and caches still cold), which broke before/after comparisons
    await page.send("Emulation.setDeviceMetricsOverride", { ...WINDOW, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url: `${server.url}/?` });
    // A warm-up that never loads leaves the first shot cold: stop rather than compare it
    if (!(await waitFor(page, `${WAIT_LOG} && document.fonts.status === "loaded"`))) throw new Error("the warm-up page never loaded its log and fonts in 8 s");
    await sleep(400);
    for (const shot of SHOTS.filter((s) => !only || only.includes(s.name))) {
      events = [];
      await page.send("Emulation.setDeviceMetricsOverride", { width: shot.size.width, height: shot.size.height, deviceScaleFactor: 1, mobile: false });
      await page.send("Emulation.setDefaultBackgroundColorOverride", shot.background ? { color: shot.background } : {});
      // Page.navigate answers before the new page loads: the old one is marked, and the waits
      // read only a page without the mark (a fresh window), never the previous shot's
      await page.send("Runtime.evaluate", { expression: "window.__harnessStale = true" });
      await page.send("Page.navigate", { url: `${server.url}/${shot.page ?? ""}?${shot.query}` });
      const ready = await waitFor(page, `!window.__harnessStale && (${shot.ready})`);
      let settled = true;
      if (shot.then) {
        await page.send("Runtime.evaluate", { expression: shot.then });
        settled = await waitFor(page, shot.settle ?? "true");
      }
      // Fonts in, the pulse ring still (a frozen frame of it reads as a stray circle), then a beat
      await page.send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => { const s = document.createElement('style'); s.textContent = '.dot.live::after { animation: none !important; opacity: 0 !important; }'; document.head.append(s); })", awaitPromise: true });
      await sleep(400);
      const { data } = await page.send("Page.captureScreenshot", { format: "png" });
      const file = path.join(out, `${prefix}${shot.name}.png`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      const { result } = await page.send("Runtime.evaluate", { expression: "JSON.stringify(window.__harness?.problems ?? ['no harness'])", returnByValue: true });
      const checked = shot.check ? (await page.send("Runtime.evaluate", { expression: `Boolean(${shot.check})`, returnByValue: true })).result.value : true;
      const problems = [
        ...(ready ? [] : [`never ready: ${shot.ready}`]),
        ...(settled ? [] : [`never settled after "${shot.then}": ${shot.settle}`]),
        ...(checked ? [] : [`check failed: ${shot.check}`]),
        ...JSON.parse(result.value),
        ...events.filter((e) => e.method === "Runtime.exceptionThrown").map((e) => `exception: ${e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text}`),
        ...events.filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error").map((e) => `console.error: ${e.params.args.map((a) => a.value ?? a.description).join(" ")}`),
        ...events.filter((e) => e.method === "Log.entryAdded" && e.params.entry.level === "error").map((e) => `log: ${e.params.entry.text} ${e.params.entry.url ?? ""}`),
      ];
      report.push({ shot: shot.name, file, problems });
    }
    page.close();
    const version = await edgeJson(port, "version");
    const control = await cdp(version.webSocketDebuggerUrl);
    await control.send("Browser.close").catch(() => {});
    control.close();
  } finally {
    await server.close();
    // Only the Edge this run started, by its own process handle
    const { edge, profile } = browser;
    if (edge) {
      for (let i = 0; i < 50 && edge.exitCode === null; i++) await sleep(100);
      if (edge.exitCode === null && edge.pid !== undefined) {
        // Killed, then waited for: a process still holding its profile's files blocks the removal
        const exited = new Promise((resolve) => edge.once("exit", resolve));
        edge.kill();
        await Promise.race([exited, sleep(5000)]);
      }
    }
    if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("capture.mjs")) {
  const out = arg("--out");
  if (!out) throw new Error("--out <dir> is required");
  const report = await capture({ ui: arg("--ui"), out, only: arg("--only")?.split(","), prefix: arg("--prefix") ?? "" });
  let bad = 0;
  for (const { shot, file, problems } of report) {
    console.log(`${problems.length ? "PROBLEM" : "ok     "} ${shot.padEnd(16)} ${file}`);
    for (const p of problems) console.log(`          ${p}`);
    bad += problems.length;
  }
  process.exitCode = bad ? 1 : 0;
}
