import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyStats, observeHand } from '../src/ai/model.ts';
import { HoldemHand } from '../src/engine/hand.ts';
import { publicRecordFromView } from '../src/engine/records.ts';
import { buildHistoryRecord } from '../src/game/history.ts';
import {
  achievementsForDaily,
  achievementsForHand,
  achievementsForTournament,
  dailyShareText,
  dailyStreak,
  emptyProgress,
  normaliseProgress,
  REPUTATION_HANDS,
  recordDaily,
  reputationPrior,
  unlock,
  unlockedCosmetics,
} from '../src/game/progress.ts';
import { riggedDeck, seats } from './helpers.ts';

/** Plays a heads-up hand to showdown (both players check it down) and returns the human's record. */
function showdown(holes: Record<number, string>, board: string) {
  const setup = { handNumber: 1, seats: seats(1000, 1000), button: 0, blinds: { smallBlind: 25, bigBlind: 50, ante: 0 } };
  const { hand } = HoldemHand.start(setup, riggedDeck(setup, holes, board));
  hand.act(0, { kind: 'call' });
  hand.act(1, { kind: 'check' });
  for (let street = 0; street < 3; street++) {
    hand.act(1, { kind: 'check' });
    hand.act(0, { kind: 'check' });
  }
  assert.ok(hand.isComplete);
  return { record: buildHistoryRecord(hand, setup, { 0: 'You', 1: 'Rival' }, 0), hand };
}

test('achievements: hands award firsts, rare hands and counters', () => {
  const p = emptyProgress();
  const royal = showdown({ 0: 'As Ks', 1: '2c 3d' }, 'Qs Js Ts 4h 5d').record;
  const ids = achievementsForHand(p, royal, { cash: false, eliminatedBy: 0 });
  for (const id of ['first-hand', 'first-pot', 'quads', 'straight-flush', 'royal'] as const) assert.ok(ids.includes(id), `${id} in ${ids}`);
  assert.equal(p.counters.handsPlayed, 1);
  assert.equal(p.counters.showdownsWon, 1);

  const p2 = emptyProgress();
  const steelWheel = showdown({ 0: 'As 2s', 1: 'Kd Kc' }, '3s 4s 5s Kh 9d').record;
  const sf = achievementsForHand(p2, steelWheel, { cash: false, eliminatedBy: 0 });
  assert.ok(sf.includes('straight-flush') && !sf.includes('royal'), 'a five-high straight flush is not royal');

  const p3 = emptyProgress();
  const hammer = showdown({ 0: '7c 2d', 1: '3h 4c' }, '7s 7d 9c Kh Qd').record;
  assert.ok(achievementsForHand(p3, hammer, { cash: true, eliminatedBy: 2 }).includes('hammer'));
  assert.equal(p3.counters.cashHands, 1);
  assert.equal(p3.counters.knockouts, 2);
  assert.ok(achievementsForHand(p3, hammer, { cash: true, eliminatedBy: 0 }).includes('double-ko') === false);

  // Losing hands earn no pot achievements.
  const p4 = emptyProgress();
  const lost = showdown({ 0: '2c 3d', 1: 'As Ks' }, 'Qs Js Ts 4h 5d').record;
  assert.deepEqual(achievementsForHand(p4, lost, { cash: false, eliminatedBy: 0 }), ['first-hand']);
});

test('achievements: tournaments, unlocks and cosmetics', () => {
  assert.deepEqual(achievementsForTournament({ place: 1, fieldSize: 6, paidPlaces: 1, difficulty: 'elite' }), [
    'champion',
    'champion-pro',
    'champion-elite',
    'full-table',
  ]);
  assert.deepEqual(achievementsForTournament({ place: 3, fieldSize: 5, paidPlaces: 3, difficulty: 'casual' }), ['itm']);
  assert.deepEqual(achievementsForTournament({ place: 4, fieldSize: 5, paidPlaces: 3, difficulty: 'casual' }), ['bubble']);
  assert.deepEqual(achievementsForTournament({ place: 2, fieldSize: 4, paidPlaces: 1, difficulty: 'pro' }), []);

  const p = emptyProgress();
  assert.ok(!unlockedCosmetics(p).felts.has('royal'));
  const fresh = unlock(p, ['champion', 'champion']);
  assert.equal(fresh.length, 1, 'an achievement is earned once');
  assert.equal(unlock(p, ['champion']).length, 0);
  assert.ok(unlockedCosmetics(p).felts.has('royal'));
});

