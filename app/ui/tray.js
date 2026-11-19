// The tray panel: one line per game, open the window, pause everything, quit.
import { api, h, invoke, listen, nameOf, start, toast } from "./common.js";
import { applyStatic, t, tn } from "./i18n.js";

let settings = { hubPort: 3826 };
let last = { online: false };

const list = document.getElementById("list");
const pause = document.getElementById("pause");

const show = (placeId, view, id) => invoke("show_main", { placeId, view, id });

function line(dotClass, name, right, onclick) {
  return h("button", { class: "game press", title: name, onclick }, h("span", { class: `dot ${dotClass}` }), h("b", { class: "grow" }, name), right);
}

/** A panel with no list: a heading (with a state dot) and one line under it */
const message = (dot, heading, text) => h("div", { class: "traymsg" },
  heading ? h("strong", {}, dot ? h("span", { class: `dot ${dot}` }) : null, heading) : null, text);

function render() {
  applyStatic();
  document.getElementById("port").textContent = t("hubPort", { port: settings.hubPort });
  list.replaceChildren();
  const state = last.state;
  pause.disabled = !last.online;
  pause.textContent = state?.paused ? t("resume") : t("pauseAll");

  if (!last.online) {
    list.append(message("bad", t("hubOffline"), t("hubOfflineText", { port: settings.hubPort })));
  } else if (state.paused) {
    list.append(message("warn", t("paused"), t("pausedText")));
  } else {
    // A Studio turned away waits for the user: first, so a long list never scrolls it out of sight
    for (const refusal of state.refused) {
      list.append(line("bad", nameOf(refusal), h("span", { class: "pill bad" }, t("register")),
        () => show(null, "register", refusal.placeId)));
    }
    const sessions = new Map(state.sessions.map((s) => [s.placeId, s]));
    for (const place of state.places) {
      const session = sessions.get(place.placeId);
      const connected = session?.studioConnected;
      const right = place.conflicts
        ? h("span", { class: "pill warn" }, tn("conflicts", place.conflicts))
        : h("small", { class: connected ? "live" : "" }, connected ? t("inSync") : t("notOpen"));
      list.append(line(place.conflicts ? "warn" : connected ? "live" : "", nameOf(place), right,
        () => show(place.placeId, place.conflicts ? "merges" : "output")));
    }
    if (!state.places.length && !state.refused.length) list.append(message(null, null, t("noGames")));
  }
  fit();
}

/** The window is as tall as the panel; Rust keeps its bottom edge at the taskbar */
function fit() {
  const panel = document.getElementById("tray");
  invoke("tray_fit", { height: Math.ceil(panel.getBoundingClientRect().height) + 9 });
}

document.getElementById("open").addEventListener("click", () => show(null, null, null));
document.getElementById("quit").addEventListener("click", () => invoke("quit"));
pause.addEventListener("click", async () => {
  try {
    await api.post("/api/pause", { paused: !last.state?.paused });
  } catch (error) {
    toast(t("error", { e: error }), true);
  }
});
document.addEventListener("keydown", (event) => {
  // Through the app, which also tells WebView2 the page is off screen
  if (event.key === "Escape") invoke("hide_window");
});

await start({
  onSettings: (s) => {
    settings = s;
    render();
  },
  onState: (payload) => {
    // Only redraw when something changed: the panel is open while the user aims at it
    const before = JSON.stringify(last);
    last = payload;
    if (JSON.stringify(last) !== before) render();
  },
});
await listen("tray-shown", () => {
  // The last click's focus ring would otherwise greet the next opening
  document.activeElement?.blur();
  fit();
});
