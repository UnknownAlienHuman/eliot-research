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

  it("accepts ready output without evidence for SOURCE_AUDIT", () => {
    const bytes = output({
      role: "SOURCE_AUDIT",
      status: "CANDIDATE_READY",
      evidence_handle_refs: [],
    });
    const parsed = parseBranchRoleModelOutput(bytes, "SOURCE_AUDIT", []);
    expect(parsed.status).toBe("CANDIDATE_READY");
    expect(parsed.evidence_handle_refs).toHaveLength(0);
  });

  it("rejects extra fields (strict schema)", () => {
    const bytes = output({ unexpected: "field" });
    expect(() => parseBranchRoleModelOutput(bytes, "SUPPORT", SELECTED))
      .toThrowError(/WORKFLOW_OUTPUT_CORRUPT/);
  });

  it("rejects more than 512 evidence handle refs", () => {
    const many = Array.from({ length: 513 }, (_, index) => ({ id: `handle-${index}`, revision: 1 }));
    const bytes = output({ evidence_handle_refs: many });
    expect(() => parseBranchRoleModelOutput(bytes, "SUPPORT", many))
      .toThrowError(/WORKFLOW_OUTPUT_CORRUPT/);
  });

  it("accepts exactly 512 evidence handle refs", () => {
    const many = Array.from({ length: 512 }, (_, index) => ({ id: `handle-${index}`, revision: 1 }));
    const bytes = output({ evidence_handle_refs: many });
    const parsed = parseBranchRoleModelOutput(bytes, "SUPPORT", many);
    expect(parsed.evidence_handle_refs).toHaveLength(512);
  });

  it("rejects an unknown string longer than 1024 chars", () => {
    const bytes = output({ unknowns: ["x".repeat(1025)] });
    expect(() => parseBranchRoleModelOutput(bytes, "SUPPORT", SELECTED))
      .toThrowError(/WORKFLOW_OUTPUT_CORRUPT/);
  });

  it("rejects more than 64 unknown entries", () => {
    const bytes = output({ unknowns: Array.from({ length: 65 }, () => "x") });
    expect(() => parseBranchRoleModelOutput(bytes, "SUPPORT", SELECTED))
      .toThrowError(/WORKFLOW_OUTPUT_CORRUPT/);
  });

  it("rejects a limitation string longer than 1024 chars", () => {
    const bytes = output({ limitations: ["x".repeat(1025)] });
    expect(() => parseBranchRoleModelOutput(bytes, "SUPPORT", SELECTED))
      .toThrowError(/WORKFLOW_OUTPUT_CORRUPT/);
  });

  it("accepts unknowns at the schema boundary", () => {
    const bytes = output({ unknowns: Array.from({ length: 64 }, () => "x".repeat(1024)) });
    const parsed = parseBranchRoleModelOutput(bytes, "SUPPORT", SELECTED);
    expect(parsed.unknowns).toHaveLength(64);
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
