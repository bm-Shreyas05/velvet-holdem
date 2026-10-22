import type { GuestSeat } from '../game/session.ts';
import { type GuestMessage, type HostMessage, type LobbyPlayer, PROTOCOL, parseGuestMessage, parseHostMessage } from './protocol.ts';
import { RemotePresenter } from './remote.ts';
import type { PeerRoom } from './room.ts';

/** Friends a host can seat (the host makes nine). */
export const MAX_GUESTS = 8;

export interface LobbyGuest {
  peerId: string;
  name: string;
  token: string;
  connected: boolean;
  /** Set once the game starts. */
  seat: number | null;
  remote: RemotePresenter | null;
}

/**
 * The host's side of a table with friends: admits players before the start, seats them when the
 * game begins, and reconnects anyone who drops out and comes back (recognised by a token their
 * browser keeps for this table). Nobody new can join a game in progress.
 */
export class HostLobby {
  readonly code: string;
  readonly room: PeerRoom;
  hostName: string;
  onChange: () => void = () => undefined;
  onNotice: (message: string) => void = () => undefined;
  #guests: LobbyGuest[] = [];
  #started = false;
  #closed = false;

  constructor(room: PeerRoom, code: string, hostName: string) {
    this.room = room;
    this.code = code;
    this.hostName = hostName;
    room.onMessage = (data, peerId) => {
      const message = parseGuestMessage(data);
      if (message) this.#receive(message, peerId);
    };
    room.onPeerLeave = (peerId) => this.#lost(peerId);
  }

  get guests(): readonly LobbyGuest[] {
    return this.#guests;
  }

  get started(): boolean {
    return this.#started;
  }

  #to(peerId: string, message: HostMessage): void {
    if (!this.#closed) this.room.send(message, peerId);
  }

