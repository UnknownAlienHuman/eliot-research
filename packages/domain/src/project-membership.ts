import {
  ProjectSourceMembershipSchema,
  type ProjectSourceMembership,
} from "@eliotr/contracts";
import { domainError, type DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isMembershipActiveAt(
  membership: ProjectSourceMembership,
  instant: string,
): boolean {
  const at = timestamp(instant);
  const validFrom = timestamp(membership.valid_from);
  const validTo = membership.valid_to === undefined ? null : timestamp(membership.valid_to);
  return at !== null && validFrom !== null &&
    validFrom <= at &&
    (membership.valid_to === undefined || (validTo !== null && at < validTo));
}

export function closeMembership(
  membership: ProjectSourceMembership,
  validTo: string,
): Result<ProjectSourceMembership, DomainError> {
  const parsed = ProjectSourceMembershipSchema.safeParse(membership);
  if (!parsed.success) {
    return err(domainError("INVALID_MEMBERSHIP", membershipIdentity(membership)));
  }
  if (parsed.data.valid_to !== undefined) {
    return err(domainError("MEMBERSHIP_ALREADY_CLOSED", parsed.data.membership_ref.id));
  }
  const closedAt = timestamp(validTo);
  const openedAt = timestamp(parsed.data.valid_from);
  if (closedAt === null || openedAt === null || closedAt <= openedAt) {
    return err(domainError("INVALID_MEMBERSHIP_INTERVAL", parsed.data.membership_ref.id));
  }
  const closed = ProjectSourceMembershipSchema.safeParse({
    ...parsed.data,
    valid_to: validTo,
  });
  return closed.success
    ? ok(closed.data)
    : err(domainError("INVALID_MEMBERSHIP_INTERVAL", parsed.data.membership_ref.id));
}

export function membershipIdentity(membership: ProjectSourceMembership): string {
  return `${membership.project_id}:${membership.source_id}:${membership.valid_from}`;
}

/**
 * Validates one temporal many-to-many membership history. A source may be active in many projects,
 * but a single project/source pair cannot contain overlapping authority intervals.
 */
export function validateProjectMembershipTimeline(
  memberships: readonly ProjectSourceMembership[],
): Result<readonly ProjectSourceMembership[], DomainError> {
  const parsed: ProjectSourceMembership[] = [];
  for (const membership of memberships) {
    const candidate = ProjectSourceMembershipSchema.safeParse(membership);
    if (!candidate.success) {
      return err(domainError("INVALID_MEMBERSHIP", membershipIdentity(membership)));
    }
    const start = timestamp(candidate.data.valid_from);
    const end = candidate.data.valid_to === undefined ? null : timestamp(candidate.data.valid_to);
    if (start === null || (candidate.data.valid_to !== undefined && (end === null || end <= start))) {
      return err(domainError("INVALID_MEMBERSHIP_INTERVAL", candidate.data.membership_ref.id));
    }
    parsed.push(candidate.data);
  }

  parsed.sort((left, right) =>
    compareText(left.project_id, right.project_id) ||
    compareText(left.source_id, right.source_id) ||
    compareText(left.valid_from, right.valid_from) ||
    compareText(left.membership_ref.id, right.membership_ref.id) ||
    left.membership_ref.revision - right.membership_ref.revision,
  );

  const identities = new Set<string>();
  const priorByPair = new Map<string, ProjectSourceMembership>();
  for (const membership of parsed) {
    const identity = membershipIdentity(membership);
    if (identities.has(identity)) {
      return err(domainError("MEMBERSHIP_IDENTITY_CONFLICT", identity));
    }
    identities.add(identity);

    const pair = `${membership.project_id}\u0000${membership.source_id}`;
    const prior = priorByPair.get(pair);
    if (prior !== undefined) {
      const priorEnd = prior.valid_to === undefined ? null : timestamp(prior.valid_to);
      const nextStart = timestamp(membership.valid_from);
      if (priorEnd === null || nextStart === null || nextStart < priorEnd) {
        return err(domainError("MEMBERSHIP_INTERVAL_OVERLAP", identity));
      }
    }
    priorByPair.set(pair, membership);
  }
  return ok(parsed);
}

export function activeProjectMembershipsAt(
  memberships: readonly ProjectSourceMembership[],
  instant: string,
): Result<readonly ProjectSourceMembership[], DomainError> {
  if (timestamp(instant) === null) {
    return err(domainError("INVALID_MEMBERSHIP_INSTANT", instant));
  }
  const validated = validateProjectMembershipTimeline(memberships);
  if (!validated.ok) return validated;
  return ok(validated.value.filter((membership) => isMembershipActiveAt(membership, instant)));
}
