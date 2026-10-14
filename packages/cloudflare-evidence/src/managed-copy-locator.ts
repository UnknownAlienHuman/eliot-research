import type { LocatorCandidate } from "@eliotr/contracts";
import {
  assertEvidenceIdentifier,
  assertEvidenceInteger,
  assertEvidenceSha256,
  canonicalEvidenceJson,
  evidenceSha256Bytes,
  evidenceUtf8Bytes,
} from "./canonical.js";
import {
  EvidenceRuntimeError,
  type EvidenceSourceAuthority,
  type ScopeAuthority,
} from "./types.js";

const COPY_METADATA_MARKERS = [
  "provider_project_folder",
  "provider_project_id",
  "provider_project_membership_id",
] as const;
const ITEM_KEY = /^projection-[a-f0-9]{48}$/u;
const PROVIDER_KEY = /^projection\/[A-Za-z0-9_-]{43}\/projection-[a-f0-9]{48}\.md$/u;
const EFFECT_METADATA_KEYS = [
  "canonical_section_id",
  "content_sha256",
  "instruction_taint",
  "projection_generation",
  "source_revision_ref",
] as const;
const READBACK_KEYS = [
  "chunks_count",
  "content_sha256",
  "file_size",
  "item_key",
  "provider_item_id",
  "provider_key",
  "readback_sha256",
] as const;

export interface ManagedCopyCanonicalLocator {
  readonly source_revision_ref: string;
  readonly physical_item_key: string;
  readonly provider_key: string;
  readonly canonical_projection_generation: string;
  readonly canonical_item_key: string;
  readonly canonical_section_id: string;
  readonly content_sha256: string;
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
  readonly project_id: string;
  readonly project_membership_id: string;
  readonly membership_generation: number;
  readonly managed_instance_id: string;
  readonly managed_generation: string;
  readonly target_namespace: string;
  readonly target_profile_identity_sha256: string;
  readonly semantic_receipt_ref: string;
  readonly readback_sha256: string;
  readonly provider_item_id: string;
}

interface ManagedCopyRow {
  readonly item_key: unknown;
  readonly source_revision_ref: unknown;
  readonly canonical_projection_generation: unknown;
  readonly canonical_item_key: unknown;
  readonly project_id: unknown;
  readonly project_membership_id: unknown;
  readonly membership_generation: unknown;
  readonly copy_layout: unknown;
  readonly metadata_generation_digest: unknown;
  readonly canonical_body_ref: unknown;
  readonly canonical_body_sha256: unknown;
  readonly normalized_start_byte: unknown;
  readonly normalized_end_byte: unknown;
  readonly provider_key: unknown;
  readonly section_content_sha256: unknown;
  readonly document_sha256: unknown;
  readonly document_size_bytes: unknown;
  readonly metadata_json: unknown;
  readonly state: unknown;
  readonly provider_item_id: unknown;
  readonly readback_receipt_json: unknown;
  readonly readback_sha256: unknown;
  readonly dispatch_lease_generation: unknown;
  readonly managed_instance_id: unknown;
  readonly managed_generation: unknown;
  readonly generation_canonical_projection_generation: unknown;
  readonly item_count: unknown;
  readonly item_set_digest: unknown;
  readonly canonical_item_count: unknown;
  readonly canonical_item_set_digest: unknown;
  readonly provider_copy_count: unknown;
  readonly provider_copy_set_digest: unknown;
  readonly managed_item_protocol: unknown;
  readonly managed_target_instance_id: unknown;
  readonly managed_target_generation: unknown;
  readonly managed_target_metadata_generation_digest: unknown;
  readonly semantic_instance_id: unknown;
  readonly semantic_generation: unknown;
  readonly semantic_receipt_ref: unknown;
  readonly semantic_readback_digest: unknown;
  readonly generation_state: unknown;
  readonly job_state: unknown;
  readonly terminal_receipt_ref: unknown;
  readonly terminal_outcome: unknown;
  readonly terminal_verified: unknown;
  readonly readiness_state: unknown;
  readonly readiness_generation: unknown;
  readonly readiness_receipt_ref: unknown;
  readonly source_owner_generation: unknown;
  readonly source_content_sha256: unknown;
  readonly source_residency_digest: unknown;
  readonly purge_state: unknown;
  readonly owner_status: unknown;
  readonly active_owner_generation: unknown;
  readonly admission_decision_receipt_ref: unknown;
  readonly instruction_taint: unknown;
  readonly admission_expires_at: unknown;
  readonly active_membership_generation: unknown;
  readonly current_project_membership_generation: unknown;
  readonly target_namespace: unknown;
  readonly target_profile_identity_sha256: unknown;
}

