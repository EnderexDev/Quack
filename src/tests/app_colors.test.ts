import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
const read = (p: string) => fs.readFileSync(path.join(app, p));
const json = (p: string) => JSON.parse(read(p).toString("utf8"));

// Quack Dev tells apart from Quack by colour alone: green icons, tray and UI where Official is yellow
test("each app bundles its own colour of icons", () => {
  const dev = json("src-tauri/tauri.conf.json").bundle.icon as string[];
  const official = json("src-tauri/tauri.official.conf.json").bundle.icon as string[];
  assert.ok(dev.length > 0 && dev.every((p) => p.startsWith("icons-dev/")));
  assert.ok(official.length > 0 && official.every((p) => p.startsWith("icons/")));
  for (const p of dev) assert.notDeepEqual(read(`src-tauri/${p}`), read(`src-tauri/${p.replace("icons-dev/", "icons/")}`), p);
});

test("each app swaps its own colour of tray icons", () => {
  const main = read("src-tauri/src/main.rs").toString("utf8");
  // A Windows checkout has CRLF line ends
  const [official, dev] = main.split(/#\[cfg\(not\(feature = "official"\)\)\]\r?\nmod flavor/);
  for (const state of ["ok", "warn", "bad", "paused"]) {
    assert.ok(official.includes(`include_bytes!("../tray/${state}.png")`), state);
    assert.ok(dev.includes(`include_bytes!("../tray-dev/${state}.png")`), state);
    assert.notDeepEqual(read(`src-tauri/tray-dev/${state}.png`), read(`src-tauri/tray/${state}.png`), state);
  }
});

test("the Dev UI overrides every brand token", () => {
  const css = read("ui/style.css").toString("utf8");
  const tokens = (block: string) => [...block.matchAll(/(--brand-[a-z0-9]+):/g)].map((m) => m[1]).sort();
  const root = css.slice(css.indexOf(":root {"), css.indexOf("\n}", css.indexOf(":root {")));
  const dev = css.slice(css.indexOf("html.dev {"), css.indexOf("}", css.indexOf("html.dev {")));
  assert.deepEqual(tokens(dev), tokens(root));
  assert.ok(!/#ff8a0f|#3d3000/.test(css.slice(css.indexOf("\n}", css.indexOf(":root {")))), "a hardcoded yellow outside :root");
  assert.match(read("ui/common.js").toString("utf8"), /classList\.toggle\("dev", appInfo\.flavor === "dev"\)/);
});

// The big icon's face once was 58x53 to leave room for its shadow, and every toast showed it flattened
test("the icon's face and shadow are square", () => {
  for (const svg of ["assets/icon.svg", "assets/icon-small.svg"]) {
    const rects = [...read(svg).toString("utf8").matchAll(/<rect [^>]*width="([\d.]+)" height="([\d.]+)"/g)];
    assert.ok(rects.length > 0, svg);
    for (const [, w, h] of rects) assert.equal(w, h, svg);
  }
});

// The status dot sat at the bottom-right, over the Q's tail, and the Q read as an O (22/10/26)
test("the status dot leaves the Q's tail visible", async () => {
  const { Resvg } = await import("@resvg/resvg-js");
  const plugin = path.join(app, "..", "plugin", "assets");
  const pngs = [
    ...["tray", "tray-dev"].map((dir) => path.join(app, "src-tauri", dir, "ok.png")),
    ...["logo-synced.png", "logo-dev-synced.png"].map((f) => path.join(plugin, f)),
  ];
  for (const file of pngs) {
    const uri = `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64"><image width="64" height="64" xlink:href="${uri}"/></svg>`;
    const px = new Resvg(svg).render().pixels;
    const green = (x: number, y: number) => {
      const i = (y * 64 + x) * 4;
      return px[i] < 0x60 && px[i + 1] > 0xc0 && px[i + 2] > 0x60 && px[i + 2] < 0xa0; // #4ade80
    };
    assert.ok(green(52, 12), `${file}: dot in the top-right corner`);
    assert.ok(!green(48, 48) && !green(50, 50), `${file}: nothing green over the tail`);
  }
});
