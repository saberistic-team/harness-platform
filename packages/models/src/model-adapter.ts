import {
  type Model,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "./model";

/**
 * Compatibility adapter from the original one-shot Model API to the minimal
 * kernel's streaming boundary.
 *
 * A completion model cannot expose genuine provider text deltas. A successful
 * call emits its complete tool intentions, followed by one terminal event.
 * Errors propagate and no terminal event is fabricated after cancellation.
 */
export class CompleteModelAdapter implements ModelAdapter {
  constructor(readonly model: Model) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    request.signal?.throwIfAborted();
    const response = await waitForCompletion(
      this.model.complete(request),
      request.signal,
    );
    request.signal?.throwIfAborted();
    for (const call of response.toolCalls) {
      request.signal?.throwIfAborted();
      yield { type: "tool.call", call };
    }
    request.signal?.throwIfAborted();
    yield { type: "response.completed", response };
  }
}

function isModelAdapter(model: Model | ModelAdapter): model is ModelAdapter {
  return "stream" in model && typeof model.stream === "function";
}

/** Preserve native streams and adapt only legacy completion-based models. */
export function adaptModel(model: Model | ModelAdapter): ModelAdapter {
  return isModelAdapter(model) ? model : new CompleteModelAdapter(model);
}

function waitForCompletion<T>(
  completion: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return completion;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    completion.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
