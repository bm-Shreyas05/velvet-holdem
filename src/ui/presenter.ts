import { type Card, RANK_NAMES, RANK_PLURALS, rankOf, suitOf } from '../engine/cards.ts';
import { bestFiveCards, describeHand, evaluate } from '../engine/evaluator.ts';
import { buildPots } from '../engine/pots.ts';
import type { HandEvent, LegalActions, PlayerAction } from '../engine/types.ts';
import type { AudioEngine } from '../audio/audio.ts';
import type { EliminationChoice, GameOverInfo, HandSummary, Presenter, TableSnapshot } from '../game/controller.ts';
import { SPEEDS, type Settings } from '../game/settings.ts';
import type { ActionBar } from './action-bar.ts';
import { type Announcer, choose, toast } from './dialogs.ts';
import { h } from './dom.ts';
import { actionSentence, chips, ordinal } from './format.ts';
import type { LogPanel } from './log-panel.ts';
import type { Motion } from './motion.ts';
import { applyEvent, displayFromSnapshot, displayMismatches, type TableDisplay } from './table-model.ts';
import type { SidePotInfo, TableView } from './table-view.ts';

export interface PresenterDeps {
  table: TableView;
  bar: ActionBar;
  log: LogPanel;
  audio: AudioEngine;
  motion: Motion;
  announcer: Announcer;
  settings: () => Settings;
  updateHeader: (snapshot: TableSnapshot) => void;
  isPaused: () => boolean;
  onGameOver: (info: GameOverInfo, snapshot: TableSnapshot) => void;
  /** Resolves when the player asks for the next hand (or immediately if auto-continue is on). */
  waitForNextHand: (autoMs: number) => Promise<void>;
  debug: boolean;
}

/** "Pocket Kings", "Ace-King suited", "Seven-Two offsuit". */
export function startingHandName(cards: Card[]): string {
  const [a, b] = cards;
  if (a === undefined || b === undefined) return '';
  const hi = Math.max(rankOf(a), rankOf(b));
  const lo = Math.min(rankOf(a), rankOf(b));
  if (hi === lo) return `Pocket ${RANK_PLURALS[hi]}`;
  return `${RANK_NAMES[hi]}-${RANK_NAMES[lo]} ${suitOf(a) === suitOf(b) ? 'suited' : 'offsuit'}`;
}

/** Side pots as they stand, from the public contributions in the view. */
export function sidePotsOf(snapshot: TableSnapshot): SidePotInfo[] {
  const v = snapshot.view;
  if (!v || v.phase === 'complete') return [];
  if (!v.seats.some((s) => s.inHand && !s.folded && s.allIn)) return [];
  // Only pots two or more players are still contesting; chips nobody has matched yet are just a bet.
  const pots = buildPots(v.seats.filter((s) => s.inHand).map((s) => ({ seat: s.seat, amount: s.totalCommit, folded: s.folded }))).filter(
    (p) => p.eligible.length >= 2,
  );
  if (pots.length < 2) return [];
  return pots.map((p, i) => ({ label: i === 0 ? 'Main pot' : `Side pot ${i}`, amount: p.amount }));
}

/**
 * Turns engine events into what the player sees and hears: animation, sound, the table log and
 * screen-reader announcements. After each batch it reconciles with the controller's snapshot,
 * so the screen always matches the real game state.
 */
export class DomPresenter implements Presenter {
  #d: PresenterDeps;
  #display: TableDisplay | null = null;
  #names: string[] = [];
  #humanSeat = 0;
  #lastSnapshot: TableSnapshot | null = null;

  constructor(deps: PresenterDeps) {
    this.#d = deps;
  }

  get display(): TableDisplay | null {
    return this.#display;
  }

  get lastSnapshot(): TableSnapshot | null {
    return this.#lastSnapshot;
  }

