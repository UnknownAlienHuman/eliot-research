import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { WorkspaceMcpObservationV2Schema, WorkspaceMcpPlanV2Schema, WorkspaceMcpReceiptV2Schema } from "@eliotr/contracts";
import type { WorkspaceMcpObservationV2, WorkspaceMcpPlanV2, WorkspaceMcpReceiptV2 } from "@eliotr/contracts";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import { createD1WorkspaceMcpCandidateStore } from "../src/workspace-mcp-candidate-store.js";
import workspaceLedgerMigration from "../../../infra/d1/core/migrations/0031_workspace_mcp_candidate_ledger.sql?raw";

const database = (env as unknown as { CORE_DB: D1Database }).CORE_DB;
const store = () => createD1WorkspaceMcpCandidateStore(database);
type Fixture = { plan: WorkspaceMcpPlanV2; receipt: WorkspaceMcpReceiptV2; observation: WorkspaceMcpObservationV2; receiptSha: string; observationSha: string; inputFingerprint: string };

async function fixture(principal_ref: string): Promise<Fixture> {
  const planInput = {
    protocol: "eliotr.google-sync.plan.v2" as const, idempotency_key: "key-1", google_product: "drive" as const,
    action: "read" as const, direction: "google_to_eliot_candidate" as const, dry_run: true as const, target_ref: "file-1",
  };
  const inputFingerprint = await canonicalDigest(planInput);
  const planId = `workspace-mcp-plan-${await canonicalDigest([
    "eliotr.workspace-mcp.plan-id.v2", principal_ref, "deploy-1", "managed-oauth", "gemini-mcp", planInput.idempotency_key,
  ])}`;
  const planBase = {
    ...planInput, plan_id: planId, input_fingerprint: inputFingerprint, issued_at: "2026-09-09T12:00:00.000Z", expires_at: "2026-09-09T12:15:00.000Z",
    deployment_generation: "deploy-1", auth_profile: "managed-oauth" as const, google_transport: "gemini-mcp" as const, connector: "google-workspace" as const,
    candidate_only: true as const, effect_ceiling: "NO_EXTERNAL_EFFECT" as const, candidate_ledger_mutation: "ISSUED" as const, exact_readback_required: true as const,
    eliot_authority_changed: false as const, confirmation_required: false, required_readback_fields: ["resource_id", "observed_revision", "observed_at", "readback_performed"],
  };
  const plan: WorkspaceMcpPlanV2 = WorkspaceMcpPlanV2Schema.parse({ ...planBase, plan_sha256: await canonicalDigest(planBase) });
  const receipt: WorkspaceMcpReceiptV2 = WorkspaceMcpReceiptV2Schema.parse({
    connector: "google-workspace", google_product: "drive", action: "read", resource_id: "file-1", observed_revision: "r1",
    observed_at: "2026-09-09T12:01:00.000Z", readback_performed: true,
  });
  const receiptSha = await canonicalDigest(receipt);
  const observationId = `workspace-mcp-observation-${await canonicalDigest(["eliotr.workspace-mcp.observation-id.v2", plan.plan_id, receiptSha])}`;
  const observation: WorkspaceMcpObservationV2 = WorkspaceMcpObservationV2Schema.parse({
    protocol: "eliotr.google-sync.observation.v2", observation_id: observationId, plan_id: plan.plan_id, idempotency_key: plan.idempotency_key,
    plan_sha256: plan.plan_sha256, state: "OBSERVED", disposition: "OBSERVED_MATCH", receipt_sha256: receiptSha, reason_codes: [], candidate_only: true,
    source_evidence_authority_changed: false, candidate_ledger_mutation: "OBSERVED", reconciliation: { idempotency_key: plan.idempotency_key, plan_id: plan.plan_id,
      plan_sha256: plan.plan_sha256, write_state: "COMMITTED", retry: "SAME_KEY" },
  });
  return { plan, receipt, observation, receiptSha, observationSha: await canonicalDigest(observation), inputFingerprint };
}

