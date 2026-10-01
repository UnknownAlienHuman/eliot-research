import {
  OperationIntentSchema,
  VersionedRefSchema,
  type ArtifactRevision,
  type OperationIntent,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  canonicalDigest,
  canonicalJson,
  prepareIntentWithOutboxMutation,
} from "@eliotr/platform-cloudflare";
import type {
  D1NavigationStoreInput,
  EvidenceAccessContext,
  NavigationReadAuthority,
  ScopeAuthorization,
} from "@eliotr/cloudflare-evidence";
import { artifactMayBeAccepted } from "@eliotr/domain";
import { readReauthorizedArtifactDraftSectionCitations } from "./artifact-draft-citations-reauthorization.js";
import { readArtifactDraft, type ArtifactDraftReadError } from "./artifact-draft-reader.js";
import {
  assertArtifactPublicationReady,
  ArtifactPublicationReadinessError,
} from "./artifact-publication-policy.js";

export { ArtifactPublicationReadinessError } from "./artifact-publication-policy.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const ACCEPT_TOPIC = "artifact.accepted";
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

export interface ReadArtifactPublicationInput extends ArtifactPublicationAuthorityInput {}

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

interface PublicationRow {
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

interface ReadinessSnapshot {
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

function fail(code: ArtifactPublicationErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new ArtifactPublicationError(code, message, retryable, cause);
}

function validText(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value !== value.trim()) {
    fail("ARTIFACT_PUBLICATION_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function validRevision(value: unknown, label: string, allowNull = false): number | null {
  if (allowNull && value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("ARTIFACT_PUBLICATION_INPUT_INVALID", `${label} is invalid`);
  }
  return value as number;
}

function parseRef(value: unknown, label: string): VersionedRef {
  try { return VersionedRefSchema.parse(value); }
  catch (cause) { fail("ARTIFACT_PUBLICATION_INPUT_INVALID", `${label} is invalid`, false, cause); }
}

function nowIso(now: () => number): string {
  const milliseconds = now();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) fail("ARTIFACT_PUBLICATION_INPUT_INVALID", "clock value is invalid");
  const value = new Date(milliseconds).toISOString();
  if (!Number.isFinite(Date.parse(value))) fail("ARTIFACT_PUBLICATION_INPUT_INVALID", "clock value is invalid");
  return value;
}

function decodeCanonical(value: unknown, label: string): unknown {
  if (typeof value !== "string") fail("ARTIFACT_PUBLICATION_INTEGRITY", `${label} is missing`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { fail("ARTIFACT_PUBLICATION_INTEGRITY", `${label} is malformed`); }
  if (canonicalJson(parsed) !== value) fail("ARTIFACT_PUBLICATION_INTEGRITY", `${label} is not canonical`);
  return parsed;
}

function safeString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", `${label} is invalid`);
  }
  return value;
}

function safePositive(value: unknown, label: string): number {
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

async function readCurrentness(
  database: D1Database,
  sections: readonly unknown[],
  scopeRef: VersionedRef,
): Promise<{ readonly rows: readonly unknown[]; readonly purge_ledger_revision: number }> {
  const refs = currentnessHandleRefs(sections);
  if (refs.length === 0) fail("ARTIFACT_PUBLICATION_NOT_READY", "verified sections cite no current evidence");
  const result = await database.prepare(
    "WITH wanted AS (SELECT json_extract(value,'$.id') AS handle_id, json_extract(value,'$.revision') AS revision FROM json_each(?1)) " +
    "SELECT h.handle_id,h.revision AS handle_revision,h.source_revision_ref,h.source_namespace_id,h.source_owner_generation, " +
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
      source_namespace_id: safeString(row.source_namespace_id, "evidence source namespace"),
      source_owner_generation: safeString(row.source_owner_generation, "evidence owner generation"),
      scope_snapshot_id: scopeRef.id,
      scope_snapshot_revision: scopeRef.revision,
      excerpt_sha256: safeString(row.excerpt_sha256, "evidence excerpt digest"),
    };
  });
  const purge = await database.prepare("SELECT coalesce(max(ledger_revision),0) AS revision FROM purge_ledger").first<{ readonly revision: unknown }>();
  const purgeRevision = purge?.revision;
  if (!Number.isSafeInteger(purgeRevision) || (purgeRevision as number) < 0) fail("ARTIFACT_PUBLICATION_INTEGRITY", "purge ledger fence is invalid");
  return { rows, purge_ledger_revision: purgeRevision as number };
}

