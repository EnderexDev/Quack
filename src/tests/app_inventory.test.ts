import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The app's UI inventory, frozen before the Quackify redesign (18/11/26). A restyle may move any
// of these, but none may go: each command the windows call, each hub path, each view of the
// navigation, each element the scripts are wired to and each string. A list here only grows.

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "ui");
const read = (name: string) => fs.readFileSync(path.join(ui, name), "utf8").replace(/\r\n/g, "\n");
const js = () => ["main.js", "tray.js", "common.js", "aiview.js", "queueview.js"].map(read).join("\n");
const html = () => ["index.html", "tray.html"].map(read).join("\n");

/**
 * Every Tauri command the windows invoke, with how many places call it: a command called from
 * several views (open_path: the editor button, a finding's file, Folder) stays wired in each
 */
const COMMANDS: Record<string, number> = {
  "ai_clients": 3, "ai_rule": 2, "app_info": 2, "approval_answer": 1, "check_update": 1, "cloud_settings": 1,
  "editors": 1, "get_autostart": 1, "get_settings": 1, "hide_window": 1, "hub_get": 1, "hub_post": 1,
  "install_update": 1, "make_folder": 1, "open_path": 4, "pick_folder": 2, "plugin_version": 1, "project_roots": 1,
  "quit": 1, "read_daemon_config": 1, "restart_hub": 1, "set_autostart": 1, "set_settings": 7, "show_main": 1,
  "tray_fit": 1, "update_status": 1,
};

/** Every event the windows listen to */
const EVENTS = ["hub-state", "settings", "update-ready", "navigate", "tray-shown"];

/** Every hub path the windows call (through hub_get and hub_post), with how many places call it */
const API: Record<string, number> = {
  "/api/ai": 1, "/api/analysis": 1, "/api/analysis/run": 1, "/api/automation": 3, "/api/choice": 2,
  "/api/conflict": 1, "/api/conflict/resolve": 1, "/api/log": 1, "/api/merges": 2, "/api/pause": 2,
  "/api/production-errors": 1, "/api/production-errors/check": 1, "/api/production-errors/dismiss": 1,
  "/api/queue": 1, "/api/queue/force-release": 1, "/api/queue/settings": 2, "/api/queue/unstick": 1,
  "/api/registry": 2, "/api/rename": 1, "/api/setup-candidates": 1, "/api/unregister": 2,
};

/** The tabs of the main window's navigation, and every view it can show */
const NAV_VIEWS = ["output", "playtest", "merges", "analysis", "queue", "folder"];
const VIEWS = [...NAV_VIEWS, "settings", "conflict"];

/** The elements the scripts find by id */
const IDS: Record<string, string[]> = {
  "index.html": ["appUpdate", "ruleUpdate", "hubUpdate", "side", "main", "openCode", "mergeBadge", "analysisBadge"],
  "tray.html": ["tray", "list", "port", "open", "pause", "quit"],
};

