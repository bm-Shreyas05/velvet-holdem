import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InlineAiHost } from '../src/ai/host.ts';
import { SeededRng } from '../src/engine/rng.ts';
import type { LegalActions } from '../src/engine/types.ts';
import { defaultSetup, type NewGameSetup } from '../src/game/config.ts';
import { GameController, type HandSummary, type TableSnapshot } from '../src/game/controller.ts';
import { createSession } from '../src/game/session.ts';
import { GuestDriver } from '../src/net/guest.ts';
import { GuestClient, HostLobby, MAX_GUESTS } from '../src/net/lobby.ts';
import { cleanName, formatRoomCode, type HostMessage, inviteLink, newRoomCode, parseAction, parseRoomCode, PROTOCOL } from '../src/net/protocol.ts';
import { RemotePresenter } from '../src/net/remote.ts';
import { MemoryHub, type PeerRoom } from '../src/net/room.ts';
import { randomLegalAction } from '../src/sim/bots.ts';
import { HeadlessPresenter } from '../src/sim/headless.ts';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function until(condition: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(2);
  }
}

interface Friend {
  client: GuestClient;
  presenter: HeadlessPresenter;
  driver: GuestDriver;
  resets: number;
  asks: number;
  lobbies: string[][];
  closed: string | null;
}

function friend(room: PeerRoom, name: string, token: string, rng: SeededRng): Friend {
  const presenter = HeadlessPresenter.random(rng);
  const client = new GuestClient(room, name, token);
  const f: Friend = { client, presenter, driver: null as unknown as GuestDriver, resets: 0, asks: 0, lobbies: [], closed: null };
  f.driver = new GuestDriver(presenter, (m) => client.send(m), { cancelDecision: () => undefined });
  client.onLobby = (players) => f.lobbies.push(players.map((p) => `${p.name}${p.host ? ' (host)' : ''}${p.you ? ' (you)' : ''}`));
  client.onTable = (m: HostMessage) => {
    if (m.t === 'call' && m.m === 'reset') f.resets++;
    if (m.t === 'ask') f.asks++;
    f.driver.receive(m);
  };
  client.onClosed = (reason) => (f.closed = reason);
  return f;
}

function onlineSetup(seed: string, guests: number): NewGameSetup {
  return {
    ...defaultSetup(),
    guests,
    playerName: 'Hosting Hal',
    difficulty: 'casual',
    startingStack: 300,
    structure: 'turbo',
    payout: 'top2',
    seed,
    opponents: [
      { name: 'Rico Vance', style: 'shark' },
      { name: 'Benny Tuck', style: 'station' },
    ],
  };
}

/** No snapshot or event a friend received showed anyone else's unrevealed cards; hand records neither. */
function assertPrivate(f: Friend, seat: number): void {
  assert.deepEqual(f.presenter.violations, [], `${f.client.name} saw hidden cards`);
  for (const s of f.presenter.summaries) {
    assert.equal(s.record.humanSeat, seat, 'hand records are written from the friend’s own seat');
    for (const p of s.record.players) {
      if (p.seat === seat || !p.cards) continue;
      assert.ok(s.record.showdown && !p.folded, `hand ${s.record.handNumber}: record shows seat ${p.seat}'s unshown cards`);
    }
  }
}

test('online: a host and two friends play a whole tournament, each seeing only their own cards', async () => {
  const hub = new MemoryHub();
  const lobby = new HostLobby(hub.join('t'), 'ABCDEFGH', 'Hosting Hal');
  const rng = new SeededRng('friends');
  const ann = friend(hub.join('t'), 'Ann', 'token-ann-0001', rng);
  const ben = friend(hub.join('t'), 'Ann', 'token-ben-0001', rng); // same name: becomes "Ann 2"
  await until(() => lobby.guests.length === 2 && ann.lobbies.length > 0 && ben.lobbies.length > 0, 'both friends in the lobby');
  assert.deepEqual(
    lobby.guests.map((g) => g.name),
    ['Ann', 'Ann 2'],
  );
  assert.deepEqual(ann.lobbies.at(-1), ['Hosting Hal (host)', 'Ann (you)', 'Ann 2']);

  const { guests, remotes } = lobby.start();
  const session = createSession(onlineSetup('online-1', 2), guests);
  assert.deepEqual(
    session.seats.map((s) => `${s.name}:${s.kind}`),
    ['Hosting Hal:human', 'Ann:remote', 'Ann 2:remote', 'Rico Vance:ai', 'Benny Tuck:ai'],
  );
  const host = HeadlessPresenter.random(rng);
  host.eliminationChoice = 'skip'; // cannot skip ahead while friends play: the game must go on
  const controller = new GameController(session, host, new InlineAiHost(), {}, remotes);
  await controller.run();
  const info = host.gameOverInfo!;
  assert.ok(info, 'the tournament finished');
  await until(() => !!ann.presenter.gameOverInfo && !!ben.presenter.gameOverInfo, 'friends hearing the result');

  const places = controller.session.table.players.map((p) => p.place);
  for (const [f, seat] of [
    [ann, 1],
    [ben, 2],
  ] as const) {
    assert.equal(f.presenter.gameOverInfo!.winnerName, info.winnerName);
    assert.equal(f.presenter.gameOverInfo!.humanPlace, places[seat] ?? 1, `${f.client.name}'s place`);
    assert.ok(f.asks > 0, `${f.client.name} made decisions`);
    assert.ok(f.presenter.summaries.length > 0);
    assertPrivate(f, seat);
  }
  assert.deepEqual(host.violations, []);
  const total = controller.session.table.players.reduce((s, p) => s + p.stack, 0);
  assert.equal(total, 300 * 5, 'every chip accounted for');
});

