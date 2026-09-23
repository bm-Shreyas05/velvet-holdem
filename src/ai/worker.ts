/**
 * Web Worker entry point. AI decisions run here so the interface never freezes. The worker only
 * ever receives a DecisionRequest — the deciding player's own view plus public statistics — so
 * hidden cards are not merely unused, they are physically absent from this thread.
 */
import { type DecisionRequest, decide } from './decide.ts';

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent) => {
  const { id, request } = event.data as { id: number; request: DecisionRequest };
  try {
    scope.postMessage({ id, ok: true, decision: decide(request) });
  } catch (error) {
    scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
