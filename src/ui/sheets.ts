import { type Card, cardsToString, parseCards } from '../engine/cards.ts';
import { bestFiveCards, describeHand } from '../engine/evaluator.ts';
import type { Street } from '../engine/types.ts';
import { cardFaceUrl } from '../assets/cards.ts';
import { STYLES } from '../ai/profiles.ts';
import type { GameOverInfo, TableSnapshot } from '../game/controller.ts';
import { type HandHistoryRecord, actionText, historyToText } from '../game/history.ts';
import { BUY_IN_POINTS, todayKey } from '../game/config.ts';
import type { CashSummary } from '../game/controller.ts';
import { ACHIEVEMENTS, dailyShareText, dailyStreak, unlockedCosmetics } from '../game/progress.ts';
import { CARD_BACK_CHOICES, type CardBack, FELTS, type Felt, type Settings, SPEEDS, type Speed, UI_SCALES } from '../game/settings.ts';
import { type CareerStats, type PlayerStats, derive, emptyCareer } from '../game/stats.ts';
import type { App } from './app.ts';
import { confirm, openSheet, type SheetHandle, toast } from './dialogs.ts';
import { clear, h } from './dom.ts';
import { chips, ordinal, pct, signed } from './format.ts';

/** Progress shown in the statistics sheet (loaded when the sheet opens). */
let progress: ReturnType<App['storage']['loadProgress']> | null = null;

function miniCards(cards: Card[], fourColor: boolean): HTMLElement {
  return h(
    'span',
    { class: 'mini-cards', role: 'img', 'aria-label': cardsToString(cards) },
    ...cards.map((c) => h('img', { class: 'mini-card', src: cardFaceUrl(c, { fourColor }), alt: '' })),
  );
}

// ---------------------------------------------------------------------------------------------
// Settings

