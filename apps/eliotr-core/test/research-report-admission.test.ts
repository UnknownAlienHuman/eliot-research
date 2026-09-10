import { beforeAll, describe, expect, it } from "vitest";
import type { ResearchArtifactReportPolicy } from "@eliotr/cloudflare-research";
import {
  createEvidenceFreezeMaterializeContextReader,
  createResearchArtifactMetadataProducer,
} from "@eliotr/cloudflare-research";
import { prepareResearchReportAdmission, type ResearchReportAdmissionInput } from "../../../packages/cloudflare-research/src/research-report-admission.js";
import { WorkflowCheckpointStore } from "@eliotr/cloudflare-workflows";
import { createResearchMaterializeStageHandler as createNativeMaterializeHandler } from "../../../packages/cloudflare-research/src/research-materialize-stage-handler.js";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env.js";
import { committedFreezeSynthesisFixture } from "./research-synthesis-fixture.js";
import { principal } from "./research-evidence-freeze-fixture.js";

const runtime = env as unknown as Env & { readonly CORE_MIGRATIONS: D1Migration[]; readonly SEARCH_MIGRATIONS: D1Migration[] };

function reportPolicy(scopeId: string, principalRef: string): ResearchArtifactReportPolicy {
  const sectionResidency = {
    scope_domain_id: scopeId, access_domain_id: principalRef, confidentiality_domain_id: "report-confidentiality",
    encryption_key_domain_id: "report-key", retention_domain_id: "report-retention", erasure_domain_id: "report-erasure",
  };
  return {
    kind: "technical_audit", title: "Controlled private research draft", audience: "owner", language: "en",
    section_contract: { section_id: "summary", title: "Summary", purpose: "Private draft summary", required_claim_kinds: ["claim"], required_evidence_classes: ["source"], maximum_utf8_bytes: 4096 },
    statement_labels: { claim: "UNRESOLVED" }, citation_policy_ref: "report-citations-v1", verification_policy_ref: "report-verification-v1",
    length_policy_ref: "report-length-v1", export_formats: ["markdown"], include_counterevidence: true, include_methodology: true,
    budget_ref: "report-fixture-budget", section_residency: sectionResidency, manifest_residency: sectionResidency,
  };
}

async function advanceToMaterialize(synthesis: Awaited<ReturnType<typeof committedFreezeSynthesisFixture>>) {
  const stageTwelve = await synthesis.freeze.executor.execute(synthesis.stage_twelve, principal, synthesis.handler.handler);
  let previous = stageTwelve;
  for (const stage of ["VERIFY", "AUDIT_CLAIMS", "RESOLVE_CITATIONS", "CALCULATE_COVERAGE"] as const) {
    previous = await synthesis.freeze.executor.execute({ ...synthesis.stage_twelve, stage,
      investigation_ref: previous.investigation_ref, input_manifest: previous.output_manifest }, principal,
      async ({ request }) => new TextEncoder().encode(JSON.stringify({ stage: request.stage })));
  }
  return { stageTwelve, request: { ...synthesis.stage_twelve, stage: "MATERIALIZE" as const,
    investigation_ref: previous.investigation_ref, input_manifest: previous.output_manifest } };
}

