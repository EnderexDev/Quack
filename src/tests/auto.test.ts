import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QuackHub } from "../hub/hub.js";
import { saveRegistry } from "../hub/registry.js";
import { autoEnabled, autoSettingsPath, readAutoSettings, writeAutoSettings } from "../auto/settings.js";
import { ResidentAnalysis } from "../auto/resident.js";
import { fileKey } from "../analyze/tree.js";
import { editedFiles, reviewAnswer, reviewOutput } from "../control/review.js";

// What runs on its own (his call, 12/11/26): the review after each AI edit, the panel of each
// place, through the hub's resident analysis

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonCli = path.join(here, "..", "cli.js");
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(50);
  }
}

function call(port: number, method: "GET" | "POST", pathname: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

function project(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, "sync", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
}

const CONFIG = "local M = {}\nfunction M.getSpeed() return 16 end\nreturn M\n";
const USER = 'local Config = require(game:GetService("ReplicatedStorage").Config)\nprint(Config.getSpeed())\n';

test("automation settings: per flavor next to the registry, a place may differ, null follows the global again, unknown keys stay", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-auto-"));
  assert.equal(autoSettingsPath(path.join(dir, "hub.json")), path.join(dir, "automation.json"));
  assert.equal(autoSettingsPath(path.join(dir, "hub-dev.json")), path.join(dir, "automation-dev.json"));
  const file = path.join(dir, "automation-dev.json");
  fs.writeFileSync(file, JSON.stringify({ newer: { kept: true } }));
  let s = readAutoSettings(file);
  assert.deepEqual(s.global, { review: true, panel: true, errors: true, precommit: false }, "the pre-commit check starts off");
  s = writeAutoSettings(file, { global: { panel: false }, place: { placeId: "42", values: { precommit: true } } });
  assert.equal(autoEnabled(s, "panel", "42"), false);
  assert.equal(autoEnabled(s, "precommit", "42"), true);
  assert.equal(autoEnabled(s, "precommit", "7"), false);
  assert.equal(autoEnabled(s, "precommit"), false);
  s = writeAutoSettings(file, { place: { placeId: "42", values: { precommit: null } } });
  assert.deepEqual(s.places, {}, "a place with no value of its own is gone");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).newer, { kept: true });
});

test("resident analysis: a second run re-reads only what changed, and names what an edit broke in another file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-resident-"));
  project(root, { "ReplicatedStorage/Config.luau": CONFIG, "ServerScriptService/User.server.luau": USER });
  const resident = new ResidentAnalysis();
  const configFile = path.join(root, "sync", "ReplicatedStorage", "Config.luau");
  const first = await resident.run({ root, files: [configFile], placeFolders: [] });
  assert.deepEqual(first.findings, []);
  assert.deepEqual(first.elsewhere, []);
  // the module renames its function: the caller in another file is now wrong
  await wait(80);
  fs.writeFileSync(configFile, CONFIG.replace("getSpeed", "getWalkSpeed"));
  const second = await resident.run({ root, files: [configFile], placeFolders: [] });
  assert.deepEqual(second.findings, [], "the edited file itself is fine");
  assert.deepEqual(second.elsewhere.map((f) => [path.basename(f.file), f.rule]), [["User.server.luau", "missing-member"]]);
  // the same finding is not new after the next edit
  await wait(80);
  fs.writeFileSync(configFile, CONFIG.replace("getSpeed", "getWalkSpeed") + "-- touched\n");
  const third = await resident.run({ root, files: [configFile], placeFolders: [] });
  assert.deepEqual(third.elsewhere, []);
  // a script created just now (no sourcemap node yet) gets only what its text says
  const fresh = path.join(root, "sync", "ReplicatedStorage", "Fresh.luau");
  fs.writeFileSync(fresh, "local x = script.Parent.Nothing.Here\nreturn x\n");
  assert.deepEqual((await resident.run({ root, files: [fresh], placeFolders: [] })).findings, []);
});

