// The main window: games on the left, the chosen game's output, playtest, merges and folder
// on the right, plus the conflict view and settings.
import { api, h, invoke, listen, nameOf, popIn, shortPath, start, toast } from "./common.js";
import { applyStatic, duration, getLanguage, t, tn } from "./i18n.js";
import { every } from "./idle.js";
import { modelChoice, modelLabel, modelPill } from "./aiview.js";
import { jobWait, knownFields, recentOf, runningFirst, stuckOf, todayOf } from "./queueview.js";

const LOG_LINES_KEPT = 3000;
const LOG_POLL_MS = 1000;
const MERGES_POLL_MS = 2000;
/** Above this many cells the line diff is skipped and both versions are shown whole */
const DIFF_MAX_CELLS = 4_000_000;
const CONTEXT_LINES = 3;

const ui = {
  /** A new version of the app, downloaded and waiting for the click */
  update: null,
  /** The rule for AI this install ships ({ version, text }), for the notice */
  rule: null,
  /** The app's version and the build of the hub it ships (null in a debug run) */
  app: { version: "", build: null },
  settings: { hubPort: 3826, language: "en" },
  hub: { online: false },
  placeId: null,
  view: "output",
  conflictId: null,
  register: null,
  /** The code editors on this computer, the one "Open in …" uses first (Rust ranks them) */
  editors: [],
};
const logs = new Map(); // placeId -> { next, lines, reading }
let contentKey = "";
let mergesTimer;
let queueTimer;
/** Bumped on every content render: an async view drops its work once a newer one started */
let generation = 0;

const side = document.getElementById("side");
const main = document.getElementById("main");
const openCode = document.getElementById("openCode");
const mergeBadge = document.getElementById("mergeBadge");
const analysisBadge = document.getElementById("analysisBadge");

const compact = (n) => (n === undefined || n === null ? "–" : new Intl.NumberFormat("en", { notation: "compact" }).format(n));
const state = () => ui.hub.state;
const placeOf = (placeId) => state()?.places.find((p) => p.placeId === placeId);
const sessionOf = (placeId) => state()?.sessions.find((s) => s.placeId === placeId);
const fail = (error) => toast(t("error", { e: error }), true);

// ---------- Log ----------

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const SYMBOL_CLASS = { "✓": "ok", "+": "ok", "~": "chg", "−": "del", "ℹ": "info", "⚠": "warn", "✗": "err" };

/** One raw log line (colour codes still in) into what the views show */
function parseLine(raw) {
  // Playtest levels survive only as colours: red for errors, yellow for warnings
  const level = raw.includes("\x1b[31m") ? "err" : raw.includes("\x1b[33m") ? "warn" : "";
  const text = raw.replace(ANSI, "").replace(/\r$/, "");
  if (!text.trim()) return null;
  // One playtest message per log line: the daemon writes its own line breaks as U+2028
  let m = /^\s+(\d\d:\d\d:\d\d)\.\d+\s{2}(.*)\s{2}-\s{2}(Server|Client)$/s.exec(text);
  if (m) return { play: true, time: m[1], msg: m[2].replaceAll("\u2028", "\n"), src: m[3], level };
  m = /^\[(\d\d:\d\d:\d\d)\.\d+\]\s(\S+)\s?(.*)$/.exec(text);
  if (m) return { play: false, time: m[1], sym: m[2], msg: m[3], level };
  if (text.startsWith("=====")) return { play: false, sep: true, msg: text.replace(/=+/g, "").trim() };
  return { play: false, time: "", sym: "", msg: text, level };
}

function lineNode(line) {
  if (line.sep) return h("div", { class: "ln sep" }, `── ${line.msg} ──`);
  if (line.play) {
    return h("div", { class: `ln ${line.level}` }, h("span", { class: "t" }, line.time), "  ", h("span", { class: "msg" }, line.msg), "  ", h("span", { class: "src" }, line.src));
  }
  const cls = SYMBOL_CLASS[line.sym] ?? "";
  return h("div", { class: `ln ${line.level}` }, h("span", { class: "t" }, line.time), " ", h("span", { class: cls }, line.sym), " ", h("span", { class: `msg ${cls === "warn" || cls === "err" ? cls : ""}` }, line.msg));
}

async function readLog(placeId) {
  const place = placeOf(placeId);
  if (!place) return;
  let log = logs.get(placeId);
  // A place registered again to another folder has another log: its cursor and lines go
  const moved = log !== undefined && log.folder !== place.folder;
  if (!log || moved) {
    log = { folder: place.folder, next: undefined, lines: [], reading: false };
    logs.set(placeId, log);
  }
  if (log.reading) return;
  log.reading = true;
  try {
    const from = log.next === undefined ? "" : `&from=${log.next}`;
    const chunk = await api.get(`/api/log?placeId=${placeId}${from}&ansi=1`);
    // Replaced while this read was out: the answer belongs to the old folder
    if (logs.get(placeId) !== log) return;
    if (moved) chunk.reset = true;
    if (chunk.reset) log.lines = [];
    log.next = chunk.next;
    const fresh = chunk.text.split("\n").map(parseLine).filter(Boolean);
    if (fresh.length || chunk.reset) {
      // A 1 MB chunk of short lines is too many for push(...spread): keep only what is retained
      for (const line of fresh.slice(-LOG_LINES_KEPT)) log.lines.push(line);
      if (log.lines.length > LOG_LINES_KEPT) log.lines.splice(0, log.lines.length - LOG_LINES_KEPT);
      if (placeId === ui.placeId) appendLog(fresh, chunk.reset);
    }
  } catch {
    // the hub went away: the next state tick says so
  } finally {
    log.reading = false;
  }
}

/** Add lines to the open log view, keeping it pinned to the bottom if it was */
function appendLog(lines, reset) {
  const box = document.getElementById("log");
  if (!box || (ui.view !== "output" && ui.view !== "playtest")) return;
  const playtest = ui.view === "playtest";
  if (reset) box.replaceChildren();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const shown = lines.filter((l) => l.play === playtest);
  if (!shown.length && box.childElementCount) return;
  box.querySelector(".empty")?.remove();
  for (const line of shown.slice(-LOG_LINES_KEPT)) box.append(lineNode(line));
  while (box.childElementCount > LOG_LINES_KEPT) box.firstElementChild.remove();
  if (!box.childElementCount) box.append(h("div", { class: "empty" }, t(playtest ? "noPlaytest" : "noLog")));
  if (atBottom || reset) box.scrollTop = box.scrollHeight;
}

every(LOG_POLL_MS, () => {
  if (ui.hub.online && ui.placeId && (ui.view === "output" || ui.view === "playtest")) readLog(ui.placeId);
});

// ---------- Sidebar and header ----------

let sideKey = "";
let topKey = "";

function renderSide() {
  const s = state();
  // Redrawn only when what it shows changes: rebuilding the button under the pointer every
  // second would restart its hover lift
  const key = JSON.stringify([ui.hub.online, ui.placeId, ui.view, getLanguage(),
    s?.places.map((p) => [p.placeId, p.name, p.conflicts]),
    s?.sessions.map((x) => [x.placeId, x.studioConnected]),
    s?.refused.map((r) => [r.placeId, r.placeName])]);
  if (key === sideKey) return;
  sideKey = key;
  side.replaceChildren();
  if (!ui.hub.online || !s) return;
  const sessions = new Map(s.sessions.map((x) => [x.placeId, x]));
  const connected = s.places.filter((p) => sessions.get(p.placeId)?.studioConnected);
  const others = s.places.filter((p) => !sessions.get(p.placeId)?.studioConnected);
  const item = (place, dot) => h("button", {
    class: `game${place.placeId === ui.placeId && ui.view !== "settings" ? " sel" : ""}`,
    onclick: () => select(place.placeId, ui.view === "settings" || ui.view === "conflict" ? "output" : ui.view),
  }, h("span", { class: `dot ${place.conflicts ? "warn" : dot}` }), h("b", { class: "grow" }, nameOf(place)));
  if (connected.length) side.append(h("span", { class: "label" }, t("connected")), ...connected.map((p) => item(p, "live")));
  if (others.length) side.append(h("span", { class: "label" }, t("offlineGames")), ...others.map((p) => item(p, "")));
  if (s.refused.length) {
    side.append(h("span", { class: "label" }, t("refused")), ...s.refused.map((r) => h("button", {
      class: "game", onclick: () => openRegister(r),
    }, h("span", { class: "dot bad" }), h("b", { class: "grow" }, nameOf(r)))));
  }
  // Below the games: add one, and Settings, lit like a picked game while it is open
  side.append(
    h("span", { class: "grow" }),
    h("button", { class: "side-add", onclick: () => openRegister(null) }, t("addFolder")),
    h("button", { class: `game${ui.view === "settings" ? " sel" : ""}`, onclick: () => show("settings") }, h("span", { class: "ico sliders" }), h("b", { class: "grow" }, t("settings"))),
  );
}

function renderNav() {
  applyStatic();
  for (const link of document.querySelectorAll(".navlink")) {
    link.classList.toggle("on", link.dataset.view === ui.view || (ui.view === "conflict" && link.dataset.view === "merges"));
    link.disabled = !ui.placeId;
  }
  const place = placeOf(ui.placeId);
  mergeBadge.textContent = place?.conflicts ?? "";
  mergeBadge.classList.toggle("hidden", !place?.conflicts);
  // The panel's findings and the production errors not yet dismissed
  const flagged = (place?.findings ?? 0) + (place?.newErrors ?? 0);
  analysisBadge.textContent = flagged || "";
  analysisBadge.classList.toggle("hidden", !flagged);
  // Rebuilt only when it changes: the nav renders on every state poll
  const key = place && ui.view !== "settings" && ui.editors.length ? `${place.folder}\n${ui.editors.map((e) => e.id)}\n${getLanguage()}` : "";
  if (key !== openCodeKey) {
    openCodeKey = key;
    openCode.replaceChildren(key ? editorButtons(place.folder, "yellow") : "");
  }
}

let openCodeKey = "";

/**
 * Asks the app for the editors again; the views redraw only when the order changed. Coming back
 * from the editor changes its lastUsed every time, and a redraw for that alone would rebuild the
 * view (and a half-typed form) on each return.
 */
async function loadEditors() {
  const editors = await invoke("editors").catch(() => []);
  const order = (list) => list.map((e) => `${e.id}:${e.name}`).join();
  if (order(editors) === order(ui.editors)) return;
  ui.editors = editors;
  contentKey = "";
  renderMain();
}

/**
 * "Open in {editor}", the one picked or else the one used last, and a ▾ with the others when
 * there are any. An editor picked in that list stays the one this button opens (Settings goes
 * back to the one used last).
 */
function editorButtons(path, look) {
  const [first] = ui.editors;
  if (!first) return h("button", { class: `btn ${look} press`, disabled: true }, t("noEditor"));
  const open = h("button", { class: `btn ${look} press`, onclick: () => invoke("open_path", { path, editor: true }).catch(fail) }, t("openIn", { name: first.name }));
  if (ui.editors.length < 2) return open;
  const more = h("button", { class: `btn ${look} press more`, title: t("otherEditor"), "aria-label": t("otherEditor"), "aria-haspopup": "menu" }, "▾");
  more.addEventListener("click", () => editorMenu(more, path));
  return h("span", { class: "split" }, open, more);
}

function editorMenu(anchor, path) {
  const pick = (editor) => async () => {
    try {
      await invoke("set_settings", { editor: editor.id });
      await invoke("open_path", { path, editor: true });
    } catch (error) {
      fail(error);
    }
  };
  popMenu(anchor, `editor:${path}`, t("openWith"), ui.editors.map((editor, i) => ({ label: editor.name, on: i === 0, pick: pick(editor) })));
}

/**
 * A small menu under `anchor`, right-aligned to it: a title and one button per item. A second
 * click on the same anchor (same key) closes it; so do a click outside and Escape. Whatever
 * closes it also drops its window listeners (closeMenu), not only its element. With no room
 * below it opens above the anchor, and it never leaves the window (placeMenu).
 */
let closeMenu = null;
function popMenu(anchor, key, title, items) {
  const openKey = document.querySelector(".menu")?.dataset.key;
  closeMenu?.();
  document.querySelector(".menu")?.remove();
  if (openKey === key) return;
  const close = () => {
    menu.remove();
    removeEventListener("pointerdown", outside, true);
    removeEventListener("keydown", escape, true);
    if (closeMenu === close) closeMenu = null;
  };
  closeMenu = close;
  const outside = (event) => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) close();
  };
  const escape = (event) => {
    if (event.key === "Escape") {
      close();
      anchor.focus();
    }
  };
  const menu = h("div", { class: "menu chunk", role: "menu", dataset: { key } },
    h("span", { class: "label" }, title),
    items.map((item) => h("button", { role: "menuitem", class: item.on ? "on" : "", onclick: () => { close(); item.pick(); } }, item.label)));
  document.body.append(menu);
  placeMenu(menu, anchor);
  popIn(menu);
  addEventListener("pointerdown", outside, true);
  addEventListener("keydown", escape, true);
  // The saved pick takes the focus, so focus and pick never show as two marked items
  (menu.querySelector("button.on") ?? menu.querySelector("button"))?.focus();
}

