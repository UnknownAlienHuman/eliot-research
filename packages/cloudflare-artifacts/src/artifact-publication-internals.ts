import { VersionedRefSchema, type ArtifactRevision, type VersionedRef } from "@eliotr/contracts";
import { canonicalDigest, canonicalJson } from "@eliotr/platform-cloudflare";
import type {
  D1NavigationStoreInput,
  EvidenceAccessContext,
  NavigationReadAuthority,
  ScopeAuthorization,
} from "@eliotr/cloudflare-evidence";
import { artifactMayBeAccepted } from "@eliotr/domain";
import { readReauthorizedArtifactDraftSectionCitations } from "./artifact-draft-citations-reauthorization.js";
import { readReauthorizedArtifactDraft } from "./artifact-draft-reauthorization.js";
import {
  assertArtifactPublicationReady,
  ArtifactPublicationReadinessError,
} from "./artifact-publication-policy.js";

export { ArtifactPublicationReadinessError } from "./artifact-publication-policy.js";

export const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,256}$/u;
export const ACCEPT_TOPIC = "artifact.accepted";
const MAX_PUBLICATION_SECTIONS = 128;

export type ArtifactPublicationErrorCode =
  | "ARTIFACT_PUBLICATION_INPUT_INVALID"
  | "ARTIFACT_PUBLICATION_DENIED"
  | "ARTIFACT_PUBLICATION_STALE"
  | "ARTIFACT_PUBLICATION_NOT_FOUND"
  | "ARTIFACT_PUBLICATION_NOT_READY"
  | "ARTIFACT_PUBLICATION_IDEMPOTENCY_CONFLICT"
  | "ARTIFACT_PUBLICATION_INTEGRITY"
  | "ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN";

export class ArtifactPublicationError extends Error {
  public readonly code: ArtifactPublicationErrorCode;
  public readonly retryable: boolean;

