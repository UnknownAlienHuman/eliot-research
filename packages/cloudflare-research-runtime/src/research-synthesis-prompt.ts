import { IdentifierSchema } from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  type CloudflareEvidenceResolver,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import {
  ModelGatewayExecutionError,
} from "@eliotr/cloudflare-ai";
import {
  createFrozenResearchReferenceManifestService,
  createResearchReferenceManifestReader,
  type EvidenceFreezeSynthesisContext,
  type EvidenceFreezeSynthesisContextReader,
  type BuildReferenceManifestInput,
  type ResearchModelPromptCompilerDependencies,
  type TrustedModelPromptParameters,
} from "@eliotr/cloudflare-research";
import {
  parseRequest,
  readWorkflowObject,
  textDigest,
  type StageRequest,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import { decodeModelRouteDeployment, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import type { ModelCallInput } from "@eliotr/research";

const SYNTHESIS_STAGE = "SYNTHESIZE" as const;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface ResearchSynthesisPromptDependenciesInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly operation_id: string;
  readonly principal: Pick<WorkflowPrincipal, "principal_ref" | "credential_generation" | "deployment_generation">;
  /** Canonical reader that proves the native frozen Stage 5 context. */
  readonly context: EvidenceFreezeSynthesisContextReader;
  readonly navigation: NavigationReadAuthority;
  readonly evidence_resolver: CloudflareEvidenceResolver;
  /** Explicitly installed by the server; no model or prompt defaults are selected here. */
  readonly trusted_parameters: TrustedModelPromptParameters;
  readonly request_timeout_ms: number;
}

interface StartedResearchStageAttemptRow {
  readonly operation_id: unknown;
  readonly stage_index: unknown;
  readonly request_json: unknown;
  readonly request_sha256: unknown;
  readonly attempt_ref: unknown;
  readonly expected_revision: unknown;
  readonly attempt_state: unknown;
  readonly output_json: unknown;
  readonly investigation_id: unknown;
  readonly current_revision: unknown;
  readonly next_stage_index: unknown;
  readonly run_state: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly idempotency_key: unknown;
  readonly handler_generation: unknown;
  readonly ledger_revision: unknown;
}

export interface StartedResearchStageAttempt {
  readonly request: StageRequest;
  readonly request_sha256: string;
  readonly attempt_ref: string;
}

export interface StartedResearchStageAttemptInput {
  readonly database: D1Database;
  readonly operation_id: string;
  readonly stage: StageRequest["stage"];
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
}

interface BoundSynthesisInput {
  readonly input: ModelCallInput;
  readonly deployment: ModelRouteDeployment;
  readonly context: EvidenceFreezeSynthesisContext;
}

function fail(message: string, retryable = false, cause?: unknown): never {
  throw new ModelGatewayExecutionError("MODEL_GATEWAY_PROMPT_COMPILE_FAILED", message, { retryable, cause });
}

function identifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) fail(`${label} is invalid`);
  return parsed.data;
}

