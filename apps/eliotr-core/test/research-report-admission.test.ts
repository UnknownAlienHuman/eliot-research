import { beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalEvidenceJson, loadScopeAuthority } from "@eliotr/cloudflare-evidence";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import type { ResearchArtifactReportPolicy } from "@eliotr/cloudflare-research";
import {
  createArtifactDraftStore,
  createEvidenceFreezeMaterializeContextReader,
  readArtifactCowHistoricalFreeze,
  readArtifactDraftCowSnapshot,
  startArtifactSectionReviseWorkflow,
} from "@eliotr/cloudflare-research";
import { prepareResearchReportAdmission, type ResearchReportAdmissionInput } from "../../../packages/cloudflare-research/src/research-report-admission.js";
import { createArtifactSectionReviseWorkflowStore, digest, WorkflowCheckpointStore } from "@eliotr/cloudflare-workflows";
import { createResearchStageHandlerFactory, SERVER_OWNED_FREEZE_HANDLER_GENERATION } from "../src/research-stage-handlers.js";
import { prepareOwnerArtifactReportAdmission } from "../src/artifact-report-admission.js";
import { prepareArtifactReadReauthorization } from "../src/research-artifact-reauthorization-http.js";
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

async function reportAdmissionInput(
  synthesis: Awaited<ReturnType<typeof committedFreezeSynthesisFixture>>,
  request: Awaited<ReturnType<typeof advanceToMaterialize>>["request"],
): Promise<ResearchReportAdmissionInput> {
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
  return { database: synthesis.freeze.db, navigation: synthesis.freeze.navigation, request, principal, policy_source: policySource };
}

