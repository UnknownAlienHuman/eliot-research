import type { EvidenceAuthorityPort } from "./types.js";
import {
  authorizeScopeAuthority,
  loadEvidenceHandle,
  loadScopeAuthority,
  loadSourceAuthority,
  resolveCandidateAuthority,
} from "./authority-load.js";
import {
  invalidateEvidenceHandle,
  persistEvidenceResolution,
} from "./registry.js";
import { persistCitationResolutionReceipt } from "./citation-registry.js";

export interface D1EvidenceAuthorityDependencies {
  readonly core_database: D1Database;
  readonly search_database: D1Database;
  readonly now?: () => number;
}

export function createD1EvidenceAuthorityPort(
  dependencies: D1EvidenceAuthorityDependencies,
): EvidenceAuthorityPort {
  const now = dependencies.now ?? Date.now;
  return {
    loadScope: (ref) => loadScopeAuthority(dependencies.core_database, ref),
    authorizeScope: (scope, access) => {
      const observed = now();
      if (!Number.isSafeInteger(observed) || observed < 0) {
        throw new RangeError("evidence authority clock is invalid");
      }
      return authorizeScopeAuthority(dependencies.core_database, scope, access, observed);
    },
    loadSource: (sourceRevisionRef) => {
      const observed = now();
      if (!Number.isSafeInteger(observed) || observed < 0) {
        throw new RangeError("evidence authority clock is invalid");
      }
      return loadSourceAuthority(dependencies.core_database, sourceRevisionRef, observed);
    },
    resolveCandidate: (candidate) => resolveCandidateAuthority(
      dependencies.search_database,
      candidate,
    ),
    loadHandle: (ref) => loadEvidenceHandle(dependencies.core_database, ref),
    persistResolution: (input) => persistEvidenceResolution(dependencies.core_database, input),
    persistCitationReceipt: (input) => persistCitationResolutionReceipt(
      dependencies.core_database,
      input,
    ),
    invalidateHandle: (handle, state, reasonCode, observedAt) => invalidateEvidenceHandle(
      dependencies.core_database,
      handle,
      state,
      reasonCode,
      observedAt,
    ),
  };
}