async function readinessSnapshot(
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
  const draft = await readArtifactDraft({
    database: options.database,
    work_bucket: options.work_bucket,
    artifact_ref: artifactRef,
    access: input.access,
    require_current: options.require_current,
    now,
  });
  if (draft === null) fail("ARTIFACT_PUBLICATION_NOT_FOUND", "exact draft revision was not found");
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
  const verificationSetSha = await canonicalDigest(verificationSetWithDigests);
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

function deterministicRef(prefix: string, digest: string): string {
  return `${prefix}-${digest.slice(0, 48)}`;
}

function decodePublicationRow(row: PublicationRow): ArtifactPublicationReceipt {
  const artifactId = safeString(row.artifact_id, "publication artifact id");
  const draftRevision = safePositive(row.draft_revision, "publication draft revision");
  const publicationRevision = safePositive(row.publication_revision, "publication revision");
  const manifestSha = safeString(row.manifest_sha256, "publication manifest digest");
  const verificationSha = safeString(row.verification_set_sha256, "publication verification digest");
  const currentnessSha = safeString(row.evidence_currentness_sha256, "publication currentness digest");
  const acceptanceSha = safeString(row.acceptance_decision_sha256, "acceptance decision digest");
  if (!SHA256.test(manifestSha) || !SHA256.test(verificationSha) || !SHA256.test(currentnessSha) || !SHA256.test(acceptanceSha)) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "publication digest is malformed");
  }
  const decisionJson = decodeCanonical(row.acceptance_decision_json, "acceptance decision");
  if (decisionJson === null || typeof decisionJson !== "object" || Array.isArray(decisionJson)) fail("ARTIFACT_PUBLICATION_INTEGRITY", "acceptance decision shape is invalid");
  const expectedDecisionKeys = [
    "protocol", "mode", "artifact_ref", "expected_draft_head_revision", "expected_publication_revision",
    "principal_ref", "credential_generation", "idempotency_key", "decision_ref", "provenance_ref", "expires_at",
  ].sort();
  if (Object.keys(decisionJson).sort().join("\u0000") !== expectedDecisionKeys.join("\u0000")) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "acceptance decision contains unsupported fields");
  }
  const decision = decisionJson as Partial<ArtifactOwnerAcceptanceDecision>;
  const decisionArtifact = parseRef(decision.artifact_ref, "persisted acceptance artifact reference");
  const decisionExpectedPublication = validRevision(decision.expected_publication_revision, "persisted expected publication revision", true);
  if (decision.protocol !== "eliotr.artifact-owner-acceptance.v1" || decision.mode !== "OWNER_EXPLICIT" ||
      decisionArtifact.id !== artifactId || decisionArtifact.revision !== draftRevision ||
      decision.expected_draft_head_revision !== draftRevision || decisionExpectedPublication !== row.expected_publication_revision ||
      decision.principal_ref !== row.principal_ref || typeof decision.credential_generation !== "string" ||
      decision.credential_generation !== row.credential_generation || decision.idempotency_key !== row.idempotency_key ||
      decision.decision_ref !== row.acceptance_decision_ref || decision.provenance_ref !== row.acceptance_provenance_ref ||
      typeof decision.expires_at !== "string" || !Number.isFinite(Date.parse(decision.expires_at)) ||
      canonicalJson(decisionJson) !== row.acceptance_decision_json) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "persisted acceptance decision does not match receipt authority");
  }
  return {
    publication_ref: safeString(row.publication_ref, "publication reference"),
    artifact_ref: { id: artifactId, revision: draftRevision },
    publication_revision: publicationRevision,
    manifest_sha256: manifestSha,
    verification_set_sha256: verificationSha,
    evidence_currentness_sha256: currentnessSha,
    acceptance_decision_ref: safeString(row.acceptance_decision_ref, "acceptance decision reference"),
    acceptance_provenance_ref: safeString(row.acceptance_provenance_ref, "acceptance provenance reference"),
    acceptance_decision_sha256: acceptanceSha,
    principal_ref: safeString(row.principal_ref, "publication principal"),
    authorization_receipt_ref: safeString(row.authorization_receipt_ref, "publication authorization receipt"),
    created_at: safeString(row.created_at, "publication creation time"),
  };
}

