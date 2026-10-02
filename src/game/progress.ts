import { categoryOf, evaluate, HandCategory } from '../engine/evaluator.ts';
import { rankOf, suitOf } from '../engine/cards.ts';
import { emptyStats as emptyModelStats, isStatsBook, type PlayerStats as ModelStats, STAT_KEYS } from '../ai/model.ts';
import type { Difficulty } from '../ai/profiles.ts';
import type { HandHistoryRecord } from './history.ts';
import type { CardBack, Felt } from './settings.ts';

/**
 * Long-term progress that outlives any one game: daily-challenge results, achievements (and the
 * cosmetics they unlock) and the opponents' long-term read of the player.
 */
export interface DailyResult {
  place: number;
  fieldSize: number;
  hands: number;
  prize: number;
  finishedAt: string;
  /** Completed attempts on that date; only the first counts for the record and the streak. */
  attempts: number;
}

export interface ProgressData {
  version: 1;
  daily: Record<string, DailyResult>;
  /**
   * Date → id of the first game started for that day's challenge. Only that game's finish counts
   * (abandoning a bad start and trying again does not improve the record).
   */
  dailyStarted: Record<string, string>;
  /** Achievement id → when it was unlocked (ISO time). */
  achievements: Record<string, string>;
  /** Counters behind achievements that need more than one game to earn. */
  counters: { knockouts: number; reviews: number; cashHands: number; handsPlayed: number; potsWon: number; showdownsWon: number };
  /**
   * Public statistics the opponents have compiled about the player across games (the same
   * counts an AI keeps during a game). New games start from a scaled-down copy, so opponents
   * remember how you play but still update quickly when you change.
   */
  reputation: ModelStats | null;
}

export function emptyProgress(): ProgressData {
  return {
    version: 1,
    daily: {},
    dailyStarted: {},
    achievements: {},
    counters: { knockouts: 0, reviews: 0, cashHands: 0, handsPlayed: 0, potsWon: 0, showdownsWon: 0 },
    reputation: null,
  };
}

export function normaliseProgress(raw: ProgressData): ProgressData {
  const d = emptyProgress();
  const r = (raw ?? {}) as Partial<ProgressData>;
  const counters = { ...d.counters };
  for (const k of Object.keys(counters) as (keyof ProgressData['counters'])[]) {
    const v = r.counters?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) counters[k] = v;
  }
  return {
    version: 1,
    daily: r.daily && typeof r.daily === 'object' ? r.daily : {},
    dailyStarted: r.dailyStarted && typeof r.dailyStarted === 'object' ? r.dailyStarted : {},
    achievements: r.achievements && typeof r.achievements === 'object' ? r.achievements : {},
    counters,
    reputation: r.reputation && isStatsBook({ me: r.reputation }) ? r.reputation : null,
  };
}

export function validateProgress(p: unknown): string | null {
  return p && typeof p === 'object' ? null : 'not a progress file';
}

// ---------------------------------------------------------------------------------------------
// Daily challenge

/**
 * Records a finished daily challenge. Only the day's first started game sets the result; later
 * games that day count as practice attempts.
 */
export function recordDaily(p: ProgressData, date: string, gameId: string, result: Omit<DailyResult, 'attempts'>): { official: boolean } {
  const existing = p.daily[date];
  const official = !existing && p.dailyStarted[date] === gameId;
  if (official) p.daily[date] = { ...result, attempts: 1 };
  else if (existing) existing.attempts++;
  return { official };
}

function previousDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Consecutive days with a completed daily challenge, ending today (or yesterday, if today is not played yet). */
export function dailyStreak(p: ProgressData, today: string): number {
  let day = p.daily[today] ? today : previousDay(today);
  let streak = 0;
  while (p.daily[day]) {
    streak++;
    day = previousDay(day);
  }
  return streak;
}

export function dailyShareText(date: string, r: DailyResult, streak: number, url: string): string {
  const medal = r.place === 1 ? '🏆' : r.prize > 0 ? '💰' : '🃏';
  const placing = r.place === 1 ? `won in ${r.hands} hands` : `finished ${ordinalText(r.place)} of ${r.fieldSize} after ${r.hands} hands`;
  return `Velvet Hold'em daily ${date}: ${placing} ${medal}${streak > 1 ? ` · ${streak}-day streak` : ''}\n${url}`;
}

function ordinalText(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]!);
}

// ---------------------------------------------------------------------------------------------
// Achievements

