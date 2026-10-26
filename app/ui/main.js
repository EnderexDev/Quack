// The main window: games on the left, the chosen game's output, playtest, merges and folder
// on the right, plus the conflict view and settings.
import { api, h, invoke, listen, nameOf, shortPath, start, toast } from "./common.js";
import { applyStatic, duration, getLanguage, t, tn } from "./i18n.js";

const LOG_LINES_KEPT = 3000;
const LOG_POLL_MS = 1000;
const MERGES_POLL_MS = 2000;
/** Above this many cells the line diff is skipped and both versions are shown whole */
const DIFF_MAX_CELLS = 4_000_000;
const CONTEXT_LINES = 3;

const ui = {
  /** A new version of the app, downloaded and waiting for the click */
  update: null,
  /** The app's version and the build of the hub it ships (null in a debug run) */
  app: { version: "", build: null },
  settings: { hubPort: 3826, language: "en" },
  hub: { online: false },
  placeId: null,
  view: "output",
  conflictId: null,
  register: null,
};
const logs = new Map(); // placeId -> { next, lines, reading }
let contentKey = "";
let mergesTimer;
/** Bumped on every content render: an async view drops its work once a newer one started */
let generation = 0;

const side = document.getElementById("side");
const main = document.getElementById("main");
const openCode = document.getElementById("openCode");
const mergeBadge = document.getElementById("mergeBadge");

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

setInterval(() => {
  if (ui.hub.online && ui.placeId && (ui.view === "output" || ui.view === "playtest")) readLog(ui.placeId);
}, LOG_POLL_MS);

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
    class: `game chunk press${place.placeId === ui.placeId && ui.view !== "settings" ? " sel" : ""}`,
    onclick: () => select(place.placeId, ui.view === "settings" || ui.view === "conflict" ? "output" : ui.view),
  }, h("span", { class: `dot ${place.conflicts ? "warn" : dot}` }), h("b", { class: "grow" }, nameOf(place)));
  if (connected.length) side.append(h("span", { class: "label" }, t("connected")), ...connected.map((p) => item(p, "live")));
  if (others.length) side.append(h("span", { class: "label" }, t("offlineGames")), ...others.map((p) => item(p, "")));
  if (s.refused.length) {
    side.append(h("span", { class: "label" }, t("refused")), ...s.refused.map((r) => h("button", {
      class: "game chunk press", onclick: () => openRegister(r),
    }, h("span", { class: "dot bad" }), h("b", { class: "grow" }, nameOf(r)))));
  }
  side.append(
    h("span", { class: "grow" }),
    h("button", { class: "btn dark chunk press", onclick: () => openRegister(null) }, t("addFolder")),
    h("button", { class: `btn ${ui.view === "settings" ? "yellow chunk-bright" : "dark chunk"} press`, onclick: () => show("settings") }, t("settings")),
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
  openCode.classList.toggle("hidden", !place || ui.view === "settings");
}

function header(place) {
  const session = sessionOf(place.placeId);
  const status = session?.studioConnected
    ? h("span", { class: "pill live" }, h("span", { class: "dot live" }), t("studioFor", { d: duration(Date.now() - session.studioSince) }))
    : h("span", { class: "pill" }, h("span", { class: "dot" }), session ? t("studioClosed") : t("daemonOff"));
  return h("div", {},
    h("div", { class: "title" }, h("div", { class: "grow" }, h("h1", { class: "display" }, nameOf(place)), h("div", { class: "bar" })), status),
    h("div", { class: "meta", style: "margin-top:10px" },
      h("span", { class: "pill mono" }, `place ${place.placeId}`),
      session && h("span", { class: "pill mono" }, `pid ${session.daemonPid} · :${session.daemonPort}`),
      h("span", { class: "pill mono", title: place.folder }, shortPath(place.folder))));
}

function stats(place) {
  const session = sessionOf(place.placeId);
  const stat = (value, label, extra = "", onclick) => h("div", { class: `stat chunk press ${extra}`, onclick },
    h("span", { class: "br tl" }), h("span", { class: "br brr" }), h("span", { class: "v" }, value), h("span", { class: "label" }, label));
  return h("div", { class: "stats" },
    stat(compact(session?.instances), t("instances")),
    stat(String(place.today), t("mergesToday"), "", () => show("merges")),
    stat(String(place.conflicts), place.conflicts === 1 ? t("conflict") : t("conflictsLabel"), place.conflicts ? "warn" : "", () => show("merges")));
}

