/** C3-EC reauthorized section citations.
 *
 * The reauthorized family swaps the single scope reference for an original plus an authorization
 * scope, and each cited row carries a fresh handle beside the original. It never reuses the
 * non-reauthorized decoder, and it never collapses the two scope references into one.
 */

import { IdentifierSchema, type VersionedRef } from '@eliotr/contracts';
import type { LegacyErrorFactory } from '../../legacy/http.js';
import type { EpochPort } from '../../transport/client.js';
import type { ResearchRunRequest } from '../../research/runs/authority.js';
import type { ResearchRunWire } from '../../research/runs/wire.js';
import type { CitationAuditHelpers } from './audit.js';
import type { CitationApi } from './citations.js';

export const REAUTHORIZATION_PROTOCOL = 'eliotr.artifact-draft-citations-reauthorization.v1' as const;

const MAX_CITED_EVIDENCE = 512;

export interface ReauthorizedCitedEvidence {
  readonly original_handle_ref: VersionedRef;
  readonly handle_ref: VersionedRef;
  readonly excerpt_sha256: string;
}

export interface ReauthorizedCitationsBase {
  readonly protocol: typeof REAUTHORIZATION_PROTOCOL;
  readonly artifact_ref: VersionedRef;
  readonly section_ref: VersionedRef;
  readonly original_scope_snapshot_ref: VersionedRef;
  readonly authorization_scope_snapshot_ref: VersionedRef;
  readonly authorization: ReturnType<CitationAuditHelpers['scopeAuthorization']>;
  readonly deployment_generation: string;
  readonly verification_receipt_ref: string;
  readonly cited_evidence: readonly ReauthorizedCitedEvidence[];
}

export type ReauthorizedSectionCitationsView =
  | (ReauthorizedCitationsBase & { readonly semantic_verification: 'NOT_EXECUTED'; readonly audit?: never })
  | (ReauthorizedCitationsBase & { readonly semantic_verification: 'EXECUTED'; readonly audit: ReturnType<CitationAuditHelpers['decodeCitationAudit']> });

export interface ReauthorizationPorts {
  readonly request: ResearchRunRequest;
  readonly errors: LegacyErrorFactory;
  readonly epoch: EpochPort;
}

export interface ReauthorizationDependencies {
  readonly wire: ResearchRunWire;
  readonly audit: CitationAuditHelpers;
  /** The accepted non-reauthorized reader, injected so one decoder stays authoritative. */
  readonly decodeSectionCitations: CitationApi['decodeSectionCitations'];
  readonly readSectionCitations: CitationApi['readSectionCitations'];
}

export interface ReauthorizationApi {
  readonly decodeReauthorizedSectionCitations: (
    raw: unknown,
    expectedArtifact: VersionedRef,
    expectedSection: VersionedRef,
    expectedDeploymentGeneration?: string,
    expectedVerificationReceiptRef?: string,
  ) => ReauthorizedSectionCitationsView;
  readonly readReauthorizedSectionCitations: (
    artifactRef: VersionedRef,
    sectionRef: VersionedRef,
    expectedDeploymentGeneration?: string,
    signal?: AbortSignal,
    expectedVerificationReceiptRef?: string,
  ) => Promise<ReauthorizedSectionCitationsView>;
  readonly decodeSectionCitations: CitationApi['decodeSectionCitations'];
  readonly readSectionCitations: CitationApi['readSectionCitations'];
}

const refKey = (ref: VersionedRef): string => `${ref.id}:${ref.revision}`;