  public constructor(code: ArtifactPublicationErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArtifactPublicationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface CreateArtifactPublicationProducerInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly require_current: D1NavigationStoreInput["require_current"];
  readonly resolve_acceptance_decision?: (input: ResolveArtifactAcceptanceDecisionInput) => Promise<ArtifactOwnerAcceptanceDecision>;
  readonly now?: () => number;
}

export interface ArtifactPublicationAuthorityInput {
  readonly artifact_ref: VersionedRef;
  readonly access: EvidenceAccessContext;
  readonly current_navigation: NavigationReadAuthority;
  readonly current_authorization: ScopeAuthorization;
  readonly search_database: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly deployment_generation: string;
}

export interface AcceptArtifactInput extends ArtifactPublicationAuthorityInput {
  readonly expected_draft_head_revision: number;
  readonly expected_publication_revision: number | null;
  readonly idempotency_key: string;
}

export interface ArtifactOwnerAcceptanceDecision {
  readonly protocol: "eliotr.artifact-owner-acceptance.v1";
  readonly mode: "OWNER_EXPLICIT";
  readonly artifact_ref: VersionedRef;
  readonly expected_draft_head_revision: number;
  readonly expected_publication_revision: number | null;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly idempotency_key: string;
  readonly decision_ref: string;
  readonly provenance_ref: string;
  readonly expires_at: string;
}

export interface ResolveArtifactAcceptanceDecisionInput {
  readonly artifact_ref: VersionedRef;
  readonly expected_draft_head_revision: number;
  readonly expected_publication_revision: number | null;
  readonly access: EvidenceAccessContext;
  readonly authorization: ScopeAuthorization;
  readonly draft: ArtifactRevision;
}

export type ReadArtifactPublicationInput = ArtifactPublicationAuthorityInput;

export interface ArtifactPublicationReceipt {
  readonly publication_ref: string;
  readonly artifact_ref: VersionedRef;
  readonly publication_revision: number;
  readonly manifest_sha256: string;
  readonly verification_set_sha256: string;
  readonly evidence_currentness_sha256: string;
  readonly acceptance_decision_ref: string;
  readonly acceptance_provenance_ref: string;
  readonly acceptance_decision_sha256: string;
  readonly principal_ref: string;
  readonly authorization_receipt_ref: string;
  readonly created_at: string;
}

export interface ArtifactPublicationResult {
  readonly disposition: "CREATED" | "EXISTING";
  readonly revision: ArtifactRevision;
  readonly receipt: ArtifactPublicationReceipt;
}

export interface ArtifactPublicationRead {
  readonly revision: ArtifactRevision;
  readonly receipt: ArtifactPublicationReceipt;
}

interface CurrentnessRow {
  readonly handle_id: unknown;
  readonly handle_revision: unknown;
  readonly source_revision_ref: unknown;
  readonly source_content_sha256: unknown;
  readonly source_namespace_id: unknown;
  readonly source_owner_generation: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly excerpt_sha256: unknown;
  readonly terminal_state: unknown;
  readonly purge_state: unknown;
  readonly current_source_owner_generation: unknown;
  readonly active_owner_generation: unknown;
  readonly invalidation_ref: unknown;
}

export interface PublicationRow {
  readonly publication_ref: unknown;
  readonly artifact_id: unknown;
  readonly draft_revision: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly attempt_id: unknown;
  readonly idempotency_key: unknown;
  readonly acceptance_decision_ref: unknown;
  readonly acceptance_provenance_ref: unknown;
  readonly acceptance_decision_json: unknown;
  readonly acceptance_decision_sha256: unknown;
  readonly operation_receipt_id: unknown;
  readonly operation_receipt_revision: unknown;
  readonly principal_ref: unknown;
  readonly authorization_scope_id: unknown;
  readonly authorization_scope_revision: unknown;
  readonly authorization_receipt_ref: unknown;
  readonly policy_authority_ref: unknown;
  readonly credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly expected_publication_revision: unknown;
  readonly publication_revision: unknown;
  readonly expected_draft_head_revision: unknown;
  readonly manifest_sha256: unknown;
  readonly verification_set_json: unknown;
  readonly verification_set_sha256: unknown;
  readonly evidence_currentness_json: unknown;
  readonly evidence_currentness_sha256: unknown;
  readonly purge_ledger_revision: unknown;
  readonly created_at: unknown;
  readonly disposition: unknown;
  readonly head_publication_ref: unknown;
  readonly head_publication_revision: unknown;
  readonly operation_outcome: unknown;
  readonly operation_reconciliation_required: unknown;
  readonly operation_output_refs_json: unknown;
  readonly operation_readback_refs_json: unknown;
  readonly operation_principal_ref: unknown;
  readonly operation_kind: unknown;
  readonly operation_idempotency_key: unknown;
  readonly operation_policy_decision_ref: unknown;
  readonly outbox_id: unknown;
  readonly outbox_topic: unknown;
  readonly outbox_payload_sha256: unknown;
  readonly attempt_state: unknown;
  readonly attempt_number: unknown;
}

interface DraftBindingRow {
  readonly manifest_sha256: unknown;
  readonly manifest_size_bytes: unknown;
  readonly object_receipt_json: unknown;
}

interface VerificationObjectRow {
  readonly object_ref: unknown;
  readonly receipt_json: unknown;
}

export interface ReadinessSnapshot {
  readonly draft: ArtifactRevision;
  readonly manifest_sha256: string;
  readonly verification_set: readonly unknown[];
  readonly verification_set_sha256: string;
  readonly evidence_currentness: readonly unknown[];
  readonly evidence_currentness_sha256: string;
  readonly purge_ledger_revision: number;
  readonly authorization_scope: VersionedRef;
  readonly authorization_receipt_ref: string;
  readonly policy_authority_ref: string;
  readonly credential_generation: string;
  readonly authorization_expires_at: string;
  readonly deployment_generation: string;
}

export function fail(code: ArtifactPublicationErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new ArtifactPublicationError(code, message, retryable, cause);
}

export function validText(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value !== value.trim()) {
    fail("ARTIFACT_PUBLICATION_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

export function validRevision(value: unknown, label: string, allowNull = false): number | null {
  if (allowNull && value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("ARTIFACT_PUBLICATION_INPUT_INVALID", `${label} is invalid`);
  }
  return value as number;
}

export function parseRef(value: unknown, label: string): VersionedRef {
  try { return VersionedRefSchema.parse(value); }
  catch (cause) { fail("ARTIFACT_PUBLICATION_INPUT_INVALID", `${label} is invalid`, false, cause); }
}

export function nowIso(now: () => number): string {
  const milliseconds = now();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) fail("ARTIFACT_PUBLICATION_INPUT_INVALID", "clock value is invalid");
  const value = new Date(milliseconds).toISOString();
  if (!Number.isFinite(Date.parse(value))) fail("ARTIFACT_PUBLICATION_INPUT_INVALID", "clock value is invalid");
  return value;
}

export function decodeCanonical(value: unknown, label: string): unknown {
  if (typeof value !== "string") fail("ARTIFACT_PUBLICATION_INTEGRITY", `${label} is missing`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { fail("ARTIFACT_PUBLICATION_INTEGRITY", `${label} is malformed`); }
  if (canonicalJson(parsed) !== value) fail("ARTIFACT_PUBLICATION_INTEGRITY", `${label} is not canonical`);
  return parsed;
}

export function safeString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", `${label} is invalid`);
  }
  return value;
}

export function safePositive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("ARTIFACT_PUBLICATION_INTEGRITY", `${label} is invalid`);
  return value as number;
}

