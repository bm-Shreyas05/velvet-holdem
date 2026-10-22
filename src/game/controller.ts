import { Deck } from '../engine/deck.ts';
import { categoryOf, HandCategory } from '../engine/evaluator.ts';
import { TableGame, type HandSettlement } from '../engine/game.ts';
import { IllegalActionError } from '../engine/hand.ts';
import { type PublicHandRecord, publicRecordFromView } from '../engine/records.ts';
import { CryptoRng, type Rng, SeededRng } from '../engine/rng.ts';
import type { BlindConfig, HandEvent, HandView, LegalActions, PlayerAction } from '../engine/types.ts';
import { eventsVisibleTo } from '../engine/types.ts';
import type { AiHost } from '../ai/host.ts';
import { sanitizeDecision } from '../ai/host.ts';
import { safeFallbackAction } from '../ai/decide.ts';
import { observeHand } from '../ai/model.ts';
import type { StyleId } from '../ai/profiles.ts';
import { type GameMode, payoutsFor, prizeTable } from './config.ts';
import { buildHistoryRecord, type HandHistoryRecord } from './history.ts';
import { type SessionData, nextSeed } from './session.ts';
import { recordHand } from './stats.ts';

export interface SeatSnapshot {
  seat: number;
  id: string;
  name: string;
  /** Relative to the viewer: 'human' is the viewer; 'remote' is any other person at the table. */
  kind: 'human' | 'ai' | 'remote';
  style: StyleId | null;
  stack: number;
  eliminated: boolean;
  place: number | null;
}

/** What the interface draws. Built only from the human's own view and public table state. */
export interface TableSnapshot {
  handNumber: number;
  view: HandView | null;
  seats: SeatSnapshot[];
  humanSeat: number;
  blinds: BlindConfig;
  level: number;
  handsUntilNextLevel: number | null;
  nextBlinds: BlindConfig | null;
  button: number;
  seeded: boolean;
  gameOver: boolean;
  humanFinish: { place: number; handNumber: number } | null;
  mode: GameMode;
  /** Daily challenge date, if this is one. */
  daily: string | null;
  /** Tournament prize points for 1st, 2nd, … (empty in cash games). */
  prizes: number[];
  /** Cash games: the buy-in and how many times the human has bought in. */
  cash: { buyIn: number; humanBuyIns: number; leaving: boolean } | null;
  /** Other people are playing at this table from their own devices. */
  online: boolean;
}

/** Result of a cash-game session, reported when the human cashes out. */
export interface CashSummary {
  hands: number;
  buyIn: number;
  buyIns: number;
  finalStack: number;
  net: number;
  bigBlind: number;
}

export interface HandSummary {
  record: HandHistoryRecord;
  settlement: HandSettlement;
  blindsRiseNext: BlindConfig | null;
}

export interface GameOverInfo {
  winnerSeat: number;
  winnerName: string;
  humanPlace: number;
  fieldSize: number;
  hands: number;
  /** Prize points by place (index 0 = 1st). */
  prizes: number[];
  humanPrize: number;
}

export type EliminationChoice = 'watch' | 'skip' | 'menu';

/** The interface side of the game loop. A headless implementation drives tests and simulations. */
export interface Presenter {
  /** Show the table as it is right now (new game, resumed game, recovery). */
  reset(snapshot: TableSnapshot): void;
  /** Animate engine events (already filtered to what the human may see). */
  present(events: HandEvent[], snapshot: TableSnapshot): Promise<void>;
  /** Resolve with the human's chosen action. */
  requestAction(snapshot: TableSnapshot, legal: LegalActions): Promise<PlayerAction>;
  /** An AI starts (seat) or stops (null) thinking. */
  thinking(seat: number | null, snapshot: TableSnapshot): void;
  /** Present the result and resolve when the next hand may begin. */
  handFinished(summary: HandSummary, snapshot: TableSnapshot): Promise<void>;
  humanEliminated(place: number, fieldSize: number, snapshot: TableSnapshot): Promise<EliminationChoice>;
  gameOver(info: GameOverInfo, snapshot: TableSnapshot): void;
  actionRejected(message: string): void;
  notify(message: string, tone: 'info' | 'warning' | 'error'): void;
  /** Cash games: a player bought chips again. */
  rebuy?(seat: number, amount: number, snapshot: TableSnapshot): void;
  /** Cash games: the human has no chips left. */
  humanBusted?(buyIn: number, snapshot: TableSnapshot): Promise<'rebuy' | 'leave'>;
  /** Cash games: the session is over. */
  cashSessionOver?(summary: CashSummary, snapshot: TableSnapshot): void;
}

