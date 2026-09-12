import {
  VersionedRefSchema,
  type CitationResolutionReceipt,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  assertEvidenceIdentifier,
  assertEvidenceInteger,
  assertEvidenceIso,
  assertEvidenceSha256,
} from "./canonical.js";
import {
  loadCitationSettlement,
  type CitationSettlement,
} from "./citation-attempt-registry.js";
import {
  EvidenceRuntimeError,
  type CitationResolutionAttemptBinding,
  type EvidenceAccessContext,
} from "./types.js";

type BindingRow = Readonly<Record<"operation_id" | "stage_index" | "attempt_ref" | "request_sha256" | "receipt_id" | "receipt_revision" | "receipt_sha256" | "bound_at", unknown>>;

interface ParsedBinding {
  readonly operation_id: string; readonly attempt_ref: string; readonly request_sha256: string;
  readonly receipt_id: string; readonly receipt_revision: number; readonly receipt_sha256: string; readonly bound_at: string;
}

export interface ReadBoundCitationResolutionReceiptInput {
  readonly attempt_binding: CitationResolutionAttemptBinding; readonly access: EvidenceAccessContext;
  readonly scope_snapshot_ref: VersionedRef; readonly authorization_receipt_ref: string;
}

function fail(
  code: EvidenceRuntimeError["code"],
  message: string,
  options: ConstructorParameters<typeof EvidenceRuntimeError>[2] = {},
): never {
  throw new EvidenceRuntimeError(code, message, options);
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail("EVIDENCE_INPUT_INVALID", `${label} has unexpected fields`);
  }
}

function snapshotInput(input: ReadBoundCitationResolutionReceiptInput): ReadBoundCitationResolutionReceiptInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("EVIDENCE_INPUT_INVALID", "citation receipt readback input is invalid");
  }
  try {
    exactKeys(input, ["access", "attempt_binding", "authorization_receipt_ref", "scope_snapshot_ref"], "readback input");

    const attempt = input.attempt_binding;
    if (typeof attempt !== "object" || attempt === null || Array.isArray(attempt)) {
      fail("EVIDENCE_INPUT_INVALID", "citation attempt binding is invalid");
    }
    exactKeys(attempt, ["attempt_ref", "operation_id", "request_sha256"], "citation attempt binding");
    const attemptSnapshot: CitationResolutionAttemptBinding = Object.freeze({
      operation_id: assertEvidenceIdentifier(attempt.operation_id, "attempt_binding.operation_id"),
      attempt_ref: assertEvidenceIdentifier(attempt.attempt_ref, "attempt_binding.attempt_ref"),
      request_sha256: assertEvidenceSha256(attempt.request_sha256, "attempt_binding.request_sha256"),
    });

    const access = input.access;
    if (typeof access !== "object" || access === null || Array.isArray(access)) {
      fail("EVIDENCE_INPUT_INVALID", "citation readback access is invalid");
    }
    exactKeys(access, ["client_class", "credential_generation", "principal_ref"], "citation readback access");
    if (access.client_class !== "owner_pwa" && access.client_class !== "named_api_client" &&
        access.client_class !== "trusted_agent" && access.client_class !== "federation_client") {
      fail("EVIDENCE_INPUT_INVALID", "citation readback client class is invalid");
    }
    const accessSnapshot: EvidenceAccessContext = Object.freeze({
      principal_ref: assertEvidenceIdentifier(access.principal_ref, "access.principal_ref"),
      client_class: access.client_class,
      credential_generation: assertEvidenceIdentifier(access.credential_generation, "access.credential_generation"),
    });

    const scopeSnapshot: VersionedRef = Object.freeze(VersionedRefSchema.parse(input.scope_snapshot_ref));
    const authorizationReceiptRef = assertEvidenceIdentifier(
      input.authorization_receipt_ref,
      "authorization_receipt_ref",
    );
    return Object.freeze({
      attempt_binding: attemptSnapshot,
      access: accessSnapshot,
      scope_snapshot_ref: scopeSnapshot,
      authorization_receipt_ref: authorizationReceiptRef,
    });
  } catch (cause) {
    if (cause instanceof EvidenceRuntimeError) throw cause;
    fail("EVIDENCE_INPUT_INVALID", "citation readback input failed strict validation", { cause });
  }
}

