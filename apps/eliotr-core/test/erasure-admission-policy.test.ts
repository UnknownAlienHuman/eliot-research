import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createErasureAdmissionPolicyStore,
  type ErasureAdmissionPolicyInput,
} from "../../../packages/cloudflare-erasure/src/admission-policy.js";
import { canonicalErasureJson } from "../../../packages/cloudflare-erasure/src/canonical.js";
import type { ErasureRequest } from "@eliotr/contracts";

const runtime = env as unknown as {
  CORE_DB: D1Database;
  CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const NOW = Date.parse("2026-09-10T12:00:00.000Z");

function policy(overrides: Partial<ErasureAdmissionPolicyInput> = {}): ErasureAdmissionPolicyInput {
  return {
    permission_ref: { id: "permission-1", revision: 1 },
    source_namespace_id: "namespace-1",
    owner_system_id: "owner-system-1",
    source_owner_generation: "owner-generation-1",
    principal_ref: "principal-1",
    credential_generation: "credential-1",
    authorization_binding_ref: "operator-receipt-1",
    legal_basis_ref: "legal-basis-1",
    valid_from: "2026-09-01T00:00:00.000Z",
    expires_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function request(overrides: Partial<ErasureRequest> = {}): ErasureRequest {
  return {
    protocol: "erc.privacy.erasure.v1",
    erasure_ref: { id: "erasure-1", revision: 1 },
    requested_by_principal_ref: "principal-1",
    exact_subject_refs: ["source-revision:revision-1"],
    required_locations: ["CanonicalPayload"],
    legal_basis_ref: "legal-basis-1",
    admitted_at: "2026-09-01T00:00:00.000Z",
    deadline: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

async function seedSource(): Promise<void> {
  await runtime.CORE_DB.batch([
    runtime.CORE_DB.prepare(
      "INSERT INTO source_namespace_ownership(source_namespace_id,ownership_record_revision,owner_system_id," +
      "owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,created_at) " +
      "VALUES ('namespace-1',1,'owner-system-1','owner-incarnation-1','owner-generation-1',1,'ACTIVE',?1)",
    ).bind(new Date(NOW).toISOString()),
    runtime.CORE_DB.prepare(
      "INSERT INTO source(source_id,source_namespace_id,source_owner_system_id,source_owner_generation," +
      "ownership_mode,kind,title,default_storage_policy,default_residency_profile_id,source_class," +
      "license_policy_ref,default_retention_policy_id,created_at) VALUES " +
      "('source-1','namespace-1','owner-system-1','owner-generation-1','erc_owned','document','Fixture'," +
      "'storage-1','residency-1','document','license-1','retention-1',?1)",
    ).bind(new Date(NOW).toISOString()),
    runtime.CORE_DB.prepare(
      "INSERT INTO source_revision(source_revision_ref,source_id,source_owner_generation,content_sha256," +
      "object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation," +
      "quality_state,purge_state,currentness_state,source_view_ref,admitted_at) VALUES " +
      "('revision-1','source-1','owner-generation-1',?1,?1,'raw/object-1','normalized/object-1',?2," +
      "'parser-1','standard','LIVE','current_confirmed','source-view-1',?2)",
    ).bind("a".repeat(64), new Date(NOW).toISOString()),
  ]);
}

describe("erasure admission policy against real D1", () => {
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    await seedSource();
  });

  it("installs, reads back, and expands a request to the complete location set", async () => {
    let now = NOW;
    const store = createErasureAdmissionPolicyStore({ database: runtime.CORE_DB, now: () => now });
    const installed = await store.install(policy());
    expect(installed.state).toBe("ACTIVE");
    expect(installed.policy_json).toContain("erc.privacy.erasure-admission.v1");
    expect(installed.policy_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const replay = await store.install(policy());
    expect(replay).toEqual(installed);
    const offsetPolicy = await store.install(policy({
      permission_ref: { id: "permission-offset", revision: 1 },
      authorization_binding_ref: "operator-receipt-offset",
      valid_from: "2026-09-10T07:00:00-05:00",
      expires_at: "2026-09-11T07:00:00-05:00",
    }));
    expect(offsetPolicy.valid_from).toBe("2026-09-10T12:00:00.000Z");
    expect(offsetPolicy.expires_at).toBe("2026-09-11T12:00:00.000Z");
    const offsetAdmission = await store.admit(
      { principal_ref: "principal-1", credential_generation: "credential-1" },
      offsetPolicy.permission_ref,
      request({
        erasure_ref: { id: "erasure-offset", revision: 1 },
        deadline: "2026-09-10T13:00:00.000Z",
      }),
    );
    expect(offsetAdmission.admitted_at).toBe(new Date(NOW).toISOString());

    const admitted = await store.admit(
      { principal_ref: "principal-1", credential_generation: "credential-1" },
      installed.permission_ref,
      request(),
    );
    expect(admitted.requested_by_principal_ref).toBe("principal-1");
    expect(admitted.admitted_at).toBe(new Date(NOW).toISOString());
    expect(admitted.required_locations).toEqual([
      "CanonicalPayload", "Projection", "Index", "Blob", "OperationalRecovery",
      "ProviderCopy", "BackupRestorePath", "RouteContinuation",
    ]);
    now = NOW + 60_000;
    const replayedAdmission = await store.admit(
      { principal_ref: "principal-1", credential_generation: "credential-1" },
      installed.permission_ref,
      request(),
    );
    expect(replayedAdmission).toEqual(admitted);
  });

  it("rejects actor/legal-basis drift, conflicting replay, and revoked permission", async () => {
    const store = createErasureAdmissionPolicyStore({ database: runtime.CORE_DB, now: () => NOW });
    const installed = await store.install(policy());
    await expect(store.install(policy({ legal_basis_ref: "different-basis" }))).rejects.toMatchObject({
      code: "ERASURE_PERMISSION_CONFLICT",
    });
    await expect(store.admit(
      { principal_ref: "foreign-principal", credential_generation: "credential-1" },
      installed.permission_ref,
      request(),
    )).rejects.toMatchObject({ code: "ERASURE_PERMISSION_DENIED" });
    const revoked = await store.revoke(installed.permission_ref);
    expect(revoked.state).toBe("REVOKED");
    await expect(store.admit(
      { principal_ref: "principal-1", credential_generation: "credential-1" },
      installed.permission_ref,
      request(),
    )).rejects.toMatchObject({ code: "ERASURE_PERMISSION_DENIED" });
  });

  it("rejects a subject after its namespace owner generation changes", async () => {
    const store = createErasureAdmissionPolicyStore({ database: runtime.CORE_DB, now: () => NOW });
    const installed = await store.install(policy());
    await runtime.CORE_DB.prepare(
      "UPDATE source_namespace_ownership SET status='FENCED' WHERE source_namespace_id='namespace-1' AND status='ACTIVE'",
    ).run();
    await runtime.CORE_DB.prepare(
      "INSERT INTO source_namespace_ownership(source_namespace_id,ownership_record_revision,owner_system_id," +
      "owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,created_at) " +
      "VALUES ('namespace-1',2,'owner-system-1','owner-incarnation-2','owner-generation-2',2,'ACTIVE',?1)",
    ).bind(new Date(NOW).toISOString()).run();
    await expect(store.admit(
      { principal_ref: "principal-1", credential_generation: "credential-1" },
      installed.permission_ref,
      request(),
    )).rejects.toMatchObject({ code: "ERASURE_PERMISSION_DENIED" });
  });

  it("does not treat a read grant as destructive permission and rejects expired permission", async () => {
    await runtime.CORE_DB.prepare(
      "INSERT INTO scope_read_policy(source_namespace_id,principal_ref,client_class,policy_ref,generation," +
      "allowed_use_json,disclosure_ceiling,state,expires_at,created_at) VALUES " +
      "('namespace-1','principal-1','owner_pwa','read-policy-1',1,'[\"research\"]','owner-only','ACTIVE',?1,?2)",
    ).bind("2026-10-01T00:00:00.000Z", new Date(NOW).toISOString()).run();
    const store = createErasureAdmissionPolicyStore({ database: runtime.CORE_DB, now: () => NOW });
    await expect(store.admit(
      { principal_ref: "principal-1", credential_generation: "credential-1" },
      { id: "read-policy-1", revision: 1 },
      request({ erasure_ref: { id: "erasure-read-only", revision: 1 } }),
    )).rejects.toMatchObject({ code: "ERASURE_PERMISSION_DENIED" });
    await store.install(policy({
      permission_ref: { id: "expired-permission", revision: 1 },
      expires_at: "2026-09-09T00:00:00.000Z",
    }));
    await expect(store.admit(
      { principal_ref: "principal-1", credential_generation: "credential-1" },
      { id: "expired-permission", revision: 1 },
      request({ erasure_ref: { id: "erasure-expired", revision: 1 } }),
    )).rejects.toMatchObject({ code: "ERASURE_PERMISSION_DENIED" });
  });

  it("rejects a stored permission whose canonical digest is corrupt", async () => {
    const store = createErasureAdmissionPolicyStore({ database: runtime.CORE_DB, now: () => NOW });
    const installed = await store.install(policy());
    const corruptRef = { id: "permission-corrupt", revision: 1 } as const;
    const corruptPolicy = policy({ permission_ref: corruptRef, authorization_binding_ref: "operator-receipt-corrupt" });
    const corruptJson = installed.policy_json.replace(
      '"permission-1"',
      '"permission-corrupt"',
    ).replace('"operator-receipt-1"', '"operator-receipt-corrupt"');
    expect(canonicalErasureJson(JSON.parse(corruptJson))).toBe(corruptJson);
    await runtime.CORE_DB.prepare(
      "INSERT INTO erasure_admission_policy(permission_ref,revision,source_namespace_id,owner_system_id," +
      "source_owner_generation,principal_ref,credential_generation,authorization_binding_ref,legal_basis_ref," +
      "valid_from,expires_at,state,policy_json,policy_sha256,created_at,revoked_at) VALUES " +
      "(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'ACTIVE',?12,?13,?14,NULL)",
    ).bind(corruptRef.id, corruptRef.revision, corruptPolicy.source_namespace_id, corruptPolicy.owner_system_id,
      corruptPolicy.source_owner_generation, corruptPolicy.principal_ref, corruptPolicy.credential_generation,
      corruptPolicy.authorization_binding_ref, corruptPolicy.legal_basis_ref, corruptPolicy.valid_from,
      corruptPolicy.expires_at, corruptJson, "0".repeat(64), new Date(NOW).toISOString()).run();
    await expect(store.read(corruptRef)).rejects.toMatchObject({ code: "ERASURE_IDENTITY_CONFLICT" });
  });
});