/**
 * Puts an appended menu half a rem from its anchor, right edges lined up: below it, or above it
 * when it does not fit below and does above; then pushed inside the window, half a rem from
 * every edge. Measured in rem, so the gap grows with the window as the rest does.
 */
function placeMenu(menu, anchor) {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const gap = 0.5 * rem;
  const at = anchor.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  const fitsBelow = at.bottom + gap + box.height <= innerHeight - gap;
  const up = !fitsBelow && at.top - gap - box.height >= gap;
  const top = up ? at.top - gap - box.height : Math.min(at.bottom + gap, innerHeight - gap - box.height);
  const left = Math.min(Math.max(gap, at.right - box.width), innerWidth - gap - box.width);
  menu.style.top = `${Math.max(gap, top)}px`;
  menu.style.left = `${Math.max(gap, left)}px`;
  menu.classList.toggle("up", up);
}

function header(place) {
  const session = sessionOf(place.placeId);
  const status = session?.studioConnected
    ? h("span", { class: "pill live" }, h("span", { class: "dot live" }), t("studioFor", { d: duration(Date.now() - session.studioSince) }))
    : h("span", { class: "pill" }, h("span", { class: "dot" }), session ? t("studioClosed") : t("daemonOff"));
  // The name with the game's main action beside it (#openCode, moved in by renderMain), then
  // Studio's state first among the facts
  return h("div", { class: "head" },
    h("div", { class: "head-row" }, h("h1", { class: "display", title: nameOf(place) }, nameOf(place))),
    h("div", { class: "meta" },
      status,
      h("span", { class: "pill mono" }, `place ${place.placeId}`),
      session && h("span", { class: "pill mono" }, `pid ${session.daemonPid} · :${session.daemonPort}`),
      h("span", { class: "pill mono", title: place.folder }, shortPath(place.folder))));
}

function stats(place) {
  const session = sessionOf(place.placeId);
  const stat = (value, label, extra = "", onclick) => h("div", { class: `stat${onclick ? " link" : ""} ${extra}`, onclick },
    h("span", { class: "v" }, value), h("span", { class: "label" }, label));
  return h("div", { class: "stats" },
    stat(compact(session?.instances), t("instances")),
    stat(String(place.today), t("mergesToday"), "", () => show("merges")),
    stat(String(place.conflicts), place.conflicts === 1 ? t("conflict") : t("conflictsLabel"), place.conflicts ? "warn" : "", () => show("merges")));
}

/** Stops what the current content view runs in the background, and outdates its pending work */
function stopContent() {
  mergesTimer?.stop();
  queueTimer?.stop();
  analysisTimer?.stop();
  generation++;
}

/** Header and numbers redraw on every state tick; the content below only when it changes */
/**
 * A hub left running by an older install keeps its old code until it restarts. Restarting is a
 * click with a confirmation: every Studio drops for a few seconds and reconnects on its own.
 */
let updateKey = "";
let restartArmed = false;
/** True from the confirming click until restart_hub returns, which can take 15 s */
let restarting = false;
let disarmTimer;
function renderUpdate() {
  const bar = document.getElementById("hubUpdate");
  // A hub from before build ids reports none: that one is outdated too. Not shown while a new
  // version waits: installing it restarts the hub anyway
  const outdated = Boolean(!ui.update && ui.app.build && ui.hub.online && state()?.build !== ui.app.build);
  // The hub does not take this app's approval token (another Quack started it, or the token
  // file was lost): writes cannot be accepted until a restart gives it this app's token. Never
  // restarted by itself: on Official that drops the live game's sync for a few seconds
  const noToken = Boolean(ui.hub.online && ui.hub.approvalsAnswerable === false);
  const key = JSON.stringify([outdated, noToken, restartArmed, restarting, getLanguage()]);
  if (key === updateKey) return;
  updateKey = key;
  bar.classList.toggle("hidden", !outdated && !noToken);
  if (!outdated && !noToken) return;
  const restart = h("button", { class: "btn yellow chunk-bright press" }, restartArmed ? t("restartConfirm") : t("restartHub"));
  // Every redraw while a restart runs keeps the button off: a second one would race the first
  restart.disabled = restarting;
  restart.addEventListener("click", async () => {
    if (restarting) return;
    if (!restartArmed) {
      restartArmed = true;
      renderUpdate();
      disarmTimer = setTimeout(() => {
        restartArmed = false;
        renderUpdate();
      }, 5000);
      return;
    }
    clearTimeout(disarmTimer);
    restarting = true;
    renderUpdate();
    try {
      await invoke("restart_hub");
      toast(t("hubRestarted"));
    } catch (error) {
      fail(error);
    }
    restarting = false;
    restartArmed = false;
    renderUpdate();
  });
  bar.replaceChildren(h("span", { class: "pill brand" }, t("updateLabel")), h("span", { class: "grow" }, outdated ? t("hubOutdated") : t("approvalNeedsRestart")), restart);
}

/**
 * A new version downloaded in the background. One click installs it: the app closes, the
 * installer puts the new one in place and starts it, and it restarts the hub. Studio drops for a
 * few seconds, so the click asks for a confirmation like "Restart hub".
 */
let appUpdateKey = "";
let installArmed = false;
let installing = false;
let installDisarm;
function renderAppUpdate() {
  const bar = document.getElementById("appUpdate");
  const version = ui.update;
  const key = JSON.stringify([version, installArmed, installing, getLanguage()]);
  if (key === appUpdateKey) return;
  appUpdateKey = key;
  bar.classList.toggle("hidden", !version);
  if (!version) return;
  const install = h("button", { class: "btn yellow chunk-bright press" }, installArmed ? t("installConfirm") : t("installUpdate"));
  install.disabled = installing;
  install.addEventListener("click", async () => {
    if (installing) return;
    if (!installArmed) {
      installArmed = true;
      renderAppUpdate();
      installDisarm = setTimeout(() => {
        installArmed = false;
        renderAppUpdate();
      }, 5000);
      return;
    }
    clearTimeout(installDisarm);
    installing = true;
    renderAppUpdate();
    try {
      // Does not come back when it works: the installer closes this app
      await invoke("install_update");
    } catch (error) {
      // The download stays ready in the app: the button can be clicked again
      fail(error);
    }
    installing = false;
    installArmed = false;
    renderAppUpdate();
  });
  bar.replaceChildren(h("span", { class: "pill brand" }, t("updateLabel")), h("span", { class: "grow" }, t("appUpdateReady", { version })), install);
}

function renderMain() {
  renderAppUpdate();
  renderRuleNotice();
  renderUpdate();
  renderNav();
  renderSide();
  if (!ui.hub.online) {
    if (contentKey === "offline") return;
    stopContent();
    contentKey = "offline";
    main.replaceChildren(h("div", { class: "offline" },
      h("h2", { class: "display" }, t("hubOffline")),
      h("p", { class: "muted", style: "margin:0;line-height:1.6" }, t("hubOfflineText", { port: ui.settings.hubPort })),
      h("p", { class: "mono muted", style: "margin:0" }, t("hubLog"))));
    return;
  }
  if (ui.view === "settings") return renderContent();
  const place = placeOf(ui.placeId);
  if (!place) {
    const key = `none|${state().places.length}`;
    if (contentKey === key) return;
    stopContent();
    contentKey = key;
    main.replaceChildren(h("div", { class: "offline" }, h("p", { class: "muted" }, state().places.length ? t("pickGame") : t("noGames")),
      h("button", { class: "btn yellow chunk-bright press", onclick: () => openRegister(null) }, t("addFolder"))));
    return;
  }
  let top = document.getElementById("top");
  if (!top || contentKey === "offline" || contentKey.startsWith("none")) {
    contentKey = "";
    top = h("div", { id: "top", class: "top" });
    main.replaceChildren(top, h("div", { id: "content", class: "content" }));
  }
  const session = sessionOf(place.placeId);
  const key = JSON.stringify([place, session && { ...session, studioSince: undefined }, state().paused, state().ai?.state, ui.view, getLanguage(),
    session?.studioSince ? Math.floor((Date.now() - session.studioSince) / 60000) : 0]);
  if (key === topKey && top.childElementCount) return renderContent();
  topKey = key;
  const banner = state().paused
    ? h("div", { class: "card chunk row" }, h("span", { class: "pill" }, t("paused")), h("span", { class: "grow" }, t("pausedText")),
      h("button", { class: "btn yellow chunk-bright press", onclick: () => api.post("/api/pause", { paused: false }).catch(fail) }, t("resume")))
    : null;
  // Both AIs and no choice: every merge that needs the AI keeps Studio's version until a pick
  const aiBanner = state().ai?.state === "choose"
    ? h("div", { class: "card chunk row" }, h("span", { class: "pill brand" }, t("aiLabel")), h("span", { class: "grow" }, t("aiBanner")),
      h("button", { class: "btn yellow chunk-bright press", onclick: () => show("settings") }, t("aiBannerAction")))
    : null;
  top.replaceChildren(...[banner, aiBanner, header(place), ui.view !== "conflict" ? stats(place) : null].filter(Boolean));
  // "Open in …" sits beside the game's name: it opens this game's folder
  top.querySelector(".head-row").append(openCode);
  renderContent();
}

// ---------- Content views ----------

function renderContent() {
  // Settings also redraw when the registered games change (a game added or removed)
  const games = ui.view === "settings" ? JSON.stringify(state()?.places.map((p) => [p.placeId, p.folder])) : "";
  const key = `${ui.view}|${ui.placeId}|${ui.conflictId}|${getLanguage()}|${games}`;
  if (key === contentKey) return;
  contentKey = key;
  stopContent();
  const target = ui.view === "settings" ? main : document.getElementById("content");
  if (!target) return;
  if (ui.view === "settings") return renderSettings(target);
  if (ui.view === "output" || ui.view === "playtest") return renderLog(target);
  if (ui.view === "merges") return renderMerges(target);
  if (ui.view === "folder") return renderFolder(target);
  if (ui.view === "queue") return renderQueue(target);
  if (ui.view === "analysis") return renderAnalysis(target);
  if (ui.view === "conflict") return renderConflict(target);
}

function renderLog(target) {
  const playtest = ui.view === "playtest";
  const box = h("div", { class: "log mono", id: "log" });
  target.replaceChildren(h("div", { class: "panel" },
    h("div", { class: "panel-top" }, h("span", { class: "label" }, playtest ? t("playtest") : t("daemon")), h("span", { class: "grow" }), h("span", { class: "pill live" }, t("live"))),
    box));
  const lines = (logs.get(ui.placeId)?.lines ?? []).filter((l) => l.play === playtest);
  box.append(...(lines.length ? lines.map(lineNode) : [h("div", { class: "empty" }, t(playtest ? "noPlaytest" : "noLog"))]));
  box.scrollTop = box.scrollHeight;
  readLog(ui.placeId);
}

