/**
 * Developer tool: runs the AI on hand-picked spots and prints its action frequencies and the
 * EV of each option. Useful when tuning the decision engine.   node scripts/dev/ai-spots.ts
 */
import { HoldemHand } from '../../src/engine/hand.ts';
import { riggedDeck, seats, BLINDS } from '../../tests/helpers.ts';
import { decide } from '../../src/ai/decide.ts';
import { cardsToString } from '../../src/engine/cards.ts';
import type { Difficulty, StyleId } from '../../src/ai/profiles.ts';
import type { ActionKind } from '../../src/engine/types.ts';

type Step = [number, ActionKind, number?];
function spot(label: string, holes: Record<number, string>, board: string, script: Step[], style: StyleId = 'shark', diff: Difficulty = 'pro', runs = 30) {
  const setup = { handNumber: 1, seats: seats(1000, 1000, 1000, 1000), button: 0, blinds: BLINDS };
  const { hand } = HoldemHand.start(setup, riggedDeck(setup, holes, board));
  for (const [s, k, to] of script) hand.act(s, to === undefined ? { kind: k } : { kind: k, to });
  const seat = hand.toAct!;
  const view = hand.viewFor(seat);
  const tally: Record<string, number> = {};
  let ms = 0;
  let last = null as ReturnType<typeof decide>['debug'] | null;
  for (let i = 0; i < runs; i++) {
    const d = decide({ view, style, difficulty: diff, stats: {}, tilt: 0, seed: [i + 1, 2, 3, 4] });
    const key = d.action.kind + (d.action.to ? ' ' + d.action.to : '');
    tally[key] = (tally[key] ?? 0) + 1;
    ms += d.debug.ms;
    last = d.debug;
  }
  console.log(`${label} [${style}/${diff}] ${cardsToString(view.seats[seat]!.holeCards!)} | ${cardsToString(view.board) || '-'} | eq ${last!.equity}`);
  console.log('   ', JSON.stringify(tally), `avg ${Math.round(ms / runs)}ms`);
  console.log('   ', last!.candidates.map((c) => `${c.label}: ev ${c.ev} p ${c.probability}`).join(' | '));
}
const limp: Step[] = [[3, 'call'], [0, 'fold'], [1, 'call'], [2, 'check']];
spot('UTG aces', { 3: 'As Ad' }, '', []);
spot('UTG AJo', { 3: 'Ac Jd' }, '', []);
spot('UTG 72o', { 3: '7c 2d' }, '', []);
spot('BTN 87s vs open', { 0: '8h 7h' }, '', [[3, 'raise', 125]]);
spot('SB KK vs open', { 1: 'Ks Kd' }, '', [[3, 'raise', 125], [0, 'fold']]);
spot('BB 94o vs BTN min-raise', { 2: '9c 4d' }, '', [[3, 'fold'], [0, 'raise', 100], [1, 'fold']]);
spot('Flop air vs pot bet', { 3: '7c 2d', 1: 'Ah Kd' }, 'As 9h 4c', [...limp, [1, 'bet', 150]]);
spot('Flop set vs bet', { 3: '9c 9d', 1: 'Ah Kd' }, 'As 9h 4c', [...limp, [1, 'bet', 100]]);
spot('Flop nut FD, checked to', { 3: 'Kh Qh', 1: '5c 5d' }, 'Ah 9h 4c', [...limp, [1, 'check'], [2, 'check']]);
spot('Flop TPTK, checked to', { 3: 'As Kd', 1: '5c 5d' }, 'Ah 9h 4c', [...limp, [1, 'check'], [2, 'check']]);
spot('Flop 3rd pair, checked to', { 3: '4s 3s', 1: '5c 5d' }, 'Ah 9h 4c', [...limp, [1, 'check'], [2, 'check']]);
const river: Step[] = [...limp, [1, 'check'], [2, 'fold' as ActionKind]];
spot('River TP vs overbet (rock)', { 3: 'Ac Jd', 1: '8h 7h' }, 'As 9h 4c 2h 6d', [[3, 'call'], [0, 'fold'], [1, 'call'], [2, 'check'], [1, 'check'], [2, 'check'], [3, 'bet', 75], [1, 'call'], [2, 'fold'], [1, 'check'], [3, 'check'], [1, 'bet', 600]], 'rock');
spot('River TP vs overbet (station)', { 3: 'Ac Jd', 1: '8h 7h' }, 'As 9h 4c 2h 6d', [[3, 'call'], [0, 'fold'], [1, 'call'], [2, 'check'], [1, 'check'], [2, 'check'], [3, 'bet', 75], [1, 'call'], [2, 'fold'], [1, 'check'], [3, 'check'], [1, 'bet', 600]], 'station');
spot('River busted draw, checked to', { 3: 'Kh Qh', 1: '5c 5d' }, 'Ah 9h 4c 2s 7d', [[3, 'call'], [0, 'fold'], [1, 'call'], [2, 'fold' as ActionKind]].slice(0, 3).concat([[2, 'check'], [1, 'check'], [2, 'check'], [3, 'check'], [1, 'check'], [2, 'check'], [3, 'check'], [1, 'check'], [2, 'check']]) as Step[]);
spot('UTG 72o (casual maniac)', { 3: '7c 2d' }, '', [], 'maniac', 'casual');
spot('UTG A5s (maniac pro)', { 3: 'Ah 5h' }, '', [], 'maniac', 'pro');
spot('UTG A5s (rock pro)', { 3: 'Ah 5h' }, '', [], 'rock', 'pro');
void river;
