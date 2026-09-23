import type { LegalActions, PlayerAction } from '../engine/types.ts';
import type { Settings } from '../game/settings.ts';
import { type ControlsState, aggressiveLabel, controlsFor, parseAmount, toAction, validateAmount } from './controls-model.ts';
import { h } from './dom.ts';
import { chips, pct } from './format.ts';

export interface ActionBarHooks {
  settings: () => Settings;
  click: () => void;
  confirmAllIn: (amount: number) => Promise<boolean>;
}

/**
 * The player's controls. Buttons exist only for legal actions; when it is not the player's turn
 * everything is disabled and the bar says whose turn it is. Keyboard: F fold, C check/call,
 * R bet/raise, A all-in, ↑/↓ adjust, Enter confirms the amount.
 */
export class ActionBar {
  readonly root: HTMLElement;
  readonly #hooks: ActionBarHooks;
  #status: HTMLElement;
  #info: HTMLElement;
  #strength: HTMLElement;
  #odds: HTMLElement;
  #fold: HTMLButtonElement;
  #passive: HTMLButtonElement;
  #aggressive: HTMLButtonElement;
  #sizing: HTMLElement;
  #presets: HTMLElement;
  #slider: HTMLInputElement;
  #input: HTMLInputElement;
  #note: HTMLElement;
  #legal: LegalActions | null = null;
  #state: ControlsState | null = null;
  #amount = 0;
  #resolve: ((a: PlayerAction) => void) | null = null;
  #busy = false;

