import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Card, cardToString, orderedDeck, parseCards } from '../src/engine/cards.ts';
import {
  CATEGORY_NAMES,
  HandCategory,
  bestFiveCards,
  categoryName,
  categoryOf,
  describeHand,
  evaluate,
} from '../src/engine/evaluator.ts';
import { SeededRng, shuffle } from '../src/engine/rng.ts';

const ev = (s: string) => evaluate(parseCards(s));

/** Independent reference evaluator for five cards (sorting-based, deliberately naive). */
function naive5(cards: Card[]): number {
  const ranks = cards.map((c) => c >> 2).sort((a, b) => b - a);
  const flush = cards.every((c) => (c & 3) === (cards[0]! & 3));
  const distinct = [...new Set(ranks)];
  let straightHigh = -1;
  if (distinct.length === 5) {
    if (ranks[0]! - ranks[4]! === 4) straightHigh = ranks[0]!;
    else if (ranks.join() === '12,3,2,1,0') straightHigh = 3;
  }
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const pack = (cat: number, rs: number[]) => rs.reduce((acc, r, i) => acc | (r << (16 - 4 * i)), cat << 20);
  const g = groups.map((x) => x[0]);
  if (straightHigh >= 0 && flush) return pack(8, [straightHigh]);
  if (groups[0]![1] === 4) return pack(7, g);
  if (groups[0]![1] === 3 && groups[1]![1] === 2) return pack(6, g);
  if (flush) return pack(5, ranks);
  if (straightHigh >= 0) return pack(4, [straightHigh]);
  if (groups[0]![1] === 3) return pack(3, g);
  if (groups[0]![1] === 2 && groups[1]![1] === 2) return pack(2, g);
  if (groups[0]![1] === 2) return pack(1, g);
  return pack(0, ranks);
}

function bestOf(cards: Card[]): number {
  let best = -1;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) best = Math.max(best, naive5([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]));
  return best;
}

test('every category is recognised', () => {
  const cases: [string, number, string][] = [
    ['As Ks Qs Js Ts 2d 3c', HandCategory.StraightFlush, 'Royal Flush'],
    ['9h 8h 7h 6h 5h Ac Kd', HandCategory.StraightFlush, 'Straight Flush, Nine high'],
    ['7c 7d 7h 7s Kd 2c 3c', HandCategory.Quads, 'Four of a Kind, Sevens'],
    ['Kc Kd Kh 4s 4d 2c 9h', HandCategory.FullHouse, 'Full House, Kings full of Fours'],
    ['Ah Jh 8h 4h 2h Kc Qd', HandCategory.Flush, 'Flush, Ace high'],
    ['9c Td Jh Qs Kd 2c 3h', HandCategory.Straight, 'Straight, King high'],
    ['5c 5d 5h Ks 9d 2c 3h', HandCategory.Trips, 'Three of a Kind, Fives'],
    ['Jc Jd 4h 4s Ad 2c 8h', HandCategory.TwoPair, 'Two Pair, Jacks and Fours'],
    ['Qc Qd 9h 7s 4d 2c 3h', HandCategory.Pair, 'Pair of Queens'],
    ['Ac Jd 9h 7s 4d 2c 3h', HandCategory.HighCard, 'High Card, Ace'],
  ];
  for (const [cards, cat, desc] of cases) {
    const score = ev(cards);
    assert.equal(categoryOf(score), cat, cards);
    assert.equal(describeHand(score), desc, cards);
  }
  assert.equal(CATEGORY_NAMES.length, 9);
  assert.equal(categoryName(ev('As Ks Qs Js Ts')), 'Royal Flush');
});

test('ace-low and ace-high straights', () => {
  const wheel = ev('Ac 2d 3h 4s 5d Kc Qh');
  const sixHigh = ev('2d 3h 4s 5d 6c Kc Qh');
  const broadway = ev('Tc Jd Qh Ks Ad 2c 3h');
  assert.equal(categoryOf(wheel), HandCategory.Straight);
  assert.equal(describeHand(wheel), 'Straight, Five high');
  assert.ok(sixHigh > wheel);
  assert.ok(broadway > sixHigh);
  // No wrap-around straights.
  assert.equal(categoryOf(ev('Qc Kd Ah 2s 3d 8c 9h')), HandCategory.HighCard);
  // Steel wheel is a straight flush, the lowest one.
  const steel = ev('Ah 2h 3h 4h 5h Kc Kd');
  assert.equal(describeHand(steel), 'Straight Flush, Five high');
  assert.ok(steel < ev('2h 3h 4h 5h 6h Kc Kd'));
  assert.ok(steel > ev('Kc Kd Kh Ks Ad 2c 3c'));
});

