import { type Card, cardName } from '../engine/cards.ts';
import { STYLES } from '../ai/profiles.ts';
import { avatarSvg } from '../assets/avatars.ts';
import { cardBackUrl, cardFaceUrl } from '../assets/cards.ts';
import { chipStackSvg, chipTopSvg } from '../assets/chips.ts';
import type { Settings } from '../game/settings.ts';
import { clear, h, svgEl } from './dom.ts';
import { chips, ordinal } from './format.ts';
import { type Orientation, type Point, type StageLayout, chooseOrientation, computeLayout } from './layout.ts';
import type { Motion } from './motion.ts';
import type { SeatDisplay, TableDisplay } from './table-model.ts';
import { totalPot } from './table-model.ts';

type CardSize = 'board' | 'hero' | 'seat';

interface SeatEls {
  root: HTMLElement;
  cards: HTMLElement;
  name: HTMLElement;
  stack: HTMLElement;
  status: HTMLElement;
  badge: HTMLElement;
  hand: HTMLElement;
  blind: HTMLElement;
  avatar: HTMLElement;
}

export interface SidePotInfo {
  label: string;
  amount: number;
}

/**
 * The poker table: a fixed-geometry stage scaled to fit, with seats, bets, board, pot, dealer
 * button and a layer for flying cards and chips. `render()` draws any TableDisplay exactly;
 * the animation methods only ever move things between two rendered states.
 */
export class TableView {
  readonly root: HTMLElement;
  readonly #motion: Motion;
  readonly #settings: () => Settings;
  #stage!: HTMLElement;
  #felt!: HTMLElement;
  #layout!: StageLayout;
  #orientation: Orientation = 'landscape';
  #scale = 1;
  #seatCount: number;
  #seats: SeatEls[] = [];
  #bets: HTMLElement[] = [];
  #board: HTMLElement[] = [];
  #pot!: HTMLElement;
  #potChips!: HTMLElement;
  #potAmount!: HTMLElement;
  #potTotal!: HTMLElement;
  #sidePots!: HTMLElement;
  #dealer!: HTMLElement;
  #fx!: HTMLElement;
  #banner!: HTMLElement;
  #display: TableDisplay | null = null;
  #sidePotInfo: SidePotInfo[] = [];
  #observer: ResizeObserver | null = null;

  constructor(seatCount: number, motion: Motion, settings: () => Settings) {
    this.#seatCount = seatCount;
    this.#motion = motion;
    this.#settings = settings;
    this.root = h('div', { class: 'stage-wrap' });
    this.#build('landscape');
  }

  mount(parent: HTMLElement): void {
    parent.append(this.root);
    this.#observer = new ResizeObserver(() => this.relayout());
    this.#observer.observe(parent);
    this.relayout();
  }

  destroy(): void {
    this.#observer?.disconnect();
    this.root.remove();
  }

  relayout(): void {
    const box = this.root.parentElement?.getBoundingClientRect();
    if (!box || box.width < 10 || box.height < 10) return;
    const orientation = chooseOrientation(box.width, box.height);
    if (orientation !== this.#orientation) {
      this.#build(orientation);
      if (this.#display) this.render(this.#display, this.#sidePotInfo);
    }
    this.#scale = Math.min(box.width / this.#layout.width, box.height / this.#layout.height);
    this.#stage.style.transform = `translate(-50%, -50%) scale(${this.#scale})`;
  }

  // -------------------------------------------------------------------------------------------
  // Construction

  #build(orientation: Orientation): void {
    this.#orientation = orientation;
    this.#layout = computeLayout(this.#seatCount, orientation);
    const L = this.#layout;
    clear(this.root);
    this.#stage = h('div', { class: `stage stage--${orientation}`, style: `width:${L.width}px;height:${L.height}px` });
    const t = L.table;
    this.#felt = h(
      'div',
      {
        class: 'table',
        style: `left:${t.cx - t.rx}px;top:${t.cy - t.ry}px;width:${t.rx * 2}px;height:${t.ry * 2}px`,
        'aria-hidden': 'true',
      },
      h('div', { class: 'table-felt' }, h('div', { class: 'felt-mark' }, h('span', { class: 'felt-title' }, 'Velvet'), h('span', { class: 'felt-sub' }, "No-Limit Hold'em"))),
    );
    this.#stage.append(this.#felt);

