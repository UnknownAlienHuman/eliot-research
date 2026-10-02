import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ErasureRequest } from "@eliotr/contracts";
import { stableErasureId } from "../../../packages/cloudflare-erasure/src/canonical.js";
import { projectionWorkPrefix } from "../../../packages/cloudflare-erasure/src/empty-location-proof-r2.js";
import { createConfiguredErasureCoordinator } from "../src/erasure-runtime.js";
import type { Env } from "../src/env.js";

const runtime = env as unknown as Env & {
  readonly CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  readonly SEARCH_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

async function fixture(): Promise<{ readonly request: ErasureRequest; readonly revision: string }> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const revision = `empty-proof-revision-${suffix}`;
  const source = `empty-proof-source-${suffix}`;
  const namespace = `empty-proof-namespace-${suffix}`;
  const now = new Date().toISOString();
  await runtime.CORE_DB.batch([
    runtime.CORE_DB.prepare(
      "INSERT INTO source_namespace_ownership(source_namespace_id,ownership_record_revision,owner_system_id," +
      "owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,created_at) " +
      "VALUES (?1,1,?2,?3,?4,1,'ACTIVE',?5)",
    ).bind(namespace, `owner-${suffix}`, `incarnation-${suffix}`, `generation-${suffix}`, now),
    runtime.CORE_DB.prepare(
      "INSERT INTO source(source_id,source_namespace_id,source_owner_system_id,source_owner_generation," +
      "ownership_mode,kind,title,default_storage_policy,default_residency_profile_id,source_class," +
      "license_policy_ref,default_retention_policy_id,created_at) VALUES (?1,?2,?3,?4,'erc_owned'," +
      "'document','Empty proof fixture','storage-1','residency-1','document','license-1','retention-1',?5)",
    ).bind(source, namespace, `owner-${suffix}`, `generation-${suffix}`, now),
    runtime.CORE_DB.prepare(
      "INSERT INTO source_revision(source_revision_ref,source_id,source_owner_generation,content_sha256," +
      "object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation," +
      "quality_state,purge_state,currentness_state,source_view_ref,admitted_at) VALUES (?1,?2,?3,?4,?5,NULL,NULL,?6,?7,"
      + "'standard','LIVE','unknown',?8,?6)",
    ).bind(revision, source, `generation-${suffix}`, "a".repeat(64), "b".repeat(64), now, "parser-1", `view-${suffix}`),
  ]);
  return {
    revision,
    request: {
      protocol: "erc.privacy.erasure.v1",
      erasure_ref: { id: `erase-${suffix}`, revision: 1 },
      requested_by_principal_ref: `privacy-owner-${suffix}`,
      exact_subject_refs: [`source-revision:${revision}`],
      required_locations: ["Index", "Projection"],
      legal_basis_ref: `owner-request-${suffix}`,
      admitted_at: now,
      deadline: new Date(Date.parse(now) + 60 * 60_000).toISOString(),
    },
  };
}

