# Velvet — No-Limit Texas Hold'em

A single-player poker game against AI opponents who play by the same rules and see the same
information you do. It runs entirely in the browser, offline, from one self-contained HTML file.

**Play online: https://bm-shreyas05.github.io/velvet-holdem/** — free, no sign-up, installable as
an app and playable offline. Play money only: chips have no cash value and cannot be bought.

- Complete, rules-correct No-Limit Hold'em engine: blinds and antes, heads-up rules, minimum
  raises, incomplete all-in raises, uncalled bets, side pots, split pots and odd chips.
- Tournaments (winner-take-all, or the top two or three paid), cash games with rebuys, and a
  daily challenge: the same table and deals for everyone that day.
- Five opponent personalities driven by one decision engine that reads ranges, estimates equity
  by simulation, weighs fold equity, pot odds and tournament prize equity (ICM), and learns your
  habits — across games, if you let it.
- Four difficulty levels: weaker opponents make the mistakes beginners make, stronger ones think
  deeper and more consistently. None of them cheat.
- A hand replayer, a coach that reviews your decisions, achievements that unlock table felts and
  card backs, and save export/import.
- Animated table with illustrated court cards, synthesised sound, statistics, crash-safe saves,
  keyboard play and accessibility options.

## Play

Open the link above. To install it, use your browser's *Install app* (the menu also offers
*Install app* where the browser supports it) or, on iPhone and iPad, *Share → Add to Home Screen*.
Once loaded it works without a connection.

To run it locally you need Node.js 22.18 or newer (only to build and test):

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

### Ways to play

**Tournament** (*New game → Tournament*): your name, 1–5 opponents (name and style each),
difficulty, starting chips, blinds, the blind structure (Turbo every 8 hands, Standard every 12,
Deep every 20, or fixed), antes (a tenth of the big blind from level 4, when the blinds rise) and
prizes — winner-take-all, top 2 (65/35) or top 3 (50/30/20) of a pool of 100 points per player.
Play continues until one player holds every chip; if you are knocked out you can watch the rest,
skip to the result, or leave. When more than one place pays, opponents play the money bubble:
chips they might lose count for more than chips they might win.

**Cash game** (*New game → Cash game*): fixed blinds and a buy-in. Nobody is eliminated — buy in
again when you run out (opponents do too). Cash out from the pause menu; during a hand you finish
it first. The session summary shows your result in chips, big blinds and big blinds per 100
hands.

**Daily challenge** (main menu): one tournament per date with the same opponents, difficulty and
deck order for every hand number, for everyone. Your first game of the day counts for your record
and streak; replays are practice. Share your result from the game-over screen.

### Getting better

- **Replays.** Any hand in the history can be replayed on the table, step by step, exactly as you
  saw it — other players' cards stay hidden unless they were shown.
- **The coach.** *Review with coach* has the Elite AI look at each of your decisions from the view
  you had at the time: your equity against the opponents' likely hands, what a call needed, and
  the value of each option in big blinds, with a verdict (good, close call, costly).
- **Coach hints** (*Settings → Gameplay*, off by default) show its suggestion on your turn.

### Progress and settings

24 achievements (some secret); several unlock new table felts and card backs. Opponents can
remember how you play across games (*Settings → Gameplay*, on by default, never used in the daily
challenge; *Make opponents forget me* resets it).

Settings (sound levels by category, theme, UI size, felt colour, card backs, four-colour deck,
high contrast, game speed, reduced motion, helper displays, auto-deal, all-in confirmation,
showing or mucking losing hands) apply immediately and are remembered. *Settings → Data* exports
every save to a file and imports it in another browser or on another device.

## Tests and verification

