import { DIFFICULTIES, DIFFICULTY_ORDER, type Difficulty } from '../ai/profiles.ts';
import { MAX_OPPONENTS, type NewGameSetup, PAYOUTS, type PayoutId, playerCount, STRUCTURES, type Structure } from '../game/config.ts';
import { type GuestState, type HostLobby, MAX_GUESTS } from '../net/lobby.ts';
import { formatRoomCode, inviteLink, type LobbyPlayer, parseRoomCode } from '../net/protocol.ts';
import type { App } from './app.ts';
import { confirm, toast } from './dialogs.ts';
import { h } from './dom.ts';

const HOW_IT_WORKS = [
  'The host’s browser deals and runs the game. Everyone’s browsers connect directly to each other; free public relay servers only help them find one another, and that introduction is encrypted with the table code. There is no game server and nothing is stored online.',
  'Each player’s device receives only what that player may see. The host’s device holds the whole game, so play with people you trust.',
  'Games with friends are not saved and do not change your statistics or achievements. Some networks (workplace and school firewalls, a few mobile carriers) block direct connections; if someone cannot join, try another network.',
];

function nameField(id: string, value: string): HTMLInputElement {
  return h('input', { type: 'text', id, maxlength: '24', value, autocomplete: 'nickname', spellcheck: 'false' }) as HTMLInputElement;
}

/** Host a table, or join one with a code (prefilled when opened from an invite link). */
export function renderFriends(app: App, code: string | null): HTMLElement {
  const name = nameField('friends-name', app.playerName);
  const codeInput = h('input', {
    type: 'text',
    id: 'join-code',
    maxlength: '80',
    value: code ? formatRoomCode(code) : '',
    placeholder: 'e.g. K7QM-3XPA',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
  }) as HTMLInputElement;
  const error = h('p', { class: 'form-error', role: 'alert' });
  const fail = (message: string, field: HTMLInputElement) => {
    error.textContent = message;
    field.focus();
  };
  const checkName = (): string | null => {
    const n = name.value.trim();
    if (!n) fail('Enter your name first.', name);
    return n || null;
  };

  const host = h('button', { type: 'button', class: `btn ${code ? '' : 'btn--primary'}` }, 'Create a table');
  host.addEventListener('click', () => {
    const n = checkName();
    if (n) void app.hostTable(n);
  });
  const join = h('button', { type: 'submit', class: `btn ${code ? 'btn--primary' : ''}` }, 'Join');
  const joinForm = h(
    'form',
    { class: 'join-row', novalidate: true },
    h('label', { class: 'field', for: 'join-code' }, h('span', { class: 'field-label' }, 'Table code or invite link'), codeInput),
    join,
  );
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const n = checkName();
    if (!n) return;
    const parsed = parseRoomCode(codeInput.value);
    if (!parsed) {
      fail('That is not a table code. Codes have eight letters and digits, like K7QM-3XPA.', codeInput);
      return;
    }
    void app.joinTable(parsed, n);
  });

  const back = h('button', { type: 'button', class: 'btn' }, 'Back');
  back.addEventListener('click', () => app.showMenu());
  const screen = h(
    'main',
    { class: 'screen screen-setup screen-friends' },
    h(
      'div',
      { class: 'setup-form' },
      h(
        'header',
        { class: 'setup-head' },
        h('h1', {}, 'Play with friends'),
        h('p', {}, 'One of you hosts and everyone else joins with the table code. Up to nine players; AI opponents can fill the empty seats.'),
      ),
      h('section', { class: 'setup-section' }, h('label', { class: 'field', for: 'friends-name' }, h('span', { class: 'field-label' }, 'Your name'), name)),
      code
        ? null
        : h(
            'section',
            { class: 'setup-section' },
            h('h2', {}, 'Host a table'),
            h('p', { class: 'field-hint' }, 'You get a code and a link to send to your friends, then choose the stakes and deal when everyone is in.'),
            h('div', {}, host),
          ),
      h('section', { class: 'setup-section' }, h('h2', {}, 'Join a table'), joinForm),
      error,
      h(
        'section',
        { class: 'setup-section setup-section--quiet' },
        h('h2', {}, 'How it works'),
        ...HOW_IT_WORKS.map((t) => h('p', { class: 'field-hint' }, t)),
      ),
      h('div', { class: 'setup-actions' }, back, code ? host : null),
    ),
  );
  queueMicrotask(() => (code ? (name.value ? join : name) : name).focus({ preventScroll: true }));
  return screen;
}