function snapshot<T>(value: T, label: string): T {
  try {
    const parsed = JSON.parse(canonicalEvidenceJson(value)) as T;
    return freezeDeep(parsed);
  } catch (cause) {
    fail(`${label} is not canonical`, false, cause);
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function principalSnapshot(
  value: ResearchSynthesisPromptDependenciesInput["principal"],
): WorkflowPrincipal {
  return Object.freeze({
    principal_ref: identifier(value?.principal_ref, "principal_ref"),
    credential_generation: identifier(value?.credential_generation, "credential_generation"),
    deployment_generation: identifier(value?.deployment_generation, "deployment_generation"),
  });
}

function deploymentSnapshot(value: ModelRouteDeployment, label: string): ModelRouteDeployment {
  try {
    const decoded = decodeModelRouteDeployment(value);
    return Object.freeze({
      route_ref: decoded.route_ref,
      route_version: decoded.route_version,
      prompt_generation: decoded.prompt_generation,
      schema_generation: decoded.schema_generation,
      parameters_digest: decoded.parameters_digest,
      pricing_snapshot_ref: decoded.pricing_snapshot_ref,
    });
  } catch (cause) {
    fail(`${label} is invalid`, false, cause);
  }
}

function sameRef(left: { readonly id: string; readonly revision: number }, right: { readonly id: string; readonly revision: number }): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameDeployment(left: ModelRouteDeployment, right: ModelRouteDeployment): boolean {
  return left.route_ref === right.route_ref && left.route_version === right.route_version &&
    left.prompt_generation === right.prompt_generation && left.schema_generation === right.schema_generation &&
    left.parameters_digest === right.parameters_digest && left.pricing_snapshot_ref === right.pricing_snapshot_ref;
}

function validateTrustedParameters(value: TrustedModelPromptParameters): TrustedModelPromptParameters {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.prompt !== "string" || value.prompt.length === 0 ||
      !Number.isSafeInteger(value.max_tokens) || value.max_tokens < 1) {
    fail("installed trusted model parameters are invalid");
  }
  return snapshot(value, "installed trusted model parameters");
}

function validateModelBinding(
  input: ModelCallInput,
  suppliedDeployment: ModelRouteDeployment,
  frozen: EvidenceFreezeSynthesisContext,
): ModelRouteDeployment {
  const definition = frozen.stage_ten_input.model_profile_definition;
  const expectedDeployment = deploymentSnapshot(definition.deployment, "frozen model deployment");
  if (!sameDeployment(suppliedDeployment, expectedDeployment) ||
      input.route_ref !== expectedDeployment.route_ref ||
      input.prompt_generation !== expectedDeployment.prompt_generation ||
      input.schema_generation !== expectedDeployment.schema_generation ||
      canonicalEvidenceJson(input.evidence_pack) !== canonicalEvidenceJson(frozen.stage_five.evidence_pack) ||
      input.max_input_bytes !== definition.max_context_bytes) {
    fail("model call is not bound to the current frozen synthesis context");
  }
  if (!Number.isSafeInteger(input.max_input_bytes) || input.max_input_bytes < 1) {
    fail("model input context bound is invalid");
  }
  if (!sameRef(frozen.manifest.manifest_ref, frozen.stage_ten_input.manifest_ref)) {
    fail("frozen manifest references disagree");
  }
  return expectedDeployment;
}

export async function readStartedResearchStageAttempt(
  input: StartedResearchStageAttemptInput,
  principal: WorkflowPrincipal,
): Promise<StartedResearchStageAttempt> {
  const stageIndex = RESEARCH_WORKFLOW_STAGES.indexOf(input.stage);
  if (stageIndex < 0) fail(`${input.stage} stage is not registered`);
  let row: StartedResearchStageAttemptRow | null;
  try {
    row = await input.database.prepare(
      "SELECT a.operation_id AS operation_id, a.stage_index AS stage_index, a.request_json AS request_json, " +
      "a.request_sha256 AS request_sha256, a.attempt_ref AS attempt_ref, a.expected_revision AS expected_revision, " +
      "a.state AS attempt_state, a.output_json AS output_json, r.investigation_id AS investigation_id, " +
      "r.current_revision AS current_revision, r.next_stage_index AS next_stage_index, r.state AS run_state, " +
      "r.principal_ref AS principal_ref, r.credential_generation AS credential_generation, " +
      "r.deployment_generation AS deployment_generation, r.scope_snapshot_id AS scope_snapshot_id, " +
      "r.scope_snapshot_revision AS scope_snapshot_revision, r.idempotency_key AS idempotency_key, " +
      "r.handler_generation AS handler_generation, r.ledger_revision AS ledger_revision " +
      "FROM research_workflow_attempt a JOIN research_workflow_current r ON r.operation_id = a.operation_id " +
      "WHERE a.operation_id = ?1 AND a.stage_index = ?2 LIMIT 1",
    ).bind(input.operation_id, stageIndex).first<StartedResearchStageAttemptRow>();
  } catch (cause) {
    fail(`durable ${input.stage} attempt could not be read`, true, cause);
  }
  if (row === null) fail(`durable ${input.stage} attempt is not currently available`, true);
  const requestJson = row.request_json;
  const scopeSnapshotRevision = row.scope_snapshot_revision as number;
  if (row.operation_id !== input.operation_id || row.stage_index !== stageIndex ||
      row.attempt_state !== "STARTED" || row.output_json !== null ||
      row.run_state !== "ACTIVE" || row.next_stage_index !== stageIndex ||
      row.principal_ref !== principal.principal_ref ||
      row.credential_generation !== principal.credential_generation ||
      row.deployment_generation !== principal.deployment_generation ||
      !Number.isSafeInteger(row.current_revision) || !Number.isSafeInteger(row.expected_revision) ||
      row.current_revision !== row.expected_revision || row.ledger_revision !== row.current_revision ||
      !Number.isSafeInteger(row.scope_snapshot_revision) || scopeSnapshotRevision < 1 ||
      typeof requestJson !== "string" || typeof row.request_sha256 !== "string" ||
      !SHA256.test(row.request_sha256) || typeof row.attempt_ref !== "string") {
    fail(`durable ${input.stage} attempt is not an exact STARTED authority binding`, true);
  }
  let request: StageRequest;
  try {
    request = parseRequest(JSON.parse(requestJson));
  } catch (cause) {
    fail(`durable ${input.stage} request is malformed`, false, cause);
  }
  if (JSON.stringify(request) !== requestJson || await textDigest(requestJson) !== row.request_sha256 ||
      request.operation_id !== input.operation_id || request.stage !== input.stage ||
      request.investigation_ref.id !== row.investigation_id ||
      request.investigation_ref.revision !== row.current_revision ||
      request.idempotency_key !== row.idempotency_key || request.handler_generation !== row.handler_generation ||
      request.input_manifest.residency.scope_domain_id !== row.scope_snapshot_id ||
      request.input_manifest.residency.scope_domain_id !== input.scope_snapshot_id ||
      request.input_manifest.residency.access_domain_id !== principal.principal_ref ||
      scopeSnapshotRevision !== input.scope_snapshot_revision) {
    fail(`durable ${input.stage} request is not bound to the current owner scope`, true);
  }
  return Object.freeze({
    request,
    request_sha256: row.request_sha256,
    attempt_ref: identifier(row.attempt_ref, `${input.stage} attempt_ref`),
  });
}

export function createResearchSynthesisPromptDependencies(
  rawInput: ResearchSynthesisPromptDependenciesInput,
): ResearchModelPromptCompilerDependencies {
  if (rawInput === null || typeof rawInput !== "object" || typeof rawInput.database?.prepare !== "function" ||
      typeof rawInput.work_bucket?.head !== "function" || typeof rawInput.work_bucket?.get !== "function" ||
      typeof rawInput.navigation?.current !== "function" || typeof rawInput.navigation?.sources !== "function" ||
      typeof rawInput.evidence_resolver?.resolveHandle !== "function" || typeof rawInput.context?.read !== "function") {
    fail("synthesis prompt dependencies are invalid");
  }
  const operationId = identifier(rawInput.operation_id, "operation_id");
  const principal = principalSnapshot(rawInput.principal);
  const trustedParameters = validateTrustedParameters(rawInput.trusted_parameters);
  if (!Number.isSafeInteger(rawInput.request_timeout_ms) || rawInput.request_timeout_ms < 1 || rawInput.request_timeout_ms > 300_000) {
    fail("request timeout is invalid");
  }
  const input = Object.freeze({
    database: rawInput.database,
    work_bucket: rawInput.work_bucket,
    operation_id: operationId,
    principal,
    context: rawInput.context,
    navigation: rawInput.navigation,
    evidence_resolver: rawInput.evidence_resolver,
    trusted_parameters: trustedParameters,
    request_timeout_ms: rawInput.request_timeout_ms,
  });
  const manifestReader = createResearchReferenceManifestReader({
    database: input.database,
    work_bucket: input.work_bucket,
    navigation: input.navigation,
  });
  const manifestService = createFrozenResearchReferenceManifestService(manifestReader);

  async function readBound(rawModelInput: ModelCallInput, rawDeployment: ModelRouteDeployment): Promise<BoundSynthesisInput> {
    const modelInput = snapshot(rawModelInput, "model call input");
    const deployment = deploymentSnapshot(rawDeployment, "model deployment");
    await input.navigation.current();
    if (input.navigation.access.principal_ref !== input.principal.principal_ref ||
        input.navigation.access.credential_generation !== input.principal.credential_generation) {
      fail("owner navigation is not current", true);
    }
    const started = await readStartedResearchStageAttempt({
      database: input.database,
      operation_id: input.operation_id,
      stage: SYNTHESIS_STAGE,
      scope_snapshot_id: input.navigation.scope.snapshot_id,
      scope_snapshot_revision: input.navigation.scope.revision,
    }, input.principal);
    const inputBytes = await readWorkflowObject(input.work_bucket, started.request.input_manifest, true);
    const frozen = await input.context.read({ request: started.request, principal: input.principal, input_bytes: inputBytes });
    validateModelBinding(modelInput, deployment, frozen);
    return Object.freeze({ input: modelInput, deployment, context: frozen });
  }

  return Object.freeze({
    manifest_service: manifestService,
    build_manifest_input: async (
      rawModelInput: ModelCallInput,
      deployment: ModelRouteDeployment,
    ): Promise<BuildReferenceManifestInput> => {
      const bound = await readBound(rawModelInput, deployment);
      const definition = bound.context.stage_ten_input.model_profile_definition;
      return Object.freeze({
        evidence_pack: snapshot(bound.context.stage_five.evidence_pack, "frozen evidence pack"),
        navigation: input.navigation,
        resolver: input.evidence_resolver,
        policy: snapshot(definition.policy, "frozen model policy"),
        manifest_ref: snapshot(bound.context.manifest.manifest_ref, "frozen manifest reference"),
        model_route_ref: bound.deployment.route_ref,
        max_context_bytes: definition.max_context_bytes,
      });
    },
    resolve_trusted_parameters: async (
      rawModelInput: ModelCallInput,
      deployment: ModelRouteDeployment,
    ): Promise<TrustedModelPromptParameters> => {
      const bound = await readBound(rawModelInput, deployment);
      return Object.freeze({
        ...trustedParameters,
        prompt: `${trustedParameters.prompt}\n\nResearch request:\n${canonicalEvidenceJson({
          research_question: bound.context.w1_head.goal,
        })}`,
      });
    },
    request_timeout_ms: input.request_timeout_ms,
  });
}
