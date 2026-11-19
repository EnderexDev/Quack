// Captures the real app window (WebView2 of a debug build) in a test profile of its own
// (QUACK_TEST_PROFILE, app/src-tauri/src/test_profile.rs): its own settings, single-instance key,
// hub on a free port with an empty registry, WebView2 data, nothing written outside a temporary
// folder. The windows open off screen and are never activated; every action is a
// Runtime.evaluate over the DevTools protocol (no mouse, no keyboard). A sampler of the
// foreground window runs the whole time and fails the run if the app ever took the focus.
//
//   node app/harness/real-window.mjs --out <dir> [--build] [--exe <quack-app.exe>]
//
// --build first runs `npm run bundle:hub` (dist/ for the debug hub, resources/ for the Tauri
// build) and `cargo build` with CARGO_TARGET_DIR=app/src-tauri/target. The debugging port is
// open only while this runs: the app is quit through its own `quit` command (which stops its
// hub), or its process tree is killed by the PID this script started, and the profile removed.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cdp, sleep, waitFor } from "./capture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const tauriDir = path.join(repo, "app", "src-tauri");
const targetDir = path.join(tauriDir, "target");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(name);

/** The arguments both windows carry (tauri.conf.json), the debugging port, and no occlusion: an
 * off-screen window counts as covered and would stop drawing */
const BROWSER_ARGS = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-gpu";

const SETTINGS_SHOTS = [
  { name: "settings", then: "[...document.querySelectorAll('#side .game')].pop().click()", settle: "document.querySelectorAll('.card').length > 5" },
  // Its page scrolled to the end: the bar beside the cards, nothing under it or cut
  { name: "settings-end", then: "document.querySelector('.set-list').scrollTop = 1e6", settle: "document.querySelector('.set-list').scrollTop > 0" },
  { name: "connect-ai", then: "[...document.querySelectorAll('button')].find((b) => b.textContent === 'Connect to AI').click()", settle: "document.querySelectorAll('#aiConnect .ai-option').length > 2", wait: 15_000 },
];
const EMPTY_SHOTS = [{ name: "home", ready: "document.querySelector('.offline .btn') && document.querySelector('#side .game')" }, ...SETTINGS_SHOTS];

/**
 * --example-place: a made-up place in a folder of the profile, so the tabs open. Its daemon runs
 * hidden (windowsHide in src/hub/hub.ts) and only this run's hub knows it: the plugins in Studio
 * reach a daemon only through the hub on their own port (3825 / 3826). Nothing clicked here
 * reaches open_path or pick_folder, which would open real windows.
 */
const EXAMPLE = { placeId: "98112345678901", name: "Quack Lab" };
const TABS = ["output", "playtest", "merges", "analysis", "queue", "folder"];
const EXAMPLE_SHOTS = [
  { name: "place", ready: "document.querySelectorAll('#side .game').length >= 2", then: "document.querySelector('#side .game').click()", settle: "!document.querySelector('.navlink:disabled')" },
  ...TABS.map((view) => ({ name: `tab-${view}`, then: `document.querySelector('.navlink[data-view="${view}"]').click(); new Promise((r) => setTimeout(r, 1500))`, settle: `document.querySelector('.navlink.on')?.dataset.view === '${view}'` })),
  ...SETTINGS_SHOTS,
];

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
}

/**
 * `count` distinct ports nothing listens on now, never a real hub's: all are held open until
 * every one is picked, so two calls cannot get the same port
 */
async function freePorts(count) {
  const held = [];
  const listen = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  try {
    while (held.filter((s) => ![3825, 3826].includes(s.address().port)).length < count) held.push(await listen());
    return held.map((s) => s.address().port).filter((p) => ![3825, 3826].includes(p)).slice(0, count);
  } finally {
    await Promise.all(held.map((s) => new Promise((r) => s.close(r))));
  }
}

/** A PowerShell command's output; "" (and the reason in `failures`) when it could not run */
function powershell(script, env, failures) {
  // A query that hangs is cut at 30 s, so the cleanup that depends on it still runs
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 30_000, ...(env ? { env: { ...process.env, ...env } } : {}) });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    failures?.push(`powershell failed: ${result.error?.message ?? (result.signal ? `stopped (${result.signal})` : `exit ${result.status}`)}`);
    return "";
  }
  return result.stdout;
}

function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(500);
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
}

const json = async (url, ms = 3000) => (await fetch(url, { signal: AbortSignal.timeout(ms) })).json();

