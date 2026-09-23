import { type Card, allDistinct, isValidCard } from './cards.ts';
import { Deck, type DeckSnapshot } from './deck.ts';
import { evaluate } from './evaluator.ts';
import { buildPots, splitPot } from './pots.ts';
import type {
  ActionLogEntry,
  BlindConfig,
  HandEvent,
  HandPhase,
  HandResult,
  HandView,
  LegalActions,
  PlayerAction,
  PostKind,
  PotResult,
  RevealedHand,
  SeatView,
  Street,
} from './types.ts';

export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}

export interface HandPlayerInput {
  id: string;
  stack: number;
}

export interface HandSetup {
  handNumber: number;
  /** Index = seat number (clockwise). Null or a zero stack means the seat is not dealt in. */
  seats: (HandPlayerInput | null)[];
  button: number;
  blinds: BlindConfig;
  /** Seats that always table their hand at showdown instead of mucking a beaten hand. */
  alwaysShow?: number[];
}

interface SeatState {
  id: string | null;
  inHand: boolean;
  startStack: number;
  stack: number;
  hole: Card[];
  streetCommit: number;
  totalCommit: number;
  folded: boolean;
  allIn: boolean;
  acted: boolean;
  levelWhenActed: number;
  revealed: boolean;
  mucked: boolean;
}

export interface HandStateData {
  version: 1;
  handNumber: number;
  blinds: BlindConfig;
  button: number;
  smallBlindSeat: number | null;
  bigBlindSeat: number;
  seats: SeatState[];
  board: Card[];
  phase: HandPhase;
  street: Street;
  currentBet: number;
  lastFullRaise: number;
  raiseCount: number;
  toAct: number | null;
  lastAggressor: number | null;
  actions: ActionLogEntry[];
  deck: DeckSnapshot;
  result: HandResult | null;
  alwaysShow: number[];
  uncalled: { seat: number; amount: number }[];
  totalChips: number;
}

const NEXT_STREET: Record<Street, Exclude<Street, 'preflop'> | null> = {
  preflop: 'flop',
  flop: 'turn',
  turn: 'river',
  river: null,
};

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * One hand of No-Limit Texas Hold'em: blinds, dealing, four betting rounds, all-in run-outs,
 * showdown, side pots and chip distribution. The complete state (including every hole card and
 * the deck) is held in true private fields; the outside world interacts through `act()` and
 * receives information only through `viewFor()` and filtered events.
 */
export class HoldemHand {
  #s: HandStateData;
  #deck: Deck;

  private constructor(state: HandStateData, deck: Deck) {
    this.#s = state;
    this.#deck = deck;
  }

  // -------------------------------------------------------------------------------------------
  // Construction

  static start(setup: HandSetup, deck: Deck): { hand: HoldemHand; events: HandEvent[] } {
    const { seats, button, blinds, handNumber } = setup;
    if (!Array.isArray(seats) || seats.length < 2 || seats.length > 10) throw new Error('A table needs 2–10 seats');
    if (!isNonNegInt(handNumber)) throw new Error('Invalid hand number');
    if (!isNonNegInt(blinds.smallBlind) || !isNonNegInt(blinds.bigBlind) || !isNonNegInt(blinds.ante)) {
      throw new Error('Blinds must be non-negative integers');
    }
    if (blinds.bigBlind <= 0 || blinds.smallBlind > blinds.bigBlind) throw new Error('Invalid blind structure');
    if (deck.dealtCount !== 0) throw new Error('A hand must start from a fresh deck');

    const ids = new Set<string>();
    const state: SeatState[] = seats.map((p) => {
      if (p && (typeof p.id !== 'string' || !isNonNegInt(p.stack))) throw new Error('Invalid seat');
      if (p) {
        if (ids.has(p.id)) throw new Error(`Duplicate player id ${p.id}`);
        ids.add(p.id);
      }
      const inHand = !!p && p.stack > 0;
      return {
        id: p ? p.id : null,
        inHand,
        startStack: p ? p.stack : 0,
        stack: p ? p.stack : 0,
        hole: [],
        streetCommit: 0,
        totalCommit: 0,
        folded: false,
        allIn: false,
        acted: false,
        levelWhenActed: 0,
        revealed: false,
        mucked: false,
      };
    });
    const dealtIn = state.filter((s) => s.inHand).length;
    if (dealtIn < 2) throw new Error('At least two players with chips are required');
    if (!isNonNegInt(button) || button >= seats.length || !state[button]!.inHand) {
      throw new Error('The button must be on a seat that is dealt in');
    }

    const data: HandStateData = {
      version: 1,
      handNumber,
      blinds: { ...blinds },
      button,
      smallBlindSeat: null,
      bigBlindSeat: -1,
      seats: state,
      board: [],
      phase: 'preflop',
      street: 'preflop',
      currentBet: 0,
      lastFullRaise: blinds.bigBlind,
      raiseCount: 0,
      toAct: null,
      lastAggressor: null,
      actions: [],
      deck: deck.snapshot(),
      result: null,
      alwaysShow: [...(setup.alwaysShow ?? [])],
      uncalled: [],
      totalChips: state.reduce((sum, s) => sum + s.stack, 0),
    };
    const hand = new HoldemHand(data, deck);
    const events = hand.#begin();
    return { hand, events };
  }