async function readPublicationRow(
  database: D1Database,
  artifactRef: VersionedRef,
): Promise<PublicationRow | null> {
  return database.prepare(
    "SELECT p.publication_ref,p.artifact_id,p.draft_revision,p.intent_id,p.intent_revision,p.attempt_id,p.idempotency_key, " +
    "p.operation_receipt_id,p.operation_receipt_revision,p.principal_ref,p.acceptance_decision_ref,p.acceptance_provenance_ref, " +
    "p.acceptance_decision_json,p.acceptance_decision_sha256,p.authorization_scope_id,p.authorization_scope_revision, " +
    "p.authorization_receipt_ref,p.policy_authority_ref,p.credential_generation,p.deployment_generation, " +
      "p.expected_publication_revision,p.publication_revision,p.expected_draft_head_revision,p.manifest_sha256, " +
    "p.verification_set_json,p.verification_set_sha256,p.evidence_currentness_json,p.evidence_currentness_sha256, " +
    "p.purge_ledger_revision,p.created_at,h.disposition,h.publication_ref AS head_publication_ref, " +
    "h.publication_revision AS head_publication_revision,r.outcome AS operation_outcome, " +
    "r.reconciliation_required AS operation_reconciliation_required,r.output_refs_json AS operation_output_refs_json, " +
    "r.readback_receipt_refs_json AS operation_readback_refs_json,i.principal_ref AS operation_principal_ref, " +
    "i.operation_kind,i.idempotency_key AS operation_idempotency_key,i.policy_decision_ref AS operation_policy_decision_ref, " +
    "o.outbox_id,o.topic AS outbox_topic,o.payload_sha256 AS outbox_payload_sha256, " +
    "a.state AS attempt_state,a.attempt_number " +
    "FROM artifact_publication_receipt p " +
    "JOIN operation_intent i ON i.intent_id=p.intent_id AND i.revision=p.intent_revision " +
    "JOIN operation_attempt a ON a.attempt_id=p.attempt_id AND a.intent_id=p.intent_id AND a.intent_revision=p.intent_revision " +
    "JOIN operation_receipt r ON r.receipt_id=p.operation_receipt_id AND r.revision=p.operation_receipt_revision " +
    "JOIN outbox o ON o.outbox_id=p.outbox_id AND o.intent_id=p.intent_id AND o.intent_revision=p.intent_revision " +
    "LEFT JOIN artifact_publication_head h ON h.artifact_id=p.artifact_id " +
    "WHERE p.artifact_id=?1 AND p.draft_revision=?2 LIMIT 1",
  ).bind(artifactRef.id, artifactRef.revision).first<PublicationRow>();
}

