/**
 * Stress simulation. Plays very large numbers of hands without human input and fails loudly on
 * any broken invariant.
 *
 *   node scripts/simulate.ts            full run (≈200k engine hands, 400 freeze-outs, 12 AI games)
 *   node scripts/simulate.ts --quick    smoke run for CI (a few seconds)
 *   node scripts/simulate.ts --hands 500000 --games 1000 --ai-games 30 --seed my-seed
 *
 * 1. Engine fuzz: random tables (2–9 seats), random stacks, blinds and antes, random legal play
 *    biased toward all-ins. After every action: every hand invariant (chip conservation, unique
 *    cards, legal turn order…). After every hand: the hand is replayed from its recorded deck
 *    and decisions and must reproduce the exact result.
 * 2. Freeze-outs: whole games through TableGame until one player holds every chip.
 * 3. Real games: the full game controller with the real AI and a scripted human.
 */
import { Deck } from '../src/engine/deck.ts';
import { TableGame, buildBlindSchedule } from '../src/engine/game.ts';
import { HoldemHand } from '../src/engine/hand.ts';
import { decisionsFromLog } from '../src/engine/records.ts';
import { replayHand } from '../src/engine/replay.ts';
import { SeededRng, randomInt } from '../src/engine/rng.ts';
import { InlineAiHost } from '../src/ai/host.ts';
import { defaultSetup } from '../src/game/config.ts';
import { GameController } from '../src/game/controller.ts';
import { createSession } from '../src/game/session.ts';
import { randomLegalAction, scriptedAction } from '../src/sim/bots.ts';
import { HeadlessPresenter } from '../src/sim/headless.ts';
import { DIFFICULTY_ORDER, STYLE_ORDER } from '../src/ai/profiles.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const quick = flag('quick');
const seed = (() => {
  const i = args.indexOf('--seed');
  return i >= 0 ? args[i + 1]! : 'velvet-stress';
})();
const HANDS = opt('hands', quick ? 20000 : 200000);
const GAMES = opt('games', quick ? 40 : 400);
const AI_GAMES = opt('ai-games', quick ? 2 : 12);

const failures: string[] = [];
function fail(message: string): void {
  failures.push(message);
  if (failures.length <= 10) console.error(`  ✖ ${message}`);
}

function heapMb(): number {
  return process.memoryUsage().heapUsed / 1048576;
}

