/**
 * A room of peers that can message each other. The game only sees this interface:
 * - trysteroRoom (src/net/trystero-room.ts): the real thing — WebRTC data channels between
 *   browsers, introduced to each other through free public relays;
 * - BroadcastRoom: tabs of one browser (developer mode and the browser tests);
 * - MemoryHub: an in-process room for unit tests.
 */
export interface PeerRoom {
  readonly selfId: string;
  onPeerJoin: (peerId: string) => void;
  onPeerLeave: (peerId: string) => void;
  onMessage: (data: unknown, peerId: string) => void;
  /** A connection could not be made (bad network, blocked WebRTC…). */
  onError: (message: string) => void;
  /** To one peer, or to everyone in the room. */
  send(data: unknown, to?: string): void;
  leave(): void;
}

const noop = () => undefined;

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36).padStart(2, '0')).join('');
}

abstract class BaseRoom implements PeerRoom {
  readonly selfId = randomId();
  onPeerJoin: (peerId: string) => void = noop;
  onPeerLeave: (peerId: string) => void = noop;
  onMessage: (data: unknown, peerId: string) => void = noop;
  onError: (message: string) => void = noop;
  abstract send(data: unknown, to?: string): void;
  abstract leave(): void;
}

// ---------------------------------------------------------------------------------------------

/** In-process rooms. Delivery is asynchronous and every message is copied, like a real network. */
export class MemoryHub {
  #rooms = new Map<string, Set<MemoryRoom>>();

  join(roomId: string): PeerRoom {
    const peers = this.#rooms.get(roomId) ?? new Set<MemoryRoom>();
    this.#rooms.set(roomId, peers);
    const room = new MemoryRoom(this, roomId);
    for (const other of peers) {
      queueMicrotask(() => {
        if (!room.left && !other.left) {
          other.onPeerJoin(room.selfId);
          room.onPeerJoin(other.selfId);
        }
      });
    }
    peers.add(room);
    return room;
  }

  /** @internal */
  peers(roomId: string): Set<MemoryRoom> {
    return this.#rooms.get(roomId) ?? new Set();
  }
}

class MemoryRoom extends BaseRoom {
  left = false;
  readonly #hub: MemoryHub;
  readonly #roomId: string;

  constructor(hub: MemoryHub, roomId: string) {
    super();
    this.#hub = hub;
    this.#roomId = roomId;
  }

  send(data: unknown, to?: string): void {
    if (this.left) return;
    const copy = JSON.stringify(data);
    for (const peer of this.#hub.peers(this.#roomId)) {
      if (peer === this || peer.left || (to && peer.selfId !== to)) continue;
      setTimeout(() => {
        if (!peer.left && !this.left) peer.onMessage(JSON.parse(copy), this.selfId);
      }, 0);
    }
  }

  leave(): void {
    if (this.left) return;
    this.left = true;
    const peers = this.#hub.peers(this.#roomId);
    peers.delete(this);
    for (const peer of peers) setTimeout(() => peer.onPeerLeave(this.selfId), 0);
  }
}

// ---------------------------------------------------------------------------------------------

type Wire = { k: 'here' | 'here-too' | 'gone'; from: string; to?: string } | { k: 'msg'; from: string; to?: string; data: unknown };

/** Tabs of the same browser, over a BroadcastChannel. */
export class BroadcastRoom extends BaseRoom {
  readonly #channel: BroadcastChannel;
  readonly #peers = new Set<string>();
  #left = false;
  readonly #onHide = () => this.leave();

  constructor(roomId: string) {
    super();
    this.#channel = new BroadcastChannel(`velvet-room:${roomId}`);
    this.#channel.onmessage = (e: MessageEvent<Wire>) => this.#receive(e.data);
    addEventListener('pagehide', this.#onHide);
    // Announce after the caller has attached its handlers.
    setTimeout(() => this.#post({ k: 'here', from: this.selfId }), 0);
  }

  #post(w: Wire): void {
    if (!this.#left) this.#channel.postMessage(w);
  }

  #receive(w: Wire): void {
    if (this.#left || w.from === this.selfId || (w.to && w.to !== this.selfId)) return;
    if (w.k === 'here' || w.k === 'here-too') {
      if (w.k === 'here') this.#post({ k: 'here-too', from: this.selfId, to: w.from });
      if (!this.#peers.has(w.from)) {
        this.#peers.add(w.from);
        this.onPeerJoin(w.from);
      }
    } else if (w.k === 'gone') {
      if (this.#peers.delete(w.from)) this.onPeerLeave(w.from);
    } else if (w.k === 'msg' && this.#peers.has(w.from)) {
      this.onMessage(w.data, w.from);
    }
  }

  send(data: unknown, to?: string): void {
    this.#post({ k: 'msg', from: this.selfId, ...(to ? { to } : {}), data: JSON.parse(JSON.stringify(data)) });
  }

  leave(): void {
    if (this.#left) return;
    this.#post({ k: 'gone', from: this.selfId });
    this.#left = true;
    removeEventListener('pagehide', this.#onHide);
    this.#channel.close();
  }
}