async function validatePersistedPublication(row: PublicationRow, expected?: {
  readonly principal_ref: string;
  readonly intent: OperationIntent;
  readonly payload_sha256: string;
  readonly expected_publication_revision: number | null;
  readonly readiness: ReadinessSnapshot;
  readonly acceptance_decision: ArtifactOwnerAcceptanceDecision;
  readonly acceptance_decision_sha256: string;
}): Promise<ArtifactPublicationReceipt> {
  const receipt = decodePublicationRow(row);
  const acceptanceDecision = decodeCanonical(row.acceptance_decision_json, "acceptance decision");
  const verification = decodeCanonical(row.verification_set_json, "publication verification set");
  const currentness = decodeCanonical(row.evidence_currentness_json, "publication evidence currentness");
  if (!Array.isArray(verification) || !Array.isArray(currentness) || currentness.length === 0) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "publication evidence record is incomplete");
  }
  if (await canonicalDigest(acceptanceDecision) !== receipt.acceptance_decision_sha256 ||
      await canonicalDigest(verification) !== receipt.verification_set_sha256 ||
      await canonicalDigest(currentness) !== receipt.evidence_currentness_sha256) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "publication authority digest does not match its persisted bytes");
  }
  if (row.operation_kind !== "ARTIFACT_PUBLISH" || row.operation_outcome !== "ACCEPTED" ||
      (row.operation_reconciliation_required !== 1 && row.operation_reconciliation_required !== 0) || row.attempt_state !== "SUCCEEDED" ||
      row.attempt_number !== 1 || row.head_publication_ref === null || row.head_publication_revision === null ||
      row.operation_principal_ref !== row.principal_ref || row.operation_idempotency_key !== row.idempotency_key ||
      row.operation_policy_decision_ref !== row.acceptance_decision_ref || row.outbox_topic !== ACCEPT_TOPIC ||
      row.outbox_payload_sha256 === null || row.outbox_id === null) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "canonical operation receipt does not match publication authority");
  }
  const outputRefs = decodeCanonical(row.operation_output_refs_json, "operation output references");
  const readbackRefs = decodeCanonical(row.operation_readback_refs_json, "operation readback references");
  if (!Array.isArray(outputRefs) || outputRefs.length !== 1 || outputRefs[0] !== receipt.publication_ref ||
      !Array.isArray(readbackRefs) || readbackRefs.length !== 1 || readbackRefs[0] !== receipt.publication_ref) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "operation receipt does not bind the publication reference");
  }
  if (expected !== undefined) {
    if (receipt.principal_ref !== expected.principal_ref || row.intent_id !== expected.intent.intent_ref.id ||
        row.intent_revision !== expected.intent.intent_ref.revision || row.outbox_payload_sha256 !== expected.payload_sha256 ||
        row.idempotency_key !== expected.intent.idempotency_key ||
        row.expected_publication_revision !== expected.expected_publication_revision ||
        receipt.artifact_ref.id !== expected.readiness.draft.artifact_ref.id ||
        receipt.artifact_ref.revision !== expected.readiness.draft.artifact_ref.revision ||
        receipt.manifest_sha256 !== expected.readiness.manifest_sha256 ||
        receipt.verification_set_sha256 !== expected.readiness.verification_set_sha256 ||
        receipt.evidence_currentness_sha256 !== expected.readiness.evidence_currentness_sha256) {
      fail("ARTIFACT_PUBLICATION_IDEMPOTENCY_CONFLICT", "idempotent publication request differs from its persisted receipt");
    }
    if (receipt.acceptance_decision_sha256 !== expected.acceptance_decision_sha256 ||
        receipt.acceptance_decision_ref !== expected.acceptance_decision.decision_ref ||
        receipt.acceptance_provenance_ref !== expected.acceptance_decision.provenance_ref ||
        canonicalJson(acceptanceDecision) !== canonicalJson(expected.acceptance_decision)) {
      fail("ARTIFACT_PUBLICATION_IDEMPOTENCY_CONFLICT", "idempotent owner acceptance decision differs from its persisted receipt");
    }
  }
  return receipt;
}

function stableAttemptId(intentRef: VersionedRef): string {
  return `artifact-publish-attempt-${intentRef.id.slice(-32)}`;
}

function stableOperationReceiptId(intentRef: VersionedRef): string {
  return `artifact-publish-result-${intentRef.id.slice(-32)}`;
}

