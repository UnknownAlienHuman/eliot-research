import { createD1NavigationStore, type D1NavigationStoreInput } from "@eliotr/cloudflare-evidence";
import type { NavigationService } from "@eliotr/retrieval";
import { createNavigationService } from "./navigation-service.js";
import type { ScopeService } from "./scope-service.js";

/** Supply an authoritative scope service, not user-provided snapshot validity. No grant is minted here. */
export function createD1NavigationService(
  input: Omit<D1NavigationStoreInput, "require_current"> & { readonly scopes: Pick<ScopeService, "requireCurrent"> },
): NavigationService {
  return createNavigationService(createD1NavigationStore({ ...input,
    require_current: (scope) => input.scopes.requireCurrent(scope),
  }));
}
