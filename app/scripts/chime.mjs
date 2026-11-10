// Makes the sound Quack's app plays when a write waits for the user's answer.
//   node app/scripts/chime.mjs [out.wav]     (default app/src-tauri/sounds/approval.wav)
// Three sine tones going up (E5, G#5, B5: a major chord, so it reads as "a question", not an
// error), each with a soft attack, a long fade and a quiet octave on top, ~1.5 s in all, as a
// 16-bit mono WAV the app embeds and plays with PlaySoundW. The output is committed and the same
// on every run (no randomness); run this again only after changing the notes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 22050;
const SECONDS = 1.5;
const NOTES = [
  { hz: 659.25, at: 0.0 },
  { hz: 830.61, at: 0.14 },
  { hz: 987.77, at: 0.28 },
];
/** Peak of the sum, below full scale: a chime, not an alarm */
const LOUDNESS = 0.42;

export function chimeSamples() {
  const total = Math.round(RATE * SECONDS);
  const out = new Float64Array(total);
  for (const { hz, at } of NOTES) {
    const start = Math.round(at * RATE);
    for (let i = start; i < total; i++) {
      const t = (i - start) / RATE;
      const attack = Math.min(1, t / 0.012);
      const decay = Math.exp(-t * 3.2);
      const tone = Math.sin(2 * Math.PI * hz * t) + 0.18 * Math.sin(2 * Math.PI * 2 * hz * t) * Math.exp(-t * 6);
      out[i] += attack * decay * tone;
    }
  }
  // The last 60 ms fade to silence, so the end never clicks
  const tail = Math.round(0.06 * RATE);
  for (let i = total - tail; i < total; i++) out[i] *= (total - 1 - i) / (tail - 1);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  return out.map((v) => (v / peak) * LOUDNESS);
}

export function chimeWav() {
  const samples = chimeSamples();
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(v * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); // bytes a second
  header.writeUInt16LE(2, 32); // bytes a frame
  header.writeUInt16LE(16, 34); // bits a sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? path.join(here, "..", "src-tauri", "sounds", "approval.wav");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, chimeWav());
  console.log(`Wrote ${out}`);
}