  #name(seat: number): string {
    return seat === this.#humanSeat ? 'You' : this.#names[seat] ?? `Seat ${seat + 1}`;
  }

  #render(): void {
    if (this.#display) this.#d.table.render(this.#display, this.#lastSnapshot ? sidePotsOf(this.#lastSnapshot) : []);
  }

  #updateStrength(snapshot: TableSnapshot): void {
    const v = snapshot.view;
    const me = v?.seats[snapshot.humanSeat];
    if (!v || !me?.holeCards || me.folded || !me.inHand) {
      this.#d.bar.setHandStrength('');
      return;
    }
    const text = v.board.length >= 3 ? describeHand(evaluate([...me.holeCards, ...v.board])) : startingHandName(me.holeCards);
    this.#d.bar.setHandStrength(text);
  }

  reset(snapshot: TableSnapshot): void {
    this.#lastSnapshot = snapshot;
    this.#humanSeat = snapshot.humanSeat;
    this.#names = snapshot.seats.map((s) => s.name);
    this.#display = displayFromSnapshot(snapshot);
    this.#render();
    this.#d.table.hideBanner();
    this.#d.table.highlightWinningCards([]);
    this.#d.updateHeader(snapshot);
    this.#updateStrength(snapshot);
    this.#d.bar.idle(snapshot.gameOver ? 'Game over' : '');
  }

  async present(events: HandEvent[], snapshot: TableSnapshot): Promise<void> {
    const { table, audio, log, motion, announcer } = this.#d;
    this.#lastSnapshot = snapshot;
    for (const e of events) {
      const prev = this.#display!;
      const next = applyEvent(prev, e);
      switch (e.type) {
        case 'hand-start':
          motion.endSkip();
          table.hideBanner();
          table.highlightWinningCards([]);
          this.#display = next;
          this.#render();
          audio.play('shuffle');
          log.hand(e.handNumber, `Blinds ${chips(e.blinds.smallBlind)}/${chips(e.blinds.bigBlind)} · ${this.#name(e.button)} on the button`);
          await motion.wait(300);
          break;
        case 'post':
          if (e.kind !== 'ante') await table.chipsToBet(e.seat, e.amount);
          this.#display = next;
          this.#render();
          audio.play('chips', 0.4);
          log.entry(actionSentence(this.#name(e.seat), { kind: e.kind, amount: e.amount, to: e.amount, allIn: e.allIn }), 'post');
          break;
        case 'deal-hole':
          this.#display = next;
          this.#render();
          await table.dealHole(e.order, next, () => audio.play('deal'));
          break;
        case 'hole-cards':
          this.#display = next;
          this.#render();
          audio.play('flip');
          await table.flipSeat(e.seat);
          log.entry('You are dealt', 'info', e.cards);
          announcer.say(`Your cards: ${startingHandName(e.cards)}.`);
          break;
        case 'action': {
          const seat = e.seat;
          if (e.kind === 'fold') {
            audio.play('fold');
            await table.muck(seat);
          } else if (e.amount > 0) {
            await table.chipsToBet(seat, e.amount);
          }
          this.#display = next;
          this.#render();
          table.popBadge(seat);
          if (e.kind === 'check') audio.play('check');
          else if (e.allIn && e.kind !== 'fold') audio.play('allIn');
          else if (e.amount > 0) audio.play(e.amount >= next.blinds.bigBlind * 10 ? 'chipsBig' : 'chips', e.amount / Math.max(1, next.blinds.bigBlind));
          const sentence = actionSentence(this.#name(seat), e);
          log.entry(sentence, e.allIn && e.kind !== 'fold' && e.kind !== 'check' ? 'allin' : e.kind);
          if (seat !== this.#humanSeat) announcer.say(`${sentence}.`);
          if (seat !== this.#humanSeat) await motion.wait(260);
          break;
        }
        case 'uncalled':
          await table.betToSeat(e.seat, e.amount);
          this.#display = next;
          this.#render();
          log.entry(`${chips(e.amount)} uncalled — returned to ${this.#name(e.seat) === 'You' ? 'you' : this.#name(e.seat)}`, 'info');
          break;
        case 'collect':
          if (prev.seats.some((s) => s.bet > 0)) {
            await table.collect(prev);
            audio.play('collect');
          }
          this.#display = next;
          this.#render();
          break;
        case 'board': {
          const from = prev.board.length;
          this.#display = next;
          table.render({ ...next, board: prev.board }, sidePotsOf(snapshot));
          await motion.wait(from === 0 ? 250 : 180);
          await table.revealBoard(from, e.cards, () => audio.play('deal'));
          this.#render();
          const title = e.street === 'flop' ? 'Flop' : e.street === 'turn' ? 'Turn' : 'River';
          log.entry(`${title}`, 'street', e.cards);
          announcer.say(`${title}: ${e.board.map((c) => `${RANK_NAMES[rankOf(c)]} of ${['clubs', 'diamonds', 'hearts', 'spades'][suitOf(c)]}`).slice(from).join(', ')}.`);
          this.#updateStrengthFrom(next);
          await motion.wait(280);
          break;
        }
        case 'reveal':
          this.#display = next;
          this.#render();
          audio.play('flip');
          await table.flipSeat(e.seat);
          if (e.seat !== this.#humanSeat || e.reason === 'showdown') {
            const label = next.board.length >= 3 && e.score ? ` — ${describeHand(e.score)}` : '';
            log.entry(`${this.#name(e.seat)} ${e.seat === this.#humanSeat ? 'show' : 'shows'}`, 'info', e.cards);
            if (label) log.entry(label.slice(3), 'info');
          }
          await motion.wait(e.reason === 'all-in' ? 350 : 250);
          break;
        case 'muck':
          await table.muck(e.seat);
          this.#display = next;
          this.#render();
          log.entry(`${this.#name(e.seat)} ${e.seat === this.#humanSeat ? 'muck' : 'mucks'}`, 'muck');
          break;
        case 'award': {
          const pot = e.pot;
          const label = e.potCount === 1 ? 'the pot' : pot.index === 0 ? 'the main pot' : `side pot ${pot.index}`;
          if (pot.winningScore !== null && pot.index === 0) {
            const winnerCards = snapshot.view?.revealed.find((r) => r.seat === pot.winners[0])?.cards;
            if (winnerCards) this.#d.table.highlightWinningCards(bestFiveCards([...winnerCards, ...next.board]));
          }
          await Promise.all(pot.shares.map((s) => table.potToSeat(s.seat, s.amount)));
          this.#display = next;
          this.#render();
          for (const s of pot.shares) {
            table.pulseStack(s.seat);
            const how = pot.winningScore !== null ? ` with ${describeHand(pot.winningScore)}` : '';
            const tied = pot.shares.length > 1 ? ' (split)' : '';
            const who = this.#name(s.seat);
            const sentence = `${who} ${who === 'You' ? 'win' : 'wins'} ${chips(s.amount)} from ${label}${how}${tied}`;
            log.entry(sentence, 'win');
            announcer.say(`${sentence}.`);
          }
          const humanWon = pot.shares.some((s) => s.seat === this.#humanSeat);
          if (humanWon) audio.play(pot.amount >= next.blinds.bigBlind * 20 ? 'winBig' : 'win');
          else if (pot.eligible.includes(this.#humanSeat) && pot.winningScore !== null) audio.play('lose');
          await motion.wait(250);
          break;
        }
        case 'hand-end':
          this.#display = next;
          this.#render();
          break;
      }
    }
    // Reconcile with the authoritative state (keeping purely visual details like badges).
    const truth = displayFromSnapshot(snapshot);
    const diff = displayMismatches(this.#display!, truth);
    if (diff.length && this.#d.debug) console.warn('Display resynchronised with engine:', diff);
    this.#display = {
      ...truth,
      seats: truth.seats.map((s, i) => {
        const shown = this.#display!.seats[i]!;
        return { ...s, badge: shown.badge, handLabel: s.handLabel ?? shown.handLabel, winner: shown.winner || s.winner };
      }),
    };
    this.#render();
    this.#d.updateHeader(snapshot);
    this.#updateStrength(snapshot);
  }

  #updateStrengthFrom(d: TableDisplay): void {
    const me = d.seats[this.#humanSeat];
    if (!me || me.folded || me.cards.length !== 2 || me.cards.some((c) => c === null)) return;
    const hole = me.cards as Card[];
    this.#d.bar.setHandStrength(d.board.length >= 3 ? describeHand(evaluate([...hole, ...d.board])) : startingHandName(hole));
  }

  async requestAction(snapshot: TableSnapshot, legal: LegalActions): Promise<PlayerAction> {
    this.#lastSnapshot = snapshot;
    this.#d.motion.endSkip();
    this.#d.table.setThinking(null);
    this.#d.table.setActive(snapshot.humanSeat);
    this.#d.audio.play('yourTurn');
    const facing = legal.toCall > 0 ? `${chips(legal.toCall)} to call` : 'you can check';
    this.#d.announcer.say(`Your turn — ${facing}. Pot ${chips(legal.pot)}.`, true);
    return this.#d.bar.request(legal);
  }

  thinking(seat: number | null, snapshot: TableSnapshot): void {
    this.#lastSnapshot = snapshot;
    this.#d.table.setThinking(seat);
    if (seat !== null) {
      this.#d.table.setActive(seat);
      this.#d.bar.idle(`${this.#names[seat]} is thinking…`);
    } else {
      this.#d.bar.idle('');
    }
  }

  async handFinished(summary: HandSummary, snapshot: TableSnapshot): Promise<void> {
    const { table, motion } = this.#d;
    this.#lastSnapshot = snapshot;
    const r = summary.record;
    const me = r.players.find((p) => p.seat === r.humanSeat);
    const winners = [...new Set(r.pots.flatMap((p) => p.winners))];
    const main = r.pots[0]!;
    const total = r.pots.reduce((s, p) => s + p.amount, 0);
    let title: string;
    if (winners.length === 1) {
      const w = winners[0]!;
      title = w === r.humanSeat ? `You win ${chips(total)}` : `${this.#names[w]} wins ${chips(total)}`;
    } else {
      title = winners.includes(r.humanSeat) ? 'You split the pot' : `${winners.map((w) => this.#names[w]).join(' & ')} split the pot`;
    }
    const detail = main.winningScore !== null ? describeHand(main.winningScore) : r.showdown ? '' : 'Everyone else folded';
    table.showBanner(title, detail);
    this.#d.bar.idle(me && me.net !== 0 ? `${me.net > 0 ? 'You won' : 'You lost'} ${chips(Math.abs(me.net))} this hand` : 'Hand complete');

    for (const e of summary.settlement.eliminations) {
      const who = e.seat === r.humanSeat ? 'You are' : `${this.#names[e.seat]} is`;
      this.#d.log.entry(`${who} out in ${ordinal(e.place)} place`, 'fold');
      this.#d.announcer.say(`${who} eliminated in ${ordinal(e.place)} place.`);
      this.#d.audio.play('eliminated');
      await table.eliminate(e.seat);
    }
    if (summary.blindsRiseNext) {
      const b = summary.blindsRiseNext;
      toast(`Blinds rise to ${chips(b.smallBlind)}/${chips(b.bigBlind)} next hand`);
      this.#d.audio.play('levelUp');
    }
    const s = this.#d.settings();
    const base = r.showdown ? 2600 : 1500;
    await motion.wait(250);
    await this.#d.waitForNextHand(s.gameplay.autoContinue && !summary.settlement.gameOver ? base * SPEEDS[s.gameplay.speed].pause : -1);
    table.hideBanner();
  }

  async humanEliminated(place: number, fieldSize: number): Promise<EliminationChoice> {
    this.#d.bar.idle(`You finished ${ordinal(place)}`);
    const msg = h(
      'div',
      {},
      h('p', { class: 'result-line' }, `You finished ${ordinal(place)} of ${fieldSize}.`),
      h('p', { class: 'sheet-message' }, 'The remaining players will play on until one of them holds every chip.'),
    );
    return choose<EliminationChoice>('You’re out', msg, [
      { id: 'menu', label: 'Main menu' },
      { id: 'watch', label: 'Watch the finish' },
      { id: 'skip', label: 'Skip to the result', primary: true },
    ]);
  }

  gameOver(info: GameOverInfo, snapshot: TableSnapshot): void {
    this.#lastSnapshot = snapshot;
    this.#d.bar.idle('Game over');
    this.#d.onGameOver(info, snapshot);
  }

  actionRejected(message: string): void {
    toast(message, 'warning');
  }

  notify(message: string, tone: 'info' | 'warning' | 'error'): void {
    toast(message, tone);
  }
}
