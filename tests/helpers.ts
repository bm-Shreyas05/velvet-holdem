import { type Card, orderedDeck, parseCards } from '../src/engine/cards.ts';
import { Deck } from '../src/engine/deck.ts';
import { HoldemHand, type HandSetup } from '../src/engine/hand.ts';
import type { HandEvent, PlayerAction } from '../src/engine/types.ts';

/**
 * Builds a deck that deals the requested hole cards and board, following the real dealing order
 * (one card at a time, two passes starting left of the button, burn before each street).
 */
export function riggedDeck(setup: Pick<HandSetup, 'seats' | 'button'>, holes: Record<number, string>, board = ''): Deck {
  const n = setup.seats.length;
  const order: number[] = [];
  for (let k = 1; k <= n; k++) {
    const seat = (setup.button + k) % n;
    const p = setup.seats[seat];
    if (p && p.stack > 0) order.push(seat);
  }
  const wanted: (Card | null)[] = [];
  const holeCards = new Map<number, Card[]>();
  for (const [seat, text] of Object.entries(holes)) holeCards.set(Number(seat), parseCards(text));
  for (let pass = 0; pass < 2; pass++) for (const seat of order) wanted.push(holeCards.get(seat)?.[pass] ?? null);
  const boardCards = board ? parseCards(board) : [];
  const b = (i: number) => boardCards[i] ?? null;
  wanted.push(null, b(0), b(1), b(2), null, b(3), null, b(4));

  const used = new Set(wanted.filter((c): c is Card => c !== null));
  if (used.size !== wanted.filter((c) => c !== null).length) throw new Error('riggedDeck: duplicate card requested');
  const filler = orderedDeck().filter((c) => !used.has(c));
  const deck = wanted.map((c) => (c === null ? filler.shift()! : c));
  deck.push(...filler);
  return new Deck(deck);
}

export function startHand(setup: HandSetup, holes: Record<number, string> = {}, board = '') {
  return HoldemHand.start(setup, riggedDeck(setup, holes, board));
}

export function seats(...stacks: number[]) {
  return stacks.map((stack, i) => ({ id: `p${i}`, stack }));
}

export const BLINDS = { smallBlind: 25, bigBlind: 50, ante: 0 };

export function play(hand: HoldemHand, steps: [number, PlayerAction['kind'], number?][]): HandEvent[] {
  const out: HandEvent[] = [];
  for (const [seat, kind, to] of steps) {
    out.push(...hand.act(seat, to === undefined ? { kind } : { kind, to }));
    const problems = hand.checkInvariants();
    if (problems.length) throw new Error(`Invariant failure after ${seat} ${kind}: ${problems.join('; ')}`);
  }
  return out;
}

export function stacksOf(hand: HoldemHand): number[] {
  return hand.viewFor(null).seats.map((s) => s.stack);
}
