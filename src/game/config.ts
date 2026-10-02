import { type GameConfig, buildBlindSchedule } from '../engine/game.ts';
import { SeededRng, randomInt } from '../engine/rng.ts';
import type { BlindConfig } from '../engine/types.ts';
import { DEFAULT_PERSONAS, type Difficulty, STYLE_ORDER, type StyleId, isDifficulty, isStyle } from '../ai/profiles.ts';

/**
 * What kind of game:
 * - tournament: everyone starts equal, blinds rise, busted players are out; prizes go to the top
 *   finishers (winner-take-all or the top two or three).
 * - cash: blinds never change and nobody is eliminated — buy in again when you run out, cash out
 *   whenever you like. Results are counted in chips won or lost.
 */
export type GameMode = 'tournament' | 'cash';

/** How quickly the blinds rise. */
export type Structure = 'turbo' | 'standard' | 'slow' | 'fixed';

export const STRUCTURES: Record<Structure, { label: string; handsPerLevel: number | null; blurb: string }> = {
  turbo: { label: 'Turbo', handsPerLevel: 8, blurb: 'Blinds rise every 8 hands. Games take about 15 minutes.' },
  standard: { label: 'Standard', handsPerLevel: 12, blurb: 'Blinds rise every 12 hands.' },
  slow: { label: 'Deep', handsPerLevel: 20, blurb: 'Blinds rise every 20 hands. More room to play.' },
  fixed: { label: 'Fixed blinds', handsPerLevel: null, blurb: 'Blinds never change.' },
};

export type PayoutId = 'winner' | 'top2' | 'top3';

/** Tournament prize structures, as fractions of the prize pool for 1st, 2nd, 3rd. */
export const PAYOUTS: Record<PayoutId, { label: string; places: number[]; minPlayers: number; blurb: string }> = {
  winner: { label: 'Winner takes all', places: [1], minPlayers: 2, blurb: 'Only first place wins a prize.' },
  top2: { label: 'Top 2 paid', places: [0.65, 0.35], minPlayers: 3, blurb: '65% / 35% of the pool. Surviving the bubble matters.' },
  top3: { label: 'Top 3 paid', places: [0.5, 0.3, 0.2], minPlayers: 4, blurb: '50% / 30% / 20% of the pool.' },
};

/** Every tournament entry costs this many prize points; the pool is the sum of the entries. */
export const BUY_IN_POINTS = 100;

/** Antes join the blinds from this level (index 3 = level 4) in rising-blind tournaments. */
export const ANTE_FROM_LEVEL = 3;

export interface OpponentSetup {
  name: string;
  /** 'random' picks a style when the game starts. */
  style: StyleId | 'random';
}

export interface NewGameSetup {
  mode: GameMode;
  playerName: string;
  opponents: OpponentSetup[];
  difficulty: Difficulty;
  /** Tournament: starting chips. Cash game: the buy-in. */
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  /** Tournament only (cash games always have fixed blinds). */
  structure: Structure;
  /** Tournament only: antes from level 4 when the blinds rise. */
  antes: boolean;
  /** Tournament only. */
  payout: PayoutId;
  /** Daily challenge date (YYYY-MM-DD): a fixed table and deal sequence shared by everyone. */
  daily?: string;
  /** Developer option: reproducible deck and AI randomness. Never set in normal play. */
  seed?: string;
  /** Developer option: deal the first hand from a prepared scenario (see src/dev/scenarios.ts). */
  scenario?: string;
}

export const MIN_OPPONENTS = 1;
export const MAX_OPPONENTS = 5;

export function defaultSetup(): NewGameSetup {
  return {
    mode: 'tournament',
    playerName: 'You',
    opponents: DEFAULT_PERSONAS.slice(0, 3).map((p) => ({ name: p.name, style: p.style })),
    difficulty: 'standard',
    startingStack: 1000,
    smallBlind: 25,
    bigBlind: 50,
    structure: 'standard',
    antes: true,
    payout: 'winner',
  };
}

/** Sensible starting values when switching to a cash game (100 big blinds). */
export function defaultCashSetup(from: NewGameSetup): NewGameSetup {
  return { ...structuredClone(from), mode: 'cash', smallBlind: 5, bigBlind: 10, startingStack: 1000, structure: 'fixed' };
}

/** Fills fields added in later versions so setups saved by older versions keep working. */
export function normaliseSetup(raw: NewGameSetup): NewGameSetup {
  const d = defaultSetup();
  const s = { ...raw } as Partial<NewGameSetup> & NewGameSetup;
  if (s.mode !== 'cash' && s.mode !== 'tournament') s.mode = 'tournament';
  if (typeof s.antes !== 'boolean') s.antes = false; // older games were played without antes
  if (!s.payout || !(s.payout in PAYOUTS)) s.payout = d.payout;
  return s;
}

