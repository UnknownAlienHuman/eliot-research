import {
  ErasureRequestSchema,
  ErasureReceiptSchema,
  PurgeStateSchema,
  VersionedRefSchema,
  type ErasureReceipt,
  type ErasureRequest,
  type VersionedRef,
} from "@eliotr/contracts";
import type {
  AuthenticatedRequestContext,
  OwnerErasureStatus,
} from "@eliotr/interfaces";
import {
  createErasureAdmissionPolicyStore,
  ErasureAdmissionError,
  ErasureRuntimeError,
  assertErasureIdentifier,
  assertErasureInteger,
  assertErasureSha256,
  canonicalErasureJson,
  erasureFail,
  erasureSha256Utf8,
  validateErasureRequest,
} from "@eliotr/cloudflare-erasure";
import type { Env } from "./env.js";

interface AdmissionRow {
  readonly erasure_id: unknown;
  readonly erasure_revision: unknown;
  readonly permission_ref: unknown;
  readonly permission_revision: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly permission_sha256: unknown;
  readonly request_json: unknown;
  readonly request_sha256: unknown;
}

interface ExecutionRow {
  readonly request_json: unknown;
  readonly request_sha256: unknown;
  readonly state: unknown;
  readonly terminal_receipt_json: unknown;
  readonly terminal_receipt_sha256: unknown;
  readonly purge_ledger_revision: unknown;
}

interface TerminalGuardRow {
  readonly terminal_state: unknown;
  readonly receipt_sha256: unknown;
  readonly purge_ledger_revision: unknown;
  readonly verified: unknown;
}

function storageFailure(cause: unknown): never {
  if (cause instanceof ErasureRuntimeError || cause instanceof ErasureAdmissionError) {
    throw cause;
  }
  erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure status read failed", true, cause);
}

async function firstRow<T>(
  database: D1Database,
  statement: string,
  ...bindings: readonly unknown[]
): Promise<T | null> {
  try {
    const row = await database.prepare(statement).bind(...bindings).first<T>();
    return row === undefined ? null : row;
  } catch (cause) {
    return storageFailure(cause);
  }
}

function statusRef(raw: VersionedRef): VersionedRef {
  try {
    const parsed = VersionedRefSchema.parse(raw);
    return {
      id: assertErasureIdentifier(parsed.id, "erasure reference ID"),
      revision: assertErasureInteger(parsed.revision, "erasure reference revision", 1, Number.MAX_SAFE_INTEGER),
    };
  } catch (cause) {
    if (cause instanceof ErasureRuntimeError) throw cause;
    erasureFail("ERASURE_INPUT_INVALID", "erasure reference is invalid", false, cause);
  }
}

function canonicalRequest(json: unknown): ErasureRequest {
  if (typeof json !== "string") {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure request is malformed");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure request is malformed", false, cause);
  }
  if (canonicalErasureJson(raw) !== json) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure request is not canonical");
  }
  const parsed = ErasureRequestSchema.safeParse(raw);
  if (!parsed.success) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure request is invalid");
  }
  // Admission canonicalizes object keys but intentionally preserves its
  // protocol location order; validate semantics without rewriting arrays.
  validateErasureRequest(parsed.data);
  return parsed.data;
}

async function canonicalReceipt(json: unknown, digest: unknown): Promise<ErasureReceipt> {
  if (typeof json !== "string" || typeof digest !== "string") {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "terminal erasure receipt is incomplete", true);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "terminal erasure receipt is malformed", false, cause);
  }
  if (canonicalErasureJson(raw) !== json) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "terminal erasure receipt is not canonical");
  }
  const parsed = ErasureReceiptSchema.safeParse(raw);
  if (!parsed.success) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "terminal erasure receipt is invalid");
  }
  const expectedDigest = assertErasureSha256(digest, "terminal erasure receipt digest");
  if (await erasureSha256Utf8(json) !== expectedDigest) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "terminal erasure receipt digest mismatch");
  }
  return parsed.data;
}

function output(
  erasureRef: VersionedRef,
  state: OwnerErasureStatus["state"],
  receipt?: ErasureReceipt,
): OwnerErasureStatus {
  return {
    protocol: "eliotr.owner-erasure-status.v1",
    erasure_ref: erasureRef,
    state,
    ...(receipt === undefined ? {} : { receipt }),
  };
}

