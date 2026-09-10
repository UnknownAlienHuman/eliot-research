import {
  ArtifactRevisionSchema,
  ArtifactSectionRevisionSchema,
  ArtifactSpecSchema,
  ObjectResidencyKeySchema,
  OperationIntentSchema,
  type ArtifactRevision,
  type ArtifactSectionRevision,
  type ArtifactSpec,
  type ObjectResidencyKey,
  type OperationIntent,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  RUNTIME_LIMITS,
  assertWithinBytes,
  bufferBounded,
  canonicalJson,
  canonicalDigest,
  canonicalEvidenceObjectKey,
  createR2EvidenceObjectStore,
  objectResidencyKeyDigest,
  prepareIntentWithOutboxMutation,
  type EvidenceObjectStore,
  type ImmutableObjectReceipt,
} from "@eliotr/platform-cloudflare";

const SHA256 = /^[a-f0-9]{64}$/u;
const DEFAULT_TOPIC = "research.artifact-draft";
const SECTION_PREFIX = "artifact-draft/section";
const REFERENCE_PREFIX = "artifact-draft/reference";
const MANIFEST_PREFIX = "artifact-draft/manifest";

export type ArtifactDraftObjectKind =
  | "MANIFEST"
  | "SECTION_BODY"
  | "DEPENDENCY_MANIFEST"
  | "EVIDENCE_LEDGER"
  | "VERIFICATION_RECEIPT"
  | "EXPORT";

export interface ArtifactDraftSectionInput {
  readonly section: ArtifactSectionRevision;
  readonly bytes: Uint8Array;
  readonly residency: ObjectResidencyKey;
}

export interface ArtifactDraftReferencedObjectInput {
  readonly object_ref: string;
  readonly object_kind: Exclude<ArtifactDraftObjectKind, "MANIFEST" | "SECTION_BODY">;
  readonly bytes: Uint8Array;
  readonly residency: ObjectResidencyKey;
}

export interface PrepareArtifactDraftInput {
  readonly intent: OperationIntent;
  readonly topic?: string;
  readonly expected_draft_head_revision: number | null;
  readonly spec: ArtifactSpec;
  readonly revision: ArtifactRevision;
  readonly sections: readonly ArtifactDraftSectionInput[];
  readonly referenced_objects: readonly ArtifactDraftReferencedObjectInput[];
  readonly manifest_residency: ObjectResidencyKey;
}

export interface ArtifactDraftObjectReceipt {
  readonly object_ref: string;
  readonly object_kind: ArtifactDraftObjectKind;
  readonly section_ordinal: number | null;
  readonly residency: ObjectResidencyKey;
  readonly receipt: ImmutableObjectReceipt;
}

export interface PrepareArtifactDraftResult {
  readonly disposition: "CREATED" | "EXISTING";
  readonly artifact_ref: VersionedRef;
  readonly intent_ref: VersionedRef;
  readonly outbox_id: string;
  readonly draft_head_revision: number;
  readonly manifest: ArtifactDraftObjectReceipt;
  readonly objects: readonly ArtifactDraftObjectReceipt[];
}

export type ArtifactDraftErrorCode =
  | "ARTIFACT_DRAFT_INPUT_INVALID"
  | "ARTIFACT_DRAFT_IDEMPOTENCY_CONFLICT"
  | "ARTIFACT_DRAFT_HEAD_CONFLICT"
  | "ARTIFACT_DRAFT_R2_INTEGRITY"
  | "ARTIFACT_DRAFT_EFFECT_UNCERTAIN";

export class ArtifactDraftError extends Error {
  public readonly code: ArtifactDraftErrorCode;
  public readonly retryable: boolean;

  public constructor(code: ArtifactDraftErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArtifactDraftError";
    this.code = code;
    this.retryable = retryable;
  }
}

interface PlannedObject {
  readonly object_ref: string;
  readonly object_kind: ArtifactDraftObjectKind;
  readonly section_ordinal: number | null;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly residency: ObjectResidencyKey;
  readonly residency_digest: string;
  readonly prefix: string;
  readonly content_type: string;
}

