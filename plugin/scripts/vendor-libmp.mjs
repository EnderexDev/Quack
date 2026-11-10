// Vendors LibMP (Roblox's MicroProfiler library, MIT, github.com/Roblox/libmp) into the plugin as
// Vendor/LibMP.luau, pinned to a release and its file's sha256. Studio's own copy
// (require("@rbx/LibMP")) is refused to plugins: "can only be loaded via a shortcut by Assistant"
// (measured 09/11/26 in PA), so capture_micro_profiler carries this one.
// To update: bump RELEASE, rerun with --accept to print the new hash, put it in SHA256, review.
// The file keeps its own header with LibMP's license and its bundled parts' (FlatBuffers Apache
// 2.0, LZ4 BSD-2, Spider runtime MPL 2.0).
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE = "1.1";
const SHA256 = "236fea082f323facd08109f9fd6dab70350bd0cc69617e07cc194778415a0bb8";
const URL_ = `https://github.com/Roblox/libmp/releases/download/${RELEASE}/LibMP.luau`;
const DEST = path.join(fileURLToPath(new URL("..", import.meta.url)), "sync", "ReplicatedFirst", "QuackPlugin", "Vendor", "LibMP.luau");

const response = await fetch(URL_);
if (!response.ok) {
  console.error(`${URL_}: HTTP ${response.status}`);
  process.exit(1);
}
const data = Buffer.from(await response.arrayBuffer());
const hash = createHash("sha256").update(data).digest("hex");
if (hash !== SHA256 && !process.argv.includes("--accept")) {
  console.error(`LibMP ${RELEASE} has sha256 ${hash}, not the pinned ${SHA256}: review it, then rerun with --accept and pin the new hash`);
  process.exit(1);
}
const text = data.toString("utf8").replace(/\r\n/g, "\n");
if (!/^-- LibMP library version: /m.test(text) || !/\nreturn LibMP\n/.test(text)) {
  console.error("the download does not look like LibMP's Luau bundle");
  process.exit(1);
}
const header = `-- Vendored by plugin/scripts/vendor-libmp.mjs: LibMP release ${RELEASE} (sha256 ${hash}), unchanged below.\n`;
writeFileSync(DEST, header + text);
console.log(`vendored LibMP ${RELEASE} (${data.length} bytes, sha256 ${hash})`);