export function createReauthorizationApi(
  ports: ReauthorizationPorts,
  dependencies: ReauthorizationDependencies,
): ReauthorizationApi {
  const { request, errors, epoch } = ports;
  const { wire, audit, decodeSectionCitations, readSectionCitations } = dependencies;

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

  const decodeReauthorizedSectionCitations = (
    raw: unknown,
    expectedArtifact: VersionedRef,
    expectedSection: VersionedRef,
    expectedDeploymentGeneration?: string,
    expectedVerificationReceiptRef?: string,
  ): ReauthorizedSectionCitationsView => {
    const parsed = wire.envelope(raw);
    wire.checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
    const data = wire.record(
      parsed.data,
      [
        'protocol',
        'artifact_ref',
        'section_ref',
        'original_scope_snapshot_ref',
        'authorization_scope_snapshot_ref',
        'authorization',
        'deployment_generation',
        'verification_receipt_ref',
        'cited_evidence',
        'semantic_verification',
      ],
      ['audit'],
    );
    if (data.protocol !== REAUTHORIZATION_PROTOCOL) {
      wire.invalid('artifact citation reauthorization protocol is invalid');
    }
    const artifact = wire.versionedRef(data.artifact_ref, 'artifact_ref');
    const section = wire.versionedRef(data.section_ref, 'section_ref');
    if (!wire.sameRef(artifact, expectedArtifact) || !wire.sameRef(section, expectedSection)) {
      wire.invalid('reauthorized citation identity does not match the requested section');
    }
    const generation = wire.identifier(data.deployment_generation, 'data.deployment_generation');
    if (generation !== parsed.deployment_generation) {
      wire.invalid('reauthorized citation generations differ');
    }
    const receipt = wire.boundedString(data.verification_receipt_ref, 'verification_receipt_ref');
    if (!IdentifierSchema.safeParse(receipt).success) wire.invalid('reauthorized citation receipt is invalid');
    if (expectedVerificationReceiptRef !== undefined && receipt !== expectedVerificationReceiptRef) {
      wire.invalid('reauthorized citation receipt is invalid');
    }
    if (!Array.isArray(data.cited_evidence) || data.cited_evidence.length > MAX_CITED_EVIDENCE) {
      wire.invalid('reauthorized cited evidence is invalid');
    }
    const originalSeen = new Set<string>();
    const freshSeen = new Set<string>();
    const citedEvidence = (data.cited_evidence as unknown[]).map((value, index) => {
      const citation = wire.record(value, ['original_handle_ref', 'handle_ref', 'excerpt_sha256']);
      const original = wire.versionedRef(
        citation.original_handle_ref,
        `cited_evidence[${index}].original_handle_ref`,
      );
      const fresh = wire.versionedRef(citation.handle_ref, `cited_evidence[${index}].handle_ref`);
      const originalKey = refKey(original);
      const freshKey = refKey(fresh);
      if (originalSeen.has(originalKey) || freshSeen.has(freshKey)) {
        wire.invalid('reauthorized cited evidence contains a duplicate handle');
      }
      originalSeen.add(originalKey);
      freshSeen.add(freshKey);
      return {
        original_handle_ref: original,
        handle_ref: fresh,
        excerpt_sha256: audit.sha256Digest(citation.excerpt_sha256, `cited_evidence[${index}].excerpt_sha256`),
      };
    });
    const base = {
      protocol: REAUTHORIZATION_PROTOCOL,
      artifact_ref: artifact,
      section_ref: section,
      original_scope_snapshot_ref: wire.versionedRef(
        data.original_scope_snapshot_ref,
        'original_scope_snapshot_ref',
      ),
      authorization_scope_snapshot_ref: wire.versionedRef(
        data.authorization_scope_snapshot_ref,
        'authorization_scope_snapshot_ref',
      ),
      authorization: audit.scopeAuthorization(data.authorization),
      deployment_generation: generation,
      verification_receipt_ref: receipt,
      cited_evidence: citedEvidence,
    };
    if (data.semantic_verification === 'NOT_EXECUTED' && !Object.hasOwn(data, 'audit')) {
      return { ...base, semantic_verification: 'NOT_EXECUTED' };
    }
    if (data.semantic_verification === 'EXECUTED' && Object.hasOwn(data, 'audit')) {
      const view = audit.decodeCitationAudit(data.audit);
      for (const claim of view.claims) {
        for (const ref of [...claim.support_handle_refs, ...claim.counterevidence_handle_refs]) {
          if (!originalSeen.has(refKey(ref))) {
            wire.invalid('reauthorized audit evidence is not present in cited_evidence');
          }
        }
      }
      return { ...base, semantic_verification: 'EXECUTED', audit: view };
    }
    return wire.invalid('reauthorized citation semantic verification is invalid');
  };

  const readReauthorizedSectionCitations = async (
    artifactRef: VersionedRef,
    sectionRef: VersionedRef,
    expectedDeploymentGeneration?: string,
    signal?: AbortSignal,
    expectedVerificationReceiptRef?: string,
  ): Promise<ReauthorizedSectionCitationsView> => {
    const artifact = wire.versionedRef(artifactRef, 'artifact_ref');
    const section = wire.versionedRef(sectionRef, 'section_ref');
    const path = `/api/v1/research/artifact/${encodeURIComponent(`${artifact.id}:${artifact.revision}`)}/sections/${encodeURIComponent(`${section.id}:${section.revision}`)}/citations/reauthorize`;
    return fenced(async () => {
      // The shared owner transport injects `x-eliotr-csrf: 1` for every non-GET method, so the
      // legacy empty POST is reproduced by the method and an absent body alone.
      const raw = await request(path, {
        method: 'POST',
        ...(signal ? { signal } : {}),
      }, [200]);
      return decodeReauthorizedSectionCitations(
        raw,
        artifact,
        section,
        expectedDeploymentGeneration,
        expectedVerificationReceiptRef,
      );
    });
  };

  return {
    decodeReauthorizedSectionCitations,
    readReauthorizedSectionCitations,
    decodeSectionCitations,
    readSectionCitations,
  };
}
