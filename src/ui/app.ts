import { AudioEngine } from '../audio/audio.ts';
import { ICONS } from '../assets/icons.ts';
import type { Decision, DecisionRequest } from '../ai/decide.ts';
import { type AiHost, InlineAiHost, WorkerAiHost } from '../ai/host.ts';
import { emptyStats as emptyModelStats, observeHand } from '../ai/model.ts';
import { DEFAULT_PERSONAS, DIFFICULTIES } from '../ai/profiles.ts';
import type { HandSettlement } from '../engine/game.ts';
import type { PublicHandRecord } from '../engine/records.ts';
import { applyBackup, exportBackup, readBackup } from '../game/backup.ts';
import { dailySetup, defaultSetup, MAX_OPPONENTS, type NewGameSetup, PAYOUTS, payoutsFor, todayKey, validateSetup } from '../game/config.ts';
import { type CashSummary, type ControllerHooks, GameController, type GameOverInfo, type TableSnapshot } from '../game/controller.ts';
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
import { adviceText } from '../game/review.ts';
import { browserStore } from '../game/persistence.ts';
import { createSession, type SessionData } from '../game/session.ts';
import { SPEEDS, type Settings } from '../game/settings.ts';
import { recordCashSession, recordFinish, recordHand } from '../game/stats.ts';
import { GameStorage, HISTORY_LIMIT } from '../game/storage.ts';
import { ActionBar } from './action-bar.ts';
import { Announcer, closeAllSheets, confirm, dialogOpen, toast } from './dialogs.ts';
import { clear, h, iconButton } from './dom.ts';
import { chips, ordinal, signed } from './format.ts';
import { LogPanel } from './log-panel.ts';
import { Motion } from './motion.ts';
import { DomPresenter, type PresenterDeps } from './presenter.ts';
import { renderFriends, renderGuestLobby, renderHostLobby } from './online-screens.ts';
import { openReplayer } from './replayer.ts';
import { renderMenu, renderSetup } from './screens.ts';
import { openAchievements, openCashSummary, openGameOver, openHelp, openHistory, openPauseMenu, openSettings, openStats } from './sheets.ts';
import { TableView } from './table-view.ts';
import { GuestDriver } from '../net/guest.ts';
import { GuestClient, HostLobby } from '../net/lobby.ts';
import { formatRoomCode, type LobbyPlayer, newRoomCode, parseRoomCode } from '../net/protocol.ts';
import type { RemotePresenter } from '../net/remote.ts';
import { BroadcastRoom, type PeerRoom } from '../net/room.ts';

declare const __AI_WORKER_SOURCE__: string;

interface TableSession {
  /** The game itself; null on a friend's screen, where the host's messages drive the table. */
  controller: GameController | null;
  /** A friend's screen: plays the host's messages. */
  guest: GuestDriver | null;
  online: 'host' | 'guest' | null;
  /** Online games: the table code. */
  code: string | null;
  finished: boolean;
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
  #playerName: string | null = null;
  #lobby: HostLobby | null = null;
  #client: GuestClient | null = null;
  #onlineSetup: NewGameSetup | null = null;
  /** Bumped whenever the connection changes, so a slow load never revives an abandoned table. */
  #netTicket = 0;
  #netLoad: Promise<void> | null = null;
  #media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  /** Theme the hosting page chose (if any); "System" defers to it. */
  readonly #hostTheme = document.documentElement.getAttribute('data-theme');

