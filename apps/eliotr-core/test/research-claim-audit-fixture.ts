import type { VersionedRef } from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  createEvidenceFreezeVerificationContextReader,
  type ModelAttemptPreparationContext,
  type ModelAttemptReservationInput,
  type SpendAuthorizationReadRequest,
  type SpendAuthorizationReadback,
} from "@eliotr/cloudflare-research";
import {
  createResearchReferenceManifestService,
  createResearchReferenceManifestStore,
  type ReferenceManifestStorageContext,
} from "@eliotr/cloudflare-research";
import {
  createResearchClaimAuditInputReaderFromFreeze,
  type ResearchClaimAuditInputReader,
  type ResearchClaimAuditInputSnapshot,
  type ResearchClaimAuditPolicy,
  type ResearchClaimAuditPromptDependencies,
  type ResearchClaimAuditStageDependencies,
  type ResearchClaimAuditVerifierAuthority,
  type ResearchClaimAuditVerifierSelection,
  type ResearchVerificationV2Config,
} from "@eliotr/cloudflare-research-stages";
import {
  createResearchStageHandlerFactory,
  SERVER_OWNED_FREEZE_HANDLER_GENERATION,
  type ResearchStageHandlerFactory,
} from "../src/research-stage-handlers.js";
import {
  readCommittedStageLineage,
  readWorkflowObject,
  WorkflowCheckpointStore,
  type StageReceipt,
  type StageRequest,
  type WorkflowStageHandler,
} from "@eliotr/cloudflare-workflows";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  committedFreezeSynthesisFixture,
} from "./research-synthesis-fixture.js";
import { governedModelAttemptFixture } from "./model-attempt-fixture.js";
import { principal } from "./research-evidence-freeze-fixture.js";

export const AUDIT_VERIFIER_REF = "stage14-test-verifier";
export const AUDIT_NORMALIZATION_CONFIG: ResearchVerificationV2Config = {
  section_ref: { id: "verification-section-v2", revision: 1 },
  required_precision: "exact-excerpt",
  required_source_class: "official",
};
export const AUDIT_POLICY: ResearchClaimAuditPolicy = {
  required_dimensions: ["value_or_measurement_verification"],
  source_requirement_applicable: true,
  excerpt_requirement_applicable: true,
  coverage_limitations: [],
  unsupported_precision: [],
};

type AuditPromptClaim = {
  readonly claim_ref: VersionedRef;
  readonly claim_text_digest: string;
  readonly support_handle_refs: readonly VersionedRef[];
  readonly counterevidence_handle_refs: readonly VersionedRef[];
};

type AuditPromptBinding = {
  readonly audit_input_sha256: string;
  readonly verifier_ref: string;
  readonly verifier_schema_generation: string;
  readonly claims: readonly AuditPromptClaim[];
};

function verifierSelection(
  fixture: Awaited<ReturnType<typeof committedFreezeSynthesisFixture>>,
): ResearchClaimAuditVerifierSelection {
  const authority: ResearchClaimAuditVerifierAuthority = {
    allowed_verifier_refs: [AUDIT_VERIFIER_REF],
    verifier_ref: AUDIT_VERIFIER_REF,
    verifier_schema_generation: "stage14-verifier-schema-v1",
    // TEST qualification is deliberately explicit and fixture-only.
    deployment: fixture.freeze.profile_definition.deployment,
    deployment_generation: principal.deployment_generation,
    qualification_receipt_ref: "stage14-verifier-qualification",
    qualification_expires_at: fixture.freeze.scope.expires_at,
    qualified: true,
    current: true,
  };
  return { authority, read_current: async () => authority };
}

function createVerificationContext(
  fixture: Awaited<ReturnType<typeof committedFreezeSynthesisFixture>>,
) {
  return createEvidenceFreezeVerificationContextReader({
    database: fixture.freeze.db,
    work_bucket: fixture.freeze.bucket,
    manifest_store: fixture.freeze.freeze_store,
    read_stage_five: fixture.freeze.readers.read_stage_five,
  }, fixture.freeze.navigation, fixture.freeze.readers);
}