export function openSettings(app: App, onClose?: () => void): SheetHandle {
  const s = () => app.settings;
  const toggle = (id: string, label: string, get: (s: Settings) => boolean, set: (s: Settings, v: boolean) => void, hint = '') => {
    const input = h('input', { type: 'checkbox', id, role: 'switch' }) as HTMLInputElement;
    input.checked = get(s());
    input.addEventListener('change', () => app.updateSettings((x) => set(x, input.checked)));
    return h(
      'label',
      { class: 'setting setting--toggle', for: id },
      h('span', { class: 'setting-text' }, h('span', { class: 'setting-label' }, label), hint ? h('span', { class: 'setting-hint' }, hint) : null),
      input,
    );
  };
  const slider = (id: string, label: string, get: (s: Settings) => number, set: (s: Settings, v: number) => void) => {
    const out = h('output', { for: id, class: 'setting-value' }, `${Math.round(get(s()) * 100)}%`);
    const input = h('input', { type: 'range', id, min: '0', max: '100', step: '5', value: String(Math.round(get(s()) * 100)) }) as HTMLInputElement;
    input.addEventListener('input', () => {
      out.textContent = `${input.value}%`;
      app.updateSettings((x) => set(x, Number(input.value) / 100));
    });
    input.addEventListener('change', () => app.audio.play('chips'));
    return h('label', { class: 'setting setting--slider', for: id }, h('span', { class: 'setting-label' }, label), input, out);
  };
  const segmented = <T extends string | number>(
    label: string,
    options: { value: T; label: string; locked?: string }[],
    get: (s: Settings) => T,
    set: (s: Settings, v: T) => void,
  ) => {
    const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
    const render = () =>
      group.replaceChildren(
        ...options.map((o) => {
          const b = h(
            'button',
            {
              type: 'button',
              role: 'radio',
              class: `seg ${o.locked ? 'seg--locked' : ''}`,
              'aria-checked': String(get(s()) === o.value),
              'aria-disabled': o.locked ? 'true' : undefined,
              title: o.locked ?? undefined,
            },
            o.locked ? `🔒 ${o.label}` : o.label,
          );
          b.addEventListener('click', () => {
            if (o.locked) {
              toast(o.locked, 'info');
              return;
            }
            app.updateSettings((x) => set(x, o.value));
            render();
          });
          return b;
        }),
      );
    render();
    return h('div', { class: 'setting setting--choice' }, h('span', { class: 'setting-label' }, label), group);
  };

  const shortcuts: [string, string][] = [
    ['F', 'Fold'],
    ['C', 'Check or call'],
    ['R', 'Bet or raise the selected amount'],
    ['A', 'Select all-in'],
    ['↑ ↓', 'Adjust the amount (Shift for bigger steps)'],
    ['Space', 'Skip animations · deal the next hand'],
    ['P / Esc', 'Pause menu'],
    ['H', 'Hand history'],
    ['T', 'Statistics'],
    ['L', 'Table log (small screens)'],
    ['M', 'Mute or unmute'],
  ];

  const progress = app.storage.loadProgress();
  const unlocked = unlockedCosmetics(progress);
  const lockHint = (item: { felt?: Felt; cardBack?: CardBack }) => {
    const a = ACHIEVEMENTS.find((x) => (item.felt && x.unlocks?.felt === item.felt) || (item.cardBack && x.unlocks?.cardBack === item.cardBack));
    return a ? `Unlocked by the achievement “${a.title}”: ${a.description}` : 'Locked';
  };
  const forget = h('button', { type: 'button', class: 'btn btn--small' }, 'Make opponents forget me');
  forget.addEventListener('click', async () => {
    if (
      await confirm('Start fresh with opponents?', 'Opponents will forget how you have played in earlier games. Your statistics are not affected.', 'Forget')
    ) {
      const p = app.storage.loadProgress();
      p.reputation = null;
      app.storage.write(app.storage.progress, p);
      toast('Opponents will treat you as a stranger in your next game');
    }
  });
  const reset = h('button', { type: 'button', class: 'btn btn--danger btn--small' }, 'Reset lifetime statistics');
  reset.addEventListener('click', async () => {
    if (
      await confirm('Reset statistics?', 'Your lifetime statistics will be cleared. This cannot be undone. Your current game is not affected.', 'Reset', true)
    ) {
      app.storage.write(app.storage.career, emptyCareer());
      toast('Lifetime statistics reset');
    }
  });

  return openSheet(
    { title: 'Settings', wide: true, onClose },
    h(
      'div',
      { class: 'settings-grid' },
      h(
        'section',
        { class: 'settings-group' },
        h('h3', {}, 'Sound'),
        app.audio.available ? null : h('p', { class: 'setting-hint' }, 'Sound is not available in this browser.'),
        toggle(
          'set-mute',
          'Mute all sound',
          (x) => x.audio.muted,
          (x, v) => (x.audio.muted = v),
        ),
        slider(
          'set-master',
          'Master volume',
          (x) => x.audio.master,
          (x, v) => (x.audio.master = v),
        ),
        slider(
          'set-effects',
          'Cards and chips',
          (x) => x.audio.effects,
          (x, v) => (x.audio.effects = v),
        ),
        slider(
          'set-interface',
          'Interface',
          (x) => x.audio.interface,
          (x, v) => (x.audio.interface = v),
        ),
        slider(
          'set-ambience',
          'Room ambience',
          (x) => x.audio.ambience,
          (x, v) => (x.audio.ambience = v),
        ),
      ),
      h(
        'section',
        { class: 'settings-group' },
        h('h3', {}, 'Gameplay'),
        segmented<Speed>(
          'Game speed',
          (Object.keys(SPEEDS) as Speed[]).map((k) => ({ value: k, label: SPEEDS[k].label })),
          (x) => x.gameplay.speed,
          (x, v) => (x.gameplay.speed = v),
        ),
        toggle(
          'set-strength',
          'Show my hand strength',
          (x) => x.gameplay.showHandStrength,
          (x, v) => (x.gameplay.showHandStrength = v),
          'Names your best hand under the controls.',
        ),
        toggle(
          'set-odds',
          'Show pot odds',
          (x) => x.gameplay.showPotOdds,
          (x, v) => (x.gameplay.showPotOdds = v),
          'How much equity a call needs to break even.',
        ),
        toggle(
          'set-autodeal',
          'Deal the next hand automatically',
          (x) => x.gameplay.autoContinue,
          (x, v) => (x.gameplay.autoContinue = v),
        ),
        toggle(
          'set-confirm',
          'Confirm before going all-in',
          (x) => x.gameplay.confirmAllIn,
          (x, v) => (x.gameplay.confirmAllIn = v),
        ),
        toggle(
          'set-show',
          'Always show my cards at showdown',
          (x) => x.gameplay.alwaysShowCards,
          (x, v) => (x.gameplay.alwaysShowCards = v),
          'Off: beaten hands are mucked, as most players do. Opponents learn from what you show.',
        ),
        toggle(
          'set-remember',
          'Opponents remember how I play',
          (x) => x.gameplay.opponentsRemember,
          (x, v) => (x.gameplay.opponentsRemember = v),
          'New games start with what opponents learned about you before. Never used in the daily challenge.',
        ),
        toggle(
          'set-coach',
          'Coach hints on my turn',
          (x) => x.gameplay.coachHints,
          (x, v) => (x.gameplay.coachHints = v),
          'Shows what the coach would do, with its equity estimate. Off for a fair test of your skill.',
        ),
      ),
      h(
        'section',
        { class: 'settings-group' },
        h('h3', {}, 'Display'),
        segmented(
          'Theme',
          [
            { value: 'system', label: 'System' },
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ] as const,
          (x) => x.display.theme,
          (x, v) => (x.display.theme = v),
        ),
        segmented(
          'Text and controls size',
          UI_SCALES.map((v) => ({ value: v, label: `${Math.round(v * 100)}%` })),
          (x) => x.display.uiScale,
          (x, v) => (x.display.uiScale = v),
        ),
        segmented<Felt>(
          'Table felt',
          FELTS.map((f) => ({ ...f, locked: unlocked.felts.has(f.value) ? undefined : lockHint({ felt: f.value }) })),
          (x) => x.display.felt,
          (x, v) => (x.display.felt = v),
        ),
        segmented<CardBack>(
          'Card backs',
          CARD_BACK_CHOICES.map((c) => ({ ...c, locked: unlocked.cardBacks.has(c.value) ? undefined : lockHint({ cardBack: c.value }) })),
          (x) => x.display.cardBack,
          (x, v) => (x.display.cardBack = v),
        ),
        toggle(
          'set-fourcolor',
          'Four-colour deck',
          (x) => x.display.fourColorDeck,
          (x, v) => (x.display.fourColorDeck = v),
          'Diamonds blue and clubs green, so suits are never confused.',
        ),
        toggle(
          'set-contrast',
          'High contrast',
          (x) => x.display.highContrast,
          (x, v) => (x.display.highContrast = v),
        ),
      ),
      h(
        'section',
        { class: 'settings-group' },
        h('h3', {}, 'Accessibility'),
        segmented(
          'Motion',
          [
            { value: 'system', label: 'System' },
            { value: 'reduced', label: 'Reduced' },
            { value: 'full', label: 'Full' },
          ] as const,
          (x) => x.accessibility.motion,
          (x, v) => (x.accessibility.motion = v),
        ),
        toggle(
          'set-announce',
          'Announce actions to screen readers',
          (x) => x.accessibility.announceActions,
          (x, v) => (x.accessibility.announceActions = v),
        ),
        h('h3', {}, 'Keyboard'),
        h('dl', { class: 'shortcuts' }, ...shortcuts.flatMap(([k, d]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, d)])),
        h('h3', {}, 'Data'),
        h(
          'p',
          { class: 'setting-hint' },
          app.storage.persistent
            ? 'Your game and statistics are saved in this browser after every action.'
            : 'This browser is not allowing saved data; nothing will be kept after you close the page.',
        ),
        reset,
        forget,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Statistics

function statsBody(stats: PlayerStats, fourColor: boolean, career?: CareerStats): HTMLElement {
  const d = derive(stats);
  const tile = (label: string, value: string, sub = '') =>
    h(
      'div',
      { class: 'stat' },
      h('div', { class: 'stat-value' }, value),
      h('div', { class: 'stat-label' }, label),
      sub ? h('div', { class: 'stat-sub' }, sub) : null,
    );
  if (stats.handsPlayed === 0) return h('p', { class: 'empty' }, 'No hands played yet. Statistics appear after your first hand.');
  const tiles = [
    tile('Hands played', chips(stats.handsPlayed)),
    tile('Hands won', chips(stats.handsWon), pct(d.winRate)),
    tile('Net chips', signed(stats.netChips)),
    tile('Showdowns won', `${stats.showdownsWon} of ${stats.showdowns}`, pct(d.showdownWinRate)),
    tile('VPIP', pct(d.vpip), 'Hands you put money in voluntarily'),
    tile('Pre-flop raise', pct(d.pfr), 'Hands you raised before the flop'),
    tile('Aggression', d.aggressionFactor === null ? '—' : d.aggressionFactor.toFixed(2), 'Bets and raises per call'),
    tile('Went to showdown', pct(d.wentToShowdown), 'Of the flops you saw'),
    tile('Fold rate', pct(d.foldRate), 'Of your decisions'),
    tile('All-ins', chips(stats.allIns)),
    tile('Largest pot won', chips(stats.largestPotWon)),
    tile('Biggest win · loss', `${signed(stats.biggestWin)} · ${signed(-stats.biggestLoss)}`),
  ];
  const best = stats.bestHand
    ? h(
        'div',
        { class: 'best-hand' },
        h('span', { class: 'stat-label' }, 'Best hand at showdown'),
        h('strong', {}, describeHand(stats.bestHand.score)),
        miniCards(bestFiveCards(stats.bestHand.cards), fourColor),
      )
    : null;
  const opponents = Object.entries(stats.opponents).sort((a, b) => b[1].hands - a[1].hands);
  const table = opponents.length
    ? h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'data-table' },
          h('caption', {}, 'Against each opponent'),
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, 'Opponent'),
              h('th', { scope: 'col' }, 'Hands'),
              h('th', { scope: 'col' }, 'Chips won/lost'),
              h('th', { scope: 'col' }, 'Showdowns W–L'),
            ),
          ),
          h(
            'tbody',
            {},
            ...opponents.map(([name, r]) =>
              h(
                'tr',
                {},
                h('th', { scope: 'row' }, name),
                h('td', {}, chips(r.hands)),
                h('td', { class: r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : '' }, signed(r.net)),
                h('td', {}, `${r.showdownsWon}–${r.showdownsLost}`),
              ),
            ),
          ),
        ),
      )
    : null;
  const careerTiles = career
    ? h(
        'div',
        { class: 'stat-grid stat-grid--career' },
        tile('Games played', chips(career.gamesPlayed)),
        tile('Games won', chips(career.gamesWon), career.gamesPlayed ? pct(career.gamesWon / career.gamesPlayed) : ''),
        tile(
          'Finishes',
          Object.entries(career.finishes)
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([place, n]) => `${ordinal(Number(place))} ×${n}`)
            .join(' · ') || '—',
        ),
        tile(
          'Prize points',
          signed(career.prizePoints - career.gamesPlayed * BUY_IN_POINTS),
          `${chips(career.prizePoints)} won from ${chips(career.gamesPlayed * BUY_IN_POINTS)} in entries · paid ${career.cashes}×`,
        ),
        tile(
          'Cash games',
          career.cashSessions ? `${signed(Math.round(career.cashNetBB))} BB` : '—',
          career.cashSessions
            ? `${career.cashSessions} sessions · ${chips(career.cashHands)} hands · ${career.cashHands ? ((career.cashNetBB / career.cashHands) * 100).toFixed(1) : '0'} BB/100`
            : 'Net result in big blinds',
        ),
        tile('Daily streak', progress ? String(dailyStreak(progress, todayKey())) : '—', 'Days in a row with a finished daily challenge'),
      )
    : null;
  return h(
    'div',
    { class: 'stats' },
    careerTiles,
    h('div', { class: 'stat-grid' }, ...tiles),
    best,
    table,
    h('p', { class: 'fine' }, 'Chips won/lost against an opponent come from the pots you both contributed to, split by who won them.'),
  );
}

