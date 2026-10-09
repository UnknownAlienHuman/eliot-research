import { describe, expect, it } from "vitest";
import { NormalizedBundleManifestSchema, type NormalizedBundleManifest } from "@eliotr/contracts";
import { createBundleRecoveryApi } from "./bundle-recovery.js";
import type { LegacyErrorDetails, LegacyErrorFactory } from "../../legacy/http.js";
import type { BrowserBundle } from "./bundle-input.js";
import { createBundleWireApi, type BundleWireApi } from "./bundle-wire.js";

/** Targeted boundaries for the moved recovery and discovery decoders. */

const errors: LegacyErrorFactory = (details: LegacyErrorDetails) =>
  Object.assign(new Error(details.message), details)

const DIGEST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const clock = { now: () => NOW };

/** A manifest that satisfies the strict normalized contract, never a partial cast. */
const manifest: NormalizedBundleManifest = NormalizedBundleManifestSchema.parse({
  protocol: "eliotr.normalized.v1",
  origin: {
    owner_system_id: "owner-1",
    source_namespace_id: "namespace-1",
    source_owner_generation: "generation-1",
    source_revision_ref: "revision-1",
    source_view_ref: "view-1",
    ownership_mode: "immutable_import",
  },
  source: {
    logical_id: "source-1",
    original_name: "notes-and-datasheets",
    original_sha256: DIGEST,
    origin_location_class: "local_only",
    mime_type: "text/markdown",
  },
  residency_and_disclosure: {
    scope_domain_id: "scope-1",
    access_domain_id: "access-1",
    confidentiality_domain_id: "confidentiality-1",
    encryption_key_domain_id: "encryption-1",
    retention_domain_id: "retention-1",
    erasure_domain_id: "erasure-1",
    disclosure_ceiling: "owner-only",
    allowed_use: ["owner-workspace"],
  },
  normalization: {
    analyzer: "analyzer-1",
    analyzer_version: "1.0.0",
    profile: "profile-1",
    config_hash: DIGEST,
    created_at: "2026-10-09T12:00:00.000Z",
  },
  content: {
    markdown: "content.md",
    markdown_sha256: DIGEST,
  },
  capabilities: {
    text_ranges: true,
    pages: false,
    bounding_boxes: false,
    tables: false,
    figures: false,
  },
  quality: {
    state: "high_fidelity",
    assurance_ceiling: "ceiling-1",
    warnings: [],
  },
  export: {
    purpose: "owner workspace import",
    receipt_ref: "receipt-1",
  },
})

const bundle: BrowserBundle = {
  manifest,
  files: [{ path: "content.md", bytes: new Uint8Array([1]) }],
  hashes: { "content.md": DIGEST },
  totalBytes: 1,
};

const statusRow = (overrides: Record<string, unknown> = {}) => ({
  operation_id: "operation-1",
  source_revision_ref: "revision-1",
  state: "AUTHORIZED",
  expires_at: "2026-10-09T13:00:00.000Z",
  updated_at: "2026-10-09T12:00:00.000Z",
  ...overrides,
})

const recoveryRow = (overrides: Record<string, unknown> = {}) => ({
  protocol: "eliotr.ingest-recovery.v1",
  status: statusRow(),
  idempotency_key: "idempotency-1",
  manifest_sha256: DIGEST,
  total_bytes: 1,
  file_hashes: { "content.md": DIGEST },
  ...overrides,
})

const wireWith = (response: unknown): BundleWireApi => createBundleWireApi(
  { requestApi: async () => ({ data: response, trace_id: "trace-1", deployment_generation: "deployment-1" }) },
  { requestBinaryJson: async () => { throw new Error("Recovery must not use the binary seam"); } },
  errors, { capture: () => ({}), isCurrent: () => true }, clock,
);

const apiFor = (response: unknown) => createBundleRecoveryApi(wireWith(response), errors, clock)
describe("bundle recovery", () => {
  it("recovers the server reservation and its key without minting a new identity", async () => {
    const result = await apiFor(recoveryRow()).readBundleRecovery(bundle, "operation-1");
    expect(result.identity.operation).toBe("operation-1");
    expect(result.identity.manifestDigest).toBe(DIGEST)
    expect(result.identity.sourceRevision).toBe("revision-1");
    expect(result.key).toBe("idempotency-1");
  })

  it("passes the session through when the reservation still holds one", async () => {
    const row = recoveryRow({
      status: statusRow({ staging_session_ref: "session-1" }),
    })
    const result = await apiFor(row).readBundleRecovery(bundle, "operation-1");
    expect(result.session).toBe("session-1");
  })

  it("rejects a reservation whose operation id is not the requested one", async () => {
    const row = recoveryRow({
      status: statusRow({ operation_id: "other-operation" }),
    })
    await expect(apiFor(row).readBundleRecovery(bundle, "operation-1"))
      .rejects.toMatchObject({ code: "INGEST_RESPONSE_MISMATCH", status: 502 })
  })

  it("refuses to continue when the reselected bytes differ from the reservation", async () => {
    await expect(apiFor(recoveryRow({ total_bytes: 99 })).readBundleRecovery(bundle, "operation-1"))
      .rejects.toMatchObject({ code: "BUNDLE_RECOVERY_FILES_CHANGED", status: 409 })
  })

  it("refuses to continue an expired reservation with no terminal receipt", async () => {
    const row = recoveryRow({
      status: statusRow({ state: "UPLOAD_REQUIRED", expires_at: "2026-10-09T11:00:00.000Z" }),
    })
    await expect(apiFor(row).readBundleRecovery(bundle, "operation-1"))
      .rejects.toMatchObject({ code: "BUNDLE_RECOVERY_EXPIRED", status: 410 })
  })

  it("rejects a recovery protocol other than the ingest recovery protocol", async () => {
    await expect(apiFor(recoveryRow({ protocol: "eliotr.other.v1" }))
      .readBundleRecovery(bundle, "operation-1"))
      .rejects.toMatchObject({ code: "INGEST_RESPONSE_MISMATCH", status: 502 })
  })
});
