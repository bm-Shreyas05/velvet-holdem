import type { Card } from '../engine/cards.ts';
import { evaluate } from '../engine/evaluator.ts';
import { type Rng, SeededRng, type SeedState, randomInt, randomUnit } from '../engine/rng.ts';
import type { HandView, LegalActions, PlayerAction, SeatView } from '../engine/types.ts';
import { COMBO_A, COMBO_B, COMBO_COUNT, cardMask, comboConflicts, hasCard } from './combos.ts';
import { type StatKey, type StatsBook, type Tendencies, confidence, estimate, populationPrior, tendencies } from './model.ts';
import { DIFFICULTIES, type Difficulty, type DifficultySettings, type PersonalityProfile, STYLES, type StyleId } from './profiles.ts';
import { buildRange, massBelow, weightedQuantile } from './ranges.ts';
import { boardStrength, boardWetness } from './strength.ts';

/**
 * The decision engine shared by every AI opponent.
 *
 * Input is strictly the player's own HandView (their cards, public actions, stacks, pot) plus
 * public statistics about the other players. From that it:
 *   1. reads each opponent's range from their actions this hand (ranges.ts),
 *   2. runs a Monte Carlo simulation of opponent holdings and run-outs,
 *   3. estimates the expected value of folding, checking/calling and several bet sizes —
 *      including fold equity from each opponent's observed tendencies and the risk of being
 *      re-raised — then
 *   4. applies its personality's preferences and chooses with a softmax, so close decisions
 *      are mixed (hard to exploit) and clear ones are made consistently.
 */
export interface DecisionRequest {
  view: HandView;
  style: StyleId;
  difficulty: Difficulty;
  /** Public statistics about the players at the table, keyed by player id. */
  stats: StatsBook;
  /** 0..1 emotional state after recent losses. */
  tilt: number;
  /** Seed for this decision's own randomness (never related to the deck). */
  seed: SeedState;
}

export interface CandidateEval {
  label: string;
  action: PlayerAction;
  ev: number;
  utility: number;
  probability: number;
}

export interface DecisionDebug {
  equity: number;
  samples: number;
  candidates: CandidateEval[];
  foldProbability: Record<number, number>;
  ms: number;
}

export interface Decision {
  action: PlayerAction;
  /** 0 (obvious) .. 1 (agonising): used to vary thinking time. */
  difficulty: number;
  debug: DecisionDebug;
}

/** How strongly personality traits shift utilities, in pot-sized units. */
const TRAIT = {
  preflopLoose: 0.55,
  preflopAggro: 0.14,
  postflopAggro: 0.16,
  sticky: 0.24,
  trap: 0.18,
  bluff: 0.12,
  risk: 0.22,
  tiltLoose: 0.25,
  tiltAggro: 0.1,
};

const STREETS_LEFT = { preflop: 3, flop: 2, turn: 1, river: 0 } as const;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------------------------
// Simulation

interface Simulation {
  n: number;
  opps: number;
  my: Int32Array;
  /** Opponent hand scores, index j * n + k. */
  opp: Int32Array;
  /** Opponent strength percentile on the current street, index j * n + k. */
  str: Float32Array;
}

