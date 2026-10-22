import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { muLawDecode, muLawEncode, packSoundBank, parseSoundBank } from '../src/audio/samples.ts';

test('µ-law: silence is exact, and quiet and loud samples survive within a few percent', () => {
  assert.equal(muLawDecode(muLawEncode(0)), 0);
  for (const x of [-1, -0.5, -0.05, -0.003, 0.003, 0.05, 0.25, 0.9, 1]) {
    const y = muLawDecode(muLawEncode(x));
    assert.ok(Math.abs(y - x) <= Math.max(0.0005, Math.abs(x) * 0.04), `${x} -> ${y}`);
  }
  assert.equal(muLawDecode(muLawEncode(3)), 1, 'clipped to full scale');
});

test('sound bank: packs and parses back, and rejects anything else', () => {
  const tone = Float32Array.from({ length: 400 }, (_, i) => Math.sin(i / 7) * 0.6);
  const bank = parseSoundBank(packSoundBank(32000, { a: [tone, tone.slice(0, 100)], b: [tone.slice(50)] }).buffer as ArrayBuffer);
  assert.ok(bank);
  assert.equal(bank.rate, 32000);
  assert.deepEqual(
    Object.entries(bank.clips).map(([k, v]) => [k, v.map((c) => c.length)]),
    [
      ['a', [400, 100]],
      ['b', [350]],
    ],
  );
  assert.ok(Math.abs(bank.clips.b![0]![10]! - tone[60]!) < 0.03);
  assert.equal(parseSoundBank(new TextEncoder().encode('<!doctype html><title>404</title>').buffer as ArrayBuffer), null, 'an error page is not a bank');
  const truncated = packSoundBank(32000, { a: [tone] }).slice(0, 200);
  assert.equal(parseSoundBank(truncated.buffer as ArrayBuffer), null, 'a truncated download is rejected');
});

test('the shipped recordings cover every sound the engine asks for', () => {
  const bytes = readFileSync(new URL('../public/sounds.bin', import.meta.url));
  const bank = parseSoundBank(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  assert.ok(bank, 'public/sounds.bin parses');
  const engine = readFileSync(new URL('../src/audio/audio.ts', import.meta.url), 'utf8');
  const asked = new Set([...engine.matchAll(/#sample\(bus, '(\w+)'/g), ...engine.matchAll(/'(\w+)' : '(\w+)'/g)].flatMap((m) => m.slice(1)));
  for (const name of asked) assert.ok(bank.clips[name]?.length, `recording "${name}" is in the bank`);
  for (const [name, takes] of Object.entries(bank.clips)) {
    for (const clip of takes) {
      assert.ok(clip.length / bank.rate <= 1.05, `${name} is short`);
      const peak = clip.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      assert.ok(peak > 0.8 && peak <= 1, `${name} is normalised (${peak.toFixed(2)})`);
      assert.ok(Math.abs(clip[clip.length - 1]!) < 0.01, `${name} fades out to silence`);
    }
  }
});
