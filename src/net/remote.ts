import { safeFallbackAction } from '../ai/decide.ts';
import type { HandEvent, LegalActions, PlayerAction } from '../engine/types.ts';
import type { EliminationChoice, GameOverInfo, HandSummary, Presenter, TableSnapshot } from '../game/controller.ts';
import { type CallName, type GuestMessage, type HostMessage, parseAction } from './protocol.ts';

/** How long a friend has for a decision before it is made for them (check if free, else fold). */
export const SHOT_CLOCK_MS = 60_000;

/**
 * The host's stand-in for a friend's screen: forwards each presenter call (already built from
 * that friend's seat) over the connection and waits only for their decisions. While the friend
 * is disconnected their hand checks or folds at once, as at a real table when a player steps
 * away; when they reconnect they get the current table and any decision still pending.
 */
export class RemotePresenter implements Presenter {
  #send: ((message: HostMessage) => void) | null = null;
  #last: TableSnapshot | null = null;
  #nextId = 1;
  #pending: { id: number; snapshot: TableSnapshot; legal: LegalActions; deadline: number; finish: (a: PlayerAction) => void } | null = null;
  readonly #clockMs: number;

  constructor(clockMs = SHOT_CLOCK_MS) {
    this.#clockMs = clockMs;
  }

  get connected(): boolean {
    return this.#send !== null;
  }

  /** A (re)connection: catch the friend up on the table, and on a decision still waiting for them. */
  connect(send: (message: HostMessage) => void): void {
    this.#send = send;
    if (this.#last) send({ t: 'call', m: 'reset', a: [this.#last] });
    const p = this.#pending;
    if (p) send({ t: 'ask', id: p.id, m: 'requestAction', a: [p.snapshot, p.legal], clockMs: Math.max(0, p.deadline - Date.now()) });
  }

  disconnect(): void {
    this.#send = null;
    const p = this.#pending;
    if (p) p.finish(safeFallbackAction(p.legal));
  }

  receive(message: GuestMessage): void {
    const p = this.#pending;
    if (message.t !== 'answer' || !p || message.id !== p.id) return;
    p.finish(parseAction(message.value) ?? safeFallbackAction(p.legal));
  }

  #call(m: CallName, ...a: unknown[]): void {
    try {
      this.#send?.({ t: 'call', m, a });
    } catch {
      /* the connection is the room's concern; the game goes on */
    }
  }

  reset(snapshot: TableSnapshot): void {
    this.#last = snapshot;
    this.#call('reset', snapshot);
  }

  present(events: HandEvent[], snapshot: TableSnapshot): Promise<void> {
    this.#last = snapshot;
    this.#call('present', events, snapshot);
    return Promise.resolve();
  }

  requestAction(snapshot: TableSnapshot, legal: LegalActions): Promise<PlayerAction> {
    this.#last = snapshot;
    const send = this.#send;
    if (!send) return Promise.resolve(safeFallbackAction(legal));
    return new Promise((resolve) => {
      const id = this.#nextId++;
      const deadline = Date.now() + this.#clockMs;
      const timer = setTimeout(() => {
        this.#send?.({ t: 'cancel', id });
        finish(safeFallbackAction(legal));
      }, this.#clockMs);
      const finish = (action: PlayerAction) => {
        if (this.#pending?.id !== id) return;
        clearTimeout(timer);
        this.#pending = null;
        resolve(action);
      };
      this.#pending = { id, snapshot, legal, deadline, finish };
      send({ t: 'ask', id, m: 'requestAction', a: [snapshot, legal], clockMs: this.#clockMs });
    });
  }

  thinking(seat: number | null, snapshot: TableSnapshot): void {
    this.#last = snapshot;
    this.#call('thinking', seat, snapshot);
  }

  handFinished(summary: HandSummary, snapshot: TableSnapshot): Promise<void> {
    this.#last = snapshot;
    this.#call('handFinished', summary, snapshot);
    return Promise.resolve();
  }

  humanEliminated(place: number, fieldSize: number, snapshot: TableSnapshot): Promise<EliminationChoice> {
    this.#last = snapshot;
    this.#call('humanEliminated', place, fieldSize, snapshot);
    return Promise.resolve('watch');
  }

  gameOver(info: GameOverInfo, snapshot: TableSnapshot): void {
    this.#last = snapshot;
    this.#call('gameOver', info, snapshot);
  }

  actionRejected(message: string): void {
    this.#call('actionRejected', message);
  }

  notify(message: string, tone: 'info' | 'warning' | 'error'): void {
    this.#call('notify', message, tone);
  }
}
