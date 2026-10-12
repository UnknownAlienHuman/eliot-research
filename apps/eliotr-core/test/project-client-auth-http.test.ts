import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reset } from "cloudflare:test";
import { createCloudflareAccessVerifier, type AccessVerifier } from "@eliotr/cloudflare-access";
import type { ProjectClientGrant, ProjectClientGrantPut } from "@eliotr/contracts";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { handleHttp } from "../src/http.js";
import { db, runtime, setupOrientationDatabase } from "./orientation-fixture.js";

const origin = "https://research.example";
const issuer = "https://grant-http-test.cloudflareaccess.com";
const audience = "project-client-grant-http-test";
const owner = "grant-http-owner";
const client = "grant-http-client.access";
const foreignClient = "grant-http-foreign.access";
const environment = { ...runtime, ACCESS_TEAM_DOMAIN: issuer };
let verifier: AccessVerifier;
let keys: CryptoKeyPair;
let now: number;
const encode = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "grant-http-key", alg: "RS256", use: "sig" };
  // Only JWKS transport is controlled. Signature verification and every application/D1 result are real.
  verifier = createCloudflareAccessVerifier({ team_domain: issuer, audience, clock_skew_seconds: 0,
    allowed_service_principal_common_names: [client, foreignClient] }, {
    async fetch(input) {
      expect(String(input)).toBe(`${issuer}/cdn-cgi/access/certs`);
      return Response.json({ keys: [jwk] });
    },
  });
});
beforeEach(async () => { await reset(); await setupOrientationDatabase(); now = Math.floor(Date.now() / 1000); });

