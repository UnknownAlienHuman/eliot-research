import { beforeEach, describe, expect, it } from "vitest";
import { reset } from "cloudflare:test";
import type { ProjectClientGrant, ProjectClientGrantPut } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { authorizeProjectClientGrant, createD1ScopeService, createOwnerScopeAuthority,
  createProjectClientGrantService, createProjectClientScopeAuthority, createProjectOwnerService } from "@eliotr/cloudflare-navigation";
import { db, insert, observeDatabase, principal, runtime, seedSource, setupOrientationDatabase } from "./orientation-fixture.js";

const issuer = "https://team-example.cloudflareaccess.com";
const credential = "credential-v1";
let clock: number;
beforeEach(async () => { await reset(); await setupOrientationDatabase(); clock = Date.now(); });

// These contexts are direct-service fixtures. They do not establish signed HTTP authentication.
function context(key: string, who = principal): AuthenticatedRequestContext {
  return { request: new Request("https://research.example/api/v1/research/projects", {
    method: "POST", headers: { "idempotency-key": key },
  }), principal_ref: who, client_class: "owner_pwa", credential_generation: credential,
  trace_id: `trace-${key}`, access: { principal_ref: who, credential_generation: credential,
    expires_at: new Date(clock + 3_600_000).toISOString() } };
}

function service(database = db) {
  return createProjectClientGrantService({ database, trusted_issuers: [issuer], now: () => clock });
}

function input(expected_revision = 0, subject = "client.access",
  allowed_operations: ProjectClientGrantPut["allowed_operations"] = ["status", "catalog"]): ProjectClientGrantPut {
  return { expected_revision, grantee: { issuer, authentication_method: "service_token", subject },
    allowed_operations: [...allowed_operations], ingest_namespace_ids: [],
    expires_at: new Date(clock + 3_600_000).toISOString() };
}

async function project(key = "project-create", title = "Grant project", source_ids: readonly string[] = []) {
  // The real owner service creates the project; optional seeded members exercise source and scope paths.
  const owner = createProjectOwnerService({ database: db, deployment_generation: runtime.DEPLOYMENT_GENERATION, now: () => clock });
  const created = await owner.create(context(key), {
    idempotency_key: key, title, source_ids: [...source_ids],
  });
  return created.project_ref.id;
}

async function updateProject(id: string, key: string, expected_revision: number, title: string,
  source_ids: readonly string[] = []): Promise<void> {
  const owner = createProjectOwnerService({ database: db, deployment_generation: runtime.DEPLOYMENT_GENERATION, now: () => clock });
  await owner.update(context(key), id, { idempotency_key: key, expected_revision, title, source_ids: [...source_ids] });
}

async function seedReadableSource(id: string): Promise<void> {
  await seedSource(id);
  await insert("source_admission_policy", { source_namespace_id: `ns-${id}`, revision: 1,
    authorized_principal_refs_json: JSON.stringify([principal]), allowed_ownership_modes_json: '["immutable_import"]',
    source_class: "document", assurance_ceiling: "QUALIFIED", instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY",
    allowed_use_json: '["research"]', disclosure_ceiling: "private", license_policy_ref: "license-1",
    default_storage_policy: "NORMALIZED_CLOUD_ONLY", default_residency_profile_id: "residency-1",
    default_retention_policy_id: "retention-1", minimum_quality_state: "standard", created_at: new Date(clock).toISOString() });
}

function serviceContext(key: string, grantId: string): AuthenticatedRequestContext {
  const who = "client.access";
  return { ...context(key, who), client_class: "named_api_client",
    request: new Request("https://research.example/api/v1/research/projects", {
      headers: { "X-Eliotr-Client-Grant": grantId },
    }),
    access: { principal_ref: who, credential_generation: credential, expires_at: new Date(clock + 3_600_000).toISOString(),
      issuer, authentication_method: "service_token" } };
}

async function snapshot() {
  const tables = ["project", "project_owner", "project_source_membership", "project_mutation_receipt",
    "project_mutation_guard", "project_client_grant", "orientation_authority_epoch", "outbox"] as const;
  return Promise.all(tables.map(async (table) => {
    const result = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    expect(result.success).toBe(true);
    return { table, rows: result.results };
  }));
}

