/// <reference types="node" />
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ProjectClientGrantSchema, type OperationIntent } from "@eliotr/contracts";
import { applyCanonicalCoreMigrations, recordCanonicalCoreMigrationLedger } from "./core-migration-fixture.js";
import { BackupError } from "./shared.js";
import { createBackupPort } from "./index.js";
import { createControlledOffsiteAdapter, openOffsiteBackupPart } from "./offsite.js";
import { authorizeBackupDestination, revokeBackupDestination } from "./destination-authority.js";
import { destinationDescriptorDigest, destinationPolicyDigest, type BackupDestinationPolicy } from "./destination-policy.js";
import { verifyPortableBackupManifests } from "./portable-manifest.js";
import type { BackupSourcePorts } from "./epoch.js";
import type { Sha256DigestSink, EvidenceObjectStore } from "./shared.js";

const T = "2026-09-06T00:00:00.000Z";
const HEX = (c: string): string => c.repeat(64);
const NOW = Date.parse(T);
async function sha(b: Uint8Array): Promise<string> {
  const c = new Uint8Array(b.byteLength); c.set(b);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", c.buffer))].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function sink(): Sha256DigestSink {
  const chunks: Uint8Array[] = [];
  let res!: (v: ArrayBuffer) => void; let rej!: (r: unknown) => void;
  const result = new Promise<ArrayBuffer>((a, b) => { res = a; rej = b; });
  return { writable: new WritableStream<Uint8Array>({ write(c) { chunks.push(c.slice()); }, async close() { try { const t = chunks.reduce((s, c) => s + c.byteLength, 0); const body = new Uint8Array(t); let o = 0; for (const c of chunks) { body.set(c, o); o += c.byteLength; } const cp = new Uint8Array(body.byteLength); cp.set(body); res(await crypto.subtle.digest("SHA-256", cp.buffer)); } catch (e) { rej(e); } }, abort(r) { rej(r); } }), digest: result };
}
function d1Database(db: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    const stmt = db.prepare(sql);
    const runBound = (params: (string | number | null)[]) => ({
      async all<T>(): Promise<D1Result<T>> { return { results: stmt.all(...params) as unknown as T[], success: true, meta: {} } as unknown as D1Result<T>; },
      async first<T>(): Promise<T | null> { const r = stmt.get(...params) as unknown as T | undefined; return r ?? null; },
      async run<T>(): Promise<D1Result<T>> { stmt.run(...params); return { results: [], success: true, meta: {} } as unknown as D1Result<T>; },
    });
    return { bind(...p: unknown[]) { return runBound(p as (string | number | null)[]); }, ...runBound([]) };
  } } as unknown as D1Database;
}
interface ShimObject { bytes: Uint8Array; etag: string; version: string; customMetadata: Record<string, string>; httpMetadata: Record<string, string | Date> }
function shimBucket(): { bucket: R2Bucket; objects: Map<string, ShimObject> } {
  const objects = new Map<string, ShimObject>(); let seq = 0;
  const streamOf = (b: Uint8Array): ReadableStream<Uint8Array> => new ReadableStream({ start(c) { c.enqueue(b.slice()); c.close(); } });
  const metaOf = (k: string, o: ShimObject): Record<string, unknown> => ({ key: k, size: o.bytes.byteLength, etag: o.etag, version: o.version, customMetadata: { ...o.customMetadata }, httpMetadata: { ...o.httpMetadata } });
  const api = {
    async head(k: string) { const o = objects.get(k); return o === undefined ? null : metaOf(k, o); },
    async get(k: string) { const o = objects.get(k); if (o === undefined) return null; const f = o.bytes.slice(); return { ...metaOf(k, o), size: o.bytes.byteLength, body: streamOf(o.bytes), bytes: async () => f.slice(), arrayBuffer: async () => { const cp = new Uint8Array(f.byteLength); cp.set(f); return cp.buffer; } }; },
    async put(k: string, v: Uint8Array | ReadableStream<Uint8Array> | string, po?: Record<string, unknown>) {
      const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v instanceof Uint8Array ? v : new Uint8Array(await new Response(v as ReadableStream<Uint8Array>).arrayBuffer());
      seq += 1; objects.set(k, { bytes: bytes.slice(), etag: `etag-${seq}`, version: `version-${seq}`, customMetadata: { ...((po?.["customMetadata"] as Record<string, string> | undefined) ?? {}) }, httpMetadata: { ...((po?.["httpMetadata"] as Record<string, string | Date> | undefined) ?? {}) } });
      return { key: k, etag: `etag-${seq}`, version: `version-${seq}` };
    },
    async delete(i: string | string[]) { for (const k of typeof i === "string" ? [i] : i) objects.delete(k); },
    async list(lo?: { prefix?: string; limit?: number; cursor?: string }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(lo?.prefix ?? "")).sort();
      const s = lo?.cursor === undefined ? 0 : Number(lo.cursor);
      const page = keys.slice(s, s + (lo?.limit ?? 1000)); const n = s + (lo?.limit ?? 1000);
      return n < keys.length ? { objects: page.map((k) => metaOf(k, objects.get(k) as ShimObject)), truncated: true, cursor: String(n), delimitedPrefixes: [] } : { objects: page.map((k) => metaOf(k, objects.get(k) as ShimObject)), truncated: false, delimitedPrefixes: [] };
    },
  };
  return { bucket: api as unknown as R2Bucket, objects };
}
function testPartSink(bucket: R2Bucket): EvidenceObjectStore {
  return {
    async putImmutable(w) {
      const e = await bucket.get(w.key);
      if (e !== null) {
        const bytes = new Uint8Array(await new Response((e as R2ObjectBody).body as ReadableStream<Uint8Array>).arrayBuffer());
        const digest = await sha(bytes);
        if (digest !== w.expected_sha256 || bytes.byteLength !== w.expected_size_bytes) {
          throw new BackupError("BACKUP_PART_WRITE_FAILED", "immutable part conflict", false, {});
        }
        return { key: w.key, expected_sha256: w.expected_sha256, readback_sha256: digest, size_bytes: bytes.byteLength, etag: (e as unknown as { etag: string }).etag, existed_identically: true };
      }
      const bytes = new Uint8Array(await new Response(w.body as ReadableStream<Uint8Array>).arrayBuffer());
      await (bucket as unknown as { put(k: string, v: Uint8Array, o: unknown): Promise<{ etag: string }> }).put(w.key, bytes, { customMetadata: w.custom_metadata, httpMetadata: { contentType: w.content_type } });
      const head = await bucket.head(w.key) as unknown as { etag: string };
      return { key: w.key, expected_sha256: w.expected_sha256, readback_sha256: w.expected_sha256, size_bytes: bytes.byteLength, etag: head.etag, existed_identically: false };
    },
    async open(k) { return bucket.get(k); },
  };
}
function openCore(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyCanonicalCoreMigrations(db);
  recordCanonicalCoreMigrationLedger(db, T);
  return db;
}
function seedCore(db: DatabaseSync): void {
  db.exec(`INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,cutover_receipt_ref,created_at) VALUES ('ns-1',1,'owner-sys-1','incarnation-1','gen-1',1,'ACTIVE',NULL,'${T}');
    INSERT INTO source (source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode,kind,origin_uri,title,default_storage_policy,default_residency_profile_id,source_class,license_policy_ref,default_retention_policy_id,head_rev,created_at) VALUES ('source-1','ns-1','owner-sys-1','gen-1','immutable_import','document',NULL,'TITLE-7f3a','policy-store-1','profile-1','public','license-1','retention-1',NULL,'${T}');
    INSERT INTO source_revision (source_revision_ref,source_id,source_owner_generation,content_sha256,object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref,workspace_view_revision_ref,admitted_at) VALUES ('rev-1','source-1','gen-1','${HEX("a")}','${HEX("b")}',NULL,NULL,'${T}',NULL,'standard','LIVE','unknown','view-1',NULL,'${T}');
    INSERT INTO scope_snapshot (snapshot_id,revision,resolved_scope_expression_json,participant_generations_json,member_source_revision_refs_json,source_owner_generations_json,policy_authority_ref,disclosure_closure_digest,purge_ledger_revision,client_fence_ref,snapshot_digest,created_at,expires_at,invalidated_at,invalidation_reason) VALUES ('snap-1',1,'{}','{}','["rev-1"]','{}','policy-authority-1','${HEX("e")}',0,NULL,'${HEX("f")}','${T}','2027-09-06T00:00:00.000Z',NULL,NULL);
    INSERT INTO purge_ledger (erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) VALUES ('erasure-1','${HEX("4")}','COMPLETE','receipt-1','${T}');`);
}
function intent(k: string): OperationIntent {
  return { intent_ref: { id: "intent-1", revision: 1 }, operation_kind: "BACKUP", principal_ref: "tester", idempotency_key: k, payload_ref: "payload-1", policy_decision_ref: "policy-1", created_at: T };
}
function policy(over: Partial<BackupDestinationPolicy> = {}): BackupDestinationPolicy {
  return { destination_id: "offsite-1", failure_domain: "domain-remote", endpoint_identity: "endpoint-1", supports_deletion_journal: true, supports_expiry: true, retention_locked: false, retention_policy_ref: "retention-1", expiry_identity: "expiry-1", policy_version: "v1", owner_ref: "owner-1", authorization_receipt_ref: "auth-1", ...over };
}
async function setup() {
  const db = openCore(); seedCore(db);
  const evidence = shimBucket(); const work = shimBucket(); const parts = shimBucket();
  const coreDb = d1Database(db);
  const ports: BackupSourcePorts = { core_db: coreDb, evidence_bucket: evidence.bucket, work_bucket: work.bucket, part_sink: testPartSink(parts.bucket), create_sha256_sink: sink };
  const port = createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } });
  // Controller plane: authorize the test destination for the test principal +
  // policy decision before any caller copy. Caller refs alone never authorize.
  await authorizeBackupDestination(coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: policy(), authorization_receipt_ref: "auth-1" });
  return { db, coreDb, ports, port };
}
async function aesKey(len: number, usages: KeyUsage[] = ["encrypt", "decrypt"]): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: len }, false, usages);
}

