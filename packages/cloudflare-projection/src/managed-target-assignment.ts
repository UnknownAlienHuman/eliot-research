const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface ManagedTargetIdentity {
  /** AI Search generation-registry namespace; distinct from every source namespace. */
  readonly namespace: string;
  readonly managed_instance_id: string;
  readonly managed_generation: string;
  /** Digest of the immutable profile bound to this exact generation. */
  readonly target_profile_identity_sha256: string;
}

/** Exact V1 assignment selection. Its generation and digest remain coupled. */
export interface ManagedTargetSelectionV1 {
  readonly protocol: "eliotr.managed-target-selection.v1";
  readonly domain: "MANAGED_TARGET_ASSIGNMENT";
  readonly decision_version: 1;
  readonly selection_mode: "EXACT_GENERATION_V1";
  readonly target: ManagedTargetIdentity;
}

/** V2 physical selection captures a registry receipt or explicit absence for a planned SHADOW. */
export interface ManagedTargetSelectionV2 {
  readonly protocol: "eliotr.managed-target-selection.v2";
  readonly domain: "MANAGED_SEARCH_PRODUCT";
  readonly decision_version: 2;
  readonly selection_mode: "STABLE_PHYSICAL_PROFILE_V2";
  readonly product_alias: "primary";
  readonly purpose: "ACTIVE" | "SHADOW";
  readonly registry_revision: number | null;
  readonly registry_artifact_sha256: string | null;
  /** Exact full-profile legacy V1 digest accepted only at this exact generation. */
  readonly v1_exact_profile_identity_sha256: string;
  readonly target: ManagedTargetIdentity;
}

export type ManagedTargetSelectionReceipt =
  | ManagedTargetSelectionV1
  | ManagedTargetSelectionV2;

/** Null is honest bootstrap absence, never ACTIVE or a failed registry read. */
export function hasValidManagedTargetRegistryCaptureV2(selection: Pick<ManagedTargetSelectionV2,
  "purpose" | "registry_revision" | "registry_artifact_sha256">): boolean {
  if (selection.registry_revision === null || selection.registry_artifact_sha256 === null) {
    return selection.purpose === "SHADOW" && selection.registry_revision === null && selection.registry_artifact_sha256 === null;
  }
  return Number.isSafeInteger(selection.registry_revision) && selection.registry_revision >= 1 &&
    /^[a-f0-9]{64}$/u.test(selection.registry_artifact_sha256);
}

export interface ManagedTargetAssignmentActor {
  readonly kind: "OWNER" | "OPERATOR";
  readonly principal_ref: string;
  readonly authorization_receipt_ref: string;
}

interface ManagedTargetAssignmentCommandBase {
  readonly project_id: string;
  readonly project_generation: number;
  readonly project_owner_principal_ref: string;
  /** Latest project assignment event revision observed by the caller; zero means no event. */
  readonly expected_event_revision: number;
  readonly actor: ManagedTargetAssignmentActor;
  readonly created_at: string;
}

export interface AssignManagedTargetCommand extends ManagedTargetAssignmentCommandBase {
  readonly event_kind: "ASSIGN";
  readonly target: ManagedTargetIdentity;
}

export interface RetireManagedTargetCommand extends ManagedTargetAssignmentCommandBase {
  readonly event_kind: "RETIRE";
  /** Must identify the currently active ASSIGN event and equal expected_event_revision. */
  readonly previous_assignment_revision: number;
}

export type ManagedTargetAssignmentCommand =
  | AssignManagedTargetCommand
  | RetireManagedTargetCommand;

export type ManagedTargetAssignmentEvent = ManagedTargetAssignmentCommand & {
  readonly event_revision: number;
};

/**
 * Core D1 implements this port with one atomic append/CAS operation. It must
 * re-read project owner and generation, validate the owner's/operator's
 * authorization receipt, and rely on migration 0141's append-only guards.
 */
