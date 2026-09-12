import type { LocatorCandidate, ScopeSnapshot } from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  EvidenceRuntimeError,
  type CandidateAnchorAuthority,
  type EvidenceAuthorityPort,
  type EvidenceContentPort,
  type EvidenceSourceAuthority,
  type NavigationReadAuthority,
  type ScopeAuthorization,
  type MaterializedEvidenceExcerpt,
} from "@eliotr/cloudflare-evidence";
import type { RetrievalRequest } from "@eliotr/retrieval";

/** Compatible with the projection adapter's read-only exact verifier seam. */
export type ExactPhraseVerifier = (
  candidate: LocatorCandidate,
  request: Readonly<RetrievalRequest>,
  probe: string,
) => Promise<boolean>;

export interface ExactPhraseVerifierDependencies {
  /** Frozen scope authority; no caller-supplied currentness flag is accepted. */
  readonly navigation: Pick<NavigationReadAuthority, "scope" | "current" | "sources">;
  /** Anchor-only authority. Persistence methods are deliberately not injected. */
  readonly authority: Pick<EvidenceAuthorityPort, "resolveCandidate">;
  /** Bounded, integrity-checked evidence read; direct R2 access is prohibited here. */
  readonly content: Pick<EvidenceContentPort, "materialize">;
  /** Checks budget and cancellation before and after every awaited read. */
  readonly checkBudget: () => void;
}

interface ExactReadIdentity {
  readonly candidate: LocatorCandidate;
  readonly requestedScope: ScopeSnapshot;
  readonly requestedScopeCanonical: string;
  readonly navigationScopeCanonical: string;
  readonly sourceRevisionRef: string;
  readonly expectedOwnerGeneration: string;
  readonly indexGeneration: string;
  readonly metadataItemKey: string | number | boolean | undefined;
  readonly metadataContentSha256: string | number | boolean | undefined;
}

function fail(
  code: ConstructorParameters<typeof EvidenceRuntimeError>[0],
  message: string,
): never {
  throw new EvidenceRuntimeError(code, message);
}

/** Run one awaited authority/content read with a budget/cancellation fence on both sides. */
async function checkedRead<T>(checkBudget: () => void, read: () => Promise<T>): Promise<T> {
  checkBudget();
  let value: T;
  try {
    value = await read();
  } catch (error) {
    // Preserve the authority/content error while still checking cancellation
    // and budget after a rejected read.
    try { checkBudget(); } catch { /* preserve the original read error */ }
    throw error;
  }
  checkBudget();
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
  return value;
}

function immutableClone<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalEvidenceJson(value)) as T);
}

function captureReadIdentity(
  candidate: LocatorCandidate,
  request: Readonly<RetrievalRequest>,
  navigation: Pick<NavigationReadAuthority, "scope">,
): ExactReadIdentity {
  const requestedScope = immutableClone(request.scope_snapshot);
  const candidateSnapshot = immutableClone(candidate);
  const requestedScopeCanonical = canonicalEvidenceJson(requestedScope);
  const navigationScopeCanonical = canonicalEvidenceJson(navigation.scope);
  if (requestedScopeCanonical !== navigationScopeCanonical) {
    fail("EVIDENCE_SCOPE_MISMATCH", "exact verifier request is bound to a different frozen scope");
  }
  const sourceRevisionRef = candidateSnapshot.source_revision_ref;
  if (!requestedScope.member_source_revision_refs.includes(sourceRevisionRef)) {
    fail("EVIDENCE_SCOPE_MISMATCH", "exact candidate source is outside the frozen scope");
  }
  const expectedOwner = requestedScope.source_owner_generations[sourceRevisionRef];
  if (typeof expectedOwner !== "string" || expectedOwner.length === 0) {
    fail("EVIDENCE_OWNER_GENERATION_MISMATCH", "frozen scope omits the candidate source owner generation");
  }
  return Object.freeze({
    candidate: candidateSnapshot,
    requestedScope,
    requestedScopeCanonical,
    navigationScopeCanonical,
    sourceRevisionRef,
    expectedOwnerGeneration: expectedOwner,
    indexGeneration: candidateSnapshot.index_generation,
    metadataItemKey: candidateSnapshot.metadata.item_key,
    metadataContentSha256: candidateSnapshot.metadata.content_sha256,
  });
}

function oneSource(sources: readonly EvidenceSourceAuthority[]): EvidenceSourceAuthority {
  if (sources.length !== 1) fail("EVIDENCE_SOURCE_NOT_FOUND", "exact candidate did not resolve to one source authority");
  const source = sources[0];
  if (source === undefined) fail("EVIDENCE_SOURCE_NOT_FOUND", "exact candidate source authority is missing");
  if (source.purge_state !== "LIVE") fail("EVIDENCE_SOURCE_NOT_LIVE", "exact candidate source is not live");
  return source;
}

