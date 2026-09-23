import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cardsToString, parseCards } from '../src/engine/cards.ts';
import { Deck } from '../src/engine/deck.ts';
import { HoldemHand } from '../src/engine/hand.ts';
import { SeededRng } from '../src/engine/rng.ts';
import type { ActionKind, HandView } from '../src/engine/types.ts';
import { decide } from '../src/ai/decide.ts';
import { sanitizeDecision } from '../src/ai/host.ts';
import { type StatsBook, emptyStats, estimate, observeHand, tendencies } from '../src/ai/model.ts';
import { DIFFICULTY_ORDER, STYLE_ORDER } from '../src/ai/profiles.ts';
import { publicRecordFromView } from '../src/engine/records.ts';
import { randomLegalAction } from '../src/sim/bots.ts';
import { BLINDS, riggedDeck, seats } from './helpers.ts';

type Step = [number, ActionKind, number?];
function spot(holes: Record<number, string>, board: string, steps: Step[], stacks = [1000, 1000, 1000, 1000]) {
  const setup = { handNumber: 1, seats: seats(...stacks), button: 0, blinds: BLINDS };
  const { hand } = HoldemHand.start(setup, riggedDeck(setup, holes, board));
  for (const [s, k, to] of steps) hand.act(s, to === undefined ? { kind: k } : { kind: k, to });
  return hand;
}

const seed = (i: number) => [(i * 7919 + 1) >>> 0, (i + 13) >>> 0, (0x9e3779b9 ^ i) >>> 0, (i * 31 + 7) >>> 0] as [number, number, number, number];

test('every AI decision is legal, across styles, difficulties and random situations', () => {
  const rng = new SeededRng('ai-legal');
  let checked = 0;
  for (let i = 0; i < 160; i++) {
    const n = 2 + (i % 5);
    const { hand } = HoldemHand.start(
      { handNumber: 1, seats: seats(...Array.from({ length: n }, () => 100 + (rng.nextUint32() % 2000))), button: i % n, blinds: BLINDS },
      Deck.shuffled(rng),
    );
    const steps = rng.nextUint32() % 6;
    for (let k = 0; k < steps && !hand.isComplete; k++) hand.act(hand.toAct!, randomLegalAction(hand.legalActions()!, rng));
    if (hand.isComplete) continue;
    const seat = hand.toAct!;
    const d = decide({
      view: hand.viewFor(seat),
      style: STYLE_ORDER[i % STYLE_ORDER.length]!,
      difficulty: DIFFICULTY_ORDER[i % DIFFICULTY_ORDER.length]!,
      stats: {},
      tilt: (i % 3) / 2,
      seed: seed(i),
    });
    hand.validate(seat, d.action); // throws if illegal
    checked++;
  }
  assert.ok(checked > 100);
});

test('decisions are deterministic for the same view, statistics and seed', () => {
  const hand = spot({ 3: 'Ah Qh' }, '', []);
  const view = hand.viewFor(3);
  for (const difficulty of DIFFICULTY_ORDER) {
    const a = decide({ view, style: 'shark', difficulty, stats: {}, tilt: 0, seed: seed(5) });
    const b = decide({ view, style: 'shark', difficulty, stats: {}, tilt: 0, seed: seed(5) });
    assert.deepEqual(a.action, b.action);
    assert.deepEqual(a.debug.candidates, b.debug.candidates);
  }
});

test('the AI cannot be influenced by cards it cannot see', () => {
  // Same AI cards and board, completely different opponent holdings.
  const steps: Step[] = [
    [3, 'call'],
    [0, 'call'],
    [1, 'call'],
    [2, 'check'],
    [1, 'bet', 100],
  ];
  const a = spot({ 2: 'Kd Qd', 0: 'As Ad', 1: '7c 2d', 3: '9s 9h' }, 'Kc 8h 3s', steps);
  const b = spot({ 2: 'Kd Qd', 0: '4c 5c', 1: 'Js Ts', 3: '6d 6h' }, 'Kc 8h 3s', steps);
  const va = a.viewFor(2);
  const vb = b.viewFor(2);
  assert.deepEqual(va, vb, 'the AI receives identical information in both worlds');
  for (const difficulty of DIFFICULTY_ORDER) {
    const da = decide({ view: va, style: 'shark', difficulty, stats: {}, tilt: 0, seed: seed(9) });
    const db = decide({ view: vb, style: 'shark', difficulty, stats: {}, tilt: 0, seed: seed(9) });
    assert.deepEqual(da, { ...db, debug: { ...db.debug, ms: da.debug.ms } });
  }
});

