import type { Deck } from './deck.ts';
import { HoldemHand, type HandSetup, type HandStateData } from './hand.ts';
import type { BlindConfig, HandEvent, PlayerAction } from './types.ts';

export interface GamePlayerInput {
  id: string;
  name: string;
}

export interface GameConfig {
  startingStack: number;
  /** Blind levels in order; the last level repeats forever. */
  levels: BlindConfig[];
  /** Hands per blind level, or null for fixed blinds. */
  handsPerLevel: number | null;
}

export interface GamePlayerState {
  id: string;
  name: string;
  seat: number;
  stack: number;
  eliminated: boolean;
  /** Finishing place (1 = winner) once known. */
  place: number | null;
  eliminatedOnHand: number | null;
}

export interface GameStateData {
  version: 1;
  config: GameConfig;
  players: GamePlayerState[];
  /** Number of hands started so far. */
  handNumber: number;
  /** Seat holding the button in the current/most recent hand, -1 before the first hand. */
  button: number;
  firstButton: number;
  hand: HandStateData | null;
  /** Exact setup the current/most recent hand was started from (for replay records). */
  handSetup: HandSetup | null;
  /** True once the current hand's result has been applied to the players. */
  handSettled: boolean;
  totalChips: number;
}

export interface Elimination {
  seat: number;
  id: string;
  place: number;
}

export interface HandSettlement {
  handNumber: number;
  eliminations: Elimination[];
  gameOver: boolean;
  winnerSeat: number | null;
}

/** Multipliers of the opening blinds used for rising-blind structures. */
export const BLIND_MULTIPLIERS = [1, 2, 3, 4, 6, 8, 12, 16, 20, 30, 40, 60, 80, 120, 160, 240, 320];

