import {
  evaluateAndPersistHealth,
  readD1OutboxHealth,
  type HealthEvaluation,
  type HealthIncident,
  type HealthSnapshot,
} from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";
import { readDoctorMcpSinkState } from "./doctor-delivery.js";
import { readReadiness, REQUIRED_CORE_SCHEMA_GENERATION } from "./readiness.js";

const DOCTOR_MODEL = "@cf/zai-org/glm-5.3-flash";
const DOCTOR_MODEL_TIMEOUT_MS = 8_000;
const DOCTOR_OPEN_INCIDENT_LIMIT = 32;
const DOCTOR_HEALTH_SNAPSHOT_ID = "doctor-current";
const DOCTOR_GITHUB_SINK = "github-issue";
const DOCTOR_INCIDENT_PREFIX = "DOCTOR_HEALTH_";

const HEALTH_POLICY = {
  required_connector_refs: ["core_schema", "search_schema"],
  projection_lag_warning_seconds: 15 * 60,
  outbox_alert_seconds: 5 * 60,
  budget_warning_ratio: 0.7,
  budget_block_ratio: 1,
} as const;

type DoctorHealthCode = HealthIncident["code"];

const DOCTOR_HEALTH_CODES = new Set<DoctorHealthCode>([
  "REQUIRED_CONNECTOR_UNAVAILABLE",
  "OPTIONAL_CONNECTOR_DEGRADED",
  "PROJECTION_LAG",
  "OUTBOX_STALLED",
  "DLQ_NONEMPTY",
  "BUDGET_WARNING",
  "BUDGET_BLOCKED",
  "OPEN_INCIDENT",
]);

interface DoctorOptions {
  readonly now?: () => number;
}

