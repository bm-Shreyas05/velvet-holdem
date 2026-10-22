import type { Settings } from '../game/settings.ts';
import { parseSoundBank } from './samples.ts';

/**
 * Sound with the Web Audio API. Cards and chips use real recordings (src/audio/samples.ts), picked
 * from several takes and varied in pitch and level so repeated actions never sound identical;
 * everything else — and every sound until the recordings arrive, or if they cannot be loaded — is
 * synthesised on the fly. Four buses (master, effects, interface, ambience) map to the volume
 * controls. If audio is unavailable or blocked the engine silently becomes a no-op; the game never
 * depends on it.
 */
export type SoundName =
  | 'shuffle'
  | 'deal'
  | 'flip'
  | 'chips'
  | 'chipsBig'
  | 'collect'
  | 'check'
  | 'fold'
  | 'allIn'
  | 'win'
  | 'winBig'
  | 'lose'
  | 'eliminated'
  | 'yourTurn'
  | 'click'
  | 'levelUp';

type Category = 'effects' | 'interface';

const CATEGORY: Record<SoundName, Category> = {
  shuffle: 'effects',
  deal: 'effects',
  flip: 'effects',
  chips: 'effects',
  chipsBig: 'effects',
  collect: 'effects',
  check: 'effects',
  fold: 'effects',
  allIn: 'effects',
  win: 'effects',
  winBig: 'effects',
  lose: 'effects',
  eliminated: 'effects',
  yourTurn: 'interface',
  click: 'interface',
  levelUp: 'interface',
};

type AudioContextCtor = typeof AudioContext;

export class AudioEngine {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #buses: Partial<Record<Category | 'ambience', GainNode>> = {};
  #noise: AudioBuffer | null = null;
  #brown: AudioBuffer | null = null;
  #settings: Settings['audio'];
  #failed = false;
  #ambienceNodes: AudioNode[] = [];
  #ambienceTimer: ReturnType<typeof setTimeout> | null = null;
  #last = new Map<SoundName, number>();
  #bank = new Map<string, AudioBuffer[]>();
  #bankRequested = false;
  readonly #bankUrl: string | null;

  /** `bankUrl`: where the recordings live (null = synthesise everything). */
  constructor(settings: Settings['audio'], bankUrl: string | null = null) {
    this.#settings = { ...settings };
    this.#bankUrl = bankUrl;
  }

  get available(): boolean {
    return !this.#failed;
  }

  /** True once the recorded sounds are loaded and in use. */
  get recorded(): boolean {
    return this.#bank.size > 0;
  }

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock(): void {
    if (this.#failed) return;
    try {
      if (!this.#ctx) {
        const Ctor = (globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) as
          | AudioContextCtor
          | undefined;
        if (!Ctor) {
          this.#failed = true;
          return;
        }
        const ctx = new Ctor();
        this.#ctx = ctx;
        this.#master = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 4;
        this.#master.connect(comp).connect(ctx.destination);
        for (const name of ['effects', 'interface', 'ambience'] as const) {
          const g = ctx.createGain();
          g.connect(this.#master);
          this.#buses[name] = g;
        }
        this.#noise = this.#makeNoise(1.2, 'white');
        this.#brown = this.#makeNoise(4, 'brown');
        this.#applyGains();
        this.#syncAmbience();
        void this.#loadBank();
      }
      // iOS also reports 'interrupted' after calls or backgrounding; any non-running state resumes.
      if (this.#ctx.state !== 'running' && this.#ctx.state !== 'closed') void this.#ctx.resume();
    } catch {
      this.#failed = true;
    }
  }

  apply(settings: Settings['audio']): void {
    this.#settings = { ...settings };
    this.#applyGains();
    this.#syncAmbience();
  }

  #applyGains(): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#master) return;
    const t = ctx.currentTime;
    const s = this.#settings;
    this.#master.gain.setTargetAtTime(s.muted ? 0 : s.master, t, 0.03);
    this.#buses.effects?.gain.setTargetAtTime(s.effects, t, 0.03);
    this.#buses.interface?.gain.setTargetAtTime(s.interface, t, 0.03);
    this.#buses.ambience?.gain.setTargetAtTime(s.ambience * 0.35, t, 0.3);
  }

  #makeNoise(seconds: number, color: 'white' | 'brown'): AudioBuffer {
    const ctx = this.#ctx!;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      if (color === 'white') data[i] = white;
      else {
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      }
    }
    return buf;
  }