  #begin(): HandEvent[] {
    const s = this.#s;
    const events: HandEvent[] = [];
    const headsUp = s.seats.filter((x) => x.inHand).length === 2;
    const sb = headsUp ? s.button : this.#nextInHand(s.button);
    const bb = this.#nextInHand(sb);
    s.smallBlindSeat = sb;
    s.bigBlindSeat = bb;

    events.push({
      type: 'hand-start',
      handNumber: s.handNumber,
      button: s.button,
      smallBlindSeat: sb,
      bigBlindSeat: bb,
      blinds: { ...s.blinds },
      stacks: s.seats.map((x) => x.stack),
      inHand: s.seats.map((x) => x.inHand),
    });

    if (s.blinds.ante > 0) {
      for (const seat of this.#orderFrom(s.button)) this.#post(seat, 'ante', s.blinds.ante, events);
    }
    this.#post(sb, 'small-blind', s.blinds.smallBlind, events);
    this.#post(bb, 'big-blind', s.blinds.bigBlind, events);
    // Callers owe the full big blind even if the big blind itself is short (standard rule).
    s.currentBet = s.blinds.bigBlind;
    s.lastFullRaise = s.blinds.bigBlind;

    // Deal one card at a time, starting left of the button, like a live dealer.
    const order = this.#orderFrom(s.button);
    for (let pass = 0; pass < 2; pass++) for (const seat of order) s.seats[seat]!.hole.push(this.#deck.deal());
    s.deck = this.#deck.snapshot();
    events.push({ type: 'deal-hole', order });
    for (const seat of order) events.push({ type: 'hole-cards', seat, cards: [...s.seats[seat]!.hole] });

    const first = this.#findNextToAct(bb);
    if (first === null) this.#completeRound(events);
    else s.toAct = first;
    return events;
  }

  #post(seat: number, kind: PostKind, nominal: number, events: HandEvent[]): void {
    const s = this.#s;
    const p = s.seats[seat]!;
    const amount = Math.min(nominal, p.stack);
    if (amount <= 0) return;
    const potBefore = this.#potTotal();
    p.stack -= amount;
    p.totalCommit += amount;
    if (kind !== 'ante') p.streetCommit += amount;
    if (p.stack === 0) p.allIn = true;
    s.actions.push({
      street: 'preflop',
      seat,
      kind,
      amount,
      to: p.streetCommit,
      allIn: p.allIn,
      facing: 0,
      potBefore,
      currentBetBefore: 0,
      raiseCountBefore: 0,
    });
    events.push({ type: 'post', seat, kind, amount, allIn: p.allIn });
  }

  // -------------------------------------------------------------------------------------------
  // Seat order helpers

