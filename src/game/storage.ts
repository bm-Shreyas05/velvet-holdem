import type { HandHistoryRecord } from './history.ts';
import { isHistoryRecord } from './history.ts';
import { type KeyValueStore, MemoryStore, SlotStore, browserStore } from './persistence.ts';
import { type SessionData, SESSION_VERSION, validateSession } from './session.ts';
import { type Settings, normaliseSettings } from './settings.ts';
import { type CareerStats, emptyCareer, isPlayerStats } from './stats.ts';

export interface HistoryFile {
  gameId: string;
  records: HandHistoryRecord[];
}

export const HISTORY_LIMIT = 300;

/**
 * Everything the game keeps between visits, each in its own crash-safe slot:
 * settings, the game in progress, that game's hand history, and lifetime statistics.
 * When the browser refuses storage the game still works, in memory only.
 */
export class GameStorage {
  readonly persistent: boolean;
  readonly settings: SlotStore<Settings>;
  readonly session: SlotStore<SessionData>;
  readonly history: SlotStore<HistoryFile>;
  readonly career: SlotStore<CareerStats>;
  #warned = false;
  onWriteFailure: ((reason: string) => void) | null = null;

  constructor(store: KeyValueStore | null = browserStore()) {
    this.persistent = store !== null;
    const kv = store ?? new MemoryStore();
    this.settings = new SlotStore<Settings>(kv, 'velvet.settings', {
      kind: 'settings',
      version: 1,
      validate: (p) => (p && typeof p === 'object' ? null : 'not a settings object'),
      normalise: (p) => normaliseSettings(p),
    });
    this.session = new SlotStore<SessionData>(kv, 'velvet.session', { kind: 'session', version: SESSION_VERSION, validate: validateSession });
    this.history = new SlotStore<HistoryFile>(kv, 'velvet.history', {
      kind: 'history',
      version: 1,
      validate: (p) => {
        const f = p as HistoryFile;
        return f && typeof f.gameId === 'string' && Array.isArray(f.records) && f.records.every(isHistoryRecord) ? null : 'damaged hand history';
      },
    });
    this.career = new SlotStore<CareerStats>(kv, 'velvet.career', {
      kind: 'career',
      version: 1,
      validate: (p) => (isPlayerStats(p) && typeof (p as CareerStats).gamesPlayed === 'number' ? null : 'damaged statistics'),
      normalise: (p) => ({ ...emptyCareer(), ...p }),
    });
  }

  /** Reports the first failed write once, so the player knows progress is not being kept. */
  write<T>(slot: SlotStore<T>, value: T): boolean {
    const r = slot.save(value);
    if (!r.ok && !this.#warned) {
      this.#warned = true;
      this.onWriteFailure?.(r.reason);
    }
    if (r.ok) this.#warned = false;
    return r.ok;
  }

  loadSettings(): Settings {
    const r = this.settings.load();
    return r.status === 'ok' ? r.payload : normaliseSettings(null);
  }

  loadCareer(): CareerStats {
    const r = this.career.load();
    return r.status === 'ok' ? r.payload : emptyCareer();
  }

  loadHistory(gameId: string): HandHistoryRecord[] {
    const r = this.history.load();
    return r.status === 'ok' && r.payload.gameId === gameId ? r.payload.records : [];
  }
}
