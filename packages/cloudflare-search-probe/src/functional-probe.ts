import { EvidenceHandleSchema, ScopeSnapshotSchema, type EvidenceHandle, type LocatorCandidate, type ResolvedEvidence, type ScopeSnapshot } from "@eliotr/contracts";
import {
  AI_SEARCH_PRIMARY_GENERATION,
  AI_SEARCH_PRIMARY_INSTANCE_ID,
  AI_SEARCH_PRIMARY_NAMESPACE,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  assertImmutableAiSearchProfile,
  decodeAiSearchGenerationRegistrySnapshot,
  type AiSearchGenerationRegistryService,
  type AiSearchGenerationRegistrySnapshot,
} from "@eliotr/cloudflare-ai";
import { createAiSearchScopeFilter, type AiSearchScopeFilter } from "@eliotr/cloudflare-ai";
import { decodeAiSearchSearchResult, type AiSearchInstanceLike, type AiSearchNamespaceLike, type EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type { EvidenceAccessContext } from "@eliotr/cloudflare-evidence";
import type { RetrievalRequest } from "@eliotr/retrieval";
import { z } from "zod";
import {
  AI_SEARCH_FUNCTIONAL_PROBE_PROTOCOL as PROTOCOL,
  AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_MAX_BYTES as MAX_RECEIPT_BYTES,
  canonicalProbeJson,
  createFunctionalProbeReceipt,
  functionalProbePublicResponse,
  probeBodyStream,
  probeSha256,
  readFunctionalProbeReceipt,
  type AiSearchFunctionalProbeOutcome,
  type AiSearchFunctionalProbeResponse,
  type FunctionalProbeReceipt,
  type FunctionalProbeReceiptContext,
} from "./receipt.js";

export type { AiSearchFunctionalProbeOutcome, AiSearchFunctionalProbeResponse } from "./receipt.js";

const RECEIPT_CONTENT_TYPE = "application/json";
const MAX_QUERY_BYTES = 4096;
const MAX_PREVIEW_BYTES = 4096;
const MAX_QUERY_DURATION_MS = 10_000;
const PREBILLING_CUTOFF_MS = Date.parse("2026-10-31T00:00:00.000Z");
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
export interface AiSearchFunctionalProbeInput {
  readonly access: EvidenceAccessContext; readonly project_id: string; readonly source_id: string;
  readonly source_revision_ref: string; readonly scope_snapshot: ScopeSnapshot; readonly query: string; readonly idempotency_key: string;
  /** Absolute server deadline in Unix milliseconds. */
  readonly deadline_ms: number;
  readonly signal: AbortSignal;
}

export interface AiSearchFunctionalProbeDependencies {
  readonly ai_search: AiSearchNamespaceLike; readonly registry: Pick<AiSearchGenerationRegistryService, "read">;
  /** Must be constructed over WORK_BUCKET. */
  readonly work_object_store: Pick<EvidenceObjectStore, "putImmutable" | "open">;
  /** Existing D1 owner-scope currentness adapter. */
  readonly require_current_scope: (access: EvidenceAccessContext, scope: ScopeSnapshot) => Promise<void>;
  /** Existing D1/R2 evidence resolver; it must return exact live evidence or throw. */
  readonly resolve_candidate: (access: EvidenceAccessContext, scope: ScopeSnapshot, candidate: LocatorCandidate) => Promise<ResolvedEvidence>;
  readonly now?: () => number;
}

export type AiSearchFunctionalProbeErrorCode = "AI_SEARCH_FUNCTIONAL_PROBE_INPUT_INVALID" | "AI_SEARCH_FUNCTIONAL_PROBE_OWNER_REQUIRED" |
  "AI_SEARCH_FUNCTIONAL_PROBE_SCOPE_MISMATCH" | "AI_SEARCH_FUNCTIONAL_PROBE_REGISTRY_NOT_SHADOW" |
  "AI_SEARCH_FUNCTIONAL_PROBE_PREBILLING_CLOSED" | "AI_SEARCH_FUNCTIONAL_PROBE_AUTHORITY_UNAVAILABLE";

export class AiSearchFunctionalProbeError extends Error {
  public constructor(public readonly code: AiSearchFunctionalProbeErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AiSearchFunctionalProbeError";
  }
}

interface ValidatedInput extends Omit<AiSearchFunctionalProbeInput, "query"> {
  readonly query: string; readonly query_sha256: string; readonly filters: AiSearchScopeFilter;
}
interface RegistryPin { readonly snapshot: AiSearchGenerationRegistrySnapshot; readonly revision: number; readonly artifact_sha256: string; }

function fail(code: AiSearchFunctionalProbeErrorCode, message: string, cause?: unknown): never { throw new AiSearchFunctionalProbeError(code, message, cause); }

function utf8Size(value: string): number { return new TextEncoder().encode(value).byteLength; }

function safeReason(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { readonly code?: unknown }).code : undefined;
  return typeof code === "string" && IDENTIFIER.test(code) ? code : "AI_SEARCH_FUNCTIONAL_PROBE_UNCERTAIN";
}

