import type { Card } from './cards.ts';
import { Deck } from './deck.ts';
import { HoldemHand, type HandSetup } from './hand.ts';
import type { HandEvent, HandResult, PlayerAction } from './types.ts';

/**
 * Everything needed to reproduce a hand exactly: the table before the deal, the deck order and
 * each player's decisions. Stored with every hand-history entry (not shown to the player) so any
 * reported problem can be replayed deterministically.
 */
export interface HandReplayData {
  setup: HandSetup;
  deckOrder: Card[];
  decisions: { seat: number; action: PlayerAction }[];
}

export interface ReplayOutcome {
  hand: HoldemHand;
  events: HandEvent[];
  result: HandResult | null;
}

export function replayHand(data: HandReplayData): ReplayOutcome {
  const { hand, events } = HoldemHand.start(structuredClone(data.setup), new Deck(data.deckOrder));
  for (const { seat, action } of data.decisions) {
    if (hand.isComplete) throw new Error('Replay has more decisions than the hand allowed');
    events.push(...hand.act(seat, action));
  }
  const problems = hand.checkInvariants();
  if (problems.length) throw new Error(`Replay broke invariants: ${problems.join('; ')}`);
  return { hand, events, result: hand.result };
}
