import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createCloudflareAccessVerifier } from "@eliotr/cloudflare-access";
import type { ApplicationLifecycle } from "@eliotr/interfaces";
import { handleHttp } from "../src/http.js";
import { createSourceNamespaceOwnerService } from "../src/source-namespace-owner-service.js";
import type { NamespaceBootstrapProfileReader } from "../src/source-namespace-bootstrap-profiles.js";
import type { Env } from "../src/env.js";

interface Migration { name: string; queries: string[]; }
const runtime = env as unknown as Env & { CORE_MIGRATIONS: Migration[] };
const db = runtime.CORE_DB;
const issuer = "https://read-scope-renewal-test.cloudflareaccess.com";
const audience = "read-scope-renewal-test";
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "renewal-key", alg: "RS256", use: "sig" };
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
let nowMs = Date.now();
let modelCalls = 0;
const verifier = createCloudflareAccessVerifier({ team_domain: issuer, audience, clock_skew_seconds: 0 }, {
  async fetch(input) {
    expect(String(input)).toBe(`${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  },
  now: () => nowMs,
});
const unusedProfiles = {
  listCurrent: () => [],
  requireCurrent: () => { throw new Error("renewal must not load a bootstrap profile"); },
} as unknown as NamespaceBootstrapProfileReader;

async function signedToken(principal: string, expiresAtSeconds: number, issuedAt = Math.floor(nowMs / 1000)): Promise<string> {
  const payload = { iss: issuer, aud: [audience], sub: principal, type: "app", iat: issuedAt, exp: expiresAtSeconds };
  const signingInput = `${encode({ alg: "RS256", typ: "JWT", kid: "renewal-key" })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

function appFactory(database: typeof db = db) {
  const owner = createSourceNamespaceOwnerService({ database, profiles: unusedProfiles, now: () => nowMs });
  return () => ({
    services: {
      owner: { renewSourceNamespace: owner.renew },
      semantic: { run: async () => { modelCalls += 1; return {}; } },
      federation: {},
    },
    readiness: async () => ({ ready: true, blocking_reason_codes: [] }),
    reconcile: async () => ({ repaired: 0, still_pending: 0 }),
  }) as unknown as ApplicationLifecycle;
}

async function postRenew(
  namespaceId: string,
  principal: string,
  expiresAtSeconds: number,
  generation: number,
  issuedAt?: number,
  database: typeof db = db,
) {
  const token = await signedToken(principal, expiresAtSeconds, issuedAt);
  return handleHttp(new Request(`https://research.example/api/v1/library/namespaces/${namespaceId}/renew`, {
    method: "POST",
    headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": token },
    body: JSON.stringify({ expected_generation: generation }),
  }), runtime, {} as ExecutionContext, { accessVerifier: verifier, applicationFactory: appFactory(database) });
}

function databaseWithLostBatchAcknowledgement(): typeof db {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        await target.batch(statements);
        throw new Error("simulated lost D1 batch acknowledgement");
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as typeof db;
}

function databaseWithDelayedBatch(delayMs: number): { readonly database: typeof db; readonly batchCalls: () => number } {
  let calls = 0;
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        nowMs = Date.now();
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as typeof db;
  return { database, batchCalls: () => calls };
}

function databaseWithInterleavedOwnerSnapshot(input: {
  readonly principal: string;
  readonly credentialGeneration: string;
  readonly expiresAt: string;
}): typeof db {
  let inserted = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!inserted) {
          inserted = true;
          nowMs += 100;
          const createdAt = new Date(nowMs).toISOString();
          const snapshotId = `interleaved-${crypto.randomUUID()}`;
          const digest = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
          await target.prepare(
            "INSERT INTO scope_snapshot (snapshot_id,revision,resolved_scope_expression_json,participant_generations_json," +
            "member_source_revision_refs_json,source_owner_generations_json,policy_authority_ref,disclosure_closure_digest," +
            "purge_ledger_revision,client_fence_ref,snapshot_digest,created_at,expires_at,invalidated_at,invalidation_reason) " +
            "VALUES (?1,1,'{}','{}','[]','{}','policy-interleaved',?2,0,?3,?4,?5,?6,NULL,NULL)",
          ).bind(snapshotId, "a".repeat(64), input.credentialGeneration, digest, createdAt, input.expiresAt).run();
          await target.prepare(
            "INSERT INTO orientation_request (operation_id,principal_ref,client_class,credential_generation,idempotency_key," +
            "request_digest,state,snapshot_id,snapshot_revision,result_json,result_digest,created_at,expires_at) " +
            "VALUES (?1,?2,'owner_pwa',?3,?4,?5,'COMPLETE',?6,1,'{}',?7,?8,?9)",
          ).bind(`orientation-${snapshotId}`, input.principal, input.credentialGeneration, `idem-${snapshotId}`,
            "b".repeat(64), snapshotId, "c".repeat(64), createdAt, input.expiresAt).run();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as typeof db;
}

async function seedWorkspace(input: {
  readonly principal: string;
  readonly expires_at: string;
  readonly state?: "ACTIVE" | "REVOKED";
  readonly include_policy?: boolean;
}) {
  const namespace = `renewal-${crypto.randomUUID()}`;
  const createdAt = new Date(nowMs).toISOString();
  const ownerIncarnation = `incarnation-${namespace}`;
  const ownerGeneration = `owner-generation-${namespace}`;
  const policyRef = `policy-${namespace}`;
  const allowedUseJson = JSON.stringify(["research"]);
  await db.prepare(
    "INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref," +
    "source_owner_generation,source_admission_policy_revision,status,cutover_receipt_ref,created_at) " +
    "VALUES (?1,1,'eliotr',?2,?3,1,'ACTIVE',NULL,?4)",
  ).bind(namespace, ownerIncarnation, ownerGeneration, createdAt).run();
  await db.prepare(
    "INSERT INTO source_admission_policy (source_namespace_id,revision,authorized_principal_refs_json,allowed_ownership_modes_json," +
    "source_class,assurance_ceiling,instruction_taint,allowed_effects,allowed_use_json,disclosure_ceiling,license_policy_ref," +
    "default_storage_policy,default_residency_profile_id,default_retention_policy_id,minimum_quality_state,created_at) " +
    "VALUES (?1,1,?2,'[\"immutable_import\"]','document','QUALIFIED','DATA_ONLY','READ_ONLY','[\"research\"]'," +
    "'owner-only','license-renewal','NORMALIZED_CLOUD_ONLY','residency-renewal','retention-renewal','standard',?3)",
  ).bind(namespace, JSON.stringify([input.principal]), createdAt).run();
  if (input.include_policy !== false) {
    await db.prepare(
      "INSERT INTO scope_read_policy (source_namespace_id,principal_ref,client_class,policy_ref,generation,allowed_use_json," +
      "disclosure_ceiling,state,expires_at,created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,'owner-only',?5,?6,?7)",
    ).bind(namespace, input.principal, policyRef, allowedUseJson, input.state ?? "ACTIVE", input.expires_at, createdAt).run();
  }
  await db.prepare(
    "INSERT INTO source_namespace_initialization (source_namespace_id,principal_ref,credential_generation,profile_id,profile_revision," +
    "title,idempotency_key,owner_incarnation_ref,source_owner_generation,ownership_record_revision," +
    "source_admission_policy_revision,scope_policy_ref,scope_policy_generation,request_sha256,created_at) " +
    "VALUES (?1,?2,'bootstrap-credential','renewal-profile',1,'Renewal test workspace',?3,?4,?5,1,1,?6,1,?7,?8)",
  ).bind(namespace, input.principal, namespace, ownerIncarnation, ownerGeneration, policyRef, "a".repeat(64), createdAt).run();
  return { namespace, policyRef, allowedUseJson, createdAt };
}

async function row<T>(sql: string, ...values: (string | number)[]): Promise<T | null> {
  return db.prepare(sql).bind(...values).first<T>();
}

beforeEach(async () => {
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS);
  nowMs = Date.now();
  modelCalls = 0;
});

describe("owner namespace read lease renewal over verified HTTP and D1", () => {
  it("extends only the requested ACTIVE workspace to the verified JWT expiry and settles concurrent retries", async () => {
    const principal = `renewal-owner-${crypto.randomUUID()}`;
    const expirySeconds = Math.floor(nowMs / 1000) + 3600;
    const jwtExpiry = new Date(expirySeconds * 1000).toISOString();
    const target = await seedWorkspace({ principal, expires_at: new Date(nowMs - 60_000).toISOString() });
    const untouched = await seedWorkspace({ principal, expires_at: new Date((expirySeconds + 3600) * 1000).toISOString() });
    const responses = await Promise.all(Array.from({ length: 3 }, () =>
      postRenew(target.namespace, principal, expirySeconds, 1)));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    for (const response of responses) expect(await response.json()).toMatchObject({ data: {
      source_namespace_id: target.namespace, read_policy_generation: 2, read_expires_at: jwtExpiry, read_access: "ACTIVE",
    } });
    expect(await row<{ generation: number; allowed_use_json: string; disclosure_ceiling: string; expires_at: string }>(
      "SELECT generation,allowed_use_json,disclosure_ceiling,expires_at FROM scope_read_policy WHERE source_namespace_id=?1",
      target.namespace)).toEqual({ generation: 2, allowed_use_json: target.allowedUseJson, disclosure_ceiling: "owner-only", expires_at: jwtExpiry });
    expect(await row<{ generation: number; expires_at: string }>(
      "SELECT generation,expires_at FROM scope_read_policy WHERE source_namespace_id=?1", untouched.namespace))
      .toEqual({ generation: 1, expires_at: new Date((expirySeconds + 3600) * 1000).toISOString() });
    expect(await row<{ count: number }>(
      "SELECT COUNT(*) AS count FROM scope_read_policy_lease_refresh_receipt WHERE source_namespace_id=?1 AND state='APPLIED'",
      target.namespace)).toEqual({ count: 1 });
    expect(await row<{ count: number }>("SELECT COUNT(*) AS count FROM orientation_request WHERE principal_ref=?1", principal))
      .toEqual({ count: 0 });
    expect(await row<{ count: number }>("SELECT COUNT(*) AS count FROM scope_access_grant WHERE principal_ref=?1", principal))
      .toEqual({ count: 0 });
    expect(modelCalls).toBe(0);
  });

  it("renews again for a later verified login while a lease already covering the JWT is a no-op", async () => {
    const principal = `relogin-owner-${crypto.randomUUID()}`;
    const firstExpiry = Math.floor(nowMs / 1000) + 600;
    const workspace = await seedWorkspace({ principal, expires_at: new Date(nowMs + 120_000).toISOString() });
    const first = await postRenew(workspace.namespace, principal, firstExpiry, 1);
    expect(first.status).toBe(200);
    const firstLease = new Date(firstExpiry * 1000).toISOString();
    expect(await row<{ generation: number; expires_at: string }>(
      "SELECT generation,expires_at FROM scope_read_policy WHERE source_namespace_id=?1", workspace.namespace))
      .toEqual({ generation: 2, expires_at: firstLease });

    nowMs += 10_000;
    const laterExpiry = Math.floor(nowMs / 1000) + 3600;
    const second = await postRenew(workspace.namespace, principal, laterExpiry, 2);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ data: { read_policy_generation: 3, read_expires_at: new Date(laterExpiry * 1000).toISOString() } });
    expect(await row<{ count: number }>(
      "SELECT COUNT(*) AS count FROM scope_read_policy_lease_refresh_receipt WHERE source_namespace_id=?1 AND state='APPLIED'",
      workspace.namespace)).toEqual({ count: 2 });

    const covered = await seedWorkspace({ principal, expires_at: new Date((laterExpiry + 3600) * 1000).toISOString() });
    const noop = await postRenew(covered.namespace, principal, laterExpiry, 1);
    expect(noop.status).toBe(200);
    expect(await row<{ generation: number; expires_at: string }>(
      "SELECT generation,expires_at FROM scope_read_policy WHERE source_namespace_id=?1", covered.namespace))
      .toEqual({ generation: 1, expires_at: new Date((laterExpiry + 3600) * 1000).toISOString() });
    expect(await row<{ count: number }>(
      "SELECT COUNT(*) AS count FROM scope_read_policy_lease_refresh_receipt WHERE source_namespace_id=?1",
      covered.namespace)).toEqual({ count: 0 });
    expect(modelCalls).toBe(0);
  });

  it("reconciles a lost batch acknowledgement from the exact APPLIED receipt", async () => {
    const principal = `lost-ack-owner-${crypto.randomUUID()}`;
    const expiry = Math.floor(nowMs / 1000) + 3600;
    const workspace = await seedWorkspace({ principal, expires_at: new Date(nowMs - 1000).toISOString() });
    const response = await postRenew(workspace.namespace, principal, expiry, 1, undefined,
      databaseWithLostBatchAcknowledgement());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: {
      source_namespace_id: workspace.namespace, read_policy_generation: 2,
      read_expires_at: new Date(expiry * 1000).toISOString(),
    } });
    expect(await row<{ count: number }>(
      "SELECT COUNT(*) AS count FROM scope_read_policy_lease_refresh_receipt WHERE source_namespace_id=?1 AND state='APPLIED'",
      workspace.namespace)).toEqual({ count: 1 });
    expect(modelCalls).toBe(0);
  });

  it("does not advance a policy when the D1 batch runs after the verified JWT expires", async () => {
    const principal = `late-batch-owner-${crypto.randomUUID()}`;
    const expiry = Math.floor(nowMs / 1000) + 2;
    const oldExpiry = new Date(nowMs - 1000).toISOString();
    const workspace = await seedWorkspace({ principal, expires_at: oldExpiry });
    const delayed = databaseWithDelayedBatch(2200);
    const response = await postRenew(workspace.namespace, principal, expiry, 1, undefined, delayed.database);

    expect(delayed.batchCalls()).toBe(1);
    expect(response.status).toBe(403);
    expect(await row<{ generation: number; expires_at: string }>(
      "SELECT generation,expires_at FROM scope_read_policy WHERE source_namespace_id=?1", workspace.namespace))
      .toEqual({ generation: 1, expires_at: oldExpiry });
    expect(await row<{ count: number }>(
      "SELECT COUNT(*) AS count FROM scope_read_policy_lease_refresh_receipt WHERE source_namespace_id=?1",
      workspace.namespace)).toEqual({ count: 0 });
    expect(modelCalls).toBe(0);
  });

  it("records a receipt event for an owner snapshot created immediately before the renewal batch", async () => {
    const principal = `interleaved-owner-${crypto.randomUUID()}`;
    const expiry = Math.floor(nowMs / 1000) + 3600;
    const jwtExpiry = new Date(expiry * 1000).toISOString();
    const workspace = await seedWorkspace({ principal, expires_at: new Date(nowMs - 1000).toISOString() });
    const credentialGeneration = "access-interleaved";
    const database = databaseWithInterleavedOwnerSnapshot({ principal, credentialGeneration, expiresAt: jwtExpiry });

    const response = await postRenew(workspace.namespace, principal, expiry, 1, undefined, database);

    expect(response.status).toBe(200);
    expect(await row<{ generation: number; expires_at: string }>(
      "SELECT generation,expires_at FROM scope_read_policy WHERE source_namespace_id=?1", workspace.namespace))
      .toEqual({ generation: 2, expires_at: jwtExpiry });
    const eventOrder = await row<{ snapshot_created_at: string; receipt_created_at: string }>(
      "SELECT s.created_at AS snapshot_created_at,r.created_at AS receipt_created_at " +
      "FROM orientation_request o JOIN scope_snapshot s ON s.snapshot_id=o.snapshot_id AND s.revision=o.snapshot_revision " +
      "JOIN scope_read_policy_lease_refresh_receipt r ON r.principal_ref=o.principal_ref " +
      "WHERE o.principal_ref=?1 AND r.source_namespace_id=?2 LIMIT 1", principal, workspace.namespace);
    if (eventOrder === null) throw new Error("interleaved receipt event order was not persisted");
    expect(Date.parse(eventOrder.snapshot_created_at)).toBeGreaterThan(Date.parse(eventOrder.receipt_created_at));
    const linkedSnapshot = await row<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM orientation_request WHERE principal_ref=?1 AND snapshot_id LIKE 'interleaved-%' LIMIT 1", principal);
    if (linkedSnapshot === null) throw new Error("interleaved owner snapshot was not linked");
    const events = await db.prepare(
      "SELECT event_kind,refresh_id,receipt_sequence FROM scope_read_policy_history_event " +
      "WHERE snapshot_id=?1 ORDER BY event_id",
    ).bind(linkedSnapshot.snapshot_id).all<{ readonly event_kind: string; readonly refresh_id: string | null; readonly receipt_sequence: number }>();
    expect(events.success).toBe(true);
    expect(events.results?.map((event) => event.event_kind)).toEqual(["SNAPSHOT_BASELINE", "LEASE_REFRESH"]);
    expect(events.results?.[1]?.refresh_id).toMatch(/^scope-lease-refresh-[0-9a-f]{64}$/u);
    expect(events.results?.[1]?.receipt_sequence).toBeGreaterThan(events.results?.[0]?.receipt_sequence ?? -1);
    expect(modelCalls).toBe(0);
  });

  it("rejects missing, revoked, foreign, invalid, and changed ownership or admission contexts", async () => {
    const principal = `reject-owner-${crypto.randomUUID()}`;
    const expiry = Math.floor(nowMs / 1000) + 3600;
    const missing = await seedWorkspace({ principal, expires_at: new Date(nowMs - 1).toISOString(), include_policy: false });
    expect((await postRenew(missing.namespace, principal, expiry, 1)).status).toBe(404);
    const revoked = await seedWorkspace({ principal, expires_at: new Date(nowMs - 1).toISOString(), state: "REVOKED" });
    expect((await postRenew(revoked.namespace, principal, expiry, 1)).status).toBe(409);
    const foreign = await seedWorkspace({ principal, expires_at: new Date(nowMs - 1).toISOString() });
    expect((await postRenew(foreign.namespace, `other-${crypto.randomUUID()}`, expiry, 1)).status).toBe(404);
    const expiredToken = await postRenew(foreign.namespace, principal, Math.floor(nowMs / 1000) - 1, 1,
      Math.floor(nowMs / 1000) - 3600);
    expect(expiredToken.status).toBe(401);

    const changedOwner = await seedWorkspace({ principal, expires_at: new Date(nowMs - 1).toISOString() });
    await db.prepare("UPDATE source_namespace_ownership SET owner_incarnation_ref='changed-incarnation' WHERE source_namespace_id=?1")
      .bind(changedOwner.namespace).run();
    expect((await postRenew(changedOwner.namespace, principal, expiry, 1)).status).toBe(404);
    const changedAdmission = await seedWorkspace({ principal, expires_at: new Date(nowMs - 1).toISOString() });
    await db.prepare("UPDATE source_namespace_ownership SET source_admission_policy_revision=2 WHERE source_namespace_id=?1")
      .bind(changedAdmission.namespace).run();
    expect((await postRenew(changedAdmission.namespace, principal, expiry, 1)).status).toBe(404);
    expect(await row<{ count: number }>(
      "SELECT COUNT(*) AS count FROM scope_read_policy_lease_refresh_receipt WHERE principal_ref=?1", principal))
      .toEqual({ count: 0 });
    expect(modelCalls).toBe(0);
  });
});
