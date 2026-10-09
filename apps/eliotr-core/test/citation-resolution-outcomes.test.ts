import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import { CitationResolutionReceiptV2Schema } from "@eliotr/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createNativeCitationOutcomesFixture,
  CREATED_AT,
  CREDENTIAL_GENERATION,
  expectGuardRefusal,
  expectReceiptJsonDriftRefusal,
  insertGuard,
  insertReceipt,
  persistUnboundReceipt,
  receiptRow,
  sealReceipt,
  storedReceipt,
  toReceiptRow,
  unavailableOnlyDraft,
  v2Draft,
  v2DraftFrom,
  v2ProjectionOrderDraft,
  SHA_B,
  type NativeFixture,
  type ReceiptDraft,
} from "./citation-resolution-outcomes-fixture.js";

let fixture: NativeFixture | undefined;
describe("native D1 citation-resolution outcomes admission guard", () => {
  beforeAll(async () => {
    fixture = await createNativeCitationOutcomesFixture();
  }, 120_000);

  it("preserves pre-migration V1 bytes and digest with a null outcomes column", async () => {
    if (fixture === undefined) throw new Error("native D1 fixture was not initialized");
    const row = await storedReceipt(fixture.database, toReceiptRow(fixture.historical_v1));
    expect(row).toMatchObject({
      receipt_json: fixture.historical_v1_json,
      receipt_sha256: fixture.historical_v1_sha256,
      outcomes_json: null,
      verified: null,
    });
    await insertGuard(fixture.database, toReceiptRow(fixture.historical_v1)).run();
    const admitted = await storedReceipt(fixture.database, toReceiptRow(fixture.historical_v1));
    expect(admitted).toMatchObject({
      receipt_json: fixture.historical_v1_json,
      receipt_sha256: fixture.historical_v1_sha256,
      outcomes_json: null,
      verified: 1,
    });
  });

  it("admits every V2 outcome and reads back the exact outcomes and projections", async () => {
    if (fixture === undefined) throw new Error("native D1 fixture was not initialized");
    const sealed = await sealReceipt(v2Draft(fixture.scope_ref, "valid-v2-citation"));
    const receipt = CitationResolutionReceiptV2Schema.parse(sealed);
    const row = await receiptRow(receipt);
    await fixture.database.batch([insertReceipt(fixture.database, row), insertGuard(fixture.database, row)]);

    const stored = await storedReceipt(fixture.database, row);
    expect(stored).toMatchObject({
      receipt_json: row.receipt_json,
      receipt_sha256: row.receipt_sha256,
      requested_handle_refs_json: canonicalEvidenceJson(receipt.requested_handle_refs),
      outcomes_json: canonicalEvidenceJson(receipt.outcomes),
      resolved_json: canonicalEvidenceJson(receipt.resolved),
      rejected_json: canonicalEvidenceJson(receipt.rejected),
      verified: 1,
    });
    if (stored === null) throw new Error("admitted V2 receipt readback is missing");
    const decoded = CitationResolutionReceiptV2Schema.parse(JSON.parse(stored.receipt_json) as unknown);
    expect(decoded.outcomes).toEqual(receipt.outcomes);
    expect(stored.outcomes_json).toBe(canonicalEvidenceJson(decoded.outcomes));
  });

  it("returns the original bytes on unbound replay and rejects logical or access mismatches", async () => {
    if (fixture === undefined) throw new Error("native D1 fixture was not initialized");
    const original = CitationResolutionReceiptV2Schema.parse(
      await sealReceipt(unavailableOnlyDraft(fixture.scope_ref, "unbound-replay-v2-citation")),
    );
    const first = await persistUnboundReceipt(fixture, original);
    const originalJson = canonicalEvidenceJson(first);
    const originalSha256 = await evidenceSha256(first);
    expect(first.created_at).toBe(CREATED_AT);

    const laterCreatedAt = "2026-10-08T20:01:00.000Z";
    const replayDraft: ReceiptDraft = {
      ...v2DraftFrom(first),
      created_at: laterCreatedAt,
    };
    const replayCandidate = CitationResolutionReceiptV2Schema.parse(await sealReceipt(replayDraft));
    expect(replayCandidate.receipt_ref).toEqual(first.receipt_ref);
    expect(replayCandidate.created_at).toBe(laterCreatedAt);
    const replayed = await persistUnboundReceipt(fixture, replayCandidate);
    expect(canonicalEvidenceJson(replayed)).toBe(originalJson);
    expect(await evidenceSha256(replayed)).toBe(originalSha256);

    const stored = await storedReceipt(fixture.database, toReceiptRow(first));
    expect(stored).toMatchObject({
      receipt_json: originalJson,
      receipt_sha256: originalSha256,
      outcomes_json: canonicalEvidenceJson(first.outcomes),
      verified: 1,
    });

    const conflictingOutcomes = first.outcomes.map((outcome, index) => index === 0
      ? { handle_ref: outcome.handle_ref, outcome: "STORAGE_UNAVAILABLE" }
      : outcome);
    const logicalConflict = CitationResolutionReceiptV2Schema.parse(await sealReceipt({
      ...v2DraftFrom(first, { outcomes: conflictingOutcomes }),
      created_at: laterCreatedAt,
    }));
    await expect(persistUnboundReceipt(fixture, logicalConflict)).rejects.toMatchObject({
      code: "EVIDENCE_SETTLEMENT_UNCERTAIN",
      retryable: true,
    });

    await expect(persistUnboundReceipt(fixture, first, {
      principal_ref: "different-citation-owner",
      client_class: "owner_pwa",
      credential_generation: CREDENTIAL_GENERATION,
    })).rejects.toMatchObject({
      code: "EVIDENCE_SETTLEMENT_UNCERTAIN",
      retryable: true,
    });
  });

  it("refuses an unknown V2 outcome", async () => {
    if (fixture === undefined) throw new Error("native D1 fixture was not initialized");
    const base = CitationResolutionReceiptV2Schema.parse(
      await sealReceipt(v2Draft(fixture.scope_ref, "unknown-v2-citation")),
    );
    const outcomes = base.outcomes.map((outcome, index) => index === 1
      ? { handle_ref: outcome.handle_ref, outcome: "UNRECOGNIZED_OUTCOME" }
      : outcome);
    await expectGuardRefusal(fixture.database, v2DraftFrom(base, { outcomes }));
  });

  it("refuses duplicate outcome handles and the resulting missing handle", async () => {
    if (fixture === undefined) throw new Error("native D1 fixture was not initialized");
    const base = CitationResolutionReceiptV2Schema.parse(
      await sealReceipt(v2Draft(fixture.scope_ref, "duplicate-v2-citation")),
    );
    const duplicate = base.outcomes[1];
    if (duplicate === undefined) throw new Error("V2 fixture outcome is missing");
    const outcomes = base.outcomes.map((outcome, index) => index === 3 ? duplicate : outcome);
    await expectGuardRefusal(fixture.database, v2DraftFrom(base, { outcomes }));
  });

  it("refuses a resolved projection that differs from its RESOLVED outcome", async () => {
    if (fixture === undefined) throw new Error("native D1 fixture was not initialized");
    const base = CitationResolutionReceiptV2Schema.parse(
      await sealReceipt(v2Draft(fixture.scope_ref, "resolved-drift-v2-citation")),
    );
    const resolved = base.resolved.map((item) => ({ ...item, excerpt_sha256: SHA_B }));
    await expectGuardRefusal(fixture.database, v2DraftFrom(base, { resolved }));
  });

  it("refuses a rejected projection that differs from its proven-invalid outcome", async () => {
    if (fixture === undefined) throw new Error("native D1 fixture was not initialized");
    const base = CitationResolutionReceiptV2Schema.parse(
      await sealReceipt(v2Draft(fixture.scope_ref, "rejected-drift-v2-citation")),
    );
    const rejected = base.rejected.map((item, index) => index === 0
      ? { ...item, reason_code: "AUTHORITY_REVOKED" }
      : item);
    await expectGuardRefusal(fixture.database, v2DraftFrom(base, { rejected }));
  });

  it("refuses resolved projections whose order differs from RESOLVED outcomes", async () => {
    if (fixture === undefined) throw new Error("native D1 fixture was not initialized");
    const base = CitationResolutionReceiptV2Schema.parse(
      await sealReceipt(v2ProjectionOrderDraft(fixture.scope_ref, "resolved-order-v2-citation")),
    );
    await expectGuardRefusal(fixture.database, v2DraftFrom(base, {
      resolved: [...base.resolved].reverse(),
    }));
  });

  it("refuses rejected projections whose order differs from proven-invalid outcomes", async () => {
    if (fixture === undefined) throw new Error("native D1 fixture was not initialized");
    const base = CitationResolutionReceiptV2Schema.parse(
      await sealReceipt(v2ProjectionOrderDraft(fixture.scope_ref, "rejected-order-v2-citation")),
    );
    await expectGuardRefusal(fixture.database, v2DraftFrom(base, {
      rejected: [...base.rejected].reverse(),
    }));
  });

  it("refuses receipt_json drift from aligned V2 projections, counts, and identity", async () => {
    if (fixture === undefined) throw new Error("native D1 fixture was not initialized");

    const positiveReceipt = CitationResolutionReceiptV2Schema.parse(
      await sealReceipt(v2Draft(fixture.scope_ref, "metadata-drift-positive-v2-citation")),
    );
    const positiveRow = await receiptRow(positiveReceipt);
    await fixture.database.batch([
      insertReceipt(fixture.database, positiveRow),
      insertGuard(fixture.database, positiveRow),
    ]);
    expect(await storedReceipt(fixture.database, positiveRow)).toMatchObject({
      receipt_json: positiveRow.receipt_json,
      receipt_sha256: positiveRow.receipt_sha256,
      outcomes_json: positiveRow.outcomes_json,
      verified: 1,
    });

    await expectReceiptJsonDriftRefusal(
      fixture.database,
      v2Draft(fixture.scope_ref, "requested-json-drift-v2-citation"),
      (receipt) => {
        const refs = receipt.requested_handle_refs as Array<Record<string, unknown>>;
        const first = refs[0];
        if (first === undefined) throw new Error("receipt_json requested handles are missing");
        first.id = `${String(first.id)}-drift`;
      },
    );

    await expectReceiptJsonDriftRefusal(
      fixture.database,
      v2Draft(fixture.scope_ref, "resolved-json-drift-v2-citation"),
      (receipt) => {
        const resolved = receipt.resolved as Array<Record<string, unknown>>;
        const first = resolved[0];
        if (first === undefined) throw new Error("receipt_json resolved projection is missing");
        first.excerpt_sha256 = SHA_B;
      },
    );

    await expectReceiptJsonDriftRefusal(
      fixture.database,
      v2Draft(fixture.scope_ref, "rejected-json-drift-v2-citation"),
      (receipt) => {
        const rejected = receipt.rejected as Array<Record<string, unknown>>;
        const first = rejected[0];
        if (first === undefined) throw new Error("receipt_json rejected projection is missing");
        first.reason_code = "AUTHORITY_REVOKED";
      },
    );

    await expectReceiptJsonDriftRefusal(
      fixture.database,
      v2Draft(fixture.scope_ref, "count-json-drift-v2-citation"),
      (receipt) => {
        receipt.requested_count = 7;
        receipt.resolved_count = 0;
      },
    );

    await expectReceiptJsonDriftRefusal(
      fixture.database,
      v2Draft(fixture.scope_ref, "receipt-identity-drift-v2-citation"),
      (receipt) => {
        const reference = receipt.receipt_ref as Record<string, unknown>;
        reference.id = "different-json-receipt-identity";
        reference.revision = 2;
      },
    );

    await expectReceiptJsonDriftRefusal(
      fixture.database,
      v2Draft(fixture.scope_ref, "scope-identity-drift-v2-citation"),
      (receipt) => {
        const reference = receipt.scope_snapshot_ref as Record<string, unknown>;
        reference.id = "different-json-scope-identity";
        reference.revision = 2;
      },
    );
  });
});
