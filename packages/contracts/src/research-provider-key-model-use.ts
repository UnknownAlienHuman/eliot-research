import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

export const RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL =
  "eliotr.research.provider-key-model-use.v1" as const;

const operationId = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
const selectionRevision = z.number().int().min(1).max(999_999).nullable();
const configurationRef = z.string().regex(/^rpmc-[a-f0-9]{64}$/u);

/** The owner can identify the configured key and CAS revision only. */
export const ResearchProviderKeyModelUseRequestSchema = z.object({
  protocol: z.literal(RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL),
  operation_id: operationId,
  expected_selection_revision: selectionRevision,
}).strict();
export type ResearchProviderKeyModelUseRequest =
  z.infer<typeof ResearchProviderKeyModelUseRequestSchema>;

export const ResearchProviderKeyModelUseStateSchema = z.enum([
  "accepted",
  "preparing",
  "qualifying",
  "importing",
  "selected",
  "blocked",
  "uncertain",
  "conflict",
]);
export type ResearchProviderKeyModelUseState =
  z.infer<typeof ResearchProviderKeyModelUseStateSchema>;

export const ResearchProviderKeyModelUsePhaseSchema = z.enum([
  "intent",
  "native_prepare",
  "free_price_check",
  "native_qualify",
  "configuration_import",
  "selection_readback",
  "complete",
]);
export type ResearchProviderKeyModelUsePhase =
  z.infer<typeof ResearchProviderKeyModelUsePhaseSchema>;

export const ResearchProviderKeyModelUseFailureCodeSchema = z.enum([
  "NO_SELECTED_CONFIGURATION",
  "FREE_PRICE_NOT_PROVEN",
  "FREE_PRICE_NOT_ZERO",
  "SERVER_POLICY_UNAVAILABLE",
  "PREPARATION_REJECTED",
  "QUALIFICATION_NO_EFFECT",
  "QUALIFICATION_OUTCOME_UNCERTAIN",
  "NATIVE_RECEIPT_INVALID",
  "SELECTION_CAS_CONFLICT",
  "AUTHORITY_CHANGED",
  "STORAGE_UNAVAILABLE",
]);
export type ResearchProviderKeyModelUseFailureCode =
  z.infer<typeof ResearchProviderKeyModelUseFailureCodeSchema>;

/** Safe owner status. Provider key bytes and Secrets Store IDs never appear. */
export const ResearchProviderKeyModelUseReceiptSchema = z.object({
  protocol: z.literal(RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL),
  project_id: z.string().min(1).max(256),
  operation_id: operationId,
  key_operation_id: operationId,
  state: ResearchProviderKeyModelUseStateSchema,
  phase: ResearchProviderKeyModelUsePhaseSchema,
  selected_configuration_ref: configurationRef.nullable(),
  selection_revision: selectionRevision,
  failure_code: ResearchProviderKeyModelUseFailureCodeSchema.nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.state === "selected") {
    if (receipt.phase !== "complete" || receipt.selected_configuration_ref === null ||
        receipt.selection_revision === null || receipt.failure_code !== null) {
      context.addIssue({ code: "custom", message: "Selected model-use receipt is incomplete" });
    }
    return;
  }
  if (receipt.selected_configuration_ref !== null || receipt.selection_revision !== null) {
    context.addIssue({ code: "custom", message: "Non-selected model-use receipt cannot claim a selection" });
  }
  if ((receipt.state === "blocked" || receipt.state === "uncertain" || receipt.state === "conflict") !==
      (receipt.failure_code !== null)) {
    context.addIssue({ code: "custom", message: "Model-use failure code does not match its state" });
  }
  if (receipt.state === "uncertain" && receipt.failure_code !== "QUALIFICATION_OUTCOME_UNCERTAIN") {
    context.addIssue({ code: "custom", message: "Uncertain model-use must report its uncertainty" });
  }
  if (receipt.state === "conflict" && receipt.failure_code !== "SELECTION_CAS_CONFLICT") {
    context.addIssue({ code: "custom", message: "Model-use conflict code is invalid" });
  }
});
export type ResearchProviderKeyModelUseReceipt =
  z.infer<typeof ResearchProviderKeyModelUseReceiptSchema>;
