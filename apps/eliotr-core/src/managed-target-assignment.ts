import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  createD1ManagedTargetAssignmentPort,
  ManagedTargetAssignmentError,
  parseManagedTargetAssignmentCommand,
  type ManagedTargetAssignmentCommand,
  type ManagedTargetAssignmentEvent,
  type ManagedTargetIdentity,
} from "@eliotr/cloudflare-projection";
import {
  AI_SEARCH_PRIMARY_GENERATION,
  AI_SEARCH_PRIMARY_INSTANCE_ID,
  AI_SEARCH_PRIMARY_NAMESPACE,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  assertImmutableAiSearchProfile,
  projectionDigest,
} from "@eliotr/cloudflare-projection";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MAX_EXPECTED_EVENT_REVISION = 999_999;

interface OwnerAccess {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly authentication_method: "cloudflare_access";
  readonly issuer?: string;
  readonly expires_at: string;
}

interface AssignmentHeadRow {
  readonly current_project_generation: unknown;
  readonly current_project_owner_principal_ref: unknown;
  readonly access_current: unknown;
  readonly d1_now: unknown;
  readonly event_project_id: unknown;
  readonly event_revision: unknown;
  readonly expected_event_revision: unknown;
  readonly event_kind: unknown;
  readonly event_project_generation: unknown;
  readonly event_project_owner_principal_ref: unknown;
  readonly event_target_namespace: unknown;
  readonly event_managed_instance_id: unknown;
  readonly event_managed_generation: unknown;
  readonly event_target_profile_identity_sha256: unknown;
  readonly previous_assignment_revision: unknown;
  readonly actor_kind: unknown;
  readonly actor_principal_ref: unknown;
  readonly authorization_receipt_ref: unknown;
  readonly created_at: unknown;
}

interface CurrentAssignmentHead {
  readonly project_generation: number;
  readonly project_owner_principal_ref: string;
  readonly d1_now: string;
  readonly head_event: ManagedTargetAssignmentEvent | null;
}

export interface ManagedTargetAssignmentSnapshot {
  readonly protocol: "eliotr.managed-target-assignment.v1";
  readonly project_id: string;
  readonly project_generation: number;
  readonly project_owner_principal_ref: string;
  readonly configured_target: ManagedTargetIdentity;
  readonly event_head_revision: number;
  /** Exact durable head, retained so an owner can reconcile a lost response. */
  readonly head_event: ManagedTargetAssignmentEvent | null;
  readonly current_assignment: {
    readonly event_revision: number;
    readonly target: ManagedTargetIdentity;
  } | null;
}

function fail(code: string, status: number, message: string, retryable = false): never {
  throw new HttpRequestError(code, status, message, retryable);
}

function requireOwnerContext(context: AuthenticatedRequestContext): OwnerAccess {
  const access = context.access;
  if (
    context.client_class !== "owner_pwa" ||
    access === undefined ||
    access.authentication_method !== "cloudflare_access" ||
    !IDENTIFIER.test(context.principal_ref) ||
    !IDENTIFIER.test(context.credential_generation) ||
    access.principal_ref !== context.principal_ref ||
    access.credential_generation !== context.credential_generation ||
    typeof access.expires_at !== "string" ||
    !Number.isFinite(Date.parse(access.expires_at)) ||
    new Date(access.expires_at).toISOString() !== access.expires_at
  ) {
    fail("MANAGED_TARGET_ASSIGNMENT_OWNER_REQUIRED", 403,
      "A verified current owner Access session is required");
  }
  return Object.freeze({
    principal_ref: access.principal_ref,
    credential_generation: access.credential_generation,
    authentication_method: "cloudflare_access" as const,
    ...(access.issuer === undefined ? {} : { issuer: access.issuer }),
    expires_at: access.expires_at,
  });
}

/**
 * This is audit correlation only, not authorization proof. The authorizer checks
 * the frozen verified claims and current D1 owner; the append fences expiry in SQL.
 */
async function ownerAccessReceiptReference(access: OwnerAccess): Promise<string> {
  const digest = await projectionDigest({
    protocol: "eliotr.managed-target-assignment.owner-access.v1",
    principal_ref: access.principal_ref,
    credential_generation: access.credential_generation,
    authentication_method: access.authentication_method,
    issuer: access.issuer ?? null,
    expires_at: access.expires_at,
  });
  return `owner-access-${digest}`;
}

