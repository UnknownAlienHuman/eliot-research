import {
  EvidenceFreezeSchema,
  VersionedRefSchema,
  type AllowedReferenceManifest,
  type EvidenceFreeze,
  type ResolvedEvidence,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  type CloudflareEvidenceResolver,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import type { ReferenceManifestStore } from "@eliotr/policy";
import type { StageRequest, WorkflowPrincipal, WorkflowStageHandler } from "./types.js";

const INPUT_PROTOCOL = "eliotr.evidence-freeze-input.v1" as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export interface EvidenceFreezeStageInput {
  readonly protocol: typeof INPUT_PROTOCOL;
  readonly freeze_ref: VersionedRef;
  readonly manifest_ref: VersionedRef;
  readonly coverage_denominator_ref: VersionedRef;
}

/**
 * This port is server-owned. It must read the persisted W1 investigation and
 * denominator authority; values supplied by a request or browser are not
 * accepted as generation, scope or coverage proof.
 */
export interface EvidenceFreezeAuthorityBinding {
  readonly scope_snapshot_ref: VersionedRef;
  readonly coverage_denominator_ref: VersionedRef;
  readonly contract_protocol_digest: string;
  readonly lane_digest: string;
  readonly excluded_evidence: readonly { evidence_ref: string; reason: string }[];
  readonly unresolved_contradiction_refs: readonly string[];
  readonly open_research_debt_refs: readonly VersionedRef[];
  readonly provider_model_prompt_tool_generations: Readonly<Record<string, string>>;
}

export interface EvidenceFreezeAuthorityPort {
  /** Resolve exact persisted W1/stage/denominator bindings for this request. */
  read(input: {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly stage_input: EvidenceFreezeStageInput;
    readonly manifest: AllowedReferenceManifest;
  }): Promise<EvidenceFreezeAuthorityBinding>;
}

export interface EvidenceFreezeStageDependencies {
  readonly navigation: NavigationReadAuthority;
  readonly manifest_store: ReferenceManifestStore;
  readonly resolver: CloudflareEvidenceResolver;
  readonly authority: EvidenceFreezeAuthorityPort;
}

export type EvidenceFreezeStageErrorCode =
  | "EVIDENCE_FREEZE_INPUT_INVALID"
  | "EVIDENCE_FREEZE_SCOPE_STALE"
  | "EVIDENCE_FREEZE_EVIDENCE_INVALID"
  | "EVIDENCE_FREEZE_AUTHORITY_INVALID"
  | "EVIDENCE_FREEZE_SETTLEMENT_UNCERTAIN";

export class EvidenceFreezeStageError extends Error {
  public readonly retryable: boolean;

  public constructor(
    public readonly code: EvidenceFreezeStageErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EvidenceFreezeStageError";
    this.retryable = retryable;
  }
}

function fail(
  code: EvidenceFreezeStageErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new EvidenceFreezeStageError(code, message, retryable, cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseInput(bytes: Uint8Array): EvidenceFreezeStageInput {
  if (bytes.byteLength > 64 * 1024) fail("EVIDENCE_FREEZE_INPUT_INVALID", "freeze input exceeds the receipt bound");
  let raw: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    raw = JSON.parse(text);
    if (canonicalEvidenceJson(raw) !== text) fail("EVIDENCE_FREEZE_INPUT_INVALID", "freeze input is not canonical");
  } catch (cause) {
    if (cause instanceof EvidenceFreezeStageError) throw cause;
    fail("EVIDENCE_FREEZE_INPUT_INVALID", "freeze input is not valid JSON", false, cause);
  }
  if (!isRecord(raw) || Object.keys(raw).length !== 4 || raw.protocol !== INPUT_PROTOCOL) {
    fail("EVIDENCE_FREEZE_INPUT_INVALID", "freeze input shape is invalid");
  }
  let freezeRef: VersionedRef;
  let manifestRef: VersionedRef;
  let denominatorRef: VersionedRef;
  try {
    freezeRef = VersionedRefSchema.parse(raw.freeze_ref);
    manifestRef = VersionedRefSchema.parse(raw.manifest_ref);
    denominatorRef = VersionedRefSchema.parse(raw.coverage_denominator_ref);
  } catch (cause) {
    fail("EVIDENCE_FREEZE_INPUT_INVALID", "freeze or manifest reference is invalid", false, cause);
  }
  return Object.freeze({ protocol: INPUT_PROTOCOL, freeze_ref: freezeRef, manifest_ref: manifestRef, coverage_denominator_ref: denominatorRef });
}

function refKey(value: VersionedRef): string {
  return `${value.id}:${value.revision}`;
}

function validateSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("EVIDENCE_FREEZE_AUTHORITY_INVALID", `${label} is invalid`);
  return value;
}

function validateId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) fail("EVIDENCE_FREEZE_AUTHORITY_INVALID", `${label} is invalid`);
  return value;
}

