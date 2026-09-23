import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardToString } from '../src/engine/cards.ts';
import { Deck } from '../src/engine/deck.ts';
import { HoldemHand, IllegalActionError } from '../src/engine/hand.ts';
import { SeededRng } from '../src/engine/rng.ts';
import type { HandEvent } from '../src/engine/types.ts';
import { eventsVisibleTo } from '../src/engine/types.ts';
import { randomLegalAction } from '../src/sim/bots.ts';
import { BLINDS, play, seats, stacksOf, startHand } from './helpers.ts';

const setup4 = (...stacks: number[]) => ({ handNumber: 1, seats: seats(...stacks), button: 0, blinds: BLINDS });

test('blinds are posted and action starts under the gun', () => {
  const { hand } = startHand(setup4(1000, 1000, 1000, 1000));
  const v = hand.viewFor(null);
  assert.equal(v.smallBlindSeat, 1);
  assert.equal(v.bigBlindSeat, 2);
  assert.deepEqual(v.seats.map((s) => s.streetCommit), [0, 25, 50, 0]);
  assert.equal(v.pot, 75);
  assert.equal(hand.toAct, 3);
  const legal = hand.legalActions()!;
  assert.equal(legal.toCall, 50);
  assert.equal(legal.aggression, 'raise');
  assert.equal(legal.minTo, 100);
  assert.equal(legal.maxTo, 1000);
  assert.equal(legal.canCheck, false);
});

test('everyone folds to the big blind: BB wins the small blind and keeps its own', () => {
  const { hand } = startHand(setup4(1000, 1000, 1000, 1000));
  play(hand, [
    [3, 'fold'],
    [0, 'fold'],
    [1, 'fold'],
  ]);
  assert.ok(hand.isComplete);
  assert.deepEqual(stacksOf(hand), [1000, 975, 1025, 1000]);
  const r = hand.result!;
  assert.equal(r.showdown, false);
  assert.deepEqual(r.uncalled, [{ seat: 2, amount: 25 }]);
});

test('limped pot gives the big blind the option; postflop action starts left of the button', () => {
  const { hand } = startHand(setup4(1000, 1000, 1000, 1000));
  play(hand, [
    [3, 'call'],
    [0, 'call'],
    [1, 'call'],
  ]);
  assert.equal(hand.toAct, 2);
  const legal = hand.legalActions()!;
  assert.ok(legal.canCheck);
  assert.ok(!legal.canFold, 'folding is never offered when checking is free');
  assert.equal(legal.aggression, 'raise');
  assert.equal(legal.minTo, 100);
  play(hand, [[2, 'check']]);
  const v = hand.viewFor(null);
  assert.equal(v.street, 'flop');
  assert.equal(v.board.length, 3);
  assert.equal(v.pot, 200);
  assert.equal(hand.toAct, 1);
  assert.equal(hand.legalActions()!.aggression, 'bet');
  assert.equal(hand.legalActions()!.minTo, 50);
});

test('heads-up: the button posts the small blind, acts first preflop and last postflop', () => {
  const { hand } = startHand({ handNumber: 1, seats: seats(1000, 1000), button: 0, blinds: BLINDS });
  const v = hand.viewFor(null);
  assert.equal(v.smallBlindSeat, 0);
  assert.equal(v.bigBlindSeat, 1);
  assert.equal(hand.toAct, 0);
  play(hand, [
    [0, 'call'],
    [1, 'check'],
  ]);
  assert.equal(hand.viewFor(null).street, 'flop');
  assert.equal(hand.toAct, 1);
});

test('heads-up with an empty seat between the players', () => {
  const { hand } = startHand({ handNumber: 1, seats: [{ id: 'a', stack: 1000 }, null, { id: 'b', stack: 1000 }], button: 2, blinds: BLINDS });
  const v = hand.viewFor(null);
  assert.equal(v.smallBlindSeat, 2);
  assert.equal(v.bigBlindSeat, 0);
  assert.equal(hand.toAct, 2);
  play(hand, [
    [2, 'call'],
    [0, 'check'],
  ]);
  assert.equal(hand.toAct, 0);
});

test('minimum raise is the size of the last full raise', () => {
  const { hand } = startHand(setup4(1000, 1000, 1000, 1000));
  play(hand, [[3, 'raise', 150]]);
  const legal = hand.legalActions()!;
  assert.equal(legal.minTo, 250);
  assert.throws(() => hand.act(0, { kind: 'raise', to: 200 }), IllegalActionError);
  assert.throws(() => hand.act(0, { kind: 'raise', to: 1001 }), IllegalActionError);
  assert.throws(() => hand.act(0, { kind: 'raise', to: 250.5 }), IllegalActionError);
  play(hand, [[0, 'raise', 250]]);
  assert.equal(hand.legalActions()!.minTo, 350);
  play(hand, [[1, 'raise', 600]]);
  assert.equal(hand.legalActions()!.minTo, 950);
});