function exactOwnerScope(expression: ScopeSnapshot["resolved_scope_expression"], projectId: string, sourceId: string): boolean {
  if (expression.kind !== "INTERSECT") return false;
  const sides = [expression.left, expression.right];
  const project = sides.filter((side) => side.kind === "PROJECT"), selected = sides.filter((side) => side.kind === "SELECTED_SOURCES");
  return project.length === 1 && selected.length === 1 &&
    project[0]?.kind === "PROJECT" && project[0].project_id === projectId &&
    selected[0]?.kind === "SELECTED_SOURCES" && selected[0].source_ids.length === 1 &&
    selected[0].source_ids[0] === sourceId;
}

function validateInput(input: AiSearchFunctionalProbeInput, nowMs: number): ValidatedInput {
  const access = z.object({ principal_ref: z.string().regex(IDENTIFIER),
    client_class: z.enum(["owner_pwa", "named_api_client", "trusted_agent", "federation_client"]),
    credential_generation: z.string().regex(IDENTIFIER) }).strict().safeParse(input.access);
  if (!access.success) fail("AI_SEARCH_FUNCTIONAL_PROBE_INPUT_INVALID", "verified owner context is invalid");
  if (access.data.client_class !== "owner_pwa") {
    fail("AI_SEARCH_FUNCTIONAL_PROBE_OWNER_REQUIRED", "the functional probe is owner-only");
  }
  for (const [value, label] of [[input.project_id, "project_id"], [input.source_id, "source_id"], [input.source_revision_ref, "source_revision_ref"]] as const) {
    if (typeof value !== "string" || !IDENTIFIER.test(value)) {
      fail("AI_SEARCH_FUNCTIONAL_PROBE_INPUT_INVALID", `${label} is invalid`);
    }
  }
  const scope = ScopeSnapshotSchema.safeParse(input.scope_snapshot);
  if (!scope.success || !exactOwnerScope(scope.data.resolved_scope_expression, input.project_id, input.source_id) ||
      scope.data.member_source_revision_refs.length !== 1 ||
      scope.data.member_source_revision_refs[0] !== input.source_revision_ref) {
    fail("AI_SEARCH_FUNCTIONAL_PROBE_SCOPE_MISMATCH", "scope must be exactly the current project and one selected source revision");
  }
  if (typeof input.query !== "string" || input.query.trim().length === 0 || utf8Size(input.query) > MAX_QUERY_BYTES) {
    fail("AI_SEARCH_FUNCTIONAL_PROBE_INPUT_INVALID", "query must contain 1 to 4096 UTF-8 bytes");
  }
  if (typeof input.idempotency_key !== "string" || input.idempotency_key.length < 1 ||
      input.idempotency_key.length > 256 || /[\u0000-\u0020\u007f]/u.test(input.idempotency_key)) {
    fail("AI_SEARCH_FUNCTIONAL_PROBE_INPUT_INVALID", "Idempotency-Key is invalid");
  }
  if (!Number.isSafeInteger(input.deadline_ms) || input.deadline_ms <= nowMs || input.deadline_ms - nowMs > MAX_QUERY_DURATION_MS ||
      typeof input.signal !== "object" || input.signal === null || typeof input.signal.aborted !== "boolean") {
    fail("AI_SEARCH_FUNCTIONAL_PROBE_INPUT_INVALID", "server deadline or abort signal is invalid");
  }
  if (nowMs >= PREBILLING_CUTOFF_MS) {
    fail("AI_SEARCH_FUNCTIONAL_PROBE_PREBILLING_CLOSED", "the unreviewed prebilling functional query window has closed");
  }
  let filters: AiSearchScopeFilter;
  try {
    filters = createAiSearchScopeFilter(scope.data.member_source_revision_refs, AI_SEARCH_PRIMARY_GENERATION);
  } catch (cause) {
    fail("AI_SEARCH_FUNCTIONAL_PROBE_INPUT_INVALID", "frozen scope cannot fit an exact AI Search filter", cause);
  }
  return Object.freeze({
    filters,
    access: access.data,
    project_id: input.project_id,
    source_id: input.source_id,
    source_revision_ref: input.source_revision_ref,
    scope_snapshot: scope.data,
    query: input.query,
    query_sha256: "",
    idempotency_key: input.idempotency_key, deadline_ms: input.deadline_ms, signal: input.signal,
  });
}

