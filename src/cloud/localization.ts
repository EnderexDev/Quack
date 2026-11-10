import fs from "node:fs";
import path from "node:path";
import { RobloxError, type RobloxEnv } from "../control/roblox.js";
import type { CloudOp } from "./ops.js";
import { allPages, checkUniverseName, cloudRequest, idArg, readJsonFile, universeLabel } from "./web.js";

/**
 * A universe's auto-localization table through Open Cloud, ported from
 * ~/.claude/scripts/roblox-cloud.mjs (`loc ...`) and Anime Astral's loc-check.mjs.
 *
 * `loc.push` adds English strings the table lacks, with no translation, and Roblox's automatic
 * translation fills every enabled language within minutes (measured 13/10/2026; text capture
 * takes up to days). It spends the universe's translation quota once per string and language
 * with automatic translation on, so `loc.setLangs` turns languages off. `loc.translate` writes
 * translations we made: they spend no quota, and Roblox never overwrites them (a source edited
 * later needs them written again). `loc.delete` has no undo: `loc.dump` keeps a copy first.
 *
 * Measured limits: a source of at most 300 characters; PATCHes of 50 entries (the limits
 * endpoint says 300, but 100 came back 400 code 10 "Maximum entries exceeded", 13/10/2026); a
 * table of 10,000 entries refuses new ones (MaxEntryLimitReached), and a slot freed by a delete
 * takes minutes to count (07/11/2026). Entry counts come from paging the table: the count
 * endpoint read 5,275 while paging found 5,426 (13/10/2026).
 */

const LOC = "https://apis.roblox.com/legacy-localization-tables/v1";
const I18N = "https://apis.roblox.com/legacy-game-internationalization/v1/supported-languages/games";
const PERMISSION = "legacy-universe:manage";
export const LOC_MAX_SOURCE = 300;
export const LOC_MAX_PER_UPDATE = 50;
export const LOC_TABLE_MAX = 10_000;
const CHECK_LOCALES = ["pt", "es", "fr", "ru", "vi", "th"];

const tableUrl = (tableId: string, universeId: string) => `${LOC}/localization-table/tables/${tableId}?gameId=${universeId}`;

async function locTable(env: RobloxEnv, universeId: string): Promise<any> {
  const info = await cloudRequest(env, { method: "POST", url: `${LOC}/autolocalization/games/${universeId}/autolocalizationtable`, permission: PERMISSION, what: `the localization table of universe ${universeId}`, idempotent: true });
  if (!info?.autoLocalizationTableId) throw new RobloxError(`universe ${universeId} has no auto-localization table`);
  return info;
}

