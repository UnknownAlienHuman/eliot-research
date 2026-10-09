// Compatibility facade: the owner client owns the wire/value implementation.
import { createReadinessApi } from '@eliotr/owner-api-client';
import { legacySourceHttp, legacySourceErrors, legacySourceEpoch } from './owner-client-ports.js';
export type { LibraryReadinessView, LibrarySelectionContext } from '@eliotr/owner-api-client';
const api = createReadinessApi(legacySourceHttp, legacySourceErrors, legacySourceEpoch);
export const { decodeLibraryReadiness, readLibraryReadiness } = api;
