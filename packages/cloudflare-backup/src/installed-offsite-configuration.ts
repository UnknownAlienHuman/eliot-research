import type { BackupDestinationPolicy } from "@eliotr/backup-o2";
import { createS3OffsiteCopyAdapter } from "./backup-offsite-s3.js";
import type { OffsiteCopyAdapter } from "@eliotr/backup-o2";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const CONFIG_KEYS = ["protocol", "provider_kind", "bucket_versioning", "region", "destination_id",
  "endpoint_identity", "authorization_receipt_ref", "endpoint", "bucket"] as const;

export interface InstalledBackupR2Profile {
  readonly protocol: "eliotr.backup-offsite-r2-config.v1";
  readonly provider_kind: "cloudflare-r2";
  readonly bucket_versioning: "disabled";
  readonly region: "auto";
  readonly destination_id: string;
  readonly endpoint_identity: string;
  readonly authorization_receipt_ref: string;
  readonly endpoint: string;
  readonly bucket: string;
}

/** Plain installed values only; Core owns Env and supplies this bounded projection. */
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

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function decodeProfile(value: unknown): InstalledBackupR2Profile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== CONFIG_KEYS.length || CONFIG_KEYS.some((key) => !Object.hasOwn(record, key)) ||
      record.protocol !== "eliotr.backup-offsite-r2-config.v1" || record.provider_kind !== "cloudflare-r2" ||
      record.bucket_versioning !== "disabled" || record.region !== "auto" ||
      !identifier(record.destination_id) || !identifier(record.endpoint_identity) ||
      !identifier(record.authorization_receipt_ref) || typeof record.endpoint !== "string" || record.endpoint.length > 256 ||
      typeof record.bucket !== "string" || !BUCKET.test(record.bucket)) return fail();
  const profile = record as unknown as InstalledBackupR2Profile;
  let endpoint: URL;
  try { endpoint = new URL(profile.endpoint); } catch { return fail(); }
  // Direct S3 API only: public/custom-domain caches cannot prove fresh absence.
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" ||
      endpoint.port !== "" || endpoint.search !== "" || endpoint.hash !== "" || endpoint.pathname !== "/" ||
      !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/u.test(endpoint.hostname) ||
      (profile.endpoint !== endpoint.origin && profile.endpoint !== endpoint.origin + "/") ||
      profile.bucket.includes("..") || /^[0-9]+(?:\.[0-9]+){3}$/u.test(profile.bucket)) return fail();
  return Object.freeze({ ...profile });
}

/** Installed configuration selects transport bytes, not a destination policy or grant. */
export function readInstalledBackupR2Profile(env: BackupR2Environment): InstalledBackupR2Profile | null {
  const raw = env.ELIOTR_BACKUP_OFFSITE_R2_CONFIG_JSON;
  if (raw === undefined && env.ELIOTR_BACKUP_OFFSITE_R2_ACCESS_KEY_ID === undefined &&
      env.ELIOTR_BACKUP_OFFSITE_R2_SECRET_ACCESS_KEY === undefined) return null;
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > 16_384) return fail();
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return fail(); }
  return decodeProfile(parsed);
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
      !/^[A-Za-z0-9]{8,128}$/u.test(access) || !/^[A-Za-z0-9/+=_-]{16,256}$/u.test(secret)) return fail();
  return Object.freeze({ access_key_id: access, secret_access_key: secret });
}

export interface InstalledBackupAdapterAuthority {
  readonly destination_id: string;
  /** Original controller-approved primary failure domain, not the offsite domain. */
  readonly failure_domain: string;
  readonly policy: BackupDestinationPolicy;
}

/** Resolve one optional transport behind the established OffsiteCopyAdapter port.
 * O4 resolves and rechecks the persisted D1 destination grant before calling this.
 * Neither installed config nor adapter self-report grants authority. */
export function createInstalledBackupOffsiteR2Resolver(
  env: BackupR2Environment,
  options: { readonly fetch_impl?: typeof fetch; readonly now?: () => Date } = {},
): (authority: InstalledBackupAdapterAuthority) => Promise<OffsiteCopyAdapter | null> {
  return async (authority) => {
    const profile = readInstalledBackupR2Profile(env);
    if (profile === null || profile.destination_id !== authority.destination_id) return null;
    requireInstalledBackupR2Authority(profile, authority.policy, authority.failure_domain);
    const credentials = readInstalledBackupR2Credentials(env);
    const descriptor = Object.freeze({
      destination_id: authority.policy.destination_id,
      failure_domain: authority.policy.failure_domain,
      supports_deletion_journal: authority.policy.supports_deletion_journal,
      supports_expiry: authority.policy.supports_expiry,
      retention_locked: authority.policy.retention_locked,
      ...(authority.policy.legal_hold_ref === undefined ? {} : { legal_hold_ref: authority.policy.legal_hold_ref }),
    });
    return createS3OffsiteCopyAdapter(Object.freeze({
      ...profile, ...credentials, descriptor,
      ...(options.fetch_impl === undefined ? {} : { fetch_impl: options.fetch_impl }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }));
  };
}