const MANAGED_COPY_AUTHORITY_SQL =
  "SELECT e.item_key,e.source_revision_ref,e.canonical_projection_generation," +
  "e.canonical_item_key,e.project_id,e.project_membership_id,e.membership_generation," +
  "e.copy_layout,e.metadata_generation_digest,e.canonical_body_ref,e.canonical_body_sha256," +
  "e.normalized_start_byte,e.normalized_end_byte,e.provider_key,e.section_content_sha256," +
  "e.document_sha256,e.document_size_bytes,e.metadata_json,e.state,e.provider_item_id," +
  "e.readback_receipt_json,e.readback_sha256,e.dispatch_lease_generation," +
  "e.managed_instance_id,e.managed_generation," +
  "g.canonical_projection_generation AS generation_canonical_projection_generation," +
  "g.item_count,g.item_set_digest,g.canonical_item_count,g.canonical_item_set_digest," +
  "g.provider_copy_count,g.provider_copy_set_digest,g.managed_item_protocol," +
  "g.managed_target_instance_id,g.managed_target_generation," +
  "g.managed_target_metadata_generation_digest,g.semantic_instance_id,g.semantic_generation," +
  "g.semantic_receipt_ref,g.semantic_readback_digest,g.state AS generation_state," +
  "j.state AS job_state,j.terminal_receipt_ref,t.outcome AS terminal_outcome," +
  "t.verified AS terminal_verified,r.state AS readiness_state,r.generation AS readiness_generation," +
  "r.receipt_ref AS readiness_receipt_ref,sr.source_owner_generation," +
  "sr.content_sha256 AS source_content_sha256," +
  "sr.object_residency_key_digest AS source_residency_digest,sr.purge_state," +
  "own.status AS owner_status,own.source_owner_generation AS active_owner_generation," +
  "d.decision_receipt_ref AS admission_decision_receipt_ref," +
  "d.instruction_taint,d.expires_at AS admission_expires_at," +
  "m.membership_generation AS active_membership_generation," +
  "p.membership_generation AS current_project_membership_generation," +
  "a.target_namespace,a.target_profile_identity_sha256 " +
  "FROM projection_managed_item_effect e " +
  "JOIN projection_generation g ON g.source_revision_ref=e.source_revision_ref " +
  "AND g.projection_generation=e.projection_generation AND g.job_id=e.job_id " +
  "JOIN job j ON j.job_id=e.job_id " +
  "JOIN projection_terminal_guard t ON t.source_revision_ref=e.source_revision_ref " +
  "AND t.projection_generation=e.projection_generation AND t.job_id=e.job_id " +
  "JOIN operation_receipt tr ON tr.receipt_id=t.terminal_receipt_id " +
  "AND tr.revision=t.terminal_receipt_revision " +
  "JOIN source_revision sr ON sr.source_revision_ref=e.source_revision_ref " +
  "JOIN source s ON s.source_id=sr.source_id " +
  "JOIN source_namespace_ownership own ON own.source_namespace_id=s.source_namespace_id " +
  "AND own.owner_system_id=s.source_owner_system_id " +
  "AND own.source_owner_generation=sr.source_owner_generation " +
  "JOIN source_admission_decision d ON d.source_revision_ref=sr.source_revision_ref " +
  "AND d.source_owner_generation=sr.source_owner_generation AND d.decision='ADMITTED' " +
  "AND d.decision_receipt_ref=(SELECT chosen.decision_receipt_ref " +
  "FROM source_admission_decision chosen WHERE chosen.source_revision_ref=sr.source_revision_ref " +
  "AND chosen.decision='ADMITTED' " +
  "ORDER BY chosen.created_at DESC,chosen.decision_receipt_ref DESC LIMIT 1) " +
  "JOIN project_source_membership m ON m.source_id=sr.source_id " +
  "AND m.project_id=e.project_id AND m.membership_generation=e.membership_generation " +
  "JOIN project p ON p.project_id=m.project_id " +
  "AND p.membership_generation=m.membership_generation " +
  "JOIN managed_target_assignment_current a ON a.project_id=e.project_id " +
  "AND a.event_kind='ASSIGN' AND a.managed_instance_id=e.managed_instance_id " +
  "AND a.managed_generation=e.managed_generation " +
  "JOIN managed_target_assignment_event ae ON ae.project_id=a.project_id " +
  "AND ae.event_revision=a.event_revision " +
  "JOIN project_owner po ON po.project_id=p.project_id " +
  "AND po.principal_ref=ae.project_owner_principal_ref " +
  "JOIN source_readiness r ON r.source_revision_ref=e.source_revision_ref " +
  "AND r.channel='semantic_ready' AND r.state='ready' " +
  "AND r.generation=e.managed_generation AND r.receipt_ref=g.semantic_receipt_ref " +
  "WHERE e.source_revision_ref=?1 AND e.item_key=?2 AND e.provider_key=?3 " +
  "AND e.managed_generation=?4 AND e.copy_layout='PROJECT_COPY_V1' " +
  "AND e.state='READBACK_VERIFIED' AND e.dispatch_lease_generation IS NOT NULL " +
  "AND e.provider_item_id IS NOT NULL AND e.readback_receipt_json IS NOT NULL " +
  "AND e.readback_sha256 IS NOT NULL " +
  "AND g.managed_item_protocol='eliotr.managed-item-effects.v1' " +
  "AND g.state='COMPLETED' AND g.managed_target_instance_id=e.managed_instance_id " +
  "AND g.managed_target_generation=e.managed_generation " +
  "AND g.managed_target_metadata_generation_digest=e.metadata_generation_digest " +
  "AND g.canonical_projection_generation=e.canonical_projection_generation " +
  "AND g.item_count=g.canonical_item_count AND g.item_set_digest=g.canonical_item_set_digest " +
  "AND g.provider_copy_count BETWEEN 1 AND 256 AND g.provider_copy_set_digest IS NOT NULL " +
  "AND g.semantic_instance_id=e.managed_instance_id AND g.semantic_generation=e.managed_generation " +
  "AND g.semantic_receipt_ref IS NOT NULL AND g.semantic_readback_digest IS NOT NULL " +
  "AND j.state='COMPLETED' AND j.terminal_receipt_ref IS NOT NULL " +
  "AND t.outcome='SUCCEEDED' AND t.verified=1 AND tr.outcome='SUCCEEDED' " +
  "AND own.status='ACTIVE' AND own.source_owner_generation=sr.source_owner_generation " +
  "AND sr.purge_state='LIVE' AND d.object_residency_key_digest=sr.object_residency_key_digest " +
  "AND (d.expires_at IS NULL OR julianday(d.expires_at)>julianday(?5)) " +
  "AND m.valid_from<=?5 AND (m.valid_to IS NULL OR ?5<m.valid_to) " +
  "AND EXISTS (SELECT 1 FROM scope_snapshot ss WHERE ss.snapshot_id=?6 " +
  "AND ss.revision=?7 AND ss.snapshot_digest=?8 AND ss.invalidated_at IS NULL " +
  "AND ss.expires_at>?5) " +
  "AND EXISTS (SELECT 1 FROM json_each(?9) member WHERE member.value=sr.source_revision_ref) " +
  "AND (a.target_namespace=?10 OR ?10 IS NULL) " +
  "LIMIT 2";