const hhmm = (iso) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(getLanguage() === "pt" ? "pt-BR" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(getLanguage() === "pt" ? "pt-BR" : "en-GB", { day: "2-digit", month: "2-digit" })} ${time}`;
};

/** A script's path as its folder and its file name, for a name read at a glance over a quiet folder */
const splitPath = (file = "") => {
  const at = file.lastIndexOf("/");
  return at < 0 ? ["", file] : [file.slice(0, at), file.slice(at + 1)];
};

/** A merge's time in a row: seconds under one, ms below that */
const mergeMs = (ms) => (ms === undefined ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * An empty state: its first sentence as the heading, the rest under it. The strings were written
 * as one paragraph ("No merges yet. When ..."); split here, so the text stays exactly as it was
 */
function emptyState(text) {
  const at = text.indexOf(". ");
  return at < 0 ? h("div", { class: "empty" }, text)
    : h("div", { class: "empty" }, h("strong", {}, text.slice(0, at + 1)), text.slice(at + 2));
}

async function renderMerges(target) {
  const list = h("div", { class: "list mlist" });
  target.replaceChildren(h("div", { class: "panel" }, h("div", { class: "panel-top" }, h("span", { class: "label" }, t("merges"))), list));
  const placeId = ui.placeId;
  const mine = generation;
  let pending = false;
  const fill = async () => {
    // A slow hub must not pile up requests: a tick that finds one out skips its turn
    if (pending) return;
    pending = true;
    let merges;
    try {
      merges = await api.get(`/api/merges?placeId=${placeId}`);
    } catch (error) {
      if (mine === generation) fail(error);
      return;
    } finally {
      pending = false;
    }
    if (mine !== generation) return;
    // Unresolved conflicts older than the listed history still need a row to be opened from
    const listed = new Set(merges.entries.map((e) => e.agentVersion).filter(Boolean));
    const rows = [...merges.conflicts.filter((c) => !listed.has(c.agentVersion)), ...merges.entries];
    if (!rows.length) return list.replaceChildren(emptyState(t("noMerges")));
    list.replaceChildren(...rows.map((entry) => {
      // A conflict older than the history comes with its file and id only: no time, no method
      const method = entry.method === "ai" ? h("span", { class: "pill sky" }, t("methodAi"))
        : entry.method === "error" ? h("span", { class: "pill bad" }, t("methodError"))
        : entry.method ? h("span", { class: "pill" }, t("methodText")) : h("span");
      const waiting = entry.agentVersion && !entry.resolved;
      const action = entry.agentVersion
        ? entry.resolved
          ? h("span", { class: "result" }, t("seen"))
          : h("button", { class: "pill warn", onclick: () => show("conflict", entry.agentVersion) }, entry.conflictingHunks ? tn("hunks", entry.conflictingHunks) : t("open"), h("span", { class: "chev" }, "›"))
        : h("span", { class: "result mono" }, mergeMs(entry.ms));
      const [dir, name] = splitPath(entry.file);
      return h("div", { class: `mrow${waiting ? " waiting" : ""}${entry.method === "error" ? " failed" : ""}` },
        h("span", { class: "time mono" }, entry.t ? hhmm(entry.t) : ""),
        h("span", { class: "file", title: entry.error ? `${entry.file}: ${entry.error}` : entry.file }, h("b", {}, name), h("span", { class: entry.error ? "dir why" : "dir mono" }, entry.error || dir)),
        method, action);
    }));
  };
  await fill();
  // Left before the first answer came: no timer for a view that is gone
  if (mine === generation) mergesTimer = every(MERGES_POLL_MS, fill);
}

// ---------- Analysis: the findings panel, the production errors, what runs on its own ----------

const ANALYSIS_POLL_MS = 2000;
const AUTO_FEATURES = ["review", "panel", "errors", "precommit", "tests", "playTests"];

/**
 * One row per feature that runs on its own (Settings: for every game; a game's Analysis tab: for
 * that game, which may differ). A game's own value shows a way back to the global one.
 */
function autoRows(view, placeId) {
  return AUTO_FEATURES.map((f) => {
    const on = placeId ? !!view.effective?.[placeId]?.[f] : !!view.settings.global[f];
    const own = placeId ? view.settings.places?.[placeId]?.[f] : undefined;
    const set = async (value) => {
      try {
        await api.post("/api/automation", placeId ? { placeId, values: { [f]: value } } : { global: { [f]: value } });
        contentKey = "";
        renderContent();
      } catch (error) {
        fail(error);
      }
    };
    const hook = f === "precommit" && placeId ? view.precommitHooks?.[placeId] : undefined;
    const hookPill = hook && hook !== "installed" && hook !== "not installed" ? h("span", { class: "pill warn", title: hook }, hook) : null;
    const back = own !== undefined ? h("button", { class: "pill", onclick: () => set(null) }, t("autoFollowGlobal")) : null;
    return h("div", { class: "field" }, h("span", { class: "grow" }, t(`auto_${f}`), h("span", { class: "hint" }, t(`auto_${f}_hint`))), hookPill, back, toggle(on, () => set(!on)));
  });
}

function automationCard(view) {
  const card = h("div", { class: "card chunk" }, h("span", { class: "label" }, t("autoCard")));
  if (!view) return card.append(h("p", { class: "note bad" }, t("error", { e: "the hub has no automation" }))), card;
  card.append(...autoRows(view, null), h("p", { class: "note" }, t("autoNote")));
  return card;
}

let analysisTimer;
async function renderAnalysis(target) {
  const place = placeOf(ui.placeId);
  const placeId = place.placeId;
  const mine = generation;
  // No height cap on the lists: the view is the one scroll, never a scroll inside a scroll
  const findings = h("div", { class: "list alist" });
  const findingsInfo = h("span", { class: "ainfo" });
  const rerun = h("button", { class: "btn sm press" }, t("analysisRerun"));
  const errors = h("div", { class: "list alist" });
  const errorsInfo = h("span", { class: "ainfo" });
  const dismiss = h("button", { class: "btn sm ghost press hidden" }, t("errorsDismiss"));
  const check = h("button", { class: "btn sm press" }, t("errorsCheck"));
  const own = h("div", { class: "card" }, h("span", { class: "label" }, t("autoPlace")));
  target.replaceChildren(h("div", { class: "view analysis" },
    h("div", { class: "panel apanel" },
      h("div", { class: "panel-top" }, h("span", { class: "label" }, t("analysisFindings")), findingsInfo, h("span", { class: "grow" }), rerun),
      findings),
    h("div", { class: "panel apanel" },
      h("div", { class: "panel-top" }, h("span", { class: "label" }, t("errorsTitle")), errorsInfo, h("span", { class: "grow" }), dismiss, check),
      errors),
    own));
  // A finding's file in the editor the app found or the user picked (its name and its line are buttons)
  const open = (where) => {
    const file = `${place.folder}\\${where.replace(/:\d+$/, "").replace(/\//g, "\\")}`;
    return invoke("open_path", { path: file, editor: true }).catch(fail);
  };
  /**
   * One finding or error: its line (opens the file), the rule or side, the message. Without a
   * line the cell holds `bare` (an error's hash when it names no script) or nothing
   */
  const row = (where, rule, message, pill, extra, bare = "") => {
    const line = /:(\d+)$/.exec(where ?? "");
    return h("div", { class: "frow" },
      where && line
        ? h("button", { class: "file mono", title: where, onclick: () => open(where) }, `:${line[1]}`)
        : h("span", { class: "file mono", title: where ?? "" }, bare),
      h("span", { class: `pill ${pill}`, title: rule }, rule),
      h("span", { class: "msg", title: message }, message),
      extra);
  };
  /** Rows grouped by file, in the order each file first shows up: the file's name, its folder and how many */
  const grouped = (items) => {
    const groups = new Map();
    for (const item of items) {
      const key = item.file ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups].map(([file, list]) => {
      const [dir, name] = splitPath(file);
      const head = file
        ? h("button", { class: "fhead", title: file, onclick: () => open(file) }, h("b", {}, name), h("span", { class: "dir mono" }, dir), h("span", { class: "pill mono" }, list.length))
        : null;
      return h("div", { class: "fgroup" }, head, ...list.map((item) => item.row));
    });
  };
  let pending = false;
  let lastPanel = "";
  let lastErrors = "";
  const fill = async () => {
    if (pending) return;
    pending = true;
    let panel;
    let prod;
    try {
      [panel, prod] = await Promise.all([api.get(`/api/analysis?placeId=${placeId}`), api.get(`/api/production-errors?placeId=${placeId}`)]);
    } catch (error) {
      if (mine === generation) fail(error);
      return;
    } finally {
      pending = false;
    }
    if (mine !== generation) return;
    const panelKey = JSON.stringify(panel);
    if (panelKey !== lastPanel) {
      lastPanel = panelKey;
      rerun.disabled = panel.state === "off";
      findingsInfo.textContent = panel.state === "off" ? t("analysisOff")
        : panel.state === "error" ? t("error", { e: panel.error })
        : panel.at === undefined ? t("analysisRunning")
        : t("analysisInfo", { n: panel.findings.length, scripts: panel.scripts ?? "?", s: ((panel.ms ?? 0) / 1000).toFixed(1), at: hhmm(new Date(panel.at).toISOString()) }) + (panel.state === "running" ? ` · ${t("analysisRunning")}` : "");
      findingsInfo.className = `ainfo${panel.state === "error" ? " bad" : panel.state === "running" || panel.at === undefined ? " busy" : ""}`;
      findings.replaceChildren(...(panel.findings.length
        ? grouped(panel.findings.map((f) => ({ file: f.file, row: row(`${f.file}:${f.line}`, f.rule, f.message, "warn") })))
        // An analysis that failed says so in its info line: "nothing found" would contradict it
        : panel.state === "error" ? [] : [emptyState(t(panel.state === "off" ? "analysisOffText" : panel.at === undefined ? "analysisRunning" : "analysisNone"))]));
    }
    const errorsKey = JSON.stringify(prod);
    if (errorsKey !== lastErrors) {
      lastErrors = errorsKey;
      check.disabled = prod.state === "off";
      dismiss.classList.toggle("hidden", !prod.fresh.length);
      errorsInfo.textContent = prod.state === "off" ? t("errorsOff")
        : prod.state === "problem" ? t("errorsProblemShort")
        : prod.checkedAt ? t("errorsChecked", { at: hhmm(new Date(prod.checkedAt).toISOString()) }) : t("errorsWaiting");
      errorsInfo.className = `ainfo${prod.state === "problem" ? " bad" : ""}`;
      // An error with no script line has no file to group under or open: its hash stands alone
      errors.replaceChildren(...(prod.state === "problem" ? [h("p", { class: "note bad aproblem" }, prod.problem)] : []),
        ...(prod.fresh.length
          ? grouped(prod.fresh.slice().reverse().map((e) => ({
            file: e.at ? e.at.replace(/:\d+$/, "") : undefined,
            // An empty or missing field falls back like a missing one: no "undefined×", no "#undefi"
            row: row(e.at || e.hash, e.source || "?", e.message || (e.hash ? `hash ${e.hash}` : "?"), e.source === "Server" ? "bad" : "sky",
              Number.isFinite(e.count) ? h("span", { class: "pill mono", title: `${e.count}×` }, `${e.count}×`) : null, e.at || !e.hash ? "" : `#${String(e.hash).slice(0, 6)}`),
          })))
          // A key that cannot read the errors says so above: "no new error" would contradict it
          : prod.state === "problem" ? [] : [emptyState(t(prod.state === "off" ? "errorsOffText" : "errorsNone"))]));
    }
  };
  rerun.addEventListener("click", () => api.post("/api/analysis/run", { placeId }).then(fill).catch(fail));
  dismiss.addEventListener("click", () => api.post("/api/production-errors/dismiss", { placeId }).then(fill).catch(fail));
  check.addEventListener("click", async () => {
    check.disabled = true;
    try {
      await api.post("/api/production-errors/check", { placeId });
      lastErrors = "";
      await fill();
    } catch (error) {
      fail(error);
    } finally {
      check.disabled = false;
    }
  });
  const view = await api.get("/api/automation").catch(() => null);
  if (mine !== generation) return;
  if (view) own.append(...autoRows(view, placeId), h("p", { class: "note" }, t("autoPlaceNote")));
  await fill();
  if (mine === generation) analysisTimer = every(ANALYSIS_POLL_MS, fill);
}

// ---------- Queue ----------

const QUEUE_POLL_MS = 1500;
/** A short wait: seconds under a minute, else what duration() says */
const span = (ms) => (ms == null ? "–" : ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : duration(ms));
const who = (client) => client?.name || client?.id || "?";

/** A square slot (.slot, controls.css) in a state's colour, "lg" for a block's big one: a glyph (.ico.i-<glyph>) or a short text, a place in line */
const qslot = (kind, glyph, text) => h("span", { class: `slot${kind ? ` ${kind}` : ""}` }, glyph ? h("span", { class: `ico i-${glyph}` }) : text);

/** One line of the Queue: its slot, the name with a hint under it, its pills, and a time at the end */
function qrow({ slot, name, hint, mono = true, hintTitle, bad = false, title, tags = [], time, timeTitle }) {
  const pills = tags.filter(Boolean);
  return h("div", { class: "qrow", title },
    slot,
    h("div", { class: `qmain${bad ? " bad" : ""}` }, h("b", {}, name), hint ? h("span", { class: `hint${mono ? " mono" : ""}`, title: hintTitle ?? hint }, hint) : null),
    pills.length ? h("div", { class: "qtags" }, ...pills) : null,
    time === undefined ? null : h("span", { class: "qtime mono", title: timeTitle }, time));
}

/** A card's heading: the label, and what sits at its right end */
const qhead = (label, ...end) => h("div", { class: "qhead" }, h("span", { class: "label" }, label), h("span", { class: "grow" }), ...end);

/**
 * The place's Studio queue: who holds Studio and for how long, who waits (level and wait), the
 * tests queued and running, the play, and the day's speed. Free the lock frees it, whoever holds
 * it (armed by a first click, as Remove is); it is a danger action, never the screen's main one.
 */
