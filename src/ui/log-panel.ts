import { type Card, RANK_CHARS, rankOf, suitOf } from '../engine/cards.ts';
import { SUIT_SYMBOLS, suitColor } from '../assets/cards.ts';
import { h } from './dom.ts';
import type { Tone } from './format.ts';

/** The running table log: every action, card and result of recent hands, newest at the bottom. */
export class LogPanel {
  readonly root: HTMLElement;
  #list: HTMLElement;
  #fourColor: () => boolean;
  #count = 0;

  constructor(fourColor: () => boolean) {
    this.#fourColor = fourColor;
    this.#list = h('ol', { class: 'log-list' });
    this.root = h('aside', { class: 'log-panel', 'aria-label': 'Table log' }, h('h2', { class: 'log-title' }, 'Table log'), this.#list);
  }

  cardsInline(cards: Card[]): HTMLElement {
    return h(
      'span',
      { class: 'inline-cards' },
      ...cards.map((c) =>
        h(
          'span',
          { class: 'inline-card', style: `color:${suitColor(suitOf(c), this.#fourColor())}` },
          (rankOf(c) === 8 ? '10' : RANK_CHARS[rankOf(c)]!) + SUIT_SYMBOLS[suitOf(c)],
        ),
      ),
    );
  }

  hand(n: number, detail: string): void {
    this.#push(h('li', { class: 'log-hand' }, h('strong', {}, `Hand ${n}`), h('span', {}, detail)));
  }

  entry(text: string | Node, tone: Tone | 'street' | 'info' = 'info', cards?: Card[]): void {
    const li = h('li', { class: `log-entry tone-${tone}` }, h('span', { class: 'log-dot', 'aria-hidden': 'true' }), typeof text === 'string' ? h('span', {}, text) : text);
    if (cards?.length) li.append(' ', this.cardsInline(cards));
    this.#push(li);
  }

  #push(li: HTMLElement): void {
    const atBottom = this.#list.scrollHeight - this.#list.scrollTop - this.#list.clientHeight < 40;
    this.#list.append(li);
    this.#count++;
    while (this.#count > 250) {
      this.#list.firstElementChild?.remove();
      this.#count--;
    }
    if (atBottom) this.#list.scrollTop = this.#list.scrollHeight;
  }

  clear(): void {
    this.#list.replaceChildren();
    this.#count = 0;
  }
}
