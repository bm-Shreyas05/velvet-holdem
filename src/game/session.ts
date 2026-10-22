import { TableGame, type GameStateData } from '../engine/game.ts';
import { CryptoRng, type Rng, SeededRng, type SeedState, isSeedState, randomInt } from '../engine/rng.ts';
import { type StatsBook, isStatsBook } from '../ai/model.ts';
import { STYLE_ORDER, type StyleId, isStyle } from '../ai/profiles.ts';
import { SCENARIOS, preparedDeck } from '../dev/scenarios.ts';
import { MAX_OPPONENTS, type NewGameSetup, gameConfigFor, normaliseSetup, validateSetup } from './config.ts';
import { type PlayerStats, emptyStats, isPlayerStats } from './stats.ts';

export interface SeatInfo {
  id: string;
  name: string;
  /** 'remote': a friend playing from their own device (online games, see src/net). */
  kind: 'human' | 'ai' | 'remote';
  style: StyleId | null;
}

/** A friend who joined an online game: seated after the host, before the AI players. */
export interface GuestSeat {
  id: string;
  name: string;
}

/** Cash games: how many times each player has bought in, and the human's cash-out. */
export interface CashState {
  buyIn: number;
  /** Buy-ins per player id, including the first. */
  buyIns: Record<string, number>;
  /** Set when the human leaves the table; the session is then over. */
  cashedOut: { stack: number; hands: number } | null;
  /** The human asked to cash out; the session ends after the hand in progress. */
  leaving?: boolean;
}

export interface AiState {
  /** 0..1 emotional state; rises after painful losses and fades over a few hands. */
  tilt: number;
  /** State of this opponent's private random stream (tie-breaks between close options). */
  rng: SeedState;
}

/** Everything needed to resume a game exactly where it was left. */
export interface SessionData {
  version: 1;
  gameId: string;
  startedAt: string;
  setup: NewGameSetup;
  seats: SeatInfo[];
  humanSeat: number;
  table: GameStateData;
  ai: Record<string, AiState>;
  /** Public statistics every player at the table could compile. The AIs learn from these. */
  statsBook: StatsBook;
  /** The human's statistics for this game. */
  playerStats: PlayerStats;
  /** Deck random stream — only for developer-seeded games; normal games use the OS CSPRNG. */
  deckRng: SeedState | null;
  humanFinish: { place: number; handNumber: number } | null;
  /** The human chose to let the AI players finish without watching. */
  spectate: 'watch' | 'skip' | null;
  /** Developer scenarios only: prepared deck orders by hand number. */
  devDecks?: Record<number, number[]>;
  /** Cash games only. */
  cash?: CashState;
}

export const SESSION_VERSION = 1;

function nextSeed(rng: Rng): SeedState {
  return [rng.nextUint32(), rng.nextUint32(), rng.nextUint32(), (rng.nextUint32() | 1) >>> 0];
}

export function createSession(setup: NewGameSetup, guests: GuestSeat[] = []): SessionData {
  const problem = validateSetup(setup) ?? validateGuests(setup, guests);
  if (problem) throw new Error(problem);
  const scenario = setup.scenario ? SCENARIOS.find((s) => s.id === setup.scenario) : undefined;
  if (setup.scenario && !scenario) throw new Error(`Unknown scenario "${setup.scenario}"`);
  if (scenario && scenario.stacks.length !== setup.opponents.length + 1) {
    throw new Error(`The "${scenario.label}" scenario needs exactly ${scenario.stacks.length - 1} opponents.`);
  }
  const seeded = (typeof setup.seed === 'string' && setup.seed.length > 0) || !!scenario;
  const master: Rng = seeded ? new SeededRng(`velvet:${setup.seed ?? setup.scenario}`) : new CryptoRng();

  const unused = [...STYLE_ORDER];
  const seats: SeatInfo[] = [{ id: 'human', name: setup.playerName.trim(), kind: 'human', style: null }];
  for (const g of guests) seats.push({ id: g.id, name: g.name.trim(), kind: 'remote', style: null });
  setup.opponents.forEach((o, i) => {
    let style: StyleId;
    if (o.style === 'random') {
      const pool = unused.length ? unused : STYLE_ORDER;
      style = pool[randomInt(master, pool.length)]!;
    } else style = o.style;
    const at = unused.indexOf(style);
    if (at >= 0) unused.splice(at, 1);
    seats.push({ id: `ai-${i + 1}`, name: o.name.trim(), kind: 'ai', style });
  });

  const firstButton = scenario ? scenario.button : randomInt(master, seats.length);
  const table = TableGame.create(
    gameConfigFor(setup),
    seats.map((s) => ({ id: s.id, name: s.name })),
    firstButton,
  );
  const tableData = table.serialize();
  let devDecks: Record<number, number[]> | undefined;
  if (scenario) {
    scenario.stacks.forEach((stack, i) => {
      tableData.players[i]!.stack = stack;
    });
    tableData.totalChips = scenario.stacks.reduce((a, b) => a + b, 0);
    devDecks = { 1: preparedDeck(seats.length, scenario.button, scenario.holes, scenario.board) };
  }
  const ai: Record<string, AiState> = {};
  for (const s of seats) if (s.kind === 'ai') ai[s.id] = { tilt: 0, rng: nextSeed(master) };
  const cash: CashState | undefined =
    setup.mode === 'cash' ? { buyIn: setup.startingStack, buyIns: Object.fromEntries(seats.map((s) => [s.id, 1])), cashedOut: null } : undefined;

  return {
    version: SESSION_VERSION,
    gameId: nextSeed(master)
      .map((x) => x.toString(36))
      .join(''),
    startedAt: new Date().toISOString(),
    setup: structuredClone(setup),
    seats,
    humanSeat: 0,
    table: tableData,
    ai,
    statsBook: {},
    playerStats: emptyStats(),
    deckRng: seeded ? nextSeed(master) : null,
    humanFinish: null,
    spectate: null,
    ...(devDecks ? { devDecks } : {}),
    ...(cash ? { cash } : {}),
  };
}

