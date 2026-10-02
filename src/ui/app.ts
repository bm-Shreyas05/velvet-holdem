import { AudioEngine } from '../audio/audio.ts';
import { ICONS } from '../assets/icons.ts';
import { type AiHost, InlineAiHost, WorkerAiHost } from '../ai/host.ts';
import { emptyStats as emptyModelStats, observeHand } from '../ai/model.ts';
import { DIFFICULTIES } from '../ai/profiles.ts';
import type { HandSettlement } from '../engine/game.ts';
import type { PublicHandRecord } from '../engine/records.ts';
import { dailySetup, type NewGameSetup, PAYOUTS, todayKey } from '../game/config.ts';
import { type CashSummary, GameController, type GameOverInfo, type TableSnapshot } from '../game/controller.ts';
import type { HandHistoryRecord } from '../game/history.ts';
import {
  type Achievement,
  achievementsForDaily,
  achievementsForHand,
  achievementsForTournament,
  type ProgressData,
  recordDaily,
  reputationPrior,
  unlock,
} from '../game/progress.ts';
import { createSession, type SessionData } from '../game/session.ts';
import { SPEEDS, type Settings } from '../game/settings.ts';
import { recordCashSession, recordFinish, recordHand } from '../game/stats.ts';
import { GameStorage, HISTORY_LIMIT } from '../game/storage.ts';
import { ActionBar } from './action-bar.ts';
import { Announcer, confirm, dialogOpen, toast } from './dialogs.ts';
import { clear, h, iconButton } from './dom.ts';
import { chips, ordinal, signed } from './format.ts';
import { LogPanel } from './log-panel.ts';
import { Motion } from './motion.ts';
import { DomPresenter } from './presenter.ts';
import { renderMenu, renderSetup } from './screens.ts';
import { openAchievements, openCashSummary, openGameOver, openHelp, openHistory, openPauseMenu, openSettings, openStats } from './sheets.ts';
import { TableView } from './table-view.ts';

declare const __AI_WORKER_SOURCE__: string;

interface TableSession {
  controller: GameController;
  presenter: DomPresenter;
  table: TableView;
  bar: ActionBar;
  log: LogPanel;
  records: HandHistoryRecord[];
  nextHand: (() => void) | null;
  header: HTMLElement;
}

/**
 * Application shell: screens, persistence, audio, settings and the game loop wiring.
 */
export class App {
  readonly root: HTMLElement;
  readonly storage: GameStorage;
  readonly audio: AudioEngine;
  readonly motion = new Motion();
  readonly announcer = new Announcer();
  readonly dev: boolean;
  settings: Settings;
  #ai: AiHost | null = null;
  #table: TableSession | null = null;
  #lastSetup: NewGameSetup | null = null;
  #media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  /** Theme the hosting page chose (if any); "System" defers to it. */
  readonly #hostTheme = document.documentElement.getAttribute('data-theme');

