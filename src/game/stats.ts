import type { Card } from '../engine/cards.ts';
import { evaluate } from '../engine/evaluator.ts';
import type { HandHistoryRecord } from './history.ts';

/**
 * The human player's statistics, computed only from completed hands. Everything shown in the
 * statistics screen comes from these counters, so every figure is traceable to real hands.
 */
export interface OpponentRecord {
  hands: number;
  /** Chips won from (positive) or lost to (negative) this opponent, by pot share. */
  net: number;
  showdownsWon: number;
  showdownsLost: number;
}

export interface PlayerStats {
  handsPlayed: number;
  handsWon: number;
  vpipHands: number;
  pfrHands: number;
  sawFlop: number;
  showdowns: number;
  showdownsWon: number;
  folds: number;
  checks: number;
  calls: number;
  bets: number;
  raises: number;
  allIns: number;
  netChips: number;
  largestPotWon: number;
  biggestWin: number;
  biggestLoss: number;
  bestHand: { score: number; cards: Card[]; handNumber: number } | null;
  opponents: Record<string, OpponentRecord>;
}

export interface CareerStats extends PlayerStats {
  gamesPlayed: number;
  gamesWon: number;
  /** Count of finishes by place, e.g. {"1": 3, "2": 5}. */
  finishes: Record<string, number>;
  bestFinishOf: Record<string, number>;
}

export function emptyStats(): PlayerStats {
  return {
    handsPlayed: 0,
    handsWon: 0,
    vpipHands: 0,
    pfrHands: 0,
    sawFlop: 0,
    showdowns: 0,
    showdownsWon: 0,
    folds: 0,
    checks: 0,
    calls: 0,
    bets: 0,
    raises: 0,
    allIns: 0,
    netChips: 0,
    largestPotWon: 0,
    biggestWin: 0,
    biggestLoss: 0,
    bestHand: null,
    opponents: {},
  };
}

export function emptyCareer(): CareerStats {
  return { ...emptyStats(), gamesPlayed: 0, gamesWon: 0, finishes: {}, bestFinishOf: {} };
}

/** Adds one hand to the stats of the player in `record.humanSeat`. */
export function recordHand(stats: PlayerStats, record: HandHistoryRecord): void {
  const seat = record.humanSeat;
  const me = record.players.find((p) => p.seat === seat);
  if (!me) return; // not dealt in (e.g. already eliminated, watching)
  stats.handsPlayed++;

  const mine = record.actions.filter((a) => a.seat === seat);
  const preflop = mine.filter((a) => a.street === 'preflop');
  if (preflop.some((a) => a.kind === 'call' || a.kind === 'raise')) stats.vpipHands++;
  if (preflop.some((a) => a.kind === 'raise')) stats.pfrHands++;
  for (const a of mine) {
    if (a.kind === 'fold') stats.folds++;
    else if (a.kind === 'check') stats.checks++;
    else if (a.kind === 'call') stats.calls++;
    else if (a.kind === 'bet') stats.bets++;
    else if (a.kind === 'raise') stats.raises++;
    if (a.allIn && (a.kind === 'call' || a.kind === 'bet' || a.kind === 'raise')) stats.allIns++;
  }
  const foldedPreflop = me.folds === 'preflop';
  if (record.board.length >= 3 && !foldedPreflop) stats.sawFlop++;

  let won = 0;
  for (const pot of record.pots) for (const s of pot.shares) if (s.seat === seat) won += s.amount;
  if (won > 0) {
    stats.handsWon++;
    const potTotal = record.pots.filter((p) => p.shares.some((s) => s.seat === seat)).reduce((sum, p) => sum + p.amount, 0);
    stats.largestPotWon = Math.max(stats.largestPotWon, potTotal);
  }
  stats.netChips += me.net;
  if (me.net > 0) stats.biggestWin = Math.max(stats.biggestWin, me.net);
  if (me.net < 0) stats.biggestLoss = Math.max(stats.biggestLoss, -me.net);

  const atShowdown = record.showdown && !me.folded;
  if (atShowdown) {
    stats.showdowns++;
    if (won > 0) stats.showdownsWon++;
    if (me.cards && record.board.length === 5) {
      const score = evaluate([...me.cards, ...record.board]);
      if (!stats.bestHand || score > stats.bestHand.score) {
        stats.bestHand = { score, cards: [...me.cards, ...record.board], handNumber: record.handNumber };
      }
    }
  }

  // Head-to-head: each contributor's chips in a pot go to its winners in proportion to their
  // shares, so the chips moving between two players in a pot are exact.
  for (const opp of record.players) {
    if (opp.seat === seat) continue;
    const entry = (stats.opponents[opp.name] ??= { hands: 0, net: 0, showdownsWon: 0, showdownsLost: 0 });
    entry.hands++;
    for (const pot of record.pots) {
      if (pot.amount <= 0) continue;
      const mineIn = pot.contributions[seat] ?? 0;
      const theirsIn = pot.contributions[opp.seat] ?? 0;
      const myShare = pot.shares.find((s) => s.seat === seat)?.amount ?? 0;
      const theirShare = pot.shares.find((s) => s.seat === opp.seat)?.amount ?? 0;
      entry.net += (theirsIn * myShare - mineIn * theirShare) / pot.amount;
    }
    if (atShowdown && record.showdown && !opp.folded) {
      const shared = record.pots.filter((p) => p.eligible.includes(seat) && p.eligible.includes(opp.seat) && p.eligible.length > 1);
      if (shared.length) {
        const main = shared[0]!;
        if (main.winners.includes(seat) && !main.winners.includes(opp.seat)) entry.showdownsWon++;
        else if (main.winners.includes(opp.seat) && !main.winners.includes(seat)) entry.showdownsLost++;
      }
    }
  }
}

