import {
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  createNavigationReadAuthority,
  EvidenceRuntimeError,
} from "@eliotr/cloudflare-evidence";
import {
  readHeldResearchScope as readStoredHeldResearchScope,
  ResearchHeldScopeError,
  type HeldResearchScope,
} from "@eliotr/cloudflare-research";
import { AI_SEARCH_PRIMARY_NAMESPACE, createD1BackedAiSearchManagedSearchPort } from "@eliotr/cloudflare-ai";
import {
  createD1SearchExactPort,
  createD1SearchIdentPort,
  createD1SearchLexPort,
  D1_SEARCH_LANE_MAX_LIMIT,
  readD1SearchChannelReadback,
  type PinnedGeneration,
} from "@eliotr/cloudflare-projection";
import {
  createD1RetrievalResultStore,
  createD1RetrievalTracePort,
  createD1ScopePorts,
  createD1ScopeProfilePort,
  createExactLaneExecutor,
  createIdentLaneExecutor,
  createLexLaneExecutor,
  createQueryBudgetGuard,
  createRetrievalQueryService,
  createSemLaneExecutor,
  RetrievalQueryError,
  type RetrievalQueryAccess,
  type RetrievalQueryPorts,
  type ScopeProfileBinding,
} from "@eliotr/retrieval";
import type { LocatorCandidate, ResolvedEvidence, RetrievalLane, ScopeSnapshot } from "@eliotr/contracts";
import type { RetrievalRequest, RetrievalResult } from "@eliotr/retrieval";
import type { Env } from "./env.js";
import { createExactPhraseVerifier } from "./research-exact-search.js";

export type ResearchRetrievalEnvironment = Pick<Env, "CORE_DB" | "SEARCH_DB" | "EVIDENCE_BUCKET"> & {
  readonly AI_SEARCH?: Env["AI_SEARCH"];
};

export interface HeldScopeRetrievalInput {
  readonly access: RetrievalQueryAccess;
  readonly scope_snapshot: ScopeSnapshot;
  readonly raw_query: string;
  readonly product: RetrievalRequest["product"];
  readonly literals: readonly string[];
  readonly requested_limit: number;
  readonly deadline_ms: number;
  readonly idempotency_key: string;
  readonly signal: AbortSignal;
  /** Server-selected immutable profile; never sourced from a public request. */
  readonly profile: ScopeProfileBinding;
}

const OMITTED_CANDIDATE_CODES: ReadonlySet<string> = new Set([
  "EVIDENCE_INPUT_INVALID", "EVIDENCE_SCOPE_MISMATCH", "EVIDENCE_LOCATOR_NOT_RESOLVABLE",
  "EVIDENCE_PRECISION_UNSUPPORTED", "EVIDENCE_OBJECT_NOT_FOUND", "EVIDENCE_OBJECT_INTEGRITY",
  "EVIDENCE_RANGE_INVALID", "EVIDENCE_SOURCE_NOT_FOUND", "EVIDENCE_HANDLE_NOT_FOUND",
  "EVIDENCE_HANDLE_NOT_LIVE", "EVIDENCE_IDENTITY_CONFLICT",
]);
const STALE_AUTHORITY_CODES: ReadonlySet<string> = new Set([
  "EVIDENCE_SCOPE_NOT_FOUND", "EVIDENCE_SCOPE_INVALIDATED", "EVIDENCE_SCOPE_EXPIRED",
  "EVIDENCE_AUTHORIZATION_DENIED", "EVIDENCE_SOURCE_NOT_LIVE", "EVIDENCE_OWNER_GENERATION_MISMATCH",
]);

function fail(code: "RETRIEVAL_RESOLUTION_UNCERTAIN" | "RETRIEVAL_AUTHORITY_STALE", message: string): never {
  throw new RetrievalQueryError(code, message, code === "RETRIEVAL_RESOLUTION_UNCERTAIN");
}

interface SelectedSourceProjectionRow {
  readonly item_key: unknown;
  readonly source_revision_ref: unknown;
  readonly canonical_section_id: unknown;
  readonly content_sha256: unknown;
  readonly projection_generation: unknown;
  readonly normalized_start_byte: unknown;
  readonly normalized_end_byte: unknown;
}

