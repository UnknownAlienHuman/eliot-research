import { beforeAll, describe, expect, it } from "vitest";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import { createArtifactSectionReviseWorkflowStore, digest } from "@eliotr/cloudflare-workflows";
import { createArtifactCowDraftMaterialization, startArtifactSectionReviseWorkflow } from "@eliotr/cloudflare-research";
import { prepareOwnerArtifactReportAdmission } from "../src/artifact-report-admission.js";
import { admittedArtifactReportFixture } from "./artifact-report-admission-fixture.js";
import { countResidencyPuts, createArtifactDraftRuntime, draftInput, initializeArtifactDraftRuntime, runtime } from "./artifact-draft-fixture.js";

async function start(tag: string) {
  const data = await admittedArtifactReportFixture(tag);
  const admission = await prepareOwnerArtifactReportAdmission(data.configuredEnv,data.context,data.request);
  const store = createArtifactSectionReviseWorkflowStore(runtime.CORE_DB);
  const input = { request: data.request,report_admission: admission,store,
    principal: { principal_ref: data.context.principal_ref,credential_generation: data.context.credential_generation,
      deployment_generation: runtime.DEPLOYMENT_GENERATION },handler_generation: "artifact-cow-handler-test-v1" };
  const attempt = await startArtifactSectionReviseWorkflow(input);
  return { data,admission,store,input,attempt };
}

