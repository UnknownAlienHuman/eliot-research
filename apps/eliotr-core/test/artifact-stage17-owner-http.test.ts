import { afterEach, describe, expect, it, vi } from "vitest";
import { modelGatewayDynamicRouteTarget, type ModelGatewayApi } from "@eliotr/cloudflare-ai";
import { canonicalEvidenceJson, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import {
  createEvidenceFreezeMaterializeContextReader, createEvidenceFreezePostSynthesisContextReader,
  createEvidenceFreezeVerificationContextReader, createResearchReferenceManifestService, createResearchReferenceManifestStore,
  type ModelAttemptPreparationContext, type ModelAttemptReservationInput, type ReferenceManifestStorageContext,
  type ResearchArtifactReportPolicy,
} from "@eliotr/cloudflare-research";
import {
  createResearchClaimAuditInputReaderFromFreeze, decodeResearchClaimAuditResult, createResearchCoverageMaterializeStageHandlerFromFreeze,
  createResearchCoverageStageHandlerFromFreeze, type ResearchClaimAuditPromptDependencies, type ResearchClaimAuditStageDependencies,
} from "@eliotr/cloudflare-research-stages";
import { readWorkflowObject, WorkflowCheckpointStore, type StageRequest } from "@eliotr/cloudflare-workflows";
import { handleHttp } from "../src/http.js";
import { createResearchStageHandlerFactory, SERVER_OWNED_FREEZE_HANDLER_GENERATION } from "@eliotr/cloudflare-research-runtime/research-stage-handlers.js";
import { runtime, governedModelAttemptFixture } from "./model-attempt-fixture.js";
import { committedFreezeSynthesisFixture, BASE_URL } from "./research-synthesis-fixture.js";
import { principal } from "./research-evidence-freeze-fixture.js";
import { AUDIT_POLICY, AUDIT_VERIFIER_REF, researchClaimAuditStageFixture, type ResearchClaimAuditStageFixture } from "./research-claim-audit-fixture.js";
import { createResearchArtifactMetadataProducer } from "../../../packages/cloudflare-research/src/research-artifact-metadata.js";
import { prepareResearchReportAdmission } from "../../../packages/cloudflare-research/src/research-report-admission.js";
import { readCommittedResearchSynthesisOutput } from "../../../packages/cloudflare-research/src/research-synthesis-output-reader.js";
import { readCommittedResearchV2MaterializationCandidate } from "../../../packages/cloudflare-research/src/research-v2-materialize-adapter.js";
import { readCommittedResearchMaterializeAudit } from "../../../packages/cloudflare-research-stages/src/research-materialize-audit-reader.js";
import { materializeResearchArtifactDraft } from "../../../packages/cloudflare-research/src/research-artifact-draft.js";

type Audited = Pick<ResearchClaimAuditStageFixture, "fixture" | "stage14" | "auditHandler" | "auditProviderCalls">;
const generation = SERVER_OWNED_FREEZE_HANDLER_GENERATION;

// Reuse the native synthesis/model fixtures, selecting a document-class
// requirement that the actual frozen document meets. No receipt is fabricated.
async function supportedAudit(): Promise<Audited> {
  const fixture = await committedFreezeSynthesisFixture({ candidate_protocol: "v2", allowed_verifier_refs: [AUDIT_VERIFIER_REF] });
  const freeze = fixture.freeze;
  const environment = { database: freeze.db, work_bucket: freeze.bucket, manifest_store: freeze.freeze_store, read_stage_five: freeze.readers.read_stage_five };
  const synthesis = await freeze.executor.execute(fixture.stage_twelve, principal, fixture.handler.handler);
  const normalization = { section_ref: { id: "stage17-native-section", revision: 1 }, required_precision: "exact-excerpt", required_source_class: "document" };
  const recheck = async () => ({ investigation_id: freeze.investigation_id, scope_snapshot_id: freeze.scope.snapshot_id, scope_snapshot_revision: freeze.scope.revision });
  const stage13: StageRequest = { ...fixture.stage_twelve, stage: "VERIFY", investigation_ref: synthesis.investigation_ref, input_manifest: synthesis.output_manifest };
  const verification = createResearchStageHandlerFactory({ kind: "server-owned-exploratory", generation,
    navigation: freeze.navigation, ledger: freeze.ledger, verification: { database: freeze.db, work_bucket: freeze.bucket,
      navigation: freeze.navigation, evidence_resolver: freeze.resolver, recheck_authority: recheck,
      context: createEvidenceFreezeVerificationContextReader(environment, freeze.navigation, freeze.readers), v2_config: normalization } })("VERIFY");
  const verified = await freeze.executor.execute(stage13, principal, verification);
  const stage14: StageRequest = { ...stage13, stage: "AUDIT_CLAIMS", investigation_ref: verified.investigation_ref, input_manifest: verified.output_manifest };
  const deployment = freeze.profile_definition.deployment;
  const authority = { allowed_verifier_refs: [AUDIT_VERIFIER_REF], verifier_ref: AUDIT_VERIFIER_REF,
    verifier_schema_generation: "stage14-verifier-schema-v1", deployment, deployment_generation: principal.deployment_generation,
    qualification_receipt_ref: "stage17-test-verifier-qualification", qualification_expires_at: freeze.scope.expires_at, qualified: true, current: true };
  const input = createResearchClaimAuditInputReaderFromFreeze(environment, freeze.navigation, freeze.readers, {
    database: freeze.db, work_bucket: freeze.bucket, evidence_resolver: freeze.resolver, recheck_authority: recheck,
    normalization, verifier: { authority, read_current: async () => authority }, audit_policy: AUDIT_POLICY });
  const base = await governedModelAttemptFixture("stage17-audit", { database: freeze.db, bucket: freeze.bucket, request: stage14,
    principal, inputBytes: await readWorkflowObject(freeze.bucket, stage14.input_manifest, true) });
  const manifestService = createResearchReferenceManifestService({ navigation: freeze.navigation, resolver: freeze.resolver, store: {
    put: async (manifest) => {
      const grant = await freeze.navigation.current();
      const contentDigest = await evidenceSha256Bytes(new TextEncoder().encode(canonicalEvidenceJson(manifest)));
      const context: ReferenceManifestStorageContext = { principal_ref: principal.principal_ref, credential_generation: principal.credential_generation,
        scope_snapshot_ref: { id: freeze.scope.snapshot_id, revision: freeze.scope.revision }, manifest_residency_key: {
          scope_domain_id: freeze.scope.snapshot_id, access_domain_id: principal.principal_ref, confidentiality_domain_id: "private",
          encryption_key_domain_id: "freeze-key-v1", retention_domain_id: "freeze-retention-v1", erasure_domain_id: "freeze-erasure-v1",
          content_digest: { algorithm: "sha256", digest: contentDigest } }, policy_authority_ref: grant.policy_authority_ref,
        authorization_receipt_ref: grant.authorization_receipt_ref, scope_snapshot_digest: freeze.scope.digest,
        pack_ref: fixture.stage_five.evidence_pack.pack_ref, trace_ref: fixture.stage_five.evidence_pack.trace_ref,
        stage_attempt_ref: fixture.stage_five.stage_attempt_ref, stage_request_sha256: fixture.stage_five.stage_request_sha256,
        created_at: freeze.navigation.timestamp() };
      return (await createResearchReferenceManifestStore({ database: freeze.db, work_bucket: freeze.bucket, context, navigation: freeze.navigation }).persist(manifest)).manifest_ref;
    }, get: (ref) => freeze.freeze_store.get(ref),
  } });
  type Binding = { evidence_input_sha256: string; verifier_ref: string; verifier_schema_generation: string;
    claims: { claim_ref: { id: string; revision: number }; claim_text_digest: string }[] };
  let binding: Binding | undefined;
  const prompt: ResearchClaimAuditPromptDependencies = { manifest_service: manifestService,
    build_manifest_input: async (call) => ({ evidence_pack: call.evidence_pack, navigation: freeze.navigation, resolver: freeze.resolver,
      policy: { allowed_tool_definition_refs: [], allowed_verifier_refs: [AUDIT_VERIFIER_REF], permitted_anchor_and_precision_ceilings: [],
        provider_and_policy_generations: freeze.profile_definition.policy.provider_and_policy_generations, stale_or_revoked_entries: [],
        permitted_acquisition_or_expansion_routes: freeze.profile_definition.policy.permitted_acquisition_or_expansion_routes,
        disclosure_ceiling: freeze.profile_definition.policy.disclosure_ceiling, allowed_use: freeze.profile_definition.policy.allowed_use,
        expires_at: freeze.profile_definition.expires_at }, manifest_ref: { id: "stage17-native-audit-prompt", revision: 1 },
      model_route_ref: deployment.route_ref, max_context_bytes: 64 * 1024 }),
    resolve_trusted_parameters: async (_call, _deployment, audit) => {
      binding = { evidence_input_sha256: audit.evidence_input_sha256, verifier_ref: audit.verifier.verifier_ref,
        verifier_schema_generation: audit.verifier.verifier_schema_generation,
        claims: audit.claims.claims.map((claim) => ({ claim_ref: claim.claim_ref, claim_text_digest: claim.text_digest })) };
      return { prompt: JSON.stringify(binding), max_tokens: 32 };
    }, request_timeout_ms: 5000 };
  let prepared: ModelAttemptReservationInput | undefined; let calls = 0;
  const auditModel: ResearchClaimAuditStageDependencies = { database: freeze.db, work_bucket: freeze.bucket, deployment_environment: "TEST", input, prompt,
    gateway: { reasoning_gateway_base_url: BASE_URL, ai_gateway_binding: {
      gateway: (gatewayId) => {
        if (gatewayId !== "eliotr-reasoning") throw new Error("unexpected stage17 gateway binding");
        return {
          getUrl: async () => BASE_URL,
          getLog: async () => { throw new Error("Controlled fingerprint must not fetch a log"); },
          run: async (request, requestOptions) => {
            const model = (await modelGatewayDynamicRouteTarget(deployment)).model;
            if (request.provider !== "compat" || request.endpoint !== "chat/completions" || Object.keys(request.headers).length !== 0 ||
                request.query.model !== model || requestOptions.gateway.collectLog !== true || requestOptions.gateway.skipCache !== true) {
              throw new Error("unexpected stage17 audit binding request");
            }
            const headers = new Headers(requestOptions.extraHeaders);
            const metadataHeader = headers.get("cf-aig-metadata");
            if (headers.has("cf-aig-authorization") || headers.get("cf-aig-max-attempts") !== "1" ||
                headers.get("cf-aig-collect-log-payload") !== "false" || headers.get("cf-aig-request-timeout") !== "5000" ||
                metadataHeader === null || JSON.stringify(requestOptions.gateway.metadata) !== metadataHeader) {
              throw new Error("stage17 audit binding policy or metadata changed");
            }
            if (binding === undefined) throw new Error("Actual audit prompt binding is missing");
            const query = request.query as { readonly messages?: readonly { readonly role?: unknown; readonly content?: unknown }[] };
            const user = query.messages?.find((message) => message.role === "user");
            if (typeof user?.content !== "string" || JSON.parse(user.content).prompt !== JSON.stringify(binding)) {
              throw new Error("Actual audit prompt binding changed");
            }
            if (calls !== 0) throw new Error("stage17 audit binding must make one request");
            calls += 1;
            const observation = { schema: "eliotr.research.semantic-verifier-observation.v1", verifier_ref: binding.verifier_ref,
              verifier_schema_generation: binding.verifier_schema_generation, evidence_input_sha256: binding.evidence_input_sha256,
              claims: binding.claims.map((claim) => ({ ...claim, value_or_measurement_verification: "PASS", specification_compliance: "PASS",
                method_artifact_alignment: "PASS", source_satisfies_requirement: "PASS", supplied_excerpt_supports_requirement: "PASS",
                contradiction_observed: false, unsupported_precision_observed: false, notes: [] })) };
            return new Response(JSON.stringify({ id: "stage17-native-audit", object: "chat.completion", created: 1, model: deployment.route_ref,
              choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(observation) } }],
              usage: { prompt_tokens: 8, completion_tokens: 16, total_tokens: 24 } }), { status: 200,
              headers: { "content-type": "application/json", "cf-aig-provider": "controlled-audit-provider", "cf-aig-model": "controlled-audit-model", "cf-aig-log-id": "stage17-native-audit-log" } });
          },
        };
      },
    } }, pricing: { quote: async () => ({ quote_ref: "stage17-native-quote", pricing_snapshot_ref: deployment.pricing_snapshot_ref, billed_usd: 0 }) },
    spend_authorization: { read: async (request) => {
      if (prepared === undefined) throw new Error("Audit preparation is missing");
      return { authorization_ref: "stage17-native-authorization", decision_digest: "b".repeat(64),
        operation_id: request.operation_id, principal_ref: request.principal_ref, stage_attempt_ref: request.stage_attempt_ref,
        stage_request_sha256: request.stage_request_sha256, reservation_id: request.reservation_id, quote_ref: request.quote_ref,
        route_ref: request.route_ref, scope_snapshot_ref: request.scope_snapshot_ref, workflow_authorization_receipt_ref: request.workflow_authorization_receipt_ref,
        policy_generation: prepared.authority.policy_generation, currentness_digest: prepared.authority.currentness_digest,
        expires_at: freeze.profile_definition.expires_at, expected_deployment: deployment };
    } }, prepare: async (context: ModelAttemptPreparationContext, audit) => {
      const value = await base.dependencies.prepare(context); const expiresAt = freeze.profile_definition.expires_at;
      prepared = { ...value, intent: { ...value.intent, operation_kind: "AUDIT" },
        authority: { ...value.authority, policy_generation: audit.context.w1_head.policy_generation, expires_at: expiresAt },
        call: { ...value.call, route_ref: deployment.route_ref, prompt_generation: deployment.prompt_generation,
          schema_generation: deployment.schema_generation, evidence_pack: fixture.stage_five.evidence_pack },
        quote: { ...value.quote, operation_kind: "AUDIT", selected_routes: [deployment.route_ref], expires_at: expiresAt } };
      return prepared;
    } };
  const auditHandler = createResearchStageHandlerFactory({ kind: "server-owned-exploratory", generation,
    navigation: freeze.navigation, ledger: freeze.ledger, audit_claims: auditModel })("AUDIT_CLAIMS");
  return { fixture, stage14, auditHandler, auditProviderCalls: () => calls };
}

