import {
  WorkspaceMcpObservationV2Schema,
  WorkspaceMcpPlanV2Schema,
  WorkspaceMcpReceiptV2Schema,
} from "@eliotr/contracts";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import type {
  AuthenticatedRequestContext,
  RawNormalizedAdmissionRequest,
  RawNormalizedAdmissionResult,
  WorkspaceCandidateAdmissionRequest as WorkspaceCandidateAdmissionRequestDto,
} from "@eliotr/interfaces";
import type {
  WorkspaceMcpCandidateStore,
  WorkspaceMcpObservationLookup,
  WorkspaceMcpObservationLookupResult,
} from "@eliotr/cloudflare-workspace-mcp";
import type { RawCaptureReceipt } from "@eliotr/cloudflare-raw-ingest";
import { RawNormalizedAdmissionError } from "./raw-normalized-admission.js";
import {
  WorkspaceOwnerAuthorizationError,
  type WorkspaceOwnerAuthorization,
} from "./workspace-owner-authorization.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_DATE_MS = 8_640_000_000_000_000;
const GOOGLE_TRANSPORT = "gemini-mcp" as const;
const PROTOCOL = "eliotr.workspace-candidate-admission.v1" as const;

export type WorkspaceCandidateAdmissionRequest = WorkspaceCandidateAdmissionRequestDto;
export type WorkspaceCandidateAdmissionResult = RawNormalizedAdmissionResult;

export class WorkspaceCandidateAdmissionError extends RawNormalizedAdmissionError {
  public constructor(code: string, status: number, message: string, retryable = false, cause?: unknown) {
    super(code, status, message, retryable, cause);
    this.name = "WorkspaceCandidateAdmissionError";
  }
}

export interface WorkspaceCandidateAdmissionRawNormalizedPort {
  readonly admit: (
    context: AuthenticatedRequestContext,
    captureId: string,
    request: RawNormalizedAdmissionRequest,
  ) => Promise<RawNormalizedAdmissionResult>;
  readonly getStatus: (
    context: AuthenticatedRequestContext,
    captureId: string,
    admissionOperationId: string,
  ) => Promise<RawNormalizedAdmissionResult>;
}

export interface WorkspaceCandidateAdmissionDependencies {
  readonly database: D1Database;
  readonly workspaceCandidateStore: WorkspaceMcpCandidateStore;
  readonly rawNormalized: WorkspaceCandidateAdmissionRawNormalizedPort;
  readonly readCapture: (
    context: AuthenticatedRequestContext,
    captureId: string,
  ) => Promise<RawCaptureReceipt | null>;
  /** The server-selected deployment identity; it is never supplied by the request body. */
  readonly expectedDeploymentGeneration: string;
  /** The server-selected MCP profile; it is never inferred from the ledger row. */
  readonly expectedAuthProfile: "service-token" | "managed-oauth";
  /** Optional operator-installed grant for importing a different MCP principal's observation. */
  readonly ownerAuthorization?: WorkspaceOwnerAuthorization;
  readonly now?: () => number;
}

interface BindingRow {
  readonly binding_id: unknown;
  readonly principal_ref: unknown;
  readonly deployment_generation: unknown;
  readonly auth_profile: unknown;
  readonly google_transport: unknown;
  readonly idempotency_key: unknown;
  readonly plan_idempotency_key: unknown;
  readonly observation_principal_ref: unknown;
  readonly plan_id: unknown;
  readonly plan_sha256: unknown;
  readonly observation_id: unknown;
  readonly observation_receipt_sha256: unknown;
  readonly capture_id: unknown;
  readonly capture_content_sha256: unknown;
  readonly conversion_operation_id: unknown;
  readonly admission_operation_id: unknown;
  readonly state: unknown;
}

interface BindingIdentity {
  readonly binding_id: string;
  readonly principal_ref: string;
  readonly deployment_generation: string;
  readonly auth_profile: "service-token" | "managed-oauth";
  readonly google_transport: typeof GOOGLE_TRANSPORT;
  readonly idempotency_key: string;
  readonly plan_idempotency_key: string;
  readonly observation_principal_ref: string;
  readonly plan_id: string;
  readonly plan_sha256: string;
  readonly observation_id: string;
  readonly observation_receipt_sha256: string;
  readonly capture_id: string;
  readonly capture_content_sha256: string;
  readonly conversion_operation_id: string;
}

