import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPots, splitPot } from '../src/engine/pots.ts';
import { SeededRng, randomInt } from '../src/engine/rng.ts';

const c = (seat: number, amount: number, folded = false) => ({ seat, amount, folded });

test('single main pot when everyone contributes equally', () => {
  const pots = buildPots([c(0, 100), c(1, 100), c(2, 100)]);
  assert.equal(pots.length, 1);
  assert.equal(pots[0]!.amount, 300);
  assert.deepEqual(pots[0]!.eligible, [0, 1, 2]);
});

test('one short all-in creates a main pot and a side pot', () => {
  const pots = buildPots([c(0, 50), c(1, 200), c(2, 200)]);
  assert.deepEqual(
    pots.map((p) => [p.amount, p.eligible]),
    [
      [150, [0, 1, 2]],
      [300, [1, 2]],
    ],
  );
  assert.deepEqual(pots[1]!.contributions, { 1: 150, 2: 150 });
});

test('multiple all-ins with different stacks create layered side pots', () => {
  const pots = buildPots([c(0, 100), c(1, 300), c(2, 600), c(3, 1000)]);
  assert.deepEqual(
    pots.map((p) => [p.amount, p.eligible]),
    [
      [400, [0, 1, 2, 3]],
      [600, [1, 2, 3]],
      [600, [2, 3]],
      [400, [3]],
    ],
  );
});

test('folded contributors fund pots but are never eligible', () => {
  const pots = buildPots([c(0, 100), c(1, 250, true), c(2, 400), c(3, 400)]);
  assert.deepEqual(
    pots.map((p) => [p.amount, p.eligible]),
    [
      [400, [0, 2, 3]],
      [750, [2, 3]],
    ],
  );
  assert.equal(pots.reduce((s, p) => s + p.amount, 0), 1150);
});

test('folded chips above every live contribution are still awarded', () => {
  const pots = buildPots([c(0, 300, true), c(1, 200)]);
  assert.equal(pots.reduce((s, p) => s + p.amount, 0), 500);
  assert.deepEqual(pots[pots.length - 1]!.eligible, [1]);
});

test('odd chips go to winners closest to the left of the button', () => {
  // Button on seat 3 → order 0, 1, 2, 3.
  assert.deepEqual(splitPot(101, [2, 0], [0, 1, 2, 3]), [
    { seat: 0, amount: 51 },
    { seat: 2, amount: 50 },
  ]);
  // Button on seat 0 → order 1, 2, 3, 0.
  assert.deepEqual(splitPot(302, [0, 3, 1], [1, 2, 3, 0]), [
    { seat: 1, amount: 101 },
    { seat: 3, amount: 101 },
    { seat: 0, amount: 100 },
  ]);
  assert.throws(() => splitPot(10, [], [0, 1]));
});

test('randomised: pots always sum to contributions and nest correctly', () => {
  const rng = new SeededRng('pots-fuzz');
  for (let iter = 0; iter < 5000; iter++) {
    const n = 2 + randomInt(rng, 7);
    const contribs = Array.from({ length: n }, (_, seat) => c(seat, randomInt(rng, 6) * 50 + randomInt(rng, 3), randomInt(rng, 4) === 0));
    if (contribs.every((x) => x.folded || x.amount === 0)) contribs[0] = c(0, 100);
    const pots = buildPots(contribs);
    const total = contribs.reduce((s, x) => s + x.amount, 0);
    assert.equal(pots.reduce((s, p) => s + p.amount, 0), total);
    for (let i = 1; i < pots.length; i++) {
      for (const seat of pots[i]!.eligible) assert.ok(pots[i - 1]!.eligible.includes(seat), 'side pot eligibility must nest');
    }
    for (const p of pots) {
      assert.ok(p.eligible.every((seat) => !contribs[seat]!.folded));
      assert.equal(Object.values(p.contributions).reduce((a, b) => a + b, 0), p.amount);
      const winners = p.eligible.filter(() => randomInt(rng, 2) === 0);
      const w = winners.length ? winners : [p.eligible[0]!];
      const shares = splitPot(p.amount, w, contribs.map((x) => x.seat));
      assert.equal(shares.reduce((s, x) => s + x.amount, 0), p.amount);
      assert.ok(Math.max(...shares.map((x) => x.amount)) - Math.min(...shares.map((x) => x.amount)) <= 1);
    }
  }
});
