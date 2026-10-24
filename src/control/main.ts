#!/usr/bin/env node
// `quack` / `quackdev`, the hub from a terminal.
//   node dist/control/main.js [--flavor official|dev] <command> ...
// Each app installs a command that passes its own --flavor (bin\quack.cmd, bin\quackdev.cmd);
// without one this is Dev, the hub every change is tried on first.
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { BUNDLED } from "../bundled.js";
import { openWithDefaultApp } from "../util/open.js";
import { runControl } from "./commands.js";
import { flavorInfo, HubClient, type Flavor } from "./hubClient.js";

const argv = process.argv.slice(2);
let flavor: Flavor = "dev";
const at = argv.indexOf("--flavor");
if (at >= 0) {
  const value = argv[at + 1];
  if (value !== "official" && value !== "dev") {
    console.error("--flavor must be official or dev");
    process.exit(1);
  }
  flavor = value;
  argv.splice(at, 2);
}

const info = flavorInfo(flavor);
const here = path.dirname(fileURLToPath(import.meta.url));

const code = await runControl(argv, {
  info,
  client: new HubClient(info.port),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  confirm: async (question) => {
    // On stderr: stdout stays only the answer, valid JSON under --json
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return /^(y|yes|s|sim)$/i.test((await rl.question(`${question} [y/N] `)).trim());
    } finally {
      rl.close();
    }
  },
  interactive: process.stdin.isTTY === true,
  color: process.stdout.isTTY === true,
  cwd: process.cwd(),
  openUri: openWithDefaultApp,
  // The app ships this as resources/hub/cli.mjs, next to the BUILD of the hub it starts
  bundleDir: BUNDLED ? here : undefined,
});
// Not process.exit: on Windows it can abort Node while fetch is closing its socket
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"); nothing else keeps it alive
process.exitCode = code;
