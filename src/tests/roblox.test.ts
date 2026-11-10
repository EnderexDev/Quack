import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runControl } from "../control/commands.js";
import { flavorInfo, HubClient } from "../control/hubClient.js";
import { serveMcp } from "../control/mcp.js";
import { assetThumbnail, cloudSettings, docSecurity, downloadPlace, placeVersions, saveCloudSettings, robloxDocs, robloxEnv, searchAssets, uploadAsset, type RobloxEnv } from "../control/roblox.js";
import { Vault, type Dpapi } from "../cloud/vault.js";
import { registerCloudOps } from "../cloud/ops.js";
import { lintTranslations } from "../cloud/localization.js";
import { readJsonFile } from "../cloud/web.js";
import { QuackHub } from "../hub/hub.js";
import { saveRegistry } from "../hub/registry.js";
import { fileURLToPath } from "node:url";

/** DPAPI stand-in: reversible, and never the key's own bytes on disk */
const fakeDpapi: Dpapi = {
  protect: async (b) => Buffer.from([...b].reverse().map((x) => x ^ 0x5a)),
  unprotect: async (b) => Buffer.from([...b].map((x) => x ^ 0x5a).reverse()),
};

/** A real hub on a scratch folder, its Open Cloud on the fake web, its approval dialog a function */
async function withCloudHub(dataDir: string, fetch: typeof globalThis.fetch, variables: Record<string, string>, body: (port: number) => Promise<void>, approve: (q: { title: string; text: string }) => Promise<boolean> = async () => false): Promise<void> {
  const registryFile = path.join(dataDir, "hub.json");
  saveRegistry(registryFile, { places: {} });
  const port = await freePort();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const hub = new QuackHub({
    port, registryFile, daemonCli: path.join(here, "..", "cli.js"), log: () => {}, configFile: path.join(dataDir, "config.json"),
    detectAi: async () => ({ claude: { installed: false, loggedIn: false }, codex: { installed: false, loggedIn: false } }),
    cloud: { dpapi: fakeDpapi, approve, env: { fetch, env: variables, sleep: async () => {} } },
  });
  await hub.start();
  try {
    await body(port);
  } finally {
    await hub.stop();
  }
}

/** A fake web: each call is logged; `route` answers by URL (a thrown error is a network failure) */
function fakeWeb(route: (url: URL, init: any, n: number) => Response | Promise<Response>) {
  const calls: { url: URL; init: any }[] = [];
  const fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return route(url, init, calls.filter((c) => c.url.pathname === url.pathname).length);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const md = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "text/markdown" } });

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-roblox-"));
}

/** A clock that only moves when the code sleeps */
function clock() {
  let now = 1_700_000_000_000;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    advance: (ms: number) => (now += ms),
    slept,
  };
}

const INDEX_HTML = `<a href="/docs/reference/engine/classes/TweenService">x</a><a href="/docs/reference/engine/classes/AssetService"></a>
<a href="/docs/reference/engine/enums/KeyCode"></a><a href="/docs/reference/engine/datatypes/Color3"></a><a href="/docs/reference/engine/classes/TweenBase"></a>
<a href="/docs/reference/engine/libraries/task"></a><a href="/docs/reference/engine/classes/Tween"></a>`;

const ASSET_MD = `---
name: AssetService
---

# Class: AssetService

## Description

Asset queries.

## Properties

### Property: AssetService.AllowInsertFreeAssets

\`\`\`json
{
  "type": "boolean",
  "security": {
    "read": "RobloxScriptSecurity",
    "write": "RobloxScriptSecurity"
  }
}
\`\`\`

Changed in Game Settings.

### Property: AssetService.Open

\`\`\`json
{ "type": "int", "security": { "read": "None", "write": "None" } }
\`\`\`

## Methods

### Method: AssetService:LoadAssetAsync

**Signature:** \`AssetService:LoadAssetAsync(assetId: int): Model\`

*Security: None · Thread Safety: Unsafe*

### Method: AssetService:SavePlaceAsync

*Security: PluginSecurity · Thread Safety: Unsafe*

## Events
`;