export function isManagedCopyLocatorCandidate(candidate: LocatorCandidate): boolean {
  const metadata = candidate.metadata as Readonly<Record<string, unknown>>;
  return COPY_METADATA_MARKERS.some((key) => metadata[key] !== undefined) ||
    (typeof metadata.provider_item_key === "string" && metadata.provider_item_key.includes("/"));
}

function invalid(message: string): never {
  throw new EvidenceRuntimeError("EVIDENCE_LOCATOR_NOT_RESOLVABLE", message);
}

function unavailable(cause: unknown): never {
  throw new EvidenceRuntimeError(
    "EVIDENCE_SETTLEMENT_UNCERTAIN",
    "Core project-copy authority read failed",
    { retryable: true, cause },
  );
}

function requiredString(value: unknown, label: string): string {
  return assertEvidenceIdentifier(value, label);
}

function optionalString(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = metadata[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid("project-copy locator metadata is malformed");
  return value;
}

function exactJsonObject(
  raw: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof raw !== "string") invalid(label + " is not JSON text");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new EvidenceRuntimeError("EVIDENCE_LOCATOR_NOT_RESOLVABLE", label + " is malformed", { cause });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(label + " is not an object");
  }
  const record = value as Record<string, unknown>;
  const observed = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (observed.length !== expected.length ||
      observed.some((key, index) => key !== expected[index]) ||
      canonicalEvidenceJson(record) !== raw) {
    invalid(label + " does not have the exact canonical fields");
  }
  return record;
}

