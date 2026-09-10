import {
  ArtifactRevisionSchema,
  ArtifactSpecSchema,
  ObjectResidencyKeySchema,
  OperationIntentSchema,
  VersionedRefSchema,
  type ArtifactRevision,
  type ArtifactSpec,
  type ObjectResidencyKey,
  type OperationIntent,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  createNavigationReadAuthority,
  loadScopeAuthority,
  type D1NavigationStoreInput,
  type EvidenceAccessContext,
} from "@eliotr/cloudflare-evidence";
import {
  RUNTIME_LIMITS,
  bufferBounded,
  canonicalDigest,
  canonicalEvidenceObjectKey,
  canonicalJson,
  createR2EvidenceObjectStore,
  objectResidencyKeyDigest,
  type EvidenceObjectStore,
  type ImmutableObjectReceipt,
} from "@eliotr/platform-cloudflare";

const MANIFEST_PREFIX = "artifact-draft/manifest";
const SECTION_PREFIX = "artifact-draft/section";
const REFERENCE_PREFIX = "artifact-draft/reference";
const SHA256 = /^[a-f0-9]{64}$/u;

export type ArtifactDraftReadErrorCode =
  | "ARTIFACT_REF_INVALID"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_ACCESS_DENIED"
  | "ARTIFACT_SCOPE_STALE"
  | "ARTIFACT_INTEGRITY_INVALID"
  | "ARTIFACT_READ_UNAVAILABLE";

export class ArtifactDraftReadError extends Error {
  public readonly code: ArtifactDraftReadErrorCode;
  public readonly status: 400 | 403 | 404 | 409 | 410 | 503;
  public readonly retryable: boolean;

  public constructor(
    code: ArtifactDraftReadErrorCode,
    status: 400 | 403 | 404 | 409 | 410 | 503,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "ArtifactDraftReadError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface ArtifactDraftReadInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly artifact_ref: VersionedRef;
  readonly access: EvidenceAccessContext;
  readonly require_current: D1NavigationStoreInput["require_current"];
  readonly now?: () => number;
}

interface ArtifactRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly kind: unknown;
  readonly spec_digest: unknown;
  readonly evidence_freeze_id: unknown;
  readonly evidence_freeze_revision: unknown;
  readonly manifest_r2_key: unknown;
  readonly dependency_manifest_ref: unknown;
  readonly status: unknown;
  readonly created_at: unknown;
}

interface BindingRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly expected_head_revision: unknown;
  readonly principal_ref: unknown;
  readonly spec_ref_id: unknown;
  readonly spec_ref_revision: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly manifest_r2_key: unknown;
  readonly manifest_sha256: unknown;
  readonly manifest_size_bytes: unknown;
  readonly created_at: unknown;
}

interface ReservationRow {
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly artifact_id: unknown;
  readonly artifact_revision: unknown;
  readonly request_sha256: unknown;
  readonly spec_digest: unknown;
  readonly manifest_r2_key: unknown;
  readonly expected_head_revision: unknown;
  readonly spec_ref_id: unknown;
  readonly spec_ref_revision: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly intent_json: unknown;
  readonly principal_ref: unknown;
  readonly idempotency_key: unknown;
  readonly payload_ref: unknown;
  readonly topic: unknown;
  readonly planned_objects_json: unknown;
  readonly state: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface AuthorityRow {
  readonly intent_id: unknown;
  readonly revision: unknown;
  readonly operation_kind: unknown;
  readonly principal_ref: unknown;
  readonly idempotency_key: unknown;
  readonly payload_ref: unknown;
  readonly policy_decision_ref: unknown;
  readonly budget_reservation_ref: unknown;
  readonly cancellation_ref: unknown;
  readonly created_at: unknown;
  readonly outbox_id: unknown;
  readonly topic: unknown;
  readonly payload_sha256: unknown;
}

interface HeadRow {
  readonly artifact_id: unknown;
  readonly head_revision: unknown;
  readonly manifest_r2_key: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly updated_at: unknown;
}

interface ObjectRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly object_kind: unknown;
  readonly object_ref: unknown;
  readonly section_ordinal: unknown;
  readonly receipt_json: unknown;
  readonly residency_key_json: unknown;
  readonly residency_key_digest: unknown;
  readonly created_at: unknown;
}

