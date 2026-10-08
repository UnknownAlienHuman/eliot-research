import { z } from "zod";
import { IsoDateTimeSchema, IdentifierSchema } from "@eliotr/contracts";

const PROTOCOL = "eliotr.workspace-owner-bindings.v1" as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MAX_DATE_MS = 8_640_000_000_000_000;

const CanonicalExpirySchema = IsoDateTimeSchema.refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, { message: "expires_at must be canonical UTC milliseconds" });

export const WorkspaceOwnerBindingRuleSchema = z.object({
  owner_principal_ref: IdentifierSchema,
  owner_credential_generation: IdentifierSchema,
  mcp_principal_ref: IdentifierSchema,
  deployment_generation: IdentifierSchema,
  auth_profile: z.enum(["service-token", "managed-oauth"]),
  source_namespace_id: IdentifierSchema,
  expires_at: CanonicalExpirySchema,
  provenance_ref: IdentifierSchema,
}).strict();

export const WorkspaceOwnerBindingsDocumentSchema = z.object({
  protocol: z.literal(PROTOCOL),
  bindings: z.array(WorkspaceOwnerBindingRuleSchema).max(256),
}).strict();

export type WorkspaceOwnerBindingRule = Readonly<z.infer<typeof WorkspaceOwnerBindingRuleSchema>>;
export interface WorkspaceOwnerBindingsDocument {
  readonly protocol: typeof PROTOCOL;
  readonly bindings: readonly WorkspaceOwnerBindingRule[];
}

export interface WorkspaceOwnerAuthorizationInput {
  readonly owner_principal_ref: string;
  readonly owner_credential_generation: string;
  readonly mcp_principal_ref: string;
  readonly deployment_generation: string;
  readonly auth_profile: "service-token" | "managed-oauth";
  readonly source_namespace_id: string;
}

export type WorkspaceOwnerAuthorizationErrorCode =
  | "WORKSPACE_OWNER_BINDINGS_CONFIG_INVALID"
  | "WORKSPACE_OWNER_BINDING_UNAVAILABLE"
  | "WORKSPACE_OWNER_BINDING_AMBIGUOUS"
  | "WORKSPACE_OWNER_BINDING_EXPIRED"
  | "WORKSPACE_OWNER_BINDING_INPUT_INVALID";

export class WorkspaceOwnerAuthorizationError extends Error {
  public readonly code: WorkspaceOwnerAuthorizationErrorCode;
  public readonly status: number;
  public readonly retryable: boolean;

  public constructor(code: WorkspaceOwnerAuthorizationErrorCode, status: number, message: string, retryable: boolean) {
    super(message);
    this.name = "WorkspaceOwnerAuthorizationError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface WorkspaceOwnerAuthorization {
  readonly assertCurrent: (input: WorkspaceOwnerAuthorizationInput, nowMs: number) => WorkspaceOwnerBindingRule;
}

function configInvalid(): never {
  throw new WorkspaceOwnerAuthorizationError(
    "WORKSPACE_OWNER_BINDINGS_CONFIG_INVALID", 503,
    "workspace owner binding configuration is invalid", true,
  );
}

function inputInvalid(): never {
  throw new WorkspaceOwnerAuthorizationError(
    "WORKSPACE_OWNER_BINDING_INPUT_INVALID", 503,
    "workspace owner binding input is invalid", true,
  );
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validNow(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS;
}

function bindingKey(rule: WorkspaceOwnerBindingRule): string {
  return [rule.owner_principal_ref, rule.owner_credential_generation, rule.mcp_principal_ref,
    rule.deployment_generation, rule.auth_profile, rule.source_namespace_id].join("\u0000");
}

function freezeDocument(document: z.infer<typeof WorkspaceOwnerBindingsDocumentSchema>): WorkspaceOwnerBindingsDocument {
  const rules = document.bindings.map((rule) => Object.freeze({ ...rule }));
  return Object.freeze({ protocol: PROTOCOL, bindings: Object.freeze(rules) });
}

export function createWorkspaceOwnerAuthorization(document: WorkspaceOwnerBindingsDocument): WorkspaceOwnerAuthorization {
  const checked = WorkspaceOwnerBindingsDocumentSchema.safeParse(document);
  if (!checked.success) configInvalid();
  const frozen = freezeDocument(checked.data);
  const keys = new Set<string>();
  for (const rule of frozen.bindings) {
    if (keys.has(bindingKey(rule))) {
      throw new WorkspaceOwnerAuthorizationError(
        "WORKSPACE_OWNER_BINDINGS_CONFIG_INVALID", 503,
        "workspace owner binding configuration is ambiguous", true,
      );
    }
    keys.add(bindingKey(rule));
  }
  return Object.freeze({
    assertCurrent(input: WorkspaceOwnerAuthorizationInput, nowMs: number): WorkspaceOwnerBindingRule {
      if (!validNow(nowMs) || !validIdentifier(input.owner_principal_ref) ||
          !validIdentifier(input.owner_credential_generation) || !validIdentifier(input.mcp_principal_ref) ||
          !validIdentifier(input.deployment_generation) ||
          (input.auth_profile !== "service-token" && input.auth_profile !== "managed-oauth") ||
          !validIdentifier(input.source_namespace_id)) inputInvalid();
      const matches = frozen.bindings.filter((rule) =>
        rule.owner_principal_ref === input.owner_principal_ref &&
        rule.owner_credential_generation === input.owner_credential_generation &&
        rule.mcp_principal_ref === input.mcp_principal_ref &&
        rule.deployment_generation === input.deployment_generation &&
        rule.auth_profile === input.auth_profile &&
        rule.source_namespace_id === input.source_namespace_id);
      if (matches.length === 0) {
        throw new WorkspaceOwnerAuthorizationError(
          "WORKSPACE_OWNER_BINDING_UNAVAILABLE", 503,
          "workspace owner binding is not installed", true,
        );
      }
      const rule = matches[0];
      if (rule === undefined) inputInvalid();
      if (matches.length !== 1) {
        throw new WorkspaceOwnerAuthorizationError(
          "WORKSPACE_OWNER_BINDING_AMBIGUOUS", 503,
          "workspace owner binding is ambiguous", true,
        );
      }
      if (Date.parse(rule.expires_at) <= nowMs) {
        throw new WorkspaceOwnerAuthorizationError(
          "WORKSPACE_OWNER_BINDING_EXPIRED", 409,
          "workspace owner binding has expired", false,
        );
      }
      return rule;
    },
  });
}

export function parseWorkspaceOwnerBindings(raw: string | undefined): WorkspaceOwnerAuthorization | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let decoded: unknown;
  try { decoded = JSON.parse(raw) as unknown; } catch { configInvalid(); }
  const parsed = WorkspaceOwnerBindingsDocumentSchema.safeParse(decoded);
  if (!parsed.success) configInvalid();
  return createWorkspaceOwnerAuthorization(parsed.data);
}
