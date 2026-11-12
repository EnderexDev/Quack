import fs from "node:fs";
import path from "node:path";

/**
 * What runs on its own (his call, 12/11/26): the review after each AI edit, the findings panel,
 * the alert of a new production error and the pre-commit check. Each one is on or off for every
 * place, and a place may differ. The file is per flavor, next to the hub's registry
 * (automation.json / automation-dev.json), never config.json: that one is shared by both hubs and
 * an older Official rewrites it without the fields it does not know.
 */
export type AutoFeature = "review" | "panel" | "errors" | "precommit";
export const AUTO_FEATURES: readonly AutoFeature[] = ["review", "panel", "errors", "precommit"];

/** The pre-commit check stops commits: off until the user turns it on */
export const AUTO_DEFAULTS: Readonly<Record<AutoFeature, boolean>> = { review: true, panel: true, errors: true, precommit: false };

export interface AutoSettings {
  global: Record<AutoFeature, boolean>;
  /** By place id: only the features the user set for that place */
  places: Record<string, Partial<Record<AutoFeature, boolean>>>;
}

/** hub.json -> automation.json, hub-dev.json -> automation-dev.json */
export function autoSettingsPath(registryFile: string): string {
  return flavorFile(registryFile, "automation");
}

/** A file of this flavor next to its registry: hub-dev.json -> <stem>-dev.json */
export function flavorFile(registryFile: string, stem: string): string {
  const base = path.basename(registryFile, ".json");
  const name = base.startsWith("hub") ? `${stem}${base.slice(3)}.json` : `${base}.${stem}.json`;
  return path.join(path.dirname(registryFile), name);
}

function readRaw(file: string): Record<string, any> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const flags = (value: unknown): Partial<Record<AutoFeature, boolean>> => {
  const out: Partial<Record<AutoFeature, boolean>> = {};
  if (!value || typeof value !== "object") return out;
  for (const f of AUTO_FEATURES) if (typeof (value as any)[f] === "boolean") out[f] = (value as any)[f];
  return out;
};

export function readAutoSettings(file: string): AutoSettings {
  const raw = readRaw(file);
  const places: AutoSettings["places"] = {};
  if (raw.places && typeof raw.places === "object") {
    for (const [id, value] of Object.entries(raw.places)) {
      const set = flags(value);
      if (/^\d+$/.test(id) && Object.keys(set).length) places[id] = set;
    }
  }
  return { global: { ...AUTO_DEFAULTS, ...flags(raw.global) }, places };
}

/** Whether a feature runs for a place (none: a project no registered place holds) */
export function autoEnabled(settings: AutoSettings, feature: AutoFeature, placeId?: string | null): boolean {
  const own = placeId ? settings.places[placeId]?.[feature] : undefined;
  return own ?? settings.global[feature];
}

export interface AutoPatch {
  global?: Partial<Record<AutoFeature, boolean>>;
  /** A place's own values; null for a feature drops the place's own value (it follows the global one again) */
  place?: { placeId: string; values: Partial<Record<AutoFeature, boolean | null>> };
}

/** Writes a change; every key it does not know (a newer Quack's) stays as it was */
export function writeAutoSettings(file: string, patch: AutoPatch): AutoSettings {
  const raw = readRaw(file);
  if (patch.global) raw.global = { ...(raw.global && typeof raw.global === "object" ? raw.global : {}), ...flags(patch.global) };
  if (patch.place) {
    const { placeId, values } = patch.place;
    if (!/^\d+$/.test(placeId)) throw new Error("placeId must be a place id");
    const places = raw.places && typeof raw.places === "object" ? raw.places : {};
    const own = { ...(places[placeId] && typeof places[placeId] === "object" ? places[placeId] : {}) };
    for (const f of AUTO_FEATURES) {
      if (values[f] === null) delete own[f];
      else if (typeof values[f] === "boolean") own[f] = values[f];
    }
    if (Object.keys(own).length) places[placeId] = own;
    else delete places[placeId];
    raw.places = places;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`);
  fs.renameSync(temp, file);
  return readAutoSettings(file);
}
