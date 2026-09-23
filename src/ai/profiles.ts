/**
 * Opponent identities and difficulty levels.
 *
 * A personality never scripts actions. It biases how the shared decision engine values its
 * options (e.g. a loose player puts a premium on seeing flops, a sticky player on calling) and
 * how much it trusts what it has observed. Difficulty controls the engine's sophistication:
 * simulation precision, how carefully it reads opponents' ranges, whether it uses its reads,
 * and how consistently it picks its best option.
 */
export type StyleId = 'rock' | 'shark' | 'maniac' | 'station' | 'trapper';

export interface PersonalityProfile {
  style: StyleId;
  label: string;
  blurb: string;
  /** −1..1: premium on playing hands preflop. */
  looseness: number;
  /** −1..1: premium on betting and raising over checking and calling. */
  aggression: number;
  /** −1..1: optimism about getting folds. */
  bluffing: number;
  /** −1..1: reluctance to fold once invested. */
  stickiness: number;
  /** 0..1: willingness to slow-play very strong hands on dry boards. */
  trappiness: number;
  /** 0..1: how much observed opponent tendencies change its play. */
  adaptivity: number;
  /** 0..1: dislike of risking a large share of its stack on marginal edges. */
  riskAversion: number;
  /** 0..1: how much big losses rattle it. */
  tiltProne: number;
  /** 0..1.2: how much it believes what opponents' bets say about their hands. */
  rangeTrust: number;
  /** Multiplier on how often it assumes opponents bluff. */
  bluffBelief: number;
}

export const STYLES: Record<StyleId, PersonalityProfile> = {
  rock: {
    style: 'rock',
    label: 'The Rock',
    blurb: 'Plays few hands and rarely bluffs. When the Rock bets, believe it.',
    looseness: -0.75,
    aggression: 0.05,
    bluffing: -0.6,
    stickiness: -0.3,
    trappiness: 0.2,
    adaptivity: 0.45,
    riskAversion: 0.6,
    tiltProne: 0.1,
    rangeTrust: 1.15,
    bluffBelief: 0.5,
  },
  shark: {
    style: 'shark',
    label: 'The Shark',
    blurb: 'Patient and balanced. Studies your habits and adjusts to them.',
    looseness: -0.15,
    aggression: 0.35,
    bluffing: 0.1,
    stickiness: -0.1,
    trappiness: 0.3,
    adaptivity: 1,
    riskAversion: 0.25,
    tiltProne: 0,
    rangeTrust: 1,
    bluffBelief: 1,
  },
  maniac: {
    style: 'maniac',
    label: 'The Maniac',
    blurb: 'Raises constantly and loves to put you to a decision for all your chips.',
    looseness: 0.6,
    aggression: 0.85,
    bluffing: 0.6,
    stickiness: 0.1,
    trappiness: 0.05,
    adaptivity: 0.45,
    riskAversion: 0.05,
    tiltProne: 0.45,
    rangeTrust: 0.6,
    bluffBelief: 1.4,
  },
  station: {
    style: 'station',
    label: 'The Station',
    blurb: 'Hates folding. Will pay you off with second pair — and bluffing rarely works.',
    looseness: 0.55,
    aggression: -0.55,
    bluffing: -0.5,
    stickiness: 0.85,
    trappiness: 0.15,
    adaptivity: 0.2,
    riskAversion: 0.2,
    tiltProne: 0.3,
    rangeTrust: 0.3,
    bluffBelief: 1.8,
  },
  trapper: {
    style: 'trapper',
    label: 'The Trapper',
    blurb: 'Slow-plays monsters and check-raises when you least expect it.',
    looseness: 0,
    aggression: 0.15,
    bluffing: 0.2,
    stickiness: 0.05,
    trappiness: 0.8,
    adaptivity: 0.7,
    riskAversion: 0.3,
    tiltProne: 0.15,
    rangeTrust: 0.9,
    bluffBelief: 1.1,
  },
};

export const STYLE_ORDER: StyleId[] = ['shark', 'maniac', 'rock', 'trapper', 'station'];

export interface OpponentPersona {
  name: string;
  style: StyleId;
}

/** Default names; players can rename opponents in the new-game screen. */
export const DEFAULT_PERSONAS: OpponentPersona[] = [
  { name: 'Silas Crane', style: 'shark' },
  { name: 'Rico Vance', style: 'maniac' },
  { name: 'Margot Hale', style: 'rock' },
  { name: 'Nora Quill', style: 'trapper' },
  { name: 'Benny Tuck', style: 'station' },
];

export type Difficulty = 'casual' | 'standard' | 'pro' | 'elite';

export interface DifficultySettings {
  id: Difficulty;
  label: string;
  blurb: string;
  /** Monte Carlo samples per decision. */
  samples: number;
  /** 0..1: how strongly observed actions narrow an opponent's range. */
  rangeDepth: number;
  /** 0..1: how much personal reads replace population assumptions. */
  modelWeight: number;
  /** 0..1: how quickly reads follow recent changes of style. */
  recencyWeight: number;
  /** Softmax temperature in pot units: higher = less consistent choices. */
  temperature: number;
  sizing: 'basic' | 'standard' | 'full';
  /** Consider being re-raised when betting. */
  anticipatesRaises: boolean;
  /** Account for its own table image. */
  usesImage: boolean;
}

export const DIFFICULTIES: Record<Difficulty, DifficultySettings> = {
  casual: {
    id: 'casual',
    label: 'Casual',
    blurb: 'Plays its own cards, reads little into your bets and makes the occasional loose call.',
    samples: 500,
    rangeDepth: 0.3,
    modelWeight: 0,
    recencyWeight: 0,
    temperature: 0.24,
    sizing: 'basic',
    anticipatesRaises: false,
    usesImage: false,
  },
  standard: {
    id: 'standard',
    label: 'Standard',
    blurb: 'Solid fundamentals: pot odds, position and what your betting says about your hand.',
    samples: 1000,
    rangeDepth: 0.7,
    modelWeight: 0.5,
    recencyWeight: 0.3,
    temperature: 0.11,
    sizing: 'standard',
    anticipatesRaises: true,
    usesImage: false,
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    blurb: 'Tracks your tendencies, adapts when you change gears and picks bet sizes deliberately.',
    samples: 1800,
    rangeDepth: 1,
    modelWeight: 0.85,
    recencyWeight: 0.7,
    temperature: 0.06,
    sizing: 'full',
    anticipatesRaises: true,
    usesImage: true,
  },
  elite: {
    id: 'elite',
    label: 'Elite',
    blurb: 'Precise, consistent and exploitative. Same cards and information as you — just sharper.',
    samples: 3000,
    rangeDepth: 1,
    modelWeight: 1,
    recencyWeight: 1,
    temperature: 0.04,
    sizing: 'full',
    anticipatesRaises: true,
    usesImage: true,
  },
};

export const DIFFICULTY_ORDER: Difficulty[] = ['casual', 'standard', 'pro', 'elite'];

export function isDifficulty(v: unknown): v is Difficulty {
  return typeof v === 'string' && v in DIFFICULTIES;
}

export function isStyle(v: unknown): v is StyleId {
  return typeof v === 'string' && v in STYLES;
}
