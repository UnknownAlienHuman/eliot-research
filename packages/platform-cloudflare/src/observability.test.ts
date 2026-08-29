import { describe, expect, it } from "vitest";
import {
  createSafeMetricsPort,
  evaluateAndPersistHealth,
  evaluateHealthSnapshot,
  shouldSampleMetric,
  type HealthSnapshot,
  type MetricPoint,
} from "./observability.js";

const ordinary: MetricPoint = {
  operation_kind: "fast_search",
  query_product: "FAST_SEARCH",
  duration_ms: 12,
  count: 1,
};

describe("safe observability", () => {
  it("drops evidence and credential-shaped fields without forwarding their values", () => {
    const written: MetricPoint[] = [];
    const metrics = createSafeMetricsPort({ write: (point) => written.push(point) }, {
      sampling: { ordinary_success_rate: 1, random: () => 0 },
    });

    expect(metrics.admit({ ...ordinary, evidence_excerpt: "private evidence" })).toEqual({
      admitted: false,
      reason_code: "UNKNOWN_OR_FORBIDDEN_FIELD",
    });
    expect(metrics.admit({ ...ordinary, oauth_token: "secret" })).toEqual({
      admitted: false,
      reason_code: "UNKNOWN_OR_FORBIDDEN_FIELD",
    });
    expect(metrics.admit({ ...ordinary, error_class: "Bearer secret" })).toEqual({
      admitted: false,
      reason_code: "INVALID_DIMENSION",
    });
    expect(written).toHaveLength(0);
  });

  it("admits only bounded flat dimensions and finite numbers", () => {
    const written: MetricPoint[] = [];
    const metrics = createSafeMetricsPort({ write: (point) => written.push(point) }, {
      sampling: { ordinary_success_rate: 1, random: () => 0 },
    });
    expect(metrics.admit(ordinary)).toEqual({ admitted: true, reason_code: "ADMITTED" });
    expect(metrics.admit({ ...ordinary, vendor_debug: true })).toEqual({
      admitted: false,
      reason_code: "UNKNOWN_OR_FORBIDDEN_FIELD",
    });
    expect(metrics.admit({ ...ordinary, duration_ms: Number.NaN })).toEqual({
      admitted: false,
      reason_code: "INVALID_NUMBER",
    });
    expect(written).toEqual([ordinary]);
  });

  it("samples errors and security/erasure/deep/audit/report operations at 100 percent", () => {
    const never = { ordinary_success_rate: 0, random: () => 0.999 };
    expect(shouldSampleMetric({ operation_kind: "security.denied" }, never)).toBe(true);
    expect(shouldSampleMetric({ operation_kind: "erasure.execute" }, never)).toBe(true);
    expect(shouldSampleMetric({ operation_kind: "research.deep" }, never)).toBe(true);
    expect(shouldSampleMetric({ operation_kind: "artifact.report" }, never)).toBe(true);
    expect(shouldSampleMetric({ operation_kind: "fast_search", error_class: "TIMEOUT" }, never)).toBe(true);
    expect(shouldSampleMetric(ordinary, never)).toBe(false);
  });

  it("keeps optional connector degradation independent from required readiness", () => {
    const snapshot: HealthSnapshot = {
      generated_at: "2026-08-29T12:00:00Z",
      deployment_generation: "deploy-g1",
      schema_generation: "schema-g1",
      connector_states: { core: "ACTIVE", google_drive: "REAUTH_REQUIRED" },
      projection_lag_seconds: { search: 0 },
      outbox_oldest_seconds: 0,
      dlq_messages: 0,
      open_incident_refs: [],
      budget_utilization: { total: 0.1 },
    };
    const policy = {
      required_connector_refs: ["core"],
      projection_lag_warning_seconds: 900,
      outbox_alert_seconds: 300,
      budget_warning_ratio: 0.7,
      budget_block_ratio: 1,
    };
    expect(evaluateHealthSnapshot(snapshot, policy)).toEqual({
      status: "DEGRADED",
      incidents: [expect.objectContaining({ code: "OPTIONAL_CONNECTOR_DEGRADED" })],
    });
    expect(evaluateHealthSnapshot(snapshot, {
      ...policy,
      required_connector_refs: ["core", "google_drive"],
    }).status).toBe("BLOCKED");
    expect(evaluateHealthSnapshot({
      ...snapshot,
      connector_states: { google_drive: "ACTIVE" },
    }, policy).status).toBe("BLOCKED");
  });

  it("persists exactly the evaluated health state", async () => {
    const snapshot: HealthSnapshot = {
      generated_at: "2026-08-29T12:00:00Z",
      deployment_generation: "deploy-g1",
      schema_generation: "schema-g1",
      connector_states: { core: "ACTIVE" },
      projection_lag_seconds: { search: 901 },
      outbox_oldest_seconds: 301,
      dlq_messages: 1,
      open_incident_refs: [],
      budget_utilization: { total: 1 },
    };
    const persisted: unknown[] = [];
    const evaluation = await evaluateAndPersistHealth(snapshot, {
      required_connector_refs: ["core"],
      projection_lag_warning_seconds: 900,
      outbox_alert_seconds: 300,
      budget_warning_ratio: 0.7,
      budget_block_ratio: 1,
    }, {
      async persist(storedSnapshot, storedEvaluation) {
        persisted.push(storedSnapshot, storedEvaluation);
      },
    });
    expect(evaluation.status).toBe("BLOCKED");
    expect(persisted).toEqual([snapshot, evaluation]);
  });
});
