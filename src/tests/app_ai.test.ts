import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codexDefaultModel, codexModels } from "../merge/ai.js";

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "ui");
const read = (name: string) => fs.readFileSync(path.join(ui, name), "utf8");

function keysOf(language: "en" | "pt"): Set<string> {
  const text = read("i18n.js");
  const start = text.indexOf(`  ${language}: {`);
  const end = language === "en" ? text.indexOf("  pt: {") : text.indexOf("\n};", start);
  return new Set([...text.slice(start, end).matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]));
}

// 14/11/26: the AI merge card showed the model as a read-only pill. It is now a choice: Sonnet,
// Opus or Haiku for Claude Code; for Codex, the models its own cache lists, plus its default.
test("ai: the Codex models are the cache's visible ones in its order, none without a cache", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "quack-codex-"));
  try {
    assert.deepEqual(codexModels(home), []);
    assert.equal(codexDefaultModel(home), null);
    fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({
      models: [
        { slug: "gpt-old", visibility: "hide", priority: 0 },
        { slug: "gpt-5.5", visibility: "list", priority: 2 },
        { slug: "gpt-5.5-codex", visibility: "list", priority: 1 },
        { slug: "gpt-mini", visibility: "list" },
        { visibility: "list", priority: 0 },
      ],
    }));
    assert.deepEqual(codexModels(home), ["gpt-5.5-codex", "gpt-5.5", "gpt-mini"]);
    assert.equal(codexDefaultModel(home), "gpt-5.5-codex");
    fs.writeFileSync(path.join(home, "models_cache.json"), "{ half");
    assert.deepEqual(codexModels(home), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

type Choice = { provider: string; field: "model" | "codexModel"; current: string; options: { value: string; on: boolean }[] } | null;
type AiView = {
  modelChoice(ai: unknown): Choice;
  modelPill(ai: unknown): string;
  modelLabel(value: string): string;
};
const loadView = async (): Promise<AiView> => import(pathToFileURL(path.join(ui, "aiview.js")).href);

const status = (provider: "claude" | "codex", settings: Record<string, unknown>, withModels = true) => ({
  effective: { state: "ready", provider },
  settings: { ai: true, provider, ...settings },
  usable: ["claude", "codex"],
  detected: {
    claude: { installed: true, loggedIn: true, model: settings.model ?? "sonnet", ...(withModels ? { models: ["sonnet", "opus", "haiku"] } : {}) },
    codex: { installed: true, loggedIn: true, model: settings.codexModel || "gpt-5.5-codex", ...(withModels ? { models: ["gpt-5.5-codex", "gpt-5.5"] } : {}) },
  },
});

test("app ai: the model pill offers the models of the AI in use, with the saved one marked", async () => {
  const v = await loadView();
  const claude = v.modelChoice(status("claude", { model: "opus", codexModel: "" }));
  assert.equal(claude?.field, "model");
  assert.deepEqual(claude?.options, [{ value: "sonnet", on: false }, { value: "opus", on: true }, { value: "haiku", on: false }]);
  assert.equal(v.modelPill(status("claude", { model: "opus", codexModel: "" })), "opus");

  // Codex: its default first (an empty codexModel), then the cache's list
  const codex = v.modelChoice(status("codex", { model: "sonnet", codexModel: "" }));
  assert.equal(codex?.field, "codexModel");
  assert.deepEqual(codex?.options, [{ value: "", on: true }, { value: "gpt-5.5-codex", on: false }, { value: "gpt-5.5", on: false }]);
  assert.equal(v.modelPill(status("codex", { codexModel: "" })), "gpt-5.5-codex", "the default shows the model it is");
  assert.equal(v.modelChoice(status("codex", { codexModel: "gpt-5.5" }))?.options.find((o) => o.on)?.value, "gpt-5.5");

  // A model set by hand in config.json is not in the list: it still shows, nothing is marked
  const own = status("claude", { model: "claude-opus-5-5" });
  assert.equal(v.modelPill(own), "claude-opus-5-5");
  assert.deepEqual(v.modelChoice(own)?.options.filter((o) => o.on), []);

  assert.equal(v.modelLabel("sonnet"), "Sonnet");
  assert.equal(v.modelLabel("gpt-5.5"), "gpt-5.5");
});

test("app ai: an older hub (no model list) and no AI in use keep the read-only pill", async () => {
  const v = await loadView();
  const old = status("claude", {}, false);
  delete (old.settings as Record<string, unknown>).model;
  assert.equal(v.modelChoice(old), null);
  assert.equal(v.modelPill(old), "sonnet", "the model the older hub reports");
  const off = { ...status("claude", {}), effective: { state: "off", provider: null } };
  assert.equal(v.modelChoice(off), null);
  assert.equal(v.modelChoice(null), null);
});

// Council review 14/11/26: a second click on the pill removed the menu but left its window
// listeners, one more pair per open and close
test("app: closing a menu by its own button also drops its window listeners", () => {
  const main = read("main.js");
  const body = main.slice(main.indexOf("function popMenu("), main.indexOf("\nfunction ", main.indexOf("function popMenu(") + 1));
  const closedAt = body.indexOf("closeMenu?.()");
  assert.ok(closedAt > 0, "an open menu is closed through its close function");
  assert.ok(closedAt < body.indexOf("if (openKey === key) return;"), "before the second click returns");
  assert.match(body, /closeMenu = close;/);
  assert.doesNotMatch(body, /open\?\.remove\(\);\s*if \(open\?\.dataset\.key === key\) return;/);
});

test("app ai: the card wires the pill to a menu that posts the model, with every string in English and Portuguese", () => {
  const main = read("main.js");
  assert.match(main, /import \{[^}]*modelChoice[^}]*\} from "\.\/aiview\.js"/);
  assert.match(main, /modelChoice\(ai\)/);
  assert.match(main, /set\(\{ \[choice\.field\]: /, "the pick goes to the hub as model or codexModel");
  assert.match(main, /h\("button", \{ class: "pill brand[^"]*"/, "the pill is a button");
  const used = new Set([...main.matchAll(/t\("(ai\w*)"/g)].map((m) => m[1]));
  for (const key of ["aiModel", "aiModelDefault", "aiModelPick"]) assert.ok(used.has(key), `${key} is used`);
  for (const language of ["en", "pt"] as const) {
    const keys = keysOf(language);
    const missing = [...used].filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `${language} is missing ${missing.join(", ")}`);
  }
});