/** The normalized server-owned profile is available before registry declaration. */
export async function readConfiguredManagedTargetIdentity(): Promise<ManagedTargetIdentity> {
  const configured = AI_SEARCH_PRIMARY_PROJECTION_PROFILE;
  const profile = Object.freeze({
    ...configured,
    index_method: Object.freeze({ ...configured.index_method }),
    metadata_fields: Object.freeze([...configured.metadata_fields].sort()),
  });
  try {
    assertImmutableAiSearchProfile(profile, configured);
  } catch {
    fail("MANAGED_TARGET_ASSIGNMENT_PROFILE_UNAVAILABLE", 503,
      "The configured immutable managed target profile is unavailable", true);
  }
  if (profile.id !== AI_SEARCH_PRIMARY_INSTANCE_ID ||
      profile.generation !== AI_SEARCH_PRIMARY_GENERATION) {
    fail("MANAGED_TARGET_ASSIGNMENT_PROFILE_UNAVAILABLE", 503,
      "The configured managed target identity differs from its immutable profile", true);
  }
  let profileIdentity: string;
  try {
    profileIdentity = await projectionDigest(profile);
  } catch {
    fail("MANAGED_TARGET_ASSIGNMENT_PROFILE_UNAVAILABLE", 503,
      "The configured immutable managed target profile could not be identified", true);
  }
  return Object.freeze({
    namespace: AI_SEARCH_PRIMARY_NAMESPACE,
    managed_instance_id: AI_SEARCH_PRIMARY_INSTANCE_ID,
    managed_generation: AI_SEARCH_PRIMARY_GENERATION,
    target_profile_identity_sha256: profileIdentity,
  });
}

function sameTarget(left: ManagedTargetIdentity, right: ManagedTargetIdentity): boolean {
  return left.namespace === right.namespace &&
    left.managed_instance_id === right.managed_instance_id &&
    left.managed_generation === right.managed_generation &&
    left.target_profile_identity_sha256 === right.target_profile_identity_sha256;
}

function decodeHeadEvent(row: AssignmentHeadRow): ManagedTargetAssignmentEvent | null {
  if (row.event_project_id === null) return null;
  try {
    const commandInput: Record<string, unknown> = {
      event_kind: row.event_kind,
      project_id: row.event_project_id,
      project_generation: row.event_project_generation,
      project_owner_principal_ref: row.event_project_owner_principal_ref,
      expected_event_revision: row.expected_event_revision,
      actor: {
        kind: row.actor_kind,
        principal_ref: row.actor_principal_ref,
        authorization_receipt_ref: row.authorization_receipt_ref,
      },
      created_at: row.created_at,
    };
    if (row.event_kind === "ASSIGN") {
      commandInput.target = {
        namespace: row.event_target_namespace,
        managed_instance_id: row.event_managed_instance_id,
        managed_generation: row.event_managed_generation,
        target_profile_identity_sha256: row.event_target_profile_identity_sha256,
      };
    } else {
      commandInput.previous_assignment_revision = row.previous_assignment_revision;
    }
    const command = parseManagedTargetAssignmentCommand(commandInput);
    if (!Number.isSafeInteger(row.event_revision) ||
        row.event_revision !== command.expected_event_revision + 1) {
      throw new Error("assignment head revision is inconsistent");
    }
    return Object.freeze({ ...command, event_revision: row.event_revision as number });
  } catch {
    fail("MANAGED_TARGET_ASSIGNMENT_READBACK_INVALID", 503,
      "The durable managed target assignment head is invalid", true);
  }
}

function matchesIntent(
  event: ManagedTargetAssignmentEvent,
  command: ManagedTargetAssignmentCommand,
): boolean {
  if (
    event.event_revision !== command.expected_event_revision + 1 ||
    event.expected_event_revision !== command.expected_event_revision ||
    event.event_kind !== command.event_kind ||
    event.project_id !== command.project_id ||
    event.project_generation !== command.project_generation ||
    event.project_owner_principal_ref !== command.project_owner_principal_ref ||
    event.actor.kind !== command.actor.kind ||
    event.actor.principal_ref !== command.actor.principal_ref
  ) return false;
  if (event.event_kind === "ASSIGN" && command.event_kind === "ASSIGN") {
    return sameTarget(event.target, command.target);
  }
  return event.event_kind === "RETIRE" && command.event_kind === "RETIRE" &&
    event.previous_assignment_revision === command.previous_assignment_revision;
}