interface ReservationRow {
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly artifact_id: unknown;
  readonly artifact_revision: unknown;
  readonly request_sha256: unknown;
  readonly planned_objects_json: unknown;
  readonly state: unknown;
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

interface DraftBindingRow {
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

interface DraftRevisionRow {
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

interface DraftHeadRow {
  readonly artifact_id: unknown;
  readonly head_revision: unknown;
}

interface DraftObjectRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly object_kind: unknown;
  readonly object_ref: unknown;
  readonly section_ordinal: unknown;
  readonly receipt_json: unknown;
  readonly residency_key_json: unknown;
  readonly residency_key_digest: unknown;
}

function fail(code: ArtifactDraftErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new ArtifactDraftError(code, message, retryable, cause);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value) {
    fail("ARTIFACT_DRAFT_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function safePositive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("ARTIFACT_DRAFT_INPUT_INVALID", `${label} must be a positive integer`);
  }
  return value as number;
}

function exactJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function bytesFrom(value: Uint8Array, label: string, limit: number): Uint8Array {
  if (!(value instanceof Uint8Array)) fail("ARTIFACT_DRAFT_INPUT_INVALID", `${label} must be bytes`);
  assertWithinBytes(label, value.byteLength, limit);
  return new Uint8Array(value);
}

function bodyFor(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const body = new Response(owned).body;
  if (body === null) fail("ARTIFACT_DRAFT_R2_INTEGRITY", "bounded R2 body could not be created", true);
  return body;
}

function plannedShape(objects: readonly PlannedObject[]): readonly Record<string, unknown>[] {
  return objects.map((object) => ({
    object_ref: object.object_ref,
    object_kind: object.object_kind,
    section_ordinal: object.section_ordinal,
    sha256: object.sha256,
    size_bytes: object.size_bytes,
    residency: object.residency,
    residency_digest: object.residency_digest,
  }));
}

function receiptJson(receipt: ImmutableObjectReceipt): string {
  const value = canonicalJson(receipt);
  assertWithinBytes("artifact draft receipt", new TextEncoder().encode(value).byteLength, RUNTIME_LIMITS.d1_text_or_json_column_bytes);
  return value;
}

function parseReceipt(value: unknown): ImmutableObjectReceipt {
  if (typeof value !== "string") fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft receipt is missing");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) {
    fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft receipt is not JSON", false, cause);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft receipt is not an object");
  }
  const receipt = parsed as Record<string, unknown>;
  if (typeof receipt.key !== "string" || typeof receipt.expected_sha256 !== "string" || !SHA256.test(receipt.expected_sha256) ||
      typeof receipt.readback_sha256 !== "string" || !SHA256.test(receipt.readback_sha256) ||
      !Number.isSafeInteger(receipt.size_bytes) || (receipt.size_bytes as number) < 0 ||
      typeof receipt.etag !== "string" || typeof receipt.existed_identically !== "boolean" ||
      Object.keys(receipt).some((key) => !["key", "expected_sha256", "readback_sha256", "size_bytes", "etag", "existed_identically"].includes(key))) {
    fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft receipt is malformed");
  }
  return receipt as unknown as ImmutableObjectReceipt;
}

function requestDigestInput(input: PrepareArtifactDraftInput, objects: readonly PlannedObject[]): Record<string, unknown> {
  return {
    intent_ref: input.intent.intent_ref,
    operation_kind: input.intent.operation_kind,
    principal_ref: input.intent.principal_ref,
    idempotency_key: input.intent.idempotency_key,
    payload_ref: input.intent.payload_ref,
    policy_decision_ref: input.intent.policy_decision_ref,
    topic: input.topic ?? DEFAULT_TOPIC,
    artifact_ref: input.revision.artifact_ref,
    expected_draft_head_revision: input.expected_draft_head_revision,
    spec: input.spec,
    revision: input.revision,
    objects: plannedShape(objects),
  };
}