/** Strings called by name: t("key"), tn("key") or data-t="key" */
const KEYS = [
  "addFolder", "aiAccount", "aiBanner", "aiBannerAction", "aiCard", "aiCheck", "aiChoose",
  "aiLabel", "aiMerge", "aiModel", "aiModelDefault", "aiModelPick", "aiNone", "aiOffNote",
  "aiPickKeep", "aiPickNote", "aiPickTitle", "aiUnknown", "aiUse", "analysis", "analysisFindings",
  "analysisInfo", "analysisOff", "analysisRerun", "analysisRunning", "appUpdateReady",
  "approvalAccept", "approvalAsk", "approvalCannotAnswer", "approvalExpires", "approvalLabel",
  "approvalNeedsRestart", "approvalRefuse", "approvalSent", "autoCard", "autoFollowGlobal",
  "autoNote", "autoPlace", "autoPlaceNote", "back", "cancel", "checkUpdate", "checkingUpdate",
  "choiceFolderTitle", "choiceStudioTitle", "choiceWaiting", "chooseFolder", "cloudCard",
  "cloudCreator", "cloudEnv", "cloudFile", "cloudIdNumber", "cloudIdPlaceholder", "cloudKey",
  "cloudKeyNew", "cloudKeySaved", "cloudKeySavedShort", "cloudLoading", "cloudNote", "cloudRemove",
  "cloudSave", "conflict", "conflictTitle", "conflicts", "conflictsLabel", "connected",
  "currentHub", "currentStandalone", "currentStudio", "daemon", "daemonOff", "daemonSettings",
  "deleteOrphans", "done", "editorAuto", "editorHint", "editorSetting", "error", "errorsCheck",
  "errorsChecked", "errorsDismiss", "errorsOff", "errorsProblemShort", "errorsTitle",
  "errorsWaiting", "fileGone", "folder", "folderLabel", "folderTab", "hub", "hubLog", "hubOffline",
  "hubOfflineText", "hubOutdated", "hubPort", "hubRestarted", "hunks", "inSync", "installConfirm",
  "installUpdate", "instances", "keep", "keepCurrent", "keepEffectFolder", "keepEffectStudio",
  "kept", "language", "linesAround", "live", "lost", "mcpCard", "mcpConnect", "mcpConnecting",
  "mcpFind", "mcpFinding", "mcpNone", "mcpNote", "mcpRestart", "mergeCrossed", "merges",
  "mergesToday", "methodAi", "methodError", "methodText", "name", "noEditor", "noFolder",
  "noGames", "noMerges", "notOpen", "notify", "offlineGames", "oneConnection", "open",
  "openFolder", "openIn", "openWindow", "openWith", "otherEditor", "output", "pauseAll", "paused",
  "pausedText", "pickGame", "pidPort", "placeId", "playtest", "pluginVersion", "pluginVersionHint",
  "pluginVersionUnknown", "portOnly", "qsSaved", "qsSharedRetry", "queue", "queueAgo",
  "queueAlone", "queueAsked", "queueCapped", "queueCard", "queueFailures", "queueForeignPlay",
  "queueForeignPlayHint", "queueFree", "queueHeldBy", "queueHeldByQueue", "queueHolds",
  "queueInfraTry", "queueJobs", "queueJobsDone", "queueLastCall", "queueLastCovered",
  "queueLastPublish", "queueLive", "queueNoJobs", "queueNoWaiting", "queueNotRun",
  "queueNotRunNote", "queueNote", "queueP50", "queueP90", "queuePassed", "queuePerPlay",
  "queuePhase", "queuePlay", "queuePlayHeld", "queuePlays", "queuePublishPill", "queuePublishing",
  "queueRecent", "queueRecentFail", "queueRecentNotRun", "queueRecentPass", "queueRelease",
  "queueReleaseSure", "queueReleased", "queueRiders", "queueRunning", "queueRush", "queueShared",
  "queueStuck", "queueStuckJob", "queueStuckTries", "queueStudio", "queueToday", "queueUnstick",
  "queueUnstickFailed", "queueUnstickSure", "queueUnsticking", "queueUnstuck", "queueWaiting",
  "queueWasLevel", "quit", "refused", "register", "registered", "remove", "removeConfirm",
  "removeGame", "restartConfirm", "restartHub", "resume", "ruleConnected", "ruleCopied",
  "ruleCopy", "ruleDone", "ruleLabel", "ruleNote", "sameText", "save", "seen", "settings",
  "setupDone", "setupFound", "setupGo", "setupLabel", "setupNewFolder", "setupNewHint",
  "setupNoneFound", "setupNote", "setupUseExisting", "sharedConfig", "startWin", "studioClosed",
  "studioFor", "syncingNow", "takeEffectFolder", "takeEffectStudio", "takeOver", "tooBig",
  "upToDate", "updateLabel", "useDisk", "version", "wantsIn",
];

/** Strings picked by a ternary or a table: present as "key" in the scripts */
const KEYS_INDIRECT = [
  "noLog", "noPlaytest", "qsHistoryDays", "qsLockIdleMin", "qsLockIdleWaitingMin", "qsCapMin",
  "qsHoldSec", "qsReadySec", "qsInfraWaitSec", "qsInfraTries", "qsLingerSec", "qsSharedAll",
  "qsSharedForeign", "qsAgingMin", "qsStuckRetrySec", "qsStuckGiveUpMin", "aiNotInstalled",
  "aiLoggedOut", "mcpHas", "mcpNo", "mcpUpdate", "mcpMissing", "ruleFirst", "ruleChanged",
  "cloudUser", "cloudGroup", "cloudSaved", "cloudRemoved", "analysisNone", "analysisOffText",
  "errorsNone", "errorsOffText",
];

/** Strings built from a template: auto_${f} and auto_${f}_hint, tn's "Many" twins, duration() */
const KEYS_BUILT = [
  ...["review", "panel", "errors", "precommit"].flatMap((f) => [`auto_${f}`, `auto_${f}_hint`]),
  "conflictsMany", "hunksMany", "linesAroundMany", "justNow", "min", "hours",
];