  #nextInHand(from: number): number {
    const n = this.#s.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (this.#s.seats[i]!.inHand) return i;
    }
    throw new Error('No seat is dealt in');
  }

  /** Dealt-in seats clockwise, starting with the seat after `from`. */
  #orderFrom(from: number): number[] {
    const n = this.#s.seats.length;
    const out: number[] = [];
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (this.#s.seats[i]!.inHand) out.push(i);
    }
    return out;
  }

  #live(): number[] {
    const out: number[] = [];
    this.#s.seats.forEach((p, i) => {
      if (p.inHand && !p.folded) out.push(i);
    });
    return out;
  }

  #potTotal(): number {
    return this.#s.seats.reduce((sum, p) => sum + p.totalCommit, 0);
  }

  // -------------------------------------------------------------------------------------------
  // Betting rules

  /** Whether some other live player could still respond to a bet by this player. */
  #othersCanAct(seat: number): boolean {
    return this.#s.seats.some((p, i) => i !== seat && p.inHand && !p.folded && !p.allIn);
  }

  #maxOtherCommit(seat: number): number {
    let max = 0;
    this.#s.seats.forEach((p, i) => {
      if (i !== seat && p.inHand && !p.folded && p.streetCommit > max) max = p.streetCommit;
    });
    return max;
  }

  /**
   * The bet level this player must match. Normally the current bet; but when every other live
   * player is already all-in, only what they actually put in can be called.
   */
  #effectiveBet(seat: number): number {
    return this.#othersCanAct(seat) ? this.#s.currentBet : this.#maxOtherCommit(seat);
  }

  #needsToAct(seat: number): boolean {
    const p = this.#s.seats[seat]!;
    if (!p.inHand || p.folded || p.allIn) return false;
    if (this.#othersCanAct(seat)) return !p.acted || p.streetCommit < this.#s.currentBet;
    return p.streetCommit < this.#maxOtherCommit(seat);
  }

  #findNextToAct(after: number): number | null {
    const n = this.#s.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (after + k) % n;
      if (this.#needsToAct(i)) return i;
    }
    return null;
  }

  #legalFor(seat: number): LegalActions {
    const s = this.#s;
    const p = s.seats[seat]!;
    const othersCanAct = this.#othersCanAct(seat);
    const effBet = this.#effectiveBet(seat);
    const toCall = Math.max(0, Math.min(effBet - p.streetCommit, p.stack));
    const reopened = !p.acted || s.currentBet - p.levelWhenActed >= s.lastFullRaise;
    const canAggress = othersCanAct && p.stack > s.currentBet - p.streetCommit && reopened;
    const maxTo = p.streetCommit + p.stack;
    const fullRaiseTo = s.currentBet === 0 ? s.blinds.bigBlind : s.currentBet + s.lastFullRaise;
    return {
      seat,
      toCall,
      canFold: toCall > 0,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      callIsAllIn: toCall > 0 && toCall === p.stack,
      aggression: canAggress ? (s.currentBet === 0 ? 'bet' : 'raise') : null,
      minTo: canAggress ? Math.min(fullRaiseTo, maxTo) : 0,
      maxTo: canAggress ? maxTo : 0,
      fullRaiseTo,
      currentBet: s.currentBet,
      streetCommit: p.streetCommit,
      stack: p.stack,
      pot: this.#potTotal(),
      bigBlind: s.blinds.bigBlind,
    };
  }

  legalActions(): LegalActions | null {
    const seat = this.#s.toAct;
    return seat === null ? null : this.#legalFor(seat);
  }

  /** Throws IllegalActionError with a player-readable reason if the action is not allowed. */
  validate(seat: number, action: PlayerAction): void {
    const s = this.#s;
    if (s.phase === 'complete') throw new IllegalActionError('The hand is over.');
    if (s.toAct !== seat) throw new IllegalActionError('It is not this player\'s turn.');
    const legal = this.#legalFor(seat);
    switch (action?.kind) {
      case 'fold':
        if (!legal.canFold) throw new IllegalActionError('Folding is not needed — checking is free.');
        return;
      case 'check':
        if (!legal.canCheck) throw new IllegalActionError(`There is a bet to call (${legal.toCall}).`);
        return;
      case 'call':
        if (!legal.canCall) throw new IllegalActionError('There is nothing to call.');
        return;
      case 'bet':
      case 'raise': {
        if (legal.aggression !== action.kind) {
          throw new IllegalActionError(
            legal.aggression ? `You can ${legal.aggression}, not ${action.kind}.` : 'Raising is not allowed here.',
          );
        }
        const to = action.to;
        if (typeof to !== 'number' || !Number.isInteger(to)) throw new IllegalActionError('The amount must be a whole number of chips.');
        if (to > legal.maxTo) throw new IllegalActionError(`You only have ${legal.maxTo} available.`);
        if (to < legal.minTo) throw new IllegalActionError(`The minimum is ${legal.minTo}.`);
        if (to < legal.fullRaiseTo && to !== legal.maxTo) {
          throw new IllegalActionError(`The minimum is ${legal.fullRaiseTo} unless you go all-in.`);
        }
        return;
      }
      default:
        throw new IllegalActionError('Unknown action.');
    }
  }

  act(seat: number, action: PlayerAction): HandEvent[] {
    this.validate(seat, action);
    const s = this.#s;
    const p = s.seats[seat]!;
    const legal = this.#legalFor(seat);
    const events: HandEvent[] = [];
    const entry: ActionLogEntry = {
      street: s.street,
      seat,
      kind: action.kind,
      amount: 0,
      to: p.streetCommit,
      allIn: false,
      facing: legal.toCall,
      potBefore: this.#potTotal(),
      currentBetBefore: s.currentBet,
      raiseCountBefore: s.raiseCount,
    };

    switch (action.kind) {
      case 'fold':
        p.folded = true;
        break;
      case 'check':
        break;
      case 'call':
        this.#commit(p, legal.toCall);
        entry.amount = legal.toCall;
        break;
      case 'bet':
      case 'raise': {
        const to = action.to!;
        const add = to - p.streetCommit;
        const raiseSize = to - s.currentBet;
        if (raiseSize >= s.lastFullRaise) s.lastFullRaise = raiseSize;
        this.#commit(p, add);
        s.currentBet = to;
        s.raiseCount++;
        s.lastAggressor = seat;
        entry.amount = add;
        break;
      }
    }
    p.acted = true;
    p.levelWhenActed = s.currentBet;
    entry.to = p.streetCommit;
    entry.allIn = p.allIn;
    s.actions.push(entry);
    events.push({
      type: 'action',
      seat,
      street: s.street,
      kind: action.kind,
      amount: entry.amount,
      to: entry.to,
      allIn: entry.allIn,
    });

    this.#advance(seat, events);
    s.deck = this.#deck.snapshot();
    return events;
  }

  #commit(p: SeatState, amount: number): void {
    if (amount < 0 || amount > p.stack) throw new Error('Commit exceeds stack');
    p.stack -= amount;
    p.streetCommit += amount;
    p.totalCommit += amount;
    if (p.stack === 0) p.allIn = true;
  }

  // -------------------------------------------------------------------------------------------
  // Flow

  #advance(lastSeat: number, events: HandEvent[]): void {
    const live = this.#live();
    if (live.length === 1) {
      this.#finishUncontested(live[0]!, events);
      return;
    }
    const next = this.#findNextToAct(lastSeat);
    if (next !== null) {
      this.#s.toAct = next;
      return;
    }
    this.#completeRound(events);
  }

  #returnUncalled(events: HandEvent[]): void {
    const s = this.#s;
    let top = -1;
    let max = 0;
    let second = 0;
    s.seats.forEach((p, i) => {
      if (!p.inHand) return;
      if (p.streetCommit > max) {
        second = max;
        max = p.streetCommit;
        top = i;
      } else if (p.streetCommit > second) {
        second = p.streetCommit;
      }
    });
    if (top < 0 || max <= second) return;
    const p = s.seats[top]!;
    if (p.folded) return;
    const refund = max - second;
    p.stack += refund;
    p.streetCommit -= refund;
    p.totalCommit -= refund;
    if (p.stack > 0) p.allIn = false;
    s.uncalled.push({ seat: top, amount: refund });
    events.push({ type: 'uncalled', seat: top, amount: refund });
  }

  #completeRound(events: HandEvent[]): void {
    const s = this.#s;
    s.toAct = null;
    this.#returnUncalled(events);
    events.push({ type: 'collect', street: s.street, pot: this.#potTotal() });

    const live = this.#live();
    if (live.length === 1) {
      // Possible only if everyone else was already all-in for less and folded out — defensive.
      this.#finishUncontested(live[0]!, events);
      return;
    }
    if (s.street === 'river') {
      this.#showdown(events);
      return;
    }
    this.#resetStreet();
    const canAct = live.filter((i) => !s.seats[i]!.allIn).length;
    if (canAct <= 1) {
      // No more betting possible: all hands are turned face up and the board is run out.
      for (const seat of this.#showdownOrder()) this.#reveal(seat, 'all-in', events);
      // (cast: TypeScript's narrowing does not see #dealNextStreet advancing the street)
      while ((s.street as Street) !== 'river') this.#dealNextStreet(events);
      this.#showdown(events);
      return;
    }
    this.#dealNextStreet(events);
    const first = this.#findNextToAct(s.button);
    if (first === null) throw new Error('Invariant: a new street started with nobody to act');
    s.toAct = first;
  }

  #resetStreet(): void {
    const s = this.#s;
    for (const p of s.seats) {
      p.streetCommit = 0;
      p.acted = false;
      p.levelWhenActed = 0;
    }
    s.currentBet = 0;
    s.lastFullRaise = s.blinds.bigBlind;
    s.raiseCount = 0;
    s.lastAggressor = null;
  }

  #dealNextStreet(events: HandEvent[]): void {
    const s = this.#s;
    const next = NEXT_STREET[s.street];
    if (!next) throw new Error('No street after the river');
    this.#deck.burn();
    const count = next === 'flop' ? 3 : 1;
    const cards: Card[] = [];
    for (let i = 0; i < count; i++) cards.push(this.#deck.deal());
    s.board.push(...cards);
    s.street = next;
    s.phase = next;
    s.deck = this.#deck.snapshot();
    events.push({ type: 'board', street: next, cards, board: [...s.board] });
  }

  #score(seat: number): number {
    const p = this.#s.seats[seat]!;
    return evaluate([...p.hole, ...this.#s.board]);
  }

  #reveal(seat: number, reason: 'all-in' | 'showdown', events: HandEvent[]): void {
    const p = this.#s.seats[seat]!;
    if (p.revealed) return;
    p.revealed = true;
    p.mucked = false;
    const score = this.#s.board.length >= 3 ? this.#score(seat) : 0;
    events.push({ type: 'reveal', seat, cards: [...p.hole], score, reason });
  }

  /** Last aggressor on the final street shows first; otherwise the first live seat left of the button. */
  #showdownOrder(): number[] {
    const s = this.#s;
    const live = new Set(this.#live());
    const start = s.lastAggressor !== null && live.has(s.lastAggressor) ? s.lastAggressor : null;
    const order = this.#orderFrom(start === null ? s.button : (start - 1 + s.seats.length) % s.seats.length);
    return order.filter((i) => live.has(i));
  }

  #showdown(events: HandEvent[]): void {
    const s = this.#s;
    const live = this.#live();
    const scores = new Map<number, number>();
    for (const seat of live) scores.set(seat, this.#score(seat));

    const allInShowdown = live.some((i) => s.seats[i]!.allIn) || live.every((i) => s.seats[i]!.revealed);
    let best = -1;
    for (const seat of this.#showdownOrder()) {
      const score = scores.get(seat)!;
      if (allInShowdown || score >= best || s.alwaysShow.includes(seat)) {
        this.#reveal(seat, 'showdown', events);
        if (score > best) best = score;
      } else {
        s.seats[seat]!.mucked = true;
        events.push({ type: 'muck', seat });
      }
    }

    const pots = buildPots(
      s.seats.map((p, seat) => ({ seat, amount: p.inHand ? p.totalCommit : 0, folded: !p.inHand || p.folded })),
    );
    const seatOrder = this.#orderFrom(s.button);
    const results: PotResult[] = pots.map((pot, index) => {
      let top = -1;
      for (const seat of pot.eligible) top = Math.max(top, scores.get(seat)!);
      const winners = pot.eligible.filter((seat) => scores.get(seat) === top);
      for (const w of winners) this.#reveal(w, 'showdown', events); // a winner can never have mucked; defensive
      return {
        index,
        amount: pot.amount,
        eligible: pot.eligible,
        contributions: pot.contributions,
        winners,
        shares: splitPot(pot.amount, winners, seatOrder),
        winningScore: pot.eligible.length > 1 ? top : null,
      };
    });
    this.#award(results, true, events);
  }

  #finishUncontested(winner: number, events: HandEvent[]): void {
    const s = this.#s;
    s.toAct = null;
    this.#returnUncalled(events);
    events.push({ type: 'collect', street: s.street, pot: this.#potTotal() });
    const contributions: Record<number, number> = {};
    s.seats.forEach((p, seat) => {
      if (p.inHand && p.totalCommit > 0) contributions[seat] = p.totalCommit;
    });
    const amount = this.#potTotal();
    this.#award(
      [
        {
          index: 0,
          amount,
          eligible: [winner],
          contributions,
          winners: [winner],
          shares: [{ seat: winner, amount }],
          winningScore: null,
        },
      ],
      false,
      events,
    );
  }

  #award(pots: PotResult[], showdown: boolean, events: HandEvent[]): void {
    const s = this.#s;
    for (const pot of pots) {
      for (const share of pot.shares) s.seats[share.seat]!.stack += share.amount;
      events.push({ type: 'award', pot, potCount: pots.length });
    }
    s.phase = 'complete';
    s.toAct = null;
    s.result = {
      showdown,
      pots,
      netChange: s.seats.map((p) => p.stack - p.startStack),
      finalStacks: s.seats.map((p) => p.stack),
      uncalled: s.uncalled.map((u) => ({ ...u })),
    };
    s.deck = this.#deck.snapshot();
    events.push({ type: 'hand-end', result: structuredClone(s.result) });
  }

  // -------------------------------------------------------------------------------------------
  // Read access

  get handNumber(): number {
    return this.#s.handNumber;
  }

  get isComplete(): boolean {
    return this.#s.phase === 'complete';
  }

  get toAct(): number | null {
    return this.#s.toAct;
  }

  get result(): HandResult | null {
    return this.#s.result ? structuredClone(this.#s.result) : null;
  }

  get seatCount(): number {
    return this.#s.seats.length;
  }

  /** Stable player id sitting in a seat. */
  seatId(seat: number): string | null {
    return this.#s.seats[seat]?.id ?? null;
  }

  /**
   * Builds the information-restricted view for one seat (or a spectator when viewer is null).
   * Other players' hole cards appear only once they have been shown. The result is a fresh,
   * deeply frozen object that shares nothing with the engine's internal state.
   */
  viewFor(viewer: number | null): HandView {
    const s = this.#s;
    const seats: SeatView[] = s.seats.map((p, seat) => ({
      seat,
      id: p.id,
      inHand: p.inHand,
      startStack: p.startStack,
      stack: p.stack,
      streetCommit: p.streetCommit,
      totalCommit: p.totalCommit,
      folded: p.folded,
      allIn: p.allIn,
      holeCards: p.inHand && (seat === viewer || p.revealed) ? [...p.hole] : null,
      hasCards: p.inHand && !p.folded && !p.mucked,
      revealed: p.revealed,
      mucked: p.mucked,
    }));
    const revealed: RevealedHand[] = [];
    s.seats.forEach((p, seat) => {
      if (p.revealed) revealed.push({ seat, cards: [...p.hole], score: s.board.length >= 3 ? this.#score(seat) : 0 });
    });
    const pot = this.#potTotal();
    const view: HandView = {
      handNumber: s.handNumber,
      blinds: { ...s.blinds },
      button: s.button,
      smallBlindSeat: s.smallBlindSeat,
      bigBlindSeat: s.bigBlindSeat,
      phase: s.phase,
      street: s.street,
      board: [...s.board],
      pot,
      collectedPot: pot - s.seats.reduce((sum, p) => sum + p.streetCommit, 0),
      currentBet: s.currentBet,
      lastFullRaise: s.lastFullRaise,
      toAct: s.toAct,
      viewer,
      seats,
      legal: viewer !== null && s.toAct === viewer ? this.#legalFor(viewer) : null,
      actions: s.actions.map((a) => ({ ...a })),
      revealed,
      result: s.result ? structuredClone(s.result) : null,
    };
    return deepFreeze(view);
  }

  /** Hole cards for one seat (used by the controller for the human's own cards and history). */
  holeCards(seat: number): Card[] {
    return [...(this.#s.seats[seat]?.hole ?? [])];
  }

  /** Full deck order — debug/replay records only, never passed to players. */
  deckOrder(): Card[] {
    return [...this.#s.deck.order];
  }

  // -------------------------------------------------------------------------------------------
  // Integrity

  checkInvariants(): string[] {
    const s = this.#s;
    const problems: string[] = [];
    const inHand = s.seats.filter((p) => p.inHand);

    for (const [i, p] of s.seats.entries()) {
      for (const [k, v] of [
        ['stack', p.stack],
        ['streetCommit', p.streetCommit],
        ['totalCommit', p.totalCommit],
      ] as const) {
        if (!isNonNegInt(v)) problems.push(`seat ${i}: ${k} is not a non-negative integer (${v})`);
      }
      if (p.streetCommit > p.totalCommit) problems.push(`seat ${i}: street commit exceeds total commit`);
      if (!p.inHand && (p.totalCommit > 0 || p.hole.length)) problems.push(`seat ${i}: not dealt in but has chips/cards in play`);
      if (p.inHand && p.hole.length !== 2) problems.push(`seat ${i}: expected 2 hole cards, has ${p.hole.length}`);
      if (s.phase !== 'complete' && p.inHand && !p.folded && p.allIn !== (p.stack === 0)) {
        problems.push(`seat ${i}: all-in flag (${p.allIn}) disagrees with stack ${p.stack}`);
      }
    }

    const stacks = s.seats.reduce((sum, p) => sum + p.stack, 0);
    const committed = this.#potTotal();
    const total = s.phase === 'complete' ? stacks : stacks + committed;
    if (total !== s.totalChips) problems.push(`chip conservation broken: ${total} vs ${s.totalChips}`);

    if (s.toAct !== null) {
      const p = s.seats[s.toAct];
      if (!p || !p.inHand || p.folded || p.allIn) problems.push('the player to act cannot act');
      if (s.phase === 'complete') problems.push('a completed hand has a player to act');
      if (!this.#needsToAct(s.toAct)) problems.push('the player to act does not need to act');
    } else if (s.phase !== 'complete') {
      problems.push('hand in progress with nobody to act');
    }
    if (s.phase !== 'complete') {
      for (const p of s.seats) if (p.streetCommit > s.currentBet) problems.push('a street commitment exceeds the current bet');
    }

    const expectedBoard = { preflop: 0, flop: 3, turn: 4, river: 5 }[s.street];
    if (s.board.length !== expectedBoard) problems.push(`board has ${s.board.length} cards on the ${s.street}`);

    // Every card in play came from this deck exactly once.
    const deck = this.#deck;
    const inPlay = [...inHand.flatMap((p) => p.hole), ...s.board, ...deck.burnedCards()];
    const dealt = deck.dealtCards();
    if (!allDistinct(inPlay)) problems.push('duplicate card in play');
    if (inPlay.length !== dealt.length || !inPlay.every((c) => dealt.includes(c))) {
      problems.push('cards in play do not match the cards dealt from the deck');
    }
    if (!s.board.every(isValidCard)) problems.push('invalid board card');

    if (s.phase === 'complete') {
      const r = s.result;
      if (!r) problems.push('completed hand without a result');
      else {
        const awarded = r.pots.reduce((sum, pot) => sum + pot.shares.reduce((a, x) => a + x.amount, 0), 0);
        const potSum = r.pots.reduce((sum, pot) => sum + pot.amount, 0);
        if (awarded !== potSum) problems.push('pot shares do not add up to the pots');
        if (potSum !== committed) problems.push(`pots (${potSum}) differ from committed chips (${committed})`);
        for (const pot of r.pots) {
          for (const w of pot.winners) {
            const p = s.seats[w]!;
            if (!pot.eligible.includes(w) || p.folded || !p.inHand) problems.push(`ineligible winner ${w} in pot ${pot.index}`);
          }
        }
      }
    }
    return problems;
  }

  // -------------------------------------------------------------------------------------------
  // Persistence

  serialize(): HandStateData {
    const data = structuredClone(this.#s);
    data.deck = this.#deck.snapshot();
    return data;
  }

  static restore(data: HandStateData): HoldemHand {
    if (!data || data.version !== 1 || !Array.isArray(data.seats) || !data.deck) {
      throw new Error('Unrecognised hand data');
    }
    const copy = structuredClone(data);
    if (!Array.isArray(copy.uncalled)) throw new Error('Unrecognised hand data');
    const hand = new HoldemHand(copy, Deck.restore(copy.deck));
    const problems = hand.checkInvariants();
    if (problems.length) throw new Error(`Saved hand failed integrity checks: ${problems.join('; ')}`);
    return hand;
  }
}
