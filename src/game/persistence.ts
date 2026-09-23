/**
 * Crash-safe local persistence.
 *
 * Every save is written as a self-describing envelope (format, kind, version, sequence number,
 * checksum) into one of two alternating slots. Loading takes the newest slot that parses, matches
 * its checksum and passes validation, so an interrupted or failed write can never destroy the
 * previous good save. Newer-version saves are refused rather than misread; older versions are
 * migrated step by step.
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

/** localStorage if the browser allows it (private modes and sandboxes may not). */
export function browserStore(): KeyValueStore | null {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const probe = '__velvet_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

export const SAVE_FORMAT = 'velvet-holdem';

interface Envelope {
  format: string;
  kind: string;
  version: number;
  seq: number;
  savedAt: string;
  checksum: string;
  payload: string;
}

/** cyrb53: fast 53-bit string hash, used to detect truncated or edited saves. */
export function checksum(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export type LoadResult<T> =
  | { status: 'ok'; payload: T; recovered: boolean }
  | { status: 'missing' }
  | { status: 'corrupt'; reason: string }
  | { status: 'incompatible'; reason: string };

export type SaveResult = { ok: true } | { ok: false; reason: string };

export interface SlotOptions<T> {
  kind: string;
  version: number;
  /** Returns a description of what is wrong, or null if the payload is usable. */
  validate: (payload: unknown) => string | null;
  /** migrations[v] upgrades a version-v payload to version v+1. */
  migrations?: Record<number, (payload: unknown) => unknown>;
  /** Called with the typed payload after validation (e.g. to fill defaults). */
  normalise?: (payload: T) => T;
}

export class SlotStore<T> {
  readonly #store: KeyValueStore;
  readonly #key: string;
  readonly #opts: SlotOptions<T>;

  constructor(store: KeyValueStore, key: string, opts: SlotOptions<T>) {
    this.#store = store;
    this.#key = key;
    this.#opts = opts;
  }

  #slots(): [string, string] {
    return [`${this.#key}:a`, `${this.#key}:b`];
  }

  #read(slot: string): { env: Envelope | null; error: string | null } {
    let raw: string | null;
    try {
      raw = this.#store.getItem(slot);
    } catch (e) {
      return { env: null, error: `storage unavailable (${e instanceof Error ? e.message : e})` };
    }
    if (raw === null) return { env: null, error: null };
    try {
      const env = JSON.parse(raw) as Envelope;
      if (!env || env.format !== SAVE_FORMAT || env.kind !== this.#opts.kind || typeof env.payload !== 'string') {
        return { env: null, error: 'not a save file for this game' };
      }
      if (!Number.isInteger(env.version) || !Number.isInteger(env.seq)) return { env: null, error: 'damaged header' };
      if (checksum(env.payload) !== env.checksum) return { env: null, error: 'checksum mismatch (the save was damaged)' };
      return { env, error: null };
    } catch {
      return { env: null, error: 'unreadable data' };
    }
  }

  load(): LoadResult<T> {
    const candidates: Envelope[] = [];
    const problems: string[] = [];
    for (const slot of this.#slots()) {
      const { env, error } = this.#read(slot);
      if (env) candidates.push(env);
      if (error) problems.push(error);
    }
    if (!candidates.length) {
      return problems.length ? { status: 'corrupt', reason: problems[0]! } : { status: 'missing' };
    }
    candidates.sort((a, b) => b.seq - a.seq);
    let incompatible: string | null = null;
    for (const [index, env] of candidates.entries()) {
      if (env.version > this.#opts.version) {
        incompatible = 'it was saved by a newer version of the game';
        continue;
      }
      try {
        let payload: unknown = JSON.parse(env.payload);
        for (let v = env.version; v < this.#opts.version; v++) {
          const migrate = this.#opts.migrations?.[v];
          if (!migrate) throw new Error(`no upgrade path from version ${v}`);
          payload = migrate(payload);
        }
        const problem = this.#opts.validate(payload);
        if (problem) {
          problems.push(problem);
          continue;
        }
        const typed = payload as T;
        return {
          status: 'ok',
          payload: this.#opts.normalise ? this.#opts.normalise(typed) : typed,
          recovered: index > 0 || problems.length > 0,
        };
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (incompatible) return { status: 'incompatible', reason: incompatible };
    return { status: 'corrupt', reason: problems[0] ?? 'unknown problem' };
  }

  save(payload: T): SaveResult {
    let text: string;
    try {
      text = JSON.stringify(payload);
    } catch (e) {
      return { ok: false, reason: `could not serialise (${e instanceof Error ? e.message : e})` };
    }
    // Write over the OLDER slot so the newest good save survives a failed write.
    const [a, b] = this.#slots();
    const ra = this.#read(a).env;
    const rb = this.#read(b).env;
    const target = !ra ? a : !rb ? b : ra.seq <= rb.seq ? a : b;
    const seq = Math.max(ra?.seq ?? 0, rb?.seq ?? 0) + 1;
    const env: Envelope = {
      format: SAVE_FORMAT,
      kind: this.#opts.kind,
      version: this.#opts.version,
      seq,
      savedAt: new Date().toISOString(),
      checksum: checksum(text),
      payload: text,
    };
    try {
      this.#store.setItem(target, JSON.stringify(env));
      return { ok: true };
    } catch (e) {
      const name = e instanceof Error ? `${e.name} ${e.message}` : String(e);
      return { ok: false, reason: /quota/i.test(name) ? 'browser storage is full' : 'browser storage is unavailable' };
    }
  }

  clear(): void {
    for (const slot of this.#slots()) {
      try {
        this.#store.removeItem(slot);
      } catch {
        /* storage unavailable: nothing to clear */
      }
    }
  }

  /** True if anything (valid or not) is stored under this key. */
  exists(): boolean {
    return this.#slots().some((slot) => {
      try {
        return this.#store.getItem(slot) !== null;
      } catch {
        return false;
      }
    });
  }
}
