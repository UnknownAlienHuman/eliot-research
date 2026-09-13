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

type WorkspaceMcpObservationLookup = Parameters<NonNullable<WorkspaceMcpCandidateStore["loadObservation"]>>[0];
type WorkspaceMcpObservationLookupResult = Awaited<ReturnType<NonNullable<WorkspaceMcpCandidateStore["loadObservation"]>>>;
type WorkspaceMcpObservationReadback = Extract<WorkspaceMcpObservationLookupResult, { readonly state: "FOUND" }>["readback"];

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
  readonly observed_at?: string;
}

interface ObservationReadbackRow {
  readonly plan_id: string;
  readonly plan_principal_ref: string;
  readonly plan_deployment_generation: string;
  readonly plan_auth_profile: string;
  readonly plan_google_transport: string;
  readonly plan_idempotency_key: string;
  readonly plan_input_fingerprint: string;
  readonly plan_sha256: string;
  readonly plan_json: string;
  readonly plan_issued_at: string;
  readonly plan_expires_at: string;
  readonly plan_state: string;
  readonly observation_id: string;
  readonly observation_plan_id: string;
  readonly observation_principal_ref: string;
  readonly observation_deployment_generation: string;
  readonly observation_auth_profile: string;
  readonly observation_google_transport: string;
  readonly observation_idempotency_key: string;
  readonly receipt_sha256: string;
  readonly observation_sha256: string;
  readonly observation_json: string;
  readonly receipt_json: string;
  readonly disposition: string;
  readonly reason_codes_json: string;
  readonly observed_at: string;
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
      (row.observed_at !== undefined && row.observed_at !== checkedReceipt.data.observed_at) ||
      !sameJson(reasonCodes, checkedObservation.data.reason_codes) ||
      !sameJson(receipt, checkedReceipt.data) || !sameJson(receipt, input.receipt) ||
      await canonicalDigest(checkedReceipt.data) !== row.receipt_sha256 ||
      await canonicalDigest(checkedObservation.data) !== row.observation_sha256 ||
      `workspace-mcp-observation-${await canonicalDigest(["eliotr.workspace-mcp.observation-id.v2", row.plan_id, row.receipt_sha256])}` !== row.observation_id) {
    return { state: "UNKNOWN" };
  }
  return { state, observation: checkedObservation.data };
}

function freezeDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value) as T;
  }
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeDeep(child);
    return Object.freeze(value) as T;
  }
  return value;
}