function validateAuthority(
  value: EvidenceFreezeAuthorityBinding,
  input: EvidenceFreezeStageInput,
  scope: NavigationReadAuthority["scope"],
): EvidenceFreezeAuthorityBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("EVIDENCE_FREEZE_AUTHORITY_INVALID", "freeze authority readback is malformed");
  }
  let snapshot: EvidenceFreezeAuthorityBinding;
  try { snapshot = JSON.parse(canonicalEvidenceJson(value)) as EvidenceFreezeAuthorityBinding; }
  catch (cause) { fail("EVIDENCE_FREEZE_AUTHORITY_INVALID", "freeze authority readback is not canonical", false, cause); }
  const authorityKeys = ["scope_snapshot_ref", "coverage_denominator_ref", "contract_protocol_digest", "lane_digest",
    "excluded_evidence", "unresolved_contradiction_refs", "open_research_debt_refs",
    "provider_model_prompt_tool_generations"];
  if (Object.keys(snapshot).length !== authorityKeys.length || authorityKeys.some((key) => !Object.hasOwn(snapshot, key))) {
    fail("EVIDENCE_FREEZE_AUTHORITY_INVALID", "freeze authority readback has an unexpected shape");
  }
  if (!Array.isArray(snapshot.excluded_evidence) || !Array.isArray(snapshot.unresolved_contradiction_refs) ||
      !Array.isArray(snapshot.open_research_debt_refs)) {
    fail("EVIDENCE_FREEZE_AUTHORITY_INVALID", "freeze authority arrays are malformed");
  }
  try {
    VersionedRefSchema.parse(snapshot.scope_snapshot_ref);
    VersionedRefSchema.parse(snapshot.coverage_denominator_ref);
  } catch (cause) {
    fail("EVIDENCE_FREEZE_AUTHORITY_INVALID", "freeze authority references are invalid", false, cause);
  }
  if (refKey(snapshot.scope_snapshot_ref) !== `${scope.snapshot_id}:${scope.revision}`) {
    fail("EVIDENCE_FREEZE_SCOPE_STALE", "freeze authority is bound to another scope");
  }
  if (refKey(snapshot.coverage_denominator_ref).length > 256 ||
      refKey(snapshot.coverage_denominator_ref) !== refKey(input.coverage_denominator_ref)) {
    fail("EVIDENCE_FREEZE_AUTHORITY_INVALID", "coverage denominator reference is invalid");
  }
  if (refKey(input.freeze_ref).length > 256) {
    fail("EVIDENCE_FREEZE_AUTHORITY_INVALID", "freeze authority reference is invalid");
  }
  validateSha(snapshot.contract_protocol_digest, "contract protocol digest");
  validateSha(snapshot.lane_digest, "lane digest");
  if (snapshot.provider_model_prompt_tool_generations === null ||
      typeof snapshot.provider_model_prompt_tool_generations !== "object" ||
      Array.isArray(snapshot.provider_model_prompt_tool_generations) ||
      Object.keys(snapshot.provider_model_prompt_tool_generations).length === 0) {
    fail("EVIDENCE_FREEZE_AUTHORITY_INVALID", "generation bindings are missing");
  }
  for (const [key, generation] of Object.entries(snapshot.provider_model_prompt_tool_generations)) {
    validateId(key, "generation binding key");
    validateId(generation, "generation binding value");
  }
  for (const item of snapshot.excluded_evidence) {
    if (item === null || typeof item !== "object") fail("EVIDENCE_FREEZE_AUTHORITY_INVALID", "excluded evidence is malformed");
    validateId(item.evidence_ref, "excluded evidence reference");
    validateId(item.reason, "excluded evidence reason");
  }
  for (const ref of snapshot.unresolved_contradiction_refs) validateId(ref, "contradiction reference");
  for (const debtRef of snapshot.open_research_debt_refs) {
    try { VersionedRefSchema.parse(debtRef); }
    catch (cause) { fail("EVIDENCE_FREEZE_AUTHORITY_INVALID", "research debt reference is invalid", false, cause); }
  }
  return snapshot;
}

