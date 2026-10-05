/// <reference types="node" />
/// <reference types="vite/client" />
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { OperationIntent } from "@eliotr/contracts";
import { backupSha256Hex, canonicalBackupJson } from "@eliotr/backup-o2";
import { computeBackupRestoreIdentity } from "./restore-store.js";
import { makeTestRestoreAdmissionBinding } from "./restore-admission-test-support.js";
import { createD1RestoreAdmissionVerifier, type RestoreAdmissionRequest } from "./restore-admission.js";

const MIGRATION = fileURLToPath(new URL("../../../infra/d1/core/migrations/0115_backup_restore_current_admission.sql", import.meta.url));
const NOW = "2026-10-03T12:00:00.000Z";
const EXPIRES = "2030-10-03T12:00:00.000Z";
const H = (c: string): string => c.repeat(64);

function d1(database: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    const statement = database.prepare(sql);
    const bound = (values: unknown[]) => ({
      async all<T>(): Promise<D1Result<T>> { return { success: true, results: statement.all(...values as never[]) as unknown as T[], meta: {} } as unknown as D1Result<T>; },
      async first<T>(): Promise<T | null> { return (statement.get(...values as never[]) as T | undefined) ?? null; },
      async run<T>(): Promise<D1Result<T>> { statement.run(...values as never[]); return { success: true, results: [], meta: {} } as unknown as D1Result<T>; },
    });
    return { bind(...values: unknown[]) { return bound(values); }, ...bound([]) };
  } } as unknown as D1Database;
}

async function makeRequest(): Promise<RestoreAdmissionRequest> {
  const intent: OperationIntent = {
    intent_ref: { id: "restore-op-current", revision: 4 }, operation_kind: "RESTORE_VERIFY",
    principal_ref: "owner-current", idempotency_key: "restore-current-4", payload_ref: "epoch-current",
    policy_decision_ref: "restore-policy-current", created_at: NOW,
  };
  const target = {
    account_id: "staging-account", failure_domain: "staging-domain", environment_ref: "staging",
    deployment_ref: "restore-deployment-4", configuration_sha256: H("1"),
    resources: { core_database: "staging-core", evidence_bucket: "staging-evidence", work_bucket: "staging-work" },
  };
  const profile = {
    protocol: "eliotr.backup-restore-target-profile.v1", profile_ref: "restore-target-staging",
    revision: 4, ...target, created_at: NOW,
  };
  const target_profile = { profile_ref: profile.profile_ref, revision: profile.revision,
    profile_sha256: await backupSha256Hex(canonicalBackupJson(profile)) };
  const identity = await computeBackupRestoreIdentity({ intent, epoch_id: "epoch-current", offsite_copy_ref: "copy-current", target });
  return {
    protocol: "eliotr.backup-restore-admission-request.v1", permission_ref: "restore-permission-current",
    permission_revision: 2,
    actor: { principal_ref: intent.principal_ref, credential_generation: "access-generation-17", client_class: "owner_pwa",
      authentication_method: "cloudflare_access", issuer: "https://access.example.test", verified_at: NOW, expires_at: EXPIRES },
    intent, restore_id: identity.restore_id, restore_intent_digest: identity.intent_digest,
    epoch_id: "epoch-current", offsite_copy_ref: "copy-current", copy_authority_sha256: H("2"),
    primary: { account_id: "primary-account", failure_domain: "primary-domain",
      resources: { core_database: "primary-core", evidence_bucket: "primary-evidence", work_bucket: "primary-work" } },
    target, target_profile, migration_ledger_digest: H("3"), purge_ledger_revision: 6, purge_ledger_digest: H("4"),
  };
}

async function setup(request: RestoreAdmissionRequest, now = Date.parse(NOW), persist = true,
  operatorIssuerAccountId = request.primary.account_id) {
  const database = new DatabaseSync(":memory:");
  database.exec(await readFile(MIGRATION, "utf8"));
  const binding = await makeTestRestoreAdmissionBinding(database, request, { persist, created_at: NOW, operatorIssuerAccountId });
  return { database, binding, verifier: createD1RestoreAdmissionVerifier(d1(database), () => now) };
}

