import { createD1ScopeSnapshotStore } from "@eliotr/cloudflare-evidence";
import { createScopeService, type ScopeRepository, type ScopeService, type ScopeServiceOptions } from "./scope-service.js";

/** Compose real snapshot storage without inventing a principal or mutable policy authority. */
export function createD1ScopeService(
  database: D1Database,
  authority: Pick<ScopeRepository, "resolveAtom" | "resolveAuthorityClosure">,
  options: ScopeServiceOptions = {},
): ScopeService {
  const storage = createD1ScopeSnapshotStore(database);
  return createScopeService({
    resolveAtom: (atom, observedAt) => authority.resolveAtom(atom, observedAt),
    resolveAuthorityClosure: (request) => authority.resolveAuthorityClosure(request),
    persistSnapshot: (snapshot) => storage.persistSnapshot(snapshot),
    readSnapshot: (id, revision) => storage.readSnapshot(id, revision),
  }, options);
}
