import { type Card, RANK_NAMES, RANK_PLURALS, rankOf } from './cards.ts';

/**
 * Hand evaluation for 5, 6 or 7 cards.
 *
 * The result is a single integer "score" where a higher score always means a stronger hand and
 * equal scores are exact ties:
 *
 *   score = category << 20 | r1 << 16 | r2 << 12 | r3 << 8 | r4 << 4 | r5
 *
 * r1..r5 are the ranks (0 = deuce … 12 = ace) that decide ties within the category, most
 * significant first (e.g. full house: trips rank, pair rank; two pair: high pair, low pair, kicker).
 * The evaluator is branch-light and allocation-free so the AI can run tens of thousands of
 * showdowns per decision.
 */
export const HandCategory = {
  HighCard: 0,
  Pair: 1,
  TwoPair: 2,
  Trips: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  Quads: 7,
  StraightFlush: 8,
} as const;
export type HandCategory = (typeof HandCategory)[keyof typeof HandCategory];

export const CATEGORY_NAMES = [
  'High Card',
  'One Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
] as const;

// ---------------------------------------------------------------------------------------------
// Lookup tables over 13-bit rank masks.

/** Highest rank of a 5-long run in the mask (3 for the A-2-3-4-5 wheel), or -1. */
const STRAIGHT_HIGH = new Int8Array(8192);
/** Top five ranks of the mask packed into nibbles, most significant first (r1 << 16 … r5). */
const TOP5 = new Int32Array(8192);

(function buildTables() {
  for (let mask = 0; mask < 8192; mask++) {
    let high = -1;
    for (let hi = 12; hi >= 4; hi--) {
      const window = 0x1f << (hi - 4);
      if ((mask & window) === window) {
        high = hi;
        break;
      }
    }
    if (high < 0 && (mask & 0x100f) === 0x100f) high = 3;
    STRAIGHT_HIGH[mask] = high;

    let packed = 0;
    let taken = 0;
    for (let r = 12; r >= 0 && taken < 5; r--) {
      if (mask & (1 << r)) {
        packed |= r << (16 - 4 * taken);
        taken++;
      }
    }
    TOP5[mask] = packed;
  }
})();

const rankCount = new Uint8Array(13);
const suitCount = new Uint8Array(4);
const suitMask = new Uint16Array(4);

/** Evaluates the best five-card hand available from the first n cards (5 ≤ n ≤ 7). */
export function evaluate(cards: ArrayLike<number>, n: number = cards.length): number {
  for (let i = 0; i < 13; i++) rankCount[i] = 0;
  suitCount[0] = suitCount[1] = suitCount[2] = suitCount[3] = 0;
  suitMask[0] = suitMask[1] = suitMask[2] = suitMask[3] = 0;
  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i]!;
    const r = c >> 2;
    const s = c & 3;
    rankCount[r]!++;
    suitCount[s]!++;
    suitMask[s]! |= 1 << r;
    rankMask |= 1 << r;
  }

  // With at most 7 cards a flush excludes quads and full houses, so it can be decided first.
  for (let s = 0; s < 4; s++) {
    if (suitCount[s]! >= 5) {
      const m = suitMask[s]!;
      const sf = STRAIGHT_HIGH[m]!;
      if (sf >= 0) return (8 << 20) | (sf << 16);
      return (5 << 20) | TOP5[m]!;
    }
  }

  let quad = -1;
  let trips1 = -1;
  let trips2 = -1;
  let pair1 = -1;
  let pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const cnt = rankCount[r]!;
    if (cnt === 4) quad = r;
    else if (cnt === 3) {
      if (trips1 < 0) trips1 = r;
      else if (trips2 < 0) trips2 = r;
    } else if (cnt === 2) {
      if (pair1 < 0) pair1 = r;
      else if (pair2 < 0) pair2 = r;
    }
  }

  if (quad >= 0) {
    const kicker = TOP5[rankMask & ~(1 << quad)]! >> 16;
    return (7 << 20) | (quad << 16) | (kicker << 12);
  }
  if (trips1 >= 0 && (trips2 >= 0 || pair1 >= 0)) {
    const pairRank = trips2 > pair1 ? trips2 : pair1;
    return (6 << 20) | (trips1 << 16) | (pairRank << 12);
  }
  const straight = STRAIGHT_HIGH[rankMask]!;
  if (straight >= 0) return (4 << 20) | (straight << 16);
  if (trips1 >= 0) {
    const kickers = TOP5[rankMask & ~(1 << trips1)]! >> 12; // top two
    return (3 << 20) | (trips1 << 16) | (kickers << 8);
  }
  if (pair2 >= 0) {
    const kicker = TOP5[rankMask & ~(1 << pair1) & ~(1 << pair2)]! >> 16;
    return (2 << 20) | (pair1 << 16) | (pair2 << 12) | (kicker << 8);
  }
  if (pair1 >= 0) {
    const kickers = TOP5[rankMask & ~(1 << pair1)]! >> 8; // top three
    return (1 << 20) | (pair1 << 16) | (kickers << 4);
  }
  return TOP5[rankMask]!;
}