type DraftObjectKind = "MANIFEST" | "SECTION_BODY" | "DEPENDENCY_MANIFEST" | "EVIDENCE_LEDGER" | "VERIFICATION_RECEIPT" | "EXPORT";

interface ExpectedObject {
  readonly object_ref: string;
  readonly object_kind: DraftObjectKind;
  readonly section_ordinal: number | null;
  readonly sha256?: string;
  readonly prefix: string;
  readonly content_type: string;
}

interface StoredObject {
  readonly row: ObjectRow;
  readonly receipt: ImmutableObjectReceipt;
  readonly residency: ObjectResidencyKey;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly physical_key: string;
  readonly bytes: Uint8Array;
}

function fail(code: ArtifactDraftReadErrorCode, status: 400 | 403 | 404 | 409 | 410 | 503, message: string, retryable = false): never {
  throw new ArtifactDraftReadError(code, status, message, retryable);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) fail("ARTIFACT_INTEGRITY_INVALID", 409, `${label} is invalid`);
  return value;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("ARTIFACT_INTEGRITY_INVALID", 409, `${label} is invalid`);
  return value as number;
}

function optionalPositive(value: unknown, label: string): number | null {
  if (value === null) return null;
  return positive(value, label);
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") fail("ARTIFACT_INTEGRITY_INVALID", 409, `${label} is invalid`);
  try { return JSON.parse(value); }
  catch { fail("ARTIFACT_INTEGRITY_INVALID", 409, `${label} is invalid`); }
}

function parseCanonical(value: unknown, label: string): unknown {
  const parsed = parseJson(value, label);
  if (canonicalJson(parsed) !== value) fail("ARTIFACT_INTEGRITY_INVALID", 409, `${label} is not canonical`);
  return parsed;
}

function parseReceipt(value: unknown): ImmutableObjectReceipt {
  const parsed = parseCanonical(value, "draft object receipt");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object receipt is invalid");
  const receipt = parsed as Record<string, unknown>;
  const keys = ["key", "expected_sha256", "readback_sha256", "size_bytes", "etag", "existed_identically"];
  if (Object.keys(receipt).some((key) => !keys.includes(key)) ||
      typeof receipt.key !== "string" || typeof receipt.expected_sha256 !== "string" || !SHA256.test(receipt.expected_sha256) ||
      typeof receipt.readback_sha256 !== "string" || !SHA256.test(receipt.readback_sha256) ||
      !Number.isSafeInteger(receipt.size_bytes) || (receipt.size_bytes as number) < 0 ||
      typeof receipt.etag !== "string" || typeof receipt.existed_identically !== "boolean") {
    fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object receipt is invalid");
  }
  return receipt as unknown as ImmutableObjectReceipt;
}

