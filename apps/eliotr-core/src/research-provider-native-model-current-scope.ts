import {
  decodeProviderNativeModelSelection,
  type ProviderNativeModelKeyBindingReadRequestV1,
  type ProviderNativeModelSelectionV1,
} from "@eliotr/cloudflare-native-models";
import { readResearchProviderKeyModelUseNativeScope } from "./research-provider-key-model-use-current-scope.js";
import type {
  ResearchProviderNativeModelCurrentScopeV1,
  ReadResearchProviderNativeModelCurrentScope,
} from "./research-provider-native-model-authority.js";

function selectionsByStage(raw: readonly unknown[]): ReadonlyMap<string, ProviderNativeModelSelectionV1> {
  const result = new Map<string, ProviderNativeModelSelectionV1>();
  for (const value of raw) {
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
        (value as { candidate_kind?: unknown }).candidate_kind !== "provider-native-v1") continue;
    const selection = decodeProviderNativeModelSelection(value);
    if (result.has(selection.stage)) throw new TypeError("run snapshot contains duplicate Native model stages");
    result.set(selection.stage, selection);
  }
  return result;
}

/**
 * Binds Native resolution to the completed owner model-use operation that
 * produced the exact selection captured in the immutable run snapshot.
 */
export function createResearchProviderNativeModelCurrentScopeReader(input: {
  readonly database: D1Database;
  readonly owner_ref: string;
  readonly project_id: string;
  readonly model_selections: readonly unknown[];
}): ReadResearchProviderNativeModelCurrentScope {
  const selectedByStage = selectionsByStage(input.model_selections);
  return async (request: ProviderNativeModelKeyBindingReadRequestV1): Promise<ResearchProviderNativeModelCurrentScopeV1 | null> => {
    if (request.owner_ref !== input.owner_ref || request.project_id !== input.project_id) return null;
    if (!selectedByStage.has(request.stage)) return null;
    return readResearchProviderKeyModelUseNativeScope(input.database, request, { allowed_phases: ["COMPLETE"] });
  };
}