async function insertActiveProjectionWriter(sourceRevisionRef: string, sourceId: string): Promise<void> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const now = new Date().toISOString();
  const namespace = `active-producer-namespace-${suffix}`;
  const ownerSystem = `active-producer-owner-${suffix}`;
  const ownerGeneration = `active-producer-generation-${suffix}`;
  const intentId = `active-producer-intent-${suffix}`;
  const jobId = `active-producer-job-${suffix}`;
  const projectionGeneration = `active-producer-projection-${suffix}`;
  const operationId = await stableErasureId("projection-execute", intentId, "1", projectionGeneration);
  const nowMs = Date.now();
  await runtime.CORE_DB.batch([
    runtime.CORE_DB.prepare(
      "INSERT INTO source_namespace_ownership(source_namespace_id,ownership_record_revision,owner_system_id," +
      "owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,created_at) " +
      "VALUES (?1,1,?2,?3,?4,1,'ACTIVE',?5)",
    ).bind(namespace, ownerSystem, `active-producer-incarnation-${suffix}`, ownerGeneration, now),
    runtime.CORE_DB.prepare(
      "INSERT INTO source(source_id,source_namespace_id,source_owner_system_id,source_owner_generation," +
      "ownership_mode,kind,title,default_storage_policy,default_residency_profile_id,source_class," +
      "license_policy_ref,default_retention_policy_id,created_at) VALUES (?1,?2,?3,?4,'erc_owned','document'," +
      "'Unrelated live producer','storage-1','residency-1','document','license-1','retention-1',?5)",
    ).bind(sourceId, namespace, ownerSystem, ownerGeneration, now),
    runtime.CORE_DB.prepare(
      "INSERT INTO source_revision(source_revision_ref,source_id,source_owner_generation,content_sha256," +
      "object_residency_key_digest,captured_at,quality_state,purge_state,currentness_state,source_view_ref,admitted_at) " +
      "VALUES (?1,?2,?3,?4,?5,?6,'standard','LIVE','unknown',?7,?6)",
    ).bind(sourceRevisionRef, sourceId, ownerGeneration, "c".repeat(64), "d".repeat(64), now, `active-producer-view-${suffix}`),
    runtime.CORE_DB.prepare(
      "INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref,idempotency_key,payload_ref," +
      "policy_decision_ref,created_at) VALUES (?1,1,'PROJECTION','projection-owner',?2,?3,'decision-1',?4)",
    ).bind(intentId, intentId, sourceRevisionRef, now),
    runtime.CORE_DB.prepare(
      "INSERT INTO job(job_id,intent_id,intent_revision,state,current_stage,created_at,updated_at) " +
      "VALUES (?1,?2,1,'RUNNING','PROJECTION_MATERIALIZING',?3,?3)",
    ).bind(jobId, intentId, now),
    runtime.CORE_DB.prepare(
      "INSERT INTO projection_generation(source_revision_ref,projection_generation,job_id,source_owner_generation," +
      "content_sha256,object_residency_key_digest,projector_profile,state,reason_codes_json,created_at,updated_at) " +
      "VALUES (?1,?2,?3,?4,?5,?6,'profile-1','PREPARING','[]',?7,?7)",
    ).bind(sourceRevisionRef, projectionGeneration, jobId, ownerGeneration, "c".repeat(64), "d".repeat(64), now),
    runtime.CORE_DB.prepare(
      "INSERT INTO operation_execution_lease(operation_id,operation_kind,lease_owner,lease_generation,lease_until," +
      "attempt,state,created_at,updated_at) VALUES (?1,'PROJECTION_EXECUTE','projection-worker',1,?2,1,'LEASED',?3,?3)",
    ).bind(operationId, nowMs + 60_000, nowMs),
  ]);
}

