import zlib from "node:zlib";

/**
 * Roblox's binary model and place format (.rbxm, .rbxl), read far enough to list a file's tree and
 * to make a place file importable.
 *
 * SerializationService:DeserializeInstancesAsync on an .rbxl hands back the services it can create
 * but drops Workspace and StarterGui with everything under them (measured 09/11/26). The fix,
 * ported from the rbxl-extract script of the roblox-assets skill: rewrite the INST chunk of
 * Workspace as a plain Model, of Terrain as a Folder (a Terrain under a Model errors "Workspace
 * already has Terrain") and of every other service as a Folder. Every other chunk is copied byte
 * for byte; the properties a Model or a Folder lacks are skipped by the deserializer, as for a
 * file from a newer Studio. Terrain voxels do not survive (see `terrain` in the summary).
 *
 * A downloaded place is untrusted: no chunk may claim more than MAX_CHUNK once decompressed, one
 * file may not make us decompress more than MAX_TOTAL, and every read is bounds-checked.
 */

const MAGIC = "<roblox!";
const MAX_CHUNK = 64 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_INSTANCES = 5_000_000;
/** a big place has tens of thousands (a few per property of each class); millions of empty ones are an attack */
const MAX_CHUNKS = 500_000;

export class RbxlError extends Error {}

interface Chunk {
  name: string;
  clen: number;
  ulen: number;
  /** the whole chunk, header included, as it is in the file */
  raw: Buffer;
  payload: Buffer;
}

interface ClassInfo {
  classId: number;
  className: string;
  isService: boolean;
  refs: number[];
  /** offset of the referent array in the INST chunk's data */
  refsAt: number;
  chunk: Chunk;
}

export interface FileInstance {
  ref: number;
  className: string;
  name: string;
  parent: FileInstance | undefined;
  children: FileInstance[];
}

export interface RobloxFile {
  header: Buffer;
  chunks: Chunk[];
  classes: Map<number, ClassInfo>;
  instances: Map<number, FileInstance>;
  roots: FileInstance[];
  /** some class is a service: a place file */
  place: boolean;
  /** the Terrain's SmoothGrid: its size in bytes, and whether it holds voxels */
  terrain?: { voxelBytes: number; empty: boolean };
  /** the bytes the file made us decompress */
  decompressed: number;
}