test("review hook: the files a call wrote (Claude Code, Codex's patch, Cursor), the answer in each client's format, silent on any failure", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "quack-review-"));
  assert.deepEqual(editedFiles({ tool_name: "Edit", cwd, tool_input: { file_path: path.join(cwd, "a.luau") } }), [path.join(cwd, "a.luau")]);
  assert.deepEqual(editedFiles({ tool_name: "Write", cwd, tool_input: { file_path: path.join(cwd, "a.ts") } }), [], "not Luau");
  const patch = "*** Begin Patch\n*** Update File: sync/b.luau\n@@\n-x\n+y\n*** Add File: sync/c.lua\n+z\n*** Update File: README.md\n*** End Patch";
  assert.deepEqual(editedFiles({ tool_name: "apply_patch", cwd, tool_input: { command: patch } }), [path.join(cwd, "sync", "b.luau"), path.join(cwd, "sync", "c.lua")]);
  assert.deepEqual(editedFiles({ tool_name: "apply_patch", cwd, tool_input: { command: ["apply_patch", patch] } }).length, 2, "argv with the patch last");

  const file = path.join(cwd, "a.luau");
  fs.writeFileSync(file, "print(1)\n");
  const stdin = JSON.stringify({ tool_name: "Edit", cwd, tool_input: { file_path: file } });
  const finding = { file: "sync/a.luau", line: 3, column: 1, rule: "undefined-variable", message: "x is not defined" };
  const claude = JSON.parse(await reviewAnswer(stdin, { client: "claude", port: 1, ask: async () => ({ findings: [finding], elsewhere: [] }) }));
  assert.equal(claude.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(claude.hookSpecificOutput.additionalContext, /^Quack's analysis found 1 problem in the file\(s\) just edited:\nsync\/a\.luau:3:1 {2}undefined-variable {2}x is not defined/);
  assert.equal(claude.decision, undefined, "never blocks");
  const cursor = JSON.parse(await reviewAnswer(stdin, { client: "cursor", port: 1, ask: async () => ({ findings: [finding], elsewhere: [] }) }));
  assert.match(cursor.additional_context, /undefined-variable/);
  assert.equal(await reviewAnswer(stdin, { client: "claude", port: 1, ask: async () => ({ findings: [], elsewhere: [] }) }), "", "nothing found: silent");
  assert.equal(await reviewAnswer(stdin, { client: "claude", port: 1, ask: async () => ({ disabled: true, findings: [], elsewhere: [] }) }), "", "turned off in the app: silent");
  assert.equal(await reviewAnswer(stdin, { client: "claude", port: 1, ask: async () => { throw new Error("ECONNREFUSED"); } }), "", "hub down: silent");
  assert.equal(await reviewAnswer(stdin, { client: "cursor", port: 1, ask: async () => { throw new Error("ECONNREFUSED"); } }), "{}");
  assert.equal(await reviewAnswer("not json", { client: "claude", port: 1 }), "");
  assert.equal(reviewOutput("codex", ""), "");
});

test("hub: /api/analyze answers a review from the resident analysis, honours the setting, and the panel follows a place's edits", { timeout: 90000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-hub-auto-"));
  const folder = path.join(tmp, "Game");
  project(folder, { "ReplicatedStorage/Config.luau": CONFIG, "ServerScriptService/User.server.luau": USER });
  const registryFile = path.join(tmp, "hub-dev.json");
  saveRegistry(registryFile, { places: { "555": { folder, name: "Game" } } });
  const port = await freePort();
  const hub = new QuackHub({ port, registryFile, daemonCli, log: () => {}, auto: { debounceMs: 100 } });
  await hub.start();
  try {
    // the panel runs at start, then on each change of a script
    await waitFor(async () => (await call(port, "GET", "/api/analysis?placeId=555")).body.state === "ready");
    assert.deepEqual((await call(port, "GET", "/api/analysis?placeId=555")).body.findings, []);
    const configFile = path.join(folder, "sync", "ReplicatedStorage", "Config.luau");
    fs.writeFileSync(configFile, CONFIG.replace("getSpeed", "getWalkSpeed"));
    await waitFor(async () => (await call(port, "GET", "/api/analysis?placeId=555")).body.findings.length === 1);
    const panel = (await call(port, "GET", "/api/analysis?placeId=555")).body;
    assert.equal(panel.findings[0].file, "sync/ServerScriptService/User.server.luau");
    assert.equal(panel.findings[0].rule, "missing-member");
    const state = (await call(port, "GET", "/api/state")).body;
    assert.equal(state.places.find((p: any) => p.placeId === "555").findings, 1, "the place list carries the count");

    // the review: the edited file's findings, relative to its project
    const user = path.join(folder, "sync", "ServerScriptService", "User.server.luau");
    const review = (await call(port, "POST", "/api/analyze", { files: [user] })).body;
    assert.equal(review.placeId, "555");
    assert.deepEqual(review.findings.map((f: any) => [f.file, f.rule]), [["sync/ServerScriptService/User.server.luau", "missing-member"]]);
    assert.equal((await call(port, "POST", "/api/analyze", { files: ["relative.luau"] })).status, 400);

    // turned off for this place in the app: nothing runs; the panel stops for it
    const set = await call(port, "POST", "/api/automation", { placeId: "555", values: { review: false, panel: false } });
    assert.equal(set.body.effective["555"].review, false);
    assert.equal(set.body.effective["555"].precommit, false, "the pre-commit check starts off");
    assert.equal((await call(port, "POST", "/api/analyze", { files: [user] })).body.disabled, true);
    assert.equal((await call(port, "GET", "/api/analysis?placeId=555")).body.state, "off");
    assert.equal((await call(port, "POST", "/api/automation", { placeId: "999", values: { panel: true } })).status, 404);
    assert.equal((await call(port, "POST", "/api/automation", { global: { panel: "yes" } })).status, 400);
    assert.equal(readAutoSettings(autoSettingsPath(registryFile)).places["555"].review, false, "kept in automation-dev.json, next to the registry");
  } finally {
    await hub.stop();
  }
});

