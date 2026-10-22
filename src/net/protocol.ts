import type { PlayerAction } from '../engine/types.ts';

/**
 * Wire format for games with friends. The host's browser runs the game; every message is JSON
 * sent over an encrypted WebRTC data channel (src/net/room.ts).
 *
 * Guest -> host: `hello` (join or rejoin), `answer` (a decision the host asked for), `bye`.
 * Host -> guest: `lobby` (who is at the table before the start), `reject`, `call` (one presenter
 * method, already built from the guest's own seat), `ask` (a presenter method that needs an
 * answer: the guest's decision), `cancel` (the shot clock ran out), `end` (the host closed the table).
 *
 * The host never sends anything a player may not see: snapshots and events are made from that
 * player's view, exactly as for the local player. Everything received is checked before use.
 */
export const PROTOCOL = 1;

/** Presenter methods a host may call on a guest. */
export const CALLS = ['reset', 'present', 'thinking', 'handFinished', 'humanEliminated', 'gameOver', 'actionRejected', 'notify'] as const;
export type CallName = (typeof CALLS)[number];

export interface LobbyPlayer {
  name: string;
  host: boolean;
  /** This entry is the player receiving the message. */
  you: boolean;
}

export type GuestMessage = { t: 'hello'; v: number; name: string; token: string } | { t: 'answer'; id: number; value: unknown } | { t: 'bye' };

export type HostMessage =
  | { t: 'lobby'; players: LobbyPlayer[]; seats: number }
  | { t: 'reject'; reason: string }
  | { t: 'call'; m: CallName; a: unknown[] }
  | { t: 'ask'; id: number; m: 'requestAction'; a: unknown[]; clockMs: number }
  | { t: 'cancel'; id: number }
  | { t: 'end'; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);

/** A display name from another device: trimmed, without control characters, at most 24 long. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return [...raw.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').trim()].slice(0, 24).join('');
}

export function parseGuestMessage(data: unknown): GuestMessage | null {
  if (!isObject(data)) return null;
  switch (data.t) {
    case 'hello':
      if (!isInt(data.v) || typeof data.token !== 'string' || !/^[\w-]{8,64}$/.test(data.token)) return null;
      return { t: 'hello', v: data.v, name: cleanName(data.name), token: data.token };
    case 'answer':
      return isInt(data.id) ? { t: 'answer', id: data.id, value: data.value } : null;
    case 'bye':
      return { t: 'bye' };
    default:
      return null;
  }
}

export function parseHostMessage(data: unknown): HostMessage | null {
  if (!isObject(data)) return null;
  switch (data.t) {
    case 'lobby':
      if (!Array.isArray(data.players) || !isInt(data.seats)) return null;
      return {
        t: 'lobby',
        seats: data.seats,
        players: data.players.filter(isObject).map((p) => ({ name: cleanName(p.name), host: p.host === true, you: p.you === true })),
      };
    case 'reject':
    case 'end':
      return { t: data.t, reason: typeof data.reason === 'string' ? data.reason.slice(0, 200) : '' };
    case 'call':
      return (CALLS as readonly unknown[]).includes(data.m) && Array.isArray(data.a) ? { t: 'call', m: data.m as CallName, a: data.a } : null;
    case 'ask':
      return data.m === 'requestAction' && isInt(data.id) && Array.isArray(data.a) && isInt(data.clockMs)
        ? { t: 'ask', id: data.id, m: 'requestAction', a: data.a, clockMs: data.clockMs }
        : null;
    case 'cancel':
      return isInt(data.id) ? { t: 'cancel', id: data.id } : null;
    default:
      return null;
  }
}

/** A decision from another device, if it is shaped like one (legality is the engine's job). */
export function parseAction(value: unknown): PlayerAction | null {
  if (!isObject(value)) return null;
  switch (value.kind) {
    case 'fold':
    case 'check':
    case 'call':
      return { kind: value.kind };
    case 'bet':
    case 'raise':
      return isInt(value.to) && value.to > 0 ? { kind: value.kind, to: value.to } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Room codes

/** Letters and digits that cannot be mistaken for one another when read aloud or typed. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

/** A new room code, e.g. "K7QM3XPA" (about 40 bits: also the room's encryption password). */
export function newRoomCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(CODE_LENGTH * 2);
  let code = '';
  for (let i = 0; code.length < CODE_LENGTH && i < bytes.length; i++) {
    // Rejection sampling keeps every letter equally likely.
    if (bytes[i]! < 248) code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code.length === CODE_LENGTH ? code : newRoomCode(random);
}

/** Normalises a typed or pasted code ("k7qm-3xpa", a whole invite link…); null if it is not one. */
export function parseRoomCode(input: string): string | null {
  const fromLink = /[#&?]join=([^&#\s]+)/i.exec(input)?.[1];
  const raw = (fromLink ?? input).toUpperCase().replace(/[\s-]/g, '');
  if (raw.length !== CODE_LENGTH) return null;
  return [...raw].every((c) => CODE_ALPHABET.includes(c)) ? raw : null;
}

/** "K7QM-3XPA": easier to read out. */
export function formatRoomCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function inviteLink(base: string, code: string): string {
  const url = new URL(base);
  url.hash = `join=${code}`;
  return url.href;
}
