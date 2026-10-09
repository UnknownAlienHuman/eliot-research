/** C3-EC citation audit and digest helpers.
 *
 * One file owns these three helpers for the whole leaf, so the resolution, reauthorization and byte
 * modules call the same factory members instead of carrying local copies. Every bound, digest form
 * and rejection is preserved exactly from the legacy workspace decoders.
 */

import { Sha256Schema, type VersionedRef } from '@eliotr/contracts';
import type { ResearchRunWire } from '../../research/runs/wire.js';
import type { LegacyErrorFactory } from '../../legacy/http.js';

export type CitationAuditDisposition =
  | 'SUPPORTED'
  | 'PARTIALLY_SUPPORTED'
  | 'UNSUPPORTED'
  | 'CONTRADICTED'
  | 'NOT_VERIFIABLE_IN_SCOPE';

export interface CitationAuditClaim {
  readonly claim_ref: VersionedRef;
  readonly claim_text: string;
  readonly claim_text_digest: string;
  readonly disposition: CitationAuditDisposition;
  readonly support_handle_refs: readonly VersionedRef[];
  readonly counterevidence_handle_refs: readonly VersionedRef[];
}

export interface CitationAuditView {
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly output_sha256: string;
  readonly synthesis_output_sha256: string;
  readonly normalization_binding_sha256: string;
  readonly verifier_ref: string;
  readonly verifier_schema_generation: string;
  readonly model_receipt_ref: string;
  readonly claims: readonly CitationAuditClaim[];
}

export interface CitationScopeAuthorizationView {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly authorization_receipt_ref: string;
  readonly scope_snapshot_ref: { readonly id: string; readonly revision: number };
}

export interface CitationAuditHelpers {
  readonly sha256Digest: (value: unknown, label: string) => string;
  readonly decodeCitationAudit: (value: unknown) => CitationAuditView;
  readonly scopeAuthorization: (value: unknown) => CitationScopeAuthorizationView;
  readonly claimDisposition: (value: unknown, label: string) => CitationAuditDisposition;
  readonly auditClaims: (view: CitationAuditView) => readonly CitationAuditClaim[];
}

const DISPOSITIONS: readonly CitationAuditDisposition[] = [
  'SUPPORTED',
  'PARTIALLY_SUPPORTED',
  'UNSUPPORTED',
  'CONTRADICTED',
  'NOT_VERIFIABLE_IN_SCOPE',
];

const MAX_AUDIT_CLAIMS = 512;
const MAX_AUDIT_REFS = 512;
const MAX_CLAIM_TEXT = 16_384;

const DIGEST_LABELS: readonly string[] = [
  'audit.stage_request_sha256',
  'audit.output_sha256',
  'audit.synthesis_output_sha256',
  'audit.normalization_binding_sha256',
];

const refKey = (ref: VersionedRef): string => `${ref.id}:${ref.revision}`;

