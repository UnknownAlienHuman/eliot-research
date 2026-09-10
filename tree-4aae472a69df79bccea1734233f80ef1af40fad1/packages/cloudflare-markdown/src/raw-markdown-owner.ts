import { createR2EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import { createRawMarkdownConversionService, createWorkersAiMarkdownConversionAdapter } from "./raw-markdown-conversion.js";
import type { WorkersAiMarkdownBinding } from "./markdown-conversion-contract.js";
import type { RawMarkdownCaptureReceipt, RawMarkdownConversionRequest, RawMarkdownResult } from "./raw-markdown-conversion-contract.js";

interface OwnerContext { readonly principal_ref: string; readonly credential_generation: string; readonly request: Request; readonly client_class: "owner_pwa" | "named_api_client" | "trusted_agent" | "federation_client"; readonly trace_id: string; readonly signal?: AbortSignal; }
interface OwnerInput { readonly database: D1Database; readonly bucket: R2Bucket; readonly ai?: WorkersAiMarkdownBinding; readonly profile_generation: string; readonly readCapture: (context: OwnerContext, captureId: string) => Promise<RawMarkdownCaptureReceipt | null>; }

/** Core composition seam. It never exposes raw object keys or provider credentials. */
export function createRawMarkdownOwnerConverter(input: OwnerInput) {
  return async function convert(context: OwnerContext, captureId: string, request: RawMarkdownConversionRequest): Promise<RawMarkdownResult> {
    if (context.client_class !== "owner_pwa" || input.ai === undefined) throw new Error("raw markdown conversion requires an owner session and configured AI binding");
    const service = createRawMarkdownConversionService({
      database: input.database,
      profile_generation: input.profile_generation,
      adapter: createWorkersAiMarkdownConversionAdapter(input.ai),
      output: createR2EvidenceObjectStore(input.bucket),
      source: {
        read: (owner, id) => input.readCapture(context, id),
        open: async (receipt) => (await input.bucket.get(receipt.object_key))?.body ?? null,
        assertCurrent: async (_owner, receipt) => {
          const current = await input.readCapture(context, receipt.capture_id);
          if (current === null || current.object_key !== receipt.object_key || current.content_sha256 !== receipt.content_sha256 || current.source_owner_generation !== receipt.source_owner_generation) throw new Error("raw capture authority is no longer current");
        },
      },
    });
    return service.convert({ principal_ref: context.principal_ref, credential_generation: context.credential_generation, deployment_generation: input.profile_generation, profile_generation: input.profile_generation, signal: context.signal ?? context.request.signal }, captureId, request);
  };
}
