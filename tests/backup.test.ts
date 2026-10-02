import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyBackup, exportBackup, readBackup } from '../src/game/backup.ts';
import { defaultSetup } from '../src/game/config.ts';
import { MemoryStore } from '../src/game/persistence.ts';
import { emptyProgress, unlock } from '../src/game/progress.ts';
import { createSession } from '../src/game/session.ts';
import { emptyCareer } from '../src/game/stats.ts';
import { GameStorage } from '../src/game/storage.ts';

function populated(): MemoryStore {
  const store = new MemoryStore();
  const storage = new GameStorage(store);
  const session = createSession({ ...defaultSetup(), seed: 'backup' });
  storage.write(storage.session, session);
  storage.write(storage.history, { gameId: session.gameId, records: [] });
  const career = { ...emptyCareer(), handsPlayed: 1234, gamesPlayed: 9 };
  storage.write(storage.career, career);
  const progress = emptyProgress();
  unlock(progress, ['champion', 'first-hand']);
  storage.write(storage.progress, progress);
  const settings = storage.loadSettings();
  settings.display.felt = 'navy';
  storage.write(storage.settings, settings);
  return store;
}

test('a backup moves every save to another browser intact', () => {
  const text = exportBackup(populated(), new Date('2026-10-02T12:00:00Z'));
  const check = readBackup(text);
  assert.ok(check.ok, check.ok ? '' : check.reason);
  assert.deepEqual(check.summary, ['1,234 hands of statistics', 'a saved game', '2 achievements']);
  const target = new MemoryStore();
  new GameStorage(target).write(new GameStorage(target).career, { ...emptyCareer(), handsPlayed: 5 });
  applyBackup(target, check.entries);
  const restored = new GameStorage(target);
  assert.equal(restored.loadCareer().handsPlayed, 1234, 'imported statistics replace the old ones');
  assert.equal(restored.loadSettings().display.felt, 'navy');
  assert.ok(restored.loadProgress().achievements.champion);
  assert.equal(restored.session.load().status, 'ok');
});

test('damaged, edited, foreign or newer backups are refused before anything is replaced', () => {
  const text = exportBackup(populated());
  const file = JSON.parse(text);

  assert.equal(readBackup('not json').ok, false);
  assert.equal(readBackup(JSON.stringify({ hello: 'world' })).ok, false);
  assert.equal(readBackup(JSON.stringify({ ...file, version: 99 })).ok, false);
  assert.equal(readBackup(JSON.stringify({ ...file, entries: {} })).ok, false);
  assert.equal(readBackup(JSON.stringify({ ...file, entries: { ...file.entries, 'other.key': 'x' } })).ok, false);

  // Edit a statistic inside the career envelope: the checksum no longer matches.
  const tampered = structuredClone(file);
  for (const key of Object.keys(tampered.entries).filter((k: string) => k.startsWith('velvet.career'))) {
    const env = JSON.parse(tampered.entries[key]);
    env.payload = env.payload.replace('1234', '99999');
    tampered.entries[key] = JSON.stringify(env);
  }
  const verdict = readBackup(JSON.stringify(tampered));
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? '' : verdict.reason, /statistics could not be read/);
});
