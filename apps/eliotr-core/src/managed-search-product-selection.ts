import {
  ManagedTargetSelectionError,
  resolveManagedTargetSelectionV2 as readManagedTargetSelectionV2,
} from "@eliotr/cloudflare-projection/ai-search";
import type { ManagedTargetSelectionV2 } from "@eliotr/cloudflare-projection";

export type { ManagedTargetSelectionV2 } from "@eliotr/cloudflare-projection";

export class ManagedSearchProductSelectionError extends Error {
  public constructor(
    public readonly code:
      | "MANAGED_SEARCH_PRODUCT_REGISTRY_UNAVAILABLE"
      | "MANAGED_SEARCH_PRODUCT_REGISTRY_INVALID"
      | "MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND"
      | "MANAGED_SEARCH_PRODUCT_PROFILE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ManagedSearchProductSelectionError";
  }
}


/** Preserve the owner HTTP error surface around the shared server-only reader. */
export async function resolveManagedTargetSelectionV2(
  searchDatabase: D1Database,
  purpose: "ACTIVE" | "SHADOW",
  shadowGeneration?: string,
): Promise<ManagedTargetSelectionV2> {
  try {
    return await readManagedTargetSelectionV2(searchDatabase, purpose, shadowGeneration);
  } catch (error) {
    if (error instanceof ManagedTargetSelectionError) {
      throw new ManagedSearchProductSelectionError(error.code, error.message);
    }
    throw error;
  }
}