test('an all-in for less than a full raise does not reopen betting for players who already acted', () => {
  const { hand } = startHand(setup4(200, 1000, 1000, 1000));
  play(hand, [
    [3, 'raise', 150],
    [0, 'raise', 200], // all-in: only a 50 raise
    [1, 'fold'],
  ]);
  // The big blind has not acted yet, so it may raise.
  let legal = hand.legalActions()!;
  assert.equal(hand.toAct, 2);
  assert.equal(legal.aggression, 'raise');
  assert.equal(legal.minTo, 300);
  play(hand, [[2, 'call']]);
  // UTG already acted and faces only 50 more: call or fold only.
  legal = hand.legalActions()!;
  assert.equal(hand.toAct, 3);
  assert.equal(legal.aggression, null);
  assert.equal(legal.toCall, 50);
  assert.throws(() => hand.act(3, { kind: 'raise', to: 400 }), IllegalActionError);
  play(hand, [[3, 'call']]);
  assert.equal(hand.viewFor(null).street, 'flop');
});

test('several short all-ins that add up to a full raise do reopen the betting', () => {
  const { hand } = startHand(setup4(1000, 1000, 1000, 450));
  play(hand, [
    [3, 'call'],
    [0, 'call'],
    [1, 'call'],
    [2, 'check'],
    [1, 'bet', 100],
    [2, 'raise', 300], // full raise of 200
    [3, 'raise', 400], // all-in, only +100
    [0, 'call'],
  ]);
  // Seat 1 bet 100 and now faces 300 more, which is at least a full raise (200): may re-raise.
  let legal = hand.legalActions()!;
  assert.equal(hand.toAct, 1);
  assert.equal(legal.aggression, 'raise');
  assert.equal(legal.minTo, 600);
  play(hand, [[1, 'call']]);
  // Seat 2 faces only the +100 from the short all-in: no re-raise.
  legal = hand.legalActions()!;
  assert.equal(hand.toAct, 2);
  assert.equal(legal.aggression, null);
  assert.equal(legal.toCall, 100);
});

test('multiple all-ins with different stacks build exact side pots', () => {
  const setup = setup4(100, 300, 600, 1000);
  const { hand } = startHand(setup, { 0: 'As Ad', 1: 'Ks Kd', 2: 'Qs Qd', 3: '7d 4h' }, '2c 5d 9h Js 3c');
  const events = play(hand, [
    [3, 'raise', 1000],
    [0, 'call'],
    [1, 'call'],
    [2, 'call'],
  ]);
  assert.ok(hand.isComplete);
  const r = hand.result!;
  assert.deepEqual(r.uncalled, [{ seat: 3, amount: 400 }]);
  assert.deepEqual(
    r.pots.map((p) => [p.amount, p.eligible, p.winners]),
    [
      [400, [0, 1, 2, 3], [0]],
      [600, [1, 2, 3], [1]],
      [600, [2, 3], [2]],
    ],
  );
  assert.deepEqual(stacksOf(hand), [400, 600, 600, 400]);
  assert.equal(stacksOf(hand).reduce((a, b) => a + b, 0), 2000);
  // All-in: every hand is turned over before the run-out.
  const reveals = events.filter((e) => e.type === 'reveal');
  assert.equal(reveals.length, 4);
  assert.ok(reveals.every((e) => e.type === 'reveal' && e.reason === 'all-in'));
});

test('a short all-in wins the main pot and the uncalled excess is returned', () => {
  const setup = setup4(100, 1000, 1000, 1000);
  const { hand } = startHand(setup, { 0: 'As Ad', 1: 'Ks Kd', 2: '7c 2d', 3: '8c 3d' }, '2c 5d 9h Js 4s');
  play(hand, [
    [3, 'call'],
    [0, 'raise', 100],
    [1, 'raise', 400],
    [2, 'fold'],
    [3, 'fold'],
  ]);
  assert.ok(hand.isComplete);
  const r = hand.result!;
  // Main: 100×2 (seats 0,1) + 50 (seat 2's blind) + 50 (seat 3's limp) = 300, won by aces.
  assert.deepEqual(r.pots.map((p) => [p.amount, p.winners]), [[300, [0]]]);
  assert.deepEqual(r.uncalled, [{ seat: 1, amount: 300 }]);
  assert.deepEqual(stacksOf(hand), [300, 900, 950, 950]);
});

