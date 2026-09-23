import type { Card } from '../engine/cards.ts';
import { positionLabel } from '../engine/records.ts';
import type { ActionLogEntry, HandView } from '../engine/types.ts';
import { COMBO_COUNT, cardMask, comboConflicts } from './combos.ts';
import type { Tendencies } from './model.ts';
import { boardStrength } from './strength.ts';

/**
 * Bayesian range reading. An opponent starts with every combo that does not conflict with cards
 * the observer can see. Each of their actions this hand multiplies every combo's weight by the
 * likelihood that a player with their tendencies would have taken that action with that holding.
 *
 * Likelihoods are smooth functions of the combo's strength on that street, calibrated so that
 * across the current range they reproduce the player's observed frequencies — a player who bets
 * 70% of the time is not assumed to hold a monster whenever they bet, and a player whose shown
 * bets were often bluffs keeps weak hands in their betting range.
 */

const SOFTNESS = 0.08;
const FLOOR = 0.001;
/**
 * Highest probability that even the strongest holding takes the aggressive option. Strong hands
 * are often slow-played or just called, so passive lines never rule them out.
 */
function maxAggressFor(entry: ActionLogEntry): number {
  if (entry.street === 'preflop') return entry.raiseCountBefore === 0 ? 0.95 : 0.8;
  return entry.facing > 0 ? 0.55 : 0.72;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Bluff likelihood shape: highest for the weakest holdings, zero above ~45th percentile. */
function bluffShape(s: number): number {
  return s < 0.45 ? (0.45 - s) / 0.45 : 0;
}

function weightedMean(weights: Float64Array, strength: Float32Array, f: (s: number) => number): number {
  let num = 0;
  let den = 0;
  for (let k = 0; k < COMBO_COUNT; k++) {
    const w = weights[k]!;
    if (w <= 0) continue;
    num += w * f(strength[k]!);
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/** Near the top of the range strengths are compressed, so value thresholds there are sharper. */
function softnessAt(theta: number): number {
  return Math.min(SOFTNESS, Math.max(0.015, 0.3 * (1 - theta)));
}

/** Finds θ so the range-weighted mean of σ(dir·(s−θ)/τ) equals target. */
function solveThreshold(weights: Float64Array, strength: Float32Array, target: number, dir: 1 | -1, adaptive = false): number {
  const t = Math.min(0.98, Math.max(0.005, target));
  let lo = -1.5;
  let hi = 2.5;
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) / 2;
    const tau = adaptive ? softnessAt(mid) : SOFTNESS;
    const mean = weightedMean(weights, strength, (s) => sigmoid((dir * (s - mid)) / tau));
    // For dir=+1 the mean falls as θ rises; for dir=−1 it rises.
    if ((dir === 1 && mean > t) || (dir === -1 && mean < t)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface ActionModel {
  /** Probability of betting/raising given strength. */
  aggress: (s: number) => number;
  /** Probability of folding given strength (0 when not facing a bet). */
  fold: (s: number) => number;
}

/**
 * Builds the action model for one decision point from target frequencies.
 * `aggressFreq` = how often this player bets/raises here, `foldFreq` = how often they fold,
 * `bluffShare` = what fraction of their aggressive actions are bluffs.
 */
export function actionModel(
  reference: Float64Array,
  current: Float64Array,
  strength: Float32Array,
  aggressFreq: number,
  foldFreq: number,
  bluffShare: number,
  maxAggress = 0.72,
  sizeFactor = 1,
): ActionModel {
  const share = Math.min(0.45, Math.max(0, bluffShare));
  // The player's usual frequency, scaled for the size actually chosen: big bets are made with a
  // smaller, stronger set of value hands...
  const valueTarget = Math.min(0.97, Math.max(0.005, (aggressFreq * (1 - share) * sizeFactor) / maxAggress));
  const thetaA = solveThreshold(reference, strength, valueTarget, 1, true);
  const tauA = softnessAt(thetaA);
  const value = (s: number) => maxAggress * sigmoid((s - thetaA) / tauA);
  // ...and bluffs make up the player's usual share of what they bet with THIS range: someone
  // holding mostly air does not bluff proportionally more often, they just have fewer value bets.
  const valueMass = weightedMean(current, strength, value);
  const shapeMean = weightedMean(current, strength, bluffShape) || 1e-6;
  const beta = Math.min(0.9, ((share / (1 - share)) * valueMass) / shapeMean);
  const thetaF = foldFreq > 0 ? solveThreshold(reference, strength, foldFreq, -1) : -10;
  const aggress = (s: number) => Math.min(0.98, value(s) + beta * bluffShape(s));
  const rawFold = (s: number) => (foldFreq > 0 ? sigmoid((thetaF - s) / SOFTNESS) : 0);
  return {
    aggress: (s) => {
      const a = aggress(s);
      const f = rawFold(s);
      return a + f > 1 ? a / (a + f) : a;
    },
    fold: (s) => {
      const a = aggress(s);
      const f = rawFold(s);
      return a + f > 1 ? f / (a + f) : f;
    },
  };
}

export interface RangeContext {
  view: HandView;
  /** Cards the observer knows (own hole cards + board). */
  dead: readonly Card[];
  depth: number;
  tendenciesOf: (seat: number) => Tendencies;
}

/** Target frequencies (aggress, fold, bluff share) for an action entry. */
export function targetsFor(entry: ActionLogEntry, t: Tendencies, view: HandView): [number, number, number] {
  if (entry.street === 'preflop') {
    if (entry.raiseCountBefore === 0) {
      if (entry.facing === 0) return [Math.min(0.45, t.pfr * 0.8), 0, 0.3]; // big blind option
      const dealtIn = view.seats.filter((s) => s.inHand).map((s) => s.seat);
      const label = positionLabel(entry.seat, view.button, view.smallBlindSeat, view.bigBlindSeat, dealtIn);
      const late = label === 'BTN' || label === 'CO' || label === 'BTN/SB';
      const early = label.startsWith('UTG') || label === 'HJ';
      const vpip = late ? t.vpipLate : early ? t.vpipEarly : t.vpip;
      const pfr = Math.min(vpip * 0.95, t.pfr * (vpip / Math.max(0.05, t.vpip)));
      return [pfr, Math.max(0.02, 1 - vpip), 0.06];
    }
    if (entry.raiseCountBefore === 1) return [t.threeBet, t.foldToRaise, 0.18];
    return [t.threeBet * 0.45, t.foldTo3Bet, 0.1];
  }
  // Bluffing into several opponents is rarer than heads-up.
  const idx = view.actions.indexOf(entry);
  const foldedBefore = new Set(view.actions.slice(0, Math.max(0, idx)).filter((a) => a.kind === 'fold').map((a) => a.seat));
  const opponentsLeft = view.seats.filter((s) => s.inHand && s.seat !== entry.seat && !foldedBefore.has(s.seat)).length;
  const multiway = 1 / (1 + 0.5 * Math.max(0, opponentsLeft - 1));
  if (entry.facing === 0) return [t.betFreq, 0, t.bluff * multiway];
  const ratio = entry.facing / Math.max(1, entry.potBefore - entry.facing);
  const fold = ratio >= 0.66 ? t.foldToBigBet : t.foldToBet + (ratio - 0.5) * 0.15;
  return [t.raiseVsBet, Math.min(0.9, Math.max(0.05, fold)), t.bluff * 0.7 * multiway];
}

export interface OpponentRange {
  /** Posterior over combos given everything this player did this hand (sums to 1). */
  current: Float64Array;
  /**
   * The population this player's frequencies refer to: every hand preflop, the kind of range
   * they usually see a flop with afterwards. Thresholds are measured against it, so they are
   * absolute: a player who checked twice and now bets big is betting a strong hand or a bluff —
   * not "the best of a weak range".
   */
  reference: Float64Array;
}

function normalise(w: Float64Array): Float64Array {
  let total = 0;
  for (let k = 0; k < COMBO_COUNT; k++) total += w[k]!;
  if (total > 0) for (let k = 0; k < COMBO_COUNT; k++) w[k]! /= total;
  return w;
}

/** Range of the live opponent in `seat`, read from their actions this hand. */
export function buildRange(seat: number, ctx: RangeContext): OpponentRange {
  const w = new Float64Array(COMBO_COUNT);
  const [lo, hi] = cardMask(ctx.dead);
  for (let k = 0; k < COMBO_COUNT; k++) w[k] = comboConflicts(k, lo, hi) ? 0 : 1;
  const everyHand = Float64Array.from(w);
  const t = ctx.tendenciesOf(seat);
  // Postflop frequencies are calibrated against the kind of range this player usually takes to
  // a flop (from their observed VPIP), not against this hand's narrowed range — so a range that
  // missed the board is read as weak, and a raise from it as strength.
  const preflop = boardStrength([]);
  const cut = 1 - Math.min(0.9, Math.max(0.1, t.vpip));
  const typicalFlopRange = new Float64Array(COMBO_COUNT);
  for (let k = 0; k < COMBO_COUNT; k++) typicalFlopRange[k] = everyHand[k]! > 0 ? sigmoid((preflop[k]! - cut) / 0.06) : 0;

  const board = ctx.view.board;
  for (const entry of ctx.view.actions) {
    if (entry.seat !== seat) continue;
    if (entry.kind !== 'check' && entry.kind !== 'call' && entry.kind !== 'bet' && entry.kind !== 'raise') continue;
    const boardAt = entry.street === 'preflop' ? [] : board.slice(0, entry.street === 'flop' ? 3 : entry.street === 'turn' ? 4 : 5);
    const strength = boardStrength(boardAt);
    const [aggFreq, foldFreq, bluff] = targetsFor(entry, t, ctx.view);
    const preflop = entry.street === 'preflop';
    // Bigger bets are made with stronger value hands (bluff frequency stays the player's own).
    const sizeRatio = entry.amount / Math.max(1, entry.potBefore);
    const aggressive = entry.kind === 'bet' || entry.kind === 'raise';
    const model = actionModel(
      preflop ? everyHand : typicalFlopRange,
      w,
      strength,
      aggFreq,
      entry.facing > 0 ? foldFreq : 0,
      Math.min(0.4, bluff),
      maxAggressFor(entry),
      aggressive && !preflop ? Math.min(1.6, Math.max(0.12, Math.pow(0.66 / Math.max(0.05, sizeRatio), 0.6))) : 1,
    );
    // An all-in "call" or a raise by a very short stack carries less information.
    const depth = ctx.depth * (entry.allIn && !aggressive ? 0.6 : 1);
    for (let k = 0; k < COMBO_COUNT; k++) {
      if (w[k] === 0) continue;
      const s = strength[k]!;
      if (s < 0) {
        w[k] = 0;
        continue;
      }
      const a = model.aggress(s);
      const likelihood = aggressive ? a : Math.max(0, 1 - a - model.fold(s));
      w[k]! *= FLOOR + (1 - FLOOR) * Math.pow(likelihood, depth);
    }
  }

  if (!w.some((x) => x > 0)) w.set(everyHand);
  const current = normalise(w);
  const reference = ctx.view.street === 'preflop' ? Float64Array.from(current) : normalise(typicalFlopRange);
  return { current, reference };
}

/** Share of the range's weight whose strength is below `threshold`. */
export function massBelow(weights: Float64Array, strength: Float32Array, threshold: number): number {
  let below = 0;
  let total = 0;
  for (let k = 0; k < COMBO_COUNT; k++) {
    const w = weights[k]!;
    if (w <= 0 || strength[k]! < 0) continue;
    total += w;
    if (strength[k]! < threshold) below += w;
  }
  return total > 0 ? below / total : 0;
}

/** Strength value below which a fraction `q` of the range's weight lies. */
export function weightedQuantile(weights: Float64Array, strength: Float32Array, q: number): number {
  const items: [number, number][] = [];
  for (let k = 0; k < COMBO_COUNT; k++) if (weights[k]! > 0 && strength[k]! >= 0) items.push([strength[k]!, weights[k]!]);
  if (!items.length) return 0.5;
  items.sort((a, b) => a[0] - b[0]);
  const total = items.reduce((s, x) => s + x[1], 0);
  let acc = 0;
  for (const [s, w] of items) {
    acc += w;
    if (acc >= q * total) return s;
  }
  return items[items.length - 1]![0];
}