function sampleIndex(cum: Float64Array, rng: Rng): number {
  const u = randomUnit(rng) * cum[COMBO_COUNT - 1]!;
  let lo = 0;
  let hi = COMBO_COUNT - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! > u) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function simulate(hole: Card[], board: Card[], ranges: Float64Array[], strength: Float32Array, n: number, rng: Rng): Simulation {
  const opps = ranges.length;
  const cums = ranges.map((w) => {
    const c = new Float64Array(COMBO_COUNT);
    let acc = 0;
    for (let k = 0; k < COMBO_COUNT; k++) {
      acc += w[k]!;
      c[k] = acc;
    }
    return c;
  });
  const [lo0, hi0] = cardMask([...hole, ...board]);
  const rest: number[] = [];
  for (let c = 0; c < 52; c++) if (!hasCard(c, lo0, hi0)) rest.push(c);
  const need = 5 - board.length;
  const cards = new Int32Array(7);
  const oppCombo = new Int32Array(opps);
  const sim: Simulation = { n, opps, my: new Int32Array(n), opp: new Int32Array(opps * n), str: new Float32Array(opps * n) };

  for (let k = 0; k < n; k++) {
    let lo = lo0;
    let hi = hi0;
    const mark = (c: number) => {
      if (c < 32) lo |= 1 << c;
      else hi |= 1 << (c - 32);
    };
    for (let j = 0; j < opps; j++) {
      let idx = -1;
      for (let attempt = 0; attempt < 40; attempt++) {
        const cand = sampleIndex(cums[j]!, rng);
        if (!comboConflicts(cand, lo, hi)) {
          idx = cand;
          break;
        }
      }
      if (idx < 0) {
        // Heavy card-removal overlap between ranges: take any compatible combo.
        const start = randomInt(rng, COMBO_COUNT);
        for (let t = 0; t < COMBO_COUNT; t++) {
          const cand = (start + t) % COMBO_COUNT;
          if (!comboConflicts(cand, lo, hi)) {
            idx = cand;
            break;
          }
        }
      }
      oppCombo[j] = idx;
      mark(COMBO_A[idx]!);
      mark(COMBO_B[idx]!);
    }
    for (let i = 0; i < board.length; i++) cards[2 + i] = board[i]!;
    for (let r = 0; r < need; r++) {
      let c: number;
      do c = rest[randomInt(rng, rest.length)]!;
      while (hasCard(c, lo, hi));
      mark(c);
      cards[2 + board.length + r] = c;
    }
    cards[0] = hole[0]!;
    cards[1] = hole[1]!;
    sim.my[k] = evaluate(cards, 7);
    for (let j = 0; j < opps; j++) {
      const idx = oppCombo[j]!;
      cards[0] = COMBO_A[idx]!;
      cards[1] = COMBO_B[idx]!;
      sim.opp[j * n + k] = evaluate(cards, 7);
      sim.str[j * n + k] = strength[idx]!;
    }
  }
  return sim;
}

/** My share of the pot in sample k against the opponents flagged in `inHand`. */
function share(sim: Simulation, k: number, inHand: boolean[]): number {
  const mine = sim.my[k]!;
  let ties = 0;
  for (let j = 0; j < sim.opps; j++) {
    if (!inHand[j]) continue;
    const v = sim.opp[j * sim.n + k]!;
    if (v > mine) return 0;
    if (v === mine) ties++;
  }
  return 1 / (ties + 1);
}

// ---------------------------------------------------------------------------------------------
// Helpers

function legalTo(legal: LegalActions, target: number): number {
  const floor = Math.min(Math.max(legal.minTo, legal.fullRaiseTo), legal.maxTo);
  const to = Math.round(clamp(target, floor, legal.maxTo));
  return to < legal.fullRaiseTo ? legal.maxTo : to;
}

/** Postflop acting order key: higher acts later. */
function orderKey(seat: number, button: number, n: number): number {
  return (seat - button - 1 + n) % n;
}

/** Share of its raw equity a hand converts into pot winnings over the remaining streets. */
function realization(eq: number, streetsLeft: number, inPosition: boolean, opponents: number): number {
  if (streetsLeft === 0) return 1;
  const base = inPosition ? 1.0 : 0.88;
  return clamp(base * (0.85 + 0.3 * eq) * (1 - 0.05 * Math.max(0, opponents - 1)), 0.6, 1.15);
}

/**
 * Money beyond the current pot that a hand expects to win (or lose) on later streets, from the
 * effective stack still behind. Strong hands get paid; weak hands that continue leak chips.
 * `extraction` < 1 when the line gives the opponent less reason to put money in (checking).
 */
