import type { Card } from './cards.ts';
import type { ActionLogEntry, BlindConfig, HandResult, HandView, PlayerAction } from './types.ts';

/**
 * Everything any observer at the table saw during a hand: actions, the board, shown hands and
 * the result. This is the only material AI opponents learn from between hands.
 */
export interface PublicHandRecord {
  handNumber: number;
  blinds: BlindConfig;
  button: number;
  smallBlindSeat: number | null;
  bigBlindSeat: number;
  players: { seat: number; id: string; startStack: number; endStack: number }[];
  actions: ActionLogEntry[];
  board: Card[];
  revealed: { seat: number; cards: Card[] }[];
  result: HandResult;
}

export function publicRecordFromView(view: HandView): PublicHandRecord {
  if (view.viewer !== null) throw new Error('A public record must be built from the spectator view');
  if (!view.result) throw new Error('The hand is not finished');
  return {
    handNumber: view.handNumber,
    blinds: { ...view.blinds },
    button: view.button,
    smallBlindSeat: view.smallBlindSeat,
    bigBlindSeat: view.bigBlindSeat,
    players: view.seats
      .filter((s) => s.inHand && s.id !== null)
      .map((s) => ({ seat: s.seat, id: s.id!, startStack: s.startStack, endStack: s.stack })),
    actions: view.actions.map((a) => ({ ...a })),
    board: [...view.board],
    revealed: view.revealed.map((r) => ({ seat: r.seat, cards: [...r.cards] })),
    result: structuredClone(view.result),
  };
}

/** Voluntary decisions only (blinds and antes are posted automatically). */
export function decisionsFromLog(actions: readonly ActionLogEntry[]): { seat: number; action: PlayerAction }[] {
  const out: { seat: number; action: PlayerAction }[] = [];
  for (const a of actions) {
    switch (a.kind) {
      case 'fold':
      case 'check':
      case 'call':
        out.push({ seat: a.seat, action: { kind: a.kind } });
        break;
      case 'bet':
      case 'raise':
        out.push({ seat: a.seat, action: { kind: a.kind, to: a.to } });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Name of a seat's position for display ("BTN", "SB", "BB", "UTG", "HJ", "CO"…). */
export function positionLabel(
  seat: number,
  button: number,
  smallBlindSeat: number | null,
  bigBlindSeat: number,
  dealtIn: readonly number[],
): string {
  const n = dealtIn.length;
  if (n === 2) return seat === button ? 'BTN/SB' : 'BB';
  if (seat === button) return 'BTN';
  if (seat === smallBlindSeat) return 'SB';
  if (seat === bigBlindSeat) return 'BB';
  // Seats after the big blind, clockwise: UTG, UTG+1, … then HJ, CO right before the button.
  const order = [...dealtIn].sort((a, b) => a - b);
  const bbIdx = order.indexOf(bigBlindSeat);
  const rotated = [...order.slice(bbIdx + 1), ...order.slice(0, bbIdx + 1)];
  const middle = rotated.slice(0, rotated.indexOf(button));
  const idx = middle.indexOf(seat);
  const fromEnd = middle.length - 1 - idx;
  if (fromEnd === 0 && middle.length >= 2) return 'CO';
  if (fromEnd === 1 && middle.length >= 3) return 'HJ';
  return idx === 0 ? 'UTG' : `UTG+${idx}`;
}