export function createManagedTargetAssignmentService(
  env: Env,
  context: AuthenticatedRequestContext,
  rawProjectId: string,
) {
  const access = requireOwnerContext(context);
  if (!IDENTIFIER.test(rawProjectId)) {
    fail("MANAGED_TARGET_ASSIGNMENT_INPUT_INVALID", 400, "Project id is invalid");
  }
  const projectId = rawProjectId;
  const principalRef = context.principal_ref;

  async function readCurrent(): Promise<CurrentAssignmentHead> {
    if (context.request.signal.aborted) {
      fail("MANAGED_TARGET_ASSIGNMENT_AUTHORITY_CHANGED", 409,
        "Owner assignment request was cancelled");
    }
    let row: AssignmentHeadRow | null;
    try {
      row = await env.CORE_DB.prepare(
        "SELECT p.generation AS current_project_generation," +
        "o.principal_ref AS current_project_owner_principal_ref," +
        "CASE WHEN julianday(?3)>julianday('now') THEN 1 ELSE 0 END AS access_current," +
        "strftime('%Y-%m-%dT%H:%M:%fZ','now') AS d1_now," +
        "e.project_id AS event_project_id,e.event_revision,e.expected_event_revision,e.event_kind," +
        "e.project_generation AS event_project_generation," +
        "e.project_owner_principal_ref AS event_project_owner_principal_ref," +
        "e.target_namespace AS event_target_namespace,e.managed_instance_id AS event_managed_instance_id," +
        "e.managed_generation AS event_managed_generation," +
        "e.target_profile_identity_sha256 AS event_target_profile_identity_sha256," +
        "e.previous_assignment_revision,e.actor_kind,e.actor_principal_ref,e.authorization_receipt_ref,e.created_at " +
        "FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
        "LEFT JOIN managed_target_assignment_event e ON e.project_id=p.project_id AND e.event_revision=(" +
        "SELECT MAX(head.event_revision) FROM managed_target_assignment_event head WHERE head.project_id=p.project_id) " +
        "WHERE p.project_id=?1 AND o.principal_ref=?2 LIMIT 1",
      ).bind(projectId, principalRef, access.expires_at).first<AssignmentHeadRow>();
    } catch {
      fail("MANAGED_TARGET_ASSIGNMENT_AUTHORITY_UNAVAILABLE", 503,
        "Current project assignment authority could not be read", true);
    }
    if (row === null) {
      fail("MANAGED_TARGET_ASSIGNMENT_PROJECT_NOT_FOUND", 404,
        "Project is unavailable to the authenticated owner");
    }
    if (row.access_current !== 1) {
      fail("MANAGED_TARGET_ASSIGNMENT_OWNER_AUTH_EXPIRED", 401,
        "The owner Access session has expired");
    }
    if (context.request.signal.aborted) {
      fail("MANAGED_TARGET_ASSIGNMENT_AUTHORITY_CHANGED", 409,
        "Owner assignment request was cancelled");
    }
    if (
      typeof row.current_project_owner_principal_ref !== "string" ||
      row.current_project_owner_principal_ref !== principalRef ||
      !Number.isSafeInteger(row.current_project_generation) ||
      (row.current_project_generation as number) < 1 ||
      typeof row.d1_now !== "string" ||
      !Number.isFinite(Date.parse(row.d1_now)) ||
      new Date(row.d1_now).toISOString() !== row.d1_now
    ) {
      fail("MANAGED_TARGET_ASSIGNMENT_AUTHORITY_UNAVAILABLE", 503,
        "Current project assignment authority is invalid", true);
    }
    return Object.freeze({
      project_generation: row.current_project_generation as number,
      project_owner_principal_ref: row.current_project_owner_principal_ref,
      d1_now: row.d1_now,
      head_event: decodeHeadEvent(row),
    });
  }

  function assertCurrentProjectEvent(
    event: ManagedTargetAssignmentEvent | null,
    current: CurrentAssignmentHead,
  ): void {
    if (event !== null && (
      event.project_generation !== current.project_generation ||
      event.project_owner_principal_ref !== current.project_owner_principal_ref
    )) {
      throw new ManagedTargetAssignmentError(
        "MANAGED_TARGET_ASSIGNMENT_PROJECT_AUTHORITY_STALE",
        "The assignment head belongs to a prior project owner or generation",
      );
    }
  }

  function assertRetirableProjectEvent(
    event: ManagedTargetAssignmentEvent | null,
    current: CurrentAssignmentHead,
  ): void {
    if (event !== null && (
      event.project_owner_principal_ref !== current.project_owner_principal_ref ||
      event.project_generation > current.project_generation
    )) {
      throw new ManagedTargetAssignmentError(
        "MANAGED_TARGET_ASSIGNMENT_PROJECT_AUTHORITY_STALE",
        "The assignment head belongs to another owner or a future project generation",
      );
    }
  }

  function commandFor(
    current: CurrentAssignmentHead,
    eventKind: "ASSIGN" | "RETIRE",
    expectedEventRevision: number,
    actorReceiptRef: string,
    target?: ManagedTargetIdentity,
  ): ManagedTargetAssignmentCommand {
    const common = {
      project_id: projectId,
      project_generation: current.project_generation,
      project_owner_principal_ref: current.project_owner_principal_ref,
      expected_event_revision: expectedEventRevision,
      actor: {
        kind: "OWNER" as const,
        principal_ref: principalRef,
        authorization_receipt_ref: actorReceiptRef,
      },
      created_at: current.d1_now,
    };
    return parseManagedTargetAssignmentCommand(eventKind === "ASSIGN"
      ? { ...common, event_kind: eventKind, target }
      : {
        ...common,
        event_kind: eventKind,
        previous_assignment_revision: expectedEventRevision,
      });
  }

  async function append(command: ManagedTargetAssignmentCommand): Promise<ManagedTargetAssignmentEvent> {
    const accessReceiptRef = await ownerAccessReceiptReference(access);
    const configuredTarget = command.event_kind === "ASSIGN"
      ? await readConfiguredManagedTargetIdentity()
      : null;
    const port = createD1ManagedTargetAssignmentPort(env.CORE_DB, async (candidate) => {
      if (context.request.signal.aborted) {
        throw new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_AUTHORITY_CHANGED", 409,
          "Owner assignment request was cancelled");
      }
      if (
        candidate.project_id !== projectId ||
        candidate.project_owner_principal_ref !== principalRef ||
        candidate.actor.kind !== "OWNER" ||
        candidate.actor.principal_ref !== principalRef ||
        candidate.actor.authorization_receipt_ref !== accessReceiptRef
      ) {
        throw new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_AUTHORIZATION_DENIED", 403,
          "The verified owner context does not authorize this assignment");
      }
      if (candidate.event_kind === "ASSIGN" &&
          (configuredTarget === null || !sameTarget(candidate.target, configuredTarget))) {
        throw new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_PROFILE_MISMATCH", 409,
          "Target identity does not match the server-owned immutable profile");
      }
      const current = await readCurrent();
      if (candidate.project_generation !== current.project_generation ||
          candidate.project_owner_principal_ref !== current.project_owner_principal_ref) {
        throw new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_PROJECT_AUTHORITY_STALE", 409,
          "Project owner or generation changed before assignment append");
      }
    }, access.expires_at);
    try {
      return await port.append(command);
    } catch (error) {
      if (error instanceof ManagedTargetAssignmentError &&
          error.code === "MANAGED_TARGET_ASSIGNMENT_AUTHORIZATION_DENIED" &&
          error.cause instanceof HttpRequestError) {
        throw error.cause;
      }
      if (error instanceof ManagedTargetAssignmentError && (
        error.code === "MANAGED_TARGET_ASSIGNMENT_OUTCOME_UNKNOWN" ||
        error.code === "MANAGED_TARGET_ASSIGNMENT_CAS_CONFLICT"
      )) {
        try {
          const observed = await readCurrent();
          if (observed.head_event !== null && matchesIntent(observed.head_event, command)) {
            return observed.head_event;
          }
        } catch {
          // Preserve the original uncertain result; a later GET is the recovery read.
        }
      }
      throw error;
    }
  }

  async function read(): Promise<ManagedTargetAssignmentSnapshot> {
    const current = await readCurrent();
    const configuredTarget = await readConfiguredManagedTargetIdentity();
    const head = current.head_event;
    const active = head?.event_kind === "ASSIGN" &&
      head.project_generation === current.project_generation &&
      head.project_owner_principal_ref === current.project_owner_principal_ref
      ? Object.freeze({ event_revision: head.event_revision, target: head.target })
      : null;
    return Object.freeze({
      protocol: "eliotr.managed-target-assignment.v1",
      project_id: projectId,
      project_generation: current.project_generation,
      project_owner_principal_ref: current.project_owner_principal_ref,
      configured_target: configuredTarget,
      event_head_revision: head?.event_revision ?? 0,
      head_event: head,
      current_assignment: active,
    });
  }

  async function assign(
    expectedEventRevision: number,
    target: ManagedTargetIdentity,
  ): Promise<ManagedTargetAssignmentEvent> {
    if (!Number.isSafeInteger(expectedEventRevision) ||
        expectedEventRevision < 0 || expectedEventRevision > MAX_EXPECTED_EVENT_REVISION) {
      fail("MANAGED_TARGET_ASSIGNMENT_INPUT_INVALID", 400,
        "Expected assignment revision is invalid");
    }
    const current = await readCurrent();
    const configuredTarget = await readConfiguredManagedTargetIdentity();
    if (!sameTarget(target, configuredTarget)) {
      fail("MANAGED_TARGET_ASSIGNMENT_PROFILE_MISMATCH", 409,
        "Target identity does not match the server-owned immutable profile");
    }
    const command = commandFor(
      current,
      "ASSIGN",
      expectedEventRevision,
      await ownerAccessReceiptReference(access),
      configuredTarget,
    );
    const head = current.head_event;
    assertCurrentProjectEvent(head, current);
    const headRevision = head?.event_revision ?? 0;
    if (head !== null && matchesIntent(head, command)) return head;
    if (headRevision !== expectedEventRevision) {
      throw new ManagedTargetAssignmentError(
        "MANAGED_TARGET_ASSIGNMENT_CAS_CONFLICT",
        "Expected assignment revision differs from the exact event head",
      );
    }
    if (head?.event_kind === "ASSIGN") {
      throw new ManagedTargetAssignmentError(
        "MANAGED_TARGET_ASSIGNMENT_ACTIVE_REQUIRES_RETIREMENT",
        "Retire the current target assignment before assigning another target",
      );
    }
    return append(command);
  }

  async function retire(expectedEventRevision: number): Promise<ManagedTargetAssignmentEvent> {
    if (!Number.isSafeInteger(expectedEventRevision) ||
        expectedEventRevision < 1 || expectedEventRevision > MAX_EXPECTED_EVENT_REVISION) {
      fail("MANAGED_TARGET_ASSIGNMENT_INPUT_INVALID", 400,
        "Expected assignment revision is invalid");
    }
    const current = await readCurrent();
    const command = commandFor(
      current,
      "RETIRE",
      expectedEventRevision,
      await ownerAccessReceiptReference(access),
    );
    const head = current.head_event;
    assertRetirableProjectEvent(head, current);
    if (head !== null && matchesIntent(head, command)) return head;
    if ((head?.event_revision ?? 0) !== expectedEventRevision) {
      throw new ManagedTargetAssignmentError(
        "MANAGED_TARGET_ASSIGNMENT_CAS_CONFLICT",
        "Expected assignment revision differs from the exact event head",
      );
    }
    if (head?.event_kind !== "ASSIGN") {
      throw new ManagedTargetAssignmentError(
        "MANAGED_TARGET_ASSIGNMENT_RETIREMENT_STALE",
        "There is no current assignment at the expected event revision",
      );
    }
    return append(command);
  }

  return Object.freeze({ read, assign, retire });
}

export function mapManagedTargetAssignmentError(error: unknown): never {
  if (error instanceof HttpRequestError) throw error;
  if (error instanceof ManagedTargetAssignmentError) {
    const status = error.code === "MANAGED_TARGET_ASSIGNMENT_INVALID" ? 400
      : error.code === "MANAGED_TARGET_ASSIGNMENT_AUTHORIZATION_DENIED" ? 403
      : error.code === "MANAGED_TARGET_ASSIGNMENT_OUTCOME_UNKNOWN" ? 503
      : 409;
    throw new HttpRequestError(error.code, status,
      status === 503
        ? "Assignment outcome is uncertain; read the exact event head before taking further action"
        : "Managed target assignment conflicts with current owner authority",
      false);
  }
  throw new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_UNAVAILABLE", 503,
    "Managed target assignment is temporarily unavailable", true);
}