function handleKeys(manifest: AllowedReferenceManifest): readonly string[] {
  const keys = manifest.allowed_evidence_handle_refs.map(refKey);
  if (new Set(keys).size !== keys.length) fail("EVIDENCE_FREEZE_EVIDENCE_INVALID", "manifest contains duplicate evidence handles");
  return [...keys].sort();
}

function resolvedKeys(evidence: readonly ResolvedEvidence[]): readonly string[] {
  const keys = evidence.map((item) => refKey(item.handle.handle_ref));
  if (new Set(keys).size !== keys.length) fail("EVIDENCE_FREEZE_EVIDENCE_INVALID", "resolver returned duplicate evidence handles");
  return [...keys].sort();
}

function resolvedReceiptRecords(evidence: readonly ResolvedEvidence[]): readonly {
  readonly handle_ref: VersionedRef;
  readonly excerpt_sha256: string;
  readonly verification_receipt_ref: string;
}[] {
  return [...evidence].map((item) => ({
    handle_ref: item.handle.handle_ref,
    excerpt_sha256: item.handle.excerpt_sha256,
    verification_receipt_ref: item.verification_receipt_ref,
  })).sort((left, right) => refKey(left.handle_ref).localeCompare(refKey(right.handle_ref)));
}

function freezeBytes(freeze: EvidenceFreeze): Uint8Array {
  let parsed: EvidenceFreeze;
  try { parsed = EvidenceFreezeSchema.parse(freeze); }
  catch (cause) { fail("EVIDENCE_FREEZE_INPUT_INVALID", "evidence freeze failed strict validation", false, cause); }
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(parsed));
  if (bytes.byteLength > 64 * 1024) fail("EVIDENCE_FREEZE_INPUT_INVALID", "evidence freeze exceeds the receipt bound");
  return bytes;
}

