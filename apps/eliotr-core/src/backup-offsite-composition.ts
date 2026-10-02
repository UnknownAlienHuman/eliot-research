import {
  createS3OffsiteCopyAdapter,
  type BackupDestinationPolicy,
  type OffsiteCopyAdapter,
} from "@eliotr/platform-cloudflare";
import {
  readInstalledBackupR2Profile,
  readInstalledBackupR2Credentials,
  requireInstalledBackupR2Authority,
  type BackupR2Environment,
} from "./backup-offsite-configuration.js";

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
