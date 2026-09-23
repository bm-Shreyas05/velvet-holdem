import type { Card } from '../engine/cards.ts';
import { describeHand } from '../engine/evaluator.ts';
import type { BlindConfig, HandEvent, HandPhase } from '../engine/types.ts';
import type { StyleId } from '../ai/profiles.ts';
import type { TableSnapshot } from '../game/controller.ts';
import { type ActionBadge, actionBadge, chips } from './format.ts';

/**
 * What the table shows, as plain data. The presenter advances it one engine event at a time so
 * animations can play between states, then reconciles it with the controller's authoritative
 * snapshot after every batch — the screen can never drift from the real game state.
 */
export interface SeatDisplay {
  seat: number;
  name: string;
  style: StyleId | null;
  isHuman: boolean;
  stack: number;
  bet: number;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  eliminated: boolean;
  place: number | null;
  /** [] = no cards, null entries = face down. */
  cards: (Card | null)[];
  mucked: boolean;
  badge: ActionBadge | null;
  handLabel: string | null;
  winner: boolean;
}

export interface TableDisplay {
  handNumber: number;
  phase: HandPhase | 'waiting';
  button: number;
  smallBlindSeat: number | null;
  bigBlindSeat: number | null;
  blinds: BlindConfig;
  board: Card[];
  /** Chips gathered in the middle (not counting bets still in front of players). */
  pot: number;
  toAct: number | null;
  seats: SeatDisplay[];
  humanSeat: number;
}

export function totalPot(d: TableDisplay): number {
  return d.pot + d.seats.reduce((s, x) => s + x.bet, 0);
}

export function displayFromSnapshot(snap: TableSnapshot): TableDisplay {
  const v = snap.view;
  const complete = v?.phase === 'complete';
  const winners = new Set(v?.result?.pots.flatMap((p) => p.winners) ?? []);
  return {
    handNumber: snap.handNumber,
    phase: v ? v.phase : 'waiting',
    button: v ? v.button : snap.button,
    smallBlindSeat: v ? v.smallBlindSeat : null,
    bigBlindSeat: v ? v.bigBlindSeat : null,
    blinds: { ...snap.blinds },
    board: v ? [...v.board] : [],
    pot: v && !complete ? v.collectedPot : 0,
    toAct: v ? v.toAct : null,
    humanSeat: snap.humanSeat,
    seats: snap.seats.map((s) => {
      const sv = v?.seats[s.seat];
      const inHand = !!sv?.inHand;
      const cards: (Card | null)[] = !inHand || !sv ? [] : sv.holeCards ? [...sv.holeCards] : sv.hasCards ? [null, null] : [];
      const revealed = v?.revealed.find((r) => r.seat === s.seat);
      return {
        seat: s.seat,
        name: s.name,
        style: s.style,
        isHuman: s.kind === 'human',
        stack: s.stack,
        bet: sv && !complete ? sv.streetCommit : 0,
        inHand,
        folded: !!sv?.folded,
        allIn: !!sv?.allIn,
        eliminated: s.eliminated,
        place: s.place,
        // Folded or mucked hands are gone from the table (even the player's own).
        cards: sv?.folded || sv?.mucked ? [] : cards,
        mucked: !!sv?.mucked,
        badge: null,
        handLabel: revealed && v!.board.length >= 3 ? describeHand(revealed.score) : null,
        winner: complete && winners.has(s.seat),
      };
    }),
  };
}

function clone(d: TableDisplay): TableDisplay {
  return { ...d, blinds: { ...d.blinds }, board: [...d.board], seats: d.seats.map((s) => ({ ...s, cards: [...s.cards] })) };
}