function playerList(players: { name: string; note: string; remove?: () => void }[]): HTMLElement {
  return h(
    'ul',
    { class: 'lobby-players' },
    ...players.map((p) => {
      const remove = p.remove ? h('button', { type: 'button', class: 'btn btn--small', 'aria-label': `Remove ${p.name}` }, 'Remove') : null;
      if (remove && p.remove) remove.addEventListener('click', p.remove);
      return h('li', {}, h('span', { class: 'lobby-name' }, p.name), h('span', { class: 'lobby-note' }, p.note), remove);
    }),
  );
}

function select<T extends string>(id: string, value: T, options: [T, string][], onChange: (v: T) => void): HTMLSelectElement {
  const el = h('select', { id }, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label))) as HTMLSelectElement;
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

/** The host's lobby: the invite, who has joined, and the game to deal. */
export function renderHostLobby(app: App, lobby: HostLobby, setup: NewGameSetup): HTMLElement {
  const link = inviteLink(location.href, lobby.code);
  const linkInput = h('input', { type: 'text', id: 'invite-link', readonly: true, value: link, 'aria-label': 'Invite link' }) as HTMLInputElement;
  linkInput.addEventListener('focus', () => linkInput.select());
  const copy = h('button', { type: 'button', class: 'btn' }, 'Copy link');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied');
    } catch {
      linkInput.focus();
      toast('Select the link and copy it', 'info');
    }
  });
  const share =
    typeof navigator.share === 'function'
      ? (() => {
          const b = h('button', { type: 'button', class: 'btn' }, 'Share');
          b.addEventListener('click', () => {
            navigator.share({ title: 'Velvet Hold’em', text: `Join my poker table — code ${formatRoomCode(lobby.code)}`, url: link }).catch(() => undefined);
          });
          return b;
        })()
      : null;

  const players = h('div', {});
  const seatsNote = h('span', { class: 'field-hint' });
  const aiCount = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'AI opponents' });
  const start = h('button', { type: 'button', class: 'btn btn--primary btn--large' }, 'Deal');
  const error = h('p', { class: 'form-error', role: 'alert' });

  const maxAi = () => MAX_OPPONENTS - lobby.guests.length;
  const refresh = () => {
    if (setup.opponents.length > maxAi()) setup.opponents.length = maxAi();
    players.replaceChildren(
      playerList([
        { name: lobby.hostName, note: 'You · host' },
        ...lobby.guests.map((g) => ({ name: g.name, note: g.connected ? 'Joined' : 'Reconnecting…', remove: () => lobby.remove(g.peerId) })),
      ]),
    );
    const total = 1 + lobby.guests.length;
    seatsNote.textContent =
      lobby.guests.length === 0
        ? 'Waiting for friends to join…'
        : `${total} ${total === 1 ? 'player' : 'players'} · ${MAX_GUESTS + 1 - total - setup.opponents.length} empty seats`;
    aiCount.replaceChildren(
      ...Array.from({ length: maxAi() + 1 }, (_, n) => {
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(setup.opponents.length === n), class: 'seg' }, String(n));
        b.addEventListener('click', () => {
          app.fillAiSeats(
            setup,
            n,
            lobby.guests.map((g) => g.name),
          );
          refresh();
        });
        return b;
      }),
    );
    start.toggleAttribute('aria-disabled', lobby.guests.length === 0);
  };
  lobby.onChange = () => {
    if (players.isConnected) refresh();
  };
  refresh();

  const stack = h('input', {
    type: 'number',
    id: 'lobby-stack',
    min: '100',
    step: '50',
    inputmode: 'numeric',
    value: String(setup.startingStack),
  }) as HTMLInputElement;
  stack.addEventListener('input', () => (setup.startingStack = Math.round(Number(stack.value))));
  const options = h(
    'div',
    { class: 'lobby-options' },
    h(
      'label',
      { class: 'field', for: 'lobby-difficulty' },
      h('span', { class: 'field-label' }, 'AI difficulty'),
      select<Difficulty>(
        'lobby-difficulty',
        setup.difficulty,
        DIFFICULTY_ORDER.map((d) => [d, DIFFICULTIES[d].label]),
        (v) => (setup.difficulty = v),
      ),
    ),
    h('label', { class: 'field', for: 'lobby-stack' }, h('span', { class: 'field-label' }, 'Starting chips'), stack),
    h(
      'label',
      { class: 'field', for: 'lobby-structure' },
      h('span', { class: 'field-label' }, 'Blinds'),
      select<Structure>(
        'lobby-structure',
        setup.structure,
        (Object.keys(STRUCTURES) as Structure[]).map((k) => [k, `${STRUCTURES[k].label} — ${STRUCTURES[k].blurb.split('.')[0]}`]),
        (v) => (setup.structure = v),
      ),
    ),
    h(
      'label',
      { class: 'field', for: 'lobby-payout' },
      h('span', { class: 'field-label' }, 'Prizes'),
      select<PayoutId>(
        'lobby-payout',
        setup.payout,
        (Object.keys(PAYOUTS) as PayoutId[]).map((k) => [k, PAYOUTS[k].label]),
        (v) => (setup.payout = v),
      ),
    ),
  );

  start.addEventListener('click', () => {
    if (!lobby.guests.length) {
      error.textContent = 'Wait for at least one friend to join (or play against the AI from New game).';
      return;
    }
    const minPlayers = PAYOUTS[setup.payout].minPlayers;
    if (playerCount({ ...setup, guests: lobby.guests.length }) < minPlayers) {
      error.textContent = `"${PAYOUTS[setup.payout].label}" needs at least ${minPlayers} players. Add AI opponents or choose another prize.`;
      return;
    }
    error.textContent = '';
    app.startOnlineGame(lobby, setup);
  });
  const close = h('button', { type: 'button', class: 'btn' }, 'Close table');
  close.addEventListener('click', async () => {
    if (lobby.guests.length && !(await confirm('Close the table?', 'Everyone who joined will be disconnected.', 'Close table', true))) return;
    app.showFriends();
  });

  return h(
    'main',
    { class: 'screen screen-setup screen-lobby' },
    h(
      'div',
      { class: 'setup-form' },
      h(
        'header',
        { class: 'setup-head' },
        h('h1', {}, 'Your table'),
        h('p', {}, 'Send your friends the code or the link. Keep this page open: your browser runs the game.'),
      ),
      h(
        'section',
        { class: 'setup-section' },
        h('h2', {}, 'Invite'),
        h('p', { class: 'lobby-code', 'aria-label': `Table code ${[...lobby.code].join(' ')}` }, formatRoomCode(lobby.code)),
        h('div', { class: 'invite-row' }, linkInput, copy, share),
      ),
      h('section', { class: 'setup-section' }, h('div', { class: 'section-head' }, h('h2', {}, 'Players'), seatsNote), players),
      h(
        'section',
        { class: 'setup-section' },
        h('div', { class: 'section-head' }, h('h2', {}, 'AI opponents'), aiCount),
        h('p', { class: 'field-hint' }, 'Fill empty seats with computer players. They play every friend the same way they play you.'),
        options,
      ),
      error,
      h('div', { class: 'setup-actions' }, close, start),
    ),
  );
}

