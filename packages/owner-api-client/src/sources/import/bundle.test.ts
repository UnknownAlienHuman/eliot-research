import { describe, expect, it } from "vitest";
import { NormalizedBundleManifestSchema, type NormalizedBundleManifest } from "@eliotr/contracts";
import { createBundleImportApi } from "./bundle.js";
import type { LegacyErrorDetails, LegacyErrorFactory } from "../../legacy/http.js";
import type { EpochPort } from "../../transport/client.js";
import type { BundleWireApi } from "./bundle-wire.js";

/** Targeted boundaries for the moved bundle import attempt lifecycle. */

const errors: LegacyErrorFactory = (details: LegacyErrorDetails) =>
  Object.assign(new Error(details.message), details)

const isRequestError = (value: unknown): value is Error & {
  readonly code: string;
  readonly status: number;
} => value instanceof Error &&
  typeof (value as { code?: unknown }).code === "string" &&
  typeof (value as { status?: unknown }).status === "number";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const clock = { now: () => NOW };

const liveEpoch = (): { epoch: EpochPort; advance(): void } => {
  let stamp: object | undefined = {};
  return {
    epoch: {
      capture: () => stamp,
      isCurrent: (capture: unknown) => stamp !== undefined && capture === stamp,
    },
    advance: () => { stamp = {}; },
  };
};

const DIGEST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
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

const bundle = {
  manifest,
  files: [],
  hashes: {},
  totalBytes: 0,
};
const uploadBundle = { ...bundle, files: [{ path: "content.md", bytes: new Uint8Array(11) }], hashes: { "content.md": DIGEST }, totalBytes: 11 };

const identity = {
  operation: "operation-1",
  manifestDigest: DIGEST,
  sourceRevision: "revision-1",
  generation: "deployment-1",
};

const prepared = (overrides: Record<string, unknown> = {}) => ({
  identity,
  expiry: NOW + 60_000,
  files: [],
  rejected: false,
  reasons: [],
  ...overrides,
})

const partRow = (filePath: string, partNumber: number, sizeBytes: number) => ({
  operation_id: "operation-1",
  multipart_session_ref: "session-1",
  path: filePath,
  part_number: partNumber,
  size_bytes: sizeBytes,
  etag: "etag-1",
})
const receipt = () => ({
  protocol: "eliotr.normalized.v1",
  operation_id: "operation-1",
  manifest_sha256: DIGEST,
  source_revision_ref: "revision-1",
  normalized_artifact_ref: "artifact-1",
  object_residency_key_digest: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  decision: "ADMITTED",
  reason_codes: [],
  readback_sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  committed_at: "2026-10-09T12:00:00.000Z",
})

const committedStatus = () => ({
  operation_id: "operation-1",
  source_revision_ref: "revision-1",
  state: "COMMITTED",
  expires_at: "2026-10-09T13:00:00.000Z",
  updated_at: "2026-10-09T12:00:00.000Z",
  receipt: receipt(),
})

interface Probe {
  readonly json: readonly { path: string; init: RequestInit }[];
  readonly binary: readonly { path: string; input: unknown }[];
  readonly binaryResponses: unknown[];
  releaseBinary(): void;
  readonly binaryStarted: Promise<void>;
}

/** One in-memory wire plus its recorded calls; no arbitrary transport override is injected. */
const probe = (options: {
  readonly prepared?: unknown;
  readonly status?: unknown;
  readonly gateBinary?: boolean;
} = {}): Probe & { readonly wire: BundleWireApi } => {
  const json: { path: string; init: RequestInit }[] = [];
  const binary: { path: string; input: unknown }[] = [];
  const binaryResponses: unknown[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; })
  let started: () => void = () => undefined;
  const binaryStarted = new Promise<void>(resolve => { started = resolve; });
  const wire = {
    mismatch: () => errors({ status: 502, code: "INGEST_RESPONSE_MISMATCH",
      message: "mismatch", traceId: null, retryable: false }),
    importCall: async (path: string, init: RequestInit) => {
      json.push({ path, init })
      if (path.endsWith("/commit")) {
        return { data: receipt(), generation: "deployment-1" };
      }
      if (path.endsWith("/prepare")) {
        return { data: options.prepared ?? prepared(), generation: "deployment-1" };
      }
      if (path.includes("/files/complete")) {
        return {
          data: { operation_id: "operation-1", multipart_session_ref: "session-1",
            path: "content.md", sha256: DIGEST, size_bytes: 11, etag: "etag-1",
            completed_at: "2026-10-09T12:00:00.000Z" },
          trace_id: "trace-1", deployment_generation: "deployment-1",
        };
      }
      return {
        data: options.status ?? committedStatus(),
        trace_id: "trace-1", deployment_generation: "deployment-1",
      };
    },
    importBytesCall: async (path: string, input: unknown) => {
      binary.push({ path, input })
      started();
      if (options.gateBinary === true) await gate;
      const stored = binaryResponses.shift()
      return {
        data: stored ?? partRow("content.md", binary.length, 11),
        trace_id: "trace-1", deployment_generation: "deployment-1",
      };
    },
    decodePrepared: () => {
      if (options.prepared === undefined) return prepared()
      return options.prepared;
    },
    decodeImportStatus: () => {
      if (options.status === undefined) return { state: "COMMITTED", receipt: receipt() };
      return options.status;
    },
    receiptFor: () => receipt(),
  };
  return {
    json, binary, binaryResponses, releaseBinary: release, binaryStarted,
    wire: wire as unknown as BundleWireApi,
  };
};
/** Build the import API over one probe; tests never inject an arbitrary transport. */
const importApiFor = (p: Probe & { readonly wire: BundleWireApi },
  epoch: EpochPort, over: { readonly wire?: BundleWireApi } = {}) =>
  createBundleImportApi(over.wire ?? p.wire, errors, epoch, clock, isRequestError)