function auditPrompt(
  fixture: Awaited<ReturnType<typeof committedFreezeSynthesisFixture>>,
  stageFive: Awaited<ReturnType<typeof fixture.freeze.readers.read_stage_five>>,
  deployment: ModelRouteDeployment,
  promptBinding: (audit: ResearchClaimAuditInputSnapshot) => AuditPromptBinding,
  observedBindings: AuditPromptBinding[],
): ResearchClaimAuditPromptDependencies {
  const manifestRef: VersionedRef = { id: "stage14-audit-prompt", revision: 1 };
  const manifestService = createResearchReferenceManifestService({
    navigation: fixture.freeze.navigation,
    resolver: fixture.freeze.resolver,
    store: {
      async put(manifest) {
        const bytes = new TextEncoder().encode(canonicalEvidenceJson(manifest));
        const contentDigest = await evidenceSha256Bytes(bytes);
        const grant = await fixture.freeze.navigation.current();
        const context: ReferenceManifestStorageContext = {
          principal_ref: principal.principal_ref,
          credential_generation: principal.credential_generation,
          scope_snapshot_ref: { id: fixture.freeze.scope.snapshot_id, revision: fixture.freeze.scope.revision },
          manifest_residency_key: {
            scope_domain_id: fixture.freeze.scope.snapshot_id,
            access_domain_id: principal.principal_ref,
            confidentiality_domain_id: "private",
            encryption_key_domain_id: "freeze-key-v1",
            retention_domain_id: "freeze-retention-v1",
            erasure_domain_id: "freeze-erasure-v1",
            content_digest: { algorithm: "sha256", digest: contentDigest },
          },
          policy_authority_ref: grant.policy_authority_ref,
          authorization_receipt_ref: grant.authorization_receipt_ref,
          scope_snapshot_digest: fixture.freeze.scope.digest,
          pack_ref: stageFive.evidence_pack.pack_ref,
          trace_ref: stageFive.evidence_pack.trace_ref,
          stage_attempt_ref: stageFive.stage_attempt_ref,
          stage_request_sha256: stageFive.stage_request_sha256,
          created_at: fixture.freeze.navigation.timestamp(),
        };
        return (await createResearchReferenceManifestStore({
          database: fixture.freeze.db,
          work_bucket: fixture.freeze.bucket,
          context,
          navigation: fixture.freeze.navigation,
        }).persist(manifest)).manifest_ref;
      },
      async get(ref) {
        return fixture.freeze.freeze_store.get(ref);
      },
    },
  });

  return {
    manifest_service: manifestService,
    build_manifest_input: async (input) => ({
      evidence_pack: input.evidence_pack,
      navigation: fixture.freeze.navigation,
      resolver: fixture.freeze.resolver,
      policy: {
        allowed_tool_definition_refs: [],
        allowed_verifier_refs: [AUDIT_VERIFIER_REF],
        permitted_anchor_and_precision_ceilings: [],
        provider_and_policy_generations: fixture.freeze.profile_definition.policy.provider_and_policy_generations,
        stale_or_revoked_entries: [],
        permitted_acquisition_or_expansion_routes: fixture.freeze.profile_definition.policy.permitted_acquisition_or_expansion_routes,
        disclosure_ceiling: fixture.freeze.profile_definition.policy.disclosure_ceiling,
        allowed_use: fixture.freeze.profile_definition.policy.allowed_use,
        expires_at: fixture.freeze.profile_definition.expires_at,
      },
      manifest_ref: manifestRef,
      model_route_ref: deployment.route_ref,
      max_context_bytes: 64 * 1024,
    }),
    resolve_trusted_parameters: async (_input, _resolvedDeployment, audit) => {
      const binding = promptBinding(audit);
      observedBindings.push(binding);
      return { prompt: JSON.stringify(binding), max_tokens: 32 };
    },
    request_timeout_ms: 5_000,
  };
}

export interface ResearchClaimAuditStageFixtureOptions {
  /** Include a second real projected counterevidence section in the committed pack. */
  readonly include_counterevidence?: boolean;
}