test("production errors: the first check only learns, a new hash later is told once with its file and line, a refused key is said once and asked a day later", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-errors-"));
  const folder = path.join(tmp, "Game");
  project(folder, { "ServerScriptService/Shop.server.luau": "print(1)\n" });
  fs.writeFileSync(path.join(folder, "sourcemap.json"), JSON.stringify({
    name: "Game", className: "DataModel", children: [{ name: "ServerScriptService", className: "ServerScriptService", children: [{ name: "Shop", className: "Script", filePaths: ["sync/ServerScriptService/Shop.server.luau"] }] }],
  }));
  let now = Date.parse("2026-11-12T12:00:00Z");
  let hashes = ["1", "2"];
  let refuse = false;
  const asked: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fake = (async (url: string) => {
    asked.push(url.replace(/\?.*/, ""));
    if (url.includes("/universes/v1/places/")) return json({ universeId: 42 });
    if (refuse) return json({ message: "Forbidden" }, 403);
    if (url.includes("/analytics-query-api/")) return json({ done: true, response: { values: hashes.map((h) => ({ breakdowns: [{ dimension: "MessageHash", value: h }], dataPoints: [{ value: 5 }] })) } });
    const ids = new URL(url).searchParams.getAll("messageHashIds");
    return json({ values: ids.map((id) => ({ id, logSource: "Server", message: `ServerScriptService.Shop:7: attempt to index nil (${id})`, firstSeenUtc: id === "old" ? "2026-01-01T00:00:00Z" : new Date(now).toISOString() })) });
  }) as typeof fetch;
  const lines: string[] = [];
  const { ErrorsWatch } = await import("../auto/errorsWatch.js");
  const file = path.join(tmp, "production-errors-dev.json");
  const options = { file, places: () => ({ "555": { folder, name: "Game" } }), enabled: () => true, log: (l: string) => lines.push(l), env: { fetch: fake, dataDir: tmp, env: {}, sleep: async () => {}, now: () => now, apiKey: async () => "key" } as any };
  const watch = new ErrorsWatch(options);

  let view = await watch.check("555");
  assert.equal(view.state, "ready");
  assert.deepEqual(view.fresh, [], "the first check only learns what is there");
  assert.equal(asked.filter((a) => a.includes("log-details")).length, 0, "and asks no details for it");

  // an hour later: one new hash (with its file and line), and one that was out of the top 100 before
  now += 3600_000;
  hashes = ["1", "2", "3", "old"];
  view = await watch.check("555");
  assert.deepEqual(view.fresh.map((e) => [e.hash, e.at, e.source]), [["3", "sync/ServerScriptService/Shop.server.luau:7", "Server"]]);
  assert.equal(asked.filter((a) => a.includes("log-details")).length, 1, "details only for the hashes not seen");
  assert.equal(watch.summary("555").newErrors, 1);
  assert.match(watch.summary("555").latestError!.message!, /attempt to index nil \(3\)/);

  // kept on disk: a hub started again (an update) tells nothing twice
  const again = new ErrorsWatch(options);
  now += 3600_000;
  assert.deepEqual((await again.check("555")).fresh.map((e) => e.hash), ["3"]);
  again.dismiss("555");
  assert.deepEqual(again.view("555").fresh, []);
  assert.equal(again.summary("555").newErrors, undefined);

  // a key without universe.analytics:read: said once, then left alone for a day
  refuse = true;
  now += 3600_000;
  view = await again.check("555");
  assert.equal(view.state, "problem");
  assert.match(view.problem!, /universe\.analytics:read/);
  const told = lines.filter((l) => l.includes("not read")).length;
  assert.equal(told, 1);
  const before = asked.length;
  now += 3600_000;
  again.tick();
  await wait(50);
  assert.equal(asked.length, before, "not asked again within a day");
  now += 24 * 3600_000;
  refuse = false;
  again.tick();
  await waitFor(() => again.view("555").state === "ready");

  // no key saved: no request at all, nothing to say
  const keyless = new ErrorsWatch({ ...options, file: path.join(tmp, "other.json"), env: { ...options.env, apiKey: async () => undefined } });
  const count = asked.length;
  assert.deepEqual((await keyless.check("555")).fresh, []);
  assert.equal(asked.length, count);
});