```bash
npm test                 # 108 unit and integration tests
npm run test:e2e         # browser tests: Chromium, Firefox, WebKit, iPhone and Android sizes
npm run simulate         # stress simulation (200k random hands, 400 freeze-outs, 200 cash
                         # sessions, 12 AI games)
npm run evaluate-ai      # AI evaluation by simulated play (15–20 minutes; --quick, --only B)
npm run exhaustive       # evaluates all 133,784,560 seven-card hands
npm run lint             # Biome lint and format check (npm run format applies fixes)
npm run typecheck
npm run check            # lint + typecheck + tests + quick simulation + build
npm run gen:preflop      # regenerate src/ai/preflop-table.ts (seeded, so the output is identical)
npm run gen:images       # re-render the app icons and link-preview image
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
  hands with side pots (up to 8 pots) and 12,074 split pots; 400 complete freeze-outs; 200 cash
  sessions (30,000 hands, 15,824 rebuys, every chip at the table accounted for after each hand);
  and 12 full games with the real AI across every prize structure and cash games — no invariant
  violations, the heap stays under 50 MB, and no AI decision took longer than 100 ms.
- **Information boundaries.** Views handed to the AI and the interface never contain unrevealed
  hole cards or deck data; AI modules cannot import engine internals (enforced by a test); an AI
  decision is bit-for-bit identical in two worlds that differ only in cards it cannot see.
  Replays never show a card the player did not see.
- **Game modes.** Cash games: rebuys keep every chip accounted for, cashing out mid-hand waits for
  the hand, a save made while broke resumes by offering the buy-in. Tournament prizes are paid to
  the right places; antes start at level 4; the daily challenge deals identical decks to everyone.
- **ICM.** Prize equities match the Malmuth–Harville model (checked against a hand-worked
  example), bubble factors stay between 1 and their cap for random stacks, and on a money bubble
  the AI folds hands it calls when only chips count.
- **Coach.** Folding aces to a small raise is graded costly and folding seven-deuce to a shove
  good; the exact amount the player chose is priced; reviews are deterministic.
- **Interface sync.** The animated table is replayed event by event over whole games and must
  equal the engine's state after every batch.
- **Saves and backups.** Round trip, damaged newest save (falls back to the previous one), edited
  payload (checksum), foreign data, newer versions (refused), older versions (migrated), failed
  writes; backups are verified in a scratch store before anything is replaced.
- **Real browsers** (`npm run test:e2e`, Playwright; run `npx playwright install` once first).
  In desktop Chromium, Firefox and WebKit and in iPhone 13 and Pixel 7 emulation: the menu loads
  without errors or sideways scrolling; hands are played against the AI in its Web Worker with
  chip totals checked; a game survives a reload; your hole cards are rendered face up (checked
  from screenshot pixels); every seat stays on screen with the longest possible names; a hand is
  replayed and reviewed by the coach; coach hints appear; a cash game is cashed out mid-hand; the
  daily challenge starts; achievements are awarded; opponents remember you in a new game; saves
  are exported to a file and imported back. In Chromium, the game is played offline.

### AI evaluation (last full run)

`npm run evaluate-ai` plays cash-style sessions (every hand starts at 100 big blinds); results
are in big blinds per 100 hands with 95% confidence intervals. All 12 checks pass.

- **Exploitation.** An Elite Shark against exploitable fixed styles (a calling station, a maniac
  and a random player), 4-handed, 2,500 hands: **+641 ± 230 bb/100**.
- **Difficulty ladder.** Duplicate heads-up matches: each pair plays the same deck sequence twice
  with the seats swapped, which cancels most of the card luck (2 × 2,000 hands per pair).

  | Match | Result for the first player |
  | --- | --- |
  | Elite vs Casual | **+192 ± 64** |
  | Standard vs Casual | **+177 ± 77** |
  | Pro vs Standard | **+92 ± 55** |
  | Elite vs Pro | −23 ± 60 (level) |

  Casual, Standard and Pro are clearly separated. Pro and Elite share the full engine and come
  out level head to head; Elite simulates more deeply and picks its best option more
  consistently, but that does not show as a measurable edge against Pro.
- **Style fingerprints** (Pro, one table, 2,000 hands): the Rock plays 15% of hands, the Shark
  23%, the Trapper 27%, the Maniac 51% with the highest aggression; the Station plays 40%, has an
  aggression factor of 0.57, folds to bets only 15% of the time and reaches showdown most often.
- **Adaptation** (heads-up, 2,500 hands): against a player who folds to most bets, a Pro Shark
  bluffs 33% of its weak hands in the first 100 hands and 95% once its read is firm; against a
  calling station it bluffs 4–8%.

The station check is an absolute bound (bluffing stays at or below 10%) because the read forms
within the first few dozen hands, leaving nothing to compare against later.

## How it works

```
src/
  engine/   cards, rng, deck, evaluator, pots, hand (one hand's state machine), game (a freeze-out
            or a cash game: button, blinds, eliminations, buy-ins), records, replay, types
  ai/       combos, preflop-table (generated), strength (board percentiles), ranges (Bayesian
            range reading), model (opponent statistics), icm (tournament prize equity), profiles,
            decide, worker, host
  game/     config (game types, prizes, the daily challenge), session, controller (game loop),
            history, stats, settings, progress (achievements, daily results, reputation),
            review (replays and the coach), backup, persistence, storage
  ui/       app shell, screens, sheets, replayer, table-view, table-model, presenter, action-bar,
            controls-model, dialogs, log-panel, layout, motion, format, pwa, dom
  assets/   procedurally drawn cards and court figures, chips, avatars, icons (SVG)
  audio/    synthesised sound (Web Audio)
  dev/      developer scenarios
  sim/      scripted sparring bots and a headless presenter for tests and simulations
  styles/   main.css
  pwa/      service worker template (the build stamps in a version and the asset list)