export function openStats(app: App, session: PlayerStats | null, onClose?: () => void): SheetHandle {
  const career = app.storage.loadCareer();
  progress = app.storage.loadProgress();
  const fourColor = app.settings.display.fourColorDeck;
  const body = h('div', {});
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const views: [string, () => HTMLElement][] = [];
  if (session) views.push(['This game', () => statsBody(session, fourColor)]);
  views.push(['All time', () => statsBody(career, fourColor, career)]);
  let current = 0;
  const render = () => {
    tabs.replaceChildren(
      ...views.map(([label], i) => {
        const b = h('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(i === current) }, label);
        b.addEventListener('click', () => {
          current = i;
          render();
        });
        return b;
      }),
    );
    body.replaceChildren(views[current]![1]());
  };
  render();
  return openSheet({ title: 'Statistics', wide: true, onClose }, views.length > 1 ? tabs : '', body);
}

// ---------------------------------------------------------------------------------------------
// Hand history

const STREET_NAMES: Record<Street, string> = { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River' };

function historyDetail(app: App, r: HandHistoryRecord, back: () => void): HTMLElement {
  const fourColor = app.settings.display.fourColorDeck;
  const name = (seat: number) => (seat === r.humanSeat ? 'You' : (r.players.find((p) => p.seat === seat)?.name ?? `Seat ${seat + 1}`));
  const players = h(
    'div',
    { class: 'table-scroll' },
    h(
      'table',
      { class: 'data-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col' }, 'Player'),
          h('th', { scope: 'col' }, 'Position'),
          h('th', { scope: 'col' }, 'Cards'),
          h('th', { scope: 'col' }, 'Start'),
          h('th', { scope: 'col' }, 'Result'),
        ),
      ),
      h(
        'tbody',
        {},
        ...r.players.map((p) =>
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, p.seat === r.humanSeat && p.name.toLowerCase() !== 'you' ? `${p.name} (you)` : p.name),
            h('td', {}, p.position),
            h(
              'td',
              {},
              p.cards ? miniCards(p.cards, fourColor) : h('span', { class: 'muted' }, p.folds ? `folded ${STREET_NAMES[p.folds].toLowerCase()}` : 'not shown'),
            ),
            h('td', {}, chips(p.startStack)),
            h('td', { class: p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : '' }, signed(p.net)),
          ),
        ),
      ),
    ),
  );
  const streets: HTMLElement[] = [];
  for (const street of ['preflop', 'flop', 'turn', 'river'] as Street[]) {
    const acts = r.actions.filter((a) => a.street === street);
    if (!acts.length && street !== 'preflop' && r.board.length < (street === 'flop' ? 3 : street === 'turn' ? 4 : 5)) continue;
    const board = street === 'flop' ? r.board.slice(0, 3) : street === 'turn' ? r.board.slice(3, 4) : street === 'river' ? r.board.slice(4, 5) : [];
    streets.push(
      h(
        'section',
        { class: 'street' },
        h(
          'h4',
          {},
          STREET_NAMES[street],
          board.length ? miniCards(board, fourColor) : null,
          acts.length ? h('span', { class: 'street-pot' }, `pot ${chips(acts[0]!.potBefore)}`) : null,
        ),
        acts.length
          ? h('ol', { class: 'street-actions' }, ...acts.map((a) => h('li', {}, h('strong', {}, name(a.seat)), ` ${actionText(a, a.seat === r.humanSeat)}`)))
          : h('p', { class: 'muted' }, 'No betting (all-in).'),
      ),
    );
  }
  const results = h(
    'ul',
    { class: 'pot-results' },
    ...r.pots.map((pot, i) => {
      const label = r.pots.length === 1 ? 'Pot' : i === 0 ? 'Main pot' : `Side pot ${i}`;
      const who = pot.shares.map((s) => `${name(s.seat)} ${chips(s.amount)}`).join(', ');
      return h(
        'li',
        {},
        h('strong', {}, `${label} ${chips(pot.amount)}`),
        ` → ${who}${pot.winningScore !== null ? ` · ${describeHand(pot.winningScore)}` : ' · uncontested'}`,
      );
    }),
  );
  const copy = h('button', { type: 'button', class: 'btn btn--small' }, 'Copy as text');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(historyToText(r));
      toast('Hand copied to the clipboard');
    } catch {
      toast('Copying is not allowed here — select the text instead.', 'warning');
      const pre = h('pre', { class: 'hand-text' }, historyToText(r));
      copy.replaceWith(pre);
    }
  });
  const devCopy = app.dev ? h('button', { type: 'button', class: 'btn btn--small' }, 'Copy replay data') : null;
  devCopy?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(r.replay));
      toast('Replay data copied (includes the full deck order)');
    } catch {
      toast('Clipboard unavailable', 'warning');
    }
  });
  const backBtn = h('button', { type: 'button', class: 'btn btn--small' }, '← All hands');
  backBtn.addEventListener('click', back);
  return h(
    'div',
    { class: 'history-detail' },
    h(
      'div',
      { class: 'detail-head' },
      backBtn,
      h('h3', {}, `Hand ${r.handNumber}`),
      h('span', { class: 'muted' }, `Blinds ${chips(r.blinds.smallBlind)}/${chips(r.blinds.bigBlind)} · ${name(r.button)} on the button`),
    ),
    players,
    ...streets,
    h('h4', {}, 'Result'),
    results,
    h('div', { class: 'sheet-actions sheet-actions--left' }, copy, devCopy),
  );
}

