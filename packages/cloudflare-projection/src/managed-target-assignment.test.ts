import { describe, expect, it } from "vitest";
import {
  ManagedTargetAssignmentError,
  parseManagedTargetAssignmentCommand,
} from "./managed-target-assignment.js";

const assignment = {
  event_kind: "ASSIGN",
  project_id: "project-1",
  project_generation: 7,
  project_owner_principal_ref: "owner-principal-1",
  expected_event_revision: 0,
  actor: {
    kind: "OWNER",
    principal_ref: "owner-principal-1",
    authorization_receipt_ref: "owner-assignment-receipt-1",
  },
  created_at: "2026-10-14T12:00:00.000Z",
  target: {
    namespace: "eliotr",
    managed_instance_id: "private-prose-g2",
    managed_generation: "generation-2",
    target_profile_identity_sha256: "a".repeat(64),
  },
} as const;

describe("managed target assignment command", () => {
  it("binds an explicit target to the current owner and project generation", () => {
    const parsed = parseManagedTargetAssignmentCommand(assignment);
    expect(parsed).toMatchObject({
      event_kind: "ASSIGN",
      project_id: "project-1",
      project_generation: 7,
      project_owner_principal_ref: "owner-principal-1",
      expected_event_revision: 0,
      target: {
        namespace: "eliotr",
        managed_instance_id: "private-prose-g2",
        managed_generation: "generation-2",
        target_profile_identity_sha256: "a".repeat(64),
      },
    });
  });

  it("rejects an owner acting for another principal and unknown fields", () => {
    expect(() => parseManagedTargetAssignmentCommand({
      ...assignment,
      actor: { ...assignment.actor, principal_ref: "different-owner" },
    })).toThrow(ManagedTargetAssignmentError);
    expect(() => parseManagedTargetAssignmentCommand({
      ...assignment,
      inferred: true,
    })).toThrow(/unknown field/u);
  });

  it("requires retirement to name the exact assignment revision fenced by CAS", () => {
    const retired = parseManagedTargetAssignmentCommand({
      event_kind: "RETIRE",
      project_id: "project-1",
      project_generation: 8,
      project_owner_principal_ref: "owner-principal-1",
      expected_event_revision: 3,
      previous_assignment_revision: 3,
      actor: assignment.actor,
      created_at: "2026-10-14T12:01:00.000Z",
    });
    expect(retired).toMatchObject({
      event_kind: "RETIRE",
      expected_event_revision: 3,
      previous_assignment_revision: 3,
    });
    expect(() => parseManagedTargetAssignmentCommand({
      event_kind: "RETIRE",
      project_id: "project-1",
      project_generation: 8,
      project_owner_principal_ref: "owner-principal-1",
      expected_event_revision: 3,
      previous_assignment_revision: 2,
      actor: assignment.actor,
      created_at: "2026-10-14T12:01:00.000Z",
    })).toThrow(/event revision fenced by the CAS/u);
  });
});