export interface GuestLobbyView {
  root: HTMLElement;
  update(state: GuestState, players: LobbyPlayer[]): void;
}

/** A friend's waiting room until the host deals. */
export function renderGuestLobby(app: App, code: string): GuestLobbyView {
  const status = h('p', { class: 'lobby-status', role: 'status' }, 'Looking for the table…');
  const players = h('div', {});
  const leave = h('button', { type: 'button', class: 'btn' }, 'Leave');
  leave.addEventListener('click', () => app.showMenu());
  const root = h(
    'main',
    { class: 'screen screen-setup screen-lobby' },
    h(
      'div',
      { class: 'setup-form' },
      h('header', { class: 'setup-head' }, h('h1', {}, `Table ${formatRoomCode(code)}`), status),
      h('section', { class: 'setup-section' }, h('h2', {}, 'Players'), players),
      h(
        'section',
        { class: 'setup-section setup-section--quiet' },
        h('h2', {}, 'How it works'),
        ...HOW_IT_WORKS.map((t) => h('p', { class: 'field-hint' }, t)),
      ),
      h('div', { class: 'setup-actions' }, leave),
    ),
  );
  return {
    root,
    update(state, list) {
      status.textContent =
        state === 'connecting'
          ? 'Looking for the table… This can take a few seconds.'
          : state === 'reconnecting'
            ? 'Lost the connection to the host. Reconnecting…'
            : 'You are in. Waiting for the host to deal.';
      players.replaceChildren(
        list.length
          ? playerList(list.map((p) => ({ name: p.name, note: p.host ? 'Host' : p.you ? 'You' : 'Joined' })))
          : h('p', { class: 'field-hint' }, 'The players appear here once you are connected.'),
      );
    },
  };
}
