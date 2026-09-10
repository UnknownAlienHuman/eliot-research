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
  readonly principal_ref: string;
  readonly deployment_generation: string;
  readonly auth_profile: string;
  readonly google_transport: string;
  readonly idempotency_key: string;
  readonly receipt_sha256: string;
  readonly observation_sha256: string;
  readonly observation_json: string;
  readonly receipt_json: string;
  readonly disposition: string;
}

function decodeJson(raw: string): unknown | undefined {
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

function samePlanIdentity(row: PlanRow, input: WorkspaceMcpPlanStoreInput): boolean {
  return row.plan_id === input.plan_id && row.principal_ref === input.principal_ref &&
    row.deployment_generation === input.deployment_generation && row.auth_profile === input.auth_profile &&
    row.google_transport === input.google_transport && row.idempotency_key === input.idempotency_key;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function readPlan(row: PlanRow, state: "COMMITTED" | "REPLAY" = "REPLAY"): WorkspaceMcpPlanStoreResult {
  const plan = decodeJson(row.plan_json);
  if (plan === undefined || typeof plan !== "object" || plan === null) {
    return { state: "UNKNOWN", plan_id: row.plan_id, plan_sha256: row.plan_sha256 };
  }
  const value = plan as Record<string, unknown>;
  if (value.plan_id !== row.plan_id || value.input_fingerprint !== row.input_fingerprint ||
      value.plan_sha256 !== row.plan_sha256 || value.idempotency_key !== row.idempotency_key ||
      value.deployment_generation !== row.deployment_generation || value.auth_profile !== row.auth_profile ||
      value.google_transport !== row.google_transport || value.candidate_ledger_mutation !== "ISSUED") {
    return { state: "UNKNOWN", plan_id: row.plan_id, plan_sha256: row.plan_sha256 };
  }
  return { state, plan };
}

function readIssuedPlan(row: PlanRow, input: WorkspaceMcpPlanStoreInput, state: "COMMITTED" | "REPLAY"): WorkspaceMcpPlanStoreResult {
  return !samePlanIdentity(row, input) || row.input_fingerprint !== input.input_fingerprint
    ? { state: "UNKNOWN", plan_id: row.plan_id, plan_sha256: row.plan_sha256 }
    : readPlan(row, state);
}

function readObservation(row: ObservationRow, input: WorkspaceMcpObservationStoreInput, state: "COMMITTED" | "REPLAY"): WorkspaceMcpObservationStoreResult {
  const observation = decodeJson(row.observation_json);
  const receipt = decodeJson(row.receipt_json);
  if (observation === undefined || receipt === undefined || row.observation_id !== input.observation_id ||
      row.plan_id !== input.plan_id || row.principal_ref !== input.principal_ref ||
      row.deployment_generation !== input.deployment_generation || row.auth_profile !== input.auth_profile ||
      row.google_transport !== input.google_transport || row.idempotency_key !== input.idempotency_key ||
      row.receipt_sha256 !== input.receipt_sha256 || row.observation_sha256 !== input.observation_sha256 ||
      row.disposition !== input.disposition || !sameJson(receipt, input.receipt) || !sameJson(observation, input.observation)) {
    return { state: "UNKNOWN" };
  }
  return { state, observation };
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
      return readIssuedPlan(row, input, "REPLAY");
    }
    try {
      await database.prepare(
        "INSERT INTO workspace_mcp_plan(plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,input_fingerprint,plan_sha256,plan_json,issued_at,expires_at,state,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'ISSUED',?10)",
      ).bind(input.plan_id, input.principal_ref, input.deployment_generation, input.auth_profile, input.google_transport, input.idempotency_key, input.input_fingerprint, input.plan_sha256, JSON.stringify(input.plan), input.issued_at, input.expires_at).run();
    } catch {
      try { row = await existingPlan(input); } catch { return { state: "UNKNOWN", plan_id: input.plan_id, plan_sha256: input.plan_sha256 }; }
      if (row === null) return { state: "UNKNOWN", plan_id: input.plan_id, plan_sha256: input.plan_sha256 };
      if (!samePlanIdentity(row, input) || row.input_fingerprint !== input.input_fingerprint || Date.parse(input.issued_at) >= Date.parse(row.expires_at)) {
        return row.input_fingerprint === input.input_fingerprint && Date.parse(input.issued_at) >= Date.parse(row.expires_at)
          ? { state: "CONFLICT", code: "PLAN_EXPIRED" }
          : { state: "CONFLICT", code: "IDEMPOTENCY_CONFLICT" };
      }
      return readIssuedPlan(row, input, "REPLAY");
    }
    try {
      row = await database.prepare("SELECT plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,input_fingerprint,plan_sha256,plan_json,expires_at FROM workspace_mcp_plan WHERE plan_id=?1 LIMIT 1").bind(input.plan_id).first<PlanRow>() ?? null;
    } catch { return { state: "UNKNOWN", plan_id: input.plan_id, plan_sha256: input.plan_sha256 }; }
    return row === null ? { state: "UNKNOWN", plan_id: input.plan_id, plan_sha256: input.plan_sha256 } : readIssuedPlan(row, input, "COMMITTED");
  }

  async function loadPlan(input: WorkspaceMcpPlanLookup): Promise<WorkspaceMcpPlanLookupResult> {
    try {
      const row = await database.prepare(
        "SELECT plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,input_fingerprint,plan_sha256,plan_json,expires_at FROM workspace_mcp_plan WHERE plan_id=?1 AND principal_ref=?2 AND deployment_generation=?3 AND auth_profile=?4 AND google_transport=?5 AND idempotency_key=?6 LIMIT 1",
      ).bind(input.plan_id, input.principal_ref, input.deployment_generation, input.auth_profile, input.google_transport, input.idempotency_key).first<PlanRow>();
      if (row === null || row === undefined) return { state: "NOT_FOUND" };
      const checked = readPlan(row);
      return checked.state === "COMMITTED" || checked.state === "REPLAY"
        ? { state: "FOUND", plan: checked.plan }
        : { state: "UNKNOWN" };
    } catch { return { state: "UNKNOWN" }; }
  }

  async function recordObservation(input: WorkspaceMcpObservationStoreInput): Promise<WorkspaceMcpObservationStoreResult> {
    try {
      const owner = await database.prepare(
        "SELECT plan_id FROM workspace_mcp_plan WHERE plan_id=?1 AND principal_ref=?2 AND deployment_generation=?3 AND auth_profile=?4 AND google_transport=?5 AND idempotency_key=?6 AND plan_sha256=?7 LIMIT 1",
      ).bind(input.plan_id, input.principal_ref, input.deployment_generation, input.auth_profile, input.google_transport, input.idempotency_key, input.plan_sha256).first<{ plan_id: string }>();
      if (owner === null || owner === undefined) return { state: "UNKNOWN" };
      const previous = await database.prepare("SELECT observation_id,plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,receipt_sha256,observation_sha256,receipt_json,observation_json,disposition FROM workspace_mcp_observation WHERE plan_id=?1 AND receipt_sha256=?2 LIMIT 1").bind(input.plan_id, input.receipt_sha256).first<ObservationRow>();
      if (previous !== null && previous !== undefined) {
        return readObservation(previous, input, "REPLAY");
      }
      await database.prepare(
        "INSERT INTO workspace_mcp_observation(observation_id,plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,receipt_sha256,receipt_json,observation_json,observation_sha256,disposition,reason_codes_json,observed_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)",
      ).bind(input.observation_id, input.plan_id, input.principal_ref, input.deployment_generation, input.auth_profile, input.google_transport, input.idempotency_key, input.receipt_sha256, JSON.stringify(input.receipt), JSON.stringify(input.observation), input.observation_sha256, input.disposition, JSON.stringify(input.reason_codes), input.observed_at).run();
      const stored = await database.prepare("SELECT observation_id,plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,receipt_sha256,observation_sha256,receipt_json,observation_json,disposition FROM workspace_mcp_observation WHERE observation_id=?1 AND plan_id=?2 AND receipt_sha256=?3 LIMIT 1").bind(input.observation_id, input.plan_id, input.receipt_sha256).first<ObservationRow>();
      return stored === null || stored === undefined ? { state: "UNKNOWN" } : readObservation(stored, input, "COMMITTED");
    } catch {
      try {
        const stored = await database.prepare("SELECT observation_id,plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,receipt_sha256,observation_sha256,receipt_json,observation_json,disposition FROM workspace_mcp_observation WHERE plan_id=?1 AND receipt_sha256=?2 LIMIT 1").bind(input.plan_id, input.receipt_sha256).first<ObservationRow>();
        return stored === null || stored === undefined ? { state: "UNKNOWN" } : readObservation(stored, input, "REPLAY");
      } catch { return { state: "UNKNOWN" }; }
    }
  }

  return { issuePlan, loadPlan, recordObservation };
}
