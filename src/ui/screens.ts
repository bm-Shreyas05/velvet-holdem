import { parseCards } from '../engine/cards.ts';
import { avatarSvg } from '../assets/avatars.ts';
import { cardFaceUrl } from '../assets/cards.ts';
import { ICONS } from '../assets/icons.ts';
import { DEFAULT_PERSONAS, DIFFICULTIES, DIFFICULTY_ORDER, STYLES, STYLE_ORDER, type StyleId } from '../ai/profiles.ts';
import { SCENARIOS } from '../dev/scenarios.ts';
import { MAX_OPPONENTS, MIN_OPPONENTS, type NewGameSetup, STRUCTURES, type Structure, defaultSetup, validateSetup } from '../game/config.ts';
import type { App } from './app.ts';
import { confirm, toast } from './dialogs.ts';
import { h } from './dom.ts';

/** Main menu: continue, new game, and the secondary screens. */
export function renderMenu(app: App): HTMLElement {
  const saved = app.savedGameSummary();
  const fan = h(
    'div',
    { class: 'hero-fan', 'aria-hidden': 'true' },
    ...parseCards('Ts Js Qs Ks As').map((c, i) => h('img', { class: 'hero-card', style: `--i:${i - 2}`, src: cardFaceUrl(c, { fourColor: app.settings.display.fourColorDeck }), alt: '' })),
  );
  const primary: HTMLElement[] = [];
  if (saved && saved.ok) {
    const cont = h('button', { type: 'button', class: 'menu-btn menu-btn--primary' }, h('span', { class: 'menu-btn-label' }, 'Continue'), h('span', { class: 'menu-btn-sub' }, saved.text));
    cont.addEventListener('click', () => app.continueGame());
    primary.push(cont);
  }
  const fresh = h('button', { type: 'button', class: `menu-btn ${saved && saved.ok ? '' : 'menu-btn--primary'}` }, h('span', { class: 'menu-btn-label' }, 'New game'), h('span', { class: 'menu-btn-sub' }, 'Choose opponents, stakes and difficulty'));
  fresh.addEventListener('click', () => app.showSetup());
  primary.push(fresh);

  const notice =
    saved && !saved.ok
      ? h(
          'div',
          { class: 'notice notice--warning', role: 'alert' },
          h('p', {}, `Your saved game could not be loaded (${saved.reason}). Starting a new game will replace it.`),
          (() => {
            const b = h('button', { type: 'button', class: 'btn btn--small' }, 'Discard saved game');
            b.addEventListener('click', async () => {
              if (await confirm('Discard saved game?', 'The damaged save will be deleted. Your statistics are kept.', 'Discard', true)) {
                app.storage.session.clear();
                app.showMenu();
              }
            });
            return b;
          })(),
        )
      : null;

  const secondary = h(
    'div',
    { class: 'menu-secondary' },
    ...(
      [
        ['Statistics', ICONS.stats, () => app.openStats()],
        ['Hand history', ICONS.history, () => app.openHistory()],
        ['How to play', ICONS.help, () => app.openHelp()],
        ['Settings', ICONS.settings, () => app.openSettings()],
      ] as const
    ).map(([label, icon, fn]) => {
      const b = h('button', { type: 'button', class: 'menu-link', html: `${icon}<span>${label}</span>` });
      b.addEventListener('click', fn);
      return b;
    }),
  );

  return h(
    'main',
    { class: 'screen screen-menu' },
    h(
      'div',
      { class: 'menu-card' },
      fan,
      h('h1', { class: 'menu-title' }, 'Velvet'),
      h('p', { class: 'menu-tagline' }, "No-Limit Texas Hold'em against opponents who read the table the way you do."),
      notice,
      h('div', { class: 'menu-primary' }, ...primary),
      secondary,
      h('p', { class: 'menu-fine' }, 'Cards are shuffled by your browser’s secure random generator. Opponents see only what a real player at the table would see.'),
    ),
  );
}

