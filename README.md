# Velvet — No-Limit Texas Hold'em

A single-player poker game against AI opponents who play by the same rules and see the same
information you do. It runs entirely in the browser, offline, from one self-contained HTML file.

- Complete, rules-correct No-Limit Hold'em engine: blinds and antes, heads-up rules, minimum
  raises, incomplete all-in raises, uncalled bets, side pots, split pots and odd chips.
- Five opponent personalities driven by one decision engine that reads ranges, estimates equity
  by simulation, weighs fold equity and pot odds, and learns your habits from what you do.
- Four difficulty levels that change how deeply opponents think, not whether they cheat.
- Animated table, synthesised sound, hand history, statistics, crash-safe saves, keyboard
  play and accessibility options.

## Play

Requirements: Node.js 22.18 or newer (only to build and test).

```bash
npm install
```

```bash
npm start
```

`npm start` builds the game into `dist/index.html`, serves it on http://localhost:5173 and opens
your browser. You can also open `dist/index.html` directly from disk after `npm run build`.

### Controls

| Key | Action |
| --- | --- |
| F / C / R | Fold · check or call · bet or raise the selected amount |
| A | Select all-in |
| ↑ ↓ (Shift for bigger steps) | Adjust the bet amount |
| Space | Skip animations · deal the next hand |
| P or Esc | Pause menu |
| H · T · L · M | Hand history · statistics · table log · mute |

Everything is also reachable by mouse or touch. The slider, the presets (Min, ½ Pot, ¾ Pot, Pot,
All-in) and the amount field all feed one validated amount.

### Game options

Chosen on the New game screen: your name, 1–5 opponents (name and style each), difficulty,
starting chips, blinds, and the blind structure (Turbo every 8 hands, Standard every 12, Deep
every 20, or fixed). The game is a freeze-out: it continues until one player holds every chip.
If you are knocked out you can watch the rest, skip straight to the result, or leave.

Settings (sound levels by category, theme, UI size, felt colour, card backs, four-colour deck,
high contrast, game speed, reduced motion, helper displays, auto-deal, all-in confirmation,
showing or mucking losing hands) apply immediately and are remembered.

## Tests and verification

```bash
npm test                 # 84 unit and integration tests (engine, AI, controller, UI model, saves)
npm run simulate         # stress simulation (200k random hands, 400 freeze-outs, 12 AI games)
npm run evaluate-ai      # AI evaluation by simulated play (about 5 minutes; --quick for 1)
npm run exhaustive       # evaluates all 133,784,560 seven-card hands
npm run typecheck
npm run check            # typecheck + tests + quick simulation + build
```

What the checks cover:

- **Hand evaluation.** Every 5-card hand (2,598,960) matches the known category counts and the
  7,462 distinct hand values; every 7-card hand (133,784,560) matches the published counts and
  4,824 distinct values; 40,000 random 7- and 6-card hands agree with an independent brute-force
  evaluator.
- **Betting and pots.** Hand-built scenarios for every rule above, plus fuzzing: after every
  single action the engine verifies chip conservation, unique cards, card provenance from the
  deck, legal turn order, all-in consistency and board size. Every simulated hand is replayed
  from its recorded deck and decisions and must reproduce the identical result.
- **Stress run** (last full run): 200,000 hands and 2.04 million actions, including 122,481
  hands with side pots (up to 8 pots) and 12,074 split pots, plus 400 complete freeze-outs and
  12 full games with the real AI — no invariant violations; the heap stays under 50 MB
  throughout, and the slowest AI decision took 32 ms.
- **Information boundaries.** Views handed to the AI and the interface never contain unrevealed
  hole cards or deck data; AI modules cannot import engine internals (enforced by a test); an AI
  decision is bit-for-bit identical in two worlds that differ only in cards it cannot see.
- **Interface sync.** The animated table is replayed event by event over whole games and must
  equal the engine's state after every batch.
- **Saves.** Round trip, damaged newest save (falls back to the previous one), edited payload
  (checksum), foreign data, newer versions (refused), older versions (migrated), failed writes.

### AI evaluation (last full run)

Cash-style sessions (every hand at 100 big blinds), 95% confidence intervals:

- Elite Shark vs exploitable fixed styles, 4-handed, 2,500 hands: **+430 ± 206 bb/100**.
- Difficulty ladder, heads-up, 2,000 hands each: Elite beats Casual **+248 ± 112**, Pro beats
  Standard **+96 ± 92**, Standard beats Casual **+63 ± 112** bb/100.
- Style fingerprints at one table (Pro, 2,000 hands): the Rock plays 17% of hands, the Shark 24%,
  the Maniac 51% with the highest aggression; the Station plays 41%, has an aggression factor of
  0.63, folds to bets only 18% of the time and reaches showdown most often.
- Adaptation (heads-up, 2,500 hands): against a player who folds to most bets, a Pro Shark bluffs
  56% of its weak hands in the first 100 hands and 100% once its read is firm; against a calling
  station it bluffs about 5%.

All 11 evaluation checks pass. (The station check is an absolute bound — bluffing stays at or
below 10% — because the read forms within the first few dozen hands, leaving nothing to compare
against later.)

## How it works

```
src/
  engine/   cards, rng, deck, evaluator, pots, hand (one hand's state machine), game (a
            freeze-out: button, blinds, eliminations), records, replay, types
  ai/       combos, preflop-table (generated), strength (board percentiles), ranges (Bayesian
            range reading), model (opponent statistics), profiles, decide, worker, host
  game/     config, session, controller (game loop), history, stats, settings, persistence,
            storage
  ui/       app shell, screens, sheets, table-view, table-model, presenter, action-bar,
            controls-model, dialogs, log-panel, layout, motion, format, dom
  assets/   procedurally drawn cards, chips, avatars, icons (SVG)
  audio/    synthesised sound (Web Audio)
  dev/      developer scenarios
  styles/   main.css
scripts/    build, serve, simulate, evaluate-ai, exhaustive-evaluator, gen-preflop-table, dev/
tests/      node:test suites
```

