import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  type VersionedRef,
} from "@eliotr/contracts";

const PROTOCOL = "eliotr.namespace-bootstrap-profiles.v1" as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MAX_PROFILES = 16;

const Identifier = IdentifierSchema.regex(IDENTIFIER);
const VersionedRefInputSchema = z.object({
  id: Identifier,
  revision: z.number().int().positive().refine(Number.isSafeInteger),
}).strict();
const CanonicalTimeSchema = IsoDateTimeSchema.refine((value) => {
  const parsed = Date.parse(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isSafeInteger(parsed) &&
    new Date(parsed).toISOString() === value;
}, { message: "timestamp must be canonical UTC milliseconds" });
const IdentifierListSchema = z.array(Identifier)
  .min(1)
  .max(16)
  .refine((values) => new Set(values).size === values.length, { message: "identifiers must be unique" });
const TitleSchema = z.string()
  .min(1)
  .max(120)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));

const SourceAdmissionPolicySchema = z.object({
  allowed_ownership_modes: z.tuple([z.literal("immutable_import")]),
  source_class: Identifier,
  assurance_ceiling: z.enum(["LOCATOR_ONLY", "CAPTURED", "QUALIFIED"]),
  instruction_taint: z.literal("DATA_ONLY"),
  allowed_effects: z.literal("READ_ONLY"),
  allowed_use: IdentifierListSchema,
  disclosure_ceiling: Identifier,
  license_policy_ref: Identifier,
  default_storage_policy: z.literal("NORMALIZED_CLOUD_ONLY"),
  default_residency_profile_id: Identifier,
  default_retention_policy_id: Identifier,
  minimum_quality_state: z.enum(["high_fidelity", "standard", "degraded"]),
}).strict();

const OwnerReadScopeSchema = z.object({
  allowed_use: IdentifierListSchema.refine((values) => values.includes("research"), {
    message: "owner read scope must include research",
  }),
  disclosure_ceiling: Identifier,
  expires_at: CanonicalTimeSchema,
}).strict();

const ErasureAdmissionPolicySchema = z.object({
  permission_profile_ref: VersionedRefInputSchema,
  authorization_binding_ref: Identifier,
  legal_basis_ref: Identifier,
  valid_from: CanonicalTimeSchema,
  expires_at: CanonicalTimeSchema,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expires_at) <= Date.parse(value.valid_from)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "erasure permission expiry must follow valid-from" });
  }
});

const ProfileSchema = z.object({
  profile_ref: VersionedRefInputSchema,
  title: TitleSchema,
  principal_ref: Identifier,
  credential_generation: Identifier,
  expires_at: CanonicalTimeSchema,
  provenance_ref: Identifier,
  policy: SourceAdmissionPolicySchema,
  owner_read_scope: OwnerReadScopeSchema,
  erasure_admission_policy: ErasureAdmissionPolicySchema.optional(),
}).strict().superRefine((profile, ctx) => {
  if (profile.erasure_admission_policy !== undefined &&
      Date.parse(profile.erasure_admission_policy.expires_at) > Date.parse(profile.expires_at)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "erasure permission must expire within its bootstrap profile" });
  }
});

const DocumentSchema = z.object({
  protocol: z.literal(PROTOCOL),
  profiles: z.array(ProfileSchema).max(MAX_PROFILES),
}).strict();

type ParsedPolicy = z.infer<typeof SourceAdmissionPolicySchema>;
type ParsedOwnerReadScope = z.infer<typeof OwnerReadScopeSchema>;
type ParsedErasureAdmissionPolicy = z.infer<typeof ErasureAdmissionPolicySchema>;

export interface NamespaceBootstrapProfilePolicy {
  readonly allowed_ownership_modes: readonly ["immutable_import"];
  readonly source_class: string;
  readonly assurance_ceiling: "LOCATOR_ONLY" | "CAPTURED" | "QUALIFIED";
  readonly instruction_taint: "DATA_ONLY";
  readonly allowed_effects: "READ_ONLY";
  readonly allowed_use: readonly string[];
  readonly disclosure_ceiling: string;
  readonly license_policy_ref: string;
  readonly default_storage_policy: "NORMALIZED_CLOUD_ONLY";
  readonly default_residency_profile_id: string;
  readonly default_retention_policy_id: string;
  readonly minimum_quality_state: "high_fidelity" | "standard" | "degraded";
}

export interface NamespaceBootstrapOwnerReadScope {
  readonly allowed_use: readonly string[];
  readonly disclosure_ceiling: string;
  readonly expires_at: string;
}

export interface NamespaceBootstrapErasureAdmissionPolicy {
  readonly permission_profile_ref: VersionedRef;
  readonly authorization_binding_ref: string;
  readonly legal_basis_ref: string;
  readonly valid_from: string;
  readonly expires_at: string;
}

export interface NamespaceBootstrapProfile {
  readonly profile_ref: VersionedRef;
  readonly title: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly expires_at: string;
  readonly provenance_ref: string;
  readonly policy: NamespaceBootstrapProfilePolicy;
  readonly owner_read_scope: NamespaceBootstrapOwnerReadScope;
  readonly erasure_admission_policy?: NamespaceBootstrapErasureAdmissionPolicy;
}