test("pre-commit: the hook goes in and out with the setting, keeps the project's own hook, stops a commit only on findings", { timeout: 60000 }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { setPrecommitHook, runPrecommit, FINDINGS_EXIT } = await import("../auto/precommit.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "quack-precommit-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  project(repo, { "ServerScriptService/Main.server.luau": "print(1)\n" });
  const hooks = path.join(repo, ".git", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho own >> \"$(git rev-parse --git-dir)/own-ran\"\nexit 0\n", { mode: 0o755 });

  // a fake CLI: what it exits with is what Quack's check would answer
  const cli = path.join(repo, "..", `fake-cli-${path.basename(repo)}.mjs`);
  const answer = (code: number) => fs.writeFileSync(cli, `process.exit(${code});\n`);
  const entry = { node: process.execPath, cli, flavor: "dev" as const };
  assert.equal(await setPrecommitHook(repo, true, entry), "installed");
  assert.equal(await setPrecommitHook(repo, true, entry), "installed", "twice is the same");
  assert.match(fs.readFileSync(path.join(hooks, "pre-commit"), "utf8"), /# quack-precommit dev/);
  assert.equal(fs.readFileSync(path.join(hooks, "pre-commit.before-quack"), "utf8").includes("own-ran"), true, "the project's own hook is kept");
  assert.equal(await setPrecommitHook(repo, true, { ...entry, flavor: "official" }), "another Quack's", "the other flavor's hook is left alone");

  const commit = (name: string) => {
    fs.writeFileSync(path.join(repo, "sync", name), "print(2)\n");
    git("add", "-A");
    try {
      git("commit", "-q", "-m", name);
      return true;
    } catch {
      return false;
    }
  };
  answer(FINDINGS_EXIT);
  assert.equal(commit("a.luau"), false, "findings stop the commit");
  answer(0);
  assert.equal(commit("b.luau"), true);
  answer(1);
  assert.equal(commit("c.luau"), true, "Quack failing never stops a commit");
  fs.rmSync(cli);
  assert.equal(commit("d.luau"), true, "nor Quack gone");
  assert.ok(fs.readFileSync(path.join(repo, ".git", "own-ran"), "utf8").split("\n").filter(Boolean).length >= 3, "the project's own hook ran first");

  assert.equal(await setPrecommitHook(repo, false, entry), "not installed");
  assert.match(fs.readFileSync(path.join(hooks, "pre-commit"), "utf8"), /own-ran/, "taken out, the project's own hook is back in place");
  git("config", "core.hooksPath", ".husky");
  assert.equal(await setPrecommitHook(repo, true, entry), "core.hooksPath is set", "a hooks folder of the project's own is not written");
  git("config", "--unset", "core.hooksPath");

  // the check itself: the staged Luau files only, through the hub, or alone with the hub down
  const registry = path.join(repo, "..", `hub-dev-${path.basename(repo)}.json`);
  saveRegistry(registry, { places: { "555": { folder: repo, name: "Game" } } });
  fs.writeFileSync(path.join(repo, "sync", "Bad.luau"), "print(notDefinedAnywhere)\n");
  git("add", "-A");
  const out: string[] = [];
  const finding = { file: "sync/Bad.luau", line: 1, column: 7, rule: "undefined-variable", message: "x" };
  let sent: string[] = [];
  const ctx = { cwd: repo, out: (l: string) => out.push(l), registry, ask: async (files: string[]) => ((sent = files), { findings: [finding] }) };
  assert.equal(await runPrecommit(ctx), FINDINGS_EXIT);
  assert.deepEqual(sent, [fs.realpathSync.native(path.join(repo, "sync", "Bad.luau"))], "only the staged Luau files");
  // the project reached through a junction (or a short 8.3 name, as on the CI runner): git names the real folder
  const link = `${repo}-link`;
  fs.symlinkSync(repo, link, "junction");
  try {
    assert.equal(await runPrecommit({ ...ctx, cwd: link }), FINDINGS_EXIT);
  } finally {
    // the link alone, never what it points at
    fs.unlinkSync(link);
  }
  assert.ok(fs.existsSync(path.join(repo, "sync", "Bad.luau")), "the project is still there");
  assert.match(out.join("\n"), /sync\/Bad\.luau:1:7 {2}undefined-variable/);
  assert.equal(await runPrecommit({ ...ctx, ask: async () => ({ disabled: true, findings: [] }) }), 0, "off in the app");
  // hub down: the setting from its file (off by default), then one analysis here
  assert.equal(await runPrecommit({ ...ctx, ask: async () => null }), 0, "off by default");
  writeAutoSettings(autoSettingsPath(registry), { place: { placeId: "555", values: { precommit: true } } });
  assert.equal(await runPrecommit({ ...ctx, ask: async () => null }), FINDINGS_EXIT);
  assert.equal(await runPrecommit({ ...ctx, cwd: os.tmpdir() }), 0, "not a project: through");
});

test("resident analysis (council review): a sync-folder tree follows new files, a panel run does not eat a review's news, the cache keeps nothing of a run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-resident2-"));
  project(root, { "ServerScriptService/User.server.luau": "print(1)\n" });
  const resident = new ResidentAnalysis();
  const user = path.join(root, "sync", "ServerScriptService", "User.server.luau");
  await resident.run({ root, files: [user], placeFolders: [] });
  // no sourcemap: a module added after the first run is found by the require that names it
  project(root, { "ReplicatedStorage/Config.luau": CONFIG });
  fs.writeFileSync(user, USER.replace("getSpeed", "getSped"));
  assert.deepEqual((await resident.run({ root, files: [user], placeFolders: [] })).findings.map((f) => f.rule), ["missing-member"]);

  // the module renames its function; the panel runs (whole place) before the review comes
  const config = path.join(root, "sync", "ReplicatedStorage", "Config.luau");
  fs.writeFileSync(user, USER);
  await resident.run({ root, files: [user], placeFolders: [] });
  await wait(80);
  fs.writeFileSync(config, CONFIG.replace("getSpeed", "getWalkSpeed"));
  await resident.run({ root, placeFolders: [] });
  assert.deepEqual((await resident.run({ root, files: [config], placeFolders: [] })).elsewhere.map((f) => path.basename(f.file)), ["User.server.luau"]);

  // what the cache keeps: the parse, never a run's node or bindings (they name nodes of an old tree)
  const { analyzeProject } = await import("../analyze/analyze.js");
  const cache: any = new Map();
  analyzeProject(root, { cache });
  assert.ok(cache.size >= 2);
  for (const { parsed } of cache.values()) {
    assert.equal(parsed.node, undefined);
    assert.equal(parsed.bound.size, 0);
  }
});

