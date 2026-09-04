import type {
  AllowedReferenceManifest,
  FederationJobStatus,
  FederationRequest,
} from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  createD1FederationJobAuthority,
  createD1FederationReferenceManifestAuthority,
  type FederationAuthorityBindingInput,
} from "./d1-federation-authority.js";
import { canonicalJson } from "./ingest-validation.js";

const NOW = Date.parse("2026-09-04T15:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();
const FUTURE = "2026-09-05T15:00:00.000Z";
const MANIFEST_REF = { id: "federation-manifest-1", revision: 1 } as const;
const SCOPE_REF = { id: "scope-snapshot-1", revision: 1 } as const;
const encoder = new TextEncoder();

interface Call {
  readonly method: "first" | "run";
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface DatabaseFixture {
  readonly database: D1Database;
  readonly calls: Call[];
}

type FirstResult = Record<string, unknown> | null | Error;
type RunResult = D1Result<unknown> | Error;

function changedResult(changes = 1): D1Result<unknown> {
  return {
    success: true,
    meta: { changes },
    results: [],
  } as unknown as D1Result<unknown>;
}

function databaseFixture(
  firstResults: readonly FirstResult[],
  runResults: readonly RunResult[] = [],
): DatabaseFixture {
  const calls: Call[] = [];
  let firstIndex = 0;
  let runIndex = 0;
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              calls.push({ method: "first", sql, values });
              const result = firstResults[firstIndex++] ?? null;
              if (result instanceof Error) throw result;
              return result as T | null;
            },
            async run() {
              calls.push({ method: "run", sql, values });
              const result = runResults[runIndex++] ?? changedResult();
              if (result instanceof Error) throw result;
              return result;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { database, calls };
}

async function digest(value: unknown): Promise<string> {
  const bytes = encoder.encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function binding(
  overrides: Partial<FederationAuthorityBindingInput> = {},
): FederationAuthorityBindingInput {
  return {
    requester_principal_ref: "memory-os-client",
    requester_credential_generation: "memory-os-credential-1",
    server_principal_ref: "eliot-research",
    server_credential_generation: "research-credential-1",
    bridge_generation: "bridge-generation-1",
    client_fence_ref: "client-fence-1",
    allowed_reference_manifest_ref: MANIFEST_REF,
    trace_id: "trace-1",
    ...overrides,
  };
}

async function manifest(
  overrides: Partial<Omit<AllowedReferenceManifest, "manifest_digest">> = {},
): Promise<AllowedReferenceManifest> {
  const payload: Omit<AllowedReferenceManifest, "manifest_digest"> = {
    manifest_ref: MANIFEST_REF,
    scope_snapshot_ref: SCOPE_REF,
    allowed_source_revision_refs: [],
    allowed_evidence_handle_refs: [],
    allowed_tool_definition_refs: [],
    allowed_verifier_refs: [],
    permitted_anchor_and_precision_ceilings: [],
    provider_and_policy_generations: {
      "memory-os-client": "memory-os-credential-1",
      "eliot-research": "research-credential-1",
    },
    stale_or_revoked_entries: [],
    permitted_acquisition_or_expansion_routes: [],
    disclosure_ceiling: "private",
    allowed_use: [
      "federation.submit",
      "federation.status",
      "federation.cancel",
    ],
    expires_at: FUTURE,
    client_fence_ref: "client-fence-1",
    ...overrides,
  };
  return { ...payload, manifest_digest: await digest(payload) };
}

function request(overrides: Partial<FederationRequest> = {}): FederationRequest {
  return {
    protocol: "eliotr.federation.v1",
    exchange_id: "exchange-1",
    bridge_generation: "bridge-generation-1",
    idempotency_key: "idempotency-1",
    requester_principal_ref: "memory-os-client",
    client_fence_ref: "client-fence-1",
    question: "What exact evidence is available?",
    scope_expression: { kind: "PROJECT", project_id: "project-1" },
    expected_decision_or_artifact: "evidence bundle",
    source_classes: ["primary"],
    coverage_goal: "high_recall",
    allowed_input_handle_refs: [],
    privacy_policy_ref: "privacy-policy-1",
    disclosure_policy_ref: "disclosure-policy-1",
    retention_policy_ref: "retention-policy-1",
    license_policy_ref: "license-policy-1",
    residency_profile_ref: "residency-profile-1",
    budget_ref: "budget-1",
    deadline: FUTURE,
    stop_rule_ref: "stop-rule-1",
    progress_contract_ref: "progress-contract-1",
    required_result_schema_ref: "result-schema-1",
    evidence_grade: "E2",
    ...overrides,
  };
}

function manifestRow(value: AllowedReferenceManifest): Record<string, unknown> {
  return {
    manifest_id: value.manifest_ref.id,
    revision: value.manifest_ref.revision,
    manifest_json: canonicalJson(value),
    manifest_digest: value.manifest_digest,
    scope_snapshot_id: value.scope_snapshot_ref.id,
    scope_snapshot_revision: value.scope_snapshot_ref.revision,
    client_fence_ref: value.client_fence_ref ?? null,
    expires_at: value.expires_at,
    created_at: NOW_ISO,
  };
}

async function stableJobId(
  authorityBinding: FederationAuthorityBindingInput,
  value: FederationRequest,
  requestDigest: string,
): Promise<string> {
  const hash = await digest([
    "federation-job",
    value.exchange_id,
    value.idempotency_key,
    requestDigest,
    authorityBinding.requester_principal_ref,
    authorityBinding.server_principal_ref,
    authorityBinding.bridge_generation,
  ]);
  return `fjob-${hash.slice(0, 48)}`;
}

async function cancelReceipt(jobId: string, reason: string): Promise<string> {
  const hash = await digest(["federation-cancel", jobId, reason]);
  return `federation-cancel-${hash.slice(0, 48)}`;
}

async function jobRow(input: {
  readonly authorityBinding?: FederationAuthorityBindingInput;
  readonly value?: FederationRequest;
  readonly requestDigest?: string;
  readonly cancellationReason?: string;
  readonly corruptDigest?: string;
} = {}): Promise<Record<string, unknown>> {
  const authorityBinding = input.authorityBinding ?? binding();
  const value = input.value ?? request();
  const requestDigest = input.requestDigest ?? await digest(value);
  const jobId = await stableJobId(authorityBinding, value, requestDigest);
  const cancelled = input.cancellationReason !== undefined;
  const cancelledAt = cancelled ? "2026-09-04T15:01:00.000Z" : null;
  const receiptRef = cancelled
    ? await cancelReceipt(jobId, input.cancellationReason ?? "")
    : undefined;
  const status: FederationJobStatus = {
    exchange_id: value.exchange_id,
    idempotency_key: value.idempotency_key,
    job_id: jobId,
    attempt: 1,
    transport_state: cancelled ? "CANCELLED" : "ACCEPTED",
    completion_disposition: cancelled ? "CANCELLED" : null,
    completed_obligation_refs: [],
    partial_bundle_refs: [],
    open_research_debt_refs: [],
    ...(receiptRef === undefined
      ? {}
      : {
          cancellation_receipt_ref: receiptRef,
          terminal_receipt_ref: receiptRef,
        }),
  };
  return {
    job_id: jobId,
    exchange_id: value.exchange_id,
    idempotency_key: value.idempotency_key,
    request_digest: input.corruptDigest ?? requestDigest,
    request_json: canonicalJson(value),
    requester_principal_ref: authorityBinding.requester_principal_ref,
    requester_credential_generation: authorityBinding.requester_credential_generation,
    server_principal_ref: authorityBinding.server_principal_ref,
    server_credential_generation: authorityBinding.server_credential_generation,
    bridge_generation: authorityBinding.bridge_generation,
    client_fence_ref: authorityBinding.client_fence_ref,
    allowed_manifest_id: authorityBinding.allowed_reference_manifest_ref.id,
    allowed_manifest_revision: authorityBinding.allowed_reference_manifest_ref.revision,
    origin_trace_id: authorityBinding.trace_id,
    attempt: 1,
    transport_state: status.transport_state,
    status_json: canonicalJson(status),
    observed_completion_disposition: cancelled ? "CANCELLED" : null,
    result_json: null,
    cancellation_reason: input.cancellationReason ?? null,
    cancelled_at: cancelledAt,
    created_at: NOW_ISO,
    updated_at: cancelledAt ?? NOW_ISO,
  };
}

describe("D1 federation reference-manifest authority", () => {
  it("persists immutable canonical bytes and returns exact replay", async () => {
    const value = await manifest();
    const createdFixture = databaseFixture([
      null,
      manifestRow(value),
    ]);
    const authority = createD1FederationReferenceManifestAuthority(
      createdFixture.database,
      { now: () => NOW },
    );
    await expect(authority.put(value)).resolves.toMatchObject({
      disposition: "CREATED",
      manifest: value,
    });
    const insert = createdFixture.calls.find((call) => call.method === "run");
    expect(insert?.sql).toContain("INSERT INTO federation_reference_manifest");
    expect(insert?.values[2]).toBe(canonicalJson(value));

    const replayFixture = databaseFixture([manifestRow(value)]);
    await expect(createD1FederationReferenceManifestAuthority(
      replayFixture.database,
      { now: () => NOW },
    ).put(value)).resolves.toMatchObject({ disposition: "EXISTING" });
    expect(replayFixture.calls.some((call) => call.method === "run")).toBe(false);
  });

  it("rejects revision reuse with different valid canonical bytes", async () => {
    const expected = await manifest();
    const occupied = await manifest({ disclosure_ceiling: "restricted" });
    const fixture = databaseFixture([manifestRow(occupied)]);
    await expect(createD1FederationReferenceManifestAuthority(
      fixture.database,
      { now: () => NOW },
    ).put(expected)).rejects.toMatchObject({
      code: "FEDERATION_D1_MANIFEST_CONFLICT",
    });
  });
});

describe("D1 federation job authority", () => {
  it("creates one durable ACCEPTED reservation and replays the exact identity", async () => {
    const allowed = await manifest();
    const value = request();
    const requestDigest = await digest(value);
    const stored = await jobRow({ value, requestDigest });
    const createdFixture = databaseFixture([
      manifestRow(allowed),
      null,
      stored,
    ]);
    const authority = createD1FederationJobAuthority(
      createdFixture.database,
      { now: () => NOW },
    );
    await expect(authority.reserve({
      binding: binding(),
      request: value,
      request_digest: requestDigest,
    })).resolves.toMatchObject({
      outcome: "CREATED",
      request_digest: requestDigest,
      record: {
        status: {
          transport_state: "ACCEPTED",
          completion_disposition: null,
        },
      },
    });
    const insert = createdFixture.calls.find((call) => call.method === "run");
    expect(insert?.sql).toContain("INSERT INTO federation_job");
    expect(insert?.values[3]).toBe(requestDigest);

    const replayFixture = databaseFixture([
      manifestRow(allowed),
      stored,
    ]);
    await expect(createD1FederationJobAuthority(
      replayFixture.database,
      { now: () => NOW },
    ).reserve({
      binding: binding({ trace_id: "retry-trace" }),
      request: value,
      request_digest: requestDigest,
    })).resolves.toMatchObject({ outcome: "REPLAY" });
    expect(replayFixture.calls.some((call) => call.method === "run")).toBe(false);
  });

  it("returns conflict for idempotency-key reuse with different request bytes", async () => {
    const allowed = await manifest();
    const occupiedRequest = request({ question: "A different question" });
    const occupiedDigest = await digest(occupiedRequest);
    const fixture = databaseFixture([
      manifestRow(allowed),
      await jobRow({ value: occupiedRequest, requestDigest: occupiedDigest }),
    ]);
    const expected = request();
    await expect(createD1FederationJobAuthority(
      fixture.database,
      { now: () => NOW },
    ).reserve({
      binding: binding(),
      request: expected,
      request_digest: await digest(expected),
    })).resolves.toEqual({
      outcome: "CONFLICT",
      existing_request_digest: occupiedDigest,
    });
  });

  it("reconciles a lost insert acknowledgement through exact durable readback", async () => {
    const allowed = await manifest();
    const value = request();
    const requestDigest = await digest(value);
    const fixture = databaseFixture([
      manifestRow(allowed),
      null,
      await jobRow({ value, requestDigest }),
    ], [new Error("lost ACK")]);
    await expect(createD1FederationJobAuthority(
      fixture.database,
      { now: () => NOW },
    ).reserve({
      binding: binding(),
      request: value,
      request_digest: requestDigest,
    })).resolves.toMatchObject({ outcome: "REPLAY" });
    expect(fixture.calls.filter((call) => call.method === "run")).toHaveLength(1);
  });

  it("binds reads to the exact principal credential, server generation and fence", async () => {
    const stored = await jobRow();
    const fixture = databaseFixture([stored]);
    await expect(createD1FederationJobAuthority(fixture.database).read(
      binding({ requester_credential_generation: "rotated-credential" }),
      "exchange-1",
      "idempotency-1",
    )).rejects.toMatchObject({ code: "FEDERATION_D1_BINDING_MISMATCH" });
  });

  it("cancels through an exact compare-and-swap and reconciles the receipt", async () => {
    const reason = "operator requested cancellation";
    const active = await jobRow();
    const cancelled = await jobRow({ cancellationReason: reason });
    const fixture = databaseFixture([active, cancelled]);
    const result = await createD1FederationJobAuthority(
      fixture.database,
      { now: () => Date.parse("2026-09-04T15:01:00.000Z") },
    ).cancel(binding(), "exchange-1", "idempotency-1", reason);
    expect(result?.status).toMatchObject({
      transport_state: "CANCELLED",
      completion_disposition: "CANCELLED",
    });
    const update = fixture.calls.find((call) => call.method === "run");
    expect(update?.sql).toContain("status_json = ?1");
    expect(update?.sql).toContain("updated_at = ?7");
    expect(update?.values[1]).toBe(reason);
  });

  it("does not retry an uncertain cancellation mutation", async () => {
    const reason = "lost response after cancellation";
    const fixture = databaseFixture([
      await jobRow(),
      await jobRow({ cancellationReason: reason }),
    ], [new Error("lost ACK")]);
    await expect(createD1FederationJobAuthority(
      fixture.database,
      { now: () => Date.parse("2026-09-04T15:01:00.000Z") },
    ).cancel(
      binding(),
      "exchange-1",
      "idempotency-1",
      reason,
    )).resolves.toMatchObject({
      status: { transport_state: "CANCELLED" },
    });
    expect(fixture.calls.filter((call) => call.method === "run")).toHaveLength(1);
  });

  it("fails closed on corrupted durable request identity", async () => {
    const fixture = databaseFixture([
      await jobRow({ corruptDigest: "f".repeat(64) }),
    ]);
    await expect(createD1FederationJobAuthority(fixture.database).read(
      binding(),
      "exchange-1",
      "idempotency-1",
    )).rejects.toMatchObject({ code: "FEDERATION_D1_INPUT_INVALID" });
  });
});
