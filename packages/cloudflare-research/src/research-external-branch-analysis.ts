import {
  ProjectClientGrantSchema,
  ResearchBranchAnalysisCheckpointSchema,
  ResearchBranchRoleSchema,
  VersionedRefSchema,
  type ProjectClientGrant,
  type ResearchBranchAnalysisCheckpoint,
  type ResearchBranchResult,
  type ResearchBranchRole,
  type ResearchPlanningManifest,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  evidenceSha256,
  type CloudflareEvidenceResolver,
} from "@eliotr/cloudflare-evidence";
import {
  ExternalAgentTaskStore,
  fail,
  publishExternalAgentTaskPayload,
  readWorkflowObject,
  textDigest,
  type ExternalAgentRecordedResult,
  type StageRequest,
  type WorkflowAttemptRecoveryInput,
  type WorkflowPrincipal,
  type WorkflowStageHandler,
  type WorkflowStartedAttemptRecovery,
} from "@eliotr/cloudflare-workflows";
import { z } from "zod";
import {
  branchResult,
  canonicalBytes,
  decodeResearchReadExtractCheckpoint,
  refKey,
  sameRef,
  uniqueSorted,
  withIdentity,
} from "./research-branch-execution-shared.js";
import {
  branchEvidence,
  loadContext,
  type BranchExecutionContext,
  type ResearchBranchExecutionDependencies,
} from "./research-branch-execution-context.js";

const TASK_KIND = "RESEARCH_BRANCH_ANALYSIS" as const;
const OUTPUT_PROTOCOL = "eliotr.external-branch-analysis.v1" as const;
const TASK_BODY_PROTOCOL = "eliotr.research.external-branch-analysis-task.v1" as const;
const TASK_LIFETIME_MS = 24 * 60 * 60 * 1000;
// Evidence text is reopened through the current evidence authority; task pull remains safely below the MCP response ceiling.
const INLINE_EXCERPT_BUDGET_BYTES = 0;
const MAX_TEXT = 8192;

const RoleOutputSchema = z.object({
  role: ResearchBranchRoleSchema,
  status: z.enum(["CANDIDATE_READY", "BLOCKED"]),
  evidence_handle_refs: z.array(VersionedRefSchema).max(512),
}).strict();

const CandidateFindingSchema = z.object({
  candidate_ref: z.string().min(1).max(256),
  locator: z.string().min(1).max(4096),
  observation: z.string().min(1).max(MAX_TEXT),
  captured_at: z.string().datetime({ offset: true }).optional(),
  admission_state: z.literal("NOT_ADMITTED"),
}).strict();

const ExecutionObservationSchema = z.object({
  contour: z.enum(["GEMINI_SPARK", "META_MUSE", "OPENAI_DOT", "OTHER"]),
  computer_scope: z.enum(["CLOUD", "LOCAL", "HYBRID", "UNKNOWN"]),
  interfaces_used: z.array(z.string().min(1).max(128)).max(32),
  observed_at: z.string().datetime({ offset: true }),
}).strict();

const ExternalBranchAnalysisOutputSchema = z.object({
  protocol: z.literal(OUTPUT_PROTOCOL),
  task_kind: z.literal(TASK_KIND),
  task_id: z.string().regex(/^external-task:[a-f0-9]{64}$/u),
  operation_id: z.string().min(1).max(128),
  stage_index: z.literal(8),
  stage: z.literal("ANALYZE_BRANCHES"),
  attempt_ref: z.string().min(1).max(128),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  roles: z.array(RoleOutputSchema).max(16),
  candidate_findings: z.array(CandidateFindingSchema).max(64),
  execution_observation: ExecutionObservationSchema,
}).strict();
type ExternalBranchAnalysisOutput = z.infer<typeof ExternalBranchAnalysisOutputSchema>;

export interface ResearchExternalBranchAnalysisDependencies extends ResearchBranchExecutionDependencies {
  readonly resolver: CloudflareEvidenceResolver;
  readonly grant: ProjectClientGrant;
  readonly now?: () => number;
}