  constructor(hooks: ActionBarHooks) {
    this.#hooks = hooks;
    this.#status = h('div', { class: 'bar-status', role: 'status' });
    this.#strength = h('div', { class: 'bar-strength' });
    this.#odds = h('div', { class: 'bar-odds' });
    this.#info = h('div', { class: 'bar-info' }, this.#strength, this.#odds);
    this.#fold = h('button', { type: 'button', class: 'act act--fold', 'aria-keyshortcuts': 'F' }) as HTMLButtonElement;
    this.#passive = h('button', { type: 'button', class: 'act act--passive', 'aria-keyshortcuts': 'C' }) as HTMLButtonElement;
    this.#aggressive = h('button', { type: 'button', class: 'act act--aggressive', 'aria-keyshortcuts': 'R' }) as HTMLButtonElement;
    this.#fold.addEventListener('click', () => this.#choose('fold'));
    this.#passive.addEventListener('click', () => this.#choose('passive'));
    this.#aggressive.addEventListener('click', () => this.#choose('aggressive'));

    this.#presets = h('div', { class: 'presets', role: 'group', 'aria-label': 'Bet size presets' });
    this.#slider = h('input', { type: 'range', class: 'bet-slider', id: 'bet-slider', 'aria-label': 'Bet amount' }) as HTMLInputElement;
    this.#slider.addEventListener('input', () => this.#setAmount(Number(this.#slider.value), false));
    this.#input = h('input', { type: 'text', inputmode: 'numeric', class: 'bet-input', id: 'bet-input', 'aria-label': 'Bet amount in chips', autocomplete: 'off' }) as HTMLInputElement;
    this.#input.addEventListener('change', () => this.#commitTyped());
    this.#input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.#commitTyped()) this.#choose('aggressive');
      }
    });
    this.#note = h('div', { class: 'bet-note', role: 'alert' });
    this.#sizing = h('div', { class: 'sizing' }, this.#presets, h('div', { class: 'slider-row' }, this.#slider, this.#input), this.#note);

    this.root = h(
      'section',
      { class: 'action-bar', 'aria-label': 'Your actions' },
      h('div', { class: 'bar-left' }, this.#status, this.#info),
      h('div', { class: 'bar-buttons' }, this.#fold, this.#passive, this.#aggressive),
      this.#sizing,
    );
    this.idle('');
  }

  get waiting(): boolean {
    return this.#resolve !== null;
  }

  /** Not the player's turn: show whose turn it is, disable everything. */
  idle(message: string): void {
    this.#legal = null;
    this.#state = null;
    this.root.classList.remove('is-active');
    this.#status.textContent = message;
    for (const b of [this.#fold, this.#passive, this.#aggressive]) b.disabled = true;
    this.#fold.textContent = 'Fold';
    this.#passive.textContent = 'Check';
    this.#aggressive.textContent = 'Raise';
    this.#sizing.classList.add('is-hidden');
    this.#odds.textContent = '';
  }

  setHandStrength(text: string): void {
    const show = this.#hooks.settings().gameplay.showHandStrength;
    this.#strength.textContent = show && text ? text : '';
  }

  /** Ask for a decision; resolves when the player acts. */
  request(legal: LegalActions): Promise<PlayerAction> {
    this.#legal = legal;
    const state = controlsFor(legal);
    this.#state = state;
    this.root.classList.add('is-active');
    this.#status.textContent = 'Your turn';
    this.#fold.hidden = !state.canFold;
    this.#fold.disabled = !state.canFold;
    this.#fold.innerHTML = `Fold <kbd>F</kbd>`;
    this.#passive.disabled = false;
    this.#passive.innerHTML = `${state.passive.label} <kbd>C</kbd>`;
    this.#passive.classList.toggle('is-allin', state.passive.allIn);
    const odds = state.potOdds;
    this.#odds.textContent =
      odds && this.#hooks.settings().gameplay.showPotOdds
        ? `Call ${chips(odds.toCall)} to win ${chips(odds.potAfterCall)} · you need ${pct(odds.equityNeeded)} equity`
        : '';
    const agg = state.aggressive;
    if (agg) {
      this.#aggressive.hidden = false;
      this.#aggressive.disabled = false;
      this.#sizing.classList.toggle('is-hidden', agg.allInOnly);
      this.#slider.min = String(agg.min);
      this.#slider.max = String(agg.max);
      this.#slider.step = String(agg.step);
      this.#presets.replaceChildren(
        ...agg.presets.map((p) => {
          const b = h('button', { type: 'button', class: 'preset', 'data-id': p.id, title: `${p.label}: ${chips(p.to)}` }, p.label) as HTMLButtonElement;
          b.addEventListener('click', () => {
            this.#hooks.click();
            this.#setAmount(p.to, true);
          });
          return b;
        }),
      );
      const defaultTo = agg.presets.find((p) => p.id === (legal.aggression === 'bet' ? 'half' : 'min'))?.to ?? agg.min;
      this.#setAmount(agg.allInOnly ? agg.max : defaultTo, true);
    } else {
      this.#aggressive.hidden = true;
      this.#aggressive.disabled = true;
      this.#sizing.classList.add('is-hidden');
    }
    this.#note.textContent = '';
    this.#busy = false;
    return new Promise((resolve) => {
      this.#resolve = resolve;
      // Put keyboard focus on the most common choice without scrolling the page.
      (state.canFold ? this.#passive : this.#passive).focus({ preventScroll: true });
    });
  }

  /** Abandon a pending request (leaving the table). */
  cancel(): void {
    const pending = this.#resolve;
    this.#resolve = null;
    this.idle('');
    // Settle the promise so the (already stopped) game loop can finish; it discards the action.
    pending?.({ kind: 'check' });
  }

  #setAmount(value: number, fromPreset: boolean): void {
    const legal = this.#legal;
    const agg = this.#state?.aggressive;
    if (!legal || !agg) return;
    const v = validateAmount(Math.round(value), legal);
    this.#amount = v.to;
    this.#slider.value = String(v.to);
    this.#input.value = chips(v.to);
    this.#aggressive.innerHTML = `${aggressiveLabel(agg.kind, v.to, agg.max)} <kbd>R</kbd>`;
    this.#aggressive.classList.toggle('is-allin', v.to >= agg.max);
    for (const b of this.#presets.querySelectorAll<HTMLButtonElement>('.preset')) {
      const p = agg.presets.find((x) => x.id === b.dataset.id);
      b.setAttribute('aria-pressed', String(!!p && p.to === v.to));
    }
    if (fromPreset) this.#note.textContent = '';
  }

  #commitTyped(): boolean {
    const legal = this.#legal;
    if (!legal) return false;
    const parsed = parseAmount(this.#input.value);
    const v = validateAmount(parsed, legal);
    this.#setAmount(v.to, false);
    this.#note.textContent = v.note ?? '';
    return parsed !== null;
  }

  adjust(direction: 1 | -1, big: boolean): void {
    const agg = this.#state?.aggressive;
    if (!agg) return;
    const step = big ? Math.max(agg.step * 4, this.#legal!.bigBlind) : agg.step;
    this.#setAmount(this.#amount + direction * step, true);
  }

  selectAllIn(): void {
    const agg = this.#state?.aggressive;
    if (agg) this.#setAmount(agg.max, true);
    else if (this.#state?.passive.allIn) this.#passive.focus();
  }

  async #choose(choice: 'fold' | 'passive' | 'aggressive'): Promise<void> {
    const legal = this.#legal;
    const resolve = this.#resolve;
    if (!legal || !resolve || this.#busy) return;
    if (choice === 'fold' && !legal.canFold) return;
    if (choice === 'aggressive' && !legal.aggression) return;
    const action = toAction(choice, legal, this.#amount);
    const allIn = (action.kind === 'bet' || action.kind === 'raise') && action.to === legal.maxTo;
    const callAllIn = action.kind === 'call' && legal.callIsAllIn;
    if ((allIn || callAllIn) && this.#hooks.settings().gameplay.confirmAllIn) {
      this.#busy = true;
      const ok = await this.#hooks.confirmAllIn(allIn ? legal.maxTo : legal.toCall);
      this.#busy = false;
      if (!ok || this.#resolve !== resolve) return;
    }
    this.#hooks.click();
    this.#resolve = null;
    this.idle('');
    resolve(action);
  }

  /** Keyboard shortcuts while it is the player's turn. Returns true if the key was used. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.#resolve) return false;
    const typing = e.target instanceof HTMLInputElement && e.target.type === 'text';
    switch (e.key) {
      case 'f':
      case 'F':
        if (typing) return false;
        void this.#choose('fold');
        return true;
      case 'c':
      case 'C':
      case 'k':
      case 'K':
        if (typing) return false;
        void this.#choose('passive');
        return true;
      case 'r':
      case 'R':
      case 'b':
      case 'B':
        if (typing) return false;
        void this.#choose('aggressive');
        return true;
      case 'a':
      case 'A':
        if (typing) return false;
        this.selectAllIn();
        return true;
      case 'ArrowUp':
      case '+':
      case '=':
        if (typing && e.key !== 'ArrowUp') return false;
        this.adjust(1, e.shiftKey);
        return true;
      case 'ArrowDown':
      case '-':
        if (typing && e.key !== 'ArrowDown') return false;
        this.adjust(-1, e.shiftKey);
        return true;
      default:
        return false;
    }
  }
}