export function categoryOf(score: number): HandCategory {
  return (score >> 20) as HandCategory;
}

function nib(score: number, index: number): number {
  return (score >> (16 - 4 * index)) & 0xf;
}

/** Short name of the hand category, with "Royal Flush" split out for display. */
export function categoryName(score: number): string {
  const cat = categoryOf(score);
  if (cat === HandCategory.StraightFlush && nib(score, 0) === 12) return 'Royal Flush';
  return CATEGORY_NAMES[cat];
}

/** Full description, e.g. "Full House, Kings full of Sevens". */
export function describeHand(score: number): string {
  const cat = categoryOf(score);
  const r = (i: number) => nib(score, i);
  switch (cat) {
    case HandCategory.StraightFlush:
      return r(0) === 12 ? 'Royal Flush' : `Straight Flush, ${RANK_NAMES[r(0)]} high`;
    case HandCategory.Quads:
      return `Four of a Kind, ${RANK_PLURALS[r(0)]}`;
    case HandCategory.FullHouse:
      return `Full House, ${RANK_PLURALS[r(0)]} full of ${RANK_PLURALS[r(1)]}`;
    case HandCategory.Flush:
      return `Flush, ${RANK_NAMES[r(0)]} high`;
    case HandCategory.Straight:
      return `Straight, ${RANK_NAMES[r(0)]} high`;
    case HandCategory.Trips:
      return `Three of a Kind, ${RANK_PLURALS[r(0)]}`;
    case HandCategory.TwoPair:
      return `Two Pair, ${RANK_PLURALS[r(0)]} and ${RANK_PLURALS[r(1)]}`;
    case HandCategory.Pair:
      return `Pair of ${RANK_PLURALS[r(0)]}`;
    default:
      return `High Card, ${RANK_NAMES[r(0)]}`;
  }
}

const COMBOS_CACHE = new Map<number, number[][]>();

function combinations(n: number, k: number): number[][] {
  const key = n * 16 + k;
  const cached = COMBOS_CACHE.get(key);
  if (cached) return cached;
  const out: number[][] = [];
  const pick: number[] = [];
  const rec = (start: number) => {
    if (pick.length === k) {
      out.push([...pick]);
      return;
    }
    for (let i = start; i < n; i++) {
      pick.push(i);
      rec(i + 1);
      pick.pop();
    }
  };
  rec(0);
  COMBOS_CACHE.set(key, out);
  return out;
}

/**
 * The five cards that make the best hand (used to highlight winning cards). When several
 * five-card subsets tie, the one using the highest cards is returned.
 */
export function bestFiveCards(cards: readonly Card[]): Card[] {
  if (cards.length < 5) return [...cards];
  const target = evaluate(cards);
  let best: Card[] | null = null;
  let bestSum = -1;
  for (const idx of combinations(cards.length, 5)) {
    const five = idx.map((i) => cards[i]!);
    if (evaluate(five) === target) {
      const sum = five.reduce((acc, c) => acc + rankOf(c), 0);
      if (sum > bestSum) {
        best = five;
        bestSum = sum;
      }
    }
  }
  return best ?? cards.slice(0, 5);
}