export interface ResearchExternalBranchAnalysisHandlers {
  readonly handler: WorkflowStageHandler;
  readonly recoverStartedAttempt: WorkflowStartedAttemptRecovery;
}

function corrupt(): never { return fail("WORKFLOW_OUTPUT_CORRUPT"); }
function stale(): never { return fail("WORKFLOW_AUTHORITY_STALE"); }
function uncertain(): never { return fail("WORKFLOW_EFFECT_UNCERTAIN"); }

function requiredRoles(planning: ResearchPlanningManifest): ResearchBranchRole[] {
  return uniqueSorted(planning.required_branch_roles.map((value) => ResearchBranchRoleSchema.parse(value)));
}

function requiredAnalysisRoles(planning: ResearchPlanningManifest): ResearchBranchRole[] {
  return requiredRoles(planning).filter((role) => role !== "COUNTER");
}

function roleForQuestionKind(kind: ResearchPlanningManifest["questions"][number]["kind"]): ResearchBranchRole {
  switch (kind) {
    case "counter": return "COUNTER";
    case "alternative": return "ALTERNATIVE";
    case "chronology": return "CHRONOLOGY";
    case "implementation": return "IMPLEMENTATION";
    case "literature": return "LITERATURE";
    case "source_audit": return "SOURCE_AUDIT";
    case "primary":
    case "support": return "SUPPORT";
  }
}

function questionsForRole(planning: ResearchPlanningManifest, role: ResearchBranchRole): string[] {
  return uniqueSorted(planning.questions
    .filter((question) => roleForQuestionKind(question.kind) === role)
    .map((question) => question.question_id));
}

function hypothesesForRole(planning: ResearchPlanningManifest, role: ResearchBranchRole): string[] {
  return role === "ALTERNATIVE" ? uniqueSorted(planning.hypotheses.map((item) => item.hypothesis_id)) : [];
}

function validateReadCheckpoint(context: BranchExecutionContext, request: StageRequest, principal: WorkflowPrincipal,
  inputBytes: Uint8Array) {
  const read = decodeResearchReadExtractCheckpoint(inputBytes);
  if (read.operation_id !== request.operation_id || read.investigation_ref.id !== request.investigation_ref.id ||
      read.principal_ref !== principal.principal_ref ||
      !sameRef(read.scope_snapshot_ref, context.protocol.scope_snapshot_ref) ||
      !sameRef(read.planning_manifest_ref, context.planning.manifest_ref) ||
      read.planning_manifest_digest !== context.planning.identity_digest ||
      read.retrieval_request_digest !== context.stage_five.retrieval_request_digest) corrupt();
  return read;
}

function payloadEvidence(context: BranchExecutionContext) {
  const metadata = new Map(branchEvidence(context).map((item) => [refKey(item.handle_ref), item]));
  let remaining = INLINE_EXCERPT_BUDGET_BYTES;
  return context.stage_five.evidence_pack.resolved_evidence.map((item) => {
    const key = refKey(item.handle.handle_ref);
    const branch = metadata.get(key);
    if (branch === undefined) corrupt();
    const excerptBytes = new TextEncoder().encode(item.exact_excerpt).byteLength;
    const inline = excerptBytes <= remaining;
    if (inline) remaining -= excerptBytes;
    return Object.freeze({
      handle_ref: { ...item.handle.handle_ref },
      source_revision_ref: item.handle.source_revision_ref,
      source_id: branch.source_id,
      source_class: branch.source_class,
      source_family_ref: branch.source_family_ref,
      source_title: item.source_title ?? null,
      excerpt_sha256: item.handle.excerpt_sha256,
      excerpt_byte_length: item.handle.excerpt_byte_length,
      verification_receipt_ref: item.verification_receipt_ref,
      authorization_receipt_ref: item.authorization_receipt_ref,
      instruction_taint: item.instruction_taint,
      allowed_effects: item.allowed_effects,
      content_delivery: inline ? "INLINE" as const : "HANDLE_ONLY" as const,
      ...(inline ? { exact_excerpt: item.exact_excerpt } : {}),
    });
  });
}