export interface ControllerHooks {
  /** Persist the session (called after every change). */
  saveSession?(session: SessionData): void;
  /** Persist a finished hand (with who was knocked out in it). */
  handRecorded?(record: HandHistoryRecord, settlement: HandSettlement): void;
  /** Everything any observer saw in a finished hand (what opponents learn from). */
  publicHandObserved?(record: PublicHandRecord): void;
  /** Human's final place in this tournament and the prize points it paid. */
  humanFinished?(place: number, fieldSize: number, prize: number): void;
  /** Cash games: the human left the table. */
  cashedOut?(summary: CashSummary): void;
  /** Milliseconds an AI should appear to think, given how close its decision was (0..1). */
  thinkTime?(closeness: number): number;
  /** Diagnostics for developers (console in the browser). */
  log?(message: string, detail?: unknown): void;
  /** Seats that always table their cards at showdown (the human's "always show" preference). */
  alwaysShowSeats?(): number[];
}

class StopSignal extends Error {}

/**
 * Runs a game: deals hands, asks the human or the AI for decisions, applies them through the
 * engine, verifies every invariant after every action, and records results. The controller is
 * the only holder of the engine objects; the interface and the AI receive views.
 *
 * Online games add remote seats, each with its own presenter (src/net/remote.ts) that receives
 * exactly what that player may see, built from their own view. The local presenter paces the
 * game; remote presenters are told what happened without being waited for, except for their
 * own decisions.
 */
export class GameController {
  readonly #session: SessionData;
  readonly #presenter: Presenter;
  readonly #remotes: ReadonlyMap<number, Presenter>;
  /** Where each remote player finished (the local human's is in the session). */
  readonly #finishes = new Map<number, { place: number; handNumber: number }>();
  readonly #ai: AiHost;
  readonly #hooks: ControllerHooks;
  #table: TableGame;
  #deckRng: Rng;
  #aiRngs = new Map<string, SeededRng>();
  #stopped = false;
  #paused = false;
  #resumeWaiters: (() => void)[] = [];
  #hurry: (() => void) | null = null;
  #fastForward = false;
  /** Table state at the start of the current hand, used to recover from an integrity failure. */
  #checkpoint: SessionData['table'] | null = null;
  #running = false;
  /** Events of a freshly dealt hand, presented on the next loop turn (after the save). */
  #pendingEvents: HandEvent[] | null = null;