/** New-game setup. */
export function renderSetup(app: App, previous: NewGameSetup | null): HTMLElement {
  const setup: NewGameSetup = structuredClone(previous ?? defaultSetup());
  delete setup.seed;
  delete setup.scenario;
  const error = h('p', { class: 'form-error', role: 'alert' });

  const nameInput = h('input', { type: 'text', id: 'setup-name', maxlength: '24', value: setup.playerName, autocomplete: 'nickname' }) as HTMLInputElement;
  nameInput.addEventListener('input', () => (setup.playerName = nameInput.value));

  // Opponents
  const oppList = h('div', { class: 'opp-list' });
  const countGroup = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Number of opponents' });
  const renderCount = () => {
    countGroup.replaceChildren(
      ...Array.from({ length: MAX_OPPONENTS - MIN_OPPONENTS + 1 }, (_, k) => {
        const n = MIN_OPPONENTS + k;
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(setup.opponents.length === n), class: 'seg' }, String(n)) as HTMLButtonElement;
        b.addEventListener('click', () => {
          while (setup.opponents.length < n) {
            const used = new Set(setup.opponents.map((o) => o.name));
            const next = DEFAULT_PERSONAS.find((p) => !used.has(p.name)) ?? { name: `Player ${setup.opponents.length + 2}`, style: 'shark' as StyleId };
            setup.opponents.push({ name: next.name, style: next.style });
          }
          setup.opponents.length = n;
          renderCount();
          renderOpponents();
        });
        return b;
      }),
    );
  };
  const renderOpponents = () => {
    oppList.replaceChildren(
      ...setup.opponents.map((o, i) => {
        const avatar = h('div', { class: 'avatar avatar--sm', html: avatarSvg(o.name, o.style === 'random' ? null : o.style) });
        const name = h('input', { type: 'text', id: `opp-name-${i}`, maxlength: '24', value: o.name, 'aria-label': `Opponent ${i + 1} name` }) as HTMLInputElement;
        const blurb = h('p', { class: 'opp-blurb' }, o.style === 'random' ? 'A style is chosen at random when the game starts.' : STYLES[o.style].blurb);
        name.addEventListener('input', () => {
          o.name = name.value;
          avatar.innerHTML = avatarSvg(o.name, o.style === 'random' ? null : o.style);
        });
        const style = h(
          'select',
          { id: `opp-style-${i}`, 'aria-label': `Opponent ${i + 1} playing style` },
          h('option', { value: 'random', selected: o.style === 'random' }, 'Random style'),
          ...STYLE_ORDER.map((s) => h('option', { value: s, selected: o.style === s }, STYLES[s].label)),
        ) as HTMLSelectElement;
        style.addEventListener('change', () => {
          o.style = style.value as StyleId | 'random';
          blurb.textContent = o.style === 'random' ? 'A style is chosen at random when the game starts.' : STYLES[o.style].blurb;
          avatar.innerHTML = avatarSvg(o.name, o.style === 'random' ? null : o.style);
        });
        return h('div', { class: 'opp-row' }, avatar, h('div', { class: 'opp-fields' }, h('div', { class: 'opp-inputs' }, name, style), blurb));
      }),
    );
  };
  renderCount();
  renderOpponents();

  // Difficulty
  const diffGroup = h('div', { class: 'choice-grid', role: 'radiogroup', 'aria-label': 'Difficulty' });
  const renderDiff = () =>
    diffGroup.replaceChildren(
      ...DIFFICULTY_ORDER.map((d) => {
        const info = DIFFICULTIES[d];
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(setup.difficulty === d), class: 'choice' }, h('span', { class: 'choice-title' }, info.label), h('span', { class: 'choice-sub' }, info.blurb)) as HTMLButtonElement;
        b.addEventListener('click', () => {
          setup.difficulty = d;
          renderDiff();
        });
        return b;
      }),
    );
  renderDiff();

  // Chips and blinds
  const numberField = (id: string, label: string, get: () => number, set: (v: number) => void, hint: string) => {
    const input = h('input', { type: 'number', id, min: '1', step: '1', inputmode: 'numeric', value: String(get()) }) as HTMLInputElement;
    input.addEventListener('input', () => set(Math.round(Number(input.value))));
    return h('label', { class: 'field', for: id }, h('span', { class: 'field-label' }, label), input, h('span', { class: 'field-hint' }, hint));
  };
  const chipsRow = h(
    'div',
    { class: 'field-row' },
    numberField('setup-stack', 'Starting chips', () => setup.startingStack, (v) => (setup.startingStack = v), 'Each player starts with this many.'),
    numberField('setup-sb', 'Small blind', () => setup.smallBlind, (v) => (setup.smallBlind = v), 'Posted left of the button.'),
    numberField('setup-bb', 'Big blind', () => setup.bigBlind, (v) => (setup.bigBlind = v), 'Also the minimum bet.'),
  );

  const structGroup = h('div', { class: 'choice-grid choice-grid--compact', role: 'radiogroup', 'aria-label': 'Blind structure' });
  const renderStruct = () =>
    structGroup.replaceChildren(
      ...(Object.keys(STRUCTURES) as Structure[]).map((k) => {
        const info = STRUCTURES[k];
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(setup.structure === k), class: 'choice' }, h('span', { class: 'choice-title' }, info.label), h('span', { class: 'choice-sub' }, info.blurb)) as HTMLButtonElement;
        b.addEventListener('click', () => {
          setup.structure = k;
          renderStruct();
        });
        return b;
      }),
    );
  renderStruct();

  let seedInput: HTMLInputElement | null = null;
  let scenarioSelect: HTMLSelectElement | null = null;
  const devSection = app.dev
    ? h(
        'section',
        { class: 'setup-section setup-dev' },
        h('h2', {}, 'Developer'),
        h(
          'label',
          { class: 'field', for: 'setup-seed' },
          h('span', { class: 'field-label' }, 'Seed (reproducible deck and AI choices)'),
          (seedInput = h('input', { type: 'text', id: 'setup-seed', placeholder: 'Leave empty for a normal game' }) as HTMLInputElement),
        ),
        h(
          'label',
          { class: 'field', for: 'setup-scenario' },
          h('span', { class: 'field-label' }, 'First hand'),
          (scenarioSelect = h(
            'select',
            { id: 'setup-scenario' },
            h('option', { value: '' }, 'Shuffled normally'),
            ...SCENARIOS.map((sc) => h('option', { value: sc.id }, `${sc.label} (needs ${sc.stacks.length - 1} opponents)`)),
          ) as HTMLSelectElement),
          h('span', { class: 'field-hint' }, 'Deals a prepared first hand to check rare situations; the rest of the game is normal.'),
        ),
      )
    : null;

  const back = h('button', { type: 'button', class: 'btn' }, 'Back');
  back.addEventListener('click', () => app.showMenu());
  const start = h('button', { type: 'submit', class: 'btn btn--primary btn--large' }, 'Deal me in');
  const form = h(
    'form',
    { class: 'setup-form', novalidate: true },
    h('header', { class: 'setup-head' }, h('h1', {}, 'New game'), h('p', {}, 'Play until one player holds every chip.')),
    h('section', { class: 'setup-section' }, h('h2', {}, 'You'), h('label', { class: 'field', for: 'setup-name' }, h('span', { class: 'field-label' }, 'Your name'), nameInput)),
    h('section', { class: 'setup-section' }, h('div', { class: 'section-head' }, h('h2', {}, 'Opponents'), countGroup), oppList),
    h('section', { class: 'setup-section' }, h('h2', {}, 'Difficulty'), diffGroup),
    h('section', { class: 'setup-section' }, h('h2', {}, 'Chips and blinds'), chipsRow, structGroup),
    devSection,
    error,
    h('div', { class: 'setup-actions' }, back, start),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (seedInput && seedInput.value.trim()) setup.seed = seedInput.value.trim();
    else delete setup.seed;
    if (scenarioSelect && scenarioSelect.value) setup.scenario = scenarioSelect.value;
    else delete setup.scenario;
    setup.playerName = setup.playerName.trim();
    setup.opponents = setup.opponents.map((o) => ({ ...o, name: o.name.trim() }));
    const problem = validateSetup(setup);
    error.textContent = problem ?? '';
    if (problem) {
      toast(problem, 'warning');
      return;
    }
    void app.startNewGame(setup);
  });
  return h('main', { class: 'screen screen-setup' }, form);
}