function taskBody(context: BranchExecutionContext): Readonly<Record<string, unknown>> {
  return Object.freeze({
    protocol: TASK_BODY_PROTOCOL,
    objective: context.protocol.protocol_profile.question,
    intended_decision_or_artifact: context.protocol.protocol_profile.intended_decision_or_artifact,
    scope_snapshot_ref: { ...context.protocol.scope_snapshot_ref },
    inquiry_protocol_ref: { ...context.protocol.profile_definition_ref },
    planning_manifest_ref: { ...context.planning.manifest_ref },
    planning_manifest_digest: context.planning.identity_digest,
    required_roles: requiredAnalysisRoles(context.planning),
    questions: context.planning.questions.map((question) => ({ ...question,
      dependency_question_ids: [...question.dependency_question_ids] })),
    hypotheses: context.planning.hypotheses.map((hypothesis) => ({ ...hypothesis,
      alternative_hypothesis_ids: [...hypothesis.alternative_hypothesis_ids] })),
    evidence: payloadEvidence(context),
    result_contract: Object.freeze({
      protocol: OUTPUT_PROTOCOL,
      task_kind: TASK_KIND,
      required_top_level_fields: Object.freeze([
        "protocol", "task_kind", "task_id", "operation_id", "stage_index", "stage",
        "attempt_ref", "request_sha256", "roles", "candidate_findings", "execution_observation",
      ]),
      role_record_fields: Object.freeze(["role", "status", "evidence_handle_refs"]),
      candidate_finding_fields: Object.freeze([
        "candidate_ref", "locator", "observation", "captured_at(optional)", "admission_state=NOT_ADMITTED",
      ]),
      execution_observation_fields: Object.freeze([
        "contour=GEMINI_SPARK|META_MUSE|OPENAI_DOT|OTHER",
        "computer_scope=CLOUD|LOCAL|HYBRID|UNKNOWN", "interfaces_used", "observed_at",
      ]),
      rules: Object.freeze([
        "Copy task_id, operation_id, stage_index, stage, attempt_ref and request_sha256 exactly from the task envelope.",
        "Use eliotr_open with bounded byte ranges to reopen exact excerpts from supplied admitted handles.",
        "Return exactly one role record for every required role except COUNTER; COUNTER is handled by the next canonical stage.",
        "CANDIDATE_READY roles must select admitted evidence_handle_refs supplied by this task. Never invent a handle.",
        "Do not return prose in role records. Canonical unknowns, limitations and failed-probe refs are derived server-side.",
        "New browser, app, local-computer or UI observations belong only in candidate_findings with admission_state=NOT_ADMITTED.",
        "Provider or contour names are diagnostic metadata only and never confer authority.",
        "After eliotr_task_result succeeds, call the existing recover operation for this same workflow instance.",
      ]),
    }),
  });
}

function taskExpiry(grant: ProjectClientGrant, now: number): string {
  const expiry = Math.min(now + TASK_LIFETIME_MS, Date.parse(grant.expires_at));
  if (!Number.isFinite(expiry) || expiry <= now + 5_000) stale();
  return new Date(expiry).toISOString();
}

