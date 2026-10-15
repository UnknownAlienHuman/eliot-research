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
  aiSearchPhysicalProfileDigest,
  matchAiSearchProfileIdentity,
  projectionDigest,
} from "@eliotr/cloudflare-projection";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";
import {
  ManagedSearchProductSelectionError,
  resolveManagedTargetSelectionV2,
  type ManagedTargetSelectionV2,
} from "./managed-search-product-selection.js";

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
  readonly event_decision_version: unknown;
  readonly event_selection_mode: unknown;
  readonly event_product_alias: unknown;
  readonly current_event_revision: unknown;
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
  readonly head_revision: number;
  readonly head_event: ManagedTargetAssignmentEvent | null;
}

export interface ManagedSearchProductOptInSnapshotV2 {
  readonly protocol: "eliotr.managed-search-product-optin.v2";
  readonly decision_version: 2;
  readonly project_id: string;
  readonly decision: "ENABLED" | "DISABLED";
  readonly product_alias?: "primary";
  readonly expected_head_revision: number;
}

interface ManagedSearchProductEvent {
  readonly event_revision: number;
  readonly expected_event_revision: number;
  readonly event_kind: "ASSIGN" | "RETIRE";
  readonly project_id: string;
  readonly project_generation: number;
  readonly project_owner_principal_ref: string;
  readonly actor_kind: "OWNER" | "OPERATOR";
  readonly actor_principal_ref: string;
  readonly authorization_receipt_ref: string;
  readonly created_at: string;
  readonly decision_version: 1 | 2;
  readonly selection_mode: "EXACT_GENERATION_V1" | "STABLE_PHYSICAL_PROFILE_V2";
  readonly product_alias: "primary" | null;
  readonly target: ManagedTargetIdentity | null;
  readonly previous_assignment_revision: number | null;
}