test('views handed to the AI contain no opponent hole cards and no deck information', () => {
  const hand = spot({ 3: 'Ah Kh', 0: 'Qs Qd' }, '', []);
  const view: HandView = hand.viewFor(3);
  const json = JSON.stringify(view);
  assert.ok(!json.includes('"order"') && !json.includes('burn'), 'no deck order or burn cards');
  const theirs = hand.holeCards(0);
  for (const s of view.seats) if (s.seat !== 3) assert.equal(s.holeCards, null);
  assert.ok(!cardsToString(view.seats[3]!.holeCards!).includes(cardsToString(theirs)));
});

test('AI modules cannot reach engine internals (import boundary)', () => {
  const dir = fileURLToPath(new URL('../src/ai/', import.meta.url));
  const forbidden = ['engine/hand.ts', 'engine/deck.ts', 'engine/game.ts', 'engine/replay.ts', '/game/', '/ui/', '/sim/'];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(dir + file, 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    for (const imp of imports) {
      for (const f of forbidden) assert.ok(!imp.includes(f), `${file} must not import ${imp}`);
    }
  }
});

test('folds trash, raises premiums, and folds weak hands to heavy action', () => {
  const aces = spot({ 3: 'As Ad' }, '', []);
  const trash = spot({ 3: '7c 2d' }, '', []);
  const runs = (hand: HoldemHand, seat: number, difficulty: 'pro' | 'elite') => {
    const tally: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      const d = decide({ view: hand.viewFor(seat), style: 'shark', difficulty, stats: {}, tilt: 0, seed: seed(i) });
      tally[d.action.kind] = (tally[d.action.kind] ?? 0) + 1;
    }
    return tally;
  };
  assert.ok((runs(aces, 3, 'elite').raise ?? 0) >= 19, 'aces are raised');
  assert.ok((runs(trash, 3, 'elite').fold ?? 0) >= 18, '72o is folded under the gun');
  // Bottom pair facing a pot-sized bet and a raise behind folds.
  const pressure = spot({ 2: '3c 4d', 1: 'Ah Kd' }, 'As 9h 4c', [
    [3, 'call'],
    [0, 'call'],
    [1, 'call'],
    [2, 'check'],
    [1, 'bet', 200],
    [2, 'call'],
    [3, 'raise', 700],
    [0, 'fold'],
    [1, 'fold'],
  ]);
  assert.ok((runs(pressure, 2, 'pro').fold ?? 0) >= 16, 'weak pair folds to bet + raise');
});

test('calling becomes less frequent as the price rises (pot odds)', () => {
  const freq = (bet: number) => {
    const hand = spot({ 2: 'Jc Td', 1: 'Qh 3h' }, 'Js 7h 2c', [
      [3, 'fold'],
      [0, 'fold'],
      [1, 'call'],
      [2, 'check'],
      [1, 'bet', bet],
    ], [1000, 1000, 2000, 1000]);
    let calls = 0;
    for (let i = 0; i < 40; i++) {
      const d = decide({ view: hand.viewFor(2), style: 'shark', difficulty: 'pro', stats: {}, tilt: 0, seed: seed(i) });
      if (d.action.kind !== 'fold') calls++;
    }
    return calls / 40;
  };
  const small = freq(50);
  const huge = freq(900);
  assert.ok(small > huge, `continues more vs small bet (${small}) than vs overbet (${huge})`);
  assert.ok(small >= 0.8, `top pair continues vs a small bet (${small})`);
});

function bookFor(id: string, style: 'folder' | 'station', hands: number): StatsBook {
  const book: StatsBook = {};
  const rng = new SeededRng(`book-${style}`);
  for (let i = 0; i < hands; i++) {
    const { hand } = HoldemHand.start({ handNumber: i + 1, seats: [{ id, stack: 1000 }, { id: 'hero', stack: 1000 }], button: i % 2, blinds: BLINDS }, Deck.shuffled(rng));
    let guard = 0;
    while (!hand.isComplete && guard++ < 50) {
      const seat = hand.toAct!;
      const legal = hand.legalActions()!;
      let action;
      if (hand.seatId(seat) === id) {
        if (style === 'folder') action = legal.canCheck ? { kind: 'check' as const } : { kind: 'fold' as const };
        else action = legal.canCall ? { kind: 'call' as const } : { kind: 'check' as const };
      } else {
        action = legal.aggression && hand.viewFor(null).street !== 'preflop' ? { kind: legal.aggression, to: legal.minTo } : legal.canCall ? { kind: 'call' as const } : { kind: 'check' as const };
      }
      hand.act(seat, action);
    }
    observeHand(book, publicRecordFromView(hand.viewFor(null)));
  }
  return book;
}

