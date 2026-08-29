export interface MetricPoint {
  readonly operation_kind: string;
  readonly query_product?: string;
  readonly project_id_hash?: string;
  readonly route_generation?: string;
  readonly embedding_generation?: string;
  readonly index_generation?: string;
  readonly workflow_stage?: string;
  readonly result_disposition?: string;
  readonly error_class?: string;
  readonly duration_ms?: number;
  readonly cost_usd?: number;
  readonly count?: number;
}

export interface MetricsPort {
  write(point: MetricPoint): void;
}

export interface RawMetricsSink {
  write(point: MetricPoint): void;
}

export type MetricAdmissionReason =
  | "ADMITTED"
  | "SAMPLED_OUT"
  | "NOT_AN_OBJECT"
  | "UNKNOWN_OR_FORBIDDEN_FIELD"
  | "MISSING_OPERATION_KIND"
  | "INVALID_DIMENSION"
  | "INVALID_NUMBER"
  | "SINK_FAILURE";

export interface MetricAdmissionReceipt {
  readonly admitted: boolean;
  readonly reason_code: MetricAdmissionReason;
}

export interface SafeMetricsPort extends MetricsPort {
  admit(point: unknown): MetricAdmissionReceipt;
}

export interface MetricsSamplingPolicy {
  readonly ordinary_success_rate: number;
  readonly random?: () => number;
}

export interface SafeMetricsPortOptions {
  readonly sampling?: MetricsSamplingPolicy;
}

export interface HealthSnapshot {
  readonly generated_at: string;
  readonly deployment_generation: string;
  readonly schema_generation: string;
  readonly connector_states: Readonly<Record<string, string>>;
  readonly projection_lag_seconds: Readonly<Record<string, number>>;
  readonly outbox_oldest_seconds: number;
  readonly dlq_messages: number;
  readonly open_incident_refs: readonly string[];
  readonly budget_utilization: Readonly<Record<string, number>>;
}

export const TELEMETRY_FORBIDDEN_FIELDS = [
  "source_text",
  "prompt_body",
  "private_path",
  "evidence_excerpt",
  "oauth_token",
  "provider_key",
] as const;

const STRING_FIELDS = [
  "operation_kind",
  "query_product",
  "project_id_hash",
  "route_generation",
  "embedding_generation",
  "index_generation",
  "workflow_stage",
  "result_disposition",
  "error_class",
] as const;

const NUMBER_FIELDS = ["duration_ms", "cost_usd", "count"] as const;
const ALLOWED_FIELDS = new Set<string>([...STRING_FIELDS, ...NUMBER_FIELDS]);
const CRITICAL_OPERATION = /(?:^|[._:-])(security|erasure|deep|audit|report)(?:$|[._:-])/i;
const SENSITIVE_FIELD_NAME = /(?:authorization|cookie|credential|password|secret|token|private.?key|api.?key|source.?text|prompt|excerpt|private.?path|email|uri|url)/i;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SAFE_DIMENSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_HEALTH_DIMENSIONS = 256;

interface MutableMetricPoint {
  operation_kind: string;
  query_product?: string;
  project_id_hash?: string;
  route_generation?: string;
  embedding_generation?: string;
  index_generation?: string;
  workflow_stage?: string;
  result_disposition?: string;
  error_class?: string;
  duration_ms?: number;
  cost_usd?: number;
  count?: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validDimension(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_DIMENSION.test(value) &&
    !JWT_SHAPE.test(value) &&
    !/^bearer[: ]/i.test(value)
  );
}

function decodeMetricPoint(input: unknown):
  | { readonly ok: true; readonly point: MetricPoint }
  | { readonly ok: false; readonly reason: MetricAdmissionReason } {
  if (!isPlainRecord(input)) return { ok: false, reason: "NOT_AN_OBJECT" };
  for (const field of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(field) || SENSITIVE_FIELD_NAME.test(field)) {
      return { ok: false, reason: "UNKNOWN_OR_FORBIDDEN_FIELD" };
    }
  }

  if (!validDimension(input.operation_kind)) {
    return {
      ok: false,
      reason: input.operation_kind === undefined
        ? "MISSING_OPERATION_KIND"
        : "INVALID_DIMENSION",
    };
  }

  const point: MutableMetricPoint = { operation_kind: input.operation_kind };
  for (const field of STRING_FIELDS) {
    if (field === "operation_kind") continue;
    const value = input[field];
    if (value === undefined) continue;
    if (!validDimension(value)) return { ok: false, reason: "INVALID_DIMENSION" };
    point[field] = value;
  }
  for (const field of NUMBER_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (field === "count" && !Number.isSafeInteger(value))
    ) {
      return { ok: false, reason: "INVALID_NUMBER" };
    }
    point[field] = value;
  }
  return { ok: true, point };
}

