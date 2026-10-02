import { describe, expect, it } from "vitest";
import type { BackupDestinationPolicy } from "@eliotr/platform-cloudflare";
import { readInstalledBackupR2Profile, readInstalledBackupR2Credentials, requireInstalledBackupR2Authority } from "./backup-offsite-configuration.js";
const endpoint = "https://" + "a".repeat(32) + ".r2.cloudflarestorage.com";
const profile = { protocol: "eliotr.backup-offsite-r2-config.v1", provider_kind: "cloudflare-r2", bucket_versioning: "disabled", region: "auto", destination_id: "offsite", endpoint_identity: "offsite-endpoint", authorization_receipt_ref: "destination-approved", endpoint, bucket: "offsite-ciphertext" } as const;
const policy: BackupDestinationPolicy = { destination_id: "offsite", endpoint_identity: "offsite-endpoint", authorization_receipt_ref: "destination-approved", failure_domain: "independent-account", supports_deletion_journal: true, supports_expiry: true, retention_locked: false, retention_policy_ref: "retention-v1", expiry_identity: "expiry-v1", policy_version: "1", owner_ref: "owner" };
function read(changes: Record<string, unknown> = {}) {
  return readInstalledBackupR2Profile({ ELIOTR_BACKUP_OFFSITE_R2_CONFIG_JSON: JSON.stringify({ ...profile, ...changes }) });
}
describe("installed backup R2 transport authority", () => {
  it("keeps an unconfigured destination unavailable without creating authority", () => {
    expect(readInstalledBackupR2Profile({})).toBeNull();
    expect(() => readInstalledBackupR2Profile({ ELIOTR_BACKUP_OFFSITE_R2_ACCESS_KEY_ID: "partial-key" })).toThrow();
  });
  it("rejects custom caches, credentials in URLs, versions, unknown fields and oversized configuration", () => {
    for (const changes of [{ endpoint: "https://cache.example.invalid" }, { endpoint: endpoint + "/bucket" }, { endpoint: endpoint + "?token=private" }, { endpoint: "https://user:secret@" + "a".repeat(32) + ".r2.cloudflarestorage.com" }, { bucket_versioning: "enabled" }, { unexpected: true }, { bucket: "a..b" }]) {
      expect(() => read(changes)).toThrow();
    }
    expect(() => readInstalledBackupR2Profile({ ELIOTR_BACKUP_OFFSITE_R2_CONFIG_JSON: " ".repeat(16_385) })).toThrow();
  });
  it("requires exact controller endpoint/receipt and a distinct failure domain", () => {
    const installed = read();
    if (installed === null) throw new Error("fixture profile unavailable");
    expect(() => requireInstalledBackupR2Authority(installed, policy, "primary-account")).not.toThrow();
    for (const changes of [{ destination_id: "other" }, { endpoint_identity: "other" }, { authorization_receipt_ref: "rotated" }, { retention_locked: true }, { legal_hold_ref: "hold" }, { supports_expiry: false }]) {
      expect(() => requireInstalledBackupR2Authority(installed, { ...policy, ...changes }, "primary-account")).toThrow();
    }
    expect(() => requireInstalledBackupR2Authority(installed, policy, policy.failure_domain)).toThrow();
  });
  it("never reflects malformed server credentials", () => {
    const privateValue = "credential with private bytes";
    try { readInstalledBackupR2Credentials({ ELIOTR_BACKUP_OFFSITE_R2_ACCESS_KEY_ID: privateValue }); }
    catch (error) { expect(String(error)).not.toContain(privateValue); }
    expect(readInstalledBackupR2Credentials({ ELIOTR_BACKUP_OFFSITE_R2_ACCESS_KEY_ID: "FIXTUREACCESSKEY001", ELIOTR_BACKUP_OFFSITE_R2_SECRET_ACCESS_KEY: "fixture-secret-key-for-tests" })).toEqual({ access_key_id: "FIXTUREACCESSKEY001", secret_access_key: "fixture-secret-key-for-tests" });
  });
});