interface Binding extends BindingIdentity {
  readonly admission_operation_id: string | null;
  readonly state: "RESERVED" | "BOUND";
}

function invalid(code: string, message: string, retryable = false, cause?: unknown): never {
  throw new WorkspaceCandidateAdmissionError(code, retryable ? 503 : 409, message, retryable, cause);
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new WorkspaceCandidateAdmissionError("WORKSPACE_ADMISSION_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return value;
}

function requiredSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new WorkspaceCandidateAdmissionError("WORKSPACE_ADMISSION_STATE_INVALID", 503, `${label} is invalid`, true);
  }
  return value;
}

function requiredProfile(value: unknown, label: string): "service-token" | "managed-oauth" {
  if (value !== "service-token" && value !== "managed-oauth") {
    throw new WorkspaceCandidateAdmissionError("WORKSPACE_ADMISSION_STATE_INVALID", 503, `${label} is invalid`, true);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new WorkspaceCandidateAdmissionError("WORKSPACE_ADMISSION_STATE_INVALID", 503, `${label} is invalid`, true);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new WorkspaceCandidateAdmissionError("WORKSPACE_ADMISSION_STATE_INVALID", 503, `${label} is invalid`, true);
  }
  return parsed;
}

function clock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
    throw new WorkspaceCandidateAdmissionError("WORKSPACE_ADMISSION_CLOCK_INVALID", 503, "Workspace admission clock is invalid", true);
  }
  return value;
}

function ownerAuthorizationError(cause: unknown): never {
  if (cause instanceof WorkspaceOwnerAuthorizationError) {
    throw new WorkspaceCandidateAdmissionError(cause.code, cause.status, cause.message, cause.retryable, cause);
  }
  throw new WorkspaceCandidateAdmissionError(
    "WORKSPACE_ADMISSION_OWNER_AUTHORIZATION_UNAVAILABLE", 503,
    "workspace owner authorization is unavailable", true, cause,
  );
}

function freezeRequest(request: WorkspaceCandidateAdmissionRequest): WorkspaceCandidateAdmissionRequest {
  const observation: WorkspaceMcpObservationLookup = Object.freeze({
    principal_ref: requiredIdentifier(request.observation.principal_ref, "observation.principal_ref"),
    deployment_generation: requiredIdentifier(request.observation.deployment_generation, "observation.deployment_generation"),
    auth_profile: requiredProfile(request.observation.auth_profile, "observation.auth_profile"),
    google_transport: request.observation.google_transport === GOOGLE_TRANSPORT
      ? GOOGLE_TRANSPORT
      : invalid("WORKSPACE_ADMISSION_INPUT_INVALID", "observation.google_transport is invalid"),
    idempotency_key: requiredIdentifier(request.observation.idempotency_key, "observation.idempotency_key"),
    plan_id: requiredIdentifier(request.observation.plan_id, "observation.plan_id"),
    plan_sha256: requiredSha(request.observation.plan_sha256, "observation.plan_sha256"),
    observation_id: requiredIdentifier(request.observation.observation_id, "observation.observation_id"),
  });
  const captureId = requiredIdentifier(request.capture_id, "capture_id");
  const conversionId = requiredIdentifier(request.conversion_operation_id, "conversion_operation_id");
  const idempotencyKey = requiredIdentifier(request.idempotency_key, "idempotency_key");
  return Object.freeze({
    observation,
    capture_id: captureId,
    conversion_operation_id: conversionId,
    idempotency_key: idempotencyKey,
  });
}

