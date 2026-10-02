import type { Decision, DecisionRequest } from '../ai/decide.ts';
import type { StatsBook } from '../ai/model.ts';
import type { Card } from '../engine/cards.ts';
import { Deck } from '../engine/deck.ts';
import { HoldemHand } from '../engine/hand.ts';
import { eventsVisibleTo, type HandEvent, type HandView, type LegalActions, type PlayerAction, type Street } from '../engine/types.ts';
import type { HandHistoryRecord } from './history.ts';

/**
 * Hand replays and the coach's review of a finished hand.
 *
 * A replay re-runs the hand through the real engine from its stored deck order and decisions,
 * and keeps only what the player could see at each moment (their own cards, the board, the
 * bets, and hands shown down) — the same information boundary as live play. The coach then
 * evaluates each of the player's decisions from the view they had at that moment.
 */
export interface ReplayStep {
  /** What the player saw happen in this step (other players' unrevealed cards removed). */
  events: HandEvent[];
  /** The player's view after this step. */
  view: HandView;
  /** The decision that produced this step (null for the deal). */
  decision: { seat: number; action: PlayerAction } | null;
  /** The player's view just before they decided (their own decisions only). */
  before: HandView | null;
}

export function buildReplaySteps(record: HandHistoryRecord): ReplayStep[] {
  const viewer = record.humanSeat;
  const { hand, events } = HoldemHand.start(structuredClone(record.replay.setup), new Deck(record.replay.deckOrder));
  const steps: ReplayStep[] = [{ events: eventsVisibleTo(events, viewer), view: hand.viewFor(viewer), decision: null, before: null }];
  for (const d of record.replay.decisions) {
    const before = d.seat === viewer ? hand.viewFor(viewer) : null;
    const produced = hand.act(d.seat, d.action);
    steps.push({ events: eventsVisibleTo(produced, viewer), view: hand.viewFor(viewer), decision: d, before });
  }
  return steps;
}

/** How an action reads in words: "Fold", "Call 150", "Raise to 600", "All-in (1,240)". */
export function actionText(action: PlayerAction, legal: Pick<LegalActions, 'toCall' | 'maxTo'>): string {
  const n = (x: number) => x.toLocaleString('en-US');
  switch (action.kind) {
    case 'fold':
      return 'Fold';
    case 'check':
      return 'Check';
    case 'call':
      return `Call ${n(legal.toCall)}`;
    case 'bet':
      return action.to === legal.maxTo ? `All-in (${n(action.to!)})` : `Bet ${n(action.to ?? 0)}`;
    case 'raise':
      return action.to === legal.maxTo ? `All-in (${n(action.to!)})` : `Raise to ${n(action.to ?? 0)}`;
  }
}

export type Verdict = 'good' | 'close' | 'costly';

export interface OptionReview {
  text: string;
  action: PlayerAction;
  /** Estimated value in big blinds, relative to folding. */
  evBB: number;
  chosen: boolean;
  best: boolean;
}

export interface DecisionReview {
  /** Index of the replay step this decision produced. */
  step: number;
  street: Street;
  board: Card[];
  hole: Card[];
  potBB: number;
  toCallBB: number;
  /** Equity a call needs to break even, or null when checking was free. */
  potOdds: number | null;
  /** Estimated equity against the opponents' likely holdings at that moment. */
  equity: number;
  action: PlayerAction;
  actionText: string;
  options: OptionReview[];
  /** Estimated value given up versus the coach's best option, in big blinds (≥ 0). */
  evLossBB: number;
  verdict: Verdict;
}

export interface ReviewContext {
  /** Public statistics about the players, if the hand is from the current game. */
  stats?: StatsBook;
  /** Tournament payouts (ICM) when more than one place is paid. */
  payouts?: number[] | null;
}