async function readObservationReadback(
  row: ObservationReadbackRow,
  lookup: WorkspaceMcpObservationLookup,
): Promise<WorkspaceMcpObservationLookupResult> {
  if (row.plan_state !== "ISSUED" || row.plan_id !== lookup.plan_id ||
      row.plan_principal_ref !== lookup.principal_ref ||
      row.plan_deployment_generation !== lookup.deployment_generation ||
      row.plan_auth_profile !== lookup.auth_profile || row.plan_google_transport !== lookup.google_transport ||
      row.plan_idempotency_key !== lookup.idempotency_key || row.plan_sha256 !== lookup.plan_sha256 ||
      row.observation_id !== lookup.observation_id || row.observation_plan_id !== row.plan_id ||
      row.observation_principal_ref !== row.plan_principal_ref ||
      row.observation_deployment_generation !== row.plan_deployment_generation ||
      row.observation_auth_profile !== row.plan_auth_profile ||
      row.observation_google_transport !== row.plan_google_transport ||
      row.observation_idempotency_key !== row.plan_idempotency_key) {
    return { state: "UNKNOWN" };
  }
  const planResult = await readPlan({
    plan_id: row.plan_id,
    principal_ref: row.plan_principal_ref,
    deployment_generation: row.plan_deployment_generation,
    auth_profile: row.plan_auth_profile,
    google_transport: row.plan_google_transport,
    idempotency_key: row.plan_idempotency_key,
    input_fingerprint: row.plan_input_fingerprint,
    plan_sha256: row.plan_sha256,
    plan_json: row.plan_json,
    expires_at: row.plan_expires_at,
  });
  if (planResult.state !== "COMMITTED" && planResult.state !== "REPLAY") return { state: "UNKNOWN" };
  const checkedPlan = WorkspaceMcpPlanV2Schema.safeParse(planResult.plan);
  const observation = decodeJson(row.observation_json);
  const receipt = decodeJson(row.receipt_json);
  const reasonCodes = decodeJson(row.reason_codes_json);
  const checkedObservation = WorkspaceMcpObservationV2Schema.safeParse(observation);
  const checkedReceipt = WorkspaceMcpReceiptV2Schema.safeParse(receipt);
  if (!checkedPlan.success || !checkedObservation.success || !checkedReceipt.success ||
      !Array.isArray(reasonCodes) || checkedObservation.data.state !== "OBSERVED" ||
      row.plan_issued_at !== checkedPlan.data.issued_at || row.plan_expires_at !== checkedPlan.data.expires_at ||
      row.plan_input_fingerprint !== checkedPlan.data.input_fingerprint ||
      row.disposition !== checkedObservation.data.disposition ||
      checkedObservation.data.observation_id !== row.observation_id ||
      checkedObservation.data.plan_id !== row.plan_id ||
      checkedObservation.data.idempotency_key !== row.plan_idempotency_key ||
      checkedObservation.data.plan_sha256 !== row.plan_sha256 ||
      checkedObservation.data.receipt_sha256 !== row.receipt_sha256 ||
      checkedObservation.data.reconciliation.idempotency_key !== row.plan_idempotency_key ||
      checkedObservation.data.reconciliation.plan_id !== row.plan_id ||
      checkedObservation.data.reconciliation.plan_sha256 !== row.plan_sha256 ||
      checkedObservation.data.reconciliation.write_state !== "COMMITTED" ||
      checkedObservation.data.reconciliation.retry !== "SAME_KEY" ||
      row.observed_at !== checkedReceipt.data.observed_at ||
      !sameJson(reasonCodes, checkedObservation.data.reason_codes) ||
      !sameJson(observation, checkedObservation.data) || !sameJson(receipt, checkedReceipt.data) ||
      await canonicalDigest(checkedReceipt.data) !== row.receipt_sha256 ||
      await canonicalDigest(checkedObservation.data) !== row.observation_sha256 ||
      `workspace-mcp-observation-${await canonicalDigest(["eliotr.workspace-mcp.observation-id.v2", row.plan_id, row.receipt_sha256])}` !== row.observation_id) {
    return { state: "UNKNOWN" };
  }
  const readback: WorkspaceMcpObservationReadback = {
    plan: checkedPlan.data,
    observation: checkedObservation.data,
    receipt: checkedReceipt.data,
    provenance: {
      principal_ref: row.plan_principal_ref,
      deployment_generation: row.plan_deployment_generation,
      auth_profile: row.plan_auth_profile as "service-token" | "managed-oauth",
      google_transport: row.plan_google_transport as "gemini-mcp",
      idempotency_key: row.plan_idempotency_key,
      plan_id: row.plan_id,
      plan_sha256: row.plan_sha256,
      input_fingerprint: row.plan_input_fingerprint,
      observation_id: row.observation_id,
      observation_sha256: row.observation_sha256,
      receipt_sha256: row.receipt_sha256,
      issued_at: row.plan_issued_at,
      expires_at: row.plan_expires_at,
      observed_at: row.observed_at,
    },
  };
  return { state: "FOUND", readback: freezeDeep(readback) };
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

  async function loadObservation(input: WorkspaceMcpObservationLookup): Promise<WorkspaceMcpObservationLookupResult> {
    const lookup = Object.freeze({ ...input });
    try {
      const row = await database.prepare(
        "SELECT p.plan_id AS plan_id,p.principal_ref AS plan_principal_ref,p.deployment_generation AS plan_deployment_generation,p.auth_profile AS plan_auth_profile,p.google_transport AS plan_google_transport,p.idempotency_key AS plan_idempotency_key,p.input_fingerprint AS plan_input_fingerprint,p.plan_sha256 AS plan_sha256,p.plan_json AS plan_json,p.issued_at AS plan_issued_at,p.expires_at AS plan_expires_at,p.state AS plan_state,o.observation_id AS observation_id,o.plan_id AS observation_plan_id,o.principal_ref AS observation_principal_ref,o.deployment_generation AS observation_deployment_generation,o.auth_profile AS observation_auth_profile,o.google_transport AS observation_google_transport,o.idempotency_key AS observation_idempotency_key,o.receipt_sha256 AS receipt_sha256,o.observation_sha256 AS observation_sha256,o.observation_json AS observation_json,o.receipt_json AS receipt_json,o.disposition AS disposition,o.reason_codes_json AS reason_codes_json,o.observed_at AS observed_at FROM workspace_mcp_plan AS p INNER JOIN workspace_mcp_observation AS o ON o.plan_id=p.plan_id WHERE p.plan_id=?1 AND p.principal_ref=?2 AND p.deployment_generation=?3 AND p.auth_profile=?4 AND p.google_transport=?5 AND p.idempotency_key=?6 AND p.plan_sha256=?7 AND p.state='ISSUED' AND o.observation_id=?8 LIMIT 1",
      ).bind(
        lookup.plan_id,
        lookup.principal_ref,
        lookup.deployment_generation,
        lookup.auth_profile,
        lookup.google_transport,
        lookup.idempotency_key,
        lookup.plan_sha256,
        lookup.observation_id,
      ).first<ObservationReadbackRow>();
      if (row === null || row === undefined) return { state: "NOT_FOUND" };
      return await readObservationReadback(row, lookup);
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

  return { issuePlan, loadPlan, loadObservation, recordObservation };
}
