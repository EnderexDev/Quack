// The hub and the daemon as two single files the app ships, so the installed app no longer runs
// this repo's dist/ (which every build here changes), plus both plugins for the app to install.
//   node scripts/bundle-hub.mjs [outDir]     (after `npm run build`; default app/src-tauri/resources/hub)
// Writes hub.mjs, daemon.mjs and cli.mjs; they need only a `node` on PATH.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Stands for the build id while bundling; each file then gets the hash of its own bytes */
const BUILD_PLACEHOLDER = "@@quack-build-id@@";

export async function bundleHub(outDir = path.join(root, "app", "src-tauri", "resources", "hub")) {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  fs.mkdirSync(outDir, { recursive: true });
  const common = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
    legalComments: "none",
    define: { __QUACK_BUNDLE__: "true", __QUACK_VERSION__: JSON.stringify(version), __QUACK_BUILD__: JSON.stringify(BUILD_PLACEHOLDER) },
    // ws and chokidar's dependencies are CommonJS: in an ES module they need a real require
    banner: { js: 'import { createRequire as __quackRequire } from "node:module"; const require = __quackRequire(import.meta.url);' },
    // ws loads these native speed-ups only if present, and works without them
    external: ["bufferutil", "utf-8-validate"],
  };
  await build({ ...common, entryPoints: [path.join(root, "dist", "hub", "main.js")], outfile: path.join(outDir, "hub.mjs") });
  await build({ ...common, entryPoints: [path.join(root, "dist", "cli.js")], outfile: path.join(outDir, "daemon.mjs") });
  // The terminal command (`quack` / `quackdev`); the app's bin\*.cmd names the flavor
  await build({ ...common, entryPoints: [path.join(root, "dist", "control", "main.js")], outfile: path.join(outDir, "cli.mjs") });
  // Content ids: a rebuild of the same code keeps its id, so an update that leaves the hub's
  // bytes alone does not restart it, and a daemon is replaced only when daemon.mjs changed
  const daemonBuild = stampBuildId(path.join(outDir, "daemon.mjs"));
  // The hub's id covers the daemon too: an update that changes only daemon.mjs still restarts
  // the hub, whose successor then replaces each daemon (handing its tree to the new one)
  const hubBuild = stampBuildId(path.join(outDir, "hub.mjs"), undefined, daemonBuild);
  stampBuildId(path.join(outDir, "cli.mjs"), hubBuild);
  fs.writeFileSync(path.join(outDir, "VERSION"), `${version}\n`);
  // What the app compares with the running hub's /api/state build
  fs.writeFileSync(path.join(outDir, "BUILD"), `${hubBuild}\n`);
  // What a hub compares with a running daemon's, to keep it or replace it
  fs.writeFileSync(path.join(outDir, "DAEMON_BUILD"), `${daemonBuild}\n`);
  return outDir;
}

/**
 * Puts `id` (default: the hash of the file as bundled, placeholder included, plus `alsoCovers`)
 * where the placeholder is
 */
function stampBuildId(file, id, alsoCovers = "") {
  const text = fs.readFileSync(file, "utf8");
  const build = id ?? createHash("sha256").update(text).update(alsoCovers).digest("hex").slice(0, 12);
  fs.writeFileSync(file, text.split(BUILD_PLACEHOLDER).join(build));
  return build;
}

/**
 * Both plugins, for the app to install: each app copies the one of its own flavor into Studio's
 * Plugins folder. Built here with explicit paths, never into Plugins (that is the live plugin).
 */
export function bundlePlugins(outDir = path.join(root, "app", "src-tauri", "resources", "plugin")) {
  fs.mkdirSync(outDir, { recursive: true });
  const script = path.join(root, "plugin", "scripts", "build-rbxmx.mjs");
  execFileSync(process.execPath, [script, path.join(outDir, "Quack.rbxmx")], { stdio: "inherit" });
  execFileSync(process.execPath, [script, "--dev", path.join(outDir, "QuackDev.rbxmx")], { stdio: "inherit" });
  return outDir;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const out = await bundleHub(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  for (const file of ["hub.mjs", "daemon.mjs", "cli.mjs"]) {
    console.log(`${path.join(out, file)}  ${(fs.statSync(path.join(out, file)).size / 1024).toFixed(0)} KB`);
  }
  if (!process.argv[2]) bundlePlugins();
}
