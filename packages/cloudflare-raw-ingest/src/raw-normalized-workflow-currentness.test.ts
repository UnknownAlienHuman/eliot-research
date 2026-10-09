import { describe, expect, it } from "vitest";
import { sha256Utf8 } from "@eliotr/platform-cloudflare";
import type { RawNormalizedAdmissionRequest } from "@eliotr/interfaces";
import {
  createRawNormalizedAdmissionService,
  type RawNormalizedAdmissionBundlePort,
  type RawNormalizedAdmissionRequestPorts,
} from "./raw-normalized-admission-service.js";
import type { RawCaptureReceipt } from "./raw-ingest-types.js";
import type { RawNormalizedConversion, RawNormalizedOutputReadback } from "./raw-normalized-types.js";

const capture: RawCaptureReceipt = {
  protocol: "eliotr.raw-file-capture.v1",
  capture_id: "capture-1",
  principal_ref: "principal-1",
  owner_system_id: "owner-1",
  source_namespace_id: "namespace-1",
  source_revision_ref: "revision-1",
  source_logical_id: "source-1",
  source_owner_generation: "generation-1",
  idempotency_key: "capture-key-1",
  original_file_name: "report.pdf",
  object_key: "raw/capture-1",
  residency_key_digest: "b".repeat(64),
  content_sha256: "a".repeat(64),
  size_bytes: 11,
  content_type: "application/pdf",
  etag: "capture-etag-1",
  captured_at: "2026-10-08T12:00:00.000Z",
};

const ownerRow = {
  source_namespace_id: "namespace-1",
  ownership_record_revision: 1,
  owner_system_id: "owner-1",
  source_owner_generation: "generation-1",
  source_admission_policy_revision: 1,
  status: "ACTIVE",
  cutover_receipt_ref: null,
};

const policyRow = {
  source_namespace_id: "namespace-1",
  revision: 1,
  authorized_principal_refs_json: '["principal-1"]',
  allowed_ownership_modes_json: '["immutable_import"]',
  source_class: "document",
  assurance_ceiling: "QUALIFIED",
  instruction_taint: "DATA_ONLY",
  allowed_effects: "READ_ONLY",
  allowed_use_json: '["research"]',
  disclosure_ceiling: "private",
  license_policy_ref: "license-1",
  default_storage_policy: "storage-1",
  default_residency_profile_id: "residency-1",
  default_retention_policy_id: "retention-1",
  minimum_quality_state: "standard",
  created_at: "2026-10-08T00:00:00.000Z",
};

const request: RawNormalizedAdmissionRequest = {
  idempotency_key: "admission-key-1",
  conversion_operation_id: "conversion-1",
};

async function scenario(failOnAuthorityCheck: number) {
  const bytes = new TextEncoder().encode("# Normalized report\n");
  const outputSha = await sha256Utf8(new TextDecoder().decode(bytes));
  const conversion: RawNormalizedConversion = {
    protocol: "eliotr.raw-markdown-conversion.v1",
    state: "COMPLETE",
    operation_id: "conversion-1",
    capture_id: capture.capture_id,
    content_sha256: capture.content_sha256,
    output_sha256: outputSha,
    output_bytes: bytes.byteLength,
    detected_mime: "text/markdown",
    format: "markdown",
    tokens: 4,
  };
  const output: RawNormalizedOutputReadback = {
    object_key: "raw-markdown/conversion-1/output.md",
    bytes,
    sha256: outputSha,
    size_bytes: bytes.byteLength,
  };

  let admissionRow: { readonly state: string } | null = null;
  let reservationWrites = 0;
  let bundlePrepareCalls = 0;
  let authorityChecks = 0;
  const database = {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first<T>() {
          if (sql.includes("FROM source_namespace_ownership")) return ownerRow as T;
          if (sql.includes("FROM source_admission_policy")) return policyRow as T;
          if (sql.includes("FROM raw_normalized_admission")) return admissionRow as T | null;
          return null;
        },
        async run() {
          if (sql.startsWith("INSERT INTO raw_normalized_admission")) {
            reservationWrites += 1;
            admissionRow = { state: "PREPARING" };
          }
          return { success: true, results: [], meta: {} };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  const service = createRawNormalizedAdmissionService({ database, now: () => Date.parse("2026-10-09T12:00:00.000Z") });
  const bundle: RawNormalizedAdmissionBundlePort = {
    async getBundleRecovery() { throw new Error("unexpected bundle recovery effect"); },
    async prepareBundle() {
      bundlePrepareCalls += 1;
      throw new Error("unexpected bundle preparation effect");
    },
    async uploadBundlePart() { throw new Error("unexpected bundle upload effect"); },
    async completeBundleFile() { throw new Error("unexpected bundle completion effect"); },
    async commitBundle() { throw new Error("unexpected bundle commit effect"); },
    async getBundleStatus() { throw new Error("unexpected bundle status read"); },
  };
  const ports: RawNormalizedAdmissionRequestPorts = {
    owner: bundle,
    async readCapture() { return capture; },
    async readConversion() { return { conversion, output }; },
    async assertCurrentAuthority() {
      authorityChecks += 1;
      if (authorityChecks === failOnAuthorityCheck) throw new Error("workflow authority drifted");
    },
  };
  let failure: unknown;
  try {
    await service.admit({ principal_ref: "principal-1", signal: new AbortController().signal }, capture.capture_id, request, ports);
  } catch (cause) {
    failure = cause;
  }
  return { failure, reservationWrites, admissionRow, bundlePrepareCalls, authorityChecks };
}

describe("raw normalized Workflow currentness fence", () => {
  it("rejects drift before reservation or after reservation before any bundle effect", async () => {
    const beforeReservation = await scenario(2);
    expect(beforeReservation.failure).toMatchObject({ code: "RAW_NORMALIZED_AUTHORITY_STALE", status: 409 });
    expect(beforeReservation.reservationWrites).toBe(0);
    expect(beforeReservation.admissionRow).toBeNull();
    expect(beforeReservation.bundlePrepareCalls).toBe(0);

    const afterReservation = await scenario(3);
    expect(afterReservation.failure).toMatchObject({ code: "RAW_NORMALIZED_AUTHORITY_STALE", status: 409 });
    expect(afterReservation.reservationWrites).toBe(1);
    expect(afterReservation.admissionRow).toEqual({ state: "PREPARING" });
    expect(afterReservation.bundlePrepareCalls).toBe(0);
  });
});
