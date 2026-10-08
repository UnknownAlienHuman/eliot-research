import { ObjectResidencyKeySchema, type ObjectResidencyKey } from "@eliotr/contracts";
import {
  bufferBounded,
  canonicalEvidenceObjectKey,
  canonicalJson,
  createR2EvidenceObjectStore,
  sha256Utf8,
  type EvidenceObjectStore,
  type ImmutableObjectReceipt,
} from "@eliotr/platform-cloudflare";
import type { ModelGatewayOutputStorePort } from "@eliotr/cloudflare-ai";
import { createModelAttemptStore } from "./model-attempt-store.js";
import type { ModelAttemptReadback, ModelOutputBinding } from "./model-attempt-types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const OUTPUT_PREFIX = "research/model-output";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DOMAIN_JSON_BYTES = 4096;

const ResidencyDomainSchema = ObjectResidencyKeySchema.omit({ content_digest: true });
export type ResidencyDomainProfile = Omit<ObjectResidencyKey, "content_digest">;

export interface ModelOutputBindingPreparation {
  readonly attempt_id: string;
  readonly output_object_ref: string;
  readonly principal_ref: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly request_sha256: string;
  readonly workflow_budget_receipt_ref: string;
  readonly residency_domains: ResidencyDomainProfile;
  readonly created_at: string;
}

export type ModelOutputStoreErrorCode =
  | "MODEL_OUTPUT_INPUT_INVALID"
  | "MODEL_OUTPUT_BINDING_MISSING"
  | "MODEL_OUTPUT_AUTHORITY_STALE"
  | "MODEL_OUTPUT_CONFLICT"
  | "MODEL_OUTPUT_INTEGRITY"
  | "MODEL_OUTPUT_UNCERTAIN";

export class ModelOutputStoreError extends Error {
  public readonly code: ModelOutputStoreErrorCode;
  public readonly retryable: boolean;