function currentnessHandleRefs(sections: readonly unknown[]): readonly VersionedRef[] {
  const refs = new Map<string, VersionedRef>();
  for (const value of sections) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("ARTIFACT_PUBLICATION_INTEGRITY", "verification section record is invalid");
    const section = value as { readonly cited_handle_refs?: unknown };
    if (!Array.isArray(section.cited_handle_refs)) fail("ARTIFACT_PUBLICATION_INTEGRITY", "verification citation set is invalid");
    for (const rawRef of section.cited_handle_refs) {
      const ref = parseRef(rawRef, "verification evidence handle");
      refs.set(`${ref.id}:${ref.revision}`, ref);
    }
  }
  return [...refs.values()].sort((left, right) => `${left.id}:${left.revision}`.localeCompare(`${right.id}:${right.revision}`));
}

export function verificationIdentity(sections: unknown): readonly unknown[] {
  if (!Array.isArray(sections)) fail("ARTIFACT_PUBLICATION_INTEGRITY", "verification set is invalid");
  return sections.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("ARTIFACT_PUBLICATION_INTEGRITY", "verification section record is invalid");
    const section = value as Record<string, unknown>;
    if (!Array.isArray(section.cited_evidence)) fail("ARTIFACT_PUBLICATION_INTEGRITY", "verification evidence identity is invalid");
    const citedEvidence = section.cited_evidence.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) fail("ARTIFACT_PUBLICATION_INTEGRITY", "verification citation identity is invalid");
      const citation = item as Record<string, unknown>;
      return {
        original_handle_ref: parseRef(citation.original_handle_ref, "original evidence handle"),
        excerpt_sha256: safeString(citation.excerpt_sha256, "verification excerpt digest"),
      };
    }).sort((left, right) => `${left.original_handle_ref.id}:${left.original_handle_ref.revision}`.localeCompare(`${right.original_handle_ref.id}:${right.original_handle_ref.revision}`));
    return {
      section_ref: parseRef(section.section_ref, "verification section"),
      body_sha256: safeString(section.body_sha256, "verification body digest"),
      evidence_ledger_ref: safeString(section.evidence_ledger_ref, "verification evidence ledger"),
      verification_receipt_ref: safeString(section.verification_receipt_ref, "verification receipt"),
      cited_evidence: citedEvidence,
      audit_claims: section.audit_claims,
      verification_sha256: safeString(section.verification_sha256, "verification object digest"),
    };
  }).sort((left, right) => `${(left.section_ref as VersionedRef).id}:${(left.section_ref as VersionedRef).revision}`.localeCompare(`${(right.section_ref as VersionedRef).id}:${(right.section_ref as VersionedRef).revision}`));
}