function mapAuthorityFailure(error: unknown): never {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { readonly code?: unknown }).code : undefined;
  if (code === "EVIDENCE_AUTHORIZATION_DENIED" || code === "NAVIGATION_SCOPE_MISMATCH") fail("ARTIFACT_ACCESS_DENIED", 403, "draft read authorization denied");
  if (code === "EVIDENCE_SCOPE_EXPIRED" || code === "EVIDENCE_SCOPE_INVALIDATED" || code === "SCOPE_SNAPSHOT_STALE" || code === "NAVIGATION_SCOPE_NOT_CURRENT") fail("ARTIFACT_SCOPE_STALE", 410, "draft read scope is stale");
  if (code === "EVIDENCE_INPUT_INVALID" || code === "SCOPE_SNAPSHOT_READBACK_MISMATCH") fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft read authority is inconsistent");
  fail("ARTIFACT_READ_UNAVAILABLE", 503, "draft read authority is unavailable", true);
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readStoredObject(store: EvidenceObjectStore, row: ObjectRow, expected: ExpectedObject): Promise<StoredObject> {
  if (row.object_kind !== expected.object_kind || row.object_ref !== expected.object_ref || row.section_ordinal !== expected.section_ordinal) {
    fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object mapping is inconsistent");
  }
  const receipt = parseReceipt(row.receipt_json);
  let residency: ObjectResidencyKey;
  try { residency = ObjectResidencyKeySchema.parse(parseCanonical(row.residency_key_json, "draft residency")); }
  catch { fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft residency is invalid"); }
  const sha256 = receipt.expected_sha256;
  if (receipt.readback_sha256 !== sha256 || residency.content_digest.digest !== sha256 ||
      row.residency_key_digest !== await objectResidencyKeyDigest(residency)) {
    fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object integrity is inconsistent");
  }
  if (expected.sha256 !== undefined && expected.sha256 !== sha256) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft declared digest is inconsistent");
  const physicalKey = await canonicalEvidenceObjectKey(residency, expected.prefix, sha256);
  if (receipt.key !== physicalKey) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object key is inconsistent");
  let stored: R2ObjectBody | null;
  try { stored = await store.open(physicalKey); }
  catch { fail("ARTIFACT_READ_UNAVAILABLE", 503, "draft object read is unavailable", true); }
  if (stored === null) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object is missing");
  const metadata = stored.customMetadata ?? {};
  if (stored.etag !== receipt.etag || stored.size !== receipt.size_bytes ||
      stored.httpMetadata?.contentType !== expected.content_type || Object.keys(metadata).length !== 3 ||
      metadata.eliotr_sha256 !== sha256 || metadata.eliotr_size_bytes !== String(receipt.size_bytes) || metadata.eliotr_immutable !== "true") {
    fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object metadata is inconsistent");
  }
  let actual: Uint8Array;
  try { actual = await bufferBounded(stored.body, RUNTIME_LIMITS.buffered_r2_bytes); }
  catch { fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object body is unreadable"); }
  if (actual.byteLength !== receipt.size_bytes || await digestBytes(actual) !== sha256) {
    fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object bytes are inconsistent");
  }
  return { row, receipt, residency, sha256, size_bytes: actual.byteLength, physical_key: physicalKey, bytes: actual };
}

function addExpected(map: Map<string, ExpectedObject>, expected: ExpectedObject): void {
  if (map.has(expected.object_ref)) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object references are duplicated");
  map.set(expected.object_ref, expected);
}

function parseManifest(bytes: Uint8Array): { readonly spec: ArtifactSpec; readonly revision: ArtifactRevision } {
  let manifestText: string;
  try { manifestText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft manifest encoding is invalid"); }
  const raw = parseCanonical(manifestText, "draft manifest");
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft manifest is invalid");
  try {
    const value = raw as { readonly spec?: unknown; readonly revision?: unknown };
    const spec = ArtifactSpecSchema.parse(value.spec);
    const revision = ArtifactRevisionSchema.parse(value.revision);
    return { spec, revision };
  } catch { fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft manifest contract is invalid"); }
}

async function readArtifactDraftInternal(input: ArtifactDraftReadInput, artifactRef: VersionedRef): Promise<ArtifactRevision | null> {
  const { database } = input;
  const artifact = await database.prepare(
    "SELECT artifact_id, revision, kind, spec_digest, evidence_freeze_id, evidence_freeze_revision, manifest_r2_key, dependency_manifest_ref, status, created_at FROM artifact_revision WHERE artifact_id=?1 AND revision=?2 LIMIT 1",
  ).bind(artifactRef.id, artifactRef.revision).first<ArtifactRow>();
  if (artifact === null) return null;
  if (artifact.status !== "DRAFT") return null;
  if (artifact.artifact_id !== artifactRef.id || artifact.revision !== artifactRef.revision) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft identity is inconsistent");
  const binding = await database.prepare(
    "SELECT artifact_id, revision, intent_id, intent_revision, expected_head_revision, principal_ref, spec_ref_id, spec_ref_revision, scope_snapshot_id, scope_snapshot_revision, manifest_r2_key, manifest_sha256, manifest_size_bytes, created_at FROM artifact_draft_binding WHERE artifact_id=?1 AND revision=?2 LIMIT 1",
  ).bind(artifactRef.id, artifactRef.revision).first<BindingRow>();
  if (binding === null) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft binding is missing");
  if (binding.principal_ref !== input.access.principal_ref) fail("ARTIFACT_ACCESS_DENIED", 403, "draft read authorization denied");
  let scopeRef: VersionedRef;
  try { scopeRef = VersionedRefSchema.parse({ id: binding.scope_snapshot_id, revision: binding.scope_snapshot_revision }); }
  catch { fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft scope reference is invalid"); }
  let scope;
  try { scope = await loadScopeAuthority(database, scopeRef); }
  catch (error) { return mapAuthorityFailure(error); }
  if (scope === null) fail("ARTIFACT_SCOPE_STALE", 410, "draft read scope is unavailable");
  let authority: ReturnType<typeof createNavigationReadAuthority>;
  try {
    if (input.access.client_class !== "owner_pwa") fail("ARTIFACT_ACCESS_DENIED", 403, "draft read authorization denied");
    authority = createNavigationReadAuthority({
      database,
      scope_snapshot: scope.snapshot,
      access: input.access,
      require_current: input.require_current,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    await authority.current();
  } catch (error) {
    if (error instanceof ArtifactDraftReadError) throw error;
    return mapAuthorityFailure(error);
  }
  const reservation = await database.prepare(
    "SELECT intent_id, intent_revision, artifact_id, artifact_revision, request_sha256, spec_digest, manifest_r2_key, expected_head_revision, spec_ref_id, spec_ref_revision, scope_snapshot_id, scope_snapshot_revision, intent_json, principal_ref, idempotency_key, payload_ref, topic, planned_objects_json, state, created_at, updated_at FROM artifact_draft_reservation WHERE intent_id=?1 AND intent_revision=?2 LIMIT 1",
  ).bind(binding.intent_id, binding.intent_revision).first<ReservationRow>();
  const authorityRow = await database.prepare(
    "SELECT i.intent_id, i.revision, i.operation_kind, i.principal_ref, i.idempotency_key, i.payload_ref, i.policy_decision_ref, i.budget_reservation_ref, i.cancellation_ref, i.created_at, o.outbox_id, o.topic, o.payload_sha256 FROM operation_intent i JOIN outbox o ON o.intent_id=i.intent_id AND o.intent_revision=i.revision WHERE i.intent_id=?1 AND i.revision=?2 LIMIT 1",
  ).bind(binding.intent_id, binding.intent_revision).first<AuthorityRow>();
  const objectRows = await database.prepare(
    "SELECT artifact_id, revision, object_kind, object_ref, section_ordinal, receipt_json, residency_key_json, residency_key_digest, created_at FROM artifact_draft_object WHERE artifact_id=?1 AND revision=?2 ORDER BY object_kind, object_ref",
  ).bind(artifactRef.id, artifactRef.revision).all<ObjectRow>();
  const head = await database.prepare(
    "SELECT artifact_id, head_revision, manifest_r2_key, intent_id, intent_revision, updated_at FROM artifact_draft_head WHERE artifact_id=?1 LIMIT 1",
  ).bind(artifactRef.id).first<HeadRow>();
  if (reservation === null || authorityRow === null || !objectRows.success || !Array.isArray(objectRows.results) || head === null) {
    fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft durable authority is incomplete");
  }
  const headRevision = positive(head.head_revision, "draft head revision");
  if (headRevision < artifactRef.revision || head.artifact_id !== artifactRef.id) {
    fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft head is inconsistent");
  }
  const currentBinding = headRevision === artifactRef.revision
    ? binding
    : await database.prepare(
      "SELECT artifact_id, revision, intent_id, intent_revision, expected_head_revision, principal_ref, spec_ref_id, spec_ref_revision, scope_snapshot_id, scope_snapshot_revision, manifest_r2_key, manifest_sha256, manifest_size_bytes, created_at FROM artifact_draft_binding WHERE artifact_id=?1 AND revision=?2 LIMIT 1",
    ).bind(artifactRef.id, headRevision).first<BindingRow>();
  const currentArtifact = headRevision === artifactRef.revision
    ? artifact
    : await database.prepare(
      "SELECT artifact_id, revision, kind, spec_digest, evidence_freeze_id, evidence_freeze_revision, manifest_r2_key, dependency_manifest_ref, status, created_at FROM artifact_revision WHERE artifact_id=?1 AND revision=?2 LIMIT 1",
    ).bind(artifactRef.id, headRevision).first<ArtifactRow>();
  if (currentBinding === null || currentArtifact === null || currentArtifact.status !== "DRAFT" ||
      currentBinding.artifact_id !== artifactRef.id || currentBinding.revision !== headRevision ||
      currentArtifact.artifact_id !== artifactRef.id || currentArtifact.revision !== headRevision ||
      currentBinding.manifest_r2_key !== head.manifest_r2_key || currentArtifact.manifest_r2_key !== head.manifest_r2_key ||
      currentBinding.intent_id !== head.intent_id || currentBinding.intent_revision !== head.intent_revision ||
      currentBinding.created_at !== head.updated_at) {
    fail("ARTIFACT_INTEGRITY_INVALID", 409, "current draft head binding is inconsistent");
  }
  if (reservation.state !== "FINALIZED" || reservation.artifact_id !== artifactRef.id || reservation.artifact_revision !== artifactRef.revision ||
      reservation.intent_id !== binding.intent_id || reservation.intent_revision !== binding.intent_revision || reservation.principal_ref !== binding.principal_ref ||
      reservation.manifest_r2_key !== binding.manifest_r2_key || reservation.expected_head_revision !== binding.expected_head_revision ||
      reservation.spec_digest !== artifact.spec_digest ||
      reservation.spec_ref_id !== binding.spec_ref_id || reservation.spec_ref_revision !== binding.spec_ref_revision ||
      reservation.scope_snapshot_id !== binding.scope_snapshot_id || reservation.scope_snapshot_revision !== binding.scope_snapshot_revision ||
      reservation.created_at !== artifact.created_at || reservation.updated_at !== artifact.created_at) {
    fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft reservation binding is inconsistent");
  }
  let intent: OperationIntent;
  try {
    intent = OperationIntentSchema.parse({
      intent_ref: { id: authorityRow.intent_id, revision: authorityRow.revision }, operation_kind: authorityRow.operation_kind,
      principal_ref: authorityRow.principal_ref, idempotency_key: authorityRow.idempotency_key, payload_ref: authorityRow.payload_ref,
      policy_decision_ref: authorityRow.policy_decision_ref,
      ...(authorityRow.budget_reservation_ref === null ? {} : { budget_reservation_ref: authorityRow.budget_reservation_ref }),
      ...(authorityRow.cancellation_ref === null ? {} : { cancellation_ref: authorityRow.cancellation_ref }), created_at: authorityRow.created_at,
    });
  } catch { fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft operation intent is invalid"); }
  if (intent.operation_kind !== "REPORT" || !canonicalJson(intent) || authorityRow.outbox_id === null || authorityRow.topic !== reservation.topic ||
      authorityRow.payload_sha256 !== binding.manifest_sha256 || intent.principal_ref !== binding.principal_ref ||
      intent.idempotency_key !== reservation.idempotency_key || intent.payload_ref !== reservation.payload_ref ||
      canonicalJson(parseCanonical(reservation.intent_json, "draft intent")) !== canonicalJson(intent)) {
    fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft operation authority is inconsistent");
  }
  const manifestRow = objectRows.results.find((row) => row.object_kind === "MANIFEST" && row.object_ref === "manifest");
  if (manifestRow === undefined || objectRows.results.filter((row) => row.object_kind === "MANIFEST").length !== 1) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft manifest row is missing");
  const manifestReceipt = parseReceipt(manifestRow.receipt_json);
  let manifestResidency: ObjectResidencyKey;
  try { manifestResidency = ObjectResidencyKeySchema.parse(parseCanonical(manifestRow.residency_key_json, "draft manifest residency")); }
  catch { fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft manifest residency is invalid"); }
  const manifestKey = await canonicalEvidenceObjectKey(manifestResidency, MANIFEST_PREFIX, manifestReceipt.expected_sha256);
  if (manifestReceipt.key !== manifestKey || manifestReceipt.readback_sha256 !== manifestReceipt.expected_sha256 ||
      binding.manifest_r2_key !== artifact.manifest_r2_key || binding.manifest_r2_key !== manifestReceipt.key ||
      binding.manifest_sha256 !== manifestReceipt.expected_sha256 || binding.manifest_size_bytes !== manifestReceipt.size_bytes ||
      manifestRow.created_at !== artifact.created_at) {
    fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft manifest binding is inconsistent");
  }
  const store = createR2EvidenceObjectStore(input.work_bucket);
  const manifestObject = await readStoredObject(store, manifestRow, {
    object_ref: "manifest", object_kind: "MANIFEST", section_ordinal: null, prefix: MANIFEST_PREFIX, content_type: "application/json",
  });
  const parsedManifest = parseManifest(manifestObject.bytes);
  const manifestSha = await canonicalDigest({ spec: parsedManifest.spec, revision: parsedManifest.revision });
  if (manifestSha !== manifestObject.sha256 || parsedManifest.revision.status !== "DRAFT" ||
      parsedManifest.revision.artifact_ref.id !== artifactRef.id || parsedManifest.revision.artifact_ref.revision !== artifactRef.revision ||
      parsedManifest.revision.spec_digest !== artifact.spec_digest || parsedManifest.spec.spec_ref.id !== binding.spec_ref_id ||
      parsedManifest.spec.spec_ref.revision !== binding.spec_ref_revision || parsedManifest.spec.scope_snapshot_ref.id !== binding.scope_snapshot_id ||
      parsedManifest.spec.scope_snapshot_ref.revision !== binding.scope_snapshot_revision || artifact.kind !== parsedManifest.spec.kind ||
      artifact.evidence_freeze_id !== parsedManifest.revision.evidence_freeze_ref.id || artifact.evidence_freeze_revision !== parsedManifest.revision.evidence_freeze_ref.revision ||
      artifact.dependency_manifest_ref !== parsedManifest.revision.dependency_manifest_ref || artifact.created_at !== parsedManifest.revision.created_at) {
    fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft manifest contract does not match durable identity");
  }
  const expected = new Map<string, ExpectedObject>();
  addExpected(expected, { object_ref: "manifest", object_kind: "MANIFEST", section_ordinal: null, sha256: manifestSha, prefix: MANIFEST_PREFIX, content_type: "application/json" });
  const contracts = new Set(parsedManifest.spec.section_contracts.map((contract) => contract.section_id));
  for (let ordinal = 0; ordinal < parsedManifest.revision.sections.length; ordinal += 1) {
    const section = parsedManifest.revision.sections[ordinal];
    if (section === undefined) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft section is missing");
    if (!contracts.has(section.contract_id)) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft section contract is missing");
    addExpected(expected, { object_ref: section.body_object_ref, object_kind: "SECTION_BODY", section_ordinal: ordinal, sha256: section.body_sha256, prefix: SECTION_PREFIX, content_type: "application/octet-stream" });
    addExpected(expected, { object_ref: section.evidence_ledger_ref, object_kind: "EVIDENCE_LEDGER", section_ordinal: null, prefix: REFERENCE_PREFIX, content_type: "application/octet-stream" });
    addExpected(expected, { object_ref: section.verification_receipt_ref, object_kind: "VERIFICATION_RECEIPT", section_ordinal: null, prefix: REFERENCE_PREFIX, content_type: "application/octet-stream" });
  }
  addExpected(expected, { object_ref: parsedManifest.revision.dependency_manifest_ref, object_kind: "DEPENDENCY_MANIFEST", section_ordinal: null, prefix: REFERENCE_PREFIX, content_type: "application/octet-stream" });
  for (const ref of Object.values(parsedManifest.revision.deterministic_export_refs)) addExpected(expected, { object_ref: ref, object_kind: "EXPORT", section_ordinal: null, prefix: REFERENCE_PREFIX, content_type: "application/octet-stream" });
  if (objectRows.results.length !== expected.size) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object set is incomplete");
  const storedByRef = new Map<string, StoredObject>();
  storedByRef.set("manifest", manifestObject);
  for (const expectedObject of expected.values()) {
    if (expectedObject.object_ref === "manifest") continue;
    const row = objectRows.results.find((candidate) => candidate.object_ref === expectedObject.object_ref);
    if (row === undefined) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object mapping is incomplete");
    if (row.artifact_id !== artifactRef.id || row.revision !== artifactRef.revision || row.created_at !== artifact.created_at) {
      fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object identity is inconsistent");
    }
    storedByRef.set(expectedObject.object_ref, await readStoredObject(store, row, expectedObject));
  }
  const plannedStored = parseCanonical(reservation.planned_objects_json, "draft planned objects");
  if (!Array.isArray(plannedStored) || plannedStored.length !== expected.size) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft planned object set is invalid");
  const plannedRefs = new Set<string>();
  for (const entry of plannedStored) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft planned object is invalid");
    const value = entry as Record<string, unknown>;
    const ref = text(value.object_ref, "planned object ref");
    if (plannedRefs.has(ref)) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft planned object refs are duplicated");
    plannedRefs.add(ref);
    const stored = storedByRef.get(ref);
    if (stored === undefined || value.object_kind !== stored.row.object_kind || value.section_ordinal !== stored.row.section_ordinal ||
        value.sha256 !== stored.sha256 || value.size_bytes !== stored.size_bytes || value.key !== stored.physical_key ||
        value.residency_digest !== stored.row.residency_key_digest || canonicalJson(value.residency) !== canonicalJson(stored.residency)) {
      fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft planned object differs from durable object");
    }
  }
  if (plannedRefs.size !== expected.size || await canonicalDigest({
    intent_ref: intent.intent_ref, operation_kind: intent.operation_kind, principal_ref: intent.principal_ref,
    idempotency_key: intent.idempotency_key, payload_ref: intent.payload_ref, policy_decision_ref: intent.policy_decision_ref,
    topic: reservation.topic, artifact_ref: parsedManifest.revision.artifact_ref,
    expected_draft_head_revision: optionalPositive(reservation.expected_head_revision, "reservation expected head"),
    spec: parsedManifest.spec, revision: parsedManifest.revision, objects: plannedStored,
  }) !== reservation.request_sha256) {
    fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft request identity differs from durable reservation");
  }
  const initialObjects = objectRows.results;
  const rereadObjects = await database.prepare(
    "SELECT artifact_id, revision, object_kind, object_ref, section_ordinal, receipt_json, residency_key_json, residency_key_digest, created_at FROM artifact_draft_object WHERE artifact_id=?1 AND revision=?2 ORDER BY object_kind, object_ref",
  ).bind(artifactRef.id, artifactRef.revision).all<ObjectRow>();
  if (!rereadObjects.success || !Array.isArray(rereadObjects.results) || canonicalJson(initialObjects) !== canonicalJson(rereadObjects.results)) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft object identity changed during readback");
  try { await authority.current(); }
  catch (error) { if (error instanceof ArtifactDraftReadError) throw error; return mapAuthorityFailure(error); }
  const finalArtifact = await database.prepare(
    "SELECT artifact_id, revision, kind, spec_digest, evidence_freeze_id, evidence_freeze_revision, manifest_r2_key, dependency_manifest_ref, status, created_at FROM artifact_revision WHERE artifact_id=?1 AND revision=?2 LIMIT 1",
  ).bind(artifactRef.id, artifactRef.revision).first<ArtifactRow>();
  const finalBinding = await database.prepare(
    "SELECT artifact_id, revision, intent_id, intent_revision, expected_head_revision, principal_ref, spec_ref_id, spec_ref_revision, scope_snapshot_id, scope_snapshot_revision, manifest_r2_key, manifest_sha256, manifest_size_bytes, created_at FROM artifact_draft_binding WHERE artifact_id=?1 AND revision=?2 LIMIT 1",
  ).bind(artifactRef.id, artifactRef.revision).first<BindingRow>();
  if (finalArtifact === null || finalBinding === null || canonicalJson(finalArtifact) !== canonicalJson(artifact) || canonicalJson(finalBinding) !== canonicalJson(binding)) fail("ARTIFACT_INTEGRITY_INVALID", 409, "draft identity changed during authorization readback");
  return parsedManifest.revision;
}

export async function readArtifactDraft(input: ArtifactDraftReadInput): Promise<ArtifactRevision | null> {
  let artifactRef: VersionedRef;
  try { artifactRef = VersionedRefSchema.parse(input.artifact_ref); }
  catch { fail("ARTIFACT_REF_INVALID", 400, "draft reference is invalid"); }
  if (input.access.client_class !== "owner_pwa") fail("ARTIFACT_ACCESS_DENIED", 403, "draft read authorization denied");
  try { return await readArtifactDraftInternal(input, artifactRef); }
  catch (error) {
    if (error instanceof ArtifactDraftReadError) throw error;
    return mapAuthorityFailure(error);
  }
}
