import { positionLabel, type PublicHandRecord } from '../engine/records.ts';
import type { Street } from '../engine/types.ts';
import { comboIndex } from './combos.ts';
import { madeHandPercentile } from './strength.ts';

/**
 * Opponent modelling from public information only.
 *
 * Every tendency is a count of opportunities (n) and occurrences (k), kept twice: a lifetime
 * count and an exponentially decayed "recent" count. Estimates are Beta-binomial posteriors that
 * start at a population prior, so a handful of hands barely moves them (no instant reads), and a
 * sustained change in style shows up first in the recent counts.
 */
export interface Counter {
  n: number;
  k: number;
  rn: number;
  rk: number;
}

export const STAT_KEYS = [
  'vpip',
  'pfr',
  'vpipLate',
  'vpipEarly',
  'threeBet',
  'foldToRaise',
  'foldTo3Bet',
  'betFreq',
  'foldToBet',
  'foldToBigBet',
  'raiseVsBet',
  'cbet',
  'foldToCbet',
  'wtsd',
  'wsd',
  'bluff',
] as const;
export type StatKey = (typeof STAT_KEYS)[number];

export interface PlayerStats {
  hands: number;
  counters: Record<StatKey, Counter>;
  /** Postflop bets+raises and calls, for the aggression factor. */
  aggressive: number;
  passive: number;
}

export type StatsBook = Record<string, PlayerStats>;

/** Population priors: what an unknown player is assumed to do. */
export function populationPrior(key: StatKey, tableSize: number): number {
  const vpip = Math.min(0.62, Math.max(0.22, 0.18 + 0.55 / Math.max(2, tableSize)));
  switch (key) {
    case 'vpip':
      return vpip;
    case 'vpipLate':
      return Math.min(0.75, vpip * 1.3);
    case 'vpipEarly':
      return vpip * 0.8;
    case 'pfr':
      return vpip * 0.62;
    case 'threeBet':
      return 0.08;
    case 'foldToRaise':
      return 0.62;
    case 'foldTo3Bet':
      return 0.5;
    case 'betFreq':
      return 0.42;
    case 'foldToBet':
      return 0.45;
    case 'foldToBigBet':
      return 0.55;
    case 'raiseVsBet':
      return 0.09;
    case 'cbet':
      return 0.62;
    case 'foldToCbet':
      return 0.45;
    case 'wtsd':
      return 0.3;
    case 'wsd':
      return 0.5;
    case 'bluff':
      return 0.25;
  }
}

const PRIOR_STRENGTH: Record<StatKey, number> = {
  vpip: 10,
  pfr: 10,
  vpipLate: 8,
  vpipEarly: 8,
  threeBet: 8,
  foldToRaise: 8,
  foldTo3Bet: 6,
  betFreq: 8,
  foldToBet: 8,
  foldToBigBet: 6,
  raiseVsBet: 8,
  cbet: 6,
  foldToCbet: 6,
  wtsd: 8,
  wsd: 8,
  bluff: 5,
};

export const RECENT_DECAY = 0.94;

export function emptyStats(): PlayerStats {
  const counters = {} as Record<StatKey, Counter>;
  for (const key of STAT_KEYS) counters[key] = { n: 0, k: 0, rn: 0, rk: 0 };
  return { hands: 0, counters, aggressive: 0, passive: 0 };
}

function bump(stats: PlayerStats, key: StatKey, hit: boolean): void {
  const c = stats.counters[key];
  c.n++;
  c.rn++;
  if (hit) {
    c.k++;
    c.rk++;
  }
}

export interface EstimateOptions {
  tableSize: number;
  /** 0 = rely on the recent window not at all, 1 = fully. */
  recencyWeight: number;
}

/** Posterior estimate of one tendency, blending lifetime and recent evidence. */
export function estimate(stats: PlayerStats | undefined, key: StatKey, opts: EstimateOptions): number {
  const prior = populationPrior(key, opts.tableSize);
  if (!stats) return prior;
  const c = stats.counters[key];
  const m = PRIOR_STRENGTH[key];
  const lifetime = (c.k + prior * m) / (c.n + m);
  const recent = (c.rk + lifetime * 4) / (c.rn + 4);
  const w = opts.recencyWeight * (c.rn / (c.rn + 6));
  return (1 - w) * lifetime + w * recent;
}