describe("current restore admission verifier", () => {
  it("binds operator authority to the primary account while permitting a separate target account", async () => {
    const request = await makeRequest();
    const current = await setup(request);
    try {
      const row = current.database.prepare("SELECT permission_json FROM backup_restore_permission").get() as { permission_json: string };
      const permission = JSON.parse(row.permission_json) as { operator_issuer: { account_id: string } };
      expect(request.target.account_id).not.toBe(request.primary.account_id);
      expect(permission.operator_issuer.account_id).toBe(request.primary.account_id);
      await expect(current.verifier.assertCurrentAdmission(request)).resolves.toEqual(current.binding);
    } finally { current.database.close(); }

    const targetIssuer = await setup(request, Date.parse(NOW), true, request.target.account_id);
    try {
      const row = targetIssuer.database.prepare("SELECT permission_json FROM backup_restore_permission").get() as { permission_json: string };
      const permission = JSON.parse(row.permission_json) as { operator_issuer: { account_id: string } };
      expect(permission.operator_issuer.account_id).toBe(request.target.account_id);
      await expect(targetIssuer.verifier.assertCurrentAdmission(request)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
    } finally { targetIssuer.database.close(); }
  });

  it("revalidates the same persisted binding read-only across repeated preflight checks", async () => {
    const request = await makeRequest();
    const h = await setup(request);
    try {
      const before = h.database.prepare("SELECT COUNT(*) AS profiles FROM backup_restore_target_profile").get();
      await expect(h.verifier.assertCurrentAdmission(request)).resolves.toEqual(h.binding);
      await expect(h.verifier.assertCurrentAdmission(request)).resolves.toEqual(h.binding);
      expect(h.database.prepare("SELECT COUNT(*) AS profiles FROM backup_restore_target_profile").get()).toEqual(before);
      expect(h.database.prepare("SELECT COUNT(*) AS permissions FROM backup_restore_permission").get()).toEqual({ permissions: 1 });
    } finally { h.database.close(); }
  });

  it("refuses changes to the authenticated generation, full intent revision, copy, primary, target, or config", async () => {
    const request = await makeRequest();
    const changes: Array<(value: RestoreAdmissionRequest) => RestoreAdmissionRequest> = [
      (value) => ({ ...value, actor: { ...value.actor, principal_ref: "foreign-actor" } }),
      (value) => ({ ...value, actor: { ...value.actor, credential_generation: "access-generation-18" } }),
      (value) => ({ ...value, intent: { ...value.intent, intent_ref: { ...value.intent.intent_ref, revision: 5 } } }),
      (value) => ({ ...value, offsite_copy_ref: "copy-foreign" }),
      (value) => ({ ...value, copy_authority_sha256: H("5") }),
      (value) => ({ ...value, primary: { ...value.primary, resources: { ...value.primary.resources, core_database: "foreign-primary" } } }),
      (value) => ({ ...value, target: { ...value.target, resources: { ...value.target.resources, core_database: "foreign-target" } } }),
      (value) => ({ ...value, target: { ...value.target, configuration_sha256: H("6") } }),
      (value) => ({ ...value, target_profile: { ...value.target_profile, revision: 5 } }),
    ];
    for (const change of changes) {
      const h = await setup(request);
      try {
        await expect(h.verifier.assertCurrentAdmission(change(request))).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
      } finally { h.database.close(); }
    }
  });

  it("refuses absent, revoked, and expired current authority", async () => {
    const request = await makeRequest();
    const absent = await setup(request, Date.parse(NOW), false);
    try {
      await expect(absent.verifier.assertCurrentAdmission(request)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
    } finally { absent.database.close(); }

    const revoked = await setup(request);
    try {
      revoked.database.prepare("INSERT INTO backup_restore_permission_revocation(revocation_ref,permission_ref,permission_revision,revoked_at,reason_sha256,revocation_json,revocation_sha256) VALUES(?,?,?,?,?,?,?)")
        .run("revocation-current", request.permission_ref, request.permission_revision, NOW, H("7"), "{}", H("8"));
      await expect(revoked.verifier.assertCurrentAdmission(request)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
    } finally { revoked.database.close(); }

    const profileRevoked = await setup(request);
    try {
      profileRevoked.database.prepare("INSERT INTO backup_restore_target_profile_revocation(revocation_ref,profile_ref,profile_revision,revoked_at,reason_sha256,revocation_json,revocation_sha256) VALUES(?,?,?,?,?,?,?)")
        .run("profile-revocation-current", request.target_profile.profile_ref, request.target_profile.revision, NOW, H("7"), "{}", H("8"));
      await expect(profileRevoked.verifier.assertCurrentAdmission(request)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
    } finally { profileRevoked.database.close(); }

    const expired = await setup(request, Date.parse(EXPIRES));
    try {
      await expect(expired.verifier.assertCurrentAdmission(request)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
    } finally { expired.database.close(); }
  });
});