test("pre-commit (council review): a place unregistered or moved has its hook taken out of the folder it went in", { timeout: 60000 }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { HubAutomation } = await import("../auto/hubAuto.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "quack-unreg-"));
  execFileSync("git", ["-C", repo, "init", "-q"], { windowsHide: true });
  project(repo, { "A.luau": "return 1\n" });
  const settingsFile = path.join(repo, "..", `automation-${path.basename(repo)}.json`);
  writeAutoSettings(settingsFile, { global: { precommit: true, panel: false } });
  let places: Record<string, { folder: string }> = { "555": { folder: repo } };
  const auto = new HubAutomation({ settingsFile, places: () => places, service: {} as any, log: () => {}, precommit: { node: process.execPath, cli: "x.mjs", flavor: "dev" } });
  const hook = path.join(repo, ".git", "hooks", "pre-commit");
  await auto.reconcileHooks(true);
  assert.equal(auto.hookStatus()["555"], "installed");
  assert.ok(fs.existsSync(hook));
  places = {};
  await auto.reconcileHooks();
  assert.equal(fs.existsSync(hook), false, "unregistered: the hook is gone from its repository");
  assert.deepEqual(auto.hookStatus(), {});
  auto.stop();
});

test("council review, round 2: the first review has the panel's baseline from before the edit, an edit over two projects reviews both, the sync folder replaced whole counts", async () => {
  const { HubAutomation, panelCounts } = await import("../auto/hubAuto.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-first-review-"));
  project(root, { "ReplicatedStorage/Config.luau": CONFIG, "ServerScriptService/User.server.luau": USER });
  const resident = new ResidentAnalysis();
  await resident.run({ root, placeFolders: [] });
  await wait(80);
  const config = path.join(root, "sync", "ReplicatedStorage", "Config.luau");
  fs.writeFileSync(config, CONFIG.replace("getSpeed", "getWalkSpeed"));
  assert.deepEqual((await resident.run({ root, files: [config], placeFolders: [] })).elsewhere.map((f) => path.basename(f.file)), ["User.server.luau"], "the panel's run before the edit is the first review's baseline");

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "quack-second-project-"));
  project(other, { "ServerScriptService/Main.server.luau": "print(otherUndefined)\n" });
  project(root, { "ServerScriptService/Bad.server.luau": "print(rootUndefined)\n" });
  const settingsFile = path.join(other, "automation.json");
  const auto = new HubAutomation({ settingsFile, places: () => ({}), service: { run: (req: any) => resident.run(req) } as any, log: () => {} });
  const answer = await auto.review([path.join(root, "sync", "ServerScriptService", "Bad.server.luau"), path.join(other, "sync", "ServerScriptService", "Main.server.luau")], "review");
  assert.deepEqual(answer.findings.map((f) => f.message.match(/`(\w+)`/)?.[1]).sort(), ["otherUndefined", "rootUndefined"]);
  assert.ok(answer.findings.every((f) => path.isAbsolute(f.file)), "with two projects, the whole path says which");

  assert.equal(panelCounts("sync"), true, "the sync folder replaced or removed whole");
  assert.equal(panelCounts("sourcemap.json"), true);
  assert.equal(panelCounts("sync/A/B.luau"), true);
  assert.equal(panelCounts("sync/A/notes.txt"), false);
  assert.equal(panelCounts(".git/index"), false);
});

