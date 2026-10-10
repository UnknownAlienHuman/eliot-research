/**
 * Injected capabilities the studio factories need beyond the accepted HTTP seam.
 *
 * The seam in `../../legacy/http` owns transport, path policy, protected headers, deadlines and
 * authorization observation. It does not own payload hashing, so the digest is injected here and no
 * feature module reaches for a global `crypto` implementation.
 */

import type { ManifestApi } from '../evidence/report/manifest';

export interface StudioCollaborators {
  /** Lowercase hex SHA-256 of the supplied bytes. */
  readonly digestBytes: (bytes: Uint8Array) => Promise<string>;
  /**
   * The series author read and the independently authorized re-read. Injected, not reimplemented:
   * C3-EM owns the manifest wire decoder in evidence/report/manifest.ts, and studio consumes it
   * rather than copying that decoder.
   */
  readonly manifest: ManifestApi;
}


/** A manifest reader that satisfies the interface and refuses every call, so a test that never opens an
 * artifact still compiles against the real contract. */
export function unavailableManifest(): ManifestApi {
  const fail = (): never => {
    throw new Error('manifest read is not available in this scenario');
  };
  return {
    readResearchArtifact: () => fail(),
    readReauthorizedResearchArtifact: () => fail(),
  };
}

export type { LegacyErrorDetails, LegacyErrorFactory } from '../legacy/http';