async function readRegistryPin(
  registry: Pick<AiSearchGenerationRegistryService, "read">,
): Promise<RegistryPin> {
  let raw: unknown;
  try {
    raw = await registry.read(AI_SEARCH_PRIMARY_NAMESPACE);
  } catch (cause) {
    fail("AI_SEARCH_FUNCTIONAL_PROBE_AUTHORITY_UNAVAILABLE", "AI Search shadow registry is unavailable", cause);
  }
  if (raw === null) fail("AI_SEARCH_FUNCTIONAL_PROBE_REGISTRY_NOT_SHADOW", "AI Search generation registry is absent");
  let snapshot: AiSearchGenerationRegistrySnapshot;
  try {
    snapshot = await decodeAiSearchGenerationRegistrySnapshot(raw, AI_SEARCH_PRIMARY_NAMESPACE);
  } catch (cause) {
    fail("AI_SEARCH_FUNCTIONAL_PROBE_AUTHORITY_UNAVAILABLE", "AI Search generation registry readback is invalid", cause);
  }
  const registryRecord = snapshot.artifact.registry.generations.find(
    (record) => record.generation === AI_SEARCH_PRIMARY_GENERATION,
  );
  if (registryRecord === undefined ||
      !["DECLARED", "SHADOW_BUILDING", "SHADOW_COMPLETE"].includes(registryRecord.state) ||
      snapshot.artifact.registry.active_head_generation === AI_SEARCH_PRIMARY_GENERATION) {
    fail("AI_SEARCH_FUNCTIONAL_PROBE_REGISTRY_NOT_SHADOW", "the exact g2 generation is not a non-active shadow generation");
  }
  try {
    assertImmutableAiSearchProfile(registryRecord.profile, AI_SEARCH_PRIMARY_PROJECTION_PROFILE);
  } catch (cause) {
    fail("AI_SEARCH_FUNCTIONAL_PROBE_REGISTRY_NOT_SHADOW", "the g2 shadow profile differs from the immutable profile", cause);
  }
  if (registryRecord.profile.id !== AI_SEARCH_PRIMARY_INSTANCE_ID) {
    fail("AI_SEARCH_FUNCTIONAL_PROBE_REGISTRY_NOT_SHADOW", "the g2 shadow registry points to another native instance");
  }
  return Object.freeze({ snapshot, revision: snapshot.artifact.revision, artifact_sha256: snapshot.artifact_sha256 });
}

function sameRegistryPin(left: RegistryPin, right: RegistryPin): boolean {
  return left.revision === right.revision && left.artifact_sha256 === right.artifact_sha256 &&
    left.snapshot.artifact.namespace === right.snapshot.artifact.namespace &&
    left.snapshot.artifact.registry.active_head_generation === right.snapshot.artifact.registry.active_head_generation;
}

function checkRequestBudget(input: ValidatedInput, now: () => number): void {
  if (input.signal.aborted) throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_ABORTED");
  const current = now();
  if (!Number.isSafeInteger(current) || current < 0 || current >= input.deadline_ms) {
    throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_DEADLINE");
  }
  if (current >= PREBILLING_CUTOFF_MS) throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_PREBILLING_CLOSED");
}

async function requirePinnedAuthority(
  dependencies: AiSearchFunctionalProbeDependencies,
  input: ValidatedInput,
  pin: RegistryPin,
): Promise<void> {
  await dependencies.require_current_scope(input.access, input.scope_snapshot);
  const current = await readRegistryPin(dependencies.registry);
  if (!sameRegistryPin(current, pin)) throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_REGISTRY_CHANGED");
}