test('folded players contribute to side pots but cannot win them', () => {
  const setup = setup4(1000, 300, 1000, 1000);
  const { hand } = startHand(setup, { 0: 'Qs Qd', 1: 'As Ad', 2: 'Ks Kd', 3: '7c 2d' }, '2c 5d 9h Js 4s');
  play(hand, [
    [3, 'call'],
    [0, 'raise', 300],
    [1, 'call'], // seat 1 all-in 300
    [2, 'call'],
    [3, 'call'],
    // Flop: seat 2 first (seat 1 all-in).
    [2, 'bet', 200],
    [3, 'fold'],
    [0, 'call'],
    [2, 'check'],
    [0, 'check'],
    [2, 'check'],
    [0, 'check'],
  ]);
  const r = hand.result!;
  assert.deepEqual(
    r.pots.map((p) => [p.amount, p.eligible, p.winners]),
    [
      [1200, [0, 1, 2], [1]],
      [400, [0, 2], [2]],
    ],
  );
  assert.equal(r.pots[0]!.contributions[3], 300);
  assert.deepEqual(stacksOf(hand), [500, 1200, 900, 700]);
});

test('split pot with an odd chip: extra chip goes left of the button', () => {
  const setup = setup4(1000, 1000, 1000, 1000);
  const { hand } = startHand(setup, { 0: '2c 3c', 1: '4c 5c', 2: '2d 3d', 3: '4d 5d' }, 'As Ks Qs Js Ts');
  play(hand, [
    [3, 'raise', 101],
    [0, 'fold'],
    [1, 'fold'],
    [2, 'call'],
    [2, 'check'],
    [3, 'check'],
    [2, 'check'],
    [3, 'check'],
    [2, 'check'],
    [3, 'check'],
  ]);
  const r = hand.result!;
  assert.equal(r.pots.length, 1);
  assert.equal(r.pots[0]!.amount, 227);
  assert.deepEqual(r.pots[0]!.shares, [
    { seat: 2, amount: 114 },
    { seat: 3, amount: 113 },
  ]);
  assert.deepEqual(stacksOf(hand), [1000, 975, 1013, 1012]);
});

test('three-way tie splits the pot evenly', () => {
  const { hand } = startHand(
    { handNumber: 1, seats: seats(1000, 1000, 1000), button: 0, blinds: BLINDS },
    { 0: '2c 3c', 1: '4c 5c', 2: '2d 3d' },
    'As Ks Qs Js Ts',
  );
  play(hand, [
    [0, 'call'],
    [1, 'call'],
    [2, 'check'],
    [1, 'check'],
    [2, 'check'],
    [0, 'check'],
    [1, 'check'],
    [2, 'check'],
    [0, 'check'],
    [1, 'check'],
    [2, 'check'],
    [0, 'check'],
  ]);
  assert.deepEqual(stacksOf(hand), [1000, 1000, 1000]);
  assert.deepEqual(hand.result!.pots[0]!.winners, [0, 1, 2]);
});

test('kicker decides between two pairs of the same rank', () => {
  const { hand } = startHand(
    { handNumber: 1, seats: seats(1000, 1000), button: 0, blinds: BLINDS },
    { 0: 'Ah Qc', 1: 'Ad Jc' },
    'As 8d 5c 3h 2s',
  );
  play(hand, [
    [0, 'call'],
    [1, 'check'],
    [1, 'check'],
    [0, 'check'],
    [1, 'check'],
    [0, 'check'],
    [1, 'check'],
    [0, 'check'],
  ]);
  assert.deepEqual(hand.result!.pots[0]!.winners, [0]);
  assert.deepEqual(stacksOf(hand), [1050, 950]);
});

test('a short big blind still requires callers to put in the full big blind', () => {
  const { hand } = startHand(setup4(1000, 1000, 30, 1000));
  assert.equal(hand.legalActions()!.toCall, 50);
  play(hand, [
    [3, 'call'],
    [0, 'fold'],
    [1, 'call'],
  ]);
  const v = hand.viewFor(null);
  assert.equal(v.street, 'flop');
  assert.equal(hand.toAct, 1);
  assert.equal(v.pot, 130);
});

test('heads-up small blind facing a short all-in big blind only needs to match it', () => {
  const { hand } = startHand({ handNumber: 1, seats: seats(1000, 30), button: 0, blinds: BLINDS }, { 0: 'As Ad', 1: '7c 2d' }, 'Kc 9d 5h 4s 3c');
  const legal = hand.legalActions()!;
  assert.equal(legal.toCall, 5);
  assert.equal(legal.aggression, null, 'no raising when nobody can respond');
  play(hand, [[0, 'call']]);
  assert.ok(hand.isComplete);
  assert.deepEqual(stacksOf(hand), [1030, 0]);
});

