import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InlineAiHost } from '../src/ai/host.ts';
import { GameController, type TableSnapshot } from '../src/game/controller.ts';
import { defaultSetup } from '../src/game/config.ts';
import { createSession } from '../src/game/session.ts';
import { HeadlessPresenter } from '../src/sim/headless.ts';
import { SeededRng } from '../src/engine/rng.ts';
import { randomLegalAction } from '../src/sim/bots.ts';
import type { HandEvent, LegalActions } from '../src/engine/types.ts';
import { applyEvent, displayFromSnapshot, displayMismatches, totalPot, type TableDisplay } from '../src/ui/table-model.ts';
import { aggressiveLabel, controlsFor, parseAmount, presets, toAction, validateAmount } from '../src/ui/controls-model.ts';
import { HoldemHand } from '../src/engine/hand.ts';
import { BLINDS, riggedDeck, seats } from './helpers.ts';

/** Presenter that animates nothing but advances the display model exactly like the real one. */
class ModelPresenter extends HeadlessPresenter {
  display: TableDisplay | null = null;
  mismatches: string[] = [];
  batches = 0;
  override reset(snapshot: TableSnapshot): void {
    super.reset(snapshot);
    this.display = displayFromSnapshot(snapshot);
  }
  override async present(events: HandEvent[], snapshot: TableSnapshot): Promise<void> {
    await super.present(events, snapshot);
    for (const e of events) this.display = applyEvent(this.display!, e);
    const truth = displayFromSnapshot(snapshot);
    const diff = displayMismatches(this.display!, truth);
    if (diff.length) this.mismatches.push(`hand ${snapshot.handNumber}: ${diff.join('; ')}`);
    // The pot shown (collected + bets) always equals chips committed in the engine.
    if (snapshot.view && snapshot.view.phase !== 'complete') {
      const committed = snapshot.view.pot;
      if (totalPot(this.display!) !== committed) this.mismatches.push(`hand ${snapshot.handNumber}: pot ${totalPot(this.display!)} vs engine ${committed}`);
    }
    this.display = truth;
    this.batches++;
  }
}

test('the animated table state always matches the engine after every batch of events', async () => {
  for (const seed of ['sync-a', 'sync-b', 'sync-c']) {
    const rng = new SeededRng(seed);
    const presenter = new ModelPresenter((legal: LegalActions) => randomLegalAction(legal, rng));
    presenter.eliminationChoice = 'watch';
    const session = createSession({ ...defaultSetup(), difficulty: 'casual', startingStack: 2500, structure: 'turbo', seed, opponents: defaultSetup().opponents.concat([{ name: 'Nora Quill', style: 'trapper' }, { name: 'Benny Tuck', style: 'station' }]) });
    await new GameController(session, presenter, new InlineAiHost()).run();
    assert.ok(presenter.batches > 40, `only ${presenter.batches} batches; mismatches: ${presenter.mismatches.slice(0, 3).join(" | ")}`);
    assert.deepEqual(presenter.mismatches, []);
    assert.deepEqual(presenter.violations, []);
  }
});

test('controls: labels, availability and presets follow the legal actions', () => {
  const setup = { handNumber: 1, seats: seats(1000, 1000, 1000, 1000), button: 0, blinds: BLINDS };
  const { hand } = HoldemHand.start(setup, riggedDeck(setup, {}, ''));
  const legal = hand.legalActions()!;
  const c = controlsFor(legal);
  assert.equal(c.canFold, true);
  assert.deepEqual(c.passive, { kind: 'call', label: 'Call 50', amount: 50, allIn: false });
  assert.equal(c.aggressive!.kind, 'raise');
  assert.equal(c.aggressive!.min, 100);
  assert.equal(c.aggressive!.max, 1000);
  assert.ok(c.potOdds && Math.abs(c.potOdds.equityNeeded - 50 / 125) < 1e-9);
  const p = presets(legal);
  assert.deepEqual(p.map((x) => x.id), ['min', 'half', 'three-quarters', 'pot', 'allin']);
  assert.ok(p.every((x) => x.to >= 100 && x.to <= 1000));
  assert.equal(p.find((x) => x.id === 'pot')!.to, 50 + 125); // call 50, then raise the 125 pot
  assert.equal(aggressiveLabel('raise', 1000, 1000), 'All-in 1,000');
  // After everyone limps, the big blind may check: no fold button.
  hand.act(3, { kind: 'call' });
  hand.act(0, { kind: 'call' });
  hand.act(1, { kind: 'call' });
  const bb = controlsFor(hand.legalActions()!);
  assert.equal(bb.canFold, false);
  assert.equal(bb.passive.label, 'Check');
  assert.equal(bb.potOdds, null);
});

test('controls: typed amounts are parsed and validated with explanations', () => {
  assert.equal(parseAmount('1,200'), 1200);
  assert.equal(parseAmount(' 350 '), 350);
  assert.equal(parseAmount('1.5k'), 1500);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount('-5'), null);
  assert.equal(parseAmount(''), null);
  const setup = { handNumber: 1, seats: seats(1000, 1000, 1000, 1000), button: 0, blinds: BLINDS };
  const { hand } = HoldemHand.start(setup, riggedDeck(setup, {}, ''));
  const legal = hand.legalActions()!;
  assert.deepEqual(validateAmount(300, legal), { to: 300, note: null });
  assert.match(validateAmount(60, legal).note!, /minimum raise is 100/);
  assert.equal(validateAmount(60, legal).to, 100);
  assert.equal(validateAmount(5000, legal).to, 1000);
  assert.match(validateAmount(5000, legal).note!, /all-in/);
  assert.equal(validateAmount(null, legal).to, 100);
  // Whatever the controls produce is accepted by the engine.
  for (const amount of [0, 99, 100, 101, 555, 999, 1000, 99999]) hand.validate(3, toAction('aggressive', legal, amount));
  hand.validate(3, toAction('passive', legal));
  hand.validate(3, toAction('fold', legal));
});

test('controls: a short stack can only move all-in', () => {
  const setup = { handNumber: 1, seats: seats(1000, 1000, 1000, 120), button: 0, blinds: BLINDS };
  const { hand } = HoldemHand.start(setup, riggedDeck(setup, {}, ''));
  hand.act(3, { kind: 'call' });
  hand.act(0, { kind: 'raise', to: 300 });
  hand.act(1, { kind: 'fold' });
  hand.act(2, { kind: 'fold' });
  const c = controlsFor(hand.legalActions()!);
  assert.equal(hand.toAct, 3);
  assert.equal(c.aggressive, null);
  assert.equal(c.passive.label, 'Call 70 (all-in)');
});
