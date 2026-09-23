/**
 * Card representation.
 *
 * A card is an integer 0..51: rank = card >> 2 (0 = deuce … 12 = ace), suit = card & 3
 * (0 = clubs, 1 = diamonds, 2 = hearts, 3 = spades). Integers keep the evaluator and the
 * AI's Monte Carlo loops allocation-free and make "every card exists once" trivially checkable.
 */
export type Card = number;

export const RANK_CHARS = '23456789TJQKA';
export const SUIT_CHARS = 'cdhs';
export const DECK_SIZE = 52;

export const RANK_NAMES = [
  'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace',
] as const;
export const RANK_PLURALS = [
  'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces',
] as const;
export const SUIT_NAMES = ['clubs', 'diamonds', 'hearts', 'spades'] as const;

export function makeCard(rank: number, suit: number): Card {
  return rank * 4 + suit;
}

export function rankOf(card: Card): number {
  return card >> 2;
}

export function suitOf(card: Card): number {
  return card & 3;
}

export function isValidCard(value: unknown): value is Card {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < DECK_SIZE;
}

export function cardToString(card: Card): string {
  return RANK_CHARS[rankOf(card)] + SUIT_CHARS[suitOf(card)];
}

export function cardsToString(cards: readonly Card[]): string {
  return cards.map(cardToString).join(' ');
}

/** Human-readable name, e.g. "Ace of spades" (used for screen-reader labels). */
export function cardName(card: Card): string {
  return `${RANK_NAMES[rankOf(card)]} of ${SUIT_NAMES[suitOf(card)]}`;
}

export function parseCard(text: string): Card {
  const t = text.trim();
  if (t.length !== 2) throw new Error(`Invalid card "${text}"`);
  const rank = RANK_CHARS.indexOf(t[0]!.toUpperCase());
  const suit = SUIT_CHARS.indexOf(t[1]!.toLowerCase());
  if (rank < 0 || suit < 0) throw new Error(`Invalid card "${text}"`);
  return makeCard(rank, suit);
}

/** Parses "As Kd", "As,Kd" or "AsKd". */
export function parseCards(text: string): Card[] {
  const compact = text.replace(/[\s,]+/g, '');
  if (compact.length % 2 !== 0) throw new Error(`Invalid card list "${text}"`);
  const out: Card[] = [];
  for (let i = 0; i < compact.length; i += 2) out.push(parseCard(compact.slice(i, i + 2)));
  return out;
}

export function orderedDeck(): Card[] {
  return Array.from({ length: DECK_SIZE }, (_, i) => i);
}

/** True when every card is valid and no card appears twice. */
export function allDistinct(cards: readonly Card[]): boolean {
  let seenLo = 0;
  let seenHi = 0;
  for (const c of cards) {
    if (!isValidCard(c)) return false;
    if (c < 32) {
      const bit = 1 << c;
      if (seenLo & bit) return false;
      seenLo |= bit;
    } else {
      const bit = 1 << (c - 32);
      if (seenHi & bit) return false;
      seenHi |= bit;
    }
  }
  return true;
}
