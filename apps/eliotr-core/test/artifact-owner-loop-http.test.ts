import { afterEach, describe, expect, it, vi } from "vitest";
import type { VersionedRef } from "@eliotr/contracts";
import { acceptArtifact, readArtifactPublication, reviseArtifactSection } from "../../eliotr-pwa/src/artifact-product-api.js";
import { readReauthorizedResearchArtifact } from "../../eliotr-pwa/src/research-run-api.js";
import { readReauthorizedResearchArtifactSectionCitations } from "../../eliotr-pwa/src/research-run-reauthorization-api.js";
import { handleHttp } from "../src/http.js";
import type { Env } from "../src/env.js";
import { principal } from "./research-evidence-freeze-fixture.js";
import { fixture, runtime, crashBeforeW2Commit, withoutResearchSemanticConfiguration } from "./artifact-cow-http-fixture.js";

const generation = principal.deployment_generation;
function clientTransport(current: () => Env) {
  const keys: string[] = [];
  vi.stubGlobal("fetch", async (path: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(path), "https://research.example"), init);
    const key = request.headers.get("idempotency-key"); if (key !== null) keys.push(key);
    const response = await handleHttp(request, current(), {} as ExecutionContext, { accessVerifier: { verify: async () => ({
      principal_ref: principal.principal_ref, credential_generation: principal.credential_generation,
      authentication_method: "cloudflare_access" as const, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }) } });
    return response;
  });
  return keys;
}
async function head(ref: VersionedRef) {
  return runtime.CORE_DB.prepare("SELECT head_revision FROM artifact_draft_head WHERE artifact_id=?1")
    .bind(ref.id).first<number>("head_revision");
}
async function receipts(ref: VersionedRef) {
  return runtime.CORE_DB.prepare("SELECT COUNT(*) AS n FROM artifact_publication_receipt WHERE artifact_id=?1")
    .bind(ref.id).first<number>("n");
}

