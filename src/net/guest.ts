import type { HandEvent, LegalActions } from '../engine/types.ts';
import type { EliminationChoice, GameOverInfo, HandSummary, Presenter, TableSnapshot } from '../game/controller.ts';
import type { GuestMessage, HostMessage } from './protocol.ts';

export interface GuestDriverHooks {
  /** The host's shot clock ran out: abandon the decision on screen (the host has acted for us). */
  cancelDecision(): void;
  /** Seconds left to decide, shown near the end of the shot clock (null clears it). */
  clock?(secondsLeft: number | null): void;
  /** The player chose what to do after being knocked out. */
  eliminated?(choice: EliminationChoice): void;
  /** A message could not be shown (a bug or a damaged message). */
  failed?(error: unknown): void;
}

/** Messages that only update the picture, so can be skipped when we fall behind. */
const SKIPPABLE = new Set(['present', 'thinking']);
/** More queued messages than this means the screen is far behind (a hidden tab, a slow phone). */
const BACKLOG = 6;

/**
 * Plays the host's messages through an ordinary presenter, one at a time, so a friend's screen
 * animates exactly like a local game. Notices and shot-clock cancellations jump the queue. If the
 * screen falls far behind, the picture-only messages are skipped and the table redrawn as it is.
 */
export class GuestDriver {
  readonly #presenter: Presenter;
  readonly #send: (message: GuestMessage) => void;
  readonly #hooks: GuestDriverHooks;
  #queue: HostMessage[] = [];
  #busy = false;
  #stopped = false;
  #waiters: (() => void)[] = [];
  #asking: number | null = null;
  #clockTimer: ReturnType<typeof setInterval> | null = null;

  constructor(presenter: Presenter, send: (message: GuestMessage) => void, hooks: GuestDriverHooks) {
    this.#presenter = presenter;
    this.#send = send;
    this.#hooks = hooks;
  }

  get pending(): number {
    return this.#queue.length;
  }

  /** Resolves once a message is waiting (used to end the pause between hands). */
  whenMessage(): Promise<void> {
    if (this.#queue.length || this.#stopped) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  stop(): void {
    this.#stopped = true;
    this.#queue = [];
    this.#stopClock();
    for (const w of this.#waiters.splice(0)) w();
  }

  receive(message: HostMessage): void {
    if (this.#stopped) return;
    if (message.t === 'cancel') {
      if (message.id === this.#asking) {
        this.#asking = null;
        this.#stopClock();
        this.#hooks.cancelDecision();
      }
      return;
    }
    if (message.t === 'call' && message.m === 'notify') {
      this.#presenter.notify(String(message.a[0] ?? ''), message.a[1] === 'error' || message.a[1] === 'warning' ? message.a[1] : 'info');
      return;
    }
    if (message.t !== 'call' && message.t !== 'ask') return;
    this.#queue.push(message);
    for (const w of this.#waiters.splice(0)) w();
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (this.#queue.length && !this.#stopped) {
        this.#catchUp();
        const message = this.#queue.shift()!;
        try {
          await this.#handle(message);
        } catch (error) {
          this.#hooks.failed?.(error);
        }
      }
    } finally {
      this.#busy = false;
    }
  }

  #catchUp(): void {
    if (this.#queue.length <= BACKLOG) return;
    let latest: TableSnapshot | null = null;
    while (this.#queue.length > 2) {
      const next = this.#queue[0]!;
      if (next.t !== 'call' || !SKIPPABLE.has(next.m)) break;
      latest = next.a[next.a.length - 1] as TableSnapshot;
      this.#queue.shift();
    }
    if (latest) this.#presenter.reset(latest);
  }

  async #handle(message: HostMessage): Promise<void> {
    const p = this.#presenter;
    if (message.t === 'ask') {
      const id = message.id;
      this.#asking = id;
      this.#startClock(message.clockMs);
      const action = await p.requestAction(message.a[0] as TableSnapshot, message.a[1] as LegalActions);
      this.#stopClock();
      if (this.#asking === id) {
        this.#asking = null;
        this.#send({ t: 'answer', id, value: action });
      }
      return;
    }
    if (message.t !== 'call') return;
    const a = message.a;
    switch (message.m) {
      case 'reset':
        p.reset(a[0] as TableSnapshot);
        break;
      case 'present':
        await p.present(a[0] as HandEvent[], a[1] as TableSnapshot);
        break;
      case 'thinking':
        p.thinking(a[0] as number | null, a[1] as TableSnapshot);
        break;
      case 'handFinished':
        await p.handFinished(a[0] as HandSummary, a[1] as TableSnapshot);
        break;
      case 'humanEliminated':
        // Asked without holding up the table: the game goes on while the player decides.
        p.humanEliminated(a[0] as number, a[1] as number, a[2] as TableSnapshot)
          .then((choice) => this.#hooks.eliminated?.(choice))
          .catch(() => undefined);
        break;
      case 'gameOver':
        p.gameOver(a[0] as GameOverInfo, a[1] as TableSnapshot);
        break;
      case 'actionRejected':
        p.actionRejected(String(a[0] ?? ''));
        break;
    }
  }

  #startClock(ms: number): void {
    this.#stopClock();
    const deadline = Date.now() + ms;
    const tick = () => {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      this.#hooks.clock?.(left <= 20 ? Math.max(0, left) : null);
    };
    tick();
    this.#clockTimer = setInterval(tick, 500);
  }

  #stopClock(): void {
    if (this.#clockTimer) clearInterval(this.#clockTimer);
    this.#clockTimer = null;
    this.#hooks.clock?.(null);
  }
}