function validateSamplingPolicy(policy: MetricsSamplingPolicy): void {
  if (
    !Number.isFinite(policy.ordinary_success_rate) ||
    policy.ordinary_success_rate < 0 ||
    policy.ordinary_success_rate > 1
  ) {
    throw new RangeError("ordinary_success_rate must be in [0, 1]");
  }
}

export function shouldSampleMetric(
  point: MetricPoint,
  policy: MetricsSamplingPolicy,
): boolean {
  validateSamplingPolicy(policy);
  if (point.error_class !== undefined || CRITICAL_OPERATION.test(point.operation_kind)) return true;
  const random = policy.random ?? Math.random;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("metrics random source must return a finite value in [0, 1)");
  }
  return sample < policy.ordinary_success_rate;
}

export function createSafeMetricsPort(
  sink: RawMetricsSink,
  options: SafeMetricsPortOptions = {},
): SafeMetricsPort {
  const sampling = options.sampling ?? { ordinary_success_rate: 0.1 };
  validateSamplingPolicy(sampling);

  function admit(input: unknown): MetricAdmissionReceipt {
    const decoded = decodeMetricPoint(input);
    if (!decoded.ok) return { admitted: false, reason_code: decoded.reason };
    let sampled: boolean;
    try {
      sampled = shouldSampleMetric(decoded.point, sampling);
    } catch {
      return { admitted: false, reason_code: "INVALID_NUMBER" };
    }
    if (!sampled) return { admitted: false, reason_code: "SAMPLED_OUT" };
    try {
      sink.write(decoded.point);
      return { admitted: true, reason_code: "ADMITTED" };
    } catch {
      return { admitted: false, reason_code: "SINK_FAILURE" };
    }
  }

  return {
    admit,
    write(point: MetricPoint): void {
      admit(point);
    },
  };
}

export type HealthStatus = "READY" | "DEGRADED" | "BLOCKED";
export type HealthIncidentSeverity = "WARNING" | "ALERT" | "BLOCKING";

export interface HealthIncident {
  readonly code:
    | "REQUIRED_CONNECTOR_UNAVAILABLE"
    | "OPTIONAL_CONNECTOR_DEGRADED"
    | "PROJECTION_LAG"
    | "OUTBOX_STALLED"
    | "DLQ_NONEMPTY"
    | "BUDGET_WARNING"
    | "BUDGET_BLOCKED"
    | "OPEN_INCIDENT";
  readonly severity: HealthIncidentSeverity;
  readonly component_ref: string;
}

export interface HealthEvaluation {
  readonly status: HealthStatus;
  readonly incidents: readonly HealthIncident[];
}

export interface HealthEvaluationPolicy {
  readonly required_connector_refs: readonly string[];
  readonly healthy_connector_states?: readonly string[];
  readonly projection_lag_warning_seconds: number;
  readonly outbox_alert_seconds: number;
  readonly budget_warning_ratio: number;
  readonly budget_block_ratio: number;
}

export interface HealthStateStore {
  persist(snapshot: HealthSnapshot, evaluation: HealthEvaluation): Promise<void>;
}

function requireNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
}

