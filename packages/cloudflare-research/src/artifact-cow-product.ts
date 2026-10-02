import { VersionedRefSchema, type OperationIntent, type VersionedRef } from "@eliotr/contracts";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import type { WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import {
  ARTIFACT_SECTION_REVISE_PROTOCOL,
  ArtifactSectionReviseRequestSchema,
  type ArtifactSectionReviseAttempt,
  type ArtifactSectionReviseAuthority,
  type ArtifactSectionReviseBudgetGrant,
  type ArtifactSectionReviseRequest,
} from "@eliotr/cloudflare-workflows";
import type { ARTIFACT_SECTION_REVISE_HTTP_PROTOCOL } from "@eliotr/cloudflare-workflows";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;

/** Minimal structural contract so Core can pass its exact owner REPORT helper result. */
export interface ArtifactCowReportAdmission {
  readonly intent: OperationIntent;
  readonly outbox_id: string;
  readonly admission_witness: unknown;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly purge_revision: number;
  readonly authorization: {
    readonly authorization_receipt_ref: string;
  };
  readonly budget: ArtifactSectionReviseBudgetGrant;
  readonly requireCurrent: () => Promise<void>;
  readonly readback: () => Promise<unknown | null>;
  readonly commit: () => Promise<unknown>;
}

export interface ArtifactSectionReviseWorkflowStorePort {
  start(input: {
    readonly request: ArtifactSectionReviseRequest;
    readonly report_intent: OperationIntent;
    readonly authority: ArtifactSectionReviseAuthority;
    readonly budget: ArtifactSectionReviseBudgetGrant;
    readonly created_at: string;
    readonly attempt_ref: string;
    readonly now?: () => number;
  }): Promise<ArtifactSectionReviseAttempt>;
  read(operationId: string): Promise<ArtifactSectionReviseAttempt | null>;
}

export interface StartArtifactSectionReviseInput {
  readonly request: {
    readonly protocol: typeof ARTIFACT_SECTION_REVISE_HTTP_PROTOCOL;
    readonly artifact_ref: VersionedRef;
    readonly section_id: string;
    readonly expected_artifact_revision: number;
    readonly idempotency_key: string;
  };
  readonly report_admission: ArtifactCowReportAdmission;
  readonly principal: WorkflowPrincipal;
  readonly handler_generation: string;
  readonly store: ArtifactSectionReviseWorkflowStorePort;
  readonly now?: () => number;
}

function stale(message: string): never {
  throw new Error(`ARTIFACT_COW_REPORT_ADMISSION_INVALID: ${message}`);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) stale(`${label} is invalid`);
  return value;
}

function versionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) stale(`${label} is invalid`);
  return parsed.data;
}

/**
 * Commits the Core-prepared REPORT intent/outbox first, then persists the
 * dedicated W2 attempt with the complete immutable admission witness. It
 * performs no model or R2 effect itself.
 */
