import { ApiRequestError } from "./api.js";
import { readOwnerSession } from "./owner-session-api.js";

/** Unavailability says nothing about the outcome of a submitted write. */
export function isResearchConnectionFailure(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.code === "API_UNREACHABLE" ||
    error.code === "API_REQUEST_ABORTED" || error.code === "API_HTTP_UNAVAILABLE" ||
    error.status === 503 || error.status === 504);
}

interface ConnectionHooks {
  generation(): string | undefined;
  healthReady(): boolean;
  changed(): void;
  suspended(): void;
  denied(notice: string): void;
}

/** Current-tab continuity hint, never a credential or an authorization grant.
 * Only a fresh owner session can release suspended input for API operations. */
export function createResearchConnection(hooks: ConnectionHooks) {
  let owner: string | undefined;
  let generation: string | undefined;
  let expires = 0;
  let verified = false;
  let disposed = false;
  let serial = 0;
  let timer: number | undefined;
  let controller: AbortController | undefined;
  let pending: Promise<boolean> | undefined;
  const reachable = () => !disposed && navigator.onLine && hooks.healthReady() &&
    hooks.generation() !== undefined && hooks.generation() !== "unreachable";
  const ready = () => reachable() && verified && generation === hooks.generation() && expires > Date.now();
  const stop = () => {
    serial += 1;
    controller?.abort(); controller = undefined; pending = undefined;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined; verified = false;
  };
  const suspend = () => { stop(); hooks.suspended(); hooks.changed(); };
  const reset = () => { stop(); owner = undefined; generation = undefined; expires = 0; };
  const refresh = (): Promise<boolean> => {
    if (!reachable() || document.visibilityState === "hidden") return Promise.resolve(false);
    if (ready()) return Promise.resolve(true);
    if (pending !== undefined) return pending;
    const expected = hooks.generation();
    if (expected === undefined) return Promise.resolve(false);
    const active = ++serial;
    const local = new AbortController(); controller = local;
    hooks.changed();
    const task = (async () => {
      try {
        const session = await readOwnerSession(expected, local.signal);
        if (active !== serial || disposed || local.signal.aborted) return false;
        if (!reachable() || document.visibilityState === "hidden" || hooks.generation() !== expected) { suspend(); return false; }
        if (session.client_class !== "owner_pwa" || Date.parse(session.expires_at) <= Date.now()) {
          hooks.denied("A current owner session is required. Private Research state was cleared."); return false;
        }
        if (owner !== undefined && (owner !== session.principal_ref || generation !== expected)) {
          window.dispatchEvent(new Event("eliotr:authorization-cleared"));
          hooks.denied("The signed-in owner or deployment changed. Previous Research input was cleared.");
          return false;
        }
        owner = session.principal_ref; generation = expected; expires = Date.parse(session.expires_at); verified = true;
        // Do not leave protected results usable after the verified session expires.
        timer = window.setTimeout(suspend, Math.min(expires - Date.now(), 2_147_483_647));
        return true;
      } catch (error) {
        if (active !== serial || disposed || local.signal.aborted) return false;
        if (isResearchConnectionFailure(error)) suspend();
        else hooks.denied("The owner session could not be verified. Private Research state was cleared; refresh the server check.");
        return false;
      } finally {
        if (controller === local) { controller = undefined; pending = undefined; }
        if (active === serial && !disposed) hooks.changed();
      }
    })();
    pending = task;
    return task;
  };
  return {
    get ready() { return ready(); },
    get hasIdentity() { return owner !== undefined; },
    get checking() { return controller !== undefined; },
    refresh, suspend, reset,
    dispose() { disposed = true; reset(); },
  };
}