  constructor(root: HTMLElement) {
    this.root = root;
    this.dev = /(^|[?&#])dev\b/.test(location.search + location.hash);
    this.storage = new GameStorage();
    this.storage.onWriteFailure = (reason) => toast(`Progress could not be saved: ${reason}.`, 'warning');
    this.settings = this.storage.loadSettings();
    this.audio = new AudioEngine(this.settings.audio);
    this.applySettings();
    this.#media?.addEventListener?.('change', () => this.applySettings());
    const unlock = () => this.audio.unlock();
    // iOS Safari only accepts audio unlocks from gestures that end (touchend/click), so listen to both ends.
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) window.addEventListener(type, unlock, { passive: true });
    window.addEventListener('keydown', (e) => this.#onKey(e));
    window.addEventListener('beforeunload', () => this.#saveNow());
    // Mobile browsers often skip beforeunload; pagehide fires when a tab is closed or frozen.
    window.addEventListener('pagehide', () => this.#saveNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.#saveNow();
    });
    if (!this.storage.persistent) {
      setTimeout(() => toast('This browser is not allowing saved data, so progress will be lost when you close the page.', 'warning'), 800);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Settings

  applySettings(): void {
    const s = this.settings;
    const html = document.documentElement;
    if (s.display.theme !== 'system') html.setAttribute('data-theme', s.display.theme);
    else if (this.#hostTheme) html.setAttribute('data-theme', this.#hostTheme);
    else html.removeAttribute('data-theme');
    html.style.setProperty('--ui-scale', String(s.display.uiScale));
    html.classList.toggle('high-contrast', s.display.highContrast);
    const reduced = s.accessibility.motion === 'reduced' || (s.accessibility.motion === 'system' && !!this.#media?.matches);
    html.classList.toggle('reduced-motion', reduced);
    this.motion.reduced = reduced;
    this.motion.speed = SPEEDS[s.gameplay.speed].animation;
    this.audio.apply(s.audio);
    this.announcer.enabled = s.accessibility.announceActions;
  }

  updateSettings(mutate: (s: Settings) => void): void {
    const before = JSON.stringify(this.settings.display);
    mutate(this.settings);
    this.storage.write(this.storage.settings, this.settings);
    this.applySettings();
    if (JSON.stringify(this.settings.display) !== before) this.#table?.table.refreshArt();
  }

  // -------------------------------------------------------------------------------------------
  // Screens

  showMenu(): void {
    this.#leaveTable();
    this.root.dataset.screen = 'menu';
    clear(this.root);
    this.root.append(renderMenu(this));
  }

  showSetup(): void {
    this.#leaveTable();
    this.root.dataset.screen = 'setup';
    clear(this.root);
    this.root.append(renderSetup(this, this.#lastSetup));
  }

  /** True while a saved game still has hands to play. */
  #resumable(s: SessionData): boolean {
    if (s.cash) return !s.cash.cashedOut;
    return s.table.players.filter((p) => !p.eliminated).length > 1;
  }

  async startNewGame(setup: NewGameSetup): Promise<SessionData | null> {
    if (this.storage.session.exists()) {
      const existing = this.storage.session.load();
      const inProgress = existing.status === 'ok' && this.#resumable(existing.payload);
      if (inProgress) {
        const ok = await confirm(
          'Start a new game?',
          'Your game in progress will be replaced. Its hands still count toward your lifetime statistics.',
          'Start new game',
          true,
        );
        if (!ok) return null;
      }
    }
    this.#lastSetup = structuredClone(setup);
    let session: SessionData;
    try {
      session = createSession(setup);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That game could not be set up.', 'error');
      return null;
    }
    // Opponents remember how you have played before (never in the daily challenge, which is the
    // same table for everyone).
    if (!setup.daily && this.settings.gameplay.opponentsRemember) {
      const prior = reputationPrior(this.storage.loadProgress().reputation);
      if (prior) session.statsBook[session.seats[session.humanSeat]!.id] = prior;
    }
    this.storage.write(this.storage.session, session);
    this.storage.write(this.storage.history, { gameId: session.gameId, records: [] });
    this.#openTable(session, []);
    return session;
  }

  /** Today's daily challenge. Only the first game started each day counts for the record. */
  async startDaily(): Promise<void> {
    const today = todayKey();
    const progress = this.storage.loadProgress();
    if (progress.dailyStarted[today]) {
      const done = progress.daily[today];
      const ok = await confirm(
        'Play today’s challenge again?',
        done
          ? 'You have already finished today’s challenge. Another game is practice: it does not change your result or streak.'
          : 'Your first game today was not finished, so today does not count for your streak. You can still play for practice.',
        'Play for practice',
      );
      if (!ok) return;
    }
    const session = await this.startNewGame(dailySetup(today, this.#lastSetup?.playerName ?? 'You'));
    if (session && !progress.dailyStarted[today]) {
      const fresh = this.storage.loadProgress();
      fresh.dailyStarted[today] = session.gameId;
      this.storage.write(this.storage.progress, fresh);
    }
  }

  continueGame(): void {
    const r = this.storage.session.load();
    if (r.status !== 'ok') {
      toast('The saved game could not be loaded.', 'error');
      this.showMenu();
      return;
    }
    if (r.recovered) toast('The most recent save was damaged, so the game resumed from the save before it.', 'warning');
    this.#lastSetup = structuredClone(r.payload.setup);
    this.#openTable(r.payload, this.storage.loadHistory(r.payload.gameId));
  }

  #aiHost(): AiHost {
    if (this.#ai) return this.#ai;
    try {
      if (typeof Worker === 'undefined' || typeof __AI_WORKER_SOURCE__ !== 'string') throw new Error('no worker');
      const url = URL.createObjectURL(new Blob([__AI_WORKER_SOURCE__], { type: 'text/javascript' }));
      const host = new WorkerAiHost(() => new Worker(url));
      host.onError = (m) => this.dev && console.warn(m);
      this.#ai = host;
    } catch {
      this.#ai = new InlineAiHost();
    }
    return this.#ai;
  }

  // -------------------------------------------------------------------------------------------
  // The table

  #openTable(session: SessionData, records: HandHistoryRecord[]): void {
    this.#leaveTable();
    this.root.dataset.screen = 'table';
    clear(this.root);

    const header = h('header', { class: 'topbar' });
    const tableArea = h('div', { class: 'table-area' });
    const log = new LogPanel(() => this.settings.display.fourColorDeck);
    const bar = new ActionBar({
      settings: () => this.settings,
      click: () => this.audio.play('click'),
      confirmAllIn: (amount) => confirm('Go all-in?', `You are about to put all ${chips(amount)} of your chips at risk.`, 'All-in'),
    });
    const screen = h('div', { class: 'screen screen-table' }, header, h('div', { class: 'table-layout' }, tableArea, log.root), bar.root);
    this.root.append(screen);

    const table = new TableView(session.seats.length, this.motion, () => this.settings);
    table.mount(tableArea);

    const ts = { records, nextHand: null, header, table, bar, log } as unknown as TableSession;
    const presenter = new DomPresenter({
      table,
      bar,
      log,
      audio: this.audio,
      motion: this.motion,
      announcer: this.announcer,
      settings: () => this.settings,
      updateHeader: (snap) => this.#renderHeader(header, snap),
      isPaused: () => ts.controller?.paused ?? false,
      onGameOver: (info, snap) => this.#gameOver(info, snap),
      onCashSessionOver: (summary) => this.#cashSessionOver(summary),
      waitForNextHand: (autoMs) => this.#waitForNextHand(ts, autoMs),
      debug: this.dev,
    });
    ts.presenter = presenter;
    const humanSeat = session.humanSeat;
    const controller = new GameController(session, presenter, this.#aiHost(), {
      saveSession: (s) => this.storage.write(this.storage.session, s),
      handRecorded: (record, settlement) => this.#recordHand(ts, session, record, settlement),
      publicHandObserved: (record) => this.#learnReputation(session, record),
      humanFinished: (place, field, prize) => this.#tournamentFinished(session, place, field, prize),
      cashedOut: (summary) => this.#cashedOut(summary),
      thinkTime: (closeness) => {
        const speed = SPEEDS[this.settings.gameplay.speed];
        return (550 + 900 * closeness + Math.random() * 350) * speed.think;
      },
      alwaysShowSeats: () => (this.settings.gameplay.alwaysShowCards ? [humanSeat] : []),
      log: (message, detail) => {
        if (this.dev) console.warn(message, detail);
      },
    });
    ts.controller = controller;
    this.#table = ts;
    if (this.dev) {
      (globalThis as Record<string, unknown>).__velvet = {
        snapshot: () => controller.snapshot(),
        display: () => presenter.display,
        session: () => controller.session,
        records: () => ts.records,
        aiMode: () => this.#ai?.mode ?? 'none',
      };
    }
    controller.run().catch((e) => {
      console.error(e);
    });
  }

  #recordHand(ts: TableSession, session: SessionData, record: HandHistoryRecord, settlement: HandSettlement): void {
    ts.records.push(record);
    if (ts.records.length > HISTORY_LIMIT) ts.records.splice(0, ts.records.length - HISTORY_LIMIT);
    this.storage.write(this.storage.history, { gameId: session.gameId, records: ts.records });
    const career = this.storage.loadCareer();
    recordHand(career, record);
    this.storage.write(this.storage.career, career);
    // A knockout: an opponent busted in a hand where you won chips they had put in.
    const me = record.humanSeat;
    const knockouts = settlement.eliminations.filter(
      (e) => e.seat !== me && record.pots.some((p) => (p.contributions[e.seat] ?? 0) > 0 && p.shares.some((s) => s.seat === me)),
    ).length;
    this.#progress((p) => achievementsForHand(p, record, { cash: session.setup.mode === 'cash', eliminatedBy: knockouts }));
  }

  /** Updates what opponents remember about you, from the hand's public record only. */
  #learnReputation(session: SessionData, record: PublicHandRecord): void {
    if (session.setup.daily || !this.settings.gameplay.opponentsRemember) return;
    const id = session.seats[session.humanSeat]!.id;
    if (!record.players.some((p) => p.id === id)) return;
    this.#progress((p) => {
      const book = { [id]: p.reputation ?? emptyModelStats() };
      observeHand(book, record);
      p.reputation = book[id]!;
      return [];
    });
  }

  #tournamentFinished(session: SessionData, place: number, field: number, prize: number): void {
    const career = this.storage.loadCareer();
    recordFinish(career, place, field, prize);
    this.storage.write(this.storage.career, career);
    this.#progress((p) => {
      const ids = achievementsForTournament({
        place,
        fieldSize: field,
        paidPlaces: PAYOUTS[session.setup.payout].places.length,
        difficulty: session.setup.difficulty,
      });
      const date = session.setup.daily;
      if (date) {
        const hands = session.table.handNumber;
        const { official } = recordDaily(p, date, session.gameId, { place, fieldSize: field, hands, prize, finishedAt: new Date().toISOString() });
        ids.push(...achievementsForDaily(p, date, { place, official }));
      }
      return ids;
    });
  }

