/**
 * AI evaluation through repeated simulated play.
 *
 *   node scripts/evaluate-ai.ts            full evaluation (several minutes)
 *   node scripts/evaluate-ai.ts --quick    short version
 *
 * Sessions are "cash-style": every hand starts at 100 big blinds so results measure decision
 * quality rather than bust-outs. Win rates are reported in big blinds per 100 hands (bb/100)
 * with a 95% confidence interval. The AIs keep public statistics across a session, exactly as in
 * a real game, so their reads develop as hands go by.
 *
 * Experiments
 *   A. Exploitation: an Elite Shark against fixed, exploitable styles.
 *   B. Difficulty ladder: heads-up matches between difficulty levels.
 *   C. Style fingerprints: the five personalities at one table (VPIP, PFR, aggression, WTSD).
 *   D. Adaptation: how often the AI bluffs a habitual folder vs a calling station, early and late.
 */
import { Deck } from '../src/engine/deck.ts';
import { HoldemHand } from '../src/engine/hand.ts';
import { publicRecordFromView } from '../src/engine/records.ts';
import { SeededRng } from '../src/engine/rng.ts';
import { comboIndex } from '../src/ai/combos.ts';
import { decide } from '../src/ai/decide.ts';
import { sanitizeDecision } from '../src/ai/host.ts';
import { type StatsBook, aggressionFactor, estimate } from '../src/ai/model.ts';
import { type Difficulty, STYLES, type StyleId } from '../src/ai/profiles.ts';
import { boardStrength } from '../src/ai/strength.ts';
import { observeHand } from '../src/ai/model.ts';
import { type ScriptedStyle, scriptedAction } from '../src/sim/bots.ts';

const quick = process.argv.includes('--quick');
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg >= 0 ? process.argv[onlyArg + 1]!.toUpperCase() : null;
const run = (id: string) => !only || only.includes(id);
const N = (full: number) => (quick ? Math.round(full / 5) : full);
const BB = 50;
const STACK = 100 * BB;

type SeatSpec = { label: string; kind: 'ai'; style: StyleId; difficulty: Difficulty } | { label: string; kind: 'bot'; style: ScriptedStyle };

interface SeatResult {
  label: string;
  nets: number[];
}

function strengthOf(hand: HoldemHand, seat: number): number {
  const view = hand.viewFor(seat);
  const cards = view.seats[seat]!.holeCards!;
  return boardStrength(view.board)[comboIndex(cards[0]!, cards[1]!)]!;
}

function runSession(seed: string, seats: SeatSpec[], hands: number, onHand?: (h: number, nets: number[]) => void): { results: SeatResult[]; book: StatsBook; ids: string[] } {
  const rng = new SeededRng(seed);
  const book: StatsBook = {};
  const ids = seats.map((_, i) => `s${i}`);
  const results: SeatResult[] = seats.map((s) => ({ label: s.label, nets: [] }));
  for (let h = 0; h < hands; h++) {
    const setup = { handNumber: h + 1, seats: ids.map((id) => ({ id, stack: STACK })), button: h % seats.length, blinds: { smallBlind: BB / 2, bigBlind: BB, ante: 0 } };
    const { hand } = HoldemHand.start(setup, Deck.shuffled(rng));
    let guard = 0;
    while (!hand.isComplete && guard++ < 300) {
      const seat = hand.toAct!;
      const spec = seats[seat]!;
      const legal = hand.legalActions()!;
      if (spec.kind === 'ai') {
        const d = decide({
          view: hand.viewFor(seat),
          style: spec.style,
          difficulty: spec.difficulty,
          stats: book,
          tilt: 0,
          seed: [rng.nextUint32(), rng.nextUint32(), rng.nextUint32(), (rng.nextUint32() | 1) >>> 0],
        });
        hand.act(seat, sanitizeDecision(d.action, legal));
      } else {
        hand.act(seat, scriptedAction(spec.style, legal, rng, strengthOf(hand, seat)));
      }
    }
    const r = hand.result!;
    const nets = r.netChange;
    nets.forEach((n, i) => results[i]!.nets.push(n));
    observeHand(book, publicRecordFromView(hand.viewFor(null)));
    onHand?.(h, nets);
  }
  return { results, book, ids };
}