public/     web-app manifest, icons, social preview image (copied into dist/)
scripts/    build, serve, simulate, evaluate-ai, exhaustive-evaluator, gen-preflop-table,
            gen-images, dev/
tests/      node:test suites
e2e/        Playwright browser tests
.github/    CI and GitHub Pages deployment
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
continued. Cash games add buy-ins between hands (the table's chip total grows by exactly the
chips bought).

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
4. *Tournament pressure.* When more than one place pays, the Independent Chip Model turns stacks
   into shares of the prize pool. A bubble factor — how much more losing chips hurts than winning
   them helps — scales the losing side of each option, and raises the equity an opponent needs to
   call.
5. *Choice.* A softmax over the values: close spots are mixed, clear ones are consistent.

Personalities change perception and preference (how much a player believes bets, assumes bluffs,
likes to see flops or to bet), never the rules. Difficulty changes simulation depth, how strongly
ranges are read, how much personal reads are used, how consistently the best option is taken and
how many bet sizes are considered; Casual and Standard opponents also have the habits of weaker
players — calling too much, checking strong hands, rarely bluffing, and betting bigger with
better hands (a tell an observant player can use). Opponent statistics are Beta-binomial
estimates with population priors, kept as lifetime and recent (decayed) counts, so reads build
gradually and style changes show up first in the recent window. Casual opponents ignore reads
entirely.

**Coach and replays.** A replay re-runs a hand through the engine from its stored deck order and
decisions and keeps only the player's view at each step, so it shows exactly what was visible at
the table. The coach evaluates the player's decisions from those same views with the Elite engine,
pricing the player's exact action next to the engine's own options.

**Interface.** Plain TypeScript and DOM (no framework). The table is a fixed-geometry stage scaled
to the window, with landscape and portrait layouts. `table-model.ts` advances a plain display
model one event at a time so animations play between states, then reconciles with the engine's
snapshot after every batch. The replayer drives a second table with the same presenter.

### Design decisions

- **Browser + TypeScript, single file.** Runs anywhere without installation, needs no network,
  and keeps one language across engine, AI, interface and tests. esbuild bundles the game and
  embeds the AI worker as a string started from a Blob URL; if a browser refuses workers the AI
  runs inline in short tasks instead. The display font (Playfair Display, SIL Open Font License)
  is embedded too.
- **Tests run the real source.** Node runs the TypeScript directly (type stripping), so tests
  exercise exactly the modules that ship.
- **Fairness by construction.** Normal games shuffle with the operating system's secure random
  generator (every deck order reachable). Seeded randomness is used only where sharing is the
  point — the daily challenge, which deals everyone the same decks — and for tests, simulations,
  replays and the developer mode. AI randomness is a separate stream unrelated to the deck.
