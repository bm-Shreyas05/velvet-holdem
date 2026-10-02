import { type KeyValueStore, MemoryStore } from './persistence.ts';
import { GameStorage } from './storage.ts';

/**
 * Exporting and importing everything the game keeps (settings, the game in progress, its hand
 * history, lifetime statistics and progress), so a player can move to another browser or device.
 *
 * A backup holds the stored slots exactly as saved — checksummed envelopes — so importing runs
 * the same integrity checks as loading: the backup is first loaded into a scratch store, and
 * nothing is overwritten unless every slot in it is readable.
 */
export const BACKUP_FORMAT = 'velvet-holdem-backup';
export const BACKUP_VERSION = 1;

export const SAVE_KEYS = ['velvet.settings', 'velvet.session', 'velvet.history', 'velvet.career', 'velvet.progress'] as const;
const SLOT_KEYS = SAVE_KEYS.flatMap((k) => [`${k}:a`, `${k}:b`]);

interface BackupFile {
  format: string;
  version: number;
  exportedAt: string;
  entries: Record<string, string>;
}

export function exportBackup(store: KeyValueStore, now = new Date()): string {
  const entries: Record<string, string> = {};
  for (const key of SLOT_KEYS) {
    const value = store.getItem(key);
    if (value !== null) entries[key] = value;
  }
  const file: BackupFile = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: now.toISOString(), entries };
  return JSON.stringify(file);
}

export type BackupCheck = { ok: true; entries: Record<string, string>; exportedAt: string; summary: string[] } | { ok: false; reason: string };

/** Parses and verifies a backup without touching the real saves. */
export function readBackup(text: string): BackupCheck {
  let file: BackupFile;
  try {
    file = JSON.parse(text) as BackupFile;
  } catch {
    return { ok: false, reason: 'the file is not a Velvet backup (it could not be read)' };
  }
  if (!file || file.format !== BACKUP_FORMAT || typeof file.entries !== 'object' || file.entries === null) {
    return { ok: false, reason: 'the file is not a Velvet backup' };
  }
  if (!Number.isInteger(file.version) || file.version > BACKUP_VERSION) return { ok: false, reason: 'the backup was made by a newer version of the game' };
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(file.entries)) {
    if (!SLOT_KEYS.includes(key)) return { ok: false, reason: `the backup contains unexpected data (${key.slice(0, 40)})` };
    if (typeof value !== 'string') return { ok: false, reason: 'the backup is damaged' };
    entries[key] = value;
  }
  if (!Object.keys(entries).length) return { ok: false, reason: 'the backup is empty' };

  // Load every slot from a scratch copy: damaged, edited or incompatible data is refused here.
  const scratch = new MemoryStore();
  for (const [key, value] of Object.entries(entries)) scratch.setItem(key, value);
  const storage = new GameStorage(scratch);
  const summary: string[] = [];
  const slots = [
    ['settings', storage.settings.load()],
    ['saved game', storage.session.load()],
    ['hand history', storage.history.load()],
    ['statistics', storage.career.load()],
    ['progress', storage.progress.load()],
  ] as const;
  for (const [label, result] of slots) {
    if (result.status === 'corrupt' || result.status === 'incompatible') return { ok: false, reason: `its ${label} could not be read: ${result.reason}` };
  }
  const career = storage.career.load();
  if (career.status === 'ok') summary.push(`${career.payload.handsPlayed.toLocaleString('en-US')} hands of statistics`);
  const session = storage.session.load();
  if (session.status === 'ok') summary.push('a saved game');
  const progress = storage.progress.load();
  if (progress.status === 'ok') {
    const earned = Object.keys(progress.payload.achievements).length;
    if (earned) summary.push(`${earned} achievement${earned === 1 ? '' : 's'}`);
  }
  return { ok: true, entries, exportedAt: typeof file.exportedAt === 'string' ? file.exportedAt : '', summary };
}

/** Replaces all saves with a verified backup's entries. */
export function applyBackup(store: KeyValueStore, entries: Record<string, string>): void {
  for (const key of SLOT_KEYS) store.removeItem(key);
  for (const [key, value] of Object.entries(entries)) store.setItem(key, value);
}