async function renderQueue(target) {
  const body = h("div", { class: "view queue" });
  target.replaceChildren(body);
  const placeId = ui.placeId;
  const mine = generation;
  let pending = false;
  let armed = false;
  let unstickArmed = false;
  let unsticking = false;
  let lastStuck = null;
  const fill = async () => {
    if (pending) return;
    pending = true;
    let q;
    try {
      q = await api.get(`/api/queue?placeId=${placeId}`);
    } catch (error) {
      if (mine === generation) body.replaceChildren(h("div", { class: "empty qfail" }, qslot("bad lg", "alert"), h("span", {}, t("error", { e: error }))));
      return;
    } finally {
      pending = false;
    }
    if (mine !== generation) return;

    const release = h("button", { class: `btn danger press${armed ? " armed" : ""}` }, armed ? t("queueReleaseSure") : t("queueRelease"));
    release.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        release.textContent = t("queueReleaseSure");
        release.classList.add("armed");
        setTimeout(() => {
          armed = false;
        }, 3000);
        return;
      }
      armed = false;
      await api.post("/api/queue/force-release", { placeId }).then(() => toast(t("queueReleased"))).catch(fail);
      fill();
    });
    // Studio refusing every play start (decision 24), or a play Quack did not start up in Studio
    // (a Local Server test): the jobs wait instead of failing, and the button stops the play left
    // up in Studio (armed by a first click, as Free the lock is)
    // While the stop runs (9 to 13 s) the hub may already report no stuck state: the row stays,
    // saying it works, so the click is not followed by a row that just vanishes
    const stuck = stuckOf(q, Date.now()) ?? (unsticking ? lastStuck : null);
    if (stuck) lastStuck = stuck;
    let stuckRow = null;
    if (stuck) {
      // The poll redraws the card while the POST is out: the flag keeps the new button disabled
      const unstick = h("button", { class: `btn danger press${unstickArmed ? " armed" : ""}`, disabled: unsticking }, unsticking ? t("queueUnsticking") : unstickArmed ? t("queueUnstickSure") : t("queueUnstick"));
      unstick.addEventListener("click", async () => {
        if (unsticking) return;
        if (!unstickArmed) {
          unstickArmed = true;
          unstick.textContent = t("queueUnstickSure");
          unstick.classList.add("armed");
          setTimeout(() => {
            unstickArmed = false;
          }, 3000);
          return;
        }
        unstickArmed = false;
        unsticking = true;
        unstick.disabled = true;
        unstick.textContent = t("queueUnsticking");
        // Success in his language (the hub's message is English and the toast was easy to miss);
        // a refusal keeps the hub's reason, which says what to do in Studio
        await api.post("/api/queue/unstick", { placeId })
          .then((r) => (r?.ok === false ? toast(r?.message || t("queueUnstickFailed"), true) : toast(t("queueUnstuck"), false, 6000)))
          .catch(fail)
          .finally(() => {
            unsticking = false;
          });
        fill();
      });
      const foreign = stuck.kind === "foreign-play";
      // The one red block of the tab: everything waits on it
      stuckRow = h("div", { class: "qalert" },
        qslot("bad", "alert"),
        h("div", { class: "qmain bad" }, h("b", {}, stuck.kind === "foreign-play" ? t("queueForeignPlay", { d: span(stuck.forMs) }) : t("queueStuck", { d: span(stuck.forMs) })),
          h("span", { class: "hint", title: stuck.error }, foreign ? t("queueForeignPlayHint") : [t("queueStuckTries", { n: stuck.tries }), stuck.error].filter(Boolean).join(" · "))),
        unstick);
    }

    // Studio: the lock first, in a big line (free is green), then what holds the queue back
    const holder = q.holder;
    const studio = h("div", { class: "card qcard qstudio" },
      qhead(t("queueStudio"), h("span", { class: "pill qphase" }, t("queuePhase"), h("b", { class: "mono" }, q.phase))),
      h("div", { class: `qlock${holder ? "" : " free"}` },
        qslot(holder ? "lg" : "live lg", holder ? "lock" : "unlock"),
        h("div", { class: "qmain" },
          h("b", {}, holder ? (holder.runner ? t("queueHeldByQueue", { d: span(holder.heldMs) }) : t("queueHeldBy", { who: who(holder.client), d: span(holder.heldMs) })) : t("queueFree")),
          holder && h("span", { class: "hint" }, [holder.requestedMin ? t("queueAsked", { n: holder.requestedMin }) : null, t("queueLastCall", { d: span(holder.idleMs), tool: holder.tool })].filter(Boolean).join(" · "))),
        holder ? release : null),
      stuckRow,
      q.cap?.active ? h("p", { class: "note" }, t("queueCapped", { who: q.cap.clientId })) : null,
      q.publish?.current ? qrow({
        slot: qslot("sky", "up"),
        name: t("queuePublishing", { who: who(q.publish.current.client), d: span(q.publish.current.ms) }),
        hint: q.publish.current.head ? q.publish.current.head.slice(0, 8) : null,
        tags: [q.publish.current.riders?.length ? h("span", { class: "pill sky" }, t("queueRiders", { n: q.publish.current.riders.length })) : null],
      }) : null,
      q.publish?.last ? h("p", { class: "note" }, [
        t("queueLastPublish", { what: q.publish.last.version !== undefined ? `v${q.publish.last.version}` : (q.publish.last.head ?? "").slice(0, 8), who: who(q.publish.last.client), d: span(Date.now() - q.publish.last.at) }),
        q.publish.last.covered?.length ? t("queueLastCovered", { n: q.publish.last.covered.length }) : null].filter(Boolean).join(" · ")) : null);

    // Tests: the running one first (green), then the queued ones by their place in line
    // An empty card is one line: its label, and the empty text at the other end
    const noJobs = !q.jobs.length && !q.play;
    const jobs = h("div", { class: `card qcard${noJobs ? " none" : ""}` }, qhead(t("queueJobs"), noJobs ? h("span", { class: "qnone" }, t("queueNoJobs")) : null));
    let inLine = 0;
    for (const j of runningFirst(q.jobs, q.running?.id)) {
      const running = q.running?.id === j.id;
      const wait = jobWait(j);
      if (!running) inLine++;
      jobs.append(qrow({
        slot: running ? qslot("live", "run") : qslot(wait === "stuck" ? "bad" : wait === "infra" ? "warn" : "", null, String(inLine)),
        name: j.name,
        hint: `${who(j.client)} · ${shortPath(j.root)}`,
        hintTitle: j.root,
        tags: [
          running ? h("span", { class: "pill live" }, t("queueRunning")) : null,
          wait === "stuck" ? h("span", { class: "pill bad", title: j.stuck.last ?? "" }, t("queueStuckJob")) : null,
          wait === "infra" ? h("span", { class: "pill warn", title: j.infra.last }, t("queueInfraTry", { n: j.infra.tries, d: span(j.infra.retryInMs) })) : null,
          j.alone ? h("span", { class: "pill sky" }, t("queueAlone")) : null],
        time: span(running ? q.running.ms : j.waitedMs),
      }));
    }
    if (q.play) {
      jobs.append(qrow({
        slot: qslot("", "play"),
        name: t("queuePlay"),
        hint: q.play.roots.map(shortPath).join(" + "),
        hintTitle: q.play.roots.join("\n"),
        tags: [q.play.held ? h("span", { class: "pill warn" }, t("queuePlayHeld", { who: q.play.held.client, d: span(q.play.held.leftMs) })) : null],
        time: span(Date.now() - q.play.since),
      }));
    }

    // Who waits for Studio, in line; the level pill is neutral (the brand stays off this tab)
    const waiting = h("div", { class: `card qcard${q.waiters.length ? "" : " none"}` }, qhead(t("queueWaiting"), q.waiters.length ? null : h("span", { class: "qnone" }, t("queueNoWaiting"))));
    q.waiters.forEach((w, i) => waiting.append(qrow({
      slot: qslot(w.rush ? "bad" : "", null, String(i + 1)),
      name: who(w.client),
      // The task, then how long it asks to hold Studio (the commit of a publish rides in its pill)
      hint: [w.task, `~${w.holdMin} min`].filter(Boolean).join(" · "),
      mono: false,
      tags: [
        w.rush ? h("span", { class: "pill bad" }, t("queueRush")) : null,
        w.publish ? h("span", { class: "pill warn", title: w.publish.commit ?? "" }, w.publish.commit ? `${t("queuePublishPill")} ${w.publish.commit.slice(0, 8)}` : t("queuePublishPill"))
          : w.exclusive ? h("span", { class: "pill sky" }, t("queueLive")) : null,
        h("span", { class: "pill strong", title: w.effectiveLevel !== w.level ? t("queueWasLevel", { level: w.level }) : "" }, w.effectiveLevel)],
      time: span(w.waitedMs),
    })));

    // The day's answers (decision 25): a job that never ran is red and says so, never a result
    const recent = recentOf(q);
    const answers = recent.length ? h("div", { class: "card qcard" }, qhead(t("queueRecent"))) : null;
    for (const r of recent) {
      const notRun = r.verdict === "infra";
      const pass = r.verdict === "pass";
      answers.append(qrow({
        slot: qslot(pass ? "live" : notRun ? "bad" : "warn", pass ? "check" : notRun ? "alert" : "cross"),
        name: r.name,
        bad: notRun,
        title: r.reason ?? "",
        hint: [who(r.client), notRun ? r.reason : span(r.ms)].filter(Boolean).join(" · "),
        tags: [pass ? h("span", { class: "pill live" }, t("queueRecentPass"))
          : r.verdict === "fail" ? h("span", { class: "pill warn", title: r.reason ?? "" }, t("queueRecentFail"))
            : h("span", { class: "pill bad", title: r.reason ?? "" }, t("queueRecentNotRun"))],
        time: t("queueAgo", { d: span(Date.now() - r.at) }),
        timeTitle: new Date(r.at).toLocaleTimeString(),
      }));
    }

    const d = q.today;
    const stat = (value, label, kind = "") => h("div", { class: `stat${kind ? ` ${kind}` : ""}` }, h("span", { class: "v" }, value), h("span", { class: "label" }, label));
    const { notRun, failures } = todayOf(d);
    // A hub that counts the not-run jobs apart gets their own tile; p50 and p90 share one so the
    // row keeps six tiles
    const stats = notRun === null
      ? [
        stat(String(d.jobs), t("queueJobsDone")),
        stat(String(d.passed), t("queuePassed")),
        stat(`${d.plays}`, `${t("queuePlays")} (${d.sharedPlays} ${t("queueShared")})`),
        stat(d.jobsPerPlay == null ? "–" : String(d.jobsPerPlay), t("queuePerPlay")),
        stat(span(d.queueP50Ms), t("queueP50")),
        stat(span(d.queueP90Ms), t("queueP90"))]
      : [
        stat(String(d.jobs), t("queueJobsDone")),
        stat(String(d.passed), t("queuePassed")),
        stat(String(notRun), t("queueNotRun"), notRun > 0 ? "bad" : ""),
        stat(`${d.plays}`, `${t("queuePlays")} (${d.sharedPlays} ${t("queueShared")})`),
        stat(d.jobsPerPlay == null ? "–" : String(d.jobsPerPlay), t("queuePerPlay")),
        stat(span(d.queueP50Ms), `${t("queueP50")} (p90 ${span(d.queueP90Ms)})`)];
    const today = h("div", { class: "card qcard qtoday" },
      qhead(t("queueToday")),
      h("div", { class: "stats qstats" }, ...stats),
      failures.length ? h("div", { class: "field" }, h("span", { class: "grow" }, t("queueFailures")), ...failures.map(([k, n]) => h("span", { class: "pill warn" }, `${k} ${n}`))) : null,
      notRun ? h("p", { class: "note" }, t("queueNotRunNote", { n: notRun })) : null,
      h("p", { class: "note" }, `${d.grants} ${t("queueHolds", { n: d.grantsCapped })}`));

    // The lock on top, then now (the tests, who waits), then the day (answers and numbers): one
    // column, so a row keeps its name readable beside its pills at every width
    body.replaceChildren(...[studio, jobs, waiting, answers, today].filter(Boolean));
  };
  await fill();
  if (mine === generation) queueTimer = every(QUEUE_POLL_MS, fill);
}

/**
 * The game's folder and its registration: the folder, the place id, what lives there, opening it,
 * and Remove from Quack as the danger action (armed by a first click: the button turns red and
 * the line under the buttons says what removing does).
 */
function renderFolder(target) {
  const place = placeOf(ui.placeId);
  // The registry never keeps a place without a folder; a game removed meanwhile lands here
  if (!place?.folder) {
    target.replaceChildren(h("div", { class: "view folder" }, h("div", { class: "empty" }, qslot("lg", "folder"), h("strong", {}, t("folder")), t("noFolder"))));
    return;
  }
  let armed = false;
  const sure = h("p", { class: "note bad hidden" }, t("removeConfirm", { name: nameOf(place) }));
  const remove = h("button", { class: "btn danger press", "aria-label": `${t("removeGame")}: ${nameOf(place)}` }, t("removeGame"));
  remove.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      remove.classList.add("armed");
      sure.classList.remove("hidden");
      remove.setAttribute("aria-label", t("removeConfirm", { name: nameOf(place) }));
      setTimeout(() => {
        armed = false;
        remove.classList.remove("armed");
        sure.classList.add("hidden");
        remove.setAttribute("aria-label", `${t("removeGame")}: ${nameOf(place)}`);
      }, 4000);
      return;
    }
    try {
      await api.post("/api/unregister", { placeId: place.placeId });
      ui.placeId = null;
      toast(t("done"));
    } catch (error) {
      fail(error);
    }
  });
  target.replaceChildren(h("div", { class: "view folder" }, h("div", { class: "card fcard" },
    h("span", { class: "label" }, t("folder")),
    h("div", { class: "place" }, qslot("lg", "folder"), h("div", { class: "grow" }, h("b", {}, nameOf(place)), h("span", { class: "mono" }, place.folder))),
    h("div", { class: "field" }, h("span", { class: "grow" }, t("placeId")), h("span", { class: "mono muted" }, place.placeId)),
    h("p", { class: "note" }, t("folderTab")),
    h("div", { class: "actions" },
      h("button", { class: "btn light press", onclick: () => invoke("open_path", { path: place.folder, editor: false }).catch(fail) }, t("openFolder")),
      h("span", { class: "grow" }), remove),
    // Under the buttons, so the armed one stays where the second click lands
    sure)));
}

