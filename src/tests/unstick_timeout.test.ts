import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

// Measured in the Dev hub on 14/11/26: ending a play takes 9 to 13 s even in a small place, and
// both callers gave up at their 5 s default while the hub went on and ended it ("the hub took
// more than 5 s"; the app's "the hub is not answering")
test("unstick: the CLI and the app wait for the play to end instead of the 5 s default", () => {
  assert.match(read("src/control/commands.ts"), /post\("\/api\/queue\/unstick", \{ placeId: place\.placeId \}, UNSTICK_TIMEOUT_MS\)/, "the CLI passes its own timeout");
  const rust = read("app/src-tauri/src/main.rs");
  assert.match(rust, /fn hub_timeout\(path: &str\)[\s\S]*"\/api\/queue\/unstick" => Duration::from_secs\(45\)/, "the app gives unstick 45 s");
  assert.match(rust, /\.timeout\(hub_timeout\(path\)\)/, "hub_call_with uses it");
});