function lz4Block(src: Buffer, outLen: number): Buffer {
  const out = Buffer.alloc(outLen);
  let i = 0;
  let o = 0;
  const byte = () => {
    if (i >= src.length) throw new RbxlError("corrupt LZ4: truncated");
    return src[i++];
  };
  const extend = (n: number) => {
    let b: number;
    do {
      b = byte();
      n += b;
    } while (b === 255);
    return n;
  };
  while (i < src.length) {
    const token = byte();
    let lit = token >> 4;
    if (lit === 15) lit = extend(lit);
    if (i + lit > src.length || o + lit > outLen) throw new RbxlError("corrupt LZ4: literal out of bounds");
    src.copy(out, o, i, i + lit);
    i += lit;
    o += lit;
    if (i >= src.length) break;
    const off = byte() | (byte() << 8);
    let len = token & 15;
    if (len === 15) len = extend(len);
    len += 4;
    if (off === 0 || off > o || o + len > outLen) throw new RbxlError("corrupt LZ4: match out of bounds");
    for (let k = 0; k < len; k++) out[o + k] = out[o - off + k];
    o += len;
  }
  if (o !== outLen) throw new RbxlError("corrupt LZ4: wrong size");
  return out;
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** One chunk's bytes, decompressed on demand and never kept, counted against the file's budget */
function chunkData(c: Chunk, budget: { used: number }): Buffer {
  if (c.clen === 0) return c.payload;
  budget.used += c.ulen;
  if (budget.used > MAX_TOTAL) throw new RbxlError(`over the ${MAX_TOTAL} byte decompression budget`);
  const pl = c.payload;
  if (!ZSTD_MAGIC.every((b, i) => pl[i] === b)) return lz4Block(pl, c.ulen);
  const zstd = (zlib as any).zstdDecompressSync as ((b: Buffer, o: object) => Buffer) | undefined;
  if (!zstd) throw new RbxlError(`chunk ${c.name} is zstd, which this Node (${process.version}) cannot read: Node 22.15 or newer`);
  let out: Buffer;
  try {
    // never more than the header declares: a small ulen cannot buy a 64 MB expansion
    out = zstd(pl, { maxOutputLength: Math.max(c.ulen, 1) });
  } catch (error) {
    throw new RbxlError(`corrupt zstd in chunk ${c.name}: ${(error as Error).message}`);
  }
  if (out.length !== c.ulen) throw new RbxlError(`chunk ${c.name}: zstd gave ${out.length} bytes, the header says ${c.ulen}`);
  return out;
}

/** A cursor over one chunk's data that refuses to read past its end */
class Reader {
  constructor(readonly data: Buffer, readonly what: string, public at = 0) {}
  need(n: number) {
    if (n < 0 || this.at + n > this.data.length) throw new RbxlError(`${this.what} is shorter than it claims`);
  }
  u8(): number {
    this.need(1);
    return this.data[this.at++];
  }
  u32(): number {
    this.need(4);
    const v = this.data.readUInt32LE(this.at);
    this.at += 4;
    return v;
  }
  string(): string {
    const len = this.u32();
    this.need(len);
    const s = this.data.toString("utf8", this.at, this.at + len);
    this.at += len;
    return s;
  }
  /** count int32 referents, interleaved big-endian, zigzag and delta coded */
  refs(count: number): number[] {
    if (count > MAX_INSTANCES) throw new RbxlError(`${this.what} claims ${count} referents`);
    this.need(4 * count);
    const d = this.data;
    const p = this.at;
    const out = new Array<number>(count);
    let acc = 0;
    for (let i = 0; i < count; i++) {
      const v = ((d[p + i] << 24) | (d[p + count + i] << 16) | (d[p + 2 * count + i] << 8) | d[p + 3 * count + i]) >>> 0;
      acc = (acc + ((v >>> 1) ^ -(v & 1))) | 0;
      out[i] = acc;
    }
    this.at += 4 * count;
    return out;
  }
}

/**
 * The file's chunks, classes and tree. Throws RbxlError on anything that is not a well-formed
 * binary file within the caps.
 */
export function readRoblox(buf: Buffer): RobloxFile {
  if (buf.toString("latin1", 0, 8) !== MAGIC) {
    throw new RbxlError(buf.toString("latin1", 0, 7) === "<roblox" ? "an XML file (.rbxmx / .rbxlx): save it as binary (.rbxm / .rbxl)" : "not a Roblox file (no <roblox! at the start)");
  }
  if (buf.length < 32) throw new RbxlError("the file is cut short");
  if (buf.readUInt16LE(14) !== 0) throw new RbxlError(`format version ${buf.readUInt16LE(14)}, only 0 is known`);
  const chunks: Chunk[] = [];
  let p = 32;
  let ended = false;
  while (p + 16 <= buf.length) {
    if (chunks.length >= MAX_CHUNKS) throw new RbxlError(`over ${MAX_CHUNKS} chunks`);
    const name = buf.toString("latin1", p, p + 4);
    const clen = buf.readUInt32LE(p + 4);
    const ulen = buf.readUInt32LE(p + 8);
    const start = p + 16;
    const end = start + (clen || ulen);
    if (end > buf.length) throw new RbxlError(`chunk ${name.replace(/\0/g, "")} runs past the end of the file`);
    if (ulen > MAX_CHUNK) throw new RbxlError(`chunk ${name.replace(/\0/g, "")} claims ${ulen} bytes, over the ${MAX_CHUNK} limit`);
    chunks.push({ name, clen, ulen, raw: buf.subarray(p, end), payload: buf.subarray(start, end) });
    p = end;
    if (name === "END\0") {
      ended = true;
      break;
    }
  }
  if (!ended) throw new RbxlError("the file has no END chunk: cut short?");

  const budget = { used: 0 };
  const data = (c: Chunk) => chunkData(c, budget);

  const classes = new Map<number, ClassInfo>();
  const instances = new Map<number, FileInstance>();
  let terrain: RobloxFile["terrain"];
  // the chunks read again below, kept decompressed so none counts twice against the budget
  const terrainProp: Buffer[] = [];
  const nameProps: Buffer[] = [];
  const prnt: Buffer[] = [];
  for (const c of chunks) {
    if (c.name === "INST") {
      const r = new Reader(data(c), "an INST chunk");
      const classId = r.u32();
      const className = r.string();
      const isService = r.u8() !== 0;
      const count = r.u32();
      const refsAt = r.at;
      const refs = r.refs(count);
      if (classes.has(classId)) throw new RbxlError(`class id ${classId} is declared twice`);
      classes.set(classId, { classId, className, isService, refs, refsAt, chunk: c });
      if (instances.size + count > MAX_INSTANCES) throw new RbxlError(`over ${MAX_INSTANCES} instances`);
      for (const ref of refs) {
        if (instances.has(ref)) throw new RbxlError(`referent ${ref} is used twice`);
        instances.set(ref, { ref, className, name: className, parent: undefined, children: [] });
      }
    } else if (c.name === "PROP") {
      // Only the Name and the Terrain's voxels are read: the rest is copied untouched
      const head = data(c);
      const r = new Reader(head, "a PROP chunk");
      r.u32();
      const prop = r.string();
      if (prop === "Name") nameProps.push(head);
      else if (prop === "SmoothGrid") terrainProp.push(head);
    } else if (c.name === "PRNT") {
      prnt.push(data(c));
    }
  }
  for (const d of nameProps) {
    const r = new Reader(d, "a Name PROP chunk");
    const info = classes.get(r.u32());
    r.string();
    if (!info || r.u8() !== 0x01) continue;
    for (const ref of info.refs) instances.get(ref)!.name = r.string();
  }
  for (const d of terrainProp) {
    const r = new Reader(d, "a SmoothGrid PROP chunk");
    const info = classes.get(r.u32());
    if (info?.className !== "Terrain") continue;
    r.string();
    if (r.u8() !== 0x01 || !info.refs.length) continue;
    // a blank Terrain's chunk is 25 bytes (measured in the skill's script)
    terrain = { voxelBytes: r.u32(), empty: d.length <= 25 };
  }
  for (const d of prnt) {
    const r = new Reader(d, "the PRNT chunk");
    if (r.u8() !== 0) throw new RbxlError("unknown PRNT chunk version");
    const count = r.u32();
    const children = r.refs(count);
    const parents = r.refs(count);
    for (let i = 0; i < count; i++) {
      const child = instances.get(children[i]);
      if (!child) throw new RbxlError(`PRNT names referent ${children[i]}, which no class holds`);
      if (parents[i] === -1) continue;
      const parent = instances.get(parents[i]);
      if (!parent) throw new RbxlError(`PRNT names parent ${parents[i]}, which no class holds`);
      if (child.parent) throw new RbxlError(`referent ${children[i]} has two parents`);
      child.parent = parent;
    }
  }
  // A parent chain that loops would make every walk below run forever
  const settled = new Set<FileInstance>();
  for (const inst of instances.values()) {
    const chain = new Set<FileInstance>();
    let at: FileInstance | undefined = inst;
    while (at && !settled.has(at)) {
      if (chain.has(at)) throw new RbxlError(`the parents of ${inst.name} loop`);
      chain.add(at);
      at = at.parent;
    }
    for (const done of chain) settled.add(done);
  }
  const roots: FileInstance[] = [];
  for (const inst of instances.values()) {
    if (inst.parent) inst.parent.children.push(inst);
    else roots.push(inst);
  }
  const place = [...classes.values()].some((c) => c.isService);
  return { header: buf.subarray(0, 32), chunks, classes, instances, roots, place, terrain, decompressed: budget.used };
}

/** The class each service, Workspace and Terrain become so the deserializer keeps them */
function swapFor(info: ClassInfo): string | undefined {
  if (info.className === "Workspace") return "Model";
  if (info.className === "Terrain") return "Folder";
  return info.isService ? "Folder" : undefined;
}

const afterByFile = new WeakMap<RobloxFile, Map<string, string>>();

/** The class an instance has once the file went through toModelFile */
export function classAfter(file: RobloxFile, inst: FileInstance): string {
  if (!file.place) return inst.className;
  let after = afterByFile.get(file);
  if (!after) {
    after = new Map();
    for (const info of file.classes.values()) {
      const swap = swapFor(info);
      if (swap) after.set(info.className, swap);
    }
    afterByFile.set(file, after);
  }
  return after.get(inst.className) ?? inst.className;
}

/** The INST chunk again, as a plain (non-service) class, stored uncompressed */
function asPlainClass(info: ClassInfo, data: Buffer, newClass: string): Buffer {
  const refs = data.subarray(info.refsAt, info.refsAt + 4 * info.refs.length);
  const name = Buffer.from(newClass, "utf8");
  const body = Buffer.alloc(13 + name.length + refs.length);
  let q = body.writeUInt32LE(info.classId, 0);
  q = body.writeUInt32LE(name.length, q);
  q += name.copy(body, q);
  body[q++] = 0;
  q = body.writeUInt32LE(info.refs.length, q);
  refs.copy(body, q);
  const head = Buffer.alloc(16);
  head.write("INST", 0, "latin1");
  head.writeUInt32LE(body.length, 8);
  return Buffer.concat([head, body]);
}

/**
 * A place file as a model file whose every top-level item survives DeserializeInstancesAsync:
 * Workspace a Model, Terrain and each other service a Folder, each keeping its name. A file with
 * no service comes back as it was.
 */
export function toModelFile(file: RobloxFile): Buffer {
  if (!file.place) return Buffer.concat([file.header, ...file.chunks.map((c) => c.raw)]);
  const budget = { used: 0 };
  const byChunk = new Map<Chunk, ClassInfo>();
  for (const info of file.classes.values()) byChunk.set(info.chunk, info);
  const parts: Buffer[] = [file.header];
  for (const c of file.chunks) {
    const info = byChunk.get(c);
    const swap = info && swapFor(info);
    if (!info || !swap) {
      parts.push(c.raw);
      continue;
    }
    parts.push(asPlainClass(info, chunkData(c, budget), swap));
  }
  return Buffer.concat(parts);
}

const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);
export function isScriptClass(className: string): boolean {
  return SCRIPT_CLASSES.has(className) || /Script$/.test(className);
}

