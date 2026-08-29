import type { NavigationService, NavigationStore, OrientationRequest, OrientationResult } from "@eliotr/retrieval";

export function createNavigationService(_store: NavigationStore): NavigationService {
  return {
    async orient(_request: OrientationRequest): Promise<OrientationResult> {
      throw new Error("ER-31 implementation required; orientation may not fabricate corpus coverage");
    },
  };
}
