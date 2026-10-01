import { describe, expect, it } from "vitest";
import { parseBranchRoleModelOutput } from "./research-branch-role-output.js";

const SELECTED = [
  { id: "handle-1", revision: 1 },
  { id: "handle-2", revision: 1 },
];

function output(overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    protocol: "eliotr.research.branch-role-output.v1",
    role: "SUPPORT",
    status: "CANDIDATE_READY",
    evidence_handle_refs: [{ id: "handle-1", revision: 1 }],
    unknowns: [],
    limitations: [],
    ...overrides,
  }));
}

describe("parseBranchRoleModelOutput", () => {
  it("parses valid substantive output", () => {
    const parsed = parseBranchRoleModelOutput(output(), "SUPPORT", SELECTED);
    expect(parsed.role).toBe("SUPPORT");
    expect(parsed.status).toBe("CANDIDATE_READY");
    expect(parsed.evidence_handle_refs).toHaveLength(1);
  });

  it("rejects output bound to another role", () => {
    expect(() => parseBranchRoleModelOutput(output({ role: "COUNTER" }), "SUPPORT", SELECTED))
      .toThrowError(/WORKFLOW_OUTPUT_CORRUPT/);
  });

  it("rejects handles outside the role selection (reference firewall)", () => {
    const bytes = output({ evidence_handle_refs: [{ id: "handle-9", revision: 1 }] });
    expect(() => parseBranchRoleModelOutput(bytes, "SUPPORT", SELECTED))
      .toThrowError(/WORKFLOW_OUTPUT_CORRUPT/);
  });

  it("rejects duplicate handles", () => {
    const bytes = output({
      evidence_handle_refs: [{ id: "handle-1", revision: 1 }, { id: "handle-1", revision: 1 }],
    });
    expect(() => parseBranchRoleModelOutput(bytes, "SUPPORT", SELECTED))
      .toThrowError(/WORKFLOW_OUTPUT_CORRUPT/);
  });

  it("rejects ready output without evidence for evidence-bound roles", () => {
    const bytes = output({ status: "CANDIDATE_READY", evidence_handle_refs: [] });
    expect(() => parseBranchRoleModelOutput(bytes, "SUPPORT", SELECTED))
      .toThrowError(/WORKFLOW_OUTPUT_CORRUPT/);
  });

  it("rejects blocked output that cites evidence", () => {
    const bytes = output({ status: "BLOCKED" });
    expect(() => parseBranchRoleModelOutput(bytes, "SUPPORT", SELECTED))
      .toThrowError(/WORKFLOW_OUTPUT_CORRUPT/);
  });

  it("accepts blocked output without evidence", () => {
    const bytes = output({ status: "BLOCKED", evidence_handle_refs: [] });
    const parsed = parseBranchRoleModelOutput(bytes, "SUPPORT", SELECTED);
    expect(parsed.status).toBe("BLOCKED");
  });

  it("rejects non-JSON bytes", () => {
    expect(() => parseBranchRoleModelOutput(new TextEncoder().encode("not json"), "SUPPORT", SELECTED))
      .toThrowError(/WORKFLOW_OUTPUT_CORRUPT/);
  });
});
