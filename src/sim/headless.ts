import type { LegalActions, PlayerAction } from '../engine/types.ts';
import type { Rng } from '../engine/rng.ts';
import type { EliminationChoice, GameOverInfo, HandSummary, Presenter, TableSnapshot } from '../game/controller.ts';
import type { HandEvent } from '../engine/types.ts';
import { randomLegalAction } from './bots.ts';

/**
 * A presenter with no interface: decisions come from a callback, presentation resolves
 * immediately. Used by integration tests and simulations. It also cross-checks that what the
 * human is shown never includes another player's unrevealed cards.
 */
export class HeadlessPresenter implements Presenter {
  readonly events: HandEvent[] = [];
  readonly summaries: HandSummary[] = [];
  readonly notices: { message: string; tone: string }[] = [];
  readonly rejections: string[] = [];
  gameOverInfo: GameOverInfo | null = null;
  eliminationChoice: EliminationChoice = 'skip';
  violations: string[] = [];
  #decide: (legal: LegalActions, snapshot: TableSnapshot) => PlayerAction;

  constructor(decide: (legal: LegalActions, snapshot: TableSnapshot) => PlayerAction) {
    this.#decide = decide;
  }

  static random(rng: Rng): HeadlessPresenter {
    return new HeadlessPresenter((legal) => randomLegalAction(legal, rng));
  }

  #checkVisibility(snapshot: TableSnapshot): void {
    const v = snapshot.view;
    if (!v) return;
    for (const s of v.seats) {
      if (s.seat !== snapshot.humanSeat && s.holeCards && !s.revealed) this.violations.push(`hand ${v.handNumber}: saw seat ${s.seat}'s hidden cards`);
    }
  }

  reset(snapshot: TableSnapshot): void {
    this.#checkVisibility(snapshot);
  }
  async present(events: HandEvent[], snapshot: TableSnapshot): Promise<void> {
    for (const e of events) {
      if (e.type === 'hole-cards' && e.seat !== snapshot.humanSeat) this.violations.push(`received seat ${e.seat}'s hole cards`);
    }
    this.events.push(...events);
    this.#checkVisibility(snapshot);
  }
  async requestAction(snapshot: TableSnapshot, legal: LegalActions): Promise<PlayerAction> {
    this.#checkVisibility(snapshot);
    return this.#decide(legal, snapshot);
  }
  thinking(): void {}
  async handFinished(summary: HandSummary): Promise<void> {
    this.summaries.push(summary);
  }
  async humanEliminated(): Promise<EliminationChoice> {
    return this.eliminationChoice;
  }
  gameOver(info: GameOverInfo): void {
    this.gameOverInfo = info;
  }
  actionRejected(message: string): void {
    this.rejections.push(message);
  }
  notify(message: string, tone: 'info' | 'warning' | 'error'): void {
    this.notices.push({ message, tone });
  }
}