function selectedFallbackInvalid(): never {
  throw new RetrievalQueryError(
    "RETRIEVAL_RESOLUTION_UNCERTAIN",
    "selected source projection readback is unavailable",
    true,
  );
}

function selectedFallbackIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) {
    return selectedFallbackInvalid();
  }
  return value;
}

function selectedFallbackDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    return selectedFallbackInvalid();
  }
  return value;
}

function sameProjectionPin(
  left: PinnedGeneration,
  right: PinnedGeneration,
): boolean {
  return left.source_revision_ref === right.source_revision_ref &&
    left.projection_generation === right.projection_generation &&
    left.receipt_ref === right.receipt_ref &&
    left.readback_digest === right.readback_digest &&
    left.item_set_digest === right.item_set_digest &&
    left.item_count === right.item_count;
}

/**
 * When selected sources produce no lexical hit, expose bounded real projection
 * sections as context. Every locator still goes through the existing Evidence
 * resolver, so this never turns an index row into proof or leaves the selected
 * scope.
 */
async function selectedDocumentFallbackCandidates(
  search: D1Database,
  core: D1Database,
  request: RetrievalRequest,
  checkBudget: () => void,
): Promise<readonly LocatorCandidate[]> {
  const members = request.scope_snapshot.member_source_revision_refs;
  if (members.length === 0) return [];
  let first: Awaited<ReturnType<typeof readD1SearchChannelReadback>>;
  try {
    checkBudget();
    first = await readD1SearchChannelReadback(
      search,
      core,
      "lexical",
      members,
      request.scope_snapshot.source_owner_generations,
    );
    checkBudget();
  } catch {
    checkBudget();
    throw new RetrievalQueryError(
      "RETRIEVAL_RESOLUTION_UNCERTAIN",
      "selected source projection readback is unavailable",
      true,
    );
  }
  const memberSet = new Set(members);
  const pinnedSet = new Set(first.pinned.map((pin) => pin.source_revision_ref));
  if (first.pinned.length !== members.length || pinnedSet.size !== first.pinned.length ||
      first.pinned.some((pin) => !memberSet.has(pin.source_revision_ref)) ||
      first.missing.length !== 0 || first.stale.length !== 0) {
    throw new RetrievalQueryError(
      "RETRIEVAL_RESOLUTION_UNCERTAIN",
      "selected source projection changed during readback",
      true,
    );
  }
  const fallbackLimit = Math.min(request.requested_limit, D1_SEARCH_LANE_MAX_LIMIT);
  const candidates: LocatorCandidate[] = [];
  for (const [index, pin] of first.pinned.entries()) {
    const remaining = fallbackLimit - candidates.length;
    if (remaining <= 0) break;
    const remainingSources = first.pinned.length - index;
    const fairShare = Math.ceil(remaining / remainingSources);
    const limit = Math.min(fairShare, pin.item_count, D1_SEARCH_LANE_MAX_LIMIT);
    if (limit <= 0) continue;
    let result: D1Result<SelectedSourceProjectionRow>;
    try {
      checkBudget();
      result = await search.prepare(
        "SELECT p.item_key, p.source_revision_ref, p.canonical_section_id, p.content_sha256, " +
          "p.projection_generation, s.normalized_start_byte, s.normalized_end_byte " +
          "FROM projection_item p JOIN projection_span s ON s.item_key = p.item_key " +
          "AND s.source_revision_ref = p.source_revision_ref " +
          "AND s.projection_generation = p.projection_generation " +
          "WHERE p.source_revision_ref = ?1 AND p.projection_generation = ?2 AND p.active = 1 " +
          "ORDER BY s.normalized_start_byte, p.item_key LIMIT ?3",
      ).bind(pin.source_revision_ref, pin.projection_generation, limit).all<SelectedSourceProjectionRow>();
      checkBudget();
    } catch (error) {
      if (error instanceof RetrievalQueryError) throw error;
      return selectedFallbackInvalid();
    }
    if (!result.success || !Array.isArray(result.results) || result.results.length !== limit) {
      return selectedFallbackInvalid();
    }
    for (const row of result.results) {
      const itemKey = selectedFallbackIdentity(row.item_key);
      const source = selectedFallbackIdentity(row.source_revision_ref);
      const section = selectedFallbackIdentity(row.canonical_section_id);
      const digest = selectedFallbackDigest(row.content_sha256);
      const generation = selectedFallbackIdentity(row.projection_generation);
      if (source !== pin.source_revision_ref || generation !== pin.projection_generation ||
          typeof row.normalized_start_byte !== "number" || typeof row.normalized_end_byte !== "number" ||
          !Number.isSafeInteger(row.normalized_start_byte) || !Number.isSafeInteger(row.normalized_end_byte) ||
          row.normalized_start_byte < 0 || row.normalized_end_byte <= row.normalized_start_byte) {
        return selectedFallbackInvalid();
      }
      candidates.push({
        candidate_id: itemKey,
        lane: "LEX",
        source_revision_ref: source,
        canonical_section_id: section,
        preview: "",
        raw_score: 0.25,
        rank: candidates.length + 1,
        index_generation: generation,
        metadata: { item_key: itemKey, content_sha256: digest, selected_document_fallback: true },
      });
    }
  }
  let settled: Awaited<ReturnType<typeof readD1SearchChannelReadback>>;
  try {
    checkBudget();
    settled = await readD1SearchChannelReadback(
      search,
      core,
      "lexical",
      members,
      request.scope_snapshot.source_owner_generations,
    );
    checkBudget();
  } catch {
    checkBudget();
    throw new RetrievalQueryError(
      "RETRIEVAL_RESOLUTION_UNCERTAIN",
      "selected source projection changed during readback",
      true,
    );
  }
  const settledBySource = new Map(settled.pinned.map((pin) => [pin.source_revision_ref, pin]));
  if (settled.pinned.length !== first.pinned.length || settled.missing.length !== 0 || settled.stale.length !== 0 ||
      first.pinned.some((pin) => {
        const settledPin = settledBySource.get(pin.source_revision_ref);
        return settledPin === undefined || !sameProjectionPin(pin, settledPin);
      })) {
    throw new RetrievalQueryError(
      "RETRIEVAL_RESOLUTION_UNCERTAIN",
      "selected source projection changed during readback",
      true,
    );
  }
  return candidates.slice(0, request.requested_limit);
}