function keysOf(language: "en" | "pt"): Set<string> {
  const text = read("i18n.js");
  const start = text.indexOf(`  ${language}: {`);
  const end = language === "en" ? text.indexOf("  pt: {") : text.indexOf("\n};", start);
  assert.ok(start >= 0 && end > start, `i18n.js has no "${language}" block where this test looks for it`);
  return new Set([...text.slice(start, end).matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

test("app inventory: every command, event and hub path the windows used is still called", () => {
  const code = js();
  const count = (pattern: RegExp) => [...code.matchAll(pattern)].length;
  const gone = Object.entries(COMMANDS)
    .map(([c, n]) => [c, n, count(new RegExp(`invoke\\("${c}"`, "g"))] as const)
    .filter(([, n, seen]) => seen < n)
    .map(([c, n, seen]) => `${c} (${seen} of ${n})`);
  assert.deepEqual(gone, [], `commands called from fewer places: ${gone.join(", ")}`);
  const deaf = EVENTS.filter((e) => !code.includes(`listen("${e}"`));
  assert.deepEqual(deaf, [], `events no longer listened to: ${deaf.join(", ")}`);
  // A path ends at its query, its closing quote or its template's end: /api/queue is not /api/queue/settings
  const paths = Object.entries(API)
    .map(([p, n]) => [p, n, count(new RegExp(`${escape(p)}(?=[?"\`])`, "g"))] as const)
    .filter(([, n, seen]) => seen < n)
    .map(([p, n, seen]) => `${p} (${seen} of ${n})`);
  assert.deepEqual(paths, [], `hub paths called from fewer places: ${paths.join(", ")}`);
});

test("app inventory: every view still has its tab and its renderer, and every wired id is in the page", () => {
  const index = read("index.html");
  const main = read("main.js");
  for (const view of NAV_VIEWS) {
    assert.match(index, new RegExp(`<button class="[^"]*\\bnavlink\\b[^"]*" data-view="${view}"`), `the ${view} tab`);
  }
  for (const view of VIEWS) assert.ok(main.includes(`ui.view === "${view}"`), `the ${view} view`);
  // The tab clicks and the app's own navigation still reach show()
  assert.ok(main.includes(`for (const link of document.querySelectorAll(".navlink")) link.addEventListener("click", () => show(link.dataset.view));`));
  assert.ok(main.includes(`await listen("navigate"`));
  for (const [page, ids] of Object.entries(IDS)) {
    const text = read(page);
    const missing = ids.filter((id) => !text.includes(`id="${id}"`));
    assert.deepEqual(missing, [], `${page} lost ${missing.join(", ")}`);
  }
});

test("app inventory: every string is still shown, in English and Portuguese", () => {
  const code = js();
  const pages = html();
  const en = keysOf("en");
  const pt = keysOf("pt");
  const called = (k: string) => new RegExp(`\\btn?\\("${k}"`).test(code) || pages.includes(`data-t="${k}"`);
  const lost = KEYS.filter((k) => !called(k));
  assert.deepEqual(lost, [], `strings no longer shown: ${lost.join(", ")}`);
  const lostIndirect = KEYS_INDIRECT.filter((k) => !code.includes(`"${k}"`));
  assert.deepEqual(lostIndirect, [], `strings no longer picked: ${lostIndirect.join(", ")}`);
  // The built ones, where they are built: the automation rows, tn's "Many" twin, duration()
  assert.ok(read("main.js").includes("t(`auto_${f}`), h(\"span\", { class: \"hint\" }, t(`auto_${f}_hint`))"), "the automation rows build their strings");
  assert.ok(read("main.js").includes(`const AUTO_FEATURES = ["review", "panel", "errors", "precommit", "tests", "playTests"]`), "the six automation features (Quack Test's two last)");
  const i18n = read("i18n.js");
  assert.ok(i18n.includes("return t(n === 1 ? key : `${key}Many`, { n });"), "tn picks the Many twin");
  for (const key of ["conflicts", "hunks", "linesAround"]) assert.ok(code.includes(`tn("${key}"`), `tn("${key}") is still shown`);
  for (const call of ['t("justNow")', 't("min", ', 't("hours", ']) assert.ok(i18n.includes(call), `duration() still says ${call}`);
  assert.ok(code.includes("duration("), "duration() is still shown");
  for (const k of [...KEYS, ...KEYS_INDIRECT, ...KEYS_BUILT]) {
    assert.ok(en.has(k), `${k} in English`);
    assert.ok(pt.has(k), `${k} in Portuguese`);
  }
});
