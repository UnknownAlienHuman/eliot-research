import {
  IdentifierSchema,
  OperationIntentSchema,
  PolicyDecisionSchema,
  type OperationIntent,
  type PolicyDecision,
} from "@eliotr/contracts";
import {
  canonicalDigest,
} from "@eliotr/platform-cloudflare";
import type { ArtifactDraftAdmissionMutation, ArtifactDraftAdmissionPort } from "@eliotr/cloudflare-artifacts";
import {
  canonicalEvidenceJson,
  type EvidenceSourceAuthority,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import type { StageRequest, WorkflowPrincipal } from "@eliotr/cloudflare-workflows";

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
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly policy_source: ResearchReportAdmissionPolicySource;
  readonly now?: () => number;
}

export interface ResearchReportAdmissionPolicySource {
  readonly provenance_ref: string;
  read(): Promise<ResearchReportAdmissionPolicy | null>;
}

export interface ResearchReportAdmissionPreparation {
  readonly decision: PolicyDecision;
  readonly decision_sha256: string;
  readonly intent: OperationIntent;
  readonly authority_input_sha256: string;
  readonly admission: ArtifactDraftAdmissionPort;
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

function readClock(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail("REPORT_ADMISSION_INPUT_INVALID", "REPORT admission clock is invalid");
  return value;
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

async function currentGrant(input: ResearchReportAdmissionInput): Promise<Awaited<ReturnType<NavigationReadAuthority["current"]>>> {
  try { return await input.navigation.current(); }
  catch (cause) { fail("REPORT_ADMISSION_AUTHORITY_STALE", "current scope grant is unavailable", false, cause); }
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

interface AdmissionAuthority {
  readonly run: RunAuthority;
  readonly grant: Awaited<ReturnType<NavigationReadAuthority["current"]>>;
  readonly sources: readonly EvidenceSourceAuthority[];
  readonly refs: readonly string[];
  readonly sourceRefsJson: string;
  readonly policyJson: string;
  readonly policyDigest: string;
  readonly expiry: string;
  readonly nowMs: number;
  readonly material: Record<string, unknown>;
}

interface StoredIntentOutbox {
  readonly intent: OperationIntent;
  readonly outbox_id: string;
  readonly topic: string;
  readonly payload_sha256: string;
}

async function readStoredIntent(database: D1Database, intentRef: { readonly id: string; readonly revision: number }): Promise<OperationIntent | null> {
  const row = await database.prepare(
    "SELECT intent_id,revision,operation_kind,principal_ref,idempotency_key,payload_ref,policy_decision_ref," +
    "budget_reservation_ref,cancellation_ref,created_at FROM operation_intent WHERE intent_id=?1 AND revision=?2 LIMIT 1",
  ).bind(intentRef.id, intentRef.revision).first<Record<string, unknown>>();
  if (row === null) return null;
  try {
    return OperationIntentSchema.parse({
      intent_ref: { id: row.intent_id, revision: row.revision }, operation_kind: row.operation_kind,
      principal_ref: row.principal_ref, idempotency_key: row.idempotency_key, payload_ref: row.payload_ref,
      policy_decision_ref: row.policy_decision_ref,
      ...(row.budget_reservation_ref === null ? {} : { budget_reservation_ref: row.budget_reservation_ref }),
      ...(row.cancellation_ref === null ? {} : { cancellation_ref: row.cancellation_ref }), created_at: row.created_at,
    });
  } catch (cause) {
    fail("REPORT_ADMISSION_PERSISTENCE_UNCERTAIN", "stored REPORT intent is malformed", false, cause);
  }
}

function validatePolicySource(policy: ResearchReportAdmissionPolicy | null, source: ResearchReportAdmissionPolicySource): ResearchReportAdmissionPolicy {
  const validated = validatePolicy(policy);
  if (validated.config_provenance_ref !== source.provenance_ref) {
    fail("REPORT_ADMISSION_DENIED", "REPORT policy provenance is not the installed server source");
  }
  return validated;
}

async function readAuthority(input: ResearchReportAdmissionInput, policy: ResearchReportAdmissionPolicy, nowMs: number, requestSha: string): Promise<AdmissionAuthority> {
  if (input.request.stage !== "MATERIALIZE") fail("REPORT_ADMISSION_INPUT_INVALID", "REPORT admission requires a MATERIALIZE request");
  const operationId = text(input.request.operation_id, "operation_id");
  const run = await readRun(input.database, operationId, input.principal);
  if (input.request.investigation_ref.id !== run.investigation_id || input.request.investigation_ref.revision !== run.current_revision) {
    fail("REPORT_ADMISSION_AUTHORITY_STALE", "MATERIALIZE request is not bound to the current workflow revision");
  }
  if (policy.principal_ref !== run.principal_ref || policy.policy_generation !== run.policy_generation || policy.policy_authority_ref !== run.policy_authority_ref) {
    fail("REPORT_ADMISSION_DENIED", "installed REPORT policy is not configured for this owner run");
  }
  if (input.navigation.scope.snapshot_id !== run.scope_snapshot_id || input.navigation.scope.revision !== run.scope_snapshot_revision ||
      input.navigation.scope.policy_authority_ref !== run.policy_authority_ref) {
    fail("REPORT_ADMISSION_AUTHORITY_STALE", "navigation scope is not the run's frozen scope");
  }
  const grant = await currentGrant(input);
  if (grant.authorization_receipt_ref !== run.authorization_receipt_ref || !grant.allowed_use.includes("research") ||
      grant.disclosure_ceiling !== policy.disclosure_ceiling || Date.parse(grant.expires_at) <= nowMs || Date.parse(policy.expires_at) <= nowMs) {
    fail("REPORT_ADMISSION_DENIED", "current scope grant does not permit the configured private REPORT policy");
  }
  const refs = [...input.navigation.scope.member_source_revision_refs];
  const sources = await assertExactSources(input.navigation, refs, grant);
  const afterGrant = await currentGrant(input);
  if (afterGrant.authorization_receipt_ref !== run.authorization_receipt_ref) {
    fail("REPORT_ADMISSION_AUTHORITY_STALE", "scope authorization changed during REPORT admission");
  }
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
  const material = {
    schema: RESEARCH_REPORT_ADMISSION_SCHEMA, request_sha256: requestSha, operation_id: finalRun.operation_id,
    investigation_id: finalRun.investigation_id, workflow_revision: finalRun.current_revision,
    principal_ref: finalRun.principal_ref, client_class: "owner_pwa", credential_generation: finalRun.credential_generation,
    deployment_generation: finalRun.deployment_generation, policy_generation: finalRun.policy_generation,
    policy_authority_ref: finalRun.policy_authority_ref, authorization_receipt_ref: afterGrant.authorization_receipt_ref,
    scope_snapshot_ref: { id: finalRun.scope_snapshot_id, revision: finalRun.scope_snapshot_revision },
    scope_snapshot_digest: input.navigation.scope.digest, source_bindings: afterSources.map(sourceBinding),
    policy_ref: policy.policy_ref, policy_revision: policy.policy_revision, policy_digest: policyDigest,
    requested_output_class: RESEARCH_REPORT_OUTPUT_CLASS, purpose: RESEARCH_REPORT_PURPOSE,
    disclosure_ceiling: afterGrant.disclosure_ceiling, expires_at: expiry,
  } as const;
  return { run: finalRun, grant: afterGrant, sources: afterSources, refs, sourceRefsJson, policyJson, policyDigest, expiry, nowMs, material };
}

async function readIntentOutbox(database: D1Database, intentRef: { readonly id: string; readonly revision: number }): Promise<StoredIntentOutbox | null> {
  const row = await database.prepare(
    "SELECT i.intent_id,i.revision,i.operation_kind,i.principal_ref,i.idempotency_key,i.payload_ref,i.policy_decision_ref," +
    "i.budget_reservation_ref,i.cancellation_ref,i.created_at,o.outbox_id,o.topic,o.payload_sha256 " +
    "FROM operation_intent i JOIN outbox o ON o.intent_id=i.intent_id AND o.intent_revision=i.revision " +
    "WHERE i.intent_id=?1 AND i.revision=?2 LIMIT 1",
  ).bind(intentRef.id, intentRef.revision).first<Record<string, unknown>>();
  if (row === null) return null;
  try {
    const intent = OperationIntentSchema.parse({
      intent_ref: { id: row.intent_id, revision: row.revision }, operation_kind: row.operation_kind,
      principal_ref: row.principal_ref, idempotency_key: row.idempotency_key, payload_ref: row.payload_ref,
      policy_decision_ref: row.policy_decision_ref,
      ...(row.budget_reservation_ref === null ? {} : { budget_reservation_ref: row.budget_reservation_ref }),
      ...(row.cancellation_ref === null ? {} : { cancellation_ref: row.cancellation_ref }), created_at: row.created_at,
    });
    return { intent, outbox_id: text(row.outbox_id, "stored outbox_id"), topic: text(row.topic, "stored outbox topic"), payload_sha256: digest(row.payload_sha256, "stored payload_sha256") };
  } catch (cause) {
    fail("REPORT_ADMISSION_PERSISTENCE_UNCERTAIN", "stored REPORT intent/outbox is malformed", false, cause);
  }
}

async function assertAdmissionReadback(input: {
  readonly database: D1Database;
  readonly authority: AdmissionAuthority;
  readonly policy: ResearchReportAdmissionPolicy;
  readonly decision: PolicyDecision;
  readonly decision_sha256: string;
  readonly intent: OperationIntent;
  readonly outbox_id: string;
  readonly payload_sha256: string;
  readonly input_json: string;
  readonly input_sha256: string;
}): Promise<void> {
  const row = await readAdmission(input.database, input.authority.run.operation_id, input.authority.run.principal_ref, input.intent.idempotency_key);
  if (row === null) fail("REPORT_ADMISSION_PERSISTENCE_UNCERTAIN", "REPORT admission readback is missing");
  const storedDecision = parseStoredDecision(row);
  if (row.decision_id !== input.decision.decision_id || row.decision_revision !== 1 || row.decision !== input.decision.decision ||
      row.decision_json !== canonicalEvidenceJson(input.decision) || row.decision_sha256 !== input.decision_sha256 ||
      row.input_json !== input.input_json || row.input_sha256 !== input.input_sha256 || row.policy_json !== input.authority.policyJson ||
      row.policy_ref !== input.policy.policy_ref || row.policy_revision !== input.policy.policy_revision ||
      row.policy_generation !== input.authority.run.policy_generation || row.policy_authority_ref !== input.authority.run.policy_authority_ref ||
      row.policy_expires_at !== input.policy.expires_at || row.operation_id !== input.authority.run.operation_id ||
      row.intent_id !== input.intent.intent_ref.id || row.intent_revision !== input.intent.intent_ref.revision ||
      row.outbox_id !== input.outbox_id || row.principal_ref !== input.intent.principal_ref || row.client_class !== "owner_pwa" ||
      row.credential_generation !== input.authority.run.credential_generation || row.idempotency_key !== input.intent.idempotency_key ||
      row.scope_snapshot_id !== input.authority.run.scope_snapshot_id || row.scope_snapshot_revision !== input.authority.run.scope_snapshot_revision ||
      row.scope_snapshot_digest !== input.authority.material.scope_snapshot_digest || row.authorization_receipt_ref !== input.authority.grant.authorization_receipt_ref ||
      row.deployment_generation !== input.authority.run.deployment_generation || row.source_revision_refs_json !== input.authority.sourceRefsJson ||
      row.requested_output_class !== RESEARCH_REPORT_OUTPUT_CLASS || row.purpose !== RESEARCH_REPORT_PURPOSE ||
      row.disclosure_ceiling !== input.authority.grant.disclosure_ceiling || row.expires_at !== input.authority.expiry ||
      row.created_at !== input.intent.created_at ||
      storedDecision.decision_sha256 !== input.decision_sha256) {
    fail("REPORT_ADMISSION_CONFLICT", "stored REPORT admission differs from current server authority");
  }
  const storedIntent = await readIntentOutbox(input.database, input.intent.intent_ref);
  if (storedIntent === null || !sameJson(storedIntent.intent, input.intent) || storedIntent.outbox_id !== input.outbox_id ||
      storedIntent.topic !== RESEARCH_REPORT_ADMISSION_TOPIC || storedIntent.payload_sha256 !== input.payload_sha256) {
    fail("REPORT_ADMISSION_PERSISTENCE_UNCERTAIN", "REPORT intent/outbox readback differs from the prepared admission");
  }
}

function noAdmissionBatchChanges(): void { /* Existing admission is read back before artifact effects. */ }

export async function prepareResearchReportAdmission(input: ResearchReportAdmissionInput): Promise<ResearchReportAdmissionPreparation> {
  if (input.navigation.access.principal_ref !== input.principal.principal_ref || input.navigation.access.client_class !== "owner_pwa" ||
      input.navigation.access.credential_generation !== input.principal.credential_generation) {
    fail("REPORT_ADMISSION_AUTHORITY_STALE", "navigation access is not bound to the authenticated owner");
  }
  const policyRaw = await input.policy_source.read();
  const policy = validatePolicySource(policyRaw, input.policy_source);
  const clock = input.now ?? Date.now;
  const nowMs = readClock(clock);
  const requestSha = await canonicalDigest(input.request);
  const authority = await readAuthority(input, policy, nowMs, requestSha);
  const authorityInputSha = await canonicalDigest(authority.material);
  const decisionId = `report-decision-${authorityInputSha}`;
  const decision = PolicyDecisionSchema.parse({
    decision_id: decisionId, policy_revision: policy.policy_revision, decision: "ALLOW",
    reason_codes: ["REPORT_PRIVATE_DRAFT_POLICY_ALLOWED"], admitted_source_revision_refs: authority.refs,
    denied_source_revision_refs: [], output_disclosure_ceiling: authority.grant.disclosure_ceiling, expires_at: authority.expiry,
  });
  const decisionSha = await canonicalDigest(decision);
  const createdAt = new Date(nowMs).toISOString();
  const candidateIntent: OperationIntent = OperationIntentSchema.parse({
    intent_ref: { id: `report-intent-${requestSha}`, revision: 1 }, operation_kind: "REPORT", principal_ref: authority.run.principal_ref,
    idempotency_key: input.request.idempotency_key, payload_ref: `report-materialize-${requestSha}`,
    policy_decision_ref: decisionId, cancellation_ref: `workflow:${authority.run.operation_id}`, created_at: createdAt,
  });
  const storedIntent = await readStoredIntent(input.database, candidateIntent.intent_ref);
  if (storedIntent !== null && (storedIntent.operation_kind !== candidateIntent.operation_kind ||
      storedIntent.principal_ref !== candidateIntent.principal_ref || storedIntent.idempotency_key !== candidateIntent.idempotency_key ||
      storedIntent.payload_ref !== candidateIntent.payload_ref || storedIntent.policy_decision_ref !== candidateIntent.policy_decision_ref ||
      storedIntent.cancellation_ref !== candidateIntent.cancellation_ref)) {
    fail("REPORT_ADMISSION_CONFLICT", "stored REPORT intent differs from the current request authority");
  }
  const intent = storedIntent ?? candidateIntent;
  const admission: ArtifactDraftAdmissionPort = {
    async prepare({ intent: requestedIntent, outbox_id: outboxId, payload_sha256: payloadSha }) : Promise<ArtifactDraftAdmissionMutation> {
      if (!sameJson(requestedIntent, intent)) fail("REPORT_ADMISSION_CONFLICT", "artifact draft intent differs from prepared REPORT admission");
      const currentPolicyRaw = await input.policy_source.read();
      const currentPolicy = validatePolicySource(currentPolicyRaw, input.policy_source);
      if (!sameJson(currentPolicy, policy)) fail("REPORT_ADMISSION_AUTHORITY_STALE", "REPORT policy changed before artifact commit");
      const current = await readAuthority(input, currentPolicy, readClock(clock), requestSha);
      if (await canonicalDigest(current.material) !== authorityInputSha) fail("REPORT_ADMISSION_AUTHORITY_STALE", "REPORT authority changed before artifact commit");
      const payload = digest(payloadSha, "payload_sha256");
      const inputMaterial = { ...current.material, payload_sha256: payload };
      const inputJson = canonicalEvidenceJson(inputMaterial);
      const inputSha = await canonicalDigest(inputMaterial);
      const existing = await readAdmission(input.database, current.run.operation_id, current.run.principal_ref, intent.idempotency_key);
      const readback = () => assertAdmissionReadback({ database: input.database, authority: current, policy: currentPolicy, decision, decision_sha256: decisionSha, intent, outbox_id: outboxId, payload_sha256: payload, input_json: inputJson, input_sha256: inputSha });
      if (existing !== null) {
        await readback();
        return { statements: [], assertBatchResults: noAdmissionBatchChanges, readback };
      }
      const decisionJson = canonicalEvidenceJson(decision);
      const statement = input.database.prepare(
        "INSERT INTO research_report_admission(decision_id,decision_revision,decision,decision_json,decision_sha256,input_json,input_sha256,policy_json,policy_ref,policy_revision,policy_generation,policy_authority_ref,policy_expires_at,operation_id,intent_id,intent_revision,outbox_id,principal_ref,client_class,credential_generation,idempotency_key,scope_snapshot_id,scope_snapshot_revision,scope_snapshot_digest,authorization_receipt_ref,deployment_generation,source_revision_refs_json,requested_output_class,purpose,disclosure_ceiling,expires_at,created_at) " +
        "VALUES (?1,1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,1,?15,?16,'owner_pwa',?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29)",
      ).bind(decision.decision_id, decision.decision, decisionJson, decisionSha, inputJson, inputSha, current.policyJson, currentPolicy.policy_ref, currentPolicy.policy_revision,
        current.run.policy_generation, current.run.policy_authority_ref, currentPolicy.expires_at, current.run.operation_id, intent.intent_ref.id, outboxId, current.run.principal_ref,
        current.run.credential_generation, intent.idempotency_key, current.run.scope_snapshot_id, current.run.scope_snapshot_revision, current.material.scope_snapshot_digest,
        current.grant.authorization_receipt_ref, current.run.deployment_generation, current.sourceRefsJson, RESEARCH_REPORT_OUTPUT_CLASS, RESEARCH_REPORT_PURPOSE,
        current.grant.disclosure_ceiling, current.expiry, intent.created_at);
      return {
        statements: [statement],
        assertBatchResults(results, offset) {
          if ((results[offset]?.meta?.changes ?? 0) !== 1) fail("REPORT_ADMISSION_PERSISTENCE_UNCERTAIN", "REPORT admission statement did not mutate exactly one row", true);
        },
        readback,
      };
    },
  };
  return { decision, decision_sha256: decisionSha, intent, authority_input_sha256: authorityInputSha, admission };
}