test('blinds that put everyone all-in finish the hand immediately with a refund', () => {
  const { hand } = startHand({ handNumber: 1, seats: seats(20, 1000), button: 0, blinds: BLINDS }, { 0: 'As Ad', 1: '7c 2d' }, 'Kc 9d 5h 4s 3c');
  assert.ok(hand.isComplete);
  assert.deepEqual(hand.result!.uncalled, [{ seat: 1, amount: 30 }]);
  assert.deepEqual(stacksOf(hand), [40, 980]);
});

test('uncalled part of an all-in is returned', () => {
  const { hand } = startHand({ handNumber: 1, seats: seats(1000, 400), button: 0, blinds: BLINDS }, { 0: '7c 2d', 1: 'As Ad' }, 'Kc 9d 5h 4s 3c');
  play(hand, [
    [0, 'raise', 1000],
    [1, 'call'],
  ]);
  assert.deepEqual(hand.result!.uncalled, [{ seat: 0, amount: 600 }]);
  assert.deepEqual(stacksOf(hand), [600, 800]);
});

test('antes are dead money and go into the pot', () => {
  const { hand } = startHand({ handNumber: 1, seats: seats(1000, 1000, 1000), button: 0, blinds: { smallBlind: 25, bigBlind: 50, ante: 10 } });
  const v = hand.viewFor(null);
  assert.equal(v.pot, 105);
  assert.deepEqual(v.seats.map((s) => s.streetCommit), [0, 25, 50]);
  play(hand, [
    [0, 'fold'],
    [1, 'fold'],
  ]);
  assert.deepEqual(stacksOf(hand), [990, 965, 1045]);
});

test('showdown: last aggressor shows first and a beaten hand is mucked', () => {
  const s3 = { handNumber: 1, seats: seats(1000, 1000, 1000), button: 0, blinds: BLINDS };
  const { hand } = startHand(s3, { 0: '7c 2d', 1: '8c 3d', 2: 'As Ad' }, 'Kc 9d 5h Js Qc');
  const events = play(hand, [
    [0, 'call'],
    [1, 'call'],
    [2, 'check'],
    ...(['flop', 'turn'] as const).flatMap(() => [
      [1, 'check'] as [number, 'check'],
      [2, 'check'] as [number, 'check'],
      [0, 'check'] as [number, 'check'],
    ]),
    [1, 'check'],
    [2, 'bet', 100],
    [0, 'call'],
    [1, 'fold'],
  ]);
  const tail = events.filter((e) => e.type === 'reveal' || e.type === 'muck');
  assert.deepEqual(
    tail.map((e) => [e.type, (e as { seat: number }).seat]),
    [
      ['reveal', 2],
      ['muck', 0],
    ],
  );
  const view = hand.viewFor(1);
  assert.equal(view.seats[0]!.holeCards, null, 'mucked cards stay hidden');
  assert.deepEqual(view.seats[2]!.holeCards!.map(cardToString), ['As', 'Ad']);
});

test('players marked always-show table a losing hand instead of mucking', () => {
  const s = { handNumber: 1, seats: seats(1000, 1000), button: 0, blinds: BLINDS, alwaysShow: [0] };
  const { hand } = startHand(s, { 0: '7c 2d', 1: 'As Ad' }, 'Kc 9d 5h Js Qc');
  const events = play(hand, [
    [0, 'call'],
    [1, 'check'],
    [1, 'check'],
    [0, 'check'],
    [1, 'check'],
    [0, 'check'],
    [1, 'bet', 50],
    [0, 'call'],
  ]);
  assert.equal(events.filter((e) => e.type === 'reveal').length, 2);
});

test('views never expose unrevealed hole cards or the deck', () => {
  const { hand, events } = startHand(setup4(1000, 1000, 1000, 1000));
  for (const viewer of [0, 1, 2, 3, null]) {
    const v = hand.viewFor(viewer);
    v.seats.forEach((s) => {
      if (s.seat === viewer) assert.equal(s.holeCards!.length, 2);
      else assert.equal(s.holeCards, null);
    });
    const json = JSON.stringify(v);
    assert.ok(!/deck|order|burn/i.test(json), 'view must not carry deck information');
    assert.ok(Object.isFrozen(v) && Object.isFrozen(v.seats[0]), 'views are immutable');
    const visible = eventsVisibleTo(events, viewer);
    assert.equal(visible.filter((e) => e.type === 'hole-cards').length, viewer === null ? 0 : 1);
  }
  assert.equal(hand.viewFor(3).legal!.seat, 3);
  assert.equal(hand.viewFor(0).legal, null, 'legal actions only for the player to act');
});