/** Stops what the current content view runs in the background, and outdates its pending work */
function stopContent() {
  clearInterval(mergesTimer);
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
  const key = JSON.stringify([outdated, restartArmed, restarting, getLanguage()]);
  if (key === updateKey) return;
  updateKey = key;
  bar.classList.toggle("hidden", !outdated);
  if (!outdated) return;
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
  bar.replaceChildren(h("span", { class: "pill brand" }, t("updateLabel")), h("span", { class: "grow" }, t("hubOutdated")), restart);
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
    top = h("div", { id: "top", style: "display:flex;flex-direction:column;gap:14px" });
    main.replaceChildren(top, h("div", { id: "content", style: "flex:1;min-height:0;display:flex;flex-direction:column" }));
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
  if (ui.view === "conflict") return renderConflict(target);
}

function renderLog(target) {
  const playtest = ui.view === "playtest";
  const box = h("div", { class: "log mono", id: "log" });
  target.replaceChildren(h("div", { class: "panel chunk" },
    h("div", { class: "panel-top" }, h("span", { class: "label" }, playtest ? t("playtest") : t("daemon")), h("span", { class: "grow" }), h("span", { class: "pill brand" }, t("live"))),
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

async function renderMerges(target) {
  const list = h("div", { class: "list" });
  target.replaceChildren(h("div", { class: "panel chunk" }, h("div", { class: "panel-top" }, h("span", { class: "label" }, t("merges"))), list));
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
    if (!rows.length) return list.replaceChildren(h("div", { class: "empty" }, t("noMerges")));
    list.replaceChildren(...rows.map((entry) => {
      const method = entry.method === "ai" ? h("span", { class: "pill sky" }, t("methodAi"))
        : entry.method === "error" ? h("span", { class: "pill bad" }, t("methodError"))
        : h("span", { class: "pill" }, t("methodText"));
      const action = entry.agentVersion
        ? entry.resolved
          ? h("span", { class: "label" }, t("seen"))
          : h("button", { class: "pill warn", onclick: () => show("conflict", entry.agentVersion) }, entry.conflictingHunks ? tn("hunks", entry.conflictingHunks) : t("open"))
        : h("span", { class: "label" }, entry.ms !== undefined ? `${entry.ms} ms` : "");
      return h("div", { class: "mrow" }, h("span", { class: "mono muted" }, hhmm(entry.t)), h("span", { class: "file mono", title: entry.error ?? entry.file }, entry.file), method, action);
    }));
  };
  await fill();
  // Left before the first answer came: no timer for a view that is gone
  if (mine === generation) mergesTimer = setInterval(fill, MERGES_POLL_MS);
}

function renderFolder(target) {
  const place = placeOf(ui.placeId);
  let armed = false;
  const remove = h("button", { class: "btn dark chunk press danger", "aria-label": `${t("removeGame")}: ${nameOf(place)}` }, t("removeGame"));
  remove.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      remove.textContent = t("removeConfirm", { name: nameOf(place) });
      remove.setAttribute("aria-label", remove.textContent);
      setTimeout(() => {
        armed = false;
        remove.textContent = t("removeGame");
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
  target.replaceChildren(h("div", { class: "card chunk" },
    h("span", { class: "label" }, t("folder")),
    h("div", { class: "place chunk" }, h("div", { class: "grow" }, h("b", {}, nameOf(place)), h("span", { class: "mono" }, place.folder))),
    h("p", { class: "note" }, t("folderTab")),
    h("div", { class: "actions", style: "margin-top:14px" },
      h("button", { class: "btn yellow chunk-bright press", onclick: () => invoke("open_path", { path: place.folder, editor: false }).catch(fail) }, t("openFolder")),
      h("button", { class: "btn dark chunk press", onclick: () => invoke("open_path", { path: place.folder, editor: true }).catch(fail) }, t("openVsc")),
      h("span", { class: "grow" }), remove)));
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
  const left = h("div", { class: "pane chunk mono" }, h("span", { class: "label" }, t("kept")));
  const right = h("div", { class: "pane chunk mono" }, h("span", { class: "label" }, t("lost")));
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
  if (!changed.some(Boolean)) return [left, right, t("sameText")];
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
  const method = entry?.method === "ai" ? t("methodAi") : t("methodText");
  target.replaceChildren(h("div", { class: "view" },
    h("div", { class: "title" },
      h("div", { class: "grow" },
        h("span", { class: "label" }, `${t("conflictTitle")} · ${entry ? hhmm(entry.t) : ""} · ${method}`),
        h("h1", { class: "display", style: "font-size:22px;margin-top:6px" }, view.file.split("/").pop()),
        h("div", { class: "bar" })),
      entry?.conflictingHunks ? h("span", { class: "pill warn" }, h("span", { class: "dot warn" }), tn("hunks", entry.conflictingHunks)) : null),
    note ? h("p", { class: "note" }, note) : null,
    h("div", { class: "diff" }, left, right),
    h("div", { class: "actions" },
      h("button", { class: "btn yellow chunk-bright press", onclick: resolve("useDisk") }, t("useDisk")),
      h("button", { class: "btn dark chunk press", onclick: resolve("keep") }, t("keep")),
      h("button", { class: "btn dark chunk press", onclick: () => invoke("open_path", { path: view.path, editor: true }).catch(fail) }, t("openVsc")),
      h("button", { class: "btn dark chunk press", onclick: () => show("merges") }, t("back")),
      h("span", { class: "grow" }),
      h("span", { class: "mono muted", style: "font-size:10.5px" }, id))));
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
  const card = h("div", { class: "card chunk" }, h("span", { class: "label" }, t("aiCard")));
  const redraw = () => {
    contentKey = "";
    renderContent();
  };
  const check = h("button", { class: "btn dark chunk press" }, t("aiCheck"));
  check.addEventListener("click", () => {
    check.disabled = true;
    ui.aiRefresh = true;
    redraw();
  });
  if (!ai) {
    card.append(h("p", { class: "note" }, t("aiUnknown")), h("div", { class: "row" }, h("span", { class: "grow" }), check));
    return card;
  }
  const { effective, settings, usable, detected } = ai;
  const set = (body) => api.post("/api/ai", body).then(redraw).catch(fail);
  const none = usable.length === 0;
  const on = !none && settings.ai;
  const model = effective.provider ? detected[effective.provider].model : null;
  card.append(h("div", { class: "field" },
    h("span", { class: "grow" }, t("aiMerge")),
    model ? h("span", { class: "pill brand" }, model) : null,
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
    card.append(h("p", { class: "note", style: "color:var(--brand-400)" }, t("aiChoose")));
  } else if (effective.state === "off") {
    card.append(h("p", { class: "note" }, t("aiOffNote")));
  } else {
    card.append(h("p", { class: "note" }, t("aiAccount", { name: AI_NAMES[effective.provider] })));
  }
  card.append(h("div", { class: "row", style: "margin-top:8px" }, h("span", { class: "grow" }), check));
  return card;
}

/**
 * Connect to AI: finds Claude Code, Cursor and Codex, shows which have this Quack's MCP, and
 * adds it only after the Connect click (the first click only looks).
 */
function mcpCard() {
  const card = h("div", { class: "card chunk" }, h("span", { class: "label" }, t("mcpCard")), h("p", { class: "note" }, t("mcpNote")));
  const list = h("div", {});
  const button = h("button", { class: "btn yellow chunk-bright press" }, t("mcpFind"));
  let found = null;
  const show = (clients) => {
    found = clients;
    list.replaceChildren(...clients.map((c) => h("div", { class: "field" },
      h("span", { class: "grow" }, c.label),
      h("span", { class: c.connected ? "pill brand" : "pill", title: c.problem ?? "" }, c.problem ? c.problem : t(!c.installed ? "mcpMissing" : c.connected ? "mcpHas" : "mcpNo")))));
    const toConnect = clients.filter((c) => c.installed && !c.connected).length;
    if (!clients.some((c) => c.installed)) list.append(h("p", { class: "note" }, t("mcpNone")));
    button.textContent = toConnect ? `${t("mcpConnect")} (${toConnect})` : t("mcpFind");
  };
  button.addEventListener("click", async () => {
    const connect = !!found?.some((c) => c.installed && !c.connected);
    button.disabled = true;
    button.textContent = t(connect ? "mcpConnecting" : "mcpFinding");
    try {
      const result = await invoke("ai_clients", { connect });
      if (result.error) throw new Error(result.error);
      show(result.clients);
      if (connect && result.clients.some((c) => c.connected)) toast(t("mcpRestart"));
    } catch (error) {
      fail(error);
      button.textContent = t("mcpFind");
    } finally {
      button.disabled = false;
    }
  });
  card.append(list, h("div", { class: "row", style: "margin-top:8px" }, h("span", { class: "grow" }), button));
  return card;
}

async function renderSettings(target) {
  const s = state();
  const mine = generation;
  const [autostart, daemon, ai] = await Promise.all([
    invoke("get_autostart").catch(() => false),
    invoke("read_daemon_config"),
    api.get(`/api/ai${ui.aiRefresh ? "?refresh=1" : ""}`).catch(() => null),
  ]);
  ui.aiRefresh = false;
  if (mine !== generation) return;

  // Registered games and the form to add one (prefilled when it comes from a refusal)
  const games = h("div", {});
  for (const place of s?.places ?? []) {
    let armed = false;
    // Named after its game: a row of identical "Remove" buttons cannot be told apart by a
    // screen reader (or by automation, which removed the wrong game in a test on 20/10/26)
    const remove = h("button", { class: "btn dark chunk press danger", "aria-label": `${t("remove")} ${nameOf(place)}` }, t("remove"));
    remove.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        remove.textContent = `${t("remove")}?`;
        remove.setAttribute("aria-label", `${t("remove")} ${nameOf(place)}?`);
        setTimeout(() => {
          armed = false;
          remove.textContent = t("remove");
          remove.setAttribute("aria-label", `${t("remove")} ${nameOf(place)}`);
        }, 3000);
        return;
      }
      await api.post("/api/unregister", { placeId: place.placeId }).then(() => toast(t("done"))).catch(fail);
    });
    games.append(h("div", { class: "place chunk" }, h("div", { class: "grow" }, h("b", {}, nameOf(place)), h("span", { class: "mono" }, `${place.placeId} · ${place.folder}`)), remove));
  }
  if (!s?.places.length) games.append(h("p", { class: "note" }, t("noGames")));

  const placeInput = h("input", { class: "field-input mono", placeholder: t("placeId"), value: ui.register?.placeId ?? "", inputmode: "numeric" });
  const nameInput = h("input", { class: "field-input", placeholder: t("name"), value: ui.register?.placeName ?? "" });
  let folder = null;
  const folderLabel = h("span", { class: "mono muted grow", style: "overflow-wrap:anywhere" }, t("noFolder"));
  const choose = h("button", { class: "btn dark chunk press" }, t("chooseFolder"));
  choose.addEventListener("click", async () => {
    const picked = await invoke("pick_folder");
    if (picked) {
      folder = picked;
      folderLabel.textContent = picked;
    }
  });
  const save = h("button", { class: "btn yellow chunk-bright press" }, t("save"));
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
  // The background check runs every 6 hours: a release published right after the app opened waited that long
  const checkUpdate = h("button", { class: "btn dark chunk press" }, t("checkUpdate"));
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
        toast(t("upToDate", { version: ui.app.version }));
      }
    } catch (error) {
      fail(error);
    } finally {
      checkUpdate.disabled = false;
      checkUpdate.textContent = t("checkUpdate");
    }
  });

  const cfg = daemon.config ?? {};
  const ro = (label, on, extra) => h("div", { class: "field" }, h("span", { class: "grow" }, label), extra, toggle(on, null, true));

  target.replaceChildren(h("div", { class: "view" },
    h("div", { class: "title" }, h("div", { class: "grow" }, h("h1", { class: "display" }, t("settings")), h("div", { class: "bar" }))),
    h("div", { class: "cards" },
      h("div", { class: "card chunk" },
        h("span", { class: "label" }, t("registered")),
        games,
        h("div", { class: "form" },
          placeInput, nameInput,
          h("div", { class: "wide row" }, choose, folderLabel),
          h("div", { class: "wide row" }, h("span", { class: "grow" }), save))),
      h("div", { style: "display:flex;flex-direction:column;gap:16px" },
        h("div", { class: "card chunk" },
          h("span", { class: "label" }, t("hub")),
          h("div", { class: "field" }, h("span", { class: "grow" }, t("language")), h("span", { class: "seg" }, lang("en", "English"), lang("pt", "Português"))),
          h("div", { class: "field" }, h("span", { class: "grow" }, t("startWin")), autostartToggle),
          h("div", { class: "field" }, h("span", { class: "grow" }, t("notify")), notifyToggle),
          h("div", { class: "field" }, h("span", { class: "grow" }, t("version")),
            h("span", { class: "mono muted", title: `hub ${s?.build ?? "?"}` }, `${ui.app.version}${ui.app.build ? ` · ${ui.app.build}` : ""}`),
            checkUpdate)),
        aiCard(ai),
        mcpCard(),
        h("div", { class: "card chunk" },
          h("span", { class: "label" }, t("daemonSettings")),
          ro(t("mergeCrossed"), cfg.merge?.enabled !== false),
          ro(t("deleteOrphans"), !!cfg.deleteOrphansOnConnect),
          h("p", { class: "note" }, t("sharedConfig", { path: daemon.path })))))));
  if (ui.register) placeInput.focus();
}