/** 0..1: how much evidence stands behind a tendency. */
export function confidence(stats: PlayerStats | undefined, key: StatKey): number {
  if (!stats) return 0;
  const n = stats.counters[key].n;
  return n / (n + PRIOR_STRENGTH[key]);
}

export interface Tendencies {
  vpip: number;
  pfr: number;
  vpipLate: number;
  vpipEarly: number;
  threeBet: number;
  foldToRaise: number;
  foldTo3Bet: number;
  betFreq: number;
  foldToBet: number;
  foldToBigBet: number;
  raiseVsBet: number;
  cbet: number;
  foldToCbet: number;
  bluff: number;
  /** Hands observed. */
  sample: number;
}

/**
 * The tendencies an AI will actually use: posterior estimates pulled back toward the population
 * prior by `modelWeight` (lower difficulties and less observant personalities use less of what
 * they have seen).
 */
export function tendencies(stats: PlayerStats | undefined, tableSize: number, modelWeight: number, recencyWeight: number): Tendencies {
  const opts = { tableSize, recencyWeight };
  const get = (key: StatKey) => {
    const prior = populationPrior(key, tableSize);
    return prior + (estimate(stats, key, opts) - prior) * modelWeight;
  };
  return {
    vpip: get('vpip'),
    pfr: get('pfr'),
    vpipLate: get('vpipLate'),
    vpipEarly: get('vpipEarly'),
    threeBet: get('threeBet'),
    foldToRaise: get('foldToRaise'),
    foldTo3Bet: get('foldTo3Bet'),
    betFreq: get('betFreq'),
    foldToBet: get('foldToBet'),
    foldToBigBet: get('foldToBigBet'),
    raiseVsBet: get('raiseVsBet'),
    cbet: get('cbet'),
    foldToCbet: get('foldToCbet'),
    bluff: get('bluff'),
    sample: stats?.hands ?? 0,
  };
}

const VOLUNTARY = new Set(['fold', 'check', 'call', 'bet', 'raise']);

function isLatePosition(label: string): boolean {
  return label === 'BTN' || label === 'CO' || label === 'BTN/SB';
}

/**
 * Updates the book with one finished hand. Only public information is read: the action log,
 * the board, and hands that were actually shown.
 */
