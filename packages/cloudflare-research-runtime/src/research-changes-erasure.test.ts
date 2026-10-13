import { describe, expect, it } from "vitest";
import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext, ResearchChangeItem } from "@eliotr/interfaces";
import { authorizeErasureChange } from "./research-changes-erasure.js";

const context: AuthenticatedRequestContext = {
  request: new Request("https://erasure-contract.invalid/api/v1/research/changes"),
  principal_ref: "owner-erasure-contract",
  client_class: "owner_pwa",
  credential_generation: "erasure-contract-credential-1",
  trace_id: "erasure-contract-trace-1",
};
const change: ResearchChangeItem = {
  sequence: 1,
  change_ref: "erasure-completed:erasure-contract-operation:1",
  kind: "ERASURE_COMPLETED",
  subject_ref: "erasure-contract-operation",
  subject_revision: 1,
  payload_ref: "erasure-contract-purge-receipt",
  payload_sha256: "a".repeat(64),
  visibility_principal_ref: context.principal_ref,
  occurred_at: "2026-10-12T00:00:00.000Z",
  metadata: {},
};

describe("erasure change authorization error contract", () => {
  it("retains an upstream deterministic denial as a bounded non-retryable conflict", async () => {
    const upstream = new CatalogInputError("RESEARCH_CHANGES_CONFLICT", "private upstream detail", 409, false);
    await expect(authorizeErasureChange(context, change, async () => { throw upstream; }))
      .rejects.toMatchObject({
        code: "RESEARCH_CHANGES_CONFLICT", status: 409, retryable: false,
        message: "erasure change authorization is denied",
      });
  });

  it.each([
    new Error("private storage detail"),
    new CatalogInputError("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "private upstream detail", 503, true),
  ])("keeps unavailable or unknown authorization conservative (%#)", async (upstream) => {
    await expect(authorizeErasureChange(context, change, async () => { throw upstream; }))
      .rejects.toMatchObject({
        code: "RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", status: 503, retryable: true,
        message: "erasure change authorization is unavailable",
      });
  });

  it("does not execute an unknown retryability accessor while handling an error", async () => {
    let reads = 0;
    const upstream = Object.defineProperty(new Error("private upstream detail"), "retryable", {
      get() { reads += 1; throw new Error("private accessor detail"); },
    });
    await expect(authorizeErasureChange(context, change, async () => { throw upstream; }))
      .rejects.toMatchObject({
        code: "RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", status: 503, retryable: true,
        message: "erasure change authorization is unavailable",
      });
    expect(reads).toBe(0);
  });
});
