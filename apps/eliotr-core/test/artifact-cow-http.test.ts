import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { canonicalDigest, canonicalJson, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { modelGatewayDynamicRouteTarget, modelGatewayRequestParametersSha256 } from "@eliotr/cloudflare-ai";
import { canonicalEvidenceJson, evidenceSha256Bytes, loadScopeAuthority, createNavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import { createArtifactSectionReviseWorkflowStore, WorkflowCheckpointStore } from "@eliotr/cloudflare-workflows";
import { createEvidenceFreezeMaterializeContextReader, readArtifactDraftCowSnapshot,
  resolveReauthorizedArtifactEvidence, type ResearchArtifactReportPolicy } from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createD1DynamicRouteRegistry } from "../../../packages/cloudflare-research/src/model-gateway-deployment-registry-d1.js";
import { createD1ResearchModelPricingSnapshotStore } from "../../../packages/cloudflare-research/src/research-model-pricing-store.js";
import { dynamicRouteJsonArtifact } from "../../../packages/cloudflare-ai/src/dynamic-route-provisioning-codec.js";
import { handleHttp } from "../src/http.js";
import { createResearchStageHandlerFactory, SERVER_OWNED_FREEZE_HANDLER_GENERATION } from "../src/research-stage-handlers.js";
import type { Env } from "../src/env.js";
import { committedFreezeSynthesisFixture } from "./research-synthesis-fixture.js";
import { principal } from "./research-evidence-freeze-fixture.js";
import { countResidencyPuts } from "./artifact-draft-fixture.js";

const runtime = env as unknown as Env;
const BASE = "https://gateway.ai.cloudflare.com/v1/" + "a".repeat(32) + "/eliotr-reasoning";
const VERIFIER = "cow-http-independent-verifier-v1";
const NEXT = () => new Date(Date.now() + 3_600_000).toISOString();
const encoder = new TextEncoder();

function originalPolicy(scopeId: string): ResearchArtifactReportPolicy {
  const domains = { scope_domain_id: scopeId, access_domain_id: principal.principal_ref,
    confidentiality_domain_id: "private", encryption_key_domain_id: "cow-http-key-v1",
    retention_domain_id: "cow-http-retention-v1", erasure_domain_id: "cow-http-erasure-v1" };
  return { kind: "technical_audit", title: "Controlled owner draft", audience: "owner", language: "en",
    section_contract: { section_id: "summary", title: "Summary", purpose: "Owner summary",
      required_claim_kinds: ["observation"], required_evidence_classes: ["source"], maximum_utf8_bytes: 4096 },
    statement_labels: { observation: "UNRESOLVED" }, citation_policy_ref: "cow-http-citations-v1",
    verification_policy_ref: "cow-http-verification-v1", length_policy_ref: "cow-http-length-v1",
    export_formats: ["markdown"], include_counterevidence: true, include_methodology: true,
    budget_ref: "cow-http-budget-v1", section_residency: domains, manifest_residency: domains };
}

async function originalReport() {
  // Give unchanged current read policy a longer lifetime than the original one-hour scope.
  const prepare = runtime.CORE_DB.prepare.bind(runtime.CORE_DB);
  const policyClock = vi.spyOn(runtime.CORE_DB, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith("INSERT INTO scope_read_policy ")) return statement;
    return new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => {
        values[5] = new Date(Date.now() + 10_800_000).toISOString();
        return target.bind(...values);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  const synthesis = await committedFreezeSynthesisFixture().finally(() => policyClock.mockRestore());
  const freeze = synthesis.freeze;
  let previous = await freeze.executor.execute(synthesis.stage_twelve, principal, synthesis.handler.handler);
  for (const stage of ["VERIFY", "AUDIT_CLAIMS", "RESOLVE_CITATIONS", "CALCULATE_COVERAGE"] as const) {
    previous = await freeze.executor.execute({ ...synthesis.stage_twelve, stage,
      investigation_ref: previous.investigation_ref, input_manifest: previous.output_manifest }, principal,
      async ({ request }) => encoder.encode(JSON.stringify({ stage: request.stage })));
  }
  const request = { ...synthesis.stage_twelve, stage: "MATERIALIZE" as const,
    investigation_ref: previous.investigation_ref, input_manifest: previous.output_manifest };
  const status = new WorkflowCheckpointStore(freeze.db);
  const run = await freeze.db.prepare("SELECT policy_generation,policy_authority_ref FROM research_workflow_run WHERE operation_id=?1")
    .bind(freeze.operation_id).first<{ policy_generation: string; policy_authority_ref: string }>();
  if (run === null) throw new Error("Original REPORT run is missing");
  const policySource = { provenance_ref: "cow-http-original-report-policy-v1", read: async () => ({
    schema: "eliotr.research.report-admission.v1" as const, policy_ref: "cow-http-original-report-policy-v1", policy_revision: 1,
    config_provenance_ref: "cow-http-original-report-policy-v1", principal_ref: principal.principal_ref,
    client_class: "owner_pwa" as const, ...run, allowed_use: ["research"], disclosure_ceiling: "owner-only",
    requested_output_class: "private-draft", purpose: "research-report-materialization", expires_at: freeze.scope.expires_at }) };
  const reader = createEvidenceFreezeMaterializeContextReader({ database: freeze.db, work_bucket: freeze.bucket,
    manifest_store: freeze.freeze_store, read_stage_five: freeze.readers.read_stage_five }, freeze.navigation, freeze.readers);
  const handler = createResearchStageHandlerFactory({ kind: "server-owned-exploratory", generation: SERVER_OWNED_FREEZE_HANDLER_GENERATION,
    navigation: freeze.navigation, ledger: freeze.ledger, report_materialize: { database: freeze.db,
      work_bucket: freeze.bucket, navigation: freeze.navigation, evidence_resolver: freeze.resolver, context: reader,
      recheck_authority: async () => {
        const current = await status.readRunStatus(freeze.operation_id, principal);
        if (current === null) throw new Error("Original REPORT status is missing");
        return { investigation_id: current.investigation_id, scope_snapshot_id: current.scope_snapshot_id,
          scope_snapshot_revision: current.scope_snapshot_revision };
      }, policy_source: policySource, report_policy: originalPolicy(freeze.scope.snapshot_id) } })("MATERIALIZE");
  await freeze.executor.execute(request, principal, handler);
  const binding = await freeze.db.prepare("SELECT artifact_id,revision FROM artifact_draft_binding WHERE intent_id=(SELECT intent_id FROM research_report_admission WHERE operation_id=?1)")
    .bind(freeze.operation_id).first<{ artifact_id: string; revision: number }>();
  if (binding === null) throw new Error("Original REPORT draft binding is missing");
  const artifact_ref = { id: binding.artifact_id, revision: binding.revision };
  const context: AuthenticatedRequestContext = { ...principal, client_class: "owner_pwa",
    request: new Request("https://research.example"), trace_id: "cow-http-original" };
  const snapshot = await readArtifactDraftCowSnapshot({ database: freeze.db, work_bucket: freeze.bucket,
    artifact_ref, access: context, require_current: async (requested) => {
      const saved = await loadScopeAuthority(freeze.db, { id: requested.snapshot_id, revision: requested.revision });
      if (saved === null || canonicalEvidenceJson(saved.snapshot) !== canonicalEvidenceJson(requested)) throw new Error("Historical snapshot changed");
      return saved.snapshot;
    } });
  if (snapshot === null || snapshot.sections[0] === undefined) throw new Error("Original draft snapshot is missing");
  return { freeze, artifact_ref, context, snapshot };
}

async function installRoute(): Promise<ModelRouteDeployment> {
  const created = new Date().toISOString();
  const deployment: ModelRouteDeployment = { route_ref: "dynamic/eliotr-economy", route_version: "cow-http-v1",
    prompt_generation: "cow-http-prompt-v1", schema_generation: "cow-http-schema-v1",
    parameters_digest: await modelGatewayRequestParametersSha256({ max_tokens: 32, stream: false }),
    pricing_snapshot_ref: "cow-http-pricing-v1" };
  const target = await modelGatewayDynamicRouteTarget(deployment);
  const candidate = { schema: "eliotr.dynamic-route-candidate.v1" as const, deployment,
    provider_route_id: "cow-http-controlled-route", provider_route_name: target.provider_route_name,
    route_definition_sha256: "1".repeat(64), provider_snapshot_sha256: "2".repeat(64),
    control_plane_receipt_ref: "cow-http-controlled-receipt", qualification_tier: "FIXTURE" as const,
    control_plane_readback_ref: "cow-http-controlled-readback", execution_probe_ref: "cow-http-controlled-probe",
    qualification_expires_at: NEXT() };
  const registry = createD1DynamicRouteRegistry(runtime.CORE_DB, { environment: "TEST", now: () => created });
  const staged = await registry.stageCandidate(candidate, (await dynamicRouteJsonArtifact(candidate)).sha256);
  await registry.promote({ route_ref: deployment.route_ref, expected_active_route_version: null,
    target_route_version: deployment.route_version, candidate_ref: staged.candidate_ref, candidate_sha256: staged.readback_sha256 });
  const identity = { pricing_snapshot_ref: deployment.pricing_snapshot_ref, route_ref: deployment.route_ref,
    route_version: deployment.route_version, provider: "controlled-local-provider", exact_model_id: "controlled-local-model" };
  await createD1ResearchModelPricingSnapshotStore(runtime.CORE_DB).putImmutable({ identity, snapshot: {
    protocol: "eliotr.research-model-pricing.v1", ...identity, pricing_basis: "EXACT_TOKEN_RATES_V1",
    input_rate_usd_per_1k_tokens: "0.00000125", output_rate_usd_per_1k_tokens: "0.00000450",
    effective_at: created, expires_at: NEXT(), provenance_ref: "cow-http-controlled-price",
    approval_receipt_ref: "cow-http-controlled-approval" } });
  return deployment;
}

async function fixture() {
  const original = await originalReport();
  const allOriginal = await runtime.WORK_BUCKET.list();
  const originalBytes = new Map<string, string>();
  for (const entry of allOriginal.objects) {
    const object = await runtime.WORK_BUCKET.get(entry.key);
    if (object === null) throw new Error("Original object missing");
    originalBytes.set(entry.key, await evidenceSha256Bytes(new Uint8Array(await object.arrayBuffer())));
  }
  const originalReportRows = async () => canonicalJson((await runtime.CORE_DB.batch([
    runtime.CORE_DB.prepare("SELECT * FROM operation_intent WHERE intent_id=(SELECT intent_id FROM research_report_admission WHERE operation_id=?1)").bind(original.freeze.operation_id),
    runtime.CORE_DB.prepare("SELECT * FROM outbox WHERE intent_id=(SELECT intent_id FROM research_report_admission WHERE operation_id=?1)").bind(original.freeze.operation_id),
  ])).map((result) => result.results));
  const reportBytes = await originalReportRows();
  // Let historical scope expiry pass under the controlled contract clock; current policy is unchanged.
  const renewedTime = Date.parse(original.freeze.scope.expires_at) + 1;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(renewedTime);
  expect(Date.now()).toBeGreaterThan(Date.parse(original.freeze.scope.expires_at));
  const created = new Date().toISOString();
  await runtime.CORE_DB.prepare("UPDATE investigation_current_policy SET state='RETIRED' WHERE policy_authority_ref=?1 AND state='ACTIVE'")
    .bind(original.freeze.scope.policy_authority_ref).run();
  await runtime.CORE_DB.prepare("INSERT INTO investigation_current_policy(policy_generation,policy_authority_ref,state,created_at) VALUES (?1,?2,'ACTIVE',?3)")
    .bind("cow-http-current-policy-v1", original.freeze.scope.policy_authority_ref, created).run();
  const deployment = await installRoute();
  const policy = originalPolicy(original.freeze.scope.snapshot_id);
  const quote = { estimated_model_calls: 1, estimated_input_tokens: 20, estimated_output_tokens: 20,
    estimated_embedding_tokens: 0, quoted_neurons: 0, platform_usd: 0, workers_ai_usd: 0, byok_usd: 0,
    max_total_usd: 0.01, workflow_steps: 1, expected_sources: 1, expected_sections: 1, confidence: 0.5 };
  const spend = { protocol: "eliotr.research-owner-spend-template.v1", approved: true, policy_ref: "cow-http-spend-v1",
    config_provenance_ref: "cow-http-spend-source-v1", principal_ref: principal.principal_ref, client_class: "owner_pwa",
    deployment_generation: principal.deployment_generation, expires_at: NEXT(),
    rules: ["SYNTHESIZE", "AUDIT_CLAIMS"].map((stage) => ({ stage, quote, max_input_bytes: 65_536,
      max_output_bytes: 16_384, deployment })) };
  const report = { schema: "eliotr.research.report-config.v1", admission_policy: {
    protocol: "eliotr.research-owner-report-admission-template.v1", policy_ref: "cow-http-report-v1", policy_revision: 1,
    config_provenance_ref: "cow-http-report-source-v1", principal_ref: principal.principal_ref, client_class: "owner_pwa",
    deployment_generation: principal.deployment_generation, allowed_use: ["research"], disclosure_ceiling: "owner-only",
    requested_output_class: "private-draft", purpose: "research-report-materialization", expires_at: NEXT() }, artifact_policy: policy };
  const { definition_ref: _ref, definition_sha256: _sha, ...oldDefinition } = original.freeze.profile_definition;
  const definition = { ...oldDefinition, deployment, expires_at: NEXT(), config_provenance_ref: "cow-http-model-profile-source-v1",
    policy: { ...oldDefinition.policy, allowed_verifier_refs: [VERIFIER], expires_at: NEXT() } };
  const definition_sha256 = await canonicalDigest(definition);
  const modelProfile = { ...definition, definition_sha256,
    definition_ref: { id: "eliotr.research.model-profile-definition-" + definition_sha256, revision: 1 } };
  const semantic = { protocol: "eliotr.research-semantic-config.v1",
    synthesis: { trusted_parameters: { prompt: "Return the exact supplied observation as a synthesis claims candidate.", max_tokens: 32 }, request_timeout_ms: 5000 },
    audit: { trusted_parameters: { prompt: "Independently verify only the exact supplied claim and evidence.", max_tokens: 32 }, request_timeout_ms: 5000,
      verifier_ref: VERIFIER, verifier_schema_generation: "cow-http-verifier-schema-v1", allowed_verifier_refs: [VERIFIER],
      policy: { required_dimensions: ["value_or_measurement_verification", "specification_compliance", "method_artifact_alignment"],
        source_requirement_applicable: true, excerpt_requirement_applicable: true, coverage_limitations: [], unsupported_precision: [] } },
    normalization: { section_ref: original.snapshot.sections[0]?.section.section_ref, required_precision: "normalized_byte_range", required_source_class: "source" } };
  let modelCalls = 0;
  let failProvider = false;
  const target = await modelGatewayDynamicRouteTarget(deployment);
  const binding = { gateway: (id: string) => {
    expect(id).toBe("eliotr-reasoning");
    return { getUrl: async () => BASE, getLog: async () => { throw new Error("Controlled response must carry its fingerprint"); } };
  }, run: async (model: string, inputs: Record<string, unknown>) => {
    modelCalls += 1;
    if (failProvider) throw new Error("Controlled provider acknowledgement lost after invocation");
    expect(model).toBe(target.model);
    const messages = inputs.messages as { role: string; content: string }[];
    const userMessage = messages.find((message) => message.role === "user");
    if (userMessage === undefined) throw new Error("Controlled model request has no user context");
    const payload = JSON.parse(userMessage.content) as { prompt: string };
    const exact = payload.prompt.slice(payload.prompt.indexOf("\n\n") + 2);
    const context = JSON.parse(exact) as { protocol: string; evidence: { exact_excerpt: string; handle: { handle_ref: { id: string; revision: number } } }[];
      claims: { claim_ref: { id: string; revision: number }; text_digest: string }[] };
    let content: string;
    if (context.protocol === "eliotr.artifact-section-synthesis-input.v1") {
      const evidence = context.evidence[0];
      if (evidence === undefined) throw new Error("Controlled synthesis input has no exact evidence");
      content = JSON.stringify({ schema: "eliotr.research.synthesis-claims-candidate.v2", section_text: evidence.exact_excerpt,
        material_claims: [{ kind: "observation", text: evidence.exact_excerpt, support_handle_refs: [evidence.handle.handle_ref],
          counterevidence_handle_refs: [], span: { start: 0, end: evidence.exact_excerpt.length } }] });
    } else {
      expect(context.protocol).toBe("eliotr.artifact-section-independent-verification-input.v1");
      content = JSON.stringify({ schema: "eliotr.research.semantic-verifier-observation.v1", verifier_ref: VERIFIER,
        verifier_schema_generation: "cow-http-verifier-schema-v1", evidence_input_sha256: await evidenceSha256Bytes(encoder.encode(exact)),
        claims: context.claims.map((claim) => ({ claim_ref: claim.claim_ref, claim_text_digest: claim.text_digest,
          value_or_measurement_verification: "PASS", specification_compliance: "PASS", method_artifact_alignment: "PASS",
          source_satisfies_requirement: "PASS", supplied_excerpt_supports_requirement: "PASS",
          contradiction_observed: false, unsupported_precision_observed: false, notes: ["Controlled exact evidence inspection"] })) });
    }
    return new Response(JSON.stringify({ id: "cow-http-response-" + modelCalls, object: "chat.completion", created: 1, model: target.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 } }), { status: 200,
      headers: { "content-type": "application/json", "cf-aig-provider": "controlled-local-provider",
        "cf-aig-model": "controlled-local-model", "cf-aig-log-id": "cow-http-log-" + modelCalls } });
  } };
  const counted = countResidencyPuts(runtime.WORK_BUCKET);
  const configuredEnv: Env = { ...runtime, ENVIRONMENT: "development", DEPLOYMENT_GENERATION: principal.deployment_generation,
    WORK_BUCKET: counted.bucket, AI: binding as unknown as Env["AI"], AI_GATEWAY_REASONING_URL: BASE,
    ELIOTR_MODEL_GATEWAY_TOKEN: undefined, ELIOTR_MODEL_SPEND_POLICY_JSON: JSON.stringify(spend),
    ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "cow-http-spend-source-v1", ELIOTR_RESEARCH_REPORT_CONFIG_JSON: JSON.stringify(report),
    ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "cow-http-report-source-v1", ELIOTR_MODEL_PROFILE_DEFINITION_JSON: JSON.stringify(modelProfile),
    ELIOTR_MODEL_PROFILE_PROVENANCE_REF: "cow-http-model-profile-source-v1", ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: JSON.stringify(semantic),
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0: undefined, ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1: undefined,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: undefined, ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: undefined };
  const post = async (current: Env, tag: string, ref = original.artifact_ref, service = false) => {
    const request = new Request("https://research.example/api/v1/research/artifact/" + encodeURIComponent(ref.id + ":" + ref.revision) + "/sections/summary/revise", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": tag },
      body: JSON.stringify({ protocol: "eliotr.artifact-section-revise.v1", expected_artifact_revision: ref.revision }) });
    const response = await handleHttp(request, current, {} as ExecutionContext, { accessVerifier: { verify: async () => ({
      principal_ref: principal.principal_ref, credential_generation: principal.credential_generation,
      authentication_method: service ? "service_token" as const : "cloudflare_access" as const, expires_at: NEXT() }) } });
    return { status: response.status, body: await response.json() as { data?: { operation_id: string; state: string; draft?: { artifact_ref: { id: string; revision: number } } }; code?: string } };
  };
  const originalsUnchanged = async () => {
    expect(await originalReportRows()).toBe(reportBytes);
    for (const [key, sha] of originalBytes) {
      const object = await runtime.WORK_BUCKET.get(key);
      expect(object).not.toBeNull();
      if (object === null) throw new Error("Original object disappeared");
      expect(await evidenceSha256Bytes(new Uint8Array(await object.arrayBuffer()))).toBe(sha);
    }
  };
  return { ...original, configuredEnv, counted, post, modelCalls: () => modelCalls,
    failProvider: () => { failProvider = true; }, originalsUnchanged };
}