export function openHistory(app: App, records: HandHistoryRecord[], onClose?: () => void): SheetHandle {
  const body = h('div', { class: 'history' });
  const sheet = openSheet({ title: 'Hand history', wide: true, onClose }, body);
  const list = () => {
    clear(body);
    if (!records.length) {
      body.append(h('p', { class: 'empty' }, 'Completed hands of the current game appear here.'));
      return;
    }
    const ul = h('ul', { class: 'history-list' });
    for (const r of [...records].reverse()) {
      const me = r.players.find((p) => p.seat === r.humanSeat);
      const main = r.pots[0];
      const winners = [...new Set(r.pots.flatMap((p) => p.winners))].map((s) =>
        s === r.humanSeat ? 'You' : (r.players.find((p) => p.seat === s)?.name ?? '?'),
      );
      const summary = main && main.winningScore !== null ? describeHand(main.winningScore) : 'no showdown';
      const b = h(
        'button',
        { type: 'button', class: 'history-row' },
        h('span', { class: 'hr-num' }, `#${r.handNumber}`),
        me?.cards ? miniCards(me.cards, app.settings.display.fourColorDeck) : h('span', { class: 'muted hr-cards' }, me ? '' : 'watching'),
        h('span', { class: 'hr-text' }, `${winners.join(' & ')} ${winners.length > 1 || winners[0] === 'You' ? 'won' : 'won'} · ${summary}`),
        h('span', { class: `hr-net ${me && me.net > 0 ? 'pos' : me && me.net < 0 ? 'neg' : ''}` }, me ? signed(me.net) : ''),
      );
      b.addEventListener('click', () => {
        clear(body);
        body.append(historyDetail(app, r, list));
        body.querySelector('button')?.focus();
      });
      ul.append(h('li', {}, b));
    }
    body.append(ul);
  };
  list();
  return sheet;
}