  #cashedOut(summary: CashSummary): void {
    const career = this.storage.loadCareer();
    recordCashSession(career, summary);
    this.storage.write(this.storage.career, career);
    this.#progress(() => (summary.net >= 50 * summary.bigBlind ? ['cash-profit'] : []));
  }

  #cashSessionOver(summary: CashSummary): void {
    if (summary.net > 0) this.audio.play('winBig');
    openCashSummary(this, summary);
  }

  /** Loads progress, applies a change that may earn achievements, saves, and celebrates. */
  #progress(change: (p: ProgressData) => Parameters<typeof unlock>[1]): void {
    const p = this.storage.loadProgress();
    const earned = unlock(p, change(p));
    this.storage.write(this.storage.progress, p);
    this.#celebrate(earned);
  }

  #celebrate(earned: Achievement[]): void {
    earned.forEach((a, i) => {
      setTimeout(() => {
        const reward = a.unlocks?.felt ? ` New table felt unlocked.` : a.unlocks?.cardBack ? ` New card back unlocked.` : '';
        toast(`Achievement: ${a.title} — ${a.description}${reward}`, 'info', 5200);
        this.announcer.say(`Achievement unlocked: ${a.title}.`);
        this.audio.play('levelUp');
      }, 900 * i);
    });
  }

  /** Cash games: leave the table (now, or after the hand in progress). */
  cashOut(): void {
    const ts = this.#table;
    if (!ts) return;
    if (ts.controller.requestCashOut() === 'after-hand') toast('You will cash out when this hand is over.');
  }

  get inCashGame(): boolean {
    const s = this.#table?.controller.session;
    return !!s?.cash && !s.cash.cashedOut;
  }

  #waitForNextHand(ts: TableSession, autoMs: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        ts.nextHand = null;
        btn.remove();
        ts.bar.root.classList.remove('is-between');
        resolve();
      };
      const btn = h('button', { type: 'button', class: 'btn btn--primary next-hand' }, 'Deal next hand', h('kbd', {}, 'Space')) as HTMLButtonElement;
      btn.addEventListener('click', done);
      ts.bar.root.querySelector('.bar-buttons')?.append(btn);
      ts.bar.root.classList.add('is-between');
      ts.nextHand = done;
      const arm = () => {
        if (autoMs < 0) return;
        if (ts.controller.paused) {
          timer = setTimeout(arm, 300);
          return;
        }
        timer = setTimeout(done, autoMs);
      };
      arm();
      if (autoMs < 0) btn.focus({ preventScroll: true });
    });
  }

  #renderHeader(header: HTMLElement, snap: TableSnapshot): void {
    clear(header);
    const level =
      snap.handsUntilNextLevel !== null && snap.nextBlinds
        ? `Level ${snap.level} · ${snap.nextBlinds.smallBlind}/${snap.nextBlinds.bigBlind} in ${snap.handsUntilNextLevel} ${snap.handsUntilNextLevel === 1 ? 'hand' : 'hands'}`
        : `Level ${snap.level}`;
    const alive = snap.seats.filter((s) => !s.eliminated).length;
    header.append(
      h(
        'div',
        { class: 'brand' },
        h('span', { class: 'brand-mark' }, 'Velvet'),
        h('span', { class: 'brand-sub' }, DIFFICULTIES[this.#table?.controller?.session.setup.difficulty ?? 'standard']?.label ?? ''),
      ),
      h(
        'div',
        { class: 'hand-info' },
        h('span', { class: 'info-chip' }, `Hand ${snap.handNumber}`),
        h(
          'span',
          { class: 'info-chip info-chip--strong' },
          `Blinds ${chips(snap.blinds.smallBlind)}/${chips(snap.blinds.bigBlind)}${snap.blinds.ante ? ` · ante ${chips(snap.blinds.ante)}` : ''}`,
        ),
        ...this.#modeChips(snap, level, alive),
        snap.daily ? h('span', { class: 'info-chip info-daily', title: 'Today’s daily challenge: the same deals for everyone' }, `Daily ${snap.daily}`) : null,
        snap.seeded ? h('span', { class: 'info-chip info-dev', title: 'Developer game with a fixed seed' }, 'Seeded') : null,
      ),
      h(
        'nav',
        { class: 'top-actions', 'aria-label': 'Game menu' },
        iconButton(ICONS.log, 'Table log (L)', () => this.toggleLog(), 'only-narrow'),
        iconButton(ICONS.history, 'Hand history (H)', () => this.openHistory()),
        iconButton(ICONS.stats, 'Statistics (T)', () => this.openStats()),
        iconButton(this.settings.audio.muted ? ICONS.soundOff : ICONS.soundOn, this.settings.audio.muted ? 'Unmute (M)' : 'Mute (M)', () => this.toggleMute()),
        iconButton(ICONS.pause, 'Pause and menu (P)', () => this.pauseMenu()),
      ),
    );
  }

  #modeChips(snap: TableSnapshot, level: string, alive: number): HTMLElement[] {
    if (snap.cash) {
      const me = snap.seats[snap.humanSeat]!;
      const net = me.stack - snap.cash.humanBuyIns * snap.cash.buyIn;
      return [
        h('span', { class: 'info-chip info-muted' }, `Cash game · buy-in ${chips(snap.cash.buyIn)}`),
        h(
          'span',
          { class: `info-chip ${net > 0 ? 'info-pos' : net < 0 ? 'info-neg' : 'info-muted'}`, title: 'Your stack minus everything you bought in for' },
          `Net ${signed(net)}`,
        ),
        snap.cash.leaving ? h('span', { class: 'info-chip info-muted' }, 'Cashing out after this hand') : null,
      ].filter((x): x is HTMLElement => x !== null);
    }
    const paid = snap.prizes.length;
    return [
      h('span', { class: 'info-chip info-muted' }, level),
      h('span', { class: 'info-chip info-muted' }, `${alive} of ${snap.seats.length} left`),
      ...(paid > 1
        ? [
            h(
              'span',
              { class: 'info-chip info-muted', title: `Prizes: ${snap.prizes.map((p, i) => `${ordinal(i + 1)} ${p}`).join(' · ')}` },
              `Top ${paid} paid`,
            ),
          ]
        : []),
    ];
  }

  toggleLog(): void {
    this.root.classList.toggle('log-open');
  }

  toggleMute(): void {
    this.updateSettings((s) => (s.audio.muted = !s.audio.muted));
    toast(this.settings.audio.muted ? 'Sound off' : 'Sound on');
    const snap = this.#table?.presenter.lastSnapshot;
    if (snap && this.#table) this.#renderHeader(this.#table.header, snap);
  }

  /** Pauses the game while an information sheet is open over the table; returns the resume hook. */
  #holdTable(): (() => void) | undefined {
    const ts = this.#table;
    if (!ts || ts.controller.paused) return undefined;
    ts.controller.pause();
    return () => {
      if (this.#table === ts) ts.controller.resume();
    };
  }

  openHistory(): void {
    openHistory(this, this.#table?.records ?? this.#savedRecords(), this.#holdTable());
  }

  openStats(): void {
    openStats(this, this.#table ? this.#table.controller.session.playerStats : null, this.#holdTable());
  }

  openSettings(): void {
    openSettings(this, this.#holdTable());
  }

  openHelp(): void {
    openHelp(this, this.#holdTable());
  }

  #savedRecords(): HandHistoryRecord[] {
    const r = this.storage.session.load();
    return r.status === 'ok' ? this.storage.loadHistory(r.payload.gameId) : [];
  }

  pauseMenu(): void {
    const ts = this.#table;
    if (!ts || dialogOpen()) return;
    ts.controller.pause();
    openPauseMenu(this, () => ts.controller.resume());
  }

  quitToMenu(): void {
    this.#saveNow();
    this.showMenu();
  }

  #leaveTable(): void {
    const ts = this.#table;
    if (!ts) return;
    this.#table = null;
    ts.controller.stop();
    ts.bar.cancel();
    ts.nextHand?.();
    ts.table.destroy();
    this.motion.endSkip();
    delete (globalThis as Record<string, unknown>).__velvet;
  }

  #saveNow(): void {
    const ts = this.#table;
    if (ts) this.storage.write(this.storage.session, ts.controller.session);
  }

  #gameOver(info: GameOverInfo, snap: TableSnapshot): void {
    const stats = this.#table?.controller.session.playerStats ?? null;
    const title = info.humanPlace === 1 ? 'You win the game!' : `${info.winnerName} wins`;
    if (info.humanPlace === 1) this.audio.play('winBig');
    openGameOver(this, { title, info, snapshot: snap, stats });
  }

  playAgain(): void {
    const last = this.#lastSetup;
    if (!last) this.showSetup();
    else if (last.daily) void this.startDaily();
    else void this.startNewGame({ ...last, seed: last.seed ? `${last.seed}+` : undefined });
  }

  openAchievements(): void {
    openAchievements(this, this.#holdTable());
  }

  // -------------------------------------------------------------------------------------------

  #onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (dialogOpen()) return;
    const ts = this.#table;
    if (!ts || this.root.dataset.screen !== 'table') return;
    if (ts.bar.handleKey(e)) {
      e.preventDefault();
      return;
    }
    const target = e.target as HTMLElement;
    const inField = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
    if (inField) return;
    switch (e.key) {
      case ' ':
      case 'Enter':
        if (target instanceof HTMLButtonElement && e.key === 'Enter') return;
        e.preventDefault();
        if (ts.nextHand) ts.nextHand();
        else {
          this.motion.skip();
          ts.controller.hurry();
        }
        break;
      case 'p':
      case 'P':
      case 'Escape':
        e.preventDefault();
        this.pauseMenu();
        break;
      case 'h':
      case 'H':
        this.openHistory();
        break;
      case 't':
      case 'T':
        this.openStats();
        break;
      case 'l':
      case 'L':
        this.toggleLog();
        break;
      case 'm':
      case 'M':
        this.toggleMute();
        break;
      case '?':
        this.openHelp();
        break;
      default:
        if (!ts.bar.waiting && /^[fcrbak]$/i.test(e.key)) toast('Not your turn yet', 'info', 1400);
    }
  }

  /** Summary line for the Continue button. */
  savedGameSummary(): { ok: true; text: string } | { ok: false; reason: string } | null {
    const r = this.storage.session.load();
    if (r.status === 'missing') return null;
    if (r.status !== 'ok') return { ok: false, reason: r.reason };
    const s = r.payload;
    if (!this.#resumable(s)) return null;
    if (s.cash) {
      const me = s.table.players[s.humanSeat]!;
      const live = s.table.hand && s.table.hand.phase !== 'complete' ? s.table.hand : null;
      const stack = live ? (live.seats[s.humanSeat]?.stack ?? me.stack) : me.stack;
      const net = stack - (s.cash.buyIns[s.seats[s.humanSeat]!.id] ?? 1) * s.cash.buyIn;
      return { ok: true, text: `Cash game · hand ${live ? s.table.handNumber : s.table.handNumber + 1} · your stack ${chips(stack)} (${signed(net)})` };
    }
    const alive = s.table.players.filter((p) => !p.eliminated);
    if (alive.length <= 1) return null;
    const me = s.table.players[s.humanSeat]!;
    const live = s.table.hand && s.table.hand.phase !== 'complete' ? s.table.hand : null;
    const hand = live ? s.table.handNumber : s.table.handNumber + 1;
    const stack = live ? (live.seats[s.humanSeat]?.stack ?? me.stack) : me.stack;
    const mine = me.eliminated ? `you finished ${ordinal(me.place ?? 0)}` : `your stack ${chips(stack)}${live ? ' (hand in progress)' : ''}`;
    return { ok: true, text: `Hand ${hand} · ${alive.length} players left · ${mine}` };
  }
}
