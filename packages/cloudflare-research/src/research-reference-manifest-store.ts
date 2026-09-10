import {
  AllowedReferenceManifestSchema,
  ObjectResidencyKeySchema,
  VersionedRefSchema,
  type AllowedReferenceManifest,
  type ObjectResidencyKey,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  evidenceSha256,
  evidenceSha256Bytes,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import {
  canonicalEvidenceObjectKey,
  createR2EvidenceObjectStore,
  objectResidencyKeyDigest,
  type ImmutableObjectReceipt,
} from "@eliotr/platform-cloudflare";
import type { ReferenceManifestStore } from "@eliotr/policy";
import { ReferenceManifestError } from "./research-reference-manifest.js";

const MAX_MANIFEST_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export interface ReferenceManifestStorageContext {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly manifest_residency_key: ObjectResidencyKey;
  readonly policy_authority_ref: string;
  readonly authorization_receipt_ref: string;
  readonly scope_snapshot_digest: string;
  readonly pack_ref: VersionedRef;
  readonly trace_ref: VersionedRef;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly created_at: string;
}

export interface ReferenceManifestReceipt {
  readonly manifest_ref: VersionedRef;
  readonly manifest_digest: string;
  readonly r2_content_sha256: string;
  readonly r2_key: string;
  readonly r2_etag: string;
  readonly r2_size_bytes: number;
  readonly existed_identically: boolean;
}

export interface ResearchReferenceManifestStore extends ReferenceManifestStore {
  persist(manifest: AllowedReferenceManifest): Promise<ReferenceManifestReceipt>;
  readReceipt(ref: VersionedRef): Promise<ReferenceManifestReceipt | null>;
}

interface ManifestRow {
  readonly manifest_id: unknown;
  readonly manifest_revision: unknown;
  readonly manifest_digest: unknown;
  readonly r2_content_sha256: unknown;
  readonly r2_residency_key_json: unknown;
  readonly r2_residency_key_digest: unknown;
  readonly r2_key: unknown;
  readonly r2_etag: unknown;
  readonly r2_size_bytes: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly scope_snapshot_digest: unknown;
  readonly policy_authority_ref: unknown;
  readonly authorization_receipt_ref: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly pack_ref_id: unknown;
  readonly pack_ref_revision: unknown;
  readonly trace_ref_id: unknown;
  readonly trace_ref_revision: unknown;
  readonly stage_attempt_ref: unknown;
  readonly stage_request_sha256: unknown;
  readonly state: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
}

function fail(code: ConstructorParameters<typeof ReferenceManifestError>[0], message: string, retryable = false, cause?: unknown): never {
  throw new ReferenceManifestError(code, message, retryable, cause);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) fail("REFERENCE_MANIFEST_INPUT_INVALID", `${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("REFERENCE_MANIFEST_INPUT_INVALID", `${label} is invalid`);
  return value;
}

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("REFERENCE_MANIFEST_INPUT_INVALID", `${label} is invalid`);
  return value as number;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isSafeInteger(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail("REFERENCE_MANIFEST_INPUT_INVALID", `${label} is not canonical ISO-8601`);
  }
  return value;
}

function ref(value: unknown, label: string): VersionedRef {
  try { return VersionedRefSchema.parse(value); }
  catch (cause) { fail("REFERENCE_MANIFEST_INPUT_INVALID", `${label} is invalid`, false, cause); }
}

function refKey(value: VersionedRef): string {
  return `${value.id}:${value.revision}`;
}

function manifestBytes(manifest: AllowedReferenceManifest): { readonly json: string; readonly bytes: Uint8Array; readonly digest: string } {
  const parsed = AllowedReferenceManifestSchema.parse(manifest);
  const json = canonicalEvidenceJson(parsed);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) fail("REFERENCE_MANIFEST_INPUT_INVALID", "reference manifest exceeds the R2 bound");
  return { json, bytes, digest: parsed.manifest_digest };
}

function validateContext(context: ReferenceManifestStorageContext): void {
  text(context.principal_ref, "principal_ref");
  text(context.credential_generation, "credential_generation");
  ref(context.scope_snapshot_ref, "scope_snapshot_ref");
  try { ObjectResidencyKeySchema.parse(context.manifest_residency_key); }
  catch (cause) { fail("REFERENCE_MANIFEST_INPUT_INVALID", "manifest residency key is invalid", false, cause); }
  text(context.policy_authority_ref, "policy_authority_ref");
  text(context.authorization_receipt_ref, "authorization_receipt_ref");
  sha(context.scope_snapshot_digest, "scope_snapshot_digest");
  ref(context.pack_ref, "pack_ref");
  ref(context.trace_ref, "trace_ref");
  text(context.stage_attempt_ref, "stage_attempt_ref");
  sha(context.stage_request_sha256, "stage_request_sha256");
  iso(context.created_at, "created_at");
}

function validateRow(row: ManifestRow): {
  readonly manifest_ref: VersionedRef;
  readonly manifest_digest: string;
  readonly r2_content_sha256: string;
  readonly r2_residency_key_json: string;
  readonly r2_residency_key_digest: string;
  readonly r2_key: string;
  readonly r2_etag: string;
  readonly r2_size_bytes: number;
} {
  const manifestRef = { id: text(row.manifest_id, "stored manifest id"), revision: revision(row.manifest_revision, "stored manifest revision") };
  const digest = sha(row.manifest_digest, "stored manifest digest");
  const contentDigest = sha(row.r2_content_sha256, "stored manifest R2 digest");
  const residencyJson = text(row.r2_residency_key_json, "stored manifest residency key");
  const residencyDigest = sha(row.r2_residency_key_digest, "stored manifest residency digest");
  const r2Key = text(row.r2_key, "stored manifest R2 key");
  const etag = text(row.r2_etag, "stored manifest ETag");
  const size = revision(row.r2_size_bytes, "stored manifest R2 size");
  if (row.state !== "WRITING" && row.state !== "COMMITTED") fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "stored reference manifest state is invalid", true);
  return { manifest_ref: manifestRef, manifest_digest: digest, r2_content_sha256: contentDigest, r2_residency_key_json: residencyJson, r2_residency_key_digest: residencyDigest, r2_key: r2Key, r2_etag: etag, r2_size_bytes: size };
}

function sameBinding(row: ManifestRow, manifest: AllowedReferenceManifest, context: ReferenceManifestStorageContext, residencyDigest: string): boolean {
  const scope = manifest.scope_snapshot_ref;
  return row.manifest_id === manifest.manifest_ref.id && row.manifest_revision === manifest.manifest_ref.revision &&
    row.manifest_digest === manifest.manifest_digest &&
    row.r2_residency_key_json === canonicalEvidenceJson(context.manifest_residency_key) &&
    row.r2_residency_key_digest === residencyDigest && row.scope_snapshot_id === scope.id &&
    row.scope_snapshot_revision === scope.revision && row.scope_snapshot_digest === context.scope_snapshot_digest &&
    row.policy_authority_ref === context.policy_authority_ref && row.authorization_receipt_ref === context.authorization_receipt_ref &&
    row.principal_ref === context.principal_ref && row.credential_generation === context.credential_generation &&
    row.pack_ref_id === context.pack_ref.id && row.pack_ref_revision === context.pack_ref.revision &&
    row.trace_ref_id === context.trace_ref.id && row.trace_ref_revision === context.trace_ref.revision &&
    row.stage_attempt_ref === context.stage_attempt_ref && row.stage_request_sha256 === context.stage_request_sha256 &&
    row.expires_at === manifest.expires_at;
}

function contextMatchesRow(row: ManifestRow, context: ReferenceManifestStorageContext, residencyDigest: string): boolean {
  return row.r2_residency_key_json === canonicalEvidenceJson(context.manifest_residency_key) &&
    row.r2_residency_key_digest === residencyDigest && row.scope_snapshot_id === context.scope_snapshot_ref.id &&
    row.scope_snapshot_revision === context.scope_snapshot_ref.revision &&
    row.scope_snapshot_digest === context.scope_snapshot_digest &&
    row.policy_authority_ref === context.policy_authority_ref &&
    row.authorization_receipt_ref === context.authorization_receipt_ref &&
    row.principal_ref === context.principal_ref &&
    row.credential_generation === context.credential_generation &&
    row.pack_ref_id === context.pack_ref.id && row.pack_ref_revision === context.pack_ref.revision &&
    row.trace_ref_id === context.trace_ref.id && row.trace_ref_revision === context.trace_ref.revision &&
    row.stage_attempt_ref === context.stage_attempt_ref && row.stage_request_sha256 === context.stage_request_sha256;
}

async function readR2(
  store: ReturnType<typeof createR2EvidenceObjectStore>,
  row: ReturnType<typeof validateRow>,
): Promise<ReferenceManifestReceipt & { readonly json: string }> {
  const object = await store.open(row.r2_key);
  if (object === null) fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "reference manifest object is missing", true);
  if (object.etag !== row.r2_etag || object.size !== row.r2_size_bytes || object.httpMetadata?.contentType !== "application/json") {
    fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "reference manifest object metadata differs from D1", true);
  }
  const metadata = object.customMetadata ?? {};
  if (metadata.eliotr_kind !== "research-reference-manifest" || metadata.eliotr_sha256 !== row.r2_content_sha256 || metadata.eliotr_size_bytes !== String(row.r2_size_bytes) || metadata.eliotr_immutable !== "true") {
    fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "reference manifest immutable metadata differs from D1", true);
  }
  let residency: ObjectResidencyKey;
  try { residency = ObjectResidencyKeySchema.parse(JSON.parse(row.r2_residency_key_json)); }
  catch (cause) { fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "reference manifest residency binding is invalid", true, cause); }
  if (canonicalEvidenceJson(residency) !== row.r2_residency_key_json ||
      await objectResidencyKeyDigest(residency) !== row.r2_residency_key_digest ||
      residency.content_digest.digest !== row.r2_content_sha256) {
    fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "reference manifest residency binding differs from R2 content", true);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== row.r2_size_bytes || await evidenceSha256Bytes(bytes) !== row.r2_content_sha256) {
    fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "reference manifest R2 readback digest differs from D1", true);
  }
  const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let parsed: AllowedReferenceManifest;
  try { parsed = AllowedReferenceManifestSchema.parse(JSON.parse(json)); }
  catch (cause) { fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "reference manifest R2 readback is not a valid contract", true, cause); }
  if (canonicalEvidenceJson(parsed) !== json || parsed.manifest_digest !== row.manifest_digest ||
      refKey(parsed.manifest_ref) !== refKey(row.manifest_ref)) {
    fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "reference manifest R2 readback is not canonical", true);
  }
  return { manifest_ref: row.manifest_ref, manifest_digest: row.manifest_digest, r2_content_sha256: row.r2_content_sha256, r2_key: row.r2_key, r2_etag: row.r2_etag, r2_size_bytes: row.r2_size_bytes, existed_identically: true, json };
}

export function createResearchReferenceManifestStore(input: {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly context: ReferenceManifestStorageContext;
  readonly navigation: NavigationReadAuthority;
}): ResearchReferenceManifestStore {
  validateContext(input.context);
  const database = input.database;
  const store = createR2EvidenceObjectStore(input.work_bucket);
  const residencyJson = canonicalEvidenceJson(input.context.manifest_residency_key);

  async function ensureCurrent(): Promise<Awaited<ReturnType<typeof input.navigation.current>>> {
    if (input.navigation.access.principal_ref !== input.context.principal_ref ||
        input.navigation.access.credential_generation !== input.context.credential_generation ||
        input.navigation.scope.digest !== input.context.scope_snapshot_digest ||
        input.navigation.scope.snapshot_id !== input.context.scope_snapshot_ref.id ||
        input.navigation.scope.revision !== input.context.scope_snapshot_ref.revision) {
      fail("REFERENCE_MANIFEST_SCOPE_STALE", "manifest store authority context differs from navigation authority");
    }
    const grant = await input.navigation.current();
    if (grant.authorization_receipt_ref !== input.context.authorization_receipt_ref ||
        grant.policy_authority_ref !== input.context.policy_authority_ref) {
      fail("REFERENCE_MANIFEST_SCOPE_STALE", "manifest authorization changed before readback", true);
    }
    return grant;
  }

  async function find(refValue: VersionedRef): Promise<ManifestRow | null> {
    return database.prepare(
      "SELECT manifest_id, manifest_revision, manifest_digest, r2_content_sha256, r2_residency_key_json, r2_residency_key_digest, r2_key, r2_etag, r2_size_bytes, scope_snapshot_id, scope_snapshot_revision, scope_snapshot_digest, policy_authority_ref, authorization_receipt_ref, principal_ref, credential_generation, pack_ref_id, pack_ref_revision, trace_ref_id, trace_ref_revision, stage_attempt_ref, stage_request_sha256, state, created_at, expires_at FROM research_reference_manifest WHERE manifest_id=?1 AND manifest_revision=?2 LIMIT 1",
    ).bind(refValue.id, refValue.revision).first<ManifestRow>();
  }

  async function receipt(refValue: VersionedRef): Promise<ReferenceManifestReceipt | null> {
    const found = await find(refValue);
    if (found === null || found.state !== "COMMITTED") return null;
    const residencyDigest = await objectResidencyKeyDigest(input.context.manifest_residency_key);
    if (!contextMatchesRow(found, input.context, residencyDigest)) fail("REFERENCE_MANIFEST_INPUT_INVALID", "manifest read is outside its exact authority binding");
    const before = await ensureCurrent();
    const row = validateRow(found);
    const readback = await readR2(store, row);
    const after = await ensureCurrent();
    if (canonicalEvidenceJson(before) !== canonicalEvidenceJson(after)) fail("REFERENCE_MANIFEST_SCOPE_STALE", "manifest authorization changed during readback", true);
    return { manifest_ref: readback.manifest_ref, manifest_digest: readback.manifest_digest, r2_content_sha256: readback.r2_content_sha256, r2_key: readback.r2_key, r2_etag: readback.r2_etag, r2_size_bytes: readback.r2_size_bytes, existed_identically: true };
  }

  async function persist(manifestInput: AllowedReferenceManifest): Promise<ReferenceManifestReceipt> {
    const manifest = AllowedReferenceManifestSchema.parse(manifestInput);
    if (manifest.client_fence_ref !== input.context.credential_generation ||
        manifest.scope_snapshot_ref.id !== input.context.scope_snapshot_ref.id ||
        manifest.scope_snapshot_ref.revision !== input.context.scope_snapshot_ref.revision) {
      fail("REFERENCE_MANIFEST_INPUT_INVALID", "manifest client fence or scope binding is invalid");
    }
    const encoded = manifestBytes(manifest);
    if (encoded.digest !== manifest.manifest_digest) fail("REFERENCE_MANIFEST_INPUT_INVALID", "manifest digest is invalid");
    const contentDigest = await evidenceSha256Bytes(encoded.bytes);
    const residencyDigest = await objectResidencyKeyDigest(input.context.manifest_residency_key);
    if (input.context.manifest_residency_key.content_digest.digest !== contentDigest) fail("REFERENCE_MANIFEST_INPUT_INVALID", "manifest residency content digest differs from canonical bytes");
    const expectedKey = await canonicalEvidenceObjectKey(input.context.manifest_residency_key, "research/reference-manifest", contentDigest);
    const { manifest_digest: _digest, ...manifestDigestPayload } = manifest;
    const computedManifestDigest = await evidenceSha256(manifestDigestPayload);
    if (computedManifestDigest !== manifest.manifest_digest) fail("REFERENCE_MANIFEST_INPUT_INVALID", "manifest digest is invalid");
    const existing = await find(manifest.manifest_ref);
    if (existing !== null) {
      if (!sameBinding(existing, manifest, input.context, residencyDigest) || existing.r2_key !== expectedKey) {
        fail("REFERENCE_MANIFEST_INPUT_INVALID", "manifest identity or authority binding conflicts with durable row");
      }
      if (existing.state === "COMMITTED") {
        const readback = await receipt(manifest.manifest_ref);
        if (readback === null) fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "committed manifest readback is missing", true);
        return { manifest_ref: readback.manifest_ref, manifest_digest: readback.manifest_digest, r2_content_sha256: readback.r2_content_sha256, r2_key: readback.r2_key, r2_etag: readback.r2_etag, r2_size_bytes: readback.r2_size_bytes, existed_identically: true };
      }
    } else {
      const result = await database.prepare(
        "INSERT INTO research_reference_manifest(manifest_id, manifest_revision, manifest_digest, r2_content_sha256, r2_residency_key_json, r2_residency_key_digest, r2_key, r2_etag, r2_size_bytes, scope_snapshot_id, scope_snapshot_revision, scope_snapshot_digest, policy_authority_ref, authorization_receipt_ref, principal_ref, credential_generation, pack_ref_id, pack_ref_revision, trace_ref_id, trace_ref_revision, stage_attempt_ref, stage_request_sha256, state, created_at, expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'PENDING',?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,'WRITING',?23,?24) ON CONFLICT(manifest_id, manifest_revision) DO NOTHING",
      ).bind(manifest.manifest_ref.id, manifest.manifest_ref.revision, manifest.manifest_digest, contentDigest, residencyJson, residencyDigest, expectedKey, encoded.bytes.byteLength, manifest.scope_snapshot_ref.id, manifest.scope_snapshot_ref.revision, input.context.scope_snapshot_digest, input.context.policy_authority_ref, input.context.authorization_receipt_ref, input.context.principal_ref, input.context.credential_generation, input.context.pack_ref.id, input.context.pack_ref.revision, input.context.trace_ref.id, input.context.trace_ref.revision, input.context.stage_attempt_ref, input.context.stage_request_sha256, input.context.created_at, manifest.expires_at).run();
      if (!result.success) fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "manifest reservation could not be persisted", true);
      const raced = await find(manifest.manifest_ref);
      if (raced === null || !sameBinding(raced, manifest, input.context, residencyDigest)) fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "manifest reservation readback is not exact", true);
    }
    const beforeR2 = await ensureCurrent();
    const body = new ArrayBuffer(encoded.bytes.byteLength);
    new Uint8Array(body).set(encoded.bytes);
    let r2Receipt: ImmutableObjectReceipt;
    try {
      r2Receipt = await store.putResidencyObject({
        residency_key: input.context.manifest_residency_key,
        prefix: "research/reference-manifest",
        body: new Response(body).body as ReadableStream<Uint8Array>,
        expected_sha256: contentDigest,
        expected_size_bytes: encoded.bytes.byteLength,
        content_type: "application/json",
        custom_metadata: { eliotr_kind: "research-reference-manifest" },
      });
    } catch (cause) {
      fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "reference manifest R2 write/readback is uncertain", true, cause);
    }
    const afterR2 = await ensureCurrent();
    if (canonicalEvidenceJson(beforeR2) !== canonicalEvidenceJson(afterR2)) fail("REFERENCE_MANIFEST_SCOPE_STALE", "manifest authorization changed during R2 settlement", true);
    const settled = await database.prepare(
      "UPDATE research_reference_manifest SET r2_etag=?1, state='COMMITTED' WHERE manifest_id=?2 AND manifest_revision=?3 AND manifest_digest=?4 AND r2_key=?5 AND state='WRITING'",
    ).bind(r2Receipt.etag, manifest.manifest_ref.id, manifest.manifest_ref.revision, manifest.manifest_digest, expectedKey).run();
    if (!settled.success || (settled.meta?.changes ?? 0) !== 1) {
      const recovered = await receipt(manifest.manifest_ref);
      if (recovered !== null) return recovered;
      fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "manifest settlement was not durably acknowledged", true);
    }
    const final = await receipt(manifest.manifest_ref);
    if (final === null) fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "manifest settlement readback is missing", true);
    return { ...final, existed_identically: r2Receipt.existed_identically };
  }

  return {
    async put(manifest) {
      return (await persist(manifest)).manifest_ref;
    },
    async get(refValue) {
      const found = await find(refValue);
      if (found === null || found.state !== "COMMITTED") return null;
      const residencyDigest = await objectResidencyKeyDigest(input.context.manifest_residency_key);
      if (!contextMatchesRow(found, input.context, residencyDigest)) fail("REFERENCE_MANIFEST_INPUT_INVALID", "manifest read is outside its exact authority binding");
      const before = await ensureCurrent();
      const readback = await readR2(store, validateRow(found));
      const after = await ensureCurrent();
      if (canonicalEvidenceJson(before) !== canonicalEvidenceJson(after)) fail("REFERENCE_MANIFEST_SCOPE_STALE", "manifest authorization changed during readback", true);
      return AllowedReferenceManifestSchema.parse(JSON.parse(readback.json));
    },
    persist,
    readReceipt: receipt,
  };
}
