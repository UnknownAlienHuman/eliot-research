/** C3-EC citation resolution V1 and V2.
 *
 * Both retained families are decoded strictly. V1 is immutable. V2 carries one outcome per requested
 * handle in requested order, and its projections are the exact ordered projection of those outcomes.
 * The projection is never reconstructed from compatibility members.
 */

import { IdentifierSchema, type VersionedRef } from '@eliotr/contracts';
import type { LegacyErrorFactory } from '../../legacy/http.js';
import type { EpochPort } from '../../transport/client.js';
import type { ResearchRunRequest } from '../../research/runs/authority.js';
import type { ResearchRunWire } from '../../research/runs/wire.js';
import type { CitationAuditHelpers } from './audit.js';

const CITATIONS_PATH = '/api/v1/research/artifact';
const MAX_CITED_EVIDENCE = 512;

const REJECTED_OUTCOMES: readonly string[] = ['INVALID_REFERENCE', 'AUTHORITY_REVOKED', 'CONTENT_MISMATCH'];

export interface CitedEvidence {
  readonly handle_ref: VersionedRef;
  readonly excerpt_sha256: string;
}

export interface CitationResolutionItem extends CitedEvidence {
  readonly verification_receipt_ref: string;
}

export interface CitationResolutionRejection {
  readonly handle_ref: VersionedRef;
  readonly reason_code: string;
}

export type CitationResolutionOutcome =
  | { readonly handle_ref: VersionedRef; readonly outcome: 'RESOLVED'; readonly excerpt_sha256: string; readonly verification_receipt_ref: string }
  | { readonly handle_ref: VersionedRef; readonly outcome: 'INVALID_REFERENCE' }
  | { readonly handle_ref: VersionedRef; readonly outcome: 'AUTHORITY_REVOKED' }
  | { readonly handle_ref: VersionedRef; readonly outcome: 'SOURCE_QUARANTINED' }
  | { readonly handle_ref: VersionedRef; readonly outcome: 'CONTENT_MISMATCH' }
  | { readonly handle_ref: VersionedRef; readonly outcome: 'VERIFY_UNAVAILABLE' }
  | { readonly handle_ref: VersionedRef; readonly outcome: 'STORAGE_UNAVAILABLE' }
  | { readonly handle_ref: VersionedRef; readonly outcome: 'EFFECT_UNKNOWN' };

export type NonResolvedOutcome =
  | 'INVALID_REFERENCE'
  | 'AUTHORITY_REVOKED'
  | 'SOURCE_QUARANTINED'
  | 'CONTENT_MISMATCH'
  | 'VERIFY_UNAVAILABLE'
  | 'STORAGE_UNAVAILABLE'
  | 'EFFECT_UNKNOWN';

export interface CitationResolutionReceiptV2 {
  readonly schema_version: 2;
  readonly receipt_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly requested_handle_refs: readonly VersionedRef[];
  readonly outcomes: readonly CitationResolutionOutcome[];
  readonly resolved: readonly CitationResolutionItem[];
  readonly rejected: readonly CitationResolutionRejection[];
  readonly requested_count: number;
  readonly resolved_count: number;
  readonly all_material_citations_resolved: boolean;
  readonly created_at: string;
  readonly receipt_digest: string;
}

export interface CitationResolutionReceiptV1 {
  readonly receipt_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly requested_handle_refs: readonly VersionedRef[];
  readonly resolved: readonly CitationResolutionItem[];
  readonly rejected: readonly CitationResolutionRejection[];
  readonly requested_count: number;
  readonly resolved_count: number;
  readonly all_material_citations_resolved: boolean;
  readonly created_at: string;
  readonly receipt_digest: string;
}

export interface SectionCitationsNotExecuted {
  readonly protocol: 'eliotr.artifact-section-citations.v1';
  readonly semantic_verification: 'NOT_EXECUTED';
  readonly artifact_ref: VersionedRef;
  readonly section_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly verification_receipt_ref: string;
  readonly cited_evidence: readonly CitedEvidence[];
  readonly deployment_generation: string;
}

