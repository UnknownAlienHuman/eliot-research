/** Browser-only authorization-cleared binding for the legacy seam.
 *
 * The adapter must never reach for a global `window` or a module-level event name. Binding happens
 * here, explicitly, against a caller-provided EventTarget and a caller-provided event factory, so a
 * DOM-free host can run the same code path with no ambient acquisition.
 */

import type { AuthorizationLoss } from '../transport/client';
import type { SessionEpoch } from '../transport/session/epoch';

export interface AuthorizationClearedDispatch {
  readonly epoch: SessionEpoch;
  dispatch(observation: AuthorizationLoss): void;
}

export interface AuthorizationClearedPort {
  readonly epoch: SessionEpoch;
  readonly target: EventTarget;
  readonly createEvent: () => Event;
}

/**
 * Emits at most once per current epoch. A `WeakSet` keyed by the live epoch stamp means an advance
 * starts a fresh emitter identity, while an observation from an old, closed or advanced epoch is
 * dropped without touching the new session. The epoch is never advanced, closed or disposed here.
 */
export function bindAuthorizationCleared(ports: AuthorizationClearedPort): AuthorizationClearedDispatch {
  const emitted = new WeakSet<object>();
  return {
    epoch: ports.epoch,
    dispatch(observation: AuthorizationLoss) {
      if (!ports.epoch.isCurrent(observation.epoch) || !observation.current) return;
      if (observation.epoch === null || typeof observation.epoch !== 'object') return;
      if (emitted.has(observation.epoch)) return;
      emitted.add(observation.epoch);
      ports.target.dispatchEvent(ports.createEvent());
    },
  };
}
