import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HEADER, APPROVAL_TOKEN_HEADER, AppApprovals, launchApp } from "../cloud/approve.js";
import { registerCloudOps } from "../cloud/ops.js";
import type { Dpapi } from "../cloud/vault.js";
import { QuackHub } from "../hub/hub.js";
import { saveRegistry } from "../hub/registry.js";

// 10/11/26 (Ender: the PowerShell window "looked like a virus"): a write waits in the hub, the
// app shows it in its own popup, and only the app's token answers it

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "ab".repeat(32);
const fakeDpapi: Dpapi = { protect: async (b) => Buffer.from(b), unprotect: async (b) => Buffer.from(b) };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function call(port: number, method: "GET" | "POST", pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

let written = 0;
registerCloudOps({
  approvalTestWrite: { write: true, describe: (a) => ({ title: "Quack: approval test", text: `Set ${a.what}\nLine two\u202Ehidden` }), run: async () => ({ written: ++written }) },
});

async function withHub(options: { launched?: string[]; timeoutMs?: number; appExe?: string | null }, body: (port: number, hub: QuackHub) => Promise<void>): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-approval-"));
  const registryFile = path.join(dataDir, "hub.json");
  saveRegistry(registryFile, { places: {} });
  const port = await freePort();
  const hub = new QuackHub({
    port, registryFile, daemonCli: path.join(here, "..", "cli.js"), log: () => {}, configFile: path.join(dataDir, "config.json"),
    detectAi: async () => ({ claude: { installed: false, loggedIn: false }, codex: { installed: false, loggedIn: false } }),
    cloud: {
      dpapi: fakeDpapi,
      ...(options.appExe === null ? {} : { appExe: options.appExe ?? "C:\\Quack\\quack-app.exe" }),
      launchApp: (exe) => options.launched?.push(exe),
      ...(options.timeoutMs ? { approvalTimeoutMs: options.timeoutMs } : {}),
      env: { fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch, env: {}, sleep: async () => {} },
    },
  });
  await hub.start();
  try {
    await body(port, hub);
  } finally {
    await hub.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("approval: with no app running the hub starts it hidden and answers at once; the app's poll lets the write wait for its answer", { timeout: 30000 }, async () => {
  const launched: string[] = [];
  await withHub({ launched }, async (port, hub) => {
    assert.ok(hub.setApprovalToken(TOKEN));
    const before = written;
    const first = await call(port, "POST", "/api/cloud", { op: "approvalTestWrite", args: { what: "Coins" } });
    assert.match(first.body.error, /Quack is opening.*ask again/);
    assert.deepEqual(launched, ["C:\\Quack\\quack-app.exe"], "the app was started");
    assert.equal(written, before, "nothing ran");

    // A plain /api/state (quack status, the MCP) is not the app
    await call(port, "GET", "/api/state");
    assert.match((await call(port, "POST", "/api/cloud", { op: "approvalTestWrite", args: { what: "Coins" } })).body.error, /Quack is opening/);

    // The app's poll: now the write waits in the queue
    const state = await call(port, "GET", "/api/state", undefined, { [APP_HEADER]: "1" });
    assert.ok(state.body.capabilities.includes("approvals"));
    assert.equal(state.body.approvals, 0);
    const pending = call(port, "POST", "/api/cloud", { op: "approvalTestWrite", args: { what: "Coins" } });
    await until(async () => (await call(port, "GET", "/api/state")).body.approvals === 1);
    const list = await call(port, "GET", "/api/approvals");
    assert.equal(list.status, 200, "the list is open");
    assert.equal(list.body.tokenSet, true);
    assert.equal(list.body.answerable, false, "no token sent, not answerable");
    const [question] = list.body.approvals;
    assert.equal(question.title, "Quack: approval test");
    assert.equal(question.text, "Set Coins\nLine two\\u{202E}hidden", "the whole text, every hidden character shown");
    assert.ok(question.expiresAt - question.createdAt === 5 * 60_000, "five minutes to answer");
    assert.equal((await call(port, "GET", "/api/approvals", undefined, { [APPROVAL_TOKEN_HEADER]: TOKEN })).body.answerable, true);

    // A second write while one waits: refused at once
    assert.match((await call(port, "POST", "/api/cloud", { op: "approvalTestWrite", args: { what: "Gems" } })).body.error, /another write is waiting/);

    // Only the app's token answers
    assert.equal((await call(port, "POST", "/api/approvals/answer", { id: question.id, approve: true })).status, 403, "no token");
    assert.equal((await call(port, "POST", "/api/approvals/answer", { id: question.id, approve: true }, { [APPROVAL_TOKEN_HEADER]: "cd".repeat(32) })).status, 403, "another token");
    assert.equal((await call(port, "POST", "/api/approvals/answer", { id: question.id, approve: true }, { [APPROVAL_TOKEN_HEADER]: TOKEN.slice(2) })).status, 403, "a shorter one");
    assert.equal((await call(port, "POST", "/api/approvals/answer", { id: "nope", approve: true }, { [APPROVAL_TOKEN_HEADER]: TOKEN })).status, 404);
    assert.equal(written, before, "still nothing ran");
    const ok = await call(port, "POST", "/api/approvals/answer", { id: question.id, approve: true }, { [APPROVAL_TOKEN_HEADER]: TOKEN });
    assert.equal(ok.status, 200);
    assert.deepEqual((await pending).body, { result: { written: before + 1 } });
    assert.equal((await call(port, "GET", "/api/state")).body.approvals, 0);

    // Refuse
    await call(port, "GET", "/api/state", undefined, { [APP_HEADER]: "1" });
    const refused = call(port, "POST", "/api/cloud", { op: "approvalTestWrite", args: { what: "Coins" } });
    await until(async () => (await call(port, "GET", "/api/approvals")).body.approvals.length === 1);
    const id = (await call(port, "GET", "/api/approvals")).body.approvals[0].id;
    await call(port, "POST", "/api/approvals/answer", { id, approve: false }, { [APPROVAL_TOKEN_HEADER]: TOKEN });
    assert.match((await refused).body.error, /did not approve approvalTestWrite in Quack's app.*nothing was changed/);
    assert.equal(written, before + 1);
  });
});

test("approval: a hub with no token can be asked but never answered, and no answer in time is a No", { timeout: 30000 }, async () => {
  await withHub({ timeoutMs: 300 }, async (port) => {
    await call(port, "GET", "/api/state", undefined, { [APP_HEADER]: "1" });
    const before = written;
    const pending = call(port, "POST", "/api/cloud", { op: "approvalTestWrite", args: { what: "Coins" } });
    await until(async () => (await call(port, "GET", "/api/approvals")).body.approvals.length === 1);
    const list = (await call(port, "GET", "/api/approvals", undefined, { [APPROVAL_TOKEN_HEADER]: TOKEN })).body;
    assert.equal(list.tokenSet, false);
    assert.equal(list.answerable, false, "the app learns to ask for a hub restart");
    assert.equal((await call(port, "POST", "/api/approvals/answer", { id: list.approvals[0].id, approve: true }, { [APPROVAL_TOKEN_HEADER]: TOKEN })).status, 403);
    assert.match((await pending).body.error, /did not approve/);
    assert.equal(written, before);
  });
  // Started from dist/ with no --app: it says to open the app instead of starting one
  await withHub({ appExe: null }, async (port) => {
    assert.match((await call(port, "POST", "/api/cloud", { op: "approvalTestWrite", args: {} })).body.error, /app is not running.*open it/);
  });
});

test("approval: the token is 64 hex characters, compared as a digest, and a stopped hub refuses what waits", async () => {
  const approvals = new AppApprovals({ appExe: "x" });
  assert.equal(approvals.setToken("short"), false);
  assert.equal(approvals.hasToken(), false);
  assert.equal(approvals.tokenMatches(TOKEN), false, "no token: nothing matches");
  assert.equal(approvals.setToken(`${TOKEN.toUpperCase()}\r\n`), true);
  assert.equal(approvals.tokenMatches(TOKEN), true);
  assert.equal(approvals.tokenMatches([TOKEN]), false, "a repeated header is refused");
  assert.equal(approvals.tokenMatches(undefined), false);
  approvals.sawApp();
  const answer = approvals.approver()({ title: "t", text: "x" });
  assert.equal(approvals.list().length, 1);
  approvals.close();
  assert.equal(await answer, false);
  assert.equal(approvals.list().length, 0);
});

// Council review of 10/11/26: a burst of writes started the app once each; an answer that came
// after the deadline (a late timer) still counted; invisible characters the old list missed
test("approval: the app is started once per 15 s however many writes ask, an answer after the deadline is a No, and every invisible character is shown", async () => {
  let clock = 1_000_000;
  const launched: string[] = [];
  const approvals = new AppApprovals({ appExe: "app.exe", launch: (exe) => launched.push(exe), now: () => clock, timeoutMs: 60_000 });
  const approve = approvals.approver();
  for (let i = 0; i < 5; i++) await assert.rejects(approve({ title: "t", text: "x" }), /Quack is opening/);
  assert.equal(launched.length, 1, "five writes at once: one start");
  clock += 14_000;
  await assert.rejects(approve({ title: "t", text: "x" }), /Quack is opening/);
  assert.equal(launched.length, 1);
  clock += 1_000;
  await assert.rejects(approve({ title: "t", text: "x" }), /Quack is opening/);
  assert.equal(launched.length, 2, "15 s later it tries again");
  const failing = new AppApprovals({ appExe: "app.exe", launch: () => { launched.push("x"); throw new Error("ENOENT"); }, now: () => clock });
  for (let i = 0; i < 3; i++) await assert.rejects(failing.approver()({ title: "t", text: "x" }), /Quack is opening/);
  assert.equal(launched.length, 3, "a start that fails is not retried at once either");

  approvals.sawApp();
  const late = approve({ title: "t", text: "x" });
  const [question] = approvals.list();
  clock += 60_000;
  assert.equal(approvals.answer(question.id, true), false, "past the deadline: refused even if the timer is late");
  assert.equal(await late, false);

  const { revealHidden, hasHiddenCharacters } = await import("../cloud/approve.js");
  assert.equal(revealHidden("a­b᠎c͏d\u{E0041}e️fㅤg⁠h"), "a\\u{00AD}b\\u{180E}c\\u{034F}d\\u{E0041}e\\u{FE0F}f\\u{3164}g\\u{2060}h");
  assert.equal(revealHidden("tab\tand\nlines\r\nstay"), "tab\tand\nlines\r\nstay");
  assert.equal(hasHiddenCharacters("print('ok')\n"), false);
  assert.equal(hasHiddenCharacters("print('o\u{E0020}k')"), true);
  // The Mongolian variation selectors are combining marks (Mn), not format characters
  assert.equal(revealHidden("a᠋b᠌c᠍d᠏e"), "a\\u{180B}b\\u{180C}c\\u{180D}d\\u{180F}e");
  assert.equal(hasHiddenCharacters("print('o᠏k')"), true);
});

test("approval: the app is started detached with --hidden, never hidden by Windows (its first show is the popup's)", () => {
  const calls: { exe: string; args: string[]; options: any }[] = [];
  let unref = false;
  const fake = ((exe: string, args: string[], options: any) => {
    calls.push({ exe, args, options });
    return { on: () => {}, unref: () => (unref = true) };
  }) as any;
  launchApp("C:\\Quack\\quack-app.exe", fake);
  assert.deepEqual(calls[0].args, ["--hidden"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, false);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.ok(unref, "the hub does not wait for it");
  // No PowerShell anywhere in the approval path
  const source = fs.readFileSync(path.join(here, "..", "..", "src", "cloud", "approve.ts"), "utf8");
  assert.doesNotMatch(source, /powershellExe|-NoProfile|System.Windows.Forms/);
});

test("approval: the hub reads the app's token from stdin (--token-stdin), and only that token answers", { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-approval-main-"));
  const registryFile = path.join(dataDir, "hub.json");
  saveRegistry(registryFile, { places: {} });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(here, "..", "hub", "main.js"), "--port", String(port), "--registry", registryFile, "--token-stdin"], { stdio: ["pipe", "ignore", "pipe"] });
  try {
    child.stdin.end(`${TOKEN}\n`);
    await until(async () => {
      try {
        return (await call(port, "GET", "/api/approvals", undefined, { [APPROVAL_TOKEN_HEADER]: TOKEN })).body?.answerable === true;
      } catch {
        return false;
      }
    }, 15000);
    assert.equal((await call(port, "GET", "/api/approvals", undefined, { [APPROVAL_TOKEN_HEADER]: "cd".repeat(32) })).body.answerable, false);
    assert.ok(!child.spawnargs.some((a) => a.includes(TOKEN)), "never on the command line");
  } finally {
    // A hub that already died emitted its exit long ago: never wait for it again
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill();
      await exited;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
