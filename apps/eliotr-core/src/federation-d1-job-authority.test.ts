import type { FederationRequest } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  FederationD1JobAuthorityError,
  createD1FederationJobAuthority,
} from "./federation-d1-job-authority.js";
import {
  canonicalFederationJson,
  federationSha256Hex,
  type FederationAuthorityBinding,
  type FederationSubmission,
} from "./federation-service.js";

const T0 = "2026-09-04T13:20:00.000Z";
const T1 = "2026-09-04T13:21:00.000Z";
const COLUMN_ORDER = [
  "requester_principal_ref",
  "requester_credential_generation",
  "server_principal_ref",
  "server_credential_generation",
  "bridge_generation",
  "client_fence_ref",
  "allowed_reference_manifest_id",
  "allowed_reference_manifest_revision",
  "exchange_id",
  "idempotency_key",
  "request_digest",
  "request_json",
  "job_id",
  "attempt",
  "transport_state",
  "completion_disposition",
  "status_json",
  "observed_completion_disposition",
  "result_json",
  "cancellation_reason",
  "state_version",
  "created_at",
  "updated_at",
] as const;

type Row = Record<(typeof COLUMN_ORDER)[number], unknown> & Record<string, unknown>;
type WriteMode = "normal" | "throw-before" | "throw-after" | "race";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function rowKey(values: readonly unknown[]): string {
  return JSON.stringify(values);
}

function identityFromInsert(values: readonly unknown[]): readonly unknown[] {
  return [values[0], values[1], values[2], values[3], values[4], values[5], values[8], values[9]];
}

class D1Fixture {
  public readonly rows = new Map<string, Row>();
  public writeMode: WriteMode = "normal";
  public writeAttempts = 0;
  public mutations = 0;
  public readonly database: D1Database;

  public constructor() {
    this.database = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async <T>(): Promise<T | null> =>
            this.execute(sql, values) as T | null,
        }),
      }),
    } as unknown as D1Database;
  }

  public onlyRow(): Row {
    const values = [...this.rows.values()];
    if (values.length !== 1 || values[0] === undefined) {
      throw new Error(`expected exactly one row, found ${values.length}`);
    }
    return values[0];
  }

  private execute(sql: string, values: readonly unknown[]): Row | null {
    if (sql.startsWith("SELECT ")) {
      return clone(this.rows.get(rowKey(values.slice(0, 8))) ?? null);
    }
    if (sql.startsWith("INSERT ")) return this.insert(values);
    if (sql.startsWith("UPDATE ")) return this.update(values);
    throw new Error(`unexpected SQL: ${sql}`);
  }

  private beforeWrite(): void {
    this.writeAttempts += 1;
    if (this.writeMode === "throw-before") {
      this.writeMode = "normal";
      throw new Error("fixture D1 write failed before mutation");
    }
  }

  private afterWrite(row: Row): Row {
    if (this.writeMode === "throw-after") {
      this.writeMode = "normal";
      throw new Error("fixture lost D1 acknowledgement");
    }
    return clone(row);
  }

  private insert(values: readonly unknown[]): Row | null {
    this.beforeWrite();
    const key = rowKey(identityFromInsert(values));
    if (this.rows.has(key)) return null;
    const row = Object.fromEntries(
      COLUMN_ORDER.map((column, index) => [column, values[index]]),
    ) as Row;
    this.rows.set(key, row);
    this.mutations += 1;
    return this.afterWrite(row);
  }

  private update(values: readonly unknown[]): Row | null {
    this.beforeWrite();
    const key = rowKey(values.slice(0, 8));
    const row = this.rows.get(key);
    if (row === undefined) return null;
    if (this.writeMode === "race") {
      this.writeMode = "normal";
      row.transport_state = "RUNNING";
      row.status_json = canonicalFederationJson({
        ...JSON.parse(String(row.status_json)) as Record<string, unknown>,
        transport_state: "RUNNING",
      });
      row.state_version = Number(row.state_version) + 1;
      row.updated_at = T1;
      return null;
    }
    if (
      row.state_version !== values[12] ||
      !["ACCEPTED", "RUNNING", "PARTIAL", "BLOCKED"].includes(
        String(row.transport_state),
      )
    ) {
      return null;
    }
    row.transport_state = "CANCELLED";
    row.completion_disposition = "CANCELLED";
    row.status_json = values[8];
    row.observed_completion_disposition = "CANCELLED";
    row.result_json = null;
    row.cancellation_reason = values[9];
    row.state_version = values[10];
    row.updated_at = values[11];
    this.mutations += 1;
    return this.afterWrite(row);
  }
}

