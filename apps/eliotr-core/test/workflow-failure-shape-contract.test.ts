import { describe, expect, it } from "vitest";
import {
  WORKFLOW_FAILURE_CODES,
  WorkflowFailureSchema,
  recordWorkflowFailure,
} from "@eliotr/cloudflare-workflows";
import { WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import { principal, workflowFixture } from "./research-workflow-fixture.js";

describe("persisted workflow failure shape contract", () => {
  it("round-trips every canonical diagnosis through D1 and refuses unknown or malformed JSON", async () => {
    const fixture = await workflowFixture("failure-shape-contract");
    await new WorkflowCheckpointStore(fixture.db).ensureRun(fixture.request, principal);

    const failureFor = (code: (typeof WORKFLOW_FAILURE_CODES)[number]) => ({
      code,
      phase: "STAGE" as const,
      stage: fixture.request.stage,
      retryable: false,
    });
    for (const code of WORKFLOW_FAILURE_CODES) {
      const failure = failureFor(code);
      expect(WorkflowFailureSchema.safeParse(failure).success).toBe(true);
      await recordWorkflowFailure(fixture.db, fixture.request.operation_id, principal, failure);
    }

    const read = () => fixture.db.prepare(`SELECT first_failure_json, latest_failure_json
      FROM research_workflow_run WHERE operation_id = ?1`).bind(fixture.request.operation_id)
      .first<{ first_failure_json: string | null; latest_failure_json: string | null }>();
    const firstCode = WORKFLOW_FAILURE_CODES[0];
    const lastCode = WORKFLOW_FAILURE_CODES[WORKFLOW_FAILURE_CODES.length - 1];
    if (firstCode === undefined || lastCode === undefined) {
      throw new Error("canonical workflow failure code list must not be empty");
    }
    const before = await read();
    expect(JSON.parse(before?.first_failure_json ?? "null")).toEqual(failureFor(firstCode));
    expect(JSON.parse(before?.latest_failure_json ?? "null")).toEqual(
      failureFor(lastCode),
    );

    const unknown = { ...failureFor(firstCode), code: "UNREGISTERED_FAILURE" };
    const malformed = { ...failureFor(firstCode), extra: "not permitted" };
    expect(WorkflowFailureSchema.safeParse(unknown).success).toBe(false);
    expect(WorkflowFailureSchema.safeParse(malformed).success).toBe(false);
    for (const invalid of [unknown, malformed]) {
      await expect(fixture.db.prepare(`UPDATE research_workflow_run SET latest_failure_json = ?1
        WHERE operation_id = ?2`).bind(JSON.stringify(invalid), fixture.request.operation_id).run()).rejects.toThrow();
    }
    expect(await read()).toEqual(before);
  });
});