export interface SectionCitationsExecuted extends Omit<SectionCitationsNotExecuted, 'protocol' | 'semantic_verification'> {
  readonly protocol: 'eliotr.artifact-section-citations.v2';
  readonly semantic_verification: 'EXECUTED';
  readonly audit: ReturnType<CitationAuditHelpers['decodeCitationAudit']>;
}

export type SectionCitationsView = SectionCitationsNotExecuted | SectionCitationsExecuted;

export interface CitationApiPorts {
  readonly request: ResearchRunRequest;
  readonly errors: LegacyErrorFactory;
  readonly epoch: EpochPort;
}

export interface CitationDependencies {
  readonly wire: ResearchRunWire;
  readonly audit: CitationAuditHelpers;
}

export interface CitationApi {
  readonly decodeSectionCitations: (
    raw: unknown,
    expectedArtifact: VersionedRef,
    expectedSection: VersionedRef,
    expectedDeploymentGeneration?: string,
    expectedVerificationReceiptRef?: string,
  ) => SectionCitationsView;
  readonly readSectionCitations: (
    artifactRef: VersionedRef,
    sectionRef: VersionedRef,
    expectedDeploymentGeneration?: string,
    signal?: AbortSignal,
    expectedVerificationReceiptRef?: string,
  ) => Promise<SectionCitationsView>;
  readonly decodeReceiptV1: (raw: unknown) => CitationResolutionReceiptV1;
  readonly decodeReceiptV2: (raw: unknown) => CitationResolutionReceiptV2;
}

const refKey = (ref: VersionedRef): string => `${ref.id}:${ref.revision}`;



