#!/usr/bin/env node
// Quack hub entry point.
//   node dist/hub/main.js [--port 3825] [--registry <file>] [--token-stdin] [--app <quack-app.exe>]
//   node dist/hub/main.js register <placeId> <folder> [name] [--registry <file>]
//   node dist/hub/main.js unregister <placeId> [--registry <file>]
//   node dist/hub/main.js list [--registry <file>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED } from "../bundled.js";
import { QuackHub } from "./hub.js";
import { defaultRegistryPath, loadRegistry, saveRegistry } from "./registry.js";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const registryFile = path.resolve(option("--registry") ?? defaultRegistryPath());

const command = positional[0] ?? "run";

if (command === "register") {
  const [, placeId, folder, name] = positional;
  if (!placeId || !/^\d+$/.test(placeId) || !folder) {
    console.error("usage: register <placeId> <folder> [name]");
    process.exit(1);
  }
  const registry = loadRegistry(registryFile);
  registry.places[placeId] = { folder: path.resolve(folder), ...(name ? { name } : {}) };
  saveRegistry(registryFile, registry);
  console.log(`Registered ${placeId} -> ${path.resolve(folder)} in ${registryFile}`);
} else if (command === "unregister") {
  const registry = loadRegistry(registryFile);
  delete registry.places[positional[1] ?? ""];
  saveRegistry(registryFile, registry);
  console.log(`Unregistered ${positional[1]}`);
} else if (command === "list") {
  const registry = loadRegistry(registryFile);
  for (const [id, entry] of Object.entries(registry.places)) {
    console.log(`${id}  ${entry.name ?? ""}  ${entry.folder}`);
  }
} else {
  const port = Number(option("--port") ?? 3825);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`invalid --port ${option("--port")}`);
    process.exit(1);
  }
  // From dist/ the daemon is dist/cli.js; the app's bundle ships it as daemon.mjs next to this file
  const here = path.dirname(fileURLToPath(import.meta.url));
  const daemonCli = BUNDLED ? path.join(here, "daemon.mjs") : path.join(here, "..", "cli.js");
  // What a daemon left running must report to be adopted. Each daemon reports the id baked into
  // its own file, so one started from a daemon.mjs an install replaced is still told apart
  let daemonBuild = "dist";
  if (BUNDLED) {
    try {
      daemonBuild = fs.readFileSync(path.join(here, "DAEMON_BUILD"), "utf8").trim() || "dist";
    } catch {
      // an older bundle without the file: never matches a daemon, so none is adopted
      daemonBuild = "unknown";
    }
  }
  const shutdown = (options: { handoff?: boolean; replaceDaemons?: boolean } = {}) => void hub.stop(options).then(() => process.exit(0));
  // --takeover: replace the hub on this port with a gap of ms (the app's restarts and updates)
  const takeover = args.includes("--takeover");
  // The app that answers Open Cloud writes: the bundled hub sits in <install>/resources/hub,
  // next to the app's quack-app.exe two folders up; from dist/ only --app names one
  const appExe = option("--app") ?? (BUNDLED && process.platform === "win32" ? path.join(here, "..", "..", "quack-app.exe") : undefined);
  const hub = new QuackHub({ port, registryFile, daemonCli, daemonBuild, takeover, onShutdownRequest: shutdown, cloud: { appExe } });
  // --token-stdin: the app's approval token comes on stdin (never argv, env or a file), and only
  // answers carrying it accept or refuse a write. Without the flag stdin is never read
  if (args.includes("--token-stdin")) {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 1024) process.stdin.destroy();
    });
    process.stdin.on("end", () => {
      if (!hub.setApprovalToken(Buffer.concat(chunks).toString("utf8"))) console.error("The approval token on stdin is not 64 hex characters: no write can be approved until the app restarts the hub");
    });
    process.stdin.on("error", () => {});
  }
  hub.start().catch((error) => {
    console.error(`Quack hub could not start: ${error.message}`);
    process.exit(1);
  });
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
}