/** An instance's path in the file, its names joined by dots from the root */
export function pathOf(inst: FileInstance): string {
  let path = "";
  for (let at: FileInstance | undefined = inst; at; at = at.parent) {
    path = path ? `${shortName(at.name)}.${path}` : shortName(at.name);
    if (path.length > MAX_PATH_SHOWN) return `...${path.slice(-MAX_PATH_SHOWN)}`;
  }
  return path;
}

/**
 * A path is for a person to read: a name the file made huge is cut, and so is a path nested deep
 * (from its start), so no answer grows with what an untrusted file chose. The plugin walks by
 * namesOf, never by these.
 */
const MAX_NAME_SHOWN = 100;
const MAX_PATH_SHOWN = 400;
function shortName(name: string): string {
  return name.length > MAX_NAME_SHOWN ? `${name.slice(0, MAX_NAME_SHOWN)}...` : name;
}

/** The names from the root down to this instance */
export function namesOf(inst: FileInstance): string[] {
  const names: string[] = [];
  for (let at: FileInstance | undefined = inst; at; at = at.parent) names.push(at.name);
  return names.reverse();
}

function walk(inst: FileInstance, visit: (i: FileInstance) => void) {
  const stack = [inst];
  while (stack.length) {
    const at = stack.pop()!;
    visit(at);
    for (let i = at.children.length - 1; i >= 0; i--) stack.push(at.children[i]);
  }
}

