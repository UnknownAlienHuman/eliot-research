import { describe, expect, it, vi } from "vitest";
import {
  canonicalModelGatewayJson,
  ModelGatewayExecutionError,
  modelGatewaySha256,
  type ModelGatewayPricingPort,
} from "@eliotr/cloudflare-ai";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  createD1ResearchModelSpendObserver,
  RESEARCH_MODEL_SPEND_OBSERVATION_PROTOCOL,
  ResearchModelSpendObservationError,
  type OperationSpendObservation,
  type SpendObservationInput,
  type SpendObservationReport,
} from "./research-model-spend-observation.js";

const WINDOW = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
const SNAPSHOT_REF = "pricing-snapshot-1";
const NOW_MS = Date.parse("2026-10-01T12:00:00.000Z");

const FINGERPRINT = {
  route_ref: "dynamic/eliotr-balanced",
  route_version: "v1",
  prompt_generation: "pg-1",
  schema_generation: "sg-1",
  parameters_digest: "a".repeat(64),
  pricing_snapshot_ref: SNAPSHOT_REF,
  provider: "workers-ai",
  exact_model_id: "@cf/meta/llama-3.1-8b-instruct",
};

interface Fixture {
  readonly fingerprintRef: string;
  readonly fingerprintRow: Record<string, unknown>;
}

async function buildFingerprint(): Promise<Fixture> {
  const canonical = canonicalModelGatewayJson(FINGERPRINT);
  const sha = await modelGatewaySha256(canonical);
  const fingerprintRef = `route-fingerprint-${sha}`;
  return {
    fingerprintRef,
    fingerprintRow: {
      observation_seq: 1,
      fingerprint_ref: fingerprintRef,
      route_ref: FINGERPRINT.route_ref,
      fingerprint_sha256: sha,
      fingerprint_json: canonical,
      observed_at: "2026-06-01T00:00:00.000Z",
    },
  };
}

async function buildReceipt(
  billedUsd: number,
  fingerprintRef: string,
  inputTokens = 1000,
  outputTokens = 500,
): Promise<{ receipt_json: string; receipt_sha256: string }> {
  const receipt = {
    receipt_ref: "receipt-1",
    route_fingerprint_ref: fingerprintRef,
    output_object_ref: "output-1",
    output_sha256: "b".repeat(64),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    billed_usd: billedUsd,
  };
  const receipt_json = canonicalJson(receipt);
  const receipt_sha256 = await modelGatewaySha256(receipt_json);
  return { receipt_json, receipt_sha256 };
}

function buildQuote(platform: number, workersAi: number, byok: number, maxTotal: number): string {
  return canonicalJson({
    quote_ref: "quote-1",
    reservation_id: "reservation-1",
    operation_kind: "RESEARCH",
    estimated_model_calls: 1,
    estimated_input_tokens: 1000,
    estimated_output_tokens: 500,
    estimated_embedding_tokens: 0,
    quoted_neurons: 0,
    selected_routes: ["dynamic/eliotr-balanced"],
    platform_usd: platform,
    workers_ai_usd: workersAi,
    byok_usd: byok,
    max_total_usd: maxTotal,
    workflow_steps: 1,
    expected_sources: 1,
    expected_sections: 1,
    confidence: 0.9,
    expires_at: "2026-10-02T00:00:00.000Z",
  });
}

function admissionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authorization_ref: "auth-1",
    operation_id: "model-operation-1",
    workflow_operation_id: "workflow-operation-1",
    stage_index: 12,
    reservation_id: "reservation-1",
    quote_json: buildQuote(0.01, 0.02, 0.005, 0.1),
    route_ref: "dynamic/eliotr-balanced",
    principal_ref: "owner",
    created_at: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

function attemptRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attempt_id: "model-attempt-1",
    reservation_id: "reservation-1",
    operation_kind: "RESEARCH",
    state: "SUCCEEDED",
    receipt_json: null,
    receipt_sha256: null,
    started_at: "2026-09-15T01:00:00.000Z",
    ...overrides,
  };
}

interface MockTables {
  admissions: Record<string, unknown>[];
  attempts: Record<string, unknown>[];
  orphans: Record<string, unknown>[];
  fingerprints: Record<string, Record<string, unknown>>;
}

function mockDatabase(tables: MockTables): D1Database {
  const prepare = vi.fn((sql: string) => ({
    bind: (...args: unknown[]) => ({
      all: async () => {
        if (sql.includes("research_model_attempt") && sql.includes("NOT EXISTS")) return { results: tables.orphans };
        if (sql.includes("research_model_attempt")) return { results: tables.attempts };
        if (sql.includes("research_model_spend_admission")) return { results: tables.admissions };
        throw new Error(`unexpected SQL in spend observation test: ${sql}`);
      },
      first: async () => {
        if (sql.includes("research_model_fingerprint")) {
          return tables.fingerprints[args[0] as string] ?? null;
        }
        return null;
      },
    }),
  }));
  return { prepare } as unknown as D1Database;
}