test("council review, round 2: one repository's places share its hook, a registry changed from a terminal and one changed while the hub was down take theirs out", { timeout: 60000 }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { HubAutomation } = await import("../auto/hubAuto.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { windowsHide: true, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  project(repo, { "A.luau": "return 1\n" });
  git("add", "-A");
  git("commit", "-q", "-m", "a");
  const worktree = `${repo}-wt`;
  git("worktree", "add", "-q", worktree);
  const settingsFile = path.join(repo, "..", `automation-${path.basename(repo)}.json`);
  const hooksFile = path.join(repo, "..", `hooks-${path.basename(repo)}.json`);
  writeAutoSettings(settingsFile, { global: { panel: false }, place: { placeId: "1", values: { precommit: true } } });
  let places: Record<string, { folder: string }> = { "1": { folder: repo }, "2": { folder: worktree } };
  const entry = { node: process.execPath, cli: "x.mjs", flavor: "dev" as const };
  const make = () => new HubAutomation({ settingsFile, hooksFile, places: () => places, service: { drop: async () => {} } as any, log: () => {}, precommit: entry });
  const hook = path.join(repo, ".git", "hooks", "pre-commit");
  const auto = make();
  auto.start();
  await auto.hooksSettled();
  assert.ok(fs.existsSync(hook), "place 2 has the check off, place 1 on: the shared hook stays");
  assert.deepEqual(auto.hookStatus(), { "1": "installed", "2": "installed" });

  // unregistered from a terminal: the next refresh (the hub's timer) sees it
  places = { "2": { folder: worktree } };
  auto.refresh();
  await auto.hooksSettled();
  assert.equal(fs.existsSync(hook), false, "place 1 gone, place 2 off: the hook leaves");
  auto.stop();

  // put back, then unregistered while no hub ran: the next hub reads where it went from disk
  places = { "1": { folder: repo } };
  const again = make();
  again.start();
  await again.hooksSettled();
  assert.ok(fs.existsSync(hook));
  again.stop();
  places = {};
  const next = make();
  next.start();
  await next.hooksSettled();
  assert.equal(fs.existsSync(hook), false, "the next hub takes it out");
  next.stop();
});

test("council review, round 3: a review's baseline is the newest run before its edit, whatever ran after; a worktree's borrowed sourcemap is looked up again; a folder with a dot counts", async () => {
  const { panelCounts } = await import("../auto/hubAuto.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-baselines-"));
  project(root, { "ReplicatedStorage/Config.luau": CONFIG, "ServerScriptService/User.server.luau": USER, "ServerScriptService/Other.server.luau": "print(1)\n" });
  const config = path.join(root, "sync", "ReplicatedStorage", "Config.luau");
  const other = path.join(root, "sync", "ServerScriptService", "Other.server.luau");
  const user = (f: { file: string }) => path.basename(f.file);

  // a clean panel run, the edit, a panel run after it, then the review: the clean run is the baseline
  let resident = new ResidentAnalysis();
  await resident.run({ root, placeFolders: [] });
  await wait(80);
  fs.writeFileSync(config, CONFIG.replace("getSpeed", "getWalkSpeed"));
  await wait(80);
  await resident.run({ root, placeFolders: [] });
  assert.deepEqual((await resident.run({ root, files: [config], placeFolders: [] })).elsewhere.map(user), ["User.server.luau"]);

  // two edits whose reviews queue: the first review runs after both, the second still sees its own
  fs.writeFileSync(config, CONFIG);
  resident = new ResidentAnalysis();
  await resident.run({ root, files: [other], placeFolders: [] });
  await wait(80);
  fs.writeFileSync(other, "print(2)\n");
  fs.writeFileSync(config, CONFIG.replace("getSpeed", "getWalkSpeed"));
  await wait(80);
  await resident.run({ root, files: [other], placeFolders: [] });
  assert.deepEqual((await resident.run({ root, files: [config], placeFolders: [] })).elsewhere.map(user), ["User.server.luau"]);

  // a worktree with no sourcemap: the synced checkout registered later is found then
  const { execFileSync } = await import("node:child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "quack-borrow-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { windowsHide: true, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  project(repo, { "A.luau": "return 1\n" });
  git("add", "-A");
  git("commit", "-q", "-m", "a");
  fs.writeFileSync(path.join(repo, "sourcemap.json"), JSON.stringify({ name: "Game", className: "DataModel", children: [] }));
  const worktree = `${repo}-wt`;
  git("worktree", "add", "-q", worktree);
  resident = new ResidentAnalysis();
  assert.equal((await resident.run({ root: worktree, placeFolders: [] })).stats.sourcemap, null);
  assert.equal(fileKey((await resident.run({ root: worktree, placeFolders: [repo] })).stats.sourcemap ?? ""), fileKey(path.join(repo, "sourcemap.json")));

  // a folder whose name has a dot, renamed or removed
  fs.mkdirSync(path.join(root, "sync", "Version.2"));
  fs.writeFileSync(path.join(root, "sync", "notes.txt"), "x");
  assert.equal(panelCounts("sync/Version.2", root), true, "a folder there now");
  assert.equal(panelCounts("sync/Gone.2", root), true, "a path gone");
  assert.equal(panelCounts("sync/notes.txt", root), false, "a file that is not a script");
});

test("council review, round 3: a hook that would not come out of a moved place's old folder is kept apart and tried again, also by the next hub", async () => {
  const { HubAutomation } = await import("../auto/hubAuto.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-stale-"));
  const settingsFile = path.join(tmp, "automation.json");
  const hooksFile = path.join(tmp, "hooks.json");
  writeAutoSettings(settingsFile, { global: { precommit: true, panel: false } });
  const oldFolder = path.join(tmp, "old");
  const newFolder = path.join(tmp, "new");
  let places: Record<string, { folder: string }> = { "1": { folder: oldFolder } };
  const installed = new Set<string>();
  let failRemoval = true;
  const setHook = async (folder: string, on: boolean) => {
    if (on) installed.add(folder);
    else if (installed.has(folder)) {
      if (failRemoval) throw new Error("EPERM");
      installed.delete(folder);
    }
    return on ? ("installed" as const) : ("not installed" as const);
  };
  const make = () => new HubAutomation({ settingsFile, hooksFile, setHook: setHook as any, places: () => places, service: { drop: async () => {} } as any, log: () => {}, precommit: { node: "n", cli: "c", flavor: "dev" } });
  const auto = make();
  auto.start();
  await auto.hooksSettled();
  assert.deepEqual([...installed], [oldFolder]);
  places = { "1": { folder: newFolder } };
  auto.refresh();
  await auto.hooksSettled();
  assert.deepEqual([...installed].sort(), [newFolder, oldFolder].sort(), "the removal failed, the new one is in");
  auto.stop();
  // the next hub reads the pending removal from disk and finishes it
  failRemoval = false;
  const next = make();
  next.start();
  await next.hooksSettled();
  assert.deepEqual([...installed], [newFolder]);
  next.stop();
});

