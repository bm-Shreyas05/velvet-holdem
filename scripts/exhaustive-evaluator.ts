/**
 * Evaluates every one of the 133,784,560 seven-card hands and checks the category counts and the
 * number of distinct hand values against the published figures.
 *   node scripts/exhaustive-evaluator.ts
 */
import { evaluate } from '../src/engine/evaluator.ts';

const EXPECTED = [23294460, 58627800, 31433400, 6461620, 6180020, 4047644, 3473184, 224848, 41584];
const NAMES = ['High card', 'One pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

const counts = new Array(9).fill(0);
const seen = new Uint8Array(1 << 24);
let royals = 0;
const cards = new Int32Array(7);
const t0 = performance.now();
for (let a = 0; a < 52; a++) {
  cards[0] = a;
  for (let b = a + 1; b < 52; b++) {
    cards[1] = b;
    for (let c = b + 1; c < 52; c++) {
      cards[2] = c;
      for (let d = c + 1; d < 52; d++) {
        cards[3] = d;
        for (let e = d + 1; e < 52; e++) {
          cards[4] = e;
          for (let f = e + 1; f < 52; f++) {
            cards[5] = f;
            for (let g = f + 1; g < 52; g++) {
              cards[6] = g;
              const s = evaluate(cards, 7);
              counts[s >> 20]++;
              seen[s] = 1;
              if (s === ((8 << 20) | (12 << 16))) royals++;
            }
          }
        }
      }
    }
  }
}
const secs = (performance.now() - t0) / 1000;
let distinct = 0;
for (let i = 0; i < seen.length; i++) distinct += seen[i]!;
const total = counts.reduce((x, y) => x + y, 0);
let ok = true;
counts.forEach((n, i) => {
  const good = n === EXPECTED[i];
  ok &&= good;
  console.log(`${good ? '✔' : '✖'} ${NAMES[i]!.padEnd(16)} ${n.toLocaleString().padStart(12)} (expected ${EXPECTED[i]!.toLocaleString()})`);
});
const checks: [boolean, string][] = [
  [total === 133784560, `total hands ${total.toLocaleString()}`],
  [royals === 4324, `royal flushes ${royals.toLocaleString()} (expected 4,324)`],
  [distinct === 4824, `distinct hand values ${distinct.toLocaleString()} (expected 4,824)`],
];
for (const [good, text] of checks) {
  ok &&= good;
  console.log(`${good ? '✔' : '✖'} ${text}`);
}
console.log(`${(total / secs / 1e6).toFixed(1)} million hands per second (${secs.toFixed(1)} s)`);
if (!ok) process.exit(1);
