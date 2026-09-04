import type { FederationApi } from "./federation-api.js";
import type { SemanticApi } from "./semantic-api.js";
import type { OwnerApi } from "./owner-api.js";

export interface ApplicationServices {
  readonly semantic: SemanticApi;
  readonly federation: FederationApi;
  readonly owner: OwnerApi;
}

export interface ApplicationLifecycle {
  readonly services: ApplicationServices;
  readiness(): Promise<{ ready: boolean; blocking_reason_codes: readonly string[] }>;
  reconcile(limit: number): Promise<{ repaired: number; still_pending: number }>;
}
