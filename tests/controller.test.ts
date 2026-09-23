import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InlineAiHost, type AiHost } from '../src/ai/host.ts';
import { GameController } from '../src/game/controller.ts';
import { type NewGameSetup, defaultSetup } from '../src/game/config.ts';
import { createSession, validateSession, type SessionData } from '../src/game/session.ts';
import { replayHand } from '../src/engine/replay.ts';
import { SeededRng } from '../src/engine/rng.ts';
import { HeadlessPresenter } from '../src/sim/headless.ts';
import type { PlayerAction } from '../src/engine/types.ts';
import type { HandHistoryRecord } from '../src/game/history.ts';

function quickSetup(seed: string, extra: Partial<NewGameSetup> = {}): NewGameSetup {
  return { ...defaultSetup(), difficulty: 'casual', startingStack: 600, structure: 'turbo', seed, ...extra };
}

/** A deterministic "human": calls or checks, raises with some hands, folds sometimes — keyed on public state. */
const scriptedHuman = (legal: Parameters<ConstructorParameters<typeof HeadlessPresenter>[0]>[0], snapshot: Parameters<ConstructorParameters<typeof HeadlessPresenter>[0]>[1]): PlayerAction => {
  const key = (snapshot.handNumber * 31 + (snapshot.view?.actions.length ?? 0) * 7) % 10;
  if (legal.aggression && key < 2) return { kind: legal.aggression, to: legal.minTo };
  if (legal.canFold && key >= 8) return { kind: 'fold' };
  return legal.canCall ? { kind: 'call' } : { kind: 'check' };
};

async function playToEnd(session: SessionData, presenter: HeadlessPresenter, ai: AiHost = new InlineAiHost()) {
  const records: HandHistoryRecord[] = [];
  const controller = new GameController(session, presenter, ai, { handRecorded: (r) => records.push(r) });
  await controller.run();
  return { controller, records };
}

test('a complete game runs to a single winner holding every chip', async () => {
  const session = createSession(quickSetup('full-game'));
  const presenter = new HeadlessPresenter(scriptedHuman);
  const { controller, records } = await playToEnd(session, presenter);
  const info = presenter.gameOverInfo;
  assert.ok(info, 'game over was announced');
  const final = controller.session;
  const stacks = final.table.players.map((p) => p.stack);
  assert.equal(stacks.reduce((a, b) => a + b, 0), 600 * 4);
  assert.equal(stacks.filter((s) => s > 0).length, 1);
  assert.equal(final.table.players[info!.winnerSeat]!.stack, 2400);
  assert.equal(records.length, info!.hands);
  assert.deepEqual(presenter.violations, [], 'the human never saw hidden cards');
  assert.equal(presenter.notices.filter((n) => n.tone === 'error').length, 0);
  const places = final.table.players.map((p) => p.place).sort();
  assert.deepEqual(new Set(places).size >= 3 ? true : places, true, 'finishing places were assigned');
  // Every recorded hand replays exactly from its stored deck and decisions.
  for (const r of records) {
    const replay = replayHand(r.replay);
    assert.deepEqual(replay.result!.finalStacks, r.players.reduce((acc, p) => ((acc[p.seat] = p.endStack), acc), [...replay.result!.finalStacks]));
  }
});

test('the human sees only their own hole cards throughout a game', async () => {
  const session = createSession(quickSetup('visibility'));
  const presenter = new HeadlessPresenter(scriptedHuman);
  await playToEnd(session, presenter);
  const holeEvents = presenter.events.filter((e) => e.type === 'hole-cards');
  assert.ok(holeEvents.length > 0);
  assert.ok(holeEvents.every((e) => e.type === 'hole-cards' && e.seat === session.humanSeat));
  assert.deepEqual(presenter.violations, []);
});

test('saving mid-game and resuming produces exactly the same game (seeded)', async () => {
  // Uninterrupted reference run.
  const reference = await playToEnd(createSession(quickSetup('resume-determinism')), new HeadlessPresenter(scriptedHuman));

  // Interrupted run: stop after 5 hands, round-trip the save through JSON, resume.
  const first = createSession(quickSetup('resume-determinism'));
  const p1 = new HeadlessPresenter(scriptedHuman);
  const records: HandHistoryRecord[] = [];
  const c1 = new GameController(first, p1, new InlineAiHost(), {
    handRecorded: (r) => {
      records.push(r);
      if (records.length === 5) c1.stop();
    },
  });
  await c1.run();
  const saved = JSON.parse(JSON.stringify(c1.session)) as SessionData;
  assert.equal(validateSession(saved), null);
  const p2 = new HeadlessPresenter(scriptedHuman);
  const c2 = new GameController(saved, p2, new InlineAiHost(), { handRecorded: (r) => records.push(r) });
  await c2.run();

  assert.equal(records.length, reference.records.length);
  for (let i = 0; i < records.length; i++) {
    assert.deepEqual(records[i]!.replay, reference.records[i]!.replay, `hand ${i + 1} differs after resume`);
  }
  assert.equal(p2.gameOverInfo?.winnerSeat, (await playToEnd(createSession(quickSetup('resume-determinism')), new HeadlessPresenter(scriptedHuman))).controller.session.table.players.findIndex((p) => p.place === 1));
});

