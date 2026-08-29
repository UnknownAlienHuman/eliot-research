import type {
  EvidenceHandle,
  LocatorCandidate,
  ProjectionItem,
  QueryProduct,
  ResolvedEvidence,
  RetrievalLane,
  RetrievalTrace,
  ScopeSnapshot,
  VersionedRef,
} from "@eliotr/contracts";
import type { PolicyEvaluationResult } from "@eliotr/policy";

export interface RetrievalRequest {
  readonly raw_query: string;
  readonly product: QueryProduct;
  readonly scope_snapshot: ScopeSnapshot;
  readonly policy: PolicyEvaluationResult;
  readonly literals: readonly string[];
  readonly requested_limit: number;
  readonly deadline_ms: number;
  readonly cancellation_ref?: string;
}

export interface DirectLookupPort {
  lookupIdentifiers(request: RetrievalRequest): Promise<readonly LocatorCandidate[]>;
}

export interface ExactSearchPort {
  exactPhraseCandidates(request: RetrievalRequest): Promise<readonly LocatorCandidate[]>;
  completeScopeCursor(scope: ScopeSnapshot): AsyncIterable<readonly string[]>;
  scanNormalizedSection(sourceRevisionRef: string, sectionRef: string, probes: readonly string[]): Promise<readonly LocatorCandidate[]>;
}

export interface LexicalSearchPort {
  search(request: RetrievalRequest, lane: "LEX" | "LITERAL"): Promise<readonly LocatorCandidate[]>;
}

export interface ManagedSearchPort {
  search(request: RetrievalRequest, lanes: readonly ("SEM" | "LEX" | "LITERAL")[], contextExpansion: 0 | 1 | 2 | 3): Promise<readonly LocatorCandidate[]>;
}

export interface StructurePort {
  expand(candidate: LocatorCandidate, mode: "PARENT" | "NEIGHBORS" | "PAGE" | "TABLE"): Promise<readonly LocatorCandidate[]>;
}

export interface EvidenceRegistryPort {
  loadHandle(ref: VersionedRef): Promise<EvidenceHandle | null>;
  findOrCreateHandle(candidate: LocatorCandidate, scope: ScopeSnapshot): Promise<EvidenceHandle>;
}

export interface EvidenceMaterializerPort {
  materialize(handle: EvidenceHandle): Promise<ResolvedEvidence>;
}

export interface ProjectionSinkPort {
  putProjectionItem(instanceId: string, item: ProjectionItem): Promise<{ item_ref: string; readback_digest: string }>;
  deleteProjectionItem(instanceId: string, itemKey: string): Promise<void>;
}

export interface RetrievalTracePort {
  persist(trace: RetrievalTrace): Promise<VersionedRef>;
}

export interface RetrievalLaneExecutor {
  execute(lane: RetrievalLane, request: RetrievalRequest): Promise<readonly LocatorCandidate[]>;
}