function requireRatio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be in [0, 1]`);
  }
}

function safeComponentRef(value: string): string {
  return SAFE_DIMENSION.test(value) ? value : "invalid-component-ref";
}

function escalate(current: HealthStatus, next: HealthStatus): HealthStatus {
  const rank: Readonly<Record<HealthStatus, number>> = { READY: 0, DEGRADED: 1, BLOCKED: 2 };
  return rank[next] > rank[current] ? next : current;
}

function assertBoundedHealthDimensions(snapshot: HealthSnapshot): void {
  for (const [label, count] of [
    ["connector_states", Object.keys(snapshot.connector_states).length],
    ["projection_lag_seconds", Object.keys(snapshot.projection_lag_seconds).length],
    ["open_incident_refs", snapshot.open_incident_refs.length],
    ["budget_utilization", Object.keys(snapshot.budget_utilization).length],
  ] as const) {
    if (count > MAX_HEALTH_DIMENSIONS) {
      throw new RangeError(`${label} exceeds the health dimension limit`);
    }
  }
}

export function evaluateHealthSnapshot(
  snapshot: HealthSnapshot,
  policy: HealthEvaluationPolicy,
): HealthEvaluation {
  requireNonNegativeFinite(policy.projection_lag_warning_seconds, "projection_lag_warning_seconds");
  requireNonNegativeFinite(policy.outbox_alert_seconds, "outbox_alert_seconds");
  requireRatio(policy.budget_warning_ratio, "budget_warning_ratio");
  requireRatio(policy.budget_block_ratio, "budget_block_ratio");
  if (policy.budget_warning_ratio > policy.budget_block_ratio) {
    throw new RangeError("budget_warning_ratio must not exceed budget_block_ratio");
  }
  requireNonNegativeFinite(snapshot.outbox_oldest_seconds, "outbox_oldest_seconds");
  if (!Number.isSafeInteger(snapshot.dlq_messages) || snapshot.dlq_messages < 0) {
    throw new RangeError("dlq_messages must be a non-negative safe integer");
  }
  assertBoundedHealthDimensions(snapshot);

  const required = new Set<string>();
  for (const connectorRef of policy.required_connector_refs) {
    if (!SAFE_DIMENSION.test(connectorRef)) {
      throw new RangeError("required connector reference is invalid");
    }
    required.add(connectorRef);
  }
  const healthy = new Set(policy.healthy_connector_states ?? ["ACTIVE", "READY", "HEALTHY"]);
  const incidents: HealthIncident[] = [];
  let status: HealthStatus = "READY";

  for (const connectorRef of [...required].sort()) {
    if (Object.prototype.hasOwnProperty.call(snapshot.connector_states, connectorRef)) continue;
    incidents.push({
      code: "REQUIRED_CONNECTOR_UNAVAILABLE",
      severity: "BLOCKING",
      component_ref: connectorRef,
    });
    status = escalate(status, "BLOCKED");
  }

  for (const [connectorRef, connectorState] of Object.entries(snapshot.connector_states)
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (healthy.has(connectorState)) continue;
    const componentRef = safeComponentRef(connectorRef);
    if (required.has(connectorRef)) {
      incidents.push({
        code: "REQUIRED_CONNECTOR_UNAVAILABLE",
        severity: "BLOCKING",
        component_ref: componentRef,
      });
      status = escalate(status, "BLOCKED");
    } else {
      incidents.push({
        code: "OPTIONAL_CONNECTOR_DEGRADED",
        severity: "WARNING",
        component_ref: componentRef,
      });
      status = escalate(status, "DEGRADED");
    }
  }

  for (const [projectionRef, lagSeconds] of Object.entries(snapshot.projection_lag_seconds)
    .sort(([left], [right]) => left.localeCompare(right))) {
    requireNonNegativeFinite(lagSeconds, `projection lag ${safeComponentRef(projectionRef)}`);
    if (lagSeconds > policy.projection_lag_warning_seconds) {
      incidents.push({
        code: "PROJECTION_LAG",
        severity: "WARNING",
        component_ref: safeComponentRef(projectionRef),
      });
      status = escalate(status, "DEGRADED");
    }
  }

  if (snapshot.outbox_oldest_seconds > policy.outbox_alert_seconds) {
    incidents.push({ code: "OUTBOX_STALLED", severity: "ALERT", component_ref: "outbox" });
    status = escalate(status, "DEGRADED");
  }
  if (snapshot.dlq_messages > 0) {
    incidents.push({ code: "DLQ_NONEMPTY", severity: "ALERT", component_ref: "dlq" });
    status = escalate(status, "DEGRADED");
  }

  for (const [poolRef, utilization] of Object.entries(snapshot.budget_utilization)
    .sort(([left], [right]) => left.localeCompare(right))) {
    requireRatio(utilization, `budget utilization ${safeComponentRef(poolRef)}`);
    if (utilization >= policy.budget_block_ratio) {
      incidents.push({
        code: "BUDGET_BLOCKED",
        severity: "BLOCKING",
        component_ref: safeComponentRef(poolRef),
      });
      status = escalate(status, "BLOCKED");
    } else if (utilization >= policy.budget_warning_ratio) {
      incidents.push({
        code: "BUDGET_WARNING",
        severity: "WARNING",
        component_ref: safeComponentRef(poolRef),
      });
      status = escalate(status, "DEGRADED");
    }
  }

  for (const incidentRef of [...new Set(snapshot.open_incident_refs)].sort()) {
    incidents.push({
      code: "OPEN_INCIDENT",
      severity: "ALERT",
      component_ref: safeComponentRef(incidentRef),
    });
    status = escalate(status, "DEGRADED");
  }

  return { status, incidents };
}

export async function evaluateAndPersistHealth(
  snapshot: HealthSnapshot,
  policy: HealthEvaluationPolicy,
  store: HealthStateStore,
): Promise<HealthEvaluation> {
  const evaluation = evaluateHealthSnapshot(snapshot, policy);
  await store.persist(snapshot, evaluation);
  return evaluation;
}
