import {
  CitationResolutionReceiptSchema,
  type CitationResolutionReceipt,
} from "@eliotr/contracts";
import {
  assertBoundCitationSettlement,
  assertHistoricalCitationReceipt,
  citationBindingInsert,
  citationGuardInsert,
  citationReceiptInsert,
  citationResolutionReceiptDigestPayload,
  loadCitationReceipt,
  loadCitationSettlement,
} from "./citation-attempt-registry.js";
import { canonicalEvidenceJson, evidenceSha256 } from "./canonical.js";
import {
  EvidenceRuntimeError,
  type PersistCitationResolutionInput,
} from "./types.js";

export { citationResolutionReceiptDigestPayload } from "./citation-attempt-registry.js";

function fail(
  code: EvidenceRuntimeError["code"],
  message: string,
  options: ConstructorParameters<typeof EvidenceRuntimeError>[2] = {},
): never {
  throw new EvidenceRuntimeError(code, message, options);
}

export async function persistCitationResolutionReceipt(
  database: D1Database,
  input: PersistCitationResolutionInput,
): Promise<CitationResolutionReceipt> {
  let receipt: CitationResolutionReceipt;
  try {
    receipt = CitationResolutionReceiptSchema.parse(input.receipt);
  } catch (cause) {
    fail("CITATION_SET_INVALID", "citation resolution receipt failed strict validation", { cause });
  }
  if (await evidenceSha256(citationResolutionReceiptDigestPayload(receipt)) !== receipt.receipt_digest) {
    fail("CITATION_SET_INVALID", "citation resolution receipt payload digest mismatch");
  }
  if (
    canonicalEvidenceJson(receipt) !== input.receipt_json ||
    await evidenceSha256(receipt) !== input.receipt_sha256
  ) {
    fail("CITATION_SET_INVALID", "citation resolution receipt canonical digest mismatch");
  }
  if (
    receipt.scope_snapshot_ref.id !== input.scope.snapshot.snapshot_id ||
    receipt.scope_snapshot_ref.revision !== input.scope.snapshot.revision ||
    input.authorization.authorization_receipt_ref === ""
  ) {
    fail("CITATION_SET_INVALID", "citation receipt is not bound to the authorized ScopeSnapshot");
  }

  let persistedReceipt = receipt;
  let persistedReceiptJson = input.receipt_json;
  let persistedReceiptSha256 = input.receipt_sha256;
  if (input.attempt_binding !== undefined) {
    const historical = await loadCitationSettlement(database, receipt, input.attempt_binding);
    if (historical !== null) {
      assertHistoricalCitationReceipt(historical, input, receipt);
      persistedReceipt = historical.receipt;
      persistedReceiptJson = historical.receipt_json;
      persistedReceiptSha256 = historical.receipt_sha256;
      if (historical.binding !== null) {
        return assertBoundCitationSettlement(
          historical,
          persistedReceipt,
          persistedReceiptJson,
          persistedReceiptSha256,
          input,
        );
      }
    }
  }

  const authorityNow = new Date().toISOString();
  const guardEvaluationTime = input.attempt_binding === undefined
    ? persistedReceipt.created_at
    : authorityNow;
  try {
    const statements: D1PreparedStatement[] = [
      citationReceiptInsert(
        database,
        persistedReceipt,
        persistedReceiptJson,
        persistedReceiptSha256,
        input,
      ),
      citationGuardInsert(
        database,
        persistedReceipt,
        persistedReceiptSha256,
        input,
        guardEvaluationTime,
      ),
    ];
    if (input.attempt_binding !== undefined) {
      statements.push(citationBindingInsert(
        database,
        persistedReceipt,
        persistedReceiptSha256,
        input,
      ));
    }
    await database.batch(statements);
  } catch (cause) {
    if (input.attempt_binding !== undefined) {
      const settlement = await loadCitationSettlement(database, receipt, input.attempt_binding);
      if (settlement !== null) {
        assertHistoricalCitationReceipt(settlement, input, receipt);
        return assertBoundCitationSettlement(
          settlement,
          settlement.receipt,
          settlement.receipt_json,
          settlement.receipt_sha256,
          input,
        );
      }
      fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "bound citation settlement is missing after transaction failure", {
        retryable: true,
        cause,
      });
    }
    const raced = await loadCitationReceipt(database, receipt);
    if (raced !== null && canonicalEvidenceJson(raced) === canonicalEvidenceJson(receipt)) return raced;
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation resolution receipt transaction failed", {
      retryable: true,
      cause,
    });
  }

  if (input.attempt_binding !== undefined) {
    const settlement = await loadCitationSettlement(database, persistedReceipt, input.attempt_binding);
    if (settlement === null) {
      fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "bound citation settlement readback is missing", {
        retryable: true,
      });
    }
    return assertBoundCitationSettlement(
      settlement,
      persistedReceipt,
      persistedReceiptJson,
      persistedReceiptSha256,
      input,
    );
  }

  const readback = await loadCitationReceipt(database, receipt);
  if (readback === null || canonicalEvidenceJson(readback) !== canonicalEvidenceJson(receipt)) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation resolution receipt readback mismatch", {
      retryable: true,
    });
  }
  return readback;
}
