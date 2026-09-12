import { decodeModelGatewayBody } from "@eliotr/cloudflare-ai";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { type ClaimAuditItem, type VersionedRef } from "@eliotr/contracts";
import {
  decodeSemanticVerifierBatch,
  translateSemanticVerifierBatch,
  type TrustedSemanticClaimAuditInput,
} from "@eliotr/research";
import {
  createModelAttemptStore,
  createResearchModelStageHandler,
  deriveModelAttemptIdentity,
  readD1ModelGatewayFingerprint,
  type ModelAttemptPreparationContext,
  type ModelAttemptReadback,
  type ModelAttemptReservationInput,
  type ResearchModelPromptCompilerDependencies,
  type ResearchModelStageHandler,
  type ResearchModelStageHandlerDependencies,
} from "@eliotr/cloudflare-research";
import {
  digest,
  fail,
  MAX_WORKFLOW_OUTPUT_BYTES,
  parseRequest,
  readWorkflowObject,
  snapshotPrincipal,
  type StageRequest,
  type WorkflowAttemptRecoveryInput,
  type WorkflowPrincipal,
  type WorkflowStageHandler,
} from "@eliotr/cloudflare-workflows";
import {
  encodeResearchClaimAuditResult,
  type ResearchClaimAuditClaimInput,
} from "./research-claim-audit-result.js";
import type {
  ResearchClaimAuditInputReader,
  ResearchClaimAuditInputSnapshot,
} from "./research-claim-audit-input.js";
import {
  parseResearchClaimAuditPolicy,
  type ResearchClaimAuditPolicy,
} from "./research-claim-audit-policy.js";

const AUDIT_STAGE = "AUDIT_CLAIMS" as const;
const MODEL_IDEMPOTENCY_PREFIX = "model-idempotency-";

type PromptResolver = ResearchModelPromptCompilerDependencies["resolve_trusted_parameters"];

export type ResearchClaimAuditPromptDependencies = Omit<
  ResearchModelPromptCompilerDependencies,
  "resolve_trusted_parameters"
> & {
  readonly resolve_trusted_parameters: (
    input: Parameters<PromptResolver>[0],
    deployment: Parameters<PromptResolver>[1],
    audit: ResearchClaimAuditInputSnapshot,
  ) => ReturnType<PromptResolver>;
};

export interface ResearchClaimAuditStageDependencies
  extends Omit<ResearchModelStageHandlerDependencies, "operation_kind" | "prepare" | "prompt" | "expected_deployment"> {
  /** Prompt compilation remains owned by the lower model package. */
  readonly prompt: ResearchClaimAuditPromptDependencies;
  /** Reads and revalidates the committed VERIFY/freeze/source input. */
  readonly input: ResearchClaimAuditInputReader;
  /** Builds the server-owned AUDIT model intent, quote, authority and call. */
  readonly prepare: (
    input: ModelAttemptPreparationContext,
    audit: ResearchClaimAuditInputSnapshot,
  ) => Promise<ModelAttemptReservationInput>;
}

export interface ResearchClaimAuditStageHandler extends ResearchModelStageHandler {}

function inputInvalid(): never {
  return fail("WORKFLOW_INPUT_INVALID");
}

function authorityStale(): never {
  return fail("WORKFLOW_AUTHORITY_STALE");
}