function validateInput(input: PrepareArtifactDraftInput): void {
  if (input === null || typeof input !== "object") fail("ARTIFACT_DRAFT_INPUT_INVALID", "draft input is invalid");
  try {
    OperationIntentSchema.parse(input.intent);
    ArtifactSpecSchema.parse(input.spec);
    ArtifactRevisionSchema.parse(input.revision);
  } catch (cause) {
    fail("ARTIFACT_DRAFT_INPUT_INVALID", "draft input failed strict contract validation", false, cause);
  }
  if (input.intent.operation_kind !== "REPORT") fail("ARTIFACT_DRAFT_INPUT_INVALID", "draft intent must use REPORT");
  if (input.revision.status !== "DRAFT") fail("ARTIFACT_DRAFT_INPUT_INVALID", "draft revision must remain DRAFT");
  if (!exactJson(input.revision.spec_ref, input.spec.spec_ref)) fail("ARTIFACT_DRAFT_INPUT_INVALID", "revision and spec refs differ");
  if (!Number.isSafeInteger(input.expected_draft_head_revision) && input.expected_draft_head_revision !== null) {
    fail("ARTIFACT_DRAFT_INPUT_INVALID", "expected draft head revision is invalid");
  }
  if (input.expected_draft_head_revision !== null && input.expected_draft_head_revision < 1) {
    fail("ARTIFACT_DRAFT_INPUT_INVALID", "expected draft head revision is invalid");
  }
  const topic = input.topic ?? DEFAULT_TOPIC;
  if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(topic)) fail("ARTIFACT_DRAFT_INPUT_INVALID", "draft topic is invalid");
}

