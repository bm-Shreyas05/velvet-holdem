import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InlineAiHost } from '../src/ai/host.ts';
import { Deck } from '../src/engine/deck.ts';
import { SeededRng } from '../src/engine/rng.ts';
import type { LegalActions, PlayerAction } from '../src/engine/types.ts';
import {
  ANTE_FROM_LEVEL,
  dailySetup,
  defaultCashSetup,
  defaultSetup,
  gameConfigFor,
  type NewGameSetup,
  normaliseSetup,
  prizeTable,
  todayKey,
  validateSetup,
} from '../src/game/config.ts';
import { type ControllerHooks, GameController, type TableSnapshot } from '../src/game/controller.ts';
import { createSession, type SessionData, validateSession } from '../src/game/session.ts';
import { randomLegalAction } from '../src/sim/bots.ts';
import { HeadlessPresenter } from '../src/sim/headless.ts';

function chipsAtTable(session: SessionData): number {
  return session.table.players.reduce((sum, p) => sum + p.stack, 0);
}

function cashSetup(seed: string, extra: Partial<NewGameSetup> = {}): NewGameSetup {
  // Short buy-ins (20 big blinds) and a reckless human make bust-outs and rebuys common.
  return { ...defaultCashSetup(defaultSetup()), difficulty: 'casual', startingStack: 200, seed, ...extra };
}

test('cash game: busted players buy in again, chips stay accounted for, and cashing out ends the session', async () => {
  const session = createSession(cashSetup('cash-rebuys'));
  const rng = new SeededRng('cash-human');
  let controller: GameController | null = null;
  let asked = false;
  const presenter = new HeadlessPresenter((legal: LegalActions, snap: TableSnapshot): PlayerAction => {
    // After 60 hands, ask to leave mid-hand: the session must end after this hand, not during it.
    if (snap.handNumber >= 60 && !asked) {
      asked = true;
      assert.equal(controller!.requestCashOut(), 'after-hand');
    }
    return legal.aggression && rng.nextUint32() % 3 === 0 ? { kind: legal.aggression, to: legal.maxTo } : randomLegalAction(legal, rng);
  });
  const hooks: ControllerHooks = { cashedOut: () => undefined };
  controller = new GameController(session, presenter, new InlineAiHost(), hooks);
  await controller.run();

  const s = controller.session;
  const summary = presenter.cashSummary;
  assert.ok(summary, 'the session ended with a summary');
  assert.ok(asked && s.cash?.cashedOut, 'cashed out after the requested hand');
  assert.ok(presenter.rebuys.length > 0, 'somebody bought in again');
  const buyIns = Object.values(s.cash!.buyIns).reduce((a, b) => a + b, 0);
  assert.equal(chipsAtTable(s), buyIns * s.cash!.buyIn, 'every chip at the table was bought');
  assert.equal(s.table.totalChips, buyIns * s.cash!.buyIn);
  const human = s.table.players[s.humanSeat]!;
  assert.equal(summary!.finalStack, human.stack);
  assert.equal(summary!.net, human.stack - s.cash!.buyIns.human! * s.cash!.buyIn);
  assert.ok(
    s.table.players.every((p) => !p.eliminated),
    'nobody is eliminated in a cash game',
  );
  assert.equal(presenter.gameOverInfo, null, 'a cash game has no winner');
  assert.deepEqual(presenter.violations, []);
  assert.equal(validateSession(s), null, 'the finished session is still a valid save');
});

test('cash game: going broke and choosing to leave counts the whole buy-in as lost', async () => {
  const session = createSession(cashSetup('cash-leave'));
  const presenter = new HeadlessPresenter((legal) =>
    legal.aggression ? { kind: legal.aggression, to: legal.maxTo } : legal.canCall ? { kind: 'call' } : { kind: 'check' },
  );
  presenter.bustChoice = 'leave';
  const controller = new GameController(session, presenter, new InlineAiHost());
  await controller.run();
  const summary = presenter.cashSummary;
  assert.ok(summary, 'the session ended');
  if (summary!.finalStack === 0) assert.equal(summary!.net, -summary!.buyIns * summary!.buyIn);
  assert.equal(chipsAtTable(controller.session), Object.values(controller.session.cash!.buyIns).reduce((a, b) => a + b, 0) * 200);
});