/**
 * The scripts at or under these instances: how many, and the first `limit` as "path (Class)".
 * Each path is carried down the walk (one concatenation a level), so a file nested deep costs
 * no more than its size, and no more paths than `limit` are kept.
 */
export function scriptsUnder(roots: FileInstance[], limit = 200): { paths: string[]; count: number } {
  const paths: string[] = [];
  let count = 0;
  // only instances on the stack: a path is made for the `limit` scripts listed, never for the rest
  for (const root of roots) {
    const stack: FileInstance[] = [root];
    while (stack.length) {
      const at = stack.pop()!;
      if (isScriptClass(at.className) && count++ < limit) paths.push(`${pathOf(at)} (${at.className})`);
      for (let i = at.children.length - 1; i >= 0; i--) stack.push(at.children[i]);
    }
  }
  return { paths, count };
}

function countUnder(inst: FileInstance): number {
  let n = -1;
  walk(inst, () => n++);
  return n;
}

/** Under Workspace, the Camera and the Terrain are the place's own, not a part of the map */
function isPlaceFixture(inst: FileInstance): boolean {
  return inst.parent?.className === "Workspace" && !inst.parent.parent && (inst.className === "Camera" || inst.className === "Terrain");
}

/**
 * The file's top-level items: in a place, each service's children (but Workspace's Camera and
 * Terrain); in a model, its roots.
 */
export function topItems(file: RobloxFile): FileInstance[] {
  if (!file.place) return file.roots;
  return file.roots.flatMap((root) => root.children.filter((c) => !isPlaceFixture(c)));
}