function impliedValue(eq: number, behind: number, pot: number, streetsLeft: number, inPosition: boolean, extraction: number): number {
  if (streetsLeft === 0 || behind <= 0) return 0;
  const edge = eq - 0.5;
  // The shallower the stacks relative to the pot, the more likely the rest goes in later.
  const spr = behind / Math.max(1, pot);
  const commitment = clamp(1.15 - 0.1 * spr, 0.3, 1);
  const k = edge >= 0 ? (inPosition ? 0.95 : 0.8) : 0.3;
  return behind * commitment * Math.min(1, streetsLeft / 2) * k * edge * extraction;
}

function softplus(x: number): number {
  return x > 30 ? x : Math.log1p(Math.exp(x));
}

/**
 * Approximate equity of a holding at strength percentile `s` against holdings spread evenly over
 * the percentile interval [a, b], modelling head-to-head equity as a logistic function of the
 * percentile gap (the closed form of the average of σ((s − u)/width) over u in [a, b]).
 */
export function equityVsInterval(s: number, a: number, b: number, width: number): number {
  return (width / (b - a)) * (softplus((s - a) / width) - softplus((s - b) / width));
}

/** What a bet represents to the players facing it: a value range plus some bluffs. */
export interface PerceivedRange {
  /** Value part: the top `top` of holdings. */
  top: number;
  /** Share of the range that is bluffs, spread over [bluffLo, bluffHi]. */
  bluff: number;
  bluffLo: number;
  bluffHi: number;
  width: number;
}

export function equityVsPerceived(s: number, r: PerceivedRange): number {
  const value = equityVsInterval(s, 1 - r.top, 1, r.width);
  const bluffs = equityVsInterval(s, r.bluffLo, r.bluffHi, r.width);
  return (1 - r.bluff) * value + r.bluff * bluffs;
}