describe("server-owned REPORT admission and artifact commit", () => {
  beforeAll(async () => {
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
  });

  it("admits through the native materializer, replays immutably, and fails closed", async () => {
    const revokedSynthesis = await committedFreezeSynthesisFixture();
    const revoked = await advanceToMaterialize(revokedSynthesis);
    const revokedInput = await reportAdmissionInput(revokedSynthesis, revoked.request);
    await revokedSynthesis.freeze.db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=?2 AND principal_ref=?3")
      .bind(revokedSynthesis.freeze.scope.snapshot_id, revokedSynthesis.freeze.scope.revision, principal.principal_ref).run();
    await expect(prepareResearchReportAdmission(revokedInput)).rejects.toMatchObject({ code: "REPORT_ADMISSION_AUTHORITY_STALE" });
    expect((await revokedSynthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM research_report_admission").first<{ readonly n: number }>())?.n).toBe(0);

    const synthesis = await committedFreezeSynthesisFixture();
    const { stageTwelve, request } = await advanceToMaterialize(synthesis);
    const admissionInput = await reportAdmissionInput(synthesis, request);
    const policySource = admissionInput.policy_source;
    const missingPolicy = { ...admissionInput, policy_source: { provenance_ref: policySource.provenance_ref, read: async () => null } } satisfies ResearchReportAdmissionInput;
    await expect(prepareResearchReportAdmission(missingPolicy)).rejects.toMatchObject({ code: "REPORT_ADMISSION_POLICY_MISSING" });
    expect((await synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM research_report_admission").first<{ readonly n: number }>())?.n).toBe(0);

    const metadataPolicy = reportPolicy(synthesis.freeze.scope.snapshot_id, principal.principal_ref);
    const context = createEvidenceFreezeMaterializeContextReader({ database: synthesis.freeze.db, work_bucket: synthesis.freeze.bucket,
      manifest_store: synthesis.freeze.freeze_store, read_stage_five: synthesis.freeze.readers.read_stage_five }, synthesis.freeze.navigation, synthesis.freeze.readers);
    const statusStore = new WorkflowCheckpointStore(synthesis.freeze.db);
    const handler = createResearchStageHandlerFactory({ kind: "server-owned-exploratory",
      generation: SERVER_OWNED_FREEZE_HANDLER_GENERATION, navigation: synthesis.freeze.navigation, ledger: synthesis.freeze.ledger,
      report_materialize: { database: synthesis.freeze.db, work_bucket: synthesis.freeze.bucket,
      navigation: synthesis.freeze.navigation, evidence_resolver: synthesis.freeze.resolver, context,
      recheck_authority: async () => {
        const status = await statusStore.readRunStatus(synthesis.freeze.operation_id, principal);
        if (status === null) throw new Error("REPORT fixture status is missing");
        return { investigation_id: status.investigation_id, scope_snapshot_id: status.scope_snapshot_id, scope_snapshot_revision: status.scope_snapshot_revision };
      }, policy_source: policySource, report_policy: metadataPolicy } })("MATERIALIZE");
    let handlerError: unknown;
    const observedHandler = async (input: Parameters<typeof handler>[0]) => {
      try { return await handler(input); }
      catch (error) { handlerError = error; throw error; }
    };
    const first = await synthesis.freeze.executor.execute(request, principal, observedHandler).catch((error: unknown) => {
      throw handlerError ?? error;
    });
    expect(first.stage).toBe("MATERIALIZE");
    const admissionRow = await synthesis.freeze.db.prepare(
      "SELECT decision_id,intent_id,outbox_id,created_at FROM research_report_admission WHERE operation_id=?1 LIMIT 1",
    ).bind(synthesis.freeze.operation_id).first<{ readonly decision_id: string; readonly intent_id: string; readonly outbox_id: string; readonly created_at: string }>();
    if (admissionRow === null) throw new Error("REPORT admission row is missing");
    expect(admissionRow).toMatchObject({ decision_id: expect.stringMatching(/^report-decision-[a-f0-9]{64}$/u), intent_id: expect.stringMatching(/^report-intent-[a-f0-9]{64}$/u), outbox_id: expect.any(String), created_at: expect.any(String) });
    const storedIntent = await synthesis.freeze.db.prepare("SELECT operation_kind,idempotency_key,created_at FROM operation_intent WHERE intent_id=?1 LIMIT 1")
      .bind(admissionRow.intent_id).first<{ readonly operation_kind: string; readonly idempotency_key: string; readonly created_at: string }>();
    expect(storedIntent).toEqual({ operation_kind: "REPORT", idempotency_key: request.idempotency_key, created_at: admissionRow.created_at });
    expect((await synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM research_report_admission").first<{ readonly n: number }>())?.n).toBe(1);
    expect((await synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM artifact_revision WHERE artifact_id LIKE 'eliotr.research.artifact-%'").first<{ readonly n: number }>())?.n).toBe(1);
    expect(stageTwelve.stage).toBe("SYNTHESIZE");

    const beforeReplay = await Promise.all([
      synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM research_report_admission").first<{ readonly n: number }>(),
      synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM artifact_draft_object").first<{ readonly n: number }>(),
      synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE intent_id=(SELECT intent_id FROM research_report_admission WHERE operation_id=?1 LIMIT 1)").bind(synthesis.freeze.operation_id).first<{ readonly n: number }>(),
    ]);
    const replay = await synthesis.freeze.executor.execute(request, principal, observedHandler);
    expect(replay.receipt_ref).toBe(first.receipt_ref);
    const afterReplay = await Promise.all([
      synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM research_report_admission").first<{ readonly n: number }>(),
      synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM artifact_draft_object").first<{ readonly n: number }>(),
      synthesis.freeze.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE intent_id=(SELECT intent_id FROM research_report_admission WHERE operation_id=?1 LIMIT 1)").bind(synthesis.freeze.operation_id).first<{ readonly n: number }>(),
    ]);
    expect(afterReplay).toEqual(beforeReplay);

    const originalBinding = await synthesis.freeze.db.prepare(
      "SELECT artifact_id,revision FROM artifact_draft_binding WHERE intent_id=?1 AND intent_revision=1 LIMIT 2",
    ).bind(admissionRow.intent_id).all<{ readonly artifact_id: string; readonly revision: number }>();
    expect(originalBinding.results).toHaveLength(1);
    const baseBinding = originalBinding.results[0];
    if (baseBinding === undefined) throw new Error("original REPORT draft binding is missing");
    const originalRef = { id: baseBinding.artifact_id, revision: baseBinding.revision };
    const ownerContext: AuthenticatedRequestContext = {
      principal_ref: principal.principal_ref,
      client_class: "owner_pwa",
      credential_generation: principal.credential_generation,
      request: new Request("https://example.test"),
      trace_id: "cow-freeze-lineage-test",
    };
    const ownerRead = await prepareArtifactReadReauthorization(runtime, ownerContext, originalRef, "report");
    const parentSnapshot = await readArtifactDraftCowSnapshot({
      database: synthesis.freeze.db,
      work_bucket: synthesis.freeze.bucket,
      artifact_ref: originalRef,
      access: ownerContext,
      require_current: async (requested) => {
        const stored = await loadScopeAuthority(synthesis.freeze.db, { id: requested.snapshot_id, revision: requested.revision });
        if (stored === null || canonicalEvidenceJson(stored.snapshot) !== canonicalEvidenceJson(requested)) {
          throw new Error("original artifact scope changed during the controlled COW fixture");
        }
        return stored.snapshot;
      },
    });
    if (parentSnapshot === null || parentSnapshot.sections.length !== 1 || parentSnapshot.sections[0] === undefined) {
      throw new Error("original REPORT draft is not a single-section D1/R2 snapshot");
    }
    const originalSection = parentSnapshot.sections[0];
    const sectionContract = parentSnapshot.spec.section_contracts[0];
    if (sectionContract === undefined) throw new Error("original REPORT draft has no section contract");
    const withoutContentDigest = (value: Record<string, unknown>): Record<string, unknown> => {
      const { content_digest: _contentDigest, ...rest } = value;
      return rest;
    };
    const currentScope = ownerRead.navigation.scope;
    const currentAuthorization = ownerRead.authorization;
    const spendQuote = { estimated_model_calls: 1, estimated_input_tokens: 10, estimated_output_tokens: 10,
      estimated_embedding_tokens: 0, quoted_neurons: 0, platform_usd: 0, workers_ai_usd: 0, byok_usd: 0,
      max_total_usd: 0.01, workflow_steps: 1, expected_sources: 1, expected_sections: 1, confidence: 0.5 };
    const spendTemplate = {
      protocol: "eliotr.research-owner-spend-template.v1",
      approved: true,
      policy_ref: "cow-lineage-spend-policy",
      config_provenance_ref: "cow-lineage-spend-source",
      principal_ref: principal.principal_ref,
      client_class: "owner_pwa",
      deployment_generation: runtime.DEPLOYMENT_GENERATION,
      expires_at: currentScope.expires_at,
      rules: ["SYNTHESIZE", "AUDIT_CLAIMS"].map((stage) => ({ stage, quote: spendQuote,
        max_input_bytes: 1024, max_output_bytes: 1024,
        deployment: { route_ref: "dynamic/eliotr-economy", route_version: "v1", prompt_generation: "pg-1",
          schema_generation: "sg-1", parameters_digest: "a".repeat(64), pricing_snapshot_ref: "price-1" } })),
    };
    const ownerReportConfig = {
      schema: "eliotr.research.report-config.v1",
      admission_policy: {
        protocol: "eliotr.research-owner-report-admission-template.v1",
        policy_ref: "cow-lineage-report-policy",
        policy_revision: 1,
        config_provenance_ref: "cow-lineage-report-source",
        principal_ref: principal.principal_ref,
        client_class: "owner_pwa",
        deployment_generation: runtime.DEPLOYMENT_GENERATION,
        allowed_use: ["research"],
        disclosure_ceiling: currentAuthorization.disclosure_ceiling,
        requested_output_class: "private-draft",
        purpose: "research-report-materialization",
        expires_at: currentScope.expires_at,
      },
      artifact_policy: {
        kind: parentSnapshot.spec.kind,
        title: parentSnapshot.spec.title,
        audience: parentSnapshot.spec.audience,
        language: parentSnapshot.spec.language,
        section_contract: sectionContract,
        statement_labels: Object.fromEntries(sectionContract.required_claim_kinds.map((kind) => [kind, "UNRESOLVED"])),
        citation_policy_ref: parentSnapshot.spec.citation_policy_ref,
        verification_policy_ref: parentSnapshot.spec.verification_policy_ref,
        length_policy_ref: parentSnapshot.spec.length_policy_ref,
        export_formats: parentSnapshot.spec.export_formats,
        include_counterevidence: parentSnapshot.spec.include_counterevidence,
        include_methodology: parentSnapshot.spec.include_methodology,
        budget_ref: parentSnapshot.spec.budget_ref,
        section_residency: withoutContentDigest(originalSection.residency as unknown as Record<string, unknown>),
        manifest_residency: withoutContentDigest(parentSnapshot.manifest_residency as unknown as Record<string, unknown>),
      },
    };
    const cowEnv: Env = {
      ...runtime,
      ELIOTR_MODEL_SPEND_POLICY_JSON: JSON.stringify(spendTemplate),
      ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "cow-lineage-spend-source",
      ELIOTR_RESEARCH_REPORT_CONFIG_JSON: JSON.stringify(ownerReportConfig),
      ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "cow-lineage-report-source",
    };
    const workflowStore = createArtifactSectionReviseWorkflowStore(synthesis.freeze.db);
    const draftStore = createArtifactDraftStore(synthesis.freeze.db, synthesis.freeze.bucket);

    const createChild = async (parentRef: { readonly id: string; readonly revision: number }) => {
      const reviseRequest = {
        protocol: "eliotr.artifact-section-revise.v1" as const,
        artifact_ref: parentRef,
        section_id: sectionContract.section_id,
        expected_artifact_revision: parentRef.revision,
        idempotency_key: `cow-lineage-${parentRef.revision}`,
      };
      const admission = await prepareOwnerArtifactReportAdmission(cowEnv, ownerContext, reviseRequest);
      const attempt = await startArtifactSectionReviseWorkflow({ request: reviseRequest, report_admission: admission,
        principal, handler_generation: "artifact-cow-freeze-lineage-test-v1", store: workflowStore });
      const savedOutput = new TextEncoder().encode(`controlled local COW output ${parentRef.revision}; no provider call`);
      const outputSha = await digest(savedOutput);
      const outputRef = `artifact-cow/freeze-lineage/${attempt.request.operation_id}`;
      await synthesis.freeze.bucket.put(outputRef, savedOutput);
      const storedOutput = await synthesis.freeze.bucket.get(outputRef);
      if (storedOutput === null) throw new Error("controlled local COW output is missing from R2");
      const outputReadback = new Uint8Array(await storedOutput.arrayBuffer());
      const id = { operation_id: attempt.request.operation_id, attempt_ref: attempt.attempt_ref,
        request_sha256: attempt.request_sha256, created_at: new Date().toISOString() };
      await workflowStore.recordOutput({ ...id, output: { output_object_ref: outputRef, output_sha256: outputSha,
        output_size_bytes: savedOutput.byteLength, readback_sha256: await digest(outputReadback) } });

      const parent = await readArtifactDraftCowSnapshot({ database: synthesis.freeze.db, work_bucket: synthesis.freeze.bucket,
        artifact_ref: parentRef, access: ownerContext,
        require_current: async (requested) => {
          const stored = await loadScopeAuthority(synthesis.freeze.db, { id: requested.snapshot_id, revision: requested.revision });
          if (stored === null || canonicalEvidenceJson(stored.snapshot) !== canonicalEvidenceJson(requested)) {
            throw new Error("COW parent scope changed during the controlled fixture");
          }
          return stored.snapshot;
        } });
      if (parent === null || parent.sections.length !== 1 || parent.sections[0] === undefined) {
        throw new Error("exact COW parent D1/R2 snapshot is missing");
      }
      const sectionBytes = new TextEncoder().encode(`controlled local COW section ${parentRef.revision + 1}`);
      const sectionSha = await digest(sectionBytes);
      const suffix = `${attempt.request.operation_id}-${parentRef.revision + 1}`;
      const section = {
        ...parent.sections[0].section,
        section_ref: { id: parent.sections[0].section.section_ref.id, revision: parent.sections[0].section.section_ref.revision + 1 },
        body_object_ref: `cow-section-${suffix}`,
        body_sha256: sectionSha,
        evidence_ledger_ref: `cow-ledger-${suffix}`,
        verification_receipt_ref: `cow-verification-${suffix}`,
      };
      const dependencyRef = `cow-dependency-${suffix}`;
      const exportRef = `cow-export-${suffix}`;
      const revision = {
        ...parent.revision,
        artifact_ref: { id: parentRef.id, revision: parentRef.revision + 1 },
        dependency_manifest_ref: dependencyRef,
        sections: [section],
        deterministic_export_refs: { markdown: exportRef },
        status: "DRAFT" as const,
        created_at: new Date().toISOString(),
      };
      const domain = parent.sections[0].residency;
      const residency = async (template: typeof domain, bytes: Uint8Array) => ({
        ...template,
        content_digest: { algorithm: "sha256" as const, digest: await digest(bytes) },
      });
      const sectionResidency = await residency(domain, sectionBytes);
      const artifactObject = async (object_ref: string, object_kind: "DEPENDENCY_MANIFEST" | "EVIDENCE_LEDGER" | "VERIFICATION_RECEIPT" | "EXPORT", text: string) => {
        const bytes = new TextEncoder().encode(text);
        return { object_ref, object_kind, bytes, residency: await residency(domain, bytes) };
      };
      const referenced_objects = await Promise.all([
        artifactObject(dependencyRef, "DEPENDENCY_MANIFEST", `controlled dependency ${suffix}`),
        artifactObject(section.evidence_ledger_ref, "EVIDENCE_LEDGER", `controlled ledger ${suffix}`),
        artifactObject(section.verification_receipt_ref, "VERIFICATION_RECEIPT", `controlled verification ${suffix}`),
        artifactObject(exportRef, "EXPORT", `controlled export ${suffix}`),
      ]);
      const manifestSha = await canonicalDigest({ spec: parent.spec, revision });
      const manifestResidency = { ...parent.manifest_residency,
        content_digest: { algorithm: "sha256" as const, digest: manifestSha } };
      const prepared = await draftStore.prepare({ intent: admission.intent, expected_draft_head_revision: parentRef.revision,
        spec: parent.spec, revision, sections: [{ section, bytes: sectionBytes, residency: sectionResidency }],
        referenced_objects, manifest_residency: manifestResidency });
      const manifestReadbackSha = prepared.manifest.receipt.expected_sha256;
      const committed = await workflowStore.commitReadback({ ...id,
        draft: { artifact_ref: prepared.artifact_ref, manifest_sha256: manifestReadbackSha } });
      expect(committed.state).toBe("COMMITTED");
      return prepared.artifact_ref;
    };

    const childTwo = await createChild(originalRef);
    const childThree = await createChild(childTwo);
    const historical = await readArtifactCowHistoricalFreeze({ database: synthesis.freeze.db,
      work_bucket: synthesis.freeze.bucket, artifact_ref: childThree,
      expected_freeze_ref: parentSnapshot.revision.evidence_freeze_ref,
      expected_scope_snapshot_ref: parentSnapshot.spec.scope_snapshot_ref });
    expect(historical.operation_id).toBe(synthesis.freeze.operation_id);
    expect(historical.artifact_ref).toEqual(childThree);
    expect(historical.spec_ref).toEqual(parentSnapshot.spec.spec_ref);
    expect(historical.spec_digest).toBe(parentSnapshot.revision.spec_digest);
    expect(historical.freeze.freeze_ref).toEqual(parentSnapshot.revision.evidence_freeze_ref);
    expect(historical.source_revision_refs).toEqual(synthesis.freeze.scope.member_source_revision_refs);
    await expect(readArtifactCowHistoricalFreeze({ database: synthesis.freeze.db, work_bucket: synthesis.freeze.bucket,
      artifact_ref: childThree, expected_freeze_ref: parentSnapshot.revision.evidence_freeze_ref,
      expected_scope_snapshot_ref: { id: "unbound-scope-lineage", revision: 1 } }))
      .rejects.toThrow(/expected historical freeze scope/u);
  }, 180_000);
});
