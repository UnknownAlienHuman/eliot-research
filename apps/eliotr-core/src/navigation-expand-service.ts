import {
  createD1ScopeService,
  createOwnerScopeAuthority,
} from "@eliotr/cloudflare-navigation";
import type {
  AuthenticatedRequestContext,
  NavigationExpansionApi,
  NavigationExpansionRequest,
  NavigationExpansionResult,
} from "@eliotr/interfaces";
import { parseNavigationScopeSnapshot } from "@eliotr/retrieval";
import { CatalogInputError } from "./catalog-service.js";
import { createD1NavigationService } from "./navigation-persistence.js";

export interface NavigationExpandEnvironment {
  readonly CORE_DB: D1Database;
}

function requireOwner(context: AuthenticatedRequestContext): void {
  if (context.client_class !== "owner_pwa") {
    throw new CatalogInputError(
      "NAVIGATION_OWNER_REQUIRED",
      "Corpus Lens expansion requires an owner session",
      403,
    );
  }
}

/**
 * App-layer bridge for the existing D1-backed NavigationService. It performs
 * no writes and derives all currentness checks from the authenticated owner
 * and the persisted scope authority.
 */
export function createNavigationExpandService(
  env: NavigationExpandEnvironment,
  now: () => number = Date.now,
): NavigationExpansionApi {
  return {
    async expand(
      context: AuthenticatedRequestContext,
      request: NavigationExpansionRequest,
    ): Promise<NavigationExpansionResult> {
      requireOwner(context);
      const scope = parseNavigationScopeSnapshot(request.scope_snapshot);
      const authority = createOwnerScopeAuthority(env.CORE_DB, context, now);
      const scopes = createD1ScopeService(env.CORE_DB, authority, { now });
      const navigation = createD1NavigationService({
        database: env.CORE_DB,
        scope_snapshot: scope,
        access: {
          principal_ref: context.principal_ref,
          client_class: context.client_class,
          credential_generation: context.credential_generation,
        },
        scopes,
        now,
      });
      return navigation.expand({ ...request, scope_snapshot: scope });
    },
  };
}