async function committedAuditInputFixture(options: ResearchClaimAuditStageFixtureOptions = {}) {
  const fixture = await committedFreezeSynthesisFixture({
    candidate_protocol: "v2",
    synthesis_prompt: "Produce eliotr.research.synthesis-claims-candidate.v2 from the frozen evidence.",
    allowed_verifier_refs: [AUDIT_VERIFIER_REF],
    ...(options.include_counterevidence === true ? { include_counterevidence: true } : {}),
  });
  const synthesis = await fixture.freeze.executor.execute(fixture.stage_twelve, principal, fixture.handler.handler);
  const stage13: StageRequest = {
    ...fixture.stage_twelve,
    stage: "VERIFY",
    investigation_ref: synthesis.investigation_ref,
    input_manifest: synthesis.output_manifest,
  };
  const verification = createResearchStageHandlerFactory({
    kind: "server-owned-exploratory",
    generation: SERVER_OWNED_FREEZE_HANDLER_GENERATION,
    navigation: fixture.freeze.navigation,
    ledger: fixture.freeze.ledger,
    verification: {
      database: fixture.freeze.db,
      work_bucket: fixture.freeze.bucket,
      navigation: fixture.freeze.navigation,
      evidence_resolver: fixture.freeze.resolver,
      recheck_authority: async () => ({
        investigation_id: fixture.freeze.investigation_id,
        scope_snapshot_id: fixture.freeze.scope.snapshot_id,
        scope_snapshot_revision: fixture.freeze.scope.revision,
      }),
      context: createVerificationContext(fixture),
      v2_config: AUDIT_NORMALIZATION_CONFIG,
    },
  })("VERIFY");
  const verificationReceipt = await fixture.freeze.executor.execute(stage13, principal, verification);
  const stage14: StageRequest = {
    ...stage13,
    stage: "AUDIT_CLAIMS",
    investigation_ref: verificationReceipt.investigation_ref,
    input_manifest: verificationReceipt.output_manifest,
  };
  const inputBytes = await readWorkflowObject(fixture.freeze.bucket, stage14.input_manifest, true);
  const reader = createResearchClaimAuditInputReaderFromFreeze({
    database: fixture.freeze.db,
    work_bucket: fixture.freeze.bucket,
    manifest_store: fixture.freeze.freeze_store,
    read_stage_five: fixture.freeze.readers.read_stage_five,
  }, fixture.freeze.navigation, fixture.freeze.readers, {
    database: fixture.freeze.db,
    work_bucket: fixture.freeze.bucket,
    evidence_resolver: fixture.freeze.resolver,
    recheck_authority: async () => ({
      investigation_id: fixture.freeze.investigation_id,
      scope_snapshot_id: fixture.freeze.scope.snapshot_id,
      scope_snapshot_revision: fixture.freeze.scope.revision,
    }),
    normalization: AUDIT_NORMALIZATION_CONFIG,
    verifier: verifierSelection(fixture),
    audit_policy: AUDIT_POLICY,
  });
  return { fixture, synthesis, verificationReceipt, stage14, inputBytes, reader };
}

export interface ResearchClaimAuditStageFixture {
  readonly fixture: Awaited<ReturnType<typeof committedFreezeSynthesisFixture>>;
  readonly synthesis: StageReceipt;
  readonly verificationReceipt: StageReceipt;
  readonly stage14: StageRequest;
  readonly inputBytes: Uint8Array;
  readonly reader: ResearchClaimAuditInputReader;
  readonly auditFactory: ResearchStageHandlerFactory;
  readonly auditHandler: WorkflowStageHandler;
  readonly auditProviderCalls: () => number;
  readonly promptBindings: () => readonly AuditPromptBinding[];
}