/** Line diff by longest common subsequence: [op, aIndex, bIndex] with op "=", "a" or "b" */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push(["=", i++, j++]);
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) ops.push(["a", i++, -1]);
    else ops.push(["b", -1, j++]);
  }
  while (i < n) ops.push(["a", i++, -1]);
  while (j < m) ops.push(["b", -1, j++]);
  return ops;
}

function codeLine(no, text, cls = "") {
  return h("div", { class: `ln ${cls}` }, h("span", { class: "no" }, no), text);
}

/** Both panes show only the changed stretches, with a few unchanged lines around each */
function diffPanes(current, saved) {
  // The panes hold code only: each side's name, count and choice are around it (renderConflict)
  const left = h("div", { class: "pane mono" });
  const right = h("div", { class: "pane mono" });
  if (current === null) {
    left.append(h("div", { class: "gap" }, t("fileGone")));
    saved.split("\n").forEach((line, i) => right.append(codeLine(i + 1, line, "lost")));
    return [left, right, null];
  }
  const a = current.split("\n");
  const b = saved.split("\n");
  if (a.length * b.length > DIFF_MAX_CELLS) {
    a.forEach((line, i) => left.append(codeLine(i + 1, line)));
    b.forEach((line, i) => right.append(codeLine(i + 1, line)));
    return [left, right, t("tooBig")];
  }
  const ops = diffLines(a, b);
  const changed = ops.map((op) => op[0] !== "=");
  // Nothing differs any more: both whole, so the choice is still made over the text it keeps
  if (!changed.some(Boolean)) {
    a.forEach((line, i) => left.append(codeLine(i + 1, line)));
    b.forEach((line, i) => right.append(codeLine(i + 1, line)));
    return [left, right, t("sameText")];
  }
  const near = ops.map((_, k) => {
    for (let d = -CONTEXT_LINES; d <= CONTEXT_LINES; d++) if (changed[k + d]) return true;
    return false;
  });
  let skipped = 0;
  const flushGap = () => {
    if (!skipped) return;
    for (const pane of [left, right]) pane.append(h("div", { class: "gap" }, `⋯ ${tn("linesAround", skipped)}`));
    skipped = 0;
  };
  ops.forEach(([op, ai, bi], k) => {
    if (!near[k]) {
      skipped++;
      return;
    }
    flushGap();
    if (op === "=") {
      left.append(codeLine(ai + 1, a[ai]));
      right.append(codeLine(bi + 1, b[bi]));
    } else if (op === "a") left.append(codeLine(ai + 1, a[ai], "kept"));
    else right.append(codeLine(bi + 1, b[bi], "lost"));
  });
  flushGap();
  return [left, right, null];
}

async function renderConflict(target) {
  const placeId = ui.placeId;
  const id = ui.conflictId;
  const mine = generation;
  target.replaceChildren(h("div", { class: "empty" }, "…"));
  let view;
  try {
    view = await api.get(`/api/conflict?placeId=${placeId}&id=${encodeURIComponent(id)}`);
  } catch (error) {
    if (mine !== generation) return;
    fail(error);
    return show("merges");
  }
  if (mine !== generation) return;
  const entry = await api.get(`/api/merges?placeId=${placeId}`).then((m) => m.entries.find((e) => e.agentVersion === id)).catch(() => undefined);
  if (mine !== generation) return;
  const [left, right, note] = diffPanes(view.current, view.saved);
  const resolve = (action) => async () => {
    try {
      await api.post("/api/conflict/resolve", { placeId, id, action });
      toast(t("done"));
      show("merges");
    } catch (error) {
      fail(error);
    }
  };
  // A conflict older than the merge history has no entry: no time and no method to show
  const method = entry ? (entry.method === "ai" ? t("methodAi") : t("methodText")) : "";
  const [dir] = splitPath(view.file);
  /** One side: its name and how many lines only it has, its code, and the button that makes it win */
  const side = (label, pane, only, cls, choice) => h("div", { class: "cf-side" },
    h("div", { class: "cf-head" }, h("span", { class: "label grow" }, label), only ? h("span", { class: `pill mono ${cls}` }, `+${only}`) : null),
    pane,
    h("div", { class: "actions" }, choice));
  // What it is over the full width; the script's name with what can be done to it beside it
  target.replaceChildren(h("div", { class: "view conflict" },
    h("div", { class: "cf-title" },
      h("div", { class: "cf-meta" },
        h("span", { class: "label" }, [t("conflictTitle"), entry?.t ? hhmm(entry.t) : "", method].filter(Boolean).join(" · ")),
        entry?.conflictingHunks ? h("span", { class: "pill warn" }, h("span", { class: "dot warn" }), tn("hunks", entry.conflictingHunks)) : null),
      h("div", { class: "cf-name" },
        h("h1", { class: "display grow", title: view.file }, view.file.split("/").pop()),
        h("div", { class: "actions" },
          editorButtons(view.path, "sm"),
          h("button", { class: "btn sm ghost press", onclick: () => show("merges") }, h("span", { class: "chev" }, "‹"), t("back")))),
      h("div", { class: "cf-path mono" }, dir ? `${dir} · ${id}` : id)),
    note ? h("p", { class: "note cf-note" }, note) : null,
    // Each side's choice sits under its own code: the left keeps the merge, the right takes the disk's text
    h("div", { class: "diff" },
      side(t("kept"), left, left.querySelectorAll(".kept").length, "live", h("button", { class: "btn press", onclick: resolve("keep") }, t("keep"))),
      side(t("lost"), right, right.querySelectorAll(".lost").length, "bad", h("button", { class: "btn yellow press", onclick: resolve("useDisk") }, t("useDisk"))))));
}

function toggle(on, onclick, readOnly = false) {
  return h("button", { class: `tog${on ? "" : " off"}${readOnly ? " ro" : ""}`, onclick: readOnly ? undefined : onclick, "aria-pressed": on ? "true" : "false" });
}

const AI_NAMES = { claude: "Claude Code", codex: "Codex" };

/**
 * The AI merge offers only what this computer has: nothing = off, with what to install; one =
 * that one; both = a choice. The hub checks the CLIs and refuses a choice it cannot run.
 */
function aiCard(ai) {
  const redraw = () => {
    contentKey = "";
    renderContent();
  };
  const check = h("button", { class: "btn sm press" }, t("aiCheck"));
  check.addEventListener("click", () => {
    check.disabled = true;
    ui.aiRefresh = true;
    redraw();
  });
  const card = h("div", { class: "card set-group" }, setHead(t("aiCard"), check));
  if (!ai) {
    card.append(h("p", { class: "note" }, t("aiUnknown")));
    return card;
  }
  const { effective, settings, usable, detected } = ai;
  const set = (body) => api.post("/api/ai", body).then(redraw).catch(fail);
  const none = usable.length === 0;
  const on = !none && settings.ai;
  // The model of the AI in use: a menu of its models, or read-only from a hub without the lists
  const model = modelPill(ai) || (effective.provider === "codex" ? t("aiModelDefault") : "");
  // The menu's name for it ("Opus", not "opus"); a menu with no model known yet still says what it picks
  const shown = model ? modelLabel(model) : t("aiModelDefault");
  const choice = modelChoice(ai);
  let pill = null;
  if (choice) {
    pill = h("button", { class: "pill strong", title: t("aiModelPick"), "aria-haspopup": "menu" }, shown, " ▾");
    const items = choice.options.map((o) => ({
      label: o.value ? modelLabel(o.value) : t("aiModelDefault"),
      on: o.on,
      pick: () => set({ [choice.field]: o.value }),
    }));
    pill.addEventListener("click", () => popMenu(pill, "ai-model", t("aiModel", { name: AI_NAMES[choice.provider] }), items));
  } else if (model) {
    pill = h("span", { class: "pill strong" }, shown);
  }
  // What the switch does now, one line under its name (the choice to make has its own warning)
  const now = none || effective.state === "choose" ? null
    : effective.state === "off" ? t("aiOffNote")
    : t("aiAccount", { name: AI_NAMES[effective.provider] });
  card.append(h("div", { class: "field" },
    h("span", { class: "grow" }, t("aiMerge"), now ? h("span", { class: "hint" }, now) : null),
    pill,
    toggle(on, () => set({ ai: !on }), none)));
  if (usable.length === 2 && settings.ai) {
    const pick = (provider) => h("button", { class: settings.provider === provider || effective.provider === provider ? "on" : "", onclick: () => set({ provider }) }, AI_NAMES[provider]);
    card.append(h("div", { class: "field" }, h("span", { class: "grow" }, t("aiUse")), h("span", { class: "seg" }, pick("claude"), pick("codex"))));
  }
  if (none) {
    card.append(h("p", { class: "note" }, t("aiNone")));
    for (const provider of ["claude", "codex"]) {
      const status = detected[provider];
      card.append(h("p", { class: "note mono" }, t(status.installed ? "aiLoggedOut" : "aiNotInstalled", { name: AI_NAMES[provider] })));
    }
  } else if (effective.state === "choose") {
    card.append(h("p", { class: "note set-warn" }, t("aiChoose")));
  }
  return card;
}

/**
 * What a connect puts in place: the MCP server, Quack's rule in the AI's instructions and, in
 * Claude Code, Quack's guard. A folder missing any of them (an older rule, a folder connected
 * before the guard existed) needs connecting again.
 */
const aiNeeds = (c) => c.installed && (!c.connected || c.guarded === false || c.reviewed === false || c.rule === "outdated" || c.rule === "missing");
const aiState = (c) => c.problem ? c.problem : t(!c.installed ? "mcpMissing" : !c.connected ? "mcpNo" : aiNeeds(c) ? "mcpUpdate" : "mcpHas");

/**
 * Connect to AI asks first: every Claude Code, Codex and Cursor config folder found, each with a
 * box, and only the ones ticked are written. The folders ticked last time come ticked; with no
 * choice saved yet, only each AI's default folder does, so an account folder (a T3 Code provider,
 * ~/.claude-*) gets Quack only when the user ticks it. Resolves with the connect's result, or
 * null when closed without connecting.
 */
function aiConnectDialog() {
  return new Promise((resolve) => {
    document.getElementById("aiConnect")?.remove();
    const list = h("div", { class: "setup-options" }, h("p", { class: "note" }, t("mcpFinding")));
    const go = h("button", { class: "btn yellow chunk-bright press", disabled: true }, t("mcpConnect"));
    const cancel = h("button", { class: "btn ghost press" }, t("cancel"));
    const picked = new Set();
    let clients = [];
    let busy = false;
    let dialog;
    const close = (result) => {
      dialog.remove();
      resolve(result);
    };
    const paint = () => {
      go.disabled = busy || !picked.size;
      go.textContent = busy ? t("mcpConnecting") : picked.size ? `${t("mcpConnect")} (${picked.size})` : t("mcpConnect");
    };
    const row = (c) => {
      const box = h("input", { type: "checkbox", class: "checkbox", disabled: !c.installed || busy });
      box.checked = picked.has(c.id);
      box.addEventListener("change", () => {
        if (box.checked) picked.add(c.id); else picked.delete(c.id);
        paint();
      });
      return h("label", { class: `setup-option ai-option${c.installed ? "" : " off"}` },
        box,
        h("div", { class: "grow" }, h("b", {}, c.label), c.dir ? h("span", { class: "mono muted", title: c.dir }, c.dir) : null),
        // Its state in its own colour; the brand stays on Connect
        h("span", { class: c.problem ? "pill bad" : !c.connected ? "pill" : aiNeeds(c) ? "pill warn" : "pill live", title: c.problem ?? "" }, aiState(c)));
    };
    const show = (found) => {
      clients = found;
      list.replaceChildren(...clients.map(row));
      if (!clients.some((c) => c.installed)) list.append(h("p", { class: "note" }, t("mcpNone")));
      paint();
    };
    go.addEventListener("click", async () => {
      if (busy || !picked.size) return;
      busy = true;
      cancel.disabled = true;
      show(clients);
      const only = [...picked];
      try {
        const result = await invoke("ai_clients", { connect: true, only });
        if (result.error) throw new Error(result.error);
        // A saved choice for a folder not found today stays for the day it is back
        const present = new Set(clients.map((c) => c.id));
        const kept = (ui.settings.aiTargets ?? []).filter((id) => !present.has(id));
        await invoke("set_settings", { aiTargets: [...kept, ...only] }).catch(() => {});
        close({ ...result, only });
      } catch (error) {
        fail(error);
        busy = false;
        cancel.disabled = false;
        show(clients);
      }
    });
    cancel.addEventListener("click", () => close(null));
    dialog = h("div", { id: "aiConnect", class: "overlay" },
      h("div", { class: "card chunk dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "aiConnectTitle" },
        h("div", { class: "dlg-head" },
          h("div", { class: "grow" },
            h("span", { class: "label" }, t("mcpCard")),
            h("h2", { class: "display", id: "aiConnectTitle" }, t("aiPickTitle")))),
        h("p", {}, t("aiPickNote")),
        list,
        h("div", { class: "dlg-foot" }, h("p", { class: "dlg-hint" }, t("aiPickKeep")), cancel, go)));
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        close(null);
      }
    });
    document.body.append(dialog);
    popIn(dialog.firstChild);
    cancel.focus();
    invoke("ai_clients", { connect: false })
      .then((result) => {
        if (result?.error && !Array.isArray(result.clients)) throw new Error(result.error);
        const saved = Array.isArray(ui.settings.aiTargets) ? new Set(ui.settings.aiTargets) : null;
        for (const c of result.clients) {
          if (c.installed && (saved ? saved.has(c.id) : !c.id.includes(":"))) picked.add(c.id);
        }
        show(result.clients);
        go.focus();
      })
      .catch((error) => {
        list.replaceChildren(h("p", { class: "note bad" }, String(error?.message ?? error)));
      });
  });
}

