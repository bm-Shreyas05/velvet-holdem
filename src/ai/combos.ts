import { type Card, RANK_CHARS, rankOf, suitOf } from '../engine/cards.ts';

/**
 * The 1,326 two-card starting combinations, and the 169 strategic hand classes (AKs, AKo, QQ…).
 * Ranges are weight vectors over the 1,326 combos so card removal is exact.
 */
export const COMBO_COUNT = 1326;
export const COMBO_A = new Uint8Array(COMBO_COUNT);
export const COMBO_B = new Uint8Array(COMBO_COUNT);
const INDEX = new Int16Array(52 * 52).fill(-1);
/** 13×13 grid index: pairs on the diagonal, suited hi*13+lo, offsuit lo*13+hi. */
export const COMBO_CLASS = new Uint8Array(COMBO_COUNT);

(function build() {
  let k = 0;
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      COMBO_A[k] = a;
      COMBO_B[k] = b;
      INDEX[a * 52 + b] = k;
      INDEX[b * 52 + a] = k;
      COMBO_CLASS[k] = classOf(a, b);
      k++;
    }
  }
})();

export function comboIndex(a: Card, b: Card): number {
  return INDEX[a * 52 + b]!;
}

export function classOf(a: Card, b: Card): number {
  const ra = rankOf(a);
  const rb = rankOf(b);
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  if (hi === lo) return hi * 13 + hi;
  return suitOf(a) === suitOf(b) ? hi * 13 + lo : lo * 13 + hi;
}

export function className(cls: number): string {
  const r1 = Math.floor(cls / 13);
  const r2 = cls % 13;
  if (r1 === r2) return RANK_CHARS[r1]! + RANK_CHARS[r2]!;
  return r1 > r2 ? `${RANK_CHARS[r1]}${RANK_CHARS[r2]}s` : `${RANK_CHARS[r2]}${RANK_CHARS[r1]}o`;
}

/** Number of card combinations in a class (6 pairs, 4 suited, 12 offsuit). */
export function classComboCount(cls: number): number {
  const r1 = Math.floor(cls / 13);
  const r2 = cls % 13;
  return r1 === r2 ? 6 : r1 > r2 ? 4 : 12;
}

/** Bit mask helpers for the 52-card set (two 32-bit halves avoid BigInt in hot loops). */
export function comboConflicts(k: number, deadLo: number, deadHi: number): boolean {
  const a = COMBO_A[k]!;
  const b = COMBO_B[k]!;
  return hasCard(a, deadLo, deadHi) || hasCard(b, deadLo, deadHi);
}

export function hasCard(c: number, lo: number, hi: number): boolean {
  return c < 32 ? (lo & (1 << c)) !== 0 : (hi & (1 << (c - 32))) !== 0;
}

export function cardMask(cards: readonly Card[]): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const c of cards) {
    if (c < 32) lo |= 1 << c;
    else hi |= 1 << (c - 32);
  }
  return [lo, hi];
}
