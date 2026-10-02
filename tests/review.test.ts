import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from '../src/ai/decide.ts';
import { parseCards } from '../src/engine/cards.ts';
import { HoldemHand } from '../src/engine/hand.ts';
import type { PlayerAction } from '../src/engine/types.ts';
import { buildHistoryRecord } from '../src/game/history.ts';
import { actionText, buildReplaySteps, reviewDecisions, verdictFor } from '../src/game/review.ts';
import { riggedDeck, seats } from './helpers.ts';

/** Plays a scripted hand and returns its history record from `human`'s seat. */
function playHand(holes: Record<number, string>, board: string, script: [number, PlayerAction][], human: number, stacks = [1000, 1000, 1000]) {
  const setup = { handNumber: 7, seats: seats(...stacks), button: 0, blinds: { smallBlind: 25, bigBlind: 50, ante: 0 } };
  const { hand } = HoldemHand.start(setup, riggedDeck(setup, holes, board));
  for (const [seat, action] of script) hand.act(seat, action);
  assert.ok(hand.isComplete, 'the scripted hand finishes');
  return buildHistoryRecord(hand, setup, { 0: 'Ann', 1: 'Bo', 2: 'You' }, human);
}

const inline = async (req: Parameters<typeof decide>[0]) => decide(req);

test('replay steps reproduce the hand and never show cards the player did not see', () => {
  const r = playHand(
    { 0: 'Kh Kd', 1: '7c 2d', 2: 'Ah Qh' },
    '2h 9h Jc 4s 8d',
    [
      [0, { kind: 'raise', to: 150 }],
      [1, { kind: 'fold' }],
      [2, { kind: 'call' }],
      [2, { kind: 'check' }],
      [0, { kind: 'bet', to: 200 }],
      [2, { kind: 'call' }],
      [2, { kind: 'check' }],
      [0, { kind: 'check' }],
      [2, { kind: 'check' }],
      [0, { kind: 'check' }],
    ],
    2,
  );
  const steps = buildReplaySteps(r);
  assert.equal(steps.length, r.replay.decisions.length + 1);
  assert.deepEqual(
    steps.at(-1)!.view.result!.finalStacks,
    r.players.map((p) => p.endStack),
  );
  for (const s of steps) {
    for (const e of s.events) if (e.type === 'hole-cards') assert.equal(e.seat, 2, 'only the player’s own cards are dealt face up');
    for (const seat of s.view.seats) if (seat.seat !== 2 && seat.holeCards) assert.ok(seat.revealed, 'other cards only once shown');
  }
  // Bo folded 7-2: those cards never appear anywhere in the replay.
  const folded = new Set(parseCards('7c 2d'));
  for (const s of steps) {
    for (const e of s.events) if (e.type === 'hole-cards' || e.type === 'reveal') assert.ok(!e.cards.some((c) => folded.has(c)), 'folded cards stay hidden');
    for (const seat of s.view.seats) assert.ok(!(seat.holeCards ?? []).some((c) => folded.has(c)), 'folded cards stay hidden');
  }
  assert.equal(steps.filter((s) => s.before).length, 5, 'the player’s five decisions are reviewable');
});

test('the coach flags folding aces to a small raise as costly, and folding seven-deuce to a shove as good', async () => {
  const aces = playHand(
    { 0: 'Ts 9s', 2: 'As Ad' },
    '',
    [
      [0, { kind: 'raise', to: 125 }],
      [1, { kind: 'fold' }],
      [2, { kind: 'fold' }],
    ],
    2,
  );
  const [fold] = await reviewDecisions(aces, buildReplaySteps(aces), inline);
  assert.ok(fold);
  assert.equal(fold!.verdict, 'costly', `${fold!.evLossBB} BB lost`);
  assert.equal(fold!.actionText, 'Fold');
  assert.ok(!fold!.options.find((o) => o.best)!.chosen);
  assert.ok(fold!.equity > 0.6);

  const trash = playHand(
    { 0: 'As Ks', 2: '7c 2d' },
    '',
    [
      [0, { kind: 'raise', to: 1000 }],
      [1, { kind: 'fold' }],
      [2, { kind: 'fold' }],
    ],
    2,
  );
  const [good] = await reviewDecisions(trash, buildReplaySteps(trash), inline);
  assert.equal(good!.verdict, 'good');
  assert.ok(good!.options.find((o) => o.chosen)!.best, 'folding was the best option');
  assert.ok(good!.potOdds !== null && good!.potOdds > 0.4);
});

test('the coach prices the exact amount the player chose and gives the same verdicts every time', async () => {
  const r = playHand(
    { 0: '8c 8d', 2: 'Kc Qc' },
    '',
    [
      [0, { kind: 'call' }],
      [1, { kind: 'fold' }],
      [2, { kind: 'raise', to: 230 }],
      [0, { kind: 'fold' }],
    ],
    2,
  );
  const steps = buildReplaySteps(r);
  const first = await reviewDecisions(r, steps, inline);
  const again = await reviewDecisions(r, steps, inline);
  assert.deepEqual(first, again);
  const chosen = first[0]!.options.find((o) => o.chosen)!;
  assert.equal(chosen.text, 'Raise to 230');
  assert.equal(actionText({ kind: 'raise', to: 1000 }, { toCall: 0, maxTo: 1000 }), 'All-in (1,000)');
  assert.equal(verdictFor(0.2, 10), 'good');
  assert.equal(verdictFor(1, 4), 'close');
  assert.equal(verdictFor(5, 10), 'costly');
});