function generationMetadataDigest(generation: string): Promise<string> {
  return evidenceSha256Bytes(
    evidenceUtf8Bytes("eliotr.project-copy-generation.v1\u0000" + generation),
  );
}

function assertSourceAndScope(
  candidate: LocatorCandidate,
  source: EvidenceSourceAuthority,
  scope: ScopeAuthority,
  nowMs: number,
): void {
  if (
    candidate.source_revision_ref !== source.source_revision_ref ||
    source.purge_state !== "LIVE" ||
    scope.invalidated_at !== null ||
    !scope.snapshot.member_source_revision_refs.includes(source.source_revision_ref) ||
    scope.snapshot.source_owner_generations[source.source_revision_ref] !== source.source_owner_generation ||
    Date.parse(scope.snapshot.expires_at) <= nowMs
  ) {
    invalid("project-copy locator source, owner, purge, or ScopeSnapshot is no longer current");
  }
}

export async function resolveManagedCopyLocator(
  database: D1Database,
  candidate: LocatorCandidate,
  source: EvidenceSourceAuthority,
  scope: ScopeAuthority,
  nowMs: number,
): Promise<ManagedCopyCanonicalLocator> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    invalid("project-copy locator clock is invalid");
  }
  assertSourceAndScope(candidate, source, scope, nowMs);
  const metadata = candidate.metadata as Readonly<Record<string, unknown>>;
  const providerKey = requiredString(metadata.provider_item_key, "provider item key");
  if (new TextEncoder().encode(providerKey).byteLength > 128 || !PROVIDER_KEY.test(providerKey)) {
    invalid("project-copy provider key is not canonical");
  }
  const slash = providerKey.lastIndexOf("/");
  const providerFolder = providerKey.slice(0, slash + 1);
  const physicalItemKey = providerKey.slice(slash + 1, -3);
  if (!ITEM_KEY.test(physicalItemKey)) invalid("project-copy physical item key is invalid");

  const metadataItemKey = optionalString(metadata, "item_key");
  const metadataFolder = optionalString(metadata, "provider_project_folder");
  const metadataProject = optionalString(metadata, "provider_project_id");
  const metadataMembership = optionalString(metadata, "provider_project_membership_id");
  const metadataNamespace = optionalString(metadata, "provider_namespace");
  const metadataGeneration = optionalString(metadata, "projection_generation");
  const metadataSourceRevision = optionalString(metadata, "source_revision_ref");
  const metadataTaint = optionalString(metadata, "instruction_taint");
  const metadataContentDigest = assertEvidenceSha256(
    metadata.content_sha256,
    "project-copy content digest",
  );
  const managedGeneration = assertEvidenceIdentifier(candidate.index_generation, "managed provider generation");
  if (
    metadataItemKey !== undefined && metadataItemKey !== physicalItemKey ||
    metadataFolder !== undefined && metadataFolder !== providerFolder ||
    metadataGeneration !== undefined && metadataGeneration !== managedGeneration ||
    metadataSourceRevision !== undefined && metadataSourceRevision !== candidate.source_revision_ref ||
    metadataTaint !== undefined && metadataTaint !== source.instruction_taint ||
    metadataProject !== undefined && metadataMembership === undefined ||
    metadataMembership !== undefined && metadataProject === undefined
  ) {
    invalid("project-copy locator provenance differs from its provider key or generation");
  }

  const nowIso = new Date(nowMs).toISOString();
  let result: D1Result<ManagedCopyRow>;
  try {
    result = await database.prepare(MANAGED_COPY_AUTHORITY_SQL).bind(
      candidate.source_revision_ref,
      physicalItemKey,
      providerKey,
      managedGeneration,
      nowIso,
      scope.snapshot.snapshot_id,
      scope.snapshot.revision,
      scope.snapshot.digest,
      JSON.stringify(scope.snapshot.member_source_revision_refs),
      metadataNamespace ?? null,
    ).all<ManagedCopyRow>();
  } catch (cause) {
    unavailable(cause);
  }
  if (!result.success || !Array.isArray(result.results)) {
    unavailable(new Error("Core project-copy authority read was unsuccessful"));
  }
  if (result.results.length !== 1) {
    invalid("project-copy locator does not resolve to one current Core effect map");
  }
  const row = result.results[0];
  if (row === undefined) invalid("Core project-copy effect map is missing");

  const itemKey = requiredString(row.item_key, "Core physical item key");
  const sourceRevisionRef = requiredString(row.source_revision_ref, "Core effect source revision");
  const canonicalGeneration = requiredString(
    row.canonical_projection_generation,
    "Core canonical projection generation",
  );
  const canonicalItemKey = requiredString(row.canonical_item_key, "Core canonical item key");
  const projectId = requiredString(row.project_id, "Core project id");
  const membershipId = requiredString(row.project_membership_id, "Core project membership id");
  const membershipGeneration = assertEvidenceInteger(
    row.membership_generation,
    "Core membership generation",
    1,
  );
  const managedInstanceId = requiredString(row.managed_instance_id, "Core managed instance id");
  const rowManagedGeneration = requiredString(row.managed_generation, "Core managed generation");
  const targetNamespace = requiredString(row.target_namespace, "Core target namespace");
  const targetProfileDigest = assertEvidenceSha256(
    row.target_profile_identity_sha256,
    "Core target profile identity",
  );
  const providerKeyReadback = requiredString(row.provider_key, "Core provider key");
  const contentDigest = assertEvidenceSha256(row.section_content_sha256, "Core section content digest");
  const bodyDigest = assertEvidenceSha256(row.canonical_body_sha256, "Core canonical body digest");
  const canonicalSection = requiredString(candidate.canonical_section_id, "candidate canonical section id");
  const canonicalBodyRef = requiredString(row.canonical_body_ref, "Core canonical body reference");
  const targetDigest = assertEvidenceSha256(
    row.metadata_generation_digest,
    "Core target metadata generation digest",
  );
  const itemCount = assertEvidenceInteger(row.item_count, "Core canonical item count", 1, 1024);
  const canonicalItemCount = assertEvidenceInteger(
    row.canonical_item_count,
    "Core canonical receipt count",
    1,
    1024,
  );
  const providerCopyCount = assertEvidenceInteger(row.provider_copy_count, "Core provider copy count", 1, 256);
  const itemSetDigest = assertEvidenceSha256(row.item_set_digest, "Core Work item set digest");
  const canonicalItemSetDigest = assertEvidenceSha256(
    row.canonical_item_set_digest,
    "Core canonical item set digest",
  );
  const providerCopySetDigest = assertEvidenceSha256(
    row.provider_copy_set_digest,
    "Core provider copy set digest",
  );
  const semanticReadbackDigest = assertEvidenceSha256(
    row.semantic_readback_digest,
    "Core semantic readback digest",
  );
  assertEvidenceSha256(row.document_sha256, "Core provider document digest");
  assertEvidenceInteger(row.document_size_bytes, "Core provider document size", 1, 4 * 1024 * 1024);
  const start = assertEvidenceInteger(row.normalized_start_byte, "Core normalized range start");
  const end = assertEvidenceInteger(row.normalized_end_byte, "Core normalized range end", start + 1);
  const readbackSha = assertEvidenceSha256(row.readback_sha256, "Core effect readback digest");
  const providerItemId = requiredString(row.provider_item_id, "Core provider item id");
  const semanticReceipt = requiredString(row.semantic_receipt_ref, "Core semantic receipt");

  if (
    sourceRevisionRef !== source.source_revision_ref ||
    row.source_owner_generation !== source.source_owner_generation ||
    row.source_content_sha256 !== source.content_sha256 ||
    row.source_residency_digest !== source.object_residency_key_digest ||
    row.purge_state !== "LIVE" ||
    row.owner_status !== "ACTIVE" ||
    row.active_owner_generation !== source.source_owner_generation ||
    row.admission_decision_receipt_ref !== source.admission_receipt_ref ||
    row.instruction_taint !== source.instruction_taint ||
    row.copy_layout !== "PROJECT_COPY_V1" ||
    itemKey !== physicalItemKey ||
    providerKeyReadback !== providerKey ||
    rowManagedGeneration !== managedGeneration ||
    row.generation_canonical_projection_generation !== canonicalGeneration ||
    row.managed_item_protocol !== "eliotr.managed-item-effects.v1" ||
    row.managed_target_instance_id !== managedInstanceId ||
    row.managed_target_generation !== managedGeneration ||
    row.semantic_instance_id !== managedInstanceId ||
    row.semantic_generation !== managedGeneration ||
    row.generation_state !== "COMPLETED" ||
    row.job_state !== "COMPLETED" ||
    row.terminal_outcome !== "SUCCEEDED" ||
    row.terminal_verified !== 1 ||
    typeof row.terminal_receipt_ref !== "string" ||
    row.readiness_state !== "ready" ||
    row.readiness_generation !== managedGeneration ||
    row.readiness_receipt_ref !== semanticReceipt ||
    canonicalItemCount !== itemCount ||
    canonicalItemSetDigest !== itemSetDigest ||
    providerCopyCount < 1 ||
    providerCopySetDigest.length !== 64 ||
    semanticReadbackDigest.length !== 64 ||
    row.active_membership_generation !== membershipGeneration ||
    row.current_project_membership_generation !== membershipGeneration ||
    (metadataProject !== undefined && metadataProject !== projectId) ||
    (metadataMembership !== undefined && metadataMembership !== membershipId) ||
    (metadataNamespace !== undefined && metadataNamespace !== targetNamespace) ||
    canonicalSection.length === 0 ||
    contentDigest !== metadataContentDigest ||
    bodyDigest !== contentDigest ||
    canonicalBodyRef.length === 0 ||
    targetDigest !== await generationMetadataDigest(managedGeneration)
  ) {
    invalid("Core project-copy effect, source, target, or readiness identity is inconsistent");
  }
  if (membershipId !== "project:" + projectId + ":generation:" + membershipGeneration) {
    invalid("Core project-copy membership identity is inconsistent");
  }

  const effectMetadata = exactJsonObject(row.metadata_json, EFFECT_METADATA_KEYS, "Core effect metadata");
  if (
    effectMetadata.canonical_section_id !== canonicalSection ||
    effectMetadata.content_sha256 !== contentDigest ||
    effectMetadata.instruction_taint !== source.instruction_taint ||
    effectMetadata.projection_generation !== targetDigest ||
    effectMetadata.source_revision_ref !== sourceRevisionRef
  ) {
    invalid("Core effect metadata does not bind the current source and canonical section");
  }

  const readback = exactJsonObject(row.readback_receipt_json, READBACK_KEYS, "Core provider readback");
  if (
    readback.item_key !== itemKey ||
    readback.provider_item_id !== providerItemId ||
    readback.provider_key !== providerKeyReadback ||
    readback.file_size !== row.document_size_bytes ||
    readback.content_sha256 !== row.document_sha256 ||
    readback.readback_sha256 !== readbackSha ||
    typeof readback.chunks_count !== "number" ||
    !Number.isSafeInteger(readback.chunks_count) ||
    readback.chunks_count < 1 ||
    row.state !== "READBACK_VERIFIED" ||
    typeof row.dispatch_lease_generation !== "number" ||
    !Number.isSafeInteger(row.dispatch_lease_generation) ||
    row.dispatch_lease_generation < 1
  ) {
    invalid("Core effect has no exact readback-verified provider receipt");
  }

  return Object.freeze({
    source_revision_ref: sourceRevisionRef,
    physical_item_key: itemKey,
    provider_key: providerKeyReadback,
    canonical_projection_generation: canonicalGeneration,
    canonical_item_key: canonicalItemKey,
    canonical_section_id: canonicalSection,
    content_sha256: contentDigest,
    normalized_start_byte: start,
    normalized_end_byte: end,
    project_id: projectId,
    project_membership_id: membershipId,
    membership_generation: membershipGeneration,
    managed_instance_id: managedInstanceId,
    managed_generation: rowManagedGeneration,
    target_namespace: targetNamespace,
    target_profile_identity_sha256: targetProfileDigest,
    semantic_receipt_ref: semanticReceipt,
    readback_sha256: readbackSha,
    provider_item_id: providerItemId,
  });
}

export function sameManagedCopyLocator(
  left: ManagedCopyCanonicalLocator,
  right: ManagedCopyCanonicalLocator,
): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}