describe("server-owned REPORT admission and artifact commit", () => {
  beforeAll(async () => {
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
  });

  it("admits through the native materializer, replays immutably, and fails closed", async () => {
    const synthesis = await committedFreezeSynthesisFixture();
    const { stageTwelve, request } = await advanceToMaterialize(synthesis);
    const run = await synthesis.freeze.db.prepare(
      "SELECT policy_generation,policy_authority_ref FROM research_workflow_run WHERE operation_id=?1 LIMIT 1",
    ).bind(synthesis.freeze.operation_id).first<{ readonly policy_generation: string; readonly policy_authority_ref: string }>();
    if (run === null) throw new Error("REPORT fixture run is missing");
    const expiresAt = synthesis.freeze.scope.expires_at;
    const policySource: ResearchReportAdmissionInput["policy_source"] = {
      provenance_ref: "server-report-policy-fixture-v1",
      read: async () => ({ schema: "eliotr.research.report-admission.v1", policy_ref: "report-policy-v1", policy_revision: 1,
        config_provenance_ref: "server-report-policy-fixture-v1", principal_ref: principal.principal_ref, client_class: "owner_pwa",
        policy_generation: run.policy_generation, policy_authority_ref: run.policy_authority_ref, allowed_use: ["research"],
        disclosure_ceiling: "owner-only", requested_output_class: "private-draft", purpose: "research-report-materialization", expires_at: expiresAt }),
    };
    const admissionInput = { database: synthesis.freeze.db, navigation: synthesis.freeze.navigation, request,
      principal, policy_source: policySource } satisfies ResearchReportAdmissionInput;
    const missingPolicy = { ...admissionInput, policy_source: { provenance_ref: policySource.provenance_ref, read: async () => null } } satisfies ResearchReportAdmissionInput;
    await expect(prepareResearchReportAdmission(missingPolicy)).rejects.toMatchObject({ code: "REPORT_ADMISSION_POLICY_MISSING" });
    expect((await synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM research_report_admission").first<{ readonly n: number }>())?.n).toBe(0);

    await synthesis.freeze.db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=?2 AND principal_ref=?3")
      .bind(synthesis.freeze.scope.snapshot_id, synthesis.freeze.scope.revision, principal.principal_ref).run();
    await expect(prepareResearchReportAdmission(admissionInput)).rejects.toMatchObject({ code: "REPORT_ADMISSION_AUTHORITY_STALE" });
    expect((await synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM research_report_admission").first<{ readonly n: number }>())?.n).toBe(0);
    await synthesis.freeze.db.prepare("UPDATE scope_access_grant SET state='ACTIVE' WHERE snapshot_id=?1 AND snapshot_revision=?2 AND principal_ref=?3")
      .bind(synthesis.freeze.scope.snapshot_id, synthesis.freeze.scope.revision, principal.principal_ref).run();

    const admission = await prepareResearchReportAdmission(admissionInput);
    const metadataPolicy = reportPolicy(synthesis.freeze.scope.snapshot_id, principal.principal_ref);
    const metadata = createResearchArtifactMetadataProducer({ intent: admission.intent, expected_draft_head_revision: null, policy: metadataPolicy });
    const context = createEvidenceFreezeMaterializeContextReader({ database: synthesis.freeze.db, work_bucket: synthesis.freeze.bucket,
      manifest_store: synthesis.freeze.freeze_store, read_stage_five: synthesis.freeze.readers.read_stage_five }, synthesis.freeze.navigation, synthesis.freeze.readers);
    const statusStore = new WorkflowCheckpointStore(synthesis.freeze.db);
    const handler = createNativeMaterializeHandler({ database: synthesis.freeze.db, work_bucket: synthesis.freeze.bucket,
      navigation: synthesis.freeze.navigation, evidence_resolver: synthesis.freeze.resolver, context,
      recheck_authority: async () => {
        const status = await statusStore.readRunStatus(synthesis.freeze.operation_id, principal);
        if (status === null) throw new Error("REPORT fixture status is missing");
        return { investigation_id: status.investigation_id, scope_snapshot_id: status.scope_snapshot_id, scope_snapshot_revision: status.scope_snapshot_revision };
      }, metadata: async (input) => ({ ...await metadata(input), admission: admission.admission }) });
    const first = await synthesis.freeze.executor.execute(request, principal, handler);
    expect(first.stage).toBe("MATERIALIZE");
    const admissionRow = await synthesis.freeze.db.prepare(
      "SELECT decision_id,intent_id,outbox_id,created_at FROM research_report_admission WHERE operation_id=?1 LIMIT 1",
    ).bind(synthesis.freeze.operation_id).first<{ readonly decision_id: string; readonly intent_id: string; readonly outbox_id: string; readonly created_at: string }>();
    expect(admissionRow).toMatchObject({ intent_id: admission.intent.intent_ref.id, outbox_id: expect.any(String), created_at: admission.intent.created_at });
    expect((await synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM research_report_admission").first<{ readonly n: number }>())?.n).toBe(1);
    expect((await synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM artifact_revision WHERE artifact_id LIKE 'eliotr.research.artifact-%'").first<{ readonly n: number }>())?.n).toBe(1);
    expect(stageTwelve.stage).toBe("SYNTHESIZE");

    const beforeReplay = await Promise.all([
      synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM research_report_admission").first<{ readonly n: number }>(),
      synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM artifact_draft_object").first<{ readonly n: number }>(),
      synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE intent_id=?1").bind(admission.intent.intent_ref.id).first<{ readonly n: number }>(),
    ]);
    const replay = await synthesis.freeze.executor.execute(request, principal, handler);
    expect(replay.receipt_ref).toBe(first.receipt_ref);
    const afterReplay = await Promise.all([
      synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM research_report_admission").first<{ readonly n: number }>(),
      synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM artifact_draft_object").first<{ readonly n: number }>(),
      synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE intent_id=?1").bind(admission.intent.intent_ref.id).first<{ readonly n: number }>(),
    ]);
    expect(afterReplay).toEqual(beforeReplay);
  }, 30_000);
});
