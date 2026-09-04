import type {
  AllowedReferenceManifest,
  FederationJobStatus,
  FederationRequest,
} from "@eliotr/contracts";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import { describe, expect, it } from "vitest";
import {
  createD1FederationJobAuthority,
  createD1FederationManifestStore,
  federationCancellationReceiptRef,
  federationCanonicalJson,
  stableFederationJobId,
} from "../apps/eliotr-core/src/federation-d1-authority.js";
import type {
  FederationAuthorityBinding,
} from "../apps/eliotr-core/src/federation-service.js";

const NOW = Date.parse("2026-09-04T15:00:00.000Z");
const CREATED = "2026-09-04T15:00:00.000Z";
const CANCELLED = "2026-09-04T15:01:00.000Z";
const FUTURE = "2026-09-05T15:00:00.000Z";
const MANIFEST_REF = { id: "federation-manifest-1", revision: 1 } as const;
const SCOPE_REF = { id: "scope-snapshot-1", revision: 1 } as const;
type Database = Parameters<typeof createD1FederationJobAuthority>[0];
interface Call {
  readonly method: "first" | "run";
  readonly sql: string;
  readonly values: readonly unknown[];
}
type FirstValue = Record<string, unknown> | null | Error;
type RunValue = { readonly meta?: { readonly changes?: number } } | Error;

function changed(changes = 1): RunValue {
  return { meta: { changes } };
}

function database(
  firstValues: readonly FirstValue[],
  runValues: readonly RunValue[] = [],
): { readonly db: Database; readonly calls: Call[] } {
  const calls: Call[] = [];
  let firstIndex = 0;
  let runIndex = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              calls.push({ method: "first", sql, values });
              const result = firstValues[firstIndex++] ?? null;
              if (result instanceof Error) throw result;
              return result as T | null;
            },
            async run() {
              calls.push({ method: "run", sql, values });
              const result = runValues[runIndex++] ?? changed();
              if (result instanceof Error) throw result;
              return result;
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Database, calls };
}

function binding(
  overrides: Partial<FederationAuthorityBinding> = {},
): FederationAuthorityBinding {
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
  return {
    ...payload,
    manifest_digest: await canonicalDigest(payload),
  };
}

function request(
  overrides: Partial<FederationRequest> = {},
): FederationRequest {
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
    manifest_json: federationCanonicalJson(value),
    manifest_digest: value.manifest_digest,
    scope_snapshot_id: value.scope_snapshot_ref.id,
    scope_snapshot_revision: value.scope_snapshot_ref.revision,
    client_fence_ref: value.client_fence_ref ?? null,
    expires_at: value.expires_at,
    created_at: CREATED,
  };
}

async function jobRow(input: {
  readonly value?: FederationRequest;
  readonly authorityBinding?: FederationAuthorityBinding;
  readonly cancellationReason?: string;
  readonly corruptDigest?: string;
  readonly cancellationReceipt?: string;
} = {}): Promise<Record<string, unknown>> {
  const value = input.value ?? request();
  const authorityBinding = input.authorityBinding ?? binding();
  const requestDigest = await canonicalDigest(value);
  const jobId = await stableFederationJobId(
    authorityBinding,
    value,
    requestDigest,
  );
  const reason = input.cancellationReason;
  const receipt = reason === undefined
    ? undefined
    : input.cancellationReceipt ??
      await federationCancellationReceiptRef(jobId, reason);
  const status: FederationJobStatus = {
    exchange_id: value.exchange_id,
    idempotency_key: value.idempotency_key,
    job_id: jobId,
    attempt: 1,
    transport_state: reason === undefined ? "ACCEPTED" : "CANCELLED",
    completion_disposition: reason === undefined ? null : "CANCELLED",
    completed_obligation_refs: [],
    partial_bundle_refs: [],
    open_research_debt_refs: [],
    ...(receipt === undefined
      ? {}
      : {
          cancellation_receipt_ref: receipt,
          terminal_receipt_ref: receipt,
        }),
  };
  return {
    job_id: jobId,
    exchange_id: value.exchange_id,
    idempotency_key: value.idempotency_key,
    request_digest: input.corruptDigest ?? requestDigest,
    request_json: federationCanonicalJson(value),
    requester_principal_ref: authorityBinding.requester_principal_ref,
    requester_credential_generation:
      authorityBinding.requester_credential_generation,
    server_principal_ref: authorityBinding.server_principal_ref,
    server_credential_generation:
      authorityBinding.server_credential_generation,
    bridge_generation: authorityBinding.bridge_generation,
    client_fence_ref: authorityBinding.client_fence_ref,
    allowed_manifest_id: authorityBinding.allowed_reference_manifest_ref.id,
    allowed_manifest_revision:
      authorityBinding.allowed_reference_manifest_ref.revision,
    origin_trace_id: authorityBinding.trace_id,
    attempt: 1,
    transport_state: status.transport_state,
    status_json: federationCanonicalJson(status),
    observed_completion_disposition: reason === undefined ? null : "CANCELLED",
    result_json: null,
    cancellation_reason: reason ?? null,
    cancelled_at: reason === undefined ? null : CANCELLED,
    created_at: CREATED,
    updated_at: reason === undefined ? CREATED : CANCELLED,
  };
}

