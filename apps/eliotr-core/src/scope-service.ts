import type { ScopeExpression, ScopeSnapshot } from "@eliotr/contracts";

export interface ScopeRepository {
  resolveSourceRevisionRefs(expression: ScopeExpression): Promise<readonly string[]>;
  currentParticipantGenerations(expression: ScopeExpression): Promise<Readonly<Record<string, string>>>;
  currentOwnerGenerations(sourceRevisionRefs: readonly string[]): Promise<Readonly<Record<string, string>>>;
  currentPurgeLedgerRevision(): Promise<number>;
}

export interface ScopeService {
  freeze(expression: ScopeExpression, clientFenceRef?: string): Promise<ScopeSnapshot>;
  validateCurrent(snapshot: ScopeSnapshot): Promise<{ current: boolean; invalidation_reason_codes: readonly string[] }>;
}

// SCAFFOLD_FAIL_CLOSED: ER-30 scope snapshot persistence
export function createScopeService(_repository: ScopeRepository): ScopeService {
  return {
    async freeze(): Promise<never> { throw new Error("ER-30 implementation required"); },
    async validateCurrent(): Promise<never> { throw new Error("ER-30 implementation required"); },
  };
}
