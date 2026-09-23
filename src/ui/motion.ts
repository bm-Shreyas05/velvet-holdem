/**
 * Animation timing shared by the whole interface. Durations are scaled by the game-speed
 * setting, collapse to near-instant under reduced motion, and can be skipped wholesale (Space)
 * so animation never stands between the player and the game.
 */
export class Motion {
  speed = 1;
  reduced = false;
  #skipping = false;
  #running = new Set<Animation>();

  duration(ms: number): number {
    if (this.#skipping) return 0;
    if (this.reduced) return Math.min(ms, 120) * 0.6;
    return ms * this.speed;
  }

  /** Finish every running animation now and play the rest of this batch instantly. */
  skip(): void {
    this.#skipping = true;
    for (const a of this.#running) {
      try {
        a.finish();
      } catch {
        /* animation already finished */
      }
    }
  }

  endSkip(): void {
    this.#skipping = false;
  }

  get skipping(): boolean {
    return this.#skipping;
  }

  /** Web Animations wrapper that always resolves (even if the element is removed mid-flight). */
  run(el: Element, keyframes: Keyframe[], ms: number, options: KeyframeAnimationOptions = {}): Promise<void> {
    const duration = this.duration(ms);
    if (duration <= 0 || typeof el.animate !== 'function') return Promise.resolve();
    let anim: Animation;
    try {
      anim = el.animate(keyframes, { duration, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'both', ...options });
    } catch {
      return Promise.resolve();
    }
    this.#running.add(anim);
    return anim.finished
      .catch(() => undefined)
      .then(() => {
        this.#running.delete(anim);
      });
  }

  wait(ms: number): Promise<void> {
    const d = this.duration(ms);
    if (d <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, d);
      // A skip ends pending waits as well.
      const check = setInterval(() => {
        if (this.#skipping) {
          clearTimeout(t);
          clearInterval(check);
          resolve();
        }
      }, 30);
      setTimeout(() => clearInterval(check), d + 10);
    });
  }
}
