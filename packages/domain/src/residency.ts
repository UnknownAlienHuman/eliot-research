import type { ObjectResidencyKey } from "@eliotr/contracts";
import { domainError, type DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

const SERIALIZATION_VERSION = "object-residency-key.v1";

export function serializeObjectResidencyKey(key: ObjectResidencyKey): string {
  return [
    SERIALIZATION_VERSION,
    key.scope_domain_id,
    key.access_domain_id,
    key.confidentiality_domain_id,
    key.encryption_key_domain_id,
    key.retention_domain_id,
    key.erasure_domain_id,
    key.content_digest.algorithm,
    key.content_digest.digest,
  ].map(encodeURIComponent).join("/");
}

export function residencyDomainsEqual(left: ObjectResidencyKey, right: ObjectResidencyKey): boolean {
  return left.scope_domain_id === right.scope_domain_id
    && left.access_domain_id === right.access_domain_id
    && left.confidentiality_domain_id === right.confidentiality_domain_id
    && left.encryption_key_domain_id === right.encryption_key_domain_id
    && left.retention_domain_id === right.retention_domain_id
    && left.erasure_domain_id === right.erasure_domain_id;
}

export function validateDeduplication(left: ObjectResidencyKey, right: ObjectResidencyKey): Result<void, DomainError> {
  if (!residencyDomainsEqual(left, right)) {
    return err(domainError("CROSS_DOMAIN_DEDUP_FORBIDDEN", "equal content bytes cannot deduplicate across residency domains"));
  }
  if (left.content_digest.algorithm !== right.content_digest.algorithm || left.content_digest.digest !== right.content_digest.digest) {
    return err(domainError("RESIDENCY_MISMATCH", "deduplication requires identical versioned content digests"));
  }
  return ok(undefined);
}