**Engine.** `HoldemHand` holds the complete state of a hand in private fields and exposes only
`act()`, `legalActions()` and `viewFor(seat)`. A view is a freshly built, deeply frozen object
containing the viewer's own cards, public information and cards that have been shown — nothing
else. Betting is one state machine: each player records the bet level at which they last acted,
which decides whether an incomplete all-in reopens the betting for them. Pots are built purely
from each player's total contribution, so side-pot math does not depend on how the betting went.

**Game loop.** `GameController` is the only holder of engine objects. It deals, asks the human
(through the interface) or an AI (through a Web Worker) for a decision, applies it, checks every
invariant, saves, and passes events filtered for the human to the presenter. If an invariant
ever failed, the hand would be cancelled and the table restored to its start — never silently
continued.

**AI.** Every opponent uses the same engine (`ai/decide.ts`):
1. *Range reading.* Each opponent starts with all 1,326 holdings; each of their actions this
   hand reweights holdings by how likely a player with their observed tendencies would take that
   action with that holding (strength percentiles computed from public cards only).
2. *Simulation.* Monte Carlo over opponent holdings drawn from those ranges and the remaining
   board.
3. *Expected value* of folding, checking or calling (with equity realisation and implied odds
   by stack depth) and of each bet size, including how often each opponent folds (from pot odds,
   what the bet represents, and their observed fold rate once the evidence is solid) and the risk
   of being re-raised.
4. *Choice.* A softmax over the values: close spots are mixed, clear ones are consistent.

Personalities change perception and preference (how much a player believes bets, assumes bluffs,
likes to see flops or to bet), never the rules. Difficulty changes simulation depth, how strongly
ranges are read, how much personal reads are used and how consistently the best option is taken.
Opponent statistics are Beta-binomial estimates with population priors, kept as lifetime and
recent (decayed) counts, so reads build gradually and style changes show up first in the recent
window. Casual opponents ignore reads entirely.

**Interface.** Plain TypeScript and DOM (no framework). The table is a fixed-geometry stage scaled
to the window, with landscape and portrait layouts. `table-model.ts` advances a plain display
model one event at a time so animations play between states, then reconciles with the engine's
snapshot after every batch.

### Design decisions

- **Browser + TypeScript, single file.** Runs anywhere without installation, needs no network,
  and keeps one language across engine, AI, interface and tests. esbuild bundles the game and
  embeds the AI worker as a string started from a Blob URL; if a browser refuses workers the AI
  runs inline in short tasks instead.
- **Tests run the real source.** Node runs the TypeScript directly (type stripping), so tests
  exercise exactly the modules that ship.
- **Fairness by construction.** Normal games shuffle with the operating system's secure random
  generator (every deck order reachable). Seeded randomness exists only for tests, simulations,
  replays and the developer mode, and AI randomness is a separate stream unrelated to the deck.
- **Procedural assets.** Cards, chips, avatars, icons and sounds are generated, so there are no
  binary assets to lose and everything scales cleanly.

## Rules as implemented

- Moving button; heads-up the button posts the small blind and acts first before the flop and
  last after it.
- Callers owe the full big blind even when the big blind is all-in for less.
- Minimum bet is the big blind; a raise must be at least the previous full raise. An all-in for
  less than a full raise does not reopen the betting for players who have already acted unless
  the raises since their action add up to a full raise.
- Folding is not offered when checking is free.
- Uncalled chips are returned before pots are built. When a player is all-in and no more betting
  is possible, all hands are turned face up and the board is run out.
- Showdown: the last aggressor on the river shows first (otherwise the first player left of the
  button); later players may muck a beaten hand. Odd chips go to the winner closest to the
  button's left.
- Players knocked out in the same hand are placed by their stacks at the start of that hand.

## Saved data

Everything is stored in the browser's local storage for the page:
`velvet.session` (the game in progress, saved after every action — including mid-hand, so
closing the page never lets anyone escape a hand), `velvet.history` (up to 300 hands of the
current game), `velvet.career` (lifetime statistics) and `velvet.settings`.

Each is written as a versioned, checksummed envelope into two alternating slots, so an
interrupted write never destroys the previous good save. Damaged or edited saves are detected
and the game falls back to the last good copy or explains what happened; saves from a newer
version are refused rather than misread. To reset, use *Settings → Reset lifetime statistics*,
start a new game, or clear the site's data in the browser.

## Developer mode

Add `#dev` to the URL. The New game screen then offers a seed (reproducible deck and AI choices)
and prepared first hands (a split pot, a multi-way all-in with side pots); such games are marked
*Seeded*. Hand history adds *Copy replay data* (deck order and decisions), which
`replayHand()` in `src/engine/replay.ts` reproduces exactly. `window.__velvet` exposes read-only
snapshots for debugging. None of this is visible in normal play.

## Known limitations

- One table of up to six players (you and five opponents); the engine itself supports up to ten
  seats.
- The AI is a strong heuristic player, not a solver: its bet-sizing menu is small and it models
  opponents with summary statistics rather than full game-theoretic strategies.
- The button always moves to the next player; the tournament "dead button" rule is not used.
- Sounds are synthesised rather than recorded.
- Saves live in one browser profile; private-browsing modes that block storage keep the game in
  memory only (the game says so).
