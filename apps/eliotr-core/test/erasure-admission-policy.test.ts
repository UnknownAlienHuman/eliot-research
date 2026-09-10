import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createErasureAdmissionPolicyStore,
  type ErasureAdmissionPolicyInput,
} from "../../../packages/cloudflare-erasure/src/admission-policy.js";
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
    const store = createErasureAdmissionPolicyStore({ database: runtime.CORE_DB, now: () => NOW });
    const installed = await store.install(policy());
    expect(installed.state).toBe("ACTIVE");
    expect(installed.policy_json).toContain("erc.privacy.erasure-admission.v1");
    expect(installed.policy_sha256).toMatch(/^[a-f0-9]{64}$/u);

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
});