function parseBindingRow(row: BindingRow): ParsedBinding {
  try {
    const stageIndex = assertEvidenceInteger(row.stage_index, "stored citation binding stage", 15, 15);
    if (stageIndex !== 15) throw new TypeError("stored citation binding stage is not Stage15");
    return {
      operation_id: assertEvidenceIdentifier(row.operation_id, "stored citation binding operation"),
      attempt_ref: assertEvidenceIdentifier(row.attempt_ref, "stored citation binding attempt"),
      request_sha256: assertEvidenceSha256(row.request_sha256, "stored citation binding request digest"),
      receipt_id: assertEvidenceIdentifier(row.receipt_id, "stored citation binding receipt"),
      receipt_revision: assertEvidenceInteger(row.receipt_revision, "stored citation binding receipt revision", 1),
      receipt_sha256: assertEvidenceSha256(row.receipt_sha256, "stored citation binding receipt digest"),
      bound_at: assertEvidenceIso(row.bound_at, "stored citation binding timestamp"),
    };
  } catch (cause) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "stored citation workflow binding is malformed", {
      retryable: true,
      cause,
    });
  }
}

function assertBindingMatches(
  binding: ParsedBinding,
  attempt: CitationResolutionAttemptBinding,
): void {
  if (binding.operation_id !== attempt.operation_id || binding.attempt_ref !== attempt.attempt_ref ||
      binding.request_sha256 !== attempt.request_sha256) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "stored citation binding differs from the requested attempt", {
      retryable: true,
    });
  }
}

function assertSettlement(
  settlement: CitationSettlement,
  binding: ParsedBinding,
  input: ReadBoundCitationResolutionReceiptInput,
): CitationResolutionReceipt {
  if (settlement.binding === null || settlement.guard === null) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "bound citation settlement is incomplete", { retryable: true });
  }
  const storedBinding = parseBindingRow(settlement.binding);
  assertBindingMatches(storedBinding, input.attempt_binding);
  if (storedBinding.receipt_id !== binding.receipt_id ||
      storedBinding.receipt_revision !== binding.receipt_revision ||
      storedBinding.receipt_sha256 !== binding.receipt_sha256) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation binding readback changed during settlement read", {
      retryable: true,
    });
  }
  if (settlement.receipt.receipt_ref.id !== binding.receipt_id ||
      settlement.receipt.receipt_ref.revision !== binding.receipt_revision ||
      settlement.receipt_sha256 !== binding.receipt_sha256 ||
      settlement.row.scope_snapshot_id !== input.scope_snapshot_ref.id ||
      settlement.row.scope_snapshot_revision !== input.scope_snapshot_ref.revision ||
      settlement.row.principal_ref !== input.access.principal_ref ||
      settlement.row.client_class !== input.access.client_class ||
      settlement.row.credential_generation !== input.access.credential_generation ||
      settlement.row.authorization_receipt_ref !== input.authorization_receipt_ref) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "bound citation receipt authority differs from the request", {
      retryable: true,
    });
  }
  return settlement.receipt;
}

/**
 * Read one receipt through its immutable Stage15 attempt binding.
 * This performs storage identity readback only. The caller must still authorize
 * the current scope/source and perform exact R2 readback before exposing evidence.
 */
export async function readBoundCitationResolutionReceipt(
  database: D1Database,
  rawInput: ReadBoundCitationResolutionReceiptInput,
): Promise<CitationResolutionReceipt | null> {
  const input = snapshotInput(rawInput);
  let row: BindingRow | null;
  try {
    row = await database.prepare(
      "SELECT operation_id, stage_index, attempt_ref, request_sha256, receipt_id, " +
      "receipt_revision, receipt_sha256, bound_at FROM research_workflow_citation_binding " +
      "WHERE operation_id = ?1 AND stage_index = 15 LIMIT 1",
    ).bind(input.attempt_binding.operation_id).first<BindingRow>();
  } catch (cause) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation binding readback failed", {
      retryable: true,
      cause,
    });
  }
  if (row === null) return null;
  const binding = parseBindingRow(row);
  assertBindingMatches(binding, input.attempt_binding);
  let settlement: CitationSettlement | null;
  try {
    settlement = await loadCitationSettlement(
      database,
      { receipt_ref: { id: binding.receipt_id, revision: binding.receipt_revision } },
      input.attempt_binding,
    );
  } catch (cause) {
    if (cause instanceof EvidenceRuntimeError) throw cause;
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "bound citation settlement readback failed", {
      retryable: true,
      cause,
    });
  }
  if (settlement === null) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "bound citation settlement is missing", { retryable: true });
  }
  return assertSettlement(settlement, binding, input);
}