/** Read a previously admitted erasure without acquiring a lease or running effects. */
export async function readErasureOwnerStatus(
  env: Env,
  context: AuthenticatedRequestContext,
  rawErasureRef: VersionedRef,
): Promise<OwnerErasureStatus | null> {
  if (context.client_class !== "owner_pwa") {
    throw new ErasureAdmissionError(
      "ERASURE_PERMISSION_DENIED",
      "erasure status requires an owner session",
    );
  }
  const erasureRef = statusRef(rawErasureRef);
  const admissionRow = await firstRow<AdmissionRow>(
    env.CORE_DB,
    "SELECT erasure_id,erasure_revision,permission_ref,permission_revision,principal_ref," +
      "credential_generation,permission_sha256,request_json,request_sha256 " +
      "FROM erasure_admission_request WHERE erasure_id=?1 AND erasure_revision=?2 LIMIT 1",
    erasureRef.id,
    erasureRef.revision,
  );
  if (admissionRow === null) return null;

  const storedId = assertErasureIdentifier(admissionRow.erasure_id, "stored erasure ID");
  const storedRevision = assertErasureInteger(
    admissionRow.erasure_revision,
    "stored erasure revision",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (storedId !== erasureRef.id || storedRevision !== erasureRef.revision) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure admission identity is malformed");
  }
  const principalRef = assertErasureIdentifier(admissionRow.principal_ref, "stored admission principal");
  const credentialGeneration = assertErasureIdentifier(
    admissionRow.credential_generation,
    "stored admission credential generation",
  );
  if (
    principalRef !== context.principal_ref ||
    credentialGeneration !== context.credential_generation
  ) {
    return null;
  }
  if (typeof admissionRow.request_json !== "string") {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure admission request is malformed");
  }
  const requestSha = assertErasureSha256(admissionRow.request_sha256, "stored admission request digest");
  if (await erasureSha256Utf8(admissionRow.request_json) !== requestSha) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored admission request digest mismatch");
  }
  const request = canonicalRequest(admissionRow.request_json);
  if (
    request.erasure_ref.id !== erasureRef.id ||
    request.erasure_ref.revision !== erasureRef.revision ||
    request.requested_by_principal_ref !== principalRef
  ) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure admission request identity is inconsistent");
  }

  const permissionRef = {
    id: assertErasureIdentifier(admissionRow.permission_ref, "stored admission permission ID"),
    revision: assertErasureInteger(
      admissionRow.permission_revision,
      "stored admission permission revision",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
  const permissionSha = assertErasureSha256(
    admissionRow.permission_sha256,
    "stored admission permission digest",
  );
  let permission;
  try {
    const store = createErasureAdmissionPolicyStore({ database: env.CORE_DB });
    permission = await store.read(permissionRef);
  } catch (cause) {
    return storageFailure(cause);
  }
  if (permission === null) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "stored erasure permission readback is absent", true);
  }
  if (
    permission.policy_sha256 !== permissionSha ||
    permission.principal_ref !== principalRef ||
    permission.credential_generation !== credentialGeneration
  ) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure permission identity is inconsistent");
  }

  const executionRow = await firstRow<ExecutionRow>(
    env.CORE_DB,
    "SELECT request_json,request_sha256,state,terminal_receipt_json,terminal_receipt_sha256," +
      "purge_ledger_revision FROM erasure_execution " +
      "WHERE erasure_id=?1 AND revision=?2 LIMIT 1",
    erasureRef.id,
    erasureRef.revision,
  );
  if (executionRow === null) return output(erasureRef, "UNKNOWN");
  if (executionRow.request_json !== admissionRow.request_json || executionRow.request_sha256 !== requestSha) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "erasure execution request does not match admission");
  }
  if (executionRow.state === "FAILED") return output(erasureRef, "UNKNOWN");
  const parsedState = PurgeStateSchema.safeParse(executionRow.state);
  if (!parsedState.success) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure execution state is invalid");
  }
  const state = parsedState.data;
  if (state !== "COMPLETE" && state !== "BLOCKED") return output(erasureRef, state);

  const receipt = await canonicalReceipt(
    executionRow.terminal_receipt_json,
    executionRow.terminal_receipt_sha256,
  );
  if (
    receipt.erasure_ref.id !== erasureRef.id ||
    receipt.erasure_ref.revision !== erasureRef.revision ||
    receipt.state !== state
  ) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "terminal erasure receipt identity does not match execution");
  }
  const guard = await firstRow<TerminalGuardRow>(
    env.CORE_DB,
    "SELECT terminal_state,receipt_sha256,purge_ledger_revision,verified " +
      "FROM erasure_terminal_guard WHERE erasure_id=?1 AND erasure_revision=?2 LIMIT 1",
    erasureRef.id,
    erasureRef.revision,
  );
  if (guard === null) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "terminal erasure guard readback is absent", true);
  }
  const guardDigest = assertErasureSha256(guard.receipt_sha256, "stored terminal guard digest");
  const guardLedgerRevision = assertErasureInteger(
    guard.purge_ledger_revision,
    "stored terminal guard ledger revision",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const executionLedgerRevision = assertErasureInteger(
    executionRow.purge_ledger_revision,
    "stored erasure ledger revision",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (
    guard.terminal_state !== state ||
    guard.verified !== 1 ||
    guardDigest !== executionRow.terminal_receipt_sha256 ||
    guardLedgerRevision !== executionLedgerRevision
  ) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "terminal erasure guard does not match receipt");
  }
  return output(erasureRef, state, receipt);
}