/**
 * One PowerShell, read only, for the whole run: every 100 ms the process owning the foreground
 * window (GetForegroundWindow) and its chain of parents, looked up only when the owner changes.
 * A parent is followed only if it started before its child, so a reused PID never joins a
 * chain; a parent that no longer exists ends it. "?" when the owner was gone before it could be
 * looked up or a lookup failed, and the lookup is tried again on the next sample. Any other
 * error stops the sampler, which fails the run. Each sample keeps the time it arrived; the app
 * owned the focus when its PID is in a chain.
 */
function foregroundSampler() {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Q -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'
$last = -1; $chain = ''
while ($true) {
  $p = 0; [void][Q.W]::GetWindowThreadProcessId([Q.W]::GetForegroundWindow(), [ref]$p)
  if ($p -ne $last) {
    $last = $p; $ids = @(); $cur = $p; $born = [datetime]::MaxValue; $chain = ''
    for ($i = 0; $i -lt 32 -and $cur -gt 0; $i++) {
      try { $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" } catch { $chain = '?'; break }
      if (-not $proc) { if ($i -eq 0) { $chain = '?' }; break }
      if ($proc.CreationDate -and $proc.CreationDate -gt $born) { break }
      $ids += [int]$proc.ProcessId; $born = $proc.CreationDate; $cur = [int]$proc.ParentProcessId
      if ($ids -contains $cur) { break }
    }
    if ($chain -eq '?') { $last = -1 } else { $chain = $ids -join ',' }
  }
  [Console]::Out.WriteLine("$p|$chain"); [Console]::Out.Flush(); Start-Sleep -Milliseconds 100
}`;
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const sampler = { child, samples: [], error: null, started: () => sampler.samples.length > 0 };
  child.on("error", (error) => (sampler.error = error));
  let buffer = "";
  child.stdout.on("data", (d) => {
    buffer += d;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      const m = /^(\d+)\|([\d,]*|\?)$/.exec(line.trim());
      if (m) sampler.samples.push({ at: Date.now(), pid: Number(m[1]), chain: m[2] === "?" ? null : m[2].split(",").filter(Boolean).map(Number) });
    }
  });
  return sampler;
}

/** Processes whose command line names `text` (this run's profile folder: only this run's) */
function processesNaming(text, failures) {
  const script = `$t = $env:QUACK_FIND; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($t) -and $_.ProcessId -ne $PID } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
  const out = powershell(script, { QUACK_FIND: text }, failures);
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => ({ pid: Number(l.split(" ")[0]), name: l.split(" ").slice(1).join(" ") }));
}

/** Every process: id, parent id, creation time (FILETIME) and name */
function processes(failures) {
  const out = powershell("Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) $($_.Name)\" }", null, failures);
  return out.split(/\r?\n/).map((l) => l.trim().split(" ")).filter((r) => r.length >= 4).map(([pid, parent, created, ...name]) => ({ pid: Number(pid), parent: Number(parent), created, name: name.join(" ") }));
}

/**
 * The app and every process under it (its WebView2, its hub), each as pid and "created name":
 * a PID Windows gives to another process later never matches. A child counts only if it started
 * after its parent, so an old process whose dead parent's PID the app reused is left out.
 */
function processTree(root, failures) {
  const rows = processes(failures);
  const self = rows.find((r) => r.pid === root);
  const born = new Map(self ? [[root, BigInt(self.created)]] : []);
  const tree = new Map(self ? [[root, `${self.created} ${self.name}`]] : []);
  for (let grew = tree.size > 0; grew; ) {
    grew = false;
    for (const r of rows) {
      if (!tree.has(r.parent) || tree.has(r.pid) || BigInt(r.created) < born.get(r.parent)) continue;
      tree.set(r.pid, `${r.created} ${r.name}`);
      born.set(r.pid, BigInt(r.created));
      grew = true;
    }
  }
  return tree;
}