function requestDigestPayload(input: ValidatedInput, pin: RegistryPin): Readonly<Record<string, unknown>> {
  return Object.freeze({
    protocol: PROTOCOL,
    principal_ref: input.access.principal_ref,
    credential_generation: input.access.credential_generation,
    project_id: input.project_id,
    source_id: input.source_id,
    source_revision_ref: input.source_revision_ref,
    scope_snapshot_id: input.scope_snapshot.snapshot_id,
    scope_snapshot_revision: input.scope_snapshot.revision,
    scope_snapshot_digest: input.scope_snapshot.digest,
    query_sha256: input.query_sha256,
    idempotency_key_sha256: "",
    namespace: AI_SEARCH_PRIMARY_NAMESPACE,
    generation: AI_SEARCH_PRIMARY_GENERATION,
    registry_revision: pin.revision,
    registry_artifact_sha256: pin.artifact_sha256,
  });
}

function nativeRequest(input: ValidatedInput): Readonly<Record<string, unknown>> {
  return Object.freeze({
    query: input.query,
    ai_search_options: Object.freeze({
      retrieval: Object.freeze({
        filters: input.filters,
        retrieval_type: "vector",
        match_threshold: 0,
        max_num_results: 1,
        context_expansion: 0,
        boost_by: Object.freeze([]),
        metadata_only: false,
      }),
    }),
  });
}

async function withDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal,
  deadlineMs: number,
  now: () => number,
): Promise<T> {
  const remaining = deadlineMs - now();
  if (remaining <= 0 || signal.aborted) throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_DEADLINE");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const stop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("AI_SEARCH_FUNCTIONAL_PROBE_DEADLINE")), remaining);
    abortListener = () => reject(new Error("AI_SEARCH_FUNCTIONAL_PROBE_ABORTED"));
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try { return await Promise.race([work, stop]); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  }
}

async function storeTerminal(
  store: Pick<EvidenceObjectStore, "putImmutable" | "open">,
  receiptKey: string,
  receipt: FunctionalProbeReceipt,
  input: ValidatedInput,
  pin: RegistryPin,
): Promise<AiSearchFunctionalProbeResponse> {
  const text = canonicalProbeJson(receipt);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_RECEIPT_BYTES) return unknownResponse(input, pin, "AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_TOO_LARGE");
  const digest = await probeSha256(bytes);
  try {
    const written = await store.putImmutable({
      key: receiptKey,
      body: probeBodyStream(bytes),
      expected_sha256: digest,
      expected_size_bytes: bytes.byteLength,
      content_type: RECEIPT_CONTENT_TYPE,
      custom_metadata: { protocol: PROTOCOL, kind: "terminal", request_sha256: receipt.request_sha256 },
    });
    if (written.key !== receiptKey || written.expected_sha256 !== digest || written.readback_sha256 !== digest ||
        written.size_bytes !== bytes.byteLength || typeof written.existed_identically !== "boolean") {
      return unknownResponse(input, pin, "AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_READBACK_INVALID");
    }
    if (!written.existed_identically) return functionalProbePublicResponse(receipt);
    const replay = await readFunctionalProbeReceipt(store, receiptKey, receipt.request_sha256, receiptContext(input, pin));
    if (replay !== null && canonicalProbeJson(replay) === text) return functionalProbePublicResponse(replay);
  } catch {
    // The R2 claim prevents a retry from repeating the provider query.
  }
  return unknownResponse(input, pin, "AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_UNCERTAIN");
}

function receiptContext(input: ValidatedInput, pin: RegistryPin): FunctionalProbeReceiptContext {
  return {
    access: input.access, project_id: input.project_id, source_id: input.source_id,
    source_revision_ref: input.source_revision_ref, scope_snapshot: input.scope_snapshot,
    query_sha256: input.query_sha256, registry_revision: pin.revision,
    registry_artifact_sha256: pin.artifact_sha256,
  };
}

function unknownResponse(
  input: ValidatedInput,
  pin: RegistryPin,
  reasonCode: string,
): AiSearchFunctionalProbeResponse {
  return Object.freeze({
    protocol: PROTOCOL,
    qualification: "NONE",
    outcome: "UNKNOWN",
    source_revision_ref: input.source_revision_ref,
    registry_revision: pin.revision,
    registry_artifact_sha256: pin.artifact_sha256,
    query_sha256: input.query_sha256,
    reason_code: IDENTIFIER.test(reasonCode) ? reasonCode : "AI_SEARCH_FUNCTIONAL_PROBE_UNCERTAIN",
  });
}

