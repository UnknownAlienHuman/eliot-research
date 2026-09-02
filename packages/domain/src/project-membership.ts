import {
  ProjectSourceMembershipSchema,
  type ProjectSourceMembership,
} from "@eliotr/contracts";
import { domainError, type DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export type ProjectMembershipInvalidReason =
  | "SCHEMA_INVALID"
  | "START_INSTANT_INVALID"
  | "END_INSTANT_INVALID"
  | "END_NOT_AFTER_START"
  | "IDENTITY_CONFLICT"
  | "INTERVAL_OVERLAP"
  | "OBSERVED_AT_INVALID";

interface ParsedMembership {
  readonly membership: ProjectSourceMembership;
  readonly start_ms: number;
  readonly end_ms: number | null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidMembership(
  reason: ProjectMembershipInvalidReason,
  message: string,
): DomainError {
  return domainError("INVALID_MEMBERSHIP_INTERVAL", message, { reason });
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMembership(
  input: ProjectSourceMembership,
): Result<ParsedMembership, DomainError> {
  const parsed = ProjectSourceMembershipSchema.safeParse(input);
  if (!parsed.success) {
    return err(invalidMembership("SCHEMA_INVALID", "project membership failed strict validation"));
  }
  const start = timestamp(parsed.data.valid_from);
  if (start === null) {
    return err(invalidMembership("START_INSTANT_INVALID", "membership start instant is invalid"));
  }
  const end = parsed.data.valid_to === undefined ? null : timestamp(parsed.data.valid_to);
  if (parsed.data.valid_to !== undefined && end === null) {
    return err(invalidMembership("END_INSTANT_INVALID", "membership end instant is invalid"));
  }
  if (end !== null && end <= start) {
    return err(invalidMembership("END_NOT_AFTER_START", "membership interval is empty or reversed"));
  }
  return ok({ membership: parsed.data, start_ms: start, end_ms: end });
}

export function isMembershipActiveAt(
  membership: ProjectSourceMembership,
  instant: string,
): boolean {
  const parsed = parseMembership(membership);
  const observed = timestamp(instant);
  if (!parsed.ok || observed === null) return false;
  return parsed.value.start_ms <= observed &&
    (parsed.value.end_ms === null || observed < parsed.value.end_ms);
}

export function closeMembership(
  membership: ProjectSourceMembership,
  validTo: string,
): Result<ProjectSourceMembership, DomainError> {
  const parsed = parseMembership(membership);
  if (!parsed.ok) return parsed;
  if (parsed.value.membership.valid_to !== undefined) {
    return err(domainError(
      "MEMBERSHIP_ALREADY_CLOSED",
      "project membership is already closed",
    ));
  }
  const end = timestamp(validTo);
  if (end === null) {
    return err(invalidMembership("END_INSTANT_INVALID", "membership close instant is invalid"));
  }
  if (end <= parsed.value.start_ms) {
    return err(invalidMembership("END_NOT_AFTER_START", "membership interval is empty or reversed"));
  }
  const closed = ProjectSourceMembershipSchema.safeParse({
    ...parsed.value.membership,
    valid_to: validTo,
  });
  return closed.success
    ? ok(closed.data)
    : err(invalidMembership("SCHEMA_INVALID", "closed project membership failed strict validation"));
}

/** Collision-free identity matching the D1 `(project_id, source_id, valid_from)` key. */
export function membershipIdentity(membership: ProjectSourceMembership): string {
  return JSON.stringify([
    membership.project_id,
    membership.source_id,
    membership.valid_from,
  ]);
}

function membershipPairIdentity(membership: ProjectSourceMembership): string {
  return JSON.stringify([membership.project_id, membership.source_id]);
}

function compareParsedMembership(left: ParsedMembership, right: ParsedMembership): number {
  return compareText(left.membership.project_id, right.membership.project_id) ||
    compareText(left.membership.source_id, right.membership.source_id) ||
    left.start_ms - right.start_ms ||
    compareText(left.membership.valid_from, right.membership.valid_from) ||
    compareText(left.membership.membership_ref.id, right.membership.membership_ref.id) ||
    left.membership.membership_ref.revision - right.membership.membership_ref.revision;
}

/**
 * Validates one complete temporal membership set.
 *
 * A source may belong to several projects. Within one project/source pair, intervals are half-open,
 * may be adjacent, and must never overlap. The D1 tuple identity is unique even when identifiers contain
 * delimiter characters.
 */
export function validateProjectMembershipTimeline(
  memberships: readonly ProjectSourceMembership[],
): Result<readonly ProjectSourceMembership[], DomainError> {
  const parsed: ParsedMembership[] = [];
  for (const membership of memberships) {
    const result = parseMembership(membership);
    if (!result.ok) return result;
    parsed.push(result.value);
  }
  parsed.sort(compareParsedMembership);

  const identities = new Set<string>();
  const priorByPair = new Map<string, ParsedMembership>();
  for (const current of parsed) {
    const identity = membershipIdentity(current.membership);
    if (identities.has(identity)) {
      return err(invalidMembership(
        "IDENTITY_CONFLICT",
        "project membership tuple identity appears more than once",
      ));
    }
    identities.add(identity);

    const pair = membershipPairIdentity(current.membership);
    const prior = priorByPair.get(pair);
    if (prior !== undefined &&
        (prior.end_ms === null || current.start_ms < prior.end_ms)) {
      return err(invalidMembership(
        "INTERVAL_OVERLAP",
        "project membership intervals overlap",
      ));
    }
    priorByPair.set(pair, current);
  }

  return ok(parsed.map((entry) => entry.membership));
}

export function activeProjectMembershipsAt(
  memberships: readonly ProjectSourceMembership[],
  instant: string,
): Result<readonly ProjectSourceMembership[], DomainError> {
  const observed = timestamp(instant);
  if (observed === null) {
    return err(invalidMembership("OBSERVED_AT_INVALID", "membership observation instant is invalid"));
  }
  const validated = validateProjectMembershipTimeline(memberships);
  if (!validated.ok) return validated;
  return ok(validated.value.filter((membership) => {
    const start = Date.parse(membership.valid_from);
    const end = membership.valid_to === undefined ? null : Date.parse(membership.valid_to);
    return start <= observed && (end === null || observed < end);
  }));
}
