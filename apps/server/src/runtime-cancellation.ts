import { RunCancelledError } from "./errors.js";

/** Fail with the canonical runtime cancellation before crossing a process boundary. */
export function throwIfRuntimeCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RunCancelledError();
}

/**
 * Registers a synchronous cancellation hook and handles an already-aborted
 * signal. The returned cleanup must be called when the local run settles.
 */
export function onRuntimeCancellation(
  signal: AbortSignal | undefined,
  cancel: () => void,
): () => void {
  if (!signal) return () => undefined;
  let handled = false;
  const handle = (): void => {
    if (handled) return;
    handled = true;
    cancel();
  };
  if (signal.aborted) handle();
  else signal.addEventListener("abort", handle, { once: true });
  return () => signal.removeEventListener("abort", handle);
}