export type AchievementId =
  | 'first-hand'
  | 'first-pot'
  | 'big-pot'
  | 'hammer'
  | 'quads'
  | 'straight-flush'
  | 'royal'
  | 'showdowns-25'
  | 'champion'
  | 'champion-pro'
  | 'champion-elite'
  | 'full-table'
  | 'itm'
  | 'bubble'
  | 'double-ko'
  | 'eliminator'
  | 'cash-profit'
  | 'grinder'
  | 'daily'
  | 'daily-win'
  | 'streak-3'
  | 'streak-7'
  | 'student'
  | 'marathon';

export interface Achievement {
  id: AchievementId;
  title: string;
  description: string;
  /** Cosmetic unlocked by earning it. */
  unlocks?: { felt?: Felt; cardBack?: CardBack };
  /** Shown as "???" until earned. */
  secret?: boolean;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-hand', title: 'Shuffle up and deal', description: 'Play your first hand.' },
  { id: 'first-pot', title: 'First blood', description: 'Win a pot.' },
  { id: 'big-pot', title: 'Monster pot', description: 'Win a pot of at least 100 big blinds.' },
  { id: 'hammer', title: 'The hammer', description: 'Win a pot holding seven-deuce offsuit.', secret: true },
  { id: 'quads', title: 'Four of a kind', description: 'Win a showdown with four of a kind or better.' },
  { id: 'straight-flush', title: 'Straight flush', description: 'Win a showdown with a straight flush.' },
  { id: 'royal', title: 'Royalty', description: 'Win a showdown with a royal flush.', secret: true },
  { id: 'showdowns-25', title: 'Card reader', description: 'Win 25 showdowns.' },
  { id: 'champion', title: 'Champion', description: 'Win a tournament.', unlocks: { felt: 'royal' } },
  { id: 'champion-pro', title: 'Professional', description: 'Win a tournament against Pro opponents.' },
  { id: 'champion-elite', title: 'Elite', description: 'Win a tournament against Elite opponents.', unlocks: { felt: 'midnight' } },
  { id: 'full-table', title: 'Last one standing', description: 'Win a tournament against five opponents.' },
  { id: 'itm', title: 'In the money', description: 'Finish in a paid place of a tournament that pays more than first.', unlocks: { cardBack: 'emerald' } },
  { id: 'bubble', title: 'So close', description: 'Finish one place short of the prizes.', secret: true },
  { id: 'double-ko', title: 'Two for one', description: 'Knock out two players in the same hand.' },
  { id: 'eliminator', title: 'Eliminator', description: 'Knock out 10 players in all.' },
  { id: 'cash-profit', title: 'Good session', description: 'Cash out at least 50 big blinds ahead.' },
  { id: 'grinder', title: 'Grinder', description: 'Play 500 hands of cash games.', unlocks: { cardBack: 'onyx' } },
  { id: 'daily', title: 'Daily player', description: 'Finish a daily challenge.' },
  { id: 'daily-win', title: 'Daily champion', description: 'Win a daily challenge on your first try.' },
  { id: 'streak-3', title: 'Habit forming', description: 'Finish the daily challenge three days in a row.', unlocks: { felt: 'teal' } },
  { id: 'streak-7', title: 'Week of poker', description: 'Finish the daily challenge seven days in a row.' },
  { id: 'student', title: 'Student of the game', description: 'Review 10 hands with the coach.' },
  { id: 'marathon', title: 'Marathon', description: 'Play 1,000 hands.' },
];

export function achievement(id: AchievementId): Achievement {
  return ACHIEVEMENTS.find((a) => a.id === id)!;
}

/** Felts and card backs available to the player (the originals plus everything unlocked). */
export function unlockedCosmetics(p: ProgressData): { felts: Set<Felt>; cardBacks: Set<CardBack> } {
  const felts = new Set<Felt>(['emerald', 'navy', 'claret']);
  const cardBacks = new Set<CardBack>(['claret', 'midnight']);
  for (const a of ACHIEVEMENTS) {
    if (!p.achievements[a.id]) continue;
    if (a.unlocks?.felt) felts.add(a.unlocks.felt);
    if (a.unlocks?.cardBack) cardBacks.add(a.unlocks.cardBack);
  }
  return { felts, cardBacks };
}

/** Unlocks the given achievements (if new) and returns the ones that were newly earned. */
export function unlock(p: ProgressData, ids: AchievementId[], when = new Date()): Achievement[] {
  const fresh: Achievement[] = [];
  for (const id of ids) {
    if (p.achievements[id]) continue;
    p.achievements[id] = when.toISOString();
    fresh.push(achievement(id));
  }
  return fresh;
}