/** Same seed for the same decision, so a hand reviewed twice gets the same verdicts. */
function seedFor(record: HandHistoryRecord, step: number): [number, number, number, number] {
  const deck = record.replay.deckOrder;
  return [(record.handNumber * 2654435761) >>> 0, step + 1, (deck[0]! * 64 + deck[1]!) >>> 0, 0x9e3779b9];
}

function sameAction(a: PlayerAction, b: PlayerAction): boolean {
  return a.kind === b.kind && (a.to ?? 0) === (b.to ?? 0);
}

/**
 * Grades a value given up, scaled to the stakes of the decision: small leaks in big pots are
 * "close", the same leak in a tiny pot is not.
 */
export function verdictFor(evLossBB: number, potBB: number): Verdict {
  if (evLossBB <= Math.max(0.3, 0.03 * potBB)) return 'good';
  if (evLossBB <= Math.max(1.5, 0.12 * potBB)) return 'close';
  return 'costly';
}

/**
 * Reviews every decision the player made in the hand. The coach is the strongest AI setting (an
 * Elite Shark) evaluating the same view the player had; values are its model's estimates.
 */
export async function reviewDecisions(
  record: HandHistoryRecord,
  steps: ReplayStep[],
  decide: (request: DecisionRequest) => Promise<Decision>,
  ctx: ReviewContext = {},
): Promise<DecisionReview[]> {
  const out: DecisionReview[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (!step.before || !step.decision) continue;
    const view = step.before;
    const legal = view.legal;
    const hole = view.seats[record.humanSeat]?.holeCards;
    if (!legal || !hole) continue;
    const action = step.decision.action;
    const decision = await decide({
      view,
      style: 'shark',
      difficulty: 'elite',
      stats: ctx.stats ?? {},
      tilt: 0,
      seed: seedFor(record, i),
      ...(ctx.payouts && ctx.payouts.length > 1 ? { payouts: ctx.payouts } : {}),
      evaluate: [action],
    });
    const bb = legal.bigBlind;
    const candidates = decision.debug.candidates;
    if (!candidates.length) continue;
    const best = candidates.reduce((a, b) => (b.ev > a.ev ? b : a));
    const chosen =
      candidates.find((c) => sameAction(c.action, action)) ??
      // An amount the engine clamped differently: compare with the closest priced size.
      candidates
        .filter((c) => c.action.kind === action.kind)
        .reduce<(typeof candidates)[number] | undefined>(
          (near, c) => (!near || Math.abs((c.action.to ?? 0) - (action.to ?? 0)) < Math.abs((near.action.to ?? 0) - (action.to ?? 0)) ? c : near),
          undefined,
        );
    if (!chosen) continue;
    const seen = new Set<string>();
    const options: OptionReview[] = [...candidates]
      .sort((a, b) => b.ev - a.ev)
      .map((c) => ({ text: actionText(c.action, legal), action: c.action, evBB: c.ev / bb, chosen: c === chosen, best: c === best }))
      .filter((o) => {
        if (seen.has(o.text) && !o.chosen) return false;
        seen.add(o.text);
        return true;
      });
    const potBB = legal.pot / bb;
    const evLossBB = Math.max(0, (best.ev - chosen.ev) / bb);
    out.push({
      step: i,
      street: view.street,
      board: [...view.board],
      hole: [...hole],
      potBB,
      toCallBB: legal.toCall / bb,
      potOdds: legal.toCall > 0 ? legal.toCall / (legal.pot + legal.toCall) : null,
      equity: decision.debug.equity,
      action,
      actionText: actionText(action, legal),
      options,
      evLossBB,
      verdict: verdictFor(evLossBB, potBB),
    });
  }
  return out;
}

/** One-line advice for the player's current decision (live coach hints). */
export function adviceText(decision: Decision, legal: LegalActions): string {
  const best = decision.debug.candidates.reduce((a, b) => (b.ev > a.ev ? b : a));
  return `Coach: ${actionText(best.action, legal)} · your equity ≈ ${Math.round(decision.debug.equity * 100)}%`;
}
