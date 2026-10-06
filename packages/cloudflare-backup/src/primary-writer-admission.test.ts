import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { canonicalBackupJson } from "@eliotr/backup-o2";
import {
  issuePrimaryWriterBootstrapAdmission,
  issuePrimaryWriterBootstrapAdmissionRoute,
  parsePrimaryWriterBootstrapAdmission,
  validatePrimaryWriterBootstrapRequestSecurity,
  type PrimaryWriterBootstrapAdmissionActor,
} from "./primary-writer-admission.js";

const EXPIRY = "2099-01-01T00:00:00.000Z";
const MIGRATION = new URL("../../../infra/d1/core/migrations/0120_backup_primary_writer_admission.sql", import.meta.url);

interface BoundStatement {
  readonly sql: string;
  readonly values: readonly unknown[];
  bind(...values: unknown[]): BoundStatement;
  all<T>(): Promise<{ readonly success: boolean; readonly results: T[] }>;
  run(): Promise<{ readonly success: boolean; readonly meta: { readonly changes: number } }>;
}

function d1Database(database: DatabaseSync): D1Database {
  const prepared = (sql: string, values: readonly unknown[] = []): BoundStatement => ({
    sql,
    values,
    bind: (...next) => prepared(sql, next),
    async all<T>() {
      const results = database.prepare(sql).all(...values as never[]) as T[];
      return { success: true, results };
    },
    async run() {
      const result = database.prepare(sql).run(...values as never[]);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  return { prepare(sql: string) { return prepared(sql) as unknown as D1PreparedStatement; } } as unknown as D1Database;
}

async function migratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE backup_primary_writer_qualification (
    qualification_ref TEXT PRIMARY KEY, owner_admission_ref TEXT NOT NULL, owner_admission_sha256 TEXT NOT NULL,
    controller_generation TEXT NOT NULL, version_id TEXT NOT NULL, bucket_binding_ref TEXT NOT NULL
  ) STRICT`);
  database.exec(await readFile(MIGRATION, "utf8"));
  return database;
}

function actor(overrides: Partial<PrimaryWriterBootstrapAdmissionActor> = {}): PrimaryWriterBootstrapAdmissionActor {
  const identity = {
    principal_ref: "owner-subject-17",
    client_class: "owner_pwa",
    credential_generation: "cf-access-jwt:kid-test:1798761600",
    access: {
      principal_ref: "owner-subject-17",
      credential_generation: "cf-access-jwt:kid-test:1798761600",
      expires_at: EXPIRY,
      issuer: "https://research.cloudflareaccess.com",
      authentication_method: "cloudflare_access" as const,
    },
  };
  return { ...identity, ...overrides };
}

function issueInput(database: D1Database, overrides: Partial<Parameters<typeof issuePrimaryWriterBootstrapAdmission>[0]> = {}) {
  return {
    database,
    actor: actor(),
    deployment_generation: "git-bootstrap-test",
    version_id: "version-bootstrap-test",
    bucket_binding_ref: "BACKUP_PARTS_BUCKET",
    ...overrides,
  };
}

describe("primary writer bootstrap admission", () => {
  it("persists one canonical server-derived grant and returns the same exact-tuple retry", async () => {
    const database = await migratedDatabase();
    try {
      const d1 = d1Database(database);
      const input = issueInput(d1);
      const issued = await issuePrimaryWriterBootstrapAdmission(input);
      expect(issued.admission).toMatchObject({
        principal_ref: "owner-subject-17",
        client_class: "owner_pwa",
        credential_generation: "cf-access-jwt:kid-test:1798761600",
        issuer: "https://research.cloudflareaccess.com",
        authentication_method: "cloudflare_access",
        access_expires_at: EXPIRY,
        deployment_generation: "git-bootstrap-test",
        version_id: "version-bootstrap-test",
        bucket_binding_ref: "BACKUP_PARTS_BUCKET",
        purpose: "BOOTSTRAP",
      });
      expect(issued.admission_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(issued.admission.admission_ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      expect(database.prepare("SELECT COUNT(*) AS count FROM backup_primary_writer_admission").get()?.count).toBe(1);

      const retry = await issuePrimaryWriterBootstrapAdmission(input);
      expect(retry).toEqual(issued);
      expect(await parsePrimaryWriterBootstrapAdmission({ ...issued.admission, admission_sha256: issued.admission_sha256 }))
        .toEqual(issued.admission);
      await expect(parsePrimaryWriterBootstrapAdmission({
        ...issued.admission, admission_sha256: issued.admission_sha256, extra: "ignored-fields-are-denied",
      })).rejects.toMatchObject({ code: "BACKUP_ROW_INVALID" });
      await expect(parsePrimaryWriterBootstrapAdmission({
        ...issued.admission, version_id: "tampered-version", admission_sha256: issued.admission_sha256,
      })).rejects.toMatchObject({ code: "BACKUP_ROW_INVALID" });
      expect(canonicalBackupJson(issued.admission)).toContain('"purpose":"BOOTSTRAP"');

      const refreshed = actor({ credential_generation: "cf-access-jwt:new-kid:1798761700", access: {
        principal_ref: "owner-subject-17", credential_generation: "cf-access-jwt:new-kid:1798761700",
        expires_at: "2099-01-01T00:05:00.000Z", issuer: "https://research.cloudflareaccess.com", authentication_method: "cloudflare_access",
      } });
      await expect(issuePrimaryWriterBootstrapAdmission({ ...input, actor: refreshed }))
        .rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
      const expiredActor = actor({ credential_generation: "cf-access-jwt:expired:1704067200", access: {
        principal_ref: "owner-subject-17", credential_generation: "cf-access-jwt:expired:1704067200",
        expires_at: "2000-01-01T00:00:00.000Z", issuer: "https://research.cloudflareaccess.com", authentication_method: "cloudflare_access",
      } });
      await expect(issuePrimaryWriterBootstrapAdmission({ ...input, actor: expiredActor, deployment_generation: "git-expired-test" }))
        .rejects.toMatchObject({ code: "BACKUP_INPUT_INVALID" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM backup_primary_writer_admission").get()?.count).toBe(1);
    } finally {
      database.close();
    }
  });

  it("rejects service or mismatched owner context before any D1 access", async () => {
    const noAccess = { prepare() { throw new Error("D1 must not be read for an invalid actor"); } } as unknown as D1Database;
    await expect(issuePrimaryWriterBootstrapAdmission(issueInput(noAccess, {
      actor: actor({ client_class: "trusted_agent" }),
    }))).rejects.toMatchObject({ code: "BACKUP_INPUT_INVALID" });
    await expect(issuePrimaryWriterBootstrapAdmission(issueInput(noAccess, {
      actor: actor({ access: {
        principal_ref: "different-subject", credential_generation: "cf-access-jwt:kid-test:1798761600",
        expires_at: EXPIRY, issuer: "https://research.cloudflareaccess.com", authentication_method: "cloudflare_access",
      } }),
    }))).rejects.toMatchObject({ code: "BACKUP_INPUT_INVALID" });
  });

  it("applies the exact Origin, CSRF and optional Fetch-Site guard", () => {
    const accepted = new Request("https://research.example/api", { method: "POST", headers: {
      Origin: "https://research.example", "x-eliotr-csrf": "1", "Sec-Fetch-Site": "same-origin",
    } });
    expect(validatePrimaryWriterBootstrapRequestSecurity({ request: accepted, url: new URL(accepted.url) })).toBeNull();
    const denied = new Request("https://research.example/api", { method: "POST", headers: {
      Origin: "https://research.example", "x-eliotr-csrf": "1", "Sec-Fetch-Site": "cross-site",
    } });
    expect(validatePrimaryWriterBootstrapRequestSecurity({ request: denied, url: new URL(denied.url) })).toMatchObject({
      code: "BACKUP_PRIMARY_ORIGIN_CSRF_DENIED", status: 403,
    });
    const nonPost = new Request("https://research.example/api", { method: "GET", headers: {
      Origin: "https://research.example", "x-eliotr-csrf": "1", "Sec-Fetch-Site": "same-origin",
    } });
    expect(validatePrimaryWriterBootstrapRequestSecurity({ request: nonPost, url: new URL(nonPost.url) })).toMatchObject({
      code: "BACKUP_PRIMARY_ORIGIN_CSRF_DENIED", status: 403,
    });
    const missingCsrf = new Request("https://research.example/api", { method: "POST", headers: { Origin: "https://research.example" } });
    expect(validatePrimaryWriterBootstrapRequestSecurity({ request: missingCsrf, url: new URL(missingCsrf.url) }))
      .toMatchObject({ status: 403 });
  });

  it("returns controlled runtime, identity and conflict outcomes without exposing storage errors", async () => {
    const request = new Request("https://research.example/api", { method: "POST", headers: {
      Origin: "https://research.example", "x-eliotr-csrf": "1", "Sec-Fetch-Site": "same-origin",
    } });
    const url = new URL(request.url);
    const absentRuntime = await issuePrimaryWriterBootstrapAdmissionRoute({ request, url, actor: actor() });
    expect(absentRuntime).toMatchObject({ ok: false, status: 503, code: "BACKUP_PRIMARY_UNAVAILABLE" });
    const absentActor = await issuePrimaryWriterBootstrapAdmissionRoute({ request, url, database: {} as D1Database, bucket: {} as R2Bucket });
    expect(absentActor).toMatchObject({ ok: false, status: 403, code: "BACKUP_PRIMARY_OWNER_REQUIRED" });
    const storageFailure = await issuePrimaryWriterBootstrapAdmissionRoute({
      request, url, database: { prepare() { throw new Error("private database detail"); } } as unknown as D1Database,
      actor: actor(), deployment_generation: "git-bootstrap-test", version_id: "version-bootstrap-test", bucket: {} as R2Bucket,
    });
    expect(storageFailure).toMatchObject({ ok: false, status: 500, code: "BACKUP_PRIMARY_ADMISSION_UNKNOWN", retryable: true });
    expect(JSON.stringify(storageFailure)).not.toContain("private database detail");
  });
});