function racePublicationDisposition(database: D1Database, ref: VersionedRef) {
  let reads = 0;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, { get(target, property) {
    if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
    if (property === "first" && sql.startsWith("SELECT d.head_revision,h.publication_revision")) return async () => {
      if (++reads === 2) await database.prepare(
        "UPDATE artifact_publication_head SET disposition='PENDING_REVALIDATION' WHERE artifact_id=?1 AND disposition='ACCEPTED'",
      ).bind(ref.id).run();
      return target.first();
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { database: new Proxy(database, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } }), reads: () => reads };
}

describe("PWA clients through owner HTTP, COW and publication on native D1/R2", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("reconciles a crashed child, independently verifies, accepts two sequential children and reopens immutable history", async () => {
    const data = await fixture();
    const crash = crashBeforeW2Commit(runtime.CORE_DB);
    let current = { ...data.configuredEnv, CORE_DB: crash.database };
    const keys = clientTransport(() => current);
    await expect(reviseArtifactSection(data.artifact_ref, "summary", generation)).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(crash.interrupted()).toBe(true); expect(data.modelCalls()).toBe(2);
    const puts = data.counted.puts(); expect(puts).toBeGreaterThan(0);
    // A fresh HTTP/application composition must settle the durable child before preparing a model.
    current = withoutResearchSemanticConfiguration({ ...data.configuredEnv, ELIOTR_MODEL_PROFILE_DEFINITION_JSON: "invalid" });
    const child = await reviseArtifactSection(data.artifact_ref, "summary", generation);
    expect(keys[1]).toBe(keys[0]); expect(child.state).toBe("COMMITTED");
    const childRef = child.draft?.artifact_ref; if (childRef === undefined) throw new Error("First child missing");
    expect(childRef).toEqual({ ...data.artifact_ref, revision: 2 });
    expect(data.modelCalls()).toBe(2); expect(data.counted.puts()).toBe(puts);
    const reopened = await readReauthorizedResearchArtifact(childRef, generation);
    const section = reopened.artifact.sections[0]; if (section === undefined) throw new Error("Child section missing");
    const citations = await readReauthorizedResearchArtifactSectionCitations(childRef, section.section_ref, generation, undefined, section.verification_receipt_ref);
    expect(citations.semantic_verification).toBe("EXECUTED");
    if (citations.semantic_verification === "EXECUTED") {
      expect(citations.audit.claims.every((claim) => claim.disposition === "SUPPORTED")).toBe(true);
      expect(Object.keys(section.statement_labels)).toEqual(citations.audit.claims.map((claim) => claim.claim_ref.id));
      expect(Object.values(section.statement_labels)).toEqual(["SOURCE_SUPPORTED"]);
    }
    expect(await readArtifactPublication(childRef, generation, undefined, true)).toBeNull();
    const accepted = await acceptArtifact(childRef, null, generation);
    expect(accepted.revision.status).toBe("ACCEPTED"); expect(accepted.receipt.publication_revision).toBe(1);
    expect((await acceptArtifact(childRef, null, generation)).receipt).toEqual(accepted.receipt);
    expect(await receipts(childRef)).toBe(1);
    expect((await readArtifactPublication(childRef, generation))?.receipt).toEqual(accepted.receipt);
    await data.originalsUnchanged();

    current = data.configuredEnv;
    const second = await reviseArtifactSection(childRef, "summary", generation);
    const secondRef = second.draft?.artifact_ref; if (secondRef === undefined) throw new Error("Second child missing");
    expect(secondRef).toEqual({ ...data.artifact_ref, revision: 3 }); expect(await head(secondRef)).toBe(3);
    expect(data.modelCalls()).toBe(4);
    const secondPuts = data.counted.puts();
    current = withoutResearchSemanticConfiguration({ ...current, ELIOTR_MODEL_PROFILE_DEFINITION_JSON: "invalid" });
    const laterHead = await reviseArtifactSection(data.artifact_ref, "summary", generation);
    expect(laterHead.draft?.artifact_ref).toEqual(childRef); expect(data.modelCalls()).toBe(4); expect(data.counted.puts()).toBe(secondPuts);
    await expect(readArtifactPublication(childRef, generation, undefined, true)).rejects.toMatchObject({ status: 409 });
    const publicationHead = await readArtifactPublication(secondRef, generation, undefined, true);
    expect(publicationHead?.receipt).toEqual(accepted.receipt);
    await expect(acceptArtifact(secondRef, null, generation)).rejects.toMatchObject({ status: 503, code: "ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN" });
    expect(await receipts(secondRef)).toBe(1);
    const secondAccepted = await acceptArtifact(secondRef, publicationHead?.receipt.publication_revision ?? null, generation);
    expect(secondAccepted.revision.status).toBe("ACCEPTED"); expect(secondAccepted.receipt.publication_revision).toBe(2);
    expect((await readArtifactPublication(childRef, generation))?.revision.status).toBe("SUPERSEDED");
    expect((await readArtifactPublication(secondRef, generation))?.receipt).toEqual(secondAccepted.receipt);
    expect((await readReauthorizedResearchArtifact(secondRef, generation)).artifact.status).toBe("DRAFT");
    expect(await receipts(secondRef)).toBe(2); expect(data.modelCalls()).toBe(4); expect(data.counted.puts()).toBe(secondPuts);
    await data.originalsUnchanged();

    await runtime.CORE_DB.prepare("UPDATE scope_read_policy SET state='REVOKED' WHERE principal_ref=?1 AND state='ACTIVE'").bind(principal.principal_ref).run();
    await expect(readArtifactPublication(secondRef, generation)).rejects.toMatchObject({ status: 404, code: "ARTIFACT_DRAFT_READ_NOT_FOUND" });
    await expect(readReauthorizedResearchArtifact(secondRef, generation)).rejects.toMatchObject({ status: 404, code: "ARTIFACT_DRAFT_READ_NOT_FOUND" });
    await expect(acceptArtifact(secondRef, 1, generation)).rejects.toMatchObject({ status: 404, code: "ARTIFACT_DRAFT_READ_NOT_FOUND" });
    expect(await receipts(secondRef)).toBe(2); expect(data.modelCalls()).toBe(4); expect(data.counted.puts()).toBe(secondPuts);
  }, 180_000);

  it("refuses a purged dependency on accepted read, reopen and replay without another effect", async () => {
    const data = await fixture(); clientTransport(() => data.configuredEnv);
    const child = await reviseArtifactSection(data.artifact_ref, "summary", generation);
    const ref = child.draft?.artifact_ref; if (ref === undefined) throw new Error("Purged child missing");
    await acceptArtifact(ref, null, generation);
    const puts = data.counted.puts(); const calls = data.modelCalls();
    const ledger = data.snapshot.referenced_objects.find((object) => object.object_kind === "EVIDENCE_LEDGER");
    if (ledger === undefined) throw new Error("Original ledger missing");
    const evidence = (JSON.parse(new TextDecoder().decode(ledger.bytes)) as { resolved_evidence: { handle: { source_revision_ref: string } }[] }).resolved_evidence[0];
    if (evidence === undefined) throw new Error("Original evidence missing");
    await runtime.CORE_DB.prepare("UPDATE source_revision SET purge_state='REDACTED' WHERE source_revision_ref=?1").bind(evidence.handle.source_revision_ref).run();
    await expect(readArtifactPublication(ref, generation)).rejects.toMatchObject({ status: 404, code: "ARTIFACT_DRAFT_READ_NOT_FOUND" });
    await expect(readReauthorizedResearchArtifact(ref, generation)).rejects.toMatchObject({ status: 404, code: "ARTIFACT_DRAFT_READ_NOT_FOUND" });
    await expect(acceptArtifact(ref, null, generation)).rejects.toMatchObject({ status: 404, code: "ARTIFACT_DRAFT_READ_NOT_FOUND" });
    await expect(reviseArtifactSection(data.artifact_ref, "summary", generation)).rejects.toMatchObject({ status: 409 });
    expect(await receipts(ref)).toBe(1); expect(data.modelCalls()).toBe(calls); expect(data.counted.puts()).toBe(puts);
    await data.originalsUnchanged();
  }, 120_000);

  it("keeps a supported assumption as HYPOTHESIS and refuses publication through the existing gate", async () => {
    const data = await fixture("assumption"); clientTransport(() => data.configuredEnv);
    const child = await reviseArtifactSection(data.artifact_ref, "summary", generation);
    const ref = child.draft?.artifact_ref; if (ref === undefined) throw new Error("Assumption child missing");
    const reopened = await readReauthorizedResearchArtifact(ref, generation);
    const section = reopened.artifact.sections[0]; if (section === undefined) throw new Error("Assumption section missing");
    const audit = await readReauthorizedResearchArtifactSectionCitations(ref, section.section_ref, generation, undefined, section.verification_receipt_ref);
    expect(audit.semantic_verification).toBe("EXECUTED");
    if (audit.semantic_verification !== "EXECUTED") throw new Error("Assumption audit missing");
    expect(audit.audit.claims.map((claim) => claim.disposition)).toEqual(["SUPPORTED"]);
    expect(Object.keys(section.statement_labels)).toEqual(audit.audit.claims.map((claim) => claim.claim_ref.id));
    expect(Object.values(section.statement_labels)).toEqual(["HYPOTHESIS"]);
    const puts = data.counted.puts();
    await expect(acceptArtifact(ref, null, generation)).rejects.toMatchObject({ status: 409, code: "ARTIFACT_PUBLICATION_NOT_READY" });
    expect(await receipts(ref)).toBe(0); expect(data.modelCalls()).toBe(2); expect(data.counted.puts()).toBe(puts);
    await data.originalsUnchanged();
  }, 120_000);

  it("rejects a publication disposition race with unchanged ref and revisions after ACCEPTED read", async () => {
    const data = await fixture(); let current = data.configuredEnv; clientTransport(() => current);
    const child = await reviseArtifactSection(data.artifact_ref, "summary", generation);
    const ref = child.draft?.artifact_ref; if (ref === undefined) throw new Error("Disposition-race child missing");
    const accepted = await acceptArtifact(ref, null, generation);
    const puts = data.counted.puts();
    const raced = racePublicationDisposition(runtime.CORE_DB, ref); current = { ...current, CORE_DB: raced.database };
    await expect(readArtifactPublication(ref, generation, undefined, true)).rejects.toMatchObject({ status: 409, code: "ARTIFACT_PUBLICATION_STALE" });
    expect(raced.reads()).toBe(2);
    const head = await runtime.CORE_DB.prepare("SELECT publication_ref,publication_revision,draft_revision,disposition FROM artifact_publication_head WHERE artifact_id=?1")
      .bind(ref.id).first();
    expect(head).toEqual({ publication_ref: accepted.receipt.publication_ref, publication_revision: 1,
      draft_revision: ref.revision, disposition: "PENDING_REVALIDATION" });
    current = data.configuredEnv;
    expect((await readArtifactPublication(ref, generation))?.revision.status).toBe("PENDING_REVALIDATION");
    expect(await receipts(ref)).toBe(1); expect(data.modelCalls()).toBe(2); expect(data.counted.puts()).toBe(puts);
    await data.originalsUnchanged();
  }, 120_000);
});