export function createAiSearchFunctionalProbe(
  dependencies: AiSearchFunctionalProbeDependencies,
): { readonly probe: (input: AiSearchFunctionalProbeInput) => Promise<AiSearchFunctionalProbeResponse> } {
  if (typeof dependencies.ai_search?.get !== "function" || typeof dependencies.registry?.read !== "function" ||
      typeof dependencies.work_object_store?.putImmutable !== "function" || typeof dependencies.work_object_store?.open !== "function" ||
      typeof dependencies.require_current_scope !== "function" || typeof dependencies.resolve_candidate !== "function") {
    fail("AI_SEARCH_FUNCTIONAL_PROBE_INPUT_INVALID", "functional probe dependencies are incomplete");
  }
  const now = dependencies.now ?? Date.now;

  return Object.freeze({
    async probe(rawInput: AiSearchFunctionalProbeInput): Promise<AiSearchFunctionalProbeResponse> {
      const input = validateInput(rawInput, now());
      const querySha = await probeSha256(new TextEncoder().encode(input.query));
      const validated: ValidatedInput = Object.freeze({ ...input, query_sha256: querySha });
      let initialPin: RegistryPin;
      try {
        await dependencies.require_current_scope(validated.access, validated.scope_snapshot);
        initialPin = await readRegistryPin(dependencies.registry);
      } catch (error) {
        if (error instanceof AiSearchFunctionalProbeError) throw error;
        fail("AI_SEARCH_FUNCTIONAL_PROBE_AUTHORITY_UNAVAILABLE", "owner scope or shadow registry could not be verified", error);
      }
      checkRequestBudget(validated, now);
      const idemSha = await probeSha256(new TextEncoder().encode(validated.idempotency_key));
      const claimIdentity = await probeSha256(new TextEncoder().encode(canonicalProbeJson({
        principal_ref: validated.access.principal_ref,
        idempotency_key_sha256: idemSha,
        protocol: PROTOCOL,
      })));
      const requestPayload = { ...requestDigestPayload(validated, initialPin), idempotency_key_sha256: idemSha };
      const requestSha = await probeSha256(new TextEncoder().encode(canonicalProbeJson(requestPayload)));
      const claimKey = `functional-probe/v1/claims/${claimIdentity}.json`;
      const receiptKey = `functional-probe/v1/receipts/${claimIdentity}.json`;
      const claim = {
        protocol: PROTOCOL,
        state: "STARTED",
        request_sha256: requestSha,
        query_sha256: validated.query_sha256,
        principal_ref: validated.access.principal_ref,
        credential_generation: validated.access.credential_generation,
        project_id: validated.project_id,
        source_id: validated.source_id,
        source_revision_ref: validated.source_revision_ref,
        scope_snapshot_id: validated.scope_snapshot.snapshot_id,
        scope_snapshot_revision: validated.scope_snapshot.revision,
        scope_snapshot_digest: validated.scope_snapshot.digest,
        namespace: AI_SEARCH_PRIMARY_NAMESPACE,
        generation: AI_SEARCH_PRIMARY_GENERATION,
        registry_revision: initialPin.revision,
        registry_artifact_sha256: initialPin.artifact_sha256,
      };
      const claimText = canonicalProbeJson(claim);
      const claimBytes = new TextEncoder().encode(claimText);
      const claimSha = await probeSha256(claimBytes);
      let claimReceipt;
      try {
        claimReceipt = await dependencies.work_object_store.putImmutable({
          key: claimKey,
          body: probeBodyStream(claimBytes),
          expected_sha256: claimSha,
          expected_size_bytes: claimBytes.byteLength,
          content_type: RECEIPT_CONTENT_TYPE,
          custom_metadata: { protocol: PROTOCOL, kind: "start", request_sha256: requestSha },
        });
        if (claimReceipt.key !== claimKey || claimReceipt.expected_sha256 !== claimSha ||
            claimReceipt.readback_sha256 !== claimSha || claimReceipt.size_bytes !== claimBytes.byteLength ||
            typeof claimReceipt.existed_identically !== "boolean") {
          return unknownResponse(validated, initialPin, "AI_SEARCH_FUNCTIONAL_PROBE_CLAIM_READBACK_INVALID");
        }
      } catch {
        return unknownResponse(validated, initialPin, "AI_SEARCH_FUNCTIONAL_PROBE_CLAIM_UNCERTAIN");
      }
      if (claimReceipt.existed_identically) {
        try {
          await requirePinnedAuthority(dependencies, validated, initialPin);
          const terminal = await readFunctionalProbeReceipt(dependencies.work_object_store, receiptKey, requestSha, receiptContext(validated, initialPin));
          await requirePinnedAuthority(dependencies, validated, initialPin);
          return terminal === null
            ? unknownResponse(validated, initialPin, "AI_SEARCH_FUNCTIONAL_PROBE_START_ALREADY_CLAIMED")
            : functionalProbePublicResponse(terminal);
        } catch {
          return unknownResponse(validated, initialPin, "AI_SEARCH_FUNCTIONAL_PROBE_REPLAY_UNCERTAIN");
        }
      }

      let outcome: AiSearchFunctionalProbeOutcome;
      let evidenceHandle: EvidenceHandle | undefined;
      let reasonCode: string | undefined;
      try {
        checkRequestBudget(validated, now);
        await requirePinnedAuthority(dependencies, validated, initialPin);
        checkRequestBudget(validated, now);
        let instance: AiSearchInstanceLike;
        try { instance = dependencies.ai_search.get(AI_SEARCH_PRIMARY_INSTANCE_ID); }
        catch (error) { throw new Error(`AI_SEARCH_FUNCTIONAL_INSTANCE_UNAVAILABLE:${safeReason(error)}`, { cause: error }); }
        if (typeof instance !== "object" || instance === null || typeof instance.search !== "function") {
          throw new Error("AI_SEARCH_FUNCTIONAL_INSTANCE_UNAVAILABLE");
        }
        const request: RetrievalRequest = {
          raw_query: validated.query,
          product: "FAST_SEARCH",
          scope_snapshot: validated.scope_snapshot,
          literals: [],
          requested_limit: 1,
          deadline_ms: validated.deadline_ms,
        };
        const rawResult = await withDeadline(
          Promise.resolve().then(() => instance.search(nativeRequest(validated))),
          validated.signal,
          validated.deadline_ms,
          now,
        );
        checkRequestBudget(validated, now);
        await requirePinnedAuthority(dependencies, validated, initialPin);
        const candidates = decodeAiSearchSearchResult(request, rawResult, {
          expected_index_generation: AI_SEARCH_PRIMARY_GENERATION,
          requested_lanes: ["SEM"],
          max_results: 1,
          max_preview_bytes: MAX_PREVIEW_BYTES,
        });
        if (candidates.length === 0) {
          outcome = "NO_MATCH";
          reasonCode = "AI_SEARCH_FUNCTIONAL_PROBE_NO_MATCH";
        } else {
          const candidate = candidates[0];
          if (candidate === undefined || candidate.source_revision_ref !== validated.source_revision_ref || candidate.lane !== "SEM") {
            throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_CANDIDATE_SCOPE_MISMATCH");
          }
          const { proof_state: _proofState, ...locator } = candidate as LocatorCandidate & { readonly proof_state?: unknown };
          void _proofState;
          const resolved = await dependencies.resolve_candidate(validated.access, validated.scope_snapshot, locator);
          await requirePinnedAuthority(dependencies, validated, initialPin);
          const parsedHandle = EvidenceHandleSchema.safeParse(resolved.handle);
          if (!parsedHandle.success || parsedHandle.data.terminal_state !== "LIVE" ||
              parsedHandle.data.source_revision_ref !== validated.source_revision_ref ||
              parsedHandle.data.scope_snapshot_ref.id !== validated.scope_snapshot.snapshot_id ||
              parsedHandle.data.scope_snapshot_ref.revision !== validated.scope_snapshot.revision) {
            throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_EVIDENCE_SCOPE_MISMATCH");
          }
          evidenceHandle = parsedHandle.data;
          outcome = "SUCCEEDED";
        }
      } catch (error) {
        outcome = "UNKNOWN";
        evidenceHandle = undefined;
        reasonCode = safeReason(error);
      }

      let receipt: FunctionalProbeReceipt;
      try {
        receipt = await createFunctionalProbeReceipt(receiptContext(validated, initialPin), requestSha, outcome, now(), evidenceHandle, reasonCode);
      } catch {
        return unknownResponse(validated, initialPin, "AI_SEARCH_FUNCTIONAL_PROBE_TERMINAL_INVALID");
      }
      try {
        await requirePinnedAuthority(dependencies, validated, initialPin);
        const response = await storeTerminal(dependencies.work_object_store, receiptKey, receipt, validated, initialPin);
        await requirePinnedAuthority(dependencies, validated, initialPin);
        return response;
      } catch {
        return unknownResponse(validated, initialPin, "AI_SEARCH_FUNCTIONAL_PROBE_AUTHORITY_CHANGED");
      }
    },
  });
}