function refSet(refs: readonly VersionedRef[]): string[] {
  return refs.map(refKey).sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function currentSelectedEvidence(
  dependencies: ResearchExternalBranchAnalysisDependencies,
  context: BranchExecutionContext,
  refs: readonly VersionedRef[],
): Promise<void> {
  const admitted = new Map(context.stage_five.evidence_pack.resolved_evidence
    .map((item) => [refKey(item.handle.handle_ref), item]));
  for (const ref of refs) {
    const expected = admitted.get(refKey(ref));
    if (expected === undefined) corrupt();
    const resolved = await dependencies.resolver.resolveHandle({
      handle_ref: ref,
      expected_scope_snapshot_ref: context.protocol.scope_snapshot_ref,
      access: dependencies.navigation.access,
    });
    if (!sameRef(resolved.handle.handle_ref, expected.handle.handle_ref) ||
        !sameRef(resolved.handle.scope_snapshot_ref, context.protocol.scope_snapshot_ref) ||
        resolved.handle.source_revision_ref !== expected.handle.source_revision_ref ||
        resolved.handle.terminal_state !== "LIVE" ||
        resolved.handle.excerpt_sha256 !== expected.handle.excerpt_sha256 ||
        resolved.handle.excerpt_byte_length !== expected.handle.excerpt_byte_length ||
        resolved.exact_excerpt !== expected.exact_excerpt ||
        resolved.verification_receipt_ref !== expected.verification_receipt_ref ||
        resolved.authorization_receipt_ref !== expected.authorization_receipt_ref) corrupt();
  }
}

async function observationRefs(role: ResearchBranchRole, refs: readonly VersionedRef[], resultDigest: string): Promise<string[]> {
  return Promise.all(refs.map(async (handleRef) => `eliotr.research.observation-${await evidenceSha256({
    domain: "eliotr.research.external-branch-observation.v1",
    role,
    handle_ref: handleRef,
    result_digest: resultDigest,
  })}`));
}

async function checkpointBytes(
  dependencies: ResearchExternalBranchAnalysisDependencies,
  context: BranchExecutionContext,
  request: StageRequest,
  principal: WorkflowPrincipal,
  branchResults: readonly ResearchBranchResult[],
  createdAt: string,
): Promise<Uint8Array> {
  const read = decodeResearchReadExtractCheckpoint(
    await readWorkflowObject(dependencies.work_bucket, request.input_manifest, true),
  );
  const value = {
    protocol: "eliotr.research.branch-analysis.v1" as const,
    operation_id: request.operation_id,
    investigation_ref: { ...request.investigation_ref },
    principal_ref: principal.principal_ref,
    scope_snapshot_ref: { ...context.protocol.scope_snapshot_ref },
    inquiry_protocol_ref: { ...context.protocol.profile_definition_ref },
    protocol_digest: context.protocol.protocol_digest,
    planning_manifest_ref: { ...context.planning.manifest_ref },
    planning_manifest_digest: context.planning.identity_digest,
    read_extract_ref: read.checkpoint_ref,
    required_roles: requiredRoles(context.planning),
    branch_results: [...branchResults],
    created_at: createdAt,
  };
  const checkpoint: ResearchBranchAnalysisCheckpoint = ResearchBranchAnalysisCheckpointSchema.parse(await withIdentity(
    "eliotr.research.branch-analysis.v1",
    "eliotr.research.branch-analysis-",
    value,
  ));
  return canonicalBytes(checkpoint);
}

async function failedBranchResults(
  context: BranchExecutionContext,
  recorded: ExternalAgentRecordedResult,
  resultDigest: string,
): Promise<readonly ResearchBranchResult[]> {
  if (recorded.output !== null || recorded.evidence_refs.length !== 0 || recorded.diagnostics.length === 0) corrupt();
  const results: ResearchBranchResult[] = [];
  for (const role of requiredAnalysisRoles(context.planning)) {
    results.push(await branchResult({
      role,
      status: "BLOCKED",
      question_ids: questionsForRole(context.planning, role),
      hypothesis_ids: hypothesesForRole(context.planning, role),
      evidence_handle_refs: [],
      observation_refs: [],
      unknowns: ["External computer-agent analysis did not produce a validated branch result."],
      limitations: [
        `External task callback ${resultDigest} reported failure; its diagnostics remain quarantined in delivery metadata.`,
      ],
      failed_probe_refs: [`eliotr.research.external-agent-failure-${resultDigest}`],
      authoritative_disposition: "UNASSESSED",
    }));
  }
  return Object.freeze(results);
}

async function consumeResult(
  dependencies: ResearchExternalBranchAnalysisDependencies,
  context: BranchExecutionContext,
  request: StageRequest,
  principal: WorkflowPrincipal,
  recorded: ExternalAgentRecordedResult,
): Promise<Uint8Array> {
  if (recorded.operation_id !== request.operation_id || recorded.stage !== request.stage ||
      recorded.stage_index !== 8 || recorded.request_sha256 !== await textDigest(JSON.stringify(request))) corrupt();
  const before = await dependencies.navigation.current();
  const resultDigest = await evidenceSha256({
    domain: "eliotr.research.external-branch-result.v1",
    result: recorded,
  });
  let branchResults: readonly ResearchBranchResult[];
  if (recorded.disposition === "FAILED") {
    branchResults = await failedBranchResults(context, recorded, resultDigest);
  } else {
    if (recorded.output === null) corrupt();
    const parsed = ExternalBranchAnalysisOutputSchema.safeParse(recorded.output);
    if (!parsed.success) corrupt();
    const output = parsed.data;
    const submittedAt = Date.parse(recorded.submitted_at);
    if (!Number.isFinite(submittedAt) || Date.parse(output.execution_observation.observed_at) > submittedAt ||
        new Set(output.execution_observation.interfaces_used).size !== output.execution_observation.interfaces_used.length ||
        new Set(output.candidate_findings.map((item) => item.candidate_ref)).size !== output.candidate_findings.length ||
        output.candidate_findings.some((item) => item.captured_at !== undefined && Date.parse(item.captured_at) > submittedAt)) corrupt();
    const taskId = `external-task:${recorded.request_sha256}`;
    if (output.task_id !== taskId || output.operation_id !== request.operation_id ||
        output.attempt_ref !== recorded.attempt_ref || output.request_sha256 !== recorded.request_sha256 ||
        output.stage !== request.stage || output.stage_index !== 8) corrupt();

    const required = requiredAnalysisRoles(context.planning);
    const roles = output.roles.map((item) => item.role).sort();
    if (!sameStrings(roles, [...required].sort()) || new Set(roles).size !== roles.length) corrupt();
    for (const role of output.roles) {
      if (role.role === "COUNTER" ||
          (role.status === "CANDIDATE_READY" && role.evidence_handle_refs.length === 0 && role.role !== "SOURCE_AUDIT")) corrupt();
      const keys = refSet(role.evidence_handle_refs);
      if (new Set(keys).size !== keys.length) corrupt();
    }
    const selected = output.roles.flatMap((role) => role.evidence_handle_refs);
    const uniqueSelected = [...new Map(selected.map((ref) => [refKey(ref), ref])).values()]
      .sort((left, right) => refKey(left).localeCompare(refKey(right)));
    if (!sameStrings(refSet(uniqueSelected), refSet(recorded.evidence_refs))) corrupt();
    await currentSelectedEvidence(dependencies, context, uniqueSelected);

    const candidateLimitation = output.candidate_findings.length === 0 ? [] : [
      "Computer-use observations outside the frozen evidence set remain non-authoritative task candidates until a separate ingest/admission flow accepts them.",
    ];
    const results: ResearchBranchResult[] = [];
    for (const role of output.roles.sort((left, right) => left.role.localeCompare(right.role))) {
      const blocked = role.status === "BLOCKED";
      const limitations = uniqueSorted([
        ...candidateLimitation,
        "Arbitrary computer-agent prose remains quarantined in delivery metadata; the canonical branch contains only server-derived status text and admitted handle selections.",
        `External client reported contour ${output.execution_observation.contour}; this metadata is non-authoritative and verification/claim audit remain authoritative.`,
      ]);
      const failedProbeRefs = blocked ? [`eliotr.research.external-agent-blocked-${await evidenceSha256({
        domain: "eliotr.research.external-agent-blocked.v1",
        role: role.role,
        result_digest: resultDigest,
      })}`] : [];
      results.push(await branchResult({
        role: role.role,
        status: role.status,
        question_ids: questionsForRole(context.planning, role.role),
        hypothesis_ids: hypothesesForRole(context.planning, role.role),
        evidence_handle_refs: role.evidence_handle_refs,
        observation_refs: await observationRefs(role.role, role.evidence_handle_refs, resultDigest),
        unknowns: blocked ? ["External computer-agent analysis left this required branch unresolved."] : [],
        limitations,
        failed_probe_refs: failedProbeRefs,
        authoritative_disposition: "UNASSESSED",
      }));
    }
    branchResults = Object.freeze(results);
  }
  const bytes = await checkpointBytes(dependencies, context, request, principal, branchResults, recorded.submitted_at);
  const after = await dependencies.navigation.current();
  const finalW1 = await dependencies.ledger.read(request.investigation_ref.id);
  if (finalW1 === null || canonicalEvidenceJson(before) !== canonicalEvidenceJson(after) ||
      canonicalEvidenceJson(context.w1) !== canonicalEvidenceJson(finalW1.head)) stale();
  return bytes;
}

async function executeOrRecover(
  dependencies: ResearchExternalBranchAnalysisDependencies,
  inputValue: {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly input_bytes: Uint8Array;
    readonly attempt_ref: string;
    readonly request_sha256: string;
  },
): Promise<Uint8Array> {
  const { request, principal } = inputValue;
  if (request.stage !== "ANALYZE_BRANCHES" ||
      dependencies.navigation.access.principal_ref !== principal.principal_ref ||
      dependencies.navigation.access.credential_generation !== principal.credential_generation) stale();
  const requestText = JSON.stringify(request);
  if (await textDigest(requestText) !== inputValue.request_sha256) corrupt();
  const parsedGrant = ProjectClientGrantSchema.safeParse(dependencies.grant);
  if (!parsedGrant.success) stale();
  const grant = parsedGrant.data;
  if (grant.grantee.subject !== principal.principal_ref || grant.state !== "ACTIVE" ||
      !grant.allowed_operations.includes("run") || !grant.allowed_operations.includes("recover") ||
      !grant.allowed_operations.includes("evidence")) stale();
  const context = await loadContext(dependencies, request, principal);
  validateReadCheckpoint(context, request, principal, inputValue.input_bytes);
  const store = new ExternalAgentTaskStore(dependencies.database,
    dependencies.now === undefined ? {} : { now: dependencies.now });
  const identity = {
    operation_id: request.operation_id,
    stage_index: 8,
    attempt_ref: inputValue.attempt_ref,
    request_sha256: inputValue.request_sha256,
  } as const;
  const existing = await store.readRecordedResult(identity);
  if (existing !== null) return consumeResult(dependencies, context, request, principal, existing);

  const now = dependencies.now?.() ?? Date.now();
  const taskId = `external-task:${inputValue.request_sha256}`;
  await publishExternalAgentTaskPayload(dependencies.database, {
    envelope: {
      protocol: "eliotr.external-agent-task-payload.v1",
      task_kind: TASK_KIND,
      task_id: taskId,
      operation_id: request.operation_id,
      stage_index: 8,
      stage: "ANALYZE_BRANCHES",
      attempt_ref: inputValue.attempt_ref,
      request_sha256: inputValue.request_sha256,
      project_id: grant.project_id,
      body: taskBody(context),
    },
    expires_at: taskExpiry(grant, now),
  }, dependencies.now);
  await store.publish({ ...identity, grant });
  const settled = await store.readRecordedResult(identity);
  if (settled === null) uncertain();
  return consumeResult(dependencies, context, request, principal, settled);
}

export function createResearchExternalBranchAnalysisHandlers(
  dependencies: ResearchExternalBranchAnalysisDependencies,
): ResearchExternalBranchAnalysisHandlers {
  const handler: WorkflowStageHandler = async ({ request, principal, input_bytes, attempt_ref }) => executeOrRecover(
    dependencies,
    {
      request,
      principal,
      input_bytes,
      attempt_ref,
      request_sha256: await textDigest(JSON.stringify(request)),
    },
  );
  const recoverStartedAttempt: WorkflowStartedAttemptRecovery = async (input: WorkflowAttemptRecoveryInput) => {
    if (input.request.stage !== "ANALYZE_BRANCHES") return null;
    const bytes = await readWorkflowObject(dependencies.work_bucket, input.request.input_manifest, true);
    return executeOrRecover(dependencies, {
      request: input.request,
      principal: {
        principal_ref: input.principal_ref,
        credential_generation: input.credential_generation,
        deployment_generation: input.deployment_generation,
      },
      input_bytes: bytes,
      attempt_ref: input.attempt_ref,
      request_sha256: input.request_sha256,
    });
  };
  return Object.freeze({ handler, recoverStartedAttempt });
}
