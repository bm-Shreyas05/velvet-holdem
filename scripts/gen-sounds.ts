/**
 * Packs the recorded sounds in assets/sounds/ (Kenney's "Casino Audio", CC0 — see License.txt
 * there) into public/sounds.bin: decoded with Playwright's Chromium, mixed to mono, resampled,
 * trimmed of silence, faded out, peak-normalised and stored as 8-bit µ-law (src/audio/samples.ts).
 *
 *   node scripts/gen-sounds.ts
 *
 * sounds.bin is committed, so building and deploying never needs this; rerun it only when the
 * selection or the processing changes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { packSoundBank } from '../src/audio/samples.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 32000;

/** Bank entry -> source files and the longest it may run (seconds, before the fade). */
const SELECTION: Record<string, { files: string[]; max: number }> = {
  shuffle: { files: ['card-shuffle'], max: 1.0 },
  deal: { files: ['card-slide-1', 'card-slide-2', 'card-slide-5', 'card-slide-6', 'card-slide-8'], max: 0.25 },
  flip: { files: ['card-place-1', 'card-place-2', 'card-place-4'], max: 0.25 },
  fold: { files: ['card-shove-1', 'card-shove-2', 'card-shove-3'], max: 0.45 },
  chipLay: { files: ['chip-lay-1', 'chip-lay-2', 'chip-lay-3'], max: 0.25 },
  chipStack: { files: ['chips-stack-1', 'chips-stack-3', 'chips-stack-4', 'chips-stack-6'], max: 0.3 },
  collide: { files: ['chips-collide-1', 'chips-collide-2', 'chips-collide-3', 'chips-collide-4'], max: 0.25 },
  handle: { files: ['chips-handle-1', 'chips-handle-4', 'chips-handle-6'], max: 0.45 },
  riffle: { files: ['chips-handle-5'], max: 0.85 },
};

function prepare(raw: Float32Array, max: number): Float32Array {
  let peak = 0;
  for (const v of raw) peak = Math.max(peak, Math.abs(v));
  // Start 3 ms before the first sample above -26 dB of the peak.
  let start = raw.findIndex((v) => Math.abs(v) > peak * 0.05);
  start = Math.max(0, start - Math.round(RATE * 0.003));
  // End after the last 10 ms window that still reaches -40 dB, capped at `max`.
  const win = Math.round(RATE * 0.01);
  let end = start;
  for (let i = start; i < raw.length; i += win) {
    let m = 0;
    for (let j = i; j < Math.min(raw.length, i + win); j++) m = Math.max(m, Math.abs(raw[j]!));
    if (m > peak * 0.01) end = Math.min(raw.length, i + win);
  }
  end = Math.min(end, start + Math.round(RATE * max));
  const fade = Math.min(Math.round(RATE * 0.04), Math.floor((end - start) / 3));
  const out = raw.slice(start, end);
  for (let i = 0; i < fade; i++) out[out.length - 1 - i]! *= i / fade;
  const gain = 0.95 / peak;
  for (let i = 0; i < out.length; i++) out[i]! *= gain;
  return out;
}

const browser = await chromium.launch();
const page = await browser.newPage();
const clips: Record<string, Float32Array[]> = {};
let seconds = 0;
for (const [name, { files, max }] of Object.entries(SELECTION)) {
  clips[name] = [];
  for (const file of files) {
    const b64 = readFileSync(join(root, 'assets/sounds', `${file}.ogg`)).toString('base64');
    const mono: number[] = await page.evaluate(
      async ({ b64, rate }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const buf = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes.buffer);
        const out = new Float32Array(buf.length);
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length; i++) out[i]! += d[i]! / buf.numberOfChannels;
        }
        return Array.from(out);
      },
      { b64, rate: RATE },
    );
    const clip = prepare(Float32Array.from(mono), max);
    clips[name]!.push(clip);
    seconds += clip.length / RATE;
  }
}
await browser.close();
const bank = packSoundBank(RATE, clips);
writeFileSync(join(root, 'public/sounds.bin'), bank);
console.log(`Wrote public/sounds.bin: ${Object.keys(clips).length} sounds, ${seconds.toFixed(2)} s of audio, ${(bank.length / 1024).toFixed(0)} KB`);
