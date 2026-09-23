import type { Card } from '../engine/cards.ts';
import { evaluate } from '../engine/evaluator.ts';
import { COMBO_A, COMBO_B, COMBO_CLASS, COMBO_COUNT, cardMask, comboConflicts, hasCard } from './combos.ts';
import { PREFLOP_EQUITY_HU } from './preflop-table.ts';

/**
 * Strength of every possible holding on a given board, as a percentile in [0, 1] among all
 * holdings that do not conflict with the board. Computed only from public cards, so tables can be
 * cached and shared by all AI seats without leaking anything.
 *
 * - Preflop: percentile of the class's all-in equity.
 * - Flop/turn: a blend of the current percentile and the average percentile after the next card,
 *   so draws are valued for what they can become.
 * - River: current percentile.
 *
 * Combos that conflict with the board get -1.
 */

const PREFLOP = (() => {
  const out = new Float32Array(COMBO_COUNT);
  const order = Array.from({ length: COMBO_COUNT }, (_, k) => k).sort(
    (x, y) => PREFLOP_EQUITY_HU[COMBO_CLASS[x]!]! - PREFLOP_EQUITY_HU[COMBO_CLASS[y]!]!,
  );
  let i = 0;
  while (i < order.length) {
    let j = i;
    const eq = PREFLOP_EQUITY_HU[COMBO_CLASS[order[i]!]!]!;
    while (j < order.length && PREFLOP_EQUITY_HU[COMBO_CLASS[order[j]!]!]! === eq) j++;
    const pct = (i + (j - i) / 2) / order.length;
    for (let t = i; t < j; t++) out[order[t]!] = pct;
    i = j;
  }
  return out;
})();

const scratch = new Int32Array(7);
const keys = new Float64Array(COMBO_COUNT);

/** Percentile of each non-conflicting combo's hand value on `board` (length 3–5). */
function percentiles(board: readonly Card[], out: Float32Array, accumulate: boolean): void {
  const [lo, hi] = cardMask(board);
  const n = board.length;
  for (let i = 0; i < n; i++) scratch[2 + i] = board[i]!;
  let m = 0;
  for (let k = 0; k < COMBO_COUNT; k++) {
    if (comboConflicts(k, lo, hi)) continue;
    scratch[0] = COMBO_A[k]!;
    scratch[1] = COMBO_B[k]!;
    keys[m++] = evaluate(scratch, n + 2) * 2048 + k;
  }
  const sorted = keys.subarray(0, m).sort();
  let i = 0;
  while (i < m) {
    const score = Math.floor(sorted[i]! / 2048);
    let j = i;
    while (j < m && Math.floor(sorted[j]! / 2048) === score) j++;
    const pct = (i + (j - i) / 2) / m;
    for (let t = i; t < j; t++) {
      const k = sorted[t]! - score * 2048;
      out[k] = accumulate ? out[k]! + pct : pct;
    }
    i = j;
  }
}

function compute(board: readonly Card[]): Float32Array {
  if (board.length === 0) return PREFLOP;
  const out = new Float32Array(COMBO_COUNT).fill(-1);
  const [lo, hi] = cardMask(board);
  percentiles(board, out, false);
  if (board.length === 5) return out;

  // One-card look-ahead: average percentile over every possible next card.
  const sum = new Float32Array(COMBO_COUNT);
  const count = new Uint8Array(COMBO_COUNT);
  const next = new Float32Array(COMBO_COUNT);
  const extended = [...board, 0];
  for (let c = 0; c < 52; c++) {
    if (hasCard(c, lo, hi)) continue;
    extended[board.length] = c;
    next.fill(-1);
    percentiles(extended, next, false);
    for (let k = 0; k < COMBO_COUNT; k++) {
      if (next[k]! >= 0) {
        sum[k]! += next[k]!;
        count[k]!++;
      }
    }
  }
  const nowWeight = board.length === 3 ? 0.35 : 0.5;
  for (let k = 0; k < COMBO_COUNT; k++) {
    if (out[k]! < 0) continue;
    out[k] = nowWeight * out[k]! + (1 - nowWeight) * (sum[k]! / count[k]!);
  }
  return out;
}

const cache = new Map<string, Float32Array>();
const CACHE_LIMIT = 48;

export function boardStrength(board: readonly Card[]): Float32Array {
  const key = [...board].sort((a, b) => a - b).join(',');
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const table = compute(board);
  cache.set(key, table);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return table;
}

/** Current made-hand percentile (no look-ahead) — used to judge shown-down bluffs. */
export function madeHandPercentile(board: readonly Card[], combo: number): number {
  if (board.length < 3) return PREFLOP[combo]!;
  const key = `made:${[...board].sort((a, b) => a - b).join(',')}`;
  let table = cache.get(key);
  if (!table) {
    table = new Float32Array(COMBO_COUNT).fill(-1);
    percentiles(board, table, false);
    cache.set(key, table);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  return table[combo]!;
}

export function preflopStrength(combo: number): number {
  return PREFLOP[combo]!;
}

/**
 * Board texture in [0, 1]: how many strong draws and coordinated cards the board holds. Used for
 * bet sizing and trap decisions (0 = dry rainbow, 1 = very wet).
 */
export function boardWetness(board: readonly Card[]): number {
  if (board.length < 3) return 0;
  const suits = [0, 0, 0, 0];
  let mask = 0;
  for (const c of board) {
    suits[c & 3]!++;
    mask |= 1 << (c >> 2);
  }
  if (mask & (1 << 12)) mask |= 1 << 13; // ace plays low too (bit 13 unused otherwise)
  const maxSuit = Math.max(...suits);
  let connected = 0;
  for (let hi = 13; hi >= 4; hi--) {
    let inWindow = 0;
    for (let r = hi - 4; r <= hi; r++) if (mask & (1 << (r === 13 ? 12 : r))) inWindow++;
    connected = Math.max(connected, inWindow);
  }
  const flushiness = maxSuit >= 3 ? 0.55 : maxSuit === 2 ? 0.3 : 0;
  const straightiness = connected >= 4 ? 0.5 : connected === 3 ? 0.3 : connected === 2 ? 0.1 : 0;
  const paired = new Set(board.map((c) => c >> 2)).size < board.length ? -0.1 : 0;
  return Math.max(0, Math.min(1, flushiness + straightiness + paired));
}
