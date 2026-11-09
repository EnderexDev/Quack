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

/**
 * Images of one size side by side, `columns` to a row, left to right then top to bottom, with a
 * `gap` of dark grey between them (a recording's frames as one picture an AI can read).
 */
export function sheet(images: Buffer[], width: number, height: number, columns: number, gap = 4): { rgba: Buffer; width: number; height: number } {
  if (images.length === 0) throw new Error("a contact sheet needs at least one image");
  const cols = Math.max(1, Math.min(columns, images.length));
  const rows = Math.ceil(images.length / cols);
  const w = cols * width + (cols - 1) * gap;
  const h = rows * height + (rows - 1) * gap;
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < out.length; i += 4) out.set([40, 40, 40, 255], i);
  images.forEach((image, n) => {
    const x0 = (n % cols) * (width + gap);
    const y0 = Math.floor(n / cols) * (height + gap);
    for (let y = 0; y < height; y++) image.copy(out, ((y0 + y) * w + x0) * 4, y * width * 4, (y + 1) * width * 4);
  });
  return { rgba: out, width: w, height: h };
}

/** Any size down (or up) to `width` x `height`, each pixel the mean of the source area it covers */
export function resize(rgba: Buffer, width: number, height: number, toWidth: number, toHeight: number): { rgba: Buffer; width: number; height: number } {
  const w = Math.max(1, Math.round(toWidth));
  const h = Math.max(1, Math.round(toHeight));
  if (rgba.length !== width * height * 4) throw new Error(`expected ${width * height * 4} bytes of RGBA, got ${rgba.length}`);
  const out = Buffer.alloc(w * h * 4);
  const sx = width / w;
  const sy = height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0;
      const count = (y1 - y0) * (x1 - x0);
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          a += rgba[i + 3];
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = Math.round(a / count);
    }
  }
  return { rgba: out, width: w, height: h };
}

/**
 * Images of any size as one picture: each scaled to `tileHeight` tall (keeping its shape), placed
 * left to right and wrapped at `maxWidth`, with a dark grey gap. Answers where each one went.
 */
export function mosaic(images: { rgba: Buffer; width: number; height: number }[], tileHeight: number, maxWidth: number, gap = 6): { rgba: Buffer; width: number; height: number; places: { x: number; y: number; width: number; height: number }[] } {
  if (images.length === 0) throw new Error("a mosaic needs at least one image");
  const tiles = images.map((image) => resize(image.rgba, image.width, image.height, (image.width * tileHeight) / image.height, tileHeight));
  const places: { x: number; y: number; width: number; height: number }[] = [];
  let x = 0;
  let y = 0;
  let width = 0;
  for (const tile of tiles) {
    if (x > 0 && x + tile.width > maxWidth) {
      x = 0;
      y += tileHeight + gap;
    }
    places.push({ x, y, width: tile.width, height: tile.height });
    width = Math.max(width, x + tile.width);
    x += tile.width + gap;
  }
  const height = y + tileHeight;
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < out.length; i += 4) out.set([40, 40, 40, 255], i);
  tiles.forEach((tile, n) => {
    const p = places[n];
    for (let row = 0; row < tile.height; row++) tile.rgba.copy(out, ((p.y + row) * width + p.x) * 4, row * tile.width * 4, (row + 1) * tile.width * 4);
  });
  return { rgba: out, width, height, places };
}