/**
 * Connect to AI in Settings: what each AI folder has, and the button that opens the dialog to
 * choose which of them to set up.
 */
function mcpCard() {
  const list = h("div", { class: "set-rows" });
  const button = h("button", { class: "btn light press" }, t("mcpFind"));
  const card = h("div", { class: "card set-group" }, setHead(t("mcpCard"), button), setNote(t("mcpNoteShort"), t("mcpNote")), list);
  let found = null;
  // Connected and current is live, connected but behind needs an update, a problem is an error
  const look = (c) => c.problem ? "pill bad" : !c.connected ? "pill" : aiNeeds(c) ? "pill warn" : "pill live";
  const paint = (clients) => {
    list.replaceChildren(...clients.map((c) => h("div", { class: "field" },
      h("span", { class: "grow" }, c.label),
      h("span", { class: look(c), title: c.problem ?? "" }, aiState(c)))));
    if (!clients.some((c) => c.installed)) list.append(h("p", { class: "note" }, t("mcpNone")));
  };
  const show = (clients) => {
    found = clients;
    ui.mcpClients = clients;
    paint(clients);
  };
  // The last answer at once: a redraw of Settings (a toggle, the language) keeps the page's height
  // instead of growing the list back under the reader's eyes
  if (ui.mcpClients) paint(ui.mcpClients);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const result = await aiConnectDialog();
      if (!result) return;
      show(result.clients);
      if (result.clients.some((c) => result.only.includes(c.id) && c.connected)) toast(t("mcpRestart"), "info");
    } finally {
      button.disabled = false;
    }
  });
  // What each AI has, as soon as the card opens: an update shows without a first click
  invoke("ai_clients", { connect: false }).then((result) => { if (!found && Array.isArray(result?.clients)) show(result.clients); }).catch(() => {});
  card.append(h("div", { class: "field" }, h("span", { class: "grow" }, t("ruleOther"), h("span", { class: "hint", title: t("ruleNote") }, t("ruleHintShort"))), ruleButton()));
  return card;
}

/**
 * Copy rule for AI: `rule --prompt` to the clipboard. The text is fetched when the card is drawn,
 * so the click writes it at once, while the click still counts as the user's own gesture.
 */
function ruleButton() {
  const button = h("button", { class: "btn press" }, t("ruleCopy"));
  const fetchRule = () => {
    const pending = invoke("ai_rule").then((result) => {
      if (typeof result?.text !== "string") throw new Error(result?.error ?? "no rule");
      return result;
    });
    pending.catch(() => {});
    return pending;
  };
  let ready = fetchRule();
  button.addEventListener("click", async () => {
    try {
      const { version, text } = await ready;
      await copyText(text);
      toast(t("ruleCopied", { version }));
    } catch (error) {
      ready = fetchRule();
      fail(error);
    }
  });
  return button;
}

/**
 * Open Cloud for upload_asset: the key and the creator, written to open-cloud.env by the shipped
 * `cloud` command. The key field is always empty: a saved key shows only its last 4 characters.
 */
function cloudCard() {
  const card = h("div", { class: "card set-group" }, setHead(t("cloudCard")), setNote(t("cloudNoteShort"), t("cloudNote")));
  const status = h("p", { class: "note set-path" }, t("cloudLoading"));
  const keyInput = h("input", { class: "field-input mono set-key", type: "password", autocomplete: "off", spellcheck: "false", placeholder: t("cloudKeyNew"), "aria-label": t("cloudKey") });
  let kind = "user";
  const idInput = h("input", { class: "field-input mono set-id", inputmode: "numeric", placeholder: t("cloudIdPlaceholder"), "aria-label": t("cloudCreator") });
  const kindButton = (value) => {
    const button = h("button", { onclick: () => { kind = value; paintKind(); } }, t(value === "user" ? "cloudUser" : "cloudGroup"));
    button.dataset.kind = value;
    return button;
  };
  const kinds = h("span", { class: "seg" }, kindButton("user"), kindButton("group"));
  const paintKind = () => kinds.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind));
  const save = h("button", { class: "btn light press" }, t("cloudSave"));
  const remove = h("button", { class: "btn danger press hidden" }, t("cloudRemove"));
  const show = (s) => {
    keyInput.value = "";
    keyInput.placeholder = s.hasKey ? (s.keyEnd ? t("cloudKeySaved", { end: s.keyEnd }) : t("cloudKeySavedShort")) : t("cloudKeyNew");
    kind = s.groupId ? "group" : "user";
    idInput.value = s.groupId ?? s.userId ?? "";
    paintKind();
    remove.classList.toggle("hidden", !s.hasKey);
    status.textContent = [t("cloudFile", { file: s.file }), s.fromEnvironment?.length ? t("cloudEnv", { names: s.fromEnvironment.join(", ") }) : ""].filter(Boolean).join(" ");
  };
  const run = async (args, done) => {
    save.disabled = remove.disabled = true;
    try {
      show(await invoke("cloud_settings", args));
      if (done) toast(t(done));
    } catch (error) {
      fail(error);
    } finally {
      save.disabled = remove.disabled = false;
    }
  };
  save.addEventListener("click", () => {
    const id = idInput.value.trim();
    if (id && !/^\d+$/.test(id)) return fail(t("cloudIdNumber"));
    const args = { key: keyInput.value.trim() || null, userId: null, groupId: null, clear: null };
    if (kind === "user") args.userId = id; else args.groupId = id;
    run(args, "cloudSaved");
  });
  remove.addEventListener("click", () => run({ key: null, userId: null, groupId: null, clear: true }, "cloudRemoved"));
  paintKind();
  run({ key: null, userId: null, groupId: null, clear: null });
  card.append(
    h("div", { class: "field" }, h("span", { class: "grow" }, t("cloudKey")), keyInput),
    h("div", { class: "field" }, h("span", { class: "grow" }, t("cloudCreator")), kinds, idInput),
    h("div", { class: "field set-foot" }, status, remove, save));
  return card;
}

// ---------- The rule for AI: a notice until Connect to AI put it in place (or the user dismisses it) ----------

let ruleKey = "";
function renderRuleNotice() {
  const bar = document.getElementById("ruleUpdate");
  if (!bar) return;
  const version = ui.rule?.version;
  const seen = ui.settings.ruleSeen ?? null;
  const visible = Boolean(version && seen !== version);
  const key = JSON.stringify([visible, version, seen, getLanguage()]);
  if (key === ruleKey) return;
  ruleKey = key;
  bar.classList.toggle("hidden", !visible);
  if (!visible) return;
  // The same dialog as Settings' Connect to AI: the user ticks which AI folders get the rule,
  // with its tools and guard
  const connect = h("button", { class: "btn yellow chunk-bright press" }, t("mcpFind"));
  connect.addEventListener("click", async () => {
    connect.disabled = true;
    try {
      const result = await aiConnectDialog();
      if (!result) return;
      // Only the folders ticked now: one connected before and left alone is not news
      const done = (result.clients ?? []).filter((c) => c.connected && result.only.includes(c.id));
      if (!done.length) throw new Error((result.clients ?? []).find((c) => c.problem && result.only.includes(c.id))?.problem ?? t("mcpNone"));
      toast(t("ruleConnected", { version, clients: done.map((c) => c.label).join(", ") }));
      await invoke("set_settings", { ruleSeen: version });
    } catch (error) {
      fail(error);
    } finally {
      connect.disabled = false;
    }
  });
  const done = h("button", { class: "btn press" }, t("ruleDone"));
  done.addEventListener("click", () => invoke("set_settings", { ruleSeen: version }).catch(fail));
  bar.replaceChildren(h("span", { class: "pill brand" }, t("ruleLabel")), h("span", { class: "grow" }, t(seen ? "ruleChanged" : "ruleFirst", { version })), connect, done);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // An older WebView without the async clipboard: a hidden field and the copy command
    const field = h("textarea", { style: "position:fixed;opacity:0" });
    field.value = text;
    document.body.append(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    if (!ok) throw new Error("the clipboard refused the text");
  }
}

/** A section's heading in Settings: its name, and what sits at its end (a pill, a button) */
function setHead(label, ...end) {
  return h("div", { class: "set-head" }, h("span", { class: "label" }, label), ...end);
}

/**
 * The one line under a section's heading, and its long text behind a small info button beside it:
 * the page stays short, and the whole story is one click away (and in the button's tooltip)
 */
function setNote(short, long) {
  const more = h("p", { class: "note set-more hidden" }, long);
  const info = h("button", { class: "btn ghost sm icon press set-info", title: long, "aria-label": t("setMore"), "aria-expanded": "false" }, h("span", { class: "ico i-info" }));
  info.addEventListener("click", () => {
    const open = more.classList.toggle("hidden") === false;
    info.setAttribute("aria-expanded", String(open));
    info.classList.toggle("on", open);
  });
  return h("div", { class: "set-lead" }, h("div", { class: "set-lead-row" }, h("p", { class: "note" }, short), info), more);
}

/** Settings' sections in page order: the id the index scrolls to and the key of its short name */
const SETTINGS_SECTIONS = [
  ["general", "setGeneral"],
  ["games", "setGames"],
  ["connect", "mcpCard"],
  ["ai", "aiCard"],
  ["auto", "autoCard"],
  ["cloud", "setCloud"],
  ["queue", "queueCard"],
  ["daemon", "daemonSettings"],
  ["about", "setAbout"],
];

/** Lower case and no accents: "configuracoes" finds "Configurações" */
const fold = (text) => String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** What a search reads in a node: its text and the words it only shows on hover or to a screen reader */
function searchText(node) {
  const extra = [node, ...node.querySelectorAll("[title], [placeholder], [aria-label]")]
    .flatMap((n) => ["title", "placeholder", "aria-label"].map((a) => n.getAttribute(a)))
    .filter(Boolean);
  return fold(`${node.textContent} ${extra.join(" ")}`);
}

/**
 * The rows a search shows or hides in a section: each child under the heading, and inside a list
 * of rows (the games, the AIs found) each row of it
 */
function searchUnits(section) {
  return [...section.children]
    .filter((c) => !c.classList.contains("set-head") && !c.classList.contains("label"))
    .flatMap((c) => (!c.classList.contains("field") && c.querySelector(":scope > .field, :scope > .place") ? [...c.children] : [c]));
}

