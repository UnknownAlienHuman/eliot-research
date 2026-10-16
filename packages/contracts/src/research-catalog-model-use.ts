import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

export const RESEARCH_CATALOG_MODEL_USE_REQUEST_PROTOCOL =
  "eliotr.research.catalog-model-use-request.v1" as const;
export const RESEARCH_CATALOG_MODEL_USE_RECEIPT_PROTOCOL =
  "eliotr.research.catalog-model-use-receipt.v1" as const;

const operationId = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
const providerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/u);
const modelId = z.string().regex(/^(?:@[A-Za-z0-9][A-Za-z0-9._:~@/-]{0,254}|[A-Za-z0-9~][A-Za-z0-9._:~@/-]{0,255})$/u);
const selectionRevision = z.number().int().min(1).max(999_999).nullable();
const configurationRef = z.string().regex(/^rpmc-[a-f0-9]{64}$/u);
const configurationSha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const ResearchCatalogModelUseRequestSchema = z.object({
  protocol: z.literal(RESEARCH_CATALOG_MODEL_USE_REQUEST_PROTOCOL),
  operation_id: operationId,
  expected_selection_revision: selectionRevision,
  /** Logical provider ID from the owner-visible catalog. */
  provider_id: providerId,
  /** Exact model ID from that provider's catalog page. */
  model_id: modelId,
  /** Existing global provider connection operation; null only for the Workers AI binding. */
  provider_operation_id: operationId.nullable(),
}).strict().superRefine((request, context) => {
  const builtin = request.provider_id === "cloudflare-workers-ai";
  if (builtin !== (request.provider_operation_id === null) || (builtin && !request.model_id.startsWith("@cf/"))) {
    context.addIssue({ code: "custom", message: "Provider operation identity does not match the catalog provider" });
  }
});
export type ResearchCatalogModelUseRequest = z.infer<typeof ResearchCatalogModelUseRequestSchema>;

export const ResearchCatalogModelUseStateSchema = z.enum([
  "accepted", "preparing", "qualifying", "importing", "selected", "blocked", "uncertain", "conflict",
]);
export type ResearchCatalogModelUseState = z.infer<typeof ResearchCatalogModelUseStateSchema>;

export const ResearchCatalogModelUsePhaseSchema = z.enum([
  "intent", "provider_resolution", "native_prepare", "qualification", "configuration_import", "selection_readback", "complete",
]);
export type ResearchCatalogModelUsePhase = z.infer<typeof ResearchCatalogModelUsePhaseSchema>;

export const ResearchCatalogModelUseFailureCodeSchema = z.enum([
  "PROVIDER_NOT_CONFIGURED", "MODEL_NOT_SUPPORTED", "SERVER_POLICY_UNAVAILABLE", "PREPARATION_REJECTED",
  "QUALIFICATION_NO_EFFECT", "QUALIFICATION_OUTCOME_UNCERTAIN", "NATIVE_RECEIPT_INVALID",
  "SELECTION_CAS_CONFLICT", "AUTHORITY_CHANGED", "STORAGE_UNAVAILABLE",
]);
export type ResearchCatalogModelUseFailureCode = z.infer<typeof ResearchCatalogModelUseFailureCodeSchema>;

/** Safe owner status. The receipt contains identities and digests, never credentials or aliases. */
export const ResearchCatalogModelUseReceiptSchema = z.object({
  protocol: z.literal(RESEARCH_CATALOG_MODEL_USE_RECEIPT_PROTOCOL),
  project_id: z.string().min(1).max(256),
  operation_id: operationId,
  provider_id: providerId,
  provider_operation_id: operationId.nullable(),
  model_id: modelId,
  state: ResearchCatalogModelUseStateSchema,
  phase: ResearchCatalogModelUsePhaseSchema,
  selected_configuration_ref: configurationRef.nullable(),
  selected_configuration_sha256: configurationSha256.nullable(),
  selection_revision: selectionRevision,
  failure_code: ResearchCatalogModelUseFailureCodeSchema.nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
}).strict().superRefine((receipt, context) => {
  const selected = receipt.state === "selected";
  const hasSelection = receipt.selected_configuration_ref !== null &&
    receipt.selected_configuration_sha256 !== null && receipt.selection_revision !== null;
  if (selected) {
    if (receipt.phase !== "complete" || !hasSelection || receipt.failure_code !== null ||
        receipt.selected_configuration_ref !== `rpmc-${receipt.selected_configuration_sha256}`) {
      context.addIssue({ code: "custom", message: "Selected catalog model receipt lacks exact configuration readback" });
    }
    return;
  }
  if (receipt.selected_configuration_ref !== null || receipt.selected_configuration_sha256 !== null ||
      receipt.selection_revision !== null) {
    context.addIssue({ code: "custom", message: "Non-selected catalog model receipt cannot claim a selection" });
  }
  const failureState = receipt.state === "blocked" || receipt.state === "uncertain" || receipt.state === "conflict";
  if (failureState !== (receipt.failure_code !== null) ||
      (receipt.state === "uncertain" && receipt.failure_code !== "QUALIFICATION_OUTCOME_UNCERTAIN") ||
      (receipt.state === "conflict" && receipt.failure_code !== "SELECTION_CAS_CONFLICT")) {
    context.addIssue({ code: "custom", message: "Catalog model failure code does not match its state" });
  }
});
export type ResearchCatalogModelUseReceipt = z.infer<typeof ResearchCatalogModelUseReceiptSchema>;
