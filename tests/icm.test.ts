import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from '../src/ai/decide.ts';
import { bubbleFactor, icmEquities, icmMatters, MAX_BUBBLE_FACTOR } from '../src/ai/icm.ts';
import { HoldemHand } from '../src/engine/hand.ts';
import { SeededRng } from '../src/engine/rng.ts';
import { riggedDeck, seats } from './helpers.ts';

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

test('ICM: equities follow the Malmuth–Harville model and share out the whole pool', () => {
  const eq = icmEquities([5000, 3000, 2000], [0.5, 0.3, 0.2]);
  // Worked by hand: P(1st) = 0.5; P(2nd) = 0.3·5/7 + 0.2·5/8; P(3rd) = the rest.
  const a = 0.5 * 0.5 + 0.3 * (0.3 * (5 / 7) + 0.2 * (5 / 8)) + 0.2 * (1 - 0.5 - (0.3 * (5 / 7) + 0.2 * (5 / 8)));
  assert.ok(near(eq[0]!, a), `chip leader ${eq[0]} vs ${a}`);
  assert.ok(
    near(
      eq.reduce((x, y) => x + y, 0),
      1,
    ),
  );
  assert.ok(eq[0]! < 0.5 && eq[2]! > 0.2, 'a big stack is worth less than its chip share, a small one more');

  // Winner-take-all is proportional to chips.
  assert.deepEqual(
    icmEquities([5000, 3000, 2000], [1]).map((x) => Math.round(x * 1000)),
    [500, 300, 200],
  );
  // A player with no chips takes the lowest remaining place.
  const bust = icmEquities([6000, 0, 4000], [0.5, 0.3, 0.2]);
  assert.ok(near(bust[1]!, 0.2));
  assert.ok(near(bust[0]! + bust[2]!, 0.8));
});

test('ICM: bubble factors are 1 without prize pressure and grow on the money bubble', () => {
  const stacks = [4000, 3000, 2000, 1000];
  assert.equal(bubbleFactor(stacks, [1], 1, 0, 3000), 1, 'winner-take-all: chips keep their value');
  assert.equal(bubbleFactor([5000, 5000], [0.65, 0.35], 0, 1, 5000), 1, 'heads-up for the last two prizes is linear');
  const medium = bubbleFactor(stacks, [0.5, 0.3, 0.2], 1, 0, 3000);
  assert.ok(medium > 2, `a medium stack risking its tournament against the leader: ${medium}`);
  const leader = bubbleFactor(stacks, [0.5, 0.3, 0.2], 0, 1, 3000);
  assert.ok(leader < medium, 'the chip leader feels less pressure than the stack it covers');

  // Property: never below 1, never above the cap, whatever the stacks.
  const rng = new SeededRng('icm-property');
  for (let t = 0; t < 300; t++) {
    const n = 3 + (rng.nextUint32() % 4);
    const s = Array.from({ length: n }, () => 100 + (rng.nextUint32() % 5000));
    const bf = bubbleFactor(s, [0.5, 0.3, 0.2], 0, 1 + (rng.nextUint32() % (n - 1)), 1 + (rng.nextUint32() % 5000));
    assert.ok(bf >= 1 && bf <= MAX_BUBBLE_FACTOR, `bubble factor ${bf} for ${s}`);
  }
  assert.equal(icmMatters([1]), false);
  assert.equal(icmMatters([0.65, 0.35]), true);
  assert.equal(icmMatters(undefined), false);
});

/**
 * Four left, three paid, blinds 100/200. The chip leader on the button moves all-in; the big
 * blind holds a hand that is a profitable call for chips but risks busting fourth with a short
 * stack still at the table.
 */
function bubbleSpot() {
  const setup = { handNumber: 40, seats: seats(6000, 900, 2600, 2500), button: 0, blinds: { smallBlind: 100, bigBlind: 200, ante: 0 } };
  const hand = HoldemHand.start(setup, riggedDeck(setup, { 2: 'Ad 9c' })).hand;
  hand.act(3, { kind: 'fold' });
  hand.act(0, { kind: 'raise', to: 6000 });
  hand.act(1, { kind: 'fold' });
  return hand.viewFor(2);
}

test('ICM: on the money bubble the AI folds a hand it calls when chips are all that count', () => {
  const view = bubbleSpot();
  const seedOf = (i: number) => [i + 1, (i * 2654435761) >>> 0, 77, 1] as [number, number, number, number];
  let chipCalls = 0;
  let icmCalls = 0;
  const trials = 24;
  for (let i = 0; i < trials; i++) {
    const base = { view, style: 'shark' as const, difficulty: 'elite' as const, stats: {}, tilt: 0, seed: seedOf(i) };
    if (decide(base).action.kind === 'call') chipCalls++;
    if (decide({ ...base, payouts: [0.5, 0.3, 0.2] }).action.kind === 'call') icmCalls++;
  }
  assert.ok(chipCalls >= trials * 0.6, `calls for chips ${chipCalls}/${trials}`);
  assert.ok(icmCalls <= trials * 0.25, `calls on the bubble ${icmCalls}/${trials}`);

  // Winner-take-all payouts change nothing.
  const base = { view, style: 'shark' as const, difficulty: 'pro' as const, stats: {}, tilt: 0, seed: seedOf(3) };
  assert.deepEqual(decide({ ...base, payouts: [1] }).debug.candidates, decide(base).debug.candidates);
});

test('coach: extra actions are priced alongside the engine’s own options', () => {
  const setup = { handNumber: 1, seats: seats(1000, 1000, 1000), button: 0, blinds: { smallBlind: 25, bigBlind: 50, ante: 0 } };
  const hand = HoldemHand.start(setup, riggedDeck(setup, { 0: 'Ks Kd' })).hand;
  const view = hand.viewFor(0);
  const odd = { kind: 'raise' as const, to: 175 };
  const d = decide({ view, style: 'shark', difficulty: 'pro', stats: {}, tilt: 0, seed: [1, 2, 3, 4], evaluate: [odd] });
  const priced = d.debug.candidates.find((c) => c.action.kind === 'raise' && c.action.to === 175);
  assert.ok(priced, `the requested raise is priced: ${d.debug.candidates.map((c) => c.label)}`);
  assert.ok(Number.isFinite(priced.ev));
});

test('an all-in call is priced on the chips it can win, not on an over-shove’s uncalled excess', () => {
  // The button covers the big blind by 3,400: only 2,600 of its 6,000 can be won by calling.
  const view = bubbleSpot();
  const d = decide({ view, style: 'shark', difficulty: 'elite', stats: {}, tilt: 0, seed: [5, 6, 7, 8] });
  const call = d.debug.candidates.find((c) => c.action.kind === 'call')!;
  const contestable = 100 + 2600 + 2600; // small blind + the big blind's stack + the matching part of the shove
  const expected = d.debug.equity * contestable - 2400;
  assert.ok(Math.abs(call.ev - expected) < 30, `call EV ${call.ev} vs equity × contestable pot − call = ${expected.toFixed(1)}`);
});