test('online: a friend who drops out folds until they reconnect, then gets the table back', async () => {
  const hub = new MemoryHub();
  const lobby = new HostLobby(hub.join('t'), 'ABCDEFGH', 'Hosting Hal');
  const notices: string[] = [];
  lobby.onNotice = (m) => notices.push(m);
  const rng = new SeededRng('drop');
  let ann = friend(hub.join('t'), 'Ann', 'token-ann-0002', rng);
  await until(() => lobby.guests.length === 1, 'Ann in the lobby');
  const { guests, remotes } = lobby.start();
  const host = new HeadlessPresenter((legal: LegalActions) => (legal.canCheck ? { kind: 'check' } : legal.canCall ? { kind: 'call' } : { kind: 'fold' }));
  let hands = 0;
  let rejoinedAsks = 0;
  const handFinished = host.handFinished.bind(host);
  host.handFinished = async (summary: HandSummary) => {
    hands++;
    if (hands === 2) ann.client.room.leave(); // the connection drops (no goodbye)
    if (hands === 5) {
      ann = friend(hub.join('t'), 'Ann', 'token-ann-0002', rng); // reload: same browser token
      const asked = ann.client.onTable;
      ann.client.onTable = (m) => {
        if (m.t === 'ask') rejoinedAsks++;
        asked(m);
      };
    }
    if (hands === 12) controller.stop();
    await tick(5);
    return handFinished(summary);
  };
  const setup = { ...onlineSetup('online-2', 1), startingStack: 5000, structure: 'fixed' as const, payout: 'winner' as const };
  const controller = new GameController(createSession(setup, guests), host, new InlineAiHost(), {}, remotes);
  await controller.run();
  assert.ok(
    notices.some((n) => /Ann lost the connection/.test(n)),
    notices.join('|'),
  );
  assert.ok(
    notices.some((n) => /Ann is back/.test(n)),
    notices.join('|'),
  );
  assert.ok(ann.resets >= 1, 'the returning friend was sent the whole table');
  assert.ok(rejoinedAsks > 0, 'and plays again');
  assertPrivate(ann, 1);
});

test('online: the lobby turns away latecomers, a full table and other versions, and can remove a player', async () => {
  const hub = new MemoryHub();
  const lobby = new HostLobby(hub.join('t'), 'ABCDEFGH', 'Hal');
  const rng = new SeededRng('lobby');
  const crowd = Array.from({ length: MAX_GUESTS + 1 }, (_, i) => friend(hub.join('t'), `P${i}`, `token-crowd-${i}0000`, rng));
  await until(() => lobby.guests.length === MAX_GUESTS && crowd.some((f) => f.closed), 'the lobby filling up');
  assert.equal(crowd.filter((f) => f.closed === 'The table is full.').length, 1);

  const kicked = crowd.find((f) => !f.closed)!;
  lobby.remove(lobby.guests.find((g) => g.name === kicked.client.name)!.peerId);
  await until(() => !!kicked.closed, 'the removed player hearing it');
  assert.equal(kicked.closed, 'The host removed you from the table.');

  const room = hub.join('t');
  let reply: unknown = null;
  room.onMessage = (data) => (reply = data);
  room.onPeerJoin = (peer) => room.send({ t: 'hello', v: PROTOCOL + 1, name: 'Future', token: 'token-future-01' }, peer);
  await until(() => reply !== null, 'a reply to a newer version');
  assert.match((reply as { reason: string }).reason, /different version/);

  lobby.start();
  const late = friend(hub.join('t'), 'Late', 'token-late-0001', rng);
  await until(() => !!late.closed, 'the latecomer hearing it');
  assert.equal(late.closed, 'This game has already started.');
  lobby.close();
  const seated = crowd.find((f) => !f.closed)!;
  await until(() => !!seated.closed, 'friends hearing the table close');
  assert.equal(seated.closed, 'The host closed the table.');
});