export function observeHand(book: StatsBook, record: PublicHandRecord, decay = RECENT_DECAY): void {
  const seatsIn = record.players.map((p) => p.seat);
  const idOf = new Map(record.players.map((p) => [p.seat, p.id]));
  const statsOf = (seat: number): PlayerStats => {
    const id = idOf.get(seat)!;
    return (book[id] ??= emptyStats());
  };

  for (const p of record.players) {
    const s = statsOf(p.seat);
    s.hands++;
    for (const key of STAT_KEYS) {
      s.counters[key].rn *= decay;
      s.counters[key].rk *= decay;
    }
  }

  const voluntary = record.actions.filter((a) => VOLUNTARY.has(a.kind));
  const folded = new Set(voluntary.filter((a) => a.kind === 'fold').map((a) => a.seat));
  const foldedPreflop = new Set(voluntary.filter((a) => a.kind === 'fold' && a.street === 'preflop').map((a) => a.seat));

  // ---- Preflop -------------------------------------------------------------------------------
  const vpip = new Set<number>();
  const pfr = new Set<number>();
  const decided = new Set<number>();
  const facedRaise = new Set<number>();
  const faced3Bet = new Set<number>();
  const raisers = new Set<number>();
  let preflopAggressor: number | null = null;
  for (const a of voluntary.filter((x) => x.street === 'preflop')) {
    decided.add(a.seat);
    const s = statsOf(a.seat);
    if (a.kind === 'call' || a.kind === 'raise') vpip.add(a.seat);
    if (a.kind === 'raise') pfr.add(a.seat);
    if (a.raiseCountBefore === 1 && !facedRaise.has(a.seat) && !raisers.has(a.seat)) {
      facedRaise.add(a.seat);
      bump(s, 'foldToRaise', a.kind === 'fold');
      bump(s, 'threeBet', a.kind === 'raise');
    } else if (a.raiseCountBefore >= 2 && raisers.has(a.seat) && !faced3Bet.has(a.seat)) {
      faced3Bet.add(a.seat);
      bump(s, 'foldTo3Bet', a.kind === 'fold');
    }
    if (a.kind === 'raise') {
      raisers.add(a.seat);
      preflopAggressor = a.seat;
    }
  }
  for (const seat of decided) {
    const s = statsOf(seat);
    bump(s, 'vpip', vpip.has(seat));
    bump(s, 'pfr', pfr.has(seat));
    const label = positionLabel(seat, record.button, record.smallBlindSeat, record.bigBlindSeat, seatsIn);
    if (label !== 'SB' && label !== 'BB') bump(s, isLatePosition(label) ? 'vpipLate' : 'vpipEarly', vpip.has(seat));
  }

  // ---- Postflop ------------------------------------------------------------------------------
  const streets: Street[] = ['flop', 'turn', 'river'];
  for (const street of streets) {
    const acts = voluntary.filter((a) => a.street === street);
    const firstDecision = new Set<number>();
    const facedBet = new Set<number>();
    let firstBettor: number | null = null;
    for (const a of acts) {
      const s = statsOf(a.seat);
      if (a.facing === 0 && !firstDecision.has(a.seat)) {
        bump(s, 'betFreq', a.kind === 'bet');
        if (street === 'flop' && a.seat === preflopAggressor) bump(s, 'cbet', a.kind === 'bet');
      }
      if (a.facing > 0 && !facedBet.has(a.seat)) {
        facedBet.add(a.seat);
        bump(s, 'foldToBet', a.kind === 'fold');
        bump(s, 'raiseVsBet', a.kind === 'raise');
        const ratio = a.facing / Math.max(1, a.potBefore - a.facing);
        if (ratio >= 0.66) bump(s, 'foldToBigBet', a.kind === 'fold');
        if (street === 'flop' && firstBettor !== null && firstBettor === preflopAggressor && a.raiseCountBefore === 1) {
          bump(s, 'foldToCbet', a.kind === 'fold');
        }
      }
      firstDecision.add(a.seat);
      if (a.kind === 'bet' && firstBettor === null) firstBettor = a.seat;
      if (a.kind === 'bet' || a.kind === 'raise') s.aggressive++;
      if (a.kind === 'call') s.passive++;
    }
  }

  // ---- Showdown ------------------------------------------------------------------------------
  const sawFlop = record.board.length >= 3;
  const wentToShowdown = record.result.showdown;
  for (const p of record.players) {
    if (!sawFlop || foldedPreflop.has(p.seat)) continue;
    const s = statsOf(p.seat);
    const atShowdown = wentToShowdown && !folded.has(p.seat);
    bump(s, 'wtsd', atShowdown);
    if (atShowdown) {
      const won = record.result.pots.some((pot) => pot.winners.includes(p.seat));
      bump(s, 'wsd', won);
    }
  }

  // Bluff evidence: aggressive turn/river actions by players whose cards were shown.
  for (const shown of record.revealed) {
    const s = statsOf(shown.seat);
    const combo = comboIndex(shown.cards[0]!, shown.cards[1]!);
    for (const a of voluntary) {
      if (a.seat !== shown.seat || (a.kind !== 'bet' && a.kind !== 'raise')) continue;
      if (a.street !== 'turn' && a.street !== 'river') continue;
      const boardAt = record.board.slice(0, a.street === 'turn' ? 4 : 5);
      const pct = madeHandPercentile(boardAt, combo);
      bump(s, 'bluff', pct >= 0 && pct < 0.4);
    }
  }
}

/** Aggression factor (postflop bets+raises per call), or null with too little data. */
export function aggressionFactor(stats: PlayerStats | undefined): number | null {
  if (!stats || stats.aggressive + stats.passive < 5) return null;
  return stats.aggressive / Math.max(1, stats.passive);
}

export function isStatsBook(value: unknown): value is StatsBook {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every((s) => {
    const st = s as PlayerStats;
    return (
      st &&
      typeof st.hands === 'number' &&
      st.counters &&
      STAT_KEYS.every((k) => {
        const c = st.counters[k];
        return c && [c.n, c.k, c.rn, c.rk].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
      })
    );
  });
}