function validateOwnerAcceptanceDecision(
  raw: ArtifactOwnerAcceptanceDecision,
  input: AcceptArtifactInput,
  draft: ArtifactRevision,
  expectedDraftHead: number,
  expectedPublicationRevision: number | null,
  idempotencyKey: string,
  nowText: string,
): ArtifactOwnerAcceptanceDecision {
  const expectedKeys = [
    "protocol", "mode", "artifact_ref", "expected_draft_head_revision", "expected_publication_revision",
    "principal_ref", "credential_generation", "idempotency_key", "decision_ref", "provenance_ref", "expires_at",
  ].sort();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).sort().join("\u0000") !== expectedKeys.join("\u0000") ||
      raw.protocol !== "eliotr.artifact-owner-acceptance.v1" || raw.mode !== "OWNER_EXPLICIT") {
    fail("ARTIFACT_PUBLICATION_DENIED", "explicit owner acceptance decision is missing or invalid");
  }
  const artifactRef = parseRef(raw.artifact_ref, "acceptance decision artifact reference");
  const decisionRef = validText(raw.decision_ref, "acceptance decision reference");
  const provenanceRef = validText(raw.provenance_ref, "acceptance decision provenance");
  const expiry = typeof raw.expires_at === "string" ? Date.parse(raw.expires_at) : NaN;
  if (artifactRef.id !== draft.artifact_ref.id || artifactRef.revision !== draft.artifact_ref.revision ||
      raw.expected_draft_head_revision !== expectedDraftHead ||
      raw.expected_publication_revision !== expectedPublicationRevision ||
      raw.principal_ref !== input.access.principal_ref || raw.credential_generation !== input.access.credential_generation ||
      raw.idempotency_key !== idempotencyKey || !Number.isFinite(expiry) || expiry <= Date.parse(nowText) ||
      expiry > Date.parse(input.current_authorization.expires_at) || new Date(expiry).toISOString() !== raw.expires_at) {
    fail("ARTIFACT_PUBLICATION_DENIED", "owner acceptance decision is not bound to this exact request and current authorization");
  }
  return {
    protocol: raw.protocol,
    mode: raw.mode,
    artifact_ref: artifactRef,
    expected_draft_head_revision: expectedDraftHead,
    expected_publication_revision: expectedPublicationRevision,
    principal_ref: input.access.principal_ref,
    credential_generation: input.access.credential_generation,
    idempotency_key: idempotencyKey,
    decision_ref: decisionRef,
    provenance_ref: provenanceRef,
    expires_at: raw.expires_at,
  };
}

function activeStatus(row: PublicationRow, receipt: ArtifactPublicationReceipt): ArtifactRevision["status"] {
  if (row.head_publication_ref === receipt.publication_ref) {
    if (row.head_publication_revision !== receipt.publication_revision) fail("ARTIFACT_PUBLICATION_INTEGRITY", "publication head revision differs from its receipt");
    if (row.disposition === "ACCEPTED" || row.disposition === "PENDING_REVALIDATION" || row.disposition === "REDACTED_DEPENDENCY") {
      return row.disposition;
    }
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "publication head disposition is invalid");
  }
  return "SUPERSEDED";
}