function requireSourceBinding(
  source: EvidenceSourceAuthority,
  identity: ExactReadIdentity,
): void {
  if (
    source.source_revision_ref !== identity.sourceRevisionRef ||
    source.source_owner_generation !== identity.expectedOwnerGeneration ||
    !identity.requestedScope.member_source_revision_refs.includes(source.source_revision_ref)
  ) {
    fail("EVIDENCE_OWNER_GENERATION_MISMATCH", "source authority does not match the frozen exact candidate binding");
  }
  const metadataDigest = identity.metadataContentSha256;
  if (metadataDigest !== undefined && metadataDigest !== source.content_sha256) {
    fail("EVIDENCE_IDENTITY_CONFLICT", "candidate content digest differs from source authority");
  }
}

function requireAnchorBinding(
  anchor: CandidateAnchorAuthority,
  source: EvidenceSourceAuthority,
  identity: ExactReadIdentity,
): void {
  if (
    anchor.content_sha256 !== source.content_sha256 ||
    anchor.projection_generation !== identity.indexGeneration
  ) {
    fail("EVIDENCE_IDENTITY_CONFLICT", "candidate anchor does not match source or projection authority");
  }
  const metadataItem = identity.metadataItemKey;
  if (metadataItem !== undefined && metadataItem !== anchor.item_key) {
    fail("EVIDENCE_IDENTITY_CONFLICT", "candidate item key differs from anchor authority");
  }
}

function requireMaterializedBinding(
  materialized: MaterializedEvidenceExcerpt,
  source: EvidenceSourceAuthority,
): void {
  if (materialized.source_object_sha256 !== source.content_sha256) {
    fail("EVIDENCE_OBJECT_INTEGRITY", "materialized evidence bytes differ from source authority");
  }
  if (typeof materialized.exact_excerpt !== "string") {
    fail("EVIDENCE_INPUT_INVALID", "materialized exact excerpt is not text");
  }
}

/**
 * Build the exact phrase verifier used by D1 EXACT candidate enumeration.
 *
 * This performs only readback: navigation currentness, source authority,
 * candidate anchor authority, and bounded evidence materialization. It never
 * invokes handle persistence. The final check is a literal JavaScript string
 * substring operation over the canonical pinned excerpt; no normalization,
 * case folding, stemming, punctuation rewrite, or regex is applied.
 */
export function createExactPhraseVerifier(
  dependencies: ExactPhraseVerifierDependencies,
): ExactPhraseVerifier {
  return async (
    candidate: LocatorCandidate,
    request: Readonly<RetrievalRequest>,
    probe: string,
  ): Promise<boolean> => {
    if (probe.length === 0) fail("EVIDENCE_INPUT_INVALID", "exact probe must not be empty");
    const identity = captureReadIdentity(candidate, request, dependencies.navigation);
    const beforeGrant: ScopeAuthorization = await checkedRead(
      dependencies.checkBudget,
      () => dependencies.navigation.current(identity.requestedScope),
    );
    const beforeGrantSnapshot = immutableClone(beforeGrant);
    const beforeGrantCanonical = canonicalEvidenceJson(beforeGrantSnapshot);
    const beforeSource = oneSource(await checkedRead(
      dependencies.checkBudget,
      () => dependencies.navigation.sources([identity.sourceRevisionRef], beforeGrantSnapshot),
    ));
    const beforeSourceSnapshot = immutableClone(beforeSource);
    const beforeSourceCanonical = canonicalEvidenceJson(beforeSourceSnapshot);
    requireSourceBinding(beforeSourceSnapshot, identity);

    const anchorAuthority: CandidateAnchorAuthority = await checkedRead(
      dependencies.checkBudget,
      () => dependencies.authority.resolveCandidate(identity.candidate),
    );
    requireAnchorBinding(anchorAuthority, beforeSourceSnapshot, identity);
    const materialized: MaterializedEvidenceExcerpt = await checkedRead(
      dependencies.checkBudget,
      () => dependencies.content.materialize(beforeSourceSnapshot, anchorAuthority.anchor),
    );
    requireMaterializedBinding(materialized, beforeSourceSnapshot);

    const afterGrant: ScopeAuthorization = await checkedRead(
      dependencies.checkBudget,
      () => dependencies.navigation.current(identity.requestedScope),
    );
    const afterSource = oneSource(await checkedRead(
      dependencies.checkBudget,
      () => dependencies.navigation.sources([identity.sourceRevisionRef], afterGrant),
    ));
    if (
      beforeGrantCanonical !== canonicalEvidenceJson(afterGrant) ||
      beforeSourceCanonical !== canonicalEvidenceJson(afterSource) ||
      identity.navigationScopeCanonical !== canonicalEvidenceJson(dependencies.navigation.scope)
    ) {
      fail("EVIDENCE_IDENTITY_CONFLICT", "scope or source authority changed during exact readback");
    }
    return materialized.exact_excerpt.includes(probe);
  };
}