export function recordFinish(career: CareerStats, place: number, fieldSize: number): void {
  career.gamesPlayed++;
  if (place === 1) career.gamesWon++;
  career.finishes[String(place)] = (career.finishes[String(place)] ?? 0) + 1;
  const key = String(fieldSize);
  const best = career.bestFinishOf[key];
  if (best === undefined || place < best) career.bestFinishOf[key] = place;
}

export function mergeInto(target: PlayerStats, source: PlayerStats): void {
  const numeric: (keyof PlayerStats)[] = [
    'handsPlayed',
    'handsWon',
    'vpipHands',
    'pfrHands',
    'sawFlop',
    'showdowns',
    'showdownsWon',
    'folds',
    'checks',
    'calls',
    'bets',
    'raises',
    'allIns',
    'netChips',
  ];
  for (const k of numeric) (target[k] as number) += source[k] as number;
  target.largestPotWon = Math.max(target.largestPotWon, source.largestPotWon);
  target.biggestWin = Math.max(target.biggestWin, source.biggestWin);
  target.biggestLoss = Math.max(target.biggestLoss, source.biggestLoss);
  if (source.bestHand && (!target.bestHand || source.bestHand.score > target.bestHand.score)) target.bestHand = source.bestHand;
  for (const [name, r] of Object.entries(source.opponents)) {
    const t = (target.opponents[name] ??= { hands: 0, net: 0, showdownsWon: 0, showdownsLost: 0 });
    t.hands += r.hands;
    t.net += r.net;
    t.showdownsWon += r.showdownsWon;
    t.showdownsLost += r.showdownsLost;
  }
}

export interface DerivedStats {
  winRate: number | null;
  vpip: number | null;
  pfr: number | null;
  aggressionFactor: number | null;
  showdownWinRate: number | null;
  foldRate: number | null;
  wentToShowdown: number | null;
}

const ratio = (a: number, b: number, min = 1) => (b >= min ? a / b : null);

export function derive(s: PlayerStats): DerivedStats {
  const decisions = s.folds + s.checks + s.calls + s.bets + s.raises;
  return {
    winRate: ratio(s.handsWon, s.handsPlayed),
    vpip: ratio(s.vpipHands, s.handsPlayed),
    pfr: ratio(s.pfrHands, s.handsPlayed),
    aggressionFactor: s.calls + s.bets + s.raises >= 5 ? (s.bets + s.raises) / Math.max(1, s.calls) : null,
    showdownWinRate: ratio(s.showdownsWon, s.showdowns),
    foldRate: ratio(s.folds, decisions),
    wentToShowdown: ratio(s.showdowns, s.sawFlop),
  };
}

export function isPlayerStats(v: unknown): v is PlayerStats {
  const s = v as PlayerStats;
  return !!s && typeof s.handsPlayed === 'number' && typeof s.netChips === 'number' && !!s.opponents && typeof s.opponents === 'object';
}
