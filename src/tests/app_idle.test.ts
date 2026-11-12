import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 12/11/26: the app's two windows live on hidden in the tray, and their WebView2 used 0.7 of a
// core doing nothing: the pulsing dot animated box-shadow (a repaint every frame, forever) and
// five pollers ran with the window hidden. These hold the fix in place.

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
const read = (p: string) => fs.readFileSync(path.join(app, p), "utf8").replace(/\r\n/g, "\n");

type Idle = {
  setWindowState(s: { focused?: boolean; shown?: boolean }): void;
  isIdle(): boolean;
  isAsleep(): boolean;
  onIdleChange(fn: (idle: boolean) => void): () => void;
  every(ms: number, fn: () => void): { stop(): void };
};
const loadIdle = async (): Promise<Idle> => import(`${pathToFileURL(path.join(app, "ui", "idle.js")).href}?t=${Math.random()}`);

test("app idle: a poller skips its turns while the window is hidden and runs once when it shows", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const idle = await loadIdle();
  let runs = 0;
  // A window starts hidden in the tray: nothing runs until it shows
  const poller = idle.every(1000, () => runs++);
  t.mock.timers.tick(3000);
  assert.equal(runs, 0);
  assert.equal(idle.isAsleep(), true);

  idle.setWindowState({ shown: true });
  assert.equal(runs, 1, "one fresh read when the window shows");
  t.mock.timers.tick(2000);
  assert.equal(runs, 3);

  // Visible but without focus (the user in Studio, the log open): it keeps polling
  idle.setWindowState({ focused: false });
  t.mock.timers.tick(1000);
  assert.equal(runs, 4);

  idle.setWindowState({ shown: false });
  t.mock.timers.tick(5000);
  assert.equal(runs, 4);

  // Stopped: not run again by a later show
  poller.stop();
  idle.setWindowState({ shown: true });
  t.mock.timers.tick(3000);
  assert.equal(runs, 4);
});

test("app idle: losing the focus marks the window idle, gaining it clears it", async () => {
  const idle = await loadIdle();
  const seen: boolean[] = [];
  idle.onIdleChange((v) => seen.push(v));
  assert.equal(idle.isIdle(), true, "idle until the window says it has the focus");
  idle.setWindowState({ focused: true, shown: true });
  idle.setWindowState({ focused: true });
  idle.setWindowState({ focused: false });
  assert.deepEqual(seen, [false, true]);
});

test("app idle: the pulse animates only transform and opacity, and every animation pauses on body.idle", () => {
  const css = read("ui/style.css");
  // The whole block, up to the brace that closes @keyframes, however it is laid out
  const from = css.indexOf("@keyframes pulse");
  let keyframes = "";
  for (let i = css.indexOf("{", from), depth = 0; from >= 0 && i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      keyframes = css.slice(css.indexOf("{", from) + 1, i);
      break;
    }
  }
  assert.ok(keyframes, "the pulse keyframes are there");
  assert.doesNotMatch(keyframes, /box-shadow|width|height|background|top|left|inset/);
  assert.match(keyframes, /transform/);
  assert.match(css, /\.dot\.live::after \{[^}]*animation: pulse/);
  assert.doesNotMatch(css, /\.dot\.live \{[^}]*animation/);
  assert.match(css, /body\.idle \*, body\.idle \*::before, body\.idle \*::after \{ animation-play-state: paused !important; \}/);
  // Both windows load common.js, which ties body.idle to the window's focus
  const common = read("ui/common.js");
  assert.match(common, /onIdleChange\(\(idle\) => document\.body\.classList\.toggle\("idle", idle\)\)/);
  assert.match(common, /win\.onFocusChanged/);
  assert.match(read("ui/tray.js"), /from "\.\/common\.js"/);
});

test("app idle: every background poll of the main window goes through every(), the approval countdown stays", () => {
  const main = read("ui/main.js");
  const intervals = [...main.matchAll(/setInterval\((\w+)/g)].map((m) => m[1]);
  // The countdown of a write waiting for the user: it runs only while the popup is up
  assert.deepEqual(intervals, ["tick"]);
  for (const poll of ["LOG_POLL_MS", "MERGES_POLL_MS", "ANALYSIS_POLL_MS", "QUEUE_POLL_MS"]) {
    assert.match(main, new RegExp(`every\\(${poll}, `), poll);
  }
});