describe("bundle import attempt lifecycle", () => {
  it("rejects an invalid idempotency key before any transport call", async () => {
    const p = probe()
    expect(() => importApiFor(p, liveEpoch().epoch).createBrowserBundleImport(bundle, "../bad key"))
      .toThrow(expect.objectContaining({ code: "BUNDLE_INPUT_INVALID", status: 400 }));
    expect(p.json).toHaveLength(0)
    expect(p.binary).toHaveLength(0)
  })

  it("reports a rejected reservation as null with no receipt", async () => {
    const p = probe({
      prepared: prepared({ rejected: true, reasons: ["source_rejected"] }),
    })
    const attempt = importApiFor(p, liveEpoch().epoch)
      .createBrowserBundleImport(bundle, "key-1");
    await expect(attempt.run()).resolves.toBeNull()
  })

  it("refuses to run again while an attempt is already in flight", async () => {
    const p = probe({ gateBinary: true, prepared: prepared({ session: "session-1", files: [{ path: "content.md", maxPart: 6291456 }] }) })
    const attempt = importApiFor(p, liveEpoch().epoch)
      .createBrowserBundleImport(uploadBundle, "key-1");
    const first = attempt.run()
    await p.binaryStarted;
    await expect(attempt.run()).rejects.toMatchObject({
      code: "BUNDLE_IMPORT_NOT_RESUMABLE", status: 409,
    })
    p.releaseBinary()
    await first;
  })

  it("closes the attempt permanently after a terminal mismatch", async () => {
    const p = probe()
    const failing = {
      ...p.wire,
      decodePrepared: () => { throw errors({ status: 502,
        code: "INGEST_RESPONSE_MISMATCH", message: "mismatch",
        traceId: null, retryable: false }); },
    } as unknown as BundleWireApi;
    const attempt = importApiFor(p, liveEpoch().epoch, { wire: failing })
      .createBrowserBundleImport(bundle, "key-1");
    await expect(attempt.run()).rejects.toMatchObject({
      code: "INGEST_RESPONSE_MISMATCH", status: 502,
    })
    expect(attempt.canResume).toBe(false)
    await expect(attempt.run()).rejects.toMatchObject({
      code: "BUNDLE_IMPORT_NOT_RESUMABLE", status: 409,
    })
  })

  it("refuses to dispatch if the epoch advances after the attempt was created", async () => {
    const { epoch, advance } = liveEpoch()
    const p = probe({ gateBinary: true })
    const api = createBundleImportApi(p.wire, errors, epoch, clock, isRequestError)
    const attempt = api.createBrowserBundleImport(bundle, "key-1");
    advance()
    await expect(attempt.run()).rejects.toMatchObject({
      code: "API_SESSION_CLOSED", status: 503,
    });
    expect(p.json).toHaveLength(0)
    expect(p.binary).toHaveLength(0)
  })

  it("stops an in-flight upload when the attempt is disposed", async () => {
    const p = probe({ gateBinary: true, prepared: prepared({ session: "session-1", files: [{ path: "content.md", maxPart: 6291456 }] }) })
    const attempt = importApiFor(p, liveEpoch().epoch)
      .createBrowserBundleImport(uploadBundle, "key-1");
    const first = attempt.run()
    await p.binaryStarted;
    attempt.dispose()
    p.releaseBinary()
    await expect(first).rejects.toMatchObject({
      code: "BUNDLE_IMPORT_CANCELLED", status: 499,
    });
    expect(attempt.canResume).toBe(false)
    expect(p.binary).toHaveLength(1);
    expect(p.json.some(call => call.path.endsWith("/commit"))).toBe(false);
  })
});
