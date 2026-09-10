import type { OperationAttempt, OperationIntent, OperationReceipt, VersionedRef } from "@eliotr/contracts";

export interface D1TransactionWork<T> {
  readonly statements: readonly D1PreparedStatement[];
  readonly decode: (results: readonly D1Result<unknown>[]) => T;
}

export interface CoreMetadataRepository {
  getSourceRevision(ref: string): Promise<Record<string, unknown> | null>;
  getScopeSnapshot(ref: VersionedRef): Promise<Record<string, unknown> | null>;
  getEvidenceHandle(ref: VersionedRef): Promise<Record<string, unknown> | null>;
  appendIntentWithOutbox(intent: OperationIntent, outboxPayloadRef: string): Promise<VersionedRef>;
  appendAttempt(attempt: OperationAttempt): Promise<void>;
  appendReceipt(receipt: OperationReceipt): Promise<VersionedRef>;
  compareAndSwapHead(table: "investigation" | "wiki_head" | "artifact_head", id: string, expectedRevision: number, nextRevision: number, manifestRef: string): Promise<boolean>;
}

export interface SearchProjectionRepository {
  exactPhrase(query: string, scopeRevisionRefs: readonly string[], limit: number): Promise<readonly Record<string, unknown>[]>;
  lexical(query: string, scopeRevisionRefs: readonly string[], limit: number): Promise<readonly Record<string, unknown>[]>;
  scanCursor(scopeRevisionRefs: readonly string[], cursor?: string): Promise<{ rows: readonly Record<string, unknown>[]; next_cursor?: string }>;
  projectionWatermark(channel: string): Promise<string | null>;
}

export const D1_WRITE_DISCIPLINE = [
  "no model, HTTP, R2, AI Search, or Google call inside a D1 transaction",
  "canonical mutation and outbox intent commit in the same transaction",
  "active heads use expected-revision compare-and-swap",
  "agents never receive direct SQL access",
  "search projections are rebuildable and isolated in SEARCH_DB",
] as const;