interface IncidentIdentity {
  readonly incident_id: string;
  readonly kind: string;
  readonly severity: "INFO" | "WARNING" | "CRITICAL";
  readonly details_ref: string;
  readonly delivery_id: string;
  readonly marker: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRows<T>(result: D1Result<T>, label: string): readonly T[] {
  if (result.success !== true || !Array.isArray(result.results)) {
    throw new Error(`scheduled doctor ${label} read did not settle`);
  }
  return result.results;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function safeExternalIncidentRefs(database: D1Database): Promise<readonly string[]> {
  const result = await database.prepare(
    "SELECT incident_id FROM incident WHERE state IN ('OPEN','ACKNOWLEDGED') " +
    "AND kind NOT LIKE ?1 ORDER BY created_at,incident_id LIMIT ?2",
  ).bind(`${DOCTOR_INCIDENT_PREFIX}%`, DOCTOR_OPEN_INCIDENT_LIMIT).all<{ readonly incident_id: unknown }>();
  return Promise.all(assertRows(result, "open incident").map(async (row) => {
    if (typeof row.incident_id !== "string") throw new Error("scheduled doctor incident identity is invalid");
    return `incident-${(await sha256Hex(row.incident_id)).slice(0, 32)}`;
  }));
}

async function oldestDoctorDeliverySeconds(database: D1Database, nowMs: number): Promise<number> {
  const row = await database.prepare(
    "SELECT MIN(d.created_at) AS oldest_created_at FROM doctor_delivery_outbox d " +
    "JOIN incident i ON i.incident_id=d.incident_id " +
    "WHERE d.sink_ref=?1 AND d.state IN ('PENDING','UNKNOWN') " +
    "AND i.state IN ('OPEN','ACKNOWLEDGED')",
  ).bind(DOCTOR_GITHUB_SINK).first<{ readonly oldest_created_at: unknown }>();
  if (row === null) throw new Error("scheduled doctor delivery age read returned no row");
  if (row.oldest_created_at === null) return 0;
  if (typeof row.oldest_created_at !== "string") throw new Error("scheduled doctor delivery timestamp is invalid");
  const oldestMs = Date.parse(row.oldest_created_at);
  if (!Number.isFinite(oldestMs)) throw new Error("scheduled doctor delivery timestamp is invalid");
  return Math.max(0, Math.floor((nowMs - oldestMs) / 1000));
}

async function hasUnsettledGitHubDelivery(database: D1Database, nowMs: number): Promise<boolean> {
  const row = await database.prepare(
    "SELECT 1 AS present FROM doctor_delivery_outbox d " +
    "LEFT JOIN incident i ON i.incident_id=d.incident_id " +
    "WHERE d.sink_ref=?1 AND ((d.state='UNKNOWN' AND (d.lease_until IS NULL OR d.lease_until<=?2)) OR " +
    "(d.state='FAILED' AND i.state IN ('OPEN','ACKNOWLEDGED'))) LIMIT 1",
  ).bind(DOCTOR_GITHUB_SINK, nowMs).first<{ readonly present: number }>();
  return row !== null;
}

function codeForKind(value: unknown): DoctorHealthCode | null {
  if (typeof value !== "string" || !value.startsWith(DOCTOR_INCIDENT_PREFIX)) return null;
  const code = value.slice(DOCTOR_INCIDENT_PREFIX.length) as DoctorHealthCode;
  return DOCTOR_HEALTH_CODES.has(code) ? code : null;
}

function severityForIncident(incident: HealthIncident): "INFO" | "WARNING" | "CRITICAL" {
  if (incident.severity === "BLOCKING" || incident.severity === "ALERT") return "CRITICAL";
  return "WARNING";
}

async function incidentIdentity(incident: HealthIncident): Promise<IncidentIdentity> {
  const digest = await sha256Hex(`${incident.code}\u0000${incident.severity}\u0000${incident.component_ref}`);
  return {
    incident_id: `doctor-health-${digest}`,
    kind: `${DOCTOR_INCIDENT_PREFIX}${incident.code}`,
    severity: severityForIncident(incident),
    details_ref: `health-code:${incident.code}:${digest.slice(0, 32)}`,
    delivery_id: `doctor-${digest}`,
    marker: `[eliotr-doctor:${digest}]`,
  };
}

function currentDoctorIncidentIds(identities: readonly IncidentIdentity[]): readonly string[] {
  return [...new Set(identities.map((identity) => identity.incident_id))];
}

async function persistHealthState(
  database: D1Database,
  snapshot: HealthSnapshot,
  evaluation: HealthEvaluation,
): Promise<void> {
  if (evaluation.incidents.length > 48) {
    throw new Error("scheduled doctor incident count exceeds its persistence bound");
  }
  const identities = await Promise.all(evaluation.incidents.map(incidentIdentity));
  const currentIds = currentDoctorIncidentIds(identities);
  const now = snapshot.generated_at;
  const storedSnapshot = JSON.stringify({ ...snapshot, status: evaluation.status, incidents: evaluation.incidents });
  const exclusions = currentIds.length === 0
    ? ""
    : ` AND incident_id NOT IN (${currentIds.map((_, index) => `?${index + 3}`).join(",")})`;
  const statements: D1PreparedStatement[] = [
    database.prepare(
      "INSERT INTO health_snapshot(snapshot_id,generated_at,deployment_generation,schema_generation,snapshot_json) " +
      "VALUES(?1,?2,?3,?4,?5) ON CONFLICT(snapshot_id) DO UPDATE SET " +
      "generated_at=excluded.generated_at,deployment_generation=excluded.deployment_generation, " +
      "schema_generation=excluded.schema_generation,snapshot_json=excluded.snapshot_json",
    ).bind(
      DOCTOR_HEALTH_SNAPSHOT_ID,
      snapshot.generated_at,
      snapshot.deployment_generation,
      snapshot.schema_generation,
      storedSnapshot,
    ),
    database.prepare(
      "UPDATE incident SET state='RESOLVED',resolved_at=?1 WHERE kind LIKE ?2 " +
      "AND state IN ('OPEN','ACKNOWLEDGED')" + exclusions,
    ).bind(now, `${DOCTOR_INCIDENT_PREFIX}%`, ...currentIds),
  ];

  for (let index = 0; index < evaluation.incidents.length; index += 1) {
    const incident = evaluation.incidents[index];
    const identity = identities[index];
    if (incident === undefined || identity === undefined) continue;
    statements.push(database.prepare(
      "INSERT INTO incident(incident_id,severity,kind,state,details_ref,created_at,resolved_at) " +
      "VALUES(?1,?2,?3,'OPEN',?4,?5,NULL) ON CONFLICT(incident_id) DO UPDATE SET " +
      "severity=excluded.severity,kind=excluded.kind,details_ref=excluded.details_ref, " +
      "state=CASE WHEN incident.state='RESOLVED' THEN 'OPEN' ELSE incident.state END, " +
      "resolved_at=CASE WHEN incident.state='RESOLVED' THEN NULL ELSE incident.resolved_at END",
    ).bind(identity.incident_id, identity.severity, identity.kind, identity.details_ref, now));

    const initialDeliveryState = snapshot.connector_states.github_issue_sink === "UNCONFIGURED"
      ? "UNCONFIGURED" : "PENDING";
    statements.push(database.prepare(
      "INSERT INTO doctor_delivery_outbox(" +
      "delivery_id,incident_id,sink_ref,marker,state,diagnosis_state,created_at,updated_at" +
      ") VALUES(?1,?2,?3,?4,?5,'NOT_STARTED',?6,?6) " +
      "ON CONFLICT(incident_id,sink_ref) DO UPDATE SET " +
      "state=CASE WHEN doctor_delivery_outbox.state='SUPERSEDED' THEN excluded.state " +
      "ELSE doctor_delivery_outbox.state END, " +
      "diagnosis_state=CASE WHEN doctor_delivery_outbox.state='SUPERSEDED' THEN 'NOT_STARTED' " +
      "ELSE doctor_delivery_outbox.diagnosis_state END, " +
      "diagnosis=CASE WHEN doctor_delivery_outbox.state='SUPERSEDED' THEN NULL " +
      "ELSE doctor_delivery_outbox.diagnosis END, " +
      "last_error_code=CASE WHEN doctor_delivery_outbox.state='SUPERSEDED' THEN NULL " +
      "ELSE doctor_delivery_outbox.last_error_code END, " +
      "updated_at=CASE WHEN doctor_delivery_outbox.state='SUPERSEDED' THEN excluded.updated_at " +
      "ELSE doctor_delivery_outbox.updated_at END",
    ).bind(identity.delivery_id, identity.incident_id, DOCTOR_GITHUB_SINK, identity.marker, initialDeliveryState, now));
  }

  statements.push(database.prepare(
    "UPDATE doctor_delivery_outbox SET state='SUPERSEDED',last_error_code='INCIDENT_RESOLVED', " +
    "lease_owner=NULL,lease_until=NULL,updated_at=?1 WHERE state IN ('PENDING','UNCONFIGURED') " +
    "AND incident_id IN (SELECT incident_id FROM incident WHERE kind LIKE ?2 AND state='RESOLVED')",
  ).bind(now, `${DOCTOR_INCIDENT_PREFIX}%`));
  await database.batch(statements);
}

async function persistEvaluation(
  database: D1Database,
  snapshot: HealthSnapshot,
): Promise<HealthEvaluation> {
  return evaluateAndPersistHealth(snapshot, HEALTH_POLICY, {
    persist: async (value, evaluation) => persistHealthState(database, value, evaluation),
  });
}

async function buildHealthSnapshot(
  env: Env,
  nowMs: number,
  githubState: "UNCONFIGURED" | "UNVERIFIED" | "READY" | "UNAVAILABLE",
): Promise<HealthSnapshot> {
  const [readiness, outbox, openIncidentRefs, doctorOutboxAge] = await Promise.all([
    readReadiness(env),
    readD1OutboxHealth(env.CORE_DB, nowMs),
    safeExternalIncidentRefs(env.CORE_DB),
    oldestDoctorDeliverySeconds(env.CORE_DB, nowMs),
  ]);
  const ai = env.AI as unknown as Partial<Pick<Ai, "run">> | undefined;
  const coreReady = readiness.core_schema_generation === REQUIRED_CORE_SCHEMA_GENERATION;
  const searchReady = readiness.search_schema_generation !== null &&
    !readiness.blocking_reason_codes.includes("SEARCH_SCHEMA_GENERATION_MISMATCH") &&
    !readiness.blocking_reason_codes.includes("SEARCH_SCHEMA_NOT_APPLIED");
  return {
    generated_at: new Date(nowMs).toISOString(),
    deployment_generation: env.DEPLOYMENT_GENERATION,
    schema_generation: readiness.core_schema_generation ?? "unavailable",
    connector_states: {
      core_schema: coreReady ? "READY" : "UNAVAILABLE",
      search_schema: searchReady ? "READY" : "UNAVAILABLE",
      native_workers_ai: typeof ai?.run === "function" ? "READY" : "UNCONFIGURED",
      github_issue_sink: githubState,
    },
    projection_lag_seconds: {},
    outbox_oldest_seconds: Math.max(outbox.oldest_unsent_age_ms / 1_000, doctorOutboxAge),
    dlq_messages: outbox.dead_lettered,
    open_incident_refs: openIncidentRefs,
    budget_utilization: {},
  };
}

interface DiagnosisCandidate {
  readonly delivery_id: string;
  readonly health_code: DoctorHealthCode;
}

async function claimDiagnosisCandidates(database: D1Database, now: string): Promise<readonly DiagnosisCandidate[]> {
  const result = await database.prepare(
    "UPDATE doctor_delivery_outbox SET diagnosis_state='UNKNOWN',updated_at=?1 " +
    "WHERE sink_ref=?2 AND diagnosis_state='NOT_STARTED' AND state IN ('PENDING','UNCONFIGURED','UNKNOWN') " +
    "AND incident_id IN (" +
    "SELECT incident_id FROM incident WHERE kind LIKE ?3 AND state IN ('OPEN','ACKNOWLEDGED')) " +
    "RETURNING delivery_id,incident_id",
  ).bind(now, DOCTOR_GITHUB_SINK, `${DOCTOR_INCIDENT_PREFIX}%`).all<{
    readonly delivery_id: unknown;
    readonly incident_id: unknown;
  }>();
  const claimed = assertRows(result, "diagnosis claim");
  const deliveryIds = claimed.flatMap((row) => typeof row.delivery_id === "string" ? [row.delivery_id] : []);
  if (deliveryIds.length === 0) return [];
  const details = await database.prepare(
    `SELECT d.delivery_id,i.kind FROM doctor_delivery_outbox d ` +
    `JOIN incident i ON i.incident_id=d.incident_id WHERE d.delivery_id IN (` +
    deliveryIds.map((_, index) => `?${index + 1}`).join(",") + ")",
  ).bind(...deliveryIds).all<{ readonly delivery_id: unknown; readonly kind: unknown }>();
  return assertRows(details, "diagnosis code").flatMap((row) => {
    const code = codeForKind(row.kind);
    return typeof row.delivery_id === "string" && code !== null
      ? [{ delivery_id: row.delivery_id, health_code: code }]
      : [];
  });
}

function extractDiagnosis(value: unknown): string | null {
  let candidate: unknown = value;
  if (isRecord(value)) {
    candidate = value.response;
    if (typeof candidate !== "string" && Array.isArray(value.choices)) {
      const first = value.choices[0];
      if (isRecord(first) && isRecord(first.message)) candidate = first.message.content;
    }
  }
  if (typeof candidate !== "string") return null;
  const normalized = candidate.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || /(?:[A-Za-z]:\\|\/(?:Users|home|private|var)\/|https?:\/\/|\bBearer\s+|\bgh[pousr]_[A-Za-z0-9_]{8,}|\bsk-[A-Za-z0-9_-]{8,})/iu.test(normalized)) {
    return null;
  }
  return normalized.slice(0, 320);
}

async function runNativeDiagnosis(env: Env, codes: readonly DoctorHealthCode[]): Promise<string | null> {
  const ai = env.AI as unknown as Pick<Ai, "run"> | undefined;
  if (typeof ai?.run !== "function") return null;
  const uniqueCodes = [...new Set(codes)].sort();
  if (uniqueCodes.length === 0) return null;
  try {
    const result: unknown = await ai.run(DOCTOR_MODEL, {
      messages: [
        {
          role: "system",
          content: "Give one concise operational diagnosis based only on the supplied health codes. Do not request or infer logs, source data, paths, credentials, or external provider details. Use at most 40 words.",
        },
        { role: "user", content: JSON.stringify({ health_codes: uniqueCodes }) },
      ],
      max_tokens: 96,
      temperature: 0,
    }, { signal: AbortSignal.timeout(DOCTOR_MODEL_TIMEOUT_MS) });
    return extractDiagnosis(result);
  } catch {
    return null;
  }
}

async function finishDiagnosis(
  env: Env,
  database: D1Database,
  candidates: readonly DiagnosisCandidate[],
  now: string,
): Promise<void> {
  if (candidates.length === 0) return;
  const ai = env.AI as unknown as Partial<Pick<Ai, "run">> | undefined;
  if (typeof ai?.run !== "function") {
    await database.prepare(
      `UPDATE doctor_delivery_outbox SET diagnosis_state='UNAVAILABLE',updated_at=?1 ` +
      `WHERE diagnosis_state='UNKNOWN' AND delivery_id IN (${candidates.map((_, i) => `?${i + 2}`).join(",")})`,
    ).bind(now, ...candidates.map((candidate) => candidate.delivery_id)).run();
    return;
  }
  const diagnosis = await runNativeDiagnosis(env, candidates.map((candidate) => candidate.health_code));
  if (diagnosis === null) return;
  await database.prepare(
    `UPDATE doctor_delivery_outbox SET diagnosis_state='COMPLETE',diagnosis=?1,updated_at=?2 ` +
    `WHERE diagnosis_state='UNKNOWN' AND delivery_id IN (${candidates.map((_, i) => `?${i + 3}`).join(",")})`,
  ).bind(diagnosis, now, ...candidates.map((candidate) => candidate.delivery_id)).run();
}

async function activateConfiguredDeliveries(database: D1Database, now: string): Promise<void> {
  await database.prepare(
    "UPDATE doctor_delivery_outbox SET state='PENDING',last_error_code=NULL,updated_at=?1 " +
    "WHERE sink_ref=?2 AND state='UNCONFIGURED' AND incident_id IN (" +
    "SELECT incident_id FROM incident WHERE state IN ('OPEN','ACKNOWLEDGED'))",
  ).bind(now, DOCTOR_GITHUB_SINK).run();
}

export interface DoctorRunResult {
  readonly health_status: HealthEvaluation["status"];
  readonly incident_count: number;
  readonly github_sink: "UNCONFIGURED" | "READY" | "UNAVAILABLE";
  readonly diagnosis_attempted: boolean;
  readonly deliveries_examined: number;
}

/** Production entry called from the existing scheduled Worker handler. */
export async function runScheduledDoctor(env: Env, options: DoctorOptions = {}): Promise<DoctorRunResult> {
  const now = options.now ?? Date.now;
  const nowMs = now();
  const mcpState = await readDoctorMcpSinkState({
    database: env.CORE_DB,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    repository: env.ELIOTR_DOCTOR_GITHUB_REPOSITORY,
    agent_connection_id: env.ELIOTR_DOCTOR_AGENT_CONNECTION_ID,
    mcp_auth_profile: env.MCP_ACCESS_AUTH_PROFILE,
    mcp_service_client_id: env.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID,
    mcp_service_client_ids: env.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS,
    now_ms: nowMs,
  });
  const unsettled = await hasUnsettledGitHubDelivery(env.CORE_DB, nowMs);
  const sinkState = mcpState === "UNCONFIGURED"
    ? "UNCONFIGURED" : mcpState === "READY" && !unsettled ? "READY" : "UNAVAILABLE";
  const snapshot = await buildHealthSnapshot(env, nowMs, sinkState);
  const evaluation = await persistEvaluation(env.CORE_DB, snapshot);

  // Old token-only UNCONFIGURED incidents are resolved by the MCP readiness
  // readback above; only other still-active incidents are promoted for MCP pull.
  if (sinkState === "READY") await activateConfiguredDeliveries(env.CORE_DB, new Date(nowMs).toISOString());

  const diagnosisCandidates = await claimDiagnosisCandidates(env.CORE_DB, new Date(now()).toISOString());
  await finishDiagnosis(env, env.CORE_DB, diagnosisCandidates, new Date(now()).toISOString());

  return {
    health_status: evaluation.status,
    incident_count: evaluation.incidents.length,
    github_sink: sinkState,
    diagnosis_attempted: diagnosisCandidates.length > 0 &&
      typeof (env.AI as unknown as Partial<Pick<Ai, "run">> | undefined)?.run === "function",
    deliveries_examined: 0,
  };
}
