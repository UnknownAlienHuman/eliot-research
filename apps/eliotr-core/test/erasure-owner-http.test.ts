import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createErasureAdmissionPolicyStore,
  type ErasureAdmissionPolicyInput,
} from "@eliotr/cloudflare-erasure";
import type { Env } from "../src/env.js";
import { createApplication } from "../src/composition-root.js";
import { handleHttp } from "../src/http.js";

const runtime = env as unknown as Env & {
  readonly CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  readonly SEARCH_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const credential = "erasure-http-credential";

function ownerAccess(principal: string) {
  return {
    accessVerifier: {
      async verify() {
        return {
          principal_ref: principal,
          credential_generation: credential,
          authentication_method: "cloudflare_access" as const,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        };
      },
    },
    applicationFactory: () => createApplication({ env: runtime, executionContext: {} as ExecutionContext }),
  };
}

async function seedOwnerSource(principal: string) {
  const createdAt = new Date(Date.now()).toISOString();
  await runtime.CORE_DB.batch([
    runtime.CORE_DB.prepare(
      "INSERT INTO source_namespace_ownership(source_namespace_id,ownership_record_revision,owner_system_id," +
      "owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,created_at) " +
      "VALUES ('erase-http-namespace',1,'erase-http-owner','erase-http-incarnation','erase-http-generation',1,'ACTIVE',?1)",
    ).bind(createdAt),
    runtime.CORE_DB.prepare(
      "INSERT INTO source(source_id,source_namespace_id,source_owner_system_id,source_owner_generation," +
      "ownership_mode,kind,title,default_storage_policy,default_residency_profile_id,source_class," +
      "license_policy_ref,default_retention_policy_id,created_at) VALUES " +
      "('erase-http-source','erase-http-namespace','erase-http-owner','erase-http-generation','erc_owned'," +
      "'document','Erasure fixture','storage-1','residency-1','document','license-1','retention-1',?1)",
    ).bind(createdAt),
    runtime.CORE_DB.prepare(
      "INSERT INTO source_revision(source_revision_ref,source_id,source_owner_generation,content_sha256," +
      "object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation," +
      "quality_state,purge_state,currentness_state,source_view_ref,admitted_at) VALUES " +
      "('erase-http-revision','erase-http-source','erase-http-generation',?1,?2,'erase-http/raw.bin'," +
      "'erase-http/normalized.md',?3,'parser-1','standard','LIVE','current_confirmed','source-view-1',?3)",
    ).bind("a".repeat(64), "b".repeat(64), createdAt),
  ]);
  const policy: ErasureAdmissionPolicyInput = {
    permission_ref: { id: "erase-http-permission", revision: 1 },
    source_namespace_id: "erase-http-namespace",
    owner_system_id: "erase-http-owner",
    source_owner_generation: "erase-http-generation",
    principal_ref: principal,
    credential_generation: credential,
    authorization_binding_ref: "erase-http-operator-receipt",
    legal_basis_ref: "erase-http-legal-basis",
    valid_from: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
  await createErasureAdmissionPolicyStore({ database: runtime.CORE_DB }).install(policy);
  await runtime.EVIDENCE_BUCKET.put("erase-http/raw.bin", new TextEncoder().encode("pinned source bytes"));
  await runtime.EVIDENCE_BUCKET.put("erase-http/normalized.md", new TextEncoder().encode("# Pinned source\n"));
}

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`https://research.example${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

async function rowCount(table: string): Promise<number> {
  return (await runtime.CORE_DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>())?.count ?? -1;
}

describe("owner erasure HTTP composition over real D1 and R2", () => {
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([Date.UTC(2026, 9, 1, 12), Date.UTC(2030, 0, 15, 12)])(
    "serves an honest erasure HTTP flow at clock %s", async (now) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const owner = "erase-http-owner-principal";
    await seedOwnerSource(owner);
    const ownerDeps = ownerAccess(owner);
    const prepare = await handleHttp(jsonRequest("/api/v1/library/erasure/prepare", "POST", {
      source_id: "erase-http-source",
      idempotency_key: "erase-http-request-1",
    }), runtime, {} as ExecutionContext, ownerDeps);
    expect(prepare.status).toBe(200);
    const preview = (await prepare.json() as { data: { request: { permission_ref: unknown; request: unknown } } }).data;
    expect(preview.request).toMatchObject({
      protocol: "eliotr.owner-erasure.v1",
      permission_ref: { id: "erase-http-permission", revision: 1 },
    });
    expect(await rowCount("erasure_execution")).toBe(0);
    expect(await rowCount("purge_ledger")).toBe(0);
    expect(await runtime.EVIDENCE_BUCKET.get("erase-http/raw.bin")).not.toBeNull();
    expect(await runtime.EVIDENCE_BUCKET.get("erase-http/normalized.md")).not.toBeNull();

    const foreign = await handleHttp(jsonRequest("/api/v1/library/erasure", "POST", preview.request), runtime,
      {} as ExecutionContext, ownerAccess("erase-http-foreign-principal"));
    expect(foreign.status).toBe(403);
    expect(await rowCount("erasure_execution")).toBe(0);
    expect(await runtime.EVIDENCE_BUCKET.get("erase-http/raw.bin")).not.toBeNull();

    const execute = await handleHttp(jsonRequest("/api/v1/library/erasure", "POST", preview.request), runtime,
      {} as ExecutionContext, ownerDeps);
    expect([409, 503]).toContain(execute.status);
    const execution = await runtime.CORE_DB.prepare(
      "SELECT state FROM erasure_execution LIMIT 1",
    ).first<{ state: string }>();
    expect(execution?.state).not.toBe("COMPLETE");
    expect(await rowCount("purge_ledger")).toBe(0);
    expect(await runtime.EVIDENCE_BUCKET.get("erase-http/raw.bin")).not.toBeNull();
    expect(await runtime.EVIDENCE_BUCKET.get("erase-http/normalized.md")).not.toBeNull();
  });
});
