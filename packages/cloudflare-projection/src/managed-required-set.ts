import {
  canonicalProjectionJson,
  projectionSha256Utf8,
} from "./canonical.js";
import type { ManagedTargetIdentity } from "./managed-target-assignment.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PAGE_SIZE = 256;
const MAX_PAGES = 400;
const MAX_PROJECT_REVISION_COPIES = PAGE_SIZE * MAX_PAGES;

export interface ManagedRequiredSetCursor {
  readonly project_id: string;
  readonly source_id: string;
  readonly membership_generation: number;
  readonly source_revision_ref: string;
}

/** One source-revision copy contributed by one current membership in one assigned project. */
export interface ManagedRequiredProjectRevisionCopy {
  readonly assignment_revision: number;
  readonly project_id: string;
  readonly project_generation: number;
  readonly project_owner_principal_ref: string;
  /** AI Search target namespace, not the source namespace below. */
  readonly namespace: string;
  readonly managed_instance_id: string;
  readonly managed_generation: string;
  readonly target_profile_identity_sha256: string;
  readonly project_membership_id: string;
  readonly source_id: string;
  readonly source_revision_ref: string;
  readonly source_head_revision_ref: string;
  readonly source_namespace_id: string;
  readonly source_owner_system_id: string;
  readonly source_ownership_mode: string;
  readonly source_owner_generation: string;
  readonly source_ownership_record_revision: number;
  readonly source_owner_status: "ACTIVE";
  readonly source_admission_policy_revision: number;
  readonly source_admission_policy_source_class: string;
  readonly source_admission_decision_source_class: string;
  readonly source_class: string;
  readonly source_revision_content_sha256: string;
  readonly normalized_artifact_ref: string | null;
  readonly purge_state: "LIVE";
  readonly admission_decision: "ADMITTED";
  readonly admission_decision_receipt_ref: string;
  readonly admission_decision_sha256: string;
  readonly admission_decision_expires_at: string | null;
  readonly admission_disclosure_ceiling: string;
  readonly project_owner_read_policy_ref: string;
  readonly project_owner_read_policy_generation: number;
  readonly project_owner_read_policy_state: "ACTIVE";
  readonly project_owner_read_policy_disclosure_ceiling: string;
  readonly project_owner_read_policy_expires_at: string;
  readonly membership_generation: number;
  readonly membership_valid_from: string;
  readonly membership_valid_to: string | null;
}

export interface ManagedRequiredSetFence {
  /** Core orientation_authority_epoch generation, extended by migration 0141 assignment appends. */
  readonly authority_revision: number;
  /** Derived from current ASSIGN events for this exact target, never from profile configuration. */
  readonly assigned_project_count: number;
  readonly stale_assignment_count: number;
  readonly profile_mismatch_count: number;
}

export interface ManagedRequiredSetPage {
  readonly authority_revision: number;
  readonly rows: readonly ManagedRequiredProjectRevisionCopy[];
  /** Cursor for the last returned row when more rows may exist; null ends the scan. */
  readonly next_cursor: ManagedRequiredSetCursor | null;
}

export interface ManagedRequiredSetPort {
  /** Must verify current owner/project generation and exact immutable target profile identity. */
  readFence(
    target: ManagedTargetIdentity,
    as_of: string,
  ): Promise<ManagedRequiredSetFence>;
  /**
   * Pages only rows admitted by the existing currentSourcePredicate: current head,
   * LIVE purge state, active owner generation, matching source admission policy,
   * latest unexpired ADMITTED decision, and active owner read policy. It must not
   * join projection jobs/effects or a caller ScopeSnapshot to decide membership.
   */
  readPage(input: {
    readonly target: ManagedTargetIdentity;
    readonly as_of: string;
    readonly expected_authority_revision: number;
    readonly after: ManagedRequiredSetCursor | null;
    readonly limit: number;
  }): Promise<ManagedRequiredSetPage>;
}