test("docs: the type comes from the index, the page and the index are cached on disk, a section and the members' security come back", async () => {
  const dataDir = scratch();
  try {
    const time = clock();
    const web = fakeWeb((url) => {
      if (url.pathname === "/docs/reference/engine") return new Response(INDEX_HTML);
      if (url.pathname.endsWith("/classes/AssetService.md")) return md(ASSET_MD);
      if (url.pathname.endsWith("/enums/KeyCode.md")) return md("# Enum: KeyCode\n\n## Items\n");
      return md("not found", 404);
    });
    const env = robloxEnv(dataDir, { fetch: web.fetch, now: time.now, sleep: time.sleep });
    const page = await robloxDocs(env, { name: "AssetService" });
    assert.equal(page.type, "classes");
    assert.equal(page.url, "https://create.roblox.com/docs/reference/engine/classes/AssetService.md");
    assert.deepEqual(page.sections, ["Description", "Properties", "Methods", "Events"]);
    assert.equal(web.calls.find((c) => c.url.pathname.endsWith(".md"))!.init.headers.Accept, "text/markdown, text/plain");
    const { docsText } = await import("../control/roblox.js");
    const text = docsText(page);
    assert.match(text, /Security: 2 of 4 members need more than a game script/);
    assert.match(text, /AssetService\.AllowInsertFreeAssets \(property\): read RobloxScriptSecurity, write RobloxScriptSecurity/);
    assert.match(text, /AssetService:SavePlaceAsync \(method\): PluginSecurity/);
    assert.ok(!/LoadAssetAsync \(method\)/.test(text), "a member open to any script is not listed");

    const before = web.calls.length;
    const methods = await robloxDocs(env, { name: "assetservice", section: "methods" });
    assert.equal(web.calls.length, before, "the index and the page come from the disk cache");
    assert.equal(methods.name, "AssetService", "any case finds the page and names it as the engine does");
    assert.match(methods.text, /^## Methods\n/);
    assert.ok(!methods.text.includes("## Events"));
    assert.deepEqual(methods.security.map((m) => m.member), ["AssetService:LoadAssetAsync", "AssetService:SavePlaceAsync"]);
    await assert.rejects(robloxDocs(env, { name: "AssetService", section: "Nope" }), /has no section "Nope"; its sections: Description, Properties/);

    assert.equal((await robloxDocs(env, { name: "Enum.KeyCode" })).type, "enums");
    await assert.rejects(robloxDocs(env, { name: "../../etc" }), /name must be one reference page's name/);

    // A day later the page is fetched again
    time.advance(25 * 60 * 60 * 1000);
    await robloxDocs(env, { name: "AssetService", type: "classes" });
    assert.equal(web.calls.filter((c) => c.url.pathname.endsWith("AssetService.md")).length, 2);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("docs: a missing page answers the nearest names, its 404 is cached five minutes, and a long page stops at 50,000 characters with its sections", async () => {
  const dataDir = scratch();
  try {
    const time = clock();
    const long = `# Class: Big\n\n## Description\n\n${"word ".repeat(12_000)}\n\n## Properties\n\nmore\n`;
    const web = fakeWeb((url) => {
      if (url.pathname === "/docs/reference/engine") return new Response(INDEX_HTML);
      if (url.pathname.endsWith("/classes/Big.md")) return md(long);
      return md("nope", 404);
    });
    const env = robloxEnv(dataDir, { fetch: web.fetch, now: time.now, sleep: time.sleep });
    const missing = await robloxDocs(env, { name: "TweenServce", type: "classes" });
    assert.equal(missing.suggestions?.[0].name, "TweenService");
    assert.equal(missing.suggestions?.length, 5);
    await robloxDocs(env, { name: "TweenServce", type: "classes" });
    assert.equal(web.calls.filter((c) => c.url.pathname.endsWith("TweenServce.md")).length, 1, "the 404 is cached");
    time.advance(6 * 60 * 1000);
    await robloxDocs(env, { name: "TweenServce", type: "classes" });
    assert.equal(web.calls.filter((c) => c.url.pathname.endsWith("TweenServce.md")).length, 2, "for five minutes only");
    const notInIndex = await robloxDocs(env, { name: "Twen" });
    assert.ok(notInIndex.suggestions?.some((s) => s.name === "Tween"), "a name the index lacks gets suggestions without a page fetch");

    const big = await robloxDocs(env, { name: "Big", type: "classes" });
    assert.equal(big.truncated, true);
    assert.ok(big.text.length < 50_500);
    assert.match(big.text, /\[Cut at 50000 of \d+ characters: ask for one section to read it whole\. Sections: Description, Properties\]$/);

    assert.deepEqual(docSecurity("### Event: X.Changed\n\n*Security: None · Thread Safety: Safe*\n"), [{ member: "X.Changed", kind: "event", security: "None" }]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("search, details and thumbnail: Image searches Decals, Particle adds its words, Roblox-only sends user 1; a Pending thumbnail is asked again and saved as a PNG", async () => {
  const dataDir = scratch();
  try {
    const time = clock();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const store = {
      totalResults: 2,
      creatorStoreAssets: [
        { creator: { name: "Roblox", verified: true }, voting: { upVotePercent: 91, voteCount: 20000 }, creatorStoreProduct: { purchasePrice: { quantity: { significand: 0, exponent: 0 } } }, asset: { id: 47433, name: "Sword", description: `${"long ".repeat(80)}`, hasScripts: true, scriptCount: 2 } },
        { creator: { name: "Someone" }, creatorStoreProduct: { purchasePrice: { quantity: { significand: 3990000000, exponent: -9 } } }, asset: { id: 5, name: "Star", textureId: 6, description: " " } },
      ],
    };
    const web = fakeWeb((url, _init, n) => {
      if (url.pathname === "/toolbox-service/v2/assets:search") return json(store);
      if (url.pathname === "/toolbox-service/v2/assets/47433") return json(store.creatorStoreAssets[0]);
      if (url.pathname === "/v1/assets" && url.host === "thumbnails.roblox.com") {
        return json({ data: [n < 3 ? { targetId: 47433, state: "Pending" } : { targetId: 47433, state: "Completed", imageUrl: "https://tr.rbxcdn.com/x/420/420/Model/Png" }] });
      }
      if (url.host === "tr.rbxcdn.com") return new Response(png);
      return json({ title: "Not Found" }, 404);
    });
    const env = robloxEnv(dataDir, { fetch: web.fetch, now: time.now, sleep: time.sleep });
    const found = await searchAssets(env, { type: "Image", query: "star", robloxOnly: true });
    let sent = web.calls.at(-1)!.url.searchParams;
    assert.equal(sent.get("searchCategoryType"), "Decal");
    assert.equal(sent.get("userId"), "1");
    assert.equal(sent.get("maxPageSize"), "10");
    assert.equal(found.searchedAs, "Decal");
    assert.deepEqual(found.results[1], { assetId: 5, name: "Star", creator: "Someone", priceUsd: 3.99, imageId: 6, description: "" });
    assert.equal(found.results[0].scripts, 2);
    assert.equal(found.results[0].description.length, 240);
    await searchAssets(env, { type: "Particle", query: "fire" });
    sent = web.calls.at(-1)!.url.searchParams;
    assert.equal(sent.get("searchCategoryType"), "Model");
    assert.equal(sent.get("query"), "fire particle effect");
    await searchAssets(env, { type: "VFX", query: "fire effect" });
    assert.equal(web.calls.at(-1)!.url.searchParams.get("query"), "fire effect", "a query that already says effect is left alone");
    await assert.rejects(searchAssets(env, { type: "Car" }), /type must be one of/);
    await assert.rejects(searchAssets(env, { limit: 500 }), /limit must be a whole number from 1 to 100/);

    const shot = await assetThumbnail(env, { id: 47433 });
    assert.equal(web.calls.filter((c) => c.url.host === "thumbnails.roblox.com").length, 3, "asked again while Pending");
    assert.deepEqual(fs.readFileSync(shot.file), png);
    assert.equal(shot.file, path.join(dataDir, "thumbnails", "asset-47433-420x420.png"));
    await assert.rejects(assetThumbnail(env, { id: 47433, size: "64x64" }), /size must be one of/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

const KEY = "sk-secret-0123456789";

/** Open Cloud as Roblox runs it: POST makes an operation, GET answers it once it is done */
function openCloud(options: { postStatus?: number[]; pollsBeforeDone?: number; pollErrors?: number[]; throwPost?: boolean; neverDone?: boolean } = {}) {
  let posts = 0;
  let polls = 0;
  let nextAsset = 9000;
  const requests: any[] = [];
  const web = fakeWeb(async (url, init) => {
    if (url.pathname === "/assets/v1/assets" && init.method === "POST") {
      assert.equal(init.headers["x-api-key"], KEY);
      const status = options.postStatus?.[posts];
      posts++;
      if (options.throwPost) throw Object.assign(new Error("fetch failed"), { cause: new Error("socket hang up") });
      if (status && status !== 200) return new Response(`denied ${KEY}`, { status, headers: status === 429 ? { "retry-after": "1" } : {} });
      requests.push({ request: JSON.parse(String((init.body as FormData).get("request"))), file: (init.body as FormData).get("fileContent") });
      return json({ path: `operations/op${posts}`, operationId: `op${posts}`, done: false });
    }
    if (url.pathname.startsWith("/assets/v1/operations/")) {
      polls++;
      const error = options.pollErrors?.[polls - 1];
      if (error === -1) throw new Error("ECONNRESET");
      if (error) return new Response("busy", { status: error });
      if (options.neverDone || polls <= (options.pollsBeforeDone ?? 0)) return json({ done: false });
      return json({ done: true, response: { assetId: String(nextAsset++) } });
    }
    if (url.pathname.startsWith("/toolbox-service/v2/assets/")) return json({ asset: { id: 1, name: "Decal", textureId: 777 } });
    return json({}, 404);
  });
  return { web, requests, posts: () => posts, polls: () => polls };
}

function uploadEnv(dataDir: string, fetch: typeof globalThis.fetch, env: Record<string, string> = {}): RobloxEnv & { time: ReturnType<typeof clock> } {
  const time = clock();
  // As the hub runs it: the vault first, then a key in its own environment
  const apiKey = async () => (await new Vault(dataDir, fakeDpapi).get()) ?? env.ROBLOX_OPEN_CLOUD_API_KEY;
  return { ...robloxEnv(dataDir, { fetch, now: time.now, sleep: time.sleep, env, apiKey, dpapi: fakeDpapi }), time };
}

test("upload: the key and creator from open-cloud.env (the group wins), the same upload twice makes one asset, force makes another", async () => {
  const dataDir = scratch();
  try {
    const file = path.join(dataDir, "icon.png");
    fs.writeFileSync(file, "png bytes");
    const cloud = openCloud({ pollsBeforeDone: 2 });
    const env = uploadEnv(dataDir, cloud.web.fetch);
    await assert.rejects(uploadAsset(env, { file, assetType: "Decal", displayName: "Icon" }), new RegExp(`no Open Cloud key: .*${path.join(dataDir, "open-cloud.key").replace(/\\/g, "\\\\")}`));
    fs.writeFileSync(path.join(dataDir, "open-cloud.env"), `# Quack's Open Cloud\nROBLOX_OPEN_CLOUD_API_KEY="${KEY}"\nROBLOX_CREATOR_USER_ID=11\nROBLOX_CREATOR_GROUP_ID=22\n`);
    await assert.rejects(uploadAsset(env, { file, assetType: "Audio", displayName: "Icon" }), /an Audio is uploaded from \.mp3, \.ogg, \.wav, \.flac, not \.png/);

    const first = await uploadAsset(env, { file, assetType: "Decal", displayName: "Icon", description: "d" });
    assert.equal(first.assetId, "9000");
    // The plain key from before the vault moved into it on first use; the creator lines stay
    const envFile = fs.readFileSync(path.join(dataDir, "open-cloud.env"), "utf8");
    assert.ok(!envFile.includes(KEY) && envFile.includes("ROBLOX_CREATOR_USER_ID=11"), envFile);
    assert.ok(!fs.readFileSync(path.join(dataDir, "open-cloud.key"), "utf8").includes(KEY), "the vault holds no plain key");
    assert.equal(first.creator, "group 22");
    assert.deepEqual(cloud.requests[0].request, { assetType: "Decal", displayName: "Icon", description: "d", creationContext: { creator: { groupId: "22" } } });
    assert.equal(cloud.requests[0].file.type, "image/png");
    assert.equal(cloud.polls(), 3);

    const again = await uploadAsset(env, { file, assetType: "Decal", displayName: "Icon" });
    assert.equal(again.reused, "done");
    assert.equal(again.assetId, "9000");
    assert.equal(cloud.posts(), 1, "the same upload is not posted twice");
    const renamed = await uploadAsset(env, { file, assetType: "Decal", displayName: "Icon 2" });
    assert.equal(cloud.posts(), 2, "another name is another upload");
    assert.notEqual(renamed.assetId, "9000");
    const forced = await uploadAsset(env, { file, assetType: "Decal", displayName: "Icon", force: true });
    assert.equal(cloud.posts(), 3);
    assert.equal((await uploadAsset(env, { file, assetType: "Decal", displayName: "Icon" })).assetId, forced.assetId, "the log keeps the newest");

    const asUser = await uploadAsset({ ...env, env: { ROBLOX_CREATOR_GROUP_ID: "" } }, { file, assetType: "Decal", displayName: "Icon", userId: "33" });
    assert.equal(asUser.creator, "user 33", "a user given wins over the configured group");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("upload: a 429 on the POST is sent again, the poll waits out 429s, 5xx and dropped connections, and a poll past its deadline is resumed, not posted again", async () => {
  const dataDir = scratch();
  try {
    const file = path.join(dataDir, "song.mp3");
    fs.writeFileSync(file, "mp3 bytes");
    const env = { ROBLOX_OPEN_CLOUD_API_KEY: KEY, ROBLOX_CREATOR_USER_ID: "11" };
    const busy = openCloud({ postStatus: [429, 429], pollErrors: [429, 503, -1] });
    const result = await uploadAsset(uploadEnv(dataDir, busy.web.fetch, env), { file, assetType: "Audio", displayName: "Song" });
    assert.equal(busy.posts(), 3, "two refusals, then the upload");
    assert.equal(busy.requests.length, 1, "one asset made");
    assert.equal(result.assetId, "9000");
    assert.equal(busy.polls(), 4);

    const slow = openCloud({ neverDone: true });
    const slowEnv = uploadEnv(dataDir, slow.web.fetch, env);
    await assert.rejects(uploadAsset(slowEnv, { file, assetType: "Audio", displayName: "Slow" }), (error: any) => {
      assert.equal(error.pending, true);
      assert.match(error.message, /still processing on Roblox after 5 min \(operation op1\).*run the same upload again/);
      return true;
    });
    assert.ok(slowEnv.time.slept.every((ms) => ms <= 10_000), "backoff capped at 10 s");
    const log = JSON.parse(fs.readFileSync(path.join(dataDir, "uploads.json"), "utf8"));
    assert.equal(Object.values<any>(log.entries).find((e) => e.displayName === "Slow").state, "pending");
    const done = openCloud();
    const resumed = await uploadAsset(uploadEnv(dataDir, done.web.fetch, env), { file, assetType: "Audio", displayName: "Slow" });
    assert.equal(resumed.reused, "resumed");
    assert.equal(done.posts(), 0, "the known operation is polled, nothing posted");
    assert.equal(done.web.calls[0].url.pathname, "/assets/v1/operations/op1");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("upload: a POST with no answer is never sent again without force, a refusal is, and the key never shows", async () => {
  const dataDir = scratch();
  try {
    const file = path.join(dataDir, "a.png");
    fs.writeFileSync(file, "x");
    const env = { ROBLOX_OPEN_CLOUD_API_KEY: KEY, ROBLOX_CREATOR_USER_ID: "11" };
    const lost = openCloud({ throwPost: true });
    await assert.rejects(uploadAsset(uploadEnv(dataDir, lost.web.fetch, env), { file, assetType: "Decal", displayName: "A" }), /Roblox did not answer \(socket hang up\): it may still make the asset/);
    const retry = openCloud();
    await assert.rejects(uploadAsset(uploadEnv(dataDir, retry.web.fetch, env), { file, assetType: "Decal", displayName: "A" }), /no answer was kept \(socket hang up\): Roblox may have made the asset.*with force/);
    assert.equal(retry.posts(), 0);
    assert.equal((await uploadAsset(uploadEnv(dataDir, retry.web.fetch, env), { file, assetType: "Decal", displayName: "A", force: true })).assetId, "9000");

    const gateway = openCloud({ postStatus: [502] });
    await assert.rejects(uploadAsset(uploadEnv(dataDir, gateway.web.fetch, env), { file, assetType: "Decal", displayName: "B" }), /HTTP 502.*it may still make the asset/);
    await assert.rejects(uploadAsset(uploadEnv(dataDir, openCloud().web.fetch, env), { file, assetType: "Decal", displayName: "B" }), /no answer was kept \(HTTP 502\)/);

    const denied = openCloud({ postStatus: [403, 200] });
    const deniedEnv = uploadEnv(dataDir, denied.web.fetch, env);
    await assert.rejects(uploadAsset(deniedEnv, { file, assetType: "Decal", displayName: "C" }), (error: Error) => {
      assert.match(error.message, /Roblox refused the upload: HTTP 403 \(the key lacks asset:write, or this creator\) denied \*\*\*/);
      assert.ok(!error.message.includes(KEY), "the key is scrubbed from what Roblox echoed");
      return true;
    });
    assert.equal((await uploadAsset(deniedEnv, { file, assetType: "Decal", displayName: "C" })).assetId, "9000", "a refusal made nothing: the next try posts");

    // Through the command: no line printed, error or not, holds the key
    const lines: string[] = [];
    await withCloudHub(dataDir, openCloud({ postStatus: [401, 401] }).web.fetch, env, async (port) => {
      const run = async (...argv: string[]) => runControl(argv, {
        info: flavorInfo("dev"), client: new HubClient(port), out: (l) => lines.push(l), err: (l) => lines.push(l),
        confirm: async () => false, interactive: false, color: false, cwd: dataDir, openUri: async () => {},
        roblox: { dataDir, env: {}, sleep: async () => {} },
      });
      assert.equal(await run("asset", "upload", "a.png", "--type", "Decal", "--name", "D"), 1);
      assert.equal(await run("asset", "upload", "a.png", "--type", "Decal", "--name", "D", "--json"), 1);
    });
    assert.ok(lines.length >= 2);
    assert.match(lines.join("\n"), /HTTP 401/, "the hub's Roblox refusal reaches the command");
    assert.ok(lines.every((l) => !l.includes(KEY)), lines.join("\n"));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

test("asset upload: a Decal answers its image id from the Creator Store and remembers it; with neither the store nor a hub it says how to get it", async () => {
  const dataDir = scratch();
  try {
    fs.writeFileSync(path.join(dataDir, "icon.png"), "png");
    const env = { ROBLOX_OPEN_CLOUD_API_KEY: KEY, ROBLOX_CREATOR_USER_ID: "11" };
    // The upload runs in the hub (its key); the image id lookup in the command (the Creator Store)
    const run = async (fetch: typeof globalThis.fetch, ...argv: string[]) => {
      const out: string[] = [];
      let code = -1;
      await withCloudHub(dataDir, fetch, env, async (port) => {
        code = await runControl(argv, {
          info: flavorInfo("dev"), client: new HubClient(port), out: (l) => out.push(l), err: (l) => out.push(l),
          confirm: async () => false, interactive: false, color: false, cwd: dataDir, openUri: async () => {},
          roblox: { dataDir, fetch, env: {}, sleep: async () => {} },
        });
      });
      return { code, out: out.join("\n") };
    };
    const cloud = openCloud();
    const first = await run(cloud.web.fetch, "asset", "upload", "icon.png", "--type", "Decal", "--name", "Icon");
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /^Uploaded icon\.png as Decal "Icon" for user 11: asset 9000 \(operation op1\)\.\nImage id 777 \(rbxassetid:\/\/777\)/);
    const again = await run(fakeWeb(() => json({}, 500)).fetch, "asset", "upload", "icon.png", "--type", "Decal", "--name", "Icon", "--json");
    assert.equal(again.code, 0, again.out);
    assert.deepEqual([JSON.parse(again.out).reused, JSON.parse(again.out).imageId], ["done", "777"], "the image id was remembered: no web call needed");

    const noStore = openCloud();
    const lost = await run(async (input, init) => (String(input).includes("toolbox-service") ? json({}, 404) : noStore.web.fetch(input, init)), "asset", "upload", "icon.png", "--type", "Decal", "--name", "Other");
    assert.equal(lost.code, 0, lost.out);
    assert.match(lost.out, /The image id is not known yet \(.+\)\. With the place open in Studio, run the same upload again/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("mcp: get_roblox_docs, search_assets and get_asset_thumbnail run with no hub; a query starting with - stays the query; the thumbnail is an image block", { timeout: 15000 }, async () => {
  const dataDir = scratch();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]);
    const web = fakeWeb((url) => {
      if (url.pathname === "/docs/reference/engine") return new Response(INDEX_HTML);
      if (url.pathname.endsWith("/classes/AssetService.md")) return md(ASSET_MD);
      if (url.pathname === "/toolbox-service/v2/assets:search") return json({ totalResults: 0, creatorStoreAssets: [] });
      if (url.host === "thumbnails.roblox.com") return json({ data: [{ state: "Completed", imageUrl: "https://tr.rbxcdn.com/a" }] });
      if (url.host === "tr.rbxcdn.com") return new Response(png);
      return md("", 404);
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const answers = new Map<number, (m: any) => void>();
    let buffer = "";
    output.on("data", (chunk) => {
      buffer += chunk.toString();
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        answers.get(message.id)?.(message);
      }
    });
    const done = serveMcp(input, output, {
      info: { ...flavorInfo("dev"), port: await freePort() }, client: new HubClient(await freePort()), cwd: dataDir, openUri: async () => {},
      roblox: { dataDir, fetch: web.fetch },
    });
    let next = 1;
    const tool = (name: string, args: object): Promise<any> => {
      const id = next++;
      return new Promise((resolve) => {
        answers.set(id, (m) => resolve(m.result));
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      });
    };
    const docs = await tool("get_roblox_docs", { name: "AssetService", section: "Properties" });
    assert.equal(docs.isError, undefined, docs.content[0].text);
    assert.match(docs.content[0].text, /^https:\/\/create\.roblox\.com\/docs\/reference\/engine\/classes\/AssetService\.md\nSecurity: 1 of 2 members/);
    assert.match((await tool("get_roblox_docs", { name: "Nope" })).content[0].text, /No reference page .*Nearest:/);
    const search = await tool("search_assets", { query: "-sword", assetType: "Model" });
    assert.equal(search.isError, undefined, search.content[0].text);
    assert.equal(web.calls.at(-1)!.url.searchParams.get("query"), "-sword");
    assert.match((await tool("get_asset_details", { assetId: -3 })).content[0].text, /assetId must be a whole number above 0/);
    const thumb = await tool("get_asset_thumbnail", { assetId: 12 });
    assert.equal(thumb.isError, undefined, thumb.content[0].text);
    assert.match(thumb.content[0].text, /^Thumbnail of asset 12 \(420x420\), saved at .*asset-12-420x420\.png$/);
    assert.equal(thumb.content[1].type, "image");
    assert.deepEqual(Buffer.from(thumb.content[1].data, "base64"), png);
    const insert = await tool("insert_asset", { assetId: 5, position: { x: -10, y: 2.5, z: 0 } });
    assert.match(insert.content[0].text, /no hub answers/, "a negative position is a value, not an option; with no hub the place cannot be found");
    input.end();
    await done;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Review of 09/11/26: a short key is never shown whole, an unreadable file is never replaced, and
// the temporary file is a new one of its own (no leftovers)
test("cloud settings: a short key shows no end, an unreadable open-cloud.env is left alone, no temp file stays", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-cloud-review-"));
  try {
    const env = robloxEnv(dataDir, { env: {}, dpapi: fakeDpapi });
    const short = await saveCloudSettings(env, { key: "abcd1234" });
    assert.equal(short.hasKey, true);
    assert.equal(short.keyEnd, undefined, "8 characters: no end shown");
    assert.equal((await saveCloudSettings(env, { key: "0123456789abcdefWXYZ" })).keyEnd, "WXYZ");
    // Encrypted: no file holds the key; only a decrypt (the hub's) gives it back
    for (const f of fs.readdirSync(dataDir)) assert.ok(!fs.readFileSync(path.join(dataDir, f), "utf8").includes("0123456789abcdefWXYZ"), f);
    assert.equal(await new Vault(dataDir, fakeDpapi).get(), "0123456789abcdefWXYZ", "the hub decrypts it");
    assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp")), [], "no temporary file left");

    // A folder where the file goes: reading fails with something other than "not there"
    const blocked = path.join(dataDir, "blocked");
    fs.mkdirSync(path.join(blocked, "open-cloud.env"), { recursive: true });
    const blockedEnv = robloxEnv(blocked, { env: {}, dpapi: fakeDpapi });
    await assert.rejects(saveCloudSettings(blockedEnv, { key: "0123456789abcdefWXYZ" }), /could not be read, so it was left as it is/);
    assert.ok(fs.statSync(path.join(blocked, "open-cloud.env")).isDirectory(), "what was there stays");
    fs.rmSync(path.join(blocked, "open-cloud.key"), { force: true });
    assert.equal(cloudSettings(blockedEnv).hasKey, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud: a short saved key reads as saved, never as ending in undefined", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-cloud-short-"));
  try {
    await saveCloudSettings(robloxEnv(dataDir, { env: {}, dpapi: fakeDpapi }), { key: "abcd1234" });
    const out: string[] = [];
    await runControl(["cloud"], {
      info: flavorInfo("dev"), client: new HubClient(1), out: (l) => out.push(l), err: (l) => out.push(l),
      confirm: async () => false, interactive: false, color: false, cwd: dataDir, openUri: async () => {}, roblox: { dataDir, env: {} },
    });
    assert.match(out[0], /^Key saved, no creator: /);
    assert.ok(!out.join("\n").includes("undefined"));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// chrrxs's list_place_versions, and the download the Memória Roblox note did by hand (05/11/26):
// the Asset Delivery answer is a location, fetched without the key
test("place versions and download: the key goes to Open Cloud only, a version's .rbxl is checked and kept, a refusal names the permission", async () => {
  const dataDir = scratch();
  try {
    const rbxl = Buffer.concat([Buffer.from("<roblox!"), Buffer.alloc(100, 7)]);
    const web = fakeWeb((url, init) => {
      if (url.host === "apis.roblox.com" && url.pathname === "/assets/v1/assets/555/versions") {
        assert.equal(init.headers["x-api-key"], KEY);
        return json({ assetVersions: [{ path: "assets/555/versions/12", createTime: "2026-11-09T19:32:04.123Z", moderationResult: { moderationState: "Approved" } }, { path: "assets/555/versions/11", createTime: "2026-11-08T10:00:00Z" }], nextPageToken: "tok" });
      }
      if (url.pathname === "/assets/v1/assets/666/versions") return json({ code: "PERMISSION_DENIED", message: `bad key ${KEY}` }, 403);
      if (url.pathname === "/asset-delivery-api/v1/assetId/555/version/11") return json({ location: "https://cdn.example.com/place-11" });
      if (url.pathname === "/asset-delivery-api/v1/assetId/555") return json({ location: "https://cdn.example.com/not-a-place" });
      if (url.host === "cdn.example.com") {
        assert.equal(init.headers?.["x-api-key"], undefined, "the file's location never gets the key");
        return new Response(url.pathname === "/place-11" ? rbxl : Buffer.from("<html>nope</html>"));
      }
      throw new Error(`unexpected ${url}`);
    });
    const env = uploadEnv(dataDir, web.fetch);
    await assert.rejects(placeVersions(env, { placeId: 555 }), /no Open Cloud key: .*asset:read/);
    fs.writeFileSync(path.join(dataDir, "open-cloud.env"), `ROBLOX_OPEN_CLOUD_API_KEY=${KEY}\n`);

    const page = await placeVersions(env, { placeId: "555", limit: 2, pageToken: "abc" });
    assert.deepEqual(page.versions, [{ version: 12, createdAt: "2026-11-09T19:32:04.123Z", moderation: "Approved" }, { version: 11, createdAt: "2026-11-08T10:00:00Z" }]);
    assert.equal(page.nextPageToken, "tok");
    const asked = web.calls.at(-1)!.url;
    assert.deepEqual([asked.searchParams.get("maxPageSize"), asked.searchParams.get("pageToken")], ["2", "abc"]);
    await assert.rejects(placeVersions(env, { placeId: 555, limit: 99 }), /limit must be from 1 to 50/);
    const refused = await placeVersions(env, { placeId: 666 }).then(() => undefined, (e: Error) => e);
    assert.match(refused!.message, /Roblox refused the key \(HTTP 403.*It needs asset:read/);
    assert.ok(!refused!.message.includes(KEY), "the key never shows");

    const got = await downloadPlace(env, { placeId: 555, version: 11 });
    assert.equal(path.basename(path.dirname(got.file)), "places");
    assert.match(path.basename(got.file), /^555-v11-.*\.rbxl$/);
    assert.deepEqual(fs.readFileSync(got.file), rbxl);
    assert.equal(got.bytes, rbxl.length);
    await assert.rejects(downloadPlace(env, { placeId: 555 }), /the download is not a place file \(17 bytes starting "<html>no"\)/);
    await assert.rejects(downloadPlace(env, { placeId: 555, version: 11, out: "relative.rbxl" }), /out must be an absolute path/);
    const out = path.join(dataDir, "mine.rbxl");
    assert.equal((await downloadPlace(env, { placeId: 555, version: 11, out })).file, out);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// 09/11/26 (Ender: the AI must not reach the key at all): the key lives in the hub's process;
// the hub runs named operations only, and a write runs after the user's yes in a dialog
test("cloud: the CLI never holds the key, the hub runs only named operations, and a write waits for the user's yes", { timeout: 30000 }, async () => {
  const dataDir = scratch();
  try {
    await assert.rejects(placeVersions(robloxEnv(dataDir, { env: { ROBLOX_OPEN_CLOUD_API_KEY: KEY } }), { placeId: 1 }), /used only inside the Quack hub/, "a process with no vault access refuses, even with the key in its environment");
    let changed = 0;
    registerCloudOps({
      testWrite: { write: true, describe: (a) => ({ title: "Quack: test write", text: `change ${a.what}?` }), run: async () => ({ changed: ++changed }) },
    });
    const asked: string[] = [];
    let answer = false;
    await withCloudHub(dataDir, fakeWeb(() => json({}, 404)).fetch, {}, async (port) => {
      const client = new HubClient(port);
      assert.match((await client.post("/api/cloud", { op: "rawRequest", args: { url: "https://apis.roblox.com/anything" } })).error, /no cloud operation rawRequest/);
      const refused = await client.post("/api/cloud", { op: "testWrite", args: { what: "the entry" } });
      assert.match(refused.error, /did not approve testWrite.*nothing was changed/);
      assert.equal(changed, 0, "refused: the write never ran");
      answer = true;
      assert.deepEqual((await client.post("/api/cloud", { op: "testWrite", args: { what: "the entry" } })).result, { changed: 1 });
      assert.deepEqual(asked, ["Quack: test write|change the entry?", "Quack: test write|change the entry?"]);
      // No key saved: the operation says where the user puts one, never in chat
      assert.match((await client.post("/api/cloud", { op: "versions", args: { placeId: 5 } })).error, /no Open Cloud key: .*Settings.*never in chat/);
    }, async (q) => {
      asked.push(`${q.title}|${q.text}`);
      return answer;
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Phase 4 and 5 of the Open Cloud plan (09/11/26): DataStore reads free, writes after a dialog
// that lists what changes and a version the user saw; configs: draft free, publish gated
test("datastore and config: reads free, a save shows every changed field and fails if the game saved in between, a publish ships the draft it showed", { timeout: 30000 }, async () => {
  const dataDir = scratch();
  try {
    const saves: { url: URL; init: any }[] = [];
    let stored: any = { Coins: 10, Pets: { Count: 2 }, Name: "Ender" };
    let version = "08DC1.0000000001.08DC1.01";
    let gameSavesInBetween = false;
    const published: Record<string, unknown> = { Rate: 1, Event: "off" };
    let draftEntries: Record<string, unknown> | undefined;
    let publishedBody: any;
    const web = fakeWeb(async (url, init) => {
      assert.equal(init.headers["x-api-key"], KEY);
      const p = url.pathname;
      const v1 = "/datastores/v1/universes/77/standard-datastores";
      if (p === v1) return json({ datastores: [{ name: "PlayerData", createdTime: "2026-01-01T00:00:00Z" }], nextPageCursor: "c2" });
      if (p === `${v1}/datastore/entries`) return json({ keys: [{ scope: "global", key: "Player_1" }, { scope: "global", key: "Player_2" }] });
      if (p === `${v1}/datastore/entries/entry` && (init.method ?? "GET") === "GET") {
        if (url.searchParams.get("entryKey") === "Nobody") return json({}, 404);
        return new Response(JSON.stringify(stored), { headers: { "roblox-entry-version": version, "roblox-entry-version-created-time": "2026-11-09T10:00:00Z", "roblox-entry-userids": "[1]" } });
      }
      if (p === `${v1}/datastore/entries/entry` && init.method === "POST") {
        saves.push({ url, init });
        if (gameSavesInBetween) return new Response("PreconditionFailed", { status: 412 });
        stored = JSON.parse(init.body);
        version = "08DC1.0000000002.08DC1.01";
        return json({ version });
      }
      if (p === `${v1}/datastore/entries/entry/versions`) return json({ versions: [{ version, createdTime: "2026-11-09T10:00:00Z", contentLength: 40 }] });
      const repo = "/creator-configs-public-api/v1/configs/universes/77/repositories/InExperienceConfig";
      if (p === repo) return json({ entries: published, version: 21 });
      if (p === `${repo}/draft` && init.method === "PATCH") {
        draftEntries = { ...(draftEntries ?? {}), ...JSON.parse(init.body).entries };
        return json({ draftHash: "h1" });
      }
      if (p === `${repo}/draft`) return draftEntries ? json({ entries: draftEntries, draftHash: "h1" }) : json({}, 404);
      if (p === `${repo}/publish`) {
        publishedBody = JSON.parse(init.body);
        Object.assign(published, draftEntries);
        draftEntries = undefined;
        return json({ version: 22 });
      }
      if (p.includes(":overwrite")) throw new Error("draft:overwrite must never be called");
      return json({}, 404);
    });
    const asked: string[] = [];
    let yes = true;
    await withCloudHub(dataDir, web.fetch, { ROBLOX_OPEN_CLOUD_API_KEY: KEY }, async (port) => {
      const out: string[] = [];
      const run = async (...argv: string[]) => {
        out.length = 0;
        const code = await runControl(argv, {
          info: flavorInfo("dev"), client: new HubClient(port), out: (l) => out.push(l), err: (l) => out.push(l),
          confirm: async () => false, interactive: false, color: false, cwd: dataDir, openUri: async () => {}, roblox: { dataDir, env: {} },
        });
        return { code, text: out.join("\n") };
      };
      assert.match((await run("datastore", "stores", "--universe=77")).text, /^1 DataStore\(s\) in experience 77:\n  PlayerData\nMore: --cursor c2$/);
      assert.match((await run("datastore", "keys", "PlayerData", "--universe=77")).text, /2 key\(s\) in PlayerData:\n  Player_1\n  Player_2/);
      const fields = await run("datastore", "get", "PlayerData", "Player_1", "--universe=77", "--fields=Coins,Pets.Count");
      assert.equal(fields.code, 0, fields.text);
      assert.match(fields.text, /version 08DC1\.0000000001\.08DC1\.01, \d+ bytes.*users 1\n  Coins = 10\n  Pets\.Count = 2$/);
      assert.match((await run("datastore", "get", "PlayerData", "Nobody", "--universe=77")).text, /no such entry/);
      assert.equal(asked.length, 0, "reads ask nothing");

      // A save: the dialog lists each field that changes; the write carries the version shown
      const saved = await run("datastore", "set", "PlayerData", "Player_1", "--universe=77", '--value={"Coins":99,"Pets":{"Count":2},"Name":"Ender","Vip":true}');
      assert.equal(saved.code, 0, saved.text);
      assert.match(asked[0], /Save the DataStore entry PlayerData\/Player_1 in experience 77\?/);
      assert.match(asked[0], /Coins: 10 -> 99/);
      assert.match(asked[0], /Vip: \(none\) -> true/);
      assert.ok(!asked[0].includes("Name:"), "an unchanged field is not listed");
      assert.equal(saves[0].url.searchParams.get("matchVersion"), "08DC1.0000000001.08DC1.01");
      assert.ok(saves[0].init.headers["content-md5"], "Roblox checks the body's MD5");
      assert.equal(stored.Coins, 99);

      // The game saved between the dialog and the write: refused, nothing overwritten
      gameSavesInBetween = true;
      const raced = await run("datastore", "set", "PlayerData", "Player_1", "--universe=77", '--value={"Coins":1}');
      assert.equal(raced.code, 1);
      assert.match(raced.text, /changed after the user approved.*nothing was written/);
      gameSavesInBetween = false;

      // No: nothing is sent
      yes = false;
      const before = saves.length;
      const refused = await run("datastore", "delete", "PlayerData", "Player_1", "--universe=77");
      assert.equal(refused.code, 1);
      assert.match(refused.text, /did not approve dsDelete/);
      assert.equal(saves.length, before);
      yes = true;

      // Configs: the draft is free and merged, the publish ships the hash it showed
      assert.match((await run("config", "get", "--universe=77")).text, /version 21, 2 keys:\n  Rate = 1\n  Event = "off"/);
      const asksBefore = asked.length;
      assert.match((await run("config", "set", "--universe=77", '--value={"Event":"on"}')).text, /Merged Event into the draft \(not live/);
      assert.equal(asked.length, asksBefore, "a draft asks nothing");
      assert.match((await run("config", "draft", "--universe=77")).text, /A draft is pending \(1 change\(s\)[^\n]*\n  Event: "off" -> "on"/);
      const pub = await run("config", "publish", "--universe=77", "--message=event on");
      assert.equal(pub.code, 0, pub.text);
      assert.match(asked.at(-1)!, /Publish the configs draft to the live game \(experience 77[\s\S]*Event: "off" -> "on"[\s\S]*Message: event on/);
      assert.deepEqual(publishedBody, { draftHash: "h1", message: "event on", deploymentStrategy: "Immediate" });
      assert.match((await run("config", "publish", "--universe=77")).text, /has no configs draft: nothing to publish/);
      assert.ok(out.every((l) => !l.includes(KEY)));
    }, async (q) => {
      asked.push(`${q.title}\n${q.text}`);
      return yes;
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud check names what a missing permission leaves out; a cloud Luau run waits for the user's yes, polls its task and returns its output", { timeout: 30000 }, async () => {
  const dataDir = scratch();
  try {
    let created = 0;
    let polls = 0;
    const web = fakeWeb(async (url, init) => {
      if (url.pathname === "/api-keys/v1/introspect") {
        assert.equal(JSON.parse(init.body).apiKey, KEY, "the key goes to Roblox's check only");
        return json({ name: "Universe Write", enabled: true, expired: false, scopes: [{ name: "asset", operations: ["read", "write"] }, { name: "legacy-asset", operations: ["manage"] }, { name: "universe", operations: ["read", "write"], universeIds: ["*"] }] });
      }
      assert.equal(init.headers["x-api-key"], KEY);
      if (url.pathname === "/cloud/v2/universes/77/places/88/luau-execution-session-tasks" && init.method === "POST") {
        created++;
        assert.deepEqual(JSON.parse(init.body), { script: "print('hi') return 1 + 1", timeout: "60s" });
        return json({ path: "universes/77/places/88/luau-execution-sessions/s1/tasks/t1", state: "QUEUED" });
      }
      if (url.pathname === "/cloud/v2/universes/77/places/88/luau-execution-sessions/s1/tasks/t1") {
        polls++;
        return json(polls < 2 ? { state: "PROCESSING" } : { state: "COMPLETE", placeVersion: 85, output: { results: [2] } });
      }
      if (url.pathname === "/cloud/v2/universes/77/places/88/luau-execution-sessions/s1/tasks/t1/logs") return json({ luauExecutionSessionTaskLogs: [{ messages: ["hi"] }] });
      return json({}, 404);
    });
    let yes = false;
    const asked: string[] = [];
    await withCloudHub(dataDir, web.fetch, { ROBLOX_OPEN_CLOUD_API_KEY: KEY }, async (port) => {
      const out: string[] = [];
      const run = async (...argv: string[]) => {
        out.length = 0;
        const code = await runControl(argv, {
          info: flavorInfo("dev"), client: new HubClient(port), out: (l) => out.push(l), err: (l) => out.push(l),
          confirm: async () => false, interactive: false, color: false, cwd: dataDir, openUri: async () => {}, roblox: { dataDir, env: {} },
        });
        return { code, text: out.join("\n") };
      };
      const check = await run("cloud", "check");
      assert.equal(check.code, 0, check.text);
      assert.match(check.text, /^Key "Universe Write": enabled/);
      assert.match(check.text, /datastore reads: universe-datastores\.objects:list/);
      assert.match(check.text, /luau_run \(Luau in the cloud\): universe\.place\.luau-execution-session:write/);
      assert.ok(!check.text.includes(KEY));

      const refused = await run("luau", "88", "--universe=77", "--code=print('hi') return 1 + 1");
      assert.equal(refused.code, 1);
      assert.equal(created, 0, "no run without the user's yes");
      assert.match(asked[0], /run Luau in the cloud \(place 88\)[\s\S]*print\('hi'\) return 1 \+ 1/);
      yes = true;
      const ran = await run("luau", "88", "--universe=77", "--code=print('hi') return 1 + 1");
      assert.equal(ran.code, 0, ran.text);
      assert.match(ran.text, /^hi\n=> 2\n\(\d+ ms on place 88 version 85\)$/);
    }, async (q) => {
      asked.push(`${q.title}\n${q.text}`);
      return yes;
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Review of 09/11/26: nothing approved goes unseen (every change listed, attributes, the whole
// script), a delete checks the version the user saw, a read never replaces a file
test("cloud writes show everything they change: a long diff goes whole to a file, attributes are listed, a script the dialog cannot show is refused, a delete checks the version seen", { timeout: 30000 }, async () => {
  const dataDir = scratch();
  try {
    const big: Record<string, number> = {};
    for (let i = 0; i < 30; i++) big[`K${i}`] = i;
    let version = "v1";
    let deletes = 0;
    let deleteBumps = false;
    const web = fakeWeb(async (url, init) => {
      const p = url.pathname;
      const entry = "/datastores/v1/universes/77/standard-datastores/datastore/entries/entry";
      if (p === entry && (init.method ?? "GET") === "GET") {
        const answer = new Response(JSON.stringify(big), { headers: { "roblox-entry-version": version } });
        if (deleteBumps) version = "v2";
        return answer;
      }
      if (p === entry && init.method === "POST") return json({ version: "v9" });
      if (p === entry && init.method === "DELETE") {
        deletes++;
        return new Response("", { status: 204 });
      }
      return json({}, 404);
    });
    const asked: string[] = [];
    await withCloudHub(dataDir, web.fetch, { ROBLOX_OPEN_CLOUD_API_KEY: KEY }, async (port) => {
      const client = new HubClient(port);
      const call = (op: string, args: object) => client.post("/api/cloud", { op, args });
      const changed: Record<string, number> = {};
      for (let i = 0; i < 30; i++) changed[`K${i}`] = i + 100;
      const set = await call("dsSet", { universeId: 77, store: "S", key: "P", value: changed, attributes: { tier: "gold" }, userIds: [5] });
      assert.equal(set.error, undefined, set.error);
      const shown = asked.at(-1)!;
      // Every change in the window itself (it scrolls), none in a file the asker could edit
      assert.match(shown, /What changes \(30\):/);
      for (let i = 0; i < 30; i++) assert.ok(shown.includes(`K${i}: ${i} -> ${i + 100}`), `K${i} shown`);
      assert.ok(!fs.existsSync(path.join(dataDir, "approvals")), "no approval file");
      assert.match(shown, /attributes become: \{"tier":"gold"\}/);
      assert.match(shown, /user ids become: \[5\]/);
      // More than the window holds is refused, never cut
      const huge: Record<string, number> = {};
      for (let i = 0; i < 2001; i++) huge[`H${i}`] = i;
      assert.match((await call("dsSet", { universeId: 77, store: "S", key: "P", value: huge })).error, /more than the approval window can show whole \(over 2000 fields\): split it/);

      const longScript = Array.from({ length: 41 }, (_, i) => `print(${i})`).join("\n");
      assert.match((await call("luauRun", { universeId: 77, placeId: 88, script: longScript })).error, /41 lines.*the approval shows the whole script, so at most 40 lines/);
      assert.match((await call("luauRun", { universeId: 77, placeId: 88, script: "print('safe') --\u0000 hidden\nprint('x')" })).error, /hidden characters/);
      assert.match((await call("luauRun", { universeId: 77, placeId: 88, script: "print('a') -- ‮ evil" })).error, /hidden characters/);

      // The game saves between the dialog and the delete: refused, nothing deleted
      const asks = asked.length;
      deleteBumps = true;
      const raced = await call("dsDelete", { universeId: 77, store: "S", key: "P" });
      assert.match(raced.error, /changed after the user approved \(version v1 then, v2 now/);
      assert.equal(deletes, 0);
      assert.equal(asked.length, asks + 1);

      const out = path.join(dataDir, "taken.json");
      fs.writeFileSync(out, "mine");
      assert.match((await call("dsGet", { universeId: 77, store: "S", key: "P", out })).error, /already exists: give a new file/);
      assert.equal(fs.readFileSync(out, "utf8"), "mine");
      assert.match((await call("dsGet", { universeId: 77, store: "S", key: "P", out: path.join(dataDir, "x.txt") })).error, /a \.json file/);
    }, async (q) => {
      asked.push(`${q.title}\n${q.text}`);
      return true;
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Review of 09/11/26, round 2: a save keeps the entry's attributes and user ids; a busy window
// refuses before any Roblox call; hidden characters are shown; one decrypt for calls at once
test("a save keeps the attributes and user ids it does not change; a write while a window is open never reads Roblox; hidden characters are shown; calls at once share one decrypt", { timeout: 30000 }, async () => {
  const dataDir = scratch();
  try {
    const sent: any[] = [];
    let reads = 0;
    const web = fakeWeb(async (url, init) => {
      const entry = "/datastores/v1/universes/77/standard-datastores/datastore/entries/entry";
      if (url.pathname === entry && (init.method ?? "GET") === "GET") {
        reads++;
        return new Response(JSON.stringify({ Coins: 1 }), { headers: { "roblox-entry-version": "v1", "roblox-entry-attributes": "{\"tier\":\"gold\"}", "roblox-entry-userids": "[5]" } });
      }
      if (url.pathname === entry && init.method === "POST") {
        sent.push(init.headers);
        return json({ version: "v2" });
      }
      return json({}, 404);
    });
    let busy = false;
    const asked: string[] = [];
    const approve = Object.assign(async (q: { title: string; text: string }) => {
      asked.push(q.text);
      return true;
    }, { busy: () => busy });
    await withCloudHub(dataDir, web.fetch, { ROBLOX_OPEN_CLOUD_API_KEY: KEY }, async (port) => {
      const call = (op: string, args: object) => new HubClient(port).post("/api/cloud", { op, args });
      assert.equal((await call("dsSet", { universeId: 77, store: "S", key: "P", value: { Coins: 2 } })).error, undefined);
      assert.match(asked[0], /Its attributes stay: \{"tier":"gold"\}\nIts user ids stay: \[5\]/);
      assert.equal(sent[0]["roblox-entry-attributes"], "{\"tier\":\"gold\"}", "the attributes there are sent again, not cleared");
      assert.equal(sent[0]["roblox-entry-userids"], "[5]");

      busy = true;
      const readsBefore = reads;
      assert.match((await call("dsSet", { universeId: 77, store: "S", key: "P", value: { Coins: 3 } })).error, /another write is waiting for the user's answer/);
      assert.equal(reads, readsBefore, "refused before reading Roblox");
      busy = false;
    }, approve);

    const { revealHidden } = await import("../cloud/approve.js");
    assert.equal(revealHidden("a\u0000b‮c​d"), "a\\u{0000}b\\u{202E}c\\u{200B}d");

    let decrypts = 0;
    const counting: Dpapi = { protect: fakeDpapi.protect, unprotect: async (b) => { decrypts++; return fakeDpapi.unprotect(b); } };
    const v = new Vault(dataDir, counting);
    await v.set("0123456789abcdefWXYZ");
    const got = await Promise.all([v.get(), v.get(), v.get()]);
    assert.deepEqual(got, ["0123456789abcdefWXYZ", "0123456789abcdefWXYZ", "0123456789abcdefWXYZ"]);
    assert.equal(decrypts, 1, "one decrypt for three calls at once");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Review of 09/11/26, round 3: a key with a line break cannot fake a line, two writes at once
// read Roblox for one only, a configs publish always names the published keys the draft lacks
test("approval questions: a key's line break stays one line, two writes at once never both read Roblox, a publish names every published key the draft lacks", { timeout: 30000 }, async () => {
  const { changesForDialog } = await import("../cloud/http.js");
  const shown = changesForDialog({ ok: 1 }, { ok: 1, "x\n  Coins: 1 -> 2": 5 });
  assert.equal(shown.split("\n").length, 2, shown);
  assert.match(shown, /"x\\n  Coins: 1 -> 2": \(none\) -> 5/);

  const dataDir = scratch();
  try {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const web = fakeWeb(async (url) => {
      const repo = "/creator-configs-public-api/v1/configs/universes/77/repositories/InExperienceConfig";
      if (url.pathname === repo) return json({ entries: { A: 1, B: 2, C: 3, D: 4 }, version: 1 });
      if (url.pathname === `${repo}/draft`) return json({ entries: { A: 9 }, draftHash: "h" });
      if (url.pathname.endsWith("/datastore/entries/entry")) {
        reads++;
        await gate;
        return new Response("{}", { headers: { "roblox-entry-version": "v1" } });
      }
      return json({}, 404);
    });
    const asked: string[] = [];
    await withCloudHub(dataDir, web.fetch, { ROBLOX_OPEN_CLOUD_API_KEY: KEY }, async (port) => {
      const call = (op: string, args: object) => new HubClient(port).post("/api/cloud", { op, args });
      const first = call("dsSet", { universeId: 77, store: "S", key: "P", value: { a: 1 } });
      await new Promise((r) => setTimeout(r, 100));
      const second = await call("dsSet", { universeId: 77, store: "S", key: "Q", value: { a: 2 } });
      assert.match(second.error, /another write is waiting/);
      assert.equal(reads, 1, "the second write never read Roblox");
      release();
      assert.match((await first).error, /did not approve dsSet/, "the first one reached the user (who said No here)");
      // The slot is free again once the first write ends
      assert.match((await call("dsSet", { universeId: 77, store: "S", key: "Q", value: { a: 2 } })).error, /did not approve dsSet/);

      await call("configPublish", { universeId: 77 });
      assert.match(asked.at(-1)!, /The draft lacks 3 published key\(s\).*REMOVES them: "B", "C", "D"/);
    }, async (q) => {
      asked.push(q.text);
      return false;
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------
// The jobs of ~/.claude/scripts/roblox-cloud.mjs and Anime Astral's analytics-query.mjs and
// loc-check.mjs, now operations the hub runs (src/cloud/economy.ts, localization.ts,
// analytics.ts). Everything against a fake Roblox: a badge, a product and a pass can never be
// deleted and a badge past the quota costs Robux, so nothing here ever reaches the real one.

const UNIVERSE = "10771103861";

/** Roblox as the scripts met it: public games and badges APIs (no key), the rest with the key */
function fakeRoblox() {
  const state = {
    free: 3,
    owner: { type: "Group", name: "Taverna", id: 77 },
    badges: [{ id: 1, name: "Old", enabled: true, iconImageId: 10 }, { id: 2, name: "Older", enabled: false, iconImageId: 11 }],
    products: [{ productId: 31, name: "Bundle", priceInformation: { defaultPriceInRobux: 799 }, isForSale: true }, { productId: 32, name: "Coins", priceInformation: { defaultPriceInRobux: 50 }, isForSale: false }],
    passes: [{ gamePassId: 41, name: "VIP", priceInformation: { defaultPriceInRobux: 199 }, isForSale: true, iconAssetId: 5 }],
    entries: [] as any[],
    langs: { pt: true, de: true, ja: false } as Record<string, boolean>,
    /** loc PATCHes: answered 429 first this many times */
    locThrottle: 0,
    analyticsPolls: 0,
    /** A create whose answer is cut off after its headers */
    cutBody: false,
    /** The badge listing gives the same cursor on every page */
    loopCursor: false,
  };
  const writes: { what: string; fields: Record<string, string>; files: string[] }[] = [];
  const patches: any[] = [];
  const formFields = (body: FormData) => {
    const fields: Record<string, string> = {};
    const files: string[] = [];
    for (const [k, v] of body.entries()) {
      if (typeof v === "string") fields[k] = v;
      else files.push(`${k}:${(v as File).name}`);
    }
    return { fields, files };
  };
  const web = fakeWeb(async (url, init) => {
    const key = init.headers?.["x-api-key"];
    const method = init.method ?? "GET";
    if (url.host === "games.roblox.com" || url.host === "badges.roblox.com") {
      assert.equal(key, undefined, `the key never goes to the public ${url.host}`);
      if (url.host === "games.roblox.com") {
        const id = url.searchParams.get("universeIds");
        return json({ data: id === UNIVERSE || id === "666" ? [{ name: id === "666" ? "Other" : "PA Test", rootPlaceId: 138530444532741, creator: state.owner }] : [] });
      }
      if (url.pathname.endsWith("/free-badges-quota")) return new Response(String(state.free));
      if (url.pathname === `/v1/universes/${UNIVERSE}/badges`) {
        const page = url.searchParams.get("cursor") ? 1 : 0;
        return json({ data: [state.badges[page]], nextPageCursor: state.loopCursor || page === 0 ? "c2" : null });
      }
    }
    assert.equal(url.host, "apis.roblox.com");
    if (url.pathname.includes("/666/")) return new Response(`{"message":"bad key ${KEY}"}`, { status: 403 });
    assert.equal(key, KEY, `${method} ${url.pathname} carries the key`);
    if (url.pathname === `/legacy-badges/v1/universes/${UNIVERSE}/badges` && method === "POST") {
      writes.push({ what: "badge", ...formFields(init.body) });
      return json({ id: 555, name: (init.body as FormData).get("name"), enabled: true, iconImageId: 0 });
    }
    if (url.pathname === "/legacy-publish/v1/badges/555/icon") {
      writes.push({ what: "badge icon", ...formFields(init.body) });
      return json({ targetId: 999 });
    }
    for (const [segment, list, field, base] of [["developer-products", state.products, "developerProducts", "/developer-products/v2"], ["game-passes", state.passes, "gamePasses", "/game-passes/v1"]] as const) {
      const root = `${base}/universes/${UNIVERSE}/${segment}`;
      if (url.pathname === `${root}/creator`) {
        const page = url.searchParams.get("pageToken") ? 1 : 0;
        return json({ [field]: list.slice(page, page + 1), nextPageToken: page === 0 && list.length > 1 ? "p2" : "" });
      }
      if (url.pathname.startsWith(`${root}/`) && url.pathname.endsWith("/creator")) return json(list[0]);
      if (url.pathname === root && method === "POST") {
        const form = formFields(init.body);
        writes.push({ what: `${segment} create`, ...form });
        if (state.cutBody) return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); c.error(new Error("socket hang up")); } }), { status: 200 });
        const id = segment === "game-passes" ? { gamePassId: 42 } : { productId: 33 };
        return json({ ...id, name: form.fields.name, priceInformation: { defaultPriceInRobux: Number(form.fields.price) }, isForSale: form.fields.isForSale === "true" });
      }
      if (url.pathname.startsWith(`${root}/`) && method === "PATCH") {
        writes.push({ what: `${segment} update ${url.pathname.split("/").pop()}`, ...formFields(init.body) });
        return new Response("", { status: 200 });
      }
    }
    if (url.pathname === `/legacy-localization-tables/v1/autolocalization/games/${UNIVERSE}/autolocalizationtable`) {
      return json({ autoLocalizationTableId: "t1", sourceLanguage: "en", isAutolocalizationEnabled: true, isAutomaticEntriesSettingEnabled: false, isAutomaticEntriesDeletionEnabled: false, shouldUseLocalizationTable: true });
    }
    if (url.pathname === "/legacy-localization-tables/v1/localization-table/tables/t1/entries") {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      return json({ data: state.entries.slice(start, start + 100), nextPageCursor: start + 100 < state.entries.length ? String(start + 100) : null });
    }
    if (url.pathname === "/legacy-localization-tables/v1/localization-table/tables/t1" && method === "PATCH") {
      if (state.locThrottle > 0) {
        state.locThrottle--;
        return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
      }
      const body = JSON.parse(init.body);
      patches.push(body);
      for (const e of body.entries) {
        const i = state.entries.findIndex((x) => x.identifier.source === e.identifier.source);
        if (e.delete) state.entries.splice(i, 1);
        else if (i < 0) state.entries.push({ identifier: e.identifier, translations: e.translations });
      }
      return json({ failedEntriesAndTranslations: [] });
    }
    if (url.pathname === "/legacy-localization-tables/v1/localization-table/tables/t1/entries/translation-history") {
      const body = JSON.parse(init.body);
      return json({ entries: [{ history: body.locale === "pt" ? [{ translationText: "Sorte", translator: { agentType: "Automation" }, created: "2026-11-01" }] : [] }] });
    }
    const i18n = `/legacy-game-internationalization/v1/supported-languages/games/${UNIVERSE}`;
    if (url.pathname === `${i18n}/automatic-translation-status`) return json({ data: Object.entries(state.langs).map(([languageCode, on]) => ({ languageCode, isAutomaticTranslationEnabled: on })) });
    const lang = new RegExp(`^${i18n}/languages/([a-z-]+)/automatic-translation-status$`).exec(url.pathname);
    if (lang && method === "PATCH") {
      state.langs[lang[1]] = JSON.parse(init.body);
      patches.push({ lang: lang[1], on: state.langs[lang[1]] });
      return json({ isAutomaticTranslationEnabled: state.langs[lang[1]] });
    }
    if (url.pathname === `/analytics-query-api/v1/universes/${UNIVERSE}/metrics` && method === "POST") {
      patches.push({ analytics: JSON.parse(init.body) });
      return json({ done: false, path: `v1/universes/${UNIVERSE}/operations/q1` });
    }
    if (url.pathname === `/analytics-query-api/v1/universes/${UNIVERSE}/operations/q1`) {
      state.analyticsPolls++;
      return json(state.analyticsPolls < 2 ? { done: false, path: `v1/universes/${UNIVERSE}/operations/q1` } : { done: true, response: { values: [{ date: "2026-11-08", value: 1234 }] } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  return { state, web, writes, patches };
}

/** A real hub on the fake Roblox with the key in its environment; the CLI run against it */
async function cloudCli(dataDir: string, roblox: ReturnType<typeof fakeRoblox>, approve: (q: { title: string; text: string }) => Promise<boolean>, body: (run: (...argv: string[]) => Promise<{ code: number; out: string }>, client: HubClient) => Promise<void>) {
  await withCloudHub(dataDir, roblox.web.fetch, { ROBLOX_OPEN_CLOUD_API_KEY: KEY }, async (port) => {
    const client = new HubClient(port);
    const run = async (...argv: string[]) => {
      const out: string[] = [];
      const code = await runControl(argv, {
        info: flavorInfo("dev"), client, out: (l) => out.push(l), err: (l) => out.push(l),
        confirm: async () => false, interactive: false, color: false, cwd: dataDir, openUri: async () => {},
        roblox: { dataDir, fetch: roblox.web.fetch, env: {}, sleep: async () => {} },
      });
      const text = out.join("\n");
      assert.ok(!text.includes(KEY), `the key never shows: ${argv.join(" ")}`);
      return { code, out: text };
    };
    await body(run, client);
  }, approve);
}

test("badges: past the free quota nothing runs without --spend, the cost goes as expectedCost, the owner pays, a No or a quota that moved makes nothing", { timeout: 30000 }, async () => {
  const dataDir = scratch();
  try {
    fs.writeFileSync(path.join(dataDir, "medal.png"), "png");
    const roblox = fakeRoblox();
    const asked: string[] = [];
    let answer: boolean | (() => boolean) = false;
    await cloudCli(dataDir, roblox, async (q) => {
      asked.push(`${q.title}\n${q.text}`);
      return typeof answer === "function" ? answer() : answer;
    }, async (run, client) => {
      const u = (await client.post("/api/cloud", { op: "universe", args: { universeId: UNIVERSE } })).result;
      assert.deepEqual([u.name, u.rootPlaceId, u.creator.type, u.creator.name], ["PA Test", 138530444532741, "Group", "Taverna"]);
      assert.match((await run("badge", "quota", UNIVERSE)).out, /Free badges left today in universe 10771103861: 3 \(past them, 100 Robux each\)/);
      assert.equal((await run("badge", "list", UNIVERSE)).out, "1 | Old | enabled=true | icon 10\n2 | Older | enabled=false | icon 11", "both pages");

      (roblox.state as any).free = "";
      assert.match((await run("badge", "quota", UNIVERSE)).out, /the free badge quota of universe 10771103861 is not a number/, "an empty answer is not a spent quota");

      // Quota at 0: refused before any dialog, nothing sent
      roblox.state.free = 0;
      const broke = await run("badge", "create", UNIVERSE, "--name", "World 22");
      assert.equal(broke.code, 1);
      assert.match(broke.out, /No free badge is left today .* 100 Robux\. Pass --spend/);
      assert.equal(asked.length, 0, "no dialog");
      assert.equal(roblox.writes.length, 0, "nothing sent");
      // The hub itself refuses 100 Robux without spend, before its dialog, whoever calls it
      assert.match((await client.post("/api/cloud", { op: "badge.create", args: { universeId: UNIVERSE, name: "X", expectedCost: 100 } })).error, /needs spend/);
      assert.match((await client.post("/api/cloud", { op: "badge.create", args: { universeId: UNIVERSE, name: "X", expectedCost: 7, spend: true } })).error, /expectedCost must be 0/);
      assert.match((await client.post("/api/cloud", { op: "badge.create", args: { universeId: UNIVERSE, name: "X", expectedCost: 0, icon: path.join(dataDir, "nope.png") } })).error, /cannot read .*nope.png/);
      assert.match((await client.post("/api/cloud", { op: "product.create", args: { universeId: UNIVERSE, name: "X", price: 5, image: "relative.png" } })).error, /image must be an absolute path/);
      fs.writeFileSync(path.join(dataDir, "big.png"), "");
      fs.truncateSync(path.join(dataDir, "big.png"), 21 * 1024 * 1024);
      assert.match((await client.post("/api/cloud", { op: "badge.create", args: { universeId: UNIVERSE, name: "X", expectedCost: 0, icon: path.join(dataDir, "big.png") } })).error, /big\.png is 21 MB: an image here is at most 20 MB/);
      assert.equal(asked.length, 0, "a bad file never opens the dialog");
      roblox.state.loopCursor = true;
      assert.match((await run("badge", "list", UNIVERSE)).out, /the badges of universe 10771103861: Roblox gave the same page cursor twice, stopped/);
      roblox.state.loopCursor = false;

      // --spend: the dialog says the price and who pays; a No sends nothing
      const no = await run("badge", "create", UNIVERSE, "--name", "World 22", "--spend");
      assert.equal(no.code, 1);
      assert.match(no.out, /did not approve badge\.create.*nothing was changed/);
      assert.match(asked[0], /^Quack: create a badge for 100 Robux\nCreate the badge "World 22" in universe 10771103861 \("PA Test"\) \(no icon.*\nCost: 100 Robux, from the owner's funds.*\n\nA badge can never be deleted, only disabled\. Make it in the published game's universe/);
      assert.equal(roblox.writes.length, 0);
      answer = true;
      const paid = await run("badge", "create", UNIVERSE, "--name", "World 22", "--spend", "--description=-beat it");
      assert.equal(paid.code, 0, paid.out);
      assert.match(paid.out, /^Created badge 555 "World 22" in PA Test .*cost 100 Robux \(paid by group Taverna; 0 free before\)/);
      assert.deepEqual(roblox.writes[0].fields, { name: "World 22", description: "-beat it", paymentSourceType: "2", expectedCost: "100", isActive: "true" });

      // Free: expectedCost 0, the user owner pays nothing, the icon goes as `files`
      roblox.state.free = 2;
      roblox.state.owner = { type: "User", name: "Ender", id: 9 };
      const free = await run("badge", "create", UNIVERSE, "--name", "World 23", "--icon", "medal.png");
      assert.equal(free.code, 0, free.out);
      assert.match(asked.at(-1)!, /with the icon .*medal\.png\.\nCost: free/);
      assert.deepEqual([roblox.writes[1].fields.expectedCost, roblox.writes[1].fields.paymentSourceType, roblox.writes[1].files], ["0", "1", ["files:medal.png"]]);

      // The quota spent while the dialog was open: the free badge approved is not made for 100
      answer = () => {
        roblox.state.free = 0;
        return true;
      };
      roblox.state.free = 1;
      const moved = await run("badge", "create", UNIVERSE, "--name", "World 24");
      assert.equal(moved.code, 1);
      assert.match(moved.out, /the free badge quota changed since the dialog \(0 free now, so it would cost 100 Robux, not the 0 approved\): nothing was made/);
      assert.equal(roblox.writes.length, 2);

      answer = true;
      const icon = await run("badge", "icon", "555", "medal.png");
      assert.equal(icon.out, "Badge 555: icon image 999.");
      assert.deepEqual(roblox.writes[2].files, ["Files:medal.png"], "the icon endpoint takes Files");
      assert.match(asked.at(-1)!, /Replace the icon of badge 555 with .*medal\.png/);
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("products and passes: pages read through, create puts a product on sale and a pass where asked, update sends only what changes, a No or a wrong game makes nothing, a refusal names the permission", { timeout: 30000 }, async () => {
  const dataDir = scratch();
  try {
    fs.writeFileSync(path.join(dataDir, "box.png"), "png");
    const roblox = fakeRoblox();
    const asked: string[] = [];
    let answer = false;
    await cloudCli(dataDir, roblox, async (q) => {
      asked.push(`${q.title}\n${q.text}`);
      return answer;
    }, async (run, client) => {
      assert.equal((await run("product", "list", UNIVERSE)).out, "31 | Bundle | 799 R$ | forSale=true\n32 | Coins | 50 R$ | forSale=false");
      assert.equal((await run("gamepass", "list", UNIVERSE)).out, "41 | VIP | 199 R$ | forSale=true | icon=5");
      assert.equal(JSON.parse((await run("product", "get", UNIVERSE, "31")).out).productId, 31);

      const no = await run("product", "create", UNIVERSE, "--name", "Update 18 Bundle", "--price", "799", "--image", "box.png");
      assert.equal(no.code, 1);
      assert.equal(roblox.writes.length, 0, "a No never reaches Roblox");
      assert.match(asked[0], /^Quack: create a developer product\nCreate the developer product "Update 18 Bundle" in universe 10771103861 \("PA Test"\):\n  name "Update 18 Bundle"\n  price 799 Robux\n  on sale: players can buy it as soon as this runs\n  image .*box\.png\n\nA developer product can never be deleted, only taken off sale/);

      answer = true;
      const made = await run("product", "create", UNIVERSE, "--name", "Update 18 Bundle", "--price", "799", "--image", "box.png");
      assert.equal(made.code, 0, made.out);
      assert.match(made.out, /^Created developer product 33 \| Update 18 Bundle \| 799 R\$ \| forSale=true in PA Test\./);
      assert.deepEqual(roblox.writes[0], { what: "developer-products create", fields: { name: "Update 18 Bundle", price: "799", isForSale: "true" }, files: ["imageFile:box.png"] });
      assert.match((await run("product", "create", UNIVERSE, "--name", "X", "--price", "5", "--for-sale", "false")).out, /made on sale/);

      // A pass can start off sale; an update sends only what was given (never isForSale by itself)
      const pass = await run("gamepass", "create", UNIVERSE, "--name", "Big Queue", "--price", "199", "--for-sale", "false");
      assert.equal(pass.code, 0, pass.out);
      assert.equal(roblox.writes[1].fields.isForSale, "false");
      assert.match(asked.at(-1)!, /  off sale\n/);
      const update = await run("product", "update", UNIVERSE, "31", "--price", "899");
      assert.equal(update.out, "Updated developer product 31 in PA Test.");
      assert.deepEqual(roblox.writes[2], { what: "developer-products update 31", fields: { price: "899" }, files: [] });
      assert.match(asked.at(-1)!, /^Quack: change a developer product\nChange developer product 31 in universe 10771103861 \("PA Test"\):\n  price 899 Robux$/);
      assert.match((await run("gamepass", "update", UNIVERSE, "41")).out, /nothing to change/);

      // A price or a name the dialog cannot show right never reaches it
      const asks = asked.length;
      for (const price of [true, "", null, "12abc", -1]) {
        assert.match((await client.post("/api/cloud", { op: "product.create", args: { universeId: UNIVERSE, name: "X", price } })).error, /price (is required|must be a whole number)/, `price ${JSON.stringify(price)}`);
      }
      assert.match((await client.post("/api/cloud", { op: "product.update", args: { universeId: UNIVERSE, id: 31, name: "" } })).error, /name is required/);
      assert.equal(asked.length, asks);

      // An answer cut off after its headers is not a success: the product may exist
      roblox.state.cutBody = true;
      const cut = await run("product", "create", UNIVERSE, "--name", "Cut", "--price", "5");
      assert.equal(cut.code, 1);
      assert.match(cut.out, /the new developer product "Cut": Roblox's answer \(HTTP 200\) was cut off .*It may still have been done: read it back \(list\) before sending it again/);
      roblox.state.cutBody = false;

      // The dialog's game name is checked again before the write: a caller's claim is not trusted
      const before = roblox.writes.length;
      const lie = await client.post("/api/cloud", { op: "product.create", args: { universeId: UNIVERSE, universeName: "Anime Astral", name: "X", price: 5 } });
      assert.match(lie.error, /universe 10771103861 is "PA Test", not "Anime Astral" as the dialog said: nothing was changed/);
      assert.equal(roblox.writes.length, before);

      // A refusal names the permission and never shows the key it echoed
      const refused = await run("product", "list", "666");
      assert.equal(refused.code, 1);
      assert.match(refused.out, /Roblox refused the key \(HTTP 403.*It needs developer-product:read/);
      assert.match((await run("gamepass", "create", "666", "--name", "P", "--price", "1")).out, /It needs game-pass:write/);
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("loc: push adds only what the table lacks in batches of 50 and waits out a 429, delete and translate ask first, a file with problems never opens the dialog, dry runs ask nothing", { timeout: 30000 }, async () => {
  const dataDir = scratch();
  try {
    const roblox = fakeRoblox();
    roblox.state.entries = Array.from({ length: 130 }, (_, i) => ({ identifier: { key: "", context: "", source: `Have ${i}` }, translations: i < 100 ? [{ locale: "pt", translationText: "x" }] : [] }));
    const strings = [...Array.from({ length: 10 }, (_, i) => `Have ${i}`), ...Array.from({ length: 120 }, (_, i) => `New ${i}`), "123", "x".repeat(301), "New 0"];
    fs.writeFileSync(path.join(dataDir, "strings.json"), JSON.stringify(strings));
    const asked: string[] = [];
    let answer = true;
    await cloudCli(dataDir, roblox, async (q) => {
      asked.push(`${q.title}\n${q.text}`);
      return answer;
    }, async (run, client) => {
      assert.match((await run("loc", "info", UNIVERSE)).out, /^table t1 \| 130 entries of 10,000 \| 30 with no translation yet \| source en\n  auto-localization true/);

      const dry = await run("loc", "push", UNIVERSE, "strings.json", "--dry-run");
      assert.equal(dry.code, 0, dry.out);
      assert.match(dry.out, /^table read: 130 entries\n131 strings \| 10 already in the table \| 120 to add \| 1 over 300 characters \(skipped\)\n  too long: x{80} \(301\)$/);
      assert.equal(asked.length, 0, "a dry run asks nothing");

      answer = false;
      assert.equal((await run("loc", "push", UNIVERSE, "strings.json")).code, 1);
      assert.match(asked[0], /^Quack: add strings to a localization table\nAdd 120 English strings from .*strings\.json \(131 in the file\) to the localization table of universe 10771103861, with no translation\.\nRoblox's automatic translation then fills each language that has it on, spending/);
      assert.equal(roblox.patches.length, 0);

      answer = true;
      roblox.state.locThrottle = 1;
      const pushed = await run("loc", "push", UNIVERSE, "strings.json");
      assert.equal(pushed.code, 0, pushed.out);
      assert.match(pushed.out, /sent 120, failed 0 \| 130 entries before the push/);
      assert.deepEqual(roblox.patches.map((p) => p.entries.length), [50, 50, 20], "batches of 50; the 429 was waited out, not counted twice");
      assert.deepEqual(roblox.patches[0].entries[0], { identifier: { key: "", context: "", source: "New 0" }, translations: [] });
      assert.equal((await run("loc", "push", UNIVERSE, "strings.json")).out.split("\n").at(-1), "Nothing to add.");

      // Approved for N: a table that lost entries while the dialog was open is planned again
      answer = false;
      roblox.state.entries.splice(0, 5);
      const before = roblox.patches.length;
      const stale = await cloudOp(client, "loc.push", { universeId: UNIVERSE, file: path.join(dataDir, "strings.json"), expected: 0 });
      assert.match(stale, /did not approve/);
      answer = true;
      assert.match(await cloudOp(client, "loc.push", { universeId: UNIVERSE, file: path.join(dataDir, "strings.json"), expected: 0 }), /the table now lacks 5 of these strings, more than the 0 approved: nothing was sent/);
      assert.equal(roblox.patches.length, before);

      // Only strings: an object or a number in the file is not a source to publish
      fs.writeFileSync(path.join(dataDir, "nums.json"), JSON.stringify([1, "a", { b: 2 }]));
      assert.match((await run("loc", "push", UNIVERSE, "nums.json", "--dry-run")).out, /nums\.json must hold a JSON array of strings/);

      // Delete: dry run, then the dialog says there is no undo
      fs.writeFileSync(path.join(dataDir, "gone.json"), JSON.stringify(["New 1", "New 2", "Not there"]));
      assert.equal((await run("loc", "delete", UNIVERSE, "gone.json", "--dry-run")).out, "3 sources asked | 2 found in the table of 245");
      const deleted = await run("loc", "delete", UNIVERSE, "gone.json");
      assert.match(deleted.out, /deleted 2, failed 0/);
      assert.match(asked.at(-1)!, /^Quack: delete localization entries\nDelete 2 entries .*There is no undo/s);
      assert.deepEqual(roblox.patches.at(-1).entries, [{ identifier: { key: "", context: "", source: "New 1" }, delete: true }, { identifier: { key: "", context: "", source: "New 2" }, delete: true }]);
      // The game's name a dialog showed is checked before a localization write too
      const patchesBefore = roblox.patches.length;
      fs.writeFileSync(path.join(dataDir, "gone2.json"), JSON.stringify(["New 3"]));
      assert.match(await cloudOp(client, "loc.delete", { universeId: UNIVERSE, universeName: "Anime Astral", file: path.join(dataDir, "gone2.json"), expected: 1 }), /universe 10771103861 is "PA Test", not "Anime Astral" as the dialog said/);
      assert.equal(roblox.patches.length, patchesBefore);

      // Translate: the file is checked first; a problem stops it before any dialog
      fs.writeFileSync(path.join(dataDir, "bad.json"), JSON.stringify({ "Win {number1} <b>Gems</b> ! Codes: ASTRAL": { pt: "Ganhe {number2} <b>Gemas</b> ! Códigos: ASTRA", es: "" } }));
      const asks = asked.length;
      const bad = await run("loc", "translate", UNIVERSE, "bad.json", "--locales", "pt,es,fr");
      assert.equal(bad.code, 1);
      for (const problem of ["[fr]: missing", "[pt]: placeholders differ", "[pt]: redeem code ASTRAL changed", "[es]: empty"]) assert.ok(bad.out.includes(problem), `${problem} in\n${bad.out}`);
      assert.match(bad.out, /Nothing was sent: fix the file/);
      assert.equal(asked.length, asks, "no dialog for a bad file");
      assert.match(await cloudOp(client, "loc.translate", { universeId: UNIVERSE, file: path.join(dataDir, "bad.json") }), /problems in .*bad\.json, nothing was sent/, "the hub checks it too");
      assert.equal(asked.length, asks);
      assert.equal((await run("loc", "lint", "bad.json")).code, 1);
      // --unchecked passes content problems, never an entry Roblox cannot take
      fs.writeFileSync(path.join(dataDir, "broken.json"), JSON.stringify({ Luck: "Sorte" }));
      const broken = await run("loc", "translate", UNIVERSE, "broken.json", "--unchecked");
      assert.equal(broken.code, 1);
      assert.match(broken.out, /Luck: not an object of locale -> text[\s\S]*Nothing was sent: fix the file \(empty or malformed entries go nowhere/);
      assert.match(await cloudOp(client, "loc.translate", { universeId: UNIVERSE, file: path.join(dataDir, "broken.json"), unchecked: true }), /1 problems in .*broken\.json, nothing was sent/);
      assert.equal(asked.length, asks);

      fs.writeFileSync(path.join(dataDir, "good.json"), JSON.stringify({ "Luck": { pt: "Sorte", es: "Suerte" }, "<b>Rebirth</b> ": { pt: "<b>Renascer</b> " } }));
      assert.match((await run("loc", "lint", "good.json")).out, /^good\.json: 2 strings \| locales es, pt \| 3 translations \| 0 problems$/);
      const sent = await run("loc", "translate", UNIVERSE, "good.json");
      assert.equal(sent.code, 0, sent.out);
      assert.match(asked.at(-1)!, /Write 3 translations of 2 strings \(es, pt\).*Roblox's automatic translation never overwrites them/s);
      assert.deepEqual(roblox.patches.at(-1).entries[0], { identifier: { key: "", context: "", source: "Luck" }, translations: [{ locale: "pt", translationText: "Sorte" }, { locale: "es", translationText: "Suerte" }] });

      assert.equal((await run("loc", "check", UNIVERSE, "Luck", "--locales", "pt,es")).out, "pt: Sorte (Automation, 2026-11-01)\nes: no translation");
      assert.equal((await run("loc", "langs", UNIVERSE)).out, "on (2): pt, de\noff (1): ja");
      const asksBefore = asked.length;
      const langs = await run("loc", "langs", UNIVERSE, "de=off", "ja=on");
      assert.equal(langs.out, "de: automatic translation off\nja: automatic translation on\non (2): pt, ja\noff (1): de");
      assert.match(asked[asksBefore], /turn automatic translation ON for ja .*\n  turn automatic translation OFF for de \(the translations already made stay\)/);
      assert.match((await run("loc", "langs", UNIVERSE, "de")).out, /"de" is not code=on or code=off/);

      const dump = await run("loc", "dump", UNIVERSE, "dump.json");
      assert.match(dump.out, /^\d+ entries -> .*dump\.json$/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "dump.json"), "utf8")).length, roblox.state.entries.length);
      // A dump runs with no dialog: it never replaces a file that is there
      const again = await run("loc", "dump", UNIVERSE, "dump.json");
      assert.equal(again.code, 1);
      assert.match(again.out, /dump\.json already exists: the dump goes to a new file/);
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

/** One named operation straight to the hub, as any local program could send it: its error */
async function cloudOp(client: HubClient, op: string, args: Record<string, unknown>): Promise<string> {
  const answer = await client.post("/api/cloud", { op, args });
  return String(answer.error ?? JSON.stringify(answer.result));
}

test("analytics: the default asks daily active users, a query still computing is asked again by its path, and the MCP tools reach every job with the key never shown", { timeout: 30000 }, async () => {
  const dataDir = scratch();
  try {
    const roblox = fakeRoblox();
    await cloudCli(dataDir, roblox, async () => false, async (run, client) => {
      const r = await run("analytics", UNIVERSE, "--json");
      assert.equal(r.code, 0, r.out);
      const answer = JSON.parse(r.out);
      assert.deepEqual(answer.result.response.values, [{ date: "2026-11-08", value: 1234 }]);
      assert.equal(roblox.patches[0].analytics.metric, "DailyActiveUsers");
      assert.equal(roblox.state.analyticsPolls, 2);
      assert.match((await run("analytics", UNIVERSE, "--kind", "events")).out, /--kind must be metrics or dimension-values/);
      assert.match((await run("analytics", UNIVERSE, "--body={nope")).out, /the query is not JSON/);

      // The MCP: each tool is the command of the same name; a write still waits for the dialog
      const input = new PassThrough();
      const output = new PassThrough();
      const answers = new Map<number, (m: any) => void>();
      let buffer = "";
      output.on("data", (chunk) => {
        buffer += chunk.toString();
        for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
          const message = JSON.parse(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
          answers.get(message.id)?.(message);
        }
      });
      const done = serveMcp(input, output, { info: flavorInfo("dev"), client, cwd: dataDir, openUri: async () => {}, roblox: { dataDir, fetch: roblox.web.fetch, env: {} } });
      let next = 1;
      const tool = (name: string, args: object): Promise<any> => {
        const id = next++;
        return new Promise((resolve) => {
          answers.set(id, (m) => resolve(m.result));
          input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
        });
      };
      const texts: string[] = [];
      const call = async (name: string, args: object) => {
        const result = await tool(name, args);
        texts.push(result.content[0].text);
        return result;
      };
      assert.match((await call("analytics_query", { universeId: UNIVERSE, query: { metric: "DailyActiveUsers", granularity: "None", startTime: "2026-11-01T00:00:00Z", endTime: "2026-11-08T00:00:00Z" } })).content[0].text, /"value": 1234/);
      assert.match((await call("badges", { action: "quota", universeId: UNIVERSE })).content[0].text, /Free badges left today/);
      const refused = await call("developer_products", { action: "create", universeId: UNIVERSE, name: "-dash", price: 5 });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /did not approve product\.create/);
      assert.equal(roblox.writes.length, 0);
      assert.match((await call("game_passes", { action: "list", universeId: UNIVERSE })).content[0].text, /41 \| VIP/);
      assert.match((await call("localization", { action: "langs", universeId: UNIVERSE })).content[0].text, /on \(2\): pt, de/);
      assert.match((await call("badges", { action: "list", universeId: "../1" })).content[0].text, /universeId must be a whole number/);
      for (const t of texts) assert.ok(!t.includes(KEY));
      input.end();
      await done;
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("loc lint: a long source stops at its limit, and \"Codes:\" with a long tail is read in linear time; the codes are still checked", () => {
  const tail = `Codes: ${" ".repeat(100_000)}X\nY`;
  const start = Date.now();
  const long = lintTranslations({ [tail]: { pt: "x" } });
  assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
  assert.equal(long.broken, 1);
  // The same scan under the limit, through the codes check itself
  const t0 = Date.now();
  const linear = lintTranslations({ [`Codes: ${" ".repeat(250)}X\nY`]: { pt: "x" } });
  assert.ok(Date.now() - t0 < 500);
  assert.equal(linear.problems.length, 0);
  assert.deepEqual(lintTranslations({ "Use Codes: ASTRAL, NEW1!": { pt: "Use os códigos: ASTRAL, NEW" } }).problems, ["Use Codes: ASTRAL, NEW1! [pt]: redeem code NEW1 changed"]);
});

test("cloud files: a JSON file past the size limit is refused before the hub reads it", () => {
  const dataDir = scratch();
  try {
    const big = path.join(dataDir, "big.json");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 65 * 1024 * 1024);
    assert.throws(() => readJsonFile(big, "file"), /big\.json is 65 MB: a file here is at most 64 MB/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("loc lint: a run of '<' with no '>' is checked in linear time", () => {
  const long = "<".repeat(200_000);
  const start = Date.now();
  const lint = lintTranslations({ [long]: { pt: long } });
  assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
  assert.ok(lint.problems.some((p) => p.endsWith("source over 300 characters")));
});