  #receive(message: GuestMessage, peerId: string): void {
    if (this.#closed) return;
    const guest = this.#guests.find((g) => g.peerId === peerId);
    if (message.t === 'answer') {
      guest?.remote?.receive(message);
      return;
    }
    if (message.t === 'bye') {
      if (guest) this.#lost(peerId, true);
      return;
    }
    if (message.v !== PROTOCOL) {
      this.#to(peerId, { t: 'reject', reason: 'The host is on a different version of the game. Both of you should reload the page.' });
      return;
    }
    const known = this.#guests.find((g) => g.token === message.token);
    if (this.#started) {
      if (!known?.remote) {
        this.#to(peerId, { t: 'reject', reason: 'This game has already started.' });
        return;
      }
      known.peerId = peerId;
      if (!known.connected) this.onNotice(`${known.name} is back.`);
      known.connected = true;
      known.remote.connect((m) => this.#to(peerId, m));
      this.onChange();
      return;
    }
    if (known) {
      known.peerId = peerId;
      known.connected = true;
      known.name = this.#uniqueName(message.name, known);
    } else {
      if (this.#guests.length >= MAX_GUESTS) {
        this.#to(peerId, { t: 'reject', reason: 'The table is full.' });
        return;
      }
      this.#guests.push({ peerId, token: message.token, name: this.#uniqueName(message.name, null), connected: true, seat: null, remote: null });
    }
    this.#broadcastLobby();
    this.onChange();
  }

  /** "Sam", or "Sam 2" if the name is taken (names identify players at the table). */
  #uniqueName(wanted: string, self: LobbyGuest | null): string {
    const base = wanted || `Guest ${this.#guests.length + 1}`;
    const taken = new Set([this.hostName, ...this.#guests.filter((g) => g !== self).map((g) => g.name)].map((n) => n.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) {
      const name = `${base.slice(0, 21)} ${i}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  #lost(peerId: string, left = false): void {
    const guest = this.#guests.find((g) => g.peerId === peerId);
    if (!guest || this.#closed) return;
    if (!this.#started) {
      this.#guests.splice(this.#guests.indexOf(guest), 1);
      this.#broadcastLobby();
    } else if (guest.connected) {
      guest.connected = false;
      guest.remote?.disconnect();
      this.onNotice(
        left ? `${guest.name} left the table. Their hands will fold.` : `${guest.name} lost the connection. Their hands will fold until they are back.`,
      );
    }
    this.onChange();
  }

  #broadcastLobby(): void {
    for (const g of this.#guests) {
      const players: LobbyPlayer[] = [
        { name: this.hostName, host: true, you: false },
        ...this.#guests.map((o) => ({ name: o.name, host: false, you: o === g })),
      ];
      this.#to(g.peerId, { t: 'lobby', players, seats: MAX_GUESTS + 1 });
    }
  }

  setHostName(name: string): void {
    this.hostName = name;
    for (const g of this.#guests) g.name = this.#uniqueName(g.name, g);
    this.#broadcastLobby();
    this.onChange();
  }

  /** Before the start only. */
  remove(peerId: string): void {
    const guest = this.#guests.find((g) => g.peerId === peerId);
    if (!guest || this.#started) return;
    this.#to(peerId, { t: 'reject', reason: 'The host removed you from the table.' });
    this.#guests.splice(this.#guests.indexOf(guest), 1);
    this.#broadcastLobby();
    this.onChange();
  }

  /** Seats everyone present (seat 0 is the host) and returns their stand-ins for the controller. */
  start(): { guests: GuestSeat[]; remotes: Map<number, RemotePresenter> } {
    this.#started = true;
    this.#guests = this.#guests.filter((g) => g.connected);
    const remotes = new Map<number, RemotePresenter>();
    const guests = this.#guests.map((g, i) => {
      g.seat = i + 1;
      g.remote = new RemotePresenter();
      g.remote.connect((m) => this.#to(g.peerId, m));
      remotes.set(g.seat, g.remote);
      return { id: `guest-${i + 1}`, name: g.name };
    });
    this.onChange();
    return { guests, remotes };
  }

  /** After a game: back to the lobby with everyone still connected, ready for a rematch. */
  reopen(): void {
    if (this.#closed) return;
    this.#started = false;
    this.#guests = this.#guests.filter((g) => g.connected);
    for (const g of this.#guests) {
      g.seat = null;
      g.remote = null;
    }
    this.#broadcastLobby();
    this.onChange();
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(reason = 'The host closed the table.'): void {
    if (this.#closed) return;
    for (const g of this.#guests) if (g.connected) this.#to(g.peerId, { t: 'end', reason });
    this.#closed = true;
    // Give the goodbye a moment to leave before the connections close.
    setTimeout(() => this.room.leave(), 300);
  }
}

// ---------------------------------------------------------------------------------------------

export type GuestState = 'connecting' | 'lobby' | 'playing' | 'reconnecting' | 'closed';

/** How long to look for the host before giving up. */
export const CONNECT_TIMEOUT_MS = 30_000;

/**
 * A friend's side: finds the host in the room, introduces itself, then hands every table message
 * to the game screen. Only the peer that answered as the host is listened to afterwards.
 */
export class GuestClient {
  readonly room: PeerRoom;
  readonly token: string;
  name: string;
  state: GuestState = 'connecting';
  onLobby: (players: LobbyPlayer[], seats: number) => void = () => undefined;
  onTable: (message: HostMessage) => void = () => undefined;
  onState: (state: GuestState) => void = () => undefined;
  onClosed: (reason: string) => void = () => undefined;
  #hostId: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(room: PeerRoom, name: string, token: string, timeoutMs = CONNECT_TIMEOUT_MS) {
    this.room = room;
    this.name = name;
    this.token = token;
    room.onPeerJoin = (peerId) => {
      if (this.state === 'closed') return;
      if (!this.#hostId || this.#hostId === peerId) this.#hello(peerId);
    };
    room.onPeerLeave = (peerId) => {
      if (peerId !== this.#hostId || this.state === 'closed') return;
      // The host may come straight back (a network change); wait before giving up.
      this.#setState('reconnecting');
      this.#arm(timeoutMs, 'Lost the connection to the host.');
    };
    room.onMessage = (data, peerId) => this.#receive(data, peerId);
    room.onError = () => {
      if (this.state === 'connecting') this.#arm(5000, 'Could not connect to the table. Your network may block direct connections.');
    };
    this.#arm(timeoutMs, 'Could not reach the table. Check the code, and that the host still has the game open.');
  }

  #hello(peerId: string): void {
    this.room.send({ t: 'hello', v: PROTOCOL, name: this.name, token: this.token } satisfies GuestMessage, peerId);
  }

  #arm(ms: number, reason: string): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#close(reason), ms);
  }

  #setState(state: GuestState): void {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  #receive(data: unknown, peerId: string): void {
    if (this.state === 'closed') return;
    const message = parseHostMessage(data);
    if (!message || (this.#hostId && peerId !== this.#hostId)) return;
    this.#hostId = peerId;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    switch (message.t) {
      case 'lobby':
        this.#setState('lobby');
        this.onLobby(message.players, message.seats);
        break;
      case 'reject':
      case 'end':
        this.#close(message.reason || 'The host closed the table.');
        break;
      default:
        this.#setState('playing');
        this.onTable(message);
    }
  }

  #close(reason: string): void {
    if (this.state === 'closed') return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#setState('closed');
    this.room.leave();
    this.onClosed(reason);
  }

  send(message: GuestMessage): void {
    if (this.#hostId && this.state !== 'closed') this.room.send(message, this.#hostId);
  }

  leave(): void {
    if (this.state === 'closed') return;
    this.send({ t: 'bye' });
    if (this.#timer) clearTimeout(this.#timer);
    this.state = 'closed';
    setTimeout(() => this.room.leave(), 200);
  }
}