export interface RobloxSummary {
  place: boolean;
  instances: number;
  classes: { className: string; count: number; service: boolean }[];
  /** top-level items with their size, at most `limit` of them; `itemCount` is all */
  items: { path: string; className: string; descendants: number; scripts: number }[];
  itemCount: number;
  scripts: string[];
  scriptCount: number;
  terrain?: { voxelBytes: number; empty: boolean };
}

/** What a file holds, for a person to read before any of it lands (the skill script's `list`) */
export function summarize(file: RobloxFile, limit = 200): RobloxSummary {
  const counts = new Map<string, { className: string; count: number; service: boolean }>();
  for (const info of file.classes.values()) {
    const row = counts.get(info.className) ?? { className: info.className, count: 0, service: info.isService };
    row.count += info.refs.length;
    counts.set(info.className, row);
  }
  const items = topItems(file);
  const scripts = scriptsUnder(file.roots, limit);
  return {
    place: file.place,
    instances: file.instances.size,
    classes: [...counts.values()].sort((a, b) => a.className.localeCompare(b.className)),
    items: items.slice(0, limit).map((i) => ({ path: pathOf(i), className: i.className, descendants: countUnder(i), scripts: scriptsUnder([i], 0).count })),
    itemCount: items.length,
    scripts: scripts.paths,
    scriptCount: scripts.count,
    ...(file.terrain ? { terrain: file.terrain } : {}),
  };
}

/** The summary as lines a person reads */
export function summaryText(s: RobloxSummary): string {
  const lines = [`${s.place ? "A place" : "A model"} of ${s.instances} instances.`];
  lines.push(`${s.place ? "Top-level items (each service's children)" : "Top-level items"}: ${s.itemCount}`);
  for (const i of s.items) lines.push(`  ${i.path} (${i.className}): ${i.descendants} below${i.scripts ? `, ${i.scripts} script(s)` : ""}`);
  if (s.itemCount > s.items.length) lines.push(`  ... and ${s.itemCount - s.items.length} more`);
  if (s.terrain) lines.push(`Terrain: ${s.terrain.empty ? "empty" : `${s.terrain.voxelBytes} bytes of voxels, which do not come in an import`}`);
  lines.push(s.scriptCount ? `Scripts: ${s.scriptCount}` : "No scripts.");
  for (const p of s.scripts) lines.push(`  ${p}`);
  if (s.scriptCount > s.scripts.length) lines.push(`  ... and ${s.scriptCount - s.scripts.length} more`);
  lines.push("Classes: " + s.classes.map((c) => `${c.className} x${c.count}${c.service ? " (service)" : ""}`).join(", "));
  return lines.join("\n");
}

/**
 * Containers every place already has once (StarterPlayer's two): a pick of one is a pick of what
 * it holds, each put in the place's own container, never a second container.
 */
const SINGLE_CONTAINERS = new Set(["StarterPlayerScripts", "StarterCharacterScripts"]);

const MAX_PATH_SEGMENTS = 200;

/**
 * Instances grouped by name and by the class the deserializer gives them, in file order: the
 * plugin's walk takes a group at once
 */