test('illegal actions are rejected with a reason and change nothing', () => {
  const { hand } = startHand(setup4(1000, 1000, 1000, 1000));
  const before = JSON.stringify(hand.serialize());
  const bad: [number, Parameters<HoldemHand['act']>[1]][] = [
    [0, { kind: 'call' }], // out of turn
    [3, { kind: 'check' }], // facing a bet
    [3, { kind: 'bet', to: 200 }], // must raise, not bet
    [3, { kind: 'raise', to: 60 }], // below minimum
    [3, { kind: 'raise', to: 5000 }], // more than the stack
    [3, { kind: 'raise' }], // missing amount
    [3, { kind: 'dance' } as never],
  ];
  for (const [seat, action] of bad) assert.throws(() => hand.act(seat, action), IllegalActionError);
  assert.equal(JSON.stringify(hand.serialize()), before);
  play(hand, [
    [3, 'fold'],
    [0, 'fold'],
    [1, 'fold'],
  ]);
  assert.throws(() => hand.act(2, { kind: 'check' }), IllegalActionError);
});

test('a folded player never gets the action again', () => {
  const { hand } = startHand(setup4(1000, 1000, 1000, 1000));
  play(hand, [
    [3, 'fold'],
    [0, 'raise', 150],
    [1, 'call'],
    [2, 'raise', 400],
    [0, 'call'],
    [1, 'call'],
  ]);
  const order: number[] = [];
  while (!hand.isComplete) {
    const seat = hand.toAct!;
    order.push(seat);
    hand.act(seat, { kind: 'check' });
  }
  assert.ok(!order.includes(3));
});

test('mid-hand save and restore continues identically', () => {
  const rng = new SeededRng('restore');
  const { hand } = HoldemHand.start(setup4(1000, 800, 1200, 1000), Deck.shuffled(rng));
  const actions = new SeededRng('restore-actions');
  for (let i = 0; i < 4 && !hand.isComplete; i++) hand.act(hand.toAct!, randomLegalAction(hand.legalActions()!, actions));
  const copy = HoldemHand.restore(JSON.parse(JSON.stringify(hand.serialize())));
  assert.deepEqual(copy.viewFor(null), hand.viewFor(null));
  const a = new SeededRng('continue');
  const b = new SeededRng('continue');
  while (!hand.isComplete) {
    const ea = hand.act(hand.toAct!, randomLegalAction(hand.legalActions()!, a));
    const eb = copy.act(copy.toAct!, randomLegalAction(copy.legalActions()!, b));
    assert.deepEqual(eb, ea);
  }
  assert.deepEqual(copy.result, hand.result);
});

test('restoring tampered hand data is refused', () => {
  const { hand } = startHand(setup4(1000, 1000, 1000, 1000));
  const data = hand.serialize();
  data.seats[0]!.stack += 500;
  assert.throws(() => HoldemHand.restore(data), /integrity/);
  const dup = hand.serialize();
  dup.seats[1]!.hole[0] = dup.seats[0]!.hole[0]!;
  assert.throws(() => HoldemHand.restore(dup), /integrity/);
});

test('fuzz: thousands of random hands keep every invariant', () => {
  const rng = new SeededRng('hand-fuzz');
  let showdowns = 0;
  let sidePots = 0;
  for (let i = 0; i < 3000; i++) {
    const n = 2 + (i % 7);
    const stacks = Array.from({ length: n }, () => 20 + (rng.nextUint32() % 1500));
    const { hand, events } = HoldemHand.start(
      { handNumber: i + 1, seats: seats(...stacks), button: i % n, blinds: BLINDS },
      Deck.shuffled(rng),
    );
    const all: HandEvent[] = [...events];
    let guard = 0;
    while (!hand.isComplete) {
      assert.ok(guard++ < 500, 'hand did not terminate');
      all.push(...hand.act(hand.toAct!, randomLegalAction(hand.legalActions()!, rng)));
      const problems = hand.checkInvariants();
      if (problems.length) assert.fail(problems.join('; '));
    }
    const r = hand.result!;
    if (r.showdown) showdowns++;
    if (r.pots.length > 1) sidePots++;
    assert.equal(r.finalStacks.reduce((a, b) => a + b, 0), stacks.reduce((a, b) => a + b, 0));
    assert.equal(all.filter((e) => e.type === 'hand-end').length, 1);
  }
  assert.ok(showdowns > 300, `showdowns ${showdowns}`);
  assert.ok(sidePots > 100, `side pots ${sidePots}`);
});