/** Returns a player-readable problem with the setup, or null if it can be played. */
export function validateSetup(s: NewGameSetup): string | null {
  if (s.mode !== 'tournament' && s.mode !== 'cash') return 'Unknown game type.';
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
  if (!(s.payout in PAYOUTS)) return 'Unknown prize structure.';
  for (const [label, v] of [
    [s.mode === 'cash' ? 'Buy-in' : 'Starting stack', s.startingStack],
    ['Big blind', s.bigBlind],
  ] as const) {
    if (!Number.isInteger(v) || v <= 0) return `${label} must be a positive whole number.`;
  }
  if (!Number.isInteger(s.smallBlind) || s.smallBlind <= 0) return 'Small blind must be a positive whole number.';
  if (s.smallBlind > s.bigBlind) return 'The small blind cannot be larger than the big blind.';
  if (s.startingStack > 10_000_000) return s.mode === 'cash' ? 'Buy-in is too large.' : 'Starting stack is too large.';
  if (s.startingStack < s.bigBlind * 2)
    return s.mode === 'cash' ? 'The buy-in must be at least two big blinds.' : 'Starting stacks must be at least two big blinds.';
  if (s.mode === 'tournament') {
    const players = s.opponents.length + 1;
    const payout = PAYOUTS[s.payout];
    if (players < payout.minPlayers) return `"${payout.label}" needs at least ${payout.minPlayers} players.`;
  }
  return null;
}

/** Ante for a level: a tenth of the big blind, from level 4, in rising-blind tournaments. */
function withAntes(levels: BlindConfig[]): BlindConfig[] {
  return levels.map((l, i) => (i >= ANTE_FROM_LEVEL ? { ...l, ante: Math.max(1, Math.round(l.bigBlind / 10)) } : l));
}

export function gameConfigFor(s: NewGameSetup): GameConfig {
  if (s.mode === 'cash') {
    return {
      startingStack: s.startingStack,
      levels: [{ smallBlind: s.smallBlind, bigBlind: s.bigBlind, ante: 0 }],
      handsPerLevel: null,
      format: 'cash',
    };
  }
  const rising = STRUCTURES[s.structure].handsPerLevel !== null;
  const levels = buildBlindSchedule(s.smallBlind, s.bigBlind);
  return {
    startingStack: s.startingStack,
    levels: s.antes && rising ? withAntes(levels) : levels,
    handsPerLevel: STRUCTURES[s.structure].handsPerLevel,
    format: 'freezeout',
  };
}

/** Prize fractions for a tournament setup, or null for cash games. */
export function payoutsFor(s: NewGameSetup): number[] | null {
  return s.mode === 'tournament' ? [...PAYOUTS[s.payout].places] : null;
}

/** Prize points for each finishing place (index 0 = 1st). */
export function prizeTable(s: NewGameSetup): number[] {
  const payouts = payoutsFor(s);
  if (!payouts) return [];
  const pool = BUY_IN_POINTS * (s.opponents.length + 1);
  // Round down each place; the leftover from rounding goes to the winner, so prizes sum to the pool.
  const prizes = payouts.map((f) => Math.floor(pool * f));
  prizes[0]! += pool - prizes.reduce((a, b) => a + b, 0);
  return prizes;
}

// ---------------------------------------------------------------------------------------------
// Daily challenge

/** Today's date as YYYY-MM-DD in the player's own time zone. */
export function todayKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isDateKey(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * The daily challenge: one table for everyone on a given date — the same opponents, styles,
 * difficulty and deck for every hand number. Only the order of the deal is shared; what happens
 * depends on how you play.
 */
export function dailySetup(dateKey: string, playerName: string): NewGameSetup {
  const rng = new SeededRng(`velvet-daily:${dateKey}`);
  const styles = [...STYLE_ORDER];
  const opponents: OpponentSetup[] = [];
  const count = 3 + randomInt(rng, 2); // 3 or 4 opponents
  const personas = [...DEFAULT_PERSONAS];
  for (let i = 0; i < count; i++) {
    const style = styles.splice(randomInt(rng, styles.length), 1)[0]!;
    const persona = personas.splice(randomInt(rng, personas.length), 1)[0]!;
    opponents.push({ name: persona.name, style });
  }
  const name = playerName.trim() && !opponents.some((o) => o.name.toLowerCase() === playerName.trim().toLowerCase()) ? playerName.trim() : 'You';
  return {
    mode: 'tournament',
    playerName: name,
    opponents,
    difficulty: 'pro',
    startingStack: 1500,
    smallBlind: 25,
    bigBlind: 50,
    structure: 'turbo',
    antes: true,
    payout: count + 1 >= 5 ? 'top2' : 'winner',
    daily: dateKey,
    seed: `daily:${dateKey}`,
  };
}
