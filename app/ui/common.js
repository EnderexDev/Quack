// What both windows share: the calls to the app (which relays to the hub), the hub state
// stream, settings, and small DOM helpers.
import { setLanguage } from "./i18n.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

export const api = {
  get: (path) => invoke("hub_get", { path }),
  post: (path, body = {}) => invoke("hub_post", { path, body }),
};
export { invoke, listen };

// Dev wears green instead of yellow (html.dev in style.css). Both windows start hidden, so the
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

let toastTimer;
export function toast(text, bad = false) {
  document.querySelector(".toast")?.remove();
  const node = h("div", { class: `toast chunk${bad ? " bad" : ""}` }, text);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), bad ? 5000 : 2200);
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
