import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allDistinct, cardName, cardToString, orderedDeck, parseCard, parseCards } from '../src/engine/cards.ts';
import { Deck } from '../src/engine/deck.ts';
import { CryptoRng, SeededRng, randomInt, shuffle } from '../src/engine/rng.ts';

test('deck construction: 52 distinct cards, every rank/suit once', () => {
  const d = orderedDeck();
  assert.equal(d.length, 52);
  assert.ok(allDistinct(d));
  const strings = new Set(d.map(cardToString));
  assert.equal(strings.size, 52);
  for (const r of '23456789TJQKA') for (const s of 'cdhs') assert.ok(strings.has(r + s));
});

test('card parsing and naming round-trip', () => {
  for (const c of orderedDeck()) assert.equal(parseCard(cardToString(c)), c);
  assert.deepEqual(parseCards('As Kd').map(cardToString), ['As', 'Kd']);
  assert.deepEqual(parseCards('AsKd,2c').map(cardToString), ['As', 'Kd', '2c']);
  assert.equal(cardName(parseCard('Qh')), 'Queen of hearts');
  assert.throws(() => parseCard('1x'));
  assert.throws(() => parseCards('AsK'));
});

test('duplicate detection', () => {
  assert.ok(allDistinct([0, 1, 51]));
  assert.ok(!allDistinct([3, 3]));
  assert.ok(!allDistinct([52]));
  assert.ok(!allDistinct([-1]));
  assert.throws(() => new Deck([...orderedDeck().slice(0, 51), 0]), /permutation/);
  assert.throws(() => new Deck(orderedDeck().slice(0, 51)), /permutation/);
});

test('dealing and burning consume the deck in order and never repeat a card', () => {
  const deck = Deck.shuffled(new SeededRng('deal-test'));
  const seen: number[] = [];
  for (let i = 0; i < 20; i++) seen.push(i % 5 === 0 ? deck.burn() : deck.deal());
  assert.equal(deck.remaining, 32);
  assert.ok(allDistinct(seen));
  assert.deepEqual(deck.dealtCards(), seen);
  assert.deepEqual(deck.burnedCards(), [seen[0], seen[5], seen[10], seen[15]]);
  while (deck.remaining) deck.deal();
  assert.throws(() => deck.deal(), /exhausted/);
});

test('deck snapshot/restore preserves order, position and burns', () => {
  const deck = Deck.shuffled(new SeededRng('snap'));
  deck.deal();
  deck.burn();
  const copy = Deck.restore(deck.snapshot());
  assert.equal(copy.deal(), deck.deal());
  assert.deepEqual(copy.burnedCards(), deck.burnedCards());
});

test('seeded shuffles are reproducible and different seeds differ', () => {
  const a = Deck.shuffled(new SeededRng('seed-1')).snapshot().order;
  const b = Deck.shuffled(new SeededRng('seed-1')).snapshot().order;
  const c = Deck.shuffled(new SeededRng('seed-2')).snapshot().order;
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('RNG state can be saved and resumed exactly', () => {
  const rng = new SeededRng('resume');
  for (let i = 0; i < 10; i++) rng.nextUint32();
  const resumed = SeededRng.fromState(rng.state());
  for (let i = 0; i < 100; i++) assert.equal(resumed.nextUint32(), rng.nextUint32());
});

test('shuffle is unbiased: each card lands in each position about equally often', () => {
  const rng = new SeededRng('uniformity');
  const trials = 52 * 400;
  const counts = Array.from({ length: 52 }, () => new Array(52).fill(0));
  for (let t = 0; t < trials; t++) {
    const d = shuffle(orderedDeck(), rng);
    d.forEach((card, pos) => counts[card][pos]++);
  }
  // Chi-square over the card-0 row and the position-0 column (51 degrees of freedom each).
  const expected = trials / 52;
  const chi = (values: number[]) => values.reduce((s, v) => s + (v - expected) ** 2 / expected, 0);
  assert.ok(chi(counts[0]) < 90, `card 0 distribution chi² ${chi(counts[0])}`);
  assert.ok(chi(counts.map((row) => row[0])) < 90, 'position 0 distribution');
});

test('randomInt covers the range without bias at awkward bounds', () => {
  const rng = new SeededRng('ints');
  const n = 7;
  const hist = new Array(n).fill(0);
  for (let i = 0; i < 70000; i++) hist[randomInt(rng, n)]++;
  for (const h of hist) assert.ok(Math.abs(h - 10000) < 450, `bucket ${h}`);
  assert.throws(() => randomInt(rng, 0));
});

test('crypto RNG produces varied output', () => {
  const rng = new CryptoRng();
  const values = new Set(Array.from({ length: 1000 }, () => rng.nextUint32()));
  assert.ok(values.size > 990);
  const d1 = Deck.shuffled(rng).snapshot().order;
  const d2 = Deck.shuffled(rng).snapshot().order;
  assert.notDeepEqual(d1, d2);
});
