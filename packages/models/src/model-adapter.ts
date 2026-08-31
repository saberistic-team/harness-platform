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
 * A completion model cannot expose genuine provider deltas, so a successful
 * call emits exactly one terminal event. Errors are allowed to propagate and
 * no terminal event is fabricated after cancellation.
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
    yield { type: "response.completed", response };
  }
}

/** Adapt an existing completion-based model without changing the model. */
export function adaptModel(model: Model): ModelAdapter {
  return new CompleteModelAdapter(model);
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
