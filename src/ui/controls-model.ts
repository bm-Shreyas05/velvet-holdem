import type { LegalActions, PlayerAction } from '../engine/types.ts';
import { chips } from './format.ts';

/**
 * Pure logic behind the action bar: which buttons exist, what they say, which bet sizes are
 * offered and how typed amounts are validated. The DOM layer only renders this.
 */
export interface Preset {
  id: string;
  label: string;
  to: number;
}

export interface ControlsState {
  canFold: boolean;
  passive: { kind: 'check' | 'call'; label: string; amount: number; allIn: boolean };
  aggressive: {
    kind: 'bet' | 'raise';
    min: number;
    max: number;
    step: number;
    presets: Preset[];
    /** Only an all-in is possible (stack too short for a full raise). */
    allInOnly: boolean;
  } | null;
  /** Chips needed to call and the share of the final pot that represents (pot odds). */
  potOdds: { toCall: number; potAfterCall: number; equityNeeded: number } | null;
}

export function controlsFor(legal: LegalActions): ControlsState {
  const passive = legal.canCheck
    ? { kind: 'check' as const, label: 'Check', amount: 0, allIn: false }
    : { kind: 'call' as const, label: legal.callIsAllIn ? `Call ${chips(legal.toCall)} (all-in)` : `Call ${chips(legal.toCall)}`, amount: legal.toCall, allIn: legal.callIsAllIn };
  let aggressive: ControlsState['aggressive'] = null;
  if (legal.aggression) {
    const min = Math.min(Math.max(legal.minTo, legal.fullRaiseTo), legal.maxTo);
    const allInOnly = min >= legal.maxTo;
    aggressive = {
      kind: legal.aggression,
      min: allInOnly ? legal.maxTo : min,
      max: legal.maxTo,
      step: stepFor(legal.bigBlind),
      presets: allInOnly ? [] : presets(legal),
      allInOnly,
    };
  }
  const potOdds = legal.toCall > 0 ? { toCall: legal.toCall, potAfterCall: legal.pot + legal.toCall, equityNeeded: legal.toCall / (legal.pot + legal.toCall) } : null;
  return { canFold: legal.canFold, passive, aggressive, potOdds };
}

function stepFor(bigBlind: number): number {
  if (bigBlind >= 200) return Math.round(bigBlind / 4);
  if (bigBlind >= 20) return Math.max(5, Math.round(bigBlind / 10) * 5 / 2);
  return 1;
}

/** Common sizes: minimum, half pot, three-quarters pot, pot, all-in (deduplicated, legal). */
export function presets(legal: LegalActions): Preset[] {
  const out: Preset[] = [];
  const fullMin = Math.min(Math.max(legal.minTo, legal.fullRaiseTo), legal.maxTo);
  const add = (id: string, label: string, target: number) => {
    let to = Math.round(target);
    if (to < fullMin) to = fullMin;
    if (to > legal.maxTo) to = legal.maxTo;
    if (!out.some((p) => p.to === to)) out.push({ id, label, to });
  };
  add('min', 'Min', fullMin);
  // A pot-sized raise: call first, then raise the size of the pot.
  const potAfterCall = legal.pot + legal.toCall;
  const base = legal.currentBet;
  add('half', '½ Pot', base + potAfterCall * 0.5);
  add('three-quarters', '¾ Pot', base + potAfterCall * 0.75);
  add('pot', 'Pot', base + potAfterCall);
  add('allin', 'All-in', legal.maxTo);
  return out.sort((a, b) => a.to - b.to);
}

/** Accepts "1200", "1,200", " 1 200 ", "1.5k". Returns null for anything else. */
export function parseAmount(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/[,\s_]/g, '');
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)(k)?$/.exec(t);
  if (!m) return null;
  const value = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(value) ? Math.round(value) : null;
}

export interface Validated {
  to: number;
  /** Explains any adjustment made to the requested amount. */
  note: string | null;
}

/** Brings a requested raise-to amount into the legal range, explaining any change. */
export function validateAmount(requested: number | null, legal: LegalActions): Validated {
  const min = Math.min(Math.max(legal.minTo, legal.fullRaiseTo), legal.maxTo);
  if (requested === null) return { to: min, note: 'Enter an amount in chips.' };
  if (requested >= legal.maxTo) return { to: legal.maxTo, note: requested > legal.maxTo ? `You have ${chips(legal.maxTo)} in total — that is all-in.` : null };
  if (requested < min) return { to: min, note: `The minimum ${legal.aggression === 'bet' ? 'bet' : 'raise'} is ${chips(min)}.` };
  return { to: requested, note: null };
}

export function aggressiveLabel(kind: 'bet' | 'raise', to: number, max: number): string {
  if (to >= max) return `All-in ${chips(max)}`;
  return kind === 'bet' ? `Bet ${chips(to)}` : `Raise to ${chips(to)}`;
}

export function toAction(choice: 'fold' | 'passive' | 'aggressive', legal: LegalActions, to?: number): PlayerAction {
  if (choice === 'fold') return { kind: 'fold' };
  if (choice === 'passive') return legal.canCheck ? { kind: 'check' } : { kind: 'call' };
  if (!legal.aggression) throw new Error('Raising is not available');
  return { kind: legal.aggression, to: validateAmount(to ?? null, legal).to };
}