function pricingPort(billedUsd: number | Error): ModelGatewayPricingPort {
  return {
    quote: async (input) => {
      if (billedUsd instanceof Error) throw billedUsd;
      return Object.freeze({
        quote_ref: "repriced-quote-1",
        pricing_snapshot_ref: input.pricing_snapshot_ref,
        billed_usd: billedUsd,
      });
    },
  };
}

function baseInput(overrides: Partial<SpendObservationInput> = {}): SpendObservationInput {
  return {
    window: WINDOW,
    pricing_snapshot_ref: SNAPSHOT_REF,
    cost_targets: { max_usd_per_operation: 0.05, max_total_usd: 1 },
    ...overrides,
  };
}

/** Fail-fast accessor: the fixtures below always observe exactly one operation. */
function firstOperation(report: SpendObservationReport): OperationSpendObservation {
  const operation = report.operations[0];
  if (operation === undefined) throw new Error("expected one observed operation");
  return operation;
}

async function happyFixture(billedUsd = 0.025, repricedUsd = 0.025): Promise<{
  tables: MockTables;
  observer: ReturnType<typeof createD1ResearchModelSpendObserver>;
  input: SpendObservationInput;
}> {
  const { fingerprintRef, fingerprintRow } = await buildFingerprint();
  const receipt = await buildReceipt(billedUsd, fingerprintRef);
  const tables: MockTables = {
    admissions: [admissionRow()],
    attempts: [attemptRow({ ...receipt })],
    orphans: [],
    fingerprints: { [fingerprintRef]: fingerprintRow },
  };
  const observer = createD1ResearchModelSpendObserver(mockDatabase(tables), {
    pricing: pricingPort(repricedUsd),
    now: () => NOW_MS,
  });
  return { tables, observer, input: baseInput() };
}