/** Online games: every friend needs a unique name and a seat (nine players at most, AI included). */
export function validateGuests(setup: NewGameSetup, guests: GuestSeat[]): string | null {
  if (guests.length !== (setup.guests ?? 0)) return 'The setup does not match the players who joined.';
  if (!guests.length) return null;
  if (guests.length + setup.opponents.length > MAX_OPPONENTS) return `A table seats at most ${MAX_OPPONENTS + 1} players.`;
  const names = new Set([setup.playerName, ...setup.opponents.map((o) => o.name)].map((n) => n.trim().toLowerCase()));
  const ids = new Set<string>();
  for (const g of guests) {
    const n = g.name.trim();
    if (!n || n.length > 24) return 'Every player needs a name of at most 24 characters.';
    if (names.has(n.toLowerCase())) return `The name "${n}" is used twice.`;
    if (!/^guest-\w+$/.test(g.id) || ids.has(g.id)) return 'Damaged player list.';
    names.add(n.toLowerCase());
    ids.add(g.id);
  }
  return null;
}

/** Fills fields added in later versions (saves from older versions keep loading). */
export function normaliseSession(s: SessionData): SessionData {
  s.setup = normaliseSetup(s.setup);
  return s;
}

/** Structural validation of a loaded session; deep poker invariants are checked on restore. */
export function validateSession(value: unknown): string | null {
  const s = value as SessionData;
  if (!s || typeof s !== 'object') return 'not a saved game';
  if (s.version !== SESSION_VERSION) return 'unsupported saved-game version';
  if (!Array.isArray(s.seats) || s.seats.length < 2) return 'missing players';
  for (const seat of s.seats) {
    if (!seat || typeof seat.id !== 'string' || typeof seat.name !== 'string') return 'damaged player list';
    if (seat.kind === 'ai' && !isStyle(seat.style)) return 'unknown opponent style';
  }
  if (!Number.isInteger(s.humanSeat) || s.seats[s.humanSeat]?.kind !== 'human') return 'missing human player';
  if (!s.table || !s.setup) return 'missing table state';
  if (s.setup.mode === 'cash') {
    const c = s.cash;
    if (!c || !Number.isInteger(c.buyIn) || c.buyIn <= 0 || !c.buyIns || typeof c.buyIns !== 'object') return 'damaged cash-game state';
    if (s.seats.some((seat) => !Number.isInteger(c.buyIns[seat.id]) || c.buyIns[seat.id]! < 1)) return 'damaged cash-game state';
  }
  if (!isStatsBook(s.statsBook)) return 'damaged opponent notes';
  if (!isPlayerStats(s.playerStats)) return 'damaged statistics';
  for (const seat of s.seats) {
    if (seat.kind !== 'ai') continue;
    const st = s.ai?.[seat.id];
    if (!st || typeof st.tilt !== 'number' || !isSeedState(st.rng)) return 'damaged opponent state';
  }
  if (s.deckRng !== null && !isSeedState(s.deckRng)) return 'damaged random state';
  try {
    TableGame.restore(s.table);
  } catch (e) {
    return e instanceof Error ? e.message : 'damaged table';
  }
  return null;
}

export { nextSeed };
