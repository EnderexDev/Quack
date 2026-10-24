import fs from "node:fs";
import path from "node:path";

/**
 * Folders that already sync a place, found by the stamp the daemon writes at the end of
 * sourcemap.json: `_quack.placeId`, or `_azul.placeId` in folders synced before Quack 1.0.
 * Looks at each root and its direct subfolders only: project folders sit side by side.
 */

const TAIL_BYTES = 4096;
const MAX_FOLDERS_PER_ROOT = 500;

/** The place stamped in a folder's sourcemap, read from its tail (a big game's file is 60+ MB) */
export function stampedPlace(folder: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(folder, "sourcemap.json"), "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const match = /"_(?:quack|azul)"\s*:\s*\{[^}]*"placeId"\s*:\s*(\d+)/.exec(buffer.toString("utf8"));
    return match?.[1];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function findStampedFolders(placeId: string, roots: string[]): string[] {
  const found = new Set<string>();
  for (const root of new Set(roots.map((r) => path.resolve(r)))) {
    const folders = [root];
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true }).slice(0, MAX_FOLDERS_PER_ROOT)) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) folders.push(path.join(root, entry.name));
      }
    } catch {
      continue;
    }
    for (const folder of folders) if (stampedPlace(folder) === placeId) found.add(folder);
  }
  return [...found];
}

/** A folder name from a place name: no characters Windows refuses, never empty */
export function folderNameFor(placeName: string | undefined, placeId: string): string {
  const cleaned = (placeName ?? "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/[. ]+$/, "").trim();
  return cleaned || `Place ${placeId}`;
}