describe("ER-41 D1 federation manifest authority", () => {
  it("creates canonical immutable bytes and returns an exact replay", async () => {
    const value = await manifest();
    const created = database([null, manifestRow(value)]);
    await expect(createD1FederationManifestStore(
      created.db,
      () => NOW,
    ).put(value)).resolves.toMatchObject({
      disposition: "CREATED",
      manifest: value,
    });
    expect(created.calls.filter((call) => call.method === "run")).toHaveLength(1);
    expect(created.calls.find((call) => call.method === "run")?.values[2])
      .toBe(federationCanonicalJson(value));

    const replay = database([manifestRow(value)]);
    await expect(createD1FederationManifestStore(
      replay.db,
      () => NOW,
    ).put(value)).resolves.toMatchObject({ disposition: "EXISTING" });
    expect(replay.calls.some((call) => call.method === "run")).toBe(false);
  });

  it("reconciles a lost manifest insert acknowledgement by exact readback", async () => {
    const value = await manifest();
    const fixture = database(
      [null, manifestRow(value)],
      [new Error("lost ACK")],
    );
    await expect(createD1FederationManifestStore(
      fixture.db,
      () => NOW,
    ).put(value)).resolves.toMatchObject({ disposition: "EXISTING" });
    expect(fixture.calls.filter((call) => call.method === "run")).toHaveLength(1);
  });

  it("rejects revision reuse with different valid bytes", async () => {
    const current = await manifest();
    const replacement = await manifest({ disclosure_ceiling: "restricted" });
    await expect(createD1FederationManifestStore(
      database([manifestRow(current)]).db,
      () => NOW,
    ).put(replacement)).rejects.toMatchObject({
      code: "FEDERATION_D1_MANIFEST_CONFLICT",
    });
  });
});