async function renderSettings(target) {
  const s = state();
  const mine = generation;
  const [autostart, daemon, ai, queueSettings, pluginVersion, automation] = await Promise.all([
    invoke("get_autostart").catch(() => false),
    invoke("read_daemon_config"),
    api.get(`/api/ai${ui.aiRefresh ? "?refresh=1" : ""}`).catch(() => null),
    api.get("/api/queue/settings").then((r) => r.settings).catch(() => null),
    // The app version that last changed the plugin: not every app update does
    invoke("plugin_version").catch(() => null),
    api.get("/api/automation").catch(() => null),
  ]);
  ui.aiRefresh = false;
  if (mine !== generation) return;

  // A row of a section: its name, a one-line hint under it (the long one in its tooltip), its controls
  const row = (title, hint, ...controls) => h("div", { class: "field" },
    h("span", { class: "grow" }, title, hint ? h("span", { class: "hint", title: hint.long ?? null }, hint.short ?? hint) : null),
    ...controls);

  // Registered games and the form to add one (prefilled when it comes from a refusal)
  const games = h("div", { class: "set-rows" });
  for (const place of s?.places ?? []) {
    let armed = false;
    // Named after its game: a row of identical "Remove" buttons cannot be told apart by a
    // screen reader (or by automation, which removed the wrong game in a test on 20/10/26)
    const remove = h("button", { class: "btn danger press", "aria-label": `${t("remove")} ${nameOf(place)}` }, t("remove"));
    remove.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        remove.classList.add("armed");
        remove.textContent = `${t("remove")}?`;
        remove.setAttribute("aria-label", `${t("remove")} ${nameOf(place)}?`);
        setTimeout(() => {
          armed = false;
          remove.classList.remove("armed");
          remove.textContent = t("remove");
          remove.setAttribute("aria-label", `${t("remove")} ${nameOf(place)}`);
        }, 3000);
        return;
      }
      await api.post("/api/unregister", { placeId: place.placeId }).then(() => toast(t("done"))).catch(fail);
    });
    games.append(h("div", { class: "place" }, h("div", { class: "grow" }, h("b", {}, nameOf(place)), h("span", { class: "mono" }, `${place.placeId} · ${place.folder}`)), remove));
  }
  if (!s?.places.length) games.append(h("p", { class: "note" }, t("noGames")));

  const placeInput = h("input", { class: "field-input mono", placeholder: t("placeId"), value: ui.register?.placeId ?? "", inputmode: "numeric", "aria-label": t("placeId") });
  const nameInput = h("input", { class: "field-input", placeholder: t("name"), value: ui.register?.placeName ?? "", "aria-label": t("name") });
  let folder = null;
  const folderLabel = h("span", { class: "mono muted grow set-folder" }, t("noFolder"));
  const choose = h("button", { class: "btn press" }, t("chooseFolder"));
  choose.addEventListener("click", async () => {
    const picked = await invoke("pick_folder");
    if (picked) {
      folder = picked;
      folderLabel.textContent = picked;
      folderLabel.title = picked;
    }
  });
  const save = h("button", { class: "btn light press" }, t("save"));
  save.addEventListener("click", async () => {
    try {
      await api.post("/api/registry", { placeId: placeInput.value.trim(), folder: folder ?? "", name: nameInput.value.trim() || undefined });
      ui.register = null;
      toast(t("done"));
      contentKey = "";
      renderContent();
    } catch (error) {
      fail(error);
    }
  });

  const form = h("div", { class: "set-form" },
    h("span", { class: "set-sub" }, t("setAddGame")),
    h("div", { class: "set-pair" }, placeInput, nameInput),
    h("div", { class: "row" }, choose, folderLabel, save));

  const lang = (code, label) => h("button", {
    class: ui.settings.language === code ? "on" : "",
    onclick: () => invoke("set_settings", { language: code }).catch(fail),
  }, label);
  const autostartToggle = toggle(autostart, async () => {
    try {
      await invoke("set_autostart", { enabled: !autostart });
      contentKey = "";
      renderContent();
    } catch (error) {
      fail(error);
    }
  });
  const notifyToggle = toggle(ui.settings.notify, () => invoke("set_settings", { notify: !ui.settings.notify }).catch(fail));
  // "" is the one used last, which the list in Rust's order cannot show once one is picked
  const lastUsed = [...ui.editors].sort((a, b) => b.lastUsed - a.lastUsed || (a.name < b.name ? -1 : 1))[0];
  const picked = ui.editors.some((e) => e.id === ui.settings.editor) ? ui.settings.editor : "";
  const editorSelect = ui.editors.length
    ? h("select", { class: "field-input", "aria-label": t("editorSetting"), onchange: (event) => invoke("set_settings", { editor: event.target.value }).catch(fail) },
      h("option", { value: "", selected: picked === "" }, t("editorAuto", { name: lastUsed.name })),
      [...ui.editors].sort((a, b) => (a.name < b.name ? -1 : 1)).map((e) => h("option", { value: e.id, selected: picked === e.id }, e.name)))
    : h("span", { class: "muted" }, t("noEditor"));
  // The background check runs every 6 hours: a release published right after the app opened waited that long
  const checkUpdate = h("button", { class: "btn press" }, t("checkUpdate"));
  checkUpdate.addEventListener("click", async () => {
    checkUpdate.disabled = true;
    // The shorter label would pull the version beside it sideways
    checkUpdate.style.minWidth = `${checkUpdate.offsetWidth}px`;
    checkUpdate.textContent = t("checkingUpdate");
    try {
      const { ready } = await invoke("check_update");
      if (ready) {
        ui.update = ready;
        renderAppUpdate();
      } else {
        toast(t("upToDate", { version: ui.app.version }), "info");
      }
    } catch (error) {
      fail(error);
    } finally {
      checkUpdate.disabled = false;
      checkUpdate.textContent = t("checkUpdate");
    }
  });

  // The daemon's own settings are shown, never changed here: a value, not a switch that does nothing
  const cfg = daemon.config ?? {};
  const ro = (label, on) => row(label, null, h("span", { class: `set-value${on ? " on" : ""}` }, t(on ? "setOn" : "setOff")));

  const automationSection = automationCard(automation);
  automationSection.classList.add("set-group");
  const sections = Object.entries({
    general: h("div", { class: "card set-group" },
      setHead(t("setGeneral")),
      row(t("language"), null, h("span", { class: "seg" }, lang("en", "English"), lang("pt", "Português"))),
      row(t("startWin"), null, autostartToggle),
      row(t("notify"), null, notifyToggle),
      row(t("editorSetting"), { short: t("editorHintShort"), long: t("editorHint") }, editorSelect)),
    games: h("div", { class: "card set-group" },
      setHead(t("registered")),
      games,
      form),
    connect: mcpCard(),
    ai: aiCard(ai),
    auto: automationSection,
    cloud: cloudCard(),
    queue: queueCard(queueSettings),
    daemon: h("div", { class: "card set-group" },
      setHead(t("daemonSettings"), h("span", { class: "pill" }, t("setReadOnly"))),
      ro(t("mergeCrossed"), cfg.merge?.enabled !== false),
      ro(t("deleteOrphans"), !!cfg.deleteOrphansOnConnect),
      h("p", { class: "note set-path" }, t("sharedConfig", { path: daemon.path }))),
    about: h("div", { class: "card set-group" },
      setHead(t("setAbout")),
      row(t("version"), null, h("span", { class: "mono muted", title: `hub ${s?.build ?? "?"}` }, `${ui.app.version}${ui.app.build ? ` · ${ui.app.build}` : ""}`), checkUpdate),
      row(t("hub"), t("setHubBuild"), h("span", { class: "mono muted" }, s?.build ?? "?")),
      row(t("pluginVersion"), { short: t("pluginHintShort"), long: t("pluginVersionHint") }, h("span", { class: "mono muted" }, pluginVersion ?? t("pluginVersionUnknown")))),
  });
  for (const [id, node] of sections) {
    node.id = `set-${id}`;
    node.dataset.sec = id;
  }

  // The index: a click scrolls to its section; scrolling lights the section being read
  const list = h("div", { class: "set-list scroll" });
  const indexButtons = new Map();
  let clicked = null;
  const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const lit = () => {
    const box = list.getBoundingClientRect();
    const shown = sections.filter(([, node]) => !node.classList.contains("hidden"));
    // The last section whose top came within a few lines of the list's top
    let at = shown[0]?.[0] ?? null;
    for (const [id, node] of shown) if (node.getBoundingClientRect().top <= box.top + 6 * rem()) at = id;
    // The section clicked stays lit, on its way and once there, until the reader scrolls on their
    // own: a short one near the end never reaches the top, the list stops scrolling first
    if (clicked && !document.getElementById(`set-${clicked}`)?.classList.contains("hidden")) at = clicked;
    for (const [id, button] of indexButtons) {
      button.classList.toggle("on", id === at);
      if (id === at) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  };
  const go = (id) => {
    const node = document.getElementById(`set-${id}`);
    if (!node) return;
    clicked = id;
    const top = node.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTo({ top, behavior: "smooth" });
    lit();
  };
  const index = h("nav", { class: "set-index", "aria-label": t("setSections") }, SETTINGS_SECTIONS.map(([id, key]) => {
    const button = h("button", { class: "press", "data-sec": id, onclick: () => go(id) }, t(key));
    indexButtons.set(id, button);
    return button;
  }));
  list.addEventListener("scroll", lit, { passive: true });
  // The reader's own scroll (wheel, the bar, keys) hands the index back to the position
  const own = () => {
    clicked = null;
  };
  for (const type of ["wheel", "pointerdown", "keydown", "touchstart"]) list.addEventListener(type, own, { passive: true });

  // Settings opened fresh (no page of it on screen) starts with no search, and so does a call to
  // add a game (the sidebar's + Add folder, a refused Studio): the form must not be filtered away.
  // That call is used once: the redraws after it keep the reader's place
  const before = target.querySelector(".set-list");
  const adding = ui.registerOpen === true;
  ui.registerOpen = false;
  if (!before || adding) ui.setSearch = "";

  // The search: rows whose words do not match hide, and so does a section left with none. A match
  // in a section's heading (or its long note) keeps the whole section
  const search = h("input", { class: "field-input set-q", placeholder: t("setSearch"), "aria-label": t("setSearch"), spellcheck: "false", autocomplete: "off", value: ui.setSearch ?? "" });
  const emptyTitle = h("strong", {});
  const empty = h("div", { class: "empty set-empty hidden" }, emptyTitle, t("setNoMatchHint"));
  const filter = () => {
    ui.setSearch = search.value;
    const query = fold(search.value.trim());
    let any = false;
    for (const [id, node] of sections) {
      const head = node.querySelector(":scope > .set-head, :scope > .label");
      const whole = !query || (head && searchText(head).includes(query));
      let shown = whole;
      let first = true;
      for (const unit of searchUnits(node)) {
        const hit = whole || searchText(unit).includes(query);
        unit.classList.toggle("set-miss", !hit);
        // The first row left under the heading drops its hairline, as the first row always does
        unit.classList.toggle("set-first", hit && first);
        if (hit) first = false;
        shown ||= hit;
      }
      node.classList.toggle("hidden", !shown);
      indexButtons.get(id).classList.toggle("set-out", !shown);
      any ||= shown;
    }
    emptyTitle.textContent = t("setNoMatch", { q: search.value.trim() });
    empty.classList.toggle("hidden", any);
    lit();
  };
  search.addEventListener("input", filter);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && search.value) {
      event.preventDefault();
      search.value = "";
      filter();
    }
  });
  list.append(...sections.map(([, node]) => node), empty);
  // Rows that arrive later (the AIs found, the Open Cloud file) go through the search too
  const late = new MutationObserver(filter);
  for (const [, node] of sections) late.observe(node, { childList: true, subtree: true, characterData: true });

  // A redraw (a switch, the language, a game added) keeps the place in the page and the search
  const scrolled = adding ? 0 : before?.scrollTop ?? 0;
  const typing = !adding && document.activeElement?.classList.contains("set-q");
  const caret = typing ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  target.replaceChildren(h("div", { class: "set-view" },
    h("div", { class: "title set-title" },
      h("h1", { class: "display grow" }, t("settings")),
      h("label", { class: "search-field" }, h("span", { class: "ico i-search" }), search)),
    h("div", { class: "set-body" }, index, list)));
  filter();
  list.scrollTop = scrolled;
  if (adding) {
    // The form whole in view, its first field ready to type in
    const below = form.getBoundingClientRect().bottom + 0.75 * rem() - list.getBoundingClientRect().bottom;
    if (below > 0) list.scrollTop += below;
    clicked = "games";
    placeInput.focus({ preventScroll: true });
  }
  lit();
  if (typing) {
    search.focus();
    search.setSelectionRange(...caret);
  }
}

// Ctrl+F in Settings goes to its search
addEventListener("keydown", (event) => {
  if (ui.view !== "settings" || !event.ctrlKey || event.key.toLowerCase() !== "f") return;
  const search = document.querySelector(".set-q");
  if (!search) return;
  event.preventDefault();
  search.focus();
  search.select();
});

// ---------- Navigation ----------

/**
 * Settings > Queue: every timing of the Studio queue (Spec decision 16), for every game. The hub
 * checks each value and refuses one out of range; a game's .claude/studio-test.json may change
 * them for that game.
 */
const QUEUE_FIELDS = [
  ["historyDays", "qsHistoryDays"],
  ["lockIdleMin", "qsLockIdleMin"],
  ["lockIdleWaitingMin", "qsLockIdleWaitingMin"],
  ["capMin", "qsCapMin"],
  ["holdSec", "qsHoldSec"],
  ["readySec", "qsReadySec"],
  ["infraWaitSec", "qsInfraWaitSec"],
  ["infraTries", "qsInfraTries"],
  ["lingerSec", "qsLingerSec"],
  ["agingMin", "qsAgingMin"],
  ["stuckRetrySec", "qsStuckRetrySec"],
  ["stuckGiveUpMin", "qsStuckGiveUpMin"],
];

function queueCard(settings) {
  const card = h("div", { class: "card set-group" }, setHead(t("queueCard")));
  if (!settings) {
    card.append(h("p", { class: "note bad" }, t("error", { e: "the hub has no Studio queue" })));
    return card;
  }
  card.append(h("p", { class: "note set-lead" }, t("queueNote")));
  const save = (patch) =>
    api.post("/api/queue/settings", { settings: patch }).then(() => {
      toast(t("qsSaved"));
      contentKey = "";
      renderContent();
    }).catch(fail);
  for (const [key, label] of knownFields(QUEUE_FIELDS, settings)) {
    // An older hub may send one number here, not a list: shown as it is, never a broken card
    const list = key === "infraWaitSec" && Array.isArray(settings[key]);
    const input = h("input", { class: "field-input mono set-num", value: list ? settings[key].join(", ") : String(settings[key] ?? ""), inputmode: "decimal", "aria-label": t(label) });
    input.addEventListener("change", () => {
      const raw = input.value.trim();
      const value = list ? raw.split(/[,\s]+/).filter(Boolean).map(Number) : Number(raw);
      save({ [key]: value });
    });
    card.append(h("div", { class: "field" }, h("span", { class: "grow" }, t(label)), input));
  }
  const pick = (value, label) => h("button", { class: settings.sharedRetry === value ? "on" : "", onclick: () => save({ sharedRetry: value }) }, t(label));
  card.append(h("div", { class: "field" }, h("span", { class: "grow" }, t("qsSharedRetry")), h("span", { class: "seg" }, pick("all", "qsSharedAll"), pick("foreign", "qsSharedForeign"))));
  return card;
}