function bb100(nets: number[]): { mean: number; ci: number } {
  const perHand = nets.map((n) => n / BB);
  const mean = perHand.reduce((a, b) => a + b, 0) / perHand.length;
  const variance = perHand.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, perHand.length - 1);
  const se = Math.sqrt(variance / perHand.length);
  return { mean: mean * 100, ci: 1.96 * se * 100 };
}

function fmt(r: { mean: number; ci: number }): string {
  const sign = r.mean >= 0 ? '+' : '';
  return `${sign}${r.mean.toFixed(1)} ± ${r.ci.toFixed(1)} bb/100`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

const t0 = performance.now();
let checks = 0;
let passed = 0;
function expect(ok: boolean, text: string): void {
  checks++;
  if (ok) passed++;
  console.log(`   ${ok ? '✔' : '✖'} ${text}`);
}

// ---------------------------------------------------------------------------------------------
if (run('A')) {
  const hands = N(2500);
  console.log(`\nA. Exploitation — Elite Shark vs fixed styles, 4-handed, ${hands} hands`);
  const { results } = runSession('eval-A', [
    { label: 'Elite Shark', kind: 'ai', style: 'shark', difficulty: 'elite' },
    { label: 'Calling station bot', kind: 'bot', style: 'station' },
    { label: 'Maniac bot', kind: 'bot', style: 'maniac' },
    { label: 'Random bot', kind: 'bot', style: 'random' },
  ], hands);
  for (const r of results) console.log(`   ${r.label.padEnd(22)} ${fmt(bb100(r.nets))}`);
  const shark = bb100(results[0]!.nets);
  expect(shark.mean - shark.ci > 0, 'the Shark wins significantly against exploitable players');
}

// ---------------------------------------------------------------------------------------------
if (run('B')) {
  const hands = N(2000);
  console.log(`\nB. Difficulty ladder — heads-up, ${hands} hands per match (same style, Shark)`);
  const pairs: [Difficulty, Difficulty][] = [
    ['elite', 'casual'],
    ['pro', 'standard'],
    ['standard', 'casual'],
  ];
  for (const [hi, lo] of pairs) {
    const { results } = runSession(`eval-B-${hi}-${lo}`, [
      { label: hi, kind: 'ai', style: 'shark', difficulty: hi },
      { label: lo, kind: 'ai', style: 'shark', difficulty: lo },
    ], hands);
    const r = bb100(results[0]!.nets);
    console.log(`   ${hi.padEnd(8)} vs ${lo.padEnd(8)} ${fmt(r)} for ${hi}`);
    expect(r.mean > 0, `${hi} beats ${lo}`);
  }
}

// ---------------------------------------------------------------------------------------------
if (run('C')) {
  const hands = N(2000);
  console.log(`\nC. Style fingerprints — five personalities at one table (Pro), ${hands} hands`);
  const styles: StyleId[] = ['rock', 'shark', 'trapper', 'maniac', 'station'];
  const { results, book, ids } = runSession('eval-C', styles.map((s) => ({ label: STYLES[s].label, kind: 'ai' as const, style: s, difficulty: 'pro' as Difficulty })), hands);
  const opts = { tableSize: 5, recencyWeight: 0 };
  const rows = styles.map((s, i) => {
    const st = book[ids[i]!];
    return {
      label: STYLES[s].label,
      vpip: estimate(st, 'vpip', opts),
      pfr: estimate(st, 'pfr', opts),
      af: aggressionFactor(st) ?? 0,
      wtsd: estimate(st, 'wtsd', opts),
      foldToBet: estimate(st, 'foldToBet', opts),
      result: bb100(results[i]!.nets),
    };
  });
  console.log('   style          VPIP   PFR    AF    WTSD  fold-to-bet  result');
  for (const r of rows) {
    console.log(`   ${r.label.padEnd(14)} ${pct(r.vpip).padStart(4)}  ${pct(r.pfr).padStart(4)}  ${r.af.toFixed(2).padStart(5)}  ${pct(r.wtsd).padStart(4)}   ${pct(r.foldToBet).padStart(4)}      ${fmt(r.result)}`);
  }
  const by = Object.fromEntries(rows.map((r, i) => [styles[i]!, r]));
  expect(by.rock!.vpip < by.shark!.vpip && by.shark!.vpip < by.maniac!.vpip, 'Rock plays the fewest hands, Maniac the most');
  expect(by.maniac!.af > by.station!.af * 1.5, 'Maniac is far more aggressive than the Station');
  expect(by.station!.foldToBet < by.rock!.foldToBet, 'the Station folds to bets less than the Rock');
  expect(by.station!.wtsd > by.rock!.wtsd, 'the Station goes to showdown more than the Rock');
}

// ---------------------------------------------------------------------------------------------
if (run('D')) {
  const hands = N(2500);
  console.log(`\nD. Adaptation — a Pro Shark's bluffing, heads-up, ${hands} hands against each opponent`);
  // A "bluff" = the Shark bets or raises after the flop holding a weak hand (bottom 35% on that street).
  const bluffRates = (bot: ScriptedStyle) => {
    const counts = { early: [0, 0], late: [0, 0] };
    const rng = new SeededRng(`eval-D-${bot}`);
    const book: StatsBook = {};
    for (let h = 0; h < hands; h++) {
      const setup = { handNumber: h + 1, seats: [{ id: 'shark', stack: STACK }, { id: 'bot', stack: STACK }], button: h % 2, blinds: { smallBlind: BB / 2, bigBlind: BB, ante: 0 } };
      const { hand } = HoldemHand.start(setup, Deck.shuffled(rng));
      // "Early" = the first 100 hands, before any read can be trusted; "late" = the second half.
      const phase = h < 100 ? counts.early : h >= hands * 0.5 ? counts.late : null;
      let guard = 0;
      while (!hand.isComplete && guard++ < 300) {
        const seat = hand.toAct!;
        const legal = hand.legalActions()!;
        if (seat === 0) {
          const view = hand.viewFor(0);
          const d = decide({ view, style: 'shark', difficulty: 'pro', stats: book, tilt: 0, seed: [rng.nextUint32(), rng.nextUint32(), rng.nextUint32(), 1] });
          const action = sanitizeDecision(d.action, legal);
          if (phase && view.street !== 'preflop' && legal.aggression && strengthOf(hand, 0) < 0.35) {
            phase[1]!++;
            if (action.kind === 'bet' || action.kind === 'raise') phase[0]!++;
          }
          hand.act(0, action);
        } else hand.act(1, scriptedAction(bot, legal, rng, strengthOf(hand, 1)));
      }
      observeHand(book, publicRecordFromView(hand.viewFor(null)));
    }
    return { early: counts.early[0]! / Math.max(1, counts.early[1]!), late: counts.late[0]! / Math.max(1, counts.late[1]!) };
  };
  const folder = bluffRates('folder');
  const station = bluffRates('station');
  console.log(`   vs a habitual folder:  bluffs with ${pct(folder.early)} of weak hands early → ${pct(folder.late)} later`);
  console.log(`   vs a calling station:  bluffs with ${pct(station.early)} of weak hands early → ${pct(station.late)} later`);
  expect(folder.late > folder.early, 'bluffs more against the folder once it has seen enough hands');
  // Against a calling station the read forms within a few dozen hands, so "early" is already low;
  // the meaningful check is that bluffing stays rare once the read exists.
  expect(station.late <= 0.1, 'rarely bluffs a calling station once it has a read (≤10% of weak hands)');
  expect(folder.late > station.late * 1.5, 'ends up bluffing the folder far more than the station');
}

console.log(`\n${passed}/${checks} checks passed in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
if (passed !== checks) process.exitCode = 1;
