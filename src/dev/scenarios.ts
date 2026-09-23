import { type Card, orderedDeck, parseCards } from '../engine/cards.ts';

/**
 * Developer scenarios (only reachable with #dev in the URL): the first hand is dealt from a
 * prepared deck so rare situations — split pots, multi-way all-ins with side pots — can be
 * checked in the real interface on demand. Everything after the deal is played normally by the
 * same engine and AI. Games started this way are marked "Seeded" in the top bar.
 */
export interface Scenario {
  id: string;
  label: string;
  description: string;
  /** Starting stacks by seat (seat 0 = the player). */
  stacks: number[];
  /** Button seat for the first hand. */
  button: number;
  holes: Record<number, string>;
  board: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'split-pot',
    label: 'Split pot',
    description: 'Everyone holds a big pair and the board runs out a royal flush: whoever reaches showdown splits the pot.',
    stacks: [1000, 1000, 1000, 1000],
    button: 0,
    holes: { 0: 'Ah Ad', 1: 'Kh Kd', 2: 'Qh Qd', 3: 'Jh Jd' },
    board: 'As Ks Qs Js Ts',
  },
  {
    id: 'side-pots',
    label: 'Side pots',
    description: 'Four stack sizes and four premium pairs: expect several all-ins, a main pot and side pots won by different players.',
    stacks: [1000, 250, 500, 750],
    button: 0,
    holes: { 0: 'Qh Qd', 1: 'Ah Ad', 2: 'Kh Kd', 3: 'Jh Jd' },
    board: '2c 7d 9s 3h 4c',
  },
];

/** A deck that deals the given hole cards and board in real dealing order (burns included). */
export function preparedDeck(seatCount: number, button: number, holes: Record<number, string>, board: string): Card[] {
  const order: number[] = [];
  for (let k = 1; k <= seatCount; k++) order.push((button + k) % seatCount);
  const wanted: (Card | null)[] = [];
  const hole = new Map(Object.entries(holes).map(([s, text]) => [Number(s), parseCards(text)]));
  for (let pass = 0; pass < 2; pass++) for (const seat of order) wanted.push(hole.get(seat)?.[pass] ?? null);
  const b = parseCards(board);
  wanted.push(null, b[0] ?? null, b[1] ?? null, b[2] ?? null, null, b[3] ?? null, null, b[4] ?? null);
  const used = new Set(wanted.filter((c): c is Card => c !== null));
  const filler = orderedDeck().filter((c) => !used.has(c));
  const deck = wanted.map((c) => (c === null ? filler.shift()! : c));
  deck.push(...filler);
  return deck;
}