test('tie-breakers within each category', () => {
  const gt = (a: string, b: string) => assert.ok(ev(a) > ev(b), `${a} should beat ${b}`);
  const eq = (a: string, b: string) => assert.equal(ev(a), ev(b), `${a} should tie ${b}`);
  // Flushes compare all five cards.
  gt('Ah Kh 9h 5h 3h', 'Ad Kd 9d 5d 2d');
  gt('Ah Qh 9h 5h 3h Kh', 'Ad Kd 9d 5d 2d'); // six hearts: best five used
  // Full houses: trips first, then pair.
  gt('Qc Qd Qh 2s 2d', 'Jc Jd Jh As Ad');
  gt('Qc Qd Qh 3s 3d', 'Qc Qd Qh 2s 2d');
  eq('Kc Kd Kh 7s 7d 7h 2c', 'Kc Kd Kh 7s 7d 2d 3c'); // two trips: second trips plays as the pair
  // Quads: kicker decides.
  gt('9c 9d 9h 9s Ad', '9c 9d 9h 9s Kd');
  eq('9c 9d 9h 9s Ad Kc Qc', '9c 9d 9h 9s Ad 2c 3c');
  // Two pair: high pair, low pair, kicker; third pair can be the kicker.
  gt('Ac Ad 3h 3s Kd', 'Kc Kd Qh Qs Ad');
  gt('Ac Ad 4h 4s 2d', 'Ac Ad 3h 3s Kd');
  gt('Ac Ad 4h 4s Qd', 'Ac Ad 4h 4s Jd');
  eq('Ac Ad 4h 4s 3d 3c 2h', 'Ac Ad 4h 4s 3d 2c 2h'); // third pair's rank serves as the kicker
  // Pair kickers.
  gt('8c 8d Ah 5s 3d', '8c 8d Kh Qs Jd');
  gt('8c 8d Ah 5s 4d', '8c 8d Ah 5s 3d');
  // Trips kickers.
  gt('5c 5d 5h As 2d', '5c 5d 5h Ks Qd');
  // High card all five.
  gt('Ac Jd 9h 7s 3d', 'Ac Jd 9h 7s 2d');
  // Straights compare high card only; suits never matter.
  eq('5c 6d 7h 8s 9d', '5h 6h 7c 8d 9s');
  // Straight flushes.
  gt('Tc Jc Qc Kc 9c', '9d Td Jd Qd 8d');
  // Exact ties: board plays.
  eq('2c 3d Ah Kh Qh Jh Th', '4c 5d Ah Kh Qh Jh Th');
});

test('five-card enumeration matches the known distribution and 7,462 distinct hand values', () => {
  const deck = orderedDeck();
  const counts = new Array(9).fill(0);
  const distinct = new Set<number>();
  const hand = new Int32Array(5);
  let royals = 0;
  for (let a = 0; a < 52; a++)
    for (let b = a + 1; b < 52; b++)
      for (let c = b + 1; c < 52; c++)
        for (let d = c + 1; d < 52; d++)
          for (let e = d + 1; e < 52; e++) {
            hand[0] = deck[a]!;
            hand[1] = deck[b]!;
            hand[2] = deck[c]!;
            hand[3] = deck[d]!;
            hand[4] = deck[e]!;
            const s = evaluate(hand, 5);
            counts[s >> 20]++;
            distinct.add(s);
            if (s === ((8 << 20) | (12 << 16))) royals++;
          }
  assert.deepEqual(counts, [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40]);
  assert.equal(royals, 4);
  assert.equal(distinct.size, 7462);
});

test('seven-card evaluation equals best-of-21 under an independent evaluator (random sample)', () => {
  const rng = new SeededRng('evaluator-crosscheck');
  for (let i = 0; i < 40000; i++) {
    const cards = shuffle(orderedDeck(), rng).slice(0, 7);
    const fast = evaluate(cards);
    const slow = bestOf(cards);
    if (fast !== slow) assert.fail(`mismatch for ${cards.map(cardToString).join(' ')}: ${fast} vs ${slow}`);
    const six = cards.slice(0, 6);
    if (evaluate(six) !== bestOf(six)) assert.fail(`6-card mismatch ${six.map(cardToString).join(' ')}`);
  }
});

test('bestFiveCards returns five cards that make exactly the evaluated hand', () => {
  const rng = new SeededRng('best-five');
  for (let i = 0; i < 2000; i++) {
    const cards = shuffle(orderedDeck(), rng).slice(0, 7);
    const five = bestFiveCards(cards);
    assert.equal(five.length, 5);
    assert.ok(five.every((c) => cards.includes(c)));
    assert.equal(evaluate(five), evaluate(cards));
  }
});

test('evaluation is deterministic and independent of card order', () => {
  const rng = new SeededRng('order');
  for (let i = 0; i < 2000; i++) {
    const cards = shuffle(orderedDeck(), rng).slice(0, 7);
    const s = evaluate(cards);
    assert.equal(evaluate(shuffle([...cards], rng)), s);
    assert.equal(evaluate(cards), s);
  }
});