async function buildPlan(input: PrepareArtifactDraftInput): Promise<{ readonly objects: readonly PlannedObject[]; readonly request_sha256: string; readonly manifest: PlannedObject }> {
  validateInput(input);
  const specDigest = await canonicalDigest(input.spec);
  if (specDigest !== input.revision.spec_digest) fail("ARTIFACT_DRAFT_INPUT_INVALID", "spec_digest does not match canonical spec");
  const manifestValue = { spec: input.spec, revision: input.revision };
  const manifestText = canonicalJson(manifestValue);
  const manifestBytes = bytesFrom(new TextEncoder().encode(manifestText), "artifact draft manifest", RUNTIME_LIMITS.ordinary_json_bytes);
  const manifestSha = await canonicalDigest(manifestValue);
  const manifestResidency = ObjectResidencyKeySchema.parse(input.manifest_residency);
  if (manifestResidency.content_digest.digest !== manifestSha) fail("ARTIFACT_DRAFT_INPUT_INVALID", "manifest residency digest differs from manifest bytes");

  const contracts = new Map<string, (typeof input.spec.section_contracts)[number]>();
  for (const contract of input.spec.section_contracts) {
    if (contracts.has(contract.section_id)) fail("ARTIFACT_DRAFT_INPUT_INVALID", "section contract ids are duplicated");
    contracts.set(contract.section_id, contract);
  }
  const seenSections = new Set<string>();
  const seenRefs = new Set<string>();
  const plans: PlannedObject[] = [];
  if (input.sections.length !== input.revision.sections.length) fail("ARTIFACT_DRAFT_INPUT_INVALID", "section input set is incomplete");
  for (let ordinal = 0; ordinal < input.sections.length; ordinal += 1) {
    const supplied = input.sections[ordinal];
    if (supplied === undefined) fail("ARTIFACT_DRAFT_INPUT_INVALID", "section input is missing");
    const section = ArtifactSectionRevisionSchema.parse(supplied.section);
    if (!exactJson(section, input.revision.sections[ordinal])) fail("ARTIFACT_DRAFT_INPUT_INVALID", "section inputs are out of revision order");
    const sectionKey = `${section.section_ref.id}:${section.section_ref.revision}`;
    if (seenSections.has(sectionKey) || seenRefs.has(section.body_object_ref)) fail("ARTIFACT_DRAFT_INPUT_INVALID", "section refs are duplicated");
    seenSections.add(sectionKey);
    seenRefs.add(section.body_object_ref);
    const contract = contracts.get(section.contract_id);
    if (contract === undefined) fail("ARTIFACT_DRAFT_INPUT_INVALID", "section contract is not present in the spec");
    const bytes = bytesFrom(supplied.bytes, `section ${section.section_ref.id} body`, Math.min(contract.maximum_utf8_bytes, RUNTIME_LIMITS.artifact_section_target_bytes));
    const sha = await digestBytes(bytes);
    if (sha !== section.body_sha256) fail("ARTIFACT_DRAFT_INPUT_INVALID", "section body digest differs from contract revision");
    const residency = ObjectResidencyKeySchema.parse(supplied.residency);
    if (residency.content_digest.digest !== sha) fail("ARTIFACT_DRAFT_INPUT_INVALID", "section residency digest differs from body");
    plans.push({ object_ref: section.body_object_ref, object_kind: "SECTION_BODY", section_ordinal: ordinal, bytes, sha256: sha, size_bytes: bytes.byteLength, residency, residency_digest: await objectResidencyKeyDigest(residency), prefix: SECTION_PREFIX, content_type: "application/octet-stream" });
  }
  const expected = new Map<string, ArtifactDraftObjectKind>();
  const expectRef = (ref: string, kind: ArtifactDraftObjectKind): void => {
    if (expected.has(ref) || seenRefs.has(ref)) fail("ARTIFACT_DRAFT_INPUT_INVALID", "logical object refs are duplicated");
    expected.set(ref, kind);
  };
  expectRef(input.revision.dependency_manifest_ref, "DEPENDENCY_MANIFEST");
  for (const exportRef of Object.values(input.revision.deterministic_export_refs)) expectRef(exportRef, "EXPORT");
  for (const section of input.revision.sections) {
    expectRef(section.evidence_ledger_ref, "EVIDENCE_LEDGER");
    expectRef(section.verification_receipt_ref, "VERIFICATION_RECEIPT");
  }
  for (const object of input.referenced_objects) {
    identifier(object.object_ref, "referenced object_ref");
    if (expected.get(object.object_ref) !== object.object_kind) {
      fail("ARTIFACT_DRAFT_INPUT_INVALID", "referenced object mapping is incomplete or has an unexpected kind");
    }
    expected.delete(object.object_ref);
    const bytes = bytesFrom(object.bytes, `referenced object ${object.object_ref}`, RUNTIME_LIMITS.buffered_r2_bytes);
    const sha = await digestBytes(bytes);
    const residency = ObjectResidencyKeySchema.parse(object.residency);
    if (residency.content_digest.digest !== sha) fail("ARTIFACT_DRAFT_INPUT_INVALID", "referenced object residency digest differs from bytes");
    plans.push({ object_ref: object.object_ref, object_kind: object.object_kind, section_ordinal: null, bytes, sha256: sha, size_bytes: bytes.byteLength, residency, residency_digest: await objectResidencyKeyDigest(residency), prefix: REFERENCE_PREFIX, content_type: "application/octet-stream" });
  }
  if (expected.size !== 0) fail("ARTIFACT_DRAFT_INPUT_INVALID", "referenced object mapping is incomplete");
  if (seenRefs.has("manifest")) fail("ARTIFACT_DRAFT_INPUT_INVALID", "manifest is reserved as an internal object ref");
  const manifest: PlannedObject = { object_ref: "manifest", object_kind: "MANIFEST", section_ordinal: null, bytes: manifestBytes, sha256: manifestSha, size_bytes: manifestBytes.byteLength, residency: manifestResidency, residency_digest: await objectResidencyKeyDigest(manifestResidency), prefix: MANIFEST_PREFIX, content_type: "application/json" };
  const request_sha256 = await canonicalDigest(requestDigestInput(input, [manifest, ...plans]));
  assertWithinBytes("artifact draft reservation", new TextEncoder().encode(canonicalJson(plannedShape([manifest, ...plans]))).byteLength, RUNTIME_LIMITS.d1_text_or_json_column_bytes);
  return { objects: [manifest, ...plans], request_sha256, manifest };
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", owned);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function reservationJson(objects: readonly PlannedObject[]): string {
  const value = canonicalJson(plannedShape(objects));
  assertWithinBytes("artifact draft planned objects", new TextEncoder().encode(value).byteLength, RUNTIME_LIMITS.d1_text_or_json_column_bytes);
  return value;
}

async function readReservation(database: D1Database, intent: OperationIntent): Promise<ReservationRow | null> {
  return database.prepare(
    "SELECT intent_id, intent_revision, artifact_id, artifact_revision, request_sha256, planned_objects_json, state " +
    "FROM artifact_draft_reservation WHERE intent_id = ?1 AND intent_revision = ?2 LIMIT 1",
  ).bind(intent.intent_ref.id, intent.intent_ref.revision).first<ReservationRow>();
}

