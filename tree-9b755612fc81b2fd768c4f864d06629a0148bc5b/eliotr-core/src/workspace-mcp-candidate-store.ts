import type { D1Database } from "@cloudflare/workers-types";
import {
  WorkspaceMcpObservationV2Schema,
  WorkspaceMcpPlanV2InputSchema,
  WorkspaceMcpPlanV2Schema,
  WorkspaceMcpReceiptV2Schema,
} from "@eliotr/contracts";
import { canonicalDigest, canonicalJson } from "@eliotr/platform-cloudflare";
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
  readonly reason_codes_json: string;
}

function decodeJson(raw: string): unknown | undefined {
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

function samePlanIdentity(row: PlanRow, input: WorkspaceMcpPlanStoreInput): boolean {
  return row.plan_id === input.plan_id && row.principal_ref === input.principal_ref &&
    row.deployment_generation === input.deployment_generation && row.auth_profile === input.auth_profile &&
    row.google_transport === input.google_transport && row.idempotency_key === input.idempotency_key;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function planInput(value: Record<string, unknown>): unknown {
  const input = Object.fromEntries([
    "protocol", "idempotency_key", "google_product", "action", "direction",
    "source_ref", "target_ref", "expected_revision", "payload_sha256", "dry_run",
  ].filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
  const parsed = WorkspaceMcpPlanV2InputSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

function planWithoutDigest(value: Record<string, unknown>): Record<string, unknown> {
  const { plan_sha256: _ignored, ...rest } = value;
  return rest;
}

async function readPlan(row: PlanRow, state: "COMMITTED" | "REPLAY" = "REPLAY"): Promise<WorkspaceMcpPlanStoreResult> {
  const plan = decodeJson(row.plan_json);
  if (plan === undefined || typeof plan !== "object" || plan === null) {
    return { state: "UNKNOWN", plan_id: row.plan_id, plan_sha256: row.plan_sha256 };
  }
  const value = plan as Record<string, unknown>;
  const parsed = WorkspaceMcpPlanV2Schema.safeParse(value);
  const input = planInput(value);
  if (!parsed.success || input === undefined) {
    return { state: "UNKNOWN", plan_id: row.plan_id, plan_sha256: row.plan_sha256 };
  }
  const [inputFingerprint, planSha256, expectedPlanId] = await Promise.all([
    canonicalDigest(input),
    canonicalDigest(planWithoutDigest(value)),
    canonicalDigest([
      "eliotr.workspace-mcp.plan-id.v2", row.principal_ref, row.deployment_generation,
      row.auth_profile, row.google_transport, row.idempotency_key,
    ]),
  ]);
  if (value.plan_id !== row.plan_id || value.input_fingerprint !== row.input_fingerprint ||
      value.input_fingerprint !== inputFingerprint || value.plan_sha256 !== row.plan_sha256 ||
      value.plan_sha256 !== planSha256 || row.plan_id !== `workspace-mcp-plan-${expectedPlanId}` ||
      value.plan_sha256 !== row.plan_sha256 || value.idempotency_key !== row.idempotency_key ||
      value.deployment_generation !== row.deployment_generation || value.auth_profile !== row.auth_profile ||
      value.google_transport !== row.google_transport || value.candidate_ledger_mutation !== "ISSUED") {
    return { state: "UNKNOWN", plan_id: row.plan_id, plan_sha256: row.plan_sha256 };
  }
  return { state, plan };
}

async function readIssuedPlan(row: PlanRow, input: WorkspaceMcpPlanStoreInput, state: "COMMITTED" | "REPLAY"): Promise<WorkspaceMcpPlanStoreResult> {
  return !samePlanIdentity(row, input) || row.input_fingerprint !== input.input_fingerprint
    ? { state: "UNKNOWN", plan_id: row.plan_id, plan_sha256: row.plan_sha256 }
    : await readPlan(row, state);
}

async function readObservation(row: ObservationRow, input: WorkspaceMcpObservationStoreInput, state: "COMMITTED" | "REPLAY"): Promise<WorkspaceMcpObservationStoreResult> {
  const observation = decodeJson(row.observation_json);
  const receipt = decodeJson(row.receipt_json);
  const reasonCodes = decodeJson(row.reason_codes_json);
  const checkedObservation = WorkspaceMcpObservationV2Schema.safeParse(observation);
  const checkedReceipt = WorkspaceMcpReceiptV2Schema.safeParse(receipt);
  if (observation === undefined || receipt === undefined || !checkedObservation.success || !checkedReceipt.success ||
      !Array.isArray(reasonCodes) || row.observation_id !== input.observation_id ||
      row.plan_id !== input.plan_id || row.principal_ref !== input.principal_ref ||
      row.deployment_generation !== input.deployment_generation || row.auth_profile !== input.auth_profile ||
      row.google_transport !== input.google_transport || row.idempotency_key !== input.idempotency_key ||
      row.receipt_sha256 !== input.receipt_sha256 ||
      row.disposition !== checkedObservation.data.disposition ||
      checkedObservation.data.observation_id !== row.observation_id ||
      checkedObservation.data.plan_id !== row.plan_id ||
      checkedObservation.data.idempotency_key !== row.idempotency_key ||
      checkedObservation.data.plan_sha256 !== input.plan_sha256 ||
      checkedObservation.data.receipt_sha256 !== row.receipt_sha256 ||
      !sameJson(reasonCodes, checkedObservation.data.reason_codes) ||
      !sameJson(receipt, checkedReceipt.data) || !sameJson(receipt, input.receipt) ||
      await canonicalDigest(checkedReceipt.data) !== row.receipt_sha256 ||
      await canonicalDigest(checkedObservation.data) !== row.observation_sha256 ||
      `workspace-mcp-observation-${await canonicalDigest(["eliotr.workspace-mcp.observation-id.v2", row.plan_id, row.receipt_sha256])}` !== row.observation_id) {
    return { state: "UNKNOWN" };
  }
  return { state, observation: checkedObservation.data };
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
      return await readIssuedPlan(row, input, "REPLAY");
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
      return await readIssuedPlan(row, input, "REPLAY");
    }
    try {
      row = await database.prepare("SELECT plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,input_fingerprint,plan_sha256,plan_json,expires_at FROM workspace_mcp_plan WHERE plan_id=?1 LIMIT 1").bind(input.plan_id).first<PlanRow>() ?? null;
    } catch { return { state: "UNKNOWN", plan_id: input.plan_id, plan_sha256: input.plan_sha256 }; }
    return row === null ? { state: "UNKNOWN", plan_id: input.plan_id, plan_sha256: input.plan_sha256 } : await readIssuedPlan(row, input, "COMMITTED");
  }

  async function loadPlan(input: WorkspaceMcpPlanLookup): Promise<WorkspaceMcpPlanLookupResult> {
    try {
      const row = await database.prepare(
        "SELECT plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,input_fingerprint,plan_sha256,plan_json,expires_at FROM workspace_mcp_plan WHERE plan_id=?1 AND principal_ref=?2 AND deployment_generation=?3 AND auth_profile=?4 AND google_transport=?5 AND idempotency_key=?6 LIMIT 1",
      ).bind(input.plan_id, input.principal_ref, input.deployment_generation, input.auth_profile, input.google_transport, input.idempotency_key).first<PlanRow>();
      if (row === null || row === undefined) return { state: "NOT_FOUND" };
      const checked = await readPlan(row);
      return checked.state === "COMMITTED" || checked.state === "REPLAY"
        ? { state: "FOUND", plan: checked.plan }
        : { state: "UNKNOWN" };
    } catch { return { state: "UNKNOWN" }; }
  }

  async function recordObservation(input: WorkspaceMcpObservationStoreInput): Promise<WorkspaceMcpObservationStoreResult> {
    try {
      const owner = await database.prepare(
        "SELECT plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,input_fingerprint,plan_sha256,plan_json,expires_at FROM workspace_mcp_plan WHERE plan_id=?1 AND principal_ref=?2 AND deployment_generation=?3 AND auth_profile=?4 AND google_transport=?5 AND idempotency_key=?6 AND plan_sha256=?7 LIMIT 1",
      ).bind(input.plan_id, input.principal_ref, input.deployment_generation, input.auth_profile, input.google_transport, input.idempotency_key, input.plan_sha256).first<PlanRow>();
      if (owner === null || owner === undefined) return { state: "UNKNOWN" };
      const ownerPlan = await readPlan(owner);
      if (ownerPlan.state !== "REPLAY" && ownerPlan.state !== "COMMITTED") return { state: "UNKNOWN" };
      const previous = await database.prepare("SELECT observation_id,plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,receipt_sha256,observation_sha256,receipt_json,observation_json,disposition,reason_codes_json FROM workspace_mcp_observation WHERE plan_id=?1 AND receipt_sha256=?2 LIMIT 1").bind(input.plan_id, input.receipt_sha256).first<ObservationRow>();
      if (previous !== null && previous !== undefined) {
        return readObservation(previous, input, "REPLAY");
      }
      await database.prepare(
        "INSERT INTO workspace_mcp_observation(observation_id,plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,receipt_sha256,receipt_json,observation_json,observation_sha256,disposition,reason_codes_json,observed_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)",
      ).bind(input.observation_id, input.plan_id, input.principal_ref, input.deployment_generation, input.auth_profile, input.google_transport, input.idempotency_key, input.receipt_sha256, JSON.stringify(input.receipt), JSON.stringify(input.observation), input.observation_sha256, input.disposition, JSON.stringify(input.reason_codes), input.observed_at).run();
      const stored = await database.prepare("SELECT observation_id,plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,receipt_sha256,observation_sha256,receipt_json,observation_json,disposition,reason_codes_json FROM workspace_mcp_observation WHERE observation_id=?1 AND plan_id=?2 AND receipt_sha256=?3 LIMIT 1").bind(input.observation_id, input.plan_id, input.receipt_sha256).first<ObservationRow>();
      return stored === null || stored === undefined ? { state: "UNKNOWN" } : readObservation(stored, input, "COMMITTED");
    } catch {
      try {
        const stored = await database.prepare("SELECT observation_id,plan_id,principal_ref,deployment_generation,auth_profile,google_transport,idempotency_key,receipt_sha256,observation_sha256,receipt_json,observation_json,disposition,reason_codes_json FROM workspace_mcp_observation WHERE plan_id=?1 AND receipt_sha256=?2 LIMIT 1").bind(input.plan_id, input.receipt_sha256).first<ObservationRow>();
        return stored === null || stored === undefined ? { state: "UNKNOWN" } : readObservation(stored, input, "REPLAY");
      } catch { return { state: "UNKNOWN" }; }
    }
  }

  return { issuePlan, loadPlan, recordObservation };
}
