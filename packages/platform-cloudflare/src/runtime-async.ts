export type RuntimeDeadlineFailureCode = "ABORTED" | "TIMEOUT";

export interface RuntimeDeadline {
  readonly signal: AbortSignal;
  failureCode(): RuntimeDeadlineFailureCode | undefined;
  dispose(): void;
}

export function createRuntimeDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): RuntimeDeadline {
  const controller = new AbortController();
  let code: RuntimeDeadlineFailureCode | undefined;
  const stop = (nextCode: RuntimeDeadlineFailureCode): void => {
    if (code !== undefined) return;
    code = nextCode;
    controller.abort();
  };
  const onAbort = (): void => stop("ABORTED");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("TIMEOUT"), timeoutMs);

  return {
    signal: controller.signal,
    failureCode: () => code,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export function waitForRuntimeDeadline<T, E extends Error>(
  promise: Promise<T>,
  deadline: RuntimeDeadline,
  createFailure: (code: RuntimeDeadlineFailureCode) => E,
): Promise<T> {
  if (deadline.signal.aborted) {
    return Promise.reject(createFailure(deadline.failureCode() ?? "TIMEOUT"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      deadline.signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = (): void => finish(() => reject(
      createFailure(deadline.failureCode() ?? "TIMEOUT"),
    ));
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    if (deadline.signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function cancelQuietly(
  target: Pick<ReadableStream<Uint8Array>, "cancel"> | null,
): void {
  if (target === null) return;
  try {
    // Source cleanup is asynchronous and may never settle. Start it, but do not
    // make a known rejection wait for it or leak its rejected promise.
    void target.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best effort; retain the primary operation outcome.
  }
}
