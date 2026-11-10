import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { pathOf, RbxlError, readRoblox, resolvePicks, scriptsUnder, summarize, summaryText, toModelFile, topItems } from "../util/rbxl.js";
import { buildRoblox, chunk, lz4Literal, samplePlace } from "./rbxlFixture.js";

test("rbxl: a place's tree, items and scripts are read from the binary file", () => {
  const file = readRoblox(buildRoblox(samplePlace()));
  assert.equal(file.place, true);
  assert.deepEqual(file.roots.map((r) => r.name), ["Workspace", "StarterGui", "ReplicatedStorage", "StarterPlayer", "Lighting"]);
  assert.deepEqual(topItems(file).map(pathOf), [
    "Workspace.MapA", "Workspace.My.Map", "Workspace.Baseplate", "StarterGui.Shop", "ReplicatedStorage.Config", "StarterPlayer.StarterPlayerScripts", "Lighting.Sky",
  ], "the Camera and the Terrain are the place's own, not items");
  assert.deepEqual(scriptsUnder(file.roots), { count: 3, paths: ["Workspace.MapA.Door (Script)", "ReplicatedStorage.Config.Prices (ModuleScript)", "StarterPlayer.StarterPlayerScripts.Camera (LocalScript)"] });
  assert.deepEqual(scriptsUnder(file.roots, 1), { count: 3, paths: ["Workspace.MapA.Door (Script)"] }, "counts them all, keeps the first");
  const s = summarize(file);
  assert.equal(s.instances, 20);
  assert.deepEqual(s.terrain, { voxelBytes: 2, empty: true });
  assert.deepEqual(s.items.find((i) => i.path === "Workspace.MapA"), { path: "Workspace.MapA", className: "Model", descendants: 2, scripts: 1 });
  assert.ok(s.classes.some((c) => c.className === "Workspace" && c.service));
  const text = summaryText(s);
  assert.match(text, /^A place of 20 instances\./);
  assert.match(text, /Scripts: 3\n {2}Workspace\.MapA\.Door \(Script\)/);
  assert.match(text, /Terrain: empty/);
});

test("rbxl: a place becomes a model file: Workspace a Model, Terrain and every service a Folder, the other chunks byte for byte", () => {
  const original = buildRoblox(samplePlace());
  const model = toModelFile(readRoblox(original));
  const file = readRoblox(model);
  assert.equal(file.place, false, "no service is left");
  assert.deepEqual(file.roots.map((r) => `${r.name}:${r.className}`), ["Workspace:Model", "StarterGui:Folder", "ReplicatedStorage:Folder", "StarterPlayer:Folder", "Lighting:Folder"]);
  assert.equal(file.roots[0].children.find((c) => c.name === "Terrain")!.className, "Folder");
  assert.deepEqual(scriptsUnder(file.roots), scriptsUnder(readRoblox(original).roots), "the same tree, the same names");
  // Only INST chunks of swapped classes differ: every PROP, PRNT and END chunk is the same bytes
  const raws = (f: ReturnType<typeof readRoblox>, kind: string) => f.chunks.filter((c) => c.name === kind).map((c) => c.raw.toString("hex"));
  for (const kind of ["PROP", "PRNT", "END\0"]) assert.deepEqual(raws(file, kind), raws(readRoblox(original), kind));
  assert.equal(file.header.toString("hex"), readRoblox(original).header.toString("hex"));
  const inst = file.chunks.find((c) => c.name === "INST" && c.payload.includes(Buffer.from("Model")) && c.payload.readUInt32LE(0) === 0)!;
  assert.equal(inst.payload.length, 4 + 4 + 5 + 1 + 4 + 4, "a service's trailing markers are dropped with its flag");
  const plain = buildRoblox([{ className: "Model", name: "Tower" }]);
  assert.deepEqual(toModelFile(readRoblox(plain)), plain, "a model file is left as it is");
});

