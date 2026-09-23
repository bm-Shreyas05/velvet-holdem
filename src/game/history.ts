import { type Card, cardsToString } from '../engine/cards.ts';
import { describeHand, evaluate } from '../engine/evaluator.ts';
import type { HoldemHand, HandSetup } from '../engine/hand.ts';
import { decisionsFromLog, positionLabel } from '../engine/records.ts';
import type { HandReplayData } from '../engine/replay.ts';
import type { ActionLogEntry, BlindConfig, PotResult, Street } from '../engine/types.ts';

/** One completed hand, as the player may review it. */
export interface HandHistoryRecord {
  handNumber: number;
  finishedAt: string;
  blinds: BlindConfig;
  button: number;
  humanSeat: number;
  players: {
    seat: number;
    name: string;
    position: string;
    startStack: number;
    endStack: number;
    net: number;
    /** Own cards, or cards shown at showdown. Null when never seen. */
    cards: Card[] | null;
    handDescription: string | null;
    folded: boolean;
    folds: Street | null;
  }[];
  actions: ActionLogEntry[];
  board: Card[];
  pots: PotResult[];
  showdown: boolean;
  /**
   * Debug/replay data (full deck order and every decision). Kept out of the history screen; it
   * lets any reported hand be reproduced exactly with engine/replay.ts.
   */
  replay: HandReplayData;
}

export function buildHistoryRecord(
  hand: HoldemHand,
  setup: HandSetup,
  names: Record<number, string>,
  humanSeat: number,
): HandHistoryRecord {
  const view = hand.viewFor(humanSeat);
  const result = view.result;
  if (!result) throw new Error('Cannot record an unfinished hand');
  const dealtIn = view.seats.filter((s) => s.inHand).map((s) => s.seat);
  const foldStreet = new Map<number, Street>();
  for (const a of view.actions) if (a.kind === 'fold') foldStreet.set(a.seat, a.street);
  return {
    handNumber: view.handNumber,
    finishedAt: new Date().toISOString(),
    blinds: { ...view.blinds },
    button: view.button,
    humanSeat,
    players: view.seats
      .filter((s) => s.inHand)
      .map((s) => {
        const cards = s.holeCards ? [...s.holeCards] : null;
        const showdownHand = cards && view.board.length >= 3 && !s.folded ? describeHand(evaluate([...cards, ...view.board])) : null;
        return {
          seat: s.seat,
          name: names[s.seat] ?? `Seat ${s.seat + 1}`,
          position: positionLabel(s.seat, view.button, view.smallBlindSeat, view.bigBlindSeat, dealtIn),
          startStack: s.startStack,
          endStack: s.stack,
          net: s.stack - s.startStack,
          cards,
          handDescription: showdownHand,
          folded: s.folded,
          folds: foldStreet.get(s.seat) ?? null,
        };
      }),
    actions: view.actions.map((a) => ({ ...a })),
    board: [...view.board],
    pots: structuredClone(result.pots),
    showdown: result.showdown,
    replay: {
      setup: structuredClone(setup),
      deckOrder: hand.deckOrder(),
      decisions: decisionsFromLog(view.actions),
    },
  };
}

const STREET_TITLES: Record<Street, string> = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };

/** Verb phrase for an action; `secondPerson` for the player's own lines ("call 50" vs "calls 50"). */
export function actionText(a: ActionLogEntry, secondPerson = false): string {
  const v = (third: string, second: string) => (secondPerson ? second : third);
  const allIn = ` and ${v('is', 'are')} all-in`;
  switch (a.kind) {
    case 'ante':
      return `${v('posts', 'post')} ante ${a.amount}`;
    case 'small-blind':
      return `${v('posts', 'post')} small blind ${a.amount}`;
    case 'big-blind':
      return `${v('posts', 'post')} big blind ${a.amount}`;
    case 'fold':
      return v('folds', 'fold');
    case 'check':
      return v('checks', 'check');
    case 'call':
      return `${v('calls', 'call')} ${a.amount}${a.allIn ? allIn : ''}`;
    case 'bet':
      return `${v('bets', 'bet')} ${a.amount}${a.allIn ? allIn : ''}`;
    case 'raise':
      return `${v('raises', 'raise')} to ${a.to}${a.allIn ? allIn : ''}`;
  }
}

/** Plain-text export in the familiar hand-history style. */
export function historyToText(r: HandHistoryRecord): string {
  const name = (seat: number) => r.players.find((p) => p.seat === seat)?.name ?? `Seat ${seat + 1}`;
  const lines: string[] = [];
  lines.push(`Hand #${r.handNumber} — No-Limit Hold'em ${r.blinds.smallBlind}/${r.blinds.bigBlind}${r.blinds.ante ? ` ante ${r.blinds.ante}` : ''}`);
  lines.push(new Date(r.finishedAt).toLocaleString());
  for (const p of r.players) {
    lines.push(`Seat ${p.seat + 1}: ${p.name} (${p.startStack}) [${p.position}]${p.cards ? ` ${cardsToString(p.cards)}` : ''}`);
  }
  let street: Street | null = null;
  for (const a of r.actions) {
    if (a.street !== street) {
      street = a.street;
      const shown = street === 'flop' ? r.board.slice(0, 3) : street === 'turn' ? r.board.slice(0, 4) : street === 'river' ? r.board : [];
      lines.push(`*** ${STREET_TITLES[street].toUpperCase()} ***${shown.length ? ` [${cardsToString(shown)}]` : ''}`);
    }
    lines.push(`${name(a.seat)} ${actionText(a)}`);
  }
  if (r.board.length && street !== 'river') lines.push(`Board: [${cardsToString(r.board)}]`);
  lines.push('*** RESULT ***');
  r.pots.forEach((pot, i) => {
    const label = r.pots.length === 1 ? 'Pot' : i === 0 ? 'Main pot' : `Side pot ${i}`;
    const winners = pot.shares.map((s) => `${name(s.seat)} wins ${s.amount}`).join(', ');
    const hand = pot.winningScore !== null ? ` with ${describeHand(pot.winningScore)}` : '';
    lines.push(`${label} ${pot.amount}: ${winners}${hand}`);
  });
  for (const p of r.players) lines.push(`${p.name}: ${p.net >= 0 ? '+' : ''}${p.net}`);
  return lines.join('\n');
}

export function isHistoryRecord(value: unknown): value is HandHistoryRecord {
  const r = value as HandHistoryRecord;
  return (
    !!r &&
    Number.isInteger(r.handNumber) &&
    Array.isArray(r.players) &&
    Array.isArray(r.actions) &&
    Array.isArray(r.board) &&
    Array.isArray(r.pots) &&
    !!r.replay &&
    Array.isArray(r.replay.deckOrder)
  );
}
