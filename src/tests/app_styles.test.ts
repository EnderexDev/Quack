import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appCss, linkedSheets } from "./app_css.js";

// The app's styles, split by owner for the Quackify redesign (18/11/26): every file is linked by
// both windows in one order, nothing points at a file that is not there, and the shared controls
// keep the brand colour for the screen's main action only.

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
const ui = path.join(app, "ui");

test("app styles: both windows link every stylesheet, in the same order", () => {
  const main = linkedSheets("index.html");
  assert.ok(main.length >= 5, `${main.length} stylesheets`);
  assert.deepEqual(linkedSheets("tray.html"), main);
  for (const f of main) assert.ok(fs.existsSync(path.join(ui, f)), `${f} is linked but missing`);
  const onDisk = fs.readdirSync(ui).filter((f) => f.endsWith(".css")).sort();
  assert.deepEqual(onDisk, [...main].sort(), "a stylesheet in app/ui that no window links");
  // Tokens first: every other file reads them
  assert.equal(main[0], "base.css");
});

test("app styles: every font and image a stylesheet names is in app/ui, and the unused Archivo is gone", () => {
  const css = appCss();
  const urls = [...css.matchAll(/url\(["']?(?!data:|%23|#)([^"')]+)["']?\)/g)].map((m) => m[1]);
  assert.ok(urls.some((u) => u.startsWith("fonts/")), "the fonts are referenced");
  // A query or a fragment (?v=2, #iefix) is not part of the file's name
  const file = (u: string) => u.split(/[?#]/)[0];
  for (const u of urls) assert.ok(fs.existsSync(path.join(ui, file(u))), `${u} is missing`);
  const fonts = fs.readdirSync(path.join(ui, "fonts"));
  assert.deepEqual(fonts.filter((f) => /archivo/i.test(f)), []);
  assert.doesNotMatch(css, /Archivo/);
  // Every font file shipped is used by a @font-face (the licence text goes with Fredoka)
  for (const f of fonts.filter((f) => /\.(ttf|woff2?)$/.test(f))) assert.ok(urls.some((u) => file(u) === `fonts/${f}`), `fonts/${f} is shipped but unused`);
});

test("app styles: a switched-on toggle and a level pill are neutral, the brand stays for the main action", () => {
  // Comments and @media headers out, so the first rule inside a media block is read as a rule
  const css = appCss().replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{/g, "");
  const rules = (selector: RegExp) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => selector.test(m[1].trim())).map((m) => m[2]);
  const tog = rules(/^\.tog(::after)?$/);
  assert.equal(tog.length, 2, "the toggle and its knob");
  for (const body of tog) assert.doesNotMatch(body, /--brand-/);
  // The queue's level pill (main.js) is a neutral pill, not .pill.brand
  const main = fs.readFileSync(path.join(ui, "main.js"), "utf8");
  assert.doesNotMatch(main, /class: "pill brand", title: w\.effectiveLevel/);
});

// 18/11/26, the merge of the Quackify restyle: the groups had each made the same small parts (a
// square sign, an armed danger button, a search, a tick box, a round pick, a chevron, glyphs).
// One copy now, in controls.css; a view restyles them under its own scope, never redefines them
test("app styles: the shared small parts are defined only in controls.css", () => {
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  const shared = [/^\.slot(\.[a-z]+)*$/, /^\.btn\.danger\.armed(:hover)?$/, /^\.search-field\b/, /^input\.checkbox\b/, /^\.radio\b/, /^\.chev$/, /^\.ico\.i-[a-z]+$/];
  for (const file of fs.readdirSync(ui).filter((f) => f.endsWith(".css"))) {
    const css = strip(fs.readFileSync(path.join(ui, file), "utf8"));
    const selectors = [...css.matchAll(/([^{}]+)\{[^}]*\}/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()));
    const found = selectors.filter((s) => shared.some((re) => re.test(s)));
    if (file === "controls.css") assert.ok(found.length >= 15, `controls.css defines the shared parts (${found.length})`);
    else assert.deepEqual(found, [], `${file} redefines a shared part`);
  }
  // The old per-group names are gone from the windows' code
  const code = ["main.js", "tray.js", "common.js"].map((f) => fs.readFileSync(path.join(ui, f), "utf8")).join("\n");
  assert.doesNotMatch(code, /"qslot|ico q-|set-ico-|mchev|set-search|dlg-icon/);
});

test("app styles: the window's first paint is the page's own background", () => {
  const bg = /--bg:\s*(#[0-9a-f]{6})\s*;/i.exec(appCss())?.[1]?.toLowerCase();
  assert.ok(bg);
  for (const conf of ["tauri.conf.json", "tauri.official.conf.json"]) {
    const json = JSON.parse(fs.readFileSync(path.join(app, "src-tauri", conf), "utf8"));
    const main = json.app.windows.find((w: { label: string }) => w.label === "main");
    assert.equal(String(main.backgroundColor).toLowerCase(), bg, conf);
  }
});

test("app styles: the layout grows with the window from one root size", () => {
  const css = appCss();
  // One clamp on the root sets 1rem; it is 16 px at the window's own 1120 x 740
  const root = /\bhtml \{[^}]*font-size: ([^;]+);/.exec(css)?.[1];
  assert.ok(root && /clamp\(/.test(root), `root font-size: ${root}`);
  // Every size is rem: a px value does not grow (a capture at 1920 x 1080 showed the blocks small
  // before this). Allowed in px: hairlines up to 2 px, the pill radius, the root clamp's bounds
  // and a media query's own condition
  const rootRule = /\bhtml \{[^}]*\}/.exec(css)?.[0] ?? "";
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(rootRule, "").replace(/@media[^{]*\{/g, "@media {");
  // Negative values (a translate) and an upper-case PX count too
  const px = [...body.matchAll(/(?<![\w.])-?(\d*\.?\d+)px\b/gi)].map((m) => m[0]).filter((v) => Math.abs(parseFloat(v)) > 2 && v.toLowerCase() !== "999px");
  assert.deepEqual(px, [], "px sizes in a stylesheet: write them in rem (px / 16)");
  const inline = ["main.js", "tray.js", "common.js", "aiview.js", "queueview.js"].flatMap((f) =>
    [...fs.readFileSync(path.join(ui, f), "utf8").matchAll(/style: "([^"]*)"/g)]
      .filter((m) => [...m[1].matchAll(/(\d*\.?\d+)px\b/gi)].some((v) => parseFloat(v[1]) > 2))
      .map((m) => `${f}: ${m[0]}`));
  assert.deepEqual(inline, []);
});