test("rbxl: paths pick items from the file, a service stands for its items and StarterPlayer's containers for what they hold", () => {
  const file = readRoblox(buildRoblox(samplePlace()));
  const brief = (paths: string[]) => resolvePicks(file, paths).map((p) => `${p.names.join("/")}:${p.className}x${p.count}`);
  assert.deepEqual(brief(["Workspace.MapA", "game.ReplicatedStorage.Config"]), ["Workspace/MapA:Modelx1", "ReplicatedStorage/Config:Folderx1"]);
  assert.deepEqual(brief(["Workspace.My.Map"]), ["Workspace/My.Map:Modelx1"], "a name with a dot is matched whole");
  assert.deepEqual(brief(["StarterGui"]), ["StarterGui/Shop:ScreenGuix1"]);
  assert.deepEqual(brief(["Workspace"]), ["Workspace/MapA:Modelx1", "Workspace/My.Map:Modelx1", "Workspace/Baseplate:Partx1"], "never the Camera or the Terrain");
  assert.deepEqual(brief(["StarterPlayer"]), ["StarterPlayer/StarterPlayerScripts/Camera:LocalScriptx1"], "never a second StarterPlayerScripts");
  assert.deepEqual(brief(["StarterPlayer.StarterPlayerScripts"]), ["StarterPlayer/StarterPlayerScripts/Camera:LocalScriptx1"]);
  assert.throws(() => resolvePicks(file, ["Workspace.MapB"]), /the file has no Workspace\.MapB; Workspace holds MapA, My\.Map, Baseplate$/);
  assert.throws(() => resolvePicks(file, ["Nope.X"]), /the file has no Nope; the file's top level holds Workspace, StarterGui/);
  assert.throws(() => resolvePicks(file, ["Workspace.MapA", "Workspace.MapA.Door"]), /Workspace\.MapA\.Door is inside Workspace\.MapA/);
  assert.throws(() => resolvePicks(file, ["Workspace.MapA", "Workspace.MapA"]), /named twice/);
  assert.throws(() => resolvePicks(file, ["Workspace..MapA"]), /not a path/);

  const twins = readRoblox(buildRoblox([{ className: "Workspace", name: "Workspace", children: [
    { className: "Model", name: "Tree" }, { className: "Model", name: "Tree" }, { className: "Part", name: "Tree" },
  ] }]));
  assert.deepEqual(resolvePicks(twins, ["Workspace.Tree"]).map((p) => p.count), [2], "siblings of one name and class all come; the Part named Tree is another thing");
  const nested = readRoblox(buildRoblox([{ className: "Model", name: "A", children: [{ className: "Model", name: "B", children: [{ className: "Part", name: "C" }] }] }, { className: "Model", name: "A" }]));
  assert.throws(() => resolvePicks(nested, ["A.B"]), /the file has 2 A: the path cannot tell them apart/);
});

test("rbxl: an untrusted file is refused when it lies about its chunks, its tree or its size", () => {
  const good = buildRoblox(samplePlace());
  assert.throws(() => readRoblox(Buffer.from("<roblox xmlns:xmime=...>")), /an XML file/);
  assert.throws(() => readRoblox(Buffer.from("PK\x03\x04 a zip")), /not a Roblox file/);
  assert.throws(() => readRoblox(good.subarray(0, good.length - 20)), /runs past the end|no END chunk/);
  assert.throws(() => readRoblox(good.subarray(0, 20)), /cut short/);
  // a chunk that claims more than 64 MB once decompressed is never decompressed
  const huge = buildRoblox(samplePlace(), (name, payload) => (name === "PRNT" ? chunk(name, payload.subarray(0, 8), 8, 200 * 1024 * 1024) : undefined));
  assert.throws(() => readRoblox(huge), /claims 209715200 bytes, over the 67108864 limit/);
  const badLz4 = buildRoblox(samplePlace(), (name, payload) => (name === "PRNT" ? chunk(name, Buffer.from([0xf0, 0xff, 0xff]), 3, payload.length) : undefined));
  assert.throws(() => readRoblox(badLz4), RbxlError);
  // a parent chain that loops: A's parent is B and B's is A
  const loop = buildRoblox([{ className: "Model", name: "A", children: [{ className: "Model", name: "B" }] }], (name, payload) => {
    if (name !== "PRNT") return undefined;
    const p = Buffer.from(payload);
    // the parents' low bytes: zigzag 2 is a delta of +1 (A's parent is 1, B), then 1 is -1 (B's is 0, A)
    p[1 + 4 + 8 + 6] = 2;
    p[1 + 4 + 8 + 7] = 1;
    return chunk(name, p);
  });
  assert.throws(() => readRoblox(loop), /loop|two parents/);
  const short = buildRoblox(samplePlace(), (name, payload) => (name === "PRNT" ? chunk(name, payload.subarray(0, payload.length - 3)) : undefined));
  assert.throws(() => readRoblox(short), /shorter than it claims/);
});

test("rbxl: compressed chunks are read, LZ4 always and zstd when this Node has it", () => {
  const lz4 = buildRoblox(samplePlace(), (name, payload) => chunk(name, lz4Literal(payload), lz4Literal(payload).length, payload.length));
  const file = readRoblox(lz4);
  assert.equal(file.roots[0].children[2].name, "MapA");
  assert.ok(file.decompressed > 0);
  // a converted LZ4 INST chunk is written back plain
  assert.deepEqual(readRoblox(toModelFile(file)).roots.map((r) => r.className), ["Model", "Folder", "Folder", "Folder", "Folder"]);
  const zstd = (zlib as any).zstdCompressSync as ((b: Buffer) => Buffer) | undefined;
  if (!zstd) return;
  const z = buildRoblox(samplePlace(), (name, payload) => chunk(name, zstd(payload), zstd(payload).length, payload.length));
  assert.deepEqual(scriptsUnder(readRoblox(z).roots), scriptsUnder(file.roots));
});

test("rbxl review fixes: a pick Studio would widen is refused, an empty service says so, and big or deep files stay linear", () => {
  // Workspace's Terrain becomes a Folder: beside a real Folder named Terrain the plugin would take both
  const terrainTwin = readRoblox(buildRoblox([{ className: "Workspace", name: "Workspace", children: [
    { className: "Terrain", name: "Terrain", children: [{ className: "Script", name: "Hidden" }] },
    { className: "Folder", name: "Terrain", children: [{ className: "Part", name: "Rock" }] },
  ] }]));
  // named directly, both come and both are read: the hidden script is in the list the check sees
  const direct = resolvePicks(terrainTwin, ["Workspace.Terrain"]);
  assert.equal(direct[0].count, 2);
  assert.deepEqual(scriptsUnder(direct[0].instances).paths, ["Workspace.Terrain.Hidden (Script)"]);
  // a whole Workspace leaves the Terrain out, so the Folder beside it cannot be picked alone
  assert.throws(() => resolvePicks(terrainTwin, ["Workspace"]), /Workspace\.Terrain: 1 other instance\(s\) of that name become a Folder/);
  const empty = readRoblox(buildRoblox(samplePlace().concat([{ className: "ServerStorage", name: "ServerStorage" }])));
  assert.throws(() => resolvePicks(empty, ["ServerStorage"]), /ServerStorage holds nothing in the file/);

  // 30000 siblings of one name, 30000 of distinct names: groups and overlap checks in one pass each
  const many = (distinct: boolean) => readRoblox(buildRoblox([{ className: "ReplicatedStorage", name: "ReplicatedStorage", children:
    Array.from({ length: 30000 }, (_, i) => ({ className: "Part", name: distinct ? `P${i}` : "Part" })) }]));
  let started = Date.now();
  assert.equal(resolvePicks(many(false), ["ReplicatedStorage"])[0].count, 30000);
  assert.equal(resolvePicks(many(true), ["ReplicatedStorage"]).length, 30000);
  assert.ok(Date.now() - started < 3000, `30000 items took ${Date.now() - started} ms`);

  // a chain 20000 deep with a script at every level: counted without building 20000 long paths
  let deep: { className: string; name: string; children?: any[] } = { className: "ModuleScript", name: "S" };
  for (let i = 0; i < 20000; i++) deep = { className: "ModuleScript", name: "S", children: [deep] };
  started = Date.now();
  const chain = readRoblox(buildRoblox([deep]));
  const s = summarize(chain, 3);
  assert.equal(s.scriptCount, 20001);
  assert.equal(s.scripts.length, 3);
  assert.ok(Date.now() - started < 3000, `the deep chain took ${Date.now() - started} ms`);
});

test("rbxl review fixes: zstd never inflates past the size its header declares, and a file of millions of empty chunks is refused early", () => {
  const zstd = (zlib as any).zstdCompressSync as ((b: Buffer) => Buffer) | undefined;
  if (zstd) {
    const lying = buildRoblox(samplePlace(), (name, payload) => (name === "PRNT" ? chunk(name, zstd(Buffer.alloc(8 * 1024 * 1024)), zstd(Buffer.alloc(8 * 1024 * 1024)).length, payload.length) : undefined));
    assert.throws(() => readRoblox(lying), /corrupt zstd in chunk PRNT/);
  }
  const good = buildRoblox([{ className: "Model", name: "A" }]);
  const end = good.length - (16 + "</roblox>".length);
  const spam = Buffer.concat([good.subarray(0, end), Buffer.alloc(16 * 500_001), good.subarray(end)]);
  assert.throws(() => readRoblox(spam), /over 500000 chunks/);
});

test("rbxl review fixes, round 2: empty StarterPlayer containers, overlong paths and huge names", () => {
  const emptyScripts = readRoblox(buildRoblox([{ className: "StarterPlayer", name: "StarterPlayer", children: [{ className: "StarterPlayerScripts", name: "StarterPlayerScripts" }] }]));
  assert.throws(() => resolvePicks(emptyScripts, ["StarterPlayer"]), /^RbxlError: StarterPlayer holds nothing in the file$|StarterPlayer holds nothing in the file/);
  assert.throws(() => resolvePicks(emptyScripts, ["StarterPlayer.StarterPlayerScripts"]), /StarterPlayer\.StarterPlayerScripts holds nothing in the file/);

  const file = readRoblox(buildRoblox(samplePlace()));
  assert.throws(() => resolvePicks(file, [Array.from({ length: 201 }, () => "A").join(".")]), /a path of 201 segments: at most 200/);

  // a name the file made huge never reaches an answer whole; the plugin still gets it whole
  const huge = "N".repeat(1_000_000);
  const big = readRoblox(buildRoblox([{ className: "Workspace", name: "Workspace", children: [{ className: "Model", name: huge, children: Array.from({ length: 200 }, (_, i) => ({ className: "Script", name: `S${i}` })) }] }]));
  const listed = scriptsUnder(big.roots);
  assert.equal(listed.count, 200);
  assert.ok(listed.paths.every((p) => p.length < 600), "each listed path is short");
  assert.match(listed.paths[0], /^Workspace\.N{100}\.\.\.\.S0 \(Script\)$/);
  const pick = resolvePicks(big, [`Workspace.${huge}`])[0];
  assert.equal(pick.names[1].length, 1_000_000);
  assert.ok(pick.path.length < 600);
  assert.ok(summaryText(summarize(big)).length < 200_000);
});
