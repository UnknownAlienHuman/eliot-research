import type { ErasureReceipt, ErasureRequest } from "@eliotr/contracts";
import type { ErasureBackend } from "@eliotr/platform-cloudflare";

export interface ErasureCoordinator {
  execute(request: ErasureRequest): Promise<ErasureReceipt>;
}

/**
 * Fail-closed composition boundary. ER-28 must supply exact requested-location equality,
 * policy/hold checks, absence verification, purge-ledger append and dependent invalidation.
 */
export function createErasureCoordinator(_backend: ErasureBackend): ErasureCoordinator {
  return {
    async execute(): Promise<never> {
      throw new Error("ER-28 implementation required; no partial purge may return a success receipt");
    },
  };
}
