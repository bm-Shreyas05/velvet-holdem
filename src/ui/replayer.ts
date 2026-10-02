import type { Card } from '../engine/cards.ts';
import type { StyleId } from '../ai/profiles.ts';
import type { TableSnapshot } from '../game/controller.ts';
import type { HandHistoryRecord } from '../game/history.ts';
import { buildReplaySteps, type DecisionReview, type ReplayStep, type ReviewContext, reviewDecisions } from '../game/review.ts';
import type { App } from './app.ts';
import { openSheet, type SheetHandle, toast } from './dialogs.ts';
import { h } from './dom.ts';
import { chips, pct } from './format.ts';
import { LogPanel } from './log-panel.ts';
import { Motion } from './motion.ts';
import { DomPresenter, type PresenterBar } from './presenter.ts';
import { TableView } from './table-view.ts';
import { cardsToString } from '../engine/cards.ts';
import { cardFaceUrl } from '../assets/cards.ts';

export interface ReplayOptions extends ReviewContext {
  /** Opponents' styles by name, when known (for their avatars). */
  styleOf?: (name: string) => StyleId | null;
  /** Start with the coach's review open. */
  review?: boolean;
}

const STREET_LABEL = { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River' } as const;
const VERDICT_LABEL = { good: 'Good decision', close: 'Close call', costly: 'Costly' } as const;

/**
 * Replays a finished hand on a table of its own, step by step, exactly as the player saw it —
 * plus the coach's review of each of the player's decisions.
 */
export function openReplayer(app: App, record: HandHistoryRecord, opts: ReplayOptions = {}): SheetHandle {
  const steps = buildReplaySteps(record);
  const setup = record.replay.setup;
  const human = record.humanSeat;
  const nameOf = (seat: number) => record.players.find((p) => p.seat === seat)?.name ?? `Seat ${seat + 1}`;

  const snapshotAt = (i: number): TableSnapshot => {
    const view = steps[i]!.view;
    return {
      handNumber: record.handNumber,
      view,
      seats: setup.seats.map((s, seat) => ({
        seat,
        id: s?.id ?? `empty-${seat}`,
        name: s ? nameOf(seat) : '',
        kind: seat === human ? 'human' : 'ai',
        style: seat === human || !s ? null : (opts.styleOf?.(nameOf(seat)) ?? null),
        stack: view.seats[seat]?.inHand ? view.seats[seat]!.stack : (s?.stack ?? 0),
        eliminated: !s,
        place: null,
      })),
      humanSeat: human,
      blinds: { ...setup.blinds },
      level: 1,
      handsUntilNextLevel: null,
      nextBlinds: null,
      button: setup.button,
      seeded: false,
      gameOver: false,
      humanFinish: null,
      mode: 'tournament',
      daily: null,
      prizes: [],
      cash: null,
    };
  };

  // A table, log and presenter of the replay's own (the live game keeps its own untouched).
  const motion = new Motion();
  motion.reduced = app.motion.reduced;
  motion.speed = 1;
  const stageBox = h('div', { class: 'replay-stage table-area' });
  const log = new LogPanel(() => app.settings.display.fourColorDeck);
  const caption = h('p', { class: 'replay-caption', 'aria-live': 'polite' });
  const strength = h('p', { class: 'replay-strength' });
  const bar: PresenterBar = {
    setHandStrength: (text: string) => {
      strength.textContent = text;
    },
    idle: () => undefined,
    request: () => Promise.reject(new Error('A replay never asks for a decision')),
    setHint: () => undefined,
    waiting: false,
  };
  const table = new TableView(setup.seats.length, motion, () => app.settings);
  // Sound plays while stepping forward, but not while fast-forwarding to a jumped-to step.
  let silent = false;
  const audio = {
    play: (...args: Parameters<App['audio']['play']>) => {
      if (!silent) app.audio.play(...args);
    },
  };
  const presenter = new DomPresenter({
    table,
    bar,
    log,
    audio,
    motion,
    announcer: app.announcer,
    settings: () => app.settings,
    updateHeader: () => undefined,
    isPaused: () => false,
    onGameOver: () => undefined,
    waitForNextHand: async () => undefined,
    debug: false,
  });

  // ---- Playback -------------------------------------------------------------------------------
  let at = 0;
  let busy = false;
  let playing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const counter = h('span', { class: 'replay-counter' });

  const describe = (step: ReplayStep, i: number): string => {
    if (i === 0)
      return `Hand ${record.handNumber} · blinds ${chips(setup.blinds.smallBlind)}/${chips(setup.blinds.bigBlind)} · ${nameOf(setup.button)} on the button`;
    const d = step.decision!;
    const who = d.seat === human ? 'You' : nameOf(d.seat);
    const entry = step.view.actions.filter((a) => a.seat === d.seat).at(-1);
    const verb =
      d.action.kind === 'fold'
        ? 'fold'
        : d.action.kind === 'check'
          ? 'check'
          : d.action.kind === 'call'
            ? `call ${chips(entry?.amount ?? 0)}`
            : d.action.kind === 'bet'
              ? `bet ${chips(d.action.to ?? 0)}`
              : `raise to ${chips(d.action.to ?? 0)}`;
    const third = who === 'You' ? verb : verb.replace(/^(\w+)/, (w) => (w === 'raise' ? 'raises' : `${w}s`));
    const allIn = entry?.allIn && d.action.kind !== 'fold' && d.action.kind !== 'check' ? (who === 'You' ? ' — you are all-in' : ' — all-in') : '';
    const end = i === steps.length - 1 ? ' · hand over' : '';
    return `${who} ${third}${allIn}${end}`;
  };

  const sync = () => {
    counter.textContent = `Step ${at + 1} of ${steps.length}`;
    caption.textContent = describe(steps[at]!, at);
    first.disabled = back.disabled = at === 0 || busy;
    next.disabled = last.disabled = at >= steps.length - 1;
    play.textContent = playing ? 'Pause' : at >= steps.length - 1 ? 'Replay' : 'Play';
    for (const el of reviewList.querySelectorAll<HTMLElement>('[data-step]')) el.classList.toggle('is-current', Number(el.dataset.step) === at);
  };

  /**
   * Shows step i instantly (jumps and going back): the hand is replayed from the deal with
   * animation and sound off, so the table and the log both end up exactly as they were.
   */
  const jump = async (i: number) => {
    if (busy) return;
    busy = true;
    const target = Math.max(0, Math.min(steps.length - 1, i));
    const speed = motion.speed;
    silent = true;
    motion.speed = 0;
    try {
      log.clear();
      presenter.reset(snapshotAt(0));
      for (let k = 0; k <= target; k++) await presenter.present(steps[k]!.events, snapshotAt(k));
      at = target;
    } finally {
      motion.speed = speed;
      silent = false;
      busy = false;
      sync();
    }
  };

  /** Animates the next step, exactly as it played at the table. */
  const forward = async () => {
    if (busy) {
      motion.skip();
      return;
    }
    if (at >= steps.length - 1) return;
    busy = true;
    sync();
    try {
      const i = at + 1;
      await presenter.present(steps[i]!.events, snapshotAt(i));
      at = i;
    } finally {
      busy = false;
      sync();
    }
  };

  const stop = () => {
    playing = false;
    if (timer) clearTimeout(timer);
    timer = null;
    sync();
  };
  const loop = async () => {
    if (!playing) return;
    if (at >= steps.length - 1) {
      stop();
      return;
    }
    await forward();
    if (playing) timer = setTimeout(() => void loop(), 650 / motion.speed);
  };

  const button = (label: string, title: string, fn: () => void) => {
    const b = h('button', { type: 'button', class: 'btn btn--small', title, 'aria-label': title }, label) as HTMLButtonElement;
    b.addEventListener('click', fn);
    return b;
  };
  const first = button('⏮', 'Start of the hand', () => {
    stop();
    void jump(0);
  });
  const back = button('◀', 'Previous step', () => {
    stop();
    void jump(at - 1);
  });
  const play = button('Play', 'Play or pause', async () => {
    if (playing) return stop();
    if (at >= steps.length - 1) await jump(0);
    playing = true;
    sync();
    void loop();
  });
  play.classList.add('btn--primary');
  const next = button('▶', 'Next step', () => {
    stop();
    void forward();
  });
  const last = button('⏭', 'End of the hand', () => {
    stop();
    void jump(steps.length - 1);
  });
  const speed = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Replay speed' });
  const renderSpeed = () =>
    speed.replaceChildren(
      ...[1, 2, 4].map((s) => {
        const b = h('button', { type: 'button', role: 'radio', class: 'seg', 'aria-checked': String(motion.speed === 1 / s) }, `${s}×`);
        b.addEventListener('click', () => {
          motion.speed = 1 / s;
          renderSpeed();
        });
        return b;
      }),
    );
  renderSpeed();

  // ---- Coach ------------------------------------------------------------------------------------
  const reviewList = h('ol', { class: 'review-list' });
  const reviewSummary = h('p', { class: 'review-summary' });
  const reviewButton = h('button', { type: 'button', class: 'btn btn--primary btn--small' }, 'Review my decisions') as HTMLButtonElement;
  const mine = steps.filter((s) => s.before).length;
  if (!mine) {
    reviewButton.disabled = true;
    reviewSummary.textContent = record.players.some((p) => p.seat === human)
      ? 'You had no decisions to make in this hand.'
      : 'You were not dealt into this hand.';
  }

  const miniCards = (cards: Card[]) =>
    h(
      'span',
      { class: 'mini-cards', role: 'img', 'aria-label': cardsToString(cards) },
      ...cards.map((c) => h('img', { class: 'mini-card', src: cardFaceUrl(c, { fourColor: app.settings.display.fourColorDeck }), alt: '' })),
    );

  const renderReview = (reviews: DecisionReview[]) => {
    const costly = reviews.filter((r) => r.verdict === 'costly').length;
    const lost = reviews.reduce((s, r) => s + r.evLossBB, 0);
    reviewSummary.textContent = reviews.length
      ? costly
        ? `${costly} costly decision${costly > 1 ? 's' : ''} — about ${lost.toFixed(1)} big blinds given up in all, by the coach’s estimate.`
        : lost < 0.5
          ? 'Well played: every decision matched or came close to the coach’s choice.'
          : `No costly decisions. About ${lost.toFixed(1)} big blinds given up in close calls.`
      : 'Nothing to review.';
    reviewList.replaceChildren(
      ...reviews.map((r) => {
        const goTo = h('button', { type: 'button', class: 'btn btn--small review-goto' }, 'Show') as HTMLButtonElement;
        goTo.addEventListener('click', () => {
          stop();
          void jump(r.step - 1);
        });
        const best = r.options.find((o) => o.best)!;
        return h(
          'li',
          { class: `review-item verdict-${r.verdict}`, 'data-step': String(r.step - 1) },
          h(
            'div',
            { class: 'review-head' },
            h('strong', {}, STREET_LABEL[r.street]),
            r.board.length ? miniCards(r.board) : null,
            h('span', { class: 'review-pot' }, `pot ${r.potBB.toFixed(1)} BB${r.toCallBB ? ` · ${r.toCallBB.toFixed(1)} to call` : ''}`),
            h('span', { class: `review-verdict` }, VERDICT_LABEL[r.verdict]),
            goTo,
          ),
          h(
            'p',
            { class: 'review-line' },
            'You: ',
            h('strong', {}, r.actionText),
            best.chosen
              ? ' — the coach agrees.'
              : [' · Coach: ', h('strong', {}, best.text), r.evLossBB >= 0.05 ? ` (about ${r.evLossBB.toFixed(1)} BB better)` : ''],
          ),
          h(
            'p',
            { class: 'review-facts' },
            `Your equity ≈ ${pct(r.equity)} against their likely hands`,
            r.potOdds !== null ? ` · a call needed ${pct(r.potOdds)}` : '',
          ),
          h(
            'ul',
            { class: 'review-options' },
            ...r.options
              .slice(0, 5)
              .map((o) =>
                h(
                  'li',
                  { class: `${o.best ? 'is-best' : ''} ${o.chosen ? 'is-chosen' : ''}` },
                  h('span', {}, o.text),
                  h('span', { class: 'review-ev' }, `${o.evBB >= 0 ? '+' : ''}${o.evBB.toFixed(1)} BB`),
                ),
              ),
          ),
        );
      }),
    );
    sync();
  };

  const runReview = async () => {
    reviewButton.disabled = true;
    reviewButton.textContent = 'Reviewing…';
    try {
      const reviews = await reviewDecisions(record, steps, (req) => app.aiDecide(req), opts);
      renderReview(reviews);
      app.noteReview();
      reviewButton.textContent = 'Reviewed';
    } catch (e) {
      reviewButton.disabled = false;
      reviewButton.textContent = 'Review my decisions';
      toast(`The coach could not review this hand (${e instanceof Error ? e.message : e}).`, 'warning');
    }
  };
  reviewButton.addEventListener('click', () => void runReview());

  const sheet = openSheet(
    {
      title: `Replay · hand ${record.handNumber}`,
      wide: true,
      className: 'sheet--replay',
      onClose: () => {
        stop();
        motion.skip();
        table.destroy();
      },
    },
    h('div', { class: 'replay-main' }, stageBox, log.root),
    h('div', { class: 'replay-info' }, caption, strength),
    h('div', { class: 'replay-controls' }, first, back, play, next, last, counter, speed),
    h(
      'section',
      { class: 'coach' },
      h('div', { class: 'coach-head' }, h('h3', {}, 'Coach'), reviewButton),
      h(
        'p',
        { class: 'fine' },
        'The coach is the strongest AI setting, looking at exactly what you saw at each decision. Values are its estimates in big blinds, compared with folding.',
      ),
      reviewSummary,
      reviewList,
    ),
  );
  table.mount(stageBox);
  void jump(0);
  if (opts.review && mine) void runReview();
  return sheet;
}