/** Strength a player needs to continue when getting `price` odds against a perceived range. */
export function continueThreshold(price: number, r: PerceivedRange): number {
  if (equityVsPerceived(0, r) >= price) return 0;
  if (equityVsPerceived(1, r) < price) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (equityVsPerceived(mid, r) < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

interface Candidate {
  label: string;
  action: PlayerAction;
  cls: 'fold' | 'passive' | 'aggressive';
  ev: number;
  utility: number;
  added: number;
}

// ---------------------------------------------------------------------------------------------

export function decide(req: DecisionRequest): Decision {
  const started = now();
  const { view } = req;
  const legal = view.legal;
  const me = view.viewer;
  if (!legal || me === null || view.toAct !== me) throw new Error("decide() was called when it is not this player's turn");
  const mine = view.seats[me]!;
  const hole = mine.holeCards;
  if (!hole || hole.length !== 2) throw new Error('The deciding player has no hole cards');

  const profile: PersonalityProfile = STYLES[req.style];
  const diff: DifficultySettings = DIFFICULTIES[req.difficulty];
  const rng = SeededRng.fromSeed(req.seed);
  const board = [...view.board];
  const street = view.street;
  const streetsLeft = STREETS_LEFT[street];
  const seatsIn = view.seats.filter((s) => s.inHand);
  const tableSize = seatsIn.length;
  const opps: SeatView[] = view.seats.filter((s) => s.inHand && !s.folded && s.seat !== me);
  const tilt = clamp(req.tilt, 0, 1) * profile.tiltProne;

  const modelWeight = diff.modelWeight * (0.4 + 0.6 * profile.adaptivity);
  const tendCache = new Map<number, Tendencies>();
  const tendOf = (seat: number): Tendencies => {
    let t = tendCache.get(seat);
    if (!t) {
      t = tendencies(req.stats[view.seats[seat]!.id ?? ''], tableSize, modelWeight, diff.recencyWeight);
      tendCache.set(seat, t);
    }
    return t;
  };
  // How this personality perceives others: a calling station doesn't believe bets and assumes
  // bluffs; a rock takes every bet at face value.
  const perceivedTendencies = (seat: number): Tendencies => {
    const t = tendOf(seat);
    return { ...t, bluff: Math.min(0.6, t.bluff * profile.bluffBelief) };
  };
  const depth = Math.min(1, diff.rangeDepth * profile.rangeTrust);

  const read = opps.map((o) => buildRange(o.seat, { view, dead: [...hole, ...board], depth, tendenciesOf: perceivedTendencies }));
  const ranges = read.map((r) => r.current);
  const strength = boardStrength(board);
  const sim = simulate(hole, board, ranges, strength, diff.samples, rng);
  const n = sim.n;
  const everyone = opps.map(() => true);

  let eqAll = 0;
  let oppStrengthSum = 0;
  for (let k = 0; k < n; k++) {
    eqAll += share(sim, k, everyone);
    for (let j = 0; j < sim.opps; j++) oppStrengthSum += Math.max(0, sim.str[j * n + k]!);
  }
  eqAll /= n;
  // Future bets only come from hands strong enough to put money in.
  const extractionOf = (avgStrength: number) => clamp((avgStrength - 0.25) / 0.6, 0.15, 1);
  const rangeExtraction = extractionOf(sim.opps ? oppStrengthSum / (n * sim.opps) : 0.5);

  const pot = legal.pot;
  const bb = legal.bigBlind;
  const myCommit = legal.streetCommit;
  const myTotal = myCommit + legal.stack;
  const scale = Math.max(pot, 2 * bb);
  const nSeats = view.seats.length;
  const inPosition = opps.every((o) => orderKey(me, view.button, nSeats) > orderKey(o.seat, view.button, nSeats));
  const streetActions = view.actions.filter((a) => a.street === street);
  const raiseCount = streetActions.filter((a) => a.kind === 'bet' || a.kind === 'raise').length;
  const wetness = boardWetness(board);

  // Self-image: how the table perceives this player's looseness, from the same public stats.
  let imageAdj = 0;
  if (diff.usesImage && mine.id) {
    const own = req.stats[mine.id];
    const opts = { tableSize, recencyWeight: 0.6 };
    imageAdj = clamp((populationPrior('vpip', tableSize) - estimate(own, 'vpip', opts)) * 0.5, -0.08, 0.08) * confidence(own, 'vpip');
  }

  // How the table sees this player's betting ranges (built from the same public statistics).
  const ownView = tendencies(mine.id ? req.stats[mine.id] : undefined, tableSize, 1, 0.5);
  const width = street === 'preflop' ? 0.25 : 0.12;

  const candidates: Candidate[] = [];

  // ---- Passive options -------------------------------------------------------------------
  const biggestOpponentStack = Math.max(0, ...opps.filter((o) => !o.allIn).map((o) => o.stack));
  if (legal.canCheck) {
    const r = realization(eqAll, streetsLeft, inPosition, opps.length);
    const behind = Math.min(legal.stack, biggestOpponentStack);
    const ev = r * eqAll * pot + impliedValue(eqAll, behind, pot, streetsLeft, inPosition, 0.5 * rangeExtraction);
    candidates.push({ label: 'check', action: { kind: 'check' }, cls: 'passive', ev, utility: 0, added: 0 });
  }
  if (legal.canCall) {
    const everyoneElseAllIn = opps.every((o) => o.allIn || o.stack === 0);
    const noFuture = legal.callIsAllIn || everyoneElseAllIn;
    const r = noFuture ? 1 : realization(eqAll, streetsLeft, inPosition, opps.length);
    const behind = noFuture ? 0 : Math.min(legal.stack - legal.toCall, biggestOpponentStack);
    const waiting = opps.filter((o) => !o.allIn && o.streetCommit < legal.currentBet && o.seat !== streetActions.at(-1)?.seat).length;
    const ev =
      r * eqAll * (pot + legal.toCall) -
      legal.toCall +
      impliedValue(eqAll, behind, pot + 2 * legal.toCall, streetsLeft, inPosition, 0.8 * rangeExtraction) -
      0.04 * pot * waiting * (1 - eqAll);
    candidates.push({ label: `call ${legal.toCall}`, action: { kind: 'call' }, cls: 'passive', ev, utility: 0, added: legal.toCall });
  }
  if (legal.canFold) candidates.push({ label: 'fold', action: { kind: 'fold' }, cls: 'fold', ev: 0, utility: 0, added: 0 });

  // ---- Aggressive options ----------------------------------------------------------------
  const foldProbability: Record<number, number> = {};
  if (legal.aggression) {
    const effectiveStack = Math.min(myTotal, Math.max(0, ...opps.map((o) => o.stack + o.streetCommit)));
    const targets = sizeTargets(view, legal, diff, inPosition, effectiveStack);
    const seen = new Set<number>();
    for (const target of targets) {
      let to = legalTo(legal, target);
      const add = to - myCommit;
      // Stack commitment: don't leave behind a sliver that can't be played later.
      if (legal.maxTo - to < 0.35 * (pot + 2 * add)) to = legal.maxTo;
      if (seen.has(to)) continue;
      seen.add(to);
      const ev = aggressionEv(to);
      const label = to === legal.maxTo ? 'all-in' : `${legal.aggression} ${to}`;
      candidates.push({ label, action: { kind: legal.aggression, to }, cls: 'aggressive', ev, utility: 0, added: to - myCommit });
    }
  }


  /** The range opponents credit this player with when putting in `add` more. */
  function perceived(add: number): PerceivedRange {
    if (street === 'preflop') {
      if (raiseCount === 0) return { top: clamp(ownView.pfr, 0.08, 0.6), bluff: 0.08, bluffLo: 0.35, bluffHi: 0.65, width };
      if (raiseCount === 1) return { top: clamp(ownView.threeBet * 1.3, 0.04, 0.3), bluff: 0.22, bluffLo: 0.4, bluffHi: 0.7, width };
      return { top: 0.04, bluff: 0.15, bluffLo: 0.5, bluffHi: 0.8, width };
    }
    const ratio = add / Math.max(1, pot);
    let top = clamp(0.32 * Math.sqrt(0.66 / Math.max(0.2, ratio)), 0.1, 0.55) * (0.8 + ownView.betFreq / 2);
    // Raises are read as stronger and rarely bluffs; bigger bets as more polarised.
    if (raiseCount > 0) top *= 0.55;
    const bluff =
      raiseCount > 0 ? clamp(ownView.bluff * 0.4, 0.04, 0.2) : clamp(ownView.bluff * (0.8 + 0.3 * Math.min(2, ratio)), 0.08, 0.5);
    return { top, bluff, bluffLo: 0, bluffHi: street === 'river' ? 0.35 : 0.45, width };
  }

  /** The observed statistic that describes folding to this bet, and the bet size it typically refers to. */
  function foldStatFor(add: number): [StatKey, number] {
    if (street === 'preflop') return raiseCount === 0 ? ['foldToRaise', 0.62] : ['foldTo3Bet', 0.6];
    return add / Math.max(1, pot) >= 0.66 ? ['foldToBigBet', 0.47] : ['foldToBet', 0.375];
  }

  /** Observed fold tendency relative to the population, for the spot this bet creates. */
  function foldShift(o: SeatView, add: number): number {
    const [key] = foldStatFor(add);
    return (tendOf(o.seat)[key as keyof Tendencies] as number) - populationPrior(key, tableSize);
  }

  function aggressionEv(to: number): number {
    const add = to - myCommit;
    const iAmAllIn = to >= myTotal;
    const q: number[] = [];
    const qr: number[] = [];
    const callAdd: number[] = [];
    const canRespond: boolean[] = [];
    opps.forEach((o, j) => {
      const oppTotal = o.streetCommit + o.stack;
      canRespond[j] = !o.allIn && o.stack > 0;
      callAdd[j] = Math.max(0, Math.min(to, oppTotal) - o.streetCommit);
      if (!canRespond[j]) {
        q[j] = -1;
        qr[j] = 2;
        return;
      }
      // The opponent continues when their holding has enough equity against the range this
      // bet represents at the price offered; habitual folders need more, stations less.
      const potAfter = pot + add + callAdd[j]!;
      const othersBehind = opps.filter((x) => x.seat !== o.seat && !x.allIn).length;
      const price = (callAdd[j]! / potAfter) * (1 + 0.08 * othersBehind);
      let threshold = continueThreshold(price, perceived(add));
      threshold += 0.6 * foldShift(o, add) + 0.06 * profile.bluffing + imageAdj;
      threshold = clamp(threshold, 0, 0.995);
      // Blend the structural prediction with how often this player has actually folded to bets
      // like this one, trusting the observation as evidence accumulates.
      const [statKey, typicalAlpha] = foldStatFor(add);
      const trust = confidence(req.stats[o.id ?? ''], statKey) * modelWeight;
      if (trust > 0.05) {
        const predicted = massBelow(ranges[j]!, strength, threshold);
        const observed = clamp((tendOf(o.seat)[statKey as keyof Tendencies] as number) + 0.5 * (add / (add + pot) - typicalAlpha), 0.02, 0.97);
        const blended = (1 - trust) * predicted + trust * observed;
        threshold = weightedQuantile(ranges[j]!, strength, blended);
      }
      q[j] = threshold;
      foldProbability[o.seat] = Math.round(massBelow(ranges[j]!, strength, q[j]!) * 100) / 100;
      // Part of the continuing range re-raises; facing a bet that commits much of their stack,
      // continuing hands mostly move all-in.
      const t = tendOf(o.seat);
      let raiseShare = street === 'preflop' ? (raiseCount === 0 ? 0.22 + (t.threeBet - 0.08) * 2 : 0.4) : 0.2 * (t.raiseVsBet / 0.09);
      if (callAdd[j]! >= 0.4 * o.stack) raiseShare = Math.max(raiseShare, 0.55);
      qr[j] = oppTotal > to ? q[j]! + (1 - q[j]!) * (1 - clamp(raiseShare, 0, 0.9)) : 2;
    });

    // Pass 1: equity when called, equity when re-raised.
    const callers = opps.map(() => false);
    let calledSamples = 0;
    let eqCalled = 0;
    let callerStrength = 0;
    let callerCount = 0;
    let raisedSamples = 0;
    let eqRaised = 0;
    const raisedFlag = new Uint8Array(n);
    const anyCaller = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      let any = false;
      let raised = false;
      for (let j = 0; j < opps.length; j++) {
        const s = sim.str[j * n + k]!;
        callers[j] = !canRespond[j] || s >= q[j]!;
        if (callers[j]) any = true;
        if (canRespond[j] && s >= qr[j]! && diff.anticipatesRaises && !iAmAllIn) raised = true;
      }
      if (!any) continue;
      anyCaller[k] = 1;
      const sh = share(sim, k, callers);
      if (raised) {
        raisedFlag[k] = 1;
        raisedSamples++;
        eqRaised += sh;
      } else {
        calledSamples++;
        eqCalled += sh;
        for (let j = 0; j < opps.length; j++) {
          if (callers[j] && canRespond[j]) {
            callerStrength += Math.max(0, sim.str[j * n + k]!);
            callerCount++;
          }
        }
      }
    }
    eqCalled = calledSamples ? eqCalled / calledSamples : eqAll;
    eqRaised = raisedSamples ? eqRaised / raisedSamples : 0;
    const rCalled = iAmAllIn ? 1 : realization(eqCalled, streetsLeft, inPosition, 1);
    const behindCalled = iAmAllIn
      ? 0
      : Math.min(myTotal - to, Math.max(0, ...opps.map((o, j) => (canRespond[j] ? o.stack - callAdd[j]! : 0))));
    const impliedCalled = impliedValue(eqCalled, behindCalled, pot + 2 * add, streetsLeft, inPosition, extractionOf(callerCount ? callerStrength / callerCount : 0.5));

    // Facing a re-raise: continue only if the price is right for our equity against it.
    const shoveTo = Math.max(0, ...opps.map((o, j) => (canRespond[j] && callAdd[j]! >= 0.4 * o.stack ? o.streetCommit + o.stack : 0)));
    const reraiseTo = Math.min(myTotal, Math.max(3 * to, to + pot + add, shoveTo));
    const potIfReraised = pot + (reraiseTo - myCommit) + (reraiseTo - Math.min(...opps.map((o) => o.streetCommit)));
    const continueVsRaise = eqRaised * potIfReraised >= reraiseTo - to;

    // Pass 2: expected value.
    let total = 0;
    for (let k = 0; k < n; k++) {
      if (!anyCaller[k]) {
        total += pot;
        continue;
      }
      let contributed = 0;
      let allCallersAllIn = true;
      for (let j = 0; j < opps.length; j++) {
        callers[j] = !canRespond[j] || sim.str[j * n + k]! >= q[j]!;
        if (callers[j] && canRespond[j]) {
          contributed += callAdd[j]!;
          if (callAdd[j]! < opps[j]!.stack) allCallersAllIn = false;
        }
      }
      const sh = share(sim, k, callers);
      if (raisedFlag[k]) {
        total += continueVsRaise ? sh * potIfReraised - (reraiseTo - myCommit) : -add;
      } else {
        const r = allCallersAllIn ? 1 : rCalled;
        total += r * sh * (pot + add + contributed) - add + (allCallersAllIn ? 0 : impliedCalled);
      }
    }
    return total / n;
  }

  // ---- Personality & state adjustments ---------------------------------------------------
  const stackAtRisk = Math.max(1, myTotal);
  for (const c of candidates) {
    let u = c.ev;
    const isCall = c.action.kind === 'call';
    if (street === 'preflop') {
      if (isCall) u += scale * (TRAIT.preflopLoose * profile.looseness * 0.8 + TRAIT.sticky * profile.stickiness * 0.3 + TRAIT.tiltLoose * tilt);
      if (c.cls === 'aggressive') {
        u += scale * (TRAIT.preflopLoose * profile.looseness * 0.6 + TRAIT.preflopAggro * profile.aggression + TRAIT.tiltLoose * tilt * 0.6);
      }
    } else {
      if (isCall) u += scale * TRAIT.sticky * profile.stickiness;
      if (c.cls === 'aggressive') u += scale * (TRAIT.postflopAggro * profile.aggression + TRAIT.tiltAggro * tilt);
      if (c.cls === 'passive' && eqAll >= 0.8 && wetness < 0.45 && streetsLeft > 0) u += scale * TRAIT.trap * profile.trappiness;
    }
    const riskShare = c.added / stackAtRisk;
    if (riskShare > 0.3) u -= TRAIT.risk * profile.riskAversion * c.added * riskShare * (1 - eqAll);
    c.utility = u;
  }

  // ---- Choice ------------------------------------------------------------------------------
  const temperature = diff.temperature * (1 + 1.5 * tilt) * scale;
  const classes: { cls: Candidate['cls']; best: Candidate; members: Candidate[] }[] = [];
  for (const cls of ['fold', 'passive', 'aggressive'] as const) {
    const members = candidates.filter((c) => c.cls === cls);
    if (!members.length) continue;
    const best = members.reduce((a, b) => (b.utility > a.utility ? b : a));
    classes.push({ cls, best, members });
  }
  const maxU = Math.max(...classes.map((c) => c.best.utility));
  const classWeights = classes.map((c) => Math.exp((c.best.utility - maxU) / temperature));
  const classTotal = classWeights.reduce((a, b) => a + b, 0);
  const probabilities = new Map<Candidate, number>();
  classes.forEach((c, i) => {
    const pClass = classWeights[i]! / classTotal;
    const inner = c.members.map((m) => Math.exp((m.utility - c.best.utility) / (temperature * 0.6)));
    const innerTotal = inner.reduce((a, b) => a + b, 0);
    c.members.forEach((m, t) => probabilities.set(m, (pClass * inner[t]!) / innerTotal));
  });

  let roll = randomUnit(rng);
  let chosen = candidates[0]!;
  for (const c of candidates) {
    const p = probabilities.get(c) ?? 0;
    if (roll < p) {
      chosen = c;
      break;
    }
    roll -= p;
    chosen = c;
  }

  const sortedP = [...probabilities.values()].sort((a, b) => b - a);
  const closeness = sortedP.length > 1 ? clamp(1 - (sortedP[0]! - sortedP[1]!), 0, 1) : 0;

  return {
    action: chosen.action,
    difficulty: closeness,
    debug: {
      equity: Math.round(eqAll * 1000) / 1000,
      samples: n,
      candidates: candidates.map((c) => ({
        label: c.label,
        action: c.action,
        ev: Math.round(c.ev * 10) / 10,
        utility: Math.round(c.utility * 10) / 10,
        probability: Math.round((probabilities.get(c) ?? 0) * 1000) / 1000,
      })),
      foldProbability,
      ms: Math.round(now() - started),
    },
  };
}

/**
 * Candidate raise-to amounts before legalisation. Each context has a small menu of sizes, as
 * real players use: one opening size regardless of hand strength (no size tells), all-in only at
 * push/fold stack depths or low stack-to-pot ratios.
 */
function sizeTargets(view: HandView, legal: LegalActions, diff: DifficultySettings, inPosition: boolean, effectiveStack: number): number[] {
  const bb = legal.bigBlind;
  const pot = legal.pot;
  const cb = legal.currentBet;
  const depthBB = effectiveStack / bb;
  const out: number[] = [];
  let allowAllIn: boolean;
  if (view.street === 'preflop') {
    const pre = view.actions.filter((a) => a.street === 'preflop');
    const raises = pre.filter((a) => a.kind === 'raise');
    if (raises.length === 0) {
      const limpers = pre.filter((a) => a.kind === 'call').length;
      const open = legal.toCall === 0 ? 4 : diff.sizing === 'full' && depthBB > 40 ? 3 : 2.5;
      out.push(bb * (open + limpers));
      if (diff.sizing === 'full' && legal.toCall > 0 && depthBB > 25) out.push(bb * (2.2 + limpers));
      allowAllIn = depthBB <= 13;
    } else {
      const lastRaise = raises[raises.length - 1]!;
      const callersAfter = pre.filter((a) => a.kind === 'call' && pre.indexOf(a) > pre.indexOf(lastRaise)).length;
      const mult = raises.length === 1 ? (inPosition ? 3 : 3.7) : 2.3;
      out.push(cb * mult + callersAfter * cb);
      allowAllIn = depthBB <= (raises.length === 1 ? 30 : 60);
    }
  } else {
    const spr = effectiveStack / Math.max(1, pot);
    if (cb === 0) {
      const fracs = diff.sizing === 'basic' ? [0.5, 1] : diff.sizing === 'standard' ? [0.33, 0.66, 1] : [0.33, 0.66, 1, 1.5];
      for (const f of fracs) out.push(Math.max(bb, f * pot));
    } else {
      const fracs = diff.sizing === 'basic' ? [0.8] : diff.sizing === 'standard' ? [0.8] : [0.7, 1.1];
      for (const f of fracs) out.push(cb + f * (pot + legal.toCall));
    }
    allowAllIn = spr <= 3 || (diff.sizing === 'full' && spr <= 5);
  }
  if (allowAllIn) out.push(legal.maxTo);
  return out;
}

/** Last-resort action if the decision engine fails: never folds when checking is free. */
export function safeFallbackAction(legal: LegalActions): PlayerAction {
  if (legal.canCheck) return { kind: 'check' };
  return { kind: 'fold' };
}
