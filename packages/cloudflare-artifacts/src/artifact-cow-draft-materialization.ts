import { OperationIntentSchema, type OperationIntent } from "@eliotr/contracts";
import { canonicalDigest, canonicalJson } from "@eliotr/platform-cloudflare";
import { type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { createArtifactSectionReviseWorkflowStore, type ArtifactSectionReviseAttempt } from "@eliotr/cloudflare-workflows";
import { ArtifactDraftError, createArtifactDraftStore } from "./artifact-draft.js";
import type { ArtifactCowPorts } from "./artifact-cow.js";
import { readReauthorizedArtifactDraftCowSnapshot } from "./artifact-draft-reader.js";
import type { ArtifactDraftAdmissionPort, PrepareArtifactDraftInput } from "./artifact-draft-types.js";

function deny(message: string): never {
  throw new ArtifactDraftError("ARTIFACT_DRAFT_EFFECT_UNCERTAIN", message);
}

/** One child manifest effect of an existing COW attempt, through the ordinary
 * draft writer/admission bridge. This neither grants REPORT nor invokes a model. */
export async function createArtifactCowDraftMaterialization(input: {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly attempt: ArtifactSectionReviseAttempt;
  readonly navigation: NavigationReadAuthority;
}) {
  const { database, attempt, navigation } = input;
  const workflow = createArtifactSectionReviseWorkflowStore(database);
  const childRef = { id: attempt.request.artifact_ref.id, revision: attempt.request.artifact_ref.revision + 1 };
  const identity = await canonicalDigest({ operation_id: attempt.request.operation_id,
    attempt_ref: attempt.attempt_ref, request_sha256: attempt.request_sha256, artifact_ref: childRef });
  const row = await database.prepare("SELECT created_at FROM artifact_section_revise_attempt WHERE operation_id=?1 AND attempt_ref=?2 AND request_sha256=?3")
    .bind(attempt.request.operation_id, attempt.attempt_ref, attempt.request_sha256).first<{ created_at: string }>();
  if (row === null) deny("exact COW attempt is unavailable");
  const intent: OperationIntent = OperationIntentSchema.parse({
    intent_ref: { id: `artifact-cow-child-${identity}`, revision: 1 }, operation_kind: "REPORT",
    principal_ref: attempt.authority.principal_ref, idempotency_key: `artifact-cow-child-${identity}`,
    payload_ref: `artifact-cow-materialization-${identity}`,
    policy_decision_ref: attempt.request.report_admission_witness.decision_sha256, created_at: row.created_at,
  });
  const material = attempt.request.report_admission_witness.material;

  const requireCurrent = async () => {
    const current = await workflow.read(attempt.request.operation_id);
    if (current === null || current.request_json !== attempt.request_json || current.attempt_ref !== attempt.attempt_ref ||
        current.request_sha256 !== attempt.request_sha256 || canonicalJson(current.authority) !== canonicalJson(attempt.authority) ||
        !["STARTED", "OUTPUT_RECORDED", "COMMITTED"].includes(current.state)) deny("COW attempt no longer permits child materialization/readback");
    if (navigation.access.client_class !== "owner_pwa" || navigation.access.principal_ref !== attempt.authority.principal_ref ||
        navigation.access.credential_generation !== attempt.authority.credential_generation ||
        navigation.scope.snapshot_id !== attempt.request.scope_snapshot_ref.id ||
        navigation.scope.revision !== attempt.request.scope_snapshot_ref.revision || navigation.scope.digest !== material.scope_snapshot_digest) {
      deny("current execution authority differs from the admitted COW scope");
    }
    const grant = await navigation.current();
    if (canonicalJson(grant) !== canonicalJson(material.authorization)) deny("COW owner grant changed");
    const sources = await navigation.sources(navigation.scope.member_source_revision_refs, grant);
    const bindings = sources.map((source) => ({ source_revision_ref: source.source_revision_ref,
      source_owner_generation: source.source_owner_generation, content_sha256: source.content_sha256,
      object_residency_key_digest: source.object_residency_key_digest, admission_receipt_ref: source.admission_receipt_ref,
      allowed_use: [...source.allowed_use], disclosure_ceiling: source.disclosure_ceiling,
      admission_expires_at: source.admission_expires_at ?? null })).sort((a, b) => a.source_revision_ref.localeCompare(b.source_revision_ref));
    if (canonicalJson(bindings) !== canonicalJson(material.source_bindings) ||
        canonicalJson(await navigation.current()) !== canonicalJson(grant)) deny("COW source authority changed");
    const fence = await database.prepare(
      "SELECT 1 AS current FROM artifact_section_revise_run r JOIN artifact_section_revise_attempt a ON a.operation_id=r.operation_id AND a.attempt_ref=r.current_attempt_ref " +
      "JOIN artifact_draft_head h ON h.artifact_id=r.artifact_id " +
      "WHERE r.operation_id=?1 AND a.attempt_ref=?2 AND a.request_sha256=?3 AND r.state IN ('ACTIVE','COMPLETED') " +
      "AND r.purge_revision=COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger),0) " +
      "AND EXISTS (SELECT 1 FROM investigation_current_policy p WHERE p.policy_generation=r.policy_generation AND p.policy_authority_ref=r.policy_authority_ref AND p.state='ACTIVE') " +
      "AND EXISTS (SELECT 1 FROM research_deployment_compatible d WHERE d.origin_deployment_generation=r.deployment_generation) " +
      "AND ((h.head_revision=r.parent_revision AND a.state IN ('STARTED','OUTPUT_RECORDED')) OR " +
      "(h.head_revision>=r.parent_revision+1 AND a.state IN ('OUTPUT_RECORDED','COMMITTED') " +
      "AND EXISTS (SELECT 1 FROM artifact_draft_reservation child WHERE child.cow_operation_id=r.operation_id AND child.cow_attempt_ref=a.attempt_ref " +
      "AND child.cow_request_sha256=a.request_sha256 AND child.state='FINALIZED' AND child.intent_id=?4)))",
    ).bind(attempt.request.operation_id, attempt.attempt_ref, attempt.request_sha256, intent.intent_ref.id).first<{ current: number }>();
    if (fence?.current !== 1) deny("COW parent, policy, deployment or purge authority changed");
    return current;
  };

  const createIntent: ArtifactCowPorts["createIntent"] = async (request) => {
    await requireCurrent();
    if (canonicalJson(request.artifactRef) !== canonicalJson(childRef) || request.expectedHeadRevision !== attempt.request.artifact_ref.revision ||
        request.sectionId !== attempt.request.section_id) deny("child intent differs from the admitted section/revision");
    return { intent, created_at: row.created_at };
  };

  const prepare = async (draft: PrepareArtifactDraftInput) => {
    const current = await requireCurrent();
    if (!["OUTPUT_RECORDED", "COMMITTED"].includes(current.state) || canonicalJson(draft.intent) !== canonicalJson(intent) ||
        canonicalJson(draft.revision.artifact_ref) !== canonicalJson(childRef) || draft.expected_draft_head_revision !== attempt.request.artifact_ref.revision ||
        draft.revision.created_at !== row.created_at || draft.revision.spec_digest !== attempt.request.spec_digest ||
        canonicalJson(draft.revision.evidence_freeze_ref) !== canonicalJson(attempt.request.evidence_freeze_ref)) {
      deny("child draft is not the exact recorded COW materialization");
    }
    const parent = await database.prepare("SELECT spec_ref_id,spec_ref_revision,scope_snapshot_id,scope_snapshot_revision FROM artifact_draft_binding WHERE artifact_id=?1 AND revision=?2")
      .bind(attempt.request.artifact_ref.id, attempt.request.artifact_ref.revision)
      .first<{ spec_ref_id: string; spec_ref_revision: number; scope_snapshot_id: string; scope_snapshot_revision: number }>();
    if (parent === null || draft.spec.spec_ref.id !== parent.spec_ref_id || draft.spec.spec_ref.revision !== parent.spec_ref_revision ||
        draft.spec.scope_snapshot_ref.id !== parent.scope_snapshot_id || draft.spec.scope_snapshot_ref.revision !== parent.scope_snapshot_revision) {
      deny("child materialization changed immutable historical spec/scope");
    }
    const manifestSha = await canonicalDigest({ spec: draft.spec, revision: draft.revision });
    const readback = async () => {
      await requireCurrent();
      const saved = await database.prepare(
        "SELECT 1 AS exact FROM artifact_draft_reservation r JOIN artifact_draft_binding b ON (b.intent_id,b.intent_revision)=(r.intent_id,r.intent_revision) " +
        "JOIN outbox o ON (o.intent_id,o.intent_revision)=(r.intent_id,r.intent_revision) " +
        "WHERE r.intent_id=?1 AND r.intent_revision=1 AND r.cow_operation_id=?2 AND r.cow_attempt_ref=?3 AND r.cow_request_sha256=?4 " +
        "AND r.state='FINALIZED' AND b.artifact_id=?5 AND b.revision=?6 AND b.manifest_sha256=?7 AND o.payload_sha256=b.manifest_sha256",
      ).bind(intent.intent_ref.id, attempt.request.operation_id, attempt.attempt_ref, attempt.request_sha256,
        childRef.id, childRef.revision, manifestSha).first<{ exact: number }>();
      if (saved?.exact !== 1) deny("COW child authority/manifest readback is incomplete");
    };
    const admission: ArtifactDraftAdmissionPort = {
      async prepare(effect) {
        await requireCurrent();
        if (canonicalJson(effect.intent) !== canonicalJson(intent) || effect.payload_sha256 !== manifestSha) deny("child effect changed admitted manifest bytes");
        return {
          statements: [database.prepare("UPDATE artifact_draft_reservation SET cow_operation_id=?1,cow_attempt_ref=?2,cow_request_sha256=?3 WHERE intent_id=?4 AND intent_revision=1 AND state='RESERVED' AND cow_operation_id IS NULL")
            .bind(attempt.request.operation_id, attempt.attempt_ref, attempt.request_sha256, intent.intent_ref.id)],
          assertBatchResults(results, offset) {
            if (results[offset]?.success !== true || results[offset]?.meta?.changes !== 1) deny("COW child authority was not atomically recorded");
          },
          readback,
        };
      },
    };
    return createArtifactDraftStore(database, input.work_bucket, admission).prepare(draft);
  };
  const readFinalizedChild = async () => {
    const current = await requireCurrent();
    if (current.state !== "OUTPUT_RECORDED" && current.state !== "COMMITTED") return null;
    const reserved = await database.prepare(
      "SELECT state,artifact_id,artifact_revision,cow_operation_id,cow_attempt_ref,cow_request_sha256 FROM artifact_draft_reservation WHERE intent_id=?1 AND intent_revision=1 LIMIT 1",
    ).bind(intent.intent_ref.id).first<{ state: string; artifact_id: string; artifact_revision: number;
      cow_operation_id: string; cow_attempt_ref: string; cow_request_sha256: string }>();
    if (reserved === null || reserved.state !== "FINALIZED") return null;
    if (reserved.artifact_id !== childRef.id || reserved.artifact_revision !== childRef.revision ||
        reserved.cow_operation_id !== attempt.request.operation_id || reserved.cow_attempt_ref !== attempt.attempt_ref ||
        reserved.cow_request_sha256 !== attempt.request_sha256) deny("finalized child differs from its exact COW attempt");
    const binding = await database.prepare(
      "SELECT b.manifest_sha256,b.spec_ref_id,b.spec_ref_revision,b.scope_snapshot_id,b.scope_snapshot_revision " +
      "FROM artifact_draft_binding b JOIN outbox o ON (o.intent_id,o.intent_revision)=(b.intent_id,b.intent_revision) " +
      "WHERE b.intent_id=?1 AND b.intent_revision=1 AND b.artifact_id=?2 AND b.revision=?3 AND o.payload_sha256=b.manifest_sha256",
    ).bind(intent.intent_ref.id, childRef.id, childRef.revision).first<{ manifest_sha256: string;
      spec_ref_id: string; spec_ref_revision: number; scope_snapshot_id: string; scope_snapshot_revision: number }>();
    if (binding === null) deny("finalized child has no exact manifest/outbox authority");
    const grant = await navigation.current();
    const snapshot = await readReauthorizedArtifactDraftCowSnapshot({ database, work_bucket: input.work_bucket,
      artifact_ref: childRef, access: navigation.access, reauthorization: { navigation, authorization: grant } });
    const parent = await database.prepare(
      "SELECT spec_ref_id,spec_ref_revision,scope_snapshot_id,scope_snapshot_revision FROM artifact_draft_binding WHERE artifact_id=?1 AND revision=?2",
    ).bind(attempt.request.artifact_ref.id, attempt.request.artifact_ref.revision).first<Record<string, unknown>>();
    if (snapshot === null || parent === null || snapshot.revision.spec_digest !== attempt.request.spec_digest ||
        canonicalJson(snapshot.revision.evidence_freeze_ref) !== canonicalJson(attempt.request.evidence_freeze_ref) ||
        binding.spec_ref_id !== parent.spec_ref_id || binding.spec_ref_revision !== parent.spec_ref_revision ||
        binding.scope_snapshot_id !== parent.scope_snapshot_id || binding.scope_snapshot_revision !== parent.scope_snapshot_revision ||
        await canonicalDigest({ spec: snapshot.spec, revision: snapshot.revision }) !== binding.manifest_sha256) {
      deny("finalized child changed immutable parent provenance or manifest bytes");
    }
    await requireCurrent();
    return { artifact_ref: childRef, manifest_sha256: binding.manifest_sha256 };
  };
  return Object.freeze({ createIntent, prepare, requireCurrent, readFinalizedChild });
}
