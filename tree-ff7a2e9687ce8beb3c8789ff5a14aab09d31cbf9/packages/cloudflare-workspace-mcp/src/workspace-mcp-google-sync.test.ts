import { describe, expect, it } from "vitest";
import { createWorkspacePlan, validateWorkspaceReceipt } from "./workspace-mcp-google-sync.js";
import type { WorkspaceMcpCandidateStore } from "./workspace-mcp-ledger.js";
import type { GeminiMcpToolDependencies } from "./gemini-mcp-tool-common.js";
import type { McpToolCallContext } from "./gemini-mcp-protocol.js";

const context: McpToolCallContext = { principal_ref: "actor-a", trace_id: "trace", deployment_generation: "deploy-1" };
const intent = { protocol: "eliotr.google-sync.plan.v2", idempotency_key: "key-a", google_product: "drive", action: "read", direction: "google_to_eliot_candidate", target_ref: "file-a", dry_run: true } as const;
const now = Date.parse("2026-09-09T12:09:00.000Z");

function store(): WorkspaceMcpCandidateStore {
  const plans = new Map<string, unknown>();
  const observations = new Map<string, unknown>();
  return {
    async issuePlan(input) {
      const key = `${input.principal_ref}:${input.deployment_generation}:${input.auth_profile}:${input.idempotency_key}`;
      const old = plans.get(key) as { input_fingerprint: string; plan_sha256: string; plan: unknown; expires_at: string } | undefined;
      if (old !== undefined) {
        if (old.input_fingerprint !== input.input_fingerprint) return { state: "CONFLICT", code: "IDEMPOTENCY_CONFLICT" };
        if (Date.parse(input.issued_at) >= Date.parse(old.expires_at)) return { state: "CONFLICT", code: "PLAN_EXPIRED" };
        return { state: "REPLAY", plan: old.plan };
      }
      plans.set(key, input);
      return { state: "COMMITTED", plan: input.plan };
    },
    async loadPlan(input) {
      const key = `${input.principal_ref}:${input.deployment_generation}:${input.auth_profile}:${input.idempotency_key}`;
      const found = plans.get(key) as { plan: unknown } | undefined;
      return found === undefined ? { state: "NOT_FOUND" } : { state: "FOUND", plan: found.plan };
    },
    async recordObservation(input) {
      const old = observations.get(`${input.plan_id}:${input.receipt_sha256}`);
      return old === undefined
        ? (observations.set(`${input.plan_id}:${input.receipt_sha256}`, input.observation), { state: "COMMITTED", observation: input.observation })
        : { state: "REPLAY", observation: old };
    },
  };
}

function dependencies(candidateStore: WorkspaceMcpCandidateStore, clock = now): GeminiMcpToolDependencies {
  return {
    google_transport: "gemini-mcp",
    now: () => clock,
    mcp_auth_profile: "managed-oauth",
    workspaceCandidateStore: candidateStore,
    async systemStatus() { return {}; },
    async catalog() { return {}; },
  };
}

describe("Workspace MCP durable candidate dispatch", () => {
  it("issues byte-stable plans and replays an exact same key", async () => {
    const ledger = store();
    const first = await createWorkspacePlan(intent, dependencies(ledger), context);
    const replay = await createWorkspacePlan(intent, dependencies(ledger), context);
    expect(first.state).toBe("ISSUED");
    expect(replay.state).toBe("ISSUED");
    expect(replay).toEqual(first);
  });

  it("rejects cloud, deploy, caller authority, and changed same-key payloads", async () => {
    const ledger = store();
    await createWorkspacePlan(intent, dependencies(ledger), context);
    await expect(createWorkspacePlan({ ...intent, action: "update" }, dependencies(ledger), context)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(createWorkspacePlan({ ...intent, google_product: "cloud" }, dependencies(ledger), context)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(createWorkspacePlan({ ...intent, action: "deploy" }, dependencies(ledger), context)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(createWorkspacePlan({ ...intent, principal_ref: "forged" }, dependencies(ledger), context)).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("does not remint an expired idempotency key", async () => {
    const ledger = store();
    await createWorkspacePlan(intent, dependencies(ledger), context);
    await expect(createWorkspacePlan(intent, dependencies(ledger, now + 16 * 60 * 1000), context)).rejects.toMatchObject({ code: "PLAN_EXPIRED" });
  });

  it("persists an actual match and returns UNKNOWN when observation write is uncertain", async () => {
    const ledger = store();
    const issued = await createWorkspacePlan(intent, dependencies(ledger), context);
    if (issued.state !== "ISSUED") throw new Error("expected issued plan");
    const observed = await validateWorkspaceReceipt({ plan: issued, receipt: {
      connector: "google-workspace", google_product: "drive", action: "read", resource_id: "file-a",
      observed_revision: "r1", observed_at: "2026-09-09T12:09:00.000Z", readback_performed: true,
    } }, dependencies(ledger), context);
    expect(observed).toMatchObject({ state: "OBSERVED", disposition: "OBSERVED_MATCH", reconciliation: { write_state: "COMMITTED" } });
    const indeterminate = await validateWorkspaceReceipt({ plan: issued, receipt: {
      connector: "google-workspace", google_product: "drive", action: "read", resource_id: "file-a",
      observed_revision: "r1", observed_at: "2026-09-09T12:09:00.000Z", readback_performed: true, status: "UNKNOWN",
    } }, dependencies(ledger), context);
    expect(indeterminate).toMatchObject({ state: "OBSERVED", disposition: "UNKNOWN", reconciliation: { write_state: "COMMITTED" } });
    expect(indeterminate.receipt_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const uncertain: WorkspaceMcpCandidateStore = { ...ledger, async recordObservation() { return { state: "UNKNOWN" }; } };
    const unknown = await validateWorkspaceReceipt({ plan: issued, receipt: {
      connector: "google-workspace", google_product: "drive", action: "read", resource_id: "file-a",
      observed_revision: "r2", observed_at: "2026-09-09T12:09:00.000Z", readback_performed: true,
    } }, dependencies(uncertain), context);
    expect(unknown).toMatchObject({ state: "UNKNOWN", disposition: "UNKNOWN", reconciliation: { write_state: "UNKNOWN" } });
    expect(unknown.receipt_sha256).toBeUndefined();
  });
});