async function throughCoverage(audited: Audited, synthesisBodyApi?: ModelGatewayApi, outputLanguage?: "en" | "ru") {
  const freeze = audited.fixture.freeze;
  const environment = { database: freeze.db, work_bucket: freeze.bucket, manifest_store: freeze.freeze_store, read_stage_five: freeze.readers.read_stage_five };
  const status = new WorkflowCheckpointStore(freeze.db);
  const recheck = async () => {
    const run = await status.readRunStatus(freeze.operation_id, principal); if (run === null) throw new Error("Native run disappeared");
    return { investigation_id: run.investigation_id, scope_snapshot_id: run.scope_snapshot_id, scope_snapshot_revision: run.scope_snapshot_revision };
  };
  const domains = { scope_domain_id: freeze.scope.snapshot_id, access_domain_id: principal.principal_ref,
    confidentiality_domain_id: "stage17-private", encryption_key_domain_id: "stage17-key", retention_domain_id: "stage17-retention", erasure_domain_id: "stage17-erasure" };
  const policy: ResearchArtifactReportPolicy = { kind: "technical_audit", title: "Direct audited native report", audience: "owner", language: "ru",
    section_contract: { section_id: "summary", title: "Summary", purpose: "Bound claim audit", required_claim_kinds: ["observation"], required_evidence_classes: ["source"], maximum_utf8_bytes: 4096 },
    statement_labels: { observation: "UNRESOLVED" }, citation_policy_ref: "stage17-citations", verification_policy_ref: "stage17-verification",
    length_policy_ref: "stage17-length", export_formats: ["markdown"], include_counterevidence: true, include_methodology: true,
    budget_ref: "stage17-report-budget", section_residency: domains, manifest_residency: domains };
  const row = await freeze.db.prepare("SELECT policy_generation,policy_authority_ref FROM research_workflow_run WHERE operation_id=?1")
    .bind(freeze.operation_id).first<{ policy_generation: string; policy_authority_ref: string }>();
  if (row === null) throw new Error("Native policy is missing");
  const policySource = { provenance_ref: "stage17-native-policy-source", read: async () => ({ schema: "eliotr.research.report-admission.v1" as const,
    policy_ref: "stage17-native-policy", policy_revision: 1, config_provenance_ref: "stage17-native-policy-source", principal_ref: principal.principal_ref,
    client_class: "owner_pwa" as const, policy_generation: row.policy_generation, policy_authority_ref: row.policy_authority_ref, allowed_use: ["research"] as const,
    disclosure_ceiling: "owner-only", requested_output_class: "private-draft" as const, purpose: "research-report-materialization" as const, expires_at: freeze.scope.expires_at }) };
  const handlers = createResearchStageHandlerFactory({ kind: "server-owned-exploratory", generation, navigation: freeze.navigation, ledger: freeze.ledger,
    resolve_citations: { database: freeze.db, navigation: freeze.navigation, evidence_resolver: freeze.resolver,
      context: createEvidenceFreezePostSynthesisContextReader(environment, freeze.navigation, freeze.readers, "RESOLVE_CITATIONS") },
    calculate_coverage: createResearchCoverageStageHandlerFromFreeze(environment, freeze.navigation, freeze.readers, { ledger: freeze.ledger }),
    materialize_handler: createResearchCoverageMaterializeStageHandlerFromFreeze(environment, freeze.navigation, freeze.readers, {
      database: freeze.db, work_bucket: freeze.bucket, evidence_resolver: freeze.resolver, recheck_authority: recheck, report_policy: policy, policy_source: policySource,
      ...(outputLanguage === undefined ? {} : { output_language: outputLanguage }),
      ...(synthesisBodyApi === undefined ? {} : { synthesis_body_api: synthesisBodyApi }) }) });
  let previous = await freeze.executor.execute(audited.stage14, principal, audited.auditHandler);
  const auditReceipt = previous;
  for (const stage of ["RESOLVE_CITATIONS", "CALCULATE_COVERAGE"] as const) {
    previous = await freeze.executor.execute({ ...audited.stage14, stage, investigation_ref: previous.investigation_ref, input_manifest: previous.output_manifest }, principal, handlers(stage));
  }
  const request: StageRequest = { ...audited.stage14, stage: "MATERIALIZE", investigation_ref: previous.investigation_ref, input_manifest: previous.output_manifest };
  return { audited, freeze, environment, recheck, handlers, request, policy, policySource, auditReceipt };
}