export interface NamespaceBootstrapProfileContext {
  readonly principal_ref: string;
  readonly credential_generation: string;
}

export interface NamespaceBootstrapProfileSummary {
  readonly profile_ref: VersionedRef;
  readonly title: string;
}

export type NamespaceBootstrapProfileErrorCode =
  | "NAMESPACE_BOOTSTRAP_PROFILES_CONFIG_INVALID"
  | "NAMESPACE_BOOTSTRAP_PROFILE_INPUT_INVALID"
  | "NAMESPACE_BOOTSTRAP_PROFILE_UNAVAILABLE"
  | "NAMESPACE_BOOTSTRAP_PROFILE_FORBIDDEN"
  | "NAMESPACE_BOOTSTRAP_PROFILE_EXPIRED";

export class NamespaceBootstrapProfileError extends Error {
  public readonly code: NamespaceBootstrapProfileErrorCode;
  public readonly status: number;
  public readonly retryable: boolean;

  public constructor(
    code: NamespaceBootstrapProfileErrorCode,
    status: number,
    message: string,
    retryable: boolean,
  ) {
    super(message);
    this.name = "NamespaceBootstrapProfileError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface NamespaceBootstrapProfileReader {
  readonly listCurrent: (
    context: NamespaceBootstrapProfileContext,
    nowMs: number,
  ) => readonly NamespaceBootstrapProfileSummary[];
  readonly requireCurrent: (
    context: NamespaceBootstrapProfileContext,
    profileRef: VersionedRef,
    nowMs: number,
  ) => NamespaceBootstrapProfile;
}

function fail(
  code: NamespaceBootstrapProfileErrorCode,
  status: number,
  message: string,
  retryable: boolean,
): never {
  throw new NamespaceBootstrapProfileError(code, status, message, retryable);
}

function configInvalid(): never {
  return fail(
    "NAMESPACE_BOOTSTRAP_PROFILES_CONFIG_INVALID",
    503,
    "namespace bootstrap profile configuration is invalid",
    true,
  );
}

function inputInvalid(): never {
  return fail(
    "NAMESPACE_BOOTSTRAP_PROFILE_INPUT_INVALID",
    503,
    "namespace bootstrap profile request context is invalid",
    true,
  );
}

function unavailable(): never {
  return fail(
    "NAMESPACE_BOOTSTRAP_PROFILE_UNAVAILABLE",
    503,
    "namespace bootstrap profile is not installed",
    true,
  );
}

function forbidden(): never {
  return fail(
    "NAMESPACE_BOOTSTRAP_PROFILE_FORBIDDEN",
    403,
    "namespace bootstrap profile is not assigned to this caller",
    false,
  );
}

function expired(): never {
  return fail(
    "NAMESPACE_BOOTSTRAP_PROFILE_EXPIRED",
    409,
    "namespace bootstrap profile is expired",
    false,
  );
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function contextSnapshot(context: unknown): NamespaceBootstrapProfileContext {
  if (context === null || typeof context !== "object") inputInvalid();
  const value = context as { readonly principal_ref?: unknown; readonly credential_generation?: unknown };
  if (!validIdentifier(value.principal_ref) || !validIdentifier(value.credential_generation)) inputInvalid();
  return Object.freeze({
    principal_ref: value.principal_ref,
    credential_generation: value.credential_generation,
  });
}

function validNow(nowMs: unknown): nowMs is number {
  return typeof nowMs === "number" && Number.isSafeInteger(nowMs) && nowMs >= 0;
}

function nowSnapshot(nowMs: unknown): number {
  if (!validNow(nowMs)) inputInvalid();
  return nowMs;
}

function profileRefSnapshot(profileRef: unknown): VersionedRef {
  const parsed = VersionedRefInputSchema.safeParse(profileRef);
  if (!parsed.success) inputInvalid();
  return Object.freeze({ id: parsed.data.id, revision: parsed.data.revision });
}

function refKey(profileRef: VersionedRef): string {
  return profileRef.id + "\u0000" + String(profileRef.revision);
}

function freezePolicy(policy: ParsedPolicy): NamespaceBootstrapProfilePolicy {
  return Object.freeze({
    allowed_ownership_modes: Object.freeze(["immutable_import"] as const),
    source_class: policy.source_class,
    assurance_ceiling: policy.assurance_ceiling,
    instruction_taint: "DATA_ONLY" as const,
    allowed_effects: "READ_ONLY" as const,
    allowed_use: Object.freeze([...policy.allowed_use]),
    disclosure_ceiling: policy.disclosure_ceiling,
    license_policy_ref: policy.license_policy_ref,
    default_storage_policy: "NORMALIZED_CLOUD_ONLY" as const,
    default_residency_profile_id: policy.default_residency_profile_id,
    default_retention_policy_id: policy.default_retention_policy_id,
    minimum_quality_state: policy.minimum_quality_state,
  });
}

function freezeOwnerReadScope(scope: ParsedOwnerReadScope): NamespaceBootstrapOwnerReadScope {
  return Object.freeze({
    allowed_use: Object.freeze([...scope.allowed_use]),
    disclosure_ceiling: scope.disclosure_ceiling,
    expires_at: scope.expires_at,
  });
}

function freezeErasureAdmissionPolicy(policy: ParsedErasureAdmissionPolicy): NamespaceBootstrapErasureAdmissionPolicy {
  return Object.freeze({
    permission_profile_ref: Object.freeze({ id: policy.permission_profile_ref.id, revision: policy.permission_profile_ref.revision }),
    authorization_binding_ref: policy.authorization_binding_ref,
    legal_basis_ref: policy.legal_basis_ref,
    valid_from: policy.valid_from,
    expires_at: policy.expires_at,
  });
}

function freezeProfile(profile: z.infer<typeof ProfileSchema>): NamespaceBootstrapProfile {
  return Object.freeze({
    profile_ref: Object.freeze({
      id: profile.profile_ref.id,
      revision: profile.profile_ref.revision,
    }),
    title: profile.title,
    principal_ref: profile.principal_ref,
    credential_generation: profile.credential_generation,
    expires_at: profile.expires_at,
    provenance_ref: profile.provenance_ref,
    policy: freezePolicy(profile.policy),
    owner_read_scope: freezeOwnerReadScope(profile.owner_read_scope),
    ...(profile.erasure_admission_policy === undefined ? {} : {
      erasure_admission_policy: freezeErasureAdmissionPolicy(profile.erasure_admission_policy),
    }),
  });
}

function erasurePermissionCurrent(profile: NamespaceBootstrapProfile, nowMs: number): boolean {
  const permission = profile.erasure_admission_policy;
  return permission === undefined ||
    (Date.parse(permission.valid_from) <= nowMs && Date.parse(permission.expires_at) > nowMs);
}

function readCurrentProfile(
  profile: NamespaceBootstrapProfile,
  context: NamespaceBootstrapProfileContext,
  nowMs: number,
): NamespaceBootstrapProfile {
  if (profile.principal_ref !== context.principal_ref ||
      profile.credential_generation !== context.credential_generation) forbidden();
  if (Date.parse(profile.expires_at) <= nowMs ||
      Date.parse(profile.owner_read_scope.expires_at) <= nowMs || !erasurePermissionCurrent(profile, nowMs)) expired();
  return profile;
}

function createReader(profiles: readonly NamespaceBootstrapProfile[]): NamespaceBootstrapProfileReader {
  const frozenProfiles = Object.freeze([...profiles]);
  return Object.freeze({
    listCurrent(context: NamespaceBootstrapProfileContext, nowMs: number): readonly NamespaceBootstrapProfileSummary[] {
      const snapshot = contextSnapshot(context);
      const currentNow = nowSnapshot(nowMs);
      return Object.freeze(frozenProfiles
        .filter((profile) =>
          profile.principal_ref === snapshot.principal_ref &&
          profile.credential_generation === snapshot.credential_generation &&
          Date.parse(profile.expires_at) > currentNow &&
          Date.parse(profile.owner_read_scope.expires_at) > currentNow && erasurePermissionCurrent(profile, currentNow))
        .map((profile) => Object.freeze({
          profile_ref: Object.freeze({
            id: profile.profile_ref.id,
            revision: profile.profile_ref.revision,
          }),
          title: profile.title,
        })));
    },
    requireCurrent(
      context: NamespaceBootstrapProfileContext,
      profileRef: VersionedRef,
      nowMs: number,
    ): NamespaceBootstrapProfile {
      const snapshot = contextSnapshot(context);
      const currentNow = nowSnapshot(nowMs);
      const requested = profileRefSnapshot(profileRef);
      const profile = frozenProfiles.find((candidate) => refKey(candidate.profile_ref) === refKey(requested));
      if (profile === undefined) unavailable();
      return readCurrentProfile(profile, snapshot, currentNow);
    },
  });
}

export function parseNamespaceBootstrapProfiles(raw?: string): NamespaceBootstrapProfileReader {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return createReader([]);
  }
  if (typeof raw !== "string") configInvalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    configInvalid();
  }
  const parsed = DocumentSchema.safeParse(decoded);
  if (!parsed.success) configInvalid();
  const seen = new Set<string>();
  const profiles: NamespaceBootstrapProfile[] = [];
  for (const profile of parsed.data.profiles) {
    const key = refKey(profile.profile_ref);
    if (seen.has(key)) configInvalid();
    seen.add(key);
    if (Date.parse(profile.owner_read_scope.expires_at) > Date.parse(profile.expires_at) ||
        profile.owner_read_scope.disclosure_ceiling !== profile.policy.disclosure_ceiling ||
        !profile.policy.allowed_use.includes("research") ||
        profile.policy.allowed_use.some((use) => !profile.owner_read_scope.allowed_use.includes(use))) {
      configInvalid();
    }
    profiles.push(freezeProfile(profile));
  }
  return createReader(profiles);
}

export { PROTOCOL as NAMESPACE_BOOTSTRAP_PROFILES_PROTOCOL };