function sameNameGroups(file: RobloxFile, items: FileInstance[]): FileInstance[][] {
  const groups = new Map<string, FileInstance[]>();
  for (const item of items) {
    const key = `${item.name}\0${classAfter(file, item)}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()];
}

export interface Pick {
  /** the path as given, and as the file names it */
  asked: string;
  path: string;
  /** the names from the root down: the plugin walks the deserialized tree by them */
  names: string[];
  /** the class at the end of the walk, as the deserializer makes it */
  className: string;
  /** how many siblings carry that name and class: all of them come */
  count: number;
  instances: FileInstance[];
}

/**
 * Paths into the file (Workspace.MapA, StarterGui.Shop, ReplicatedStorage.Config; a name with
 * dots is matched whole, as Studio paths are) turned into the walks the plugin makes. In a place,
 * a service alone (StarterGui) stands for all its items. Two paths where one holds the other are
 * refused: the inner one would land twice.
 */
export function resolvePicks(file: RobloxFile, paths: string[]): Pick[] {
  const picks: Pick[] = [];
  // how many of a parent's children share each name and class after the import, counted once a parent
  const counted = new Map<FileInstance[], Map<string, number>>();
  const sameKeyCount = (children: FileInstance[]) => {
    let counts = counted.get(children);
    if (!counts) {
      counts = new Map();
      for (const c of children) {
        const key = `${c.name}\0${classAfter(file, c)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      counted.set(children, counts);
    }
    return counts;
  };
  const add = (asked: string, found: FileInstance[]): void => {
    const first = found[0];
    if (file.place && SINGLE_CONTAINERS.has(first.className) && first.parent && !first.parent.parent) {
      for (const group of sameNameGroups(file, found.flatMap((f) => f.children))) add(asked, group);
      return;
    }
    // The plugin takes every sibling of this name and class as Studio makes them: one the pick
    // leaves out (Workspace's Terrain, now a Folder, beside a Folder named Terrain) would land
    // with no script check
    const className = classAfter(file, first);
    const siblings = sameKeyCount(first.parent?.children ?? file.roots).get(`${first.name}\0${className}`) ?? 0;
    if (siblings !== found.length) throw new RbxlError(`${pathOf(first)}: ${siblings - found.length} other instance(s) of that name become a ${className} in the import too (a Terrain or a service): the path cannot tell them apart`);
    // the walk needs each name whole (a path joins them with dots)
    picks.push({ asked, path: pathOf(first), names: namesOf(first), className, count: found.length, instances: found });
  };
  for (const raw of paths) {
    const parts = raw.trim().split(".");
    if (parts[0] === "game") parts.shift();
    if (!parts.length || parts.some((p) => p === "")) throw new RbxlError(`"${raw}" is not a path`);
    // each level tries every run of the remaining segments as one dotted name: cap the segments
    if (parts.length > MAX_PATH_SEGMENTS) throw new RbxlError(`a path of ${parts.length} segments: at most ${MAX_PATH_SEGMENTS}`);
    const before = picks.length;
    let level: FileInstance[] = file.roots;
    let found: FileInstance[] = [];
    let i = 0;
    while (i < parts.length) {
      let matched: FileInstance[] = [];
      let used = 0;
      for (let j = parts.length; j > i; j--) {
        const name = parts.slice(i, j).join(".");
        matched = level.filter((c) => c.name === name);
        if (matched.length) {
          used = j - i;
          break;
        }
      }
      if (!matched.length) {
        const where = i === 0 ? "the file's top level" : parts.slice(0, i).join(".");
        const names = [...new Set(level.filter((c) => !isPlaceFixture(c)).map((c) => shortName(c.name)))];
        throw new RbxlError(`the file has no ${parts.slice(0, i + 1).join(".")}; ${where} holds ${names.length ? names.slice(0, 30).join(", ") + (names.length > 30 ? `, ... (${names.length})` : "") : "nothing"}`);
      }
      i += used;
      if (i < parts.length) {
        if (matched.length > 1) throw new RbxlError(`the file has ${matched.length} ${parts.slice(0, i).join(".")}: the path cannot tell them apart`);
        level = matched[0].children;
      }
      found = matched;
    }
    if (file.place && !found[0].parent) {
      // A whole service: every item of it, each where it was
      const items = found[0].children.filter((c) => !isPlaceFixture(c));
      for (const group of sameNameGroups(file, items)) add(raw, group);
    } else {
      // siblings with the same name but another class are not this one
      const className = classAfter(file, found[0]);
      add(raw, found.filter((c) => classAfter(file, c) === className));
    }
    // a service, or StarterPlayer's containers, with nothing in them
    if (picks.length === before) throw new RbxlError(`${raw.trim()} holds nothing in the file`);
  }
  // One pass over the picks and their ancestors, never pick against pick
  const owner = new Map<FileInstance, Pick>();
  for (const pick of picks) {
    for (const inst of pick.instances) {
      if (owner.has(inst)) throw new RbxlError(`${pick.path} is named twice`);
      owner.set(inst, pick);
    }
  }
  // an ancestor walked once and found free of picks, with all of its own: the next walk stops there
  const free = new Set<FileInstance>();
  for (const pick of picks) {
    for (const inst of pick.instances) {
      const walked: FileInstance[] = [];
      for (let at = inst.parent; at && !free.has(at); at = at.parent) {
        const outer = owner.get(at);
        if (outer) throw new RbxlError(`${pick.path} is inside ${outer.path}: name one of them`);
        walked.push(at);
      }
      for (const at of walked) free.add(at);
    }
  }
  return picks;
}
