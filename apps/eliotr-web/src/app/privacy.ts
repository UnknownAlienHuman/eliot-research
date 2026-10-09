export interface SessionVerification {
  readonly principal: string;
  readonly session: string;
  readonly credentialGeneration: string;
  readonly deploymentGeneration: string;
}
export interface SessionContext extends SessionVerification { readonly cacheEpoch: number }
export type PrivacySnapshot =
  | { readonly phase: "verifying"; readonly revision: number }
  | { readonly phase: "unavailable"; readonly revision: number }
  | { readonly phase: "available"; readonly revision: number; readonly context: SessionContext };
export interface PrivacyPorts {
  readonly mask: () => void;
  readonly reveal: () => void;
  readonly cancelReads: () => void;
  readonly clearProtected: () => void;
  readonly verify: (signal: AbortSignal) => Promise<SessionVerification | undefined>;
}

/** Created once at the composition root, outside React's StrictMode lifetime. */
export function createPrivacyController(ports: PrivacyPorts) {
  let revision = 0;
  let disposed = false;
  let attempt: AbortController | undefined;
  let snapshot: PrivacySnapshot = Object.freeze({ phase: "verifying", revision });
  const subscribers = new Set<() => void>();
  ports.mask();
  function publish(next: PrivacySnapshot) {
    snapshot = Object.freeze(next);
    for (const subscriber of subscribers) subscriber();
  }
  function invalidate() {
    // This order is security relevant: close visibility before any observable cleanup.
    ports.mask();
    revision += 1;
    const previous = attempt;
    attempt = undefined;
    publish({ phase: "verifying", revision });
    previous?.abort();
    ports.cancelReads();
    ports.clearProtected();
  }
  async function refresh() {
    if (disposed) return;
    invalidate();
    const current = new AbortController();
    attempt = current;
    const currentRevision = revision;
    let verified: SessionVerification | undefined;
    try { verified = await ports.verify(current.signal); }
    catch { verified = undefined; }
    if (disposed || current.signal.aborted || current !== attempt || currentRevision !== revision) return;
    attempt = undefined;
    if (verified && [verified.principal, verified.session, verified.credentialGeneration, verified.deploymentGeneration]
      .every(value => typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value))) {
      const context = Object.freeze({ ...verified, cacheEpoch: currentRevision });
      publish({ phase: "available", revision, context });
    } else publish({ phase: "unavailable", revision });
    // Verification does not reveal the old tree. Only the new React commit may do that.
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    refresh,
    close() { if (!disposed) invalidate(); },
    isCurrent(context: SessionContext) { return !disposed && snapshot.phase === "available" && snapshot.context === context; },
    commitVisible(rendered: PrivacySnapshot) {
      if (disposed || rendered !== snapshot || rendered.phase === "verifying") return false;
      ports.reveal();
      return true;
    },
    dispose() { if (!disposed) { disposed = true; invalidate(); subscribers.clear(); } },
  };
}
export type PrivacyController = ReturnType<typeof createPrivacyController>;

export function bindPrivacyLifecycle(controller: PrivacyController, target: EventTarget) {
  const hide = () => controller.close();
  const show = (event: Event) => { if ((event as PageTransitionEvent).persisted) void controller.refresh(); };
  const events = ["pagehide", "eliotr:authorization-cleared"];
  for (const name of events) target.addEventListener(name, hide);
  target.addEventListener("pageshow", show);
  return () => {
    for (const name of events) target.removeEventListener(name, hide);
    target.removeEventListener("pageshow", show);
  };
}