async function pageTarget(debugPort, match, ms, gone = () => false) {
  const start = Date.now();
  while (Date.now() - start < ms && !gone()) {
    const list = await json(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
    const target = list.find((t) => t.type === "page" && match(t.url));
    if (target) return target;
    await sleep(200);
  }
  return null;
}

/** Captures one page as it is, with what went wrong on it */
async function shoot(page, events, out, name, shot) {
  const problems = [];
  if (shot.ready && !(await waitFor(page, shot.ready, shot.wait ?? 30_000))) problems.push(`never ready: ${shot.ready}`);
  if (shot.then) {
    // A click that throws (no such button) is a problem even when the wait below is already true
    const answer = await page.send("Runtime.evaluate", { expression: shot.then, awaitPromise: true }).catch((error) => ({ exceptionDetails: { text: error.message } }));
    if (answer.exceptionDetails) problems.push(`action failed: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`);
    if (!(await waitFor(page, shot.settle ?? "true", shot.wait ?? 8000))) problems.push(`never settled: ${shot.settle}`);
  }
  // A page that closes or stops answering is this shot's problem, not the end of the run
  let file;
  try {
    await page.send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
    await sleep(400);
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
  } catch (error) {
    problems.push(`no capture: ${error.message}`);
  }
  let facts = {};
  try {
    const answer = await page.send("Runtime.evaluate", {
      expression: "JSON.stringify({ visibility: document.visibilityState, focus: document.hasFocus(), width: innerWidth, height: innerHeight, dpr: devicePixelRatio, fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family), tabsDisabled: document.querySelectorAll('.navlink:disabled').length })",
      returnByValue: true,
    });
    facts = JSON.parse(answer.result.value);
  } catch (error) {
    problems.push(`page facts unread: ${error.message}`);
  }
  problems.push(
    ...events.splice(0).flatMap((e) =>
      e.method === "Runtime.exceptionThrown" ? [`exception: ${e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text}`]
      : e.method === "Runtime.consoleAPICalled" && e.params.type === "error" ? [`console.error: ${e.params.args.map((a) => a.value ?? a.description).join(" ")}`]
      : e.method === "Log.entryAdded" && e.params.entry.level === "error" ? [`log: ${e.params.entry.text}`]
      : []),
  );
  return { name, file, problems, facts };
}

async function openPage(target) {
  const events = [];
  const page = await cdp(target.webSocketDebuggerUrl, (m) => events.push(m));
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  return { page, events };
}

export async function realWindow({ out, exe, build, examplePlace = false }) {
  if (build) {
    run("npm", ["run", "bundle:hub"], { cwd: repo });
    run("cargo", ["build"], { cwd: tauriDir, env: { ...process.env, CARGO_TARGET_DIR: targetDir } });
  }
  // Absolute: the app starts with the profile as its working folder
  exe = path.resolve(exe ?? path.join(targetDir, "debug", "quack-app.exe"));
  if (!fs.existsSync(exe)) throw new Error(`${exe} is missing: run with --build`);
  fs.mkdirSync(out, { recursive: true });

  const [hubPort, debugPort] = await freePorts(2);
  if (await portAnswers(hubPort)) throw new Error(`port ${hubPort} answers already: the app would use that hub`);
  // As the app resolves it (junctions, short names): the command lines name this path
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "quack-real-window-")));
  // Failures of the process queries the checks and the cleanup rest on
  const failures = [];
  const report = { hubPort, debugPort, profile, shots: [], timings: {}, failures, problems: [] };
  const sampler = foregroundSampler();
  let app;
  let started;
  // Every process seen under the app, read as soon as its page is up, again before the quit,
  // and on the way out of a failure
  let tree = new Map();
  const readTree = () => {
    if (app?.pid !== undefined && app.exitCode === null) for (const [pid, id] of processTree(app.pid, failures)) tree.set(pid, id);
  };
  try {
    if (examplePlace) {
      // The registry the profile's hub reads (Dev flavor: hub-dev.json under the profile's appdata)
      const game = path.join(profile, "game");
      fs.mkdirSync(path.join(game, "sync"), { recursive: true });
      fs.mkdirSync(path.join(profile, "appdata", "quack"), { recursive: true });
      fs.writeFileSync(path.join(profile, "appdata", "quack", "hub-dev.json"), JSON.stringify({ places: { [EXAMPLE.placeId]: { folder: game, name: EXAMPLE.name } } }, null, 2));
    }
    for (let i = 0; i < 100 && !sampler.started() && !sampler.error && sampler.child.exitCode === null; i++) await sleep(100);
    // No window opens unless the focus is being watched
    if (!sampler.started()) throw new Error(`the foreground sampler did not start (${sampler.error?.message ?? `exit ${sampler.child.exitCode}`}): no window opened`);
    const log = fs.openSync(path.join(profile, "app.log"), "a");
    started = Date.now();
    // windowsHide: the debug build is a console program, and a console of its own would take the focus
    app = spawn(exe, [], {
      cwd: profile,
      stdio: ["ignore", log, log],
      windowsHide: true,
      env: { ...process.env, QUACK_TEST_PROFILE: profile, QUACK_TEST_PORT: String(hubPort), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `${BROWSER_ARGS} --remote-debugging-port=${debugPort}` },
    });
    let spawnError = null;
    app.on("error", (error) => (spawnError = error));
    fs.closeSync(log);

    const mainTarget = await pageTarget(debugPort, (url) => url.startsWith("http://tauri.localhost/") && !url.includes("tray.html"), 90_000, () => spawnError || app.exitCode !== null);
    if (spawnError) throw new Error(`the app did not start: ${spawnError.message}`);
    if (!mainTarget) throw new Error(`no page at http://tauri.localhost/ (app exit code ${app.exitCode}); log: ${path.join(profile, "app.log")}`);
    report.timings.pageMs = Date.now() - started;
    const main = await openPage(mainTarget);
    if (await waitFor(main.page, "document.readyState === 'complete'", 30_000)) report.timings.loadedMs = Date.now() - started;
    else report.problems.push("the page did not finish loading in 30 s");
    // After the timings: the query takes most of a second
    readTree();
    for (const shot of examplePlace ? EXAMPLE_SHOTS : EMPTY_SHOTS) {
      report.shots.push(await shoot(main.page, main.events, out, shot.name, shot));
      if (report.shots.length === 1) report.timings.firstShotMs = Date.now() - started;
    }
    const trayTarget = await pageTarget(debugPort, (url) => url.includes("tray.html"), 10_000);
    if (trayTarget) {
      const tray = await openPage(trayTarget);
      report.shots.push(await shoot(tray.page, tray.events, out, "tray", { ready: "document.getElementById('list')?.children.length > 0" }));
      tray.page.close();
    } else report.shots.push({ name: "tray", problems: ["no tray.html page"] });

    readTree();
    // Quit through the app's own command: RunEvent::Exit then stops the hub it started
    await main.page.send("Runtime.evaluate", { expression: "window.__TAURI__.core.invoke('quit')" }).catch(() => {});
    main.page.close();
  } catch (error) {
    report.error = error.message;
  } finally {
    // A run that failed early still knows what the app started before it is ended
    readTree();
    if (app && app.exitCode === null && app.pid !== undefined) {
      for (let i = 0; i < 100 && app.exitCode === null; i++) await sleep(100);
      if (app.exitCode === null) {
        // Only this run's app and what it started, by the PID this script got
        spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true });
        report.killed = true;
        // Node learns of the exit on a later turn of its loop
        for (let i = 0; i < 50 && app.exitCode === null && app.signalCode === null; i++) await sleep(100);
      }
    }
    report.exitCode = app?.exitCode ?? app?.signalCode;
    // The hub and WebView2 it started end with it
    for (let i = 0; i < 50 && (await portAnswers(hubPort)); i++) await sleep(100);
    // A process still naming this run's profile was started by this run: ended by its PID, and
    // reported. Seen 18/11/26, when the app's poll started a new hub while quitting; fixed in
    // 1.0.41 (none left since), kept as a safety net
    await sleep(1500);
    const leftover = processesNaming(profile, failures);
    report.leftover = leftover.map((p) => `${p.pid} ${p.name}`);
    for (const { pid } of leftover) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    for (let i = 0; i < 50 && processesNaming(profile, failures).length; i++) await sleep(200);
    // Every process the app had started (its WebView2, its hub, a daemon under it) that still runs
    // is ended by its PID, only while the same PID still has the same creation time and name
    report.started = [...tree].map(([pid, id]) => `${pid} ${id}`);
    const survivors = () => {
      const alive = new Map(processes(failures).map((r) => [r.pid, `${r.created} ${r.name}`]));
      return [...tree].filter(([pid, id]) => alive.get(pid) === id);
    };
    report.endedAfterQuit = survivors().map(([pid, id]) => `${pid} ${id.split(" ").slice(1).join(" ")}`);
    for (const [pid] of survivors()) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    await sleep(500);
    report.stillRunning = survivors().map(([pid, id]) => `${pid} ${id.split(" ").slice(1).join(" ")}`);
    // The ports once every process of the run is gone
    for (let i = 0; i < 20 && ((await portAnswers(hubPort)) || (await portAnswers(debugPort))); i++) await sleep(100);
    report.hubPortClosed = !(await portAnswers(hubPort));
    report.debugPortClosed = !(await portAnswers(debugPort));
    // The focus over the whole run, the quit and the cleanup included: an owner whose chain of
    // parents holds the app or any process this run started (a hub started while quitting,
    // as before 1.0.41, whose parent is gone by then) is the run's; an owner gone before its lookup cannot be cleared
    if (started !== undefined) {
      const ours = new Set([app?.pid, ...tree.keys(), ...leftover.map((p) => p.pid)].filter((pid) => pid !== undefined));
      const during = sampler.samples.filter((s) => s.at >= started);
      report.stolen = [...new Set(during.filter((s) => s.chain?.some((pid) => ours.has(pid))).map((s) => s.pid))];
      report.unexplained = [...new Set(during.filter((s) => s.chain === null).map((s) => s.pid))];
      report.foregroundSamples = during.length;
      // Each owner seen, as its chain of parents (owner first)
      report.foregroundOwners = [...new Set(during.map((s) => (s.chain ? s.chain.join("<") || String(s.pid) : `${s.pid}?`)))];
      // Only a sampler still running, that sampled about every 100 ms and saw a real owner, vouches for the focus
      report.focusChecked = sampler.child.exitCode === null && !sampler.error && during.some((s) => s.pid > 0) && during.length >= Math.floor((Date.now() - started) / 400);
    }
    sampler.child.kill();
    report.appLog = tail(path.join(profile, "app.log"), 2000);
    report.profileFiles = listFiles(profile);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      report.removeError = error.message;
    }
    report.profileRemoved = !fs.existsSync(profile);
  }
  return report;
}