export interface ManagedRequiredSetReceipt {
  readonly protocol: "eliotr.managed-required-project-revisions.v1";
  readonly target: ManagedTargetIdentity;
  readonly as_of: string;
  readonly authority_revision_before: number;
  readonly authority_revision_after: number;
  readonly assigned_project_count: number;
  readonly project_revision_copy_count: number;
  /** Digest of the ordered project/revision copies; it is not an item or section count. */
  readonly required_set_digest: string;
}

export class ManagedRequiredSetError extends Error {
  public constructor(
    public readonly code:
      | "MANAGED_REQUIRED_SET_INPUT_INVALID"
      | "MANAGED_REQUIRED_SET_ASSIGNMENT_MISSING"
      | "MANAGED_REQUIRED_SET_ASSIGNMENT_STALE"
      | "MANAGED_REQUIRED_SET_PROFILE_MISMATCH"
      | "MANAGED_REQUIRED_SET_PAGE_INVALID"
      | "MANAGED_REQUIRED_SET_MEMBERSHIP_AMBIGUOUS"
      | "MANAGED_REQUIRED_SET_BOUNDS_EXCEEDED"
      | "MANAGED_REQUIRED_SET_FENCE_CHANGED"
      | "MANAGED_REQUIRED_SET_AUTHORITY_UNAVAILABLE"
      | "MANAGED_REQUIRED_SET_READ_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "ManagedRequiredSetError";
  }
}

function fail(
  code: ManagedRequiredSetError["code"],
  message: string,
): never {
  throw new ManagedRequiredSetError(code, message);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("MANAGED_REQUIRED_SET_INPUT_INVALID", `${label} is invalid`);
  }
}

function assertInteger(
  value: unknown,
  label: string,
  minimum: number,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    fail("MANAGED_REQUIRED_SET_INPUT_INVALID", `${label} is invalid`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("MANAGED_REQUIRED_SET_INPUT_INVALID", `${label} is invalid`);
  }
}

function validateTarget(target: ManagedTargetIdentity): void {
  assertIdentifier(target.namespace, "target namespace");
  assertIdentifier(target.managed_instance_id, "managed instance id");
  assertIdentifier(target.managed_generation, "managed generation");
  if (
    typeof target.target_profile_identity_sha256 !== "string" ||
    !SHA256.test(target.target_profile_identity_sha256)
  ) {
    fail("MANAGED_REQUIRED_SET_INPUT_INVALID", "target profile identity digest is invalid");
  }
}

