import type { Card } from './cards.ts';

export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export const STREETS: readonly Street[] = ['preflop', 'flop', 'turn', 'river'];
export type HandPhase = Street | 'complete';

export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise';
export type PostKind = 'ante' | 'small-blind' | 'big-blind';

/**
 * A player's decision. For bet/raise, `to` is the player's TOTAL commitment on this street after
 * the action ("raise to 300"), which is how players and dealers state raises.
 */
export interface PlayerAction {
  kind: ActionKind;
  to?: number;
}

export interface BlindConfig {
  smallBlind: number;
  bigBlind: number;
  ante: number;
}

export interface LegalActions {
  seat: number;
  /** Chips needed to call, already capped at the player's stack. */
  toCall: number;
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  /** True when calling puts the player all-in. */
  callIsAllIn: boolean;
  /** 'bet' when nobody has bet this street, 'raise' otherwise, null when the player may not raise. */
  aggression: 'bet' | 'raise' | null;
  /** Smallest legal bet/raise-to (may be an all-in for less than a full raise). */
  minTo: number;
  /** All-in amount as a raise-to. */
  maxTo: number;
  /** Smallest raise-to that counts as a full raise (anything below must be all-in). */
  fullRaiseTo: number;
  currentBet: number;
  streetCommit: number;
  stack: number;
  /** All chips in the middle, including bets in front of players. */
  pot: number;
  bigBlind: number;
}

export interface ActionLogEntry {
  street: Street;
  seat: number;
  kind: ActionKind | PostKind;
  /** Chips moved from the stack by this entry. */
  amount: number;
  /** The player's street commitment afterwards. */
  to: number;
  allIn: boolean;
  /** Chips the player needed to call before acting (0 for posts). */
  facing: number;
  /** All chips in the middle before this entry. */
  potBefore: number;
  currentBetBefore: number;
  /** Voluntary bets/raises already made on this street before this entry. */
  raiseCountBefore: number;
}

export interface PotResult {
  index: number;
  amount: number;
  eligible: number[];
  contributions: Record<number, number>;
  winners: number[];
  shares: { seat: number; amount: number }[];
  /** Winning hand score, or null when nobody else could contest the pot. */
  winningScore: number | null;
}

export interface HandResult {
  showdown: boolean;
  pots: PotResult[];
  /** Final stack minus starting stack, indexed by seat. */
  netChange: number[];
  finalStacks: number[];
  uncalled: { seat: number; amount: number }[];
}

export interface SeatView {
  seat: number;
  id: string | null;
  inHand: boolean;
  startStack: number;
  stack: number;
  streetCommit: number;
  totalCommit: number;
  folded: boolean;
  allIn: boolean;
  /** The viewer's own cards, or cards that have been shown. Null otherwise. */
  holeCards: Card[] | null;
  /** Whether the player still holds (face-down or face-up) cards. */
  hasCards: boolean;
  revealed: boolean;
  mucked: boolean;
}

export interface RevealedHand {
  seat: number;
  cards: Card[];
  score: number;
}

/**
 * Everything one seat is allowed to know about the hand. AI players only ever receive this
 * object (serialised across a worker boundary), never the engine itself.
 */
export interface HandView {
  handNumber: number;
  blinds: BlindConfig;
  button: number;
  smallBlindSeat: number | null;
  bigBlindSeat: number;
  phase: HandPhase;
  street: Street;
  board: Card[];
  /** All chips in the middle, including current-street bets. */
  pot: number;
  /** Chips gathered from completed streets. */
  collectedPot: number;
  currentBet: number;
  lastFullRaise: number;
  toAct: number | null;
  viewer: number | null;
  seats: SeatView[];
  legal: LegalActions | null;
  actions: ActionLogEntry[];
  revealed: RevealedHand[];
  result: HandResult | null;
}

export type HandEvent =
  | {
      type: 'hand-start';
      handNumber: number;
      button: number;
      smallBlindSeat: number | null;
      bigBlindSeat: number;
      blinds: BlindConfig;
      stacks: number[];
      inHand: boolean[];
    }
  | { type: 'post'; seat: number; kind: PostKind; amount: number; allIn: boolean }
  | { type: 'deal-hole'; order: number[] }
  /** PRIVATE: only ever delivered to `seat`. */
  | { type: 'hole-cards'; seat: number; cards: Card[] }
  | {
      type: 'action';
      seat: number;
      street: Street;
      kind: ActionKind;
      amount: number;
      to: number;
      allIn: boolean;
    }
  | { type: 'uncalled'; seat: number; amount: number }
  | { type: 'collect'; street: Street; pot: number }
  | { type: 'board'; street: Exclude<Street, 'preflop'>; cards: Card[]; board: Card[] }
  | { type: 'reveal'; seat: number; cards: Card[]; score: number; reason: 'all-in' | 'showdown' }
  | { type: 'muck'; seat: number }
  | { type: 'award'; pot: PotResult; potCount: number }
  | { type: 'hand-end'; result: HandResult };

/** Removes information the viewer is not entitled to (other players' hole cards). */
export function eventsVisibleTo(events: readonly HandEvent[], viewer: number | null): HandEvent[] {
  return events.filter((e) => e.type !== 'hole-cards' || e.seat === viewer);
}