export function createArtifactPublicationProducer(options: CreateArtifactPublicationProducerInput) {
  const now = options.now ?? Date.now;

  async function readValidated(input: ArtifactPublicationAuthorityInput): Promise<ArtifactPublicationRead | null> {
    const artifactRef = parseRef(input.artifact_ref, "artifact reference");
    const row = await readPublicationRow(options.database, artifactRef);
    if (row === null) return null;
    const receipt = await validatePersistedPublication(row);
    const readiness = await readinessSnapshot(options, input);
    const verification = decodeCanonical(row.verification_set_json, "publication verification set");
    const currentness = decodeCanonical(row.evidence_currentness_json, "publication currentness record");
    if (receipt.manifest_sha256 !== readiness.manifest_sha256 ||
        receipt.verification_set_sha256 !== readiness.verification_set_sha256 ||
        receipt.evidence_currentness_sha256 !== readiness.evidence_currentness_sha256 ||
        row.purge_ledger_revision !== readiness.purge_ledger_revision ||
        canonicalJson(verification) !== canonicalJson(readiness.verification_set) ||
        canonicalJson(currentness) !== canonicalJson(readiness.evidence_currentness)) {
      fail("ARTIFACT_PUBLICATION_STALE", "accepted publication is no longer supported by its exact current evidence");
    }
    const status = activeStatus(row, receipt);
    return { receipt, revision: { ...readiness.draft, status } };
  }

  return {
    async accept(rawInput: AcceptArtifactInput): Promise<ArtifactPublicationResult> {
      const input = rawInput;
      const artifactRef = parseRef(input.artifact_ref, "artifact reference");
      const expectedDraftHead = validRevision(input.expected_draft_head_revision, "expected draft head");
      const expectedPublicationRevision = validRevision(input.expected_publication_revision, "expected publication revision", true);
      const idempotencyKey = validText(input.idempotency_key, "idempotency key");
      if (expectedDraftHead !== artifactRef.revision) fail("ARTIFACT_PUBLICATION_STALE", "acceptance must target the exact expected draft head");
      const readiness = await readinessSnapshot(options, input);
      if (readiness.draft.artifact_ref.id !== artifactRef.id || readiness.draft.artifact_ref.revision !== artifactRef.revision) {
        fail("ARTIFACT_PUBLICATION_INTEGRITY", "draft reader returned a different revision");
      }
      const operationRequest = {
        artifact_ref: artifactRef,
        expected_draft_head_revision: expectedDraftHead,
        expected_publication_revision: expectedPublicationRevision,
      };
      if (options.resolve_acceptance_decision === undefined) {
        fail("ARTIFACT_PUBLICATION_DENIED", "explicit owner acceptance decision service is unavailable");
      }
      let acceptanceDecisionRaw: ArtifactOwnerAcceptanceDecision;
      try {
        acceptanceDecisionRaw = await options.resolve_acceptance_decision({
          artifact_ref: artifactRef,
          expected_draft_head_revision: expectedDraftHead,
          expected_publication_revision: expectedPublicationRevision,
          access: input.access,
          authorization: input.current_authorization,
          draft: readiness.draft,
        });
      } catch (cause) {
        fail("ARTIFACT_PUBLICATION_DENIED", "explicit owner acceptance decision could not be resolved", false, cause);
      }
      const acceptanceDecision = validateOwnerAcceptanceDecision(
        acceptanceDecisionRaw, input, readiness.draft, expectedDraftHead, expectedPublicationRevision,
        idempotencyKey, nowIso(now),
      );
      const acceptanceDecisionJson = canonicalJson(acceptanceDecision);
      const acceptanceDecisionSha = await canonicalDigest(acceptanceDecision);
      const requestSha = await canonicalDigest({ request: operationRequest, acceptance_decision_sha256: acceptanceDecisionSha });
      const principal = input.access.principal_ref;
      const intentId = deterministicRef("artifact-publish-intent", await canonicalDigest({ principal, idempotencyKey, acceptance_decision_sha256: acceptanceDecisionSha }));
      const createdAt = nowIso(now);
      const rawIntent: OperationIntent = {
        intent_ref: { id: intentId, revision: 1 },
        operation_kind: "ARTIFACT_PUBLISH",
        principal_ref: principal,
        idempotency_key: idempotencyKey,
        payload_ref: `artifact-publication-${requestSha}`,
        policy_decision_ref: acceptanceDecision.decision_ref,
        created_at: createdAt,
      };
      let intent: OperationIntent;
      try { intent = OperationIntentSchema.parse(rawIntent); }
      catch (cause) { fail("ARTIFACT_PUBLICATION_INPUT_INVALID", "server publication intent failed strict validation", false, cause); }
      const intentPlan = await prepareIntentWithOutboxMutation(options.database, {
        intent,
        topic: ACCEPT_TOPIC,
        payload_sha256: requestSha,
      });
      let existingIntent: Awaited<ReturnType<typeof intentPlan.readback>>;
      try { existingIntent = await intentPlan.readback(); }
      catch (cause) { fail("ARTIFACT_PUBLICATION_IDEMPOTENCY_CONFLICT", "idempotency key is bound to different publication input", false, cause); }
      if (existingIntent !== null) {
        const existingRow = await readPublicationRow(options.database, artifactRef);
        if (existingRow === null || existingRow.intent_id !== intent.intent_ref.id || existingRow.intent_revision !== intent.intent_ref.revision) {
          fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "publication intent exists without its acceptance readback", true);
        }
        const receipt = await validatePersistedPublication(existingRow, {
          principal_ref: principal,
          intent,
          payload_sha256: requestSha,
          expected_publication_revision: expectedPublicationRevision,
          readiness,
          acceptance_decision: acceptanceDecision,
          acceptance_decision_sha256: acceptanceDecisionSha,
        });
        const replay = await readValidated(input);
        if (replay === null || replay.receipt.publication_ref !== receipt.publication_ref) {
          fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "persisted publication could not be revalidated", true);
        }
        return { ...replay, disposition: "EXISTING" };
      }

      const attemptId = stableAttemptId(intent.intent_ref);
      const operationReceiptId = stableOperationReceiptId(intent.intent_ref);
      const publicationRef = deterministicRef("artifact-publication", await canonicalDigest({ artifactRef, intent: intent.intent_ref }));
      const publicationRevision = (expectedPublicationRevision ?? 0) + 1;
      const attemptInsert = options.database.prepare(
        "INSERT INTO operation_attempt(attempt_id,intent_id,intent_revision,attempt_number,state,started_at) " +
        "VALUES(?1,?2,?3,1,'STARTED',?4)",
      ).bind(attemptId, intent.intent_ref.id, intent.intent_ref.revision, createdAt);
      const operationReceiptInsert = options.database.prepare(
        "INSERT INTO operation_receipt(receipt_id,revision,intent_id,intent_revision,attempt_id,outcome,output_refs_json,readback_receipt_refs_json,reconciliation_required,reason_codes_json,created_at) " +
        "VALUES(?1,1,?2,?3,?4,'ACCEPTED',?5,?5,1,'[]',?6)",
      ).bind(operationReceiptId, intent.intent_ref.id, intent.intent_ref.revision, attemptId,
        canonicalJson([publicationRef]), createdAt);
      const currentnessJson = canonicalJson(readiness.evidence_currentness);
      const verificationJson = canonicalJson(readiness.verification_set);
      const publicationInsert = options.database.prepare(
        "INSERT INTO artifact_publication_receipt(publication_ref,artifact_id,draft_revision,intent_id,intent_revision,attempt_id,operation_receipt_id,operation_receipt_revision,outbox_id,principal_ref,idempotency_key,acceptance_decision_ref,acceptance_provenance_ref,acceptance_decision_json,acceptance_decision_sha256,authorization_scope_id,authorization_scope_revision,authorization_receipt_ref,policy_authority_ref,credential_generation,authorization_expires_at,deployment_generation,expected_publication_revision,publication_revision,expected_draft_head_revision,manifest_sha256,verification_set_json,verification_set_sha256,evidence_currentness_json,evidence_currentness_sha256,purge_ledger_revision,created_at) " +
        "VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31)",
      ).bind(publicationRef, artifactRef.id, artifactRef.revision, intent.intent_ref.id, intent.intent_ref.revision,
        attemptId, operationReceiptId, intentPlan.outbox_id, principal, idempotencyKey,
        acceptanceDecision.decision_ref, acceptanceDecision.provenance_ref, acceptanceDecisionJson, acceptanceDecisionSha,
        readiness.authorization_scope.id, readiness.authorization_scope.revision, readiness.authorization_receipt_ref,
        readiness.policy_authority_ref, readiness.credential_generation, readiness.authorization_expires_at,
        readiness.deployment_generation, expectedPublicationRevision, publicationRevision, expectedDraftHead,
        readiness.manifest_sha256, verificationJson, readiness.verification_set_sha256, currentnessJson,
        readiness.evidence_currentness_sha256, readiness.purge_ledger_revision, createdAt);
      const headUpsert = options.database.prepare(
        "INSERT INTO artifact_publication_head(artifact_id,publication_revision,draft_revision,publication_ref,disposition,updated_at) " +
        "VALUES(?1,?2,?3,?4,'ACCEPTED',?5) " +
        "ON CONFLICT(artifact_id) DO UPDATE SET publication_revision=excluded.publication_revision,draft_revision=excluded.draft_revision, " +
        "publication_ref=excluded.publication_ref,disposition='ACCEPTED',updated_at=excluded.updated_at " +
        "WHERE artifact_publication_head.publication_revision=?6",
      ).bind(artifactRef.id, publicationRevision, artifactRef.revision, publicationRef, createdAt, expectedPublicationRevision);
      const headCasGuard = options.database.prepare(
        "INSERT INTO artifact_publication_mutation_guard(publication_ref,created_at) VALUES(?1,?2)",
      ).bind(publicationRef, createdAt);
      const attemptComplete = options.database.prepare(
        "UPDATE operation_attempt SET state='SUCCEEDED',ended_at=?2 WHERE attempt_id=?1 AND state='STARTED'",
      ).bind(attemptId, createdAt);
      const statements = [...intentPlan.statements, attemptInsert, operationReceiptInsert, publicationInsert,
        headUpsert, headCasGuard, attemptComplete];
      try {
        const results = await options.database.batch(statements);
        intentPlan.assertBatchResults(results, 0);
        if (results.length !== statements.length || results.slice(2).some((result) => result?.success !== true || (result.meta?.changes ?? 0) !== 1)) {
          fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "publication transaction did not mutate all expected rows", true);
        }
      } catch (cause) {
        const raced = await readPublicationRow(options.database, artifactRef).catch(() => null);
        if (raced !== null && raced.intent_id === intent.intent_ref.id && raced.intent_revision === intent.intent_ref.revision) {
          const receipt = await validatePersistedPublication(raced, {
            principal_ref: principal,
            intent,
            payload_sha256: requestSha,
            expected_publication_revision: expectedPublicationRevision,
            readiness,
            acceptance_decision: acceptanceDecision,
            acceptance_decision_sha256: acceptanceDecisionSha,
          });
          const replay = await readValidated(input);
          if (replay !== null && replay.receipt.publication_ref === receipt.publication_ref) return { ...replay, disposition: "EXISTING" };
        }
        if (cause instanceof ArtifactPublicationError) throw cause;
        fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "publication transaction failed or may have committed", true, cause);
      }

      let committed = await readPublicationRow(options.database, artifactRef);
      if (committed === null || committed.publication_ref !== publicationRef) {
        fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "publication receipt readback is missing", true);
      }
      const receipt = await validatePersistedPublication(committed, {
        principal_ref: principal,
        intent,
        payload_sha256: requestSha,
        expected_publication_revision: expectedPublicationRevision,
        readiness,
        acceptance_decision: acceptanceDecision,
        acceptance_decision_sha256: acceptanceDecisionSha,
      });
      const postCommit = await readValidated(input);
      if (postCommit === null || postCommit.receipt.publication_ref !== receipt.publication_ref) {
        fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "committed publication failed exact readback validation", true);
      }
      const reconciliation = await options.database.prepare(
        "UPDATE operation_receipt SET reconciliation_required=0 WHERE receipt_id=?1 AND revision=?2 AND reconciliation_required=1 " +
        "AND EXISTS(SELECT 1 FROM artifact_publication_receipt p WHERE p.operation_receipt_id=operation_receipt.receipt_id " +
        "AND p.operation_receipt_revision=operation_receipt.revision AND p.publication_ref=?3)",
      ).bind(operationReceiptId, 1, publicationRef).run();
      if (!reconciliation.success || (reconciliation.meta?.changes ?? 0) !== 1) {
        fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "canonical operation reconciliation did not update exactly one receipt", true);
      }
      committed = await readPublicationRow(options.database, artifactRef);
      if (committed === null || committed.operation_reconciliation_required !== 0 || committed.publication_ref !== publicationRef) {
        fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "publication reconciliation readback is incomplete", true);
      }
      const final = await readValidated(input);
      if (final === null || final.receipt.publication_ref !== publicationRef || final.revision.status !== "ACCEPTED") {
        fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "final accepted publication readback is incomplete", true);
      }
      return { ...final, disposition: "CREATED" };
    },

    async read(input: ReadArtifactPublicationInput): Promise<ArtifactPublicationRead | null> {
      return readValidated(input);
    },
  };
}

export type ArtifactPublicationDraftReadError = ArtifactDraftReadError;
