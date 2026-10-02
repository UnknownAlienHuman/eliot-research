import { beforeAll, describe, expect, it } from "vitest";
import { canonicalEvidenceJson, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import { createD1ScopeProfilePort } from "@eliotr/retrieval";
import { createArtifactSectionReviseWorkflowStore } from "@eliotr/cloudflare-workflows";
import { startArtifactSectionReviseWorkflow } from "@eliotr/cloudflare-research";
import { modelGatewayDynamicRouteTarget, modelGatewayRequestParametersSha256 } from "@eliotr/cloudflare-ai";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { ModelCallInput } from "@eliotr/research";
import type { Env } from "../src/env.js";
import { createOwnerArtifactCowModelAdmission } from "../src/artifact-cow-model-admission.js";
import { prepareOwnerArtifactReportAdmission } from "../src/artifact-report-admission.js";
import { createArtifactCowModelRuntime } from "../../../packages/cloudflare-research/src/artifact-cow-model-runtime.js";
import type { ArtifactCowModelCallContext } from "../../../packages/cloudflare-research/src/artifact-cow-model-executor.js";
import { createResearchReferenceManifestService } from "../../../packages/cloudflare-research/src/research-reference-manifest.js";
import { createResearchReferenceManifestStore, type ReferenceManifestStorageContext } from "../../../packages/cloudflare-research/src/research-reference-manifest-store.js";
import { createD1DynamicRouteRegistry } from "../../../packages/cloudflare-research/src/model-gateway-deployment-registry-d1.js";
import { createD1ResearchModelPricingQuotePort } from "../../../packages/cloudflare-research/src/research-model-pricing-quote.js";
import { createD1ResearchModelPricingSnapshotStore } from "../../../packages/cloudflare-research/src/research-model-pricing-store.js";
import { dynamicRouteJsonArtifact } from "../../../packages/cloudflare-ai/src/dynamic-route-provisioning-codec.js";
import { retrieveWithHeldScope } from "../src/research-retrieval-composition.js";
import { createArtifactDraftRuntime, draftInput, runtime } from "./artifact-draft-fixture.js";
import { freezeFixture, principal as freezePrincipal } from "./research-evidence-freeze-fixture.js";

const ROUTE = "dynamic/eliotr-cow-w3";
const ROUTE_VERSION = "cow-w3-test-v1";
const PROMPT_GENERATION = "cow-w3-prompt-v1";
const SCHEMA_GENERATION = "cow-w3-schema-v1";
const PRICING_SNAPSHOT = "cow-w3-price-v1";
const PROVIDER = "controlled-local-provider";
const EXACT_MODEL_ID = "controlled-local-model";
const GATEWAY_BASE = `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`;
const CURRENT_POLICY = "cow-w3-report-policy-v1";

let freeze: Awaited<ReturnType<typeof freezeFixture>>;
let deployment: ModelRouteDeployment;
let modelTarget: Awaited<ReturnType<typeof modelGatewayDynamicRouteTarget>>;

function digest(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes).then((raw) =>
    [...new Uint8Array(raw)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
}

async function installTestRoute(): Promise<ModelRouteDeployment> {
  const now = new Date().toISOString();
  const nextHour = new Date(Date.now() + 3_600_000).toISOString();
  const routeDeployment: ModelRouteDeployment = {
    route_ref: ROUTE,
    route_version: ROUTE_VERSION,
    prompt_generation: PROMPT_GENERATION,
    schema_generation: SCHEMA_GENERATION,
    parameters_digest: await modelGatewayRequestParametersSha256({ max_tokens: 32, stream: false }),
    pricing_snapshot_ref: PRICING_SNAPSHOT,
  };
  const target = await modelGatewayDynamicRouteTarget(routeDeployment);
  const candidate = {
    schema: "eliotr.dynamic-route-candidate.v1" as const,
    deployment: routeDeployment,
    provider_route_id: "cow-w3-controlled-route-id",
    provider_route_name: target.provider_route_name,
    route_definition_sha256: "1".repeat(64),
    provider_snapshot_sha256: "2".repeat(64),
    control_plane_receipt_ref: "cow-w3-controlled-route-receipt",
    qualification_tier: "FIXTURE" as const,
    control_plane_readback_ref: "cow-w3-controlled-control-readback",
    execution_probe_ref: "cow-w3-controlled-execution-probe",
    qualification_expires_at: nextHour,
  };
  const artifact = await dynamicRouteJsonArtifact(candidate);
  const registry = createD1DynamicRouteRegistry(runtime.CORE_DB, { environment: "TEST", now: () => now });
  const staged = await registry.stageCandidate(candidate, artifact.sha256);
  await registry.promote({ route_ref: ROUTE, expected_active_route_version: null,
    target_route_version: ROUTE_VERSION, candidate_ref: staged.candidate_ref,
    candidate_sha256: staged.readback_sha256 });

  const pricingStore = createD1ResearchModelPricingSnapshotStore(runtime.CORE_DB, { now: () => now });
  const identity = { pricing_snapshot_ref: PRICING_SNAPSHOT, route_ref: ROUTE,
    route_version: ROUTE_VERSION, provider: PROVIDER, exact_model_id: EXACT_MODEL_ID };
  await pricingStore.putImmutable({ identity, snapshot: {
    protocol: "eliotr.research-model-pricing.v1", ...identity,
    pricing_basis: "EXACT_TOKEN_RATES_V1",
    input_rate_usd_per_1k_tokens: "0.00000125",
    output_rate_usd_per_1k_tokens: "0.00000450",
    effective_at: now,
    expires_at: nextHour,
    provenance_ref: "cow-w3-controlled-price-observation",
    approval_receipt_ref: "cow-w3-controlled-price-approval",
  } });
  modelTarget = target;
  return routeDeployment;
}

async function configureReportPolicy(): Promise<void> {
  const now = new Date().toISOString();
  await runtime.CORE_DB.prepare("UPDATE investigation_current_policy SET state='REVOKED' WHERE policy_authority_ref=?1 AND state='ACTIVE'")
    .bind(freeze.scope.policy_authority_ref).run();
  await runtime.CORE_DB.prepare("INSERT INTO investigation_current_policy(policy_generation,policy_authority_ref,state,created_at) VALUES (?1,?2,'ACTIVE',?3)")
    .bind(CURRENT_POLICY, freeze.scope.policy_authority_ref, now).run();
  await runtime.CORE_DB.prepare("INSERT OR IGNORE INTO investigation_current_deployment(deployment_generation,state,created_at) VALUES (?1,'ACTIVE',?2)")
    .bind(runtime.DEPLOYMENT_GENERATION, now).run();
}

async function startW2(tag: string) {
  const input = await draftInput(tag, { scope_snapshot_id: freeze.scope.snapshot_id,
    principal_ref: freezePrincipal.principal_ref });
  await createArtifactDraftRuntime().prepare(input);
  const context = {
    principal_ref: freezePrincipal.principal_ref,
    client_class: "owner_pwa" as const,
    credential_generation: freezePrincipal.credential_generation,
    request: new Request("https://eliotr.test/artifact-revision"),
    trace_id: `cow-w3-${tag}`,
  };
  const request = { protocol: "eliotr.artifact-section-revise.v1" as const,
    artifact_ref: input.revision.artifact_ref, section_id: "summary",
    expected_artifact_revision: 1, idempotency_key: `cow-w3-revise-${tag}` };
  const quote = { estimated_model_calls: 1, estimated_input_tokens: 10, estimated_output_tokens: 10,
    estimated_embedding_tokens: 0, quoted_neurons: 0, platform_usd: 0, workers_ai_usd: 0,
    byok_usd: 0, max_total_usd: 0.01, workflow_steps: 1, expected_sources: 1,
    expected_sections: 1, confidence: 0.5 };
  const spend = { protocol: "eliotr.research-owner-spend-template.v1", approved: true,
    policy_ref: "cow-w3-spend-policy", config_provenance_ref: "cow-w3-spend-policy-install",
    principal_ref: context.principal_ref, client_class: "owner_pwa",
    deployment_generation: runtime.DEPLOYMENT_GENERATION, expires_at: freeze.scope.expires_at,
    rules: ["SYNTHESIZE", "AUDIT_CLAIMS"].map((stage) => ({ stage, quote, max_input_bytes: 8192,
      max_output_bytes: 2048, deployment })) };
  const { content_digest: _draftDigest, ...residency } = input.manifest_residency;
  const section = input.spec.section_contracts[0];
  if (section === undefined) throw new Error("COW test draft is missing its stable summary contract");
  const report = { schema: "eliotr.research.report-config.v1", admission_policy: {
    protocol: "eliotr.research-owner-report-admission-template.v1", policy_ref: "cow-w3-report-policy",
    policy_revision: 1, config_provenance_ref: "cow-w3-report-policy-install",
    principal_ref: context.principal_ref, client_class: "owner_pwa",
    deployment_generation: runtime.DEPLOYMENT_GENERATION, allowed_use: ["research"],
    disclosure_ceiling: "owner-only", requested_output_class: "private-draft",
    purpose: "research-report-materialization", expires_at: freeze.scope.expires_at },
    artifact_policy: { kind: input.spec.kind, title: input.spec.title, audience: input.spec.audience,
      language: input.spec.language, section_contract: section,
      statement_labels: { claim: "UNRESOLVED" }, citation_policy_ref: input.spec.citation_policy_ref,
      verification_policy_ref: input.spec.verification_policy_ref, length_policy_ref: input.spec.length_policy_ref,
      export_formats: input.spec.export_formats, include_counterevidence: input.spec.include_counterevidence,
      include_methodology: input.spec.include_methodology, budget_ref: input.spec.budget_ref,
      section_residency: residency, manifest_residency: residency } };
  const configuredEnv: Env = { ...runtime,
    ELIOTR_MODEL_SPEND_POLICY_JSON: JSON.stringify(spend),
    ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "cow-w3-spend-policy-install",
    ELIOTR_RESEARCH_REPORT_CONFIG_JSON: JSON.stringify(report),
    ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "cow-w3-report-policy-install",
  };
  const reportAdmission = await prepareOwnerArtifactReportAdmission(configuredEnv, context, request);
  const store = createArtifactSectionReviseWorkflowStore(runtime.CORE_DB);
  const workflowInput = { request, report_admission: reportAdmission, store,
    principal: { principal_ref: context.principal_ref, credential_generation: context.credential_generation,
      deployment_generation: runtime.DEPLOYMENT_GENERATION }, handler_generation: "cow-w3-handler-v1" };
  const attempt = await startArtifactSectionReviseWorkflow(workflowInput);
  expect(attempt.state).toBe("STARTED");
  return { input, context, request, configuredEnv, reportAdmission, attempt };
}

async function currentEvidencePack(data: Awaited<ReturnType<typeof startW2>>) {
  const navigation = data.reportAdmission.navigation;
  const profile = await createD1ScopeProfilePort(runtime.CORE_DB).loadBinding(navigation.scope);
  if (profile === null) throw new Error("Fresh COW scope is missing its persisted retrieval profile");
  const retrieval = await retrieveWithHeldScope({ CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB,
    EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET }, {
    access: navigation.access,
    scope_snapshot: navigation.scope,
    raw_query: "Pinned",
    product: "FAST_SEARCH",
    literals: [],
    requested_limit: 8,
    deadline_ms: Date.now() + 30_000,
    idempotency_key: `cow-w3-evidence-${data.attempt.request.operation_id}`,
    signal: new AbortController().signal,
    profile,
  });
  expect(retrieval.evidence_pack.scope_snapshot_ref).toEqual(data.attempt.request.scope_snapshot_ref);
  expect(retrieval.evidence_pack.resolved_evidence.length).toBeGreaterThan(0);
  return retrieval.evidence_pack;
}

function promptFor(data: Awaited<ReturnType<typeof startW2>>, pack: ModelCallInput["evidence_pack"], tag: string,
  admission: Awaited<ReturnType<typeof createOwnerArtifactCowModelAdmission>>, expectedContext: string) {
  const navigation = data.reportAdmission.navigation;
  const stores = new Map<string, ReturnType<typeof createResearchReferenceManifestStore>>();
  const manifestService = createResearchReferenceManifestService({ navigation, resolver: freeze.resolver, store: {
    async put(manifest) {
      const bytes = new TextEncoder().encode(canonicalEvidenceJson(manifest));
      const grant = await navigation.current();
      const context: ReferenceManifestStorageContext = {
        principal_ref: navigation.access.principal_ref,
        credential_generation: navigation.access.credential_generation,
        scope_snapshot_ref: { id: navigation.scope.snapshot_id, revision: navigation.scope.revision },
        manifest_residency_key: { scope_domain_id: navigation.scope.snapshot_id,
          access_domain_id: navigation.access.principal_ref, confidentiality_domain_id: "private",
          encryption_key_domain_id: `cow-w3-key-${tag}`, retention_domain_id: `cow-w3-retention-${tag}`,
          erasure_domain_id: `cow-w3-erasure-${tag}`,
          content_digest: { algorithm: "sha256", digest: await evidenceSha256Bytes(bytes) } },
        policy_authority_ref: grant.policy_authority_ref,
        authorization_receipt_ref: grant.authorization_receipt_ref,
        scope_snapshot_digest: navigation.scope.digest,
        pack_ref: pack.pack_ref,
        trace_ref: pack.trace_ref,
        stage_attempt_ref: data.attempt.attempt_ref,
        stage_request_sha256: data.attempt.request_sha256,
        created_at: new Date().toISOString(),
      };
      const store = createResearchReferenceManifestStore({ database: runtime.CORE_DB,
        work_bucket: runtime.WORK_BUCKET, context, navigation });
      stores.set(`${manifest.manifest_ref.id}:${manifest.manifest_ref.revision}`, store);
      return (await store.persist(manifest)).manifest_ref;
    },
    async get(ref) { return stores.get(`${ref.id}:${ref.revision}`)?.get(ref) ?? null; },
  } });
  let promptContextCalls = 0;
  const policy = { allowed_tool_definition_refs: [], allowed_verifier_refs: [],
    permitted_anchor_and_precision_ceilings: ["normalized_byte_range"],
    provider_and_policy_generations: { policy: CURRENT_POLICY },
    stale_or_revoked_entries: [], permitted_acquisition_or_expansion_routes: [],
    disclosure_ceiling: "owner-only", allowed_use: ["research"],
    expires_at: navigation.scope.expires_at };
  return {
    promptContextCalls: () => promptContextCalls,
    dependencies: {
      manifest_service: manifestService,
      build_manifest_input: async (call: ModelCallInput, current: ModelRouteDeployment) => ({
        evidence_pack: call.evidence_pack, navigation, resolver: freeze.resolver, policy,
        manifest_ref: { id: `cow-w3-manifest-${tag}-${(await digest(new TextEncoder().encode(call.output_object_ref))).slice(0, 20)}`, revision: 1 },
        model_route_ref: current.route_ref, max_context_bytes: 8192,
      }),
      resolve_trusted_parameters: async (call: ModelCallInput) => {
        const exactContext = await admission.promptContext(call);
        promptContextCalls += 1;
        if (exactContext !== expectedContext) throw new Error("COW prompt context differs from the admitted bounded evidence pack");
        return { prompt: "Use only the saved evidence context. Return a concise private draft.", max_tokens: 32 };
      },
      request_timeout_ms: 5_000,
    },
  };
}

async function runW3(data: Awaited<ReturnType<typeof startW2>>, tag: string, failAtGateway = false) {
  const pack = await currentEvidencePack(data);
  const cowAdmission = await createOwnerArtifactCowModelAdmission({ env: data.configuredEnv,
    attempt: data.attempt, navigation: data.reportAdmission.navigation, evidence_pack: pack,
    deployment_environment: "TEST" });
  const contextText = canonicalEvidenceJson(pack);
  const inputBytes = new TextEncoder().encode(contextText);
  const prompt = promptFor(data, pack, tag, cowAdmission, contextText);
  let gatewayCalls = 0;
  const gateway = {
    reasoning_gateway_base_url: GATEWAY_BASE,
    gateway_token: "controlled-test-transport-token",
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      gatewayCalls += 1;
      if (!String(url).startsWith(`${GATEWAY_BASE}/`)) throw new Error("unexpected nonlocal gateway destination");
      const sent = JSON.parse(String(init?.body ?? "{}")) as { model?: unknown };
      if (sent.model !== modelTarget.model) throw new Error("controlled route received a different model target");
      if (failAtGateway) throw new Error("controlled local gateway lost its acknowledgement after invocation");
      return new Response(JSON.stringify({ id: `cow-w3-response-${tag}-${gatewayCalls}`, object: "chat.completion",
        created: 1, model: modelTarget.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "controlled local model output" } }],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } }), { status: 200,
        headers: { "content-type": "application/json", "cf-aig-provider": PROVIDER,
          "cf-aig-model": EXACT_MODEL_ID, "cf-aig-log-id": `cow-w3-log-${tag}-${gatewayCalls}` } });
    },
  };
  const executor = createArtifactCowModelRuntime({ database: runtime.CORE_DB, work_bucket: runtime.WORK_BUCKET,
    gateway, prompt: prompt.dependencies,
    pricing: createD1ResearchModelPricingQuotePort(runtime.CORE_DB),
    prepare: cowAdmission.prepare, revalidateExisting: cowAdmission.revalidateExisting,
    deployment_environment: "TEST" });
  const firstSection = data.input.sections[0];
  if (firstSection === undefined) throw new Error("COW test draft is missing its output residency contract");
  const { content_digest: _discard, ...domains } = firstSection.residency;
  const residency = { ...domains, scope_domain_id: data.attempt.request.scope_snapshot_ref.id,
    access_domain_id: data.context.principal_ref };
  const workflowPrincipal = { principal_ref: data.context.principal_ref, client_class: "owner_pwa" as const,
    credential_generation: data.context.credential_generation, deployment_generation: runtime.DEPLOYMENT_GENERATION };
  const contexts = (["SYNTHESIZE", "INDEPENDENT_VERIFY"] as const).map((call_slot) => ({
    request: data.attempt.request,
    workflow_attempt: data.attempt,
    principal: workflowPrincipal,
    authority: cowAdmission.authority,
    call_slot,
    input_bytes: inputBytes,
    output_residency_domains: residency,
  } satisfies ArtifactCowModelCallContext));
  return { executor, contexts, gatewayCalls: () => gatewayCalls, promptContextCalls: prompt.promptContextCalls,
    pack, cowAdmission };
}