describe("authoritative empty-location proof over Worker D1 and R2", () => {
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
  });

  it("completes only after actual empty D1 Search and source-scoped R2 Work readbacks", async () => {
    const { request } = await fixture();
    const receipt = await createConfiguredErasureCoordinator(runtime).execute(request);
    expect(receipt.state).toBe("COMPLETE");
    expect(receipt.completed_locations).toEqual(["Index", "Projection"]);
    const targets = await runtime.CORE_DB.prepare(
      "SELECT location,target_kind,state FROM erasure_target WHERE erasure_id=?1 ORDER BY location",
    ).bind(request.erasure_ref.id).all<{ location: string; target_kind: string; state: string }>();
    expect(targets.success).toBe(true);
    expect(targets.results).toEqual([
      { location: "Index", target_kind: "LOCATION_EMPTY_PROOF", state: "ABSENT" },
      { location: "Projection", target_kind: "LOCATION_EMPTY_PROOF", state: "ABSENT" },
    ]);
  });

  it("refuses a Work object written after initial enumeration and before closure persistence", async () => {
    const { request, revision } = await fixture();
    let injected = false;
    const workBucket = new Proxy(runtime.WORK_BUCKET, {
      get(target, property, receiver) {
        if (property === "list") {
          return async (options: R2ListOptions) => {
            const result = await target.list(options);
            if (!injected) {
              injected = true;
              await target.put(`${await projectionWorkPrefix(revision)}items/late.md`, "late projection bytes");
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    const coordinator = createConfiguredErasureCoordinator({ ...runtime, WORK_BUCKET: workBucket });
    await expect(coordinator.execute(request)).rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
    expect(injected).toBe(true);
    const storedTargets = await runtime.CORE_DB.prepare(
      "SELECT COUNT(*) AS count FROM erasure_target WHERE erasure_id=?1",
    ).bind(request.erasure_ref.id).first<{ count: number }>();
    expect(storedTargets?.count).toBe(0);
    expect(await runtime.WORK_BUCKET.head(`${await projectionWorkPrefix(revision)}items/late.md`)).not.toBeNull();
  });

  it("blocks an empty proof while a quarantined source still has an admitted projection job", async () => {
    const { request, revision } = await fixture();
    const now = new Date().toISOString();
    const intent = `projection-intent-${crypto.randomUUID().replaceAll("-", "")}`;
    const outbox = `projection-outbox-${crypto.randomUUID().replaceAll("-", "")}`;
    const job = `projection-job-${crypto.randomUUID().replaceAll("-", "")}`;
    await runtime.CORE_DB.batch([
      runtime.CORE_DB.prepare(
        "INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref,idempotency_key,payload_ref," +
        "policy_decision_ref,created_at) VALUES (?1,1,'PROJECTION','projection-owner',?2,?3,'decision-1',?4)",
      ).bind(intent, intent, revision, now),
      runtime.CORE_DB.prepare(
        "INSERT INTO job(job_id,intent_id,intent_revision,state,current_stage,created_at,updated_at) " +
        "VALUES (?1,?2,1,'ACCEPTED','QUEUED',?3,?3)",
      ).bind(job, intent, now),
      runtime.CORE_DB.prepare(
        "INSERT INTO outbox(outbox_id,intent_id,intent_revision,topic,payload_ref,state,attempts,next_attempt_at,created_at,updated_at) " +
        "VALUES (?1,?2,1,'source.revision.admitted',?3,'PENDING',0,0,?4,?4)",
      ).bind(outbox, intent, revision, now),
    ]);
    await expect(createConfiguredErasureCoordinator(runtime).execute(request))
      .rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
    const storedTargets = await runtime.CORE_DB.prepare(
      "SELECT COUNT(*) AS count FROM erasure_target WHERE erasure_id=?1",
    ).bind(request.erasure_ref.id).first<{ count: number }>();
    expect(storedTargets?.count).toBe(0);
  });

  it("allows an unrelated live projection when durable source provenance binds it to another source", async () => {
    const { request } = await fixture();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    await insertActiveProjectionWriter(`other-revision-${suffix}`, `other-source-${suffix}`);
    const receipt = await createConfiguredErasureCoordinator(runtime).execute(request);
    expect(receipt.state).toBe("COMPLETE");
  });

  it("blocks a live projection lease with no durable source binding", async () => {
    const { request } = await fixture();
    const now = Date.now();
    await runtime.CORE_DB.prepare(
      "INSERT INTO operation_execution_lease(operation_id,operation_kind,lease_owner,lease_generation,lease_until," +
      "attempt,state,created_at,updated_at) VALUES ('projection-execute-unbound','PROJECTION_EXECUTE'," +
      "'projection-worker',1,?1,1,'LEASED',?2,?2)",
    ).bind(now + 60_000, now).run();
    await expect(createConfiguredErasureCoordinator(runtime).execute(request))
      .rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
    const storedTargets = await runtime.CORE_DB.prepare(
      "SELECT COUNT(*) AS count FROM erasure_target WHERE erasure_id=?1",
    ).bind(request.erasure_ref.id).first<{ count: number }>();
    expect(storedTargets?.count).toBe(0);
  });
});