test("pre-commit (council review): what the commit stages is checked, not the disk: a staged error fixed only on disk still stops it, a clean stage with an error only on disk goes through", { timeout: 60000 }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { runPrecommit, FINDINGS_EXIT } = await import("../auto/precommit.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "quack-staged-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { windowsHide: true, stdio: "ignore" });
  git("init", "-q");
  project(repo, { "ServerScriptService/Main.server.luau": "print(1)\n" });
  const registry = path.join(repo, "..", `hub-dev-${path.basename(repo)}.json`);
  saveRegistry(registry, { places: { "555": { folder: repo } } });
  writeAutoSettings(autoSettingsPath(registry), { global: { precommit: true } });
  const main = path.join(repo, "sync", "ServerScriptService", "Main.server.luau");
  // the hub down: one analysis in this process, over the staged texts
  const ctx = { cwd: repo, out: () => {}, registry, ask: async () => null };
  fs.writeFileSync(main, "print(stagedUndefined)\n");
  git("add", "-A");
  fs.writeFileSync(main, "print(1)\n");
  assert.equal(await runPrecommit(ctx), FINDINGS_EXIT, "the staged text has the error");
  fs.writeFileSync(main, "print(2)\n");
  git("add", "-A");
  fs.writeFileSync(main, "print(diskOnlyUndefined)\n");
  assert.equal(await runPrecommit(ctx), 0, "only the disk has it");
  // through the hub: the texts travel with the files
  let sent: Record<string, string> | undefined;
  await runPrecommit({ ...ctx, ask: async (_files: string[], texts?: Record<string, string>) => ((sent = texts), { findings: [] }) });
  assert.deepEqual(Object.values(sent ?? {}), ["print(2)\n"]);

  const port = await freePort();
  const hub = new QuackHub({ port, registryFile: registry, daemonCli, log: () => {}, auto: { debounceMs: 100 } });
  await hub.start();
  try {
    const answer = (await call(port, "POST", "/api/analyze", { files: [main], feature: "precommit", texts: { [main]: "print(hubStagedUndefined)\n" } })).body;
    assert.deepEqual(answer.findings.map((f: any) => f.message.match(/`(\w+)`/)?.[1]), ["hubStagedUndefined"], JSON.stringify(answer));
    assert.equal((await call(port, "POST", "/api/analyze", { files: [main], texts: { "relative.luau": "x" } })).status, 400, "a text only for a script's absolute path");
    assert.equal((await call(port, "POST", "/api/analyze", { files: [main], texts: { [path.join(repo, "notes.txt")]: "x" } })).status, 400);
    assert.equal((await call(port, "POST", "/api/analyze", { files: [main], absent: [42] })).status, 400);
    // a review of the disk right after is the disk's, not the staged text's (never cached)
    assert.deepEqual((await call(port, "POST", "/api/analyze", { files: [main], feature: "precommit" })).body.findings.map((f: any) => f.message.match(/`(\w+)`/)?.[1]), ["diskOnlyUndefined"]);
  } finally {
    await hub.stop();
  }
});

