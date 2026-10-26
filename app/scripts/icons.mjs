// Renders the app and tray icons from app/assets/*.svg.
//   node app/scripts/icons.mjs
// Writes app/src-tauri/icons/ (what Tauri bundles) and app/src-tauri/tray/ (status icons the
// app swaps at runtime) for Official, in yellow, and icons-dev/ and tray-dev/ for Dev, in green,
// so the two apps tell apart by colour alone, plus the plugin's toolbar logos in plugin/assets/.
// The outputs are committed; run this again after
// changing an SVG.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");
const tauriDir = path.join(here, "..", "src-tauri");

const font = {
  fontFiles: [path.join(assets, "ArchivoBlack.ttf")],
  loadSystemFonts: false,
  defaultFontFamily: "Archivo Black",
};
const bigSvg = fs.readFileSync(path.join(assets, "icon.svg"), "utf8");
const smallSvg = fs.readFileSync(path.join(assets, "icon-small.svg"), "utf8");

/**
 * The SVGs are drawn in the official logo's gold; Dev swaps every gold tone for a green one (the
 * light, mid and dark stops follow the --brand-* greens in app/ui/style.css and Theme.luau)
 */
const DEV_GREEN = {
  "#ffe680": "#a8f29c", // tile top
  "#ffc21a": "#4fd65e", // tile middle
  "#b87a00": "#1f8a3a", // tile bottom
  "#fff2b0": "#dcfcd2", // tile border
  "#7a4a00": "#0f5a22", // tile's lower inner shadow
  "#5a3600": "#0b4519", // the Q's drop shadow
  "#fffbe0": "#f0ffe8", // metallic filete top
  "#ffd54a": "#7fe88a", // filete (metallic middle, the small cut's flat one)
  "#9a6200": "#1f7a33", // metallic filete bottom
};
// The wordmark beside the mark (Figma lockup "quack-lockup-ouro") is drawn by the app and the
// plugin, not here: gold #fff6c8 / #ffcc1f / #b87400, Dev #f0ffe8 / #5ee36a / #1f8a3a, in
// app/ui/style.css (--word-*), Theme.luau (Word) and build-rbxmx.mjs
const recolor = (svg, swap) => Object.entries(swap).reduce((out, [from, to]) => out.split(from).join(to), svg);

const flavors = [
  { icons: "icons", tray: "tray", logo: "logo", swap: {} },
  { icons: "icons-dev", tray: "tray-dev", logo: "logo-dev", swap: DEV_GREEN },
];
const pluginDir = path.join(here, "..", "..", "plugin", "assets");
const uiDir = path.join(here, "..", "ui");

const dots = { ok: "#4ade80", warn: "#f0b232", bad: "#f23f43", paused: "#9a8f80" };
/**
 * The status dot sits in the top-right corner, over the empty side of the Q's bowl: at the
 * bottom-right it covered the Q's tail and the Q read as an O (22/10/26)
 */
const withDot = (svg, color) =>
  svg.replace("</svg>", `<circle cx="52" cy="12" r="10" fill="${color}" stroke="#0a0806" stroke-width="5"/></svg>`);

/** An .ico is a directory of PNGs: Windows picks the size it needs */
function ico(sizes, render) {
  const images = sizes.map((size) => ({ size, png: render(size) }));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

for (const { icons, tray, logo, swap } of flavors) {
  const iconsDir = path.join(tauriDir, icons);
  const trayDir = path.join(tauriDir, tray);
  fs.mkdirSync(iconsDir, { recursive: true });
  fs.mkdirSync(trayDir, { recursive: true });
  const big = recolor(bigSvg, swap);
  const small = recolor(smallSvg, swap);

  /** At 24 px and under the shadow turns to mud: those sizes use the thick-outline cut */
  const render = (size, svg = size <= 24 ? small : big) =>
    new Resvg(svg, { font, fitTo: { mode: "width", value: size } }).render().asPng();

  for (const [name, size] of [["32x32.png", 32], ["128x128.png", 128], ["128x128@2x.png", 256], ["icon.png", 512]]) {
    fs.writeFileSync(path.join(iconsDir, name), render(size));
  }
  fs.writeFileSync(path.join(iconsDir, "icon.ico"), ico([16, 20, 24, 32, 48, 64, 256], render));

  // Tray: the small cut with a status dot in the corner, outlined like everything else
  for (const [state, color] of Object.entries(dots)) {
    fs.writeFileSync(path.join(trayDir, `${state}.png`), render(32, withDot(small, color)));
  }

  // The Studio plugin's toolbar logo, idle and synced: uploaded by hand as decals, their image
  // ids in UI.luau (Official) and build-rbxmx.mjs (Dev)
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, `${logo}.png`), render(128, withDot(small, dots.paused)));
  fs.writeFileSync(path.join(pluginDir, `${logo}-synced.png`), render(128, withDot(small, dots.ok)));
  // The mark beside the name (the lockup): plain, no dot. The app's window shows the SVG; the
  // plugin's top bar a decal of the PNG, its image id in UI.luau (Official) and build-rbxmx.mjs (Dev)
  fs.writeFileSync(path.join(uiDir, `${logo}.svg`), big);
  fs.writeFileSync(path.join(pluginDir, `${logo}-mark.png`), render(128, big));
  console.log(`icons written to ${iconsDir}, ${trayDir}, ${uiDir} and ${pluginDir}`);
}
