import { createSessionEpoch, type LegacyErrorFactory } from '@eliotr/owner-api-client';
import { ApiRequestError, requestApi, requestApiWithStatuses } from './api.js';

// The legacy composition owns this epoch; importing this module binds no browser listener.
export const legacySourceEpoch = createSessionEpoch();
export const legacySourceHttp = { requestApi, requestApiWithStatuses };
export const legacySourceErrors: LegacyErrorFactory = details => new ApiRequestError(details);

/** Bind explicitly from the served application's lifecycle root. */
export function bindSourceWorkspaceClientLifecycle(target: EventTarget, healthTarget: EventTarget): () => void {
  const advance = () => { legacySourceEpoch.advance(); };
  const close = () => { legacySourceEpoch.close(); };
  target.addEventListener('eliotr:authorization-cleared', advance);
  target.addEventListener('pagehide', close);
  healthTarget.addEventListener('eliotr:health-lost', advance);
  return () => {
    target.removeEventListener('eliotr:authorization-cleared', advance);
    target.removeEventListener('pagehide', close);
    healthTarget.removeEventListener('eliotr:health-lost', advance);
  };
}
