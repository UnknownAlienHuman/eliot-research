import { describe, expect, it, vi } from "vitest";
import type { BackupDestinationPolicy } from "@eliotr/platform-cloudflare";
import { createInstalledBackupOffsiteR2Resolver } from "./backup-offsite-composition.js";
const endpoint = "https://" + "a".repeat(32) + ".r2.cloudflarestorage.com";
const profile = { protocol: "eliotr.backup-offsite-r2-config.v1", provider_kind: "cloudflare-r2", bucket_versioning: "disabled", region: "auto", destination_id: "offsite", endpoint_identity: "offsite-endpoint", authorization_receipt_ref: "destination-approved", endpoint, bucket: "offsite-ciphertext" } as const;
const policy: BackupDestinationPolicy = { destination_id: "offsite", endpoint_identity: "offsite-endpoint", authorization_receipt_ref: "destination-approved", failure_domain: "independent-account", supports_deletion_journal: true, supports_expiry: true, retention_locked: false, retention_policy_ref: "retention-v1", expiry_identity: "expiry-v1", policy_version: "1", owner_ref: "owner" };
const environment = { ELIOTR_BACKUP_OFFSITE_R2_CONFIG_JSON: JSON.stringify(profile), ELIOTR_BACKUP_OFFSITE_R2_ACCESS_KEY_ID: "FIXTUREACCESSKEY001", ELIOTR_BACKUP_OFFSITE_R2_SECRET_ACCESS_KEY: "fixture-secret-key-for-tests" };
const authority = { destination_id: "offsite", failure_domain: "primary-account", policy };
describe("installed offsite adapter composition", () => {
  it("leaves an unconfigured or unmatched destination unavailable with no requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(createInstalledBackupOffsiteR2Resolver({}, { fetch_impl: fetchImpl })(authority)).resolves.toBeNull();
    await expect(createInstalledBackupOffsiteR2Resolver(environment, { fetch_impl: fetchImpl })({ ...authority, destination_id: "other" })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses rotated endpoint/approval/domain before issuing a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const resolve = createInstalledBackupOffsiteR2Resolver(environment, { fetch_impl: fetchImpl });
    for (const changed of [{ endpoint_identity: "other" }, { authorization_receipt_ref: "rotated" }, { failure_domain: "primary-account" }]) {
      await expect(resolve({ ...authority, policy: { ...policy, ...changed } })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("constructs the real signed bounded adapter from server credentials and controller descriptor", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    const adapter = await createInstalledBackupOffsiteR2Resolver(environment, { fetch_impl: fetchImpl, now: () => new Date("2026-10-01T00:00:00.000Z") })(authority);
    if (adapter === null) throw new Error("fixture adapter unavailable");
    expect((await adapter.describe()).failure_domain).toBe(policy.failure_domain);
    await expect(adapter.get("offsite/epoch/copy/part")).resolves.toBeNull();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(endpoint + "/offsite-ciphertext/offsite/epoch/copy/part");
    expect(new Headers(init?.headers).get("authorization")).toContain("AWS4-HMAC-SHA256");
    expect(init).toMatchObject({ redirect: "manual", cache: "no-store" });
  });
});