export function currentnessIdentity(rows: unknown): readonly unknown[] {
  if (!Array.isArray(rows)) fail("ARTIFACT_PUBLICATION_INTEGRITY", "evidence currentness record is invalid");
  return rows.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("ARTIFACT_PUBLICATION_INTEGRITY", "evidence currentness row is invalid");
    const row = value as Record<string, unknown>;
    if (!Array.isArray(row.original_handle_refs)) fail("ARTIFACT_PUBLICATION_INTEGRITY", "evidence currentness source identity is invalid");
    return {
      original_handle_refs: row.original_handle_refs.map((ref) => parseRef(ref, "original evidence handle"))
        .sort((left, right) => `${left.id}:${left.revision}`.localeCompare(`${right.id}:${right.revision}`)),
      source_revision_ref: safeString(row.source_revision_ref, "evidence source revision"),
      source_content_sha256: safeString(row.source_content_sha256, "evidence source content digest"),
      source_namespace_id: safeString(row.source_namespace_id, "evidence source namespace"),
      source_owner_generation: safeString(row.source_owner_generation, "evidence owner generation"),
      excerpt_sha256: safeString(row.excerpt_sha256, "evidence excerpt digest"),
    };
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

async function readCurrentness(
  database: D1Database,
  sections: readonly unknown[],
  scopeRef: VersionedRef,
): Promise<{ readonly rows: readonly unknown[]; readonly purge_ledger_revision: number }> {
  const refs = currentnessHandleRefs(sections);
  const originalRefsByCurrentRef = new Map<string, Set<string>>();
  for (const value of sections) {
    const section = value as { readonly cited_evidence: readonly { readonly original_handle_ref: VersionedRef; readonly handle_ref: VersionedRef }[] };
    for (const citation of section.cited_evidence) {
      const currentKey = `${citation.handle_ref.id}:${citation.handle_ref.revision}`;
      const originalKey = `${citation.original_handle_ref.id}:${citation.original_handle_ref.revision}`;
      const originals = originalRefsByCurrentRef.get(currentKey) ?? new Set<string>();
      originals.add(originalKey);
      originalRefsByCurrentRef.set(currentKey, originals);
    }
  }
  if (refs.length === 0) fail("ARTIFACT_PUBLICATION_NOT_READY", "verified sections cite no current evidence");
  const result = await database.prepare(
    "WITH wanted AS (SELECT json_extract(value,'$.id') AS handle_id, json_extract(value,'$.revision') AS revision FROM json_each(?1)) " +
    "SELECT h.handle_id,h.revision AS handle_revision,h.source_revision_ref,sr.content_sha256 AS source_content_sha256,h.source_namespace_id,h.source_owner_generation, " +
    "h.scope_snapshot_id,h.scope_snapshot_revision,h.excerpt_sha256,h.terminal_state,sr.purge_state, " +
    "s.source_owner_generation AS current_source_owner_generation,own.source_owner_generation AS active_owner_generation, " +
    "(SELECT i.invalidation_ref FROM evidence_handle_invalidation i WHERE i.handle_id=h.handle_id AND i.handle_revision=h.revision LIMIT 1) AS invalidation_ref " +
    "FROM wanted w JOIN evidence_handle h ON h.handle_id=w.handle_id AND h.revision=w.revision " +
    "JOIN source_revision sr ON sr.source_revision_ref=h.source_revision_ref " +
    "JOIN source s ON s.source_id=sr.source_id " +
    "JOIN source_namespace_ownership own ON own.source_namespace_id=h.source_namespace_id AND own.status='ACTIVE' " +
    "WHERE h.terminal_state='LIVE' AND sr.purge_state='LIVE' AND sr.currentness_state IN ('current_confirmed','observed_with_age') " +
    "AND sr.source_owner_generation=h.source_owner_generation AND s.source_namespace_id=h.source_namespace_id " +
    "AND s.source_owner_generation=h.source_owner_generation AND own.source_owner_generation=h.source_owner_generation " +
    "AND h.scope_snapshot_id=?2 AND h.scope_snapshot_revision=?3 AND h.excerpt_sha256 IS NOT NULL " +
    "AND NOT EXISTS(SELECT 1 FROM evidence_handle_invalidation i WHERE i.handle_id=h.handle_id AND i.handle_revision=h.revision) " +
    "ORDER BY h.handle_id,h.revision",
  ).bind(canonicalJson(refs), scopeRef.id, scopeRef.revision).all<CurrentnessRow>();
  if (!result.success || !Array.isArray(result.results) || result.results.length !== refs.length) {
    fail("ARTIFACT_PUBLICATION_STALE", "one or more exact evidence handles are no longer current");
  }
  const rows = result.results.map((row) => {
    const handleRef = `${safeString(row.handle_id, "current evidence handle")}:${safePositive(row.handle_revision, "current evidence revision")}`;
    if (row.terminal_state !== "LIVE" || row.purge_state !== "LIVE" || row.invalidation_ref !== null ||
        row.current_source_owner_generation !== row.source_owner_generation || row.active_owner_generation !== row.source_owner_generation ||
        row.scope_snapshot_id !== scopeRef.id || row.scope_snapshot_revision !== scopeRef.revision) {
      fail("ARTIFACT_PUBLICATION_STALE", `evidence handle ${handleRef} is stale`);
    }
    return {
      handle_id: safeString(row.handle_id, "current evidence handle"),
      handle_revision: safePositive(row.handle_revision, "current evidence revision"),
      source_revision_ref: safeString(row.source_revision_ref, "evidence source revision"),
      source_content_sha256: safeString(row.source_content_sha256, "evidence source content digest"),
      source_namespace_id: safeString(row.source_namespace_id, "evidence source namespace"),
      source_owner_generation: safeString(row.source_owner_generation, "evidence owner generation"),
      scope_snapshot_id: scopeRef.id,
      scope_snapshot_revision: scopeRef.revision,
      excerpt_sha256: safeString(row.excerpt_sha256, "evidence excerpt digest"),
      original_handle_refs: [...(originalRefsByCurrentRef.get(handleRef) ?? [])].sort().map((ref) => {
        const separator = ref.lastIndexOf(":");
        return parseRef({ id: ref.slice(0, separator), revision: Number(ref.slice(separator + 1)) }, "original evidence handle");
      }),
    };
  });
  const purge = await database.prepare("SELECT coalesce(max(ledger_revision),0) AS revision FROM purge_ledger").first<{ readonly revision: unknown }>();
  const purgeRevision = purge?.revision;
  if (!Number.isSafeInteger(purgeRevision) || (purgeRevision as number) < 0) fail("ARTIFACT_PUBLICATION_INTEGRITY", "purge ledger fence is invalid");
  return { rows, purge_ledger_revision: purgeRevision as number };
}

export async function readinessSnapshot(
  options: CreateArtifactPublicationProducerInput,
  input: ArtifactPublicationAuthorityInput,
): Promise<ReadinessSnapshot> {
  if (input.access.client_class !== "owner_pwa") fail("ARTIFACT_PUBLICATION_DENIED", "artifact acceptance is owner-only");
  if (!input.current_authorization.allowed_use.includes("research") ||
      input.current_authorization.policy_authority_ref.length < 1 ||
      input.current_authorization.authorization_receipt_ref.length < 1 ||
      input.access.principal_ref.length < 1 || input.access.credential_generation.length < 1) {
    fail("ARTIFACT_PUBLICATION_DENIED", "current owner authorization is incomplete");
  }
  const deploymentGeneration = validText(input.deployment_generation, "deployment generation");
  const artifactRef = parseRef(input.artifact_ref, "artifact reference");
  const now = options.now ?? Date.now;
  const nowText = nowIso(now);
  const authorizationExpiry = Date.parse(input.current_authorization.expires_at);
  if (!Number.isFinite(authorizationExpiry) || authorizationExpiry <= Date.parse(nowText)) {
    fail("ARTIFACT_PUBLICATION_STALE", "owner authorization has expired");
  }
  const draftRead = await readReauthorizedArtifactDraft({
    database: options.database,
    work_bucket: options.work_bucket,
    artifact_ref: artifactRef,
    access: input.access,
    current_navigation: input.current_navigation,
    current_authorization: input.current_authorization,
    deployment_generation: deploymentGeneration,
  });
  if (draftRead === null) fail("ARTIFACT_PUBLICATION_NOT_FOUND", "exact draft revision was not found");
  const draft = draftRead.artifact;
  if (!("sections" in draft)) fail("ARTIFACT_PUBLICATION_INTEGRITY", "draft reader returned a section instead of a revision");
  if (draft.status !== "DRAFT" || draft.sections.length < 1 || draft.sections.length > MAX_PUBLICATION_SECTIONS) {
    fail("ARTIFACT_PUBLICATION_NOT_READY", "exact draft revision is not publishable");
  }
  const authorizationScope = parseRef({
    id: input.current_navigation.scope.snapshot_id,
    revision: input.current_navigation.scope.revision,
  }, "current authorization scope");
  const sectionReads = new Map<string, NonNullable<Awaited<ReturnType<typeof readReauthorizedArtifactDraftSectionCitations>>>>();
  for (const section of draft.sections) {
    const sectionKey = `${section.section_ref.id}:${section.section_ref.revision}`;
    const read = await readReauthorizedArtifactDraftSectionCitations({
      database: options.database,
      work_bucket: options.work_bucket,
      search_database: input.search_database,
      evidence_bucket: input.evidence_bucket,
      artifact_ref: artifactRef,
      section_ref: section.section_ref,
      access: input.access,
      current_navigation: input.current_navigation,
      current_authorization: input.current_authorization,
      deployment_generation: deploymentGeneration,
      now,
    });
    if (read === null) fail("ARTIFACT_PUBLICATION_NOT_FOUND", `verified section ${section.section_ref.id} was not found`);
    sectionReads.set(sectionKey, read);
  }
  try { assertArtifactPublicationReady(draft, sectionReads); }
  catch (cause) {
    if (cause instanceof ArtifactPublicationReadinessError) fail("ARTIFACT_PUBLICATION_NOT_READY", cause.message, false, cause);
    throw cause;
  }
  const verifiedRevision: ArtifactRevision = { ...draft, status: "VERIFIED" };
  if (!artifactMayBeAccepted(verifiedRevision)) fail("ARTIFACT_PUBLICATION_NOT_READY", "verified artifact does not satisfy the domain acceptance predicate");

  const verificationSet = draft.sections.map((section) => {
    const sectionKey = `${section.section_ref.id}:${section.section_ref.revision}`;
    const read = sectionReads.get(sectionKey);
    if (read === undefined) fail("ARTIFACT_PUBLICATION_INTEGRITY", "section verification readback is missing");
    return {
      section_ref: section.section_ref,
      body_sha256: section.body_sha256,
      evidence_ledger_ref: section.evidence_ledger_ref,
      verification_receipt_ref: section.verification_receipt_ref,
      cited_handle_refs: read.cited_evidence.map((item) => item.handle_ref)
        .sort((left, right) => `${left.id}:${left.revision}`.localeCompare(`${right.id}:${right.revision}`)),
      cited_evidence: read.cited_evidence.map((item) => ({
        original_handle_ref: item.original_handle_ref,
        handle_ref: item.handle_ref,
        excerpt_sha256: item.excerpt_sha256,
      })).sort((left, right) => `${left.handle_ref.id}:${left.handle_ref.revision}`.localeCompare(`${right.handle_ref.id}:${right.handle_ref.revision}`)),
      audit_claims: read.semantic_verification === "EXECUTED" ? read.audit.claims.map((claim) => ({
        claim_ref: claim.claim_ref,
        claim_text_digest: claim.claim_text_digest,
        disposition: claim.disposition,
        statement_label: section.statement_labels[claim.claim_ref.id],
        support_handle_refs: claim.support_handle_refs,
        counterevidence_handle_refs: claim.counterevidence_handle_refs,
      })) : [],
    };
  });
  const verificationObjects = await options.database.prepare(
    "SELECT object_ref,receipt_json FROM artifact_draft_object " +
    "WHERE artifact_id=?1 AND revision=?2 AND object_kind='VERIFICATION_RECEIPT' ORDER BY object_ref",
  ).bind(artifactRef.id, artifactRef.revision).all<VerificationObjectRow>();
  if (!verificationObjects.success || !Array.isArray(verificationObjects.results) || verificationObjects.results.length !== draft.sections.length) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "persisted verification object receipts are incomplete");
  }
  const verificationObjectByRef = new Map<string, string>();
  for (const row of verificationObjects.results) {
    const objectRef = safeString(row.object_ref, "verification object reference");
    const objectReceipt = decodeCanonical(row.receipt_json, "verification object receipt") as Record<string, unknown>;
    const sha = safeString(objectReceipt.expected_sha256, "verification object digest");
    if (!SHA256.test(sha) || objectReceipt.readback_sha256 !== sha) {
      fail("ARTIFACT_PUBLICATION_INTEGRITY", "verification object readback receipt is inconsistent");
    }
    verificationObjectByRef.set(objectRef, sha);
  }
  const verificationSetWithDigests = verificationSet.map((section) => {
    const ref = (section as { readonly verification_receipt_ref: string }).verification_receipt_ref;
    const digest = verificationObjectByRef.get(ref);
    if (digest === undefined) fail("ARTIFACT_PUBLICATION_INTEGRITY", "section verification object is not persisted");
    return { ...section, verification_sha256: digest };
  });
  const verificationSetSha = await canonicalDigest(verificationIdentity(verificationSetWithDigests));
  const currentness = await readCurrentness(options.database, verificationSetWithDigests, authorizationScope);
  const evidenceCurrentnessSha = await canonicalDigest(currentness.rows);
  const binding = await options.database.prepare(
    "SELECT b.manifest_sha256,b.manifest_size_bytes,o.receipt_json AS object_receipt_json " +
    "FROM artifact_draft_binding b JOIN artifact_draft_object o ON o.artifact_id=b.artifact_id " +
    "AND o.revision=b.revision AND o.object_kind='MANIFEST' AND o.object_ref='manifest' " +
    "WHERE b.artifact_id=?1 AND b.revision=?2 LIMIT 1",
  ).bind(artifactRef.id, artifactRef.revision).first<DraftBindingRow>();
  if (binding === null) fail("ARTIFACT_PUBLICATION_INTEGRITY", "persisted draft manifest binding is missing");
  const manifestReceipt = decodeCanonical(binding.object_receipt_json, "draft manifest object receipt") as Record<string, unknown>;
  if (typeof binding.manifest_sha256 !== "string" || !SHA256.test(binding.manifest_sha256) ||
      manifestReceipt.expected_sha256 !== binding.manifest_sha256 || manifestReceipt.readback_sha256 !== binding.manifest_sha256 ||
      !Number.isSafeInteger(binding.manifest_size_bytes) || manifestReceipt.size_bytes !== binding.manifest_size_bytes) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "persisted draft manifest receipt does not match its binding");
  }
  return {
    draft,
    manifest_sha256: binding.manifest_sha256,
    verification_set: verificationSetWithDigests,
    verification_set_sha256: verificationSetSha,
    evidence_currentness: currentness.rows,
    evidence_currentness_sha256: evidenceCurrentnessSha,
    purge_ledger_revision: currentness.purge_ledger_revision,
    authorization_scope: authorizationScope,
    authorization_receipt_ref: input.current_authorization.authorization_receipt_ref,
    policy_authority_ref: input.current_authorization.policy_authority_ref,
    credential_generation: input.access.credential_generation,
    authorization_expires_at: input.current_authorization.expires_at,
    deployment_generation: deploymentGeneration,
  };
}

export function deterministicRef(prefix: string, digest: string): string {
  return `${prefix}-${digest.slice(0, 48)}`;
}