async function locEntries(env: RobloxEnv, universeId: string, tableId: string) {
  const what = `the entries of universe ${universeId}'s table`;
  const entries: any[] = await allPages(what, async (cursor) => {
    const page = await cloudRequest(env, { method: "GET", url: `${LOC}/localization-table/tables/${tableId}/entries?gameId=${universeId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, permission: PERMISSION, what, idempotent: true });
    return { items: page?.data ?? [], next: page?.nextPageCursor || "" };
  });
  const untranslated = entries.filter((e) => !(e.translations ?? []).length).length;
  const sources = new Set<string>(entries.map((e) => e.identifier?.source));
  return { entries, sources, total: entries.length, untranslated };
}

/** Sends entries 50 at a time; the failures Roblox lists come back, not thrown */
async function patchEntries(env: RobloxEnv, universeId: string, tableId: string, entries: unknown[], what: string) {
  const failures: string[] = [];
  for (let i = 0; i < entries.length; i += LOC_MAX_PER_UPDATE) {
    const out = await cloudRequest(env, { method: "PATCH", url: tableUrl(tableId, universeId), body: { entries: entries.slice(i, i + LOC_MAX_PER_UPDATE) }, permission: PERMISSION, what, idempotent: true });
    for (const f of out?.failedEntriesAndTranslations ?? []) failures.push(JSON.stringify(f).slice(0, 200));
  }
  return failures;
}

/** What a file a write was approved on held when the dialog read it: the write sends that */
const approved = new WeakMap<Record<string, any>, unknown>();

function stringsFile(args: Record<string, any>): string[] {
  const data = approved.get(args) ?? readJsonFile(args.file, "file");
  if (!Array.isArray(data) || data.some((s) => typeof s !== "string")) throw new RobloxError(`${args.file} must hold a JSON array of strings`);
  return [...new Set(data as string[])];
}

/** push: the strings with a letter, unique; the ones over the source limit apart */
function pushWanted(args: Record<string, any>) {
  const wanted = stringsFile(args).filter((s) => /\p{L}/u.test(s));
  return { wanted, tooLong: wanted.filter((s) => s.length > LOC_MAX_SOURCE) };
}

/** delete matches entries with an empty key and context: the way capture and push write them */
const plainEntry = (e: any, wanted: Set<string>) => wanted.has(e.identifier?.source) && !e.identifier?.key && !e.identifier?.context;

function expectedArg(args: Record<string, any>): number {
  const n = Number(args.expected);
  if (!Number.isSafeInteger(n) || n < 0) throw new RobloxError("expected must be the count loc.plan answered (a whole number)");
  return n;
}

// ---------------------------------------------------------------------------------------
// The translations file, checked before it is sent (Anime Astral's loc-check.mjs, without its
// Jev reading of meaning): placeholders, RichText tags in order, emojis and private-use icon
// glyphs, redeem codes after "Codes:", the source limit, and every locale asked present.

export type Translations = Record<string, Record<string, string>>;

const placeholders = (s: string) => (s.match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(",");
const tags = (s: string) => (s.match(/<[^<>]+>/g) || []).join("");
const icons = (s: string) => (s.match(/[\uE000-\uF8FF]|\p{Extended_Pictographic}/gu) || []).sort().join("");
/** The redeem codes after "Codes:" up to the end of the text (one line), found with one scan */
const codes = (s: string): string[] => {
  const head = /\bcodes?[ \t]*:/i.exec(s);
  if (!head) return [];
  const tail = s.slice(head.index + head[0].length).trim();
  if (!tail || tail.includes("\n")) return [];
  return tail.split(/[,\s]+/).filter((c) => /[A-Z]{3,}/.test(c)).map((c) => c.replace(/[.!]+$/, ""));
};

export function lintTranslations(data: unknown, locales: string[] = []): { strings: number; translations: number; locales: string[]; problems: string[]; broken: number } {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new RobloxError('the translations file must be { "<English source>": { "<locale>": "<text>" } }');
  const problems: string[] = [];
  /** Problems no send survives (unchecked or not): an entry Roblox cannot take */
  let broken = 0;
  const seen = new Set<string>();
  let translations = 0;
  for (const [source, t] of Object.entries(data as Record<string, unknown>)) {
    const at = (loc?: string) => `${source.slice(0, 40)}${loc ? ` [${loc}]` : ""}`;
    if (!source.trim()) {
      problems.push("an entry has an empty source");
      broken++;
      continue;
    }
    if (source.length > LOC_MAX_SOURCE) {
      // Roblox refuses it: no send takes it, and its text is not checked further
      problems.push(`${at()}: source over ${LOC_MAX_SOURCE} characters`);
      broken++;
      continue;
    }
    const sourceCodes = codes(source);
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      problems.push(`${at()}: not an object of locale -> text`);
      broken++;
      continue;
    }
    for (const loc of locales) if (!(loc in t)) problems.push(`${at(loc)}: missing`);
    for (const [loc, v] of Object.entries(t as Record<string, unknown>)) {
      if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(loc)) {
        problems.push(`${at(loc)}: not a locale code`);
        broken++;
      }
      if (typeof v !== "string" || !v.trim()) {
        problems.push(`${at(loc)}: empty`);
        broken++;
        continue;
      }
      seen.add(loc);
      translations++;
      if (placeholders(v) !== placeholders(source)) problems.push(`${at(loc)}: placeholders differ`);
      if (tags(v) !== tags(source)) problems.push(`${at(loc)}: tags differ`);
      if (icons(v) !== icons(source)) problems.push(`${at(loc)}: emojis or icon glyphs differ`);
      for (const c of sourceCodes) if (!v.includes(c)) problems.push(`${at(loc)}: redeem code ${c} changed`);
    }
  }
  return { strings: Object.keys(data as object).length, translations, locales: [...seen].sort(), problems, broken };
}

function localesArg(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((l) => typeof l !== "string" || !/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(l))) throw new RobloxError("locales must be a list of locale codes (pt, es, zh-hans)");
  return raw as string[];
}

/** The translations file read and checked; a problem stops it before any dialog opens */
function translationsFile(args: Record<string, any>) {
  const data = readJsonFile(args.file, "file");
  const lint = lintTranslations(data, localesArg(args.locales));
  if (lint.problems.length && (args.unchecked !== true || lint.broken > 0)) {
    throw new RobloxError(`${lint.problems.length} problems in ${args.file}, nothing was sent:\n${lint.problems.slice(0, 40).map((p) => `  ${p}`).join("\n")}${lint.problems.length > 40 ? `\n  ... and ${lint.problems.length - 40} more` : ""}`);
  }
  return { data: data as Translations, lint };
}

// ---------------------------------------------------------------------------------------

export const LOCALIZATION_OPS: Record<string, CloudOp> = {
  "loc.info": {
    write: false,
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      const info = await locTable(ctx.env, universeId);
      const table = await locEntries(ctx.env, universeId, info.autoLocalizationTableId);
      return {
        universeId,
        tableId: info.autoLocalizationTableId,
        entries: table.total,
        max: LOC_TABLE_MAX,
        untranslated: table.untranslated,
        sourceLanguage: info.sourceLanguage,
        autoLocalization: info.isAutolocalizationEnabled,
        textCapture: info.isAutomaticEntriesSettingEnabled,
        captureCleanup: info.isAutomaticEntriesDeletionEnabled,
        usesTable: info.shouldUseLocalizationTable,
      };
    },
  },
  "loc.dump": {
    write: false,
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      if (typeof args.out !== "string" || !path.isAbsolute(args.out) || !/\.json$/i.test(args.out)) throw new RobloxError("out must be an absolute .json path");
      // A read with no dialog: it makes a new file and never replaces one (a config, a package.json)
      if (fs.existsSync(args.out)) throw new RobloxError(`${args.out} already exists: the dump goes to a new file`);
      const info = await locTable(ctx.env, universeId);
      const table = await locEntries(ctx.env, universeId, info.autoLocalizationTableId);
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, JSON.stringify(table.entries), { flag: "wx" });
      return { universeId, entries: table.total, file: args.out };
    },
  },
  "loc.plan": {
    write: false,
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      if (args.action !== "push" && args.action !== "delete") throw new RobloxError("action must be push or delete");
      const info = await locTable(ctx.env, universeId);
      const table = await locEntries(ctx.env, universeId, info.autoLocalizationTableId);
      if (args.action === "delete") {
        const wanted = new Set(stringsFile(args));
        const found = table.entries.filter((e) => plainEntry(e, wanted));
        return { universeId, action: "delete", total: table.total, asked: wanted.size, found: found.length, sample: found.slice(0, 5).map((e) => e.identifier.source) };
      }
      const { wanted, tooLong } = pushWanted(args);
      const missing = wanted.filter((s) => s.length <= LOC_MAX_SOURCE && !table.sources.has(s));
      return {
        universeId, action: "push", total: table.total, max: LOC_TABLE_MAX, strings: wanted.length,
        already: wanted.length - missing.length - tooLong.length, missing: missing.length,
        tooLong: tooLong.map((s) => `${s.slice(0, 80)} (${s.length})`), sample: missing.slice(0, 5),
        overCap: table.total + missing.length > LOC_TABLE_MAX,
      };
    },
  },
  "loc.push": {
    write: true,
    describe: (args) => {
      idArg(args.universeId, "the universe id");
      const expected = expectedArg(args);
      approved.set(args, readJsonFile(args.file, "file"));
      const { wanted } = pushWanted(args);
      return {
        title: "Quack: add strings to a localization table",
        text: [
          `Add ${expected} English strings from ${args.file} (${wanted.length} in the file) to the localization table of ${universeLabel(args)}, with no translation.`,
          "Roblox's automatic translation then fills each language that has it on, spending the universe's translation quota once per string and language.",
          "Entries can be deleted later, but a deleted string cannot be added back as it was.",
        ].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      await checkUniverseName(ctx.env, args);
      const expected = expectedArg(args);
      const { wanted } = pushWanted(args);
      const info = await locTable(ctx.env, universeId);
      const table = await locEntries(ctx.env, universeId, info.autoLocalizationTableId);
      const missing = wanted.filter((s) => s.length <= LOC_MAX_SOURCE && !table.sources.has(s));
      if (missing.length > expected) throw new RobloxError(`the table now lacks ${missing.length} of these strings, more than the ${expected} approved: nothing was sent. Plan it again`);
      const failures = await patchEntries(ctx.env, universeId, info.autoLocalizationTableId, missing.map((source) => ({ identifier: { key: "", context: "", source }, translations: [] })), `the strings added to universe ${universeId}'s table`);
      // The PATCH answers an empty "modified" list even when it made the entries: loc.info
      // a few minutes later shows them
      return { universeId, before: table.total, sent: missing.length - failures.length, failed: failures.length, failures: failures.slice(0, 20) };
    },
  },
  "loc.delete": {
    write: true,
    describe: (args) => {
      idArg(args.universeId, "the universe id");
      const expected = expectedArg(args);
      approved.set(args, readJsonFile(args.file, "file"));
      const wanted = stringsFile(args);
      return {
        title: "Quack: delete localization entries",
        text: [
          `Delete ${expected} entries (the ${wanted.length} sources in ${args.file} that the table has), and every translation they hold, from the localization table of ${universeLabel(args)}.`,
          "There is no undo (loc dump keeps a copy), and a deleted string cannot be added back with an empty context.",
        ].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      await checkUniverseName(ctx.env, args);
      const expected = expectedArg(args);
      const wanted = new Set(stringsFile(args));
      const info = await locTable(ctx.env, universeId);
      const table = await locEntries(ctx.env, universeId, info.autoLocalizationTableId);
      const found = table.entries.filter((e) => plainEntry(e, wanted));
      if (found.length > expected) throw new RobloxError(`the table now has ${found.length} of these entries, more than the ${expected} approved: nothing was deleted. Plan it again`);
      const failures = await patchEntries(ctx.env, universeId, info.autoLocalizationTableId, found.map((e) => ({ identifier: { key: "", context: "", source: e.identifier.source }, delete: true })), `the entries deleted from universe ${universeId}'s table`);
      return { universeId, before: table.total, deleted: found.length - failures.length, failed: failures.length, failures: failures.slice(0, 20) };
    },
  },
  "loc.translate": {
    write: true,
    describe: (args) => {
      idArg(args.universeId, "the universe id");
      const { data, lint } = translationsFile(args);
      approved.set(args, data);
      return {
        title: "Quack: write translations",
        text: [
          `Write ${lint.translations} translations of ${lint.strings} strings (${lint.locales.join(", ")}) from ${args.file} to the localization table of ${universeLabel(args)}.`,
          "They replace the translation each of those strings has in those languages. Roblox's automatic translation never overwrites them, and they spend no quota.",
          ...(lint.problems.length ? [`The file has ${lint.problems.length} problems the check found (sent anyway, as asked).`] : []),
        ].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      await checkUniverseName(ctx.env, args);
      const data = (approved.get(args) ?? translationsFile(args).data) as Translations;
      const entries = Object.entries(data).map(([source, t]) => ({
        identifier: { key: "", context: "", source },
        translations: Object.entries(t).map(([locale, translationText]) => ({ locale, translationText })),
      }));
      const info = await locTable(ctx.env, universeId);
      const failures = await patchEntries(ctx.env, universeId, info.autoLocalizationTableId, entries, `the translations sent to universe ${universeId}'s table`);
      return { universeId, sent: entries.length - failures.length, failed: failures.length, failures: failures.slice(0, 20) };
    },
  },
  "loc.check": {
    write: false,
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      if (typeof args.source !== "string" || !args.source) throw new RobloxError("source is required: the English text of the entry");
      const locales = localesArg(args.locales);
      const info = await locTable(ctx.env, universeId);
      const out: { locale: string; text?: string; by?: string; at?: string }[] = [];
      for (const locale of locales.length ? locales : CHECK_LOCALES) {
        const answer = await cloudRequest(ctx.env, {
          method: "POST",
          url: `${LOC}/localization-table/tables/${info.autoLocalizationTableId}/entries/translation-history?gameId=${universeId}`,
          body: { locale, entries: [{ identifier: { key: "", context: "", source: args.source }, count: 1, sortOrder: "Desc" }] },
          permission: PERMISSION, what: `the ${locale} translation of "${args.source.slice(0, 40)}"`, idempotent: true,
        });
        const last = answer?.entries?.[0]?.history?.[0];
        out.push(last ? { locale, text: last.translationText, by: last.translator?.agentType, at: last.created } : { locale });
      }
      return { universeId, source: args.source, translations: out };
    },
  },
  "loc.langs": {
    write: false,
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      const status = await cloudRequest(ctx.env, { method: "GET", url: `${I18N}/${universeId}/automatic-translation-status`, permission: PERMISSION, what: `the languages of universe ${universeId}`, idempotent: true });
      const all: any[] = status?.data ?? [];
      return { universeId, on: all.filter((l) => l.isAutomaticTranslationEnabled).map((l) => l.languageCode), off: all.filter((l) => !l.isAutomaticTranslationEnabled).map((l) => l.languageCode) };
    },
  },
  "loc.setLangs": {
    write: true,
    describe: (args) => {
      idArg(args.universeId, "the universe id");
      const changes = langChanges(args);
      const on = changes.filter((c) => c.on).map((c) => c.code);
      const off = changes.filter((c) => !c.on).map((c) => c.code);
      return {
        title: "Quack: automatic translation by language",
        text: [
          `In ${universeLabel(args)}:`,
          ...(on.length ? [`  turn automatic translation ON for ${on.join(", ")} (every string without a translation there is then translated, spending the quota)`] : []),
          ...(off.length ? [`  turn automatic translation OFF for ${off.join(", ")} (the translations already made stay)`] : []),
        ].join("\n"),
      };
    },
    run: async (ctx, args) => {
      const universeId = idArg(args.universeId, "the universe id");
      await checkUniverseName(ctx.env, args);
      const done: { code: string; on: boolean }[] = [];
      for (const change of langChanges(args)) {
        const out = await cloudRequest(ctx.env, { method: "PATCH", url: `${I18N}/${universeId}/languages/${change.code}/automatic-translation-status`, body: change.on, permission: PERMISSION, what: `automatic translation for ${change.code}`, idempotent: true });
        done.push({ code: change.code, on: out?.isAutomaticTranslationEnabled === true });
      }
      return { universeId, changed: done };
    },
  },
};

function langChanges(args: Record<string, any>): { code: string; on: boolean }[] {
  const raw = args.changes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length) throw new RobloxError('changes must be { "<language code>": true | false }');
  return Object.entries(raw).map(([code, on]) => {
    if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(code)) throw new RobloxError(`${code} is not a language code`);
    if (typeof on !== "boolean") throw new RobloxError(`${code} must be true (on) or false (off)`);
    return { code, on };
  });
}