function validateReservation(row: ReservationRow, input: PrepareArtifactDraftInput, request_sha256: string): void {
  if (row.intent_id !== input.intent.intent_ref.id || row.intent_revision !== input.intent.intent_ref.revision ||
      row.artifact_id !== input.revision.artifact_ref.id || row.artifact_revision !== input.revision.artifact_ref.revision) {
    fail("ARTIFACT_DRAFT_IDEMPOTENCY_CONFLICT", "draft intent is bound to another artifact revision");
  }
  if (row.request_sha256 !== request_sha256) fail("ARTIFACT_DRAFT_IDEMPOTENCY_CONFLICT", "draft idempotency key is bound to different request bytes");
  if (row.state !== "RESERVED" && row.state !== "FINALIZED") fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "draft reservation state is invalid");
}

function resultFromRows(
  input: PrepareArtifactDraftInput,
  binding: DraftBindingRow,
  revision: DraftRevisionRow,
  head: DraftHeadRow,
  rows: readonly DraftObjectRow[],
  planned: readonly PlannedObject[],
  outboxId: string,
  disposition: "CREATED" | "EXISTING",
): PrepareArtifactDraftResult {
  if (binding.manifest_r2_key !== revision.manifest_r2_key || revision.status !== "DRAFT" ||
      binding.artifact_id !== input.revision.artifact_ref.id || binding.revision !== input.revision.artifact_ref.revision ||
      head.artifact_id !== input.revision.artifact_ref.id || revision.kind !== input.spec.kind ||
      revision.spec_digest !== input.revision.spec_digest || revision.evidence_freeze_id !== input.revision.evidence_freeze_ref.id ||
      revision.evidence_freeze_revision !== input.revision.evidence_freeze_ref.revision ||
      revision.dependency_manifest_ref !== input.revision.dependency_manifest_ref ||
      binding.principal_ref !== input.intent.principal_ref || binding.spec_ref_id !== input.spec.spec_ref.id ||
      binding.spec_ref_revision !== input.spec.spec_ref.revision || binding.scope_snapshot_id !== input.spec.scope_snapshot_ref.id ||
      binding.scope_snapshot_revision !== input.spec.scope_snapshot_ref.revision || binding.manifest_sha256 !== planned.find((item) => item.object_kind === "MANIFEST")?.sha256 ||
      binding.manifest_size_bytes !== planned.find((item) => item.object_kind === "MANIFEST")?.size_bytes) {
    fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft binding is inconsistent");
  }
  const byRef = new Map(rows.map((row) => [String(row.object_ref), row]));
  const receipts: ArtifactDraftObjectReceipt[] = [];
  for (const object of planned) {
    const row = byRef.get(object.object_ref);
    if (row === undefined || row.object_kind !== object.object_kind || row.section_ordinal !== object.section_ordinal || row.residency_key_digest !== object.residency_digest) {
      fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft object mapping is incomplete");
    }
    let residency: ObjectResidencyKey;
    try { residency = ObjectResidencyKeySchema.parse(JSON.parse(String(row.residency_key_json))); }
    catch (cause) { fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft residency is malformed", false, cause); }
    const receipt = parseReceipt(row.receipt_json);
    if (receipt.expected_sha256 !== object.sha256 || receipt.readback_sha256 !== object.sha256 || receipt.size_bytes !== object.size_bytes ||
        residency.content_digest.digest !== object.sha256) fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft receipt does not match planned bytes");
    receipts.push({ object_ref: object.object_ref, object_kind: object.object_kind, section_ordinal: object.section_ordinal, residency, receipt });
  }
  if (rows.length !== planned.length) fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft has an unexpected object mapping");
  const manifest = receipts.find((item) => item.object_kind === "MANIFEST");
  if (manifest === undefined) fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft manifest receipt is missing");
  if (manifest.receipt.key !== binding.manifest_r2_key || manifest.receipt.expected_sha256 !== binding.manifest_sha256 ||
      manifest.receipt.size_bytes !== binding.manifest_size_bytes) {
    fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft manifest binding is inconsistent");
  }
  return {
    disposition,
    artifact_ref: input.revision.artifact_ref,
    intent_ref: input.intent.intent_ref,
    outbox_id: outboxId,
    draft_head_revision: safePositive(head.head_revision, "draft head revision"),
    manifest,
    objects: receipts.filter((item) => item.object_kind !== "MANIFEST"),
  };
}

async function readExactDraft(
  database: D1Database,
  store: EvidenceObjectStore,
  input: PrepareArtifactDraftInput,
  plan: { readonly objects: readonly PlannedObject[]; readonly request_sha256: string; readonly manifest: PlannedObject },
  outboxId: string,
): Promise<PrepareArtifactDraftResult | null> {
  const authority = await database.prepare(
    "SELECT i.intent_id, i.revision, i.operation_kind, i.principal_ref, i.idempotency_key, i.payload_ref, " +
    "i.policy_decision_ref, i.budget_reservation_ref, i.cancellation_ref, i.created_at, o.outbox_id, o.topic, o.payload_sha256 " +
    "FROM operation_intent i JOIN outbox o ON o.intent_id=i.intent_id AND o.intent_revision=i.revision " +
    "WHERE i.intent_id=?1 AND i.revision=?2 LIMIT 1",
  ).bind(input.intent.intent_ref.id, input.intent.intent_ref.revision).first<AuthorityRow>();
  if (authority === null) return null;
  let storedIntent: OperationIntent;
  try {
    storedIntent = OperationIntentSchema.parse({
      intent_ref: { id: authority.intent_id, revision: authority.revision },
      operation_kind: authority.operation_kind,
      principal_ref: authority.principal_ref,
      idempotency_key: authority.idempotency_key,
      payload_ref: authority.payload_ref,
      policy_decision_ref: authority.policy_decision_ref,
      ...(authority.budget_reservation_ref === null ? {} : { budget_reservation_ref: authority.budget_reservation_ref }),
      ...(authority.cancellation_ref === null ? {} : { cancellation_ref: authority.cancellation_ref }),
      created_at: authority.created_at,
    });
  } catch (cause) {
    fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft intent is malformed", false, cause);
  }
  if (!exactJson(storedIntent, input.intent) || authority.outbox_id !== outboxId ||
      authority.topic !== (input.topic ?? DEFAULT_TOPIC) || authority.payload_sha256 !== plan.manifest.sha256) {
    fail("ARTIFACT_DRAFT_IDEMPOTENCY_CONFLICT", "draft intent or outbox is bound to different request bytes");
  }
  const reservation = await readReservation(database, input.intent);
  if (reservation === null) return null;
  validateReservation(reservation, input, plan.request_sha256);
  if (reservation.state !== "FINALIZED") return null;
  let plannedStored: unknown;
  try { plannedStored = JSON.parse(String(reservation.planned_objects_json)); } catch (cause) {
    fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft plan is malformed", false, cause);
  }
  if (!exactJson(plannedStored, plannedShape(plan.objects))) fail("ARTIFACT_DRAFT_IDEMPOTENCY_CONFLICT", "stored draft plan differs from request");
  const artifactId = input.revision.artifact_ref.id;
  const revision = input.revision.artifact_ref.revision;
  const binding = await database.prepare("SELECT artifact_id, revision, intent_id, intent_revision, expected_head_revision, principal_ref, spec_ref_id, spec_ref_revision, scope_snapshot_id, scope_snapshot_revision, manifest_r2_key, manifest_sha256, manifest_size_bytes, created_at FROM artifact_draft_binding WHERE artifact_id = ?1 AND revision = ?2 LIMIT 1").bind(artifactId, revision).first<DraftBindingRow>();
  const artifact = await database.prepare("SELECT artifact_id, revision, kind, spec_digest, evidence_freeze_id, evidence_freeze_revision, manifest_r2_key, dependency_manifest_ref, status, created_at FROM artifact_revision WHERE artifact_id = ?1 AND revision = ?2 LIMIT 1").bind(artifactId, revision).first<DraftRevisionRow>();
  const head = await database.prepare("SELECT artifact_id, head_revision FROM artifact_draft_head WHERE artifact_id = ?1 LIMIT 1").bind(artifactId).first<DraftHeadRow>();
  const rows = await database.prepare("SELECT artifact_id, revision, object_kind, object_ref, section_ordinal, receipt_json, residency_key_json, residency_key_digest FROM artifact_draft_object WHERE artifact_id = ?1 AND revision = ?2 ORDER BY object_kind, object_ref").bind(artifactId, revision).all<DraftObjectRow>();
  if (binding === null || artifact === null || head === null || rows.results === undefined) return null;
  if (binding.intent_id !== input.intent.intent_ref.id || binding.intent_revision !== input.intent.intent_ref.revision) fail("ARTIFACT_DRAFT_IDEMPOTENCY_CONFLICT", "draft revision is bound to another intent");
  for (const object of plan.objects) {
    const row = rows.results.find((candidate) => candidate.object_ref === object.object_ref);
    if (row === undefined) return null;
    const receipt = parseReceipt(row.receipt_json);
    const expectedKey = await canonicalEvidenceObjectKey(object.residency, object.prefix, object.sha256);
    if (receipt.key !== expectedKey) fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "stored draft receipt key is not canonical");
    const stored = await store.open(receipt.key);
    if (stored === null) return null;
    const actual = await bufferBounded(stored.body, RUNTIME_LIMITS.buffered_r2_bytes);
    if (actual.byteLength !== object.size_bytes || await digestBytes(actual) !== object.sha256) fail("ARTIFACT_DRAFT_R2_INTEGRITY", "draft R2 readback differs from durable receipt");
  }
  const result = resultFromRows(input, binding, artifact, head, rows.results, plan.objects, outboxId, "EXISTING");
  return { ...result, outbox_id: outboxId };
}

