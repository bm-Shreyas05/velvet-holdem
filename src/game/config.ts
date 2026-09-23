import { type GameConfig, buildBlindSchedule } from '../engine/game.ts';
import { DEFAULT_PERSONAS, type Difficulty, type StyleId, isDifficulty, isStyle } from '../ai/profiles.ts';

/** How quickly the blinds rise. */
export type Structure = 'turbo' | 'standard' | 'slow' | 'fixed';

export const STRUCTURES: Record<Structure, { label: string; handsPerLevel: number | null; blurb: string }> = {
  turbo: { label: 'Turbo', handsPerLevel: 8, blurb: 'Blinds rise every 8 hands. Games take about 15 minutes.' },
  standard: { label: 'Standard', handsPerLevel: 12, blurb: 'Blinds rise every 12 hands.' },
  slow: { label: 'Deep', handsPerLevel: 20, blurb: 'Blinds rise every 20 hands. More room to play.' },
  fixed: { label: 'Fixed blinds', handsPerLevel: null, blurb: 'Blinds never change.' },
};

export interface OpponentSetup {
  name: string;
  /** 'random' picks a style when the game starts. */
  style: StyleId | 'random';
}

export interface NewGameSetup {
  playerName: string;
  opponents: OpponentSetup[];
  difficulty: Difficulty;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  structure: Structure;
  /** Developer option: reproducible deck and AI randomness. Never set in normal play. */
  seed?: string;
  /** Developer option: deal the first hand from a prepared scenario (see src/dev/scenarios.ts). */
  scenario?: string;
}

export const MIN_OPPONENTS = 1;
export const MAX_OPPONENTS = 5;

export function defaultSetup(): NewGameSetup {
  return {
    playerName: 'You',
    opponents: DEFAULT_PERSONAS.slice(0, 3).map((p) => ({ name: p.name, style: p.style })),
    difficulty: 'standard',
    startingStack: 1000,
    smallBlind: 25,
    bigBlind: 50,
    structure: 'standard',
  };
}

/** Returns a player-readable problem with the setup, or null if it can be played. */
export function validateSetup(s: NewGameSetup): string | null {
  const name = s.playerName.trim();
  if (!name) return 'Enter a name for yourself.';
  if (name.length > 24) return 'Names can be at most 24 characters.';
  if (!Array.isArray(s.opponents) || s.opponents.length < MIN_OPPONENTS || s.opponents.length > MAX_OPPONENTS) {
    return `Choose between ${MIN_OPPONENTS} and ${MAX_OPPONENTS} opponents.`;
  }
  const names = new Set([name.toLowerCase()]);
  for (const o of s.opponents) {
    const n = o.name.trim();
    if (!n) return 'Every opponent needs a name.';
    if (n.length > 24) return 'Names can be at most 24 characters.';
    if (names.has(n.toLowerCase())) return `The name "${n}" is used twice.`;
    names.add(n.toLowerCase());
    if (o.style !== 'random' && !isStyle(o.style)) return 'Unknown playing style.';
  }
  if (!isDifficulty(s.difficulty)) return 'Unknown difficulty.';
  if (!(s.structure in STRUCTURES)) return 'Unknown blind structure.';
  for (const [label, v] of [
    ['Starting stack', s.startingStack],
    ['Big blind', s.bigBlind],
  ] as const) {
    if (!Number.isInteger(v) || v <= 0) return `${label} must be a positive whole number.`;
  }
  if (!Number.isInteger(s.smallBlind) || s.smallBlind <= 0) return 'Small blind must be a positive whole number.';
  if (s.smallBlind > s.bigBlind) return 'The small blind cannot be larger than the big blind.';
  if (s.startingStack > 10_000_000) return 'Starting stack is too large.';
  if (s.startingStack < s.bigBlind * 2) return 'Starting stacks must be at least two big blinds.';
  return null;
}

export function gameConfigFor(s: NewGameSetup): GameConfig {
  return {
    startingStack: s.startingStack,
    levels: buildBlindSchedule(s.smallBlind, s.bigBlind),
    handsPerLevel: STRUCTURES[s.structure].handsPerLevel,
  };
}