test("pre-commit (council review, round 2): the dependencies are read as the commit holds them too, and a staged file deleted from the disk is still checked", { timeout: 60000 }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { runPrecommit, FINDINGS_EXIT } = await import("../auto/precommit.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "quack-deps-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { windowsHide: true, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  project(repo, { "ReplicatedStorage/Config.luau": CONFIG, "ServerScriptService/User.server.luau": USER });
  git("add", "-A");
  git("commit", "-q", "-m", "a");
  const registry = path.join(repo, "..", `hub-dev-${path.basename(repo)}.json`);
  saveRegistry(registry, { places: {} });
  writeAutoSettings(autoSettingsPath(registry), { global: { precommit: true } });
  const ctx = { cwd: repo, out: () => {}, registry, ask: async () => null };
  const config = path.join(repo, "sync", "ReplicatedStorage", "Config.luau");
  const user = path.join(repo, "sync", "ServerScriptService", "User.server.luau");

  // the module renamed on disk only: the commit keeps getSpeed, so a commit of the caller is valid
  fs.writeFileSync(config, CONFIG.replace("getSpeed", "getWalkSpeed"));
  fs.writeFileSync(user, `${USER}-- touched\n`);
  git("add", "--", user);
  assert.equal(await runPrecommit(ctx), 0, "a dependency changed only on disk does not stop a valid commit");

  // the rename staged, the disk put back: the commit's caller is wrong
  git("add", "--", config);
  fs.writeFileSync(config, CONFIG);
  fs.writeFileSync(user, `${USER}-- touched again\n`);
  git("add", "--", user);
  assert.equal(await runPrecommit(ctx), FINDINGS_EXIT, "a dependency changed in the index does not hide the wrong call");
  git("reset", "-q", "--", config);
  git("commit", "-q", "-m", "b");

  // a staged script deleted from the disk afterwards: the commit still has it
  const bad = path.join(repo, "sync", "ServerScriptService", "Bad.server.luau");
  fs.writeFileSync(bad, "print(deletedButStagedUndefined)\n");
  git("add", "--", bad);
  fs.rmSync(bad);
  let sent: string[] = [];
  assert.equal(await runPrecommit({ ...ctx, ask: async (files: string[]) => ((sent = files), null) }), FINDINGS_EXIT);
  assert.deepEqual(sent.map((f) => path.basename(f)), ["Bad.server.luau"]);
});

test("pre-commit (council review, round 3): run from a subfolder, an untracked script there is still left out; a dependency deleted from the disk is found by its require with no sourcemap", { timeout: 60000 }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { runPrecommit, FINDINGS_EXIT } = await import("../auto/precommit.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "quack-subdir-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { windowsHide: true, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  const NO_SPEED = "local M = {}\nfunction M.getWalkSpeed() return 16 end\nreturn M\n";
  project(repo, { "ReplicatedStorage/Config.luau": NO_SPEED, "ServerScriptService/User.server.luau": "print(1)\n" });
  git("add", "-A");
  git("commit", "-q", "-m", "a");
  const registry = path.join(repo, "..", `hub-dev-${path.basename(repo)}.json`);
  saveRegistry(registry, { places: {} });
  writeAutoSettings(autoSettingsPath(registry), { global: { precommit: true } });
  const sss = path.join(repo, "sync", "ServerScriptService");
  // an untracked script beside the caller adds the key the module lacks: the commit does not have it
  fs.writeFileSync(path.join(sss, "Patch.server.luau"), 'local Config = require(game:GetService("ReplicatedStorage").Config)\nConfig.getSpeed = function() return 1 end\n');
  fs.writeFileSync(path.join(sss, "User.server.luau"), USER);
  git("add", "--", path.join(sss, "User.server.luau"));
  const ctx = { cwd: sss, out: () => {}, registry, ask: async () => null };
  assert.equal(await runPrecommit(ctx), FINDINGS_EXIT, "from the subfolder, the untracked Patch is not in the commit");

  // the module deleted from the disk only: the commit keeps it, its require still finds it
  fs.rmSync(path.join(sss, "Patch.server.luau"));
  fs.rmSync(path.join(repo, "sync", "ReplicatedStorage", "Config.luau"));
  assert.equal(await runPrecommit({ ...ctx, cwd: repo }), FINDINGS_EXIT, "Config (index) has no getSpeed");
});
