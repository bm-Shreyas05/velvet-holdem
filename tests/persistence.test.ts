import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, SlotStore, checksum } from '../src/game/persistence.ts';

interface Doc {
  name: string;
  count: number;
}
const validate = (p: unknown) => {
  const d = p as Doc;
  return d && typeof d.name === 'string' && Number.isInteger(d.count) ? null : 'bad document';
};
const slots = (store: MemoryStore, version = 2, migrations = {}) => new SlotStore<Doc>(store, 'doc', { kind: 'doc', version, validate, migrations });

test('save then load round-trips', () => {
  const store = new MemoryStore();
  const s = slots(store);
  assert.deepEqual(s.load(), { status: 'missing' });
  assert.deepEqual(s.save({ name: 'a', count: 1 }), { ok: true });
  assert.deepEqual(s.save({ name: 'b', count: 2 }), { ok: true });
  const r = s.load();
  assert.equal(r.status, 'ok');
  if (r.status === 'ok') {
    assert.deepEqual(r.payload, { name: 'b', count: 2 });
    assert.equal(r.recovered, false);
  }
});

test('a damaged newest save falls back to the previous good one', () => {
  const store = new MemoryStore();
  const s = slots(store);
  s.save({ name: 'good', count: 1 });
  s.save({ name: 'newer', count: 2 });
  // Corrupt whichever slot holds the newest save.
  for (const key of ['doc:a', 'doc:b']) {
    const env = JSON.parse(store.getItem(key)!);
    if (JSON.parse(env.payload).name === 'newer') store.setItem(key, store.getItem(key)!.slice(0, 40));
  }
  const r = s.load();
  assert.equal(r.status, 'ok');
  if (r.status === 'ok') {
    assert.equal(r.payload.name, 'good');
    assert.equal(r.recovered, true);
  }
});

test('an edited payload is detected by its checksum', () => {
  const store = new MemoryStore();
  const s = slots(store);
  s.save({ name: 'x', count: 1 });
  const env = JSON.parse(store.getItem('doc:a')!);
  env.payload = env.payload.replace('1', '9');
  store.setItem('doc:a', JSON.stringify(env));
  const r = s.load();
  assert.equal(r.status, 'corrupt');
  if (r.status === 'corrupt') assert.match(r.reason, /checksum/);
});

test('garbage and foreign data are reported as corrupt, never thrown', () => {
  const store = new MemoryStore();
  store.setItem('doc:a', '{not json');
  store.setItem('doc:b', JSON.stringify({ hello: 'world' }));
  const r = slots(store).load();
  assert.equal(r.status, 'corrupt');
});

test('a save from a newer version is refused, not misread', () => {
  const store = new MemoryStore();
  slots(store, 5).save({ name: 'future', count: 1 });
  const r = slots(store, 2).load();
  assert.equal(r.status, 'incompatible');
});

test('older saves are migrated step by step', () => {
  const store = new MemoryStore();
  new SlotStore<{ title: string }>(store, 'doc', { kind: 'doc', version: 1, validate: () => null }).save({ title: 'old' });
  const r = slots(store, 2, { 1: (p: unknown) => ({ name: (p as { title: string }).title, count: 0 }) }).load();
  assert.equal(r.status, 'ok');
  if (r.status === 'ok') assert.deepEqual(r.payload, { name: 'old', count: 0 });
  const noPath = slots(store, 3, {}).load();
  assert.equal(noPath.status, 'corrupt');
});

test('a failed write keeps the previous save intact', () => {
  const store = new MemoryStore();
  const s = slots(store);
  s.save({ name: 'safe', count: 1 });
  store.failWrites = true;
  const result = s.save({ name: 'lost', count: 2 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /full/);
  store.failWrites = false;
  const r = s.load();
  assert.equal(r.status, 'ok');
  if (r.status === 'ok') assert.equal(r.payload.name, 'safe');
});

test('writes alternate slots so the last good save is never overwritten in place', () => {
  const store = new MemoryStore();
  const s = slots(store);
  for (let i = 0; i < 5; i++) {
    const before = new Map(store.data);
    s.save({ name: `v${i}`, count: i });
    const changed = [...store.data.keys()].filter((k) => before.get(k) !== store.data.get(k));
    assert.equal(changed.length, 1);
    if (i > 0) {
      const kept = [...store.data.keys()].find((k) => !changed.includes(k))!;
      assert.equal(JSON.parse(JSON.parse(store.data.get(kept)!).payload).name, `v${i - 1}`);
    }
  }
});

test('checksum is stable and sensitive', () => {
  assert.equal(checksum('hello'), checksum('hello'));
  assert.notEqual(checksum('hello'), checksum('hellp'));
});