async function signed(fields: Record<string, unknown> = {}) {
  const bytes = `${encode({ alg: "RS256", typ: "JWT", kid: "grant-http-key" })}.${encode({
    iss: issuer, aud: [audience], sub: owner, type: "app", iat: now, exp: now + 3600, ...fields,
  })}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey,
    new TextEncoder().encode(bytes)));
  return `${bytes}.${btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}
const serviceToken = (subject = client) => signed({ sub: "", common_name: subject });

async function call(path: string, input: { method?: string; token?: string; body?: unknown;
  headers?: Record<string, string>; environment?: typeof environment } = {}) {
  const headers = new Headers(input.headers);
  if (input.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", input.token);
  if (input.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return handleHttp(new Request(`${origin}${path}`, { method: input.method ?? "GET", headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) }), input.environment ?? environment,
  {} as ExecutionContext, { accessVerifier: verifier });
}
async function data<T>(response: Response, status = 200): Promise<T> {
  const envelope = await response.json() as { data: T };
  expect(response.status, JSON.stringify(envelope)).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return envelope.data;
}
async function project() {
  // Actual signed owner HTTP creates this empty prerequisite; no project/grant receipt is seeded.
  // Nonempty admitted A/B source isolation is a separate S31/S91 requirement.
  const created = await data<{ project_ref: { id: string } }>(await call("/api/v1/research/projects", {
    method: "POST", token: await signed(), body: { title: "HTTP grant project", source_ids: [] },
    headers: { "Idempotency-Key": "http-project-create" },
  }), 201);
  return created.project_ref.id;
}
const pathFor = (id: string) => `/api/v1/research/projects/${encodeURIComponent(id)}/client-grants/grant-http-1`;
const grantInput = (): ProjectClientGrantPut => ({ expected_revision: 0,
  grantee: { issuer, authentication_method: "service_token", subject: client },
  allowed_operations: ["catalog"], ingest_namespace_ids: [], expires_at: new Date((now + 1800) * 1000).toISOString() });
async function put(id: string, input: unknown = grantInput(), key = "http-grant-create", token?: string,
  headers: Record<string, string> = {}) {
  return call(pathFor(id), { method: "PUT", token: token ?? await signed(), body: input,
    headers: { "Idempotency-Key": key, ...headers } });
}
async function state() {
  const tables = ["project", "project_owner", "project_source_membership", "project_mutation_receipt",
    "project_mutation_guard", "project_client_grant", "orientation_authority_epoch", "outbox"] as const;
  return Promise.all(tables.map(async table => {
    const result = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    expect(result.success).toBe(true); return { table, rows: result.results };
  }));
}
async function denied(response: Response, expected: number, code?: string) {
  const envelope = await response.json();
  expect(response.status, JSON.stringify(envelope)).toBe(expected);
  expect(envelope).not.toHaveProperty("data");
  if (code !== undefined) expect(envelope).toHaveProperty("code", code);
}
async function catalog(id: string, token = "", locator = "grant-http-1") {
  return call(`/api/v1/research/catalog?project_id=${encodeURIComponent(id)}`, {
    token, headers: { "X-Eliotr-Client-Grant": locator },
  });
}

async function initializeOwnerReadPolicy() {
  const token = await signed();
  const session = await data<{ principal_ref: string; credential_generation: string; expires_at: string;
    client_class: string }>(await call("/api/v1/system/session", { token }));
  expect(session).toMatchObject({ principal_ref: owner, client_class: "owner_pwa" });
  // Local operator configuration fixture only. Identity/expiry come from the real signed session;
  // the exact policy is the existing namespace-bootstrap.test.ts command fixture. No installed vars change.
  const profile = { profile_ref: { id: "http-grant-bootstrap", revision: 1 }, title: "HTTP grant read policy",
    principal_ref: session.principal_ref, credential_generation: session.credential_generation,
    expires_at: session.expires_at, provenance_ref: "fixture:namespace-bootstrap:policy",
    policy: { allowed_ownership_modes: ["immutable_import"], source_class: "document",
      assurance_ceiling: "QUALIFIED", instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY", allowed_use: ["research"],
      disclosure_ceiling: "owner-only", license_policy_ref: "license-1", default_storage_policy: "NORMALIZED_CLOUD_ONLY",
      default_residency_profile_id: "residency-1", default_retention_policy_id: "retention-1", minimum_quality_state: "standard" },
    owner_read_scope: { allowed_use: ["research"], disclosure_ceiling: "owner-only", expires_at: session.expires_at } };
  const configured = { ...environment, ELIOTR_NAMESPACE_BOOTSTRAP_PROFILES_JSON:
    JSON.stringify({ protocol: "eliotr.namespace-bootstrap-profiles.v1", profiles: [profile] }) };
  const available = await data<{ profiles: Array<{ profile_ref: { id: string; revision: number }; title: string }> }>(
    await call("/api/v1/library/namespaces", { token, environment: configured }));
  expect(available.profiles).toEqual([{ profile_ref: profile.profile_ref, title: profile.title }]);
  const selected = available.profiles[0];
  if (!selected) throw new Error("Configured test owner bootstrap profile missing");
  const initialized = await data<{ source_namespace_id: string }>(await call("/api/v1/library/namespaces", {
    method: "POST", token, environment: configured,
    body: { profile_ref: selected.profile_ref, title: "HTTP grant namespace", idempotency_key: "http-read-policy" },
  }));
  expect(await db.prepare("SELECT principal_ref,client_class,state,expires_at FROM scope_read_policy WHERE source_namespace_id=?1")
    .bind(initialized.source_namespace_id).first()).toEqual({ principal_ref: owner, client_class: "owner_pwa",
      state: "ACTIVE", expires_at: session.expires_at });
}

describe("S91.1 signed project-client HTTP authorization on actual Workers D1", () => {
  it("issues and revokes through signed owner HTTP; replay never revives a revoked service grant", async () => {
    const id = await project(), raw = grantInput();
    const issued = await data<ProjectClientGrant>(await put(id, raw));
    expect(issued).toMatchObject({ grant_id: "grant-http-1", project_id: id, grantor_principal_ref: owner,
      revision: 1, state: "ACTIVE", grantee: raw.grantee, allowed_operations: ["catalog"], ingest_namespace_ids: [] });
    const record = await db.prepare("SELECT record_json,record_sha256 FROM project_client_grant WHERE grant_id=?1 AND revision=1")
      .bind(issued.grant_id).first<{ record_json: string; record_sha256: string }>();
    expect(record).toEqual({ record_json: canonicalJson(issued), record_sha256: await sha256Utf8(canonicalJson(issued)) });
    const settled = await state();
    expect(await data<ProjectClientGrant>(await put(id, raw))).toEqual(issued);
    expect(await state()).toEqual(settled);
    const list = await data<{ grants: ProjectClientGrant[] }>(await call(pathFor(id).replace("/grant-http-1", ""), { token: await signed() }));
    expect(list.grants).toEqual([issued]);
    const service = await serviceToken();
    await denied(await catalog(id, service), 403, "ORIENTATION_READ_POLICY_REQUIRED");
    expect(await state()).toEqual(settled);
    await initializeOwnerReadPolicy();
    const result = await data<{ sources: unknown[] }>(await catalog(id, service));
    expect(result.sources).toEqual([]);
    // Empty explicit scope grants no access to another project or actor.
    await denied(await catalog("foreign-project", service), 403);
    await denied(await catalog(id, await serviceToken(foreignClient)), 403);
    const revoke = () => call(pathFor(id), { method: "DELETE", body: { expected_revision: 1 } });
    const ownerToken = await signed();
    const remove = () => call(pathFor(id), { method: "DELETE", token: ownerToken,
      body: { expected_revision: 1 }, headers: { "Idempotency-Key": "http-grant-revoke" } });
    const revoked = await data<ProjectClientGrant>(await remove());
    expect(revoked).toMatchObject({ revision: 2, state: "REVOKED", created_at: issued.created_at });
    const terminal = await state();
    expect(await data<ProjectClientGrant>(await remove())).toEqual(revoked);
    expect(await data<ProjectClientGrant>(await put(id, raw))).toEqual(issued);
    expect(await state()).toEqual(terminal);
    await denied(await catalog(id, service), 403);
    await denied(await revoke(), 401);
    expect(await state()).toEqual(terminal);
  });

  it("requires verified issuer, audience, signature and owner class before any grant mutation", async () => {
    const id = await project(), baseline = await state(), token = await signed();
    const parts = token.split(".");
    parts[2] = `${parts[2]?.startsWith("A") ? "B" : "A"}${parts[2]?.slice(1)}`;
    for (const invalid of ["forged.token.signature", parts.join("."), await signed({ aud: ["foreign"] }),
      await signed({ iss: "https://foreign-test.cloudflareaccess.com" }), await signed({ iat: now - 120, exp: now - 60 })]) {
      await denied(await put(id, grantInput(), "invalid-token", invalid), 401);
      expect(await state()).toEqual(baseline);
    }
    await denied(await call(pathFor(id), { method: "PUT", body: grantInput(),
      headers: { "Idempotency-Key": "locator-only", "X-Eliotr-Client-Grant": "grant-http-1" } }), 401);
    for (const machine of [await serviceToken(), await serviceToken(foreignClient)]) {
      await denied(await put(id, grantInput(), "machine-self-issue", machine), 403);
      await denied(await call(pathFor(id).replace("/grant-http-1", ""), { token: machine }), 403);
    }
    await denied(await put(id, grantInput(), "foreign-owner", await signed({ sub: "foreign-owner" })), 404, "CLIENT_GRANT_PROJECT_UNAVAILABLE");
    expect(await state()).toEqual(baseline);
  });

  it("rejects CSRF, unsupported transport/query/body fields without partial authority", async () => {
    const id = await project(), baseline = await state();
    const csrfHeaders: Array<Record<string, string>> = [{ Origin: "https://foreign.example" }, { Cookie: "session=fixture" },
      { Origin: origin, "Sec-Fetch-Site": "cross-site" }];
    for (const headers of csrfHeaders) {
      await denied(await put(id, grantInput(), "csrf-denied", undefined, headers), 403);
      expect(await state()).toEqual(baseline);
    }
    await denied(await put(id, grantInput(), "wrong-media", undefined, { "Content-Type": "text/plain" }), 415);
    await denied(await put(id, { ...grantInput(), unexpected: true }, "unknown-body"), 400);
    await denied(await put(id, { ...grantInput(), idempotency_key: "body-key" }, "header-key"), 400);
    await denied(await call(`${pathFor(id)}?unexpected=1`, { method: "PUT", token: await signed(), body: grantInput(),
      headers: { "Idempotency-Key": "unknown-query" } }), 400);
    expect(await state()).toEqual(baseline);
    const issued = await data<ProjectClientGrant>(await put(id, grantInput(), "same-origin", undefined,
      { Origin: origin, Cookie: "session=fixture", "Sec-Fetch-Site": "same-origin" }));
    expect(issued.revision).toBe(1);
  });

  it("rejects excessive namespace/spend/identity/CAS requests entirely through the real grant API", async () => {
    const id = await project(), baseline = await state();
    const invalid: Array<{ input: unknown; status: number }> = [
      { input: { ...grantInput(), allowed_operations: ["unknown"] }, status: 400 },
      { input: { ...grantInput(), grantee: { ...grantInput().grantee, issuer: "https://foreign-test.cloudflareaccess.com" } }, status: 403 },
      { input: { ...grantInput(), allowed_operations: ["ingest.bundle"], ingest_namespace_ids: ["foreign-namespace"] }, status: 403 },
      { input: { ...grantInput(), allowed_operations: ["run"], spend_policy_ref: "uninstalled-spend" }, status: 403 },
      { input: { ...grantInput(), expected_revision: 1 }, status: 409 },
    ];
    for (const [index, candidate] of invalid.entries()) {
      await denied(await put(id, candidate.input, `reject-${index}`), candidate.status);
      expect(await state()).toEqual(baseline);
    }
    const raw = grantInput();
    await data<ProjectClientGrant>(await put(id, raw));
    const settled = await state();
    await denied(await put(id, { ...raw, allowed_operations: ["status"] }), 409);
    await denied(await put(id, raw, "stale-cas"), 409);
    await denied(await put(id, { ...raw, expected_revision: 1,
      grantee: { ...raw.grantee, subject: foreignClient } }, "reassign-actor"), 409);
    expect(await state()).toEqual(settled);
  });
});