test('daily challenge: only the first game of the day counts; streaks span month ends', () => {
  const p = emptyProgress();
  p.dailyStarted['2026-09-30'] = 'game-a';
  const result = { place: 2, fieldSize: 5, hands: 40, prize: 175, finishedAt: '2026-09-30T20:00:00Z' };
  const day = () => p.daily['2026-09-30'];
  assert.equal(recordDaily(p, '2026-09-30', 'game-b', result).official, false, 'a later game is practice');
  assert.equal(day(), undefined);
  assert.equal(recordDaily(p, '2026-09-30', 'game-a', result).official, true);
  assert.equal(recordDaily(p, '2026-09-30', 'game-c', { ...result, place: 1 }).official, false);
  assert.equal(day()!.place, 2, 'practice never improves the record');
  assert.equal(day()!.attempts, 2);

  p.daily['2026-10-01'] = { ...result, attempts: 1 };
  p.daily['2026-09-29'] = { ...result, attempts: 1 };
  assert.equal(dailyStreak(p, '2026-10-01'), 3);
  assert.equal(dailyStreak(p, '2026-10-02'), 3, 'today not played yet keeps yesterday’s streak');
  assert.equal(dailyStreak(p, '2026-10-03'), 0);
  assert.deepEqual(achievementsForDaily(p, '2026-10-01', { place: 1, official: true }), ['daily', 'daily-win', 'streak-3']);
  assert.deepEqual(achievementsForDaily(p, '2026-10-01', { place: 1, official: false }), []);
  assert.match(
    dailyShareText('2026-10-01', p.daily['2026-10-01']!, 3, 'https://example.test/'),
    /finished 2nd of 5 after 40 hands .* · 3-day streak\nhttps:\/\/example\.test\//,
  );
});

test('reputation: opponents start a new game with a scaled-down memory of the player', () => {
  const book = { me: emptyStats() };
  // Many hands where "me" always folds preflop: a very tight player.
  for (let i = 0; i < 300; i++) {
    const setup = {
      handNumber: i + 1,
      seats: [
        { id: 'me', stack: 1000 },
        { id: 'them', stack: 1000 },
      ],
      button: i % 2,
      blinds: { smallBlind: 25, bigBlind: 50, ante: 0 },
    };
    const { hand } = HoldemHand.start(setup, riggedDeck(setup, {}));
    const meSeat = 0;
    while (!hand.isComplete) {
      const seat = hand.toAct!;
      const legal = hand.legalActions()!;
      hand.act(seat, seat === meSeat ? (legal.canCheck ? { kind: 'check' } : { kind: 'fold' }) : legal.canCheck ? { kind: 'check' } : { kind: 'call' });
    }
    observeHand(book, publicRecordFromView(hand.viewFor(null)));
  }
  const rep = book.me;
  assert.equal(rep.hands, 300);
  const prior = reputationPrior(rep)!;
  assert.equal(prior.hands, REPUTATION_HANDS);
  const scale = REPUTATION_HANDS / 300;
  assert.ok(Math.abs(prior.counters.vpip.n - rep.counters.vpip.n * scale) < 1e-9);
  assert.equal(prior.counters.vpip.rn, rep.counters.vpip.rn, 'the recent window is kept as it was');
  assert.equal(reputationPrior(null), null);

  // Damaged or foreign progress data is replaced by defaults, field by field.
  const odd = normaliseProgress({ counters: { knockouts: -3, reviews: 'x' }, reputation: { nonsense: true } } as never);
  assert.equal(odd.counters.knockouts, 0);
  assert.equal(odd.reputation, null);
  assert.deepEqual(odd.daily, {});
});