describe("dedicated artifact COW W2 over actual D1/R2", () => {
  beforeAll(initializeArtifactDraftRuntime);
  it("persists full REPORT witness and exact budget, then reads the next-revision commit immutably", async () => {
    const data = await start("cow-w2-positive");
    expect(data.attempt.state).toBe("STARTED");
    expect(data.attempt.request.report_admission_witness.input_sha256).toBe(data.admission.admission_witness.input_sha256);
    expect(data.attempt.budget.max_total_usd).toBe(0.02);
    expect(await startArtifactSectionReviseWorkflow(data.input)).toEqual(data.attempt);
    const originalBytes = async () => JSON.stringify(await runtime.CORE_DB.batch([
      runtime.CORE_DB.prepare("SELECT * FROM operation_intent WHERE intent_id=?1 AND revision=1").bind(data.admission.intent.intent_ref.id),
      runtime.CORE_DB.prepare("SELECT * FROM outbox WHERE intent_id=?1 AND intent_revision=1").bind(data.admission.intent.intent_ref.id),
      runtime.CORE_DB.prepare("SELECT request_json,request_sha256 FROM artifact_section_revise_run WHERE operation_id=?1").bind(data.attempt.request.operation_id),
      runtime.CORE_DB.prepare("SELECT request_json,request_sha256 FROM artifact_section_revise_attempt WHERE attempt_ref=?1").bind(data.attempt.attempt_ref),
    ]).then((results) => results.map((result) => result.results)));
    const original = await originalBytes();
    const body = new TextEncoder().encode("controlled local output, no provider call");
    const outputSha = await digest(body);
    const objectRef = "artifact-cow/w2-test/" + data.attempt.request.operation_id;
    await runtime.WORK_BUCKET.put(objectRef,body);
    const actual = await runtime.WORK_BUCKET.get(objectRef);
    if (actual === null) throw new Error("local R2 output unavailable");
    const exactSha = await digest(new Uint8Array(await actual.arrayBuffer()));
    const id = { operation_id: data.attempt.request.operation_id,attempt_ref: data.attempt.attempt_ref,
      request_sha256: data.attempt.request_sha256,created_at: new Date().toISOString() };
    const recorded = await data.store.recordOutput({ ...id,output: { output_object_ref: objectRef,output_sha256: outputSha,
      output_size_bytes: body.byteLength,readback_sha256: exactSha } });
    expect(recorded.state).toBe("OUTPUT_RECORDED");
    await expect(data.store.commitReadback({ ...id,draft: { artifact_ref: { id: data.data.request.artifact_ref.id,revision: 2 },
      manifest_sha256: "b".repeat(64) } })).rejects.toThrow();
    expect((await data.store.read(id.operation_id))?.state).toBe("OUTPUT_RECORDED");
    const childFixture = await draftInput("cow-w2-child", { artifact_id: data.data.request.artifact_ref.id,artifact_revision: 2,
      expected_head_revision: 1,scope_snapshot_id: data.data.fixture.scope.snapshot_id,
      principal_ref: data.data.context.principal_ref });
    const counted = countResidencyPuts(runtime.WORK_BUCKET);
    const createMaterialization = () => createArtifactCowDraftMaterialization({ database: runtime.CORE_DB,
      work_bucket: counted.bucket,attempt: recorded,navigation: data.admission.navigation });
    const materialization = await createMaterialization();
    const childIdentity = await materialization.createIntent({ artifactRef: childFixture.revision.artifact_ref,
      expectedHeadRevision: 1,sectionId: data.data.request.section_id });
    expect(childIdentity.intent.intent_ref).not.toEqual(data.admission.intent.intent_ref);
    expect(childIdentity.intent.policy_decision_ref).toBe(data.admission.intent.policy_decision_ref);
    const parent = data.data.fixture.input;
    const nextInput = { ...childFixture,intent: childIdentity.intent,spec: parent.spec,revision: { ...childFixture.revision,
      created_at: childIdentity.created_at,
      spec_ref: parent.revision.spec_ref,spec_digest: parent.revision.spec_digest,evidence_freeze_ref: parent.revision.evidence_freeze_ref } };
    const manifestDigest = await canonicalDigest({ spec: nextInput.spec,revision: nextInput.revision });
    const childInput = { ...nextInput,manifest_residency: { ...nextInput.manifest_residency,
      content_digest: { algorithm: "sha256" as const,digest: manifestDigest } } };
    await expect(createArtifactDraftRuntime().prepare({ ...childInput,intent: data.admission.intent }))
      .rejects.toMatchObject({ code: "ARTIFACT_DRAFT_IDEMPOTENCY_CONFLICT" });
    expect(counted.puts()).toBe(0);
    const next = await materialization.prepare(childInput);
    expect(next.disposition).toBe("CREATED");
    const firstPuts = counted.puts();
    expect(firstPuts).toBeGreaterThan(0);
    expect(await (await createMaterialization()).prepare(childInput)).toEqual({ ...next,disposition: "EXISTING" });
    expect(counted.puts()).toBe(firstPuts);
    const binding = await runtime.CORE_DB.prepare("SELECT cow_operation_id,cow_attempt_ref,cow_request_sha256 FROM artifact_draft_reservation WHERE intent_id=?1")
      .bind(childIdentity.intent.intent_ref.id).first();
    expect(binding).toEqual({ cow_operation_id: id.operation_id,cow_attempt_ref: id.attempt_ref,cow_request_sha256: id.request_sha256 });
    await expect(data.store.commitReadback({ ...id,draft: { artifact_ref: next.artifact_ref,manifest_sha256: "b".repeat(64) } })).rejects.toThrow();
    expect((await data.store.read(id.operation_id))?.state).toBe("OUTPUT_RECORDED");
    // Simulate a crash after child finalization, before W2 commit readback,
    // followed by an ordinary writer advancing the head. Recover the old effect.
    const laterFixture = await draftInput("cow-w2-later-head", { artifact_id: next.artifact_ref.id,artifact_revision: 3,
      expected_head_revision: 2,scope_snapshot_id: parent.spec.scope_snapshot_ref.id,
      principal_ref: data.data.context.principal_ref });
    const laterInput = { ...laterFixture,spec: parent.spec,revision: { ...laterFixture.revision,
      spec_ref: parent.revision.spec_ref,spec_digest: parent.revision.spec_digest,evidence_freeze_ref: parent.revision.evidence_freeze_ref } };
    const laterManifestSha = await canonicalDigest({ spec: laterInput.spec,revision: laterInput.revision });
    const later = await createArtifactDraftRuntime().prepare({ ...laterInput,manifest_residency: { ...laterInput.manifest_residency,
      content_digest: { algorithm: "sha256",digest: laterManifestSha } } });
    expect(later.draft_head_revision).toBe(3);
    const historical = await (await createMaterialization()).prepare(childInput);
    expect(historical).toEqual({ ...next,disposition: "EXISTING",draft_head_revision: 3 });
    expect(counted.puts()).toBe(firstPuts);
    expect(await originalBytes()).toBe(original);
    expect((await data.store.read(id.operation_id))?.state).toBe("OUTPUT_RECORDED");
    await expect(data.store.commitReadback({ ...id,draft: { artifact_ref: next.artifact_ref,manifest_sha256: "b".repeat(64) } })).rejects.toThrow();
    await expect(data.store.commitReadback({ ...id,draft: { artifact_ref: later.artifact_ref,
      manifest_sha256: later.manifest.receipt.expected_sha256 } })).rejects.toThrow();
    const draft = { artifact_ref: historical.artifact_ref,manifest_sha256: historical.manifest.receipt.expected_sha256 };
    const committed = await data.store.commitReadback({ ...id,draft });
    expect(committed.state).toBe("COMMITTED");
    expect(committed.draft?.artifact_ref).toEqual(next.artifact_ref);
    expect(await data.store.read(id.operation_id)).toEqual(committed);
    expect(await data.store.commitReadback({ ...id,draft })).toEqual(committed);
    expect(await (await createMaterialization()).prepare(childInput)).toEqual(historical);
    expect(counted.puts()).toBe(firstPuts);
    expect(await originalBytes()).toBe(original);
    expect(await runtime.CORE_DB.prepare("SELECT COUNT(*) AS count FROM artifact_draft_binding WHERE artifact_id=?1 AND revision=2")
      .bind(next.artifact_ref.id).first()).toEqual({ count: 1 });
    expect(await runtime.CORE_DB.prepare("SELECT COUNT(*) AS count FROM outbox WHERE intent_id=?1")
      .bind(childIdentity.intent.intent_ref.id).first()).toEqual({ count: 1 });
    await runtime.CORE_DB.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND principal_ref=?2")
      .bind(data.admission.navigation.scope.snapshot_id,data.data.context.principal_ref).run();
    await expect((await createMaterialization()).prepare(childInput)).rejects.toThrow();
    expect(counted.puts()).toBe(firstPuts);
    expect(await originalBytes()).toBe(original);
  },30_000);
  it("retains UNKNOWN durably and refuses output/commit for an uncertain effect", async () => {
    const data = await start("cow-w2-unknown");
    const id = { operation_id: data.attempt.request.operation_id,attempt_ref: data.attempt.attempt_ref,
      request_sha256: data.attempt.request_sha256,created_at: new Date().toISOString() };
    expect((await data.store.markEffectUnknown(id)).state).toBe("UNKNOWN");
    expect((await startArtifactSectionReviseWorkflow(data.input)).state).toBe("UNKNOWN");
    await expect(data.store.recordOutput({ ...id,output: { output_object_ref: "unknown-output",output_sha256: "b".repeat(64),
      output_size_bytes: 1,readback_sha256: "b".repeat(64) } })).rejects.toThrow();
    expect((await data.store.read(id.operation_id))?.state).toBe("UNKNOWN");
  },30_000);
});