  constructor(session: SessionData, presenter: Presenter, ai: AiHost, hooks: ControllerHooks = {}, remotes: ReadonlyMap<number, Presenter> = new Map()) {
    this.#session = session;
    this.#presenter = presenter;
    this.#remotes = remotes;
    for (const p of session.table.players) if (p.place !== null && p.seat !== session.humanSeat) this.#finishes.set(p.seat, { place: p.place, handNumber: 0 });
    this.#ai = ai;
    this.#hooks = hooks;
    this.#table = TableGame.restore(session.table);
    this.#deckRng = session.deckRng ? SeededRng.fromState(session.deckRng) : new CryptoRng();
    for (const [id, st] of Object.entries(session.ai)) this.#aiRngs.set(id, SeededRng.fromState(st.rng));
    this.#fastForward = session.spectate === 'skip';
    if (!this.#table.handInProgress) this.#checkpoint = this.#table.serialize();
  }

  get session(): SessionData {
    this.#syncSession();
    return this.#session;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get running(): boolean {
    return this.#running;
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
    const waiters = this.#resumeWaiters;
    this.#resumeWaiters = [];
    for (const w of waiters) w();
  }

  /** Skip the remaining artificial delay (AI thinking pause). */
  hurry(): void {
    this.#hurry?.();
  }

  stop(): void {
    this.#stopped = true;
    this.resume();
    this.#hurry?.();
  }

  // -------------------------------------------------------------------------------------------

  snapshot(): TableSnapshot {
    return this.snapshotFor(this.#session.humanSeat);
  }

  /** The table as one player sees it: their own view, and seat kinds relative to them. */
  snapshotFor(viewer: number): TableSnapshot {
    const t = this.#table;
    const hand = t.hand;
    const handNumber = hand ? t.handNumber : t.handNumber + 1;
    const levelIdx = t.levelIndexForHand(t.handInProgress || t.awaitingSettlement ? t.handNumber : t.handNumber + 1);
    const levels = t.config.levels;
    const view = hand ? hand.viewFor(viewer) : null;
    const handLive = !!view && (t.handInProgress || t.awaitingSettlement);
    return {
      handNumber,
      view,
      seats: t.players().map((p) => {
        const info = this.#session.seats[p.seat]!;
        const seatView = view?.seats[p.seat];
        return {
          seat: p.seat,
          id: p.id,
          name: info.name,
          kind: p.seat === viewer ? 'human' : info.kind === 'ai' ? 'ai' : 'remote',
          style: info.style,
          stack: handLive && seatView?.inHand ? seatView.stack : p.stack,
          eliminated: p.eliminated,
          place: p.place,
        };
      }),
      humanSeat: viewer,
      blinds: view ? { ...view.blinds } : t.blindsForHand(t.handNumber + 1),
      level: levelIdx + 1,
      handsUntilNextLevel: t.handsUntilNextLevel(),
      nextBlinds: levelIdx + 1 < levels.length && t.config.handsPerLevel !== null ? { ...levels[levelIdx + 1]! } : null,
      button: hand ? t.button : t.isOver ? t.button : t.nextButton(),
      seeded: this.#session.deckRng !== null && !this.#session.setup.daily,
      gameOver: t.isOver,
      humanFinish: viewer === this.#session.humanSeat ? this.#session.humanFinish : (this.#finishes.get(viewer) ?? null),
      mode: this.#session.setup.mode,
      daily: this.#session.setup.daily ?? null,
      prizes: prizeTable(this.#session.setup),
      cash: this.#session.cash
        ? {
            buyIn: this.#session.cash.buyIn,
            humanBuyIns: this.#session.cash.buyIns[this.#session.seats[viewer]!.id] ?? 1,
            leaving: !!this.#session.cash.leaving,
          }
        : null,
      online: this.#remotes.size > 0,
    };
  }

  /** Tells every remote player something, each from their own seat. Never waits for them. */
  #toRemotes(call: (remote: Presenter, seat: number) => unknown): void {
    for (const [seat, remote] of this.#remotes) {
      try {
        const result = call(remote, seat);
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        /* a remote player's connection never stops the game */
      }
    }
  }

  #thinking(seat: number | null): void {
    if (!this.#fastForward) this.#presenter.thinking(seat, this.snapshot());
    this.#toRemotes((r, s) => r.thinking(seat === s ? null : seat, this.snapshotFor(s)));
  }

  /** True once there is nothing left to play (tournament over, or cash game cashed out). */
  get finished(): boolean {
    return !!this.#session.cash?.cashedOut || this.#table.isOver;
  }

  /**
   * Cash games: leave the table. Between hands this happens at once; during a hand the human
   * finishes it first (chips in the pot cannot be taken off the table).
   */
  requestCashOut(): 'now' | 'after-hand' | 'not-cash' {
    const cash = this.#session.cash;
    if (!cash || cash.cashedOut) return 'not-cash';
    cash.leaving = true;
    this.#save();
    if (this.#table.handInProgress || this.#table.awaitingSettlement) return 'after-hand';
    if (this.#running) this.resume();
    else this.#cashOut();
    return 'now';
  }

  #syncSession(): void {
    this.#session.table = this.#table.serialize();
    for (const [id, rng] of this.#aiRngs) this.#session.ai[id]!.rng = rng.state();
    if (this.#deckRng instanceof SeededRng) this.#session.deckRng = this.#deckRng.state();
  }

  #save(): void {
    this.#syncSession();
    this.#hooks.saveSession?.(this.#session);
  }

  async #gate(): Promise<void> {
    if (this.#stopped) throw new StopSignal();
    if (!this.#paused) return;
    await new Promise<void>((resolve) => this.#resumeWaiters.push(resolve));
    if (this.#stopped) throw new StopSignal();
  }

  async #wait(ms: number): Promise<void> {
    if (ms <= 0 || this.#fastForward) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.#hurry = done;
    });
    this.#hurry = null;
  }

  async #present(events: HandEvent[]): Promise<void> {
    this.#toRemotes((r, s) => {
      const visible = eventsVisibleTo(events, s);
      return visible.length ? r.present(visible, this.snapshotFor(s)) : undefined;
    });
    if (this.#fastForward) return;
    const visible = eventsVisibleTo(events, this.#session.humanSeat);
    if (visible.length) await this.#presenter.present(visible, this.snapshot());
  }

  // -------------------------------------------------------------------------------------------

  /** Plays until the game ends or stop() is called. */
  async run(): Promise<void> {
    if (this.#running) throw new Error('Controller already running');
    this.#running = true;
    try {
      this.#presenter.reset(this.snapshot());
      this.#toRemotes((r, s) => r.reset(this.snapshotFor(s)));
      while (!this.#stopped) {
        if (this.#table.awaitingSettlement) {
          await this.#finishHand();
          continue;
        }
        if (this.#table.isOver) {
          this.#announceGameOver();
          break;
        }
        if (!this.#table.handInProgress) {
          if (this.#table.isCash && this.#session.cash?.cashedOut) break;
          if (!this.#session.cash?.leaving) await this.#gate();
          if (this.#table.isCash) {
            if (this.#session.cash?.leaving) {
              this.#cashOut();
              break;
            }
            if (!(await this.#settleBuyIns())) break;
          }
          this.#startHand();
          continue;
        }
        await this.#playTurn();
      }
    } catch (error) {
      if (!(error instanceof StopSignal)) {
        this.#hooks.log?.('Game loop failed', error);
        this.#presenter.notify('Something went wrong and the game was paused. Your progress up to the last hand is saved.', 'error');
        throw error;
      }
    } finally {
      this.#running = false;
      if (!this.#stopped) this.#save();
    }
  }

  #startHand(): void {
    this.#checkpoint = this.#table.serialize();
    const prepared = this.#session.devDecks?.[this.#table.handNumber + 1];
    const deck = prepared ? new Deck(prepared) : Deck.shuffled(this.#deckRng);
    const events = this.#table.startHand(deck, { alwaysShow: this.#hooks.alwaysShowSeats?.() ?? [] });
    this.#verify();
    this.#save();
    // Presentation happens after the save so a crash mid-animation resumes the same hand.
    this.#pendingEvents = events;
  }

  async #playTurn(): Promise<void> {
    if (this.#pendingEvents) {
      const events = this.#pendingEvents;
      this.#pendingEvents = null;
      await this.#present(events);
    }
    await this.#gate();
    const hand = this.#table.hand!;
    if (hand.isComplete) return;
    const seat = hand.toAct!;
    const info = this.#session.seats[seat]!;
    let action: PlayerAction;
    if (info.kind === 'human') {
      const snap = this.snapshot();
      try {
        action = await this.#presenter.requestAction(snap, snap.view!.legal!);
      } catch (error) {
        if (this.#stopped) throw new StopSignal();
        throw error;
      }
      if (this.#stopped) throw new StopSignal();
      try {
        hand.validate(seat, action);
      } catch (error) {
        if (error instanceof IllegalActionError) {
          this.#presenter.actionRejected(error.message);
          return;
        }
        throw error;
      }
    } else if (info.kind === 'remote') {
      const remote = this.#remotes.get(seat);
      const snap = this.snapshotFor(seat);
      if (!remote) {
        // Nobody is connected for this seat (it can only happen to a resumed online game): sit out.
        action = safeFallbackAction(snap.view!.legal!);
      } else {
        this.#thinking(seat);
        action = await remote.requestAction(snap, snap.view!.legal!);
        if (this.#stopped) throw new StopSignal();
        this.#thinking(null);
        try {
          hand.validate(seat, action);
        } catch (error) {
          if (error instanceof IllegalActionError) {
            remote.actionRejected(error.message);
            return;
          }
          throw error;
        }
      }
      await this.#gate();
    } else {
      action = await this.#aiAction(seat);
      await this.#gate();
    }
    const events = this.#table.act(seat, action);
    if (!this.#verify()) return;
    this.#save();
    await this.#present(events);
  }

  async #aiAction(seat: number): Promise<PlayerAction> {
    const hand = this.#table.hand!;
    const info = this.#session.seats[seat]!;
    const view = hand.viewFor(seat);
    const legal = view.legal!;
    const rng = this.#aiRngs.get(info.id)!;
    const tableIds = new Set(this.#session.seats.map((s) => s.id));
    const stats = Object.fromEntries(Object.entries(this.#session.statsBook).filter(([id]) => tableIds.has(id)));
    this.#thinking(seat);
    const started = Date.now();
    let action: PlayerAction;
    let closeness = 0.3;
    try {
      const payouts = payoutsFor(this.#session.setup);
      const decision = await this.#ai.decide({
        view,
        style: info.style!,
        difficulty: this.#session.setup.difficulty,
        stats,
        tilt: this.#session.ai[info.id]!.tilt,
        seed: nextSeed(rng),
        ...(payouts && payouts.length > 1 ? { payouts } : {}),
      });
      action = sanitizeDecision(decision.action, legal);
      closeness = decision.difficulty;
    } catch (error) {
      this.#hooks.log?.(`AI decision failed for ${info.name}; using a safe action`, error);
      action = safeFallbackAction(legal);
    }
    const target = this.#hooks.thinkTime?.(closeness) ?? 0;
    await this.#wait(target - (Date.now() - started));
    this.#thinking(null);
    return action;
  }

  /** Checks every invariant; on failure rolls the table back to the start of the hand. */
  #verify(): boolean {
    const problems = this.#table.checkInvariants();
    if (!problems.length) return true;
    this.#hooks.log?.('Integrity check failed — restoring the start of the hand', { problems, hand: this.#table.hand?.serialize() });
    if (this.#checkpoint) {
      this.#table = TableGame.restore(this.#checkpoint);
      this.#pendingEvents = null;
      this.#save();
      const message = 'A problem was detected with that hand, so it was cancelled and all chips were returned.';
      this.#presenter.notify(message, 'error');
      this.#presenter.reset(this.snapshot());
      this.#toRemotes((r, s) => {
        r.notify(message, 'error');
        r.reset(this.snapshotFor(s));
      });
      return false;
    }
    throw new Error(`Game state failed integrity checks: ${problems.join('; ')}`);
  }

  async #finishHand(): Promise<void> {
    if (this.#pendingEvents) {
      await this.#present(this.#pendingEvents);
      this.#pendingEvents = null;
    }
    const hand = this.#table.hand!;
    const setup = this.#table.handSetup!;
    const names = Object.fromEntries(this.#session.seats.map((s, i) => [i, s.name]));
    const record = buildHistoryRecord(hand, setup, names, this.#session.humanSeat);
    const publicView = hand.viewFor(null);
    const publicRecord = publicRecordFromView(publicView);
    observeHand(this.#session.statsBook, publicRecord);
    this.#hooks.publicHandObserved?.(publicRecord);
    recordHand(this.#session.playerStats, record);
    this.#updateTilt(publicView);

    const blindsBefore = this.#table.blindsForHand(this.#table.handNumber);
    const settlement = this.#table.settleHand();
    this.#checkpoint = this.#table.serialize();
    const nextBlinds = this.#table.isOver ? null : this.#table.blindsForHand(this.#table.handNumber + 1);
    const blindsRiseNext = nextBlinds && nextBlinds.bigBlind !== blindsBefore.bigBlind ? nextBlinds : null;

    const humanOut = settlement.eliminations.find((e) => e.seat === this.#session.humanSeat);
    const fieldSize = this.#session.seats.length;
    for (const e of settlement.eliminations) {
      if (e.seat !== this.#session.humanSeat) this.#finishes.set(e.seat, { place: e.place, handNumber: settlement.handNumber });
    }
    if (settlement.gameOver && settlement.winnerSeat !== null && settlement.winnerSeat !== this.#session.humanSeat) {
      this.#finishes.set(settlement.winnerSeat, { place: 1, handNumber: settlement.handNumber });
    }
    if (humanOut) this.#session.humanFinish = { place: humanOut.place, handNumber: settlement.handNumber };
    if (settlement.gameOver && settlement.winnerSeat === this.#session.humanSeat) {
      this.#session.humanFinish = { place: 1, handNumber: settlement.handNumber };
    }
    this.#hooks.handRecorded?.(record, settlement);
    this.#save();
    if (this.#session.humanFinish && (humanOut || settlement.winnerSeat === this.#session.humanSeat)) {
      const place = this.#session.humanFinish.place;
      this.#hooks.humanFinished?.(place, fieldSize, prizeTable(this.#session.setup)[place - 1] ?? 0);
    }

    this.#toRemotes((r, s) => {
      r.handFinished({ record: buildHistoryRecord(hand, setup, names, s), settlement, blindsRiseNext }, this.snapshotFor(s));
      const out = settlement.eliminations.find((e) => e.seat === s);
      if (out && !settlement.gameOver) r.humanEliminated(out.place, fieldSize, this.snapshotFor(s));
    });
    if (!this.#fastForward || settlement.gameOver) {
      await this.#presenter.handFinished({ record, settlement, blindsRiseNext }, this.snapshot());
    }
    if (humanOut && !settlement.gameOver && !this.#stopped) {
      await this.#gate(); // never ask over a sheet the player has open
      let choice = await this.#presenter.humanEliminated(humanOut.place, fieldSize, this.snapshot());
      // Friends are still playing: the game cannot skip ahead without them.
      if (choice === 'skip' && this.#remotes.size) choice = 'watch';
      if (choice === 'menu') {
        this.#session.spectate = 'skip';
        this.#save();
        this.stop();
        return;
      }
      this.#session.spectate = choice;
      this.#fastForward = choice === 'skip';
      this.#save();
    }
  }

  #updateTilt(view: HandView): void {
    const bb = view.blinds.bigBlind;
    const result = view.result!;
    for (const seatInfo of this.#session.seats) {
      if (seatInfo.kind !== 'ai') continue;
      const state = this.#session.ai[seatInfo.id]!;
      const seat = this.#session.seats.indexOf(seatInfo);
      const s = view.seats[seat]!;
      state.tilt *= 0.85;
      if (!s.inHand) continue;
      const net = result.netChange[seat]!;
      if (net <= -25 * bb || (s.startStack > 0 && net <= -0.4 * s.startStack)) state.tilt += 0.35;
      const shown = view.revealed.find((r) => r.seat === seat);
      if (shown && net < 0 && categoryOf(shown.score) >= HandCategory.TwoPair) state.tilt += 0.2;
      if (net >= 20 * bb) state.tilt -= 0.2;
      state.tilt = Math.min(1, Math.max(0, state.tilt));
    }
  }

  #announceGameOver(): void {
    const winner = this.#table.winner()!;
    const humanPlace =
      this.#session.humanFinish?.place ?? (winner.seat === this.#session.humanSeat ? 1 : (this.#table.players()[this.#session.humanSeat]!.place ?? 0));
    const prizes = prizeTable(this.#session.setup);
    this.#save();
    this.#toRemotes((r, s) => {
      const place = s === winner.seat ? 1 : (this.#finishes.get(s)?.place ?? this.#table.players()[s]!.place ?? 0);
      r.gameOver(
        {
          winnerSeat: winner.seat,
          winnerName: this.#session.seats[winner.seat]!.name,
          humanPlace: place,
          fieldSize: this.#session.seats.length,
          hands: this.#table.handNumber,
          prizes,
          humanPrize: prizes[place - 1] ?? 0,
        },
        this.snapshotFor(s),
      );
    });
    this.#presenter.gameOver(
      {
        winnerSeat: winner.seat,
        winnerName: this.#session.seats[winner.seat]!.name,
        humanPlace,
        fieldSize: this.#session.seats.length,
        hands: this.#table.handNumber,
        prizes,
        humanPrize: prizes[humanPlace - 1] ?? 0,
      },
      this.snapshot(),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Cash games

  /** Buys chips for everyone who has none. Returns false if the human chose to leave instead. */
  async #settleBuyIns(): Promise<boolean> {
    const cash = this.#session.cash!;
    for (const seat of this.#table.seatsWithoutChips()) {
      const info = this.#session.seats[seat]!;
      if (info.kind === 'human') {
        const choice = (await this.#presenter.humanBusted?.(cash.buyIn, this.snapshot())) ?? 'rebuy';
        if (this.#stopped) throw new StopSignal();
        if (choice === 'leave') {
          this.#cashOut();
          return false;
        }
      }
      this.#table.addChips(seat, cash.buyIn);
      cash.buyIns[info.id] = (cash.buyIns[info.id] ?? 1) + 1;
      this.#checkpoint = this.#table.serialize();
      if (!this.#verify()) return true;
      this.#save();
      if (!this.#fastForward) this.#presenter.rebuy?.(seat, cash.buyIn, this.snapshot());
    }
    return true;
  }

  #cashOut(): void {
    const cash = this.#session.cash!;
    if (cash.cashedOut) return;
    const human = this.#session.seats[this.#session.humanSeat]!;
    const stack = this.#table.players()[this.#session.humanSeat]!.stack;
    const buyIns = cash.buyIns[human.id] ?? 1;
    const summary: CashSummary = {
      hands: this.#session.playerStats.handsPlayed,
      buyIn: cash.buyIn,
      buyIns,
      finalStack: stack,
      net: stack - buyIns * cash.buyIn,
      bigBlind: this.#table.blindsForHand(this.#table.handNumber + 1).bigBlind,
    };
    cash.cashedOut = { stack, hands: summary.hands };
    cash.leaving = false;
    this.#save();
    this.#hooks.cashedOut?.(summary);
    this.#presenter.cashSessionOver?.(summary, this.snapshot());
  }
}
