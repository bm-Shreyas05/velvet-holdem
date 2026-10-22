import { joinRoom, selfId } from 'trystero';
import type { PeerRoom } from './room.ts';

/**
 * A room over WebRTC: browsers find each other through free public Nostr relays (Trystero's
 * default), then talk directly. The relays only ever carry connection offers, encrypted with the
 * room code; the game itself travels peer to peer over DTLS-encrypted data channels. No account,
 * no server of our own. Some networks (strict corporate firewalls, a few mobile carriers) block
 * direct connections, and without a relay server of our own (TURN) those players cannot join.
 */
export function trysteroRoom(code: string): PeerRoom {
  const noop = () => undefined;
  const room: PeerRoom = {
    selfId,
    onPeerJoin: noop,
    onPeerLeave: noop,
    onMessage: noop,
    onError: noop,
    send: (data, to) => {
      action.send(JSON.stringify(data), to ? { target: to } : undefined).catch(() => undefined);
    },
    leave: () => {
      inner.leave().catch(() => undefined);
    },
  };
  const inner = joinRoom({ appId: 'velvet-holdem.table.v1', password: code, relayConfig: { warnOnRelayFailure: false } }, `table-${code}`, {
    onJoinError: (details) => room.onError(details.error),
  });
  const action = inner.makeAction<string>('m');
  action.onMessage = (data, { peerId }) => {
    try {
      room.onMessage(JSON.parse(data), peerId);
    } catch {
      /* not JSON: ignore */
    }
  };
  inner.onPeerJoin = (peerId) => room.onPeerJoin(peerId);
  inner.onPeerLeave = (peerId) => room.onPeerLeave(peerId);
  return room;
}
