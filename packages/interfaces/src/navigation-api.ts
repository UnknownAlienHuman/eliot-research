import type {
  NavigationExpansionRequest,
  NavigationExpansionResult,
} from "@eliotr/retrieval";
import type { AuthenticatedRequestContext } from "./http.js";

/** The owner Corpus Lens expansion route is a read of existing navigation artifacts. */
export const NAVIGATION_EXPANSION_OPERATION = "research.navigation.expand" as const;
export const NAVIGATION_EXPANSION_PATH = "/api/v1/research/navigation/expand" as const;

export type { NavigationExpansionRequest, NavigationExpansionResult } from "@eliotr/retrieval";

export interface NavigationExpansionApi {
  expand(
    context: AuthenticatedRequestContext,
    request: NavigationExpansionRequest,
  ): Promise<NavigationExpansionResult>;
}
