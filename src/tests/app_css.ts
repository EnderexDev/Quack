import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The app's styles are split by owner (app/ui/base.css, controls.css, shell.css, one file per
// group of views, dialogs.css, tray.css). Tests that look for a rule read them all, in the order
// the main window links them, so a rule moving between files never breaks a test.

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "ui");

/** The stylesheets a page links, in order */
export const linkedSheets = (page: string): string[] =>
  [...fs.readFileSync(path.join(ui, page), "utf8").matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);

/** Every stylesheet of the main window, joined in link order, with LF line ends */
export const appCss = (): string =>
  linkedSheets("index.html").map((f) => fs.readFileSync(path.join(ui, f), "utf8")).join("\n").replace(/\r\n/g, "\n");