describe("research-model-spend-observation", () => {
  it("observes quoted vs actual vs repriced cost and passes a settled operation", async () => {
    const { observer, input } = await happyFixture();
    const report = await observer.observe(input);
    expect(report.protocol).toBe(RESEARCH_MODEL_SPEND_OBSERVATION_PROTOCOL);
    expect(report.observation_ref).toMatch(/^spend-observation-[a-f0-9]{64}$/);
    expect(report.verdict).toBe("PASS");
    expect(report.empty_window).toBe(false);
    expect(report.operations).toHaveLength(1);
    const operation = firstOperation(report);
    expect(operation.settlement).toBe("SETTLED");
    expect(operation.quoted.quoted_total_usd).toBeCloseTo(0.03, 9);
    expect(operation.quoted.max_total_usd).toBe(0.1);
    expect(operation.actual_usd).toBeCloseTo(0.025, 9);
    expect(operation.repriced_usd).toBeCloseTo(0.025, 9);
    expect(operation.repricing.status).toBe("AVAILABLE");
    // BYOK is reported separately and never mixed into billed totals.
    expect(operation.byok_usd).toBe(0.005);
    expect(report.aggregate.byok_total_usd).toBeCloseTo(0.005, 9);
    expect(report.aggregate.actual_total_usd).toBeCloseTo(0.025, 9);
    expect(report.aggregate.repriced_total_usd).toBeCloseTo(0.025, 9);
    expect(report.aggregate.reprice_complete).toBe(true);
    expect(report.aggregate.per_operation_kind["RESEARCH"]).toEqual({
      count: 1,
      p50_actual_usd: expect.any(Number),
      p95_actual_usd: expect.any(Number),
    });
    expect(report.orphans).toEqual([]);
  });

  it("fails the operation when the receipt digest is corrupt", async () => {
    const { fingerprintRef } = await buildFingerprint();
    const receipt = await buildReceipt(0.025, fingerprintRef);
    const tables: MockTables = {
      admissions: [admissionRow()],
      attempts: [attemptRow({ ...receipt, receipt_sha256: "0".repeat(64) })],
      orphans: [],
      fingerprints: {},
    };
    const observer = createD1ResearchModelSpendObserver(mockDatabase(tables), {
      pricing: pricingPort(0.025),
      now: () => NOW_MS,
    });
    const report = await observer.observe(baseInput());
    expect(report.verdict).toBe("FAIL");
    expect(firstOperation(report).verdict).toBe("FAIL");
    expect(firstOperation(report).reasons).toContain("READBACK_CORRUPT");
  });

  it("fails the operation when an attempt is still STARTED (unsettled cannot pass)", async () => {
    const tables: MockTables = {
      admissions: [admissionRow()],
      attempts: [attemptRow({ state: "STARTED", receipt_json: null, receipt_sha256: null })],
      orphans: [],
      fingerprints: {},
    };
    const observer = createD1ResearchModelSpendObserver(mockDatabase(tables), {
      pricing: pricingPort(0.025),
      now: () => NOW_MS,
    });
    const report = await observer.observe(baseInput());
    expect(firstOperation(report).settlement).toBe("UNSETTLED");
    expect(firstOperation(report).verdict).toBe("FAIL");
    expect(firstOperation(report).reasons).toContain("UNSETTLED_ATTEMPT");
    expect(firstOperation(report).actual_usd).toBeNull();
    expect(report.verdict).toBe("FAIL");
  });

  it("blocks the operation when the pricing snapshot is missing", async () => {
    const { fingerprintRef, fingerprintRow } = await buildFingerprint();
    const receipt = await buildReceipt(0.025, fingerprintRef);
    const tables: MockTables = {
      admissions: [admissionRow()],
      attempts: [attemptRow({ ...receipt })],
      orphans: [],
      fingerprints: { [fingerprintRef]: fingerprintRow },
    };
    const observer = createD1ResearchModelSpendObserver(mockDatabase(tables), {
      pricing: pricingPort(
        new ModelGatewayExecutionError("MODEL_GATEWAY_PRICING_FAILED", "approved pricing snapshot is unavailable"),
      ),
      now: () => NOW_MS,
    });
    const report = await observer.observe(baseInput());
    expect(firstOperation(report).verdict).toBe("BLOCKED");
    expect(firstOperation(report).reasons).toContain("PRICING_SNAPSHOT_MISSING");
    expect(firstOperation(report).repriced_usd).toBeNull();
    // Billed actuals are still observed from the receipt.
    expect(firstOperation(report).actual_usd).toBeCloseTo(0.025, 9);
    expect(report.verdict).toBe("BLOCKED");
    expect(report.aggregate.reprice_complete).toBe(false);
  });

  it("blocks the report on an empty window (never a pass)", async () => {
    const tables: MockTables = { admissions: [], attempts: [], orphans: [], fingerprints: {} };
    const observer = createD1ResearchModelSpendObserver(mockDatabase(tables), {
      pricing: pricingPort(0.025),
      now: () => NOW_MS,
    });
    const report = await observer.observe(baseInput());
    expect(report.verdict).toBe("BLOCKED");
    expect(report.empty_window).toBe(true);
    expect(report.operations).toEqual([]);
    expect(report.aggregate.operations_observed).toBe(0);
    expect(report.aggregate.actual_total_usd).toBe(0);
  });

  it("fails the report on orphan attempts that have no spend admission", async () => {
    const tables: MockTables = {
      admissions: [],
      attempts: [],
      orphans: [
        { attempt_id: "model-attempt-orphan", reservation_id: "reservation-orphan", state: "SUCCEEDED", started_at: "2026-09-20T00:00:00.000Z" },
      ],
      fingerprints: {},
    };
    const observer = createD1ResearchModelSpendObserver(mockDatabase(tables), {
      pricing: pricingPort(0.025),
      now: () => NOW_MS,
    });
    const report = await observer.observe(baseInput());
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0]).toEqual({
      attempt_id: "model-attempt-orphan",
      reservation_id: "reservation-orphan",
      state: "SUCCEEDED",
      started_at: "2026-09-20T00:00:00.000Z",
    });
    // Spend without a quote is a control violation: fail-closed, never a pass.
    expect(report.aggregate.orphans_found).toBe(true);
    expect(report.verdict).toBe("FAIL");
  });

  it("fails the operation when actual cost breaches the quoted envelope", async () => {
    const { fingerprintRef, fingerprintRow } = await buildFingerprint();
    const receipt = await buildReceipt(0.2, fingerprintRef);
    const tables: MockTables = {
      admissions: [admissionRow()],
      attempts: [attemptRow({ ...receipt })],
      orphans: [],
      fingerprints: { [fingerprintRef]: fingerprintRow },
    };
    const observer = createD1ResearchModelSpendObserver(mockDatabase(tables), {
      pricing: pricingPort(0.2),
      now: () => NOW_MS,
    });
    const report = await observer.observe(baseInput());
    expect(firstOperation(report).verdict).toBe("FAIL");
    expect(firstOperation(report).reasons).toContain("QUOTED_ACTUAL_BREACH");
    expect(report.verdict).toBe("FAIL");
  });

  it("fails the operation when actual cost exceeds the per-operation target", async () => {
    const { observer, input } = await happyFixture(0.06, 0.06);
    const report = await observer.observe(input);
    expect(firstOperation(report).verdict).toBe("FAIL");
    expect(firstOperation(report).reasons).toContain("PER_OPERATION_TARGET_EXCEEDED");
    expect(report.verdict).toBe("FAIL");
  });

  it("fails the report when the window total exceeds the total target", async () => {
    const { fingerprintRef, fingerprintRow } = await buildFingerprint();
    const receiptA = await buildReceipt(0.04, fingerprintRef);
    const receiptB = await buildReceipt(0.04, fingerprintRef);
    const tables: MockTables = {
      admissions: [
        admissionRow(),
        admissionRow({ authorization_ref: "auth-2", operation_id: "model-operation-2", reservation_id: "reservation-2" }),
      ],
      attempts: [
        attemptRow({ ...receiptA }),
        attemptRow({ attempt_id: "model-attempt-2", reservation_id: "reservation-2", ...receiptB }),
      ],
      orphans: [],
      fingerprints: { [fingerprintRef]: fingerprintRow },
    };
    const observer = createD1ResearchModelSpendObserver(mockDatabase(tables), {
      pricing: pricingPort(0.04),
      now: () => NOW_MS,
    });
    const report = await observer.observe(
      baseInput({ cost_targets: { max_usd_per_operation: 0.05, max_total_usd: 0.05 } }),
    );
    expect(report.operations.every((operation) => operation.verdict === "PASS")).toBe(true);
    expect(report.aggregate.actual_total_usd).toBeCloseTo(0.08, 9);
    expect(report.aggregate.total_target_exceeded).toBe(true);
    expect(report.verdict).toBe("FAIL");
  });

  it("blocks the operation when the route fingerprint was never observed (never fabricated)", async () => {
    const { fingerprintRef } = await buildFingerprint();
    const receipt = await buildReceipt(0.025, fingerprintRef);
    const tables: MockTables = {
      admissions: [admissionRow()],
      attempts: [attemptRow({ ...receipt })],
      orphans: [],
      fingerprints: {},
    };
    const observer = createD1ResearchModelSpendObserver(mockDatabase(tables), {
      pricing: pricingPort(0.025),
      now: () => NOW_MS,
    });
    const report = await observer.observe(baseInput());
    expect(firstOperation(report).repriced_usd).toBeNull();
    expect(firstOperation(report).repricing).toEqual({ status: "UNAVAILABLE", reason: "FINGERPRINT_INCOMPLETE" });
    expect(firstOperation(report).verdict).toBe("BLOCKED");
    expect(firstOperation(report).reasons).toContain("FINGERPRINT_INCOMPLETE");
    expect(report.verdict).toBe("BLOCKED");
  });

  it("blocks an admission that produced no attempt", async () => {
    const tables: MockTables = {
      admissions: [admissionRow()],
      attempts: [],
      orphans: [],
      fingerprints: {},
    };
    const observer = createD1ResearchModelSpendObserver(mockDatabase(tables), {
      pricing: pricingPort(0.025),
      now: () => NOW_MS,
    });
    const report = await observer.observe(baseInput());
    expect(firstOperation(report).settlement).toBe("NO_ATTEMPT");
    expect(firstOperation(report).verdict).toBe("BLOCKED");
    expect(firstOperation(report).reasons).toContain("NO_ATTEMPT");
    expect(report.verdict).toBe("BLOCKED");
  });

  it("rejects invalid observation input", async () => {
    const tables: MockTables = { admissions: [], attempts: [], orphans: [], fingerprints: {} };
    const observer = createD1ResearchModelSpendObserver(mockDatabase(tables), { now: () => NOW_MS });
    await expect(
      observer.observe(baseInput({ window: { from: WINDOW.to, to: WINDOW.from } })),
    ).rejects.toMatchObject({ code: "SPEND_OBSERVATION_INPUT_INVALID" });
    await expect(
      observer.observe(baseInput({ cost_targets: { max_usd_per_operation: -1, max_total_usd: 1 } })),
    ).rejects.toMatchObject({ code: "SPEND_OBSERVATION_INPUT_INVALID" });
    await expect(
      observer.observe(baseInput({ window: { from: "not-a-date", to: WINDOW.to } })),
    ).rejects.toMatchObject({ code: "SPEND_OBSERVATION_INPUT_INVALID" });
  });

  it("rejects a corrupt spend admission quote", async () => {
    const tables: MockTables = {
      admissions: [admissionRow({ quote_json: "not json" })],
      attempts: [],
      orphans: [],
      fingerprints: {},
    };
    const observer = createD1ResearchModelSpendObserver(mockDatabase(tables), {
      pricing: pricingPort(0.025),
      now: () => NOW_MS,
    });
    await expect(observer.observe(baseInput())).rejects.toMatchObject({
      code: "SPEND_OBSERVATION_READBACK_CORRUPT",
    });
    expect(observer).toBeDefined();
    expect(ResearchModelSpendObservationError).toBeDefined();
  });
});
