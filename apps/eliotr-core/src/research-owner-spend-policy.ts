import { IdentifierSchema, IsoDateTimeSchema } from "@eliotr/contracts";
import type { ScopeAuthorization, EvidenceAccessContext } from "@eliotr/cloudflare-evidence";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  readResearchOwnerSpendPolicyTemplate,
  readResearchModelSpendPolicy,
  type ResearchModelSpendPolicy,
  type ResearchOwnerSpendPolicyTemplate,
} from "@eliotr/cloudflare-research";

export type ResearchOwnerSpendPolicyResolution = Readonly<{
  readonly mode: "legacy" | "template";
  readonly policy: ResearchModelSpendPolicy;
}>;

export interface ResearchOwnerSpendPolicyBindingInput {
  readonly raw: string | undefined;
  readonly provenance: string;
  readonly access: EvidenceAccessContext;
  readonly deployment_generation: string;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly scope_expires_at: string;
  readonly authorization: ScopeAuthorization;
  readonly now_ms?: number;
}

export class ResearchOwnerSpendPolicyError extends Error {
  public readonly code: "INVALID" | "AUTHORITY_STALE";

  public constructor(code: ResearchOwnerSpendPolicyError["code"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchOwnerSpendPolicyError";
    this.code = code;
  }
}

function invalid(message: string, cause?: unknown): never {
  throw new ResearchOwnerSpendPolicyError("INVALID", message, cause);
}

function stale(message: string): never {
  throw new ResearchOwnerSpendPolicyError("AUTHORITY_STALE", message);
}

function dateMs(value: string, label: string): number {
  const parsed = IsoDateTimeSchema.safeParse(value);
  const result = parsed.success ? Date.parse(parsed.data) : Number.NaN;
  if (!Number.isFinite(result)) invalid(`${label} is invalid`);
  return result;
}

function id(value: string, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return parsed.data;
}

function parseJson(raw: string | undefined): unknown {
  if (typeof raw !== "string" || raw.trim() === "" || new TextEncoder().encode(raw).byteLength > 65_536) {
    invalid("installed model spend policy is missing or oversized");
  }
  try { return JSON.parse(raw); }
  catch (cause) { invalid("installed model spend policy is invalid", cause); }
}

function boundTemplate(
  template: ResearchOwnerSpendPolicyTemplate,
  input: ResearchOwnerSpendPolicyBindingInput,
): ResearchModelSpendPolicy {
  const principal = id(input.access.principal_ref, "current owner principal");
  const credential = id(input.access.credential_generation, "current owner credential generation");
  const deployment = id(input.deployment_generation, "current deployment generation");
  const generation = id(input.policy_generation, "current policy generation");
  const authority = id(input.policy_authority_ref, "current policy authority");
  if (input.access.client_class !== "owner_pwa") stale("current client is not the owner application");
  if (template.principal_ref !== principal || template.client_class !== input.access.client_class ||
      template.deployment_generation !== deployment) stale("owner spend template is bound to another owner or deployment");
  if (input.authorization.policy_authority_ref !== authority ||
      !input.authorization.allowed_use.includes("research")) stale("current scope grant does not authorize research");
  id(input.authorization.authorization_receipt_ref, "current authorization receipt");
  const now = input.now_ms ?? Date.now();
  if (!Number.isSafeInteger(now)) invalid("current clock is invalid");
  const expires = Math.min(
    dateMs(template.expires_at, "template expiry"),
    dateMs(input.scope_expires_at, "scope expiry"),
    dateMs(input.authorization.expires_at, "grant expiry"),
  );
  if (!Number.isFinite(expires) || expires <= now) stale("owner spend authority has expired");
  const bound = {
    ...template,
    protocol: "eliotr.research-model-spend-policy.v1" as const,
    credential_generation: credential,
    policy_generation: generation,
    policy_authority_ref: authority,
    expires_at: new Date(expires).toISOString(),
  };
  try {
    return readResearchModelSpendPolicy(canonicalJson(bound), input.provenance);
  } catch (cause) {
    invalid("bound owner spend policy is invalid", cause);
  }
}

/** Resolve the installed policy, binding only the template's session-varying fields to current authority. */
export function resolveResearchOwnerSpendPolicy(
  input: ResearchOwnerSpendPolicyBindingInput,
): ResearchOwnerSpendPolicyResolution {
  const decoded = parseJson(input.raw);
  if (typeof decoded === "object" && decoded !== null &&
      (decoded as { protocol?: unknown }).protocol === "eliotr.research-owner-spend-template.v1") {
    try {
      return Object.freeze({ mode: "template", policy: boundTemplate(
        readResearchOwnerSpendPolicyTemplate(input.raw, input.provenance), input,
      ) });
    } catch (cause) {
      invalid("installed owner spend template is invalid", cause);
    }
  }
  try {
    return Object.freeze({ mode: "legacy", policy: readResearchModelSpendPolicy(input.raw, input.provenance) });
  } catch (cause) {
    invalid("installed model spend policy is invalid", cause);
  }
}