// ---------- Navigation ----------

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
  contentKey = "";
  show("settings");
}

for (const link of document.querySelectorAll(".navlink")) link.addEventListener("click", () => show(link.dataset.view));
openCode.addEventListener("click", () => {
  const place = placeOf(ui.placeId);
  if (place) invoke("open_path", { path: place.folder, editor: true }).catch(fail);
});

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
  const choose = h("button", { class: "btn dark chunk press" }, t("chooseFolder"));
  choose.addEventListener("click", async () => {
    const picked = await invoke("pick_folder");
    if (picked) {
      newInput.value = picked;
      options[options.length - 1].folder = picked;
    }
  });
  const newRow = h("div", { class: "row" }, h("div", { class: "grow" }, newInput), choose);

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
  const cancel = h("button", { class: "btn dark chunk press" }, t("cancel"));
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
      h("span", { class: "label" }, t("setupLabel")),
      h("h2", { class: "display" }, place),
      h("div", { class: "bar" }),
      h("p", { class: "mono muted" }, `place ${choice.placeId}`),
      h("p", {}, found.existing.length ? t("setupFound", { n: found.existing.length }) : t("setupNoneFound")),
      h("div", { class: "setup-options" }, optionNodes),
      newRow,
      h("div", { class: "actions" }, cancel, h("span", { class: "grow" }), go),
      h("p", { class: "note" }, t("setupNote"))));
  document.getElementById("choice")?.remove();
  document.body.append(dialog);
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
    h("div", { class: "card chunk dialog", role: "alertdialog", "aria-modal": "true" },
      h("span", { class: "label" }, t("oneConnection")),
      h("h2", { class: "display" }, folderCase ? t("choiceFolderTitle") : t("choiceStudioTitle")),
      h("div", { class: "bar" }),
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
      h("p", { class: "note" }, t("choiceWaiting"))));
  document.body.append(dialog);
  keep.focus();
}

ui.app = await invoke("app_info").catch(() => ui.app);
// Listening first: a download finishing between the two would otherwise never show
await listen("update-ready", (event) => {
  ui.update = event.payload.version;
  renderAppUpdate();
});
ui.update = (await invoke("update_status").catch(() => ({}))).ready ?? ui.update;
await start({
  onSettings: (settings) => {
    ui.settings = settings;
    contentKey = "";
    renderMain();
    // An open dialog is redrawn in the new language
    choiceShown = null;
    renderChoice();
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
  },
});
await listen("navigate", (event) => {
  const { placeId, view, id } = event.payload;
  if (view === "register") return openRegister(state()?.refused.find((r) => r.placeId === id) ?? null);
  if (placeId) ui.placeId = placeId;
  show(view ?? (ui.view === "settings" ? "output" : ui.view));
});