async function nativeEffects(data: Awaited<ReturnType<typeof throughCoverage>>) {
  const blobs = await data.freeze.bucket.list();
  const bytes = Object.fromEntries(await Promise.all(blobs.objects.map(async ({ key }) => {
    const object = await data.freeze.bucket.get(key); if (object === null) throw new Error("Native blob disappeared");
    return [key, await evidenceSha256Bytes(new Uint8Array(await object.arrayBuffer()))];
  })));
  const counts = await data.freeze.db.prepare("SELECT (SELECT COUNT(*) FROM artifact_draft_binding) AS drafts,(SELECT COUNT(*) FROM artifact_publication_receipt) AS publications,(SELECT COUNT(*) FROM research_model_attempt) AS models").first();
  return { bytes, counts };
}
async function ownerHttp(path: string, method = "GET", body?: unknown) {
  return handleHttp(new Request("https://research.example" + path, { method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json", "idempotency-key": "stage17-native-accept" }, body: JSON.stringify(body) }) }),
  { ...runtime, DEPLOYMENT_GENERATION: principal.deployment_generation }, {} as ExecutionContext, { accessVerifier: { verify: async () => ({
    principal_ref: principal.principal_ref, credential_generation: principal.credential_generation, authentication_method: "cloudflare_access",
    expires_at: new Date(Date.now() + 3_600_000).toISOString() }) } });
}
async function materialized(data: Awaited<ReturnType<typeof throughCoverage>>) {
  const receipt = await data.freeze.executor.execute(data.request, principal, data.handlers("MATERIALIZE"));
  const binding = await data.freeze.db.prepare("SELECT artifact_id,revision FROM artifact_draft_binding WHERE intent_id=(SELECT intent_id FROM research_report_admission WHERE operation_id=?1)")
    .bind(data.freeze.operation_id).first<{ artifact_id: string; revision: number }>();
  if (binding === null) throw new Error("Actual Stage17 draft binding missing");
  expect(binding.revision).toBe(1);
  return { receipt, artifactPath: "/api/v1/research/artifact/" + encodeURIComponent(binding.artifact_id + ":" + binding.revision) };
}
const acceptBody = { protocol: "eliotr.artifact-publication-accept.v1", expected_draft_head_revision: 1, expected_publication_revision: null };

describe("Stage17 audit-derived labels through native owner publication", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it.each(["revoked read policy", "redacted source"] as const)("accepts the fresh original draft, replays exact bytes and refuses %s without another effect", async (refusal) => {
    const data = await throughCoverage(await supportedAudit()); const output = await materialized(data);
    expect(data.audited.fixture.provider_calls()).toBe(1); expect(data.audited.auditProviderCalls()).toBe(1);
    const reauthorized = await ownerHttp(output.artifactPath + "/reauthorize", "POST"); expect(reauthorized.status).toBe(200);
    const draft = await reauthorized.json() as { data: { artifact: { sections: { statement_labels: Record<string, string> }[] } } };
    const audit = await decodeResearchClaimAuditResult(await readWorkflowObject(data.freeze.bucket, data.auditReceipt.output_manifest, true));
    expect(audit.claims).toHaveLength(1);
    expect(draft.data.artifact.sections[0]?.statement_labels).toEqual({ [audit.claims[0]?.claim_ref.id as string]: "SOURCE_SUPPORTED" });
    const before = await nativeEffects(data);
    const accepted = await ownerHttp(output.artifactPath + "/accept", "POST", acceptBody); expect(accepted.status).toBe(201);
    const publication = await accepted.json() as { data: { receipt: unknown; revision: { status: string } } };
    expect(publication.data.revision.status).toBe("ACCEPTED");
    const replay = await ownerHttp(output.artifactPath + "/accept", "POST", acceptBody); expect(replay.status).toBe(200);
    expect((await replay.json() as { data: { receipt: unknown } }).data.receipt).toEqual(publication.data.receipt);
    const committed = await data.freeze.executor.execute(data.request, principal, async () => { throw new Error("Committed Stage17 replay must not run the materializer"); });
    expect(committed).toEqual(output.receipt);
    const after = await nativeEffects(data); expect(after.bytes).toEqual(before.bytes);
    expect(after.counts).toMatchObject({ drafts: 1, publications: 1, models: before.counts?.models });
    expect(data.audited.fixture.provider_calls()).toBe(1); expect(data.audited.auditProviderCalls()).toBe(1);
    const current = await ownerHttp(output.artifactPath + "/publication"); expect(current.status).toBe(200);
    expect((await current.json() as { data: { receipt: unknown } }).data.receipt).toEqual(publication.data.receipt);
    // Policy changes invalidate scope snapshots permanently; revoke and purge
    // each use their own accepted fixture rather than reviving old authority.
    if (refusal === "revoked read policy") {
      const policies = await data.freeze.db.prepare("SELECT source_namespace_id,client_class,policy_ref,generation FROM scope_read_policy WHERE principal_ref=?1 AND state='ACTIVE'")
        .bind(principal.principal_ref).all<{ source_namespace_id: string; client_class: string; policy_ref: string; generation: number }>();
      expect(policies.results.length).toBeGreaterThan(0);
      for (const policy of policies.results) {
        const revoked = await data.freeze.db.prepare("UPDATE scope_read_policy SET state='REVOKED' WHERE principal_ref=?1 AND source_namespace_id=?2 AND client_class=?3 AND policy_ref=?4 AND generation=?5 AND state='ACTIVE' RETURNING source_namespace_id,client_class,policy_ref,generation")
          .bind(principal.principal_ref, policy.source_namespace_id, policy.client_class, policy.policy_ref, policy.generation).all<typeof policy>();
        expect(revoked.results).toEqual([policy]);
      }
    } else {
      const sources = data.freeze.scope.member_source_revision_refs; expect(sources).toHaveLength(1);
      const purged = await data.freeze.db.prepare("UPDATE source_revision SET purge_state='REDACTED' WHERE source_revision_ref=?1 AND purge_state='LIVE' RETURNING source_revision_ref")
        .bind(sources[0]).all<{ source_revision_ref: string }>();
      expect(purged.results).toEqual([{ source_revision_ref: sources[0] }]);
    }
    expect((await ownerHttp(output.artifactPath + "/publication")).status).toBe(404);
    expect((await ownerHttp(output.artifactPath + "/reauthorize", "POST")).status).toBe(404);
    expect((await ownerHttp(output.artifactPath + "/accept", "POST", acceptBody)).status).toBe(404);
    expect(await nativeEffects(data)).toEqual(after);
  }, 120_000);

  it("rejects mismatched audited claim identity, digest and normalization binding before draft writes", async () => {
    const data = await throughCoverage(await supportedAudit()); const inputBytes = await readWorkflowObject(data.freeze.bucket, data.request.input_manifest, true);
    const context = await createEvidenceFreezeMaterializeContextReader(data.environment, data.freeze.navigation, data.freeze.readers)
      .read({ request: data.request, principal, input_bytes: inputBytes });
    const synthesis = await readCommittedResearchSynthesisOutput({ database: data.freeze.db, work_bucket: data.freeze.bucket,
      operation_id: data.freeze.operation_id, principal, recheck_authority: data.recheck });
    if (synthesis === null) throw new Error("Committed synthesis is missing");
    const normalized = await readCommittedResearchV2MaterializationCandidate({ database: data.freeze.db, work_bucket: data.freeze.bucket,
      request: data.request, principal, context, synthesis_readback: synthesis });
    const audit = await readCommittedResearchMaterializeAudit({ database: data.freeze.db, work_bucket: data.freeze.bucket,
      request: data.request, principal, context, input_bytes: inputBytes, synthesis_readback: synthesis, normalized_synthesis: normalized });
    const admission = await prepareResearchReportAdmission({ database: data.freeze.db, navigation: data.freeze.navigation,
      request: data.request, principal, policy_source: data.policySource });
    const metadata = await createResearchArtifactMetadataProducer({ intent: admission.intent, expected_draft_head_revision: null, policy: data.policy })({ request: data.request, principal, context });
    const input = { ...metadata, database: data.freeze.db, work_bucket: data.freeze.bucket, operation_id: data.freeze.operation_id,
      evidence_freeze: context.freeze, reference_manifest: context.manifest, evidence_pack: context.stage_five.evidence_pack,
      navigation: data.freeze.navigation, evidence_resolver: data.freeze.resolver, synthesis_readback: synthesis,
      normalized_synthesis: normalized, require_v2_synthesis: true, admission: admission.admission, claim_audit: audit };
    const first = audit.claims[0]; if (first === undefined) throw new Error("Real audited claim missing");
    const before = await nativeEffects(data);
    for (const corrupted of [
      { ...audit, normalization_binding_sha256: "f".repeat(64) },
      { ...audit, claims: [{ ...first, claim_ref: { ...first.claim_ref, revision: first.claim_ref.revision + 1 } }] },
      { ...audit, claims: [{ ...first, claim_text_digest: "f".repeat(64) }] },
      { ...audit, claims: [first, first] },
    ]) {
      await expect(materializeResearchArtifactDraft({ ...input, claim_audit: corrupted })).rejects.toMatchObject({ code: "RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID" });
      expect(await nativeEffects(data)).toEqual(before);
    }
    expect(before.counts).toMatchObject({ drafts: 0, publications: 0 });
    expect(data.audited.fixture.provider_calls()).toBe(1); expect(data.audited.auditProviderCalls()).toBe(1);
  }, 120_000);

  it("retains the actual unsupported source verdict and HYPOTHESIS labels under the existing publication gate", async () => {
    const data = await throughCoverage(await researchClaimAuditStageFixture()); const output = await materialized(data);
    const audit = await decodeResearchClaimAuditResult(await readWorkflowObject(data.freeze.bucket, data.auditReceipt.output_manifest, true));
    expect(audit.claims.map((claim) => claim.disposition)).toEqual(["UNSUPPORTED"]);
    expect(audit.claims.map((claim) => claim.source_satisfies_requirement)).toEqual([false]);
    const reauthorized = await ownerHttp(output.artifactPath + "/reauthorize", "POST"); expect(reauthorized.status).toBe(200);
    const draft = await reauthorized.json() as { data: { artifact: { sections: { statement_labels: Record<string, string> }[] } } };
    expect(draft.data.artifact.sections[0]?.statement_labels).toEqual({ [audit.claims[0]?.claim_ref.id as string]: "HYPOTHESIS" });
    // The unchanged gate permits HYPOTHESIS for UNSUPPORTED, while a
    // SUPPORTED assumption's HYPOTHESIS remains refused by its existing rule.
    const accepted = await ownerHttp(output.artifactPath + "/accept", "POST", acceptBody);
    expect(accepted.status).toBe(201);
    const effects = await nativeEffects(data); expect(effects.counts).toMatchObject({ drafts: 1, publications: 1 });
    expect(data.audited.fixture.provider_calls()).toBe(1); expect(data.audited.auditProviderCalls()).toBe(1);
  }, 120_000);
});

function synthesisReasoningOutput(body: Readonly<Record<string, unknown>>): unknown {
  const choices = body.choices as readonly { readonly message: Readonly<Record<string, unknown>> }[];
  const first = choices[0];
  if (first === undefined) throw new Error("Controlled synthesis has no choice");
  return {
    ...body,
    choices: [{ ...first, message: { ...first.message, reasoning_content: "Hidden final-reader fixture reasoning" } }],
    usage: { ...(body.usage as Readonly<Record<string, unknown>>), neurons: 0.25 },
  };
}

describe("Stored SYNTH API through final MATERIALIZE", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("saves the actual governed draft from compatibility reasoning and neurons through both final readers", async () => {
    const data = await throughCoverage(await researchClaimAuditStageFixture({
      synthesis_response_body: synthesisReasoningOutput,
      synthesis_body_api: "compat-chat-completions",
    }), "compat-chat-completions");
    const output = await materialized(data);
    expect(output.receipt.stage).toBe("MATERIALIZE");
    expect(output.receipt.output_manifest.byte_length).toBeGreaterThan(0);
    expect((await nativeEffects(data)).counts).toMatchObject({ drafts: 1, publications: 0, models: 2 });
    expect(data.audited.fixture.provider_calls()).toBe(1);
    expect(data.audited.auditProviderCalls()).toBe(1);
  }, 120_000);

  it("refuses an explicit wrong final API in V2 and draft readers without new artifact or R2 effects", async () => {
    const data = await throughCoverage(await researchClaimAuditStageFixture({
      synthesis_response_body: synthesisReasoningOutput,
      synthesis_body_api: "compat-chat-completions",
    }));
    const inputBytes = await readWorkflowObject(data.freeze.bucket, data.request.input_manifest, true);
    const context = await createEvidenceFreezeMaterializeContextReader(data.environment, data.freeze.navigation, data.freeze.readers)
      .read({ request: data.request, principal, input_bytes: inputBytes });
    const synthesis = await readCommittedResearchSynthesisOutput({ database: data.freeze.db, work_bucket: data.freeze.bucket,
      operation_id: data.freeze.operation_id, principal, recheck_authority: data.recheck });
    if (synthesis === null) throw new Error("Committed synthesis is missing");
    const readerInput = { database: data.freeze.db, work_bucket: data.freeze.bucket,
      request: data.request, principal, context, synthesis_readback: synthesis };
    const beforeReader = await nativeEffects(data);
    await expect(readCommittedResearchV2MaterializationCandidate({ ...readerInput, synthesis_body_api: "openrouter-chat-completions" }))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(await nativeEffects(data)).toEqual(beforeReader);
    const normalized = await readCommittedResearchV2MaterializationCandidate({ ...readerInput, synthesis_body_api: "compat-chat-completions" });
    const audit = await readCommittedResearchMaterializeAudit({ database: data.freeze.db, work_bucket: data.freeze.bucket,
      request: data.request, principal, context, input_bytes: inputBytes, synthesis_readback: synthesis, normalized_synthesis: normalized });
    const admission = await prepareResearchReportAdmission({ database: data.freeze.db, navigation: data.freeze.navigation,
      request: data.request, principal, policy_source: data.policySource });
    const metadataProducer = createResearchArtifactMetadataProducer({ intent: admission.intent, expected_draft_head_revision: null, policy: data.policy });
    const metadata = await metadataProducer({ request: data.request, principal, context });
    const beforeDraft = await nativeEffects(data);
    await expect(materializeResearchArtifactDraft({ ...metadata, database: data.freeze.db, work_bucket: data.freeze.bucket,
      operation_id: data.freeze.operation_id, evidence_freeze: context.freeze, reference_manifest: context.manifest,
      evidence_pack: context.stage_five.evidence_pack, navigation: data.freeze.navigation, evidence_resolver: data.freeze.resolver,
      synthesis_readback: synthesis, synthesis_body_api: "openrouter-chat-completions", normalized_synthesis: normalized,
      require_v2_synthesis: true, admission: admission.admission, claim_audit: audit }))
      .rejects.toMatchObject({ code: "RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID" });
    expect(await nativeEffects(data)).toEqual(beforeDraft);
    expect(beforeDraft.counts).toMatchObject({ drafts: 0, publications: 0, models: 2 });
    expect(data.audited.fixture.provider_calls()).toBe(1);
    expect(data.audited.auditProviderCalls()).toBe(1);
  }, 120_000);
});

