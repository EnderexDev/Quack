import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "ui");
const read = (name: string) => fs.readFileSync(path.join(ui, name), "utf8");

/** The keys of one language's block in i18n.js */
function keysOf(language: "en" | "pt"): Set<string> {
  const text = read("i18n.js");
  const start = text.indexOf(`  ${language}: {`);
  const end = language === "en" ? text.indexOf("  pt: {") : text.indexOf("\n};", start);
  return new Set([...text.slice(start, end).matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]));
}

test("app: the Queue tab and the Queue settings have every string in English and Portuguese", () => {
  assert.match(read("index.html"), /data-view="queue" data-t="queue"/);
  const main = read("main.js");
  assert.match(main, /if \(ui\.view === "queue"\) return renderQueue\(target\)/);
  const used = new Set([...main.matchAll(/t\("((?:queue|qs)\w*)"/g)].map((m) => m[1]));
  for (const m of main.matchAll(/\["\w+", "(qs\w+)"\]/g)) used.add(m[1]);
  assert.ok(used.size > 30, `${used.size} queue strings found`);
  for (const language of ["en", "pt"] as const) {
    const keys = keysOf(language);
    const missing = [...used].filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `${language} is missing ${missing.join(", ")}`);
  }
});

test("app: Settings > Queue offers every timing the hub keeps", async () => {
  const { DEFAULT_SETTINGS } = await import("../queue/settings.js");
  const main = read("main.js");
  const fields = new Set([...main.matchAll(/\["(\w+)", "qs\w+"\]/g)].map((m) => m[1]));
  fields.add("sharedRetry"); // a choice of two, not a number
  assert.deepEqual([...fields].sort(), Object.keys(DEFAULT_SETTINGS).sort());
});