// ---------------------------------------------------------------------------------------------
// Help

export function openHelp(app: App, onClose?: () => void): SheetHandle {
  const fc = app.settings.display.fourColorDeck;
  const rankings: [string, string, string][] = [
    ['Royal Flush', 'As Ks Qs Js Ts', 'A, K, Q, J, 10 of one suit.'],
    ['Straight Flush', '9h 8h 7h 6h 5h', 'Five in a row, all one suit.'],
    ['Four of a Kind', 'Qc Qd Qh Qs 7c', 'Four cards of one rank.'],
    ['Full House', 'Kc Kd Kh 4s 4d', 'Three of a kind plus a pair.'],
    ['Flush', 'Ad Jd 8d 5d 2d', 'Any five of one suit.'],
    ['Straight', '9c 8d 7s 6h 5c', 'Five in a row. A-2-3-4-5 counts; wrapping around does not.'],
    ['Three of a Kind', '7s 7h 7d Kc 2s', 'Three cards of one rank.'],
    ['Two Pair', 'Jc Jd 4s 4h Ac', 'Two different pairs.'],
    ['One Pair', 'Th Tc Ks 8d 3c', 'Two cards of one rank.'],
    ['High Card', 'Ac Qd 9s 6h 3c', 'Nothing else — highest cards win.'],
  ];
  return openSheet(
    { title: 'How to play', wide: true, onClose },
    h(
      'div',
      { class: 'help' },
      h(
        'section',
        {},
        h('h3', {}, 'The game'),
        h(
          'p',
          {},
          'Each player gets two private cards. Five shared cards are dealt face up in the middle: three on the flop, then the turn, then the river. Your hand is the best five cards out of your two and the five on the board.',
        ),
        h(
          'p',
          {},
          'Before each deal, the two players left of the dealer button post the small and big blinds. Betting goes around the table four times (before the flop and after each new card). On your turn you can fold, check (when nobody has bet), call, bet or raise. A raise must be at least as large as the previous bet or raise. You can always go all-in.',
        ),
        h(
          'p',
          {},
          'If more than one player is left after the river, hands are shown and the best hand wins. When someone is all-in for less, the extra chips form side pots that only the players who matched them can win. Equal hands split the pot.',
        ),
      ),
      h(
        'section',
        {},
        h('h3', {}, 'Ways to play'),
        h(
          'p',
          {},
          'Tournament: everyone starts with the same chips and the blinds rise. When you run out of chips you are out; play continues until one player holds them all. Tournaments can pay only the winner or the top two or three places. When more than one place is paid, chips you might lose are worth more than chips you might win, especially just before the money (“the bubble”) — opponents tighten up there, and so should you.',
        ),
        h(
          'p',
          {},
          'Cash game: the blinds never change and nobody is eliminated. If you run out of chips you can buy in again. Cash out whenever you like from the pause menu; your result is what you leave with minus what you bought in for.',
        ),
        h(
          'p',
          {},
          'Daily challenge: one tournament per day, the same opponents and the same deck for every hand number for everyone. Your first game of the day counts for your record and streak; replays are practice.',
        ),
      ),
      h(
        'section',
        {},
        h('h3', {}, 'Hand rankings, best to worst'),
        h(
          'ol',
          { class: 'rankings' },
          ...rankings.map(([n, cards, d]) =>
            h('li', {}, h('span', { class: 'rank-name' }, n), miniCards(parseCards(cards), fc), h('span', { class: 'rank-desc' }, d)),
          ),
        ),
      ),
      h(
        'section',
        {},
        h('h3', {}, 'Your opponents'),
        h('ul', { class: 'style-list' }, ...Object.values(STYLES).map((s) => h('li', {}, h('strong', {}, s.label), ` — ${s.blurb}`))),
        h(
          'p',
          {},
          'Every opponent uses the same decision engine and sees exactly what a player in their seat would see: their own cards, the board, the bets, and any hands shown down. They learn your habits from what you do at the table, and adjust as they gather evidence.',
        ),
      ),
      h(
        'section',
        {},
        h('h3', {}, 'Play money and privacy'),
        h(
          'p',
          {},
          'Velvet is a free game played with play money. Chips have no cash value, cannot be bought, sold or exchanged, and nothing can be won. There is no gambling of any kind.',
        ),
        h(
          'p',
          {},
          'The game runs entirely in your browser. Your games, history, statistics and settings are stored only on this device; nothing is sent anywhere, and there are no accounts, ads or tracking.',
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Pause and game over

export function openPauseMenu(app: App, resume: () => void): SheetHandle {
  let leaving = false;
  const btn = (label: string, fn: () => void, primary = false) => {
    const b = h('button', { type: 'button', class: `menu-btn ${primary ? 'menu-btn--primary' : ''}` }, h('span', { class: 'menu-btn-label' }, label));
    b.addEventListener('click', fn);
    return b;
  };
  const sheet = openSheet(
    {
      title: 'Paused',
      onClose: () => {
        if (!leaving) resume();
      },
    },
    h(
      'div',
      { class: 'pause-menu' },
      btn('Resume', () => sheet.close(), true),
      btn('Hand history', () => app.openHistory()),
      btn('Statistics', () => app.openStats()),
      btn('Settings', () => app.openSettings()),
      btn('How to play', () => app.openHelp()),
      app.inCashGame
        ? btn('Cash out', () => {
            leaving = true;
            sheet.close();
            resume();
            app.cashOut();
          })
        : null,
      btn('Leave table', () => {
        leaving = true;
        sheet.close();
        app.quitToMenu();
      }),
      h(
        'p',
        { class: 'fine' },
        app.inCashGame
          ? 'Cash out to end the session and count your result. Leave the table to take a break and continue later from the main menu.'
          : 'Your game is saved after every action. Leave any time and continue later from the main menu.',
      ),
    ),
  );
  return sheet;
}

export function openGameOver(app: App, data: { title: string; info: GameOverInfo; snapshot: TableSnapshot; stats: PlayerStats | null }): SheetHandle {
  const { info, snapshot, stats } = data;
  const standings = [...snapshot.seats].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
  const place = (n: number | null) => (n ? ordinal(n) : '—');
  const list = h(
    'ol',
    { class: 'standings' },
    ...standings.map((s) =>
      h(
        'li',
        { class: s.kind === 'human' ? 'is-you' : '' },
        h('span', { class: 'st-place' }, place(s.place)),
        h('span', { class: 'st-name' }, s.kind === 'human' && s.name.toLowerCase() !== 'you' ? `${s.name} (you)` : s.name),
        h('span', { class: 'st-style' }, s.style ? STYLES[s.style].label : ''),
      ),
    ),
  );
  const d = stats ? derive(stats) : null;
  const summary =
    stats && d
      ? h(
          'p',
          { class: 'sheet-message' },
          `${chips(stats.handsPlayed)} hands played · won ${chips(stats.handsWon)} (${pct(d.winRate)}) · showdowns won ${stats.showdownsWon} of ${stats.showdowns}.`,
        )
      : null;
  const again = h('button', { type: 'button', class: 'btn btn--primary' }, 'Play again');
  const setup = h('button', { type: 'button', class: 'btn' }, 'New game');
  const review = h('button', { type: 'button', class: 'btn' }, 'Review hands');
  const menu = h('button', { type: 'button', class: 'btn' }, 'Main menu');
  const sheet = openSheet(
    { title: data.title, modal: true, className: info.humanPlace === 1 ? 'sheet--victory' : '' },
    h(
      'p',
      { class: 'result-line' },
      info.humanPlace === 1
        ? `You took every chip in ${chips(info.hands)} hands.`
        : `You finished ${ordinal(info.humanPlace)} of ${info.fieldSize}. The game lasted ${chips(info.hands)} hands.`,
    ),
    info.prizes.length > 1 || info.humanPrize > 0
      ? h(
          'p',
          { class: 'sheet-message prize-line' },
          info.humanPrize > 0
            ? `You won ${chips(info.humanPrize)} prize points (entry ${BUY_IN_POINTS}).`
            : `No prize this time — ${info.prizes.length > 1 ? `the top ${info.prizes.length} were paid` : 'only the winner is paid'}.`,
          ' ',
          h('span', { class: 'muted' }, `Prizes: ${info.prizes.map((p, i) => `${ordinal(i + 1)} ${chips(p)}`).join(' · ')}`),
        )
      : '',
    dailyNote(app, snapshot),
    list,
    summary ?? '',
    h('div', { class: 'sheet-actions' }, review, menu, setup, again),
  );
  again.addEventListener('click', () => {
    sheet.close();
    app.playAgain();
  });
  setup.addEventListener('click', () => {
    sheet.close();
    app.showSetup();
  });
  menu.addEventListener('click', () => {
    sheet.close();
    app.showMenu();
  });
  review.addEventListener('click', () => app.openHistory());
  return sheet;
}

/** After a daily challenge: the official result, streak, and a shareable summary. */
function dailyNote(app: App, snapshot: TableSnapshot): HTMLElement | string {
  const date = snapshot.daily;
  if (!date) return '';
  const p = app.storage.loadProgress();
  const result = p.daily[date];
  const official = result && result.attempts === 1 && p.dailyStarted[date];
  const streak = dailyStreak(p, date);
  const box = h('div', { class: 'daily-note' });
  if (!result) {
    box.append(h('p', { class: 'sheet-message' }, 'Practice game — your first game today is the one that counts.'));
    return box;
  }
  box.append(
    h(
      'p',
      { class: 'sheet-message' },
      official ? `Daily challenge ${date} recorded.` : `Practice game. Your result for ${date} stays ${ordinal(result.place)}.`,
      streak > 1 ? ` Streak: ${streak} days.` : '',
    ),
  );
  const share = h('button', { type: 'button', class: 'btn btn--small' }, 'Share result');
  share.addEventListener('click', async () => {
    const text = dailyShareText(date, result, streak, location.href.split('#')[0]!.split('?')[0]!);
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        toast('Result copied — paste it anywhere');
      }
    } catch {
      /* the share sheet was dismissed */
    }
  });
  box.append(share);
  return box;
}

// ---------------------------------------------------------------------------------------------
// Achievements

export function openAchievements(app: App, onClose?: () => void): SheetHandle {
  const p = app.storage.loadProgress();
  const earned = ACHIEVEMENTS.filter((a) => p.achievements[a.id]).length;
  const list = h(
    'ul',
    { class: 'achievements' },
    ...ACHIEVEMENTS.map((a) => {
      const when = p.achievements[a.id];
      const hidden = a.secret && !when;
      const reward = a.unlocks?.felt ? `Unlocks the ${a.unlocks.felt} table felt` : a.unlocks?.cardBack ? `Unlocks the ${a.unlocks.cardBack} card back` : '';
      return h(
        'li',
        { class: `achievement ${when ? 'is-earned' : 'is-locked'}` },
        h('span', { class: 'ach-mark', 'aria-hidden': 'true' }, when ? '★' : '☆'),
        h(
          'span',
          { class: 'ach-text' },
          h('strong', {}, hidden ? 'Secret achievement' : a.title),
          h('span', { class: 'ach-desc' }, hidden ? 'Keep playing to discover it.' : a.description),
          reward && !hidden ? h('span', { class: 'ach-reward' }, reward) : null,
        ),
        h('span', { class: 'ach-date' }, when ? new Date(when).toLocaleDateString() : ''),
      );
    }),
  );
  return openSheet(
    { title: 'Achievements', wide: true, onClose },
    h('p', { class: 'sheet-message' }, `${earned} of ${ACHIEVEMENTS.length} earned. Some unlock new table felts and card backs (Settings → Display).`),
    list,
  );
}

// ---------------------------------------------------------------------------------------------
// Cash game summary

export function openCashSummary(app: App, s: CashSummary): SheetHandle {
  const bb = (n: number) => `${signed(Math.round((n / Math.max(1, s.bigBlind)) * 10) / 10)} BB`;
  const per100 = s.hands > 0 ? (s.net / Math.max(1, s.bigBlind) / s.hands) * 100 : 0;
  const rows: [string, string][] = [
    ['Hands played', chips(s.hands)],
    ['Bought in for', `${chips(s.buyIn * s.buyIns)}${s.buyIns > 1 ? ` (${s.buyIns} buy-ins)` : ''}`],
    ['Cashed out', chips(s.finalStack)],
    ['Result', `${signed(s.net)} chips · ${bb(s.net)}`],
    ['Win rate', s.hands ? `${per100 >= 0 ? '+' : ''}${per100.toFixed(1)} BB per 100 hands` : '—'],
  ];
  const again = h('button', { type: 'button', class: 'btn btn--primary' }, 'New session');
  const menu = h('button', { type: 'button', class: 'btn' }, 'Main menu');
  const review = h('button', { type: 'button', class: 'btn' }, 'Review hands');
  const sheet = openSheet(
    { title: s.net > 0 ? 'Nice session' : s.net < 0 ? 'Session over' : 'Broke even', modal: true, className: s.net > 0 ? 'sheet--victory' : '' },
    h(
      'p',
      { class: 'result-line' },
      s.net > 0 ? `You left ${chips(s.net)} ahead.` : s.net < 0 ? `You left ${chips(-s.net)} down.` : 'You left with exactly what you brought.',
    ),
    h('dl', { class: 'summary-list' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    h('div', { class: 'sheet-actions' }, review, menu, again),
  );
  again.addEventListener('click', () => {
    sheet.close();
    app.playAgain();
  });
  menu.addEventListener('click', () => {
    sheet.close();
    app.showMenu();
  });
  review.addEventListener('click', () => app.openHistory());
  return sheet;
}
