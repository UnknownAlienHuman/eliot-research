import type { ProjectSourceMembership } from "@eliotr/contracts";
import { domainError, type DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export function isMembershipActiveAt(membership: ProjectSourceMembership, instant: string): boolean {
  const at = Date.parse(instant);
  return Date.parse(membership.valid_from) <= at && (membership.valid_to === undefined || at < Date.parse(membership.valid_to));
}

export function closeMembership(
  membership: ProjectSourceMembership,
  validTo: string,
): Result<ProjectSourceMembership, DomainError> {
  if (membership.valid_to !== undefined) return err(domainError("MEMBERSHIP_ALREADY_CLOSED", membership.membership_ref.id));
  if (Date.parse(validTo) <= Date.parse(membership.valid_from)) {
    return err(domainError("INVALID_MEMBERSHIP_INTERVAL", membership.membership_ref.id));
  }
  return ok({ ...membership, valid_to: validTo });
}

export function membershipIdentity(membership: ProjectSourceMembership): string {
  return `${membership.project_id}:${membership.source_id}:${membership.valid_from}`;
}
