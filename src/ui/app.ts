import { AudioEngine } from '../audio/audio.ts';
import { ICONS } from '../assets/icons.ts';
import { type AiHost, InlineAiHost, WorkerAiHost } from '../ai/host.ts';
import { DIFFICULTIES } from '../ai/profiles.ts';
import { type NewGameSetup } from '../game/config.ts';
import { GameController, type GameOverInfo, type TableSnapshot } from '../game/controller.ts';
import type { HandHistoryRecord } from '../game/history.ts';
import { createSession, type SessionData } from '../game/session.ts';
import { SPEEDS, type Settings } from '../game/settings.ts';
import { recordFinish, recordHand } from '../game/stats.ts';
import { GameStorage, HISTORY_LIMIT } from '../game/storage.ts';
import { ActionBar } from './action-bar.ts';
import { Announcer, confirm, dialogOpen, toast } from './dialogs.ts';
import { clear, h, iconButton } from './dom.ts';
import { chips, ordinal } from './format.ts';
import { LogPanel } from './log-panel.ts';
import { Motion } from './motion.ts';
import { DomPresenter } from './presenter.ts';
import { renderMenu, renderSetup } from './screens.ts';
import { openGameOver, openHelp, openHistory, openPauseMenu, openSettings, openStats } from './sheets.ts';
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
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    window.addEventListener('keydown', (e) => this.#onKey(e));
    window.addEventListener('beforeunload', () => this.#saveNow());
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

  async startNewGame(setup: NewGameSetup): Promise<void> {
    if (this.storage.session.exists()) {
      const existing = this.storage.session.load();
      const inProgress = existing.status === 'ok' && existing.payload.table.players.filter((p) => !p.eliminated).length > 1;
      if (inProgress) {
        const ok = await confirm('Start a new game?', 'Your game in progress will be replaced. Its hands still count toward your lifetime statistics.', 'Start new game', true);
        if (!ok) return;
      }
    }
    this.#lastSetup = structuredClone(setup);
    let session: SessionData;
    try {
      session = createSession(setup);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That game could not be set up.', 'error');
      return;
    }
    this.storage.write(this.storage.session, session);
    this.storage.write(this.storage.history, { gameId: session.gameId, records: [] });
    this.#openTable(session, []);
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
      waitForNextHand: (autoMs) => this.#waitForNextHand(ts, autoMs),
      debug: this.dev,
    });
    ts.presenter = presenter;
    const humanSeat = session.humanSeat;
    const controller = new GameController(session, presenter, this.#aiHost(), {
      saveSession: (s) => this.storage.write(this.storage.session, s),
      handRecorded: (record) => this.#recordHand(ts, session.gameId, record),
      humanFinished: (place, field) => {
        const career = this.storage.loadCareer();
        recordFinish(career, place, field);
        this.storage.write(this.storage.career, career);
      },
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

  #recordHand(ts: TableSession, gameId: string, record: HandHistoryRecord): void {
    ts.records.push(record);
    if (ts.records.length > HISTORY_LIMIT) ts.records.splice(0, ts.records.length - HISTORY_LIMIT);
    this.storage.write(this.storage.history, { gameId, records: ts.records });
    const career = this.storage.loadCareer();
    recordHand(career, record);
    this.storage.write(this.storage.career, career);
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
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, 'Velvet'), h('span', { class: 'brand-sub' }, DIFFICULTIES[this.#table?.controller?.session.setup.difficulty ?? 'standard']?.label ?? '')),
      h(
        'div',
        { class: 'hand-info' },
        h('span', { class: 'info-chip' }, `Hand ${snap.handNumber}`),
        h('span', { class: 'info-chip info-chip--strong' }, `Blinds ${chips(snap.blinds.smallBlind)}/${chips(snap.blinds.bigBlind)}`),
        h('span', { class: 'info-chip info-muted' }, level),
        h('span', { class: 'info-chip info-muted' }, `${alive} of ${snap.seats.length} left`),
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
    if (this.#lastSetup) void this.startNewGame({ ...this.#lastSetup, seed: this.#lastSetup.seed ? `${this.#lastSetup.seed}+` : undefined });
    else this.showSetup();
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