/** Advances the display by one engine event. Pure: returns a new object. */
export function applyEvent(prev: TableDisplay, e: HandEvent): TableDisplay {
  const d = clone(prev);
  const seat = (i: number) => d.seats[i]!;
  switch (e.type) {
    case 'hand-start':
      d.handNumber = e.handNumber;
      d.phase = 'preflop';
      d.button = e.button;
      d.smallBlindSeat = e.smallBlindSeat;
      d.bigBlindSeat = e.bigBlindSeat;
      d.blinds = { ...e.blinds };
      d.board = [];
      d.pot = 0;
      d.toAct = null;
      d.seats.forEach((s, i) => {
        s.inHand = e.inHand[i]!;
        s.stack = e.stacks[i]!;
        Object.assign(s, { bet: 0, folded: false, allIn: false, cards: [], mucked: false, badge: null, handLabel: null, winner: false });
      });
      break;
    case 'post': {
      const s = seat(e.seat);
      s.stack -= e.amount;
      if (e.kind === 'ante') d.pot += e.amount;
      else s.bet += e.amount;
      s.allIn = e.allIn;
      s.badge = e.kind === 'ante' ? null : { label: `${e.kind === 'small-blind' ? 'SB' : 'BB'} ${chips(e.amount)}`, tone: 'post' };
      break;
    }
    case 'deal-hole':
      for (const i of e.order) seat(i).cards = [null, null];
      break;
    case 'hole-cards':
      seat(e.seat).cards = [...e.cards];
      break;
    case 'action': {
      const s = seat(e.seat);
      s.stack -= e.amount;
      s.bet = e.to;
      s.allIn = e.allIn;
      s.badge = actionBadge(e);
      if (e.kind === 'fold') {
        s.folded = true;
        s.cards = [];
      }
      break;
    }
    case 'uncalled': {
      const s = seat(e.seat);
      s.stack += e.amount;
      s.bet -= e.amount;
      if (s.stack > 0) s.allIn = false;
      if (s.badge?.tone === 'allin') s.badge = null;
      break;
    }
    case 'collect':
      d.pot = e.pot;
      for (const s of d.seats) s.bet = 0;
      break;
    case 'board':
      d.board = [...e.board];
      d.phase = e.street;
      for (const s of d.seats) if (!s.folded && s.badge?.tone !== 'allin') s.badge = null;
      break;
    case 'reveal': {
      const s = seat(e.seat);
      s.cards = [...e.cards];
      s.mucked = false;
      if (d.board.length >= 3 && e.score) s.handLabel = describeHand(e.score);
      break;
    }
    case 'muck': {
      const s = seat(e.seat);
      s.mucked = true;
      s.cards = [];
      s.badge = { label: 'Mucks', tone: 'muck' };
      break;
    }
    case 'award':
      for (const share of e.pot.shares) {
        const s = seat(share.seat);
        s.stack += share.amount;
        s.winner = true;
        d.pot -= share.amount;
      }
      break;
    case 'hand-end':
      d.phase = 'complete';
      d.toAct = null;
      d.pot = 0;
      e.result.finalStacks.forEach((stack, i) => {
        if (seat(i).inHand) seat(i).stack = stack;
      });
      for (const s of d.seats) s.bet = 0;
      break;
  }
  return d;
}

/**
 * Differences between two displays in the fields a player relies on (chips, cards, status).
 * Empty means the animated display and the engine agree.
 */
export function displayMismatches(a: TableDisplay, b: TableDisplay): string[] {
  const out: string[] = [];
  if (a.pot !== b.pot) out.push(`pot ${a.pot} vs ${b.pot}`);
  if (a.board.join() !== b.board.join()) out.push(`board ${a.board.join()} vs ${b.board.join()}`);
  a.seats.forEach((s, i) => {
    const t = b.seats[i]!;
    if (s.stack !== t.stack) out.push(`seat ${i} stack ${s.stack} vs ${t.stack}`);
    if (s.bet !== t.bet) out.push(`seat ${i} bet ${s.bet} vs ${t.bet}`);
    if (s.folded !== t.folded) out.push(`seat ${i} folded ${s.folded} vs ${t.folded}`);
    if (s.allIn !== t.allIn) out.push(`seat ${i} all-in ${s.allIn} vs ${t.allIn}`);
    if (s.cards.map(String).join() !== t.cards.map(String).join()) out.push(`seat ${i} cards ${s.cards.join()} vs ${t.cards.join()}`);
  });
  return out;
}
