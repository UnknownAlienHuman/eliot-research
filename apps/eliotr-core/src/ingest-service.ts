import type { OperationReceipt } from "@eliotr/contracts";
import type { IngestApi, CommitBundleRequest, PrepareBundleRequest, PrepareBundleResponse } from "@eliotr/interfaces";
import type { StagedBundlePort } from "@eliotr/platform-cloudflare";

export interface IngestServiceDependencies {
  readonly stagedBundles: StagedBundlePort;
}

// SCAFFOLD_FAIL_CLOSED: ER-14/ER-21/ER-29 ingest API composition
export function createIngestService(_dependencies: IngestServiceDependencies): IngestApi {
  return {
    async prepareBundle(_request: PrepareBundleRequest): Promise<PrepareBundleResponse> {
      throw new Error("ER-14/ER-21 implementation required");
    },
    async commitBundle(_request: CommitBundleRequest): Promise<OperationReceipt> {
      throw new Error("ER-14/ER-29 implementation required");
    },
    async getBundleStatus(): Promise<OperationReceipt | null> {
      throw new Error("ER-13 operation repository implementation required");
    },
  };
}