describe("ER-41 D1 federation job authority", () => {
  it("creates one ACCEPTED job and replays the exact identity", async () => {
    const allowed = await manifest();
    const value = request();
    const requestDigest = await canonicalDigest(value);
    const stored = await jobRow({ value });
    const created = database([
      manifestRow(allowed),
      null,
      stored,
    ]);
    await expect(createD1FederationJobAuthority(
      created.db,
      () => NOW,
    ).reserve({
      binding: binding(),
      request: value,
      request_digest: requestDigest,
    })).resolves.toMatchObject({
      outcome: "CREATED",
      record: {
        status: {
          transport_state: "ACCEPTED",
          completion_disposition: null,
        },
      },
    });
    expect(created.calls.filter((call) => call.method === "run")).toHaveLength(1);

    const replay = database([
      manifestRow(allowed),
      stored,
    ]);
    await expect(createD1FederationJobAuthority(
      replay.db,
      () => NOW,
    ).reserve({
      binding: binding({ trace_id: "retry-trace" }),
      request: value,
      request_digest: requestDigest,
    })).resolves.toMatchObject({ outcome: "REPLAY" });
    expect(replay.calls.some((call) => call.method === "run")).toBe(false);
  });

  it("returns conflict for idempotency payload substitution", async () => {
    const allowed = await manifest();
    const occupied = request({ question: "A different question" });
    const expected = request();
    await expect(createD1FederationJobAuthority(
      database([
        manifestRow(allowed),
        await jobRow({ value: occupied }),
      ]).db,
      () => NOW,
    ).reserve({
      binding: binding(),
      request: expected,
      request_digest: await canonicalDigest(expected),
    })).resolves.toMatchObject({
      outcome: "CONFLICT",
      existing_request_digest: await canonicalDigest(occupied),
    });
  });

  it("does not disclose another authority binding as an idempotency conflict", async () => {
    const allowed = await manifest();
    const foreignBinding = binding({
      requester_credential_generation: "foreign-credential",
    });
    await expect(createD1FederationJobAuthority(
      database([
        manifestRow(allowed),
        await jobRow({ authorityBinding: foreignBinding }),
      ]).db,
      () => NOW,
    ).reserve({
      binding: binding(),
      request: request(),
      request_digest: await canonicalDigest(request()),
    })).rejects.toMatchObject({
      code: "FEDERATION_D1_BINDING_MISMATCH",
    });
  });

  it("reconciles a lost reservation acknowledgement without retry", async () => {
    const allowed = await manifest();
    const value = request();
    const fixture = database([
      manifestRow(allowed),
      null,
      await jobRow({ value }),
    ], [new Error("lost ACK")]);
    await expect(createD1FederationJobAuthority(
      fixture.db,
      () => NOW,
    ).reserve({
      binding: binding(),
      request: value,
      request_digest: await canonicalDigest(value),
    })).resolves.toMatchObject({ outcome: "REPLAY" });
    expect(fixture.calls.filter((call) => call.method === "run")).toHaveLength(1);
  });

  it("binds reads to exact peer generations and rejects corrupt rows", async () => {
    await expect(createD1FederationJobAuthority(
      database([await jobRow()]).db,
    ).read(
      binding({ requester_credential_generation: "rotated-credential" }),
      "exchange-1",
      "idempotency-1",
    )).rejects.toMatchObject({
      code: "FEDERATION_D1_BINDING_MISMATCH",
    });

    await expect(createD1FederationJobAuthority(
      database([await jobRow({ corruptDigest: "f".repeat(64) })]).db,
    ).read(
      binding(),
      "exchange-1",
      "idempotency-1",
    )).rejects.toMatchObject({
      code: "FEDERATION_D1_INPUT_INVALID",
    });
  });

  it("cancels with exact CAS and reconciles a lost acknowledgement", async () => {
    const reason = "operator requested cancellation";
    const first = database([
      await jobRow(),
      await jobRow({ cancellationReason: reason }),
    ]);
    await expect(createD1FederationJobAuthority(
      first.db,
      () => Date.parse(CANCELLED),
    ).cancel(
      binding(),
      "exchange-1",
      "idempotency-1",
      reason,
    )).resolves.toMatchObject({
      status: {
        transport_state: "CANCELLED",
        completion_disposition: "CANCELLED",
      },
    });
    const update = first.calls.find((call) => call.method === "run");
    expect(update?.sql).toContain("status_json=?1");
    expect(update?.sql).toContain("updated_at=?7");

    const lost = database([
      await jobRow(),
      await jobRow({ cancellationReason: reason }),
    ], [new Error("lost ACK")]);
    await expect(createD1FederationJobAuthority(
      lost.db,
      () => Date.parse(CANCELLED),
    ).cancel(
      binding(),
      "exchange-1",
      "idempotency-1",
      reason,
    )).resolves.toMatchObject({
      status: { transport_state: "CANCELLED" },
    });
    expect(lost.calls.filter((call) => call.method === "run")).toHaveLength(1);
  });

  it("rejects cancellation reason rebinding and forged receipt bytes", async () => {
    const existing = database([
      await jobRow({ cancellationReason: "first reason" }),
    ]);
    await expect(createD1FederationJobAuthority(existing.db).cancel(
      binding(),
      "exchange-1",
      "idempotency-1",
      "second reason",
    )).rejects.toMatchObject({
      code: "FEDERATION_D1_STATE_CONFLICT",
    });
    expect(existing.calls.some((call) => call.method === "run")).toBe(false);

    const forged = database([
      await jobRow({
        cancellationReason: "first reason",
        cancellationReceipt: "forged-receipt",
      }),
    ]);
    await expect(createD1FederationJobAuthority(forged.db).read(
      binding(),
      "exchange-1",
      "idempotency-1",
    )).rejects.toMatchObject({
      code: "FEDERATION_D1_INPUT_INVALID",
    });
  });
});