  async #loadBank(): Promise<void> {
    if (this.#bankRequested || !this.#bankUrl) return;
    this.#bankRequested = true;
    try {
      const response = await fetch(this.#bankUrl);
      if (!response.ok) return;
      const bank = parseSoundBank(await response.arrayBuffer());
      const ctx = this.#ctx;
      if (!bank || !ctx) return;
      for (const [name, clips] of Object.entries(bank.clips)) {
        this.#bank.set(
          name,
          clips.map((data) => {
            const buf = ctx.createBuffer(1, data.length, bank.rate);
            buf.getChannelData(0).set(data);
            return buf;
          }),
        );
      }
    } catch {
      /* offline without a cached copy, or opened from a file: keep synthesising */
    }
  }

  /** Plays a random take of a recording; false if it is not loaded (the caller synthesises instead). */
  #sample(bus: GainNode, name: string, at: number, gain: number, lowpass?: number): boolean {
    const takes = this.#bank.get(name);
    if (!takes?.length) return false;
    const ctx = this.#ctx!;
    const src = ctx.createBufferSource();
    src.buffer = takes[Math.floor(Math.random() * takes.length)]!;
    src.playbackRate.value = this.#vary(1, 0.05);
    const g = ctx.createGain();
    g.gain.value = this.#vary(gain, 0.12);
    let node: AudioNode = src;
    if (lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      node = node.connect(f);
    }
    node.connect(g).connect(bus);
    src.start(at);
    return true;
  }

  #vary(x: number, amount = 0.08): number {
    return x * (1 + (Math.random() * 2 - 1) * amount);
  }

  #noiseBurst(bus: GainNode, at: number, dur: number, filter: BiquadFilterType, freq: number, q: number, gain: number, sweepTo?: number): void {
    const ctx = this.#ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, at);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, at + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(bus);
    src.start(at, Math.random() * 0.5, dur + 0.05);
  }

  #tone(bus: GainNode, at: number, freq: number, dur: number, gain: number, type: OscillatorType = 'sine', slideTo?: number): void {
    const ctx = this.#ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(bus);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  #chipClicks(bus: GainNode, at: number, count: number, spread: number, gain: number): void {
    let t = at;
    for (let i = 0; i < count; i++) {
      const f = this.#vary(2900, 0.25);
      this.#tone(bus, t, f, this.#vary(0.035, 0.3), gain * this.#vary(0.7, 0.3), 'triangle');
      this.#tone(bus, t, f * 1.49, 0.02, gain * 0.25, 'sine');
      this.#noiseBurst(bus, t, 0.02, 'bandpass', this.#vary(5200, 0.2), 1.2, gain * 0.5);
      t += this.#vary(spread, 0.45);
    }
  }

  play(name: SoundName, intensity = 1): void {
    const ctx = this.#ctx;
    if (!ctx || this.#failed || this.#settings.muted || ctx.state !== 'running') return;
    // Don't stack identical sounds that fire in the same instant (e.g. several chips at once).
    const now = performance.now();
    const minGap = name === 'deal' ? 35 : 25;
    if (now - (this.#last.get(name) ?? 0) < minGap) return;
    this.#last.set(name, now);
    const bus = this.#buses[CATEGORY[name]]!;
    const t = ctx.currentTime + 0.005;
    try {
      switch (name) {
        case 'shuffle':
          if (this.#sample(bus, 'shuffle', t, 0.55)) break;
          for (let i = 0; i < 22; i++) this.#noiseBurst(bus, t + i * this.#vary(0.018, 0.3), 0.03, 'highpass', this.#vary(2600), 0.7, 0.18);
          this.#noiseBurst(bus, t + 0.42, 0.12, 'bandpass', 1400, 0.8, 0.22);
          break;
        case 'deal':
          if (this.#sample(bus, 'deal', t, 0.5)) break;
          this.#noiseBurst(bus, t, this.#vary(0.06), 'bandpass', this.#vary(3000, 0.18), 0.9, 0.35);
          this.#tone(bus, t + 0.035, this.#vary(190), 0.05, 0.12);
          break;
        case 'flip':
          if (this.#sample(bus, 'flip', t, 0.5)) break;
          this.#noiseBurst(bus, t, 0.035, 'highpass', this.#vary(3200), 0.6, 0.3);
          this.#noiseBurst(bus, t + this.#vary(0.045), 0.03, 'bandpass', this.#vary(2100), 1, 0.2);
          break;
        case 'chips':
          if (this.#sample(bus, intensity < 2 ? 'chipLay' : 'chipStack', t, 0.5)) break;
          this.#chipClicks(bus, t, Math.round(2 + Math.min(4, intensity * 2)), 0.035, 0.22);
          break;
        case 'chipsBig':
          if (this.#sample(bus, 'handle', t, 0.5)) {
            this.#sample(bus, 'chipStack', t + this.#vary(0.12, 0.2), 0.4);
            break;
          }
          this.#chipClicks(bus, t, 9, 0.03, 0.22);
          break;
        case 'collect':
          if (this.#sample(bus, 'collide', t, 0.45)) {
            this.#sample(bus, 'collide', t + this.#vary(0.07, 0.3), 0.35);
            break;
          }
          this.#chipClicks(bus, t, 6, 0.022, 0.16);
          this.#noiseBurst(bus, t, 0.18, 'bandpass', 900, 0.8, 0.07);
          break;
        case 'check':
          for (const dt of [0, this.#vary(0.1, 0.1)]) {
            this.#noiseBurst(bus, t + dt, 0.07, 'lowpass', 260, 0.7, 0.55);
            this.#tone(bus, t + dt, this.#vary(105, 0.05), 0.08, 0.3);
          }
          break;
        case 'fold':
          if (this.#sample(bus, 'fold', t, 0.4)) break;
          this.#noiseBurst(bus, t, 0.22, 'bandpass', this.#vary(2200), 0.9, 0.2, 500);
          break;
        case 'allIn':
          if (!this.#sample(bus, 'riffle', t, 0.55)) this.#chipClicks(bus, t, 12, 0.026, 0.24);
          this.#tone(bus, t, 72, 0.5, 0.35, 'sine', 52);
          break;
        case 'win':
          [523.25, 659.25, 783.99].forEach((f, i) => {
            this.#tone(bus, t + i * 0.09, f, 0.5, 0.12, 'sine');
            this.#tone(bus, t + i * 0.09, f * 2, 0.3, 0.03, 'triangle');
          });
          break;
        case 'winBig':
          [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
            this.#tone(bus, t + i * 0.1, f, 0.9, 0.13, 'sine');
            this.#tone(bus, t + i * 0.1, f * 1.5, 0.5, 0.03, 'triangle');
          });
          if (!this.#sample(bus, 'handle', t + 0.35, 0.4)) this.#chipClicks(bus, t + 0.35, 10, 0.03, 0.18);
          break;
        case 'lose':
          this.#tone(bus, t, 392, 0.35, 0.08);
          this.#tone(bus, t + 0.16, 311.1, 0.5, 0.08);
          break;
        case 'eliminated':
          this.#tone(bus, t, 330, 0.5, 0.1);
          this.#tone(bus, t + 0.22, 262, 0.6, 0.1);
          this.#tone(bus, t + 0.44, 196, 0.9, 0.1);
          break;
        case 'yourTurn':
          this.#tone(bus, t, 880, 0.55, 0.12);
          this.#tone(bus, t, 1320, 0.35, 0.04);
          this.#tone(bus, t + 0.12, 1174.7, 0.6, 0.1);
          break;
        case 'click':
          this.#tone(bus, t, this.#vary(1500, 0.05), 0.03, 0.08, 'triangle');
          break;
        case 'levelUp':
          this.#tone(bus, t, 659.25, 0.4, 0.1);
          this.#tone(bus, t + 0.14, 987.8, 0.6, 0.1);
          break;
      }
    } catch {
      /* a single failed sound must never interrupt the game */
    }
  }

  // ---- Ambience: a quiet room tone with the occasional distant chip riffle -------------------

  #syncAmbience(): void {
    const want = !!this.#ctx && !this.#settings.muted && this.#settings.ambience > 0;
    if (want && !this.#ambienceNodes.length) this.#startAmbience();
    if (!want && this.#ambienceNodes.length) this.#stopAmbience();
  }

  #startAmbience(): void {
    const ctx = this.#ctx!;
    const bus = this.#buses.ambience!;
    try {
      const src = ctx.createBufferSource();
      src.buffer = this.#brown;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.15;
      lfo.connect(lfoGain).connect(g.gain);
      src.connect(lp).connect(g).connect(bus);
      src.start();
      lfo.start();
      this.#ambienceNodes = [src, lfo];
      const riffle = () => {
        if (!this.#ambienceNodes.length || !this.#ctx) return;
        if (this.#ctx.state === 'running') {
          const at = this.#ctx.currentTime + 0.01;
          // A distant table: the recording, muffled and quiet, when it is loaded.
          if (!this.#sample(bus, Math.random() < 0.5 ? 'handle' : 'collide', at, 0.12, 1800))
            this.#chipClicks(bus, at, 4 + Math.floor(Math.random() * 5), 0.03, 0.05);
        }
        this.#ambienceTimer = setTimeout(riffle, 7000 + Math.random() * 9000);
      };
      this.#ambienceTimer = setTimeout(riffle, 5000);
    } catch {
      this.#ambienceNodes = [];
    }
  }

  #stopAmbience(): void {
    for (const n of this.#ambienceNodes) {
      try {
        (n as AudioScheduledSourceNode).stop();
      } catch {
        /* already stopped */
      }
    }
    this.#ambienceNodes = [];
    if (this.#ambienceTimer) clearTimeout(this.#ambienceTimer);
    this.#ambienceTimer = null;
  }
}