  constructor(root: HTMLElement) {
    this.root = root;
    this.dev = /(^|[?&#])dev\b/.test(location.search + location.hash);
    this.storage = new GameStorage();
    this.storage.onWriteFailure = (reason) => toast(`Progress could not be saved: ${reason}.`, 'warning');
    this.settings = this.storage.loadSettings();
    // The recordings ship beside the page on the website build; the single-file builds synthesise.
    const hosted = /^https?:$/.test(location.protocol) && !!document.querySelector('link[rel="manifest"]');
    this.audio = new AudioEngine(this.settings.audio, hosted ? new URL('sounds.bin', document.baseURI).href : null);
    this.applySettings();
    this.#media?.addEventListener?.('change', () => this.applySettings());
    const unlock = () => this.audio.unlock();
    // iOS Safari only accepts audio unlocks from gestures that end (touchend/click), so listen to both ends.
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) window.addEventListener(type, unlock, { passive: true });
    window.addEventListener('keydown', (e) => this.#onKey(e));
    // An invite link opened in a tab that already shows the game (only the #fragment changes).
    window.addEventListener('hashchange', () => {
      if (/[#&]join=/.test(location.hash) && !this.#table && !this.#lobby && !this.#client) this.start();
    });
    window.addEventListener('beforeunload', () => this.#saveNow());
    // Mobile browsers often skip beforeunload; pagehide fires when a tab is closed or frozen.
    window.addEventListener('pagehide', () => this.#saveNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.#saveNow();
      // Online, a hidden tab must not hold up the table with animations nobody can see.
      this.motion.suspended = !!this.#table?.online && document.hidden;
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
    this.#disconnect();
    this.root.dataset.screen = 'menu';
    clear(this.root);
    this.root.append(renderMenu(this));
  }

  showSetup(): void {
    this.#leaveTable();
    this.#disconnect();
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
  // Games with friends (src/net)

  /** The name last used, to prefill forms ("You" is the solo default and not a real name). */
  get playerName(): string {
    const n = this.#playerName ?? this.#lastSetup?.playerName ?? '';
    return n === 'You' ? '' : n;
  }

  /** Whether the table on screen is an online game, and whose. */
  get onlineRole(): 'host' | 'guest' | null {
    return this.#table?.online ?? null;
  }

  /** First screen: an invite link opens the join form (or rejoins the table after a reload). */
  start(): void {
    const code = /[#&]join=/.test(location.hash) ? parseRoomCode(location.hash) : null;
    if (!code) {
      this.showMenu();
      return;
    }
    const remembered = this.#rememberedSeat(code);
    if (remembered) void this.joinTable(code, remembered.name);
    else this.showFriends(code);
  }

  showFriends(code: string | null = null): void {
    this.#leaveTable();
    this.#disconnect(!!code);
    closeAllSheets();
    this.root.dataset.screen = 'friends';
    clear(this.root);
    this.root.append(renderFriends(this, code));
  }

  async #room(code: string): Promise<PeerRoom> {
    // Developer mode can keep a table inside one browser (tabs talk over a BroadcastChannel).
    if (this.dev && /[#&?]net=local\b/.test(location.hash + location.search)) return new BroadcastRoom(code);
    await this.#loadNet();
    const net = (globalThis as { __velvetNet?: { trysteroRoom(code: string): PeerRoom } }).__velvetNet;
    if (!net) throw new Error('Online play could not be started in this browser.');
    return net.trysteroRoom(code);
  }

  /** Loads dist/net.js (the WebRTC layer) the first time it is needed. */
  #loadNet(): Promise<void> {
    if ((globalThis as { __velvetNet?: unknown }).__velvetNet) return Promise.resolve();
    this.#netLoad ??= new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('net.js', document.baseURI).href;
      script.onload = () => resolve();
      script.onerror = () => {
        script.remove();
        this.#netLoad = null;
        reject(
          new Error(
            /^https?:$/.test(location.protocol) ? 'Online play could not be loaded. Check your internet connection.' : 'Online play works on the website only.',
          ),
        );
      };
      document.head.append(script);
    });
    return this.#netLoad;
  }

  /** Ends any connection to a table with friends (closing it, for the host). */
  #disconnect(keepLink = false): void {
    this.#netTicket++;
    this.#lobby?.close();
    this.#lobby = null;
    this.#client?.leave();
    this.#client = null;
    if (!keepLink && /[#&]join=/.test(location.hash)) {
      try {
        history.replaceState(null, '', location.href.replace(/[#&]join=[^&#]*/, ''));
      } catch {
        /* the address cannot be changed here (a sandboxed frame): harmless */
      }
    }
  }

  async hostTable(name: string): Promise<void> {
    this.#leaveTable();
    this.#disconnect();
    this.#playerName = name;
    const code = newRoomCode();
    const ticket = this.#netTicket;
    let room: PeerRoom;
    try {
      room = await this.#room(code);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Online play could not be started.', 'error');
      return;
    }
    if (ticket !== this.#netTicket) {
      room.leave();
      return;
    }
    this.#lobby = new HostLobby(room, code, name);
    this.#onlineSetup ??= { ...defaultSetup(), opponents: [], startingStack: 1500, payout: 'winner' };
    this.#onlineSetup.playerName = name;
    this.#showHostLobby();
  }

  #showHostLobby(): void {
    const lobby = this.#lobby;
    if (!lobby || lobby.closed) {
      this.showFriends();
      return;
    }
    closeAllSheets();
    this.root.dataset.screen = 'lobby';
    clear(this.root);
    this.root.append(renderHostLobby(this, lobby, this.#onlineSetup!));
  }

  /** Seats `count` AI opponents, named so nobody at the table shares a name. */
  fillAiSeats(setup: NewGameSetup, count: number, guestNames: string[]): void {
    const taken = new Set([setup.playerName, ...guestNames].map((n) => n.trim().toLowerCase()));
    const kept = setup.opponents.filter((o) => !taken.has(o.name.trim().toLowerCase())).slice(0, count);
    for (const o of kept) taken.add(o.name.toLowerCase());
    for (const p of DEFAULT_PERSONAS) {
      if (kept.length >= count) break;
      if (!taken.has(p.name.toLowerCase())) {
        kept.push({ name: p.name, style: p.style });
        taken.add(p.name.toLowerCase());
      }
    }
    for (let i = 1; kept.length < count; i++) if (!taken.has(`bot ${i}`)) kept.push({ name: `Bot ${i}`, style: 'random' });
    setup.opponents = kept;
  }

  startOnlineGame(lobby: HostLobby, setup: NewGameSetup): void {
    const s: NewGameSetup = structuredClone(setup);
    s.playerName = lobby.hostName;
    const names = lobby.guests.filter((g) => g.connected).map((g) => g.name);
    this.fillAiSeats(s, Math.min(s.opponents.length, MAX_OPPONENTS - names.length), names);
    s.guests = names.length;
    const problem = validateSetup(s);
    if (problem) {
      toast(problem, 'warning');
      return;
    }
    const { guests, remotes } = lobby.start();
    let session: SessionData;
    try {
      session = createSession({ ...s, guests: guests.length }, guests);
    } catch (e) {
      lobby.reopen();
      toast(e instanceof Error ? e.message : 'That game could not be set up.', 'error');
      return;
    }
    this.#openTable(session, [], { lobby, remotes });
  }

  /** After an online game: everyone still connected goes back to the lobby. */
  #rematch(): void {
    const lobby = this.#lobby;
    this.#leaveTable();
    if (!lobby || lobby.closed) {
      this.showFriends();
      return;
    }
    lobby.reopen();
    this.#showHostLobby();
  }

  #rememberedSeat(code: string): { token: string; name: string } | null {
    try {
      const v = JSON.parse(sessionStorage.getItem(`velvet.table.${code}`) ?? 'null') as { token?: unknown; name?: unknown } | null;
      return v && typeof v.token === 'string' && typeof v.name === 'string' ? { token: v.token, name: v.name } : null;
    } catch {
      return null;
    }
  }

  async joinTable(code: string, name: string): Promise<void> {
    this.#leaveTable();
    this.#disconnect(true);
    this.#playerName = name;
    const ticket = this.#netTicket;
    let room: PeerRoom;
    try {
      room = await this.#room(code);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Online play could not be started.', 'error');
      return;
    }
    if (ticket !== this.#netTicket) {
      room.leave();
      return;
    }
    // The same token after a reload puts this browser back in its seat.
    const remembered = this.#rememberedSeat(code);
    const token = remembered?.token ?? Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      sessionStorage.setItem(`velvet.table.${code}`, JSON.stringify({ token, name }));
    } catch {
      /* private mode: a reload will join as someone new */
    }
    // Keep the table in the address, so a reload comes straight back (other #flags stay).
    try {
      const url = new URL(location.href);
      url.hash = [
        ...url.hash
          .slice(1)
          .split('&')
          .filter((p) => p && !p.startsWith('join=')),
        `join=${code}`,
      ].join('&');
      history.replaceState(null, '', url.href);
    } catch {
      /* the address cannot be changed here: harmless */
    }
    const client = new GuestClient(room, name, token);
    this.#client = client;
    const view = renderGuestLobby(this, code);
    let players: LobbyPlayer[] = [];
    let driver: GuestDriver | null = null;
    const showLobby = () => {
      this.#leaveTable();
      closeAllSheets();
      driver = null;
      this.root.dataset.screen = 'lobby';
      clear(this.root);
      this.root.append(view.root);
      view.update(client.state, players);
    };
    showLobby();
    client.onLobby = (list) => {
      players = list;
      if (this.#table?.online === 'guest' || !view.root.isConnected) showLobby(); // the host is starting a rematch
      view.update(client.state, players);
    };
    client.onState = (state) => {
      if (this.#table?.online !== 'guest') view.update(state, players);
      else if (state === 'reconnecting') toast('Lost the connection to the host. Reconnecting…', 'warning', 6000);
      else if (state === 'playing') toast('Reconnected');
    };
    client.onTable = (message) => {
      if (!driver || this.#table?.online !== 'guest') {
        // The game starts (or resumes after a reconnection) with the whole table.
        if (message.t !== 'call' || message.m !== 'reset') return;
        driver = this.#openGuestTable(client, code, message.a[0] as TableSnapshot);
      }
      driver.receive(message);
    };
    client.onClosed = (reason) => {
      if (this.#client !== client) return;
      this.#client = null;
      try {
        sessionStorage.removeItem(`velvet.table.${code}`);
      } catch {
        /* nothing to forget */
      }
      if (this.#table?.online === 'guest' && this.#table.finished) {
        toast(reason, 'info', 6000);
        return;
      }
      this.showFriends();
      toast(reason, 'warning', 8000);
    };
  }

  // -------------------------------------------------------------------------------------------
  // The table

  /** Builds the table screen (header, table, log, action bar). */
  #mountTable(seatCount: number, viewSeat: number, records: HandHistoryRecord[], online: TableSession['online'], code: string | null): TableSession {
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

    const table = new TableView(seatCount, this.motion, () => this.settings, viewSeat);
    table.mount(tableArea);
    this.motion.suspended = !!online && document.hidden;
    return { controller: null, guest: null, online, code, finished: false, records, nextHand: null, header, table, bar, log } as unknown as TableSession;
  }

  #presenterFor(ts: TableSession, extra: Pick<PresenterDeps, 'advise'> & Partial<Pick<PresenterDeps, 'waitForNextHand'>>): DomPresenter {
    const presenter = new DomPresenter({
      table: ts.table,
      bar: ts.bar,
      log: ts.log,
      audio: this.audio,
      motion: this.motion,
      announcer: this.announcer,
      settings: () => this.settings,
      updateHeader: (snap) => this.#renderHeader(ts.header, snap),
      isPaused: () => ts.controller?.paused ?? false,
      onGameOver: (info, snap) => this.#gameOver(info, snap),
      onCashSessionOver: (summary) => this.#cashSessionOver(summary),
      waitForNextHand: extra.waitForNextHand ?? ((autoMs) => this.#waitForNextHand(ts, autoMs)),
      ...(extra.advise ? { advise: extra.advise } : {}),
      ...(ts.online ? { online: ts.online } : {}),
      debug: this.dev,
    });
    ts.presenter = presenter;
    return presenter;
  }

  #openTable(session: SessionData, records: HandHistoryRecord[], online?: { lobby: HostLobby; remotes: Map<number, RemotePresenter> }): void {
    const ts = this.#mountTable(session.seats.length, session.humanSeat, records, online ? 'host' : null, online?.lobby.code ?? null);
    const presenter = this.#presenterFor(ts, { advise: (snap) => this.#advise(session, snap) });
    // "Main menu" after being knocked out: leave once the game has recorded the choice.
    const eliminated = presenter.humanEliminated.bind(presenter);
    presenter.humanEliminated = async (place: number, fieldSize: number) => {
      const choice = await eliminated(place, fieldSize);
      if (choice === 'menu') setTimeout(() => this.#table === ts && this.quitToMenu(), 0);
      return choice;
    };
    const humanSeat = session.humanSeat;
    const timing: ControllerHooks = {
      thinkTime: (closeness) => {
        const speed = SPEEDS[this.settings.gameplay.speed];
        return (550 + 900 * closeness + Math.random() * 350) * speed.think;
      },
      alwaysShowSeats: () => (this.settings.gameplay.alwaysShowCards ? [humanSeat] : []),
      log: (message, detail) => {
        if (this.dev) console.warn(message, detail);
      },
    };
    // Games with friends are not saved and do not count toward statistics or achievements.
    const hooks: ControllerHooks = online
      ? { ...timing, handRecorded: (record) => this.#keepRecord(ts, record) }
      : {
          ...timing,
          saveSession: (s) => this.storage.write(this.storage.session, s),
          handRecorded: (record, settlement) => this.#recordHand(ts, session, record, settlement),
          publicHandObserved: (record) => this.#learnReputation(session, record),
          humanFinished: (place, field, prize) => this.#tournamentFinished(session, place, field, prize),
          cashedOut: (summary) => this.#cashedOut(summary),
        };
    const controller = new GameController(session, presenter, this.#aiHost(), hooks, online?.remotes);
    ts.controller = controller;
    this.#table = ts;
    if (online) online.lobby.onNotice = (message) => toast(message, 'info', 5000);
    if (this.dev) {
      (globalThis as Record<string, unknown>).__velvet = {
        snapshot: () => controller.snapshot(),
        display: () => presenter.display,
        session: () => controller.session,
        records: () => ts.records,
        aiMode: () => this.#ai?.mode ?? 'none',
        recordedSound: () => this.audio.recorded,
        online: () => ts.online,
      };
    }
    controller.run().catch((e) => {
      console.error(e);
    });
  }

  /** A friend's view of an online game: the host's messages drive an ordinary presenter. */
  #openGuestTable(client: GuestClient, code: string, first: TableSnapshot): GuestDriver {
    const ts = this.#mountTable(first.seats.length, first.humanSeat, [], 'guest', code);
    const presenter = this.#presenterFor(ts, {
      advise: undefined,
      waitForNextHand: () => {
        ts.bar.idle('Waiting for the next hand');
        return driver.whenMessage();
      },
    });
    const handFinished = presenter.handFinished.bind(presenter);
    presenter.handFinished = (summary, snap) => {
      this.#keepRecord(ts, summary.record);
      return handFinished(summary, snap);
    };
    const driver = new GuestDriver(presenter, (m) => client.send(m), {
      cancelDecision: () => {
        ts.bar.cancel();
        toast('Time ran out, so your hand was checked or folded.', 'warning');
      },
      clock: (seconds) => {
        if (ts.bar.waiting) ts.bar.setHint(seconds === null ? '' : `${seconds} s left to act`);
      },
      eliminated: (choice) => {
        if (choice === 'menu' && this.#table === ts) this.showMenu();
      },
      failed: (error) => console.error(error),
    });
    ts.guest = driver;
    this.#table = ts;
    if (this.dev) {
      (globalThis as Record<string, unknown>).__velvet = {
        snapshot: () => presenter.lastSnapshot,
        display: () => presenter.display,
        records: () => ts.records,
        recordedSound: () => this.audio.recorded,
        online: () => ts.online,
      };
    }
    return driver;
  }

  #keepRecord(ts: TableSession, record: HandHistoryRecord): void {
    ts.records.push(record);
    if (ts.records.length > HISTORY_LIMIT) ts.records.splice(0, ts.records.length - HISTORY_LIMIT);
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
    if (!ts?.controller) return;
    if (ts.controller.requestCashOut() === 'after-hand') {
      toast('You will cash out when this hand is over.');
      this.#renderHeader(ts.header, ts.controller.snapshot());
    }
  }

  get inCashGame(): boolean {
    const s = this.#table?.controller?.session;
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
        if (ts.controller?.paused) {
          timer = setTimeout(arm, 300);
          return;
        }
        // A sheet opened in the meantime pauses the game: wait for it instead of dealing.
        timer = setTimeout(() => (ts.controller?.paused ? arm() : done()), autoMs);
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
        h(
          'span',
          { class: 'brand-sub' },
          this.#table?.online ? 'With friends' : (DIFFICULTIES[this.#table?.controller?.session.setup.difficulty ?? 'standard']?.label ?? ''),
        ),
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
        this.#table?.code ? h('span', { class: 'info-chip info-muted', title: 'Table code' }, `Table ${formatRoomCode(this.#table.code)}`) : null,
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
          { class: `info-chip info-key ${net > 0 ? 'info-pos' : net < 0 ? 'info-neg' : 'info-muted'}`, title: 'Your stack minus everything you bought in for' },
          `Net ${signed(net)}`,
        ),
        snap.cash.leaving ? h('span', { class: 'info-chip info-muted info-key' }, 'Cashing out after this hand') : null,
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
    // Online, reading the history or settings must not stop the game for everyone else.
    if (!ts?.controller || ts.online || ts.controller.paused) return undefined;
    const controller = ts.controller;
    controller.pause();
    return () => {
      if (this.#table === ts) controller.resume();
    };
  }

  openHistory(): void {
    openHistory(this, this.#table?.records ?? this.#savedRecords(), this.#holdTable());
  }

  /** Runs one AI evaluation (off the main thread when possible). Used by the coach. */
  aiDecide(request: DecisionRequest): Promise<Decision> {
    return this.#aiHost().decide(request);
  }

  /** The game the hand history belongs to: the table in play, or the saved game. */
  #historySession(): SessionData | null {
    if (this.#table) return this.#table.controller?.session ?? null;
    const r = this.storage.session.load();
    return r.status === 'ok' ? r.payload : null;
  }

  /** Replays a hand from the history, optionally with the coach's review open. */
  openReplay(record: HandHistoryRecord, review = false): void {
    const session = this.#historySession();
    const styles = new Map(session?.seats.map((s) => [s.name, s.style]) ?? []);
    openReplayer(this, record, {
      stats: session?.statsBook,
      payouts: session ? payoutsFor(session.setup) : null,
      styleOf: (name) => styles.get(name) ?? null,
      review,
    });
  }

  /** Downloads every save as one file (Settings → Data). */
  exportSaves(): void {
    this.#saveNow();
    const store = browserStore();
    if (!store) {
      toast('This browser is not allowing saved data, so there is nothing to export.', 'warning');
      return;
    }
    const url = URL.createObjectURL(new Blob([exportBackup(store)], { type: 'application/json' }));
    const link = h('a', { href: url, download: `velvet-saves-${todayKey()}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast('Saves exported. Keep the file to restore them later or on another device.');
  }

  /** Replaces every save with a verified backup, then reloads (Settings → Data). */
  async importSaves(file: File): Promise<void> {
    const store = browserStore();
    if (!store) {
      toast('This browser is not allowing saved data, so a backup cannot be imported here.', 'warning');
      return;
    }
    if (file.size > 20_000_000) {
      toast('That file is far too large to be a Velvet backup.', 'error');
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      toast('That file could not be read.', 'error');
      return;
    }
    const check = readBackup(text);
    if (!check.ok) {
      toast(`Nothing was imported: ${check.reason}.`, 'error', 6000);
      return;
    }
    const when = check.exportedAt ? new Date(check.exportedAt).toLocaleString() : 'an unknown date';
    const ok = await confirm(
      'Replace your saves?',
      `This backup from ${when} contains ${check.summary.join(', ') || 'your settings'}. It will replace everything saved in this browser, including any game in progress.`,
      'Replace and reload',
      true,
    );
    if (!ok) return;
    this.#leaveTable(); // stop the game first, so it cannot save over the imported data
    applyBackup(store, check.entries);
    location.reload();
  }

  /** Counts a completed coach review (towards an achievement). */
  noteReview(): void {
    this.#progress((p) => {
      p.counters.reviews++;
      return p.counters.reviews >= 10 ? ['student'] : [];
    });
  }

  /** The coach's suggestion for the player's current decision, from their own view only. */
  async #advise(session: SessionData, snap: TableSnapshot): Promise<string | null> {
    const view = snap.view;
    if (!view?.legal || view.toAct !== snap.humanSeat) return null;
    const payouts = payoutsFor(session.setup);
    const decision = await this.aiDecide({
      view,
      style: 'shark',
      difficulty: 'elite',
      stats: session.statsBook,
      tilt: 0,
      seed: [snap.handNumber >>> 0, view.actions.length + 1, 0x51ed, 0x9e37],
      ...(payouts && payouts.length > 1 ? { payouts } : {}),
    });
    return adviceText(decision, view.legal);
  }

  openStats(): void {
    openStats(this, this.#table?.controller && !this.#table.online ? this.#table.controller.session.playerStats : null, this.#holdTable());
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
    const tell = (message: string) => {
      if (ts.online === 'host') for (const g of this.#lobby?.guests ?? []) g.remote?.notify(message, 'info');
    };
    ts.controller?.pause();
    tell('The host paused the game.');
    openPauseMenu(this, () => {
      ts.controller?.resume();
      tell('The game continues.');
    });
  }

  quitToMenu(): void {
    this.#saveNow();
    this.showMenu();
  }

  #leaveTable(): void {
    const ts = this.#table;
    if (!ts) return;
    this.#table = null;
    ts.controller?.stop();
    ts.guest?.stop();
    ts.bar.cancel();
    ts.nextHand?.();
    ts.table.destroy();
    this.motion.endSkip();
    this.motion.suspended = false;
    delete (globalThis as Record<string, unknown>).__velvet;
  }

  #saveNow(): void {
    const ts = this.#table;
    if (ts?.controller && !ts.online) this.storage.write(this.storage.session, ts.controller.session);
  }

  #gameOver(info: GameOverInfo, snap: TableSnapshot): void {
    if (this.#table) this.#table.finished = true;
    const stats = this.#table?.controller && !this.#table.online ? this.#table.controller.session.playerStats : null;
    const title = info.humanPlace === 1 ? 'You win the game!' : `${info.winnerName} wins`;
    if (info.humanPlace === 1) this.audio.play('winBig');
    openGameOver(this, { title, info, snapshot: snap, stats });
  }

  playAgain(): void {
    if (this.onlineRole === 'host') {
      this.#rematch();
      return;
    }
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
          ts.controller?.hurry();
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