function outputCorrupt(): never {
  return fail("WORKFLOW_OUTPUT_CORRUPT");
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameDeployment(
  left: ResearchClaimAuditInputSnapshot["verifier"]["deployment"],
  right: ResearchClaimAuditInputSnapshot["verifier"]["deployment"],
): boolean {
  return left.route_ref === right.route_ref &&
    left.route_version === right.route_version &&
    left.prompt_generation === right.prompt_generation &&
    left.schema_generation === right.schema_generation &&
    left.parameters_digest === right.parameters_digest &&
    left.pricing_snapshot_ref === right.pricing_snapshot_ref;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function bindPolicy(value: ResearchClaimAuditInputSnapshot): ResearchClaimAuditInputSnapshot {
  try {
    return Object.freeze({ ...value, audit_policy: parseResearchClaimAuditPolicy(value.audit_policy) });
  } catch {
    return inputInvalid();
  }
}

function requestDigest(request: StageRequest): Promise<string> {
  return digest(new TextEncoder().encode(JSON.stringify(request)));
}

type StageHandlerInput = Parameters<WorkflowStageHandler>[0];

function snapshotStageInput(value: StageHandlerInput): StageHandlerInput {
  const request = parseRequest(value.request);
  const principal = snapshotPrincipal(value.principal);
  if (request.stage !== AUDIT_STAGE || !(value.input_bytes instanceof Uint8Array)) return inputInvalid();
  return Object.freeze({
    request,
    principal,
    input_bytes: new Uint8Array(value.input_bytes),
    attempt_ref: value.attempt_ref,
    budget_receipt_ref: value.budget_receipt_ref,
    ...(value.signal === undefined ? {} : { signal: value.signal }),
  });
}

function policyFor(audit: ResearchClaimAuditInputSnapshot): ResearchClaimAuditPolicy {
  return audit.audit_policy;
}

function assertStableAuditInput(before: ResearchClaimAuditInputSnapshot, after: ResearchClaimAuditInputSnapshot): void {
  try {
    if (before.evidence_input_sha256 !== after.evidence_input_sha256 ||
        canonicalEvidenceJson(before.verifier) !== canonicalEvidenceJson(after.verifier) ||
        canonicalEvidenceJson(policyFor(before)) !== canonicalEvidenceJson(policyFor(after)) ||
        canonicalEvidenceJson(before.request) !== canonicalEvidenceJson(after.request) ||
        canonicalEvidenceJson(before.synthesis) !== canonicalEvidenceJson(after.synthesis)) {
      return authorityStale();
    }
  } catch {
    return authorityStale();
  }
}

function assertAuditPreparation(
  context: ModelAttemptPreparationContext,
  audit: ResearchClaimAuditInputSnapshot,
  prepared: ModelAttemptReservationInput,
): void {
  const expectedPack = audit.context.stage_five.evidence_pack;
  try {
    if (context.request.operation_id !== audit.request.operation_id ||
        context.request.investigation_ref.id !== audit.request.investigation_ref.id ||
        context.request.stage !== AUDIT_STAGE ||
        prepared.call.route_ref !== audit.verifier.deployment.route_ref ||
        prepared.call.prompt_generation !== audit.verifier.deployment.prompt_generation ||
        prepared.call.schema_generation !== audit.verifier.deployment.schema_generation ||
        canonicalEvidenceJson(prepared.call.evidence_pack) !== canonicalEvidenceJson(expectedPack) ||
        !sameRef(prepared.call.evidence_pack.scope_snapshot_ref, audit.context.freeze.scope_snapshot_ref)) {
      return authorityStale();
    }
  } catch {
    return authorityStale();
  }
}

function snapshotReadback(value: ModelAttemptReadback): ModelAttemptReadback {
  let text: string;
  try { text = canonicalEvidenceJson(value); }
  catch { return outputCorrupt(); }
  try {
    const parsed = JSON.parse(text) as ModelAttemptReadback;
    if (canonicalEvidenceJson(parsed) !== text) return outputCorrupt();
    return deepFreeze(parsed);
  } catch {
    return outputCorrupt();
  }
}

async function readDurableModelAttempt(
  database: D1Database,
  audit: ResearchClaimAuditInputSnapshot,
  principal: WorkflowPrincipal,
  stageAttemptRef: string,
  stageRequestSha256: string,
  workflowBudgetReceiptRef: string,
): Promise<ModelAttemptReadback> {
  const identity = await deriveModelAttemptIdentity({
    stage_request_sha256: stageRequestSha256,
    principal_ref: principal.principal_ref,
    credential_generation: principal.credential_generation,
    deployment_generation: principal.deployment_generation,
  });
  const readback = await createModelAttemptStore(database).readByIdempotency({
    principal_ref: principal.principal_ref,
    operation_kind: "AUDIT",
    idempotency_key: identity.idempotency_key,
  });
  if (readback === null) return outputCorrupt();

  const expectedOutputObjectRef = `model-output/${identity.idempotency_key.slice(MODEL_IDEMPOTENCY_PREFIX.length)}/${stageAttemptRef}`;
  if (readback.authority.principal_ref !== principal.principal_ref ||
      readback.authority.credential_generation !== principal.credential_generation ||
      readback.authority.deployment_generation !== principal.deployment_generation ||
      !sameRef(readback.authority.scope_snapshot_ref, audit.context.freeze.scope_snapshot_ref)) {
    return authorityStale();
  }
  if (readback.intent.operation_kind !== "AUDIT" ||
      readback.intent.intent_ref.id !== identity.operation_id ||
      readback.intent.principal_ref !== principal.principal_ref ||
      readback.intent.idempotency_key !== identity.idempotency_key ||
      readback.stage_attempt_ref !== stageAttemptRef ||
      readback.stage_request_sha256 !== stageRequestSha256 ||
      readback.workflow_budget_receipt_ref !== workflowBudgetReceiptRef ||
      readback.state !== "SUCCEEDED" ||
      readback.persisted_state !== "SUCCEEDED" ||
      readback.receipt === null ||
      readback.operation_receipt === null ||
      readback.output === null ||
      readback.receipt.output_object_ref !== expectedOutputObjectRef ||
      readback.output.output_object_ref !== expectedOutputObjectRef ||
      readback.receipt.output_sha256 !== readback.output.output_sha256 ||
      readback.output.readback_sha256 !== readback.output.output_sha256 ||
      !Number.isSafeInteger(readback.output.output_size_bytes) ||
      readback.output.output_size_bytes < 0 ||
      readback.output.output_size_bytes > MAX_WORKFLOW_OUTPUT_BYTES) {
    return outputCorrupt();
  }
  let fingerprint;
  try {
    fingerprint = await readD1ModelGatewayFingerprint(
      database,
      readback.receipt.route_fingerprint_ref,
    );
  } catch {
    return outputCorrupt();
  }
  if (fingerprint === null) return outputCorrupt();
  if (!sameDeployment(fingerprint, audit.verifier.deployment)) return authorityStale();
  return snapshotReadback(readback);
}

function handlesFor(
  audit: ResearchClaimAuditInputSnapshot,
  refs: readonly VersionedRef[],
): TrustedSemanticClaimAuditInput["exact_support_handles"] {
  const byRef = new Map(audit.evidence.map((item) => [refKey(item.handle.handle_ref), item.handle]));
  const result = refs.map((ref) => {
    const handle = byRef.get(refKey(ref));
    if (handle === undefined) return authorityStale();
    return handle;
  });
  return Object.freeze(result);
}

function trustedAuditInputs(audit: ResearchClaimAuditInputSnapshot): readonly TrustedSemanticClaimAuditInput[] {
  const policy = policyFor(audit);
  const evidenceGrade = audit.context.stage_ten_input.protocol_profile.evidence_grade;
  const lane = audit.context.stage_ten_input.protocol_profile.lane;
  return Object.freeze(audit.claims.claims.map((claim) => ({
    claim,
    exact_support_handles: handlesFor(audit, claim.support_handle_refs),
    counterevidence_handles: handlesFor(audit, claim.counterevidence_handle_refs),
    reference_resolution_verified: true,
    semantic_verifier_qualified: audit.verifier.qualified,
    required_dimensions: policy.required_dimensions,
    source_requirement_applicable: policy.source_requirement_applicable,
    excerpt_requirement_applicable: policy.excerpt_requirement_applicable,
    evidence_grade: evidenceGrade,
    lane,
    coverage_limitations: policy.coverage_limitations,
    unsupported_precision: policy.unsupported_precision.map((item) => ({
      ...item,
      source_and_coverage_basis: [...item.source_and_coverage_basis],
    })),
  })));
}

function compactClaims(
  audit: ResearchClaimAuditInputSnapshot,
  items: readonly ClaimAuditItem[],
): readonly ResearchClaimAuditClaimInput[] {
  const normalizedById = new Map(audit.claims.claims.map((claim) => [claim.claim_ref.id, claim]));
  return Object.freeze(items.map((item) => {
    const normalized = normalizedById.get(item.claim_id);
    if (normalized === undefined) return outputCorrupt();
    return {
      claim_ref: normalized.claim_ref,
      claim_text_digest: item.claim_text_digest,
      claim_kind: item.claim_kind,
      support_handle_refs: Object.freeze([...normalized.support_handle_refs]),
      counterevidence_handle_refs: Object.freeze([...normalized.counterevidence_handle_refs]),
      reference_verification: item.reference_verification,
      value_or_measurement_verification: item.value_or_measurement_verification,
      specification_compliance: item.specification_compliance,
      method_artifact_alignment: item.method_artifact_alignment,
      source_satisfies_requirement: item.source_satisfies_requirement,
      supplied_excerpt_supports_requirement: item.supplied_excerpt_supports_requirement,
      evidence_grade: item.evidence_grade,
      lane: item.lane,
      coverage_limitations: Object.freeze([...item.coverage_limitations]),
      unsupported_precision: Object.freeze(item.unsupported_precision.map((entry) => Object.freeze({
        ...entry,
        source_and_coverage_basis: Object.freeze([...entry.source_and_coverage_basis]),
      }))),
      disposition: item.disposition,
    } satisfies ResearchClaimAuditClaimInput;
  }));
}

async function encodeAuditOutput(input: {
  readonly audit: ResearchClaimAuditInputSnapshot;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly model_attempt: ModelAttemptReadback;
  readonly model_bytes: Uint8Array;
}): Promise<Uint8Array> {
  let assistantContent: string;
  try { assistantContent = (await decodeModelGatewayBody(input.model_bytes)).assistant_content; }
  catch { return outputCorrupt(); }

  let batch;
  try {
    batch = decodeSemanticVerifierBatch(assistantContent, {
      verifier_ref: input.audit.verifier.verifier_ref,
      verifier_schema_generation: input.audit.verifier.verifier_schema_generation,
      evidence_input_sha256: input.audit.evidence_input_sha256,
      claims: input.audit.claims.claims,
    });
  } catch { return outputCorrupt(); }

  let translated: readonly ClaimAuditItem[];
  try { translated = translateSemanticVerifierBatch(batch, trustedAuditInputs(input.audit)); }
  catch { return outputCorrupt(); }

  try {
    return encodeResearchClaimAuditResult({
      audit_input: input.audit,
      stage_attempt_ref: input.stage_attempt_ref,
      stage_request_sha256: input.stage_request_sha256,
      model_attempt: input.model_attempt,
      claims: compactClaims(input.audit, translated),
    });
  } catch { return outputCorrupt(); }
}

/**
 * Composes the governed Stage14 semantic verifier call and deterministic
 * handle-only result.  The model-stage adapter remains the sole owner of W3
 * reservation, paid invocation, output binding, and raw-output recovery.
 */
export function createResearchClaimAuditStageHandler(
  dependencies: ResearchClaimAuditStageDependencies,
): ResearchClaimAuditStageHandler {
  const {
    input: auditInputReader,
    prepare: prepareAudit,
    prompt: auditPrompt,
    ...modelDependencies
  } = dependencies;

  function createModelAdapter(audit: ResearchClaimAuditInputSnapshot | null): ResearchModelStageHandler {
    return createResearchModelStageHandler({
      ...modelDependencies,
      ...(audit === null ? {} : { expected_deployment: audit.verifier.deployment }),
      prompt: {
        ...auditPrompt,
        resolve_trusted_parameters: (modelInput, deployment) => {
          if (audit === null) return authorityStale();
          return auditPrompt.resolve_trusted_parameters(modelInput, deployment, audit);
        },
      },
      operation_kind: "AUDIT",
      prepare: async (context): Promise<ModelAttemptReservationInput> => {
        if (audit === null) return authorityStale();
        const prepared = await prepareAudit(context, audit);
        assertAuditPreparation(context, audit, prepared);
        return prepared;
      },
    });
  }

  // This adapter is used only for W3 read-only recovery; its prepare closure
  // cannot be reached by recoverStartedAttempt and therefore cannot spend.
  const recoveryModel = createModelAdapter(null);

  async function handler(rawInput: StageHandlerInput): Promise<Uint8Array> {
    const input = snapshotStageInput(rawInput);
    const stageRequestSha256 = await requestDigest(input.request);
    const auditBefore = bindPolicy(await auditInputReader.read({
      request: input.request,
      principal: input.principal,
      input_bytes: input.input_bytes,
    }));
    const model = createModelAdapter(auditBefore);
    const modelBytes = new Uint8Array(await model.handler(input));
    const auditAfter = bindPolicy(await auditInputReader.read({
      request: input.request,
      principal: input.principal,
      input_bytes: input.input_bytes,
    }));
    assertStableAuditInput(auditBefore, auditAfter);
    const modelAttempt = await readDurableModelAttempt(
      modelDependencies.database,
      auditAfter,
      input.principal,
      input.attempt_ref,
      stageRequestSha256,
      input.budget_receipt_ref,
    );
    return encodeAuditOutput({
      audit: auditAfter,
      stage_attempt_ref: input.attempt_ref,
      stage_request_sha256: stageRequestSha256,
      model_attempt: modelAttempt,
      model_bytes: modelBytes,
    });
  }

  async function recoverStartedAttempt(input: WorkflowAttemptRecoveryInput): Promise<Uint8Array | null> {
    const request = parseRequest(input.request);
    if (request.stage !== AUDIT_STAGE) return inputInvalid();
    const principal = Object.freeze({
      principal_ref: input.principal_ref,
      credential_generation: input.credential_generation,
      deployment_generation: input.deployment_generation,
    });
    const stageRequestSha256 = await requestDigest(request);
    if (stageRequestSha256 !== input.request_sha256) return outputCorrupt();
    const stageInputBytes = new Uint8Array(await readWorkflowObject(
      modelDependencies.work_bucket,
      request.input_manifest,
      true,
    ));
    const auditBefore = bindPolicy(await auditInputReader.read({
      request,
      principal,
      input_bytes: stageInputBytes,
    }));
    const recoveredModelBytes = await recoveryModel.recoverStartedAttempt(Object.freeze({ ...input, request }));
    if (recoveredModelBytes === null) return null;
    const modelBytes = new Uint8Array(recoveredModelBytes);
    const auditAfter = bindPolicy(await auditInputReader.read({
      request,
      principal,
      input_bytes: stageInputBytes,
    }));
    assertStableAuditInput(auditBefore, auditAfter);
    const modelAttempt = await readDurableModelAttempt(
      modelDependencies.database,
      auditAfter,
      principal,
      input.attempt_ref,
      stageRequestSha256,
      input.budget_receipt_ref,
    );
    return encodeAuditOutput({
      audit: auditAfter,
      stage_attempt_ref: input.attempt_ref,
      stage_request_sha256: stageRequestSha256,
      model_attempt: modelAttempt,
      model_bytes: modelBytes,
    });
  }

  return Object.freeze({ handler, recoverStartedAttempt });
}
