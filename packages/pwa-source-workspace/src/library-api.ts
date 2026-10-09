// Compatibility facade: the owner client owns the wire/value implementation.
import { createLibraryApi } from '@eliotr/owner-api-client';
import { legacySourceHttp, legacySourceErrors, legacySourceEpoch } from './owner-client-ports.js';
export type { LibraryPage } from '@eliotr/owner-api-client';
export { LIBRARY_PAGE_SIZE } from '@eliotr/owner-api-client';
const api = createLibraryApi(legacySourceHttp, legacySourceErrors, legacySourceEpoch);
export const { decodeLibraryPage, readLibraryPage } = api;