function bindingFromRow(row: BindingRow): Binding {
  const state = row.state;
  if (state !== "RESERVED" && state !== "BOUND") invalid("WORKSPACE_ADMISSION_STATE_INVALID", "workspace admission binding state is invalid", true);
  const operationId = row.admission_operation_id;
  if (state === "RESERVED" && operationId !== null) invalid("WORKSPACE_ADMISSION_STATE_INVALID", "reserved workspace admission has an operation", true);
  if (state === "BOUND" && (typeof operationId !== "string" || !SHA256.test(operationId))) invalid("WORKSPACE_ADMISSION_STATE_INVALID", "bound workspace admission operation is invalid", true);
  return {
    binding_id: requiredSha(row.binding_id, "binding_id"),
    principal_ref: requiredIdentifier(row.principal_ref, "principal_ref"),
    deployment_generation: requiredIdentifier(row.deployment_generation, "deployment_generation"),
    auth_profile: requiredProfile(row.auth_profile, "auth_profile"),
    google_transport: row.google_transport === GOOGLE_TRANSPORT
      ? GOOGLE_TRANSPORT
      : invalid("WORKSPACE_ADMISSION_STATE_INVALID", "workspace admission transport is invalid", true),
    idempotency_key: requiredIdentifier(row.idempotency_key, "idempotency_key"),
    plan_idempotency_key: requiredIdentifier(row.plan_idempotency_key, "plan_idempotency_key"),
    observation_principal_ref: requiredIdentifier(row.observation_principal_ref, "observation_principal_ref"),
    plan_id: requiredIdentifier(row.plan_id, "plan_id"),
    plan_sha256: requiredSha(row.plan_sha256, "plan_sha256"),
    observation_id: requiredIdentifier(row.observation_id, "observation_id"),
    observation_receipt_sha256: requiredSha(row.observation_receipt_sha256, "observation_receipt_sha256"),
    capture_id: requiredIdentifier(row.capture_id, "capture_id"),
    capture_content_sha256: requiredSha(row.capture_content_sha256, "capture_content_sha256"),
    conversion_operation_id: requiredIdentifier(row.conversion_operation_id, "conversion_operation_id"),
    admission_operation_id: operationId as string | null,
    state,
  };
}

function sameBinding(left: BindingIdentity, right: BindingIdentity): boolean {
  return left.principal_ref === right.principal_ref &&
    left.deployment_generation === right.deployment_generation &&
    left.auth_profile === right.auth_profile &&
    left.google_transport === right.google_transport &&
    left.idempotency_key === right.idempotency_key &&
    left.plan_idempotency_key === right.plan_idempotency_key &&
    left.observation_principal_ref === right.observation_principal_ref &&
    left.plan_id === right.plan_id &&
    left.plan_sha256 === right.plan_sha256 &&
    left.observation_id === right.observation_id &&
    left.observation_receipt_sha256 === right.observation_receipt_sha256 &&
    left.capture_id === right.capture_id &&
    left.capture_content_sha256 === right.capture_content_sha256 &&
    left.conversion_operation_id === right.conversion_operation_id;
}

function observationLookup(binding: BindingIdentity): WorkspaceMcpObservationLookup {
  return Object.freeze({
    principal_ref: binding.observation_principal_ref,
    deployment_generation: binding.deployment_generation,
    auth_profile: binding.auth_profile,
    google_transport: binding.google_transport,
    idempotency_key: binding.plan_idempotency_key,
    plan_id: binding.plan_id,
    plan_sha256: binding.plan_sha256,
    observation_id: binding.observation_id,
  });
}

function sameObservationLookup(left: WorkspaceMcpObservationLookup, right: WorkspaceMcpObservationLookup): boolean {
  return left.principal_ref === right.principal_ref && left.deployment_generation === right.deployment_generation &&
    left.auth_profile === right.auth_profile && left.google_transport === right.google_transport &&
    left.idempotency_key === right.idempotency_key && left.plan_id === right.plan_id &&
    left.plan_sha256 === right.plan_sha256 && left.observation_id === right.observation_id;
}