test('resuming in the middle of a hand continues that exact hand', async () => {
  const session = createSession(quickSetup('mid-hand'));
  let calls = 0;
  let controller!: GameController;
  const presenter = new HeadlessPresenter((legal) => {
    calls++;
    if (calls === 3) controller.stop();
    if (legal.canCheck) return { kind: 'check' };
    return legal.toCall <= 100 ? { kind: 'call' } : { kind: 'fold' };
  });
  controller = new GameController(session, presenter, new InlineAiHost());
  await controller.run();
  const saved = JSON.parse(JSON.stringify(controller.session)) as SessionData;
  assert.ok(saved.table.hand && saved.table.hand.phase !== 'complete', 'saved mid-hand');
  const before = saved.table.hand!.deck.order.join();
  const handNo = saved.table.handNumber; // read now: the controller updates the session it runs
  const p2 = new HeadlessPresenter(scriptedHuman);
  const records: HandHistoryRecord[] = [];
  await new GameController(saved, p2, new InlineAiHost(), { handRecorded: (r) => records.push(r) }).run();
  const same = records.find((r) => r.handNumber === handNo)!;
  assert.equal(same.replay.deckOrder.join(), before, 'the same deck continued');
});

test('an illegal human action is rejected with a reason and asked again', async () => {
  const session = createSession(quickSetup('illegal', { opponents: [{ name: 'Rico', style: 'maniac' }] }));
  let attempts = 0;
  let controller!: GameController;
  const presenter = new HeadlessPresenter((legal) => {
    attempts++;
    if (attempts === 1) return { kind: legal.canCheck ? 'call' : 'check' };
    if (attempts === 2) return { kind: 'raise', to: 1 };
    controller.stop();
    return { kind: 'fold' };
  });
  controller = new GameController(session, presenter, new InlineAiHost());
  await controller.run();
  assert.equal(presenter.rejections.length, 2);
  assert.ok(presenter.rejections.every((m) => m.length > 5));
});

test('a failing AI never stalls or corrupts the game', async () => {
  const broken: AiHost = {
    mode: 'inline',
    async decide() {
      throw new Error('simulated AI crash');
    },
    dispose() {},
  };
  const session = createSession(quickSetup('broken-ai'));
  const presenter = new HeadlessPresenter(scriptedHuman);
  const logs: string[] = [];
  const records: HandHistoryRecord[] = [];
  const controller = new GameController(session, presenter, broken, {
    log: (m) => logs.push(m),
    handRecorded: (r) => {
      records.push(r);
      if (records.length === 8) controller.stop();
    },
  });
  await controller.run();
  assert.equal(records.length, 8);
  assert.ok(logs.some((m) => m.includes('AI decision failed')));
  const total = controller.session.table.players.reduce((s, p) => s + p.stack, 0);
  assert.equal(total, 2400);
});

test('when the human is eliminated, the rest of the game can be skipped to the result', async () => {
  const session = createSession(quickSetup('bust-human', { difficulty: 'standard' }));
  // A human who shoves every hand busts quickly.
  const presenter = new HeadlessPresenter((legal) =>
    legal.aggression ? { kind: legal.aggression, to: legal.maxTo } : legal.canCall ? { kind: 'call' } : { kind: 'check' },
  );
  presenter.eliminationChoice = 'skip';
  const { controller } = await playToEnd(session, presenter);
  const s = controller.session;
  assert.ok(presenter.gameOverInfo);
  if (s.humanFinish && s.humanFinish.place > 1) {
    assert.equal(s.spectate, 'skip');
    assert.equal(presenter.gameOverInfo!.humanPlace, s.humanFinish.place);
  }
});

test('a tampered save is refused by validation', () => {
  const s = createSession(quickSetup('tamper'));
  const copy = JSON.parse(JSON.stringify(s)) as SessionData;
  copy.table.players[0]!.stack += 100;
  assert.match(validateSession(copy) ?? '', /integrity|chips/);
  const copy2 = JSON.parse(JSON.stringify(s));
  delete copy2.statsBook;
  assert.notEqual(validateSession(copy2), null);
});

test('different seeds deal different games; unseeded games use the secure source', () => {
  const a = createSession(quickSetup('one'));
  const b = createSession(quickSetup('two'));
  assert.notDeepEqual(a.deckRng, b.deckRng);
  const normal = createSession({ ...defaultSetup() });
  assert.equal(normal.deckRng, null);
  void SeededRng;
});