function show(view, conflictId = null) {
  ui.view = view;
  ui.conflictId = conflictId;
  renderMain();
}

function select(placeId, view = "output") {
  ui.placeId = placeId;
  show(view);
}

function openRegister(refusal) {
  ui.register = refusal ? { placeId: refusal.placeId, placeName: refusal.placeName } : null;
  // Settings scrolls to the form and focuses it once, for this call (renderSettings)
  ui.registerOpen = true;
  contentKey = "";
  show("settings");
}

for (const link of document.querySelectorAll(".navlink")) link.addEventListener("click", () => show(link.dataset.view));
// An editor installed or used while the window was away changes the list
addEventListener("focus", loadEditors);

// ---------- A connection waiting for the user's choice ----------

let choiceShown = null;

/** The last two folders of a path, the part people recognise */
const shortFolder = (folder) => String(folder).split(/[\\/]/).filter(Boolean).slice(-2).join("\\");
const lastFolder = (folder) => String(folder).split(/[\\/]/).filter(Boolean).pop() ?? folder;

/**
 * Setting a place up: the folders already stamped with it come first, then a new folder under
 * Documents\Dev named after the place. Registering it is what the Studio waits for.
 */
async function renderSetup(choice) {
  const place = choice.placeName || choice.placeId;
  let roots = [];
  let found = { existing: [], folderName: place };
  try {
    roots = await invoke("project_roots");
    const query = new URLSearchParams({ placeId: choice.placeId, name: place });
    for (const r of roots) query.append("root", r);
    found = await api.get(`/api/setup-candidates?${query}`);
  } catch (error) {
    fail(error);
  }
  if (choiceShown !== choice.id) return;

  const options = [
    ...found.existing.map((folder) => ({ kind: "existing", folder })),
    { kind: "new", folder: `${roots[0] ?? ""}\\${found.folderName}` },
  ];
  let selected = 0;
  const newInput = h("input", { class: "field-input mono", value: options[options.length - 1].folder, spellcheck: "false" });
  newInput.addEventListener("input", () => (options[options.length - 1].folder = newInput.value));

  const optionNodes = options.map((option, index) => {
    const node = h("button", { class: "setup-option chunk press" },
      h("span", { class: "radio" }),
      h("span", { class: "grow" },
        h("b", {}, option.kind === "existing" ? t("setupUseExisting", { name: lastFolder(option.folder) }) : t("setupNewFolder")),
        option.kind === "existing"
          ? h("span", { class: "mono muted" }, option.folder)
          : h("span", { class: "muted" }, t("setupNewHint"))));
    node.addEventListener("click", () => select(index));
    return node;
  });
  function select(index) {
    selected = index;
    optionNodes.forEach((n, i) => n.classList.toggle("on", i === index));
    newRow.classList.toggle("hidden", options[index].kind !== "new");
  }
  const choose = h("button", { class: "btn press" }, t("chooseFolder"));
  choose.addEventListener("click", async () => {
    const picked = await invoke("pick_folder");
    if (picked) {
      newInput.value = picked;
      options[options.length - 1].folder = picked;
    }
  });
  const newRow = h("div", { class: "setup-new" }, h("div", { class: "grow" }, newInput), choose);

  let dialog;
  const go = h("button", { class: "btn yellow chunk-bright press" }, t("setupGo"));
  go.addEventListener("click", async () => {
    const option = options[selected];
    const folder = option.folder.trim();
    try {
      if (option.kind === "new") await invoke("make_folder", { path: folder });
      await api.post("/api/registry", { placeId: choice.placeId, folder, name: place });
      toast(t("setupDone", { place }));
      dialog.remove();
    } catch (error) {
      fail(error);
    }
  });
  const cancel = h("button", { class: "btn ghost press" }, t("cancel"));
  cancel.addEventListener("click", async () => {
    try {
      await api.post("/api/choice", { id: choice.id, decision: "cancel" });
    } catch (error) {
      fail(error);
      return;
    }
    dialog.remove();
  });

  dialog = h("div", { id: "choice", class: "overlay" },
    h("div", { class: "card chunk dialog", role: "dialog", "aria-modal": "true" },
      h("div", { class: "dlg-head" },
        h("div", { class: "grow" },
          h("span", { class: "label" }, t("setupLabel")),
          h("h2", { class: "display" }, place),
          h("span", { class: "mono" }, `place ${choice.placeId}`))),
      h("p", {}, found.existing.length ? t("setupFound", { n: found.existing.length }) : t("setupNoneFound")),
      h("div", { class: "setup-options" }, optionNodes),
      newRow,
      h("div", { class: "dlg-foot" }, h("p", { class: "dlg-hint" }, t("setupNote")), cancel, go)));
  document.getElementById("choice")?.remove();
  document.body.append(dialog);
  popIn(dialog.firstChild);
  select(0);
  go.focus();
}

/** One dialog over everything for the oldest waiting choice; keeping the current one is the default */
function renderChoice() {
  const choice = ui.hub.online ? state()?.pending?.[0] : undefined;
  if (choice?.id === choiceShown) return;
  document.getElementById("choice")?.remove();
  choiceShown = choice?.id ?? null;
  if (!choice) return;
  if (choice.kind === "setup") {
    renderSetup(choice);
    return;
  }

  const folderCase = choice.kind === "folderInUse";
  const place = choice.placeName || choice.placeId;
  const current = choice.other.kind === "standalone"
    ? { title: t("currentStandalone"), detail: t("pidPort", { pid: choice.other.pid, port: choice.other.port }) }
    : choice.other.kind === "hub"
      ? { title: t("currentHub"), detail: t("portOnly", { port: choice.other.port }) }
      : { title: t("currentStudio"), detail: place };

  // Only this choice's dialog goes, and only once the hub took the answer: a failed request
  // leaves it up to try again, and a newer dialog opened meanwhile stays
  let dialog;
  const decide = (decision) => async () => {
    try {
      await api.post("/api/choice", { id: choice.id, decision });
    } catch (error) {
      fail(error);
      return;
    }
    dialog.remove();
  };

  const party = (tag, cls, title, detail, dot) => h("div", { class: `party ${cls}` },
    h("span", { class: "label" }, tag),
    h("div", { class: "row" }, h("span", { class: `dot ${dot}` }), h("b", {}, title)),
    h("span", { class: "mono muted" }, detail));

  const option = (cls, title, effect, onclick) => h("button", { class: `option chunk press ${cls}`, onclick },
    h("b", {}, title), h("span", {}, effect));

  const keep = option("keep", t("keepCurrent"), folderCase ? t("keepEffectFolder", { place }) : t("keepEffectStudio"), decide("cancel"));
  const take = option("take", t("takeOver"), folderCase ? t("takeEffectFolder", { place }) : t("takeEffectStudio"), decide("continue"));

  dialog = h("div", { id: "choice", class: "overlay" },
    h("div", { class: "card chunk dialog wide", role: "alertdialog", "aria-modal": "true" },
      h("div", { class: "dlg-head" },
        h("div", { class: "grow" },
          h("span", { class: "label" }, t("oneConnection")),
          h("h2", { class: "display" }, folderCase ? t("choiceFolderTitle") : t("choiceStudioTitle")))),
      h("div", { class: "parties" },
        party(t("wantsIn"), "new", place, `place ${choice.placeId}`, "warn"),
        h("span", { class: "arrow" }, "→"),
        h("div", { class: "party folder" },
          h("span", { class: "label" }, t("folderLabel")),
          h("b", { class: "display" }, lastFolder(choice.folder)),
          h("span", { class: "mono muted", title: choice.folder }, shortFolder(choice.folder))),
        h("span", { class: "arrow" }, "←"),
        party(t("syncingNow"), "current", current.title, current.detail, "live")),
      h("div", { class: "options" }, keep, take),
      h("p", { class: "note center" }, t("choiceWaiting"))));
  document.body.append(dialog);
  popIn(dialog.firstChild);
  keep.focus();
}

// ---------- A write to the live game waiting for the user's answer ----------

/**
 * The oldest write the hub holds for the user (Open Cloud: a save, a publish, a badge...), over
 * everything, the choice dialog too. Its title and its whole text, read only and scrolling, as
 * the hub's `describe` wrote it (hidden characters already shown as \u{...}). Refuse is the
 * default: it has the focus, so Enter refuses, and Esc refuses too. The answer goes through the
 * app's Rust side, which adds the token only it holds; the window never sees the token.
 */
let approvalShown = null;
let approvalTimer;
let approvalEscape = null;
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && approvalEscape) {
    event.preventDefault();
    approvalEscape();
  }
});

/** m:ss left */
const countdown = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function renderApproval() {
  const approval = ui.hub.online ? ui.hub.approvals?.[0] : undefined;
  const answerable = ui.hub.approvalsAnswerable === true;
  const key = approval ? JSON.stringify([approval.id, answerable, getLanguage()]) : null;
  if (key === approvalShown) return;
  approvalShown = key;
  clearInterval(approvalTimer);
  approvalEscape = null;
  document.getElementById("approval")?.remove();
  if (!approval) return;

  let dialog;
  let sending = false;
  const answer = (approve) => async () => {
    if (sending || !answerable) return;
    sending = true;
    refuse.disabled = accept.disabled = true;
    try {
      await invoke("approval_answer", { id: approval.id, approve });
    } catch (error) {
      // Still up, to try again (or to refuse); the hub's own timeout is a No anyway
      sending = false;
      refuse.disabled = accept.disabled = false;
      fail(error);
      return;
    }
    clearInterval(approvalTimer);
    approvalEscape = null;
    dialog.remove();
    toast(t("approvalSent"));
  };
  const refuse = h("button", { class: "btn yellow chunk-bright press", onclick: answer(false) }, t("approvalRefuse"));
  const accept = h("button", { class: "btn danger press", onclick: answer(true) }, t("approvalAccept"));
  refuse.disabled = accept.disabled = !answerable;
  approvalEscape = answer(false);

  const text = h("textarea", { class: "approval-text mono", readonly: true, spellcheck: "false", "aria-label": approval.title });
  text.value = approval.text;
  const expires = h("p", { class: "dlg-hint" });
  const tick = () => {
    expires.textContent = t("approvalExpires", { time: countdown(approval.expiresAt - Date.now()) });
  };
  tick();
  approvalTimer = setInterval(tick, 1000);

  dialog = h("div", { id: "approval", class: "overlay" },
    h("div", { class: "card chunk dialog approval", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "approvalTitle" },
      h("div", { class: "dlg-head" },
        h("span", { class: "slot lg warn", "aria-hidden": "true" }, h("span", { class: "ico i-alert" })),
        h("div", { class: "grow" },
          h("span", { class: "label" }, t("approvalLabel")),
          h("h2", { class: "display approval-title", id: "approvalTitle" }, approval.title))),
      h("p", { class: "note approval-ask" }, t("approvalAsk")),
      text,
      answerable ? null : h("p", { class: "note bad" }, t("approvalCannotAnswer")),
      // The countdown on the left; Accept, then Refuse (the default) at the end
      h("div", { class: "dlg-foot" }, expires, accept, refuse)));
  document.body.append(dialog);
  popIn(dialog.firstChild);
  refuse.focus();
}

ui.app = await invoke("app_info").catch(() => ui.app);
// Listening first: a download finishing between the two would otherwise never show
await listen("update-ready", (event) => {
  ui.update = event.payload.version;
  renderAppUpdate();
});
ui.update = (await invoke("update_status").catch(() => ({}))).ready ?? ui.update;
// The rule this install ships: its version against the one the user last gave their AI
ui.rule = await invoke("ai_rule").then((r) => (typeof r?.version === "string" && typeof r?.text === "string" ? r : null)).catch(() => null);
await start({
  onSettings: (settings) => {
    ui.settings = settings;
    contentKey = "";
    renderMain();
    // The editor picked changes which one opens first
    loadEditors();
    // An open dialog is redrawn in the new language
    choiceShown = null;
    renderChoice();
    approvalShown = null;
    renderApproval();
  },
  onState: (payload) => {
    const wasOnline = ui.hub.online;
    ui.hub = payload;
    if (payload.online) {
      const s = payload.state;
      // Keep the chosen game while it exists; otherwise the first connected one, then any
      if (!placeOf(ui.placeId)) {
        ui.placeId = (s.sessions.find((x) => x.studioConnected) ?? s.places[0])?.placeId ?? null;
        if (ui.view !== "settings") ui.view = "output";
      }
    }
    if (wasOnline !== payload.online) contentKey = "";
    renderMain();
    renderChoice();
    renderApproval();
  },
});
await listen("navigate", (event) => {
  const { placeId, view, id } = event.payload;
  if (view === "register") return openRegister(state()?.refused.find((r) => r.placeId === id) ?? null);
  if (placeId) ui.placeId = placeId;
  show(view ?? (ui.view === "settings" ? "output" : ui.view));
});
