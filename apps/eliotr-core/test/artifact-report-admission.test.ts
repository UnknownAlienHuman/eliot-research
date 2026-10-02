import { beforeAll, describe, expect, it } from "vitest";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import { prepareOwnerArtifactReportAdmission } from "../src/artifact-report-admission.js";
import { initializeArtifactDraftRuntime, runtime } from "./artifact-draft-fixture.js";


import { admittedArtifactReportFixture } from "./artifact-report-admission-fixture.js";

async function intents(): Promise<number> {
  const row = await runtime.CORE_DB.prepare("SELECT count(*) AS n FROM operation_intent WHERE intent_id LIKE 'artifact-cow-report-%'").first<{n:number}>();
  if (row === null) throw new Error("intent count is unavailable");
  return row.n;
}

describe("dedicated artifact REPORT admission", () => {
  beforeAll(initializeArtifactDraftRuntime);
  it("persists exact intent/outbox only after installed approval and keeps its full witness immutable", async () => {
    const data = await admittedArtifactReportFixture("report-admission-positive");
    const before = await intents();
    const { ELIOTR_MODEL_SPEND_POLICY_JSON: _spendPolicy, ...withoutSpendPolicy } = data.configuredEnv;
    void _spendPolicy;
    await expect(prepareOwnerArtifactReportAdmission(withoutSpendPolicy, data.context, data.request))
      .rejects.toThrow(/missing/u);
    expect(await intents()).toBe(before);
    const prepared = await prepareOwnerArtifactReportAdmission(data.configuredEnv,data.context,data.request);
    const witness = prepared.admission_witness;
    expect(await canonicalDigest(witness.material)).toBe(witness.input_sha256);
    expect(await canonicalDigest(witness.decision)).toBe(prepared.intent.policy_decision_ref);
    expect(witness.source_bindings).toHaveLength(1);
    expect(prepared.budget.max_total_usd).toBe(0.02);
    data.request.section_id = "changed-after-admission";
    expect(witness.request.section_id).toBe("summary");
    expect(Object.isFrozen(witness.material)).toBe(true);
    expect(await prepared.readback()).toBeNull();
    const receipt = await prepared.commit();
    expect(await prepared.commit()).toEqual(receipt);
    expect(await intents()).toBe(before + 1);
    const row = await runtime.CORE_DB.prepare("SELECT count(*) AS n FROM outbox WHERE intent_id=?1 AND topic='research.artifact-section-revise'")
      .bind(prepared.intent.intent_ref.id).first<{n:number}>();
    expect(row?.n).toBe(1);
  },30_000);
  it("rejects current source revocation before intent/outbox commit", async () => {
    const data = await admittedArtifactReportFixture("report-admission-revoked");
    const before = await intents();
    const prepared = await prepareOwnerArtifactReportAdmission(data.configuredEnv,data.context,data.request);
    await runtime.CORE_DB.prepare("UPDATE scope_read_policy SET state='REVOKED' WHERE source_namespace_id=?1 AND principal_ref=?2")
      .bind("ns-artifact-reader-source-report-admission-revoked",data.context.principal_ref).run();
    await expect(prepared.commit()).rejects.toThrow();
    expect(await intents()).toBe(before);
    expect(await prepared.readback()).toBeNull();
  },30_000);
});