async function validateReadback(
  result: WorkspaceMcpObservationLookupResult,
  lookup: WorkspaceMcpObservationLookup,
  expectedDeploymentGeneration: string,
  expectedAuthProfile: "service-token" | "managed-oauth",
  now: number,
  requireCurrent: boolean,
): Promise<{ readonly receiptSha: string; readonly planId: string; readonly observationId: string; readonly contentSha: string }> {
  if (result.state === "NOT_FOUND") throw new WorkspaceCandidateAdmissionError("WORKSPACE_ADMISSION_OBSERVATION_NOT_FOUND", 404, "workspace observation is not available");
  if (result.state === "UNKNOWN") invalid("WORKSPACE_ADMISSION_LEDGER_UNAVAILABLE", "workspace observation readback is uncertain", true);
  const readback = result.readback;
  const planResult = WorkspaceMcpPlanV2Schema.safeParse(readback.plan);
  const observationResult = WorkspaceMcpObservationV2Schema.safeParse(readback.observation);
  const receiptResult = WorkspaceMcpReceiptV2Schema.safeParse(readback.receipt);
  if (!planResult.success || !observationResult.success || !receiptResult.success) {
    invalid("WORKSPACE_ADMISSION_STATE_INVALID", "workspace observation readback is malformed", true);
  }
  const plan = planResult.data;
  const observation = observationResult.data;
  const receipt = receiptResult.data;
  const provenance = readback.provenance;
  if (!sameObservationLookup({
    principal_ref: provenance.principal_ref,
    deployment_generation: provenance.deployment_generation,
    auth_profile: provenance.auth_profile,
    google_transport: provenance.google_transport,
    idempotency_key: provenance.idempotency_key,
    plan_id: provenance.plan_id,
    plan_sha256: provenance.plan_sha256,
    observation_id: provenance.observation_id,
  }, lookup) ||
      plan.plan_id !== lookup.plan_id || plan.plan_sha256 !== lookup.plan_sha256 ||
      plan.deployment_generation !== expectedDeploymentGeneration || plan.auth_profile !== expectedAuthProfile ||
      observation.observation_id !== lookup.observation_id || observation.plan_id !== lookup.plan_id ||
      observation.idempotency_key !== lookup.idempotency_key || observation.plan_sha256 !== lookup.plan_sha256 ||
      observation.receipt_sha256 !== provenance.receipt_sha256 || observation.state !== "OBSERVED" ||
      observation.disposition !== "OBSERVED_MATCH" || observation.reconciliation.write_state !== "COMMITTED" ||
      observation.candidate_ledger_mutation !== "OBSERVED" || receipt.connector !== "google-workspace" ||
      receipt.readback_performed !== true || receipt.readback_payload_sha256 === undefined ||
      provenance.receipt_sha256 === undefined || provenance.observation_sha256 === undefined) {
    invalid("WORKSPACE_ADMISSION_OBSERVATION_MISMATCH", "workspace observation is not authorized for this owner", false);
  }
  const issuedAt = timestamp(provenance.issued_at, "observation.issued_at");
  const expiresAt = timestamp(provenance.expires_at, "observation.expires_at");
  const observedAt = timestamp(provenance.observed_at, "observation.observed_at");
  if (observedAt < issuedAt || observedAt >= expiresAt ||
      (requireCurrent && (issuedAt > now || observedAt > now || expiresAt <= now))) {
    invalid("WORKSPACE_ADMISSION_OBSERVATION_EXPIRED", "workspace observation is no longer current", false);
  }
  if (plan.payload_sha256 !== undefined && plan.payload_sha256 !== receipt.readback_payload_sha256) {
    invalid("WORKSPACE_ADMISSION_OBSERVATION_MISMATCH", "workspace payload digest does not match the plan", false);
  }
  const receiptSha = requiredSha(receipt.readback_payload_sha256, "observation.readback_payload_sha256");
  const storedReceiptSha = requiredSha(provenance.receipt_sha256, "observation.receipt_sha256");
  const storedObservationSha = requiredSha(provenance.observation_sha256, "observation.observation_sha256");
  if (await canonicalDigest(receipt) !== storedReceiptSha || await canonicalDigest(observation) !== storedObservationSha) {
    invalid("WORKSPACE_ADMISSION_STATE_INVALID", "workspace observation digest readback is invalid", true);
  }
  return {
    receiptSha: storedReceiptSha,
    planId: plan.plan_id,
    observationId: observation.observation_id,
    contentSha: receiptSha,
  };
}

