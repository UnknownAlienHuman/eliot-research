import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createCloudflareAccessVerifier, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { SourceNamespaceOwnershipSchema } from "@eliotr/contracts";
import { decodePolicyRow, type AdmissionPolicyRow } from "../../../packages/platform-cloudflare/src/d1-ingest-validation.js";
import { bundleFixture } from "../../../packages/platform-cloudflare/src/ingest-test-fixture.js";
import { initializeLocalNamespace, type NamespaceCommand, type NamespaceReceipt } from "../../../scripts/lib/local-namespace.mjs";
import { importBrowserBundle } from "../../eliotr-pwa/src/bundle-import.js";
import { prepareBrowserBundle } from "../../eliotr-pwa/src/bundle-input.js";
import { type ImportTransport } from "../../eliotr-pwa/src/bundle-import-api.js";
import { decodeApiProblem } from "../../eliotr-pwa/src/api.js";
import { handleHttp } from "../src/http.js";
import { type Env } from "../src/env.js";

interface Migration { name: string; queries: string[]; }
const runtime = env as unknown as Env & { CORE_MIGRATIONS: Migration[]; SEARCH_MIGRATIONS: Migration[] };
const db = runtime.CORE_DB, owner = "bootstrap-owner";
const issuer = "https://bootstrap-test.cloudflareaccess.com", audience = "bootstrap-audience";
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "bootstrap-key", alg: "RS256", use: "sig" };
const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
let token = "";
const verifier = createCloudflareAccessVerifier({ team_domain: issuer, audience, clock_skew_seconds: 0 }, {
  async fetch(url) { expect(String(url)).toBe(`${issuer}/cdn-cgi/access/certs`); return Response.json({ keys: [jwk] }); },
});
const transport: ImportTransport = async (path, init = {}) => {
  const headers = new Headers(init.headers); headers.set("Cf-Access-Jwt-Assertion", token);
  const response = await handleHttp(new Request(`https://research.example${path}`, { ...init, headers }), runtime,
    {} as ExecutionContext, { accessVerifier: verifier });
  const value: unknown = await response.json();
  if (!response.ok) throw decodeApiProblem(value, response.status); return value;
};
const query = async (sql: string) => (await db.prepare(sql).all<Record<string, unknown>>()).results;
function command(): NamespaceCommand {
  return { protocol: "eliotr.local-namespace-init.v1", namespace: `bootstrap-${crypto.randomUUID()}`,
    owner_incarnation_ref: "bootstrap-test-installation", expected_ownership_revision: 0, expected_policy_revision: 0,
    created_at: new Date().toISOString(), policy: { allowed_ownership_modes: ["immutable_import"], source_class: "document",
      assurance_ceiling: "QUALIFIED", instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY", allowed_use: ["research"],
      disclosure_ceiling: "owner-only", license_policy_ref: "license-1", default_storage_policy: "NORMALIZED_CLOUD_ONLY",
      default_residency_profile_id: "residency-1", default_retention_policy_id: "retention-1", minimum_quality_state: "standard" } };
}
async function verifiedIdentity(): Promise<unknown> {
  const envelope = await transport("/api/v1/system/session");
  if (typeof envelope !== "object" || envelope === null || !("data" in envelope)) throw new Error("Missing signed identity");
  return envelope.data;
}
async function bundle(receipt: NamespaceReceipt) {
  const fixture = await bundleFixture(), ownership = receipt.ownership;
  const manifest = { ...fixture.manifest, origin: { ...fixture.manifest.origin, source_namespace_id: ownership.source_namespace_id,
    owner_system_id: ownership.owner_system_id, source_owner_generation: ownership.source_owner_generation,
    source_revision_ref: `revision-${crypto.randomUUID()}` }, source: { ...fixture.manifest.source, logical_id: `source-${crypto.randomUUID()}` } };
  const json = JSON.stringify(manifest), content = fixture.files[manifest.content.markdown];
  if (!content) throw new Error("Missing fixture content");
  return prepareBrowserBundle([
    { path: "content.md", blob: new Blob([new Uint8Array(content)]) }, { path: "manifest.json", blob: new Blob([json]) },
    { path: "hashes.sha256", blob: new Blob([`${manifest.content.markdown_sha256}  content.md\n${await sha256Utf8(json)}  manifest.json\n`]) },
  ]);
}
beforeEach(async () => {
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS); await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
  const now = Math.floor(Date.now() / 1000);
  const data = `${encode({ alg: "RS256", typ: "JWT", kid: "bootstrap-key" })}.${encode({ iss: issuer, aud: [audience], sub: owner,
    type: "app", iat: now, exp: now + 3600 })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(data));
  token = `${data}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
});
describe("explicit local namespace setup against actual Workers D1 and ingest", () => {
  it("produces schema-valid authority, imports through signed HTTP, and does not issue read grants", async () => {
    const input = command(), identity = await verifiedIdentity();
    const receipt = await initializeLocalNamespace({ command: input, identity, query });
    const { created_at: createdAt, cutover_receipt_ref: cutover, ...ownership } = receipt.ownership;
    expect(createdAt).toBe(input.created_at); expect(cutover).toBeNull();
    expect(SourceNamespaceOwnershipSchema.parse(ownership)).toEqual(ownership);
    const policy = await db.prepare("SELECT * FROM source_admission_policy WHERE source_namespace_id=?1 AND revision=1")
      .bind(input.namespace).first<AdmissionPolicyRow>();
    if (!policy) throw new Error("Missing bootstrap policy");
    expect(decodePolicyRow(policy).authorized_principal_refs).toEqual([owner]);
    const prepared = await bundle(receipt);
    const admitted = await importBrowserBundle(prepared, `bootstrap-import-${input.namespace}`, { transport });
    expect(admitted?.decision).toBe("ADMITTED");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM scope_read_policy WHERE source_namespace_id=?1").bind(input.namespace).first("n")).toBe(0);
    expect(await initializeLocalNamespace({ command: input, identity, query })).toEqual(receipt);
    expect(await importBrowserBundle(prepared, `bootstrap-import-${input.namespace}`, { transport })).toEqual(admitted);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM source_revision WHERE source_id=?1").bind(prepared.manifest.source.logical_id).first("n")).toBe(1);
  });
  it("resumes policy-only preparation without treating it as an active owner", async () => {
    const input = command(), identity = await verifiedIdentity();
    await expect(initializeLocalNamespace({ command: input, identity,
      query: (sql) => sql.startsWith("INSERT INTO source_namespace_ownership") ? Promise.reject(new Error("lost process")) : query(sql),
    })).rejects.toThrow("SETTLEMENT_UNCERTAIN");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM source_namespace_ownership WHERE source_namespace_id=?1").bind(input.namespace).first("n")).toBe(0);
    const receipt = await initializeLocalNamespace({ command: input, identity, query });
    expect((await importBrowserBundle(await bundle(receipt), `resumed-${input.namespace}`, { transport }))?.decision).toBe("ADMITTED");
  });
  it("cannot reactivate a retired namespace or admit its old generation", async () => {
    const input = command(), identity = await verifiedIdentity();
    const receipt = await initializeLocalNamespace({ command: input, identity, query });
    await db.prepare("UPDATE source_namespace_ownership SET status='RETIRED' WHERE source_namespace_id=?1").bind(input.namespace).run();
    await expect(initializeLocalNamespace({ command: input, identity, query })).rejects.toThrow("CONFLICT");
    await expect(importBrowserBundle(await bundle(receipt), `retired-${input.namespace}`, { transport })).rejects.toMatchObject({ code: "INGEST_OWNER_NOT_ACTIVE" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM bundle_ingest_operation WHERE source_namespace_id=?1").bind(input.namespace).first("n")).toBe(0);
  });
});