interface ManagedSearchProductCurrent {
  readonly project_generation: number;
  readonly project_owner_principal_ref: string;
  readonly d1_now: string;
  readonly head_revision: number;
  readonly head_event: ManagedSearchProductEvent | null;
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
  if (profile.id !== AI_SEARCH_PRIMARY_INSTANCE_ID) {
    fail("MANAGED_TARGET_ASSIGNMENT_PROFILE_UNAVAILABLE", 503,
      "The configured managed target identity differs from its immutable profile", true);
  }
  let profileIdentity: string;
  try {
    profileIdentity = await aiSearchPhysicalProfileDigest(profile);
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
  if (row.event_decision_version !== 1 ||
      row.event_selection_mode !== "EXACT_GENERATION_V1" ||
      row.event_product_alias !== null) {
    fail("MANAGED_TARGET_ASSIGNMENT_VERSIONED_HEAD", 409,
      "This assignment head uses the V2 managed-search product API");
  }
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

function decodeManagedSearchProductEvent(
  row: AssignmentHeadRow,
): ManagedSearchProductEvent | null {
  if (row.event_project_id === null) {
    if (row.current_event_revision !== null) {
      fail("MANAGED_TARGET_ASSIGNMENT_READBACK_INVALID", 503,
        "The current managed-search head has no matching immutable event", true);
    }
    return null;
  }
  if (!Number.isSafeInteger(row.current_event_revision) ||
      !Number.isSafeInteger(row.event_revision) ||
      row.current_event_revision !== row.event_revision) {
    fail("MANAGED_TARGET_ASSIGNMENT_READBACK_INVALID", 503,
      "The current managed-search head revision is invalid", true);
  }
  const decisionVersion = row.event_decision_version;
  const selectionMode = row.event_selection_mode;
  const productAlias = row.event_product_alias;
  if (!(
    (decisionVersion === 1 && selectionMode === "EXACT_GENERATION_V1" && productAlias === null) ||
    (decisionVersion === 2 && selectionMode === "STABLE_PHYSICAL_PROFILE_V2" && productAlias === "primary")
  )) {
    fail("MANAGED_TARGET_ASSIGNMENT_READBACK_INVALID", 503,
      "The current managed-search head has an invalid versioned selection marker", true);
  }

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
  } else if (row.event_kind === "RETIRE") {
    commandInput.previous_assignment_revision = row.previous_assignment_revision;
  } else {
    fail("MANAGED_TARGET_ASSIGNMENT_READBACK_INVALID", 503,
      "The current managed-search event kind is invalid", true);
  }

  try {
    const command = parseManagedTargetAssignmentCommand(commandInput);
    if (command.project_id !== row.event_project_id ||
        command.expected_event_revision + 1 !== row.event_revision) {
      throw new Error("managed-search event revision does not match its command");
    }
    return Object.freeze({
      ...command,
      event_revision: row.event_revision as number,
      actor_kind: command.actor.kind,
      actor_principal_ref: command.actor.principal_ref,
      authorization_receipt_ref: command.actor.authorization_receipt_ref,
      decision_version: decisionVersion as 1 | 2,
      selection_mode: selectionMode as ManagedSearchProductEvent["selection_mode"],
      product_alias: productAlias as "primary" | null,
      target: command.event_kind === "ASSIGN" ? command.target : null,
      previous_assignment_revision: command.event_kind === "RETIRE"
        ? command.previous_assignment_revision
        : null,
    });
  } catch {
    fail("MANAGED_TARGET_ASSIGNMENT_READBACK_INVALID", 503,
      "The current managed-search event is invalid", true);
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
        "e.decision_version AS event_decision_version,e.selection_mode AS event_selection_mode," +
        "e.product_alias AS event_product_alias,h.event_revision AS current_event_revision," +
        "e.previous_assignment_revision,e.actor_kind,e.actor_principal_ref,e.authorization_receipt_ref,e.created_at " +
        "FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
        "LEFT JOIN managed_target_assignment_current h ON h.project_id=p.project_id " +
        "LEFT JOIN managed_target_assignment_event e ON e.project_id=h.project_id AND e.event_revision=h.event_revision " +
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
      head_revision: row.current_event_revision === null
        ? 0
        : row.current_event_revision as number,
      head_event: decodeHeadEvent(row),
    });
  }

  function assertAssignableProjectEvent(
    event: ManagedTargetAssignmentEvent | null,
    current: CurrentAssignmentHead,
  ): void {
    if (event !== null && (
      event.project_owner_principal_ref !== current.project_owner_principal_ref ||
      event.project_generation > current.project_generation
    )) {
      throw new ManagedTargetAssignmentError(
        "MANAGED_TARGET_ASSIGNMENT_PROJECT_AUTHORITY_STALE",
        "The assignment head is foreign or from a future project generation",
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
    // event_revision owns assignment identity; project_generation records only
    // the metadata revision current when that immutable event was appended.
    const active = head?.event_kind === "ASSIGN" &&
      head.project_generation <= current.project_generation &&
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
    const head = current.head_event;
    assertAssignableProjectEvent(head, current);
    // Historical hashes retain their exact event bytes. Only an already committed intent may
    // replay this identity; every new append is required to use the physical-profile digest.
    if (!sameTarget(target, configuredTarget) && head?.event_kind === "ASSIGN" &&
        target.namespace === configuredTarget.namespace &&
        target.managed_instance_id === configuredTarget.managed_instance_id &&
        target.managed_generation === AI_SEARCH_PRIMARY_PROJECTION_PROFILE.generation &&
        await matchAiSearchProfileIdentity(AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
          target.target_profile_identity_sha256) === "LEGACY_GENERATION_V1") {
      const replayCommand = commandFor(current, "ASSIGN", expectedEventRevision,
        await ownerAccessReceiptReference(access), target);
      if (matchesIntent(head, replayCommand)) return head;
    }
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

export function createManagedSearchProductOptInService(
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

  async function readCurrent(): Promise<ManagedSearchProductCurrent> {
    if (context.request.signal.aborted) {
      fail("MANAGED_TARGET_ASSIGNMENT_AUTHORITY_CHANGED", 409,
        "Owner product-decision request was cancelled");
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
        "e.decision_version AS event_decision_version,e.selection_mode AS event_selection_mode," +
        "e.product_alias AS event_product_alias,h.event_revision AS current_event_revision," +
        "e.previous_assignment_revision,e.actor_kind,e.actor_principal_ref,e.authorization_receipt_ref,e.created_at " +
        "FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
        "LEFT JOIN managed_target_assignment_current h ON h.project_id=p.project_id " +
        "LEFT JOIN managed_target_assignment_event e ON e.project_id=h.project_id AND e.event_revision=h.event_revision " +
        "WHERE p.project_id=?1 AND o.principal_ref=?2 LIMIT 1",
      ).bind(projectId, principalRef, access.expires_at).first<AssignmentHeadRow>();
    } catch {
      fail("MANAGED_TARGET_ASSIGNMENT_AUTHORITY_UNAVAILABLE", 503,
        "Current managed-search product authority could not be read", true);
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
        "Owner product-decision request was cancelled");
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
        "Current project product authority is invalid", true);
    }
    const headRevision = row.current_event_revision === null
      ? 0
      : row.current_event_revision;
    if (!Number.isSafeInteger(headRevision) || (headRevision as number) < 0) {
      fail("MANAGED_TARGET_ASSIGNMENT_READBACK_INVALID", 503,
        "Current managed-search event-head revision is invalid", true);
    }
    return Object.freeze({
      project_generation: row.current_project_generation as number,
      project_owner_principal_ref: row.current_project_owner_principal_ref,
      d1_now: row.d1_now,
      head_revision: headRevision as number,
      head_event: decodeManagedSearchProductEvent(row),
    });
  }

  function eventDecision(event: ManagedSearchProductEvent | null, current: ManagedSearchProductCurrent): "ENABLED" | "DISABLED" {
    return event !== null &&
      event.decision_version === 2 &&
      event.selection_mode === "STABLE_PHYSICAL_PROFILE_V2" &&
      event.product_alias === "primary" &&
      event.event_kind === "ASSIGN" &&
      event.project_owner_principal_ref === current.project_owner_principal_ref &&
      event.project_generation <= current.project_generation
      ? "ENABLED"
      : "DISABLED";
  }

  function snapshot(current: ManagedSearchProductCurrent): ManagedSearchProductOptInSnapshotV2 {
    const decision = eventDecision(current.head_event, current);
    return Object.freeze({
      protocol: "eliotr.managed-search-product-optin.v2",
      decision_version: 2,
      project_id: projectId,
      decision,
      ...(decision === "ENABLED" ? { product_alias: "primary" as const } : {}),
      expected_head_revision: current.head_revision,
    });
  }

  function assertWritableHead(current: ManagedSearchProductCurrent): void {
    const head = current.head_event;
    if (head !== null && (
      head.project_owner_principal_ref !== current.project_owner_principal_ref ||
      head.project_generation > current.project_generation
    )) {
      throw new ManagedTargetAssignmentError(
        "MANAGED_TARGET_ASSIGNMENT_PROJECT_AUTHORITY_STALE",
        "The current product decision belongs to another owner or a future project generation",
      );
    }
  }

  function isDecisionReplay(
    event: ManagedSearchProductEvent | null,
    expectedHeadRevision: number,
    decision: "ENABLED" | "DISABLED",
  ): boolean {
    return event !== null &&
      event.decision_version === 2 &&
      event.selection_mode === "STABLE_PHYSICAL_PROFILE_V2" &&
      event.product_alias === "primary" &&
      event.expected_event_revision === expectedHeadRevision &&
      event.event_revision === expectedHeadRevision + 1 &&
      ((decision === "ENABLED" && event.event_kind === "ASSIGN") ||
        (decision === "DISABLED" && event.event_kind === "RETIRE"));
  }

  async function ensureV1HeadUsesPrimaryProfile(
    event: ManagedSearchProductEvent,
  ): Promise<void> {
    if (event.event_kind !== "ASSIGN" ||
        event.decision_version !== 1 ||
        event.target === null ||
        event.target.namespace !== AI_SEARCH_PRIMARY_NAMESPACE ||
        event.target.managed_instance_id !== AI_SEARCH_PRIMARY_INSTANCE_ID) {
      throw new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_PROFILE_MISMATCH", 409,
        "An existing exact-generation assignment cannot be upgraded to the reviewed primary product");
    }
    const currentMatch = await matchAiSearchProfileIdentity(
      AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
      event.target.target_profile_identity_sha256,
    );
    if (currentMatch === "PHYSICAL_V1") return;
    if (currentMatch === "LEGACY_GENERATION_V1" &&
        event.target.managed_generation === AI_SEARCH_PRIMARY_PROJECTION_PROFILE.generation) return;
    const legacyProfile = {
      ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
      generation: event.target.managed_generation,
      index_method: { ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE.index_method },
      metadata_fields: [...AI_SEARCH_PRIMARY_PROJECTION_PROFILE.metadata_fields].sort(),
    };
    if (event.target.target_profile_identity_sha256 === await projectionDigest(legacyProfile)) return;
    throw new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_PROFILE_MISMATCH", 409,
      "The existing exact-generation assignment does not prove the reviewed primary physical profile");
  }

  async function appendDecision(
    current: ManagedSearchProductCurrent,
    decision: "ENABLED" | "DISABLED",
    selection: ManagedTargetSelectionV2 | null,
  ): Promise<void> {
    const head = current.head_event;
    const accessReceiptRef = await ownerAccessReceiptReference(access);
    const common = {
      project_id: projectId,
      project_generation: current.project_generation,
      project_owner_principal_ref: current.project_owner_principal_ref,
      expected_event_revision: current.head_revision,
      actor: {
        kind: "OWNER" as const,
        principal_ref: principalRef,
        authorization_receipt_ref: accessReceiptRef,
      },
      created_at: current.d1_now,
      decision_version: 2 as const,
      selection_mode: "STABLE_PHYSICAL_PROFILE_V2" as const,
      product_alias: "primary" as const,
    };
    let command:
      | (typeof common & { readonly event_kind: "ASSIGN"; readonly target: ManagedTargetIdentity })
      | (typeof common & { readonly event_kind: "RETIRE"; readonly previous_assignment_revision: number });
    if (decision === "ENABLED") {
      if (selection === null) {
        fail("MANAGED_TARGET_ASSIGNMENT_PROFILE_UNAVAILABLE", 503,
          "The reviewed primary registry target was not resolved", true);
      }
      command = {
        ...common,
        event_kind: "ASSIGN" as const,
        target: selection.target,
      };
    } else {
      if (head === null || head.event_kind !== "ASSIGN") {
        fail("MANAGED_TARGET_ASSIGNMENT_RETIREMENT_STALE", 409,
          "A product disable append requires the current assigned event");
      }
      command = {
        ...common,
        event_kind: "RETIRE" as const,
        previous_assignment_revision: head.event_revision,
      };
    }
    const port = createD1ManagedTargetAssignmentPort(env.CORE_DB, async () => undefined, access.expires_at);
    const appendProductDecisionV2 = port.appendProductDecisionV2;
    if (appendProductDecisionV2 === undefined) {
      fail("MANAGED_TARGET_ASSIGNMENT_AUTHORITY_UNAVAILABLE", 503,
        "The versioned managed-search decision writer is unavailable", true);
    }
    try {
      await appendProductDecisionV2(command, async (candidate) => {
        if (context.request.signal.aborted) {
          throw new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_AUTHORITY_CHANGED", 409,
            "Owner product-decision request was cancelled");
        }
        if (
          candidate.project_id !== projectId ||
          candidate.project_owner_principal_ref !== principalRef ||
          candidate.actor.kind !== "OWNER" ||
          candidate.actor.principal_ref !== principalRef ||
          candidate.actor.authorization_receipt_ref !== accessReceiptRef
        ) {
          throw new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_AUTHORIZATION_DENIED", 403,
            "The verified owner context does not authorize this product decision");
        }
        if (candidate.event_kind === "ASSIGN" &&
            (selection === null ||
             candidate.target.namespace !== selection.target.namespace ||
             candidate.target.managed_instance_id !== selection.target.managed_instance_id ||
             candidate.target.managed_generation !== selection.target.managed_generation ||
             candidate.target.target_profile_identity_sha256 !== selection.target.target_profile_identity_sha256)) {
          throw new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_PROFILE_MISMATCH", 409,
            "The resolved registry target differs from the authorized product selection");
        }
        const fresh = await readCurrent();
        if (candidate.expected_event_revision !== fresh.head_revision ||
            candidate.project_generation !== fresh.project_generation ||
            candidate.project_owner_principal_ref !== fresh.project_owner_principal_ref) {
          throw new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_PROJECT_AUTHORITY_STALE", 409,
            "Project owner, revision, or decision head changed before product append");
        }
      });
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
          if (isDecisionReplay(observed.head_event, current.head_revision, decision)) return;
        } catch {
          // Preserve the uncertain append; a later GET is the recovery read.
        }
      }
      throw error;
    }
  }

  async function decide(input: {
    readonly expected_head_revision: number;
    readonly decision: "ENABLED" | "DISABLED";
  }): Promise<ManagedSearchProductOptInSnapshotV2> {
    if (!Number.isSafeInteger(input.expected_head_revision) ||
        input.expected_head_revision < 0 || input.expected_head_revision > MAX_EXPECTED_EVENT_REVISION) {
      fail("MANAGED_TARGET_ASSIGNMENT_INPUT_INVALID", 400,
        "Expected managed-search head revision is invalid");
    }
    const current = await readCurrent();
    const head = current.head_event;
    if (head !== null && isDecisionReplay(head, input.expected_head_revision, input.decision)) {
      return snapshot(current);
    }
    if (current.head_revision !== input.expected_head_revision) {
      throw new ManagedTargetAssignmentError(
        "MANAGED_TARGET_ASSIGNMENT_CAS_CONFLICT",
        "Expected managed-search head differs from the current event revision",
      );
    }
    const alreadyDisabled = input.decision === "DISABLED" &&
      (head === null || head.event_kind === "RETIRE");
    if ((input.decision === "ENABLED" && eventDecision(head, current) === "ENABLED") || alreadyDisabled) {
      return snapshot(current);
    }
    assertWritableHead(current);

    if (input.decision === "DISABLED") {
      if (head === null || head.event_kind === "RETIRE") return snapshot(current);
      await appendDecision(current, "DISABLED", null);
      return snapshot(await readCurrent());
    }

    if (head?.event_kind === "ASSIGN" && head.decision_version === 1) {
      await ensureV1HeadUsesPrimaryProfile(head);
    }
    let selection: ManagedTargetSelectionV2;
    try {
      selection = await resolveManagedTargetSelectionV2(env.SEARCH_DB, "ACTIVE");
    } catch (error) {
      if (error instanceof ManagedSearchProductSelectionError) {
        const status = error.code === "MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND" ? 409 : 503;
        throw new HttpRequestError(error.code, status, error.message, status === 503);
      }
      throw error;
    }
    await appendDecision(current, "ENABLED", selection);
    return snapshot(await readCurrent());
  }

  return Object.freeze({
    async read(): Promise<ManagedSearchProductOptInSnapshotV2> {
      return snapshot(await readCurrent());
    },
    decide,
  });
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