describe("ER-34 O2 offsite copy (policy + hardened crypto)", () => {
  it("archives grant insert, revocation transition, and deletion without copying live authority", async () => {
    const db = openCore();
    seedCore(db);
    db.prepare(`INSERT INTO scope_access_grant(
      snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation,policy_authority_ref,
      allowed_use_json,disclosure_ceiling,authorization_receipt_ref,state,expires_at,created_at
    ) VALUES ('snap-1',1,'author-1','owner_pwa','credential-old','policy-authority-1','["research"]','local',
      'grant-receipt-1','ACTIVE','2027-01-01T00:00:00.000Z','2026-09-06T00:00:00.000Z')`).run();
    db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE authorization_receipt_ref='grant-receipt-1'").run();
    db.prepare("DELETE FROM scope_access_grant WHERE authorization_receipt_ref='grant-receipt-1'").run();
    expect(db.prepare("SELECT archive_revision,state,event_kind FROM historical_scope_access_grant ORDER BY archive_revision").all())
      .toEqual([
        { archive_revision: 1, state: "ACTIVE", event_kind: "INSERT" },
        { archive_revision: 2, state: "REVOKED", event_kind: "UPDATE" },
        { archive_revision: 3, state: "REVOKED", event_kind: "DELETE" },
      ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM scope_access_grant").get()).toEqual({ n: 0 });
    db.prepare("INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref,default_model_profile_ref,default_depth_profile_ref,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)")
      .run("project-1", "Project 1", "private", "project-default-retention-project-1", "project-default-source-project-1",
        "project-default-model-project-1", "project-default-depth-project-1", T);
    db.prepare("INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) VALUES (?1,?2,?3,?4,?5)")
      .run("project-1", "grantor-1", "fixture-deployment-1", T, T);
    const recordJson = JSON.stringify(ProjectClientGrantSchema.parse({
      protocol: "eliotr.project-client-grant.v1",
      grant_id: "client-grant-1",
      project_id: "project-1",
      grantor_principal_ref: "grantor-1",
      revision: 1,
      state: "ACTIVE",
      grantee: {
        issuer: "https://test.cloudflareaccess.com",
        authentication_method: "service_token",
        subject: "fixture-agent.access",
      },
      allowed_operations: ["catalog"],
      ingest_namespace_ids: [],
      expires_at: "2027-01-01T00:00:00.000Z",
      created_at: T,
      updated_at: T,
    }));
    const recordSha = await sha(new TextEncoder().encode(recordJson));
    db.prepare(`INSERT INTO project_client_grant(
      grant_id,revision,project_id,grantor_principal_ref,grantee_issuer,grantee_method,grantee_subject,
      state,expires_at,idempotency_key,request_sha256,record_json,record_sha256
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`)
      .run("client-grant-1", 1, "project-1", "grantor-1", "https://test.cloudflareaccess.com", "service_token",
        "fixture-agent.access", "ACTIVE", "2027-01-01T00:00:00.000Z", "idempotency-1", HEX("a"), recordJson, recordSha);
    expect(db.prepare("SELECT grant_id,grantor_principal_ref,state,event_kind FROM historical_project_client_grant").all())
      .toEqual([{ grant_id: "client-grant-1", grantor_principal_ref: "grantor-1", state: "ACTIVE", event_kind: "INSERT" }]);
  });

  it("parses the actual full portable epoch and validates its vector against every exported row", async () => {
    const h = await setup();
    const { draft } = await h.port.createPortableEpoch(intent("id-parse-portable"), { now_ms: NOW });
    const plaintext_parts = [];
    for (const part of draft.part_index) {
      const object = await h.ports.part_sink.open(part.part_key);
      expect(object).not.toBeNull();
      if (object === null) throw new Error("fixture portable part disappeared");
      plaintext_parts.push({ manifest: part.manifest, index: part.index, bytes: new Uint8Array(await new Response(object.body).arrayBuffer()) });
    }
    const parsed = await verifyPortableBackupManifests({ draft, plaintext_parts });
    expect(parsed.purge_ledger).toHaveLength(1);
    expect(parsed.source_rows.some((row) => row.table === "source" && row.row["source_id"] === "source-1")).toBe(true);
  });

  it("round-trips with controller authority; deterministic nonces converge across copies; exact replay returns persisted bytes", async () => {
    const h = await setup();
    const key = await aesKey(256);
    const draft = (await h.port.createPortableEpoch(intent("id-off-1"), { now_ms: NOW })).draft;
    const a1 = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const c1 = await h.port.copyOffsite({ draft, intent: intent("id-off-1"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: a1, now_ms: Date.now() });
    expect(c1.epoch.offsite_failure_domain).toBe("domain-remote");
    expect(c1.receipt.readback_receipt_refs).toContain("auth-1");
    const twin = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const c2 = await h.port.copyOffsite({ draft, intent: intent("id-off-1-twin"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: twin, now_ms: Date.now() });
    expect(c2.epoch).toEqual(c1.epoch);
    expect(c2.receipt).not.toEqual(c1.receipt);
    const ref = `offsite/${draft.epoch_id}/${draft.part_index[0]?.manifest}/${String(draft.part_index[0]?.index).padStart(6, "0")}-${draft.part_index[0]?.sha256}`;
    // Nonces derive per (key generation, copy/intent identity, part, content,
    // policy): distinct intents use distinct nonce material even for identical
    // plaintext under one key, while same-intent replay writes nothing new.
    expect(await sha(a1.peek(ref) as Uint8Array)).not.toBe(await sha(twin.peek(ref) as Uint8Array));
    const putsBefore = a1.puts;
    const replayed = await h.port.copyOffsite({ draft, intent: intent("id-off-1"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: a1, now_ms: Date.now() });
    expect(replayed.receipt).toEqual(c1.receipt);
    expect(replayed.epoch).toEqual(c1.epoch);
    expect(a1.puts).toBe(putsBefore);
  });
  it("copies bounded R2 payload chunks with exact metadata and denies a foreign epoch read", async () => {
    const h = await setup();
    const source = new TextEncoder().encode("payload-bound-to-this-r2-object/" + "r".repeat(1400));
    const sourceDigest = await sha(source);
    await (h.ports.evidence_bucket as unknown as { put(key: string, value: Uint8Array, options: unknown): Promise<unknown> }).put("evidence/exact-object", source, {
      customMetadata: { eliotr_sha256: sourceDigest, residency: "private" },
      httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store", cacheExpiry: new Date("2026-12-31T00:00:00.000Z") },
    });
    const draft = (await h.port.createPortableEpoch(intent("id-payload-offsite"), { now_ms: NOW })).draft;
    expect(draft.r2_payload_protocol).toBe("eliotr.r2-payload.v1");
    expect(draft.payload_part_index).toHaveLength(3);
    expect(draft.payload_part_index?.map((part) => part.size_bytes)).toEqual([512, 512, 408]);

    const plaintextParts = [];
    for (const part of draft.part_index) {
      const object = await h.ports.part_sink.open(part.part_key);
      expect(object).not.toBeNull();
      if (object === null) throw new Error("fixture portable part disappeared");
      plaintextParts.push({ manifest: part.manifest, index: part.index, bytes: new Uint8Array(await new Response(object.body).arrayBuffer()) });
    }
    const portable = await verifyPortableBackupManifests({ draft, plaintext_parts: plaintextParts });
    expect(portable.payload_supported).toBe(true);
    expect(portable.r2_objects).toContainEqual(expect.objectContaining({
      key: "evidence/exact-object", custom_metadata: { eliotr_sha256: sourceDigest, residency: "private" },
      http_metadata: { contentType: "application/octet-stream", cacheControl: "private, no-store", cacheExpiry: "2026-12-31T00:00:00.000Z" },
    }));

    const key = await aesKey(256);
    const adapter = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    await h.port.copyOffsite({ draft, intent: intent("id-payload-offsite"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter, now_ms: Date.now() });
    const descriptor = await adapter.describe();
    const readAuthority = {
      destination_id: "offsite-1", key_generation: "key-gen-1", expires_at: draft.expires_at,
      primary_failure_domain: "domain-primary", destination_policy_digest: await destinationPolicyDigest(policy()),
      descriptor_digest: await destinationDescriptorDigest(descriptor),
    };
    const restoredChunks: Uint8Array[] = [];
    for (const part of [...(draft.payload_part_index ?? [])].sort((a, b) => a.index - b.index)) {
      restoredChunks.push(await openOffsiteBackupPart({ draft, part, encryption_key: key, destination_policy: policy(), authority: readAuthority, adapter }));
    }
    expect(await sha(restoredChunks.reduce((all, chunk) => { const next = new Uint8Array(all.byteLength + chunk.byteLength); next.set(all); next.set(chunk, all.byteLength); return next; }, new Uint8Array()))).toBe(sourceDigest);
    await expect(openOffsiteBackupPart({ draft: { ...draft, epoch_id: "epoch-foreign" }, part: draft.payload_part_index?.[0] as NonNullable<typeof draft.payload_part_index>[number], encryption_key: key, destination_policy: policy(), authority: readAuthority, adapter }))
      .rejects.toMatchObject({ code: "BACKUP_PART_READBACK_MISMATCH" });
  });
  it("opens a copied part with the original AAD and rejects ciphertext tampering", async () => {
    const h = await setup();
    const key = await aesKey(256);
    const draft = (await h.port.createPortableEpoch(intent("id-open-part"), { now_ms: NOW })).draft;
    const adapter = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    await h.port.copyOffsite({ draft, intent: intent("id-open-part"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter, now_ms: Date.now() });
    const authority = {
      destination_id: "offsite-1",
      key_generation: "key-gen-1",
      expires_at: draft.expires_at,
      primary_failure_domain: "domain-primary",
      destination_policy_digest: await destinationPolicyDigest(policy()),
      descriptor_digest: await destinationDescriptorDigest(await adapter.describe()),
    };
    const part = draft.part_index[0];
    expect(part).toBeDefined();
    if (part === undefined) throw new Error("fixture epoch has no parts");
    const openInput = { draft, part, encryption_key: key, destination_policy: policy(), authority, adapter, now_ms: Date.now() };
    const plaintext = await openOffsiteBackupPart(openInput);
    expect(await sha(plaintext)).toBe(part.sha256);
    expect(new TextDecoder().decode(plaintext)).toContain("\"manifest_protocol\"");
    const corrupt: typeof adapter = {
      ...adapter,
      async get(partRef) {
        const read = await adapter.get(partRef);
        if (read === null) return null;
        const ciphertext = read.ciphertext.slice();
        ciphertext[ciphertext.length - 1] = (ciphertext[ciphertext.length - 1] ?? 0) ^ 1;
        return { ...read, ciphertext };
      },
    };
    await expect(openOffsiteBackupPart({ ...openInput, adapter: corrupt }))
      .rejects.toMatchObject({ code: "BACKUP_OFFSITE_READBACK_MISMATCH" });
    const malformed: typeof adapter = {
      ...adapter,
      async get(partRef) {
        const read = await adapter.get(partRef);
        return read === null ? null : { ...read, ciphertext: [1, 2, 3] as unknown as Uint8Array };
      },
    };
    await expect(openOffsiteBackupPart({ ...openInput, adapter: malformed }))
      .rejects.toMatchObject({ code: "BACKUP_PART_READBACK_MISMATCH" });
    const oversized: typeof adapter = {
      ...adapter,
      async get(partRef) {
        const read = await adapter.get(partRef);
        return read === null ? null : { ...read, ciphertext: new Uint8Array(part.size_bytes + 29) };
      },
    };
    await expect(openOffsiteBackupPart({ ...openInput, adapter: oversized }))
      .rejects.toMatchObject({ code: "BACKUP_PART_READBACK_MISMATCH" });
  });

  it("refuses copies with no controller authority and rejects adapter self-report", async () => {
    const h = await setup();
    const key = await aesKey(256);
    const draft = (await h.port.createPortableEpoch(intent("id-pol"), { now_ms: NOW })).draft;
    const base = { draft, intent: intent("id-pol"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", now_ms: Date.now() };
    // Caller-asserted owner/auth refs with no grant for that principal fail.
    await expect(h.port.copyOffsite({ ...base, intent: { ...intent("id-pol"), principal_ref: "stranger" }, destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }) })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(h.port.copyOffsite({ ...base, intent: { ...intent("id-pol"), policy_decision_ref: "policy-evil" }, destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }) })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(h.port.copyOffsite({ ...base, destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-evil", failure_domain: "domain-remote" }) })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(h.port.copyOffsite({ ...base, destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-primary" }) })).rejects.toMatchObject({ code: expect.any(String) });
    await expect(h.port.copyOffsite({ ...base, destination_policy: policy({ retention_locked: true }), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }) })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
  });
  it("refuses a revoked authority and a caller-forged clock", async () => {
    const h = await setup();
    const key = await aesKey(256);
    const draft = (await h.port.createPortableEpoch(intent("id-rev"), { now_ms: NOW })).draft;
    await revokeBackupDestination(h.coreDb, "offsite-1", "tester", "policy-1");
    await expect(h.port.copyOffsite({ draft, intent: intent("id-rev"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }), now_ms: Date.now() })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await authorizeBackupDestination(h.coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: policy(), authorization_receipt_ref: "auth-1" });
    await expect(h.port.copyOffsite({ draft, intent: intent("id-rev"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }), now_ms: Date.parse("2019-01-01T00:00:00.000Z") })).rejects.toMatchObject({ code: "BACKUP_INPUT_INVALID" });
  });
  it("validates key strength/type and detects nonce reuse, tamper and wrong key", async () => {
    const h = await setup();
    const key = await aesKey(256);
    const draft = (await h.port.createPortableEpoch(intent("id-crypto"), { now_ms: NOW })).draft;
    const base = { draft, intent: intent("id-crypto"), key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), now_ms: Date.now() };
    await expect(h.port.copyOffsite({ ...base, encryption_key: await aesKey(128), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }) })).rejects.toMatchObject({ code: "BACKUP_KEY_INVALID" });
    const fixed = new Uint8Array(12).fill(7);
    await expect(h.port.copyOffsite({ ...base, intent: intent("id-nonce"), encryption_key: key, adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }), generate_nonce: () => fixed.slice() })).rejects.toMatchObject({ code: "BACKUP_NONCE_COLLISION" });
    const corrupt = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote", faults: { corrupt_readback: "bytes" } });
    await expect(h.port.copyOffsite({ ...base, intent: intent("id-tamper"), encryption_key: key, adapter: corrupt })).rejects.toMatchObject({ code: "BACKUP_OFFSITE_READBACK_MISMATCH" });
    const good = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    await h.port.copyOffsite({ ...base, intent: intent("id-good"), encryption_key: key, adapter: good });
    const otherKey = await aesKey(256);
    const victim = { describe: () => good.describe(), put: (r: string, b: Uint8Array, s: never) => good.put(r, b, s), get: (r: string) => good.get(r), delete: (r: string, x: string) => good.delete(r, x) };
    const swappedDraft = draft;
    const wrongKeyInput = { draft: swappedDraft, intent: intent("id-wrong"), encryption_key: otherKey, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: victim, now_ms: Date.now() };
    await expect(h.port.copyOffsite(wrongKeyInput)).rejects.toMatchObject({ code: "BACKUP_OFFSITE_READBACK_MISMATCH" });
    void BackupError;
  });
  it("keeps key material and source bytes out of epoch/receipts", async () => {
    const h = await setup();
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    const rawHex = [...raw].map((v) => v.toString(16).padStart(2, "0")).join("");
    const draft = (await h.port.createPortableEpoch(intent("id-leak"), { now_ms: NOW })).draft;
    const copied = await h.port.copyOffsite({ draft, intent: intent("id-leak"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }), now_ms: Date.now() });
    const s = JSON.stringify({ epoch: copied.epoch, receipt: copied.receipt });
    expect(s).not.toContain(rawHex);
    expect(s).not.toContain("TITLE-7f3a");
  });
});
