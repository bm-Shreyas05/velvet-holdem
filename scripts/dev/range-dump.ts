/** Developer tool: prints the range the AI assigns to an opponent at a given spot. */
import { HoldemHand } from '../../src/engine/hand.ts';
import { riggedDeck, seats, BLINDS } from '../../tests/helpers.ts';
import { buildRange } from '../../src/ai/ranges.ts';
import { tendencies } from '../../src/ai/model.ts';
import { boardStrength } from '../../src/ai/strength.ts';
import { COMBO_A, COMBO_B, COMBO_COUNT } from '../../src/ai/combos.ts';
import { cardsToString } from '../../src/engine/cards.ts';
import type { ActionKind } from '../../src/engine/types.ts';

const setup = { handNumber: 1, seats: seats(1000, 1000, 1000, 1000), button: 0, blinds: BLINDS };
const { hand } = HoldemHand.start(setup, riggedDeck(setup, { 3: 'Ac Jd', 1: '8h 7h' }, 'As 9h 4c 2h 6d'));
const script: [number, ActionKind, number?][] = [[3, 'call'], [0, 'fold'], [1, 'call'], [2, 'check'], [1, 'check'], [2, 'check'], [3, 'bet', 75], [1, 'call'], [2, 'fold'], [1, 'check'], [3, 'check'], [1, 'bet', 600]];
for (const [s, k, to] of script) hand.act(s, to === undefined ? { kind: k } : { kind: k, to });
const view = hand.viewFor(3);
const t = tendencies(undefined, 4, 1, 1);
const r = buildRange(1, { view, dead: [...view.seats[3]!.holeCards!, ...view.board], depth: 1, tendenciesOf: () => t });
const str = boardStrength(view.board);
const mine = str[(() => { for (let k = 0; k < COMBO_COUNT; k++) if ((COMBO_A[k] === view.seats[3]!.holeCards![0] && COMBO_B[k] === view.seats[3]!.holeCards![1]) || (COMBO_B[k] === view.seats[3]!.holeCards![0] && COMBO_A[k] === view.seats[3]!.holeCards![1])) return k; return 0; })()]!;
console.log('my strength', mine.toFixed(3));
const buckets = new Array(10).fill(0);
for (let k = 0; k < COMBO_COUNT; k++) if (str[k]! >= 0) buckets[Math.min(9, Math.floor(str[k]! * 10))] += r.current[k]!;
console.log('range mass by strength decile:', buckets.map((b) => b.toFixed(3)).join(' '));
const top = Array.from({ length: COMBO_COUNT }, (_, k) => k).sort((a, b) => r.current[b]! - r.current[a]!).slice(0, 25);
console.log(top.map((k) => `${cardsToString([COMBO_A[k]!, COMBO_B[k]!])}(${str[k]!.toFixed(2)}):${(r.current[k]! * 1000).toFixed(1)}`).join('  '));
