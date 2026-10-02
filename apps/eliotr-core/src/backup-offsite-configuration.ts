import { z } from "zod";
import type { BackupDestinationPolicy } from "@eliotr/platform-cloudflare";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
const profileSchema = z.strictObject({
  protocol: z.literal("eliotr.backup-offsite-r2-config.v1"),
  provider_kind: z.literal("cloudflare-r2"),
  bucket_versioning: z.literal("disabled"),
  region: z.literal("auto"),
  destination_id: identifier,
  endpoint_identity: identifier,
  authorization_receipt_ref: identifier,
  endpoint: z.string().max(256),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u),
});
export type InstalledBackupR2Profile = z.infer<typeof profileSchema>;
export interface BackupR2Environment {
  readonly ELIOTR_BACKUP_OFFSITE_R2_CONFIG_JSON?: string;
  readonly ELIOTR_BACKUP_OFFSITE_R2_ACCESS_KEY_ID?: string;
  readonly ELIOTR_BACKUP_OFFSITE_R2_SECRET_ACCESS_KEY?: string;
}
export class BackupR2ConfigurationError extends Error {
  public readonly code = "BACKUP_DESTINATION_POLICY_MISMATCH";
  public readonly retryable = false;
  public constructor() {
    super("Installed offsite R2 configuration is absent, malformed, or outside controller authority");
    this.name = "BackupR2ConfigurationError";
  }
}
function fail(): never { throw new BackupR2ConfigurationError(); }

/** This is one transport implementation of the existing OffsiteCopyAdapter port.
 * No environment value creates destination authority or selects an owner policy. */
export function readInstalledBackupR2Profile(env: BackupR2Environment): InstalledBackupR2Profile | null {
  const raw = env.ELIOTR_BACKUP_OFFSITE_R2_CONFIG_JSON;
  if (raw === undefined && env.ELIOTR_BACKUP_OFFSITE_R2_ACCESS_KEY_ID === undefined &&
      env.ELIOTR_BACKUP_OFFSITE_R2_SECRET_ACCESS_KEY === undefined) return null;
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > 16_384) fail();
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { fail(); }
  const result = profileSchema.safeParse(parsed);
  if (!result.success) fail();
  const profile = result.data;
  let endpoint: URL;
  try { endpoint = new URL(profile.endpoint); } catch { fail(); }
  // Direct S3 API only: public/custom-domain caches cannot prove fresh absence.
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" ||
      endpoint.port !== "" || endpoint.search !== "" || endpoint.hash !== "" ||
      endpoint.pathname !== "/" || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/u.test(endpoint.hostname) ||
      (profile.endpoint !== endpoint.origin && profile.endpoint !== endpoint.origin + "/") ||
      profile.bucket.includes("..") || /^[0-9]+(?:\.[0-9]+){3}$/u.test(profile.bucket)) fail();
  return Object.freeze(profile);
}

export function requireInstalledBackupR2Authority(
  profile: InstalledBackupR2Profile,
  policy: BackupDestinationPolicy,
  primaryFailureDomain: string,
): void {
  if (profile.destination_id !== policy.destination_id || profile.endpoint_identity !== policy.endpoint_identity ||
      profile.authorization_receipt_ref !== policy.authorization_receipt_ref ||
      policy.failure_domain === primaryFailureDomain || !policy.supports_deletion_journal ||
      !policy.supports_expiry || policy.retention_locked || policy.legal_hold_ref !== undefined) fail();
}

export function readInstalledBackupR2Credentials(env: BackupR2Environment): {
  readonly access_key_id: string; readonly secret_access_key: string;
} {
  const access = env.ELIOTR_BACKUP_OFFSITE_R2_ACCESS_KEY_ID;
  const secret = env.ELIOTR_BACKUP_OFFSITE_R2_SECRET_ACCESS_KEY;
  if (typeof access !== "string" || typeof secret !== "string" ||
      !/^[A-Za-z0-9]{8,128}$/u.test(access) || !/^[A-Za-z0-9/+=_-]{16,256}$/u.test(secret)) fail();
  return Object.freeze({ access_key_id: access, secret_access_key: secret });
}
