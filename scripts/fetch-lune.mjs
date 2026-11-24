// Quack Test's engine for a checkout: the pinned Lune release (src/quacktest/lune.ts holds the
// version and each platform's SHA-256), downloaded once into vendor/lune/<version>/ and checked.
//   node scripts/fetch-lune.mjs [platform]     (after `npm run build`; default this machine's)
// npm test runs it; bundle-hub.mjs copies the binary into the app.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function ensureLune(platform) {
  const { fetchLune, vendorDir, LUNE_VERSION } = await import(pathToFileURL(path.join(root, "dist", "quacktest", "lune.js")).href);
  const file = await fetchLune(vendorDir(root), platform);
  return { file, version: LUNE_VERSION };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { file, version } = await ensureLune(process.argv[2]);
  console.log(`Lune ${version}: ${file}`);
}
