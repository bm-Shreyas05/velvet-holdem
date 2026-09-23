import type { LegalActions, PlayerAction } from '../engine/types.ts';
import { type Decision, type DecisionRequest, decide, safeFallbackAction } from './decide.ts';

/**
 * Runs AI decisions off the main thread when a worker is available, inline otherwise (tests,
 * simulations, or browsers that refuse worker creation). A failing or slow worker is replaced by
 * inline computation so the game can never stall on an AI turn.
 */
export interface AiHost {
  decide(request: DecisionRequest): Promise<Decision>;
  readonly mode: 'worker' | 'inline';
  dispose(): void;
}

const WORKER_TIMEOUT_MS = 8000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class InlineAiHost implements AiHost {
  readonly mode = 'inline' as const;
  async decide(request: DecisionRequest): Promise<Decision> {
    await yieldToEventLoop(); // let the UI paint the "thinking" state first
    return decide(request);
  }
  dispose(): void {}
}

export class WorkerAiHost implements AiHost {
  #worker: Worker | null;
  #nextId = 1;
  #pending = new Map<number, { resolve: (d: Decision) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #fallback = new InlineAiHost();
  #failures = 0;
  onError: ((message: string) => void) | null = null;

  constructor(createWorker: () => Worker) {
    this.#worker = createWorker();
    this.#worker.onmessage = (event: MessageEvent) => {
      const { id, ok, decision, error } = event.data as { id: number; ok: boolean; decision?: Decision; error?: string };
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (ok && decision) pending.resolve(decision);
      else pending.reject(new Error(error ?? 'AI worker error'));
    };
    this.#worker.onerror = (event: ErrorEvent) => {
      event.preventDefault?.();
      this.#retire(`AI worker crashed: ${event.message}`);
    };
  }

  get mode(): 'worker' | 'inline' {
    return this.#worker ? 'worker' : 'inline';
  }

  #retire(reason: string): void {
    this.onError?.(reason);
    this.#worker?.terminate();
    this.#worker = null;
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.#pending.clear();
  }

  async decide(request: DecisionRequest): Promise<Decision> {
    if (!this.#worker) return this.#fallback.decide(request);
    const worker = this.#worker;
    const id = this.#nextId++;
    try {
      return await new Promise<Decision>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error('AI worker timed out'));
        }, WORKER_TIMEOUT_MS);
        this.#pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, request });
      });
    } catch (error) {
      this.#failures++;
      if (this.#failures >= 2) this.#retire(error instanceof Error ? error.message : String(error));
      return this.#fallback.decide(request);
    }
  }

  dispose(): void {
    this.#worker?.terminate();
    this.#worker = null;
  }
}

/** Guarantees a legal action even if the decision contains something unexpected. */
export function sanitizeDecision(action: PlayerAction, legal: LegalActions): PlayerAction {
  switch (action.kind) {
    case 'fold':
      return legal.canFold ? action : safeFallbackAction(legal);
    case 'check':
      return legal.canCheck ? action : safeFallbackAction(legal);
    case 'call':
      return legal.canCall ? action : safeFallbackAction(legal);
    case 'bet':
    case 'raise': {
      if (legal.aggression !== action.kind || typeof action.to !== 'number') return legal.canCall ? { kind: 'call' } : safeFallbackAction(legal);
      const to = Math.round(action.to);
      if (to >= legal.maxTo) return { kind: action.kind, to: legal.maxTo };
      if (to < legal.fullRaiseTo) return { kind: action.kind, to: Math.min(legal.fullRaiseTo, legal.maxTo) };
      return { kind: action.kind, to };
    }
    default:
      return safeFallbackAction(legal);
  }
}