export function createArtifactDraftStore(database: D1Database, bucket: R2Bucket) {
  return { prepare: (input: PrepareArtifactDraftInput) => prepareArtifactDraft(database, bucket, input) };
}

export async function prepareArtifactDraft(
  database: D1Database,
  bucket: R2Bucket,
  input: PrepareArtifactDraftInput,
): Promise<PrepareArtifactDraftResult> {
  const plan = await buildPlan(input);
  const topic = input.topic ?? DEFAULT_TOPIC;
  const store = createR2EvidenceObjectStore(bucket);
  const intentPlan = await prepareIntentWithOutboxMutation(database, { intent: input.intent, topic, payload_sha256: plan.manifest.sha256 });
  const existing = await readExactDraft(database, store, input, plan, intentPlan.outbox_id);
  if (existing !== null) return existing;
  const intentStatement = intentPlan.statements[0];
  if (intentStatement === undefined) fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "prepared intent mutation is incomplete");

  const reservationInsert = database.prepare(
    "INSERT INTO artifact_draft_reservation(intent_id, intent_revision, artifact_id, artifact_revision, request_sha256, planned_objects_json, state, created_at, updated_at) " +
    "VALUES (?1,?2,?3,?4,?5,?6,'RESERVED',?7,?7)",
  ).bind(input.intent.intent_ref.id, input.intent.intent_ref.revision, input.revision.artifact_ref.id, input.revision.artifact_ref.revision, plan.request_sha256, reservationJson(plan.objects), input.revision.created_at);
  try {
    const reservationResults = await database.batch([intentStatement, reservationInsert]);
    if ((reservationResults[0]?.meta?.changes ?? 0) !== 1 || (reservationResults[1]?.meta?.changes ?? 0) !== 1) fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "draft intent reservation did not mutate exactly two rows", true);
  } catch (cause) {
    const raced = await readExactDraft(database, store, input, plan, intentPlan.outbox_id);
    if (raced !== null) return raced;
    const reserved = await readReservation(database, input.intent);
    if (reserved !== null) {
      validateReservation(reserved, input, plan.request_sha256);
    } else {
      fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "draft intent reservation failed without exact readback", true, cause);
    }
  }

  const receipts: ArtifactDraftObjectReceipt[] = [];
  try {
    for (const object of plan.objects) {
      const receipt = await store.putResidencyObject({ residency_key: object.residency, prefix: object.prefix, body: bodyFor(object.bytes), expected_sha256: object.sha256, expected_size_bytes: object.size_bytes, content_type: object.content_type, custom_metadata: {} });
      if (receipt.expected_sha256 !== object.sha256 || receipt.readback_sha256 !== object.sha256 || receipt.size_bytes !== object.size_bytes) fail("ARTIFACT_DRAFT_R2_INTEGRITY", "R2 receipt failed exact byte verification");
      receipts.push({ object_ref: object.object_ref, object_kind: object.object_kind, section_ordinal: object.section_ordinal, residency: object.residency, receipt });
    }
  } catch (cause) {
    if (cause instanceof ArtifactDraftError) throw cause;
    fail("ARTIFACT_DRAFT_R2_INTEGRITY", "draft R2 write/readback failed", true, cause);
  }

  const manifestReceipt = receipts.find((item) => item.object_kind === "MANIFEST");
  if (manifestReceipt === undefined) fail("ARTIFACT_DRAFT_R2_INTEGRITY", "draft manifest receipt is missing");
  const outboxStatement = intentPlan.statements[1];
  if (outboxStatement === undefined) fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "prepared outbox mutation is incomplete");
  const statements: D1PreparedStatement[] = [
    outboxStatement,
    database.prepare("INSERT INTO artifact_revision(artifact_id, revision, kind, spec_digest, evidence_freeze_id, evidence_freeze_revision, manifest_r2_key, dependency_manifest_ref, status, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'DRAFT',?9)").bind(input.revision.artifact_ref.id, input.revision.artifact_ref.revision, input.spec.kind, input.revision.spec_digest, input.revision.evidence_freeze_ref.id, input.revision.evidence_freeze_ref.revision, manifestReceipt.receipt.key, input.revision.dependency_manifest_ref, input.revision.created_at),
    database.prepare("INSERT INTO artifact_draft_binding(artifact_id, revision, intent_id, intent_revision, expected_head_revision, principal_ref, spec_ref_id, spec_ref_revision, scope_snapshot_id, scope_snapshot_revision, manifest_r2_key, manifest_sha256, manifest_size_bytes, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)").bind(input.revision.artifact_ref.id, input.revision.artifact_ref.revision, input.intent.intent_ref.id, input.intent.intent_ref.revision, input.expected_draft_head_revision, input.intent.principal_ref, input.spec.spec_ref.id, input.spec.spec_ref.revision, input.spec.scope_snapshot_ref.id, input.spec.scope_snapshot_ref.revision, manifestReceipt.receipt.key, manifestReceipt.receipt.expected_sha256, manifestReceipt.receipt.size_bytes, input.revision.created_at),
  ];
  for (const item of receipts) {
    statements.push(database.prepare("INSERT INTO artifact_draft_object(artifact_id, revision, object_kind, object_ref, section_ordinal, receipt_json, residency_key_json, residency_key_digest, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)").bind(input.revision.artifact_ref.id, input.revision.artifact_ref.revision, item.object_kind, item.object_ref, item.section_ordinal, receiptJson(item.receipt), canonicalJson(item.residency), await objectResidencyKeyDigest(item.residency), input.revision.created_at));
  }
  statements.push(database.prepare("UPDATE artifact_draft_reservation SET state='FINALIZED', updated_at=?3 WHERE intent_id=?1 AND intent_revision=?2 AND state='RESERVED'").bind(input.intent.intent_ref.id, input.intent.intent_ref.revision, input.revision.created_at));
  try {
    const results = await database.batch(statements);
    if (results.some((result) => (result.meta?.changes ?? 0) !== 1)) fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "draft final batch did not mutate exactly one row per statement", true);
  } catch (cause) {
    const recovered = await readExactDraft(database, store, input, plan, intentPlan.outbox_id);
    if (recovered !== null) return recovered;
    const head = await database.prepare("SELECT head_revision FROM artifact_draft_head WHERE artifact_id=?1 LIMIT 1").bind(input.revision.artifact_ref.id).first<{ readonly head_revision: unknown }>();
    if (head !== null && input.expected_draft_head_revision !== null && head.head_revision !== input.expected_draft_head_revision) fail("ARTIFACT_DRAFT_HEAD_CONFLICT", "draft head changed before commit", false, cause);
    fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "draft final batch failed without exact readback", true, cause);
  }
  const final = await readExactDraft(database, store, input, plan, intentPlan.outbox_id);
  if (final === null) fail("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", "draft final batch readback is missing", true);
  return { ...final, disposition: "CREATED" };
}
