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
import { assetThumbnail, cloudSettings, docSecurity, saveCloudSettings, robloxDocs, robloxEnv, searchAssets, uploadAsset, type RobloxEnv } from "../control/roblox.js";

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
  return { ...robloxEnv(dataDir, { fetch, now: time.now, sleep: time.sleep, env }), time };
}

test("upload: the key and creator from open-cloud.env (the group wins), the same upload twice makes one asset, force makes another", async () => {
  const dataDir = scratch();
  try {
    const file = path.join(dataDir, "icon.png");
    fs.writeFileSync(file, "png bytes");
    const cloud = openCloud({ pollsBeforeDone: 2 });
    const env = uploadEnv(dataDir, cloud.web.fetch);
    await assert.rejects(uploadAsset(env, { file, assetType: "Decal", displayName: "Icon" }), new RegExp(`no Open Cloud key: .*${path.join(dataDir, "open-cloud.env").replace(/\\/g, "\\\\")}`));
    fs.writeFileSync(path.join(dataDir, "open-cloud.env"), `# Quack's Open Cloud\nROBLOX_OPEN_CLOUD_API_KEY="${KEY}"\nROBLOX_CREATOR_USER_ID=11\nROBLOX_CREATOR_GROUP_ID=22\n`);
    await assert.rejects(uploadAsset(env, { file, assetType: "Audio", displayName: "Icon" }), /an Audio is uploaded from \.mp3, \.ogg, \.wav, \.flac, not \.png/);

    const first = await uploadAsset(env, { file, assetType: "Decal", displayName: "Icon", description: "d" });
    assert.equal(first.assetId, "9000");
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
    const run = async (...argv: string[]) => runControl(argv, {
      info: flavorInfo("dev"), client: new HubClient(await freePort()), out: (l) => lines.push(l), err: (l) => lines.push(l),
      confirm: async () => false, interactive: false, color: false, cwd: dataDir, openUri: async () => {},
      roblox: { dataDir, fetch: openCloud({ postStatus: [401] }).web.fetch, env, sleep: async () => {} },
    });
    assert.equal(await run("asset", "upload", "a.png", "--type", "Decal", "--name", "D"), 1);
    assert.equal(await run("asset", "upload", "a.png", "--type", "Decal", "--name", "D", "--json"), 1);
    assert.ok(lines.length >= 2);
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
    const run = async (fetch: typeof globalThis.fetch, ...argv: string[]) => {
      const out: string[] = [];
      const code = await runControl(argv, {
        info: flavorInfo("dev"), client: new HubClient(await freePort()), out: (l) => out.push(l), err: (l) => out.push(l),
        confirm: async () => false, interactive: false, color: false, cwd: dataDir, openUri: async () => {},
        roblox: { dataDir, fetch, env, sleep: async () => {} },
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
    assert.match(lost.out, /The image id is not known yet \(no hub answers on port \d+.*\)\. With the place open in Studio, run the same upload again/);
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
test("cloud settings: a short key shows no end, an unreadable open-cloud.env is left alone, no temp file stays", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-cloud-review-"));
  try {
    const env = robloxEnv(dataDir, { env: {} });
    const short = saveCloudSettings(env, { key: "abcd1234" });
    assert.equal(short.hasKey, true);
    assert.equal(short.keyEnd, undefined, "8 characters: no end shown");
    assert.equal(saveCloudSettings(env, { key: "0123456789abcdefWXYZ" }).keyEnd, "WXYZ");
    assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp")), [], "no temporary file left");

    // A folder where the file goes: reading fails with something other than "not there"
    const blocked = path.join(dataDir, "blocked");
    fs.mkdirSync(path.join(blocked, "open-cloud.env"), { recursive: true });
    const blockedEnv = robloxEnv(blocked, { env: {} });
    assert.throws(() => saveCloudSettings(blockedEnv, { key: "0123456789abcdefWXYZ" }), /could not be read, so it was left as it is/);
    assert.ok(fs.statSync(path.join(blocked, "open-cloud.env")).isDirectory(), "what was there stays");
    assert.equal(cloudSettings(blockedEnv).hasKey, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cloud: a short saved key reads as saved, never as ending in undefined", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-cloud-short-"));
  try {
    saveCloudSettings(robloxEnv(dataDir, { env: {} }), { key: "abcd1234" });
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
