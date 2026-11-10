/**
 * Tiny binary Roblox files built in the test, as Studio writes them (header, INST, PROP Name,
 * PRNT, END), every chunk stored uncompressed unless a test wraps one.
 */

export interface FixtureInstance {
  className: string;
  name: string;
  children?: FixtureInstance[];
}

const SERVICES = new Set(["Workspace", "StarterGui", "ReplicatedStorage", "StarterPlayer", "Lighting", "ServerStorage"]);

function str(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/** int32 referents: delta, zigzag, then big-endian bytes interleaved */
export function encodeRefs(refs: number[]): Buffer {
  const n = refs.length;
  const out = Buffer.alloc(4 * n);
  let prev = 0;
  refs.forEach((ref, i) => {
    const delta = (ref - prev) | 0;
    prev = ref;
    const z = ((delta << 1) ^ (delta >> 31)) >>> 0;
    out[i] = z >>> 24;
    out[n + i] = (z >>> 16) & 0xff;
    out[2 * n + i] = (z >>> 8) & 0xff;
    out[3 * n + i] = z & 0xff;
  });
  return out;
}

export function chunk(name: string, payload: Buffer, clen = 0, ulen = payload.length): Buffer {
  const head = Buffer.alloc(16);
  head.write(name.padEnd(4, "\0"), 0, "latin1");
  head.writeUInt32LE(clen, 4);
  head.writeUInt32LE(ulen, 8);
  return Buffer.concat([head, payload]);
}

/** A literal-only LZ4 block: valid, and the reader's own decoder has to run on it */
export function lz4Literal(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  let lit = data.length;
  if (lit < 15) parts.push(Buffer.from([lit << 4]));
  else {
    parts.push(Buffer.from([0xf0]));
    lit -= 15;
    while (lit >= 255) {
      parts.push(Buffer.from([255]));
      lit -= 255;
    }
    parts.push(Buffer.from([lit]));
  }
  parts.push(data);
  return Buffer.concat(parts);
}

/**
 * A file holding these roots. Each class gets one INST chunk (services flagged as Studio flags
 * them), a PROP Name chunk, then one PRNT chunk for the whole tree. `wrap` may replace a chunk's
 * bytes (to compress or corrupt it).
 */
export function buildRoblox(roots: FixtureInstance[], wrap?: (name: string, payload: Buffer, className?: string) => Buffer | undefined): Buffer {
  const byClass = new Map<string, { id: number; refs: number[]; names: string[] }>();
  const links: [number, number][] = [];
  let next = 0;
  // depth first in file order, with a stack: a test builds chains deeper than the call stack
  const stack: [FixtureInstance, number][] = roots.map((r) => [r, -1] as [FixtureInstance, number]).reverse();
  while (stack.length) {
    const [inst, parent] = stack.pop()!;
    const ref = next++;
    let cls = byClass.get(inst.className);
    if (!cls) byClass.set(inst.className, (cls = { id: byClass.size, refs: [], names: [] }));
    cls.refs.push(ref);
    cls.names.push(inst.name);
    links.push([ref, parent]);
    const children = inst.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], ref]);
  }
  const header = Buffer.alloc(32);
  header.write("<roblox!", 0, "latin1");
  Buffer.from([0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 8);
  header.writeUInt16LE(0, 14);
  header.writeInt32LE(byClass.size, 16);
  header.writeInt32LE(next, 20);
  const parts: Buffer[] = [header];
  const put = (name: string, payload: Buffer, className?: string) => parts.push(wrap?.(name, payload, className) ?? chunk(name, payload));
  for (const [className, cls] of byClass) {
    const service = SERVICES.has(className);
    put("INST", Buffer.concat([u32(cls.id), str(className), Buffer.from([service ? 1 : 0]), u32(cls.refs.length), encodeRefs(cls.refs), service ? Buffer.alloc(cls.refs.length, 1) : Buffer.alloc(0)]), className);
  }
  for (const [className, cls] of byClass) {
    put("PROP", Buffer.concat([u32(cls.id), str("Name"), Buffer.from([0x01]), ...cls.names.map(str)]), className);
    if (className === "Terrain") put("PROP", Buffer.concat([u32(cls.id), str("SmoothGrid"), Buffer.from([0x01]), str("\x01\x05")]), className);
  }
  put("PRNT", Buffer.concat([Buffer.from([0]), u32(links.length), encodeRefs(links.map((l) => l[0])), encodeRefs(links.map((l) => l[1]))]));
  parts.push(chunk("END", Buffer.from("</roblox>", "latin1")));
  return Buffer.concat(parts);
}

/** A small place: a map, its Camera and Terrain, a UI, a config with a module, player scripts */
export function samplePlace(): FixtureInstance[] {
  return [
    {
      className: "Workspace", name: "Workspace", children: [
        { className: "Camera", name: "Camera" },
        { className: "Terrain", name: "Terrain" },
        { className: "Model", name: "MapA", children: [{ className: "Part", name: "Floor" }, { className: "Script", name: "Door" }] },
        { className: "Model", name: "My.Map", children: [{ className: "Part", name: "Wall" }] },
        { className: "Part", name: "Baseplate" },
      ],
    },
    { className: "StarterGui", name: "StarterGui", children: [{ className: "ScreenGui", name: "Shop", children: [{ className: "Frame", name: "Main" }] }] },
    { className: "ReplicatedStorage", name: "ReplicatedStorage", children: [{ className: "Folder", name: "Config", children: [{ className: "ModuleScript", name: "Prices" }] }] },
    {
      className: "StarterPlayer", name: "StarterPlayer", children: [
        { className: "StarterPlayerScripts", name: "StarterPlayerScripts", children: [{ className: "LocalScript", name: "Camera" }] },
      ],
    },
    { className: "Lighting", name: "Lighting", children: [{ className: "Sky", name: "Sky" }] },
  ];
}