const ACTOR_A = await fixture("actor-a");
const ACTOR_B = await fixture("actor-b");

function input(fixtureValue: Fixture = ACTOR_A, principal_ref = "actor-a", fingerprint = fixtureValue.inputFingerprint) {
  const plan = fixtureValue.plan;
  return { principal_ref, deployment_generation: plan.deployment_generation, auth_profile: plan.auth_profile,
    google_transport: "gemini-mcp" as const, idempotency_key: plan.idempotency_key, input_fingerprint: fingerprint,
    plan_id: plan.plan_id, plan_sha256: plan.plan_sha256, issued_at: plan.issued_at, expires_at: plan.expires_at, plan };
}

beforeAll(async () => {
  const existing = await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_mcp_plan'").first<{ name: string }>();
  if (existing !== null && existing !== undefined) return;
  for (const statement of workspaceLedgerMigration.split(/;\s*(?=CREATE )/u).map((value) => value.trim()).filter(Boolean)) {
    await database.prepare(statement.endsWith(";") ? statement : `${statement};`).run();
  }
});

describe("Workspace MCP candidate ledger on local D1", () => {
  it("replays exact plans, conflicts changed keys, and isolates verified actors", async () => {
    const candidate = store();
    const first = await candidate.issuePlan(input()); expect(first.state).toBe("COMMITTED");
    expect((await candidate.issuePlan(input())).state).toBe("REPLAY");
    expect((await candidate.issuePlan(input(ACTOR_A, "actor-a", "b".repeat(64)))).state).toBe("CONFLICT");
    expect((await candidate.issuePlan(input(ACTOR_B, "actor-b"))).state).toBe("COMMITTED");
    expect(await database.prepare("SELECT COUNT(*) AS n FROM workspace_mcp_plan WHERE idempotency_key='key-1'").first("n")).toBe(2);
  });

  it("round-trips an exact readback observation and replays it by receipt digest", async () => {
    const candidate = store();
    await candidate.issuePlan(input());
    const first = await candidate.recordObservation({ ...input(), observation_id: ACTOR_A.observation.observation_id,
      observation_sha256: ACTOR_A.observationSha, receipt_sha256: ACTOR_A.receiptSha, disposition: "OBSERVED_MATCH", reason_codes: [], receipt: ACTOR_A.receipt,
      observation: ACTOR_A.observation, observed_at: ACTOR_A.receipt.observed_at });
    expect(first.state).toBe("COMMITTED");
    const recomputedAfterExpiry = WorkspaceMcpObservationV2Schema.parse({ ...ACTOR_A.observation,
      disposition: "OBSERVED_MISMATCH", reason_codes: ["PLAN_EXPIRED"] });
    const replay = await candidate.recordObservation({ ...input(), observation_id: ACTOR_A.observation.observation_id,
      observation_sha256: await canonicalDigest(recomputedAfterExpiry), receipt_sha256: ACTOR_A.receiptSha, disposition: "OBSERVED_MISMATCH", reason_codes: ["PLAN_EXPIRED"], receipt: ACTOR_A.receipt,
      observation: recomputedAfterExpiry, observed_at: ACTOR_A.receipt.observed_at });
    expect(replay.state).toBe("REPLAY");
    expect((replay.state === "REPLAY" ? replay.observation : undefined)?.disposition).toBe("OBSERVED_MATCH");
    expect(await database.prepare("SELECT COUNT(*) AS n FROM workspace_mcp_observation").first("n")).toBe(1);
  });

  it("rejects attempts to mutate the append-only rows", async () => {
    const candidate = store();
    await expect(database.prepare("UPDATE workspace_mcp_plan SET state='ISSUED' WHERE plan_id=?1").bind(ACTOR_A.plan.plan_id).run()).rejects.toThrow();
    await expect(database.prepare("DELETE FROM workspace_mcp_plan WHERE plan_id=?1").bind(ACTOR_A.plan.plan_id).run()).rejects.toThrow();
    void candidate;
  });
});
