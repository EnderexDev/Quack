import zlib from "node:zlib";

/**
 * PNG from raw RGBA, as Studio's EditableImage reads a screenshot. The alpha is dropped (a
 * screenshot is opaque) and every row gets the Up filter, which halves a game frame against no
 * filter at all. Only node's zlib: no image library ships with the hub.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts: Buffer[]): number {
  let crc = 0xffffffff;
  for (const part of parts) for (let i = 0; i < part.length; i++) crc = CRC_TABLE[(crc ^ part[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([head.subarray(4), data]), 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  if (rgba.length !== width * height * 4) throw new Error(`expected ${width * height * 4} bytes of RGBA for ${width}x${height}, got ${rgba.length}`);
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  let previous = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      row[x * 3] = rgba[from];
      row[x * 3 + 1] = rgba[from + 1];
      row[x * 3 + 2] = rgba[from + 2];
    }
    const at = y * (stride + 1);
    raw[at] = 2; // Up
    for (let i = 0; i < stride; i++) raw[at + 1 + i] = (row[i] - previous[i]) & 0xff;
    previous = Buffer.from(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Half the size each way, each pixel the mean of the four it covers */
export function halve(rgba: Buffer, width: number, height: number): { rgba: Buffer; width: number; height: number } {
  const w = Math.max(1, Math.floor(width / 2));
  const h = Math.max(1, Math.floor(height / 2));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(width - 1, x * 2);
      const x1 = Math.min(width - 1, x * 2 + 1);
      const y0 = Math.min(height - 1, y * 2);
      const y1 = Math.min(height - 1, y * 2 + 1);
      for (let c = 0; c < 4; c++) {
        const sum = rgba[(y0 * width + x0) * 4 + c] + rgba[(y0 * width + x1) * 4 + c] + rgba[(y1 * width + x0) * 4 + c] + rgba[(y1 * width + x1) * 4 + c];
        out[(y * w + x) * 4 + c] = (sum + 2) >> 2;
      }
    }
  }
  return { rgba: out, width: w, height: h };
}
