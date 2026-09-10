import type { D1Database } from "@cloudflare/workers-types";
import type {
  WorkspaceMcpCandidateStore,
  WorkspaceMcpObservationStoreInput,
  WorkspaceMcpObservationStoreResult,
  WorkspaceMcpPlanLookup,
  WorkspaceMcpPlanLookupResult,
  WorkspaceMcpPlanStoreInput,
  WorkspaceMcpPlanStoreResult,
} from "@eliotr/cloudflare-workspace-mcp";

interface PlanRow {
  readonly plan_id: string;
  readonly principal_ref: string;
  readonly deployment_generation: string;
  readonly auth_profile: string;
  readonly google_transport: string;
  readonly idempotency_key: string;
  readonly input_fingerprint: string;
  readonly plan_sha256: string;
  readonly plan_json: string;
  readonly expires_at: string;
}

interface ObservationRow {
  readonly observation_id: string;
  readonly plan_id: string;
  readonly receipt_sha256: string;
  readonly observation_json: string;
}

function decodeJson(raw: string): unknown | undefined {
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

function samePlanIdentity(row: PlanRow, input: WorkspaceMcpPlanStoreInput): boolean {
  return row.plan_id === input.plan_id && row.principal_ref === input.principal_ref &&
    row.deployment_generation === input.deployment_generation && row.auth_profile === input.auth_profile &&
    row.google_transport === input.google_transport && row.idempotency_key === input.idempotency_key;
}

function readPlan(row: PlanRow): WorkspaceMcpPlanStoreResult {
  const plan = decodeJson(row.plan_json);
  return plan === undefined
    ? { state: "UNKNOWN", plan_id: row.plan_id, plan_sha256: row.plan_sha256 }
    : { state: "REPLAY", plan };
}

export function createD1WorkspaceMcpCandidateStore(database: D1Database): WorkspaceMcpCandidateStore {
  async function existingPlan(input: WorkspaceMcpPlanStoreInput): Promise<PlanRow | null> {
    return await database.prepare(
      "SELECT plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,input_fingerprint,plan_sha256,plan_json,expires_at FROM workspace_mcp_plan WHERE principal_ref=?1 AND deployment_generation=?2 AND auth_profile=?3 AND google_transport=?4 AND idempotency_key=?5 LIMIT 1",
    ).bind(input.principal_ref, input.deployment_generation, input.auth_profile, input.google_transport, input.idempotency_key).first<PlanRow>() ?? null;
  }

  async function issuePlan(input: WorkspaceMcpPlanStoreInput): Promise<WorkspaceMcpPlanStoreResult> {
    let row: PlanRow | null;
    try { row = await existingPlan(input); } catch { return { state: "UNKNOWN", plan_id: input.plan_id, plan_sha256: input.plan_sha256 }; }
    if (row !== null) {
      if (!samePlanIdentity(row, input) || row.input_fingerprint !== input.input_fingerprint) {
        return { state: "CONFLICT", code: "IDEMPOTENCY_CONFLICT" };
      }
      if (Date.parse(input.issued_at) >= Date.parse(row.expires_at)) return { state: "CONFLICT", code: "PLAN_EXPIRED" };
      return readPlan(row);
    }
    try {
      await database.prepare(
        "INSERT INTO workspace_mcp_plan(plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,input_fingerprint,plan_sha256,plan_json,issued_at,expires_at,state,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'ISSUED',?10)",
      ).bind(input.plan_id, input.principal_ref, input.deployment_generation, input.auth_profile, input.google_transport, input.idempotency_key, input.input_fingerprint, input.plan_sha256, JSON.stringify(input.plan), input.issued_at, input.expires_at).run();
    } catch {
      try { row = await existingPlan(input); } catch { return { state: "UNKNOWN", plan_id: input.plan_id, plan_sha256: input.plan_sha256 }; }
      if (row === null) return { state: "UNKNOWN", plan_id: input.plan_id, plan_sha256: input.plan_sha256 };
      if (row.input_fingerprint !== input.input_fingerprint) return { state: "CONFLICT", code: "IDEMPOTENCY_CONFLICT" };
      return readPlan(row);
    }
    try {
      row = await database.prepare("SELECT plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,input_fingerprint,plan_sha256,plan_json,expires_at FROM workspace_mcp_plan WHERE plan_id=?1 LIMIT 1").bind(input.plan_id).first<PlanRow>() ?? null;
    } catch { return { state: "UNKNOWN", plan_id: input.plan_id, plan_sha256: input.plan_sha256 }; }
    return row === null ? { state: "UNKNOWN", plan_id: input.plan_id, plan_sha256: input.plan_sha256 } : readPlan(row);
  }

  async function loadPlan(input: WorkspaceMcpPlanLookup): Promise<WorkspaceMcpPlanLookupResult> {
    try {
      const row = await database.prepare(
        "SELECT plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,input_fingerprint,plan_sha256,plan_json,expires_at FROM workspace_mcp_plan WHERE plan_id=?1 AND principal_ref=?2 AND deployment_generation=?3 AND auth_profile=?4 AND google_transport=?5 AND idempotency_key=?6 LIMIT 1",
      ).bind(input.plan_id, input.principal_ref, input.deployment_generation, input.auth_profile, input.google_transport, input.idempotency_key).first<PlanRow>();
      if (row === null || row === undefined) return { state: "NOT_FOUND" };
      const plan = decodeJson(row.plan_json);
      return plan === undefined ? { state: "UNKNOWN" } : { state: "FOUND", plan };
    } catch { return { state: "UNKNOWN" }; }
  }

  async function recordObservation(input: WorkspaceMcpObservationStoreInput): Promise<WorkspaceMcpObservationStoreResult> {
    try {
      const owner = await database.prepare(
        "SELECT plan_id FROM workspace_mcp_plan WHERE plan_id=?1 AND principal_ref=?2 AND deployment_generation=?3 AND auth_profile=?4 AND google_transport=?5 AND idempotency_key=?6 AND plan_sha256=?7 LIMIT 1",
      ).bind(input.plan_id, input.principal_ref, input.deployment_generation, input.auth_profile, input.google_transport, input.idempotency_key, input.plan_sha256).first<{ plan_id: string }>();
      if (owner === null || owner === undefined) return { state: "UNKNOWN" };
      const previous = await database.prepare("SELECT observation_id,plan_id,receipt_sha256,observation_json FROM workspace_mcp_observation WHERE plan_id=?1 AND receipt_sha256=?2 LIMIT 1").bind(input.plan_id, input.receipt_sha256).first<ObservationRow>();
      if (previous !== null && previous !== undefined) {
        const observation = decodeJson(previous.observation_json);
        return observation === undefined ? { state: "UNKNOWN" } : { state: "REPLAY", observation };
      }
      await database.prepare(
        "INSERT INTO workspace_mcp_observation(observation_id,plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,receipt_sha256,receipt_json,observation_json,observation_sha256,disposition,reason_codes_json,observed_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)",
      ).bind(input.observation_id, input.plan_id, input.principal_ref, input.deployment_generation, input.auth_profile, input.google_transport, input.idempotency_key, input.receipt_sha256, JSON.stringify(input.receipt), JSON.stringify(input.observation), input.observation_sha256, input.disposition, JSON.stringify(input.reason_codes), input.observed_at).run();
      const stored = await database.prepare("SELECT observation_id,plan_id,receipt_sha256,observation_json FROM workspace_mcp_observation WHERE observation_id=?1 AND plan_id=?2 AND receipt_sha256=?3 LIMIT 1").bind(input.observation_id, input.plan_id, input.receipt_sha256).first<ObservationRow>();
      const observation = stored === null || stored === undefined ? undefined : decodeJson(stored.observation_json);
      return observation === undefined ? { state: "UNKNOWN" } : { state: "COMMITTED", observation };
    } catch {
      try {
        const stored = await database.prepare("SELECT observation_id,plan_id,receipt_sha256,observation_json FROM workspace_mcp_observation WHERE plan_id=?1 AND receipt_sha256=?2 LIMIT 1").bind(input.plan_id, input.receipt_sha256).first<ObservationRow>();
        const observation = stored === null || stored === undefined ? undefined : decodeJson(stored.observation_json);
        return observation === undefined ? { state: "UNKNOWN" } : { state: "REPLAY", observation };
      } catch { return { state: "UNKNOWN" }; }
    }
  }

  return { issuePlan, loadPlan, recordObservation };
}
