/**
 * Randomness.
 *
 * - CryptoRng: the operating system CSPRNG (crypto.getRandomValues). Normal games shuffle with
 *   this directly, so every one of the 52! deck orders is reachable and nothing is predictable.
 * - SeededRng: sfc32 seeded through cyrb128. Deterministic; used for tests, simulations, replay,
 *   developer-seeded games, and the AI's own tie-breaking randomness (which is independent of
 *   the deck and reveals nothing about it).
 */
export interface Rng {
  /** Uniform unsigned 32-bit integer. */
  nextUint32(): number;
}

const TWO_32 = 4294967296;

/** Unbiased integer in [0, n) via rejection sampling. */
export function randomInt(rng: Rng, n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > TWO_32) throw new RangeError(`randomInt: bad bound ${n}`);
  const limit = TWO_32 - (TWO_32 % n);
  let x = rng.nextUint32();
  while (x >= limit) x = rng.nextUint32();
  return x % n;
}

/** Uniform float in [0, 1). */
export function randomUnit(rng: Rng): number {
  return rng.nextUint32() / TWO_32;
}

/** In-place Fisher–Yates shuffle. */
export function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

export class CryptoRng implements Rng {
  readonly #buffer = new Uint32Array(128);
  #index = 128;

  constructor() {
    if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
      // Never silently fall back to Math.random for dealing cards.
      throw new Error('A cryptographically secure random source is not available in this environment.');
    }
  }

  nextUint32(): number {
    if (this.#index >= this.#buffer.length) {
      globalThis.crypto.getRandomValues(this.#buffer);
      this.#index = 0;
    }
    return this.#buffer[this.#index++]!;
  }
}

export type SeedState = [number, number, number, number];

/** cyrb128 string hash → 128 bits of seed material. */
export function seedFromString(text: string): SeedState {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function isSeedState(value: unknown): value is SeedState {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < TWO_32)
  );
}

export class SeededRng implements Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: string | SeedState) {
    const s = typeof seed === 'string' ? seedFromString(seed) : seed;
    if (!isSeedState(s)) throw new Error('SeededRng: invalid seed state');
    this.#a = s[0];
    this.#b = s[1];
    this.#c = s[2];
    this.#d = s[3];
    // sfc32 with an all-zero state is degenerate; nudge it.
    if ((this.#a | this.#b | this.#c | this.#d) === 0) this.#d = 1;
    if (typeof seed === 'string') for (let i = 0; i < 15; i++) this.nextUint32();
  }

  /** Resumes a stream exactly where `state()` left it. */
  static fromState(state: SeedState): SeededRng {
    return new SeededRng([...state] as SeedState);
  }

  /**
   * Starts a fresh stream from arbitrary seed material. Unlike fromState, the seed is hashed so
   * that low-entropy seeds (small numbers, repeated words) still produce well-mixed output.
   */
  static fromSeed(seed: SeedState): SeededRng {
    return new SeededRng(seed.join(':'));
  }

  state(): SeedState {
    return [this.#a >>> 0, this.#b >>> 0, this.#c >>> 0, this.#d >>> 0];
  }

  nextUint32(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#c = (this.#c + t) | 0;
    return t >>> 0;
  }

  /** Derives an independent child stream (e.g. one per hand or per player). */
  fork(label: string): SeededRng {
    const [a, b, c, d] = this.state();
    return new SeededRng(`${a}:${b}:${c}:${d}/${label}`);
  }
}

/** A fresh, unpredictable 128-bit seed as a hex string. */
export function randomSeedString(): string {
  const rng = new CryptoRng();
  let out = '';
  for (let i = 0; i < 4; i++) out += rng.nextUint32().toString(16).padStart(8, '0');
  return out;
}

/** A fresh, unpredictable seed state. */
export function randomSeedState(): SeedState {
  const rng = new CryptoRng();
  return [rng.nextUint32(), rng.nextUint32(), rng.nextUint32(), (rng.nextUint32() | 1) >>> 0];
}
