// Compatibility facade: the owner client owns the wire/value implementation.
import { createRevisionApi } from '@eliotr/owner-api-client';
import { legacySourceHttp, legacySourceErrors, legacySourceEpoch } from './owner-client-ports.js';
export type { SourceRevisionPage } from '@eliotr/owner-api-client';
export { REVISION_PAGE_SIZE } from '@eliotr/owner-api-client';
const api = createRevisionApi(legacySourceHttp, legacySourceErrors, legacySourceEpoch);
export const { decodeSourceRevisions, readSourceRevisionsPage } = api;