test('online: the shot clock acts for a friend who does not answer, and bad answers are refused', async () => {
  const sent: HostMessage[] = [];
  const remote = new RemotePresenter(40);
  remote.connect((m) => sent.push(m));
  const snapshot = { view: null } as unknown as TableSnapshot;
  const legal = { canCheck: false, canCall: true, canFold: true } as LegalActions;
  assert.deepEqual(await remote.requestAction(snapshot, legal), { kind: 'fold' }, 'timed out: fold when facing a bet');
  assert.deepEqual(
    sent.map((m) => m.t),
    ['ask', 'cancel'],
  );

  const asked = remote.requestAction(snapshot, legal);
  const ask = sent.at(-1) as Extract<HostMessage, { t: 'ask' }>;
  remote.receive({ t: 'answer', id: ask.id - 1, value: { kind: 'call' } }); // stale: ignored
  remote.receive({ t: 'answer', id: ask.id, value: { kind: 'raise', to: 'lots' } });
  assert.deepEqual(await asked, { kind: 'fold' }, 'a malformed answer becomes the safe action');

  const answered = remote.requestAction(snapshot, legal);
  remote.receive({ t: 'answer', id: (sent.at(-1) as { id: number }).id, value: { kind: 'call', extra: 'ignored' } });
  assert.deepEqual(await answered, { kind: 'call' });

  remote.disconnect();
  assert.deepEqual(await remote.requestAction(snapshot, { ...legal, canCheck: true }), { kind: 'check' }, 'away from the table: check when free');
});

test('online: a friend’s screen that falls far behind skips to the current table', async () => {
  const shown: string[] = [];
  let release: () => void = () => undefined;
  const slow = new HeadlessPresenter(() => ({ kind: 'check' }));
  slow.present = (events) => {
    shown.push(`present ${events.length}`);
    return new Promise<void>((r) => (release = r));
  };
  slow.reset = () => void shown.push('reset');
  const driver = new GuestDriver(slow, () => undefined, { cancelDecision: () => undefined });
  const snap = (n: number) => ({ handNumber: n, view: null }) as unknown as TableSnapshot;
  for (let i = 1; i <= 10; i++) driver.receive({ t: 'call', m: 'present', a: [[{ type: 'hand-end' }], snap(i)] });
  await tick();
  release(); // the first animation finishes; nine more are waiting
  await tick();
  assert.deepEqual(shown.slice(0, 3), ['present 1', 'reset', 'present 1']);
  assert.ok(driver.pending <= 2, 'the backlog was dropped');
});

test('online: room codes are unambiguous, survive dashes, case and whole links, and names are cleaned', () => {
  for (let i = 0; i < 200; i++) {
    const code = newRoomCode();
    assert.match(code, /^[A-HJKMNP-Z2-9]{8}$/);
    assert.equal(parseRoomCode(formatRoomCode(code).toLowerCase()), code);
    assert.equal(parseRoomCode(inviteLink('https://example.com/velvet/?x=1', code)), code);
  }
  assert.equal(inviteLink('https://example.com/velvet/', 'ABCDEFGH'), 'https://example.com/velvet/#join=ABCDEFGH');
  assert.equal(parseRoomCode('ABCD-EFG0'), null, 'zero is not in the alphabet');
  assert.equal(parseRoomCode('short'), null);
  assert.equal(cleanName('  Sam\u0000\u202e  '), 'Sam');
  assert.equal(cleanName('x'.repeat(40)).length, 24);
  assert.equal(cleanName(42), '');
  assert.equal(parseAction({ kind: 'raise', to: 3.5 }), null);
  assert.equal(parseAction({ kind: 'shove' }), null);
  assert.deepEqual(parseAction({ kind: 'bet', to: 120 }), { kind: 'bet', to: 120 });
});

test('online: a friend can be randomly bot-driven through many games without breaking the table', async () => {
  for (const seed of ['soak-1', 'soak-2', 'soak-3']) {
    const hub = new MemoryHub();
    const lobby = new HostLobby(hub.join('t'), 'ABCDEFGH', 'Hosting Hal');
    const rng = new SeededRng(seed);
    const friends = ['Ann', 'Bo', 'Cy'].map((n, i) => friend(hub.join('t'), n, `token-${seed}-${i}000`, rng));
    await until(() => lobby.guests.length === 3, 'three friends');
    const { guests, remotes } = lobby.start();
    const setup = { ...onlineSetup(seed, 3), opponents: [{ name: 'Rico Vance', style: 'maniac' as const }], startingStack: 200 };
    const host = new HeadlessPresenter((legal) => randomLegalAction(legal, rng));
    const controller = new GameController(createSession(setup, guests), host, new InlineAiHost(), {}, remotes);
    await controller.run();
    assert.ok(host.gameOverInfo, `${seed} finished`);
    await until(() => friends.every((f) => f.presenter.gameOverInfo), 'everyone hearing the result');
    for (const [i, f] of friends.entries()) assertPrivate(f, i + 1);
  }
});
