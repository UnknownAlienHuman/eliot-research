import { afterEach, expect, test, vi } from "vitest";
import { readHistoricalResearchArtifactLocator, readHistoricalResearchCoverage } from "@eliotr/cloudflare-research-stages";
import { originalReport } from "./artifact-cow-http-fixture.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test("Recent verifies exact materialized association without reopening the artifact or certifying coverage", async () => {
  const data = await originalReport("observation", true);
  const scope = { id: data.freeze.scope.snapshot_id, revision: data.freeze.scope.revision };
  let bodyReads = 0, currentChecks = 0;
  const database = new Proxy(data.freeze.db, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      if (!sql.trimStart().startsWith("SELECT")) throw new Error("Locator must not materialize scope or grant state");
      return target.prepare(sql);
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const bucket = new Proxy(data.freeze.bucket, { get(target, key) {
    if (key === "get") return (...args: Parameters<R2Bucket["get"]>) => { bodyReads += 1; return target.get(...args); };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const input = { database, work_bucket: bucket, operation_id: data.freeze.operation_id,
    owner: { principal_ref: data.context.principal_ref, client_class: "owner_pwa" as const },
    artifact_ref: data.artifact_ref, original_scope_snapshot_ref: scope,
    require_current: async () => { currentChecks += 1; } };
  expect(await readHistoricalResearchArtifactLocator(input)).toEqual({ operation_id: data.freeze.operation_id, artifact_ref: data.artifact_ref });
  expect(bodyReads).toBe(1); expect(currentChecks).toBe(2);
  expect(await readHistoricalResearchArtifactLocator({ ...input, owner: { ...input.owner, principal_ref: "foreign-owner" } })).toBeNull();
  await expect(readHistoricalResearchArtifactLocator({ ...input, original_scope_snapshot_ref: { ...scope, id: "foreign-scope" } }))
    .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  await expect(readHistoricalResearchArtifactLocator({ ...input, artifact_ref: { ...data.artifact_ref, revision: data.artifact_ref.revision + 1 } }))
    .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  let checks = 0;
  await expect(readHistoricalResearchArtifactLocator({ ...input, require_current: async () => {
    checks += 1; if (checks === 2) throw new Error("Current read authority was lost");
  } })).rejects.toThrow("Current read authority was lost");
  // The full reader still verifies historical coverage using the admitted fixture's artifact binding.
  const coverage = await readHistoricalResearchCoverage({ database, work_bucket: bucket,
    operation_id: input.operation_id, owner: input.owner, require_current: async () => {},
    require_artifact: async () => ({ artifact_ref: data.artifact_ref, original_scope_snapshot_ref: scope, status: "DRAFT" as const,
      evidence_freeze_ref: data.snapshot.revision.evidence_freeze_ref, dependency_manifest_ref: data.snapshot.revision.dependency_manifest_ref }),
  });
  expect(coverage?.artifact_ref).toEqual(data.artifact_ref);
  expect(coverage?.provenance.operation_id).toBe(input.operation_id);
  expect(data.original_model_calls).toBe(2);
}, 120_000);