describe("run-frozen language through the actual coverage and report materializer", () => {
  it("writes the selected language into the new spec and deterministic coverage footer", async () => {
    const data = await throughCoverage(await supportedAudit(), undefined, "en");
    const output = await materialized(data);
    const binding = await data.freeze.db.prepare(
      "SELECT manifest_r2_key FROM artifact_draft_head WHERE artifact_id=(SELECT artifact_id FROM artifact_draft_binding WHERE intent_id=(SELECT intent_id FROM research_report_admission WHERE operation_id=?1)) LIMIT 1",
    ).bind(data.freeze.operation_id).first<{ manifest_r2_key: string }>();
    if (binding === null) throw new Error("Actual report manifest missing");
    const object = await data.freeze.bucket.get(binding.manifest_r2_key);
    if (object === null) throw new Error("Actual report manifest object missing");
    const manifest = JSON.parse(await object.text()) as { spec: { language: string }; revision: { sections: { body_object_ref: string }[] } };
    expect(manifest.spec.language).toBe("en");
    const bodyRef = manifest.revision.sections[0]?.body_object_ref;
    if (bodyRef === undefined) throw new Error("Actual report body reference missing");
    const bodyRow = await data.freeze.db.prepare(
      "SELECT receipt_json FROM artifact_draft_object WHERE artifact_id=(SELECT artifact_id FROM artifact_draft_binding WHERE intent_id=(SELECT intent_id FROM research_report_admission WHERE operation_id=?1)) AND object_ref=?2 AND object_kind='SECTION_BODY' LIMIT 1",
    ).bind(data.freeze.operation_id, bodyRef).first<{ receipt_json: string }>();
    if (bodyRow === null) throw new Error("Actual report body object missing");
    const bodyReceipt = JSON.parse(bodyRow.receipt_json) as { key: string };
    const body = await data.freeze.bucket.get(bodyReceipt.key);
    if (body === null) throw new Error("Actual report body bytes missing");
    const text = await body.text();
    expect(text).toContain("## Coverage and method");
    expect(text).not.toContain("## Охват и метод");
    expect(data.policy.language).toBe("ru");
    expect(output.receipt.stage).toBe("MATERIALIZE");
  }, 120_000);
});