function binding(overrides: Partial<FederationAuthorityBinding> = {}): FederationAuthorityBinding {
  return {
    requester_principal_ref: "client-principal",
    requester_credential_generation: "client-credential-generation-1",
    server_principal_ref: "server-principal",
    server_credential_generation: "server-credential-generation-1",
    bridge_generation: "bridge-generation-1",
    client_fence_ref: "client-fence-1",
    allowed_reference_manifest_ref: {
      id: "allowed-reference-manifest",
      revision: 1,
    },
    trace_id: "trace-1",
    ...overrides,
  };
}

function request(overrides: Partial<FederationRequest> = {}): FederationRequest {
  return {
    protocol: "eliotr.federation.v1",
    exchange_id: "exchange-1",
    bridge_generation: "bridge-generation-1",
    idempotency_key: "idempotency-1",
    requester_principal_ref: "client-principal",
    client_fence_ref: "client-fence-1",
    question: "What evidence is available?",
    scope_expression: { kind: "PROJECT", project_id: "project-1" },
    expected_decision_or_artifact: "evidence bundle",
    source_classes: ["primary"],
    coverage_goal: "high_recall",
    allowed_input_handle_refs: [{ id: "evidence-handle", revision: 1 }],
    privacy_policy_ref: "privacy-policy-1",
    disclosure_policy_ref: "disclosure-policy-1",
    retention_policy_ref: "retention-policy-1",
    license_policy_ref: "license-policy-1",
    residency_profile_ref: "residency-profile-1",
    budget_ref: "budget-1",
    deadline: "2026-09-05T13:20:00.000Z",
    stop_rule_ref: "stop-rule-1",
    progress_contract_ref: "progress-contract-1",
    required_result_schema_ref: "result-schema-1",
    evidence_grade: "E2",
    ...overrides,
  };
}

async function submission(
  requestOverrides: Partial<FederationRequest> = {},
  bindingOverrides: Partial<FederationAuthorityBinding> = {},
): Promise<FederationSubmission> {
  const selectedRequest = request(requestOverrides);
  const selectedBinding = binding(bindingOverrides);
  return {
    binding: selectedBinding,
    request: selectedRequest,
    request_digest: await federationSha256Hex(
      canonicalFederationJson(selectedRequest),
    ),
  };
}

function authority(fixture: D1Fixture, timestamps = [T0, T1]) {
  let index = 0;
  return createD1FederationJobAuthority(fixture.database, {
    now: () => timestamps[Math.min(index++, timestamps.length - 1)] ?? T1,
  });
}

function expectAuthorityError(code: string) {
  return expect.objectContaining({
    name: "FederationD1JobAuthorityError",
    code,
  });
}