async function receipt(grant: ProjectClientGrant, key: string, operation: "PUT" | "DELETE",
  raw: ProjectClientGrantPut | { expected_revision: number }) {
  const row = await db.prepare("SELECT grant_id,revision,idempotency_key,record_json,record_sha256,request_sha256," +
    "spend_policy_protocol,spend_policy_sha256,spend_deployment_generation,spend_expires_at " +
    "FROM project_client_grant WHERE grantor_principal_ref=?1 AND idempotency_key=?2")
    .bind(principal, key).first<{ grant_id: string; revision: number; idempotency_key: string;
      record_json: string; record_sha256: string; request_sha256: string; spend_policy_protocol: string | null;
      spend_policy_sha256: string | null; spend_deployment_generation: string | null; spend_expires_at: string | null }>();
  if (row === null) throw new Error("Missing immutable grant receipt");
  const normalized = "grantee" in raw ? { ...raw, allowed_operations: [...raw.allowed_operations].sort(),
    ingest_namespace_ids: [...raw.ingest_namespace_ids].sort(), expires_at: new Date(raw.expires_at).toISOString() } : raw;
  expect(row).toMatchObject({ grant_id: grant.grant_id, revision: grant.revision, idempotency_key: key,
    record_json: canonicalJson(grant), record_sha256: await sha256Utf8(canonicalJson(grant)),
    request_sha256: await sha256Utf8(canonicalJson({ protocol: "eliotr.project-client-grant-mutation.v1",
      operation, project_id: grant.project_id, grant_id: grant.grant_id, grantor_principal_ref: principal, input: normalized })),
    spend_policy_protocol: null, spend_policy_sha256: null, spend_deployment_generation: null, spend_expires_at: null });
}