export function createCitationApi(ports: CitationApiPorts, dependencies: CitationDependencies): CitationApi {
  const { request, errors, epoch } = ports;
  const { wire, audit } = dependencies;

  const fenced = async <T>(operation: () => Promise<T>): Promise<T> => {
    const captured = epoch.capture();
    const value = await operation();
    if (!epoch.isCurrent(captured)) {
      throw errors({
        code: 'API_SESSION_CLOSED',
        status: 503,
        message: 'Response belongs to a closed owner session',
        traceId: null,
        retryable: false,
      });
    }
    return value;
  };

  const decodeOutcome = (value: unknown, index: number): CitationResolutionOutcome => {
    const outcome = wire.record(value, ['handle_ref', 'outcome'], ['excerpt_sha256', 'verification_receipt_ref']);
    const handle = wire.versionedRef(outcome.handle_ref, `outcomes[${index}].handle_ref`);
    if (outcome.outcome === 'RESOLVED') {
      return {
        handle_ref: handle,
        outcome: 'RESOLVED',
        excerpt_sha256: audit.sha256Digest(outcome.excerpt_sha256, `outcomes[${index}].excerpt_sha256`),
        verification_receipt_ref: wire.identifier(
          outcome.verification_receipt_ref,
          `outcomes[${index}].verification_receipt_ref`,
        ),
      };
    }
    const closed: readonly NonResolvedOutcome[] = [
      'INVALID_REFERENCE', 'AUTHORITY_REVOKED', 'SOURCE_QUARANTINED', 'CONTENT_MISMATCH',
      'VERIFY_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'EFFECT_UNKNOWN',
    ];
    if (typeof outcome.outcome !== 'string' || !closed.includes(outcome.outcome as NonResolvedOutcome)) {
      wire.invalid(`outcomes[${index}].outcome is invalid`);
    }
    return { handle_ref: handle, outcome: outcome.outcome as NonResolvedOutcome };
  };

  /** Retained immutable V1 receipt. Members are never reordered, relabeled or dropped. */
  const decodeReceiptV1 = (raw: unknown): CitationResolutionReceiptV1 => {
    const receipt = wire.record(raw, [
      'receipt_ref',
      'scope_snapshot_ref',
      'requested_handle_refs',
      'resolved',
      'rejected',
      'requested_count',
      'resolved_count',
      'all_material_citations_resolved',
      'created_at',
      'receipt_digest',
    ]);
    const requested = (receipt.requested_handle_refs as unknown[]).map((ref, index) =>
      wire.versionedRef(ref, `requested_handle_refs[${index}]`));
    const requestedKeys = requested.map(refKey);
    if (new Set(requestedKeys).size !== requestedKeys.length) wire.invalid('duplicate requested handle');
    const resolved = (receipt.resolved as unknown[]).map((value, index) => {
      const item = wire.record(value, ['handle_ref', 'excerpt_sha256', 'verification_receipt_ref']);
      return {
        handle_ref: wire.versionedRef(item.handle_ref, `resolved[${index}].handle_ref`),
        excerpt_sha256: audit.sha256Digest(item.excerpt_sha256, `resolved[${index}].excerpt_sha256`),
        verification_receipt_ref: wire.identifier(
          item.verification_receipt_ref,
          `resolved[${index}].verification_receipt_ref`,
        ),
      };
    });
    const rejected = (receipt.rejected as unknown[]).map((value, index) => {
      const item = wire.record(value, ['handle_ref', 'reason_code']);
      return {
        handle_ref: wire.versionedRef(item.handle_ref, `rejected[${index}].handle_ref`),
        reason_code: wire.boundedString(item.reason_code, `rejected[${index}].reason_code`),
      };
    });
    const resolvedKeys = resolved.map((item) => refKey(item.handle_ref));
    const rejectedKeys = rejected.map((item) => refKey(item.handle_ref));
    if (new Set(resolvedKeys).size !== resolvedKeys.length) wire.invalid('duplicate resolved handle');
    if (new Set(rejectedKeys).size !== rejectedKeys.length) wire.invalid('duplicate rejected handle');
    const requestedSet = new Set(requestedKeys);
    if (resolvedKeys.some((key) => !requestedSet.has(key)) || rejectedKeys.some((key) => !requestedSet.has(key))) {
      wire.invalid('receipt contains an unrequested handle');
    }
    if (resolvedKeys.some((key) => rejectedKeys.includes(key))) {
      wire.invalid('one handle is both resolved and rejected');
    }
    return {
      receipt_ref: wire.versionedRef(receipt.receipt_ref, 'receipt_ref'),
      scope_snapshot_ref: wire.versionedRef(receipt.scope_snapshot_ref, 'scope_snapshot_ref'),
      requested_handle_refs: requested,
      resolved,
      rejected,
      requested_count: requestedKeys.length,
      resolved_count: resolvedKeys.length,
      all_material_citations_resolved: resolvedKeys.length === requestedKeys.length && rejectedKeys.length === 0,
      created_at: wire.isoTimestamp(receipt.created_at, 'created_at'),
      receipt_digest: audit.sha256Digest(receipt.receipt_digest, 'receipt_digest'),
    };
  };

  /** Strict V2 receipt. Order and projection are exact, never reconstructed. */
  const decodeReceiptV2 = (raw: unknown): CitationResolutionReceiptV2 => {
    const receipt = wire.record(raw, [
      'schema_version',
      'receipt_ref',
      'scope_snapshot_ref',
      'requested_handle_refs',
      'outcomes',
      'resolved',
      'rejected',
      'requested_count',
      'resolved_count',
      'all_material_citations_resolved',
      'created_at',
      'receipt_digest',
    ]);
    if (receipt.schema_version !== 2) wire.invalid('citation resolution receipt version is not 2');
    const requested = (receipt.requested_handle_refs as unknown[]).map((ref, index) =>
      wire.versionedRef(ref, `requested_handle_refs[${index}]`));
    const outcomes = (receipt.outcomes as unknown[]).map(decodeOutcome);
    const requestedKeys = requested.map(refKey);
    const outcomeKeys = outcomes.map((item) => refKey(item.handle_ref));
    if (new Set(requestedKeys).size !== requestedKeys.length) wire.invalid('duplicate requested handle');
    if (new Set(outcomeKeys).size !== outcomeKeys.length) wire.invalid('duplicate citation outcome');
    if (outcomeKeys.length !== requestedKeys.length || outcomeKeys.some((key) => !requestedKeys.includes(key))) {
      wire.invalid('outcomes must cover every requested handle exactly once');
    }
    /** The exact ordered projection of the RESOLVED outcomes, never reconstructed from other members. */
    const resolved: CitationResolutionItem[] = outcomes
      .filter((item): item is CitationResolutionOutcome & { outcome: 'RESOLVED' } => item.outcome === 'RESOLVED')
      .map((item) => ({
        handle_ref: item.handle_ref,
        excerpt_sha256: item.excerpt_sha256,
        verification_receipt_ref: item.verification_receipt_ref,
      }));
    const rejected: CitationResolutionRejection[] = outcomes
      .filter((item) => REJECTED_OUTCOMES.includes(item.outcome))
      .map((item) => ({ handle_ref: item.handle_ref, reason_code: item.outcome }));
    const exactProjection = (field: string, sent: unknown, derived: readonly { handle_ref: VersionedRef }[], members: readonly string[]): void => {
      if (!Array.isArray(sent) || sent.length !== derived.length) {
        wire.invalid(`${field} is not the exact projection of the outcomes`);
      }
      (sent as unknown[]).forEach((value, index) => {
        const expected = derived[index];
        if (expected === undefined) {
          wire.invalid(`${field} is not the exact projection of the outcomes`);
          return;
        }
        const row = value as Record<string, unknown>;
        const derivedRow = expected as unknown as Record<string, unknown>;
        if (refKey(wire.versionedRef(row.handle_ref, `${field}[${index}].handle_ref`)) !== refKey(expected.handle_ref) ||
            members.some((member) => row[member] !== derivedRow[member])) {
          wire.invalid(`${field} is not the exact projection of the outcomes`);
        }
      });
    };
    exactProjection('resolved', receipt.resolved, resolved, ['excerpt_sha256', 'verification_receipt_ref']);
    exactProjection('rejected', receipt.rejected, rejected, ['reason_code']);
    if (receipt.requested_count !== requestedKeys.length) wire.invalid('requested_count is not derived from requested handles');
    if (receipt.resolved_count !== resolved.length) wire.invalid('resolved_count is not derived from outcomes');
    if (receipt.all_material_citations_resolved !== (outcomes.length > 0 && outcomes.every((item) => item.outcome === 'RESOLVED'))) {
      wire.invalid('all_material_citations_resolved is not derived from outcomes');
    }
    return {
      schema_version: 2,
      receipt_ref: wire.versionedRef(receipt.receipt_ref, 'receipt_ref'),
      scope_snapshot_ref: wire.versionedRef(receipt.scope_snapshot_ref, 'scope_snapshot_ref'),
      requested_handle_refs: requested,
      outcomes,
      resolved,
      rejected,
      requested_count: requestedKeys.length,
      resolved_count: resolved.length,
      all_material_citations_resolved: outcomes.length > 0 && outcomes.every((item) => item.outcome === 'RESOLVED'),
      created_at: wire.isoTimestamp(receipt.created_at, 'created_at'),
      receipt_digest: audit.sha256Digest(receipt.receipt_digest, 'receipt_digest'),
    };
  };

  const decodeSectionCitations = (
    raw: unknown,
    expectedArtifact: VersionedRef,
    expectedSection: VersionedRef,
    expectedDeploymentGeneration?: string,
    expectedVerificationReceiptRef?: string,
  ): SectionCitationsView => {
    const parsed = wire.envelope(raw);
    wire.checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
    const data = wire.record(
      parsed.data,
      ['protocol', 'artifact_ref', 'section_ref', 'scope_snapshot_ref', 'verification_receipt_ref', 'semantic_verification', 'cited_evidence'],
      ['audit'],
    );
    const artifact = wire.versionedRef(data.artifact_ref, 'artifact_ref');
    const section = wire.versionedRef(data.section_ref, 'section_ref');
    const scope = wire.versionedRef(data.scope_snapshot_ref, 'scope_snapshot_ref');
    if (!wire.sameRef(artifact, expectedArtifact) || !wire.sameRef(section, expectedSection)) {
      wire.invalid('research citation identity does not match the requested section');
    }
    const receipt = wire.boundedString(data.verification_receipt_ref, 'verification_receipt_ref');
    if (!IdentifierSchema.safeParse(receipt).success) wire.invalid('verification_receipt_ref is invalid');
    if (expectedVerificationReceiptRef !== undefined && receipt !== expectedVerificationReceiptRef) {
      wire.invalid('research citation receipt does not match the requested section');
    }
    if (!Array.isArray(data.cited_evidence) || data.cited_evidence.length < 1 || data.cited_evidence.length > MAX_CITED_EVIDENCE) {
      wire.invalid('cited evidence is invalid');
    }
    const seen = new Set<string>();
    const citedEvidence = (data.cited_evidence as unknown[]).map((value, index) => {
      const citation = wire.record(value, ['handle_ref', 'excerpt_sha256']);
      const handle = wire.versionedRef(citation.handle_ref, `cited_evidence[${index}].handle_ref`);
      const key = refKey(handle);
      if (seen.has(key)) wire.invalid('cited evidence contains a duplicate handle');
      seen.add(key);
      return { handle_ref: handle, excerpt_sha256: audit.sha256Digest(citation.excerpt_sha256, `cited_evidence[${index}].excerpt_sha256`) };
    });
    const base = {
      artifact_ref: artifact,
      section_ref: section,
      scope_snapshot_ref: scope,
      verification_receipt_ref: receipt,
      cited_evidence: citedEvidence,
      deployment_generation: parsed.deployment_generation,
    };
    if (data.protocol === 'eliotr.artifact-section-citations.v1' && data.semantic_verification === 'NOT_EXECUTED' && !Object.hasOwn(data, 'audit')) {
      return { ...base, protocol: 'eliotr.artifact-section-citations.v1', semantic_verification: 'NOT_EXECUTED' };
    }
    if (data.protocol === 'eliotr.artifact-section-citations.v2' && data.semantic_verification === 'EXECUTED' && Object.hasOwn(data, 'audit')) {
      const view = audit.decodeCitationAudit(data.audit);
      for (const claim of view.claims) {
        for (const ref of [...claim.support_handle_refs, ...claim.counterevidence_handle_refs]) {
          if (!seen.has(refKey(ref))) wire.invalid('audit evidence is not present in cited_evidence');
        }
      }
      return { ...base, protocol: 'eliotr.artifact-section-citations.v2', semantic_verification: 'EXECUTED', audit: view };
    }
    return wire.invalid('research citation protocol is invalid');
  };

  const readSectionCitations = async (
    artifactRef: VersionedRef,
    sectionRef: VersionedRef,
    expectedDeploymentGeneration?: string,
    signal?: AbortSignal,
    expectedVerificationReceiptRef?: string,
  ): Promise<SectionCitationsView> => {
    const artifact = wire.versionedRef(artifactRef, 'artifact_ref');
    const section = wire.versionedRef(sectionRef, 'section_ref');
    const path = `${CITATIONS_PATH}/${encodeURIComponent(`${artifact.id}:${artifact.revision}`)}/sections/${encodeURIComponent(`${section.id}:${section.revision}`)}/citations`;
    return fenced(async () => {
      const raw = await request(path, signal ? { signal } : {}, [200]);
      return decodeSectionCitations(raw, artifact, section, expectedDeploymentGeneration, expectedVerificationReceiptRef);
    });
  };

  return { decodeSectionCitations, readSectionCitations, decodeReceiptV1, decodeReceiptV2 };
}