describe("D1 federation job authority", () => {
  it("reserves one exact durable job and reads it under the same authority", async () => {
    const fixture = new D1Fixture();
    const service = authority(fixture);
    const input = await submission();

    const reserved = await service.reserve(input);
    expect(reserved).toMatchObject({
      outcome: "CREATED",
      request_digest: input.request_digest,
      record: {
        status: {
          exchange_id: "exchange-1",
          idempotency_key: "idempotency-1",
          attempt: 1,
          transport_state: "ACCEPTED",
          completion_disposition: null,
        },
        observed_completion_disposition: null,
        result: null,
      },
    });
    await expect(
      service.read(input.binding, "exchange-1", "idempotency-1"),
    ).resolves.toEqual(reserved.record);
    expect(fixture.writeAttempts).toBe(1);
    expect(fixture.mutations).toBe(1);
  });

  it("replays immutable submission identity after durable progress", async () => {
    const fixture = new D1Fixture();
    const service = authority(fixture);
    const input = await submission();
    await service.reserve(input);

    const row = fixture.onlyRow();
    const currentStatus = JSON.parse(String(row.status_json)) as Record<string, unknown>;
    row.transport_state = "RUNNING";
    row.status_json = canonicalFederationJson({
      ...currentStatus,
      transport_state: "RUNNING",
    });
    row.state_version = 2;
    row.updated_at = T1;

    await expect(service.reserve(input)).resolves.toMatchObject({
      outcome: "REPLAY",
      record: { status: { transport_state: "RUNNING" } },
    });
    expect(fixture.writeAttempts).toBe(2);
    expect(fixture.mutations).toBe(1);
  });

  it("returns conflict for payload substitution under one idempotency identity", async () => {
    const fixture = new D1Fixture();
    const service = authority(fixture);
    const first = await submission();
    const substituted = await submission({ question: "A different question" });
    await service.reserve(first);

    await expect(service.reserve(substituted)).resolves.toEqual({
      outcome: "CONFLICT",
      existing_request_digest: first.request_digest,
    });
    expect(fixture.mutations).toBe(1);
  });

  it("rejects cross-manifest reads instead of leaking job existence", async () => {
    const fixture = new D1Fixture();
    const service = authority(fixture);
    const input = await submission();
    await service.reserve(input);

    await expect(
      service.read(
        binding({
          allowed_reference_manifest_ref: {
            id: "allowed-reference-manifest",
            revision: 2,
          },
        }),
        "exchange-1",
        "idempotency-1",
      ),
    ).rejects.toEqual(expectAuthorityError("FEDERATION_JOB_AUTHORITY_MISMATCH"));
  });

  it("cancels through state-version CAS and replays only the same reason", async () => {
    const fixture = new D1Fixture();
    const service = authority(fixture);
    const input = await submission();
    await service.reserve(input);

    const cancelled = await service.cancel(
      input.binding,
      "exchange-1",
      "idempotency-1",
      "operator requested cancellation",
    );
    expect(cancelled).toMatchObject({
      status: {
        transport_state: "CANCELLED",
        completion_disposition: "CANCELLED",
        cancellation_receipt_ref: expect.stringMatching(/^cancel-[a-f0-9]{64}$/u),
      },
      observed_completion_disposition: "CANCELLED",
      result: null,
    });
    const writesAfterCancel = fixture.writeAttempts;
    await expect(
      service.cancel(
        input.binding,
        "exchange-1",
        "idempotency-1",
        "operator requested cancellation",
      ),
    ).resolves.toEqual(cancelled);
    expect(fixture.writeAttempts).toBe(writesAfterCancel);
    await expect(
      service.cancel(
        input.binding,
        "exchange-1",
        "idempotency-1",
        "different reason",
      ),
    ).rejects.toEqual(expectAuthorityError("FEDERATION_JOB_CANCEL_CONFLICT"));
  });

  it("reconciles a lost cancellation acknowledgement without a second write", async () => {
    const fixture = new D1Fixture();
    const service = authority(fixture);
    const input = await submission();
    await service.reserve(input);
    fixture.writeMode = "throw-after";

    await expect(
      service.cancel(
        input.binding,
        "exchange-1",
        "idempotency-1",
        "operator requested cancellation",
      ),
    ).resolves.toMatchObject({ status: { transport_state: "CANCELLED" } });
    expect(fixture.writeAttempts).toBe(2);
    expect(fixture.mutations).toBe(2);
  });

  it("never retries a reservation or cancellation with an unknown D1 effect", async () => {
    const reserveFixture = new D1Fixture();
    reserveFixture.writeMode = "throw-before";
    const reserveService = authority(reserveFixture);
    await expect(
      reserveService.reserve(await submission()),
    ).rejects.toEqual(expect.objectContaining({
      code: "FEDERATION_JOB_WRITE_UNCERTAIN",
      ambiguous_effect: "FEDERATION_JOB_WRITE",
    }));
    expect(reserveFixture.writeAttempts).toBe(1);
    expect(reserveFixture.mutations).toBe(0);

    const cancelFixture = new D1Fixture();
    const cancelService = authority(cancelFixture);
    const input = await submission();
    await cancelService.reserve(input);
    cancelFixture.writeMode = "throw-before";
    await expect(
      cancelService.cancel(
        input.binding,
        "exchange-1",
        "idempotency-1",
        "operator requested cancellation",
      ),
    ).rejects.toEqual(expect.objectContaining({
      code: "FEDERATION_JOB_WRITE_UNCERTAIN",
      ambiguous_effect: "FEDERATION_JOB_WRITE",
    }));
    expect(cancelFixture.writeAttempts).toBe(2);
    expect(cancelFixture.mutations).toBe(1);
  });

  it("surfaces a stale cancellation state-version as a retryable conflict", async () => {
    const fixture = new D1Fixture();
    const service = authority(fixture);
    const input = await submission();
    await service.reserve(input);
    fixture.writeMode = "race";

    await expect(
      service.cancel(
        input.binding,
        "exchange-1",
        "idempotency-1",
        "operator requested cancellation",
      ),
    ).rejects.toEqual(expect.objectContaining({
      code: "FEDERATION_JOB_WRITE_CONFLICT",
      retryable: true,
    }));
    expect(fixture.mutations).toBe(1);
  });

  it("fails closed on noncanonical or authority-shaped D1 readback", async () => {
    const fixture = new D1Fixture();
    const service = authority(fixture);
    const input = await submission();
    await service.reserve(input);

    const row = fixture.onlyRow();
    row.status_json = JSON.stringify(JSON.parse(String(row.status_json)), null, 2);
    await expect(
      service.read(input.binding, "exchange-1", "idempotency-1"),
    ).rejects.toEqual(expectAuthorityError("FEDERATION_JOB_READBACK_INVALID"));

    row.status_json = canonicalFederationJson(JSON.parse(String(row.status_json)));
    row.unexpected_authority = "forged";
    await expect(
      service.read(input.binding, "exchange-1", "idempotency-1"),
    ).rejects.toEqual(expectAuthorityError("FEDERATION_JOB_READBACK_INVALID"));
  });

  it("refuses cancellation after terminal completion", async () => {
    const fixture = new D1Fixture();
    const service = authority(fixture);
    const input = await submission();
    await service.reserve(input);
    const row = fixture.onlyRow();
    const currentStatus = JSON.parse(String(row.status_json)) as Record<string, unknown>;
    row.transport_state = "COMPLETED";
    row.completion_disposition = "INCONCLUSIVE";
    row.observed_completion_disposition = "INCONCLUSIVE";
    row.status_json = canonicalFederationJson({
      ...currentStatus,
      transport_state: "COMPLETED",
      completion_disposition: "INCONCLUSIVE",
      terminal_receipt_ref: "terminal-receipt-1",
    });
    row.state_version = 2;
    row.updated_at = T1;

    await expect(
      service.cancel(
        input.binding,
        "exchange-1",
        "idempotency-1",
        "too late",
      ),
    ).rejects.toEqual(expectAuthorityError("FEDERATION_JOB_TERMINAL"));
  });

  it("rejects an invalid CORE_DB binding at composition time", () => {
    expect(() => createD1FederationJobAuthority({} as D1Database)).toThrow(
      FederationD1JobAuthorityError,
    );
  });
});