test('cash game: a save made while the human is broke resumes by offering the buy-in again', async () => {
  const session = createSession(cashSetup('cash-resume'));
  let saved: SessionData | null = null;
  const all = new HeadlessPresenter((legal) =>
    legal.aggression ? { kind: legal.aggression, to: legal.maxTo } : legal.canCall ? { kind: 'call' } : { kind: 'check' },
  );
  all.bustChoice = 'leave';
  const first = new GameController(session, all, new InlineAiHost(), {
    saveSession: (s) => {
      if (s.table.players[s.humanSeat]!.stack === 0 && s.table.handSettled) saved ??= structuredClone(s);
    },
  });
  await first.run();
  assert.ok(saved, 'captured a save with the human broke between hands');
  const snap = saved as SessionData;
  snap.cash!.cashedOut = null;
  snap.cash!.leaving = false;
  let offered = 0;
  const again = new HeadlessPresenter((legal) => (legal.canCheck ? { kind: 'check' } : { kind: 'fold' }));
  again.humanBusted = async () => {
    offered++;
    return 'leave';
  };
  const resumed = new GameController(snap, again, new InlineAiHost());
  await resumed.run();
  assert.equal(offered, 1, 'the buy-in was offered before any new hand');
  assert.ok(again.cashSummary);
});

test('tournament prizes: the pool is split by finishing place and paid to the right players', async () => {
  const setup: NewGameSetup = { ...defaultSetup(), difficulty: 'casual', startingStack: 600, structure: 'turbo', payout: 'top3', seed: 'prizes' };
  assert.deepEqual(prizeTable(setup), [200, 120, 80]);
  assert.deepEqual(prizeTable({ ...setup, opponents: setup.opponents.slice(0, 2), payout: 'top2' }), [195, 105]);
  assert.equal(validateSetup({ ...setup, opponents: setup.opponents.slice(0, 2) }), '"Top 3 paid" needs at least 4 players.');

  const session = createSession(setup);
  const rng = new SeededRng('prize-human');
  const presenter = new HeadlessPresenter((legal) => randomLegalAction(legal, rng));
  const finishes: { place: number; prize: number }[] = [];
  const controller = new GameController(session, presenter, new InlineAiHost(), { humanFinished: (place, _field, prize) => finishes.push({ place, prize }) });
  await controller.run();
  const info = presenter.gameOverInfo!;
  assert.deepEqual(info.prizes, [200, 120, 80]);
  assert.equal(info.humanPrize, [200, 120, 80][info.humanPlace - 1] ?? 0);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0]!.prize, info.humanPrize);
});

test('antes join the blinds from level 4 in rising-blind tournaments only', () => {
  const t = gameConfigFor({ ...defaultSetup(), structure: 'standard', antes: true });
  assert.ok(t.levels.slice(0, ANTE_FROM_LEVEL).every((l) => l.ante === 0));
  assert.ok(t.levels.slice(ANTE_FROM_LEVEL).every((l) => l.ante === Math.max(1, Math.round(l.bigBlind / 10))));
  assert.ok(gameConfigFor({ ...defaultSetup(), structure: 'fixed', antes: true }).levels.every((l) => l.ante === 0));
  assert.ok(gameConfigFor({ ...defaultSetup(), antes: false }).levels.every((l) => l.ante === 0));
  const cash = gameConfigFor(defaultCashSetup(defaultSetup()));
  assert.equal(cash.format, 'cash');
  assert.equal(cash.levels.length, 1);
  assert.equal(cash.handsPerLevel, null);
});

test('setups saved by older versions load with sensible defaults', () => {
  const old = { ...defaultSetup() } as Partial<NewGameSetup>;
  delete old.mode;
  delete old.antes;
  delete old.payout;
  const s = normaliseSetup(old as NewGameSetup);
  assert.equal(s.mode, 'tournament');
  assert.equal(s.antes, false, 'games started before antes existed continue without them');
  assert.equal(s.payout, 'winner');
  assert.equal(validateSetup(s), null);
});

test('daily challenge: the same table and the same deals for everyone on a date', () => {
  const a = dailySetup('2026-10-02', 'Alex');
  const b = dailySetup('2026-10-02', 'Sam');
  assert.deepEqual(a.opponents, b.opponents);
  assert.equal(a.difficulty, b.difficulty);
  assert.equal(validateSetup(a), null);
  assert.notDeepEqual(dailySetup('2026-10-03', 'Alex').seed, a.seed);
  // Deck order for every hand number depends only on the date.
  const decks = (setup: NewGameSetup) => {
    const s = createSession(setup);
    const rng = SeededRng.fromState(s.deckRng!);
    return [1, 2, 3].map(() => Deck.shuffled(rng).snapshot().order.join());
  };
  assert.deepEqual(decks(a), decks(b));
  assert.notDeepEqual(decks(a), decks(dailySetup('2026-10-03', 'Alex')));
  // A player named like one of the day's opponents plays as "You".
  assert.equal(dailySetup('2026-10-02', a.opponents[0]!.name).playerName, 'You');
  assert.match(todayKey(new Date(2026, 0, 5)), /^2026-01-05$/);
});
