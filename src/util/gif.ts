/**
 * Animated GIF from raw RGBA frames, for the record tool: no image library and no ffmpeg ship
 * with the hub. Each frame gets its own 255-colour palette (median cut over a 15-bit
 * histogram), and a pixel whose colour stayed in the same 15-bit bin since the frame before is
 * left transparent, so a still background costs almost nothing after the first frame.
 */

export interface GifFrame {
  rgba: Buffer;
  /** How long the frame shows, in hundredths of a second */
  delayCs: number;
}

const TRANSPARENT = 255;
const BINS = 1 << 15;

function bin(rgba: Buffer, at: number): number {
  return ((rgba[at] >> 3) << 10) | ((rgba[at + 1] >> 3) << 5) | (rgba[at + 2] >> 3);
}

/**
 * Median cut: the bins in `used` (with their pixel counts and colour sums) split into at most
 * `colors` boxes, each box the weighted mean of its pixels. Returns the palette (RGB triples) and
 * each bin's box.
 */
function medianCut(used: number[], count: Float64Array, sums: Float64Array, colors: number): { palette: Buffer; lut: Uint8Array } {
  const channel = (b: number, c: number) => (c === 0 ? b >> 10 : c === 1 ? (b >> 5) & 31 : b & 31);
  const boxes: number[][] = used.length ? [used] : [];
  while (boxes.length < colors) {
    // The box spanning the most, weighted by its pixels, splits next
    let pick = -1;
    let best = 0;
    let axis = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      let pixels = 0;
      const lo = [31, 31, 31];
      const hi = [0, 0, 0];
      for (const b of box) {
        pixels += count[b];
        for (let c = 0; c < 3; c++) {
          const v = channel(b, c);
          if (v < lo[c]) lo[c] = v;
          if (v > hi[c]) hi[c] = v;
        }
      }
      const spans = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
      const longest = spans.indexOf(Math.max(...spans));
      const score = (spans[longest] + 1) * Math.sqrt(pixels);
      if (spans[longest] > 0 && score > best) {
        best = score;
        pick = i;
        axis = longest;
      }
    }
    if (pick < 0) break;
    const box = boxes[pick].sort((a, b) => channel(a, axis) - channel(b, axis));
    let total = 0;
    for (const b of box) total += count[b];
    let seen = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      seen += count[box[i]];
      cut = i + 1;
      if (seen >= total / 2) break;
    }
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }
  const palette = Buffer.alloc(256 * 3);
  const lut = new Uint8Array(BINS);
  boxes.forEach((box, index) => {
    let n = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const entry of box) {
      n += count[entry];
      r += sums[entry * 3];
      g += sums[entry * 3 + 1];
      b += sums[entry * 3 + 2];
      lut[entry] = index;
    }
    palette[index * 3] = Math.round(r / n);
    palette[index * 3 + 1] = Math.round(g / n);
    palette[index * 3 + 2] = Math.round(b / n);
  });
  return { palette, lut };
}

/** GIF's LZW: variable-width codes from 9 to 12 bits, packed least significant bit first */
export function lzw(indices: Uint8Array, minCodeSize = 8): Buffer {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let bits = 0;
  let pending = 0;
  const emit = (code: number, size: number) => {
    pending |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(pending & 0xff);
      pending >>>= 8;
      bits -= 8;
    }
  };
  let size = minCodeSize + 1;
  let next = eoi + 1;
  const table = new Map<number, number>();
  emit(clear, size);
  if (indices.length === 0) {
    emit(eoi, size);
    if (bits > 0) out.push(pending & 0xff);
    return Buffer.from(out);
  }
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const code = table.get(key);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    emit(prefix, size);
    if (next === 4096) {
      emit(clear, size);
      table.clear();
      size = minCodeSize + 1;
      next = eoi + 1;
    } else {
      // The decoder widens its codes one entry later than the encoder adds them
      if (next >= 1 << size) size++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix, size);
  // Reading that last code fills the decoder's table to `next`: at a power of two it widens
  // before the end code (the padding's zero bits hid the difference, but the spec counts them)
  if (next === 1 << size && size < 12) size++;
  emit(eoi, size);
  if (bits > 0) out.push(pending & 0xff);
  return Buffer.from(out);
}

/** Data in GIF sub-blocks of at most 255 bytes, then the block terminator */
function subBlocks(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let at = 0; at < data.length; at += 255) {
    const piece = data.subarray(at, at + 255);
    parts.push(Buffer.from([piece.length]), piece);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

export function encodeGif(frames: GifFrame[], width: number, height: number): Buffer {
  if (!frames.length) throw new Error("a GIF needs at least one frame");
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width < 65536 && height < 65536)) throw new Error(`a GIF cannot be ${width}x${height}`);
  const pixels = width * height;
  // Every frame's size before any buffer: the dimensions alone could ask for gigabytes
  frames.forEach((frame, n) => {
    if (frame.rgba.length !== pixels * 4) throw new Error(`frame ${n + 1}: expected ${pixels * 4} bytes of RGBA for ${width}x${height}, got ${frame.rgba.length}`);
  });
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  // no global colour table: every frame has its own
  const parts: Buffer[] = [
    Buffer.from("GIF89a", "ascii"),
    screen,
    // Loops forever
    Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0", "ascii"), 0x03, 0x01, 0x00, 0x00, 0x00]),
  ];
  const shown = new Uint16Array(pixels);
  const indices = new Uint8Array(pixels);
  const count = new Float64Array(BINS);
  const sums = new Float64Array(BINS * 3);
  frames.forEach((frame, n) => {
    count.fill(0);
    sums.fill(0);
    const used: number[] = [];
    for (let p = 0; p < pixels; p++) {
      const b = bin(frame.rgba, p * 4);
      // The same bin as the colour already on screen: left as it is
      if (n > 0 && shown[p] === b) continue;
      if (count[b] === 0) used.push(b);
      count[b]++;
      sums[b * 3] += frame.rgba[p * 4];
      sums[b * 3 + 1] += frame.rgba[p * 4 + 1];
      sums[b * 3 + 2] += frame.rgba[p * 4 + 2];
    }
    const { palette, lut } = medianCut(used, count, sums, 255);
    for (let p = 0; p < pixels; p++) {
      const b = bin(frame.rgba, p * 4);
      if (n > 0 && shown[p] === b) {
        indices[p] = TRANSPARENT;
      } else {
        indices[p] = lut[b];
        shown[p] = b;
      }
    }
    // A delay that is not a number shows the frame for a tenth of a second
    const delay = Math.max(2, Math.min(65535, Math.round(Number.isFinite(frame.delayCs) ? frame.delayCs : 10)));
    const control = Buffer.from([0x21, 0xf9, 0x04, (1 << 2) | (n > 0 ? 1 : 0), delay & 0xff, delay >> 8, TRANSPARENT, 0x00]);
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = 0x80 | 7; // a local colour table of 256 entries
    parts.push(control, descriptor, palette, Buffer.from([8]), subBlocks(lzw(indices)));
  });
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
