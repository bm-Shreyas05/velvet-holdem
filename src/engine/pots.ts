/**
 * Pot construction and distribution.
 *
 * Pots are built purely from each player's total contribution for the hand, so the math is
 * independent of how the betting unfolded. Folded players' chips stay in the pots they reached
 * but folded players are never eligible to win.
 */
export interface Contribution {
  seat: number;
  amount: number;
  folded: boolean;
}

export interface Pot {
  amount: number;
  /** Seats that can win this pot, ascending. */
  eligible: number[];
  /** Chips each seat put into this particular pot (for statistics and history). */
  contributions: Record<number, number>;
}

export interface PotShare {
  seat: number;
  amount: number;
}

export function buildPots(contributions: readonly Contribution[]): Pot[] {
  for (const c of contributions) {
    if (!Number.isInteger(c.amount) || c.amount < 0) throw new Error(`Invalid contribution ${c.amount}`);
  }
  const live = contributions.filter((c) => !c.folded && c.amount > 0);
  const levels = [...new Set(live.map((c) => c.amount))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let previous = 0;
  for (const level of levels) {
    const pot: Pot = { amount: 0, eligible: [], contributions: {} };
    for (const c of contributions) {
      const slice = Math.min(c.amount, level) - Math.min(c.amount, previous);
      if (slice > 0) {
        pot.amount += slice;
        pot.contributions[c.seat] = slice;
      }
    }
    pot.eligible = live
      .filter((c) => c.amount >= level)
      .map((c) => c.seat)
      .sort((a, b) => a - b);
    pots.push(pot);
    previous = level;
  }

  // Chips a folded player put in above the highest live contribution. With correct uncalled-bet
  // handling this cannot happen, but if it ever did the chips must still go somewhere legal.
  const top = levels.length ? levels[levels.length - 1]! : 0;
  const excess = contributions.reduce((sum, c) => sum + Math.max(0, c.amount - top), 0);
  if (excess > 0) {
    if (!pots.length) throw new Error('Chips committed but no live player can win them');
    const last = pots[pots.length - 1]!;
    last.amount += excess;
    for (const c of contributions) {
      const over = c.amount - top;
      if (over > 0) last.contributions[c.seat] = (last.contributions[c.seat] ?? 0) + over;
    }
  }
  return pots;
}

/**
 * Splits one pot between the tied winners. Odd chips go one at a time to the winners closest
 * to the left of the button (the conventional rule), which `seatOrder` encodes.
 */
export function splitPot(amount: number, winners: readonly number[], seatOrder: readonly number[]): PotShare[] {
  if (!winners.length) throw new Error('A pot needs at least one winner');
  const ordered = [...winners].sort((a, b) => seatOrder.indexOf(a) - seatOrder.indexOf(b));
  if (ordered.some((s) => seatOrder.indexOf(s) < 0)) throw new Error('Winner missing from seat order');
  const base = Math.floor(amount / ordered.length);
  let remainder = amount - base * ordered.length;
  return ordered.map((seat) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { seat, amount: base + extra };
  });
}
