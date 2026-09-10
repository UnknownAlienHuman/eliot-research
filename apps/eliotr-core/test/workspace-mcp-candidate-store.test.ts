import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkspaceMcpObservationV2Schema, WorkspaceMcpPlanV2Schema, WorkspaceMcpReceiptV2Schema } from "@eliotr/contracts";
import type { WorkspaceMcpObservationV2, WorkspaceMcpReceiptV2 } from "@eliotr/contracts";
import { createD1WorkspaceMcpCandidateStore } from "../src/workspace-mcp-candidate-store.js";

const database = (env as unknown as { CORE_DB: D1Database }).CORE_DB;
const store = () => createD1WorkspaceMcpCandidateStore(database);
const DIGEST = "a".repeat(64);
const PLAN = WorkspaceMcpPlanV2Schema.parse({
  protocol: "eliotr.google-sync.plan.v2", idempotency_key: "key-1", google_product: "drive", action: "read",
  direction: "google_to_eliot_candidate", dry_run: true, target_ref: "file-1", plan_id: `workspace-mcp-plan-${DIGEST}`,
  input_fingerprint: DIGEST, plan_sha256: DIGEST, issued_at: "2026-09-09T12:00:00.000Z", expires_at: "2026-09-09T12:15:00.000Z",
  deployment_generation: "deploy-1", auth_profile: "managed-oauth", google_transport: "gemini-mcp", connector: "google-workspace",
  candidate_only: true, effect_ceiling: "NO_EXTERNAL_EFFECT", candidate_ledger_mutation: "ISSUED", exact_readback_required: true,
  eliot_authority_changed: false, confirmation_required: false, required_readback_fields: ["resource_id", "observed_revision", "observed_at", "readback_performed"],
});
const RECEIPT: WorkspaceMcpReceiptV2 = WorkspaceMcpReceiptV2Schema.parse({
  connector: "google-workspace", google_product: "drive", action: "read", resource_id: "file-1", observed_revision: "r1",
  observed_at: "2026-09-09T12:01:00.000Z", readback_performed: true,
});
const OBSERVATION: WorkspaceMcpObservationV2 = WorkspaceMcpObservationV2Schema.parse({
  protocol: "eliotr.google-sync.observation.v2", observation_id: `workspace-mcp-observation-${DIGEST}`,
  plan_id: PLAN.plan_id, idempotency_key: PLAN.idempotency_key, plan_sha256: PLAN.plan_sha256, state: "OBSERVED",
  disposition: "OBSERVED_MATCH", receipt_sha256: DIGEST, reason_codes: [], candidate_only: true,
  source_evidence_authority_changed: false, reconciliation: { idempotency_key: PLAN.idempotency_key, plan_id: PLAN.plan_id,
    plan_sha256: PLAN.plan_sha256, write_state: "COMMITTED", retry: "SAME_KEY" },
});

function input(principal_ref = "actor-a", fingerprint = DIGEST) {
  const plan = principal_ref === "actor-a" ? PLAN : { ...PLAN, plan_id: `workspace-mcp-plan-${"b".repeat(64)}` };
  return { principal_ref, deployment_generation: plan.deployment_generation, auth_profile: plan.auth_profile,
    google_transport: "gemini-mcp" as const, idempotency_key: PLAN.idempotency_key, input_fingerprint: fingerprint,
    plan_id: plan.plan_id, plan_sha256: plan.plan_sha256, issued_at: plan.issued_at, expires_at: plan.expires_at, plan };
}

beforeEach(async () => {
  await database.prepare("DELETE FROM workspace_mcp_observation").run();
  await database.prepare("DELETE FROM workspace_mcp_plan").run();
});

describe("Workspace MCP candidate ledger on local D1", () => {
  it("replays exact plans, conflicts changed keys, and isolates verified actors", async () => {
    const candidate = store();
    expect((await candidate.issuePlan(input())).state).toBe("COMMITTED");
    expect((await candidate.issuePlan(input())).state).toBe("REPLAY");
    expect((await candidate.issuePlan(input("actor-a", "b".repeat(64)))).state).toBe("CONFLICT");
    expect((await candidate.issuePlan(input("actor-b"))).state).toBe("COMMITTED");
    expect(await database.prepare("SELECT COUNT(*) AS n FROM workspace_mcp_plan").first("n")).toBe(2);
  });

  it("round-trips an exact readback observation and replays it by receipt digest", async () => {
    const candidate = store();
    await candidate.issuePlan(input());
    const first = await candidate.recordObservation({ ...input(), observation_id: OBSERVATION.observation_id,
      observation_sha256: DIGEST, receipt_sha256: DIGEST, disposition: "OBSERVED_MATCH", reason_codes: [], receipt: RECEIPT,
      observation: OBSERVATION, observed_at: RECEIPT.observed_at });
    expect(first.state).toBe("COMMITTED");
    const replay = await candidate.recordObservation({ ...input(), observation_id: OBSERVATION.observation_id,
      observation_sha256: DIGEST, receipt_sha256: DIGEST, disposition: "OBSERVED_MATCH", reason_codes: [], receipt: RECEIPT,
      observation: OBSERVATION, observed_at: RECEIPT.observed_at });
    expect(replay.state).toBe("REPLAY");
    expect(await database.prepare("SELECT COUNT(*) AS n FROM workspace_mcp_observation").first("n")).toBe(1);
  });
});