export type { HeldResearchScope } from "@eliotr/cloudflare-research";
export async function loadHeldResearchScope(
  env: Pick<Env, "CORE_DB" | "SEARCH_DB">,
  access: RetrievalQueryAccess,
  operationId: string,
  deploymentGeneration: string,
): Promise<HeldResearchScope> {
  try {
    return await readStoredHeldResearchScope({
      core_database: env.CORE_DB,
      search_database: env.SEARCH_DB,
      access,
      operation_id: operationId,
      deployment_generation: deploymentGeneration,
      require_current_scope: async (scope) => { await createD1ScopePorts(env.CORE_DB, access).requireCurrentScope(scope); },
    });
  } catch (error) {
    if (error instanceof ResearchHeldScopeError) {
      fail(error.code === "RESEARCH_HELD_SCOPE_STALE" ? "RETRIEVAL_AUTHORITY_STALE" : "RETRIEVAL_RESOLUTION_UNCERTAIN", "stored research scope authority is unavailable");
    }
    throw error;
  }
}

export async function retrieveWithHeldScope(
  env: ResearchRetrievalEnvironment,
  input: HeldScopeRetrievalInput,
): Promise<RetrievalResult> {
  const access = input.access;
  const scopePorts = createD1ScopePorts(env.CORE_DB, access);
  // Validate the held scope and its owner grant before creating any retrieval
  // profile row. This keeps revoked or foreign workflow scopes read-only.
  await scopePorts.requireCurrentScope(input.scope_snapshot);
  if (input.scope_snapshot.member_source_revision_refs.length > input.profile.max_sources ||
      input.requested_limit > input.profile.max_results) {
    throw new RetrievalQueryError("RETRIEVAL_INPUT_INVALID", "retrieval request exceeds its server-selected scope profile");
  }
  await createD1ScopeProfilePort(env.CORE_DB).recordBinding(input.scope_snapshot, input.profile);
  const evidenceAuthority = createD1EvidenceAuthorityPort({
    core_database: env.CORE_DB,
    search_database: env.SEARCH_DB,
  });
  const evidenceContent = createR2EvidenceContentPort({ evidence_bucket: env.EVIDENCE_BUCKET });
  const resolver = createCloudflareEvidenceResolver({ authority: evidenceAuthority, content: evidenceContent });
  const navigation = createNavigationReadAuthority({
    database: env.CORE_DB,
    scope_snapshot: input.scope_snapshot,
    access,
    require_current: async (scope) => {
      await scopePorts.requireCurrentScope(scope);
      return scope;
    },
  });
  const queryBudget = createQueryBudgetGuard(input.deadline_ms, () => input.signal.aborted);
  async function resolveEvidence(candidate: LocatorCandidate, scope: ScopeSnapshot): Promise<ResolvedEvidence | null> {
    try {
      return await resolver.resolveCandidate({
        candidate,
        scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
        access,
      });
    } catch (error) {
      if (error instanceof EvidenceRuntimeError) {
        if (!STALE_AUTHORITY_CODES.has(error.code) && OMITTED_CANDIDATE_CODES.has(error.code)) return null;
        if (STALE_AUTHORITY_CODES.has(error.code)) throw new RetrievalQueryError("RETRIEVAL_AUTHORITY_STALE", error.message);
        throw new RetrievalQueryError("RETRIEVAL_RESOLUTION_UNCERTAIN", error.message, true);
      }
      throw new RetrievalQueryError("RETRIEVAL_RESOLUTION_UNCERTAIN", error instanceof Error ? error.message : "evidence resolution failed", true);
    }
  }
  const directCandidatesSeen = new WeakMap<RetrievalRequest, true>();
  const identPort = createD1SearchIdentPort({ search_database: env.SEARCH_DB, core_database: env.CORE_DB });
  const ident = createIdentLaneExecutor({
    async lookupIdentifiers(request) {
      const candidates = await identPort.lookupIdentifiers(request);
      if (candidates.length > 0) directCandidatesSeen.set(request, true);
      return candidates;
    },
  });
  const exactPort = createD1SearchExactPort({
    search_database: env.SEARCH_DB,
    core_database: env.CORE_DB,
    verifyExactPhrase: createExactPhraseVerifier({
      navigation,
      authority: evidenceAuthority,
      content: evidenceContent,
      checkBudget: () => queryBudget.checkBudget(),
    }),
  });
  const exact = createExactLaneExecutor({
    async exactPhraseCandidates(request) {
      const candidates = await exactPort.exactPhraseCandidates(request);
      if (candidates.length > 0) directCandidatesSeen.set(request, true);
      return candidates;
    },
  });
  const lexPort = createD1SearchLexPort({ search_database: env.SEARCH_DB, core_database: env.CORE_DB });
  const lex = createLexLaneExecutor({
    async search(request, lane) {
      const candidates = await lexPort.search(request, lane);
      if (candidates.length > 0 || directCandidatesSeen.has(request)) return candidates;
      return selectedDocumentFallbackCandidates(env.SEARCH_DB, env.CORE_DB, request, () => queryBudget.checkBudget());
    },
  });
  const sem = env.AI_SEARCH === undefined ? null : createSemLaneExecutor(createD1BackedAiSearchManagedSearchPort(
    env.SEARCH_DB,
    env.AI_SEARCH,
    { expected_namespace: AI_SEARCH_PRIMARY_NAMESPACE, max_preview_bytes: 4096, match_threshold: 0 },
  ));
  const lanes = {
    executorFor(lane: RetrievalLane) {
      if (lane === "IDENT") return ident;
      if (lane === "EXACT") return exact;
      if (lane === "LEX") return lex;
      if (lane === "SEM") return sem;
      return null;
    },
  };
  const ports: RetrievalQueryPorts = {
    ...scopePorts,
    lanes,
    fusion: { reciprocal_rank_constant: 60, lane_weights: { IDENT: 2, EXACT: 2, LEX: 1, SEM: 1 }, maxPerSourceRevision: 8 },
    resolveEvidence,
    persistTrace: (trace) => createD1RetrievalTracePort(env.CORE_DB, access).persistTrace(trace),
    results: createD1RetrievalResultStore(env.CORE_DB, access),
    checkBudget: () => queryBudget.checkBudget(),
  };
  const request: RetrievalRequest = {
    raw_query: input.raw_query,
    product: input.product,
    scope_snapshot: input.scope_snapshot,
    literals: [...input.literals],
    requested_limit: input.requested_limit,
    deadline_ms: input.deadline_ms,
  };
  return createRetrievalQueryService(ports).query({ request, idempotency_key: input.idempotency_key });
}