function crashBeforeW2Commit(database: D1Database) {
  let interrupted = false;
  const contexts = new WeakMap<object, { sql: string; values: unknown[] }>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, { get(target, property) {
    if (property === "bind") return (...values: unknown[]) => {
      const bound = target.bind(...values);
      contexts.set(bound, { sql, values });
      return bound;
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const controlled = new Proxy(database, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      if (!interrupted && statements.some((statement) => {
        const context = contexts.get(statement);
        return context?.sql.startsWith("UPDATE artifact_section_revise_attempt SET state=") && context.values[0] === "COMMITTED";
      })) { interrupted = true; throw new Error("Controlled crash after exact child finalization, before W2 commit"); }
      return target.batch(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { database: controlled, interrupted: () => interrupted };
}

async function requestBytes(operationId: string) {
  return canonicalJson((await runtime.CORE_DB.batch([
    runtime.CORE_DB.prepare("SELECT * FROM operation_intent WHERE intent_id=(SELECT report_intent_id FROM artifact_section_revise_run WHERE operation_id=?1)").bind(operationId),
    runtime.CORE_DB.prepare("SELECT * FROM outbox WHERE intent_id=(SELECT report_intent_id FROM artifact_section_revise_run WHERE operation_id=?1)").bind(operationId),
    runtime.CORE_DB.prepare("SELECT request_json,request_sha256 FROM artifact_section_revise_run WHERE operation_id=?1").bind(operationId),
    runtime.CORE_DB.prepare("SELECT request_json,request_sha256 FROM artifact_section_revise_attempt WHERE operation_id=?1").bind(operationId),
  ])).map((result) => result.results));
}

describe("owner COW HTTP/runner on native Workerd D1/R2", () => {
  afterEach(() => vi.useRealTimers());
  it("recovers a finalized child before model preparation and preserves historical bytes under a fresh REPORT scope", async () => {
    const data = await fixture();
    expect((await data.post(data.configuredEnv, "cow-http-service-denied", data.artifact_ref, true)).status).toBe(403);
    expect(data.modelCalls()).toBe(0);
    const crash = crashBeforeW2Commit(runtime.CORE_DB);
    const first = await data.post({ ...data.configuredEnv, CORE_DB: crash.database }, "cow-http-crash");
    expect(first.status, JSON.stringify(first.body)).toBeGreaterThanOrEqual(400);
    expect(crash.interrupted(), JSON.stringify({ first, calls: data.modelCalls(), attempts: (await runtime.CORE_DB.prepare("SELECT state,error_code FROM research_model_attempt WHERE cow_operation_id IS NOT NULL").all()).results })).toBe(true);
    expect(data.modelCalls()).toBe(2);
    const row = await runtime.CORE_DB.prepare("SELECT operation_id,scope_snapshot_id FROM artifact_section_revise_run WHERE idempotency_key=?1").bind("cow-http-crash").first<{ operation_id: string; scope_snapshot_id: string }>();
    if (row === null) throw new Error("COW W2 missing");
    expect(row.scope_snapshot_id).not.toBe(data.freeze.scope.snapshot_id);
    const store = createArtifactSectionReviseWorkflowStore(runtime.CORE_DB);
    const recorded = await store.read(row.operation_id);
    expect(recorded?.state).toBe("OUTPUT_RECORDED");
    if (recorded === null) throw new Error("Recorded COW attempt disappeared");
    expect(Date.now()).toBeLessThan(recorded.budget.expires_at_ms);
    expect((await runtime.CORE_DB.prepare("SELECT state FROM artifact_draft_reservation WHERE cow_operation_id=?1").bind(row.operation_id).first())?.state).toBe("FINALIZED");
    expect((await runtime.CORE_DB.prepare("SELECT scope_snapshot_id FROM artifact_section_revise_spend_admission WHERE stage_attempt_ref=?1 ORDER BY call_slot").bind(recorded.attempt_ref).all()).results)
      .toEqual([{ scope_snapshot_id: row.scope_snapshot_id }, { scope_snapshot_id: row.scope_snapshot_id }]);
    const saved = await requestBytes(row.operation_id);
    const puts = data.counted.puts();
    expect(puts).toBeGreaterThan(0);
    await data.originalsUnchanged();
    // A restarted request cannot construct a model profile. It must reconcile exact receipts first.
    const withoutModels = { ...data.configuredEnv, ELIOTR_MODEL_PROFILE_DEFINITION_JSON: "invalid", ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: undefined };
    vi.setSystemTime(Date.now() + 1000);
    const recovered = await data.post(withoutModels, "cow-http-crash");
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body.data?.state).toBe("COMMITTED");
    expect(recovered.body.data?.draft?.artifact_ref).toEqual({ ...data.artifact_ref, revision: 2 });
    expect((await data.post(withoutModels, "cow-http-crash")).body.data?.state).toBe("COMMITTED");
    expect(data.modelCalls()).toBe(2);
    expect(data.counted.puts()).toBe(puts);
    expect(await requestBytes(row.operation_id)).toBe(saved);
    await data.originalsUnchanged();
    await runtime.CORE_DB.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND principal_ref=?2")
      .bind(row.scope_snapshot_id, principal.principal_ref).run();
    const revoked = await data.post(withoutModels, "cow-http-crash");
    expect(revoked.status).toBeGreaterThanOrEqual(400);
    expect(data.modelCalls()).toBe(2);
    expect(data.counted.puts()).toBe(puts);
    expect(await requestBytes(row.operation_id)).toBe(saved);
    await data.originalsUnchanged();
  }, 120_000);

  it("keeps OUTPUT_RECORDED pending when current authority is revoked and rejects a saved-handle redaction race", async () => {
    const data = await fixture();
    const crash = crashBeforeW2Commit(runtime.CORE_DB);
    expect((await data.post({ ...data.configuredEnv, CORE_DB: crash.database }, "cow-http-revoked-output")).status).toBeGreaterThanOrEqual(400);
    expect(crash.interrupted()).toBe(true);
    expect(data.modelCalls()).toBe(2);
    const row = await runtime.CORE_DB.prepare("SELECT operation_id FROM artifact_section_revise_run WHERE idempotency_key=?1")
      .bind("cow-http-revoked-output").first<{ operation_id: string }>();
    if (row === null) throw new Error("Revoked-output COW W2 missing");
    const store = createArtifactSectionReviseWorkflowStore(runtime.CORE_DB);
    const recorded = await store.read(row.operation_id);
    if (recorded === null) throw new Error("Revoked-output COW attempt missing");
    expect(recorded.state).toBe("OUTPUT_RECORDED");
    const scope = await loadScopeAuthority(runtime.CORE_DB, recorded.request.scope_snapshot_ref);
    if (scope === null) throw new Error("Current REPORT scope missing");
    const scopes = createD1ScopeService(runtime.CORE_DB, createOwnerScopeAuthority(runtime.CORE_DB, data.context, Date.now));
    const navigation = createNavigationReadAuthority({ database: runtime.CORE_DB, scope_snapshot: scope.snapshot,
      access: data.context, require_current: (requested) => scopes.requireCurrent(requested), now: Date.now });
    const ledger = data.snapshot.referenced_objects.find((object) => object.object_kind === "EVIDENCE_LEDGER");
    if (ledger === undefined) throw new Error("Original evidence ledger missing");
    const evidence = (JSON.parse(new TextDecoder().decode(ledger.bytes)) as { resolved_evidence: { handle: {
      handle_ref: { id: string; revision: number }; excerpt_sha256: string } }[] }).resolved_evidence[0];
    if (evidence === undefined) throw new Error("Original evidence handle missing");
    let redactedDuringRead = false;
    const racedBucket = Object.create(runtime.EVIDENCE_BUCKET) as R2Bucket;
    racedBucket.head = runtime.EVIDENCE_BUCKET.head.bind(runtime.EVIDENCE_BUCKET);
    racedBucket.get = async (...args: Parameters<R2Bucket["get"]>) => {
      if (!redactedDuringRead) {
        redactedDuringRead = true;
        await runtime.CORE_DB.prepare("UPDATE evidence_handle SET terminal_state='REDACTED',invalidation_ref='cow-http-redaction-race' WHERE handle_id=?1 AND revision=?2")
          .bind(evidence.handle.handle_ref.id, evidence.handle.handle_ref.revision).run();
      }
      return runtime.EVIDENCE_BUCKET.get(...args);
    };
    const authorizationBeforeRace = await navigation.current();
    await expect(resolveReauthorizedArtifactEvidence({ database: runtime.CORE_DB, search_database: runtime.SEARCH_DB,
      evidence_bucket: racedBucket, access: data.context, current_navigation: navigation,
      current_authorization: authorizationBeforeRace, original_handle_ref: evidence.handle.handle_ref,
      original_scope_snapshot_ref: data.snapshot.spec.scope_snapshot_ref,
      expected_excerpt_sha256: evidence.handle.excerpt_sha256 })).rejects.toMatchObject({ code: "ARTIFACT_DRAFT_READ_STALE" });
    expect(redactedDuringRead).toBe(true);
    expect(canonicalJson(await navigation.current())).toBe(canonicalJson(authorizationBeforeRace));
    const saved = await requestBytes(row.operation_id);
    const puts = data.counted.puts();
    await runtime.CORE_DB.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND principal_ref=?2")
      .bind(scope.snapshot.snapshot_id, principal.principal_ref).run();
    const denied = await data.post({ ...data.configuredEnv, ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: undefined }, "cow-http-revoked-output");
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect((await store.read(row.operation_id))?.state).toBe("OUTPUT_RECORDED");
    expect(data.modelCalls()).toBe(2);
    expect(data.counted.puts()).toBe(puts);
    expect(await requestBytes(row.operation_id)).toBe(saved);
    await data.originalsUnchanged();
  }, 120_000);

  it("returns durable UNKNOWN on replay without another model effect", async () => {
    const data = await fixture();
    data.failProvider();
    const first = await data.post(data.configuredEnv, "cow-http-unknown");
    expect(first.status).toBeGreaterThanOrEqual(400);
    expect(data.modelCalls()).toBe(1);
    const row = await runtime.CORE_DB.prepare("SELECT operation_id FROM artifact_section_revise_run WHERE idempotency_key=?1").bind("cow-http-unknown").first<{ operation_id: string }>();
    if (row === null) throw new Error("UNKNOWN COW W2 missing");
    expect((await createArtifactSectionReviseWorkflowStore(runtime.CORE_DB).read(row.operation_id))?.state).toBe("UNKNOWN");
    const saved = await requestBytes(row.operation_id);
    const puts = data.counted.puts();
    const replay = await data.post({ ...data.configuredEnv, ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: undefined }, "cow-http-unknown");
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data?.state).toBe("UNKNOWN");
    expect(data.modelCalls()).toBe(1);
    expect(data.counted.puts()).toBe(puts);
    expect(await requestBytes(row.operation_id)).toBe(saved);
    await data.originalsUnchanged();
  }, 120_000);
});
