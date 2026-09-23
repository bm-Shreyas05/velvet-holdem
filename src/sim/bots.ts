import { type Rng, randomInt, randomUnit } from '../engine/rng.ts';
import type { LegalActions, PlayerAction } from '../engine/types.ts';

/**
 * Simple scripted players used by tests, stress simulations and AI evaluation as sparring
 * partners. They are NOT the game's AI (see src/ai); they exist to exercise the engine and to
 * give the real AI known, exploitable styles to adapt to.
 */

/** A legal raise-to amount between the full minimum and all-in, or the all-in when short. */
export function legalRaiseTo(legal: LegalActions, target: number): number {
  const floor = Math.min(Math.max(legal.minTo, legal.fullRaiseTo), legal.maxTo);
  const to = Math.round(Math.min(Math.max(target, floor), legal.maxTo));
  return to < legal.fullRaiseTo ? legal.maxTo : to;
}

/** Uniform-ish random legal action with a bias toward all-ins, to hit side-pot edge cases. */
export function randomLegalAction(legal: LegalActions, rng: Rng): PlayerAction {
  const roll = randomUnit(rng);
  if (legal.aggression && roll < 0.3) {
    const pick = randomInt(rng, 4);
    const target =
      pick === 0 ? legal.minTo : pick === 1 ? legal.maxTo : legal.fullRaiseTo + randomInt(rng, Math.max(1, legal.maxTo - legal.fullRaiseTo + 1));
    return { kind: legal.aggression, to: legalRaiseTo(legal, target) };
  }
  if (legal.canFold && roll < 0.45) return { kind: 'fold' };
  if (legal.canCall) return { kind: 'call' };
  return { kind: 'check' };
}

export type ScriptedStyle = 'random' | 'station' | 'maniac' | 'nit' | 'folder';

/** Fixed-style bots for AI evaluation. They ignore their cards entirely except 'nit'. */
export function scriptedAction(style: ScriptedStyle, legal: LegalActions, rng: Rng, strength = 0.5): PlayerAction {
  switch (style) {
    case 'station':
      return legal.canCall ? { kind: 'call' } : { kind: 'check' };
    case 'maniac':
      if (legal.aggression && randomUnit(rng) < 0.7) {
        return { kind: legal.aggression, to: legalRaiseTo(legal, legal.currentBet + legal.pot) };
      }
      return legal.canCall ? { kind: 'call' } : { kind: 'check' };
    case 'folder':
      if (legal.canCheck) return { kind: 'check' };
      return randomUnit(rng) < 0.85 ? { kind: 'fold' } : { kind: 'call' };
    case 'nit':
      if (strength > 0.85 && legal.aggression) return { kind: legal.aggression, to: legalRaiseTo(legal, legal.currentBet * 3 || legal.pot) };
      if (strength > 0.65) return legal.canCall ? { kind: 'call' } : { kind: 'check' };
      return legal.canCheck ? { kind: 'check' } : { kind: 'fold' };
    default:
      return randomLegalAction(legal, rng);
  }
}
