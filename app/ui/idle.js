// What the window's state allows to run in the background. Both windows stay alive hidden in
// the tray; measured 12/11/26, their WebView2 used 0.7 of a core doing nothing (the pulsing
// dot, repainted every frame, and the pollers). Animations stop while the window has no focus;
// pollers stop while it is hidden or minimized (a visible window keeps its log live while the
// user works in Studio) and run once when it shows again. No DOM or Tauri here, so the tests
// import it in node.

let focused = false;
let shown = false;
const idleListeners = new Set();
const pollers = new Set();

/** What the window reports: focused, and shown (visible and not minimized) */
export function setWindowState(next) {
  const wasIdle = !focused;
  const wasShown = shown;
  if (typeof next.focused === "boolean") focused = next.focused;
  if (typeof next.shown === "boolean") shown = next.shown;
  if (wasIdle !== !focused) for (const fn of idleListeners) fn(!focused);
  if (!wasShown && shown) for (const poller of [...pollers]) poller.run();
}

/** No focus: animations pause */
export const isIdle = () => !focused;
/** Hidden or minimized: pollers skip their turn */
export const isAsleep = () => !shown;

/** Called with the new idle value on each change */
export function onIdleChange(fn) {
  idleListeners.add(fn);
  return () => idleListeners.delete(fn);
}

/** setInterval that skips its turns while the window sleeps and runs once when it wakes */
export function every(ms, fn) {
  const poller = {
    run: () => {
      if (shown) fn();
    },
    stop: () => {
      clearInterval(poller.timer);
      pollers.delete(poller);
    },
  };
  poller.timer = setInterval(poller.run, ms);
  pollers.add(poller);
  return poller;
}
