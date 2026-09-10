import {
  IdentifierSchema,
  OperationIntentSchema,
  PolicyDecisionSchema,
  type OperationIntent,
  type PolicyDecision,
} from "@eliotr/contracts";
import {
  canonicalDigest,
  prepareIntentWithOutboxMutation,
  type PreparedIntentWithOutboxMutation,
} from "@eliotr/platform-cloudflare";
import {
  canonicalEvidenceJson,
  type EvidenceSourceAuthority,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import type { WorkflowPrincipal } from "./types.js";

export const RESEARCH_REPORT_ADMISSION_SCHEMA = "eliotr.research.report-admission.v1" as const;
export const RESEARCH_REPORT_ADMISSION_TOPIC = "research.artifact-draft" as const;
export const RESEARCH_REPORT_OUTPUT_CLASS = "private-draft" as const;
export const RESEARCH_REPORT_PURPOSE = "research-report-materialization" as const;

const SHA256 = /^[a-f0-9]{64}$/u;

export interface ResearchReportAdmissionPolicy {
  readonly schema: typeof RESEARCH_REPORT_ADMISSION_SCHEMA;
  readonly policy_ref: string;
  readonly policy_revision: number;
  readonly config_provenance_ref: string;
  readonly principal_ref: string;
  readonly client_class: "owner_pwa";
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly allowed_use: readonly string[];
  readonly disclosure_ceiling: string;
  readonly requested_output_class: typeof RESEARCH_REPORT_OUTPUT_CLASS;
  readonly purpose: typeof RESEARCH_REPORT_PURPOSE;
  readonly expires_at: string;
}

export interface ResearchReportAdmissionInput {
  readonly database: D1Database;
  readonly navigation: NavigationReadAuthority;
  readonly operation_id: string;
  readonly principal: WorkflowPrincipal;
  readonly policy: ResearchReportAdmissionPolicy | null;
  /** Server-computed canonical draft-manifest digest for the shared REPORT outbox. */
  readonly payload_sha256: string;
  readonly now?: () => number;
}

export interface ResearchReportAdmissionResult {
  readonly decision: PolicyDecision;
  readonly decision_sha256: string;
  readonly input_sha256: string;
  readonly intent: OperationIntent;
  readonly outbox_id: string;
  readonly disposition: "CREATED" | "EXISTING";
}

export type ResearchReportAdmissionErrorCode =
  | "REPORT_ADMISSION_POLICY_MISSING"
  | "REPORT_ADMISSION_INPUT_INVALID"
  | "REPORT_ADMISSION_DENIED"
  | "REPORT_ADMISSION_AUTHORITY_STALE"
  | "REPORT_ADMISSION_CONFLICT"
  | "REPORT_ADMISSION_PERSISTENCE_UNCERTAIN";

export class ResearchReportAdmissionError extends Error {
  public readonly code: ResearchReportAdmissionErrorCode;
  public readonly retryable: boolean;

  public constructor(code: ResearchReportAdmissionErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchReportAdmissionError";
    this.code = code;
    this.retryable = retryable;
  }
}

function fail(code: ResearchReportAdmissionErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new ResearchReportAdmissionError(code, message, retryable, cause);
}

function text(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) fail("REPORT_ADMISSION_INPUT_INVALID", `${label} is invalid`);
  return parsed.data;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("REPORT_ADMISSION_INPUT_INVALID", `${label} is invalid`);
  return value;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("REPORT_ADMISSION_INPUT_INVALID", `${label} is invalid`);
  return value as number;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail("REPORT_ADMISSION_INPUT_INVALID", `${label} is not canonical UTC time`);
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

function snapshot<T>(value: T, label: string): T {
  try { return Object.freeze(JSON.parse(canonicalEvidenceJson(value)) as T); }
  catch (cause) { fail("REPORT_ADMISSION_INPUT_INVALID", `${label} is not canonical`, false, cause); }
}

function validatePolicy(policy: ResearchReportAdmissionPolicy | null): ResearchReportAdmissionPolicy {
  if (policy === null) fail("REPORT_ADMISSION_POLICY_MISSING", "server REPORT policy is not installed");
  if (policy.schema !== RESEARCH_REPORT_ADMISSION_SCHEMA || policy.client_class !== "owner_pwa" ||
      policy.requested_output_class !== RESEARCH_REPORT_OUTPUT_CLASS || policy.purpose !== RESEARCH_REPORT_PURPOSE ||
      !Array.isArray(policy.allowed_use) || policy.allowed_use.length !== 1 || policy.allowed_use[0] !== "research") {
    fail("REPORT_ADMISSION_DENIED", "installed REPORT policy does not explicitly permit private research drafts");
  }
  text(policy.policy_ref, "policy_ref");
  positive(policy.policy_revision, "policy_revision");
  text(policy.config_provenance_ref, "config_provenance_ref");
  text(policy.principal_ref, "policy principal_ref");
  text(policy.policy_generation, "policy_generation");
  text(policy.policy_authority_ref, "policy_authority_ref");
  text(policy.disclosure_ceiling, "disclosure_ceiling");
  iso(policy.expires_at, "policy.expires_at");
  return snapshot(policy, "REPORT policy");
}

interface RunRow {
  readonly operation_id: unknown;
  readonly investigation_id: unknown;
  readonly current_revision: unknown;
  readonly next_stage_index: unknown;
  readonly state: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly policy_generation: unknown;
  readonly policy_authority_ref: unknown;
  readonly authorization_receipt_ref: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly purge_revision: unknown;
  readonly ledger_revision: unknown;
  readonly ledger_status: unknown;
  readonly ledger_principal_ref: unknown;
  readonly ledger_policy_generation: unknown;
  readonly ledger_policy_authority_ref: unknown;
  readonly ledger_deployment_generation: unknown;
  readonly ledger_scope_snapshot_id: unknown;
  readonly ledger_scope_snapshot_revision: unknown;
}

interface RunAuthority {
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly current_revision: number;
  readonly next_stage_index: number;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly authorization_receipt_ref: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly purge_revision: number;
}

async function readRun(database: D1Database, operationId: string, principal: WorkflowPrincipal): Promise<RunAuthority> {
  const row = await database.prepare(
    "SELECT r.operation_id,r.investigation_id,r.current_revision,r.next_stage_index,r.state,r.principal_ref," +
    "r.credential_generation,r.deployment_generation,r.policy_generation,r.policy_authority_ref,r.authorization_receipt_ref," +
    "r.scope_snapshot_id,r.scope_snapshot_revision,r.purge_revision,h.revision AS ledger_revision,h.status AS ledger_status," +
    "h.principal_ref AS ledger_principal_ref,h.policy_generation AS ledger_policy_generation," +
    "h.policy_authority_ref AS ledger_policy_authority_ref,h.deployment_generation AS ledger_deployment_generation," +
    "h.scope_snapshot_id AS ledger_scope_snapshot_id,h.scope_snapshot_revision AS ledger_scope_snapshot_revision " +
    "FROM research_workflow_run r JOIN investigation_ledger_head h ON h.investigation_id=r.investigation_id " +
    "WHERE r.operation_id=?1 AND r.principal_ref=?2 LIMIT 1",
  ).bind(operationId, principal.principal_ref).first<RunRow>();
  if (row === null) fail("REPORT_ADMISSION_AUTHORITY_STALE", "research run is missing for this principal");
  const run = {
    operation_id: text(row.operation_id, "operation_id"), investigation_id: text(row.investigation_id, "investigation_id"),
    current_revision: positive(row.current_revision, "run revision"), next_stage_index: positive(row.next_stage_index, "stage index"),
    principal_ref: text(row.principal_ref, "run principal_ref"), credential_generation: text(row.credential_generation, "credential_generation"),
    deployment_generation: text(row.deployment_generation, "deployment_generation"), policy_generation: text(row.policy_generation, "policy_generation"),
    policy_authority_ref: text(row.policy_authority_ref, "policy_authority_ref"), authorization_receipt_ref: text(row.authorization_receipt_ref, "authorization_receipt_ref"),
    scope_snapshot_id: text(row.scope_snapshot_id, "scope_snapshot_id"), scope_snapshot_revision: positive(row.scope_snapshot_revision, "scope_snapshot_revision"),
    purge_revision: Number.isSafeInteger(row.purge_revision) && (row.purge_revision as number) >= 0 ? row.purge_revision as number : -1,
  } satisfies RunAuthority;
  if (run.operation_id !== operationId || run.principal_ref !== principal.principal_ref ||
      run.credential_generation !== principal.credential_generation || run.deployment_generation !== principal.deployment_generation ||
      row.state !== "ACTIVE" || run.next_stage_index !== 17 || run.purge_revision < 0 ||
      row.ledger_revision !== run.current_revision || row.ledger_status !== "OPEN" ||
      row.ledger_principal_ref !== run.principal_ref || row.ledger_policy_generation !== run.policy_generation ||
      row.ledger_policy_authority_ref !== run.policy_authority_ref || row.ledger_deployment_generation !== run.deployment_generation ||
      row.ledger_scope_snapshot_id !== run.scope_snapshot_id || row.ledger_scope_snapshot_revision !== run.scope_snapshot_revision) {
    fail("REPORT_ADMISSION_AUTHORITY_STALE", "research run or W1 authority is not current for REPORT admission");
  }
  return run;
}

interface CurrentPolicyRow { readonly policy_generation: unknown; readonly policy_authority_ref: unknown; readonly state: unknown; }
interface CurrentDeploymentRow { readonly deployment_generation: unknown; readonly state: unknown; }

async function assertCurrentPolicyAndDeployment(database: D1Database, run: RunAuthority): Promise<void> {
  const [policy, deployment] = await Promise.all([
    database.prepare("SELECT policy_generation,policy_authority_ref,state FROM investigation_current_policy WHERE policy_generation=?1 LIMIT 1").bind(run.policy_generation).first<CurrentPolicyRow>(),
    database.prepare("SELECT deployment_generation,state FROM investigation_current_deployment WHERE deployment_generation=?1 LIMIT 1").bind(run.deployment_generation).first<CurrentDeploymentRow>(),
  ]);
  if (policy === null || policy.state !== "ACTIVE" || policy.policy_authority_ref !== run.policy_authority_ref ||
      deployment === null || deployment.state !== "ACTIVE" || deployment.deployment_generation !== run.deployment_generation) {
    fail("REPORT_ADMISSION_AUTHORITY_STALE", "current policy or deployment changed during REPORT admission");
  }
}

function sourceBinding(source: EvidenceSourceAuthority): Record<string, unknown> {
  return {
    source_revision_ref: source.source_revision_ref,
    source_owner_generation: source.source_owner_generation,
    content_sha256: source.content_sha256,
    object_residency_key_digest: source.object_residency_key_digest,
    admission_receipt_ref: source.admission_receipt_ref,
    allowed_use: [...source.allowed_use],
    disclosure_ceiling: source.disclosure_ceiling,
    admission_expires_at: source.admission_expires_at ?? null,
  };
}

function minExpiry(values: readonly string[]): string {
  const times = values.map((value) => Date.parse(value));
  if (times.some((value) => !Number.isSafeInteger(value))) fail("REPORT_ADMISSION_AUTHORITY_STALE", "REPORT expiry authority is invalid");
  return new Date(Math.min(...times)).toISOString();
}

async function assertExactSources(
  navigation: NavigationReadAuthority,
  refs: readonly string[],
  grant: Awaited<ReturnType<NavigationReadAuthority["current"]>>,
): Promise<readonly EvidenceSourceAuthority[]> {
  const sources = await navigation.sources(refs, grant);
  if (sources.length !== refs.length || canonicalEvidenceJson(sources.map((source) => source.source_revision_ref).sort()) !== canonicalEvidenceJson([...refs].sort())) {
    fail("REPORT_ADMISSION_AUTHORITY_STALE", "current navigation did not return the exact frozen admitted source set");
  }
  if (sources.some((source) => source.purge_state !== "LIVE" || !source.allowed_use.includes("research") || source.disclosure_ceiling !== grant.disclosure_ceiling)) {
    fail("REPORT_ADMISSION_AUTHORITY_STALE", "an admitted source is not currently authorized for research");
  }
  return sources;
}

interface AdmissionRow {
  readonly decision_id: unknown; readonly decision_revision: unknown; readonly decision: unknown; readonly decision_json: unknown; readonly decision_sha256: unknown;
  readonly input_json: unknown; readonly input_sha256: unknown; readonly policy_json: unknown; readonly policy_ref: unknown; readonly policy_revision: unknown;
  readonly policy_generation: unknown; readonly policy_authority_ref: unknown; readonly policy_expires_at: unknown; readonly operation_id: unknown;
  readonly intent_id: unknown; readonly intent_revision: unknown; readonly outbox_id: unknown; readonly principal_ref: unknown; readonly client_class: unknown;
  readonly credential_generation: unknown; readonly idempotency_key: unknown; readonly scope_snapshot_id: unknown; readonly scope_snapshot_revision: unknown;
  readonly scope_snapshot_digest: unknown; readonly authorization_receipt_ref: unknown; readonly deployment_generation: unknown;
  readonly source_revision_refs_json: unknown; readonly requested_output_class: unknown; readonly purpose: unknown; readonly disclosure_ceiling: unknown;
  readonly expires_at: unknown; readonly created_at: unknown;
}

async function readAdmission(database: D1Database, operationId: string, principalRef: string, idempotencyKey: string): Promise<AdmissionRow | null> {
  return database.prepare("SELECT * FROM research_report_admission WHERE operation_id=?1 AND principal_ref=?2 AND idempotency_key=?3 LIMIT 1")
    .bind(operationId, principalRef, idempotencyKey).first<AdmissionRow>();
}

function parseStoredDecision(row: AdmissionRow): { readonly decision: PolicyDecision; readonly decision_sha256: string; readonly input_sha256: string } {
  const decisionSha = digest(row.decision_sha256, "stored decision_sha256");
  const inputSha = digest(row.input_sha256, "stored input_sha256");
  if (typeof row.decision_json !== "string" || typeof row.input_json !== "string" ||
      typeof row.policy_json !== "string" || row.decision !== "ALLOW" && row.decision !== "ALLOW_WITH_MINIMIZATION") {
    fail("REPORT_ADMISSION_PERSISTENCE_UNCERTAIN", "stored REPORT admission is malformed");
  }
  try {
    const decision = PolicyDecisionSchema.parse(JSON.parse(row.decision_json));
    if (decision.decision !== row.decision || canonicalEvidenceJson(JSON.parse(row.decision_json)) !== row.decision_json) {
      fail("REPORT_ADMISSION_PERSISTENCE_UNCERTAIN", "stored REPORT decision canonical bytes differ");
    }
    return { decision, decision_sha256: decisionSha, input_sha256: inputSha };
  } catch (cause) {
    fail("REPORT_ADMISSION_PERSISTENCE_UNCERTAIN", "stored REPORT decision is invalid", false, cause);
  }
}

async function exactReadback(
  database: D1Database,
  expected: {
    readonly row: AdmissionRow;
    readonly decision: PolicyDecision;
    readonly decision_sha256: string;
    readonly input_sha256: string;
    readonly intent: OperationIntent;
    readonly plan: PreparedIntentWithOutboxMutation;
    readonly policy: ResearchReportAdmissionPolicy;
    readonly policyJson: string;
    readonly inputJson: string;
    readonly run: RunAuthority;
    readonly scopeSnapshotDigest: string;
    readonly sourceRefsJson: string;
    readonly disclosureCeiling: string;
    readonly expiry: string;
  },
): Promise<ResearchReportAdmissionResult> {
  const row = expected.row;
  if (row.decision_id !== expected.decision.decision_id || row.decision_revision !== 1 || row.decision !== expected.decision.decision ||
      row.decision_sha256 !== expected.decision_sha256 || row.input_sha256 !== expected.input_sha256 || row.policy_ref !== expected.policy.policy_ref ||
      row.decision_json !== canonicalEvidenceJson(expected.decision) || row.policy_json !== expected.policyJson || row.input_json !== expected.inputJson ||
      row.policy_revision !== expected.policy.policy_revision || row.policy_generation !== expected.run.policy_generation ||
      row.policy_authority_ref !== expected.run.policy_authority_ref || row.operation_id !== expected.run.operation_id ||
      row.intent_id !== expected.intent.intent_ref.id || row.intent_revision !== expected.intent.intent_ref.revision ||
      row.principal_ref !== expected.intent.principal_ref || row.client_class !== "owner_pwa" || row.credential_generation !== expected.run.credential_generation ||
      row.idempotency_key !== expected.intent.idempotency_key || row.scope_snapshot_id !== expected.run.scope_snapshot_id ||
      row.scope_snapshot_revision !== expected.run.scope_snapshot_revision || row.scope_snapshot_digest !== expected.scopeSnapshotDigest ||
      row.authorization_receipt_ref !== expected.run.authorization_receipt_ref || row.deployment_generation !== expected.run.deployment_generation ||
      row.source_revision_refs_json !== expected.sourceRefsJson || row.requested_output_class !== RESEARCH_REPORT_OUTPUT_CLASS ||
      row.purpose !== RESEARCH_REPORT_PURPOSE || row.disclosure_ceiling !== expected.disclosureCeiling ||
      row.policy_expires_at !== expected.policy.expires_at || row.expires_at !== expected.expiry || row.intent_id !== expected.plan.intent_ref.id ||
      row.outbox_id !== expected.plan.outbox_id) {
    fail("REPORT_ADMISSION_CONFLICT", "stored REPORT admission differs from the current server authority");
  }
  const existingIntent = await expected.plan.readback();
  if (existingIntent === null || existingIntent.intent_ref.id !== expected.intent.intent_ref.id || existingIntent.outbox_id !== expected.plan.outbox_id) {
    fail("REPORT_ADMISSION_PERSISTENCE_UNCERTAIN", "REPORT intent/outbox readback is missing");
  }
  return { decision: expected.decision, decision_sha256: expected.decision_sha256, input_sha256: expected.input_sha256, intent: expected.intent, outbox_id: expected.plan.outbox_id, disposition: "EXISTING" };
}

export async function admitResearchReport(input: ResearchReportAdmissionInput): Promise<ResearchReportAdmissionResult> {
  const policy = validatePolicy(input.policy);
  const operationId = text(input.operation_id, "operation_id");
  const payloadSha = digest(input.payload_sha256, "payload_sha256");
  if (input.navigation.access.principal_ref !== input.principal.principal_ref || input.navigation.access.client_class !== "owner_pwa" ||
      input.navigation.access.credential_generation !== input.principal.credential_generation) {
    fail("REPORT_ADMISSION_AUTHORITY_STALE", "navigation access is not bound to the authenticated owner");
  }
  const clock = input.now ?? Date.now;
  const nowMs = clock();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("REPORT_ADMISSION_INPUT_INVALID", "REPORT admission clock is invalid");
  const now = new Date(nowMs).toISOString();
  const run = await readRun(input.database, operationId, input.principal);
  if (policy.principal_ref !== run.principal_ref || policy.policy_generation !== run.policy_generation || policy.policy_authority_ref !== run.policy_authority_ref) {
    fail("REPORT_ADMISSION_DENIED", "installed REPORT policy is not configured for this owner run");
  }
  if (input.navigation.scope.snapshot_id !== run.scope_snapshot_id || input.navigation.scope.revision !== run.scope_snapshot_revision ||
      input.navigation.scope.policy_authority_ref !== run.policy_authority_ref) {
    fail("REPORT_ADMISSION_AUTHORITY_STALE", "navigation scope is not the run's frozen scope");
  }
  const grant = await input.navigation.current();
  if (!grant.allowed_use.includes("research") || grant.disclosure_ceiling !== policy.disclosure_ceiling || Date.parse(grant.expires_at) <= nowMs || Date.parse(policy.expires_at) <= nowMs) {
    fail("REPORT_ADMISSION_DENIED", "current scope grant does not permit the configured private REPORT policy");
  }
  const refs = [...input.navigation.scope.member_source_revision_refs];
  const sources = await assertExactSources(input.navigation, refs, grant);
  const afterGrant = await input.navigation.current();
  const afterSources = await assertExactSources(input.navigation, refs, afterGrant);
  if (!sameJson(grant, afterGrant) || !sameJson(sources.map(sourceBinding), afterSources.map(sourceBinding))) {
    fail("REPORT_ADMISSION_AUTHORITY_STALE", "scope or admitted source authority changed during REPORT admission");
  }
  const finalRun = await readRun(input.database, operationId, input.principal);
  await assertCurrentPolicyAndDeployment(input.database, finalRun);
  if (!sameJson(run, finalRun) || policy.disclosure_ceiling !== afterGrant.disclosure_ceiling || Date.parse(policy.expires_at) <= nowMs) {
    fail("REPORT_ADMISSION_AUTHORITY_STALE", "run authority changed during REPORT admission");
  }
  const expiry = minExpiry([policy.expires_at, input.navigation.scope.expires_at, afterGrant.expires_at, ...afterSources.flatMap((source) => source.admission_expires_at === undefined ? [] : [source.admission_expires_at])]);
  if (Date.parse(expiry) <= nowMs) fail("REPORT_ADMISSION_DENIED", "configured REPORT policy is expired");
  const policyJson = canonicalEvidenceJson(policy);
  const policyDigest = await canonicalDigest(policy);
  const sourceRefsJson = canonicalEvidenceJson(refs);
  const inputMaterial = {
    schema: RESEARCH_REPORT_ADMISSION_SCHEMA, operation_id: finalRun.operation_id, investigation_id: finalRun.investigation_id,
    workflow_revision: finalRun.current_revision, principal_ref: finalRun.principal_ref, client_class: "owner_pwa",
    credential_generation: finalRun.credential_generation, deployment_generation: finalRun.deployment_generation,
    policy_generation: finalRun.policy_generation, policy_authority_ref: finalRun.policy_authority_ref,
    authorization_receipt_ref: afterGrant.authorization_receipt_ref, scope_snapshot_ref: { id: finalRun.scope_snapshot_id, revision: finalRun.scope_snapshot_revision },
    scope_snapshot_digest: input.navigation.scope.digest, source_bindings: afterSources.map(sourceBinding), policy_ref: policy.policy_ref,
    policy_revision: policy.policy_revision, policy_digest: policyDigest, requested_output_class: RESEARCH_REPORT_OUTPUT_CLASS,
    purpose: RESEARCH_REPORT_PURPOSE, disclosure_ceiling: afterGrant.disclosure_ceiling, expires_at: expiry, payload_sha256: payloadSha,
  } as const;
  const inputJson = canonicalEvidenceJson(inputMaterial);
  const inputSha = await canonicalDigest(inputMaterial);
  const decisionId = `report-decision-${inputSha}`;
  const decision = PolicyDecisionSchema.parse({
    decision_id: decisionId, policy_revision: policy.policy_revision, decision: "ALLOW",
    reason_codes: ["REPORT_PRIVATE_DRAFT_POLICY_ALLOWED"], admitted_source_revision_refs: refs,
    denied_source_revision_refs: [], output_disclosure_ceiling: afterGrant.disclosure_ceiling, expires_at: expiry,
  });
  const decisionJson = canonicalEvidenceJson(decision);
  const decisionSha = await canonicalDigest(decision);
  const intent: OperationIntent = OperationIntentSchema.parse({
    intent_ref: { id: `report-intent-${operationId}`, revision: 1 }, operation_kind: "REPORT", principal_ref: finalRun.principal_ref,
    idempotency_key: `report-materialize-${operationId}`, payload_ref: `report-materialize-${operationId}`,
    policy_decision_ref: decisionId, cancellation_ref: `workflow:${operationId}`, created_at: now,
  });
  const plan = await prepareIntentWithOutboxMutation(input.database, { intent, topic: RESEARCH_REPORT_ADMISSION_TOPIC, payload_sha256: payloadSha });
  const existing = await readAdmission(input.database, finalRun.operation_id, finalRun.principal_ref, intent.idempotency_key);
  if (existing !== null) {
    const parsed = parseStoredDecision(existing);
    return exactReadback(input.database, {
      row: existing, decision: parsed.decision, decision_sha256: parsed.decision_sha256, input_sha256: parsed.input_sha256,
      intent, plan, policy, policyJson, inputJson, run: finalRun, scopeSnapshotDigest: input.navigation.scope.digest,
      sourceRefsJson, disclosureCeiling: afterGrant.disclosure_ceiling, expiry,
    });
  }
  const decisionStatement = input.database.prepare(
    "INSERT INTO research_report_admission(decision_id,decision_revision,decision,decision_json,decision_sha256,input_json,input_sha256,policy_json,policy_ref,policy_revision,policy_generation,policy_authority_ref,policy_expires_at,operation_id,intent_id,intent_revision,outbox_id,principal_ref,client_class,credential_generation,idempotency_key,scope_snapshot_id,scope_snapshot_revision,scope_snapshot_digest,authorization_receipt_ref,deployment_generation,source_revision_refs_json,requested_output_class,purpose,disclosure_ceiling,expires_at,created_at) " +
    "VALUES (?1,1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,1,?15,?16,'owner_pwa',?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29)",
  ).bind(decisionId, decision.decision, decisionJson, decisionSha, inputJson, inputSha, policyJson, policy.policy_ref, policy.policy_revision,
    finalRun.policy_generation, finalRun.policy_authority_ref, policy.expires_at, finalRun.operation_id, intent.intent_ref.id, plan.outbox_id, finalRun.principal_ref,
    finalRun.credential_generation, intent.idempotency_key, finalRun.scope_snapshot_id, finalRun.scope_snapshot_revision, input.navigation.scope.digest,
    afterGrant.authorization_receipt_ref, finalRun.deployment_generation, sourceRefsJson, RESEARCH_REPORT_OUTPUT_CLASS, RESEARCH_REPORT_PURPOSE,
    afterGrant.disclosure_ceiling, expiry, now);
  try {
    const results = await input.database.batch([...plan.statements, decisionStatement]);
    if (results.length !== 3 || results.some((result) => (result.meta?.changes ?? 0) !== 1)) fail("REPORT_ADMISSION_PERSISTENCE_UNCERTAIN", "REPORT admission batch did not commit exactly three rows", true);
  } catch (cause) {
    const raced = await readAdmission(input.database, finalRun.operation_id, finalRun.principal_ref, intent.idempotency_key);
    if (raced !== null) {
      const parsed = parseStoredDecision(raced);
      return exactReadback(input.database, {
        row: raced, decision: parsed.decision, decision_sha256: parsed.decision_sha256, input_sha256: parsed.input_sha256,
        intent, plan, policy, policyJson, inputJson, run: finalRun, scopeSnapshotDigest: input.navigation.scope.digest,
        sourceRefsJson, disclosureCeiling: afterGrant.disclosure_ceiling, expiry,
      });
    }
    if (cause instanceof ResearchReportAdmissionError) throw cause;
    fail("REPORT_ADMISSION_PERSISTENCE_UNCERTAIN", "REPORT admission batch failed", true, cause);
  }
  const stored = await readAdmission(input.database, finalRun.operation_id, finalRun.principal_ref, intent.idempotency_key);
  if (stored === null) fail("REPORT_ADMISSION_PERSISTENCE_UNCERTAIN", "REPORT admission readback is missing", true);
  const parsed = parseStoredDecision(stored);
  return exactReadback(input.database, {
    row: stored, decision: parsed.decision, decision_sha256: parsed.decision_sha256, input_sha256: parsed.input_sha256,
    intent, plan, policy, policyJson, inputJson, run: finalRun, scopeSnapshotDigest: input.navigation.scope.digest,
    sourceRefsJson, disclosureCeiling: afterGrant.disclosure_ceiling, expiry,
  });
}
