import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../infra/d1/core/migrations/0120_backup_primary_writer_admission.sql", import.meta.url), "utf8");
const database = new DatabaseSync(":memory:");
database.exec(`CREATE TABLE backup_primary_writer_qualification (
  qualification_ref TEXT PRIMARY KEY,
  owner_admission_ref TEXT NOT NULL,
  owner_admission_sha256 TEXT NOT NULL,
  controller_generation TEXT NOT NULL,
  version_id TEXT NOT NULL,
  bucket_binding_ref TEXT NOT NULL
) STRICT`);
database.exec(migration);

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function admission(ref, options = {}) {
  const body = {
    protocol: "eliotr.backup-primary-writer-admission.v1",
    admission_ref: ref,
    purpose: "BOOTSTRAP",
    principal_ref: options.principal_ref ?? "owner-subject",
    client_class: "owner_pwa",
    credential_generation: options.credential_generation ?? "cf-access-jwt:kid:1798761600",
    issuer: "https://research.cloudflareaccess.com",
    authentication_method: "cloudflare_access",
    access_expires_at: options.access_expires_at ?? "2099-01-01T00:00:00.000Z",
    deployment_generation: options.deployment_generation ?? "git-bootstrap-test",
    version_id: options.version_id ?? "version-bootstrap-test",
    bucket_binding_ref: "BACKUP_PARTS_BUCKET",
  };
  const json = canonical(body);
  const digest = sha256(json);
  database.prepare(`INSERT INTO backup_primary_writer_admission(
    admission_ref,protocol,purpose,admission_json,admission_sha256,principal_ref,client_class,
    credential_generation,issuer,authentication_method,access_expires_at,deployment_generation,
    version_id,bucket_binding_ref
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ref, body.protocol, body.purpose, json, digest, body.principal_ref, body.client_class,
    body.credential_generation, body.issuer, body.authentication_method, body.access_expires_at,
    body.deployment_generation, body.version_id, body.bucket_binding_ref,
  );
  return { body, digest };
}

function qualification(ref, digest, overrides = {}) {
  database.prepare(`INSERT INTO backup_primary_writer_qualification(
    qualification_ref,owner_admission_ref,owner_admission_sha256,controller_generation,version_id,bucket_binding_ref
  ) VALUES(?,?,?,?,?,?)`).run(
    `qualification-${ref}`, ref, overrides.admission_sha256 ?? digest,
    overrides.controller_generation ?? "git-bootstrap-test",
    overrides.version_id ?? "version-bootstrap-test",
    overrides.bucket_binding_ref ?? "BACKUP_PARTS_BUCKET",
  );
}

const first = admission("11111111-1111-4111-8111-111111111111");
const revoked = admission("22222222-2222-4222-8222-222222222222", { principal_ref: "different-owner", version_id: "version-other" });

assert.throws(() => admission("33333333-3333-4333-8333-333333333333", { access_expires_at: "2000-01-01T00:00:00.000Z" }), /BACKUP_PRIMARY_ADMISSION_UNAVAILABLE/u);
assert.throws(() => admission("not-a-generated-uuid", { principal_ref: "invalid-reference-owner" }), /CHECK constraint failed/u);
assert.throws(() => database.prepare(`INSERT INTO backup_primary_writer_admission(
  admission_ref,protocol,purpose,admission_json,admission_sha256,principal_ref,client_class,
  credential_generation,issuer,authentication_method,access_expires_at,deployment_generation,
  version_id,bucket_binding_ref
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "44444444-4444-4444-8444-444444444444", first.body.protocol, first.body.purpose, canonical({ ...first.body, admission_ref: "44444444-4444-4444-8444-444444444444" }),
  "a".repeat(64), first.body.principal_ref, first.body.client_class, first.body.credential_generation,
  first.body.issuer, first.body.authentication_method, first.body.access_expires_at,
  first.body.deployment_generation, first.body.version_id, first.body.bucket_binding_ref,
), /BACKUP_PRIMARY_ADMISSION_UNAVAILABLE/u);
assert.throws(() => qualification(first.body.admission_ref, first.digest, { admission_sha256: "b".repeat(64) }), /BACKUP_PRIMARY_ADMISSION_NOT_CURRENT_OR_ALREADY_CONSUMED/u);
assert.throws(() => qualification(first.body.admission_ref, first.digest, { controller_generation: "wrong-generation" }), /BACKUP_PRIMARY_ADMISSION_NOT_CURRENT_OR_ALREADY_CONSUMED/u);
assert.throws(() => qualification(first.body.admission_ref, first.digest, { version_id: "wrong-version" }), /BACKUP_PRIMARY_ADMISSION_NOT_CURRENT_OR_ALREADY_CONSUMED/u);
assert.throws(() => qualification(first.body.admission_ref, first.digest, { bucket_binding_ref: "OTHER_BUCKET" }), /BACKUP_PRIMARY_ADMISSION_NOT_CURRENT_OR_ALREADY_CONSUMED/u);

qualification(first.body.admission_ref, first.digest);
assert.throws(() => qualification(first.body.admission_ref, first.digest), /BACKUP_PRIMARY_ADMISSION_NOT_CURRENT_OR_ALREADY_CONSUMED/u);
assert.throws(() => database.prepare("UPDATE backup_primary_writer_admission SET issuer='https://forged.example' WHERE admission_ref=?").run(first.body.admission_ref), /immutable/u);
assert.throws(() => database.prepare("DELETE FROM backup_primary_writer_admission WHERE admission_ref=?").run(first.body.admission_ref), /immutable/u);
assert.throws(() => database.prepare("INSERT INTO backup_primary_writer_admission_revocation(admission_ref,admission_sha256,reason_code) VALUES(?,?,'OWNER_REVOKED')").run(first.body.admission_ref, first.digest), /BACKUP_PRIMARY_ADMISSION_CANNOT_BE_REVOKED/u);

database.prepare("INSERT INTO backup_primary_writer_admission_revocation(admission_ref,admission_sha256,reason_code) VALUES(?,?,'OWNER_REVOKED')")
  .run(revoked.body.admission_ref, revoked.digest);
assert.throws(() => qualification(revoked.body.admission_ref, revoked.digest), /BACKUP_PRIMARY_ADMISSION_NOT_CURRENT_OR_ALREADY_CONSUMED/u);
assert.throws(() => database.prepare("UPDATE backup_primary_writer_admission_revocation SET reason_code='OTHER' WHERE admission_ref=?").run(revoked.body.admission_ref), /immutable/u);
assert.throws(() => database.prepare("DELETE FROM backup_primary_writer_admission_revocation WHERE admission_ref=?").run(revoked.body.admission_ref), /immutable/u);

assert.equal(database.prepare("SELECT COUNT(*) AS count FROM backup_primary_writer_qualification").get().count, 1);
assert.equal(database.prepare("SELECT COUNT(*) AS count FROM backup_primary_writer_admission").get().count, 2);
assert.equal(database.prepare("SELECT COUNT(*) AS count FROM backup_primary_writer_admission_revocation").get().count, 1);
database.close();
console.log("primary writer bootstrap admission migration fixture: PASS (DB clock, immutable grant/revocation, exact one-use runtime pins)");