describe("owner COW W3 model admission through actual Workerd D1/R2", () => {
  beforeAll(async () => {
    freeze = await freezeFixture();
    deployment = await installTestRoute();
    await configureReportPolicy();
  }, 60_000);

  it("admits, settles, and replays two distinct installed REPORT slots without another route call", async () => {
    const data = await startW2("cow-w3-two-slots");
    const running = await runW3(data, "two-slots");
    const first = [];
    for (const context of running.contexts) first.push(await running.executor.executor.execute(context));
    expect(running.gatewayCalls()).toBe(2);
    expect(running.promptContextCalls()).toBe(2);
    expect(first.map((item) => item.call_slot)).toEqual(["SYNTHESIZE", "INDEPENDENT_VERIFY"]);
    expect(first.every((item) => item.bytes.byteLength > 0 && item.receipt.output_object_ref === item.output.output_object_ref)).toBe(true);

    const replay = [];
    for (const context of running.contexts) replay.push(await running.executor.executor.execute(context));
    expect(replay.map((item) => item.model_attempt_id)).toEqual(first.map((item) => item.model_attempt_id));
    expect(replay.map((item) => item.output.output_object_ref)).toEqual(first.map((item) => item.output.output_object_ref));
    expect(replay.map((item) => [...item.bytes])).toEqual(first.map((item) => [...item.bytes]));
    expect(running.gatewayCalls()).toBe(2);
    expect(running.promptContextCalls()).toBe(2);

    const admissions = await runtime.CORE_DB.prepare("SELECT call_slot,operation_id,reservation_id,quote_json,stage_request_sha256 FROM artifact_section_revise_spend_admission WHERE workflow_operation_id=?1 ORDER BY call_slot")
      .bind(data.attempt.request.operation_id).all<{ call_slot: string; operation_id: string; reservation_id: string; quote_json: string; stage_request_sha256: string }>();
    expect(admissions.results).toHaveLength(2);
    expect(admissions.results.map((row) => row.call_slot)).toEqual(["INDEPENDENT_VERIFY", "SYNTHESIZE"]);
    expect(new Set(admissions.results.map((row) => row.operation_id)).size).toBe(2);
    expect(new Set(admissions.results.map((row) => row.reservation_id)).size).toBe(2);
    for (const row of admissions.results) {
      const quote = JSON.parse(row.quote_json) as { operation_kind: string; max_total_usd: number; selected_routes: string[] };
      expect(quote).toMatchObject({ operation_kind: "REPORT", max_total_usd: 0.01, selected_routes: [ROUTE] });
      expect(row.stage_request_sha256).toBe(data.attempt.request_sha256);
    }
    const settled = await runtime.CORE_DB.prepare("SELECT state,stage_attempt_ref,output_size_bytes,output_sha256,readback_sha256 FROM research_model_attempt WHERE stage_attempt_ref=?1 ORDER BY attempt_number")
      .bind(data.attempt.attempt_ref).all<{ state: string; stage_attempt_ref: string; output_size_bytes: number; output_sha256: string; readback_sha256: string }>();
    expect(settled.results).toHaveLength(2);
    expect(settled.results.every((row) => row.state === "SUCCEEDED" && row.stage_attempt_ref === data.attempt.attempt_ref &&
      row.output_size_bytes > 0 && row.output_sha256 === row.readback_sha256)).toBe(true);
    expect(await running.executor.attempts.readByIdempotency({ principal_ref: data.context.principal_ref,
      operation_kind: "REPORT", idempotency_key: "unused" })).toBeNull();
  }, 60_000);

  it("marks an invoked lost acknowledgement UNKNOWN and refuses a second route effect", async () => {
    const data = await startW2("cow-w3-unknown");
    const running = await runW3(data, "unknown", true);
    const context = running.contexts[0];
    if (context === undefined) throw new Error("COW test is missing its synthesis slot");
    await expect(running.executor.executor.execute(context)).rejects.toMatchObject({ code: "ARTIFACT_COW_MODEL_EFFECT_UNKNOWN" });
    const w2 = await runtime.CORE_DB.prepare("SELECT state FROM artifact_section_revise_attempt WHERE operation_id=?1 AND attempt_ref=?2 LIMIT 1")
      .bind(data.attempt.request.operation_id, data.attempt.attempt_ref).first<{ state: string }>();
    expect(w2?.state).toBe("UNKNOWN");
    const before = await runtime.CORE_DB.prepare("SELECT COUNT(*) AS n FROM research_model_attempt WHERE stage_attempt_ref=?1")
      .bind(data.attempt.attempt_ref).first<{ n: number }>();
    const admissionsBefore = await runtime.CORE_DB.prepare("SELECT COUNT(*) AS n FROM artifact_section_revise_spend_admission WHERE stage_attempt_ref=?1")
      .bind(data.attempt.attempt_ref).first<{ n: number }>();
    await expect(running.executor.executor.execute(context)).rejects.toMatchObject({ code: "ARTIFACT_COW_MODEL_EFFECT_UNKNOWN" });
    const after = await runtime.CORE_DB.prepare("SELECT COUNT(*) AS n FROM research_model_attempt WHERE stage_attempt_ref=?1")
      .bind(data.attempt.attempt_ref).first<{ n: number }>();
    const admissionsAfter = await runtime.CORE_DB.prepare("SELECT COUNT(*) AS n FROM artifact_section_revise_spend_admission WHERE stage_attempt_ref=?1")
      .bind(data.attempt.attempt_ref).first<{ n: number }>();
    expect(running.gatewayCalls()).toBe(1);
    expect(before?.n).toBe(1);
    expect(after?.n).toBe(before?.n);
    expect(admissionsBefore?.n).toBe(1);
    expect(admissionsAfter?.n).toBe(admissionsBefore?.n);
  }, 60_000);
});
