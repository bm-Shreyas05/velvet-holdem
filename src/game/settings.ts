/** Player preferences. Everything here is exposed in the Settings screen and takes effect immediately. */
export type Speed = 'relaxed' | 'normal' | 'fast' | 'turbo';
export type MotionPreference = 'system' | 'reduced' | 'full';
export type ThemePreference = 'system' | 'dark' | 'light';
export type Felt = 'emerald' | 'navy' | 'claret';
export type CardBack = 'claret' | 'midnight';

export interface Settings {
  version: 1;
  audio: {
    muted: boolean;
    master: number;
    effects: number;
    interface: number;
    ambience: number;
  };
  display: {
    theme: ThemePreference;
    uiScale: number;
    felt: Felt;
    cardBack: CardBack;
    fourColorDeck: boolean;
    highContrast: boolean;
  };
  gameplay: {
    speed: Speed;
    showHandStrength: boolean;
    showPotOdds: boolean;
    /** Show your cards at showdown even when beaten (off = muck losing hands like most players). */
    alwaysShowCards: boolean;
    confirmAllIn: boolean;
    autoContinue: boolean;
  };
  accessibility: {
    motion: MotionPreference;
    announceActions: boolean;
  };
}

export const UI_SCALES = [0.9, 1, 1.15, 1.3] as const;

export function defaultSettings(): Settings {
  return {
    version: 1,
    audio: { muted: false, master: 0.8, effects: 0.8, interface: 0.5, ambience: 0.25 },
    display: { theme: 'system', uiScale: 1, felt: 'emerald', cardBack: 'claret', fourColorDeck: false, highContrast: false },
    gameplay: { speed: 'normal', showHandStrength: true, showPotOdds: true, alwaysShowCards: false, confirmAllIn: false, autoContinue: true },
    accessibility: { motion: 'system', announceActions: true },
  };
}

const unit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const oneOf = <T extends string>(v: unknown, options: readonly T[]): v is T => typeof v === 'string' && (options as readonly string[]).includes(v);

/** Fills missing or invalid fields with defaults so an old or hand-edited file never breaks the game. */
export function normaliseSettings(raw: unknown): Settings {
  const d = defaultSettings();
  const r = (raw ?? {}) as Partial<Settings>;
  const a = (r.audio ?? {}) as Partial<Settings['audio']>;
  const disp = (r.display ?? {}) as Partial<Settings['display']>;
  const g = (r.gameplay ?? {}) as Partial<Settings['gameplay']>;
  const acc = (r.accessibility ?? {}) as Partial<Settings['accessibility']>;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    version: 1,
    audio: {
      muted: bool(a.muted, d.audio.muted),
      master: unit(a.master) ? a.master! : d.audio.master,
      effects: unit(a.effects) ? a.effects! : d.audio.effects,
      interface: unit(a.interface) ? a.interface! : d.audio.interface,
      ambience: unit(a.ambience) ? a.ambience! : d.audio.ambience,
    },
    display: {
      theme: oneOf(disp.theme, ['system', 'dark', 'light'] as const) ? disp.theme : d.display.theme,
      uiScale: (UI_SCALES as readonly number[]).includes(disp.uiScale as number) ? disp.uiScale! : d.display.uiScale,
      felt: oneOf(disp.felt, ['emerald', 'navy', 'claret'] as const) ? disp.felt : d.display.felt,
      cardBack: oneOf(disp.cardBack, ['claret', 'midnight'] as const) ? disp.cardBack : d.display.cardBack,
      fourColorDeck: bool(disp.fourColorDeck, d.display.fourColorDeck),
      highContrast: bool(disp.highContrast, d.display.highContrast),
    },
    gameplay: {
      speed: oneOf(g.speed, ['relaxed', 'normal', 'fast', 'turbo'] as const) ? g.speed : d.gameplay.speed,
      showHandStrength: bool(g.showHandStrength, d.gameplay.showHandStrength),
      showPotOdds: bool(g.showPotOdds, d.gameplay.showPotOdds),
      alwaysShowCards: bool(g.alwaysShowCards, d.gameplay.alwaysShowCards),
      confirmAllIn: bool(g.confirmAllIn, d.gameplay.confirmAllIn),
      autoContinue: bool(g.autoContinue, d.gameplay.autoContinue),
    },
    accessibility: {
      motion: oneOf(acc.motion, ['system', 'reduced', 'full'] as const) ? acc.motion : d.accessibility.motion,
      announceActions: bool(acc.announceActions, d.accessibility.announceActions),
    },
  };
}

/** Animation and pacing multipliers for each speed. */
export const SPEEDS: Record<Speed, { label: string; animation: number; think: number; pause: number }> = {
  relaxed: { label: 'Relaxed', animation: 1.35, think: 1.4, pause: 1.5 },
  normal: { label: 'Normal', animation: 1, think: 1, pause: 1 },
  fast: { label: 'Fast', animation: 0.6, think: 0.45, pause: 0.6 },
  turbo: { label: 'Turbo', animation: 0.3, think: 0.12, pause: 0.35 },
};