describe("S91.1 project-client grants on actual Workers D1", () => {
  it("issues, revises and revokes with exact immutable receipts, current view and restart replay", async () => {
    const id = await project();
    const initialInput = input();
    const initial = await service().put(context("grant-create"), id, "grant-1", initialInput);
    expect(initial).toMatchObject({ grant_id: "grant-1", project_id: id, revision: 1, state: "ACTIVE",
      allowed_operations: ["catalog", "status"], grantor_principal_ref: principal });
    await receipt(initial, "grant-create", "PUT", initialInput);
    const created = await snapshot();
    await expect(service().put(context("grant-create"), id, "grant-1", initialInput)).resolves.toEqual(initial);
    expect(await snapshot()).toEqual(created);

    clock += 1;
    const changedInput = { ...input(1), allowed_operations: ["catalog"] as const };
    const updateInput: ProjectClientGrantPut = { ...changedInput, allowed_operations: [...changedInput.allowed_operations] };
    const updated = await service().put(context("grant-update"), id, "grant-1", updateInput);
    expect(updated).toMatchObject({ revision: 2, state: "ACTIVE", allowed_operations: ["catalog"], created_at: initial.created_at });
    await receipt(updated, "grant-update", "PUT", updateInput);
    await expect(service().list(context("list-updated"), id)).resolves.toEqual({ protocol: "eliotr.project-client-grants.v1", grants: [updated] });
    const revised = await snapshot();
    await expect(service().put(context("grant-update"), id, "grant-1", updateInput)).resolves.toEqual(updated);
    expect(await snapshot()).toEqual(revised);

    clock += 1;
    const revokeInput = { expected_revision: 2 };
    const revoked = await service().revoke(context("grant-revoke"), id, "grant-1", revokeInput);
    expect(revoked).toMatchObject({ revision: 3, state: "REVOKED", created_at: initial.created_at });
    await receipt(revoked, "grant-revoke", "DELETE", revokeInput);
    await expect(service().list(context("list-revoked"), id)).resolves.toEqual({ protocol: "eliotr.project-client-grants.v1", grants: [revoked] });
    const settled = await snapshot();
    await expect(service().revoke(context("grant-revoke"), id, "grant-1", revokeInput)).resolves.toEqual(revoked);
    expect(await snapshot()).toEqual(settled);
    // Earlier completed mutation replay returns its own receipt, not renewed current authority.
    await expect(service().put(context("grant-create"), id, "grant-1", initialInput)).resolves.toEqual(initial);
    expect(await snapshot()).toEqual(settled);
    const rows = await db.prepare("SELECT revision,state FROM project_client_grant WHERE grant_id=?1 ORDER BY revision")
      .bind("grant-1").all<{ revision: number; state: string }>();
    expect(rows.results).toEqual([{ revision: 1, state: "ACTIVE" }, { revision: 2, state: "ACTIVE" }, { revision: 3, state: "REVOKED" }]);
  });

  it("rejects stale, foreign, malformed and conflicting replay requests without partial durable state", async () => {
    const id = await project(); const initialInput = input();
    await service().put(context("grant-create"), id, "grant-1", initialInput);
    const before = await snapshot();
    const refused: Array<{ key: string; actor: AuthenticatedRequestContext; value: unknown; code: string; status: number }> = [
      { key: "stale", actor: context("stale"), value: input(0), code: "CLIENT_GRANT_REVISION_CONFLICT", status: 409 },
      { key: "foreign", actor: context("foreign", "other-owner"), value: input(1), code: "CLIENT_GRANT_PROJECT_UNAVAILABLE", status: 404 },
      { key: "unknown", actor: context("unknown"), value: { ...input(1), forged_authority: true }, code: "CLIENT_GRANT_INPUT_INVALID", status: 400 },
      { key: "duplicate", actor: context("duplicate"), value: { ...input(1), allowed_operations: ["catalog", "catalog"] }, code: "CLIENT_GRANT_INPUT_INVALID", status: 400 },
      { key: "grant-create", actor: context("grant-create"), value: { ...initialInput, allowed_operations: ["query"] }, code: "CLIENT_GRANT_IDEMPOTENCY_CONFLICT", status: 409 },
      { key: "issuer", actor: context("issuer"), value: { ...input(1), grantee: { ...input(1).grantee, issuer: "https://foreign-example.cloudflareaccess.com" } }, code: "CLIENT_GRANT_ISSUER_DENIED", status: 403 },
      { key: "expired", actor: context("expired"), value: { ...input(1), expires_at: new Date(clock - 1).toISOString() }, code: "CLIENT_GRANT_INPUT_INVALID", status: 400 },
    ];
    for (const denied of refused) {
      await expect(service().put(denied.actor, id, "grant-1", denied.value), denied.key)
        .rejects.toMatchObject({ code: denied.code, status: denied.status });
      expect(await snapshot(), denied.key).toEqual(before);
    }
    const expired = context("expired-owner");
    await expect(service().revoke({ ...expired, access: { principal_ref: principal, credential_generation: credential,
      expires_at: new Date(clock - 1).toISOString() } }, id, "grant-1", { expected_revision: 1 }))
      .rejects.toMatchObject({ code: "CLIENT_GRANT_OWNER_REQUIRED", status: 403 });
    expect(await snapshot()).toEqual(before);
  });

  it("keeps one logical actor grant and cannot reassign an existing grant", async () => {
    const id = await project(); const initialInput = input();
    await service().put(context("grant-create"), id, "grant-1", initialInput);
    const before = await snapshot();
    await expect(service().put(context("duplicate-actor"), id, "grant-2", initialInput))
      .rejects.toMatchObject({ code: "CLIENT_GRANT_IDENTITY_CONFLICT", status: 409 });
    await expect(service().put(context("reassign"), id, "grant-1", input(1, "other.access")))
      .rejects.toMatchObject({ code: "CLIENT_GRANT_IDENTITY_CONFLICT", status: 409 });
    expect(await snapshot()).toEqual(before);
  });

  it("reconciles an effect-before-lost-ACK against the exact native receipt and does not repeat the write", async () => {
    const id = await project(); const initialInput = input(); let writes = 0;
    const observed = observeDatabase(async (sql, phase) => {
      if (phase === "after" && sql.startsWith("INSERT INTO project_client_grant (")) {
        writes += 1;
        if (writes === 1) throw new Error("Lost native grant acknowledgement after commit");
      }
    });
    const granted = await service(observed).put(context("lost-ack"), id, "grant-1", initialInput);
    await receipt(granted, "lost-ack", "PUT", initialInput);
    const committed = await snapshot();
    await expect(service(observed).put(context("lost-ack"), id, "grant-1", initialInput)).resolves.toEqual(granted);
    expect(writes).toBe(1);
    expect(await snapshot()).toEqual(committed);
  });

  it("settles a competing native winner and leaves no losing revision or receipt", async () => {
    const id = await project(); const initialInput = input(); let winner: ProjectClientGrant | undefined;
    let committed: Awaited<ReturnType<typeof snapshot>> | undefined;
    const observed = observeDatabase(async (sql, phase) => {
      if (phase === "before" && sql.startsWith("INSERT INTO project_client_grant (") && winner === undefined) {
        winner = await service().put(context("winner"), id, "grant-1", initialInput);
        committed = await snapshot();
      }
    });
    await expect(service(observed).put(context("loser"), id, "grant-1", initialInput))
      .rejects.toMatchObject({ code: "CLIENT_GRANT_REVISION_CONFLICT", status: 409 });
    if (winner === undefined || committed === undefined) throw new Error("Native competing winner was not reached");
    await receipt(winner, "winner", "PUT", initialInput);
    expect(await snapshot()).toEqual(committed);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM project_client_grant WHERE idempotency_key=?1").bind("loser").first<number>("n")).toBe(0);
    await expect(service().put(context("winner"), id, "grant-1", initialInput)).resolves.toEqual(winner);
    expect(await snapshot()).toEqual(committed);
  });

  it("fences an actual membership-authority change before the final native grant INSERT", async () => {
    await seedReadableSource("authority-source");
    const id = await project(); let changed = false;
    let committed: Awaited<ReturnType<typeof snapshot>> | undefined;
    const observed = observeDatabase(async (sql, phase) => {
      if (phase === "before" && sql.startsWith("INSERT INTO project_client_grant (") && !changed) {
        changed = true;
        await updateProject(id, "project-change", 1, "Membership changed", ["authority-source"]);
        committed = await snapshot();
      }
    });
    await expect(service(observed).put(context("stale-authority"), id, "grant-1", input()))
      .rejects.toMatchObject({ code: "CLIENT_GRANT_AUTHORITY_CHANGED", status: 409 });
    if (committed === undefined) throw new Error("Actual project authority mutation was not reached");
    expect(await snapshot()).toEqual(committed);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM project_client_grant").first<number>("n")).toBe(0);
  });

  it("honors late revoke and rejects locator-only, foreign, expired and out-of-operation service authority", async () => {
    const id = await project();
    const granted = await service().put(context("grant-create"), id, "grant-1", input());
    const actor: AuthenticatedRequestContext = { ...context("client", "client.access"), client_class: "named_api_client",
      request: new Request("https://research.example/api/v1/research/projects", { headers: { "X-Eliotr-Client-Grant": granted.grant_id } }),
      access: { principal_ref: "client.access", credential_generation: credential, expires_at: new Date(clock + 3_600_000).toISOString(),
        issuer, authentication_method: "service_token" } };
    const lease = await authorizeProjectClientGrant(db, actor, { operation: "catalog", project_id: id }, () => clock);
    expect(lease.grant).toEqual(granted);
    await lease.requireCurrent();
    const before = await snapshot();
    const { access: _access, ...locatorOnly } = actor;
    await expect(authorizeProjectClientGrant(db, locatorOnly, { operation: "catalog", project_id: id }, () => clock))
      .rejects.toMatchObject({ code: "CLIENT_GRANT_IDENTITY_INVALID", status: 403 });
    await expect(authorizeProjectClientGrant(db, { ...actor, principal_ref: "foreign.access",
      access: { ...actor.access, principal_ref: "foreign.access", credential_generation: credential,
        expires_at: new Date(clock + 3_600_000).toISOString(), issuer, authentication_method: "service_token" } },
    { operation: "catalog", project_id: id }, () => clock)).rejects.toMatchObject({ code: "CLIENT_GRANT_DENIED", status: 403 });
    await expect(authorizeProjectClientGrant(db, actor, { operation: "run", project_id: id }, () => clock))
      .rejects.toMatchObject({ code: "CLIENT_GRANT_DENIED", status: 403 });
    await expect(authorizeProjectClientGrant(db, actor, { operation: "catalog", project_id: id }, () => clock + 3_600_000))
      .rejects.toMatchObject({ code: "CLIENT_GRANT_IDENTITY_INVALID", status: 403 });
    expect(await snapshot()).toEqual(before);
    await service().revoke(context("late-revoke"), id, "grant-1", { expected_revision: 1 });
    const revoked = await snapshot();
    await expect(lease.requireCurrent()).rejects.toMatchObject({ code: "CLIENT_GRANT_AUTHORITY_CHANGED", status: 409 });
    await expect(authorizeProjectClientGrant(db, actor, { operation: "catalog", project_id: id }, () => clock))
      .rejects.toMatchObject({ code: "CLIENT_GRANT_DENIED", status: 403 });
    expect(await snapshot()).toEqual(revoked);
  });

  it("keeps Project A grant listing across a causal Project B title update", async () => {
    const projectA = await project("project-a", "Project A");
    const projectB = await project("project-b", "Project B");
    const granted = await service().put(context("grant-a"), projectA, "grant-a", input());
    let changed = false;
    const observed = observeDatabase(async (sql, phase) => {
      if (phase === "before" && sql.includes("FROM project_client_grant_current") && !changed) {
        changed = true;
        await updateProject(projectB, "rename-b", 1, "Project B renamed");
      }
    });
    await expect(service(observed).list(context("list-a"), projectA)).resolves.toMatchObject({ grants: [granted] });
    expect(changed).toBe(true);
  });

  it("reconciles a Project A grant write after an unrelated Project B epoch CAS no-op", async () => {
    const projectA = await project("project-a", "Project A");
    const projectB = await project("project-b", "Project B");
    let inserts = 0;
    const observed = observeDatabase(async (sql, phase) => {
      if (phase === "before" && sql.startsWith("INSERT INTO project_client_grant (")) {
        inserts += 1;
        if (inserts === 1) await updateProject(projectB, "rename-b", 1, "Project B renamed");
      }
    });
    const granted = await service(observed).put(context("grant-a"), projectA, "grant-a", input());
    expect(granted).toMatchObject({ project_id: projectA, revision: 1, state: "ACTIVE" });
    expect(inserts).toBe(2);
    await receipt(granted, "grant-a", "PUT", input());
  });

  it("keeps a Project A lease current through Project B title, source, membership, tag and scope churn", async () => {
    const projectA = await project("project-a", "Project A");
    const projectB = await project("project-b", "Project B");
    const granted = await service().put(context("grant-a"), projectA, "grant-a", input());
    const lease = await authorizeProjectClientGrant(db, serviceContext("client-a", granted.grant_id),
      { operation: "catalog", project_id: projectA }, () => clock);

    await updateProject(projectB, "rename-b", 1, "Project B renamed");
    await seedReadableSource("b-source");
    await updateProject(projectB, "add-b-member", 2, "Project B renamed", ["b-source"]);
    await db.prepare("INSERT INTO source_tag (source_id,tag,valid_from,valid_to) VALUES (?1,'unrelated-b-tag',?2,NULL)")
      .bind("b-source", new Date(clock).toISOString()).run();
    const bScope = createD1ScopeService(db, createOwnerScopeAuthority(db, context("scope-b"), () => clock),
      { now: () => clock });
    await bScope.freeze({ kind: "PROJECT", project_id: projectB }, credential);

    await expect(lease.requireCurrent()).resolves.toBeUndefined();
    await service().revoke(context("revoke-a"), projectA, "grant-a", { expected_revision: 1 });
    await expect(lease.requireCurrent()).rejects.toMatchObject({ code: "CLIENT_GRANT_AUTHORITY_CHANGED", status: 409 });
  });

  it("rejects Project A membership changes and service expiry", async () => {
    await seedReadableSource("a-member");
    const projectA = await project("project-a", "Project A");
    const granted = await service().put(context("grant-a"), projectA, "grant-a", input());
    const lease = await authorizeProjectClientGrant(db, serviceContext("client-a", granted.grant_id),
      { operation: "catalog", project_id: projectA }, () => clock);
    await updateProject(projectA, "add-a-member", 1, "Project A", ["a-member"]);
    await expect(lease.requireCurrent()).rejects.toMatchObject({ code: "CLIENT_GRANT_AUTHORITY_CHANGED", status: 409 });

    const expiryProject = await project("expiry-project", "Expiry project");
    const expiryGrant = await service().put(context("expiry-grant"), expiryProject, "expiry-grant", input());
    const expiryLease = await authorizeProjectClientGrant(db, serviceContext("expiry-client", expiryGrant.grant_id),
      { operation: "catalog", project_id: expiryProject }, () => clock);
    clock = expiryLease.expires_at_ms;
    await expect(expiryLease.requireCurrent()).rejects.toMatchObject({ code: "CLIENT_GRANT_DENIED", status: 403 });
  });

  it("revalidates the bounded Project A scope before retrying after Project B churn", async () => {
    await seedReadableSource("a-scope-source");
    await seedReadableSource("b-scope-source");
    const projectA = await project("project-a", "Project A", ["a-scope-source"]);
    const projectB = await project("project-b", "Project B", ["b-scope-source"]);
    const granted = await service().put(context("grant-a"), projectA, "grant-a",
      input(0, "client.access", ["query"]));
    let bChanged = false;
    let scopeWrites = 0;
    let sourceReads = 0;
    const observed = observeDatabase(async (sql, phase) => {
      if (phase === "before" && sql.includes("FROM source s JOIN source_revision r")) sourceReads += 1;
      if (phase === "before" && sql.startsWith("INSERT INTO scope_access_grant (")) {
        scopeWrites += 1;
        if (!bChanged) {
          bChanged = true;
          await db.prepare("INSERT INTO source_tag (source_id,tag,valid_from,valid_to) VALUES (?1,'unrelated-b-tag',?2,NULL)")
            .bind("b-scope-source", new Date(clock).toISOString()).run();
          const bScopes = createD1ScopeService(db, createOwnerScopeAuthority(db, context("scope-b"), () => clock),
            { now: () => clock });
          await bScopes.freeze({ kind: "PROJECT", project_id: projectB }, credential);
        }
      }
    });
    const delegated = await createProjectClientScopeAuthority(observed, serviceContext("client-a", granted.grant_id),
      { kind: "PROJECT", project_id: projectA }, () => clock);
    const scopes = createD1ScopeService(observed, delegated.authority, { now: () => clock });
    const snapshot = await scopes.freeze({ kind: "PROJECT", project_id: projectA }, credential);
    sourceReads = 0;
    await delegated.authority.grant(snapshot);
    await delegated.requireScopeCurrent(snapshot);
    expect(bChanged).toBe(true);
    expect(scopeWrites).toBe(2);
    expect(sourceReads).toBeLessThan(32);

    await db.prepare("UPDATE scope_read_policy SET state='REVOKED' WHERE source_namespace_id=?1 " +
      "AND principal_ref=?2 AND client_class='owner_pwa'").bind("ns-a-scope-source", principal).run();
    await expect(delegated.requireScopeCurrent(snapshot)).rejects.toBeDefined();
  });

  it("keeps committed grant receipts append-only under actual D1 triggers", async () => {
    const id = await project();
    const granted = await service().put(context("grant-create"), id, "grant-1", input());
    const before = await snapshot();
    await expect(db.prepare("UPDATE project_client_grant SET state='REVOKED' WHERE grant_id=?1").bind(granted.grant_id).run())
      .rejects.toThrow(/CLIENT_GRANT_IMMUTABLE/u);
    await expect(db.prepare("DELETE FROM project_client_grant WHERE grant_id=?1").bind(granted.grant_id).run())
      .rejects.toThrow(/CLIENT_GRANT_IMMUTABLE/u);
    expect(await snapshot()).toEqual(before);
  });
});