function validateFence(
  fence: ManagedRequiredSetFence,
  target: ManagedTargetIdentity,
): void {
  assertInteger(fence.authority_revision, "authority revision", 0);
  assertInteger(fence.assigned_project_count, "assigned project count", 0);
  assertInteger(fence.stale_assignment_count, "stale assignment count", 0);
  assertInteger(fence.profile_mismatch_count, "profile mismatch count", 0);
  if (fence.stale_assignment_count !== 0) {
    fail("MANAGED_REQUIRED_SET_ASSIGNMENT_STALE", "a target assignment no longer matches its project authority");
  }
  if (fence.profile_mismatch_count !== 0) {
    fail("MANAGED_REQUIRED_SET_PROFILE_MISMATCH", "a target assignment names a different immutable profile");
  }
  if (fence.assigned_project_count === 0) {
    fail("MANAGED_REQUIRED_SET_ASSIGNMENT_MISSING", "the target has no current explicit project assignment");
  }
  void target;
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCopy(
  left: ManagedRequiredProjectRevisionCopy,
  right: ManagedRequiredProjectRevisionCopy,
): number {
  return compareString(left.project_id, right.project_id) ||
    compareString(left.source_id, right.source_id) ||
    left.membership_generation - right.membership_generation ||
    compareString(left.source_revision_ref, right.source_revision_ref);
}

function cursorFor(copy: ManagedRequiredProjectRevisionCopy): ManagedRequiredSetCursor {
  return Object.freeze({
    project_id: copy.project_id,
    source_id: copy.source_id,
    membership_generation: copy.membership_generation,
    source_revision_ref: copy.source_revision_ref,
  });
}

function compareCursor(
  left: ManagedRequiredSetCursor,
  right: ManagedRequiredSetCursor,
): number {
  return compareString(left.project_id, right.project_id) ||
    compareString(left.source_id, right.source_id) ||
    left.membership_generation - right.membership_generation ||
    compareString(left.source_revision_ref, right.source_revision_ref);
}

function validateCopy(
  copy: ManagedRequiredProjectRevisionCopy,
  target: ManagedTargetIdentity,
  asOf: string,
): void {
  for (const [value, label] of [
    [copy.project_id, "project id"],
    [copy.project_owner_principal_ref, "project owner principal"],
    [copy.source_id, "source id"],
    [copy.source_revision_ref, "source revision ref"],
    [copy.source_head_revision_ref, "source head revision ref"],
    [copy.source_namespace_id, "source namespace"],
    [copy.source_owner_system_id, "source owner system id"],
    [copy.source_ownership_mode, "source ownership mode"],
    [copy.source_owner_generation, "source owner generation"],
    [copy.source_admission_policy_source_class, "admission policy source class"],
    [copy.source_admission_decision_source_class, "admission decision source class"],
    [copy.source_class, "source class"],
    [copy.admission_decision_receipt_ref, "admission decision receipt"],
    [copy.admission_disclosure_ceiling, "admission disclosure ceiling"],
    [copy.project_owner_read_policy_ref, "owner read policy ref"],
    [copy.project_owner_read_policy_disclosure_ceiling, "owner read disclosure ceiling"],
  ] as const) assertIdentifier(value, label);

  assertInteger(copy.assignment_revision, "assignment revision", 1);
  assertInteger(copy.project_generation, "project generation", 1);
  assertInteger(copy.source_ownership_record_revision, "ownership record revision", 1);
  assertInteger(copy.source_admission_policy_revision, "admission policy revision", 1);
  assertInteger(copy.project_owner_read_policy_generation, "owner read policy generation", 1);
  assertInteger(copy.membership_generation, "membership generation", 1);
  for (const [value, label] of [
    [copy.namespace, "copy namespace"],
    [copy.managed_instance_id, "copy managed instance id"],
    [copy.managed_generation, "copy managed generation"],
  ] as const) assertIdentifier(value, label);
  if (
    copy.namespace !== target.namespace ||
    copy.managed_instance_id !== target.managed_instance_id ||
    copy.managed_generation !== target.managed_generation ||
    copy.target_profile_identity_sha256 !== target.target_profile_identity_sha256 ||
    copy.source_head_revision_ref !== copy.source_revision_ref ||
    copy.source_owner_status !== "ACTIVE" ||
    copy.purge_state !== "LIVE" ||
    copy.admission_decision !== "ADMITTED" ||
    copy.source_admission_decision_source_class !== copy.source_admission_policy_source_class ||
    copy.admission_disclosure_ceiling !== copy.project_owner_read_policy_disclosure_ceiling ||
    copy.project_owner_read_policy_state !== "ACTIVE"
  ) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "page contains a row outside canonical target eligibility");
  }
  if (!SHA256.test(copy.source_revision_content_sha256) || !SHA256.test(copy.admission_decision_sha256)) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "page contains an invalid authority digest");
  }
  if (copy.normalized_artifact_ref !== null) {
    assertIdentifier(copy.normalized_artifact_ref, "normalized artifact ref");
  }
  assertTimestamp(copy.membership_valid_from, "membership valid_from");
  assertTimestamp(asOf, "as_of");
  if (copy.admission_decision_expires_at !== null) {
    assertTimestamp(copy.admission_decision_expires_at, "admission decision expiry");
    if (Date.parse(copy.admission_decision_expires_at) <= Date.parse(asOf)) {
      fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "admission decision has expired");
    }
  }
  assertTimestamp(copy.project_owner_read_policy_expires_at, "owner read policy expiry");
  if (Date.parse(copy.project_owner_read_policy_expires_at) <= Date.parse(asOf)) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "owner read policy has expired");
  }
  if (copy.membership_valid_to !== null) {
    assertTimestamp(copy.membership_valid_to, "membership valid_to");
  }
  const from = Date.parse(copy.membership_valid_from);
  const at = Date.parse(asOf);
  const to = copy.membership_valid_to === null ? Number.POSITIVE_INFINITY : Date.parse(copy.membership_valid_to);
  if (!(from <= at && at < to)) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "membership is outside its half-open validity interval");
  }
  const expectedMembershipId = `project:${copy.project_id}:generation:${copy.membership_generation}`;
  if (copy.project_membership_id !== expectedMembershipId) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "project membership identity differs from the canonical format");
  }
}

