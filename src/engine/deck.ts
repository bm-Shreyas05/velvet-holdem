import { type Card, DECK_SIZE, allDistinct, orderedDeck } from './cards.ts';
import { type Rng, shuffle } from './rng.ts';

export interface DeckSnapshot {
  order: Card[];
  position: number;
  burned: Card[];
}

/**
 * One physical deck. The full order is fixed at shuffle time and never changes afterwards:
 * nothing can reorder, add or remove cards once the hand has started. Fields are true private
 * (#) fields, so no other module can peek at upcoming cards through the object.
 */
export class Deck {
  readonly #order: readonly Card[];
  #position: number;
  readonly #burned: Card[];

  constructor(order: readonly Card[], position = 0, burned: readonly Card[] = []) {
    if (order.length !== DECK_SIZE || !allDistinct(order)) {
      throw new Error('Deck must be a permutation of all 52 cards');
    }
    if (!Number.isInteger(position) || position < 0 || position > DECK_SIZE) {
      throw new Error('Deck position out of range');
    }
    const dealt = new Set(order.slice(0, position));
    if (!burned.every((c) => dealt.has(c)) || !allDistinct(burned)) {
      throw new Error('Burned cards must come from the dealt part of the deck');
    }
    this.#order = Object.freeze([...order]);
    this.#position = position;
    this.#burned = [...burned];
  }

  static shuffled(rng: Rng): Deck {
    return new Deck(shuffle(orderedDeck(), rng));
  }

  get remaining(): number {
    return DECK_SIZE - this.#position;
  }

  get dealtCount(): number {
    return this.#position;
  }

  deal(): Card {
    if (this.#position >= DECK_SIZE) throw new Error('Deck exhausted');
    return this.#order[this.#position++]!;
  }

  burn(): Card {
    const card = this.deal();
    this.#burned.push(card);
    return card;
  }

  burnedCards(): Card[] {
    return [...this.#burned];
  }

  /** Cards dealt so far, in dealing order. */
  dealtCards(): Card[] {
    return this.#order.slice(0, this.#position);
  }

  snapshot(): DeckSnapshot {
    return { order: [...this.#order], position: this.#position, burned: [...this.#burned] };
  }

  static restore(snapshot: DeckSnapshot): Deck {
    return new Deck(snapshot.order, snapshot.position, snapshot.burned);
  }
}