export interface ManagedTargetAssignmentPort {
  append(
    command: ManagedTargetAssignmentCommand,
  ): Promise<ManagedTargetAssignmentEvent>;
  /** Explicit V2 product decision on the same immutable event/current-head tables. */
  appendProductDecisionV2?(
    command: ManagedSearchProductDecisionCommandV2,
    authorize: ManagedSearchProductDecisionAuthorizer,
  ): Promise<ManagedSearchProductDecisionEventV2>;
}

type ManagedSearchProductDecisionCommandV2 =
  | (ManagedTargetAssignmentCommandBase & {
    readonly event_kind: "ASSIGN";
    readonly decision_version: 2;
    readonly selection_mode: "STABLE_PHYSICAL_PROFILE_V2";
    readonly product_alias: "primary";
    readonly target: ManagedTargetIdentity;
  })
  | (ManagedTargetAssignmentCommandBase & {
    readonly event_kind: "RETIRE";
    readonly decision_version: 2;
    readonly selection_mode: "STABLE_PHYSICAL_PROFILE_V2";
    readonly product_alias: "primary";
    readonly previous_assignment_revision: number;
  });

type ManagedSearchProductDecisionEventV2 = ManagedSearchProductDecisionCommandV2 & {
  readonly event_revision: number;
};

type ManagedSearchProductDecisionAuthorizer = (
  command: ManagedSearchProductDecisionCommandV2,
) => Promise<void>;

export type ManagedTargetAssignmentErrorCode =
  | "MANAGED_TARGET_ASSIGNMENT_INVALID"
  | "MANAGED_TARGET_ASSIGNMENT_CAS_CONFLICT"
  | "MANAGED_TARGET_ASSIGNMENT_PROJECT_AUTHORITY_STALE"
  | "MANAGED_TARGET_ASSIGNMENT_OWNER_ACTOR_MISMATCH"
  | "MANAGED_TARGET_ASSIGNMENT_ACTIVE_REQUIRES_RETIREMENT"
  | "MANAGED_TARGET_ASSIGNMENT_RETIREMENT_STALE"
  | "MANAGED_TARGET_ASSIGNMENT_AUTHORIZATION_DENIED"
  | "MANAGED_TARGET_ASSIGNMENT_OUTCOME_UNKNOWN";

export class ManagedTargetAssignmentError extends Error {
  public readonly code: ManagedTargetAssignmentErrorCode;

  public constructor(code: ManagedTargetAssignmentErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ManagedTargetAssignmentError";
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new ManagedTargetAssignmentError("MANAGED_TARGET_ASSIGNMENT_INVALID", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    invalid(`${label} contains an unknown field`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    invalid("created_at must be a canonical UTC millisecond timestamp");
  }
  return value;
}

function parseTarget(value: unknown): ManagedTargetIdentity {
  const target = record(value, "target");
  exactKeys(target, [
    "namespace",
    "managed_instance_id",
    "managed_generation",
    "target_profile_identity_sha256",
  ], "target");
  const profile = target.target_profile_identity_sha256;
  if (typeof profile !== "string" || !SHA256.test(profile)) {
    invalid("target profile identity must be a lowercase SHA-256 digest");
  }
  return Object.freeze({
    namespace: identifier(target.namespace, "target namespace"),
    managed_instance_id: identifier(target.managed_instance_id, "managed instance id"),
    managed_generation: identifier(target.managed_generation, "managed generation"),
    target_profile_identity_sha256: profile,
  });
}

function parseActor(value: unknown, ownerPrincipal: string): ManagedTargetAssignmentActor {
  const actor = record(value, "actor");
  exactKeys(actor, ["kind", "principal_ref", "authorization_receipt_ref"], "actor");
  if (actor.kind !== "OWNER" && actor.kind !== "OPERATOR") {
    invalid("actor kind must be OWNER or OPERATOR");
  }
  const principal = identifier(actor.principal_ref, "actor principal");
  if (actor.kind === "OWNER" && principal !== ownerPrincipal) {
    invalid("owner actor must match the bound project owner");
  }
  return Object.freeze({
    kind: actor.kind,
    principal_ref: principal,
    authorization_receipt_ref: identifier(
      actor.authorization_receipt_ref,
      "authorization receipt",
    ),
  });
}

/** Strictly validates an explicit assignment or retirement event command. */
export function parseManagedTargetAssignmentCommand(
  input: unknown,
): ManagedTargetAssignmentCommand {
  const value = record(input, "assignment command");
  const commonKeys = [
    "event_kind",
    "project_id",
    "project_generation",
    "project_owner_principal_ref",
    "expected_event_revision",
    "actor",
    "created_at",
  ] as const;
  if (value.event_kind === "ASSIGN") {
    exactKeys(value, [...commonKeys, "target"], "assignment command");
    const owner = identifier(value.project_owner_principal_ref, "project owner principal");
    const expected = positiveInteger(value.expected_event_revision, "expected event revision", 0);
    return Object.freeze({
      event_kind: "ASSIGN",
      project_id: identifier(value.project_id, "project id"),
      project_generation: positiveInteger(value.project_generation, "project generation", 1),
      project_owner_principal_ref: owner,
      expected_event_revision: expected,
      actor: parseActor(value.actor, owner),
      created_at: timestamp(value.created_at),
      target: parseTarget(value.target),
    });
  }
  if (value.event_kind === "RETIRE") {
    exactKeys(value, [...commonKeys, "previous_assignment_revision"], "assignment command");
    const owner = identifier(value.project_owner_principal_ref, "project owner principal");
    const expected = positiveInteger(value.expected_event_revision, "expected event revision", 1);
    const previous = positiveInteger(
      value.previous_assignment_revision,
      "previous assignment revision",
      1,
    );
    if (previous !== expected) {
      invalid("retirement must reference the event revision fenced by the CAS");
    }
    return Object.freeze({
      event_kind: "RETIRE",
      project_id: identifier(value.project_id, "project id"),
      project_generation: positiveInteger(value.project_generation, "project generation", 1),
      project_owner_principal_ref: owner,
      expected_event_revision: expected,
      actor: parseActor(value.actor, owner),
      created_at: timestamp(value.created_at),
      previous_assignment_revision: previous,
    });
  }
  return invalid("event_kind must be ASSIGN or RETIRE");
}

export type ManagedTargetAssignmentAuthorizer = (
  command: ManagedTargetAssignmentCommand,
) => Promise<void>;

interface ManagedTargetAssignmentD1Row {
  readonly project_id: string;
  readonly event_revision: number;
  readonly expected_event_revision: number;
  readonly event_kind: "ASSIGN" | "RETIRE";
  readonly project_generation: number;
  readonly project_owner_principal_ref: string;
  readonly target_namespace: string | null;
  readonly managed_instance_id: string | null;
  readonly managed_generation: string | null;
  readonly target_profile_identity_sha256: string | null;
  readonly previous_assignment_revision: number | null;
  readonly actor_kind: "OWNER" | "OPERATOR";
  readonly actor_principal_ref: string;
  readonly authorization_receipt_ref: string;
  readonly created_at: string;
}

/**
 * Core D1 writer for migration 0141. The injected authorizer must authenticate
 * the owner/operator receipt and verify the exact immutable target profile
 * identity; the SQL trigger then fences the current project principal/generation
 * and append revision in the same write.
 */
export function createD1ManagedTargetAssignmentPort(
  database: D1Database,
  authorize: ManagedTargetAssignmentAuthorizer,
  /** Trusted Access expiry from Core; omitted to preserve existing port callers. */
  authorizationExpiresAt?: string,
): ManagedTargetAssignmentPort {
  const trustedAuthorizationExpiry = authorizationExpiresAt === undefined
    ? undefined
    : timestamp(authorizationExpiresAt);
  return Object.freeze({
    async append(input: ManagedTargetAssignmentCommand): Promise<ManagedTargetAssignmentEvent> {
      const command = parseManagedTargetAssignmentCommand(input);
      try {
        await authorize(command);
      } catch (cause) {
        throw new ManagedTargetAssignmentError(
          "MANAGED_TARGET_ASSIGNMENT_AUTHORIZATION_DENIED",
          "owner/operator authorization did not admit this assignment event",
          cause,
        );
      }

      const target = command.event_kind === "ASSIGN" ? command.target : null;
      const previous = command.event_kind === "RETIRE"
        ? command.previous_assignment_revision
        : null;
      const insertPrefix =
        "INSERT INTO managed_target_assignment_event(" +
        "project_id,event_revision,expected_event_revision,event_kind,project_generation," +
        "project_owner_principal_ref,target_namespace,managed_instance_id,managed_generation," +
        "target_profile_identity_sha256,previous_assignment_revision,actor_kind,actor_principal_ref," +
        "authorization_receipt_ref,created_at) ";
      const insertValues = trustedAuthorizationExpiry === undefined
        ? "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
        : "SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? " +
          "WHERE julianday(?)>julianday('now') ";
      const insertReturning =
        "RETURNING project_id,event_revision,expected_event_revision,event_kind,project_generation," +
        "project_owner_principal_ref,target_namespace,managed_instance_id,managed_generation," +
        "target_profile_identity_sha256,previous_assignment_revision,actor_kind,actor_principal_ref," +
        "authorization_receipt_ref,created_at";
      let row: ManagedTargetAssignmentD1Row | null;
      try {
        const statement = database.prepare(insertPrefix + insertValues + insertReturning);
        const values = [
          command.project_id,
          command.expected_event_revision + 1,
          command.expected_event_revision,
          command.event_kind,
          command.project_generation,
          command.project_owner_principal_ref,
          target?.namespace ?? null,
          target?.managed_instance_id ?? null,
          target?.managed_generation ?? null,
          target?.target_profile_identity_sha256 ?? null,
          previous,
          command.actor.kind,
          command.actor.principal_ref,
          command.actor.authorization_receipt_ref,
          command.created_at,
        ] as const;
        row = await (trustedAuthorizationExpiry === undefined
          ? statement.bind(...values)
          : statement.bind(...values, trustedAuthorizationExpiry)
        ).first<ManagedTargetAssignmentD1Row>();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const knownCodes: readonly ManagedTargetAssignmentErrorCode[] = [
          "MANAGED_TARGET_ASSIGNMENT_CAS_CONFLICT",
          "MANAGED_TARGET_ASSIGNMENT_PROJECT_AUTHORITY_STALE",
          "MANAGED_TARGET_ASSIGNMENT_OWNER_ACTOR_MISMATCH",
          "MANAGED_TARGET_ASSIGNMENT_ACTIVE_REQUIRES_RETIREMENT",
          "MANAGED_TARGET_ASSIGNMENT_RETIREMENT_STALE",
        ];
        const knownCode = knownCodes.find((code) => message.includes(code));
        throw new ManagedTargetAssignmentError(
          knownCode ?? "MANAGED_TARGET_ASSIGNMENT_OUTCOME_UNKNOWN",
          knownCode === undefined
            ? "assignment append outcome is unknown; reconcile the project event head before retrying"
            : message,
          cause,
        );
      }

      if (row === null && trustedAuthorizationExpiry !== undefined) {
        throw new ManagedTargetAssignmentError(
          "MANAGED_TARGET_ASSIGNMENT_AUTHORIZATION_DENIED",
          "verified owner Access expired before the atomic assignment append",
        );
      }
      if (row === null || !matchesCommand(row, command, target, previous)) {
        throw new ManagedTargetAssignmentError(
          "MANAGED_TARGET_ASSIGNMENT_OUTCOME_UNKNOWN",
          "assignment append readback differs from its authorized command",
        );
      }
      return Object.freeze({ ...command, event_revision: row.event_revision });
    },
    async appendProductDecisionV2(
      input: ManagedSearchProductDecisionCommandV2,
      authorize: ManagedSearchProductDecisionAuthorizer,
    ): Promise<ManagedSearchProductDecisionEventV2> {
      const command = parseManagedSearchProductDecisionCommandV2(input);
      try {
        await authorize(command);
      } catch (cause) {
        throw new ManagedTargetAssignmentError(
          "MANAGED_TARGET_ASSIGNMENT_AUTHORIZATION_DENIED",
          "owner authorization did not admit this product decision",
          cause,
        );
      }

      const target = command.event_kind === "ASSIGN" ? command.target : null;
      const previous = command.event_kind === "RETIRE"
        ? command.previous_assignment_revision
        : null;
      const insertPrefix =
        "INSERT INTO managed_target_assignment_event(" +
        "project_id,event_revision,expected_event_revision,event_kind,project_generation," +
        "project_owner_principal_ref,target_namespace,managed_instance_id,managed_generation," +
        "target_profile_identity_sha256,previous_assignment_revision,actor_kind,actor_principal_ref," +
        "authorization_receipt_ref,created_at,decision_version,selection_mode,product_alias) ";
      const insertValues = trustedAuthorizationExpiry === undefined
        ? "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
        : "SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? " +
          "WHERE julianday(?)>julianday('now') ";
      const insertReturning =
        "RETURNING project_id,event_revision,expected_event_revision,event_kind,project_generation," +
        "project_owner_principal_ref,target_namespace,managed_instance_id,managed_generation," +
        "target_profile_identity_sha256,previous_assignment_revision,actor_kind,actor_principal_ref," +
        "authorization_receipt_ref,created_at,decision_version,selection_mode,product_alias";
      let row: ManagedSearchProductDecisionD1Row | null;
      try {
        const values = [
          command.project_id,
          command.expected_event_revision + 1,
          command.expected_event_revision,
          command.event_kind,
          command.project_generation,
          command.project_owner_principal_ref,
          target?.namespace ?? null,
          target?.managed_instance_id ?? null,
          target?.managed_generation ?? null,
          target?.target_profile_identity_sha256 ?? null,
          previous,
          command.actor.kind,
          command.actor.principal_ref,
          command.actor.authorization_receipt_ref,
          command.created_at,
          command.decision_version,
          command.selection_mode,
          command.product_alias,
        ] as const;
        const statement = database.prepare(insertPrefix + insertValues + insertReturning);
        row = await (trustedAuthorizationExpiry === undefined
          ? statement.bind(...values)
          : statement.bind(...values, trustedAuthorizationExpiry)
        ).first<ManagedSearchProductDecisionD1Row>();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const knownCodes: readonly ManagedTargetAssignmentErrorCode[] = [
          "MANAGED_TARGET_ASSIGNMENT_CAS_CONFLICT",
          "MANAGED_TARGET_ASSIGNMENT_PROJECT_AUTHORITY_STALE",
          "MANAGED_TARGET_ASSIGNMENT_OWNER_ACTOR_MISMATCH",
          "MANAGED_TARGET_ASSIGNMENT_ACTIVE_REQUIRES_RETIREMENT",
          "MANAGED_TARGET_ASSIGNMENT_RETIREMENT_STALE",
        ];
        const knownCode = knownCodes.find((code) => message.includes(code));
        throw new ManagedTargetAssignmentError(
          knownCode ?? "MANAGED_TARGET_ASSIGNMENT_OUTCOME_UNKNOWN",
          knownCode === undefined
            ? "product decision append outcome is unknown; reconcile the current head before retrying"
            : message,
          cause,
        );
      }

      if (row === null && trustedAuthorizationExpiry !== undefined) {
        throw new ManagedTargetAssignmentError(
          "MANAGED_TARGET_ASSIGNMENT_AUTHORIZATION_DENIED",
          "verified owner Access expired before the atomic product decision append",
        );
      }
      if (row === null || !matchesProductDecisionV2(row, command, target, previous)) {
        throw new ManagedTargetAssignmentError(
          "MANAGED_TARGET_ASSIGNMENT_OUTCOME_UNKNOWN",
          "product decision append readback differs from its authorized command",
        );
      }
      return Object.freeze({ ...command, event_revision: row.event_revision });
    },
  });
}

interface ManagedSearchProductDecisionD1Row extends ManagedTargetAssignmentD1Row {
  readonly decision_version: number;
  readonly selection_mode: string;
  readonly product_alias: string;
}

function parseManagedSearchProductDecisionCommandV2(
  input: unknown,
): ManagedSearchProductDecisionCommandV2 {
  const value = record(input, "product decision command");
  exactKeys(value, [
    "event_kind",
    "project_id",
    "project_generation",
    "project_owner_principal_ref",
    "expected_event_revision",
    "actor",
    "created_at",
    "decision_version",
    "selection_mode",
    "product_alias",
    ...(value.event_kind === "ASSIGN" ? ["target"] : ["previous_assignment_revision"]),
  ], "product decision command");
  if (value.decision_version !== 2 ||
      value.selection_mode !== "STABLE_PHYSICAL_PROFILE_V2" ||
      value.product_alias !== "primary") {
    invalid("product decision must use the reviewed V2 primary profile selection");
  }
  const baseInput: Record<string, unknown> = {
    event_kind: value.event_kind,
    project_id: value.project_id,
    project_generation: value.project_generation,
    project_owner_principal_ref: value.project_owner_principal_ref,
    expected_event_revision: value.expected_event_revision,
    actor: value.actor,
    created_at: value.created_at,
    ...(value.event_kind === "ASSIGN"
      ? { target: value.target }
      : { previous_assignment_revision: value.previous_assignment_revision }),
  };
  const parsed = parseManagedTargetAssignmentCommand(baseInput);
  return Object.freeze({
    ...parsed,
    decision_version: 2,
    selection_mode: "STABLE_PHYSICAL_PROFILE_V2",
    product_alias: "primary",
  }) as ManagedSearchProductDecisionCommandV2;
}

function matchesProductDecisionV2(
  row: ManagedSearchProductDecisionD1Row,
  command: ManagedSearchProductDecisionCommandV2,
  target: ManagedTargetIdentity | null,
  previous: number | null,
): boolean {
  return matchesCommand(row, command, target, previous) &&
    row.decision_version === 2 &&
    row.selection_mode === "STABLE_PHYSICAL_PROFILE_V2" &&
    row.product_alias === "primary";
}

function matchesCommand(
  row: ManagedTargetAssignmentD1Row,
  command: ManagedTargetAssignmentCommand,
  target: ManagedTargetIdentity | null,
  previous: number | null,
): boolean {
  return row.project_id === command.project_id &&
    row.event_revision === command.expected_event_revision + 1 &&
    row.expected_event_revision === command.expected_event_revision &&
    row.event_kind === command.event_kind &&
    row.project_generation === command.project_generation &&
    row.project_owner_principal_ref === command.project_owner_principal_ref &&
    row.target_namespace === (target?.namespace ?? null) &&
    row.managed_instance_id === (target?.managed_instance_id ?? null) &&
    row.managed_generation === (target?.managed_generation ?? null) &&
    row.target_profile_identity_sha256 === (target?.target_profile_identity_sha256 ?? null) &&
    row.previous_assignment_revision === previous &&
    row.actor_kind === command.actor.kind &&
    row.actor_principal_ref === command.actor.principal_ref &&
    row.authorization_receipt_ref === command.actor.authorization_receipt_ref &&
    row.created_at === command.created_at;
}

/**
 * Append-only Core authority contract. Assignment writes remain unavailable
 * until the owner/operator Core composition validates and implements this port.
 */
export const MANAGED_TARGET_ASSIGNMENT_PROTOCOL =
  "eliotr.managed-target-assignment.v1" as const;
