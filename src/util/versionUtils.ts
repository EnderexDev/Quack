import fs from "node:fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { BUNDLED_VERSION } from "../bundled.js";

export function getCurrentVersion(): string {
  // A bundle has no package.json two levels up; its version is baked in
  if (BUNDLED_VERSION) return BUNDLED_VERSION;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(
    fs.readFileSync(resolve(__dirname, "../../package.json"), "utf8"), // two levels up: this file is in src/util
  );

  return pkg.version;
}

/**
 * The last plugin numbered before Quack had its own versions (2.4, the Azul-era numbering)
 * speaks the same protocol as Quack 1.0: a Studio still running it keeps syncing until the
 * place is reopened with the new plugin.
 */
const SAME_PROTOCOL = [["2.4", "1.0"]];

/**
 * The version to announce to a plugin. A 2.4 plugin checks the daemon's version too, by
 * major.minor, and would drop a "1.0" daemon: it is told the 2.4 it knows. Anything else
 * hears the real version.
 */
export function versionToAnnounce(pluginVersion: string, daemonVersion: string): string {
  const key = (v: string) => v.split(".").slice(0, 2).join(".");
  for (const [legacy, current] of SAME_PROTOCOL) {
    if (key(pluginVersion) === legacy && key(daemonVersion) === current) return `${legacy}.0`;
  }
  return daemonVersion;
}

/**
 * Daemon and plugin only have to agree on major.minor; patch releases stay
 * compatible.
 */
export function isVersionCompatible(a: string, b: string): boolean {
  const key = (v: string) => v.split(".").slice(0, 2).join(".");
  const [ka, kb] = [key(a), key(b)];
  if (ka === kb) return true;
  return SAME_PROTOCOL.some(([x, y]) => (ka === x && kb === y) || (ka === y && kb === x));
}
