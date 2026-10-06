import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AccessVerifier } from "@eliotr/cloudflare-access";
import type { Env } from "../src/env.js";
import { handleHttp } from "../src/http.js";

const runtime = env as unknown as Env & {
  readonly CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  readonly SEARCH_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const ORIGIN = "https://research.example";
const PATH = "/api/v1/system/backup-primary/bootstrap-admissions";
const ACCESS_ISSUER = "https://eliotr-test.cloudflareaccess.com";

function environment(overrides: Partial<Env> = {}): Env {
  return {
    ...runtime,
    ENVIRONMENT: "development",
    DEPLOYMENT_GENERATION: "bootstrap-admission-test-generation",
    VERSION_METADATA: { id: "bootstrap-admission-test-version" } as NonNullable<Env["VERSION_METADATA"]>,
    ...overrides,
  } as Env;
}

function request(options: {
  readonly query?: string;
  readonly origin?: string | null;
  readonly csrf?: string | null;
  readonly site?: string | null;
  readonly body?: string;
} = {}): Request {
  const headers = new Headers();
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.csrf !== null) headers.set("x-eliotr-csrf", options.csrf ?? "1");
  if (options.site !== null && options.site !== undefined) headers.set("sec-fetch-site", options.site);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${ORIGIN}${PATH}${options.query ?? ""}`, {
    method: "POST",
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function accessVerifier(
  principalRef: string,
  options: {
    readonly method?: "cloudflare_access" | "service_token";
    readonly credentialGeneration?: string;
    readonly expiresAt?: string;
  } = {},
): AccessVerifier {
  return {
    async verify() {
      return {
        principal_ref: principalRef,
        credential_generation: options.credentialGeneration ?? "bootstrap-admission-credential",
        authentication_method: options.method ?? "cloudflare_access",
        issuer: ACCESS_ISSUER,
        expires_at: options.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
      };
    },
  };
}

async function call(
  owner: string,
  options: Parameters<typeof request>[0] = {},
  env: Env = environment(),
  authMethod: "cloudflare_access" | "service_token" = "cloudflare_access",
  credentialGeneration = "bootstrap-admission-credential",
  expiresAt = new Date(Date.now() + 3_600_000).toISOString(),
): Promise<{ readonly response: Response; readonly document: Record<string, unknown> }> {
  const response = await handleHttp(
    request(options),
    env,
    {} as ExecutionContext,
    { accessVerifier: accessVerifier(owner, { method: authMethod, credentialGeneration, expiresAt }) },
  );
  return { response, document: await response.json() as Record<string, unknown> };
}

async function admissionCount(): Promise<number> {
  const row = await runtime.CORE_DB.prepare(
    "SELECT COUNT(*) AS count FROM backup_primary_writer_admission",
  ).first<{ readonly count: number }>();
  return row?.count ?? -1;
}

function data(document: Record<string, unknown>): Record<string, unknown> {
  return document.data as Record<string, unknown>;
}

describe("owner primary writer bootstrap admission route", () => {
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
  });

  it("denies non-owner, cross-origin, malformed, and unconfigured requests before a D1 row", async () => {
    const owner = `bootstrap-admission-denied-${crypto.randomUUID()}`;

    const service = await call(owner, {}, environment(), "service_token");
    expect(service.response.status).toBe(403);
    expect(service.document).toMatchObject({ code: "PRINCIPAL_CLASS_DENIED" });

    const noOrigin = await call(owner, { origin: null });
    expect(noOrigin.response.status).toBe(403);
    expect(noOrigin.document).toMatchObject({ code: "BACKUP_PRIMARY_ORIGIN_CSRF_DENIED" });

    const foreignOrigin = await call(owner, { origin: "https://foreign.example" });
    expect(foreignOrigin.response.status).toBe(403);
    expect(foreignOrigin.document).toMatchObject({ code: "BACKUP_PRIMARY_ORIGIN_CSRF_DENIED" });

    const missingCsrf = await call(owner, { csrf: null });
    expect(missingCsrf.response.status).toBe(403);
    expect(missingCsrf.document).toMatchObject({ code: "BACKUP_PRIMARY_ORIGIN_CSRF_DENIED" });

    const crossSite = await call(owner, { site: "cross-site" });
    expect(crossSite.response.status).toBe(403);
    expect(crossSite.document).toMatchObject({ code: "BACKUP_PRIMARY_ORIGIN_CSRF_DENIED" });

    const query = await call(owner, { query: "?unexpected=1" });
    expect(query.response.status).toBe(400);
    expect(query.document).toMatchObject({ code: "UNKNOWN_QUERY_PARAMETER" });

    const body = await call(owner, { body: JSON.stringify({ principal_ref: "caller-forged" }) });
    expect(body.response.status).toBeGreaterThanOrEqual(400);

    const missingBucket = await call(owner, {}, environment({ BACKUP_PARTS_BUCKET: undefined }));
    expect(missingBucket.response.status).toBe(503);

    const missingVersion = await call(owner, {}, environment({ VERSION_METADATA: undefined }));
    expect(missingVersion.response.status).toBe(503);

    expect(await admissionCount()).toBe(0);
  });

  it("persists the verified owner/runtime tuple and replays only the exact token tuple", async () => {
    const owner = `bootstrap-admission-owner-${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const first = await call(owner, {}, environment(), "cloudflare_access", "bootstrap-credential-v1", expiresAt);
    expect(first.response.status, JSON.stringify(first.document)).toBe(200);
    const issued = data(first.document);
    expect(issued).toMatchObject({
      admission: {
        protocol: "eliotr.backup-primary-writer-admission.v1",
        purpose: "BOOTSTRAP",
        principal_ref: owner,
        client_class: "owner_pwa",
        credential_generation: "bootstrap-credential-v1",
        issuer: ACCESS_ISSUER,
        authentication_method: "cloudflare_access",
        access_expires_at: expiresAt,
        deployment_generation: "bootstrap-admission-test-generation",
        version_id: "bootstrap-admission-test-version",
        bucket_binding_ref: "BACKUP_PARTS_BUCKET",
      },
    });
    expect(typeof (issued.admission as Record<string, unknown>).admission_ref).toBe("string");
    expect(issued.admission_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Number.isNaN(Date.parse(String(issued.created_at)))).toBe(false);

    const admission = issued.admission as Record<string, unknown>;
    const stored = await runtime.CORE_DB.prepare(
      "SELECT admission_json,admission_sha256 FROM backup_primary_writer_admission WHERE admission_ref=?1",
    ).bind(admission.admission_ref).first<{ readonly admission_json: string; readonly admission_sha256: string }>();
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored?.admission_json ?? "null")).toEqual(admission);
    expect(stored?.admission_sha256).toBe(issued.admission_sha256);

    const replay = await call(owner, {}, environment(), "cloudflare_access", "bootstrap-credential-v1", expiresAt);
    expect(replay.response.status, JSON.stringify(replay.document)).toBe(200);
    expect(data(replay.document)).toEqual(issued);

    const changedCredential = await call(owner, {}, environment(), "cloudflare_access", "bootstrap-credential-v2", expiresAt);
    expect(changedCredential.response.status).toBe(409);
    expect(changedCredential.document).toMatchObject({ code: "BACKUP_PRIMARY_ADMISSION_CONFLICT" });
    expect(await admissionCount()).toBe(1);
  });
});