export function buildBlindSchedule(smallBlind: number, bigBlind: number, ante = 0): BlindConfig[] {
  return BLIND_MULTIPLIERS.map((m) => ({ smallBlind: smallBlind * m, bigBlind: bigBlind * m, ante: ante * m }));
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

export function validateGameConfig(config: GameConfig): string | null {
  if (!isPosInt(config.startingStack)) return 'Starting stack must be a positive whole number.';
  if (!Array.isArray(config.levels) || config.levels.length === 0) return 'At least one blind level is required.';
  for (const l of config.levels) {
    if (!isPosInt(l.bigBlind)) return 'Big blind must be a positive whole number.';
    if (!Number.isInteger(l.smallBlind) || l.smallBlind < 0 || l.smallBlind > l.bigBlind) {
      return 'Small blind must be between 0 and the big blind.';
    }
    if (!Number.isInteger(l.ante) || l.ante < 0) return 'Ante must be zero or a positive whole number.';
  }
  if (config.handsPerLevel !== null && !isPosInt(config.handsPerLevel)) return 'Hands per level must be a positive number.';
  if (config.levels[0]!.bigBlind > config.startingStack) return 'The starting stack must cover the big blind.';
  return null;
}

/**
 * A freeze-out at one table: players keep playing hands until one holds every chip. Handles the
 * button, blind levels, eliminations and finishing places. Poker rules for each hand live in
 * HoldemHand; this class only sequences hands.
 */
export class TableGame {
  #s: GameStateData;
  #hand: HoldemHand | null;

  private constructor(state: GameStateData, hand: HoldemHand | null) {
    this.#s = state;
    this.#hand = hand;
  }

  static create(config: GameConfig, players: GamePlayerInput[], firstButton: number): TableGame {
    const problem = validateGameConfig(config);
    if (problem) throw new Error(problem);
    if (players.length < 2 || players.length > 10) throw new Error('A game needs 2–10 players');
    if (new Set(players.map((p) => p.id)).size !== players.length) throw new Error('Player ids must be unique');
    if (!Number.isInteger(firstButton) || firstButton < 0 || firstButton >= players.length) throw new Error('Invalid button');
    const state: GameStateData = {
      version: 1,
      config: structuredClone(config),
      players: players.map((p, seat) => ({
        id: p.id,
        name: p.name,
        seat,
        stack: config.startingStack,
        eliminated: false,
        place: null,
        eliminatedOnHand: null,
      })),
      handNumber: 0,
      button: -1,
      firstButton,
      hand: null,
      handSetup: null,
      handSettled: true,
      totalChips: config.startingStack * players.length,
    };
    return new TableGame(state, null);
  }

  // -------------------------------------------------------------------------------------------

  get handNumber(): number {
    return this.#s.handNumber;
  }

  get button(): number {
    return this.#s.button;
  }

  get config(): GameConfig {
    return structuredClone(this.#s.config);
  }

  get totalChips(): number {
    return this.#s.totalChips;
  }

  /** The hand being played (or just finished). Only the controller holds this reference. */
  get hand(): HoldemHand | null {
    return this.#hand;
  }

  get handSetup(): HandSetup | null {
    return this.#s.handSetup ? structuredClone(this.#s.handSetup) : null;
  }

  get handInProgress(): boolean {
    return !!this.#hand && !this.#hand.isComplete;
  }

  get awaitingSettlement(): boolean {
    return !!this.#hand && this.#hand.isComplete && !this.#s.handSettled;
  }

  players(): GamePlayerState[] {
    return this.#s.players.map((p) => ({ ...p }));
  }

  alivePlayers(): GamePlayerState[] {
    return this.players().filter((p) => !p.eliminated);
  }

  get isOver(): boolean {
    return this.#s.players.filter((p) => !p.eliminated).length <= 1;
  }

  winner(): GamePlayerState | null {
    return this.isOver ? this.players().find((p) => !p.eliminated) ?? null : null;
  }

  levelIndexForHand(handNumber: number): number {
    const { handsPerLevel, levels } = this.#s.config;
    if (handsPerLevel === null) return 0;
    return Math.min(Math.floor((Math.max(1, handNumber) - 1) / handsPerLevel), levels.length - 1);
  }

  blindsForHand(handNumber: number): BlindConfig {
    return { ...this.#s.config.levels[this.levelIndexForHand(handNumber)]! };
  }

  /** Hands remaining at the current level before blinds go up, or null if they never rise. */
  handsUntilNextLevel(): number | null {
    const { handsPerLevel, levels } = this.#s.config;
    if (handsPerLevel === null) return null;
    const upcoming = this.#s.handSettled ? this.#s.handNumber + 1 : this.#s.handNumber;
    const idx = this.levelIndexForHand(upcoming);
    if (idx >= levels.length - 1) return null;
    return (idx + 1) * handsPerLevel - upcoming + 1;
  }

  #nextAliveSeat(from: number): number {
    const n = this.#s.players.length;
    for (let k = 1; k <= n; k++) {
      const seat = (from + k) % n;
      if (!this.#s.players[seat]!.eliminated) return seat;
    }
    throw new Error('No players remain');
  }

  /** Seat that will hold the button for the next hand. */
  nextButton(): number {
    if (this.#s.button < 0) {
      const first = this.#s.firstButton;
      return this.#s.players[first]!.eliminated ? this.#nextAliveSeat(first) : first;
    }
    return this.#nextAliveSeat(this.#s.button);
  }

  // -------------------------------------------------------------------------------------------

  startHand(deck: Deck, options: { alwaysShow?: number[] } = {}): HandEvent[] {
    if (this.isOver) throw new Error('The game is over');
    if (!this.#s.handSettled) throw new Error('The previous hand has not been settled');
    const handNumber = this.#s.handNumber + 1;
    const button = this.nextButton();
    const setup: HandSetup = {
      handNumber,
      seats: this.#s.players.map((p) => (p.eliminated ? null : { id: p.id, stack: p.stack })),
      button,
      blinds: this.blindsForHand(handNumber),
      alwaysShow: options.alwaysShow ?? [],
    };
    const { hand, events } = HoldemHand.start(structuredClone(setup), deck);
    this.#hand = hand;
    this.#s.handSetup = setup;
    this.#s.handNumber = handNumber;
    this.#s.button = button;
    this.#s.handSettled = false;
    return events;
  }

  act(seat: number, action: PlayerAction): HandEvent[] {
    if (!this.#hand || this.#hand.isComplete) throw new Error('No hand in progress');
    return this.#hand.act(seat, action);
  }

  /** Applies a completed hand: stacks, eliminations and finishing places. */
  settleHand(): HandSettlement {
    const hand = this.#hand;
    if (!hand || !hand.isComplete) throw new Error('No completed hand to settle');
    if (this.#s.handSettled) throw new Error('Hand already settled');
    const result = hand.result!;
    const aliveBefore = this.#s.players.filter((p) => !p.eliminated).length;
    const busted: { player: GamePlayerState; startStack: number }[] = [];
    for (const p of this.#s.players) {
      if (p.eliminated) continue;
      const startStack = p.stack;
      p.stack = result.finalStacks[p.seat]!;
      if (p.stack === 0) busted.push({ player: p, startStack });
    }

    // Players busting in the same hand: more chips at the start of the hand finishes higher;
    // equal starting stacks share the better place.
    busted.sort((a, b) => b.startStack - a.startStack);
    const eliminations: Elimination[] = [];
    let place = aliveBefore - busted.length + 1;
    busted.forEach((b, i) => {
      if (i > 0 && b.startStack !== busted[i - 1]!.startStack) place = aliveBefore - busted.length + 1 + i;
      b.player.eliminated = true;
      b.player.place = place;
      b.player.eliminatedOnHand = this.#s.handNumber;
      eliminations.push({ seat: b.player.seat, id: b.player.id, place });
    });

    this.#s.handSettled = true;
    let winnerSeat: number | null = null;
    const alive = this.#s.players.filter((p) => !p.eliminated);
    if (alive.length === 1) {
      alive[0]!.place = 1;
      winnerSeat = alive[0]!.seat;
    }
    return { handNumber: this.#s.handNumber, eliminations, gameOver: alive.length <= 1, winnerSeat };
  }

  checkInvariants(): string[] {
    const problems: string[] = [];
    const s = this.#s;
    let total = 0;
    for (const p of s.players) {
      if (!Number.isInteger(p.stack) || p.stack < 0) problems.push(`${p.name}: invalid stack ${p.stack}`);
      if (p.eliminated && p.stack !== 0 && s.handSettled) problems.push(`${p.name}: eliminated with chips`);
      if (!p.eliminated && p.stack === 0 && s.handSettled) problems.push(`${p.name}: no chips but not eliminated`);
    }
    if (this.#hand && !s.handSettled) {
      problems.push(...this.#hand.checkInvariants().map((m) => `hand: ${m}`));
      const view = this.#hand.viewFor(null);
      total = view.seats.reduce((sum, x) => sum + x.stack, 0) + (view.phase === 'complete' ? 0 : view.pot);
      // Eliminated players hold nothing, so the hand's chips are the whole table's chips.
    } else {
      total = s.players.reduce((sum, p) => sum + p.stack, 0);
    }
    if (total !== s.totalChips) problems.push(`table chips ${total} ≠ ${s.totalChips}`);
    return problems;
  }

  serialize(): GameStateData {
    const data = structuredClone(this.#s);
    data.hand = this.#hand ? this.#hand.serialize() : null;
    return data;
  }

  static restore(data: GameStateData): TableGame {
    if (!data || data.version !== 1 || !Array.isArray(data.players) || !data.config) throw new Error('Unrecognised game data');
    const problem = validateGameConfig(data.config);
    if (problem) throw new Error(`Saved game has an invalid configuration: ${problem}`);
    const copy = structuredClone(data);
    copy.handSetup ??= null;
    const hand = copy.hand ? HoldemHand.restore(copy.hand) : null;
    const game = new TableGame(copy, hand);
    const problems = game.checkInvariants();
    if (problems.length) throw new Error(`Saved game failed integrity checks: ${problems.join('; ')}`);
    return game;
  }
}
