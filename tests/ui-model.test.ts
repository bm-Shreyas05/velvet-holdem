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
import { chooseOrientation, computeLayout, contentBounds, fitScale } from '../src/ui/layout.ts';
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

test('layout: content bounds cover every seat, and the scale fits them in the box', () => {
  for (const orientation of ['landscape', 'portrait'] as const) {
    for (let n = 2; n <= 6; n++) {
      const layout = computeLayout(n, orientation);
      const b = contentBounds(layout);
      for (const seat of layout.seats) {
        // The widest possible name plate (190 units, whatever the font) must fit.
        assert.ok(seat.anchor.x - 95 >= b.left && seat.anchor.x + 95 <= b.right, `${orientation} ${n}: seat plate inside horizontally`);
      }
      for (const [w, h] of [[390, 402], [960, 560], [1400, 500], [300, 900]]) {
        const s = fitScale(layout, w!, h!);
        assert.ok((b.right - b.left) * s <= w! + 1e-9 && (b.bottom - b.top) * s <= h! + 1e-9, `${orientation} ${n}: fits ${w}x${h}`);
      }
    }
  }
  // Landscape side plates reach past the 1000-unit design width; the bounds must include them.
  const four = contentBounds(computeLayout(4, 'landscape'));
  assert.ok(four.left < -30 && four.right > 1030);
});

test('layout: orientation follows the larger table and does not flip on small resizes', () => {
  // A phone in portrait keeps the portrait table even when the action bar grows on your turn.
  assert.equal(chooseOrientation(390, 560, 4), 'portrait');
  assert.equal(chooseOrientation(390, 402, 4), 'portrait');
  assert.equal(chooseOrientation(390, 402, 4, 'portrait'), 'portrait');
  // Desktop and phone-landscape boxes use the wide table.
  assert.equal(chooseOrientation(960, 560, 4), 'landscape');
  assert.equal(chooseOrientation(844, 220, 4), 'landscape');
  // Near the crossover the current orientation is kept (10% hysteresis) ...
  const w = 600;
  let h = 300;
  while (chooseOrientation(w, h, 4) === 'landscape') h++;
  assert.equal(chooseOrientation(w, h, 4, 'landscape'), 'landscape', 'just past the crossover, landscape is kept');
  assert.equal(chooseOrientation(w, h - 1, 4, 'portrait'), 'portrait', 'just before it, portrait is kept');
  // ... but a clear gain switches.
  assert.equal(chooseOrientation(w, h * 1.4, 4, 'landscape'), 'portrait');
});
