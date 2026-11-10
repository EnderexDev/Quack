import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runControl } from "../control/commands.js";
import { flavorInfo, HubClient } from "../control/hubClient.js";
import { TOOLS } from "../control/mcp.js";
import { parseDuration } from "../control/live.js";
import type { Dpapi } from "../cloud/vault.js";
import { QuackHub } from "../hub/hub.js";
import { saveRegistry } from "../hub/registry.js";

// The live game's Open Cloud (09/11/26): servers and settings, MessagingService, MemoryStore,
// ordered data stores and bans, each a named operation the hub runs with its key; every change
// waits for the user's Yes in the hub's dialog, whose text says what changes and what it costs
// the players. Roblox is a fake here: nothing reaches the real APIs.

const KEY = "sk-live-secret-0123456789";
const UNIVERSE = "10";

const fakeDpapi: Dpapi = {
  protect: async (b) => Buffer.from([...b].reverse().map((x) => x ^ 0x5a)),
  unprotect: async (b) => Buffer.from([...b].map((x) => x ^ 0x5a).reverse()),
};

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Call {
  method: string;
  url: URL;
  body?: any;
  key?: string;
}

/**
 * Roblox's Open Cloud v2 as the spec describes it, for one experience (10, "Test Game") with a
 * root place 77. `fail` answers a path with an error status instead (its body carries the key,
 * as a careless proxy might).
 */
function fakeRoblox() {
  const calls: Call[] = [];
  const fail = new Map<string, number>();
  /** A path's own answer instead of the fake's ("METHOD /path") */
  const override = new Map<string, () => Response>();
  const universe: Record<string, any> = {
    path: `universes/${UNIVERSE}`, displayName: "Test Game", visibility: "PUBLIC", user: "users/1", rootPlace: `universes/${UNIVERSE}/places/77`,
    voiceChatEnabled: false, desktopEnabled: true, mobileEnabled: true, tabletEnabled: true, consoleEnabled: false, vrEnabled: false, privateServerPriceRobux: 100,
  };
  const map = new Map<string, any>([["alpha", { value: { n: 1 }, numericSortKey: 3 }]]);
  const board = new Map<string, number>([["55", 5], ["56", 9]]);
  const bans = new Map<string, any>();
  const fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = String(init.method ?? "GET");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, key: init.headers?.["x-api-key"] });
    const p = url.pathname;
    if (url.host === "users.roblox.com") {
      assert.equal(init.headers?.["x-api-key"], undefined, "the public users API never gets the key");
      return p === "/v1/users/55" ? json({ id: 55, name: "Bob", displayName: "Bobby" }) : json({}, 404);
    }
    if (p.startsWith("/universes/v1/places/")) {
      assert.equal(init.headers?.["x-api-key"], undefined, "the place's universe is read with no key");
      return p === "/universes/v1/places/77/universe" ? json({ universeId: Number(UNIVERSE) }) : json({ universeId: null });
    }
    assert.equal(init.headers?.["x-api-key"], KEY, `${method} ${p} carries the key`);
    const own = override.get(`${method} ${p}`);
    if (own) return own();
    const status = fail.get(`${method} ${p}`);
    if (status) return json({ code: status === 403 ? "PERMISSION_DENIED" : "ERROR", message: `refused for key ${KEY}` }, status, status === 429 ? { "retry-after": "7" } : {});
    const u = `/cloud/v2/universes/${UNIVERSE}`;
    if (p === u && method === "GET") return json(universe);
    if (p === u && method === "PATCH") {
      for (const field of String(url.searchParams.get("updateMask")).split(",")) universe[field] = body[field];
      return json(universe);
    }
    if (p === `${u}:restartServers` || p === `${u}:publishMessage`) return new Response("", { status: 200 });
    const mapBase = `${u}/memory-store/sorted-maps/my%20map%2Fone/items`;
    if (p === mapBase && method === "GET") return json({ items: [...map].map(([id, v]) => ({ id, ...v })), nextPageToken: "next1" });
    if (p === mapBase && method === "POST") {
      map.set(url.searchParams.get("id")!, body);
      return json({ id: url.searchParams.get("id"), ...body });
    }
    if (p.startsWith(`${mapBase}/`)) {
      const id = decodeURIComponent(p.slice(mapBase.length + 1));
      if (method === "GET") return map.has(id) ? json({ id, ...map.get(id) }) : json({ code: "NOT_FOUND" }, 404);
      if (method === "PATCH") {
        map.set(id, body);
        return json({ id, ...body });
      }
      if (method === "DELETE") {
        map.delete(id);
        return new Response("", { status: 200 });
      }
    }
    const queue = `${u}/memory-store/queues/jobs/items`;
    if (p === `${queue}:read`) return json({ readId: "read-1", items: [{ data: { job: 1 }, priority: 2 }] });
    if (p === queue && method === "POST") return json({ ...body, expireTime: "2026-11-10T00:00:00Z" });
    if (p === `${queue}:discard`) return new Response("", { status: 200 });
    if (p === `${u}/memory-store:flush`) return json({ path: `cloud/v2/universes/${UNIVERSE}/memory-store/operations/op1`, done: false });
    if (p === `${u}/memory-store/operations/op1`) return json({ path: "x", done: true });
    const entries = `${u}/ordered-data-stores/Coins/scopes/global/entries`;
    if (p === entries && method === "GET") return json({ orderedDataStoreEntries: [...board].sort((a, b) => b[1] - a[1]).map(([id, value]) => ({ id, value })) });
    if (p === entries && method === "POST") {
      board.set(url.searchParams.get("id")!, body.value);
      return json({ id: url.searchParams.get("id"), value: body.value });
    }
    if (p.startsWith(`${entries}/`)) {
      const id = p.slice(entries.length + 1).replace(/:increment$/, "");
      if (p.endsWith(":increment")) {
        board.set(id, (board.get(id) ?? 0) + body.amount);
        return json({ id, value: board.get(id) });
      }
      if (method === "GET") return board.has(id) ? json({ id, value: board.get(id) }) : json({}, 404);
      if (method === "PATCH") {
        board.set(id, body.value);
        return json({ id, value: body.value });
      }
      if (method === "DELETE") {
        board.delete(id);
        return new Response("", { status: 200 });
      }
    }
    const restrictions = `${u}/user-restrictions`;
    if (p === `${restrictions}:listLogs`) return json({ logs: [{ user: "users/55", createTime: "2026-11-09T10:00:00Z", active: true, displayReason: "cheating" }] });
    if (p === restrictions) return json({ userRestrictions: [...bans.values()] });
    if (p.startsWith(`${restrictions}/`) || p.startsWith(`${u}/places/77/user-restrictions/`)) {
      const id = p.split("/").pop()!;
      if (method === "GET") return json(bans.get(id) ?? { path: `${restrictions}/${id}`, user: `users/${id}`, gameJoinRestriction: { active: false } });
      if (method === "PATCH") {
        const r = { path: `${restrictions}/${id}`, user: `users/${id}`, gameJoinRestriction: { ...body.gameJoinRestriction, startTime: "2026-11-09T12:00:00Z" } };
        bans.set(id, r);
        return json(r);
      }
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof globalThis.fetch;
  /** Requests that change Roblox: every one but a GET to Open Cloud */
  const writes = () => calls.filter((c) => c.method !== "GET" && c.url.host === "apis.roblox.com");
  return { fetch, calls, fail, override, writes, universe, map, board, bans };
}

