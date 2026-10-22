/**
 * The recorded-sound bank: real card and chip recordings (Kenney's "Casino Audio", CC0) packed by
 * scripts/gen-sounds.ts into one small file, public/sounds.bin.
 *
 * Layout: the bytes "VSND", a little-endian uint32 header length, a UTF-8 JSON header
 * `{ rate, clips: { name: [[offset, length], ...] } }`, then 8-bit µ-law samples (mono). µ-law
 * is decoded here rather than by the browser's audio decoder, so every engine plays the same
 * bytes — Safari before 17 cannot decode Ogg, and WAV at full resolution would be four times larger.
 */
export interface SoundBank {
  rate: number;
  clips: Record<string, Float32Array[]>;
}

const MAGIC = 'VSND';
const MU = 255;

/** Encodes one sample in [-1, 1] as a µ-law byte (128 is silence). */
export function muLawEncode(x: number): number {
  const v = Math.max(-1, Math.min(1, x));
  const y = (Math.sign(v) * Math.log1p(MU * Math.abs(v))) / Math.log1p(MU);
  return Math.round(y * 127) + 128;
}

const DECODE = Float32Array.from({ length: 256 }, (_, b) => {
  const y = (b - 128) / 127;
  return (Math.sign(y) * Math.expm1(Math.abs(y) * Math.log1p(MU))) / MU;
});

export function muLawDecode(byte: number): number {
  return DECODE[byte & 255]!;
}

export function packSoundBank(rate: number, clips: Record<string, Float32Array[]>): Uint8Array {
  const index: Record<string, [number, number][]> = {};
  let offset = 0;
  for (const [name, variants] of Object.entries(clips)) {
    index[name] = variants.map((v) => {
      const at: [number, number] = [offset, v.length];
      offset += v.length;
      return at;
    });
  }
  const header = new TextEncoder().encode(JSON.stringify({ rate, clips: index }));
  const out = new Uint8Array(8 + header.length + offset);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  let at = 8 + header.length;
  for (const variants of Object.values(clips)) {
    for (const v of variants) for (let i = 0; i < v.length; i++) out[at++] = muLawEncode(v[i]!);
  }
  return out;
}

/** Parses a sound bank, or returns null if the bytes are not one (never throws). */
export function parseSoundBank(buffer: ArrayBuffer): SoundBank | null {
  try {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) return null;
    const headerLength = new DataView(buffer).getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength))) as {
      rate: number;
      clips: Record<string, [number, number][]>;
    };
    const data = bytes.subarray(8 + headerLength);
    if (!Number.isFinite(header.rate) || header.rate < 8000 || header.rate > 96000) return null;
    const clips: Record<string, Float32Array[]> = {};
    for (const [name, ranges] of Object.entries(header.clips)) {
      clips[name] = ranges.map(([offset, length]) => {
        if (offset < 0 || length <= 0 || offset + length > data.length) throw new Error('clip out of range');
        const out = new Float32Array(length);
        for (let i = 0; i < length; i++) out[i] = DECODE[data[offset + i]!]!;
        return out;
      });
    }
    return { rate: header.rate, clips };
  } catch {
    return null;
  }
}