    const boardEl = h('div', { class: 'board', role: 'group', 'aria-label': 'Community cards', style: this.#pos(L.board) });
    this.#board = [];
    for (let i = 0; i < 5; i++) {
      const slot = h('div', { class: 'board-slot' });
      this.#board.push(slot);
      boardEl.append(slot);
    }
    this.#stage.append(boardEl);

    this.#potChips = h('div', { class: 'pot-chips' });
    this.#potAmount = h('div', { class: 'pot-amount' });
    this.#potTotal = h('div', { class: 'pot-total' });
    this.#sidePots = h('div', { class: 'side-pots' });
    this.#pot = h('div', { class: 'pot', style: this.#pos(L.pot), role: 'status', 'aria-live': 'off' }, this.#potChips, this.#potAmount, this.#potTotal, this.#sidePots);
    this.#stage.append(this.#pot);

    this.#bets = [];
    this.#seats = [];
    for (let i = 0; i < this.#seatCount; i++) {
      const g = L.seats[i]!;
      const bet = h('div', { class: 'bet', style: this.#pos(g.bet), 'data-seat': i }, h('span', { class: 'bet-chips' }), h('span', { class: 'bet-amount' }));
      this.#bets.push(bet);
      this.#stage.append(bet);
    }
    for (let i = 0; i < this.#seatCount; i++) {
      const g = L.seats[i]!;
      const isHero = i === 0;
      const els: SeatEls = {
        root: h('div', { class: `seat ${isHero ? 'seat--hero' : 'seat--ai'} side-${g.side}`, style: this.#pos(g.anchor), 'data-seat': i }),
        cards: h('div', { class: 'seat-cards' }),
        name: h('div', { class: 'seat-name' }),
        stack: h('div', { class: 'seat-stack' }),
        status: h('div', { class: 'seat-status' }),
        badge: h('div', { class: 'seat-badge' }),
        hand: h('div', { class: 'seat-hand' }),
        blind: h('div', { class: 'blind-chip' }),
        avatar: h('div', { class: 'avatar' }),
      };
      const plate = h(
        'div',
        { class: 'seat-plate' },
        els.avatar,
        h('div', { class: 'seat-info' }, els.name, els.stack),
        els.blind,
      );
      els.root.append(els.cards, plate, els.status, els.badge, els.hand);
      this.#seats.push(els);
      this.#stage.append(els.root);
    }

    this.#dealer = h('div', { class: 'dealer-btn', 'aria-hidden': 'true' }, 'D');
    this.#stage.append(this.#dealer);
    this.#banner = h('div', { class: 'table-banner', role: 'status' });
    this.#stage.append(this.#banner);
    this.#fx = h('div', { class: 'fx-layer', 'aria-hidden': 'true' });
    this.#stage.append(this.#fx);
    this.root.append(this.#stage);
    if (this.#scale) this.#stage.style.transform = `translate(-50%, -50%) scale(${this.#scale})`;
  }

  #pos(p: Point): string {
    return `left:${p.x}px;top:${p.y}px`;
  }

  // -------------------------------------------------------------------------------------------
  // Rendering

  #cardEl(card: Card | null, size: CardSize, faceUp: boolean): HTMLElement {
    const s = this.#settings().display;
    const el = h(
      'div',
      { class: `card card--${size}`, 'data-up': faceUp && card !== null ? 'true' : 'false', role: 'img', 'aria-label': card === null || !faceUp ? 'Face-down card' : cardName(card) },
      h('div', { class: 'card-inner' }, h('img', { class: 'card-face', alt: '', draggable: 'false', src: card === null ? cardBackUrl(s.cardBack) : cardFaceUrl(card, { fourColor: s.fourColorDeck }) }), h('img', { class: 'card-back', alt: '', draggable: 'false', src: cardBackUrl(s.cardBack) })),
    );
    if (card !== null) el.dataset.card = String(card);
    return el;
  }

  render(d: TableDisplay, sidePots: SidePotInfo[] = []): void {
    this.#display = d;
    this.#sidePotInfo = sidePots;
    this.#stage.dataset.felt = this.#settings().display.felt;

    // Board
    this.#board.forEach((slot, i) => {
      const card = d.board[i];
      const current = slot.firstElementChild as HTMLElement | null;
      if (card === undefined) {
        clear(slot);
        return;
      }
      if (!current || current.dataset.card !== String(card)) {
        clear(slot);
        slot.append(this.#cardEl(card, 'board', true));
      }
    });

    // Pot
    // The headline is everything at stake; the chip pile shows what has been gathered so far.
    const collected = d.pot;
    const total = totalPot(d);
    this.#pot.classList.toggle('is-empty', total <= 0);
    this.#potChips.innerHTML = collected > 0 ? chipStackSvg(collected).svg : '';
    this.#potAmount.textContent = total > 0 ? `Pot ${chips(total)}` : '';
    this.#potTotal.textContent = '';
    clear(this.#sidePots);
    if (sidePots.length > 1) for (const p of sidePots) this.#sidePots.append(h('span', { class: 'side-pot' }, `${p.label} ${chips(p.amount)}`));

    // Seats and bets
    d.seats.forEach((s, i) => this.#renderSeat(i, s, d));
    this.#bets.forEach((bet, i) => this.#renderBet(bet, d.seats[i]!.bet));

    // Dealer button
    const g = this.#layout.seats[d.button];
    if (g && d.seats[d.button] && !d.seats[d.button]!.eliminated) {
      this.#dealer.style.left = `${g.button.x}px`;
      this.#dealer.style.top = `${g.button.y}px`;
      this.#dealer.hidden = false;
    } else this.#dealer.hidden = true;
    this.setActive(d.toAct);
  }

  #renderBet(bet: HTMLElement, amount: number): void {
    bet.classList.toggle('is-empty', amount <= 0);
    const chipsEl = bet.firstElementChild as HTMLElement;
    const label = bet.lastElementChild as HTMLElement;
    if (amount > 0) {
      if (bet.dataset.amount !== String(amount)) {
        chipsEl.innerHTML = chipStackSvg(amount).svg;
        label.textContent = chips(amount);
        bet.dataset.amount = String(amount);
      }
    } else {
      chipsEl.innerHTML = '';
      label.textContent = '';
      bet.dataset.amount = '0';
    }
  }

  #renderSeat(i: number, s: SeatDisplay, d: TableDisplay): void {
    const e = this.#seats[i]!;
    const isHero = i === d.humanSeat;
    const r = e.root;
    r.classList.toggle('is-folded', s.folded);
    r.classList.toggle('is-allin', s.allIn && !s.folded && d.phase !== 'complete');
    r.classList.toggle('is-out', s.eliminated);
    r.classList.toggle('is-winner', s.winner);
    r.classList.toggle('is-sitting-out', !s.inHand && !s.eliminated && d.phase !== 'waiting');
    if (e.name.textContent !== s.name) {
      e.name.textContent = s.name;
      e.avatar.innerHTML = avatarSvg(s.name, s.style);
      e.avatar.title = s.style ? STYLES[s.style].label : 'You';
    }
    e.stack.textContent = s.eliminated ? '' : chips(s.stack);
    let status = '';
    if (s.eliminated) status = s.place ? `Out · ${ordinal(s.place)}` : 'Out';
    else if (s.allIn && !s.folded && d.phase !== 'waiting' && d.phase !== 'complete') status = 'All-in';
    else if (s.folded) status = 'Folded';
    e.status.textContent = status;
    e.status.hidden = !status;
    e.root.setAttribute(
      'aria-label',
      `${isHero ? 'You' : s.name}${s.style ? `, ${STYLES[s.style].label}` : ''}: ${s.eliminated ? 'eliminated' : `${chips(s.stack)} chips`}${status && !s.eliminated ? `, ${status}` : ''}`,
    );

    // Blind marker
    const blind = d.phase === 'waiting' || d.phase === 'complete' ? '' : i === d.bigBlindSeat ? 'BB' : i === d.smallBlindSeat ? 'SB' : '';
    e.blind.textContent = blind;
    e.blind.hidden = !blind;

    // Badge (last action)
    if (s.badge) {
      e.badge.textContent = s.badge.label;
      e.badge.className = `seat-badge tone-${s.badge.tone}`;
      e.badge.hidden = false;
    } else e.badge.hidden = true;

    e.hand.textContent = s.handLabel ?? '';
    e.hand.hidden = !s.handLabel;

    // Cards
    const want = s.cards.map((c) => (c === null ? 'x' : String(c))).join(',');
    if (e.cards.dataset.cards !== want) {
      clear(e.cards);
      const size: CardSize = isHero ? 'hero' : 'seat';
      for (const c of s.cards) e.cards.append(this.#cardEl(c, size, c !== null));
      e.cards.dataset.cards = want;
    }
  }

  // -------------------------------------------------------------------------------------------
  // State indicators

  setActive(seat: number | null): void {
    this.#seats.forEach((e, i) => e.root.classList.toggle('is-turn', i === seat));
  }

  setThinking(seat: number | null): void {
    this.#seats.forEach((e, i) => {
      const on = i === seat;
      const was = e.root.classList.contains('is-thinking');
      e.root.classList.toggle('is-thinking', on);
      if (on) {
        e.status.textContent = 'Thinking…';
        e.status.hidden = false;
      } else if (was && this.#display) {
        this.#renderSeat(i, this.#display.seats[i]!, this.#display);
      }
    });
  }

  highlightWinningCards(cards: Card[]): void {
    const set = new Set(cards.map(String));
    const all = this.#stage.querySelectorAll<HTMLElement>('.board .card, .seat-cards .card');
    all.forEach((el) => {
      const inWin = !!el.dataset.card && set.has(el.dataset.card);
      el.classList.toggle('is-winning', cards.length > 0 && inWin);
      el.classList.toggle('is-dimmed', cards.length > 0 && !inWin && !!el.closest('.board'));
    });
  }

  showBanner(title: string, detail = ''): void {
    clear(this.#banner);
    this.#banner.append(h('div', { class: 'banner-title' }, title));
    if (detail) this.#banner.append(h('div', { class: 'banner-detail' }, detail));
    this.#banner.classList.add('is-visible');
  }

  hideBanner(): void {
    this.#banner.classList.remove('is-visible');
  }

  // -------------------------------------------------------------------------------------------
  // Animation helpers

  /** Centre of an element in stage coordinates. */
  #pointOf(el: Element): Point {
    const stageRect = this.#stage.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: (r.left + r.width / 2 - stageRect.left) / this.#scale, y: (r.top + r.height / 2 - stageRect.top) / this.#scale };
  }

  async #fly(markup: HTMLElement, from: Point, to: Point, ms: number, extra: Keyframe = {}): Promise<void> {
    if (this.#motion.duration(ms) <= 0) return;
    markup.style.left = `${from.x}px`;
    markup.style.top = `${from.y}px`;
    this.#fx.append(markup);
    await this.#motion.run(markup, [{ transform: 'translate(-50%, -50%) scale(1)', opacity: 1 }, { transform: `translate(calc(-50% + ${to.x - from.x}px), calc(-50% + ${to.y - from.y}px)) scale(1)`, opacity: 1, ...extra }], ms);
    markup.remove();
  }

  /** Cards fly from the dealer to each seat, one at a time, twice around. */
  async dealHole(order: number[], d: TableDisplay, onCard: () => void): Promise<void> {
    const deck = this.#layout.deck;
    for (const i of order) {
      const el = this.#seats[i]!.cards;
      el.style.visibility = 'hidden';
    }
    const flights: Promise<void>[] = [];
    let delay = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const i of order) {
        const target = this.#pointOf(this.#seats[i]!.cards);
        const card = this.#cardEl(null, i === d.humanSeat ? 'hero' : 'seat', false);
        card.classList.add('is-flying');
        const wait = delay;
        flights.push(
          this.#motion.wait(wait).then(() => {
            onCard();
            return this.#fly(card, deck, { x: target.x + (pass ? 10 : -10), y: target.y }, 260, { transform: `translate(calc(-50% + ${target.x + (pass ? 10 : -10) - deck.x}px), calc(-50% + ${target.y - deck.y}px)) rotate(${pass ? 4 : -4}deg)` });
          }),
        );
        delay += 70;
      }
    }
    await Promise.all(flights);
    for (const i of order) this.#seats[i]!.cards.style.visibility = '';
  }

  /** Flips the human's (or a revealed player's) cards face up with a 3D turn. */
  async flipSeat(seat: number): Promise<void> {
    const cards = [...this.#seats[seat]!.cards.querySelectorAll<HTMLElement>('.card')];
    await Promise.all(
      cards.map((c, k) => this.#motion.run(c.querySelector('.card-inner')!, [{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0deg)' }], 380, { delay: this.#motion.duration(k * 90) })),
    );
  }

  /** Chips slide from a player to their bet position. */
  async chipsToBet(seat: number, amount: number): Promise<void> {
    if (amount <= 0) return;
    const from = this.#pointOf(this.#seats[seat]!.root.querySelector('.seat-plate')!);
    const to = this.#layout.seats[seat]!.bet;
    await this.#fly(h('div', { class: 'fly-chip', html: chipTopSvg(amount) }), from, to, 280);
  }

  /** Bets slide back to a player (uncalled bet returned). */
  async betToSeat(seat: number, amount: number): Promise<void> {
    if (amount <= 0) return;
    const to = this.#pointOf(this.#seats[seat]!.root.querySelector('.seat-plate')!);
    await this.#fly(h('div', { class: 'fly-chip', html: chipTopSvg(amount) }), this.#layout.seats[seat]!.bet, to, 320);
  }

  /** All bets slide into the pot. */
  async collect(d: TableDisplay): Promise<void> {
    const flights = d.seats
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.bet > 0)
      .map(({ s, i }) => {
        this.#bets[i]!.classList.add('is-empty');
        return this.#fly(h('div', { class: 'fly-chip', html: chipTopSvg(s.bet) }), this.#layout.seats[i]!.bet, this.#layout.pot, 320);
      });
    await Promise.all(flights);
  }

  /** Winnings slide from the pot to the winner. */
  async potToSeat(seat: number, amount: number): Promise<void> {
    const to = this.#pointOf(this.#seats[seat]!.root.querySelector('.seat-plate')!);
    const pile = h('div', { class: 'fly-chip fly-chip--pile', html: chipStackSvg(amount).svg });
    await this.#fly(pile, this.#layout.pot, to, 520);
  }

  /** New board cards flip in one after another. */
  async revealBoard(from: number, cards: Card[], onCard: () => void): Promise<void> {
    for (let k = 0; k < cards.length; k++) {
      const slot = this.#board[from + k];
      if (!slot) continue;
      clear(slot);
      const el = this.#cardEl(cards[k]!, 'board', true);
      slot.append(el);
      onCard();
      await this.#motion.run(el, [{ transform: 'translateY(-16px) scale(.92)', opacity: 0 }, { transform: 'none', opacity: 1 }], 200);
      await this.#motion.run(el.querySelector('.card-inner')!, [{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0deg)' }], 320);
    }
  }

  /** A folded hand slides toward the middle and disappears. */
  async muck(seat: number): Promise<void> {
    const cards = [...this.#seats[seat]!.cards.querySelectorAll<HTMLElement>('.card')];
    const toward = this.#layout.board;
    const from = this.#pointOf(this.#seats[seat]!.cards);
    await Promise.all(
      cards.map((c) =>
        this.#motion.run(c, [{ transform: 'none', opacity: 1 }, { transform: `translate(${(toward.x - from.x) * 0.35}px, ${(toward.y - from.y) * 0.35}px) rotate(12deg) scale(.8)`, opacity: 0 }], 300),
      ),
    );
  }

  pulseStack(seat: number): void {
    const el = this.#seats[seat]!.stack;
    void this.#motion.run(el, [{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], 420);
  }

  popBadge(seat: number): void {
    const el = this.#seats[seat]!.badge;
    void this.#motion.run(el, [{ transform: 'translate(-50%, 0) scale(.6)', opacity: 0 }, { transform: 'translate(-50%, 0) scale(1)', opacity: 1 }], 220);
  }

  /** Brief visual pulse when a player goes out. */
  async eliminate(seat: number): Promise<void> {
    await this.#motion.run(this.#seats[seat]!.root, [{ filter: 'none' }, { filter: 'grayscale(1) brightness(.6)' }], 600);
  }

  get seatRoots(): HTMLElement[] {
    return this.#seats.map((s) => s.root);
  }

  /** Re-applies card artwork after a display setting changes. */
  refreshArt(): void {
    this.#seats.forEach((s) => delete s.cards.dataset.cards);
    this.#board.forEach((slot) => clear(slot));
    if (this.#display) this.render(this.#display, this.#sidePotInfo);
  }

  svgNode(markup: string): Element {
    return svgEl(markup);
  }
}