export interface EnumerateManagedRequiredSetInput {
  readonly target: ManagedTargetIdentity;
  readonly as_of: string;
  /** Stage each row in a bounded, unpublished manifest; do not call providers or publish during enumeration. */
  readonly on_copy: (copy: ManagedRequiredProjectRevisionCopy) => void | Promise<void>;
}

/**
 * Streams the target's canonical project/revision copies and returns a digest
 * only after a stable pre/post Core authority fence. It never expands sections
 * into item keys and never reads jobs, effects, ScopeSnapshots, or configured counts.
 */
export async function enumerateManagedRequiredSet(
  port: ManagedRequiredSetPort,
  input: EnumerateManagedRequiredSetInput,
): Promise<ManagedRequiredSetReceipt> {
  validateTarget(input.target);
  assertTimestamp(input.as_of, "as_of");
  const before = await port.readFence(input.target, input.as_of);
  validateFence(before, input.target);

  let digest = await projectionSha256Utf8(canonicalProjectionJson({
    protocol: "eliotr.managed-required-project-revisions.v1",
    target: input.target,
    as_of: input.as_of,
    authority_revision: before.authority_revision,
    assigned_project_count: before.assigned_project_count,
  }));
  let count = 0;
  let pages = 0;
  let after: ManagedRequiredSetCursor | null = null;
  let previous: ManagedRequiredProjectRevisionCopy | null = null;

  while (true) {
    if (pages >= MAX_PAGES) {
      fail("MANAGED_REQUIRED_SET_BOUNDS_EXCEEDED", "required-set page bound was exceeded");
    }
    const page = await port.readPage({
      target: input.target,
      as_of: input.as_of,
      expected_authority_revision: before.authority_revision,
      after,
      limit: PAGE_SIZE,
    });
    pages += 1;
    if (
      page.authority_revision !== before.authority_revision ||
      !Array.isArray(page.rows) ||
      page.rows.length > PAGE_SIZE
    ) {
      fail("MANAGED_REQUIRED_SET_FENCE_CHANGED", "required-set page did not match its pre-scan authority fence");
    }

    for (const copy of page.rows) {
      validateCopy(copy, input.target, input.as_of);
      if (previous !== null) {
        const order = compareCopy(previous, copy);
        if (previous.project_id === copy.project_id && previous.source_id === copy.source_id) {
          fail("MANAGED_REQUIRED_SET_MEMBERSHIP_AMBIGUOUS", "more than one current membership exists for a project/source pair");
        }
        if (order >= 0) {
          fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set pages are not in strict canonical order");
        }
      }
      if (count >= MAX_PROJECT_REVISION_COPIES) {
        fail("MANAGED_REQUIRED_SET_BOUNDS_EXCEEDED", "required-set cumulative row bound was exceeded");
      }
      digest = await projectionSha256Utf8(`${digest}\n${canonicalProjectionJson(copy)}`);
      count += 1;
      previous = copy;
      await input.on_copy(copy);
    }

    if (page.next_cursor === null) break;
    if (page.rows.length === 0 || previous === null || compareCursor(page.next_cursor, cursorFor(previous)) !== 0) {
      fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set cursor does not identify the last returned row");
    }
    after = page.next_cursor;
  }

  const afterFence = await port.readFence(input.target, input.as_of);
  validateFence(afterFence, input.target);
  if (
    before.authority_revision !== afterFence.authority_revision ||
    before.assigned_project_count !== afterFence.assigned_project_count ||
    before.stale_assignment_count !== afterFence.stale_assignment_count ||
    before.profile_mismatch_count !== afterFence.profile_mismatch_count
  ) {
    fail("MANAGED_REQUIRED_SET_FENCE_CHANGED", "Core authority changed during required-set enumeration");
  }

  return Object.freeze({
    protocol: "eliotr.managed-required-project-revisions.v1",
    target: input.target,
    as_of: input.as_of,
    authority_revision_before: before.authority_revision,
    authority_revision_after: afterFence.authority_revision,
    assigned_project_count: before.assigned_project_count,
    project_revision_copy_count: count,
    required_set_digest: digest,
  });
}

