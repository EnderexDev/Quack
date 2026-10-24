import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Quack hub registry: which folder serves which place.
 * { "places": { "<placeId>": { "folder": "C:\\...\\Game", "name": "Game" } } }
 */
export interface RegisteredPlace {
  folder: string;
  name?: string;
}

export interface Registry {
  places: Record<string, RegisteredPlace>;
}

export function defaultRegistryPath(): string {
  const root =
    process.platform === "win32"
      ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
      : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
  return path.join(root, "quack", "hub.json");
}

export function loadRegistry(file: string): Registry {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const places: Record<string, RegisteredPlace> = {};
    if (parsed && typeof parsed === "object" && parsed.places && typeof parsed.places === "object") {
      for (const [id, entry] of Object.entries(parsed.places as Record<string, unknown>)) {
        if (!/^\d+$/.test(id) || !entry || typeof entry !== "object") continue;
        const { folder, name } = entry as Record<string, unknown>;
        if (typeof folder !== "string" || folder.trim() === "") continue;
        places[id] = { folder, ...(typeof name === "string" ? { name } : {}) };
      }
    }
    return { places };
  } catch {
    return { places: {} };
  }
}

export function saveRegistry(file: string, registry: Registry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}