/** Builds committed W1/W2 stages, then composes the real W2 AUDIT handler. */
export async function researchClaimAuditStageFixture(
  options: ResearchClaimAuditStageFixtureOptions = {},
): Promise<ResearchClaimAuditStageFixture> {
  const prepared = await committedAuditInputFixture(options);
  const auditInput = await prepared.reader.read({
    request: prepared.stage14,
    principal,
    input_bytes: prepared.inputBytes,
  });
  const stageFive = prepared.fixture.stage_five;
  const deployment = auditInput.verifier.deployment;
  const observedBindings: AuditPromptBinding[] = [];
  const prompt = auditPrompt(
    prepared.fixture,
    stageFive,
    deployment,
    (audit) => Object.freeze({
      audit_input_sha256: audit.evidence_input_sha256,
      verifier_ref: audit.verifier.verifier_ref,
      verifier_schema_generation: audit.verifier.verifier_schema_generation,
      claims: Object.freeze(audit.claims.claims.map((claim) => Object.freeze({
        claim_ref: claim.claim_ref,
        claim_text_digest: claim.text_digest,
        support_handle_refs: Object.freeze([...claim.support_handle_refs]),
        counterevidence_handle_refs: Object.freeze([...claim.counterevidence_handle_refs]),
      }))),
    }),
    observedBindings,
  );
  let latestPrepared: ModelAttemptReservationInput | null = null;
  let providerCalls = 0;
  const base = await governedModelAttemptFixture("freeze-audit", {
    database: prepared.fixture.freeze.db,
    bucket: prepared.fixture.freeze.bucket,
    request: prepared.stage14,
    principal,
    inputBytes: prepared.inputBytes,
  });
  const gatewayResponse = (binding: AuditPromptBinding) => JSON.stringify({
    schema: "eliotr.research.semantic-verifier-observation.v1",
    verifier_ref: binding.verifier_ref,
    verifier_schema_generation: binding.verifier_schema_generation,
    evidence_input_sha256: binding.audit_input_sha256,
    claims: binding.claims.map((claim) => ({
      claim_ref: claim.claim_ref,
      claim_text_digest: claim.claim_text_digest,
      value_or_measurement_verification: "PASS",
      specification_compliance: "PASS",
      method_artifact_alignment: "PASS",
      // The fixture source is a document while policy requires official.
      source_satisfies_requirement: "FAIL",
      supplied_excerpt_supports_requirement: "PASS",
      contradiction_observed: false,
      unsupported_precision_observed: false,
      notes: ["Controlled verifier readback bound to the immutable audit input."],
    })),
  });
  const auditModel: ResearchClaimAuditStageDependencies = {
    database: prepared.fixture.freeze.db,
    work_bucket: prepared.fixture.freeze.bucket,
    deployment_environment: "TEST", // Explicit fixture-only qualification lane.
    gateway: {
      reasoning_gateway_base_url: `https://gateway.ai.cloudflare.com/v1/${"b".repeat(32)}/eliotr-reasoning`,
      ai_gateway_binding: {
        gateway: (gatewayId) => {
          if (gatewayId !== "eliotr-reasoning") throw new Error("unexpected audit gateway binding");
          return {
            getUrl: async () => `https://gateway.ai.cloudflare.com/v1/${"b".repeat(32)}/eliotr-reasoning`,
            run: async (request, options) => {
              if (Array.isArray(request) || request.provider !== "compat" || request.endpoint !== "chat/completions") {
                throw new Error("unexpected audit binding request");
              }
              const headers = new Headers(options?.extraHeaders as Record<string, string>);
              if (headers.has("cf-aig-authorization") || headers.get("cf-aig-max-attempts") !== "1" ||
                  headers.get("cf-aig-collect-log-payload") !== "false") {
                throw new Error("audit binding policy changed");
              }
              const query = request.query as { readonly messages?: readonly { readonly role?: unknown; readonly content?: unknown }[] };
              const user = query.messages?.find((message) => message.role === "user");
              if (typeof user?.content !== "string") throw new Error("audit prompt payload is missing");
              const payload = JSON.parse(user.content) as { readonly prompt?: unknown };
              const binding = observedBindings.at(-1);
              if (binding === undefined || payload.prompt !== JSON.stringify(binding)) {
                throw new Error("audit response was not bound to the trusted prompt");
              }
              providerCalls += 1;
              return new Response(JSON.stringify({
                id: "freeze-audit-response", object: "chat.completion", created: 1,
                model: deployment.route_ref,
                choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: gatewayResponse(binding) } }],
                usage: { prompt_tokens: 8, completion_tokens: 16, total_tokens: 24 },
              }), {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "cf-aig-provider": "controlled-audit-provider",
                  "cf-aig-model": "controlled-audit-model",
                  "cf-aig-log-id": "freeze-audit-gateway-log",
                },
              });
            },
          };
        },
      },
    },
    prompt,
    pricing: {
      // Zero price is explicit test accounting; production pricing remains governed.
      quote: async () => ({ quote_ref: "freeze-audit-quote", pricing_snapshot_ref: deployment.pricing_snapshot_ref, billed_usd: 0 }),
    },
    spend_authorization: {
      read: async (request: SpendAuthorizationReadRequest): Promise<SpendAuthorizationReadback> => {
        if (latestPrepared === null) throw new Error("audit spend authorization read before preparation");
        return {
          authorization_ref: "freeze-audit-authorization",
          decision_digest: "b".repeat(64),
          operation_id: request.operation_id,
          principal_ref: request.principal_ref,
          stage_attempt_ref: request.stage_attempt_ref,
          stage_request_sha256: request.stage_request_sha256,
          reservation_id: request.reservation_id,
          quote_ref: request.quote_ref,
          route_ref: request.route_ref,
          scope_snapshot_ref: request.scope_snapshot_ref,
          workflow_authorization_receipt_ref: request.workflow_authorization_receipt_ref,
          policy_generation: latestPrepared.authority.policy_generation,
          currentness_digest: latestPrepared.authority.currentness_digest,
          expires_at: prepared.fixture.freeze.profile_definition.expires_at,
          expected_deployment: deployment,
        };
      },
    },
    input: prepared.reader,
    prepare: async (context: ModelAttemptPreparationContext, audit): Promise<ModelAttemptReservationInput> => {
      const result = await base.dependencies.prepare(context);
      const expiresAt = audit.context.stage_ten_input.model_profile_definition.expires_at;
      const value: ModelAttemptReservationInput = {
        ...result,
        intent: { ...result.intent, operation_kind: "AUDIT" },
        authority: { ...result.authority, policy_generation: audit.context.w1_head.policy_generation, expires_at: expiresAt },
        call: {
          ...result.call,
          route_ref: audit.verifier.deployment.route_ref,
          prompt_generation: audit.verifier.deployment.prompt_generation,
          schema_generation: audit.verifier.deployment.schema_generation,
          evidence_pack: audit.context.stage_five.evidence_pack,
        },
        quote: {
          ...result.quote,
          operation_kind: "AUDIT",
          selected_routes: [audit.verifier.deployment.route_ref],
          expires_at: expiresAt,
        },
      };
      latestPrepared = value;
      return value;
    },
  };
  const auditFactory = createResearchStageHandlerFactory({
    kind: "server-owned-exploratory",
    generation: SERVER_OWNED_FREEZE_HANDLER_GENERATION,
    navigation: prepared.fixture.freeze.navigation,
    ledger: prepared.fixture.freeze.ledger,
    audit_claims: auditModel,
  });
  const auditHandler = auditFactory("AUDIT_CLAIMS");
  return {
    fixture: prepared.fixture,
    synthesis: prepared.synthesis,
    verificationReceipt: prepared.verificationReceipt,
    stage14: prepared.stage14,
    inputBytes: prepared.inputBytes,
    reader: prepared.reader,
    auditFactory,
    auditHandler,
    auditProviderCalls: () => providerCalls,
    promptBindings: () => observedBindings.map((binding) => ({ ...binding, claims: binding.claims.map((claim) => ({
      ...claim,
      support_handle_refs: [...claim.support_handle_refs],
      counterevidence_handle_refs: [...claim.counterevidence_handle_refs],
    })) })),
  };
}