/** Achievements earned by one finished hand. Also advances the hand-level counters. */
export function achievementsForHand(p: ProgressData, r: HandHistoryRecord, opts: { cash: boolean; eliminatedBy: number }): AchievementId[] {
  const me = r.players.find((x) => x.seat === r.humanSeat);
  if (!me) return [];
  const ids: AchievementId[] = ['first-hand'];
  p.counters.handsPlayed++;
  if (opts.cash) p.counters.cashHands++;
  let won = 0;
  for (const pot of r.pots) for (const s of pot.shares) if (s.seat === r.humanSeat) won += s.amount;
  if (won > 0) {
    p.counters.potsWon++;
    ids.push('first-pot');
    const total = r.pots.filter((pot) => pot.shares.some((s) => s.seat === r.humanSeat)).reduce((sum, pot) => sum + pot.amount, 0);
    if (total >= 100 * r.blinds.bigBlind) ids.push('big-pot');
    if (me.cards && isSevenDeuceOffsuit(me.cards)) ids.push('hammer');
    if (r.showdown && !me.folded && me.cards && r.board.length === 5) {
      p.counters.showdownsWon++;
      const score = evaluate([...me.cards, ...r.board]);
      const cat = categoryOf(score);
      if (cat >= HandCategory.Quads) ids.push('quads');
      if (cat >= HandCategory.StraightFlush) ids.push('straight-flush');
      if (cat === HandCategory.StraightFlush && isRoyal(score)) ids.push('royal');
    }
  }
  if (opts.eliminatedBy >= 2) ids.push('double-ko');
  if (opts.eliminatedBy > 0) p.counters.knockouts += opts.eliminatedBy;
  if (p.counters.knockouts >= 10) ids.push('eliminator');
  if (p.counters.showdownsWon >= 25) ids.push('showdowns-25');
  if (p.counters.cashHands >= 500) ids.push('grinder');
  if (p.counters.handsPlayed >= 1000) ids.push('marathon');
  return ids;
}

function isSevenDeuceOffsuit(cards: number[]): boolean {
  const ranks = cards.map(rankOf).sort((a, b) => a - b);
  return ranks[0] === 0 && ranks[1] === 5 && suitOf(cards[0]!) !== suitOf(cards[1]!);
}

/** Royal flush: the straight flush whose top card is an ace (score's high nibble is the ace rank). */
function isRoyal(score: number): boolean {
  return ((score >> 16) & 0xf) === 12;
}

export function achievementsForTournament(o: { place: number; fieldSize: number; paidPlaces: number; difficulty: Difficulty }): AchievementId[] {
  const ids: AchievementId[] = [];
  if (o.place === 1) {
    ids.push('champion');
    if (o.difficulty === 'pro' || o.difficulty === 'elite') ids.push('champion-pro');
    if (o.difficulty === 'elite') ids.push('champion-elite');
    if (o.fieldSize >= 6) ids.push('full-table');
  }
  if (o.paidPlaces > 1 && o.place <= o.paidPlaces) ids.push('itm');
  if (o.paidPlaces > 1 && o.place === o.paidPlaces + 1) ids.push('bubble');
  return ids;
}

export function achievementsForDaily(p: ProgressData, today: string, result: { place: number; official: boolean }): AchievementId[] {
  if (!result.official) return [];
  const ids: AchievementId[] = ['daily'];
  if (result.place === 1) ids.push('daily-win');
  const streak = dailyStreak(p, today);
  if (streak >= 3) ids.push('streak-3');
  if (streak >= 7) ids.push('streak-7');
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Reputation: what opponents remember about the player between games

/** Hands' worth of evidence a new game starts with, so old habits inform but do not dominate. */
export const REPUTATION_HANDS = 80;

/** A scaled copy of the long-term read, to seed a new game's statistics about the player. */
export function reputationPrior(rep: ModelStats | null): ModelStats | null {
  if (!rep || rep.hands <= 0) return null;
  const f = Math.min(1, REPUTATION_HANDS / rep.hands);
  const out = emptyModelStats();
  out.hands = Math.round(rep.hands * f);
  out.aggressive = rep.aggressive * f;
  out.passive = rep.passive * f;
  for (const k of STAT_KEYS) {
    const c = rep.counters[k];
    // Lifetime counts are scaled down; the recent window (already decayed) is kept, so a change
    // of style shows up in the first hands of the next game.
    out.counters[k] = { n: c.n * f, k: c.k * f, rn: c.rn, rk: c.rk };
  }
  return out;
}