export async function startArtifactSectionReviseWorkflow(
  input: StartArtifactSectionReviseInput,
): Promise<ArtifactSectionReviseAttempt> {
  const { request, report_admission: admission, principal } = input;
  const expectedRef = VersionedRefSchema.parse(request.artifact_ref);
  const material = (admission.admission_witness as Record<string, unknown> | null)?.material;
  if (material === null || typeof material !== "object" || Array.isArray(material)) stale("full authority material is missing");
  const materialObject = material as Record<string, unknown>;
  const scopeRef = versionedRef(materialObject.scope_snapshot_ref, "admitted ScopeSnapshot");
  const freezeRef = versionedRef(materialObject.evidence_freeze_ref, "admitted EvidenceFreeze");
  const specDigest = requiredText(materialObject.spec_digest, "admitted spec digest");
  const spendPolicy = materialObject.spend_policy;
  if (spendPolicy === null || typeof spendPolicy !== "object" || Array.isArray(spendPolicy) ||
      !Array.isArray((spendPolicy as Record<string, unknown>).rules)) stale("installed REPORT spend policy is malformed");
  const policyRules = (spendPolicy as { readonly rules: readonly unknown[] }).rules;
  const ruleCosts = new Map<string, number>();
  for (const rawRule of policyRules) {
    if (rawRule === null || typeof rawRule !== "object" || Array.isArray(rawRule)) stale("installed model spend rule is malformed");
    const rule = rawRule as Record<string, unknown>;
    const quote = rule.quote;
    const maxTotal = quote !== null && typeof quote === "object" && !Array.isArray(quote)
      ? (quote as Record<string, unknown>).max_total_usd : undefined;
    if (typeof rule.stage !== "string" || quote === null || typeof quote !== "object" || Array.isArray(quote) ||
        !Number.isFinite(maxTotal) || (maxTotal as number) < 0 || ruleCosts.has(rule.stage)) stale("installed model spend rule is invalid");
    ruleCosts.set(rule.stage, maxTotal as number);
  }
  const maxTotalUsd = (ruleCosts.get("SYNTHESIZE") ?? Number.NaN) + (ruleCosts.get("AUDIT_CLAIMS") ?? Number.NaN);
  if (!/^[a-f0-9]{64}$/u.test(specDigest) ||
      materialObject.principal_ref !== principal.principal_ref ||
      materialObject.credential_generation !== principal.credential_generation ||
      materialObject.deployment_generation !== principal.deployment_generation ||
      materialObject.policy_generation !== admission.policy_generation ||
      materialObject.policy_authority_ref !== admission.policy_authority_ref ||
      materialObject.purge_revision !== admission.purge_revision ||
      !Number.isFinite(admission.budget.max_total_usd) || admission.budget.max_total_usd !== maxTotalUsd ||
      request.expected_artifact_revision !== expectedRef.revision ||
      canonicalJson(materialObject.request) !== canonicalJson(request)) {
    stale("REPORT authority does not bind the authenticated owner request, draft, or current generations");
  }
  const handlerGeneration = requiredText(input.handler_generation, "handler generation");
  const identity = await canonicalDigest({
    protocol: ARTIFACT_SECTION_REVISE_PROTOCOL,
    principal_ref: principal.principal_ref,
    request,
  });
  const operationId = `artifact-cow-run-${identity}`;
  const attemptRef = `artifact-cow-attempt-${identity}`;
  if (!IDENTIFIER.test(operationId) || !IDENTIFIER.test(attemptRef)) stale("derived W2 identity is invalid");
  const workflowRequest = ArtifactSectionReviseRequestSchema.parse({
    protocol: ARTIFACT_SECTION_REVISE_PROTOCOL,
    operation_id: operationId,
    report_intent_ref: admission.intent.intent_ref,
    report_admission_witness: admission.admission_witness,
    artifact_ref: expectedRef,
    section_id: request.section_id,
    spec_digest: specDigest,
    evidence_freeze_ref: freezeRef,
    scope_snapshot_ref: scopeRef,
    idempotency_key: request.idempotency_key,
    handler_generation: handlerGeneration,
  });
  const now = input.now ?? Date.now;
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || admission.budget.expires_at_ms <= nowMs ||
      !Number.isFinite(admission.budget.max_total_usd) || admission.budget.max_total_usd < 0) stale("REPORT budget expired before W2 admission");
  const createdAt = new Date(nowMs).toISOString();
  const authority: ArtifactSectionReviseAuthority = {
    principal_ref: principal.principal_ref,
    credential_generation: principal.credential_generation,
    deployment_generation: principal.deployment_generation,
    policy_generation: admission.policy_generation,
    policy_authority_ref: admission.policy_authority_ref,
    authorization_receipt_ref: requiredText(admission.authorization.authorization_receipt_ref, "owner authorization receipt"),
    purge_revision: admission.purge_revision,
  };
  await admission.commit();
  await admission.requireCurrent();
  const persistedIntent = await admission.readback();
  if (persistedIntent === null) stale("REPORT intent/outbox commit did not read back");
  return input.store.start({ request: workflowRequest, report_intent: admission.intent, authority,
    budget: admission.budget, created_at: createdAt, attempt_ref: attemptRef, now });
}

/** Durable status readback; caller must enforce current owner-read authority before returning it. */
export function readArtifactSectionReviseWorkflowStatus(
  store: ArtifactSectionReviseWorkflowStorePort,
  operationId: string,
): Promise<ArtifactSectionReviseAttempt | null> {
  return store.read(requiredText(operationId, "operation id"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) stale("canonical material contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return stale("canonical material contains an unsupported value");
}
