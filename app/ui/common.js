// What both windows share: the calls to the app (which relays to the hub), the hub state
// stream, settings, and small DOM helpers.
import { setLanguage } from "./i18n.js";
import { onIdleChange, setWindowState } from "./idle.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// The window's focus and visibility drive idle.js: body.idle pauses the CSS animations, and the
// pollers sleep while the window is hidden or minimized. A window covered by another stays
// "visible" to the page (visibilitychange never fires), so this reads the window itself.
const win = window.__TAURI__.window.getCurrentWindow();
async function readWindow(focused) {
  try {
    const [f, visible, minimized] = await Promise.all([focused ?? win.isFocused(), win.isVisible(), win.isMinimized()]);
    setWindowState({ focused: f, shown: visible && !minimized });
  } catch {
    // the window is closing
  }
}
onIdleChange((idle) => document.body.classList.toggle("idle", idle));
document.body.classList.add("idle");
await win.onFocusChanged(({ payload }) => {
  readWindow(payload);
  // A hide or minimize right after the blur may not show yet in the first read
  setTimeout(() => readWindow(), 400);
});
// Minimized without a focus change (Win+D over another app) arrives as a resize
await win.onResized(() => readWindow());
await readWindow();

export const api = {
  get: (path) => invoke("hub_get", { path }),
  post: (path, body = {}) => invoke("hub_post", { path, body }),
};
export { invoke, listen };

// Dev wears green instead of yellow (html.dev in base.css). Both windows start hidden, so the
// class is on before anything shows.
const appInfo = await invoke("app_info").catch(() => ({}));
document.documentElement.classList.toggle("dev", appInfo.flavor === "dev");

/** Element builder: h("div", { class: "x", onclick }, "text", child) */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * A short entrance (0.96 to 1, faded in) for a dialog, a menu or a toast. A Web Animation, not a
 * CSS one: body.idle pauses CSS animations on their first frame, which once left the approval
 * popup invisible in a window without focus. With no focus there is no entrance at all, and one
 * started runs to its end on time, whatever the focus does meanwhile.
 */
export function popIn(node, from = "scale(0.96)") {
  if (document.body.classList.contains("idle") || typeof node.animate !== "function") return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  node.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }], { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
}

const TOAST_KINDS = { success: "✓", info: "i", error: "!" };
let toastTimer;
/**
 * A short line at the bottom. `bad` is its kind: true or "error", "info", or false / "success"
 * (the default). Errors stay longer.
 */
export function toast(text, bad = false, ms = bad === true || bad === "error" ? 5000 : 2200) {
  const type = bad === true ? "error" : TOAST_KINDS[bad] ? bad : "success";
  document.querySelector(".toast")?.remove();
  const node = h("div", { class: `toast ${type}${type === "error" ? " bad" : ""}`, role: type === "error" ? "alert" : "status" },
    h("span", { class: "toast-icon", "aria-hidden": "true" }, TOAST_KINDS[type]),
    h("span", { class: "toast-text" }, text));
  document.body.append(node);
  popIn(node, "translateY(0.5rem) scale(0.96)");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), ms);
}

/** Settings first (for the language), then every hub-state the app polls */
export async function start({ onSettings, onState }) {
  const settings = await invoke("get_settings");
  setLanguage(settings.language);
  onSettings(settings);
  await listen("settings", (event) => {
    setLanguage(event.payload.language);
    onSettings(event.payload);
  });
  await listen("hub-state", (event) => onState(event.payload));
}

/** A place's display name */
export const nameOf = (place) => place?.name || place?.placeName || place?.placeId || "?";

/** The short end of a folder path */
export const shortPath = (folder) => {
  const parts = String(folder).split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? `…\\${parts[parts.length - 1]}` : folder;
};
