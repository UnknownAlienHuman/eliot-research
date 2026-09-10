import {
  AllowedReferenceManifestSchema,
  type AllowedReferenceManifest,
  type ResolvedEvidence,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  type CloudflareEvidenceResolver,
  type EvidenceSourceAuthority,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import {
  createEvidenceContextCompiler,
  type CompiledEvidenceContext,
  type ReferenceManifestStore,
} from "@eliotr/policy";
import { evidenceSha256 } from "@eliotr/cloudflare-evidence";
import type { ModelCallInput } from "@eliotr/research";

export type ResearchEvidencePack = ModelCallInput["evidence_pack"];

const SHA256 = /^[a-f0-9]{64}$/u;

export type ReferenceManifestErrorCode =
  | "REFERENCE_MANIFEST_INPUT_INVALID"
  | "REFERENCE_MANIFEST_SCOPE_STALE"
  | "REFERENCE_MANIFEST_EVIDENCE_INVALID"
  | "REFERENCE_MANIFEST_POLICY_INVALID"
  | "REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN";

export class ReferenceManifestError extends Error {
  public readonly code: ReferenceManifestErrorCode;
  public readonly retryable: boolean;

  public constructor(code: ReferenceManifestErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ReferenceManifestError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ReferenceManifestPolicyProfile {
  readonly allowed_tool_definition_refs: readonly string[];
  readonly allowed_verifier_refs: readonly string[];
  readonly permitted_anchor_and_precision_ceilings: readonly string[];
  readonly provider_and_policy_generations: Readonly<Record<string, string>>;
  readonly stale_or_revoked_entries?: readonly string[];
  readonly permitted_acquisition_or_expansion_routes: readonly string[];
  readonly disclosure_ceiling: string;
  readonly allowed_use: readonly string[];
  readonly expires_at: string;
}

export interface BuildReferenceManifestInput {
  readonly evidence_pack: ResearchEvidencePack;
  readonly navigation: NavigationReadAuthority;
  readonly resolver: CloudflareEvidenceResolver;
  readonly policy: ReferenceManifestPolicyProfile;
  readonly manifest_ref: VersionedRef;
  readonly model_route_ref: string;
  readonly max_context_bytes: number;
}

export interface BuiltReferenceManifest {
  readonly manifest: AllowedReferenceManifest;
  readonly compiled: CompiledEvidenceContext;
  readonly resolved_evidence: readonly ResolvedEvidence[];
  readonly source_authorities: readonly EvidenceSourceAuthority[];
}

function fail(code: ReferenceManifestErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new ReferenceManifestError(code, message, retryable, cause);
}

function assertText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("REFERENCE_MANIFEST_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function exactIso(value: string, label: string): number {
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || new Date(time).toISOString() !== value) {
    fail("REFERENCE_MANIFEST_POLICY_INVALID", `${label} is not canonical ISO-8601`);
  }
  return time;
}

function sortedUnique(values: readonly string[], label: string): string[] {
  const checked = values.map((value) => assertText(value, label));
  if (new Set(checked).size !== checked.length) fail("REFERENCE_MANIFEST_POLICY_INVALID", `${label} contains duplicates`);
  return checked.sort();
}

function sourceBinding(source: EvidenceSourceAuthority): string {
  return canonicalEvidenceJson({
    source_revision_ref: source.source_revision_ref,
    source_owner_generation: source.source_owner_generation,
    content_sha256: source.content_sha256,
    object_residency_key_digest: source.object_residency_key_digest,
    admission_receipt_ref: source.admission_receipt_ref,
  });
}

function evidenceBinding(evidence: ResolvedEvidence): string {
  return canonicalEvidenceJson({
    handle: evidence.handle,
    exact_excerpt: evidence.exact_excerpt,
    source_revision_content_sha256: evidence.source_revision_content_sha256,
    scope_snapshot_digest: evidence.scope_snapshot_digest,
    authorization_receipt_ref: evidence.authorization_receipt_ref,
    credential_generation: evidence.credential_generation,
    instruction_taint: evidence.instruction_taint,
    allowed_effects: evidence.allowed_effects,
  });
}

function compareAuthoritativeEvidence(requested: ResolvedEvidence, authoritative: ResolvedEvidence): void {
  if (evidenceBinding(requested) !== evidenceBinding(authoritative)) {
    fail("REFERENCE_MANIFEST_EVIDENCE_INVALID", "held EvidencePack differs from authoritative handle readback");
  }
  if (authoritative.handle.terminal_state !== "LIVE" || authoritative.handle.source_revision_ref.length === 0) {
    fail("REFERENCE_MANIFEST_EVIDENCE_INVALID", "authoritative evidence handle is not LIVE");
  }
}

function minExpiry(values: readonly string[]): string {
  const times = values.map((value, index) => exactIso(value, `expiry[${index}]`));
  const minimum = Math.min(...times);
  if (!Number.isSafeInteger(minimum)) fail("REFERENCE_MANIFEST_POLICY_INVALID", "expiry authority is invalid");
  return new Date(minimum).toISOString();
}

function buildManifest(
  input: BuildReferenceManifestInput,
  grant: Awaited<ReturnType<NavigationReadAuthority["current"]>>,
  resolved: readonly ResolvedEvidence[],
  sources: readonly EvidenceSourceAuthority[],
): AllowedReferenceManifest {
  const scope = input.navigation.scope;
  const sourceRefs = sortedUnique(resolved.map((item) => item.handle.source_revision_ref), "source references");
  const handleRefs = [...new Set(resolved.map((item) => refKey(item.handle.handle_ref)))].sort();
  if (handleRefs.length !== resolved.length) fail("REFERENCE_MANIFEST_EVIDENCE_INVALID", "held EvidencePack repeats an evidence handle");
  const sourceByRef = new Map(sources.map((source) => [source.source_revision_ref, source]));
  for (const evidence of resolved) {
    const source = sourceByRef.get(evidence.handle.source_revision_ref);
    if (source === undefined || source.content_sha256 !== evidence.source_revision_content_sha256 ||
        source.object_residency_key_digest !== evidence.handle.object_residency_key_digest ||
        source.source_owner_generation !== evidence.handle.source_owner_generation) {
      fail("REFERENCE_MANIFEST_EVIDENCE_INVALID", "evidence handle is not bound to current source authority");
    }
  }
  const allowedUse = sortedUnique(
    input.policy.allowed_use.filter((use) => grant.allowed_use.includes(use) && sources.every((source) => source.allowed_use.includes(use))),
    "allowed use",
  );
  if (allowedUse.length === 0) fail("REFERENCE_MANIFEST_POLICY_INVALID", "policy and source authorities have no allowed-use intersection");
  if (input.policy.disclosure_ceiling !== grant.disclosure_ceiling ||
      sources.some((source) => source.disclosure_ceiling !== grant.disclosure_ceiling)) {
    fail("REFERENCE_MANIFEST_POLICY_INVALID", "disclosure ceiling differs from current authority");
  }
  const expiryValues = [scope.expires_at, grant.expires_at, input.policy.expires_at];
  for (const source of sources) if (source.admission_expires_at !== undefined) expiryValues.push(source.admission_expires_at);
  const manifestWithoutDigest = {
    manifest_ref: input.manifest_ref,
    scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
    allowed_source_revision_refs: sourceRefs,
    allowed_evidence_handle_refs: resolved.map((item) => item.handle.handle_ref).sort((left, right) => refKey(left).localeCompare(refKey(right))),
    allowed_tool_definition_refs: sortedUnique(input.policy.allowed_tool_definition_refs, "tool references"),
    allowed_verifier_refs: sortedUnique(input.policy.allowed_verifier_refs, "verifier references"),
    permitted_anchor_and_precision_ceilings: sortedUnique(input.policy.permitted_anchor_and_precision_ceilings, "precision ceilings"),
    provider_and_policy_generations: Object.fromEntries(Object.entries(input.policy.provider_and_policy_generations).sort(([left], [right]) => left.localeCompare(right))),
    stale_or_revoked_entries: sortedUnique(input.policy.stale_or_revoked_entries ?? [], "stale or revoked entries"),
    permitted_acquisition_or_expansion_routes: sortedUnique(input.policy.permitted_acquisition_or_expansion_routes, "acquisition routes"),
    disclosure_ceiling: grant.disclosure_ceiling,
    allowed_use: allowedUse,
    expires_at: minExpiry(expiryValues),
    client_fence_ref: input.navigation.access.credential_generation,
  } satisfies Omit<AllowedReferenceManifest, "manifest_digest">;
  return AllowedReferenceManifestSchema.parse({
    ...manifestWithoutDigest,
    manifest_digest: "0".repeat(64),
  });
}

export async function buildAllowedReferenceManifest(input: BuildReferenceManifestInput): Promise<BuiltReferenceManifest> {
  if (input.evidence_pack.scope_snapshot_ref.id !== input.navigation.scope.snapshot_id ||
      input.evidence_pack.scope_snapshot_ref.revision !== input.navigation.scope.revision) {
    fail("REFERENCE_MANIFEST_SCOPE_STALE", "EvidencePack is bound to another ScopeSnapshot");
  }
  assertText(input.model_route_ref, "model route reference");
  if (!Number.isSafeInteger(input.max_context_bytes) || input.max_context_bytes < 1) {
    fail("REFERENCE_MANIFEST_INPUT_INVALID", "context byte budget is invalid");
  }
  const initialGrant = await input.navigation.current();
  const requested = [...input.evidence_pack.resolved_evidence];
  if (requested.length > 512) fail("REFERENCE_MANIFEST_INPUT_INVALID", "EvidencePack exceeds the handle bound");
  const refs = [...new Set(requested.map((item) => item.handle.source_revision_ref))];
  if (new Set(requested.map((item) => refKey(item.handle.handle_ref))).size !== requested.length) {
    fail("REFERENCE_MANIFEST_EVIDENCE_INVALID", "EvidencePack contains duplicate handles");
  }
  const initialSources = await input.navigation.sources(refs, initialGrant);
  const authoritative: ResolvedEvidence[] = [];
  for (const evidence of requested) {
    const value = await input.resolver.resolveHandle({
      handle_ref: evidence.handle.handle_ref,
      expected_scope_snapshot_ref: input.evidence_pack.scope_snapshot_ref,
      access: input.navigation.access,
    });
    compareAuthoritativeEvidence(evidence, value);
    authoritative.push(value);
  }
  const finalGrant = await input.navigation.current();
  const finalSources = await input.navigation.sources(refs, finalGrant);
  if (canonicalEvidenceJson(initialGrant) !== canonicalEvidenceJson(finalGrant) ||
      canonicalEvidenceJson(initialSources.map(sourceBinding)) !== canonicalEvidenceJson(finalSources.map(sourceBinding))) {
    fail("REFERENCE_MANIFEST_SCOPE_STALE", "scope or source authority changed during evidence readback");
  }
  const manifestWithPlaceholder = buildManifest(input, finalGrant, authoritative, finalSources);
  const { manifest_digest: _placeholder, ...digestPayload } = manifestWithPlaceholder;
  const digest = await evidenceSha256(digestPayload);
  if (!SHA256.test(digest)) fail("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "manifest digest computation failed", true);
  const manifest = AllowedReferenceManifestSchema.parse({ ...digestPayload, manifest_digest: digest });
  const compiled = await createEvidenceContextCompiler().compile({
    manifest,
    evidence: authoritative,
    modelRouteRef: input.model_route_ref,
    maxBytes: input.max_context_bytes,
  });
  return { manifest, compiled, resolved_evidence: authoritative, source_authorities: finalSources };
}

export interface ResearchReferenceManifestService {
  build(input: Omit<BuildReferenceManifestInput, "resolver"> & { readonly resolver?: CloudflareEvidenceResolver }): Promise<BuiltReferenceManifest>;
  persist(manifest: AllowedReferenceManifest): Promise<VersionedRef>;
}

export function createResearchReferenceManifestService(input: {
  readonly navigation: NavigationReadAuthority;
  readonly resolver?: CloudflareEvidenceResolver;
  readonly store: ReferenceManifestStore;
}): ResearchReferenceManifestService {
  return {
    build: (request) => buildAllowedReferenceManifest({ ...request, navigation: input.navigation, resolver: request.resolver ?? input.resolver ?? fail("REFERENCE_MANIFEST_INPUT_INVALID", "evidence resolver is required") }),
    async persist(manifest) {
      return input.store.put(manifest);
    },
  };
}