// ---------------------------------------------------------------------------------------------
console.log(`Velvet stress simulation (seed "${seed}")`);
console.log(`\n1) Engine fuzz: ${HANDS.toLocaleString()} hands`);
{
  const rng = new SeededRng(`${seed}/fuzz`);
  const t0 = performance.now();
  let actions = 0;
  let showdowns = 0;
  let sidePotHands = 0;
  let maxPots = 0;
  let splits = 0;
  let allInRunouts = 0;
  let uncalled = 0;
  const heapStart = heapMb();
  for (let i = 0; i < HANDS; i++) {
    const n = 2 + randomInt(rng, 8);
    const big = [2, 10, 20, 50, 100][randomInt(rng, 5)]!;
    const blinds = { smallBlind: Math.max(1, Math.floor(big / 2)), bigBlind: big, ante: randomInt(rng, 4) === 0 ? Math.max(1, Math.floor(big / 10)) : 0 };
    const seats = Array.from({ length: n }, (_, s) => {
      const empty = n > 3 && randomInt(rng, 9) === 0;
      return empty ? null : { id: `p${s}`, stack: 1 + randomInt(rng, big * (randomInt(rng, 3) === 0 ? 8 : 60)) };
    });
    const live = seats.map((s, k) => (s && s.stack > 0 ? k : -1)).filter((k) => k >= 0);
    if (live.length < 2) continue;
    const setup = { handNumber: i + 1, seats, button: live[randomInt(rng, live.length)]!, blinds };
    const deck = Deck.shuffled(rng);
    const order = deck.snapshot().order;
    let hand: HoldemHand;
    try {
      hand = HoldemHand.start(structuredClone(setup), deck).hand;
    } catch (e) {
      fail(`hand ${i + 1}: could not start (${e instanceof Error ? e.message : e})`);
      continue;
    }
    let guard = 0;
    while (!hand.isComplete) {
      if (++guard > 400) {
        fail(`hand ${i + 1}: did not terminate`);
        break;
      }
      const legal = hand.legalActions();
      if (!legal) {
        fail(`hand ${i + 1}: in progress but no legal actions`);
        break;
      }
      try {
        hand.act(hand.toAct!, randomLegalAction(legal, rng));
      } catch (e) {
        fail(`hand ${i + 1}: a legal action was rejected (${e instanceof Error ? e.message : e})`);
        break;
      }
      actions++;
      const problems = hand.checkInvariants();
      if (problems.length) {
        fail(`hand ${i + 1}: ${problems.join('; ')}`);
        break;
      }
    }
    const result = hand.result;
    if (!result) continue;
    if (result.showdown) showdowns++;
    if (result.pots.length > 1) sidePotHands++;
    maxPots = Math.max(maxPots, result.pots.length);
    if (result.pots.some((p) => p.winners.length > 1)) splits++;
    if (result.uncalled.length) uncalled++;
    const view = hand.viewFor(null);
    if (view.actions.some((a) => a.allIn) && result.showdown && view.revealed.length > 1) allInRunouts++;
    const start = seats.reduce((s, x) => s + (x?.stack ?? 0), 0);
    if (result.finalStacks.reduce((a, b) => a + b, 0) !== start) fail(`hand ${i + 1}: chips not conserved`);
    // Determinism: replay from the recorded deck order and decisions.
    try {
      const replay = replayHand({ setup, deckOrder: order, decisions: decisionsFromLog(view.actions) });
      if (JSON.stringify(replay.result) !== JSON.stringify(result)) fail(`hand ${i + 1}: replay produced a different result`);
    } catch (e) {
      fail(`hand ${i + 1}: replay failed (${e instanceof Error ? e.message : e})`);
    }
  }
  const secs = (performance.now() - t0) / 1000;
  console.log(
    `   ${HANDS.toLocaleString()} hands, ${actions.toLocaleString()} actions in ${secs.toFixed(1)} s (${Math.round(HANDS / secs).toLocaleString()} hands/s incl. replay)`,
  );
  console.log(`   showdowns ${showdowns.toLocaleString()} · hands with side pots ${sidePotHands.toLocaleString()} (up to ${maxPots} pots) · split pots ${splits.toLocaleString()}`);
  console.log(`   all-in run-outs ${allInRunouts.toLocaleString()} · uncalled bets returned ${uncalled.toLocaleString()} · heap ${heapStart.toFixed(0)} → ${heapMb().toFixed(0)} MB`);
}

