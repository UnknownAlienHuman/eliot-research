import type { AuthenticatedRequestContext, ResearchChangeItem } from "@eliotr/interfaces";
import { CatalogInputError } from "@eliotr/cloudflare-navigation";

export type ErasureChangeAuthorizer = (
  context: AuthenticatedRequestContext,
  change: ResearchChangeItem,
) => Promise<boolean>;

function declaredRetryable(error: unknown): boolean | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    // Project errors declare a boolean data property. Unknown accessors and
    // failing proxy inspection do not establish a permanent domain failure.
    const value: unknown = Object.getOwnPropertyDescriptor(error, "retryable")?.value;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function authorizeErasureChange(
  context: AuthenticatedRequestContext,
  change: ResearchChangeItem,
  authorize: ErasureChangeAuthorizer | undefined,
): Promise<boolean> {
  if (change.kind !== "ERASURE_COMPLETED") return true;
  if (authorize === undefined) return false;
  try {
    return await authorize(context, change) === true;
  } catch (error) {
    if (declaredRetryable(error) === false) {
      throw new CatalogInputError("RESEARCH_CHANGES_CONFLICT", "erasure change authorization is denied", 409, false);
    }
    throw new CatalogInputError("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "erasure change authorization is unavailable", 503, true);
  }
}

export async function recheckErasureChanges<T extends { readonly kind: string }>(
  context: AuthenticatedRequestContext,
  changes: T[],
  decode: (row: T) => ResearchChangeItem,
  authorize: ErasureChangeAuthorizer | undefined,
): Promise<void> {
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const row = changes[index];
    if (row !== undefined && row.kind === "ERASURE_COMPLETED" &&
        !await authorizeErasureChange(context, decode(row), authorize)) changes.splice(index, 1);
  }
}