/** The last `bytes` of a file, "" when it cannot be read */
function tail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(bytes, size));
    const read = fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The profile's files (path and size), to show what the app wrote and where; an unreadable one is named as such */
function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return out.push(`${path.relative(root, dir) || "."}/ unreadable (${error.code ?? error.message})`);
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "webview") out.push("webview/ (WebView2 data)");
        else walk(full);
      } else {
        try {
          out.push(`${path.relative(root, full)} ${fs.statSync(full).size}`);
        } catch (error) {
          out.push(`${path.relative(root, full)} unreadable (${error.code ?? error.message})`);
        }
      }
    }
  };
  walk(root);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("real-window.mjs")) {
  const out = arg("--out");
  if (!out) throw new Error("--out <dir> is required");
  const report = await realWindow({ out, exe: arg("--exe"), build: flag("--build"), examplePlace: flag("--example-place") });
  let bad = 0;
  for (const shot of report.shots) {
    console.log(`${shot.problems.length ? "PROBLEM" : "ok     "} ${shot.name.padEnd(12)} ${shot.file ?? ""} ${JSON.stringify(shot.facts ?? {})}`);
    for (const p of shot.problems) console.log(`          ${p}`);
    bad += shot.problems.length;
  }
  const { shots, appLog, ...rest } = report;
  console.log(JSON.stringify(rest, null, 2));
  if (report.error) (console.log(`ERROR: ${report.error}`), bad++);
  for (const problem of report.problems) (console.log(`PROBLEM: ${problem}`), bad++);
  if (report.stolen?.length) (console.log(`FOCUS: the app owned the foreground window (pids ${report.stolen})`), bad++);
  if (report.unexplained?.length) (console.log(`FOCUS: a process that ended, never seen under the app, owned the foreground (pids ${report.unexplained}): cannot tell it was not the app's`), bad++);
  if (!report.error && !report.focusChecked) (console.log("FOCUS: not checked (the sampler stopped, sampled too little, or the app's processes were not read)"), bad++);
  if (report.failures.length) (console.log(`process queries failed: ${[...new Set(report.failures)]}`), bad++);
  if (!report.hubPortClosed || !report.debugPortClosed) (console.log("a port stayed open"), bad++);
  if (!report.profileRemoved) (console.log(`the profile was not removed: ${report.profile}`), bad++);
  if (report.stillRunning?.length) (console.log(`still running: ${report.stillRunning}`), bad++);
  if (report.leftover?.length || report.endedAfterQuit?.length) console.log(`ended after the app quit (started by this run): ${[...report.leftover, ...report.endedAfterQuit]}`);
  if (bad && appLog) console.log(`app log (end):\n${appLog}`);
  process.exitCode = bad ? 1 : 0;
}
