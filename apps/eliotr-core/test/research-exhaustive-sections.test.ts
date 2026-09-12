import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createExhaustiveQueryService } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Q1Namespace, Q1Runtime } from "./retrieval-q1-fixture.js";
import { importAndProject, prepareQ1Namespace } from "./retrieval-q1-fixture.js";

const runtime = env as unknown as Q1Runtime;

const TWO_SECTION_MARKDOWN = [
  "# Alpha section",
  "",
  "The alpha evidence is retained.",
  "",
  "# Beta section",
  "",
  "The beta evidence is retained.",
  "",
].join("\n");

async function world(owner: string): Promise<Q1Namespace> {
  const value: Q1Namespace = {
    db: runtime.CORE_DB,
    searchDb: runtime.SEARCH_DB,
    runtime,
    owner,
    ...(await prepareQ1Namespace(runtime, runtime.CORE_DB, runtime.SEARCH_DB, owner)),
  };
  await importAndProject(value, { content_markdown: TWO_SECTION_MARKDOWN });
  const decision = await runtime.CORE_DB.prepare(
    "SELECT allowed_use_json, disclosure_ceiling FROM source_admission_decision WHERE source_revision_ref=?1 LIMIT 1",
  ).bind(value.revision).first<{ readonly allowed_use_json: string; readonly disclosure_ceiling: string }>();
  if (decision === null) throw new Error("missing source admission decision");
  await runtime.CORE_DB.prepare(
    "INSERT INTO scope_read_policy (source_namespace_id, principal_ref, client_class, policy_ref, generation, allowed_use_json, disclosure_ceiling, state, expires_at, created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)",
  ).bind(
    value.namespace,
    owner,
    `read-${value.namespace}`,
    decision.allowed_use_json,
    decision.disclosure_ceiling,
    new Date(Date.now() + 86_400_000).toISOString(),
    new Date().toISOString(),
  ).run();
  return value;
}

function request(value: Q1Namespace, key: string): Request {
  return new Request("https://research.example/api/v1/research/query", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({
      query: "evidence",
      product: "EXHAUSTIVE_JOB",
      scope_expression: { kind: "SELECTED_SOURCES", source_ids: [`source-${value.namespace}`] },
      literals: [],
      evidence_grade: "E0",
      budget_ref: "exhaustive-job-v1",
      max_results: 8,
    }),
  });
}

function context(input: Request, owner: string, trace: string): AuthenticatedRequestContext {
  return {
    request: input,
    principal_ref: owner,
    client_class: "owner_pwa",
    credential_generation: "credential-1",
    trace_id: trace,
  };
}

interface SourceDigestRow {
  readonly content_sha256: string;
}

interface ProjectionDigestRow {
  readonly item_key: string;
  readonly canonical_section_id: string;
  readonly content_sha256: string;
}

async function readDigests(value: Q1Namespace): Promise<{
  readonly source: SourceDigestRow;
  readonly items: readonly ProjectionDigestRow[];
}> {
  const source = await value.db.prepare(
    "SELECT content_sha256 FROM source_revision WHERE source_revision_ref=?1 LIMIT 1",
  ).bind(value.revision).first<SourceDigestRow>();
  if (source === null) throw new Error("missing source revision digest");
  const result = await value.searchDb.prepare(
    "SELECT item_key, canonical_section_id, content_sha256 FROM projection_item WHERE source_revision_ref=?1 AND active=1 ORDER BY canonical_section_id",
  ).bind(value.revision).all<ProjectionDigestRow>();
  if (!result.success) throw new Error("projection digest read failed");
  return { source, items: result.results };
}

describe("ER-24 exhaustive section digest binding", () => {
  it("completes a real admitted two-section scan with distinct section digests", async () => {
    const owner = "exhaustive-sections-positive-owner";
    const value = await world(owner);
    const digests = await readDigests(value);
    expect(digests.items).toHaveLength(2);
    expect(new Set(digests.items.map((item) => item.canonical_section_id)).size).toBe(2);
    for (const item of digests.items) {
      expect(item.content_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(item.content_sha256).not.toBe(digests.source.content_sha256);
    }

    const input = request(value, "exhaustive-sections-positive");
    const output = await createExhaustiveQueryService(runtime).query(
      context(input, owner, "exhaustive-sections-positive"),
      await input.clone().json(),
    );
    expect(output.job.status).toBe("COMPLETE");
    if (output.job.status !== "COMPLETE") throw new Error("two-section scan did not complete");
    expect(output.job.receipt).toMatchObject({
      coverage_claim: "COMPLETE",
      denominator_shards: 1,
      settled_shards: 1,
      total_scanned_sections: 2,
    });
  }, 20_000);

  it("rejects a tampered section digest before creating an exhaustive job", async () => {
    const owner = "exhaustive-sections-tamper-owner";
    const value = await world(owner);
    const digests = await readDigests(value);
    expect(digests.items).toHaveLength(2);
    const item = digests.items[0];
    if (item === undefined) throw new Error("missing first projected section");
    const tampered = `${item.content_sha256[0] === "0" ? "1" : "0"}${item.content_sha256.slice(1)}`;
    await value.searchDb.prepare(
      "UPDATE projection_item SET content_sha256=?1 WHERE item_key=?2 AND source_revision_ref=?3",
    ).bind(tampered, item.item_key, value.revision).run();

    const input = request(value, "exhaustive-sections-tampered");
    await expect(createExhaustiveQueryService(runtime).query(
      context(input, owner, "exhaustive-sections-tampered"),
      await input.clone().json(),
    )).rejects.toMatchObject({
      code: "RESEARCH_AUTHORITY_STALE",
      status: 409,
      retryable: false,
    });
    const persisted = await value.db.prepare(
      "SELECT COUNT(*) AS count FROM retrieval_exhaustive_job WHERE idempotency_key=?1",
    ).bind("exhaustive-sections-tampered").first<{
      readonly count: number;
    }>();
    expect(persisted?.count).toBe(0);
  }, 20_000);
});