export function createCitationAuditHelpers(
  errors: LegacyErrorFactory,
  wire: ResearchRunWire,
): CitationAuditHelpers {
  const invalid = (message: string): never => {
    throw errors({
      code: 'EVIDENCE_RESPONSE_INVALID',
      status: 502,
      message,
      traceId: null,
      retryable: false,
    });
  };

  const sha256Digest = (value: unknown, label: string): string => {
    const digest = wire.boundedString(value, label, 64);
    if (!Sha256Schema.safeParse(digest).success) invalid(`${label} is invalid`);
    return digest;
  };

  const claimText = (value: unknown, label: string): string => {
    const text = wire.boundedString(value, label, MAX_CLAIM_TEXT);
    if (text.length < 1) invalid(`${label} is invalid`);
    return text;
  };

  const claimDisposition = (value: unknown, label: string): CitationAuditDisposition => {
    if (typeof value !== 'string' || !DISPOSITIONS.includes(value as CitationAuditDisposition)) {
      invalid(`${label} is invalid`);
    }
    return value as CitationAuditDisposition;
  };

  const versionedRefList = (value: unknown, label: string): VersionedRef[] => {
    if (!Array.isArray(value) || value.length > MAX_AUDIT_REFS) invalid(`${label} is invalid`);
    const refs = (value as unknown[]).map((item, index) => wire.versionedRef(item, `${label}[${index}]`));
    if (new Set(refs.map(refKey)).size !== refs.length) invalid(`${label} contains duplicate references`);
    return refs;
  };

  const decodeClaim = (value: unknown, index: number): CitationAuditClaim => {
    const claim = wire.record(value, [
      'claim_ref',
      'claim_text',
      'claim_text_digest',
      'disposition',
      'support_handle_refs',
      'counterevidence_handle_refs',
    ]);
    const support = versionedRefList(claim.support_handle_refs, `audit.claims[${index}].support_handle_refs`);
    const counter = versionedRefList(
      claim.counterevidence_handle_refs,
      `audit.claims[${index}].counterevidence_handle_refs`,
    );
    const combined = [...support, ...counter];
    if (new Set(combined.map(refKey)).size !== combined.length) {
      invalid(`audit.claims[${index}] contains duplicate evidence references`);
    }
    return {
      claim_ref: wire.versionedRef(claim.claim_ref, `audit.claims[${index}].claim_ref`),
      claim_text: claimText(claim.claim_text, `audit.claims[${index}].claim_text`),
      claim_text_digest: sha256Digest(claim.claim_text_digest, `audit.claims[${index}].claim_text_digest`),
      disposition: claimDisposition(claim.disposition, `audit.claims[${index}].disposition`),
      support_handle_refs: support,
      counterevidence_handle_refs: counter,
    };
  };

  const decodeCitationAudit = (value: unknown): CitationAuditView => {
    const audit = wire.record(value, [
      'stage_attempt_ref',
      'stage_request_sha256',
      'output_sha256',
      'synthesis_output_sha256',
      'normalization_binding_sha256',
      'verifier_ref',
      'verifier_schema_generation',
      'model_receipt_ref',
      'claims',
    ]);
    if (!Array.isArray(audit.claims) || audit.claims.length < 1 || audit.claims.length > MAX_AUDIT_CLAIMS) {
      invalid('audit claims are invalid');
    }
    const claims = (audit.claims as unknown[]).map((claim, index) => decodeClaim(claim, index));
    if (new Set(claims.map((claim) => refKey(claim.claim_ref))).size !== claims.length) {
      invalid('audit claims contain duplicate references');
    }
    return {
      stage_attempt_ref: wire.identifier(audit.stage_attempt_ref, 'audit.stage_attempt_ref'),
      stage_request_sha256: sha256Digest(audit.stage_request_sha256, 'audit.stage_request_sha256'),
      output_sha256: sha256Digest(audit.output_sha256, 'audit.output_sha256'),
      synthesis_output_sha256: sha256Digest(audit.synthesis_output_sha256, 'audit.synthesis_output_sha256'),
      normalization_binding_sha256: sha256Digest(
        audit.normalization_binding_sha256,
        'audit.normalization_binding_sha256',
      ),
      verifier_ref: wire.identifier(audit.verifier_ref, 'audit.verifier_ref'),
      verifier_schema_generation: wire.identifier(
        audit.verifier_schema_generation,
        'audit.verifier_schema_generation',
      ),
      model_receipt_ref: wire.identifier(audit.model_receipt_ref, 'audit.model_receipt_ref'),
      claims,
    };
  };

  const scopeAuthorization = (value: unknown): CitationScopeAuthorizationView => {
    const view = wire.record(value, [
      'principal_ref',
      'credential_generation',
      'authorization_receipt_ref',
      'scope_snapshot_ref',
    ]);
    return {
      principal_ref: wire.identifier(view.principal_ref, 'authorization.principal_ref'),
      credential_generation: wire.identifier(view.credential_generation, 'authorization.credential_generation'),
      authorization_receipt_ref: wire.identifier(
        view.authorization_receipt_ref,
        'authorization.authorization_receipt_ref',
      ),
      scope_snapshot_ref: wire.versionedRef(view.scope_snapshot_ref, 'authorization.scope_snapshot_ref'),
    };
  };

  return {
    sha256Digest,
    decodeCitationAudit,
    scopeAuthorization,
    claimDisposition,
    auditClaims: (view: CitationAuditView) => view.claims,
  };
}

export const CITATION_AUDIT_DIGEST_LABELS = DIGEST_LABELS;