export async function readAuditStageInput(
  fixture: ResearchClaimAuditStageFixture,
): Promise<ResearchClaimAuditInputSnapshot> {
  return fixture.reader.read({ request: fixture.stage14, principal, input_bytes: fixture.inputBytes });
}

export async function readAuditStageResult(
  fixture: ResearchClaimAuditStageFixture,
  receipt: StageReceipt,
): Promise<Uint8Array> {
  return readWorkflowObject(fixture.fixture.freeze.bucket, receipt.output_manifest, true);
}

export async function auditCheckpointCount(
  fixture: ResearchClaimAuditStageFixture,
): Promise<number> {
  const row = await fixture.fixture.freeze.db.prepare(
    "SELECT COUNT(*) AS n FROM research_workflow_checkpoint WHERE operation_id=?1 AND stage_index=?2",
  ).bind(fixture.fixture.freeze.operation_id, RESEARCH_WORKFLOW_STAGES.indexOf("AUDIT_CLAIMS"))
    .first<{ readonly n: number }>();
  return row?.n ?? 0;
}

export async function auditStageLineage(fixture: ResearchClaimAuditStageFixture) {
  return readCommittedStageLineage(
    new WorkflowCheckpointStore(fixture.fixture.freeze.db),
    fixture.fixture.freeze.operation_id,
    "AUDIT_CLAIMS",
  );
}
