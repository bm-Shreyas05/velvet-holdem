/**
 * Tournament prize equity (the Independent Chip Model, Malmuth–Harville).
 *
 * When a tournament pays more than first place, chips are not worth their face value: doubling a
 * stack does not double its share of the prize pool, while busting loses everything. ICM turns
 * stacks into each player's expected share of the remaining prizes, and the "bubble factor"
 * derived from it says how much more a chip lost hurts than a chip won helps. The AI uses it to
 * tighten up near the money and to pressure players who cannot afford to call.
 */

/**
 * Each player's expected share of `payouts` (fractions of the pool for 1st, 2nd, …) given their
 * chip counts. Players with no chips take the lowest remaining places (sharing them equally).
 */
export function icmEquities(stacks: readonly number[], payouts: readonly number[]): number[] {
  const n = stacks.length;
  const eq = new Array<number>(n).fill(0);
  const alive: number[] = [];
  const busted: number[] = [];
  for (let i = 0; i < n; i++) (stacks[i]! > 0 ? alive : busted).push(i);
  const paid = Math.min(payouts.length, n);

  const recurse = (remaining: number[], place: number, prob: number) => {
    if (place >= paid || remaining.length === 0) return;
    let total = 0;
    for (const i of remaining) total += stacks[i]!;
    for (const i of remaining) {
      const p = stacks[i]! / total;
      if (p === 0) continue;
      eq[i]! += prob * p * payouts[place]!;
      if (place + 1 < paid && remaining.length > 1) {
        recurse(
          remaining.filter((j) => j !== i),
          place + 1,
          prob * p,
        );
      }
    }
  };
  recurse(alive, 0, 1);

  // Busted players finish behind everyone still alive and share those places' prizes.
  if (busted.length) {
    let share = 0;
    for (let place = alive.length; place < alive.length + busted.length; place++) share += payouts[place] ?? 0;
    for (const i of busted) eq[i] = share / busted.length;
  }
  return eq;
}

/**
 * How much more losing `risk` chips to `opponent` hurts than winning them helps, for `player`
 * (1 = chips are worth face value, as in a winner-take-all game). `risk` is capped by both stacks.
 */
export function bubbleFactor(stacks: readonly number[], payouts: readonly number[], player: number, opponent: number, risk: number): number {
  const r = Math.min(risk, stacks[player]!, stacks[opponent]!);
  if (!(r > 0) || player === opponent) return 1;
  const now = icmEquities(stacks, payouts)[player]!;
  const won = [...stacks];
  won[player]! += r;
  won[opponent]! -= r;
  const lost = [...stacks];
  lost[player]! -= r;
  lost[opponent]! += r;
  const gain = icmEquities(won, payouts)[player]! - now;
  const loss = now - icmEquities(lost, payouts)[player]!;
  if (gain <= 1e-12) return loss > 1e-12 ? MAX_BUBBLE_FACTOR : 1;
  return Math.min(MAX_BUBBLE_FACTOR, Math.max(1, loss / gain));
}

/** Bubble factors above this change nothing a player would do; capping keeps EV math stable. */
export const MAX_BUBBLE_FACTOR = 4;

/** True when payouts make chip values non-linear (more than one place paid). */
export function icmMatters(payouts: readonly number[] | undefined): payouts is number[] {
  return !!payouts && payouts.filter((p) => p > 0).length > 1;
}