export function createWorkspaceCandidateAdmissionService(input: WorkspaceCandidateAdmissionDependencies) {
  const now = input.now ?? Date.now;
  const expectedDeploymentGeneration = requiredIdentifier(input.expectedDeploymentGeneration, "expectedDeploymentGeneration");
  const expectedAuthProfile = requiredProfile(input.expectedAuthProfile, "expectedAuthProfile");

  async function loadBinding(bindingId: string): Promise<Binding | null> {
    let row: BindingRow | null | undefined;
    try {
      row = await input.database.prepare(
        "SELECT binding_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,plan_idempotency_key,observation_principal_ref,plan_id,plan_sha256,observation_id,observation_receipt_sha256,capture_id,capture_content_sha256,conversion_operation_id,admission_operation_id,state FROM workspace_mcp_raw_normalized_admission WHERE binding_id=?1 LIMIT 1",
      ).bind(bindingId).first<BindingRow>();
    } catch (cause) {
      invalid("WORKSPACE_ADMISSION_BINDING_UNAVAILABLE", "workspace admission binding read is unavailable", true, cause);
    }
    return row === null || row === undefined ? null : bindingFromRow(row);
  }

  async function loadBindingByIdentity(principalRef: string, idempotencyKey: string): Promise<Binding | null> {
    let row: BindingRow | null | undefined;
    try {
      row = await input.database.prepare(
        "SELECT binding_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,plan_idempotency_key,observation_principal_ref,plan_id,plan_sha256,observation_id,observation_receipt_sha256,capture_id,capture_content_sha256,conversion_operation_id,admission_operation_id,state FROM workspace_mcp_raw_normalized_admission WHERE principal_ref=?1 AND idempotency_key=?2 LIMIT 1",
      ).bind(principalRef, idempotencyKey).first<BindingRow>();
    } catch (cause) {
      invalid("WORKSPACE_ADMISSION_BINDING_UNAVAILABLE", "workspace admission binding read is unavailable", true, cause);
    }
    return row === null || row === undefined ? null : bindingFromRow(row);
  }

  async function loadBindingByOperation(principalRef: string, operationId: string): Promise<Binding | null> {
    let row: BindingRow | null | undefined;
    try {
      row = await input.database.prepare(
        "SELECT binding_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,plan_idempotency_key,observation_principal_ref,plan_id,plan_sha256,observation_id,observation_receipt_sha256,capture_id,capture_content_sha256,conversion_operation_id,admission_operation_id,state FROM workspace_mcp_raw_normalized_admission WHERE principal_ref=?1 AND admission_operation_id=?2 LIMIT 1",
      ).bind(principalRef, operationId).first<BindingRow>();
    } catch (cause) {
      invalid("WORKSPACE_ADMISSION_BINDING_UNAVAILABLE", "workspace admission binding read is unavailable", true, cause);
    }
    return row === null || row === undefined ? null : bindingFromRow(row);
  }

  async function reserveBinding(identity: BindingIdentity): Promise<Binding> {
    const createdAt = new Date(clock(now)).toISOString();
    try {
      await input.database.prepare(
        "INSERT INTO workspace_mcp_raw_normalized_admission(binding_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,plan_idempotency_key,observation_principal_ref,plan_id,plan_sha256,observation_id,observation_receipt_sha256,capture_id,capture_content_sha256,conversion_operation_id,admission_operation_id,state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,NULL,'RESERVED',?16,?16)",
      ).bind(identity.binding_id, identity.principal_ref, identity.deployment_generation, identity.auth_profile, identity.google_transport, identity.idempotency_key, identity.plan_idempotency_key, identity.observation_principal_ref, identity.plan_id, identity.plan_sha256, identity.observation_id, identity.observation_receipt_sha256, identity.capture_id, identity.capture_content_sha256, identity.conversion_operation_id, createdAt).run();
    } catch (cause) {
      const existing = await loadBindingByIdentity(identity.principal_ref, identity.idempotency_key);
      if (existing === null) invalid("WORKSPACE_ADMISSION_BINDING_UNKNOWN", "workspace admission binding outcome is uncertain", true, cause);
      if (!sameBinding(existing, identity)) invalid("WORKSPACE_ADMISSION_BINDING_CONFLICT", "idempotency key is bound to different workspace evidence", false);
      return existing;
    }
    const stored = await loadBinding(identity.binding_id);
    if (stored === null) invalid("WORKSPACE_ADMISSION_BINDING_UNKNOWN", "workspace admission binding readback is missing", true);
    if (!sameBinding(stored, identity) || stored.state !== "RESERVED") invalid("WORKSPACE_ADMISSION_BINDING_CONFLICT", "workspace admission binding changed during reservation", false);
    return stored;
  }

  async function attachOperation(binding: Binding, operationId: string): Promise<Binding> {
    if (binding.state === "BOUND") {
      if (binding.admission_operation_id !== operationId) invalid("WORKSPACE_ADMISSION_BINDING_CONFLICT", "workspace admission operation is bound to different input", false);
      return binding;
    }
    try {
      await input.database.prepare(
        "UPDATE workspace_mcp_raw_normalized_admission SET admission_operation_id=?1,state='BOUND',updated_at=?2 WHERE binding_id=?3 AND state='RESERVED' AND admission_operation_id IS NULL",
      ).bind(operationId, new Date(clock(now)).toISOString(), binding.binding_id).run();
    } catch (cause) {
      const raced = await loadBinding(binding.binding_id);
      if (raced !== null && raced.state === "BOUND" && raced.admission_operation_id === operationId) return raced;
      invalid("WORKSPACE_ADMISSION_BINDING_UNKNOWN", "workspace admission binding outcome is uncertain", true, cause);
    }
    const stored = await loadBinding(binding.binding_id);
    if (stored === null || stored.state !== "BOUND" || stored.admission_operation_id !== operationId) {
      invalid("WORKSPACE_ADMISSION_BINDING_UNKNOWN", "workspace admission operation binding readback is invalid", true);
    }
    return stored;
  }

  async function readObservation(lookup: WorkspaceMcpObservationLookup, currentNow: number, requireCurrent = true): Promise<{ readonly receiptSha: string; readonly planId: string; readonly observationId: string; readonly contentSha: string }> {
    const load = input.workspaceCandidateStore.loadObservation;
    if (load === undefined) invalid("WORKSPACE_ADMISSION_LEDGER_UNAVAILABLE", "workspace observation readback is not configured", true);
    let result: WorkspaceMcpObservationLookupResult;
    try {
      result = await load(lookup);
    } catch (cause) {
      invalid("WORKSPACE_ADMISSION_LEDGER_UNAVAILABLE", "workspace observation readback is unavailable", true, cause);
    }
    return validateReadback(result, lookup, expectedDeploymentGeneration, expectedAuthProfile, currentNow, requireCurrent);
  }

  function assertCrossPrincipalAuthorization(
    context: AuthenticatedRequestContext,
    observation: WorkspaceMcpObservationLookup,
    sourceNamespaceId: string,
    currentNow: number,
  ): void {
    if (observation.principal_ref === context.principal_ref) return;
    if (observation.deployment_generation !== expectedDeploymentGeneration || observation.auth_profile !== expectedAuthProfile) {
      throw new WorkspaceCandidateAdmissionError(
        "WORKSPACE_ADMISSION_AUTHORITY_STALE", 409,
        "workspace observation authority is no longer current",
      );
    }
    const authorization = input.ownerAuthorization;
    if (authorization === undefined) {
      invalid("WORKSPACE_ADMISSION_OWNER_AUTHORIZATION_UNAVAILABLE", "workspace owner authorization is not installed", true);
    }
    try {
      authorization.assertCurrent({
        owner_principal_ref: context.principal_ref,
        owner_credential_generation: context.credential_generation,
        mcp_principal_ref: observation.principal_ref,
        deployment_generation: observation.deployment_generation,
        auth_profile: observation.auth_profile,
        source_namespace_id: sourceNamespaceId,
      }, currentNow);
    } catch (cause) {
      ownerAuthorizationError(cause);
    }
  }

  async function captureForOwner(context: AuthenticatedRequestContext, captureId: string, expectedContentSha?: string, expectedSourceNamespace?: string): Promise<RawCaptureReceipt> {
    let capture: RawCaptureReceipt | null;
    try {
      capture = await input.readCapture(context, captureId);
    } catch (cause) {
      invalid("WORKSPACE_ADMISSION_CAPTURE_UNAVAILABLE", "owner raw capture read is unavailable", true, cause);
    }
    if (capture === null) throw new WorkspaceCandidateAdmissionError("WORKSPACE_ADMISSION_CAPTURE_NOT_FOUND", 404, "owner raw capture is not available");
    if (capture.principal_ref !== context.principal_ref || capture.capture_id !== captureId ||
        (expectedContentSha !== undefined && capture.content_sha256 !== expectedContentSha) ||
        (expectedSourceNamespace !== undefined && capture.source_namespace_id !== expectedSourceNamespace)) {
      invalid("WORKSPACE_ADMISSION_CAPTURE_MISMATCH", "owner raw capture does not match the workspace observation", false);
    }
    return capture;
  }

  async function resultFor(binding: Binding, context: AuthenticatedRequestContext): Promise<RawNormalizedAdmissionResult> {
    if (binding.admission_operation_id === null) invalid("WORKSPACE_ADMISSION_BINDING_UNKNOWN", "workspace admission operation is not bound", true);
    const result = await input.rawNormalized.getStatus(context, binding.capture_id, binding.admission_operation_id);
    if (result.capture_id !== binding.capture_id || result.conversion_operation_id !== binding.conversion_operation_id || result.admission_operation_id !== binding.admission_operation_id) {
      invalid("WORKSPACE_ADMISSION_STATE_INVALID", "raw normalized admission readback does not match the workspace binding", true);
    }
    return result;
  }

  async function resultForBound(binding: Binding, context: AuthenticatedRequestContext): Promise<RawNormalizedAdmissionResult> {
    if (binding.state !== "BOUND" || binding.admission_operation_id === null) {
      invalid("WORKSPACE_ADMISSION_BINDING_UNKNOWN", "workspace admission operation is not bound", true);
    }
    const lookup = observationLookup(binding);
    const crossPrincipal = lookup.principal_ref !== context.principal_ref;
    let expectedSourceNamespace: string | undefined;
    if (crossPrincipal) {
      const firstCapture = await captureForOwner(context, binding.capture_id, binding.capture_content_sha256);
      expectedSourceNamespace = firstCapture.source_namespace_id;
      assertCrossPrincipalAuthorization(context, lookup, expectedSourceNamespace, clock(now));
    }
    const observation = await readObservation(lookup, clock(now), false);
    const finalCapture = await captureForOwner(context, binding.capture_id, binding.capture_content_sha256, expectedSourceNamespace);
    assertCrossPrincipalAuthorization(context, lookup, finalCapture.source_namespace_id, clock(now));
    if (observation.receiptSha !== binding.observation_receipt_sha256 ||
        observation.planId !== binding.plan_id || observation.observationId !== binding.observation_id ||
        observation.contentSha !== binding.capture_content_sha256) {
      invalid("WORKSPACE_ADMISSION_BINDING_CONFLICT", "workspace admission binding no longer matches its observation", false);
    }
    return resultFor(binding, context);
  }

  async function admit(context: AuthenticatedRequestContext, request: WorkspaceCandidateAdmissionRequest): Promise<WorkspaceCandidateAdmissionResult> {
    if (context.client_class !== "owner_pwa") throw new WorkspaceCandidateAdmissionError("WORKSPACE_ADMISSION_OWNER_REQUIRED", 403, "workspace candidate admission requires an owner session");
    const frozen = freezeRequest(request);
    const crossPrincipal = frozen.observation.principal_ref !== context.principal_ref;
    const bindingId = await canonicalDigest([PROTOCOL, context.principal_ref, frozen.idempotency_key]);
    const existing = await loadBinding(bindingId);
    if (existing !== null && existing.state === "BOUND") {
      if (existing.principal_ref !== context.principal_ref || existing.deployment_generation !== expectedDeploymentGeneration ||
          existing.auth_profile !== expectedAuthProfile || existing.idempotency_key !== frozen.idempotency_key ||
          existing.observation_principal_ref !== frozen.observation.principal_ref ||
          existing.plan_idempotency_key !== frozen.observation.idempotency_key || existing.plan_id !== frozen.observation.plan_id ||
          existing.plan_sha256 !== frozen.observation.plan_sha256 || existing.observation_id !== frozen.observation.observation_id ||
          existing.capture_id !== frozen.capture_id || existing.conversion_operation_id !== frozen.conversion_operation_id) {
        invalid("WORKSPACE_ADMISSION_BINDING_CONFLICT", "idempotency key is bound to different workspace evidence", false);
      }
      return resultForBound(existing, context);
    }
    let preflightCapture: RawCaptureReceipt | undefined;
    if (crossPrincipal) {
      preflightCapture = await captureForOwner(context, frozen.capture_id);
      assertCrossPrincipalAuthorization(context, frozen.observation, preflightCapture.source_namespace_id, clock(now));
    }
    const currentNow = clock(now);
    const observation = await readObservation(frozen.observation, currentNow);
    const capture = await captureForOwner(context, frozen.capture_id, observation.contentSha, preflightCapture?.source_namespace_id);
    assertCrossPrincipalAuthorization(context, frozen.observation, capture.source_namespace_id, clock(now));
    const identity: BindingIdentity = {
      binding_id: bindingId,
      principal_ref: context.principal_ref,
      deployment_generation: expectedDeploymentGeneration,
      auth_profile: expectedAuthProfile,
      google_transport: GOOGLE_TRANSPORT,
      idempotency_key: frozen.idempotency_key,
      plan_idempotency_key: frozen.observation.idempotency_key,
      observation_principal_ref: frozen.observation.principal_ref,
      plan_id: observation.planId,
      plan_sha256: frozen.observation.plan_sha256,
      observation_id: observation.observationId,
      observation_receipt_sha256: observation.receiptSha,
      capture_id: capture.capture_id,
      capture_content_sha256: capture.content_sha256,
      conversion_operation_id: frozen.conversion_operation_id,
    };
    const binding = await reserveBinding(identity);
    if (binding.state === "BOUND") return resultForBound(binding, context);
    let admission: RawNormalizedAdmissionResult;
    try {
      admission = await input.rawNormalized.admit(context, frozen.capture_id, {
        idempotency_key: frozen.idempotency_key,
        conversion_operation_id: frozen.conversion_operation_id,
      });
    } catch (cause) {
      if (cause instanceof RawNormalizedAdmissionError) throw cause;
      throw new WorkspaceCandidateAdmissionError("WORKSPACE_ADMISSION_OUTCOME_UNKNOWN", 503, "workspace candidate admission outcome is uncertain", true, cause);
    }
    const expectedOperationId = await canonicalDigest(["eliotr.raw-normalized-admission.v1", context.principal_ref, frozen.idempotency_key]);
    if (admission.admission_operation_id !== expectedOperationId || admission.capture_id !== frozen.capture_id || admission.conversion_operation_id !== frozen.conversion_operation_id) {
      invalid("WORKSPACE_ADMISSION_STATE_INVALID", "raw normalized admission identity does not match the workspace binding", true);
    }
    const bound = await attachOperation(binding, admission.admission_operation_id);
    return resultFor(bound, context);
  }

  async function getStatus(context: AuthenticatedRequestContext, captureId: string, admissionOperationId: string): Promise<WorkspaceCandidateAdmissionResult> {
    if (context.client_class !== "owner_pwa") throw new WorkspaceCandidateAdmissionError("WORKSPACE_ADMISSION_OWNER_REQUIRED", 403, "workspace candidate admission requires an owner session");
    const cid = requiredIdentifier(captureId, "capture_id");
    const operationId = requiredSha(admissionOperationId, "admission_operation_id");
    const binding = await loadBindingByOperation(context.principal_ref, operationId);
    if (binding === null || binding.admission_operation_id !== operationId || binding.capture_id !== cid || binding.state !== "BOUND") {
      throw new WorkspaceCandidateAdmissionError("WORKSPACE_ADMISSION_NOT_FOUND", 404, "workspace candidate admission is not available");
    }
    if (binding.deployment_generation !== expectedDeploymentGeneration || binding.auth_profile !== expectedAuthProfile) {
      throw new WorkspaceCandidateAdmissionError("WORKSPACE_ADMISSION_AUTHORITY_STALE", 409, "workspace candidate admission authority is no longer current");
    }
    return resultForBound(binding, context);
  }

  return { admit, getStatus };
}
