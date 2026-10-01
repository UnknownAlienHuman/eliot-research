import { describe, expect, it } from "vitest";
import { StageRequestSchema } from "@eliotr/cloudflare-workflows";
import { deriveBranchRoleStageRequest } from "./research-branch-role-model.js";

const REQUEST = StageRequestSchema.parse({
  protocol: "eliotr.workflow-stage.v1",
  operation_id: "op-1",
  investigation_ref: { id: "inv-1", revision: 2 },
  stage: "ANALYZE_BRANCHES",
  idempotency_key: "stage-key",
  handler_generation: "server-owned-branch-v1",
  input_manifest: {
    object_ref: "obj-1",
    sha256: "a".repeat(64),
    byte_length: 10,
    residency: {
      scope_domain_id: "scope-1",
      access_domain_id: "access-1",
      confidentiality_domain_id: "conf-1",
      encryption_key_domain_id: "enc-1",
      retention_domain_id: "ret-1",
      erasure_domain_id: "era-1",
      content_digest: { algorithm: "sha256", digest: "a".repeat(64) },
    },
  },
});

describe("deriveBranchRoleStageRequest", () => {
  it("scopes the idempotency key per role", () => {
    const derived = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    expect(derived.idempotency_key).toBe("stage-key:branch-role:SUPPORT");
    expect(derived.operation_id).toBe(REQUEST.operation_id);
    expect(derived.stage).toBe(REQUEST.stage);
  });

  it("gives every role a distinct key", () => {
    const support = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const counter = deriveBranchRoleStageRequest(REQUEST, "COUNTER");
    expect(support.idempotency_key).not.toBe(counter.idempotency_key);
  });

  it("is deterministic: a restart replays the same key", () => {
    const first = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const second = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    expect(first.idempotency_key).toBe(second.idempotency_key);
  });

  it("rejects unknown roles", () => {
    expect(() => deriveBranchRoleStageRequest(REQUEST, "NOPE" as never))
      .toThrow();
  });
});