- **Learning tools see what you saw.** Replays and the coach work from the player's own views, so
  they can never reveal an opponent's folded cards.
- **Procedural assets.** Cards (including the court figures), chips, avatars, icons and sounds are
  generated, so there are no binary assets to lose and everything scales cleanly. The only images
  are the app icons and the link-preview picture, which `npm run gen:images` renders from the same
  artwork with a local Chrome or Edge.
- **Static hosting.** The game needs no server: any static host can serve `dist/`. The service
  worker precaches this exact build and serves it first, so it loads instantly and offline; a new
  deployment changes the worker, the browser fetches it in the background, and the game offers a
  reload.

## Deploying

Pushes to `main` run [the CI workflow](.github/workflows/ci.yml): lint, typecheck, unit tests, a
quick simulation, the build and the browser tests. If all pass, `dist/` is published to GitHub
Pages (repository *Settings → Pages → Source: GitHub Actions*). The build receives the site's
address as `SITE_URL`, which it needs for absolute link-preview URLs.

Any other static host works the same way:

```bash
SITE_URL=https://your.domain/path/ npm run build
```

then upload `dist/` except `artifact.html` (a variant for hosts that supply their own page shell).
Serve it over HTTPS; offline play and installing need a secure origin.

## Browser support

Chrome and Edge 111+, Firefox 113+, Safari 16.2+ (iPhone and iPad on iOS 16.2+) — every browser
updated since spring 2023. Older browsers may lose some colours and borders. The game has been
tested in the engines above through Playwright (including phone emulation), not yet on physical
phones.

## Rules as implemented

- Moving button; heads-up the button posts the small blind and acts first before the flop and
  last after it.
- Antes, when used, are posted by every player before the blinds and go straight into the pot.
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
- Tournaments: players knocked out in the same hand are placed by their stacks at the start of
  that hand. Cash games: a player who runs out buys in again before the next hand, or leaves.

## Saved data

Nothing leaves your device: there are no accounts, analytics or ads. (The host serving the page
sees ordinary web requests when it loads.) Everything is stored in the browser's local storage
for the page: `velvet.session` (the game in progress, saved after every action — including
mid-hand, so closing the page never lets anyone escape a hand), `velvet.history` (up to 300 hands
of the current game), `velvet.career` (lifetime statistics), `velvet.progress` (achievements,
daily results, and what opponents have learned about you) and `velvet.settings`.

Each is written as a versioned, checksummed envelope into two alternating slots, so an
interrupted write never destroys the previous good save. Damaged or edited saves are detected
and the game falls back to the last good copy or explains what happened; saves from a newer
version are refused rather than misread. *Settings → Data* exports all of it to one file and
imports such a file (after checking every part of it). To reset, use *Settings → Reset lifetime
statistics*, start a new game, or clear the site's data in the browser (which also removes the
offline copy the service worker keeps in the browser's cache storage).

## Developer mode

Add `#dev` to the URL. The New game screen then offers a seed (reproducible deck and AI choices)
and prepared first hands (a split pot, a multi-way all-in with side pots); such games are marked
*Seeded*. Hand history adds *Copy replay data* (deck order and decisions), which
`replayHand()` in `src/engine/replay.ts` reproduces exactly. `window.__velvet` exposes read-only
snapshots for debugging. None of this is visible in normal play.

## Known limitations

- One table of up to six players (you and five opponents); the engine itself supports up to ten
  seats.
- No online play: there are no global leaderboards or games against other people, which would
  need a server, accounts and moderation. The daily challenge's result can be shared as text.
- The AI is a strong heuristic player, not a solver: it models opponents with summary statistics
  rather than full game-theoretic strategies, and the coach's values are that model's estimates.
- The daily challenge's decks follow from the date, so someone determined could compute them in
  advance; with no prizes or rankings at stake this only spoils their own fun.
- The button always moves to the next player; the tournament "dead button" rule is not used.
- Sounds are synthesised rather than recorded. On iPhone, sound follows the ring/silent switch.
- Tested in real browser engines with phone emulation, but not yet on physical phones.
- Saves live in one browser profile unless exported; private-browsing modes that block storage
  keep the game in memory only (the game says so).
