import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "@eliotr/cloudflare-access";
import { invalidateEvidenceHandle } from "@eliotr/cloudflare-evidence";
import { handleHttp } from "../src/http.js";
import { runtime } from "./orientation-fixture.js";
import { principal as freezePrincipal } from "./research-evidence-freeze-fixture.js";
import { createArtifactPublicationFixture } from "../../../packages/cloudflare-artifacts/test/artifact-publication-fixture.js";

const ownerVerifier: AccessVerifier = {
  async verify() {
    return {
      principal_ref: freezePrincipal.principal_ref,
      credential_generation: freezePrincipal.credential_generation,
      authentication_method: "cloudflare_access",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
  },
};

function acceptRequest(artifactRef: { readonly id: string; readonly revision: number }, key: string): Request {
  return new Request(`https://research.example/api/v1/research/artifact/${artifactRef.id}:${artifactRef.revision}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({
      protocol: "eliotr.artifact-publication-accept.v1",
      expected_draft_head_revision: artifactRef.revision,
      expected_publication_revision: null,
    }),
  });
}

function publicationRequest(artifactRef: { readonly id: string; readonly revision: number }): Request {
  return new Request(`https://research.example/api/v1/research/artifact/${artifactRef.id}:${artifactRef.revision}/publication`);
}

const call = (
  request: Request,
  database: D1Database = runtime.CORE_DB,
  deploymentGeneration = runtime.DEPLOYMENT_GENERATION,
) => handleHttp(request, { ...runtime, CORE_DB: database, DEPLOYMENT_GENERATION: deploymentGeneration },
  {} as ExecutionContext, { accessVerifier: ownerVerifier });

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function publicationReceiptCount(database: D1Database, artifactId: string): Promise<number> {
  const row = await database.prepare("SELECT COUNT(*) AS count FROM artifact_publication_receipt WHERE artifact_id=?1")
    .bind(artifactId).first<{ readonly count: number }>();
  return row?.count ?? 0;
}

describe("owner artifact publication HTTP composition with real D1/R2 and V2 evidence", () => {
  it("accepts through the authenticated route, replays, and reads the persisted publication", async () => {
    const { fixture, prepared } = await createArtifactPublicationFixture();
    const key = `owner-http-${crypto.randomUUID()}`;
    const first = await call(acceptRequest(prepared.artifactRef, key), runtime.CORE_DB, prepared.access.deployment_generation);
    const firstBody = await json(first);
    expect(first.status, JSON.stringify(firstBody)).toBe(201);
    expect(firstBody.data).toMatchObject({ disposition: "CREATED", revision: { status: "ACCEPTED" } });
    expect(await publicationReceiptCount(fixture.db, prepared.artifactRef.id)).toBe(1);

    const replay = await call(acceptRequest(prepared.artifactRef, key), runtime.CORE_DB, prepared.access.deployment_generation);
    const replayBody = await json(replay);
    expect(replay.status, JSON.stringify(replayBody)).toBe(200);
    expect(replayBody.data).toMatchObject({ disposition: "EXISTING", revision: { status: "ACCEPTED" } });
    expect((replayBody.data as { receipt: { publication_ref: string } }).receipt.publication_ref)
      .toBe((firstBody.data as { receipt: { publication_ref: string } }).receipt.publication_ref);

    const read = await call(publicationRequest(prepared.artifactRef), runtime.CORE_DB, prepared.access.deployment_generation);
    const readBody = await json(read);
    expect(read.status, JSON.stringify(readBody)).toBe(200);
    expect(readBody.data).toMatchObject({ revision: { status: "ACCEPTED" } });
    expect((readBody.data as { receipt: { publication_ref: string } }).receipt.publication_ref)
      .toBe((firstBody.data as { receipt: { publication_ref: string } }).receipt.publication_ref);
    expect(await publicationReceiptCount(fixture.db, prepared.artifactRef.id)).toBe(1);

    await invalidateEvidenceHandle(fixture.db, prepared.evidence.handle, "REDACTED", "owner-http-purge", new Date().toISOString());
    const purgedRead = await call(publicationRequest(prepared.artifactRef), runtime.CORE_DB, prepared.access.deployment_generation);
    const purgedReadBody = await json(purgedRead);
    expect([409, 410], JSON.stringify(purgedReadBody)).toContain(purgedRead.status);
    expect(String(purgedReadBody.code)).toMatch(/(?:STALE|REDACTED|PURGE|AUTHORITY)/u);
    expect(await publicationReceiptCount(fixture.db, prepared.artifactRef.id)).toBe(1);

    const draft = await fixture.db.prepare("SELECT status FROM artifact_revision WHERE artifact_id=?1 AND revision=?2")
      .bind(prepared.artifactRef.id, prepared.artifactRef.revision).first<{ readonly status: string }>();
    expect(draft?.status).toBe("DRAFT");
  }, 120_000);

  it("rejects a corrupted V2 verification receipt before writing publication state", async () => {
    const { fixture, prepared } = await createArtifactPublicationFixture();
    const verification = await fixture.db.prepare(
      "SELECT receipt_json FROM artifact_draft_object WHERE artifact_id=?1 AND revision=?2 AND object_kind='VERIFICATION_RECEIPT' LIMIT 1",
    ).bind(prepared.artifactRef.id, prepared.artifactRef.revision).first<{ readonly receipt_json: string }>();
    if (verification === null) throw new Error("V2 fixture did not persist a verification receipt");
    const receipt = JSON.parse(verification.receipt_json) as { readonly key: string };
    await fixture.bucket.put(receipt.key, new TextEncoder().encode("not a V2 verification receipt"));

    const response = await call(acceptRequest(prepared.artifactRef, `invalid-v2-${crypto.randomUUID()}`),
      runtime.CORE_DB, prepared.access.deployment_generation);
    const responseBody = await json(response);
    expect([409, 410, 503], JSON.stringify(responseBody)).toContain(response.status);
    expect(String(responseBody.code)).toMatch(/^(?:ARTIFACT_DRAFT_READ_(?:INTEGRITY|UNAVAILABLE)|ARTIFACT_PUBLICATION_(?:INTEGRITY|NOT_READY|STALE|EFFECT_UNCERTAIN))$/u);
    expect(await publicationReceiptCount(fixture.db, prepared.artifactRef.id)).toBe(0);
  }, 60_000);
});