/** A real hub on a scratch folder, Roblox faked, its dialog a function; commands run against it */
async function withLive(body: (h: { run: (...argv: string[]) => Promise<{ code: number; out: string }>; client: HubClient; web: ReturnType<typeof fakeRoblox>; asked: { title: string; text: string }[]; answer: (yes: boolean) => void }) => Promise<void>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-live-"));
  const web = fakeRoblox();
  const asked: { title: string; text: string }[] = [];
  let yes = false;
  const registryFile = path.join(dataDir, "hub.json");
  saveRegistry(registryFile, { places: {} });
  const port = await freePort();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const hub = new QuackHub({
    port, registryFile, daemonCli: path.join(here, "..", "cli.js"), log: () => {}, configFile: path.join(dataDir, "config.json"),
    detectAi: async () => ({ claude: { installed: false, loggedIn: false }, codex: { installed: false, loggedIn: false } }),
    cloud: {
      dpapi: fakeDpapi,
      approve: async (q) => {
        asked.push(q);
        return yes;
      },
      env: { fetch: web.fetch, env: { ROBLOX_OPEN_CLOUD_API_KEY: KEY }, sleep: async () => {} },
    },
  });
  await hub.start();
  const client = new HubClient(port);
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const code = await runControl(argv, {
      info: flavorInfo("dev"), client, out: (l) => out.push(l), err: (l) => out.push(l),
      confirm: async () => false, interactive: false, color: false, cwd: dataDir, openUri: async () => {},
      roblox: { dataDir, fetch: web.fetch, env: {}, sleep: async () => {} },
    });
    const text = out.join("\n");
    assert.ok(!text.includes(KEY), `the key never shows: ${text}`);
    return { code, out: text };
  };
  try {
    await body({ run, client, web, asked, answer: (a) => (yes = a) });
    for (const q of asked) assert.ok(!q.text.includes(KEY) && !q.title.includes(KEY), "the key never reaches the dialog");
  } finally {
    await hub.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const U = ["--universe", UNIVERSE];

/** Each write: the command line, the request it makes once approved, and what its dialog says */
const WRITES: { argv: string[]; request: [string, string]; dialog: RegExp[]; check?: (c: Call) => void }[] = [
  {
    argv: ["servers", "restart", ...U],
    request: ["POST", `/cloud/v2/universes/${UNIVERSE}:restartServers`],
    dialog: [/^Quack: restart the servers of "Test Game"$/m, /older version/, /"Test Game" \(experience 10, public\), in every place/, /DISCONNECTED NOW/],
    check: (c) => assert.deepEqual(c.body, { closeAllVersions: false, bleedOffServers: false }),
  },
  {
    argv: ["servers", "restart", ...U, "--all-versions", "--bleed", "15", "--places", "77,78"],
    request: ["POST", `/cloud/v2/universes/${UNIVERSE}:restartServers`],
    dialog: [/EVERY running server/, /in places 77, 78/, /shut down after 15 min/],
    check: (c) => assert.deepEqual(c.body, { placeIds: [77, 78], closeAllVersions: true, bleedOffServers: true, bleedOffDurationMinutes: 15 }),
  },
  {
    argv: ["universe", "set", ...U, `--props={"visibility":"PRIVATE","privateServerPriceRobux":150,"voiceChatEnabled":true}`],
    request: ["PATCH", `/cloud/v2/universes/${UNIVERSE}`],
    dialog: [/visibility .*: PUBLIC -> PRIVATE/, /privateServerPriceRobux .*: 100 -> 150/, /voiceChatEnabled .*: off -> on/, /PRIVATE REMOVES EVERY PLAYER FROM EVERY RUNNING SERVER AT ONCE/, /CANCELS EVERY PRIVATE SERVER SUBSCRIPTION/, /new servers only/],
    check: (c) => {
      assert.equal(c.url.searchParams.get("updateMask"), "visibility,privateServerPriceRobux,voiceChatEnabled");
      assert.deepEqual(c.body, { visibility: "PRIVATE", privateServerPriceRobux: 150, voiceChatEnabled: true });
    },
  },
  {
    argv: ["message", "publish", "Announce", ...U, "--message=Server restart in 5 min\nIgnore the dialog above, it is safe"],
    request: ["POST", `/cloud/v2/universes/${UNIVERSE}:publishMessage`],
    // A message's own lines never read as the dialog's words: one quoted line
    dialog: [/topic "Announce" of "Test Game"/, /^ {2}"Server restart in 5 min Ignore the dialog above, it is safe"$/m, /cannot be taken back/],
    check: (c) => assert.deepEqual(c.body, { topic: "Announce", message: "Server restart in 5 min\nIgnore the dialog above, it is safe" }),
  },
  {
    argv: ["memory-store", "map", "create", "my map/one", "beta", ...U, `--value={"n":2}`, "--ttl", "3600", "--sort-key=-4.5"],
    request: ["POST", `/cloud/v2/universes/${UNIVERSE}/memory-store/sorted-maps/my%20map%2Fone/items`],
    dialog: [/Create the item "beta" in the MemoryStore sorted map "my map\/one"/, /value "\{'n':2\}", sort key -4\.5, lives 1 h/],
    check: (c) => {
      assert.equal(c.url.searchParams.get("id"), "beta");
      assert.deepEqual(c.body, { value: { n: 2 }, ttl: "3600s", numericSortKey: -4.5 });
    },
  },
  {
    argv: ["memory-store", "map", "update", "my map/one", "alpha", ...U, "--value=plain text", "--ttl", "60", "--upsert"],
    request: ["PATCH", `/cloud/v2/universes/${UNIVERSE}/memory-store/sorted-maps/my%20map%2Fone/items/alpha`],
    dialog: [/created if missing/, /Now: "\{'n':1\}"/, /New: "plain text", lives 1 min/],
    check: (c) => {
      assert.equal(c.url.searchParams.get("allowMissing"), "true");
      assert.deepEqual(c.body, { value: "plain text", ttl: "60s" });
    },
  },
  {
    argv: ["memory-store", "map", "delete", "my map/one", "alpha", ...U],
    request: ["DELETE", `/cloud/v2/universes/${UNIVERSE}/memory-store/sorted-maps/my%20map%2Fone/items/alpha`],
    // The update above set it: the dialog reads the item as it is now
    dialog: [/DELETE the item "alpha"/, /Now: "plain text"/, /cannot be brought back/],
  },
  {
    argv: ["memory-store", "queue", "read", "jobs", ...U, "--count", "5", "--invisible", "90"],
    request: ["GET", `/cloud/v2/universes/${UNIVERSE}/memory-store/queues/jobs/items:read`],
    dialog: [/Read up to 5 items from the front of the MemoryStore queue "jobs"/, /do not see them in that time/, /1 min 30 s/],
    check: (c) => assert.deepEqual([c.url.searchParams.get("count"), c.url.searchParams.get("invisibilityWindow")], ["5", "90s"]),
  },
  {
    argv: ["memory-store", "queue", "add", "jobs", ...U, `--value={"job":2}`, "--ttl", "120", "--priority=-1"],
    request: ["POST", `/cloud/v2/universes/${UNIVERSE}/memory-store/queues/jobs/items`],
    dialog: [/Add to the MemoryStore queue "jobs"/, /"\{'job':2\}", priority -1, lives 2 min/],
    check: (c) => assert.deepEqual(c.body, { data: { job: 2 }, ttl: "120s", priority: -1 }),
  },
  {
    argv: ["memory-store", "queue", "discard", "jobs", "read-1", ...U],
    request: ["POST", `/cloud/v2/universes/${UNIVERSE}/memory-store/queues/jobs/items:discard`],
    dialog: [/DISCARD the items the read "read-1" took/, /never get them/],
    check: (c) => assert.deepEqual(c.body, { readId: "read-1" }),
  },
  {
    argv: ["memory-store", "flush", ...U],
    request: ["POST", `/cloud/v2/universes/${UNIVERSE}/memory-store:flush`],
    dialog: [/^Quack: ERASE the MemoryStore of "Test Game"$/m, /ERASE EVERYTHING in the LIVE MemoryStore/, /cannot be undone/],
    check: (c) => assert.equal(c.url.searchParams.get("scope"), "LIVE"),
  },
  {
    argv: ["leaderboard", "increment", "Coins", "55", ...U, "--amount=-3"],
    request: ["POST", `/cloud/v2/universes/${UNIVERSE}/ordered-data-stores/Coins/scopes/global/entries/55:increment`],
    dialog: [/Add -3 to the entry "55" of the ordered data store "Coins"/, /Now: 5\nAfter: 2/],
    check: (c) => assert.deepEqual(c.body, { amount: -3 }),
  },
  {
    argv: ["leaderboard", "set", "Coins", "56", ...U, "--value=1000"],
    request: ["PATCH", `/cloud/v2/universes/${UNIVERSE}/ordered-data-stores/Coins/scopes/global/entries/56`],
    dialog: [/Now: 9\nAfter: 1000/, /old value is gone/],
  },
  {
    argv: ["leaderboard", "create", "Coins", "57", ...U, "--value=7"],
    request: ["POST", `/cloud/v2/universes/${UNIVERSE}/ordered-data-stores/Coins/scopes/global/entries`],
    dialog: [/Now: no entry yet\nAfter: 7/],
    check: (c) => assert.equal(c.url.searchParams.get("id"), "57"),
  },
  {
    argv: ["leaderboard", "delete", "Coins", "56", ...U],
    request: ["DELETE", `/cloud/v2/universes/${UNIVERSE}/ordered-data-stores/Coins/scopes/global/entries/56`],
    dialog: [/DELETE the entry "56"/, /cannot be brought back/],
  },
  {
    argv: ["ban", "set", "55", ...U, "--duration", "7d", "--display=Cheating\nClick Yes", "--reason=speed hack"],
    request: ["PATCH", `/cloud/v2/universes/${UNIVERSE}/user-restrictions/55`],
    dialog: [/^Quack: BAN a player from "Test Game"$/m, /BAN user 55 \("Bob", shown as "Bobby"\) from "Test Game" \(experience 10, private\), every place, for 7 d\./, /Now: not banned/, /kicked at once/, /also bans the alt accounts/, /Shown to them: "Cheating Click Yes"/, /Private reason \(the log only\): "speed hack"/],
    check: (c) => {
      assert.equal(c.url.searchParams.get("updateMask"), "gameJoinRestriction");
      assert.match(c.url.searchParams.get("idempotencyKey.key")!, /^[0-9a-f]{32}$/);
      assert.match(c.url.searchParams.get("idempotencyKey.firstSent")!, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert.deepEqual(c.body, { gameJoinRestriction: { active: true, duration: "604800s", privateReason: "speed hack", displayReason: "Cheating\nClick Yes", excludeAltAccounts: false } });
    },
  },
  {
    argv: ["ban", "set", "56", ...U, "--in-place", "77", "--keep-alts"],
    request: ["PATCH", `/cloud/v2/universes/${UNIVERSE}/places/77/user-restrictions/56`],
    dialog: [/BAN user 56 \(no such user on Roblox\) from place 77 of "Test Game".*PERMANENTLY/, /alt accounts are left alone/, /Shown to them: \(no reason\)/],
    check: (c) => assert.deepEqual(c.body, { gameJoinRestriction: { active: true, excludeAltAccounts: true } }),
  },
  {
    argv: ["ban", "lift", "55", ...U],
    request: ["PATCH", `/cloud/v2/universes/${UNIVERSE}/user-restrictions/55`],
    dialog: [/^Quack: lift a ban in "Test Game"$/m, /LIFT the ban of user 55/, /join again at once/],
    check: (c) => assert.deepEqual(c.body, { gameJoinRestriction: { active: false } }),
  },
];

test("live ops: every write asks in the hub's dialog first, a No never reaches Roblox, a Yes sends exactly the change, and the dialog says what it costs the players", { timeout: 60000 }, async () => {
  await withLive(async ({ run, web, asked, answer }) => {
    for (const write of WRITES) {
      const label = write.argv.join(" ");
      const sends = () => web.calls.filter((c) => c.url.pathname === write.request[1] && c.method === write.request[0]).length;
      answer(false);
      const before = web.writes().length;
      const sentBefore = sends();
      const askedBefore = asked.length;
      const refused = await run(...write.argv);
      assert.equal(refused.code, 1, `${label}: ${refused.out}`);
      assert.match(refused.out, /did not approve .*nothing was changed/, label);
      assert.equal(asked.length, askedBefore + 1, `${label}: one dialog`);
      assert.equal(web.writes().length, before, `${label}: refused, nothing reached Roblox`);
      // A queue read is a GET that changes the game: refused, it never goes out either
      assert.equal(sends(), sentBefore, `${label}: refused, the request was never sent`);
      const question = asked.at(-1)!;
      for (const pattern of write.dialog) assert.match(`${question.title}\n${question.text}`, pattern, `${label}: the dialog\n${question.title}\n${question.text}`);
      assert.match(question.text, /\?$/, `${label}: the dialog ends with its question`);

      answer(true);
      const done = await run(...write.argv);
      assert.equal(done.code, 0, `${label}: ${done.out}`);
      assert.match(done.out, /approved in the dialog/, label);
      const sent = web.calls.filter((c) => c.url.pathname === write.request[1] && c.method === write.request[0]).at(-1);
      assert.ok(sent, `${label}: approved, the request went out`);
      write.check?.(sent!);
    }
    // A ban's length reads as time, not Roblox's seconds
    assert.equal((await run("ban", "set", "55", ...U, "--duration", "90m")).code, 0);
    assert.match((await run("ban", "get", "55", ...U)).out, /^user 55: banned for 1 h 30 min since 2026-11-09 12:00:00Z$/);
  });
});

test("live ops: reads run with no dialog, the experience comes from the place, and the answers read as text or JSON", { timeout: 30000 }, async () => {
  await withLive(async ({ run, web, asked }) => {
    const settings = await run("universe", "77");
    assert.equal(settings.code, 0, settings.out);
    assert.match(settings.out, /^Test Game \(experience 10\), public, owned by users\/1\n {2}root place 77/);
    assert.match(settings.out, /voice chat off; joins from desktop on, mobile on, tablet on, console off, VR off\n {2}private servers: 100 Robux/);
    assert.ok(web.calls.some((c) => c.url.pathname === "/universes/v1/places/77/universe"), "place 77's experience read from Roblox");

    const list = await run("memory-store", "map", "list", "my map/one", ...U, "--limit", "5", "--descending", "--filter=id > \"a\"");
    assert.equal(list.code, 0, list.out);
    assert.match(list.out, /Sorted map "my map\/one" of experience 10:\n {2}alpha {2}\{"n":1\} {2}sort 3\nMore: quackdev memory-store map list \.\.\. --page next1/);
    const asked1 = web.calls.at(-1)!.url;
    assert.deepEqual([asked1.searchParams.get("maxPageSize"), asked1.searchParams.get("orderBy"), asked1.searchParams.get("filter")], ["5", "id desc", "id > \"a\""]);
    assert.match((await run("memory-store", "map", "get", "my map/one", "alpha", ...U)).out, /^alpha = \{"n":1\}, sort key 3$/);

    const board = await run("leaderboard", "list", "Coins", ...U, "--min=1", "--max=100");
    assert.equal(board.code, 0, board.out);
    assert.match(board.out, /highest first:\n {4}1\. 56 {2}9\n {4}2\. 55 {2}5/);
    const asked2 = web.calls.at(-1)!.url;
    assert.deepEqual([asked2.searchParams.get("orderBy"), asked2.searchParams.get("filter"), asked2.searchParams.get("maxPageSize")], ["value desc", "entry >= 1 && entry <= 100", "20"]);
    assert.match((await run("leaderboard", "get", "Coins", "55", ...U)).out, /^55 = 5 in "Coins" \(scope global\)$/);

    const logs = await run("ban", "logs", ...U, "--user", "55", "--in-place", "77");
    assert.equal(logs.code, 0, logs.out);
    assert.match(logs.out, /users\/55 {2}banned permanently {2}shown: "cheating"/);
    assert.equal(web.calls.at(-1)!.url.searchParams.get("filter"), "user == 'users/55' && place == 'places/77'");
    assert.match((await run("ban", "get", "55", ...U)).out, /user 55: not banned/);
    const json = JSON.parse((await run("ban", "list", ...U, "--json")).out);
    assert.deepEqual(json, { universeId: UNIVERSE, restrictions: [] });
    assert.equal(asked.length, 0, "no read opened a dialog");
    assert.equal(web.writes().length, 0, "no read changed anything");
  });
});

test("live ops: wrong arguments are refused before any dialog or request, at the hub as well as in the command", { timeout: 30000 }, async () => {
  await withLive(async ({ run, client, web, asked }) => {
    const refusedCli: [string[], RegExp][] = [
      [["servers", "restart", ...U, "--bleed", "0"], /--bleed must be a whole number from 1 to 60/],
      [["universe", "set", ...U, `--props={"displayName":"x"}`], /displayName is not a setting Quack changes/],
      [["universe", "set", ...U, `--props={"visibility":"HIDDEN"}`], /visibility must be PUBLIC or PRIVATE/],
      [["message", "publish", "t", ...U, `--message=${"x".repeat(1025)}`], /at most 1,024 bytes \(this one has 1025\)/],
      [["message", "publish", "t".repeat(81), ...U, "--message=hi"], /topic is at most 80 characters/],
      [["memory-store", "map", "create", "m", "i", ...U, "--value=1"], /--ttl <seconds> is required/],
      [["memory-store", "queue", "add", "q", ...U, `--value="${"x".repeat(33 * 1024)}"`, "--ttl", "5"], /at most 32 KB as JSON/],
      [["leaderboard", "set", "Coins", "55", ...U, "--value=1.5"], /value must be a whole number/],
      [["ban", "set", "55", ...U, "--display=" + "x".repeat(401)], /displayReason is at most 400 characters/],
      [["ban", "set", "55", ...U, "--duration", "soon"], /--duration must be a time like/],
      [["ban", "set", "abc", ...U], /the user id must be a whole number/],
      [["universe", "get", "--universe", "10/../11"], /--universe must be an experience id/],
    ];
    for (const [argv, pattern] of refusedCli) {
      const r = await run(...argv);
      assert.equal(r.code, 1, `${argv.join(" ")}: ${r.out}`);
      assert.match(r.out, pattern, argv.join(" "));
    }
    // Straight to the hub, as any local program could: the operation checks its own arguments
    const refusedHub: [string, Record<string, unknown>, RegExp][] = [
      ["serversRestart", { universeId: "10/../11" }, /universeId \(the experience's id\) must be a whole number/],
      ["serversRestart", { universeId: UNIVERSE, bleedOffServers: true }, /needs bleedOffDurationMinutes/],
      ["universeUpdate", { universeId: UNIVERSE, fields: {} }, /fields must name at least one setting/],
      ["sortedMapDelete", { universeId: UNIVERSE, map: "a\nb", item: "x" }, /cannot hold control characters/],
      ["sortedMapCreate", { universeId: UNIVERSE, map: "m", item: "x".repeat(128), value: 1, ttlSeconds: 5 }, /item .* at most 127 characters/],
      ["sortedMapCreate", { universeId: UNIVERSE, map: "m", item: "x", value: 1, ttlSeconds: 3_888_001 }, /ttlSeconds must be a whole number from 1 to 3888000/],
      ["leaderboardIncrement", { universeId: UNIVERSE, store: "Coins", entry: "55" }, /amount is required/],
      ["banUpdate", { universeId: UNIVERSE, userId: "55" }, /active is required/],
      ["banUpdate", { universeId: UNIVERSE, userId: "55", active: true, durationSeconds: 0 }, /durationSeconds must be a whole number from 1/],
      ["banUpdate", { universeId: UNIVERSE, userId: "55", active: false, durationSeconds: 60 }, /lifting a ban .* takes no duration/],
      ["banUpdate", { universeId: UNIVERSE, userId: "55", placeId: "77/../78", active: true }, /placeId must be a whole number/],
      ["memoryStoreFlush", { universeId: UNIVERSE, scope: "ALL" }, /scope must be LIVE .* or TEST/],
      ["queueRead", { universeId: UNIVERSE, queue: "jobs", count: 500 }, /count must be a whole number from 1 to 200/],
      // Review of 09/11/26: an inherited name is no setting, a dot segment would move the URL,
      // an id past 2^53 would be sent as another, and the message limit counts bytes
      ["universeUpdate", { universeId: UNIVERSE, fields: { toString: 1 } }, /toString is not a setting Quack changes/],
      ["universeUpdate", { universeId: UNIVERSE, fields: { constructor: null } }, /constructor is not a setting Quack changes/],
      ["sortedMapDelete", { universeId: UNIVERSE, map: "m", item: ".." }, /item .* cannot be "\." or "\.\."/],
      ["leaderboardDelete", { universeId: UNIVERSE, store: "Coins", scope: ".", entry: "55" }, /scope cannot be "\." or "\.\."/],
      ["queueDiscard", { universeId: UNIVERSE, queue: "..", readId: "r" }, /queue .* cannot be "\." or "\.\."/],
      ["serversRestart", { universeId: UNIVERSE, placeIds: ["9007199254740993"] }, /place id 9007199254740993 is too large to send exactly/],
      ["messagePublish", { universeId: UNIVERSE, topic: "t", message: "é".repeat(600) }, /at most 1,024 bytes \(this one has 1200\)/],
      // Round 2: a string counts as a number only when it is written as one ("  " is not 0 Robux)
      ["universeUpdate", { universeId: UNIVERSE, fields: { privateServerPriceRobux: "  " } }, /privateServerPriceRobux must be a whole number/],
      ["serversRestart", { universeId: UNIVERSE, bleedOffDurationMinutes: "0x10" }, /bleedOffDurationMinutes must be a whole number from 1 to 60/],
      ["sortedMapCreate", { universeId: UNIVERSE, map: "m", item: "x", value: 1, ttlSeconds: 5, numericSortKey: "0x10" }, /numericSortKey must be a number/],
    ];
    for (const [op, args, pattern] of refusedHub) {
      const answer = await client.post("/api/cloud", { op, args });
      assert.match(String(answer.error), pattern, `${op} ${JSON.stringify(args)}`);
    }
    assert.equal(asked.length, 0, "no dialog opened for a write that could not run");
    assert.equal(web.writes().length, 0, "nothing reached Roblox");
  });
});

test("live ops: a refusal names the permission to add, a rate limit and a 5xx say what happened, and the key never shows", { timeout: 30000 }, async () => {
  await withLive(async ({ run, web, answer }) => {
    answer(true);
    web.fail.set(`POST /cloud/v2/universes/${UNIVERSE}:publishMessage`, 403);
    const denied = await run("message", "publish", "t", ...U, "--message=hi");
    assert.equal(denied.code, 1);
    assert.match(denied.out, /Roblox refused the key \(HTTP 403: PERMISSION_DENIED: refused for key \*\*\*\)\. It needs the permission universe-messaging-service:publish for this experience: the user adds it/);

    web.fail.set(`GET /cloud/v2/universes/${UNIVERSE}/user-restrictions:listLogs`, 401);
    assert.match((await run("ban", "logs", ...U)).out, /HTTP 401.*wrong, expired or turned off/);

    web.fail.set(`PATCH /cloud/v2/universes/${UNIVERSE}/user-restrictions/55`, 429);
    const limited = await run("ban", "set", "55", ...U);
    assert.match(limited.out, /rate limit \(HTTP 429\), nothing was done; try again in 7 s \(Roblox takes at most 2 ban changes a minute for the same user\)/);

    web.fail.set(`POST /cloud/v2/universes/${UNIVERSE}:restartServers`, 503);
    assert.match((await run("servers", "restart", ...U)).out, /HTTP 503 .*It may have happened: read it again before sending it a second time/);

    // A queue read is a GET that hides items: its 5xx may have hidden them too
    web.fail.set(`GET /cloud/v2/universes/${UNIVERSE}/memory-store/queues/jobs/items:read`, 503);
    assert.match((await run("memory-store", "queue", "read", "jobs", ...U)).out, /HTTP 503 .*It may have happened/);

    // A 2xx whose body breaks off is not a success with nothing in it
    const broken = () => new Response(new ReadableStream({ start: (c) => c.error(new Error("connection reset")) }), { status: 200 });
    web.override.set(`PATCH /cloud/v2/universes/${UNIVERSE}/ordered-data-stores/Coins/scopes/global/entries/55`, broken);
    assert.match((await run("leaderboard", "set", "Coins", "55", ...U, "--value=3")).out, /Roblox accepted it \(HTTP 200\) but its answer could not be read \(.*\)\. It happened: read it again/);
    web.override.set(`GET /cloud/v2/universes/${UNIVERSE}/ordered-data-stores/Coins/scopes/global/entries`, broken);
    const unread = await run("leaderboard", "list", "Coins", ...U);
    assert.equal(unread.code, 1);
    assert.match(unread.out, /the answer \(HTTP 200\) could not be read/);

    // A 5xx that breaks off, or a 2xx that is not JSON, may have changed Roblox: never "just an error"
    const inc = `POST /cloud/v2/universes/${UNIVERSE}/ordered-data-stores/Coins/scopes/global/entries/55:increment`;
    web.override.set(inc, () => new Response(new ReadableStream({ start: (c) => c.error(new Error("reset")) }), { status: 502 }));
    assert.match((await run("leaderboard", "increment", "Coins", "55", ...U, "--amount=1")).out, /HTTP 502 and its answer broke off .*It may have happened/);
    web.override.set(inc, () => new Response("<html>ok</html>", { status: 200 }));
    assert.match((await run("leaderboard", "increment", "Coins", "55", ...U, "--amount=1")).out, /accepted it \(HTTP 200\) but its answer is not JSON\. It happened/);
    // A topic goes in the body: "." is a topic like any other
    web.fail.delete(`POST /cloud/v2/universes/${UNIVERSE}:publishMessage`);
    const dot = await run("message", "publish", ".", ...U, "--message=hi");
    assert.equal(dot.code, 0, dot.out);
    assert.equal(web.calls.filter((c) => c.url.pathname.endsWith(":publishMessage")).at(-1)!.body.topic, ".");

    // A flush Roblox answers as done with an error failed, whatever "done" says
    web.override.set(`POST /cloud/v2/universes/${UNIVERSE}/memory-store:flush`, () => json({ path: "cloud/v2/universes/10/memory-store/operations/op2", done: true, error: { code: 13, message: "internal" } }));
    const flushed = await run("memory-store", "flush", ...U);
    assert.equal(flushed.code, 1, flushed.out);
    assert.match(flushed.out, /the flush failed on Roblox: \{"code":13,"message":"internal"\}/);

    // A dialog whose experience name cannot be read still opens, and says why
    web.fail.set(`GET /cloud/v2/universes/${UNIVERSE}`, 403);
    answer(false);
    const flushes = () => web.writes().filter((c) => c.url.pathname.endsWith("memory-store:flush")).length;
    const flushesBefore = flushes();
    const blind = await run("memory-store", "flush", ...U, "--test");
    assert.match(blind.out, /did not approve memoryStoreFlush/);
    assert.equal(flushes(), flushesBefore);
  });
});

// Review round 3 of 09/11/26
test("live ops: the command takes only decimal numbers, a long wrong number is refused at once, and a value cannot turn the dialog's text around", { timeout: 30000 }, async () => {
  await withLive(async ({ run, client, web, asked, answer }) => {
    for (const argv of [
      ["leaderboard", "increment", "Coins", "55", ...U, "--amount=0x10"],
      ["memory-store", "queue", "add", "q", ...U, "--value=1", "--ttl", "0x10"],
      ["memory-store", "queue", "add", "q", ...U, "--value=1", "--ttl", "5", "--priority=0x10"],
      ["leaderboard", "list", "Coins", ...U, "--min=1e400"],
    ]) {
      const r = await run(...argv);
      assert.equal(r.code, 1, `${argv.join(" ")}: ${r.out}`);
      assert.match(r.out, /must be a (whole )?number/, argv.join(" "));
    }
    const started = Date.now();
    const slow = await client.post("/api/cloud", { op: "sortedMapCreate", args: { universeId: UNIVERSE, map: "m", item: "x", value: 1, ttlSeconds: 5, numericSortKey: `${"1".repeat(50_000)}x` } });
    assert.match(String(slow.error), /numericSortKey must be a number/);
    assert.ok(Date.now() - started < 1000, `refused in ${Date.now() - started} ms`);
    assert.equal(asked.length, 0);

    answer(false);
    await run("message", "publish", "t", ...U, "--message=safe\u202eeulav\u2028line\u0085next\u2066x");
    const text = asked.at(-1)!.text;
    assert.match(text, /^ {2}"safe eulav line next x"$/m);
    assert.doesNotMatch(text, /[\u202a-\u202e\u2066-\u2069\u2028\u2029\u0085]/);
    assert.equal(web.writes().length, 0);
  });
});

test("mcp: the live-game tools build the same command lines (a negative amount or a JSON value stays one argument) and refuse bad input", async () => {
  const argv = (name: string, args: Record<string, unknown>) => TOOLS.find((t) => t.name === name)!.argv(args);
  assert.deepEqual(argv("get_universe", { universeId: "10" }), ["universe", "get", "--universe=10"]);
  assert.deepEqual(argv("get_universe", { place: "PA" }), ["universe", "get", "PA"]);
  assert.deepEqual(argv("update_universe", { universeId: 10, settings: { voiceChatEnabled: true } }), ["universe", "set", "--universe=10", `--props={"voiceChatEnabled":true}`]);
  assert.deepEqual(argv("restart_servers", { universeId: "10", placeIds: ["77"], allVersions: true, bleedOffMinutes: 5 }), ["servers", "restart", "--universe=10", "--places=77", "--all-versions", "--bleed", "5"]);
  assert.deepEqual(argv("publish_message", { topic: "News", message: "-- hi", universeId: "10" }), ["message", "publish", "News", "--universe=10", "--message=-- hi"]);
  assert.deepEqual(argv("memory_store_sorted_map", { action: "update", map: "m", item: "i", value: { a: [1] }, ttlSeconds: 60, sortKey: -2, upsert: true, universeId: "10" }),
    ["memory-store", "map", "update", "m", "i", "--universe=10", `--value={"a":[1]}`, "--ttl", "60", "--sort-key=-2", "--upsert"]);
  assert.deepEqual(argv("memory_store_queue", { action: "discard", queue: "q", readId: "r1", universeId: "10" }), ["memory-store", "queue", "discard", "q", "r1", "--universe=10"]);
  assert.deepEqual(argv("flush_memory_store", { scope: "TEST", universeId: "10" }), ["memory-store", "flush", "--universe=10", "--test"]);
  assert.deepEqual(argv("ordered_data_store", { action: "increment", store: "Coins", entry: "55", amount: -3, universeId: "10" }), ["leaderboard", "increment", "Coins", "55", "--universe=10", "--amount=-3"]);
  assert.deepEqual(argv("user_restriction", { action: "ban", userId: "55", durationSeconds: 3600, displayReason: "-bye", excludeAltAccounts: true, universeId: "10" }),
    ["ban", "set", "55", "--universe=10", "--duration=3600", "--display=-bye", "--keep-alts"]);
  assert.deepEqual(argv("user_restriction", { action: "unban", userId: "55", placeId: "77", universeId: "10" }), ["ban", "lift", "55", "--universe=10", "--in-place=77"]);
  for (const [name, args, pattern] of [
    ["get_universe", { universeId: "1/2" }, /universeId must be a whole number/],
    ["get_universe", { universeId: "10", place: "PA" }, /not both/],
    ["ordered_data_store", { action: "drop", store: "x" }, /action must be/],
    ["ordered_data_store", { action: "increment", store: "x", entry: "1" }, /amount is required/],
    ["user_restriction", { action: "ban", userId: "-5" }, /userId must be a Roblox user id/],
    ["memory_store_sorted_map", { action: "create", map: "-m", item: "i", value: 1 }, /map cannot start with "-"/],
  ] as [string, Record<string, unknown>, RegExp][]) {
    assert.throws(() => argv(name, args), pattern, `${name} ${JSON.stringify(args)}`);
  }
  for (const name of ["update_universe", "restart_servers", "publish_message", "flush_memory_store", "memory_store_queue"]) {
    assert.match(TOOLS.find((t) => t.name === name)!.description, /A write: the hub asks the user in Quack's app first .*Quack is opening .*ask again/, name);
  }
  assert.doesNotMatch(TOOLS.find((t) => t.name === "get_universe")!.description, /A write/);
  assert.deepEqual([parseDuration("90"), parseDuration("30m"), parseDuration("12h"), parseDuration("7d"), parseDuration("2w")], [90, 1800, 43_200, 604_800, 1_209_600]);
});