export function createEvidenceFreezeStageHandler(
  dependencies: EvidenceFreezeStageDependencies,
): WorkflowStageHandler {
  return async ({ request, principal, input_bytes }) => {
    if (request.stage !== "FREEZE_EVIDENCE") fail("EVIDENCE_FREEZE_INPUT_INVALID", "handler called for another workflow stage");
    const stageInput = parseInput(input_bytes);
    const expectedScope = dependencies.navigation.scope;
    const before = await dependencies.navigation.current();
    let manifest: AllowedReferenceManifest | null;
    try {
      manifest = await dependencies.manifest_store.get(stageInput.manifest_ref);
    } catch (cause) {
      if (cause instanceof EvidenceFreezeStageError) throw cause;
      fail("EVIDENCE_FREEZE_SETTLEMENT_UNCERTAIN", "reference manifest readback is unavailable", true, cause);
    }
    if (manifest === null) fail("EVIDENCE_FREEZE_EVIDENCE_INVALID", "reference manifest is not committed");
    const expectedScopeRef = { id: expectedScope.snapshot_id, revision: expectedScope.revision };
    if (refKey(manifest.scope_snapshot_ref) !== refKey(expectedScopeRef) ||
        manifest.client_fence_ref !== dependencies.navigation.access.credential_generation) {
      fail("EVIDENCE_FREEZE_SCOPE_STALE", "reference manifest is bound to another scope or credential");
    }
    const authority = validateAuthority(
      await dependencies.authority.read({ request, principal, stage_input: stageInput, manifest }),
      stageInput,
      expectedScope,
    );
    if (refKey(authority.scope_snapshot_ref) !== refKey(manifest.scope_snapshot_ref)) {
      fail("EVIDENCE_FREEZE_SCOPE_STALE", "freeze authority is bound to a different manifest scope");
    }
    if (refKey(manifest.manifest_ref) !== refKey(stageInput.manifest_ref)) {
      fail("EVIDENCE_FREEZE_EVIDENCE_INVALID", "reference manifest identity differs from stage input");
    }
    const requested = handleKeys(manifest);
    let citation: Awaited<ReturnType<CloudflareEvidenceResolver["resolveCitationSet"]>>;
    try {
      citation = await dependencies.resolver.resolveCitationSet({
        handle_refs: manifest.allowed_evidence_handle_refs,
        scope_snapshot_ref: manifest.scope_snapshot_ref,
        access: dependencies.navigation.access,
      });
    } catch (cause) {
      const code = typeof cause === "object" && cause !== null && "code" in cause
        ? (cause as { readonly code?: unknown }).code
        : undefined;
      if (code === "EVIDENCE_SCOPE_NOT_FOUND" || code === "EVIDENCE_SCOPE_INVALIDATED" ||
          code === "EVIDENCE_SCOPE_EXPIRED" || code === "EVIDENCE_AUTHORIZATION_DENIED" ||
          code === "EVIDENCE_SCOPE_MISMATCH" || code === "EVIDENCE_OWNER_GENERATION_MISMATCH") {
        fail("EVIDENCE_FREEZE_SCOPE_STALE", "evidence scope authority is stale", true, cause);
      }
      if (code === "EVIDENCE_SETTLEMENT_UNCERTAIN") {
        fail("EVIDENCE_FREEZE_SETTLEMENT_UNCERTAIN", "evidence citation settlement is uncertain", true, cause);
      }
      if (typeof code === "string" && code.startsWith("EVIDENCE_")) {
        fail("EVIDENCE_FREEZE_EVIDENCE_INVALID", "authoritative evidence resolution failed", false, cause);
      }
      throw cause;
    }
    if (refKey(citation.receipt.scope_snapshot_ref) !== refKey(manifest.scope_snapshot_ref) ||
        JSON.stringify(citation.receipt.requested_handle_refs.map(refKey).sort()) !== JSON.stringify(requested)) {
      fail("EVIDENCE_FREEZE_EVIDENCE_INVALID", "citation receipt is bound to a different evidence set");
    }
    if (!citation.receipt.all_material_citations_resolved || citation.receipt.rejected.length !== 0 ||
        citation.receipt.resolved_count !== requested.length ||
        JSON.stringify(resolvedKeys(citation.resolved_evidence)) !== JSON.stringify(requested)) {
      fail("EVIDENCE_FREEZE_EVIDENCE_INVALID", "authoritative citation resolution is incomplete");
    }
    if (canonicalEvidenceJson(citation.receipt.resolved.map((item) => ({
      handle_ref: item.handle_ref,
      excerpt_sha256: item.excerpt_sha256,
      verification_receipt_ref: item.verification_receipt_ref,
    })).sort((left, right) => refKey(left.handle_ref).localeCompare(refKey(right.handle_ref)))) !==
        canonicalEvidenceJson(resolvedReceiptRecords(citation.resolved_evidence))) {
      fail("EVIDENCE_FREEZE_EVIDENCE_INVALID", "citation receipt digests differ from resolved evidence");
    }
    const after = await dependencies.navigation.current();
    if (canonicalEvidenceJson(before) !== canonicalEvidenceJson(after)) {
      fail("EVIDENCE_FREEZE_SCOPE_STALE", "scope authority changed during evidence freeze", true);
    }
    const finalAuthority = validateAuthority(
      await dependencies.authority.read({ request, principal, stage_input: stageInput, manifest }),
      stageInput,
      expectedScope,
    );
    if (canonicalEvidenceJson(authority) !== canonicalEvidenceJson(finalAuthority)) {
      fail("EVIDENCE_FREEZE_SCOPE_STALE", "freeze authority changed during evidence freeze", true);
    }
    const observedAt = dependencies.navigation.timestamp();
    if (!Number.isSafeInteger(Date.parse(observedAt)) || Date.parse(manifest.expires_at) <= Date.parse(observedAt)) {
      fail("EVIDENCE_FREEZE_SCOPE_STALE", "reference manifest has expired", true);
    }
    const included = citation.receipt.resolved.map((item) => ({
      handle_ref: item.handle_ref,
      digest: item.excerpt_sha256,
    })).sort((left, right) => refKey(left.handle_ref).localeCompare(refKey(right.handle_ref)));
    return freezeBytes({
      freeze_ref: stageInput.freeze_ref,
      scope_snapshot_ref: manifest.scope_snapshot_ref,
      client_fence_ref: dependencies.navigation.access.credential_generation,
      coverage_denominator_ref: authority.coverage_denominator_ref,
      contract_protocol_digest: authority.contract_protocol_digest,
      lane_digest: authority.lane_digest,
      included_evidence: included,
      excluded_evidence: [...authority.excluded_evidence],
      unresolved_contradiction_refs: [...authority.unresolved_contradiction_refs],
      open_research_debt_refs: [...authority.open_research_debt_refs],
      provider_model_prompt_tool_generations: authority.provider_model_prompt_tool_generations,
      frozen_at: observedAt,
    });
  };
}