// ---------------------------------------------------------------------------------------------
console.log(`\n2) Freeze-outs: ${GAMES} complete games`);
{
  const rng = new SeededRng(`${seed}/games`);
  const t0 = performance.now();
  let hands = 0;
  let longest = 0;
  const styles = ['random', 'station', 'maniac', 'nit', 'folder'] as const;
  for (let g = 0; g < GAMES; g++) {
    const n = 2 + randomInt(rng, 5);
    const stack = [300, 1000, 1500][randomInt(rng, 3)]!;
    const game = TableGame.create(
      { startingStack: stack, levels: buildBlindSchedule(25, 50), handsPerLevel: [5, 10, null][randomInt(rng, 3)] ?? null },
      Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` })),
      randomInt(rng, n),
    );
    const seatStyle = Array.from({ length: n }, () => styles[randomInt(rng, styles.length)]!);
    let guard = 0;
    let prevButton = -1;
    while (!game.isOver) {
      if (++guard > 5000) {
        fail(`game ${g}: no winner after 5000 hands`);
        break;
      }
      game.startHand(Deck.shuffled(rng));
      const button = game.button;
      if (prevButton >= 0 && button === prevButton && game.alivePlayers().length > 1) fail(`game ${g}: button did not move`);
      prevButton = button;
      const hand = game.hand!;
      let steps = 0;
      while (!hand.isComplete && steps++ < 400) {
        const seat = hand.toAct!;
        game.act(seat, scriptedAction(seatStyle[seat]!, hand.legalActions()!, rng, (rng.nextUint32() % 1000) / 1000));
      }
      const problems = game.checkInvariants();
      if (problems.length) fail(`game ${g} hand ${game.handNumber}: ${problems.join('; ')}`);
      game.settleHand();
      hands++;
    }
    longest = Math.max(longest, game.handNumber);
    const players = game.players();
    const winner = game.winner();
    if (!winner || winner.stack !== stack * n) fail(`game ${g}: winner does not hold every chip`);
    const places = players.map((p) => p.place);
    if (places.some((p) => p === null) || !places.includes(1)) fail(`game ${g}: finishing places incomplete`);
  }
  const secs = (performance.now() - t0) / 1000;
  console.log(`   ${GAMES} games, ${hands.toLocaleString()} hands in ${secs.toFixed(1)} s · longest game ${longest} hands`);
}

// ---------------------------------------------------------------------------------------------
console.log(`\n3) Full games with the real AI: ${AI_GAMES}`);
{
  const rng = new SeededRng(`${seed}/ai`);
  const t0 = performance.now();
  let hands = 0;
  let decisions = 0;
  let slowest = 0;
  const heapStart = heapMb();
  for (let g = 0; g < AI_GAMES; g++) {
    const setup = defaultSetup();
    setup.difficulty = DIFFICULTY_ORDER[g % DIFFICULTY_ORDER.length]!;
    setup.opponents = Array.from({ length: 1 + (g % 5) }, (_, i) => ({ name: `AI ${i + 1}`, style: STYLE_ORDER[(g + i) % STYLE_ORDER.length]! }));
    setup.startingStack = 1000;
    setup.structure = 'turbo';
    setup.seed = `${seed}/ai-game-${g}`;
    const session = createSession(setup);
    const presenter = new HeadlessPresenter((legal) => randomLegalAction(legal, rng));
    presenter.eliminationChoice = 'skip';
    const host = new InlineAiHost();
    const timed = {
      mode: 'inline' as const,
      async decide(req: Parameters<InlineAiHost['decide']>[0]) {
        const s = performance.now();
        const d = await host.decide(req);
        slowest = Math.max(slowest, performance.now() - s);
        decisions++;
        return d;
      },
      dispose() {},
    };
    let gameHands = 0;
    const logs: string[] = [];
    await new GameController(session, presenter, timed, {
      handRecorded: () => gameHands++,
      log: (m) => logs.push(m),
    }).run();
    hands += gameHands;
    if (!presenter.gameOverInfo) fail(`AI game ${g}: did not finish`);
    if (presenter.violations.length) fail(`AI game ${g}: hidden information shown to the player: ${presenter.violations[0]}`);
    if (presenter.notices.some((n) => n.tone === 'error')) fail(`AI game ${g}: ${presenter.notices.find((n) => n.tone === 'error')!.message}`);
    if (logs.length) fail(`AI game ${g}: ${logs[0]}`);
  }
  const secs = (performance.now() - t0) / 1000;
  console.log(
    `   ${AI_GAMES} games, ${hands.toLocaleString()} hands, ${decisions.toLocaleString()} AI decisions in ${secs.toFixed(1)} s · slowest decision ${slowest.toFixed(0)} ms · heap ${heapStart.toFixed(0)} → ${heapMb().toFixed(0)} MB`,
  );
}

console.log('');
if (failures.length) {
  console.error(`FAILED: ${failures.length} problem(s) found.`);
  process.exit(1);
} else {
  console.log('All invariants held. No failures.');
}
