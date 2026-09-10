import { modelGatewayRequestParametersSha256 } from "@eliotr/cloudflare-ai";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { dynamicRouteJsonArtifact } from "../../../packages/cloudflare-ai/src/dynamic-route-provisioning-codec.js";
import type { DynamicRouteCandidateWriteReceipt } from "../../../packages/cloudflare-ai/src/dynamic-route-provisioning-contract.js";
import { createD1DynamicRouteRegistry } from "../../../packages/cloudflare-research/src/model-gateway-deployment-registry-d1.js";
import {
  createEvidenceFreezeSynthesisContextReader,
  createEvidenceFreezeSynthesisHandler,
  type EvidenceFreezeSynthesisModelDependencies,
} from "../../../packages/cloudflare-research/src/research-evidence-freeze-composition.js";
import type { ModelAttemptReservationInput } from "../../../packages/cloudflare-research/src/model-attempt-types.js";
import type { ModelAttemptPreparationContext } from "../../../packages/cloudflare-research/src/model-attempt-handler.js";
import type { SpendAuthorizationReadRequest, SpendAuthorizationReadback } from "../../../packages/cloudflare-research/src/research-model-attempt-revalidator.js";
import type { ResearchModelPromptCompilerDependencies } from "../../../packages/cloudflare-research/src/research-model-prompt.js";
import { createResearchReferenceManifestService } from "../../../packages/cloudflare-research/src/research-reference-manifest.js";
import { createResearchReferenceManifestStore, type ReferenceManifestStorageContext } from "../../../packages/cloudflare-research/src/research-reference-manifest-store.js";
import { canonicalEvidenceJson, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import type { VersionedRef } from "@eliotr/contracts";
import { committedEvidenceFreezeFixture, principal } from "./research-evidence-freeze-fixture.js";
import { governedModelAttemptFixture } from "./model-attempt-fixture.js";

const ROUTE = "dynamic/eliotr-balanced";
const BASE_URL = `https://gateway.ai.cloudflare.com/v1/${"c".repeat(32)}/eliotr-reasoning`;
const PROMPT_GENERATION = "prompt-v1";
const SCHEMA_GENERATION = "schema-v1";

async function deploy(database: D1Database): Promise<ModelRouteDeployment> {
  const parameters_digest = await modelGatewayRequestParametersSha256({ max_tokens: 32, stream: false });
  const deployment = {
    route_ref: ROUTE, route_version: "route-v1", prompt_generation: PROMPT_GENERATION,
    schema_generation: SCHEMA_GENERATION, parameters_digest, pricing_snapshot_ref: "pricing-v1",
  } satisfies ModelRouteDeployment;
  const candidate = {
    schema: "eliotr.dynamic-route-candidate.v1" as const, deployment,
    provider_route_id: "freeze-synthesis-provider", provider_route_name: "freeze-synthesis-provider",
    route_definition_sha256: "1".repeat(64), provider_snapshot_sha256: "2".repeat(64),
    control_plane_receipt_ref: "freeze-synthesis-control", qualification_tier: "FIXTURE" as const,
    control_plane_readback_ref: "freeze-synthesis-readback", execution_probe_ref: "freeze-synthesis-probe",
    qualification_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const registry = createD1DynamicRouteRegistry(database, { environment: "TEST" });
  const raw = await registry.stageCandidate(candidate, (await dynamicRouteJsonArtifact(candidate)).sha256);
  const staged = raw as DynamicRouteCandidateWriteReceipt;
  await registry.promote({ route_ref: ROUTE, expected_active_route_version: null,
    target_route_version: deployment.route_version, candidate_ref: staged.candidate_ref,
    candidate_sha256: staged.readback_sha256 });
  return deployment;
}

function prompt(freeze: Awaited<ReturnType<typeof committedEvidenceFreezeFixture>>, stage_five: Awaited<ReturnType<typeof freeze.readers.read_stage_five>>, deployment: ModelRouteDeployment, tag: string): ResearchModelPromptCompilerDependencies {
  const manifest_ref: VersionedRef = { id: `synthesis-prompt-${tag}`, revision: 1 };
  const manifest_service = createResearchReferenceManifestService({
    navigation: freeze.navigation, resolver: freeze.resolver,
    store: {
      async put(manifest) {
        const bytes = new TextEncoder().encode(canonicalEvidenceJson(manifest));
        const content_digest = await evidenceSha256Bytes(bytes);
        const grant = await freeze.navigation.current();
        const context: ReferenceManifestStorageContext = {
          principal_ref: principal.principal_ref, credential_generation: principal.credential_generation,
          scope_snapshot_ref: { id: freeze.scope.snapshot_id, revision: freeze.scope.revision },
          manifest_residency_key: {
            scope_domain_id: freeze.scope.snapshot_id, access_domain_id: principal.principal_ref,
            confidentiality_domain_id: "private", encryption_key_domain_id: "freeze-key-v1",
            retention_domain_id: "freeze-retention-v1", erasure_domain_id: "freeze-erasure-v1",
            content_digest: { algorithm: "sha256", digest: content_digest },
          },
          policy_authority_ref: grant.policy_authority_ref, authorization_receipt_ref: grant.authorization_receipt_ref,
          scope_snapshot_digest: freeze.scope.digest, pack_ref: stage_five.evidence_pack.pack_ref,
          trace_ref: stage_five.evidence_pack.trace_ref, stage_attempt_ref: stage_five.stage_attempt_ref,
          stage_request_sha256: stage_five.stage_request_sha256, created_at: freeze.navigation.timestamp(),
        };
        return (await createResearchReferenceManifestStore({ database: freeze.db, work_bucket: freeze.bucket, context, navigation: freeze.navigation }).persist(manifest)).manifest_ref;
      },
      async get(ref) {
        return freeze.freeze_store.get(ref);
      },
    },
  });
  return {
    manifest_service,
    build_manifest_input: async (input) => ({
      evidence_pack: input.evidence_pack, navigation: freeze.navigation,
      resolver: freeze.resolver,
      policy: {
        allowed_tool_definition_refs: [], allowed_verifier_refs: [], permitted_anchor_and_precision_ceilings: [],
        provider_and_policy_generations: freeze.profile_definition.policy.provider_and_policy_generations, stale_or_revoked_entries: [],
      permitted_acquisition_or_expansion_routes: freeze.profile_definition.policy.permitted_acquisition_or_expansion_routes,
      disclosure_ceiling: freeze.profile_definition.policy.disclosure_ceiling, allowed_use: freeze.profile_definition.policy.allowed_use,
      expires_at: freeze.profile_definition.expires_at,
      },
      manifest_ref, model_route_ref: deployment.route_ref, max_context_bytes: 64 * 1024,
    }),
    resolve_trusted_parameters: async () => ({ prompt: "Produce eliotr.research.synthesis-section-candidate.v1 from the frozen evidence.", max_tokens: 32 }),
    request_timeout_ms: 5_000,
  };
}

export async function committedFreezeSynthesisFixture() {
  const freeze = await committedEvidenceFreezeFixture();
  const base = await governedModelAttemptFixture("freeze-synthesis", {
    database: freeze.db, bucket: freeze.bucket, request: freeze.stage_zero, principal,
    inputBytes: new TextEncoder().encode("freeze-synthesis-input"),
  });
  const deployment = await deploy(freeze.db);
  const context = createEvidenceFreezeSynthesisContextReader({
    database: freeze.db, work_bucket: freeze.bucket, manifest_store: freeze.freeze_store,
    read_stage_five: freeze.readers.read_stage_five,
  }, freeze.navigation, freeze.readers);
  const stage_five = await freeze.readers.read_stage_five({ operation_id: freeze.operation_id,
    investigation_id: freeze.investigation_id, principal });
  const evidence = stage_five.evidence_pack.resolved_evidence[0];
  if (evidence === undefined) throw new Error("stage five fixture has no resolved evidence");
  const candidate = JSON.stringify({ schema: "eliotr.research.synthesis-section-candidate.v1",
    section_text: evidence.exact_excerpt, cited_handle_refs: [evidence.handle.handle_ref] });
  let prepared: ModelAttemptReservationInput | null = null;
  let provider_calls = 0;
  const request_bodies: string[] = [];
  const model: EvidenceFreezeSynthesisModelDependencies = {
    database: freeze.db, work_bucket: freeze.bucket, operation_kind: "REPORT",
    gateway: { reasoning_gateway_base_url: BASE_URL, gateway_token: "controlled-freeze-synthesis",
      fetch: async (_input, init) => {
        provider_calls += 1;
        if (typeof init?.body === "string") request_bodies.push(init.body);
        return new Response(JSON.stringify({
          id: "freeze-synthesis-response", object: "chat.completion", created: 1, model: ROUTE,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: candidate } }],
          usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
        }), { status: 200, headers: { "content-type": "application/json", "cf-aig-provider": "controlled", "cf-aig-model": "controlled" } });
      } },
    prompt: prompt(freeze, stage_five, deployment, "freeze"), pricing: { quote: async () => ({ quote_ref: "freeze-synthesis-quote", pricing_snapshot_ref: "pricing-v1", billed_usd: 0 }) },
    spend_authorization: { read: async (request: SpendAuthorizationReadRequest): Promise<SpendAuthorizationReadback> => {
      if (prepared === null) throw new Error("spend authorization read before preparation");
      return {
        authorization_ref: "freeze-synthesis-authorization", decision_digest: "b".repeat(64),
        operation_id: request.operation_id, principal_ref: request.principal_ref, stage_attempt_ref: request.stage_attempt_ref,
        stage_request_sha256: request.stage_request_sha256, reservation_id: request.reservation_id, quote_ref: request.quote_ref,
        route_ref: request.route_ref, scope_snapshot_ref: request.scope_snapshot_ref,
        workflow_authorization_receipt_ref: request.workflow_authorization_receipt_ref,
        policy_generation: prepared.authority.policy_generation, currentness_digest: prepared.authority.currentness_digest,
        expires_at: freeze.profile_definition.expires_at, expected_deployment: deployment,
      };
    } },
    prepare: async (input: ModelAttemptPreparationContext, frozen) => {
      const result = await base.dependencies.prepare(input);
      const value = { ...result,
        authority: { ...result.authority, policy_generation: frozen.w1_head.policy_generation, expires_at: frozen.stage_ten_input.model_profile_definition.expires_at },
        call: { ...result.call, route_ref: frozen.stage_ten_input.model_profile_definition.deployment.route_ref,
          prompt_generation: frozen.stage_ten_input.model_profile_definition.deployment.prompt_generation,
          schema_generation: frozen.stage_ten_input.model_profile_definition.deployment.schema_generation,
          evidence_pack: frozen.stage_five.evidence_pack },
        quote: { ...result.quote, selected_routes: [deployment.route_ref], expires_at: frozen.stage_ten_input.model_profile_definition.expires_at },
      };
      prepared = value;
      return value;
    },
  };
  return { freeze, stage_five, context, handler: createEvidenceFreezeSynthesisHandler({ context, model }),
    stage_twelve: freeze.stage_twelve, provider_calls: () => provider_calls,
    request_bodies: () => [...request_bodies] };
}