test('opponent model: estimates move with evidence, slowly at first', () => {
  const few = bookFor('villain', 'folder', 3);
  const many = bookFor('villain', 'folder', 80);
  const opts = { tableSize: 2, recencyWeight: 0.5 };
  const prior = estimate(undefined, 'foldToBet', opts);
  const early = estimate(few.villain, 'foldToBet', opts);
  const late = estimate(many.villain, 'foldToBet', opts);
  assert.ok(early > prior && early < 0.8, `a few hands barely move the read (${prior.toFixed(2)} → ${early.toFixed(2)})`);
  assert.ok(late > 0.85, `a long record of folding is recognised (${late.toFixed(2)})`);
  const station = bookFor('villain', 'station', 80);
  assert.ok(estimate(station.villain, 'foldToBet', opts) < 0.15, 'a calling station is recognised');
  assert.ok(tendencies(station.villain, 2, 0, 0).foldToBet === tendencies(undefined, 2, 0, 0).foldToBet, 'casual AIs ignore reads');
});

test('adaptation: the AI bluffs a habitual folder more than a calling station', () => {
  const hand = spot({ 3: 'Kc Qc', 2: '5d 6d' }, 'Ah 9s 4d 2s 7h', [
    [3, 'call'],
    [0, 'fold'],
    [1, 'fold'],
    [2, 'check'],
    [2, 'check'],
    [3, 'check'],
    [2, 'check'],
    [3, 'check'],
    [2, 'check'],
  ]);
  const view = hand.viewFor(3);
  const villain = view.seats[2]!.id!;
  const betFreq = (book: StatsBook) => {
    let bets = 0;
    for (let i = 0; i < 60; i++) {
      if (decide({ view, style: 'shark', difficulty: 'elite', stats: book, tilt: 0, seed: seed(i) }).action.kind === 'bet') bets++;
    }
    return bets / 60;
  };
  const vsFolder = betFreq(bookFor(villain, 'folder', 120));
  const vsStation = betFreq(bookFor(villain, 'station', 120));
  assert.ok(vsFolder > vsStation + 0.2, `bluffs folder ${vsFolder} vs station ${vsStation}`);
});

test('personalities produce different preflop styles from the same engine', () => {
  const rng = new SeededRng('styles');
  const vpip: Record<string, number> = {};
  for (const style of ['rock', 'maniac', 'shark'] as const) {
    let played = 0;
    const r = new SeededRng('styles-deal');
    for (let i = 0; i < 120; i++) {
      const { hand } = HoldemHand.start({ handNumber: 1, seats: seats(1000, 1000, 1000, 1000), button: 0, blinds: BLINDS }, Deck.shuffled(r));
      const d = decide({ view: hand.viewFor(3), style, difficulty: 'pro', stats: {}, tilt: 0, seed: seed(i) });
      if (d.action.kind !== 'fold') played++;
    }
    vpip[style] = played / 120;
  }
  void rng;
  assert.ok(vpip.maniac! > vpip.shark! && vpip.shark! > vpip.rock!, JSON.stringify(vpip));
  assert.ok(vpip.rock! < 0.2 && vpip.maniac! > 0.35, JSON.stringify(vpip));
});

test('sanitizeDecision always yields a legal action', () => {
  const hand = spot({}, '', [[3, 'raise', 150]]);
  const legal = hand.legalActions()!;
  const cases = [
    { kind: 'check' as const },
    { kind: 'bet' as const, to: 10 },
    { kind: 'raise' as const, to: 1 },
    { kind: 'raise' as const, to: 99999 },
    { kind: 'raise' as const },
    { kind: 'nonsense' } as never,
  ];
  for (const c of cases) hand.validate(hand.toAct!, sanitizeDecision(c, legal));
  void parseCards;
  void emptyStats;
});