  public constructor(code: ModelOutputStoreErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ModelOutputStoreError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ModelOutputStorage {
  readonly outputs: ModelGatewayOutputStorePort;
  readonly readOutput: (binding: Pick<ModelOutputBinding, "output_object_ref" | "output_sha256">) => Promise<Uint8Array>;
  readonly prepareOutputBinding: (input: ModelOutputBindingPreparation) => Promise<void>;
}

interface OutputRow {
  readonly output_object_ref: unknown;
  readonly attempt_id: unknown;
  readonly principal_ref: unknown;
  readonly stage_attempt_ref: unknown;
  readonly stage_request_sha256: unknown;
  readonly request_sha256: unknown;
  readonly workflow_budget_receipt_ref: unknown;
  readonly residency_domain_json: unknown;
  readonly residency_domain_sha256: unknown;
  readonly r2_key: unknown;
  readonly r2_etag: unknown;
  readonly output_sha256: unknown;
  readonly output_size_bytes: unknown;
  readonly readback_sha256: unknown;
  readonly state: unknown;
  readonly created_at: unknown;
  readonly committed_at: unknown;
}

interface VerifiedOutputRow {
  readonly output_object_ref: string;
  readonly attempt_id: string;
  readonly principal_ref: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly request_sha256: string;
  readonly workflow_budget_receipt_ref: string;
  readonly residency_domains: ResidencyDomainProfile;
  readonly residency_domain_sha256: string;
  readonly r2_key: string | null;
  readonly r2_etag: string | null;
  readonly output_sha256: string | null;
  readonly output_size_bytes: number | null;
  readonly readback_sha256: string | null;
  readonly state: "PREPARED" | "COMMITTED";
  readonly created_at: string;
  readonly committed_at: string | null;
}

function fail(code: ModelOutputStoreErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new ModelOutputStoreError(code, message, retryable, cause);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("MODEL_OUTPUT_INTEGRITY", `${label} is invalid`);
  return value;
}

function inputText(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("MODEL_OUTPUT_INPUT_INVALID", `${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("MODEL_OUTPUT_INTEGRITY", `${label} is invalid`);
  return value;
}

function etag(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || new TextEncoder().encode(value).byteLength > 512 || /[\u0000-\u001f\u007f]/u.test(value)) fail("MODEL_OUTPUT_INTEGRITY", `${label} is invalid`);
  return value;
}

function inputSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("MODEL_OUTPUT_INPUT_INVALID", `${label} is invalid`);
  return value;
}

function iso(value: unknown, label: string, code: ModelOutputStoreErrorCode): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(code, `${label} is invalid`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_OUTPUT_BYTES) fail("MODEL_OUTPUT_INTEGRITY", `${label} is invalid`);
  return value as number;
}

function canonicalDomain(value: unknown, code: ModelOutputStoreErrorCode): { readonly value: ResidencyDomainProfile; readonly json: string; readonly digest: Promise<string> } {
  let parsed: ResidencyDomainProfile;
  try { parsed = ResidencyDomainSchema.parse(value); } catch (cause) { fail(code, "residency domain profile is invalid", false, cause); }
  const json = canonicalJson(parsed);
  if (new TextEncoder().encode(json).byteLength > MAX_DOMAIN_JSON_BYTES) fail(code, "residency domain profile exceeds its bound");
  return { value: parsed, json, digest: sha256Utf8(json) };
}

function canonicalRowJson(value: unknown, label: string): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_DOMAIN_JSON_BYTES) fail("MODEL_OUTPUT_INTEGRITY", `${label} is invalid`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) { fail("MODEL_OUTPUT_INTEGRITY", `${label} is not JSON`, false, cause); }
  if (canonicalJson(parsed) !== value) fail("MODEL_OUTPUT_INTEGRITY", `${label} is not canonical JSON`);
  return value;
}

function decodeRow(row: OutputRow): VerifiedOutputRow {
  const state = row.state;
  if (state !== "PREPARED" && state !== "COMMITTED") fail("MODEL_OUTPUT_INTEGRITY", "stored model output state is invalid");
  const domainJson = canonicalRowJson(row.residency_domain_json, "residency domain");
  const domain = canonicalDomain(JSON.parse(domainJson), "MODEL_OUTPUT_INTEGRITY");
  const domainDigest = sha(row.residency_domain_sha256, "residency domain digest");
  const r2Key = row.r2_key === null ? null : text(row.r2_key, "R2 key");
  const r2Etag = row.r2_etag === null ? null : etag(row.r2_etag, "R2 ETag");
  const outputSha = row.output_sha256 === null ? null : sha(row.output_sha256, "output digest");
  const readbackSha = row.readback_sha256 === null ? null : sha(row.readback_sha256, "readback digest");
  const size = row.output_size_bytes === null ? null : integer(row.output_size_bytes, "output size");
  const committedAt = row.committed_at === null ? null : iso(row.committed_at, "committed_at", "MODEL_OUTPUT_INTEGRITY");
  if (state === "PREPARED" && (r2Key !== null || r2Etag !== null || outputSha !== null || size !== null || readbackSha !== null || committedAt !== null)) fail("MODEL_OUTPUT_INTEGRITY", "prepared output has a receipt");
  if (state === "COMMITTED" && (r2Key === null || r2Etag === null || outputSha === null || size === null || readbackSha === null || committedAt === null || readbackSha !== outputSha)) fail("MODEL_OUTPUT_INTEGRITY", "committed output receipt is incomplete");
  return {
    output_object_ref: text(row.output_object_ref, "output_object_ref"),
    attempt_id: text(row.attempt_id, "attempt_id"),
    principal_ref: text(row.principal_ref, "principal_ref"),
    stage_attempt_ref: text(row.stage_attempt_ref, "stage_attempt_ref"),
    stage_request_sha256: sha(row.stage_request_sha256, "stage_request_sha256"),
    request_sha256: sha(row.request_sha256, "request_sha256"),
    workflow_budget_receipt_ref: text(row.workflow_budget_receipt_ref, "workflow budget receipt"),
    residency_domains: domain.value,
    residency_domain_sha256: domainDigest,
    r2_key: r2Key,
    r2_etag: r2Etag,
    output_sha256: outputSha,
    output_size_bytes: size,
    readback_sha256: readbackSha,
    state,
    created_at: iso(row.created_at, "created_at", "MODEL_OUTPUT_INTEGRITY"),
    committed_at: committedAt,
  };
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bodyFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const body = new Response(owned).body;
  if (body === null) fail("MODEL_OUTPUT_UNCERTAIN", "R2 output body could not be created", true);
  return body;
}

async function readOne(database: D1Database, ref: string): Promise<VerifiedOutputRow | null> {
  const row = await database.prepare(
    "SELECT output_object_ref,attempt_id,principal_ref,stage_attempt_ref,stage_request_sha256,request_sha256,workflow_budget_receipt_ref,residency_domain_json,residency_domain_sha256,r2_key,r2_etag,output_sha256,output_size_bytes,readback_sha256,state,created_at,committed_at FROM research_model_output WHERE output_object_ref = ?1 LIMIT 1",
  ).bind(ref).first<OutputRow>();
  if (row === null) return null;
  const decoded = decodeRow(row);
  const expectedDomainDigest = await sha256Utf8(canonicalJson(decoded.residency_domains));
  if (expectedDomainDigest !== decoded.residency_domain_sha256) fail("MODEL_OUTPUT_INTEGRITY", "residency domain digest does not match its canonical value");
  return decoded;
}

async function readAttemptBinding(database: D1Database, row: VerifiedOutputRow, allowSucceeded: boolean): Promise<ModelAttemptReadback> {
  const attempts = createModelAttemptStore(database);
  const readback = await attempts.readByAttempt(row.attempt_id);
  if (readback === null || (readback.persisted_state !== "STARTED" && !(allowSucceeded && readback.persisted_state === "SUCCEEDED"))) fail("MODEL_OUTPUT_AUTHORITY_STALE", "model output is not bound to an active model attempt", true);
  if (readback.authority.principal_ref !== row.principal_ref || readback.stage_attempt_ref !== row.stage_attempt_ref || readback.stage_request_sha256 !== row.stage_request_sha256 || readback.request_sha256 !== row.request_sha256 || readback.workflow_budget_receipt_ref !== row.workflow_budget_receipt_ref) fail("MODEL_OUTPUT_AUTHORITY_STALE", "model output attempt binding changed", true);
  return readback;
}

async function readAttemptRequest(database: D1Database, row: VerifiedOutputRow): Promise<{ readonly readback: ModelAttemptReadback; readonly request: Record<string, unknown> }> {
  const readback = await readAttemptBinding(database, row, true);
  const stored = await database.prepare("SELECT request_json FROM research_model_attempt WHERE attempt_id = ?1 LIMIT 1").bind(row.attempt_id).first<{ readonly request_json: unknown }>();
  if (stored === null || typeof stored.request_json !== "string") fail("MODEL_OUTPUT_INTEGRITY", "model attempt request is missing");
  let request: unknown;
  try { request = JSON.parse(stored.request_json); } catch (cause) { fail("MODEL_OUTPUT_INTEGRITY", "model attempt request is not JSON", false, cause); }
  if (request === null || typeof request !== "object" || Array.isArray(request) || canonicalJson(request) !== stored.request_json) fail("MODEL_OUTPUT_INTEGRITY", "model attempt request is not canonical");
  return { readback, request: request as Record<string, unknown> };
}

async function verifyStoredObject(store: EvidenceObjectStore, row: VerifiedOutputRow): Promise<Uint8Array> {
  if (row.state !== "COMMITTED" || row.output_sha256 === null || row.output_size_bytes === null || row.readback_sha256 === null || row.r2_key === null || row.r2_etag === null) fail("MODEL_OUTPUT_BINDING_MISSING", "model output has not been durably committed", true);
  const fullResidency = ObjectResidencyKeySchema.parse({ ...row.residency_domains, content_digest: { algorithm: "sha256", digest: row.output_sha256 } });
  const expectedKey = await canonicalEvidenceObjectKey(fullResidency, OUTPUT_PREFIX, row.output_sha256);
  if (row.r2_key !== expectedKey) fail("MODEL_OUTPUT_INTEGRITY", "stored model output key is not canonical");
  const object = await store.open(expectedKey);
  if (object === null || object.body === null) fail("MODEL_OUTPUT_INTEGRITY", "stored model output is missing", true);
  if (object.etag !== row.r2_etag || object.size !== row.output_size_bytes || object.httpMetadata?.contentType !== "application/octet-stream") fail("MODEL_OUTPUT_INTEGRITY", "stored model output metadata differs from its receipt");
  const metadata = object.customMetadata ?? {};
  if (Object.keys(metadata).length !== 3 || metadata.eliotr_sha256 !== row.output_sha256 || metadata.eliotr_size_bytes !== String(row.output_size_bytes) || metadata.eliotr_immutable !== "true") fail("MODEL_OUTPUT_INTEGRITY", "stored model output integrity metadata differs from its receipt");
  const bytes = await bufferBounded(object.body, MAX_OUTPUT_BYTES);
  if (bytes.byteLength !== row.output_size_bytes || await digestBytes(bytes) !== row.output_sha256 || row.readback_sha256 !== row.output_sha256) fail("MODEL_OUTPUT_INTEGRITY", "stored model output bytes differ from its receipt");
  return bytes;
}

function sameIdentity(left: VerifiedOutputRow, right: VerifiedOutputRow): boolean {
  return left.output_object_ref === right.output_object_ref && left.attempt_id === right.attempt_id && left.principal_ref === right.principal_ref && left.stage_attempt_ref === right.stage_attempt_ref && left.stage_request_sha256 === right.stage_request_sha256 && left.request_sha256 === right.request_sha256 && left.workflow_budget_receipt_ref === right.workflow_budget_receipt_ref && left.residency_domain_sha256 === right.residency_domain_sha256 && left.r2_key === right.r2_key && left.r2_etag === right.r2_etag && left.output_sha256 === right.output_sha256 && left.output_size_bytes === right.output_size_bytes && left.readback_sha256 === right.readback_sha256 && left.state === right.state;
}

export function createResearchModelOutputStore(input: { readonly database: D1Database; readonly work_bucket: R2Bucket }): ModelOutputStorage {
  const store = createR2EvidenceObjectStore(input.work_bucket);
  const outputPort: ModelGatewayOutputStorePort = {
    async putImmutable(ref, body, expectedSha256): Promise<unknown> {
      const outputRef = inputText(ref, "output reference");
      const expected = inputSha(expectedSha256, "expected output digest");
      const prepared = await readOne(input.database, outputRef);
      if (prepared === null) fail("MODEL_OUTPUT_BINDING_MISSING", "model output was not prepared");
      if (prepared.state === "COMMITTED") {
        if (prepared.output_sha256 !== expected) fail("MODEL_OUTPUT_CONFLICT", "committed model output digest differs from the provider receipt");
        await readAttemptBinding(input.database, prepared, true);
        const bytes = await verifyStoredObject(store, prepared);
        return { object_ref: outputRef, readback_sha256: await digestBytes(bytes) };
      }
      await readAttemptBinding(input.database, prepared, false);
      const bytes = await bufferBounded(body, MAX_OUTPUT_BYTES);
      if (await digestBytes(bytes) !== expected) fail("MODEL_OUTPUT_INTEGRITY", "provider output digest differs from the bounded bytes");
      const fullResidency = ObjectResidencyKeySchema.parse({ ...prepared.residency_domains, content_digest: { algorithm: "sha256", digest: expected } });
      const receipt: ImmutableObjectReceipt = await store.putResidencyObject({ residency_key: fullResidency, prefix: OUTPUT_PREFIX, body: bodyFromBytes(bytes), expected_sha256: expected, expected_size_bytes: bytes.byteLength, content_type: "application/octet-stream", custom_metadata: {} });
      let result: D1Result<unknown>;
      const committedAt = new Date().toISOString();
      try {
        result = await input.database.prepare(
          "UPDATE research_model_output SET r2_key=?1,r2_etag=?2,output_sha256=?3,output_size_bytes=?4,readback_sha256=?5,state='COMMITTED',committed_at=?6 WHERE output_object_ref=?7 AND state='PREPARED' AND attempt_id=?8 AND residency_domain_sha256=?9",
        ).bind(receipt.key, receipt.etag, expected, bytes.byteLength, receipt.readback_sha256, committedAt, outputRef, prepared.attempt_id, prepared.residency_domain_sha256).run();
      } catch (cause) {
        const raced = await readOne(input.database, outputRef);
        if (raced === null || raced.state !== "COMMITTED" || raced.attempt_id !== prepared.attempt_id || raced.output_sha256 !== expected) fail("MODEL_OUTPUT_UNCERTAIN", "model output commit outcome is uncertain", true, cause);
        const racedBytes = await verifyStoredObject(store, raced);
        return { object_ref: outputRef, readback_sha256: await digestBytes(racedBytes) };
      }
      if ((result.meta?.changes ?? 0) !== 1) {
        const raced = await readOne(input.database, outputRef);
        if (raced === null || raced.state !== "COMMITTED" || raced.output_sha256 !== expected) fail("MODEL_OUTPUT_UNCERTAIN", "model output commit outcome is uncertain", true);
        const racedBytes = await verifyStoredObject(store, raced);
        return { object_ref: outputRef, readback_sha256: await digestBytes(racedBytes) };
      }
      const committed = await readOne(input.database, outputRef);
      if (committed === null || committed.state !== "COMMITTED" || committed.output_sha256 !== expected) fail("MODEL_OUTPUT_UNCERTAIN", "model output commit readback is missing", true);
      const committedBytes = await verifyStoredObject(store, committed);
      return { object_ref: outputRef, readback_sha256: await digestBytes(committedBytes) };
    },
  };

  async function prepareOutputBinding(preparation: ModelOutputBindingPreparation): Promise<void> {
    const attemptId = inputText(preparation.attempt_id, "attempt_id");
    const outputRef = inputText(preparation.output_object_ref, "output reference");
    const principal = inputText(preparation.principal_ref, "principal_ref");
    const stageRef = inputText(preparation.stage_attempt_ref, "stage_attempt_ref");
    const stageSha = inputSha(preparation.stage_request_sha256, "stage_request_sha256");
    const requestSha = inputSha(preparation.request_sha256, "request_sha256");
    const workflowBudget = inputText(preparation.workflow_budget_receipt_ref, "workflow budget receipt");
    const createdAt = iso(preparation.created_at, "created_at", "MODEL_OUTPUT_INPUT_INVALID");
    const domain = canonicalDomain(preparation.residency_domains, "MODEL_OUTPUT_INPUT_INVALID");
    const domainDigest = await domain.digest;
    const probe = {
      output_object_ref: outputRef, attempt_id: attemptId, principal_ref: principal, stage_attempt_ref: stageRef,
      stage_request_sha256: stageSha, request_sha256: requestSha, workflow_budget_receipt_ref: workflowBudget,
      residency_domains: domain.value, residency_domain_sha256: domainDigest, r2_key: null, r2_etag: null,
      output_sha256: null, output_size_bytes: null, readback_sha256: null, state: "PREPARED", created_at: createdAt, committed_at: null,
    } satisfies VerifiedOutputRow;
    const existing = await readOne(input.database, outputRef);
    const { readback, request } = await readAttemptRequest(input.database, probe);
    if (existing === null && readback.persisted_state !== "STARTED") fail("MODEL_OUTPUT_AUTHORITY_STALE", "model attempt is not an exact STARTED authority binding", true);
    if (existing !== null && readback.persisted_state !== "STARTED" && readback.persisted_state !== "SUCCEEDED") fail("MODEL_OUTPUT_AUTHORITY_STALE", "model attempt is not an exact resumable authority binding", true);
    if (readback.authority.scope_snapshot_ref.id !== domain.value.scope_domain_id) fail("MODEL_OUTPUT_AUTHORITY_STALE", "output residency scope differs from the persisted model authority", true);
    const call = request.call;
    if (call === null || typeof call !== "object" || Array.isArray(call) || (call as Record<string, unknown>).output_object_ref !== outputRef) fail("MODEL_OUTPUT_INPUT_INVALID", "model request output reference differs from the prepared reference");
    try {
      await input.database.prepare(
        "INSERT INTO research_model_output(output_object_ref,attempt_id,principal_ref,stage_attempt_ref,stage_request_sha256,request_sha256,workflow_budget_receipt_ref,residency_domain_json,residency_domain_sha256,state,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'PREPARED',?10) ON CONFLICT(output_object_ref) DO NOTHING",
      ).bind(outputRef, attemptId, principal, stageRef, stageSha, requestSha, workflowBudget, domain.json, domainDigest, createdAt).run();
    } catch (cause) {
      const raced = await readOne(input.database, outputRef);
      if (raced === null || raced.state !== "PREPARED" || raced.attempt_id !== attemptId || raced.principal_ref !== principal || raced.stage_attempt_ref !== stageRef || raced.stage_request_sha256 !== stageSha || raced.request_sha256 !== requestSha || raced.workflow_budget_receipt_ref !== workflowBudget || raced.residency_domain_sha256 !== domainDigest || canonicalJson(raced.residency_domains) !== domain.json) fail("MODEL_OUTPUT_UNCERTAIN", "model output preparation outcome is uncertain", true, cause);
    }
    const stored = await readOne(input.database, outputRef);
    if (stored === null || (stored.state !== "PREPARED" && stored.state !== "COMMITTED") || stored.attempt_id !== attemptId || stored.principal_ref !== principal || stored.stage_attempt_ref !== stageRef || stored.stage_request_sha256 !== stageSha || stored.request_sha256 !== requestSha || stored.workflow_budget_receipt_ref !== workflowBudget || stored.residency_domain_sha256 !== domainDigest || canonicalJson(stored.residency_domains) !== domain.json || stored.created_at !== createdAt) fail("MODEL_OUTPUT_CONFLICT", "model output preparation readback differs from the requested authority");
  }

  async function readOutput(binding: Pick<ModelOutputBinding, "output_object_ref" | "output_sha256">): Promise<Uint8Array> {
    const ref = inputText(binding.output_object_ref, "output reference");
    const expected = inputSha(binding.output_sha256, "output digest");
    const before = await readOne(input.database, ref);
    if (before === null || before.state !== "COMMITTED" || before.output_sha256 !== expected) fail("MODEL_OUTPUT_BINDING_MISSING", "committed model output is unavailable", true);
    await readAttemptBinding(input.database, before, true);
    const bytes = await verifyStoredObject(store, before);
    const after = await readOne(input.database, ref);
    if (after === null || !sameIdentity(before, after)) fail("MODEL_OUTPUT_UNCERTAIN", "model output binding changed during readback", true);
    await readAttemptBinding(input.database, after, true);
    return bytes;
  }

  return Object.freeze({ outputs: outputPort, readOutput, prepareOutputBinding });
}
