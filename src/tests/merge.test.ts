import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeScripts,
  newErrors,
  defaultTools,
  findLuauLsp,
  type MergeTools,
} from "../merge/merge.js";
import { config, readMergeSettings, writeMergeSettings, type QuackConfig } from "../config.js";
import { claudeArgs, codexArgs, codexReply, resolveAi, type Detected } from "../merge/ai.js";
import { findOnPath, quoteForCmd, run } from "../merge/cli.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const READY = { installed: true, loggedIn: true };
const ABSENT = { installed: false, loggedIn: false };
const settingsWith = (over: Partial<QuackConfig["merge"]>): QuackConfig["merge"] => ({ ...config.merge, ai: true, provider: "", ...over });
const brokenTextMerge = (text: string) => (/Config\.Damage = 15/.test(text) && /BaseDamage \//.test(text) ? ["x"] : []);

const BASE = "--!strict\nlocal Config = {}\nConfig.Damage = 10\nConfig.Cooldown = 2\n\nfunction Config.getDps(): number\n\treturn Config.Damage / Config.Cooldown\nend\n\nreturn Config\n";
const RENAMED = BASE.replace(/Damage/g, "BaseDamage");
const TUNED = BASE.replace("Damage = 10", "Damage = 15").replace("Cooldown = 2", "Cooldown = 1.5");

/** Real git merge-file, scripted analyzer and AI */
function tools(over: Partial<MergeTools>): MergeTools {
  return {
    merge3: defaultTools.merge3,
    analyze: async () => [],
    aiMerge: async () => "unused",
    // Never the real config.json or the real CLIs: Claude is the only AI here
    settings: () => settingsWith({}),
    detect: async () => ({ claude: READY, codex: ABSENT }),
    ...over,
  };
}

test("newErrors counts only what neither input had, as a multiset", () => {
  assert.deepEqual(
    newErrors(["game", "game", "game", "key BaseDamage"], ["game", "game"], ["game"]),
    ["game", "key BaseDamage"],
  );
  assert.deepEqual(newErrors(["a"], ["a"], []), []);
});

test("edits to different lines merge as text, both kept", async () => {
  const base = "local a = 1\nlocal b = 2\nlocal c = 3\n";
  const disk = "local a = 100\nlocal b = 2\nlocal c = 3\n";
  const studio = "local a = 1\nlocal b = 2\nlocal c = 300\n";
  const r = await mergeScripts(base, disk, studio, tools({}));
  assert.equal(r.method, "text");
  assert.equal(r.conflictingHunks, 0);
  assert.equal(r.text, "local a = 100\nlocal b = 2\nlocal c = 300\n");
});

test("the same line changed on both sides keeps Studio's line", async () => {
  const base = "local damage = 10\n";
  const r = await mergeScripts(base, "local damage = 12\n", "local damage = 20\n", tools({}));
  assert.equal(r.method, "text");
  assert.equal(r.conflictingHunks, 1);
  assert.equal(r.text, "local damage = 20\n");
});

test("a text merge with a new analyzer error goes to the AI, whose checked result is used", async () => {
  const calls: string[][] = [];
  const r = await mergeScripts(BASE, RENAMED, TUNED, tools({
    analyze: async (text) => (/Config\.Damage = 15/.test(text) && /BaseDamage \//.test(text) ? ["Key 'BaseDamage' not found"] : []),
    aiMerge: async (input) => {
      calls.push(input.errors);
      return RENAMED.replace("BaseDamage = 10", "BaseDamage = 15").replace("Cooldown = 2", "Cooldown = 1.5");
    },
  }));
  assert.equal(r.method, "ai");
  assert.deepEqual(calls, [["Key 'BaseDamage' not found"]]);
  assert.match(r.text, /Config\.BaseDamage = 15/);
  assert.match(r.text, /Config\.Cooldown = 1\.5/);
  assert.deepEqual(r.textMergeErrors, ["Key 'BaseDamage' not found"]);
});

test("the AI gets a second try with its own errors, then Studio is kept as the fallback", async () => {
  const attempts: Array<string[] | undefined> = [];
  const r = await mergeScripts(BASE, RENAMED, TUNED, tools({
    analyze: async (text) => (text.includes("broken") || (/Damage = 15/.test(text) && /BaseDamage \//.test(text)) ? ["new error"] : []),
    aiMerge: async (input) => {
      attempts.push(input.previousAttempt?.errors);
      return "broken";
    },
  }));
  assert.deepEqual(attempts, [undefined, ["new error"]]);
  assert.equal(r.method, "fallback");
  assert.equal(r.text, TUNED);
});

test("with merge.ai off, a failed check keeps Studio without calling the AI", async () => {
  let called = false;
  const r = await mergeScripts(BASE, RENAMED, TUNED, tools({
    analyze: async (text) => brokenTextMerge(text),
    aiMerge: async () => { called = true; return ""; },
    settings: () => settingsWith({ ai: false }),
  }));
  assert.equal(called, false);
  assert.equal(r.method, "fallback");
});

test("no AI CLI on this machine: Studio is kept and the note says what to install", async () => {
  let called = false;
  const r = await mergeScripts(BASE, RENAMED, TUNED, tools({
    analyze: async (text) => brokenTextMerge(text),
    aiMerge: async () => { called = true; return ""; },
    detect: async () => ({ claude: ABSENT, codex: { installed: true, loggedIn: false } }),
  }));
  assert.equal(called, false);
  assert.equal(r.method, "fallback");
  assert.match(r.aiNote ?? "", /install Claude Code or Codex/);
});

test("both CLIs and none chosen: the merge waits for a choice instead of guessing", async () => {
  const r = await mergeScripts(BASE, RENAMED, TUNED, tools({
    analyze: async (text) => brokenTextMerge(text),
    detect: async () => ({ claude: READY, codex: READY }),
  }));
  assert.equal(r.method, "fallback");
  assert.match(r.aiNote ?? "", /choose one/);
});

test("the chosen provider reaches the AI merge; with one CLI it is used without a choice", async () => {
  const seen: string[] = [];
  const fixed = RENAMED.replace("BaseDamage = 10", "BaseDamage = 15");
  const aiMerge = async (input: { provider: string }) => { seen.push(input.provider); return fixed; };
  const both = async () => ({ claude: READY, codex: READY });
  await mergeScripts(BASE, RENAMED, TUNED, tools({ analyze: async (t) => brokenTextMerge(t), aiMerge, detect: both, settings: () => settingsWith({ provider: "codex" }) }));
  await mergeScripts(BASE, RENAMED, TUNED, tools({ analyze: async (t) => brokenTextMerge(t), aiMerge, detect: async () => ({ claude: ABSENT, codex: READY }) }));
  assert.deepEqual(seen, ["codex", "codex"]);
});

test("resolveAi: none, off, the only one, the chosen one, a choice that left, and both unchosen", () => {
  const d = (claude: boolean, codex: boolean): Detected => ({ claude: claude ? READY : ABSENT, codex: codex ? READY : ABSENT });
  assert.deepEqual(resolveAi(settingsWith({}), d(false, false)), { state: "none", provider: null });
  assert.deepEqual(resolveAi(settingsWith({ ai: false }), d(true, false)), { state: "off", provider: null });
  // Off with nothing installed is "none": the app shows what to install, not a switch
  assert.deepEqual(resolveAi(settingsWith({ ai: false }), d(false, false)), { state: "none", provider: null });
  assert.deepEqual(resolveAi(settingsWith({}), d(false, true)), { state: "ready", provider: "codex" });
  assert.deepEqual(resolveAi(settingsWith({ provider: "claude" }), d(true, true)), { state: "ready", provider: "claude" });
  assert.deepEqual(resolveAi(settingsWith({ provider: "claude" }), d(false, true)), { state: "ready", provider: "codex" });
  assert.deepEqual(resolveAi(settingsWith({}), d(true, true)), { state: "choose", provider: null });
  // Installed but logged out does not count
  assert.deepEqual(resolveAi(settingsWith({}), { claude: { installed: true, loggedIn: false }, codex: ABSENT }), { state: "none", provider: null });
});

test("claude runs without --bare (which ignores the login) and without the user's settings", () => {
  const args = claudeArgs("sonnet", "C:/tmp/system.txt");
  assert.ok(!args.includes("--bare"));
  const at = args.indexOf("--setting-sources");
  assert.deepEqual(args.slice(at, at + 2), ["--setting-sources", ""]);
  for (const flag of ["-p", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
});

test("codex runs read-only, without the user's config or rules, and picks its own model when none is set", () => {
  const args = codexArgs("");
  for (const flag of ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--json"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("-s") + 1], "read-only");
  assert.ok(!args.includes("-m"));
  assert.deepEqual(codexArgs("gpt-6-luna").slice(-3), ["-m", "gpt-6-luna", "-"]);
});

test("codex's JSON events give its last message; an error event is an error", () => {
  const out = [
    JSON.stringify({ type: "thread.started", thread_id: "x" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "<<<MERGED\nreturn 1\nMERGED>>>" } }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
  assert.equal(codexReply(out), "<<<MERGED\nreturn 1\nMERGED>>>");
  assert.throws(() => codexReply(JSON.stringify({ type: "error", message: "usage limit reached" })), /usage limit/);
  assert.throws(() => codexReply("not json"), /no answer/);
});

test("merge settings: the app's choice is read fresh, other keys survive, a model with shell syntax is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-cfg-"));
  const file = path.join(dir, "config.json");
  const prev = config.merge;
  try {
    fs.writeFileSync(file, JSON.stringify({ port: 3825, merge: { ai: true, model: "sonnet" } }));
    assert.equal(readMergeSettings(file).provider, "");
    writeMergeSettings({ provider: "codex", ai: false }, file);
    const whole = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(whole.port, 3825);
    assert.equal(whole.merge.provider, "codex");
    assert.equal(readMergeSettings(file).ai, false);
    fs.writeFileSync(file, JSON.stringify({ merge: { provider: "gpt", codexModel: "x & calc", model: "a%PATH%" } }));
    const m = readMergeSettings(file);
    assert.equal(m.provider, "");
    assert.equal(m.codexModel, "");
    assert.equal(m.model, "sonnet");
  } finally {
    config.merge = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cmd.exe arguments are quoted, and what it would expand is refused", () => {
  assert.equal(quoteForCmd(""), '""');
  assert.equal(quoteForCmd("C:/a b/system.txt"), '"C:/a b/system.txt"');
  for (const bad of ['a"b', "%PATH%", "a^b", "!x!"]) assert.throws(() => quoteForCmd(bad));
});

/**
 * A fake AI CLI: a .cmd on Windows (how npm installs codex) that records where it ran and its
 * arguments and answers with a merge. The real aiMerge must start it, in an empty folder.
 */
function fakeCli(dir: string, name: string, reply: string): string {
  const js = path.join(dir, `${name}.cjs`);
  const seen = JSON.stringify(path.join(dir, "seen.json"));
  fs.writeFileSync(js, [
    'const fs = require("fs"); let s = "";',
    'process.stdin.on("data", (d) => (s += d)).on("end", () => {',
    `  fs.writeFileSync(${seen}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), files: fs.readdirSync("."), stdin: s }));`,
    `  process.stdout.write(${JSON.stringify(reply)});`,
    "});",
  ].join("\n"));
  if (process.platform === "win32") {
    const cmd = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(cmd, `@"${process.execPath}" "${js}" %*\r\n`);
    return cmd;
  }
  const sh = path.join(dir, name);
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  return sh;
}

test("the real aiMerge starts an npm-style CLI, in an empty folder, with the prompt on stdin", async () => {
  // A space in the path, as in a user folder like "C:\Users\Ana Silva"
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack fake ai-"));
  try {
    const event = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "<<<MERGED\nreturn 2\nMERGED>>>" } });
    const codexBin = fakeCli(dir, "fakecodex", event + "\n");
    const input = { base: "return 0\n", studio: "return 1\n", disk: "return 2\n", errors: ["e"] };
    assert.equal(await defaultTools.aiMerge({ ...input, provider: "codex", settings: settingsWith({ codexBin, codexModel: "gpt-test" }) }), "return 2\n");
    const seen = JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8"));
    assert.match(path.basename(seen.cwd), /^quack-merge-/);
    assert.deepEqual(seen.args, codexArgs("gpt-test"));
    assert.match(seen.stdin, /=== STUDIO ===\nreturn 1/);

    const claudeBin = fakeCli(dir, "fakeclaude", "noise\n<<<MERGED\nreturn 3\nMERGED>>>\n");
    assert.equal(await defaultTools.aiMerge({ ...input, provider: "claude", settings: settingsWith({ claudeBin, model: "haiku" }) }), "return 3\n");
    const seenClaude = JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8"));
    assert.equal(seenClaude.args[seenClaude.args.indexOf("--setting-sources") + 1], "");
    assert.equal(seenClaude.args[seenClaude.args.indexOf("--model") + 1], "haiku");
    // The folder it runs in holds only the system prompt: no CLAUDE.md, AGENTS.md or game files
    assert.deepEqual(seenClaude.files, ["system.txt"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a command is found on PATH with its Windows extension; a missing one is ENOENT", { skip: process.platform !== "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-path-"));
  try {
    fs.writeFileSync(path.join(dir, "tool.cmd"), "@echo hi\r\n");
    assert.equal(findOnPath("tool", { PATH: dir, PATHEXT: ".EXE;.CMD" })?.toLowerCase(), path.join(dir, "tool.cmd").toLowerCase());
    assert.equal(findOnPath("nothing", { PATH: dir, PATHEXT: ".EXE;.CMD" }), null);
    await assert.rejects(() => run(path.join(dir, "missing-tool"), []), { code: "ENOENT" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Real CLIs answering a real merge; slow and costs tokens, so only with QUACK_REAL_AI=1 */
for (const provider of ["claude", "codex"] as const) {
  test(`a real ${provider} merge keeps the rename and the tuned values`, { skip: process.env.QUACK_REAL_AI !== "1", timeout: 200000 }, async () => {
    const text = await defaultTools.aiMerge({
      base: BASE, studio: TUNED, disk: RENAMED, errors: ["TypeError: Key 'BaseDamage' not found in table 'Config'"],
      provider, settings: settingsWith({}),
    });
    assert.match(text, /BaseDamage = 15/);
    assert.match(text, /Cooldown = 1\.5/);
  });
}

test("no analyzer: the text merge is applied unchecked and says so", async () => {
  const r = await mergeScripts("a\n", "b\n", "a\n", tools({ analyze: async () => null }));
  assert.equal(r.method, "text");
  assert.match(r.aiNote ?? "", /no Luau analyzer/);
});

test("the real luau-lsp flags the BaseDamage text merge and nothing in either input", { skip: findLuauLsp() === null }, async () => {
  let aiErrors: string[] = [];
  const r = await mergeScripts(BASE, RENAMED, TUNED, {
    ...defaultTools,
    settings: () => settingsWith({}),
    detect: async () => ({ claude: READY, codex: ABSENT }),
    aiMerge: async (input) => {
      aiErrors = input.errors;
      return RENAMED.replace("BaseDamage = 10", "BaseDamage = 15").replace("Cooldown = 2", "Cooldown = 1.5");
    },
  });
  assert.deepEqual(aiErrors, ["TypeError: Key 'BaseDamage' not found in table 'Config'"]);
  assert.equal(r.method, "ai");
});

test("an analyzer that cannot run is an error, never a clean check", async () => {
  const prev = config.merge;
  config.merge = { ...prev, luauLsp: path.join(os.tmpdir(), "no-such-dir", "luau-lsp.exe") };
  try {
    await assert.rejects(() => defaultTools.analyze("return 1\n"));
    await assert.rejects(() => mergeScripts("a\n", "b\n", "c\n", { ...defaultTools }));
  } finally {
    config.merge = prev;
  }
});

test("codex runs with its shell, code, browser and web tools off, in a form an older Codex accepts", () => {
  const args = codexArgs("");
  const keys = args.filter((_, i) => args[i - 1] === "-c");
  for (const feature of ["shell_tool", "unified_exec", "code_mode_host"]) assert.ok(keys.includes(`features.${feature}=false`), feature);
  assert.ok(keys.includes("web_search=disabled"));
  // --disable with an unknown name stops Codex; -c with an unknown key is only a warning
  assert.ok(!args.includes("--disable"));
  // Every argument survives cmd.exe, which an npm-installed codex runs through
  for (const arg of args) quoteForCmd(arg);
});

/** A .cmd (or script) that starts a node child which writes its pid and never ends */
function hangingCli(dir: string): { bin: string; pidFile: string } {
  const pidFile = path.join(dir, "pid.txt");
  const js = path.join(dir, "hang.cjs");
  fs.writeFileSync(js, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  if (process.platform === "win32") {
    const bin = path.join(dir, "hang.cmd");
    fs.writeFileSync(bin, `@"${process.execPath}" "${js}" %*\r\n`);
    return { bin, pidFile };
  }
  const bin = path.join(dir, "hang");
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  return { bin, pidFile };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a CLI that hangs is stopped with what it started: the node behind a .cmd does not survive", { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-hang-"));
  try {
    const { bin, pidFile } = hangingCli(dir);
    await assert.rejects(() => run(bin, [], undefined, 1500), /timed out/);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0);
    const end = Date.now() + 5000;
    while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(pid), false, "the CLI kept running after the timeout");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a relative CLI path is found from Quack's folder, not from the empty folder it runs in", async () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".quack-rel-"));
  const runIn = fs.mkdtempSync(path.join(os.tmpdir(), "quack-elsewhere-"));
  try {
    const bin = fakeCli(dir, "relcli", "hello");
    const relative = path.relative(process.cwd(), bin);
    assert.ok(!path.isAbsolute(relative));
    const r = await run(relative, [], "", 20000, runIn);
    assert.equal(r.stdout, "hello", JSON.stringify(r));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(runIn, { recursive: true, force: true });
  }
});

test("an AI merge the analyzer can no longer check is not taken: Studio stays", async () => {
  let calls = 0;
  const r = await mergeScripts(BASE, RENAMED, TUNED, tools({
    // Found for the three inputs, gone by the time the AI answers
    analyze: async (text) => (++calls > 3 ? null : brokenTextMerge(text)),
    aiMerge: async () => RENAMED.replace("BaseDamage = 10", "BaseDamage = 15"),
  }));
  assert.equal(r.method, "fallback");
  assert.equal(r.text, TUNED);
  assert.match(r.aiNote ?? "", /could not check/);
});

test("a command on a relative PATH entry comes back absolute", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".quack-relpath-"));
  try {
    const name = process.platform === "win32" ? "tool.cmd" : "tool";
    fs.writeFileSync(path.join(dir, name), "x");
    const found = findOnPath("tool", { PATH: path.relative(process.cwd(), dir), PATHEXT: ".CMD" });
    assert.ok(found && path.isAbsolute(found), String(found));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