const CURRENT_TARGET_ASSIGNMENTS_SQL =
  "WITH latest AS (SELECT project_id,MAX(event_revision) AS event_revision " +
  "FROM managed_target_assignment_event GROUP BY project_id), assignments AS (" +
  "SELECT e.* FROM managed_target_assignment_event e JOIN latest l " +
  "ON l.project_id=e.project_id AND l.event_revision=e.event_revision " +
  "WHERE e.event_kind='ASSIGN' AND e.target_namespace=?1 " +
  "AND e.managed_instance_id=?2 AND e.managed_generation=?3) ";

/** Production Core D1 adapter for the typed required-set port. */
export function createD1ManagedRequiredSetPort(
  coreDatabase: D1Database,
): ManagedRequiredSetPort {
  return Object.freeze({
    async readFence(target: ManagedTargetIdentity, _asOf: string): Promise<ManagedRequiredSetFence> {
      try {
        const row = await coreDatabase.prepare(
          CURRENT_TARGET_ASSIGNMENTS_SQL +
          "SELECT (SELECT generation FROM orientation_authority_epoch WHERE singleton=1) AS authority_revision," +
          "COUNT(a.project_id) AS assigned_project_count," +
          "COALESCE(SUM(CASE WHEN p.project_id IS NULL OR p.generation<>a.project_generation " +
          "OR o.principal_ref<>a.project_owner_principal_ref THEN 1 ELSE 0 END),0) AS stale_assignment_count," +
          "COALESCE(SUM(CASE WHEN a.target_profile_identity_sha256<>?4 THEN 1 ELSE 0 END),0) AS profile_mismatch_count " +
          "FROM assignments a LEFT JOIN project p ON p.project_id=a.project_id " +
          "LEFT JOIN project_owner o ON o.project_id=a.project_id",
        ).bind(
          target.namespace,
          target.managed_instance_id,
          target.managed_generation,
          target.target_profile_identity_sha256,
        ).first<ManagedRequiredSetFence>();
        if (row === null) {
          fail("MANAGED_REQUIRED_SET_AUTHORITY_UNAVAILABLE", "Core returned no required-set authority fence");
        }
        return Object.freeze(row);
      } catch (cause) {
        if (cause instanceof ManagedRequiredSetError) throw cause;
        fail("MANAGED_REQUIRED_SET_AUTHORITY_UNAVAILABLE", "Core required-set authority fence is unavailable");
      }
    },

    async readPage(input: Parameters<ManagedRequiredSetPort["readPage"]>[0]): Promise<ManagedRequiredSetPage> {
      if (input.limit !== PAGE_SIZE) {
        fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set D1 page size must use the fixed bound");
      }
      let authority: { readonly generation: number } | null;
      try {
        authority = await coreDatabase.prepare(
          "SELECT generation FROM orientation_authority_epoch WHERE singleton=1",
        ).bind().first<{ readonly generation: number }>();
      } catch {
        fail("MANAGED_REQUIRED_SET_AUTHORITY_UNAVAILABLE", "Core required-set page fence is unavailable");
      }
      if (authority === null) {
        fail("MANAGED_REQUIRED_SET_AUTHORITY_UNAVAILABLE", "Core returned no required-set page fence");
      }
      if (authority.generation !== input.expected_authority_revision) {
        return Object.freeze({ authority_revision: authority.generation, rows: [], next_cursor: null });
      }

      const after = input.after;
      let result: D1Result<ManagedRequiredProjectRevisionCopy>;
      try {
        result = await coreDatabase.prepare(
          CURRENT_TARGET_ASSIGNMENTS_SQL +
          "SELECT a.event_revision AS assignment_revision,p.project_id,p.generation AS project_generation," +
          "a.project_owner_principal_ref,a.target_namespace AS namespace,a.managed_instance_id," +
          "a.managed_generation,a.target_profile_identity_sha256," +
          "'project:'||p.project_id||':generation:'||m.membership_generation AS project_membership_id," +
          "s.source_id,sr.source_revision_ref,s.head_rev AS source_head_revision_ref," +
          "s.source_namespace_id,s.source_owner_system_id,s.ownership_mode AS source_ownership_mode," +
          "sr.source_owner_generation,own.ownership_record_revision AS source_ownership_record_revision," +
          "own.status AS source_owner_status,ap.revision AS source_admission_policy_revision," +
          "ap.source_class AS source_admission_policy_source_class," +
          "d.source_class AS source_admission_decision_source_class,s.source_class," +
          "sr.content_sha256 AS source_revision_content_sha256,sr.normalized_artifact_ref,sr.purge_state," +
          "d.decision AS admission_decision,d.decision_receipt_ref AS admission_decision_receipt_ref," +
          "d.decision_sha256 AS admission_decision_sha256,d.expires_at AS admission_decision_expires_at," +
          "d.disclosure_ceiling AS admission_disclosure_ceiling," +
          "rp.policy_ref AS project_owner_read_policy_ref,rp.generation AS project_owner_read_policy_generation," +
          "rp.state AS project_owner_read_policy_state," +
          "rp.disclosure_ceiling AS project_owner_read_policy_disclosure_ceiling," +
          "rp.expires_at AS project_owner_read_policy_expires_at," +
          "m.membership_generation,m.valid_from AS membership_valid_from,m.valid_to AS membership_valid_to " +
          "FROM assignments a " +
          "JOIN project p ON p.project_id=a.project_id AND p.generation=a.project_generation " +
          "JOIN project_owner po ON po.project_id=p.project_id " +
          "AND po.principal_ref=a.project_owner_principal_ref " +
          "JOIN project_source_membership m ON m.project_id=p.project_id " +
          "AND m.membership_generation=p.generation AND m.valid_from<=?5 " +
          "AND (m.valid_to IS NULL OR ?6<m.valid_to) " +
          "JOIN source s ON s.source_id=m.source_id " +
          "JOIN source_revision sr ON sr.source_revision_ref=s.head_rev AND sr.source_id=s.source_id " +
          "AND sr.source_owner_generation=s.source_owner_generation AND sr.purge_state='LIVE' " +
          "JOIN source_namespace_ownership own ON own.source_namespace_id=s.source_namespace_id " +
          "AND own.status='ACTIVE' AND own.owner_system_id=s.source_owner_system_id " +
          "AND own.source_owner_generation=s.source_owner_generation " +
          "AND sr.source_owner_generation=own.source_owner_generation " +
          "JOIN source_admission_policy ap ON ap.source_namespace_id=own.source_namespace_id " +
          "AND ap.revision=own.source_admission_policy_revision " +
          "JOIN source_admission_decision d ON d.source_revision_ref=sr.source_revision_ref " +
          "AND d.decision='ADMITTED' AND d.owner_system_id=own.owner_system_id " +
          "AND d.source_namespace_id=s.source_namespace_id " +
          "AND d.source_owner_generation=s.source_owner_generation " +
          "AND d.source_class=ap.source_class " +
          "AND (d.expires_at IS NULL OR julianday(d.expires_at)>julianday(?5)) " +
          "AND d.decision_receipt_ref=(SELECT chosen.decision_receipt_ref " +
          "FROM source_admission_decision chosen WHERE chosen.source_revision_ref=sr.source_revision_ref " +
          "AND chosen.decision='ADMITTED' " +
          "ORDER BY chosen.created_at DESC,chosen.decision_receipt_ref DESC LIMIT 1) " +
          "JOIN scope_read_policy rp ON rp.source_namespace_id=s.source_namespace_id " +
          "AND rp.principal_ref=a.project_owner_principal_ref AND rp.client_class='owner_pwa' " +
          "AND rp.state='ACTIVE' AND julianday(rp.expires_at)>julianday(?5) " +
          "WHERE a.target_profile_identity_sha256=?4 " +
          "AND json_type(ap.allowed_use_json)='array' " +
          "AND json_type(ap.allowed_ownership_modes_json)='array' " +
          "AND EXISTS (SELECT 1 FROM json_each(ap.allowed_use_json) WHERE value='research') " +
          "AND EXISTS (SELECT 1 FROM json_each(ap.allowed_ownership_modes_json) WHERE value=s.ownership_mode) " +
          "AND json_type(d.allowed_use_json)='array' AND json_type(rp.allowed_use_json)='array' " +
          "AND EXISTS (SELECT 1 FROM json_each(d.allowed_use_json) WHERE value='research') " +
          "AND d.disclosure_ceiling=rp.disclosure_ceiling " +
          "AND NOT EXISTS (SELECT 1 FROM json_each(d.allowed_use_json) used WHERE NOT EXISTS " +
          "(SELECT 1 FROM json_each(rp.allowed_use_json) permitted WHERE permitted.value=used.value)) " +
          "AND (?7 IS NULL OR p.project_id>?7 OR (p.project_id=?8 AND (s.source_id>?9 OR " +
          "(s.source_id=?10 AND (m.membership_generation>?11 OR " +
          "(m.membership_generation=?12 AND sr.source_revision_ref>?13)))))) " +
          "ORDER BY p.project_id,s.source_id,m.membership_generation,sr.source_revision_ref LIMIT ?14",
        ).bind(
          input.target.namespace,
          input.target.managed_instance_id,
          input.target.managed_generation,
          input.target.target_profile_identity_sha256,
          input.as_of,
          input.as_of,
          after?.project_id ?? null,
          after?.project_id ?? null,
          after?.source_id ?? null,
          after?.source_id ?? null,
          after?.membership_generation ?? null,
          after?.membership_generation ?? null,
          after?.source_revision_ref ?? null,
          input.limit,
        ).all<ManagedRequiredProjectRevisionCopy>();
      } catch (cause) {
        if (cause instanceof ManagedRequiredSetError) throw cause;
        fail("MANAGED_REQUIRED_SET_AUTHORITY_UNAVAILABLE", "Core required-set page is unavailable");
      }
      if (!result.success) {
        fail("MANAGED_REQUIRED_SET_READ_FAILED", "Core did not successfully complete the required-set page read");
      }
      const rows = result.results;
      if (!Array.isArray(rows) || rows.length > input.limit) {
        fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "Core returned an invalid required-set page");
      }
      const last = rows.at(-1);
      return Object.freeze({
        authority_revision: authority.generation,
        rows,
        next_cursor: rows.length === input.limit && last !== undefined
          ? Object.freeze({
            project_id: last.project_id,
            source_id: last.source_id,
            membership_generation: last.membership_generation,
            source_revision_ref: last.source_revision_ref,
          })
          : null,
      });
    },
  });
}
